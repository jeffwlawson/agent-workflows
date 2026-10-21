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

// The loop's identity.

/**
 * The account the loop always recognises as its own (§4.1), in its REST
 * spelling: the one every Actions workflow posts as with its job's
 * `GITHUB_TOKEN`. Recognised beside whatever accounts an orchestrator passes
 * in, since older pull requests carry it and the Actions reusables still post
 * as it. Read through `loopAccounts` (`shared/loop-accounts.ts`), which adds
 * its GraphQL spelling.
 *
 * The one place shipped TypeScript writes this login, and
 * `tests/loop-accounts.test.ts` holds it there, so no runner or command can
 * hard-code the loop's account again.
 */
export const DEFAULT_LOOP_ACCOUNT = "github-actions[bot]";

/**
 * Who the merge commits the loop makes are made by: the name and noreply
 * address every workflow's merge of a base branch, and the resolution of one,
 * is committed as, and the identity `implement:prepare` gives the checkout
 * an implement agent commits in. Handed to the engine's merge
 * (`engine/git.ts`), which spells no identity of its own. The workflows'
 * shell steps that still merge spell it too, until their steps move.
 */
export const LOOP_COMMITTER = {
  name: "sandcastle-agent[bot]",
  email: "sandcastle-agent[bot]@users.noreply.github.com",
} as const;


// Fix's markers, which `fix:publish` writes from `fix`'s hand-over and the
// runners read back off the loop's own comments.

/**
 * Appended to every top-level comment `fix` posts. It keeps the comment out
 * of the next fix run's feedback and is what that channel is deduped on
 * (`shared/fix-output.ts`). Not a selector for filing anything.
 */
export const TOP_LEVEL_COMMENT_MARKER = "<!-- agent-fix:top-level -->";

/**
 * Ends the record of what a fix run did with the conversation comments (#104):
 * a different string from `TOP_LEVEL_COMMENT_MARKER`, since a record repeated
 * across rounds is correct and a top-level comment repeated is not.
 */
export const CONVERSATION_OUTCOME_MARKER = "<!-- agent-fix:conversation-outcomes -->";

/**
 * The selector an out-of-scope note carries (#213), followed by the note as
 * JSON inside the same HTML comment (`shared/fix-notes.ts`). Read only off a
 * comment the loop posted, never on the marker alone.
 */
export const OUT_OF_SCOPE_NOTE_MARKER = "agent-fix:out-of-scope";

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
 * The PRD PR's **`Closes` block**: the parent and every sub-issue still open,
 * on one line, each with its own keyword, since GitHub reads a closing keyword
 * anywhere in the body. So merging the PRD PR closes exactly the work it
 * holds, and nothing closes before that. Workflow-owned like the progress
 * table, between its own markers, which the review's rewrite of the summary
 * splices around. Written by `implement-prd:publish` into the frame, and
 * appended to a PRD PR an older release opened, which has no block.
 */
export const CLOSES_START = "<!-- agent:closes -->";

export const CLOSES_END = "<!-- /agent:closes -->";

/** The `Closes` block for `parent` and its sub-issues still `open`, markers and all. */
export const closesBlock = (parent: number, open: readonly number[]): string =>
  `${CLOSES_START}\nCloses ${[parent, ...open].map((issue) => `#${issue}`).join(", closes ")}\n${CLOSES_END}`;

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
 * The chain's first run's comment on the PRD parent, saying which sub-issue
 * it builds first, ends with this: a retry of a first run that stopped finds
 * the comment it posted by it, and posts no second (`implement-prd:gate`).
 */
export const PRD_STARTED_MARK = "<!-- agent:prd-started -->";

/**
 * The end of the note on an approved slice's sub-issue, naming the head it
 * was approved on: a retry past the same approval finds the note it posted by
 * it, and posts no second (`implement-prd:gate`).
 */
export const sliceApprovedMark = (sha: string): string => `<!-- agent:slice-approved ${sha} -->`;

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
 * here. It is what `review:budget` counts rounds by and what
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

/**
 * JSON that survives being put inside an HTML comment.
 *
 * `<` and `>` are escaped into the JSON rather than stripped: prose carried in
 * the payload may legitimately contain `-->`, which would end the comment early
 * and truncate what is left to invalid JSON — a reader that files nothing
 * rather than one that files three. `JSON.parse` decodes the escapes, so the
 * round trip is exact.
 *
 * Shared by every payload a marker carries deliberately. The block in a review
 * body and the dedup payload on a filed stub are written by different halves of
 * the feature and read by the same one, and this hazard is identical in both.
 */
