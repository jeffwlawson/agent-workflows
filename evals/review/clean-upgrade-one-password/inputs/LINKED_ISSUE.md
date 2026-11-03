> *Filed by AI from the installability research (Phase 1), after a real upgrade from 0.9.8 to 0.9.9 on 2026-11-02 where the maintainer typed the box's ssh password 5 times and its sudo password 2 times. The maintainer asked for installs and upgrades that prompt for a few things, once.*

## Agent Brief

**Category:** enhancement

**Summary:** `deploy/unraid/upgrade.sh` opens a new ssh or scp connection for every step it runs on the box, so with password login it asks for the box's ssh password at each, and again for sudo at each `sudo`. Make one run ask for the ssh password once (not at all with a key), and for the sudo password once.

**Current behaviour** (read on `main` at 957ae7b, 2026-11-02):
- `upgrade.sh` builds `ssh_opts` (host keys beside the conf, `accept-new`, an optional `-i $BOX_SSH_KEY`) and `on_box() { ssh "${ssh_opts[@]}" -t "$box" "$1"; }`. Each `on_box` and the one `scp` is its own connection: the copy (`scp`), the install, the staged-file `rm`, the restart and the check. That is 5 ssh/scp connections, so 5 ssh password prompts when the maintainer logs in by password.
- Three of those run `sudo` (`upgrade-box.sh --install`, `--restart`, and `check-box.sh`), each with `-t`, so each asks for the sudo password. sudo's default ticket is per terminal (`timestamp_type=tty`), and every `ssh -t` gets a new terminal, so one entry never covers the next. A connection-sharing option alone therefore fixes the ssh prompts and leaves the sudo ones.
- The box's lines arrive through a terminal and end in a carriage return, which the script strips before it parses them.
- `BOX_SSH_KEY`, when set, is passed to ssh with `-i`. On Unraid the conf sits on `/boot`, a FAT filesystem, and OpenSSH refuses a private key whose file mode is open to others. Whether it does for a key on `/boot` is not confirmed (the research marks it unverified), so the copy below is a precaution.

**Desired behaviour:**
- **One connection.** Each run makes a private directory (`mktemp -d`, mode 700) in the system temp directory, never beside the conf and never under `/boot`, and opens one ssh master connection with a `ControlPath` in it (`%C` keeps the socket's name short). Every later ssh and scp of that run reuses it. The master is closed (`ssh -O exit`) and the directory removed when the script ends, whether it succeeds, fails or is interrupted.
- **One sudo password.** The script reads the box's sudo password once, with no echo, before the first step that needs it, and sends it to each box `sudo` on stdin (`sudo -S -p ''`). It is never in an argument list, a printed line or a file. The box commands drop `-t`, so the carriage-return stripping goes with it.
- **A key on `/boot`.** Where `BOX_SSH_KEY` is set, the script copies the key into the private directory with mode 600, uses the copy for every ssh and scp of the run, and removes it at the end. The original is not changed.
- **Where no terminal is available** to read the password, it does not guess: a sudo that wants one fails with a message that says to run the script from a terminal, and the script's existing stop-and-name-the-next-command behaviour applies.
- **The commands printed for an operator to paste** when a step stops stay as they are (with `-t`, no control path), because they run after the script has ended and its master is gone.

**Decisions made here (the implementer may change one with a reason in the PR):**
- **Prompt once, no standing grant.** No sudoers change, no passwordless sudo. A narrower helper for boxes the installer builds is a later decision (the research's D5).
- **Only `upgrade.sh`.** `upgrade-unraid.sh` and `upgrade-box.sh` run on one machine each and have no ssh.
- **The ControlPath is in the system temp directory,** because `/boot` is FAT and cannot hold a socket. Whether that works on the maintainer's Unraid is not known from here (see *After merge*), so the script must still work if the master cannot be set up: ssh then falls back to a connection per step, as today.

**Acceptance criteria:**
- [ ] A stubbed run of `upgrade.sh` opens exactly one master connection, and every other ssh and scp it makes names that master's `ControlPath`; a test reads the stubs' call log.
- [ ] The `ControlPath`'s directory is mode 700, is not under the conf's directory or `/boot`, and is gone after a successful run, a failed one and an interrupted one; the master is asked to exit in each.
- [ ] The sudo password appears in no argument list, no line of output and no file the run leaves; a test with a sentinel password checks all three, as the existing test does for the worker's secret.
- [ ] Each box `sudo` receives the password on stdin and the run reads it once however many `sudo` calls it makes; a test counts the reads.
- [ ] No box command uses `-t`, and the output parsing still gets the version and fingerprint lines from the box's check without carriage-return handling.
- [ ] With `BOX_SSH_KEY` set, every ssh and scp of the run uses a copy of the key with mode 600 inside the private directory, the copy is removed at the end, and the original's mode and content are unchanged.
- [ ] With no terminal to read the password from, a step whose `sudo` wants one fails with a message naming the terminal, and the existing commands-that-finish message still prints.
- [ ] The commands printed for an operator to paste still carry `-t` and the host-key options, and nothing in a run writes under `~/.ssh` (the existing tests keep passing, adjusted only where they assert `-t` on every box command).
- [ ] `deploy/unraid/README.md` and `docs/deploying-the-service.md` (*Upgrading both*) say a run asks for the ssh password once (none with a key) and the sudo password once, in place of "each ssh that runs `sudo` asks for its password".
- [ ] The verify command `CLAUDE.md` names passes.

## Tests

Extend `tests/deploy/upgrade.test.ts`, where `ssh` and `scp` are stubbed (the `ssh` stub runs the last argument in a fake box home, and every stub logs its argv to one call log). The `ssh` stub must learn the master's options (`-M`, `-N`, `-f`, `-O exit`) and a `sudo` stub must read its password from stdin. The two existing assertions that every box ssh carries ` -t ` (around lines 526 to 541) change to the new rule, and the pasted-command test (around line 268) stays as it is.

## Out of scope

- Recreating the dispatcher's container on upgrade, so a drifted one gains the `/state` mount: `install-unraid.sh` also writes `STATE_FILE` into `service.env`, so that needs the settings change too. Its own issue, to be filed next.
- `--dry-run`, shipping the deploy scripts in each release, `ssh-copy-id` or key generation, a sudoers helper, `install-unraid.sh` and `install-box.sh` (Phases 2 to 4 of the research).

## Where things are

Read on `main` at 957ae7b, 2026-11-02. Hints only; re-read them.
- `deploy/unraid/upgrade.sh`: `ssh_opts` and `on_box` (about lines 139 to 142), the `scp` (176), the `on_box` calls at 186, 198, 317 and 345, and the `tr -d '\r'` in `info()` after the checks.
- `tests/deploy/upgrade.test.ts`: the `scp` and `ssh` stubs (about lines 50 to 60) and the host-key and `BOX_SSH_KEY` tests (about lines 526 to 550).
- `deploy/unraid/README.md` and `docs/deploying-the-service.md`, the upgrade passages that say the sudo prompt is the only one.

## After merge, by a human

- [ ] On the next release, run `upgrade.sh` on the real Unraid and count the prompts: expect one ssh password (none with a key) and one sudo password. If ssh still asks more than once, the control socket could not be made there; note the message.
- [ ] If the run says the box's `sudo` needs a terminal (`requiretty`), say so on this issue; it would change the approach.
- [ ] With `BOX_SSH_KEY` pointing at a key on `/boot`, confirm ssh accepts the copy.
