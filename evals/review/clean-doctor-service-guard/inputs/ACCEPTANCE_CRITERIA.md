- `C1`: With the orchestrator variable `service`, a caller pinned below the minimum yields an error naming the file, its pin and the minimum, with `init` as the fix; a caller at or above it yields nothing.
- `C2`: A SHA-pinned or otherwise unorderable pin is a note saying it could not be ordered.
- `C3`: Without `service`, the Actions path's findings are unchanged.
- `C4`: The minimum is derived in exactly one place, and a test fails if the constant names a release whose workflows lack the guard (checked against the repository's own history or a fixture, not a hard-coded tag list).
- `C5`: The finding is covered through `diagnose`, the pure half; `gatherFacts` gains no new fact if the pin is already on the caller.
- `C6`: Docs: `docs/ADOPTING.md` or the deployment guide says a service repository's callers must be at the minimum release or later.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #563.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #563
