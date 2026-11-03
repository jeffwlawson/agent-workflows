# Audit of CONTEXT.md against `writing-for-agents`

Read-only audit. Document: `CONTEXT.md` at `origin/main` = `c53531d`, 1024 lines, 92,412 bytes (about 23.1k tokens at ~4 chars/token; all token figures below are estimates on that rule).
Line numbers are as at that commit. Issue states were read with `gh issue view` (98 distinct issue numbers cited in the file: 92 CLOSED, 4 MERGED, 2 OPEN; the open ones are #68 and #305, both cited as still open, which is accurate).

## Shape of the document (measured)

| Lines | Section | Bytes | Share |
|---|---|---|---|
| 7-63 | Glossary | 10,008 | 11% |
| 64-547 | What this is (no subheadings) | 43,200 | 47% |
| 548-678 | The three parts | 10,669 | 12% |
| 679-692 | Orchestrator, the record and the agent | 875 | 1% |
| 693-736 | The install path | 3,904 | 4% |
| 737-837 | The service orchestrator | 9,310 | 10% |
| 838-844 | Why reusable workflows, not a composite action | 379 | <1% |
| 845-943 | Trust boundary, agent's own runner, loop's identity, base-controlled | ~7,600 | 8% |
| 944-1024 | Pin, invariants, prompts name no domain, where the rest is written | ~6,200 | 7% |

Glossary: 47 terms, 25 of them (53%) link to the one `What this is` section; 21 have a non-empty Avoid cell. The Section column is 2.4 KB of the glossary's 10 KB, and "[What this is](#what-this-is)" repeated 25 times carries no information.

## What the document does well (keep)

- **The glossary exists and is test-held** (`tests/context-md.test.ts`): one-line meanings (average about 20 words, none over 30), an Avoid column, links to sections, and a check that every link lands and every `##` is linked. This is a real context pointer set and #640 was the right move.
- **It carries reasons, not only facts.** Examples: why the reviewer closes a finding and the fixer never does (L304-311: a resolved thread is dropped from the next review's feedback, so the one pass that asks "did it land?" could not see it); why the split exists (L872-899); why a composite action cannot hold the controls (L838-843). This is the "cache what the agent cannot find by looking" content the skill wants kept.
- **`Invariants with no runtime symptom` (L955-998) is the best section in the file by the skill's own test**: each bullet is a gotcha no config confesses (`bin` must not start with `./`, `assets/severity-*.svg` rename, cancelled-not-failed on timeout, a label set at issue creation fires nothing). Keep it, and make it easier to reach (F8).
- **Leading words are used and repeated as tokens**: *arm / disarm*, *park*, *advance*, *early stop*, *split*, *frame*, *one order*, *part, not layer*. They are in the prompts, the code and the docs, so they recruit the same behaviour at each site.
- **The three-parts distinction (L548-678)** is the one thing CLAUDE.md says every change needs; its placement and the ASCII diagram are right.

## Findings

Numbering is by priority. "Tests" lists what pins the text; a move must change them in the same commit.

---

### F1. The file tells the agent two opposite things about how much of it to read — HIGH — behaviour-affecting

- (a) `CONTEXT.md:3` "Read this before changing anything" (whole file implied) vs `CONTEXT.md:9` "Read this first, then only the sections below that a change touches". `CLAUDE.md:22` "Read it before changing a workflow — especially the *three parts*" repeats the whole-file version. The four runner prompts and `docs/agents/domain.md` say glossary-first.
- (b) Lever: **context pointers** (the wording decides how much material is reached) and **sprawl**. A pre-#640 sentence survived beside its replacement.
- (c) Why it matters: in an interactive session the agent holds only L3 and CLAUDE.md:22, both say "read it", so it reads 23k tokens; the runners, told to read the glossary first, read a different amount. Same document, two reading policies, which is run-to-run variance.
- (d) Proposal. Replace L3-5 with:
  `The domain model. Start at the [Glossary](#glossary), then read only the sections a change touches; [CLAUDE.md](./CLAUDE.md) has the commands and conventions, [README.md](./README.md) is for people installing the package, [docs/ADOPTING.md](./docs/ADOPTING.md) for people installing the loop.`
  And `CLAUDE.md:22`: `See [CONTEXT.md](./CONTEXT.md): read its Glossary, then the *three parts* section before changing a workflow.`
- (e) Risk. Tests: none pins L3 or the CLAUDE.md:22 sentence (`tests/claude-md.test.ts` pins headings and the 150-line cap only; `tests/context-md.test.ts` starts at `## Glossary`). `tests/context-md.test.ts` requires `## Glossary` to be the first `##`; the intro stays above it. No test change.
- (f) behaviour-affecting (low risk, tiny edit). (g) high: cheapest fix of the whole audit.

---

### F2. `What this is` is one 484-line, 43 KB section with no subheadings, and most of the glossary points into it — HIGH — behaviour-affecting

- (a) `CONTEXT.md:64-547`, opening `## What this is` and then 43 paragraphs, each begun with a bold lead word (`**A trigger label is on while its run works**` L150, `**Review is the one run whose work and whose posting are two jobs**` L181, `**The fix threshold places the open findings**` L386, `**What the change is lives in the pull request's body**` L457 ...). Glossary rows 14-38 (25 rows) all link `[What this is](#what-this-is)`.
- (b) Lever: **information hierarchy / progressive disclosure** (nothing between "the file" and "the one 43 KB section" for a pointer to land on) and **sprawl**. Also a **context-pointer** defect: a pointer that names a 484-line target has no usable trigger, so the glossary "saves little" exactly as the #689 review noted: an agent that wants *Early stop* or *Round header* is sent to read 10.8k tokens.
- (c) Why it matters: every runner whose change touches one of 25 terms reads the whole section (about 10.8k tokens, 47% of the file) to learn one rule. The glossary was supposed to prevent exactly this.
- (d) Proposal (no content moves yet): add `###` headings that already exist as paragraph lead-ins, and retarget the 25 glossary links to them. Suggested slices, with current lines:
  1. `### The labels and the issue shape` L66-83 (table, partition)
  2. `### The PRD chain: branch, slice range, slice round` L85-134
  3. `### Round headers` L136-142 (and the pre-upgrade note, see F6)
  4. `### A trigger label is on while its run works; one order` L150-179
  5. `### Review is two jobs; the review after a push` L181-225
  6. `### Fix rounds: budget, early stop, advance and park` L227-281
  7. `### Update-branch and the arm` L283-302
  8. `### Findings: who closes them` L304-347 (reviewer closes, maintainer outranks, direction, outcome owed)
  9. `### Out-of-scope notes` L349-360
  10. `### The review body and its findings` L362-424 (record, fix threshold, minor findings, thread anchoring)
  11. `### Acceptance criteria and what changed since the brief` L426-455
  12. `### The pull request body: frame, summary, evidence` L457-511
  13. `### Follow-ups and the post-merge checklist` L513-546
  Section cell becomes a pointer with a trigger: e.g. Early stop -> `[Fix rounds](#fix-rounds-budget-early-stop-advance-and-park)`.
- (e) Risk. `tests/context-md.test.ts`: `anchors()` collects headings of every level, so new `###` anchors are valid link targets; the "links to every section below it" test checks `^## ` only, so new `###`s need no glossary row. Nothing pins `#what-this-is` itself, but `## What this is` must remain (the file's `##` list must stay linked; keep at least one row linking it, or the test fails). `tests/workflows.test.ts:6396-6520` reads the file as a string, not by heading: it needs `Review adds a trigger label in two cases.` (L227), the paragraph containing `**advance**` with `second arrow`, `**parent**` and `**bounded by the number of sub-issues**` (L263-281), the table rows `| \`agent:implement\` on ... |` with `**issue**` / `**PRD parent**`, `| \`implement\` |`, `| \`implement-prd\` |`, `approval`, `hand the PRD PR over` (L70-78), and the bold terms `**slice range**`, `**slice round**`, `**final review**`, `**progress list**`, `**finishing run**`. All survive inserting headings between paragraphs. Do not reflow those paragraphs.
- (f) behaviour-affecting (changes what is read; no content lost). (g) high: largest expected effect per line of change; also the prerequisite for F3.

---

### F3. The review and fix internals (about 33 KB) are loaded by runs that never touch them — HIGH — behaviour-affecting (phase 2, after F2)

- (a) `CONTEXT.md:181-546` ("Review is the one run ..." through "There are two follow-up kinds ..."): the review's two jobs, post-push labelling, fix-round budget and early stop, advance/park, finding ownership, out-of-scope notes, review body layout, fix threshold, criteria, PR-body frame, final-review summary, follow-ups. Sum of those paragraphs is about 32.6 KB (about 8.2k tokens).
- (b) Lever: **progressive disclosure by branching**: "inline what every branch needs, push behind a pointer what only some branches reach." `implement`, `implement-prd`, `update-branch`, and any session on `setup/`, `service/` or `engine/` need the label table, the PRD chain and the three parts, not the shape of the review body. Only `review`, `fix`, and changes under `review/`, `fix/`, `follow-ups/` reach this material.
- (c) Why it matters: 8.2k tokens of the 23.1k in context for runs that cannot use them, and attention thinned across reference that has no step to attach to (the skill: in-file reference that should be disclosed buries the steps).
- (d) Proposal. Create `docs/agents/review-and-fix-rounds.md` holding L181-546 verbatim under the F2 headings (plus F9/F11 prunes). In CONTEXT.md keep a 6-8 line summary under `### How a review and a fix round fit together` (the arrow `fix`/`update-branch` -> `agent:review`; the two bounds on the return leg, budget and early stop; advance/park; the arm; one sentence each, with the terms bolded so the glossary rows stay true) ending:
  `Read [Review and fix rounds](./docs/agents/review-and-fix-rounds.md) before changing review, fix, follow-ups or anything that posts a finding, a verdict, the pull request body or a follow-up.`
  Update the `review`, `fix` and `implement-prd` prompts (they already name CONTEXT.md; add one sentence naming this file as the next read), and add `docs/agents/review-and-fix-rounds.md` to the table in `docs/agents/domain.md` and `CLAUDE.md`'s pointer list only if a trigger is not already covered.
- (e) Risk (this one is large). Tests that must change in the same commit:
  - `tests/context-md.test.ts`: every glossary row requires `row[3]` to match `\]\(#[^)]+\)`, i.e. an in-file anchor. Rows whose text moves (about 25) must either keep an anchor to the summary heading or the regex must be widened to `\]\((#|\./docs/)[^)]+\)` and a new check added that the file exists.
  - `tests/workflows.test.ts:6396` reads `CONTEXT.md` for L227's "Review adds a trigger label in two cases.", the `**advance**` paragraph (L263), and (L6502) negative regexes (`slice PR`, `slice branch`, `integration review`, `slices table`, `chain-merge`, `advance-merged`). After the move those assertions must read both files, or the negatives silently stop guarding the moved text. Keep the table rows (L70-78) and the PRD-chain bold terms (L85-148) in CONTEXT.md and the first part of the test stays unchanged.
  - `tests/prompt-ending.test.ts:111` pins the exact glossary sentence per runner; extending a prompt must not alter that sentence.
  - Section-name pointers elsewhere (not tested): `docs/platform-spec.md:72`, `docs/profiling.md:136`, `docs/agents/domain.md:81`, `docs/agents/releasing.md:147`, `docs/parity.md:1106` (cites "CONTEXT.md (the review body paragraph)").
  - Eval prompts: a change to a review or fix prompt is measured by `evals/` per CLAUDE.md; this edit changes two of the four prompts, so it needs the before/after eval runs the CLAUDE.md asks for.
- (f) behaviour-affecting. (g) high, but do it after F2, and measure: if F2 alone brings per-run reads down enough, F3 can wait.

---

### F4. The command lists and the "has moved" ledger are a cache of `shared/contract.ts`, and they are stale — HIGH — safe prune

- (a) `CONTEXT.md:616-623` "`fix:gate`, `fix:prepare` ... `update-branch:conclude` are the commands today, and no step that decides still runs as YAML shell" (36 names); `CONTEXT.md:585-605` "`review` has moved (PRD #409) ... So has `fix` (PRD #466) ... And so has `follow-ups` (PRD #508), the last". `shared/contract.ts` `COMMANDS` (line 1224) also holds `merge:gate`, `merge:publish`, `merge:conclude`, which neither list names, and `merge/` and `.github/workflows/merge.yml` exist (CONTEXT.md itself says at L760 that the merge job "runs `merge.yml`'s three commands").
- (b) Lever: **environment as source of truth / cache** ("leave the one-file lookups to the environment, where they cannot go stale"), plus **sediment** (a ledger of which PRD moved which workflow, seven PRD numbers, reading as history).
- (c) Why it matters: an agent that adds a `merge:*` step, or checks "is there a command for this?", reads a list that is wrong, with the same authority as the rest. Six PRD numbers and a 20-line ledger do not change any action; they only say the move is finished, which one sentence says.
- (d) Proposal. Replace L585-605 (21 lines) with:
  `Every reusable workflow's deciding steps are commands, named \`<workflow>:<step>\` (\`shared/contract.ts\`, \`COMMANDS\`, is the list). What shell is left in a reusable records facts only Actions has (a clock, a job's status); a fix to a step goes in its command.`
  Delete the 36-name list at L616-623, keep the sentence after it.
  Also fix the dependent clause in `docs/agents/changing-a-workflow.md:6` ("Only in a workflow whose steps have not moved yet, which CONTEXT.md's *three parts* names, does a guard still go in the reusable's YAML"): with every workflow moved it names an empty set, a branch that cannot fire; delete the clause. (`docs/platform-spec.md:60-66` holds a third copy of the same list, also missing `merge:*`; out of scope for this file, same fix.)
- (e) Risk. Tests: none reads these lines (grep of `tests/` for `readFileSync("CONTEXT.md")` gives only `context-md.test.ts` and `workflows.test.ts` at 6396, 7043, 7068; none matches command names). `tests/workflows.test.ts` has its own `COMMANDS`-based walks that do not use this prose. Safe.
- (f) safe prune. (g) high: removes a wrong statement and about 2.2 KB.

---

### F5. The `service orchestrator` section re-states `docs/deploying-the-service.md`, `docs/platform-spec.md` §4.2/§11/§12 and ADR 0008 — HIGH — behaviour-affecting (verify each fact is elsewhere, then cut)

- (a) `CONTEXT.md:737-837` (101 lines, 9.3 KB, about 2.3k tokens), e.g. L750-767 "A job has a **kind** ... at this release the kinds are `review` (`ReviewJob`) ... `merge` (`MergeJob`, #591) ... one more is absorbed by the one waiting ... (#645)", L777-801 the scan, `SCAN_DISPATCH_LIMIT`, `SCAN_MERGED_WINDOW_DAYS`, `STATE_FILE`, instance ids (#597, #581, #582, #596, #603, #618), L802-831 the worker's phases and token kinds, L833-836 pointer to the settings table.
- (b) Lever: **single source of truth** and **cache of the environment**. I checked that the same facts are written in `docs/deploying-the-service.md` (the dispatcher, worker, scan, `STATE_FILE`, token kinds `read/write/resolve/push`, `EXTRA_OWNERS`, `AGENT_SETUP`, coalescing: all present), `docs/platform-spec.md` §4.2 (label-to-kind map, `SERVICE_LABELS`, `follow-ups` on every merge, `merge` on push/check-suite/status) and ADR 0008 (one job kind per workflow, own-App sender). Constants such as `SCAN_DISPATCH_LIMIT` are in `service/settings.ts` and the code. Also **no-op / sediment**: "At this release the kinds are ..." is a time-stamped list that the next kind falsifies.
- (c) Why it matters: this is the section with the highest churn (it cites 20 issue numbers, most in 2026-10/11) and so the likeliest to disagree with `docs/deploying-the-service.md` the day after a service PR; two-source edits are what produced F6's stale lines. A reader changing `service/` is already sent to those docs; a reader changing anything else never needs it.
- (d) Proposal. Keep L739-745 (the concept: second orchestrator, so not a fourth part; its code is `service/`, neither a workflow folder, `shared/` nor `engine/`; the same subcommands under the same contract), the two invariants that are domain rather than operation ("A job carries no token" and "the runner only ever gets `read`"), and then:
  `The dispatcher, the worker, the scan and the settings are in [docs/deploying-the-service.md](./docs/deploying-the-service.md); the label-to-job-kind map is [docs/platform-spec.md](./docs/platform-spec.md) §4.2 and [ADR 0008](./docs/adr/0008-service-job-kinds-and-own-app-sender.md). Read them before changing \`service/\`.`
  Target about 14 lines / 1.4 KB (saves about 7.9 KB, about 2k tokens). Delete L821-823 ("the budget was held at 0 until something answered `agent:fix`"): it narrates a state that ended when the last kind was served.
- (e) Risk. The glossary row `Service orchestrator` links `#and-the-service-orchestrator-which-is-an-orchestrator-not-a-part`: keep the heading text unchanged. Tests: no test reads text in this section (`workflows.test.ts` / `context-md.test.ts` do not). Not pinned. The risk is information loss, not a failing test: before deleting a sentence confirm it exists in `docs/deploying-the-service.md` or the platform spec (I did for the items listed; I did not check the sentence about the worker "writing nothing to the record and spelling no record string" L811-812, which `docs/platform-spec.md` may or may not hold; keep that one line).
- (f) behaviour-affecting (a cut of live content, even though duplicated). (g) high.

---

### F6. Stale and sedimented lines that describe a state of the world that has changed — MEDIUM — safe prune

- (a), (c), (d) one by one:
  1. `CONTEXT.md:686-687` "A second one, a service outside Actions, was prototyped on #364." Contradicts L739-745 and L746 on the same page (the service is built, PRD #453, `AGENT_ORCHESTRATOR=service`); #364 is CLOSED and its title reads "Prototype: an agent:review orchestrator on Sandcastle". An agent reading the Orchestrator bullet first learns the service is a prototype. Replace with "A second one, [the service](#and-the-service-orchestrator-which-is-an-orchestrator-not-a-part), runs outside Actions."
  2. `CONTEXT.md:144-148` the "chain an older release started is migrated" paragraph, "removable under #224". #224 is CLOSED (title: "Remove pre-upgrade compatibility code from the review ..."), yet the code still carries `Pre-upgrade compatibility, removable under #224` in `implement-prd/chain.ts:25`, `gate.ts:214`, `publish.ts:365`, `shared/progress-list.ts:124`, `docs/platform-spec.md:1373` and `.github/workflows/implement-prd.yml:45`. So the marker is the code's own grep handle and is already searchable there; the paragraph is read on every run by agents who never meet an older chain. Delete the paragraph (8 lines), or cut to one sentence: "Rules marked *Pre-upgrade compatibility* in the code serve a chain an older release started."
  3. `CONTEXT.md:252-258` the history of the removed `round rule`, the `auto-fix` input (v0.7.5, "removed (#366)") and `agent:queued`; L155 "`agent:in-progress` ... is retired"; L726 "a caller still passing the removed `auto-fix`". The glossary Avoid cells already carry `agent:in-progress`, `auto-fix` and "the round rule". Keep them there only (that is what the column is for) and cut from the prose (about 6 lines). This also reduces negation: the retired names are spoken once, where the instruction is "do not use".
  4. `CONTEXT.md:853-859` "Not something the `@v7` bump bought, either — the refusal was backported into `v6.1.0`, `v5.1.0` and `v4.4.0`, and `@v4` floats to the last of those." Every checkout in `.github/workflows` is `@v7` (14 of 14), so the version archaeology serves no branch. Keep the two sentences about `ref:` and `allow-unsafe-pr-checkout`.
  5. `CONTEXT.md:674-677` "Part, not layer. These were *the three layers* until stacked pull requests arrived ..." Keep one sentence (a **layer** is a pull request in a GitHub stack); drop the history (the glossary row `Part` already carries it as Avoid).
  6. `CONTEXT.md:1006-1007` "This is why the loop can run anywhere. It is also why **this** repo needs its own `CLAUDE.md` and `CONTEXT.md` — it is an adopter of itself." Exposition: no action follows from it. **No-op.**
  7. `CONTEXT.md:933-937` "block `pull_request_target` there by default from 2026-11-02" — a future date written as present; today it is 2026-11-02. Re-word to the present ("GitHub blocks ... by default").
- (b) Levers: **sediment**, **relevance**, **no-ops**, **negation** (3).
- (e) Risk. Tests: `tests/workflows.test.ts:7043-7080` forbids `gh label create "agent:in-progress"` and the other retired labels in CONTEXT.md (negative only; removing the mention passes). No test requires the retired names to be present in the prose. `tests/workflows.test.ts:6502` negatives (`slice PR` ...) still pass. CLAUDE.md:65 points at "CONTEXT.md's note on the toolchain-free auth step": unaffected here.
- (f) safe prune. (g) medium; roughly 3 KB (about 0.75k tokens) and removes two actively misleading lines (items 1 and 2).

---

### F7. The install-path section restates `docs/agents/changing-the-install-path.md` and ADOPTING §0, and its `doctor` list is a partial stale copy — MEDIUM — behaviour-affecting

- (a) `CONTEXT.md:693-736`; in particular L699-700 "`docs/ADOPTING.md` §0's table is the list of what it checks" followed at L724-727 by "`diagnose` rules on a **fixed list** — every grant ..., `self-check`, the labels, ... a time limit variable that is not a positive integer (#220)". `docs/ADOPTING.md:19-129` §0 is that list and also holds checks the CONTEXT list omits (merge caller, `synchronize` trigger, `AGENT_ORCHESTRATOR`, the domain-model file #611, retired labels, red-check half-configuration, pin freshness). `docs/agents/changing-the-install-path.md:12-31` already says, in the same words, that `init` copies once and `doctor` owns body drift (items 2 and 5). CLAUDE.md has a pointer for "Changing `init` or `doctor`" to that file.
- (b) Lever: **single source of truth** (three copies, the CONTEXT one oldest), **cache** of a list in `setup/doctor.ts` / ADOPTING §0, and **disclosure** (CLAUDE.md already routes install-path work to a topic file).
- (c) Why it matters: an agent adding a `doctor` check reads a "fixed list" that is incomplete and concludes the omitted checks are not there; one reading L699 gets the right answer and L724 a contradicting one.
- (d) Proposal. Keep L693-707 (the idea: `init` and `doctor` are subcommands a human runs, not a fourth part; `init` moves the pin and changes nothing else; drift inside a caller is `doctor`'s to name) and the last paragraph (L733-735, "they ship in the same package on purpose"). Delete L708-722 (the App-manifest flow, `--app`, `--service`, the TTY question: code detail in `setup/app.ts` and ADOPTING §2) and L724-731 (the fixed list, with the rationale for not diffing callers, which `changing-the-install-path.md` item 5 already holds). Target about 14 lines / 1.4 KB, from 44 lines / 3.9 KB.
- (e) Risk. The glossary row `Install path` links `#and-the-install-path-which-is-none-of-the-three`; keep the heading. Tests: none reads the section. Check `docs/agents/changing-the-install-path.md` carries the "App manifest flow" fact before deleting (it does not today; it lives in ADOPTING §2 "The loop's App", `docs/ADOPTING.md:303`).
- (f) behaviour-affecting. (g) medium (about 2.5 KB, about 0.6k tokens, and removes a contradiction).

---

### F8. The glossary's pointers are weak where they matter, and a quarter of it is noise — MEDIUM — behaviour-affecting

- (a) Rows and cells:
  1. `CONTEXT.md:60` "`self-check`, rescue branch | Two invariants nothing fails on" links `Invariants with no runtime symptom`, which holds nine bullets (L959-998). Seven branches have no trigger: `bin` starting with `./`, the `assets/severity-*.svg` rename, `timeout-minutes` cancel-not-fail, a label set at issue creation, a `GITHUB_TOKEN` label add, the toolchain-free Authenticate step. CLAUDE.md:65 reaches the last by name; nothing reaches the rest.
  2. 25 Section cells read "[What this is](#what-this-is)" (F2). Section cells total 2,404 bytes.
  3. Avoid cells hold behaviours as well as words: `CONTEXT.md:18` "reading the next slice off which issues are closed", `:26` "reading that off who authored the commits", `:17` "a branch or a pull request per slice; a stack", `:35` ""test-first check" anywhere but the body", `:34` "the loop arming". A reader cannot "use" these as vocabulary; they are rules, and they name the forbidden action.
  4. Meta rows: `Domain model` (L61, "This file", Avoid `GLOSSARY.md`) and `Narrative log` (L62) are not domain terms. The first is a no-op once the file is read; the second is a docs convention CLAUDE.md already states ("`docs/friction.md` is a dated narrative log. Append; never rewrite").
  5. Terms the file defines in bold but the glossary lacks: dispatcher, worker, job (kind), scan (all F5 content), and "the three ways on" (spelled out twice, L251-252 and L272-273).
- (b) Levers: **context pointers** (trigger wording; "one trigger per branch"; "cut identity the body already carries"), **leading words** (the triad "decline a finding by replying to it, then `agent:review`; or push a commit, then `agent:review`" spelled twice is a passage that wants a token), **negation**.
- (c) Why it matters: the glossary is the only pointer layer; a gotcha with no trigger is read only by the agent that happens to read the whole section, which is the sprawl the glossary exists to avoid.
- (d) Proposal.
  1. Row `Invariants with no runtime symptom`: `| Silent invariants | Facts nothing fails on when they break: before renaming \`assets/severity-*.svg\`, editing \`bin\`, adding a \`failure()\`-gated step, creating a label in the same call as the issue, adding a label with the workflow token, or adding an input to the Authenticate step | | [Invariants](#invariants-with-no-runtime-symptom) |`
  2. Section cells: after F2, each row links its subsection.
  3. Recast Avoid cells as the word: `Slice range | ... | next slice by closed issues` -> keep Avoid for words only (`stack`, `layer`, `agent:in-progress`, `auto-fix`); move the behaviours into the section as positives ("the next slice is the first open sub-issue with no range", already at L99-101).
  4. Drop rows `Domain model` and `Narrative log` and their two sections' glossary links (see F13).
  5. Add `Dispatcher`, `Worker`, `Job` as three one-line rows linking the service section, and `Three ways on` (one phrase, defined once at the park/advance paragraph).
- (e) Risk. `tests/context-md.test.ts`: header must read exactly `| Term | Means | Avoid | Section |`; each row has exactly 4 cells, a non-empty term and meaning, and a `](#...)` link in the 4th; more than 10 terms; every `##` heading below the glossary is linked by some row, and every `#` link lands on a heading. Deleting `Domain model` / `Narrative log` is only safe together with deleting the two `##` sections or keeping a row for each (F13). `docs/agents/domain.md` requires the words "`## Glossary`" and "*Avoid*" to be present, which stays true.
- (f) behaviour-affecting (edits the pointer layer). (g) medium.

---

### F9. One concept is stated several times inside the file — MEDIUM — safe prune

- (a) Examples with lines:
  - The usage-limit exception to "the label comes off in the run's last step" (#635): `CONTEXT.md:152-156`, `:166-168`, `:174-176` — three times in 25 lines.
  - "The three ways on" (`agent:fix`, decline-by-reply then `agent:review`, push then `agent:review`): `:251-252` and `:272-273`, spelled out twice.
  - The arm: glossary L34 and L33, table row L77, `:283-287`, `:289-302`; plus ADR 0009 and `docs/ADOPTING.md:695-757` (the *merge decision* subsection) which holds the same lifecycle.
  - The fix-round budget: glossary L24, `:109-111`, `:227-241`, `:247-252`, again on the service at `:821-823`.
  - The progress list: glossary L21, `:124`, `:274`, `:461-466`.
- (b) Lever: **single source of truth** ("inflates a meaning's prominence on the ladder past its real rank"); and **leading words** (restatements that a token retires).
- (c) Why it matters: a rule stated three times is edited in one place when it changes; this file has the history to show it (the #635 exception was added to three places and L153's "except a run the plan's usage limit stopped on the service" still needs the next reader to find all three).
- (d) Proposal. State each once at its home subsection (F2) and refer by term: lifecycle exception once in `### A trigger label is on while its run works`; "the three ways on" defined once with a bold lead word, then used as the token; the arm once in `### Update-branch and the arm`, with the table row and glossary row left as the two short pointers.
- (e) Risk. `tests/workflows.test.ts:6469-6471` needs the `**advance**` paragraph to contain `second arrow`, `**parent**` and `**bounded by the number of sub-issues**`: do not touch those words. No test pins the #635 sentences or the other restatements (grep of `tests/` for `usage limit`/`three ways on` in `CONTEXT` context returns nothing).
- (f) safe prune. (g) medium (about 1 KB).

---

### F10. Related rules sit far apart; the fix-round system and the follow-ups system are each scattered over 150+ lines — MEDIUM — behaviour-affecting

- (a) Fix rounds: budget `:227-241`, early stop `:247-252`, draft state `:259-261`, advance/park `:263-281`, the round-scoped budget on a PRD PR `:109-111` and `:236-241`, the fix threshold `:386-406` (160 lines after its first use at `:231` "(`AGENT_FIX_MIN_SEVERITY`, below)"). Follow-ups: the out-of-scope note `:349-360`, minor findings `:396-399`, the cap `:530-532`, the two kinds `:534-546`, the checklist `:513-521`. Arm: `:77`, `:283-302`.
- (b) Lever: **co-location** ("keep a concept's definition, rules, and caveats under one heading ... scattered material does not read like documentation"). Also the `**And ...**` paragraphs (`:313`, `:323`, `:332`, `:349`, `:362`) are the narrative of a single design (PRD #109 decisions 1-10) interleaved with unrelated topics.
- (c) Why it matters: a reader who finds "budget" at L227 has to know to look at L386 for the threshold that decides whether a round starts at all, and at L109 for the PRD-PR variant; a partial read yields a wrong model (reading budget without threshold gives the "every finding a thread" behaviour that was true before #616).
- (d) Proposal: the F2 slices are drawn along these lines; additionally move `:386-406` (the fix threshold) next to `:227-261` under `### Fix rounds`, and `:349-360` + `:396-399` under `### Follow-ups`. Do the reordering in the same commit as the headings, with no rewording, so the diff is a pure move.
- (e) Risk. Pure moves of paragraphs: `tests/workflows.test.ts:6460-6475` finds the `**advance**` paragraph by splitting on `\n\n`, so keep it as one paragraph. Nothing else.
- (f) behaviour-affecting (changes the order an agent reads). (g) medium.

---

### F11. In the review-body, PR-body and follow-up paragraphs the file restates what the code and the spec already pin — MEDIUM — behaviour-affecting

- (a) `CONTEXT.md:362-371` the exact order of the review body ("the round header, `## Agent review`, the assessment, one sentence ..., the step, a count, then *Open*, *Minor findings* (#616), *Previously missed*, *Still open* ... *Notes from `agent:fix` not filed*, then *How this was checked*, then a rule and the run"); `:457-494` the frame in order with every marker; `:534-546` the follow-up payload (`kind`, exempt prefix, cap, key).
- (b) Lever: **environment as source of truth** / **cache** — the order is defined in `review/publish.ts`, tested in `tests/review/publish.test.ts` and `tests/review-output.test.ts`, and written for people in `docs/ADOPTING.md:1024-1146` ("Reading the review body"); the markers are in `docs/platform-spec.md` §4.3 (11 mentions) and `shared/record.ts` (8). Cache what the agent cannot find by looking: here it can find it in one file.
- (c) Why it matters: when the layout changes the CONTEXT copy is the one nobody edits (L371 already lists the groups in an order that ADOPTING also lists; two lists of 11 headings). The reasons in these paragraphs are worth keeping (the frame is written once so a maintainer's notes survive; a thread-less finding cannot be declined; why `testSketches` cannot add a test).
- (d) Proposal. In `:362-371` and `:457-494` keep the sentences that say **why** and the invariants (frame written once, only the summary block rewritten; severity decides one thing; an entry carries an id iff it has no thread) and delete the ordered inventories, replacing them with "the layout is `docs/ADOPTING.md` *Reading the review body*, built in `review/publish.ts`". About 5-6 KB.
- (e) Risk. No test pins these sentences. Real risk is dropping a rule that only lives here: before deleting, diff each sentence against ADOPTING §3b and `docs/platform-spec.md` §8 (review) and keep those it does not hold. Moves with F3 if F3 is done.
- (f) behaviour-affecting. (g) medium.

---

### F12. The "**And ...**" chain reads as a decision log, so its paragraphs do not stand alone — LOW — safe prune

- (a) `CONTEXT.md:304`, `:313`, `:323`, `:332`, `:349`, `:362`: "**And a maintainer's decision outranks both** (#109, decision 10)", "**And in the fix half it is a direction rather than a ruling** (PRD #101, decision 5)", "**And an outcome is owed ...** (#104; decision 6, superseding #3)". Also 129 issue-number mentions in total (76 in this section), including "decision 6, superseding #3" which names a decision in a closed PRD an agent will not open.
- (b) Levers: **co-location / reads like documentation written for the agent**, **sediment** (decision numbers and supersession trails are provenance, not instruction).
- (c) Why it matters: "And" and "both" refer to a neighbour the agent may not have read (an agent that reads only the glossary link for *Finding* lands on "And a maintainer's decision outranks both" with no antecedent). Issue numbers cost few tokens, but the supersession notes ("superseding #3", "decisions 8 and 9") ask the reader to resolve references that are all closed.
- (d) Proposal. Give each paragraph its own lead noun phrase instead of "And ..." (for example `**A maintainer's decision outranks the reviewer's.**`), drop the "decision N / superseding #M" trails, and keep at most one issue number per paragraph, for the behaviour's origin.
- (e) Risk. None pinned (the `**advance**` paragraph at L263 is not in the chain). Wording only.
- (f) safe prune. (g) low.

---

### F13. The closing pointer table is where the agent never gets to, repeats `domain.md` and CLAUDE.md, and carries a no-op — LOW — safe prune

- (a) `CONTEXT.md:1009-1024` ("Where the rest is written down" table, then "`friction.md` is a **narrative log** ... Do not edit history into it."); `CONTEXT.md:1000-1007` ("The prompts name no domain").
- (b) Levers: **context pointers** (a pointer table at the end of a 1024-line file is reached last; each row says what a file is, not when to read it), **single source of truth** (`docs/agents/domain.md:36-51` "Where the decisions currently live" lists the same files; CLAUDE.md already says friction.md is "append; never rewrite"; `docs/agents/domain.md` already says "Prompts name no domain" and a test enforces it), **no-ops**.
- (c) Why it matters: the table lacks `docs/deploying-the-service.md`, `docs/adr/` and `docs/self-hosted-runners.md`, files other sections of this document link to; and two of three narrative-log statements are no-ops for an agent that has read CLAUDE.md.
- (d) Proposal. Move a 6-row version of the table to the top of the file (after the one-line intro, F1) with triggers in the leading words: `**Platform contract** (what a runner reads and returns): docs/platform-spec.md. **Service**: docs/deploying-the-service.md. **Adopter-facing behaviour**: docs/ADOPTING.md. **Decisions**: docs/adr/. **Why something was decided**: docs/parity.md §10, docs/friction.md.` Delete the narrative-log paragraph and `The prompts name no domain` (keep the one fact that is not elsewhere: "the verify command `CLAUDE.md` names" — already in domain.md).
- (e) Risk. `tests/context-md.test.ts` "links to every section below it" fails if a `##` section is deleted while a glossary row still links it, or conversely if a `##` stays unlinked: delete the sections `Where the rest is written down` and `The prompts name no domain` together with the rows `Narrative log` (L62) and `Domain model` (L61). A pre-existing sandcastle test enforces the prompts rule independently of this file.
- (f) safe prune. (g) low (about 1.2 KB, but it also fixes a pointer placement).

---

### F14. `Orchestrator, the record and the agent` is a verbatim copy of `docs/platform-spec.md` §1 — LOW — safe prune

- (a) `CONTEXT.md:679-692` "Three terms ... worded as `docs/platform-spec.md` §1 words them. The spec is their home; these are here so the glossary and the contract use one vocabulary." The spec's `## 1. Terms` (`docs/platform-spec.md:59-80`) holds the same definitions in the same words.
- (b) Lever: **single source of truth** (the file says so itself); it also holds the stale line F6.1.
- (c) Why: two copies of the definition that the glossary rows (L49-51) already say in one line each.
- (d) Proposal. Replace the three bullets by one line: `Defined in [docs/platform-spec.md](./docs/platform-spec.md) §1: **orchestrator**, **record**, **agent**.` Keep the heading so the three glossary rows keep a target.
- (e) Risk. Tests: none reads it; the three glossary rows link `#orchestrator-the-record-and-the-agent` (keep the heading).
- (f) safe prune. (g) low (about 0.6 KB).

---

## Count

14 findings. By class: **safe prune 6** (F4, F6, F9, F12, F13, F14); **behaviour-affecting 8** (F1, F2, F3, F5, F7, F8, F10, F11). By priority: **high 5** (F1, F2, F3, F4, F5); **medium 6** (F6, F7, F8, F9, F10, F11); **low 3** (F12, F13, F14).

## Suggested order of work

1. **One commit, no behaviour change:** F1, F4, F6, F9, F12, F13, F14 (all safe prune plus the one-line F1 fix). Pins to change: none.
2. **F2 + F10 + F8:** headings, reorder and glossary retarget. Pins to change: none in `tests/`; keep `Review adds a trigger label in two cases.`, the `**advance**` paragraph, the table rows and the five bold terms intact. `npm run verify` is the gate.
3. **F5 + F7 + F11:** cuts of live but duplicated content, each checked sentence by sentence against the file that holds the copy.
4. **F3 only if** phase 2 reads still show the review/fix runs carrying material they do not use. It changes two prompts and two tests, and CLAUDE.md requires the golden-PR eval run (before and after) for a review or fix prompt change.

## Proposed target structure (estimates, 4 chars per token)

| Part | Lines now | Bytes now | Lines after | Bytes after |
|---|---|---|---|---|
| Intro + 6-row pointer table (F1, F13) | 5 | 0.4k | 12 | 1.5k |
| Glossary (F8: section cells, 3 new rows, 2 dropped) | 57 | 10.0k | 56 | 8.5k |
| What this is: label table, issue shape, PRD chain, round header, trigger-label lifecycle, one order (L66-179) | 114 | ~10.5k | 105 | ~9.5k |
| What this is: summary of review/fix round shape + pointer (new, F3) | - | - | 12 | 1.5k |
| What this is: review/fix internals L181-546 | 366 | ~32.6k | to `docs/agents/review-and-fix-rounds.md` (about 330 lines / 28k after F9, F11, F12) | |
| The three parts (F4) | 131 | 10.7k | ~105 | ~8.2k |
| Orchestrator/record/agent (F14), composite (keep) | 21 | 1.3k | 9 | 0.7k |
| Install path (F7) | 44 | 3.9k | 14 | 1.4k |
| Service orchestrator (F5) | 101 | 9.3k | 14 | 1.4k |
| Trust boundary, split, identity, base-controlled, pin (F6.4, F6.7) | ~98 | ~8.3k | ~90 | ~7.5k |
| Invariants (keep; reword pointer, F8) | 45 | 3.6k | 45 | 3.6k |
| **Always-loaded core CONTEXT.md** | **1024** | **92.4k (23.1k tokens)** | **about 470** | **about 44k (11k tokens)** |

Estimated per-run saving (reading behaviour as the prompts now set it: glossary, then sections the change touches):

- **Whole-file read** (interactive session, or an adopter repo with no glossary): 23.1k -> about 11k tokens, a saving of about 12k (about 50%).
- **`implement`, `implement-prd`, `update-branch` runs** (after F2 alone): glossary 2.5k + `What this is` 10.8k + one other section, about 14-15k tokens; after F2, glossary 2.1k plus two or three 0.4-1.5k subsections, about 4-5k. Saving about 9-10k tokens per run.
- **`review` and `fix` runs**: F2 alone saves about 4-6k tokens (they read the subsections they touch instead of the whole section); with F3 they read the disclosed file by subsection, which costs about what they read now minus the prunes (F9/F11/F12, about 2-3k), so the saving there is smaller, about 5-7k in total.
- Net effect of F4, F5, F6, F7, F9, F11, F12, F13, F14 on the whole file: about 18-20 KB (about 4.5-5k tokens) with no loss of a rule.

These are estimates: the token counts use 4 characters per token, and the per-run figures assume the reads the prompts and the glossary links send an agent to, which I did not measure from run transcripts (`docs/profiling.md` describes how to).

## Not found / checked and fine

- No glossary link is broken; the context-md test covers that.
- The `Invariants` and `Why reusable workflows` sections are short, carry reasons, and have no duplicate elsewhere I could find.
- Cited issue numbers: all 98 resolve; 96 are closed or merged, and the two open (#68, #305) are cited as open decisions, so none is a dangling "pending" reference, with one exception: #224 is closed but still used as the live removal handle in code comments (F6.2).
- `docs/agents/domain.md` and the four runner prompts match the glossary-first policy; the only contradicting pointers are CONTEXT.md:3 and CLAUDE.md:22 (F1).
- Hazard I did not verify: at about 23k tokens the file may be at or over a single `Read` call's output ceiling for an agent that follows the prompts' "where it has no glossary, read it whole" branch; this audit read it in four chunks.
