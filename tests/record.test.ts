import { describe, expect, it } from "vitest";
import { planFollowUps } from "../shared/follow-up-plan.js";
import { loopAccounts } from "../shared/loop-accounts.js";
import { stubMarker } from "../shared/record.js";
import { renderFollowUpsBlock } from "../shared/review-output.js";

/**
 * The stub's dedupe marker (#510): the one string a retry, and every run after
 * it, matches a filed stub by. Every stub filed so far carries these bytes, so
 * a changed byte makes each of them unmatchable and the next merge files
 * duplicates of them. Pinned for a fixed input, including a location that
 * needs embedding, against the bytes the planner wrote before the marker moved
 * into `shared/record.ts`.
 */
const PINNED = [
  { location: "src/a.ts:12", pr: 32, seq: 0, bytes: `<!--{"version":2,"location":"src/a.ts:12","pr":32,"seq":0}-->` },
  {
    location: "src/<a>.ts --> x",
    pr: 7,
    seq: 3,
    bytes: `<!--{"version":2,"location":"src/\\u003ca\\u003e.ts --\\u003e x","pr":7,"seq":3}-->`,
  },
] as const;

describe("the stub's dedupe marker", () => {
  it.each(PINNED)("ends a planned stub's body in exactly its bytes for $location", ({ location, pr, seq, bytes }) => {
    const followUps = Array.from({ length: seq + 1 }, (_, i) => ({
      title: `Finding ${i}`,
      location: i === seq ? location : `src/other-${i}.ts`,
      body: "Evidence.",
      severity: "low" as const,
    }));
    const plan = planFollowUps(
      {
        prNumber: pr,
        reviews: [{ author: "github-actions", body: renderFollowUpsBlock(followUps, 0, 0, 10), lastEditedAt: null, url: "https://github.com/o/r/pull/1" }],
        stubs: [],
      },
      loopAccounts(""),
    );

    expect(plan.issues[seq]?.body.split("\n").at(-1)).toBe(bytes);
  });

  it.each(PINNED)("is spelled in the record in exactly its bytes for $location", ({ location, pr, seq, bytes }) => {
    expect(stubMarker(location, pr, seq)).toBe(bytes);
  });
});
