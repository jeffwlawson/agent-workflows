#!/usr/bin/env bash
# install-box.sh <version>: set up the agent box, the VM that runs the
# agent-workflows service worker, on a fresh Ubuntu 24.04 server, then run
# check-box.sh. Safe to run again on a box already set up: a file already as
# it should be is left alone, one that differs is backed up beside itself
# (<file>.bak.<time>) and replaced, and a secret already set is kept.
#
# What it sets up: the packages (bubblewrap, tinyproxy, nftables, git, curl),
# Node from nodejs.org with root owning every file, the `worker` user (no
# sudo), the AppArmor profile that lets bwrap make user namespaces, the egress
# rule limiting `worker` to loopback (and so to tinyproxy), tinyproxy and its
# list, the package in /opt, the worker's settings and its systemd unit.
#
# Asks, at prompts that do not show what is typed, for what it cannot make:
#   - the shared secret, WORKER_SECRET, from Unraid's service.env (install-unraid.sh makes it);
#   - the agent's model token, from `claude setup-token`;
#   - a classic GitHub token with only read:packages, to download the package.
# Delete the GitHub token on GitHub afterwards.
#
# Run on the box, as root:  sudo bash ~/install-box.sh 0.8.5
set -euo pipefail

# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$(dirname "$0")/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

NODE_VERSION=${NODE_VERSION:-24.21.0}
CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION:-2.1.290}
WORKER_USER=${WORKER_USER:-worker}
PREFIX=${PREFIX:-/opt/agent-workflows}
PKG_JSON=$PREFIX/node_modules/@jeffwlawson/agent-workflows/package.json
ENV_FILE=${ENV_FILE:-/etc/agent-worker/worker.env}
WORK_DIR=${WORK_DIR:-/var/lib/agent-worker}
HOST_IP=${HOST_IP:-192.168.250.1}
BOX_IP=${BOX_IP:-192.168.250.11}
TOKEN_PORT=${TOKEN_PORT:-8791}
JOBS_PORT=${JOBS_PORT:-8787}
PROXY_PORT=${PROXY_PORT:-3128}
PROXY=http://127.0.0.1:$PROXY_PORT
UNIT=${UNIT:-agent-worker}
# The worker installs the agent's CLI at each start, so give it a while.
WAIT_SECONDS=${WAIT_SECONDS:-180}

version=${1:-}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: sudo bash $0 <version>, for example: sudo bash $0 0.8.5" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash $0 $version" >&2
  exit 2
fi
check_script="$(dirname "$0")/check-box.sh"
if [ ! -f "$check_script" ]; then
  echo "check-box.sh is not beside this script ($check_script): copy it here first. Nothing was changed." >&2
  exit 2
fi
if ! : </dev/tty 2>/dev/null; then
  echo "This asks for secrets at a prompt, so it needs a terminal (over ssh, use ssh -t). Nothing was changed." >&2
  exit 2
fi
if ! grep -q '^VERSION_ID="24.04"' /etc/os-release; then
  echo "This box is not Ubuntu 24.04; the script was written for it. Continuing, but check what it says." >&2
fi

stamp=$(date +%Y%m%d-%H%M%S)
# Write $3 to $1 with mode $2, owned by root. Prints what it did; returns 0
# when it changed the file, 1 when the file was already so.
put() {
  local dest=$1 mode=$2 content=$3
  if [ -f "$dest" ] && [ "$(cat "$dest")" = "$content" ]; then
    chmod "$mode" "$dest"
    echo "  unchanged  $dest"
    return 1
  fi
  if [ -f "$dest" ]; then
    cp -p "$dest" "$dest.bak.$stamp"
    echo "  updated    $dest (the old one is $dest.bak.$stamp)"
  else
    echo "  created    $dest"
  fi
  mkdir -p "$(dirname "$dest")"
  (umask 077 && printf '%s\n' "$content" >"$dest")
  chown root:root "$dest"
  chmod "$mode" "$dest"
  return 0
}
# A secret typed at a prompt that does not echo it.
ask_secret() {
  local answer
  read -rsp "$1: " answer </dev/tty
  echo >/dev/tty
  printf '%s' "$answer"
}

echo "== Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq bubblewrap tinyproxy nftables git curl ca-certificates xz-utils >/dev/null
echo "  ensured    bubblewrap tinyproxy nftables git curl are installed"

echo "== Node $NODE_VERSION"
node_have=$(/usr/local/bin/node --version 2>/dev/null | sed 's/^v//' || true)
if [ "$node_have" = "$NODE_VERSION" ]; then
  echo "  unchanged  Node $node_have"
