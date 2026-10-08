/**
 * The record strings: what the loop writes on GitHub for a later run to read
 * back, as `docs/platform-spec.md` §4 lists them. Markers, status contexts,
 * labels and trailers, each spelled once, here.
 *
 * **This module imports nothing**, and `tests/agent-cli.test.ts` holds it to
 * that. A command names these strings to write them, and whatever a command
 * imports is loaded beside the loop's write token (ADR 0004): a string kept in
 * a module that reaches the agent driver would bring the agent SDK with it.
 * The formatters and readers built on these stay with the code they serve; a
 * function here only spells a marker.
 *
 * Every value is record: changing one is a change to §4 in the same commit,
 * and makes the runs on either side of the release unable to read each other.
 */

// Headings and markers in posts.

/**
 * The fixed heading the body opens with.
 *
 * Every agent in the loop posts as `github-actions[bot]`, so in the timeline a
 * review overview and a fix run's thread replies look like the same author
 * saying more things. A heading marks the one to read, and this wording matches
 * the `agent-review` status and the `agent:review` label — the way Copilot's
 * overview opens with "Copilot review overview".
 *
 * Level 2 rather than level 1: `#` renders very large inside a comment, and the
 * assessment heading below it stays level 3.
 */
export const BODY_HEADING = "## Agent review";

/**
 * What a reader selects a finding's id on, and nothing more than that. The
 * marker is a **selector, not a control**, exactly as the follow-ups block's
 * is: anyone who can comment can type one, so whatever reads this establishes
 * that the thread is the loop's own by who opened it.
 */
export const FINDING_MARKER = "agent-finding";

/**
 * The other marker this loop writes into a body it posts: the one on a closing
 * reply, saying which reason a thread was closed under (#133). Its format and
 * its reader live with the replies that carry it
 * (`shared/review-verification.ts`), and the strip of every agent-written
 * string is by this name (`shared/review-findings.ts`).
 *
 * A selector rather than a control, exactly as `FINDING_MARKER` is, and read
 * only off a comment the workflow bot wrote.
 */
export const RESOLUTION_MARKER = "agent-resolution";

/**
 * What a reader selects the payload on, and nothing more than that. The
 * marker is a **selector, not a control**: it says where the block is and
 * contributes nothing to trusting it. Whatever reads this establishes that the
 * review is the runner's own by checking who posted it and whether it was
 * edited — never by the presence of this string, which anyone who can comment
 * can type.
 */
export const FOLLOW_UPS_MARKER = "agent-follow-ups";

/**
 * What a reader selects the record on: a selector, not a control, as
 * `FOLLOW_UPS_MARKER` is. Only a review this loop posted is read.
 */
export const RED_TESTS_MARKER = "agent-red-tests";

// Markers in a pull request's body.

/**
 * The **summary block** in a pull request's body (#218): the one part of the
 * body the review writes, between these two markers, which the opening run put
 * there. Text outside them is the opening run's frame and whatever a maintainer
 * added, and survives every update byte for byte (`review/pr-summary.ts`).
 */
export const SUMMARY_START = "<!-- agent:summary -->";

export const SUMMARY_END = "<!-- /agent:summary -->";

/**
 * The head a summary was written at, as the first line inside the block. What
 * the update rule reads: a summary is rewritten when the pull request has
 * moved since, and left alone when it has not (`review/pr-summary.ts`).
 */
export const summaryHeadMark = (sha: string): string => `<!-- agent:summary-head ${sha} -->`;

/**
 * Written inside the block by a PRD PR's **final review** (#247), beside the
 * head mark. The last slice round wrote the block at the same head the final
 * review reads, so the head alone would leave the final review's title and PRD
 * sections unwritten: a block without this mark is due to the final review
 * whatever head it was written at.
 */
export const FINAL_SUMMARY_MARK = "<!-- agent:summary-final -->";

/**
 * The PRD PR frame's **draft-only** text (#247): the note that the PR stays a
 * draft until every slice is done, between these markers, which the opening
 * run writes and the final review's write of the summary removes, markers and
 * all. Once the final review runs every slice is done, and a ready PRD PR
 * carries nothing that says otherwise. Held equal to `implement-prd.yml`'s
 * frame by a test.
 */
export const DRAFT_NOTE_START = "<!-- agent:draft-note -->";

export const DRAFT_NOTE_END = "<!-- /agent:draft-note -->";

