import { gh, git, isTrustedAuthor } from "./common.js";
import { isAgentTopLevelComment } from "./fix-output.js";

export interface PullRequestFeedback {
  /** Bodies of submitted reviews (the reviewer's overall note). */
  readonly summaries: string;
  /** Comments in *unresolved* review threads, anchored to file + line, replies included. */
  readonly inline: string;
  /**
   * Top-level conversation comments on the PR, **excluding** the ones
   * `agent:fix` posted itself (see `TOP_LEVEL_COMMENT_MARKER`).
   */
  readonly conversation: string;
  /** All of the above rendered as one block, or "" when there is none. */
  readonly all: string;
  /** Node ids of the unresolved threads shown to the agent, for reply/resolve. */
  readonly threadIds: readonly string[];
  /**
   * Bodies of the top-level comments `agent:fix` already posted on this PR —
   * kept out of every rendered surface above, and returned only so a new run
   * can avoid posting the same note twice.
   */
  readonly priorTopLevelComments: readonly string[];
  /** Diff of the branch against the PR's base branch merge-base (three-dot). */
  readonly diff: string;
  /** False when nothing trusted was found — callers should refuse rather than invent work. */
  readonly hasFeedback: boolean;
}

/**
 * One query for every feedback surface a PR has: conversation comments, review
 * summaries, and review threads (whose `comments` include replies). Doing it in
 * a single GraphQL round trip — rather than three REST calls — is what makes
 * `isResolved` available, which REST does not expose at all.
 */
const QUERY = `
query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      comments(first:100) { nodes { body author { login } authorAssociation } }
      reviews(first:50) { nodes { body state author { login } authorAssociation } }
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:50) {
            nodes {
              path line startLine originalLine originalStartLine
              body author { login } authorAssociation
            }
          }
        }
      }
    }
  }
}`;

interface GqlAuthored {
  body?: string | null;
  author?: { login?: string } | null;
  authorAssociation?: string;
}
interface GqlThreadComment extends GqlAuthored {
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
}

interface GqlThread {
  id?: string;
  isResolved?: boolean;
  comments?: { nodes?: GqlThreadComment[] };
}

/**
 * The `git diff` that defines the PR, as GitHub sees it. GitHub computes a PR's
 * diff against the merge-base of its *base branch*, and the inline-comment
 * allow-list (built from this same diff by `parseDiffLines`) must match exactly:
 * too permissive and GitHub rejects the whole review, too restrictive and
 * legitimate comments are dropped — both surface as a silent, empty review
 * (issue #71). So the base is the PR's real base, not a hardcoded `main`.
 *
 * Three-dot on purpose: `<base>...HEAD` is changes since the merge-base, which
 * is what GitHub shows. A two-dot diff has different semantics and would
 * silently mis-filter; the fallback to it was deliberately removed once already
 * (see review-context.ts) — do not reintroduce it.
 *
 * Refuses an absent or empty base rather than defaulting to one. It defaulted
 * to `main` until #98, which is the same silent wrong-branch failure one level
 * down: on a `master` repo every review diffed against a ref that did not
 * exist, and on one that had a stale `main` it diffed against that instead.
 * Every workflow in the loop now sets `BASE_REF` from the pull-request event
 * with the `default-branch` input behind it, so an empty value is a
 * misconfiguration to say out loud — and `fail()` puts the message on the PR.
 *
 * Returns argv for `git`, not a command string: `git()` runs `execFileSync`, so
 * `baseRef` arrives as one argument and is never shell-parsed. That matters
 * because a git ref may legally contain `` ` ``, `$()`, `;`, `|` and `&`. This
 * previously carried a "must stay trusted input" warning instead (issue #75) —
 * write access is still the loop's trust boundary, but it is no longer the only
 * thing standing between a ref name and `/bin/sh`.
 */
export const diffCommandAgainstBase = (baseRef: string | undefined): readonly string[] => {
  const base = (baseRef ?? "").trim();
  if (!base) {
    throw new Error(
      "BASE_REF is empty. The workflow sets it from the pull request's base ref, falling back to its `default-branch` input; without it this diff would have to guess a branch, and a wrong guess is a review that silently comments on the wrong lines (#71).",
    );
  }
  return ["diff", `${base}...HEAD`];
};

/**
 * Where a thread comment points, and whether that anchor is still live.
 *
 * `line` is null once the code under a comment has changed — GitHub calls this
 * *outdated* and keeps `originalLine` as the position it was written against.
 * Saying so matters: an agent handed a bare line number cannot tell whether it
 * describes today's code or code that has since moved.
 */
const anchorOf = (c: GqlThreadComment): string => {
  const outdated = c.line === null || c.line === undefined;
  const end = c.line ?? c.originalLine;
  const start = c.startLine ?? c.originalStartLine;
  const range = start !== null && start !== undefined && start !== end ? `${start}-${end}` : `${end ?? "?"}`;
  return `${c.path ?? "unknown"}:${range}${outdated ? " (outdated — the code here has changed since)" : ""}`;
};

