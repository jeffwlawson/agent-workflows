Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

## Where each finding goes — `findings`

Every finding names the `path` and `line` in the **source** that it is about. Where it is posted is
not yours to decide and not yours to state: the workflow reads the diff and puts each finding on
the line, on the file, or in the review body, in that order of preference. Nothing is dropped, so
give the truest location you have rather than the nearest one inside the diff.

`title` is one short line, as a reader scans it in a list of what is open — the claim, not the
evidence. Under about twelve words.

Give each finding **no id of any kind**. The workflow writes one and a finding carries it from
round to round; one you invented would be matched against a thread you never opened.

`startLine` is optional and turns the anchor into a range. Include it **only** when the body
carries a ```suggestion block replacing more than one line: `startLine` is the first line
replaced, `line` is the last. A range with any line outside the diff is posted on the file instead,
where a suggestion cannot be applied — so keep a suggestion's range inside the diff.

## Findings an earlier review left open — `verified`

One entry per identifier you were given under **FINDINGS AN EARLIER REVIEW LEFT OPEN**, using the
identifier exactly as it was given. Do not invent one — an identifier that was not handed to you is
dropped.

- `landed` — the current code resolves it. The workflow closes its thread, quoting your `note` as
  the reason it closed.
- `open` — it does not. It counts against this pull request exactly as one of your own findings
  does, so do **not** also restate it in `fixBeforeMerge`: that counts it twice.

`note` is one line, written to whoever raised the finding and whoever has to read the thread after
it closes. An identifier you omit stays open, which is the safe direction and not a way to skip the
list.

## Findings that must be fixed — `fixBeforeMerge`

Every finding is one of two kinds, and this is the first: the change is wrong, unsafe, or does not
do what the linked issue asked, and must not merge as it stands. Label each one
**fix before merge** in the summary and in its `findings` entry, *and* restate it as one line in
`fixBeforeMerge`.

Both, not either. The list is what is **counted** — the outcome posted to the pull request is
derived from how many entries it has — and the two are written independently, so either can be the
one you left something out of. The list is one line each; the evidence stays in the summary and the
finding.

A real problem in code an earlier review of this pull request already read is **previously
missed**: open its body with `**Previously missed.**` rather than `**Fix before merge.**`, and
restate it in `fixBeforeMerge` like any other. It counts the same way. Do not send it to
`followUps` — it is this pull request's to fix, and the record having missed it is the reason to
say so rather than a reason to defer it.

Nothing else is a finding. A style preference, a "consider…", a rename you would accept being
overruled on: leave it out. Anything real but outside this pull request's scope goes to
`followUps` below.

Every finding `body` is under 120 words: the label, then the defect, then its consequence, then the
code you mean. The examples below are the shape, not the subject matter.

## When another pass will not settle it — `needsYou`

One line naming which case it is — the wrong thing was built, the issue itself was wrong, or a
check fails and the diff does not explain why. Omit the field entirely on every other review; it
is not a severity dial, and a review that sets it for a finding another pass would settle spends
the one signal that says a human is needed.

## Out-of-scope findings — `followUps`

A third channel, beside the summary and the findings, for a real problem this pull request does not
own: a defect in a function the diff only calls, a missing test for behaviour it did not change, a
value read twice. These are recorded on the pull request and filed as issues once it merges. The
other two channels do not survive that: nobody reads a merged pull request's review, and a
`fixBeforeMerge` finding is a claim about *this* change, which an out-of-scope one is not.

Every part of the bar is required, and a finding missing any of it belongs in the summary instead:

- **a `location`** — `path` or `path:line`. **One path**, the one a reader should open first. It
  is also read back verbatim once the pull request merges: a filed issue is keyed on this exact
  string together with the finding's place in this list, and that key is how a filing run that
  failed half way recognises what it already filed. Give the line when you have one — it is the
  first thing a reader opens.
- **evidence it is real**, quoting the code or the check result it rests on.
- **why this pull request cannot fix it** — what it would have to change that is not its subject.

Excluded however true: style preferences, "consider adding tests someday", and refactors you cannot
name a defect for.

**This list is a complete restatement, every run.** *Raise only what is new* governs the summary and
the findings; it does **not** govern this list. Only the most recent list is ever read, so a
finding you raised in an earlier round and leave out of this one is lost — and an empty list is how
a round says the earlier ones are no longer true. Re-record anything that still is.

Order them by **the worst consequence if nobody ever fixes it** — not by how hard each is to fix,
and not by how confident you are in it. List the three most serious. Anything past the third is
dropped from the end, here, after you have written it; it is not yours to filter.

```json
<output>
{
  "summary": "Under 250 words. No verdict — one is derived from `fixBeforeMerge`, `needsYou` and the check results, and prepended for you. Each finding worst first, one short paragraph each, quoting the code or check result it rests on.",
  "fixBeforeMerge": [
    "One line per finding that must be fixed before this merges — the same findings the summary and the `findings` list carry."
  ],
  "verified": [
    { "id": "f-1a2b3c4d", "status": "landed", "note": "The guard now runs before `apply()`, and a test covers the malformed input." },
    { "id": "f-5e6f7a8b", "status": "open", "note": "Still returns early on an empty list, so the count is unchanged." }
  ],
  "needsYou": "Omit this field unless another pass cannot settle it; one line naming which of the three cases it is.",
  "findings": [
    { "title": "parse() returns before its guard runs", "path": "src/example.ts", "line": 42, "body": "**Fix before merge.** `parse()` returns before the guard below it runs, so a malformed input reaches `apply()` unchecked." },
    { "title": "a comment describes the old behaviour", "path": "src/helpers.ts", "startLine": 87, "line": 88, "body": "**Fix before merge.** This comment describes the old behaviour.\n\n```suggestion\n * Returns every match, not just the first — callers rely on the full\n * list, so narrowing it here would be a silent behaviour change.\n```" }
  ],
  "followUps": [
    { "title": "One line, as a human scans it in a triage list", "location": "src/other.ts:88", "body": "The evidence it is real, quoting what it rests on. Then why this pull request cannot fix it." }
  ]
}
</output>
```

Use an empty array for any of the four lists with no entries — `verified` is empty when you were
given no open findings to rule on — and leave `needsYou` out entirely unless it applies.
