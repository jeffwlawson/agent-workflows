Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

Each inline comment's `line` must be a line that appears in the diff above (a changed or context
line on the new side). Do not comment on lines outside the diff — they will be dropped.

`startLine` is optional and turns the anchor into a range. Include it **only** when the body
carries a ```suggestion block replacing more than one line: `startLine` is the first line
replaced, `line` is the last. Every line in that range must also be in the diff, or the comment
is dropped. Omit `startLine` for single-line comments.

```json
<output>
{
  "summary": "1-3 paragraphs: your overall assessment, what is good, and any concerns. This becomes the PR review body.",
  "inlineComments": [
    { "path": "src/rules/example.ts", "line": 42, "body": "Markdown comment anchored to this line." },
    { "path": "src/manifest.ts", "startLine": 87, "line": 88, "body": "This claim is stale.\n\n```suggestion\n * `NestedInstallerType`/`NestedInstallerFiles`. Kept in one place so the\n * rules that branch on it cannot silently disagree.\n```" }
  ]
}
</output>
```

Use an empty array when there are no inline comments.
