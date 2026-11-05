# The digest: every open loop pull request, read-only

Asked for a digest (`/merge-check --digest`, "digest the open loop PRs"), you run the check on every open pull request the loop has approved, write nothing, and end with one **digest** shaped as a brief: what was found, why, a link, never the raw output, and what needs the maintainer first. A person reads it in a minute; another skill (`conduct`) reads it by its headings without re-deriving it. It is safe to run unattended, on a schedule, under a token that can only read.

## Writes nothing

No review, comment, label, merge, push, branch deletion, status, or edit to an issue or pull request; no Ready for review, no thread resolved. Every recommendation in the digest is for the maintainer to carry out. Local files in a scratch worktree (the checkouts, verify's logs, the digest file the invoker asked for) are not writes to the repository.

The calls a digest makes are these, all reads (`GET`, or `git fetch`), through `gh api repos/<owner>/<repo>/…`:

| Read | Call |
|---|---|
| Open pull requests, their draft state, head SHA and labels | `pulls?state=open&per_page=100` |
| One pull request, its `mergeable_state` and diff | `pulls/<n>`, and with `-H 'Accept: application/vnd.github.diff'` |
| Its files, for the merge order | `pulls/<n>/files` |
| The verdict and CI on a commit | `commits/<sha>/status`, `commits/<sha>/check-runs` |
| Agent reviews and review threads | `pulls/<n>/reviews`, `pulls/<n>/comments` |
| Issues and their labels, open loop issues | `issues/<n>`, `issues?state=open&labels=<label>` |
| Conversation, the loop's stop comments | `issues/<n>/comments` |
| Loop runs, in progress or stuck | `actions/runs?status=in_progress`, `actions/runs?per_page=30` |
| Sub-issues and blockers, for the briefs | `issues/<n>/sub_issues`, `issues/<n>/dependencies/blocked_by` |
| The head, for verify | `git fetch origin main "pull/<n>/head"` |

So a token with read access to contents, pull requests, issues, commit statuses, checks and actions is enough. A call outside this table is not made. A write that is refused is not retried by another route (the MCP file tool, a different token, `git push`): the refusal is the mode working, so leave it and go on.

## Never asks

A digest needs no answer to finish. Where the interactive mode would stop and ask the maintainer (SKILL.md's *Stop and ask*), write the question as a line under that pull request in **Needs you**, in the same shape (the stake, the question, one recommendation with one reason), and go on to the next pull request.

## Selecting

List the open pull requests and the open issues carrying an `agent:*` label. Each open loop pull request lands in one section below (one in flight is also named under **Skipped**, as `loop run in progress`, so that list of what was not checked is whole); read its draft state, head SHA, labels, runs and the `agent-review` status on its head.

- **Checked**: not a draft, no trigger label on it (`agent:implement`, `agent:review`, `agent:fix`, `agent:update-branch`, `agent:merge`; `agent:follow-ups` on an open pull request is a marker, not a run), no loop run in progress on it, and `agent-review` on the head is `success` (🟢 Approval recommended, the loop's `docs/ADOPTING.md` §3b). Checked pull requests go under **Needs you**.
- **In flight**: a trigger label on, or a loop run in progress. Not checked: a push or a probe now races the run.
- **Parked and blocked**: `agent:blocked`, a draft with no run in progress (the loop left it), or an item carrying the scan's stop comment (`**The service has stopped dispatching …`).
- **Skipped**, with its reason: a stale verdict (the newest `agent-review` status is on an older commit than the head: "verdict stale", not checked), a verdict that is not 🟢 (name it: 🟡, 🔴, pending, or none), or a draft not left by the loop.

An open pull request with no loop branch, no `agent:*` label and no `agent-review` status is not a loop pull request and is left out.

## Each checked pull request

The same check as the single-PR mode, SKILL.md steps 3 to 5: the briefs, verify on the exact head with `scripts/verify.sh`, the review axes and the probes you can run. One scratch worktree per pull request, removed afterwards. Where the head moves during the check, the result is for the head you checked: say so, and recommend a re-check.

## The digest

In the reply and, where the invoker asked, to a file they name. Six headings, in this order, every time; a section with nothing in it says `none`.

```markdown
# Merge-check digest, <owner>/<repo>, <UTC time>

## Needs you
## In flight
## Parked and blocked
## Escapes
## Service health
## Skipped
```

1. **Needs you.** One line per pull request waiting on the maintainer: `#<n>` and its title, as a link; `at <short head SHA>`; what the check found (`merge-ready, no findings`, or the count and the worst finding in a phrase); the verify result (`verify 0` or what failed); and **a recommendation**, which the digest does not carry out: arm `agent:merge` at that head, or post the findings and add `agent:fix` (naming the fix rounds left, where the `agent-fix-round` statuses show them), or re-review. A question the interactive mode would have asked is a line here too. Beneath each line, indented, the findings (file and line, what is wrong) and the *After merge, by a human* items, so a reader can skip them. Where several pull requests touch the same files, end the section with the order to merge them in, and why.
2. **In flight.** One line per open loop pull request or issue with a run in progress or a trigger label on: what is running (the label, the run's link), and the time in it, where the record shows it (the run's `run_started_at`, or the label's `labeled` event).
3. **Parked and blocked.** Grouped by the **reason the loop gave**, quoted from its stop comment (`**agent:X stopped:**` or `**agent:X didn't run:**`, or the scan's stop comment), with the items under each reason. Two or more items under one reason, or an item stopped with no reason given, are marked `possible loop defect`: the loop always says why it stopped.
4. **Escapes.** One line per finding the check raised on a pull request the loop's review approved: the pull request, the file, the head it was found at, and the finding in a phrase. Every finding on a checked pull request is an escape by definition; classing it, and proposing the fix, is not this mode's job.
5. **Service health.** Only what read calls on the repository show: items carrying the scan's stop comment, runs in progress for longer than their time limit would allow, stop comments with no reason. What needs the worker's machine (versions, the queue, the dispatcher's state) is `not checked`, unless the invoker passed the output of the deployment's own check, which is then quoted unaltered. Invent nothing.
6. **Skipped.** Each open loop pull request not checked and not listed above, and why: draft, verdict stale (`agent-review` at `<sha>`, head at `<sha>`), a loop run in progress, or not 🟢.
