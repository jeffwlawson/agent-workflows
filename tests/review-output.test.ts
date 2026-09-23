import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiffLines } from "../shared/diff-lines.js";
import {
  placeFindings,
  reviewThreads,
  type Finding,
  type PlacedFinding,
} from "../shared/review-findings.js";
import {
  capFollowUps,
  countFixBeforeMerge,
  deriveVerdict,
  fixBeforeMergeChecklist,
  FOLLOW_UPS_MARKER,
  hasFollowUpsBlock,
  MAX_FOLLOW_UPS,
  parseFollowUpsBlock,
  renderFollowUpsBlock,
  renderReviewSummary,
  reviewOutputSchema,
  VERDICT_CONTEXT,
  VERDICTS,
  type CiResult,
  type FollowUp,
  type ReviewOutput,
} from "../shared/review-output.js";

/**
 * These guard the review's posting path rather than the linter. GitHub rejects
 * an *entire* review if any one anchor falls outside the diff, so a bug here
 * does not degrade a review — it silently posts nothing. Where each finding is
 * anchored, and what happens to one that cannot be, is
 * `tests/review-findings.test.ts`.
 */

const parse = (value: unknown) => {
  const result = reviewOutputSchema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error(result.issues.map((i) => i.message).join("; "));
  }
  return (result as { value: ReviewOutput }).value;
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  title: "t",
  path: "src/a.ts",
  line: 10,
  body: "x",
  ...over,
});

