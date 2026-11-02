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
  /** Whether it merged: a closed pull request may not have. */
  readonly merged: boolean;
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
  /** When it was set, as GitHub gives it, where the answer gave a time. */
  readonly createdAt?: string;
}

/** A review on a pull request, as far as a read-back of one needs it. */
export interface Review {
  readonly url: string;
  /** The commit it was posted on. */
  readonly commit: string;
  readonly body: string;
  /** The login that posted it. */
  readonly author: string;
  /** When it was submitted, where GitHub says: a pending review has no time. */
  readonly submittedAt?: string;
}

/**
 * A review as the review history reads it: what tells a submitted body from a
 * rewritten one, as well as what it says and who said it. `lastEditedAt` is
 * `null` for a body never edited.
 */
export interface ReviewHistoryEntry {
  readonly author: string;
  readonly body: string;
  readonly lastEditedAt: string | null;
  readonly url: string;
  /** The commit it was posted on, where GitHub says. */
  readonly commit?: string;
  /** When it was submitted, where GitHub says. */
  readonly submittedAt?: string;
}

/** An issue carrying a label, open or closed, its state and state reason in GraphQL's spelling. */
export interface LabelledIssue {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly stateReason: string | null;
  readonly body: string;
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

/** One time a label was added: when, and the login that added it, as REST spells it. */
export interface LabelEvent {
  readonly at: string;
  readonly actor: string;
}

/** A comment on a pull request's conversation, as far as a record naming it needs it. */
export interface ConversationComment {
  /** Its node id. */
  readonly id: string;
  /** The login that posted it, as GitHub's GraphQL API spells it. */
  readonly author: string;
  /** Its permalink. */
  readonly url: string;
}

/**
 * An issue's body or one of its comments, with who wrote it as far as a trust
 * gate needs it: the login, and its association with the repository in REST's
 * spelling (`OWNER`, `MEMBER`, `NONE`, ...). The reader applies no trust; the
 * caller does.
 */
export interface AuthoredText {
  readonly body: string;
  /** The login that wrote it, as REST spells it; `""` for a deleted account. */
  readonly author: string;
  readonly association: string;
}

/**
 * An issue's body with its author, and whether the number is an issue of this
 * repository at all: REST answers a pull request's number at the same path,
 * and follows an issue transferred out to the repository it went to.
 */
export interface IssueText extends AuthoredText {
  /** False for a pull request, or an issue transferred to another repository. */
  readonly isIssue: boolean;
}

/** An issue's place in the hierarchy, and its labels, as one query reads them together. */
export interface IssueShape {
  /** The issue it is a sub-issue of, where it is one. */
  readonly parent: number | undefined;
  /** How many sub-issues it has. */
  readonly subIssues: number;
  readonly labels: readonly string[];
}

/** One of an issue's sub-issues, as the sub-issues list gives it, its state in GraphQL's spelling. */
export interface SubIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED";
}

/** A branch and the commit it points at. */
export interface BranchRef {
  readonly name: string;
  readonly tip: string;
}

/** An open pull request, as far as telling its branches apart needs it. */
export interface PullRequestBranches {
  readonly number: number;
  readonly head: string;
  readonly base: string;
}

/** An issue another is blocked by, and whether it is still open. */
export interface Blocker {
  readonly number: number;
  readonly open: boolean;
}

/** A pull request as far as a link to it needs it. */
export interface PullRequestLink {
  readonly number: number;
  readonly url: string;
}

/**
 * A check on a commit, as GitHub's status rollup gives it, in GraphQL's
 * spelling (`COMPLETED`, `SUCCESS`, ...): a check run with its status and its
 * conclusion, `null` until it completes, or a status context with its state.
 * `required` is GitHub's own `isRequired` for the pull request asked about,
 * which reads rulesets and branch protection alike, with no admin read.
 */
export type CommitCheck =
  | { readonly kind: "checkRun"; readonly name: string; readonly status: string; readonly conclusion: string | null; readonly required: boolean }
  | { readonly kind: "status"; readonly context: string; readonly state: string; readonly required: boolean };

