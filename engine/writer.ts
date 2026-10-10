/**
 * The engine's writer (ADR 0005): a command calls it once per write, each write
 * a type named for what GitHub does, never for what the loop means. Every
 * write is counted against the command's limit for its type, appended to the
 * write log as it lands, and thrown on failure.
 *
 * Two writers, one per token, share one log and one set of limits, so the log
 * reads in one order across tokens. The writer does not latch: a failed write
 * throws, and whether the command stops is whether the loop caught the throw.
 * Only the loop knows which writes it can live without.
 *
 * What a write does on GitHub is a `Backend`: `githubWrites` in
 * `engine/writes.ts` for a run, a fake for a test. Limits, the log and the
 * throw are this module's, so a test exercises the same ones a run does.
 */
import { GitHubError } from "./github.js";

/**
 * A refusal a write type accepts, declared where it makes the call: `when`
 * picks it out of what the call threw, and `reason` is what the log says of it,
 * an expected result rather than an error. The call still throws it, for the
 * write type to turn into its outcome.
 */
export interface Tolerated {
  readonly when: (error: unknown) => boolean;
  readonly reason: string;
}

/** One GitHub call a write makes: a read only looks, a write changes something. */
export type Call = <C>(label: string, request: () => Promise<C>, kind?: "read" | "write", tolerated?: Tolerated) => Promise<C>;

/** A write that landed, or found the record already as asked. */
export interface Done {
  readonly outcome: "applied" | "unchanged";
}

/** A write that made something with a URL of its own. */
export interface Posted {
  readonly outcome: "applied";
  readonly url: string;
}

/** One thread of a review, as `AddPullRequestReviewInput.threads` takes it. No `line` is a file-level thread. */
export interface ReviewThread {
  readonly path: string;
  readonly body: string;
  readonly line?: number;
  readonly side?: "LEFT" | "RIGHT";
  readonly startLine?: number;
  readonly startSide?: "LEFT" | "RIGHT";
}

/**
 * A review's variables, and only its variables: the mutation is the engine's
 * own, so no caller can choose what runs with the token (#399). The event is
 * the engine's too, always `COMMENT`.
 */
export interface ReviewVariables {
  readonly pullRequestId: string;
  /** The commit reviewed, so a push during the run does not move what the threads anchor to. */
  readonly commitOID: string;
  readonly body: string;
  readonly threads: readonly ReviewThread[];
}

export type ResolutionReason = "ADDRESSED" | "WONT_FIX";

export interface CommitStatusWrite {
  readonly sha: string;
  readonly context: string;
  readonly state: "error" | "failure" | "pending" | "success";
  readonly description: string;
  readonly targetUrl?: string;
}

export interface ThreadClose {
  readonly threadId: string;
  /** The reply to post before the resolve, or `undefined` where the thread already carries it. */
  readonly reply: string | undefined;
  readonly reason: ResolutionReason;
}

/**
 * A pull request's title and body. `body` is handed the body as it is now and
 * returns the new one, or `undefined` to leave it, so a splice is made against
 * what a maintainer wrote while the run worked rather than against a copy read
 * before it.
 */
export interface PullRequestEdit {
  readonly title?: string;
  readonly body?: (live: string) => string | undefined;
}

export interface Writer {
  addLabel(issue: number, label: string): Promise<Done>;
  /** A label that is not there is `unchanged`, not a failure. */
  removeLabel(issue: number, label: string): Promise<Done>;
  setCommitStatus(status: CommitStatusWrite): Promise<Done>;
  comment(issue: number, body: string): Promise<Posted>;
  /** A pull request that is not a draft is `unchanged`. */
  markReadyForReview(pr: number): Promise<Done>;
  postReview(variables: ReviewVariables): Promise<Posted>;
  /**
   * The reply, then the resolve, the resolve only once the reply landed: a
   * thread closed with no reply loses the only record of why. Logged `partial`
   * where the reply landed and the resolve did not.
   */
  replyAndResolve(thread: ThreadClose): Promise<Done>;
  /** Nothing to change, by title or by what `body` returns for the live body, is `unchanged`. */
  editPullRequest(pr: number, edit: PullRequestEdit): Promise<Done>;
}

export type WriteType = keyof Writer;

