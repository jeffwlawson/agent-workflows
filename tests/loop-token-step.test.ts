import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The loop's token resolver (#319, PRD #314), executed: the choice
 * `.github/actions/loop-token` makes between the App, `AGENT_PAT` and the
 * workflow token, read out of the action and run under `bash`, and what the
 * issue side's label steps do with the source it reports, run against a `gh`
 * that records each call and the token it was made with.
 *
 * Minting is GitHub's own action and is not run here: what the action does
 * with a mint is asserted in `tests/workflows.test.ts`.
 *
 * Skipped where `bash` is not on PATH.
 */

const CAN_RUN =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v bash"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
}
interface Action {
  readonly runs: { readonly steps: readonly Step[] };
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const chooseRun = (): string => {
  const action = parse(fs.readFileSync(path.join(".github", "actions", "loop-token", "action.yml"), "utf8")) as Action;
  const step = action.runs.steps.find((s) => s.id === "choose");

  expect(step?.run, "the resolver has no `choose` step").toBeDefined();
  return step?.run ?? "";
};

const publishStep = (command: string, name: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs["publish"]?.steps ?? []).find((s) => s.name === name);

  expect(step?.run, `${command} has no \`${name}\` step in publish`).toBeDefined();
  return step?.run ?? "";
};

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  /** Each `gh` call, as `<token> <argv>`. */
  readonly gh: readonly string[];
  readonly output: string;
}

/** Runs a script under `bash -e`, with a recording `gh` first on PATH. */
const execute = (script: string, env: Readonly<Record<string, string>>): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-token-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const file = path.join(temp, "step.sh");
  // Its own, never the runner's: a test run inside a workflow job inherits
  // that job's `GITHUB_OUTPUT`.
  const output = path.join(temp, "output");
  fs.writeFileSync(output, "");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\nprintf \'%s %s\\n\' "$GH_TOKEN" "$*" >> "$GH_LOG"\n[ "$1 $2" = "pr view" ] && printf \'%s\\n\' "$PUSHED_SHA"\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(file, script);

  const result = spawnSync("bash", ["-e", file], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GH_LOG: log,
      GITHUB_OUTPUT: output,
      ...env,
    },
  });
  const gh = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  const written = fs.readFileSync(output, "utf8");
  fs.rmSync(temp, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, gh, output: written };
};

describe.skipIf(!CAN_RUN)("the loop's token resolver chooses, executed", () => {
  /** What the action's `env:` makes of each input: whether it is set, never its value. */
  const choose = (app: boolean, key: boolean, pat: boolean): Outcome =>
    execute(chooseRun(), { HAS_APP_ID: String(app), HAS_APP_KEY: String(key), HAS_PAT: String(pat) });

  it.each([
    [true, true, true, "app"],
    [true, true, false, "app"],
    [false, false, true, "pat"],
    [false, false, false, "workflow"],
    // Half an App cannot mint, so it is passed over for what is left.
    [true, false, true, "pat"],
    [false, true, true, "pat"],
    [true, false, false, "workflow"],
    [false, true, false, "workflow"],
  ] as const)("App ID %s, key %s, PAT %s: reports %s", (app, key, pat, source) => {
    const outcome = choose(app, key, pat);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.output).toBe(`source=${source}\n`);
    expect(outcome.gh).toEqual([]);
  });

  /** A half-finished App is named rather than silently passed over. */
  it.each([
    [true, false, "AGENT_APP_ID is set but AGENT_APP_PRIVATE_KEY is not"],
    [false, true, "AGENT_APP_PRIVATE_KEY is set but AGENT_APP_ID is not"],
  ] as const)("warns on half an App (ID %s, key %s)", (app, key, warning) => {
    expect(choose(app, key, true).stdout).toContain(`::warning::${warning}`);
  });

  it("warns of nothing on a whole App, or none", () => {
    expect(choose(true, true, false).stdout).not.toContain("::warning::");
    expect(choose(false, false, true).stdout).not.toContain("::warning::");
  });
});

/**
 * What a label step does with the source: the `agent:review` the issue side
 * adds is made with the token the resolver produced whatever it is, and only
 * the workflow token, which fires nothing, draws the warning to add it by
 * hand. An empty source, from a resolver that did not run, is read as the
 * workflow token.
 */
