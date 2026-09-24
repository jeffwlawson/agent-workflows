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
import {
  carriedFindings,
  verifyCarried,
  type CarriedFinding,
} from "../shared/review-verification.js";
import {
  capFollowUps,
  countFixBeforeMerge,
  deriveVerdict,
  FOLLOW_UPS_MARKER,
  hasFollowUpsBlock,
  MAX_FOLLOW_UPS,
  MAX_HOW_CHECKED_WORDS,
  MAX_WHAT_CHANGED,
  parseFollowUpsBlock,
  renderFollowUpsBlock,
  renderReviewBody,
  PREVIOUSLY_MISSED_SUBTITLE,
  reviewOutputSchema,
  reviewRecord,
  VERDICT_CONTEXT,
  VERDICTS,
  withMovedFindings,
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

/**
 * **The three prose fields**, and the two of them the schema holds to a size.
 *
 * A prompt-only "under 250 words" is a limit with nothing behind it, and the
 * body it produced ran long enough to bury the record above it. So the cap is
 * here, where a review cannot talk its way past it — and it **truncates**
 * rather than refuses, which is the choice `capFollowUps` and `parseFinding`
 * both make: a reviewer that wrote a long paragraph has not produced a broken
 * review, and refusing it would lose every finding in it.
 */
describe("reviewOutputSchema: the prose beside the findings", () => {
  it("keeps the review's assessment, and reads a blank one as absent", () => {
    expect(parse({ assessment: "Undo-safe state handling is wrong here." }).assessment).toBe(
      "Undo-safe state handling is wrong here.",
    );
    for (const blank of [undefined, null, "", "   "]) {
      expect(parse({ assessment: blank }).assessment).toBeUndefined();
    }
  });

  it("truncates howChecked at the hard limit rather than losing the review", () => {
    const long = Array.from({ length: MAX_HOW_CHECKED_WORDS + 40 }, (_, i) => `w${i}`).join(" ");

    const kept = parse({ howChecked: long }).howChecked ?? "";

    expect(kept.split(/\s+/)).toHaveLength(MAX_HOW_CHECKED_WORDS);
    expect(kept.endsWith("…")).toBe(true);
    expect(kept.startsWith("w0 w1 ")).toBe(true);
  });

  it("leaves a howChecked inside the limit exactly as written", () => {
    expect(parse({ howChecked: "Ran the suite; traced `apply()`." }).howChecked).toBe(
      "Ran the suite; traced `apply()`.",
    );
  });

  it("keeps the first five changes and drops the rest from the end", () => {
    const changes = ["a", "b", "c", "d", "e", "f", "g"];

    expect(parse({ whatChanged: { summary: "s", changes } }).whatChanged).toEqual({
      summary: "s",
      changes: ["a", "b", "c", "d", "e"],
    });
    expect(MAX_WHAT_CHANGED).toBe(5);
  });

  /**
   * `summary` was one 250-word paragraph until the two fields split it, and a
   * model prompted for the new shape still reaches for the old one. It is read
   * as *what changed* and never as the assessment: the one thing the brief now
   * forbids that paragraph is restating the findings, and feeding it to the
   * sentence under the heading would be putting it back above them.
   */
  it("reads the field this replaced as what changed, never as the assessment", () => {
    const out = parse({ summary: "It moves thread resolution to the review." });

    expect(out.whatChanged).toEqual({
      summary: "It moves thread resolution to the review.",
      changes: [],
    });
    expect(out.assessment).toBeUndefined();
  });

  it("carries none of the three when the model wrote none of them", () => {
    const out = parse({});

    expect(out.assessment).toBeUndefined();
    expect(out.howChecked).toBeUndefined();
    expect(out.whatChanged).toBeUndefined();
  });
});

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
   * throwing here fails the whole output — every finding and all three prose
   * fields with it — so a model that emitted a fourth follow-up would cost the
   * entire review.
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

/**
 * **A moved finding leads the follow-ups** (#127, decision 3).
 *
 * The cap drops from the end, so this order is what decides which findings
 * survive to be filed. A moved one is a finding the review believed had to be
 * fixed before the pull request merged; the rest of the list is what it wrote
 * knowing it was out of scope. Appending would spend the three slots on the
 * weaker claims and drop the stronger one, which is a blocker lost to a note
 * about a function the diff only calls.
 */
describe("withMovedFindings", () => {
  const moved = (over: Partial<Finding> = {}): Finding => ({
    title: "the cache key omits the tenant",
    path: "src/other.ts",
    line: 88,
    body: "**Fix before merge.** `key()` hashes the id and not the tenant.",
    severity: "high",
    ...over,
  });

  it("puts the moved findings in front of the ones the model recorded", () => {
    const list = withMovedFindings([moved()], followUps(2));

    expect(list.map((f) => f.title)).toEqual(["the cache key omits the tenant", "t0", "t1"]);
  });

  it("keeps the finding whole, and says how it got here", () => {
    const [entry] = withMovedFindings([moved()], []);

    expect(entry).toMatchObject({
      title: "the cache key omits the tenant",
      location: "src/other.ts:88",
      severity: "high",
    });
    expect(entry?.body).toContain("`key()` hashes the id and not the tenant.");
    expect(entry?.body).toContain("moved");
  });

  /**
   * And the cap then spends its slots on the moved ones first. Stated over the
   * pair rather than over the order alone, because "first" is only worth
   * anything as the thing the cap reads.
   */
  it("survives the cap that the model's own entries lose to", () => {
    const { kept, dropped } = capFollowUps(withMovedFindings([moved()], followUps(3)));

    expect(kept.map((f) => f.title)).toEqual(["the cache key omits the tenant", "t0", "t1"]);
    expect(dropped).toBe(1);
  });

  it("changes nothing where nothing was moved", () => {
    expect(withMovedFindings([], followUps(2))).toEqual(followUps(2));
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
    findings: [],
    followUps: [],
    fixBeforeMerge: [],
    verified: [],
    ...over,
  });

  it("recommends approval when nothing is wrong and the checks are green", () => {
    expect(deriveVerdict(output(), { ci: "green", round: 1, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe("approval recommended");
  });

  it("recommends changes when the findings are the only thing wrong", () => {
    expect(
      deriveVerdict(output({ fixBeforeMerge: ["the guard runs after the return"] }), {
        ci: "green",
        round: 1,
        stillOpen: 0, movedToFollowUps: 0 }).verdict,
    ).toBe("changes recommended");
  });

  it("needs a closer look when the agent says a fix round cannot settle it", () => {
    expect(
      deriveVerdict(output({ needsYou: "the issue asked for the opposite" }), {
        ci: "green",
        round: 1,
        stillOpen: 0, movedToFollowUps: 0 }).verdict,
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
    expect(deriveVerdict(output(), { ci: ci as CiResult, round: 1, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe(
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
        stillOpen: 0, movedToFollowUps: 0 }).verdict,
    ).toBe("changes recommended");
  });

  /**
   * The list is a restatement of findings the `findings` list already carries,
   * so either of the two can be the one the model forgot — and only one of the
   * two mistakes has a consequence. A finding written into `findings` and left
   * off the list used to derive *approval recommended*, which puts the unsafe
   * answer on the one signal meant to be acted on without reading (#105).
   */
  it("counts a finding the list left out", () => {
    const listless = output({
      findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })],
    });

    expect(deriveVerdict(listless, { ci: "green", round: 1, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe("changes recommended");
    expect(deriveVerdict(listless, { ci: "green", round: 2, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe(
      "changes recommended after a fix round",
    );
  });

  /**
   * **However the body is written, label or none.** The label is presentation
   * and no predicate reads it: by #96's decision 1 a finding is one of two
   * kinds and `followUps` is the other, so an entry in `findings` is
   * fix-before-merge by definition.
   *
   * What a predicate over the label cost is the unsafe direction twice over. A
   * finding it did not recognise in an untouched file was counted nowhere and
   * posted nowhere — the body is that one's only surface — so a review
   * recommended approval over a populated *Open* group; and one on a diff line
   * got a thread and an id, counted in no round that raised it, then counted
   * through `stillOpen` in every round after, turning non-blocking into
   * blocking with no code change.
   */
  it.each([
    "**Fix before merge.** x",
    "Fix before merge. x",
    "__Fix before merge__ x",
    "  **fix before merge:** x",
    "### Fix before merge\n\nx",
    "Worth a look before merge — the guard runs after the return.",
    "the guard runs after the return",
  ])("counts a finding whatever its body opens with: %s", (body: string) => {
    expect(
      deriveVerdict(output({ findings: [finding({ body })] }), { ci: "green", round: 1, stillOpen: 0, movedToFollowUps: 0 })
        .verdict,
      body,
    ).toBe("changes recommended");
  });

  it("counts one finding once when it is recorded in both places", () => {
    const both = output({
      fixBeforeMerge: ["the guard runs after the return"],
      findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })],
    });

    // One set, not the sum of two: a restatement counts only where the list is
    // longer than the findings it restates. Either way a fix is a fix, so what
    // this pins is the arithmetic rather than the verdict.
    expect(deriveVerdict(both, { ci: "green", round: 1, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe("changes recommended");
    expect(countFixBeforeMerge(both, 0)).toBe(1);
  });

  it("prefers a closer look over a fix-before-merge finding", () => {
    expect(
      deriveVerdict(output({ fixBeforeMerge: ["a"], needsYou: "the wrong thing was built" }), {
        ci: "green",
        round: 1,
        stillOpen: 0, movedToFollowUps: 0 }).verdict,
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
      stillOpen: 0, movedToFollowUps: 0 });

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
    expect(deriveVerdict(output(), { ci: "green", round: 2, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe(
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
    expect(deriveVerdict(output(), { ci: "green", round: 1, stillOpen: 1, movedToFollowUps: 0 }).verdict).toBe(
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
    expect(deriveVerdict(output(), { ci: "green", round: 2, stillOpen: 2, movedToFollowUps: 0 }).verdict).toBe(
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

    expect(countFixBeforeMerge(missed, 0)).toBe(1);
    expect(deriveVerdict(missed, { ci: "green", round: 2, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe(
      "changes recommended after a fix round",
    );
    expect(deriveVerdict(missed, { ci: "green", round: 1, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe(
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
/**
 * A review body exactly as **v0.4.0** posted one, carrying the body entry that
 * release wrote for a finding in a file the pull request never changed: the id
 * and the rating on the entry line, and the evidence indented under it.
 *
 * Kept as a literal rather than rendered by this version, which is the whole of
 * what it tests: decision 5 says the entries already on open pull requests are
 * carried and verified until they close, and nothing here can write one any
 * more. A fixture produced by the current renderer would only prove it agrees
 * with itself.
 */
const LEGACY_V040_BODY = `## Agent review

### 🔴 Changes recommended

The cache key is wrong in a way that has to be fixed first.

_Add \`agent:fix\` to this pull request._

**Findings:** 1 — 1 \`High\`

<details open>
<summary><b>Open</b> — 1</summary>

A finding quoted in full has no thread: it is in a file this pull request does not change.

- \`High\` the cache key omits the tenant — \`src/other.ts:88\` *new* <!-- agent-finding f-legacy high -->

  **Fix before merge.** \`key()\` hashes the id and not the tenant, so two tenants share a row.

</details>

---

_Posted by [this workflow run](https://github.com/o/r/actions/runs/1)._`;

describe("the posted review body", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
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
    movedToFollowUps: 0,
    stillOpen: [],
    resolved: [],
    followUps: [],
    droppedFollowUps: 0,
    showWhatChanged: true,
  };
  const render = (over: Partial<Parameters<typeof renderReviewBody>[0]> = {}): string =>
    renderReviewBody({ ...parts, ...over });

  /** The same finding, in code an earlier review had already read. */
  const missedFinding = (over: Partial<Finding> = {}): PlacedFinding[] => [
    {
      id: "f-missed",
      placement: "line",
      finding: finding({
        path: "src/queue.ts",
        line: 206,
        title: "the guard runs after the return",
        body: "**Previously missed.** the guard runs after the return",
        ...over,
      }),
    },
  ];

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
   * Decision 8's order, which is Copilot code review's overview: the heading
   * that says which comment this is, the assessment a reader recognises, what
   * is unresolved, the step to take, then the count that sizes it. The step is
   * italic and does **not** repeat the heading, which is what makes this a
   * rendering of the verdict row rather than the status line pasted in.
   */
  it("opens with its own heading, the assessment, a sentence, the step, then the count", () => {
    const body = render({ placed: placedFinding() });

    // Level 2, because `#` renders very large inside a comment — and the
    // assessment heading stays level 3 directly beneath it.
    expect(body.startsWith("## Agent review\n\n### 🟡 Changes recommended\n\n")).toBe(true);
    expect(body).toContain("1 finding is open.");
    expect(body).not.toContain(parts.verdict.description);
    expect(body.indexOf("1 finding is open.")).toBeLessThan(body.indexOf("**Findings:** 1"));
    expect(body.indexOf("_The fixes are clear.")).toBeLessThan(body.indexOf("**Findings:**"));
  });

  /**
   * **Every agent in the loop posts as `github-actions[bot]`**, so in the
   * timeline a review overview and a fix run's thread replies are the same
   * author saying more things. The heading is what marks the one to read, and
   * it matches the `agent-review` status and the `agent:review` label the way
   * Copilot's overview opens with "Copilot review overview".
   */
  it("names itself in the first line, and puts the assessment in the second", () => {
    const [first = "", second = ""] = render()
      .split("\n")
      .filter((line) => line.trim() !== "");

    expect(first).toBe("## Agent review");
    expect(second).toBe(`### ${VERDICTS["changes recommended"].heading}`);
  });

  /**
   * **A label name renders as code in the body and as plain text in the
   * status**, from one copy of the sentence. A status description renders no
   * Markdown at all, so a backtick shows up in it literally — which is why
   * `VERDICTS` holds the plain wording and the body decorates it on the way
   * out, rather than the table holding two spellings that can disagree.
   */
  it("renders a label name as code in the body, and leaves the status plain", () => {
    const body = render();

    expect(body).toContain("_The fixes are clear. Add `agent:fix` to start a fix round");
    expect(body).not.toContain("Add agent:fix");
    for (const row of Object.values(VERDICTS)) expect(row.description).not.toContain("`");
  });

  /** And any other label a line this file composes happens to name. */
  it("renders a label in the round note as code too", () => {
    expect(render({ roundNote: "_Re-run by adding agent:review._" })).toContain("`agent:review`");
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
   * **The review's own sentence wins**, which is the point of the field: a
   * count says how many and this says *what*, and the count is already on its
   * own line two below. Modelled on Copilot's, which names the subjects.
   */
  it("carries the review's own sentence under the heading, in place of the count", () => {
    const assessment = "Sequence validation and undo-safe state handling are each wrong here.";
    const body = render({ placed: placedFinding(), output: output({ assessment }) });

    expect(body).toContain(`### 🟡 Changes recommended\n\n${assessment}\n\n_`);
    expect(body).not.toContain("1 finding is open.");
    // Once, not twice: the sentence's job is to be the first thing read, and a
    // second copy lower down is the body repeating itself.
    expect(body.split(assessment)).toHaveLength(2);
    // And the counting stays where a reader looks for it.
    expect(body).toContain("**Findings:** 1");
  });

  /**
   * A blank one is an absent one — the same four shapes `needsYou` normalises —
   * because an empty line in a fixed layout reads as a rendering fault. The
   * fallback says less, and saying less is not the same as saying nothing.
   */
  it.each([undefined, "", "   "] as const)(
    "falls back to a sentence built from the record when the field is %p",
    (assessment) => {
      const built = render({
        placed: placedFinding(),
        output: output(assessment === undefined ? {} : { assessment }),
      });

      expect(built).toContain("1 finding is open.");
    },
  );

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
   * Collapsible, not collapsed. *Open* and *Previously missed* are what the
   * verdict has just told a reader to act on, so a disclosure widget over
   * either would be one more click between the line and the work — and
   * *Previously missed* counts toward that verdict, which is why it is not
   * folded the way Copilot folds its equivalent. *Resolved since last review*
   * is the record's memory and starts closed.
   */
  it("expands what is owed and folds what is done", () => {
    const body = render({
      placed: [...placedFinding(), ...missedFinding()],
      resolved: [{ id: "f-1", threadId: "PRRT_one", text: "an earlier finding" }],
    });

    expect(body).toContain("<details open>\n<summary><b>Open</b> — 1</summary>");
    expect(body).toContain("<details open>\n<summary><b>Previously missed</b> — 1</summary>");
    expect(body).toContain("<details>\n<summary><b>Resolved since last review</b> — 1</summary>");
  });

  /**
   * And in that order: what is owed, then what the record was wrong about,
   * then what closed. *Resolved* used to sit between the two expanded groups,
   * which put a folded widget in the middle of the list a reader is acting on.
   */
  it("orders the groups Open, Previously missed, Resolved", () => {
    const body = render({
      placed: [...placedFinding(), ...missedFinding()],
      resolved: [{ id: "f-1", threadId: "PRRT_one", text: "an earlier finding" }],
    });

    expect([...body.matchAll(/<summary><b>(.*?)<\/b>/g)].map(([, title]) => title)).toEqual([
      "Open",
      "Previously missed",
      "Resolved since last review",
    ]);
  });

  /**
   * **The group says what it means, in Copilot code review's words for it**
   * (#127). *Previously missed* names what happened to the record and not what
   * the finding is about; the subtitle is the line that says the code it is in
   * has not changed since a review already read it — and it sits directly under
   * the summary, where a reader meets it before the entries rather than after
   * deciding what they meant.
   *
   * The blank line between `</summary>` and it is load-bearing: GitHub renders
   * no Markdown inside a `<details>` until the content is separated from the
   * summary, so without it the subtitle arrives as literal underscores.
   */
  it("carries the previously-missed subtitle directly under the summary line", () => {
    const body = render({ placed: missedFinding() });

    expect(body).toContain(
      `<summary><b>Previously missed</b> — 1</summary>\n\n_${PREVIOUSLY_MISSED_SUBTITLE}_`,
    );
    expect(PREVIOUSLY_MISSED_SUBTITLE).toBe("In code that hasn't changed since last review");
  });

  /** And no other group carries one — it is this group's fact, not furniture. */
  it("gives the subtitle to no other group", () => {
    const body = render({
      placed: placedFinding(),
      resolved: [{ id: "f-1", threadId: "PRRT_one", text: "an earlier finding" }],
    });

    expect(body).not.toContain(PREVIOUSLY_MISSED_SUBTITLE);
  });

  /**
   * A *previously missed* entry is formatted exactly like an *Open* one —
   * badge, claim, anchor, the *new* mark — because it is one, with one more
   * thing said about it. A group that rendered its entries differently would
   * read as a lesser kind of finding, which is the opposite of decision 4.
   */
  it("renders a previously missed entry exactly as it renders an open one", () => {
    const missed = render({ placed: missedFinding({ severity: "high" }) });
    const open = render({ placed: placedFinding({ severity: "high" }) });
    const entryOf = (body: string): string =>
      body.split("\n").find((line) => line.startsWith("- ")) ?? "";

    expect(entryOf(missed)).toBe(entryOf(open));
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
   * And a thread-less one keeps it, which is what makes the body a record. Such
   * a finding has no thread to stay open on, so the newest review body naming
   * it is the only thing keeping it alive — and the next round reads it back
   * off exactly this line.
   *
   * Nothing raises one of these any more (#127, decision 1). What still arrives
   * is a **v0.4.0 body entry** on a pull request that was open when this
   * version landed, which decision 5 keeps carrying until it closes — so this
   * path is the legacy one, and it has to keep working for as long as one of
   * those pull requests is open.
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
   * **A finding this review raised carries neither an id nor its evidence**,
   * because it now always has a thread to carry both (#127, decision 1). The
   * entry is the one-line version of something a maintainer can reply to,
   * decline and resolve — which is the whole of what the body entry could not
   * be (#124).
   */
  it("writes no id and quotes no evidence for a finding it raised this round", () => {
    const body = render({
      placed: [
        {
          id: "f-b",
          placement: "file",
          finding: finding({
            path: "src/queue.ts",
            line: 88,
            title: "the cache key omits the tenant",
            body: "**Fix before merge.** `key()` hashes the id and not the tenant.",
          }),
        },
      ],
    });

    expect(body).toContain("- `Medium` the cache key omits the tenant — `src/queue.ts:88` *new*");
    expect(body).not.toContain("  **Fix before merge.**");
    expect(body).not.toContain(findingMarker("f-b", "medium"));
    expect(body).not.toContain("is in a file this pull request does not change");
    // And so the next round reads it off its thread rather than off this body.
    expect(carriedFindings({ threads: [], latestReviewBody: body })).toEqual([]);
  });

  /**
   * And a **v0.4.0 body entry** carried into a body this version posts reads
   * back as the claim it was, rather than as the claim plus the decorations
   * this file wrote around it. Without the strip it collects another badge and
   * keeps a stale *new* every round it survives — which is the round-on-round
   * half of decision 5: these are carried until they close, so they have to
   * survive arbitrarily many rounds unchanged.
   */
  it("re-enters a carried body finding without redecorating it", () => {
    const first = LEGACY_V040_BODY;
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
   * **A carried entry links to the thread it lives in** (#109, decision 8).
   * That thread sits under an *older* review, several screens up, which is
   * where a link earns its keep — and where `path:line` as plain text, which
   * GitHub does not linkify, left a reader to go and find it.
   */
  it("links a carried entry to the thread it was raised in", () => {
    const body = render({
      stillOpen: [
        {
          id: "f-1",
          threadId: "PRRT_one",
          url: "https://github.com/o/r/pull/12#discussion_r1",
          text: "src/a.ts:4 — the cache key omits the tenant",
        },
      ],
    });

    expect(body).toContain(
      "- [src/a.ts:4 — the cache key omits the tenant](https://github.com/o/r/pull/12#discussion_r1)",
    );
  });

  /**
   * And a **fresh** one carries none, which is a fact about GitHub rather than
   * a choice: its thread is opened by the same `addPullRequestReview` call that
   * posts this body, so there is no URL to write while the body is being
   * composed — and its thread renders directly beneath this review anyway.
   */
  it("leaves a fresh entry unlinked, since its thread does not exist yet", () => {
    expect(render({ placed: placedFinding() })).not.toContain("](http");
  });

  /**
   * The follow-ups are a **group** now, shaped like the others and placed with
   * them, rather than a block appended below the run link where it looked
   * unlike everything above it. Collapsed, because it is not what blocks this
   * pull request — and **not counted** on the `**Findings:**` line for the same
   * reason.
   */
  it("renders the follow-ups as a collapsed group after Resolved, uncounted", () => {
    const body = render({
      placed: placedFinding(),
      followUps: [followUp({ title: "Leak in parse()", location: "src/other.ts:88" })],
    });

    expect(body).toContain("<details>\n<summary><b>Follow-ups</b> — 1 ·");
    expect(body).toMatch(/remove <code>agent:follow-ups<\/code> to skip/);
    expect(body).toContain("- `Medium` **Leak in parse()** — `src/other.ts:88`");
    // Uncounted: the number is what blocks this pull request, and a follow-up
    // is by definition what does not.
    expect(body).toContain("**Findings:** 1");
    expect(body.indexOf("<summary><b>Open</b>")).toBeLessThan(
      body.indexOf("<summary><b>Follow-ups</b>"),
    );
  });

  /**
   * **The payload is untouched** — content, version and all — and goes out on
   * every review including the one that recorded nothing. The filing half reads
   * it on merge, and an empty list is how a round retracts an earlier round's.
   */
  it("carries the follow-ups payload unchanged, empty list included", () => {
    const list = [followUp({ title: "Leak in parse()", location: "src/other.ts:88" })];

    expect(parseFollowUpsBlock(render({ followUps: list, droppedFollowUps: 2 }))).toEqual({
      followUps: list,
      dropped: 2,
    });

    const empty = render();
    expect(empty).not.toContain("<summary><b>Follow-ups</b>");
    expect(hasFollowUpsBlock(empty)).toBe(true);
    expect(parseFollowUpsBlock(empty)).toEqual({ followUps: [], dropped: 0 });
  });

  /**
   * *How this was checked* is what tells a reader how much weight the review
   * carries, and it is on every one of them. Collapsed, because it is
   * supporting evidence rather than the answer.
   */
  it("folds how this was checked under the record, on every review", () => {
    const body = render({ output: output({ howChecked: "Ran the suite; traced `apply()`." }) });

    expect(body).toContain(
      "<details>\n<summary><b>How this was checked</b></summary>\n\nRan the suite; traced `apply()`.",
    );
    expect(body.indexOf("**Findings:**")).toBeLessThan(body.indexOf("How this was checked"));
  });

  /**
   * *What changed in this PR* is a sentence and up to five lines, and it is the
   * last thing in the body before the run — the description a reader wants once
   * they know what is owed, rather than the paragraph they had to read past.
   */
  it("folds what changed last, as a sentence over its bullets", () => {
    const body = render({
      output: output({
        howChecked: "Ran the suite.",
        whatChanged: { summary: "It moves thread resolution to the review.", changes: ["a", "b"] },
      }),
    });

    expect(body).toContain(
      "<details>\n<summary><b>What changed in this PR</b></summary>\n\nIt moves thread resolution to the review.\n\n- a\n- b",
    );
    expect(body.indexOf("How this was checked")).toBeLessThan(
      body.indexOf("What changed in this PR"),
    );
  });

  /**
   * And it is omitted where the caller says so — a round-2 verification pass,
   * or a re-review with nothing pushed since the last verdict. Describing the
   * change again, at the top, to a reader who was handed that description last
   * round is the body spending its opening on something already read.
   */
  it("omits what changed entirely when the round is not one that describes the change", () => {
    const whatChanged = { summary: "It moves thread resolution to the review.", changes: [] };
    const body = render({ output: output({ whatChanged }), showWhatChanged: false });

    expect(body).not.toContain("What changed in this PR");
    expect(body).not.toContain("It moves thread resolution to the review.");
  });

  /**
   * **One horizontal rule in the whole body, directly above the run link.** A
   * divider between the groups reads as a section break in a list that is one
   * record; this one is where the subject actually changes — everything above
   * is the review, and this is the run that posted it.
   */
  it("links the run under the body's only rule, and renders neither without one", () => {
    const body = render({
      placed: placedFinding(),
      followUps: [followUp()],
      output: output({ howChecked: "Ran the suite.", whatChanged: { summary: "x", changes: [] } }),
      runUrl: "https://github.com/o/r/actions/runs/7",
    });

    expect(body).toContain(
      "---\n\n_Posted by [this workflow run](https://github.com/o/r/actions/runs/7)._",
    );
    expect(body.split("\n").filter((line) => line.trim() === "---")).toHaveLength(1);
    expect(render()).not.toContain("workflow run");
    expect(render().split("\n")).not.toContain("---");
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
    placeFindings(output(over).findings, DIFF_LINES, () => "f-x").placed;
  const record = (over: Partial<ReviewOutput>) =>
    reviewRecord({ output: output(over), placed: place(over), stillOpen: [], resolved: [] });
  const body = (over: Partial<ReviewOutput>): string =>
    renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output: output(over),
      placed: place(over),
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [],
      followUps: [],
      droppedFollowUps: 0,
      showWhatChanged: true,
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

    expect(countFixBeforeMerge(output(missing), 0)).toBe(1);
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

    expect(body(short)).toContain("- the guard runs after the return");
    expect(body(short)).toContain("- the new test asserts the old behaviour");
    // Three: the finding, and both restatements, because which of the two it
    // restates is not knowable without matching prose. The count says three
    // too — the record and the count are one set, so the price of never losing
    // a finding is paid in both places or in neither.
    expect(countFixBeforeMerge(output(short), 0)).toBe(3);
    expect(record(short).findings).toBe(countFixBeforeMerge(output(short), 0));
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
 * **A finding is recorded and counted whatever its body opens with.**
 *
 * The label is presentation: by #96's decision 1 a finding is one of two kinds
 * and `followUps` is the other, so an entry in `findings` is fix-before-merge
 * by definition. A predicate over the label was a second definition of that,
 * and it disagreed with the first in the unsafe direction twice over.
 *
 * Past a changed file's **hunks** it got a file-level thread and nothing else:
 * the record listed it nowhere and the count did not see it, and the review
 * recommended approval over a populated *Open* group. On a **diff line** it got
 * a thread and an id and still reached no group and no count in the round that
 * raised it, then counted through `stillOpen` in every round after: a finding
 * that was not blocking when it was found and blocking for ever after, with no
 * code change between the two.
 *
 * Both halves are exercised on a file the pull request changes, which since
 * #127 is every finding there is: one with an anchor outside the diff is not a
 * finding with a weaker surface, it is a follow-up (decision 3), and the
 * describe below is where that is asserted.
 */
describe("a finding the record does not read a label on", () => {
  const output = (findings: Finding[]): ReviewOutput => ({
    findings,
    followUps: [],
    fixBeforeMerge: [],
    verified: [],
  });
  // One changed file with one line in a hunk: line 88 is past it, so the
  // unlabelled finding below gets a file-level thread.
  const CHANGED = new Map([["src/queue.ts", new Set([10])]]);
  const unlabelled = finding({
    path: "src/queue.ts",
    line: 88,
    title: "the cache key omits the tenant",
    body: "`key()` hashes the id and not the tenant.",
  });
  const place = (findings: Finding[]): PlacedFinding[] =>
    placeFindings(findings, CHANGED, () => "f-b").placed;

  it("is recorded even though it carries neither label", () => {
    const placed = place([unlabelled]);
    const record = reviewRecord({
      output: output([unlabelled]),
      placed,
      stillOpen: [],
      resolved: [],
    });

    expect(placed[0]?.placement).toBe("file");
    expect(record.open.map((entry) => entry.title)).toEqual(["the cache key omits the tenant"]);
  });

  it("is listed in the posted body and threaded, rather than posted nowhere", () => {
    const placed = place([unlabelled]);
    const body = renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output: output([unlabelled]),
      placed,
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [],
      followUps: [],
      droppedFollowUps: 0,
      showWhatChanged: true,
    });

    expect(body).toContain("the cache key omits the tenant");
    expect(reviewThreads(placed).map((t) => t.path)).toEqual(["src/queue.ts"]);
  });

  /** And it must not derive *approval recommended* over the group it is in. */
  it("counts in the round that raised it, rather than recommending approval over itself", () => {
    expect(countFixBeforeMerge(output([unlabelled]), 0)).toBe(1);
    expect(
      deriveVerdict(output([unlabelled]), { ci: "green", round: 1, stillOpen: 0, movedToFollowUps: 0 }).verdict,
    ).toBe("changes recommended");
  });

  /**
   * And the same finding on a **diff line**, which is the half the thread
   * disguises: it gets a thread and an id either way, so nothing about the
   * pull request looked wrong — the finding simply reached no group and no
   * count until the round *after* the one that raised it, when `stillOpen`
   * picked it up. Ran end to end, that read `approval recommended` and then
   * `changes recommended after a fix round` with no commit between them.
   */
  it("is recorded and counted in its first round when it got a thread of its own", () => {
    const threaded = finding({
      path: "src/queue.ts",
      line: 10,
      title: "a passing remark",
      body: "a passing remark",
    });
    const { placed } = placeFindings([threaded], CHANGED, () => "f-t");

    expect(placed[0]?.placement).toBe("line");
    expect(
      reviewRecord({ output: output([threaded]), placed, stillOpen: [], resolved: [] }).open.map(
        (entry) => entry.title,
      ),
    ).toEqual(["a passing remark"]);
    expect(countFixBeforeMerge(output([threaded]), 0)).toBe(1);
  });
});

/**
 * **The record and the count are one set, over every shape of review** — the
 * invariant the two failures above were each half of.
 *
 * Stated as arithmetic rather than as an example, because the ways they can
 * come apart are not enumerable by hand: any predicate either half reads and
 * the other does not reopens it, silently, and in whichever direction that
 * predicate happens to fall. The unsafe direction is a record longer than the
 * count — a body listing findings under a verdict saying there are none —
 * and the merely confusing one is a count longer than the record.
 *
 * Since #127 the shapes include a finding the diff gives no anchor to, which is
 * in neither: it is subtracted from the count and never enters the record, and
 * a caller that passed `movedToFollowUps: 0` would fail here by arithmetic
 * rather than by anybody having to notice the body was short an entry.
 */
describe("the record's size is the count the verdict was given", () => {
  const LINE = new Map([["src/queue.ts", new Set([10])]]);
  const at = (over: Partial<Finding>): Finding =>
    finding({ path: "src/queue.ts", line: 10, ...over });

  const SHAPES: readonly (readonly [string, Partial<ReviewOutput>])[] = [
    ["nothing found", {}],
    ["one labelled finding", { findings: [at({ body: "**Fix before merge.** x" })] }],
    ["one unlabelled finding on a diff line", { findings: [at({ body: "a passing remark" })] }],
    [
      "one finding the diff gives no anchor to, which is moved to follow-ups",
      { findings: [at({ path: "src/other.ts", line: 88, body: "a passing remark" })] },
    ],
    [
      "a finding moved to follow-ups beside one that stayed",
      {
        findings: [
          at({ body: "**Fix before merge.** x" }),
          at({ path: "src/other.ts", line: 88, body: "**Fix before merge.** y" }),
        ],
      },
    ],
    [
      "one previously missed finding",
      { findings: [at({ body: "**Previously missed.** x" })] },
    ],
    [
      "a labelled one, a missed one and an unanchored one",
      {
        findings: [
          at({ body: "**Fix before merge.** x" }),
          at({ body: "**Previously missed.** y" }),
          at({ path: "src/other.ts", line: 88, body: "z" }),
        ],
      },
    ],
    ["the list alone, with no findings", { fixBeforeMerge: ["a", "b"] }],
    [
      "a list longer than the findings",
      { fixBeforeMerge: ["a", "b"], findings: [at({ body: "**Fix before merge.** x" })] },
    ],
    [
      "a list the findings account for",
      { fixBeforeMerge: ["x"], findings: [at({ body: "**Fix before merge.** x" })] },
    ],
  ];

  const CARRIED: readonly (readonly [string, CarriedFinding[]])[] = [
    ["nothing carried", []],
    ["one carried finding still open", [{ id: "f-1", threadId: "PRRT_one", text: "an earlier one" }]],
    [
      "two carried findings still open",
      [
        { id: "f-1", threadId: "PRRT_one", text: "an earlier one" },
        { id: "f-2", text: "an earlier one with no thread" },
      ],
    ],
  ];

  const cases = SHAPES.flatMap(([shape, over]) =>
    CARRIED.map(([carried, stillOpen]) => [`${shape}, ${carried}`, over, stillOpen] as const),
  );

  it.each(cases)("%s", (_case, over, stillOpen) => {
    const reviewed: ReviewOutput = {
      findings: [],
      followUps: [],
      fixBeforeMerge: [],
      verified: [],
      ...over,
    };
    const { placed, unanchored } = placeFindings(reviewed.findings, LINE, () => "f-x");
    const record = reviewRecord({ output: reviewed, placed, stillOpen, resolved: [] });
    const counted = countFixBeforeMerge(reviewed, unanchored.length) + stillOpen.length;

    expect(record.open.length + record.missed.length).toBe(counted);
    expect(record.findings).toBe(counted);
    // And the verdict is the same question asked once: nothing is open exactly
    // when the record is empty.
    expect(
      deriveVerdict(reviewed, {
        ci: "green",
        round: 1,
        stillOpen: stillOpen.length,
        movedToFollowUps: unanchored.length,
      }).verdict === "approval recommended",
    ).toBe(record.findings === 0);
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
        stillOpen: 0, movedToFollowUps: 0 });

      for (const severities of assignments) {
        expect(deriveVerdict(reviewed(severities), { ci, round: 1, stillOpen: 0, movedToFollowUps: 0 }), severities.join()).toEqual(
          baseline,
        );
      }
    },
  );

  it("counts the same findings however they are rated", () => {
    for (const severities of assignments) {
      expect(countFixBeforeMerge(reviewed(severities), 0), severities.join()).toBe(3);
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
 * Every finding reaches the pull request, and the verdict counts the ones it
 * blocks on — the two halves of #110 and #127 that a placement decision could
 * quietly break.
 *
 * What #110 replaced dropped a finding whose anchor GitHub would reject, which
 * made the count and the record disagree in the one direction that matters: a
 * verdict saying *changes recommended* over a review showing nothing to change.
 * What #127 replaced posted a finding in an untouched file into the body, where
 * a maintainer had no thread to answer, decline or resolve it on — so one of
 * them could hold a pull request at *Changes recommended* for ever (#124).
 *
 * The property under test is therefore not "the line threads are right". It is
 * that **every finding leaves by one of exactly two doors** — a thread it
 * counts on, or a follow-up it does not — and that the body says which.
 */
describe("every finding leaves by a thread or by the follow-ups", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
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
    body: "**Fix before merge.** `key()` hashes the id and not the tenant.",
  });

  const findings = [ON_A_LINE, PAST_THE_HUNKS, IN_AN_UNTOUCHED_FILE];
  const { placed, unanchored } = placeFindings(findings, DIFF_LINES);
  const followUps = withMovedFindings(unanchored, []);
  const reviewed = output({ findings, followUps });
  const render = (): string =>
    renderReviewBody({
      verdict: deriveVerdict(reviewed, {
        ci: "green",
        round: 1,
        stillOpen: 0,
        movedToFollowUps: unanchored.length,
      }),
      output: reviewed,
      placed,
      movedToFollowUps: unanchored.length,
      stillOpen: [],
      resolved: [],
      followUps,
      droppedFollowUps: 0,
      showWhatChanged: true,
    });

  it("threads the two the diff reaches and moves the one it does not", () => {
    expect(placed.map((p) => p.placement)).toEqual(["line", "file"]);
    expect(unanchored).toEqual([IN_AN_UNTOUCHED_FILE]);
  });

  it("opens a thread for every finding it placed", () => {
    const posted = reviewThreads(placed).map((t) => t.body).join("\n");

    for (const f of [ON_A_LINE, PAST_THE_HUNKS]) expect(posted).toContain(f.title);
    expect(posted).not.toContain(IN_AN_UNTOUCHED_FILE.title);
  });

  /**
   * And the moved one keeps its evidence and its anchor. A follow-up is filed
   * as an issue once the pull request merges, and one that arrived as a
   * one-line claim would be a stub nobody can check — which is #126, on the
   * surface that outlives the pull request.
   */
  it("records the moved finding as a follow-up, whole, and says how it got there", () => {
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({
      title: "the cache key omits the tenant",
      location: "src/other.ts:88",
      severity: "medium",
    });
    expect(followUps[0]?.body).toContain("`key()` hashes the id and not the tenant.");
    expect(followUps[0]?.body).toContain("no file that pull request changed");
    // And no issue number: a stub is filed in the adopter's tracker, where a
    // cross-reference to this one's is a link to somebody else's issue.
    expect(followUps[0]?.body).not.toMatch(/#\d+/);
  });

  /** The two it threaded count; the one it moved does not, because it is a follow-up now. */
  it("counts what it threaded and not what it moved", () => {
    expect(countFixBeforeMerge(reviewed, unanchored.length)).toBe(2);
    expect(render()).toContain("**Findings:** 2");
  });

  /**
   * **And the body says so.** The moved finding is not in *Open*, is not in the
   * count, and the entry that does appear is folded under *Follow-ups* looking
   * like something nobody meant to block on — so a record that said nothing
   * would be demoting a blocker in silence.
   */
  it("says in the body that a finding was moved, and why", () => {
    const posted = render();

    expect(posted).toContain("1 finding was moved to follow-ups");
    expect(posted).toContain("in no file this pull request changes");
    // Under the count, which is the line it qualifies.
    expect(posted.indexOf("**Findings:** 2")).toBeLessThan(
      posted.indexOf("moved to follow-ups"),
    );
  });

  it("says nothing about moving where it moved nothing", () => {
    const kept = output({ findings: [ON_A_LINE] });
    const body = renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output: kept,
      placed: placeFindings(kept.findings, DIFF_LINES).placed,
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [],
      followUps: [],
      droppedFollowUps: 0,
      showWhatChanged: true,
    });

    expect(body).not.toContain("moved to follow-ups");
  });

  /**
   * The case the count decides on its own: a review whose only finding has no
   * anchor in the diff has found nothing this pull request must fix before it
   * merges, so it recommends approval — with the finding recorded and filed
   * rather than lost.
   */
  it("recommends approval over a review whose only finding was moved", () => {
    const only = output({ findings: [IN_AN_UNTOUCHED_FILE] });
    const moved = placeFindings(only.findings, DIFF_LINES);

    expect(moved.placed).toEqual([]);
    expect(countFixBeforeMerge(only, moved.unanchored.length)).toBe(0);
    expect(
      deriveVerdict(only, {
        ci: "green",
        round: 1,
        stillOpen: 0,
        movedToFollowUps: moved.unanchored.length,
      }).verdict,
    ).toBe("approval recommended");
  });

  /** Each thread carries the id the workflow wrote for it. */
  it("gives every posted finding an id a later round can read back", () => {
    const posted = [...reviewThreads(placed).map((t) => t.body), render()].join("\n");

    expect(new Set(placed.map((p) => p.id)).size).toBe(2);
    for (const p of placed) expect(posted).toContain(findingMarker(p.id, p.finding.severity));
  });
});

describe("the review's finding vocabulary", () => {
  const PROMPT = fs.readFileSync(path.join("review", "prompt.md"), "utf8");
  const EXTRACTION = fs.readFileSync(path.join("review", "extraction.md"), "utf8");
  const halves = [
    ["prompt.md", PROMPT],
    ["extraction.md", EXTRACTION],
  ] as const;
  /**
   * The brief without its emphasis or its wrapping, for a test about what it
   * *says*: `do **not** write it up again` is the same instruction as `do not
   * write it up again`, and a test that could tell them apart would fail on a
   * reword that changed nothing.
   */
  const plain = (text: string): string => text.replace(/[*_]/g, "").replace(/\s+/g, " ");

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

  /**
   * **A finding is never restated in the prose**, and this is the guard on the
   * instruction rather than on the output.
   *
   * The two halves said opposite things for a release: line 118 of the brief
   * said the summary is posted under *What changed in this PR* and must not
   * enumerate the findings, while three other lines told the model to label
   * each finding "in the summary". A model given both does both — #122's body
   * was a checklist and then every finding again as a paragraph — and nothing
   * downstream could tell.
   *
   * Pinned on the phrasing that caused it: the label named beside the place it
   * is written. A brief that starts saying "in the summary" again fails here
   * rather than on somebody's pull request.
   */
  it.each(halves)("%s never tells the model to put a finding in the summary", (_half, text) => {
    for (const line of text.split("\n")) {
      if (!/fix before merge/i.test(line)) continue;
      expect(line.toLowerCase(), line).not.toContain("in the summary");
    }
    expect(text.toLowerCase()).not.toContain("the summary and the finding");
  });

  /**
   * And the field that paragraph became. Two of them, because one 250-word
   * `summary` mixed what the change is with what the reviewer verified — and
   * the assessment sentence is a third, which is what the heading cannot say.
   */
  it.each(halves)("%s asks for the three prose fields by name", (_half, text) => {
    for (const field of ["assessment", "howChecked", "whatChanged"]) {
      expect(text, field).toContain(field);
    }
  });

  /**
   * **Ruling a carried finding `open` is the whole of reporting it.** The
   * brief forbade restating it in `fixBeforeMerge` and said nothing about
   * `findings`, which is where the rest of it says every finding goes — and
   * nothing dedupes, by design: ids are the workflow's and text is never
   * matched. So a re-raise mints a second thread, a second id and a second
   * entry in the count, carried separately every round after.
   */
  it.each(halves)("%s forbids writing an open carried finding up again", (_half, text) => {
    expect(plain(text)).toMatch(/not (?:also )?(?:write it up again|restate it)/i);
    // Both lists named together, so the instruction cannot be read as covering
    // one of them — `fixBeforeMerge` was the only one it named.
    expect(plain(text)).toMatch(
      /(fixBeforeMerge[^.]{0,160}`findings`|`findings`[^.]{0,160}fixBeforeMerge)/,
    );
  });

  /**
   * **Anchored at the change that causes it** (#127, decision 2).
   *
   * The brief is the half that makes the workflow's half worth having. The
   * workflow can only ever ask *is this anchor in the diff* — so a model told
   * nothing would keep pointing at the file it read the problem in, and every
   * such finding would land in `followUps` correctly and uselessly. What turns
   * a demotion into an anchored, threaded, maintainer-answerable finding is the
   * model knowing there is always a changed line to point at, and which one.
   */
  it.each(halves)("%s says to anchor an untouched file's problem at its cause", (_half, text) => {
    expect(plain(text)).toMatch(/anchored at (?:\*\*)?the change that causes it/i);
  });

  /** With the untouched location named in the text, or a reader cannot follow it. */
  it.each(halves)("%s carries the worked example, naming the untouched path:line", (_half, text) => {
    expect(text).toContain("src/api.ts:42");
    expect(text).toContain("docs/api.md:18");
  });

  /**
   * And the other arm, which is the one that decides what the workflow then
   * does: no cause in the diff means it was never this pull request's to fix.
   */
  it.each(halves)("%s sends a finding with no cause in the diff to followUps", (_half, text) => {
    expect(text).toContain("followUps");
    expect(plain(text)).toMatch(/moved to `?followUps`?/i);
  });

  /**
   * And **no half of the brief offers the review body as a place to put a
   * finding.** It was the third placement for two releases; a sentence left
   * behind would have the model writing anchors it believes will be listed
   * rather than threaded, and choosing them accordingly.
   */
  it.each(halves)("%s offers no body placement", (_half, text) => {
    expect(plain(text).toLowerCase()).not.toContain("in the review body");
  });

  /**
   * And that a decline rests on the maintainer's **latest** reply, which is the
   * only comment the workflow quotes when it closes. Without the rule the
   * review can read one comment and the thread can close under another's
   * words — including one that reversed the refusal.
   */
  it.each(halves)("%s rules a decline on the maintainer's latest reply", (_half, text) => {
    expect(plain(text)).toMatch(/latest reply/i);
  });

  it("names needsYou and the three cases it is for", () => {
    expect(PROMPT).toContain("needsYou");
    expect(EXTRACTION).toContain("needsYou");
    expect(PROMPT).toContain("the wrong thing was built");
    expect(PROMPT).toContain("the issue itself was wrong");
    expect(PROMPT).toMatch(/cannot say why/);
  });
});

/**
 * **The body entries v0.4.0 already wrote are carried until they close** (#127,
 * decision 5).
 *
 * Nothing creates one any more, so the temptation is to delete the machinery
 * with the feature. What that would do is silently drop a *fix before merge*
 * finding off every pull request that was open at the upgrade: the entry is the
 * only record it exists, so a version that stopped reading it would post a body
 * with nothing about it and a verdict counting nothing for it, and the finding
 * would end as though a review had settled it.
 *
 * Kept deliberately simple, which is the other half of the decision: these are
 * rare and this only has to cover the pull requests open at one upgrade. So the
 * test is the round trip a real one takes — read out of the v0.4.0 body, ruled
 * on, and closed — rather than a re-implementation of the release that wrote it.
 */
describe("a body entry from a v0.4.0 review", () => {
  const output: ReviewOutput = {
    findings: [],
    followUps: [],
    fixBeforeMerge: [],
    verified: [],
  };
  const carried = carriedFindings({ threads: [], latestReviewBody: LEGACY_V040_BODY });

  it("is read back out of that body as a carried finding, with its rating", () => {
    expect(carried).toEqual([
      {
        id: "f-legacy",
        severity: "high",
        // The line as the v0.4.0 body wrote it. The decorations come off at
        // render time (`carriedClaim`), not here, which is what stops the entry
        // collecting a second badge every round it survives.
        text: "`High` the cache key omits the tenant — `src/other.ts:88` *new*",
      },
    ]);
  });

  /**
   * Still open, and still counting. It has no thread, so this body is the only
   * thing keeping it alive — which is why the entry carries its id again.
   */
  it("is re-listed with its id where the review leaves it open", () => {
    const { stillOpen, resolved } = verifyCarried(carried, [
      { id: "f-legacy", status: "open", note: "The key still omits the tenant." },
    ]);
    const body = renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output,
      placed: [],
      movedToFollowUps: 0,
      stillOpen,
      resolved,
      followUps: [],
      droppedFollowUps: 0,
      showWhatChanged: true,
    });

    expect(body).toContain("**Findings:** 1");
    expect(body).toContain(findingMarker("f-legacy", "high"));
    expect(carriedFindings({ threads: [], latestReviewBody: body }).map((f) => f.id)).toEqual([
      "f-legacy",
    ]);
  });

  /**
   * And it **closes** when a review rules it landed: there is no thread to
   * resolve, so what closes it is the next body not naming it — which is the
   * only way a body entry could ever close, and the reason #124 called it a
   * finding a maintainer could not settle.
   */
  it("closes when a review rules it landed, by dropping out of the next body", () => {
    const { resolutions, stillOpen, resolved } = verifyCarried(carried, [
      { id: "f-legacy", status: "landed", note: "`key()` now hashes the tenant too." },
    ]);
    const body = renderReviewBody({
      verdict: VERDICTS["approval recommended"],
      output,
      placed: [],
      movedToFollowUps: 0,
      stillOpen,
      resolved,
      followUps: [],
      droppedFollowUps: 0,
      showWhatChanged: true,
    });

    // Nothing to resolve on GitHub, and nothing left owed.
    expect(resolutions).toEqual([]);
    expect(stillOpen).toEqual([]);
    expect(resolved.map((f) => f.id)).toEqual(["f-legacy"]);

    // It is in the record as closed, and its id is not — so the round after
    // this one is handed nothing to rule on.
    expect(body).toContain("<summary><b>Resolved since last review</b> — 1</summary>");
    expect(body).toContain("the cache key omits the tenant");
    expect(body).not.toContain("f-legacy");
    expect(carriedFindings({ threads: [], latestReviewBody: body })).toEqual([]);
  });
});
