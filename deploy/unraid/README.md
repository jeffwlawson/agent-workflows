# Deploying the service on Unraid

The scripts behind the worked example in
[docs/deploying-the-service.md](../../docs/deploying-the-service.md#a-worked-example-the-maintainers-unraid-server):
the dispatcher in a container on Unraid, the worker in a VM on it. They support that one setup, an
Unraid host plus a VM, and no other.

| Script | Runs on | Does |
|---|---|---|
| `install-unraid.sh <version>` | Unraid, as root | agentnet and its reservation, the firewall User Script, the dispatcher's settings, package, writable `state/` folder (its `STATE_FILE`) and container, the Funnel |
| `install-box.sh <version>` | the box, as root | bubblewrap and its AppArmor profile, Node, tinyproxy, the egress rule, the `worker` user, the package and the worker's unit |
| `upgrade.sh [--now] <version>` | Unraid, as root | both machines at another version: downloads the release's tarball, copies it to the box, installs on both, waits up to `IDLE_WAIT_MINUTES` (90) for the worker to hold no job, restarts the worker then the dispatcher, runs both checks and compares them. `--now` restarts without waiting, dropping what the worker holds |
| `upgrade-unraid.sh [--install \| --restart] <version> [<tarball>]` / `upgrade-box.sh …` | each machine | the halves of `upgrade.sh`: install a tarball they are handed, restart (on Unraid, recreating a dispatcher container that has drifted), then the check. Run alone, to recover or roll back one machine, they do all three; `--install` and `--restart` do one phase each, as `upgrade.sh` calls them |
| `dispatcher-container.sh` | read by `install-unraid.sh` and `upgrade-unraid.sh` | not run on its own: the dispatcher's container as the install makes it, its drift check and its create step, shared so an upgrade recreates a container that differs (one made before the state file, with no `/state` mount, among them) rather than restarting it. Where `service.env` has no `STATE_FILE`, the upgrade adds the install's line and makes `state/`; it asks for nothing |
| `check-unraid.sh` / `check-box.sh` | each machine | read-only checks; each prints a fingerprint of the shared secret, which must match the other's |
| `runs.sh [<count>] [<job-id>]` | the box, as root | the run index, read-only: the most recent runs under `WORK_DIR/runs` (20 by default), newest first, each with its start, job id, workflow, repository and number, how each phase ended, and duration; given a job id, that run's directory and phases in full. The id is the one the service's "Workflow run" link ends with, `https://github.com/apps/<slug>#job-<id>`. It reads only each run's `summary.json`, so it prints no log text and no token. `upgrade.sh` copies it to the box where it is beside it |

Each is safe to run again. Settings that differ from the scripts' defaults go in
`agent-service.conf` beside them: copy [`agent-service.conf.example`](./agent-service.conf.example).

No script asks for a token to install the package. An install at a version that is not installed
downloads that release's tarball and its `.sha256` from the repository `PACKAGE_SOURCE` names,
checks the digest and installs the tarball; a download that fails, or a digest that does not
match, stops it with the URL named and the installed package as it was. An upgrade is one command
on Unraid:

```bash
bash /boot/config/agent-service/upgrade.sh <version>
```

It needs, in `agent-service.conf`:

- **`PACKAGE_SOURCE`**, the `<owner>/<repo>` the package is released from, unless the installed
  package's `repository` field names a github.com one. The repository must be public: its
  Release assets are what is downloaded, with no token. `install-unraid.sh` and `install-box.sh`
  need it set wherever the package is not at the version they are run at, so put a copy of the
  conf beside `install-box.sh` on the box too.
- **`BOX_SSH_USER`**, the box's admin account, which may `sudo`, and **`BOX_IP`**, set even where
  it is the default. `BOX_SSH_KEY` names the key where ssh's default is not it.

On ssh: Unraid's root `~/.ssh` cannot be written, so `upgrade.sh` keeps the box's host key in
`known_hosts` beside the conf, recording it at the first connect and refusing a changed one after
(`StrictHostKeyChecking=accept-new`). A run asks for the box's ssh password once (not at all with
a key) and for its `sudo` password once: it opens one ssh connection, in a private directory under
the system temp directory, that every later ssh and scp shares, and hands the `sudo` password to
each `sudo` on the box on its stdin, never on a command line, in output or in a file. Run it from a
terminal, which the password is read from; without one, a `sudo` on the box that wants a password
fails and says so. Where `BOX_SSH_KEY` is set, the run uses a mode 600 copy of the key in that
private directory, since a key on `/boot` may be open to others, and removes it at the end. Where
the shared connection cannot be opened, each step connects on its own and ssh may ask again. The
commands a stopped step prints for you to paste use `ssh -t` and the original key.

On the worker's queue: it is in memory, so restarting the worker drops every job it holds, and a
running one starts again from the beginning. So after both installs, and before either restart,
`upgrade.sh` asks the worker's held door which jobs it holds, from inside the dispatcher's
container, signed with the `WORKER_SECRET` already set there, so the secret is never printed or
put on a command line. The question is a read only: it names no dispatcher instance, so the worker
drops nothing for it. While the worker holds a job the script waits, printing the jobs (workflow,
repository and number), a line when they change, and a line every five minutes. It waits up to
`IDLE_WAIT_MINUTES` (90 by default); past that, or where the worker cannot be asked (unreachable,
a refused signature, an answer that is not a list of jobs), it stops with both machines installed
and neither restarted, and names the ways on: run it again later, or with `--now`, which restarts
without asking. A worker from a release before the held door answers `404`: the script says it
cannot tell, and goes on as it did before. One window stays open: a webhook that lands between the
worker's empty answer and its restart queues a job the restart drops, and the dispatcher's scan
dispatches it again.

What these scripts support, and what they do not yet:

- **Unraid** for the dispatcher, with the User Scripts plugin and Tailscale for the Funnel.
- **Ubuntu 24.04 on x64** for the box. The VM itself is made by hand in Unraid's VM form.
- **Releases that carry their tarball**: a release published before its tarball was attached to
  it can be neither installed nor rolled back to by these scripts.
- **One worker.**

These files are not part of the published package.
