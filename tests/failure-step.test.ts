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
 * its whole limit, "cancelled" where it did not, and the reason the runner
 * wrote where it failed.
 *
 * And it executes the one pattern every one of them is written in (#253):
 * `**\`agent:X\` stopped:** <Reason>.`, then the run and what to do.
 *
 * Review's is no step any more: `review:conclude` says how its run ended
 * (#419), and `tests/review/conclude.test.ts` holds those scenarios. Nor is
 * fix's: `fix:conclude` says how its run ended (#469), and
 * `tests/fix/conclude.test.ts` holds those. Nor is update-branch's:
 * `update-branch:conclude` says how its run ended (#485), and
 * `tests/update-branch/conclude.test.ts` holds those. Nor is implement's:
 * `implement:conclude` says how its run ended (#493), and
 * `tests/implement/conclude.test.ts` holds those. Nor is implement-prd's:
 * `implement-prd:conclude` says how its run ended (#505), and
 * `tests/implement-prd/conclude.test.ts` holds those. What is left is
 * follow-ups', until its own move (#478). What stays here of each
 * is the half that is still YAML, the agent's job's own measure of whether it
 * ran out of time, which only Actions' clock knows.
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
  // No `agent:blocked` on a merged pull request, on a failure or otherwise:
  // there is no pipeline left there to block (see the step's own note).
  { command: "follow-ups", label: "agent:follow-ups", step: "Report the failure on the PR", minutes: 10, blocks: false },
] as const;

type Case = (typeof CASES)[number];


const stepOf = (command: string, job: string, name: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[job]?.steps ?? []).find((s) => s.name === name);

  expect(step?.run, `${command} has no \`${name}\` step in \`${job}\``).toBeDefined();
  return step?.run ?? "";
};

const runOf = (c: Case): string => stepOf(c.command, c.command, c.step);

/** `name=value` and `name<<DELIMITER … DELIMITER` lines, as GitHub reads an output file. */
const outputsOf = (text: string): Record<string, string> => {
  const outputs: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const heredoc = /^([\w-]+)<<(.+)$/.exec(line);
    if (heredoc !== null) {
      const end = lines.indexOf(heredoc[2] ?? "", i + 1);
      outputs[heredoc[1] ?? ""] = lines.slice(i + 1, end).join("\n");
      i = end;
      continue;
    }
    const pair = /^([\w-]+)=(.*)$/.exec(line);
    if (pair !== null) outputs[pair[1] ?? ""] = pair[2] ?? "";
  }
  return outputs;
};

/**
 * An agent's job's half: review's *Hand the outcome to the posting job*
 * (#257), or the `step` named, run as the job ended `status`, `elapsed`
 * seconds after its clock started, with the reason files `files` in its
 * temp. What it hands over is what the concluding command is told: its
 * outputs.
 */
const jobOutcome = (
  status: "success" | "failure" | "cancelled",
  elapsed: number,
  minutes: string,
  files: Readonly<Record<string, string>> = {},
  step: readonly [command: string, job: string, name: string] = ["review", "review", "Hand the outcome to the posting job"],
): Record<string, string> => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-outcome-"));
  const script = path.join(temp, "outcome.sh");
  const output = path.join(temp, "outcome.out");
  fs.writeFileSync(script, stepOf(...step));
  fs.writeFileSync(output, "");
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(temp, name), text);
  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      JOB_STATUS: status,
      JOB_STARTED: String(Math.floor(Date.now() / 1000) - elapsed),
      TIMEOUT_MINUTES: minutes,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const outputs = outputsOf(fs.readFileSync(output, "utf8"));
  fs.rmSync(temp, { recursive: true, force: true });
  return outputs;
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
  files: Readonly<Record<string, string>> = { "failure_reason.txt": "The runner wrote this.\n" },
  extra: Readonly<Record<string, string>> = {},
): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-failure-step-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const script = path.join(temp, "step.sh");

  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\n', { mode: 0o755 });
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(temp, name)), { recursive: true });
    fs.writeFileSync(path.join(temp, name), text);
  }
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
      // How a split run's publish job sees the jobs ahead of it end. Read
      // only by the steps of a split run, which read `JOB_STATUS` as their own.
      GATE_RESULT: "success",
      AGENT_RESULT: status,
      JOB_STARTED: String(Math.floor(Date.now() / 1000) - elapsed),
      TIMEOUT_MINUTES: minutes,
      REFUSED: refused,
      ...extra,
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

    expect(outcome.comment).toContain("The runner wrote this.");
    expect(outcome.comment).not.toMatch(/timed out|cancelled/);
    expect(outcome.gh.some((argv) => argv.includes("--add-label agent:blocked"))).toBe(c.blocks);
  });

  /**
   * One pattern for every run that stopped (#253), whichever way it stopped:
   * the label in bold and `stopped:`, the reason as a sentence starting with a
   * capital and ending in a full stop, then the run's link and what to do.
   */
  it.each(CASES)("$command: says it stopped in the one pattern, however it ended", (c: Case) => {
    const pattern = new RegExp(
      `^\\*\\*\`${c.label}\` stopped:\\*\\* [A-Z][^\\n]*[.!?]\\n\\n\\[Workflow run\\]\\(https://github\\.com/acme/widgets/actions/runs/1\\) · [A-Z][^\\n]*\\.\\n$`,
    );

    for (const [status, elapsed] of [["failure", 120], ["cancelled", 120], ["cancelled", c.minutes * 60]] as const) {
      expect(run(c, status, elapsed).comment, `${status} after ${elapsed}s`).toMatch(pattern);
    }
    // A reason written in lower case and with no full stop is made a sentence.
    const lower = run(c, "failure", 120, String(c.minutes), "false", { "failure_reason.txt": "the push was rejected\n" });
    expect(lower.comment).toContain("stopped:** The push was rejected.\n");
    // And one that wrote no reason at all still says so in words.
    const none = run(c, "failure", 120, String(c.minutes), "false", {});
    expect(none.comment).toMatch(pattern);
    expect(none.comment).toContain("It stopped without giving a reason.");
    // Five runs, so five spawns' worth of ceiling (`vitest.config.ts`).
  }, 5 * SUBPROCESS_TIMEOUT);

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
});

