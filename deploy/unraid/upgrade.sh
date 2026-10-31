#!/usr/bin/env bash
# upgrade.sh <version>: move both machines of the Unraid deployment, the
# dispatcher on Unraid and the worker on the agent box, to <version>, then
# check both and compare them. Uses no registry and no token: the release's
# tarball is downloaded once, here, checked against its .sha256 and copied to
# the box, where it is checked again.
#
# upgrade-unraid.sh and upgrade-box.sh are its two halves, and each can still be
# run alone to recover or roll back one machine. This script is the only one
# that knows about ssh. In order:
#   1. stage: download and check the tarball, copy it and the box's scripts to
#      the box. No service is touched; a failure leaves both machines as they were.
#   2. install on the box, then on Unraid. Services are still untouched.
#   3. restart the worker, then straight after it the dispatcher, each waited for.
#   4. run both check scripts and compare their versions and fingerprints.
#
# The box is reached as BOX_SSH_USER@BOX_IP, with the key the operator has set
# up for it (BOX_SSH_KEY, or ssh's default). Host keys are kept beside this
# script, never under ~/.ssh, which Unraid does not let ssh write. Each ssh that
# runs sudo on the box asks for its password: the only prompt left.
#
# Run as root on Unraid:  bash /boot/config/agent-service/upgrade.sh 0.8.6
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$here/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

APPDATA=${APPDATA:-/mnt/user/appdata/agent-dispatcher}
STAGE_DIR=${STAGE_DIR:-/root}
BOX_SSH_USER=${BOX_SSH_USER:-}
BOX_SSH_KEY=${BOX_SSH_KEY:-}
BOX_IP=${BOX_IP:-}
PACKAGE_SOURCE=${PACKAGE_SOURCE:-}
PACKAGE_NAME=${PACKAGE_NAME:-}

refuse() {
  echo "$*" >&2
  echo "Nothing was changed on either machine." >&2
  exit 2
}

