import { describe, expect, it } from "vitest";
import {
  filterOutcomes,
  filterTopLevelComments,
  fixOutputSchema,
  isAgentTopLevelComment,
  TOP_LEVEL_COMMENT_MARKER,
  unmarkedBody,
  type FixOutput,
  type ThreadOutcome,
} from "../shared/fix-output.js";

/**
 * These guard a mutation, not a rule. An outcome naming the wrong thread does
 * not merely produce a bad message — `resolveReviewThread` would close feedback
 * nobody addressed, which is silent and hard to notice.
 */

const parse = (value: unknown): FixOutput => {
  const result = fixOutputSchema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error(result.issues.map((i) => i.message).join("; "));
  }
  return (result as { value: FixOutput }).value;
};

const outcome = (over: Partial<ThreadOutcome> = {}): ThreadOutcome => ({
  threadId: "PRRT_a",
  status: "addressed",
  reply: "done",
  ...over,
});

describe("fixOutputSchema", () => {
  it("accepts addressed and declined", () => {
    const out = parse({
      threadOutcomes: [
        { threadId: "PRRT_a", status: "addressed", reply: "fixed" },
        { threadId: "PRRT_b", status: "declined", reply: "not a real problem because…" },
      ],
    });
    expect(out.threadOutcomes.map((o) => o.status)).toEqual(["addressed", "declined"]);
  });

  it("rejects a status outside the two allowed values", () => {
    expect(() =>
      parse({ threadOutcomes: [{ threadId: "PRRT_a", status: "resolved", reply: "x" }] }),
    ).toThrow(/must be "addressed" or "declined"/);
  });

  it("accepts snake_case thread_id, since the model emits both", () => {
    const out = parse({
      threadOutcomes: [{ thread_id: "PRRT_a", status: "addressed", reply: "x" }],
    });
    expect(out.threadOutcomes[0]?.threadId).toBe("PRRT_a");
  });

  it("defaults to an empty list rather than failing", () => {
    expect(parse({}).threadOutcomes).toEqual([]);
  });
});

/**
 * Top-level comments are the channel for a finding that belongs to no thread.
 * The failure mode this guards is the opposite of the thread one: not a bad
 * target, but a channel that fires on every run. A bot that comments "here is
 * what I did" each time trains a reader to skim, so silence has to be what an
 * absent — or explicitly empty — field means.
 */
