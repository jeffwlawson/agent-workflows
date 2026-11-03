- `C1`: An implement job's checkout succeeds, and is at the base branch's commit, when a tag named like the base branch exists in the repository.
- `C2`: An implement job's base is the branch's commit, not the tag's, when the tag is on a different commit.
- `C3`: update-branch's merge brings in the base branch's commit, not that of a tag named `origin/<base>`, and its report names the real base.
- `C4`: The merge commit's subject is unchanged from today's: `Merge remote-tracking branch 'origin/<base>' into <branch>`.
- `C5`: A test for each of the three sites runs with a shadowing tag present and fails without the change.
- `C6`: Tags are still fetched into the checkout (#567).

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #569.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #569
