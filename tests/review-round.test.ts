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
  describesTheChange,
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
 * review stricter — a fix-before-merge finding is answered "a fix round didn't
 * settle these" — and costs a human a look they did not owe. Reading a second as a first lets a fix round
 * that did not work ask for another one, which is the cycle the loop is built
 * not to have. So every case that cannot be established lands on 2.
 */

const spawned = vi.mocked(execFileSync);

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MIDDLE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIRST = "cccccccccccccccccccccccccccccccccccccccc";

/** An ordinary commit: one parent, which is what a fix round pushes. */
const commit = (sha: string, author = LOOP_COMMIT_AUTHOR): unknown => ({
  sha,
  parents: [{ sha: "parent" }],
  commit: { author: { name: author } },
});

/**
 * And the other kind this loop makes: the merge `update-branch` commits when it
 * resolves conflicts. Two parents, the same author, and *not* an attempt at
 * anybody's findings — which is the whole of why the round rule now asks.
 */
const merge = (sha: string, author = LOOP_COMMIT_AUTHOR): unknown => ({
  sha,
  parents: [{ sha: "parent" }, { sha: "base" }],
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
  /**
   * Statuses per commit SHA, also as pages — this endpoint is paginated too,
   * and returns one entry per status *post* rather than one per context, so a
   * verdict on an ordinary repository is not reliably on page 1. A thunk, so a
   * scenario can throw the way a non-zero exit does.
   */
  readonly statuses: Record<string, () => string>;
}

/**
 * What a call that asked for **one** page gets back, which is what makes the
 * pagination tests below mean anything: `--paginate --slurp` returns every page
 * wrapped in an outer array, and a call without it returns the first page's
 * entries and nothing else. A stub that answered both the same way would pass
 * whether or not the code paginates.
 */
const paged = (pages: string, args: readonly string[]): string => {
  if (args.includes("--paginate")) return pages;
  const first = (JSON.parse(pages) as unknown[])[0];

  return JSON.stringify(first ?? []);
};

const ghAnswers = (repo: Repo): void => {
  spawned.mockImplementation(((file: string, args: readonly string[]) => {
    if (file !== "gh") throw new Error(`unexpected binary: ${file}`);
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/pulls/")) {
      if (typeof repo.commits === "string") throw new Error(repo.commits);
      return paged(JSON.stringify(repo.commits), args);
    }
    const sha = endpoint.split("/").pop() === "statuses" ? (endpoint.split("/").at(-2) ?? "") : "";
    const answer = repo.statuses[sha];
    if (!answer) throw new Error(`unrecorded gh call: ${args.join(" ")}`);
    return paged(answer(), args);
  }) as never);
};

/**
 * Every commit answered with no statuses at all, so a test only lists the ones
 * it cares about. A plain list becomes a single page; a test that cares where
 * the verdict sits passes the pages itself.
 */
