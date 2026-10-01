import { describe, expect, it } from "vitest";
import { sliceRanges, type BranchCommit, type SliceSubIssue } from "../shared/slice-ranges.js";

/**
 * Which commits on a PRD branch belong to which sub-issue (#242), from the
 * branch's first-parent log and the `Agent-Slice` trailer every build commit
 * carries. Never from which sub-issues are closed.
 */

/**
 * A first-parent log from oldest-first entries, returned newest first as `git
 * log --first-parent` prints it. Each entry is `[sha, trailer]`, a sha
 * starting `merge` gets a second parent off the branch, and one starting
 * `merge-catch-up` carries the `Agent-Catch-Up` trailer as well.
 */
const branch = (...entries: readonly (readonly [string, number | null])[]): BranchCommit[] =>
  entries
    .map(([sha, slice], i): BranchCommit => {
      const first = i === 0 ? "root" : (entries[i - 1] as readonly [string, number | null])[0];
      const parents = sha.startsWith("merge") ? [first, `${sha}-side`] : [first];
      return { sha, parents, slice, ...(sha.startsWith("merge-catch-up") ? { catchUp: true } : {}) };
    })
    .reverse();

const open = (...numbers: readonly number[]): SliceSubIssue[] => numbers.map((number) => ({ number, state: "OPEN" }));

const rangeOf = (result: ReturnType<typeof sliceRanges>, sub: number) =>
  result.slices.find((s) => s.subIssue === sub)?.range;

