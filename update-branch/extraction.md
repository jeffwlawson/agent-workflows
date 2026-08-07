Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

`comment` is posted publicly on the PR, so write it for whoever has to trust this merge. State
each non-trivial resolution and why you chose it. If `npm run verify` does not pass, say so in
the **first line**.

Name the branch that was **actually** merged — this PR's base, which is frequently not the
repository's default branch. This file is not templated (the extraction run gets no prompt
arguments), so the branch named below is a stand-in, never the answer.

```json
<output>
{
  "comment": "Merged `release/2.x` into this branch, resolving 2 conflicts.\n\n- `src/registry.ts` — both sides added an entry to the same list; kept both, in the file's existing order.\n- `src/helpers.ts` — `release/2.x` moved a function while this branch edited its doc comment; took the moved version and reapplied the edit.\n\n`npm run verify` passes (105 tests)."
}
</output>
```
