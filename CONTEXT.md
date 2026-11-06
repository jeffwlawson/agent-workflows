# CONTEXT.md

The domain model. Start at the [Glossary](#glossary), then read only the sections a change touches;
[CLAUDE.md](./CLAUDE.md) has the commands and conventions, [README.md](./README.md) is for people
installing the package, [docs/ADOPTING.md](./docs/ADOPTING.md) for people installing the loop.

Read elsewhere for: **the platform contract** (what a runner reads and returns, for any orchestrator),
[docs/platform-spec.md](./docs/platform-spec.md); **the service**,
[docs/deploying-the-service.md](./docs/deploying-the-service.md); **adopter-facing behaviour and its
silent failures**, [docs/ADOPTING.md](./docs/ADOPTING.md) (§1); **decisions**, [docs/adr/](./docs/adr/);
**why something was decided**, [docs/parity.md](./docs/parity.md) §10 and
[docs/friction.md](./docs/friction.md); **comparing this loop with others**,
[docs/landscape.md](./docs/landscape.md); **profiling a workflow**,
[docs/profiling.md](./docs/profiling.md); **publishing a batch of tickets**,
[docs/agents/ticket-shape.md](./docs/agents/ticket-shape.md); **the triage labels and `wayfinder:*`**,
[docs/agents/triage-labels.md](./docs/agents/triage-labels.md); **what `init` leaves an adopter to
judge**, [setup/SETUP.md](./setup/SETUP.md).

## Glossary

Read this first, then only the sections below that a change touches. Each term has a one-line
meaning, the words not to use for it, and the section that holds it in full.

| Term | Means | Avoid | Section |
|---|---|---|---|
| Agent loop | A labelled issue becomes a reviewed pull request with no human in the middle; the human decides the merge at the end. | | [What this is](#what-this-is) |
| Trigger label | An `agent:*` label that starts a run; it stays on while its run works and comes off in the run's last step. | `agent:in-progress` (retired) | [Trigger labels](#trigger-labels-and-the-order-a-run-ends-in) |
| Issue shape | What `agent:implement` partitions on: a parent with sub-issues goes to `implement-prd`, anything else to `implement`. | | [The PRD chain](#the-prd-chain) |
| PRD branch, PRD PR | The one branch every slice of a PRD is built on, and the one pull request from it into the default branch. | a branch or a pull request per slice; a stack | [The PRD chain](#the-prd-chain) |
| Slice range | A sub-issue's commits on the PRD branch, derived from `Agent-Slice` trailers in its first-parent log. | reading the next slice off which issues are closed | [The PRD chain](#the-prd-chain) |
| Slice round | An ordinary review round on the PRD PR, scoped to one slice range and its sub-issue's criteria. | | [The PRD chain](#the-prd-chain) |
| Finishing run, final review | The build run that finds every sub-issue built and runs no model; the full review of the PRD PR it asks for when more than one slice landed. | | [The PRD chain](#the-prd-chain) |
| Progress list | The PRD PR body's table of each sub-issue's state, re-rendered from live state; it carries the final review's mark. | | [The PRD chain](#the-prd-chain), [the pull request body](#the-pull-request-body) |
| Round header | The line opening every top-level review and fix comment, numbered off the pull request's own record. | | [Round headers](#round-headers) |
| Advance, park | Review's `advance` job re-adds `agent:implement` to the parent when a slice round ends on an approval, and otherwise parks the chain with a comment naming the ways on. | | [The advance, and parking the chain](#the-advance-and-parking-the-chain) |
| Fix-round budget | `AGENT_MAX_FIX_ROUNDS`, default 3: the automatic fix rounds a pull request (or one round of a PRD PR) may spend, counted from `agent-fix-round` statuses. | `auto-fix` (removed); a marker label | [The fix-round budget and the early stop](#the-fix-round-budget-and-the-early-stop) |
| Early stop | No further automatic round after a fix round that closed none of the findings it was given. | the round rule (retired) | [The fix-round budget and the early stop](#the-fix-round-budget-and-the-early-stop) |
| Verdict history | The verdicts on a pull request, which say whether a review follows a fix round. | reading that off who authored the commits | [The review a push asks for](#the-review-a-push-asks-for) |
| Severity | `high`, `medium` or `low` on every finding; it orders the list and decides one thing, through the fix threshold. | | [The review body, and severity](#the-review-body-and-severity) |
| Fix threshold | `AGENT_FIX_MIN_SEVERITY`, default `medium`: whether a review's open findings are threads (mixed) or minor findings (all below). | | [The fix threshold and minor findings](#the-fix-threshold-and-minor-findings) |
| Minor finding | A finding in the pull request's own code recorded rather than threaded, since every open finding was below the threshold; filed at merge as one issue per pull request. | | [The fix threshold and minor findings](#the-fix-threshold-and-minor-findings), [follow-up kinds](#follow-ups-and-the-post-merge-checklist) |
| Follow-up | A problem the pull request is not going to fix, recorded by the review and filed at merge; out of scope or minor, by its `kind`. | | [Follow-ups](#follow-ups-and-the-post-merge-checklist) |
| Out-of-scope note | A fix run's structured note of something outside the pull request, which the next review promotes or drops. | | [Out-of-scope notes](#out-of-scope-notes) |
| Finding | A review's entry, anchored at something the pull request changed, with a severity and an id; a reviewer closes it, the fixer never does, and a maintainer's decline outranks both. | | [Who closes a finding](#who-closes-a-finding), [where it is anchored](#where-a-finding-is-anchored) |
| Clean merge, conflict resolution | An `update-branch` merge that changed nothing reviewed, which carries the verdict and the arm on; and one the loop wrote code for, which copies nothing and asks for a review. | | [Clean merges and conflict resolutions](#clean-merges-and-conflict-resolutions) |
| Arm, disarm | A human adding `agent:merge` arms the head it was added at; anything but a clean merge of the base on that head disarms it. | the loop arming | [The merge: arm and disarm](#the-merge-arm-and-disarm) |
| Frame, summary block | The pull request body the opening run writes once; a review rewrites only the title and the summary block, and only when something was pushed since. | a description of the change in the review comment | [The pull request body](#the-pull-request-body) |
| Evidence, test-first check | The summary's Before (failing-first tests from the red check) and After (CI at the head); the body alone calls the red check the test-first check. | "test-first check" anywhere but the body | [The pull request body](#the-pull-request-body) |
| Merge Danger | The summary's door (`one-way` or `two-way`), blast radius, *Breaking:* lines and known issues. | | [The pull request body](#the-pull-request-body) |
| Post-merge checklist | The *After merge, by a human* items of the linked briefs, posted by `follow-ups` on every merge. | | [Follow-ups and the post-merge checklist](#follow-ups-and-the-post-merge-checklist) |
| Part | One of the caller, the reusable workflow and the package; which one a change belongs in is the distinction to get right. | layer (a pull request in a GitHub stack) | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Caller, caller file | One calling job an adopter owns (a `uses:`, its grant and its secrets), and the workflow file holding one or more. | "the workflow" (say which part) | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Reusable workflow | The part that keeps only what Actions can do: the job graph, the fork guard, the permissions ceiling, secrets, concurrency and timeouts. | a composite action | [The three parts](#the-three-parts-and-what-belongs-in-each), [why not a composite action](#why-reusable-workflows-and-not-a-composite-action) |
| Package | Every other step: one that reads or changes the pull request or issue, or decides anything. | | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Runner | The part of the package that does an agent's work: TypeScript plus a prompt, one subcommand, no arguments. | the package; the agent | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Command | A `<workflow>:<step>` subcommand that does an orchestrator's work on the record and starts no agent. | any subcommand; the adopter's own commands | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Subcommand | Any entry of the binary's table: a runner, a command, or the install path. | | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Writer, write log | The engine's way to change the record, one call per write, each logged as it lands. | a plan of writes | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Hand-over | The runner's files a command declares it reads, checked and cleaned; decisions as data and raw text, never finished strings. | | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Workflow's folder | `<name>/`, holding that workflow's runner and every command its jobs run; `shared/` is code two or more use. | | [The three parts](#the-three-parts-and-what-belongs-in-each) |
| Orchestrator | Whatever invokes a runner and acts on its result: the Actions orchestrator (a caller plus its reusable) or the service. | | [Orchestrator, the record and the agent](#orchestrator-the-record-and-the-agent) |
| Record | What the loop leaves on GitHub that a later run reads back. | | [Orchestrator, the record and the agent](#orchestrator-the-record-and-the-agent) |
| Agent | The model CLI a runner drives inside its sandbox. | the runner | [Orchestrator, the record and the agent](#orchestrator-the-record-and-the-agent) |
| Install path | `init` and `doctor`: subcommands a human runs, which put the callers in place and check them. | a fourth part | [The install path](#and-the-install-path-which-is-none-of-the-three) |
| Service orchestrator | A second orchestrator outside Actions: the dispatcher turns label deliveries into jobs, and the worker runs each as its reusable would. | a fourth part | [The service orchestrator](#and-the-service-orchestrator-which-is-an-orchestrator-not-a-part) |
| Fork guard, author gate | The job-level `if:` keeping a fork's head out of `pull_request_target`; and `isTrustedAuthor`, which decides whose text reaches an agent. | write access (the gate is org-adjacent or better) | [The trust boundary](#the-trust-boundary) |
| Split | A workflow that runs an agent: a gate, the agent's job with a read-only token, and a publish job on a fresh runner that writes. | | [The agent's own runner](#the-agents-own-runner) |
| Catch-up | `implement-prd`'s job that merges the default branch into the PRD branch before any agent runs. | | [The agent's own runner](#the-agents-own-runner) |
| Loop's identity | Who the loop's writes are made as: its App, then `AGENT_PAT`, then the workflow token, chosen by the token resolver. | | [The loop's identity](#the-loops-identity) |
| Base-controlled | `pull_request_target` reads workflow YAML from the default branch while checking out the PR head. | `@main` in a `uses:` | [Base-controlled](#base-controlled-and-what-that-now-depends-on) |
| Pin | The version in the YAML that takes the reusable and the package from one release. | | [The version pin](#the-version-pin-keeps-two-halves-in-step) |
| `self-check`, rescue branch | Two invariants nothing fails on: the job id the CI wait excludes, and the branch a stopped run's commits are kept on. | | [Invariants with no runtime symptom](#invariants-with-no-runtime-symptom) |
| Domain model | This file, which every runner prompt reads by name; the prompts themselves name no domain. | `GLOSSARY.md` | [The prompts name no domain](#the-prompts-name-no-domain) |

## What this is

A **GitHub Actions agent loop**: a labelled issue becomes a reviewed pull request with no human in
the middle, and the human is at the end, where the merge is decided. One workflow per label
transition, near enough:

| Label | Fires | Does |
|---|---|---|
| `agent:implement` on an **issue** | `implement` | branch, implement, open a draft PR, request review |
| `agent:implement` on a **PRD parent** | `implement-prd` | once the PRD PR's head carries an approval, merge the default branch into the PRD branch if it has moved, build the next sub-issue as commits on the PRD branch, open the PRD PR as a draft the first time, request the slice's round on it; or, with no sub-issue left, hand the PRD PR over |
| `agent:review` on a **PR** | `review` | wait for CI, review the diff, verify what earlier rounds found and resolve what landed, mark ready |
| `agent:fix` on a **PR** | `fix` | act on review feedback, reply to every thread it is asked about and close none, record what it did with the conversation comments, ask for a re-review if it pushed or left an out-of-scope note |
| `agent:update-branch` on a **PR** | `update-branch` | merge the base branch in, resolve conflicts, carry the verdict over or ask for a re-review |
| `agent:merge` on a **PR** | `merge` | the maintainer's merge decision for the head it was added at (the **arm**): merge it once that head is current with its base, green and approved; ask for `agent:update-branch` where it is behind; disarm where the head gained anything but a clean merge of the base ([ADR 0009](./docs/adr/0009-agent-merge-executes-the-human-decision.md)) |
| `agent:follow-ups` on a **merged PR** | `follow-ups` | file the out-of-scope findings and the minor findings its review recorded, as `needs-triage` issues (a stub each out of scope, and one issue for the minor findings); on **every** merge, labelled or not, post the linked briefs' *After merge, by a human* checklist |

### The PRD chain

`implement` and `implement-prd` share one label and partition on **issue shape**: a parent with
sub-issues goes to the PRD chain, everything else to the single-issue run. The chain works one
sub-issue per run, and waits for that sub-issue's review round to end on an approval before it
builds the next; review's advance (below) re-adds the label that moves it on.

Every slice is built as commits on one branch, the **PRD branch** (`agent/prd-<parent>-…`), and the
one pull request from it into the default branch is the **PRD PR**: the only pull request of a
chain, opened as a draft by the first build run, and the one a human decides to merge. Its base is the
default branch, so the CI configured for the default branch runs on every slice with nothing more
to set up. No slice has a branch or a pull request of its own (PRD #222).

A sub-issue's commits on the PRD branch are its **slice range**. Every commit a build run makes
carries an `Agent-Slice: #<sub>` trailer, written by `implement-prd:publish` before the push, out of
the agent's reach (#502), and
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
the PRD PR under the same early stop as anywhere else, and under a budget that is the **round's**
(#331): each slice round has the whole fix-round budget, and so does the final review, so a slice
never parks on rounds earlier slices spent. The PRD PR stays a draft through
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

Sub-issues stay **open** until the PRD PR merges: its body's `Closes` line names the parent and
every sub-issue, so the merge closes exactly the work it contains and a PRD PR closed unmerged
closes nothing. Progress is shown by the progress table and by comments, and **each run's link lives
on the sub-issue it builds** (#298): each build run comments there with the run link as it starts,
puts a link-free chapter marker (*Slice k of n · #sub started*) on the PRD PR, and says nothing on
the parent but once, link-free, on the chain's first run; the final review's start comment and the
failure comments are the two that carry a link elsewhere, since no sub-issue holds one for them. The
run after an approval says on the slice's sub-issue which commit was approved and which criteria
changed. No loop-written text puts an issue's title beside its `#N`: GitHub renders it already.

### Round headers

Every top-level review and fix comment opens with a **round header** (#298): *Slice k of n · #sub ·
review r* (or *fix f*), *Final review · review r* on the final review, *Review r* or *Fix f* on a
regular pull request. `shared/round-header.ts` numbers them off the pull request's own record,
restarting per slice: a review belongs to the slice whose range holds the commit it reviewed, or to
the final review where its header says so, and a fix round is an `agent:fix` label event, belonging
to the scope whose first review came last before it. So a hand-requested review counts, and so does
a fix round added by hand past the budget.

Rules marked *Pre-upgrade compatibility* in the code serve a chain an older release started
(#248).

### Trigger labels, and the order a run ends in

**A trigger label is on while its run works** (#236). The run leaves it on as it starts and takes
it off in its last step, however it ends: success, failure, refusal, timeout or cancel. So the
label on an issue or a pull request is the run working on it now, or the one queued behind it. The
one exception is on the service (#635): a run the plan's usage limit stopped leaves its label on,
posts its comment, adds nothing, and resumes by itself after the reset. On a PRD parent that
makes `agent:implement` on only during each build run; the advance puts it back. Two rules
follow from GitHub firing no event for a label already there. The loop adds a trigger label by
**removing it first**, so a stale one cannot swallow the request. And a request made **while a run
works** is not lost: a review or a branch refresh that ends to find the head moved since it
started, because somebody pushed, asks for its own step again, unless another trigger label is
on it: that is a run queued behind it, which a new request would cancel and strand. `fix` does not, since a second fix
run would answer the threads it answered. There is no lifetime "in progress" label on an issue:
an open issue with a linked pull request, a draft, and `agent:blocked` already give that view.

Every run ends in **one order**: post every result, take its own label off, then add the label
naming the next step; the usage-limit stop above is the one run that ends with its label on. A hand-off removes its trigger label just before it adds `agent:review`; a
failure comments, then removes it, then adds `agent:blocked`; a refusal does the same where the
maintainer has to act, and one that leaves nothing to act on (a closed issue or pull request, a
finished PRD, a deleted branch, a fix with nothing to do) comments and removes it, and adds nothing
(#253). Every such comment is in one of two patterns: `**`agent:X` stopped:**` and the reason, the
run and what to do, for a run that started; `**`agent:X` didn't run:**` and a sentence saying why
and what to do, for one refused before it did anything. The service's usage-limit ending is a
third, `**`agent:X` is waiting:**` and the reset time it resumes after, ending in its resume note
(#635); on Actions the same stop says `stopped:`, as any does. So nothing ever carries a run's label and the next step's at once, or `agent:blocked` with no word of why. A
review that found the head moved hands off one way only, and says so as `moved`: its fix-round and
advance hand-offs stand down, since its verdict is about a commit the pull request has left, and
`update-branch` asks for itself again only where it did not just ask for a review.

### Review's two jobs

**Review is the one run whose work and whose posting are two jobs** (#257). The review job runs the
model and writes nothing at all: no comment, label, status or review, and no write scope to make
one with. One **posting job** that runs no model then writes everything, in the order above:
it answers and resolves the earlier findings the review ruled on, then posts the overview and the
new findings in one call, whose *Resolved since last review* lists only the threads that actually
resolved (one whose resolve failed is listed as still open, with a note), then the pull request's
title and summary block where anything was pushed since the summary was written, then the verdict status
and the ready state, then takes `agent:review` off, then hands off. A refusal or a failure in the
review job is said by the posting job too, since nothing else can write it. The posting is two
commands (#417, #419): `review:publish` posts the results, and `review:conclude`, run however the
job went, ends the run. Conclude is told how the review job and each step before it ended, and
works out the ending from that, so a hand-off that fails after the review posted is said as a
failed hand-off, never as a review that did not finish.

### The review a push asks for

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
commits: the latest verdict asked for a round, and commits have landed since, or the fix run
posted an out-of-scope note since without pushing (#213). The review a
**conflict resolution** asks for follows no fix round, because a resolution posts no verdict and
the one before it asked for none. A fix run that pushed nothing and left no out-of-scope note asks
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
if it never does. And the review does not trust its payload: `review:gate` reads the branch tip
from the repository's refs, reviews the tip where it descends from the labelled commit, refuses by
name where it does not, and checks out, waits on CI for and posts every status on that one commit.

### The fix-round budget and the early stop

Review adds a trigger label in two cases. The first is on the pull request (#102): the posting
job's last step adds `agent:fix` when the verdict is *Changes recommended* and the pull request has
automatic fix rounds left in its **fix-round budget** (#201): the repository variable
`AGENT_MAX_FIX_ROUNDS`, default 3, `0` for none. A review whose open findings are all below the
repository's **fix threshold** (`AGENT_FIX_MIN_SEVERITY`, below) is an approval and starts no round at
all, so the budget is spent only on rounds a finding at or above it asks for. **Rounds spent** are counted from the pull request
itself: the `agent-fix-round` statuses the loop posted there, one beside each verdict that asked
for a round (#297; the verdict's own line is fixed, so it cannot be the record). There is no marker
label, so the count survives re-runs and hand edits, only automatic rounds count, and a push resets
nothing. On a PRD PR the rounds counted are this round's alone (#331): each status counts toward
the round its linked review's header names, a slice by its sub-issue or the final review, never by
the commit it stands on, since the final review's first round stands on the last slice's tip; and a
status whose round cannot be told leaves the count unreadable, which starts no round. The budget is
settled before the review runs, by `review:budget` after the checkout, since which slice is
current is read off the branch's history; so a review asks for a round only where one
will start, and the step decides from live state rather than the event payload: it adds nothing where
`agent:fix` is already on the pull request or a newer verdict stands, and says on the pull request
when a round it should have started did not. It is the return leg `docs/parity.md` §10 used to
forbid outright, and what makes it an arrow rather than a cycle is two bounds, both ruled on before
the key it selects on is derived. The budget bounds it per pull request, or per round of a PRD
PR, and the **early stop**
(#202) ends it sooner: after a fix round that closed none of the findings it was given, matched by
the ids the workflow wrote into them, no further automatic round starts, whatever budget is left.
New findings the re-review raised neither count as progress nor reset anything. The verdict then
says why the loop stopped, and gives the same **three ways on** as a spent budget: `agent:fix` for
another round; decline a finding by replying to it, then `agent:review`; or push a commit, then
`agent:review`. The step
is in the posting job, which checks nothing out and runs no model, which is what keeps
`AGENT_PAT` away from the job that reads the pull request. Waiting has no label either (#204): a
native "blocked by" link says an issue waits, and `implement` refuses while one is open. A pull request whose
automatic fix is about to start also stays a **draft**: draft means the loop is still
working, and what marks it ready is whichever end the round comes to — the re-review, where the fix
pushed or left a note, and the fix run itself where it did neither and so asked for none.

### The advance, and parking the chain

The second is the **advance**, a second arrow, and it lands on an issue rather than a pull
request (#176). It is one job, `advance` in `review`, and it fires only on a PRD PR (head under
`agent/prd-`, same repository). When a slice round ends on an **approval**, it re-adds
`agent:implement` to the PRD's **parent**, parsed from the head name, and the `implement-prd` run
that starts passes the approval gate and builds the next slice, or finishes. When a slice round or
the final review ends any other way, the same job **parks** the chain: it comments on the parent
naming the slice (or "final review"), why the round stopped (the slice's or the final review's
fix-round budget spent, no
progress, a review that needs a closer look, a run that did not finish), the open findings with
links, and the three ways on. A verdict that started a fix round is
neither, and the job does nothing on it. At every ending it first writes the progress list.
`fix` has no copy of it: only a review posts an approval, and every fix run on a PRD PR ends in
one. It cannot cycle: it never labels a pull request, the run it starts builds one slice and asks
for one round, or refuses at the gate, and it is **bounded by the number of sub-issues**, because a
finished PRD refuses the label. It is a command, `review:advance` (#423), pinned to the release
like the runner (no checkout, no model, and the loop's App or `AGENT_PAT` for the parent, or
nothing there). The review hands it the round, the park reason, the open findings and what the
progress list is rendered from, as data, and it writes every string itself.

### Clean merges and conflict resolutions

`update-branch` asks only on the half of its work an agent wrote. A **clean** merge changed nothing
the last review read, so it carries that review's verdict on to the merge commit instead — a
commit status belongs to a commit, so without the copy every merge into a base branch would wipe
the verdict off every open PR that refreshes against it. A **conflict resolution** is the loop
writing code no review has seen, so it copies nothing and asks.

### The merge: arm and disarm

**The merge is decided by a human and carried out by the loop** (PRD #585, [ADR
0009](./docs/adr/0009-agent-merge-executes-the-human-decision.md)). Adding `agent:merge` to a pull
request is the maintainer's merge decision, for the head it was added at: it **arms** that commit,
recorded as an `agent-merge` commit status on it, posted and read back only as the loop token's
account and never as `github-actions[bot]`, which a workflow in the pull request's own branch can
post as too. **The loop never arms.** It re-adds `agent:merge` to re-start the gate, and a label it
added passes only on a head that already carries an arm. The loop merges the armed commit, or
clean merges of the base onto it, and nothing else, so what keeps unseen code out is the arm, not
the verdict. A **clean** `update-branch` merge carries the arm on to the merge commit, as it
carries the verdict, because it adds only the base's code, which is already on the base. Anything
else on the head (a resolved conflict, a fix round, a human's push, GitHub's *Update branch*
button, a force-push) leaves it unarmed, and the next gate **disarms**: it takes `agent:merge` off
and asks the human who armed it, by name, for a fresh merge-check. The label is a standing
authorisation rather than a run's label, armed until merged or disarmed.

### Who closes a finding

**The reviewer closes a finding; the fixer never does** (#109). A `fix` run replies in
every thread it is asked about — every open one bar a thread whose close failed, which already
carries the reply that settles it and is shown for its evidence only (#133) — and resolves none of
them, and every review, after a fix round or not, takes the findings an earlier review left open, rules
on each by the id the workflow wrote into it, and resolves the ones the current code settles. That is not tidiness: a resolved thread is dropped from the feedback
the next review is handed, so while the fixer closed its own threads the one pass whose job is *did
it land?* could not see what it was checking. A review after no fix round does it too, because a human may have pushed
the fix and the question has the same answer whoever wrote the commit.

**A maintainer's decision outranks the reviewer's and the fixer's** (#109). A thread a *human* resolved is
handed to every later review as settled, with the instruction not to raise it again in any wording;
a thread where a maintainer **replied** declining the finding is closed by the reviewer as
`WONT_FIX`, quoting them, and stops counting. The review never overrules a maintainer and never
declines on its own authority — a reply it cannot read as a refusal leaves the thread open, which
is the safe direction because an open finding costs a round and a wrongly closed one costs the
decision. What makes the decline usable is the author gate rather than the reading: only a reply
`isTrustedAuthor` passed reaches the agent at all, and only one it passed can close a thread, so a
decline typed by anyone at all is a finding that stays open.

**In the fix half a maintainer's comment is a direction rather than a ruling** (PRD #101). The gate is
the same one — only a comment `isTrustedAuthor` passed reaches either agent — so what the fix brief
adds is weight, not trust: a maintainer's comment is what that run follows, above a reviewer's
finding where the two disagree, and a maintainer asking for something no review raised is asking
inside this change's scope, because the bound on expanding a pull request is a bound on what a
*finding* may pull into it. The fixer may still decline a direction it believes is wrong, on the
terms it may decline any comment, and says why. What it may not do is weigh a maintainer's ask as
one more finding.

### Outcomes on conversation comments

**An outcome is owed on a comment that has no thread** (#104). A
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

### Out-of-scope notes

**A fix run's out-of-scope note ends as an issue or as a decision not to file one** (#213). The
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

### The review body, and severity

**The review body is where the rounds are kept** (#109). It is a findings
record, not a rendering of the latest pass: the round header, `## Agent review`, the assessment, one sentence the
review wrote naming what is unresolved, the step, a count, then *Open*, *Minor findings* (#616), *Previously missed*,
*Still open* (closures GitHub refused, #257), *Resolved since last review*, *Acceptance criteria*,
*Since the brief*, *Not checked here*, *Follow-ups* and *Notes from `agent:fix` not filed*, then
*How this was checked*, then a rule and the run. A group with nothing in it is
omitted, except *Not checked here*, which is on every review (#543): what the review's own test run
skipped of the tests exercising the change, for want of something in the environment, with the
reason; or that it skipped none, ran none, or did not say. Its content, never its absence, says
what went unchecked, and it derives nothing. The horizontal rule before the run is the only divider in the body. Every entry carries a **severity** — `high` / `medium` / `low`, which orders the list
and decides **one thing**, through the repository's **fix threshold** (#616), and nothing finer: whether
the review's open findings are threads that block the merge or minor findings (below). With the threshold at
`low` it decides nothing, and a test permutes it across a review and holds the outcome identical. It is
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

### The fix threshold and minor findings

**The fix threshold places the open findings, once per review** (#616). The repository variable
`AGENT_FIX_MIN_SEVERITY` is `low`, `medium` or `high`, `medium` where unset, and `review:gate` refuses
any other value by name. After the review has verified what was carried and before it writes
anything, the runner looks at the **open set**: its own findings that would be threaded (not the ones
moved to follow-ups, below) and the carried threads still open. A finding **meets** the threshold at or
above it; `high` meets every one, and so do a finding with no severity to read, carried or new, and an
acceptance criterion ruled unmet, so a missing rating can only block an approval. Where any open
finding meets it, the review is **mixed**, which is every review before this setting: every finding a
thread, lows included, so the round a medium starts fixes the lows beside it. Where at least one is
open and none meets it, the review is **all below**: none is a thread, each is a **minor finding**, a
follow-up of kind `minor` with its title, location, severity, body and id, listed under *Minor
findings* directly after *Open*; a carried thread still open is resolved by `review:publish` as
`MINOR`, with a reply saying why, and becomes a minor finding under its own id. Nothing is open, so the
verdict is the checks': *approval recommended* on green, and with it the green status, the ready
mark and the PRD chain's advance. A minor finding is carried and ruled by id on **every** pull
request, as #495 carries a PRD PR's follow-ups: one a later commit fixed is ruled resolved and drops
off, and one is never threaded again, in a later mixed review or otherwise. The fix agent is handed
them in a section of their own (`# MINOR FINDINGS`), beside the threads, owing no outcome on them;
a pull request whose only work is minor findings is not one with nothing to do. They are filed at
merge. The approval's fixed line says nothing blocks the merge, never that nothing is left (#105,
#124).

### Where a finding is anchored

Since #127 no finding the review raises is thread-less. **Every fix-before-merge finding is anchored
at something the pull request changed** — a line the diff covers, or the changed file where it
covers no such line — because GitHub opens a thread against nothing else, and a finding with no
thread is one a maintainer cannot reply to, decline or resolve. *Changed* is wider than *has a line
in the diff*: a file the change deleted, renamed, rewrote in binary or only chmod'd names no new
side, and each is a file-level thread rather than a demotion. A problem in a file the change never
touched is anchored at *the change that causes it*, with the untouched `path:line` named in the
thread; a problem nothing in the change causes was never this pull request's to fix, so the
workflow records it in `followUps` and the body says under the count that it did. So every entry
in the record has a thread, and a finding is carried from its thread alone (#224): the review no
longer reads one out of an earlier review body, and the model no longer restates its findings in a
second list that could hold a line with no finding behind it.

The prose beside the record is capped by the schema rather than asked for in the brief, and
**restates no finding**: the findings are above it with their severities, and the one 250-word
paragraph that mixed *what the change is* with *what the reviewer verified* is what made a body
long enough to bury the record in it.

### Acceptance criteria, and what changed since the brief

**Every review checks the linked issue's acceptance criteria one by one** (#214). The workflow
reads them off the issue (its acceptance section, or where triage posted a brief as a trusted
comment the latest such section, which supersedes the body's; or its body's checklist where there
is none) and hands them over by id; the review rules on each as *met*, *changed* on purpose with
the reason, or *unmet*. On an issue opened by an outsider it reads **trusted comments only**
(#444): their acceptance section, by the same rule, and never the issue's body or title, so never
a checklist either. That is how a maintainer adopts an outsider's report: by restating what done
means in a comment. An unmet criterion is a fix-before-merge finding,
anchored at the change nearest to it like any other; a changed one is not a finding, and is listed
with its reason in the body's *Acceptance criteria* section. A review handed none says why in one
line in that section's place (#435): the linked issue was read and yields none (naming both ways to
write criteria the loop reads), there is no linked issue, or its text was not read because of who
opened it (saying a maintainer can restate the criteria in a comment). The runner hands over which
case it was, and `review:publish` writes the line. On a PRD
PR a slice round is handed its own sub-issue's criteria, and the final review is handed none and
says nothing: each slice was held to its own in its round, and the final review reads what each
round recorded.

Wherever a review is handed criteria, it is also **handed what changed since the brief** (#541).
The brief is the text the criteria came from; the workflow reads the commit its *Where things are*
section says it was read at, and lists the commits since then that touched the files that section
names: on the base branch, and on a slice round also the PRD branch's commits before that slice,
never the commits under review. The review rules in one line on whether any of them changes what a
criterion means, and moves a criterion through the rulings it already has (*changed*, *unmet*, or
`needsYou`), so the list adds no verdict of its own. `review:publish` shows the list and the ruling
in a *Since the brief* group beside *Acceptance criteria*, naming any named file gone from the base
or path not found at the read-at commit, and on a slice round where the PRD branch's commits
before it could not be listed; where the check could not run (no such section, no read-at commit,
one that does not resolve or is not on the base, no named file at it, or git failing to read it) it
says why in one line there instead.

### The pull request body

**What the change is lives in the pull request's body, not the review** (#218). The run that opens
a pull request writes its **frame** once and never again, in the order #298 settled: a note saying
what the loop does with it and how to steer it (linking the opening run), opening with a one-line
**status** between `<!-- agent:status -->` markers; a `---` rule (#353); `## Summary` and a **summary block** between
`<!-- agent:summary -->` markers; on a PRD PR the **progress table** between `<!-- agent:progress -->`
markers (#246: each sub-issue not started, building, in review, fixing, parked or approved, with its
reviews, fix rounds and a diff of its slice range, and the final review's row; re-rendered from live
state by every build run, including one that stops, and at every ending of a round; edited in place
only where a job that runs no toolchain writes exactly what the render would, a building slice's row
and the final review's, held equal to it by a test; and holding the final review's mark), set off from the summary block by a second rule; and the `Closes` line at the bottom. The status
line is rendered beside the table on a PRD PR, and by the review's posting job on a regular one. The
review writes the summary block and the title, and nothing else in the body: a maintainer's notes outside
the markers survive every round byte for byte. The rule is **anything pushed since the summary was
last written rewrites both** (the first build, a maintainer's push, a conflict resolution and a fix
round alike), and nothing pushed leaves both alone. The block carries the head it was written at,
which is how the rule is read: not from the verdict history, which says what a verdict has seen
rather than what a summary has. A maintainer's edit inside the block is input to the next rewrite,
kept where it is still true. The agent produces `title` and `summary`; the posting job writes them,
splicing into the body as it stands then rather than as the review read it. Under the agent's
summary the runner adds the **Evidence** (#234, #355) under a `## Evidence` heading, as a
**Before** and an **After**. Before is the failing-first tests from the red check's report, red ones
only, each with its assertion, or which of *not checked* (the check is off), *unknown* (its report
could not be read or held no result) and *none* holds instead. After is CI's result at the head the
summary describes, `green`, `red` or `unknown`, from the file the verdict reads; it never claims a
named test passed, since the red check runs nothing at the head. The body calls the red check the
**test-first check**, and nothing else does: input, job and doc names keep "red check", since
renaming an input would refuse every adopter caller that sets it. The review may sketch what a
failing-first test checks (`testSketches`), and the runner places at most three, each only on a test
the report lists as red, so a sketch can describe a test and never add one. A block written before
#355 carries the old `### Failing-first tests` heading, and the rewrite cuts at either. Last, under a
`## Merge Danger` heading (#356), the runner lays out the review's **door**, `one-way` where a revert
cannot undo the change (a published release, deleted data, a migration) and `two-way` otherwise; its
**blast radius**, one word of the adopter's own, and who it reaches from when (on merge, or at the next
release), which is where timing lives rather than in the door; a **Breaking:** line per change a
caller or a user has to act on, which the summary's prose no longer marks; and the **known issues**,
this review's follow-ups, filed when the pull request merges. Each optional part is left out when
there is none. So the review comment
carries no description of the change, and the description exists in one place.

### The PRD PR's summary

On a PRD PR of more than one slice the summary is the final review's alone (#298): a slice round
writes neither the title nor the block, which holds a placeholder until then. A PRD PR's **final
review** writes both however little was pushed (#247). Its summary is the whole PRD's, in the same
layout as a regular pull request's (#356): the review's outcome, its sketches and a bullet per
behaviour change they do not already show; a **Differs from the PRD:** line per slice that changed or
dropped a criterion, rendered from that slice round's record (read by the commit it reviewed, through
the slice ranges), with a line saying so for a slice whose record could not be read, and none where
no slice differed; the Evidence (#235, #355): where the red check is configured one Before/After entry
per slice, its failing-first tests read off the same rounds, and where it is off one entry for the
whole pull request; and the Merge Danger, of the whole PRD, its known issues naming the follow-ups
filed at merge. A slice round's red check runs against
the PRD branch as it stood before that slice, its slice range's base, rather than the merge-base,
so each slice's tests run on code holding every earlier slice; the final review runs none, and holds
each slice's changes to that slice round's record. The same write removes the frame's
**draft-only** note, between its own markers, so a PRD PR marked ready says nothing about being a
draft.

### Follow-ups and the post-merge checklist

`follow-ups` is the row that is not quite a label transition. The **merge** is what fires it and
the label is a marker it reads — re-adding that label to a closed PR is a manual entry point rather
than the normal path — and it is the one workflow an adopter can decline by not copying its caller
(`docs/ADOPTING.md` §4). It has **two jobs** (#544). On every merge, labelled or not, it posts one
**post-merge checklist**: the *After merge, by a human* items of the linked issue's latest brief,
the one the review reads its criteria from, or on a PRD PR of the parent's and every sub-issue's,
each under its issue, read from trusted text only and cleaned, and posted once. Then, only where
the label is on, it **files**: the label gates the filing and nothing else, since removing it is
the opt-out of filing, not of being reminded. It is also the only one that runs **no model**: the review agent records
the findings and cannot file them, and the workflow holding `issues: write` decides what to file
with a pure function (`docs/parity.md` §10). On a PRD chain it fires once, at the PRD PR's merge, since nothing
merges into the PRD branch through a pull request any more (#247). That PR's newest review carries
forward, de-duplicated by the id the workflow gave each entry, every follow-up an earlier round on
it recorded, because each round there is scoped to one slice and none restates another's. The
review rules on each carried entry, still open or resolved at the head it reviewed (#495): one
ruled resolved is dropped, named with its reason under *How this was checked*, and its id goes
into the payload so no later round carries it back from an older review; one ruled open, not ruled
on, or from before ids, stays. And the cap is **three per landed slice**, recorded in the payload and re-applied by the filing end. A
regular pull request is one slice, so its cap stays three and its review still restates its list
every round.

There are two **follow-up kinds**, told apart by the payload entry's `kind`, which the workflow
writes and never the model: **out of scope** (no `kind`, every entry before #616), a problem this
pull request is not going to fix, capped, each filed as its own issue; and **minor** (#616), a
finding in this pull request's own code the review recorded rather than threaded because every
finding open was below the fix threshold. Minor findings lead the payload, inside its exempt prefix
with the moved findings, so neither the cap nor the body's shedding reaches one; they are carried and
ruled by id on every pull request, a regular one included, where the out-of-scope list is still
restated; and they are filed at merge as **one issue per pull request** (#625), *Minor findings from
#N*, listing each with its severity, title, location and body, with a key of its own naming the pull
request and the kind. Out-of-scope follow-ups are not grouped: each is a separate problem in code the
pull request did not change, triaged and fixed on its own, and relatedness works per stub; minor
findings are one pull request's polish in its own code, so one issue per pull request is the triage
unit.

## The three parts, and what belongs in each

This is the distinction to get right, because a change put in the wrong part either cannot be
tested or cannot be fixed for an adopter without them editing a file.

```
consumer repo                    this repo
─────────────                    ─────────
.github/workflows/agent-*.yml    .github/workflows/<name>.yml     <name>/, shared/, setup/
  the CALLER                       the REUSABLE workflow            the PACKAGE
  a trigger and two wires          what only Actions can do         the runners, and every step
```

**The caller** is what an adopter owns: the trigger, the permissions grant, the secrets, and
`self-check`. It is deliberately tiny — anything an adopter can get wrong is something that drifts
across repos. Reference copies live in [`examples/callers/`](./examples/callers/) and are under
test.

**Caller, and caller file.** A **caller** is one calling *job*: a `uses:` naming a reusable
workflow, with that job's grant and secrets. A **caller file** is the workflow file holding one or
more of them, and the trigger is the file's. A caller's secrets are its own, and so is its grant
when it declares one; a caller declaring none runs on the file's top-level `permissions:`, shared by
every such job in the file, and a job-level block replaces that one rather than adding to it
(`setup/callers.ts`, `permissionsFrom`). Where `CLAUDE.md` says "both caller sets" it means the
files: `examples/callers/` and `.github/workflows/agent-*.yml`. A caller an adopter does not have is a workflow they declined, whether the file is missing or only the job.

**The reusable workflow** keeps only what Actions can do: the job graph and its conditions, the
fork guard, the permissions ceiling, which job names which secret, the concurrency group and the
timeouts; glue that only carries a value into one of those; the adopter's own setup and test
commands; and checkout, Node setup, artifacts and the token's mint. An adopter *references* it, so
a fix reaches them without them touching anything, and the pin takes the package from the same
release, so a fix in the package reaches them the same way.

**The package** holds everything else. A step that reads or changes the PR or issue, or decides
anything, is package code, run in the same job its shell would have run in. That includes the
guards written as steps, such as the preflight refusals and the bundle check, and the choice of
which token each write uses. [ADR 0003](./docs/adr/0003-reusable-keeps-what-only-actions-can-do.md)
records the rule and why it replaced "every guard and every step" in the reusable. Every reusable
workflow's deciding steps are commands, named `<workflow>:<step>` (`shared/contract.ts`, `COMMANDS`,
is the list). What shell is left in a reusable records facts only Actions has (a clock, a job's
status); a fix to a step goes in its command.

**A runner** is the part of the package that does an agent's work: TypeScript plus a prompt, invoked
as one subcommand of one published binary. It takes its whole input from the environment; passing
an argument is refused rather than ignored. Its boundary with whatever invokes it is
[`docs/platform-spec.md`](./docs/platform-spec.md) §2.

**A command** is the part of the package that does an orchestrator's work on the record: a step
that reads or changes the PR or issue, or decides anything, and starts no agent. It is invoked the
way a runner is, as one subcommand with no arguments and its whole input in the environment, and
fails the way a runner does. It is named `<workflow>:<step>`, such as `review:publish`, so a bare
name is always a runner. A command that
only decides or reads, as `review:gate` does before the review job's checkout (#420),
`review:budget` does for the fix-round budget after it (#331) and `review:collect-checks` does
for the CI wait (#421), is handed the GitHub reader and no writer, and what it settles leaves it
as a declared file: the gate's and the budget's the YAML copies into step outputs, and the CI
wait's the runner reads. A command that runs beside the pull
request's own code, as the red check's two do around the adopter's test command (#422), is handed
no token at all: it reads no repository, and the package it runs from was installed before that
code ran, by the one step that held the registry token. The kind is declared, not inferred: `shared/contract.ts` holds
runners in `RUNNERS` and commands in `COMMANDS`.
[ADR 0004](./docs/adr/0004-command-shape-and-folders.md) records the shape.

**The writer** is the engine's way to change the record. A command calls it once per write, with a
type named for what GitHub does (add a label, set a commit status, edit a pull request's title and
body against the live body, post a review, reply to a thread and resolve it), never for what the
loop means. The loop passes in its own strings, and splices its markers with the engine's helper.
The writer enforces a count limit per type set by each command, throws on the first failure
without latching, and keeps a **write log**: one line per write as it lands, and a last line for
how the command ended, appended to one of the command's declared outputs. It reads cleanly on the normal path: a refusal a write accepts, such as a label not there to remove, is an expected result, and GitHub's raw answer is kept only on a write that failed. A command is handed two
writers, one per token, sharing the log and the limits. The agent's text reaches a command already cleaned, and the loop adds its markers after
that. A job's package code is one command per stretch between steps only Actions can take, plus an
`always()` command where the job has a failure path.
[ADR 0005](./docs/adr/0005-writes-are-calls-with-a-log.md) records why there is no list of writes
planned before applying. The writer is in `engine/`, and review's posting job's two commands and
its `review:advance` write through it.

**The hand-over** is what crosses from the agent's phase to the commands that act on it: the
runner's files that each command declares it reads, checked and cleaned when they are read. The
facts recorded before the agent ran, such as the reviewed commit, are not part of it. They travel
apart, where the agent cannot write them, because they are what its output is checked against.
The agent's phase always runs as a process of its own, so the write token never reaches it.
The files carry the runner's decisions as data and the agent's raw text, never finished text:
the command that posts writes every final string and every marker, so no marker in the record
came from a file the agent could write.
[ADR 0006](./docs/adr/0006-hand-over-between-agent-and-publish.md) records the rule, and
[ADR 0007](./docs/adr/0007-publish-writes-every-final-string.md) what the files hold. Review's two,
to `review:publish` and to `review:advance`, are uploaded by exactly the files each declares, which
`tests/workflows.test.ts` holds, and read through checked readers before the first write.

**A workflow's folder** holds that workflow's package code: its runner, as `<name>/<name>.ts`, where
it has one, and every command that runs in its jobs, whatever the command writes to. So review's
`advance` lives in `review/` although it changes the PRD chain's parent, and `follow-ups/` is a
workflow folder with no runner in it. Folders follow the feature, except `engine/`, the code ADR
0002 keeps from importing the loop, which is the one folder drawn by layer. `shared/` holds loop
code that two or more workflows use, and nothing one workflow alone uses.

**Subcommand** is the word for all of them: every entry of the binary's table is one, whether a
runner, a command, or the install path below. *Command* alone means the kind above, never the
umbrella, and never the adopter's own commands (`inputs.setup`, the red check's test command),
which are always named as the adopter's.

**Part, not layer.** A **layer** is one pull request in a GitHub stack, and the PRD chain uses no
stacks: its slices are ranges of commits on one branch. Older entries in `docs/friction.md` say
*layer* for a part.

### Orchestrator, the record and the agent

Defined in [docs/platform-spec.md](./docs/platform-spec.md) §1: **orchestrator**, **record**,
**agent**. The Actions orchestrator is the one the three parts above describe; a second one,
[the service](#and-the-service-orchestrator-which-is-an-orchestrator-not-a-part), runs outside
Actions.

### And the install path, which is none of the three

`init` and `doctor` (`setup/`) are two more subcommands of the same binary, run by a human rather
than by a workflow. They are not a fourth part so much as the thing that *puts* the first one in
place and then checks it: `init` copies the reference callers in with the pin substituted, and
`doctor` looks for failures that are each a condition with no runtime symptom, which is why looking
has to be deliberate. `docs/ADOPTING.md` §0's table is the list of what it checks, and which failure
each check is for.

The boundary between them follows the one above: the caller is the adopter's, so a re-run of `init`
moves the pin in the files they have and changes nothing else about them. What a later release
changed *inside* a caller is `doctor`'s to name, with the fix, rather than `init`'s to overwrite —
a scaffolder that silently reverted a `with:` input would be manufacturing exactly the failure
class the pair exists to remove.

`init` also gives the loop its own GitHub App (#322), through GitHub's App manifest flow: a page on
the loopback interface posts the manifest to GitHub's create-App page, GitHub sends the browser
back with a code, and the code is exchanged, unauthenticated and never through `gh`, for the App's
ID, key and slug. It does so only where the App's secrets are not set and nothing says otherwise:
`AGENT_PAT` set is offered the switch, never put on it (#323): on a TTY the person is asked,
defaulting to no, and without one the PAT is kept and `init --app` named, since a question nobody
can answer must not hang a scripted run; `--app` switches without asking. A secret list it could
not read creates nothing. The secrets go on the organization only where the person is shown to be
its admin, and on the repository otherwise; `AGENT_PAT` is never deleted, and after a switch
`init` says it can be, and the token revoked. Like the policy and the labels, the App is
reached through an injected surface (`setup/app.ts`) that every call must name. `init --service`
(#562) registers a service-ready App through the same flow instead: the service's permissions
(`SERVICE_APP_PERMISSIONS`, the declaration the dispatcher checks the App against at start), its
webhook and its events, with the ID, key and webhook secret written to files the operator names,
mode 600, and none of them to the repository's Actions secrets.

`doctor` names it only where it was taught to. `diagnose` rules on a **fixed list** — every grant
the job a caller calls spends, an absent `permissions:` block, the `AGENT_PAT` wire, the identity the loop writes as and the loop's App's wire and its two halves (#321), the pin's shape
and its freshness, `self-check`, the labels, an Actions policy letting `pull_request_target` run on a public repository (#219), and the fix-round budget (#204): a variable the review would refuse, a budget above 0 with neither the App nor `AGENT_PAT` behind it (the default counts), a caller still passing the removed `auto-fix` (an error: GitHub fails every job in that file before any starts, #366), and a time limit variable that is not a positive integer (#220) — and reads nothing out of `examples/callers/`, so a
release that changes a caller *body* is a release that teaches `diagnose` about it in the same
commit, exactly as a new pin site is a change to `shared/pins.ts` in the same commit. Diffing an
adopter's caller against the reference is the other design and it is the wrong one here: most of
what differs is a decision they made, and a preflight that reported those as faults would be read
for about one release.

They ship in the same package as the runners on purpose. The version that writes a pin has to be the
version that pin names, and the version that diagnoses a loop has to be the one whose guards it
knows about; a separate installer is a second thing to keep in step with the release.

### And the service orchestrator, which is an orchestrator, not a part

The three parts are the Actions orchestrator's insides. The **service orchestrator** (PRD #453) is
a second orchestrator beside it, so it is not a fourth part: it does the job the caller and the
reusable do, for the repositories that opt in with `AGENT_ORCHESTRATOR=service` (spec §4.2). Its
processes are more subcommands of the same binary, in neither `RUNNERS` nor `COMMANDS`, and its code
is `service/`: not a workflow's folder, not `shared/`, and not `engine/`, since it imports the
contract and the record, which makes it loop code.

The **dispatcher** (#456) is the only holder of the GitHub App's key. GitHub's webhooks arrive at
one of its doors, and a trigger label's delivery on a repository that opted in, with the App
installed on its owner's account or one its `EXTRA_OWNERS` lists, becomes a **job**
for the worker: what the label's event carried, the repository variables the service reads, the App's login read
off the App's own record, an id, a deadline and the release. A job has a **kind**, one per workflow
the service serves, named in its `workflow` field and routed to from the trigger label: at this
release the kinds are `review` (`ReviewJob`), from `agent:review`, `fix` (`FixJob`), from
`agent:fix`, and `update-branch` (`UpdateBranchJob`), from `agent:update-branch`, each on a pull
request's delivery, and `implement` (`ImplementJob`, #517) and `implement-prd` (`ImplementPrdJob`,
#518), both from `agent:implement` on an issue's: that label starts two jobs, as it starts two
workflows on Actions, and each gate defers the other's issue shape without a word, so the
dispatcher never reads the shape. The last kind, `follow-ups` (`FollowUpsJob`, #519), is the one
not started by a label alone: every merge of a same-repository pull request starts it, whatever its
labels (#544), with no author gate, as does `agent:follow-ups` added to a closed pull request, with
one. And `merge` (`MergeJob`, #591), from `agent:merge`, runs `merge.yml`'s three commands with no
checkout and no agent; it is started as well, with no author gate and never arming, by a push, a
check suite's completion and a final status on the head of an open pull request carrying the label,
since the service's gate waits for nothing and those are what change its answer. Per pull request at
most one merge job runs and one waits in the worker's queue: one more is absorbed by the one waiting,
which reads the record when it starts, where that one's deadline is no earlier than its own, and
otherwise replaces it (#645), as a person's `agent:merge` does whatever the deadline; one waiting
that arms is never replaced by one that does not. Every trigger label the loop has is served. And
one kind is the service's alone: `setup-check` (`SetupCheckJob`, #821), from `agent:setup-check`
on an open issue, runs the repository's setup, `AGENT_SETUP`, and its verify command,
`AGENT_VERIFY`, on the default branch in the sandbox, starts no agent, and reports on the issue
through `setup-check:report`; no Actions workflow is behind it, since a caller's `setup:` already
runs in every agent's job there, so its label has no caller and `init` writes it nowhere.
The map is keyed by event, so a label is answered on the event type it belongs to and on no other,
and each event has a route of its own reading its own payload: an implement or implement-prd job carries an issue,
with no head, and the repository's default branch as its base. A job's deadline is its kind's own time limit plus the dispatcher's margin. The labels the service
answers, `SERVICE_LABELS`, are that map's keys, on either event. The label's sender must be able to write to the
repository, unless it is the App itself, whose labels the loop's commands add
([ADR 0008](./docs/adr/0008-service-job-kinds-and-own-app-sender.md)). A job carries no token. The worker
asks for one at the other door at the start of each phase, `read`, `ci`, `write`, `resolve` or `push`, and the dispatcher
mints one for that job's repository alone, before its deadline, after reading the opt-in again, so
deleting the variable stops a job in flight at its next phase. The job's format is one module,
`service/job.ts`, which both processes import, so it only has to hold within one release.
Neither process keeps its jobs past a restart, so the dispatcher **scans** (#581) at its start,
at the worker's, at a usage limit's reset, and every `SCAN_INTERVAL_MINUTES` (#790), so a reset's
lost announcement, or one that found the item still held, is recovered without a restart: since a trigger label is on while its run works, one on an open item with no job
held for it, by the worker or the dispatcher, is a run that never reached its ending, and is
dispatched as its delivery would have been, the actor of the label's latest `labeled` event
standing in for the sender. `agent:follow-ups` on an open pull request is a marker, not a run, and
is not scanned; on a pull request merged within `SCAN_MERGED_WINDOW_DAYS` it is (#603), since
`follow-ups:file` takes it off last, so one still on is a filing owed, and the scan dispatches the
merge's follow-ups job, as the merge's delivery would have. A merge carrying no label says nothing
is owed, so its post-merge checklist is lost with its delivery.
A delivery its door did not answer in time, a dispatcher down or restarting among the causes, is
**redelivered** (#774): GitHub tries once, so the dispatcher lists the App's recent deliveries
at its start and every `REDELIVERY_INTERVAL_MINUTES`, and asks again, once, for each that failed
within `REDELIVERY_WINDOW_MINUTES`; one is lost only past the window or with the poll off. Its
arrival is decided as a fresh delivery's, but skipped where its label has since come off or
anything holds a job of its kind for the item, as a scan's is.
`agent:merge` is not a run's label either, but a standing decision: it is scanned, so a dropped gate
is started again, and never counted against the limit below.
A job carries its dispatcher's **instance**, an id fresh at each start (#597), which the scan's
question at the worker names: the worker drops every job it holds queued from another instance,
whose id no dispatcher running now knows, so a dispatcher's restart alone loses only the jobs
that had started (#582: one running in each lane, and any update-branch waiting for the agent lane), and the scan dispatches the dropped jobs' items again.
A scan's dispatches are counted per item and label (#596), each when its job first asks for a token,
so starts running (#600): a job lost from the queue before it started is not counted. A job that
ends the worker's process, and keeps its label through every restart, is started at most
`SCAN_DISPATCH_LIMIT` times and then left for a person, with one comment on the item; that label's delivery resets the count.
What the record cannot hold of this, the scan's counts and the jobs the dispatcher dispatched, is
the dispatcher's own bookkeeping, kept in memory unless `STATE_FILE` names its **state file**
(#618, `service/dispatcher-state.ts`): one atomically written JSON file, read at start, holding no
secret. With it a restarted dispatcher keeps its counts, and adopts each job the worker still holds
once the queued ones are dropped, the ones that had started, so they end normally.
The dispatcher also writes the record in one place beside its stopped comment: each scan's pass,
and an `installation` or `installation_repositories` event that adds repositories, **converges the
loop's labels** (#823) on each repository it serves, before that repository's labelled items are
read: every trigger label the service answers and the state labels (`SERVICE_LABEL_SPECS`, the ones
`doctor` demands there), and the follow-ups labels `agent:follow-ups`, `pr-follow-up` and
`needs-triage` (`ADVISORY_LABELS["follow-ups"]`, which `doctor` only advises), together
`CONVERGED_LABEL_SPECS`, from `shared/loop-labels.ts`, the one list `init` and `doctor` read too. A
present label is matched by name without regard to case, as GitHub matches it. A missing one is created and one
whose colour or description differs edited, with a token minted for the writes alone; none is ever
deleted or renamed, retired ones included, which stays `init`'s and `doctor`'s. A refused list or
write is logged and tried again next pass, and stops nothing. So a release that adds or recolours a
label needs nothing done per repository on the service, and a repository there needs neither `init`
nor callers for its labels (ADR 0012).

The **worker** (#457) runs each job the way its workflow's reusable runs it, `review.yml` for a
`review` job, `fix.yml` for a `fix` job, `update-branch.yml` for an `update-branch` job and
`implement.yml` for an `implement` job, `implement-prd.yml` for an `implement-prd` job and
`follow-ups.yml` for a `follow-ups` job (and a `setup-check` job, which no reusable runs, as that
kind's *Service orchestrator* block in `docs/platform-spec.md` says), as a **thin adapter**: the same subcommands in the same
order, under each job's and step's `if:` rather than in order alone (`service/worker.ts`),
each a child process of its own installed package, so the service and every subcommand it runs are
one release. Each kind has a run function of its own, following its workflow's orchestrator
blocks, built from shared phase primitives: ask for a token, run a subcommand, run the sandboxed
runner, and run the repository's setup, `AGENT_SETUP`, in the bwrap sandbox in the checkout with no
token, never on the worker's host. It writes nothing
to the record and spells no record string; what it reads between phases is the hand-over the
reusable's glue steps read, copied across as it is; a phase it did not start gets its reason
written where the next command reads that phase's, as Actions would have it written there. Each subcommand's environment is built by one
function from its declaration in the contract, and holds nothing else of the worker's but `PATH`,
`HOME` and `LANG`, so a token reaches a subcommand only where its phase was handed it: the runner
gets the `read` token, never the `ci`, `write`, `resolve` or `push` one. A run function checks out what each of
its reusable's jobs checks out, a checkout per job, whether or not the job before left its checkout
changed (#530): `fix`'s publish job checks the head out again as `update-branch`'s does. It differs
only where a command needs it, and that workflow's *Service orchestrator* block in
`docs/platform-spec.md` says so, as implement-prd's publish checkout of `head` does. With `fix` served, the review's fix-round
budget is the repository's `AGENT_MAX_FIX_ROUNDS`, and the fix threshold its `AGENT_FIX_MIN_SEVERITY`, read as on Actions (PRD #515): the budget was held at 0
until something answered the `agent:fix` a review adds. A token's **kind** is what it may write: `read`
writes nothing, `write` adds what a posting phase writes (the pull request, issues and statuses),
`resolve` is `write` with Contents: write added, for `review:publish` alone, since GitHub lets
only a pull request's author or a holder of repository write access resolve its threads (#571),
and `push` is `write` with Contents: write and Workflows: write added, for a phase that pushes. Not
a wider `write`, which would hand review's posting phases push rights they never use, and not a
loop/workflow split as on Actions, since on the service both would be the same App identity. The
runner only ever gets `read`, so Contents: write with Workflows: write, the pair that can push a
workflow, is never where the agent runs.

Their settings are declared in `service/settings.ts` in the contract's style and read through
`readInputs`, like a runner's inputs, but they are no runner's inputs and have no row in the spec:
[`docs/deploying-the-service.md`](./docs/deploying-the-service.md) lists them, held equal to the
declaration by a test, and says how to deploy the service.

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
   having resolved that ref itself. A test asserts the `ref:` alongside the `if:`. What matters here is the opt-out:
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

### The agent's own runner

The gate above keeps an injection out of what the agent reads, and none of it bounds what an agent
that *was* steered can do where it runs: unsandboxed, with the runner's passwordless `sudo`. From
there it can read the memory of the runner process, which holds every secret its job names from the
job's first step — including one named only in a step that never runs, and none its job does not
name (probed 2026-10-02). It can also leave something behind, such as a hook, a git config entry, a
replaced binary or a process watching `/proc`, for a later step on that runner to hand a token to.
Scrubbing the environment and persisting no checkout credential (#306) close the easy reads, not
these.

So a workflow that runs an agent is **split**, as `review.yml` was first (#257): a gate that claims
the work, a job that runs the agent with a read-only token and names no PAT anywhere, and a publish
job on a fresh runner that writes. The agent's job hands over its commits as a `git bundle`, which
the publish job checks against what the gate read before pushing it. The gate decides the branch and
the base, never the agent's job, whose outputs the agent can write. One `concurrency:` group at
workflow level holds the jobs together, and is keyed so that another label's event takes a group of
its own: a workflow-level group is entered before any job's `if:` is evaluated, so an unkeyed one
would let any label cancel a run pending there (probed, #309).

All four workflows whose agent writes code are split: `implement.yml` (#307), and `fix`,
`update-branch` and `implement-prd` (#308). Two differ in shape. `update-branch`'s gate tries the
merge, so its agent's job runs only on a conflicted one, and its publish job makes a clean merge
again itself rather than taking one from any other runner. `implement-prd` has a fourth job, the
**catch-up**, between the gate and the agent's: it merges the default branch into the PRD branch and
pushes it before any agent runs, on a runner of its own, since the gate names no PAT and the agent's
job must not. The PRD PR's progress list shows the slice *building* from the gate, which already
holds the write scope and runs no agent (#312), rather than from the runner, whose token reads only.

### The loop's identity

**The loop's identity** is who its writes are made as: the writes the workflow token cannot make
usefully, because a push, a pull request, a ready-mark or a label made with it starts no workflow
or is refused outright. Three sources, in order: **the loop's App**, a GitHub App each owner creates
with `init` (one per account or organization, since minting needs its private key, which no two
owners can share), reaching a run as `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY`; then `AGENT_PAT`,
the supported fallback; then the workflow token, under the warnings every such write already gives.
Half an App is no App: both secrets, or the next source.

The **token resolver** is the one place that order is applied: the composite action
`.github/actions/loop-token` (#319, #320), which every reusable workflow that writes names and none
reimplements. It mints an installation token scoped to the run's repository where the App is set,
and reports which source it used (`app`, `pat` or `workflow`), which is what a step reads to
decide whether to warn, or name the label to add by hand, instead of adding one. It runs only in
jobs that run no agent: every publish job, `implement-prd`'s `catch_up`, and review's
`post-review` and `advance`, which mint; and review's `time-limit`, which asks for the source alone
and mints nothing. Each job that writes mints its own token before its first write that needs it
and hands it to no other, so the key and every token minted from it are on no runner an agent ran
on, which is what makes the App's Workflows: write acceptable.

The App takes over **writes** only. Reviews, comments, thread replies and commit statuses are still
the workflow token's, posted as `github-actions[bot]`, so the author gate's workflow-bot login and
every check that recognises the loop's own earlier posts are unchanged. Moving those is #305.

## Base-controlled, and what that now depends on

`pull_request_target` reads workflow YAML from the repository's **default** branch while checking
out the **PR head**. So a pull request cannot edit a caller to change what runs. Until 2025-12-08 it
read the PR's *base* branch instead; the move made the protection stronger, since a pull request into
a branch somebody else controls no longer picks that branch's copy of the caller.

And on a **public** repository it runs only where an Actions event policy lets it (#219). GitHub's
workflow execution protections block `pull_request_target` there by default, so
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
- **A stopped fix, implement-prd or implement run keeps its commits on a rescue branch** (#303,
  #270): `agent/rescue/fix-<pr>`, `agent/rescue/prd-<parent>` or `agent/rescue/issue-<n>`, never the
  branch the pull request tracks, or will, since a commit there would stand on its head unverified
  and with no verdict. Implement's is keyed to the issue's number, not its branch, so a retitled
  issue still resumes from it. The next run of the label resumes from it where it still builds on
  the head that run starts from (for implement, the base), sets it aside (and says so) where it
  does not, and a run that succeeds deletes it either way, except a fix run with
  nothing to do, which never read it. Rescued work reaches the pull request only through a resumed
  run's own push, after its verify.
- **A label set when an issue is *created* fires no `labeled` event.** Label in a separate call,
  always; recovery is remove-then-re-add.
- **A label added with `GITHUB_TOKEN` is a silent no-op**, which is why `AGENT_PAT` exists.
- **The *Authenticate to GitHub Packages* step is deliberately toolchain-free.** It is the registry
  half of `setup-node` — it runs on repos that skipped the toolchain step entirely, so it declares
  no `node-version-file` and passes `package-manager-cache: false` to stop the action inferring one
  from a `packageManager` field (automatic and defaulted on from v5; v6/v7 also read
  `devEngines.packageManager`). An input added there that does toolchain work fails *before* the
  runner exists to write `failure_reason.txt`, and this repo cannot reproduce it: it declares no
  `packageManager`, so the caching never fires here. The one input it takes beyond the registry is
  `node-version` (#335), wherever nothing else names a Node: always in follow-ups, which has no
  toolchain step, and in the other five only when `node-version-file` is `''`. The image's own
  Node sits below the package's `engines.node`. A version needs no checkout, so the step stays
  toolchain-free in the sense that matters.

## The prompts name no domain

The runners and prompts must stay free of any consuming repo's vocabulary — a test walks the runner
surface and fails on it. The gate command is not named either: prompts say *"the verify command
`CLAUDE.md` names"*, so an adopter writes their gate down once, in their own `CLAUDE.md`.