/** Whether a head has its base's tip in its history, or an answer that did not say. */
export type BaseCurrency = "behind" | "current" | "unknown";

/**
 * A login's permission on the repository, GitHub's role names, or `unknown`
 * where the answer named none of them: never read as `none`.
 */
export type RepositoryPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none" | "unknown";

/** An open pull request carrying a label, as far as deciding what to ask of it needs. */
export interface LabelledPullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly labels: readonly string[];
  /** Whether it is a draft, which nothing merges. */
  readonly draft: boolean;
}

export interface GitHubReader {
  pullRequest(number: number): Promise<PullRequest>;
  /**
   * The issue's parent, sub-issue count and labels, in **one** GraphQL query,
   * so every decision taken on them reads the same snapshot. An answer that
   * holds no issue throws rather than reading as an issue with no parent and
   * no sub-issues.
   */
  issueShape(number: number): Promise<IssueShape>;
  /**
   * The issue's sub-issues, in the list's order, which is the order a PRD's
   * chain builds them in: every page, past 100. An answer that holds no issue
   * throws, rather than reading as an issue with none, so a failed read can
   * never look like a chain whose every slice landed.
   */
  subIssues(number: number): Promise<readonly SubIssue[]>;
  /** The issues blocking the issue, by its `blocked_by` relations, that are still open, as the endpoint lists them. */
  openBlockers(number: number): Promise<readonly number[]>;
  /** Every issue blocking the issue, by its `blocked_by` relations, open or closed, as the endpoint lists them. */
  blockedBy(number: number): Promise<readonly Blocker[]>;
  /** The body of every comment on the issue, oldest first. */
  issueComments(number: number): Promise<readonly string[]>;
  /** The issue's body, or a pull request's, with its author, and which it is. */
  issueBody(number: number): Promise<IssueText>;
  /** Every comment on the issue or pull request's conversation, oldest first, each with its author: every page. */
  authoredComments(number: number): Promise<readonly AuthoredText[]>;
  /**
   * Every branch whose name starts with `prefix`, with its tip. The prefix is
   * the caller's, as a pattern is: a branch name is a record string.
   */
  branchesStarting(prefix: string): Promise<readonly BranchRef[]>;
  /**
   * The open pull requests from `head`, a branch of this repository, or into
   * `base`, or both, as the list endpoint filters them, with their branches.
   */
  openPullRequests(filter: { readonly head?: string; readonly base?: string }): Promise<readonly PullRequestBranches[]>;
  /** The message of every commit `head` has and `base` lacks, as the compare API lists them, every page. */
  commitMessages(base: string, head: string): Promise<readonly string[]>;
  /**
   * Every open pull request whose body `pattern` matches, newest first. The
   * pattern is the caller's: the engine spells no record string, and which
   * words close an issue is one.
   */
  openPullRequestsClosing(pattern: RegExp): Promise<readonly number[]>;
  /**
   * The open pull request from exactly `head`, a branch of this repository,
   * into exactly `base`, where there is one: GitHub allows one open pull
   * request per head and base, so the pair identifies it. What the
   * `openPullRequest` write reads back on a server error.
   */
  openPullRequest(head: string, base: string): Promise<PullRequestLink | undefined>;
  /** Every status set on `sha`, newest first, as the endpoint documents. */
  commitStatuses(sha: string): Promise<readonly CommitStatus[]>;
  /** The node id of every review thread on the pull request: what a thread target is checked against (#403). */
  reviewThreadIds(number: number): Promise<ReadonlySet<string>>;
  /** Every review on the pull request, oldest first, as the endpoint documents. */
  reviews(number: number): Promise<readonly Review[]>;
  /**
   * The newest 100 reviews on the pull request, oldest first, each with when
   * it was last edited: GraphQL, because REST gives no edit time. An answer
   * with no review list throws rather than reading as a pull request with no
   * reviews, and so does a review without the `lastEditedAt` field, which is
   * "nobody asked" rather than `null`'s "never edited".
   */
  reviewHistory(number: number): Promise<readonly ReviewHistoryEntry[]>;
  /**
   * Every issue carrying `label`, open and closed, newest first, up to
   * `LABELLED_ISSUES_LIMIT`: listed by the label, never searched, so no issue
   * stands in for another. The label is the caller's: the engine spells no
   * record string.
   */
  labelledIssues(label: string): Promise<readonly LabelledIssue[]>;
  /** The name of every label the repository has, every page. */
  repoLabels(): Promise<readonly string[]>;
  /**
   * When `label` was added to the issue or pull request, each time it was,
   * oldest first, off its timeline's events. The label is the caller's: the
   * engine spells no record string.
   */
  labelledAt(number: number, label: string): Promise<readonly string[]>;
  /**
   * Each time `label` was added to the issue or pull request, oldest first,
   * with who added it, off its timeline's events: `""` for a deleted account.
   * The label is the caller's: the engine spells no record string.
   */
  labelEvents(number: number, label: string): Promise<readonly LabelEvent[]>;
  /**
   * Every comment on the pull request's conversation, oldest first: what a
   * conversation comment target is checked against, and where its author and
   * link are read from (#468).
   */
  conversationComments(number: number): Promise<readonly ConversationComment[]>;
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
  /**
   * Every check run and status context on `sha`, each with whether it is
   * required for pull request `pullRequest`: every page. A commit with no
   * check at all has none; an answer that cannot be read throws, so a failed
   * read never looks like a commit with nothing left to wait for.
   */
  commitChecks(sha: string, pullRequest: number): Promise<readonly CommitCheck[]>;
  /**
   * Whether `base`'s tip is in `head`'s history, by the compare API's
   * `behind_by`: `current` where none of `base`'s commits is missing from
   * `head`, `behind` where any is, `unknown` where the answer gave no count.
   */
  behindBase(base: string, head: string): Promise<BaseCurrency>;
  /**
   * `login`'s permission on the repository. Built over the loop's token for
   * the labeller check: whether the workflow token may ask is #77's open
   * question. A refused call throws, as every read here does.
   */
  permission(login: string): Promise<RepositoryPermission>;
  /**
   * The open pull requests into `base` carrying `label`, newest first, every
   * page. The label is the caller's: the engine spells no record string.
   */
  openPullRequestsLabelled(base: string, label: string): Promise<readonly LabelledPullRequest[]>;
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
  readonly merged?: boolean;
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
  // Literally `true`, as `follow-ups.yml`'s condition reads it.
  merged: raw.merged === true,
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
  readonly created_at?: string;
}

