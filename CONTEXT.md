# CONTEXT.md

The domain model. Read this before changing anything; [CLAUDE.md](./CLAUDE.md) has the commands and
the conventions, [README.md](./README.md) is for people installing the package, and
[docs/ADOPTING.md](./docs/ADOPTING.md) is for people installing the loop.

## What this is

A **GitHub Actions agent loop**: a labelled issue becomes a reviewed pull request with no human in
the middle. One workflow per label transition, near enough:

| Label | Fires | Does |
|---|---|---|
| `agent:implement` on an **issue** | `implement` | branch, implement, open a draft PR, request review |
| `agent:implement` on a **PRD parent** | `implement-prd` | once the PRD PR's head carries an approval, merge the default branch into the PRD branch if it has moved, build the next sub-issue as commits on the PRD branch, open the PRD PR as a draft the first time, request the slice's round on it; or, with no sub-issue left, hand the PRD PR over |
| `agent:review` on a **PR** | `review` | wait for CI, review the diff, verify what earlier rounds found and resolve what landed, mark ready |
| `agent:fix` on a **PR** | `fix` | act on review feedback, reply to every thread it is asked about and close none, record what it did with the conversation comments, ask for a re-review if it pushed or left an out-of-scope note |
| `agent:update-branch` on a **PR** | `update-branch` | merge the base branch in, resolve conflicts, carry the verdict over or ask for a re-review |
| `agent:follow-ups` on a **merged PR** | `follow-ups` | file the out-of-scope findings its review recorded, as `needs-triage` stubs |

`implement` and `implement-prd` share one label and partition on **issue shape**: a parent with
sub-issues goes to the PRD chain, everything else to the single-issue run. The chain works one
sub-issue per run, and waits for that sub-issue's review round to end on an approval before it
builds the next; review's advance (below) re-adds the label that moves it on.

Every slice is built as commits on one branch, the **PRD branch** (`agent/prd-<parent>-…`), and the
one pull request from it into the default branch is the **PRD PR**: the only pull request of a
chain, opened as a draft by the first build run, and the one a human merges. Its base is the
default branch, so the CI configured for the default branch runs on every slice with nothing more
to set up. No slice has a branch or a pull request of its own (PRD #222).

A sub-issue's commits on the PRD branch are its **slice range**. Every commit a build run makes
carries an `Agent-Slice: #<sub>` trailer, written by the workflow before the push, and
`shared/slice-ranges.ts` derives the ranges from the PRD branch's first-parent log: a slice starts
at the first parent of its earliest trailered commit and ends where the next one starts. Fix, human
and conflict-resolution commits carry no trailer and belong to the range they fall in, a
resolution at the end of a slice included; the merge of the default branch the chain makes before a
slice is built carries an `Agent-Catch-Up` trailer instead, and falls outside every range. That one function
answers every "which slice": the **next** is the first open sub-issue with no range, in the
sub-issue list's order, never read off which issues are closed; the **current** is the last one
with a range; and it gives the review its *k of n*. Order is the sub-issue list's (publish order is
execution order, `docs/agents/ticket-shape.md`), and its "blocked by" links are checked against it
once, before the first slice is built.

Each slice is reviewed as a **slice round** on the PRD PR: an ordinary review round, told "slice
*k* of *n*: #sub", handed the slice range's commits and the sub-issue's acceptance criteria, and
allowed to raise only what those commits cause. The diff is still the whole PRD PR's, and a
problem this slice causes in earlier code is anchored at this slice's change. Fix rounds run on
the PRD PR under the same budget and early stop as anywhere else. The PRD PR stays a draft through
every slice round. **The next slice starts only on an approval**: the build run's preflight reads
the `agent-review` verdict on the PRD PR's head, live, and refuses on anything else, so a human
re-adding the label to a parked chain cannot skip the gate. Before building, the run merges the
default branch into the PRD branch if it has moved; it never rebases or force-pushes, so verdicts
and threads stay on the commits they were made on, and a conflict **parks** the chain, builds
nothing and names `agent:update-branch` on the PRD PR.

