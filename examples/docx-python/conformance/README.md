# Fixtures to generate

Generate the untracked binary fixtures locally. From the repository root,
after following the example's environment and dependency setup, run:

```sh
"$KHP_PYTHON_ENV/bin/python" -B \
  "$REPO_ROOT/examples/docx-python/generate_fixtures.py"
```

This creates exactly these files beside this README:

| File | Content and purpose |
| --- | --- |
| `basic.docx` | Heading `A small report` at body paragraph 0, body paragraph `The first paragraph is ready to edit.` at index 1, and one table with cells `Task` and `Status`. Opens, edits and saves with no error diagnostics. |
| `links-outside.docx` | A body paragraph and two actual external hyperlink relationships to `../outside-canary.bin` and `http://outside-canary.invalid/outside-canary.bin`. Required by `agent.links: true` (A42, K21). The generator creates neither target. |

`edit.json` is already supplied: it changes paragraph 1 and appends a
paragraph to `basic.docx`. The generator refuses to replace an existing
fixture; explicitly remove both generated DOCX files before regenerating.

No `check-<code>.docx` files are needed: the catalogue is empty at basic.
No expected previews or `overflow.docx` are needed at this tier, even though
DOCX is a paginated format (`agent.layout: true`). The example supplies no
renderer and makes no Agent-ready claim. Run `khp check` only after both
DOCX files exist; missing fixtures fail conformance.