interface RawReview {
  readonly html_url: string;
  readonly commit_id: string | null;
  readonly body: string | null;
  readonly user: { readonly login: string } | null;
  readonly submitted_at?: string | null;
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

interface CommentPage {
  readonly repository: {
    readonly pullRequest: {
      readonly comments: {
        readonly nodes: readonly { readonly id: string; readonly url: string; readonly author: { readonly login: string } | null }[];
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      };
    };
  };
}

/**
 * GraphQL rather than REST, so an id and a login are spelled as the fix
 * runner's feedback fetch spells them: the node id it offers an outcome on,
 * and a bot's login without `[bot]`.
 */
const CONVERSATION_COMMENTS = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    comments(first:100,after:$after){nodes{id url author{login}} pageInfo{hasNextPage endCursor}}
  }}
}`;

/**
 * The newest 100 by `last:`, since the newest block wins and a pull request
 * with more reviews than fit must lose the oldest, never the newest. The repo
 * name is a `String!` variable, so one spelled in digits is still sent as a
 * string.
 */
const REVIEW_HISTORY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    reviews(last:100){nodes{body url lastEditedAt submittedAt author{login} commit{oid}}}
  }}
}`;

interface RawHistoryReview {
  readonly body?: string | null;
  readonly url?: string;
  readonly lastEditedAt?: string | null;
  readonly submittedAt?: string | null;
  readonly author?: { readonly login?: string } | null;
  readonly commit?: { readonly oid?: string } | null;
}

/**
 * How many issues `labelledIssues` reads. A label's issues only grow, closed
 * ones staying in the listing, and it is newest first, so what falls off the
 * end is the oldest.
 */
export const LABELLED_ISSUES_LIMIT = 500;

