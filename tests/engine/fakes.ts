/**
 * The writer's and the reader's fakes (ADR 0005): the seam a command's test
 * stands on. Both work over one `FakeGitHub`, so a write a command makes is
 * what its next read sees, and both record the calls they receive, in order.
 *
 * The fake writers are the engine's own `createWriters` over a fake backend,
 * so limits, the log and the throw are the ones a run has; what is fake is
 * GitHub. A write past its limit is recorded as received, and refused before
 * it reaches the fake.
 */
import { GitHubError } from "../../engine/github.js";
import type { CheckRun, CommitStatus, GitHubReader, PullRequest, WorkflowRun } from "../../engine/read.js";
import {
  createWriters,
  type Backend,
  type Limits,
  type LogEntry,
  type ReviewThread,
  type WriteLog,
  type Writer,
  type WriteType,
} from "../../engine/writer.js";

/** One pull request's mutable state. */
export interface FakePullRequest {
  number: number;
  nodeId: string;
  state: "open" | "closed";
  draft: boolean;
  headSha: string;
  title: string;
  body: string;
  labels: string[];
}

/** The live state both fakes share. */
export interface FakeGitHub {
  readonly pullRequests: Map<number, FakePullRequest>;
  /** Per commit, newest first. */
  readonly statuses: Map<string, CommitStatus[]>;
  /** Per pull request, each thread by id, with its replies and how it was resolved. */
  readonly threads: Map<number, Map<string, { replies: string[]; resolved?: string }>>;
  /** Labels on issues that are not pull requests. */
  readonly issueLabels: Map<number, string[]>;
  /** Each branch's tip, by name: what a push moves. A branch not here is not found. */
  readonly branches: Map<string, string>;
  /** Per pull request, its commits, oldest first. */
  readonly commits: Map<number, string[]>;
  /** The compare API's `status`, by `<base>...<head>`. A pair not here is not found. */
  readonly comparisons: Map<string, string>;
  /** Per commit, its check runs. A commit not here has none. */
  readonly checkRuns: Map<string, CheckRun[]>;
  /** Per commit, the workflow runs whose head it is. A commit not here has none. */
  readonly workflowRuns: Map<string, WorkflowRun[]>;
  /** Per workflow run, the log of each of its jobs that failed. A run not here has none. */
  readonly jobLogs: Map<number, string[]>;
  readonly comments: { readonly token: string; readonly issue: number; readonly body: string }[];
  /** Every review posted, in order, with the pull request's node id and the commit it was posted on. */
  readonly reviews: FakeReview[];
  /**
   * Whether the GitHub call `call` (such as `resolve`, `POST labels`) made by
   * the write `write` fails, and how. `true` refuses it with a 422 and changes
   * nothing. A `ServerError` answers with GitHub failing instead, having made
   * the change first where `landed` says so, as GitHub has been seen to. The
   * default fails none.
   */
  fails: (write: { readonly token: string; readonly type: WriteType }, call: string) => boolean | ServerError;
}

/** A review the fake holds. */
export interface FakeReview {
  readonly token: string;
  readonly pullRequestId: string;
  readonly commit: string;
  readonly body: string;
  readonly threads: readonly ReviewThread[];
  readonly url: string;
}

/** GitHub failing on a call: a 500, or GraphQL's internal error where `status` is absent. */
export interface ServerError {
  readonly status?: number;
  /** Whether the change was made before GitHub answered with the error. */
  readonly landed: boolean;
}

export const fakeGitHub = (pullRequests: readonly Partial<FakePullRequest>[] = [{}]): FakeGitHub => ({
  pullRequests: new Map(
    pullRequests.map((pr, i) => {
      const number = pr.number ?? 7 + i;
      return [
        number,
        {
          number,
          nodeId: `PR_${number}`,
          state: "open",
          draft: false,
          headSha: "a".repeat(40),
          title: "",
          body: "",
          labels: [],
          ...pr,
        },
      ];
    }),
  ),
  statuses: new Map(),
  threads: new Map(),
  issueLabels: new Map(),
  branches: new Map(),
  commits: new Map(),
  comparisons: new Map(),
  checkRuns: new Map(),
  workflowRuns: new Map(),
  jobLogs: new Map(),
  comments: [],
  reviews: [],
  fails: () => false,
});

const pullRequestOf = (github: FakeGitHub, number: number): FakePullRequest => {
  const pr = github.pullRequests.get(number);
  if (pr === undefined) throw new GitHubError(`pull request #${number}: 404 Not Found`, 404);
  return pr;
};

