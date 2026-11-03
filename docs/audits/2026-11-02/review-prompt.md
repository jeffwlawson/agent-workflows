# Audit of `review/prompt.md` against `writing-for-agents`

Read at `origin/main` c53531d. Line numbers are `review/prompt.md` unless a path is given. Read-only audit;
nothing in the repo was touched. `extraction.md` is cited only where the same meaning is stated in both.

## How the pieces fit (needed to read the findings)

- `runWithExtraction` (`shared/agent.ts:425-452`) runs `prompt.md` as the work pass, then **resumes the same
  session** with `extraction.md` as a second, static prompt. `promptArgs` are dropped for the extraction
  (`agent.ts:439`), so anything run-variable (`SUMMARY_RULE`, `FINAL_SUMMARY`, `CURRENT_SUMMARY`, the ruling
  lists) can only live in `prompt.md` or in a placeholder. That explains some of the duplication; it does not
  justify all of it.
- Several placeholders already carry their own branch-specific instruction text, so `prompt.md` restates what the
  environment says: `renderRedCheck`/`UNKNOWN` (`shared/red-check.ts:186-187,325-361`), `renderSettledFindings`
  (`shared/review-verification.ts:253-268`), `notePreamble` (`shared/pr-feedback.ts:653`),
  `renderCarriedFollowUps` (`review/review.ts:922-960`), `SKIPPED` (`review/since-brief.ts:136`),
  `NO_CRITERIA` (`review/acceptance-criteria.ts:166`).
- Size: `prompt.md` is 627 lines, 6,842 words; `extraction.md` 312 lines, 3,538 words. About 30 occurrences of
  "do not / never / don't" in `prompt.md`.
- **Tests enforce a lot of the duplication.** `tests/review-output.test.ts` (`describe("the review's finding
  vocabulary")`, ~L3101-3270) runs 14 `it.each(halves)` pins that require the *same* meaning in both `prompt.md`
  and `extraction.md`. Its own comment (`fix-output.test.ts:380-383`) says why: "both halves read as redundant ...
  to anyone tightening this brief". So any single-sourcing below must move a test in the same commit, and
  two words are banned in both files: `blocking` and `judgement call`, and the phrase `in the review body`.
- **What the evals can measure.** `evals/review/suite.yaml` replays a *first review of an ordinary PR*: no open
  findings, nothing settled, no notes, no carried follow-ups, red check not configured, no since-brief commits,
  summary written. So the four cases measure items 1-8, the findings contract, and the summary rules, and can
  measure *removing* the empty-branch text. They **cannot** measure the verification pass, `verified`/`declined`,
  `noteRulings`, carried follow-ups, a red check that ran, or PRD rounds. Changes to those need a new case or are
  unmeasured; I mark that per finding.

## Done well (do not break)

- **Leading words that work and are shared with the repo's docs**: *oracle* (also `docs/ADOPTING.md` section 7),
  *red / broken / passed*, *fail closed*, *scope creep*, *previously missed*, *sketch*, *one-way door*. Item 5's
  "used to block, fail or be reported loudly" is a crisp, checkable class definition.
