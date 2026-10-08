/**
 * The GitHub reader a command is handed beside its writers (ADR 0005): the
 * live state a decision or a target check needs. Reads only, so it is never
 * capped or logged.
 */
import type { Transport } from "./github.js";

export interface PullRequest {
  readonly number: number;
  readonly nodeId: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly headSha: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface CommitStatus {
  readonly context: string;
  readonly state: string;
  readonly targetUrl: string | null;
  readonly description: string;
  /** The login that set it. */
  readonly creator: string;
}

/** A review on a pull request, as far as a read-back of one needs it. */
export interface Review {
  readonly url: string;
  /** The commit it was posted on. */
  readonly commit: string;
  readonly body: string;
  /** The login that posted it. */
  readonly author: string;
}

/** A check run on a commit. `conclusion` is `null` until it completes. */
export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** A commit status as the combined endpoint gives it: the latest one per context. */
export interface LatestStatus {
  readonly context: string;
  readonly state: string;
}

/** A workflow run on a commit. `conclusion` is `null` until it completes. */
export interface WorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  /** The path of every reusable workflow it calls, `owner/repo/.github/workflows/<file>@<ref>`. */
  readonly referencedWorkflows: readonly string[];
}

export interface GitHubReader {
  pullRequest(number: number): Promise<PullRequest>;
  /** Every status set on `sha`, newest first, as the endpoint documents. */
  commitStatuses(sha: string): Promise<readonly CommitStatus[]>;
  /** The node id of every review thread on the pull request: what a thread target is checked against (#403). */
  reviewThreadIds(number: number): Promise<ReadonlySet<string>>;
  /** Every review on the pull request, oldest first, as the endpoint documents. */
  reviews(number: number): Promise<readonly Review[]>;
  /** Every commit on the pull request, oldest first, by sha. */
  pullRequestCommits(number: number): Promise<readonly string[]>;
  /**
   * The commit `branch` points at, read from the repository's refs rather
   * than from a pull request, so it moves the moment a push lands.
   */
  branchTip(branch: string): Promise<string>;
  /**
   * How `head` relates to `base`, as the compare API's `status` says it:
   * `ahead` where `head` descends from `base`, else `identical`, `behind` or
   * `diverged`.
   */
  compare(base: string, head: string): Promise<string>;
  /** Every check run on `sha`, the latest of each, as the endpoint documents. */
  checkRuns(sha: string): Promise<readonly CheckRun[]>;
  /** The latest status of each context on `sha`. */
  latestStatuses(sha: string): Promise<readonly LatestStatus[]>;
  /** Every workflow run whose head is `sha`, newest first, as the endpoint documents. */
  workflowRuns(sha: string): Promise<readonly WorkflowRun[]>;
  /** The log of each job of run `runId` that failed, as text, in the order the jobs are listed. */
  failedJobLogs(runId: number): Promise<readonly string[]>;
}

/** The REST pull request, as far as `PullRequest` reads it. */
export interface RawPullRequest {
  readonly number: number;
  readonly node_id: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly title: string;
  readonly body: string | null;
  readonly head: { readonly sha: string };
  readonly labels: readonly { readonly name: string }[];
}

export const toPullRequest = (raw: RawPullRequest): PullRequest => ({
  number: raw.number,
  nodeId: raw.node_id,
  state: raw.state,
  draft: raw.draft,
  headSha: raw.head.sha,
  title: raw.title,
  body: raw.body ?? "",
  labels: raw.labels.map((label) => label.name),
});

interface RawStatus {
  readonly context: string;
  readonly state: string;
  readonly target_url: string | null;
  readonly description: string | null;
  readonly creator: { readonly login: string } | null;
}

interface RawReview {
  readonly html_url: string;
  readonly commit_id: string | null;
  readonly body: string | null;
  readonly user: { readonly login: string } | null;
}

interface RawWorkflowRun {
  readonly id: number;
  readonly name: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly referenced_workflows?: readonly { readonly path: string }[] | null;
}

interface ThreadPage {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly nodes: readonly { readonly id: string }[];
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      };
    };
  };
}

