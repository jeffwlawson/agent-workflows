# Making the self-hosted service installable by other people

Research for the maintainer, 2026-11-02. Repo lines are from `main` at commit `07e016a` (v0.9.10),
read from the main checkout, after a first pass at `fe1da7e`. Every claim carries a source: a repo
`file:line`, or a URL fetched on this date. Anything not confirmed from a primary source is marked
**UNVERIFIED**. Nothing here was run against a real machine.

Changes on main since `fe1da7e` that touch this document, and what each does to it:

- `upgrade.sh` gained one thing: it also copies the new `runs.sh` to the box when it is beside it
  (`upgrade.sh:171-173`). Still 1 `scp`, 3 `sudo` call sites, 5 connections. The idle wait I
  describe was already in the version I first read; it is at `upgrade.sh:274-303` now.
- The dispatcher's `/state` mount (#618): `install-unraid.sh` now makes `state/` and sets
  `STATE_FILE` (`:50,247-249,287`), and its drift check includes a "state mount" (`:332-348`, mount at `:342`).
  `upgrade-unraid.sh:98-104` only prints a note telling you to run `install-unraid.sh`, and
  `check-unraid.sh:224-229` warns. This confirms the gap in section 1.2 (an upgrade cannot recreate
  the container). It adds no step and no prompt, so no count moves.
- `deploy/unraid/runs.sh` is new (169 lines, read-only, run by hand on the box). Bash in `deploy/`
  is now 2,030 lines in 8 scripts, not 1,830 in 7.
