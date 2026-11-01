- `C1`: `bash deploy/unraid/upgrade.sh <version>` with all machines stubbed (a fake `curl`, `ssh`, `scp`, `docker`, `systemctl` on `PATH`, as far as the repo's existing deploy-script tests go; if there are none, a small bash test in `tests/` is added) never asks for or reads a token, and no script under `deploy/` contains `read:packages`, `_authToken` or `npm.pkg.github.com` outside `install-*.sh`.
- `C2`: A tarball whose digest does not match its `.sha256` stops the run before either machine is touched, on Unraid and again on the box.
- `C3`: With `PACKAGE_SOURCE` and the installed package's `repository` both absent it refuses, naming `PACKAGE_SOURCE`; `grep -rn jeffwlawson deploy/` finds no new hit, and no IP or user is a literal in the new or changed scripts.
- `C4`: A version mismatch or fingerprint mismatch between the two check outputs exits non-zero with the two values printed; a match exits zero.
- `C5`: The ssh and scp calls carry `UserKnownHostsFile` under the conf directory and `StrictHostKeyChecking=accept-new`, and none touches `~/.ssh`.
- `C6`: The output carries the dropped-queue and 409-window statements.
- `C7`: `shellcheck -S warning deploy/*/*.sh` is clean (CI runs it); `npm run verify` passes. The scripts stay outside the published package (nothing under `deploy/` is added to `files`, `bundleDependencies` or the build copy).
- `C8`: `deploy/unraid/README.md` (script table, requirements: the token line goes, `BOX_SSH_USER` and `PACKAGE_SOURCE` come in, the ssh note) and the worked example in `docs/deploying-the-service.md` (*A worked example*, the upgrade steps) describe the one command and the two halves, and say the registry route is no longer used by these scripts.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #575.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #575
