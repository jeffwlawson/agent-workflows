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
  describeHistory,
  describesTheChange,
  fixRoundProgress,
  readReviewHistory,
  unreadableHistoryNote,
  type ReviewHistory,
} from "../shared/review-round.js";
import { VERDICT_CONTEXT, VERDICTS } from "../shared/review-output.js";
import type { CarriedFinding } from "../shared/review-verification.js";

/**
 * What the verdicts on a pull request say about the review now running (#202,
 * PRD #200), read off the repository: whether it follows a fix round, and
 * whether it is looking at commits nothing has described.
 *
 * Read from the verdict history and nothing else. The round rule this replaced
 * decided a "round 2" from who authored the commits since the last verdict; it
 * is retired, and no code decides anything from commit authorship.
 *
 * Where the history cannot be read, it is taken as following a fix round: the
 * stricter reading, since the early stop then parks the loop for a human
 * rather than spending a round nobody can judge.
 */

const spawned = vi.mocked(execFileSync);

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MIDDLE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIRST = "cccccccccccccccccccccccccccccccccccccccc";

/**
 * A commit as the listing returns it. The author and the parents are there
 * because the real listing carries them, and the round rule this replaced read
 * both; nothing here may (#202), which the tests below pin by varying them.
 */
const commit = (sha: string, author = "sandcastle-agent[bot]", parents = 1): unknown => ({
  sha,
  parents: Array.from({ length: parents }, (_, i) => ({ sha: `parent-${i}` })),
  commit: { author: { name: author } },
});

/** A verdict as the loop posts it: our context, our account, a real state. */
const verdict = (description = VERDICTS["changes recommended"].description, state = "failure"): unknown => ({
  context: VERDICT_CONTEXT,
  state,
  description,
  creator: { login: "github-actions[bot]" },
});

/** The verdict that announced an automatic fix round. */
const started = (): unknown => verdict(VERDICTS["changes recommended, fix round started"].description);

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