describe("reviewOutputSchema", () => {
  it("accepts a multi-line range and keeps startLine", () => {
    const out = parse({
      summary: "s",
      findings: [{ path: "src/a.ts", startLine: 8, line: 10, body: "b" }],
    });
    expect(out.findings[0]).toMatchObject({ startLine: 8, line: 10 });
  });

  it("accepts snake_case start_line, since the model emits both", () => {
    const out = parse({
      summary: "s",
      findings: [{ path: "src/a.ts", start_line: 8, line: 10, body: "b" }],
    });
    expect(out.findings[0]?.startLine).toBe(8);
  });

  /**
   * And the field's own former name. `inlineComments` was what this list was
   * called until placement stopped being the model's to state (#110); a model
   * prompted for one shape still reaches for the other, and a review whose
   * findings silently defaulted to empty would post *approval recommended*.
   */
  it("accepts the field's former name, since the model reaches for it", () => {
    const out = parse({
      summary: "s",
      inlineComments: [{ path: "src/a.ts", line: 10, body: "b" }],
    });
    expect(out.findings).toHaveLength(1);
  });

  it("drops startLine when it equals line — GitHub rejects a zero-width range", () => {
    const out = parse({
      summary: "s",
      findings: [{ path: "src/a.ts", startLine: 10, line: 10, body: "b" }],
    });
    expect(out.findings[0]?.startLine).toBeUndefined();
  });

  it("rejects an inverted range rather than posting a 422", () => {
    expect(() =>
      parse({ summary: "s", findings: [{ path: "src/a.ts", startLine: 11, line: 10, body: "b" }] }),
    ).toThrow(/startLine must be <= line/);
  });

  it("omits startLine entirely for a single-line anchor", () => {
    const out = parse({ summary: "s", findings: [{ path: "src/a.ts", line: 10, body: "b" }] });
    expect("startLine" in (out.findings[0] ?? {})).toBe(false);
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
 * What a reader of the block does, written out here rather than imported.
 * `parseFollowUpsBlock` is the real one and is exercised below, but a
 * round-trip test that only ever reads through it cannot tell a format from a
 * pair of functions that happen to agree. The regex is the whole contract — a
 * marker, a space, one line of JSON — so pinning it here is pinning what any
 * reader may assume.
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

  /**
   * The retraction, and the shape of every review that found nothing out of
   * scope. It has to be *a block* — the reader takes the latest one, so a round
   * that recorded nothing can only supersede round 1 by leaving something — and
   * it has to be invisible, because there is no finding to show and no opt-out
   * to describe. An empty disclosure widget on every review is how a channel
   * teaches people to stop opening it.
   */
  it("writes the empty list as a bare payload, with nothing for a reader to see", () => {
    const block = renderFollowUpsBlock([], 0);

    expect(block).toBe(`<!-- ${FOLLOW_UPS_MARKER} {"version":1,"dropped":0,"followUps":[]} -->`);
    expect(block).not.toContain("<details>");
    expect(hasFollowUpsBlock(block)).toBe(true);
    expect(parseFollowUpsBlock(block)).toEqual({ followUps: [], dropped: 0 });
  });
});

/**
 * The other end of the same format (#48). It lives beside the renderer because
 * the two *are* one format: a parser written in the half that files would be a
 * second description of it, drifting from the first on the release that changes
 * either.
 *
 * Its two absences are different answers, which is the whole shape of it. No
 * block is the ordinary case and is answered with silence. A block that cannot
 * be read is a shape this version does not know, and it has to say so rather
 * than guess at fields that may have moved.
 */
describe("parseFollowUpsBlock", () => {
  it("reads back what the renderer wrote, findings and cap alike", () => {
    const list = [followUp({ title: "Leak", location: "src/a.ts:12", body: "evidence" })];

    expect(parseFollowUpsBlock(renderFollowUpsBlock(list, 2))).toEqual({
      followUps: list,
      dropped: 2,
    });
  });

  it("finds the block wherever it sits in a review body", () => {
    const body = `A summary, with prose above and below.\n\n${renderFollowUpsBlock(followUps(1), 0)}\n\nMore prose.`;

    expect(parseFollowUpsBlock(body)?.followUps).toHaveLength(1);
  });

  /**
   * The block is appended after the summary, and the summary is model prose
   * that may quote one. A body holding two therefore carries the real one last.
   */
  it("takes the last block when a body somehow carries two", () => {
    const body = [
      renderFollowUpsBlock([followUp({ location: "src/quoted.ts" })], 0),
      renderFollowUpsBlock([followUp({ location: "src/real.ts" })], 0),
    ].join("\n\n");

    expect(parseFollowUpsBlock(body)?.followUps.map((f) => f.location)).toEqual(["src/real.ts"]);
  });

  it("returns nothing at all for a body with no block", () => {
    expect(parseFollowUpsBlock("A summary and nothing else.")).toBe(undefined);
    expect(hasFollowUpsBlock("A summary and nothing else.")).toBe(false);
  });

  it("refuses a version it does not know, naming the one it found", () => {
    const body = `<!-- ${FOLLOW_UPS_MARKER} {"version":2,"dropped":0,"followUps":[]} -->`;

    expect(hasFollowUpsBlock(body)).toBe(true);
    expect(() => parseFollowUpsBlock(body)).toThrow(/2/);
  });

  it("refuses a payload it cannot parse", () => {
    expect(() => parseFollowUpsBlock(`<!-- ${FOLLOW_UPS_MARKER} {"version":1, -->`)).toThrow(
      /readable JSON/,
    );
  });

  it("refuses a finding missing one of its three fields", () => {
    const body = `<!-- ${FOLLOW_UPS_MARKER} {"version":1,"dropped":0,"followUps":[{"title":"t","body":"b"}]} -->`;

    expect(() => parseFollowUpsBlock(body)).toThrow(/location/);
  });
});

/**
 * The two finding types (#97). Every finding is *fix before merge* or a
 * follow-up, and the first of those has to be **countable from the structured
 * output** rather than read out of the summary: the verdict is derived from the
 * count, and a verdict derived from prose is the sentence nothing acts on that
 * this replaced.
 *
 * Not derived from the findings, which is the shape this could have taken: the
 * two lists are written independently, so either can be the one the model
 * forgot, and the count takes whichever is larger.
 */
describe("reviewOutputSchema: the two finding types", () => {
  it("defaults fixBeforeMerge to empty, which is the ordinary review", () => {
    expect(parse({ summary: "s" }).fixBeforeMerge).toEqual([]);
  });

  it("accepts snake_case fix_before_merge, since the model emits both", () => {
    const out = parse({ summary: "s", fix_before_merge: ["the guard runs after the return"] });

    expect(out.fixBeforeMerge).toEqual(["the guard runs after the return"]);
  });

  it("refuses a finding that is not a line of text", () => {
    expect(() => parse({ summary: "s", fixBeforeMerge: [{ title: "x" }] })).toThrow(
      /fix-before-merge finding/,
    );
  });

  it("keeps needsYou when the model named the case", () => {
    expect(parse({ summary: "s", needsYou: "the issue asked for the opposite" }).needsYou).toBe(
      "the issue asked for the opposite",
    );
  });

  it("accepts snake_case needs_you, since the model emits both", () => {
    expect(parse({ summary: "s", needs_you: "CI fails and the diff does not explain it" }).needsYou)
      .toBe("CI fails and the diff does not explain it");
  });

  /**
   * Absent is the answer on nearly every review, and a model asked for an
   * optional string says so in three ways. All three have to mean the same
   * thing: read as *present*, an empty string is a review that sends every
   * pull request to a human with no reason given.
   */
  it.each([
    ["omitted", {}],
    ["null", { needsYou: null }],
    ["empty", { needsYou: "" }],
    ["whitespace", { needsYou: "  " }],
  ])("reads %s needsYou as absent", (_case: string, over: Record<string, unknown>) => {
    expect(parse({ summary: "s", ...over }).needsYou).toBeUndefined();
  });
});

/**
 * The verdicts, derived rather than written (#96 decision 2), and named after
 * GitHub's own Copilot code review headings so that a reader who has met one of
 * those already knows what ours mean.
 *
 * The order of the arms is the whole of it: each one is reachable, and a
 * rearrangement that made an earlier arm swallow a later one would still pass a
 * test that only checked the outcomes it happens to produce.
 */
describe("deriveVerdict", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    summary: "s",
    findings: [],
    followUps: [],
    fixBeforeMerge: [],
    ...over,
  });

  it("recommends approval when nothing is wrong and the checks are green", () => {
    expect(deriveVerdict(output(), { ci: "green", round: 1 }).verdict).toBe("approval recommended");
  });

  it("recommends changes when the findings are the only thing wrong", () => {
    expect(
      deriveVerdict(output({ fixBeforeMerge: ["the guard runs after the return"] }), {
        ci: "green",
        round: 1,
      }).verdict,
    ).toBe("changes recommended");
  });

  it("needs a closer look when the agent says a fix round cannot settle it", () => {
    expect(
      deriveVerdict(output({ needsYou: "the issue asked for the opposite" }), {
        ci: "green",
        round: 1,
      }).verdict,
    ).toBe("needs a closer look");
  });

  /**
   * The arm with no finding behind it: the checks are red and the review found
   * nothing to fix, so nobody has said what a fix round would even change.
   * That is a human's problem by construction, and it is the case a derivation
   * keyed only on findings would recommend approving.
   */
  it.each([
    ["red", "red"],
    ["unreadable", "unknown"],
  ])("needs a closer look when the checks are %s and the review found nothing", (_case, ci) => {
    expect(deriveVerdict(output(), { ci: ci as CiResult, round: 1 }).verdict).toBe(
      "needs a closer look",
    );
  });

  /**
   * And red checks *with* findings stay a fix, because the findings are the
   * explanation: the fix round has something to aim at, and the re-review is
   * what re-reads the checks.
   */
  it("recommends changes when red checks come with findings that explain them", () => {
    expect(
      deriveVerdict(output({ fixBeforeMerge: ["the new test asserts the old behaviour"] }), {
        ci: "red",
        round: 1,
      }).verdict,
    ).toBe("changes recommended");
  });

  /**
   * The list is a restatement of findings the inline comments already carry, so
   * either of the two can be the one the model forgot — and only one of the two
   * mistakes has a consequence. A finding labelled **Fix before merge.** in a
   * comment but left off the list derives *approval recommended*, which puts the
   * unsafe answer on the one signal meant to be acted on without reading
   * (#105). Counted as the larger of the two, so a review that did as it was
   * asked is not double-counted.
   */
  it("counts a labelled inline comment the list left out", () => {
    const labelled = output({
      findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })],
    });

    expect(deriveVerdict(labelled, { ci: "green", round: 1 }).verdict).toBe("changes recommended");
    expect(deriveVerdict(labelled, { ci: "green", round: 2 }).verdict).toBe(
      "changes recommended after a fix round",
    );
  });

  /**
   * Counted over the comments **as produced**. `filterInlineComments` drops an
   * anchor that is not in the diff, and a finding whose line the model invented
   * is still a finding — dropping it from the count as well as from the review
   * is how a review that found something ends up saying nothing is wrong.
   * Nothing here filters, which is what makes that true: the derivation is
   * handed the model's own output.
   */
  it("reads the label past whatever emphasis it was written in", () => {
    for (const body of ["Fix before merge. x", "__Fix before merge__ x", "  **fix before merge:** x"]) {
      expect(
        deriveVerdict(output({ findings: [finding({ body })] }), { ci: "green", round: 1 })
          .verdict,
        body,
      ).toBe("changes recommended");
    }
  });

  /** And an ordinary comment is not a finding: the label is a fixed token, read as one. */
  it("does not count a comment that merely mentions fixing something", () => {
    const chatty = output({
      findings: [finding({ body: "Worth a look before merge — fix before merge is the label." })],
    });

    expect(deriveVerdict(chatty, { ci: "green", round: 1 }).verdict).toBe("approval recommended");
  });

  it("counts one finding once when it is recorded in both places", () => {
    const both = output({
      fixBeforeMerge: ["the guard runs after the return"],
      findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })],
    });

    // The larger of the two, not the sum — and either way a fix is a fix, so
    // what this pins is the arithmetic rather than the verdict.
    expect(deriveVerdict(both, { ci: "green", round: 1 }).verdict).toBe("changes recommended");
    expect(countFixBeforeMerge(both)).toBe(1);
  });

  it("prefers a closer look over a fix-before-merge finding", () => {
    expect(
      deriveVerdict(output({ fixBeforeMerge: ["a"], needsYou: "the wrong thing was built" }), {
        ci: "green",
        round: 1,
      }).verdict,
    ).toBe("needs a closer look");
  });

  /**
   * **A round-2 review can never produce the round-1 row** (#96, decision 5),
   * and this is where that is enforced rather than in the prompt. The bound it
   * holds is the loop's only one: `agent:fix` now asks for its own re-review,
   * so a second round that could promise another automatic one would be a cycle
   * with no human in it. A prompt line would leave that to a model's judgement
   * about its own output.
   *
   * The two rows share a heading, so what is pinned here is the *line* and the
   * key — which is the whole of the difference a reader and PRD #101's
   * automatic fix each act on.
   */
  it("gives a second round's findings the round-2 line, never the round-1 one", () => {
    const second = deriveVerdict(output({ fixBeforeMerge: ["the guard still runs after the return"] }), {
      ci: "green",
      round: 2,
    });

    expect(second.verdict).toBe("changes recommended after a fix round");
    expect(second.heading).toBe(VERDICTS["changes recommended"].heading);
    expect(second.nextStep).toBe(
      "A fix round did not settle these. Read the review, then reply with your decision and add agent:fix.",
    );
    // Never the round-1 step, which promises an automatic re-review the loop
    // will not start: this round is the one that was supposed to settle it.
    expect(second.nextStep).not.toBe(VERDICTS["changes recommended"].nextStep);
    expect(second.description).not.toContain("automatically");
  });

  /**
   * And it is the *findings* that change the line, not the round. A fix round
   * that worked is a pull request that is ready, which is the outcome the whole
   * round exists to reach.
   */
  it("still recommends approval in a second round that found nothing", () => {
    expect(deriveVerdict(output(), { ci: "green", round: 2 }).verdict).toBe("approval recommended");
  });
});

