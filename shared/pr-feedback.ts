import { gh, isTrustedAuthor, sh } from "./common.js";

export interface PullRequestFeedback {
  /** Bodies of submitted reviews (the reviewer's overall note). */
  readonly summaries: string;
  /** Comments in *unresolved* review threads, anchored to file + line, replies included. */
  readonly inline: string;
  /** Top-level conversation comments on the PR. */
  readonly conversation: string;
  /** All of the above rendered as one block, or "" when there is none. */
  readonly all: string;
  /** Diff of the branch against `main`. */
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
          isResolved
          comments(first:50) {
            nodes { path line originalLine body author { login } authorAssociation }
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
  originalLine?: number | null;
}

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
        reviewThreads?: { nodes?: { isResolved?: boolean; comments?: { nodes?: GqlThreadComment[] } }[] };
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

  const conversation = render(pr?.comments?.nodes, (n, login) => `**@${login}:**\n${(n.body ?? "").trim()}`);

  const summaries = render(
    pr?.reviews?.nodes,
    (n, login) => `**@${login}** (${n.state ?? "COMMENTED"}):\n${(n.body ?? "").trim()}`,
  );

  const unresolved = (pr?.reviewThreads?.nodes ?? [])
    .filter((thread) => thread.isResolved !== true)
    .flatMap((thread) => thread.comments?.nodes ?? []);
  const inline = render(unresolved, (n, login) => {
    const where = `${n.path ?? "unknown"}:${n.line ?? n.originalLine ?? "?"}`;
    return `**${where}** (@${login}):\n${(n.body ?? "").trim()}`;
  });

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
    diff: sh("git diff main...HEAD"),
    hasFeedback: all.length > 0,
  };
};
