/**
 * PROTOTYPE (#399), throwaway. The GitHub reader a command is handed beside
 * its writers (ADR 0005): the live state a decision or a target check needs.
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
  readonly creator: string;
}

export interface GitHubReader {
  pull(number: number): Promise<PullRequest>;
  /** Newest first, as the endpoint documents. */
  statuses(sha: string): Promise<readonly CommitStatus[]>;
  /** Every review thread's node id on the pull request: what a thread target is checked against (#403). */
  reviewThreadIds(number: number): Promise<ReadonlySet<string>>;
}

interface RawPull {
  number: number;
  node_id: string;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  body: string | null;
  head: { sha: string };
  labels: { name: string }[];
}

export const toPullRequest = (raw: RawPull): PullRequest => ({
  number: raw.number,
  nodeId: raw.node_id,
  state: raw.state,
  draft: raw.draft,
  headSha: raw.head.sha,
  title: raw.title,
  body: raw.body ?? "",
  labels: raw.labels.map((label) => label.name),
});

export const githubReader = (repo: string, transport: Transport): GitHubReader => ({
  pull: async (number) => toPullRequest((await transport.rest({ method: "GET", path: `/repos/${repo}/pulls/${number}` })) as RawPull),
  statuses: async (sha) => {
    const raw = (await transport.rest({ method: "GET", path: `/repos/${repo}/commits/${sha}/statuses?per_page=100` })) as {
      context: string;
      state: string;
      target_url: string | null;
      creator: { login: string };
    }[];
    return raw.map((s) => ({ context: s.context, state: s.state, targetUrl: s.target_url, creator: s.creator.login }));
  },
  reviewThreadIds: async (number) => {
    const [owner = "", name = ""] = repo.split("/");
    const data = (await transport.graphql(
      `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id}}}}}`,
      { owner, name, number },
    )) as { repository: { pullRequest: { reviewThreads: { nodes: { id: string }[] } } } };
    return new Set(data.repository.pullRequest.reviewThreads.nodes.map((node) => node.id));
  },
});
