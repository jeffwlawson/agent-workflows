#!/usr/bin/env bash
# upgrade-box.sh <version>: move the agent-workflows worker on the agent box to
# <version>, then run check-box.sh. Installs the package into /opt and
# restarts the agent-worker service; its settings, tinyproxy and the egress
# rule are left as they are. Also moves it back: name the earlier version.
#
# Needs a classic GitHub token with read:packages only, typed at a prompt that
# does not echo it. The token is held in a root-only temporary file for the
# install and removed however the script ends. Delete the token on GitHub
# afterwards. The install runs as root, which the box's egress rule does not
# limit; the worker itself never reaches the package registry.
#
# Run on the box:  sudo bash ~/upgrade-box.sh 0.8.6
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

version=${1:-}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: sudo bash $0 <version>, for example: sudo bash $0 0.8.6" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash $0 $version" >&2
  exit 2
fi
# Refuse before changing anything: the check script must be beside this one,
# and the token prompt needs a terminal.
check_script="$(dirname "$0")/check-box.sh"
if [ ! -f "$check_script" ]; then
  echo "check-box.sh is not beside this script ($check_script): copy it here first. Nothing was changed." >&2
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

echo "Installing @jeffwlawson/agent-workflows@$version into $PREFIX ..."
npm install --prefix "$PREFIX" --userconfig "$npmrc" --no-fund --no-audit --no-update-notifier \
  "@jeffwlawson/agent-workflows@$version"
rm -f "$npmrc"

if [ "$(installed)" != "$version" ]; then
  echo "The install finished but $PKG_JSON says $(installed), not $version. Stopping before the restart." >&2
  exit 1
fi

echo "Restarting $UNIT ..."
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

echo
bash "$check_script" || status=${status:-$?}
echo
echo "Now: delete the token on GitHub, and make sure Unraid's dispatcher is on $version too"
echo "(bash /boot/config/agent-service/upgrade-unraid.sh $version)."
exit "${status:-0}"
