import type { Verdict } from "./review-output.js";
import type { RoundCount, RoundCounts } from "./round-header.js";
import type { SliceRanges } from "./slice-ranges.js";

/**
 * The **progress list** in a PRD PR's body (PRD #222, #246): since #298 a
 * table, one row per sub-issue, saying where the chain is, with each slice's
 * reviews, fix rounds and diff, so a maintainer reads the chain's state off the
 * PRD PR rather than off closed issues or state labels. Like
 * the `Closes` block beside it, it is workflow-owned, between its own
 * markers, which the review's rewrite of the summary (#218) splices around
 * byte for byte.
 *
 * **Re-rendered from live state, never edited incrementally.** Every
 * `implement-prd` run that builds renders it as its round is asked for, and
 * the advance job writes the one the review rendered for how its round ended.
 * The two jobs that run no toolchain and still write it, the gate showing a
 * slice building (#312) and the finishing run requesting the final review,
 * each rewrite one row in place to exactly what this renders, held equal by a
 * test. So each render is a pure function of the
 * sub-issues, the slice ranges, the head's verdict, what is running, the
 * finishing state and the rounds counted off the PRD PR, and a render from
 * unchanged state is byte for byte the one before it. The **status line** at
 * the top of the PRD PR's note is rendered from the same state, beside it.
 *
 * It also holds the final review's mark, which the finishing run records and
 * every review of the PRD PR reads its round off.
 */

export const PROGRESS_START = "<!-- agent:progress -->";
export const PROGRESS_END = "<!-- /agent:progress -->";

/**
 * The finishing run's record that the final review is requested: a review of
 * a PRD PR whose body carries it is the final review, and a preflight that
 * finds it on a PRD of more than one slice calls the PRD finished. Held equal
 * to the workflows' copies by a test.
 */
export const FINAL_REVIEW_MARK = "<!-- agent:final-review requested -->";

/** One of the parent's sub-issues, as the sub-issues API lists them. */
export interface ProgressSubIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED";
}

/** Where one sub-issue is in the chain. */
export type SliceState =
  | "not started"
  | "building"
  | "in review"
  | "fixing"
  | "parked"
  | "approved"
  | "landed before upgrade";

/** Where the final review is, once it is requested. */
export type FinalReviewState = "in review" | "fixing" | "parked" | "approved";

export interface ProgressInputs {
  /** In the sub-issues API's order, which is execution order. */
  readonly subIssues: readonly ProgressSubIssue[];
  /** `sliceRanges` over the PRD branch and the same sub-issues. */
  readonly ranges: SliceRanges;
  /**
   * The `agent-review` verdict on the PRD PR's head: an approval, any other
   * verdict, or none at all.
   */
  readonly verdict: "approval" | "other" | "none";
  /**
   * What is running on the chain: a build run building the sub-issue named,
   * which has no slice range yet, a review round on the PRD PR, or a fix
   * round a review started there.
   */
  readonly running:
    | { readonly kind: "build"; readonly subIssue: number }
    | { readonly kind: "review" }
    | { readonly kind: "fix" }
    | null;
  /** Whether the finishing run has requested the final review. */
  readonly finalReview: "not requested" | "requested";
  /**
   * The PRD PR's page, `…/pull/<n>`, which every diff link goes under. Absent
   * before the PRD PR is open, and the table links no diff.
   */
  readonly prUrl?: string | undefined;
  /**
   * Each slice's reviews and fix rounds, and the final review's, from
   * `roundCounts` (#298). Absent where they could not be read, and the table
   * says so in each cell rather than showing a count of none.
   */
  readonly rounds?: RoundCounts | undefined;
  /**
   * The findings open on the round that is current, the current slice's or the
   * final review's, where it is known: said beside its status where it is not
   * none.
   */
  readonly open?: number | undefined;
}

/** What a round ended or stands on: running, or else the verdict's reading. */
const roundState = (inputs: ProgressInputs): FinalReviewState =>
  inputs.running?.kind === "review"
    ? "in review"
    : inputs.running?.kind === "fix"
      ? "fixing"
      : inputs.verdict === "approval"
        ? "approved"
        : "parked";

