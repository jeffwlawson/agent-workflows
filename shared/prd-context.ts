import { gh, git, isTrustedAuthor } from "./common.js";

/**
 * What an **integration review** of a PRD PR is told about the chain behind it
 * (#179, PRD #171). A PRD PR is the PRD branch into the base branch, and the
 * one pull request of a chain a human merges; every slice on it was either a
 * slice PR with a review round of its own, or built before slice PRs existed
 * and reviewed by nothing yet. The integration review looks only at what spans
 * slices — except for the two things no slice round saw, which this names.
 *
 * Read while the token is still in hand, like the rest of the review's context.
 * Each fact is `undefined` when it could not be read, never an empty list:
 * "no slice was built before slice PRs" and "could not tell" send the review
 * to opposite amounts of work, and only one of them is safe to assume.
 */
export interface PrdContext {
  /** The PRD's issue, from the PRD branch's name. */
  readonly parent: string;
  /** The slice PRs merged into the PRD branch, in merge order. */
  readonly slicePrs: readonly SlicePr[] | undefined;
  /** Closed sub-issues no slice PR built: slices a pre-upgrade chain built straight onto the PRD branch. */
  readonly preUpgrade: readonly PreUpgradeSlice[] | undefined;
  /** Merge commits on the PRD branch whose conflicts an agent resolved, as `update-branch` named them. */
  readonly resolvedMerges: readonly string[] | undefined;
}

export interface SlicePr {
  readonly number: number;
  /** The sub-issue it built, or undefined where neither its body nor its branch says. */
  readonly subIssue: number | undefined;
}

export interface PreUpgradeSlice {
  readonly subIssue: number;
  /** Commits on the PRD branch whose message names the sub-issue — how a pre-upgrade chain committed a slice. */
  readonly commits: readonly string[];
}

/**
 * The marker `update-branch` writes on a draft PRD PR when it resolves a
 * conflict there (#178), instead of asking for a review of a partial chain.
 */
const RESOLVED_MERGE = /<!-- agent-resolved-merge ([0-9a-f]{7,40}) -->/g;

const repoParts = (): { owner: string; name: string } => {
  const repo = process.env["GH_REPO"] ?? "";
  return { owner: repo.split("/")[0] ?? "", name: repo.split("/")[1] ?? "" };
};

/** `f` or undefined: a read that failed is a fact nobody has, not an empty one. */
const orUnknown = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch (error) {
    console.log(`PRD PR context: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

/**
 * The sub-issue a slice PR built — `Part of #<n>` in its body, or failing that
 * its slice branch's name — the same reading `implement-prd` gives a row of the
 * slices table.
 */
const sliceOf = (parent: string, pr: { body?: string | null; headRefName?: string }): number | undefined => {
  const fromBody = /Part of #(\d+)/.exec(pr.body ?? "")?.[1];
  const fromBranch = new RegExp(`^agent/slice-${parent}-(\\d+)-`).exec(pr.headRefName ?? "")?.[1];
  const n = fromBody ?? fromBranch;
  return n === undefined ? undefined : Number(n);
};

const closedSubIssues = (parent: string): number[] => {
  const { owner, name } = repoParts();
  const raw = gh([
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${parent}`,
    "-f",
    "query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { subIssues(first: 100) { nodes { number state } } } } }",
  ]);
  const nodes = (
    JSON.parse(raw) as {
      data?: { repository?: { issue?: { subIssues?: { nodes?: { number: number; state: string }[] } } } };
    }
  ).data?.repository?.issue?.subIssues?.nodes;
  if (nodes === undefined) throw new Error(`could not read the sub-issues of #${parent}`);
  return nodes.filter((node) => node.state === "CLOSED").map((node) => node.number);
};

/** Commits on the PRD branch, not on its base, whose message names `#<subIssue>)`. */
const commitsNaming = (baseRef: string, subIssue: number): string[] =>
  git(["log", "--format=%h", "--fixed-strings", `--grep=(#${subIssue})`, `${baseRef}..HEAD`])
    .split("\n")
    .filter((line) => line !== "");

/**
 * A SHA a trusted comment named, kept only when it is a merge commit this PRD
 * PR actually carries. A marker is text anyone trusted can write — the failure
 * `update-branch` reports tells a human to write one — so it is checked against
 * the history rather than believed.
 */
const isMergeOnHead = (sha: string): boolean => {
  try {
    git(["merge-base", "--is-ancestor", sha, "HEAD"]);
    return git(["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").length > 2;
  } catch {
    return false;
  }
};

const resolvedMerges = (prNumber: string): string[] => {
  const { owner, name } = repoParts();
  const pages = JSON.parse(
    gh(["api", `repos/${owner}/${name}/issues/${prNumber}/comments`, "--paginate", "--slurp"]),
  ) as { body?: string; author_association?: string; user?: { login?: string } }[][];

  const shas = pages
    .flat()
    .filter((c) => isTrustedAuthor(c.author_association, c.user?.login))
    .flatMap((c) => [...(c.body ?? "").matchAll(RESOLVED_MERGE)].map((m) => m[1] ?? ""));
  return [...new Set(shas)].filter(isMergeOnHead);
};

/**
 * Everything an integration review is told about its PRD PR. `prdBranch` is the
 * PRD PR's head, `baseRef` its base; the checkout is the PRD PR's head.
 */
export const fetchPrdContext = (parent: string, prdBranch: string, baseRef: string, prNumber: string): PrdContext => {
  // Every state, as the finishing run counts them: a slice PR closed unmerged
  // still built its sub-issue's number, and rules it out as pre-upgrade.
  const pulls = orUnknown(
    () =>
      JSON.parse(
        gh([
          "pr",
          "list",
          "--state",
          "all",
          "--base",
          prdBranch,
          "--limit",
          "1000",
          "--json",
          "number,state,body,headRefName,mergedAt",
        ]),
      ) as { number: number; state: string; body?: string | null; headRefName?: string; mergedAt?: string | null }[],
  );

  const slicePrs = pulls
    ?.filter((pr) => pr.state === "MERGED")
    .sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? ""))
    .map((pr) => ({ number: pr.number, subIssue: sliceOf(parent, pr) }));

  const built = new Set(pulls?.map((pr) => sliceOf(parent, pr)).filter((n) => n !== undefined));
  const closed = pulls === undefined ? undefined : orUnknown(() => closedSubIssues(parent));
  const preUpgrade = closed
    ?.filter((n) => !built.has(n))
    .map((subIssue) => ({ subIssue, commits: orUnknown(() => commitsNaming(baseRef, subIssue)) ?? [] }));

  return {
    parent,
    slicePrs,
    preUpgrade,
    resolvedMerges: orUnknown(() => resolvedMerges(prNumber)),
  };
};