const labelsOf = (github: FakeGitHub, issue: number): string[] => {
  const pr = github.pullRequests.get(issue);
  if (pr !== undefined) return pr.labels;
  const labels = github.issueLabels.get(issue) ?? [];
  github.issueLabels.set(issue, labels);
  return labels;
};

/** A read the fake reader received: the method and its arguments. */
export interface ReceivedRead {
  readonly method: keyof GitHubReader;
  readonly args: readonly unknown[];
}

/** The reader over `github`, and every read it received, in order. */
export const fakeReader = (github: FakeGitHub): { readonly reader: GitHubReader; readonly reads: readonly ReceivedRead[] } => {
  const reads: ReceivedRead[] = [];
  const reader: GitHubReader = {
    pullRequest: async (number) => {
      reads.push({ method: "pullRequest", args: [number] });
      const pr = pullRequestOf(github, number);
      return { ...pr, labels: [...pr.labels] } satisfies PullRequest;
    },
    commitStatuses: async (sha) => {
      reads.push({ method: "commitStatuses", args: [sha] });
      return [...(github.statuses.get(sha) ?? [])];
    },
    reviewThreadIds: async (number) => {
      reads.push({ method: "reviewThreadIds", args: [number] });
      return new Set(github.threads.get(number)?.keys() ?? []);
    },
    reviews: async (number) => {
      reads.push({ method: "reviews", args: [number] });
      const nodeId = pullRequestOf(github, number).nodeId;
      return github.reviews
        .filter((review) => review.pullRequestId === nodeId)
        .map((review) => ({ url: review.url, commit: review.commit, body: review.body, author: review.token }));
    },
    pullRequestCommits: async (number) => {
      reads.push({ method: "pullRequestCommits", args: [number] });
      pullRequestOf(github, number);
      return [...(github.commits.get(number) ?? [])];
    },
    branchTip: async (branch) => {
      reads.push({ method: "branchTip", args: [branch] });
      const tip = github.branches.get(branch);
      if (tip === undefined) throw new GitHubError(`branch ${branch}: 404 Not Found`, 404);
      return tip;
    },
    compare: async (base, head) => {
      reads.push({ method: "compare", args: [base, head] });
      const status = github.comparisons.get(`${base}...${head}`);
      if (status === undefined) throw new GitHubError(`compare ${base}...${head}: 404 Not Found`, 404);
      return status;
    },
    checkRuns: async (sha) => {
      reads.push({ method: "checkRuns", args: [sha] });
      return [...(github.checkRuns.get(sha) ?? [])];
    },
    latestStatuses: async (sha) => {
      reads.push({ method: "latestStatuses", args: [sha] });
      // The statuses are newest first, so the first of each context is its latest.
      const latest = new Map<string, string>();
      for (const status of github.statuses.get(sha) ?? []) {
        if (!latest.has(status.context)) latest.set(status.context, status.state);
      }
      return [...latest].map(([context, state]) => ({ context, state }));
    },
    workflowRuns: async (sha) => {
      reads.push({ method: "workflowRuns", args: [sha] });
      return [...(github.workflowRuns.get(sha) ?? [])];
    },
    failedJobLogs: async (runId) => {
      reads.push({ method: "failedJobLogs", args: [runId] });
      return [...(github.jobLogs.get(runId) ?? [])];
    },
  };
  return { reader, reads };
};

