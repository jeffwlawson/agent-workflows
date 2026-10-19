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
import { GitError, type BundleHead, type GitReader } from "../../engine/git.js";
import { GitHubError, isServerError } from "../../engine/github.js";
import type { CheckRun, CommitStatus, ConversationComment, GitHubReader, PullRequest, SubIssue, WorkflowRun } from "../../engine/read.js";
import {
  createWriters,
  ReadBackFailed,
  type Backend,
  type Lease,
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
  /** The branch it is from, and the branch it is into, where a test names them. */
  headRef?: string;
  baseRef?: string;
}

/**
 * An issue's place in the hierarchy and its blockers. Its labels are
 * `issueLabels`', which its writes move.
 */
export interface FakeIssue {
  parent?: number;
  /** How many sub-issues it has: the length of `children` where a test lists them. */
  subIssues: number;
  /** Its sub-issues, in the list's order, where a test lists them. */
  children?: SubIssue[];
  blockedBy: { readonly number: number; readonly state: "open" | "closed" }[];
}

/** The live state both fakes share. */
export interface FakeGitHub {
  readonly pullRequests: Map<number, FakePullRequest>;
  /** Per commit, newest first. */
  readonly statuses: Map<string, CommitStatus[]>;
  /** Per pull request, each thread by id, with its replies and how it was resolved. */
  readonly threads: Map<number, Map<string, { replies: string[]; resolved?: string }>>;
  /** Per pull request, the comments on its conversation, oldest first. */
  readonly conversation: Map<number, ConversationComment[]>;
  /** Labels on issues that are not pull requests. */
  readonly issueLabels: Map<number, string[]>;
  /** Issues that are not pull requests, by number. One not here is not found. */
  readonly issues: Map<number, FakeIssue>;
  /**
   * Each branch's tip, by name: what a push moves, and what `pushRef` and
   * `deleteRef` lease against, a `refs/heads/` ref by its branch name and any
   * other by its full name. A branch not here is not found.
   */
  readonly branches: Map<string, string>;
  /** Per pull request, its commits, oldest first. */
  readonly commits: Map<number, string[]>;
  /** The compare API's `status`, by `<base>...<head>`. A pair not here is not found. */
  readonly comparisons: Map<string, string>;
  /** The messages of the commits `<head>` has and `<base>` lacks, by `<base>...<head>`. A pair not here is not found. */
  readonly ranges: Map<string, string[]>;
  /** Per commit, its check runs. A commit not here has none. */
  readonly checkRuns: Map<string, CheckRun[]>;
  /** Per commit, the workflow runs whose head it is. A commit not here has none. */
  readonly workflowRuns: Map<string, WorkflowRun[]>;
  /** Per workflow run, the log of each of its jobs that failed. A run not here has none. */
  readonly jobLogs: Map<number, string[]>;
  readonly comments: { readonly token: string; readonly issue: number; readonly body: string }[];
  /** Every review posted, in order, with the pull request's node id and the commit it was posted on. */
  readonly reviews: FakeReview[];
  /** Per issue or pull request, each label added to it and when, oldest first. */
  readonly labelled: Map<number, { readonly label: string; readonly at: string }[]>;
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
  /** When it was submitted, where a test says. */
  readonly submittedAt?: string;
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
  conversation: new Map(),
  issueLabels: new Map(),
  issues: new Map(),
  branches: new Map(),
  commits: new Map(),
  comparisons: new Map(),
  ranges: new Map(),
  checkRuns: new Map(),
  workflowRuns: new Map(),
  jobLogs: new Map(),
  comments: [],
  reviews: [],
  labelled: new Map(),
  fails: () => false,
});

const pullRequestOf = (github: FakeGitHub, number: number): FakePullRequest => {
  const pr = github.pullRequests.get(number);
  if (pr === undefined) throw new GitHubError(`pull request #${number}: 404 Not Found`, 404);
  return pr;
};

const issueOf = (github: FakeGitHub, number: number): FakeIssue => {
  const issue = github.issues.get(number);
  if (issue === undefined) throw new GitHubError(`issue #${number}: 404 Not Found`, 404);
  return issue;
};

const labelsOf = (github: FakeGitHub, issue: number): string[] => {
  const pr = github.pullRequests.get(issue);
  if (pr !== undefined) return pr.labels;
  const labels = github.issueLabels.get(issue) ?? [];
  github.issueLabels.set(issue, labels);
  return labels;
};

