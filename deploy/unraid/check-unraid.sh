#!/usr/bin/env bash
# check-unraid.sh: read-only checks of the Unraid half of the agent-workflows
# service orchestrator (the dispatcher container, the agentnet firewall, the
# Funnel). It changes no file or setting: it only reads them, and makes a few
# harmless requests (each door's /health, the box's job door, `node --version`
# in the container). It prints no secret and no log text: setting names, counts,
# and a fingerprint of the shared secret to compare with check-box.sh's.
#
# Self-contained on purpose, as check-box.sh is: each is copied alone to the
# machine it checks, so the helpers and shared addresses are repeated in both.
#
# Run as root on Unraid:  bash /boot/config/agent-service/check-unraid.sh
# Exits 1 when any check fails.
set -uo pipefail

# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$(dirname "$0")/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

APPDATA=${APPDATA:-/mnt/user/appdata/agent-dispatcher}
ENV_FILE=${ENV_FILE:-$APPDATA/service.env}
PKG_JSON=${PKG_JSON:-$APPDATA/pkg/node_modules/@jeffwlawson/agent-workflows/package.json}
CONTAINER=${CONTAINER:-agent-dispatcher}
PROTOTYPE_CONTAINER=${PROTOTYPE_CONTAINER:-agent-dispatcher-prototype}
FIREWALL_SCRIPT=${FIREWALL_SCRIPT:-/boot/config/plugins/user.scripts/scripts/agentnet-firewall/script}
CHAIN=${CHAIN:-AGENT-EGRESS}
BRIDGE=${BRIDGE:-virbr-agent}
VM=${VM:-agent-box}
NET=${NET:-agentnet}
HOST_IP=${HOST_IP:-192.168.250.1}
BOX_IP=${BOX_IP:-192.168.250.11}
WEBHOOK_PORT=${WEBHOOK_PORT:-8790}
TOKEN_PORT=${TOKEN_PORT:-8791}
JOBS_PORT=${JOBS_PORT:-8787}
FUNNEL_PORT=${FUNNEL_PORT:-10000}
# The container's user (Unraid's nobody:users), which alone may read the App's key.
CONTAINER_USER=${CONTAINER_USER:-99:100}
MIN_NODE=${MIN_NODE:-24.14.0}
REQUIRED_SETTINGS="GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY_FILE GITHUB_WEBHOOK_SECRET WORKER_URL WORKER_SECRET"

