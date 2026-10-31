#!/usr/bin/env bash
# install-unraid.sh <version>: set up the Unraid half of the agent-workflows
# service orchestrator, then run check-unraid.sh. Safe to run again on a
# server already set up: what is already as it should be is left alone, a
# file that differs is backed up beside itself (<file>.bak.<time>) and
# replaced, and a secret already set is kept.
#
# What it sets up:
#   - agentnet, the private network the agent box lives on, with the box's
#     address reserved for its network card;
#   - the agentnet-firewall User Script, which keeps the box off the LAN;
#   - the dispatcher: its settings (making the shared secret), the package in
#     appdata, its container;
#   - the Tailscale Funnel that publishes the dispatcher's webhook door.
#
# It does not create the VM: make it in the VM form (docs/deploying-the-service.md's
# worked example lists the settings), with its network card on agentnet. Run this before the VM
# exists to get the card address to give it; run it again after, and it
# reserves the address for whatever card the VM has.
#
# Needs, before it starts: the GitHub App's private key saved as app.pem in
# the dispatcher's appdata folder. Asks, at prompts that do not show what is
# typed, for the App's webhook secret and a classic GitHub token with only
# read:packages (delete it on GitHub afterwards); the App ID is shown as typed.
#
# Run as root on Unraid:  bash /boot/config/agent-service/install-unraid.sh 0.8.5
set -euo pipefail

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
IMAGE=${IMAGE:-node:24-alpine}
# Unraid's container conventions: nobody:users (99:100), and the server's time zone. The
# dispatcher is the piece the internet reaches, through the Funnel, and it holds
# the App's key: not root. The key is given to this user, readable by it alone.
# uid 99 has no home in the image, and /app is read-only, so it starts in /tmp
# with HOME there: anything written relative to either lands somewhere writable.
CONTAINER_USER=${CONTAINER_USER:-99:100}
TZ_NAME=${TZ_NAME:-UTC}
CHAIN=${CHAIN:-AGENT-EGRESS}
WAIT_SECONDS=${WAIT_SECONDS:-60}
NET=${NET:-agentnet}
BRIDGE=${BRIDGE:-virbr-agent}
VM=${VM:-agent-box}
HOST_IP=${HOST_IP:-192.168.250.1}
BOX_IP=${BOX_IP:-192.168.250.11}
# The card address reserved for the box when there is no VM yet to read one
# from: give the VM this MAC in the VM form. Unset, one is made up at random and
# printed; put it in agent-service.conf so a second run reserves the same one.
BOX_MAC=${BOX_MAC:-}
WEBHOOK_PORT=${WEBHOOK_PORT:-8790}
TOKEN_PORT=${TOKEN_PORT:-8791}
JOBS_PORT=${JOBS_PORT:-8787}
FUNNEL_PORT=${FUNNEL_PORT:-10000}
FIREWALL_DIR=${FIREWALL_DIR:-/boot/config/plugins/user.scripts/scripts/agentnet-firewall}

version=${1:-}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: bash $0 <version>, for example: bash $0 0.8.5" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root on Unraid." >&2
  exit 2
fi
check_script="$(dirname "$0")/check-unraid.sh"
if [ ! -f "$check_script" ]; then
  echo "check-unraid.sh is not beside this script ($check_script): copy it here first. Nothing was changed." >&2
  exit 2
fi
if ! : </dev/tty 2>/dev/null; then
  echo "This asks for secrets at a prompt, so it needs a terminal (over ssh, use ssh -t). Nothing was changed." >&2
  exit 2
fi
for tool in virsh docker iptables tailscale openssl; do
  command -v "$tool" >/dev/null || { echo "$tool is missing: is the VM service, Docker or the Tailscale plugin off? Nothing was changed." >&2; exit 2; }
done
if [ ! -f "$APPDATA/app.pem" ]; then
  echo "No App key at $APPDATA/app.pem. Generate a private key on the GitHub App's settings page, save it there, then run this again. Nothing was changed." >&2
  exit 2
fi

stamp=$(date +%Y%m%d-%H%M%S)
# Write $3 to $1 with mode $2. Prints what it did; returns 0 when it changed
# the file, 1 when the file was already so.
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

echo "== The $NET network"
if virsh dominfo "$VM" >/dev/null 2>&1; then
  mac=$(virsh domiflist "$VM" | awk -v net="$NET" '$3 == net {print $5; exit}')
  if [ -z "$mac" ]; then
    echo "The VM $VM has no network card on $NET: set its Network Source to $NET in the VM form first. Nothing more was changed." >&2
    exit 1
  fi
  vm_card=1
  echo "  found      $VM's card on $NET: $mac"
