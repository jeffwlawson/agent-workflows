# shellcheck shell=bash
# dispatcher-container.sh: the dispatcher's container as install-unraid.sh and
# upgrade-unraid.sh both build it (#691). Not run on its own: each of them reads
# it with `.`, after agent-service.conf, so one drift check and one create step
# serve both, and an upgrade recreates a container that has drifted from what
# an install would make rather than restarting it as it is.
#
# Copy it beside them, to /boot/config/agent-service/, with the other *.sh files.

APPDATA=${APPDATA:-/mnt/user/appdata/agent-dispatcher}
ENV_FILE=${ENV_FILE:-$APPDATA/service.env}
CONTAINER=${CONTAINER:-agent-dispatcher}
IMAGE=${IMAGE:-node:24-alpine}
# Unraid's container conventions: nobody:users (99:100), and the server's time zone. The
# dispatcher is the piece the internet reaches, through the Funnel, and it holds
# the App's key: not root. The key is given to this user, readable by it alone.
# uid 99 has no home in the image, and /app is read-only, so it starts in /tmp
# with HOME there: anything written relative to either lands somewhere writable.
CONTAINER_USER=${CONTAINER_USER:-99:100}
# The one place the dispatcher writes to (#618): its state file, which keeps its
# dispatched jobs and the scan's counts across a restart. Owned by
# CONTAINER_USER, and mounted read-write at /state.
STATE_DIR=${STATE_DIR:-$APPDATA/state}
TZ_NAME=${TZ_NAME:-UTC}

# The line of service.env that turns the state file on, at the mount's path.
# shellcheck disable=SC2034 # read by install-unraid.sh and upgrade-unraid.sh
DISPATCHER_STATE_LINE=STATE_FILE=/state/dispatcher.json
dispatcher_cmd="node /app/pkg/node_modules/@jeffwlawson/agent-workflows/dist/cli.js dispatcher"

# Make the state folder, owned by the container's user and private to it.
dispatcher_state_dir() {
  if [ ! -d "$STATE_DIR" ]; then
    mkdir -p "$STATE_DIR"
    echo "  made       $STATE_DIR, for the dispatcher's state file"
  fi
  chown "$CONTAINER_USER" "$STATE_DIR"
  chmod 700 "$STATE_DIR"
}

# What is wrong with the existing container, one thing a line, if anything.
# Docker reads --env-file when it creates a container, not when it restarts one,
# so any of these means a new container.
dispatcher_drift() {
  local mounts env
  docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "missing"; return; }
  [ "$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")" = "$IMAGE" ] || echo "image"
  [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")" = "host" ] || echo "network"
  [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")" = "unless-stopped" ] || echo "restart policy"
  [ "$(docker inspect -f '{{join .Config.Cmd " "}}' "$CONTAINER")" = "$dispatcher_cmd" ] || echo "command"
  [ "$(docker inspect -f '{{.Config.User}}' "$CONTAINER")" = "$CONTAINER_USER" ] || echo "user"
  [ "$(docker inspect -f '{{.Config.WorkingDir}}' "$CONTAINER")" = "/tmp" ] || echo "working directory"
  mounts=$(docker inspect -f '{{range .Mounts}}{{println .Source .Destination .RW}}{{end}}' "$CONTAINER")
  grep -qx "$APPDATA /app false" <<<"$mounts" || echo "mount"
  grep -qx "$STATE_DIR /state true" <<<"$mounts" || echo "state mount"
  env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER")
  grep -qx "TZ=$TZ_NAME" <<<"$env" || echo "time zone"
  grep -qx "HOME=/tmp" <<<"$env" || echo "home"
  [ -z "$(grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" | grep -Fxv -f <(printf '%s\n' "$env"))" ] || echo "settings"
}

# Remove the container, unless $1 (dispatcher_drift's list, comma-separated) says
# it is missing, and create it as an install does.
dispatcher_create() {
  local wrong=$1
  if [ "$wrong" != "missing" ]; then
    docker rm -f "$CONTAINER" >/dev/null
    echo "  removed    $CONTAINER, whose $wrong differed"
  fi
  # shellcheck disable=SC2086 # the command is words, as Docker takes them
  docker run -d --name "$CONTAINER" --restart unless-stopped --network host \
    --user "$CONTAINER_USER" -w /tmp -e HOME=/tmp -e "TZ=$TZ_NAME" \
    --env-file "$ENV_FILE" -v "$APPDATA:/app:ro" -v "$STATE_DIR:/state" "$IMAGE" $dispatcher_cmd >/dev/null
  echo "  created    $CONTAINER"
}
