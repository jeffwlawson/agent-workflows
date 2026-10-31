#!/usr/bin/env bash
# upgrade-unraid.sh <version>: move the agent-workflows dispatcher on Unraid to
# <version>, then run check-unraid.sh. Installs the package into the
# dispatcher's appdata with a throwaway container and restarts the container;
# its settings, key and firewall are left as they are. Also moves it back:
# name the earlier version.
#
# Needs a classic GitHub token with read:packages only, typed at a prompt that
# does not echo it. The token is held in a file under /root (in memory on
# Unraid) for the install and removed however the script ends. Delete the
# token on GitHub afterwards.
#
# Run as root on Unraid:  bash /boot/config/agent-service/upgrade-unraid.sh 0.8.6
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

version=${1:-}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: bash $0 <version>, for example: bash $0 0.8.6" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root on Unraid." >&2
  exit 2
fi
# Refuse before changing anything: the check script must be beside this one,
# and the token prompt needs a terminal.
check_script="$(dirname "$0")/check-unraid.sh"
if [ ! -f "$check_script" ]; then
  echo "check-unraid.sh is not beside this script ($check_script): copy it here first. Nothing was changed." >&2
  exit 2
fi
if ! : </dev/tty 2>/dev/null; then
  echo "This asks for a token at a prompt, so it needs a terminal (over ssh, use ssh -t). Nothing was changed." >&2
  exit 2
fi
installed() { grep -m1 '"version"' "$PKG_JSON" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/'; }

echo "Installed now: $(installed). Moving to $version."

npmrc=$(umask 077 && mktemp /root/agent-workflows-npmrc.XXXXXX)
trap 'rm -f "$npmrc"' EXIT
read -rsp 'GitHub token (read:packages; not shown): ' token </dev/tty
echo
printf '@jeffwlawson:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$token" >"$npmrc"
unset token

echo "Installing @jeffwlawson/agent-workflows@$version into $APPDATA/pkg ..."
docker run --rm -v "$APPDATA/pkg:/pkg" -v "$npmrc:/tmp/pkg.npmrc:ro" "$IMAGE" \
  npm install --prefix /pkg --userconfig /tmp/pkg.npmrc --no-fund --no-audit --no-update-notifier \
  "@jeffwlawson/agent-workflows@$version"
rm -f "$npmrc"

if [ "$(installed)" != "$version" ]; then
  echo "The install finished but $PKG_JSON says $(installed), not $version. Stopping before the restart." >&2
  exit 1
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

echo
bash "$check_script" || status=${status:-$?}
echo
echo "Now: delete the token on GitHub, and move the box to the same version"
echo "(sudo bash ~/upgrade-box.sh $version): until both match, the worker refuses the dispatcher's jobs."
exit "${status:-0}"
