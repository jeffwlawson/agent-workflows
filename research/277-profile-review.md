# Profile review: where an agent-review run spends its time (#277)

*Research for the profiling map #267, 2026-10-02. Method from #267's Notes, using the session
transcript artifact from #269 (v0.7.8) in place of log scraping.*

## Data

- **Primary sample:** the 15 successful post-v0.7.8 `agent-review.yml` runs, all with an
  `agent-transcript` artifact: 37068666080, 37069032644, 37071086251, 37071906155, 37072388390,
  37073687371, 37075161025, 37075852680, 37076696359, 37077727868, 37078189836, 37078676441,
  37079623447, 37080530702, 37080726291.
  - Two runs reviewed PR #327 (an ordinary issue PR). Thirteen were slice rounds on PRD PR #330
    (PRD #314), so the sample leans towards PRD reviews.
  - All runs used Claude Code 2.1.288 (from the install step's log) and `claude-opus-5-5`, the
    default (from the `Agent model:` line). The runner was agent-workflows 0.7.8.
- **Baseline:** step timings from the jobs API for 230 earlier `agent-review.yml` runs, v0.1.2 to
  v0.7.8, plus the `ci.yml` run on the same head SHA for each run since v0.7.0.
- **Where each number comes from:**
  - Job and step times: `gh api repos/{owner}/{repo}/actions/runs/<id>/jobs`. These are rounded
    to whole seconds.
  - The split inside the agent step: the job log (`npm exec` start, the `agent-workflows 0.7.8:
    review` banner, `Agent model:`, and `Agent started` / `Agent stopped` for each phase).
  - Model time versus tool time: the transcript. Its `cost-state` records hold the totals
    (`totalAPIDuration`, `totalToolDuration`, `totalDuration`) after each phase. Each
    `tool_use` → `tool_result` pair gives one tool call's duration, and per-message `usage` gives
    tokens.
  - CI: the `ci.yml` run on the same head SHA. Its `Test` step is the suite. The per-file vitest
    times come from the log of CI run 37080522516.
- **Traps observed:** none of the #267 traps bit here. The transcript makes the log's hidden
  calls visible (in this sample the reviewer used only `Bash` and `ReportFindings`). All times
  are UTC.

## What a review run is

`review.yml` has five jobs.

- `time-limit` has no secrets and works out the timeout. `red-check` is off in this repo, so it
  was skipped in all 15 runs.
- `review` runs: pre-flight → checkout → installs → *Wait for other checks* → the agent. The agent
  has a produce phase, then a resumed extraction phase (`shared/run-with-extraction.ts`).
- `post-review` holds every write the run makes.
- `advance` runs on PRD PRs only.

The review is triggered at about the same moment as CI. The CI run is created a median of 5 s
before the review run. So the review's own setup overlaps CI, and **CI is on the critical path**:
in 13 of 15 runs CI was still running when the review reached its wait step. In the other two,
the review had been re-triggered on a SHA whose CI had already finished.

## Time breakdown

Wall clock is measured from the review run's creation to its last job's end.

- All 15 runs: median **164 s** (range 94 to 192).
- The review is posted (end of *Post PR review*) at a median of **148 s**.

The critical-path buckets below sum exactly to each run's wall clock:

| Bucket | Median (s) | Share of mean wall (all 15) | Share (13 runs where CI was live) |
|---|---:|---:|---:|
| **Before the wait:** `time-limit` job (about 6 s), queue (2 s), review setup (about 15 s: fix-round budget 3, checkout 2, Node 2, `npm ci` 2, Claude Code install 3, pre-flight 1) | 23 | 15.5% | 15.2% |
| **CI still running** after the review is ready | 31 (35 live) | 18.2% | 20.3% |
| **Poll slack:** CI finished, wait not yet noticed | 11 (16 live) | 8.3% | 8.8% |
| Agent step: runner install (`npm exec`) | 1.8 | 1.1% | 1.1% |
| Agent step: runner context fetch (`gh` reads, before the model) | 4.4 | 2.8% | 2.8% |
| Agent step: `claude` boot | 1.0 | 0.6% | 0.6% |
| **Agent step: model, produce phase** | 40.8 | 24.7% | 22.9% |
| Agent step: tools, produce phase | 2.4 (mean 5.5) | 3.4% | 3.8% |
| Agent step: produce → extraction handoff | 0.8 | 0.5% | 0.4% |
| **Agent step: extraction phase** (model only) | 5.7 | 4.0% | 3.6% |
| Review job tail (redact and upload transcript, three artifact handoffs) | 7 | 3.9% | 3.8% |
| Queue before `post-review` | 3 | 1.7% | 1.6% |
| `post-review` job | 14 | 8.4% | 8.0% |
| `advance` (queue and job; 13 PRD runs only) | 10 | 6.3% | 6.6% |

### Grouped

| Group | Median (s) | Share |
|---|---:|---:|
| **Waiting on CI** (CI still running, plus poll slack) | 42 to 51 | about 27% |
| **Model** (produce and extraction; the transcript's `totalAPIDuration`, median 45.6 s) | 46 | about 29% |
| **Tool calls by the agent** | 2.4 (mean 5.5) | about 3% |
| **Runner and `claude` start-up inside the agent step** | 7 | about 4.5% |
| **Writes and job handoffs after the agent** (review tail, `post-review`, `advance`) | 31 to 34 | about 20% |
| **Before the wait** (hidden behind CI in 13 of 15 runs) | 23 | about 15%, but not on the critical path |

### The CI wait

- **CI's own wall clock** (created to last job finished): median **64 s**.
  - `Test` is **45 s** of that (70%). The other steps: `npm ci` 2, Typecheck 3, Build 2, the
    manifest check 3, setup and checkout about 3.
  - Per-file vitest times in CI run 37080522516:
    - `implement-prd-preflight.test.ts`: 27.1 s
    - `review-ci-wait.test.ts`: 26.3 s
    - `workflows.test.ts`: 22.9 s
    - `agent-cli.test.ts`: 6.0 s
    - everything else: under 6 s each.
  - These are the three files Cut the test suite's wall clock (#271) targets.
- **The poll period is about 22 s**: `POLL_SECONDS: "20"`, plus about 2 s of API reads.
  - The wait noticed CI's end a median of 16 s late on the live runs (between 6 and 23 s).
  - The last CI job and the CI run's `updatedAt` are 1 s apart, so the lag is the poll, not
    GitHub.
- **Trend.** CI's Test step rose from a median of 10 s (9/24 to 9/28) to 14, 20, 30, 43 and 46 s
  (9/29 to 10/3). The review's CI wait followed it:

| Release | Runs | Wall (s) | Wait step (s) | Agent step (s) | CI ends, s after the review is triggered | CI Test (s) |
|---|---:|---:|---:|---:|---:|---:|
| v0.7.0 | 14 | 92 | 22 | 38 | 32 | 15 |
| v0.7.3 | 12 | 118 | 24 | 57 | 37 | 21 |
| v0.7.4 | 18 | 136 | 24 | 54 | 41 | 26 |
| v0.7.5 (adds `post-review`) | 16 | 148 | 26 | 60 | 40 | 28 |
| v0.7.6 (adds `advance`) | 15 | 163 | 46 | 62 | 48 | 36 |
| v0.7.7 | 14 | 130 | 25 | 54 | 49 | 38 |
| v0.7.8 | 15 | 164 | 47 | 62 | 60 | 45 |

  From v0.7.0 to v0.7.8 the review grew by about 72 s:
  - CI ending later: about 28 s.
  - A longer agent step: about 24 s. These are larger PRD diffs and more turns; turns correlate
    0.74 with model time.
  - The `post-review` and `advance` jobs: about 20 s.

### Inside the agent

- **Model time dominates**: `totalAPIDuration` has a median of 45.6 s, against a median of 2.4 s of
  tool time.
  - The reviewer takes 4 to 8 turns (median 6).
  - It writes about 3,900 output tokens (median).
  - The turn that writes the review takes a median of 13.6 s. Middle turns take about 5 s each.
- **Prompt size does not drive time.** The slice-round prompts on PRD PR #330 grew from 106k to
  270k input tokens across the sample, because the PR DIFF section went from 208k to 563k
  characters. Yet the first turn still answered in 2 to 4 s. Prompt tokens correlate 0.21 with
  model time and **0.98 with cost**: $1.2 rising to $2.9 per review. See *Side findings*.
- **Tool time is almost entirely the reviewer's own targeted vitest runs.**
  - There were 11 such runs, in 11 of the 15 reviews. They took 76 s of the sample's 83 s of tool
    time, with a median of 4.1 s each and a maximum of 18 s.
  - The prompt's *What to check* item 4 asks the reviewer to run things, so this is behaviour,
    not waste.
  - `git`, `sed` and `grep` calls take about 0.05 to 0.4 s each.
- **The extraction phase** re-emits the verdict as the `<output>` block, and takes 5.7 s (median),
  with about 620 output tokens.
  - The resume itself costs 0.8 s.
  - This is the deliberate "think, then format" split documented in `shared/run-with-extraction.ts`.
    It is shared with fix and update-branch.

### Overhead from the job split

The `time-limit` → `review` → `post-review` → `advance` split costs the following:

| Piece | Seconds | On the critical path? |
|---|---:|---|
| `time-limit` job and queue before `review` | about 8 | No, in 13 of 15 runs (hidden behind CI) |
| Artifact handoffs at the review job's end (review, park, outcome) | about 3 | Yes |
| Transcript redaction and upload (#269, not the split) | about 2 | Yes |
| Queue, set-up and artifact fetch for `post-review` | about 5 | Yes |
| Queue, set-up and artifact fetch for `advance` (PRD only) | about 5 | Yes |

**About 8 s on the critical path for an ordinary PR, and about 13 s (8%) for a PRD round.** The
split exists to keep every write token off the agent's runner (#257, #316). It is a guard, so it
stays.

## Candidate changes

The constraint is the map's: nothing that removes a guard or a behaviour. "Now" means the v0.7.8
median of 164 s.

| # | Change | Saving now | Saving once #271 and #273 land | Risk | Effort | Status |
|---|---|---|---|---|---|---|
| 1 | Faster test suite. CI's Test step goes from 45 s to about 20 to 25 s, if #271's measured per-file cuts hold on CI. | **15 to 25 s per review** (CI is the critical path), and again on every re-review after a fix round | n/a | Low | Per #271 | Covered: Cut the test suite's wall clock (#271) |
| 2 | Poll CI every 10 s instead of 20 s. The slack drops from about 16 s to about 6 to 8 s. | 5 to 8 s | n/a | Low | Small | Covered: Faster handoff to review (#273) |
| 3 | **Start the review agent while CI runs**, and give it CI's result before it rules (details below) | 35 to 45 s (bounded by the produce phase, about 48 s) | 15 to 25 s | Medium | Medium to large | **Proposed new top-level issue** |
| 4 | Fetch the runner package and the review context before the CI wait, not after it | about 6 s | about 6 s | Low to medium: a comment posted during the wait would be missed unless the discussion is re-read | Medium: runners take no arguments, so this needs a prefetch file or a second entry point | Fold into #3's issue. It is subsumed if #3 lands; on its own it is not worth a ticket |

**Together:** about 164 s becomes about 135 to 145 s with #271 and #273, and about 115 to 125 s
with #3 as well. The savings overlap, because #1, #2 and #3 all shrink the same CI-wait bucket.
They can never sum past it: about 45 s now.

### Proposed new top-level issue: candidate 3

**Title:** Review: start the agent while CI runs, and hand it CI's result before it rules

**Body:**

> The review agent starts only after *Wait for other checks* sees CI finish. In 13 of the 15
> v0.7.8 runs profiled for #277, that left the review runner idle for a median of 35 s, plus 16 s
> of poll slack, out of a 164 s run (#267). Start the produce phase as soon as the review job is
> ready, keep the CI wait running beside it, and give the agent CI's collected result before the
> verdict is emitted. On green CI, that is in the extraction prompt. On red or unknown CI, resume
> the produce session with the failure context first, so a failing CI still gets an
> investigative turn. Every guard stays: the pinned SHA, the moved-head check, the 15-minute CI
> cap, the "CI unknown" rulings and the job split. Prefetching the runner and the review context
> before the wait (about 6 s) belongs in the same change. Expected saving: 35 to 45 s per review
> today, and 15 to 25 s once #271 and #273 land.

**Risk notes for the implementer:**
- The produce prompt today states CI's status up front (`CI_STATUS`).
- An agent told "CI is still running" may run more tests of its own. Say in the prompt that CI is
  running the suite.
- A review whose produce phase finishes on red CI needs a real reconsideration turn, not a
  reformat.
- Adopters with slow CI save the whole agent phase, about 1 minute, on every review.

### Considered and not worth doing

- **Ending the produce phase with the `<output>` block and dropping extraction** (or running it
  only as a fallback). It would save about 6.5 s per review, and the same in fix and
  update-branch. But it removes the documented think/format separation that
  `run-with-extraction.ts` keeps for quality, and the map rules out removing a behaviour.
- **Speeding up setup before the wait**: pinning or caching the Claude Code install, the
  `time-limit` job, checkout. This is 23 s, but it sits behind CI in 13 of 15 runs, so today it
  saves nothing. It becomes the floor only if CI ends sooner than about 23 s after the trigger.
  After #271, CI should still end at about 35 to 40 s.
- **Merging `advance` into `post-review`.** It would save about 5 s on PRD rounds only, and it
  loosens `advance`'s deliberately narrow permissions.
- **Merging the review job's three artifact uploads into one.** It would save about 1 to 2 s.
- **Starting the automatic fix round earlier in `post-review`.** It would save about 5 s on the 4
  of 15 rounds that start one, and its position follows the label-ordering rules.
- **Fewer reviewer test runs.** They average 5 s a review, they are what *What to check* item 4
  asks for, and #271 makes them faster anyway.
- **Fast mode:** out of scope by the map's decision.

## Bearing on the map's fog

**"A runner-side deadline (depends on #274)": review does not need one.**
- Review's own budget is 5 minutes, on top of a 15-minute CI cap, in a 20-minute job.
- Across 125 runs since v0.6.0, the agent step's median is 55 s, its p90 is 94 s and its maximum
  is 180 s. No review timed out in any of the 230 runs examined. The 9 failures since v0.6.0 were
  all in posting steps: `auto-fix` in v0.6.0 to v0.7.1, and one `Post PR review` in v0.7.8, which is post-review
  reports a refused review when GitHub errored but saved it (#328).
- A review commits nothing, so there is no finished work to lose. If it did time out,
  `post-review`'s `always()` already writes the error verdict and removes the label.
- So review is not a consumer of a deadline. Stopping the agent does not stop it: the claude
  process outlives an idle timeout or abort (#274) still matters here, but the stakes are low,
  since the review job has `contents: read` and pushes nothing.

**"Does the test-suite speedup matter elsewhere?": yes, directly, for review.**
- CI's Test step is 70% of CI's wall clock (45 of 64 s).
- CI ends after the review is ready in 13 of 15 runs, so every second off the suite is a second
  off the review.
- #271 should save about 15 to 25 s per review, about 10 to 15% of a 164 s run, paid again on
  each re-review after a fix round.
- It also speeds the reviewer's own targeted test runs (11 of 15 reviews, mean 5 s).
- The saving carries over only while CI ends later than the review's 23 s of setup. Below that,
  setup becomes the floor.
- It is this repository's saving only. An adopter's review waits on the adopter's CI.

## Side findings

- **The slice-round prompt carries the whole PRD diff, and its cost grows with every slice.**
  - On PRD PR #330, the PR DIFF section grew from 208k to 563k characters across 13 slice rounds.
    Input grew from 106k to 270k tokens, and the cost per review rose from $1.2 to $2.9.
  - It does not cost time: the correlation is 0.21. That puts it outside this map's goal, but it
    is worth a decision if cost matters.
  - It touches the same brief as review.ts briefs every PRD PR round as an integration review
    citing the slices (#285).
  - If filed, a possible title is "Review: scope a slice round's diff to the slice". Scoping
    changes what the reviewer sees, which is a behaviour change.
- **The one failed v0.7.8 run in the window** (37053115954) failed in `Post PR review`. That is
  post-review reports a refused review when GitHub errored but saved it (#328).
