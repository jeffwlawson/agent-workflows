---
source: >-
  PR #577, the loop's Review 3 at 58a8c32 (after the fix for 01), which asked for changes and recorded the package scope as a follow-up: https://github.com/jeffwlawson/agent-workflows/pull/577#pullrequestreview-5725558564, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
  "04": pass
  "05": pass
---

**Review 3**

## Agent review

### 🟡 Changes recommended

CI is red because shellcheck rejects a line the last fix round added. Two recovery messages name commands that fail as written.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 3 (1 High, 2 Low)

<details open>
<summary><b>Open</b> (3)</summary>

- High Acceptance criterion not met: `shellcheck -S warning deploy/*/*.sh` is clean (CI runs it); `npm run verify` passes. The scripts stay outside the published package (nothing under `deploy/` is added to `files`, `bundleDependencies` or the build copy). · `deploy/unraid/upgrade.sh:72` *new*
- Low Each half's closing advice names a call the other half refuses · `deploy/unraid/upgrade-unraid.sh:122` *new*
- Low The way back fails for a release with no tarball attached · `deploy/unraid/upgrade.sh:117` *new*

</details>

<details open>
<summary><b>Acceptance criteria</b> (8) · 7 met, 1 unmet</summary>

- **Met:** `bash deploy/unraid/upgrade.sh <version>` with all machines stubbed (a fake `curl`, `ssh`, `scp`, `docker`, `systemctl` on `PATH`, as far as the repo's existing deploy-script tests go; if there are none, a small bash test in `tests/` is added) never asks for or reads a token, and no script under `deploy/` contains `read:packages`, `_authToken` or `npm.pkg.github.com` outside `install-*.sh`.
- **Met:** A tarball whose digest does not match its `.sha256` stops the run before either machine is touched, on Unraid and again on the box.
- **Met:** With `PACKAGE_SOURCE` and the installed package's `repository` both absent it refuses, naming `PACKAGE_SOURCE`; `grep -rn jeffwlawson deploy/` finds no new hit, and no IP or user is a literal in the new or changed scripts.
- **Met:** A version mismatch or fingerprint mismatch between the two check outputs exits non-zero with the two values printed; a match exits zero.
- **Met:** The ssh and scp calls carry `UserKnownHostsFile` under the conf directory and `StrictHostKeyChecking=accept-new`, and none touches `~/.ssh`.
- **Met:** The output carries the dropped-queue and 409-window statements.
- **Unmet:** `shellcheck -S warning deploy/*/*.sh` is clean (CI runs it); `npm run verify` passes. The scripts stay outside the published package (nothing under `deploy/` is added to `files`, `bundleDependencies` or the build copy). · `shellcheck -S warning deploy/*/*.sh` fails with SC1007 on `installed_json= previous=`, added in 58a8c32, which is CI's red verify; write `installed_json='' previous=''`.
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

**Ruling:** None changes what a criterion means: 08c7d17 (#572) is the tarball prerequisite C2 and C3 build on, and 15d2d6e, 795fb6f, 8e5d3a1 and a0c2980 touch other sections or moved the scripts before the brief's paths.

**Not found at `c8ff6c2`:** `deploy/unraid/upgrade-unraid.sh`.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/workflows.test.ts, 'a local caller passes only what the release it pins declares' (12 tests)**: failed locally: the checkout has no v0.9.2 tag, and git fetch --tags was refused

</details>

<details>
<summary><b>Follow-ups</b> (1) · filed as issues on merge; remove <code>agent:follow-ups</code> to skip</summary>

- Low **Deploy scripts' PKG_JSON defaults hardcode the package scope** · `deploy/unraid/upgrade-unraid.sh:30`

</details>

<details>
<summary><b>How this was checked</b></summary>

Ran npm run verify: 5532 passed, all of tests/deploy/upgrade.test.ts included. The 12 failures in workflows.test.ts need git tags, and fetching them was refused here. Ran shellcheck v0.10.0 -S warning over deploy/*/*.sh: SC1007 at upgrade.sh:72, absent at edb772f, so 58a8c32 caused it. Compared the test's stand-in INFO lines with the real check-unraid.sh and check-box.sh: they match. Grepped deploy/ for the token words and the owner. Searched the docs and scripts for the old one-argument upgrade calls and read every hit. The change sends no text anywhere new. The red check is not configured.

</details>

## Inline comments

### On `deploy/unraid/upgrade-unraid.sh`

Low

`echo "Now move the box to the same version (upgrade-box.sh $version, or upgrade.sh for both):"` names a call that now prints usage and exits 2. A half given no `--restart` needs a `<tarball>` (`if [ "$phase" != restart ] && [ -z "$tarball" ]; then usage; fi`). `deploy/unraid/upgrade-box.sh:124` has the same defect (`upgrade-unraid.sh $version`). An operator recovering one machine who follows the advice gets a usage error. Fix both lines; this suggestion covers the first.

```suggestion
echo "Now move the box to the same version (upgrade-box.sh $version <tarball>, or upgrade.sh for both):"
```

### On `deploy/unraid/upgrade.sh`

Low

After a failed install, `back="bash $here/upgrade.sh ${previous:-...}"` is printed as the way to put the box back. upgrade.sh can only install a version whose Release carries the tarball and its `.sha256`, and #572 (08c7d17) began attaching those after v0.9.2 was tagged. This deployment's first upgrade starts from v0.9.2, so on that run the advice ends at `Could not download ...`, with a half-installed box and no working way back. Say that the way back needs a release with its tarball, and name the fallback for older ones.

### On `deploy/unraid/upgrade.sh`

High

The linked issue's acceptance criterion is not met: "`shellcheck -S warning deploy/*/*.sh` is clean (CI runs it); `npm run verify` passes. The scripts stay outside the published package (nothing under `deploy/` is added to `files`, `bundleDependencies` or the build copy).". `shellcheck -S warning deploy/*/*.sh` fails with SC1007 on `installed_json= previous=`, added in 58a8c32, which is CI's red verify; write `installed_json='' previous=''`. If this pull request departs from it on purpose, say why in its body, and the next review records the criterion as changed.
