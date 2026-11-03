# Audit: the three extraction prompts against `writing-for-agents`

Read-only. All citations are `path:line` at `origin/main` = `c53531d`.
Files: `review/extraction.md` (312 lines, "ext-R"), `fix/extraction.md` (77, "ext-F"),
`update-branch/extraction.md` (21, "ext-U"). Main prompts are cited only to locate a meaning
stated in both halves ("prompt-R" = `review/prompt.md`, "prompt-F", "prompt-U").

## What I found about how these files run (it changes the analysis)

- The extraction pass is a **resumed session**, not a fresh one: `shared/agent.ts:428-452`
  (`runWithExtraction`, `resumeSession: sessionId`). The main prompt is in the same window as the
  extraction file. A meaning stated in both halves is therefore *duplication inside one context
  window*, not a hand-off. The counter-argument (recency: the main prompt is far back after a long
  tool-using session, the extraction file is the last thing read before the JSON is written) is real;
  it is why most duplication findings below are **behaviour-affecting / needs a run** rather than
  safe prunes.
- sandcastle's parser takes the **last** `<output>` block and ignores everything outside it
  (`node_modules/@ai-hero/sandcastle/dist/index.js` `findLastTagContent` ~858-876), requires the tag
  to appear in the prompt text (~1045-1050), and its own retry message already says "Do not change
  files or run commands" (~900).
- The parsers are lenient and enforce much of what the prose threatens: a finding has no `id` field
  (`shared/review-findings.ts` `parseFinding`, ~757-806) and `withoutFindingMarkers` scrubs markers;
  ids not handed out are dropped (`filterOutcomes` in `shared/fix-output.ts`, review rulings in
  `shared/review-output.ts` ~2056-2113); `howChecked`/`summary`/`title` are truncated; follow-ups are
  capped (`capFollowUps`, `review-output.ts:~2420-2440`); top-level comments are capped at 2
  (`fix-output.ts:413`). Not enforced in code: the 120-word finding body, the 100-word reply, the
  12-word title.

---

# HIGH

## H1. Every field's meaning is stated in both halves of the review run (single source of truth)

**(a) Where.** `review/extraction.md` against `review/prompt.md`, for 12 of its 14 sections. Roughly
200 of ext-R's 312 lines restate prompt-R:

| Meaning | ext-R | prompt-R |
|---|---|---|
| anchoring, worked example `src/api.ts:42` | 5-20 | 553-588 (same example, same quote) |
| severity definitions, "decides one thing", "rate honestly" | 25-33 | 402-425 |
| "give no id" | 35-36 | 586-588 |
| `startLine`/suggestion range | 38-41 | 590-612 |
| `verified`: landed/open/declined, "open is the whole of reporting it", latest reply | 43-67 | 125-172 |
| two kinds / fix before merge / previously missed / "Nothing else is a finding" | 69-94 | 368-400, 103-117 |
| assessment (same example sentence, verbatim), howChecked, title, summary, em dash | 96-123, 141-142 | 427-534 |
| Merge Danger | 125-132 | 509-525 |
| `needsYou` and its three cases | 144-149 | 536-551 |
| `noteRulings` | 185-198 | 187-208 |
| `criteria` | 217-231 | 19-46 |
| `sinceBrief` | 233-238 | 58-73 |
| `notChecked` (skips per suite, unconditional skip is a finding, "changes no verdict") | 240-249 | 303-311 |
| `testSketches` (at most three, only red tests) | 134-139 | 502-507 |

**(b) Lever.** Pruning: single source of truth / duplication (inflates prominence past real rank);
co-location (the meaning of one field is fragmented across two files).

**(c) Why it matters.** Drift is already visible: prompt-R defines the third `needsYou` case as "you
cannot say why: the diff does not explain it" (546), ext-R as "the diff does not explain why" (146);
prompt-R says "Nothing else is posted" (387), ext-R "Nothing else is a finding" (89); both say the label
"decides nothing" but it decides the *Previously missed* group (`review-findings.ts:~408`). Every
duplicated clause is a place a one-sided edit silently changes behaviour. Also, 12 sections of
rules with equal weight in the last prompt before the JSON dilutes the few that are only stated
there (see H2, H3).

**(d) Proposal.** One ownership rule: the main prompt owns *what to decide and how hard to look*
(work-phase legwork); the extraction owns *shape, required keys, presence rule, and the limits the
code enforces*. Concretely, ext-R becomes (each bullet is one of the 12 sections; text to write):

- Anchoring (5-20):
  > Every finding names the `path` and `line` it is anchored at, a line this pull request changed,
  > as *Where a finding is posted* says. A problem in an untouched file is anchored at the change that
  > causes it, with the untouched `path:line` in the body: on `src/api.ts:42`, *"This changes the
  > signature of `parse()`, but `docs/api.md:18` still describes the old one."* A problem no change
  > causes is a `followUps` entry; a finding anchored in no changed file is moved to `followUps` and
  > stops counting toward the verdict. `title` is one short line, the claim not the evidence, under
  > about twelve words.
- Severity (25-33):
  > `severity` is `high`, `medium` or `low` on every finding and every `followUps` entry, as *HOW BAD
  > EACH ONE IS* defines them. Rate honestly: an inflated rating holds up an approval and buys a fix
  > round; an understated one sends a real problem to a follow-up.