describe("readReviewHistory", () => {
  it("follows no fix round when no commit carries a verdict yet", () => {
    ghAnswers({ commits: [[commit(FIRST), commit(HEAD)]], statuses: statuses() });

    expect(readReviewHistory("12")).toEqual({ afterFixRound: false, unreviewedCommits: true });
  });

  /**
   * The shape an automatic round leaves behind, and the one this exists to
   * recognise: the verdict that announced the round stands on the commit that
   * was reviewed, and the fix has pushed since.
   */
  it("follows a fix round when the latest verdict started one and commits have landed since", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD)]],
      statuses: statuses({ [MIDDLE]: [started()] }),
    });

    expect(readReviewHistory("12")).toEqual({ afterFixRound: true, unreviewedCommits: true });
  });

  /**
   * **Not from authorship.** Whoever wrote the commits since, and whether they
   * are merges, the answer is the verdict's: the round rule that read both is
   * retired (#202).
   */
  it.each([
    ["a human's commit", commit(HEAD, "A Maintainer")],
    ["a merge", commit(HEAD, "sandcastle-agent[bot]", 2)],
    ["a human's merge", commit(HEAD, "A Maintainer", 2)],
  ])("gives the same answer when the commit since is %s", (_case, head) => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), head]],
      statuses: statuses({ [MIDDLE]: [started()] }),
    });
    expect(readReviewHistory("12")).toEqual({ afterFixRound: true, unreviewedCommits: true });

    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), head]],
      statuses: statuses({ [MIDDLE]: [verdict()] }),
    });
    expect(readReviewHistory("12")).toEqual({ afterFixRound: false, unreviewedCommits: true });
  });

  /**
   * Any other verdict started no round, so what landed since it is a human's
   * push, a human-started fix, or a merge: none of it spent the budget, and the
   * early stop has nothing to judge.
   */
  it.each([
    ["changes recommended"],
    ["approval recommended"],
    ["needs a closer look"],
  ] as const)("follows no fix round after a %s verdict", (key) => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD)]],
      statuses: statuses({ [MIDDLE]: [verdict(VERDICTS[key].description)] }),
    });

    expect(readReviewHistory("12").afterFixRound).toBe(false);
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
          JSON.stringify([
            [
              {
                context: VERDICT_CONTEXT,
                state: "failure",
                description: VERDICTS["changes recommended, fix round started"].description,
                creator: { login: "someone-else" },
              },
            ],
          ]),
      },
    });

    expect(readReviewHistory("12")).toEqual({ afterFixRound: false, unreviewedCommits: true });
  });

  /**
   * `error` is the review saying *there is no verdict*: the run died before it
   * reviewed anything. So the retry after a failed review of a fix still reads
   * the verdict that started the round.
   */
  it("ignores an error status, which is a run that produced no verdict", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [FIRST]: [started()], [HEAD]: [verdict("the review failed", "error")] }),
    });

    expect(readReviewHistory("12")).toEqual({ afterFixRound: true, unreviewedCommits: true });
  });

  it("takes the latest verdict, not the first one it can find", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(MIDDLE), commit(HEAD)]],
      statuses: statuses({ [FIRST]: [started()], [MIDDLE]: [verdict()] }),
    });

    expect(readReviewHistory("12").afterFixRound).toBe(false);
  });

  /**
   * And the latest verdict *on* a commit, which the endpoint lists first: a
   * re-review of one commit posts a second verdict over the first.
   */
  it("takes the newest verdict on a commit that carries two", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [FIRST]: [verdict(), started()] }),
    });

    expect(readReviewHistory("12").afterFixRound).toBe(false);
  });

  /**
   * The head's own verdict, with nothing pushed after it: a human re-adding
   * `agent:review` on a commit that already carries one. No fix has pushed, so
   * there is nothing for the early stop to judge, even where that verdict
   * started a round.
   */
  it("follows no fix round when the commit being reviewed carries the verdict", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [HEAD]: [started()] }),
    });

    expect(readReviewHistory("12")).toEqual({ afterFixRound: false, unreviewedCommits: false });
  });

  /**
   * **Unless the fix run left an out-of-scope note** (#213): that run asked for
   * this review without pushing, so the round it was is one the early stop
   * judges, and this review restates the follow-ups its record replaces.
   */
  it("follows a fix round when the round pushed nothing but posted a note", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [HEAD]: [started()] }),
    });

    expect(readReviewHistory("12", true)).toEqual({ afterFixRound: true, unreviewedCommits: false });
    expect(describeHistory(readReviewHistory("12", true))).toMatch(/follows a fix round.*out-of-scope notes/);
  });

  /** A note after any other verdict is a human-started fix, which spends no budget. */
  it("follows no fix round when a note follows a verdict that started none", () => {
    ghAnswers({
      commits: [[commit(FIRST), commit(HEAD)]],
      statuses: statuses({ [HEAD]: [verdict()] }),
    });

    expect(readReviewHistory("12", true).afterFixRound).toBe(false);
  });

  it("reads every page, so a long pull request's head is not off the end", () => {
    ghAnswers({
      commits: [[commit(FIRST)], [commit(MIDDLE), commit(HEAD)]],
      statuses: statuses({ [MIDDLE]: [started()] }),
    });

    expect(readReviewHistory("12")).toEqual({ afterFixRound: true, unreviewedCommits: true });
  });

  /**
   * And every page of the *statuses*, which is the endpoint that pages fastest:
   * it returns one entry per status post rather than one per context, so an
   * adopter's external CI spends two of the thirty on every
   * `pending → success`.
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
          [started()],
        ],
      }),
    });

    expect(readReviewHistory("12")).toEqual({ afterFixRound: true, unreviewedCommits: true });
  });

  describe("an unreadable history follows a fix round, and says so", () => {
    it("when the commits cannot be listed", () => {
      ghAnswers({ commits: "gh: Not Found", statuses: statuses() });

      const history = readReviewHistory("12");

      expect(history.afterFixRound).toBe(true);
      expect(history.unreviewedCommits).toBe(false);
      expect(history.unreadable).toContain("commits");
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

      const history = readReviewHistory("12");

      expect(history.afterFixRound).toBe(true);
      expect(history.unreadable).toContain(HEAD.slice(0, 7));
    });

    /**
     * A commit with no SHA takes the whole listing with it rather than being
     * skipped: skipping it could drop the commits landed since the verdict.
     */
    it("when a commit in the listing has no SHA to look up", () => {
      ghAnswers({ commits: [[{ parents: [] }]], statuses: statuses() });

      expect(readReviewHistory("12").afterFixRound).toBe(true);
    });
  });
});

/**
 * **The progress test** (#202, PRD #200 decision 5): what the fix round this
 * review follows closed of the findings it was given, matched by id. The rule
 * that turns the counts into an early stop is `deriveVerdict`'s, and is tested
 * with it.
 */
