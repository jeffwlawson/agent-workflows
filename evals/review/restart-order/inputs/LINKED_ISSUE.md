## What to build

One command, run as root on Unraid, upgrades both machines of the Unraid deployment to a named version with **no registry token**:

```
bash /boot/config/agent-service/upgrade.sh <version>
```

Today an upgrade is two scripts on two machines (`upgrade-unraid.sh <v>` on Unraid, then `ssh -t <admin>@<box> 'sudo bash ~/upgrade-box.sh <v>'`), each prompting for a classic `read:packages` token, and the machines run different versions between the two (the worker refuses the dispatcher's jobs with 409). #561 makes each GitHub Release carry the packed tarball and a `<tarball>.sha256`, installable with no token; this issue uses it.

## Decisions made in this brief

- **A new `deploy/unraid/upgrade.sh <version>` is the orchestrator; `upgrade-unraid.sh` and `upgrade-box.sh` stay as the per-machine halves.** Each half stops prompting for a token and installs a tarball it is handed, so either can still be run alone to recover one machine or roll it back. The orchestrator is the only place that knows about ssh. Reusing `upgrade-unraid.sh` as the entry point would make a script named for one machine upgrade two.
- **The tarball is downloaded once, on Unraid, and `scp`'d to the box.** The box's root install is not limited by the egress rule, but a download on the box would make a second fetch and a second checksum site; the box's tinyproxy list (`github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`) does not matter on this path, because the install runs as root and the worker never fetches the package. The box verifies the `.sha256` again before installing (the file travelled over ssh to a root install; a second check is cheap).
- **Where the URL comes from.** `package.json` on main has no `repository` field today, so the source is a `PACKAGE_SOURCE=<owner>/<repo>` setting in `agent-service.conf` (declared and commented in `agent-service.conf.example`). If it is unset, the script reads `repository` from the installed package's `package.json` (accept a string or `{url}`, `github.com` form only); if neither gives one, it refuses before changing anything and names the setting. No owner or repo name is written in any script. The URL shape and tarball name are those #561 documents in `docs/deploying-the-service.md` (*Installing the package*): `https://github.com/<owner>/<repo>/releases/download/v<version>/<tarball>`, `<tarball>` = the package name with `@` dropped and `/` made `-`, plus `-<version>.tgz`; the `.sha256` is `sha256sum` output, checked with `sha256sum -c`. Derive the tarball name from the installed package's `name`, or take it from a `PACKAGE_NAME` setting, never a literal.
- **The registry route is removed from these scripts**, not kept as a fallback: the PAT prompt, the temp `.npmrc` and the `@jeffwlawson:registry` line all go. The registry route stays documented in the guide. (`install-unraid.sh` and `install-box.sh` also prompt for a token; they are out of scope here, and the README says so.)

## Behaviour

1. **Refuse before changing anything**: not root; no terminal where `sudo` needs one is not a refusal (see 4); version is not `x.y.z`; `PACKAGE_SOURCE` unresolvable; `BOX_SSH_USER` unset; check scripts or the box half missing beside it.
2. **Stage, touching no running service**: download tarball and `.sha256` (`curl -fsSL`, no credentials) into a temp dir under `/root`, verify with `sha256sum -c`, `scp` to the box the tarball, its `.sha256`, `upgrade-box.sh`, `check-box.sh` and `agent-service.conf` (a fixed destination such as the admin's home, same names the box's guide already uses). A failure here leaves both machines as they were and says so.
3. **Install, then restart both back to back**, ordered so versions differ for as short a time as possible: both installs finish first (the slow part, services untouched), then restart the worker first (it installs the agent's CLI at each start and is the long wait) and the dispatcher straight after it, then wait for each to log `... <version> listening`. The halves therefore need an install phase and a restart phase the orchestrator can call separately (flags or two functions; the implementer chooses and documents). Run alone, each half still does both.
4. **Box over ssh**, as `${BOX_SSH_USER}@${BOX_IP}` from `agent-service.conf` (new setting `BOX_SSH_USER`, no default; `BOX_IP` already exists). Commands that need `sudo` run with `ssh -t` so its password prompt works; that prompt is the only one left.
5. **Check both**: run `check-unraid.sh` locally and `check-box.sh` over ssh, parse the two `INFO  ... version:` lines and the two `shared secret fingerprint:` lines they already print, and **fail loudly (non-zero exit, a clear final line) when the versions differ from each other or from `<version>`, or the fingerprints differ**. Every check script's own failure also fails the run.
6. **Output says**: that restarting the worker drops any jobs queued in it (its queue is in memory; a known limit), and that the dispatcher gets 409 from the worker between the two restarts, naming the seconds that window lasted.

## ssh on Unraid

Unraid's root `~/.ssh` is effectively read-only (`known_hosts` writes fail with `Operation not permitted`). So every `ssh`/`scp` the orchestrator runs uses explicit options and never writes under `~/.ssh`: `-o UserKnownHostsFile=<conf dir>/known_hosts` (the conf's directory, `/boot/config/agent-service` in the guide, persisted across reboots) and `-o StrictHostKeyChecking=accept-new`, so a first connect is recorded and a later key change is refused. It uses the key the operator has already set up for the box (an `-i` path from an optional `BOX_SSH_KEY` setting; default ssh behaviour otherwise) and never `-o StrictHostKeyChecking=no`.

## Acceptance criteria

- `bash deploy/unraid/upgrade.sh <version>` with all machines stubbed (a fake `curl`, `ssh`, `scp`, `docker`, `systemctl` on `PATH`, as far as the repo's existing deploy-script tests go; if there are none, a small bash test in `tests/` is added) never asks for or reads a token, and no script under `deploy/` contains `read:packages`, `_authToken` or `npm.pkg.github.com` outside `install-*.sh`.
- A tarball whose digest does not match its `.sha256` stops the run before either machine is touched, on Unraid and again on the box.
- With `PACKAGE_SOURCE` and the installed package's `repository` both absent it refuses, naming `PACKAGE_SOURCE`; `grep -rn jeffwlawson deploy/` finds no new hit, and no IP or user is a literal in the new or changed scripts.
- A version mismatch or fingerprint mismatch between the two check outputs exits non-zero with the two values printed; a match exits zero.
- The ssh and scp calls carry `UserKnownHostsFile` under the conf directory and `StrictHostKeyChecking=accept-new`, and none touches `~/.ssh`.
- The output carries the dropped-queue and 409-window statements.
- `shellcheck -S warning deploy/*/*.sh` is clean (CI runs it); `npm run verify` passes. The scripts stay outside the published package (nothing under `deploy/` is added to `files`, `bundleDependencies` or the build copy).
- `deploy/unraid/README.md` (script table, requirements: the token line goes, `BOX_SSH_USER` and `PACKAGE_SOURCE` come in, the ssh note) and the worked example in `docs/deploying-the-service.md` (*A worked example*, the upgrade steps) describe the one command and the two halves, and say the registry route is no longer used by these scripts.

## Where things are

Read at `main` c8ff6c2 (v0.9.2), 2026-10-31.

- `deploy/unraid/upgrade-unraid.sh` (throwaway container `docker run ... npm install --prefix /pkg`, then `docker restart`, wait for `dispatcher <v> listening`), `upgrade-box.sh` (`npm install --prefix /opt/agent-workflows`, `systemctl restart agent-worker`, wait for `worker <v> listening`), `check-unraid.sh` / `check-box.sh` (the `INFO` lines at the end of their worker/dispatcher sections), `agent-service.conf.example` (each script sources `agent-service.conf` beside it).
- #572's `docs/deploying-the-service.md` *Installing the package* section: URL form, tarball name, checksum check. Land this after #561.
- The package's tarball bundles its dependency tree (`bundleDependencies`), so `npm install <tarball-file>` on a machine with no registry access completes.

## Overlap

Checked 2026-10-31 against open issues and PRs. #561 (the Release asset) is the prerequisite, set as a native blocker. #562 (init service mode) and #560 (dispatcher App check) touch `docs/deploying-the-service.md` in other sections (the App section and *Permissions*); wording only, no block. #573 (worked example wording on allowlist) touches the same worked example, a few lines: wording only. No open issue touches `deploy/`.

## Constraints (design guardrails)

The owner wants nothing here that blocks opening the package to the public later.

- Nothing owner-specific (IPs, host or account names, the owner's login, Unraid-specific paths beyond the existing defaults) is hardcoded: values come from `agent-service.conf` or `package.json`.
- The scripts stay outside the published package and say in the README that they support one setup (Unraid host plus a VM).
