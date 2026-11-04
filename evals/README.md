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
| `review/restart-order` | #577 | `edb772f` | a failed worker restart still restarts the dispatcher; the recovery advice cannot run; the halves hard-code the package's scope (#580) |
| `review/rescue-deleted-before-open` | #570 | `4d56bbc` | publish deletes the rescue before the pull request opens; a set-aside rescue is overwritten (#578) |
| `review/held-door-replay` | #601 | `bceed0c` | **security hygiene**: the held door, which now drops queued jobs, takes a replayed question; another release's job is refused before its version is checked |
| `review/clean-doctor-service-guard` | #566 | `85a04f0` | **clean**: no finding to fix before merge |
| `review/clean-explained-difference` | #698 | `5528a12` | **clean**, the scope-creep mirror: a departure from a criterion the maintainer directed is not a finding |
| `review/clean-domain-model-guard` | #678 | `b18b87f` | **clean**: no finding to fix before merge |
| `review/clean-full-ref-names` | #584 | `1159e02` | **clean**: no finding to fix before merge |
| `review/clean-upgrade-one-password` | #692 | `9d5c407` | **clean**: no finding to fix before merge |
| `review/clean-adopter-action-notes` | #681 | `c237a40` | **clean**: no finding to fix before merge |
| `review/verification-fetch-token` | #584 | `bbb7761`, then a **written** fix round, `7cfe705` | **a verification pass**: the round's tidy of the checkout's fetch drops its token; no false finding on the two findings the round fixed |
| `fix/rescue-deleted-before-open` | #570 | `b41cecd` | the fix moves the deletion, adds or updates a test, and changes nothing else |
| `fix/declined-unrunnable-eval` | #698 | `e0bd934` | **clean**: no change (a deterministic grader), and both threads declined because no change answers them |
| `fix/maintainer-direction-size-guard` | #698 | `e0bd934` | a maintainer's conversation comment is made and reported addressed; both threads declined on that direction |
| `fix/minor-finding-and-direction` | #732 | `a00633d` | a minor finding is fixed beside a maintainer's comment: the waiver read from the body only, controls graded on their own text |

Each head is found from the `agent-review` status history: the commit where the verdict turned
success, before the merge-check (or a later round) found what it missed. **Not the merged head**,
which already holds the fix. Each case's `replay.yaml` says how its head was chosen.

