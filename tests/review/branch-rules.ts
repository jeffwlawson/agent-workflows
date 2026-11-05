import { renderSummarySection } from "../../review/pr-summary.js";
import { UNREADABLE_FEEDBACK_RULE } from "../../review/review-context.js";
import { describeHistory } from "../../review/review-round.js";
import { unreadableNote } from "../../shared/pr-feedback.js";
import { renderRedCheck, type RedCheckReport } from "../../shared/red-check.js";
import { EMPTY_FINDING_HISTORY, LIVE_FINDING_HISTORY, REVIEW_PROMPT } from "./finding-history.js";

/**
 * The review prompt's branch sections as a review where each branch is live is
 * handed them (#780, audit #704 H4, stage 1b): a review that follows a fix
 * round, feedback a selection of which was refused, and a red check that ran;
 * and the title and the summary as the final review is handed them (#781,
 * stage 2).
 * Their rules ride with the placeholder the runner fills (`review/review.ts`)
 * and are printed only where they apply, so a test about those rules reads this
 * rather than the static file.
 */
export const REVIEWED_HEAD = "b".repeat(40);

/** A red check that ran and came back with one red test, at the head the review reads. */
export const RAN_REPORT: RedCheckReport = {
  status: "ran",
  base: "a".repeat(40),
  head: REVIEWED_HEAD,
  files: ["tests/queue.test.ts"],
  source: ["src/queue.ts"],
  tests: [{ name: "drops a stale lease", classname: "queue", result: "red", message: "expected 1 to be 0" }],
  exitCode: 1,
  skipped: 0,
};

/** The note a refused selection renders, as `fetchPullRequestContext` puts it in the discussion. */
export const REFUSED_NOTE = unreadableNote([
  { path: "repository.pullRequest.reviewThreads", reason: "FORBIDDEN", surfaces: ["inline"], trustBearing: true },
]);

export const LIVE_BRANCHES = {
  HISTORY: describeHistory({ afterFixRound: true, unreviewedCommits: true }),
  DISCUSSION: [UNREADABLE_FEEDBACK_RULE, REFUSED_NOTE].join("\n\n"),
  RED_CHECK: renderRedCheck({ kind: "ran", report: RAN_REPORT }, REVIEWED_HEAD),
  // The final review, the one round handed every title-and-summary rule (#781).
  SUMMARY_SECTION: renderSummarySection("final", "(empty)"),
} as const;

/** The same four where none is live: what nearly every review is handed, the summary one a review that omits both fields. */
export const EMPTY_BRANCHES = {
  HISTORY: describeHistory({ afterFixRound: false, unreviewedCommits: true }),
  DISCUSSION: "(no collaborator comments)",
  RED_CHECK: renderRedCheck({ kind: "not-configured" }, REVIEWED_HEAD),
  SUMMARY_SECTION: renderSummarySection("unchanged", "(empty)"),
} as const;

type Inputs = Readonly<Record<string, string>>;

/** The review prompt with the given placeholders filled; every other placeholder is left as it is. */
export const filled = (inputs: Inputs, template: string = REVIEW_PROMPT): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => inputs[key] ?? match);

/** The prompt as a review with every branch section live is handed it, finding history included. */
export const LIVE_PROMPT = filled({ ...LIVE_FINDING_HISTORY, ...LIVE_BRANCHES });

/** And with none live. */
export const EMPTY_PROMPT = filled({ ...EMPTY_FINDING_HISTORY, ...EMPTY_BRANCHES });
