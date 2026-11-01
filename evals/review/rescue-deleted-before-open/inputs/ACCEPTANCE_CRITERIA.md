- `C1`: A run that reaches its time limit, is cancelled, or fails after the agent committed leaves those commits on the issue's rescue branch, with no pull request and no review requested, on both orchestrators.
- `C2`: A stopped run with no commits ahead of the base saves nothing.
- `C3`: The failure comment names the rescue branch and says re-adding `agent:implement` resumes from it, or says the commits were not saved and why.
- `C4`: A retry whose rescue builds on its own base starts from the rescued commits and is told they are unverified; its push does not overwrite anything someone else pushed.
- `C5`: A rescue built on a different base is not built on, and the run says it started fresh.
- `C6`: A retitled issue resumes from its rescue.
- `C7`: A retry that publishes deletes the rescue; one that stops again rescues again without losing the earlier commits.
- `C8`: An unreadable answer about whether a rescue exists stops the run with a sentence a person can act on.
- `C9`: The prompt carries the commit-early instruction, and the prompt tests still pass.
- `C10`: A run that finishes behaves as today.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #270.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #270