describe("sliceRanges", () => {
  it("starts each slice at the first parent of its earliest trailered commit and ends it where the next starts", () => {
    const log = branch(["main-1", null], ["a1", 10], ["a2", 10], ["b1", 11], ["b2", 11]);
    const result = sliceRanges(log, open(10, 11, 12));

    expect(rangeOf(result, 10)).toEqual({ base: "main-1", commits: ["a1", "a2"] });
    expect(rangeOf(result, 11)).toEqual({ base: "a2", commits: ["b1", "b2"] });
  });

  it("puts untrailered fix, human and conflict-resolution commits in the range they fall in", () => {
    const log = branch(
      ["main-1", null],
      ["a1", 10],
      ["fix-a", null],
      ["merge-resolution-a", null],
      ["human-a", null],
      ["b1", 11],
      ["fix-b", null],
      ["human-b", null],
    );
    const result = sliceRanges(log, open(10, 11));

    expect(rangeOf(result, 10)?.commits).toEqual(["a1", "fix-a", "merge-resolution-a", "human-a"]);
    expect(rangeOf(result, 11)).toEqual({ base: "human-a", commits: ["b1", "fix-b", "human-b"] });
  });

  it("leaves a default-branch merge before a slice's first commit outside every range, as that slice's base", () => {
    const log = branch(["main-1", null], ["a1", 10], ["fix-a", null], ["merge-catch-up", null], ["b1", 11]);
    const result = sliceRanges(log, open(10, 11));

    expect(rangeOf(result, 10)?.commits).toEqual(["a1", "fix-a"]);
    expect(rangeOf(result, 11)).toEqual({ base: "merge-catch-up", commits: ["b1"] });
    expect(result.slices.flatMap((s) => s.range?.commits ?? [])).not.toContain("merge-catch-up");
  });

  /**
   * `update-branch`'s conflict resolution has the shape of the chain's own
   * merge, an untrailered merge of the default branch, and is the last commit
   * of the slice whose round it was. The approving review of that round was of
   * it, so it stays in the range when the next slice is built (#242, #247).
   */
  it("keeps an untrailered merge at the end of a slice in its range when it is no catch-up merge", () => {
    const log = branch(["main-1", null], ["a1", 10], ["merge-resolution-a", null], ["b1", 11]);
    const result = sliceRanges(log, open(10, 11));

    expect(rangeOf(result, 10)?.commits).toEqual(["a1", "merge-resolution-a"]);
    expect(rangeOf(result, 11)).toEqual({ base: "merge-resolution-a", commits: ["b1"] });
  });

  it("trims only the catch-up merges after a slice's own trailing resolution", () => {
    const log = branch(
      ["main-1", null],
      ["a1", 10],
      ["merge-resolution-a", null],
      ["merge-catch-up-1", null],
      ["merge-catch-up-2", null],
      ["b1", 11],
    );
    const result = sliceRanges(log, open(10, 11));

    expect(rangeOf(result, 10)?.commits).toEqual(["a1", "merge-resolution-a"]);
    expect(rangeOf(result, 11)).toEqual({ base: "merge-catch-up-2", commits: ["b1"] });
  });

  it("leaves the default branch's history before the first slice outside every range", () => {
    const log = branch(["main-1", null], ["main-2", null], ["merge-catch-up", null], ["a1", 10]);
    const result = sliceRanges(log, open(10));

    expect(rangeOf(result, 10)).toEqual({ base: "merge-catch-up", commits: ["a1"] });
  });

  it("starts a slice at its earliest trailered commit when a later one carries the same trailer", () => {
    const log = branch(["main-1", null], ["a1", 10], ["b1", 11], ["a-again", 10]);
    const result = sliceRanges(log, open(10, 11));

    expect(rangeOf(result, 10)?.commits).toEqual(["a1"]);
    expect(rangeOf(result, 11)?.commits).toEqual(["b1", "a-again"]);
  });

  it("reads a trailer naming no sub-issue as untrailered", () => {
    const log = branch(["main-1", null], ["a1", 10], ["stray", 99]);
    const result = sliceRanges(log, open(10));

    expect(rangeOf(result, 10)?.commits).toEqual(["a1", "stray"]);
    expect(result.slices.map((s) => s.subIssue)).toEqual([10]);
  });

  it("gives a sub-issue with no trailered commit no range", () => {
    const log = branch(["main-1", null], ["a1", 10]);
    const result = sliceRanges(log, open(10, 11, 12));

    expect(rangeOf(result, 11)).toBeNull();
    expect(rangeOf(result, 12)).toBeNull();
    expect(result.slices.map((s) => s.subIssue)).toEqual([10, 11, 12]);
  });

  it("names the next slice: the first open sub-issue with no range, whatever is closed", () => {
    const subs: SliceSubIssue[] = [
      // Built, and closed by hand: still built.
      { number: 10, state: "CLOSED" },
      // Built, and still open: not next.
      { number: 11, state: "OPEN" },
      // Closed with no range: not built here, and not next.
      { number: 12, state: "CLOSED" },
      { number: 13, state: "OPEN" },
      { number: 14, state: "OPEN" },
    ];
    const result = sliceRanges(branch(["main-1", null], ["a1", 10], ["b1", 11]), subs);

    expect(result.next).toBe(13);
  });

  it("names no next slice when every open sub-issue has a range", () => {
    const result = sliceRanges(branch(["main-1", null], ["a1", 10], ["b1", 11]), open(10, 11));

    expect(result.next).toBeNull();
  });

  it("names the current slice, the last sub-issue with a range, as k of n", () => {
    const result = sliceRanges(branch(["main-1", null], ["a1", 10], ["b1", 11]), open(10, 11, 12, 13));

    expect(result.current).toEqual({ subIssue: 11, k: 2, n: 4 });
    expect(result.next).toBe(12);
  });

  it("names no current slice before any is built, and the first sub-issue as next", () => {
    const result = sliceRanges(branch(["main-1", null], ["main-2", null]), open(10, 11));

    expect(result.current).toBeNull();
    expect(result.next).toBe(10);
    expect(result.slices.every((s) => s.range === null)).toBe(true);
  });

  it("accepts a PRD with one sub-issue", () => {
    const result = sliceRanges(branch(["main-1", null], ["a1", 10], ["fix-a", null]), open(10));

    expect(result.current).toEqual({ subIssue: 10, k: 1, n: 1 });
    expect(result.next).toBeNull();
    expect(rangeOf(result, 10)).toEqual({ base: "main-1", commits: ["a1", "fix-a"] });
  });
});