/** What each write does on GitHub, handed a `Call` for every GitHub call it makes so the log can list them. */
export type Backend = {
  readonly [K in WriteType]: (call: Call, ...args: Parameters<Writer[K]>) => ReturnType<Writer[K]>;
};

/**
 * A command's limit per write type. A type it does not name is limited to
 * none: a write the command never declared it makes is the bug the limit is
 * there to catch.
 */
export type Limits = Readonly<Partial<Record<WriteType, number>>>;

export type Outcome = "applied" | "unchanged" | "partial" | "failed" | "refused";

/** One line of the write log: one write, the token that made it, and what came of it. */
export interface LogEntry {
  readonly seq: number;
  readonly token: string;
  readonly type: WriteType;
  /** What it was aimed at: `#12 agent:fix`, a thread id, a commit and a context. */
  readonly target: string;
  readonly outcome: Outcome;
  /**
   * The GitHub calls it made, in order: `<label> ok`; `<label> expected: <reason>`
   * for a refusal the write type accepts; or, refused, `<label> <status> <reason>`
   * with GitHub's own short reason, and the status where it gave one.
   */
  readonly calls: readonly string[];
  /** What it made, where it made something with a URL. */
  readonly url?: string;
  /** GitHub's answer to the call that failed, capped: only on a `failed` or `partial` write, as evidence. */
  readonly response?: string;
}

/**
 * The log's last line: how the command ended. `by` is the entry of the write
 * whose throw stopped it, where one did, so a `failed` entry it does not name
 * is a failure the loop caught and lived with.
 */
export type Ending =
  | { readonly ended: "finished"; readonly writes: number }
  | { readonly ended: "stopped"; readonly writes: number; readonly by?: number; readonly reason: string };

/**
 * A write that failed, thrown with its log entry, and with what GitHub threw
 * as its `cause`: whether a failure is one the loop can read past, such as a
 * server error on a write that may have landed, is the loop's to judge from it.
 */
export class WriteFailed extends Error {
  constructor(
    readonly entry: LogEntry,
    cause?: unknown,
  ) {
    super(`${entry.type} ${entry.target} ${entry.outcome}: ${entry.calls.at(-1) ?? "no call made"}`, { cause });
    this.name = "WriteFailed";
  }
}

