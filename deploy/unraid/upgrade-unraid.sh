#!/usr/bin/env bash
# upgrade-unraid.sh [--install | --restart] <version> [<tarball>]: move the
# agent-workflows dispatcher on Unraid to <version>, from a release's tarball.
# Installs the tarball into the dispatcher's appdata with a throwaway container
# and restarts the container; its settings, key and firewall are left as they
# are. Also moves it back: name the earlier version and its tarball.
#
# The half of upgrade.sh that runs on Unraid, which calls its two phases apart
# so both machines restart back to back. Run alone it does both, then runs
# check-unraid.sh:
#   (no flag)  <version> <tarball>  install, restart, check
#   --install  <version> <tarball>  install only: the running dispatcher is not touched
#   --restart  <version>            restart onto the installed <version>, and wait for it
#
# <tarball> is the release's asset, with its <tarball>.sha256 beside it (see
# "Installing the package" in docs/deploying-the-service.md); the digest is
# checked before anything is installed. No registry and no token are used.
#
# Run as root on Unraid:
#   bash /boot/config/agent-service/upgrade-unraid.sh 0.8.6 /root/<tarball>
set -euo pipefail

# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$(dirname "$0")/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

APPDATA=${APPDATA:-/mnt/user/appdata/agent-dispatcher}
PKG_JSON=${PKG_JSON:-$APPDATA/pkg/node_modules/@jeffwlawson/agent-workflows/package.json}
CONTAINER=${CONTAINER:-agent-dispatcher}
IMAGE=${IMAGE:-node:24-alpine}
WAIT_SECONDS=${WAIT_SECONDS:-60}

phase=all
case "${1:-}" in
  --install) phase=install; shift ;;
  --restart) phase=restart; shift ;;
esac
version=${1:-}
tarball=${2:-}
usage() {
  echo "Usage: bash $0 [--install] <version> <tarball>, or bash $0 --restart <version>" >&2
  echo "For example: bash $0 0.8.6 /root/<tarball>" >&2
  exit 2
}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then usage; fi
if [ "$phase" = restart ] && [ -n "$tarball" ]; then usage; fi
if [ "$phase" != restart ] && [ -z "$tarball" ]; then usage; fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root on Unraid." >&2
  exit 2
fi
# Refuse before changing anything: the check script must be beside this one,
# and the tarball must match the digest beside it.
check_script="$(dirname "$0")/check-unraid.sh"
if [ "$phase" = all ] && [ ! -f "$check_script" ]; then
  echo "check-unraid.sh is not beside this script ($check_script): copy it here first. Nothing was changed." >&2
  exit 2
fi
installed() { grep -m1 '"version"' "$PKG_JSON" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/' || true; }

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

  now=$(installed)
  echo "Installed now: ${now:-none}. Moving to $version."
  echo "Installing $tarball_name into $APPDATA/pkg ..."
  docker run --rm -v "$APPDATA/pkg:/pkg" -v "$tarball_dir:/release:ro" "$IMAGE" \
    npm install --prefix /pkg --no-fund --no-audit --no-update-notifier "/release/$tarball_name"
fi

now=$(installed)
if [ -z "$now" ]; then
  echo "Nothing is installed at $PKG_JSON, where $version should be. Stopping before the restart." >&2
  exit 1
elif [ "$now" != "$version" ]; then
  echo "$PKG_JSON says $now, not $version. Stopping before the restart." >&2
  exit 1
fi
if [ "$phase" = install ]; then
  echo "Installed $version; the dispatcher still runs what it started with until it is restarted."
  exit 0
fi

echo "Restarting $CONTAINER ..."
docker restart "$CONTAINER" >/dev/null
# Read whole, then searched: grep -q on a pipe can end it early, and under
# pipefail that reads as no match. -F: the version's dots are not wildcards.
ready=
for _ in $(seq 1 "$WAIT_SECONDS"); do
  started=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null) || { sleep 1; continue; }
  log=$(docker logs --since "$started" "$CONTAINER" 2>&1 || true)
  if grep -qF "dispatcher $version listening" <<<"$log"; then
    ready=1
    echo "The dispatcher $version is listening."
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "The dispatcher did not say it was listening at $version within $WAIT_SECONDS seconds. Its log: docker logs --tail 20 $CONTAINER" >&2
  status=1
fi
if [ "$phase" = restart ]; then exit "${status:-0}"; fi

echo
bash "$check_script" || status=${status:-$?}
echo
echo "Now move the box to the same version (upgrade-box.sh $version <tarball>, or upgrade.sh for both):"
echo "until both match, the worker refuses the dispatcher's jobs."
exit "${status:-0}"
