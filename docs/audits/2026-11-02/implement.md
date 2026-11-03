# Audit: implement/prompt.md and implement-prd/prompt.md against writing-for-agents

Read at origin/main c53531d. Citation key: `I:n` = `implement/prompt.md:n` (90 lines), `P:n` = `implement-prd/prompt.md:n` (124 lines).
Risk lines list the tests that pin a phrase (grep of `tests/` at that commit). "No evals": there are no golden-PR evals for either prompt, so every behaviour-affecting change below is unmeasured until a case set exists (`evals/` holds review and fix only).

Repo rules that bound every proposal: no domain words, no gate command, no em dash, `#N` alone, and the `{{...}}` tokens each runner fills. A proposal below also keeps the "do not read CLAUDE.md again" regex in `tests/prompt-ending.test.ts:85-99` satisfied (no sentence containing a capital-R `Read` followed by `CLAUDE.md`).

Summary table (class / priority)

| Id | Where | Lever | Class | Priority |
|---|---|---|---|---|
| H1 | I:51,88 P:73,122 | completion criterion (clarity, demand) | behaviour-affecting | high |
| H2 | P:102-107 vs P:113 | premature completion (post-completion step) | behaviour-affecting | high |
| H3 | I:30-43 P:51-65 | completion criterion / missed branch | behaviour-affecting | high |
| H4 | I:20-24 P:36-40 | context pointer, sediment | behaviour-affecting | high |
| M1 | I:64-66,80-82 P:87-90,113-115 | duplication, co-location | safe prune | medium |
| M2 | I:52 P:74 | demand | behaviour-affecting | medium |
| M3 | I:54-62 P:76-85 | duplication | safe prune | medium |
| M4 | I:85-86 P:118-120 | negation, environment as cache | behaviour-affecting | medium |
| M5 | P:42-45 | relevance, wasted context | behaviour-affecting | medium |
| M6 | P:89-90 vs P:98-100 | duplication, contradiction | safe prune | medium |
| M7 | whole pair | duplication with drift | safe prune (+1 behaviour-affecting add) | medium |
| M8 | I:14,26,30 P:30,47,53 | co-location | safe prune | medium |
| M9 | P:8-14 | duplication | safe prune | medium |
| L1 | I:14-16 P:30-32 | no-op | safe prune, needs a run | low |
| L2 | P:105 | no-op, negation | safe prune | low |
| L3 | P:44-45 | no-op | safe prune | low |
| L4 | P:9,13 | imprecision, duplication | safe prune | low |
| L5 | I:3 P:3,5 | duplication of the environment | safe prune | low |
| L6 | P:111-112 | imprecise example | behaviour-affecting | low |
| L7 | I:88-89 P:122-123 | negation | behaviour-affecting, needs a run | low |
| L8 | I:23-24 P:39-40 | no-op rationale | safe prune, needs a run | low |
| L9 | I:70 etc. (four prompts) | no-op | safe prune, needs a run | low |
| L10 | P:23-24 | negation | behaviour-affecting, needs a run | low |
| L11 | I:83 P:116 | negation, placement | behaviour-affecting, needs a run | low |

Totals: 24 findings (4 high, 9 medium, 11 low). Safe prune: 13 (M7 carries one behaviour-affecting add). Behaviour-affecting: 10 (H1-H4, M2, M4, M5, L6, L7, L10). Neutral/optional: 1 (L11). Marked "needs a run": M4, L1, L7, L8, L9, L10, L11 (and parts of M3, M8).

---------------------------------------------------------------------------------------------

## HIGH

