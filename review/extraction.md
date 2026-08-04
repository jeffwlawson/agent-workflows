Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

Each inline comment's `line` must be a line that appears in the diff above (a changed or context
line on the new side). A comment on a line outside the diff is dropped.

`startLine` is optional and turns the anchor into a range. Include it **only** when the body
carries a ```suggestion block replacing more than one line: `startLine` is the first line
replaced, `line` is the last. Every line in that range must also be in the diff, or the comment
is dropped. Omit `startLine` for single-line comments.

Label every finding **blocking** or **judgement call**, in both the summary and inline comments.
Blocking means the change is wrong or unsafe as it stands. A judgement call is a preference you
would accept being overruled on. The label carries the weight, so the prose does not have to.

Every inline comment `body` is under 120 words: the label, then the defect, then its consequence,
then the code you mean. The examples below are the shape, not the subject matter.

```json
<output>
{
  "summary": "Under 250 words. Open with the verdict — merge, merge with changes, or do not merge — then each finding worst first, one short paragraph each, quoting the code or check result it rests on.",
  "inlineComments": [
    { "path": "src/example.ts", "line": 42, "body": "**Blocking.** `parse()` returns before the guard below it runs, so a malformed input reaches `apply()` unchecked." },
    { "path": "src/helpers.ts", "startLine": 87, "line": 88, "body": "**Judgement call.** This comment describes the old behaviour.\n\n```suggestion\n * Returns every match, not just the first — callers rely on the full\n * list, so narrowing it here would be a silent behaviour change.\n```" }
  ]
}
</output>
```

Use an empty array when there are no inline comments.
