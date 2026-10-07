import { gh, isWorkflowBot } from "./common.js";
import { fetchReviews } from "./follow-up-filing.js";
import type { FilingReview } from "./follow-up-plan.js";
import { BODY_HEADING } from "./review-output.js";
import type { SliceRanges } from "./slice-ranges.js";

/**
 * The **header** every top-level review and fix comment opens with (#298), and
 * the numbers in it: which round of which slice a comment belongs to, so a PRD
 * PR of many slices and many rounds reads in sections rather than as one
 * timeline of verdicts nothing tells apart.
 *
 * - On a PRD PR's slice round: `**Slice <k> of <n> · #<sub> · review <r>**`,
 *   and `· fix <f>` for a fix run.
 * - On its final review: `**Final review · review <r>**` and `· fix <f>`.
 * - On a regular pull request: `**Review <r>**` and `**Fix <f>**`.
 *
 * Numbers restart for each slice. A review number counts every review of the
 * scope, a hand-requested one included; a fix number counts every fix round,
 * automatic or added by hand, so there is no "of N": rounds can continue by
 * hand after the budget is spent. Replies inside threads carry no header.
 *
 * The renderers and the counting are pure. `readRoundRecord` is the one reader.
 */

/** What a round belongs to: one slice of a PRD PR, its final review, or a regular pull request. */
export type RoundScope =
  | { readonly kind: "slice"; readonly k: number; readonly n: number; readonly subIssue: number }
  | { readonly kind: "final" }
  | { readonly kind: "regular" };

export type RoundStep = "review" | "fix";

/** The header line, bold, with no trailing newline. */
export const roundHeader = (scope: RoundScope, step: RoundStep, number: number): string => {
  if (scope.kind === "slice") return `**Slice ${scope.k} of ${scope.n} · #${scope.subIssue} · ${step} ${number}**`;
  if (scope.kind === "final") return `**Final review · ${step} ${number}**`;
  return `**${step === "review" ? "Review" : "Fix"} ${number}**`;
};