The first clean case is #566 because its approved head left no finding open and recorded no follow-up,
no maintainer review or merge-check finding is on it, its diff is code and tests, not only docs,
and **nothing merged since has had to fix it**: no later commit on `main` changes
`setup/doctor.ts` or `docs/ADOPTING.md`. A clean case needs all of these; a later fix means a
review that caught the defect is correct, and would be scored as a false finding. #568 was the
clean case first and was dropped for that reason (#584 fixed what it shipped).

`held-door-replay` is the second security-hygiene case, beside `persisted-checkout-token` (#719).
Its replay finding rests on no criterion and no rule, only on a described way the change can be
abused, which is the class #697's first wording of the basis rule suppressed, so a change to that
rule names both as guards. The maintainer's pre-merge check on its head also found a Medium that is
not graded: the door refused a read-only question that #602's `upgrade.sh` was to ask, which nothing
in the brief says.

One clean pull request bounds the false-finding rate and does not measure it (three clean runs with
none failed is an upper 95% bound of 63%), so four more were added by the same recipe (#719): #678
(doctor, the domain model's name), #584 (the service names every ref in full), #692
(`upgrade.sh`, a shell script) and #681 (publish's Adopter action section). Each was approved by
the loop with no finding open and no follow-up, has no maintainer review or comment, was squashed
with its approved head's tree, and has code and tests in its diff; what `main` has changed in its
files since is named in its `replay.yaml`, and none of it fixes the change. #692 and #681 were
approved at their first review, so their negative control is another pull request's review. The
report gives each clean case's rate, and with more than one, the rate over all of them, which pools
runs of different pull requests and is read beside the per-case lines.

`clean-explained-difference` is the mirror #614 asks for beside a scope-creep case: #698 at its
merged head departs from its criterion C5 (a golden-PR eval) because the maintainer said so in the
pull request's conversation, and the review that approved it ruled C5 changed. Its DISCUSSION holds
that comment, which no other case's does, since every other case's conversation is a first review's,
empty. **The scope-creep case itself is not yet built**: no real one was found. The loop's review
has asked the question only since #697 (2026-11-03); the maintainer's pre-merge checks read for
this (#572, #577, #601) raise no unrequested behaviour; and a search of the pull requests for "scope
creep" finds only #697, whose own evals say no case contains it. A synthetic
commit on a clean head, the audit's cheaper route, can now be built as a written fix round is, and
a control written for the case would cover the positive (*Controls*, below); what stands in the way
is that no real review text raises scope creep for it to be measured against.

`verification-fetch-token` is **the one verification pass** (#699), the case a change to what a
review that follows a fix round reads (#641, #748) is measured on. Every other case replays a first
review, so none takes the path such a change narrows. Its fix round is **written, not real**: no
real round that introduced a regression was found (#658's, #662's and #664's fixed what they were
asked to and left only stale docs), so the round is #584's real one, 1159e02, which fixed Review
1's two Low findings on `bbb7761`, with one regression written into it: its tidy of the checkout's
fetch in `service/worker-live.ts` passes `env` where it passed `withToken`, so the fetch sends no
token. Only the round's diff shows it; the tests (a local origin) and the typecheck miss it. Its
`replay.yaml` says how it is built, and its graders are the regression raised (01) and no false
finding on what the round got right (02). Its positive control for 01 is written for the case,
since no real review of a written round exists; the other two are #584's real Reviews 1 and 2.
**Its baseline catch rate is not yet run.**

The inputs of these cases, and of the fix cases on #698, were rendered with the runners' own
renderers (`fetchPullRequestContext`, `fetchPullRequestFeedback` and `surfaceText` over the pull
request's GitHub records, through a stand-in `gh`); for #566 that reproduces its inputs byte for
byte.

The fix cases on #698 are its second and third fix rounds, both on `e0bd934` (the second made no
commit). In the second, both open threads were on the one criterion no code could meet (a golden-PR
eval, which is a paid run by hand), and the round rightly changed nothing: the maintainer then
directed the pull request not to try. So `declined-unrunnable-eval` is **the clean case for fix**: a
run that changes anything has failed it. In the third, a maintainer's conversation comment asked for
a code change and set the same two threads aside, which `maintainer-direction-size-guard` grades:
the precedence and conversation-outcome paths of `fix/prompt.md`. `minor-finding-and-direction` is
#732's first fix round, handed a minor finding (#616) and a maintainer's comment, and no thread: the
one case that reaches *MINOR FINDINGS*. No fix round here has been handed a thread, a conversation
comment and a minor finding at once, so the three kinds are held by two cases, not one.

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
      controls/<name>.md   real text, or, for a written fix round, text written for the case, with what each grader must rule on it (below)
    sections.yaml          which sections of the prompt a case reaches (below)
```

A case holds **no prompt**. `claude plugin eval` takes a case's `prompt.md` as written, and a
runner's prompt is a template its runner fills in, so `scripts/eval-prompts.ts` renders
`review/prompt.md` or `fix/prompt.md` with the case's inputs into a staged copy of the suite at each
run, and runs the tool on that copy with the same `case.yaml` and graders. Editing the prompt file
changes the next run and nothing else needs updating; adding a `{{KEY}}` to it needs the input in
`suite.yaml` (or each case), which the layout test says.

The replay, against what the runner does:

- **The review is replayed as a first review** of the approved head, except in a fix-round case (below): no history, nothing carried,
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
- **A fix round, where a case has one** (`fix_round` in its `replay.yaml`, #699), is a patch in the
  case applied on its `head`, which is then the head the last review read, and committed in your
  clone with a fixed identity and date, so it is the same commit at every stage (its objects are
  written there, and no ref). The case is staged at that commit, its parent the reviewed head, so
  the `git diff <reviewed head> HEAD` its prompt gives works in the checkout. Its prompt carries
  what the runner gives a verification pass: the case sets `HISTORY`, `OPEN_FINDINGS` and a
  `DIFF_SCOPE` with `{{PR_STAT}}` and `{{SINCE_DIFF}}` in it, which the stage fills in with the
  pull request's `git diff --stat` and the round's diff, and `PR_DIFF` is the pull request's whole
  diff of each file the round touches. A round whose scoped form is no smaller than the whole diff
  is refused, since the runner would carry the whole one.

This route is the fallback the issue allows, taken because the tool cannot render a runner's prompt
itself; it was written against Claude Code **2.1.290**.

## What a grader is counted as

Most graders are counted by their pass rate. `grading` in a case's `replay.yaml` counts one
otherwise (#718), and the report and `compare` both say so beside its name:

- **`verdict`**: it passes on any blocking finding, not on the case's own ("the review does not
  recommend approval"). `rescue-deleted-before-open` 03 and `restart-order` 04 are verdicts: in 5
  of 15 stored `restart-order` runs 04 passed while 01 to 03 all failed. It is reported, and
  `compare` refuses it as a declared primary or guard, since a rise in it says nothing about the
  finding.
- **`{ given: <grader> }`**: it is only ever true where that grader is, so it is counted over the
  completed runs that passed that one, as P(this | that). `persisted-checkout-token` 02 (the
  finding is blocking) is given 01 (the finding is raised): it never passed in a stored run where
  01 failed.

Removed in #718, against the stored runs (`docs/audits/2026-11-02/evals.md`, 3.1): the clean case's
"recommends approval" (15 of 15 on every prompt, and implied by its 01), and `restart-order`'s
`curl -L` grader, since the issue it replays prescribes `curl -fsSL`, so a review that follows the
brief is right not to raise it. `restart-order` 05 is the finding 13 of 15 stored runs raised and
no grader credited: the halves default `PKG_JSON` to a path under the package's own scope while
`upgrade.sh` honours `PACKAGE_NAME`. It is a real defect against the brief ("No owner or repo name
is written in any script"); the loop's own reviews of the head recorded it, and it is filed as #580.
Grader numbers are not reused. The verdicts, `restart-order` 04 and `rescue-deleted-before-open` 03,
were reworded after the first run of the controls (below) to say what counts as asking for a change,
so a stored run's 04 was graded by the earlier file, and `compare` refuses to pool the two.

## A deterministic grader

A grader may be `type: regex` instead of `llm`: a pattern `claude plugin eval` matches against the
final message (`target: last_message`, with `match: contains`, `not_contains` or `count:N`), with no
judge, no cost and no variance. Its body says in words what it holds; the tool reads only the
frontmatter. `declined-unrunnable-eval` 01 is one: the final message holds no `diff --git` line, so
the run printed no change. It reads what the run printed, so a run that changed a file and did not
print it would pass; its `llm` grader, which reads the replies, is the other half. Its controls are
ruled on in `tests/evals.test.ts`, by the tool's own rule, rather than in a run of the controls.

A fix case is **clean** (`clean: true`) where the right change is none. The report gives its
false-change rate: the share of completed runs that failed any of its graders.

## Controls

A grader that fails a text it should pass is broken, and one that passes a text it should fail is
too loose; neither shows in a pass rate. So every grader has a **positive** and a **negative
control** (#718, held by the layout test): `controls/<name>.md` in its case, real text (or, for a written fix round, text written for the case) with a
`source` naming where it was read and an `expect` saying, per grader, `pass` or `fail`. They are
the loop's own review at the case's head (which missed what the case grades, so a negative for those
graders), the merge-check or later review that caught it (a positive), and for `fix` the change that
shipped (`ba76218`) against another fix round on the same pull request. Every real review of #570
records the set-aside rescue (`rescue-deleted-before-open` 02) as a follow-up, so its negative is
another pull request's review. Badges are written as text and HTML comments taken out; nothing else
is edited.

```bash
node scripts/eval-prompts.ts controls review --model claude-haiku-5-5 --max-cost-usd 2
```

stages each control as a case of its own, with the `llm` graders it names (a `regex` grader is held
by the layout test instead, above), whose scaffold puts the control's text in the run's
sandbox as `control.md`. Its graders are the case's graders it names, criteria as they are, each
with its `focus` moved from the final message to that file (`focus: { source: file, path:
control.md }`), so the judge reads the text itself; the model is asked for one word, which nothing
reads. One run each, no checkout. The cost is the judge's.

The report lists each ruling against what the control expects, with the judge's reason where it
differs. A ruling counts only where the judge was shown the control's text (the tool's `evidence`
for that grader, which holds what the judge read): any other ruling is **void**, counted on its own
line and never called broken or too loose. The command exits 1 only on a ruling that differs from
`expect` on the control's own text.

**The first run** (on `a00633d`, before this staging) had the model echo the text as its final
message, so the judge graded the echo: 25 of 27 review rulings and 4 of 6 fix rulings held with a
`claude-haiku-5-5` echo, and 23 of 27 and 6 of 6 with `claude-opus-5-5`. Most of the broken
rulings were the echo: the two runs broke different controls. One broke under both,
`restart-order/changes-after-fix` grader 04. That control is right: Review 3 at `58a8c32` of #577
asked for changes, with a High (an acceptance criterion ruled unmet) and two Lows. The grader was
the problem. It asked whether the review "asks for at least one change before merge", and this
review's findings are ones the author may skip by replying, and its High one the pull request may
depart from by saying why. So 04, and `rescue-deleted-before-open` 03, which had the same words,
now say what counts. No run has yet graded the text directly. Run them, and fix a grader that
fails one, before the next comparison that declares it.

## What a case reaches

`sections.yaml` names every `#` section of the prompt as one every case reaches (`always`) or one
written for a state of one input (`gated`), and the layout test fails on a section it leaves out. A
case reaches a gated section only where it sets that input to something other than the "nothing
here" value `suite.yaml` fixes it to; `--stage-only` (and every run) prints each case's sections
and share of the prompt. As the cases stand, one, `verification-fetch-token`, reaches the
verification pass and the open findings; every other is a first review with nothing carried. No
case reaches the settled or noted findings, the carried follow-ups, a failing CI check or a
configured red check. A case that sets one of those inputs is what would reach it.

The values `suite.yaml` fixes are the strings the runners' own renderers return for that state, and
`tests/evals.test.ts` holds them there (`review/review.ts`'s inline strings are read in its source),
so a renderer that changes its words fails the layout test rather than drifting from the replay.
Every input the suite fixes needs its renderer named in that test. A fix-round case's `HISTORY`,
`OPEN_FINDINGS` and `DIFF_SCOPE` are held the same way, to `describeHistory`,
`renderCarriedFindings` and `renderDiffScope`.

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
- `controls <prompt>` runs the grader controls instead of the cases (*Controls*, above), one run
  each unless `--runs` says otherwise.

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
  the sandbox it came from (`claude-eval-*` in the temp dir; `e-*` in `/tmp` on macOS), opening
  the directories the tool sealed first. One it cannot remove is a warning naming the path. A
  sandbox with no trace (a run that never started) is
  left in the temp dir;
- `runs.json`: one record per run, which `compare` reads: case, arm, prompt blob, model, judge
  model, Claude Code version, error, cost, judge cost, turns, trace, and per grader its result, its
  file hash and the judge's votes;
- `tool/`: the tool's `aggregate-result.json` and HTML report;
- `report.md`: the report, which `report <run-dir>` prints again.

The report states, per case, the runs and each grader's pass rate (the catch rate) **of the runs
that completed**: an errored run measured nothing, so it is counted beside the runs and is in no
denominator. Then the false-finding rate on each clean case (the share of completed runs that failed
any of its graders), and over all of them where there are several (for fix, the false-change rate); the model; the Claude Code version; the cost; the run directory; and the
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
`void` where a side has two or more errored runs of the case, or no completed run of it (a case
one side never ran, or ran only into errors). Every other row says `descriptive`.

## Comparing a before and an after: the protocol

This is the rule a prompt change is measured by. It is fixed before any run, so that what is
reported does not depend on what was seen.

1. **Declare, in the pull request and before running**, one **primary** grader (the outcome the
   change sets out to move) and the **guards** (the outcomes it must not break: at least one clean
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
7. **Paste the comparison into the pull request**, with the primary and guards it declared. CI
   holds this (`.github/workflows/prompt-evals.yml`, #718): a pull request that changes
   `review/prompt.md` or `fix/prompt.md` fails it until its body or a comment carries a comparison
   (`### \`<prompt>\` comparison`) whose two sides ran the prompt's blob at the merge-base and at
   the head, in that order. A comparison of an earlier revision of the change does not count: edit
   the prompt again and the comparison is owed again. A change no eval can measure (a typo in a
   heading no case reads) says so with a line `Eval-Waiver: <the reason>` in the body; one in a
   comment waives nothing, since anyone who can comment could post it. The job
   runs again when the body is edited; after posting the comparison as a comment, re-run it.

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
one grader per outcome, and a positive and a negative control for each grader. Choose the head from
the verdict status history, as above, and write each grader as something a reader could check in
the output, "however it is worded". A clean case
says `clean: true`, is a pull request nothing merged later had to fix (search `main`'s log for
its number and its files), and its graders all hold false findings. Run it with `--stage-only`
first and read the staged prompt.
