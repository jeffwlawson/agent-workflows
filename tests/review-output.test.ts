import { describe, expect, it } from "vitest";
import {
  capFollowUps,
  filterInlineComments,
  FOLLOW_UPS_MARKER,
  MAX_FOLLOW_UPS,
  renderFollowUpsBlock,
  reviewOutputSchema,
  type FollowUp,
  type InlineComment,
} from "../shared/review-output.js";

/**
 * These guard the review's posting path rather than the linter. GitHub rejects
 * an *entire* review if any one comment anchors outside the diff, so a bug here
 * does not degrade a review — it silently posts nothing.
 */

const parse = (value: unknown) => {
  const result = reviewOutputSchema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error(result.issues.map((i) => i.message).join("; "));
  }
  return (result as { value: { inlineComments: InlineComment[]; followUps: FollowUp[] } }).value;
};

const comment = (over: Partial<InlineComment> = {}): InlineComment => ({
  path: "src/a.ts",
  line: 10,
  body: "x",
  ...over,
});

describe("reviewOutputSchema", () => {
  it("accepts a multi-line range and keeps startLine", () => {
    const out = parse({
      summary: "s",
      inlineComments: [{ path: "src/a.ts", startLine: 8, line: 10, body: "b" }],
    });
    expect(out.inlineComments[0]).toMatchObject({ startLine: 8, line: 10 });
  });

  it("accepts snake_case start_line, since the model emits both", () => {
    const out = parse({
      summary: "s",
      inlineComments: [{ path: "src/a.ts", start_line: 8, line: 10, body: "b" }],
    });
    expect(out.inlineComments[0]?.startLine).toBe(8);
  });

  it("drops startLine when it equals line — GitHub rejects a zero-width range", () => {
    const out = parse({
      summary: "s",
      inlineComments: [{ path: "src/a.ts", startLine: 10, line: 10, body: "b" }],
    });
    expect(out.inlineComments[0]?.startLine).toBeUndefined();
  });

  it("rejects an inverted range rather than posting a 422", () => {
    expect(() =>
      parse({ summary: "s", inlineComments: [{ path: "src/a.ts", startLine: 11, line: 10, body: "b" }] }),
    ).toThrow(/startLine must be <= line/);
  });

  it("omits startLine entirely for a single-line comment", () => {
    const out = parse({ summary: "s", inlineComments: [{ path: "src/a.ts", line: 10, body: "b" }] });
    expect("startLine" in (out.inlineComments[0] ?? {})).toBe(false);
  });
});

describe("filterInlineComments", () => {
  const diff = new Map([["src/a.ts", new Set([8, 9, 10])]]);

  it("keeps a range whose every line is in the diff", () => {
    expect(filterInlineComments([comment({ startLine: 8, line: 10 })], diff)).toHaveLength(1);
  });

  it("drops a range with a gap in the middle", () => {
    const gappy = new Map([["src/a.ts", new Set([8, 10])]]);
    expect(filterInlineComments([comment({ startLine: 8, line: 10 })], gappy)).toEqual([]);
  });

  it("drops a range that starts outside the diff even though its last line is inside", () => {
    expect(filterInlineComments([comment({ startLine: 6, line: 10 })], diff)).toEqual([]);
  });

  it("still drops a single-line comment outside the diff", () => {
    expect(filterInlineComments([comment({ line: 99 })], diff)).toEqual([]);
  });

  it("drops comments on a file absent from the diff", () => {
    expect(filterInlineComments([comment({ path: "src/other.ts" })], diff)).toEqual([]);
  });
});

/**
 * The third output channel (#47). It is not a posting hazard like the two
 * above — an over-long list cannot 422 a review — but it is the only record of
 * a finding this PR will not fix, and it survives the merge by being written
 * into the review body. So the properties worth holding are: the schema never
 * loses a review over it, the cap is applied where it can be counted, and what
 * the renderer writes a reader can parse back.
 */

const followUp = (over: Partial<FollowUp> = {}): FollowUp => ({
  title: "t",
  location: "src/a.ts",
  body: "b",
  ...over,
});

const followUps = (n: number): FollowUp[] =>
  Array.from({ length: n }, (_, i) => followUp({ title: `t${i}`, location: `src/${i}.ts` }));

/**
 * What a reader of the block does, written out here rather than imported: the
 * half that parses is a different workflow and does not exist yet, and a
 * round-trip test that shares a helper with the renderer is a test of the
 * helper. The regex is the whole contract — a marker, a space, one line of
 * JSON — so pinning it here is pinning what the reader may assume.
 */
