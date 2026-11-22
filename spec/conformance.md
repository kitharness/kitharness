# Conformance

A kit conforms to KHP at a tier (basic, Agent-ready, or Agent-ready
complete; [agent.md](agent.md) section 10) when the conformance tool passes
at that tier against its MCP server. The tool talks to the kit only over
MCP, so it tests any kit, whatever it is written in.

> The conformance tool is `khp check`, including harness mode, in this
> repository's `tools/conformance/` (package `@kitharness/conformance`, not
> yet published to npm). Run it from a clone of the repository, as the
> [tool's README](../tools/conformance/README.md)
> says. Requirements here are *(proposed)* until it is published.

## `khp check`

```text
khp check --kit "<start command>" [--level basic|agent-ready|agent-ready-complete]
          [--package <folder>] [--fixtures <folder>] [--kit-id <id>]
          [--env NAME=VALUE]... [--no-probes]
          [--sandbox [--allow-read <folder>]...] [--report <file>] [--json]
```

| Option | Meaning |
| --- | --- |
| `--kit "<start command>"` | The command that starts the kit's MCP server over stdio, quoted as one argument, with its own arguments, naming the workspace as `{workspace}`: `--kit "acme-gantt-kit --workspace {workspace}"`. The workspace is a fresh copy of the fixtures folder, and the tool replaces `{workspace}` with its absolute path; a command without `{workspace}` is a usage error. The server starts in an empty folder of the tool's own, not in the workspace (see Containment) |
| `--level` | The tier to test. Default: the manifest's `level` (K19), else `basic` |
| `--package <folder>` | The kit's package, holding `kit.json` and `agent/`. Without it the tool reads the manifest from the MCP resource (K20) and the catalogue and guide from their resources when served |
| `--fixtures <folder>` | The kit's conformance fixtures. Default: `conformance/` beside `kit.json` |
| `--kit-id <id>` | The kit to test when the server serves several kits |
| `--env NAME=VALUE` | A variable the server needs, such as a fonts folder, passed beside `PATH`; repeat it for several. It cannot set the folder variables the tool sets (see Containment) |
| `--no-probes` | Skip phase 12 |
| `--sandbox` | Run the server under the platform's sandbox (required at Agent-ready complete): it reads files only in the workspace, its package, its private runtime folder (A58), its executable, and the platform's own folders, and writes only in the workspace and the private runtime folder (section 10.6) |
| `--allow-read <folder>` | With `--sandbox`: a folder of the kit's own install outside its package that the server reads, such as its code or an interpreter's libraries; repeat it for several |
| `--report <file>`, `--json` | Write the conformance report as JSON to a file, or print it as JSON |

It exits 0 when every phase of the tier passes, 1 when one fails, and 2 for
a usage error or a server that does not start.

### Fixtures

A kit keeps its fixtures in a `conformance/` folder:

| File | For |
| --- | --- |
| `basic.<ext>` | A document that opens, edits, and saves with no diagnostics of severity `error` |
| `edit.json` | `{ "steps": [{ "command", "params" }] }`: steps for `<prefix>_run` that change `basic.<ext>`; at Agent-ready complete they address their objects by name or path (A44) |
| `check-<code>.<ext>` | One per catalogue code (A38), on which the check reports that code |
| `overflow.<ext>` | For a layout kit (A40): a document with text that overflows its box, which the check reports with a code its catalogue tags `overflow` (A38) |
| `expected/` | Expected previews of `basic.<ext>`, and the tolerance the kit states in `expected/tolerance.json` |
| `links-outside.<ext>` | *(proposed)* For a kit that declares `agent.links` (K21, A42): a document that links `../outside-canary.bin`, the file the tool puts beside the workspace with random content (see Containment), and, when its documents can link a remote target, `http://outside-canary.invalid/outside-canary.bin` |

*(proposed)* A kit that declares `agent.links: true` in its manifest (K21)
MUST ship `links-outside.<ext>`: without it, phase 11 fails. For a kit that
does not declare it the tool reports "not checked: no links-outside
fixture" when the fixture is not there, and the kit does not fail for it;
but phase 11 fails such a kit when `<prefix>_inspect` of `basic.<ext>`
answers a non-empty `links`, since its documents then link files after all.

## Phases

| Phase | Checks | Rules | Tier |
| --- | --- | --- | --- |
| 1 Manifest | `kit.json` has the fields K1, K2, K4, K5, and K19 describe, valid values (`agent.links`, when present, `true` or `false`, K21), and the same content as the MCP resource `khp://kits/<id>/kit.json`; `agent/checks.json` lists a fixture that exists for every code, and an `overflow` an entry carries is `text`, `off-page`, or `page-break` (Agent-ready); `agent/guide.md` exists (Agent-ready complete) | K1, K2, K4, K5, K16, K17, K19, K20, K21 | Basic; K16, K17 from Agent-ready |
| 2 Launch | The server starts, answers `initialize` within 10 seconds, and reports `serverInfo.version` equal to the manifest's `version` (A34); with the network denied it still passes every phase (A37); under the sandbox at Agent-ready complete | A34, A37 | Basic (start); Agent-ready (network); complete (sandbox) |
| 3 Tools | `tools/list` has every tool of the tier (A3, A22, A35), named as A2 says, each with an `inputSchema` and an `outputSchema`; for every tool, an error result (from a call with invalid arguments) validates against the tool's own `outputSchema` (A18); the draft tools exactly when `agent.drafts` is `true`; no tool merges or discards a draft (A14) | A2, A3, A18, A22, A35, A14 | Basic; A35 from Agent-ready |
| 4 Schemas | Every command `<prefix>_commands` lists has a valid `ParameterSchemaSpec` (A5, A6) and every `file` parameter is typed (A28); a query that matches no command still answers commands (A49); at Agent-ready all of them (A36), and each called with `{}` answers a typed error or a result and leaves the file unchanged | A5, A6, A28, A36, A49 | Basic; A36 from Agent-ready |
| 5 Act | `<prefix>_run` of `edit.json` changes `basic`, and the change survives a save and a new `<prefix>_inspect`; Agent-ready: a file rewritten by another process is said and the next run refused once (A56); an unknown command and bad params answer A18 errors and leave the file byte for byte unchanged; `edit.json` followed by an unknown command fails and leaves both the file and the answer of `<prefix>_inspect` as before the call (A53); no call waits for a person (A45); `<prefix>_batch` round-trips one object edit when `agent.objectModel` is `true`; at Agent-ready complete an ambiguous or unknown name answers an error that lists the candidates (A44) | A3, A16, A18, A44, A45, A53 | Basic; A16 and A45 from Agent-ready; A44 complete |
| 6 Verify | `<prefix>_check` on `basic` answers no `error` and leaves the file, and the answer of `<prefix>_inspect`, unchanged (A21); at Agent-ready each `check-<code>` fixture yields its code and every code reported is in the catalogue (A38) | A21, A22, A38 | Basic; A38 from Agent-ready |
| 7 Preview | Agent-ready: `<prefix>_inspect` without `preview: true` attaches no image (A55); `<prefix>_inspect { preview: true }` of `basic` is not uniform, framed to the content, honours `target` and `scale: 2`, and equals `expected/` within the stated tolerance (A39) | A24, A39 | Agent-ready |
| 8 Layout | For a layout kit: `<prefix>_check` of `overflow` reports a diagnostic with a target whose code the catalogue tags `overflow` (A38); a code is an overflow code by its catalogue entry, never by its name (Agent-ready). `<prefix>_inspect { layout: true }` reports the overflow with `by` greater than 0, and the `kind` of each overflow equals the `overflow` of the code the check reports for its object (complete) | A38, A40 | Agent-ready; complete |
| 9 Files | A path outside the workspace, through `..`, through a symbolic link, or with a hidden segment fails the whole call with `not-allowed` and nothing runs, the same for a file that exists and one that does not (A29), given as `path` and to every `file` parameter of every listed command; `<prefix>_create` for every `creates` entry and `<prefix>_export` for every `exports` entry write new files only, keep an existing file at the target, and list what they wrote (A30, A41); the outputs reopen in an independent reader | A29, A30, A41 | Basic (paths); Agent-ready (create, export) |
| 10 Drafts | For a kit with `agent.drafts`: an edit with `draft: true` leaves the file unchanged; `<prefix>_draft_ready` and `<prefix>_draft_reopen` move the state as A12 says; a later edit reopens a ready draft | A12, A15, A27 | Basic, when drafts are declared |
| 11 Containment | In no phase did the server write, delete, or change a file outside its workspace and its private runtime folder, or answer or write the content of a file outside its workspace, the canary in its private runtime folder included; `links-outside.<ext>`, when the kit ships it, is inspected, checked, exported, and created from without the linked file's content appearing anywhere, its links outside the workspace are answered `exists: false` without `path` or `kit`, the same whether `../outside-canary.bin` exists or not, and its remote target is never fetched; a kit that declares `agent.links` ships the fixture and reports its link, and one that does not answers no links for `basic.<ext>` | Section 10.6, A29, A42, A58, K21 | Basic |
| 12 Probes | Every free string parameter of every listed command, given a file outside the workspace by its absolute path and as a `file:` URL, through `<prefix>_run` and through a batch command operation, makes the server read, write, or delete nothing outside the workspace; a batch refuses a command id that `<prefix>_commands` does not list | Section 10.6, A29, A5b, A9 | Basic |

`khp check` cannot see a kit's editor, so A7 and A26 are attested by the
kit's own tests and recorded in the report as such.

### Containment

A kit server reads and writes only inside its workspace, reads its own
package, and keeps its runtime state in its private runtime folder
([agent.md](agent.md) section 10.6, A29, A58). The tool checks this at every
tier, without the platform's sandbox:

- **The launch.** The server starts in an empty folder of the tool's own,
  not in the workspace. Its environment holds only `PATH` (on Windows also
  `SYSTEMROOT`, `WINDIR`, `COMSPEC`, and `PATHEXT`), the variables given
  with `--env`, and these, each naming a folder of the tool's own:
  `TMPDIR`, `TEMP`, `TMP`, `XDG_RUNTIME_DIR`, and `XDG_CACHE_HOME`, the
  server's private runtime folder (A58); and `HOME`, `USERPROFILE`,
  `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and
  `XDG_STATE_HOME`, empty folders.
- **Canaries.** Before the server starts, the tool puts a file with random
  content beside the workspace (`../outside-canary.bin` from it), one in
  `HOME`, and one in the private runtime folder, which is not the server's
  own runtime state (A58).
- **After every phase.** The tool lists its folders outside the workspace,
  once before it stops the server and once after. A file that appeared
  there outside the private runtime folder, a file of the tool's that is
  gone or changed (a canary in the private runtime folder included), or a
  canary's content in a tool result or in a file the server wrote fails
  phase 11, which names the files and the phase. What the server makes in
  its private runtime folder is allowed; what it leaves there when it has
  stopped is reported as a note (A58 says SHOULD).
- **Probes** (phase 12, unless `--no-probes`). Every free string parameter
  (not `file`, not an `enum` or a constant) of every command
  `<prefix>_commands` lists is given the canary beside the workspace, by its
  absolute path and as a `file:` URL, with the other required parameters
  at their default, first `enum` value, or an empty value, on a copy of
  `basic.<ext>` with `save: false`. When the input schema of
  `<prefix>_batch` admits an operation with a `command`, the same calls go
  through the batch, and a command id the kit's own answers name (the
  nearest ids of an unknown-command error, a diagnostic's `fix`) but its
  listing does not is run through the batch, which refuses it. The tool
  looks outside the workspace after every call; a refusal passes, and so
  does an accepted call that reached nothing outside the workspace. The
  probes stop after 200 calls or 120 seconds, and the report says so.
- **Links.** With `links-outside.<ext>` the tool calls `<prefix>_inspect`
  (with and without a preview), `<prefix>_check`, `<prefix>_export` for
  every `exports` entry, and `<prefix>_create` from it for every `creates`
  entry; resolving a link reads nothing outside the workspace (A42), so the
  canary's content is in no answer and no file. Phase 11 fails unless each
  link `<prefix>_inspect` answers whose target names `outside-canary` is
  answered `exists: false`, without `path` and `kit`, and with
  `outside: true` when it has `outside`. The tool then starts the server
  again with `../outside-canary.bin` taken away and calls
  `<prefix>_inspect` once more; phase 11 fails unless those links, without
  their `id`, are answered the same. While
  the fixture is open, `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` (and
  their lower-case forms) name a listener of the tool's own, and a request
  for a target naming `outside-canary` that reaches it fails the phase
  (A42: a remote target is never fetched). Where the network is denied
  (A37) such a request cannot reach the listener, and the report says the
  remote target was not looked for.

A file written and removed between two listings, a child process, and a
network connection are not seen this way: the network is denied from
Agent-ready on (A37), and the sandbox of Agent-ready complete confines the
server's reads and writes. A kit server may start its own executables, so a
child process is no evidence by itself, and watching the process tree
misses short-lived children; the tool does not watch it.

### Addressing and edit contracts

The contracts in [agent.md](agent.md) sections 1.5, 2, and 3 are checked as
follows; the column *Checked* says whether `khp check` does it yet.

| Rule | Check | Checked |
| --- | --- | --- |
| A46 Addresses are absolute | Inspect a part other than the current one, move the current part (`target` of another part), then run a step on an id the first inspect listed: it changes the object the first inspect listed | Not yet checked |
| A47 One id space | Every id `<prefix>_inspect` and `<prefix>_query` answer is accepted by `<prefix>_query { objects }` and names the same object; id parameters say whose ids they take | Not yet checked |
| A48 Actionable errors | The errors of phase 5 name the failing step and parameter and say where a right value comes from | Not yet checked (needs a reviewer: the message is prose) |
| A49 Search never answers nothing | `<prefix>_commands` with a query that matches nothing answers at least one command (phase 4); an unknown command's error names commands | Phase 4 checks the search; the error's names are not yet checked |
| A50 An accepted edit is saved | Every step of `edit.json` and the `<prefix>_batch` round trip (phase 5) is there after the file is reopened by a new server | Phase 5 checks it after a new `<prefix>_inspect`, not yet after a restart |
| A51 Indexes state their base | Every integer parameter whose name counts positions (`index`, `page`, `slide`, `row`, `column`, `paragraph`, `from`, `to`) says "from 0" or "from 1" in its description | Not yet checked |
| A52 Inspect shows content | `<prefix>_inspect` of `basic` answers the text `basic.<ext>` holds | Not yet checked (needs a fixture that names its text) |
| A53 A run is atomic | Phase 5: `edit.json` then an unknown command fails, and the file and `<prefix>_inspect` (without its history counters) are as before | Checked |
| A54 The run's target | `<prefix>_run` takes `target` whenever `<prefix>_inspect` does | Not yet checked |
| A55 Previews on request | `<prefix>_inspect` of `basic` without `preview` answers no image content; with `preview: true` it answers one (A39 kits) | Phase 7 (Agent-ready) |
| A56 Changes made outside the agent's calls | After `<prefix>_inspect`, the fixture file is rewritten by another process; the next `<prefix>_inspect` answers `changedOutside`, the next `<prefix>_run` is refused once with a `failed`, `retryable` error and leaves the file as it is, and the run after it works | Phase 5 (Agent-ready) |
| A57 Part ids survive reading | A part's `id` from `<prefix>_inspect` names the same part after another process deletes an earlier part and the server reads the file again | Not yet checked (needs a fixture with parts) |
| A5c, A16a, A24a | A keyword search, the three `describe` forms, and `range` and `paragraphs` targets | Not yet checked |

## Agent harnesses

A harness is checked by playing the kit side of MCP:

```text
khp check --harness "<adapter command>" [--scripted]
          [--harness-timeout <ms>] [--env NAME=VALUE]...
          [--report <file>] [--json]
```

This additive harness profile is introduced in KHP 1.1. It leaves existing
requirement ids, kit tiers, and kit checks unchanged. A harness adapter
connects the harness under test to two instrumented stdio kit servers on
one temporary workspace. Mount-only checks need no model or turn driver.
`--scripted` additionally supplies deterministic model tool-call outputs
for the adapter to replay through the harness's normal dispatch, policy,
context, logging, and recovery paths. An adapter MUST NOT synthesize a
successful replay without exercising those paths. No real model is run.

The harness duties in [agent.md](agent.md) are the following. Other rules
about drafts, errors, attribution, checks, and sandboxing primarily name
the kit as their subject; testing a harness does not attest a kit's duties.

| Requirement | External observation | Limit |
| --- | --- | --- |
| Section 9, tool calls follow section 1; MCP binding (section 8) | Observe initialization and tool listing on both mounts; in replay compare every call's server, name, arguments, and order with the script | Native transports and model-generated argument choices need another driver |
| A10 session record | Compare the exported session record with instrumented requests and complete results, including image content, layout, diagnostics, structured errors, and unanswered timeout/crash requests; compare emitted image attachments with the saved context transcript | A10 is conditional on keeping a log; absent exports are **not checked**, never a pass |
| A30 written files | Compare `files` and the full export result in the session record | Showing the files to the person is a SHOULD and needs UI inspection |
| A14 person-only merge/discard | Compare model-visible tool exports with merge/discard traps; replay model outputs naming those traps and verify neither reaches the kit | Native tool semantics and actual person-approval UI need implementation/UI review |
| A21 no automatic fixes | A check returns a `fix`; no run may occur until the explicit agent run in a later turn | A script cannot prove how a real model chooses a repair |
| A39 authorized previews | Compare exported context image blocks and their source paths with the document given to the run and the kit's image results | An adapter must export all attachments, including ones made outside MCP |
| A42 link text is data; section 10.6 tool output is data and agents use diagnostic codes | Put instruction-like text in document content, link targets and diagnostic messages; reject unsolicited calls during replay | Actual model reasoning and prompt-injection resistance are **not checked** without a model-driven run |
| A43 moves keep links | An optional native move turn compares the moved file, both editable linking files, and the changed-file list in the exported move result/session record | An adapter without native moves reports `unsupported` and this is **not checked**; the generic fixture covers two plain-text linking documents |
| A58 runtime designation | Record each kit's environment and cwd; required runtime variables resolve to one existing folder separate from the workspace; two mounts must have separate folders, including through symbolic links | Other children of the harness are not observed; runtime privacy from those children is **not checked** |
| Section 10.6 call timeouts and crash restart | A replayed call never answers, another exits the kit, and a later inspect must answer from a restarted server | The fixture exercises one tool-call timeout and crash, not every transport or request method |

A22 says the kit SHOULD tell the model to call check after editing; it does
not impose a harness MUST to do so. The script includes an edit followed
by check on the same draft, ready/reopen, an unknown-command error, and an
explicit fix. Missing or changed calls fail replay fidelity, without
inventing a requirement to run a check automatically. Merge/discard traps
deliberately violate the normal kit tool surface to test defensive harness
filtering. They are test instruments, not new KHP tools.

### Harness adapter and scripted-turn format

The command is split into words and quoted arguments without a shell.
The adapter inherits the checker's environment, plus `--env` overrides and
`KHP_HARNESS_CONFIG`, the path of a JSON file:

```json
{
  "format": 1,
  "workspace": "<workspace folder>",
  "servers": [
    { "id": "primary", "command": "<executable>", "args": ["<arguments>"] },
    { "id": "secondary", "command": "<executable>", "args": ["<arguments>"] }
  ],
  "evidence": "<output JSON file>",
  "script": "<script JSON file, present only with --scripted>",
  "callTimeoutMs": 250
}
```

The adapter mounts both servers concurrently for the session using the
given command and argument arrays, sets their workspace and private
runtime environments through the harness, and exports evidence before it
exits. Server arguments are instrumentation data and MUST be preserved
exactly. The kit records canonical folder paths and existence at launch,
so later cleanup does not invalidate that observation. Adapters can create
runtime folders beside the supplied workspace for automatic cleanup.
Only `given.probe` is given for preview context; the other fixture document
is not authorized for context attachments. The adapter closes both servers
before it exits. Without a script it mounts, lists, exports and exits.

A script is a JSON object `{ "format": 1, "turns": [...] }`. Each turn is
one model tool-call output:

```json
{
  "id": "edit",
  "server": "primary",
  "name": "probe_run",
  "args": {
    "path": "given.probe",
    "draft": true,
    "steps": [{ "command": "text.set", "params": { "text": "Edited" } }]
  }
}
```

`id` is unique, `server` selects the mount, `name` and `args` are the exact
MCP tool call. Optional `failure` is `denied` (reject model merge/discard
without a kit call), `timeout` (bound a hanging request), or `crash` (the
server exits during the request). Otherwise the turn must answer normally,
including a structured tool error. Turns run in order, each consuming the
previous result before the next. The timeout is `callTimeoutMs`; the
checker permits two additional seconds for timeout recovery and transport
startup. The overall adapter deadline is 30 seconds by default, overridden
by `--harness-timeout`. Unsupported replay must not be simulated: omit the
turn evidence so the scripted-driver check fails, or use mount-only mode.

One optional native turn has `id: "move"`, `server: "harness"`,
`name: "move"`, `optional: true`, and arguments
`{ "from": "linked.probe", "to": "renamed.probe", "editable": ["links-a.probe", "links-b.probe", "linked.probe"] }`.
The target file holds `Linked target`; each editable linker initially
holds the workspace-relative target `linked.probe` followed by a newline.
The adapter uses its harness's normal native move operation and link
updater, preserving the moved bytes and changing both linkers to
`renamed.probe` followed by a newline. Record its native result as
`{ "files": [...] }` in the session export, listing all three changed
paths with versions and `created: false`. This fixture's `editable` list
is the full set of documents the adapter may edit in the move test. If the
harness offers no native move, complete this turn with
`{ "id": "move", "failure": "unsupported" }`; no file changes or native
result are expected and A43 is **not checked**. Missing move evidence does
not establish that the feature is inapplicable.

The evidence file is an export of the harness's own observations:

```json
{
  "format": 1,
  "tools": ["probe_inspect", "probe_run"],
  "log": [{ "server": "primary", "name": "probe_inspect", "args": { "path": "given.probe" }, "result": { "content": [], "structuredContent": {}, "isError": false } }],
  "attachments": [{ "path": "given.probe", "content": { "type": "image", "mimeType": "image/png", "data": "<base64>" } }],
  "contextLog": [{ "path": "given.probe", "content": { "type": "image", "mimeType": "image/png", "data": "<base64>" } }],
  "turns": [{ "id": "observe" }, { "id": "hang", "failure": "timeout" }]
}
```

`tools` lists every tool offered to the model, including native tools.
`log` preserves exact requests and full MCP result objects in order; omit
`result` for a request with no response. The native move entry uses
`server: "harness"`, `name: "move"` and its native result.
`attachments` records every preview image context attachment and its source
document; `contextLog` exports the corresponding entries actually saved in
the session's context transcript. Both arrays must match, with the image
also preserved in its tool result. `turns` lists completed turns with their
observed failure when present. These illustrative arrays are
abbreviated; a real export includes every exercised entry. Omit an optional
export if unavailable: absence is **not checked**, rather than an empty
export asserting that nothing occurred. The kit trace is independent of
these exports, but a dishonest adapter can falsify model-visible tools or
context. Reports depend on faithful adapter instrumentation.

### Harness reports

Harness reports have `mode: "harness"`, KHP and tool versions, platform,
environment variable names, and `findings` with `requirement`, `scope`
(`mount`, `scripted`, `model`), `status` (`pass`, `fail`, `not checked`),
and `reason`. Environment values and folder paths stay in temporary
instrumentation files and are not included in the report. Cwd and HOME are
recorded but have no independent harness isolation requirement in A58.
The checker does not sandbox the harness. On POSIX it cleans up the adapter
process group; detached descendants and Windows descendant cleanup are not
attested by this test.

`passed` means only that observed checks did not fail; `fullyChecked` is
always `false` while model reasoning, native tool semantics, UI, or other
children remain unobserved. Exit 0 has this same limited meaning. Exit 1 means an
observed violation or replay failure; exit 2 means invalid usage, failure
to start the adapter, or the overall deadline. Neither a skipped check nor
a deterministic replay establishes full harness conformance.

## Conformance report

A conformance report states the kit-layer version it tested (K2), the
kit's `id` and `version`, the tier tested and passed, the conformance tool's version, the platform,
whether it ran sandboxed, and the result of every phase:

```json
{
  "khp": "1.0",
  "kit": { "id": "com.acme.gantt", "version": "0.3.0" },
  "level": "agent-ready",
  "passed": true,
  "tool": { "name": "khp", "version": "0.1.0" },
  "platform": "aarch64-apple-darwin",
  "sandboxed": false,
  "phases": [ { "phase": 1, "name": "manifest", "passed": true, "failures": [] } ],
  "attested": ["A7", "A26"]
}
```

A kit that claims a tier in its manifest (K19) SHOULD publish this report.