version=${1:-}
if [ $# -ne 1 ] || ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: bash $0 <version>, for example: bash $0 0.8.6" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then refuse "Run this as root on Unraid."; fi
for script in upgrade-unraid.sh upgrade-box.sh check-unraid.sh check-box.sh; do
  if [ ! -f "$here/$script" ]; then refuse "$script is not beside this script, in $here: copy it there first."; fi
done
if [ -z "$BOX_SSH_USER" ]; then refuse "Set BOX_SSH_USER in $conf: the box's admin account, which ssh logs in as and which may sudo."; fi
if [ -z "$BOX_IP" ]; then refuse "Set BOX_IP in $conf: the box's address on agentnet, which ssh reaches it at."; fi
if [ -n "$BOX_SSH_KEY" ] && [ ! -f "$BOX_SSH_KEY" ]; then refuse "BOX_SSH_KEY names $BOX_SSH_KEY, which is not there."; fi

# The installed package is the one the dispatcher's install prefix depends on,
# unless PACKAGE_NAME names it.
if [ -z "$PACKAGE_NAME" ]; then
  PACKAGE_NAME=$(tr -d '\n' <"$APPDATA/pkg/package.json" 2>/dev/null | sed -n 's/.*"dependencies": *{ *"\([^"]*\)".*/\1/p' || true)
fi
PKG_JSON=${PKG_JSON:-$APPDATA/pkg/node_modules/$PACKAGE_NAME/package.json}

# Where the release comes from: PACKAGE_SOURCE, or else the installed package's
# repository field, a string or {"url": ...}, in a github.com form only.
installed_json=$(tr -d '\n' <"$PKG_JSON" 2>/dev/null || true)
source=$PACKAGE_SOURCE
if [ -z "$source" ]; then
  repository=$(sed -n 's/.*"repository": *"\([^"]*\)".*/\1/p' <<<"$installed_json")
  if [ -z "$repository" ]; then
    repository=$(sed -n 's/.*"repository": *{[^}]*"url": *"\([^"]*\)".*/\1/p' <<<"$installed_json")
  fi
  repository=${repository#git+}
  repository=${repository%.git}
  case "$repository" in
    github:*) source=${repository#github:} ;;
    https://github.com/* | http://github.com/* | git://github.com/* | ssh://git@github.com/*) source=${repository#*github.com/} ;;
    git@github.com:*) source=${repository#git@github.com:} ;;
    */*) case "$repository" in *:*) ;; *) source=$repository ;; esac ;;
  esac
fi
if ! [[ $source =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  refuse "Cannot tell which repository the release is downloaded from: set PACKAGE_SOURCE=<owner>/<repo> in $conf (the installed package at $PKG_JSON names no github.com repository)."
fi
name=$PACKAGE_NAME
if ! [[ $name =~ ^(@[a-z0-9._~-]+/)?[a-z0-9._~-]+$ ]]; then
  refuse "Cannot tell the package's name: set PACKAGE_NAME in $conf (no package is installed in $APPDATA/pkg to read it from)."
fi
# The asset's name: the package name with its @ dropped and / made -.
tarball=${name#@}
tarball="${tarball//\//-}-$version.tgz"
url="https://github.com/$source/releases/download/v$version/$tarball"

box="$BOX_SSH_USER@$BOX_IP"
# Never under ~/.ssh: host keys go beside the conf, a first connect is
# recorded and a later change of key is refused.
ssh_opts=(-o "UserKnownHostsFile=$here/known_hosts" -o StrictHostKeyChecking=accept-new)
if [ -n "$BOX_SSH_KEY" ]; then ssh_opts+=(-i "$BOX_SSH_KEY"); fi
# The command is run by the box's shell, so its home's ~ is left to it.
on_box() { ssh "${ssh_opts[@]}" -t "$box" "$1"; }

echo "Moving both machines to $version, from $url"

echo
echo "== Staging: no service is touched"
stage=$(mktemp -d "$STAGE_DIR/agent-workflows-upgrade.XXXXXX")
trap 'rm -rf "$stage"' EXIT
if ! curl -fsSL -o "$stage/$tarball" "$url" || ! curl -fsSL -o "$stage/$tarball.sha256" "$url.sha256"; then
  refuse "Could not download $url and its .sha256: is v$version released, with its tarball attached?"
fi
read -r _ named <"$stage/$tarball.sha256" || true
if [ "${named#\*}" != "$tarball" ] || ! (cd "$stage" && sha256sum -c --quiet "$tarball.sha256"); then
  refuse "The downloaded $tarball does not match its .sha256."
fi
echo "Downloaded $tarball; it matches its .sha256."
to_copy=("$stage/$tarball" "$stage/$tarball.sha256" "$here/upgrade-box.sh" "$here/check-box.sh")
if [ -f "$conf" ]; then to_copy+=("$conf"); fi
if ! scp "${ssh_opts[@]}" "${to_copy[@]}" "$box:"; then
  refuse "Could not copy the tarball and the box's scripts to $box."
fi
echo "Copied the tarball, upgrade-box.sh, check-box.sh and agent-service.conf to $box's home."

echo
echo "== Installing: both machines keep running what they started with"
if ! on_box "sudo bash ~/upgrade-box.sh --install $version ~/$tarball"; then
  echo "The install on the box stopped: read its output above. Unraid was not changed, and the box's worker was not restarted." >&2
  exit 1
fi
if ! bash "$here/upgrade-unraid.sh" --install "$version" "$stage/$tarball"; then
  echo "The install on Unraid stopped: read its output above. The box has $version installed but its worker was not restarted; restart it onto the version Unraid runs with upgrade-box.sh." >&2
  exit 1
fi
on_box "rm -f ~/$tarball ~/$tarball.sha256" || true

echo
echo "== Restarting: the worker, then the dispatcher"
echo "Restarting the worker drops any job queued in it: its queue is in memory."
status=0
on_box "sudo bash ~/upgrade-box.sh --restart $version" || status=1
worker_up=$SECONDS
bash "$here/upgrade-unraid.sh" --restart "$version" || status=1
window=$((SECONDS - worker_up))
echo "Between the two restarts the dispatcher got 409 from the worker, for about $window seconds: the two ran different versions."

echo
echo "== Checking both"
# Each check's output is shown as it runs and kept to be compared. The box's
# comes through a terminal, so its lines end in a carriage return.
unraid_out="$stage/check-unraid.out"
box_out="$stage/check-box.out"
bash "$here/check-unraid.sh" | tee "$unraid_out" || status=1
on_box "sudo bash ~/check-box.sh" | tee "$box_out" || status=1
info() { tr -d '\r' <"$1" | sed -n "s/.*INFO  $2: \([^ ]*\).*/\1/p" | tail -n1; }
dispatcher_version=$(info "$unraid_out" "dispatcher version")
worker_version=$(info "$box_out" "worker version")
unraid_fingerprint=$(info "$unraid_out" "shared secret fingerprint")
box_fingerprint=$(info "$box_out" "shared secret fingerprint")

echo
echo "dispatcher version:        ${dispatcher_version:-unknown}"
echo "worker version:            ${worker_version:-unknown}"
echo "Unraid secret fingerprint: ${unraid_fingerprint:-unknown}"
echo "box secret fingerprint:    ${box_fingerprint:-unknown}"
problems=()
if [ "$dispatcher_version" != "$version" ] || [ "$worker_version" != "$version" ]; then
  problems+=("the dispatcher runs ${dispatcher_version:-unknown} and the worker ${worker_version:-unknown}, not both $version")
fi
if [ -z "$unraid_fingerprint" ] || [ "$unraid_fingerprint" != "$box_fingerprint" ]; then
  problems+=("the shared secret's fingerprints differ (${unraid_fingerprint:-unknown} on Unraid, ${box_fingerprint:-unknown} on the box)")
fi
if [ "$status" -ne 0 ]; then problems+=("a restart or a check failed: read its output above"); fi
if [ ${#problems[@]} -gt 0 ]; then
  for problem in "${problems[@]}"; do echo "FAILED: $problem." >&2; done
  exit 1
fi
echo "Both machines run $version and share the secret."
