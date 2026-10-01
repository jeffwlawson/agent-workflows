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
 * comes off however the run ends, and a review or a refresh whose pull request
 * moved while it worked, because somebody pushed, asks for itself again.
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

const runOf = (command: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[command]?.steps ?? []).find((s) => s.name === STEP);

  expect(step?.run, `${command} has no \`${STEP}\` step`).toBeDefined();
  return step?.run ?? "";
};

const REVIEWED = "1111111111111111111111111111111111111111";
const PUSHED = "2222222222222222222222222222222222222222";

interface Scenario {
  readonly status?: "success" | "failure" | "cancelled";
  readonly proceeded?: string;
  /** What `gh pr view --json state,headRefOid,labels --jq …` prints: state, head and the trigger labels on it, comma-joined. */
  readonly live?: string;
  readonly pat?: boolean;
}

/** Each `gh` call, as `<token> <argv>`. */
const run = (command: string, scenario: Scenario = {}): { status: number | null; gh: readonly string[] } => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trigger-step-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const script = path.join(temp, "step.sh");

  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\nprintf \'%s %s\\n\' "$GH_TOKEN" "$*" >> "$GH_LOG"\n[ "$1 $2" = "pr view" ] && printf \'%s\\n\' "$GH_VIEW"\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(script, runOf(command));

  const pat = scenario.pat ?? true;
  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GH_LOG: log,
      GH_TOKEN: "workflow-token",
      GH_VIEW: scenario.live ?? `OPEN ${REVIEWED}`,
      ISSUE_NUMBER: "135",
      PR_NUMBER: "152",
      PROCEEDED: scenario.proceeded ?? "true",
      JOB_STATUS: scenario.status ?? "success",
      LEFT_SHA: REVIEWED,
      HAS_PAT: String(pat),
      REQUEST_TOKEN: pat ? "pat-token" : "workflow-token",
    },
  });
  const gh = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  fs.rmSync(temp, { recursive: true, force: true });
  return { status: result.status, gh };
};

const TRIGGERS = [
  ["implement", "agent:implement", "issue edit 135"],
  ["implement-prd", "agent:implement", "issue edit 135"],
  ["review", "agent:review", "pr edit 152"],
  ["fix", "agent:fix", "pr edit 152"],
  ["update-branch", "agent:update-branch", "pr edit 152"],
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

  describe.each([
    ["review", "agent:review"],
    ["update-branch", "agent:update-branch"],
  ] as const)("%s", (command, label) => {
    /**
     * The acceptance case: a push while the run worked moved the head, and a
     * label added then fired nothing, since it was on. So the step asks again,
     * removed and then added, the add with the PAT so that it starts a run.
     */
    it(`asks for ${label} again where somebody pushed while it worked`, () => {
      const outcome = run(command, { live: `OPEN ${PUSHED}` });

      expect(outcome.status).toBe(0);
      const adds = outcome.gh.filter((call) => call.includes("--add-label"));
      expect(adds).toEqual([`pat-token pr edit 152 --add-label ${label}`]);
      expect(outcome.gh.indexOf(`workflow-token pr edit 152 --remove-label ${label}`)).toBeLessThan(
        outcome.gh.indexOf(adds[0] ?? ""),
      );
    });

    /**
     * Another trigger label is a run queued in the same concurrency group, and
     * a request now would cancel it while pending, before its own last step
     * could take its label off.
     */
    it.each(["agent:fix", "agent:update-branch", "agent:review"])(
      "asks for nothing, and leaves a queued run alone, where %s is on",
      (other) => {
        const outcome = run(command, { live: `OPEN ${PUSHED} ${other}` });

        expect(outcome.status).toBe(0);
        expect(outcome.gh).toEqual([
          `workflow-token pr edit 152 --remove-label ${label}`,
          expect.stringContaining("pr view 152"),
        ]);
      },
    );

    it("asks for nothing where the head is still the one it left", () => {
      const outcome = run(command, { live: `OPEN ${REVIEWED}` });

      expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([]);
    });

    it.each(["failure", "cancelled"] as const)("asks for nothing after a run that ended %s", (status) => {
      const outcome = run(command, { status, live: `OPEN ${PUSHED}` });

      expect(outcome.gh).toEqual([`workflow-token pr edit 152 --remove-label ${label}`]);
    });

    it("asks for nothing after a refusal", () => {
      const outcome = run(command, { proceeded: "false", live: `OPEN ${PUSHED}` });

      expect(outcome.gh).toEqual([`workflow-token pr edit 152 --remove-label ${label}`]);
    });

    it.each(["CLOSED", "MERGED", ""])("asks for nothing on a pull request that is %s", (state) => {
      const outcome = run(command, { live: state === "" ? "" : `${state} ${PUSHED}` });

      expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([]);
    });

    /** A label added with `GITHUB_TOKEN` starts nothing, so it says so instead of adding one. */
    it("says so on the pull request rather than adding a label that starts nothing, without the PAT", () => {
      const outcome = run(command, { live: `OPEN ${PUSHED}`, pat: false });

      expect(outcome.status).toBe(0);
      expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([]);
      const comment = outcome.gh.find((call) => call.includes("pr comment 152"));
      expect(comment).toContain(PUSHED);
      expect(comment).toContain(`Add \`${label}\` by hand`);
    });
  });
});