else
  vm_card=
  mac=${BOX_MAC:-$(printf '52:54:00:%02x:%02x:%02x' $((RANDOM % 256)) $((RANDOM % 256)) $((RANDOM % 256)))}
  [ -n "$BOX_MAC" ] || echo "  made up    MAC $mac: give the VM this MAC, and set BOX_MAC=$mac in agent-service.conf"
  echo "  no VM yet  reserving $BOX_IP for the card the VM will have (its MAC follows)"
fi
if ! virsh net-info "$NET" >/dev/null 2>&1; then
  xml=$(mktemp)
  cat >"$xml" <<EOF
<network>
  <name>$NET</name>
  <forward mode='nat'/>
  <bridge name='$BRIDGE' stp='on' delay='0'/>
  <ip address='$HOST_IP' netmask='255.255.255.0'>
    <dhcp>
      <range start='${HOST_IP%.*}.10' end='${HOST_IP%.*}.50'/>
      <host mac='$mac' name='$VM' ip='$BOX_IP'/>
    </dhcp>
  </ip>
</network>
EOF
  virsh net-define "$xml" >/dev/null
  rm -f "$xml"
  echo "  created    $NET ($HOST_IP/24 on $BRIDGE), with $BOX_IP reserved for $mac"
fi
# Active before any update: libvirt refuses --live on a network that is not.
virsh net-autostart "$NET" >/dev/null
virsh net-info "$NET" | grep -q '^Active: *yes' || virsh net-start "$NET" >/dev/null
echo "  ensured    $NET is active and starts with the VM service"
hosts=$(virsh net-dumpxml "$NET" | grep "<host " | sed 's/^[[:space:]]*//' || true)
if grep -q "mac='$mac'.*ip='$BOX_IP'" <<<"$hosts"; then
  echo "  unchanged  $NET reserves $BOX_IP for $mac"
else
  holder=$(grep "ip='$BOX_IP'" <<<"$hosts" | head -n1 || true)
  if [ -z "$vm_card" ] && [ -n "$holder" ]; then
    # No VM yet, and .11 already kept for a card: that is the card to give it.
    mac=$(sed -n "s/.*mac='\([^']*\)'.*/\1/p" <<<"$holder")
    echo "  unchanged  $NET reserves $BOX_IP for $mac"
  else
    # The VM's card wins: drop whatever holds .11 or holds this card elsewhere.
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      virsh net-update "$NET" delete ip-dhcp-host "$line" --live --config >/dev/null
      echo "  removed    $NET's $line"
    done < <(grep -e "ip='$BOX_IP'" -e "mac='$mac'" <<<"$hosts" || true)
    virsh net-update "$NET" add ip-dhcp-host "<host mac='$mac' name='$VM' ip='$BOX_IP'/>" --live --config >/dev/null
    echo "  added      $NET reserves $BOX_IP for $mac"
  fi
fi
[ -n "$vm_card" ] || echo "  REMEMBER   give the VM the MAC $mac in the VM form, so it gets $BOX_IP"

echo "== The agentnet-firewall User Script"
firewall_changed=
put "$FIREWALL_DIR/script" 644 "$(cat <<EOF
#!/bin/bash
# agentnet-firewall: keep the $VM VM (network $NET, bridge $BRIDGE) off the
# LAN, the VPNs and Unraid itself. Internet only, plus DNS/DHCP from libvirt on
# $HOST_IP and the agent-workflows dispatcher's token door, $HOST_IP:$TOKEN_PORT.
# Safe to run repeatedly. Starts the VM only after the rules are in, so leave
# the VM's own Autostart OFF. Written by agent-workflows' deploy/unraid/install-unraid.sh.
IF=$BRIDGE
CH=$CHAIN

# Wait (up to 5 min) for the VM service and the $NET network.
for i in \$(seq 1 60); do virsh net-info $NET >/dev/null 2>&1 && break; sleep 5; done

iptables -t mangle -N \$CH 2>/dev/null || iptables -t mangle -F \$CH
iptables -t mangle -A \$CH -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -t mangle -A \$CH -d $HOST_IP -p udp --dport 53 -j RETURN
iptables -t mangle -A \$CH -d $HOST_IP -p tcp --dport 53 -j RETURN
iptables -t mangle -A \$CH -p udp --dport 67 -j RETURN
iptables -t mangle -A \$CH -d $HOST_IP -p tcp --dport $TOKEN_PORT -j RETURN
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  iptables -t mangle -A \$CH -d \$net -j DROP
done
iptables -t mangle -C PREROUTING -i \$IF -j \$CH 2>/dev/null || iptables -t mangle -I PREROUTING 1 -i \$IF -j \$CH

# No IPv6 at all from the agent network.
ip6tables -t mangle -C PREROUTING -i \$IF -j DROP 2>/dev/null || ip6tables -t mangle -I PREROUTING 1 -i \$IF -j DROP

