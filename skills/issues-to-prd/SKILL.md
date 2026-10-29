---
name: issues-to-prd
description: "Stage existing issues for the agent loop: group a set into ready-to-label PRDs (existing issues as ordered sub-issues) plus plain issues, or check a single issue and say what it needs."
disable-model-invocation: true
---

# Issues to PRD

You **stage** work for the agent loop, then stop. The result is PRD parents and plain issues, each ready for the maintainer to add `agent:implement`. From that label on it is the loop's ordinary workflow: you touch no pull request and watch no run.

## Before the first action

1. **Two sources of rules.** They own everything this skill applies, and where they differ from it, they win. Read both now.
   - **The repo** (`<owner>/<repo>` from `git remote -v`): its `CLAUDE.md` and its `docs/agents/`, for its own conventions, labels and how to ask the maintainer. A repo may have neither; the loop's copies below then stand in.
   - **The loop**, at the release this repo runs: the `@v<tag>` on the `uses: jeffwlawson/agent-workflows/…` lines of its `.github/workflows/` callers. Read these files at that tag (`gh api 'repos/jeffwlawson/agent-workflows/contents/<path>?ref=v<tag>' -H 'Accept: application/vnd.github.raw'`), because the running loop behaves as that release does, even in agent-workflows itself, whose `main` is ahead of its pin:
     - `CONTEXT.md`: the PRD chain, the shape it walks and what it refuses.
     - `docs/agents/ticket-shape.md`: the PRD shape, its labels, and *Verify natively*.
     - `docs/agents/issue-tracker.md`: native relations and the database-id trap, *Before a brief*, *When to block, and which issue goes first*.
     - `docs/agents/triage-labels.md`: the two label vocabularies.

   Where the repo's own `docs/agents/` file and the loop's differ, the repo's wins for its labels and conventions, and the loop's wins for what the loop does.
2. **GitHub access.** Read [references/github.md](references/github.md) before the first call.

## One issue: the gate

Read the issue, its comments, its labels, its native links (parent, sub-issues, blocked-by) and any linked pull request. Report the first row that matches, with its reason, and stop: post, label and dispatch nothing.

| Finding | Verdict |
|---|---|
| Closed, or a `wayfinder:*` ticket | **Not implementable**, and why. |
| An `agent:*` label on it, or an open linked PR | **Already running**: name the PR or run. |
| A sub-issue of a PRD | **Wrong level**: "Label the parent #P instead; it builds its sub-issues in order." |
| A PRD parent | **Ready as a PRD** if its sub-issues pass this gate; otherwise name the ones that do not. |
| No *Agent Brief* comment, or still `needs-triage` | **Triage first**: "Run `/triage #N`." |
| A brief, but a file its *Where things are* names is gone, or commits landed on one since the brief was read | **Re-triage**: "The brief predates <commit>, which changed <file>" (or "names <file>, which no longer exists"). "Run `/triage #N`." Add one line on what that commit means for the criteria: built already, in conflict, or only moved code. That line decides whether triage narrows the issue, closes it, or only re-points it. |
| A native blocker still open | **Ready, but waits**: "Add `agent:implement` once #M closes; implement refuses it until then." |
| Otherwise | **Ready**: "Add `agent:implement` to #N." |

The stale-brief row is `git log <read-at>..origin/main -- <files>` after `git fetch origin main`, where `<read-at>` is the commit the brief's *Where things are* says it was read at. A range catches what a date misses: commit dates carry their author's offset. With no commit named, fall back to `--since=<brief date>`. A deleted file has no new commits, so check each one still exists (`git cat-file -e origin/main:<file>`).

## A set

Two or more issues. Run the gate on each first: an issue whose verdict is not implementable, already running or wrong level leaves the set, and the hand-over says why.

1. **Briefs.** Every issue the gate sent to triage or re-triage is triaged by [references/triage.md](references/triage.md), all of them in one parallel dispatch. Done when every issue in the set carries a current brief the maintainer approved.
2. **Relationships.** For each pair, record what ties them: a native link; a real dependency (one builds on what the other produces); shared files, from the briefs' *Where things are*; one changing what the other's brief points at. Add the open PRs and PRDs touching those files. Done when every pair is classed independent, shares files, or depends (and which way).
3. **Clusters.** Issues joined by a dependency, or by overlap that `issue-tracker.md`'s *When to block* says would really conflict, form a **cluster**. That section also decides order and whether an overlap needs an edge or only a note in the brief.
   - A cluster of two or more becomes a PRD. An issue with no ties stays a plain issue: a one-slice PRD adds a parent and nothing else.
   - A cluster contains every open blocker of its members, since the chain refuses a sub-issue blocked from outside its PRD. A blocker outside the set is a question for the maintainer: add it, or the member waits as a plain issue.
   - Within a PRD, list order is execution order and every edge points backwards (`ticket-shape.md`).

   Done when every issue sits in exactly one PRD or stands alone, every PRD's order respects every edge, and no member has an open blocker outside its PRD.
4. **Propose, then wait.** One message to the maintainer: each PRD (a title, its members in order, why they belong together, each new edge and its reason), each plain issue (and what it waits on), and each issue left out and why. Every order or edge a rule did not settle is a question in `CLAUDE.md`'s shape. Build nothing before their yes.
5. **Build**, on their yes. For each PRD:
   1. Create the parent as a top-level issue labelled `ready-for-agent`. The chain hands its body to every slice as context, so write what one slice's implementer needs to know: what the set is, why these issues go together and in this order, and a link to each member.
   2. Attach the existing issues as its sub-issues, one at a time in execution order: each attach appends, and the list is the order the chain builds in.
   3. Add each new blocked-by edge.

   Members are attached, not recreated, so their briefs, history and links stay where they are, and the PRD PR's merge closes them. Each keeps `ready-for-agent`. For plain issues, add only the edges step 3 called for.
6. **Verify natively.** Run `ticket-shape.md`'s *Verify natively before labelling anything* checks on every PRD, in their REST form (github.md). Repair order with the priority endpoint, never by recreating. Done when every check passes on every PRD.

## Hand over, then stop

One message:

- each PRD parent to label, with its members in order;
- each plain issue to label, and any that waits for a blocker;
- each issue left out, and why;
- before merging each PR the loop hands back (a PRD PR or a plain issue's), `/merge-check <PR>`.

## Stop and ask the maintainer

- A brief is wrong or contradicts itself, or the code makes an issue's claim false.
- An issue belongs with an open PRD or a chain already running: an issue has one parent, and a running chain's list is a queue being consumed.
- An overlap or order that `issue-tracker.md`'s rules leave undecided.

Ask in this shape (`CLAUDE.md`'s *Asking me to decide*, where the repo has one): the stake in one sentence, the question, one recommendation with one reason. When they ask for it plainer, give what each side gains and loses and what common practice is, then the recommendation again.

## Hard limits

Promotion is the maintainer's: the labels you write unasked are triage ones (`ready-for-agent`, a category) on briefs they approved. `agent:implement` goes on an issue when they ask for it on that issue; a verdict of Ready is not that ask. Ask before detaching a sub-issue from a PRD, closing an issue, or removing an edge someone else set.
