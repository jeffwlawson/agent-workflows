# Deploying the service on Unraid

The scripts behind the worked example in
[docs/deploying-the-service.md](../../docs/deploying-the-service.md#a-worked-example-the-maintainers-unraid-server):
the dispatcher in a container on Unraid, the worker in a VM on it. They support that one setup, an
Unraid host plus a VM, and no other.

| Script | Runs on | Does |
|---|---|---|
| `install-unraid.sh <version>` | Unraid, as root | agentnet and its reservation, the firewall User Script, the dispatcher's settings, package and container, the Funnel |
| `install-box.sh <version>` | the box, as root | bubblewrap and its AppArmor profile, Node, tinyproxy, the egress rule, the `worker` user, the package and the worker's unit |
| `upgrade.sh <version>` | Unraid, as root | both machines at another version: downloads the release's tarball, copies it to the box, installs on both, restarts the worker then the dispatcher, runs both checks and compares them |
| `upgrade-unraid.sh [--install \| --restart] <version> [<tarball>]` / `upgrade-box.sh …` | each machine | the halves of `upgrade.sh`: install a tarball they are handed, restart, then the check. Run alone, to recover or roll back one machine, they do all three; `--install` and `--restart` do one phase each, as `upgrade.sh` calls them |
| `check-unraid.sh` / `check-box.sh` | each machine | read-only checks; each prints a fingerprint of the shared secret, which must match the other's |

Each is safe to run again. Settings that differ from the scripts' defaults go in
`agent-service.conf` beside them: copy [`agent-service.conf.example`](./agent-service.conf.example).

An upgrade is one command on Unraid, with no registry token:

```bash
bash /boot/config/agent-service/upgrade.sh <version>
```

It needs, in `agent-service.conf`:

- **`PACKAGE_SOURCE`**, the `<owner>/<repo>` the package is released from, unless the installed
  package's `repository` field names a github.com one. The repository must be public: its
  Release assets are what is downloaded, with no token.
- **`BOX_SSH_USER`**, the box's admin account, which may `sudo`, and **`BOX_IP`**, set even where
  it is the default. `BOX_SSH_KEY` names the key where ssh's default is not it.

On ssh: Unraid's root `~/.ssh` cannot be written, so `upgrade.sh` keeps the box's host key in
`known_hosts` beside the conf, recording it at the first connect and refusing a changed one after
(`StrictHostKeyChecking=accept-new`). Each ssh that runs `sudo` on the box asks for its password.

The upgrade scripts no longer use the registry route: the token prompt is gone from them. The
install scripts still use it.

What these scripts support, and what they do not yet:

- **Unraid** for the dispatcher, with the User Scripts plugin and Tailscale for the Funnel.
- **Ubuntu 24.04 on x64** for the box. The VM itself is made by hand in Unraid's VM form.
- **A registry token** for the first install only, typed at a prompt in `install-unraid.sh` and
  `install-box.sh`.
- **One worker.**

These files are not part of the published package.
