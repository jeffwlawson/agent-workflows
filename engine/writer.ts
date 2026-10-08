/**
 * PROTOTYPE (#399), throwaway. The engine's writer (ADR 0005): one call per
 * write, each a type that names what GitHub does, capped per type, logged
 * as it is applied, and thrown on failure.
 *
 * Two writers, one per token, share one log and one set of counts. The
 * writer does not latch: a failed write throws, and whether the command stops
 * is whether the loop caught it. "Stops at the first failure" is the
 * command's property, since the writer cannot tell a write the loop can live
 * without from one it cannot.
 */
import { GitHubError, type Transport } from "./github.js";
import { toPullRequest } from "./read.js";

export type WriteType =
  | "addLabel"
  | "removeLabel"
  | "comment"
  | "commitStatus"
  | "postReview"
  | "replyAndResolve"
  | "editPullRequest"
  | "markReady";

export type Caps = Readonly<Record<WriteType, number>>;

export type Outcome = "applied" | "unchanged" | "failed" | "refused";

/** One line of the log: one write, which token made it, and what came of it. */
export interface LogEntry {
  readonly seq: number;
  readonly token: string;
  readonly type: WriteType;
  /** What it was aimed at, `#12`, `#12 agent:fix`, a thread id, a commit. */
  readonly target: string;
  readonly outcome: Outcome;
  /** The GitHub calls it made, in order, each marked `ok` or with its error. */
  readonly calls: readonly string[];
  /** What a later write may refer to, such as the review's URL. */
  readonly result?: Readonly<Record<string, string>>;
}

export class WriteFailed extends Error {
  constructor(readonly entry: LogEntry) {
    super(`${entry.type} ${entry.target} failed: ${entry.calls.at(-1) ?? "no call made"}`);
  }
}

/** Past a cap is a bug in our code, so it is refused and thrown, never trimmed. */
export class CapExceeded extends Error {}

/** A review's request, without its query: the mutation is the engine's, never the hand-over's. */
export interface ReviewInput {
  readonly pullRequestId: string;
  readonly commitOID: string;
  readonly body: string;
  readonly threads: readonly unknown[];
}

export interface Writer {
  addLabel(issue: number, label: string): Promise<void>;
  /** An absent label is `unchanged`, not a failure. */
  removeLabel(issue: number, label: string): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  commitStatus(status: {
    readonly sha: string;
    readonly context: string;
    readonly state: "error" | "failure" | "pending" | "success";
    readonly description: string;
    readonly targetUrl?: string;
  }): Promise<void>;
  postReview(input: ReviewInput): Promise<{ readonly url: string }>;
  /**
   * The reply, then the resolve, gated on the reply. `reply: undefined` is a
   * thread already carrying it: the resolve alone is retried. Throws naming
   * the half that failed.
   */
  replyAndResolve(thread: {
    readonly threadId: string;
    readonly reply: string | undefined;
    readonly reason: "ADDRESSED" | "WONT_FIX";
  }): Promise<void>;
  /**
   * The title and the body, against the body as it stands now. `body` maps the
   * live body to the new one, or to `undefined` to leave it, so a splice is
   * made against what a maintainer wrote while the run worked.
   */
  editPullRequest(pr: number, edit: { readonly title?: string; readonly body?: (live: string) => string | undefined }): Promise<Outcome>;
  markReady(pr: number): Promise<void>;
}

/** The log both writers append to, entry by entry, so a killed command leaves what it did. */
export interface WriteLog {
  readonly entries: readonly LogEntry[];
}