/**
 * The commit status each verdict posts. The descriptions are quoted from #96's
 * table rather than read back out of the constant — an expectation derived from
 * the thing it tests moves when that thing is wrong, and this one is the whole
 * of what a maintainer sees: the promise of the feature is that the status line
 * is enough, so a reworded one is a different feature.
 */
describe("the verdict's commit status", () => {
  it("posts under a context of its own", () => {
    expect(VERDICT_CONTEXT).toBe("agent-review");
  });

  it.each([
    [
      "approval recommended",
      "🟢 Approval recommended",
      "success",
      "🟢 Approval recommended. Ready to merge. Nothing left to fix; any follow-ups are filed as issues when you merge.",
    ],
    [
      "changes recommended",
      "🟡 Changes recommended",
      "failure",
      "🟡 Changes recommended. Add agent:fix. The fixes are clear, so no need to read them first. A re-review runs automatically.",
    ],
    [
      "changes recommended after a fix round",
      "🟡 Changes recommended",
      "failure",
      "🟡 Changes recommended. A fix round did not settle these. Read the review, then reply with your decision and add agent:fix.",
    ],
    [
      "needs a closer look",
      "🔵 Needs a closer look",
      "failure",
      "🔵 Needs a closer look. A fix round cannot settle this. Read the review, then reply with your decision or close the PR.",
    ],
  ] as const)(
    "states %s under its heading, with the state that shows it",
    (verdict, heading, state, description) => {
      expect(VERDICTS[verdict].heading).toBe(heading);
      expect(VERDICTS[verdict].state).toBe(state);
      expect(VERDICTS[verdict].description).toBe(description);
      expect(VERDICTS[verdict].verdict).toBe(verdict);
    },
  );

  /**
   * Three headings over four rows, and the two that share one are the round-1
   * and round-2 *changes recommended* cases. The heading is the assessment and
   * the step is what differs, so a reader meets three answers and a machine
   * meets four.
   */
  it("offers the three headings Copilot code review uses, and no fourth", () => {
    expect(new Set(Object.values(VERDICTS).map((row) => row.heading))).toEqual(
      new Set(["🟢 Approval recommended", "🟡 Changes recommended", "🔵 Needs a closer look"]),
    );
  });

  /**
   * The status line is the heading and the step, and the body is the heading
   * over the step — two renderings of one row. Written out rather than composed
   * so the table reads as what a maintainer sees, which leaves exactly one way
   * for them to drift, and this is it.
   */
  it("says the same thing on the status as the body says in two parts", () => {
    for (const row of Object.values(VERDICTS)) {
      expect(row.description, row.verdict).toBe(`${row.heading}. ${row.nextStep}`);
    }
  });

  /**
   * GitHub truncates a status description past 140 characters, and truncates it
   * where the character ran out rather than where the sentence ends. The line
   * is the feature, so a line that arrives half-written is the feature broken
   * in the one place nothing else reports.
   */
  it("keeps every next step inside GitHub's 140-character limit", () => {
    for (const row of Object.values(VERDICTS)) {
      expect(row.description.length, row.verdict).toBeLessThanOrEqual(140);
    }
  });
});

