import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubReader } from "../../engine/read.js";
import { gate } from "../../review/gate.js";
import type { ReadingIo } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { FINAL_REVIEW_MARK, FIX_ROUND_STATUS, VERDICT_CONTEXT } from "../../shared/record.js";
import { LEGACY_FIX_ROUND_STARTED } from "../../shared/review-output.js";
import { fakeGitHub, fakeReader, type FakeGitHub, type ReceivedRead } from "../engine/fakes.js";

/**
 * `review:gate` (#420), called the way the CLI calls it: its declared inputs,
 * a fake GitHub reader holding the live state, and its declared outputs. What
 * is asserted is what it decided, `gate.json`, the refusal it wrote, and what
 * it said in the log; it holds no writer, so it can write nothing to the
 * record.
 *
 * The scenarios are the retired step tests': `tests/review-preflight.test.ts`
 * (the commit the pre-flight settles on, #228 and #229), and the budget, the
 * time limit's refusal and the round in `tests/workflows.test.ts`, carried
 * over by behaviour.
 */

const PR = 228;
const BRANCH = "agent/issue-228-fix";
const BEFORE = "3".repeat(40);
const AFTER = "c".repeat(40);
const STALE = "0123456789abcdef0123456789abcdef01234567";
const LOOP = "github-actions[bot]";

let github: FakeGitHub;
let reads: ReceivedRead[];
let files: Map<string, unknown>;
let logged: string[];

