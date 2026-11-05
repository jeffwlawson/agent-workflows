#!/usr/bin/env bash
# status.sh: what the loop is running now (#778), read on Unraid. It prints, in
# order:
#   1. the dispatcher container's state, and since when;
#   2. whether the worker answers, and the jobs it holds, in the order they
#      arrived (the door does not say which are running and which queued);
#   3. the jobs the dispatcher's state file records, in dispatch order, and
#      the items at SCAN_DISPATCH_LIMIT, which the scan leaves for a person;
#   4. a line for each part it cannot reach instead, so it still answers with
#      the dispatcher stopped, the worker down or the state file absent.
#
# Read-only. It changes no file, container or setting. The worker is asked at
# its held door from inside the dispatcher's container, as upgrade.sh asks it,
# signed with the WORKER_SECRET already there, so the secret is never printed,
# written or put on a command line. The question names no dispatcher instance,
# so the worker drops nothing for it (#601). The state file is read on this
# host, where it is mounted, so it is read with the dispatcher stopped too. It
# prints no secret and no log text: ids, kinds, repositories, numbers, labels,
# counts and dates.
#
# Self-contained on purpose, as check-unraid.sh is.
#
# Run as root on Unraid:  bash /boot/config/agent-service/status.sh [<count>]
# <count> is how many of the state file's jobs and at-limit items to list, 20
# of each by default. Exits 0 where any part answered, 1 where none did, and 2
# where it is given an argument it does not take or is not run as root.
set -uo pipefail

# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$(dirname "$0")/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

APPDATA=${APPDATA:-/mnt/user/appdata/agent-dispatcher}
ENV_FILE=${ENV_FILE:-$APPDATA/service.env}
STATE_DIR=${STATE_DIR:-$APPDATA/state}
CONTAINER=${CONTAINER:-agent-dispatcher}

count=20 counted=''
usage="Usage: bash $0 [<count>]"
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      sed -n '2,/^set /{/^set /d;s/^# \{0,1\}//;p}' "$0"
      exit 0
      ;;
    '' | -* | *[!0-9]* | 0)
      echo "'$arg' is not a count: the one argument is how many to list, at least 1. $usage" >&2
      exit 2
      ;;
    *)
      if [ -n "$counted" ]; then echo "One count at a time: '$count' and '$arg' were given. $usage" >&2; exit 2; fi
      count=$arg counted=1
      ;;
  esac
done
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root on Unraid: the state file is the container user's alone. $usage" >&2
  exit 2
fi

answered=0
section() { printf '\n== %s\n' "$*"; }

section "The dispatcher"
running=''
if ! state=$(docker inspect -f '{{.State.Status}} {{.State.StartedAt}}' "$CONTAINER" 2>/dev/null); then
  echo "  cannot tell: docker has no container named $CONTAINER, or docker does not answer"
else
  answered=1
  case "$state" in
    "running "*) running=1; echo "  $CONTAINER is running, since ${state#running }" ;;
    *) echo "  $CONTAINER is ${state%% *}, not running (it last started ${state#* })" ;;
  esac
fi

section "The worker"
# The held-door read upgrade.sh asks: it prints "jobs", "no-door" or
# "failed <reason>", then each held job on a line.
read -r -d '' ask_script <<'EOF' || true
import { createHmac } from "node:crypto";
const out = (...lines) => { process.stdout.write(lines.join("\n") + "\n"); };
const { WORKER_URL: jobs, WORKER_SECRET: secret } = process.env;
if (!jobs || !secret) {
  out("failed the dispatcher's container has no WORKER_URL or no WORKER_SECRET to ask with");
} else {
  const url = new URL("held", jobs);
  const body = JSON.stringify({ asked: new Date().toISOString() });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  let reply;
  try {
    reply = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature-256": signature },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    reply = undefined;
    out(`failed the worker could not be reached at ${url}: ${error?.cause?.message ?? error?.message ?? error}`);
  }
  if (reply !== undefined) {
    const text = await reply.text().catch(() => "");
    let said;
    try { said = JSON.parse(text); } catch { said = undefined; }
    const refusal = typeof said?.refusal === "string" ? `: ${said.refusal}` : "";
    const list = said?.jobs;
    const clean = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    const fine = (job) => typeof job?.workflow === "string" && typeof job?.repo === "string" && Number.isInteger(job?.number);
    if (reply.status === 404) out("no-door");
    else if (reply.status === 401) out(`failed the worker refused the question's signature (401${refusal}): the dispatcher's WORKER_SECRET is not the worker's`);
    else if (reply.status !== 200) out(`failed the worker answered ${reply.status}${clean(refusal)}`);
    else if (!Array.isArray(list) || !list.every(fine)) out("failed the worker's answer is not a list of jobs");
    else out("jobs", ...list.map((job) => clean(`${job.workflow} on ${job.repo}#${job.number}${typeof job.id === "string" ? `, job ${job.id}` : ""}`)));
  }
}
EOF
if [ -z "$running" ]; then
  echo "  cannot tell: the worker is asked from inside $CONTAINER, which is not running"
