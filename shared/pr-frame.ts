import { OPENING_STATUS, statusBlock } from "./progress-list.js";
import { SUMMARY_END, SUMMARY_START } from "./record.js";

/** What the summary block holds until the first review writes one. */
export const SUMMARY_PLACEHOLDER = "_The review will summarize this change here after its first pass._";

/**
 * **The frame** a pull request opens with (#218), written once by the run
 * that opens it and never rewritten, in the order #298 settled: a note on
 * what the loop does with the pull request and how to steer it, linking the
 * run and opening with the status line between its own markers, which every
 * review rewrites; a `---` rule, outside every marker pair and with a blank
 * line above it, without which GitHub reads the line above as a setext
 * heading (#353); `## Summary` and the summary block the review writes and
 * keeps current; and `Closes #N` at the bottom, where GitHub reads it as well
 * as at the top. The review owns the two blocks and nothing else, so a
 * maintainer's notes outside them survive every round.
 *
 * Byte for byte what `implement.yml`'s heredoc wrote before `implement:publish`
 * (#492), trailing newline included. `implement-prd` adopts it in #477.
 */
export const renderPullRequestFrame = (frame: { readonly issue: number; readonly runUrl: string }): string =>
  [
    "> [!NOTE]",
    `> ${statusBlock(OPENING_STATUS)}`,
    ">",
    `> Opened by the agent loop from #${frame.issue} ([Workflow run](${frame.runUrl})). Comment here to steer it; your notes outside the loop's blocks are never edited.`,
    "",
    "---",
    "",
    "## Summary",
    "",
    SUMMARY_START,
    SUMMARY_PLACEHOLDER,
    SUMMARY_END,
    "",
    `Closes #${frame.issue}`,
    "",
  ].join("\n");