export const embeddableJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * The stub payload's shape, versioned for the same reason the review block is
 * and on its own timeline (#81): the two are written and read by different
 * pairs of releases, and the gap this one spans is the longer of the two: a key
 * written into an issue is read back by every run after it, for as long as that
 * issue exists, since the stubs are listed open and closed, and a `wontfix`
 * closure is the case that most needs its key to still match.
 *
 * Deliberately **not** the block's `FOLLOW_UPS_VERSION`, which they shared
 * until this was split out. Moving one to reshape the other's payload is a cost
 * with no connection to the change that caused it: while they shared one, a
 * bump here also refused every findings block already posted by the previous
 * release, filing nothing for pull requests that recorded their findings
 * correctly. `embeddableJson` stays shared, because a JSON escaper is not the
 * coupling.
 */
export const STUB_KEY_VERSION = 2;

/**
 * The key a stub is matched on, written into the stub and read back on the next
 * run. Never the prose: a stub may be reworded freely, and a matcher that read
 * the prose would break on the first person who tidied one up.
 *
 * It answers **two** questions with different authority (#82), which is why
 * `location` is written verbatim and `seq` is written at all:
 *
 * | | Question | Fields | Authority |
 * |---|---|---|---|
 * | Identity | did this run already file this finding? | `pr` + `location` + `seq` | binding |
 * | Relatedness | is there an issue a triager should see? | `location`, normalised | advisory |
 *
 * One key served both until #82 and could not: it was the normalised path, so
 * two findings in one file were one finding, and the loser of that was skipped
 * rather than linked. Storing the normalised form is what made identity as
 * coarse as relatedness, so the raw string is what goes in and normalisation
 * happens on the way back out.
 *
 * Version `2` makes every stub the previous release filed unmatchable, so the
 * next review raising a finding at one of those paths files fresh rather than
 * linking. Accepted on the grounds the planner's `stubKey` states: an
 * unreadable key files a duplicate rather than skipping a real finding, which
 * is one click to close.
 *
 * Moved here byte for byte from the planner's `dedupPayload` (#510), so the
 * read-back and the planner name one spelling; `tests/record.test.ts` pins its
 * bytes. The parser stays with the planner (`stubKey`).
 */
export const stubMarker = (location: string, prNumber: number, seq: number): string =>
  `<!--${embeddableJson({ version: STUB_KEY_VERSION, location, pr: prNumber, seq })}-->`;

/**
 * What `follow-ups:conclude` says of a filing run that stopped (#511), word
 * for word as the shell step *Report the failure on the PR* said it before:
 * the reason it gives where nothing more is known, and the retry. The retry
 * is the marker's: it stays on a run that stopped, and re-adding a label
 * already there fires no event, so the gesture is remove, then add.
 */
export const FOLLOW_UPS_STOPPED = {
  timedOut: (minutes: string): string => `It timed out after ${minutes} minutes.`,
  cancelled: "It was cancelled before it finished, by hand or by GitHub.",
  noReason: "It stopped without giving a reason. The workflow run's log has the details.",
  retry: `Some follow-up issues may not have been filed. To try again, remove \`${FOLLOW_UPS_LABEL}\` and add it back; nothing is filed twice.`,
} as const;

/**
 * The comment a stopped filing run posts on its pull request, in the one
 * pattern every stopped run's takes (#253): `sentence`, already a sentence,
 * then the run's link and the retry.
 */
export const followUpsStoppedComment = (sentence: string, runUrl: string): string =>
  `**\`${FOLLOW_UPS_LABEL}\` stopped:** ${sentence}\n\n[Workflow run](${runUrl}) · ${FOLLOW_UPS_STOPPED.retry}\n`;

// The orchestrator a repository is served by.

/**
 * The repository variable a repository opts into the service orchestrator
 * with (§4.2, #455). Unset is the Actions orchestrator, `SERVICE_ORCHESTRATOR`
 * the service, and any other value is neither: `doctor` reports it, and the
 * service refuses the repository. Every job of every Actions reusable skips on
 * `SERVICE_ORCHESTRATOR`, in YAML, which `tests/workflows.test.ts` holds to
 * these two.
 */
export const ORCHESTRATOR_VARIABLE = "AGENT_ORCHESTRATOR";

export const SERVICE_ORCHESTRATOR = "service";

// Branch patterns.

/**
 * What a PRD branch's name starts with: `agent/prd-<parent>-<slug>`, the one
 * branch every slice of a PRD is built on, and the head of its PRD PR
 * (PRD #222).
 */
export const PRD_BRANCH_PREFIX = "agent/prd-";

/**
 * What an issue branch's name starts with: `agent/issue-<n>-<slug>`, the
 * branch `implement` builds a standalone issue on, and the head of its PR.
 */
export const ISSUE_BRANCH_PREFIX = "agent/issue-";

/**
 * The branch `implement` builds issue `issue` on, its slug from `title`:
 * lowercased, every run of anything but `[a-z0-9]` one `-`, the ends trimmed,
 * then cut to 50, which can leave a trailing `-` the trim came too early to
 * take. Byte for byte what the shell step it replaced wrote, on the runner's
 * `C.UTF-8` locale, so a retry lands on the branch an older release named:
 * only ASCII is lowercased there, and every other character is a separator,
 * so `toLowerCase`, which turns `İ` into an ASCII `i`, would name another
 * branch.
 */
export const issueBranch = (issue: number, title: string): string => `${ISSUE_BRANCH_PREFIX}${issue}-${slugOf(title)}`;

/**
 * Where a stopped fix run on pull request `pr` leaves its commits, its
 * `RESCUE_BRANCH`: `agent/rescue/fix-<pr>`, as `fix.yml` names it for its
 * steps. The service's fix job names it from here.
 */
export const fixRescueBranch = (pr: number): string => `agent/rescue/fix-${pr}`;

/**
 * The stable half of every PRD branch of parent `parent`, `agent/prd-<parent>-`,
 * with the dash that stops #17 matching #171's branch: what the PRD branch is
 * found by, since the slug half comes from an editable title.
 */
export const prdBranchStem = (parent: number): string => `${PRD_BRANCH_PREFIX}${parent}-`;

/**
 * The PRD branch a chain's first run names for parent `parent`, its slug from
 * `title` as `issueBranch`'s is. Only ever the name of a branch that does not
 * exist yet: a chain already started is found by `prdBranchStem`.
 */
export const prdBranch = (parent: number, title: string): string => `${prdBranchStem(parent)}${slugOf(title)}`;

/** A branch's slug, as the shell steps the commands replaced wrote it. */
const slugOf = (title: string): string =>
  title
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

/**
 * What a pull request's body says to close issue `issue` with, as a match:
 * `Closes`, `Fixes` or `Resolves`, any case, then `#<issue>` and a word
 * boundary, so `#12` is not `#123`. A PR whose body carries it is the issue's,
 * and `implement` refuses to open a second.
 */
export const closingReference = (issue: number): RegExp => new RegExp(String.raw`(closes|fixes|resolves)\s+#${issue}\b`, "i");

// Commit trailers.

/** The trailer key a build run's commits carry, as `Agent-Slice: #<sub>`. */
export const SLICE_TRAILER = "Agent-Slice";

/** The `Agent-Slice` trailer naming sub-issue `sub`, as `implement-prd:publish` writes it. */
export const sliceTrailer = (sub: number): string => `${SLICE_TRAILER}: #${sub}`;

/**
 * A line of a commit message that is an `Agent-Slice` trailer, the sub-issue
 * it names as its group: the key in any case, as git's own parser reads it,
 * and nothing else on the line. Global and multiline, for `matchAll` over a
 * whole message.
 */
export const SLICE_TRAILER_LINE = new RegExp(String.raw`^${SLICE_TRAILER}:[ \t]*#([0-9]+)[ \t]*$`, "gim");

/**
 * The trailer key `implement-prd`'s own merge of the default branch carries,
 * as `Agent-Catch-Up: #<sub>` naming the slice it was made before (#245). The
 * one mark that tells that merge from `update-branch`'s conflict resolution,
 * which has the same shape (an untrailered merge of the default branch) and
 * belongs to the slice whose round it was. Not `Agent-Slice`, so nothing reads
 * it as a slice's commit.
 */
export const CATCH_UP_TRAILER = "Agent-Catch-Up";

/** The message of `implement-prd`'s merge of `base` into the PRD branch `branch`, made before slice `sub`. */
export const catchUpMessage = (base: string, branch: string, sub: number): string =>
  `Merge ${base} into ${branch}\n\n${CATCH_UP_TRAILER}: #${sub}`;
