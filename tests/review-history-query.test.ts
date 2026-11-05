import { describe, expect, it } from "vitest";
import { REVIEW_HISTORY } from "../engine/read.js";
import { REVIEWS_QUERY } from "../shared/follow-up-filing.js";

/**
 * The review history is read by two copies of one GraphQL query: the `gh`
 * reader's in `shared/follow-up-filing.ts` and the engine's in
 * `engine/read.ts` (#513). Until they are one, they must not drift: a field
 * one reads and the other does not would let the two ends of the loop disagree
 * about which review counts.
 */

/** Whitespace GraphQL ignores: runs collapsed, and none beside punctuation. */
const normalized = (query: string): string =>
  query
    .replace(/\s+/g, " ")
    .replace(/\s*([{}():,!$])\s*/g, "$1")
    .trim();

describe("the two copies of the review-history query", () => {
  it("are equal apart from whitespace", () => {
    expect(normalized(REVIEWS_QUERY)).toEqual(normalized(REVIEW_HISTORY));
  });

  it("are compared on what they ask for, not only their shape", () => {
    expect(normalized(REVIEW_HISTORY)).toContain("reviews(last:100){nodes{body url lastEditedAt submittedAt author{login}commit{oid}}}");
    expect(normalized(REVIEWS_QUERY.replace("lastEditedAt ", ""))).not.toEqual(normalized(REVIEW_HISTORY));
  });
});
