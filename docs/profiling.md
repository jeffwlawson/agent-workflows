# Profiling a workflow

How to find out where one of the loop's workflows spends its time, so each profiling ticket follows
the same method and lands on a finding of the same shape. It is a method, not a tool: whether a
script is worth writing is decided after one more workflow has been profiled this way.

The source of truth for what the agent did is its **session transcript**, the `agent-transcript`
artifact every run that starts an agent uploads (`docs/ADOPTING.md` §2d). Do not reconstruct the
agent's work from the job log; see *The traps*.

---

## 1. Choosing runs

- **Successful runs** of the workflow, several of them, so one slow outlier does not set the
  baseline. A run that failed early measures the failure, not the workflow.
- **Plus every run that timed out.** A run that reaches its `timeout-minutes` is *cancelled*, not
  failed, so filter on the cancelled conclusion and check the log ends at the timeout rather than at
  a human's cancel. These are the runs the profile exists for: they show what the workflow does
  when it is slowest.
- **Inside the retention window.** The transcript is kept three days by default
  (`transcript-retention-days`), and a repository or organization limit can make it shorter.
  Download the artifact when you choose the run, not when you get to it. A run whose transcript has
  expired can still give step timings, but not the agent's own breakdown, so leave it out.

Record, for each run: its id, the workflow, the conclusion, and the Claude Code version (§5).

## 2. Where the timings come from

Two sources, one for each level.

**Step timings: the jobs API.** Every job's steps, with `started_at` and `completed_at`:

```bash
gh api "repos/{owner}/{repo}/actions/runs/<run-id>/jobs" \
  --jq '.jobs[] | {job: .name, steps: [.steps[] | {name, started_at, completed_at, conclusion}]}'
```

This splits the run into setup (checkout, installs), the agent step, and what follows it. Queue
time is the gap between a job's `created_at` and its `started_at`, and belongs in the profile as its
own bucket rather than folded into the first step.

**The agent's own time: the session transcript.**

```bash
gh run download <run-id> --name agent-transcript --dir transcript/<run-id>
```

It is Claude Code's JSONL, one event per line, each with a `timestamp`. An agent that spawned
subagents leaves more than one file, and all of them are uploaded; count each subagent's time
inside the parent's `Agent` call that waited on it, not again beside it. From the transcript:

- **turns**: each assistant message, and the time from the previous event to it, which is
  generation time;
- **tool calls**: each `tool_use` block and its matching `tool_result` (by `tool_use_id`), the
  difference being the tool's own time. Group by tool name, and for `Bash` by what was run;
- **thinking**: the `thinking` blocks, counted and sized, since a long one is a long turn;
- **token usage**: each assistant message's `usage`, input, output, and cache read and creation
  separately. Cache reads are cheap and fast; a run that keeps missing the cache is a finding.

The agent step's duration from the jobs API, minus the span the transcript covers, is the runner's
overhead around the agent (starting it, collecting its output). Check that it is small rather than
assuming it.

## 3. Sizing the work

A profile says how long a workflow took **for how much work**, so the work needs a size. Use the
**run's own commits**: the commits that run made on the branch, from the base it started on to the
last commit it produced.

```bash
git diff --shortstat <base>..<run's last commit>
git log --oneline <base>..<run's last commit>
```

Not the PR's totals. A PR accumulates every round that touched it (§5), so its files-changed and
line counts describe the work of several runs.

## 4. Timing the gate separately

The verify command `CLAUDE.md` names is run by the agent, usually more than once, and its time is
part of the agent's. Time it on its own as well, so a slow gate is not mistaken for a slow agent:

- **per file**, from CI's test step on the same commit: the test runner's default reporter prints
  each test file with its duration. That is the gate's cost outside the agent, on a runner of the
  same kind;
- **per invocation inside the run**, from the transcript: each `Bash` call that ran the gate, and
  its time. The count matters as much as the time; a gate run five times is five times its cost.

A gate whose time is dominated by a few files is a finding about those files, not the workflow.

## 5. The traps

- **The job log shows only `Bash`, `WebFetch`, `WebSearch` and `Agent` calls.** File reads,
  edits, writes and searches never appear in it, nor does thinking. A profile built from the log
  attributes their time to whatever was printed next. Use the transcript.
- **Timestamps are UTC**, in the jobs API, the transcript and the log alike. Convert nothing until
  the end, and convert everything then, or two sources disagree by your offset.
- **"Agent idle" lines mean one long generation**, not a stalled agent. The log prints them while
  the model is producing a single turn with no output in between, often a long thinking block or a
  large file written in one call. In the transcript that is one turn, and it belongs in the
  generation bucket.
- **Claude Code is installed unpinned.** Each agent workflow runs `npm install -g
  @anthropic-ai/claude-code`, so two runs a week apart may be different versions. Record the
  version for every run, from the install step's log or the `version` field on the transcript's
  events, and compare runs of the same version, or say that you did not.
- **PR totals include fix rounds.** A PR's commits, diff size and wall-clock time span its
  implement run and every fix and update-branch round after it. Size and time one run (§3).

## 6. The shape of a finding

A finding is posted on the profiling ticket in two parts.

**A time breakdown by bucket**, per run and as a median across the runs chosen:

| Bucket | Source |
|---|---|
| queue | jobs API, `created_at` to `started_at` |
| setup | jobs API, steps before the agent step |
| agent: generation | transcript, time to each assistant turn |
| agent: tools, by tool | transcript, `tool_use` to `tool_result` |
| agent: gate | transcript, the `Bash` calls that ran the gate |
| after the agent | jobs API, steps after the agent step, and any later job |

With the run's size (§3), its token usage, and its Claude Code version beside it.

**Then candidate changes**, each with:

- **estimated saving**: in minutes, and which bucket it comes out of;
- **risk**: what could break, and what would show it;
- **effort**: roughly how big the change is, and in which part (`CONTEXT.md`, *three parts*).

Ranked by saving against risk and effort. A candidate is a proposal for a ticket, not a change made
from the profile.