### H1. "Done" is never defined, and the commit and closing lines pull past it (both files)
(a) `I:51` "3. REPEAT until the issue is done"; `P:73` "REPEAT until the slice is done"; `I:88` / `P:122` "When complete, after committing, output only ...". Also `I:54` "the criteria are observed through" and `I:38` "A criterion that names the old place" use "criteria" with no antecedent.
(b) Completion criterion, clarity and demand; premature completion. "Done" and "complete" are the only bounds on the whole run, and they are circular. The visible later steps (verify, "Commit as soon as the work first passes", the closing promise) supply the pull; the bound supplies none of the resistance. The reviewer meanwhile rules on every acceptance criterion one by one (`CONTEXT.md:426`, met / changed / unmet), so the implementer is told to stop at a bar the reviewer does not use.
(c) Behaviour: the first green verify after the first red-green cycle is the natural stopping point; "as soon as the work first passes" (I:80, P:113) reads as the trigger to commit, and "When complete, after committing" is then satisfied by that commit. A criterion left untested is found by the review a round later, or never. This is the single largest source of variance in the pair. Splitting the sequence is not available (one `maxIterations: 1` run, no context boundary), so the fix is to sharpen the bound.
(d) Proposed. Step 3 becomes the checkable, exhaustive bound; the closing line borrows it.
- I:51 -> `3. REPEAT until every acceptance criterion of the issue (or, where it lists none, every change it asks for) is observed passing through a test`
- P:73 -> `3. REPEAT until every acceptance criterion of the slice (or, where it lists none, every change it asks for) is observed passing through a test`
- I:88 / P:122 -> `When every criterion is met and committed, output only `<promise>COMPLETE</promise>`, with no summary of what you did: nothing reads one.` (the tail stays byte-identical to the pinned text.)
This also gives `I:54` / `P:76` their missing antecedent, and uses the word the review uses (acceptance criteria), a leading word already in the repo's vocabulary.
(e) Risk. Nothing pins "until the issue is done", "REPEAT" or "When complete". `tests/prompt-ending.test.ts:15` pins "output only `<promise>COMPLETE</promise>`, with no summary of what you did" (keep the tail verbatim). `tests/rescue.test.ts:170` pins the commit line (untouched). No test moves.
(f) behaviour-affecting; no evals. (g) high.

### H2. P: the self-review is placed "before commit" but the commit line says commit as soon as verify first passes (implement-prd only)
(a) `P:102-107` "# BEFORE YOU COMMIT / Review your own slice: read the diff you are about to commit as though someone else wrote it." versus `P:113` "Commit as soon as the work first passes the verify command".
(b) Premature completion: a post-completion step ("commit as soon as") pulling past the step in front of it. Also completion criterion, clarity: the self-review has no bound ("read the diff" is done the moment it is read).
(c) Two readings, so two paths through the document. A run that verifies, sees green and commits "as soon as" skips the self-review; the section's own stakes ("the next slice is built only once that review approves it") say that is the costly failure. The rescue line was added for time-limit safety (#303) and wins by being the later, more concrete instruction. If the review does lead to an edit after the first pass, the run commits twice and verifies twice; the "once" wording at P:88 is fighting this.
(d) Proposed. Put the review before the verify run, so "the work" that first passes is the reviewed work, and give it a checkable bound:
```
# BEFORE YOU VERIFY

Read the diff you are about to commit as though someone else wrote it, and trace it to the slice: every acceptance criterion has a test that observes it, and every changed hunk serves one. A design problem you catch now costs one edit; one the review catches costs a round.
```
Move the section to sit directly before the verify sentence (after the seam paragraph, i.e. before `P:87`), delete `P:102-107`. `P:113` stays as is.
(e) Risk. grep "BEFORE YOU COMMIT", "Review your own slice", "ceremony" in `tests/`: no hit. `tests/rescue.test.ts:170` pins P:113-114 and is untouched. No test moves.
(f) behaviour-affecting; no evals. (g) high.
Note on asymmetry: I has no self-review at all. That is defensible (a slice's defects compound into every later slice, P:44-45; a standalone issue's do not), so not raised as a finding; mark "needs a run" if the user wants parity.

### H3. The stale check says "one of three things is true" but the three do not cover the cases (both files)
(a) `I:32-43` / `P:54-65`: "One of three things is true: 1. Everything is where the issue says ... 2. Something moved, and where it went is clear ... 3. The issue's premise no longer holds: what it removes is already gone, or what it fixes was replaced."
(b) Completion criterion (clarity) and a missed branch. The list claims to be exhaustive and is not; the examples in 3 cover only removal and fix.
(c) Uncovered: (i) a thing the issue names is gone or renamed and where it went is NOT clear (2 requires "clear", 3 requires the premise to fail): the agent guesses a location and builds there, or improvises a verdict, run to run differently; (ii) an issue that adds something already present (examples in 3 name only "removes" and "fixes"). Both are the case the stale stop exists for, a human's call. Also the closing line (I:89) says "A run you stopped as stale", but item 3 never uses the word; the tag name and the closing cross-reference are the only places "stale" appears, so the reader must map "premise no longer holds" to "stale" by themselves. Use the word as a leading word at the branch.
(d) Proposed (issue wording; the slice file gets the same with "slice"):
```
3. **The issue is stale**: its premise no longer holds (what it removes is already gone, what it fixes was replaced, what it adds is already there), or something it names is gone and you cannot tell where it went. Stop. Commit nothing. End your output with `<stale>` and `</stale>` around one or two sentences naming which part of the issue no longer matches the code and what the code shows instead. That is a human's call, not yours, and the run fails with your reason.
```
(e) Risk. `tests/prompt-ending.test.ts:25-26` pins "End your output with `<stale>` and `</stale>`" and "A run you stopped as stale ends with its `<stale>` tag instead" (both kept). grep "premise", "moved", "Something moved" in tests: no prompt pin. `tests/stale.test.ts` tests the runner's parser, not the prompt. No test moves. The CHECK block is unguarded for drift between the copies (see M7).
(f) behaviour-affecting; no evals. (g) high.

