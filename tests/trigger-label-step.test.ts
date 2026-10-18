import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs each workflow's last step, `Always remove the trigger label`, the real
 * `run:` block read out of its reusable workflow, under `bash -e` against a
 * `gh` that records what it was asked, and with which token, and answers the
 * one read the step makes.
 *
 * What it executes is #236: a trigger label is on while its run works and
 * comes off however the run ends.
 *
 * Review's is no step any more: `review:conclude` takes `agent:review` off
 * and asks for it again (#419), and `tests/review/conclude.test.ts` holds
 * those scenarios. Nor is fix's: `fix:conclude` takes `agent:fix` off (#469),
 * and `tests/fix/conclude.test.ts` holds those. Nor is update-branch's:
 * `update-branch:conclude` takes `agent:update-branch` off and asks for it
 * again (#485), and `tests/update-branch/conclude.test.ts` holds those, its
 * update-branch-only cases among them.
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

const STEP = "Always remove the trigger label";

/**
 * The job the step is in: the workflow's own, except where a publish job
 * writes every label, the agent's job holding no token that writes.
 */
const JOB: Readonly<Record<string, string>> = {
  implement: "publish",
  "implement-prd": "publish",
};

const runOf = (command: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[JOB[command] ?? command]?.steps ?? []).find((s) => s.name === STEP);

  expect(step?.run, `${command} has no \`${STEP}\` step`).toBeDefined();
  return step?.run ?? "";
};

interface Scenario {
  readonly status?: "success" | "failure" | "cancelled";
}

/** Each `gh` call, as `<token> <argv>`. */
const run = (command: string, scenario: Scenario = {}): { status: number | null; gh: readonly string[] } => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trigger-step-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const script = path.join(temp, "step.sh");

  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nprintf \'%s %s\\n\' "$GH_TOKEN" "$*" >> "$GH_LOG"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(script, runOf(command));

  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GH_LOG: log,
      GH_TOKEN: "workflow-token",
      ISSUE_NUMBER: "135",
      JOB_STATUS: scenario.status ?? "success",
    },
  });
  const gh = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  fs.rmSync(temp, { recursive: true, force: true });
  return { status: result.status, gh };
};

const TRIGGERS = [
  ["implement", "agent:implement", "issue edit 135"],
  ["implement-prd", "agent:implement", "issue edit 135"],
] as const;

describe.skipIf(!CAN_RUN)("the trigger label step, executed", () => {
  it.each(TRIGGERS.flatMap(([command, label, target]) =>
    (["success", "failure", "cancelled"] as const).map((status) => [command, label, target, status] as const),
  ))("%s: takes %s off when the run ends (%s)", (command, label, target, status) => {
    const outcome = run(command, { status });

    expect(outcome.status).toBe(0);
    expect(outcome.gh[0]).toBe(`workflow-token ${target} --remove-label ${label}`);
    expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([]);
  });
});
