import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs each workflow's failure step, the real `run:` block read out of its
 * reusable workflow, under `bash -e` against a `gh` that records what it was
 * asked and does nothing else.
 *
 * What it executes is how the step tells three endings apart (#220). A job
 * that reaches its `timeout-minutes` is **cancelled**, not failed, and before
 * #220 the step ran on `failure()` alone, so a timed-out run posted nothing.
 * Now it runs on both, and says "timed out after N minutes" where the job ran
 * its whole limit, "cancelled" where it did not, and "failed" as it always did.
 *
 * Skipped where `bash` is not on PATH.
 */

const CAN_RUN =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v bash"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

interface Step {
  readonly name?: string;
  readonly run?: string;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

/**
 * Each failure step, the job it is in, and the limit that job runs under when
 * no variable is set: today's value, which a timeout comment has to name.
 */
const CASES = [
  { command: "implement", step: "Mark blocked on failure", minutes: 30, blocks: true },
  { command: "implement-prd", step: "Mark blocked on failure", minutes: 30, blocks: true },
  { command: "fix", step: "Mark blocked on failure", minutes: 30, blocks: true },
  { command: "update-branch", step: "Mark blocked on failure", minutes: 30, blocks: true },
  { command: "review", step: "Mark blocked on failure", minutes: 20, blocks: true },
  // No `agent:blocked` on a merged pull request, on a failure or otherwise:
  // there is no pipeline left there to block (see the step's own note).
  { command: "follow-ups", step: "Report the failure on the PR", minutes: 10, blocks: false },
] as const;

type Case = (typeof CASES)[number];

const runOf = (c: Case): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${c.command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[c.command]?.steps ?? []).find((s) => s.name === c.step);

  expect(step?.run, `${c.command} has no \`${c.step}\` step`).toBeDefined();
  return step?.run ?? "";
};

interface Outcome {
  readonly status: number | null;
  readonly comment: string;
  readonly gh: readonly string[];
}

/**
 * The step, run as it would be once the job has ended `status`, `elapsed`
 * seconds after the clock was started. A reason file is written as a runner
 * that failed would have written it. `minutes` is the limit as the step reads
 * it, the job's own where it is not given.
 */
const run = (
  c: Case,
  status: "failure" | "cancelled",
  elapsed: number,
  minutes = String(c.minutes),
  refused = "false",
): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-failure-step-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const script = path.join(temp, "step.sh");

  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(temp, "failure_reason.txt"), "The runner wrote this.\n");
  fs.writeFileSync(script, runOf(c));

  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GH_LOG: log,
      RUNNER_TEMP: temp,
      ISSUE_NUMBER: "135",
      PR_NUMBER: "152",
      RUN_URL: "https://github.com/acme/widgets/actions/runs/1",
      JOB_STATUS: status,
      JOB_STARTED: String(Math.floor(Date.now() / 1000) - elapsed),
      TIMEOUT_MINUTES: minutes,
      REFUSED: refused,
    },
  });
  const comment = path.join(temp, "failure-comment.md");

  return {
    status: result.status,
    comment: fs.existsSync(comment) ? fs.readFileSync(comment, "utf8") : "",
    gh: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [],
  };
};

