import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fixHeader,
  fixScope,
  reviewHeader,
  roundCounts,
  roundHeader,
  withHeader,
  withoutHeader,
  type RoundRecord,
  type RoundReview,
} from "../shared/round-header.js";
import { sliceRanges, type BranchCommit } from "../shared/slice-ranges.js";
import { loopAccounts } from "../shared/loop-accounts.js";

/** The loop's accounts with `AGENT_LOOP_LOGINS` unset: the default alone. */
const ACCOUNTS = loopAccounts("");

/**
 * The header on every top-level review and fix comment (#298), and the numbers
 * in it, counted per slice off the pull request's reviews and its `agent:fix`
 * label events.
 */

const SUBS = [
  { number: 231, state: "OPEN" as const },
  { number: 232, state: "OPEN" as const },
  { number: 233, state: "OPEN" as const },
];

/** Slice 1 is `a1`..`a2`, slice 2 is `b1`..`b2` (`b2` a fix commit), newest first. */
const LOG: BranchCommit[] = [
  { sha: "b2", parents: ["b1"], slice: null },
  { sha: "b1", parents: ["a2"], slice: 232 },
  { sha: "a2", parents: ["a1"], slice: null },
  { sha: "a1", parents: ["base"], slice: 231 },
];
const RANGES = sliceRanges(LOG, SUBS);

const at = (minute: number): string => `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`;

const review = (commit: string, minute: number, header = "", author = "github-actions[bot]"): RoundReview => ({
  author,
  body: `${header === "" ? "" : `${header}\n\n`}## Agent review\n\n### Changes recommended`,
  commit,
  submittedAt: at(minute),
  url: `https://github.com/acme/widgets/pull/9#pullrequestreview-${minute}`,
});

describe("the header", () => {
  it("names the slice, its place, the step and the number on a slice round", () => {
    const slice = { kind: "slice", k: 2, n: 5, subIssue: 232 } as const;

    expect(roundHeader(slice, "review", 3)).toBe("**Slice 2 of 5 · #232 · review 3**");
    expect(roundHeader(slice, "fix", 2)).toBe("**Slice 2 of 5 · #232 · fix 2**");
  });

  it("names the final review on the final review, and only the step on a regular pull request", () => {
    expect(roundHeader({ kind: "final" }, "review", 2)).toBe("**Final review · review 2**");
    expect(roundHeader({ kind: "final" }, "fix", 1)).toBe("**Final review · fix 1**");
    expect(roundHeader({ kind: "regular" }, "review", 4)).toBe("**Review 4**");
    expect(roundHeader({ kind: "regular" }, "fix", 1)).toBe("**Fix 1**");
  });

  it("opens a body on a line of its own, and comes off again for a comparison", () => {
    const body = withHeader("**Fix 2**", "Declined the rename.");

    expect(body).toBe("**Fix 2**\n\nDeclined the rename.");
    expect(withoutHeader(body)).toBe("Declined the rename.");
    expect(withoutHeader("**Slice 1 of 2 · #231 · fix 1**\r\n\r\nText")).toBe("Text");
    expect(withoutHeader("**Not a header**\n\nText")).toBe("**Not a header**\n\nText");
  });
});

