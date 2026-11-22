# Kit Harness Protocol (KHP) Repository Rules

## Quality rules (read first)

- Tests are the spec. Read `docs/quality.md` and the feature catalogue (`features.yaml`)
  before changing behaviour. When code and a case disagree, the case wins unless a maintainer approves
  changing the case.
- Before you finish any task, run `! grep -rIlE '/(Users|home)/[a-z]' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist .`. If it fails, the task is not done. Claude Code
  runs it for you through the Stop hook; agents without hooks (Codex) run it by hand and
  report the real exit code.
- Never edit expected results to make a test pass: files under `cases/**/expected/`, paths
  listed under `protected` in `features.yaml`, and the `expected`, `tolerance`, `reference`,
  `input` and `steps` of an existing `case.yaml`. If you believe an expected result is wrong,
  stop and explain why in the task's findings; only a maintainer approves expected-result changes.
- Never weaken a test to make it pass: no deleted or loosened assertions, no added
  `#[ignore]`, `.skip`, `.only` or `.todo`, no raised tolerances.
- Every bug fix starts with a failing case under `cases/regressions/issue-<n>/`, then the fix.
- Every new feature adds an entry to `features.yaml` and at least one gating test.
- Use plain-English commit messages that describe the change.
- Stage only your own files: `git add` them by name; never `git commit -a` or `git add -A`.
  Other sessions may have uncommitted work in the same checkout.
- Only a maintainer starts real-model `layer: eval` cases. Deterministic conformance
  tests and scripted harness checks call no model.
- No compatibility layers: no aliases, old names, old file suffixes, migrations, or readers for
  old formats. Delete a replaced path in the same change.

- This repository holds the Kit Harness Protocol (KHP): how an AI agent uses a
  kit, bound to MCP. The specification is four pages in `spec/`: `index.md`,
  `agent.md` (the agent rules, A), `manifest.md` (the manifest rules, K) and
  `conformance.md`. Implementation-specific data models, engines, hosts,
  editors, sync, and embedding are outside KHP.
- Everything is written in English. Requirements use RFC 2119 keywords and
  keep their IDs (A, K); never renumber an existing ID or reuse a retired one.
- A page is readable alone and names no private repository or local path.
  Kition implementation notes do not belong in `spec/`.
- A minor version of KHP only adds requirements. A change that removes or
  changes a requirement bumps the major version and is recorded in
  `CHANGES.md`.
- Never write a local username, home
  directory, absolute workspace path, secret, token, or private key into any
  file. Links are repository-relative; command examples use placeholders such
  as `$REPO_ROOT`.
- Run checks locally. Do not add GitHub Actions workflows.
