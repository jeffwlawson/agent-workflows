import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { GitHubError } from "../engine/github.js";
import type { PullRequest } from "../engine/read.js";
import { COMMANDS } from "../shared/contract.js";
import { waitForReviewPosting } from "../shared/review-posting.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The wait for a review's posting to finish, in its two copies: the helper
 * `fix:gate` calls, `shared/review-posting.ts` (#470), and the shell step
 * `update-branch.yml` keeps until its own steps move, *Wait for a review's
 * posting to finish*, its real `run:` block run under `bash -e` against a
 * `gh` that answers each label read from a script of answers and records
 * every call. Each scenario runs over both, so the two cannot drift.
 *
 * What it executes is the race #257 opened: the review's posting job is in no
 * concurrency group, so a fix or a refresh that waited behind the review job
 * starts before the review is posted. It waits while `agent:review` is on,
 * which the posting job takes off only after every result is posted, and it
 * stops waiting at a bound rather than failing.
 *
 * The shell half is skipped where `bash` is not on PATH.
 */

const CAN_RUN =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v bash"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const STEP = "Wait for a review's posting to finish";

const workflowOf = (name: string): Workflow =>
  parse(fs.readFileSync(path.join(".github", "workflows", `${name}.yml`), "utf8")) as Workflow;

const stepsOf = (name: string): readonly Step[] =>
  Object.values(workflowOf(name).jobs)
    // Every step of the run, in the order its jobs run (#308).
    .flatMap((job) => job.steps ?? []);

const stepOf = (): Step | undefined => stepsOf("update-branch").find((s) => s.name === STEP);

/**
 * Each read pops the next answer: a comma-joined label list, or `!` for a
 * read that fails. The last answer repeats.
 */
const FAKE_GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
answer=$(head -n 1 "$GH_ANSWERS")
if [ "$(wc -l < "$GH_ANSWERS")" -gt 1 ]; then sed -i 1d "$GH_ANSWERS"; fi
if [ "$answer" = "!" ]; then echo "HTTP 502" >&2; exit 1; fi
printf '%s\\n' "$answer"
`;

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly reads: readonly string[];
}

/** The shell copy, over `answers`. */
const runShell = (answers: readonly string[], waitSeconds = "600"): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-wait-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const script = path.join(temp, "step.sh");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(temp, "answers"), `${answers.join("\n")}\n`);
  fs.writeFileSync(script, stepOf()?.run ?? "");

  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GH_LOG: log,
      GH_ANSWERS: path.join(temp, "answers"),
      PR_NUMBER: "152",
      POST_WAIT_SECONDS: waitSeconds,
      POST_POLL_SECONDS: "0",
    },
  });
  const outcome = {
    status: result.status,
    stdout: result.stdout ?? "",
    reads: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : [],
  };
  fs.rmSync(temp, { recursive: true, force: true });
  return outcome;
};

/** The helper, over the same `answers`, against a reader that answers each read the way the fake `gh` does. */
const runHelper = async (answers: readonly string[], waitSeconds = "600"): Promise<Outcome> => {
  const left = [...answers];
  const reads: string[] = [];
  const stdout: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    stdout.push(String(line));
  });
  try {
    await waitForReviewPosting(
      {
        pullRequest: async (number) => {
          reads.push(`pull request ${number}`);
          const answer = (left.length > 1 ? left.shift() : left[0]) ?? "";
          if (answer === "!") throw new GitHubError("GET pulls: 502 Bad Gateway", 502);
          return { labels: answer === "" ? [] : answer.split(",") } as unknown as PullRequest;
        },
      },
      152,
      { waitSeconds: Number(waitSeconds), pollSeconds: 0 },
    );
  } finally {
    log.mockRestore();
  }
  return { status: 0, stdout: stdout.join("\n"), reads };
};

const COPIES = [
  ["update-branch's shell", async (answers: readonly string[], waitSeconds?: string) => runShell(answers, waitSeconds)],
  ["the helper", runHelper],
] as const;

describe("a fix or a refresh waits for a review's posting job", () => {
  /**
   * After the pre-flight lets the run go ahead, and before the checkout, so
   * before anything the review posts is read. Bounded by the posting job's own
   * `timeout-minutes`, and `fix:gate`'s bound, the helper's, is the same one.
   */
  it("update-branch: waits after the pre-flight and before reading anything, as long as fix:gate does", () => {
    const names = stepsOf("update-branch").map((s) => s.name);
    const step = stepOf();

    expect(step?.if).toBe("steps.state.outputs.proceed == 'true'");
    expect(names.indexOf(STEP)).toBeGreaterThan(names.indexOf("Transition labels"));
    expect(names.indexOf(STEP)).toBeLessThan(names.indexOf("Checkout PR head"));
    const posting = (workflowOf("review") as { jobs: Record<string, { "timeout-minutes"?: number }> }).jobs["post-review"];
    expect(Number(step?.env?.["POST_WAIT_SECONDS"])).toBe((posting?.["timeout-minutes"] ?? 0) * 60);
    expect(step?.env?.["POST_WAIT_SECONDS"]).toBe(COMMANDS["fix:gate"].inputs.POST_WAIT_SECONDS.default);
    expect(step?.env?.["POST_POLL_SECONDS"]).toBe(COMMANDS["fix:gate"].inputs.POST_POLL_SECONDS.default);
    expect(step?.run ?? "").not.toMatch(/gh pr (edit|comment|ready)|--method POST/);
  });

  /** Fix's wait is `fix:gate`'s, the helper's, and fix.yml has no shell copy of it left. */
  it("fix: waits in fix:gate, with no shell copy", () => {
    expect(stepsOf("fix").map((s) => s.name)).not.toContain(STEP);
    expect(fs.readFileSync(path.join("fix", "gate.ts"), "utf8")).toContain("waitForReviewPosting(");
  });
});

describe("the wait for a review's posting job, executed", () => {
  const each = (CAN_RUN ? COPIES : COPIES.filter(([name]) => name === "the helper")).map(([name, run]) => ({ name, run }));

  it.each(each)("$name: goes straight on where no review is posting", async ({ run }) => {
    const outcome = await run(["agent:fix,agent:update-branch"]);

    expect(outcome.status).toBe(0);
    expect(outcome.reads).toHaveLength(1);
    expect(outcome.stdout).toContain("No review is posting on PR #152.");
  });

  it.each(each)("$name: waits while agent:review is on, and goes on once it is off", async ({ run }) => {
    const outcome = await run(["agent:fix,agent:review", "agent:review", "agent:fix"]);

    expect(outcome.status).toBe(0);
    expect(outcome.reads).toHaveLength(3);
    expect(outcome.stdout).toContain("waiting for the review's posting job");
    expect(outcome.stdout).not.toContain("::warning::");
  });

  /** A label that is not `agent:review` but contains it is not a review posting. */
  it.each(each)("$name: matches the label exactly", async ({ run }) => {
    expect((await run(["agent:review-later,x-agent:review"])).reads).toHaveLength(1);
  });

  /** "Could not tell" is not "nothing is posting". */
  it.each(each)("$name: keeps waiting through a read that fails", async ({ run }) => {
    const outcome = await run(["!", ""]);

    expect(outcome.status).toBe(0);
    expect(outcome.reads).toHaveLength(2);
  });

  /** A label nobody will take off costs the bound, then a warning, never the run. */
  it.each(each)("$name: stops waiting at the bound, says so, and does not fail", async ({ run }) => {
    const outcome = await run(["agent:review"], "0");

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain(
      "::warning::`agent:review` is still on PR #152 (or its labels could not be read) after 0 seconds, so this run goes on without waiting for a review to finish posting. If a review was posting, this run may not see its findings or its verdict.",
    );
  });
});