describe("numbering across rounds", () => {
  it("counts every review of a slice, and restarts for the next", () => {
    const record: RoundRecord = {
      reviews: [review("a1", 1), review("a2", 3), review("a2", 5), review("b1", 10)],
      fixes: [at(2), at(4)],
    };
    const counts = roundCounts(record, ACCOUNTS, RANGES);

    expect(counts.slices[231]).toEqual({ reviews: 3, latestReview: record.reviews[2]?.url, fixes: 2 });
    expect(counts.slices[232]).toEqual({ reviews: 1, latestReview: record.reviews[3]?.url, fixes: 0 });
    expect(reviewHeader({ kind: "slice", k: 2, n: 3, subIssue: 232 }, counts)).toBe("**Slice 2 of 3 · #232 · review 2**");
  });

  it("counts a hand-requested review, and a fix round added by hand after the budget is spent", () => {
    // Budget 2: two automatic rounds after reviews 1 and 2, review 3 parks,
    // a maintainer adds `agent:fix` (round 3) and then `agent:review` (review 4).
    const record: RoundRecord = {
      reviews: [review("b1", 10), review("b2", 12), review("b2", 14), review("b2", 18)],
      fixes: [at(11), at(13), at(16)],
    };
    const counts = roundCounts(record, ACCOUNTS, RANGES);
    const slice2 = { kind: "slice", k: 2, n: 3, subIssue: 232 } as const;

    expect(counts.slices[232]?.fixes).toBe(3);
    expect(reviewHeader(slice2, counts)).toBe("**Slice 2 of 3 · #232 · review 5**");
    expect(fixHeader(fixScope(record, ACCOUNTS, RANGES), counts)).toBe("**Slice 2 of 3 · #232 · fix 3**");
  });

  it("numbers the final review apart from every slice, by its header", () => {
    const record: RoundRecord = {
      reviews: [
        review("a1", 1),
        review("b1", 10),
        review("b2", 20, "**Final review · review 1**"),
        review("b2", 30, "**Final review · review 2**"),
      ],
      fixes: [at(5), at(25)],
    };
    const counts = roundCounts(record, ACCOUNTS, RANGES);

    expect(counts.slices[232]).toEqual({ reviews: 1, latestReview: record.reviews[1]?.url, fixes: 0 });
    expect(counts.final).toEqual({ reviews: 2, latestReview: record.reviews[3]?.url, fixes: 1 });
    expect(reviewHeader({ kind: "final" }, counts)).toBe("**Final review · review 3**");
    expect(fixScope(record, ACCOUNTS, RANGES)).toEqual({ kind: "final" });
    expect(fixHeader({ kind: "final" }, counts)).toBe("**Final review · fix 1**");
  });

  it("counts only the reviews this loop posted", () => {
    const record: RoundRecord = {
      reviews: [review("a1", 1), review("a1", 2, "", "a-human"), { ...review("a1", 3), body: "LGTM" }],
      fixes: [],
    };

    expect(roundCounts(record, ACCOUNTS, RANGES).slices[231]?.reviews).toBe(1);
  });

  /** An orchestrator posting as its own App (#376): its reviews are rounds once its account is passed in. */
  it("counts a review an account the orchestrator passes in posted, in either spelling", () => {
    const record: RoundRecord = {
      reviews: [review("x", 1), review("y", 3, "", "my-loop[bot]"), review("z", 5, "", "my-loop")],
      fixes: [],
    };

    expect(reviewHeader({ kind: "regular" }, roundCounts(record, loopAccounts("my-loop[bot]")))).toBe("**Review 4**");
    expect(reviewHeader({ kind: "regular" }, roundCounts(record, ACCOUNTS))).toBe("**Review 2**");
  });

  it("counts the whole pull request off a PRD PR", () => {
    const record: RoundRecord = { reviews: [review("x", 1), review("y", 3)], fixes: [at(2), at(4)] };
    const counts = roundCounts(record, ACCOUNTS);

    expect(reviewHeader({ kind: "regular" }, counts)).toBe("**Review 3**");
    expect(fixScope(record, ACCOUNTS)).toEqual({ kind: "regular" });
    expect(fixHeader({ kind: "regular" }, counts)).toBe("**Fix 2**");
  });

  /** A PRD branch that could not be read leaves the headers to say which round a review was. */
  it("places a review by its header, where the branch could not be read", () => {
    const record: RoundRecord = {
      reviews: [
        review("a1", 1, "**Slice 1 of 3 · #231 · review 1**"),
        review("zz", 3, "**Slice 2 of 3 · #232 · review 1**"),
        review("zz", 5, "**Slice 2 of 3 · #232 · review 2**"),
      ],
      fixes: [at(4), at(6)],
    };
    const counts = roundCounts(record, ACCOUNTS, undefined, true);

    expect(counts.slices[231]?.reviews).toBe(1);
    expect(counts.slices[232]).toEqual({ reviews: 2, latestReview: record.reviews[2]?.url, fixes: 2 });
    expect(fixScope(record, ACCOUNTS, undefined, true)).toEqual({ kind: "slice", k: 2, n: 3, subIssue: 232 });
    expect(fixHeader(fixScope(record, ACCOUNTS, undefined, true), counts)).toBe("**Slice 2 of 3 · #232 · fix 2**");
  });

  it("calls a fix run the first where its own label is not on the record", () => {
    expect(fixHeader({ kind: "regular" }, roundCounts({ reviews: [], fixes: [] }, ACCOUNTS))).toBe("**Fix 1**");
  });

  it("puts a fix run in the current slice where no review of it can be told", () => {
    expect(fixScope({ reviews: [], fixes: [] }, ACCOUNTS, RANGES)).toEqual({ kind: "slice", k: 2, n: 3, subIssue: 232 });
  });
});

/**
 * GitHub renders `#N` with its title, so the agents that write posted text
 * are told not to restate one (#298). Prompts name no domain, so the line is
 * the same in both.
 */
describe("the prompts that write posted text", () => {
  it.each(["review/prompt.md", "fix/prompt.md"])("%s asks for references by number alone", (file) => {
    expect(fs.readFileSync(file, "utf8")).toContain(
      "Refer to issues and pull requests by `#N` alone, without restating their titles: GitHub shows the\ntitle beside the reference already.",
    );
  });
});
