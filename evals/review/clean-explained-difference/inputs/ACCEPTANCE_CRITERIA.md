- `C1`: A verification review's prompt diff section is smaller than the full diff for a PR whose fix round touched one file; test on two fixtures.
- `C2`: A first review's and a final review's prompt carry the full diff; test.
- `C3`: A finding on a line outside the scoped diff but in the PR's diff is still placed on the line; test.
- `C4`: Where the range is unreadable, the full diff is used and `howChecked` says why; test.
- `C5`: Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #641.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #641
