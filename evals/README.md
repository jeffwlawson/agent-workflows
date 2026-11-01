# Prompt evals

Golden-PR evals for the `review` and `fix` prompts (#617). Each case replays a past pull request
whose outcome is known against the prompt file as it stands, and grades what the agent says. A
prompt change is then measured, before and after, instead of argued.

They are **run by hand**, and are in neither the verify command nor CI: every run is a full agent
session on your own credential, so the cost is real, and the output is not deterministic, so a
single red run proves nothing. What the verify command does hold is the layout
(`tests/evals.test.ts`): every case has its `case.yaml`, its graders, full SHAs and its brief, sets
every input the shipped prompt names, and holds no copy of a prompt. That test makes no model call
and touches no network.

## The cases

| Case | Replays | Head (the one the loop's review approved) | Graded on |
| --- | --- | --- | --- |
| `review/persisted-checkout-token` | #572 | `3586dd7` | the checkout persists a token the job can now push with; a re-run skips the install check |
| `review/restart-order` | #577 | `edb772f` | a failed worker restart still restarts the dispatcher; the recovery advice cannot run; `curl -L` can drop to http |
| `review/rescue-deleted-before-open` | #570 | `4d56bbc` | publish deletes the rescue before the pull request opens; a set-aside rescue is overwritten (#578) |
| `review/clean-doctor-service-guard` | #566 | `85a04f0` | **clean**: no finding to fix before merge, and approval |
| `fix/rescue-deleted-before-open` | #570 | `b41cecd` | the fix moves the deletion, adds or updates a test, and changes nothing else |

Each head is found from the `agent-review` status history: the commit where the verdict turned
success, before the merge-check (or a later round) found what it missed. **Not the merged head**,
which already holds the fix. Each case's `replay.yaml` says how its head was chosen.

The clean case is #566 because its approved head left no finding open and recorded no follow-up,
no maintainer review or merge-check finding is on it, its diff is code and tests, not only docs,
and **nothing merged since has had to fix it**: no later commit on `main` changes
`setup/doctor.ts` or `docs/ADOPTING.md`. A clean case needs all of these; a later fix means a
review that caught the defect is correct, and would be scored as a false finding. #568 was the
clean case first and was dropped for that reason (#584 fixed what it shipped).

## What a case is

```
evals/
  checkout.sh              the scaffold every case runs: a checkout of the pinned head
  <prompt>/
    suite.yaml             the run's limits and tools, the inputs every case shares, the replay note
    <case>/
      case.yaml            as `claude plugin eval` reads it
      replay.yaml          the pull request, its pinned base and head (full SHAs), the brief, the inputs
      inputs/<KEY>.md      one input each, named for the prompt's {{KEY}}
      graders/NN.md        one per expected outcome, each something observable in the output
```

A case holds **no prompt**. `claude plugin eval` takes a case's `prompt.md` as written, and a
runner's prompt is a template its runner fills in, so `scripts/eval-prompts.ts` renders
`review/prompt.md` or `fix/prompt.md` with the case's inputs into a staged copy of the suite at each
run, and runs the tool on that copy with the same `case.yaml` and graders. Editing the prompt file
changes the next run and nothing else needs updating; adding a `{{KEY}}` to it needs the input in
`suite.yaml` (or each case), which the layout test says.

The replay, against what the runner does:

- **The review is replayed as a first review** of the approved head: no history, nothing carried,
  no CI results, the red check off (as it is here), and no *since the brief* check, which would read
  the base branch's history. The diff is `git diff <base>...<head>`, the three-dot diff the runner
  takes. The pull request's body is reduced to a neutral one with an empty summary, since the
  merged body's summary describes the fixes.
- **The brief** is the linked issue as it stands now, with its comments, read through the review's
  own renderers when the case was written. Those inputs are pinned; only the prompt is live.
- **The second phase does not run.** The runner resumes the session to extract structured output;
  here, the replay note appended after the prompt asks for the findings (or, for fix, the diff and
  each thread's outcome) in the run itself, where the graders read them. Review graders read the
  last message; fix graders read the trace, which holds the diff.
- **The scaffold** (`evals/checkout.sh`) fetches both pinned commits from your clone, which the
  script first fetches from GitHub by SHA where they are missing, and checks out the head on the
  pull request's branch, with `origin/<branch>` at the head and `origin/main` at the base. Nothing
  depends on the current `main`.

This route is the fallback the issue allows, taken because the tool cannot render a runner's prompt
itself; it was written against Claude Code **2.1.290**.

## Running them

You need Claude Code logged in, a sandbox backend for its Bash tool (on Linux, `bubblewrap`; the tool
refuses a Bash grant it cannot confine), and network access to fetch the pinned commits.

```bash
node scripts/eval-prompts.ts review --model claude-opus-5-5 --max-cost-usd 60
node scripts/eval-prompts.ts fix    --model claude-opus-5-5 --max-cost-usd 20
```

- `--model` and `--max-cost-usd` are required. The model because a report says what it measured,
  and two runs only compare at the same one; the ceiling because a review of a large diff is a long
  session, and three runs of four cases is twelve. The ceilings above are a first guess: the first
  run's report states its cost, and the next ceiling is set from it. Hitting the ceiling stops
  launching runs and reports what finished (exit 2).
- `--runs <n>` overrides the case's runs (the tool's default, three).
- `--case <glob>` runs only the cases whose name matches.
- `--stage-only` renders and stages the cases and prints where, without running anything: what to
  read to see exactly what an agent is handed.

The script prints the `claude plugin eval` command it runs (with `--scaffold`, `--ablation none`,
`--no-publish`, and the tool grants from `suite.yaml`), then the report, which it also writes as
`report.md` in the stage directory. `node scripts/eval-prompts.ts report <stage-dir>` prints it again.

The report states, per case, the runs and each grader's pass rate (the catch rate); the
false-finding rate on the clean case (the share of finished runs that failed any of its graders);
the model; the Claude Code version; the cost; and the prompt's git revision: the last commit that
changed the file, the commit it was run from, the file's blob, and whether it had uncommitted
changes, so an *after* run of an edit not yet committed still names what it ran.

## Comparing a before and an after

1. On the commit before the change, run the prompt's cases.
2. On the change, run them again: the **same cases, the same `--runs` and the same `--model`**.
3. Paste both reports into the pull request. A grader whose rate moves by one run in three is
   within noise until a larger `--runs` says otherwise.

Some cases miss on today's prompt. That is expected, and is what the issues waiting on #617 (#612,
#613, #614, #615) set out to change.

## Another model

The same command with another `--model`, for example `--model claude-sonnet-5-5`. Compare it with a
report at the current model taken with the same cases and runs. The grader (`--judge-model` in the
tool, haiku by default) is left as it is, so only the model under test changes.

## Noise

Three runs per case until a report shows that is too few to tell a drop from variance. How much a
grader's rate moves between two runs of the same prompt on the same model is not measured yet; the
first repeated run should record it here.

## Adding a case

Make a folder beside the others with a `case.yaml`, a `replay.yaml` (the pull request, `base_ref`,
the full `base` and `head` SHAs, `brief`, and its short `inputs`), its long inputs under `inputs/`,
and one grader per outcome. Choose the head from the verdict status history, as above, and write
each grader as something a reader could check in the output, "however it is worded". A clean case
says `clean: true`, is a pull request nothing merged later had to fix (search `main`'s log for
its number and its files), and its graders all hold false findings. Run it with `--stage-only`
first and read the staged prompt.
