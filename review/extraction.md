Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

## Where each finding goes: `findings`

Every finding names the `path` and `line` it is **anchored** at, and that anchor is always
something this pull request changed. Where it is posted is not yours to decide and not yours to
state: the workflow reads the diff and puts each finding on the line or on the file, in that order
of preference.

A problem in a file this pull request does not touch is anchored at **the change that causes it**,
with the untouched `path:line` named in the body. On `src/api.ts:42`: *"This changes the signature
of `parse()`, but `docs/api.md:18` still describes the old one."* A finding about untouched code
that no change causes is not this pull request's to fix: put it in `followUps` instead.

The workflow enforces that rather than trusting it. A finding whose `path` is in no file this pull
request changes is **moved to `followUps`** (filed when the pull request merges, with the body
saying it was moved), so it stops counting toward the verdict. Nothing is dropped; what an anchor
away from the change costs is the finding's power to stop the merge.

`title` is one short line, as a reader scans it in a list of what is open: the claim, not the
evidence. Under about twelve words.

`severity` is `high`, `medium` or `low`, on **every** finding and every `followUps` entry. `high`
breaks something or ships the wrong behaviour; `medium` is a real defect with a bounded blast
radius; `low` is a real but small defect, one you can name, with a consequence you can state,
that happens to be cheap. `low` is not a place to put a preference: those are not posted at any
severity. It is display and ordering only, and changes no outcome; an omitted or unrecognised one
is read as `medium`.

Give each finding **no id of any kind**. The workflow writes one and a finding carries it from
round to round; one you invented would be matched against a thread you never opened.

