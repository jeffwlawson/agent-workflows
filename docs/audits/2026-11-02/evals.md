# Audit: agent-workflows evals vs the skill-creator method

Read-only. No eval was run, nothing in the repo was touched. Repo state read at `origin/main` `c53531d`.

Evidence base, beyond the files and PR comments you listed: the 16 `claude plugin eval` result files still on this machine at
`/tmp/prompt-evals-{review,fix}-*/result.json` (78 review runs, 27 fix runs, about $110 of spend, 2026-11-01 to 11-03). They hold per-run
grader votes, cost, turns, and the judge's input (the last message for review, the trace capped at 100,000 characters for fix). I analysed
them offline. Most of the sharpest findings below come from them, not from the PR comments. They sit in `/tmp` and will vanish.

---------------------------------------------------------------------

## 0. The short version

1. **The `fix` eval cannot measure what its graders say.** In 26 of 26 completed fix runs the agent's final message says it could not commit
   (`Unable to create '.git/index.lock': Read-only file system`) and could not run tests (`node_modules` has no `vitest` or `tsc`). Fix grader
   01 ("the run commits a change...") passed 1 of 26 times, and that one pass is a lenient judge. Graders 02 and 03 ("the committed change...")
   are graded on uncommitted work. The #700 verdict ("test-first paragraph made grader 02 fall 7/9 to 2/9") rests on this harness; see 3.2 for
   why that reading is doubtful.
2. **With 3 runs per arm no result can reach p < 0.05.** The best case, 3/3 vs 0/3, has two-sided Fisher p = 0.10. "Within noise" is
   not a finding; it is what the design guarantees. To detect the swings we actually care about you need 13 to 39 runs per arm per grader.
3. **7 of the 15 graders cannot move in one direction** (5 are 0 on every near-identical prompt, 2 are at ceiling). Of the 8 that can, 5 moved
   between near-identical prompts. Several others pass for the wrong reason (restart-order 04 passes on any blocking finding, real or spurious).
4. **Nothing is stored.** Reports print pass counts; the runs behind them live in `os.tmpdir()`. A comparison cannot be re-derived, pooled, or
   re-graded. Pooling is what the team has been doing by hand (4/9 vs 0/9; 7/9 vs 2/9), post hoc, with no rule.
5. **Coverage:** about 18% of `review/prompt.md` (the whole fix-round and carried-state branch, about 6.8 KB of 38 KB) is gated behind inputs `suite.yaml`
   sets to "none". `implement`, `implement-prd`, `update-branch`, the extraction half, scope creep, glossary path, verification pass and a
   `fix` decline/clean case have no case.

Both big wins are cheap: fix the fix harness, and store results so a `compare` can pool and test them.

---------------------------------------------------------------------

## 1. The best practice (skill-creator)

Source: `.../skills-plugin/.../skills/skill-creator/` (`SKILL.md`, `agents/{grader,analyzer,comparator}.md`, `references/schemas.md`,
`scripts/{aggregate_benchmark,run_loop,run_eval}.py`). The installed marketplace copy is an older revision (`evals.json` instead of case folders);
I used the newer one. Our `evals/` layout already follows its case-folder schema (`case.yaml` v1.1, `graders/NN.md` with `type/focus/weight`).

**A test case.** One folder per case: `prompt.md` (what a user would type, run limits in frontmatter), `case.yaml` (name, `expected_outcome`),
`graders/NN-name.md` (one verifiable statement each), `files/` (inputs). "2-3 realistic prompts", then more at scale.

**With vs without.** Every case is run in both configurations, *spawned in the same turn* ("don't spawn the with-skill runs first and then come back for
baselines later"). New skill: baseline is no skill. Improving a skill: `cp -r` a snapshot of the old skill first and run it as `old_skill`. The delta is
"first configuration minus the second", with mean and stddev over runs (`aggregate_benchmark.py`, sample stddev, `run-1/run-2/...` directories).
Iterations live in `iteration-N/`, each with its baseline; the next iteration reuses the same case names.

**Assertions.** "Objectively verifiable, descriptive names", worded "about the result itself". Subjective outputs get human review, not forced
assertions. Prefer a script for anything checkable in code. Grader rules: PASS needs evidence of genuine substance; "when uncertain, the burden of
proof to pass is on the expectation"; no partial credit; extract and verify implicit claims; **critique the evals**: flag an assertion that "would also
pass for a clearly wrong output" and any important outcome no assertion covers.

**Variance and quality of assertions.** The analyzer pass looks per assertion for: always passes in both configs (non-discriminating), always fails in
both (broken or beyond capability), passes with and fails without (skill adds value), fails with and passes without (skill hurts), highly variable
(flaky). It also flags outlier runs, cost/time trade-offs. Notes go into `benchmark.json`. Default is 3 runs; the description-trigger loop uses 20
queries, 3 runs each, a 60/40 train/held-out split stratified by should/should-not trigger, a 0.5 trigger threshold, and selects the best
description by **held-out** score "to avoid overfitting".

**Blind comparison.** `comparator.md`: two outputs labelled A/B, a rubric (content, structure, 1-5), assertion pass rates only as secondary evidence;
then `analyzer.md` unblinds and explains why the winner won. Optional, for "is the new version actually better?".

**Human review.** A viewer shows each output with its grades and previous iteration; feedback is collected per run; read transcripts, not just outputs.

**What it does not say.** There is no significance test, no power calculation, no rule for when to run more. It reports mean +/- stddev and leaves the
judgement to a human who is looking at the outputs. The significance and sample-size rules in section 4 are mine, not the skill's.

**`writing-for-agents`.** The no-op test "is model-relative, not reader-relative: two people disagreeing about a no-op disagree about the default, and settle it
by running the document, not by debate." That is the case for evals at all, and also the case against `toContain(sentence)` prompt tests (they prove
the sentence is there, not that it does anything).