- **Exhaustive, checkable completion criteria where they exist**: item 6 ("done only when every hit has been
  ruled on"), item 5 ("List every input that can reach the quiet path", "in one round, grouped as one class"),
  "Rule on every one of them, by id". These are the strongest sentences in the file.
- **Basis for every finding** (L396-400): five named kinds of basis, and "can name none ... is a preference". A
  checkable gate on posting; keep it as the single definition of what is not posted.
- **The reason behind a choice, where no config confesses it**: item 4's "a sample written by hand agrees with
  whatever its author believed the format to be" (L296-298); the settled-finding rationale (L182-185); "a
  wrong suggestion is one click from being committed" (L611-612). These are cache worth its load.
- **Positive framing already used**: "Fix before merge ... anchored at the change that causes it" with a worked
  example; the emdash rule gives its replacements; `#N` rule is one line.
- **Branch text selected by the runner** where it already is: `SUMMARY_RULE`, `FINAL_SUMMARY`,
  `CARRIED_FOLLOW_UPS`, `NOT_CARRIED`. This is the right pattern and findings H5/M-series extend it.
- `CLAUDE.md`/`CONTEXT.md` handling (L277-279): a pointer with a fallback, and tests pin it across all runners.

---

# HIGH priority

## H1. The steps are scattered and the whole task has no checkable completion criterion

- **(a)** L627 `When your review is complete, output <promise>COMPLETE</promise>.` The rulings the agent owes are
  demanded at L27, L66, L133, L195, L250 and (runner text) in `CARRIED_FOLLOW_UPS`, each inside a data section
  between L19 and L212. The ordered work (`WHAT TO CHECK`, L275) comes 260 lines after the first of them and
  after the diff.
- **(b)** Information hierarchy (steps vs reference; the primary tier is the in-file step, and it is buried in
  reference and interleaved with data sections); completion criteria (clarity, demand); premature completion.
- **(c)** "Complete" is undefined. The agent reaches L627 having read about 20 required fields' worth of
  post-completion work (summary, Merge Danger, rulings), the exact setup the skill describes: visible later
  steps, fuzzy bound. The "Rule on every one" demands are far from where the agent is when it finishes the diff, so
  attending to them is the coin-flip the skill describes. Nothing says that, at the end, each id handed over
  needs a ruling you can name.
- **(d)** Add one short section right after `# TASK` (about 8 lines) and replace L627 with a sharp criterion:

  ```
  # HOW THIS REVIEW RUNS

  1. Read `CONTEXT.md`, then the changed files in context (WHAT TO CHECK).
  2. Rule on every id this brief hands you: each criterion (`criteria`), open finding (`verified`),
     fix-run note (`noteRulings`), carried follow-up (`followUpRulings`), and the commits since the
     brief (`sinceBrief`). A ruling is the whole of reporting its subject, never also a finding.
  3. Work the eight items under WHAT TO CHECK over the diff; each finding is one of THE TWO KINDS.
  4. The review is complete when every id has a ruling, every item is worked, and every hit of items
     5 to 7 is ruled on. Then output `<promise>COMPLETE</promise>`.
  ```
  Then each data section keeps only its own definitions (met/changed/unmet, landed/open/declined, promote/drop)
  and loses its "Rule on every one of them" restatement and its "do not also write it" copy (see M2).
- **(e) Risk.** Tests pin: `review-output.test.ts` item4/item6/item7 regexes slice `plain(PROMPT)` between
  `4. Tests` ... ` 5. ` and ` 6. Text this change made false` ... ` 7. `, so inserting a numbered list
  starting `1. Read ...` ahead of the real item list could be matched by `/ 1\. Correctness against the issue.*?(?= 2\. )/s`
  only if its text differs: use a different marker than `N.` (for example "First ... Second ...") or the
  `item1`/`item4` slices will begin at the wrong place. `describe("the review brief asks for the class")` item
  `4. Tests` slicing is the same hazard. `tests/prompt-ending.test.ts` does not pin review's ending.
  Existing sentence `do not write it up again as one of your own \`findings\`` (L144) must survive in both
  halves (`forbids writing an open carried finding up again`).
- **(f)** behaviour-affecting: needs the golden-PR evals. The four cases cover only the empty-ledger state, so
  the "every id has a ruling" half is unmeasured unless a case with open findings and criteria is added
  (`persisted-checkout-token` and `restart-order` carry criteria; check whether they carry open findings).
- **(g)** high.

## H2. Escape clauses sit beside the demand to rule on everything

- **(a)** L149-151 `One you say nothing about **stays open**. That is deliberate, and it is the safe direction
  rather than an invitation to leave the list half-done`; L159-163 `Open is the safe direction here as
  everywhere else`; L207-208 `A note you say nothing about is recorded as a follow-up at medium. That is the
  safe direction`; runner text at `review/review.ts:953` `A follow-up you say nothing about is kept. That
  is the safe direction`. (L45-46 "A criterion you say nothing about is listed as not checked ... so rule on all
  of them" is fine: it ends on the demand.)
- **(b)** Completion criteria (an escape clause beside visible later steps); negation ("rather than an
  invitation to leave the list half-done" names the thing it forbids); environment as source (the fail-safe is
  workflow code, `tests/review-verification.test.ts:194-203`: "A review that ran out of attention ... must not
  thereby close it").
- **(c)** The sentences tell a model that is running low on attention that skipping an id is safe, deliberate,
  and costs nothing. That is the workflow's guarantee, not an instruction; it works whether or not the agent
  reads it. Stated to the agent it lowers the demand exactly where the prompt's own length makes skipping
  likeliest (the rulings are the first thing a long review drops).
- **(d)** Delete L149-151 and L207-208 and the runner's "That is the safe direction" sentence. Give the agent the
  positive uncertainty rule instead, in the `verified` paragraph at L133-136: "`open` is the ruling for a finding
  the current code does not clearly resolve." Keep the existing positive tail of the runner text ("Rule one
  resolved only where the code shows it fixed, not where it merely seems less important"). The *consequence*
  of omission stays in `extraction.md` (L66-67, L198, L214), where fields are emitted and which already says it
  better ("omitting one is not a way to drop it").
- **(e) Risk.** No test pins L149-151 or L207-208 in `prompt.md` (grep for `safe direction` hits only
  `tests/fix-notes.test.ts:245`, `review-verification.test.ts:194`, comments about code behaviour). The runner
  text is pinned by `tests/review-output.test.ts` `describe("the review brief's carried follow-ups")`
  (`/A follow-up you say nothing about is kept/`, ~L3280-3330): that test would have to move with it.
- **(f)** behaviour-affecting (changes how thorough the agent is on rulings). Evals do not cover the carried
  branches; call it low-risk, unmeasured. Needs a run on a case with open findings.
- **(g)** high (this is lever 1, and the repo's most consequential record: an unruled id silently stays open).

## H3. `howChecked` is asked for in eight places and capped at 100 words, with truncation

- **(a)** Requests for content: L94-95 (unreadable feedback), L121-123 (verification pass), L256 (red check:
  which changes were treated as owing nothing), L265 (red evidence unavailable), L300-301 (item 4: what you ran),
  L337-339 (item 6: phrases searched and hits read), L360-362 (item 7: new destinations), L439-441 (the contract
  itself, "under 100 words"), plus runner text `renderDiffScope` "Say so in `howChecked`". Cap and consequence in
  `extraction.md:108-111`: "truncated past that rather than refused".
- **(b)** Co-location (one concept scattered across many headings; the skill: scatter, distinct from
  duplication); demand collision; sprawl.
- **(c)** Eight conditional obligations compete for 100 words and the overflow is cut from the end, silently. The
  obligations in the later items (6, 7) are exactly the ones the prompt makes "owed" by name, so they are the
  likeliest to be cut; and nothing says which to keep when the budget is tight. The agent also has to hold all
  eight in mind while it reviews, because they are spread over 350 lines.
- **(d)** Make `howChecked` one co-located contract at L439-441 and have each item point to it by a single
  parenthetical:

  ```
  - **`howChecked`**: under 100 words, truncated past that, so write it in this order and keep each part to a clause:
    what you ran or read past the diff; the phrases you searched for and how many hits you read (item 6);
    the new destinations you found, or none (item 7); then, only where it applies, that this was a
    verification pass and what you checked the earlier findings against, that a feedback surface or the
    red evidence was unreadable, or which changes you treated as owing no test. Every review carries one.
  ```
  And in items 4, 6, 7 and the red check, cut to "(record it in `howChecked`)". Whether to raise the cap is the
  maintainer's call and a code change (`howChecked` truncation); I do not propose it.
- **(e) Risk.** Pinned and must survive: item4 `toContain("howChecked")` and `/in \`notChecked\`/`; item6 regexes
  `/phrases you searched for/`, `/how many hits you read/`, `toContain("howChecked")`; item7 `/name the new
  destinations you found, or say there were none/` and `/within its limit/`; `halves` pins the prose fields by
  name in both files; `extraction.md:108` is the field contract. Moving clauses out of item 6/7 into L439 would
  fail the item6/item7 slice tests, so the in-item phrases stay and only the *scattered extras* (L94-95, L121-123,
  L256, L265) are redirected. The honest minimum edit: keep the pinned phrases in the items, add the ordered list
  at L439, and delete the extras.
- **(f)** behaviour-affecting. Measurable on the four cases only for the item 4/6/7 clauses. "Needs a run":
  compare `howChecked` truncation rate before and after.
- **(g)** high.

## H4. Branch-only reference rides in every run (sprawl; disclose by branch)

The runner already knows each branch and already fills a placeholder with branch-specific text for some of them.
Static `prompt.md` text for branches that are empty on nearly every review (the review's own comment: "which is
nearly every review", L549-550, extraction L202-204):

| Lines | Section | Live when | Lines |
|---|---|---|---|
| 88-95 | unreadable-feedback paragraph | a feedback selection was refused | 8 |
| 103-123 | verification-pass bullets | `history.afterFixRound` | 21 |
| 125-172 | FINDINGS AN EARLIER REVIEW LEFT OPEN | there are open findings | 48 |
| 174-185 | WHAT THE MAINTAINER HAS SETTLED | a human closed a finding | 12 |
| 187-208 | NOTES THE FIX RUN LEFT | the fix run left notes | 22 |
| 230-265 | RED CHECK (three branches, all printed) | one of three | 36 |
| 452-534 | TITLE AND SUMMARY (+ Merge Danger) | `SUMMARY_RULE` says "writes them" | 83 |

About 230 of 627 lines (37 percent). On a slice round or an unchanged head, `SUMMARY_RULE` says "omit both fields"
after 83 lines of how to write them.

- **(b)** Progressive disclosure by branch; sprawl; relevance ("a branch that should be disclosed"); the skill's
  test: "inline what every branch needs, push behind a pointer what only some branches reach".
- **(c)** Attention thins across the excess; the live parts of WHAT TO CHECK are a third of the file. The
  empty-state placeholders (`NOTHING_CARRIED` etc.) already say "nothing here"; the 20-line rule text beside each
  adds only load.
- **(d)** Move each branch's rule text into its placeholder so only the live branch is printed, as
  `renderSettledFindings` and `renderCarriedFollowUps` already do (the second attaches its ruling text only
  `entries.some(entry => entry.id !== undefined)`). For the verification pass, extend `describeHistory`
  (`review/review-round.ts:259`), which already returns a branch sentence. For the summary, hand the whole
  `# TITLE AND SUMMARY` + Merge Danger block through a `{{SUMMARY_SECTION}}` placeholder that is `""` when
  the rule says omit. Keep, in the static prompt, only one line per section naming the field and where its rule
  is. This is the largest single reduction available and needs runner code plus test changes, so I rank it with
  the high items but stage it last.
- **(e) Risk.** Heavy. `section()` in `review-output.test.ts` slices `# THE TITLE AND THE SUMMARY ... (?= # )` out
  of `PROMPT` for ~12 pins (sketch, Merge Danger, 150 words, Differs line); `tests/review/acceptance-criteria.test.ts`
  pins `{{SINCE_BRIEF}}` being inside the criteria section; `red-check.test.ts:336-343` pins `{{RED_CHECK}}`,
  `**A broken test is not red**` and `no red test covers` in the prompt; `pr-feedback.test.ts:1491` pins the
  heading "Feedback that could not be read" in the prompt; `halves` pins `latest reply`, `moved to followUps`,
  worked example etc. in the prompt. Each would have to read the rendered prompt (as `evals` replay does) or the
  placeholder's source instead.
- **(f)** behaviour-affecting for the live branches (needs evals, which do not cover them), but the
  *empty-state removal* is measurable on the existing four cases and is the part that saves tokens on nearly
  every run. Stage it: (1) empty-state removal first, (2) summary block last.
- **(g)** high.

---

# MEDIUM priority

## M1. The red-check section restates `renderRedCheck`, three times over

- **(a)** L239-244 (the red / broken / passed definitions), L234-237 (slice / final-review parenthetical), L259-260,
  L262-265. The placeholder text already says each: red "each failed there on the assertion shown, so each is
  evidence that it catches the behaviour" and broken "**A broken test is not red, and is not coverage**"
  (`shared/red-check.ts:312`); not configured "Review the tests as the rest of this brief says, and do not flag a
  change only for having no red test" (`red-check.ts:328`); unreadable `UNKNOWN` "judge the tests in the diff
  yourself, and take no claim that a test was red ... on the pull request's word" (`:186-187`); final review
  intro (`renderRedCheckForFinal`, `:345-352`).
- **(b)** Single source of truth; environment as source (the prompt is a cache of text the environment prints
  right below it); relevance.
- **(c)** The same rule printed twice per run, in two voices, and the three-branch prose is printed even though one
  branch is live. `evals/review/suite.yaml` shows the not-configured text injected verbatim, so a not-configured
  run sees the same sentence at L259-260 and in the placeholder.
- **(d)** Reduce `# RED CHECK` to the definition of the demand and drop what the placeholder carries:

  ```
  # RED CHECK

  {{RED_CHECK}}

  **Where it ran, hold every behaviour change to it.** For each behaviour change this pull request makes in a
  non-test file, find the red test that covers it: one whose failing assertion exercises that behaviour. Where
  none does, flag it plainly, as a finding to fix before merge, anchored at the change, naming the behaviour
  and saying that no red test covers it. One finding per uncovered behaviour, or one naming the class where
  several share a cause. A change that alters no behaviour (a comment, a rename, a refactor the existing tests
  pin, documentation) is owed nothing; say in `howChecked` which you treated that way. A claim in the body or a
  commit message that a test was red is not evidence: the report is.
  ```
  Keep the three-term definition in the placeholder only. To keep the pin, keep the phrase **A broken test is
  not red** in one sentence of the prompt (or move the test to the renderer's output).
- **(e) Risk.** `tests/red-check.test.ts:336-343` requires `{{RED_CHECK}}`, `/\*\*A broken test is not red\*\*/` and
  `/no red test covers/` in `prompt.md`. Evals: not measurable on the existing cases (red check not configured).
  Runner tests of `renderRedCheck` strings are unaffected.
- **(f)** safe prune for L239-244 (duplicate text, same words) and L259-260/262-265 (same instruction);
  the L234-237 parenthetical is behaviour-neutral but also unmeasured, so call the whole item "safe prune,
  with a run on a case whose red check ran".
- **(g)** medium (about 20 lines, but the double statement is of a rule the agent applies on every PR in
  repositories that configure it).

## M2. "A ruling is the whole of reporting it" is stated five times, phrased as negations

- **(a)** L41-43 (unmet: `Do **not** also write it into findings ... counted twice`); L141-147 (open: `do not
  write it up again ... counted twice, given a second thread, and carried separately every round after`);
  L202 (promoted note: `so do not also write it into followUps`); runner `renderCarriedFollowUps`
  (`Do not record any of them in followUps`); `extraction.md:52-55,191-194,228-229,80-81` repeat the rationale.
- **(b)** Single source of truth; negation (each is a prohibition with its positive already in the same
  sentence: "ruling it `unmet` is the whole of reporting it").
- **(c)** Five restatements of one rule, each with its own rationale paragraph, inflate its prominence past its
  rank and are five places to keep in step. The positive form ("the ruling is the whole of the report") is
  already there and is the stronger half.
- **(d)** State it once, in H1's step 2 ("A ruling is the whole of reporting its subject, never also a finding or
  a follow-up"), and in each ruling paragraph keep only the positive clause: "ruling it `unmet` is the whole of
  reporting it", "ruling it `open` is the whole of reporting it". Delete the "counted twice ... carried separately
  every round after" mechanics from the prompt (L144-147 after the first clause) and keep one copy in
  `extraction.md:52-55`.
- **(e) Risk.** `halves` test `forbids writing an open carried finding up again` needs, in both halves,
  `/not (?:also )?(?:write it up again|restate it)[^.]{0,160}\`findings\`/i`. Keep that exact clause in the `open`
  paragraph in both files or move the test. Nothing else pins the others.
- **(f)** safe prune for the rationale copies; the negation-to-positive rewording is behaviour-affecting only
  weakly. Needs a run only if the pinned clause is changed.
- **(g)** medium.

## M3. The "preference" cluster: five statements of one bar, one of which contradicts the count

- **(a)** L365-366 `Prefer a few high-signal comments over many trivial ones. A clean change gets a short review
  saying so.`; L387-389 `Nothing else is posted. A style preference, a "consider...", a rename you would accept
  being overruled on: ... Saying the change is clean is a finding; wishing it were different is not.`; L399-400 `A
  finding that can name none of these is a preference, and is not posted.`; L412-415 `\`low\` is **not** a place to
  put a preference. The bar for reporting anything has not moved: a style choice, a "consider...", a rename you
  would accept being overruled on is not posted at any severity.`; L610-611 `not a way to post a preference, which
  the section above says not to post at all`. Same list is in `extraction.md:27-28,89-91`.
- **(b)** Leading word (a pretrained one exists: **nit**); negation (five prohibitions of one thing);
  single source; no-op/sediment ("has not moved" is a changelog phrase from an earlier bar).
- **(c)** Three things go wrong. (1) The bar is defined well once (L396-400, basis) and then re-defined four more
  times, each with the same list. (2) L388-389 `Saying the change is clean is a finding` sits beside L373-374
  `Every finding is counted` and the derived verdict: a model that obeys it literally adds a "the change is clean"
  entry to `findings`, which would count and recommend changes. The intent (a clean review is a legitimate
  result) is stated correctly at L438-439 (`assessment`). (3) L365 invites under-reporting against items 5 and 6
  (see M4).
- **(d)** Coin the term once where the bar lives and drop the rest:

  ```
  **Nits are not posted**, at any severity. A nit is a finding that can name no basis (below): a style
  preference, a "consider...", a rename you would accept being overruled on.
  ```
  at L387; at L399-400 end with "A finding that can name none of these is a nit."; at L412-415 reduce to
  "`low` is a real defect, never a nit."; delete L365-366, the second sentence of L388-389, "The bar ...
  has not moved", and L610-611 tail. A clean change: "A clean change has an empty `findings`; `assessment` says
  why it holds up." in the `assessment` bullet only.
- **(e) Risk.** Pinned: item "asks each finding to name its basis" slices
  `Quote the code or check result each finding rests on.*?is not posted\.` and requires
  `/can name none of these is a preference/`, so L399-400 must keep "is a preference" (write "is a preference (a
  nit), and is not posted.") or the test moves. `halves`: `defines low as a real but small defect` (keep L408).
  `Nothing else is posted` and `high-signal` are unpinned. Extraction repeats must move with it.
- **(f)** The deletion of L365-366 and L388-389 sentence two is behaviour-affecting (clean-review shape; findings
  volume). The `nit` rewrite is behaviour-affecting but small. Run `clean-doctor-service-guard` before and after:
  does `findings` ever carry a "clean" entry today? "Needs a run" for the L388-389 claim.
- **(g)** medium (high if the clean-entry failure is observed).

## M4. "Prefer a few" conflicts with the file's own exhaustiveness bars

- **(a)** L365 `Prefer a few high-signal comments over many trivial ones.` against L316-321 `Report every gap you
  find in one round, grouped as one class`, L330-331 `Rule on every hit`, L254 `One finding per uncovered
  behaviour`, L373 `Every finding is counted`.
- **(b)** Completion criteria (demand): a vague brevity bound beside exhaustive ones; premature completion.
- **(c)** Items 5 and 6 spend a lot of words making the agent enumerate to completion; the line before the findings
  contract tells it to stop at "a few". A reviewer that finds the first member of a class is told to stop. This is
  the failure #137 (cited in the test comment at `review-output.test.ts` L3440-3450) was written to remove.
- **(d)** Delete the sentence. The quality bar is already the basis rule (L396-400) and the nit rule (M3).
- **(e) Risk.** `high-signal` is not pinned anywhere in `tests/`.
- **(f)** behaviour-affecting (may raise finding counts); needs a run on the four cases. 
- **(g)** medium.

## M5. Dangling pointer: "the bar stated with that list"

- **(a)** L118-119 `still a followUps entry, on the bar stated with that list`; L335-336 `a followUps entry on that
  list's bar`; L359 `on that list's bar`; L378-379 `on the bar stated with it`; L575-576 `on the bar stated with
  that list`. The bar (location, evidence, why this PR cannot fix it, top three, complete restatement) is in
  `extraction.md:151-183`, which the work pass does not see; `prompt.md` itself says "as the extraction step
  describes" once (L507), so it knows the pass exists.
- **(b)** Context pointers: a pointer whose target is out of reach in this pass; its wording decides when the
  material is reached, and here it is reached after the thinking is done.
- **(c)** During the work pass the agent decides whether a problem is a finding, a follow-up, or neither with no
  bar. The extraction then drops anything missing "evidence it is real" or "why this PR cannot fix it"
  (`extraction.md:158-161`: "a finding missing any of it is left out") whether or not the agent gathered that
  evidence while it still had the code open.
- **(d)** State the bar's three requirements once in `prompt.md`, at L378-379, and have the other four mentions say
  "a `followUps` entry (L378)":

  ```
  **A follow-up**: real, but not this pull request's to fix. It goes to `followUps`, and only with all three:
  one `path` or `path:line` to open first, the code or check result it rests on, and what this pull request
  would have to change that is not its subject. The extraction step states the format and the cap.
  ```
- **(e) Risk.** None of the five phrases is pinned; `halves` pins `followUps` and `/moved to \`?followUps\`?/` in
  both files, which remain.
- **(f)** behaviour-affecting (the agent will collect the evidence in the work pass). Medium risk; unmeasured on
  the empty-ledger evals except where a case produces follow-ups.
- **(g)** medium.

## M6. `needsYou` has a fourth case in one place and three everywhere else

- **(a)** L71-72 `where which reading the issue meant is a human's call, say so in needsYou`, against L536-551
  and `extraction.md:144-149` (three cases only: wrong thing built, issue wrong, a check fails unexplained). L225
  also points at it by ordinal: `the third case under *When another pass will not settle it*`.
- **(b)** Single source of truth (the definition of `needsYou`); fuzzy branch; context pointer by ordinal.
- **(c)** `needsYou` is "the one signal that says a human is needed" and is deliberately closed to three cases
  (L549-551). L71 adds an open one in the criteria section. A model sees an instruction to use the field for
  ambiguity and a rule that it is only for three things; it will pick one at random, or use it for ambiguity
  and spend the signal the later section protects.
- **(d)** Either route it through an existing case or add it in the one place: "...and where which reading the
  issue meant is a human's call, that is the issue itself being wrong or unclear: say so in `needsYou` (WHEN
  ANOTHER PASS WILL NOT SETTLE IT)". If the maintainer wants a fourth case it is added at L542-547 and
  `extraction.md:146`, and the test updated. And name the case at L225 ("a check fails and you cannot say why")
  instead of "the third case".
- **(e) Risk.** `names needsYou and the three cases it is for` pins `the wrong thing was built`,
  `the issue itself was wrong`, `/cannot say why/` in the prompt (extraction pinned for the field name only).
  Adding a fourth case fails nothing but the test's "three" naming; routing through an existing case fails
  nothing.
- **(f)** behaviour-affecting (what `needsYou` carries). "Needs a run" on a case with an ambiguous criterion.
- **(g)** medium.

## M7. `declined` is 20 lines of negations and one no-op, repeated in the extraction

- **(a)** L153-172: `is not yours`, `you never overrule a maintainer, and you never decline a finding on your own
  authority`, `A reply you cannot read as a decline leaves the thread open`, `reading a maybe as a no closes a
  finding nobody settled`, `Only a reply the workflow has already gated can close ... You will not see an
  untrusted author's comment at all, and a decline you attribute to one leaves the thread open whatever you
  rule`. `extraction.md:56-63` says the same.
- **(b)** Negation (the same prohibition five ways); no-op (L170-172: the agent cannot see an untrusted comment,
  so cannot attribute a decline to one; the workflow ignores it anyway); single source.
- **(c)** The agent's behaviour needs one positive rule; the prose gives the rule plus its audit trail and its
  threat model.
- **(d)**

  ```
  **`declined` is a maintainer's decision, and you only report it.** Rule a finding `declined` only on the
  maintainer's latest reply on its thread when that reply refuses it in words ("won't fix", "this is
  intended", "leave it"). The workflow quotes that reply when it closes. Every other reply, an
  explanation, a question, "I'll get to it", or a refusal the maintainer has since revisited, leaves the
  finding `open`.
  ```
  Delete L170-172.
- **(e) Risk.** `halves`: `rules a decline on the maintainer's latest reply` needs `/latest reply/i` in both
  halves: the rewrite keeps "latest reply". L170-172 is unpinned. Unmeasured by the evals (no replies in the
  replay inputs).
- **(f)** L170-172: safe prune but **needs a run** (readers disagree on whether the sentence guards against a
  hallucinated attribution). The rewrite: behaviour-affecting, low risk.
- **(g)** medium.

## M8. The settled-findings section states the rule three times, one of them by the runner

- **(a)** L174-177 `They are not open, they are not yours to verify, and there is nothing to report about them.`;
  L181-182 `**Do not raise any of these again**: not in the same words, and not as a fresh finding you derived
  from the diff.`; the placeholder itself ends `Each of these is **settled by the maintainer**. Do not raise it
  again, in these words or in any others.` (`shared/review-verification.ts:262-267`); L84-86 `Treat maintainer
  steering as authoritative`; L156-157 `you never overrule a maintainer`.
- **(b)** Single source; negation (three prohibitions in L174-177); environment as source.
- **(c)** The runner prints the instruction itself, directly below the list, and the prompt prints it again
  directly after: two identical commands in the same view. The rationale at L182-185 ("the record has no way to
  recognise that it has happened") is the only part that adds anything.
- **(d)** Keep the rationale and the exception, drop the repeat and the three-negation opener:

  ```
  # WHAT THE MAINTAINER HAS SETTLED

  Findings an earlier review raised that a **human** then closed by hand: settled, and out of every field.

  {{SETTLED_FINDINGS}}

  A maintainer closing a thread is the decision on that point; re-posting it as though it were new is this
  loop overruling the person it works for, and the record has no way to recognise that it has happened.
  If one is now a different problem (the code has changed since and broken something else), say so about
  *that* problem, naming what changed.
  ```
- **(e) Risk.** No test pins `Do not raise any of these` or the opener in the prompt; `review-verification` tests
  pin the renderer's tail (leave it). Unmeasured on the evals.
- **(f)** safe prune for the repeated sentence; the opener rewording is trivially behaviour-affecting.
- **(g)** medium.

## M9. The prompt carries the extraction's field contract, and the tests enforce the copy

- **(a)** Same meaning in both files (line refs `prompt.md` / `extraction.md`):
  severity definitions L402-425 / 25-33; "fix before merge" label and "every finding counts" L372-377 / 69-81;
  previously missed L381-385 / 83-87; findings never restated in the prose fields L429-433 / 75-78,98-100;
  `assessment` text including the same example sentence L434-438 / 102-107; `howChecked` L439-441 / 108-111;
  `title` L527-532 / 112-114; `summary` L464-500 / 115-124; Merge Danger fields L513-525 / 125-132; `needsYou`
  L536-551 / 144-149 (including "not a severity dial" rationale verbatim); anchoring and worked example L553-580 /
  5-20; id ban L586-588 / 35-36; suggestions' `startLine` L602-603 / 38-41; criteria statuses L27-43 / 217-231;
  notes L195-208 / 185-198; `verified` L133-172 / 43-67; em dash L445-446 / 141-142; `sinceBrief` omit rule
  L73 + runner `SKIPPED` / 233-238; `notChecked` L303-311 / 240-249. About 190 of the 312 extraction lines
  restate prompt text.
- **(b)** Single source of truth; when to split by sequence (the repo made the split on purpose: "Separating
  think from format", `agent.ts:421-424`); sprawl.
- **(c)** The skill's duplication cost is maintenance plus prominence inflation, and both are visible here:
  the `halves` suite exists because the two copies drifted before (see its comments on #96, #109, #122, #127,
  #224, #616). The work pass does not emit any field, so field-level format text in it (severity wording,
  label wording, `title` conventions, `door` fields, JSON field names) is spent on a pass that never writes
  them. Where run-variable text forces a copy to stay in the prompt (summary, see `agent.ts:439`), that copy
  must stay; the static ones need not.
- **(d)** Decide the home of each meaning by who acts on it. Work pass (judgement): what a finding is, basis,
  anchoring rule, ruling semantics (met/changed/unmet, landed/open/declined, promote/drop), sketch guidance,
  door definition. Extraction (format): field names, caps, truncation, ids, JSON shape, the severity definition
  and its cost (once), label wording, `title` convention, `startLine`, `notChecked` shape. Then delete the
  other copy and rewrite the `halves` test to name the single home. Candidates to remove from the prompt first
  because the extraction has them in full and the work pass does not act on them: L402-425 down to the
  definitions of the three levels (L404-410), L429-433 and L434-441 (`assessment`, `howChecked` contract; see
  H3), L527-532 title format, L586-588 id ban, L549-551 `needsYou` rationale tail.
- **(e) Risk.** Highest in the file. `halves` (14 pins) fails for each removed copy; `section()` pins; the
  runner's `FINAL_SUMMARY_SHAPE` is pinned from `review.ts`. Move each test in the same commit and keep the
  banned-word checks on both files.
- **(f)** behaviour-affecting for severity and label wording (the work pass currently sees them). Run all four
  eval cases. This is an architecture decision for the maintainer (the test comments show it was made
  deliberately), so I list it as a recommendation with a staged order: duplicates the extraction has *in full*
  first (`assessment` example, `needsYou` rationale, id ban, `startLine`, `title` convention).
- **(g)** medium (high for variance if the two copies drift again; low immediate effect).

## M10. `Raise only what is new` promises two outputs that have no field

- **(a)** L84-86 `A point already made below and since addressed gets one line acknowledging it; one still
  outstanding may be reinforced.`
- **(b)** Fuzzy completion criterion (no destination), contradiction with "Nothing else is posted" (L387) and the
  rule that a ruling is the whole of the report (L141-147).
- **(c)** There is no field for "acknowledging" or "reinforcing". The only channels are `findings` (counted, new
  id, second thread) and `howChecked`. A model that follows the sentence either writes a finding for a point
  already made (the double-count L144-147 warns about) or has nowhere to put it.
- **(d)**

  ```
  **Raise only what is new.** A point already made below is not a finding of yours: an earlier review's
  finding is ruled in `verified`, and a human's comment is theirs. Treat maintainer steering as authoritative.
  ```
- **(e) Risk.** `extraction.md:174` cites the phrase *Raise only what is new*; keep that phrase. Nothing in
  `tests/` pins L84-86.
- **(f)** behaviour-affecting (removes an invitation to write reinforcing findings). Needs a run on a PR with
  existing feedback (not in the current four).
- **(g)** medium.

## M11. Verification-pass paragraph: a no-op, three tellings of "previously missed", and rationale

- **(a)** L103-104 `A review that follows no fix round is the review described everywhere else in this brief:
  read the change, and report what you find.`; L108-110 `Rule on every open finding, as the section below says.
  That is the pass.`; L113-117 previously missed; L121-123 the howChecked rationale ("The reader is being asked to
  look at a pull request they had already been told was nearly ready, and why is the first thing they will want").
  L381-385 defines the label; extraction L83-87 repeats it.
- **(b)** No-ops; single source; sediment (L115-116 is a broken wrap: "to fix before it merges:\n the record was
  wrong"); branch disclosure (see H4).
- **(c)** `HISTORY` already says which case this is. L103-104 changes nothing; L108-110 repeats the next section's
  opener; "previously missed" is defined at L381 and L342-343, so L113-117 is a third.
- **(d)**

  ```
  **A review that follows a fix round is a verification pass.** The question is no longer *what is wrong
  with this change* but *did the last round's findings land, and did the new commits break anything?*
  Rule on every open finding (below); read the new commits for what they broke, since a fix that resolves
  its own finding and regresses something else is what nothing else is looking for; a real problem in code
  an earlier review already read is *previously missed* (THE TWO KINDS). Real but out of scope is still
  `followUps`. Say in `howChecked` that this was a verification pass and what you checked the earlier
  findings against.
  ```
  Delete the no-fix-round paragraph.
- **(e) Risk.** `previously missed` hits in tests are about rendering, not the prompt; `verification pass sweeps`
  is item 6 (L341-343), untouched. `halves` do not pin L103-123.
- **(f)** the no-op and rationale deletions: safe prune, but unmeasured (the evals replay no fix round);
  "needs a run" on a verification case. The rewrite: behaviour-affecting.
- **(g)** medium.

---

# LOW priority

## L1. Opening claims a "full list" it is not, and sets a persona
- **(a)** L8-9 `You are an expert code reviewer for this project. Review only: the **BOUNDARIES** section below is
  the full list of what you must not do.`
- **(b)** No-op (persona), negation, stale claim (the file has about 30 more "do not"s: settled findings, ids,
  em dashes, restating findings).
- **(c)** The "full list" claim is false and could be read as licence to ignore the other prohibitions.
- **(d)** `Review only; the checkout stays as you found it (BOUNDARIES, at the end, names the one exception).`
- **(e) Risk.** No test pins L8-9. `review-output.test.ts` L3476-3492 comments assume BOUNDARIES is "described on
  line 8" but test the BOUNDARIES section only.
- **(f)** persona deletion: needs a run (disagreement about the default); the rest safe prune.
- **(g)** low.

## L2. Criteria-sourcing exposition and the "place the code has left" paragraphs
- **(a)** L21-23 (`read off its acceptance section by the workflow (the latest one, where a triage brief posted
  as a comment ... supersedes the body's; or its checklist ...)`), L48-52 (`An issue waits before it is built ...`,
  `The agent that built this change was told to check them first ...`), L58-62 (`Work merged after the brief ...`).
- **(b)** Relevance (exposition about how the workflow works); environment as source.
- **(c)** The agent needs the criteria and what to do with a moved reference; how the workflow sourced them is
  not an action. One piece does change behaviour: "supersedes the body's" stops the agent from reading the body's
  older list in `LINKED_ISSUE` instead. Keep that clause, cut the rest.
- **(d)** `The linked issue's acceptance criteria (the latest triage brief supersedes the body's list), each
  under the id a ruling names it by:` and cut L49-50's first sentence and L58-62 to the "since the brief"
  definition.
- **(e) Risk.** `supersedes` unpinned in prompt tests; the criteria pins are about `{{ACCEPTANCE_CRITERIA}}`,
  `{{SINCE_BRIEF}}` placement and the statuses (`acceptance-criteria.test.ts:456-520`).
- **(f)** safe prune for the exposition; "needs a run" for the supersedes clause.
- **(g)** low.

## L3. `sinceBrief`'s "leave out" rule in three places, and a negation with a positive ready to hand
- **(a)** L72-73 `Never raise a finding that the brief is out of date: nothing a fix round can edit would answer
  it. Where nothing is listed, leave sinceBrief out.`; runner `SKIPPED` "Nothing to rule on: leave `sinceBrief`
  out."; `extraction.md:233-238`.
- **(b)** Single source; negation; environment as source.
- **(c)** Placeholder says it on the case it applies to; prompt and extraction say it again.
- **(d)** Delete the last sentence of L73. Positive form of the previous one: `A stale brief is a ruling
  (\`changed\`, or \`needsYou\`), never a finding: nothing a fix round can edit would answer it.`
- **(e) Risk.** Unpinned in the prompt (`sinceBrief` name is pinned in both halves).
- **(f)** first deletion safe prune; second behaviour-affecting but small.
- **(g)** low.

## L4. The unreadable-feedback paragraph repeats the note it introduces
- **(a)** L88-95 against `notePreamble` (`shared/pr-feedback.ts:653`): "unknown rather than empty", "do not
  read its absence as agreement, and say so in your output if it matters".
- **(b)** Single source; environment as source; branch disclosure.
- **(c)** The note prints on exactly the runs it applies to, with the full statement; the prompt paragraph is a
  second copy for all other runs.
- **(d)** `A note headed *Feedback that could not be read* below says what the API refused and what that
  leaves unknown; where it changes a conclusion, say so in \`howChecked\`.` (keeps the heading).
- **(e) Risk.** `tests/pr-feedback.test.ts:1491-1493` requires the prompt to contain the heading `Feedback that
  could not be read`. The test's stated premise ("the framing for it belongs in the prompt the runner
  controls") is satisfied by the preamble, which the runner also controls.
- **(f)** safe prune. 
- **(g)** low.

## L5. CI section: vocabulary collision and an ordinal pointer
- **(a)** L225-226 `a review that says nothing about a red one leaves the reader with a verdict and no
  diagnosis`; L223 `A failing check is the most valuable thing in this review`; L224-225 `the third case under
  *When another pass will not settle it*`.
- **(b)** Leading words (here `red` means a failing CI check, a second meaning beside the RED CHECK section's);
  context pointer by ordinal; hyperbole that no stronger word fixes.
- **(c)** `red` is defined at L239 as a test that failed on an assertion at the base. A reader holding that
  definition reads "a red one" as a test. Minor, but the repo's own leading word is the one doing two jobs.
- **(d)** `A failing check is the most valuable evidence in this review: diagnose why. A failure you can explain
  is a finding to fix before merge; one you cannot is the case *a check fails and you cannot say why* under
  *When another pass will not settle it*. The check results are read again after you, so a review that says
  nothing about a failing check leaves the reader with a verdict and no diagnosis.`
- **(e) Risk.** Unpinned. `red` in code (`ci: "red"`) is not touched.
- **(f)** wording only; safe prune of the ordinal; behaviour-affecting not expected.
- **(g)** low.

## L6. Item 6's tail and item 8's catch-all
- **(a)** L330-331 `...The step is done only when every hit has been ruled on, not when the first few have been.`
  and L363 `8. **Clarity and edge cases** worth a second look.`
- **(b)** No-op (the tail repeats "every hit" as a negation); fuzzy criterion (item 8 has no bound and no
  output).
- **(c)** The tail names the failure it forbids. Item 8 asks for nothing checkable and invites findings that fail
  the nit rule.
- **(d)** Cut ", not when the first few have been". Item 8: either delete, or give it a bound: `8. **Edge cases**
  the change handles wrongly: name the input.` (a finding must name a concrete input anyway, L396-400).
- **(e) Risk.** Item 6 pin `/done only when every hit/` still matches. `item8` pinned only by `/ 8\. Clarity and
  edge cases/` and the "keeps clarity and edge cases last" test; a rename moves that test.
- **(f)** tail: safe prune, **needs a run** (readers disagree on whether it guards a rush). Item 8:
  behaviour-affecting.
- **(g)** low.

## L7. Negations in items 5 and 7 that already have their positive
- **(a)** L316 `Checking the one input the change was written for is not checking this.`; L352-354 `Passing
  through some cleanup step is not enough, and a cleanup that removes something else does not count.`
- **(b)** Negation.
- **(c)** Each names the shortcut it forbids. Both have a positive twin one sentence earlier.
- **(d)** L316: `The change's own input is the least likely to reach the quiet path.` L352-354: `Cleaned means
  that specific thing is removed or masked (the credential stripped from the URL, the token replaced).`
- **(e) Risk.** `/cleanup that removes something else does not count/` is pinned in
  `review-output.test.ts` (item 7). Leave L352-354 unless the test moves. L316 unpinned.
- **(f)** behaviour-affecting but minimal; **needs a run** (disagreement is about the model default).
- **(g)** low.

## L8. BOUNDARIES: three bans the environment already enforces
- **(a)** L624-625 `Do not push. Do not edit labels. Do not create GitHub comments or reviews yourself; your
  findings are returned as structured output and posted by the workflow.`
- **(b)** No-op / environment as source (`scrubGitHubTokens()` runs before the agent starts,
  `review/review.ts` "the review agent must not hold the GitHub token"; a reviewer does not push by default).
- **(c)** The agent cannot do any of the three; the information worth keeping is "your findings are returned
  as structured output".
- **(d)** `Your findings are returned as structured output and posted by the workflow.`
- **(e) Risk.** Unpinned in the review prompt (`workflows.test.ts:6567` pins implement-prd's `Do not push.`).
- **(f)** safe prune, **needs a run** (hard guardrails are cheap; if the maintainer prefers belt and braces, keep).
- **(g)** low.

## L9. Summary section: no-op tails and exposition
- **(a)** L454-458 `Everything else in the body ... is never touched`; L464 `It does not retell the linked
  issue`; L494-495 `Sketches do not count against those words; the prose does`; L497-501 `A maintainer's edit
  is not a lock, and it is not to be thrown away either`; L517-518 `"A revert restores it" is what two-way means,
  and is not worth a note`; L522-523 `do not restate the default, which is not worth saying`; L502-507 and
  L509-511 `Leave that section out of summary` twice.
- **(b)** No-op; negation; relevance.
- **(c)** Each states a thing the agent cannot do (edit the rest of the body) or a both-sides tail with no
  decision in it.
- **(d)** Delete those sentences; keep the first half of L494 and the pinned phrases. For the two "leave out"
  paragraphs: `\`summary\` ends before \`## Evidence\`: the workflow lays out the Evidence and the Merge Danger
  after it.`
- **(e) Risk.** Pinned in `section()`: `about 150 words`, `/sketches do not count against/i` (keep the first
  half of L494), `/one-way door is one a revert cannot undo/`, `/only where something is/`, `/from when: on merge,
  or at the next release/`, `` `## Evidence` `` (`red-check.test.ts`), `not.toContain("Failing-first tests")`.
- **(f)** safe prune for the tails; "needs a run" for the both-sides tail (L497-501).
- **(g)** low.

## L10. Item 4: the `notChecked` contract is split and duplicated
- **(a)** L303-311 against `extraction.md:240-249`: "Several tests skipped in one suite for one reason are one
  entry", "A test the diff itself marks skipped with no condition ... is a finding under item 5", "It changes no
  verdict".
- **(b)** Co-location (a field's contract in the middle of the Tests step); single source.
- **(c)** The agent decides during the run whether it ran tests and what skipped, so the instruction belongs
  here; the shape of the field belongs in the extraction. Both carry both.
- **(d)** Keep in the prompt: record whether you ran any tests and each skip for want of something in the
  environment, with the reason; the item-5 hand-off. Remove from the prompt "Several tests skipped in one suite ...
  and how many" and "The body shows the list as it is and it changes no verdict, so list what skipped rather
  than weighing it." (extraction keeps them).
- **(e) Risk.** `describe("the review brief asks what its own run left unrun")` pins `in \`notChecked\``, `whether
  you ran any`, `skipped for want of something in the environment`, `with the reason`, `Running tests is your
  choice; saying whether you did is not`, `with no condition is not one of these: it is a finding under item 5`.
  The two sentences to remove are not pinned.
- **(f)** safe prune.
- **(g)** low.

## L11. Sediment: unwrapped lines and changelog phrases
- **(a)** L144 and L373 and L383 are the only lines in the file not wrapped at 100 columns, each carrying a
  sentence that was appended later (`Identifiers are the workflow's and text is never matched, so ...`,
  `Every finding is counted and every one is listed in the review's findings record under **Open** ...`,
  `It counts the same way: what the label adds is ...`); L412-413 `The bar for reporting anything has not
  moved`; L115-116 broken wrap.
- **(b)** Sediment.
- **(c)** Appended layers that restate their neighbour (L373-376 restates L69-81 of the extraction; L383
  restates L381-383). They are where to start coring.
- **(d)** Covered by M2, M3 and M9 deletions; wrap the survivors.
- **(e)/(f)** as in those findings.
- **(g)** low.

## L12. Suggested changes block: three small trims
- **(a)** L602-604 `startLine whenever the replacement spans more than one line ... no diff -/+ markers; no
  nested code fence` (duplicates `extraction.md:38-41` and is mostly negations); L610-611 preference restatement
  (M3).
- **(b)** Negation; single source.
- **(d)** `Write the replacement lines exactly as they should appear, with the surrounding indentation.` and drop
  the `startLine` bullet from the prompt (extraction owns it) or the reverse.
- **(e) Risk.** Unpinned in the prompt; `extraction.md:38-41` is the pinned side if any test reads it.
- **(f)** safe prune.
- **(g)** low.

---

# Not findings (checked)

- "oracle" / "scope creep" / "fail closed" look like jargon but are the leading words the skill asks for; keep.
- `Read CONTEXT.md first ... CLAUDE.md is already in your context; do not read it again` is a negation, but it
  is pinned across all runners (`tests/prompt-ending.test.ts:85-123`) and it is cheap.
- `THE TWO KINDS` text on the basis rule and the worked example at L567-573 are the best passages in the file.
- The `FOLLOW-UPS EARLIER ROUNDS RECORDED` section (L210-212) is exactly the pattern to copy: a heading and a
  placeholder, the rule text in the runner.

# Staging suggestion

1. **Safe prunes** (M1, M8 repeat, L4, L8, L10, L12, L9 tails, M11 no-op): one commit, `verify` only; move
   `red-check.test.ts`, `pr-feedback.test.ts` pins.
2. **Positive rewrites and escape-clause removal** (H2, M2, M3, M4, M10, L3, L7): behaviour-affecting; before
   and after eval on the four cases plus one new case with open findings and a maintainer reply.
3. **Structure** (H1, H3, M5, M6): one eval pair.
4. **Disclosure and single-sourcing** (H4, M9): runner changes, test rewrites; last.