`startLine` is optional and turns the anchor into a range. Include it **only** when the body
carries a ```suggestion block replacing more than one line: `startLine` is the first line
replaced, `line` is the last. A range with any line outside the diff is posted on the file instead,
where a suggestion cannot be applied, so keep a suggestion's range inside the diff.

## Findings an earlier review left open: `verified`

One entry per identifier you were given under **FINDINGS AN EARLIER REVIEW LEFT OPEN**, using the
identifier exactly as it was given. Do not invent one; an identifier that was not handed to you is
dropped.

- `landed`: the current code resolves it. The workflow closes its thread, quoting your `note` as
  the reason it closed.
- `open`: it does not. It counts against this pull request exactly as one of your own findings
  does, so do **not** write it up again as one of your own `findings`. Ruling it `open` is the
  whole of reporting it. A second write-up mints a second
  identifier on the same problem (nothing matches them, by design), so it is counted twice, gets
  a second thread, and is carried separately every round after.
- `declined`: a maintainer replied on the thread refusing it ("won't fix", "this is intended").
  The workflow closes the thread as *won't fix*, quoting **them** rather than you, and it stops
  counting. This reports their decision; it is never yours to take. A reply you cannot read as a
  refusal is `open`, and so is one from anybody who is not a maintainer.

  It must be the maintainer's **latest** reply on that thread. The workflow quotes that comment
  and no other, so an earlier refusal a later reply revisits ("actually, please do fix this") is
  `open`. A thread is a conversation, and the last word in it is their position.

`note` is one line, written to whoever raised the finding and whoever has to read the thread after
it closes. An identifier you omit stays open, which is the safe direction and not a way to skip the
list.

## Findings that must be fixed

Every finding is one of two kinds, and this is the first: the change is wrong, unsafe, or does not
do what the linked issue asked, and must not merge as it stands. Open its `findings` entry's body
with **fix before merge**.

That place and nowhere else. A finding is never restated in `summary`, in `title`, in
`howChecked` or in `assessment`. Those describe the change and the pass, and the record above them is where a
finding is read and answered.

**Every finding counts**: the outcome posted to the pull request is derived from how many there
are. The label is for whoever reads the thread and decides nothing: a finding you forget to label
still counts, still blocks the merge, and is still listed in the record.

A real problem in code an earlier review of this pull request already read is **previously
missed**: open its body with `**Previously missed.**` rather than `**Fix before merge.**`. It
counts the same way. Do not send it to
`followUps`; it is this pull request's to fix, and the record having missed it is the reason to
say so rather than a reason to defer it.

Nothing else is a finding. A style preference, a "consider…", a rename you would accept being
overruled on: leave it out. Anything real but outside this pull request's scope goes to
`followUps` below.

Every finding `body` is under 120 words: the label, then the defect, then its consequence, then the
code you mean. The examples below are the shape, not the subject matter.

## The prose fields: `assessment`, `howChecked`, `title`, `summary`

They are four different jobs, and **none of them is a place to restate a finding**. Each finding
is already above them in the posted body, with its severity and a link to where it was raised;
saying it again here is the same problem read twice.

- **`assessment`**: one sentence, under about 200 characters, naming **what is unresolved**:
  *"Sequence validation, empty-column rules and undo-safe state handling are each wrong in a way
  that has to be fixed first."*
  The subjects, not the count; the count is on its own line below it. Where nothing is
  unresolved, one sentence on why the change holds up. No verdict: one is derived from
  `findings`, `needsYou` and the check results, and it opens the body for you.
- **`howChecked`**: under 100 words, and **truncated** past that rather than refused. What you
  actually verified: which checks you ran or read, which behaviour you traced, which files you
  read past the diff. It is what tells a reader how much weight this review carries. It is posted
  on every review.
- **`title`**: the pull request's title, one line, true of the change as it now stands, in the
  commit convention `CLAUDE.md` names or conventional-commit style otherwise. The type comes from
  what the diff does, not from the issue's title. Cut at 100 characters.
- **`summary`**: the pull request's summary, in Markdown: zero, one or two sketches drawn from the
  diff, each in a fenced code block beside the text it supports, then what the change does, the
  behaviour it changes, and a line led by **Differs from the issue:** where it departs from the
  linked issue, with the reason. About what was built, not what was asked; it does not retell the
  issue. Breaking changes are not marked in it: they go in `breaking`. The prose is under about 150
  words, and **truncated** past that; words inside a fenced block do not count. Description only,
  never an evaluation. It goes into the pull request's body, not the review.

  Both are written only where something was pushed since the summary was last written, which the
  brief told you. Where it said this review leaves them as they are, omit both.
- **`door`**, **`doorNote`**, **`blastRadius`**, **`blastRadiusNote`**, **`breaking`**: the pull
  request's **Merge Danger**, written beside `summary` and omitted with it. `door` is `"one-way"`
  where a revert cannot undo the change (a published release, deleted data, a migration) and
  `"two-way"` otherwise; when a change takes effect is its blast radius, not its door. `blastRadius`
  is one word for who or what it reaches. The two notes are one line each and optional: `doorNote`
  only for a one-way door or a two-way door with a catch, `blastRadiusNote` saying who is reached
  and from when. `breaking` is a list, one line per change a caller or a user has to act on, empty
  where there is none. The workflow lays the section out, with your `followUps` as its known issues.

- **`testSketches`**: what a test checks, as pseudocode, for the pull request's Evidence, where the
  brief's red check section lists tests as red: `{ "test": "its name exactly as listed", "sketch":
  "a few lines" }`. The setup, the call and what it asserts, not the test's code copied. The workflow
  puts each sketch above that test's assertion message, keeps **at most three**, and drops any naming
  a test the report does not list as red: a sketch describes a failing test, it cannot add one or
  mark one as proven. Leave it out, or empty, where no test is listed as red.

Do not use em dashes in anything you write, in any field; use a comma, colon, semicolon,
parentheses, or a new sentence instead.

## When another pass will not settle it: `needsYou`

One line naming which case it is: the wrong thing was built, the issue itself was wrong, or a
check fails and the diff does not explain why. Omit the field entirely on every other review; it
is not a severity dial, and a review that sets it for a finding another pass would settle spends
the one signal that says a human is needed.

## Out-of-scope findings: `followUps`

A third channel, beside the findings, for a real problem this pull request does not own: a defect in a function the diff only calls, a missing test for behaviour it did not change, a
value read twice. These are recorded on the pull request and filed as issues once it merges. The
other channel does not survive that: nobody reads a merged pull request's review, and a
finding is a claim about *this* change, which an out-of-scope one is not.

Every part of the bar is required, and a finding missing any of it is **left out**: there is no
lesser channel to move it to, and a would-be follow-up you cannot evidence is one you have not
established. Each one carries a `severity` like any other finding; it is written into the issue that is
filed, where it is the first thing whoever triages it reads:

- **a `location`**: `path` or `path:line`. **One path**, the one a reader should open first. It
  is also read back verbatim once the pull request merges: a filed issue is keyed on this exact
  string together with the finding's place in this list, and that key is how a filing run that
  failed half way recognises what it already filed. Give the line when you have one; it is the
  first thing a reader opens.
- **evidence it is real**, quoting the code or the check result it rests on.
- **why this pull request cannot fix it**: what it would have to change that is not its subject.

Excluded however true: style preferences, "consider adding tests someday", and refactors you cannot
name a defect for.

**This list is a complete restatement, every run.** *Raise only what is new* governs the findings;
it does **not** govern this list. Only the most recent list is ever read, so a
finding you raised in an earlier round and leave out of this one is lost, and an empty list is how
a round says the earlier ones are no longer true. Re-record anything that still is.

Order them by **the worst consequence if nobody ever fixes it**, not by how hard each is to fix,
and not by how confident you are in it. List the three most serious. Anything past the third is
dropped from the end, here, after you have written it; it is not yours to filter. The order is
yours and is kept as you wrote it: nothing re-ranks this list by `severity`, so put the one you
would most want filed first.

## The fix run's out-of-scope notes: `noteRulings`

One entry per note you were given under **NOTES THE FIX RUN LEFT**, using the `noteId` exactly as
given (the `` note `IC_...` `` marker). An id you were not given is dropped. Empty where you were
given none, which is nearly every review.

- `promoted`: real, not this pull request's to fix, and worth an issue. Carries a `severity`, and a
  `location` (`path` or `path:line`) where you can name a better one than the note did. The
  workflow files it on merge as a follow-up, ahead of your own and inside the same cap of three.
  Do not also write it into `followUps`.
- `dropped`: not worth filing. Carries a `reason`, one line, which the review body shows beside
  the note's title. A drop with no reason is refused.

A note you omit is filed as a follow-up at `medium`, so omitting one is not a way to drop it.

## The linked issue's acceptance criteria: `criteria`

One entry per criterion you were given under **ACCEPTANCE CRITERIA**, using the `id` exactly as
given (`C1`, `C2`, …). An id you were not given is dropped. Empty where you were given none.

- `met`: the change does what the criterion says.
- `changed`: it does not, on purpose, and something says why. Carries a `reason`, one line, which
  the review body shows beside the criterion. A change with no reason is refused. It is not a
  finding.
- `unmet`: it does not, and nothing says why. Carries a one-line `reason` saying what is missing, a
  `severity`, and the `path` and `line` it is anchored at, by the same rule as a finding's. The
  workflow raises it as a fix-before-merge finding there, so do **not** also write it into
  `findings`.

A criterion you omit is listed as not checked.

```json
<output>
{
  "assessment": "One sentence, under 200 characters, naming what is unresolved: the subjects, not the count.",
  "howChecked": "Under 100 words. What you actually verified: the checks you ran, the behaviour you traced, the files you read.",
  "title": "feat(scope): one line, true of the change as it now stands",
  "summary": "One sentence on what the change does.\n\n```diff\n caller()\n-  oldStep()\n+  newStep()\n```\n\n- A behaviour change it makes.\n\n**Differs from the issue:** where it departs from the linked issue, and why.",
  "door": "two-way",
  "blastRadius": "users",
  "blastRadiusNote": "Who is reached, and from when: on merge, or at the next release.",
  "breaking": [
    "One line per change a caller or a user has to act on, and what they must do."
  ],
  "testSketches": [
    { "test": "test_scales_servings", "sketch": "recipe = Recipe(servings=2, flour=100)\nscaled = recipe.scale(4)\nexpect scaled.flour == 200" }
  ],
  "verified": [
    { "id": "f-1a2b3c4d", "status": "landed", "note": "The guard now runs before `apply()`, and a test covers the malformed input." },
    { "id": "f-5e6f7a8b", "status": "open", "note": "Still returns early on an empty list, so the count is unchanged." },
    { "id": "f-9c0d1e2f", "status": "declined", "note": "The maintainer replied that the duplicate write is intended." }
  ],
  "needsYou": "Omit this field unless another pass cannot settle it; one line naming which of the three cases it is.",
  "findings": [
    { "title": "parse() returns before its guard runs", "path": "src/example.ts", "line": 42, "severity": "high", "body": "**Fix before merge.** `parse()` returns before the guard below it runs, so a malformed input reaches `apply()` unchecked." },
    { "title": "the signature change leaves the docs wrong", "path": "src/api.ts", "line": 42, "severity": "medium", "body": "**Fix before merge.** This changes the signature of `parse()`, but `docs/api.md:18` still describes the old one. Anchored at the change, because that is what makes the other file wrong." },
    { "title": "a comment describes the old behaviour", "path": "src/helpers.ts", "startLine": 87, "line": 88, "severity": "low", "body": "**Fix before merge.** This comment describes the old behaviour.\n\n```suggestion\n * Returns every match, not just the first; callers rely on the full\n * list, so narrowing it here would be a silent behaviour change.\n```" }
  ],
  "followUps": [
    { "title": "One line, as a human scans it in a triage list", "location": "src/other.ts:88", "severity": "medium", "body": "The evidence it is real, quoting what it rests on. Then why this pull request cannot fix it." }
  ],
  "noteRulings": [
    { "noteId": "IC_kwDO...", "status": "promoted", "severity": "medium", "location": "src/client.ts:41" },
    { "noteId": "IC_kwDO...", "status": "dropped", "reason": "Already tracked in the issue this pull request links." }
  ],
  "criteria": [
    { "id": "C1", "status": "met" },
    { "id": "C2", "status": "changed", "reason": "The service answers before the work exists, so the change returns its tracking id instead." },
    { "id": "C3", "status": "unmet", "reason": "The body does not say which tests cover the failure path.", "severity": "low", "path": "src/example.ts", "line": 42 }
  ]
}
</output>
```

`doorNote` is not in the example: it is for a one-way door or a two-way door with a catch. Use an
empty array for any of the eight lists with no entries (`verified` is empty when you were
given no open findings to rule on, `noteRulings` when you were given no notes, and `criteria` when
you were given no criteria). Leave
`needsYou` out entirely unless it applies, and `title`, `summary` and the Merge Danger fields out
where the brief said this review leaves them as they are.
