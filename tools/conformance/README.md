# @kitharness/conformance: `khp check`

Tests a kit's MCP server against the Kit Harness Protocol, tier by tier, as
[the conformance specification](https://kitharness.org/spec/conformance/) says. It talks to the kit only over MCP (stdio),
so it tests a kit whatever it is written in.

Run it from a clone of [the repository](https://github.com/kitharness/kitharness), with Node.js
22.18 or later and pnpm 10:

```sh
git clone https://github.com/kitharness/kitharness.git
cd kitharness
pnpm --dir tools/conformance install --frozen-lockfile
pnpm --dir tools/conformance build
node tools/conformance/dist/cli.js check --kit "<start command> … {workspace} …" --package <folder> [--level basic|agent-ready|agent-ready-complete] [--env NAME=VALUE]... [--no-probes] [--json] [--report report.json]
```

`pnpm build` writes `dist/`; `dist/cli.js` is the `khp` executable of the package. Without the
build step, `node src/cli.ts check …` from `tools/conformance` runs the same checker from its
TypeScript source. Once `@kitharness/conformance` is published to npm,
`npx @kitharness/conformance check …` will be the short form of the same command. Below,
`khp check` names the checker however you run it.

The tool is licensed under Apache-2.0; see [LICENSE](LICENSE), which is
identical to the repository's root licence. Dependencies declared in
`package.json` are installed separately under their upstream licences;
their source is not vendored or bundled into this package.

- The workspace is a fresh copy of the fixtures folder (`conformance/` beside `kit.json`, or
  `--fixtures`). The start command names it with `{workspace}`, which khp check replaces by the
  folder's absolute path: `--kit "my-kit-server --workspace {workspace}"`; a command without
  `{workspace}` is a usage error. Every phase starts the server afresh on a new copy.
- The server does not start in the workspace: its current folder is an empty folder of khp check's
  own, so a relative path in the start command does not resolve there (khp check makes a relative
  executable absolute; give other paths absolute). Its environment is exactly:
  - `PATH` from khp check's own environment (on Windows also `SYSTEMROOT`, `WINDIR`, `COMSPEC`,
    `PATHEXT`);
  - `TMPDIR`, `TEMP`, `TMP`, `XDG_RUNTIME_DIR` and `XDG_CACHE_HOME`, all naming one folder of khp
    check's own, `private/`: the server's private runtime folder (A58);
  - `HOME` and `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `APPDATA` and
    `LOCALAPPDATA`, each naming an empty folder of khp check's own;
  - each `--env NAME=VALUE` (repeat it for several), for configuration a server legitimately takes,
    such as a fonts folder. `--env` cannot set the folder variables above.

  The report lists the variables' names (`environment`), never their values.
- At Agent-ready and above every phase runs with the network denied (A37): `sandbox-exec` on macOS,
  `unshare --net` on Linux.
- `--sandbox` (Agent-ready complete, macOS only) also denies, as section 10.6 says, reading any
  file's content outside the workspace, the kit's package (`--package`), and its private runtime
  folder (`private/`, A58), and writing outside the workspace and that folder. What a process needs
  to start stays readable: `/` itself, `/System`, `/usr/lib`, `/usr/libexec`, `/usr/share`,
  `/usr/bin`, `/usr/sbin`, `/bin`, `/sbin`, `/Library/Apple`, the dyld cache and time zones in
  `/private/var/db`, a few devices, and the start command's executable (and a script's interpreter,
  found through its `#!` line and `PATH`). A file's metadata stays readable, since resolving a path
  reads it. User fonts (`/Library/Fonts`), Homebrew and other installs, and home folders are not
  readable: khp check cannot know which folders a kit's install spans, so `--allow-read <folder>`
  (repeat it) names one, such as the server's code when it lives outside the package or an
  interpreter's libraries. A folder that holds khp check's own temporary folder is refused, since the
  canaries are there.
- Exit status: 0 when every phase of the tier passes, 1 when one fails, 2 for a usage error or a
  server that does not start.
- `--level` tests any tier; without it khp check tests the tier the manifest claims (`level`,
  K19). The report states both: `level` is the tier tested, and `claim` is
  `{ level, verified, note }` with the claimed tier. `verified` is true only when the tested tier is
  the claimed one and every phase passed; a pass at a tier above the claim is not a conformance
  claim at that tier, and the text report says so on its second line.

## What each phase checks

| Phase | khp check does |
| --- | --- |
| 1 Manifest | `kit.json` fields (K1, K2, K4, K5, K19, `agent.prefix`, and `agent.links` `true` or `false` when present, K21); the resource `khp://kits/<id>/kit.json` lists and equals it (K20); Agent-ready: K16, `agent/checks.json` with a fixture per code (K17, A38), and an entry's `overflow`, when present, is `text`, `off-page`, or `page-break` (A38); complete: `agent/guide.md` |
| 2 Launch | `initialize` within 10 s; Agent-ready: `serverInfo.version` equals the manifest's (A34), the network is denied for the whole run (A37); complete: `--sandbox` |
| 3 Tools | The tools of the tier (A3, A22, A35), the draft tools exactly when `agent.drafts` is true, A2 names, no merge or discard tool (A14), an `inputSchema` and `outputSchema` each, and a call with invalid arguments answers an A18 error its own `outputSchema` accepts |
| 4 Schemas | Lists every command with `<prefix>_commands` without a query, page by page (A5b: ordered by id, `total`, `next`, a foreign cursor refused as `invalid-params`), once compact and once with `detail: true`; each compact row has an id, a title, and its parameters (A5a); each full row and an exact-id query give a ParameterSchemaSpec or its JSON Schema form (A5, A6) with well-formed `file` parameters (A28, A29); a query that matches nothing still answers commands (A49); Agent-ready: each run with `{}` answers a result or a typed error that leaves the file (A36) |
| 5 Act | `edit.json` changes and saves `basic`, and `<prefix>_inspect` sees it; an unknown command and bad params answer A18 errors and leave the file byte for byte; `edit.json` followed by an unknown command fails and leaves the file and `<prefix>_inspect` as before (A53); Agent-ready: after another process rewrites the file, the next `<prefix>_inspect` answers `changedOutside`, the next `<prefix>_run` is refused once (`failed`, `retryable`) and leaves the file, and the run after it works (A56); Agent-ready with an object model: `<prefix>_batch` sets one free string field (of the root, or of an object the root lists) and `<prefix>_query` reads it back (A16); the field is not `readOnly`, an `enum` or `const`, a reference, or constrained in the JSON Schema `<prefix>_query { describe: "*" }` answers (A16a), not named as an id or handle, and not holding an object's id, and a field the kit refuses with `invalid-value`, `invalid-op` or `read-only` (leaving the file) is skipped for the next |
| 6 Verify | `<prefix>_check` on `basic`: no `error`, diagnostics shaped as A21, a summary, the file and `<prefix>_inspect` unchanged; Agent-ready: each `check-<code>` fixture yields its code and only catalogued codes (A38) |
| 7 Preview | Agent-ready: `<prefix>_inspect` without `preview: true` attaches no image (A55); the preview is not blank, transparent or one colour; it equals `expected/basic.png` (and `expected/basic-scale-2.png` at `scale: 2`) within `expected/tolerance.json`; `scale: 2` doubles it; `maxSize` bounds it; `target` (a diagnostic's target from a check fixture) previews a part (A24, A39) |
| 8 Layout | Layout kits at Agent-ready: `overflow.<ext>` yields an overflow diagnostic with a target, where an overflow diagnostic is one whose code `agent/checks.json` tags `overflow` (A38, A40); the code's name does not count, so a catalogue that tags nothing fails with the codes the fixture yielded and the member to add; complete: `layout: true` answers an overflow with `by` > 0 (A40), and each overflow's `kind` equals the tag of the code the check reports for its object (`target.objectId`) |
| 9 Files | Paths through `..`, absolute, through a symbolic link, or with a hidden segment fail `<prefix>_inspect` and `<prefix>_run` with `not-allowed`, the same for an existing and a missing file (the same code, and the same message once the path is taken out), and nothing runs (A29); so does each such path given to every `file` parameter of every listed command (other required parameters filled with their default, first `enum` value, or an empty value), run on a copy of `basic` with `save: false`, at most 96 calls; Agent-ready: `<prefix>_create` per `creates` entry and `<prefix>_export` per `exports` entry write new files, list them (A30), never replace a file, and an independent reader opens the export where khp check has one (A41) |
| 10 Drafts | When `agent.drafts`: a draft edit leaves the file; `draft_ready` and `draft_reopen` move the state; a later edit reopens a ready draft when the result says the draft's state (A12, A15) |
| 11 Containment | Every tier: what the server did outside its workspace in phases 1 to 11 (section 10.6, A29, A58), see below |
| 12 Probes | Every tier, unless `--no-probes`: every free string parameter of every listed command (not a `file`, not an `enum` or `const`) is given the canary's absolute path and a `file:` URL of it, through `<prefix>_run` on a copy of `basic` with `save: false`; when `<prefix>_batch`'s input schema admits a command operation (an operation with a `command` property), through the batch too; and a command id the kit's own answers name (an unknown-command error's nearest ids, a diagnostic's `fix`) but `<prefix>_commands` does not list is run through the batch, which must refuse it (A5b, A9). A refusal is fine and so is an accepted call, as long as nothing outside the workspace is read, written, or deleted, which khp check looks for after every call. At most 200 calls and 120 s; the report says when that cut the probe short |

## Containment (every tier)

Section 10.6 says a kit server reads and writes only inside its workspace, reads its own package,
and keeps its runtime state in its private runtime folder (A58). khp check checks it at every tier
without an OS sandbox. Each server start gets a folder of its own:

| In the folder | What it is |
| --- | --- |
| `workspace/` | the copy of the fixtures |
| `outside-canary.bin` | a canary beside the workspace (`../outside-canary.bin` from it) with random content |
| `cwd/` | the server's current folder |
| `home/` | `HOME`, `USERPROFILE`; holds the canary `khp-canary.txt` |
| `private/` | the private runtime folder (A58): `TMPDIR`, `TEMP`, `TMP`, `XDG_RUNTIME_DIR`, `XDG_CACHE_HOME`; holds the canary `khp-canary.txt` |
| `xdg-config/`, `xdg-data/`, `xdg-state/` | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`; `APPDATA` and `LOCALAPPDATA` are `xdg-data/` |
| `outside/` | the files of the A29 path checks (phase 9) |

The folder is made in `/tmp` on macOS and Linux (elsewhere in the system's temporary folder), so
that the paths the server gets are short: a server that puts a Unix socket in `TMPDIR` cannot start
when the socket's path exceeds the system's limit (104 bytes on macOS).

khp check lists everything but `workspace/` before the server starts, again just before it stops
the server, and again when it has stopped. Phase 11 fails with, per phase:

- *the kit wrote outside its workspace (section 10.6)*: the files that appeared outside `private/`,
  relative to that folder (`home/.cache/x`, `cwd/log.txt`, `counter-kit.log` beside the workspace);
- *the kit deleted / changed a file outside its workspace (section 10.6, A29)*: a canary (the one in
  `private/` too) or another file of khp check's that is gone or different;
- *the kit read a file outside its workspace and answered / wrote its content (section 10.6, A29)*:
  a canary's content (or its base64) in a tool result, or in a file in the workspace or outside it;
  for the canary in `private/` the message names A58, since a file that was in the private runtime
  folder before the server started is not its runtime state.

What the server makes in `private/` (a socket, a cache, scratch files) is allowed at every tier and
counted in a note. What it leaves there when it has stopped is named in a note, not a failure: A58
says a kit server SHOULD remove what it created there when it exits.

Phase 11 also opens `links-outside.<ext>` when the fixtures have it (*proposed* in the
specification, for a kit whose documents link other files, A42): a document that links
`../outside-canary.bin` and, when the kit's documents can link remote targets,
`http://outside-canary.invalid/outside-canary.bin`. khp check calls `<prefix>_inspect` (with and
without a preview), `<prefix>_check`, `<prefix>_export` for every `exports` entry, and
`<prefix>_create` with `from` for every `creates` entry, where the kit offers them; the canary's
content may appear in no answer and no file. Phase 11 then fails when:

- a link whose target names `outside-canary` is answered with `exists` other than `false`, with a
  `path` or a `kit`, or with `outside` other than `true` (A42);
- those links (without their `id`) are answered differently in a second start in which khp check
  took `../outside-canary.bin` away (A42, A29: nothing may tell an existing target from a missing
  one);
- a request for a target naming `outside-canary` reaches the listener that `HTTP_PROXY`,
  `HTTPS_PROXY`, and `ALL_PROXY` (and their lower-case forms) name while the fixture is open (A42: a
  remote target is never fetched). Where the network is denied (A37) the request cannot reach it, and
  a note says so.

The fixture is required of a kit whose manifest says `agent.links: true` (K21): without it phase 11
fails, and so it does when that kit's `<prefix>_inspect` of the fixture answers no link to
`../outside-canary.bin`. A kit that does not declare `agent.links` and has no fixture gets the note
"not checked: no links-outside fixture" and does not fail; but phase 11 fails it when its
`<prefix>_inspect` of `basic.<ext>` answers a non-empty `links` (K21: its documents link files after
all).

A file the server writes and removes between two listings is not seen.

Child processes and network connections are not watched without a sandbox: a kit server
legitimately starts its own executables, so a child process is no evidence by itself, and sampling
the process tree misses short-lived children. The network is denied from Agent-ready on (A37).

A7 and A26 are attested by the kit's own tests and listed as such in every report. What khp check
could not observe is reported as a note, never as a pass.

`expected/tolerance.json` is read as `{ "maxChannelDelta": n, "maxDifferentPixels": n }` (both 0
when absent). A44 (Agent-ready complete) has no automated check yet, so khp check does not pass that
tier.

## Harness mode

```sh
khp check --harness "<adapter command>" [--scripted] [--harness-timeout 30000] [--env NAME=VALUE]... [--json] [--report report.json]
```

The adapter starts the harness under test, mounts the two supplied stdio
probe kits, exports evidence and exits. The command uses quoted arguments
without a shell; it inherits the checker's environment plus `--env` and
`KHP_HARNESS_CONFIG`. Kit-mode options cannot be combined with harness mode.
The harness chooses its kit processes' environment and folders, so those
choices can be observed. Neither the harness nor its children are sandboxed
by this mode.

The configuration JSON supplies `format: 1`, `workspace`, `servers`
(`id`, `command`, `args`), an `evidence` output path, `callTimeoutMs`, and,
with `--scripted`, a `script` path. Mount both kits for the session through
the harness's ordinary MCP path and preserve the supplied arguments.
Assign separate runtime folders outside the workspace under A58; folders
beside the supplied workspace are cleaned up by the checker. The kit records
canonical folders at launch, so runtime cleanup before adapter exit is
allowed. Only `given.probe` is authorized for preview context. Close the
kits before the adapter exits.

The script is `{ "format": 1, "turns": [...] }`. Each turn has `id`,
`server`, `name`, `args`, and optional `failure` (`denied`, `timeout`,
`crash`). Feed each turn as a model tool-call output through normal harness
dispatch, policy, logging and context handling. Replay it in order and
record the completed turn before proceeding. The fixture covers draft
edit/check, ready/reopen, refused merge/discard, an unknown command,
explicit diagnostic fix, file export, a hanging call and a crash followed
by another inspect. A22 does not impose an automatic post-edit check on
the harness; the replay asks for that check explicitly.

The optional native `move` turn uses `server: "harness"`, `name: "move"`
and `optional: true`. Its arguments specify `from`, `to`, and all editable
linking files. Invoke the harness's ordinary native move and link updater:
both plain-text linking documents must change from `linked.probe` to
`renamed.probe`, and the target bytes must survive. Export the native
`{ files: [...] }` result in the session log with all three changed paths,
versions, and `created: false`. If native moves are absent, complete that
turn with `failure: "unsupported"` and A43 is **not checked**.

Export evidence as `format: 1`, `tools` (all model-visible tool names),
optional `log` (ordered `{ server, name, args, result }`, complete MCP
results; omit `result` for unanswered calls), `attachments` (every preview
`{ path, content }` model-context attachment), `contextLog` (the corresponding
entries actually saved in the session context transcript), and `turns` (ordered
`{ id, failure? }`). Unavailable exports are omitted and reported **not
checked**. Export existing harness observations; do not manufacture them
from the script. The checker compares these with the kit's independent
trace. Model-tool and attachment exports still rely on a faithful adapter.
The full format and examples are in the
[specification](../../spec/conformance.md#harness-adapter-and-scripted-turn-format).

For a source-checkout example, from this directory:

```sh
node src/cli.ts check --harness "node '$REPO_ROOT/tools/conformance/test/fixture-harness.ts'" --scripted --json
```

`test/fixture-harness.ts` is the reference adapter and `src/harness-kit.ts`
is the instrumented kit. A harness without replay support can use
mount-only mode. Asking an unsupported adapter to replay must fail the
scripted-driver check rather than claim success.

The KHP 1.1 harness report separates `mount`, `scripted` and `model`
findings with `pass`, `fail` or `not checked`, each with a reason. It
reports environment variable names, never values or launch paths. Exit 0
means observed checks passed, 1 an observed violation/replay failure, and
2 invalid usage, failure to start, or an overall adapter deadline.
`fullyChecked` is always false: real-model interpretation of untrusted
data, native tool semantics, unsupported moves/renames (A43), person-facing UI,
and privacy from unrelated child processes remain unverified. POSIX
adapter process groups are cleaned up; detached descendants and Windows
descendant cleanup are not attested. Existing kit-mode checks report
kit layer 1.0, the version kits name in `khp` (K2), and remain unchanged.

## Tests

`pnpm test` runs khp check against `test/fixture-kit.ts`, a small counter kit: it passes as is, and
`KHP_BREAK=<phase>` breaks one phase on purpose so each test shows that phase failing.
`KHP_LAYOUT=<variant>` makes it a layout kit whose overflow code is tagged, untagged, tagged
wrongly, or reported without a target, so the tests cover phase 8.
`KHP_ESCAPE=<name>[,<name>…]` makes it reach outside its workspace (the fixture's `ESCAPES`), so
the tests show each containment check catching it; `KHP_RUNTIME=tidy|leave` makes it keep a socket
and a cache in its private runtime folder and remove them at exit, or leave them (A58);
`KHP_LINKS=false|absent` changes what its manifest says of `agent.links` (K21); khp check passes these variables to it with
`--env`, as it would any other. Its destructive escapes act only under `KHP_TEST_ROOT`, the test's
own temporary folder, in which the tests make khp check's folders.
`pnpm typecheck` checks the types.

`test/harness.test.ts` adds conforming and violating deterministic harnesses
for runtime designation, tool exposure and model merge attempts, exact
session results and file metadata, preview sources, unsolicited fixes,
injected commands, drafts, errors, check replay and restart behavior. It
also covers missing evidence, startup/deadline failures, CLI mode conflicts
and persisted reports. The gating test is
`khp.conformance.harness/scripted-contract`.

`test/cli.test.ts` covers installed-package symlinks and paths with spaces
(`regressions/issue-1`). `test/containment.test.ts` checks that planting
fixtures preserves runtime-file ownership and evidence of outside changes
(`regressions/issue-2`). Both run as part of `pnpm test`.
