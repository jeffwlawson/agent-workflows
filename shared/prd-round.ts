import { gh, git } from "./common.js";
import type { ProgressSubIssue } from "./progress-list.js";
import { SLICE_TRAILER, sliceRanges, type BranchCommit, type SliceRanges } from "./slice-ranges.js";

/**
 * A review round on a **PRD PR** (PRD #222, #244): what the review is told
 * about it, and what the advance job says on the parent when the round ends
 * without moving the chain on.
 *
 * A PRD PR is the PRD branch into the default branch, and every slice of the
 * PRD is built on it as commits. Each slice is reviewed in a **slice round**
 * scoped to that slice's commits, its **slice range**; after the last slice,
 * when more than one landed, the **final review** reads the whole PRD PR. The
 * finishing run records that the final review is requested in the PRD PR's
 * body, and the workflow tells the two apart from that mark before the runner
 * starts, so a run that fails before it gets here still knows which it was.
 *
 * The renderers are pure. `readSliceRound` is the one reader, run while the
 * token is still in hand.
 */

/** One commit of a slice range, as the brief describes it. */
export interface RangeCommit {
  readonly sha: string;
  readonly subject: string;
  /** More than one parent. */
  readonly merge: boolean;
  /**
   * For a merge, what it chose where its two sides conflicted: `git show
   * --remerge-diff`, which is empty for a merge that resolved nothing. Empty
   * for any other commit.
   */
  readonly resolution: string;
}

/** The slice a slice round reviews, and where it sits in the PRD. */
export interface RoundSlice {
  readonly subIssue: number;
  /** Slice `k` of `n`, counting from 1, in the sub-issue list's order. */
  readonly k: number;
  readonly n: number;
  /** The slice range, oldest first. */
  readonly commits: readonly RangeCommit[];
}

/**
 * The round a review of a PRD PR is. A slice round's `slice` is undefined
 * where it could not be told which slice is under review, with the reason:
 * the brief then asks for a review of the whole pull request, which is the
 * direction a guess should fail in.
 */
export type PrdRound =
  | { readonly kind: "final"; readonly parent: string }
  | {
      readonly kind: "slice";
      readonly parent: string;
      readonly slice: RoundSlice | undefined;
      readonly unknownBecause?: string;
    };

/** "slice k of n: #sub", or "the final review": what a round is called wherever it is named. */
export const roundName = (round: PrdRound): string => {
  if (round.kind === "final") return "the final review";
  if (round.slice === undefined) return "a slice round";
  return `slice ${round.slice.k} of ${round.slice.n}: #${round.slice.subIssue}`;
};

const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * A slice range's commits as the brief lists them. A merge is described by its
 * conflict resolution and nothing else: a merge that resolved nothing brings in
 * the base branch's own commits, which are not this slice's work and are left
 * out, while a resolution is code the loop (or a human) wrote and nothing has
 * reviewed yet.
 */
const describeCommits = (commits: readonly RangeCommit[]): string => {
  const lines: string[] = [];
  let clean = 0;
  for (const commit of commits) {
    if (!commit.merge) {
      lines.push(`- \`${shortSha(commit.sha)}\` ${commit.subject}`);
      continue;
    }
    if (commit.resolution.trim() === "") {
      clean += 1;
      continue;
    }
    lines.push(
      `- \`${shortSha(commit.sha)}\` ${commit.subject}: a merge whose **conflict resolution** is this slice's, ` +
        "and is reviewed like any other change in it. What the merge chose where its sides conflicted:",
      "",
      "  ```diff",
      ...commit.resolution.trimEnd().split("\n").map((line) => `  ${line}`),
      "  ```",
    );
  }
  if (clean > 0) {
    lines.push(
      `- (${clean} ${clean === 1 ? "merge" : "merges"} of the base branch that resolved no conflict, left out: ` +
        "what they bring in is the base branch's own work, not this slice's.)",
    );
  }
  return lines.length === 0 ? "- (none could be listed)" : lines.join("\n");
};

/**
 * What a slice round is told it is reading. The diff stays the whole PRD PR's
 * three-dot diff, and anchoring is unchanged; what this bounds is what may be
 * raised.
 */
