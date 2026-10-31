import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs each workflow's measure of how its job ended, the real `run:` block
 * read out of its reusable workflow, under `bash -e`, and reads what it hands
 * over.
 *
 * This file ran each workflow's failure step once, and what it executed was
 * how the step told three endings apart (#220). A job that reaches its
 * `timeout-minutes` is **cancelled**, not failed, and before #220 the step
 * ran on `failure()` alone, so a timed-out run posted nothing. Then it ran on
 * both, said "timed out after N minutes" where the job ran its whole limit,
 * "cancelled" where it did not, and the reason the runner wrote where it
 * failed, in the one pattern every one of them is written in (#253):
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
 * `tests/implement-prd/conclude.test.ts` holds those. Nor, last, is
 * follow-ups': `follow-ups:conclude` says how its run ended (#511), and
 * `tests/follow-ups/conclude.test.ts` holds those. What stays here of each
 * is the half that is still YAML, the job's own measure of whether it ran
 * out of time, which only Actions' clock knows.
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

const stepOf = (command: string, job: string, name: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[job]?.steps ?? []).find((s) => s.name === name);

  expect(step?.run, `${command} has no \`${name}\` step in \`${job}\``).toBeDefined();
  return step?.run ?? "";
};

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

/**
 * Follow-ups' job's measure of whether it ran out of time (#511), in its own
 * last steps, read off the clock its first step started. As review's, only a
 * cancel counts: a failure has `follow-ups:file`'s reason to speak for it.
 */
describe.skipIf(!CAN_RUN)("follow-ups' job hands over whether it timed out", () => {
  const MEASURE = ["follow-ups", "follow-ups", "Measure how the job ended"] as const;

  it("says a job cancelled at its limit timed out", () => {
    expect(jobOutcome("cancelled", 10 * 60, "10", {}, MEASURE)["timed-out"]).toBe("true");
  });

  it("says a job cancelled early, or one that failed at its limit, did not time out", () => {
    expect(jobOutcome("cancelled", 120, "10", {}, MEASURE)["timed-out"]).toBe("false");
    expect(jobOutcome("failure", 10 * 60, "10", {}, MEASURE)["timed-out"]).toBe("false");
  }, 2 * SUBPROCESS_TIMEOUT);

  /** `fromJSON` reads each as a number, which bash arithmetic does not: not compared, it reads as no timeout. */
  it.each(["1.5", "1e1", "1.0", "0", "-5"])("reads a limit of %s it cannot compare as no timeout", (minutes) => {
    expect(jobOutcome("cancelled", 10 * 60, minutes, {}, MEASURE)["timed-out"]).toBe("false");
  });
});
