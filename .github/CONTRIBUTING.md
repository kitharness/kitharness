# Contributing to the Kit Harness Protocol

Thank you for helping. This repository holds the KHP specification (`spec/`), the conformance
checker (`tools/conformance/`), an example kit (`examples/docx-python/`), and their gating tests
(`cases/`, `features.yaml`).

## Before you start

- For a change to the specification, open an issue first and describe the problem it solves. A
  specification change affects every kit and harness, so it is discussed before it is written.
- For a bug in the checker or the example, open an issue with the command you ran and its output,
  or send a pull request that starts with a failing case (see below).
- Security problems are not reported in public issues; see [SECURITY.md](SECURITY.md).

## Rules for changes

- Everything is written in English. Requirements use the RFC 2119 keywords and keep their ids
  (A, K): never renumber an id or reuse a retired one.
- A minor version of KHP only adds. A change that removes or changes a requirement bumps the
  major version and is recorded in [CHANGES.md](../CHANGES.md).
- A specification page is readable alone and stays implementation-neutral: no product notes,
  private repositories, or local paths in `spec/`.
- Tests are the specification. A bug fix starts with a failing case under
  `cases/regressions/issue-<n>/`; a new feature adds an entry to `features.yaml` and at least one
  gating test. Never edit expected results or loosen a test to make it pass.
- Never write a local username, home directory, absolute path, secret, or token into a file.
  Links are repository-relative; command examples use placeholders such as `$REPO_ROOT`.

## Local checks

[docs/quality.md](../docs/quality.md) lists the commands: build, type check, and test the checker,
run the example kit's case, and run the local-path scan. Run them before you open a pull request
and say in it what you ran.

## License

By contributing you agree that your contribution is licensed under the Apache License 2.0, the
license of this repository ([LICENSE](../LICENSE)).
