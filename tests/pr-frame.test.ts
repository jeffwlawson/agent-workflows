import { describe, expect, it } from "vitest";
import { renderPullRequestFrame } from "../shared/pr-frame.js";

/**
 * The frame a pull request opens with (#218), held to the text the heredoc it
 * replaced wrote, byte for byte, written out here rather than built from the
 * renderer's own constants, so a change to a marker or the status line shows:
 * a single issue's, `implement.yml`'s *Open draft PR*, before
 * `implement:publish` (#492), and a PRD PR's, `implement-prd.yml`'s *Open or
 * reuse the PRD PR*, before `implement-prd:publish` (#503).
 */
describe("the pull request frame", () => {
  it("is the note with its status line, the run link and the steering sentence, a rule, the summary, then Closes", () => {
    expect(renderPullRequestFrame({ issue: 123, runUrl: "https://github.com/o/r/actions/runs/9" })).toBe(
      [
        "> [!NOTE]",
        "> <!-- agent:status -->",
        "> **🔍 In review:** waiting for its first review.",
        "> <!-- /agent:status -->",
        ">",
        "> Opened by the agent loop from #123 ([Workflow run](https://github.com/o/r/actions/runs/9)). Comment here to steer it; your notes outside the loop's blocks are never edited.",
        "",
        "---",
        "",
        "## Summary",
        "",
        "<!-- agent:summary -->",
        "_The review will summarize this change here after its first pass._",
        "<!-- /agent:summary -->",
        "",
        "Closes #123",
        "",
      ].join("\n"),
    );
  });

  /** #353: without the blank line above it, GitHub reads the line before `---` as a setext heading. */
  it("puts a blank line above the rule, outside every marker pair", () => {
    const lines = renderPullRequestFrame({ issue: 1, runUrl: "u" }).split("\n");
    const rule = lines.indexOf("---");

    expect(lines[rule - 1]).toBe("");
    expect(lines.slice(0, rule).join("\n")).toContain("<!-- /agent:status -->");
    expect(lines.slice(rule).join("\n")).toContain("<!-- agent:summary -->");
  });

  /**
   * A PRD PR's (#503), held to the text `implement-prd.yml`'s *Open or reuse
   * the PRD PR* heredoc wrote before `implement-prd:publish`, byte for byte,
   * the status line and the progress list being what the renderer is handed.
   */
  it("is, on a PRD PR, the note with its status line and draft note, a rule, the summary, a rule, the progress list, then the Closes block", () => {
    const status = "<!-- agent:status -->\n> **🔍 Reviewing slice 1 of 2** · #15\n> <!-- /agent:status -->";
    const progress = "<!-- agent:progress -->\n## Progress\n<!-- /agent:progress -->";

    expect(renderPullRequestFrame({ prd: 14, open: [15, 16], status, progress })).toBe(
      [
        "> [!NOTE]",
        "> <!-- agent:status -->",
        "> **🔍 Reviewing slice 1 of 2** · #15",
        "> <!-- /agent:status -->",
        ">",
        "> <!-- agent:draft-note -->The agent loop builds PRD #14 here, one sub-issue at a time, and reviews each on this PR before starting the next. It stays a draft until every slice is done. Don't merge it before then.<!-- /agent:draft-note --> Built by the agent loop from PRD #14, one sub-issue per slice. Comment here to steer it; your notes outside the loop's blocks are never edited.",
        "",
        "---",
        "",
        "## Summary",
        "",
        "<!-- agent:summary -->",
        "_The final review will summarize the whole PRD here._",
        "<!-- /agent:summary -->",
        "",
        "---",
        "",
        "<!-- agent:progress -->",
        "## Progress",
        "<!-- /agent:progress -->",
        "",
        "<!-- agent:closes -->",
        "Closes #14, closes #15, closes #16",
        "<!-- /agent:closes -->",
        "",
      ].join("\n"),
    );
  });

  it("closes only the parent on a PRD PR whose every sub-issue is closed", () => {
    expect(renderPullRequestFrame({ prd: 14, open: [], status: "s", progress: "p" })).toContain(
      "\n<!-- agent:closes -->\nCloses #14\n<!-- /agent:closes -->\n",
    );
  });

  /** #353, on both of a PRD PR's rules. */
  it("puts a blank line above and below each of a PRD PR's rules, outside every marker pair", () => {
    const lines = renderPullRequestFrame({ prd: 1, open: [2], status: "<!-- agent:status -->\n> s\n> <!-- /agent:status -->", progress: "p" }).split("\n");
    const rules = lines.flatMap((line, i) => (line === "---" ? [i] : []));

    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(lines[rule - 1]).toBe("");
      expect(lines[rule + 1]).toBe("");
    }
    const [first = 0, second = 0] = rules;
    expect(lines.slice(0, first).join("\n")).toContain("<!-- /agent:draft-note -->");
    expect(lines.slice(first, second).join("\n")).toContain("<!-- /agent:summary -->");
    expect(lines.slice(second).join("\n")).not.toContain("<!-- agent:summary -->");
  });
});