else
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  dir=$(mktemp -d)
  curl -fsSL -o "$dir/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL -o "$dir/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$dir" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet)
  # --no-same-owner: the archive's files belong to a build account's uid, 1000
  # or 1001 depending on the release, which on a box whose admin came first is
  # the admin or `worker`. Unpacked as is, one of them would own /usr/local/bin,
  # which comes before /usr/bin on root's PATH.
  tar -xJf "$dir/$tarball" -C /usr/local --strip-components=1 --no-same-owner \
    --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
  rm -rf "$dir"
  echo "  installed  Node $NODE_VERSION (was ${node_have:-none}), checked against nodejs.org's SHASUMS256.txt"
fi
# And put right a box where an earlier unpacking left them to uid 1000 or 1001: on
# Ubuntu everything under /usr/local is root's, so anything that is not, is.
fixed=$(find /usr/local -xdev ! -user root -print -exec chown -h root:root {} + 2>/dev/null | wc -l)
echo "  ensured    root owns everything under /usr/local (handed $fixed back)"

echo "== The $WORKER_USER user"
if id "$WORKER_USER" >/dev/null 2>&1; then
  echo "  unchanged  $WORKER_USER exists ($(id "$WORKER_USER"))"
else
  useradd --create-home --shell /bin/bash "$WORKER_USER"
  echo "  created    $WORKER_USER ($(id "$WORKER_USER")), with no sudo"
fi
if sudo -l -U "$WORKER_USER" 2>/dev/null | grep -q 'may run'; then
  echo "  WARNING    $WORKER_USER may run sudo here: remove that, it defeats the egress rule" >&2
fi

echo "== The sandbox's AppArmor profile"
if put /etc/apparmor.d/bwrap 644 "$(cat <<'EOF'
abi <abi/4.0>,
include <tunables/global>

# Ubuntu 24.04 restricts unprivileged user namespaces; this lets bubblewrap,
# and only bubblewrap, make them, which the agent's sandbox needs.
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
EOF
)"; then apparmor_parser -r /etc/apparmor.d/bwrap; fi

echo "== The egress rule"
egress_changed=
put /etc/agent-egress.nft 644 "$(cat <<EOF
#!/usr/sbin/nft -f
# The $WORKER_USER user (the worker and the agent it runs) may only use the local
# proxy, tinyproxy on 127.0.0.1:$PROXY_PORT. Direct DNS is refused too: tinyproxy resolves.
table inet agent_egress
delete table inet agent_egress
table inet agent_egress {
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid "$WORKER_USER" ct state established,related accept
    meta skuid "$WORKER_USER" oif "lo" meta l4proto { tcp, udp } th dport 53 reject
    meta skuid "$WORKER_USER" oif "lo" accept
    meta skuid "$WORKER_USER" counter reject
  }
}
EOF
)" && egress_changed=1
put /etc/systemd/system/agent-egress.service 644 "$(cat <<'EOF'
[Unit]
Description=Agent-job egress rules (worker may only use the local proxy)
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/agent-egress.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
)" && egress_changed=1
systemctl daemon-reload
systemctl enable -q agent-egress
if [ -n "$egress_changed" ]; then systemctl restart agent-egress; else systemctl start agent-egress; fi

echo "== tinyproxy"
proxy_changed=
put /etc/tinyproxy/tinyproxy.conf 644 "$(cat <<EOF
# tinyproxy for the agent box: the one way out for the $WORKER_USER user.
User tinyproxy
Group tinyproxy
Port $PROXY_PORT
Listen 127.0.0.1
Timeout 600
Syslog On
LogLevel Info
PidFile "/run/tinyproxy/tinyproxy.pid"
MaxClients 50
Allow 127.0.0.1
DisableViaHeader Yes
# 443 for HTTPS; $TOKEN_PORT for the dispatcher's token door, since Node tunnels a
# plain http: request through CONNECT too.
ConnectPort 443
ConnectPort $TOKEN_PORT
Filter "/etc/tinyproxy/allowlist"
FilterDefaultDeny Yes
EOF
)" && proxy_changed=1
put /etc/tinyproxy/allowlist 644 "$(cat <<EOF
^api\.anthropic\.com\$
^github\.com\$
^api\.github\.com\$
^codeload\.github\.com\$
^objects\.githubusercontent\.com\$
^raw\.githubusercontent\.com\$
^release-assets\.githubusercontent\.com\$
^registry\.npmjs\.org\$
^${HOST_IP//./\\.}\$
EOF
)" && proxy_changed=1
systemctl enable -q tinyproxy
if [ -n "$proxy_changed" ]; then systemctl restart tinyproxy; else systemctl start tinyproxy; fi

