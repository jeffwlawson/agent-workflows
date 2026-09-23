import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Same shape as tests/pr-feedback.test.ts: only the process-spawning exports are
// replaced, because everything else in the graph that reaches for
// `node:child_process` must keep working.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  describeRound,
  detectReviewRound,
  LOOP_COMMIT_AUTHOR,
  unreadableRoundNote,
} from "../shared/review-round.js";
import { VERDICT_CONTEXT } from "../shared/review-output.js";

/**
 * Which round a review is (#96, decision 4), and it is read off the repository
 * rather than counted, because nothing in the loop holds a count: a review run
 * knows the commit it was pointed at and nothing about the ones before it.
 *
 * The consequence of getting it wrong is asymmetric, and these tests are
 * written around that asymmetry. Reading a first round as a second makes the
 * review stricter — a fix-before-merge finding becomes "needs you" — and costs
 * a human a look they did not owe. Reading a second as a first lets a fix round
 * that did not work ask for another one, which is the cycle the loop is built
 * not to have. So every case that cannot be established lands on 2.
 */

const spawned = vi.mocked(execFileSync);

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MIDDLE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIRST = "cccccccccccccccccccccccccccccccccccccccc";

const commit = (sha: string, author = LOOP_COMMIT_AUTHOR): unknown => ({
  sha,
  commit: { author: { name: author } },
});

/** The verdict as the loop posts it: our context, our account, a real state. */
const verdict = (state = "failure"): unknown => ({
  context: VERDICT_CONTEXT,
  state,
  creator: { login: "github-actions[bot]" },
});

interface Repo {
  /** Pages exactly as `gh api --paginate --slurp` returns them: an array of arrays. */
  readonly commits: unknown;
  /** Statuses per commit SHA; a thunk may throw the way a non-zero exit does. */
  readonly statuses: Record<string, () => string>;
}

const ghAnswers = (repo: Repo): void => {
  spawned.mockImplementation(((file: string, args: readonly string[]) => {
    if (file !== "gh") throw new Error(`unexpected binary: ${file}`);
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/pulls/")) {
      if (typeof repo.commits === "string") throw new Error(repo.commits);
      return JSON.stringify(repo.commits);
    }
    const sha = endpoint.split("/").pop() === "statuses" ? (endpoint.split("/").at(-2) ?? "") : "";
    const answer = repo.statuses[sha];
    if (!answer) throw new Error(`unrecorded gh call: ${args.join(" ")}`);
    return answer();
  }) as never);
};

/** Every commit answered with no statuses at all, so a test only lists the ones it cares about. */
const statuses = (over: Record<string, unknown[]> = {}): Record<string, () => string> =>
  Object.fromEntries(
    [HEAD, MIDDLE, FIRST].map((sha) => [sha, () => JSON.stringify(over[sha] ?? [])]),
  );

const PREVIOUS = process.env["GH_REPO"];

beforeEach(() => {
  spawned.mockReset();
  process.env["GH_REPO"] = "o/r";
});

afterEach(() => {
  if (PREVIOUS === undefined) delete process.env["GH_REPO"];
  else process.env["GH_REPO"] = PREVIOUS;
});