- The only #662 change in `deploy/` is the `CLAUDE_CODE_VERSION` default, now 2.1.316. I found no
  effort or cache-TTL variable in `deploy/unraid/*.sh`, so whether `upgrade.sh` forwards them
  (#651) is **UNVERIFIED**; it changes no count here.
- The Release body is now written from `scripts/release-notes.ts` through `--notes-file`, with an
  Adopter action section (#621): `publish.yml:222-234`, `docs/agents/releasing.md:101-111`.
  Phase 2's draft-then-publish change must keep that step.
- `shared/contract.ts` has `CLAUDE_CODE_OAUTH_TOKEN` at line 207 (was 195).

## Summary

1. Recommended path: release the deploy scripts with each version, make `upgrade.sh` reuse one
   SSH connection and ask for one password, then fold install into one front door
   (`agent-service.sh install`) that builds the box from a cloud-init seed. Publish the dispatcher
   as an OCI image only after that works.
2. Change 1, ship the scripts (Phases 1 and 2): a `agent-service-<v>.tgz` release asset beside the
   existing npm tarball, checksummed and attested, which `upgrade.sh <v>` downloads, verifies and
   re-execs itself from. No more `scp` of scripts from a dev machine.
3. Change 2, one control connection and one password (Phase 1): ssh key plus `ControlMaster` in a
   RAM directory, and the sudo password read once and fed to `sudo -S`. Today's upgrade opens 5
   ssh/scp connections and has 3 `sudo` call sites. After: 0 ssh prompts, 1 sudo prompt.
4. Change 3, first install prompts for few things (Phases 3 and 4): the GitHub App comes from the
   manifest flow `init` already has, run on Unraid, so no App ID, webhook secret or key file is
   copied by hand. The registry token prompt goes (#576). The box VM is built from a cloud-init
   seed, key-only, so no box password exists. The user still pastes one `claude setup-token` token.
5. Different machine: the box side is already portable (Ubuntu 24.04 x64, systemd, bwrap, nft,
   tinyproxy). The dispatcher side has 14 Unraid assumptions (Q5); a compose file covers most of
   them, the host firewall and the Funnel are the hard two.
6. Blockers a stranger hits that are not scripts: no `LICENSE` file in the repo (GitHub reports
   none), GitHub Packages needs a token to install even a public package (so `init`/`doctor` need
   one), and the subscription-token terms (Q8).
7. ADR 0001 parks this work. Its first revisit condition ("someone outside asks") is not met, so
   the clean move is a new ADR that supersedes it in part, not a claim that the condition holds.
8. Roadmap: Phase 0 spikes and decisions, 1 faster upgrade, 2 shipped scripts, 3 one-command
   Unraid install, 4 box from cloud-init, 5 portable shape (compose, GHCR image, CA template).
9. Ten decisions are the maintainer's (listed after the roadmap). The three that gate work:
   licence, immutable releases, and who runs the App manifest server.
10. No secret appears in this file.

---

## 1. Current state

### 1.1 First install today (23 steps)

Sources are in the right-hand column. "T" is a typed value, "M" is a manual step with no typing.

| # | Where | Step | Kind | Source |
|---|---|---|---|---|
| 1 | laptop | Point npm at GitHub Packages to run `init`: `gh auth refresh` plus two `npm config set` | M (3 commands) | `docs/ADOPTING.md:30-41` |
| 2 | GitHub | Create a classic token with only `read:packages` (used twice, steps 10 and 18) | M | `deploy/unraid/install-unraid.sh:23-24` |
| 3 | laptop | `init --service`: type webhook URL, settings file path, key file path | T x3, not secret | `docs/deploying-the-service.md:94-103`, `setup/init.ts:764-798` |
| 4 | laptop | Click Create App in the browser | M | `setup/app.ts:15-20` |
| 5 | laptop | Click Install App, choose repositories | M | `setup/init.ts:812` |
| 6 | laptop | `claude setup-token`, browser sign-in, copy the token | M | <https://code.claude.com/docs/en/authentication> (section "Generate a long-lived token") |
| 7 | Unraid | Have User Scripts, Tailscale (Funnel allowed), VM Manager and Docker on | M | `deploy/unraid/README.md:58`, `install-unraid.sh:88-90,393` |
| 8 | Unraid | Get the scripts to `/boot/config/agent-service/` (by hand, they are not in the package) | M | `README.md:23,64`, `install-unraid.sh:79-83` |
| 9 | Unraid | Copy `app.pem` from the laptop into the appdata folder | M | `install-unraid.sh:91-94` |
| 10 | Unraid | Write `agent-service.conf` (BOX_SSH_USER and BOX_IP have no default) | M | `upgrade.sh:85-86`, `agent-service.conf.example` |
| 11 | Unraid | Run `install-unraid.sh <v>`; type App ID, webhook secret, GitHub token | T x3 (2 secret) | `install-unraid.sh:260,266,301` |
| 12 | Unraid | Schedule the `agentnet-firewall` User Script "At Startup of Array" in the UI | M | `install-unraid.sh:241` |
| 13 | Unraid | Create the VM in the form: Host Passthrough, 4 vCPU, 8 GB, raw disk, network `agentnet`, Autostart off, VNC password | M (7 settings) | `docs/deploying-the-service.md:838-840` |
| 14 | VM | Install Ubuntu 24.04 from an ISO, make an admin user and password, enable ssh | M (screen count UNVERIFIED, not in the repo) | none in the repo |
| 15 | Unraid | Re-run `install-unraid.sh` after the VM exists to reserve its MAC | M | `install-unraid.sh:16-19,193` |
| 16 | Unraid to box | `scp install-box.sh check-box.sh agent-service.conf` | T x1 (ssh password) | `install-box.sh:20,56-59` |
| 17 | box | `ssh -t`, then `sudo bash ~/install-box.sh <v>` | T x2 (ssh password, sudo password) | `install-box.sh:20,51-54` |
| 18 | Unraid to box | Print `WORKER_SECRET` on Unraid and carry it across | M | `install-unraid.sh:399-401` |
| 19 | box | Type WORKER_SECRET, CLAUDE_CODE_OAUTH_TOKEN, GitHub token | T x3 (all secret) | `install-box.sh:237,262,271` |
| 20 | GitHub | Delete the GitHub token | M | `install-unraid.sh:399`, `install-box.sh:346` |
| 21 | GitHub | Set the App's webhook URL to the Funnel URL if not already | M | `install-unraid.sh:393-394` |
| 22 | GitHub | Set `AGENT_ORCHESTRATOR=service` on each repository | M | `docs/ADOPTING.md` section 2e |
| 23 | both | Read the check scripts' output and compare the two fingerprints | M (the install scripts run them) | `install-unraid.sh:397`, `install-box.sh:344` |

Counts: 23 steps. 12 typed values: 5 secrets (webhook secret, GitHub token twice, WORKER_SECRET,
Claude token), 3 passwords (ssh twice, sudo once), the App ID, and 3 `init` answers. 18 steps need
no typing but are done by a person.

Two hand-offs lose information. `init --service` writes the App ID, webhook secret and key to a
settings file (`docs/deploying-the-service.md:111-115`), but `install-unraid.sh` does not read that
file: it wants `app.pem` already in appdata (`:91-94`) and asks for the App ID and webhook secret
again (`:260,266`). And `WORKER_SECRET` is generated on Unraid (`:272`) and retyped on the box
(`install-box.sh:262`).

### 1.2 Upgrade today

`upgrade.sh <v>` (`deploy/unraid/upgrade.sh`) opens a new ssh or scp per step, none sharing a
connection, with `-t` on every `ssh`:

| Call | Line | ssh/scp password | sudo |
|---|---|---|---|
| `scp` tarball, `upgrade-box.sh`, `check-box.sh`, conf | 176 | 1 | no |
| `ssh -t ... sudo bash ~/upgrade-box.sh --install` | 186 | 1 | yes |
| `ssh -t ... rm -f` the staged tarball | 198 | 1 | no |
| `ssh -t ... sudo bash ~/upgrade-box.sh --restart` | 317 | 1 | yes |
| `ssh -t ... sudo bash ~/check-box.sh` | 345 | 1 | yes |

That is 5 ssh/scp password prompts, matching what you saw. The code has 3 `sudo` call sites; you
observed 2. I did not reproduce the difference (a cached ticket is the likely cause, UNVERIFIED).
Either way each `ssh -t` is a new pseudo-terminal, and sudo's default ticket is per terminal
(Q2).

Other manual work around an upgrade:

- The scripts are not in the release (`README.md:64`), so a changed script is copied to
  `/boot/config/agent-service/` by hand first.
- `upgrade-unraid.sh` only runs `docker restart` (`upgrade-unraid.sh:106`). Recreating the
  container (a changed mount, user or env file) lives in `install-unraid.sh:332-372`, so a
  `/state` mount warning needs a second script run, after copying that script too. That run asks
  for no secret, because it keeps the settings (`install-unraid.sh:257-274`) and the package is
  already at the version (`:296`).
- When the worker holds a job, `upgrade.sh` waits up to `IDLE_WAIT_MINUTES` (`upgrade.sh:274-303`)
  and then asks for a decision (`--now` or later). That one is a real decision and should stay.

### 1.3 Facts about the repo a stranger would hit

- Hard-coded owner scope `@jeffwlawson` in 16 lines across 6 scripts: `install-unraid.sh` 6,
  `install-box.sh` 6, and one each in `upgrade-unraid.sh:30`, `upgrade-box.sh:30`,
  `check-unraid.sh:24`, `check-box.sh:29` (grep count). `upgrade.sh` derives it instead
  (`upgrade.sh:94-97,126-133`). This is #580.
- No `LICENSE` file at the repo root and `gh repo view` reports `licenseInfo: null`; `package.json`
  says MIT. The repo is public.
- `v0.9.10` has the tarball and `.sha256` assets and is not an immutable release (`gh release view`
  returned `isImmutable: false`).
- `ci.yml:76` fails the build if `deploy/` is in the npm tarball, and `ci.yml:84-85` runs
  `shellcheck` on `deploy/*/*.sh`. So the scripts must ship as a separate asset, not in the npm
  package, unless that guard is changed on purpose.
- The scripts are about 2,030 lines of bash (226 + 257 + 348 + 404 + 169 + 369 + 126 + 131), run as
  root on Unraid and on the box. `tests/deploy/upgrade.test.ts` covers the upgrade path with stubbed
  `ssh`, `scp`, `curl`, `docker`; the install and check scripts have no tests of their own
  (`ci.yml:81-82`).
- The only network endpoints the scripts contact are `github.com` release assets (`upgrade.sh:133`),
  `npm.pkg.github.com` (`install-unraid.sh:302`, `install-box.sh:238`), `nodejs.org`
  (`install-box.sh:111-112`), apt, and the local doors.

---

## 2. Findings per question

### Q1. Inventory

Section 1.1 and 1.2 are the inventory. The two numbers to quote: **first install 23 steps and 12
typed values**; **upgrade 5 ssh/scp password prompts plus 3 sudo call sites, and a hand-copy of any
changed script**.

### Q2. SSH and sudo without repeated prompts

What OpenSSH documents (all from <https://man.openbsd.org/ssh_config> and <https://man.openbsd.org/ssh>):

- `ControlMaster auto` "tries to reuse a master connection and creates a new one if none exists".
  Further sessions use "the same ControlPath".
- `ControlPath` should include at least `%h`, `%p`, `%r` (or `%C`) and sit in a directory other
  users cannot write to. `%C` is accepted. The page says nothing about length.
- `ControlPersist` with a time value makes the background master exit after that long with no
  clients; without it the master closes when the first client disconnects.
- `ssh -O check` tests the master, `ssh -O exit` asks it to exit; `-S` names the socket, `-M` makes
  a master.
- ssh "will simply ignore a private key file if it is accessible by others".

Socket path limit: `sun_path` is 108 bytes on Linux and as short as 92 on some systems
(<https://man7.org/linux/man-pages/man7/unix.7.html>). A `%C` path (a hash) in a short directory
stays well inside it.

Can the ControlPath live on Unraid's `/boot`? Not recommended, and I cannot confirm either way:

- Unraid says `/boot` is the boot device holding config, and "files on the boot device can no
  longer be given execute permission"
  (<https://docs.unraid.net/unraid-os/system-administration/secure-your-server/secure-your-boot-drive/>).
  The scripts are already run as `bash <file>` for that reason.
- The kernel's vfat page says `uid`, `gid`, `umask`, `fmask` are mount-wide
  (<https://docs.kernel.org/filesystems/vfat.html>). So per-file `chmod 600` is not available, and
  ssh may refuse a key stored there. The repo's own example puts the key at
  `/boot/config/agent-service/box_key` (`agent-service.conf.example:65`) and `upgrade.sh:87` only
  checks that it exists. Whether ssh accepts it on this mount is **UNVERIFIED**.
- That page does not say whether vfat can hold a socket (**UNVERIFIED**).
- Unraid's docs say `/root/.ssh` is a symlink into the boot device so keys persist (search summary
  of docs.unraid.net pages, not fetched in full), yet you found it not writable
  (`upgrade.sh:33-35`). **UNVERIFIED**, and the two statements conflict.

So: keep the key and `known_hosts` beside the conf (persistent), and at run time copy the key to a
`mktemp -d` directory in RAM (mode 700, file mode 600) and put the socket there. Unraid's root
filesystem is in RAM (search summary of docs.unraid.net, "Unraid runs from RAM after boot"), which
is the right place for a socket and a key copy, and is already where `STAGE_DIR=/root` points
(`upgrade.sh:49`).

Sudo (<https://www.sudo.ws/docs/man/sudoers.man/>, <https://www.sudo.ws/docs/man/sudo.man/>):

- `timestamp_type` default is `tty`: "One time stamp record is used for each terminal, which means
  that a user's login sessions are authenticated separately." `global` is "a single time stamp
  record ... for all of a user's login sessions". `timestamp_timeout` default is 5 minutes. Unless
  `global`, the record includes a session ID, so processes in different terminal sessions do not
  share one.
- So ControlMaster fixes ssh prompts only. With `ssh -t` each call allocates its own terminal, and
  sudo asks again for each (`upgrade.sh:141` uses `-t` for every call).
- `sudo -S`: "Write the prompt to the standard error and read the password from the standard input
  instead of using the terminal device." `sudo -v` "Update the user's cached credentials",
  `-n` never prompts and errors if a password is needed.
- NOPASSWD: with any NOPASSWD entry the user can run `sudo -l` without a password (Tag_Spec
  section). Wildcards in command arguments "should be used with care". In `@includedir` /
  `sudoers.d`, sudo skips file names that end in `~` or contain a `.`, so a drop-in called
  `agent-workflows.upgrade` is silently ignored (name it `agent-workflows-upgrade`).
  `visudo -c` validation was not in the page text I could read: **UNVERIFIED**.

Options weighed:

| Option | Prompts after | Tradeoff |
|---|---|---|
| A. ControlMaster only | 0 ssh, 3 sudo | Leaves the sudo prompts. Not enough. |
| B. `timestamp_type=global` drop-in on the box | 0 ssh, 1 sudo per 5 minutes | Weakens sudo for every login of the admin; the upgrade can idle 90 minutes (`upgrade.sh:56`), past the 5-minute timeout. Rejected. |
| C. Read the sudo password once, feed `sudo -S` per call | 0 ssh, 1 sudo | No change to the box. The password lives in a shell variable of `upgrade.sh` and travels only inside the ssh channel, never in argv. Needs `ssh` without `-t`, which also removes the carriage returns `upgrade.sh:340` strips. Whether Ubuntu's default sudoers has `requiretty` set is **UNVERIFIED**; I believe not, test in the spike. |
| D. NOPASSWD for one root-owned helper | 0 ssh, 0 sudo | A narrow rule, for example `agent-box-ctl` installed root:root at `/usr/local/sbin/`. The helper validates its own arguments with a regex like `upgrade-box.sh:47`. A rule that allows `bash <file in the admin's home>` would be root for anyone holding the admin account, so the target must not be user-writable. |

**Recommendation for this repo: C everywhere, plus D only on boxes the installer builds.**

- Always: ssh key (generated once by the installer, public half installed once), one master
  connection in RAM, one sudo prompt fed to `sudo -S`. This takes an upgrade from 5 ssh + 3 sudo
  prompts to 1 prompt, with no change to a hand-built box, which is your current box.
- On a box the installer creates from cloud-init (Q4), the admin account is key-only
  (`lock_passwd: true`, <https://docs.cloud-init.io/en/latest/reference/yaml_examples/user_groups.html>)
  so there is no sudo password to type. There the narrow helper rule gives 0 prompts.
- Why D is acceptable and not just convenient: the trust direction in this design is Unraid to
  box. Unraid already holds the key to the box admin, and the box is the side that runs agents (the
  "wall between the agents and the NAS", `docs/deploying-the-service.md:824-826`). A narrow helper
  gives Unraid nothing it lacks. What it must not become is a path for the `worker` user, which has
  no sudo (`install-box.sh:133-137`).

### Q3. Distribution and integrity

How to ship the scripts with each release:

- Add a second release asset, `agent-service-<version>.tgz` (the contents of `deploy/`, plus the new
  box helper) with its `.sha256`, uploaded the same way as the npm tarball
  (`publish.yml:222-243`). Keep `deploy/` out of the npm tarball (`ci.yml:76`).
- Add one stable, tiny asset, `bootstrap.sh`, for the first run. GitHub documents
  `https://github.com/OWNER/REPO/releases/latest/download/ASSET` for manually uploaded assets
  (<https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases>),
  which our `gh release upload` assets are. `bootstrap.sh` takes a version, downloads and checks
  `agent-service-<v>.tgz`, unpacks it to `/boot/config/agent-service/`, keeps any existing conf,
  and runs it.
- Self-update: `upgrade.sh <v>` already downloads and checks a tarball before touching anything
  (`upgrade.sh:156-169`). Extend that stage to also download `agent-service-<v>.tgz`; if its
  `upgrade.sh` differs from the running one, copy the new files in place (conf and `known_hosts`
  kept) and `exec bash "$here/upgrade.sh" --reexec "$@"`. The new version's logic then runs, so
  an upgrade can fix the script that drives it. A pre-flight "scripts differ" line is enough; no
  extra prompt.
- With the scripts always delivered as one bundle, the "self-contained on purpose" rule in
  `check-unraid.sh:9-10` (each script copied alone) no longer applies, so shared helpers (`put`,
  `ask_secret`, container convergence) can move to one `lib.sh` instead of being copied into five
  files.

Integrity: what each mechanism proves.

| Mechanism | Proves | Does not prove |
|---|---|---|
| `.sha256` beside the asset (today) | The bytes match the digest published next to them; catches corruption and a truncated download. Fetched over HTTPS only (`upgrade.sh:161`). | Who made the file. Whoever can replace the asset can replace the `.sha256`. |
| GitHub's automatic asset digest | GitHub computes a SHA-256 for every uploaded asset at upload time, "immutable", shown in the UI, API and `gh release view` (<https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/>). | Same limit: it is the release's own claim, though it is not editable by an asset swap alone. |
| Artifact attestation (`actions/attest`, verified by `gh attestation verify`) | A signed SLSA provenance statement ties the file to the repository, workflow and commit that built it; Sigstore public-good instance and a public transparency log for public repos. Alone it is SLSA v1.0 Build Level 2 (<https://docs.github.com/en/actions/concepts/security/artifact-attestations>). | "Not a guarantee that an artifact is secure." It says where the file came from, not that the code is safe. It helps only if someone verifies. |
| Immutable release | Tag and assets cannot be changed or deleted after publish; the release gets its own attestation (<https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases>). `gh release verify` and `gh release verify-asset <tag> <file>` check it (<https://cli.github.com/manual/gh_release_verify-asset>). | Nothing about the content. A tag name is also burned after deletion. |

Facts for implementing the attestation:

- `actions/attest-build-provenance` is now "simply a wrapper" over `actions/attest`; new use should
  call `actions/attest` (<https://github.com/actions/attest-build-provenance>). Binaries need
  `id-token: write`, `contents: read`, `attestations: write`
  (<https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds>).
  `publish.yml:47-49` grants only `contents: write` and `packages: write` today. Attestations are
  available for public repositories on all current plans (the README above).
- `gh attestation verify <file> --owner|--repo ...` needs one of those flags; the docs advise also
  pinning the signer with `--signer-workflow` or `--cert-identity`, and say that for a reusable
  workflow the reusable workflow is the signer
  (<https://cli.github.com/manual/gh_attestation_verify>). `publish.yml` is not a reusable
  workflow, so the signer is `jeffwlawson/agent-workflows/.github/workflows/publish.yml`.
- Immutable releases: GitHub's recommended flow is create as draft, attach every asset, then
  publish (the immutable-releases page). `publish.yml` creates the release first (`:230-234`)
  and uploads assets after (`:236-243`), and its re-run logic uploads missing assets to an existing
  release. Both break on an immutable release. The flow would change to draft, upload, publish.
  Asset sizes are far inside the 2 GiB per file limit
  (<https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>).

**Is the current tokenless tarball model (#561, #575) sound?** Yes for what it claims. The download
is HTTPS only with redirects held to HTTPS (`upgrade.sh:161`), the digest must name the tarball
(`upgrade.sh:165-168`), it is checked on Unraid and again on the box (`upgrade-box.sh:72-77`), the
install runs as root so the worker never fetches a package, and `publish.yml:249-270` installs the
attached asset with all credentials removed. It needs a public repo (Release assets of a private
repo need a token; `docs/deploying-the-service.md:75`). What it does not give is authenticity: a
stranger cannot tell the tarball came from this repository's workflow. Attestation adds that.

**What a stranger should be told to verify** (put in the install doc, in this order):

1. Read `bootstrap.sh` before running it (do not pipe it to `sh`). It is short.
2. On any machine with `gh`, run `gh attestation verify agent-service-<v>.tgz --repo
   jeffwlawson/agent-workflows --signer-workflow
   jeffwlawson/agent-workflows/.github/workflows/publish.yml`, and `gh release verify-asset v<v>
   <file>` once releases are immutable. Unraid has no `gh` (**UNVERIFIED**; the scripts do not
   use it), so this runs on a laptop; the bootstrap prints the digest to compare.
3. Know what that proves (provenance, not safety) and that the scripts run as root on the NAS and
   on the VM. The scripts are about 2,030 lines of bash with `shellcheck` in CI and a tested
   upgrade path.
4. The token they paste (`CLAUDE_CODE_OAUTH_TOKEN`) is written to a mode 600 file on the box
   (`install-box.sh:275-290`) and is the only credential the box holds besides `WORKER_SECRET`.

### Q4. Unraid specifics

Community Applications (CA), from <https://ca.unraid.net/submit/help> and
<https://ca.unraid.net/submit/help/repository-xml> and `/xml-field-reference`:

- A Docker app is one XML file per template, `<Container version="2">`, with `<Repository>` (for
  example a `ghcr.io/...` image), `<Name>`, `<Overview>`, `<Network>`, `<Support>`, `<Project>`,
  `<Category>`, `<WebUI>`, `<TemplateURL>`. `ExtraParams` is "additional Docker run arguments" and
  the parser "may rewrite or reject unsafe values". Plugins use `<PluginURL>` and "are always
  manually reviewed".
- Prerequisites: public active repo, an OSI-approved `LICENSE` at the root, a `ca_profile.xml`,
  then Validate and Scan in the submission flow. **This repo has no `LICENSE` file** (section 1.3).
- Not stated on those pages: whether host networking, a `--user` flag, or `Config` entries marked
  secret are allowed. The dispatcher needs host networking and `99:100`
  (`install-unraid.sh:368-370`). **UNVERIFIED** whether a template can express that.
- CA's help index lists a "Compose package contract ... for Unraid 8" page, but the page URL I tried
  returned 404 and a secondary article says Unraid 8 will add native Compose
  (<https://www.it-connect.fr/unraid-8-base-fedora-docker-compose-sauvegarde-integree/>). **UNVERIFIED**;
  do not design around it.
- Where a template ends: it can run the dispatcher container and nothing else. It cannot create
  the libvirt network, the firewall, the VM, or the Funnel. So "install from a form" gets the
  dispatcher only; the rest still needs a script or a plugin. A plugin (`.plg`) is manually
  reviewed and its format is **UNVERIFIED** here. (Note: #605 is the Claude Code plugin for the
  skills, not an Unraid plugin.)

Can the dispatcher be a published OCI image? Technically yes, and it is a smaller step than it
looks:

- Today the "image" is stock `node:24-alpine` with the package bind-mounted from appdata
  (`install-unraid.sh:368-370`, `docs/deploying-the-service.md:932-938`). A GHCR image would bake
  the verified tarball in: `FROM node:24-alpine`, `npm install ./agent-workflows-<v>.tgz`,
  `USER 99:100`, `CMD [...dispatcher]`, tagged by version and referenced by digest. GHCR: new
  packages are private by default, public ones pull anonymously, and the image needs the
  `org.opencontainers.image.source` label to link to the repo
  (<https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry>).
  Attest it too (`subject-digest`, `push-to-registry`, same attestation page).
- Upgrade becomes "pull the new digest, recreate", which also fixes today's gap where
  `upgrade-unraid.sh` restarts but cannot recreate (section 1.2).
- Compose can express the container: `network_mode: host`, `user`, `env_file`,
  `restart: unless-stopped`, `read_only`, a `:ro` volume, `healthcheck`, image by digest
  (<https://docs.docker.com/reference/compose-file/services/>, each confirmed).

Can the box VM come from a cloud-init seed so the user creates only an empty VM? Partly, and the
parts are documented separately:

- Ubuntu publishes `noble-server-cloudimg-amd64.img` with `SHA256SUMS` and `SHA256SUMS.gpg`
  (<https://cloud-images.ubuntu.com/noble/current/>).
- cloud-init NoCloud: a vfat or iso9660 volume labelled `cidata` (the page writes `CIDATA` and
  `cidata`), files `user-data` and `meta-data` in the root, `meta-data` must hold an `instance-id`,
  optional `network-config`
  (<https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html>).
- `virt-install --cloud-init` generates that ISO and attaches it as a CDROM "only for the first
  boot" (<https://manpages.ubuntu.com/manpages/noble/man1/virt-install.1.html>). Whether Unraid
  ships `virt-install` is **UNVERIFIED**. The repo already uses `virsh` from a root shell
  (`install-unraid.sh:126-193`), and it already runs throwaway containers
  (`install-unraid.sh:304`), so the ISO could be built in a container (package choice
  **UNVERIFIED**).
- Home Assistant documents a precedent for an imported disk on Unraid: decompress a prebuilt qcow2
  into the `isos` share, make a Linux VM, set the primary vDisk location to Manual and pick the
  image (<https://www.home-assistant.io/installation/alternative/>). Unraid's VM page lists
  vDisk type QCOW2, CPU mode Host passthrough, Network MAC and bridge in the Advanced View, and
  "Autostart" (<https://docs.unraid.net/unraid-os/using-unraid-to/create-virtual-machines/vm-setup/>).
  That page does not mention cloud images, cloud-init or `virsh`; I found no Unraid doc for any of
  them. Unraid 7.1 can save a configured VM as a User Template and 7.x shows the XML inline
  (search summary of docs.unraid.net release notes). A VM defined directly with `virsh define`
  showing up correctly in the VM Manager is **UNVERIFIED**.
- So the supportable first step is "assisted": the installer prepares the disk (verified Ubuntu
  image, resized) and the seed ISO in the VM share and tells the user the four settings to pick in
  the form (existing disk, second drive is the seed, network `agentnet`, MAC). The step after is
  `virsh define` once a spike shows Unraid accepts it.
- What cloud-init can set: user with `ssh_authorized_keys`, `lock_passwd: true`, and `sudo`
  (the user-groups example above). Writing files and running commands are standard modules; I did
  not fetch their pages, **UNVERIFIED** here. Keep the secrets out of the seed: it is a CD-ROM the
  box can read, so `WORKER_SECRET` and the Claude token should be sent over ssh stdin after boot.

User Scripts and persistence:

- Unraid keeps config on `/boot` (the boot device "stores all configuration data, licensing, and
  system settings"); the OS runs from RAM; `config/go` "can run user commands" at boot
  (docs.unraid.net secure-your-boot-drive page above and search summary).
- User Scripts "At Startup of Array" fires on every array start, not only boot (forum post, not
  official: <https://forums.unraid.net/topic/48286-plugin-ca-user-scripts/page/73>). The firewall
  script is stored there (`install-unraid.sh:68`) and the user schedules it by hand (`:241`).
  Whether the install can write that schedule itself is **UNVERIFIED**. An alternative with a
  documented hook is `config/go`, but the firewall script waits up to 5 minutes for libvirt
  (`install-unraid.sh:207-208`), which would have to run in the background. Spike it.
- Tailscale Funnel needs MagicDNS, HTTPS, the `funnel` node attribute in the policy file, works
  only on ports 443, 8443 and 10000, only on `*.ts.net` names, is in beta, and has
  "non-configurable bandwidth limits" (<https://tailscale.com/docs/features/tailscale-funnel>).
  The Unraid plugin has an "Allow Tailscale Funnel" setting that can remove a Funnel when off
  (forum reports, not official docs: <https://forums.unraid.net/topic/136889-plugin-tailscale/page/67/>);
  the repo already relies on it (`install-unraid.sh:393`). The webhook door is plain HTTP on
  127.0.0.1 (`WEBHOOK_HOST`, `docs/deploying-the-service.md:917-919`), so any tunnel or reverse proxy
  that terminates HTTPS can replace Funnel. Cloudflare documents an outbound-only tunnel that
  needs only a token to run and treats the token as a secret
  (<https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/>), but that needs a Cloudflare
  account and zone; not designed here.

### Q5. A different machine

**Dispatcher on a non-Unraid host needs:**

- Docker (or Node 24.14+ plus systemd), `docs/deploying-the-service.md:52`.
- A directory holding `service.env` (mode 600, root) and `app.pem` (mode 600, owned by the container
  user), as `install-unraid.sh:245-246,277-291` creates.
- A way for GitHub to reach `/github` over HTTPS (Funnel, a tunnel, or a reverse proxy).
- A route from the box to the dispatcher's token door (`TOKEN_PORT` 8791) and from the dispatcher
  to the box's job door (8787), neither exposed publicly. If the two are on different networks they
  need a private link.

A compose file for that is about 15 lines: `network_mode: host`, `user`, `env_file`, `volumes: - ./app:/app:ro`,
`restart: unless-stopped`, `healthcheck` on `/health` (the webhook door answers `GET /health`,
`check-unraid.sh:232-233`). A systemd unit running `node .../dist/cli.js dispatcher` does the same
without Docker.

**Unraid-specific assumptions in the scripts, and what replaces each:**

| # | Assumption | Where | Replaced elsewhere by |
|---|---|---|---|
| 1 | Scripts live in `/boot/config/agent-service/`, run as `bash <file>` because `/boot` cannot hold executables | `README.md:23` | `/opt/agent-service/` or `/usr/local/lib/...`, mode 755 |
| 2 | `known_hosts` beside the conf because root's `~/.ssh` is unwritable | `upgrade.sh:136-138` | normal `~/.ssh` |
| 3 | `/root` is RAM, used as staging | `upgrade.sh:49` | any temp dir |
| 4 | Appdata at `/mnt/user/appdata/agent-dispatcher`, user `99:100` (nobody:users) | `install-unraid.sh:35,46` | a volume path and a chosen uid |
| 5 | Required tools `virsh docker iptables tailscale openssl` | `install-unraid.sh:88-90` | per host: Docker, openssl, plus whatever the adapter below needs |
| 6 | libvirt network `agentnet` (NAT, bridge `virbr-agent`, 192.168.250.0/24, DHCP reservation for the box MAC) | `install-unraid.sh:126-193` | Another libvirt host reuses it. Without libvirt: a Docker/macvlan network, a VLAN, or a separate machine with its own address |
| 7 | The firewall as a User Script: `iptables -t mangle` chain `AGENT-EGRESS` on `PREROUTING`, drops RFC1918 and others, then starts the VM | `install-unraid.sh:197-241` | A systemd unit applying nft rules at the host or router, before the VM or machine starts |
| 8 | "At Startup of Array" scheduling, done by hand | `install-unraid.sh:241` | `After=libvirtd.service` ordering in the unit |
| 9 | VM Autostart must stay off so the firewall starts the VM after the rules | `install-unraid.sh:203`, `check-unraid.sh:111-115` | systemd ordering replaces it |
| 10 | Container on host networking because libvirt's NAT admits new connections from the host only | `install-unraid.sh:368`, `docs/deploying-the-service.md:924-925` | needed only when the box is on a libvirt NAT network; otherwise normal ports |
| 11 | Package installed by a throwaway `node:24-alpine` container because Unraid has no Node | `install-unraid.sh:304`, `upgrade-unraid.sh:81` | host Node, or the image from Phase 5 |
| 12 | Tailscale plugin and Funnel on port 10000 | `install-unraid.sh:385-394` | tailscale CLI on any Linux host (Funnel works the same), or a tunnel or reverse proxy |
| 13 | Box address, gateway and subnet constants | `agent-service.conf.example:31-46` | settings the installer asks once and writes |
| 14 | The VM is created by hand in the Unraid form | `docs/deploying-the-service.md:838-840` | `virt-install` plus cloud-init on plain libvirt, or any VM or machine on another platform |

**What is already portable on the box side:** Ubuntu 24.04 x64 with systemd, apt, nft, bubblewrap,
tinyproxy, an AppArmor profile that grants `userns` to `/usr/bin/bwrap` only
(`install-box.sh:140-152`; Canonical's mechanism is a profile with a `userns` rule,
<https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces>), and an nft rule
limiting `worker` to loopback (`install-box.sh:156-190`). Its only coupling to Unraid is two
addresses: `HOST_IP` as the token door in `DISPATCHER_TOKEN_URL` (`install-box.sh:276`) and in the
tinyproxy allowlist (`:224`), and `JOBS_HOST` (`:279`). Limits: x64 only (Node tarball, `:109`;
`agent-service.conf.example:84`), Ubuntu 24.04 only (`install-box.sh:64-66` warns and continues),
and the 26.04 behaviour of bwrap is an open question (#360 probe 3, for GitHub's runner image).

**The two that cost something elsewhere.** The host firewall (assumption 7) is "a control in its own
right": it holds the whole VM off the LAN and the NAS, not just the agent
(`docs/deploying-the-service.md:898-903`). On a separate machine that wall must come from the network
(VLAN, router rule, cloud security group) or the box's own nft output rules; leaving it out is a
security regression, not a simplification. The webhook path (assumption 12) is the other: it needs
an account with a tunnel provider or a reachable host.

### Q6. Comparable projects

Only what bears on a decision here. Where a page did not say, it is marked.

| Project | Bootstrap | Config | Upgrade | Takeaway for us |
|---|---|---|---|---|
| GitHub Actions runner | Download a release tarball, check its SHA-256 (listed in the release notes, no verify command), run `config.sh` with the URL and a registration token that "expires after one hour" (<https://github.com/actions/runner/releases/latest>, <https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners>) | Flags to `config.sh`; `--unattended`, `--replace`, `config.sh remove` **UNVERIFIED** (pages did not list them) | UNVERIFIED | Short-lived token for the one secret step: our analogue is the manifest `code` (valid one hour, below). Checksums in the release page itself. |
| Tailscale | `curl -fsSL https://tailscale.com/install.sh \| sh`, and a documented package-manager alternative for those who will not pipe to a shell (<https://tailscale.com/kb/1031/install-linux>) | `sudo tailscale up` prints a URL to authenticate in a browser | UNVERIFIED (not on that page) | Offer both a one-liner and a read-first path. Browser sign-in for the secret, not a pasted key. |
| Coolify | `curl -fsSL https://cdn.coollabs.io/coolify/install.sh \| bash`; env vars pre-create the admin (`ROOT_USERNAME`, `ROOT_USER_EMAIL`, `ROOT_USER_PASSWORD`) so no open registration page; a documented manual compose install (<https://coolify.io/docs/get-started/installation>) | environment variables, `.env` back-up reminder | A separate `upgrade.sh <version>` per release; the docs warn not to re-run `install.sh` for updates because it resets ownership and permissions; backs up before an automatic update (<https://coolify.io/docs/get-started/upgrade>). Uninstall and dry-run: not in the pages **UNVERIFIED** | Install and upgrade as two different scripts with a version argument is the shape we already have. Env-var presets for non-interactive use. Ship a by-hand compose path beside the script. |
| Portainer CE | `docker volume create` + one `docker run` with the Docker socket, or a compose file (<https://docs.portainer.io/start/install-ce/server/docker/linux>) | none at install; first-run web setup | not in the fetched content **UNVERIFIED** | One container, no host scripts, is the lowest-friction shape; ours cannot be that while it needs a VM and a firewall. |
| Home Assistant | Recommends the OS image in a VM; a Container install is "standalone" and you manage it. For KVM/Unraid it ships a prebuilt qcow2 and documents using it on Unraid (<https://www.home-assistant.io/installation/linux/>, `/installation/alternative/`) | web onboarding | Container: pull `stable`, stop, remove, run again with the same settings; "restarting alone only applies configuration changes" | Same fork we face: image (appliance) vs script (host config). And the same lesson as our `docker --env-file` note (`install-unraid.sh:329-331`): recreate, do not restart. |
| Unraid CA | XML template in a public repo, Validate and Scan, optional manual review; a plugin is always reviewed (links in Q4) | The template's variables become a form | Unraid re-pulls the image | Fits a plain container. Cannot express our firewall, VM or Funnel. |

Cross-cutting: idempotent re-run (`put` writes a `.bak.<time>` before replacing,
`install-unraid.sh:97-116`) is already ahead of most of these; the repo has a read-only `check`
(`check-*.sh`) and the stage phase of `upgrade.sh` (`:156-182`) is already a dry run in all but name.
None of the project pages I fetched documented `--dry-run`, so a flag would be ours; it is cheap
because `upgrade.sh` already separates staging from changing anything.

### Q7. GitHub App creation

- GitHub's manifest flow (<https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest>):
  POST a JSON `manifest` form field to `https://github.com/settings/apps/new` (or
  `/organizations/ORG/settings/apps/new`), with a `state`. Fields include `name`, `url`,
  `hook_attributes` (with `url`), `redirect_url`, `public`, `default_permissions`, `default_events`.
  GitHub redirects the browser to `redirect_url` with a `code`; POST that to
  `/app-manifests/{code}/conversions`; the response includes `id`, `pem` and `webhook_secret`.
  All three steps must finish within one hour. The page does not say whether the exchange needs
  authentication; the repo's comment says it is unauthenticated, "confirmed live on 2026-10-02
  (#226)" (`setup/app.ts:23-27`).
- `init` already uses it for the loop's App (`setup/app.ts:15-28`) and `init --service` for a
  service-ready App with the service's permissions, webhook URL and events
  (`setup/app.ts:112-117`, `setup/init.ts:760-870`, `docs/deploying-the-service.md:92-120`). It
  keeps the App private ("Only on this account", `docs/deploying-the-service.md:160-165`) and never
  prints the key or secret.
- Gaps for a one-step install:
  1. The flow serves its form on `127.0.0.1` (`setup/app.ts:282-286`) on a random port (`server.listen(0, "127.0.0.1")`, `:363`), so the
     browser must be on the machine running `init`, and a LAN option needs a bind address and a printed port. Unraid has no browser session, so today it runs on a laptop and the
     results are copied by hand (rows 3, 9, 11 of the table). `redirect_url` is where the browser is
     sent, so it can be the Unraid server's LAN address for the few minutes the flow runs; the
     docs do not forbid it. **UNVERIFIED** in practice, and it opens a short-lived listener on the
     LAN protected by `state`.
  2. `init` needs a repository checkout and a TTY and asks three questions (`setup/init.ts:764-798`);
     for an installer these must be flags. The webhook URL is known before creation:
     `tailscale status --json` gives the node name (`install-unraid.sh:394`).
  3. The output uses a key path the operator names and an App ID and secret in a file
     `install-unraid.sh` does not read (section 1.1). The installer should call the flow directly
     and write `service.env` and `app.pem` itself.
  4. Installing the App on repositories and setting `AGENT_ORCHESTRATOR=service` remain clicks and
     `gh variable set` calls per repository.
- Verification afterwards, all documented: the dispatcher reads the App's record at start and logs
  a `warning:` per missing permission or event (`docs/deploying-the-service.md:153-158`); and
  `GET /app/hook/deliveries` with an App JWT lists deliveries with `status_code` and `delivered_at`,
  `POST /app/hook/deliveries/{id}/attempts` redelivers
  (<https://docs.github.com/en/rest/apps/webhooks>). So the installer can end by checking that
  GitHub has a recent delivery the dispatcher answered 202 to.
- #344 (second repository: reuse an App) is mostly a non-issue for the service: the App's key lives
  in the dispatcher, not in per-repository secrets, so one App serves every repository it is
  installed on.

### Q8. Other adopters' risks

**Terms.** ADR 0001 says "a team sharing one person's subscription raises a terms question"
(`docs/adr/0001-personal-tooling-before-productising.md:12-14`). Anthropic's own page now says
(<https://code.claude.com/docs/en/legal-and-compliance>):

- OAuth authentication "is intended exclusively for purchasers of ... subscription plans and is
  designed to support ordinary use of Claude Code". Usage limits "assume ordinary, individual usage
  of Claude Code and the Agent SDK".
- "Developers building products or services ... including those using the Agent SDK, should use API
  key authentication." Third parties may not "route requests through Free, Pro, Max, or Ultra plan
  credentials on behalf of their users" or "collect, store, or intermediate Claude.ai credentials".
- An end user signing in to the unmodified binary with their own subscription is not prevented.
- `claude setup-token` makes a one-year token that "authenticates with your Claude subscription"
  (authentication page).

What follows for an installer: each adopter pastes their own token on their own machine; the
installer must never send it anywhere or run as a hosted service; and nothing should suggest that
one subscription can serve several people. Whether an unattended agent loop counts as "ordinary,
individual usage" is a judgement I cannot settle from the page (**UNVERIFIED**; the page points to
sales for questions). There is also a code constraint: `CLAUDE_CODE_OAUTH_TOKEN` is the one required
credential (`shared/contract.ts:207`; #367 lists it), so an adopter who must use an API key cannot
run the loop today.

**Secret handling today.** Hidden prompts that do not echo (`install-unraid.sh:118-123`), env files
mode 600 owned by root (`:277`, `install-box.sh:275`) with backups also 600 (`:291`, `install-box.sh:290`), the App
key mode 600 owned by uid 99 (`:245-246`), the registry token in a 0600 temp `.npmrc` deleted after
use (`:299-307`). The shared secret is never printed; checks compare a fingerprint
(`upgrade.sh:349-350`). These are good and should be kept as the rule: secrets arrive on stdin or a
hidden prompt, never argv or the seed ISO.

**What a stranger needs to know before running root scripts** (for the install doc): what each script
creates (the headers of `install-unraid.sh:8-14` and `install-box.sh:8-12` already list it); that
they edit the host firewall (`iptables` mangle chain) and define a libvirt network; where the
network calls go (the endpoint list in section 1.3); that Unraid and box compromise are separate
risks (the box is the untrusted side); how to undo it (no uninstall exists today, so Phase 3 adds a
`--remove` that prints the exact list).

**Where the install should end.** The check scripts already cover the machines (container running
and as `99:100`, env matches the file, App key mode, doors answering, Funnel published, firewall
chain and rule order, VM autostart off, MAC reservation, egress rule, proxy allowlist, bwrap start,
no direct internet for `worker`: `check-unraid.sh`, `check-box.sh`) and compare the two shared-secret
fingerprints. Add four end-to-end checks that need GitHub: the App is installed on at least one
repository (`GET /app/installations`, JWT), the App's last webhook delivery got 202, the dispatcher
logged no `warning:` line for permissions or events, and `doctor` passes on a named repository with
`AGENT_ORCHESTRATOR=service` (`setup/doctor.ts` ruling at `:1616-1650`). Make it one command,
`agent-service.sh check`, that opens one control connection and prints one verdict. An optional
canary that labels a test issue should be printed as a command for the user to run, not run by the
installer, since it writes to their repository.

---

## 3. Recommended architecture

```text
Release v<x> (immutable, attested)
  |- <scope>-agent-workflows-<x>.tgz (+ .sha256)    existing; the runner package
  |- agent-service-<x>.tgz (+ .sha256)               new; deploy/ scripts, box helper, templates
  |- bootstrap.sh                                    new; stable name, read-first, verifies the bundle
  `- (Phase 5) ghcr.io/<owner>/agent-dispatcher@sha256:...  image, attested

Unraid  /boot/config/agent-service/
  agent-service.sh {install|upgrade <v>|check|remove}   one front door
  lib.sh, host/unraid.sh (the 14 assumptions in one file), box/ (files sent to the box)
  agent-service.conf, known_hosts, box_key              kept across upgrades
  one RAM dir per run: key copy (600), ssh control socket, staged bundle

Box (Ubuntu 24.04 x64)
  /usr/local/sbin/agent-box-ctl  root-owned helper: install | restart | check | set-secret
  sudoers drop-in "agent-workflows-upgrade" for that helper only, on installer-built boxes
  everything else as install-box.sh builds it today
```

Rules:

1. One control connection per run, key-based, in RAM; one sudo prompt (or none).
2. Secrets cross machines on stdin over that connection, never in argv, files on the seed ISO, or the
   user's clipboard (`WORKER_SECRET` is generated on Unraid and sent to the box).
3. The scripts ship as a verified bundle and re-exec themselves; the conf and host keys persist.
4. Install and upgrade share one idempotent "converge" (recreate-if-drifted) so an upgrade can fix a
   container that `docker restart` cannot.
5. Host-specific code sits behind small functions in `host/unraid.sh`, so a `host/linux.sh` can be
   added without touching the flow.
6. Prompts that remain, and why each cannot go: (a) one browser click to create the App, (b) one
   paste of the Claude token (a browser sign-in only the user can do), (c) one confirmation of
   defaults (box size, subnet, Funnel port), (d) install-the-App clicks and per-repo variable.
   Everything else is generated or derived.

### 3.1 The principle: the contract is the product, the adapters are conveniences

Recorded 2026-11-02 from the maintainer, who compared the intent to Sandcastle (`docs/landscape.md`,
*Sandcastle*): you may run the service anywhere you are comfortable with the security of it. The
service is not that open by nature (it is event-driven, so it needs somewhere that receives
GitHub's webhooks and a worker fenced in from the host), so the way to get the same freedom is to
state what any host must guarantee and test it, not to support every host by name.

- **The contract** is what the check scripts already assert, written down as the requirement. From
  their output on 2026-11-02: the worker's sandbox starts and the `worker` user owns nothing outside
  its home and its state and temp folders; the worker may open connections on loopback alone and
  reaches GitHub, Anthropic and the token door only through the allowlist proxy, which refuses any
  other host; the box's network is dropped from private ranges and IPv6 by the host firewall, with
  the token door's rule ahead of the drops, and that rule survives a reboot; the dispatcher runs as
  a non-root user with only its own settings and App key readable; the webhook door and the token door
  answer; the two machines share one secret (fingerprints match); and a delivery has not failed.
  The contract text is to be written in Phase 3 from those checks; the list above is a sketch.
- **An adapter** is a host file (`host/unraid.sh` today, `host/linux.sh` next) that implements the
  host-specific functions behind the one front door. Where an adapter cannot give a guarantee (a
  host with no place for the firewall rule, say), it must say so in its own documentation and the
  check must report it as a warning or a failure, never skip it silently.
- **Keep what is Claude-specific in named places.** The maintainer's long-term aim (2026-11-02, "way
  down the line") is that the loop is not tied to Claude and works with any suitable agent, as
  Sandcastle does (#367, parked). Nothing here builds that. The install should not make it harder:
  the sign-in token and `claude setup-token`, the agent CLI installed on the box, and the Anthropic
  host in the proxy's allowlist each stay in one named place and out of the flow, so a second agent
  is a later addition.
- **Other platforms are not designed for.** The maintainer also wants, far off and perhaps not
  feasible, the workflows to run on GitLab, Linear and the like (2026-11-02). The service's
  dispatcher takes GitHub webhooks and mints GitHub App tokens, and the loop's state lives in
  GitHub labels, pull requests and review threads, so this is a larger change than any adapter in
  this note. It is recorded so the install does not assume the opposite in a way that is costly to
  undo; nothing here prepares for it.
- **Whoever installs makes the security call.** `agent-service.sh check` is the evidence they are
  shown; a setup that passes it meets the contract, one that does not is theirs to fix or accept.

### 3.2 Whether others can add adapters

Yes, as pull requests, once a few things exist that do not exist now. (Proposal; the maintainer
confirmed the direction, not these mechanics.)

1. **Before the first outside pull request is welcome:** a `LICENSE` file (D1; there is none today),
   a `CONTRIBUTING.md` that says what an adapter is and what it must pass, the adapter interface
   written down (Phase 3 produces it), and the ADR that changes ADR 0001 (section 6).
2. **What an adapter pull request carries:** the `host/<name>.sh` file, a documentation page for
   that host (what it needs, what it cannot guarantee), tests with the host commands stubbed as
   `tests/deploy/` does today, and the contributor's own `agent-service.sh check` output from a real
   install. CI cannot run a hypervisor or a firewall, so the real-host evidence has to come from the
   contributor, in the pull request.
3. **Two tiers, stated in the docs (D8):** *maintained* (the maintainer runs it on a release) and
   *community* (contributor-tested, labelled as such, may lag a release). A community adapter does not
   become maintained until someone the maintainer trusts runs it.
4. **Review stays human for anything run as root.** These are scripts run as root on strangers'
   machines. The loop acts on labels from people who may write to the repository (the App's
   permission list names "a label's sender's permission"), so an outside contributor cannot start it,
   and merging a `deploy/**` change should stay the maintainer's decision, as `agent:merge` already is
   (ADR 0009). Budget for that review: it is the cost of accepting adapters, not of writing them.
5. **UNVERIFIED:** how many adapters one maintainer can review, and whether outside people will
   come. ADR 0001's rule applies here too: the first outside person to complete an install is the
   evidence for building more.

---

## 4. Phased roadmap

Sizes: S under 100 changed lines, M 100 to 400, L over 400, including tests.

### Phase 0: decisions and spikes (no product code)

- Decide D1 (licence), D3 (immutable), D9 (terms wording), D6 (App flow locus). See section 5.
- Spikes, each a short note in `docs/friction.md` (append only):
  1. On the real Unraid: does ssh accept a key stored on `/boot`; does a ControlPath socket in
     `/tmp` work with `scp` too; is `requiretty` set on the box for `sudo -S`.
  2. Create the box from `noble-server-cloudimg-amd64.img` plus a `cidata` seed, assisted route; then
     `virsh define` and check the VM Manager shows and edits it.
  3. Can the install write the User Script schedule; or use `config/go`.
  4. Can a CA Docker template express host networking, `--user 99:100` and a mounted env file.
- Maintainer decision: yes (D1, D3, D6, D9). Extends #576, #580, replaces nothing. Size: S.

### Phase 1: an upgrade with one prompt

- What: `upgrade.sh` opens one master (`ControlMaster=auto`, `ControlPersist`, `ControlPath` in a
  `mktemp -d` RAM dir with `%C`) and closes it in a trap with `ssh -O exit`; copies the key to RAM
  at 600; reads the sudo password once with `read -rs` and sends it to `sudo -S -p ''` per call; drops
  `-t` and the carriage-return handling (`upgrade.sh:340-346`); merges the staged `rm` into the box
  helper call. Make `upgrade-unraid.sh` call a shared "converge the container" function (moved out of
  `install-unraid.sh:332-372`) so a drifted container is recreated. Add `--dry-run` that runs the
  stage phase only (`upgrade.sh:156-182`).
- Files: `deploy/unraid/upgrade.sh`, `upgrade-unraid.sh`, `install-unraid.sh`, a new `lib.sh`,
  `tests/deploy/upgrade.test.ts` (extend the `ssh`/`scp` stubs to assert one master, no `-t`, and the
  password never in argv), `deploy/unraid/README.md`, `docs/deploying-the-service.md` ("Upgrading
  both").
- Size: M. Decision: D5 (sudo model) only if you want NOPASSWD now; the prompt-once path needs none.
- Extends: #575 (closed). Touches #580 if `lib.sh` takes the package name from the tarball.

### Phase 2: ship the scripts, verify them, self-update

- What: `publish.yml` builds `agent-service-<v>.tgz` from `deploy/`, writes its `.sha256`, attaches
  both, attests both release files with `actions/attest` (add `id-token: write` and
  `attestations: write`), uploads a stable `bootstrap.sh`, and (if D3 is yes) creates the release as
  a draft, uploads, then publishes. `upgrade.sh` downloads the bundle in its stage step, re-execs
  itself if it changed, and prints the verify command. Add the `--reexec` guard so it cannot loop.
  Remove "These files are not part of the published package" from `README.md:64`.
- Files: `.github/workflows/publish.yml`, `deploy/unraid/upgrade.sh`, a new `deploy/unraid/bootstrap.sh`,
  `docs/agents/releasing.md` (the release list of assets), `ci.yml` (keep the `deploy/` guard,
  add: bundle contains exactly the expected files), `tests/deploy/`.
- Size: L. Decision: D3. Extends #561 and #575; closes the "copied by hand with scp" pain.
- Risk to note: the release is cut by a tag push (`docs/agents/releasing.md:3-10`); a draft-then-publish
  flow changes the re-run behaviour described at `releasing.md:94-99`.

### Phase 3: one-command install on Unraid (dispatcher half)

- What: `agent-service.sh install` replaces the `install-unraid.sh` prompts: preflight (plugins,
  Funnel, tools) with a list of what is missing and how to fix it; derive the webhook URL from
  `tailscale status --json`; run the App manifest flow in a throwaway `node` container with host
  networking (flags instead of questions, binding a LAN address if the spike passes, otherwise the
  laptop produces one bundle file); write `service.env` and `app.pem` directly; generate
  `WORKER_SECRET`; install the package from the tokenless tarball (removes the registry token prompt,
  #576) with the package name read from the tarball (removes the 16 hard-coded lines, #580); ask for
  `BOX_*` once and write `agent-service.conf`; schedule or document the firewall; print the
  remaining GitHub clicks; add `agent-service.sh remove` that lists, then removes, what install made.
- Files: `deploy/unraid/install-unraid.sh` (becomes the Unraid adapter), a new front door,
  `setup/init.ts` and `setup/app.ts` (flags: `--webhook-url`, `--settings-file`, `--key-file`, a bind
  address; no prompts when all given), `tests/app.test.ts`, `tests/agent-cli.test.ts`,
  `docs/deploying-the-service.md` (replace the hand-run sequence), `docs/ADOPTING.md` section 2e.
- Size: L. Decision: D6 (where the flow runs). Extends: #576, #580, #562 (`init --service`).
  Replaces the manual rows 1 to 5, 9, 11 and 18 of section 1.1.

### Phase 4: the box from a cloud-init seed, key-only

- What: `install` prepares the box: downloads and checks the Ubuntu image (`SHA256SUMS` and
  signature), resizes it, builds the `cidata` seed (user with `ssh_authorized_keys` and
  `lock_passwd: true`, hostname, nothing secret), and either guides the VM form (assisted) or runs
  `virsh define` (after the spike). Then over the first control connection it sends the bundle,
  `WORKER_SECRET` and the Claude token on stdin to a new root helper `agent-box-ctl`, which wraps
  `install-box.sh`'s logic. `install-box.sh` stops requiring a TTY (`install-box.sh:60-63`) and takes
  secrets from stdin; the registry token prompt goes (`:233-248`). Installs the sudoers drop-in for
  the helper only (D5), validated before it is put in place.
- Files: `deploy/unraid/install-box.sh`, new `box/agent-box-ctl`, `check-box.sh`, the Unraid adapter
  (VM and seed), `tests/deploy/` (a new box-side test with stubbed `apt`, `systemctl`, `nft`),
  `docs/deploying-the-service.md` (the worked example's VM section).
- Size: L. Decision: D4, D5. Replaces: rows 13 to 17 and 19 of section 1.1 (one paste remains: the Claude
  token). Extends: #576.

### Phase 5: portable shape

- What: `host/linux.sh` and a `compose.yaml` (dispatcher) plus a systemd-unit alternative; the host
  firewall as a documented nft unit; the dispatcher image on GHCR built in `publish.yml` from the
  verified tarball and attested; a CA template and `ca_profile.xml` if D7 says so; `LICENSE`
  already added in Phase 0. Docs: "Running the service on a Linux host", listing assumptions 1 to 14.
- Files: `.github/workflows/publish.yml`, new `deploy/linux/`, `deploy/unraid/ca-template.xml`,
  `docs/deploying-the-service.md`.
- Size: L. Decision: D7, D8, D10. Extends: #605 only in spirit (that issue is the Claude Code
  plugin); new issue otherwise.

### Phase 6 (separate decision, not part of this plan): the Actions-side adopter path

`init` and `doctor` still need a GitHub Packages token (`docs/ADOPTING.md:30-41`), and the callers
need `packages: read` (`:290-295`). That is the registry move and rename that
`docs/landscape.md:808-820` and ADR 0001 (`:28`) already name and keep unfiled. The service path
does not depend on it, because it uses the tarball. D2.

---

## 5. Open decisions for the maintainer

Each: the stake, options, my recommendation.

1. **D1, licence.** Stake: without a `LICENSE` file no one else may clearly use the code and CA will not
   list it. Options: add MIT now (matches `package.json`), choose another, leave it. Recommend MIT
   now; it costs one file.
2. **D2, registry for `init`/`doctor`.** Stake: a stranger needs a GitHub token just to run `init`.
   Options: keep GitHub Packages and document it; run `init` from the release tarball URL
   (`npm exec --package=<url>`, tokenless install is already tested at `publish.yml:268`, running
   `init` that way is UNVERIFIED); move to npmjs with a rename. Recommend the tarball URL route for
   this plan and leave the rename as its own decision.
3. **D3, immutable releases.** Stake: tamper-evidence for every asset versus not being able to fix a
   bad asset in place, and a changed `publish.yml`. Options: yes with draft-then-publish, no and rely on
   attestation only. Recommend yes, after Phase 2's workflow change, because a stranger's trust rests on
   these assets.
4. **D4, how far to automate the box.** Stake: how many Unraid-form clicks remain. Options: keep
   hand-made; assisted (the installer prepares disk and seed, you pick them in the form); fully
   automatic `virsh define`. Recommend assisted first, automatic only if the spike shows the VM Manager
   accepts it.
5. **D5, sudo model.** Stake: root on the box reachable without a password by Unraid. Options: prompt
   once everywhere; add a narrow NOPASSWD helper on installer-built boxes; NOPASSWD:ALL. Recommend the
   first for your current box and the second for new ones; never the third.
6. **D6, where the App manifest server runs.** Stake: a short-lived listener on your LAN versus a
   file you carry from a laptop. Options: Unraid in a container on the LAN address; laptop plus one
   bundle file. Recommend Unraid if the spike passes (it removes five typed values), laptop otherwise.
7. **D7, distribution surface for the dispatcher.** Stake: effort spent before anyone has installed it.
   Options: scripts only; scripts plus GHCR image and compose; plus a CA template; plus an Unraid
   plugin. Recommend scripts then image and compose; CA and plugin only after one outside person has
   installed it, in the spirit of ADR 0001's evidence rule.
8. **D8, what you will say is supported.** Stake: support load. Options: Unraid plus Ubuntu 24.04
   only; plus "Linux with Docker, as documented, tested by one adopter"; plus cloud hosts. Recommend the
   first two, labelled so.
9. **D9, terms wording and API key.** Stake: telling strangers something that is not true about their
   subscription. Options: a plain notice quoting the legal page and saying each person uses their own
   token; ask Anthropic; add an API-key path (#367). Recommend the notice now, and filing the
   API-key path as the answer to anyone who cannot use a subscription.
10. **D10, the Funnel dependency.** Stake: every adopter needs a Tailscale account and the plugin
    setting. Options: Funnel only; Funnel plus a documented manual tunnel or reverse proxy. Recommend
    Funnel as the one automated path and document the others as manual, since the door is plain HTTP.

---

## 6. What ADR 0001 would need changed

Done in the change that added this note: [ADR 0011](./adr/0011-the-service-install-is-for-others-too.md)
records the new direction and ADR 0001 carries a dated pointer to it. What follows is the analysis
it was written from, as the research left it.

ADR 0001 (`docs/adr/0001-personal-tooling-before-productising.md`) is status `accepted`.

- Its revisit condition 1 is "Someone outside asks to use it" (`:32-33`). That has not happened, so
  do not edit it to say it has. Write a new ADR (0011) that records the maintainer's changed
  direction for the service install path, and mark 0001 "superseded in part by 0011".
- 0011 should say what is unparked and what is not. Unparked by this plan: an install that others
  can run (this document), and `LICENSE`. Still parked unless a decision says otherwise: #360 and
  #362 (adopters' self-hosted runners; the service avoids the cross-owner limit), #367 (second agent,
  though D9 may pull the API-key part forward), #371 to #373 (`doctor` checks on callers), the
  rename and registry move (D2). #344 and #346 are about the Actions side; #344 is mostly moot for
  the service (Q7).
- The lines in 0001 that stay true as history but should be dated: "eleven weeks old, no adopter but
  its maintainer" (`:16-17`), and "The subscription advantage mostly serves solo maintainers, since a
  team sharing one person's subscription raises a terms question" (`:12-14`), which Q8 now backs with
  Anthropic's wording.
- "Revisit when" needs a replacement trigger for the next unparking step: the first outside person who
  completes an install is the evidence for D7's CA template, the registry move and the rename, in the
  same spirit as 0001's own rule.
- ADR 0001's remaining two revisit conditions (gh-aw accepting subscription tokens; Anthropic
  restricting subscription use in automation) are unchanged, and the second one is exactly what
  Q8's legal page is the live text for.
- `docs/deploying-the-service.md:824-829` says the scripts "are not part of the package"; and
  `deploy/unraid/README.md:5-6,56-64` say they support "that one setup ... and no other" and need a
  registry token for first install. All three change with Phases 2 to 4.

---

## 7. Not verified

- How many screens Ubuntu 24.04's installer takes on the VM (row 14).
- Why you saw 2 sudo prompts where the code has 3 call sites.
- Whether ssh accepts a key on `/boot`; whether vfat holds a socket; whether `/root/.ssh` is writable
  on the Unraid version in use (Unraid docs and your finding disagree).
- Whether Ubuntu's default sudoers sets `requiretty` (affects `sudo -S` without a terminal).
- `visudo -c` behaviour; cloud-init modules other than users and NoCloud.
- Whether Unraid ships `virt-install`; whether a `virsh define`d VM appears and edits correctly in
  the VM Manager; whether the ISO can be built in a throwaway container and with which package.
- Whether a CA Docker template can express host networking, `--user` and a secret env file; the CA
  review policy for Docker templates; the `.plg` format; Unraid 8's compose support.
- Whether the install can write the User Scripts schedule, and `config/go` timing relative to
  libvirt.
- `config.sh --unattended`, `--replace`, `remove` for the GitHub runner; upgrade steps for the
  runner, Tailscale and Portainer; any project's `--dry-run`.
- Whether a manifest `redirect_url` on a LAN address works end to end, and whether the conversion
  endpoint's lack of authentication still holds.
- Whether Unraid has `gh`, and whether `npm exec --package=<tarball url> -- agent-workflows init`
  works tokenless.
- Whether an unattended loop on a personal subscription is "ordinary, individual usage" under
  Anthropic's terms.
- Behaviour of bwrap on Ubuntu 26.04 (#360 probe 3).
