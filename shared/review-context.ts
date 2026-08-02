import { fetchTrustedComments, fetchTrustedIssue, gh } from "./common.js";
import { fetchPullRequestFeedback } from "./pr-feedback.js";
import { parseDiffLines } from "./diff-lines.js";

export interface PullRequestContext {
  readonly prTitle: string;
  readonly prBody: string;
  readonly issueNumber: string;
  readonly issueTitle: string;
  readonly linkedIssue: string;
  /** Collaborator-authored conversation comments on the PR and linked issue. */
  readonly discussion: string;
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
  const prView = JSON.parse(gh(["pr", "view", prNumber, "--json", "title,body"])) as {
    title: string;
    body?: string | null;
  };

  const issueMatch = (prView.body ?? "").match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  const issueNumber = issueMatch?.[1] ?? "";

  // SECURITY: `fetchTrustedIssue` returns the title/body only when the issue's
  // author has repo write access, and never fetches comments. On a public repo
  // anyone can open an issue or comment on one, and this text reaches an
  // unsandboxed, token-holding agent that posts public output — so untrusted
  // issue text is a prompt-injection / exfiltration source. Gating on author
  // association (not on field type) keeps this input behind the same
  // write-access boundary the rest of the loop assumes, and holds even once
  // community-authored issues enter the backlog.
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
  const discussion = [
    feedback.all,
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
    prTitle: prView.title,
    prBody: prView.body ?? "",
    issueNumber,
    issueTitle,
    linkedIssue,
    discussion,
    diff,
    diffLines: parseDiffLines(diff),
  };
};
