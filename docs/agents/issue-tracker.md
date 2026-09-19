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

**What a consumer can see.** `agent-implement-prd.yml` walks a parent's sub-issues through the
GraphQL `subIssues` connection, and `agent-implement.yml` partitions on issue *shape* by asking the
API for `parent` and sub-issue counts. Neither one reads a body. So a `Blocked by: #12` line, or a
`## Parent` heading, is invisible to every workflow in this repo — it reads correctly to a human and
carries nothing. A batch can look perfect in the bodies and have zero edges; only the API
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

**No `wayfinder:*` issue is ever implementable.** Both implement workflows refuse one on sight, by
prefix — see [`triage-labels.md`](./triage-labels.md#the-wayfinder-planning-labels) for the
vocabulary and for the path out of a map into work the loop will run.
