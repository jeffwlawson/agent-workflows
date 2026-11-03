#!/usr/bin/env bash
# upgrade-unraid.sh [--install | --restart] <version> [<tarball>]: move the
# agent-workflows dispatcher on Unraid to <version>, from a release's tarball.
# Installs the tarball into the dispatcher's appdata with a throwaway container
# and restarts the container, or recreates it where it differs from what
# install-unraid.sh would make (#691), with the same drift check and create step
# (dispatcher-container.sh). Its key, firewall and settings are left as they
# are, except that a service.env with no STATE_FILE gains the one line the
# install writes. It asks for no secret. Also moves it back: name the earlier
# version and its tarball.
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

# The container's settings, its drift check and its create step, shared with
# install-unraid.sh.
shared="$(dirname "$0")/dispatcher-container.sh"
if [ ! -f "$shared" ]; then
  echo "dispatcher-container.sh is not beside this script ($shared): copy it here first. Nothing was changed." >&2
  exit 2
fi
# shellcheck source=dispatcher-container.sh
. "$shared"
PKG_JSON=${PKG_JSON:-$APPDATA/pkg/node_modules/@jeffwlawson/agent-workflows/package.json}
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

# Docker reads --env-file when it creates a container, and a restart keeps its
# mounts: so a container that differs from what install-unraid.sh would make,
# such as one made before the state file (#618) with no writable /state, is
# recreated, and one that does not is restarted.
if [ ! -f "$ENV_FILE" ]; then
  echo "No settings at $ENV_FILE: run install-unraid.sh $version, which makes them. Stopping before the restart." >&2
  exit 1
fi
if ! grep -q '^STATE_FILE=' "$ENV_FILE"; then
  # A last line with no newline would otherwise run into the added one.
  if [ -n "$(tail -c1 "$ENV_FILE")" ]; then echo >>"$ENV_FILE"; fi
  printf '%s\n' "$DISPATCHER_STATE_LINE" >>"$ENV_FILE"
  echo "  added      $DISPATCHER_STATE_LINE to $ENV_FILE, so the dispatcher keeps its jobs and scan counts across a restart"
fi
dispatcher_state_dir
wrong=$(dispatcher_drift | paste -sd, -)
if [ -z "$wrong" ]; then
  echo "Restarting $CONTAINER ..."
  docker restart "$CONTAINER" >/dev/null
else
  echo "Recreating $CONTAINER, as install-unraid.sh makes it ..."
  dispatcher_create "$wrong"
fi
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
