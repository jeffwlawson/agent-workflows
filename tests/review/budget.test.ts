import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubReader } from "../../engine/read.js";
import { budget } from "../../review/budget.js";
import type { ReadingIo } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import type { PrdBranch } from "../../shared/prd-round.js";
import { FIX_ROUND_STATUS, VERDICT_CONTEXT } from "../../shared/record.js";
import { roundHeader, type RoundScope } from "../../shared/round-header.js";
import { fakeGitHub, fakeReader, type FakeGitHub, type ReceivedRead } from "../engine/fakes.js";

/**
 * `review:budget` (#331), called the way the CLI calls it: its declared
 * inputs, a fake GitHub reader holding the pull request's statuses and
 * reviews, and its declared outputs. On a PRD PR, the current slice is what
 * `readPrdBranch` reads off the checkout, which this file stands in for.
 *
 * The scenarios off a PRD PR are the ones `tests/review/gate.test.ts` held
 * before the counting moved here, carried over by behaviour.
 */

const branch = vi.hoisted(() => ({ read: undefined as (() => unknown) | undefined }));

vi.mock("../../shared/prd-round.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/prd-round.js")>()),
  readPrdBranch: () => {
    if (branch.read === undefined) throw new Error("readPrdBranch was not expected here");
    return branch.read();
  },
}));

const PR = 330;
const BRANCH = "agent/issue-330-fix";
const PRD = "agent/prd-314-slices";
const LOOP = "github-actions[bot]";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const C4 = "4".repeat(40);
/** 0.7.6's *fix round started* verdict line, from before `FIX_ROUND_STATUS` (#297). */
const OLD_FIX_ROUND_STARTED =
  "Changes recommended. The fixes are clear. A fix round has already started; a re-review follows automatically.";

let github: FakeGitHub;
let reads: ReceivedRead[];
let files: Map<string, unknown>;
let logged: string[];