/**
 * The review job's measure of how it ended (#220, #257), which stays YAML:
 * only that job's clock knows whether a cancel was its limit (ADR 0003). What
 * it hands over is what `review:conclude` says, and conclude's tests take it
 * from there.
 */
describe.skipIf(!CAN_RUN)("review hands over how its job ended", () => {
  it("says a job cancelled at its limit timed out", () => {
    expect(jobOutcome("cancelled", 20 * 60, "20")["timed-out"]).toBe("true");
  });

  it("says a job cancelled early, or one that failed at its limit, did not time out", () => {
    expect(jobOutcome("cancelled", 120, "20")["timed-out"]).toBe("false");
    expect(jobOutcome("failure", 20 * 60, "20")["timed-out"]).toBe("false");
  }, 2 * SUBPROCESS_TIMEOUT);

  /** `fromJSON` reads each as a number, which bash arithmetic does not: not compared, it reads as a cancel. */
  it.each(["1.5", "1e1", "1.0", "0", "-5"])("reads a limit of %s it cannot compare as no timeout", (minutes) => {
    expect(jobOutcome("cancelled", 20 * 60, minutes)["timed-out"]).toBe("false");
  });

  it("hands over the reason and the refusal the runner wrote, whole", () => {
    const outputs = jobOutcome("failure", 120, "20", {
      "failure_reason.txt": "The agent stopped.\nOn a second line.\n",
      "refusal_reason.txt": "The repository variable `AGENT_MAX_FIX_ROUNDS` is `abc`.\n",
    });

    expect(outputs["failure-reason"]).toBe("The agent stopped.\nOn a second line.");
    expect(outputs["refusal-reason"]).toBe("The repository variable `AGENT_MAX_FIX_ROUNDS` is `abc`.");
  });
});

/**
 * Fix's agent's job's measure of whether it ran out of time (#469),
 * update-branch's (#485), implement's (#493) and implement-prd's (#505),
 * read off the gate's clock in its last step, which stays YAML for the same
 * reason. Unlike review's, a failure at the limit counts too: `needs` may
 * read a job that reached its limit as failed, and each conclude reads the
 * answer only where a cancel or a failure left no reason.
 */
describe.skipIf(!CAN_RUN).each(["fix", "update-branch", "implement", "implement-prd"])("%s's agent job hands over whether it timed out", (command) => {
  const FIX = [command, command, "Measure how the agent's job ended"] as const;

  it.each(["cancelled", "failure"] as const)("says a job that ended %s at its limit timed out", (status) => {
    expect(jobOutcome(status, 30 * 60, "30", {}, FIX)["timed-out"]).toBe("true");
  });

  it("says a job that ended early, or one that succeeded at its limit, did not time out", () => {
    expect(jobOutcome("cancelled", 120, "30", {}, FIX)["timed-out"]).toBe("false");
    expect(jobOutcome("success", 30 * 60, "30", {}, FIX)["timed-out"]).toBe("false");
  }, 2 * SUBPROCESS_TIMEOUT);

  /** `fromJSON` reads each as a number, which bash arithmetic does not: not compared, it reads as no timeout. */
  it.each(["1.5", "1e1", "1.0", "0", "-5"])("reads a limit of %s it cannot compare as no timeout", (minutes) => {
    expect(jobOutcome("cancelled", 30 * 60, minutes, {}, FIX)["timed-out"]).toBe("false");
  });
});
