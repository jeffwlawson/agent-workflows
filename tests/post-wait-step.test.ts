import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs *Wait for a review's posting to finish*, the real `run:` block read out
 * of `fix.yml` and `update-branch.yml`, under `bash -e` against a `gh` that
 * answers each label read from a script of answers and records every call.
 *
 * What it executes is the race #257 opened: the review's posting job is in no
 * concurrency group, so a fix or a refresh that waited behind the review job
 * starts before the review is posted. It waits while `agent:review` is on,
 * which the posting job takes off only after every result is posted, and it
 * stops waiting at a bound rather than failing.
 *
 * Skipped where `bash` is not on PATH.
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
const COMMANDS = ["fix", "update-branch"] as const;

const stepsOf = (command: string): readonly Step[] =>
  (parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow).jobs[command]
    ?.steps ?? [];

const stepOf = (command: string): Step | undefined => stepsOf(command).find((s) => s.name === STEP);

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

const run = (command: string, answers: readonly string[], waitSeconds = "600"): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-wait-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const script = path.join(temp, "step.sh");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(temp, "answers"), `${answers.join("\n")}\n`);
  fs.writeFileSync(script, stepOf(command)?.run ?? "");

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

describe("a fix or a refresh waits for a review's posting job", () => {
  /** One copy of the wait in two files, held equal so they cannot drift. */
  it("is the same step in fix and in update-branch", () => {
    const [fix, update] = COMMANDS.map(stepOf);

    expect(fix?.run).toBeDefined();
    expect(update?.run).toBe(fix?.run);
    expect(update?.env).toEqual(fix?.env);
    expect(update?.if).toBe(fix?.if);
  });

  /**
   * After the pre-flight lets the run go ahead, and before the checkout, so
   * before anything the review posts is read. Bounded by the posting job's own
   * `timeout-minutes`.
   */
  it.each(COMMANDS)("%s: waits after the pre-flight and before reading anything", (command) => {
    const names = stepsOf(command).map((s) => s.name);
    const step = stepOf(command);

    expect(step?.if).toBe("steps.state.outputs.proceed == 'true'");
    expect(names.indexOf(STEP)).toBeGreaterThan(names.indexOf("Transition labels"));
    expect(names.indexOf(STEP)).toBeLessThan(names.indexOf("Checkout PR head"));
    const posting = (
      parse(fs.readFileSync(path.join(".github", "workflows", "review.yml"), "utf8")) as {
        jobs: Record<string, { "timeout-minutes"?: number }>;
      }
    ).jobs["post-review"];
    expect(Number(step?.env?.["POST_WAIT_SECONDS"])).toBe((posting?.["timeout-minutes"] ?? 0) * 60);
    expect(step?.run ?? "").not.toMatch(/gh pr (edit|comment|ready)|--method POST/);
  });
});

describe.skipIf(!CAN_RUN)("the wait for a review's posting job, executed", () => {
  it.each(COMMANDS)("%s: goes straight on where no review is posting", (command) => {
    const outcome = run(command, ["agent:fix,agent:update-branch"]);

    expect(outcome.status).toBe(0);
    expect(outcome.reads).toHaveLength(1);
    expect(outcome.reads[0]).toContain("pr view 152 --json labels");
  });

  it.each(COMMANDS)("%s: waits while agent:review is on, and goes on once it is off", (command) => {
    const outcome = run(command, ["agent:fix,agent:review", "agent:review", "agent:fix"]);

    expect(outcome.status).toBe(0);
    expect(outcome.reads).toHaveLength(3);
    expect(outcome.stdout).toContain("waiting for the review's posting job");
    expect(outcome.stdout).not.toContain("::warning::");
  });

  /** A label that is not `agent:review` but contains it is not a review posting. */
  it.each(COMMANDS)("%s: matches the label exactly", (command) => {
    expect(run(command, ["agent:review-later,x-agent:review"]).reads).toHaveLength(1);
  });

  /** "Could not tell" is not "nothing is posting". */
  it.each(COMMANDS)("%s: keeps waiting through a read that fails", (command) => {
    const outcome = run(command, ["!", ""]);

    expect(outcome.status).toBe(0);
    expect(outcome.reads).toHaveLength(2);
  });

  /** A label nobody will take off costs the bound, then a warning, never the run. */
  it.each(COMMANDS)("%s: stops waiting at the bound, says so, and does not fail", (command) => {
    const outcome = run(command, ["agent:review"], "0");

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("::warning::`agent:review` is still on PR #152");
  });
});
