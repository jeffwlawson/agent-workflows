---
source: >-
  PR #692, the loop's Review 1 at 9d5c407 (this case's head), which approved: https://github.com/jeffwlawson/agent-workflows/pull/692#pullrequestreview-5744745289, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
---

**Review 1**

## Agent review

### 🟢 Approval recommended

The change holds up: the shared connection, the sudo password read once and sent on stdin, and the mode 600 copy of the key each work as #690 asks, each has a test, and the docs match.

_Nothing here blocks the merge; any minor findings below are filed as one follow-up. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Acceptance criteria</b> (10) · 10 met</summary>

- **Met:** A stubbed run of `upgrade.sh` opens exactly one master connection, and every other ssh and scp it makes names that master's `ControlPath`; a test reads the stubs' call log.
- **Met:** The `ControlPath`'s directory is mode 700, is not under the conf's directory or `/boot`, and is gone after a successful run, a failed one and an interrupted one; the master is asked to exit in each.
- **Met:** The sudo password appears in no argument list, no line of output and no file the run leaves; a test with a sentinel password checks all three, as the existing test does for the worker's secret.
- **Met:** Each box `sudo` receives the password on stdin and the run reads it once however many `sudo` calls it makes; a test counts the reads.
- **Met:** No box command uses `-t`, and the output parsing still gets the version and fingerprint lines from the box's check without carriage-return handling.
- **Met:** With `BOX_SSH_KEY` set, every ssh and scp of the run uses a copy of the key with mode 600 inside the private directory, the copy is removed at the end, and the original's mode and content are unchanged.
- **Met:** With no terminal to read the password from, a step whose `sudo` wants one fails with a message naming the terminal, and the existing commands-that-finish message still prints.
- **Met:** The commands printed for an operator to paste still carry `-t` and the host-key options, and nothing in a run writes under `~/.ssh` (the existing tests keep passing, adjusted only where they assert `-t` on every box command).
- **Met:** `deploy/unraid/README.md` and `docs/deploying-the-service.md` (*Upgrading both*) say a run asks for the ssh password once (none with a key) and the sudo password once, in place of "each ssh that runs `sudo` asks for its password".
- **Met:** The verify command `CLAUDE.md` names passes.

</details>

_**Since the brief:** no commit since `957ae7b` touched the 4 files its *Where things are* names._

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/deploy/upgrade.test.ts**: vitest failed with ERR_MODULE_NOT_FOUND because node_modules is not installed, and I left the checkout unchanged; I relied on CI's verify check (success).

</details>

<details>
<summary><b>How this was checked</b></summary>

I read upgrade.sh's ssh, sudo and cleanup trap code in full, and checked upgrade-box.sh and check-box.sh to confirm neither needs a terminal or reads stdin. I checked that OpenSSH falls back to a direct connection when the ControlPath has no master. I searched the checkout for 'carriage', 'each ssh that', 'only prompt', 'ssh -t' and 'sudo password' and read about 25 hits; the ones left are eval fixtures and the install scripts' own ssh -t hints, which are still true. New place text is sent: the box sudo's stdin, which carries the password, by design. I read CI verify's result…

</details>
