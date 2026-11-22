<div align="center">

<img src="assets/readme/hero.svg" alt="Kit Harness Protocol, the harness for real files: an agent harness connects over MCP to a kit, an MCP server for one kind of file with inspect, commands, run, check, export and draft tools, which works on the motion, photo, PDF and slide files in a workspace folder." width="100%" />

# Kit Harness Protocol

**An open protocol that lets an AI agent work on real files (motion graphics, photos, PDFs, slides)
the way a coding agent works on code: look, edit, run, check, and hand the result to a person.**

[kitharness.org](https://kitharness.org) · [Specification](spec/index.md) · [Conformance checker](tools/conformance/README.md) · [Example kit](examples/docx-python/README.md) · [Changes](CHANGES.md)

KHP 1.1 · edition 2026.11 · draft · Apache-2.0

</div>

The Kit Harness Protocol (KHP for short) says how an AI agent uses a **kit**: an MCP server
that gives the agent tools to inspect, edit, check, and export one kind of file. Any agent that
speaks MCP can use any kit that follows the protocol, with no other adapter.

## The problem it solves

A coding agent can do real work because its harness gives the model an environment: it reads the
code, edits it, runs it, tests it, and rolls back what went wrong. Motion graphics, photos,
PDFs, slides, documents, spreadsheets and drawings have no such environment. Their formats are
made for storage, their computing and layout are locked inside desktop applications, and nothing
tells an agent whether its edit was right. Without a shared contract, each integration that lets
an agent touch such a file defines its own calls, its own results, and its own safety rules.

A kit is the harness for one kind of file, and the Kit Harness Protocol is the common contract
every kit follows:

| Capability | For code | For a file, through a kit |
| --- | --- | --- |
| **Observe** | Read the source | The document as JSON, typed objects, rendered previews |
| **Act** | Edit, run a shell | Commands with parameter schemas; batches of object edits |
| **Execute** | Compiler, runtime | The kit's own engine recalculates, lays out, and renders |
| **Verify** | Tests, type checks | Diagnostics the kit reports about the document |
| **Recover** | Branches, revert | Drafts a person reviews and merges |

What that gives an agent, and the person who started it:

- **The same tools on every kit.** Every kit offers `<prefix>_inspect`, `<prefix>_commands`,
  `<prefix>_run` and `<prefix>_check`, and from the Agent-ready tier `<prefix>_create` and
  `<prefix>_export`: a slide kit's tools are `slide_*`, a spreadsheet kit's `sheet_*`, with the
  same arguments and result shapes.
- **Stable addresses.** An id, page, sheet or cell that one call answers means the same thing in
  every later call; it never depends on a "current" slide or the selection.
- **Atomic edits.** A run of 1 to 50 steps applies all of them or none; a failed run leaves the
  file as it was and says which step failed and how to recover.
- **Self-checks.** `<prefix>_check` answers diagnostics with stable codes, targets, and optional
  fix hints, without changing the document.
- **Person-approved drafts.** A kit can let the agent edit a draft. The agent asks for review; only
  a person merges or discards it, and neither is ever offered to the model as a tool.
- **Safety rules.** File paths stay inside the workspace, exports never replace a file, an agent's
  edits are attributed to the person who started it or kept apart, and every call is logged.

## How it works

<img src="assets/readme/how-it-works.svg" alt="Diagram: a person starts an agent harness and later compares the agent's draft with the file and merges or discards it. The harness, any MCP client, calls the kit's tools over MCP and gets JSON, previews, diagnostics and errors back; it logs every call. The kit, an MCP server started on one workspace folder, offers the prefix_inspect, commands, run, check, create and export tools and its manifest as the resource khp://kits/id/kit.json, and its own engine reads and writes the files in the workspace." width="100%" />

There are three roles:

| Role | What it is |
| --- | --- |
| **Kit** | An MCP server for one kind of file (or a server of several kits), started on a workspace folder, with a manifest (`kit.json`) |
| **Agent harness** | Runs a model, its tools, and its loop, and connects to kits over MCP: Claude Code, Codex, Kition's agent, or anyone's own |
| **Person** | Starts the agent, reviews its drafts, and merges or discards them |

A working session is a short loop:

<img src="assets/readme/loop.svg" alt="Diagram of the loop: 01 inspect reads the document as JSON with addresses that work in later calls and an optional preview; 02 commands finds commands, each with a parameter schema; 03 run applies 1 to 50 steps all or none; 04 check returns diagnostics with stable codes, targets and fix hints, and the agent fixes what it reports and checks again; 05 with drafts on, draft_ready asks the person to review, or export writes a new file. Then, person only: compare the draft with the file and merge or discard; these are never offered to the model." width="100%" />

## A kit is an MCP server

MCP gives an agent a standard way to discover and call a server's tools. It does not say which tools
a server for a spreadsheet should have, what their results look like, how a failed edit is undone,
or who may approve a change. KHP is that layer on top: **a kit is an MCP server that follows KHP's
tool conventions.**

| KHP | MCP |
| --- | --- |
| The kit's tools | `tools/list`, `tools/call` |
| Tool arguments | `inputSchema` (JSON Schema) |
| Tool results | `structuredContent` with a text `content` beside it, and an `outputSchema` per tool |
| Previews | Image content in the result |
| Errors | `isError: true`, with `{ code, message, index?, retryable? }` in `structuredContent.error` |
| The manifest | The resource `khp://kits/<id>/kit.json` |
| Reminders for the model | The server's `instructions` |

How a kit is built inside (its engine, data model, editor, or storage) is its own. A kit can wrap
an existing file library: the [example kit](examples/docx-python/README.md) in this repository is
a small Python MCP server around python-docx.

## Three tiers

<img src="assets/readme/tiers.svg" alt="Diagram of three cumulative tiers. Basic: inspect, commands, run and check, a schema for every agent-facing command, structured actionable errors, atomic runs with accepted edits saved, workspace containment and the safety rules; no object model or real preview needed, and drafts may work in file mode; wrapping an existing file library is enough. Agent-ready adds: works with no editor open, real previews on request, a real check with a catalogue of its codes, create and export, query and batch when the kit has an object model, no network, and notice of changes made outside its calls. Agent-ready complete adds: the layout answer for paginated kits, a guide for models, edits that address only what they change by id, name or path, and running under a sandbox." width="100%" />

A kit claims one tier in its manifest's `level`, and the conformance checker, `khp check`, tests
it against the kit's running MCP server. A conformance report names the version and the tier, for
example "KHP 1.0, Agent-ready". The complete tier cannot pass today: one of its requirements (A44)
has no automated check yet.

## Try it in five minutes

This repository contains a basic-tier kit for `.docx` files and the conformance checker. You need
Python 3.11 or later, Node.js 22.18 or later and pnpm 10, on Linux or macOS.

```sh
git clone https://github.com/kitharness/kitharness.git
cd kitharness
export REPO_ROOT="$PWD"
export KHP_PYTHON_ENV="${TMPDIR:-/tmp}/khp-docx-python-venv"

# The example kit: python-docx behind the official MCP Python SDK
python3 -m venv "$KHP_PYTHON_ENV"
"$KHP_PYTHON_ENV/bin/python" -m pip install -r examples/docx-python/requirements.txt
"$KHP_PYTHON_ENV/bin/python" -B examples/docx-python/generate_fixtures.py

# The conformance checker
pnpm --dir tools/conformance install --frozen-lockfile
pnpm --dir tools/conformance build

# Test the kit at the tier it claims
node tools/conformance/dist/cli.js check \
  --kit "\"$KHP_PYTHON_ENV/bin/python\" -B \"$REPO_ROOT/examples/docx-python/server.py\" --workspace {workspace} --actor \"Example Owner\"" \
  --package "$REPO_ROOT/examples/docx-python" \
  --fixtures "$REPO_ROOT/examples/docx-python/conformance" \
  --level basic
```

Keep `{workspace}` literal: the checker starts the kit afresh on a copy of the fixtures for every
phase. This is the real output of that command:

<img src="assets/readme/conformance.svg" alt="Terminal output of khp check against the DOCX example at the basic tier: KHP 1.0, org.example.docx-python 0.1.0, tier basic: passed; the claim is verified (K19); phases 1 manifest, 2 launch, 3 tools, 4 schemas, 5 act, 6 verify, 9 files, 11 containment and 12 probes pass; A7 and A26 are attested by the kit's own tests, not by khp check; exit status 0." width="100%" />

To use the kit from an agent, register it as an MCP stdio server in your harness, started on a
folder of your own `.docx` files (`$WORKSPACE`), with the name of the person the agent works for:

```sh
"$KHP_PYTHON_ENV/bin/python" -B "$REPO_ROOT/examples/docx-python/server.py" \
  --workspace "$WORKSPACE" --actor "Your Name"
```

Here is what the agent sees. These calls were made by a minimal MCP client (the official Python
SDK, not part of this repository) against the example kit on a copy of its `basic.docx` fixture;
the results are the kit's real `structuredContent`. Note the second `docx_run`: its second step
fails, so the first is rolled back and the file is untouched.

<img src="assets/readme/session.svg" alt="A real MCP session with the DOCX example kit: initialize reports org.example.docx-python 0.1.0; tools/list shows docx_inspect, docx_commands, docx_run, docx_check, docx_create and docx_export; resources/list shows the kit.json, checks.json and guide.md resources. docx_inspect returns the heading A small report, a body paragraph and a table as JSON with indexes. docx_commands for replace paragraph text returns paragraph.set-text with its JSON Schema. docx_run sets paragraph 1 and adds a paragraph, and saves. A second docx_run fails at step 1 with not-found, No body paragraph 99, completed empty and the first step rolled back. docx_check returns no diagnostics. docx_export writes report-copy.docx as a new file." width="100%" />

The [example's README](examples/docx-python/README.md) walks through how it was built: the
workspace boundary, the command schemas, atomic saves, link reporting, and the thin MCP binding.
Use it as a template for wrapping your own file library.

## Who implements it

[Kition](https://kition.ai) is the reference implementation: its kits (note, table, doc, sheet,
slide, PDF and others) are KHP kits, served to any MCP client by its kits MCP server. How Kition
builds and hosts its kits is documented with the [Kition SDK](https://github.com/KitionAI/kition-sdk),
not here, and none of it is required of a KHP kit. To try Kition's kits with your agent:

```sh
npm install -g @kition/cli        # Node.js 20 or later; gives the kition command
kition agent add claude           # or codex, cursor: registers Kition's kits MCP server
```

<img src="assets/readme/kition-agent-mcp.png" alt="Kition, the reference implementation: terminal output of the Kition SDK's agent-mcp example, which creates Notes.md through the Note kit over MCP and runs note_check with 0 diagnostics and 0 errors, followed by the saved Markdown file with an added section and task." width="70%" />

<sub>Kition's Note kit driven over MCP by the Kition SDK's `examples/agent-mcp` (screenshot from the
Kition SDK, Apache-2.0).</sub>

The protocol is maintained by Kition and is meant to move to a neutral foundation later. Its site is
[kitharness.org](https://kitharness.org).

## Specification

Start with [spec/index.md](spec/index.md), which states the protocol version and edition. The
specification has four pages:

| Page | Contents |
| --- | --- |
| [spec/index.md](spec/index.md) | Scope, roles, tiers, and reading guide |
| [spec/agent.md](spec/agent.md) | Tools, arguments, results, diagnostics, errors, drafts, rules, and MCP binding (requirements A) |
| [spec/manifest.md](spec/manifest.md) | The minimal `kit.json` manifest and its MCP resource (requirements K) |
| [spec/conformance.md](spec/conformance.md) | Fixtures, conformance checks, harness adapter contract, and reports |

The current version is KHP 1.1, edition 2026.11, a draft. Kits name the kit-layer version they
follow in their manifest's `khp` field; it is 1.0, because KHP 1.1 adds only harness conformance.
A minor version only adds; a change that removes or changes a requirement bumps the major version.
See [CHANGES.md](CHANGES.md) for version changes and retired requirement ids.

## Conformance

The checker, `khp check`, is in [tools/conformance](tools/conformance/README.md) (package
`@kitharness/conformance`). Run it from a clone of this repository after the build steps in
[Build and test](#build-and-test):

```sh
node tools/conformance/dist/cli.js check --kit "my-kit --workspace {workspace}" --package <kit-package> --level basic
```

The kit package supplies `kit.json` and a `conformance/` fixture folder. Keep `{workspace}`
literal: the checker substitutes a fresh fixture copy. It talks to the kit only over MCP (stdio),
so it tests a kit whatever it is written in. It reports failures and checks it could not perform.
A passing observed check does not establish an untested duty.

Agent harnesses can be checked too, with `khp check --harness "<adapter command>" --scripted`,
which replays deterministic turns without calling a model. See the
[tool README](tools/conformance/README.md) for options and report limits.

## Build and test

Use Node.js 22.18 or later and pnpm 10. From the repository root:

```sh
pnpm --dir tools/conformance install --frozen-lockfile
pnpm --dir tools/conformance build
pnpm --dir tools/conformance typecheck
pnpm --dir tools/conformance test
```

The build writes `tools/conformance/dist/`. From a checkout, run the CLI as
`node tools/conformance/dist/cli.js check ...`. To inspect the npm archive locally, run
`pnpm --dir tools/conformance pack --pack-destination /tmp/khp-pack`; packing rebuilds the
compiled output and does not publish it.

The example kit's contract case runs with
`"$KHP_PYTHON_ENV/bin/python" -B "$REPO_ROOT/examples/docx-python/test_example.py"` after the
setup above.

The feature catalogue is [features.yaml](features.yaml); the gating tests are under
[cases/](cases/). [docs/quality.md](docs/quality.md) lists their commands, the required
local-path scan, and the rules for expected results.

## Repository

| Path | What |
| --- | --- |
| [spec/](spec/index.md) | The four specification pages |
| [tools/conformance/](tools/conformance/README.md) | `khp check`, the conformance checker (`@kitharness/conformance`) |
| [examples/docx-python/](examples/docx-python/README.md) | A basic-tier kit wrapping python-docx |
| [cases/](cases/) and [features.yaml](features.yaml) | Gating tests and the feature catalogue |
| [CHANGES.md](CHANGES.md) | Version history and retired requirement ids |

The repository's home is [github.com/kitharness/kitharness](https://github.com/kitharness/kitharness).
Its packages are named in the `@kitharness/*` scope; none is published to npm yet.

## License

The specification, tool, and example are licensed under Apache-2.0; see [LICENSE](LICENSE).
Dependencies are installed separately and retain their upstream licenses. The screenshot
`assets/readme/kition-agent-mcp.png` comes from the Kition SDK, also Apache-2.0.