echo "== The package"
installed() { grep -m1 '"version"' "$PKG_JSON" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/'; }
if [ "$(installed)" = "$version" ]; then
  echo "  unchanged  @jeffwlawson/agent-workflows $version in $PREFIX"
else
  npmrc=$(umask 077 && mktemp /root/agent-workflows-npmrc.XXXXXX)
  trap 'rm -f "$npmrc"' EXIT
  token=$(ask_secret 'GitHub token (read:packages; not shown)')
  printf '@jeffwlawson:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$token" >"$npmrc"
  unset token
  mkdir -p "$PREFIX"
  npm install --prefix "$PREFIX" --userconfig "$npmrc" --no-fund --no-audit --no-update-notifier \
    "@jeffwlawson/agent-workflows@$version"
  rm -f "$npmrc"
  if [ "$(installed)" != "$version" ]; then
    echo "The install finished but $PKG_JSON says $(installed), not $version." >&2
    exit 1
  fi
  echo "  installed  @jeffwlawson/agent-workflows $version in $PREFIX"
fi

echo "== The worker's settings"
install -d -o root -g root -m 700 "$(dirname "$ENV_FILE")"
# A setting's value, without quotes around it.
value() {
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}
secret=$(value WORKER_SECRET)
oauth_token=$(value CLAUDE_CODE_OAUTH_TOKEN)
if [ -n "$secret" ]; then
  echo "  kept       WORKER_SECRET"
else
  secret=$(ask_secret "WORKER_SECRET, from Unraid's service.env (not shown)")
  if ! [[ $secret =~ ^[0-9a-f]{64}$ ]]; then
    echo "That is not the 64 hex characters install-unraid.sh makes. Nothing more was changed." >&2
    exit 1
  fi
fi
if [ -n "$oauth_token" ]; then
  echo "  kept       CLAUDE_CODE_OAUTH_TOKEN"
else
  oauth_token=$(ask_secret 'CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token` (not shown)')
  [ -n "$oauth_token" ] || { echo "The model token is required. Nothing more was changed." >&2; exit 1; }
fi
env_changed=
put "$ENV_FILE" 600 "$(cat <<EOF
DISPATCHER_TOKEN_URL=http://$HOST_IP:$TOKEN_PORT/token
CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION
WORK_DIR=$WORK_DIR
JOBS_HOST=$BOX_IP
JOBS_PORT=$JOBS_PORT
AGENT_SANDBOX=bwrap
AGENT_SANDBOX_PROXY=$PROXY
WORKER_PROXY=$PROXY
WORKER_SECRET=$secret
CLAUDE_CODE_OAUTH_TOKEN=$oauth_token
EOF
)" && env_changed=1
unset secret oauth_token
# The backup of a settings file holds the same secrets: root's alone too.
chmod 600 "$ENV_FILE".bak.* 2>/dev/null || true
install -d -o "$WORKER_USER" -g "$WORKER_USER" -m 700 "$WORK_DIR"
echo "  ensured    $WORK_DIR is $WORKER_USER's alone"

echo "== The worker's service"
if systemctl is-active --quiet agent-orchestrator 2>/dev/null || systemctl is-enabled --quiet agent-orchestrator 2>/dev/null; then
  systemctl disable --now -q agent-orchestrator
  echo "  stopped    the prototype's agent-orchestrator, which holds port $JOBS_PORT"
fi
unit_changed=
put /etc/systemd/system/$UNIT.service 644 "$(cat <<EOF
[Unit]
Description=agent-workflows service worker: review jobs from the dispatcher, agent in bwrap
After=network-online.target tinyproxy.service agent-egress.service
Wants=network-online.target
Requires=tinyproxy.service agent-egress.service

[Service]
User=$WORKER_USER
Group=$WORKER_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$WORK_DIR
ExecStart=/usr/local/bin/node $PREFIX/node_modules/@jeffwlawson/agent-workflows/dist/cli.js worker
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
)" && unit_changed=1
systemctl daemon-reload
systemctl enable -q "$UNIT"
running=$(systemctl show -p InvocationID --value "$UNIT")
if [ -n "$unit_changed$env_changed$proxy_changed$egress_changed" ] || [ -z "$running" ] ||
  ! journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$running" 2>/dev/null | grep -qF "worker $version listening"; then
  systemctl restart "$UNIT"
  echo "  restarted  $UNIT"
  ready=
  for _ in $(seq 1 "$WAIT_SECONDS"); do
    log=$(journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value "$UNIT")" 2>/dev/null || true)
    if grep -qF "worker $version listening" <<<"$log"; then ready=1; break; fi
    sleep 1
  done
  if [ -n "$ready" ]; then
    echo "  listening  worker $version"
  else
    echo "The worker did not say it was listening at $version within $WAIT_SECONDS seconds. Its log: journalctl -u $UNIT -n 30" >&2
    status=1
  fi
else
  echo "  unchanged  $UNIT, already running $version"
fi

echo
bash "$check_script" || status=${status:-$?}
echo
echo "Delete the GitHub token on GitHub if you made one. The dispatcher's checks are on Unraid:"
echo "bash /boot/config/agent-service/check-unraid.sh"
exit "${status:-0}"
