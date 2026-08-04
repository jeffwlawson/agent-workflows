Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

`comment` is posted publicly on the PR, so write it for whoever has to trust this merge. State
each non-trivial resolution and why you chose it. If `npm run verify` does not pass, say so in
the **first line**.

```json
<output>
{
  "comment": "Merged `main` into this branch, resolving 2 conflicts.\n\n- `src/registry.ts` — both sides added an entry to the same list; kept both, in the file's existing order.\n- `src/helpers.ts` — `main` moved a function while this branch edited its doc comment; took the moved version and reapplied the edit.\n\n`npm run verify` passes (105 tests)."
}
</output>
```