export const createWriters = <T extends string>(options: {
  readonly repo: string;
  readonly transports: Readonly<Record<T, Transport>>;
  readonly caps: Caps;
  /** Called once per entry as it is made: a command declares the file it lands in. */
  readonly sink: (entry: LogEntry) => void;
}): { readonly writers: Readonly<Record<T, Writer>>; readonly log: WriteLog } => {
  const entries: LogEntry[] = [];
  const counts = new Map<WriteType, number>();
  const { repo } = options;

  const writer = (token: T, transport: Transport): Writer => {
    const apply = async <R>(
      type: WriteType,
      target: string,
      body: (call: <C>(label: string, request: () => Promise<C>) => Promise<C>) => Promise<{ outcome?: Outcome; result?: Record<string, string>; value: R }>,
    ): Promise<R> => {
      const record = (entry: Omit<LogEntry, "seq" | "token" | "type" | "target">): LogEntry => {
        const full: LogEntry = { seq: entries.length + 1, token, type, target, ...entry };
        entries.push(full);
        options.sink(full);
        return full;
      };
      const used = (counts.get(type) ?? 0) + 1;
      if (used > options.caps[type]) {
        record({ outcome: "refused", calls: [`cap of ${options.caps[type]} ${type} reached`] });
        throw new CapExceeded(`${type} past its cap of ${options.caps[type]}, at ${target}`);
      }
      counts.set(type, used);
      const calls: string[] = [];
      const call = async <C>(label: string, request: () => Promise<C>): Promise<C> => {
        try {
          const value = await request();
          calls.push(`${label} ok`);
          return value;
        } catch (error) {
          calls.push(`${label} ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      };
      try {
        const done = await body(call);
        record({ outcome: done.outcome ?? "applied", calls, ...(done.result === undefined ? {} : { result: done.result }) });
        return done.value;
      } catch (error) {
        if (error instanceof CapExceeded) throw error;
        throw new WriteFailed(record({ outcome: "failed", calls }));
      }
    };

    const issuePath = (issue: number): string => `/repos/${repo}/issues/${issue}`;

    return {
      addLabel: (issue, label) =>
        apply("addLabel", `#${issue} ${label}`, async (call) => {
          await call("POST labels", () => transport.rest({ method: "POST", path: `${issuePath(issue)}/labels`, body: { labels: [label] } }));
          return { value: undefined };
        }),
      removeLabel: (issue, label) =>
        apply("removeLabel", `#${issue} ${label}`, async (call) => {
          try {
            await call("DELETE label", () =>
              transport.rest({ method: "DELETE", path: `${issuePath(issue)}/labels/${encodeURIComponent(label)}` }),
            );
            return { value: undefined };
          } catch (error) {
            if (error instanceof GitHubError && error.status === 404) return { outcome: "unchanged", value: undefined };
            throw error;
          }
        }),
      comment: (issue, body) =>
        apply("comment", `#${issue}`, async (call) => {
          const posted = (await call("POST comment", () =>
            transport.rest({ method: "POST", path: `${issuePath(issue)}/comments`, body: { body } }),
          )) as { html_url: string };
          return { result: { url: posted.html_url }, value: undefined };
        }),
      commitStatus: (status) =>
        apply("commitStatus", `${status.sha.slice(0, 7)} ${status.context}=${status.state}`, async (call) => {
          await call("POST status", () =>
            transport.rest({
              method: "POST",
              path: `/repos/${repo}/statuses/${status.sha}`,
              body: {
                context: status.context,
                state: status.state,
                description: status.description,
                ...(status.targetUrl === undefined ? {} : { target_url: status.targetUrl }),
              },
            }),
          );
          return { value: undefined };
        }),
      postReview: (input) =>
        apply("postReview", input.pullRequestId, async (call) => {
          const data = (await call("addPullRequestReview", () =>
            transport.graphql(
              `mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { url } } }`,
              { input: { ...input, event: "COMMENT" } },
            ),
          )) as { addPullRequestReview: { pullRequestReview: { url: string } } };
          const url = data.addPullRequestReview.pullRequestReview.url;
          return { result: { url }, value: { url } };
        }),
      replyAndResolve: (thread) =>
        apply("replyAndResolve", `${thread.threadId} ${thread.reason}`, async (call) => {
          if (thread.reply !== undefined) {
            const body = thread.reply;
            await call("reply", () =>
              transport.graphql(
                `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){clientMutationId}}`,
                { threadId: thread.threadId, body },
              ),
            );
          }
          await call("resolve", () =>
            transport.graphql(
              `mutation($threadId:ID!,$reason:PullRequestReviewThreadResolutionReason!){resolveReviewThread(input:{threadId:$threadId,resolutionReason:$reason}){clientMutationId}}`,
              { threadId: thread.threadId, reason: thread.reason },
            ),
          );
          return { value: undefined };
        }),
      editPullRequest: (pr, edit) =>
        apply("editPullRequest", `#${pr}${edit.title === undefined ? "" : " title"}${edit.body === undefined ? "" : " body"}`, async (call) => {
          const path = `/repos/${repo}/pulls/${pr}`;
          const live = edit.body === undefined ? undefined : toPullRequest((await call("GET pull", () => transport.rest({ method: "GET", path }))) as never);
          const body = live === undefined || edit.body === undefined ? undefined : edit.body(live.body);
          const patch = {
            ...(edit.title === undefined ? {} : { title: edit.title }),
            ...(body === undefined || body === live?.body ? {} : { body }),
          };
          if (Object.keys(patch).length === 0) return { outcome: "unchanged" as const, value: "unchanged" as const };
          await call(`PATCH ${Object.keys(patch).join("+")}`, () => transport.rest({ method: "PATCH", path, body: patch }));
          return { value: "applied" as const };
        }),
      markReady: (pr) =>
        apply("markReady", `#${pr}`, async (call) => {
          const live = toPullRequest(
            (await call("GET pull", () => transport.rest({ method: "GET", path: `/repos/${repo}/pulls/${pr}` }))) as never,
          );
          if (!live.draft) return { outcome: "unchanged", value: undefined };
          await call("markPullRequestReadyForReview", () =>
            transport.graphql(`mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`, { id: live.nodeId }),
          );
          return { value: undefined };
        }),
    };
  };

  const writers = Object.fromEntries(
    (Object.entries(options.transports) as [T, Transport][]).map(([token, transport]) => [token, writer(token, transport)]),
  ) as Record<T, Writer>;
  return { writers, log: { entries } };
};