# Start the VM only now that the rules are in.
if virsh dominfo $VM >/dev/null 2>&1; then
  virsh domstate $VM 2>/dev/null | grep -q running || virsh start $VM
fi
echo "agentnet firewall applied"
EOF
)" && firewall_changed=1
put "$FIREWALL_DIR/description" 644 "Keeps the agent box VM off the LAN, then starts it. Schedule: At Startup of Array." || true
if ! iptables -t mangle -S "$CHAIN" >/dev/null 2>&1; then
  bash "$FIREWALL_DIR/script"
  echo "  applied    the rules (none were in)"
elif [ -n "$firewall_changed" ]; then
  # Rebuilding the chain empties it for a moment, and while it is empty the
  # box can reach the LAN: so not while the box runs, unasked.
  echo "  NOT YET    the script changed, but the running rules are the old ones. Apply it at a quiet"
  echo "             moment with: bash $FIREWALL_DIR/script   (or reboot Unraid)"
fi
echo "  REMEMBER   in Settings → User Scripts, schedule agentnet-firewall 'At Startup of Array', or a reboot loses the rules"

echo "== The dispatcher's settings"
mkdir -p "$APPDATA"
chown "$CONTAINER_USER" "$APPDATA/app.pem"
chmod 600 "$APPDATA/app.pem"
# A setting's value, without quotes around it: Docker would keep them as part of it.
value() {
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}
app_id=$(value GITHUB_APP_ID)
webhook=$(value GITHUB_WEBHOOK_SECRET)
secret=$(value WORKER_SECRET)
if [ -n "$app_id" ]; then
  echo "  kept       GITHUB_APP_ID ($app_id)"
else
  read -rp "The GitHub App's ID (its settings page, under About): " app_id </dev/tty
  [[ $app_id =~ ^[0-9]+$ ]] || { echo "An App ID is a number. Nothing more was changed." >&2; exit 1; }
fi
if [ -n "$webhook" ]; then
  echo "  kept       GITHUB_WEBHOOK_SECRET"
else
  webhook=$(ask_secret "The App's webhook secret, as set on its settings page (not shown)")
  [ -n "$webhook" ] || { echo "The webhook secret is required. Nothing more was changed." >&2; exit 1; }
fi
if [ -n "$secret" ]; then
  echo "  kept       WORKER_SECRET"
else
  secret=$(openssl rand -hex 32)
  echo "  made       WORKER_SECRET (install-box.sh asks for it)"
fi
# put returns 1 for "unchanged", which set -e would otherwise stop on; the
# container step below compares the settings itself.
put "$ENV_FILE" 600 "$(cat <<EOF
GITHUB_APP_ID=$app_id
GITHUB_WEBHOOK_SECRET=$webhook
GITHUB_APP_PRIVATE_KEY_FILE=/app/app.pem
WORKER_URL=http://$BOX_IP:$JOBS_PORT/jobs
WEBHOOK_HOST=127.0.0.1
WEBHOOK_PORT=$WEBHOOK_PORT
TOKEN_HOST=$HOST_IP
TOKEN_PORT=$TOKEN_PORT
WORKER_SECRET=$secret
EOF
)" || true
unset webhook secret
chmod 600 "$ENV_FILE".bak.* 2>/dev/null || true

echo "== The package"
installed() { grep -m1 '"version"' "$PKG_JSON" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/'; }
package_changed=
if [ "$(installed)" = "$version" ]; then
  echo "  unchanged  @jeffwlawson/agent-workflows $version in $APPDATA/pkg"
else
  npmrc=$(umask 077 && mktemp /root/agent-workflows-npmrc.XXXXXX)
  trap 'rm -f "$npmrc"' EXIT
  token=$(ask_secret 'GitHub token (read:packages; not shown)')
  printf '@jeffwlawson:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$token" >"$npmrc"
  unset token
  docker run --rm -v "$APPDATA/pkg:/pkg" -v "$npmrc:/tmp/pkg.npmrc:ro" "$IMAGE" \
    npm install --prefix /pkg --userconfig /tmp/pkg.npmrc --no-fund --no-audit --no-update-notifier \
    "@jeffwlawson/agent-workflows@$version"
  rm -f "$npmrc"
  if [ "$(installed)" != "$version" ]; then
    echo "The install finished but $PKG_JSON says $(installed), not $version." >&2
    exit 1
  fi
  package_changed=1
  echo "  installed  @jeffwlawson/agent-workflows $version in $APPDATA/pkg"
fi

echo "== The dispatcher's container"
# The prototype holds the same ports: stopped, and kept from restarting at boot.
if docker inspect "$PROTOTYPE_CONTAINER" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$PROTOTYPE_CONTAINER")" = "true" ]; then
    docker stop "$PROTOTYPE_CONTAINER" >/dev/null
    echo "  stopped    the prototype's $PROTOTYPE_CONTAINER"
  fi
  if [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$PROTOTYPE_CONTAINER")" != "no" ]; then
    docker update --restart=no "$PROTOTYPE_CONTAINER" >/dev/null
    echo "  ensured    $PROTOTYPE_CONTAINER does not restart at boot"
  fi