/**
 * The body a maintainer actually reads, which is where two of the review's own
 * outputs used to stop existing (#105).
 *
 * `needsYou` fed the derivation and was then dropped, so the case the agent
 * named — *the wrong thing was built*, *the issue itself was wrong* — reached
 * nobody, while the status line it produced is a fixed sentence that cannot
 * carry it. And `fixBeforeMerge` was posted nowhere at all: the fix run
 * resolves every thread it addressed and resolved threads are dropped from the
 * feedback the next review is handed, so round 2 was verifying the last round's
 * findings against summary prose.
 */
describe("the posted review body", () => {
  const SUMMARY = "The change does what the issue asked.";
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    summary: SUMMARY,
    findings: [],
    followUps: [],
    fixBeforeMerge: [],
    ...over,
  });
  const parts = { verdict: VERDICTS["changes recommended"], output: output(), placed: [] };

  /**
   * The heading as a heading, so the assessment is what a reader's eye lands on
   * — and the step under it **without the heading repeated**, which is what
   * makes this a rendering of the row rather than the status line pasted in.
   */
  it("opens with the verdict as a heading over its next step", () => {
    const body = renderReviewSummary(parts);

    expect(body.startsWith("### 🟡 Changes recommended\n\n")).toBe(true);
    expect(body).toContain(parts.verdict.nextStep);
    expect(body).not.toContain(parts.verdict.description);
    expect(body.endsWith(SUMMARY)).toBe(true);
  });

  it("names the case when the agent said a fix round cannot settle it", () => {
    const body = renderReviewSummary({
      ...parts,
      output: output({ needsYou: "the issue asked for the opposite" }),
    });

    expect(body).toContain("the issue asked for the opposite");
    // Above the summary, because it is why the reader is being asked to read
    // one: a reason found underneath the evidence is a reason they reach after
    // deciding they had to.
    expect(body.indexOf("the issue asked for the opposite")).toBeLessThan(body.indexOf(SUMMARY));
  });

  it("renders each finding as a checklist entry, open rather than collapsed", () => {
    const body = renderReviewSummary({
      ...parts,
      output: output({
        fixBeforeMerge: [
          "the guard runs after the return",
          "the new test asserts the old behaviour",
        ],
      }),
    });

    expect(body).toContain("**To fix before merge**");
    expect(body).toContain("- [ ] the guard runs after the return");
    expect(body).toContain("- [ ] the new test asserts the old behaviour");
    expect(body).not.toContain("<details>");
  });

  /**
   * A finding the model wrapped over two lines cannot be allowed to break the
   * list it sits in — the same reason a follow-up title is collapsed.
   */
  it("keeps a wrapped finding on one line", () => {
    const body = renderReviewSummary({
      ...parts,
      output: output({ fixBeforeMerge: ["the guard runs\n  after the return"] }),
    });

    expect(body).toContain("- [ ] the guard runs after the return");
  });

  it("carries no checklist at all when there is nothing to fix", () => {
    expect(renderReviewSummary(parts)).not.toContain("To fix before merge");
  });

  /**
   * And the round note, which is the one thing in the body that is a fact about
   * how the run read the repository rather than about the change.
   */
  it("says when the round was assumed rather than established", () => {
    const body = renderReviewSummary({ ...parts, roundNote: "_Reviewed as a second round._" });

    expect(body).toContain("_Reviewed as a second round._");
  });
});