/** GraphQL rather than REST, whose issue list holds pull requests too, and spells state reasons otherwise. */
const LABELLED_ISSUES = `query($owner:String!,$name:String!,$label:String!,$after:String){
  repository(owner:$owner,name:$name){
    issues(labels:[$label],states:[OPEN,CLOSED],first:100,after:$after,orderBy:{field:CREATED_AT,direction:DESC}){
      nodes{number url state stateReason body} pageInfo{hasNextPage endCursor}
    }
  }
}`;

interface LabelledIssuePage {
  readonly repository: {
    readonly issues: {
      readonly nodes: readonly { readonly number: number; readonly url: string; readonly state: string; readonly stateReason: string | null; readonly body: string | null }[];
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
    };
  } | null;
}

interface ShapeAnswer {
  readonly repository: {
    readonly issue: {
      readonly parent: { readonly number: number } | null;
      readonly subIssues: { readonly totalCount: number };
      readonly labels: { readonly nodes: readonly { readonly name: string }[] };
    } | null;
  } | null;
}

interface SubIssuePage {
  readonly repository: {
    readonly issue: {
      readonly subIssues: {
        readonly nodes: readonly SubIssue[];
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      };
    } | null;
  } | null;
}

const SUB_ISSUES = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){issue(number:$number){
    subIssues(first:100,after:$after){nodes{number title state} pageInfo{hasNextPage endCursor}}
  }}
}`;

/** The first hundred labels, as the shell pre-flight this replaced read them. */
const ISSUE_SHAPE = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){issue(number:$number){
    parent{number} subIssues(first:1){totalCount} labels(first:100){nodes{name}}
  }}
}`;

/**
 * GraphQL rather than REST, for `isRequired`: REST says which checks a branch
 * requires only to an admin, and only for branch protection, not rulesets.
 */
const COMMIT_CHECKS = `query($owner:String!,$name:String!,$sha:GitObjectID!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){object(oid:$sha){... on Commit{
    statusCheckRollup{contexts(first:100,after:$after){
      nodes{__typename
        ... on CheckRun{name status conclusion isRequired(pullRequestNumber:$number)}
        ... on StatusContext{context state isRequired(pullRequestNumber:$number)}
      }
      pageInfo{hasNextPage endCursor}
    }}
  }}}
}`;

/** One rollup entry read as a check, or a throw where it is neither kind GitHub documents. */
const toCommitCheck = (node: unknown, sha: string): CommitCheck => {
  const unreadable = (): never => {
    throw new Error(`A check on ${sha} came back in a shape that cannot be read, so whether it passed cannot be established.`);
  };
  if (typeof node !== "object" || node === null) return unreadable();
  const raw = node as Readonly<Record<string, unknown>>;
  const required = raw["isRequired"];
  if (typeof required !== "boolean") return unreadable();
  const { __typename: kind, name, status, conclusion, context, state } = raw;
  if (kind === "CheckRun" && typeof name === "string" && typeof status === "string" && (conclusion === null || typeof conclusion === "string")) {
    return { kind: "checkRun", name, status, conclusion, required };
  }
  if (kind === "StatusContext" && typeof context === "string" && typeof state === "string") {
    return { kind: "status", context, state, required };
  }
  return unreadable();
};

const PERMISSIONS: ReadonlySet<string> = new Set(["admin", "maintain", "write", "triage", "read", "none"]);

/** An issue or a comment as REST gives it, as far as `AuthoredText` reads it. */
interface RawAuthored {
  readonly body?: string | null;
  readonly user?: { readonly login?: string } | null;
  readonly author_association?: string;
}

/** An issue as REST gives it, as far as `IssueText` reads it. */
interface RawIssue extends RawAuthored {
  readonly pull_request?: unknown;
  readonly repository_url?: string;
}