const payloadOf = (block: string): { version: number; dropped: number; followUps: FollowUp[] } => {
  const match = new RegExp(`<!-- ${FOLLOW_UPS_MARKER} (.*) -->`).exec(block);
  if (!match?.[1]) throw new Error("no payload comment in the block");
  return JSON.parse(match[1]) as { version: number; dropped: number; followUps: FollowUp[] };
};

describe("reviewOutputSchema: follow-ups", () => {
  it("defaults followUps to empty when the model emits none", () => {
    expect(parse({ summary: "s" }).followUps).toEqual([]);
  });

  it("keeps a follow-up's three fields", () => {
    const out = parse({
      summary: "s",
      followUps: [{ title: "Leak in parse()", location: "src/a.ts:12", body: "evidence" }],
    });

    expect(out.followUps).toEqual([
      { title: "Leak in parse()", location: "src/a.ts:12", body: "evidence" },
    ]);
  });

  it("accepts snake_case follow_ups, since the model emits both", () => {
    expect(parse({ summary: "s", follow_ups: [followUp()] }).followUps).toHaveLength(1);
  });

  /**
   * The cap is a *runner* concern and must never be a schema one. Extraction
   * throwing here fails the whole output — summary and inline comments with it
   * — so a model that emitted a fourth follow-up would cost the entire review.
   */
  it("does not throw on more than the cap", () => {
    expect(parse({ summary: "s", followUps: followUps(5) }).followUps).toHaveLength(5);
  });
});

describe("capFollowUps", () => {
  it("keeps the first three and reports what it dropped", () => {
    const { kept, dropped } = capFollowUps(followUps(5));

    expect(kept.map((f) => f.title)).toEqual(["t0", "t1", "t2"]);
    expect(dropped).toBe(2);
  });

  it("drops nothing under the cap", () => {
    expect(capFollowUps(followUps(2))).toEqual({ kept: followUps(2), dropped: 0 });
  });

  it("caps at three", () => {
    expect(MAX_FOLLOW_UPS).toBe(3);
  });
});

describe("renderFollowUpsBlock", () => {
  it("is collapsed, and its summary line names the gesture that opts out", () => {
    const block = renderFollowUpsBlock(followUps(1), 0);

    expect(block).toContain("<details>");
    expect(block).toContain("</details>");
    expect(block).not.toContain("<details open");
    // The opt-out is *removing* a label, and an author who has never seen one
    // of these before learns the mechanism from this line or not at all.
    expect(block).toMatch(/remove[\s\S]*agent:follow-ups/);
  });

  /**
   * Titles and locations, never bodies. The body is in the payload, which is
   * what gets filed; duplicating it into the visible half spends a body with a
   * 65,536-character ceiling to answer a question — *do I want these filed* —
   * that the titles already answer.
   */
  it("renders titles and locations only", () => {
    const block = renderFollowUpsBlock([followUp({ title: "Leak", location: "src/a.ts:12", body: "PROSE" })], 0);
    const visible = block.split(`<!-- ${FOLLOW_UPS_MARKER}`)[0] ?? "";

    expect(visible).toContain("Leak");
    expect(visible).toContain("src/a.ts:12");
    expect(visible).not.toContain("PROSE");
  });

  /**
   * The pre-merge half of announcing truncation. It reaches the author while
   * the PR is still open, which is the only point at which raising the dropped
   * finding is cheap.
   */
  it("states the truncation when the cap bit, and says nothing when it did not", () => {
    const visible = (block: string): string => block.split(`<!-- ${FOLLOW_UPS_MARKER}`)[0] ?? "";

    expect(visible(renderFollowUpsBlock(followUps(3), 2))).toMatch(/2 more were dropped/);
    expect(visible(renderFollowUpsBlock(followUps(3), 0))).not.toMatch(/dropped/i);
  });

  it("carries a versioned payload a reader can parse back", () => {
    const list = [followUp({ title: "Leak", location: "src/a.ts:12", body: "evidence, then why not here" })];

    const payload = payloadOf(renderFollowUpsBlock(list, 1));

    expect(payload).toEqual({ version: 1, dropped: 1, followUps: list });
  });

  /**
   * Model prose is arbitrary text, and `-->` in it would end the comment early
   * — truncating the JSON, which is the difference between a reader that files
   * three findings and one that files none. The escape is in the JSON, so the
   * parse gives the original string back.
   */
  it("survives a body that contains an HTML comment terminator", () => {
    const list = [followUp({ body: "the guard is <!-- gone --> entirely" })];

    expect(payloadOf(renderFollowUpsBlock(list, 0)).followUps).toEqual(list);
  });

  it("names the marker a reader selects on", () => {
    expect(FOLLOW_UPS_MARKER).toBe("agent-follow-ups");
  });
});