/**
 * Each sub-issue's state, in the list's order.
 *
 * - A sub-issue with a slice range that is not the latest is **approved**: the
 *   chain builds the next slice only on an approval.
 * - The latest one, the current slice, is **in review** while a round runs,
 *   **fixing** while a fix round it started runs, **approved** on an approval,
 *   and otherwise **parked**: waiting on a maintainer. Once the final review is
 *   requested every slice was approved, and what is running is that review,
 *   not the slice's.
 * - One with no range is **building** where a build run is building it,
 *   **landed before upgrade** where it is closed (a release before #222 closed
 *   each slice's sub-issue as it landed), and **not started** otherwise.
 *
 * "Landed before upgrade" is pre-upgrade compatibility, removable under #224
 * (#248), with its icon below.
 */
export const sliceStates = (inputs: ProgressInputs): { readonly subIssue: number; readonly state: SliceState }[] => {
  const current = inputs.ranges.current?.subIssue;
  const ranged = new Set(inputs.ranges.slices.filter((s) => s.range !== null).map((s) => s.subIssue));
  return inputs.subIssues.map(({ number, state }) => {
    const at = (s: SliceState): { readonly subIssue: number; readonly state: SliceState } => ({ subIssue: number, state: s });
    if (ranged.has(number)) {
      if (number !== current || inputs.finalReview === "requested") return at("approved");
      return at(roundState(inputs));
    }
    if (inputs.running?.kind === "build" && inputs.running.subIssue === number) return at("building");
    return at(state === "CLOSED" ? "landed before upgrade" : "not started");
  });
};

const ICON: Readonly<Record<SliceState, string>> = {
  "not started": "⏳",
  building: "🔨",
  "in review": "🔍",
  fixing: "🔧",
  parked: "⏸️",
  approved: "✅",
  "landed before upgrade": "☑️",
};

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** A full commit id, as opposed to a stand-in for commits not made yet. */
const isSha = (sha: string | null | undefined): sha is string => sha !== null && sha !== undefined && /^[0-9a-f]{7,64}$/.test(sha);

/** Where a count could not be read, or is of nothing that has happened. */
const UNKNOWN = "–";

/**
 * A state's cell: its icon and word, and the open findings where the state is
 * waiting on them and there are any. An approved round always has none.
 */
const statusCell = (state: SliceState, open: number | undefined): string =>
  `${ICON[state]} ${capitalised(state)}${
    (state === "parked" || state === "fixing") && open !== undefined && open > 0 ? ` · ${open} open` : ""
  }`;

const countCells = (count: RoundCount | undefined): [string, string] =>
  count === undefined
    ? [UNKNOWN, UNKNOWN]
    : [count.latestReview === undefined ? String(count.reviews) : `[${count.reviews}](${count.latestReview})`, String(count.fixes)];

/** The final review's row, as it closes the table. */
const finalRow = (state: FinalReviewState, inputs: Pick<ProgressInputs, "prUrl" | "rounds" | "open">): string => {
  const [reviews, fixes] = countCells(inputs.rounds?.final);
  const diff = inputs.prUrl === undefined ? UNKNOWN : `[all](${inputs.prUrl}/files)`;
  return `| Final review | ${statusCell(state, inputs.open)} | ${reviews} | ${fixes} | ${diff} |`;
};

/**
 * The lines the finishing run adds when it requests the final review: the
 * final review's row, in review with no round yet, and the mark. Exactly what
 * `renderProgressList` renders for that state below the slices, so the
 * finishing run, which runs no toolchain, writes them in front of the end
 * marker of the list the last slice's round left, and the result is the
 * render. A test holds the workflow's copy equal to this.
 */
export const finalReviewRequestedLines = (prUrl: string): string =>
  `${finalRow("in review", { prUrl, rounds: { slices: {}, final: { reviews: 0, fixes: 0 }, all: { reviews: 0, fixes: 0 } } })}\n${FINAL_REVIEW_MARK}\n`;

/**
 * The progress table, markers and all: the block a PRD PR's body carries
 * (#298). One row per sub-issue: its status, with the findings open where it
 * waits on them; its reviews, linking the latest; the fix rounds run, automatic
 * or added by hand; and a diff of its slice range alone. The final review has a
 * row of its own once it is requested, with a diff of the whole pull request.
 *
 * No title beside a reference: GitHub renders `#N` with its title already.
 */
