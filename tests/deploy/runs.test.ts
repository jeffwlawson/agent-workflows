import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { REDACTED, serviceRunUrl, SUMMARY_FILE } from "../../service/worker.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `deploy/unraid/runs.sh`, the run index (#604), run against a `WORK_DIR` of
 * fixture runs. The script is copied alone into a scratch directory, as it
 * sits on the box, so no `agent-service.conf` of the checkout's is read, and
 * handed this test's `node` as `NODE`.
 *
 * Each run's directory is named as `serve.ts` names it, the start time with
 * `:` and `.` as `-`, then the job id, and its summary is shaped as
 * `startRun`'s: the job, its phases, its subcommands. Its modification time
 * is set, since that is when the run ended.
 */

const SCRIPT = path.join(import.meta.dirname, "..", "..", "deploy", "unraid", "runs.sh");
/** A token as a log would carry it, which the index must never print. */
const TOKEN = "ghs_live0123456789abcdefghijklmnop";
/** Text from a log, which the index must never print. */
const LOG_TEXT = "a line only the agent's log holds";

const FAILED_ID = "3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b";
const OK_ID = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const DIED_ID = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const GARBLED_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const OLDEST_ID = "0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e";

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) {
    fs.chmodSync(path.join(dir, "work", "runs"), 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A run's directory under `runs`, named for its start and id, as the worker names it. */
const runDir = (runs: string, started: Date, id: string): string => {
  const dir = path.join(runs, `${started.toISOString().replace(/[:.]/g, "-")}-${id}`);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "logs", "implement.log"), `${LOG_TEXT}: GH_TOKEN=${TOKEN}\n`);
  return dir;
};

const summarise = (dir: string, summary: unknown, endedAt: Date): void => {
  const file = path.join(dir, SUMMARY_FILE);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  fs.utimesSync(file, endedAt, endedAt);
};

/** A `WORK_DIR` holding a failed run, a run that went fine, one that died before its summary, one whose summary does not parse, and an old one. */
const setUp = (): { readonly root: string; readonly runs: string; readonly failedDir: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-index-"));
  scratches.push(root);
  fs.copyFileSync(SCRIPT, path.join(root, "runs.sh"));
  const runs = path.join(root, "work", "runs");
  fs.mkdirSync(runs, { recursive: true });
  // Beside the runs, and never to be read: what a link out of a run would reach.
  fs.writeFileSync(path.join(root, "work", "outside.json"), JSON.stringify({ job: { id: "outside", workflow: "review", repo: "x/outside", pr: 1 }, phases: [] }));

  const failedDir = runDir(runs, new Date("2026-11-02T16:02:00.123Z"), FAILED_ID);
  summarise(
    failedDir,
    {
      job: { workflow: "implement", id: FAILED_ID, repo: "owner/repo", issue: 12, appLogin: "loop-app[bot]" },
      phases: [
        { name: "write token", outcome: "success" },
        { name: "implement:gate", outcome: "success" },
        { name: "implement", outcome: `failure (exit 1): GH_TOKEN ${REDACTED} was refused.` },
        { name: "implement:conclude", outcome: "success" },
      ],
      subcommands: [{ subcommand: "implement", env: { GH_TOKEN: REDACTED }, cwd: path.join(failedDir, "checkout"), log: path.join(failedDir, "logs", "implement.log") }],
    },
    new Date("2026-11-02T16:14:30.123Z"),
  );
  const okDir = runDir(runs, new Date("2026-11-02T15:00:00.000Z"), OK_ID);
  summarise(
    okDir,
    {
      job: { workflow: "review", id: OK_ID, repo: "owner/repo", pr: 7 },
      phases: [
        { name: "review:gate", outcome: "success" },
        { name: "review", outcome: "success" },
      ],
      subcommands: [],
    },
    new Date("2026-11-02T15:03:05.000Z"),
  );
  runDir(runs, new Date("2026-11-02T17:30:00.000Z"), DIED_ID);
  fs.writeFileSync(path.join(runDir(runs, new Date("2026-11-02T14:00:00.000Z"), GARBLED_ID), SUMMARY_FILE), `{"job": {"id": "${GARBLED_ID}", "repo": "own`);
  const oldest = runDir(runs, new Date("2026-10-30T09:00:00.000Z"), OLDEST_ID);
  fs.symlinkSync(path.join(root, "work", "outside.json"), path.join(oldest, SUMMARY_FILE));
  return { root, runs, failedDir };
};

