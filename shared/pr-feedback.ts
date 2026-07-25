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
  /** Node ids of the unresolved threads shown to the agent, for reply/resolve. */
  readonly threadIds: readonly string[];
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

  const conversation = render(pr?.comments?.nodes, (n, login) => `**@${login}:**\n${(n.body ?? "").trim()}`);

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
    diff: sh("git diff main...HEAD"),
    hasFeedback: all.length > 0,
  };
};