export const renderSliceRoundBrief = (
  round: Extract<PrdRound, { kind: "slice" }>,
  branch: string,
  base: string,
): string => {
  const what =
    `This is a **slice round** on a **PRD PR**: the PRD branch \`${branch}\` into \`${base}\`, delivering ` +
    `PRD #${round.parent}. Every slice of the PRD is built as commits on this one branch, and each is ` +
    "reviewed in a round of its own on this pull request before the next one is built.";
  if (round.slice === undefined) {
    return [
      what,
      `Which slice this round reviews could not be told (${round.unknownBecause ?? "no reason given"}), so ` +
        "review the whole pull request on the bar of an ordinary one. Every open finding listed below is " +
        "carried and verified as on any round.",
    ].join("\n\n");
  }
  const { slice } = round;
  return [
    what,
    `This round reviews **slice ${slice.k} of ${slice.n}: #${slice.subIssue}**, the sub-issue the linked ` +
      "issue above describes; its acceptance criteria are the ones below. The slices before it were each " +
      "approved in a round of their own. Later slices are not written yet, so work the PRD gives to a later " +
      "slice is not missing from this one.",
    `This slice's commits, oldest first (\`git show <sha>\` reads one):\n\n${describeCommits(slice.commits)}`,
    [
      "What this round may raise:",
      "",
      `- The diff below is still the whole pull request's three-dot diff against \`${base}\`, and every ` +
        "finding anchors on a line it shows, as on any review.",
      "- **A finding must be caused by this slice's commits.**",
      "- A problem in an earlier slice's code that **this slice causes** (a caller it breaks, a contract it " +
        "changes) is this slice's: anchor it at **this slice's change** that causes it, not at the earlier code.",
      "- Earlier, already-approved code this slice does not touch is **not raised**, as a finding or as a " +
        "follow-up: its own round ruled on it.",
      "- Every open finding listed under the findings an earlier review raised is carried and verified as on " +
        "any round, whichever slice's round raised it.",
    ].join("\n"),
  ].join("\n\n");
};

/**
 * What the final review is told. The whole PRD PR, with no slice range: every
 * slice is built, and this is the one review that reads them together.
 */
export const renderFinalReviewBrief = (parent: string, branch: string, base: string): string =>
  [
    `This is the **final review** of a **PRD PR**: the PRD branch \`${branch}\` into \`${base}\`, delivering ` +
      `PRD #${parent}, which the linked issue above describes. Every slice of the PRD is built on this branch, ` +
      "and each was reviewed in a slice round of its own on this pull request. This review reads the whole " +
      "pull request, with no slice range.",
    "Review the whole change, as you would an ordinary pull request, and look in particular for what no " +
      "slice round could see because each saw one slice: slices that do not agree where one calls, reads or " +
      "configures what another wrote, two slices building the same thing their own way, and scaffolding one " +
      "slice left for a later one that was never used. Every open finding listed below is carried and " +
      "verified as on any round, whichever slice's round raised it, and nothing a maintainer declined is " +
      "raised again.",
  ].join("\n\n");

/**
 * Why a round ended without moving the chain on: #200's reasons for stopping,
 * and a run that did not finish.
 *
 * - `changes recommended`: changes were recommended and no automatic fix round
 *   starts, because the fix-round budget is 0 or `AGENT_PAT` is not set.
 * - `budget spent`: the automatic fix rounds are used up.
 * - `no progress`: the fix round before this review closed none of the
 *   findings it was given.
 * - `needs a closer look`: the review asks for a human.
 * - `failed`: the review did not finish, or its verdict was never posted.
 * - `post failed`: the review finished and its verdict was posted, but a later
 *   step of the posting job failed, so the chain cannot move on from it.
 */
export type ParkReason =
  | "changes recommended"
  | "budget spent"
  | "no progress"
  | "needs a closer look"
  | "failed"
  | "post failed";

/** An open finding, as the park comment lists it. */
export interface ParkFinding {
  readonly title: string;
  /** `path:line`, where there is one. */
  readonly anchor?: string;
  /** Its thread, or the review that raised it. */
  readonly url?: string;
}