/** Trusted, non-empty, and rendered — the filter every surface shares. */
const render = <T extends GqlAuthored>(
  nodes: T[] | undefined,
  format: (node: T, login: string) => string,
): string =>
  (nodes ?? [])
    .filter((n) => isTrustedAuthor(n.authorAssociation, n.author?.login ?? undefined))
    .filter((n) => (n.body ?? "").trim().length > 0)
    .map((n) => format(n, n.author?.login ?? "unknown"))
    .join("\n\n---\n\n");

/**
 * Gather the feedback on a PR, keeping only what a repo collaborator — or our
 * own review agent — wrote.
 *
 * SECURITY: every surface here is world-writable on a public repo; anyone can
 * comment on a PR or submit a review. `agent:fix` acts on this with
 * `contents: write` and pushes, so an injection would steer *committed code*.
 * The author gate is therefore load-bearing, not cosmetic. Read here rather
 * than by the agent, whose GitHub token is scrubbed before it starts.
 *
 * Resolved threads are dropped: resolving a thread is how a human says "handled,
 * ignore this", and re-feeding it would have the agent redo dismissed work.
 */
export const fetchPullRequestFeedback = (prNumber: string): PullRequestFeedback => {
  const [owner = "", repo = ""] = (process.env["GH_REPO"] ?? "").split("/");

  let pr:
    | {
        comments?: { nodes?: GqlAuthored[] };
        reviews?: { nodes?: (GqlAuthored & { state?: string })[] };
        reviewThreads?: { nodes?: GqlThread[] };
      }
    | undefined;
  try {
    const raw = gh([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `number=${prNumber}`,
      "-f",
      `query=${QUERY}`,
    ]);
    pr = JSON.parse(raw)?.data?.repository?.pullRequest;
  } catch {
    pr = undefined;
  }

  // Our own top-level comments are split off before rendering rather than
  // filtered by author: `github-actions` is trusted on purpose (that is what
  // makes the review → fix handoff work), so an author-based filter would be
  // both too blunt and, on the `reviews` surface, actively wrong. The marker
  // names exactly the comments this workflow wrote. Feeding them back would put
  // the agent's own "worth a follow-up issue" note under a prompt heading that
  // says to decide whether to address or decline it — which is the invariant in
  // docs/parity.md §10 closed by a different door.
  const commentNodes = pr?.comments?.nodes ?? [];
  const priorTopLevelComments = commentNodes
    .filter((n) => isTrustedAuthor(n.authorAssociation, n.author?.login ?? undefined))
    .filter((n) => isAgentTopLevelComment(n.body))
    .map((n) => n.body ?? "");

  const conversation = render(
    commentNodes.filter((n) => !isAgentTopLevelComment(n.body)),
    (n, login) => `**@${login}:**\n${(n.body ?? "").trim()}`,
  );

  const summaries = render(
    pr?.reviews?.nodes,
    (n, login) => `**@${login}** (${n.state ?? "COMMENTED"}):\n${(n.body ?? "").trim()}`,
  );

  // Grouped by thread, not flattened: the fix agent has to name a thread to
  // reply to or resolve it, so thread identity must survive into the prompt.
  const threads = (pr?.reviewThreads?.nodes ?? [])
    .filter((thread): thread is GqlThread & { id: string } =>
      thread.isResolved !== true && typeof thread.id === "string",
    )
    .map((thread) => {
      const trusted = (thread.comments?.nodes ?? []).filter(
        (c) =>
          isTrustedAuthor(c.authorAssociation, c.author?.login ?? undefined) &&
          (c.body ?? "").trim().length > 0,
      );
      return { id: thread.id, comments: trusted };
    })
    .filter((thread) => thread.comments.length > 0);

  const inline = threads
    .map((thread) => {
      const first = thread.comments[0];
      const header = `**${anchorOf(first!)}** — thread \`${thread.id}\``;
      const body = thread.comments
        .map((c) => `@${c.author?.login ?? "unknown"}:\n${(c.body ?? "").trim()}`)
        .join("\n\n");
      return `${header}\n\n${body}`;
    })
    .join("\n\n---\n\n");

  const all = [
    summaries && `### Review summaries\n\n${summaries}`,
    inline && `### Inline comments (unresolved threads)\n\n${inline}`,
    conversation && `### Conversation\n\n${conversation}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    summaries,
    inline,
    conversation,
    all,
    threadIds: threads.map((t) => t.id),
    priorTopLevelComments,
    diff: git(diffCommandAgainstBase(process.env["BASE_REF"])),
    // Deliberately computed from `all`, which no longer contains our own
    // top-level comments: a PR with every thread resolved and no human input
    // must still refuse, rather than find "feedback" the agent wrote itself.
    hasFeedback: all.length > 0,
  };
};
