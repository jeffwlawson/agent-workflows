import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiffLines } from "../shared/diff-lines.js";
import {
  findingMarker,
  placeFindings,
  reviewThreads,
  type Finding,
  type PlacedFinding,
  type Severity,
} from "../shared/review-findings.js";
import { carriedFindings } from "../shared/review-verification.js";
import {
  capFollowUps,
  countFixBeforeMerge,
  deriveVerdict,
  FOLLOW_UPS_MARKER,
  hasFollowUpsBlock,
  MAX_FOLLOW_UPS,
  parseFollowUpsBlock,
  renderFollowUpsBlock,
  renderReviewBody,
  reviewOutputSchema,
  reviewRecord,
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
  severity: "medium",
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
  severity: "medium",
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

  it("keeps a follow-up's fields, and rates an unrated one in the middle", () => {
    const out = parse({
      summary: "s",
      followUps: [{ title: "Leak in parse()", location: "src/a.ts:12", body: "evidence" }],
    });

    expect(out.followUps).toEqual([
      { title: "Leak in parse()", location: "src/a.ts:12", body: "evidence", severity: "medium" },
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
    verified: [],
    ...over,
  });

  it("recommends approval when nothing is wrong and the checks are green", () => {
    expect(deriveVerdict(output(), { ci: "green", round: 1, stillOpen: 0 }).verdict).toBe("approval recommended");
  });

  it("recommends changes when the findings are the only thing wrong", () => {
    expect(
      deriveVerdict(output({ fixBeforeMerge: ["the guard runs after the return"] }), {
        ci: "green",
        round: 1,
        stillOpen: 0,
      }).verdict,
    ).toBe("changes recommended");
  });

  it("needs a closer look when the agent says a fix round cannot settle it", () => {
    expect(
      deriveVerdict(output({ needsYou: "the issue asked for the opposite" }), {
        ci: "green",
        round: 1,
        stillOpen: 0,
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
    expect(deriveVerdict(output(), { ci: ci as CiResult, round: 1, stillOpen: 0 }).verdict).toBe(
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
        stillOpen: 0,
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

    expect(deriveVerdict(labelled, { ci: "green", round: 1, stillOpen: 0 }).verdict).toBe("changes recommended");
    expect(deriveVerdict(labelled, { ci: "green", round: 2, stillOpen: 0 }).verdict).toBe(
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
        deriveVerdict(output({ findings: [finding({ body })] }), { ci: "green", round: 1, stillOpen: 0 })
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

    expect(deriveVerdict(chatty, { ci: "green", round: 1, stillOpen: 0 }).verdict).toBe("approval recommended");
  });

  it("counts one finding once when it is recorded in both places", () => {
    const both = output({
      fixBeforeMerge: ["the guard runs after the return"],
      findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })],
    });

    // The larger of the two, not the sum — and either way a fix is a fix, so
    // what this pins is the arithmetic rather than the verdict.
    expect(deriveVerdict(both, { ci: "green", round: 1, stillOpen: 0 }).verdict).toBe("changes recommended");
    expect(countFixBeforeMerge(both)).toBe(1);
  });

  it("prefers a closer look over a fix-before-merge finding", () => {
    expect(
      deriveVerdict(output({ fixBeforeMerge: ["a"], needsYou: "the wrong thing was built" }), {
        ci: "green",
        round: 1,
        stillOpen: 0,
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
      stillOpen: 0,
    });

    expect(second.verdict).toBe("changes recommended after a fix round");
    expect(second.heading).toBe(VERDICTS["changes recommended"].heading);
    expect(second.nextStep).toBe(
      "A fix round didn't settle these. Read the review, add guidance where it helps, then add agent:fix.",
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
    expect(deriveVerdict(output(), { ci: "green", round: 2, stillOpen: 0 }).verdict).toBe(
      "approval recommended",
    );
  });

  /**
   * A finding this review **carried** rather than found: an earlier round
   * raised it, this one checked and it is still not fixed (#111). It counts
   * exactly as one of this review's own would — a review that found nothing new
   * and three things still unfixed is not an approval, and the fixer no longer
   * closes anything, so nothing else would stop it.
   */
  it("recommends changes when the only thing wrong is what an earlier round asked for", () => {
    expect(deriveVerdict(output(), { ci: "green", round: 1, stillOpen: 1 }).verdict).toBe(
      "changes recommended",
    );
  });

  /**
   * Added rather than maximised, unlike the two halves inside
   * `countFixBeforeMerge`: those are two restatements of one set of findings,
   * these are two disjoint sets. What makes the distinction visible is the
   * round-2 row, which either source alone is enough to reach.
   */
  it("carries an earlier round's unfixed finding into the round-2 line", () => {
    expect(deriveVerdict(output(), { ci: "green", round: 2, stillOpen: 2 }).verdict).toBe(
      "changes recommended after a fix round",
    );
  });

  /**
   * *Previously missed* (#109, decision 4) — a real problem in code an earlier
   * review already read. It is a fix-before-merge finding carrying one extra
   * statement, so in round 2 it derives the round-2 row like any other, and
   * **never** round 1's: the maintainer reads and replies rather than the loop
   * going round again.
   *
   * This is the rule #96 set and this slice changed. Such a finding used to be
   * a `followUps` entry — filed as an issue after the merge it should have
   * stopped (`docs/parity.md` §10).
   */
  it("gives a previously-missed finding the round it was found in, never round 1's line", () => {
    const missed = output({
      findings: [
        finding({ body: "**Previously missed.** the cache key omits the tenant" }),
      ],
    });

    expect(countFixBeforeMerge(missed)).toBe(1);
    expect(deriveVerdict(missed, { ci: "green", round: 2, stillOpen: 0 }).verdict).toBe(
      "changes recommended after a fix round",
    );
    expect(deriveVerdict(missed, { ci: "green", round: 1, stillOpen: 0 }).verdict).toBe(
      "changes recommended",
    );
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
      "Approval recommended. Nothing left to fix. Merge when ready; follow-ups are filed as issues on merge.",
    ],
    [
      "changes recommended",
      "🟡 Changes recommended",
      "failure",
      "Changes recommended. The fixes are clear. Add agent:fix to start a fix round; a re-review follows automatically.",
    ],
    [
      "changes recommended after a fix round",
      "🟡 Changes recommended",
      "failure",
      "Changes recommended. A fix round didn't settle these. Read the review, add guidance where it helps, then add agent:fix.",
    ],
    [
      "needs a closer look",
      "🔵 Needs a closer look",
      "failure",
      "Needs a closer look. A fix round can't settle this alone. Read the review, add guidance, then add agent:fix or close the PR.",
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
   * Two renderings of one row. The body is the heading over the step; the status
   * line is the `label` — the heading without its marker, which a description
   * refuses — and the step. Written out rather than composed so the table reads
   * as what a maintainer sees, which leaves exactly one way for them to drift,
   * and this is it.
   */
  it("says the same thing on the status as the body says in two parts", () => {
    for (const row of Object.values(VERDICTS)) {
      expect(row.heading, row.verdict).toMatch(new RegExp(` ${row.label}$`));
      expect(row.description, row.verdict).toBe(`${row.label}. ${row.nextStep}`);
    }
  });

  /**
   * GitHub refuses a status description holding any character outside the
   * Basic Multilingual Plane (`422 Description doesn't accept 4-byte Unicode`),
   * and every assessment marker is one. v0.3.0 shipped them there, so every
   * verdict post was rejected — and the step's warning named a missing grant,
   * which is why it read as an adopter's misconfiguration rather than ours
   * (#121). The heading keeps its marker: a review body accepts it.
   */
  it("keeps every status description to characters GitHub accepts there", () => {
    for (const row of Object.values(VERDICTS)) {
      const astral = [...row.description].filter((ch) => (ch.codePointAt(0) ?? 0) > 0xffff);
      expect(astral, row.verdict).toEqual([]);
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
 * The body a maintainer actually reads, which is now a **record** rather than a
 * rendering (#109, decision 8).
 *
 * What it replaced was a flat checklist of `fixBeforeMerge` lines, and the
 * things it could not say are why this exists: a finding the last round asked
 * for and this one verified fixed disappeared with nothing saying it had ever
 * been raised, a finding an earlier review had already read the code for looked
 * exactly like one it had never seen, and nine findings read the same as one.
 * The record keeps the rounds in it, and a severity on each entry so the worst
 * is the first one a reader meets.
 *
 * Two parts of the old body survive unchanged because their reason did (#105):
 * `needsYou` fed the derivation and reached nobody, and the set the body
 * records is the set the verdict was counted from.
 */
describe("the posted review body", () => {
  const SUMMARY = "The change does what the issue asked.";
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    summary: SUMMARY,
    findings: [],
    followUps: [],
    fixBeforeMerge: [],
    verified: [],
    ...over,
  });
  const parts = {
    verdict: VERDICTS["changes recommended"],
    output: output(),
    placed: [],
    stillOpen: [],
    resolved: [],
  };
  const render = (over: Partial<Parameters<typeof renderReviewBody>[0]> = {}): string =>
    renderReviewBody({ ...parts, ...over });

  /** One labelled finding on a line the diff covers, placed with a known id. */
  const placedFinding = (over: Partial<Finding> = {}): PlacedFinding[] => [
    {
      id: "f-new",
      placement: "line",
      finding: finding({
        path: "src/queue.ts",
        line: 206,
        title: "the guard runs after the return",
        body: "**Fix before merge.** the guard runs after the return",
        ...over,
      }),
    },
  ];

  /**
   * Decision 8's order, which is Copilot code review's overview: the assessment
   * a reader recognises, what is unresolved, the step to take, then the count
   * that sizes it. The step is italic and does **not** repeat the heading,
   * which is what makes this a rendering of the verdict row rather than the
   * status line pasted in.
   */
  it("opens with the assessment, a sentence, the step in italics, then the count", () => {
    const body = render({ placed: placedFinding() });

    expect(body.startsWith("### 🟡 Changes recommended\n\n")).toBe(true);
    expect(body).toContain("1 finding is open.");
    expect(body).toContain(`_${parts.verdict.nextStep}_`);
    expect(body).not.toContain(parts.verdict.description);
    expect(body.indexOf("1 finding is open.")).toBeLessThan(body.indexOf("**Findings:** 1"));
    expect(body.indexOf(`_${parts.verdict.nextStep}_`)).toBeLessThan(body.indexOf("**Findings:**"));
  });

  /**
   * The sentence is what the heading cannot say: *changes recommended* is the
   * same three words over a round that found something new and over one that
   * found nothing and left the last round's findings unfixed.
   */
  it("names what is unresolved, and where it came from", () => {
    const body = render({
      placed: placedFinding(),
      stillOpen: [{ id: "f-1", threadId: "PRRT_one", text: "src/a.ts:4 — the cache key omits the tenant" }],
    });

    expect(body).toContain("2 findings are open, 1 carried from an earlier review.");
  });

  it("says so plainly when nothing is open", () => {
    expect(render()).toContain("Nothing is open on this pull request.");
    expect(render()).toContain("**Findings:** 0");
  });

  /**
   * And says what closed, which is the half a body with no memory could not:
   * the thread is gone from the next round's feedback, so this line is the only
   * trace that the work was done.
   */
  it("counts the round's closures even when nothing is left open", () => {
    const body = render({ resolved: [{ id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return" }] });

    expect(body).toContain("1 finding an earlier review raised was closed this round.");
    expect(body).toContain("<summary><b>Resolved since last review</b> — 1</summary>");
  });

  it("names the case when the agent said a fix round cannot settle it", () => {
    const body = render({ output: output({ needsYou: "the issue asked for the opposite" }) });

    // Above the count, because it qualifies the assessment rather than the
    // record: a reader meets it before deciding what the count means.
    expect(body).toContain("the issue asked for the opposite");
    expect(body.indexOf("the issue asked for the opposite")).toBeLessThan(
      body.indexOf("**Findings:**"),
    );
  });

  /**
   * And the round note, which is the one thing in the body that is a fact about
   * how the run read the repository rather than about the change.
   */
  it("says when the round was assumed rather than established", () => {
    expect(render({ roundNote: "_Reviewed as a second round._" })).toContain(
      "_Reviewed as a second round._",
    );
  });

  /**
   * Collapsible, not collapsed. *Open* is what the verdict has just told a
   * reader to act on, so a disclosure widget over it would be one more click
   * between the line and the work; *Resolved since last review* is the record's
   * memory and starts folded.
   */
  it("expands what is owed and folds what is done", () => {
    const body = render({
      placed: placedFinding(),
      resolved: [{ id: "f-1", threadId: "PRRT_one", text: "an earlier finding" }],
    });

    expect(body).toContain("<details open>\n<summary><b>Open</b> — 1</summary>");
    expect(body).toContain("<details>\n<summary><b>Resolved since last review</b> — 1</summary>");
  });

  it("drops a group with nothing in it rather than showing an empty widget", () => {
    const body = render();

    expect(body).not.toContain("<details");
  });

  /** A badge, the claim, where it is, and that this round is the one that found it. */
  it("enters a finding with its severity, its title, its anchor and a new marker", () => {
    const body = render({ placed: placedFinding({ severity: "high" }) });

    expect(body).toContain(
      "- `High` the guard runs after the return — `src/queue.ts:206` *new*",
    );
  });

  it("marks a carried finding as anything but new", () => {
    const body = render({
      stillOpen: [{ id: "f-1", threadId: "PRRT_one", text: "src/a.ts:4 — the cache key omits the tenant" }],
    });

    expect(body).toContain("- src/a.ts:4 — the cache key omits the tenant");
    expect(body).not.toContain("*new*");
  });

  /**
   * Worst first, and **stable** inside a rating: the order the review produced
   * its findings in is the order it thought about them.
   */
  it("sorts a group worst first, keeping the review's order inside a rating", () => {
    const at = (title: string, severity: Severity, id: string): PlacedFinding => ({
      id,
      placement: "line",
      finding: finding({ title, severity, body: `**Fix before merge.** ${title}` }),
    });
    const body = render({
      placed: [
        at("a low one", "low", "f-1"),
        at("the first high one", "high", "f-2"),
        at("a medium one", "medium", "f-3"),
        at("the second high one", "high", "f-4"),
      ],
    });

    expect(
      ["the first high one", "the second high one", "a medium one", "a low one"].map((t) =>
        body.indexOf(t),
      ),
    ).toEqual([...["the first high one", "the second high one", "a medium one", "a low one"]
      .map((t) => body.indexOf(t))
      .sort((a, b) => a - b)]);
  });

  /**
   * Decision 4, shown rather than stated: a real problem in code an earlier
   * review already read counts exactly as any other finding, and gets a group
   * of its own because *the record was wrong about this change* is the part
   * worth seeing. It is listed there and nowhere else.
   */
  it("puts a previously missed finding in its own group and not in Open", () => {
    const body = render({
      placed: [
        {
          id: "f-m",
          placement: "line",
          finding: finding({
            title: "the retry loop never terminates",
            body: "**Previously missed.** the retry loop never terminates",
          }),
        },
      ],
    });

    expect(body).toContain("<summary><b>Previously missed</b> — 1</summary>");
    expect(body).not.toContain("<summary><b>Open</b>");
    expect(body).toContain("**Findings:** 1");
    expect(body).toContain("1 finding is open, 1 in code an earlier review had already read.");
  });

  /**
   * A threaded finding is listed **without** its id: the thread is its record,
   * and a second copy in the body is one a maintainer cannot close. Resolving a
   * thread by hand is how they settle a finding, and a body that named it again
   * would raise it in the next round anyway.
   */
  it("leaves the id off a finding whose thread is already the record", () => {
    const threaded = { id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return" };
    const body = render({ stillOpen: [threaded] });

    expect(body).not.toContain(findingMarker("f-1"));
    expect(carriedFindings({ threads: [], latestReviewBody: body })).toEqual([]);
  });

  /**
   * And a thread-less one keeps it, which is what makes the body a record. A
   * finding in a file this pull request never touched has no thread to stay
   * open on (#110), so the newest review body naming it is the only thing
   * keeping it alive — and the next round reads it back off exactly this line.
   */
  it("keeps a thread-less finding alive by writing its id and its rating back", () => {
    const stillOpen = [
      { id: "f-9", severity: "low" as const, text: "`src/other.ts:88` — the cache key omits the tenant" },
    ];
    const carried = carriedFindings({ threads: [], latestReviewBody: render({ stillOpen }) });

    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ id: "f-9", severity: "low" });
    expect(carried[0]?.text).toContain("the cache key omits the tenant");
  });

  /**
   * A resolved one keeps **no** id, which is the same rule in the other
   * direction: an id written back would carry a closed finding into the next
   * round as something still to rule on.
   */
  it("writes no id back for a finding it just closed", () => {
    const body = render({ resolved: [{ id: "f-9", text: "`src/other.ts:88` — the cache key omits the tenant" }] });

    expect(carriedFindings({ threads: [], latestReviewBody: body })).toEqual([]);
  });

  /**
   * A finding GitHub has nowhere to thread is quoted in full inside its entry.
   * A list of anchors with no reasoning is a finding a reader cannot check, and
   * the body is the only surface this one has.
   */
  it("quotes a thread-less finding in full, and says why it has no thread", () => {
    const body = render({
      placed: [
        {
          id: "f-b",
          placement: "body",
          finding: finding({
            path: "src/other.ts",
            line: 88,
            title: "the cache key omits the tenant",
            body: "**Fix before merge.** `key()` hashes the id and not the tenant.",
          }),
        },
      ],
    });

    expect(body).toContain("- `Medium` the cache key omits the tenant — `src/other.ts:88` *new*");
    expect(body).toContain("  **Fix before merge.** `key()` hashes the id and not the tenant.");
    expect(body).toContain("is in a file this pull request does not change");
  });

  /**
   * And the round after it reads that entry back as the claim it was, rather
   * than as the claim plus the decorations this file wrote around it. Without
   * the strip a body entry collects another badge and keeps a stale *new* every
   * round it survives.
   */
  it("re-enters a carried body finding without redecorating it", () => {
    const first = render({
      placed: [
        {
          id: "f-b",
          placement: "body",
          finding: finding({
            path: "src/other.ts",
            line: 88,
            severity: "high",
            title: "the cache key omits the tenant",
            body: "**Fix before merge.** the cache key omits the tenant",
          }),
        },
      ],
    });
    const carried = carriedFindings({ threads: [], latestReviewBody: first });
    const second = render({ stillOpen: carried });

    expect(second).toContain("- `High` the cache key omits the tenant — `src/other.ts:88` <!--");
    expect(second).not.toContain("`High` `High`");
    expect(second).not.toContain("*new*");

    // And it holds every round after: what round three reads is what round four
    // would write, so the entry stops growing.
    const again = carriedFindings({ threads: [], latestReviewBody: second });
    expect(again).toEqual(
      carriedFindings({ threads: [], latestReviewBody: render({ stillOpen: again }) }),
    );
  });

  /**
   * And it strips the badge its **own** severity would have written, not any
   * badge: a claim that legitimately opens by quoting one is a claim somebody
   * reviewing a codebase with severities in it will eventually make.
   */
  it("keeps a claim that opens with a badge it did not write", () => {
    const body = render({
      stillOpen: [{ id: "f-9", severity: "high", text: "`Low` is not a place for preferences" }],
    });

    expect(body).toContain("- `High` `Low` is not a place for preferences");
  });

  /**
   * The prose last but one, under a heading that says what it is for. The
   * findings are above it as a list, so the summary's job is the change rather
   * than a second telling of them.
   */
  it("puts the agent's prose under what changed, after the record", () => {
    const body = render({ placed: placedFinding() });

    expect(body).toContain(`**What changed in this PR**\n\n${SUMMARY}`);
    expect(body.indexOf("**Findings:**")).toBeLessThan(body.indexOf("**What changed in this PR**"));
  });

  it("links the run that produced it, and renders none when it has no run to name", () => {
    expect(render({ runUrl: "https://github.com/o/r/actions/runs/7" })).toContain(
      "_Posted by [this workflow run](https://github.com/o/r/actions/runs/7)._",
    );
    expect(render()).not.toContain("workflow run");
  });
});

/**
 * The record is the set the **verdict was counted from** (#105), which
 * `fixBeforeMerge` alone is not: the count takes the larger of the list and the
 * labelled findings, so the case that rule exists for — a finding labelled in a
 * finding body and left off the list — posted *changes recommended* over an
 * empty checklist. Round 2 is then told that checklist is what to verify
 * against, under a verdict line saying the fixes are clear.
 */
describe("the record and the count are one set", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    summary: "s",
    findings: [],
    followUps: [],
    fixBeforeMerge: [],
    verified: [],
    ...over,
  });
  // Every path these findings name is in the diff, on the line they name, so
  // each one becomes a line thread: what is under test here is the record's
  // arithmetic, not where GitHub would let a thread hang.
  const DIFF_LINES = new Map([
    ["src/a.ts", new Set([10])],
    ["src/queue.ts", new Set([206])],
    ["a.ts", new Set([10])],
  ]);
  const place = (over: Partial<ReviewOutput>): PlacedFinding[] =>
    placeFindings(output(over).findings, DIFF_LINES, () => "f-x");
  const record = (over: Partial<ReviewOutput>) =>
    reviewRecord({ output: output(over), placed: place(over), stillOpen: [], resolved: [] });
  const body = (over: Partial<ReviewOutput>): string =>
    renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output: output(over),
      placed: place(over),
      stillOpen: [],
      resolved: [],
    });

  it("records a labelled finding the list left out, anchored where it was made", () => {
    const missing = {
      findings: [
        finding({
          path: "src/queue.ts",
          line: 206,
          title: "the guard runs after the return",
          body: "**Fix before merge.** the guard runs after the return.",
        }),
      ],
    };

    expect(countFixBeforeMerge(output(missing))).toBe(1);
    expect(record(missing).findings).toBe(1);
    expect(body(missing)).toContain("the guard runs after the return — `src/queue.ts:206`");
  });

  /**
   * A finding the model gave no title of its own is entered under the claim its
   * body opens with, up to the first line break — so a ```suggestion block
   * stays in the finding it belongs to rather than being collapsed into the
   * record.
   */
  it("takes the claim a finding opens with, not the fix it carries", () => {
    const suggested = body({
      findings: [
        finding({
          title: "",
          body: "__Fix before merge__ this comment describes the old behaviour.\n\n```suggestion\n * Returns every match\n```",
        }),
      ],
    });

    expect(suggested).toContain("this comment describes the old behaviour.");
    expect(suggested).not.toContain("```suggestion");
  });

  /**
   * A review that did as it was asked is recorded once. The list restates the
   * findings the record already carries, so a second entry per finding would be
   * the same work read twice.
   */
  it("records each finding once when the list accounts for every one of them", () => {
    const both = {
      fixBeforeMerge: ["the guard runs after the return"],
      findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })],
    };

    expect(record(both).findings).toBe(1);
    expect(body(both).match(/^- /gm)).toHaveLength(1);
  });

  /**
   * And when the list outnumbers them, all of it is recorded rather than the
   * lines it left out: the list restates the same findings in the model's own
   * words, so telling which line restates which finding is prose-matching. A
   * finding written down twice costs a reader a moment; one written down
   * nowhere is the failure this exists to remove.
   */
  it("records every restatement once the findings are short, rather than guessing which", () => {
    const short = {
      fixBeforeMerge: ["the guard runs after the return", "the new test asserts the old behaviour"],
      findings: [finding({ path: "a.ts", body: "**Fix before merge.** the guard runs after the return" })],
    };

    expect(countFixBeforeMerge(output(short))).toBe(2);
    expect(body(short)).toContain("- the guard runs after the return");
    expect(body(short)).toContain("- the new test asserts the old behaviour");
    // Never fewer entries than the verdict counted, which is the direction that
    // matters; a finding recorded twice is the price of never losing one.
    expect(record(short).findings).toBeGreaterThanOrEqual(countFixBeforeMerge(output(short)));
  });

  /** A restatement has no finding behind it to rate, so it sorts last and shows no badge. */
  it("gives a restatement no severity it did not come with", () => {
    const short = {
      fixBeforeMerge: ["one", "two"],
      findings: [finding({ severity: "low", body: "**Fix before merge.** a low finding" })],
    };

    expect(record(short).open.map((entry) => entry.severity)).toEqual(["low", undefined, undefined]);
  });
});

/**
 * **Severity decides nothing** (#109, decision 9). It is the property that
 * makes the rest of the record readable, and it is also the property most
 * likely to grow into a fourth verdict input by accident — which is exactly the
 * *judgement call* label #96 retired, because a dial the model turns means
 * every review has to be read to find out which way it was turned.
 *
 * So the test is not an example, it is every arrangement: permute the ratings
 * across a review's findings and its follow-ups, and the verdict, the count and
 * what is filed are byte-identical each time.
 */
describe("severity changes no outcome", () => {
  const RATINGS: readonly Severity[] = ["high", "medium", "low"];

  /** Every assignment of the three ratings to three findings — 27 of them. */
  const assignments: Severity[][] = RATINGS.flatMap((a) =>
    RATINGS.flatMap((b) => RATINGS.map((c) => [a, b, c])),
  );

  const reviewed = (severities: readonly Severity[]): ReviewOutput => ({
    summary: "s",
    findings: severities.map((severity, index) =>
      finding({
        path: `src/${index}.ts`,
        severity,
        body: "**Fix before merge.** the guard runs after the return",
      }),
    ),
    followUps: severities.map((severity) => followUp({ severity })),
    fixBeforeMerge: ["one", "two", "three"],
    verified: [],
  });

  it.each(["green", "red", "unknown"] as const)(
    "derives the same verdict on %s checks however the findings are rated",
    (ci: CiResult) => {
      const baseline = deriveVerdict(reviewed(["medium", "medium", "medium"]), {
        ci,
        round: 1,
        stillOpen: 0,
      });

      for (const severities of assignments) {
        expect(deriveVerdict(reviewed(severities), { ci, round: 1, stillOpen: 0 }), severities.join()).toEqual(
          baseline,
        );
      }
    },
  );

  it("counts the same findings however they are rated", () => {
    for (const severities of assignments) {
      expect(countFixBeforeMerge(reviewed(severities)), severities.join()).toBe(3);
    }
  });

  /**
   * And the cap keeps the reviewer's order rather than re-ranking it. The
   * finding's place in that list is half the key a filing run recognises its
   * own work by, so a sort here would change which stub a retry matched.
   */
  it("keeps the follow-up order the reviewer gave, whatever the ratings", () => {
    for (const severities of assignments) {
      const kept = capFollowUps(reviewed(severities).followUps).kept;
      expect(kept.map((f) => f.severity), severities.join()).toEqual(severities);
    }
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
    verified: [],
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
    const body = renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output: reviewed,
      placed,
      stillOpen: [],
      resolved: [],
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
    expect(deriveVerdict(reviewed, { ci: "green", round: 1, stillOpen: 0 }).verdict).toBe(
      "changes recommended",
    );
  });

  /** Each thread and each body entry carries the id the workflow wrote for it. */
  it("gives every posted finding an id a later round can read back", () => {
    const body = renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output: reviewed,
      placed,
      stillOpen: [],
      resolved: [],
    });
    const posted = [...reviewThreads(placed).map((t) => t.body), body].join("\n");

    expect(new Set(placed.map((p) => p.id)).size).toBe(3);
    for (const p of placed) expect(posted).toContain(findingMarker(p.id, p.finding.severity));
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
  /**
   * And the rating, which is the field most likely to be read as a fourth
   * verdict input — by the model first. Both halves say it decides nothing, and
   * both define *low* as a real but small defect rather than as a place to put
   * the preferences neither half posts (#109, decision 9).
   */
  it.each(halves)("%s asks for a severity on every finding", (_half, text) => {
    expect(text).toContain("severity");
    for (const rating of ["high", "medium", "low"]) expect(text).toContain(rating);
  });

  it.each(halves)("%s defines low as a real but small defect", (_half, text) => {
    expect(text).toContain("a real but small defect");
  });

  it.each(halves)("%s says the severity decides nothing", (_half, text) => {
    expect(text).toMatch(/display and ordering only/);
  });

  it("names needsYou and the three cases it is for", () => {
    expect(PROMPT).toContain("needsYou");
    expect(EXTRACTION).toContain("needsYou");
    expect(PROMPT).toContain("the wrong thing was built");
    expect(PROMPT).toContain("the issue itself was wrong");
    expect(PROMPT).toMatch(/cannot say why/);
  });
});
