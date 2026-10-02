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
  { command: "implement", label: "agent:implement", step: "Mark blocked on failure", minutes: 30, blocks: true },
  { command: "implement-prd", label: "agent:implement", step: "Mark blocked on failure", minutes: 30, blocks: true },
  { command: "fix", label: "agent:fix", step: "Mark blocked on failure", minutes: 30, blocks: true },
  { command: "update-branch", label: "agent:update-branch", step: "Mark blocked on failure", minutes: 30, blocks: true },
  { command: "review", label: "agent:review", step: "Mark blocked on failure", minutes: 20, blocks: true },
  // No `agent:blocked` on a merged pull request, on a failure or otherwise:
  // there is no pipeline left there to block (see the step's own note).
  { command: "follow-ups", label: "agent:follow-ups", step: "Report the failure on the PR", minutes: 10, blocks: false },
] as const;

type Case = (typeof CASES)[number];

/**
 * The job each failure step is in: its workflow's own, except the review's,
 * which is its posting job (#257). The review job runs the model and writes
 * nothing, so it measures how it ended and hands that over. And implement's,
 * which is its publish job: the agent's job writes nothing either, and the
 * publish job reads how it ended from `needs`.
 */
const JOB: Readonly<Record<string, string>> = {
  review: "post-review",
  implement: "publish",
  fix: "publish",
  "update-branch": "publish",
  "implement-prd": "publish",
};

const stepOf = (command: string, job: string, name: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[job]?.steps ?? []).find((s) => s.name === name);

  expect(step?.run, `${command} has no \`${name}\` step in \`${job}\``).toBeDefined();
  return step?.run ?? "";
};

const runOf = (c: Case): string => stepOf(c.command, JOB[c.command] ?? c.command, c.step);

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
 * The review job's half (#257): *Hand the outcome to the posting job*, run as
 * the job ended, which is where the clock and the reason files are. What it
 * hands over is what the posting job's failure step reads, as the posting job
 * sees it: the review job's result, and its outputs.
 */
const reviewOutcome = (
  temp: string,
  bin: string,
  status: "failure" | "cancelled",
  elapsed: number,
  minutes: string,
): Record<string, string> => {
  const script = path.join(temp, "outcome.sh");
  const output = path.join(temp, "outcome.out");
  fs.writeFileSync(script, stepOf("review", "review", "Hand the outcome to the posting job"));
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      JOB_STATUS: status,
      JOB_STARTED: String(Math.floor(Date.now() / 1000) - elapsed),
      TIMEOUT_MINUTES: minutes,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const outputs = outputsOf(fs.readFileSync(output, "utf8"));
  // The posting job has a temp of its own: nothing the review job wrote is in it.
  for (const name of ["failure_reason.txt", "refusal_reason.txt"]) fs.rmSync(path.join(temp, name), { force: true });
  return {
    REVIEW_RESULT: status,
    JOB_STATUS: "success",
    REVIEW_REASON: outputs["failure-reason"] ?? "",
    REVIEW_REFUSAL: outputs["refusal-reason"] ?? "",
    TIMED_OUT: outputs["timed-out"] ?? "",
  };
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
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(temp, name), text);
  fs.writeFileSync(script, runOf(c));
  // Unless the case names what was handed over itself, as a failed post does.
  const handed =
    c.command === "review" && extra["REVIEW_RESULT"] === undefined
      ? reviewOutcome(temp, bin, status, elapsed, minutes)
      : {};

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
      ...handed,
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
    // Five runs, so five spawns' worth of ceiling (`vitest.config.ts`), and
    // twice that for the review, whose run is two steps in two jobs (#257).
  }, 10 * SUBPROCESS_TIMEOUT);

  /**
   * The other pattern (#253): a review that refused a repository variable
   * before it reviewed anything did not run, rather than stopped. It says so
   * from its own file, with no run link, and is still blocked, since the
   * maintainer has to change the variable.
   */
  it("review: a variable it refused before reviewing says it didn't run, and still blocks", () => {
    const review = CASES.find((c) => c.command === "review") as Case;
    const refusal =
      "The repository variable `AGENT_MAX_FIX_ROUNDS` is `abc`. It must be a whole number (0 or more), or delete it to use the default of 3. Then add `agent:review` again.";
    const outcome = run(review, "failure", 120, "20", "false", { "refusal_reason.txt": `${refusal}\n` });

    expect(outcome.comment).toBe(`**\`agent:review\` didn't run:** ${refusal}\n`);
    expect(outcome.gh.some((argv) => argv.includes("--add-label agent:blocked"))).toBe(true);
  });

  /**
   * And a review that finished whose posting failed (#257): the reason is the
   * posting job's own, from the file its post step wrote, and the review job's
   * clock has nothing to say about it.
   */
  it("review: a review that finished and could not be posted says why, and blocks", () => {
    const review = CASES.find((c) => c.command === "review") as Case;
    const outcome = run(review, "failure", 120, "20", "false", { "failure_reason.txt": "GitHub refused the review.\n" }, {
      REVIEW_RESULT: "success",
      JOB_STATUS: "failure",
      REVIEW_REASON: "",
      REVIEW_REFUSAL: "",
      TIMED_OUT: "false",
    });

    expect(outcome.comment).toContain("stopped:** GitHub refused the review.\n");
    expect(outcome.gh.some((argv) => argv.includes("--add-label agent:blocked"))).toBe(true);
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

  /**
   * A split run's publish job reads the agent's job's end from `needs`, not
   * from its own status, and a job that reached its limit may read there as
   * failed. A runner that was killed wrote no reason, so a failure without
   * one is measured against the clock too; a failure with one never is.
   * implement's since #307, and fix's, update-branch's and implement-prd's
   * since #308.
   */
  describe.each(["implement", "fix", "update-branch", "implement-prd"])("%s, reported from its publish job", (command) => {
    const implement = CASES.find((c) => c.command === command) as Case;

    it("says a run that failed at its limit with no reason timed out", () => {
      const outcome = run(implement, "failure", implement.minutes * 60, String(implement.minutes), "false", {});

      expect(outcome.comment).toContain(`timed out after ${implement.minutes} minutes`);
    });

    it("says a run that failed early with no reason gave none", () => {
      const outcome = run(implement, "failure", 120, String(implement.minutes), "false", {});

      expect(outcome.comment).toContain("It stopped without giving a reason.");
      expect(outcome.comment).not.toContain("timed out");
    });

    it("says a run cancelled while it published was cancelled, though the agent's job succeeded", () => {
      const outcome = run(implement, "cancelled", 120, String(implement.minutes), "false", {}, {
        AGENT_RESULT: "success",
      });

      expect(outcome.comment).toContain("cancelled");
      expect(outcome.comment).not.toContain("timed out");
    });

    it("says a run cancelled in its gate was cancelled, though the agent's job never ran", () => {
      const outcome = run(implement, "failure", 120, String(implement.minutes), "", {}, {
        GATE_RESULT: "cancelled",
        AGENT_RESULT: "skipped",
      });

      expect(outcome.comment).toContain("cancelled");
      expect(outcome.comment).not.toContain("timed out");
    });

    /** implement-prd's catch-up, between its gate and its agent's job. */
    if (command === "implement-prd") {
      it("says a run cancelled in its catch-up was cancelled, though the agent's job never ran", () => {
        const outcome = run(implement, "failure", 120, String(implement.minutes), "false", {}, {
          CATCH_UP_RESULT: "cancelled",
          AGENT_RESULT: "skipped",
        });

        expect(outcome.comment).toContain("cancelled");
        expect(outcome.comment).not.toContain("timed out");
      });
    }
  });
});