/** A write past its type's limit, refused before any call: our own code's bug, so never trimmed. */
export class LimitReached extends Error {
  constructor(
    readonly entry: LogEntry,
    readonly limit: number,
  ) {
    super(`${entry.type} ${entry.target} refused: past the limit of ${limit}`);
    this.name = "LimitReached";
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A refused call's line: its label, GitHub's status and short reason, and none of the raw answer. */
const refusal = (label: string, error: unknown): string =>
  error instanceof GitHubError
    ? [label, error.status, error.reason].filter((part) => part !== undefined && part !== "").join(" ")
    : `${label} ${describe(error)}`;

/**
 * The write whose throw stopped a command, where one did: `error` itself, or
 * what it was thrown for. The loop rethrows a write's failure as a sentence a
 * person can act on, with the write's error as its `cause`, and the log still
 * names the write.
 */
const stoppedBy = (error: unknown): WriteFailed | LimitReached | undefined => {
  for (let at = error, depth = 0; at instanceof Error && depth < 10; at = at.cause, depth++) {
    if (at instanceof WriteFailed || at instanceof LimitReached) return at;
  }
  return undefined;
};

/** Each write's target, as the log names it. */
const TARGETS: { readonly [K in WriteType]: (...args: Parameters<Writer[K]>) => string } = {
  addLabel: (issue, label) => `#${issue} ${label}`,
  removeLabel: (issue, label) => `#${issue} ${label}`,
  setCommitStatus: (status) => `${status.sha.slice(0, 7)} ${status.context}=${status.state}`,
  comment: (issue) => `#${issue}`,
  markReadyForReview: (pr) => `#${pr}`,
  postReview: (variables) => `${variables.pullRequestId} ${variables.commitOID.slice(0, 7)}`,
  replyAndResolve: (thread) => `${thread.threadId} ${thread.reason}${thread.reply === undefined ? " (already replied)" : ""}`,
  editPullRequest: (pr, edit) => `#${pr}${edit.title === undefined ? "" : " title"}${edit.body === undefined ? "" : " body"}`,
};

export interface WriteLog {
  /** Every entry so far, in the order they were made. */
  readonly entries: readonly LogEntry[];
  /**
   * Append the last line: finished, or stopped by `error`. The caller of the
   * command calls it once, after the command returns or throws.
   */
  end(error?: unknown): Ending;
}

/**
 * One writer per token in `backends`, sharing `limits` and a log, each line of
 * which is handed to `appendLine` as it is made: a command declares the file
 * it lands in, and a command cancelled half way leaves what it did.
 */
export const createWriters = <T extends string>(options: {
  readonly backends: Readonly<Record<T, Backend>>;
  readonly limits: Limits;
  readonly appendLine: (line: string) => void;
}): { readonly writers: Readonly<Record<T, Writer>>; readonly log: WriteLog } => {
  const entries: LogEntry[] = [];
  const counts = new Map<WriteType, number>();

  const record = (entry: Omit<LogEntry, "seq">): LogEntry => {
    const full: LogEntry = { seq: entries.length + 1, ...entry };
    entries.push(full);
    options.appendLine(JSON.stringify(full));
    return full;
  };

  const write = async <K extends WriteType>(
    token: T,
    backend: Backend,
    type: K,
    args: Parameters<Writer[K]>,
  ): Promise<Awaited<ReturnType<Writer[K]>>> => {
    const target = (TARGETS[type] as (...a: Parameters<Writer[K]>) => string)(...args);
    const limit = options.limits[type] ?? 0;
    const used = (counts.get(type) ?? 0) + 1;
    counts.set(type, used);
    if (used > limit) {
      throw new LimitReached(record({ token, type, target, outcome: "refused", calls: [] }), limit);
    }
    const calls: string[] = [];
    let wrote = false;
    let thrown: unknown;
    const call: Call = async (label, request, kind = "write", tolerated) => {
      try {
        const value = await request();
        calls.push(`${label} ok`);
        if (kind === "write") wrote = true;
        return value;
      } catch (error) {
        calls.push(tolerated?.when(error) === true ? `${label} expected: ${tolerated.reason}` : refusal(label, error));
        thrown = error;
        throw error;
      }
    };
    const apply = backend[type] as (call: Call, ...a: Parameters<Writer[K]>) => ReturnType<Writer[K]>;
    let done: Awaited<ReturnType<Writer[K]>>;
    try {
      done = await apply(call, ...args);
    } catch (error) {
      // A throw outside any call, such as from an edit's `body`, still says what it was.
      if (error !== thrown) calls.push(describe(error));
      const response = error instanceof GitHubError ? error.raw : undefined;
      throw new WriteFailed(
        record({ token, type, target, outcome: wrote ? "partial" : "failed", calls, ...(response === undefined ? {} : { response }) }),
        error,
      );
    }
    const result = done as Done | Posted;
    record({ token, type, target, outcome: result.outcome, calls, ...("url" in result ? { url: result.url } : {}) });
    return done;
  };

  const writer = (token: T, backend: Backend): Writer => {
    const bound = <K extends WriteType>(type: K) =>
      ((...args: Parameters<Writer[K]>) => write(token, backend, type, args)) as unknown as Writer[K];
    return {
      addLabel: bound("addLabel"),
      removeLabel: bound("removeLabel"),
      setCommitStatus: bound("setCommitStatus"),
      comment: bound("comment"),
      markReadyForReview: bound("markReadyForReview"),
      postReview: bound("postReview"),
      replyAndResolve: bound("replyAndResolve"),
      editPullRequest: bound("editPullRequest"),
    };
  };

  const writers = Object.fromEntries(
    (Object.entries(options.backends) as [T, Backend][]).map(([token, backend]) => [token, writer(token, backend)]),
  ) as Record<T, Writer>;

  const end = (error?: unknown): Ending => {
    const writes = entries.length;
    const by = stoppedBy(error);
    const ending: Ending =
      error === undefined
        ? { ended: "finished", writes }
        : { ended: "stopped", writes, ...(by === undefined ? {} : { by: by.entry.seq }), reason: describe(error) };
    options.appendLine(JSON.stringify(ending));
    return ending;
  };

  return { writers, log: { entries, end } };
};