---------------------------------------------------------------------

## 2. Where we match and where we diverge

| Skill-creator practice | Ours | Gap |
| --- | --- | --- |
| Case folders, one grader per file | Yes (`case.yaml`, `graders/NN.md`, layout test) | none |
| Baseline in the same session | Only in the 6-run "targeted checks" (#697, #700). The 3-run comparisons reuse an earlier "before": #689 vs `baseline.md`; #697's "before" is #689's "after" run (identical numbers), taken about an hour earlier | partial |
| Snapshot of the old version as the baseline | Git blob hash in the report; `baseline.md` is a frozen reference | `baseline.md` goes stale with each prompt or Claude Code change |
| Mean +/- stddev, per-run records | Pass counts only; runs not stored | **missing** |
| Analyzer pass (non-discriminating, flaky, correlated assertions) | None; the team spots them by eye after the fact | **missing** |
| Grader critiques the evals | None | missing |
| Blind comparator | None | optional |
| Held-out set | None. Cases double as tuning targets: #697's fifth "kind of basis" was added after the `persisted-checkout-token` drop and then re-measured on that same case | missing |
| Human reads transcripts | Not systematic; #700 says "reading the traces would confirm or rule it out" and nobody did | missing |
| Description-trigger evals | None for `merge-check` (the only model-invoked skill) or for the CLAUDE.md "read before a change of this kind" pointers | missing |
| Parallel spawn | `claude plugin eval -j/--concurrency` exists (1-8, default 1); `eval-prompts.ts` does not pass it. Review suite takes 23-27 min sequentially | missing |

---------------------------------------------------------------------

## 3. Findings from the stored runs

### 3.1 Grader inventory (pooled over the four full runs of near-identical prompts, 12 runs each; fix likewise)

"Live" = neither always 0 nor always 3/3 across the near-identical runs.

| Grader | Pooled | Per-run counts | Verdict |
| --- | --- | --- | --- |
| review `clean` 01 no blocking finding | 10/12 (13/15 with the glossary runs) | 2,2,3,3 | Live. The only precision guard. One case, so a "false-finding rate" cannot be separated from that PR (3.4) |
| review `clean` 02 recommends approval | 12/12 (15/15) | 3,3,3,3 | **Ceiling, redundant with 01.** Never discriminated anything |
| review `persisted` 01 raises persisted credential | 4/12; main-blob 6-run 2/6 | 0,1,1,2 | Live, best signal in the suite. Real defect, fixed in `e6c5824` |
| review `persisted` 02 it is a fix-before-merge finding and no approval | 3/12 | 0,1,1,1 | **Dependent on 01** (02 true => 01 true in every stored run; 02 never passed in the 26 runs where 01 failed). A conjunction; also encodes severity policy (a Low raised with "approve" fails it). Report P(02 given 01) instead |
| review `persisted` 03 raises skippable install check | 0/12; 6-run checks 2/6, 0/6, 1/6 | 0,0,0,0 | Floor on the 3-run reports; real defect (also fixed in `e6c5824`) |
| review `rescue` 01 deletes rescue before PR opens | 10/12 | 3,2,3,2 | Live, high; a regression guard |
| review `rescue` 02 second way the rescue loses commits | 2/12 | 0,1,0,1 | Live, low. It is already a *follow-up* upstream (#578); the grader accepts "finding or follow-up" |
| review `rescue` 03 no approval | 11/12 (14/15) | 3,3,3,2 | **Near ceiling, weak.** Passes on any blocking finding, not the right one |
| review `restart` 01 dispatcher restarted after worker fails | 0/12 | 0,0,0,0 | Floor. Real, fixed in `58a8c32`. Subtle shell-control-flow bug; no prompt reaches it |
| review `restart` 02 recovery advice cannot run | 0/12 | 0,0,0,0 | Floor. Real, fixed in `83d3f62`. Requires simulating the failure state |
| review `restart` 03 `curl -L` https to http | 0/12 | 0,0,0,0 | Floor. **The issue itself prescribes `curl -fsSL`** (`LINKED_ISSUE.md` line 21), so a review that follows the brief is right not to raise it. This is a hardening finding against the spec; it is the class the #697 basis rule threatens |
| review `restart` 04 no approval | 4/12 | 1,0,2,1 | **Weak.** In 5 of 15 runs 04 passes while 01-03 all fail: the review asked for changes for another reason |
| fix `rescue` 01 deletes rescue after PR open | **1/26**, 0/12 on pooled early runs | 0,0,0,0 | **Unpassable in this harness** (3.2). The finding text also dictates the fix ("Move the deletion to after `state.pr = pr; record();`") |
| fix `rescue` 02 adds a test | 5/12 early, 7/9 and 2/8 later | 0,0,2,3 | **Confounded** by hedging and uncommitted work (3.2) |
| fix `rescue` 03 touches nothing else | 11/12 | 3,3,3,2 | Ceiling; a legitimate scope guard but the case offers little temptation to creep |

Two more facts about the graders:

* **The golden list is a recall list for what the loop *missed*, not the set of real defects.** In 13 of 15 `restart-order` runs the review raises that the
  halves (`upgrade-unraid.sh:30`, `upgrade-box.sh:30`) hard-code `@jeffwlawson/...` while `upgrade.sh` honours `PACKAGE_NAME`. That text is still in the merged head `e87b79c`
  (`upgrade-box.sh:30`). No grader credits it; 04 passes on it. It is probably a real finding the eval throws away; if it is not real it is the
  false-finding rate and nobody counts it.
* **Selection bias.** Three of the four review cases exist because the production review missed them at that head, so they sit at or near 0 by
  construction. That is good for "does a change help" and useless for "does a change hurt" on those graders (nothing to lose).

Judge noise is not the problem: 19 of 312 grader-runs had split haiku votes (6%), against run-to-run variation of whole runs.

### 3.2 The fix harness (`evals/fix`, `evals/checkout.sh`, the replay note)

* **Commit is impossible.** All 26 completed runs say so (examples: "`.git` is read-only in this sandbox", "`Unable to create '.git/index.lock'`"). The edit tool
  writes the working tree; Bash cannot write `.git`. The replay note asks the agent to run `git diff origin/<branch>..HEAD`, which compares *commits*, so it prints
  nothing for uncommitted work. The judge then reads a raw JSONL trace and decides whether "the committed change" is satisfied.
* **Verify cannot run.** "This checkout has no `npm`" / "`node_modules` has neither `vitest` nor `tsc`" in the same runs. The prompt says "Run the verify command ... before
  committing" and, since #700, "run it on the given head, see it fail". Both halves of the fix prompt that depend on running things are unmeasurable, and
  the agents say so in the thread reply text.
* **Why #700's grader-02 drop is doubtful.** In every one of the 12 six-run completed runs the final message says a test was added (0 of 12 say "no seam", so the
  hypothesised escape was not taken). But 5 of 6 (and 2 of 2 in the 3-run) #700 final messages say "I never saw the new test fail", against 0 of 9 main runs.
  Grader 02 passed 7/9 on main and 2/8 on #700 (Fisher about 0.06 two-sided; the PR comment's "about 0.03" is the one-sided figure). The likeliest reading is that the new paragraph makes
  the agent *say* it could not watch the test fail, and the judge, reading "adds a test that fails if...", marks it down. That is a grader-by-harness artifact,
  not evidence that tests were written less often. Not proven: the final messages are the agents' own claims, I did not diff-check them, and the
  traces are truncated at 100 KB. The cheap check is to read the 8 stored #700 traces and re-grade them with a diff-based grader (3.5).
* The judge is given the raw stream-JSON trace (init events, timing metadata, every tool result) up to the cap. 3 of 6 fix traces hit 100,025 characters. Fix judge cost is
  $0.034 per run against $0.003 for review (last message only).

Whether the cause is the eval's bubblewrap profile, the `cp -R node_modules`, or PATH inside the sandbox, I could not determine. The symptom is certain.

### 3.3 Other mechanical points

* **Errored runs count as failures.** `report()` divides by `runs.length`, and `tests/evals.test.ts` encodes that (`3 (1 errored) ... 1/3 33%`). The #700 3-run had one run end with
  "You've hit your session limit" (a plan limit, not a prompt behaviour), so its "1/3" is 1/2 completed. The false-finding rate already uses completed runs;
  pass rates should too.
* **No concurrency**: the harness runs one agent at a time (`concurrency: 1` in every result file).
* **Cost**: measured $0.82 per review run including the judge (clean 0.53, persisted 0.64-0.78, rescue 1.0-1.5, restart 0.87-1.04), $1.72 per fix run. A 3-run pair
  is about $20 (review) and $10 (fix). The real constraint was plan usage: one fix run died on the session limit.
* **Reports hide per-run structure.** In the `persisted` 6-run reports 01, 02 and 03 show identical counts (2/2/2, 0/0/0, 1/1/1), but 03 passes in different runs from 01 and 02
  (per-run pass strings `110,000,000,110,001,001`), while 01 and 02 pass in the same runs. The counts alone look like one latent variable; they are two.

### 3.4 One clean case

Three of three clean runs with 0 failures is an upper 95% bound of 63% on the false-finding rate (1 - 0.05^(1/3)). Pooled across the stored full runs it is 2/15 (13%, 95% CI
about 2% to 40%) on one PR. To state "below 20%" with zero failures you need 15 clean runs, and to say anything about review in general you need several clean PRs,
not several runs of one.

### 3.5 What is cheap to do with the stored data

Judge cost is $0.003 per review run and $0.034 per fix run, so re-grading the whole stored corpus (78 + 26 runs) with any rewritten grader costs about $1.20. This is the only
way to test a grader change without paying for agents.

---------------------------------------------------------------------

## 4. Point-by-point recommendations

### (1) Assertion and grader quality

Skill-creator's rule is "an assertion that would pass for a clearly wrong output is worse than useless", and it asks the grader to say so. By that rule:

* **Remove or demote:** `clean` 02 (15/15 on every prompt, redundant with 01); `rescue` 03 and `restart` 04 as headline graders (they pass on any blocking finding;
  both ride along with the real graders). Keep a *single* per-case "blocking verdict" line in the report, not a graded outcome, or define it as "01 AND the review blocks".
* **Make dependent graders conditional.** `persisted` 02 should be reported as P(blocking | raised), because it is never true without 01.
* **Add the missing real finding:** a grader for the `PACKAGE_NAME`/hard-coded path (13 of 15 restart runs). If someone judges it not a defect, that is a false-finding
  count and should show in a "findings outside the golden list" column, not vanish.
* **`restart` 03 (`curl -L`):** the brief prescribes it. Move to an optional "hardening" bucket or drop; do not let a floor grader depend on a finding the issue contradicts.
* **Positive and negative controls for every grader**, run on saved text: the loop's real review comment at each pinned head is a known *negative* for the missed
  findings (it missed them; this is the pre-image of grader floors) and the merge-check comment that caught the defect is a known *positive*. For fix, the real fix commit
  (`ba76218`) is a known positive. A grader that fails its positive control is broken; one that passes its negative control is too loose. About $0.01 per control.
* **Fix-case graders rewritten** about the change, not the commit: "the working-tree diff moves `deleteRescue` below `state.pr = pr; record();`" (01), "the diff adds or edits a test whose
  assertion would fail with the old order, by reading it" (02), "the diff touches only..." (03). Read the diff, never infer from the agent's confidence. Better still, ask the
  replay note to print `git diff origin/<branch>` (the working tree, not `..HEAD`) in the final message and set `focus: last_message`. The judge then reads a few KB, not 100 KB
  of JSONL.
* **Rewrite 01-style grader text so it does not restate the finding's own remedy** (the fix finding names the exact line to move; 01 is a compliance check, not a skill test).
* **Balance the suite** (3.1): of 15 graders, 5 floor and 2 ceiling. Aim for at least a third with a baseline pass rate in [0.3, 0.8], tag every grader as *target* (we want it up) or
  *guard* (must not fall), and test each only one-sided in its useful direction.
* **Held-out cases.** Any case a change was tuned against (#697's fifth kind was added after `persisted-checkout-token`) is now training data. Mark such cases and keep at least
  one held-out case per prompt that the prompt author, human or agent, did not read while editing. The repo's own agents can read `evals/` in the checkout.

Size: cheap (grader text, a controls script). Issue: yes.

### (2) Baselines and with/without

* Fair before/after protocol (replaces the three lines in the README): (a) name the **primary** grader(s) and the guards in the PR *before* running; (b) run before and after in the
  **same session**, staged into one suite as `<case>@before` and `<case>@after` and run together with `-j 4` so they interleave in time, or alternate one run at a time (A B B A A B) so order and drift
  cancel; (c) same cases, `--runs`, `--model`, `--judge-model`, Claude Code version, **and grader file hashes**, refused otherwise; (d) the report prints both blobs.
* Reuse an earlier "before" only when prompt blob, model, Claude Code version, case and grader hashes all match, and treat it as a separate session (pool only after a homogeneity check;
  with 9 runs per side and one session each, a difference between sessions is invisible).
* `baseline.md` is a record of one session, not a baseline: it goes stale at every prompt or Claude Code change, and a pooled ledger (section 5, H2) does the job better.
* The 6-run checks done on #697 and #700 were the right shape: both arms fresh, same session. The 3-run reports were not.

Evidence that time confounds: fix grader 02 reads 0/3, 0/3, 2/3, 3/3, then 4/6 on four prompt revisions over about two days. The prompts differ, so this is not a noise estimate, but with no concurrent
baseline it cannot be attributed.

Size: cheap (docs, plus H3/H4 in section 5). Issue: yes, with the harness work.

### (3) Variance and sample size

Measured noise (your 5 of 15) is worse than it sounds: 7 of the 15 graders are pinned at 0 or 3/3 and cannot move, so 5 of the 8 that can did.

**Fisher exact, 3 runs per arm.** Smallest significant result at two-sided 0.05: none. 3/3 vs 0/3 gives p = 1/C(6,3) x 2 = 0.10; 2/3 vs 0/3 gives 0.40.
| runs per arm | smallest significant pairs (low -> high), two-sided Fisher p < 0.05 |
| --- | --- |
| 3 | none |
| 4 | 0 -> 4 |
| 6 | 0 -> 5, 1 -> 6 |
| 9 | 0 -> 5, 1 -> 6, 2 -> 8, 3 -> 8, 4 -> 9 |
| 12 | 0 -> 5, 1 -> 7, 2 -> 8, 3 -> 9, 4 -> 10, 5 -> 11, 6 -> 12 |

**Chance of a spurious "moved by two".** Two runs of the same prompt, X and Y ~ Binomial(3, p): P(|X - Y| >= 2) = 0.09 (p 0.17), 0.185 (p 0.33), 0.22 (p 0.50). With 10 live graders, the chance at least
one moves by two is 1 - (1 - 0.22)^10 = 92% (87% at p = 0.33). A grader "moving by two" in a report is the expected case, not a signal.

**Runs per arm for 80% power, 5% two-sided** (normal approximation n = (1.96 + 0.84)^2 [p1 q1 + p2 q2] / (p1 - p2)^2, and exact-Fisher by enumeration, which is larger at small n):

| Scenario | arithmetic | normal | exact | cost, review ($0.82) | cost, fix ($1.72) |
| --- | --- | --- | --- | --- | --- |
| 0.67 -> 0.33 | 7.84 x (0.221 + 0.221) / 0.1156 | 30 | 39 | $64 | $134 |
| 0.75 -> 0.25 | 7.84 x 0.375 / 0.25 | 12 | 18 | $30 | $62 |
| 0.78 -> 0.22 (fix 02 as measured on #700) | 7.84 x 0.343 / 0.309 | 9 | 13 | $21 | $45 |
| 0.44 -> 0.11 (`persisted` 01, main vs a 2/3 drop) | 7.84 x 0.344 / 0.109 | 25 | 32 | $52 | $110 |
| 0.44 -> 0.00 (`persisted` 01, #697's 4/9 vs 0/9) | | 10 | 14 | $23 | $48 |
| 0.67 -> 0.00 | | 4 | 9 | $15 | $31 |
| 1.00 -> 0.50 (guard falls by half) | | 8 | 12 | $20 | $41 |

(Cost = n x 2 arms x per-run cost, one case, one grader; other graders on the same case are free.) The problem is that real effects are mid-sized. To catch only collapses
(1.0 -> 0.5, 0.67 -> 0) 9 to 12 per arm is enough; to catch "falls by a third" you need 30+, which is not worth buying case by case. So: detect big effects cheaply, accept that small ones are
unmeasurable at this price, and say so in the report instead of "within noise".

**A stated rule.**
1. One pre-declared primary grader (or case-level bundle) per change, plus guards; every other cell is descriptive only. This removes the multiple-comparisons problem (about 12 live cells per report).
2. Stage 1: 6 runs per arm on the primary and guard cases. Stage 2, only if the primary or a guard has a two-sided Fisher p < 0.10: extend to 12 per arm (one more 6 runs on that case, not the whole suite).
3. Declare an effect only at p < 0.029 at either look (a Pocock boundary for two looks; the exact test is conservative, simulated type I error 1.3-1.4%). Simulated power: 94% for 0.67 -> 0.00, 50% for
   0.67 -> 0.17, 47% for 0.75 -> 0.25, 20% for 0.5 -> 0.17. A result between 0.029 and 0.10 after 12 per arm is "not shown", with the interval stated.
4. Errored runs are excluded from the denominator and re-run once; two or more errors on one side voids that side.
5. Pooling a previous session's runs is allowed only for the same blob/model/Claude Code/grader hashes and is labelled pooled; never pool *after* seeing a result to reach a boundary (the #700 pooled 7/9 vs 2/9 reached p about 0.06 only by adding the 3-run set; the 6-run set alone is 4/6 vs 1/6, p = 0.24).
6. The report prints the interval (Wilson or exact) and the Fisher p next to every compared pair, so "within noise" is a number.

Present practice is not anti-conservative (simulated: the 3-then-6, "extend if moved by two, flag at pooled p < 0.10" habit flags a null change only 0.5-3% of the time) but it is badly underpowered:
it flagged #697 (real or close to it, p = 0.08) and #700 (p about 0.06) as "suggestive", which is the most 9-per-arm can say.

The "6 on a case when 3 was ambiguous" extension is the right instinct; stage 2 above makes it a rule.

Size: cheap (docs, README). Issue: yes (fold into the protocol issue).

### (4) Gaps in coverage

What the replay cannot reach, by cause:
* `suite.yaml` fixes `HISTORY`, `OPEN_FINDINGS`, `SETTLED_FINDINGS`, `FIX_NOTES`, `CARRIED_FOLLOW_UPS`, `SINCE_BRIEF`, `RED_CHECK`, `CI_STATUS` to "none" strings. About 6.8 KB of the 38.4 KB review prompt
  (lines 99-213: the whole verification-pass branch) and its scoped diff (#698) is therefore never read by a case. `DIFF_SCOPE` is the whole-diff form, so #641/#698 are untested.
* Both the review's and fix's second (extraction) phase is skipped; the replay note stands in for it.
* `CONTEXT.md` in every case is the old one: no glossary (#695).
* No case contains scope creep; the #697 PR says so.
* No case for `fix`'s decline branch, maintainer-vs-reviewer precedence, class-of-finding rule, or minor findings; one `fix` case in total, with the answer written in the brief.
* `implement`, `implement-prd` and `update-branch` prompts (4.9 KB, 6.8 KB, 3.5 KB) have no case.
* Security-hygiene findings: only `persisted` (credentials) and `restart` 03 (`curl -L`, contradicted by the brief).
* The review and fix environment cannot run commands (65 of 78 review final messages say tests/shellcheck/etc. were not run; 26 of 26 fix runs could not commit or verify), so any prompt text that
  depends on running something is untested.

Ranked cases to add (cost per run is measured for review/fix on today's cases; new-case figures are estimates and unmeasured):

| # | Case | Cheapest build | Cost/run | Size |
| --- | --- | --- | --- | --- |
| 1 | **Verification pass** (#699) | Pick a real fix-round PR (#658, #662, #664) where the fix round introduced a bug the next review or merge-check found; or take a small real PR and add a synthetic regression in a fix commit. Render `HISTORY`, `OPEN_FINDINGS`, `PR_DIFF` (scoped) by calling the *production renderers* (`readPromptDiff`, the history renderer), not pasted strings, so it also kills drift. Graders: regression raised; no false finding on what the fix got right | $0.5-1.0 | medium |
| 2 | **Scope creep + explained difference** (#614) | Real: search merged PRs for "Differs from the issue" and review findings on unrequested behaviour. Cheaper: a synthetic pinned commit that adds one unrequested flag/behaviour on top of the clean case's head (#566). Add its mirror: a deliberate, explained difference that must *not* be a finding | $0.4-0.8 | cheap-medium |
| 3 | **Fix: decline / no-change case** | The loop's own "Declined" thread replies (look for `**Declined**` in the `agent-fix:conversation-outcomes` comments) give a real wrong finding with ground truth. Grader is deterministic: the working-tree diff is empty (no Edit/Write in the trace) and the reply says why. This is the **clean case for fix** | $0.8-1.2 | cheap-medium |
| 4 | **Glossary path** (#695) | A PR opened after #689, or a synthetic domain-model slip (conflating two glossary terms) on top of current `main`; run with and without the glossary sentence on the *same* base, glossary file present in both | $0.8-1.2 | medium |
| 5 | **Security-hygiene findings (2-3 cases)** | Find merged PRs whose follow-up fix hardened something (`persist-credentials`, `permissions`, token in logs, `pull_request_target` checkout); ground truth is the hardening commit. These are the class the #697 basis rule hurt, so they are the guard for any "name your basis" change | $0.6-1.0 each | medium |
| 6 | **More clean cases** (3-5) | PRs the loop approved that nothing later had to fix (same recipe as #566). Needed before a false-finding rate means anything | $0.5-0.6 each | cheap-medium |
| 7 | **Extraction half** | Feed the 78 stored first-phase final messages (already on disk) to the extraction prompt and check them with the real `reviewOutputSchema.parse` (free, deterministic): schema valid, finding count equals the message's, anchors on diff lines | $0.1-0.3 (extraction only) | medium; fidelity caveat: production resumes the session |
| 8 | **Pointer-reach / "does it read the right doc"** | Trace-only, `max_turns` about 6, deterministic `tool_used`/`tool_order` graders: given a one-line task, did the agent Read `docs/agents/changing-a-workflow.md` (and the right `CONTEXT.md` section) before editing? 10 queries x 3 runs. This is skill-creator's description-trigger loop applied to our context pointers | $0.1-0.3 | cheap-medium |
| 9 | **`update-branch`** | A pinned conflicted merge; grader compares the resolved file to the known resolution after normalising | $0.5-1.0 (unmeasured) | medium |
| 10 | **`implement`, `implement-prd`** | Blocked until the harness can run and commit (A1). Then a tiny issue with a deterministic outcome (files changed, test passes) | $3-10 (unmeasured) | large |

### (5) Harness (`scripts/eval-prompts.ts`, `evals/`)

| # | Change | Why / note | Size |
| --- | --- | --- | --- |
| H1 | Pass `-j/--concurrency` through (default 4); document the rate-limit trade-off | The flag exists in `claude plugin eval` 2.1.307. Review suite 23-27 min -> about 6-7 min. Cost unchanged. One fix run already died on the plan limit, so make the ceiling and the error handling real | cheap |
| H2 | **Persist runs** to `~/.cache/agent-workflows/evals/` (or gitignored `evals/results/`): `stage.json`, `result.json`, full traces (the stored `evidence` is capped at 100 KB), grader file hashes, model, Claude Code version, judge model, session timestamp. Key the ledger by (case, prompt blob, grader hashes, model, CC version) | Everything else builds on this. It makes pooling and re-grading possible | medium |
| H3 | `compare <before> <after>` | Side-by-side table with Fisher p and intervals per grader, primary/guard marking, refuses mismatched model/CC/grader hashes, prints completed-run denominators. Test with fixture `result.json` like the existing `report` test | medium |
| H4 | `ab <ref>` | Stage the prompt from a git ref (`git show <ref>:review/prompt.md`) and the working tree into one suite and run them together (`<case>@before/@after`), same session | medium |
| H5 | Noise/A-A mode | `noise <prompt> --runs n`: run the same blob twice and publish per-grader variance into the ledger; once the ledger exists the same-blob runs already on file give it for free | cheap (after H2) |
| H6 | Exclude errored runs from denominators; refuse a compare with errors | `report()` divides by `runs.length`; test encodes the old behaviour | cheap |
| H7 | Cost: `--estimate` from ledger averages (review $0.82, fix $1.72 per run), confirm over a threshold; keep the required `--max-cost-usd` | Prevents surprise at 12 per arm (suite: about $79 review, $41 fix) | cheap |
| H8 | Analyzer pass in the report | Per grader, flag always-0 / always-1 on both sides, dependent graders (02 given 01), splits by judge, outlier turns/cost. This is skill-creator's `analyzer.md` step 2, in code | medium |
| H9 | CI check that a prompt PR carries its comparison | When a PR diff touches `review/prompt.md` or `fix/prompt.md`, require a PR body or comment containing the report whose `blob` lines equal `git hash-object` of the base and head files. The report already prints the blob. Waiver label with a reason for docs-only edits. #689 shipped with "the before and after reports are still owed" | cheap-medium |
| H10 | Layout/hygiene tests with no model | (a) every grader has a stored positive and negative control that its verdict matches; (b) `suite.yaml`'s fixed strings equal what the real renderers return for the same state (today they were "read off the built modules when these cases were written", so they drift silently); (c) every case lists which prompt sections it reaches | medium |
| H11 | Fix the fix environment | See 3.2: make a commit possible or switch to working-tree diff; make verify runnable (or remove it from the replay prompt and say so) | cheap (diff route) to medium (sandbox) |
| H12 | Parse `--json` into a single `runs.csv` and keep the final message of every review run beside it | Humans read transcripts; skill-creator's whole review loop depends on it | cheap |

### (6) A cheaper first pass

What costs nothing or little, and what it cannot do:

* **Regrade saved outputs.** Re-judge stored last messages/traces with a changed grader: $0.003/run review, $0.034/run fix; the whole stored corpus is about $1.20. It validates graders
  (controls, rewrites) and measures grader noise (6% split votes). It cannot test a new prompt.
* **Static checks on the rendered prompt.** A size budget per prompt and per section (review is 38,441 bytes, about 9-10k tokens paid on every review; each #614/#641/#697 change adds to it), and a table of which
  eval inputs gate which prompt sections (3.1 coverage). Cheap, deterministic. It cannot say whether text changes behaviour; the existing `toContain(sentence)` tests only pin wording. Keep those for contract text the
  runner parses (`<promise>COMPLETE</promise>`), not for quality rules.
* **Short trace screens.** `max_turns` about 6 with free deterministic graders (`tool_used`, `tool_order`, `regex`, `file_exists`; the schema lists them): "did it read the glossary first, and only the touched sections?" for the
  glossary path (#695) costs pennies. I could not verify what the `regex` grader can target, so check before relying on it for the diff.
* **A smaller model for screening.** Run haiku or sonnet on the A/B for format and parse regressions only (final message shape, schema validity, a prompt that breaks an output tag). Do not use it for catch rates:
  capability differs, and a floor on a weaker model carries no information about opus. The cost ratio is unverified, so the saving is unquantified.
* **Pairwise blind comparison** (skill-creator's comparator) over saved outputs, randomised A/B, as a continuous tie-breaker for before/after quality (severity calibration, noise findings) that binary graders miss.
  $0.01-0.02 per pair. Limit: length and style bias; use as supporting evidence only (the comparator itself ranks assertions as secondary).
* **A deterministic grader for the one fix outcome that is code.** "`deleteRescue` runs after `state.pr = pr; record();`" is a property of `implement/publish.ts` after the run. If the working tree
  survives (`--keep-temp`), a script grader is free and has no variance. Unverified: whether `claude plugin eval` can grade a file after the run.

Honest limits: nothing here replaces running the model for a judgement-type change. These only cut the number of paid runs spent on broken graders, broken harness, or a prompt that does not parse.

### (7) Skills (`skills/evals/issues-to-prd`)

Good: the layout is exactly skill-creator's (`prompt.md`, `case.yaml`, `graders/NN.md`, `place-files.sh`, `Input files:` line); the environment is a fixed `world.md`, so it is deterministic and costless in the
world sense; cases are seeded traps with named issue numbers (#726 is a sub-issue, #724 has an outside blocker, #720/#722 point at code that does not exist, the stale brief names commits `5599f4c` and `bc02a23`);
graders are mostly objective; a case was added when a rule changed (#609, `published-prd-of-slices`).

Weaknesses against the method:

* **No baseline, no recorded run.** I found no result, no count, no `without_skill`/`old_skill` arm, and no mention of a run in `docs/friction.md` or the commit messages. 4 cases (about 19 graders) cannot show the skill adds value without a
  no-skill arm. Skill-creator's analyzer calls out "passes in both configurations".
* **Trivially satisfied graders under a "make no GitHub call" rehearsal prompt:** `single-issue-ready` 02 ("adds no label, posts no comment"), `stale-brief` 03, `published-prd` 03, and `set-into-prds` 06/08 largely hold for a no-skill run as well.
  `single-issue-ready` 05 ("does not create a PRD") likewise. Only a baseline arm shows which ones discriminate.
* **Invocation.** The skill is `disable-model-invocation: true` (slash only) and no `prompt.md` says `/issues-to-prd`. `claude plugin eval` against `skills/evals` also has no plugin to load, so the with/without ablation
  does not resolve. I could not tell how a run is meant to load the skill; the layout suggests skill-creator's subagent workflow (skill path given in the task), which does support `old_skill` snapshots and was not used.
* **No layout test.** `tests/skills.test.ts` only checks that `evals` is not a skill. `tests/evals.test.ts` covers `evals/` only, not `skills/evals/`. No guard that a case has graders or `world.md`.
* **`set-into-prds` is a 9-grader compound** with an ordered, specific plan (database-id ordering, which commands, which questions). One miss moves the pass rate by 11 points, so the case-level number is noisy, and graders 07/09
  depend on earlier ones (build only after a yes). It would serve better as 3 smaller cases (cluster, blockers, stale pointers).
* **Cost is unmeasured** (no run to read).
* `merge-check` has none, and it is the only model-invoked skill, so a description-trigger set (20 queries, 60/40 split, 3 runs, using `scripts/run_loop.py` as is) is directly applicable and cheap.

Recommendation: run each case once with the skill and once with `old_skill` (snapshot via `git show` at the previous commit) in the same session, 3 runs, using skill-creator's workspace layout, and keep the `benchmark.md` in `docs/`;
add `skills/evals` to the layout test; add 2 cases for `merge-check` (exact-head mismatch; a CI-skipped check) and a trigger set. Size: medium. Issue: yes (one).

---------------------------------------------------------------------

## 5. Ranked recommendations (value for cost)

| Rank | Recommendation | Size | Issue? |
| --- | --- | --- | --- |
| 1 | Fix the fix environment and graders: working-tree diff in the final message, `focus: last_message`, drop "committed", graders read the diff; then re-grade the 8 stored #700 traces before deciding #700 (H11, 3.2) | cheap | **yes** (and a comment on #700) |
| 2 | Persist runs + ledger + `compare` with Fisher p and pooled same-blob runs; errored runs out of denominators (H2, H3, H6) | medium | **yes** |
| 3 | Write the protocol into `evals/README.md`: declared primary/guard graders, same-session A/B, 6 -> 12 per arm, p < 0.029 rule, "not shown" wording (section 4.2-4.3) | cheap | **yes** (with 2) |
| 4 | Grader hygiene: delete `clean` 02, demote `rescue` 03 / `restart` 04, make `persisted` 02 conditional, add a `PACKAGE_NAME` grader, take `restart` 03 out or bucket it, controls from real review/merge-check/fix text | cheap | **yes** |
| 5 | `-j` concurrency pass-through (H1) | cheap | fold into 2 |
| 6 | CI check that a prompt PR carries a comparison with matching blob hashes (H9) | cheap-medium | **yes** |
| 7 | Case: verification pass built with the production renderers (#699) | medium | exists (#699); tie to H10(b) |
| 8 | Case: scope creep + explained-difference mirror | cheap-medium | **yes** |
| 9 | Case: `fix` decline/no-change, with a deterministic grader | cheap-medium | **yes** |
| 10 | Case set: security-hygiene findings and 3-5 more clean PRs (turns a one-case false-finding anecdote into a rate) | medium | **yes** |
| 11 | `suite.yaml` strings vs real renderers drift test; case-reaches-section map (H10) | medium | **yes** |
| 12 | Glossary-path case (#695) | medium | exists (#695) |
| 13 | Pointer-reach / trigger evals for the CLAUDE.md pointers and `merge-check` description | cheap-medium | **yes** |
| 14 | Skills: baseline arm (`old_skill`), layout test, trim trivially-satisfied graders, split `set-into-prds`, `merge-check` cases | medium | **yes** |
| 15 | `ab <ref>` single command; `noise` mode (H4, H5) | medium | fold into 2 |
| 16 | Extraction-half replay from the stored messages (schema graders) | medium | later |
| 17 | `update-branch` case | medium | later |
| 18 | Blind pairwise comparator over saved outputs | medium | later |
| 19 | Smaller-model screening | cheap | no; low value |
| 20 | `implement`, `implement-prd` cases | large | later, after rank 1 |

What the whole protocol costs (measured per-run figures): a typical change on one target case plus two guards and the clean case, 6 per arm, is 4 x 6 x 2 x $0.82 about $39 (review); stage 2 on one flagged case adds
6 x 2 x $0.82 about $10. A full-suite 12-per-arm review comparison is about $79, a fix one about $41. The current 3-per-arm pair is about $20 (review) and $10 (fix) and cannot return a significant result.

---------------------------------------------------------------------

## 6. What I could not verify

* The root cause of the fix environment's read-only `.git` and missing `node_modules` tools (eval bubblewrap profile, copy of `node_modules`, or PATH). I read symptoms in 26 transcripts' final messages and a few tool results.
* The judge's actual input. `result.json` stores an `evidence` string capped at 100 KB; I do not know whether the judge saw all of it or the same cut. No judge rationale is stored, only votes.
* Whether the #700 drop is a judge artifact. The hedging correlation (7 of 8 vs 0 of 9) is strong but rests on regexes over the agents' own final messages, not on diffs; traces were truncated and the 8 #700 traces
  were not read line by line.
* Whether `claude plugin eval`'s `regex`/`tool_used`/`file_exists` graders can target a post-run file or the trace. I only know the type names from `references/schemas.md`.
* Whether the 13/15 `PACKAGE_NAME` finding is a true defect. It is in the merged head; no one ruled on it.
* Costs for the new cases, `skills/evals` runs, and any smaller model: unmeasured.
* How `skills/evals` is meant to be run; I found no instruction, record or baseline.
* The `gh` calls for PR comments needed an unsandboxed read-only call (sandbox 401), per your memory note. Nothing was written.
* The Fisher figures are my arithmetic (exact enumeration); the sample-size table is for a single grader with independent runs and a fixed true pass rate. Real runs have case-specific heterogeneity I did not model.
