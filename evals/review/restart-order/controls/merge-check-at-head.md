---
source: >-
  PR #577, the maintainer's pre-merge check at edb772f (this case's head), which found 01 and 02: https://github.com/jeffwlawson/agent-workflows/pull/577#pullrequestreview-5725499750, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
  "02": pass
  "05": fail
---

Pre-merge check: merge-ready apart from the Medium below, which I'd like fixed before the first real use. Verify passes (5537 tests) and shellcheck is clean. A no-token download of the real v0.9.3 passes its checksum, and both halves refuse a corrupt tarball before installing.

Two more Low items with no line of their own:
- **Partial copy:** if the copy to the box fails partway, the message still says "Nothing was changed", though the conf and scripts in the admin's home may already be overwritten. Say what was copied.
- **Stray error:** lines 62 and 68 print a "No such file" error when no package is installed yet. Silence it, or say "none installed".

## Inline comments

### On `deploy/unraid/upgrade.sh`

**Medium: a failed worker restart still restarts the dispatcher.** If the box's restart fails (a mistyped `sudo` password is enough), the dispatcher restarts anyway. That leaves the two on different versions, every job gets a 409, and nothing tells the operator how to recover. Stop before restarting the dispatcher, and print the exact commands that finish the job on each side (e.g. the `--restart` invocations, with the version).

### On `deploy/unraid/upgrade.sh`

**Low: the recovery advice can't work as written.** If the Unraid install fails, this tells the operator to restart the box with `upgrade-box.sh`. Rolling the box back needs the old version's tarball, which isn't on the box. Either keep the previous tarball staged, or name the real way back.

### On `deploy/unraid/upgrade.sh`

**Low: the download can follow a redirect to http.** `curl -L` would follow an https-to-http redirect. Add `--proto '=https' --proto-redir '=https'`. The checksum still guards the tarball, but the `.sha256` comes over the same connection.