/**
 * An `implement-prd` run that merged the default branch into the PRD branch
 * and pushed it (#245), then stopped before its slice was pushed. The PRD PR's
 * head is that merge, which no review has seen, so the gate would refuse a
 * re-added `agent:implement`. The way on it names is the review.
 */
describe.skipIf(!CAN_RUN)("implement-prd's failure step after the default branch was merged in", () => {
  const prd = CASES.find((c) => c.command === "implement-prd") as Case;
  const merged = { SUB: "245", BASE_REF: "main", PRD_PR: "286", MERGED: "0123456789abcdef" };

  /**
   * The sub-issue named is the one the preflight selected off the slice
   * ranges and handed over as `sub` (#246), with the run link: the step
   * reads no issue, so it cannot infer one from which are closed.
   */
  it("names the sub-issue the run selected, with the run link", () => {
    const outcome = run(prd, "failure", 120, "30", "false", undefined, { SUB: "246", BASE_REF: "main" });

    expect(outcome.comment).toContain("It was building sub-issue #246.");
    expect(outcome.comment).toContain("[Workflow run](https://github.com/acme/widgets/actions/runs/1)");
    expect(outcome.gh.filter((call) => !call.startsWith("issue comment 135") && !call.startsWith("issue edit 135"))).toEqual([]);
    expect(runOf(prd)).not.toMatch(/gh (api|issue view|issue list)/);
  });

  it("names the review on the PRD PR as the way on, not the label", () => {
    const outcome = run(prd, "failure", 120, "30", "false", undefined, merged);

    expect(outcome.comment).toContain("It was building sub-issue #245.");
    expect(outcome.comment).toContain(
      "The default branch `main` was merged into the PRD branch before it stopped, and that merge has no review yet, so adding `agent:implement` would be refused. Add `agent:review` to PRD PR #286",
    );
  });

  it("says the slice was pushed, where it was, whatever was merged before it", () => {
    const outcome = run(prd, "failure", 120, "30", "false", undefined, { ...merged, PUSHED: "fedcba9876543210" });

    expect(outcome.comment).toContain("Sub-issue #245 was built and pushed to the PRD branch before it stopped");
    expect(outcome.comment).not.toContain("was merged into the PRD branch");
  });
});