fi
cmd="node /app/pkg/node_modules/@jeffwlawson/agent-workflows/dist/cli.js dispatcher"
# What is wrong with the existing container, if anything. Docker reads
# --env-file when it creates a container, not when it restarts one, so any of
# these means a new container.
drift() {
  docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "missing"; return; }
  [ "$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")" = "$IMAGE" ] || echo "image"
  [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")" = "host" ] || echo "network"
  [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")" = "unless-stopped" ] || echo "restart policy"
  [ "$(docker inspect -f '{{join .Config.Cmd " "}}' "$CONTAINER")" = "$cmd" ] || echo "command"
  [ "$(docker inspect -f '{{.Config.User}}' "$CONTAINER")" = "$CONTAINER_USER" ] || echo "user"
  [ "$(docker inspect -f '{{.Config.WorkingDir}}' "$CONTAINER")" = "/tmp" ] || echo "working directory"
  docker inspect -f '{{range .Mounts}}{{println .Source .Destination .RW}}{{end}}' "$CONTAINER" | grep -qx "$APPDATA /app false" || echo "mount"
  env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER")
  grep -qx "TZ=$TZ_NAME" <<<"$env" || echo "time zone"
  grep -qx "HOME=/tmp" <<<"$env" || echo "home"
  [ -z "$(grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" | grep -Fxv -f <(printf '%s\n' "$env"))" ] || echo "settings"
}
wrong=$(drift | paste -sd, -)
# The version the container last said it was listening at.
running_version() {
  local started
  started=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null) || return 0
  docker logs --since "$started" "$CONTAINER" 2>&1 | sed -n 's/.*dispatcher \([0-9][0-9.]*\) listening.*/\1/p' | tail -n1
}
if [ -z "$wrong" ]; then
  if [ -n "$package_changed" ] || [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ] ||
    [ "$(running_version)" != "$version" ]; then
    docker restart "$CONTAINER" >/dev/null
    echo "  restarted  $CONTAINER, to run $version"
  else
    echo "  unchanged  $CONTAINER"
  fi
else
  if [ "$wrong" != "missing" ]; then
    docker rm -f "$CONTAINER" >/dev/null
    echo "  removed    $CONTAINER, whose $wrong differed"
  fi
  docker run -d --name "$CONTAINER" --restart unless-stopped --network host \
    --user "$CONTAINER_USER" -w /tmp -e HOME=/tmp -e "TZ=$TZ_NAME" \
    --env-file "$ENV_FILE" -v "$APPDATA:/app:ro" "$IMAGE" $cmd >/dev/null
  echo "  created    $CONTAINER"
fi
ready=
for _ in $(seq 1 "$WAIT_SECONDS"); do
  if [ "$(running_version)" = "$version" ]; then ready=1; break; fi
  sleep 1
done
if [ -n "$ready" ]; then
  echo "  listening  dispatcher $version"
else
  echo "The dispatcher did not say it was listening at $version within $WAIT_SECONDS seconds. Its log: docker logs --tail 20 $CONTAINER" >&2
  status=1
fi

echo "== The Funnel"
funnel=$(tailscale funnel status 2>/dev/null || true)
if grep -q ":$FUNNEL_PORT (Funnel on)" <<<"$funnel" && grep -q "proxy http://127.0.0.1:$WEBHOOK_PORT" <<<"$funnel"; then
  echo "  unchanged  :$FUNNEL_PORT is public, to the webhook door"
else
  tailscale funnel --bg --https="$FUNNEL_PORT" "http://127.0.0.1:$WEBHOOK_PORT" >/dev/null
  echo "  published  https://<this server's Tailscale name>:$FUNNEL_PORT → the webhook door"
fi
echo "  REMEMBER   Settings → Tailscale → Allow Tailscale Funnel must stay Yes; the App's webhook URL"
echo "             is https://$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n1):$FUNNEL_PORT/github"

echo
bash "$check_script" || status=${status:-$?}
echo
echo "Next: delete the GitHub token on GitHub if you made one. If the box is not set up yet, set it"
echo "up with install-box.sh, which asks for WORKER_SECRET. Print it here, once, to copy it across:"
echo "  grep '^WORKER_SECRET=' $ENV_FILE | cut -d= -f2"
echo "Before the VM exists, the checks on it fail: that it runs, its Autostart, its card on $NET, and"
echo "its job door. Once it exists the first three pass; the job door passes once install-box.sh has run."
exit "${status:-0}"
