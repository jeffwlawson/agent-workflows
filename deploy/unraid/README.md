# Deploying the service on Unraid

The scripts behind the worked example in
[docs/deploying-the-service.md](../../docs/deploying-the-service.md#a-worked-example-the-maintainers-unraid-server):
the dispatcher in a container on Unraid, the worker in a VM on it.

| Script | Runs on | Does |
|---|---|---|
| `install-unraid.sh <version>` | Unraid, as root | agentnet and its reservation, the firewall User Script, the dispatcher's settings, package and container, the Funnel |
| `install-box.sh <version>` | the box, as root | bubblewrap and its AppArmor profile, Node, tinyproxy, the egress rule, the `worker` user, the package and the worker's unit |
| `upgrade-unraid.sh <version>` / `upgrade-box.sh <version>` | each machine | the package at another version, a restart, then the check |
| `check-unraid.sh` / `check-box.sh` | each machine | read-only checks; each prints a fingerprint of the shared secret, which must match the other's |

Each is safe to run again. Settings that differ from the scripts' defaults go in
`agent-service.conf` beside them: copy [`agent-service.conf.example`](./agent-service.conf.example).

What these scripts support, and what they do not yet:

- **Unraid** for the dispatcher, with the User Scripts plugin and Tailscale for the Funnel.
- **Ubuntu 24.04 on x64** for the box. The VM itself is made by hand in Unraid's VM form.
- **A registry token** to download the package at each install and upgrade, typed at a prompt.
- **One worker.**

These files are not part of the published package.
