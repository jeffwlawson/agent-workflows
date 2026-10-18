import { describe, expect, it } from "vitest";
import { renderPullRequestFrame } from "../shared/pr-frame.js";

/**
 * The frame a single-issue pull request opens with (#218), held to the text
 * `implement.yml`'s *Open draft PR* heredoc wrote before `implement:publish`
 * (#492), byte for byte, written out here rather than built from the
 * renderer's own constants, so a change to a marker or the status line shows.
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
});