const index = (root: string, args: readonly string[] = []) => {
  const result = spawnSync("bash", [path.join(root, "runs.sh"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: SUBPROCESS_TIMEOUT,
    env: { PATH: process.env["PATH"] ?? "", WORK_DIR: path.join(root, "work"), NODE: process.execPath },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}`, lines: result.stdout.trim().split("\n") };
};

describe("runs.sh, the run index", () => {
  it("lists the runs newest first, with start, job id, kind, repository and number, how each phase ended, and duration", () => {
    const { root } = setUp();
    const { status, output, lines } = index(root);

    expect(status).toBe(0);
    const listed = lines.slice(1, -1);
    expect(listed.map((line) => [DIED_ID, FAILED_ID, OK_ID, GARBLED_ID, OLDEST_ID].find((id) => line.includes(id)))).toEqual([
      DIED_ID,
      FAILED_ID,
      OK_ID,
      GARBLED_ID,
      OLDEST_ID,
    ]);
    expect(listed[1]).toBe(
      `2026-11-02 16:02:00Z  ${FAILED_ID}  implement  owner/repo#12  FAILED  12m30s  write token=success implement:gate=success implement=failure implement:conclude=success`,
    );
    expect(listed[2]).toBe(`2026-11-02 15:00:00Z  ${OK_ID}  review  owner/repo#7  ok  3m05s  review:gate=success review=success`);
    expect(listed[0]).toBe(`2026-11-02 17:30:00Z  ${DIED_ID}  no summary.json: the run died before it wrote one, or is still running`);
    expect(listed[3]).toBe(`2026-11-02 14:00:00Z  ${GARBLED_ID}  summary.json does not parse`);
    expect(listed[4]).toBe(`2026-10-30 09:00:00Z  ${OLDEST_ID}  summary.json is not a file`);
    expect(output).not.toContain("x/outside");
  });

  it("lists as many as it is asked for, 20 by default", () => {
    const { root, runs } = setUp();
    for (let at = 0; at < 20; at += 1) runDir(runs, new Date(Date.UTC(2026, 8, 1, 0, at)), `extra-${at}`);
    const { status, lines } = index(root);

    expect(status).toBe(0);
    expect(lines[0]).toContain("The 20 most recent of 25 runs");
    expect(lines.slice(1, -1)).toHaveLength(20);
  });

  it("lists the count given", () => {
    const { root } = setUp();
    const { status, lines } = index(root, ["2"]);

    expect(status).toBe(0);
    expect(lines.slice(1, -1).map((line) => line.split("  ")[1])).toEqual([DIED_ID, FAILED_ID]);
  });

  it("prints, given a job id, that run's directory and its phases in full", () => {
    const { root, failedDir } = setUp();
    const { status, output } = index(root, [FAILED_ID]);

    expect(status).toBe(0);
    expect(output).toBe(
      [
        `Run ${FAILED_ID}`,
        `  directory: ${failedDir}`,
        "  started:   2026-11-02 16:02:00Z",
        "  job:       implement on owner/repo#12",
        "  ended:     FAILED, after 12m30s",
        "  phases:",
        "    write token: success",
        "    implement:gate: success",
        `    implement: failure (exit 1): GH_TOKEN ${REDACTED} was refused.`,
        "    implement:conclude: success",
        "",
      ].join("\n"),
    );
  });

  it("finds the run by the id the service's link ends with", () => {
    const { root } = setUp();
    const link = serviceRunUrl("loop-app[bot]", FAILED_ID);
    const { status, output } = index(root, [link.slice(link.indexOf("#job-") + "#job-".length)]);

    expect(status).toBe(0);
    expect(output).toContain(`Run ${FAILED_ID}`);
  });

  it("says, given a run that left no summary, that it left none", () => {
    const { root } = setUp();
    const { status, output } = index(root, [DIED_ID]);

    expect(status).toBe(0);
    expect(output).toContain("no summary.json: the run died before it wrote one");
  });

  it("says plainly when no run has the id", () => {
    const { root, runs } = setUp();
    const { status, output } = index(root, ["no-such-job"]);

    expect(status).toBe(1);
    expect(output).toBe(`No run in ${runs} has job id no-such-job.\n`);
  });

  it("prints no token, no log text and nothing from outside the runs, in the list or for any one run", () => {
    const { root } = setUp();
    const outputs = [index(root), ...[FAILED_ID, OK_ID, DIED_ID, GARBLED_ID, OLDEST_ID].map((id) => index(root, [id]))].map((r) => r.output);

    for (const output of outputs) {
      expect(output).not.toContain(TOKEN);
      expect(output).not.toContain(LOG_TEXT);
      expect(output).not.toContain("outside");
    }
  }, 6 * SUBPROCESS_TIMEOUT);

  it("refuses an argument it does not know", () => {
    const { root } = setUp();
    const { status, output } = index(root, ["--prune"]);

    expect(status).toBe(2);
    expect(output).toContain("Unknown option '--prune'");
  });

  it.skipIf(process.getuid?.() === 0)("refuses to run as a user that cannot read the runs, saying why", () => {
    const { root, runs } = setUp();
    fs.chmodSync(runs, 0o000);
    const { status, output } = index(root);

    expect(status).toBe(2);
    expect(output).toContain(`cannot read ${runs}: it is the worker user's alone. Run this as root`);
  });
});
