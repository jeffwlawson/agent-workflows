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

/**
 * The job the step is in: the workflow's own, except the review's, whose
 * posting job writes every label (#257), and implement's, whose publish job
 * does, the agent's job holding no token that writes.
 */
const JOB: Readonly<Record<string, string>> = {
  review: "post-review",
  implement: "publish",
  fix: "publish",
  "update-branch": "publish",
  "implement-prd": "publish",
};

const runOf = (command: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[JOB[command] ?? command]?.steps ?? []).find((s) => s.name === STEP);

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
  /** The loop's token resolver's `source` (#320): `app`, `pat` or `workflow`. */
  readonly source?: "app" | "pat" | "workflow";
  /** update-branch's `steps.request.outputs.requested`: this run asked for the review of its resolution. */
  readonly requested?: string;
  /** The review job's result, as its posting job reads it (#257). */
  readonly reviewed?: "success" | "failure" | "cancelled";
  /**
   * update-branch's gate's and agent's job's results, as its publish job
   * reads them (#308). The agent's is skipped on a clean merge.
   */
  readonly gate?: "success" | "failure" | "cancelled";
  readonly agent?: "success" | "failure" | "cancelled" | "skipped";
}

/** Each `gh` call, as `<token> <argv>`, and what the step wrote to `GITHUB_OUTPUT`. */
const run = (
  command: string,
  scenario: Scenario = {},
): { status: number | null; gh: readonly string[]; output: string } => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trigger-step-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const script = path.join(temp, "step.sh");
  // Its own, never the runner's: a test run inside a workflow job inherits
  // that job's `GITHUB_OUTPUT`, and would write this step's outputs into it.
  const output = path.join(temp, "output");
  fs.writeFileSync(output, "");

  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\nprintf \'%s %s\\n\' "$GH_TOKEN" "$*" >> "$GH_LOG"\n[ "$1 $2" = "pr view" ] && printf \'%s\\n\' "$GH_VIEW"\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(script, runOf(command));

  const source = scenario.source ?? "pat";
  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GH_LOG: log,
      GITHUB_OUTPUT: output,
      REQUESTED: scenario.requested ?? "",
      GH_TOKEN: "workflow-token",
      GH_VIEW: scenario.live ?? `OPEN ${REVIEWED}`,
      ISSUE_NUMBER: "135",
      PR_NUMBER: "152",
      PROCEEDED: scenario.proceeded ?? "true",
      JOB_STATUS: scenario.status ?? "success",
      REVIEW_RESULT: scenario.reviewed ?? "success",
      GATE_RESULT: scenario.gate ?? "success",
      AGENT_RESULT: scenario.agent ?? "skipped",
      LEFT_SHA: REVIEWED,
      TOKEN_SOURCE: source,
      REQUEST_TOKEN: `${source}-token`,
    },
  });
  const gh = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  const written = fs.readFileSync(output, "utf8");
  fs.rmSync(temp, { recursive: true, force: true });
  return { status: result.status, gh, output: written };
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

    /**
     * update-branch's publish job ends green however its agent's job ended,
     * so the jobs ahead of it are read by name: a gate or an agent that did
     * not finish is a failure's, which a human retries.
     */
    if (command === "update-branch") {
      it.each([
        { gate: "failure" },
        { gate: "cancelled" },
        { agent: "failure" },
        { agent: "cancelled" },
      ] as const)("asks for nothing after a job ahead of it ended %o", (ended) => {
        const outcome = run(command, { ...ended, live: `OPEN ${PUSHED}` });

        expect(outcome.gh).toEqual([`workflow-token pr edit 152 --remove-label ${label}`]);
      });

      it("asks again after a resolution, where the agent's job succeeded", () => {
        const outcome = run(command, { agent: "success", live: `OPEN ${PUSHED}` });

        expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([`pat-token pr edit 152 --add-label ${label}`]);
      });
    }

    it("asks for nothing after a refusal", () => {
      const outcome = run(command, { proceeded: "false", live: `OPEN ${PUSHED}` });

      expect(outcome.gh).toEqual([`workflow-token pr edit 152 --remove-label ${label}`]);
    });

    it.each(["CLOSED", "MERGED", ""])("asks for nothing on a pull request that is %s", (state) => {
      const outcome = run(command, { live: state === "" ? "" : `${state} ${PUSHED}` });

      expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([]);
    });

    /** The App's token fires the label as the PAT's does (#320). */
    it(`asks for ${label} again with the App's token, where the App is set up`, () => {
      const outcome = run(command, { live: `OPEN ${PUSHED}`, source: "app" });

      expect(outcome.status).toBe(0);
      expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([`app-token pr edit 152 --add-label ${label}`]);
      expect(outcome.gh.filter((call) => call.includes("pr comment"))).toEqual([]);
    });

    /** A label added with `GITHUB_TOKEN` starts nothing, so it says so instead of adding one. */
    it("says so on the pull request rather than adding a label that starts nothing, with neither the App nor the PAT", () => {
      const outcome = run(command, { live: `OPEN ${PUSHED}`, source: "workflow" });

      expect(outcome.status).toBe(0);
      expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([]);
      const comment = outcome.gh.find((call) => call.includes("pr comment 152"));
      expect(comment).toContain(PUSHED);
      expect(comment).toContain(`Add \`${label}\` by hand`);
    });
  });
  /**
   * The review says the head moved, on every arm that found it moved, so that
   * its fix-round and advance hand-offs stand down on a verdict about a commit the pull
   * request has left (#236): re-requested, left to a queued run, or left to a
   * human for want of the PAT.
   */
  it.each([
    ["re-requested", { live: `OPEN ${PUSHED}` }],
    ["left to a queued run", { live: `OPEN ${PUSHED} agent:fix` }],
    ["left to a human without the App or the PAT", { live: `OPEN ${PUSHED}`, source: "workflow" }],
  ] as const)("review: says the head moved where it was %s", (_case, scenario) => {
    expect(run("review", scenario).output).toContain("moved=true");
  });

  it.each([
    ["the head did not move", { live: `OPEN ${REVIEWED}` }],
    ["the run failed", { live: `OPEN ${PUSHED}`, status: "failure" }],
    ["the review job failed", { live: `OPEN ${PUSHED}`, reviewed: "failure" }],
    ["the review job was cancelled", { live: `OPEN ${PUSHED}`, reviewed: "cancelled" }],
    ["the pull request is closed", { live: `CLOSED ${PUSHED}` }],
  ] as const)("review: says nothing about the head where %s", (_case, scenario) => {
    expect(run("review", scenario).output).not.toContain("moved=");
  });

  /**
   * The posting job runs after the review job however it ended (#257), so a
   * review that failed is a result it reads rather than a status of its own,
   * and asks for nothing either.
   */
  it.each(["failure", "cancelled"] as const)("review: asks for nothing after a review job that ended %s", (reviewed) => {
    const outcome = run("review", { reviewed, live: `OPEN ${PUSHED}` });

    expect(outcome.gh).toEqual(["workflow-token pr edit 152 --remove-label agent:review"]);
  });

  /**
   * update-branch hands off one way or the other, never both: where it asked
   * for the review of its resolution, that review is queued in the group, and
   * a second request would cancel it while pending and strand `agent:review`.
   */
  it("update-branch: asks for nothing more where it asked for the review of its resolution", () => {
    const outcome = run("update-branch", { live: `OPEN ${PUSHED}`, requested: "true" });

    expect(outcome.status).toBe(0);
    expect(outcome.gh).toEqual(["workflow-token pr edit 152 --remove-label agent:update-branch"]);
  });
});
