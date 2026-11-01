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
#      Where the worker's fails, the dispatcher is left alone. A step that
#      stops prints the commands that finish the job, or the way back.
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
# Neither file is there before the first install, which is not an error here:
# the refusals below say what to set instead.
if [ -z "$PACKAGE_NAME" ] && [ -f "$APPDATA/pkg/package.json" ]; then
  PACKAGE_NAME=$(tr -d '\n' <"$APPDATA/pkg/package.json" | sed -n 's/.*"dependencies": *{ *"\([^"]*\)".*/\1/p' || true)
fi
PKG_JSON=${PKG_JSON:-$APPDATA/pkg/node_modules/$PACKAGE_NAME/package.json}

# Where the release comes from: PACKAGE_SOURCE, or else the installed package's
# repository field, a string or {"url": ...}, in a github.com form only.
installed_json= previous=
if [ -f "$PKG_JSON" ]; then
  installed_json=$(tr -d '\n' <"$PKG_JSON")
  # What the dispatcher has installed now: the way back, if this stops partway.
  # Read as the halves read it.
  previous=$(grep -m1 '"version"' "$PKG_JSON" | sed 's/.*"version": *"\([^"]*\)".*/\1/' || true)
fi
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
  refuse "Cannot tell which repository the release is downloaded from: set PACKAGE_SOURCE=<owner>/<repo> in $conf (no package is installed at $PKG_JSON, or it names no github.com repository)."
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
# The same ssh, spelt out for an operator to paste when a step stops.
box_ssh=$(printf '%q ' ssh "${ssh_opts[@]}" -t "$box")
# The way back, should a step stop partway: this script at the version the
# dispatcher had, which installs it on the box first.
back="bash $here/upgrade.sh ${previous:-<the version the dispatcher runs>}"

echo "Moving both machines to $version, from $url"

echo
echo "== Staging: no service is touched"
stage=$(mktemp -d "$STAGE_DIR/agent-workflows-upgrade.XXXXXX")
trap 'rm -rf "$stage"' EXIT
# https only, redirects too: the .sha256 comes over the same connection.
download() { curl -fsSL --proto '=https' --proto-redir '=https' -o "$1" "$2"; }
if ! download "$stage/$tarball" "$url" || ! download "$stage/$tarball.sha256" "$url.sha256"; then
  refuse "Could not download $url and its .sha256: is v$version released, with its tarball attached?"
fi
read -r _ named <"$stage/$tarball.sha256" || true
if [ "${named#\*}" != "$tarball" ] || ! (cd "$stage" && sha256sum -c --quiet "$tarball.sha256"); then
  refuse "The downloaded $tarball does not match its .sha256."
fi
echo "Downloaded $tarball; it matches its .sha256."
to_copy=("$stage/$tarball" "$stage/$tarball.sha256" "$here/upgrade-box.sh" "$here/check-box.sh")
if [ -f "$conf" ]; then to_copy+=("$conf"); fi
copied=$(for file in "${to_copy[@]}"; do basename "$file"; done | paste -sd ' ')
if ! scp "${ssh_opts[@]}" "${to_copy[@]}" "$box:"; then
  # scp copies one file at a time, so a failure can come after some of them.
  echo "Could not copy all of $copied to $box's home: read scp's output above." >&2
  echo "Some may already be there, replacing the copies the box had. Nothing was installed and no service was touched on either machine." >&2
  exit 2
fi
echo "Copied $copied to $box's home."

echo
echo "== Installing: both machines keep running what they started with"
if ! on_box "sudo bash ~/upgrade-box.sh --install $version ~/$tarball"; then
  echo "The install on the box stopped: read its output above. Unraid was not changed, and neither service was restarted." >&2
  echo "The box's install may have stopped partway. Fix the cause and run upgrade.sh $version again, or put the box back with: $back" >&2
  exit 1
fi
if ! bash "$here/upgrade-unraid.sh" --install "$version" "$stage/$tarball"; then
  echo "The install on Unraid stopped: read its output above. Neither service was restarted, so both still run what they ran." >&2
  echo "The box has $version installed, which its worker would start on its next restart. Fix the cause and run upgrade.sh $version again, or put the box back with: $back" >&2
  exit 1
fi
on_box "rm -f ~/$tarball ~/$tarball.sha256" || true

echo
echo "== Restarting: the worker, then the dispatcher"
echo "Restarting the worker drops any job queued in it: its queue is in memory."
status=0
if ! on_box "sudo bash ~/upgrade-box.sh --restart $version"; then
  # Restarting the dispatcher now would leave the two on different versions
  # for as long as the worker is not fixed, with every job refused.
  echo "The worker's restart did not finish, so the dispatcher was not restarted: read its output above (a mistyped sudo password is enough)." >&2
  echo "Both machines have $version installed. The dispatcher still runs what it ran; the worker may run either, and if it runs $version it refuses the dispatcher's jobs with 409." >&2
  echo "Fix the cause, then finish on each side, in this order, both run on Unraid:" >&2
  echo "  ${box_ssh}'sudo bash ~/upgrade-box.sh --restart $version'" >&2
  echo "  bash $here/upgrade-unraid.sh --restart $version" >&2
  echo "Then check both: bash $here/check-unraid.sh, and ${box_ssh}'sudo bash ~/check-box.sh'. Or run upgrade.sh $version again, which does all of it." >&2
  exit 1
fi
worker_up=$SECONDS
if bash "$here/upgrade-unraid.sh" --restart "$version"; then
  window=$((SECONDS - worker_up))
  echo "Between the two restarts the dispatcher got 409 from the worker, for about $window seconds: the two ran different versions."
else
  status=1
  echo "The dispatcher's restart did not finish: read its output above. The worker runs $version, so until the dispatcher does too it refuses the dispatcher's jobs with 409." >&2
  echo "Fix the cause, then finish on Unraid: bash $here/upgrade-unraid.sh --restart $version" >&2
fi

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
