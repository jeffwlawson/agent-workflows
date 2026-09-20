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

## Out-of-scope findings — `followUps`

A third channel, beside the summary and the inline comments, for a real problem this pull request
does not own: a defect in a function the diff only calls, a missing test for behaviour it did not
change, a value read twice. These are recorded on the pull request and filed as issues once it
merges. The other two channels do not survive that: nobody reads a merged pull request's review,
and an out-of-scope finding is usually off-diff, where an inline comment is dropped before posting.

Every part of the bar is required, and a finding missing any of it belongs in the summary instead:

- **a `location`** — `path` or `path:line`. **One path**, the one a reader should open first.
- **evidence it is real**, quoting the code or the check result it rests on.
- **why this pull request cannot fix it** — what it would have to change that is not its subject.

Excluded however true: style preferences, "consider adding tests someday", and refactors you cannot
name a defect for.

**This list is a complete restatement, every run.** *Raise only what is new* governs the summary and
the inline comments; it does **not** govern this list. Only the most recent list is ever read, so a
finding you raised in an earlier round and leave out of this one is lost.

Order them by **the worst consequence if nobody ever fixes it** — not by how hard each is to fix,
and not by how confident you are in it. List the three most serious. Anything past the third is
dropped from the end, here, after you have written it; it is not yours to filter.

```json
<output>
{
  "summary": "Under 250 words. Open with the verdict — merge, merge with changes, or do not merge — then each finding worst first, one short paragraph each, quoting the code or check result it rests on.",
  "inlineComments": [
    { "path": "src/example.ts", "line": 42, "body": "**Blocking.** `parse()` returns before the guard below it runs, so a malformed input reaches `apply()` unchecked." },
    { "path": "src/helpers.ts", "startLine": 87, "line": 88, "body": "**Judgement call.** This comment describes the old behaviour.\n\n```suggestion\n * Returns every match, not just the first — callers rely on the full\n * list, so narrowing it here would be a silent behaviour change.\n```" }
  ],
  "followUps": [
    { "title": "One line, as a human scans it in a triage list", "location": "src/other.ts:88", "body": "The evidence it is real, quoting what it rests on. Then why this pull request cannot fix it." }
  ]
}
</output>
```

Use an empty array for either list when it has no entries.
