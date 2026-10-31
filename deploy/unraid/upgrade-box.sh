#!/usr/bin/env bash
# upgrade-box.sh [--install | --restart] <version> [<tarball>]: move the
# agent-workflows worker on the agent box to <version>, from a release's
# tarball. Installs the tarball into /opt and restarts the agent-worker
# service; its settings, tinyproxy and the egress rule are left as they are.
# Also moves it back: name the earlier version and its tarball.
#
# The half of upgrade.sh that runs on the box, which copies the tarball here
# and calls the two phases apart so both machines restart back to back. Run
# alone it does both, then runs check-box.sh:
#   (no flag)  <version> <tarball>  install, restart, check
#   --install  <version> <tarball>  install only: the running worker is not touched
#   --restart  <version>            restart onto the installed <version>, and wait for it
#
# <tarball> is the release's asset, with its <tarball>.sha256 beside it (see
# "Installing the package" in docs/deploying-the-service.md); the digest is
# checked before anything is installed. No registry and no token are used, and
# the worker itself never fetches the package.
#
# Run on the box:  sudo bash ~/upgrade-box.sh 0.8.6 ~/<tarball>
set -euo pipefail

# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$(dirname "$0")/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

PREFIX=${PREFIX:-/opt/agent-workflows}
PKG_JSON=${PKG_JSON:-$PREFIX/node_modules/@jeffwlawson/agent-workflows/package.json}
UNIT=${UNIT:-agent-worker}
# The worker installs the agent's CLI at each start, so give it a while.
WAIT_SECONDS=${WAIT_SECONDS:-180}

phase=all
case "${1:-}" in
  --install) phase=install; shift ;;
  --restart) phase=restart; shift ;;
esac
version=${1:-}
tarball=${2:-}
usage() {
  echo "Usage: sudo bash $0 [--install] <version> <tarball>, or sudo bash $0 --restart <version>" >&2
  echo "For example: sudo bash $0 0.8.6 ~/<tarball>" >&2
  exit 2
}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then usage; fi
if [ "$phase" = restart ] && [ -n "$tarball" ]; then usage; fi
if [ "$phase" != restart ] && [ -z "$tarball" ]; then usage; fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash $0 $*" >&2
  exit 2
fi
# Refuse before changing anything: the check script must be beside this one,
# and the tarball must match the digest beside it. It is checked again here
# because it travelled from Unraid to a root install.
check_script="$(dirname "$0")/check-box.sh"
if [ "$phase" = all ] && [ ! -f "$check_script" ]; then
  echo "check-box.sh is not beside this script ($check_script): copy it here first. Nothing was changed." >&2
  exit 2
fi
installed() { grep -m1 '"version"' "$PKG_JSON" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/'; }

if [ "$phase" != restart ]; then
  tarball_dir=$(cd "$(dirname "$tarball")" && pwd)
  tarball_name=$(basename "$tarball")
  digest="$tarball_dir/$tarball_name.sha256"
  if [ ! -f "$tarball_dir/$tarball_name" ] || [ ! -f "$digest" ]; then
    echo "$tarball and its .sha256 must both be there. Nothing was changed." >&2
    exit 2
  fi
  # The digest must name this tarball: sha256sum -c checks whatever file it names.
  read -r _ named <"$digest" || true
  if [ "${named#\*}" != "$tarball_name" ] || ! (cd "$tarball_dir" && sha256sum -c --quiet "$tarball_name.sha256"); then
    echo "$tarball does not match its .sha256. Nothing was changed." >&2
    exit 1
  fi

  echo "Installed now: $(installed). Moving to $version."
  echo "Installing $tarball_name into $PREFIX ..."
  npm install --prefix "$PREFIX" --no-fund --no-audit --no-update-notifier "$tarball_dir/$tarball_name"
fi

if [ "$(installed)" != "$version" ]; then
  echo "$PKG_JSON says $(installed), not $version. Stopping before the restart." >&2
  exit 1
fi
if [ "$phase" = install ]; then
  echo "Installed $version; the worker still runs what it started with until it is restarted."
  exit 0
fi

echo "Restarting $UNIT: any job queued in it is dropped, since its queue is in memory ..."
systemctl restart "$UNIT"
# Read whole, then searched: grep -q on a pipe can end it early, and under
# pipefail that reads as no match. -F: the version's dots are not wildcards.
# The invocation is read again each pass: a start that crashes and is
# restarted (Restart=always) logs under a new one.
ready=
for _ in $(seq 1 "$WAIT_SECONDS"); do
  invocation=$(systemctl show -p InvocationID --value "$UNIT")
  log=$(journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$invocation" 2>/dev/null || true)
  if grep -qF "worker $version listening" <<<"$log"; then
    ready=1
    echo "The worker $version is listening."
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "The worker did not say it was listening at $version within $WAIT_SECONDS seconds. Its log: journalctl -u $UNIT -n 30" >&2
  status=1
fi
if [ "$phase" = restart ]; then exit "${status:-0}"; fi

echo
bash "$check_script" || status=${status:-$?}
echo
echo "Now make sure Unraid's dispatcher is on $version too (upgrade-unraid.sh $version, or"
echo "upgrade.sh for both): until both match, the worker refuses the dispatcher's jobs."
exit "${status:-0}"
