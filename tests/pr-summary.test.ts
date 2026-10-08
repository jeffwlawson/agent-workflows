import { describe, expect, it } from "vitest";
import { currentSummary, readSummaryBlock, summaryDue, summaryUpdate } from "../shared/pr-summary.js";
import { DRAFT_NOTE_END, DRAFT_NOTE_START, FINAL_SUMMARY_MARK, SUMMARY_END, SUMMARY_START } from "../shared/record.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

const body = (inner: string, before = "Closes #12\n\n", after = "\n\nMy own notes.") =>
  `${before}${SUMMARY_START}\n${inner}\n${SUMMARY_END}${after}`;

describe("readSummaryBlock", () => {
  it("reads the frame's placeholder as a block no review has written", () => {
    expect(readSummaryBlock(body("_The review will summarize this change here after its first pass._"))).toEqual({
      text: "_The review will summarize this change here after its first pass._",
      final: false,
    });
  });

  it("reads a written block's text and the head it was written at", () => {
    expect(readSummaryBlock(body(`<!-- agent:summary-head ${HEAD} -->\nIt moves the guard.`))).toEqual({
      text: "It moves the guard.",
      head: HEAD,
      final: false,
    });
  });

  /**
   * One start marker with one end marker after it is a block. Anything else is
   * not one this file will say what is inside of, and the posting job holds the
   * same rule, so the two never disagree about which text is the review's.
   */
  it.each([
    ["no markers", "Closes #12"],
    ["a start with no end", `Closes #12\n${SUMMARY_START}\ntext`],
    ["an end with no start", `Closes #12\ntext\n${SUMMARY_END}`],
    ["the end before the start", `${SUMMARY_END}\ntext\n${SUMMARY_START}`],
    ["two blocks", `${body("a")}\n${body("b")}`],
  ])("is not a block: %s", (_case, text) => {
    expect(readSummaryBlock(text)).toBeUndefined();
  });
});

/**
 * The update rule (#218): anything pushed since the summary was last written
 * rewrites it, and nothing pushed leaves it alone.
 */
describe("summaryDue", () => {
  it("is due on the first review, over the frame's placeholder", () => {
    expect(summaryDue(body("_placeholder_"), HEAD)).toBe(true);
  });

  it("is not due where the summary was written at the head being reviewed", () => {
    expect(summaryDue(body(`<!-- agent:summary-head ${HEAD} -->\nText.`), HEAD)).toBe(false);
  });

  it("is due where anything was pushed since: a fix round, a maintainer's push, a resolution", () => {
    expect(summaryDue(body(`<!-- agent:summary-head ${OTHER} -->\nText.`), HEAD)).toBe(true);
  });

  /**
   * A maintainer who edited inside the block and left the head mark has
   * changed nothing about the rule: the edit stands until something is pushed,
   * and is then the input the next summary starts from.
   */
  it("is not due over a maintainer's edit with nothing pushed", () => {
    expect(summaryDue(body(`<!-- agent:summary-head ${HEAD} -->\nTheir own words.`), HEAD)).toBe(false);
  });

  it("is due where the body has no block, so the title is still written", () => {
    expect(summaryDue("Closes #12", HEAD)).toBe(true);
    expect(summaryDue("", HEAD)).toBe(true);
  });
});

describe("currentSummary", () => {
  it("hands the agent the block's words, without the head mark", () => {
    expect(currentSummary(body(`<!-- agent:summary-head ${HEAD} -->\nTheir own words.`))).toBe(
      "Their own words.",
    );
  });

  it("says so where there is no block, or nothing in it", () => {
    expect(currentSummary("Closes #12")).toContain("no summary block");
    expect(currentSummary(body(""))).toBe("(empty)");
  });
});

describe("summaryUpdate", () => {
  it("hands the posting job the title, and the block's markers with what goes between them", () => {
    expect(summaryUpdate({ title: "feat: x", summary: "It does x." }, HEAD)).toEqual({
      title: "feat: x",
      summary: {
        start: SUMMARY_START,
        end: SUMMARY_END,
        inner: `<!-- agent:summary-head ${HEAD} -->\nIt does x.`,
      },
    });
  });

  it("carries only the half the review wrote, and nothing where it wrote neither", () => {
    expect(summaryUpdate({ title: "feat: x" }, HEAD)).toEqual({ title: "feat: x" });
    expect(summaryUpdate({ summary: "It does x." }, HEAD)?.title).toBeUndefined();
    expect(summaryUpdate({}, HEAD)).toBeUndefined();
  });

  /** What it writes is what the next review reads back as written at this head. */
  it("writes a block the next review reads as written at this head", () => {
    const inner = summaryUpdate({ summary: "It does x." }, HEAD)?.summary?.inner ?? "";
    expect(summaryDue(body(inner), HEAD)).toBe(false);
    expect(readSummaryBlock(body(inner))?.text).toBe("It does x.");
  });
});

/**
 * **The final review writes the PRD PR's title and summary** (#247, #216),
 * however little was pushed: the last slice round wrote the block at the very
 * head the final review reads, about one slice, and the head alone would leave
 * the title the PRD issue's, copied, and the summary that one slice's.
 */
describe("the final review's summary", () => {
  const sliceRound = body(`<!-- agent:summary-head ${HEAD} -->\nWhat slice 3 did.`);

  it("is due to the final review over a block a slice round wrote at the same head", () => {
    expect(summaryDue(sliceRound, HEAD)).toBe(false);
    expect(summaryDue(sliceRound, HEAD, true)).toBe(true);
  });

  it("is not due again to a later final review with nothing pushed", () => {
    const inner = summaryUpdate({ title: "feat: the PRD", summary: "The PRD." }, HEAD, true)?.summary?.inner ?? "";

    expect(inner).toContain(FINAL_SUMMARY_MARK);
    expect(summaryDue(body(inner), HEAD, true)).toBe(false);
    expect(summaryDue(body(inner), OTHER, true)).toBe(true);
    expect(readSummaryBlock(body(inner))).toEqual({ text: "The PRD.", head: HEAD, final: true });
    expect(currentSummary(body(inner))).toBe("The PRD.");
  });

  it("asks the posting job to remove the draft-only note, and only on the final review", () => {
    expect(summaryUpdate({ title: "feat: the PRD" }, HEAD, true)).toEqual({
      title: "feat: the PRD",
      drop: { start: DRAFT_NOTE_START, end: DRAFT_NOTE_END },
    });
    expect(summaryUpdate({ title: "feat: x" }, HEAD)).toEqual({ title: "feat: x" });
  });
});
