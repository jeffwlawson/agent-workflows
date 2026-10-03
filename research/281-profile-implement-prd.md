# Profile implement-prd: where an agent-implement-prd run spends its time

Research for #281, on the profiling map #267, following the method in #267's Notes and the shape of
#268's answer. Gathered 2026-10-02 (UTC 2026-10-03 00:xx), against `origin/main` at `8f3032e` (v0.7.9).

## The sample

`gh run list --workflow agent-implement-prd.yml --limit 1000` reaches back to 2026-08-09 and holds 406
runs: 282 skipped (another label's event) and 124 successful. **None failed, was cancelled or timed
out.** 52 of the successful runs lasted over 90 s; 51 of them built a slice, and one was a finishing run.

| Set | Runs | Dates | Shape | Source |
|---|---|---|---|---|
| A. v0.7.8 with transcript | 8 | 10/02 21:54Z to 23:52Z | `gate` / `catch_up` / `implement-prd` / `publish` (#311, #315) | `agent-transcript` artifact + jobs API |
| B. single job, baseline | 43 | 9/20 to 10/01 | one job | jobs API + sandcastle display log |

Set A is the eight slices of PRD #314 (sub-issues #317 to #324), all `claude-opus-5-5 (default)`
on Claude Code 2.1.288, package 0.7.8. Set B is every build run before the split: Opus 5 until 9/28,
Opus 5.5 from 9/29.

**Run 37080686912 has only the gate's artifact because it is the finishing run.** Its gate logged
"PRD PR #330's latest commit … has an approval; the chain moves on" and "Every sub-issue of #314 is
built; finishing it", so `build` was false: `catch_up` and `implement-prd` were skipped (their `if:`
reads `needs.gate.outputs.build == 'true'`), no agent ran, and there was no transcript to upload.
`publish` handed PRD PR #330 over in 15 s. That is the designed behaviour.

**The caller is gone.** v0.7.9 (#330) folded `agent-implement-prd.yml` into `agent-issue.yml`, so a
later profile has to pick the `implement-prd` jobs out of *Agent issue* runs.

**Traps checked** (#267): job and transcript timestamps are both UTC; model from the `Agent model:` line;
Claude Code version from the transcript's `version` field. Step timings from the jobs API are whole
seconds.

## Answer in one paragraph

A slice build has a **median of 9.9 minutes end to end** (n=8; 4.0 to 16.6), and its agent step is
the same size as before the split (median 8.4 vs 8.5 min). **Model time is 73% of the agent's session
and tests are 26%** (transcript, every second accounted for). That is a larger test share than
#268's 17% for implement, and the difference is mostly method: the sandcastle display log hides any
verify run chained after a heredoc edit, and on these eight runs it reports 14% where the transcript
shows 26%. As for implement, **run time follows the size of the change** (correlation 0.84 between
minutes and lines changed, elasticity 0.65, about 1 minute per 100 lines). **The #311/#315 split costs
42 s per build run** (non-agent time went from 31 s to 73.5 s at the median), of which 23 s is the
split's own mechanics. No guard needs to go. The savings are in the tests: #271 (its numbers are now
stale, and the gain is bigger than it says) and the same prompt changes #272 makes for implement, which
the implement-prd prompt does not get today. Together they should save about 1.2 to 1.5 minutes on a
typical run and about 3 on the largest.

## Where the time goes

### Set A: per run

| Run | Slice | Files | Lines | Wall (min) | Session (min) | Model (min) | Tests (min, share of session) | Verify / full / targeted runs | Tool calls | Output tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| [37069551775](https://github.com/jeffwlawson/agent-workflows/actions/runs/37069551775) | #317 | 33 | +1447 -1111 | 16.6 | 15.3 | 12.2 | 2.9 (19%) | 2 / 0 / 16 | 104 | 84,890 |
| [37071344030](https://github.com/jeffwlawson/agent-workflows/actions/runs/37071344030) | #318 | 4 | +334 -26 | 6.2 | 5.0 | 3.9 | 1.1 (23%) | 2 / 0 / 4 | 25 | 22,929 |
| [37072618946](https://github.com/jeffwlawson/agent-workflows/actions/runs/37072618946) | #319 | 12 | +780 -110 | 12.1 | 11.0 | 7.6 | 3.3 (30%) | 2 / 1 / 6 | 70 | 52,189 |
| [37073945950](https://github.com/jeffwlawson/agent-workflows/actions/runs/37073945950) | #320 | 13 | +644 -226 | 14.1 | 12.9 | 8.6 | 4.2 (33%) | 3 / 3 / 5 | 65 | 57,168 |
| [37076093883](https://github.com/jeffwlawson/agent-workflows/actions/runs/37076093883) | #321 | 5 | +451 -23 | 7.3 | 5.9 | 4.5 | 1.3 (22%) | 2 / 0 / 4 | 33 | 31,918 |
| [37076912819](https://github.com/jeffwlawson/agent-workflows/actions/runs/37076912819) | #322 | 6 | +1086 -69 | 10.2 | 8.7 | 6.3 | 2.4 (28%) | 2 / 0 / 4 | 38 | 42,553 |
| [37078377986](https://github.com/jeffwlawson/agent-workflows/actions/runs/37078377986) | #323 | 4 | +161 -21 | 4.0 | 2.7 | 1.7 | 0.9 (34%) | 1 / 0 / 2 | 16 | 11,593 |
| [37078894999](https://github.com/jeffwlawson/agent-workflows/actions/runs/37078894999) | #324 | 5 | +381 -131 | 9.6 | 8.0 | 5.9 | 2.1 (26%) | 4 / 0 / 1 | 59 | 40,087 |

Size is each run's own commit (every run logged `produced 1 commit(s)`), read off PR #330's commit
list: `d48b881`, `0168e42`, `72fad0c`, `eeba7c3`, `6245cc9`, `01ccc4d`, `77fe246`, `fb1954c`. The
fix-round commits between them (`4be2657`, `39578f5`, `3d87de9`, `4f01610`) are left out. The model
times agree with Claude Code's own `cost-state` record (`totalAPIDuration`) to within a few seconds.

### Set A: by bucket

All eight runs, 80.0 minutes of wall clock, from the event to the end of `publish`.

| Bucket | Share | Median per run | Max |
|---|---|---|---|
| **Model: writing** (turns with 400 or more output tokens: edits, mostly as `python3` heredocs, at a median 114 tokens/s) | **50.5%** | 296 s | 588 s |
| **Tests: full verify** (18 calls, 31 to 55 s each) | **14.1%** | 85 s | 124 s |
| **Model: short turns** (under 400 output tokens: a read, a grep, a decision) | **11.1%** | 57 s | 135 s |
| **Tests: targeted runs** (42 calls) | 5.4% | 19 s | 88 s |
| Agent job outside the agent step (checkout, Node, `npm ci`, Claude Code install, transcript, bundle) | 3.1% | 18 s | 29 s |
| `gate` job (preflight, labels, start comments, progress row) | 3.0% | 16 s | 34 s |
| `publish` job (fetch artifacts, checkout, push, PR, `agent:review`) | 2.9% | 18 s | 23 s |
| Tests: full test runs without typecheck (4 calls) | 2.8% | 0 s | 89 s |
| **Model: closing summary** (2 to 3 thousand characters nothing reads) | 1.7% | 11 s | 11 s |
| Queueing between jobs (three hand-offs) | 1.4% | 8 s | 14 s |
| `catch_up` job (checkout, merge, push) | 1.2% | 8 s | 9 s |
| Runner around the session (package install, issue fetch, list render) | 0.9% | 6 s | 7 s |
| Queueing before `gate` | 0.7% | 3 s | 15 s |
| Tests: typecheck and build alone | 0.6% | 0 s | 17 s |
| Every other tool call (203 `cat`/`sed`/`grep`, 72 scripts, git) | 0.5% | 2 s | 5 s |

Grouped: **model 63%, tests 23%, workflow and runner 13%, other tools under 1%.** Inside the agent's
session alone: model 73%, tests 26%. #268's "under 1% workflow" was a share of the agent step only,
so it does not compare with the 13% here.

Findings that shape the candidates:

- **Verify runs after every edit pass.** The agent edits with a `python3 - <<'EOF'` heredoc and chains
  `npm run verify` onto the same command, so each pass of edits pays for a full suite. The docs slice
  (#324: 472 of its 512 changed lines are Markdown) ran verify four times, 124 s or 26% of its
  session; the last came after a one-line wording fix. #320 ran three verifies and three full test
  runs (190 s).
- **`tests/workflows.test.ts` is the most-run targeted file**: 10 runs at about 14 s each, 140 s in all.
  It is now 22.2 s in CI (1,019 tests), up from 3.0 s when #271 was filed.
- **Short turns do not slow down as the context grows.** Their median is 1.6 to 2.2 s from 0 to 300k
  tokens of context (the largest session reached 316k). Later turns are slower because they write
  more, not because the context is larger, so there is nothing to win by trimming context.
- **The PRD context costs nothing measurable.** The prompt is 30 to 33 thousand characters (PRD body,
  slice body, comments), and reading the earlier slices (`git log`/`git diff --stat`) is one 0.3 s call.
- **No agent re-read `CLAUDE.md` whole** (two `sed -n` ranges in one run), so #272's `CLAUDE.md` line
  saves nothing measurable here.
- **No subagents and almost no parallel tool calls** (22 of 395 requests).

### Set B: the baseline

| | Set B (single job, n=43) | Set A (split, n=8) |
|---|---|---|
| Median run, event to end | 9.0 min | 9.9 min |
| Median agent step | 8.5 min | 8.4 min |
| Median non-agent time | 31 s (24 to 59) | 73.5 s (61 to 89) |
| Longest agent step | 24.8 min (35907997579, 9/23, Opus 5); 18.1 min since 9/29 | 15.3 min |

By day, the median agent step was 10.3 min (9/20), 10.5 (9/23), 18.9 (9/28), 5.6 (9/29), 11.2 (9/30),
7.7 (10/01) and 8.4 (10/02). That follows the slices' size, as #268 found for implement. The closest
any run came to the 30-minute limit was 4.8 minutes (35907997579, 25.2 min end to end).

The display log undercounts tests. Run over Set A, #268's log parser finds 14% test time where the
transcript finds 26%: sandcastle prints only the first line of a multi-line `Bash` call, so a verify
chained after a heredoc is invisible. It reports 11% for Set B, so the true share there was probably
around 20%. #268's 17% for implement was found the same way, so it is probably low too.

### What the split costs

Non-agent time rose by **42 s** at the median. Directly attributable to the split, per run:

| Piece | Median |
|---|---|
| Queueing at the three job hand-offs (`gate`→`catch_up`→`implement-prd`→`publish`) | 7.5 s |
| The `catch_up` job (runner, `fetch-depth: 0` checkout, merge, push) | 7.5 s |
| `publish` set-up, two artifact downloads and its own checkout | 5.5 s |
| Artifact hand-offs (snapshot, bundle) and marking the commits | 2.5 s |
| **Total** | **23 s** |

The other ~19 s is the gate doing more than the old preflight (the building row #312, 2 s; the
approved-slice note, 1 s; its own runner start and teardown) and the agent job's second checkout and
branch preparation. That is 4% of a median run, and it buys the guarantee of #308 that no PAT or
App secret reaches the agent's runner. See *Considered and not worth doing*.

### On the chain's critical path

PRD #314 took 133 minutes from the first slice's event to the finishing run: **80 minutes of slice
builds and 53 minutes between them**. Between two slices whose round was approved first time, the gap
was 2.8 to 3.0 minutes (CI, the review agent, the approval re-labelling). Four gaps also held a fix
round, and took 7.9 to 14.5 minutes. Those gaps belong to review and fix (#277, #278). CI is on that
path once per slice, and CI's `Test` step grew from 36 s to 46 s during this one PRD (`ci.yml` runs
37071076987 and 37079616788).

## What can be cut, with estimated savings

"Typical" is the median run (9.9 min); "largest" is #317 or #320 (14 to 17 min).

| Change | Typical run | Largest runs | Risk | Effort | Status |
|---|---|---|---|---|---|
| Test-suite speedup | 0.8 to 1 min | 1.5 to 2 min | Low | Medium | #271, carries over; numbers stale |
| Prompt: targeted tests while iterating, one verify at the end | 0.5 to 0.7 min | 1.5 to 2 min | Low | Small | Not covered: #272 is implement's prompt only |
| Prompt: no closing summary | 11 s | 11 s | None | Trivial | Same |
| Never lose committed work at the time limit | 0 | a whole run and its retry, each time | Low | Medium | #303, carries over; the split moves where it goes |
| CI poll every 10 s; skip a no-op label removal | 1 to 2 s per run, ~10 s per slice round | same | None | Trivial | #273, applies to implement-prd's review rounds; its label item is implement-only |

The two test changes overlap. Together: about **1.2 to 1.5 min** off a typical run (9.9 → ~8.5) and
about **3 min** off the largest (16.6 → ~13.5), plus ~20 s of CI per slice on the chain.

### Test-suite speedup (#271): 0.8 to 1 min typical, 1.5 to 2 min largest

Carries over unchanged, and is worth more than #271 says.

- **The suite has grown since #271 was filed.** CI's `Test` step is 46 s (it was 29 s), and on the agent's
  runner a verify takes 31 to 55 s. The three slowest files in CI (`fb1954c`) are
  `implement-prd-preflight.test.ts` (25.7 s), `review-ci-wait.test.ts` (25.5 s) and now
  **`workflows.test.ts` (22.2 s, 1,019 tests; #271 measured 3.0 s)**.
- **Item 2 of #271 alone (parse each YAML text once) takes `workflows.test.ts` from 10.5 s to 0.9 s**
  locally, all 1,019 tests passing (`workflowOf` cached by file text, returning `structuredClone`).
  `implement-prd.yml` alone takes 6.2 ms to parse and `review.yml` 10.1 ms. Item 2 alone takes the
  whole suite from 26.5 s to 23.2 s on 4 pinned cores, because the two spawn-bound files stay the
  critical path. Item 1 (concurrent spawns) is what shortens that path. The two need each other.
- **Saving here**: per run, about 2.25 verifies and 0.5 full runs at roughly 15 to 20 s less each, plus
  about 1.25 targeted `workflows.test.ts` runs at about 12 s less each.

### implement-prd prompt: targeted tests, one verify at the end, no closing summary (proposed new issue)

#272 trims `implement/prompt.md` only. `implement-prd/prompt.md` has the same two costs:

- "Run the verify command `CLAUDE.md` names before committing" produces 2.25 verifies per run, chained
  onto each edit pass (18 verifies and 4 full test runs in 8 runs). One verify at the end, plus one
  more only if something changed after it, saves about one full suite per typical run and three or
  more on the docs slice and on #320.
- "When complete, output `<promise>COMPLETE</promise>`" is preceded by a 2 to 3 thousand character
  summary in every run (median 11 s). `implement-prd.ts` ignores the agent's final output, and
  `publish` reads only the artifact.
- The `CLAUDE.md` line is harmless to align, but saves nothing measurable here.
- **Keep everything else.** That includes the slice-scope rules, the earlier-slices reading, the
  self-review before commit, which is a guard, and the commit and no-push rules.

Widening #272 to both prompts is the cheaper route, since it is the same three edits and one prompt
test covers the runner surface. Filing separately keeps #272's scope as written.

### Rescue and resume (#303): carries over, but the split moves it

#303 was written before #311/#315, and its implement-prd half now crosses a job boundary:

1. **The rescue must come from the bundle, in `publish`.** The agent job holds a read-only token.
   `Mark the slice's commits` and `Bundle the branch` are both `if: success()`
   (`implement-prd.yml`, around lines 1360 and 1402), so a timed-out or failed agent job hands over no
   commits today. #303 needs both to run on `failure() || cancelled()`. The commits must be marked,
   or a resumed run cannot tell them from the PRD branch's other slices. The hand-over step after
   them is already `always()`, and `publish` already runs after a failed agent job.
2. **Steps gated on failure do run after a job-level timeout.** Implement run 36823054971 (#257) hit
   `timeout-minutes` during `Push branch`, which was marked cancelled. Its `Mark blocked on failure`
   and `Always remove in-progress` steps still ran, three seconds later. The probe the fix profile
   (#278) asked for is answered by that record. It does not show how long such steps may take.
3. **The orphan from #274 matters here.** A bundle is built from commits, so uncommitted edits cannot
   leak into it. But a `claude` process that outlives the runner could still commit while the trailers
   are rewritten and the bundle is taken. Whether a job-level cancellation kills the step's process
   tree was not measured. #303's rescue path should not assume it does.
4. **Commit early.** The first verify came 1.5 to 13 minutes into the session (median 5.6), and in
   every run the commit came within about a minute of the session's end. #303's prompt line moves the commit to the first passing
   verify. With the "one verify at the end" change, that becomes the end anyway, so for implement-prd
   the two lines should be worded together.

### Considered and not worth doing

- **Folding `catch_up` into `gate`** would save about 10 s (one runner, one queue). But it puts the
  push token in the gate, which runs on every `agent:implement` event, deferrals to `agent-implement`
  included. That widens where the secret goes (#308), so it is out.
- **Shallow or partial checkouts.** Three `fetch-depth: 0` checkouts cost 2 to 3 s each, and the agent
  and `catch_up` need history (`git log main..HEAD`, `merge-base`). That saves 1 to 2 s at most.
- **Running the gate's start calls in parallel.** `Transition labels` is 5 s of sequential `gh` calls,
  including re-adding `agent:implement` and removing `agent:blocked` unconditionally (the same pattern
  #273 trims in implement). The saving is 2 to 3 s, which is not worth a ticket of its own; it fits
  #273 if that is widened.
- **Trimming context** (the PRD body in the prompt, large `cat` output). Short-turn latency is flat with
  context size, so this saves nothing.
- **Splitting slices smaller.** Elasticity is 0.65, as for implement, so this only keeps a single run
  under the limit, and no run is near it.
- **Lower effort, Haiku subagents, `--bare`, caching installs, fast mode:** as #268 and the map.

## Bearing on the map's fog

### A runner-side deadline (depends on #274)

**implement-prd has not needed one.** There have been 0 timeouts in 51 build runs. The longest agent
step is 24.8 min (Opus 5, 9/23), 18.1 min since 9/29 and 15.3 min in Set A. The split helped: the
agent job's `timeout-minutes` now covers only about 20 s of set-up besides the agent. Preflight,
labels, push, PR and review moved to jobs with their own limits (gate 10, catch_up 10, publish 15).
Steps gated on failure still run after a timeout (run 36823054971), so #303 can rescue without a
deadline. A deadline would add an orderly stop with no orphan process, so it waits on #274 either way.
Nothing measured here argues for building one for implement-prd.

### Does the test-suite speedup matter elsewhere?

**Yes, and more than #268 measured.** Tests are 26% of an implement-prd agent session by transcript.
The log method #268 used reads 14% on the same runs, so implement's 17% is probably low too. For a
PRD chain the suite also counts once per slice on the critical path, because each slice's review
waits on CI, whose `Test` step is now 46 s. #271 should be refreshed with today's numbers. In
particular, `workflows.test.ts` has become a 22 s file, and the parse cache is a three-line change
measured at 10.5 s → 0.9 s.

## Method notes for #276

- **Use the transcript, not the display log, for tests.** Calibrated on Set A, the log sees about half
  the test time. Group assistant entries by `requestId` so that one API response counts once. Each
  request's model time is its last block's timestamp minus the previous tool result's. Tool time is a
  `tool_result`'s timestamp minus its `tool_use`'s.
- **Classify the whole `Bash` command, not its first line.** Agents in bypass mode edit with heredocs and
  chain the verify afterwards.
- **`cost-state`**, the last record in the transcript, gives `totalAPIDuration` and
  `totalToolDuration` directly. It is a quick cross-check.
- **For a split workflow, report queueing between jobs as its own bucket**, from each job's
  `started_at` minus the previous job's `completed_at`.
- **The finishing run has no transcript**, because no agent runs in it. Filter build runs on the
  `implement-prd` job having run, not on the artifact.

<details><summary>The transcript parser (tr.py, condensed)</summary>

```python
"""Split an agent session transcript into model time and tool time, by tool kind."""
import json, re, collections
from datetime import datetime

def P(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))

def classify(name, inp):
    if name != "Bash": return name
    c = inp.get("command", "")
    if re.search(r"npm run verify", c): return "verify"
    if re.search(r"vitest", c):
        return "targeted" if re.search(r"tests/\S+\.test\.ts", c) else "fulltest"
    if re.search(r"npm (run )?test\b", c): return "fulltest"
    if re.search(r"npm run typecheck|\btsc\b|npm run build", c): return "typecheck/build"
    return "other"

def parse(path):
    msgs = [o for o in map(json.loads, open(path)) if o["type"] in ("assistant", "user")]
    prev, reqs, started, out = msgs[0]["timestamp"], collections.OrderedDict(), {}, collections.Counter()
    for o in msgs:
        c = o["message"].get("content")
        if o["type"] == "assistant":
            r = reqs.setdefault(o["requestId"], {"prev": prev, "last": o["timestamp"], "out": 0})
            r["last"] = o["timestamp"]
            r["out"] = max(r["out"], o["message"].get("usage", {}).get("output_tokens", 0))
            for b in c if isinstance(c, list) else []:
                if b.get("type") == "tool_use": started[b["id"]] = (o["timestamp"], b)
        else:
            for b in c if isinstance(c, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result" and b["tool_use_id"] in started:
                    t0, tu = started[b["tool_use_id"]]
                    out["tool:" + classify(tu["name"], tu.get("input", {}))] += (P(o["timestamp"]) - P(t0)).total_seconds()
            prev = o["timestamp"]
    rl = list(reqs.values())
    for i, r in enumerate(rl):
        k = "model:closing" if i == len(rl) - 1 else ("model:writing" if r["out"] >= 400 else "model:short")
        out[k] += (P(r["last"]) - P(r["prev"])).total_seconds()
    return out
```
</details>
