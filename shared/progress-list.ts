import type { SliceRanges } from "./slice-ranges.js";

/**
 * The **progress list** in a PRD PR's body (PRD #222, #246): one line per
 * sub-issue, saying where the chain is, so a maintainer reads the chain's
 * state off the PRD PR rather than off closed issues or state labels. It
 * replaces the slices table, and like the `Closes` block beside it, it is
 * workflow-owned, between its own markers, which the review's rewrite of the
 * summary (#218) splices around byte for byte.
 *
 * **Re-rendered from live state, never edited incrementally.** Every
 * `implement-prd` run that builds renders it as the slice starts and again as
 * its round is asked for, and the advance job writes the one the review
 * rendered for how its round ended. So each render is a pure function of the
 * sub-issues, the slice ranges, the head's verdict, what is running and the
 * finishing state, and a render from unchanged state is byte for byte the one
 * before it.
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
  | "parked"
  | "approved"
  | "landed before upgrade";

/** Where the final review is, once it is requested. */
export type FinalReviewState = "in review" | "parked" | "approved";

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
   * which has no slice range yet, or a review round on the PRD PR.
   */
  readonly running: { readonly kind: "build"; readonly subIssue: number } | { readonly kind: "review" } | null;
  /** Whether the finishing run has requested the final review. */
  readonly finalReview: "not requested" | "requested";
}

/** What a round ended or stands on: running, or else the verdict's reading. */
const roundState = (inputs: ProgressInputs): FinalReviewState =>
  inputs.running?.kind === "review" ? "in review" : inputs.verdict === "approval" ? "approved" : "parked";

/**
 * Each sub-issue's state, in the list's order.
 *
 * - A sub-issue with a slice range that is not the latest is **approved**: the
 *   chain builds the next slice only on an approval.
 * - The latest one, the current slice, is **in review** while a round runs,
 *   **approved** on an approval, and otherwise **parked**: waiting on a
 *   maintainer. Once the final review is requested every slice was approved,
 *   and what is running is that review, not the slice's.
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
  "not started": "⬜",
  building: "🔨",
  "in review": "🔍",
  parked: "⏸️",
  approved: "✅",
  "landed before upgrade": "☑️",
};

/** The final review's line, and the mark, as they close the list. */
const finalReviewLines = (state: FinalReviewState): string =>
  `\n**Final review:** ${ICON[state]} ${state}\n${FINAL_REVIEW_MARK}\n`;

/** One line, and no character that ends the list item early. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * The lines the finishing run adds when it requests the final review: the
 * final review in review, and the mark. Exactly what `renderProgressList`
 * renders for that state, below the slices, so the finishing run, which runs
 * no toolchain, writes them in front of the end marker of the list the last
 * slice's round left, and the result is the render. A test holds the
 * workflow's copy equal to this.
 */
export const FINAL_REVIEW_REQUESTED_LINES = finalReviewLines("in review");

/**
 * The progress list, markers and all: the block a PRD PR's body carries.
 */
export const renderProgressList = (inputs: ProgressInputs): string => {
  const titles = new Map(inputs.subIssues.map((s) => [s.number, s.title]));
  const rows = sliceStates(inputs).map(
    ({ subIssue, state }) =>
      `- ${ICON[state]} **${capitalised(state)}:** #${subIssue} ${oneLine(titles.get(subIssue) ?? "")}`.trimEnd(),
  );
  const final = inputs.finalReview === "requested" ? finalReviewLines(roundState(inputs)) : "";
  return [PROGRESS_START, "**Progress**", "", ...rows, `${final}${PROGRESS_END}`].join("\n");
};

/**
 * `body` with its progress list replaced by `block`, or `block` appended to a
 * body that has none. Undefined for half a list, or two: which marker is the
 * real one is where a maintainer's text ends, and that is not a guess to make.
 * The same rule the summary's splice keeps (#218), and the workflows' copies
 * are held to this one by a test.
 */
export const spliceProgressList = (body: string, block: string): string | undefined => {
  const starts = body.split(PROGRESS_START);
  const ends = body.split(PROGRESS_END);
  if (body === "") return block;
  if (starts.length === 1 && ends.length === 1) return `${body}${body.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  const [before = "", after = ""] = starts;
  const inside = after.split(PROGRESS_END);
  if (starts.length === 2 && ends.length === 2 && inside.length === 2) return `${before}${block}${inside[1] ?? ""}`;
  return undefined;
};

/**
 * How a review round on the PRD PR can leave the chain, as the advance job
 * tells them apart: on an approval, parked on any other ending, or still
 * running because the verdict started a fix round.
 */
export type RoundEnding = "approved" | "parked" | "running";

/**
 * The progress list for each way a round can end, rendered by the review
 * while it holds the PRD branch and the token, for the advance job to write
 * whichever one its round ended on. That job runs no toolchain, and it is the
 * one that knows how the round ended.
 */
export const progressAtRoundEnd = (
  branch: Pick<ProgressInputs, "subIssues" | "ranges" | "finalReview">,
): Readonly<Record<RoundEnding, string>> => ({
  approved: renderProgressList({ ...branch, verdict: "approval", running: null }),
  parked: renderProgressList({ ...branch, verdict: "other", running: null }),
  running: renderProgressList({ ...branch, verdict: "other", running: { kind: "review" } }),
});
