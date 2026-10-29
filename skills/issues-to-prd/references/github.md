# GitHub access

`gh` runs unsandboxed (the shell sandbox blocks its network). In a Claude Code cloud session **GraphQL is refused**, so `gh issue view`, `gh issue edit` and `gh issue create --parent/--blocked-by` fail. Use REST through `gh api repos/<owner>/<repo>/…`. Where GraphQL works, `ticket-shape.md`'s own commands are fine.

## Reads

| Need | REST |
|---|---|
| Issue: state, labels, body, `issue_dependencies_summary` | `issues/<n>` |
| Comments, for the *Agent Brief* and its date | `issues/<n>/comments` |
| Parent (a 404 means none) | `issues/<n>/parent` |
| Sub-issues, in list order | `issues/<n>/sub_issues` |
| Blockers | `issues/<n>/dependencies/blocked_by` |
| Linked or cross-referenced PRs | `issues/<n>/timeline` (`cross-referenced` events), and `pulls?state=open` matched on head branch |
| Open PRs touching a file | `pulls?state=open`, then `pulls/<p>/files` |

## Writes

- **Create an issue:** `POST issues -f title=… -F body=@<file> -f 'labels[]=ready-for-agent'`. The new number is `.number` in the response.
- **Attach a sub-issue, add a blocked-by edge, move a sub-issue:** the three commands in `issue-tracker.md`'s *Native relations*. All three take the issue's database id (`.id`), never its number: the trap is described there.
- **Labels:** `POST issues/<n>/labels -f 'labels[]=<l>'` and `DELETE issues/<n>/labels/<l>`.

## Verify natively, in REST

`ticket-shape.md`'s five checks, read back from the API rather than from what you wrote:

1. `issues/<prd>/sub_issues` lists every member, in execution order.
2. Each member's `issues/<m>/parent` is the PRD.
3. Each member's `dependencies/blocked_by` holds the edges the order implies, and only backwards ones.
4. Each member's labels are `ready-for-agent` (plus its category) and no `agent:*`.
5. `issues/<prd>/parent` is a 404: the PRD is top-level.

Where GraphQL works, also run `ticket-shape.md`'s query, the one the chain itself runs.
