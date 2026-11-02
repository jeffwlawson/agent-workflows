#!/usr/bin/env bash
# runs.sh: the run index (#604). Lists the worker's recent runs, newest first,
# from the summary each leaves in its directory under WORK_DIR/runs: when it
# started, its job id, its workflow, the repository and item, how each phase
# ended, and how long it took. Given a job id, prints that run's directory and
# its phases in full.
#
# The job id is the one the service's "Workflow run" link ends with
# (https://github.com/apps/<slug>#job-<id>) and the run's directory is named
# for: copy it from a comment the service posted.
#
# Read-only. It reads each run's summary.json and nothing else: no log, no
# checkout, no settings file. It prints no log text and no token: the summary
# is redacted already, and this prints only its job's fields and its phases.
# A directory with no summary.json, or one that does not parse, is listed as
# such: a run that died before it wrote one is the one most worth finding.
# Duration is from the start in the directory's name to when the summary was
# written.
#
# Self-contained on purpose, as check-box.sh is: copied alone to the box.
#
# Run on the box, as root (WORK_DIR is the worker user's alone):
#   sudo bash runs.sh [<count>] [<job-id>]
# <count> is how many runs to list, 20 by default. Exits 1 where no run has
# the job id asked for, and 2 where it cannot read the runs at all.
set -uo pipefail

# Settings that differ from the defaults below go in agent-service.conf, beside
# this script (agent-service.conf.example lists them). It is read as shell.
conf="$(dirname "$0")/agent-service.conf"
# shellcheck source=/dev/null
if [ -f "$conf" ]; then . "$conf"; fi

WORK_DIR=${WORK_DIR:-/var/lib/agent-worker}
NODE=${NODE:-/usr/local/bin/node}
RUNS="$WORK_DIR/runs"

count=20 id=
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      sed -n '2,/^set /{/^set /d;s/^# \{0,1\}//;p}' "$0"
      exit 0
      ;;
    -*)
      echo "Unknown option '$arg'. Usage: sudo bash $0 [<count>] [<job-id>]" >&2
      exit 2
      ;;
    *[!0-9]*) if [ -n "$id" ]; then echo "One job id at a time: '$id' and '$arg' were given." >&2; exit 2; fi; id=$arg ;;
    0) echo "The count must be at least 1." >&2; exit 2 ;;
    *) count=$arg ;;
  esac
done

if [ ! -d "$RUNS" ]; then
  if [ -d "$WORK_DIR" ] && [ ! -x "$WORK_DIR" ]; then
    echo "$(id -un) cannot read $WORK_DIR: it is the worker user's alone. Run this as root: sudo bash $0" >&2
  else
    echo "There is no $RUNS: no run has started on this machine, or WORK_DIR in agent-service.conf is not the worker's." >&2
  fi
  exit 2
fi
if [ ! -r "$RUNS" ] || [ ! -x "$RUNS" ]; then
  echo "$(id -un) cannot read $RUNS: it is the worker user's alone. Run this as root: sudo bash $0" >&2
  exit 2
fi
if [ ! -x "$NODE" ]; then
  echo "No Node at $NODE, which reads the summaries: set NODE in agent-service.conf to the worker's." >&2
  exit 2
fi

# shellcheck disable=SC2016
exec "$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const [runs, countArg, wanted] = process.argv.slice(1);
const count = Number(countArg);
const SUMMARY = "summary.json";
/** A run directory is named `<start, with : and . as ->-<job id>`, as the worker names it. */
const NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)$/;
/** Text from a summary, made safe for a terminal: one line, no control characters. */
const clean = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const duration = (ms) => {
  if (!(ms >= 0)) return "-";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};
/** How a phase ended, in a word or two: its outcome up to the reason. */
const brief = (outcome) => clean(outcome).split(/[:(]/)[0].trim().slice(0, 24);
const FAILED = /^(failure|timed out|not run)/;

const read = (name) => {
  const dir = path.join(runs, name);
  const parsed = NAME.exec(name);
  const started = parsed === null ? undefined : new Date(`${parsed[1]}T${parsed[2]}:${parsed[3]}:${parsed[4]}.${parsed[5]}Z`);
  const run = { name, dir, started, id: parsed === null ? undefined : parsed[6] };
  const file = path.join(dir, SUMMARY);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { ...run, problem: "no summary.json: the run died before it wrote one, or is still running" };
  }
  // A link is not followed: nothing outside the runs is read.
  if (!stat.isFile()) return { ...run, problem: "summary.json is not a file" };
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...run, problem: "summary.json does not parse" };
  }
  const job = summary !== null && typeof summary === "object" && summary.job !== null && typeof summary.job === "object" ? summary.job : {};
  const phases = Array.isArray(summary?.phases) ? summary.phases.filter((p) => p !== null && typeof p === "object") : [];
  return {
    ...run,
    id: typeof job.id === "string" ? job.id : run.id,
    kind: job.workflow,
    where: job.repo === undefined ? undefined : `${job.repo}#${job.issue ?? job.pr ?? "?"}`,
    phases: phases.map((p) => ({ name: clean(p.name ?? "?"), outcome: clean(p.outcome ?? "?") })),
    took: started === undefined ? undefined : stat.mtimeMs - started.getTime(),
  };
};

const entries = fs
  .readdirSync(runs, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => read(entry.name))
  .sort((a, b) => (b.started?.getTime() ?? -Infinity) - (a.started?.getTime() ?? -Infinity) || (a.name < b.name ? 1 : -1));
const when = (run) => (run.started === undefined ? "unknown start".padEnd(20) : `${run.started.toISOString().slice(0, 19).replace("T", " ")}Z`);
const ended = (run) => (run.problem !== undefined ? "unknown" : run.phases.some((p) => FAILED.test(p.outcome)) ? "FAILED" : "ok");

if (wanted !== undefined && wanted !== "") {
  const run = entries.find((r) => r.id === wanted || r.name.endsWith(`-${wanted}`));
  if (run === undefined) {
    console.log(`No run in ${runs} has job id ${clean(wanted)}.`);
    process.exit(1);
  }
  console.log(`Run ${clean(run.id ?? "?")}`);
  console.log(`  directory: ${clean(run.dir)}`);
  console.log(`  started:   ${when(run)}`);
  if (run.problem !== undefined) {
    console.log(`  ${run.problem}`);
    process.exit(0);
  }
  console.log(`  job:       ${clean(run.kind ?? "?")} on ${clean(run.where ?? "?")}`);
  console.log(`  ended:     ${ended(run)}, after ${duration(run.took)}`);
  console.log(`  phases:`);
  for (const p of run.phases) console.log(`    ${p.name}: ${p.outcome}`);
  if (run.phases.length === 0) console.log("    (none recorded)");
  process.exit(0);
}

if (entries.length === 0) {
  console.log(`No runs in ${runs}.`);
  process.exit(0);
}
const shown = entries.slice(0, count);
console.log(`The ${shown.length} most recent of ${entries.length} runs in ${runs}, newest first:`);
for (const run of shown) {
  const head = `${when(run)}  ${clean(run.id ?? run.name)}`;
  if (run.problem !== undefined) {
    console.log(`${head}  ${run.problem}`);
    continue;
  }
  const phases = run.phases.map((p) => `${p.name}=${brief(p.outcome)}`).join(" ");
  console.log(`${head}  ${clean(run.kind ?? "?")}  ${clean(run.where ?? "?")}  ${ended(run)}  ${duration(run.took)}  ${phases}`);
}
console.log(`For one run in full: sudo bash runs.sh <job-id>`);
' "$RUNS" "$count" "$id"
