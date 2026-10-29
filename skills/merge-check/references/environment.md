# Environment: GitHub access and local verify

Lessons from runs in Claude Code cloud sessions. A local session with a normal `gh` may need none of the workarounds; use them the moment a call is refused.

## GitHub access

`gh` runs unsandboxed (the shell sandbox blocks its network).

**GraphQL is refused** in a cloud session, so `gh issue view`, `gh pr view`, `gh pr merge` and `gh run watch` fail. Use REST through `gh api repos/<owner>/<repo>/…`:

| Need | REST |
|---|---|
| Issue, its labels | `issues/<n>` |
| Issue or PR conversation | `issues/<n>/comments` |
| PR state: `draft`, `head.sha`, `mergeable_state` | `pulls/<n>` |
| Diff | `pulls/<n>` with `-H 'Accept: application/vnd.github.diff'` |
| Agent reviews, review threads | `pulls/<n>/reviews`, `pulls/<n>/comments` |
| Verdict and CI on a commit | `commits/<sha>/status`, `commits/<sha>/check-runs` |
| Loop runs | `actions/runs?per_page=30` |
| Add / remove a label | `POST issues/<n>/labels -f 'labels[]=<l>'` / `DELETE issues/<n>/labels/<l>` |
| Comment from a file | `POST issues/<n>/comments -F body=@<file>` |

Ready for review, resolving review threads and auto-merge have no REST route; the 403 names the `…/pulls/<n>/ccr/…` route to use instead.

**Merge** with the head guard, so a head that moved after your review refuses the merge:

```bash
gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f merge_method=squash -f sha=<reviewed-head>
```

**Blocking edges** take the issue's database id, not its number: the trap and the commands are in the repo's `docs/agents/issue-tracker.md`.

### When the proxy refuses writes outside the session's own branch

The session's proxy may refuse `git push` to a PR branch, branch deletion (API or git), and REST content writes. Then:

- **A small file edit** goes through the GitHub MCP `create_or_update_file` tool on the PR branch, which takes the whole file's content. Afterwards, check the pushed blob's SHA equals `git hash-object <file>` of the copy you verified locally; a mismatch means what landed is not what you tested.
- **A file too large to retype safely** (tens of KB) goes to the loop instead: a PR comment plus `agent:fix`, while a round is left.
- **Merged branches you cannot delete** are listed for the maintainer at the end, with the repository setting "Automatically delete head branches" suggested once.

## Local verify

Run the repo's verify command (its `CLAUDE.md`, else its CI config) on the PR's exact head, yourself. Green CI is a second opinion, not yours.

1. **Toolchain.** Use the versions the repo declares (`package.json` `engines`, `.nvmrc`, `.tool-versions`, `pyproject.toml`, `go.mod` and the like). A host toolchain below them fails tests for reasons unrelated to the PR.
2. **History the tests read.** Fetch what the repo's tests need from git: `git fetch --tags origin` where tests read a tag (agent-workflows' read its pinned release with `git show v<pin>:…`).
3. **One worktree per PR, at the exact head:**

   ```bash
   git fetch origin main "pull/<n>/head"
   git worktree add --detach ../pr-<n> <head-sha>
   ```

4. **Diff against fresh `main`.** Fetch `origin main` first (a stale local `main` gives a diff full of other PRs' changes), then diff against `git merge-base HEAD origin/main`.
5. **Run** `scripts/verify.sh ../pr-<n> $TMPDIR/pr-<n> <verify command>`. Set `TOOL_BIN` to the required toolchain's `bin` when the default is wrong, and `INSTALL` to the repo's install command when it is not `npm ci` from a lockfile. It prints the head, the toolchain and what the repo declares, and the verdict. Compare the printed head with the SHA you reviewed.