/** The backend for `token`, applying each write to `github`. */
const fakeBackend = (github: FakeGitHub, token: string): Backend => {
  /** `apply`, or the failure `fails` names for this call instead, or as well. */
  const attempt = <T>(type: WriteType, call: string, apply: () => T): T => {
    const failure = github.fails({ token, type }, call);
    if (failure === false) return apply();
    if (failure === true) throw new GitHubError(`${call}: 422 refused by the fake`, 422);
    if (failure.landed) apply();
    throw failure.status === undefined
      ? new GitHubError(`${call}: An internal error occurred, by the fake`)
      : new GitHubError(`${call}: ${failure.status} by the fake`, failure.status);
  };
  const check = (type: WriteType, call: string): void => attempt(type, call, () => undefined);
  const threadOf = (threadId: string) => {
    for (const threads of github.threads.values()) {
      const thread = threads.get(threadId);
      if (thread !== undefined) return thread;
    }
    throw new GitHubError(`thread ${threadId}: not found`);
  };
  return {
    addLabel: async (call, issue, label) => {
      await call("POST labels", async () => {
        check("addLabel", "POST labels");
        const labels = labelsOf(github, issue);
        if (!labels.includes(label)) labels.push(label);
      });
      return { outcome: "applied" };
    },
    removeLabel: async (call, issue, label) => {
      const labels = labelsOf(github, issue);
      if (!labels.includes(label)) return { outcome: "unchanged" };
      await call("DELETE label", async () => {
        check("removeLabel", "DELETE label");
        labels.splice(labels.indexOf(label), 1);
      });
      return { outcome: "applied" };
    },
    setCommitStatus: async (call, status) => {
      await call("POST status", async () => {
        check("setCommitStatus", "POST status");
        const statuses = github.statuses.get(status.sha) ?? [];
        statuses.unshift({
          context: status.context,
          state: status.state,
          targetUrl: status.targetUrl ?? null,
          description: status.description,
          creator: token,
        });
        github.statuses.set(status.sha, statuses);
      });
      return { outcome: "applied" };
    },
    comment: async (call, issue, body) => {
      const url = await call("POST comment", async () => {
        check("comment", "POST comment");
        github.comments.push({ token, issue, body });
        return `https://github.com/o/r/issues/${issue}#issuecomment-${github.comments.length}`;
      });
      return { outcome: "applied", url };
    },
    markReadyForReview: async (call, number) => {
      const pr = await call("GET pull", async () => pullRequestOf(github, number), "read");
      if (!pr.draft) return { outcome: "unchanged" };
      await call("markPullRequestReadyForReview", async () => {
        check("markReadyForReview", "markPullRequestReadyForReview");
        pr.draft = false;
      });
      return { outcome: "applied" };
    },
    postReview: async (call, variables) => {
      const url = await call("addPullRequestReview", async () => {
        const posted = `https://github.com/o/r/pull/0#pullrequestreview-${github.reviews.length + 1}`;
        attempt("postReview", "addPullRequestReview", () =>
          github.reviews.push({
            token,
            pullRequestId: variables.pullRequestId,
            commit: variables.commitOID,
            body: variables.body,
            threads: variables.threads,
            url: posted,
          }),
        );
        return posted;
      });
      return { outcome: "applied", url };
    },
    replyAndResolve: async (call, close) => {
      const thread = threadOf(close.threadId);
      const { reply } = close;
      if (reply !== undefined) {
        await call("reply", async () => {
          check("replyAndResolve", "reply");
          thread.replies.push(reply);
        });
      }
      await call("resolve", async () => {
        check("replyAndResolve", "resolve");
        thread.resolved = close.reason;
      });
      return { outcome: "applied" };
    },
    editPullRequest: async (call, number, edit) => {
      const pr = await call("GET pull", async () => pullRequestOf(github, number), "read");
      const body = edit.body?.(pr.body);
      const patch = {
        ...(edit.title === undefined || edit.title === pr.title ? {} : { title: edit.title }),
        ...(body === undefined || body === pr.body ? {} : { body }),
      };
      if (Object.keys(patch).length === 0) return { outcome: "unchanged" };
      await call(`PATCH ${Object.keys(patch).join("+")}`, async () => {
        check("editPullRequest", "PATCH");
        Object.assign(pr, patch);
      });
      return { outcome: "applied" };
    },
  };
};

/** A write a fake writer received: the token's writer, its type, and its arguments. */
export interface ReceivedWrite {
  readonly token: string;
  readonly type: WriteType;
  readonly args: readonly unknown[];
}

/**
 * One fake writer per token in `tokens`, over `github`, sharing `limits` and a
 * log: every write each received, in order across them, and the log's lines
 * as a command's declared file would hold them.
 */
export const fakeWriters = <T extends string>(
  github: FakeGitHub,
  tokens: readonly T[],
  limits: Limits,
): {
  readonly writers: Readonly<Record<T, Writer>>;
  readonly log: WriteLog;
  readonly writes: readonly ReceivedWrite[];
  readonly lines: readonly string[];
  readonly entries: readonly LogEntry[];
} => {
  const lines: string[] = [];
  const writes: ReceivedWrite[] = [];
  const { writers, log } = createWriters({
    backends: Object.fromEntries(tokens.map((token) => [token, fakeBackend(github, token)])) as Record<T, Backend>,
    limits,
    appendLine: (line) => lines.push(line),
  });
  const recording = (token: T, writer: Writer): Writer =>
    Object.fromEntries(
      (Object.keys(writer) as WriteType[]).map((type) => [
        type,
        (...args: unknown[]) => {
          writes.push({ token, type, args });
          return (writer[type] as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as Writer;
  return {
    writers: Object.fromEntries(tokens.map((token) => [token, recording(token, writers[token])])) as Record<T, Writer>,
    log,
    writes,
    lines,
    entries: log.entries,
  };
};
