---
status: accepted
date: 2026-10-31
---

# `agent:merge` is the maintainer's merge decision, and the loop carries it out

Until now the doctrine was that the loop never merges: a human merges, and `CONTEXT.md`,
`docs/ADOPTING.md`, `docs/parity.md`, `implement-prd.yml`'s header and the `merge-check` skill said
so. That joined two things. The **decision** to merge, which is the maintainer's judgement of one
head, and the **execution**, which is waiting for the base to stop moving, refreshing the branch,
waiting for CI on the refresh and pressing the button. This repository's ruleset on `main` requires
the branch to be up to date, so every merge puts every other ready pull request behind, and the
execution costs one round trip per merge per pull request. PRD #585 separates the two. This records
how, and why it is safe.

## The owner's decisions, 2026-10-31

Quoted verbatim from PRD #585:

> 1. Adding the `agent:merge` label to a pull request IS the human merge decision; the loop only
>    executes it. This amends the doctrine that merging is a human hand: the decision stays human,
>    the execution moves. The PRD must include an ADR slice (next number, e.g. 0009) recording
>    this and why, and update every doc/skill that says the loop never merges (find them).
> 2. If, after `agent:merge` was added, the head gains anything beyond a clean merge of the base
>    (an agent-resolved conflict, a fix round, a human push), the loop does not merge: it removes
>    `agent:merge` and asks for a fresh merge-check, naming the human. A clean update-branch merge
>    (no agent ran) keeps the label armed.

## The decision stays human, and the execution moves

**Adding `agent:merge` to a pull request is the merge decision, for the head it was added at.**
That act **arms** the pull request. The loop then merges it once the armed head is current with
its base, green and approved, and refreshes it from the base where it falls behind. It is a
standing authorisation, not a run's label: it stays on until the merge, a disarm, a refusal, a
stopped run, or the maintainer taking it off.

**The loop never arms a pull request.** It re-adds `agent:merge` to re-start its gate, as it
re-adds every trigger label (remove first, then add), and a label the loop added passes only on a
head that already carries an arm. No rule of the loop's, whatever the verdict or the budget, turns
an unarmed pull request into an armed one.

## What keeps unseen code out is the arm, not the verdict

The loop merges only the **armed commit**, or clean merges of the base onto it. That is the whole
of the safety argument, and the verdict is not part of it.

On Actions the `agent-review` verdict is posted as `github-actions[bot]`, and so is anything a
workflow file in the pull request's own branch posts on that pull request's events
(`docs/ADOPTING.md` §3b, *Making `agent-review` a required status check*). A fix agent steered
into adding such a workflow could post `agent-review: success` on its own push. The merge still
requires an approving verdict, but a verdict alone could be forged in exactly the place a merge
gate would be satisfying itself.

So **the arm is posted, and read back, only as the loop token's account**: the loop's App's bot, or
`AGENT_PAT`'s owner, never `github-actions[bot]`. It is a commit status, context `agent-merge`,
on the armed commit, naming the human who armed it. A status belongs to one commit and cannot be
edited, which is the shape the decision has. Nothing running from a pull request's branch can post
as the loop token's account, so nothing in the pull request can arm itself.

## Why a clean refresh keeps the arm and nothing else does

A **clean** merge of the base adds only the base's code, which is already on the base: it was
reviewed and merged there, and the maintainer's decision about the pull request's own change is
untouched by it. So `update-branch`'s clean path carries the arm on to the merge commit, as it
carries the verdict today, and the refresh the ruleset forces costs no second decision.

**Every other push adds code the maintainer did not check**: a conflict an agent resolved, a fix
round, a human's push (GitHub's *Update branch* button included) or a force-push. Each leaves a
head with no arm. The next gate removes `agent:merge` and names the human who armed it, asking for
a fresh merge-check on the new head. It does not say which kind of push it was: the record cannot
tell a human's push from an agent's without trusting text, and decision 2 treats them alike.

## Considered options

- **GitHub's native auto-merge.** Rejected. It survives a push by anyone with write access, so it
  would merge a fix round the maintainer never saw, which decision 2 forbids. It has no REST route.
  And it merges on required checks, so the verdict would have to be one, which §3b warns against.
- **A merge queue.** Rejected for the same verdict problem, and because it is a repository setting
  the loop cannot own: an adopter who has not turned it on would have a label that does nothing.
- **Arming by a comment command.** Rejected: a second trust surface beside labels, with its own
  parser, its own author check and its own way to be forged, for an act a label already expresses.
- **The git-only check: is every commit since the arm a clean merge of the base.** Stronger in one
  way, since it reads the history rather than a status. Rejected: it needs a checkout in a job that
  holds Contents: write, which ADR 0003's split keeps apart. And it would accept a human's *Update
  branch*, a clean merge the loop did not make, which decision 2 does not: only a refresh the loop
  made with no agent carries the arm.

## Consequences

- **A new label lifecycle**, beside *on while its run works*, *cursor* and *marker*: `agent:merge`
  is **armed until merged or disarmed**. It lands in `docs/ADOPTING.md` §3's column with the
  workflow that reads it.
- **`merge.yml` and its commands** (`merge:gate`, `merge:publish`, `merge:conclude`), a job in the
  reference pull-request caller, and on the service a **`merge` job kind** (ADR 0008). Neither runs
  an agent or checks anything out.
- **The loop's App needs Commit statuses: write** to post the arm. The Actions loop's App, the one
  plain `init` registers, does not hold it today, so `init` asks for it from that release, and an
  existing one needs it added by hand and accepted on each installation. A service-ready App, the
  one `init --service` registers, holds it already, for the service's verdict statuses. Without the App or `AGENT_PAT` there is nothing to arm
  with and nothing to merge with, and the run says so.
- **`update-branch:publish` carries the arm as it carries the verdict**, on its clean path only.
- **The doctrine changes wording, not substance.** Every doc and skill that said the loop never
  merges now says the maintainer decides and the loop can carry the decision out once armed. A PRD
  PR is still the one a human decides to merge. `merge-check` still writes and merges nothing
  unasked, and offers `agent:merge` at the checked head beside the maintainer's own guarded merge.

## Revisit when

GitHub lets a status, or another record bound to one commit, be posted only by a named identity
that a pull request's own workflows cannot assume. The verdict could then carry the safety
argument on its own, and the arm would be one record more than needed. Or when a push could be
attributed to a human or an agent from the record itself, which would let the disarm say which it
was.
