# Profile update-branch: where an agent-update-branch run spends its time

Research for #279, on the profiling map #267, following the method in #267's Notes and the shape of
#268's answer. Gathered 2026-10-02 (UTC 2026-10-03 00:2x).

## The sample, and why it is thin

`agent-update-branch.yml` has **373 runs in its whole history** (2026-08-09 to 2026-10-03), pulled
with `gh api --paginate repos/jeffwlawson/agent-workflows/actions/workflows/agent-update-branch.yml/runs`
(`gh run list --limit 300` stops 73 runs short).

| Conclusion | Runs |
|---|---|
| skipped (another label's event) | 370 |
| success | 3 |
| timed out, failed, cancelled | 0 |

**Three runs did work in eight weeks, every one of them on the conflicts path.** None was a clean merge
or an up-to-date no-op, and none was refused. So `agent:update-branch` was added three times; the
other 370 runs were other labels on a pull request starting the caller.

**No transcript exists for any of them.** v0.7.8 (tagged 2026-10-02T19:11Z) is the first release
that uploads `agent-transcript`; there has been no update-branch run since. The breakdown below is
from job step timings (`gh api .../runs/<id>/jobs`) and the sandcastle display log
(`gh run view <id> --log`), which hides `Read`, `Edit`, `Grep` and thinking (#267, *Method* step 2).

**And the caller is gone.** v0.7.9 (#330, merged 2026-10-03T00:10Z) folded `agent-update-branch.yml`
into `agent-pr.yml`, so future update-branch runs are the `update-branch` job of an *Agent PR* run,
not runs of their own. A follow-up profile has to filter `agent-pr.yml` runs by job.

### The three runs

| Run | PR | Package | Model | Claude Code | Conflicted files | Run wall clock |
|---|---|---|---|---|---|---|
| [35927358386](https://github.com/jeffwlawson/agent-workflows/actions/runs/35927358386) | #121 | 0.3.1 | claude-sonnet-5 | 2.1.281 | 1 (`tests/review-output.test.ts`) | 145 s |
| [36601489555](https://github.com/jeffwlawson/agent-workflows/actions/runs/36601489555) | #187 | 0.7.0 | claude-sonnet-5-5 | 2.1.284 | 2 (`shared/pr-feedback.ts`, `tests/diff-base.test.ts`) | 70 s |
| [36941339626](https://github.com/jeffwlawson/agent-workflows/actions/runs/36941339626) | #306 | 0.7.7 | claude-sonnet-5-5 | 2.1.287 | 1 (`tests/workflows.test.ts`) | 92 s |

All three are the pre-split, single-job shape (#311 shipped in v0.7.8). Model from the
`Agent model:` line, Claude Code version from the install step's log, package from the
`agent-workflows <version>: update-branch` line (#267, *Traps*).

## Where the time goes

### Run 36941339626 (PR #306, v0.7.7): the most recent, 92 s

| Bucket | Seconds | Share | Detail |
|---|---|---|---|
| Queue for a runner | 2 | 2% | job created 23:32:21, started 23:32:23 |
| Workflow setup | 18 | 20% | Set up job 2, labels 3, checkout 2, merge 1, Node 5, `npm ci` 2, Claude Code install 3 |
| Runner start to agent start | 2 | 2% | `npm exec` of the package, the PR heading fetch |
| **Verify** (plus the turn that wrote the commit message) | ~30 | 33% | one `Bash` call ran the resolution script and `npm run verify` (2538 tests); 35.7 s to the next call |
| **Model turns** | ~19 | 21% | 3.1 s to the first call, 6.1 s to write the resolution, ~5 s composing the commit, 4.2 s commit and summary |
| Extraction pass | 5 | 5% | the second session that emits the `<output>` comment (`shared/run-with-extraction.ts`) |
| Publishing and API calls | 13 | 14% | push 2, comment 2, request review 6, remove label 1, post-steps 2 |
| Run overhead | ~3 | 3% | run created to job created, job end to run end |

### Run 36601489555 (PR #187, v0.7.0): 70 s

Queue 3 s, setup 21 s (labels 7 s), runner start 2 s, **agent 28 s** (3 printed calls; the one
holding the resolution and verify, 1652 tests, took 17.5 s), extraction 4.5 s, publishing 7 s.

### Run 35927358386 (PR #121, v0.3.1, Sonnet 5): 145 s

Setup 16 s, **agent 106 s** over 13 printed calls: nine `grep`/`git log` probes of both sides
before resolving, verify 15 s, then three `git status` checks. Extraction 7 s, publishing 6 s.
The two later runs on Sonnet 5.5 resolved in three calls each: look at the markers, write the
resolution and verify in one command, commit. That is the main reason the later runs are half
the length, not any workflow change.

### Summary across the three runs

| Bucket | Share of the two Sonnet 5.5 runs | Note |
|---|---|---|
| Verify (the repository's own gate) | about 25 to 33% | grows with the suite: 15 s at 1652 tests, ~30 s at 2538 |
| Model turns, including extraction | about 30 to 35% | 3 tool calls; extraction is a fixed ~5 s |
| Workflow setup on the runner | about 20 to 30% | Node, `npm ci`, Claude Code, two label writes, checkout |
| Publishing and API calls | about 10 to 15% | push, comment, request review, label off |
| Queue and run overhead | about 5% | |

**An update-branch run is about 1 to 1.5 minutes.** Its 30-minute job limit is twenty times what it
uses, so the time-limit work (#270, #303) does not reach it; #302 already decided update-branch
needs no rescue.

## What the v0.7.8 split adds per run (estimated, not measured)

v0.7.8 (#311) made update-branch three jobs: `gate` (claim, checkout, try the merge), `update-branch`
(agent, conflicts only, read-only token) and `publish` (fresh runner, check and push). No
update-branch run has used it yet, so the cost is read from `update-branch.yml` and measured on the
five `fix` runs since v0.7.8, which have the same three-job shape (runs 37068824712 to 37080387169):

- a job hop (previous job done to next job started) took **2 to 4 s** each in those fix runs, and each
  new job's *Set up job* about 1 s;
- `actions/checkout` with `fetch-depth: 0` takes about 2 s each, and update-branch now checks out in
  all three jobs;
- the transcript redact and upload, the bundle and the hand-over upload take 2 to 3 s; the
  download and the token resolution about 1 s each.

| Path | Added per run | On a run of |
|---|---|---|
| Conflicts (gate, agent, publish) | about 15 to 20 s: two hops, two more checkouts, the repeated merge, artifacts, token | about 70 to 90 s, so roughly +20% |
| Clean merge (gate, publish) | about 8 s: one hop, one more checkout, the merge made again | no clean run has ever happened here |

That cost is the guard #308 exists for (no PAT on the runner that ran the agent), so it is out of
scope to remove.

## Skipped runs: do they cost anything?

**No runner, no billable time, no queue place.**

- Skipped run wall clock: median 1 s, 90th percentile 9 s, maximum 12 s; 1105 s summed over all 370.
  Nobody waits on them.
- A skipped run's jobs have `runner_name: null`, and `.../timing` reports `total_ms: 0` billable
  (checked on run 37080726163, whose three jobs `gate`, `update-branch`, `publish` were all skipped).
- Queue: per #309, a skipped *job-level* group never takes a pending slot, and the workflow-level
  group v0.7.8 introduced is keyed `-other-<run id>` for any other label (`update-branch.yml`,
  `concurrency:`), so a stray label cannot cancel a pending `agent:update-branch`.
- Volume is rising with PR activity (78 skipped runs on 2026-10-01 alone). Since v0.7.9 these are
  skipped jobs inside one *Agent PR* run rather than runs of their own, which costs no more.

## Candidate changes

Saving is per conflicts run of about 90 s. At three runs in eight weeks, none of these is worth
more than seconds a month.

| Change | Saving | Risk | Effort | Status |
|---|---|---|---|---|
| Faster test suite (verify is the largest bucket) | about 10 s (a third of ~30 s) | low | done elsewhere | covered by #271 |
| Prompt: say `CLAUDE.md` is already loaded, as #272 does for implement | 0 to 3 s; the logs cannot show whether the agent re-reads it | low | trivial | not worth an issue now; #272 left the update-branch prompt out on purpose pending this ticket |
| Skip the extraction pass when the agent's own message already carries the comment | about 5 s | medium: `runWithExtraction` is shared and separates thinking from formatting on purpose | medium | not worth it at this traffic |
| Cache Node / `npm ci` / Claude Code install | 2 s at most (#268) | low | low | not worth it |
| Collapse the three jobs back to one | 15 to 20 s | removes the #308 guard | | out of scope |

**No new top-level issue is proposed.** The one change worth building, the test-suite speedup, is
already #271 and reaches update-branch through verify.

## Side finding

The first *Agent PR* run, [37080952471](https://github.com/jeffwlawson/agent-workflows/actions/runs/37080952471)
(2026-10-03T00:10:52Z, right after #330 merged), ended `startup_failure`. At that commit
(`f3befac`) `agent-pr.yml` pinned the reusables `@v0.7.8` while passing `AGENT_APP_ID` and
`AGENT_APP_PRIVATE_KEY`, which v0.7.8's `update-branch.yml` does not declare; a caller passing an
undeclared secret is an invalid workflow. Likely the whole PR side of the loop was down from the
merge until the v0.7.9 tag about ten minutes later. Not verified beyond the pins and the
missing declarations; not filed.

## Recommendation

**Close #279 as too little traffic to matter.** Three runs in eight weeks, each about 1 to 1.5
minutes, with verify (already covered by #271) the largest bucket. A transcript would only split the
~20 s of model time inside a ~90 s run more finely; it cannot move the conclusion. Reopen, or
profile again from the `update-branch` job of `agent-pr.yml` runs, if update-branch starts running
weekly or a run goes past five minutes.