/**
 * The checklist is the set the **verdict was counted from** (#105), which
 * `fixBeforeMerge` alone is not: the count takes the larger of the list and the
 * labelled findings, so the case that rule exists for — a finding labelled in
 * a finding body and left off the list — posted *changes recommended*
 * over an empty checklist. Round 2 is then told that checklist is what to
 * verify against, under a verdict line reading "no need to read them first".
 */
describe("the checklist and the count are one set", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    summary: "s",
    findings: [],
    followUps: [],
    fixBeforeMerge: [],
    ...over,
  });
  const body = (over: Partial<ReviewOutput>): string =>
    renderReviewSummary({
      verdict: VERDICTS["changes recommended"],
      output: output(over),
      placed: [],
    });

  it("records a labelled finding the list left out, anchored where it was made", () => {
    const missing = {
      findings: [
        finding({
          path: "src/queue.ts",
          line: 206,
          body: "**Fix before merge.** the guard runs after the return.",
        }),
      ],
    };

    expect(countFixBeforeMerge(output(missing))).toBe(1);
    expect(fixBeforeMergeChecklist(output(missing))).toHaveLength(1);
    expect(body(missing)).toContain("- [ ] `src/queue.ts:206` — the guard runs after the return.");
  });

  /**
   * Up to the comment's first line break, so a ```suggestion block stays in the
   * comment it belongs to rather than being collapsed into the list.
   */
  it("takes the claim a finding opens with, not the fix it carries", () => {
    const suggested = body({
      findings: [
        finding({
          body: "__Fix before merge__ this comment describes the old behaviour.\n\n```suggestion\n * Returns every match\n```",
        }),
      ],
    });

    expect(suggested).toContain("— this comment describes the old behaviour.");
    expect(suggested).not.toContain("```suggestion");
  });

  /**
   * A review that did as it was asked renders its own words and nothing else:
   * the list accounts for every labelled comment, so the comments add nothing.
   */
  it("renders the list alone when it accounts for every labelled finding", () => {
    const both = {
      fixBeforeMerge: ["the guard runs after the return"],
      findings: [
        finding({ body: "**Fix before merge.** the guard runs after the return" }),
      ],
    };

    expect(fixBeforeMergeChecklist(output(both))).toEqual(["the guard runs after the return"]);
    expect(body(both).match(/- \[ \]/g)).toHaveLength(1);
  });

  /**
   * And when they outnumber it, all of them are recorded rather than the ones
   * the list left out: the list restates the same findings in the model's own
   * words, so telling which line restates which comment is prose-matching. A
   * finding written down twice costs a reader a moment; one written down
   * nowhere is the failure this exists to remove.
   */
  it("records every labelled finding once the list is short, rather than guessing which", () => {
    const short = {
      fixBeforeMerge: ["the guard runs after the return"],
      findings: [
        finding({ path: "a.ts", body: "**Fix before merge.** the guard runs after the return" }),
        finding({ path: "b.ts", body: "**Fix before merge.** the new test asserts the old behaviour" }),
      ],
    };

    expect(countFixBeforeMerge(output(short))).toBe(2);
    expect(body(short)).toContain("- [ ] the guard runs after the return");
    expect(body(short)).toContain("`b.ts:10` — the new test asserts the old behaviour");
  });
});

