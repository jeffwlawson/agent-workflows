import { OPENING_STATUS, statusBlock } from "./progress-list.js";
import { closesBlock, DRAFT_NOTE_END, DRAFT_NOTE_START, SUMMARY_END, SUMMARY_START } from "./record.js";

/** What the summary block holds until the first review writes one. */
export const SUMMARY_PLACEHOLDER = "_The review will summarize this change here after its first pass._";

/** What a PRD PR's summary block holds until its final review writes one. */
export const PRD_SUMMARY_PLACEHOLDER = "_The final review will summarize the whole PRD here._";

/** A single issue's pull request: the issue it closes, and the run that opened it. */
export interface IssueFrame {
  readonly issue: number;
  readonly runUrl: string;
}

/**
 * A PRD PR (#222): the parent, its sub-issues still open, which the `Closes`
 * block names, and the status line and progress table it opens with, both
 * rendered by `shared/progress-list.ts`, the status line between its markers.
 */
export interface PrdFrame {
  readonly prd: number;
  readonly open: readonly number[];
  readonly status: string;
  readonly progress: string;
}

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
 * (#492), trailing newline included.
 *
 * **A PRD PR's** (#503) is the same frame with a PRD's parts, byte for byte
 * what `implement-prd.yml`'s heredoc wrote before `implement-prd:publish`:
 * the note opens with the status line the chain is at, and its text past it
 * opens with the **draft-only** part between its own markers, which the final
 * review's write of the summary removes (#247); no run link, since each
 * sub-issue carries its run's. The summary is the final review's. Then a
 * second rule, as outside every marker pair as the first, the progress table,
 * and the `Closes` block naming the parent and every sub-issue still open, in
 * place of the one `Closes` line.
 */
export const renderPullRequestFrame = (frame: IssueFrame | PrdFrame): string => ("prd" in frame ? prdFrame(frame) : issueFrame(frame));

const issueFrame = (frame: IssueFrame): string =>
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

const prdFrame = (frame: PrdFrame): string =>
  [
    "> [!NOTE]",
    `> ${frame.status}`,
    ">",
    `> ${DRAFT_NOTE_START}The agent loop builds PRD #${frame.prd} here, one sub-issue at a time, and reviews each on this PR before starting the next. It stays a draft until every slice is done. Don't merge it before then.${DRAFT_NOTE_END} Built by the agent loop from PRD #${frame.prd}, one sub-issue per slice. Comment here to steer it; your notes outside the loop's blocks are never edited.`,
    "",
    "---",
    "",
    "## Summary",
    "",
    SUMMARY_START,
    PRD_SUMMARY_PLACEHOLDER,
    SUMMARY_END,
    "",
    "---",
    "",
    frame.progress,
    "",
    closesBlock(frame.prd, frame.open),
    "",
  ].join("\n");
