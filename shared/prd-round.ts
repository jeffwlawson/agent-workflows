import { gh, git, isWorkflowBot } from "./common.js";
import { renderMergeDanger, type MergeDanger } from "./merge-danger.js";
import type { ProgressSubIssue } from "./progress-list.js";
import {
  readRedTestsBlock,
  renderEvidenceBySlice,
  withoutCarriedSections,
  type EvidenceInputs,
  type RedTestsRecord,
  type SliceRedTests,
} from "./red-check.js";
import {
  readCriteriaChanges,
  type CriterionChange,
  type FollowUp,
} from "./review-output.js";
import { sliceRanges, type BranchCommit, type SliceRanges } from "./slice-ranges.js";
import { CATCH_UP_TRAILER, SLICE_TRAILER } from "./record.js";

/**
 * A review round on a **PRD PR** (PRD #222, #244): what the review is told
 * about it, and what `review:advance` says on the parent when the round ends
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
      "slice left for a later one that was never used. Rule on **every** open finding listed below, " +
      "whichever slice's round raised it: one you leave unruled stays open and counts against this review. " +
      "Nothing a maintainer declined or resolved by hand is raised again, in any wording.",
  ].join("\n\n");

/**
 * What a slice round's record (#214) says of its sub-issue's acceptance
 * criteria, as the final review collects it (#247): the changed and unmet ones
 * from the round that approved the slice; no criteria checked, where every
 * round of the slice was handed none; or no record, where no review of the
 * slice could be read.
 */
export type SliceCriteriaRecord =
  | { readonly kind: "recorded"; readonly changes: readonly CriterionChange[] }
  | { readonly kind: "none checked" }
  | { readonly kind: "no record" };

export interface SliceCriteria {
  readonly subIssue: number;
  readonly record: SliceCriteriaRecord;
}

/** A review on the PRD PR, as the final review reads it: who posted it, its body, and the commit it reviewed. */
export interface PostedReview {
  readonly author: string;
  readonly body: string;
  readonly commit?: string;
}

/**
 * Each landed slice's criteria record (#247), read off the reviews on the PRD
 * PR, oldest first. A review belongs to the slice whose range holds the commit
 * it reviewed, through `sliceRanges`, the one answer to "which slice"; the
 * slice's record is the newest review of it that carries an *Acceptance
 * criteria* group, which is the round that approved it, since a slice moves on
 * only on an approval and the final review carries no such group. Only reviews
 * this loop posted: anyone may post a review, and this text goes into the PRD
 * PR's body.
 */
export const sliceCriteria = (reviews: readonly PostedReview[], ranges: SliceRanges): SliceCriteria[] =>
  ranges.slices.flatMap(({ subIssue, range }): SliceCriteria[] => {
    if (range === null) return [];
    const ofSlice = reviewsOf(reviews, range.commits);
    const recorded = ofSlice
      .map((review) => readCriteriaChanges(review.body))
      .filter((changes): changes is CriterionChange[] => changes !== undefined)
      .pop();
    if (recorded !== undefined) return [{ subIssue, record: { kind: "recorded", changes: recorded } }];
    return [{ subIssue, record: { kind: ofSlice.length > 0 ? "none checked" : "no record" } }];
  });

/** The reviews this loop posted of one slice: those whose reviewed commit is in its range, oldest first. */
const reviewsOf = (reviews: readonly PostedReview[], range: readonly string[]): PostedReview[] => {
  const commits = new Set(range);
  return reviews.filter(
    (review) => isWorkflowBot(review.author) && review.commit !== undefined && commits.has(review.commit),
  );
};

/**
 * Each landed slice's red tests (#235), read off the reviews on the PRD PR the
 * way `sliceCriteria` reads its criteria: the newest review of the slice that
 * carries the red check's record, which is the round that approved it.
 */
export const sliceRedTests = (reviews: readonly PostedReview[], ranges: SliceRanges): SliceRedTests[] =>
  ranges.slices.flatMap(({ subIssue, range }): SliceRedTests[] => {
    if (range === null) return [];
    const record = reviewsOf(reviews, range.commits)
      .map((review) => readRedTestsBlock(review.body))
      .filter((found): found is RedTestsRecord => found !== undefined)
      .pop();
    return [{ subIssue, record }];
  });