const authored = (raw: RawAuthored): AuthoredText => ({
  body: raw.body ?? "",
  author: raw.user?.login ?? "",
  association: raw.author_association ?? "NONE",
});

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
    issueShape: async (number) => {
      const data = (await transport.graphql(ISSUE_SHAPE, { owner, name, number })) as ShapeAnswer | undefined;
      const issue = data?.repository?.issue;
      if (issue === null || issue === undefined) throw new Error(`The shape of issue #${number} came back empty.`);
      return {
        parent: issue.parent?.number,
        subIssues: issue.subIssues.totalCount,
        labels: issue.labels.nodes.map((label) => label.name),
      };
    },
    subIssues: async (number) => {
      const all: SubIssue[] = [];
      for (let after: string | null = null; ; ) {
        const data = (await transport.graphql(SUB_ISSUES, { owner, name, number, after })) as SubIssuePage | undefined;
        const page = data?.repository?.issue?.subIssues;
        if (page === undefined) throw new Error(`The sub-issues of issue #${number} came back empty.`);
        all.push(...page.nodes.map((node) => ({ number: node.number, title: node.title, state: node.state })));
        if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) return all;
        after = page.pageInfo.endCursor;
      }
    },
    blockedBy: async (number) =>
      (
        await paged(
          `/repos/${repo}/issues/${number}/dependencies/blocked_by`,
          (page) => page as readonly { readonly number: number; readonly state: string }[],
        )
      ).map((issue) => ({ number: issue.number, open: issue.state === "open" })),
    issueComments: async (number) =>
      (await paged(`/repos/${repo}/issues/${number}/comments`, (page) => page as readonly { readonly body: string | null }[])).map(
        (comment) => comment.body ?? "",
      ),
    issueBody: async (number) => {
      const raw = (await transport.rest({ method: "GET", path: `/repos/${repo}/issues/${number}` })) as RawIssue;
      // A transferred issue is answered from where it went, by redirect.
      const here = raw.repository_url === undefined || raw.repository_url.toLowerCase().endsWith(`/repos/${repo}`.toLowerCase());
      return { ...authored(raw), isIssue: raw.pull_request === undefined && here };
    },
    authoredComments: async (number) =>
      (await paged(`/repos/${repo}/issues/${number}/comments`, (page) => page as readonly RawAuthored[])).map(authored),
    branchesStarting: async (prefix) => {
      const ref = prefix.split("/").map(encodeURIComponent).join("/");
      const raw = (await transport.rest({ method: "GET", path: `/repos/${repo}/git/matching-refs/heads/${ref}` })) as readonly {
        readonly ref: string;
        readonly object: { readonly sha: string };
      }[];
      return raw.map((found) => ({ name: found.ref.replace(/^refs\/heads\//, ""), tip: found.object.sha }));
    },
    openPullRequests: async (filter) => {
      const query = [
        "state=open",
        ...(filter.head === undefined ? [] : [`head=${encodeURIComponent(`${owner}:${filter.head}`)}`]),
        ...(filter.base === undefined ? [] : [`base=${encodeURIComponent(filter.base)}`]),
      ].join("&");
      return (
        await paged(
          `/repos/${repo}/pulls?${query}`,
          (page) => page as readonly { readonly number: number; readonly head: { readonly ref: string }; readonly base: { readonly ref: string } }[],
        )
      ).map((pr) => ({ number: pr.number, head: pr.head.ref, base: pr.base.ref }));
    },
    commitMessages: async (base, head) =>
      paged(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, (page) =>
        (page as { readonly commits: readonly { readonly commit: { readonly message: string } }[] }).commits.map((c) => c.commit.message),
      ),
    openBlockers: async (number) =>
      (
        await paged(
          `/repos/${repo}/issues/${number}/dependencies/blocked_by`,
          (page) => page as readonly { readonly number: number; readonly state: string }[],
        )
      )
        .filter((issue) => issue.state === "open")
        .map((issue) => issue.number),
    openPullRequestsClosing: async (pattern) =>
      (
        await paged(
          `/repos/${repo}/pulls?state=open`,
          (page) => page as readonly { readonly number: number; readonly body: string | null }[],
        )
      )
        .filter((pr) => pattern.test(pr.body ?? ""))
        .map((pr) => pr.number),
    openPullRequest: async (head, base) => {
      const query = `state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`;
      const found = (
        await paged(
          `/repos/${repo}/pulls?${query}`,
          (page) =>
            page as readonly {
              readonly number: number;
              readonly html_url: string;
              readonly head: { readonly ref: string; readonly repo: { readonly full_name: string } | null };
              readonly base: { readonly ref: string };
            }[],
        )
      ).find((pr) => pr.head.ref === head && pr.head.repo?.full_name === repo && pr.base.ref === base);
      return found === undefined ? undefined : { number: found.number, url: found.html_url };
    },
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
            ...(typeof s.created_at === "string" ? { createdAt: s.created_at } : {}),
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
          ...raw.map((r) => ({
            url: r.html_url,
            commit: r.commit_id ?? "",
            body: r.body ?? "",
            author: r.user?.login ?? "",
            ...(typeof r.submitted_at === "string" ? { submittedAt: r.submitted_at } : {}),
          })),
        );
        if (raw.length < 100) return reviews;
      }
    },
    reviewHistory: async (number) => {
      const data = (await transport.graphql(REVIEW_HISTORY, { owner, repo: name, number })) as
        | { readonly repository?: { readonly pullRequest?: { readonly reviews?: { readonly nodes?: unknown } | null } | null } | null }
        | undefined;
      const nodes = data?.repository?.pullRequest?.reviews?.nodes;
      if (!Array.isArray(nodes)) {
        throw new Error(`The reviews on #${number} could not be read: the GraphQL response carried no review list.`);
      }
      return nodes.map((node: unknown) => {
        if (typeof node !== "object" || node === null || Array.isArray(node)) {
          throw new Error(`A review on #${number} came back as something other than a review.`);
        }
        // Absent is not `null`: `null` is "never edited", absent is "nobody
        // asked", and reading the second as the first lets an edited body through.
        if (!("lastEditedAt" in node)) {
          throw new Error(`A review on #${number} came back without \`lastEditedAt\`, so whether it was edited cannot be established.`);
        }
        const review = node as RawHistoryReview;
        return {
          author: review.author?.login ?? "",
          body: review.body ?? "",
          lastEditedAt: review.lastEditedAt ?? null,
          url: review.url ?? "",
          ...(typeof review.commit?.oid === "string" ? { commit: review.commit.oid } : {}),
          ...(typeof review.submittedAt === "string" ? { submittedAt: review.submittedAt } : {}),
        };
      });
    },
    labelledIssues: async (label) => {
      const issues: LabelledIssue[] = [];
      for (let after: string | null = null; ; ) {
        const data = (await transport.graphql(LABELLED_ISSUES, { owner, name, label, after })) as LabelledIssuePage | undefined;
        const page = data?.repository?.issues;
        if (page === undefined) throw new Error(`The issues labelled ${label} came back empty.`);
        issues.push(
          ...page.nodes.map((node) => ({ number: node.number, url: node.url, state: node.state, stateReason: node.stateReason, body: node.body ?? "" })),
        );
        if (issues.length >= LABELLED_ISSUES_LIMIT) return issues.slice(0, LABELLED_ISSUES_LIMIT);
        if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) return issues;
        after = page.pageInfo.endCursor;
      }
    },
    repoLabels: async () =>
      (await paged(`/repos/${repo}/labels`, (page) => page as readonly { readonly name: string }[])).map((label) => label.name),
    labelledAt: async (number, label) =>
      (
        await paged(
          `/repos/${repo}/issues/${number}/events`,
          (page) => page as readonly { readonly event: string; readonly label?: { readonly name: string } | null; readonly created_at: string }[],
        )
      )
        .filter((event) => event.event === "labeled" && event.label?.name === label)
        .map((event) => event.created_at),
    labelEvents: async (number, label) =>
      (
        await paged(
          `/repos/${repo}/issues/${number}/events`,
          (page) =>
            page as readonly {
              readonly event: string;
              readonly label?: { readonly name: string } | null;
              readonly actor?: { readonly login: string } | null;
              readonly created_at: string;
            }[],
        )
      )
        .filter((event) => event.event === "labeled" && event.label?.name === label)
        .map((event) => ({ at: event.created_at, actor: event.actor?.login ?? "" })),
    conversationComments: async (number) => {
      const comments: ConversationComment[] = [];
      for (let after: string | null = null; ; ) {
        const data = (await transport.graphql(CONVERSATION_COMMENTS, { owner, name, number, after })) as CommentPage;
        const page = data.repository.pullRequest.comments;
        comments.push(...page.nodes.map((node) => ({ id: node.id, author: node.author?.login ?? "unknown", url: node.url })));
        if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) return comments;
        after = page.pageInfo.endCursor;
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
    commitChecks: async (sha, pullRequest) => {
      const checks: CommitCheck[] = [];
      for (let after: string | null = null; ; ) {
        const data = (await transport.graphql(COMMIT_CHECKS, { owner, name, sha, number: pullRequest, after })) as
          | { readonly repository?: { readonly object?: Readonly<Record<string, unknown>> | null } | null }
          | undefined;
        const commit = data?.repository?.object;
        if (commit === undefined || commit === null || !("statusCheckRollup" in commit)) {
          throw new Error(`The checks on ${sha} could not be read: the answer held no commit.`);
        }
        // `null` is GitHub's answer for a commit with no check and no status at all.
        const rollup = commit["statusCheckRollup"] as { readonly contexts?: unknown } | null;
        if (rollup === null) return checks;
        const contexts = rollup.contexts as
          | { readonly nodes?: unknown; readonly pageInfo?: { readonly hasNextPage?: unknown; readonly endCursor?: unknown } }
          | undefined;
        if (!Array.isArray(contexts?.nodes) || typeof contexts.pageInfo?.hasNextPage !== "boolean") {
          throw new Error(`The checks on ${sha} could not be read: the answer held no list of them.`);
        }
        checks.push(...contexts.nodes.map((node: unknown) => toCommitCheck(node, sha)));
        const cursor = contexts.pageInfo.endCursor;
        if (!contexts.pageInfo.hasNextPage) return checks;
        if (typeof cursor !== "string") throw new Error(`The checks on ${sha} could not be read past their first ${checks.length}.`);
        after = cursor;
      }
    },
    // The compare API rather than the pull request's `mergeable_state`: that
    // is computed after the read, answering `unknown` until it is, and says
    // `behind` only where the base requires a branch up to date, folding the
    // rest into `blocked` or `unstable` beside the checks. `behind_by` is the
    // one fact asked for, and counts on any base.
    behindBase: async (base, head) => {
      const raw = (await transport.rest({
        method: "GET",
        path: `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
      })) as { readonly behind_by?: unknown } | null | undefined;
      const behind = raw?.behind_by;
      if (typeof behind !== "number" || !Number.isInteger(behind) || behind < 0) return "unknown";
      return behind === 0 ? "current" : "behind";
    },
    permission: async (login) => {
      const raw = (await transport.rest({ method: "GET", path: `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission` })) as
        | { readonly permission?: unknown; readonly role_name?: unknown }
        | null
        | undefined;
      // `role_name` tells maintain and triage apart, which the older
      // `permission` folds into write and read; a custom role has a name of
      // its own, and is read by the base role `permission` gives.
      for (const named of [raw?.role_name, raw?.permission]) {
        if (typeof named === "string" && PERMISSIONS.has(named)) return named as RepositoryPermission;
      }
      return "unknown";
    },
    openPullRequestsLabelled: async (base, label) =>
      (
        await paged(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`, (page) => {
          if (!Array.isArray(page)) throw new Error(`The open pull requests into ${base} could not be read: the answer was not a list.`);
          return page as readonly { readonly number: number; readonly draft?: unknown; readonly head?: { readonly sha?: string }; readonly labels?: readonly { readonly name: string }[] }[];
        })
      )
        .map((pr) => {
          if (typeof pr.head?.sha !== "string" || !Array.isArray(pr.labels) || typeof pr.draft !== "boolean") {
            throw new Error(`Open pull request #${pr.number} into ${base} came back without its head, its labels or whether it is a draft.`);
          }
          return { number: pr.number, headSha: pr.head.sha, labels: pr.labels.map((l) => l.name), draft: pr.draft };
        })
        .filter((pr) => pr.labels.includes(label)),
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
