# Profile follow-ups: where an agent-follow-ups run spends its time

Research for #280, on the profiling map #267, following the method in #267's Notes and the shape of
#268's answer. Gathered 2026-10-02 (UTC 2026-10-03 00:3x).

## The short answer

**Follow-ups runs no model, so there is no agent time to profile.** A run is a 7 to 13 second job:
about 3 seconds waiting for a runner, 2 seconds of runner and Node setup, 2.5 seconds installing the
runner package, and then either 0.6 seconds to find no marker (73% of the runs that start) or about
6 seconds of sequential `gh` calls to file the stubs. The whole workflow used about **15 runner-minutes
in its entire history**, and nobody waits on it: it fires after a merge. Nothing here is worth
changing for speed.

## The sample

`agent-follow-ups.yml` has **392 runs in its whole history** (2026-09-20 to 2026-10-03), confirmed by
`gh api repos/jeffwlawson/agent-workflows/actions/workflows/agent-follow-ups.yml/runs --jq .total_count`.
`gh run list --limit 300` stops 92 runs short, so the list was pulled with `--limit 1000`.

| Conclusion | Runs | What it was |
|---|---|---|
| skipped | 304 | a `labeled` event for another label, a close without merging, or a label on an open PR (the job condition) |
| success, no marker | 64 | a merge whose PR carried no `agent:follow-ups`; logs `#N does not carry agent:follow-ups. Nothing to file.` |
| success, filed | 23 | 30 stubs in all: 17 runs filed 1, 2 filed 2, 3 filed 3, 1 filed 0 and only removed the marker (run 36330033971) |
| failure | 1 | run 35538285415, the very first one (2026-09-20, PR for #44): no jobs recorded and no log retained, so a startup failure |
| timed out, cancelled | 0 | |

That is about **33 triggers a day, 7 runs that start, and 2 that file**. Every run that started
succeeded except the first.

**The caller is gone.** v0.7.9 (#330, merged 2026-10-03T00:10Z) folded `agent-follow-ups.yml` into
`agent-pr.yml` as its `follow-ups` job, so future follow-ups runs are a job inside an *Agent PR* run
and a later profile has to filter `agent-pr.yml` runs by job.

## Why the newest run has no transcript

Run [37069348430](https://github.com/jeffwlawson/agent-workflows/actions/runs/37069348430) (PR #327,
package 0.7.8) has no artifacts (`gh api .../runs/37069348430/artifacts` gives `total_count: 0`), and
that is correct, not a missing upload:

- **Follow-ups never runs an agent.** `follow-ups.yml` says so in its header ("It **runs no model**")
  and has no Claude Code install step, no model secret and no sandcastle session. The runner,
  `follow-ups/follow-ups.ts`, is "gather, plan, perform": `hasFollowUpsMarker`, then the pure
  `planFollowUps`, then `executeFilingPlan`. With no session there is no transcript to upload.
- **#269's upload went exactly where agents run.** On `origin/main`, the `agent-transcript` upload
  (`actions/upload-artifact@v7`, `name: agent-transcript`) appears in `implement.yml`,
  `implement-prd.yml`, `review.yml`, `fix.yml` and `update-branch.yml`, which are all five
  workflows that start a session, and not in `follow-ups.yml`.
- **And this run was a no-op anyway.** Its log ends `#327 does not carry agent:follow-ups. Nothing
  to file.` 0.6 seconds after the runner banner.

No missing transcript upload was found. The whole run is visible in the job log, which is all
`console.log` from a deterministic runner, so #267's *Method* step 2 does not apply here.

## Where the time goes

From `gh api repos/{owner}/{repo}/actions/runs/<id>/jobs` for all 87 successful runs, split by the
runner's own log lines (`gh run view <id> --log`): "install" is from the `npm exec` step's start to
the `agent-workflows <version>: follow-ups` banner, and "runner" is from the banner to the step's last
line. Medians, with the maximum in brackets.

| Bucket | No marker (64 runs) | Filed (23 runs) |
|---|---|---|
| Queue: event to job start | 3 s (38) | 3 s (6) |
| Set up job (runner provisioning, `actions/setup-node` download) | 1 s (2) | 1 s (1) |
| Authenticate to GitHub Packages (`setup-node`, toolchain-free) | 1 s (13) | 1 s (6) |
| `npm exec` install of `@jeffwlawson/agent-workflows` | 2.5 s (9.7) | 2.4 s (4.3) |
| Runner work | 0.6 s (11.0) | 6.4 s (11.4) |
| Post steps and *Report the failure* (skipped) | 0 s | 0 s |
| **Job** | **7.5 s** (34) | **13 s** (23) |
| **Run** (`run_duration_ms` from `.../timing`, includes the reusable call's orchestration) | **12 s** (45) | **17 s** (28) |

From event to job end, a filing run (about 16 s) is runner work 40%, install 15%, setup 12% and queue
20%. A no-op run (about 10.5 s) is queue 30%, install 25%, setup 20% and runner work 6%; the rest is
step overhead.

**The filing work is seven or more sequential `gh` calls, about 0.7 to 1 second each**
(`shared/follow-up-filing.ts`): `gh pr view --json labels` (the marker), a GraphQL read of every
review, `gh issue list --label pr-follow-up --state all --limit 500`, `gh api .../labels --paginate`
(only when there is something to file), one `gh issue create` per stub, `gh pr comment`, and
`gh pr edit --remove-label`. The 3-stub runs took 6.7 to 11.4 s of runner work against 4.5 to 9.6 s for
1-stub runs: a stub costs about a second, and run-to-run API latency matters as much as stub count.

**Skipped runs cost nothing.** The 15 skipped runs sampled have `billable.UBUNTU.total_ms: 0`, no
runner, and a job whose `started_at` equals its `completed_at`; `run_duration_ms` is 1000 for each,
which is GitHub evaluating the condition. The repository is public, so even the jobs that run are
billed at 0 ms. And #309 showed that a skipped job-level `agent-pr-<n>` group takes no queue place,
so the 304 skips cannot delay a real run on the same PR either.

**Total cost: 917 s of job time across all 88 started runs**, about 15 minutes in 12 days.

## Candidate changes

None is recommended. Nobody waits on this job: it runs after a merge, and its output is an issue and
a comment that a human reads later. Each saving below is real but measured in seconds against a job
nobody watches.

| Change | Saving | Risk | Effort | Verdict |
|---|---|---|---|---|
| Check the marker in a shell step (`gh pr view --json labels`) before installing the runner, so a no-marker merge skips setup-node and `npm exec` | about 3.5 s on 73% of started runs, about 2 runner-minutes over the history | Moves the one branch the runner owns into YAML, where `tests/workflows.test.ts` is the only check; two statements of the opt-out that can drift. The re-read-at-filing-time guard survives only if the runner still re-reads too | Small | Not worth it |
| Read reviews, stubs and labels concurrently rather than one after another | 1 to 2 s on filing runs (2 a day) | Low, but turns a synchronous `execFileSync` chain into async code for no user-visible gain | Small | Not worth it |
| Cache the npm install | At most 2 s, as #268 found for the other workflows | Cache keyed on a version that changes every release | Small | Not worth it |
| Narrow the trigger so fewer runs are skipped | 0: skips cost no runner or queue time | The trigger is shared by the whole `agent-pr.yml` caller since v0.7.9 | n/a | Nothing to do |

The existing optimization issues (#270 to #273, #303) all target agent time, tests or the review
handoff, and none touches follow-ups. #275 (the duplicate-PR guard reading only 30 PRs) is
implement's; follow-ups lists stubs with `--limit 500`, newest first, which its own comment
(`STUB_LIMIT`) already reasons about.

## Side finding: follow-ups runs on Node 22 against a package that requires Node 24

Every one of the 87 retained logs carries:

```
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@jeffwlawson/agent-workflows@0.7.8',
npm warn EBADENGINE   required: { node: '>=24' },
npm warn EBADENGINE   current: { node: 'v22.23.3', npm: '10.9.9' }
```

`package.json` has declared `"engines": { "node": ">=24" }` since #96 (2026-08-08). `follow-ups.yml`
deliberately sets no `node-version-file` ("the image's own Node runs the runner perfectly well"), so
it runs on the `ubuntu-24.04` image's Node 22. The agent workflows set up Node from the caller's
`node-version-file`; review run 37080726291 shows `node: v24.21.0` and no `EBADENGINE`. So
follow-ups is the one runner executed below its declared engine.

It works today because nothing it imports needs Node 24. The day `shared/` uses something that does,
follow-ups fails at module load, before `fail()` can write `failure_reason.txt`, so the PR is told
"It stopped without giving a reason." on the one workflow whose ordinary outcome is silence. No
existing issue covers it (`gh issue list --search "EBADENGINE OR engines"` finds none). The fix is a
pinned `node-version` on the toolchain-free auth step, or a test that the runner's imports stay
Node 22 compatible; it is not a speed change, so it is reported here rather than counted above.

## Sources

- `gh api repos/jeffwlawson/agent-workflows/actions/workflows/agent-follow-ups.yml/runs` and
  `gh run list --workflow agent-follow-ups.yml --limit 1000`: run list and conclusions.
- `gh api repos/jeffwlawson/agent-workflows/actions/runs/<id>/jobs` and `.../timing` for all 88
  non-skipped runs and 15 skipped ones: step timings, billing.
- `gh run view <id> --log` for all 88 non-skipped runs (87 retained): install and runner split,
  outcome lines, `EBADENGINE`.
- `origin/main` at `8f3032e` (v0.7.9): `.github/workflows/follow-ups.yml`, `.github/workflows/agent-pr.yml`,
  `follow-ups/follow-ups.ts`, `shared/follow-up-filing.ts`, `package.json`, and the
  `agent-transcript` upload steps in the five agent workflows.
- #309's answer: skipped jobs with job-level concurrency groups take no queue place.