- No id (35-36): delete (see M4).
- `startLine` (38-41):
  > `startLine` is optional: the first line of a multi-line ` ```suggestion ` block's range, with `line`
  > the last. Keep the range inside the diff.
- `verified` (43-67):
  > One entry per identifier under **FINDINGS AN EARLIER REVIEW LEFT OPEN**, exactly as given, ruled
  > `landed`, `open` or `declined` as that section says, with a one-line `note` for whoever raised the
  > finding and whoever reads the thread after it closes. A finding ruled `open` is reported by that
  > ruling alone: do not write it up again in `findings`. `declined` reports a maintainer's latest reply
  > on the thread refusing it; it is never your decision.
- Must-be-fixed (69-94), prose fields (96-123), Merge Danger (125-132), `needsYou` (144-149),
  `noteRulings`, `criteria`, `sinceBrief`, `notChecked`: same treatment, each reduced to "field name,
  keys, when present, pointer to the prompt section that defines the judgement". For fields whose
  data the runner renders (`{{OPEN_FINDINGS}}`, `{{FIX_NOTES}}`, `{{ACCEPTANCE_CRITERIA}}`,
  `{{SINCE_BRIEF}}`, `{{CARRIED_FOLLOW_UPS}}`) the instruction already sits beside the data in the
  main prompt (co-location); the extraction needs only the JSON shape.

**(e) Risk (tests that pin it; they must move in the same commit).**
`tests/review-output.test.ts`, `describe("the review's finding vocabulary")` runs 14 `it.each(halves)`
checks that require the *same phrase in both files*: 3117 ("fix before merge"), 3121 (no "judgement
call"/"blocking" in either, case-insensitive), 3130, 3147/3152/3156 (severity, "a real but small
defect", `decides one thing, through the repository's fix threshold`, `recorded as a minor finding`,
`rate honestly`, the two inflated/understated regexes), 3180 (any line containing "fix before merge"
must not contain "in the summary"), 3195 (field names; no `whatChanged`), 3210 (regex `not (also )?
(write it up again|restate it)[^.]{0,160}\`findings\``), 3224 (`anchored at (**)?the change that causes
it`), 3229 (`src/api.ts:42`, `docs/api.md:18`), 3238 (`/moved to \`?followUps\`?/`), 3249 (no "in the
review body"), 3259 (`/latest reply/`), 3263 (ext contains `needsYou`). Also `3336-3360`
(ext heading `## Follow-ups earlier rounds recorded: \`followUpRulings\`` verbatim, `"followUpRulings": [`,
`/\`resolved\`: .*Carries a \`reason\`/`), `3366-3400` (`asks for every field`: door, doorNote,
blastRadius, blastRadiusNote, breaking in both), `4081-4108` (ext heading
`## What the review's own test run left unrun: \`notChecked\``, `"notChecked": {"ranTests": true`, and
`/\`notChecked\` out only where the review does not say whether it ran tests/` on ext),
`tests/review/acceptance-criteria.test.ts` (the `halves` checks at ~466-470 and ~505-512:
`criteria`+`met`/`changed`/`unmet`, `sinceBrief` in both). The cleanest edit is to narrow each
`halves` test to the half that keeps the text (PROMPT) and keep only the field-name/heading checks on
ext. If you keep the lines above verbatim in ext (they are my proposals), the 3117-3259 set passes
unchanged.

**(f) Class.** Behaviour-affecting (needs the golden-PR evals): reduces text at the point where the
JSON is written, so it can regress ruling completeness; see the recency counter-argument above.
Two readers could disagree whether dropping the ext copy is a no-op: **needs a run**.

**(g) Priority.** High (largest single source of load and drift).

---

## H2. The `followUps` list is described wrongly for PRD pull requests and contradicts itself

**(a)** `review/extraction.md:174-183`: "**This list is a complete restatement, every run.** ... a
finding you raised in an earlier round and leave out of this one is lost ... Re-record anything that
still is." and "List the three most serious. Anything past the third is dropped from the end ... it is
not yours to filter."

**(b)** Pruning: relevance (stale: describes one pull-request kind as all); completion-criterion
clarity ("list the three" vs "not yours to filter" are opposite instructions).

**(c)** Why it matters. (1) The runner tells the agent the opposite where entries are carried:
`review/review.ts:922-945` (`renderCarriedFollowUps`): "These are carried forward by the workflow ...
Do not record any of them again in `followUps`: record only what is new in this round"; and
`review.ts:470-471` says only a *regular* pull request's review "restates its list every round". So on
a PRD pull request (and for minor findings) "complete restatement every run" misleads, producing
re-recorded duplicates. (2) The budget is not three: `recordFollowUps` caps `[carried-and-open rest,
then the model's list]` at `cap` (`review-output.ts:~2679`), `cap = followUpsCap(landed)` = 3 per
landed slice (`review.ts:481-491`), and promoted notes take places "ahead of your own" (ext-R:193).
(3) "List the three most serious" asks the agent to filter; "it is not yours to filter" says it
should not. Two readings, two behaviours: agent lists 3 (and loses a 4th real one) or lists all in order.

**(d) Rewrite** (replace 174-183):
> **Where the brief carries no follow-ups forward, this list is a complete restatement every run.**
> *Raise only what is new* governs `findings`, not this list: only the most recent list is read, so a
> follow-up you recorded earlier and leave out now is lost, and an empty list says the earlier ones no
> longer hold. Re-record what still does. Entries the brief says the workflow carries forward are
> ruled in `followUpRulings`, not recorded again.
>
> Order them by the worst consequence if nobody ever fixes it, not by how hard each is to fix and not
> by your confidence, the most serious first. The workflow keeps the first entries up to the cap
> (promoted notes first) and drops the rest from the end; nothing re-ranks by `severity`.

Better still, state the figure from the environment: `extractionPrompt` is a string
(`review.ts:557`), so the runner can append "The cap on this pull request is N." (it already holds
`cap`). That removes the hardcoded "three" from ext-R:193 and 181-182.

**(e) Risk.** No test pins "complete restatement", "three most serious" or "not yours to filter"
(grepped `tests/`). The *code comment* at `review-output.ts:~2420-2430` says the extraction prompt
"states the ordering axis and that anything past the third is dropped from the end, so the order is a
contract": keep both facts (order axis; drop from the end), change "third" to "cap", and update that
comment in the same commit.

**(f) Class.** Behaviour-affecting (changes which entries the agent writes on a PRD pull request).
Low eval cost (it removes a contradiction); still run the golden PR for a PRD case.

**(g) Priority.** High.

---

## H3. The follow-up bar is stated only after the work is over, where it cannot drive the evidence

**(a)** `review/extraction.md:158-172`: "Every part of the bar is required ... **a `location`** ...
**evidence it is real, quoting the code or the check result** ... **why this pull request cannot fix
it**". The main prompt points at it: `review/prompt.md:118-120` ("on the bar stated with that list"),
378-380, 575-576 ("on the bar stated with that list").

**(b)** Steps and completion criteria: *demand drives legwork* only if seen before the work; and
progressive disclosure/dangling context pointer (the pointer names material the agent has not been
given yet, so during the work the wording that should trigger it triggers nothing).

**(c)** Why it matters. The three requirements are checkable and exhaustive (good), but they arrive
after the review is complete, with "Do not run commands" (ext-R:3) in force. A follow-up the agent
noticed mid-review has never been held to "quote the code it rests on" while it could still go and
get the quote; at extraction time it can only recall from context, or omit ("a finding missing any of
it is left out"), or fabricate a quote. The part that *should* be hidden until the end (order, cap,
JSON shape) is mixed with the part that should be seen early (the bar). A follow-up becomes a filed
issue, so weak evidence has a durable cost.

**(d) Proposal.** Move the bar (the three bullets and "Excluded however true") into the main prompt at
the place that defines the second kind of finding (`prompt-R:378-380`):
> **A follow-up**: real, but not this pull request's to fix, and only if you can give all three: a
> `location` (`path` or `path:line`; one path, the one to open first), evidence it is real, quoting the
> code or the check result it rests on, and why this pull request cannot fix it (what it would have
> to change that is not its subject). Excluded however true: style preferences, "consider adding
> tests someday", refactors you cannot name a defect for.

Leave in ext-R only the shape, the severity, the order/cap (H2) and the key-stability fact in M4.

**(e) Risk.** No test pins "Every part of the bar" or "Excluded however true". The rewrite touches
`review/prompt.md` (another auditor's file): coordinate. `prompt-R:575-576` "the bar stated with that
list" then points at something the reader has actually seen.

**(f) Class.** Behaviour-affecting; needs the golden-PR evals (it changes how many follow-ups are
recorded, and how well evidenced).

**(g) Priority.** High.

---

## H4. `fix/extraction.md` restates ~45 of its 77 lines from `fix/prompt.md`, and has drifted

**(a)** ext-F against prompt-F:

| Meaning | ext-F | prompt-F |
|---|---|---|
| addressed/declined; "is anything still outstanding", "whether you fixed it or an earlier commit did" | 9-12, 22-25 | 180-182, 204-205 |
| both leave the thread open / you close nothing | 14-15 | 175-178 |
| reply under 100 words, to the person who commented | 17-18, 26 | 164-168 |
| no em dashes | 19-20 | 169-170 |
| conversation outcomes: one comment, not top-level/outOfScope, "do not report in two places" | 22-33 | 192-217 |
| top-level comments: no summary, no duplicate, default empty, "a channel that fires every time is one nobody reads" (**same sentence verbatim**: ext-F:41-42, prompt-F:234-235), at most two | 35-45 | 219-240 |
| out-of-scope notes: title/body/location, next review rules, default empty, at most two | 47-53 | 242-261 |
| empty array when nothing to report | 28-29, 41, 53, 76-77 (four times) | 233-234 |

**Drift:** ext-F:47-49 defines an out-of-scope note as "a defect in code this change does not touch, or
a follow-up it makes worth doing". prompt-F:244-248 (and 94-99) also names "the larger redesign";
only the second half of the pair is nearer to the JSON when it is written, so redesign notes are
under-reported.

**(b)** Pruning: single source of truth; co-location; negation clusters ("Do not invent ids", "Neither
outcome closes anything", "Never something out of scope. Not a summary... Not anything a thread reply
already says", "Do not report the same thing in two places").

**(c)** Same as H1: duplicated clauses drift, and the model sees both.

**(d) Proposal** (ext-F after, ~35 lines; keep headings as bullets):
> Report one outcome per review thread you were asked to answer, by `threadId` exactly as given (the
> `` thread `PRRT_...` `` marker): `addressed` (nothing is outstanding in the current HEAD, whether you
> or an earlier commit fixed it) or `declined` (you disagree or are deliberately not acting, and the
> reply says why). Every thread stays open; the next review checks the claim. Each reply is under 100
> words, to the person who commented: what you did, why, the commit if there is one.
>
> `conversationOutcomes`: the same two values for each **conversation comment** with an id, by
> `commentId` exactly as given (the `` comment `IC_...` `` marker). They are posted together as one
> comment, and a declined one carries its reason, the only record such a decline leaves.
>
> `topLevelComments`: only what belongs to no thread (a refusal spanning threads, a cross-cutting
> observation). **Silence is the default**: empty. At most two are posted. Each body is under 120 words.
>
> `outOfScopeNotes`: something real, not this pull request's to fix (a defect in code the change only
> calls or never touches, a follow-up it makes worth doing, or the larger redesign *How to respond to
> feedback* asks you to name). `title` (one line, under about twelve words), `body` (what it is, the
> evidence, why this pull request is not the place), `location` where there is one. **Silence is the
> default**: empty. At most two.
>
> A field with nothing to report is `[]`.

(Note the reuse of the repo's existing leading phrase "Silence is the default", prompt-F:233 and 258,
in place of "Default to an empty array" + the explanation; see M5.)

**(e) Risk.** `tests/fix-output.test.ts:687-690` ("names the field and the id form in the extraction
prompt") needs ext-F to contain `conversationOutcomes`, `commentId`, and `/declined/i` only. Everything
else in `tests/fix-output.test.ts` (the conversation, "reporting on the conversation", "is anything
still outstanding?") reads **prompt-F**, so ext-F can shrink freely. `tests/prompt-ending.test.ts`
pins prompt-F only. Mechanical tests that apply to all three: no em dash in the file
(`tests/workflows.test.ts:~8221`), no `origin/main`/`` `main` `` (~1203), no `npm run verify` (~8181),
the domain regex (~8140).

**(f) Class.** Behaviour-affecting (needs a run), except the lines that repeat the same sentence verbatim
(`a channel that fires every time...`, "Do not report the same thing in two places", the three repeats
of "empty array"), which are safe prunes.

**(g) Priority.** High for the drift item; medium for the rest. Overall: high.

---

# MEDIUM

## M1. The review example anchors on populated optional fields, and instruction text as values

**(a)** `review/extraction.md:251-303`: `"needsYou": "Omit this field unless another pass cannot settle
it; ..."` (272) is a *prose instruction in value position*; `noteRulings`, `followUpRulings`,
`criteria`, `verified`, `sinceBrief`, `notChecked` (with a made-up skipped suite, 295-300) are all
populated, while the text says they are empty "nearly every review" (191), "Empty where you were given
none" (204, 232), "Omit ... on every other review" (147-148). Meanwhile `doorNote` is deliberately kept
*out* of the example (305) for exactly this reason. Values for `assessment`, `howChecked`, `title`,
`summary`, followUps `body` (254-257, 279) are spec sentences: a third copy of the rules in 102-123.

**(b)** Steps vs reference / completion-criterion clarity: the example is the most-read reference and
it cannot tell the agent which fields are required, optional, or normally absent (present vs absent is
indistinguishable). Also duplication (the example's prose values).

**(c)** Why it matters. The example is a template the agent fills; fields present in the template are
filled. `needsYou` spends the one signal "a human is needed" (ext-R:148) if it is copied. Copying
`notChecked.skipped` posts an invented skipped suite in the review body. A `criteria` entry copied when
no criteria were given is dropped by the id check, but `notChecked` and `needsYou` are not gated.
(`sinceBrief` is gated by `sinceBriefListed`, `review-output.ts:~1760`.) The hedge at 94, "The examples
below are the shape, not the subject matter", is the elephant: it exists because the example invites
copying.

**(d) Rewrite.** Make the shown payload the typical review (one finding; lists empty; no `needsYou`,
`sinceBrief`, `noteRulings`; `notChecked.skipped: []`), and move the populated-entry shapes into a
second block labelled "Entry shapes", one line each, outside the payload:
```json
<output>
{
  "assessment": "...", "howChecked": "...", "title": "...", "summary": "...",
  "door": "two-way", "blastRadius": "users", "breaking": [],
  "testSketches": [], "verified": [], "criteria": [],
  "findings": [ { ...one finding... } ], "followUps": [],
  "noteRulings": [], "followUpRulings": [],
  "notChecked": { "ranTests": true, "skipped": [] }
}
</output>
```
Entry shapes (not a payload): `verified` `{id,status,note}`, `noteRulings` `{noteId,status,...}`,
`criteria` `{id,status,reason?,severity?,path?,line?}`, `skipped` `{test,reason}`.
And put the string values into short true-looking literals, deleting the spec sentences. Order the
payload so `assessment` comes after `findings` (it summarises them; today it is serialised first,
254 vs 273) while `verified` stays before `findings` (it must be ruled first, 50-55).

**(e) Risk.** `tests/review-output.test.ts:3349-3352` (ext contains `"followUpRulings": [`),
`~4102-4108` (ext `"notChecked": {\s*"ranTests": true`), `~3377` (`door`, `doorNote`, `blastRadius`,
`blastRadiusNote`, `breaking` in backticks). A rewritten example that shows `"followUpRulings": []`
and `"notChecked": { "ranTests": true, ...` passes; the `noteRulings`/`criteria` entry-shape block must
still contain `` `criteria` `` and `met`/`changed`/`unmet` (acceptance-criteria test).

**(f) Class.** Behaviour-affecting; needs a run (compare how often `needsYou`/`notChecked` appear on
clean PRs before/after).

**(g) Priority.** Medium.

---

## M2. The fix example populates the two channels the text says to leave empty, with a stale, repo-specific claim

**(a)** `fix/extraction.md:66-71` fills `topLevelComments` and `outOfScopeNotes`; text at 41 ("Default to
an empty array. Most runs have nothing"), 53, 76-77. The note example reads "`shared/pr-feedback.ts:206`
builds a shell string from `GH_REPO`. Safe today only because ...".

**(b)** Same as M1 (the example is the template). Plus relevance: `GH_REPO` does not appear in
`shared/pr-feedback.ts` at this commit (line 206 is a doc comment); the example asserts a defect that
does not exist and names this repo's own files in a prompt that ships to adopters.

**(c)** `tests/fix-output.test.ts:78-82` states the failure mode precisely: "a channel that fires on
every run". A populated example is the template for a channel that fires on every run.

**(d)** Show `"topLevelComments": []` and `"outOfScopeNotes": []` in the payload; give one populated
shape of each in prose, with a generic location (prompt-F:239 already uses `src/queue.ts:206`):
> `outOfScopeNotes` entry: `{ "title": "...", "location": "src/queue.ts:206", "body": "..." }`.

**(e)** No test reads the example; `tests/fix-output.test.ts:104-108` uses a similar string only as a
fixture. The de-domaining regex is not hit.

**(f)** Behaviour-affecting (needs a run); deleting the stale `GH_REPO` example is a safe prune on its
own.

**(g)** Medium.

---

## M3. "Findings that must be fixed": negations and a hedge that weakens the label demand

**(a)** `review/extraction.md`: 75-78 ("That place and nowhere else. A finding is never restated in
`summary`, in `title`, in `howChecked` or in `assessment`"), 79-81 ("The label is for whoever reads the
thread and decides nothing: a finding you forget to label still counts, still blocks the merge"),
85-87 ("Do not send it to `followUps`"), 89-91 ("Nothing else is a finding. A style preference, a
'consider...', a rename you would accept being overruled on: leave it out."). The same bar is stated
at 25-29, 171-172, and prompt-R:365-366, 387-389, 412-415.

**(b)** Negation (names the banned behaviour; the positive target exists); duplication; completion
criterion (the demand: "open its body with **fix before merge**" is followed by a sentence saying it
does not matter).

**(c)** The "forget to label" sentence tells the agent the instruction is optional. It is also
inexact: the label decides the *Previously missed* group (`shared/review-findings.ts:~397-408`,
`isPreviouslyMissed`). Listing "style preference / consider / rename" in five places primes the very
category, and a hard "leave it out" with no positive bar invites either over- or under-reporting; the
positive bar is already there (27-28: "a real but small defect, one you can name, with a consequence
you can state"). Also the label is written three ways: `fix before merge` (73), `**Fix before merge.**`
(70-71 example, 74), `**Previously missed.**` (83).

**(d) Rewrite** (replace 69-91):
> A finding is a defect: the change is wrong, unsafe, or does not do what the linked issue asked, and
> must not merge as it stands. Open its `body` with **Fix before merge.** (or **Previously missed.**
> for a real problem in code an earlier review of this pull request already read; it stays in
> `findings` and counts the same). Each finding appears once, in `findings`; `summary`, `title`,
> `howChecked` and `assessment` describe the change and the pass. A finding is anything you can state
> as a defect with its consequence; real but outside this pull request's scope goes in `followUps`.

(Positive bar: a finding names a defect and a consequence. The "style preference/consider/rename" list
goes; prompt-R keeps one copy at 387-389 if the owners want the example.)

**(e) Risk.** `tests/review-output.test.ts:3117` needs **lower-case** `fix before merge` in both halves
(case-sensitive `toContain`): keep one lower-case occurrence or change the test to a case-insensitive
match. 3121: the word "blocking" must not appear (do not write "still blocking"). 3180: no line that
contains "fix before merge" may contain "in the summary". 3195: `assessment`, `howChecked`, `title`,
`summary` all present, no `whatChanged`.

**(f)** Behaviour-affecting; needs a run (changes how many borderline findings are reported, which
feeds the verdict). The deletion of "forget to label" alone is lower risk but still changes label
compliance.

**(g)** Medium.

---

## M4. Sentences that restate what the code enforces (cache of the environment)

Each line below states a fact the parser, the schema, or the runner already guarantees; delete or
shrink. (b) Pruning: the environment is the source, a document that restates it is a cache.

| Line | Quote | What enforces it | Disposition |
|---|---|---|---|
| ext-R:35-36 (+ prompt-R:586-588) | "Give each finding **no id of any kind** ... one you invented would be matched against a thread you never opened." | `parseFinding` has no id field; `withoutFindingMarkers` scrubs markers (`review-findings.ts:~757`) | delete both; the example shape shows what a finding carries |
| ext-R:32-33 | "An omitted or unrecognised one is shown as `medium` and counted as at the threshold, whatever it is." | `alwaysMeets` (`review-findings.ts:~800`) | delete; "on **every** finding" (25) is the demand |
| ext-R:45-46, 188, 203, 219-220; ext-F:6, 28-29 | "An id you were not given is dropped" (x6) | `filterOutcomes`, review rulings | one sentence in the preamble: "Ids are copied exactly as given; any other is dropped." |
| ext-R:109, 120-121 | "**truncated** past that rather than refused" | `MAX_*_WORDS` | keep "truncated" (it tells the agent to put the important words first), delete "rather than refused" |
| ext-R:19-20 | "Nothing is dropped; what an anchor away from the change costs is the finding's power to stop the merge." | `placeFindings` | duplicates prompt-R:578-580; keep one |
| ext-R:214 | "and so is one listed with no id" | the agent cannot rule on a follow-up with no id | delete clause |
| ext-R:237-238 | "one omitted where there were is shown as no ruling given" | renderer | delete |
| ext-R:246-249, 310 | "the body then says so, and never reads it as no run"; "It changes no verdict." (x2) | renderer | delete the in-section copies (see Risk) |
| ext-R:132 | "The workflow lays the section out, with your `followUps` as its known issues." | renderer | delete |
| ext-R:63-64 | "A thread is a conversation, and the last word in it is their position." | n/a (rhetoric after the rule) | delete; rule at 61 stands |
| ext-R:163-167 | the `location` is "read back verbatim ... keyed on this exact string together with the finding's place in this list ... a filing run that failed half way recognises what it already filed" | `tests/follow-up-plan.test.ts:59`, `shared/follow-up-plan.ts` | the mechanism is exposition; the behaviour is "write the same `location` as the earlier round for a follow-up you re-record" (restated every run, H2). Rewrite: "One path, the first a reader should open. Re-recording an entry, write its `location` as before." |

**(e) Risk.** `tests/review-output.test.ts:~4102` pins the closing-paragraph clause
`notChecked out only where the review does not say whether it ran tests` (keep it; delete the
in-section copies 246-249 instead). Nothing pins the other rows (grepped `tests/` for "no id of any
kind", "rather than refused", "listed with no id", "known issues": no hits).

**(f)** Safe prune (no behaviour change expected) for every row except the `location` rewrite
(behaviour-affecting, needs a run) and the `id` row if you doubt the parser claim (it is a
two-line check).

**(g)** Medium (high count, low individual weight).

---

## M5. Three leading words retire five clusters

(b) Leading words / repeating a token not a sentence.

1. **"once"**: the "do not also write it into X" clause appears five times: ext-R:50-55 (verified
   `open`), 75-78 (findings), 98-100 (prose fields), 193-194 (promoted note), 228-229 (criteria
   `unmet`); prompt-R:42-43, 141-147, 201-202, 429-432. One principle replaces them:
   > **Report each item once.** Ruling an id (`open`, `unmet`, `promoted`) is reporting it, so it is
   > not also a `findings` or `followUps` entry; each finding appears once, in `findings`, and the
   > prose fields describe the change and the pass.
   The repo already says "ruling it `open` is the whole of reporting it" (ext-R:52); make that the
   phrase. (Pinned shape: `tests/review-output.test.ts:3210`'s regex needs
   `not also write it up again ... \`findings\`` kept within 160 chars in each half: keep it in the
   `verified` bullet.)
2. **"exhaustive"/"one entry per"**: the checkable bar already used at 45, 187, 202, 219 ("One entry per
   ... you were given") plus the five omission clauses ("stays open", "filed at `medium`", "is kept",
   "listed as not checked", "safe direction"; ext-R:65-67, 198, 214, 231, 237-238). Say it once:
   > Each ruling list is exhaustive: one entry per id you were given, exactly as given. An id you
   > leave out keeps its default (stays open, filed at `medium`, kept, or listed as not checked); that
   > is never a way to drop it.
3. **"Silence is the default"**, already the token in prompt-F:233 and 258: use it in ext-F in place of
   "Default to an empty array" x3 and the surrounding explanation (see H4).

(c) Fewer tokens, one hook for the agent; and the omission clauses are negations ("omitting one is not
a way to drop it") that the positive statement replaces.

(e) Risk: see M3/H1 for the regexes at `review-output.test.ts:3210` and acceptance-criteria
`halves` tests. No test pins "safe direction" or "Silence is the default".

(f) Behaviour-affecting; needs a run. (g) Medium.

---

## M6. Conditional sections load on every run (disclosure by branch)

(a) Six of ext-R's eight field-lists apply to a minority of runs and say so: `verified` (only after a
review), `noteRulings` ("nearly every review" none, 191), `followUpRulings` ("Empty where you were
given none", 204), `criteria` ("Empty where you were given none", 232), `sinceBrief` ("Omit it where no
commits were listed", 237), `testSketches` (139), and the Merge Danger/`summary` block ("omit both"
when nothing was pushed, 123-124, 311-312). That is lines 43-67, 125-139, 185-238: about 110 lines
loaded for all runs, plus the 8-line "empty/omit" matrix at 305-312 that exists only because every
branch is inlined.

(b) Information hierarchy / progressive disclosure ("inline what every branch needs; push behind a
pointer what only some branches reach"); sprawl.

(c) The runner already knows which branch applies: `review.ts:543-546` picks `SUMMARY_RULE`,
`renderCarriedFollowUps` yields "(None yet.)", `{{FIX_NOTES}}`, `{{OPEN_FINDINGS}}`,
`{{ACCEPTANCE_CRITERIA}}`, `{{SINCE_BRIEF}}` are empty or not.

(d) Cheap version (no code): after H1, each conditional section is 2-4 lines, which makes the matrix
moot. Structural version: `review.ts:557` assembles `extractionPrompt` from fragments (always: base,
findings, prose, followUps, notChecked; conditional: verified, noteRulings, followUpRulings, criteria,
sinceBrief, testSketches, merge-danger), so an absent branch's field is simply not mentioned and the
example carries only fields that apply (which also fixes M1). Cost: a composed-prompt test replaces
the file-level pins; the file stops being readable whole.

(e) Risk: headings are pinned by `review-output.test.ts:3349`, `~4102`; the carried/notChecked
sections are the two the structural version touches.

(f) Behaviour-affecting; structural version also needs code. (g) Medium (do H1 first, then decide).

---

## M7. `update-branch/extraction.md`: "non-trivial" is a fuzzy completion criterion that cuts against the main prompt

(a) `update-branch/extraction.md:5-6`: "State each non-trivial resolution and why you chose it."
Main prompt `update-branch/prompt.md:44-46`: "Watch for conflicts that are textually trivial but
semantically real ... Taking 'both' compiles and is still wrong."

(b) Completion-criterion clarity (a vague bound invites premature completion). Co-location: what the
comment must contain is scattered over prompt-U:38 ("say in your comment what you traded away"), 41-42
("flag the uncertainty prominently"), 58-59 and 61-64 ("first line"), and ext-U:5-8.

(c) The agent decides which resolutions are "non-trivial"; the class the prompt warns about is precisely
the trivial-looking one. The conflicted-file list is in the context (`CONFLICTED FILES`), so an
exhaustive, checkable bar is available. Result today: comments that mention only the interesting
conflicts, which is what "whoever has to trust this merge" cannot check.

(d) Rewrite (replace 5-8, keep the em-dash line):
> `comment` is posted publicly on the PR, so write it for whoever has to trust this merge. If the
> verify command does not pass, the **first line** says so, and whether the failure is yours or the
> environment's. Then one bullet for every file in **CONFLICTED FILES**: what was kept from each
> side and why; where the sides were incompatible, what was traded away; where unsure, say so.

(e) Risk. `tests/verify-failure.test.ts:41-44, 46-53` read **prompt-U** only (the "first line"
sentences stay there). Nothing greps ext-U for "non-trivial". Mechanical: no `main`, no `npm run
verify`, no em dash, no domain term, `tests/workflows.test.ts:~1196-1203, ~8181`.

(f) Behaviour-affecting; needs a run (comment length rises: check it does not breach the posted limit).
(g) Medium.

---

## M8. `fix/extraction.md:5-7`: an exhaustive bar with an escape hatch, contradicting the main prompt's exception

(a) "Report one outcome per review thread you were shown ... **Omit threads you did not consider.**"
against prompt-F:187-190 ("A thread whose comments end with a note that it is only waiting to be
closed is shown to you for its evidence ... Report no outcome on that one").

(b) Completion criteria: demand and clarity ("one per thread shown" is exhaustive and wrong for the
evidence-only thread; "omit threads you did not consider" is a way out of the exhaustive bar that
prompt-F:54 ("For each piece of feedback, decide honestly") does not offer).

(c) The agent either answers a thread it was told not to (dropped by `filterOutcomes`, wasted tokens) or
silently leaves one out because it "did not consider" it, which is the invisibility `fix-output.ts`
works to avoid.

(d) Rewrite: "Report one outcome per review thread you were asked to answer, by `threadId` exactly as
given. A thread shown only for its evidence (the one waiting to be closed) gets none." Drop "Omit
threads you did not consider": prompt-F:184-185 already says a thread you never decided about gets no
reply, and the decision is the work.

(e) Risk: none pinned. (f) Behaviour-affecting; low eval cost. (g) Medium.

---

## M9. Dangling references and a heading that no longer describes its section (review)

(a) `review/extraction.md:153` "A **third** channel, beside the findings" (no first or second channel
is named anywhere in the file); 155 "The other channel does not survive that"; 71 "Every finding is
one of two kinds, and this is the first" (the second kind is never labelled "second"; 89-91 and 151
are the other half); 96 heading "The prose fields: `assessment`, `howChecked`, `title`, `summary`"
holds `door`, `doorNote`, `blastRadius`, `blastRadiusNote`, `breaking` (125-132) and `testSketches`
(134-139); `title` means the finding's `title` at 22 and the PR's `title` at 112.

(b) Co-location (one concept under one heading) and relevance (sediment: wording from the days when
the summary was a channel; the code docs still say "third output channel, beside the summary and the
findings", `review-output.ts:29`).

(c) A reader (or the model) infers a missing channel, and has to look for the second kind of finding. A
field described under another field's heading is found by hunting through the JSON; and the order of
sections (findings, verified, must-fix, prose, needsYou, followUps, ...) differs from the order of the
JSON (assessment ... verified, needsYou, findings, ...).

(d) Rewrite: 153-156 -> "`followUps` hold what a finding cannot: a finding is a claim about *this*
change, and nobody reads a merged pull request's review, so a real problem this pull request does not
own is recorded here and filed as an issue once it merges." 71 -> "A finding is..." (see M3). Give
`door`/`blastRadius`/`breaking` and `testSketches` their own `##` headings with the field name in
backticks, as the other eight have, and put the sections in JSON order. Disambiguate the
heading: "The pull request's prose fields: ...".

(e) Risk: the headings at 5 (`## Where each finding goes: \`findings\``), 151, 185, 200 (verbatim at
`review-output.test.ts:3349`), 217, 233, 240 (verbatim at `~4102`) are read by tests: do not rename
those two; renaming others is free.

(f) Safe prune (wording only) for 153-156 and 71; the heading move is also behaviour-neutral in
intent but reorders what the model reads: mark **needs a run** if combined with H1.
(g) Medium.

---

# LOW

## L1. The three-line preamble (all three files): negations, and facts sandcastle already enforces

(a) Lines 1-3 of each file: "Emit a single `<output>` block as the last thing in your response. / Do
not change files. Do not run commands. Do not include any text outside the `<output>` block."

(b) Negation; pruning (environment): the parser reads the *last* `<output>` block and ignores outside
text, and requires the tag in the prompt (`sandcastle/dist/index.js:~858-876, ~1045-1050`); the retry
message repeats "Do not change files or run commands" (~900). Also the same three lines x3 =
duplication a runner could own.

(c) "Do not include any text outside" and "single ... last" are not what makes parsing work. They do
cost: three prohibitions in the first lines, naming the behaviours they ban. The one real guardrail is
"do not change files / run commands": the resumed session still has tools and the work is done.

(d) Rewrite (all three files):
> The work is done. Reply with the one `<output>` block below, filled in, and nothing else; the
> session's files and commands are closed.

Or have `runWithExtraction` prepend the shared preamble (single source), and each file start at its
own content. The positive target is stated, the guardrail is kept, "single/last/outside" go.

(e) Risk: `tests/` has no hit for "Emit a single", "last thing in your response" or "Do not change
files". Keep `<output>` somewhere in each file (sandcastle throws otherwise; the example already has it).

(f) Behaviour-affecting but tiny; **needs a run** (two readers disagree whether the model would emit
prose outside the block without the sentence; it would still parse). (g) Low.

## L2. `update-branch/extraction.md:10-13`: exposition for the maintainer, weak intensifiers, a priming warning

(a) "Name the branch that was **actually** merged (this PR's base, which is frequently not the
repository's default branch) and name the verify command you **actually** ran, the one `CLAUDE.md`
gives. This file is not templated (the extraction run gets no prompt arguments), so both the branch
and the command below are stand-ins, never the answer."

(b) Pruning: relevance (the "not templated" sentence is explanation of the file's construction, not an
instruction to the agent; it is already recorded for maintainers at `tests/workflows.test.ts:~1196-1203`
and `docs/ADOPTING.md:1917`); weak leading words ("actually" x2 is a no-op beside "name"); negation/
priming ("not the repository's default branch" says the default branch aloud, in a file the tests keep
free of it); the branch and the command are already in the resumed context (`TASK`, `{{BASE_REF}}`).

(c) The guard worth keeping is "the example values are placeholders"; the rest costs tokens.

(d) Rewrite:
> Name the base branch this PR was merged with (the one in the task) and the verify command
> `CLAUDE.md` names. `release/2.x` and `./check` below are placeholders, not the answer.

(e) Risk: `tests/workflows.test.ts:~1203` (`do not hardcode main`: no `origin/main`, `` `main` ``,
`main..` in the file), `~8181` (no `npm run verify`). Both satisfied.

(f) Safe prune for deleting the "not templated" clause and the "actually"s; the "default branch"
removal is behaviour-affecting (tiny; **needs a run**). (g) Low.

## L3. `update-branch/extraction.md`: the single example shows the success path; "verify command" is used before it is defined

(a) 15-21; line 7 uses "the verify command", defined at 10-12.

(b) Completion-criterion clarity: the stake is on the failure case ("A silently broken merge is far
worse than a declared one", prompt-U:63-64, "first line"), but the shown shape is `` `./check` passes
(105 tests). ``; a few-shot sets the shape of the result.

(c) The first line is where a reviewer looks; with only a passing example it is the least likely line
to be the failure.

(d) Add a second, short example for the failing case ("`./check` fails: ... fails on the base too; the
merge is committed anyway"), or replace the single example with a failing one and the success form in
prose. Reorder: define the command (10-12) before use (7).

(e) Risk: none pinned in `tests/` for the comment shape (the posted comment is tested via
`tests/update-branch/conclude.test.ts`, not the prompt). (f) Behaviour-affecting; needs a run.
(g) Low.

## L4. The em-dash sentence in six places

(a) `review/extraction.md:141-142`, `review/prompt.md:445`, `fix/extraction.md:19-20`,
`fix/prompt.md:169-170`, `update-branch/extraction.md:8`, `update-branch/prompt.md:71`; all one rule.
In ext-R it sits between the prose fields and `needsYou`, though it applies to every field.

(b) Duplication across a resumed session; the rule is a deterministic output property.

(c) Six copies of one sentence cost ~150 tokens per run for a rule a posting boundary could enforce
(`withoutFindingMarkers` is the same pattern, `fix-output.ts:~263`). In-session: when the main prompt
says "anything you write", the ext copy adds nothing the model has not read.

(d) Option A (safe-ish): keep only the main-prompt copy, delete the ext copies. Option B: scrub
`—` at the schema boundary and delete all six.

(e) Risk: `tests/workflows.test.ts:~8221` ("prompts carry no em dash") checks the *files* contain no
em dash, not the instruction; nothing pins the sentence (grepped `tests/` for "em dash": only unrelated
hits). (f) Behaviour-affecting; needs a run (compare em dashes in posted output). (g) Low.

## L5. Hedges about the examples

(a) ext-R:94 "The examples below are the shape, not the subject matter."; ext-F:18 "The examples
below are the shape, not a length target."

(b) Negation; and the second is ambiguous: the cap is "under 100 words" and the examples are shorter,
so "not a length target" reads as permission to run longer.

(c) Two readers disagree on whether they are no-ops: they change behaviour only if the model would copy
the example (M1/M2 fix the cause). **Needs a run.**

(d) After M1/M2: delete both; if kept, ext-F:18 -> "Replies are under 100 words."

(e) Risk: nothing pinned (grepped "shape, not": no hits). (f) Behaviour-affecting. (g) Low.

## L6. "A non-maintainer's reply is `open`" asks the agent to judge what it cannot see

(a) `review/extraction.md:58-59` "A reply you cannot read as a refusal is `open`, and so is one from
anybody who is not a maintainer." Versus prompt-R:170-172: "Only a reply the workflow has already gated
can close a thread this way. You will not see an untrusted author's comment at all".

(b) Relevance/duplication; the second clause covers a case the workflow removes before the agent sees it.

(c) The agent may try to infer maintainer status from a login; it has no way to. (d) Delete the
clause ("and so is one from anybody who is not a maintainer"); the sentence before it stands.
(e) `review-output.test.ts:3259` requires `/latest reply/i` only. (f) Safe prune. (g) Low.

---

# What the files do well (keep)

- **Checkable, exhaustive criteria for rulings**: "One entry per identifier you were given ... exactly as
  given" (ext-R:45, 187, 202, 219) is the form the skill calls strongest. Keep it through any rewrite.
- **Headings carry the field name in backticks** (`## ...: \`verified\``), so a heading is a context
  pointer with a leading word; tests pin two of them (`review-output.test.ts:3349`, `~4102`).
- **Facts the agent cannot discover are kept**: the one-path `location`, "complete restatement" (once
  scoped, H2), the ordering axis stated positively ("worst consequence if nobody ever fixes it"), "not a
  severity dial" with its reason (148-149), `declined` as a report of a maintainer's decision, not one's
  own (59-60).
- **The follow-up bar is three checkable parts** (160-168): good in itself; only its position is wrong (H3).
- **Positive targets before prohibitions** in several places: `title` "the claim, not the evidence"
  (22-23); `assessment` "naming what is unresolved: the subjects, not the count" (102-105);
  `topLevelComments` "name the thing, say where it is, say why it matters" (45).
- **Caps stated with their consequence** where the code relies on the statement (the ordering contract,
  `review-output.ts:~2425`, fix's "At most two", 42-43/53).
- **The JSON example is the parser's shape** (one example per output, valid values, incl. a
  `suggestion` fence and the `startLine` range); keep the shape, change what is populated (M1/M2).
- `update-branch/extraction.md` is short, has one example, a reason for its placeholders, and a
  good leading phrase: "write it for whoever has to trust this merge".
- Back-references by section name (`*Findings that must be fixed*`) already behave as context pointers
  between the two halves; H1 leans on them.

---

# Counts

| Class | High | Medium | Low | Total |
|---|---|---|---|---|
| Behaviour-affecting (needs golden-PR evals) | H1, H2, H3, H4 | M1, M2, M3, M5, M6, M7, M8 | L1, L3, L4, L5 | 15 |
| Safe prune | | M4, M9 (wording part) | L2 (clause part), L6 | 4 |
| **Total** | **4** | **9** | **6** | **19** |

(M4, M9 and L2 have a safe-prune part and a small behaviour-affecting part, called out in each; they are
counted by their dominant class.)

Order to land them: H2 (a correctness fix, small), M4/M9/L6 (safe prunes, one commit with their
test edits), then H1+H4+M5 (one eval-measured change), then H3 and M1/M2/M7 (each measured), then the
structural M6.