export interface ParkInputs {
  readonly round: PrdRound;
  readonly prNumber: string;
  readonly reason: ParkReason;
  /** The review's own next-step line, which says the rest of why. Absent on a failed run. */
  readonly detail?: string;
  readonly findings: readonly ParkFinding[];
  /** The run, for a failed one. */
  readonly runUrl?: string;
}

/**
 * Where the posted review's URL goes in a park comment the runner writes. A
 * finding this round raised has no thread yet when the comment is written, so
 * it links the review, whose URL exists only once the posting job has posted
 * it; the advance job puts it in. Held equal to that job's copy by a test.
 */
export const REVIEW_URL_SLOT = "{{AGENT_REVIEW_URL}}";

/** The reason a round that ended on `verdict` stopped, or undefined where it moved on or a round is starting. */
export const parkReasonOf = (verdict: {
  readonly verdict: string;
  readonly stop?: "budget spent" | "no progress";
}): ParkReason | undefined => {
  if (verdict.verdict === "needs a closer look") return "needs a closer look";
  if (verdict.verdict === "changes recommended") return verdict.stop ?? "changes recommended";
  return undefined;
};

const REASONS: Readonly<Record<ParkReason, string>> = {
  "changes recommended":
    "the review recommended changes, and no automatic fix round starts (the fix-round budget is 0, or `AGENT_PAT` is not set)",
  "budget spent": "the automatic fix rounds are spent",
  "no progress": "no progress: the last fix round closed none of the findings it was given",
  "needs a closer look": "the review needs a closer look",
  failed: "the review didn't finish, or its verdict was never posted, so there is no verdict",
  "post failed":
    "the review finished and its verdict was posted, but a later step of posting it failed, so the chain cannot move on from it",
};

/**
 * The comment the advance job posts on the PRD's parent when a round ends
 * without approval: which round, why it stopped, what is open, and the ways on.
 * The parent is where a maintainer watching the chain looks, and without this
 * a parked chain says nothing there at all.
 */
export const renderParkComment = (inputs: ParkInputs): string => {
  const { round, prNumber, reason } = inputs;
  const where =
    round.kind === "final"
      ? `at the final review of PRD PR #${prNumber}`
      : `at ${round.slice === undefined ? "a slice round" : `slice ${round.slice.k} of ${round.slice.n}, #${round.slice.subIssue}`}, on PRD PR #${prNumber}`;
  const why = `**Why:** ${REASONS[reason]}.${inputs.detail === undefined ? "" : ` ${inputs.detail}`}${
    inputs.runUrl === undefined ? "" : ` [Workflow run](${inputs.runUrl})`
  }`;
  const listed = inputs.findings.map((f) => {
    const title = f.url === undefined ? f.title : `[${f.title}](${f.url})`;
    return `- ${title}${f.anchor === undefined ? "" : ` (\`${f.anchor}\`)`}`;
  });
  const findings =
    listed.length === 0
      ? `**Open findings:** none${reason === "failed" ? " from earlier rounds" : ""}.`
      : `**Open findings${reason === "failed" ? " from earlier rounds" : ""}:**\n\n${listed.join("\n")}`;
  const ways = [
    ...(reason === "failed" || reason === "post failed"
      ? [`- add \`agent:review\` to PRD PR #${prNumber} to run the review again;`]
      : []),
    `- add \`agent:fix\` to PRD PR #${prNumber} for another fix round;`,
    "- decline a finding by replying to it, then add `agent:review` there;",
    "- push a commit, then add `agent:review` there.",
  ];
  const then =
    round.kind === "final"
      ? "The PRD PR is marked ready for you once a review of its latest commit recommends approval."
      : "The chain moves on once a review of the PRD PR's latest commit recommends approval.";
  return [
    `**The PRD chain parked** ${where}.`,
    why,
    findings,
    `**Ways on:**\n\n${ways.join("\n")}\n\n${then}`,
  ].join("\n\n");
};

/** One commit of the PRD branch's first-parent log, with its subject. */
export interface PrdBranchCommit extends BranchCommit {
  readonly subject: string;
}