export const renderProgressList = (inputs: ProgressInputs): string => {
  const ranges = new Map(inputs.ranges.slices.map((s) => [s.subIssue, s.range]));
  const current = inputs.ranges.current?.subIssue;
  const rows = sliceStates(inputs).map(({ subIssue, state }, i) => {
    const range = ranges.get(subIssue) ?? null;
    const isCurrent = subIssue === current && inputs.finalReview !== "requested";
    const count = inputs.rounds === undefined ? undefined : (inputs.rounds.slices[subIssue] ?? { reviews: 0, fixes: 0 });
    const [reviews, fixes] = range === null ? [UNKNOWN, UNKNOWN] : countCells(count);
    const last = range?.commits.at(-1);
    const diff =
      inputs.prUrl !== undefined && isSha(range?.base) && isSha(last) ? `[diff](${inputs.prUrl}/files/${range?.base}..${last})` : UNKNOWN;
    return `| ${i + 1} · #${subIssue} | ${statusCell(state, isCurrent ? inputs.open : undefined)} | ${reviews} | ${fixes} | ${diff} |`;
  });
  const final =
    inputs.finalReview === "requested" ? [finalRow(roundState(inputs), inputs), FINAL_REVIEW_MARK] : [];
  return [
    PROGRESS_START,
    "## Progress",
    "",
    "| Slice | Status | Reviews | Fixes | Diff |",
    "|---|---|---|---|---|",
    ...rows,
    ...final,
    PROGRESS_END,
  ].join("\n");
};

/**
 * The **status line** (#298): one line at the top of the PRD PR's note, saying
 * where the chain is now, between its own markers. Workflow-owned like the
 * progress table, and rendered from the same state, so the two cannot
 * disagree. It links the latest review where the chain waits on it.
 */
export const STATUS_START = "<!-- agent:status -->";
export const STATUS_END = "<!-- /agent:status -->";

const findings = (open: number | undefined): string | undefined =>
  open === undefined || open === 0 ? undefined : `${open} ${open === 1 ? "finding" : "findings"} open`;

/** The status line for the state given, without its markers. */
export const renderPrdStatus = (inputs: ProgressInputs): string => {
  const n = inputs.subIssues.length;
  const open = findings(inputs.open);
  if (inputs.finalReview === "requested") {
    const state = roundState(inputs);
    const seeIt = inputs.rounds?.final.latestReview;
    const link = seeIt === undefined ? "" : ` [See it](${seeIt})`;
    if (state === "in review") return `**🔍 Final review of all ${n} slices**`;
    if (state === "approved") return `**✅ Final review approved:** ready for you to merge.${link}`;
    const word = state === "fixing" ? "🔧 Final review fixing" : "⏸️ Final review parked";
    return `**${word}:** ${open ?? "no findings open"}.${link}`;
  }
  const building = inputs.running?.kind === "build" ? inputs.running.subIssue : undefined;
  if (building !== undefined) {
    const k = inputs.subIssues.findIndex((s) => s.number === building) + 1;
    return `**🔨 Building slice ${k} of ${n}** · #${building}`;
  }
  const current = inputs.ranges.current;
  if (current === null) return `**${ICON["not started"]} Not started**`;
  const state = sliceStates(inputs).find((s) => s.subIssue === current.subIssue)?.state ?? "parked";
  const slice = `slice ${current.k} of ${n}`;
  const seeIt = inputs.rounds?.slices[current.subIssue]?.latestReview;
  const link = seeIt === undefined ? "" : ` [See it](${seeIt})`;
  if (state === "in review") return `**🔍 Reviewing ${slice}** · #${current.subIssue}`;
  if (state === "approved") return `**✅ ${capitalised(slice)} approved** · #${current.subIssue}`;
  const word = state === "fixing" ? `🔧 Fixing ${slice}` : `⏸️ ${capitalised(slice)} parked`;
  return `**${word}** · #${current.subIssue}${open === undefined ? "" : ` · ${open}`}.${link}`;
};

/**
 * A regular pull request's status line (#298), as its review leaves it: ready
 * for a human on an approval, fixing where a fix round starts, and parked on
 * a human otherwise, linking the review. The opening run writes the first one,
 * and every review rewrites it.
 */
export const renderPrStatus = (review: {
  readonly verdict: Verdict;
  readonly startsFixRound: boolean;
  readonly open: number;
  /** The review, once posted, or the slot the posting job puts its link in. */
  readonly review: string;
}): string => {
  const link = `[See it](${review.review})`;
  if (review.verdict === "approval recommended") return `**✅ Ready for you:** the review recommends approval. ${link}`;
  if (review.verdict === "needs a closer look") return `**⏸️ Parked:** the review needs a closer look. ${link}`;
  const open = findings(review.open) ?? "no findings open";
  return review.startsFixRound ? `**🔧 Fixing:** ${open}. ${link}` : `**⏸️ Parked:** ${open}. ${link}`;
};

/** The status line a pull request opens with, before its first review. */
export const OPENING_STATUS = "**🔍 In review:** waiting for its first review.";

