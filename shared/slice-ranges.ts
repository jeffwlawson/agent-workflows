/**
 * Which commits on a PRD branch belong to which sub-issue (PRD #222, #242): the
 * one answer every question of "which slice" is read from. The next slice to
 * build, the current slice and its "k of n", and the base the red check (#212)
 * compares against all come from here, and nothing else decides them.
 *
 * Read from the PRD branch's **first-parent log** and the `Agent-Slice: #<sub>`
 * trailer `implement-prd` gives every commit a build run makes, before the push.
 * Never from which sub-issues are closed: a sub-issue stays open until the PRD
 * PR merges, and closing or reopening one by hand must not make the chain skip
 * or repeat work.
 *
 * Pure. The caller reads the log and the sub-issues; this rules on plain values.
 */

/** The trailer key a build run's commits carry, as `Agent-Slice: #<sub>`. */
export const SLICE_TRAILER = "Agent-Slice";

/** One commit of the PRD branch's first-parent log. */
export interface BranchCommit {
  readonly sha: string;
  /** In git's order, so the first is the one `--first-parent` follows. */
  readonly parents: readonly string[];
  /** The sub-issue its `Agent-Slice` trailer names, or null when it has none. */
  readonly slice: number | null;
}

/** One of the parent's sub-issues, as the sub-issues API lists them. */
export interface SliceSubIssue {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
}

/** A slice's commits on the PRD branch. */
export interface SliceRange {
  /**
   * The first parent of the range's first commit: what the slice was built on,
   * and the "before" a slice round's red check compares against (#212). Null
   * only when the range starts at a root commit, which a PRD branch cut from
   * the default branch never does.
   */
  readonly base: string | null;
  /** Oldest first, so the last is the range's head. Never empty. */
  readonly commits: readonly string[];
}

export interface SliceRanges {
  /** Every sub-issue, in the order given, with its range or null if it has none. */
  readonly slices: readonly { readonly subIssue: number; readonly range: SliceRange | null }[];
  /**
   * The first open sub-issue with no range: the slice to build next. Null when
   * none is left. Open, because a closed one with no range landed before the
   * upgrade (#248), as a slice PR an older release merged with no trailer:
   * pre-upgrade compatibility, removable under #224.
   */
  readonly next: number | null;
  /**
   * The last sub-issue with a range, and its place in the list: slice `k` of
   * `n`, counting from 1. Null before any slice is built.
   */
  readonly current: { readonly subIssue: number; readonly k: number; readonly n: number } | null;
}

/**
 * The slice ranges of a PRD branch.
 *
 * `log` is the branch's first-parent log **newest first**, as `git log
 * --first-parent` prints it. `subIssues` are the parent's, in the sub-issues
 * API's order, which is execution order.
 *
 * - A slice starts at the first parent of its earliest trailered commit.
 * - It ends where the next slice on the branch starts, or at the head for the
 *   latest one.
 * - An untrailered commit belongs to the slice whose range it falls in: a fix
 *   run's commit, a human's push, or a merge that resolved a conflict.
 * - A merge `implement-prd` made of the default branch lands just before the
 *   slice it was building starts. So untrailered merges directly before a
 *   slice's earliest trailered commit fall outside every range, and the last of
 *   them is that slice's base.
 *
 * A trailer naming no sub-issue in the list starts nothing; its commit is read
 * as untrailered. Commits before the first slice's base are the default
 * branch's history and fall outside every range too.
 */
export const sliceRanges = (log: readonly BranchCommit[], subIssues: readonly SliceSubIssue[]): SliceRanges => {
  const commits = [...log].reverse();
  const known = new Set(subIssues.map((s) => s.number));

  // Where each slice's earliest trailered commit sits, in branch order.
  const starts: { readonly subIssue: number; readonly at: number }[] = [];
  const seen = new Set<number>();
  commits.forEach((commit, at) => {
    if (commit.slice === null || !known.has(commit.slice) || seen.has(commit.slice)) return;
    seen.add(commit.slice);
    starts.push({ subIssue: commit.slice, at });
  });

  const isLeadingMerge = (commit: BranchCommit): boolean => commit.slice === null && commit.parents.length > 1;

  const ranges = new Map<number, SliceRange>();
  starts.forEach(({ subIssue, at }, i) => {
    const following = starts[i + 1];
    let end = following === undefined ? commits.length : following.at;
    if (following !== undefined) {
      while (end > at + 1 && isLeadingMerge(commits[end - 1] as BranchCommit)) end -= 1;
    }
    ranges.set(subIssue, {
      base: (commits[at] as BranchCommit).parents[0] ?? null,
      commits: commits.slice(at, end).map((c) => c.sha),
    });
  });

  const slices = subIssues.map((s) => ({ subIssue: s.number, range: ranges.get(s.number) ?? null }));
  const next = subIssues.find((s) => s.state === "OPEN" && !ranges.has(s.number))?.number ?? null;
  const k = slices.findLastIndex((s) => s.range !== null);
  const last = slices[k];

  return {
    slices,
    next,
    current: last === undefined ? null : { subIssue: last.subIssue, k: k + 1, n: slices.length },
  };
};