describe("detectReviewRound", () => {
  it("is round 1 when no commit carries a verdict yet", () => {
    ghAnswers({ commits: [[commit(FIRST), commit(HEAD)]], statuses: statuses() });

    expect(detectReviewRound("12")).toEqual({ round: 1 });
  });

  /**
   * The shape a fix round leaves behind, and the one this exists to recognise:
   * a verdict stands on the commit that was reviewed, and everything pushed
   * since is the loop's own.
   */
  it("is round 2 when a verdict stands and only the loop has pushed since", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD)]],
      statuses: statuses({ [MIDDLE]: [verdict()] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 2 });
  });

  /**
   * A human's commit resets it. The branch now carries work no review has seen,
   * and a verification pass over an earlier round's findings is the wrong
   * reading of that — they would be verified against a diff that moved for
   * reasons the earlier round said nothing about.
   */
  it("is round 1 again when a human has pushed since the verdict", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD, "A Maintainer")]],
      statuses: statuses({ [MIDDLE]: [verdict()] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 1 });
  });

  /**
   * A status is a thing any token holding `statuses: write` can post under any
   * context it likes, so only the account this loop's workflows run as counts.
   */
  it("ignores a status posted under the same context by another account", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: {
        ...statuses(),
        [FIRST]: () =>
          JSON.stringify([{ context: VERDICT_CONTEXT, state: "success", creator: { login: "someone-else" } }]),
      },
    });

    expect(detectReviewRound("12")).toEqual({ round: 1 });
  });

  /**
   * `error` is the review saying *there is no verdict* — the run died before it
   * reviewed anything. Counting it would make the retry after every failed run
   * a verification pass over findings that were never posted, and a round-2 run
   * with findings can only say "needs you".
   */
  it("ignores an error status, which is a run that produced no verdict", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [FIRST]: [verdict("error")] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 1 });
  });

  it("takes the latest verdict, not the first one it can find", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD, "A Maintainer")]],
      statuses: statuses({ [FIRST]: [verdict()], [MIDDLE]: [verdict()] }),
    });

    // Read from FIRST it would be round 1 either way; what this pins is that a
    // human commit *after the latest* verdict is what decides, so an older
    // verdict cannot be the one a later loop-only stretch is measured from.
    expect(detectReviewRound("12")).toEqual({ round: 1 });
  });

  /**
   * The head's own verdict counts, with nothing after it to test. Re-reviewing
   * a commit that has already been reviewed is a second pass over it however it
   * was asked for — a human re-adding `agent:review` without pushing — and
   * #96's decision 4 is written in exactly those terms: a verdict on *a commit
   * of this pull request*, and every commit after it the loop's. Pinned here
   * because it is the one case the wording admits and nobody would think to
   * ask about, and because it fails in the safe direction: the cost is a "read
   * the review" that could have been "add agent:fix".
   */
  it("is round 2 when the commit being reviewed already carries a verdict", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [HEAD]: [verdict()] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 2 });
  });

  it("reads every page, so a long pull request's head is not off the end", () => {
    ghAnswers({
      commits: [[commit(FIRST)], [commit(MIDDLE), commit(HEAD)]],
      statuses: statuses({ [MIDDLE]: [verdict()] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 2 });
  });

  describe("an unreadable history is round 2, and says so", () => {
    it("when the commits cannot be listed", () => {
      ghAnswers({ commits: "gh: Not Found", statuses: statuses() });

      const detected = detectReviewRound("12");

      expect(detected.round).toBe(2);
      expect(detected.unreadable).toContain("commits");
    });

    it("when a commit's statuses cannot be read", () => {
      ghAnswers({
        commits: [[commit(FIRST), commit(HEAD)]],
        statuses: {
          ...statuses(),
          [HEAD]: () => {
            throw new Error("gh: Resource not accessible");
          },
        },
      });

      const detected = detectReviewRound("12");

      expect(detected.round).toBe(2);
      expect(detected.unreadable).toContain(HEAD.slice(0, 7));
    });

    /**
     * A commit with no SHA takes the whole listing with it rather than being
     * skipped: skipping it would drop a commit from the "every commit since"
     * test, which is the one test missing data can only weaken.
     */
    it("when a commit in the listing has no SHA to look up", () => {
      ghAnswers({ commits: [[{ commit: { author: { name: LOOP_COMMIT_AUTHOR } } }]], statuses: statuses() });

      expect(detectReviewRound("12").round).toBe(2);
    });
  });
});

describe("what a round is reported as", () => {
  it("tells the agent which pass it is doing", () => {
    expect(describeRound({ round: 1 })).toContain("round 1");
    expect(describeRound({ round: 2 })).toContain("round 2");
  });

  /**
   * And an assumed round says it was assumed, in both places a reader meets it:
   * the brief the agent works from and the summary a human reads. A review that
   * quietly reads as a verification of a round that may not exist is the
   * hardest state here to notice from the outside.
   */
  it("says a round it could not establish was the stricter reading", () => {
    const detected = { round: 2, unreadable: "this pull request's commits could not be listed" } as const;

    expect(describeRound(detected)).toContain("could not be listed");
    expect(unreadableRoundNote(detected)).toContain("could not be listed");
  });

  it("adds nothing to the summary of a round it did establish", () => {
    expect(unreadableRoundNote({ round: 2 })).toBeUndefined();
    expect(unreadableRoundNote({ round: 1 })).toBeUndefined();
  });
});
