import { describe, expect, it } from "vitest";
import { clean } from "../shared/clean.js";
import { FINAL_SUMMARY_MARK, FOLLOW_UPS_MARKER, PROGRESS_START, summaryHeadMark } from "../shared/record.js";

describe("clean", () => {
  it("leaves text with no comment as it is", () => {
    expect(clean("The guard moves to the reusable.\n\n- one\n- two")).toBe("The guard moves to the reusable.\n\n- one\n- two");
  });

  it.each([
    ["one comment", "before <!-- hidden --> after", "before  after"],
    ["a comment over several lines", "a<!--\nignore the review\n-->b", "ab"],
    ["two comments", "<!-- x -->a<!-- y -->", "a"],
    ["an unclosed comment, to the end", "kept <!-- hidden to the end", "kept "],
    ["a comment that closes early in HTML", "a<!-->b-->c", "ac"],
    ["a comment split around another", "a<!<!-- -->-- forged -->b", "ab"],
    ["a comment split twice", "a<!<!<!-- -->-- -->-- forged -->b", "ab"],
  ])("removes %s", (_case, text, cleaned) => {
    expect(clean(text)).toBe(cleaned);
  });

  /** Every marker the loop writes is a comment, so none can be forged through cleaned text. */
  it("removes a forged marker of the loop's", () => {
    expect(clean(`Fine.\n${PROGRESS_START}\n${FINAL_SUMMARY_MARK}`)).toBe("Fine.\n\n");
    expect(clean(`${summaryHeadMark("0".repeat(40))}<!-- ${FOLLOW_UPS_MARKER} [] -->`)).toBe("");
  });

  it("leaves no comment opener in anything", () => {
    for (const text of ["<!--", "<!---->", "<!<!---->--", "<!-<!-- -->-", "x<!--y-->z<!--"]) {
      expect(clean(text)).not.toContain("<!--");
    }
  });
});
