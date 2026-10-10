# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `jeffwlawson/agent-workflows`. Use the `gh`
CLI for all operations.

> **Scope.** This file configures the **local, human-driven** skills — `/to-tickets`, `/triage`,
> `/to-spec`, `/wayfinder`. No workflow reads it. The workflows read the *result*: the issues,
> labels and native relations these conventions tell you to create. How a batch of slices is shaped
> once published is [`ticket-shape.md`](./ticket-shape.md); the label vocabulary is
> [`triage-labels.md`](./triage-labels.md).

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc or `--body-file`
  for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also
  fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`
  with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone. This
repo is normally worked in a **worktree**; `gh` resolves the remote the same way there.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature
requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr`
equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`
  then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop
  `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`,
  `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with
`gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue. If it is a batch of slices from `/to-tickets`, read
[`ticket-shape.md`](./ticket-shape.md) first — the shape and the **creation order** are not
defaults, and getting the order wrong produces a chain nothing catches.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Native relations: sub-issues and blocking

Both relations are **native GitHub objects**, never prose in a body. That distinction is
load-bearing, and it is the single thing most worth getting right here.

**What a consumer can see.** `implement-prd.yml` walks a parent's sub-issues through the GraphQL
`subIssues` connection, and `implement.yml` partitions on issue *shape* by asking the API for
`parent` and sub-issue counts. Both queries live in the **reusable** half; the `agent-`-prefixed
callers that fire them hold trigger, permissions and secrets and no query at all, so a reusable
workflow is the file to open. Neither query reads a body. So a `Blocked by: #12` line, or a
`## Parent` heading, is invisible to every workflow in this repo — it reads correctly to a human
and carries nothing. A batch can look perfect in the bodies and have zero edges; only the API
distinguishes the two. Verify natively, always
([`ticket-shape.md`](./ticket-shape.md#verify-natively-before-labelling-anything)).

### Setting them with `gh`

A recent `gh` has flags for both, and they are the easy path:

```bash
gh issue create --parent "$prd" --blocked-by "$s1" --title "..." --body-file slice.md
```

### Setting them with the REST endpoints

On an older `gh`, both are REST calls — and both take a **database id**, not an issue number.

> **The database-id trap.** `sub_issue_id` and `issue_id` are the issue's numeric *database* id,
> not its `#number` and not its `node_id`. An issue number is also a valid-looking integer, so
> passing one does not fail cleanly — it addresses some unrelated issue or 404s, and the relation
> you wanted is silently absent. Always resolve it first:

```bash
dbid() { gh api "repos/jeffwlawson/agent-workflows/issues/$1" --jq .id; }

# Attach a sub-issue. This is the relation the PRD chain walks — appends to the parent's list,
# so calling it slice by slice, blockers first, is what gives execution order.
gh api --method POST repos/jeffwlawson/agent-workflows/issues/"$prd"/sub_issues \
  -F sub_issue_id="$(dbid "$slice")"

# Add a blocking edge. GitHub reports `issue_dependencies_summary.blocked_by`, counting open
# blockers only — that is the live gate.
gh api --method POST repos/jeffwlawson/agent-workflows/issues/"$child"/dependencies/blocked_by \
  -F issue_id="$(dbid "$blocker")"
```

### Reordering a sub-issue

A sub-issue holds a **position** in the parent's list, not a timestamp, and the position is
editable — by dragging in the parent's UI, or through the priority endpoint. There is no `gh` flag
for it, and the same database-id trap applies:

```bash
gh api --method PATCH repos/jeffwlawson/agent-workflows/issues/"$prd"/sub_issues/priority \
  -F sub_issue_id="$(dbid "$misplaced")" -F after_id="$(dbid "$should_follow")"
```

Since that list *is* the execution order, reordering it rewrites the order of a chain that has not
run yet — silently, with no other effect visible anywhere. Do it before `agent:implement` reaches
the parent, and re-read the list afterwards, because that is the only place the change shows up.

## Before a brief: overlap with other work

`/triage` checks two things before it briefs an issue: whether the code already does what is asked,
and whether a similar request was rejected before (`.out-of-scope/`). This section adds a third,
run before the brief is written: whether the issue collides with other issues, open PRs, or work in
flight. A collision nobody checks for surfaces later, when it costs something: a duplicate built
twice, a brief staled by a merge it was written before, an order worked out by hand in
conversation.

**The upstream skill is not edited.** It is installed, not vendored, so a local edit is lost on the
next update without telling anyone. This section is how this repo extends it, the same way
[`ticket-shape.md`](./ticket-shape.md#what-is-kept-and-what-is-overridden) extends `/to-tickets`.

### Checked at every triage

| Surface | What can collide | What triage does |
|---|---|---|
| Open `needs-triage` issues | A duplicate or near-duplicate. | Search by **concept**, not wording. Close one into the other, carrying over anything the closed one adds, and say which in the recommendation. |
| `ready-for-agent` issues | **Same scope:** two briefs for one change. **Same files:** running both at once means conflicts or stale pointers. **This brief moves what theirs points at:** theirs goes stale when this one merges. | Same scope: merge them. Same files: block one on the other with a native blocked-by link (`implement` refuses while a blocker is open) when running both at once would really conflict; where the overlap is only wording in a shared file, note it in the brief instead ([*When to block*](#when-to-block-and-which-issue-goes-first)). Stale-in-waiting: block theirs on this issue, and comment on theirs that its pointers need re-checking after this one merges. |
| Issues being built now (`agent:implement`, no PR yet) | Code about to change that no PR shows yet. | Treat it as an open PR: run this issue after that one merges. |
| Open PRs (the loop's `agent/*` branches and human ones) | Changes to the files this brief points at. | Read the PR's diff (`gh pr diff <n>`). Either order this issue after it, or write the brief against the code as it will be. |
| Open PRDs and their sub-issues | A long chain changes many files over days. | Check what the PRD **will** change, from its spec and its slices, not only what it has changed so far. Order anything overlapping after it. |
| The code since the issue was written | File, function and step names that have since moved. | Compare the issue's date with recent commits to the files it names (`git log --since`), and correct the pointers in the brief. |

### Checked for duplicates only

| Surface | Why |
|---|---|
| `parked` issues | Not running, so file overlap does not matter yet. A duplicate revives or merges with the parked one rather than starting fresh. |
| Open maps and question issues (`wayfinder:*`, and open questions filed as plain issues, such as #410) | They hold decisions not yet made, and a brief should not make one by accident. Link to the open question instead. |

Not checked: closed issues (closed as done is the "already built" check, and closed as rejected is
`.out-of-scope/`), and ADRs (the skill already respects them).

### Recording the outcome

**An order between issues is a native blocked-by link, never prose**
([*Native relations*](#native-relations-sub-issues-and-blocking)): `implement` reads the link and
refuses while a blocker is open, and nothing reads a sentence. Where this issue will stale another
brief's pointers, the other issue is blocked on this one and gets a comment saying its pointers
need re-checking once this merges.

#### When to block, and which issue goes first

**Block** when running both at once would really conflict, or when one would make the other's brief
stale. **Only note it in the brief** when the overlap is just wording in a shared file, such as two
issues editing different lines of the same prompt: the second one's `update-branch` resolves that,
and a needless block only delays it.

Where a block is owed, decide its direction with these, in order, stopping at the first that
decides it:

1. **A real dependency decides it.** If one issue builds on what the other produces, it waits for
   the other.
2. **Never block a ready issue on an unscheduled one.** An issue that is `ready-for-agent` or being
   built does not wait for one that is `needs-triage` or `parked`: block the unscheduled one
   instead, or the ready one may wait indefinitely. #447 blocked on #272 and #338 would have parked
   a safety fix behind two unscheduled prompt tidy-ups.
3. **Otherwise the more valuable one goes first:** a bug fix, a safety net, or something blocking a
   larger piece of work, ahead of a tidy-up. The other one rebases onto it.
4. **Still tied, the smaller one goes first.** It merges quickly, and the larger one rebases once.

**The brief says in one line what was checked and what was found**, including "no overlap found",
so a reader can tell the check ran rather than guess that it was skipped.

### When the overlap means "not yet"

Two states, both made of existing labels plus native blocked-by links. No new label.

| Situation | What triage does | Labels |
|---|---|---|
| **The decision does not depend on in-flight work**; only the code around it will move | Triage now, with criteria written as behaviour and pointers as hints (below). Block it on the work that will move the code. | `ready-for-agent` + blocked by #N. Ready, but it waits, because `implement` refuses while a blocker is open. |
| **The decision itself depends on how in-flight work turns out** | Do not brief it. Add a blocked-by link and a one-line comment, "triage after #N merges", saying why. | `needs-triage` + blocked by #N. No effort is spent early, and the reason is written down. |

**An issue is never briefed and left `needs-triage`.** The label would then mean both "not looked
at" and "briefed but not trusted", and whoever triages next cannot tell which.

### Criteria as behaviour, pointers as hints

Briefs go stale through their *pointers*, not their decisions: #224's decisions all survived #409,
and what broke were criteria naming *where* (such as "`tests/workflows.test.ts` asserts both"). So:

- **Acceptance criteria describe behaviour** that holds wherever the code lives ("a test asserts the
  pattern does not match `follow-ups`"), never a location.
- **File, function and step names go in a separate *Where things are* part** of the brief, dated
  (and naming the commit on `main` they were read at), as hints for the implementer. #447's check
  resolves them at build time.

Two placement rules follow from how the review reads criteria. The review takes acceptance criteria
from a heading (or a bold label on its own line) containing "Acceptance criteria", and when a
comment carries one, **it replaces the issue body's list for review rather than adding to it**:

- ***Where things are* sits outside the acceptance-criteria heading**, after it under its own
  heading, or a bold label alone on its line, or the review grades file locations as if they were
  criteria. The date goes on the next line, not beside a bold label: a label with anything after
  it is not read as one, so it does not end the criteria section.
- **A brief restates every criterion it keeps from the issue body.** One it leaves out is silently
  dropped from review.

### What this overrides upstream

| Upstream default | Here |
|---|---|
| The brief guide (`AGENT-BRIEF.md`, *Durability over precision*) says not to reference file paths at all | File, function and step names are allowed, but only in the separate, dated *Where things are* part, as hints. Acceptance criteria still name no location, which is the durability that rule protects. |
| Before briefing, check that the code does not already do it, and `.out-of-scope/` | Kept, and the overlap check above runs as well. |

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
  `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a native sub-issue (above). Labels:
  `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is
  assigned to the driving dev.
- **Blocking**: native issue dependencies (above). A ticket is unblocked when every blocker is
  closed.
- **Frontier query**: list the map's open children, drop any with an open blocker
  (`issue_dependencies_summary.blocked_by > 0`) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a
  context pointer to the map's Decisions-so-far.
- **Close the map**: the map's terminal state, reached only after it has been sliced into a PRD,
  or, for a map that ends in standalone issues, once its last child ticket closes, and never from
  inside a `/wayfinder` session — step 5 of the path out, in
  [`triage-labels.md`](./triage-labels.md#the-wayfinder-planning-labels), carries the precondition
  and the invocation.

**No `wayfinder:*` issue is ever implementable.** Both implement workflows refuse one on sight, by
prefix — see [`triage-labels.md`](./triage-labels.md#the-wayfinder-planning-labels) for the
vocabulary and for the path out of a map into work the loop will run.
