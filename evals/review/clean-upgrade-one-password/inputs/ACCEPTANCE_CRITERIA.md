- `C1`: A stubbed run of `upgrade.sh` opens exactly one master connection, and every other ssh and scp it makes names that master's `ControlPath`; a test reads the stubs' call log.
- `C2`: The `ControlPath`'s directory is mode 700, is not under the conf's directory or `/boot`, and is gone after a successful run, a failed one and an interrupted one; the master is asked to exit in each.
- `C3`: The sudo password appears in no argument list, no line of output and no file the run leaves; a test with a sentinel password checks all three, as the existing test does for the worker's secret.
- `C4`: Each box `sudo` receives the password on stdin and the run reads it once however many `sudo` calls it makes; a test counts the reads.
- `C5`: No box command uses `-t`, and the output parsing still gets the version and fingerprint lines from the box's check without carriage-return handling.
- `C6`: With `BOX_SSH_KEY` set, every ssh and scp of the run uses a copy of the key with mode 600 inside the private directory, the copy is removed at the end, and the original's mode and content are unchanged.
- `C7`: With no terminal to read the password from, a step whose `sudo` wants one fails with a message naming the terminal, and the existing commands-that-finish message still prints.
- `C8`: The commands printed for an operator to paste still carry `-t` and the host-key options, and nothing in a run writes under `~/.ssh` (the existing tests keep passing, adjusted only where they assert `-t` on every box command).
- `C9`: `deploy/unraid/README.md` and `docs/deploying-the-service.md` (*Upgrading both*) say a run asks for the ssh password once (none with a key) and the sudo password once, in place of "each ssh that runs `sudo` asks for its password".
- `C10`: The verify command `CLAUDE.md` names passes.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #690.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #690
