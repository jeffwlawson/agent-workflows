# Profile fix: where an agent-fix run spends its time

Research for #278, on the profiling map #267, following the method in #267's Notes and the shape of
#268's answer. Gathered 2026-10-02 (UTC 2026-10-03 00:xx), against `origin/main` at `8f3032e` (v0.7.9).

## The sample

`gh run list --workflow agent-fix.yml --limit 300` reaches back to 2026-09-20 and holds **90 runs that
did work** and 210 skipped (another label's event on the PR). No run in the window failed, was
cancelled or timed out, and none was refused or had nothing to do: all 90 ran the agent.

| Set | Runs | Dates | Shape | Source |
|---|---|---|---|---|
| A. v0.7.8 with transcript | 5 | 10/02 21:46Z to 10/03 00:03Z | `gate` / `fix` / `publish` (#311) | `agent-transcript` artifact + job steps |
| B. Opus 5.5, single job | 43 | 9/29 to 10/02 | one job | job steps + sandcastle display log |
| C. Opus 5, single job | 42 | 9/20 to 9/28 | one job | job steps + sandcastle display log |

Set A is [37068824712](https://github.com/jeffwlawson/agent-workflows/actions/runs/37068824712),
[37072145411](https://github.com/jeffwlawson/agent-workflows/actions/runs/37072145411),
[37075395856](https://github.com/jeffwlawson/agent-workflows/actions/runs/37075395856),
[37077969658](https://github.com/jeffwlawson/agent-workflows/actions/runs/37077969658) and
[37080387169](https://github.com/jeffwlawson/agent-workflows/actions/runs/37080387169) (PRs #327 and #330).
Every one is `claude-opus-5-5 (default)` on Claude Code 2.1.288; package 0.7.8.

**The caller is gone.** v0.7.9 (#330) folded `agent-fix.yml` into `agent-pr.yml`, so later fix runs are
the `fix` jobs of an *Agent PR* run. A follow-up profile has to filter `agent-pr.yml` runs by job.

**Traps checked** (#267): job and transcript timestamps are both UTC; model from the `Agent model:` line
(Opus 5 until 9/28, Opus 5.5 from 9/29; one run set `AGENT_MODEL_FIX`); Claude Code version from the
install log (2.1.278 to 2.1.288, unpinned). Step timings from the jobs API are whole seconds.

## Answer in one paragraph

A fix run is short: **median 2 min 23 s end to end** in the Opus 5.5 era (n=48, p90 3 min 47 s,
max 7 min 55 s), against a 30-minute limit. Model turns are the largest bucket (about 40%), and the
**one full verify each run makes is the second (about 22%, 30 to 51 s)**: the test suite now costs a
fix run nearly as much as the agent's own thinking does. The #311 split added **about 16 s** of runner
hand-offs (about 11%). Two changes save time without touching a guard: the test-suite speedup already
filed (#271, about 12 to 16 s on a typical run), and dropping the closing summary the fix agent writes
before the extraction pass asks for the same thing again (about 9 s on every run, not yet filed).

## Where the time goes

### Set A: the five transcript runs, every second accounted for

The transcript splits the agent step properly: each assistant message's timestamp minus the previous
event is model time; each tool result's timestamp minus its `tool_use` is tool time. The workflow
buckets come from the jobs API.

| Bucket | 24712 | 45411 | 95856 | 69658 | 87169 | Median | Share of total |
|---|---|---|---|---|---|---|---|
| **Wall clock, event to `publish` end** | **134** | **160** | **315** | **167** | **117** | **160** | 100% |
| Queue before `gate` | 3 | 2 | 3 | 4 | 2 | 3 | 1.6% |
| `gate` job | 8 | 8 | 9 | 6 | 10 | 8 | 4.6% |
| Queue, `gate` to `fix` | 2 | 3 | 4 | 4 | 2 | 3 | 1.7% |
| `fix` setup (checkout, Node, `npm ci`, Claude Code install) | 8 | 11 | 12 | 12 | 9 | 11 | 5.8% |
| Runner start, feedback fetch, `claude` start | 3.8 | 4.3 | 5.1 | 5.4 | 4.7 | 4.7 | 2.6% |
| **Model: working turns** (thinking, reading, writing edits) | 36.2 | 59.1 | 158.9 | 41.9 | 19.5 | 41.9 | **35.4%** |
| **Model: closing summary** | 8.1 | 9.0 | 8.7 | 8.9 | 7.0 | 8.7 | **4.7%** |
| **Tool: full verify** (one call per run) | 30.5 | 30.9 | 49.8 | 51.0 | 32.3 | 32.3 | **21.8%** |
| Tool: targeted test runs | 1.3 | 2.9 | 33.5 | 0 | 0 | 1.3 | 4.2% |
| Tool: everything else (`sed`, `grep`, edits, `git commit`) | 0.3 | 1.3 | 1.4 | 0.6 | 0.7 | 0.7 | 0.5% |
| Extraction pass (`shared/run-with-extraction.ts`) | 6.8 | 4.9 | 4.6 | 7.3 | 4.7 | 4.9 | 3.2% |
| `fix` after the agent (redact, upload transcript, bundle, hand over) | 5 | 5 | 7 | 6 | 5 | 5 | 3.1% |
| Queue, `fix` to `publish` | 3 | 2 | 2 | 2 | 2 | 2 | 1.2% |
| `publish` job | 18 | 16 | 16 | 18 | 18 | 18 | 9.6% |

What the transcripts show that the job log cannot:

- **Tool time other than tests is negligible.** 43 tool calls across the five runs, 4.3 s in total. The
  agent reads with `sed -n`/`grep` and edits with `python3` heredocs through `Bash`; it made one `Edit`
  call and no `Read`, `Grep` or `Write` calls at all. So #267's caveat that hidden calls sit inside the
  printed gaps does not bite on fix: the gaps really are model time.
- **Every run verifies exactly once**, then commits once, then writes a summary. The 49.8 s and 51.0 s
  verifies are the same command on the same suite; the spread is the runner.
- **The targeted runs that cost anything are `tests/workflows.test.ts`**: two runs of it in 95856 took
  16.8 s and 16.7 s, about half a full verify each.
- **The closing summary is 1,700 to 2,500 characters** of prose (670 to 890 output tokens): what was
  fixed, then "Thread outcomes" and "Conversation comments" listing each id and its reply. The very next
  step, the extraction pass, asks for those outcomes again as the `<output>` block that `fix/fix.ts`
  actually reads (`result.output`); nothing reads the produce pass's final text.
- **The prompt is large but does not slow the turns.** Turn 1 writes 25,000 to 255,000 tokens to the
  cache (the PR diff is inlined; #330 is a PRD branch), and later turns read it back. Output speed is
  about the same at 40,000 and at 270,000 tokens of context (roughly 100 to 140 tokens/s), so this is a
  cost question, not a time one.
- **The agent does not re-read `CLAUDE.md`**, though `fix/prompt.md` says to read it first. Across all
  90 logs no call reads `CLAUDE.md`; 10 read `CONTEXT.md`. So the line #272 removes from implement
  costs fix nothing today.

### Sets B and C: the baseline from job logs

From the sandcastle display (Bash calls only, each gap = command plus the start of the next turn) and the
jobs API. The display truncates a long multi-line command, so a verify chained after a `python3` heredoc
edit is sometimes missed: the log counts are lower bounds.

| | Opus 5, single job (n=42) | Opus 5.5, single job (n=43) | Opus 5.5, three jobs (n=5) |
|---|---|---|---|
| Wall clock, median (p90, max) | 302 s (711, 1369) | 134 s (216, 475) | 160 s (315, 315) |
| Agent step, median (p90, max) | 266 s (679, 1298) | 102 s (189, 444) | 113 s (262, 262) |
| Extraction pass, median | 7.4 s | 4.2 s | 4.9 s |
| Everything outside the agent step, median | 29 s | 32 s | **48 s** |
| Full verifies per run, median (max) | 2 (4) | 1 (2) | 1 (1) |
| Seconds per full verify, median | 17 s | 24 s, rising to 35 s on 10/01 | 32 s |
| Test commands' share of agent time (a lower bound; see above) | 14% | 26% | 23% |
| Printed tool calls, median | 23 | 8 | 5 |
| Review items answered per run, median (max) | 2 (15) | 1 (4) | 1 (2) |

- **Run length follows the number of findings, not the model.** Both eras spend about 85 s per thread
  or conversation item answered (median). Opus 5 rounds carried more findings (up to 15); Opus 5.5 rounds
  carry 1 to 4. The same conclusion #268 reached for implement.
- **The suite is the part growing.** A full verify in a fix run took 13 to 17 s on 9/21 to 9/23 and 30 to
  36 s on 10/01 to 10/03. CI's `Test` step at `8f3032e` ([run 37081629970](https://github.com/jeffwlawson/agent-workflows/actions/runs/37081629970))
  takes 46.7 s, and its three slowest files are `implement-prd-preflight.test.ts` (27.2 s),
  `review-ci-wait.test.ts` (25.9 s) and **`workflows.test.ts` (22.8 s, up from the 3.0 s #271 measured)**.
- **No fix run came near the limit.** The longest agent step in 90 runs is 21.6 min (Opus 5, 9/23,
  a 15-finding round); in the Opus 5.5 era it is 7.4 min.

### What the #311 split costs

Everything outside the agent step went from **32 s to 48 s median: about 16 s, 11% of a typical run.**

| Where | Single job | Three jobs | Change |
|---|---|---|---|
| Queue before the first job | 3 | 3 | 0 |
| `gate` job (pre-flight 1, labels 4 to 5, review-post wait 1, job set-up/teardown 1 to 2) | in `fix` setup | 8 | +2 for its own runner |
| Queue, `gate` to `fix` | n/a | 3 | +3 |
| `fix` setup | 16 to 17 | 11 | -6 (the gate's steps moved out) |
| `fix` after the agent | 11 to 12 | 5 | -6 (the publish steps moved out) |
| Transcript redact and upload, bundle and hand-over | n/a | 2 to 3 | +2 to 3 |
| Queue, `fix` to `publish` | n/a | 2 | +2 |
| `publish` job (artifact download 1, second checkout 2, set-up 1, then the steps that used to run in `fix`) | in `fix` | 16 to 18 | +5 to 6 for its own runner |

So the split's price is two runner provisions (about 5 s of queue), two job set-ups (about 3 s), a
second checkout (2 s) and the artifact round trip (about 3 s). That is the cost of the agent's job
holding nothing it could write with (`fix.yml`'s note above `jobs:`), and none of it can go without
giving that up.

## What can be cut, with estimated savings

"Typical" is the Opus 5.5 median, about 2.5 min. "Largest" is the p90 and above, 4 to 8 min, with two
verifies and targeted runs of `workflows.test.ts`.

| Change | Typical run | Largest runs | Risk | Effort | Status |
|---|---|---|---|---|---|
| Test-suite speedup | 12 to 16 s | 25 to 35 s | low | covered | **covered by #271** |
| Fix prompt: no closing summary before the extraction pass | 7 to 9 s | 7 to 9 s | low | small | **proposed new issue** |
| Faster CI after the fix's push, so the re-review starts sooner | 15 to 20 s per round, outside this run | same | low | covered | **covered by #271 and #273** |
| Rescue and resume at the time limit | 0 | a whole run and its retry, if one ever times out | medium | covered | **covered by #303**, with the design notes below |

Altogether, about 2 min 40 s becomes about 2 min 15 s on a typical run (about 15%); the gain on a large
run is 35 to 45 s.

### Test-suite speedup (#271): 12 to 16 s typical, 25 to 35 s large

- Fix runs verify about once each (74 of 90 show it in the log; the display truncates a long multi-line
  command, and two of the other 16 are transcript runs that did verify), and the verify is the one
  command the prompt requires. #271 expects a full verify to drop from about 32 s to about 20 s,
  and the YAML-parse cache takes the 16.7 s targeted runs of `workflows.test.ts` down to a few seconds.
- **#271's figures are stale, in its favour.** It was measured with `workflows.test.ts` at 3.0 s; that file
  is now 22.8 s on CI and was half the targeted test time in run 95856. Parsing each YAML text once is now
  the largest single item in #271 for fix, and probably for implement too. Worth re-measuring when it is
  picked up.

### Fix prompt: no closing summary (proposed new issue)

- **Measured:** 7.0 to 9.0 s in each of the five transcript runs (median 8.7 s, 5% of the wall clock),
  every run, whatever its size.
- **Why it is safe:** `fix/fix.ts` keeps only `result.output`, which comes from the extraction pass
  (`shared/run-with-extraction.ts` returns `{ ...produce, output: extraction.output }`). The extraction
  pass resumes the same session, so every commit, tool call and decision is already in its context; the
  summary only repeats them. The same guard stays: thread outcomes, conversation outcomes, top-level
  comments and out-of-scope notes are all still produced, and still filtered by the same code.
- **What must stay:** `<promise>COMPLETE</promise>`, for the reason #272 gives (sandcastle's grace period
  for a process that hangs after finishing). And "keep track as you go of which thread each change
  answers", which is what the extraction pass draws on.
- **#272 does not cover it:** its *Out of scope* names "the fix and update-branch prompts" explicitly.

### Considered and not worth doing

- **Targeted tests while iterating, one verify at the end (#272's testing item, for fix).** Fix runs
  already verify once: 6 of 48 Opus 5.5 runs verified twice, none more. Expected saving under 3 s per run.
- **"`CLAUDE.md` is already loaded" (#272's third item, for fix).** No fix run reads it. Nothing to save.
- **Merging the extraction pass into the produce pass.** The `<output>` block still has to be written;
  only the second `claude` start (under 1 s) would go, and the retrying extraction is what makes the
  structured output reliable.
- **Skipping `agent:blocked`'s removal in `gate` when it is absent** (#273's second item, applied to
  fix). About 2.5 s per run; `gh pr edit` is the slow call (2.5 s each, 4 to 5 s for the two). Folds into
  #273 if that is widened, not worth an issue of its own. Fewer label calls in `Request re-review` (5 s)
  conflicts with the remove-first rule (#236).
- **Starting `fix`'s checkout while `gate` runs.** `needs: gate` is the guard that keeps a fork, a stale
  head or a closed PR from getting a runner with the agent on it. Saves about 8 s and removes a guard.
- **Undoing the #311 split.** About 16 s; removes the guard it exists for.
- **A shallow checkout in `publish`, caching the Claude Code install.** 1 to 2 s each.
- **Trimming the inlined PR diff.** Large prompts do not slow the turns (above); a cost question, and
  the diff is what the agent works from.
- **Fast mode.** Out of scope by decision (#267).

## Bearing on the map's fog

### A runner-side deadline (depends on #274)

- **Fix has never needed one.** 0 timeouts in 90 runs; longest agent step 21.6 min (Opus 5), 7.4 min
  since 9/29. A deadline here is insurance for a large round, not a fix for something seen.
- **It needs a small margin.** After the agent stops, the `fix` job needs the extraction pass (p90 6.5 s,
  max 37 s across 90 runs) and about 5 to 7 s to redact, upload and bundle. Pushing, replying and
  rescuing happen in `publish`, which has its own 15-minute limit. So a deadline of the job limit minus
  about 2 minutes leaves room, where implement's single job would need room for its push and PR as well.
- **On a deadline, skip the extraction pass.** Outcomes from an interrupted run would claim threads
  addressed on work that goes to a rescue branch, not the PR (#303). The job should go straight to
  bundling.

### Does the test-suite speedup matter elsewhere?

**Yes, for fix, more than for implement in relative terms.** Tests are 23 to 26% of a fix run's agent
time (14% in the Opus 5 era, when the suite was half the size and the rounds were bigger), against 17%
for implement in #268. Fix rounds are short, so the one verify they must run is a large fraction of them.
It also matters twice per round: each fix that pushes starts CI, and the re-review waits on it (#273's
poll), with CI's `Test` step now 46.7 s.

## Interaction with rescue and resume (#302, #303)

#303 was written before the #311 split, and the split changes where its pieces go:

1. **The rescue must come from the bundle, in `publish`.** The `fix` job holds a read-only token and no
   PAT, so it cannot push a rescue branch. `Bundle the branch` is `if: success()` (`fix.yml`, around line
   530), so a timed-out or failed `fix` job hands over no commits today. #303 needs that step to run on a
   failed or timed-out job too (`always()`, like the hand-over step after it), so the commits reach
   `publish`, whose `if: always() && …` already runs after a failed `fix`. Whether a job cancelled by
   `timeout-minutes` still runs its `always()` steps, and for how long, is worth probing before relying
   on it.
2. **The extraction pass should not run on a rescued run** (see the deadline above), so the bundle is the
   only thing a rescue hands over.
3. **Deleting the rescue branch on every successful run costs a call.** `gate` already runs one
   `git ls-remote` for the PR head; asking for `refs/heads/agent/rescue/fix-<pr>` in the same call tells
   `publish` whether there is anything to delete, so the common case (no rescue) adds no request.
4. **Commit early costs fix nothing.** Fix runs already commit right after their one verify, so #303's
   prompt line changes little here. A resumed run's mandatory verify costs one more (30 to 50 s now,
   about 20 s after #271).

None of this changes the saving estimates above; none of the proposed changes touches the failure path.

## Method notes for #276

- **Transcripts make the log parsing unnecessary for fix.** One `.jsonl` per run holds both passes (the
  extraction resumes the session; its prompt starts "Emit a single `<output>` block"). Group assistant
  entries by `message.id` to count one API response once.
- The artifact is a directory, `-home-runner-work-<repo>-<repo>/<session>.jsonl`, and expires 3 days
  after the run (`transcript-retention-days`).

<details><summary>The transcript parser (tx.py)</summary>

```python
"""Split each fix session transcript into model time and tool time, by tool kind."""
import json, glob, os, re, collections
from datetime import datetime
S = os.path.dirname(os.path.abspath(__file__))

def ts(s): return datetime.strptime(s[:23], "%Y-%m-%dT%H:%M:%S.%f")

def classify_bash(c):
    if re.search(r"npm run verify", c): return "bash:verify"
    if re.search(r"npm (run )?test\b|npx vitest run\s*(\||;|&|2>|$|--reporter|\))|vitest run\s*(\||;|&|2>|$|\))", c): return "bash:fulltest"
    if re.search(r"vitest", c): return "bash:targeted-test"
    if re.search(r"npm run typecheck|tsc\b", c): return "bash:typecheck"
    if re.search(r"npm run build", c): return "bash:build"
    if re.search(r"^\s*git\b|&&\s*git\b", c): return "bash:git"
    return "bash:other"

def parse(path):
    ev = [json.loads(l) for l in open(path)]
    ev = [x for x in ev if x.get("timestamp") and x.get("type") in ("user", "assistant")]
    out, tool_use_at, phase, last = collections.defaultdict(float), {}, "produce", None
    for i, x in enumerate(ev):
        t, c = ts(x["timestamp"]), x["message"].get("content")
        if x["type"] == "user" and isinstance(c, str):          # a prompt: produce, then extract
            if i > 0: phase = "extract"; out["between-phases"] += (t - last).total_seconds()
            last = t; continue
        if x["type"] == "assistant":                           # model time since the last event
            out[f"{phase}:model"] += (t - last).total_seconds()
            for b in c:
                if b.get("type") == "tool_use":
                    kind = classify_bash(b["input"].get("command", "")) if b["name"] == "Bash" else b["name"]
                    tool_use_at[b["id"]] = kind
        else:                                                  # tool results: tool time
            kinds = {tool_use_at.get(b["tool_use_id"]) for b in c if b.get("type") == "tool_result"}
            k = kinds.pop() if len(kinds) == 1 else "parallel"
            out[f"{phase}:tool:{k}"] += (t - last).total_seconds()
        last = t
    return dict(out)

for p in sorted(glob.glob(f"{S}/tx/*/*/*.jsonl")):
    print(p.split("/tx/")[1].split("/")[0], parse(p))
```
</details>
