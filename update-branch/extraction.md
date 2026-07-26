Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

`comment` is posted publicly on the PR, so write it for whoever has to trust this merge. State
each non-trivial resolution and why you chose it. If `npm run verify` does not pass, say so in
the **first line**.

```json
<output>
{
  "comment": "Merged `main` into this branch, resolving 2 conflicts.\n\n- `src/rules/index.ts` — both sides registered a new rule; kept both entries in id order.\n- `src/manifest.ts` — `main` moved `isArchiveType` while this branch edited its doc comment; took the moved version and reapplied the edit.\n\n`npm run verify` passes (105 tests)."
}
</output>
```