/** The PRD branch as every "which slice" question reads it. */
export interface PrdBranch {
  /** The parent's sub-issues, in the sub-issues API's order. */
  readonly subIssues: readonly ProgressSubIssue[];
  /** The first-parent log against the base, newest first. */
  readonly log: readonly PrdBranchCommit[];
  readonly ranges: SliceRanges;
}

/**
 * The PRD branch, read: its first-parent log against the base and the
 * parent's sub-issues, through `sliceRanges`, the one answer to "which slice".
 * The checkout is the PRD branch, with `base` a local ref. Throws where either
 * cannot be read.
 */
export const readPrdBranch = (parent: string, base: string): PrdBranch => {
  const subIssues = readSubIssues(parent);
  const log = git([
    "log",
    "--first-parent",
    `--format=%H%x1f%P%x1f%(trailers:key=${SLICE_TRAILER},valueonly,separator=%x2C)%x1f%s%x1e`,
    `${base}..HEAD`,
  ])
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record): PrdBranchCommit => {
      const [sha = "", parents = "", trailer = "", subject = ""] = record.split("\x1f");
      const number = /#(\d+)/.exec(trailer.split(",")[0] ?? "")?.[1];
      return { sha, parents: parents.split(" ").filter(Boolean), subject, slice: number === undefined ? null : Number(number) };
    });
  return { subIssues, log, ranges: sliceRanges(log, subIssues) };
};

/**
 * The slice a slice round reviews, read off the PRD branch by `readPrdBranch`.
 *
 * Never throws. A slice that cannot be told is `slice: undefined` with the
 * reason, which the brief turns into a review of the whole pull request.
 */
export const readSliceRound = (parent: string, base: string): Extract<PrdRound, { kind: "slice" }> => {
  try {
    const { log, ranges } = readPrdBranch(parent, base);
    const current = ranges.current;
    if (current === null) {
      return { kind: "slice", parent, slice: undefined, unknownBecause: `no commit on the branch carries an \`${SLICE_TRAILER}\` trailer` };
    }
    const range = ranges.slices.find((s) => s.subIssue === current.subIssue)?.range;
    const bySha = new Map(log.map((c) => [c.sha, c]));
    const commits = (range?.commits ?? []).map((sha): RangeCommit => {
      const commit = bySha.get(sha);
      const merge = (commit?.parents.length ?? 0) > 1;
      return {
        sha,
        subject: commit?.subject ?? "",
        merge,
        resolution: merge ? capped(git(["show", "--remerge-diff", "--format=", sha])) : "",
      };
    });
    return { kind: "slice", parent, slice: { ...current, commits } };
  } catch (error) {
    return {
      kind: "slice",
      parent,
      slice: undefined,
      unknownBecause: `the PRD branch's history could not be read: ${firstLine(error)}`,
    };
  }
};

/** An error's first line, for a reason or a warning. */
export const firstLine = (error: unknown): string =>
  error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);

/** A resolution longer than this is cut, and says where the rest is. */
const MAX_RESOLUTION_LINES = 200;

const capped = (diff: string): string => {
  const lines = diff.trimEnd().split("\n");
  return lines.length <= MAX_RESOLUTION_LINES
    ? diff
    : `${lines.slice(0, MAX_RESOLUTION_LINES).join("\n")}\n… (cut here; \`git show --remerge-diff\` shows the rest)`;
};

/** The parent's sub-issues, in the sub-issues API's order, which is execution order. */
const readSubIssues = (parent: string): ProgressSubIssue[] => {
  const repo = process.env["GH_REPO"] ?? "";
  const raw = gh([
    "api",
    "graphql",
    "-f",
    `owner=${repo.split("/")[0] ?? ""}`,
    "-f",
    `name=${repo.split("/")[1] ?? ""}`,
    "-F",
    `number=${parent}`,
    "-f",
    "query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { subIssues(first: 100) { nodes { number title state } } } } }",
  ]);
  const nodes = (
    JSON.parse(raw) as {
      data?: { repository?: { issue?: { subIssues?: { nodes?: ProgressSubIssue[] } } } };
    }
  ).data?.repository?.issue?.subIssues?.nodes;
  if (nodes === undefined) throw new Error(`could not read the sub-issues of #${parent}`);
  return nodes;
};
