---
source: >-
  PR #577, the loop's Review 2 at edb772f (this case's head), which approved and recorded the hard-coded package scope as a follow-up: https://github.com/jeffwlawson/agent-workflows/pull/577#pullrequestreview-5725486080, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
  "02": fail
  "04": fail
  "05": pass
---

**Review 2**

## Agent review

### 🟢 Approval recommended

The ci.yml comment finding is fixed, and nothing is left open: the orchestrator, the two halves and the docs meet every criterion, and the fix commit only edits a comment.

_Nothing left to fix. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Resolved since last review</b> (1)</summary>

- Low [ci.yml still says the deploy scripts have no tests](https://github.com/jeffwlawson/agent-workflows/pull/577#discussion_r4433696127) · `tests/deploy/upgrade.test.ts:11`

</details>

<details>
<summary><b>Acceptance criteria</b> (8) · 8 met</summary>

- **Met:** `bash deploy/unraid/upgrade.sh <version>` with all machines stubbed (a fake `curl`, `ssh`, `scp`, `docker`, `systemctl` on `PATH`, as far as the repo's existing deploy-script tests go; if there are none, a small bash test in `tests/` is added) never asks for or reads a token, and no script under `deploy/` contains `read:packages`, `_authToken` or `npm.pkg.github.com` outside `install-*.sh`.
- **Met:** A tarball whose digest does not match its `.sha256` stops the run before either machine is touched, on Unraid and again on the box.
- **Met:** With `PACKAGE_SOURCE` and the installed package's `repository` both absent it refuses, naming `PACKAGE_SOURCE`; `grep -rn jeffwlawson deploy/` finds no new hit, and no IP or user is a literal in the new or changed scripts.
- **Met:** A version mismatch or fingerprint mismatch between the two check outputs exits non-zero with the two values printed; a match exits zero.
- **Met:** The ssh and scp calls carry `UserKnownHostsFile` under the conf directory and `StrictHostKeyChecking=accept-new`, and none touches `~/.ssh`.
- **Met:** The output carries the dropped-queue and 409-window statements.
- **Met:** `shellcheck -S warning deploy/*/*.sh` is clean (CI runs it); `npm run verify` passes. The scripts stay outside the published package (nothing under `deploy/` is added to `files`, `bundleDependencies` or the build copy).
- **Met:** `deploy/unraid/README.md` (script table, requirements: the token line goes, `BOX_SSH_USER` and `PACKAGE_SOURCE` come in, the ssh note) and the worked example in `docs/deploying-the-service.md` (*A worked example*, the upgrade steps) describe the one command and the two halves, and say the registry route is no longer used by these scripts.

</details>

<details open>
<summary><b>Since the brief</b> (5) · commits since <code>c8ff6c2</code> that touched the files it names</summary>

Files checked: `docs/deploying-the-service.md`.

On the base branch, newest first:

- `795fb6f` feat(implement): rescue a stopped run's commits to agent/rescue/issue-<n> and resume from them (#570)
- `15d2d6e` feat(service): check the App's permissions and events at the dispatcher's start (#574)
- `08c7d17` feat(publish): attach the packed tarball and its SHA-256 to each GitHub Release (#572)
- `8e5d3a1` feat(deploy): move the Unraid install, upgrade and check scripts into deploy/unraid/ (#564)
- `a0c2980` fix(service): fetch the repository's tags into every checkout (#567) (#568)

**Ruling:** None of the listed commits changes what a criterion means. 08c7d17 adds the Installing the package section this change builds on, 8e5d3a1 put the scripts at the deploy/unraid/ paths the brief already names, and 15d2d6e, 795fb6f and a0c2980 touch unrelated sections.

**Not found at `c8ff6c2`:** `deploy/unraid/upgrade-unraid.sh`.

</details>

<details open>
<summary><b>Not checked here</b> (2) · tests exercising this change that the review's own run skipped</summary>

- **tests/deploy/upgrade.test.ts (13 tests and 2 static checks)**: not run: node_modules is absent here, so vitest failed with ERR_MODULE_NOT_FOUND; CI verify is green
- **shellcheck -S warning deploy/*/*.sh**: shellcheck is not installed here; CI runs it

</details>

<details>
<summary><b>Follow-ups</b> (1) · filed as issues on merge; remove <code>agent:follow-ups</code> to skip</summary>

- Low **Deploy scripts' PKG_JSON defaults hardcode the package scope** · `deploy/unraid/upgrade-unraid.sh:30`

</details>

<details>
<summary><b>How this was checked</b></summary>

This pass checks the earlier round's finding. I read edb772f's ci.yml comment and searched for 'no tests of their own': no other copy remains. Across the full diff, I checked that the INFO and fingerprint lines upgrade.sh parses match check-unraid.sh:186,215 and check-box.sh:153,181 exactly. I also traced the digest checks and the order of install and restart. I searched *.md, *.yml and *.sh for the old token and upgrade wording (read:packages, 'delete the token', upgrade-unraid.sh <version>): about 25 hits, all still true. Nothing goes anywhere new beyond the script's own terminal output.

</details>