passed=0 warned=0 failed=0
pass() { printf '  PASS  %s\n' "$*"; passed=$((passed + 1)); }
warn() { printf '  WARN  %s\n' "$*"; warned=$((warned + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; failed=$((failed + 1)); }
section() { printf '\n== %s\n' "$*"; }
# The HTTP status of a request, or 000 where none came back.
status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true; }
# True where version $1 is at least $2.
at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root on Unraid." >&2
  exit 2
fi

section "The agentnet firewall"
rules=$(iptables -t mangle -S "$CHAIN" 2>/dev/null)
if [ -z "$rules" ]; then
  fail "the $CHAIN chain does not exist in the mangle table: run the agentnet-firewall User Script"
else
  pass "the $CHAIN chain exists"
  if iptables -t mangle -C PREROUTING -i "$BRIDGE" -j "$CHAIN" 2>/dev/null; then
    pass "traffic from $BRIDGE goes through $CHAIN"
  else
    fail "PREROUTING does not send $BRIDGE's traffic to $CHAIN"
  fi
  token_line=$(printf '%s\n' "$rules" | grep -n -- "-d $HOST_IP/32 -p tcp -m tcp --dport $TOKEN_PORT -j RETURN" | head -n1 | cut -d: -f1)
  first_drop=$(printf '%s\n' "$rules" | grep -n -- "-j DROP" | head -n1 | cut -d: -f1)
  if [ -z "$token_line" ]; then
    fail "no rule lets the box reach the token door, $HOST_IP:$TOKEN_PORT"
  elif [ -n "$first_drop" ] && [ "$token_line" -gt "$first_drop" ]; then
    fail "the token door's rule comes after a DROP, so it never matches"
  else
    pass "the box may reach the token door, $HOST_IP:$TOKEN_PORT, ahead of the drops"
  fi
  for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    if printf '%s\n' "$rules" | grep -q -- "-d $net -j DROP"; then
      pass "drops $net"
    else
      fail "does not drop $net"
    fi
  done
fi
if ip6tables -t mangle -C PREROUTING -i "$BRIDGE" -j DROP 2>/dev/null; then
  pass "drops all IPv6 from $BRIDGE"
else
  fail "IPv6 from $BRIDGE is not dropped"
fi
if [ ! -f "$FIREWALL_SCRIPT" ]; then
  fail "no agentnet-firewall script at $FIREWALL_SCRIPT"
else
  script_token=$(grep -n -- "-d $HOST_IP -p tcp --dport $TOKEN_PORT -j RETURN" "$FIREWALL_SCRIPT" | head -n1 | cut -d: -f1)
  script_drops=$(grep -n -- "-j DROP" "$FIREWALL_SCRIPT" | head -n1 | cut -d: -f1)
  if [ -z "$script_token" ]; then
    fail "the agentnet-firewall script lacks the token door's rule, so it is lost at the next reboot"
  elif [ -n "$script_drops" ] && [ "$script_token" -gt "$script_drops" ]; then
    fail "the agentnet-firewall script adds the token door's rule after its drops"
  else
    pass "the agentnet-firewall script keeps the token door's rule across reboots"
  fi
fi

section "The agent box VM"
state=$(virsh domstate "$VM" 2>/dev/null | head -n1)
if [ "$state" = "running" ]; then pass "$VM is running"; else fail "$VM is ${state:-unknown}"; fi
# Exactly `Autostart`: newer libvirt also prints an `Autostart Once` line.
autostart=$(virsh dominfo "$VM" 2>/dev/null | awk -F: '$1 == "Autostart" {gsub(/ /, "", $2); print $2}')
if [ "$autostart" = "disable" ]; then
  pass "$VM's own Autostart is off: the firewall script starts it, after the rules"
else
  fail "$VM's own Autostart is ${autostart:-unknown}: it could boot before the firewall rules are in"
fi
# The dispatcher sends jobs to $BOX_IP, so the box must get it every time: a
# reservation for its card, not the luck of being first to ask.
mac=$(virsh domiflist "$VM" 2>/dev/null | awk -v net="$NET" '$3 == net {print $5; exit}')
if [ -z "$mac" ]; then
  fail "$VM has no network card on $NET"
elif virsh net-dumpxml "$NET" 2>/dev/null | grep -q "<host mac='$mac'.*ip='$BOX_IP'"; then
  pass "$NET reserves $BOX_IP for $VM's card ($mac)"
else
  fail "$NET does not reserve $BOX_IP for $VM's card ($mac): a rebuilt VM or a second one could take another address (install-unraid.sh adds it)"
fi
code=$(status "http://$BOX_IP:$JOBS_PORT/health")
if [ "$code" = "200" ]; then pass "the worker's job door answers 200"; else fail "the worker's job door, http://$BOX_IP:$JOBS_PORT/health, answered $code"; fi

section "The dispatcher container"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  fail "no container named $CONTAINER"
else
  running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER")
  restart=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")
  network=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")
  cmd=$(docker inspect -f '{{join .Config.Cmd " "}}' "$CONTAINER")
  if [ "$running" = "true" ]; then pass "$CONTAINER is running"; else fail "$CONTAINER is not running"; fi
  if [ "$restart" = "unless-stopped" ] || [ "$restart" = "always" ]; then pass "it restarts on its own ($restart)"; else fail "its restart policy is '$restart': it will not come back after a reboot"; fi
  if [ "$network" = "host" ]; then pass "it uses the host network"; else fail "it is on the '$network' network, not host: libvirt's NAT network will not admit it"; fi
  user=$(docker inspect -f '{{.Config.User}}' "$CONTAINER")
  if [ "$user" = "$CONTAINER_USER" ]; then pass "it runs as $CONTAINER_USER, not root"; else fail "it runs as '${user:-root}', not $CONTAINER_USER: it is what the internet reaches, and holds the App's key (install-unraid.sh recreates it)"; fi
  case "$cmd" in
    *dist/cli.js\ dispatcher*) pass "it runs the installed package's dispatcher" ;;
    *) fail "its command is '$cmd', not the installed package's dispatcher" ;;
  esac
  names=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | cut -d= -f1)
  for name in $REQUIRED_SETTINGS; do
    if printf '%s\n' "$names" | grep -qx "$name"; then pass "it has $name"; else fail "it lacks $name: was it started with --env-file $ENV_FILE?"; fi
  done
  if [ "$running" = "true" ]; then
    node_version=$(docker exec "$CONTAINER" node --version 2>/dev/null | sed 's/^v//')
    if [ -n "$node_version" ] && at_least "$node_version" "$MIN_NODE"; then
      pass "its Node is $node_version"
    else
      fail "its Node is ${node_version:-unknown}, below $MIN_NODE"
    fi
  fi
fi
if docker inspect "$PROTOTYPE_CONTAINER" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$PROTOTYPE_CONTAINER")" = "true" ]; then
    fail "$PROTOTYPE_CONTAINER is running: it holds the same port as $CONTAINER"
  elif [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$PROTOTYPE_CONTAINER")" != "no" ]; then
    warn "$PROTOTYPE_CONTAINER is stopped but would restart at boot"
  else
    pass "$PROTOTYPE_CONTAINER is stopped and stays stopped"
  fi