### H4. The CLAUDE.md pointer describes a file shape that no longer exists (both files)
(a) `I:20-23` / `P:36-39`: "It is the rules to follow: the commands, the conventions, and the contract anything you add here has to satisfy, including any step-by-step it gives for the kind of change this issue asks for."
(b) Context pointer (the wording decides whether the target is reached) and sediment. Since #654 CLAUDE.md is "a short core with a pointer per topic": the step-by-step lives in `docs/agents/*.md`, reached by the "Read before a change of this kind" bullets (which are imperative: "Read the one your change is before you edit"). "Any step-by-step it gives" now says "steps it contains", which it mostly does not. The must-have target (the doc whose steps, if skipped, fail named tests: `docs/agents/changing-a-runner-or-a-command.md` etc.) sits behind a pointer worded for the old layout. The clause also lists CLAUDE.md's contents ("the commands, the conventions"), which the file itself already says (a cache of a lookup that costs nothing: the file is in context).
(c) Behaviour: an agent that reads "step-by-step it gives" as "inline steps" and sees none will not follow the bullets' links; it then ships a runner change without the doc's steps and the review catches it a round later. For adopters the same sentence is accurate only if their CLAUDE.md has inline steps, which is the weaker case.
(d) Proposed (adopter-neutral, no domain word):
```
`CLAUDE.md` is already in your context; do not read it again. It is the rules to follow, and it is the copy that is kept current: follow it there rather than from memory. Where it points to a file to read before a kind of change, and the issue asks for that kind, read that file before you edit.
```
(drops the "commands, conventions, contract" list and the "(this prompt included) ... second copy already drifting" clause, see L8; keeps the pinned heads.)
Care: the second `read` is lowercase and does not contain the literal `CLAUDE.md` after it, so `tests/prompt-ending.test.ts:85-99` regex (`\bRead\b ... `CLAUDE\.md``) is not tripped; do not capitalise it into a sentence-start `Read`.
(e) Risk. `tests/prompt-ending.test.ts:67` pins "`CLAUDE.md` is already in your context; do not read it again. It is the rules to follow" and `:71` "it is the copy that is kept current" (both kept, but the sentence between them changes: rejoin as "It is the rules to follow, ..." only if the pin at :67 ends at "rules to follow" - it does). `:96` pins the first sentence for every runner. grep "step-by-step" in tests: no hit.
(f) behaviour-affecting; no evals. (g) high (for this repo, where the skipped doc is the commonest named-test failure); medium for adopters.

---------------------------------------------------------------------------------------------

## MEDIUM