const statuses = (over: Record<string, unknown[] | unknown[][]> = {}): Record<string, () => string> =>
  Object.fromEntries(
    [HEAD, MIDDLE, FIRST].map((sha) => {
      const recorded = over[sha] ?? [];
      const pages = recorded.every((entry) => Array.isArray(entry)) ? recorded : [recorded];

      return [sha, () => JSON.stringify(pages)];
    }),
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

    expect(detectReviewRound("12")).toEqual({ round: 1, unreviewedCommits: true });
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

    expect(detectReviewRound("12")).toEqual({ round: 2, unreviewedCommits: true });
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

    expect(detectReviewRound("12")).toEqual({ round: 1, unreviewedCommits: true });
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
          JSON.stringify([[{ context: VERDICT_CONTEXT, state: "success", creator: { login: "someone-else" } }]]),
      },
    });

    expect(detectReviewRound("12")).toEqual({ round: 1, unreviewedCommits: true });
  });

  /**
   * `error` is the review saying *there is no verdict* — the run died before it
   * reviewed anything. Counting it would make the retry after every failed run
   * a verification pass over findings that were never posted, and a round-2 run
   * with findings can only answer "a fix round didn't settle these".
   */
  it("ignores an error status, which is a run that produced no verdict", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [FIRST]: [verdict("error")] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 1, unreviewedCommits: true });
  });

  it("takes the latest verdict, not the first one it can find", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD, "A Maintainer")]],
      statuses: statuses({ [FIRST]: [verdict()], [MIDDLE]: [verdict()] }),
    });

    // Read from FIRST it would be round 1 either way; what this pins is that a
    // human commit *after the latest* verdict is what decides, so an older
    // verdict cannot be the one a later loop-only stretch is measured from.
    expect(detectReviewRound("12")).toEqual({ round: 1, unreviewedCommits: true });
  });

  /**
   * The head's own verdict, with nothing pushed after it: a human re-adding
   * `agent:review` on a commit that already carries one. A round **1**, because
   * the third condition has nothing to find — no fix has been attempted, so
   * there is nothing for a verification pass to verify.
   *
   * Pinned because it reads the opposite way to the rest of the file and the
   * reason is worth keeping: reaching this at all takes a human adding the
   * label by hand, and every automatic leg into review runs off a push. The
   * cycle the round rule bounds cannot be opened from here.
   */
  it("is round 1 when the commit being reviewed carries a verdict and nothing was pushed after", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [HEAD]: [verdict()] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 1, unreviewedCommits: false });
  });

  /**
   * A conflict resolution is a **merge** commit under the loop's own identity,
   * so without the third condition it would make the next review a round 2 —
   * and a pull request sitting at *changes recommended* that then hit conflicts
   * would have its never-attempted findings answered with the round-2 line by
   * nothing more than the base branch moving (#105).
   */
  it("is round 1 when the only loop commit since the verdict is a merge", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), merge(HEAD)]],
      statuses: statuses({ [MIDDLE]: [verdict()] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 1, unreviewedCommits: true });
  });

  /** And a fix that was attempted stays a round 2, merge or no merge after it. */
  it("is round 2 when a fix commit and a merge have both landed since the verdict", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), merge(HEAD)]],
      statuses: statuses({ [FIRST]: [verdict()] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 2, unreviewedCommits: true });
  });

  it("reads every page, so a long pull request's head is not off the end", () => {
    ghAnswers({
      commits: [[commit(FIRST)], [commit(MIDDLE), commit(HEAD)]],
      statuses: statuses({ [MIDDLE]: [verdict()] }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 2, unreviewedCommits: true });
  });

  /**
   * And every page of the *statuses*, which is the endpoint that pages fastest:
   * it returns one entry per status post rather than one per context, so an
   * adopter's external CI spends two of the thirty on every
   * `pending → success`. Unpaginated this answered `false` rather than
   * `undefined` — a second round read as a first, the one direction this file
   * must never fail in.
   */
  it("finds a verdict that has fallen off the first page of statuses", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD)]],
      statuses: statuses({
        [MIDDLE]: [
          Array.from({ length: 30 }, () => ({
            context: "ci/deploy",
            state: "success",
            creator: { login: "deploy-bot[bot]" },
          })),
          [verdict()],
        ],
      }),
    });

    expect(detectReviewRound("12")).toEqual({ round: 2, unreviewedCommits: true });
  });

  /**
   * **Whether there is code on this pull request nothing has described yet**,
   * which the round alone cannot say: three different situations are all
   * `round: 1`, and only two of them are looking at unreviewed commits.
   *
   * What reads it is *What changed in this PR*, rendered on those two and
   * omitted on the third (#109, decision 8 as the maintainer settled it). The
   * failure it prevents is silent and cheap to reintroduce — a body that
   * describes the change again, at the top, to a reader who was handed that
   * description last round.
   */
  describe("whether commits have landed that no verdict has seen", () => {
    it("says yes on the first review, where no verdict exists anywhere", () => {
      ghAnswers({ commits: [[commit(FIRST), commit(HEAD)]], statuses: statuses() });

      expect(detectReviewRound("12").unreviewedCommits).toBe(true);
    });

    it("says no on a re-review with nothing pushed since the last verdict", () => {
      ghAnswers({
        commits: [[commit(FIRST), commit(HEAD)]],
        statuses: statuses({ [HEAD]: [verdict()] }),
      });

      expect(detectReviewRound("12").unreviewedCommits).toBe(false);
    });

    it("says yes on a round 1 a human's push made", () => {
      ghAnswers({
        commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD, "A Maintainer")]],
        statuses: statuses({ [MIDDLE]: [verdict()] }),
      });

      expect(detectReviewRound("12")).toEqual({ round: 1, unreviewedCommits: true });
    });

    /**
     * And nothing at all where the history could not be read. The round goes
     * to 2 there, which omits the section anyway; asserting a fact this file
     * could not establish is the habit worth not having.
     */
    it("claims nothing when the commits could not be listed", () => {
      ghAnswers({ commits: "gh: Not Found", statuses: statuses() });

      expect(detectReviewRound("12").unreviewedCommits).toBe(false);
    });
  });

  /**
   * The join the body reads: whether this review describes the change at all.
   *
   * Here rather than in the runner, which has no test around it, and not in the
   * renderer, which knows nothing about rounds.
   */
  describe("describesTheChange", () => {
    it.each([
      ["a first review", { round: 1, unreviewedCommits: true }, true],
      ["a round 1 a push made", { round: 1, unreviewedCommits: true }, true],
      ["a re-review with nothing pushed", { round: 1, unreviewedCommits: false }, false],
      ["a verification pass", { round: 2, unreviewedCommits: true }, false],
      ["an unreadable history", { round: 2, unreviewedCommits: false }, false],
    ] as const)("is %s: %o", (_case, detected, expected) => {
      expect(describesTheChange(detected)).toBe(expected);
    });
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
      ghAnswers({
        commits: [[{ parents: [], commit: { author: { name: LOOP_COMMIT_AUTHOR } } }]],
        statuses: statuses(),
      });

      expect(detectReviewRound("12").round).toBe(2);
    });

    /**
     * And a commit with no `parents` goes the same way, for the same reason:
     * guessing at it would decide "was anything attempted since the verdict"
     * from data that was not there, and the two guesses are a full review
     * nobody needed or a verification pass over an untouched branch.
     */
    it("when a commit in the listing does not say how many parents it has", () => {
      ghAnswers({
        commits: [[{ sha: HEAD, commit: { author: { name: LOOP_COMMIT_AUTHOR } } }]],
        statuses: statuses(),
      });

      expect(detectReviewRound("12").round).toBe(2);
    });
  });
});

describe("what a round is reported as", () => {
  it("tells the agent which pass it is doing", () => {
    expect(describeRound({ round: 1, unreviewedCommits: true })).toContain("round 1");
    expect(describeRound({ round: 2, unreviewedCommits: true })).toContain("round 2");
  });

  /**
   * And an assumed round says it was assumed, in both places a reader meets it:
   * the brief the agent works from and the summary a human reads. A review that
   * quietly reads as a verification of a round that may not exist is the
   * hardest state here to notice from the outside.
   */
  it("says a round it could not establish was the stricter reading", () => {
    const detected = {
      round: 2,
      unreadable: "this pull request's commits could not be listed",
      unreviewedCommits: false,
    } as const;

    expect(describeRound(detected)).toContain("could not be listed");
    expect(unreadableRoundNote(detected)).toContain("could not be listed");
  });

  it("adds nothing to the summary of a round it did establish", () => {
    expect(unreadableRoundNote({ round: 2, unreviewedCommits: true })).toBeUndefined();
    expect(unreadableRoundNote({ round: 1, unreviewedCommits: true })).toBeUndefined();
  });
});