fi

section "Its version"
installed=$(grep -m1 '"version"' "$PKG_JSON" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/')
# The log since the container last started, or nothing where that time cannot
# be read: an empty --since would read the whole log, earlier runs included.
started=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || true)
run_log() { [ -n "$started" ] && docker logs --since "$started" "$CONTAINER" 2>&1; }
running_version=$(run_log | sed -n 's/.*dispatcher \([0-9][0-9.]*\) listening.*/\1/p' | tail -n1)
if [ -z "$started" ]; then
  fail "cannot read when $CONTAINER last started, so neither its running version nor its log can be checked"
elif [ -z "$installed" ]; then
  fail "no package installed at $PKG_JSON"
elif [ "$installed" != "$running_version" ]; then
  fail "installed $installed, but the container last started ${running_version:-no} dispatcher: restart it"
else
  pass "installed and running: $installed"
fi
echo "  INFO  dispatcher version: ${running_version:-unknown} (the box's check prints the worker's: they must match)"

section "Its settings and the App's key"
if [ ! -f "$ENV_FILE" ]; then
  fail "no settings file at $ENV_FILE"
else
  perms=$(stat -c '%a %U' "$ENV_FILE")
  if [ "$perms" = "600 root" ]; then pass "$ENV_FILE is root's alone (600)"; else fail "$ENV_FILE is '$perms', not '600 root'"; fi
  for name in $REQUIRED_SETTINGS; do
    if grep -q "^$name=." "$ENV_FILE"; then pass "it sets $name"; else fail "it does not set $name, or sets it empty"; fi
  done
  if grep -qE "^[A-Za-z_][A-Za-z0-9_]*=[\"']" "$ENV_FILE"; then
    fail "a value is quoted: Docker keeps the quotes as part of the value"
  else
    pass "no value is quoted"
  fi
  # Docker reads --env-file when the container is created, not when it
  # restarts, so an edit to the file needs the container recreated. Compared
  # line for line; only the names of lines that differ are printed.
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    stale=$(grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" |
      grep -Fxv -f <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER") | cut -d= -f1 | tr '\n' ' ')
    if [ -z "$stale" ]; then
      pass "the container runs with exactly what $ENV_FILE says"
    else
      fail "the container's settings differ from $ENV_FILE for: $stale(recreate the container: a restart does not re-read the file)"
    fi
  fi
  fingerprint=$(grep '^WORKER_SECRET=' "$ENV_FILE" | sha256sum | cut -c1-16)
  echo "  INFO  shared secret fingerprint: $fingerprint (the box's check prints its own: they must match)"
fi
key="$APPDATA/app.pem"
if [ -f "$key" ] && [ "$(stat -c '%a %u' "$key")" = "600 ${CONTAINER_USER%%:*}" ]; then
  pass "the App's key is there, readable by the dispatcher's user alone"
else
  fail "the App's key at $key is missing, or not '600' and owned by uid ${CONTAINER_USER%%:*} ($(stat -c '%a uid %u' "$key" 2>/dev/null))"
fi

section "Its doors and the Funnel"
code=$(status "http://127.0.0.1:$WEBHOOK_PORT/health")
if [ "$code" = "200" ]; then pass "the webhook door answers 200"; else fail "the webhook door, 127.0.0.1:$WEBHOOK_PORT, answered $code"; fi
code=$(status "http://$HOST_IP:$TOKEN_PORT/health")
if [ "$code" = "200" ]; then pass "the token door answers 200"; else fail "the token door, $HOST_IP:$TOKEN_PORT, answered $code"; fi
funnel=$(tailscale funnel status 2>/dev/null)
if printf '%s\n' "$funnel" | grep -q ":$FUNNEL_PORT (Funnel on)" &&
  printf '%s\n' "$funnel" | grep -q "proxy http://127.0.0.1:$WEBHOOK_PORT"; then
  pass "the Funnel publishes :$FUNNEL_PORT to the webhook door"
else
  fail "the Funnel does not publish :$FUNNEL_PORT to 127.0.0.1:$WEBHOOK_PORT (Settings → Tailscale → Allow Tailscale Funnel must stay Yes)"
fi

section "Deliveries since the dispatcher started"
# A count and where to read them, never the lines: log text is not this
# script's to print.
count=$(run_log | grep -cE ': (failed|refused):' || true)
if [ -z "$started" ]; then
  warn "skipped: the container's start time could not be read"
elif [ "${count:-0}" -gt 0 ]; then
  warn "$count deliveries failed or were refused since the dispatcher started; read them with: docker logs --since $started $CONTAINER | grep -E ': (failed|refused):'"
else
  pass "no delivery failed or was refused since the dispatcher started"
fi

printf '\n%d passed, %d warnings, %d failed\n' "$passed" "$warned" "$failed"
[ "$failed" -eq 0 ]