/**
 * The **progress table** on a PRD PR's note: one row per sub-issue, between
 * these markers, workflow-owned and rendered from state
 * (`shared/progress-list.ts`).
 */
export const PROGRESS_START = "<!-- agent:progress -->";

export const PROGRESS_END = "<!-- /agent:progress -->";

/**
 * The finishing run's record that the final review is requested: a review of
 * a PRD PR whose body carries it is the final review, and a preflight that
 * finds it on a PRD of more than one slice calls the PRD finished. Held equal
 * to the workflows' copies by a test.
 */
export const FINAL_REVIEW_MARK = "<!-- agent:final-review requested -->";

/**
 * The **status line** (#298): one line at the top of the PRD PR's note, saying
 * where the chain is now, between its own markers. Workflow-owned like the
 * progress table, and rendered from the same state, so the two cannot
 * disagree. It links the latest review where the chain waits on it.
 */
export const STATUS_START = "<!-- agent:status -->";

export const STATUS_END = "<!-- /agent:status -->";

// Commit status contexts.

/**
 * The context the verdict is posted under. One per commit per context, so a
 * later review of the same commit replaces its own verdict and nothing else —
 * and a new commit carries none until one is posted for it, which is what stops
 * a stale approval surviving a push.
 */
export const VERDICT_CONTEXT = "agent-review";

/**
 * The record that a review asked for an automatic fix round (#297): a second
 * status, under a context of its own, posted beside the verdict on the same
 * commit and linking the same review, only where the row has
 * `startsFixRound`.
 *
 * The verdict's line used to be that record: a fix round's status line was
 * its own, and the budget counted rounds by it, word for word. #201's
 * *Verdict lines* made every line fixed whatever the state, so the fact moved
 * here. It is what `review:gate` counts rounds by and what
 * `readReviewHistory` reads a fix round off, matched to its verdict by link.
 *
 * `success`, because it records a step taken rather than something left to
 * do, and a `pending` one would read as a check that never finished.
 */
export const FIX_ROUND_STATUS = {
  context: "agent-fix-round",
  state: "success",
  description: "This review asked for an automatic fix round.",
} as const;

// Labels.

/**
 * The trigger labels, each on while its run works (`docs/ADOPTING.md` §3).
 * `implement-prd` answers `agent:implement` too, on a PRD issue.
 */
export const IMPLEMENT_LABEL = "agent:implement";
export const REVIEW_LABEL = "agent:review";
export const FIX_LABEL = "agent:fix";
export const UPDATE_BRANCH_LABEL = "agent:update-branch";

/** The state label: a run failed or was refused, and a human is needed. */
export const BLOCKED_LABEL = "agent:blocked";

/** The label whose removal opts a pull request out of having its follow-ups filed. */
export const FOLLOW_UPS_LABEL = "agent:follow-ups";

/** The triage vocabulary's entry point, on every filed stub. A stub arrives as work to judge, not as work to do. */
export const TRIAGE_LABEL = "needs-triage";

/**
 * The label that says where a filed stub came from. Also the candidate filter the
 * gather half lists on: **list and match, never search**. A label filter is
 * exact, where issue search tokenizes on path punctuation and is fuzzy in both
 * directions — and a spurious search hit skips a real finding silently, which
 * is the one direction nothing here fails in.
 */
export const FOLLOW_UP_STUB_LABEL = "pr-follow-up";

// Branch patterns.

/**
 * What a PRD branch's name starts with: `agent/prd-<parent>-<slug>`, the one
 * branch every slice of a PRD is built on, and the head of its PRD PR
 * (PRD #222).
 */
export const PRD_BRANCH_PREFIX = "agent/prd-";

// Commit trailers.

/** The trailer key a build run's commits carry, as `Agent-Slice: #<sub>`. */
export const SLICE_TRAILER = "Agent-Slice";

/**
 * The trailer key `implement-prd`'s own merge of the default branch carries,
 * as `Agent-Catch-Up: #<sub>` naming the slice it was made before (#245). The
 * one mark that tells that merge from `update-branch`'s conflict resolution,
 * which has the same shape (an untrailered merge of the default branch) and
 * belongs to the slice whose round it was. Not `Agent-Slice`, so nothing reads
 * it as a slice's commit.
 */
export const CATCH_UP_TRAILER = "Agent-Catch-Up";