### M1. The verify cadence is said twice and split from the commit rule (both files)
(a) `I:65-66` "Run it again only if anything changed after it passed." and `I:82` "A later commit is a change after that pass, so run the verify command again before making it." Same in `P:88-89` and `P:115`.
(b) Duplication (same meaning, two places) and co-location (the verify cadence is in EXECUTION, the commit trigger in COMMIT, and the environment-failure branch's own commit instruction, "Otherwise commit, and name ...", I:74-75, is a third place).
(c) Two statements of one rule inflate its prominence and let them drift (they are already worded differently: "once ... again only if" vs "a later commit is a change"). The "once" at I:65 also contradicts, on a quick read, the commit-twice flow that COMMIT describes.
(d) Proposed: keep the point-of-use sentence in COMMIT as the single source and cut the other:
- I:64-66 -> `While iterating, run the test files that cover your change, not the whole suite. Run the verify command `CLAUDE.md` names before committing. It must pass.`
- Move I:69-75 (the verify-failure branch) under `# COMMIT`, after the commit-early lines, since its last sentence is a commit instruction.
(e) Risk. `tests/prompt-ending.test.ts:42-44` pins the full "once, before committing. It must pass. Run it again only if anything changed after it passed." (must be edited in the same commit, for both prompts via `describe.each`). `:46-48` pins the L82 sentence (kept). `tests/rescue.test.ts:170` pins the commit line (kept). `tests/verify-failure.test.ts` pins the failure paragraph by substring, so moving it intact is free. Also the describe-block comment at `prompt-ending.test.ts:28-33` names "once" and would need rewording.
(f) safe prune (the pinned text moves, the behaviour is the same); keep the "tests that cover your change while iterating" sentence. (g) medium.

### M2. REFACTOR has no demand or bound (both files)
(a) `I:52` / `P:74` "4. REFACTOR".
(b) Completion criterion, demand. A one-word step sitting last, with COMMIT in sight, is the step most likely to be skipped, and where it is not skipped it is unbounded: it is in tension with step 2 ("the smallest correct change"), and in P with "Do not start the next sub-issue, even if the code you are writing would be tidier with it done".
(c) Variance in both directions: no refactor, or a refactor that rewrites neighbouring code and then needs a second verify and widens the diff the review must read.
(d) Proposed: `4. REFACTOR the code this change touched, with the tests green` (the bound is the diff and the green bar; "red" already means failing test in the same list, so "green" is the paired leading word).
(e) Risk. grep "REFACTOR" in `tests/`: no hit. No test moves.
(f) behaviour-affecting; no evals. (g) medium.

### M3. "Use an existing seam" is stated three times, with a rationale sentence (both files)
(a) `I:56-57` "otherwise write them at a seam that already exists", `I:58` "test at the nearest existing seam", `I:61` "Test through a seam the code already has, rather than one made for the test: extracting a function purely so it can be tested in isolation, for example, creates spaghetti tests." Plus `I:58-59` "Carry on with the run either way: a seam the code lacks is a gap in the brief for a human to read in that message." (same in P:79-85).
(b) Duplication. `tests/test-seam.test.ts:22-26` already insists the guidance be given once ("keeps the guidance against a seam made for the test once"), but the meaning "an existing seam" appears in three sentences. The last sentence is a rationale for "say so in the commit message" (the instruction is already said) plus the one live clause "Carry on with the run".
(c) Cost is low (about 70 tokens) but the three phrasings invite three readings ("a seam that already exists" vs "the nearest existing seam" vs "a seam the code already has"); "spaghetti tests" is also a vague word that recruits little (see leading words).
(d) Proposed:
```
A test seam is the public surface the criteria are observed through: a command and its output, a function's contract, a check's pass and fail. Where the brief names a test seam, write the tests there. Where it names none, or the named seam does not exist in the code or cannot observe a criterion, use the nearest seam the code already has, and say so in the commit message; carry on with the run either way. Extracting a function purely so it can be tested in isolation is not a seam: it creates tests coupled to the extraction.
```
(the last sentence swaps "spaghetti tests" for the thing it means; needs a run if the user prefers the original word.)
(e) Risk. `tests/test-seam.test.ts:16` pins "Where the brief names a test seam, write the tests there; otherwise write them at a seam that already exists."; `:21` pins "Where the named seam does not exist in the code, or cannot observe a criterion, test at the nearest existing seam and say so in the commit message."; `:27-28` pins "Test through a seam the code already has" (exactly once) and "extracting a function purely so it can be tested in isolation". All three assertions change in the same commit. Conservative variant: delete only the "Carry on ... in that message." sentence's rationale half ("a seam the code lacks is a gap in the brief for a human to read in that message") and leave the rest, touching no pin.
(f) safe prune (conservative variant) / behaviour-neutral rewording (full variant). (g) medium.

### M4. Five prohibitions in a row, where the environment already enforces them and a positive hand-off exists in one copy (both files)
(a) `I:85-86` "Do not push. Do not edit labels. Do not create GitHub comments. Do not close the issue. Do not create or edit PRs." `P:118-120` same plus "The workflow does all of that after you exit."
(b) Negation (each ban names the forbidden act, making it more available) and environment as source (the runner calls `scrubGitHubTokens()` before the agent starts: `implement/implement.ts:68`, and `tests/workflows.test.ts:6538-6548` asserts the same for implement-prd; the agent has no token to label, comment, close or open a PR with). The positive target already exists in P ("The workflow does all of that after you exit") but not in I: drift.
(c) The ban list names five tracker acts the agent was not going to perform and cannot; its main effect is to put "edit labels", "close the issue" and "create PRs" into context. Where the tracker acts are the thing a stopped-at-the-limit agent should not attempt, the positive form carries it.
(d) Proposed, both files:
```
Your work ends at the commits on `{{BRANCH}}`: the workflow pushes them, and moves the labels, posts the comments, closes the issue and opens the pull request after you exit.
```
(P: `closes #{{SUB_NUMBER}}`... keep the two numbers it names today.)
(e) Risk. `tests/workflows.test.ts:6567-6568` ("the implement-prd runner keeps the agent off the tracker") pins `/Do not push\./` and `/Do not close/` on `P` and must move in the same commit; it is a structural guard the user may want to keep as a guardrail ("a prohibition earns its place only as a hard guardrail you cannot phrase positively"; this one can be). Hence "needs a run" and a human call on whether the test, not just the prompt, should change. No pin on I.
(f) behaviour-affecting (tiny); no evals. (g) medium.

### M5. P: the earlier slices' whole diff is read on every run (implement-prd only)
(a) `P:42-45` "Then read what the earlier slices already did: `git log {{BASE_REF}}..HEAD` and `git diff {{BASE_REF}}...HEAD`."
(b) Relevance and wasted context. `{{BASE_REF}}` is the default branch, so the diff is the cumulative PRD, N-1 slices deep: the cost grows with the slice's position, and the last slice reads everything. The stated purpose (match a convention an earlier slice set) needs the log plus the earlier work in the files this slice touches.
(c) Late slices spend most of their context re-reading unrelated slices, leaving less attention for the slice and the self-review.
(d) Proposed: `Then read what the earlier slices already did: `git log {{BASE_REF}}..HEAD`, and the diff of each earlier commit that touched a file this slice touches.` (the agent can run `git log -p {{BASE_REF}}..HEAD -- <path>`).
(e) Risk. grep "git diff", "git log", "BASE_REF" in `tests/` for prompt text: no pin on this line. No test moves.
(f) behaviour-affecting; no evals. (g) medium.

### M6. P: the verify paragraph says "read the failure before assuming" and then gives a procedure that makes reading unnecessary; "without your change" and "on the base" differ (implement-prd only)
(a) `P:89-90` "It covers the earlier slices too, so a failure may be yours or may be an interaction with what is already on the branch; read the failure before assuming which." versus `P:92` "yours unless it also fails without your change", `P:93` "on `{{BASE_REF}}`", `P:98-100` "An interaction with an earlier slice passes on the base and fails on the branch, so it is yours to fix in this slice."
(b) Duplication within the file and a contradiction in procedure. The same question (whose failure is it) gets a diagnostic ("read the failure") and then a decision procedure (run on the base). Also "without your change" suggests the branch tip at entry, while the procedure and P:98-100 test on the default branch: a failure an earlier slice introduced passes on the base, fails on the branch, "is yours" by P:98, but "also fails without your change" by P:92.
(c) Two procedures for one decision; the agent that follows P:89-90 spends time reading and then runs the base check anyway; the ambiguity can send it to "not mine" for an earlier slice's latent failure.
(d) Proposed: P:89-90 -> `It covers the earlier slices too.` and leave P:98-100 as the one place for the interaction rule. Optional second edit (changes the shared pin, see below): P:92 `yours unless it also fails on {{BASE_REF}}`.
(e) Risk. grep "interaction", "read the failure" in `tests/`: no hit. The "unless it also fails without your change" half is pinned for all four prompts at `tests/verify-failure.test.ts:17` (`describe.each` over I, P, fix, update-branch): the optional second edit needs that test to take a per-prompt phrase.
(f) safe prune (first edit); behaviour-affecting (optional second). (g) medium.

### M7. The two files repeat about 45 lines and have drifted; only some of the shared lines are guarded
(a) Line by line: CONTEXT paragraph `I:12-24` = `P:28-40`; CHECK block `I:30-43` = `P:51-65`; EXECUTION `I:45-75` = `P:67-100`; COMMIT `I:77-86` = `P:109-120`; closing `I:88-90` = `P:122-124`. Drift found: (1) `I:66-67` "Save the full output of a test run to a file and search that file ..." is in I only; (2) `P:89-90`, `P:98-99` interaction sentences in P only; (3) `P:120` "The workflow does all of that after you exit." in P only; (4) the title restated differently (L5); (5) the CHECK block's parenthetical "(in its body, its comments and any brief on it)" and "reading the PRD for context" in P only (legitimate); (6) P:111-112 names the slice in subject, I names nothing.
(b) Duplication with drift. Tests already guard parity for some lines through `describe.each` (seam lines, verify lines, commit-early, closing, glossary). Not guarded: the whole CHECK block, the CONTEXT paragraph beyond its two pins, the em dash line, the bans (only P), the "moved" note wording.
(c) The CHECK block is the most intricate shared text (a three-way protocol with a machine-read tag) and the least guarded. Drift in it would make the two runners disagree about what a stale run is.
(d) Which copy is the source of truth: I for the shared blocks (it is the base case; P is "I plus a delta"). Proposed in order of cost:
1. Cheapest: a parity test that normalises the nouns (issue/slice, "the issue's"/"the slice's") and the three known P-only sentences, and asserts the CHECK block, the CONTEXT paragraph and the COMMIT block are equal after normalising. No change to what the agent reads; the prompts stay whole documents "written for the agent".
2. Move the "Save the full output of a test run to a file ..." sentence into P too (the verify there is the larger suite): behaviour-affecting, low.
3. Not recommended now: a shared TS constant for the shared blocks passed through `promptArgs` (as `RESUME` is). It would hide the text from the files the tests read raw (`fs.readFileSync("implement/prompt.md")` in six test files) and from `evals.test.ts:99`, and the agent-facing prompt would be assembled out of view.
(e) Risk. A new test file only. `tests/evals.test.ts:99` (no copy of a prompt's lines of 80+ chars under `evals/`) is unaffected.
(f) safe prune (items 1); item 2 behaviour-affecting. (g) medium.

### M8. Read-before-edit instructions are scattered across three places (both files)
(a) `I:14` "Read `CONTEXT.md` before changing code", `I:26` "Explore the code the issue touches, and its tests, before editing. Match what is there.", `I:30` "Before you change any code, check that the files, functions ... still exist as described". Same in `P:30`, `P:47`, `P:53`.
(b) Co-location. The exploration sentence sits in the CONTEXT section though it is the first half of the check below it; the check is the exploration, focused on the named things. "Match what is there" is a convention rule that belongs with EXECUTION, where P also says it (P:44).
(c) Three "before editing" gates in three sections; the reader assembles the sequence (CONTEXT, explore, check) themselves. The check is also where the demand is stated, so the exploration is not bound to anything.
(d) Proposed: delete `I:26` (`P:47`) and open the check with the exploration: `Before you change any code, read the code and tests the issue touches and check that the files, functions, steps, inputs and commands the issue and its brief name still exist as described.` Move "Match what is there." into step 2 of EXECUTION (`2. GREEN: implement the smallest correct change, matching what is there`).
(e) Risk. grep "Explore the", "Match what" in `tests/`: no hit. No test moves.
(f) safe prune (co-location); "Match what is there" may be a no-op (needs a run). (g) medium.

### M9. P: the scope limit is stated three times (implement-prd only)
(a) `P:9` "Later slices are not yet written and are not yours.", `P:11-12` "Implement **only** #{{SUB_NUMBER}}. Do not start the next sub-issue, even if it looks small, ...", `P:12-14` "Another run does that one, on this same branch once this slice is reviewed, with this same context, and a slice that quietly absorbs its successor leaves that run with nothing to do and a sub-issue nobody can honestly close."
(b) Duplication; and a negation where the positive ("only #SUB") is already given.
(c) The scope guard is the strongest statement in the file, which is fitting for a failure that is real (over-building into the next slice), but P:9's sentence adds nothing to P:11, and P:13-14 spends 45 words on a rationale for a rule that P:11-12 states with the rationalisation it pre-empts ("even if ... tidier with it done", the one worth keeping).
(d) Proposed:
```
Implement **only** #{{SUB_NUMBER}}. The next slice is another run's, built on this branch once this slice is reviewed; absorbing it, even where the code you are writing would be tidier with it done, leaves that run nothing to do.
```
and delete P:9's last sentence.
(e) Risk. grep "Later slices", "Do not start the next", "tidier" in `tests/`: no hit. `tests/workflows.test.ts:6563-6568` pins `{{SUB_NUMBER}}`, `{{BRANCH}}` (kept).
(f) safe prune. (g) medium.

---------------------------------------------------------------------------------------------

## LOW

### L1. The parenthetical that defines a domain model (both; needs a run)
`I:14-16` / `P:30-32` "the domain model (the concepts this project is built from, the distinctions it holds between them, and where the seams are)". No-op: a model that is told to read `CONTEXT.md` before changing code, and that is told in the next sentence to read its glossary, knows what a domain model is; the live part is "Reason from it, not from what the code appears to do." Proposed: `Read `CONTEXT.md` before changing code, and reason from it, not from what the code appears to do.` Risk: `tests/prompt-ending.test.ts:76,99,109` pin "Read `CONTEXT.md` before changing code" and the glossary sentence (kept); `tests/agent-cli.test.ts:5614` concerns the file's name. Class safe prune, needs a run (two readers could disagree whether "where the seams are" primes seam-first testing at I:56). Priority low.

### L2. "This is not ceremony:" (P:105)
A negation about the prompt's own register, no-op: the following clause is the actual motivation. Proposed: delete the five words and capitalise: `This slice is reviewed ...` (or fold per H2). Risk: no pin. Safe prune. Low.

### L3. "matters more here than in a standalone issue" (P:44-45)
The agent has no standalone issue in view; the comparison is to the other prompt. Proposed: `Match a convention an earlier slice established: every later slice is built on top of this one.` Risk: no pin. Safe prune. Low.

### L4. Small imprecisions in P:9 and P:13 (implement-prd only)
"Later slices are not yet written" reads as "no sub-issues yet" though they are filed and the PRD below lists their order; use "not built yet". "with this same context" (P:13) has no clear referent; delete. "build on them rather than redo them" (P:9) duplicates P:44 "Build on that rather than beside it"; keep one (P:44 after L3). Risk: no pins. Safe prune. Low.

### L5. The title is restated beside the reference (both)
`I:3` "Implement issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}"; `P:3` `#{{SUB_NUMBER}}: {{SUB_TITLE}}`; `P:5` "PRD #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}". The issue context below opens with the same title (`implement/implement.ts` builds `# ${issue.title}` first, or "Issue #N: title" for an outsider's), so the title is in the prompt twice. The repo's rule (`tests/round-header.test.ts:185`) is for posted text, so this is not a violation, only a duplicate. Proposed: `Implement issue #{{ISSUE_NUMBER}}.` Risk: no pin (`tests/workflows.test.ts:6561` pins the placeholders `{{SUB_NUMBER}}`, `{{BRANCH}}` only); the runner still passes the title args. Safe prune. Low.

### L6. P: the commit-subject example forces `feat` (implement-prd only)
`P:111-112` "Name the slice, not the PRD: `feat: ... (#{{SUB_NUMBER}})`." The example names one type for a slice that may be a fix, a doc or a refactor, and release notes classify by type. Proposed: `Name the slice: `<type>: ... (#{{SUB_NUMBER}})`.` (also drops the ", not the PRD" negation; the example already carries the target). Risk: no pin on this line; trailer text is the runner's, and `tests/implement-prd/publish.test.ts:1020` requires the prompt not mention `agent-slice` or `trailer` (kept). Behaviour-affecting, no evals. Low.

### L7. The closing line names the summary it forbids (both; needs a run)
`I:88-89` / `P:122-123` "output only `<promise>COMPLETE</promise>`, with no summary of what you did: nothing reads one." The "only" carries the positive; the negation primes a summary, and the rationale is for the maintainer. Counter-argument: models have a strong default toward a closing summary, so the explicit ban may earn its place as a guardrail. Settle by a run. Risk: pinned verbatim for I, P and fix at `tests/prompt-ending.test.ts:15`. Behaviour-affecting, no evals. Low.

### L8. The CLAUDE.md rationale clause (both; needs a run)
`I:23-24` / `P:39-40` "it is the copy that is kept current, and anything restating it (this prompt included) would be a second copy already drifting from it." The reason is for whoever maintains the prompt (single source of truth), not for the run; the live instruction is "Follow it there rather than from memory". Risk: `tests/prompt-ending.test.ts:70-72` ("keeps the reason for deferring to it") pins "it is the copy that is kept current" on I (so the half-sentence after the comma can go without a test move). Proposed in H4. Safe prune, needs a run. Low.

### L9. "(`git worktree add`)" (both, and fix and update-branch)
`I:71` / `P:94`. The agent knows how to make a worktree; the parenthetical is a no-op. Delete in all four prompts at once. Risk: `tests/verify-failure.test.ts:23` pins the text before the parenthetical ("...in a separate worktree"); the parenthetical itself is unpinned. Safe prune, needs a run (settled by running). Low.

### L10. P: "It is not a second task list." (implement-prd only)
`P:23-24`. A negation that names the thing to avoid (a second task list: the PRD lists the other slices). Positive: `Read this for the ordering, the vocabulary and the reasoning behind where the seams are; the slice above is the whole of your task.` Risk: no pin. Behaviour-affecting, needs a run (it guards a real failure, over-reaching into other slices, that M9 also covers). Low.

### L11. The em dash line (both; needs a run)
`I:83` / `P:116` "Do not use em dashes in anything you write; use a comma, colon, semicolon, parentheses, or a new sentence instead." It is correctly paired with the positive replacement list, so no negation finding; the only issue is placement: a global style rule sits inside COMMIT between commit mechanics, though it governs code comments and docs too. Proposed (optional): move it to the end of TASK or EXECUTION, or leave. Risk: `tests/test-seam.test.ts:34` only asserts the prompts contain no "—". Behaviour-neutral. Low; probably leave.

---------------------------------------------------------------------------------------------

## Leading words (check 6)
- `red` / `green`: already used in the numbered list. Use them in M2 (REFACTOR "with the tests green"), and in the verify-failure paragraph, where the clusters "yours unless it also fails without your change" / "fail there too, with the same message" / "A failure you did not reproduce on the base is yours" could read "A red verify is yours unless the base is red the same way". Not proposed as a change: the paragraph is pinned for four prompts at `tests/verify-failure.test.ts`, and the gain (about 40 tokens) does not clear the cost of moving five assertions.
- `seam`: already a leading word, in two senses: `CONTEXT.md` seams (module boundaries; `I:15` "where the seams are") and test seam (`I:54`). Optional link, needs a run: `Where the brief names no test seam, use one `CONTEXT.md` names.`
- `stale`: appears in the tag and the closing line but not at the branch (H3).
- `criteria`: the review's own word (`CONTEXT.md:426`), missing from the implementer's completion bound (H1).
- `slice`: used; `moved note` is a coined phrase (`I:36-37`) that is defined in place, which is acceptable.

## Environment-as-cache lines (check 7)
The verify command and the gate are correctly left to `CLAUDE.md`. Cached lines worth questioning: the CLAUDE.md contents list (H4), the title (L5), "(`git worktree add`)" (L9), the five bans against a scrubbed token (M4). Not cached and correct to keep: `git log {{BASE_REF}}..HEAD` (the base is not otherwise discoverable), "only committed work survives" (an unwritten gotcha).

## What the pair does well
- Verify and gate are never named: the prompts defer to `CLAUDE.md`, one source of truth the adopter owns (also test-enforced).
- The stale check is a closed, observable branch with a machine-read ending, and the closing line resolves the conflict between "output only the promise" and the stale tag at the point of recency.
- The commit-early rule is supported by its real reason (a run can be stopped at its limit; only committed work survives), which is exactly the kind of unwritten gotcha worth caching.
- The scope guard in P (P:11-14) names the rationalisation it pre-empts ("even if the code ... would be tidier"), the strongest sentence in either file.
- Positive-first phrasing where a ban is needed: the em dash line carries its replacements; the seam guidance leads with "Test through a seam the code already has" and tests assert the old "Do not improvise" form is gone.
- The "what to do when verify fails and the base fails too" branch is complete (decision, evidence, action, what to write), and tests pin it across four prompts.
- Modest length (90 and 124 lines), a linear step order, and no sprawl: the reference is small and inline, and the PRD context and issue text are substituted, not restated.
- Tests already pin parity for the seam, verify, commit-early, glossary and closing lines through `describe.each`, which is a partial drift guard (see M7 for the gap).