describe.skipIf(!CAN_RUN)("the issue side's review request, by the resolver's source", () => {
  const PUSHED = "2222222222222222222222222222222222222222";
  const REQUESTS = [
    ["implement", "NEW_PR", "pr edit 152 --add-label agent:review"],
    ["implement-prd", "PRD_PR", "pr edit 152 --add-label agent:review"],
  ] as const;

  const request = (command: string, pr: string, source: string): Outcome =>
    execute(publishStep(command, "Request review"), {
      GH_TOKEN: `${source || "unknown"}-token`,
      TOKEN_SOURCE: source,
      ISSUE_NUMBER: "135",
      [pr]: "152",
      PUSHED_SHA: PUSHED,
      HEAD_WAIT_SECONDS: "0",
    });

  describe.each(REQUESTS)("%s", (command, pr, add) => {
    it.each(["app", "pat", "workflow", ""])("adds agent:review with the resolved token (source %j)", (source) => {
      const outcome = request(command, pr, source);
      const token = `${source || "unknown"}-token`;

      expect(outcome.status, outcome.stdout).toBe(0);
      expect(outcome.gh).toContain(`${token} ${add}`);
      for (const call of outcome.gh) expect(call.startsWith(`${token} `), call).toBe(true);
    });

    it.each([
      ["app", false],
      ["pat", false],
      ["workflow", true],
      ["", true],
    ] as const)("warns to add the label by hand only where it fires nothing (source %j)", (source, warns) => {
      const warning = /::warning::Neither the loop's App nor AGENT_PAT is set, so this label was added with GITHUB_TOKEN/;

      if (warns) expect(request(command, pr, source).stdout).toMatch(warning);
      else expect(request(command, pr, source).stdout).not.toMatch(warning);
    });
  });
});

/** A step's `run:` block, by name, from any job of a reusable workflow. */
const jobStep = (command: string, job: string, name: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[job]?.steps ?? []).find((s) => s.name === name);

  expect(step?.run, `${command} has no \`${name}\` step in ${job}`).toBeDefined();
  return step?.run ?? "";
};

/**
 * The PR side's writes (#320), by the source the resolver reported: the
 * re-review fix and update-branch ask for, the PRD chain's advance and park,
 * and the ready-mark. Each is made with the token the resolver produced,
 * whatever it is, and only the workflow token, which fires nothing on a label
 * and cannot write to the parent issue, draws the warning and the comment
 * that say what to do by hand instead.
 */