beforeEach(() => {
  github = fakeGitHub([{ number: PR, headSha: BEFORE }]);
  github.branches.set(BRANCH, BEFORE);
  files = new Map();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Inputs = Parameters<typeof gate>[0];

/** A review asked for at `BEFORE`, of an open pull request, with the loop's App set up. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  PR_NUMBER: String(PR),
  BRANCH,
  HEAD_SHA: BEFORE,
  PR_STATE: "open",
  PR_MERGED: "false",
  HEAD_WAIT_SECONDS: "60",
  HEAD_POLL_SECONDS: "0",
  REVIEW_TIMEOUT_MINUTES: "",
  MAX_FIX_ROUNDS: "",
  DEPRECATED_AUTO_FIX: "",
  LOOP_TOKEN_SOURCE: "app",
  ...over,
});

/**
 * The CLI's half: the reader, the outputs, and the call. `heads` is what the
 * pull request shows as its head on each read, in turn, the last one held;
 * `reader` changes the fake reader where a scenario needs GitHub to fail.
 */
const run = async (
  inputs: Inputs = INPUTS(),
  options: { heads?: readonly string[]; reader?: (reader: GitHubReader) => GitHubReader } = {},
): Promise<void> => {
  const fake = fakeReader(github);
  reads = fake.reads as ReceivedRead[];
  let views = 0;
  const heads = options.heads;
  const reader: GitHubReader =
    heads === undefined
      ? fake.reader
      : {
          ...fake.reader,
          pullRequest: async (number) => {
            const pr = await fake.reader.pullRequest(number);
            return { ...pr, headSha: heads[Math.min(views++, heads.length - 1)] ?? pr.headSha };
          },
        };
  const io: ReadingIo<(typeof COMMANDS)["review:gate"]["outputs"]> = {
    github: options.reader?.(reader) ?? reader,
    outputs: {
      writeJson: (name, value) => files.set(name, value),
      writeText: (name, value) => files.set(name, value),
      appendLine: () => {},
    },
  };
  await gate(inputs, io);
};

const decided = (): Record<string, string> => files.get("gate.json") as Record<string, string>;

/** What the refusal says, as `review:conclude` posts it from `refusal`. */
const comment = (): string => `**\`agent:review\` didn't run:** ${decided()["refusal"] ?? ""}`;

const CHANGED =
  "**`agent:review` didn't run:** The PR changed after `agent:review` was added. Add `agent:review` again to review the latest version.";

describe("review:gate settles on one commit", () => {
  it("reviews the labelled commit, asking nothing more, when it is the tip", async () => {
    await run();

    expect(decided()).toMatchObject({ proceed: "true", sha: BEFORE });
    expect(reads.map((r) => r.method)).not.toContain("compare");
  });

  /**
   * The #228 sequence: the fix pushed and labelled at once, so the payload and
   * the pull request both still name the commit before the push, and the pull
   * request catches up a poll later. The review is of the pushed commit.
   */
  it("reviews the pushed commit when the label was added before the PR head moved", async () => {
    github.branches.set(BRANCH, AFTER);
    github.comparisons.set(`${BEFORE}...${AFTER}`, "ahead");

    await run(INPUTS(), { heads: [BEFORE, BEFORE, AFTER] });

    expect(decided()).toMatchObject({ proceed: "true", sha: AFTER });
    expect(reads.filter((r) => r.method === "pullRequest").length).toBeGreaterThanOrEqual(3);
    expect(logged.join("\n")).toContain(`so this run reviews ${AFTER}`);
  });

  /**
   * Every way the PR can have moved since the label gets one explanation on
   * the pull request (#253), since the reader's remedy is the same for all of
   * them. The commits are named in the log, where whoever debugs it looks.
   */
  it.each(["diverged", "behind"])("refuses, naming both commits in the log, a tip that does not descend from the labelled commit (%s)", async (relation) => {
    github.branches.set(BRANCH, AFTER);
    github.comparisons.set(`${STALE}...${AFTER}`, relation);

    await run(INPUTS({ HEAD_SHA: STALE }));

    expect(decided()).toEqual({ proceed: "false", refusal: expect.any(String), blocked: "true" });
    expect(comment()).toBe(CHANGED);
    const log = logged.join("\n");
    expect(log).toContain("moved while this run was queued");
    expect(log).toContain(STALE);
    expect(log).toContain(AFTER);
  });

  it("refuses, naming both commits in the log, when whether the tip descends cannot be read", async () => {
    github.branches.set(BRANCH, AFTER);

    await run();

    expect(decided()).toEqual({ proceed: "false", refusal: expect.any(String), blocked: "true" });
    expect(comment()).toBe(CHANGED);
    const log = logged.join("\n");
    expect(log).toContain(BEFORE);
    expect(log).toContain(AFTER);
    expect(log).toContain("could not be read");
  });

  it("refuses, and says how to make GitHub catch up, when the PR never shows the tip as its head", async () => {
    github.branches.set(BRANCH, AFTER);
    github.comparisons.set(`${BEFORE}...${AFTER}`, "ahead");

    await run(INPUTS({ HEAD_WAIT_SECONDS: "0" }));

    expect(decided()).toEqual({ proceed: "false", refusal: expect.any(String), blocked: "true" });
    expect(comment()).toBe(`${CHANGED.trimEnd()} If the PR still shows the old commit, close and reopen it so GitHub catches up.`);
    const log = logged.join("\n");
    expect(log).toContain(`still shows ${BEFORE}`);
    expect(log).toContain(AFTER);
  });

  it("refuses the same way when the PR's head cannot be read before the wait ends", async () => {
    github.branches.set(BRANCH, AFTER);
    github.comparisons.set(`${BEFORE}...${AFTER}`, "ahead");

    await run(INPUTS({ HEAD_WAIT_SECONDS: "0" }), {
      reader: (reader) => ({ ...reader, pullRequest: () => Promise.reject(new Error("502")) }),
    });

    expect(decided()).toMatchObject({ proceed: "false", blocked: "true" });
    expect(logged.join("\n")).toContain("still shows an unreadable head");
  });

  /** An unreadable tip is not evidence the branch moved, and this run only reads. */
  it("proceeds on the labelled commit, with a warning, when the tip cannot be read", async () => {
    github.branches.clear();

    await run();

    expect(decided()).toMatchObject({ proceed: "true", sha: BEFORE });
    expect(logged.join("\n")).toContain("::warning::Could not read the tip");
  });

  /**
   * Distinct from the moved branch: a human reading only the comment has to
   * be able to tell the two apart, and a closed pull request has nothing left
   * for anyone to act on, so it is not blocked (#253).
   */
  it.each([
    ["closed", { PR_STATE: "closed" }],
    ["merged", { PR_MERGED: "true" }],
  ] as const)("refuses a %s PR without blocking it, reading nothing", async (_, over) => {
    await run(INPUTS(over));

    expect(decided()).toEqual({ proceed: "false", refusal: "This PR is closed.", blocked: "false" });
    expect(reads).toEqual([]);
  });

  /** A refusal of the pre-flight's is a decision, not a failure: nothing past it is settled. */
  it("settles nothing past a refusal", async () => {
    github.branches.set("agent/prd-9-x", AFTER);
    github.comparisons.set(`${BEFORE}...${AFTER}`, "diverged");

    await run(INPUTS({ BRANCH: "agent/prd-9-x", MAX_FIX_ROUNDS: "nope" }));

    expect(Object.keys(decided()).sort()).toEqual(["blocked", "proceed", "refusal"]);
    expect(files.has("refusal_reason.txt")).toBe(false);
  });
});

/**
 * A variable the gate refuses is said as "didn't run", naming it (#253): the
 * reason in `refusal_reason.txt`, which the posting job reads, then a throw,
 * which fails the job. The commit is settled first, so the error verdict has
 * one to go on.
 */
describe("review:gate refuses a variable nobody can have meant", () => {
  const refused = async (inputs: Inputs): Promise<string> => {
    const thrown = await run(inputs).then(
      () => undefined,
      (error: unknown) => error,
    );
    const reason = String(files.get("refusal_reason.txt"));
    expect(thrown).toEqual(new Error(reason));
    expect(decided()).toMatchObject({ proceed: "true", sha: BEFORE });
    return reason;
  };

  it.each(["0", "-5", "1.5", "ten", " 5"])("refuses an AGENT_REVIEW_TIMEOUT_MINUTES of %j, before the budget", async (minutes) => {
    const reason = await refused(INPUTS({ REVIEW_TIMEOUT_MINUTES: minutes }));

    expect(reason).toBe(
      `The repository variable \`AGENT_REVIEW_TIMEOUT_MINUTES\` is \`${minutes}\`. It must be a whole number of minutes (1 or more), or delete it to use the default of 5. Then add \`agent:review\` again.`,
    );
    expect(decided()["budget"]).toBeUndefined();
    expect(logged).toContain(`::error::${reason}`);
  });

  it.each(["", "1", "20"])("lets an AGENT_REVIEW_TIMEOUT_MINUTES of %j through", async (minutes) => {
    await run(INPUTS({ REVIEW_TIMEOUT_MINUTES: minutes }));

    expect(files.has("refusal_reason.txt")).toBe(false);
  });

  it.each(["three", "-1", "1.5"])("refuses an AGENT_MAX_FIX_ROUNDS of %j, naming it", async (value) => {
    const reason = await refused(INPUTS({ MAX_FIX_ROUNDS: value }));

    expect(reason).toBe(
      `The repository variable \`AGENT_MAX_FIX_ROUNDS\` is \`${value}\`. It must be a whole number (0 or more), or delete it to use the default of 3. Then add \`agent:review\` again.`,
    );
  });

  it("refuses an auto-fix that is neither true nor false", async () => {
    const reason = await refused(INPUTS({ DEPRECATED_AUTO_FIX: "yes" }));

    expect(reason).toContain("still sets `auto-fix`, which has been replaced");
  });
});

/**
 * The fix-round budget (#201, PRD #200): whether a review that recommends
 * changes starts a round itself. Rounds spent are the `agent-fix-round`
 * statuses the loop posted beside the verdicts that asked for one (#297),
 * counted once per review, since `update-branch` copies a commit's statuses
 * on to its merge commit.
 */
describe("review:gate settles the fix-round budget", () => {
  const C1 = "1".repeat(40);
  const C2 = "2".repeat(40);
  const review = (n: number): string => `https://github.com/o/r/pull/${PR}#pullrequestreview-${n}`;
  const round = (url: string | null, creator = LOOP) => ({ context: FIX_ROUND_STATUS.context, state: "success", targetUrl: url, description: "", creator });

  beforeEach(() => {
    github.commits.set(PR, [C1, C2]);
  });

  it("reads a budget of 3 where the variable is unset, and starts a round", async () => {
    await run();

    expect(decided()).toMatchObject({ budget: "3", spent: "0", start: "true" });
  });

  it("counts each review's round once, across the commits it was copied on to", async () => {
    github.statuses.set(C1, [round(review(1))]);
    github.statuses.set(C2, [round(review(1)), round(review(2))]);

    await run(INPUTS({ MAX_FIX_ROUNDS: "2" }));

    expect(decided()).toMatchObject({ budget: "2", spent: "2", start: "false" });
  });

  it("counts only the loop's own statuses, and a 0.7.6 verdict that started a round", async () => {
    github.statuses.set(C1, [
      round(review(1), "someone"),
      { context: VERDICT_CONTEXT, state: "failure", targetUrl: review(2), description: LEGACY_FIX_ROUND_STARTED, creator: LOOP },
      { context: VERDICT_CONTEXT, state: "failure", targetUrl: review(3), description: "Changes recommended.", creator: LOOP },
    ]);

    await run();

    expect(decided()).toMatchObject({ spent: "1", start: "true" });
  });

  it("counts a round with no link on its own", async () => {
    github.statuses.set(C1, [round(null), round(null)]);

    await run(INPUTS({ MAX_FIX_ROUNDS: "3" }));

    expect(decided()).toMatchObject({ spent: "2", start: "true" });
  });

  /** A label added with the workflow token starts nothing (#316). */
  it.each(["workflow", ""])("starts no round where the loop's token is %j", async (source) => {
    await run(INPUTS({ LOOP_TOKEN_SOURCE: source }));

    expect(decided()).toMatchObject({ budget: "3", spent: "0", start: "false" });
  });

  it("starts no round, and warns, where the rounds spent cannot be counted", async () => {
    await run(INPUTS(), { reader: (reader) => ({ ...reader, commitStatuses: () => Promise.reject(new Error("403 statuses")) }) });

    expect(decided()).toMatchObject({ budget: "3", spent: "", start: "false" });
    expect(logged.join("\n")).toContain("403 statuses");
    expect(logged.some((line) => line.startsWith("::warning::Could not count the automatic fix rounds already spent on PR #228"))).toBe(true);
  });

  it("counts nothing for a budget of 0", async () => {
    await run(INPUTS({ MAX_FIX_ROUNDS: "000" }));

    expect(decided()).toMatchObject({ budget: "0", spent: "0", start: "false" });
    expect(reads.map((r) => r.method)).not.toContain("pullRequestCommits");
  });

  it("holds a budget past nine digits at nine", async () => {
    await run(INPUTS({ MAX_FIX_ROUNDS: "0012345678901" }));

    expect(decided()["budget"]).toBe("999999999");
  });

  /** The deprecated alias wins over the variable for one release (decision 4), and warns. */
  it.each([
    ["true", "1"],
    ["false", "0"],
  ])("reads auto-fix %s as a budget of %s, over the variable, and warns", async (autoFix, budget) => {
    await run(INPUTS({ DEPRECATED_AUTO_FIX: autoFix, MAX_FIX_ROUNDS: "nope" }));

    expect(decided()["budget"]).toBe(budget);
    expect(logged.some((line) => /^::warning::The `auto-fix` input is deprecated.*AGENT_MAX_FIX_ROUNDS/.test(line))).toBe(true);
  });
});

/**
 * A PRD PR's review is a slice round or the final review (PRD #222), told
 * apart by the mark the finishing run writes into the PRD PR's body.
 */
describe("review:gate tells a slice round from the final review", () => {
  const PRD = "agent/prd-171-prd-slice-prs";

  beforeEach(() => {
    github.branches.set(PRD, BEFORE);
  });

  it("is a slice round on a PRD PR whose body carries no mark", async () => {
    github.pullRequests.get(PR)!.body = "Closes #171";

    await run(INPUTS({ BRANCH: PRD }));

    expect(decided()["round"]).toBe("slice");
  });

  it("is the final review where the body carries the finishing run's mark", async () => {
    github.pullRequests.get(PR)!.body = `Closes #171\n${FINAL_REVIEW_MARK}\n`;

    await run(INPUTS({ BRANCH: PRD }));

    expect(FINAL_REVIEW_MARK).toBe("<!-- agent:final-review requested -->");
    expect(decided()["round"]).toBe("final");
  });

  it("is no round off a PRD PR, whatever its body says", async () => {
    github.pullRequests.get(PR)!.body = FINAL_REVIEW_MARK;

    await run();

    expect(decided()["round"]).toBeUndefined();
  });

  /** Rather than guessing which round it is: a failure parks the chain. */
  it("fails, naming the PR, where the body cannot be read, having handed over the commit", async () => {
    await expect(
      run(INPUTS({ BRANCH: PRD }), { reader: (reader) => ({ ...reader, pullRequest: () => Promise.reject(new Error("502")) }) }),
    ).rejects.toThrow(/Could not read PRD PR #228's body/);

    expect(decided()).toMatchObject({ proceed: "true", sha: BEFORE, budget: "3" });
    expect(decided()["round"]).toBeUndefined();
  });
});

describe("review:gate's inputs", () => {
  it("refuses a PR_NUMBER that is not one, before reading anything", async () => {
    await expect(run(INPUTS({ PR_NUMBER: "7; rm" }))).rejects.toThrow("PR_NUMBER is");

    expect(reads).toEqual([]);
  });
});