beforeEach(() => {
  github = fakeGitHub([{ number: PR }]);
  github.commits.set(PR, [C1, C2, C3, C4]);
  branch.read = undefined;
  files = new Map();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Inputs = Parameters<typeof budget>[0];

/** A review of a regular pull request, with the loop's App set up and the default budget. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  AGENT_LOOP_LOGINS: "",
  PR_NUMBER: String(PR),
  BRANCH,
  BASE_REF: "main",
  ROUND: "",
  FIX_ROUND_BUDGET: "3",
  LOOP_TOKEN_SOURCE: "app",
  ...over,
});

const run = async (inputs: Inputs = INPUTS(), reader?: (reader: GitHubReader) => GitHubReader): Promise<void> => {
  const fake = fakeReader(github);
  reads = fake.reads as ReceivedRead[];
  const io: ReadingIo<(typeof COMMANDS)["review:budget"]["outputs"]> = {
    github: reader?.(fake.reader) ?? fake.reader,
    outputs: {
      writeJson: (name, value) => files.set(name, value),
      writeText: (name, value) => files.set(name, value),
      appendLine: () => {},
    },
  };
  await budget(inputs, io);
};

const decided = (): Record<string, string> => files.get("budget.json") as Record<string, string>;

const reviewUrl = (n: number): string => `https://github.com/o/r/pull/${PR}#pullrequestreview-${n}`;
const round = (url: string | null, creator = LOOP) => ({ context: FIX_ROUND_STATUS.context, state: "success", targetUrl: url, description: "", creator });

/** A review the loop posted on the pull request, opening with `scope`'s header. */
const posted = (n: number, scope: RoundScope, commit = C1): void => {
  github.reviews.push({
    token: "workflow",
    pullRequestId: github.pullRequests.get(PR)!.nodeId,
    commit,
    body: `${roundHeader(scope, "review", 1)}\n\n## Agent review\n\nChanges recommended.`,
    threads: [],
    url: reviewUrl(n),
  });
};

describe("review:budget off a PRD PR counts the pull request's rounds", () => {
  it("starts a round where none is spent", async () => {
    await run();

    expect(decided()).toEqual({ budget: "3", spent: "0", start: "true" });
    expect(reads.map((r) => r.method)).not.toContain("reviews");
  });

  it("counts each review's round once, across the commits it was copied on to", async () => {
    github.statuses.set(C1, [round(reviewUrl(1))]);
    github.statuses.set(C2, [round(reviewUrl(1)), round(reviewUrl(2))]);

    await run(INPUTS({ FIX_ROUND_BUDGET: "2" }));

    expect(decided()).toEqual({ budget: "2", spent: "2", start: "false" });
  });

  /**
   * 0.7.6's *fix round started* verdict line was counted as a round for one
   * release after #297, and is not any more (#224): only the round record is.
   */
  it("counts only the loop's own round statuses, and not a 0.7.6 verdict that started a round", async () => {
    github.statuses.set(C1, [
      round(reviewUrl(1), "someone"),
      { context: VERDICT_CONTEXT, state: "failure", targetUrl: reviewUrl(2), description: OLD_FIX_ROUND_STARTED, creator: LOOP },
      { context: VERDICT_CONTEXT, state: "failure", targetUrl: reviewUrl(3), description: "Changes recommended.", creator: LOOP },
    ]);

    await run();

    expect(decided()).toMatchObject({ spent: "0", start: "true" });
  });

  /**
   * An orchestrator posting as its own App (#376): its rounds count once its
   * account is passed in, beside the default, and not before.
   */
  it("counts a round posted by an account the orchestrator passes in", async () => {
    github.statuses.set(C1, [round(reviewUrl(1), "my-loop[bot]")]);
    github.statuses.set(C2, [round(reviewUrl(2))]);

    await run(INPUTS({ AGENT_LOOP_LOGINS: "other-loop, my-loop[bot]," }));
    expect(decided()).toMatchObject({ spent: "2", start: "true" });

    await run(INPUTS());
    expect(decided()).toMatchObject({ spent: "1", start: "true" });
  });

  it("fails, naming the entry, on an account that is not a login", async () => {
    await expect(run(INPUTS({ AGENT_LOOP_LOGINS: "my-loop[bot], not a login" }))).rejects.toThrow(
      "`AGENT_LOOP_LOGINS` holds `not a login`, which is not a GitHub login.",
    );
    expect(decided()).toEqual({});
  });

  it("counts a round with no link on its own", async () => {
    github.statuses.set(C1, [round(null), round(null)]);

    await run();

    expect(decided()).toMatchObject({ spent: "2", start: "true" });
  });

  /** A label added with the workflow token starts nothing (#316). */
  it.each(["workflow", ""])("starts no round where the loop's token is %j", async (source) => {
    await run(INPUTS({ LOOP_TOKEN_SOURCE: source }));

    expect(decided()).toEqual({ budget: "3", spent: "0", start: "false" });
  });

  it("starts no round, and warns, where the rounds spent cannot be counted", async () => {
    await run(INPUTS(), (reader) => ({ ...reader, commitStatuses: () => Promise.reject(new Error("403 statuses")) }));

    expect(decided()).toEqual({ budget: "3", spent: "", start: "false" });
    expect(logged.join("\n")).toContain("403 statuses");
    expect(logged.some((line) => line.startsWith(`::warning::Could not count the automatic fix rounds already spent on PR #${PR}`))).toBe(true);
  });

  it("counts nothing for a budget of 0", async () => {
    await run(INPUTS({ FIX_ROUND_BUDGET: "0" }));

    expect(decided()).toEqual({ budget: "0", spent: "0", start: "false" });
    expect(reads.map((r) => r.method)).not.toContain("pullRequestCommits");
  });

  /** `review:gate` refused the variable before the checkout; a value that is not a number here is a wiring fault. */
  it.each(["", "three", "-1"])("fails on a FIX_ROUND_BUDGET of %j, having decided nothing", async (value) => {
    await expect(run(INPUTS({ FIX_ROUND_BUDGET: value }))).rejects.toThrow("FIX_ROUND_BUDGET");
    expect(decided()).toEqual({});
  });
});

/**
 * On a PRD PR the budget is the round's (#331): each slice round has its own,
 * and the final review has its own. A status counts toward the round its
 * linked review's header names, never by the commit it stands on.
 */
describe("review:budget on a PRD PR counts this round's rounds alone", () => {
  const SLICE = (k: number, subIssue: number): RoundScope => ({ kind: "slice", k, n: 8, subIssue });
  const FINAL: RoundScope = { kind: "final" };

  /** The PRD branch with slice `k` of 8, sub-issue `subIssue`, current. */
  const current = (k: number, subIssue: number): void => {
    branch.read = (): Pick<PrdBranch, "ranges"> => ({
      ranges: { slices: [], next: null, current: { subIssue, k, n: 8 } },
    });
  };

  /** #330: slices 2, 4 and 6 each spent one round, and slice 8 had spent none. */
  const earlierSlicesSpentTheBudget = (): void => {
    posted(1, SLICE(2, 316), C1);
    posted(2, SLICE(4, 318), C2);
    posted(3, SLICE(6, 320), C3);
    github.statuses.set(C1, [round(reviewUrl(1))]);
    github.statuses.set(C2, [round(reviewUrl(2))]);
    github.statuses.set(C3, [round(reviewUrl(3))]);
  };

  it("starts a slice's first round where earlier slices spent the whole budget", async () => {
    earlierSlicesSpentTheBudget();
    current(8, 322);

    await run(INPUTS({ BRANCH: PRD, ROUND: "slice" }));

    expect(decided()).toEqual({ budget: "3", spent: "0", start: "true" });
    expect(logged).toContain("Fix-round budget 3, spent 0 in slice 8 of 8, #322; an automatic fix round starts on changes recommended: true.");
  });

  it("counts the current slice's own rounds against its budget, as on any pull request", async () => {
    earlierSlicesSpentTheBudget();
    posted(4, SLICE(8, 322), C4);
    posted(5, SLICE(8, 322), C4);
    posted(6, SLICE(8, 322), C4);
    github.statuses.set(C4, [round(reviewUrl(4)), round(reviewUrl(5)), round(reviewUrl(6))]);
    current(8, 322);

    await run(INPUTS({ BRANCH: PRD, ROUND: "slice" }));

    expect(decided()).toEqual({ budget: "3", spent: "3", start: "false" });
  });

  /**
   * The final review reviews the last slice's tip, so its first round's
   * status stands on a commit in the last slice's range. It is the final
   * review's, by the review it links to.
   */
  it("counts a final review's round against the final review, though it stands on the last slice's tip", async () => {
    posted(1, SLICE(8, 322), C3);
    github.statuses.set(C3, [round(reviewUrl(1))]);
    posted(2, FINAL, C4);
    github.statuses.set(C4, [round(reviewUrl(2))]);

    await run(INPUTS({ BRANCH: PRD, ROUND: "final" }));
    expect(decided()).toEqual({ budget: "3", spent: "1", start: "true" });

    current(8, 322);
    await run(INPUTS({ BRANCH: PRD, ROUND: "slice" }));
    expect(decided()).toEqual({ budget: "3", spent: "1", start: "true" });
  });

  it("gives the final review a budget of its own, whatever the slices spent", async () => {
    earlierSlicesSpentTheBudget();

    await run(INPUTS({ BRANCH: PRD, ROUND: "final" }));

    expect(decided()).toEqual({ budget: "3", spent: "0", start: "true" });
    expect(logged).toContain("Fix-round budget 3, spent 0 in the final review; an automatic fix round starts on changes recommended: true.");
  });

  it("counts a round copied on to a merge commit once", async () => {
    posted(1, SLICE(8, 322), C3);
    github.statuses.set(C3, [round(reviewUrl(1))]);
    github.statuses.set(C4, [round(reviewUrl(1))]);
    current(8, 322);

    await run(INPUTS({ BRANCH: PRD, ROUND: "slice", FIX_ROUND_BUDGET: "1" }));

    expect(decided()).toEqual({ budget: "1", spent: "1", start: "false" });
  });

  it.each([
    ["links no review", () => github.statuses.set(C1, [round(null)])],
    ["links a review that is not on the pull request", () => github.statuses.set(C1, [round(reviewUrl(9))])],
    [
      "links a review whose header names no round",
      () => {
        posted(1, { kind: "regular" });
        github.statuses.set(C1, [round(reviewUrl(1))]);
      },
    ],
  ])("starts no round, and warns, where a status %s", async (_, given) => {
    given();
    current(8, 322);

    await run(INPUTS({ BRANCH: PRD, ROUND: "slice" }));

    expect(decided()).toEqual({ budget: "3", spent: "", start: "false" });
    expect(logged.some((line) => line.startsWith("Counting the fix rounds failed: An `agent-fix-round` status"))).toBe(true);
    expect(logged.some((line) => line.startsWith(`::warning::Could not count the automatic fix rounds already spent in this round of PRD PR #${PR}`))).toBe(true);
  });

  it("starts no round, and warns, where the PRD branch cannot be read", async () => {
    branch.read = () => {
      throw new Error("fatal: bad revision");
    };

    await run(INPUTS({ BRANCH: PRD, ROUND: "slice" }));

    expect(decided()).toEqual({ budget: "3", spent: "", start: "false" });
    expect(logged.join("\n")).toContain("fatal: bad revision");
  });

  it("starts no round, and warns, where no slice is on the branch", async () => {
    branch.read = (): Pick<PrdBranch, "ranges"> => ({ ranges: { slices: [], next: 316, current: null } });

    await run(INPUTS({ BRANCH: PRD, ROUND: "slice" }));

    expect(decided()).toEqual({ budget: "3", spent: "", start: "false" });
  });

  it("reads neither the branch nor the reviews for a budget of 0", async () => {
    await run(INPUTS({ BRANCH: PRD, ROUND: "slice", FIX_ROUND_BUDGET: "0" }));

    expect(decided()).toEqual({ budget: "0", spent: "0", start: "false" });
    expect(reads).toEqual([]);
  });
});