elif ! answer=$(docker exec -i "$CONTAINER" node --input-type=module - <<<"$ask_script" 2>&1); then
  echo "  cannot tell: $CONTAINER could not be asked to ask it: ${answer:-docker exec failed}"
else
  case "$answer" in
    jobs) answered=1; echo "  the worker answers, and holds no job" ;;
    jobs*)
      answered=1
      echo "  the worker answers, and holds $(($(wc -l <<<"$answer") - 1)) job(s), in the order they arrived (running or queued):"
      tail -n +2 <<<"$answer" | sed 's/^/    /'
      ;;
    no-door) answered=1; echo "  the worker answers, but has no held door (its release is older than it), so what it holds cannot be told" ;;
    "failed "*) echo "  cannot tell: ${answer#failed }" ;;
    *) echo "  cannot tell: the answer was not one this script reads" ;;
  esac
fi

section "The dispatcher's state file"
setting=$(grep -E '^STATE_FILE=' "$ENV_FILE" 2>/dev/null | tail -n1)
limit=$(grep -E '^SCAN_DISPATCH_LIMIT=[0-9]+$' "$ENV_FILE" 2>/dev/null | tail -n1)
limit=${limit#*=}
limit=${limit:-2}
file=''
if [ ! -r "$ENV_FILE" ]; then
  echo "  cannot tell: $ENV_FILE, which names the state file, cannot be read"
elif [ -z "$setting" ]; then
  echo "  none: $ENV_FILE sets no STATE_FILE, so the dispatcher keeps its jobs and counts in memory only"
else
  case "${setting#STATE_FILE=}" in
    /state/*) file=$STATE_DIR/${setting#STATE_FILE=/state/} ;;
    *) echo "  cannot tell: STATE_FILE is ${setting#STATE_FILE=}, outside the /state mount at $STATE_DIR" ;;
  esac
fi
if [ -z "$file" ]; then
  :
elif [ -d "$(dirname "$file")" ] && [ ! -x "$(dirname "$file")" ]; then
  echo "  cannot tell: $(dirname "$file"), where the state file is, cannot be read"
elif [ ! -e "$file" ]; then
  echo "  cannot tell: there is no $file yet (the dispatcher writes it at its start)"
elif [ ! -f "$file" ] || [ ! -r "$file" ]; then
  echo "  cannot tell: $file cannot be read"
else
  # The file as the dispatcher writes it (service/dispatcher-state.ts): JSON,
  # two spaces deep, one field a line, but an empty list on its header's line
  # ("jobs": []), which opens no list. Each entry becomes one tab-separated line.
  rows=$(awk '
    { line = $0; sub(/^[ \t]+/, "", line); sub(/,$/, "", line) }
    line == "\"version\": 1" { version = 1; next }
    line ~ /^"(asks|jobs)": \[\]$/ { list = ""; next }
    line ~ /^"(asks|jobs)": \[/ { list = substr(line, 2, 4); next }
    line ~ /^\]/ { list = ""; next }
    list != "" && line == "{" { delete f; next }
    list != "" && line == "}" {
      if (list == "asks") print "ask\t" f["repo"] "\t" f["number"] "\t" f["label"] "\t" f["dispatches"] "\t" f["told"]
      else print "job\t" f["order"] "\t" f["workflow"] "\t" f["repo"] "\t" f["number"] "\t" f["id"] "\t" f["deadline"] "\t" f["posted"]
      next
    }
    list != "" && match(line, /^"[a-z]+": /) {
      key = substr(line, 2, RLENGTH - 4); value = substr(line, RLENGTH + 1)
      gsub(/^"|"$/, "", value); gsub(/[\001-\037\177\t]/, " ", value); f[key] = value
    }
    END { if (!version) print "unknown" }
  ' "$file")
  if grep -qx unknown <<<"$rows"; then
    echo "  cannot tell: $file is not a state file this script reads (its version is not 1)"
  else
    answered=1
    jobs=$(grep $'^job\t' <<<"$rows" | sort -t $'\t' -k2,2n)
    full=$(grep $'^ask\t' <<<"$rows" | awk -F '\t' -v limit="$limit" '$5 >= limit')
    total() { if [ -z "$1" ]; then echo 0; else wc -l <<<"$1" | tr -d ' '; fi; }
    echo "  $file records $(total "$jobs") dispatched job(s), oldest first:"
    if [ -n "$jobs" ]; then
      head -n "$count" <<<"$jobs" | awk -F '\t' '{ printf "    %s on %s#%s, job %s, deadline %s%s\n", $3, $4, $5, $6, $7, ($8 == "true" ? "" : ", not yet handed to the worker") }'
    fi
    echo "  and $(total "$full") item(s) at SCAN_DISPATCH_LIMIT ($limit), which the scan leaves for a person:"
    if [ -n "$full" ]; then
      head -n "$count" <<<"$full" | awk -F '\t' '{ printf "    %s#%s, %s, started %s times%s\n", $2, $3, $4, $5, ($6 == "true" ? ", commented on" : "") }'
    fi
  fi
fi

if [ "$answered" -eq 0 ]; then
  echo
  echo "No part answered."
  exit 1
fi
exit 0