/**
 * Every finding reaches the pull request, and the verdict counts every one of
 * them — the two halves of #110 that a placement decision could quietly break.
 *
 * What this replaced dropped a finding whose anchor GitHub would reject, which
 * made the count and the record disagree in the one direction that matters: a
 * verdict saying *changes recommended* over a review showing nothing to change.
 * So the property under test is not "the line threads are right", it is that
 * **the three placements together lose nothing**.
 */
describe("no placement loses a finding", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    summary: "s",
    findings: [],
    followUps: [],
    fixBeforeMerge: [],
    ...over,
  });

  // Real `git diff` output: one hunk on `src/queue.ts` covering new-side lines
  // 8..12, and nothing at all on `src/other.ts`.
  const DIFF_LINES = parseDiffLines(`diff --git a/src/queue.ts b/src/queue.ts
index 0ff3bbb..c6ca7ae 100644
--- a/src/queue.ts
+++ b/src/queue.ts
@@ -8,4 +8,5 @@ export const drain = () => {
 const eight = 8;
 const nine = 9;
+const ten = 10;
 const eleven = 11;
 const twelve = 12;
`);

  const ON_A_LINE = finding({
    path: "src/queue.ts",
    line: 10,
    title: "the guard runs after the return",
    body: "**Fix before merge.** the guard runs after the return",
  });
  const PAST_THE_HUNKS = finding({
    path: "src/queue.ts",
    line: 400,
    title: "the retry loop never terminates",
    body: "**Fix before merge.** the retry loop never terminates",
  });
  const IN_AN_UNTOUCHED_FILE = finding({
    path: "src/other.ts",
    line: 88,
    title: "the cache key omits the tenant",
    body: "**Fix before merge.** the cache key omits the tenant",
  });

  const findings = [ON_A_LINE, PAST_THE_HUNKS, IN_AN_UNTOUCHED_FILE];
  const placed: PlacedFinding[] = placeFindings(findings, DIFF_LINES);
  const reviewed = output({ findings });

  it("places one of each kind, from the diff", () => {
    expect(placed.map((p) => p.placement)).toEqual(["line", "file", "body"]);
  });

  it("posts every one of them, in a thread or in the body", () => {
    const body = renderReviewSummary({
      verdict: VERDICTS["changes recommended"],
      output: reviewed,
      placed,
    });
    const posted = [...reviewThreads(placed).map((t) => t.body), body].join("\n");

    for (const f of findings) expect(posted).toContain(f.title);
  });

  /**
   * And the count is over the findings as produced, so it cannot depend on
   * where they were put. Three findings, three placements, one verdict.
   */
  it("counts all three toward the verdict, whatever each one's placement", () => {
    expect(countFixBeforeMerge(reviewed)).toBe(3);
    expect(deriveVerdict(reviewed, { ci: "green", round: 1 }).verdict).toBe("changes recommended");
  });

  /** Each thread and each body entry carries the id the workflow wrote for it. */
  it("gives every posted finding an id a later round can read back", () => {
    const body = renderReviewSummary({
      verdict: VERDICTS["changes recommended"],
      output: reviewed,
      placed,
    });
    const posted = [...reviewThreads(placed).map((t) => t.body), body].join("\n");

    expect(new Set(placed.map((p) => p.id)).size).toBe(3);
    for (const { id } of placed) expect(posted).toContain(`<!-- agent-finding ${id} -->`);
  });
});

