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
  each thread's outcome) in the run itself, where the graders read them. Both prompts' graders
  read the last message. A fix run's change is graded as the working-tree diff that message
  prints, not as a commit, which a fix replay cannot make (below).
- **The scaffold** (`evals/checkout.sh`) fetches both pinned commits from your clone, which the
  script first fetches from GitHub by SHA where they are missing, and checks out the head on the
  pull request's branch, with `origin/<branch>` at the head and `origin/main` at the base. Nothing
  depends on the current `main`.

This route is the fallback the issue allows, taken because the tool cannot render a runner's prompt
itself; it was written against Claude Code **2.1.290**.

## What a fix replay cannot exercise

Found from 26 of 26 fix runs whose final message said so (`docs/audits/2026-11-02/evals.md`, 3.2),
and from the code of `claude plugin eval` 2.1.316 (#716):

- **The run cannot commit.** The tool runs each case in `<tmp>/claude-eval-*/home/cwd` and denies
  the agent writes to `.git`, `HEAD`, `objects`, `refs` and `commondir` there, as Edit deny rules
  the Bash sandbox turns into read-only binds: `git commit` fails with `Unable to create
  '.git/index.lock': Read-only file system`. That is the tool's own rule, with no case or suite
  setting that lifts it, so the scaffold cannot fix it. The replay note says so, has the run print
  the working tree's diff against the head (untracked files included) and the commit message it
  would have written, and the graders read those from the final message. Fix reports run before
  this change graded "the committed change" and are not comparable with later ones; fix grader 01
  passed 1 of 26 under that wording.
- **The run cannot run the tests or the typecheck.** The runs report no `npm`, and no `vitest` or
  `tsc` in `node_modules`, though the scaffold copies the clone's `node_modules` or installs it
  from the lockfile. The cause is not found: no run could be made where this was written (no
  credential), and the stored traces were cleared. The likeliest is the sandbox's read rules,
  which allow the run's own home and temp directories and deny the operator's home, where a Node
  installed by a version manager sits; Claude Code also write-protects `node_modules/.bin`. One
  case with `--keep-temp` and a Bash call to `command -v node npm; ls -la node_modules/.bin` would
  settle it.

So these instructions in `fix/prompt.md` are not exercised, and no grader may rest on them: making
a commit and anything only its message carries; running the verify command before committing; and
taking a behaviour finding red on the given head, *run it and see it fail* (#700). A run that says
it could not do one of these is telling the truth about this sandbox, not about the prompt. What a
fix replay measures is the change it leaves and what it says about it.

The graders were checked by hand against the change that shipped for the case, `ba76218` on #570:
read as a working-tree diff, it meets 01 (the deletion moved after `state.pr = pr; record();`), 02
(two tests that a failed open keeps the rescue) and 03 (its other files change only comments and
docs naming publish's order). No judge model was run on it.

## Running them

You need Claude Code logged in, a sandbox backend for its Bash tool (on Linux, `bubblewrap`; the tool
refuses a Bash grant it cannot confine), and network access to fetch the pinned commits.

```bash
node scripts/eval-prompts.ts review --model claude-opus-5-5 --max-cost-usd 60
node scripts/eval-prompts.ts fix    --model claude-opus-5-5 --max-cost-usd 20
node scripts/eval-prompts.ts ab review origin/main --model claude-opus-5-5 --max-cost-usd 30 --case persisted-checkout-token,clean-doctor-service-guard --runs 6 -j 4
node scripts/eval-prompts.ts noise fix --model claude-opus-5-5 --max-cost-usd 25 --runs 6 -j 4
node scripts/eval-prompts.ts compare <run-dir> --primary persisted-checkout-token/01 --guard clean-doctor-service-guard/01
node scripts/eval-prompts.ts compare --before <run-dir> --after <run-dir>
node scripts/eval-prompts.ts report <run-dir>
```

- `--model` and `--max-cost-usd` are required. The model because a report says what it measured,
  and two runs only compare at the same one; the ceiling because a review of a large diff is a long
  session, and three runs of four cases is twelve. The ceilings above are a first guess: a report
  states its cost, and the next ceiling is set from it. Hitting the ceiling stops launching runs and
  reports what finished (exit 2). As measured, a review case-run costs about $0.82 and a fix
  case-run about $1.8, judge included.
- `--runs <n>` overrides the case's runs (the tool's default, three).
- `--case <glob>[,<glob>...]` runs only the cases whose name matches one of the globs (`*` and `?`).
- `-j <n>` (`--concurrency`) runs up to `n` agent runs at once (the tool allows 1 to 8, default 1).
  They share one rate limit, so a plan near its limit errors runs that a sequential session would
  finish; an errored run is out of every denominator (below), but it is still a run you paid for.
  The review suite takes about 25 minutes at `-j 1`.
- `--stage-only` renders and stages the cases and prints where, without running anything: what to
  read to see exactly what an agent is handed. A stage alone goes to the temp dir and is not kept.

`ab <prompt> <ref>` runs **both arms in one session**: every case is staged twice, as
`<case>.before` with the prompt file as it is at `<ref>` (`git show`) and as `<case>.after` with the
working tree's, against the same cases, graders and inputs, and the tool runs them together. With
`-j` the arms interleave in time, so drift in the model or the service falls on both. `noise
<prompt>` does the same with the working tree's prompt in both arms (`.a` and `.b`): an A/A run,
whose differences are all noise.

The script prints the `claude plugin eval` command it runs (with `--scaffold`, `--ablation none`,
`--no-publish`, `--keep-temp`, and the tool grants from `suite.yaml`), then the report.

### The run directory

Every run is kept in a **run directory**, which the report names: under `$EVAL_RUNS_DIR`, else
`~/.cache/agent-workflows/evals/` (`$XDG_CACHE_HOME` if set), one directory per session, named
`<UTC time>-<run|ab|noise>-<prompt>-<suffix>`. Not the checkout, whose `evals/` the layout test reads,
and not `/tmp`, which is cleared. It holds:

- `stage.json`: the prompt revision of each arm (blob included) and, per staged case, the case it
  came from, its arm and **each grader file's blob hash**;
- `evals/`: the staged suite exactly as the agent was handed it;
- `result.json`: the tool's own result, with each grader's capped `evidence` (the judge's input);
- `traces/<case>/<run>.jsonl`: each run's full trace. The tool deletes a run's sandbox, trace
  included, unless given `--keep-temp`, so the script passes it, copies each trace out, and removes
  the `claude-eval-*` sandbox it came from. A sandbox with no trace (a run that never started) is
  left in the temp dir;
- `runs.json`: one record per run, which `compare` reads: case, arm, prompt blob, model, judge
  model, Claude Code version, error, cost, judge cost, turns, trace, and per grader its result, its
  file hash and the judge's votes;
- `tool/`: the tool's `aggregate-result.json` and HTML report;
- `report.md`: the report, which `report <run-dir>` prints again.

The report states, per case, the runs and each grader's pass rate (the catch rate) **of the runs
that completed**: an errored run measured nothing, so it is counted beside the runs and is in no
denominator. Then the false-finding rate on the clean case (the share of completed runs that failed
any of its graders); the model; the Claude Code version; the cost; the run directory; and the
prompt's git revision, per arm: the last commit that changed the file, the commit it was run from,
the file's blob, and whether it had uncommitted changes, so an *after* run of an edit not yet
committed still names what it ran. An `ab` or `noise` run's report ends with its comparison.

### `compare`

`compare <run-dir>` compares an `ab` or `noise` run's two arms. `compare --before <run-dir>
--after <run-dir>` compares two sessions; name `--before` or `--after` more than once to pool, and
name an arm of a two-arm run as `<run-dir>#before`. Per case and grader it gives each side's passed
of completed runs, the Wilson 95% interval, errored runs beside it, and the **exact two-sided
Fisher p**.

A side holding more than one session is labelled **pooled**, with the sessions named, and may hold
only one prompt blob. It refuses sides of different models, judge models or Claude Code versions,
and a grader whose file hash differs between them: those compare something other than the prompt.
A run made before run directories existed has no grader hashes, which the comparison says.

`--primary <case>/<grader>` and `--guard <case>/<grader>` (each repeatable) mark the graders declared
before the run. Only they get a verdict: `rose` or `fell` at p < 0.029, `not shown` otherwise, and
`void` where a side has two or more errored runs of the case. Every other row says `descriptive`.

## Comparing a before and an after: the protocol

This is the rule a prompt change is measured by. It is fixed before any run, so that what is
reported does not depend on what was seen.

1. **Declare, in the pull request and before running**, one **primary** grader (the outcome the
   change sets out to move) and the **guards** (the outcomes it must not break: at least the clean
   case's grader). Every other row is descriptive, however it moves. With a dozen live graders in a
   report, one of them moving by chance is the expected case; naming one in advance is what makes
   its p-value mean what it says.
2. **Run both arms in the same session**: `ab <prompt> <ref-before>` with `-j 2` or more, on the
   cases the primary and the guards are on, **6 runs per arm** (`--runs 6`). A before taken another
   day is a different session, and the model, the service and the time of day differ with it.
3. **Extend to 12 per arm only if ambiguous**: if the primary or a guard has p < 0.10 but not
   p < 0.029, run that case once more with `--runs 6` in another `ab` session and pool the two
   (`compare --before a#before --before b#before --after a#after --after b#after`). Not the
   whole suite: only that case. That is the one pooling decided in advance.
4. **Call an effect only at two-sided p < 0.029**, at either look. That is a Pocock boundary for two
   looks: with the exact test, which is conservative, it holds the chance of a false call under 5%
   across both.
5. **Errored runs are out of the denominator.** Re-run an errored run once; two or more errors on one
   side of a case void that side (`void`), and it is run again rather than read.
6. **Never pool runs after seeing a result to reach a boundary.** Pooling a different session's
   runs is allowed only for the same prompt blob, model, judge, Claude Code and grader files (which
   `compare` enforces), is labelled pooled, and is decided before the result it would change is
   seen. The #700 pooled 7/9 against 2/9 reached p = 0.057 only by adding a 3-run set; the 6-run set
   alone was 4/6 against 1/6, p = 0.24.
7. **Paste the comparison into the pull request**, with the primary and guards it declared.

**The words to use.** At p < 0.029 on a primary or guard: the grader *rose* or *fell*, with both
counts and p. Otherwise it is **not shown**: write "not shown (4/6 against 1/6, p = 0.24)", never
"within noise", "no change", "no regression" or "suggestive". A result that is not shown is not
evidence of no effect; at these sample sizes a real effect of a third is usually not shown. A
descriptive row is reported with its counts and no word of verdict.

### The sample-size arithmetic

With 3 runs per arm no result reaches p < 0.05: the best case, 3/3 against 0/3, has two-sided
Fisher p = 2 / C(6, 3) = 0.10. The smallest results that clear each boundary, from `fisher` in
`scripts/eval-prompts.ts` (the tests hold its figures), as passes low against high at n per arm:

| Runs per arm | Two-sided p < 0.05 | p < 0.029 (the boundary) |
| --- | --- | --- |
| 3 | none | none |
| 4 | 0 against 4 | 0 against 4 |
| 6 | 0 against 5, 1 against 6 | 0 against 5, 1 against 6 |
| 9 | 0-5, 1-6, 2-8, 3-8, 4-9 | 0-6, 1-7, 2-8, 3-9 |
| 12 | 0-5, 1-7, 2-8, 3-9, 4-10, 5-11, 6-12, 7-12 | 0-6, 1-7, 2-9, 3-10, 4-11, 5-11, 6-12 |

Runs per arm for 80% power at two-sided 5%, by the normal approximation n = (1.96 + 0.84)^2 (p1 q1
+ p2 q2) / (p1 - p2)^2 and by exact-Fisher enumeration, which is larger at small n
(`docs/audits/2026-11-02/evals.md`, 4.3; cost is n x 2 arms x one case-run):

| Effect | Normal | Exact | Cost, review | Cost, fix |
| --- | --- | --- | --- | --- |
| 0.67 to 0.33 | 30 | 39 | $64 | $134 |
| 0.75 to 0.25 | 12 | 18 | $30 | $62 |
| 0.78 to 0.22 (fix 02 as measured on #700) | 9 | 13 | $21 | $45 |
| 0.44 to 0.00 (`persisted` 01, #697) | 10 | 14 | $23 | $48 |
| 0.67 to 0.00 | 4 | 9 | $15 | $31 |
| 1.00 to 0.50 (a guard falls by half) | 8 | 12 | $20 | $41 |

So 6 then 12 per arm detects a collapse (1.0 to 0.5, 0.67 to 0) and a large swing, and a change of a
third is not measurable at this price. The audit's simulation of the two-look rule: false calls
1.3 to 1.4% under no change; power 94% for 0.67 to 0.00, 50% for 0.67 to 0.17, 47% for 0.75 to
0.25, 20% for 0.5 to 0.17. Those figures assume independent runs and one fixed pass rate per case.

Some cases miss on today's prompt. That is expected, and is what the issues waiting on #617 (#612,
#613, #614, #615) set out to change. [`baseline.md`](./baseline.md) is the cases run once against
the prompts as released, naming the revision it ran against: a record of one session at 3 runs, so
it says where each grader sat, and is not a before to compare with under the protocol, which runs
its before in the same session. Its `fix` section was taken after the fix graders were repaired to
read the working-tree diff (*What a fix replay cannot exercise*); fix reports from before that
repair are not comparable with anything later.

## Another model

The same command with another `--model`, for example `--model claude-sonnet-5-5`. Set its report
beside one at the current model taken with the same cases and runs, in the same session where you
can. `compare` refuses two models, since it measures a prompt with everything else held; compare the
counts with the same arithmetic by hand, and say which model each side ran. The grader (`--judge-model` in the
tool, haiku by default) is left as it is, so only the model under test changes.

## Noise

The first repeat, on 2026-11-02 (#634), ran the cases at `ca43755` and again at `0226bf9`, where the
two prompt files differ only by the history clauses and one duplicated rule #610 deleted: 5 of the
15 graders moved, by one run in three for three of them and by two for the other two
(`restart-order` 04 from 0/3 to 2/3, and `fix` `rescue-deleted-before-open` 02 from 0/3 to 2/3). So
a move of two in three can happen with no real change, and one in three is no evidence at all. That
was one repeat of near-identical prompts in two sessions, not a measure of the variance.

`noise <prompt>` measures it: one prompt blob in both arms of one session, so every difference in its
comparison is noise (the comparison says so). Its run directory is kept like any other, and its
runs are same-blob runs that a later `compare` can pool under the protocol's rule.

## Adding a case

Make a folder beside the others with a `case.yaml`, a `replay.yaml` (the pull request, `base_ref`,
the full `base` and `head` SHAs, `brief`, and its short `inputs`), its long inputs under `inputs/`,
and one grader per outcome. Choose the head from the verdict status history, as above, and write
each grader as something a reader could check in the output, "however it is worded". A clean case
says `clean: true`, is a pull request nothing merged later had to fix (search `main`'s log for
its number and its files), and its graders all hold false findings. Run it with `--stage-only`
first and read the staged prompt.