describe("fixOutputSchema topLevelComments", () => {
  it("posts nothing when the agent reports no comments", () => {
    expect(parse({ threadOutcomes: [] }).topLevelComments).toEqual([]);
  });

  it("posts nothing when the field is absent entirely", () => {
    expect(parse({}).topLevelComments).toEqual([]);
  });

  it("keeps the bodies it was given, in order", () => {
    const out = parse({
      topLevelComments: [{ body: "`pr-feedback.ts:206` still interpolates." }, { body: "second" }],
    });
    expect(out.topLevelComments.map((c) => c.body)).toEqual([
      "`pr-feedback.ts:206` still interpolates.",
      "second",
    ]);
  });

  it("accepts a bare string, since the model emits both shapes", () => {
    expect(parse({ topLevelComments: ["out of scope: X"] }).topLevelComments[0]?.body).toBe(
      "out of scope: X",
    );
  });

  /**
   * The rest of this block guards one thing: a malformed *optional* comment must
   * never sink the mandatory payload. A throw here becomes a validation issue,
   * burns both extraction retries, and takes every thread reply and resolve with
   * it — giving the side channel veto power over what the run exists to produce.
   */
  it("drops an empty body instead of failing the extraction", () => {
    const out = parse({
      threadOutcomes: [{ threadId: "PRRT_a", status: "addressed", reply: "fixed" }],
      topLevelComments: [{ body: "   " }],
    });
    expect(out.topLevelComments).toEqual([]);
    expect(out.threadOutcomes).toHaveLength(1);
  });

  it("keeps the well-formed entries either side of a malformed one", () => {
    const out = parse({ topLevelComments: ["first", { nope: 1 }, { body: "second" }] });
    expect(out.topLevelComments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("drops a non-array field rather than failing the extraction", () => {
    const out = parse({
      threadOutcomes: [{ threadId: "PRRT_a", status: "addressed", reply: "fixed" }],
      topLevelComments: "a bare string where a list belongs",
    });
    expect(out.topLevelComments).toEqual([]);
    expect(out.threadOutcomes).toHaveLength(1);
  });

  it("still fails on a malformed thread outcome — that one is the payload", () => {
    expect(() => parse({ threadOutcomes: [{ threadId: "PRRT_a", status: "nope", reply: "x" }] })).toThrow();
  });
});

/**
 * The prompt says silence is the default; this is what makes that structural.
 * Unbounded, a PR taking three `agent:fix` rounds accumulates three copies of
 * the same out-of-scope note — and three issues once #79 harvests them.
 */
describe("filterTopLevelComments", () => {
  const comment = (body: string) => ({ body });

  it("stamps every kept comment with the marker", () => {
    const kept = filterTopLevelComments([comment("out of scope: X")]);
    expect(kept[0]?.body).toBe(`out of scope: X\n\n${TOP_LEVEL_COMMENT_MARKER}`);
    expect(isAgentTopLevelComment(kept[0]?.body)).toBe(true);
  });

  it("caps a run at two, keeping the first two", () => {
    const kept = filterTopLevelComments([comment("a"), comment("b"), comment("c")]);
    expect(kept.map((c) => unmarkedBody(c.body))).toEqual(["a", "b"]);
  });

  it("drops a comment an earlier run already posted", () => {
    const kept = filterTopLevelComments(
      [comment("already said"), comment("new")],
      [`already said\n\n${TOP_LEVEL_COMMENT_MARKER}`],
    );
    expect(kept.map((c) => unmarkedBody(c.body))).toEqual(["new"]);
  });

  it("collapses a comment repeated within one run", () => {
    const kept = filterTopLevelComments([comment("same"), comment("same")]);
    expect(kept).toHaveLength(1);
  });

  it("does not let a dropped duplicate free up a slot under the cap", () => {
    const kept = filterTopLevelComments([comment("a"), comment("a"), comment("b"), comment("c")]);
    expect(kept.map((c) => unmarkedBody(c.body))).toEqual(["a", "b"]);
  });

  it("posts nothing when there is nothing to post", () => {
    expect(filterTopLevelComments([])).toEqual([]);
  });
});

/**
 * The marker is what stops the next `agent:fix` run reading this run's own
 * out-of-scope note back as feedback to act on — `github-actions` is a trusted
 * author on purpose, so nothing else on the `comments` surface distinguishes it.
 */
describe("top-level comment marker", () => {
  it("recognises a body it stamped", () => {
    expect(isAgentTopLevelComment(`note\n\n${TOP_LEVEL_COMMENT_MARKER}`)).toBe(true);
  });

  it("leaves a human comment alone", () => {
    expect(isAgentTopLevelComment("please also rename this")).toBe(false);
  });

  it("treats an absent body as not ours rather than throwing", () => {
    expect(isAgentTopLevelComment(null)).toBe(false);
    expect(isAgentTopLevelComment(undefined)).toBe(false);
  });

  it("round-trips a stamped body back to what the agent wrote", () => {
    expect(unmarkedBody(`note\n\n${TOP_LEVEL_COMMENT_MARKER}`)).toBe("note");
  });
});

describe("filterOutcomes", () => {
  it("keeps outcomes for threads that were shown", () => {
    expect(filterOutcomes([outcome()], ["PRRT_a"])).toHaveLength(1);
  });

  it("drops an invented thread id rather than resolving something unrelated", () => {
    expect(filterOutcomes([outcome({ threadId: "PRRT_made_up" })], ["PRRT_a"])).toEqual([]);
  });

  it("collapses duplicates so a thread is never replied to twice", () => {
    const kept = filterOutcomes(
      [outcome({ reply: "first" }), outcome({ reply: "second" })],
      ["PRRT_a"],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.reply).toBe("first");
  });

  it("drops everything when no threads were shown", () => {
    expect(filterOutcomes([outcome()], [])).toEqual([]);
  });
});