export interface PrdSummaryInputs {
  /** What the PRD delivered, as the final review wrote it: its `summary`, sketches and bullets included. */
  readonly outcome: string | undefined;
  /** The review's door, blast radius and breaking changes, for the Merge Danger (#356). */
  readonly danger: MergeDanger;
  /** Every landed slice's criteria record, in slice order; undefined where the PRD branch could not be read. */
  readonly slices: readonly SliceCriteria[] | undefined;
  /** The follow-ups this review recorded, which `follow-ups` files when the PRD PR merges. */
  readonly followUps: readonly FollowUp[];
  /**
   * Where the red check is configured, each landed slice's red tests (#235),
   * from `sliceRedTests`; `slices` undefined where the PRD branch could not be
   * read. Absent where it is not configured, and the Evidence says so in one
   * entry for the whole pull request (#355).
   */
  readonly redTests?: { readonly slices: readonly SliceRedTests[] | undefined } | undefined;
  /** CI's result at the head and the review's test sketches, for the Evidence's After and its tests (#355). */
  readonly evidence: EvidenceInputs;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const DIFFERS = "**Differs from the PRD:**";

/**
 * The sections a PRD summary had before #356, after its outcome. A body written
 * then carries them in the block the final review is handed back.
 */
const LEGACY_PRD_SECTIONS = /^### (?:Behaviour changes|Acceptance criteria changed or dropped|Known issues)[ \t]*$/m;

/**
 * The final review's outcome as it is its own (#356). The final review is
 * handed the whole block (`currentSummary`) and rewrites it whenever the head
 * moved, so what it keeps may carry the parts this render writes afresh: the
 * Evidence and the Merge Danger, cut as a regular summary's are; a *Differs
 * from the PRD* line, dropped wherever it stands; and a block written before
 * #356, its `### Outcome` heading taken off and its later sections cut.
 */
const ownOutcome = (outcome: string): string => {
  const cut = withoutCarriedSections(outcome);
  const at = LEGACY_PRD_SECTIONS.exec(cut)?.index ?? -1;
  return (at === -1 ? cut : cut.slice(0, at))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(DIFFERS) && !/^### Outcome[ \t]*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/**
 * The PRD PR's summary as the final review writes it (#247, #356), through
 * #218's splice, in the layout a regular pull request's has: the review's own
 * text, the outcome with its sketches and bullets; then a **Differs from the
 * PRD:** line per slice that changed or dropped a criterion, from that slice
 * round's record; then the Evidence (#355), each slice's failing-first tests
 * where the red check is configured (#235), from the same rounds, beside CI's
 * result at the head; then the Merge Danger, its known issues naming the
 * follow-ups filed when it merges. All but the review's text are the
 * workflow's to lay out, so a dropped criterion is named with its slice
 * whatever the model's formatting.
 *
 * A criterion its approving round left **unmet** is one a maintainer accepted
 * as it stands, by declining the finding it raised: so it is *dropped* here.
 * A slice whose record could not be read still gets its line, saying so,
 * since leaving it out would read as a slice that changed nothing.
 */
export const renderPrdSummary = (inputs: PrdSummaryInputs): string => {
  const outcome = ownOutcome(inputs.outcome ?? "") || "_The final review wrote no outcome._";
  const differs = (text: string): string => `${DIFFERS} ${text}`;
  const lines =
    inputs.slices === undefined
      ? [
          differs(
            "not known. The PRD branch's history could not be read, so the slices' records are not listed here; each slice round's review on this pull request has its own.",
          ),
        ]
      : inputs.slices.flatMap(({ subIssue, record }): string[] => {
          if (record.kind === "no record") {
            return [differs(`#${subIssue}: no review of this slice could be read, so whether it changed or dropped a criterion is not known.`)];
          }
          if (record.kind === "none checked" || record.changes.length === 0) return [];
          const changes = record.changes.map(
            (c) => `${c.status === "changed" ? "changed" : "dropped"}: ${oneLine(c.line)}`,
          );
          return [differs(`#${subIssue} ${changes.join("; ")}`)];
        });
  return [
    outcome,
    ...lines,
    renderEvidenceBySlice(inputs.redTests, inputs.evidence),
    renderMergeDanger(inputs.danger, inputs.followUps),
  ].join("\n\n");
};

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

/**
 * The round a park comment names: the final review, or a slice round with its
 * place, where it could be told. What `review` hands `review:advance` of a
 * `PrdRound`, which also carries the slice's commits.
 */
export type ParkRound =
  | { readonly kind: "final" }
  | { readonly kind: "slice"; readonly slice: Pick<RoundSlice, "subIssue" | "k" | "n"> | undefined };

export interface ParkInputs {
  readonly round: ParkRound;
  readonly prNumber: string;
  readonly reason: ParkReason;
  /** The review's own next-step line, which says the rest of why. Absent on a failed run. */
  readonly detail?: string;
  readonly findings: readonly ParkFinding[];
  /** The run, for a failed one. */
  readonly runUrl?: string;
}

/** The reason a round that ended on `verdict` stopped, or undefined where it moved on or a round is starting. */
export const parkReasonOf = (verdict: {
  readonly verdict: string;
  readonly stop?: "budget spent" | "no progress";
  readonly startsFixRound?: true;
}): Exclude<ParkReason, "failed" | "post failed"> | undefined => {
  if (verdict.verdict === "needs a closer look") return "needs a closer look";
  if (verdict.startsFixRound === true) return undefined;
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
 * The comment `review:advance` posts on the PRD's parent when a round ends
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
export const readPrdBranch = (repo: string, parent: string, base: string): PrdBranch => {
  const subIssues = readSubIssues(repo, parent);
  const log = git([
    "log",
    "--first-parent",
    `--format=%H%x1f%P%x1f%(trailers:key=${SLICE_TRAILER},valueonly,separator=%x2C)%x1f%(trailers:key=${CATCH_UP_TRAILER},valueonly,separator=%x2C)%x1f%s%x1e`,
    `${base}..HEAD`,
  ])
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record): PrdBranchCommit => {
      const [sha = "", parents = "", trailer = "", catchUp = "", subject = ""] = record.split("\x1f");
      const number = /#(\d+)/.exec(trailer.split(",")[0] ?? "")?.[1];
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        subject,
        slice: number === undefined ? null : Number(number),
        catchUp: catchUp.trim() !== "",
      };
    });
  return { subIssues, log, ranges: sliceRanges(log, subIssues) };
};

/**
 * The slice a slice round reviews, read off the PRD branch by `readPrdBranch`.
 *
 * Never throws. A slice that cannot be told is `slice: undefined` with the
 * reason, which the brief turns into a review of the whole pull request.
 */
export const readSliceRound = (repo: string, parent: string, base: string): Extract<PrdRound, { kind: "slice" }> => {
  try {
    const { log, ranges } = readPrdBranch(repo, parent, base);
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
const readSubIssues = (repo: string, parent: string): ProgressSubIssue[] => {
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
