---
name: conduct
description: "Conduct the agent loop from this session: stage and queue the ready work, watch the record with scripts, merge-check what comes back, and carry out the merges, fix rounds, releases and restarts you decide."
disable-model-invocation: true
---

# Conduct

You **conduct** a loop that already runs: from the ready queue to merged pull requests, with the maintainer at the **checkpoints** only. You pick the work, stage it, queue it, watch the record, check what comes back and prepare each decision. The maintainer makes it. **Push right**: do all the work you can first, then ask once, late, as a **brief** (the stake, the question, one recommendation with one reason, a link to the thing, never the raw output).

`/conduct` takes what is ready; `/conduct #A #B` or `/conduct #P` takes those issues or that PRD.

Words: a **task** is an issue or PRD the loop builds; a **trigger** is the label that starts a **run**; the **orchestrator** is what turns triggers into runs (GitHub Actions or the self-hosted service). A **runner** is the loop's subcommand that starts the agent. The computer a run executes on is **the agent box**, or **the machine**.

## Before the first action

1. **Two sources of rules.** They own everything this skill applies, and where they differ from it, they win.
   - **The repo** (`<owner>/<repo>` from `git remote -v`): its `CLAUDE.md` and its `docs/agents/`, for its verify command, its release steps, its standards and how to ask the maintainer.
   - **The loop**, at the release this repo runs: the `@v<tag>` on the `uses: jeffwlawson/agent-workflows/…` lines of its `.github/workflows/` callers. Read `CONTEXT.md` and `docs/agents/` at that tag (`gh api 'repos/jeffwlawson/agent-workflows/contents/<path>?ref=v<tag>' -H 'Accept: application/vnd.github.raw'`), and `docs/deploying-the-service.md` where the repo runs on the service. The running loop behaves as its release does, even in agent-workflows, whose `main` is ahead of its pin.
2. **GitHub access**: [references/github.md](references/github.md), before the first call.
3. **The ledger and the lock**: [references/ledger.md](references/ledger.md). Read the ledger or start it, and take the lock. A lock another session holds is a question for the maintainer before anything else: one conductor per repository, as one orchestrator per repository.
4. **The delegations still in force** in the ledger: confirm them in one question before acting on any.
5. **The skills this one routes to**, installed beside it: `merge-check` (a sub-agent invokes it); `issues-to-prd` (user-invoked, so a sub-agent reads [its SKILL.md](../issues-to-prd/SKILL.md) and follows it), with the `triage` it briefs by; and Matt Pocock's `retro` (user-invoked too: a sub-agent reads `../retro/SKILL.md`). Where any is missing, say so with the install lines from the loop's `skills/README.md`, and stop.

## The ledger

The record (the tracker, the git host, the orchestrator) is the loop's memory. Keep no second copy of it. The ledger holds only what lives in this conversation: the maintainer's **delegations**, their **decisions** no record holds yet, what is **watched**, the **escapes**, and the lock. Every write rests on a delegation in force in it, or on the maintainer's words in this turn.

## A session

1. **Pick** the frontier.
2. **Checkpoint 1, delegate a batch.**
3. **Queue** one task, and see its run start.
4. **Watch** until the loop hands it back or parks it.
5. **Checkpoint 2, decide a hand-back.** Act on the answer, then go to 3 with the next task.
6. **Checkpoint 3, cut a release**, and **checkpoint 4, restart the service**, when one is due.
7. **End**: the digest, the retro, the handoff.

Keep a watch running in the background at the end of every turn, and say what it waits for. A turn that ends with nothing watched leaves the batch idle while the maintainer is away.

## Pick the frontier

Read the `ready-for-agent` issues and PRDs, the open pull requests, and what is in flight (any `agent:*` trigger label on, any loop run in progress). The **frontier** is the tasks that are ready, have no open native blocker, carry no `agent:*` label, have no open pull request, and conflict with nothing in flight. Order it by native blocked-by links first, then by `issue-tracker.md`'s *When to block, and which issue goes first*. Two tasks **conflict** when they touch the same files (their briefs' *Where things are*, and open pull requests' files) or one would stale the other's brief: the later one waits until the first merges.

Run `issues-to-prd`'s gate on each task. Stale and unbriefed ones are triaged as its *A set* says, every sub-agent in one parallel dispatch, posting nothing. Choose each sub-agent's model and effort by risk (Opus for the risk list under *Hand-backs*, Sonnet otherwise; more effort where the brief decides a design) and say which you chose and why. Draft every brief locally.

Done when every task in the batch has a current brief drafted or posted, an order, and a reason for any task left out.

## Checkpoint 1: delegate a batch

One question for the whole batch, in [references/briefs.md](references/briefs.md)'s shape: post these briefs and build these tasks, one at a time, in this order? A *Ready* verdict is not a delegation; the yes is. Record it in the ledger, with the tasks and the order, then post what the batch needs (briefs, labels from `issues-to-prd`'s *Hand over*, edges) and queue the first.

## Queue and watch

