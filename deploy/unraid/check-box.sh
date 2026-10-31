#!/usr/bin/env bash
# check-box.sh: read-only checks of the agent box, the VM that runs the
# agent-workflows service worker (its egress rule, tinyproxy, the sandbox, the
# worker). It changes no file or setting: it only reads them, and makes a few
# harmless probes (a throwaway bwrap sandbox as the worker's user; requests to
# the job and token doors, api.github.com and example.com). It prints no secret
# and no log text: setting names, counts, and a fingerprint of the shared
# secret to compare with check-unraid.sh's.
#
# Self-contained on purpose, as check-unraid.sh is: each is copied alone to the
# machine it checks, so the helpers and shared addresses are repeated in both.
#
# Run on the box, as root:  sudo bash check-box.sh
# Exits 1 when any check fails.
set -uo pipefail

# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$(dirname "$0")/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

WORKER_USER=${WORKER_USER:-worker}
ENV_FILE=${ENV_FILE:-/etc/agent-worker/worker.env}
WORK_DIR=${WORK_DIR:-/var/lib/agent-worker}
PKG_JSON=${PKG_JSON:-/opt/agent-workflows/node_modules/@jeffwlawson/agent-workflows/package.json}
NODE=${NODE:-/usr/local/bin/node}
PROXY=${PROXY:-http://127.0.0.1:3128}
TINYPROXY_CONF=${TINYPROXY_CONF:-/etc/tinyproxy/tinyproxy.conf}
HOST_IP=${HOST_IP:-192.168.250.1}
BOX_IP=${BOX_IP:-192.168.250.11}
TOKEN_PORT=${TOKEN_PORT:-8791}
JOBS_PORT=${JOBS_PORT:-8787}
MIN_NODE=${MIN_NODE:-24.14.0}
REQUIRED_SETTINGS="WORKER_SECRET DISPATCHER_TOKEN_URL CLAUDE_CODE_VERSION CLAUDE_CODE_OAUTH_TOKEN WORK_DIR JOBS_HOST WORKER_PROXY AGENT_SANDBOX_PROXY"
# What tinyproxy must let through: the model's API, GitHub, the npm registry, the
# token door. Each as the line the Filter file holds, a regex anchored at both ends.
ALLOWED_HOSTS="^api\\.anthropic\\.com\$ ^github\\.com\$ ^api\\.github\\.com\$ ^codeload\\.github\\.com\$ ^objects\\.githubusercontent\\.com\$ ^raw\\.githubusercontent\\.com\$ ^release-assets\\.githubusercontent\\.com\$ ^registry\\.npmjs\\.org\$ ^${HOST_IP//./\\.}\$"

passed=0 warned=0 failed=0
pass() { printf '  PASS  %s\n' "$*"; passed=$((passed + 1)); }
warn() { printf '  WARN  %s\n' "$*"; warned=$((warned + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; failed=$((failed + 1)); }
section() { printf '\n== %s\n' "$*"; }
# The HTTP status of a request, or 000 where none came back.
status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true; }
# A request made as the worker's user, through the proxy, the way the worker
# makes it: "<proxy's answer to CONNECT>/<the request's status>".
as_worker_via_proxy() {
  runuser -u "$WORKER_USER" -- curl -sS -p -x "$PROXY" -o /dev/null -w '%{http_connect}/%{http_code}' --max-time 10 "$1" 2>/dev/null || true
}
# True where version $1 is at least $2.
at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash $0" >&2
  exit 2
fi
if ! uid=$(id -u "$WORKER_USER" 2>/dev/null); then
  echo "There is no '$WORKER_USER' user on this machine." >&2
  exit 2
fi

section "The toolchain"
node_version=$("$NODE" --version 2>/dev/null | sed 's/^v//')
if [ -n "$node_version" ] && at_least "$node_version" "$MIN_NODE"; then
  pass "Node is $node_version"
else
  fail "Node at $NODE is ${node_version:-missing}, below $MIN_NODE: the worker will not start"
fi
for tool in git npm bwrap curl; do
  if command -v "$tool" >/dev/null; then pass "$tool is installed"; else fail "$tool is missing"; fi
done
if runuser -u "$WORKER_USER" -- bwrap --unshare-all --share-net --die-with-parent --ro-bind / / --dev /dev --proc /proc /bin/true 2>/dev/null; then
  pass "$WORKER_USER can start a bwrap sandbox"
else
  fail "$WORKER_USER cannot start a bwrap sandbox: is the AppArmor profile for bwrap (/etc/apparmor.d/bwrap) loaded?"
fi

# Nothing outside its own folders may belong to the worker's user: it would
# let a compromised worker change what root runs. The Node tarball's files
# belong to uid 1000 or 1001 depending on the release, and 1001 is `worker` on
# this box: an unpacking that kept them made `worker` the owner of
# /usr/local/bin, ahead of /usr/bin on PATH.
# /tmp and /var/tmp are anyone's; Node's compile cache lives in /tmp.
owned=$(find / -xdev -user "$WORKER_USER" -not -path "/home/$WORKER_USER" -not -path "/home/$WORKER_USER/*" \
  -not -path "$WORK_DIR" -not -path "$WORK_DIR/*" -not -path '/tmp/*' -not -path '/var/tmp/*' -not -path '/proc/*' 2>/dev/null)
if [ -z "$owned" ]; then
  pass "$WORKER_USER owns nothing outside its home, $WORK_DIR and /tmp"
else
  fail "$WORKER_USER owns $(printf '%s\n' "$owned" | wc -l) paths outside its own folders, such as $(printf '%s\n' "$owned" | head -n3 | tr '\n' ' ')(install-box.sh gives Node's to root)"
fi

section "The egress rule"
ruleset=$(nft list table inet agent_egress 2>/dev/null)
if [ -z "$ruleset" ]; then
  fail "no nft table inet agent_egress: $WORKER_USER can reach the internet directly"
else
  owner="skuid ($uid|$WORKER_USER)"
  if printf '%s\n' "$ruleset" | grep -qE "$owner oif \"lo\" accept" &&
    printf '%s\n' "$ruleset" | grep -qE "$owner (counter packets [0-9]+ bytes [0-9]+ )?reject"; then
    pass "$WORKER_USER may open connections on loopback alone"
  else
    fail "the agent_egress table does not limit $WORKER_USER to loopback"
  fi
fi
for unit in agent-egress tinyproxy; do
  if systemctl is-enabled --quiet "$unit" && systemctl is-active --quiet "$unit"; then
    pass "$unit is enabled and active"
  else
    fail "$unit is $(systemctl is-enabled "$unit" 2>/dev/null)/$(systemctl is-active "$unit" 2>/dev/null)"
  fi
done

section "tinyproxy"
setting() { grep -E "^[[:space:]]*$1[[:space:]]" "$TINYPROXY_CONF" 2>/dev/null; }
proxy_port=${PROXY##*:}
if setting Port | grep -qw "$proxy_port" && setting Listen | grep -qw "127.0.0.1"; then
  pass "it listens on 127.0.0.1:$proxy_port"
else
  fail "it does not listen on 127.0.0.1:$proxy_port"
fi
for port in 443 "$TOKEN_PORT"; do
  if setting ConnectPort | grep -qw "$port"; then pass "it tunnels to port $port"; else fail "it has no 'ConnectPort $port'"; fi
done
if setting FilterDefaultDeny | grep -qiw yes; then pass "it refuses any host not on its list"; else fail "FilterDefaultDeny is not Yes: it lets every host through"; fi
filter=$(setting Filter | awk '{print $2}' | tr -d '"')
if [ -z "$filter" ] || [ ! -f "$filter" ]; then
  fail "its Filter file, '${filter:-unset}', is missing"
else
  for host in $ALLOWED_HOSTS; do
    if grep -qxF "$host" "$filter"; then pass "it allows $host"; else fail "its list in $filter lacks $host"; fi
  done
fi

section "The worker"
installed=$(grep -m1 '"version"' "$PKG_JSON" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/')
# This run of the worker's log alone: what it said since systemd last started it.
run_log() { journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value agent-worker)" 2>/dev/null; }
running_version=$(run_log | sed -n 's/.*worker \([0-9][0-9.]*\) listening.*/\1/p' | tail -n1)
if [ -z "$installed" ]; then
  fail "no package installed at $PKG_JSON"
elif [ "$installed" != "$running_version" ]; then
  fail "installed $installed, but the worker last started ${running_version:-no} worker: restart it"
else
  pass "installed and running: $installed"
fi
echo "  INFO  worker version: ${running_version:-unknown} (check-unraid.sh prints the dispatcher's: they must match)"
if systemctl is-enabled --quiet agent-worker && systemctl is-active --quiet agent-worker; then
  pass "agent-worker is enabled and active"
else
  fail "agent-worker is $(systemctl is-enabled agent-worker 2>/dev/null)/$(systemctl is-active agent-worker 2>/dev/null)"
fi
if systemctl is-active --quiet agent-orchestrator 2>/dev/null; then
  fail "the prototype's agent-orchestrator is running: it holds the job door's port"
elif systemctl is-enabled --quiet agent-orchestrator 2>/dev/null; then
  warn "the prototype's agent-orchestrator is stopped but would start at boot"
fi
if [ ! -f "$ENV_FILE" ]; then
  fail "no settings file at $ENV_FILE"
else
  perms=$(stat -c '%a %U' "$ENV_FILE")
  if [ "$perms" = "600 root" ]; then pass "$ENV_FILE is root's alone (600)"; else fail "$ENV_FILE is '$perms', not '600 root'"; fi
  for name in $REQUIRED_SETTINGS; do
    if grep -q "^$name=." "$ENV_FILE"; then pass "it sets $name"; else fail "it does not set $name, or sets it empty"; fi
  done
  for name in WORKER_PROXY AGENT_SANDBOX_PROXY; do
    if grep -qx "$name=$PROXY" "$ENV_FILE"; then pass "$name is $PROXY"; else fail "$name is not $PROXY"; fi
  done
  if grep -qx "DISPATCHER_TOKEN_URL=http://$HOST_IP:$TOKEN_PORT/token" "$ENV_FILE"; then
    pass "it asks the token door at $HOST_IP:$TOKEN_PORT for tokens"
  else
    fail "DISPATCHER_TOKEN_URL is not http://$HOST_IP:$TOKEN_PORT/token"
  fi
  fingerprint=$(grep '^WORKER_SECRET=' "$ENV_FILE" | sha256sum | cut -c1-16)
  echo "  INFO  shared secret fingerprint: $fingerprint (check-unraid.sh prints its own: they must match)"
fi
perms=$(stat -c '%a %U' "$WORK_DIR" 2>/dev/null)
if [ "$perms" = "700 $WORKER_USER" ]; then pass "$WORK_DIR is $WORKER_USER's alone"; else fail "$WORK_DIR is '${perms:-missing}', not '700 $WORKER_USER'"; fi

section "The paths it uses"
code=$(status "http://$BOX_IP:$JOBS_PORT/health")
if [ "$code" = "200" ]; then pass "the job door answers 200"; else fail "the job door, $BOX_IP:$JOBS_PORT, answered $code"; fi
answer=$(as_worker_via_proxy "http://$HOST_IP:$TOKEN_PORT/health")
if [ "${answer#*/}" = "200" ]; then
  pass "$WORKER_USER reaches the dispatcher's token door through the proxy"
else
  fail "$WORKER_USER's request to the token door through the proxy came back '$answer' (CONNECT/HTTP): 403 is tinyproxy's list or ConnectPort, 500 is the dispatcher down, 000/000 a firewall dropping it on Unraid"
fi
answer=$(as_worker_via_proxy "https://api.github.com/")
# The tunnel opened and GitHub answered: any status is an answer from GitHub.
if [ "${answer%%/*}" = "200" ] && [ -n "${answer#*/}" ] && [ "${answer#*/}" != "000" ]; then
  pass "$WORKER_USER reaches GitHub through the proxy"
else
  fail "$WORKER_USER could not reach api.github.com through the proxy ('$answer')"
fi
answer=$(as_worker_via_proxy "https://example.com/")
if [ "${answer%%/*}" = "403" ]; then
  pass "the proxy refuses a host not on its list"
else
  fail "the proxy did not refuse example.com ('$answer'): its list is not being applied"
fi
code=$(runuser -u "$WORKER_USER" -- curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 5 https://api.github.com/ 2>/dev/null || true)
if [ "$code" = "000" ]; then
  pass "$WORKER_USER cannot reach the internet except through the proxy"
else
  fail "$WORKER_USER reached api.github.com directly ($code): the egress rule is not holding"
fi

section "Jobs since the worker started"
# A count and where to read them, never the lines: log text is not this
# script's to print.
count=$(run_log | grep -ciE 'failed|refused|timed out' || true)
if [ "${count:-0}" -gt 0 ]; then
  warn "$count lines of the worker's log since it started mention a failure, refusal or time-out; read them with: journalctl -u agent-worker -b"
else
  pass "no failure, refusal or time-out in the worker's log since it started"
fi

printf '\n%d passed, %d warnings, %d failed\n' "$passed" "$warned" "$failed"
[ "$failed" -eq 0 ]
