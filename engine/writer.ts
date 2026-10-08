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

/** One GitHub call a write makes: a read only looks, a write changes something. */
export type Call = <C>(label: string, request: () => Promise<C>, kind?: "read" | "write") => Promise<C>;

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
  /** The GitHub calls it made, in order, each `<label> ok` or `<label> <error>`. */
  readonly calls: readonly string[];
  /** What it made, where it made something with a URL. */
  readonly url?: string;
}

/**
 * The log's last line: how the command ended. `by` is the entry of the write
 * whose throw stopped it, where one did, so a `failed` entry it does not name
 * is a failure the loop caught and lived with.
 */
export type Ending =
  | { readonly ended: "finished"; readonly writes: number }
  | { readonly ended: "stopped"; readonly writes: number; readonly by?: number; readonly reason: string };

/** A write that failed, thrown with its log entry. */
export class WriteFailed extends Error {
  constructor(readonly entry: LogEntry) {
    super(`${entry.type} ${entry.target} ${entry.outcome}: ${entry.calls.at(-1) ?? "no call made"}`);
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
    const call: Call = async (label, request, kind = "write") => {
      try {
        const value = await request();
        calls.push(`${label} ok`);
        if (kind === "write") wrote = true;
        return value;
      } catch (error) {
        calls.push(`${label} ${describe(error)}`);
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
      throw new WriteFailed(record({ token, type, target, outcome: wrote ? "partial" : "failed", calls }));
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
    const ending: Ending =
      error === undefined
        ? { ended: "finished", writes }
        : {
            ended: "stopped",
            writes,
            ...(error instanceof WriteFailed || error instanceof LimitReached ? { by: error.entry.seq } : {}),
            reason: describe(error),
          };
    options.appendLine(JSON.stringify(ending));
    return ending;
  };

  return { writers, log: { entries, end } };
};