The run that finds every sub-issue built is the **finishing run**; it runs no model (#163). With
more than one slice landed it asks for the **final review**: a full review of the PRD PR with no
slice range, which rules on every finding still open, honours every decline, looks for what spans
slices, writes the PRD's title and body, and marks the PRD PR ready on approval. With one slice it
marks the PRD PR ready itself, since the slice round already read the same diff. A review knows it
is the final review from the PRD PR body's **progress list**, which the finishing run marks.

Sub-issues stay **open** until the PRD PR merges: its body's `Closes` block names the parent and
every sub-issue, so the merge closes exactly the work it contains and a PRD PR closed unmerged
closes nothing. Progress is shown by the progress list and by comments: each build run comments on
the sub-issue it starts, with the run link, and notes it on the parent, and the run after an
approval says on the slice's sub-issue which commit was approved and which criteria changed.

A chain an older release started is migrated rather than stranded (#248), by rules marked
*Pre-upgrade compatibility* and removable under #224: a closed sub-issue with no slice range landed
before the upgrade and is not built again, and a pull request from the older release's per-slice
`agent/slice-` branches still open into the PRD branch refuses the run by name until a human merges
or closes it.

**A trigger label is on while its run works** (#236). The run leaves it on as it starts and takes
it off in its last step, however it ends: success, failure, refusal, timeout or cancel. So the
label on an issue or a pull request is the run working on it now, or the one queued behind it, and
`agent:in-progress`, which said the same thing in a second write, is retired. On a PRD parent that
makes `agent:implement` on only during each build run; the advance puts it back. Two rules
follow from GitHub firing no event for a label already there. The loop adds a trigger label by
**removing it first**, so a stale one cannot swallow the request. And a request made **while a run
works** is not lost: a review or a branch refresh that ends to find the head moved since it
started, because somebody pushed, asks for its own step again, unless another trigger label is
on it: that is a run queued behind it, which a new request would cancel and strand. `fix` does not, since a second fix
run would answer the threads it answered. There is no lifetime "in progress" label on an issue:
an open issue with a linked pull request, a draft, and `agent:blocked` already give that view.

Every run ends in **one order**: post every result, take its own label off, then add the label
naming the next step. A hand-off removes its trigger label just before it adds `agent:review`; a
failure comments, then removes it, then adds `agent:blocked`; a refusal does the same where the
maintainer has to act, and one that leaves nothing to act on (a closed issue or pull request, a
finished PRD, a deleted branch, a fix with nothing to do) comments and removes it, and adds nothing
(#253). Every such comment is in one of two patterns: `**`agent:X` stopped:**` and the reason, the
run and what to do, for a run that started; `**`agent:X` didn't run:**` and a sentence saying why
and what to do, for one refused before it did anything. So nothing ever carries a run's label and the next step's at once, or `agent:blocked` with no word of why. A
review that found the head moved hands off one way only, and says so as `moved`: its fix-round and
advance hand-offs stand down, since its verdict is about a commit the pull request has left, and
`update-branch` asks for itself again only where it did not just ask for a review.

**Review is the one run whose work and whose posting are two jobs** (#257). The review job runs the
model and writes nothing at all: no comment, label, status or review, and no write scope to make
one with. One **posting job** that runs no model then writes everything, in the order above:
it answers and resolves the earlier findings the review ruled on, then posts the overview and the
new findings in one call, whose *Resolved since last review* lists only the threads that actually
resolved (one whose resolve failed is listed as still open, with a note), then the pull request's
title and summary block where anything was pushed since the summary was written, then the verdict status
and the ready state, then takes `agent:review` off, then hands off. A refusal or a failure in the
review job is said by the posting job too, since nothing else can write it.

`fix` and `update-branch` are the two rows that add `agent:review` **after a push to an existing
PR** — the `implement` pair adds it too, on the PR it has just opened, which is the table's own
first row. A run that pushed asks for the review of what it pushed, so the round it was given
closes without a human labelling again. Since #111 that leg is also what **ends** the round: a fix
run resolves nothing, so the review it asks for is the pass that reads the fix and closes the
findings that landed. That is one hop and cannot cycle: the one trigger label review adds to a
pull request is bounded twice over (below), by the fix-round budget and by the **early stop**. The
review a **fix** asks for may recommend changes and, with budget left, start another round, unless
the fix round it follows closed none of the findings it was given (`docs/parity.md` §10). Whether a
review follows a fix round is read from the **verdict history**, never from who authored the
commits: the latest verdict announced a round, and commits have landed since, or the fix run
posted an out-of-scope note since without pushing (#213). The review a
**conflict resolution** asks for follows no fix round, because a resolution posts no verdict and
the one before it announced none. A fix run that pushed nothing and left no out-of-scope note asks
for nothing, and leaves every thread it answered open, so a round it declined its way through ends
on a human rather than on another pass. It is also the run that marks such a pull request
**ready**, because there is no re-review coming to do it (#159): a run that pushed hands the pull
request to a review, and a run that did not hands it back. **Not on a PRD PR** (PRD #222): there
every fix run asks for a re-review, whatever it pushed, and never marks the PRD PR ready, so every
ending of a slice round is a verdict, which the advance either moves on from or parks on. **A note bends that rule** (#213): a run
that pushed nothing but posted an out-of-scope note asks for a re-review too, because the review is
what rules on the note, and an unruled note is filed by nobody. The fix-round budget bounds that
leg as it bounds a push.

A review asked for **right after a push** is about the pushed commit, and two halves make it so
(#229). GitHub moves a pull request's head asynchronously after a push, so a label added at once
can carry the commit before the push in its payload. Each run that pushes waits, about a minute,
for the pull request to show the pushed commit before it labels, and labels anyway with a warning
if it never does. And the review does not trust its payload: it reads the branch tip from git,
reviews the tip where it descends from the labelled commit, refuses by name where it does not,
and checks out, waits on CI for and posts every status on that one commit.

Review adds a trigger label in two cases. The first is on the pull request (#102): the posting
job's last step adds `agent:fix` when the verdict is *Changes recommended* and the pull request has
automatic fix rounds left in its **fix-round budget** (#201): the repository variable
`AGENT_MAX_FIX_ROUNDS`, default 3, `0` for none. **Rounds spent** are counted from the pull request
itself: the verdicts the loop posted there that announced a round. There is no marker label, so the
count survives re-runs and hand edits, only automatic rounds count, and a push resets nothing. The
budget is settled before the review runs, so the verdict announces a round only where one will
start, and the step decides from live state rather than the event payload: it adds nothing where
`agent:fix` is already on the pull request or a newer verdict stands, and says on the pull request
when a round it should have started did not. It is the return leg `docs/parity.md` §10 used to
forbid outright, and what makes it an arrow rather than a cycle is two bounds, both ruled on before
the key it selects on is derived. The budget bounds it per pull request, and the **early stop**
(#202) ends it sooner: after a fix round that closed none of the findings it was given, matched by
the ids the workflow wrote into them, no further automatic round starts, whatever budget is left.
New findings the re-review raised neither count as progress nor reset anything. The verdict then
says why the loop stopped, and gives the same three ways on as a spent budget: add `agent:fix`,
decline a finding in a reply, or push a commit. The **round rule** it replaced, which barred a
second-round review from recommending another round, is retired (PRD #200 decision 6). The step
is in the posting job, which checks nothing out and runs no model, which is what keeps
`AGENT_PAT` away from the job that reads the pull request. The `auto-fix` input it replaced is
a deprecated alias for one release (`true` a budget of 1, `false` of 0). Waiting has no label
either: `agent:queued` is retired with the marker (#204), because a native "blocked by" link says an
issue waits, and `implement` refuses while one is open. A pull request whose
automatic fix is about to start also stays a **draft**: draft means the loop is still
working, and what marks it ready is whichever end the round comes to — the re-review, where the fix
pushed or left a note, and the fix run itself where it did neither and so asked for none.

The second is the **advance**, a second arrow, and it lands on an issue rather than a pull
request (#176). It is one job, `advance` in `review`, and it fires only on a PRD PR (head under
`agent/prd-`, same repository). When a slice round ends on an **approval**, it re-adds
`agent:implement` to the PRD's **parent**, parsed from the head name, and the `implement-prd` run
that starts passes the approval gate and builds the next slice, or finishes. When a slice round or
the final review ends any other way, the same job **parks** the chain: it comments on the parent
naming the slice (or "final review"), why the round stopped (the fix-round budget spent, no
progress, a review that needs a closer look, a run that did not finish), the open findings with
links, and the three ways on: `agent:fix` for another round; decline a finding by replying to it,
then `agent:review`; or push a commit, then `agent:review`. A verdict that started a fix round is
neither, and the job does nothing on it. At every ending it first re-renders the progress list.
`fix` has no copy of it: only a review posts an approval, and every fix run on a PRD PR ends in
one. It cannot cycle: it never labels a pull request, the run it starts builds one slice and asks
for one round, or refuses at the gate, and it is **bounded by the number of sub-issues**, because a
finished PRD refuses the label. It runs a composite action, `.github/actions/advance-prd`, pinned
to the release like the runner (no checkout, no model, `AGENT_PAT` or nothing).

`update-branch` asks only on the half of its work an agent wrote. A **clean** merge changed nothing
the last review read, so it carries that review's verdict on to the merge commit instead — a
commit status belongs to a commit, so without the copy every merge into a base branch would wipe
the verdict off every open PR that refreshes against it. A **conflict resolution** is the loop
writing code no review has seen, so it copies nothing and asks.

**The reviewer closes a finding; the fixer never does** (#109, decision 1). A `fix` run replies in
every thread it is asked about — every open one bar a thread whose close failed, which already
carries the reply that settles it and is shown for its evidence only (#133) — and resolves none of
them, and every review, after a fix round or not, takes the findings an earlier review left open, rules
on each by the id the workflow wrote into it, and resolves the ones the current code settles. That is not tidiness: a resolved thread is dropped from the feedback
the next review is handed, so while the fixer closed its own threads the one pass whose job is *did
it land?* could not see what it was checking. A review after no fix round does it too, because a human may have pushed
the fix and the question has the same answer whoever wrote the commit.

**And a maintainer's decision outranks both** (#109, decision 10). A thread a *human* resolved is
handed to every later review as settled, with the instruction not to raise it again in any wording;
a thread where a maintainer **replied** declining the finding is closed by the reviewer as
`WONT_FIX`, quoting them, and stops counting. The review never overrules a maintainer and never
declines on its own authority — a reply it cannot read as a refusal leaves the thread open, which
is the safe direction because an open finding costs a round and a wrongly closed one costs the
decision. What makes the decline usable is the author gate rather than the reading: only a reply
`isTrustedAuthor` passed reaches the agent at all, and only one it passed can close a thread, so a
decline typed by anyone at all is a finding that stays open.

**And in the fix half it is a direction rather than a ruling** (PRD #101, decision 5). The gate is
the same one — only a comment `isTrustedAuthor` passed reaches either agent — so what the fix brief
adds is weight, not trust: a maintainer's comment is what that run follows, above a reviewer's
finding where the two disagree, and a maintainer asking for something no review raised is asking
inside this change's scope, because the bound on expanding a pull request is a bound on what a
*finding* may pull into it. The fixer may still decline a direction it believes is wrong, on the
terms it may decline any comment, and says why. What it may not do is weigh a maintainer's ask as
one more finding.

**And an outcome is owed on a comment that has no thread** (#104; decision 6, superseding #3). A
`fix` run reported one outcome per review thread and nothing for a top-level **conversation**
comment — it read them, acted on them, and never said so, which made a *declined* one invisible:
nothing on the pull request, nothing to push back on. With steering arriving as exactly such a
comment, the two halves report the same way now — addressed or declined, with the reason — and the
difference is only where it lands. A conversation comment has nothing to reply *into*, so the
outcomes are one comment on the same conversation, declines first, written by the workflow from the
runner's validated output. What bounds it is the split that was already there: this workflow's own
comments are on that same surface and `github-actions` is trusted on purpose, so the marker is all
that distinguishes last round's note from a maintainer's instruction. Only a comment the fetch
offered an **id** for can carry an outcome, which is what keeps a run from answering itself: the
marked kinds are never rendered, and the loop's own unmarked notes — a refusal, a failure comment,
a warning about a label that fired nothing — are rendered for their evidence and offered no id,
because a status note asks for nothing (#159). The record carries a
marker of its own rather than the top-level one, because the top-level one is what dedupes that
channel across runs, and a record is correct to repeat.

**And a fix run's out-of-scope note ends as an issue or as a decision not to file one** (#213). The
fix agent often reads furthest past the diff, and what it noticed there used to be a top-level
comment that nothing read: `follow-ups` files only from the newest review body, and the fetch keeps
marked comments out of what the next review sees. So such a note is now structured (a title, a body,
a location where there is one), posted by the workflow under a heading that says it is outside the
pull request, and carries a marker of its own. The **next review** is handed the notes posted since
its last verdict, selected by that marker **and** by the workflow bot having posted them, never by
the marker alone, since anyone who can comment can type it. It rules on each: **promoted**, recorded
in its own follow-ups (ahead of its own, inside the same cap) and filed on merge like any other, or
**dropped**, listed in the body with the reason. A note it says nothing about is promoted, the
direction that cannot lose one. The fix agent never writes the follow-ups record itself: two
writers of it would break "the newest record wins".

**And the review body is where the rounds are kept** (#109, decisions 8 and 9). It is a findings
record, not a rendering of the latest pass: `## Agent review`, the assessment, one sentence the
review wrote naming what is unresolved, the step, a count, then *Open*, *Previously missed*,
*Resolved since last review*, *Acceptance criteria* and *Follow-ups*, then *How this was checked*,
then a rule and the run. A group with nothing in it is omitted and that rule is the only
divider in the body. Every entry carries a **severity** — `high` / `medium` / `low`, which orders the list
and decides nothing else; a test permutes it across a review and holds the verdict identical. It is
rendered as a **chip this repository hosts**, pinned to the release that posted it, and the thread
the entry points at opens with the same one (#135) — one badge, so the two surfaces cannot label one
finding two ways. The picture is never the only copy: its alt text is the word, and every reader
that turns a body or a thread into prompt text reduces the tag to it. What
makes it a record rather than a list is which entries carry a finding id: one with no thread does,
because the newest body naming it is the only thing keeping it alive; one with a thread does not,
because the thread is its record; and one this round closed carries none at all, or the next round
would be handed a settled finding to rule on again. A carried entry also carries a **link** to its
thread, which sits under an older review; a fresh one cannot, because its thread is opened by the
same call that posts the body.

Since #127 no finding the review raises is thread-less. **Every fix-before-merge finding is anchored
at something the pull request changed** — a line the diff covers, or the changed file where it
covers no such line — because GitHub opens a thread against nothing else, and a finding with no
thread is one a maintainer cannot reply to, decline or resolve. *Changed* is wider than *has a line
in the diff*: a file the change deleted, renamed, rewrote in binary or only chmod'd names no new
side, and each is a file-level thread rather than a demotion. A problem in a file the change never
touched is anchored at *the change that causes it*, with the untouched `path:line` named in the
thread; a problem nothing in the change causes was never this pull request's to fix, so the
workflow records it in `followUps` and the body says under the count that it did. Two thread-less
entries survive and neither is a finding this version raised: a `fixBeforeMerge` line the model
restated with no finding behind it, which the record counts as an entry of its own (#105), and the
body entries v0.4.0 already wrote — carried and verified until they close, because that entry is
the only record such a finding exists.

The prose beside the record is capped by the schema rather than asked for in the brief, and
**restates no finding**: the findings are above it with their severities, and the one 250-word
paragraph that mixed *what the change is* with *what the reviewer verified* is what made a body
long enough to bury the record in it.

**Every review checks the linked issue's acceptance criteria one by one** (#214). The workflow
reads them off the issue (its acceptance section, or where triage posted a brief as a trusted
comment the latest such section, which supersedes the body's; or its body's checklist where there
is none) and hands them over by id; the review rules on each as *met*,
*changed* on purpose with the reason, or *unmet*. An unmet one is a fix-before-merge finding,
anchored at the change nearest to it like any other; a changed one is not a finding, and is listed
with its reason in the body's *Acceptance criteria* section, which a pull request with no linked
issue or no criteria does not get. On a PRD PR a slice round is handed its own sub-issue's
criteria, and the final review is handed none: each slice was held to its own in its round, and the
final review reads what each round recorded.

**What the change is lives in the pull request's body, not the review** (#218). The run that opens
a pull request writes its **frame** once and never again: `Closes #N` first, a note saying what the
loop does with it and how to steer it (linking the opening run), on a PRD PR the **progress list**
between `<!-- agent:progress -->` markers (#246: each sub-issue not started, building, in review,
parked or approved, re-rendered from live state by every build run, including one that stops, and at every ending of a round,
never edited incrementally, and holding the final review's mark), and a **summary block** between `<!-- agent:summary -->` markers. The
review writes the block and the title, and nothing else in the body: a maintainer's notes outside
the markers survive every round byte for byte. The rule is **anything pushed since the summary was
last written rewrites both** (the first build, a maintainer's push, a conflict resolution and a fix
round alike), and nothing pushed leaves both alone. The block carries the head it was written at,
which is how the rule is read: not from the verdict history, which says what a verdict has seen
rather than what a summary has. A maintainer's edit inside the block is input to the next rewrite,
kept where it is still true. The agent produces `title` and `summary`; the posting job writes them,
splicing into the body as it stands then rather than as the review read it. Under the agent's
summary the runner adds the **failing-first tests** from the red check's report (#234), red ones
only, or which of *not configured*, *could not be read* and *none red* holds instead. So the review comment
carries no description of the change, and the description exists in one place.

A PRD PR's **final review** writes both however little was pushed, since the last slice round wrote
them at the same head (#247). Its summary is the whole PRD's, laid out by the workflow: the outcome,
the behaviour changes with the breaking ones marked, the acceptance criteria each slice changed or
dropped (read off each slice round's record, by the commit it reviewed, through the slice ranges),
where the red check is configured each slice's failing-first tests (#235), read off the same rounds,
and the known issues, naming the follow-ups filed at merge. A slice round's red check runs against
the PRD branch as it stood before that slice, its slice range's base, rather than the merge-base,
so each slice's tests run on code holding every earlier slice. The same write removes the frame's
**draft-only** note, between its own markers, so a PRD PR marked ready says nothing about being a
draft.

`follow-ups` is the row that is not quite a label transition. The **merge** is what fires it and
the label is a marker it reads — re-adding that label to a closed PR is a manual entry point rather
than the normal path — and it is the one workflow an adopter can decline by not copying its caller
(`docs/ADOPTING.md` §4). It is also the only one that runs **no model**: the review agent records
the findings and cannot file them, and the workflow holding `issues: write` decides what to file
with a pure function (`docs/parity.md` §10). On a PRD chain it fires once, at the PRD PR's merge, since nothing
merges into the PRD branch through a pull request any more (#247). That PR's newest review carries
forward, de-duplicated by the id the workflow gave each entry, every follow-up an earlier round on
it recorded, because each round there is scoped to one slice and none restates another's; and the
cap is **three per landed slice**, recorded in the payload and re-applied by the filing end. A
regular pull request is one slice, so its cap stays three and its review still restates its list
every round.

## The three parts, and what belongs in each

This is the distinction to get right, because a change put in the wrong part either cannot be
tested or cannot be fixed for an adopter without them editing a file.

```
consumer repo                    this repo
─────────────                    ─────────
.github/workflows/agent-*.yml    .github/workflows/<name>.yml     <name>/*.ts + prompt.md
  the CALLER                       the REUSABLE workflow            the RUNNER
  a trigger and two wires          every guard and every step       the agent's actual work
```

**The caller** is what an adopter owns: the trigger, the permissions grant, the secrets, and
`self-check`. It is deliberately tiny — anything an adopter can get wrong is something that drifts
across repos. Reference copies live in [`examples/callers/`](./examples/callers/) and are under
test.

**The reusable workflow** holds everything that bounds what a wrong run can do: the fork guard, the
permissions ceiling, the concurrency group, the preflight refusals. An adopter *references* it, so
a fix reaches them without them touching anything.

**The runner** is TypeScript plus a prompt, invoked as one subcommand of one published binary. It
takes its whole input from the environment; passing an argument is refused rather than ignored.

**Part, not layer.** These were *the three layers* until stacked pull requests arrived: GitHub calls
one pull request in a stack a **layer**, and that is the only meaning the word has here now. The
PRD chain uses no stacks: its slices are ranges of commits on one branch, not layers. Older
entries in `docs/friction.md` keep the old usage, because that log is never rewritten.

### And the install path, which is none of the three

`init` and `doctor` (`setup/`) are two more subcommands of the same binary, run by a human rather
than by a workflow. They are not a fourth part so much as the thing that *puts* the first one in
place and then checks it: `init` copies the reference callers in with the pin substituted, and
`doctor` looks for the failures `docs/ADOPTING.md` §1 is about — every one of which is a condition
with no runtime symptom, which is why looking has to be deliberate.

The boundary between them follows the one above: the caller is the adopter's, so a re-run of `init`
moves the pin in the files they have and changes nothing else about them. What a later release
changed *inside* a caller is `doctor`'s to name, with the fix, rather than `init`'s to overwrite —
a scaffolder that silently reverted a `with:` input would be manufacturing exactly the failure
class the pair exists to remove.

`doctor` names it only where it was taught to. `diagnose` rules on a **fixed list** — every grant
the job a caller calls spends, an absent `permissions:` block, the `AGENT_PAT` wire, the pin's shape
and its freshness, `self-check`, the labels, an Actions policy letting `pull_request_target` run on a public repository (#219), and the fix-round budget (#204): a variable the review would refuse, a budget above 0 with no `AGENT_PAT` behind it (the default counts), a caller still passing the deprecated `auto-fix`, and a time limit variable that is not a positive integer (#220) — and reads nothing out of `examples/callers/`, so a
release that changes a caller *body* is a release that teaches `diagnose` about it in the same
commit, exactly as a new pin site is a change to `shared/pins.ts` in the same commit. Diffing an
adopter's caller against the reference is the other design and it is the wrong one here: most of
what differs is a decision they made, and a preflight that reported those as faults would be read
for about one release.

They ship in the same package as the runners on purpose. The version that writes a pin has to be the
version that pin names, and the version that diagnoses a loop has to be the one whose guards it
knows about; a separate installer is a second thing to keep in step with the release.

### Why reusable workflows and not a composite action

A composite action cannot declare `on:`, `permissions:`, `concurrency:` or a job-level `if:` —
which is every security control here, and **the fork guard is a job-level `if:`**. An action could
have absorbed checkout → node → install and left the controls to be copy-pasted per repo, which is
exactly how they drift.

## The trust boundary

`pull_request_target` is the load-bearing trigger, and it is a fork-code-execution path on a public
repo: it runs with repo secrets and write access. Three things close it, and none is cosmetic.

1. **The fork guard** — `head.repo.full_name == github.repository` as a job-level `if:`, in the
   *reusable* half. A caller can skip the job; it cannot loosen the guard. `actions/checkout`
   refuses a fork head under `pull_request_target` on its own too, so the guard holds twice — but
   only where the step passes an explicit `ref:`, which makes the second half a property of *this
   step* as much as of the version: the action skips its check on a default self-checkout, GitHub
   having resolved that ref itself. A test asserts the `ref:` alongside the `if:`. Not something the
   `@v7` bump bought, either — the refusal was backported into `v6.1.0`, `v5.1.0` and `v4.4.0`, and
   `@v4` floats to the last of those. What matters here is the opt-out:
   `allow-unsafe-pr-checkout: true` turns the action's half off outright, and that input lives in
   the reusable half where no caller can see it. A test asserts no checkout step sets it.
2. **The author gate** — `isTrustedAuthor` in `shared/`. Every PR feedback surface is
   world-writable, and `fix` acts on that feedback with `contents: write` and pushes. An injection
   would steer *committed code*, so the gate is read by the workflow, not by the agent, whose GitHub
   token is scrubbed before it starts. What it establishes is **org-adjacent or better**, not write
   access: of `OWNER` / `MEMBER` / `COLLABORATOR` only the first is write-gated by the enum's own
   definition, `COLLABORATOR` covers the Read and Triage roles and `MEMBER` is org membership with
   no repository grant. The two coincide on a personal repo and come apart on an organization one,
   so this gate is write-gated *here* and not for an adopting org. Whether the set narrows is the
   open decision at #68; the second half of the gate, the workflow-bot login, is transitively
   write-gated and is the stronger of the two.
3. **The pin** — see below.

## Base-controlled, and what that now depends on

`pull_request_target` reads workflow YAML from the repository's **default** branch while checking
out the **PR head**. So a pull request cannot edit a caller to change what runs. Until 2025-12-08 it
read the PR's *base* branch instead; the move made the protection stronger, since a pull request into
a branch somebody else controls no longer picks that branch's copy of the caller.

And on a **public** repository it runs only where an Actions event policy lets it (#219). GitHub's
workflow execution protections block `pull_request_target` there by default from 2026-11-02, so
`init` creates a policy allowing it for the loop's callers, targeted by workflow path so every other
workflow stays blocked, and `doctor` fails a public repository without one. A blocked run is
GitHub's refusal rather than a failed step, which is why it is looked for rather than reported.

That protection used to extend to the called workflow for free, because `uses:` was a local path
resolving against the same commit. **Remote, the reference is what decides.** `@main` would hand a
job holding `contents: write` and every secret to whatever currently sits on this repository's
default branch, and nothing would report it. Callers pin a tag or a SHA; a test enforces the shape.

## The version pin keeps two halves in step

The workflow YAML and the runner code come from different places — YAML from the default branch,
runner from the published package. Pinning the version **in the YAML** is what makes them move
together.

This is not hygiene. Before the pin existed, a pull request that changed the runner's interface
broke every later run against it: new runner on the branch, old YAML on `main`, both current as of
different commits. **A change that refactors the runner it executes on has a split brain by
construction**, and the pin is the only thing that closes it. `docs/friction.md`, 2026-08-08.

## Invariants with no runtime symptom

The ones worth knowing because nothing fails when they break:

- **`self-check`** is `<caller job id> / <called job id>`. The CI wait excludes its own check run or
  it waits for itself — the whole 15-minute wait, then a review on degraded evidence. Nothing inside a
  called workflow can read its caller's job id, hence a required input with no default.
- **`bin` must not start with `./`.** `npm publish` silently drops such an entry and exits 0. The
  tarball is fine; only the registry manifest loses it, and the symptom is `npx <pkg> <cmd>` finding
  no command. `0.1.0` shipped exactly that.
- **Renaming or moving `assets/severity-*.svg` breaks images that are already posted.** Every
  review body and every thread this loop has ever written names one of those files at the tag it was
  posted under, so the file has to keep its name in every release that is still being read — which
  is every release. The break shows up on somebody else's year-old pull request and in no build
  here; `severityAssetPath` holds the one copy of the path, and the test that reads it only proves
  the *current* release is intact.
- **A job that reaches its `timeout-minutes` is cancelled, not failed** (#220). A step gated on
  `failure()` alone never sees it, so every failure step here runs on `cancelled()` too, and tells a
  timeout from a hand cancel by how long the job ran, off a clock its first step starts. Before that
  a timed-out run posted nothing, while the `always()` cleanup still took the label marking the run
  off.
- **A label set when an issue is *created* fires no `labeled` event.** Label in a separate call,
  always; recovery is remove-then-re-add.
- **A label added with `GITHUB_TOKEN` is a silent no-op**, which is why `AGENT_PAT` exists.
- **The *Authenticate to GitHub Packages* step is deliberately toolchain-free.** It is the registry
  half of `setup-node` — it runs on repos that skipped the toolchain step entirely, so it declares
  no `node-version-file` and passes `package-manager-cache: false` to stop the action inferring one
  from a `packageManager` field (automatic and defaulted on from v5; v6/v7 also read
  `devEngines.packageManager`). An input added there that does toolchain work fails *before* the
  runner exists to write `failure_reason.txt`, and this repo cannot reproduce it: it declares no
  `packageManager`, so the caching never fires here.

## The prompts name no domain

The runners and prompts must stay free of any consuming repo's vocabulary — a test walks the runner
surface and fails on it. The gate command is not named either: prompts say *"the verify command
`CLAUDE.md` names"*, so an adopter writes their gate down once, in their own `CLAUDE.md`.

This is why the loop can run anywhere. It is also why **this** repo needs its own `CLAUDE.md` and
`CONTEXT.md` — it is an adopter of itself.

## Where the rest is written down

| File | What |
|---|---|
| [`docs/ADOPTING.md`](./docs/ADOPTING.md) | installing the loop elsewhere; §1 is the silent failures |
| [`docs/friction.md`](./docs/friction.md) | a dated log of every time a human reached into the loop, and why |
| [`docs/parity.md`](./docs/parity.md) | how this compares to the upstream loops it was modelled on; §10 holds invariants |
| [`docs/agents/ticket-shape.md`](./docs/agents/ticket-shape.md) | how a batch of tickets is published, and in what order |
| [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md) | the triage vocabulary beside `agent:*`, and the only definition of the `wayfinder:*` labels two workflows refuse |
| [`setup/SETUP.md`](./setup/SETUP.md) | the prompt `init` leaves in an adopter's tree for the judgement work it cannot do |

`friction.md` is a **narrative log**, not a changelog: the commits are its timestamps, and entries
describe what was true when written. Do not edit history into it.
