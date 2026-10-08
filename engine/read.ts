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

export interface GitHubReader {
  pullRequest(number: number): Promise<PullRequest>;
  /** Every status set on `sha`, newest first, as the endpoint documents. */
  commitStatuses(sha: string): Promise<readonly CommitStatus[]>;
  /** The node id of every review thread on the pull request: what a thread target is checked against (#403). */
  reviewThreadIds(number: number): Promise<ReadonlySet<string>>;
  /** Every review on the pull request, oldest first, as the endpoint documents. */
  reviews(number: number): Promise<readonly Review[]>;
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
  readonly creator: { readonly login: string } | null;
}

interface RawReview {
  readonly html_url: string;
  readonly commit_id: string | null;
  readonly body: string | null;
  readonly user: { readonly login: string } | null;
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
          ...raw.map((s) => ({ context: s.context, state: s.state, targetUrl: s.target_url, creator: s.creator?.login ?? "" })),
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
  };
};
