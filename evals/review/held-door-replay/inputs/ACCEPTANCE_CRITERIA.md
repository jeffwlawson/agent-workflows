- `C1`: After a dispatcher restart, a job the worker holds queued from the previous instance is dropped, never run, and its item is dispatched again by the dispatcher's start scan if its label is still on.
- `C2`: A job queued from the *current* instance is never dropped, whichever scan or delivery asked.
- `C3`: The running job is never dropped by this; the scan skips its item while the worker holds it.
- `C4`: A job whose body lacks an instance id, or carries a malformed one, is refused as any malformed job is, with a reason a person can act on.
- `C5`: A worker that cannot be reached at the dispatcher's start still skips the pass and logs it, as today; the worker's own start announcement scans again.
- `C6`: The held door's request and answer are validated, and refuse a signature that does not verify, as they do now.
- `C7`: `docs/deploying-the-service.md`'s *What it does not keep* and its account of the worker's queue say the queued jobs are recovered by a dispatcher restart and that only the running one is not.
- `C8`: The verify command `CLAUDE.md` names passes.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #597.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #597