/** The open pull request from exactly `head` into exactly `base`, as the reader and the open's read-back find it. */
const openFrom = (github: FakeGitHub, head: string, base: string) => {
  const pr = [...github.pullRequests.values()].find((p) => p.state === "open" && p.headRef === head && p.baseRef === base);
  return pr === undefined ? undefined : { number: pr.number, url: `https://github.com/o/r/pull/${pr.number}` };
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
    issueShape: async (number) => {
      reads.push({ method: "issueShape", args: [number] });
      const issue = issueOf(github, number);
      return {
        parent: issue.parent,
        subIssues: issue.children?.length ?? issue.subIssues,
        labels: [...(github.issueLabels.get(number) ?? [])],
      };
    },
    subIssues: async (number) => {
      reads.push({ method: "subIssues", args: [number] });
      return [...(issueOf(github, number).children ?? [])];
    },
    blockedBy: async (number) => {
      reads.push({ method: "blockedBy", args: [number] });
      return issueOf(github, number).blockedBy.map((blocker) => ({ number: blocker.number, open: blocker.state === "open" }));
    },
    issueComments: async (number) => {
      reads.push({ method: "issueComments", args: [number] });
      return github.comments.filter((comment) => comment.issue === number).map((comment) => comment.body);
    },
    branchesStarting: async (prefix) => {
      reads.push({ method: "branchesStarting", args: [prefix] });
      return [...github.branches].filter(([name]) => name.startsWith(prefix)).map(([name, tip]) => ({ name, tip }));
    },
    openPullRequests: async (filter) => {
      reads.push({ method: "openPullRequests", args: [filter] });
      return [...github.pullRequests.values()]
        .filter((pr) => pr.state === "open" && (filter.head === undefined || pr.headRef === filter.head) && (filter.base === undefined || pr.baseRef === filter.base))
        .map((pr) => ({ number: pr.number, head: pr.headRef ?? "", base: pr.baseRef ?? "" }));
    },
    commitMessages: async (base, head) => {
      reads.push({ method: "commitMessages", args: [base, head] });
      const messages = github.ranges.get(`${base}...${head}`);
      if (messages === undefined) throw new GitHubError(`compare ${base}...${head}: 404 Not Found`, 404);
      return [...messages];
    },
    openBlockers: async (number) => {
      reads.push({ method: "openBlockers", args: [number] });
      return issueOf(github, number)
        .blockedBy.filter((blocker) => blocker.state === "open")
        .map((blocker) => blocker.number);
    },
    openPullRequestsClosing: async (pattern) => {
      reads.push({ method: "openPullRequestsClosing", args: [pattern] });
      // Newest first, as the endpoint lists them.
      return [...github.pullRequests.values()]
        .filter((pr) => pr.state === "open" && pattern.test(pr.body))
        .map((pr) => pr.number)
        .sort((a, b) => b - a);
    },
    openPullRequest: async (head, base) => {
      reads.push({ method: "openPullRequest", args: [head, base] });
      return openFrom(github, head, base);
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
        .map((review) => ({
          url: review.url,
          commit: review.commit,
          body: review.body,
          author: review.token,
          ...(review.submittedAt === undefined ? {} : { submittedAt: review.submittedAt }),
        }));
    },
    labelledAt: async (number, label) => {
      reads.push({ method: "labelledAt", args: [number, label] });
      return (github.labelled.get(number) ?? []).filter((event) => event.label === label).map((event) => event.at);
    },
    conversationComments: async (number) => {
      reads.push({ method: "conversationComments", args: [number] });
      pullRequestOf(github, number);
      return [...(github.conversation.get(number) ?? [])];
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
    const raw = (message: string): string => JSON.stringify({ message, documentation_url: "https://docs.github.com/rest" });
    if (failure === true) {
      throw new GitHubError(`${call}: 422 ${raw("refused by the fake")}`, 422, { reason: "refused by the fake", raw: raw("refused by the fake") });
    }
    if (failure.landed) apply();
    throw failure.status === undefined
      ? new GitHubError(`${call}: An internal error occurred, by the fake`, undefined, { reason: "An internal error occurred, by the fake" })
      : new GitHubError(`${call}: ${failure.status} ${raw("by the fake")}`, failure.status, { reason: "by the fake", raw: raw("by the fake") });
  };
  const check = (type: WriteType, call: string): void => attempt(type, call, () => undefined);
  const threadOf = (threadId: string) => {
    for (const threads of github.threads.values()) {
      const thread = threads.get(threadId);
      if (thread !== undefined) return thread;
    }
    throw new GitHubError(`thread ${threadId}: not found`);
  };
  /** `ref` as `branches` keys it: a `refs/heads/` ref by its branch name, any other by its full name. */
  const branchOf = (ref: string): string => ref.replace(/^refs\/heads\//, "");
  /** `ref`'s lease checked against it, as git's `--force-with-lease` would. */
  const leased = (ref: string, lease: Lease): string => {
    const name = branchOf(ref);
    const tip = github.branches.get(name);
    if ("tip" in lease ? tip !== lease.tip : tip !== undefined) throw new GitError("rejected: [rejected] (stale info)", true);
    return name;
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
    reply: async (call, reply) => {
      const thread = threadOf(reply.threadId);
      await call("reply", async () => {
        check("reply", "reply");
        thread.replies.push(reply.body);
      });
      return { outcome: "applied" };
    },
    pushRef: async (call, push) =>
      call("git push", async () => {
        // Git reports a ref already at the commit as up to date whatever the
        // lease says, so the lease is checked only where there is a push to make.
        const name = branchOf(push.ref);
        if (github.branches.get(name) === push.commit) return { outcome: "unchanged" as const };
        leased(push.ref, push.lease);
        check("pushRef", "git push");
        github.branches.set(name, push.commit);
        return { outcome: "applied" as const };
      }),
    deleteRef: async (call, remove) => {
      await call("git push", async () => {
        const name = leased(remove.ref, remove.lease);
        check("deleteRef", "git push");
        github.branches.delete(name);
      });
      return { outcome: "applied" };
    },
    openPullRequest: async (call, open) => {
      try {
        return await call("POST pulls", async () =>
          attempt("openPullRequest", "POST pulls", () => {
            const number = Math.max(0, ...github.pullRequests.keys()) + 1;
            github.pullRequests.set(number, {
              number,
              nodeId: `PR_${number}`,
              state: "open",
              draft: open.draft,
              headSha: github.branches.get(open.head) ?? "",
              title: open.title,
              body: open.body,
              labels: [],
              headRef: open.head,
              baseRef: open.base,
            });
            return { outcome: "applied" as const, number, url: `https://github.com/o/r/pull/${number}` };
          }),
        );
      } catch (error) {
        // The read-back the engine's own makes, on a server error alone, by head and base alone.
        if (!isServerError(error)) throw error;
        let found;
        try {
          found = await call("GET pulls", async () => attempt("openPullRequest", "GET pulls", () => openFrom(github, open.head, open.base)), "read");
        } catch (readError) {
          throw new ReadBackFailed(error, readError);
        }
        if (found === undefined) throw error;
        return { outcome: "applied", ...found, readBack: (error as Error).message };
      }
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
 * as a command's declared file would hold them. `real` puts a token's real
 * backend in for the types it names, `gitWrites` against a temporary
 * repository for a push a test makes for real.
 */
export const fakeWriters = <T extends string>(
  github: FakeGitHub,
  tokens: readonly T[],
  limits: Limits,
  real: Partial<Record<T, Partial<Backend>>> = {},
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
    backends: Object.fromEntries(tokens.map((token) => [token, { ...fakeBackend(github, token), ...real[token] }])) as Record<T, Backend>,
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

/**
 * A git reader over what a test says a checkout holds: the heads each bundle
 * carries, by path, where `verifyBundle` throws for a path not there, as git
 * does for a bundle that does not verify; and the commits each commit builds
 * on, by commit, each including itself, where `isAncestor` throws for a
 * commit not there, as git does for one the repository lacks. Every call is
 * recorded, in order.
 */
export const fakeGit = (holds: {
  readonly bundles?: Readonly<Record<string, readonly BundleHead[]>>;
  readonly history?: Readonly<Record<string, readonly string[]>>;
}): { readonly git: GitReader; readonly calls: readonly string[] } => {
  const calls: string[] = [];
  return {
    calls,
    git: {
      verifyBundle: async (path) => {
        calls.push(`verifyBundle ${path}`);
        const heads = holds.bundles?.[path];
        if (heads === undefined) throw new GitError("error: could not verify the bundle, by the fake");
        return heads;
      },
      isAncestor: async (ancestor, commit) => {
        calls.push(`isAncestor ${ancestor} ${commit}`);
        const history = holds.history?.[commit];
        if (history === undefined) throw new GitError(`fatal: Not a valid commit name ${commit}, by the fake`);
        return history.includes(ancestor);
      },
      changedPaths: async (from, to, under) => {
        calls.push(`changedPaths ${from} ${to} ${under}`);
        return [];
      },
      firstParentLog: async (base, head) => {
        calls.push(`firstParentLog ${base} ${head}`);
        return [];
      },
    },
  };
};