/**
 * The prompt half of the same decision. Two finding types reach the model as
 * words, and the retired one is the reason the PRD exists: *judgement call* —
 * "a preference you would accept being overruled on" — absorbed everything real
 * but not dangerous, so every review had to be read to find out which it was.
 */
describe("the review's finding vocabulary", () => {
  const PROMPT = fs.readFileSync(path.join("review", "prompt.md"), "utf8");
  const EXTRACTION = fs.readFileSync(path.join("review", "extraction.md"), "utf8");
  const halves = [
    ["prompt.md", PROMPT],
    ["extraction.md", EXTRACTION],
  ] as const;

  it.each(halves)("%s labels a finding fix before merge", (_half, text) => {
    expect(text).toContain("fix before merge");
  });

  it.each(halves)("%s offers neither retired label", (_half, text) => {
    expect(text.toLowerCase()).not.toContain("judgement call");
    expect(text.toLowerCase()).not.toContain("blocking");
  });

  it.each(halves)("%s asks for the countable list by name", (_half, text) => {
    expect(text).toContain("fixBeforeMerge");
  });

  /**
   * And the field that says a fix round is not the answer, with the three cases
   * #96 names. Without them it is a severity dial, and a severity dial is the
   * thing that was just retired.
   */
  it("names needsYou and the three cases it is for", () => {
    expect(PROMPT).toContain("needsYou");
    expect(EXTRACTION).toContain("needsYou");
    expect(PROMPT).toContain("the wrong thing was built");
    expect(PROMPT).toContain("the issue itself was wrong");
    expect(PROMPT).toMatch(/cannot say why/);
  });
});