describe("fixRoundProgress", () => {
  const finding = (id: string, over: Partial<CarriedFinding> = {}): CarriedFinding => ({
    id,
    threadId: `T_${id}`,
    text: `src/a.ts:1: claim ${id}`,
    ...over,
  });
  const AFTER: ReviewHistory = { afterFixRound: true, unreviewedCommits: true };

  it("counts the given findings this review closed", () => {
    const given = [finding("f-1"), finding("f-2"), finding("f-3")];

    expect(fixRoundProgress(AFTER, given, [given[0]!, given[2]!])).toEqual({ given: 3, closed: 2 });
    expect(fixRoundProgress(AFTER, given, [])).toEqual({ given: 3, closed: 0 });
  });

  /**
   * By id and never by text: a closure of a finding the round was not given is
   * not its progress, whatever it says.
   */
  it("matches by id, so a finding it was not given is not progress", () => {
    const given = [finding("f-1")];

    expect(fixRoundProgress(AFTER, given, [finding("f-9", { text: given[0]!.text })])).toEqual({
      given: 1,
      closed: 0,
    });
  });

  /**
   * A thread already carrying the closing reply was verified by an earlier
   * review; only its resolve failed. Closing it again says nothing about this
   * fix round, so it is in neither count.
   */
  it("leaves out a finding an earlier review already verified", () => {
    const earlier = finding("f-1", { closedAs: "ADDRESSED" });
    const given = [earlier, finding("f-2")];

    expect(fixRoundProgress(AFTER, given, [earlier])).toEqual({ given: 1, closed: 0 });
  });

  it("is nothing to judge where this review follows no fix round", () => {
    expect(
      fixRoundProgress({ afterFixRound: false, unreviewedCommits: true }, [finding("f-1")], []),
    ).toBeUndefined();
  });
});

/**
 * The join the body reads: whether this review describes the change at all
 * (#109, decision 8 as the maintainer settled it).
 */
describe("describesTheChange", () => {
  it.each([
    ["a first review, or a push after a verdict that started no round", { afterFixRound: false, unreviewedCommits: true }, true],
    ["a re-review with nothing pushed", { afterFixRound: false, unreviewedCommits: false }, false],
    ["the review after a fix round", { afterFixRound: true, unreviewedCommits: true }, false],
    [
      "an unreadable history",
      { afterFixRound: true, unreviewedCommits: false, unreadable: "the commits could not be listed" },
      false,
    ],
  ] as const)("is %s: %o", (_case, history, expected) => {
    expect(describesTheChange(history)).toBe(expected);
  });
});

describe("what the history is reported as", () => {
  it("tells the agent whether it follows a fix round, and names no round number", () => {
    const after = describeHistory({ afterFixRound: true, unreviewedCommits: true });
    const first = describeHistory({ afterFixRound: false, unreviewedCommits: true });

    expect(after).toContain("follows a fix round");
    expect(first).toContain("no fix round");
    for (const line of [after, first]) expect(line).not.toMatch(/round [12]/);
  });

  /**
   * A fix round a human started by adding `agent:fix` posts no verdict, so the
   * review after it reads as following none. The line names that case rather
   * than calling every such commit a human's push or a merge.
   */
  it("names a fix round a human started among the commits that follow no recognised round", () => {
    const line = describeHistory({ afterFixRound: false, unreviewedCommits: true });

    expect(line).toContain("a human's push");
    expect(line).toContain("a merge");
    expect(line).toContain("a fix round a human started by adding `agent:fix`");
  });

  /**
   * And an assumed history says it was assumed, in both places a reader meets
   * it: the brief the agent works from and the summary a human reads.
   */
  it("says a history it could not establish was the stricter reading", () => {
    const history = {
      afterFixRound: true,
      unreadable: "this pull request's commits could not be listed",
      unreviewedCommits: false,
    } as const;

    expect(describeHistory(history)).toContain("could not be listed");
    expect(unreadableHistoryNote(history)).toContain("could not be listed");
  });

  it("adds nothing to the summary of a history it did establish", () => {
    expect(unreadableHistoryNote({ afterFixRound: true, unreviewedCommits: true })).toBeUndefined();
    expect(unreadableHistoryNote({ afterFixRound: false, unreviewedCommits: true })).toBeUndefined();
  });
});