/** A header as the first line of a body, and the blank lines after it. */
const LEADING_HEADER =
  /^\*\*(?:Slice \d+ of \d+ · #\d+ · (?:review|fix) \d+|Final review · (?:review|fix) \d+|(?:Review|Fix) \d+)\*\*[ \t]*(?:\r?\n)*/;

/** `body` opening with `header`, on a line of its own. */
export const withHeader = (header: string, body: string): string => `${header}\n\n${body}`;

/** `body` with the header it opens with, if any, taken off: what a comparison between two runs' bodies reads. */
export const withoutHeader = (body: string): string => body.replace(LEADING_HEADER, "");

/** A review on the pull request, as the counting reads it. */
export type RoundReview = Pick<FilingReview, "author" | "body" | "commit" | "submittedAt" | "url">;

/** What the counting reads off a pull request. */
export interface RoundRecord {
  /** Every review on it, oldest first. */
  readonly reviews: readonly RoundReview[];
  /** When `agent:fix` was added to it, each time it was: one fix round each, automatic or by hand. */
  readonly fixes: readonly string[];
}

/** One scope's rounds so far. */
export interface RoundCount {
  readonly reviews: number;
  /** The newest review of the scope, where it has one with a link. */
  readonly latestReview?: string;
  readonly fixes: number;
}

/** Every scope's rounds: each slice, by sub-issue, the final review, and the whole pull request. */
export interface RoundCounts {
  readonly slices: Readonly<Record<number, RoundCount>>;
  readonly final: RoundCount;
  readonly all: RoundCount;
}

/** A review this loop posted: by the workflow's bot, under the review's heading. */
const isLoopReview = (review: RoundReview): boolean =>
  isWorkflowBot(review.author) && withoutHeader(review.body).trimStart().startsWith(BODY_HEADING);

/** A review the final review posted, told by its header. */
const isFinalReview = (review: RoundReview): boolean => review.body.startsWith("**Final review · review ");

/** The slice a review's header names, where it has a slice round's header. */
const headerSlice = (review: RoundReview): { readonly k: number; readonly n: number; readonly subIssue: number } | undefined => {
  const match = /^\*\*Slice (\d+) of (\d+) · #(\d+) · review \d+\*\*/.exec(review.body);
  return match === null ? undefined : { k: Number(match[1]), n: Number(match[2]), subIssue: Number(match[3]) };
};

const time = (at: string | undefined): number => (at === undefined ? Number.NaN : Date.parse(at));

const counted = (reviews: readonly RoundReview[], fixes: number): RoundCount => {
  const latest = reviews.at(-1)?.url;
  return { reviews: reviews.length, ...(latest === undefined || latest === "" ? {} : { latestReview: latest }), fixes };
};

/**
 * Every scope's reviews and fix rounds, read off the pull request's record.
 *
 * - A review this loop posted belongs to the round its header names, the
 *   final review or a slice; one posted before headers belongs to the slice
 *   whose range holds the commit it reviewed (`sliceRanges`, the one answer
 *   to "which slice"). One that neither places belongs to no slice.
 * - A fix round belongs to the scope whose first review came last before it
 *   started: a slice's fix rounds all follow its first review, and all come
 *   before the next slice is built, since the chain moves on only on an
 *   approval. One started before any review belongs to none.
 *
 * Off a PRD PR, `prd` false, `all` is the whole pull request's. On one whose
 * branch could not be read, `ranges` undefined, the headers alone place the
 * reviews.
 */
export const roundCounts = (record: RoundRecord, ranges?: SliceRanges, prd = ranges !== undefined): RoundCounts => {
  const loop = record.reviews.filter(isLoopReview);
  const all = counted(loop, record.fixes.length);
  if (!prd) return { slices: {}, final: counted([], 0), all };

  const sliceOf = new Map<string, number>();
  for (const { subIssue, range } of ranges?.slices ?? []) {
    for (const sha of range?.commits ?? []) sliceOf.set(sha, subIssue);
  }
  const final = loop.filter(isFinalReview);
  const bySlice = new Map<number, RoundReview[]>();
  for (const review of loop) {
    if (isFinalReview(review)) continue;
    const sub = headerSlice(review)?.subIssue ?? (review.commit === undefined ? undefined : sliceOf.get(review.commit));
    if (sub !== undefined) bySlice.set(sub, [...(bySlice.get(sub) ?? []), review]);
  }

  // Each scope's window opens at its first review; a fix round falls in the
  // last window open when it started.
  const windows = [
    ...[...bySlice].map(([sub, reviews]) => ({ key: sub as number | "final", start: time(reviews[0]?.submittedAt) })),
    ...(final.length === 0 ? [] : [{ key: "final" as const, start: time(final[0]?.submittedAt) }]),
  ]
    .filter((w) => !Number.isNaN(w.start))
    .sort((a, b) => a.start - b.start);
  const fixes = new Map<number | "final", number>();
  for (const at of record.fixes) {
    const started = time(at);
    const window = windows.filter((w) => w.start <= started).at(-1);
    if (window !== undefined) fixes.set(window.key, (fixes.get(window.key) ?? 0) + 1);
  }

  const slices: Record<number, RoundCount> = {};
  for (const sub of [...(ranges?.slices.filter((s) => s.range !== null).map((s) => s.subIssue) ?? []), ...bySlice.keys()]) {
    slices[sub] = counted(bySlice.get(sub) ?? [], fixes.get(sub) ?? 0);
  }
  return { slices, final: counted(final, fixes.get("final") ?? 0), all };
};

/** One scope's count out of all of them. */
export const countFor = (counts: RoundCounts, scope: RoundScope): RoundCount =>
  scope.kind === "final"
    ? counts.final
    : scope.kind === "slice"
      ? (counts.slices[scope.subIssue] ?? { reviews: 0, fixes: 0 })
      : counts.all;

/** The header a review of `scope` opens with: one more than the reviews of it so far. */
export const reviewHeader = (scope: RoundScope, counts: RoundCounts): string =>
  roundHeader(scope, "review", countFor(counts, scope).reviews + 1);

/**
 * The header a fix run's top-level comments open with. Its own `agent:fix` is
 * on the record by the time it runs, so the count already holds it; a run
 * whose own label could not be placed is still at least the first.
 */
export const fixHeader = (scope: RoundScope, counts: RoundCounts): string =>
  roundHeader(scope, "fix", Math.max(1, countFor(counts, scope).fixes));

/**
 * The scope a fix run works in: the one the newest review this loop posted
 * belongs to, since a fix round answers a review. The round its header names,
 * otherwise the slice whose range holds its commit, and the current slice
 * where neither can be told. Off a PRD PR, `prd` false, the whole pull
 * request.
 */
export const fixScope = (record: RoundRecord, ranges?: SliceRanges, prd = ranges !== undefined): RoundScope => {
  if (!prd) return { kind: "regular" };
  const latest = record.reviews.filter(isLoopReview).at(-1);
  if (latest !== undefined && isFinalReview(latest)) return { kind: "final" };
  const named = latest === undefined ? undefined : headerSlice(latest);
  if (named !== undefined) return { kind: "slice", ...named };
  if (ranges === undefined) return { kind: "regular" };
  const n = ranges.slices.length;
  const index = ranges.slices.findIndex((s) => latest?.commit !== undefined && s.range?.commits.includes(latest.commit));
  const slice = ranges.slices[index];
  if (slice !== undefined) return { kind: "slice", k: index + 1, n, subIssue: slice.subIssue };
  const current = ranges.current;
  return current === null ? { kind: "regular" } : { kind: "slice", ...current };
};

/**
 * The pull request's record: its reviews, and every time `agent:fix` was added
 * to it. Throws where either cannot be read; a caller decides what a header it
 * cannot number becomes.
 */
export const readRoundRecord = (repo: string, prNumber: string): RoundRecord => {
  const reviews = fetchReviews(repo, prNumber);
  const fixes = gh([
    "api",
    `repos/${repo}/issues/${prNumber}/events`,
    "--paginate",
    "--jq",
    '.[] | select(.event == "labeled" and .label.name == "agent:fix") | .created_at',
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { reviews, fixes };
};