describe.skipIf(!CAN_RUN)("the PR side's writes, by the resolver's source", () => {
  const PUSHED = "2222222222222222222222222222222222222222";
  const SOURCES = [
    ["app", false],
    ["pat", false],
    ["workflow", true],
    ["", true],
  ] as const;
  const tokenOf = (source: string): string => `${source || "unknown"}-token`;
  const fallback = /::warning::.*[Nn]either the loop's App nor AGENT_PAT is set/;

  describe.each([
    ["fix", "Request re-review"],
    ["update-branch", "Request a review of the resolution"],
  ] as const)("%s's %s", (command, name) => {
    const request = (source: string): Outcome =>
      execute(jobStep(command, "publish", name), {
        GH_TOKEN: tokenOf(source),
        TOKEN_SOURCE: source,
        PR_NUMBER: "152",
        PUSHED: "true",
        PUSHED_SHA: PUSHED,
        HEAD_WAIT_SECONDS: "0",
        RUNNER_TEMP: os.tmpdir(),
      });

    it.each(SOURCES)("adds agent:review with the resolved token, and falls back only where it fires nothing (source %j)", (source, warns) => {
      const outcome = request(source);

      expect(outcome.status, outcome.stdout).toBe(0);
      expect(outcome.gh).toContain(`${tokenOf(source)} pr edit 152 --add-label agent:review`);
      for (const call of outcome.gh) expect(call.startsWith(`${tokenOf(source)} `), call).toBe(true);
      const comments = outcome.gh.filter((call) => call.includes("pr comment 152"));
      if (warns) {
        expect(outcome.stdout).toMatch(fallback);
        expect(comments).toHaveLength(1);
      } else {
        expect(outcome.stdout).not.toMatch(fallback);
        expect(comments).toEqual([]);
      }
    });
  });

  describe("review's advance of the PRD chain", () => {
    interface Composite {
      readonly runs: { readonly steps: readonly Step[] };
    }
    const advanceRun = (): string =>
      (parse(fs.readFileSync(path.join(".github", "actions", "advance-prd", "action.yml"), "utf8")) as Composite).runs.steps[0]?.run ?? "";

    it.each(SOURCES)("labels the parent with the resolved token, or says so on the PRD PR (source %j)", (source, warns) => {
      const outcome = execute(advanceRun(), {
        GH_TOKEN: tokenOf(source),
        TOKEN_SOURCE: source,
        PR_NUMBER: "330",
        HEAD_REF: "agent/prd-314-a-prd",
      });

      expect(outcome.status, outcome.stdout).toBe(0);
      for (const call of outcome.gh) expect(call.startsWith(`${tokenOf(source)} `), call).toBe(true);
      if (warns) {
        expect(outcome.gh.filter((call) => call.includes("--add-label"))).toEqual([]);
        expect(outcome.gh.some((call) => call.includes("pr comment 330"))).toBe(true);
        expect(outcome.stdout).toMatch(fallback);
      } else {
        expect(outcome.gh).toContain(`${tokenOf(source)} issue edit 314 --add-label agent:implement`);
        expect(outcome.stdout).not.toMatch(fallback);
      }
    });
  });

  describe("review's park of the PRD chain", () => {
    it.each(SOURCES)("comments on the parent with the resolved token, or on the PRD PR with the job's (source %j)", (source, warns) => {
      const outcome = execute(jobStep("review", "advance", "Park the PRD chain"), {
        GH_TOKEN: "job-token",
        LOOP_TOKEN: tokenOf(source),
        TOKEN_SOURCE: source,
        TOKEN_OUTCOME: "success",
        PR_NUMBER: "330",
        HEAD_REF: "agent/prd-314-a-prd",
        ENDED: "false",
        REVIEWED: "false",
        REVIEW_URL: "",
        REVIEW_URL_SLOT: "{{AGENT_REVIEW_URL}}",
        RUN_URL: "https://example.invalid/run",
        RUNNER_TEMP: os.tmpdir(),
      });

      // One call, whose multi-line body runs on over the log lines after it.
      const calls = outcome.gh.filter((line) => /^[\w-]+-token /.test(line));

      expect(outcome.status, outcome.stdout).toBe(0);
      if (warns) {
        expect(calls).toEqual([expect.stringMatching(/^job-token pr comment 330 /)]);
        expect(outcome.stdout).toMatch(fallback);
      } else {
        expect(calls).toEqual([expect.stringMatching(new RegExp(`^${tokenOf(source)} issue comment 314 `))]);
      }
    });

    /**
     * A mint that failed (#330 review): the park still goes on the PRD PR,
     * with the workflow token and the reason the resolver wrote, and the step
     * fails, as the job already has. Never on the parent with whatever token
     * the resolver fell back to: the source still says `app`.
     */
    it("parks on the PRD PR with the job's token and the mint's reason where the mint failed", () => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-park-"));
      fs.writeFileSync(path.join(temp, "failure_reason.txt"), "Couldn't mint a token for the loop's GitHub App.\n");
      const outcome = execute(jobStep("review", "advance", "Park the PRD chain"), {
        GH_TOKEN: "job-token",
        LOOP_TOKEN: "pat-token",
        TOKEN_SOURCE: "app",
        TOKEN_OUTCOME: "failure",
        PR_NUMBER: "330",
        HEAD_REF: "agent/prd-314-a-prd",
        ENDED: "false",
        REVIEWED: "false",
        REVIEW_URL: "",
        REVIEW_URL_SLOT: "{{AGENT_REVIEW_URL}}",
        RUN_URL: "https://example.invalid/run",
        RUNNER_TEMP: temp,
      });
      fs.rmSync(temp, { recursive: true, force: true });
      const calls = outcome.gh.filter((line) => /^[\w-]+-token /.test(line));

      expect(outcome.status).toBe(1);
      expect(calls).toEqual([expect.stringMatching(/^job-token pr comment 330 /)]);
      expect(outcome.gh.join("\n")).toContain("_This was meant for #314, but it could not be posted there: Couldn't mint a token for the loop's GitHub App._");
    });
  });

  /** …and the advance skipped by it says on the PRD PR which re-label does it by hand. */
  describe("review's word on an advance a failed mint skipped", () => {
    it("names the reason and the re-label, with the job's token", () => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-advance-"));
      fs.writeFileSync(path.join(temp, "failure_reason.txt"), "Couldn't mint a token for the loop's GitHub App.\n");
      const outcome = execute(jobStep("review", "advance", "Say the PRD chain did not advance"), {
        GH_TOKEN: "job-token",
        PR_NUMBER: "330",
        HEAD_REF: "agent/prd-314-a-prd",
        RUN_URL: "https://example.invalid/run",
        RUNNER_TEMP: temp,
      });
      fs.rmSync(temp, { recursive: true, force: true });
      const log = outcome.gh.join("\n");

      expect(outcome.status, outcome.stdout).toBe(0);
      expect(outcome.gh[0]).toMatch(/^job-token pr comment 330 /);
      expect(log).toContain("the PRD chain did not advance: Couldn't mint a token for the loop's GitHub App.");
      expect(log).toContain("re-add `agent:implement` to #314 by hand");
    });
  });

  describe.each([
    ["review", "post-review"],
    ["fix", "publish"],
  ] as const)("%s's ready-mark", (command, job) => {
    it.each(["app", "pat", "workflow"])("marks the PR ready with the resolved token (source %j)", (source) => {
      const outcome = execute(jobStep(command, job, "Mark PR ready for review"), { GH_TOKEN: tokenOf(source), PR_NUMBER: "152" });

      expect(outcome.status, outcome.stdout).toBe(0);
      expect(outcome.gh).toEqual([`${tokenOf(source)} pr ready 152`]);
    });
  });
});