describe.skipIf(!CAN_RUN)("a failure step says whether the run failed, timed out or was cancelled", () => {
  it.each(CASES)("$command: a run that reached its limit says it timed out, naming the limit", (c: Case) => {
    const outcome = run(c, "cancelled", c.minutes * 60);

    expect(outcome.status).toBe(0);
    expect(outcome.comment).toContain(`timed out after ${c.minutes} minutes`);
    expect(outcome.comment).not.toMatch(/cancelled|failed/);
    expect(outcome.comment).not.toContain("The runner wrote this.");
    expect(outcome.gh.some((argv) => argv.includes("--add-label agent:blocked"))).toBe(c.blocks);
    expect(outcome.gh.some((argv) => / comment /.test(` ${argv} `))).toBe(true);
  });

  it.each(CASES)("$command: a run stopped by hand says it was cancelled, not timed out", (c: Case) => {
    const outcome = run(c, "cancelled", 120);

    expect(outcome.comment).toContain("cancelled");
    expect(outcome.comment).not.toContain("timed out");
    expect(outcome.gh.some((argv) => argv.includes("--add-label agent:blocked"))).toBe(c.blocks);
  });

  it.each(CASES)("$command: a failed run still reads its reason, whatever the clock says", (c: Case) => {
    const outcome = run(c, "failure", c.minutes * 60);

    expect(outcome.comment).toContain("failed");
    expect(outcome.comment).toContain("The runner wrote this.");
    expect(outcome.comment).not.toMatch(/timed out|cancelled/);
    expect(outcome.gh.some((argv) => argv.includes("--add-label agent:blocked"))).toBe(c.blocks);
  });

  /**
   * A limit `fromJSON` reads as a number but bash arithmetic does not: `1.5`,
   * `1e1`, `1.0`, and the ones it reads but that are no limit, `0` and `-5`.
   * Compared, the first three ended the step under `bash -e` before its comment,
   * which is the silent timeout #220 removes. Not compared, the run reads as
   * cancelled, and still says so.
   */
  const UNCOMPARABLE = ["1.5", "1e1", "1.0", "0", "-5"] as const;

  it.each(CASES)("$command: a limit it cannot compare still ends in a comment", (c: Case) => {
    for (const minutes of UNCOMPARABLE) {
      // Each is a number to `fromJSON`, so the job itself would have started.
      expect(typeof JSON.parse(minutes), minutes).toBe("number");

      const outcome = run(c, "cancelled", c.minutes * 60, minutes);

      expect(outcome.status, minutes).toBe(0);
      expect(outcome.comment, minutes).toContain("was cancelled");
      expect(outcome.comment, minutes).not.toContain("timed out");
      expect(outcome.gh.some((argv) => argv.includes("--add-label agent:blocked")), minutes).toBe(c.blocks);
      expect(outcome.gh.some((argv) => / comment /.test(` ${argv} `)), minutes).toBe(true);
    }
  });

  /**
   * The loop's one order (#236): every result posted, then the run's own
   * label off, then the label naming the next step, which on a failure is
   * `agent:blocked`. So nobody sees the issue or pull request blocked with
   * no word of why, nor blocked while it still reads as a run in progress.
   */
  const TRIGGER: Readonly<Record<string, string>> = {
    implement: "issue edit 135 --remove-label agent:implement",
    "implement-prd": "issue edit 135 --remove-label agent:implement",
    fix: "pr edit 152 --remove-label agent:fix",
    "update-branch": "pr edit 152 --remove-label agent:update-branch",
    review: "pr edit 152 --remove-label agent:review",
  };

  it.each(CASES.filter((c) => c.blocks))("$command: comments, then takes its label off, then blocks", (c: Case) => {
    for (const status of ["failure", "cancelled"] as const) {
      const outcome = run(c, status, 120);
      const comment = outcome.gh.findIndex((argv) => / comment /.test(` ${argv} `));
      const removal = outcome.gh.indexOf(TRIGGER[c.command] ?? "");
      const blocked = outcome.gh.findIndex((argv) => argv.includes("--add-label agent:blocked"));

      expect(outcome.status, status).toBe(0);
      expect(comment, status).toBeGreaterThanOrEqual(0);
      expect(removal, status).toBeGreaterThan(comment);
      expect(blocked, status).toBeGreaterThan(removal);
    }
  });

  /**
   * Except the label, on an implement run whose preflight died before it
   * decided the issue was its own: that may be the sibling's event, and the
   * sibling's run holds the label while it works.
   */
  it.each(CASES.filter((c) => c.command === "implement" || c.command === "implement-prd"))(
    "$command: leaves the label on where the preflight never decided",
    (c: Case) => {
      const outcome = run(c, "failure", 120, String(c.minutes), "");

      expect(outcome.gh).not.toContain(TRIGGER[c.command]);
      expect(outcome.gh.some((argv) => argv.includes("--add-label agent:blocked"))).toBe(true);
    },
  );
});
