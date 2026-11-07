#!/usr/bin/env bash
# fleet-check.sh: doctor for every repository the service serves (#825), read
# on Unraid. It runs the package's fleet-check subcommand in the dispatcher's
# container, which prints, for every repository of every installation the
# dispatcher serves, one line: its name and `ok`, or its counts of errors and
# warnings with each finding indented below it; "not on the service" for one
# whose AGENT_ORCHESTRATOR is not `service`; or why it could not be read.
#
# Read-only. The check runs with the dispatcher's own settings, already set in
# its container (the App's ID, its key's file and EXTRA_OWNERS), so the key is
# never printed, written or put on a command line, and every token it mints
# reads and nothing else. It changes no file, container or setting.
#
# Run it after every upgrade, beside the setup check: see "The upgrade
# routine" in docs/deploying-the-service.md.
#
# Self-contained on purpose, as status.sh is.
#
# Run as root on Unraid:  bash /boot/config/agent-service/fleet-check.sh
# It takes no argument. Exits 0 where every repository was read and none has
# an error; 1 where one has an error, one could not be read, the dispatcher's
# container is not running, or the check could not be run in it; and 2 where
# it is given an argument or is not run as root.
set -uo pipefail

# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$(dirname "$0")/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

CONTAINER=${CONTAINER:-agent-dispatcher}
# The CLI the dispatcher's container runs, as dispatcher-container.sh starts it.
CLI=/app/pkg/node_modules/@jeffwlawson/agent-workflows/dist/cli.js

usage="Usage: bash $0"
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      sed -n '2,/^set /{/^set /d;s/^# \{0,1\}//;p}' "$0"
      exit 0
      ;;
    *)
      echo "fleet-check.sh takes no argument, but got '$arg': it checks every repository the dispatcher serves. $usage" >&2
      exit 2
      ;;
  esac
done
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root on Unraid: it asks docker to run the check in $CONTAINER. $usage" >&2
  exit 2
fi

if ! state=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null); then
  echo "Cannot check: docker has no container named $CONTAINER, or docker does not answer." >&2
  exit 1
fi
if [ "$state" != "running" ]; then
  echo "Cannot check: $CONTAINER is $state, not running, and the check runs in it with its settings." >&2
  exit 1
fi

docker exec "$CONTAINER" node "$CLI" fleet-check
code=$?
case "$code" in
  0 | 1) exit "$code" ;;
  *)
    echo "The check could not be run in $CONTAINER (it ended with $code): see above." >&2
    exit 1
    ;;
esac