const THREAD_IDS = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$after){nodes{id} pageInfo{hasNextPage endCursor}}
  }}
}`;

/** The reader over `transport`, for `repo` (`owner/name`). */
export const githubReader = (repo: string, transport: Transport): GitHubReader => {
  const [owner = "", name = ""] = repo.split("/");
  /** Every item of a paged listing, `items` out of each page, until a page comes back short. */
  const paged = async <T>(path: string, items: (page: unknown) => readonly T[]): Promise<T[]> => {
    const all: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const found = items(await transport.rest({ method: "GET", path: `${path}${separator}per_page=100&page=${page}` }));
      all.push(...found);
      if (found.length < 100) return all;
    }
  };
  return {
    pullRequest: async (number) =>
      toPullRequest((await transport.rest({ method: "GET", path: `/repos/${repo}/pulls/${number}` })) as RawPullRequest),
    commitStatuses: async (sha) => {
      const statuses: CommitStatus[] = [];
      for (let page = 1; ; page++) {
        const raw = (await transport.rest({
          method: "GET",
          path: `/repos/${repo}/commits/${sha}/statuses?per_page=100&page=${page}`,
        })) as readonly RawStatus[];
        statuses.push(
          ...raw.map((s) => ({
            context: s.context,
            state: s.state,
            targetUrl: s.target_url,
            description: s.description ?? "",
            creator: s.creator?.login ?? "",
          })),
        );
        if (raw.length < 100) return statuses;
      }
    },
    reviewThreadIds: async (number) => {
      const ids = new Set<string>();
      for (let after: string | null = null; ; ) {
        const data = (await transport.graphql(THREAD_IDS, { owner, name, number, after })) as ThreadPage;
        const threads = data.repository.pullRequest.reviewThreads;
        for (const node of threads.nodes) ids.add(node.id);
        if (!threads.pageInfo.hasNextPage || threads.pageInfo.endCursor === null) return ids;
        after = threads.pageInfo.endCursor;
      }
    },
    reviews: async (number) => {
      const reviews: Review[] = [];
      for (let page = 1; ; page++) {
        const raw = (await transport.rest({
          method: "GET",
          path: `/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`,
        })) as readonly RawReview[];
        reviews.push(
          ...raw.map((r) => ({ url: r.html_url, commit: r.commit_id ?? "", body: r.body ?? "", author: r.user?.login ?? "" })),
        );
        if (raw.length < 100) return reviews;
      }
    },
    pullRequestCommits: async (number) => {
      const commits: string[] = [];
      for (let page = 1; ; page++) {
        const raw = (await transport.rest({
          method: "GET",
          path: `/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`,
        })) as readonly { readonly sha: string }[];
        commits.push(...raw.map((commit) => commit.sha));
        if (raw.length < 100) return commits;
      }
    },
    branchTip: async (branch) => {
      const ref = branch.split("/").map(encodeURIComponent).join("/");
      const raw = (await transport.rest({ method: "GET", path: `/repos/${repo}/git/ref/heads/${ref}` })) as {
        readonly object: { readonly sha: string };
      };
      return raw.object.sha;
    },
    compare: async (base, head) => {
      const raw = (await transport.rest({
        method: "GET",
        path: `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
      })) as { readonly status: string };
      return raw.status;
    },
    checkRuns: (sha) =>
      paged(`/repos/${repo}/commits/${sha}/check-runs`, (page) =>
        (page as { readonly check_runs: readonly CheckRun[] }).check_runs.map((run) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
        })),
      ),
    latestStatuses: (sha) =>
      paged(`/repos/${repo}/commits/${sha}/status`, (page) =>
        (page as { readonly statuses: readonly LatestStatus[] }).statuses.map((status) => ({
          context: status.context,
          state: status.state,
        })),
      ),
    workflowRuns: (sha) =>
      paged(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}`, (page) =>
        (page as { readonly workflow_runs: readonly RawWorkflowRun[] }).workflow_runs.map((run) => ({
          id: run.id,
          name: run.name ?? "",
          status: run.status,
          conclusion: run.conclusion,
          url: run.html_url,
          referencedWorkflows: (run.referenced_workflows ?? []).map((called) => called.path),
        })),
      ),
    failedJobLogs: async (runId) => {
      const jobs = await paged(
        `/repos/${repo}/actions/runs/${runId}/jobs`,
        (page) => (page as { readonly jobs: readonly { readonly id: number; readonly conclusion: string | null }[] }).jobs,
      );
      const logs: string[] = [];
      for (const job of jobs) {
        if (job.conclusion !== "failure") continue;
        logs.push((await transport.rest({ method: "GET", path: `/repos/${repo}/actions/jobs/${job.id}/logs`, text: true })) as string);
      }
      return logs;
    },
  };
};
