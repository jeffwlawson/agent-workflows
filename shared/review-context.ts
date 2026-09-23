import { fetchTrustedComments, fetchTrustedIssue, gh } from "./common.js";
import {
  fetchPullRequestFeedback,
  unreadableNote,
  type UnreadableSelection,
} from "./pr-feedback.js";
import { parseDiffLines } from "./diff-lines.js";
import { carriedFindings, type CarriedFinding } from "./review-verification.js";

export interface PullRequestContext {
  /**
   * The pull request's GraphQL node id. The review is posted through
   * `addPullRequestReview`, whose input names the pull request by node id
   * rather than by number (#110) — so it is read here, while the token is still
   * in hand, and not by the step that posts.
   */
  readonly prId: string;
  readonly prTitle: string;
  readonly prBody: string;
  readonly issueNumber: string;
  readonly issueTitle: string;
  readonly linkedIssue: string;
  /** Collaborator-authored conversation comments on the PR and linked issue. */
  readonly discussion: string;
  /**
   * Feedback selections the API refused, already rendered into `discussion` for
   * the agent. Carried separately so the runner can say the same thing in its
   * own log, where a human debugging the run reads it.
   */
  readonly unreadableFeedback: readonly UnreadableSelection[];
  /**
   * What an earlier review of this pull request raised and nothing has verified
   * fixed yet — the open threads this loop opened, and the open entries in the
   * latest review body it posted (#111).
   *
   * Handed to **every** review, round 1 included. A human may have pushed the
   * fix, and "is this still true of the code in front of me" has the same
   * answer whoever wrote the commit; a record only round 2 read would be one
   * that a human's push silently emptied.
   */
  readonly carriedFindings: readonly CarriedFinding[];
  readonly diff: string;
  readonly diffLines: Map<string, Set<number>>;
}

/**
 * Gather everything the review agent needs, read here rather than by the agent
 * so it has no reason to reach for `gh` itself (see the token-boundary note in
 * implement.ts). This is the *lite* context: PR metadata, the linked issue, and
 * the diff. It deliberately omits the review-thread GraphQL that the full
 * workflow uses to reply to human comments.
 */
export const fetchPullRequestContext = (prNumber: string): PullRequestContext => {
  const prView = JSON.parse(gh(["pr", "view", prNumber, "--json", "id,title,body"])) as {
    id: string;
    title: string;
    body?: string | null;
  };

  const issueMatch = (prView.body ?? "").match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  const issueNumber = issueMatch?.[1] ?? "";

  // SECURITY: `fetchTrustedIssue` returns the title/body only when the issue's
  // author is trusted by `isTrustedAuthor` — org-adjacent or better, which is
  // not the same as write access (see `TRUSTED_ASSOCIATIONS`, #68) — and never
  // fetches comments. On a public repo anyone can open an issue or comment on
  // one, and this text reaches an unsandboxed, token-holding agent that posts
  // public output — so untrusted issue text is a prompt-injection /
  // exfiltration source. Gating on author association (not on field type)
  // keeps this input behind the same boundary the rest of the loop assumes,
  // and holds even once community-authored issues enter the backlog.
  let issueTitle = "";
  let linkedIssue = "(no linked issue found)";
  if (issueNumber) {
    const issue = fetchTrustedIssue(issueNumber);
    if (issue.trusted) {
      issueTitle = issue.title;
      linkedIssue = issue.body || "(linked issue has no description)";
    } else {
      linkedIssue = `(linked issue #${issueNumber} was opened by a non-collaborator; its text is omitted so world-writable input never reaches the agent)`;
    }
  }

  // Every feedback surface on the PR, author-gated, via the same shared fetch
  // `agent:fix` uses: review summaries, unresolved inline threads (replies
  // included), and conversation comments. A re-review therefore sees the notes
  // a human left on the previous one instead of repeating itself.
  const feedback = fetchPullRequestFeedback(prNumber);
  const issueComments = issueNumber ? fetchTrustedComments(issueNumber) : "";
  // A review **degrades** where the fix runner refuses: it holds `contents:
  // read` and produces text, so proceeding on what survived is right. What it
  // must not do is proceed *silently* — a refused selection used to render as an
  // absent section, and an absent section reads as agreement, so the agent
  // repeated work a human had already commented on with nothing recording why
  // (#76).
  //
  // The note sits with the feedback it qualifies rather than at the end. What
  // follows it comes from a different fetch — `fetchTrustedComments` on the
  // linked issue — which the refusal says nothing about, and a caveat that
  // spans a section it has no bearing on is one the agent has to guess the
  // scope of.
  const discussion = [
    feedback.all,
    unreadableNote(feedback.unreadable),
    issueComments && `### On the linked issue\n\n${issueComments}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // The three-dot diff against the PR's *base branch* (changes since the
  // merge-base) — never a two-dot fallback, which has different semantics and
  // would silently mis-filter inline comments. Empty legitimately means "no
  // changes", not an error. See `diffCommandAgainstBase` for why the base must
  // be the PR's real base rather than a hardcoded `main`.
  const diff = feedback.diff;

  return {
    prId: prView.id,
    prTitle: prView.title,
    prBody: prView.body ?? "",
    issueNumber,
    issueTitle,
    linkedIssue,
    discussion,
    unreadableFeedback: feedback.unreadable,
    // Assembled here rather than in the fetch, which reads GitHub surfaces and
    // reports what it read. Which of those surfaces a finding is recorded on,
    // and which copy wins when it is on both, is the review's question.
    carriedFindings: carriedFindings({
      threads: feedback.agentThreads,
      latestReviewBody: feedback.latestAgentReviewBody,
    }),
    diff,
    diffLines: parseDiffLines(diff),
  };
};