**Queue one task at a time**, and only once no build is running: one this session queued, or one already in flight when it started. A second build runs against code the first is about to change. A delegated batch starts after the running build is handed back and decided. Add `agent:implement` alone, in its own call (github.md has the call and the start check). Within about 2 minutes the run comments with its link: on the issue, or for a PRD on its next sub-issue. With no comment, wait until about 7 minutes have passed before removing and re-adding the label, alone: the service redelivers a failed webhook delivery on a poll (default every 5 minutes), which starts the run with no toggle.

**Watch with the scripts**, run in the background, never with model turns that poll:

- [`scripts/snapshot`](scripts/snapshot) `<n>...`: one line of JSON per item (labels, state, head SHA, draft, the loop's verdict, statuses, checks, comment count).
- [`scripts/wait-until`](scripts/wait-until) `<minutes> '<jq predicate>' <n>...`: polls the snapshot until the predicate holds over the items, or the bound passes; prints its pid first, then only what changed, then `MATCH` or `TIMEOUT`.

Both read REST with conditional requests and make one listing call per poll for everything watched, backing off while nothing changes: the maintainer's token has 5,000 requests an hour, shared with everything else they run. Record each watch in the ledger by its items and predicate, never its pid, which dies with the shell. **Stop a watcher with `kill <pid>`**: `pkill -f` on a pattern also matches the killing command's own command line, and kills it.

A task is **handed back** when its pull request is ready for review (or a draft the loop left with a 🟡 verdict), carries no trigger label, has no run in progress, and has a verdict on its head. It is **parked** when it carries `agent:blocked`, or the loop's stop comment names why. A parked task is a brief for the maintainer, with the loop's reason quoted and its ways on.

## Hand-backs

Before checkpoint 2, check the pull request at its exact head, and write down that head's full SHA. Choose the check by what it touches:

- **The risk list**: the engine, the service, the sandbox, tokens and credentials, permissions, the release pipeline or publish, scripts run as root. `merge-check` on **Opus**, in a fresh sub-agent.
- **Other code**: `merge-check` on **Sonnet**, in a fresh sub-agent.
- **Docs, comments or tests only, or a small change outside the list**: read the diff yourself against the brief, and confirm the verify check is green on that head.

The repo's own docs override the list where they name one. A fresh sub-agent per check keeps each pull request's diff out of the others' context.

Each finding on a pull request the loop's review approved is an **escape**: the review brake missed what the human-side brake caught. Log it in the ledger. A finding that is the brief's own mistake is fixed in a fix round whose comment says what the brief got wrong and why; a review grades against the brief, so it cannot catch it.

## Checkpoint 2: decide a hand-back

Ask in briefs.md's shape: arm `agent:merge` at `<sha>` (or the guarded squash), or post these findings and add `agent:fix`, with the fix rounds left. Carry out only what the maintainer says, as github.md says: the merge at the full 40-character SHA you checked, a draft marked ready first, the findings as one review, `agent:fix` alone in its own call. A head that moved since the check is a fresh check, never a merge.

## PRD chains: start slow

A PRD chain builds every slice with no human until its PRD PR is ready, so hold it after slice 1 and `merge-check` slice 1's commits before letting it run on. [references/prd-chains.md](references/prd-chains.md) has the hold, checked against `implement-prd` at the pinned release. Read it before labelling a PRD with more than one sub-issue.

## Releases and the service

Both are checkpoints, and both live in [references/releases-and-service.md](references/releases-and-service.md): read it when a merge makes a release worth cutting (checkpoint 3), and when a release the service runs is out (checkpoint 4).

## End of a session

At a natural boundary (a release cut, the batch merged, or the context filling):

1. **The digest**: merge-check's digest, read as it is, *Needs you* first ([references/briefs.md](references/briefs.md#the-digest)).
2. **The retro**: `retro`, in a fresh sub-agent, over this session, with the ledger's escapes as its first sources ([references/briefs.md](references/briefs.md#the-retro) has its brief). Bring back what it proposes as one brief, with a drafted friction-log entry where the repo keeps one. Change nothing unasked.
3. **The handoff**: [references/ledger.md](references/ledger.md#handoff). Handing off ends this session's conducting: take no further action after it.

## Stop and ask the maintainer

At the four checkpoints, and before taking over a lock. Beyond them, only where the work cannot go on without a decision: a brief that is wrong or contradicts itself; a design question triage did not settle; anything that weakens a sandbox; the loop looks broken rather than the task; any spend on paid evals (say roughly how many runs, on which model); anything on the maintainer's own machines or accounts; the project's direction. Ask in `CLAUDE.md`'s *Asking me to decide* shape, where the repo has one: the stake in one sentence, the question, one recommendation with one reason. Ask about nothing you have not first prepared.

## Hard limits

`agent:implement`, `agent:fix` and `agent:merge` go on only where a delegation in force covers that task and that step. Every other write (a brief, a comment, a review, an edge, a merge, a release, a restart) is one the maintainer asked for or a delegation covers. Ask before closing an issue, detaching a sub-issue or removing an edge someone else set.
