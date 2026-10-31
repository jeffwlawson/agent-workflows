import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { GitHubError } from "../engine/github.js";
import type { PullRequest } from "../engine/read.js";
import { COMMANDS } from "../shared/contract.js";
import { waitForReviewPosting } from "../shared/review-posting.js";

/**
 * The wait for a review's posting to finish (#257), `shared/review-posting.ts`,
 * which `fix:gate` and `update-branch:gate` wait with. The scenarios are
 * `tests/post-wait-step.test.ts`'s, which held `update-branch.yml`'s shell
 * copy equal to this until that copy became `update-branch:gate` (#481).
 *
 * What it executes is the race #257 opened: the review's posting job is in no
 * concurrency group, so a fix or a refresh that waited behind the review job
 * starts before the review is posted. It waits while `agent:review` is on,
 * which the posting job takes off only after every result is posted, and it
 * stops waiting at a bound rather than failing.
 */

interface Outcome {
  readonly stdout: string;
  readonly reads: readonly string[];
}

/**
 * The helper over `answers`, each read popping the next: a comma-joined label
 * list, or `!` for a read that fails. The last answer repeats.
 */
const run = async (answers: readonly string[], waitSeconds = 600): Promise<Outcome> => {
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
      { waitSeconds, pollSeconds: 0 },
    );
  } finally {
    log.mockRestore();
  }
  return { stdout: stdout.join("\n"), reads };
};

describe("the wait for a review's posting job", () => {
  it("goes straight on where no review is posting", async () => {
    const outcome = await run(["agent:fix,agent:update-branch"]);

    expect(outcome.reads).toEqual(["pull request 152"]);
    expect(outcome.stdout).toContain("No review is posting on PR #152.");
  });

  it("waits while agent:review is on, and goes on once it is off", async () => {
    const outcome = await run(["agent:fix,agent:review", "agent:review", "agent:fix"]);

    expect(outcome.reads).toHaveLength(3);
    expect(outcome.stdout).toContain("waiting for the review's posting job");
    expect(outcome.stdout).not.toContain("::warning::");
  });

  /** A label that is not `agent:review` but contains it is not a review posting. */
  it("matches the label exactly", async () => {
    expect((await run(["agent:review-later,x-agent:review"])).reads).toHaveLength(1);
  });

  /** "Could not tell" is not "nothing is posting". */
  it("keeps waiting through a read that fails", async () => {
    const outcome = await run(["!", ""]);

    expect(outcome.reads).toHaveLength(2);
    expect(outcome.stdout).toContain("No review is posting on PR #152.");
  });

  /** A label nobody will take off costs the bound, then a warning, never the run. */
  it("stops waiting at the bound, says so, and does not fail", async () => {
    const outcome = await run(["agent:review"], 0);

    expect(outcome.stdout).toContain(
      "::warning::`agent:review` is still on PR #152 (or its labels could not be read) after 0 seconds, so this run goes on without waiting for a review to finish posting. If a review was posting, this run may not see its findings or its verdict.",
    );
  });

  /**
   * Bounded by the posting job's own `timeout-minutes`, in both gates that
   * wait, and no shell copy of the wait is left in either workflow.
   */
  it.each(["fix:gate", "update-branch:gate"] as const)("%s: is bounded by the posting job's limit, with no shell copy", (name) => {
    const workflow = (file: string) =>
      parse(fs.readFileSync(path.join(".github", "workflows", file), "utf8")) as {
        jobs: Record<string, { "timeout-minutes"?: number; steps?: readonly { name?: string }[] }>;
      };
    const posting = workflow("review.yml").jobs["post-review"];

    expect(Number(COMMANDS[name].inputs.POST_WAIT_SECONDS.default)).toBe((posting?.["timeout-minutes"] ?? 0) * 60);
    expect(fs.readFileSync(path.join(...name.split(":")) + ".ts", "utf8")).toContain("waitForReviewPosting(");
    const steps = Object.values(workflow(`${name.split(":")[0] ?? ""}.yml`).jobs).flatMap((job) => job.steps ?? []);
    expect(steps.map((s) => s.name)).not.toContain("Wait for a review's posting to finish");
  });
});
