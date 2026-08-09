import { describe, expect, it } from "vitest";
import {
  filterInlineComments,
  reviewOutputSchema,
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
  return (result as { value: { inlineComments: InlineComment[] } }).value;
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