/** The status line between its markers: the block a pull request's note opens with. */
export const statusBlock = (line: string): string => `${STATUS_START}${line}${STATUS_END}`;

/**
 * The text between `start` and `end` in `body` replaced by `block`, markers
 * and all. Undefined for half a block, or two: which marker is the real one is
 * where a maintainer's text ends, and that is not a guess to make. A body with
 * none gets `block` appended where `append`, and is returned as it is where
 * not.
 */
const spliceBlock = (body: string, start: string, end: string, block: string, append: boolean): string | undefined => {
  const starts = body.split(start);
  const ends = body.split(end);
  if (starts.length === 1 && ends.length === 1) {
    if (!append) return body;
    return body === "" ? block : `${body}${body.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  }
  const [before = "", after = ""] = starts;
  const inside = after.split(end);
  if (starts.length === 2 && ends.length === 2 && inside.length === 2) return `${before}${block}${inside[1] ?? ""}`;
  return undefined;
};

/**
 * `body` with its status line replaced by `block`. A body with none is left as
 * it is: the line belongs at the top of the note the opening run wrote, and
 * appended anywhere else it would be a second note. Undefined for half a line,
 * or two, by the progress list's rule. The workflows' copies are held to this
 * one by a test.
 */
export const spliceStatus = (body: string, block: string): string | undefined =>
  spliceBlock(body, STATUS_START, STATUS_END, block, false);

/**
 * `body` with its progress list replaced by `block`, or `block` appended to a
 * body that has none. Undefined for half a list, or two: which marker is the
 * real one is where a maintainer's text ends, and that is not a guess to make.
 * The same rule the summary's splice keeps (#218), and the workflows' copies
 * are held to this one by a test.
 */
export const spliceProgressList = (body: string, block: string): string | undefined =>
  spliceBlock(body, PROGRESS_START, PROGRESS_END, block, true);

/**
 * How a review round on the PRD PR can leave the chain, as the advance job
 * tells them apart: on an approval, parked on any other ending, or still
 * running because the verdict started a fix round.
 */
export type RoundEnding = "approved" | "parked" | "running";

/** What a review knows of its own round as it renders the list for each ending. */
export interface RoundEnd {
  /** The reviews and fix rounds before this review, where they could be read. */
  readonly rounds?: RoundCounts | undefined;
  /** Where this review will be once it is posted, or the slot the advance job puts that in. */
  readonly review: string;
  /** The findings open as this review leaves them. */
  readonly open: number;
  readonly prUrl?: string | undefined;
}

/** `count` with one more review, this one, and `fixes` more fix rounds. */
const plusThisReview = (count: RoundCount | undefined, review: string, fixes: number): RoundCount => ({
  reviews: (count?.reviews ?? 0) + 1,
  latestReview: review,
  fixes: (count?.fixes ?? 0) + fixes,
});

/**
 * The progress table and the status line for each way a round can end,
 * rendered by the review while it holds the PRD branch and the token, for the
 * advance job to write whichever one its round ended on. That job runs no
 * toolchain, and it is the one that knows how the round ended.
 *
 * The round's own scope, the current slice or the final review, counts this
 * review and links it; the ending that starts a fix round counts that round
 * too, since the table then shows it fixing.
 */
export const progressAtRoundEnd = (
  branch: Pick<ProgressInputs, "subIssues" | "ranges" | "finalReview">,
  end: RoundEnd,
): Readonly<Record<RoundEnding, { readonly progress: string; readonly status: string }>> => {
  const counted = (fixes: number): RoundCounts | undefined => {
    const rounds = end.rounds;
    if (rounds === undefined) return undefined;
    if (branch.finalReview === "requested") return { ...rounds, final: plusThisReview(rounds.final, end.review, fixes) };
    const current = branch.ranges.current?.subIssue;
    if (current === undefined) return rounds;
    return { ...rounds, slices: { ...rounds.slices, [current]: plusThisReview(rounds.slices[current], end.review, fixes) } };
  };
  const at = (
    verdict: ProgressInputs["verdict"],
    running: ProgressInputs["running"],
    fixes: number,
  ): { readonly progress: string; readonly status: string } => {
    const inputs: ProgressInputs = { ...branch, verdict, running, prUrl: end.prUrl, rounds: counted(fixes), open: end.open };
    return { progress: renderProgressList(inputs), status: statusBlock(renderPrdStatus(inputs)) };
  };
  return {
    approved: at("approval", null, 0),
    parked: at("other", null, 0),
    running: at("other", { kind: "fix" }, 1),
  };
};
