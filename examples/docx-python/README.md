# Basic DOCX Kit with python-docx

This is a small third-party KHP kit: a Python MCP stdio server wrapping
[python-docx](https://python-docx.readthedocs.io/en/latest/). It edits actual
DOCX files, without a platform dependency. It claims the `basic` tier;
the commands below test its contract and conformance.

The example uses `org.example.docx-python`, a documentation identifier.
Replace it with an identifier under your own domain before distributing a
kit. Keep the manifest's package and MCP resource content identical (K20).

## Install, generate fixtures, connect

Use Python 3.11 or later on Linux or macOS, on a filesystem supporting
POSIX directory descriptors, no-follow opens, hard links and atomic rename.
Windows is not supported by this teaching implementation. Set `REPO_ROOT`
to your checkout, `KHP_PYTHON_ENV` to a virtual environment outside the
checkout, and `WORKSPACE` to an existing, dedicated folder holding
the files you want the agent to edit. Both variables should be absolute;
they are shell placeholders, never values stored in the package.

From the repository root:

```sh
export REPO_ROOT="$PWD"
export KHP_PYTHON_ENV="${TMPDIR:-/tmp}/khp-docx-python-venv"
python3 -m venv "$KHP_PYTHON_ENV"
"$KHP_PYTHON_ENV/bin/python" -m pip install \
  -r "$REPO_ROOT/examples/docx-python/requirements.txt"
"$KHP_PYTHON_ENV/bin/python" -B \
  "$REPO_ROOT/examples/docx-python/generate_fixtures.py"
```

The generator creates exactly `conformance/basic.docx` and
`conformance/links-outside.docx`; `conformance/edit.json` is already supplied.
See [the fixture recipe](conformance/README.md) for the exact contents.
The binaries are generated locally and are not tracked. The generator
refuses to overwrite fixtures. These documents contain no third-party data.

Register this command as an MCP stdio server in your harness:

```sh
"$KHP_PYTHON_ENV/bin/python" -B \
  "$REPO_ROOT/examples/docx-python/server.py" \
  --workspace "$WORKSPACE" --actor "Example Owner"
```

Replace `Example Owner` with the person who started the agent. The server
records `last_modified_by` as that person's name followed by `(via agent)`
and increments the document's core revision on saves (A11). An empty new
document also records that person as its author. This is file metadata,
not tracked changes or an audit history. The harness must keep the A10
session log. Use a review copy when a person needs to approve the result.

The manifest declares six tools:

| Tool | Implementation |
| --- | --- |
| `docx_inspect` | Body paragraphs with index, style and text; body tables with cell row/column addresses; external relationship targets and safe resolution state. JSON only. |
| `docx_commands` | Six commands, ordered by id, paginated with `total` and `next`. Full JSON Schemas are returned even without `detail`. Searches cover ids, titles and descriptions; unmatched queries return nearby commands marked `closest`. |
| `docx_run` | Paragraph add/set/delete, heading add, table add/set-cell. Validate parameters, edit a detached document, serialize and reopen it, then save once. |
| `docx_check` | Open the package; answer an empty diagnostics list. No document diagnostic codes are claimed. |
| `docx_create` | Empty DOCX, or a workspace DOCX template, written under an unused filename. |
| `docx_export` | A new DOCX copy, including unsaved session edits; never reads linked resources. |

Basic requires the first four tools. This example also supplies create and
export with the A41 shapes. It has no draft tools, query, batch, hit test,
merge or discard tools. [The agent guide](agent/guide.md) gives two worked
examples and the exact command semantics.

## Walk through the adapter

**1. Describe what your library actually does.**
[kit.json](kit.json) claims `basic`, with no stable object model and no
draft system. `layout: true` is truthful because DOCX is paginated, though
this kit cannot lay it out. `links: true` is necessary because DOCX can
reference files and remote resources (K21). A kit must not hide that fact
because its command set does not create links. No rendering, layout or
overflow fixture is required at basic. The extra [checks list](agent/checks.json)
is `[]`: opening a package is not a visual validation engine.

**2. Put one boundary in front of every library file operation.**
[workspace.py](workspace.py) accepts visible workspace-relative paths with
the allowed extensions. It rejects absolute paths, URLs, backslashes,
parent traversal, hidden segments, symlinks and hard-linked files. It walks
from an open workspace directory descriptor using `O_NOFOLLOW`, including
the final file component, instead of validating a string and then passing
it to an unrestricted library open. Rejected existing and missing paths
get the same `not-allowed` code and message. Output parent folders must
already exist. The root folder itself must not be a symlink.

Tools pass only in-memory streams to python-docx. Staging files are created
in the destination's workspace folder and removed after publication.
`os.replace` publishes saved edits atomically. `os.link` publishes a new
file without replacement; collisions choose `Name 2.docx`, then `Name 3.docx`.
Created/replaced files are listed with workspace-relative paths, a SHA-256
version and `created` (A30).

The server uses no scratch or cache outside the workspace. It neither
searches nor reads the private runtime folder (A58); existing files there
are not document input. If you add a cache, use only the harness-designated
runtime folder, track only files you create yourself, clean them up on
exit, and keep it unreachable from tools and document links. Do not write
to the process's current folder, home folder or installation directory.

**3. Make the command catalogue executable.**
[schemas.py](schemas.py) contains the six command parameter schemas and the
six MCP input/output schemas. The same command schemas are returned by
`docx_commands` and checked by `docx_run`. Integers that address paragraphs,
tables, rows or columns say they count from 0. Text is always literal:
even a string containing a filename or `file:` URL is never opened.
Only document, template and export path arguments name files; they carry
`x-khp-file` with access and accepted extensions (A28/A29).

**4. Adapt library operations, keeping failure atomic.**
[kit.py](kit.py) opens a bounded ZIP from memory and rejects XML DTDs before
calling `Document`. Runs validate and execute against a detached candidate.
They serialize and reopen the result before touching the file. A later
failing step or save failure leaves both disk and prior session state
intact, with `completed: []`, `rolledBack`, and a step `index` (A53).
Deleting a paragraph is the one isolated private XML operation, because
python-docx has no public delete method. Section-break paragraphs and
merged-cell edits are refused rather than guessed.

`save: false` retains bytes in memory for inspect, check, export and the
next run. They disappear on process exit. A saved run commits earlier
pending changes too. If disk bytes change while edits are pending, the
kit refuses to overwrite them; export the pending version to another name
before restarting. The basic example does not implement the full A56
outside-change notification workflow or coordinate with desktop editors.
Keep other editors closed. A dedicated workspace and cooperative access
are assumed: this is not an OS sandbox against another process moving open
directories outside the workspace or changing files during the final
read/rename interval. Production isolation requires an appropriate sandbox
and concurrency policy.

**5. Treat links as data.**
Inspect walks external package relationships, including headers and
footers, and reports their raw targets (A42). It never follows a remote
target or imports linked content. Targets outside by their text alone
have `exists: false`, `outside: true`, and no `path` or `kit`. Hidden or
symlink targets return `exists: false` without `outside` or a resolved
path, regardless of whether a target exists. Relative links are resolved
from the document's folder. This is also why the linked canary fixture is
required at basic.

**6. Add the thin MCP binding.**
[server.py](server.py) uses the official MCP Python SDK. It serves the
manifest straight from the package file, plus the guide and checks list.
Input validation lives in the adapter so SDK validation cannot turn bad
arguments into unstructured errors. Every tool response carries both
canonical `structuredContent` and a text JSON copy; failures also set
`isError: true`. Each output schema accepts its tool's error result (A18).
The SDK handles initialization and stdio framing; stdout stays protocol-only.

## Check the kit

After dependency installation and fixture generation, with the repository's
conformance CLI installed/built as described in
[its README](../../tools/conformance/README.md), run:

```sh
khp check \
  --kit "\"$KHP_PYTHON_ENV/bin/python\" -B \"$REPO_ROOT/examples/docx-python/server.py\" --workspace {workspace} --actor \"Example Owner\"" \
  --package "$REPO_ROOT/examples/docx-python" \
  --fixtures "$REPO_ROOT/examples/docx-python/conformance" \
  --level basic \
  --report "${TMPDIR:-/tmp}/khp-docx-python-report.json"
```

The inner quotes keep paths with spaces intact. Keep `{workspace}` literal:
`khp check` substitutes its fresh workspace copy. It starts the server from
an empty current folder, so the interpreter and script paths are absolute
after shell expansion. The server needs no inherited variables beyond
the interpreter installation and the harness's environment.

At basic the checker covers manifest/resource equality, tool schemas,
command listing/search, saved edits, failed-run rollback, read-only checks,
path containment, link containment and string probes. It also checks every
phase for canary leakage and unintended writes outside the workspace,
including the A58 runtime canary. It does not test previews or layout at
basic. Although the server exposes create/export, the checker only tests
their collision behavior at Agent-ready; the gating test below covers it
here. Do not use `--no-probes` for the conformance run.

Run the added gate contract case with the same environment:

```sh
"$KHP_PYTHON_ENV/bin/python" -B \
  "$REPO_ROOT/examples/docx-python/test_example.py"
```

The catalogue case is
[`khp.examples.docx-python/basic-contract`](../../cases/khp.examples.docx-python/basic-contract/case.yaml).
It checks saved OOXML through an independent XML reader, attribution,
all six commands, unsaved state and rollback, create/export collisions,
uniform containment, link reporting, pagination, and the real MCP stdio
manifest and error shapes. Its `python3` must have the requirements
installed (activate the example environment before using a case runner).
The tests generate their own inputs in a temporary directory, separate
from the package fixtures.

The three direct dependencies are pinned in `requirements.txt`;
transitive dependencies are not locked.

## Scope when adapting another library

Keep this wrapper small: top-level body paragraphs and simple body tables
are its editable surface. Headers, footers, drawings, comments, tracked
changes, fields and advanced Word features have no editing commands or
content preview here; external relationships from their parts are still
reported. Complex DOCX fidelity depends on python-docx and has not been
established. Body indexes are positional, not persistent ids. DOCX export
is a copy, not PDF conversion. The package budget is 16 MiB compressed,
64 MiB expanded, 2,000 ZIP members and 8 MiB per XML member.

For your own library, replace the six library calls, formats, schemas,
fixtures and guide, then run conformance. Preserve the filesystem boundary,
error envelope and all-or-nothing edit behavior. Add higher-tier claims
only after implementing their additional requirements and passing the
corresponding checks.

## Licence and dependencies

This example is licensed under Apache-2.0, like the specification and
conformance tool; see the repository's [LICENSE](../../LICENSE).
The libraries listed in [requirements.txt](requirements.txt), including
python-docx, are installed separately and retain their upstream licences.
Their source and binary distributions are not vendored in this repository.
The fixture generator creates synthetic documents locally.
