Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

Each inline comment's `line` must be a line that appears in the diff above (a changed or context
line on the new side). Do not comment on lines outside the diff — they will be dropped.

```json
<output>
{
  "summary": "1-3 paragraphs: your overall assessment, what is good, and any concerns. This becomes the PR review body.",
  "inlineComments": [
    { "path": "src/rules/example.ts", "line": 42, "body": "Markdown comment anchored to this line." }
  ]
}
</output>
```

Use an empty array when there are no inline comments.
