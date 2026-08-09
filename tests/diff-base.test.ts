import { describe, expect, it } from "vitest";
import { diffCommandAgainstBase } from "../shared/pr-feedback.js";

/**
 * The review's inline-comment allow-list is built from the same diff GitHub uses
 * to define the PR. GitHub diffs against the PR's *base branch* merge-base, so
 * this command must too — diffing against a hardcoded `main` on a stacked PR
 * pulls in the intermediate branch's lines, the allow-list disagrees with
 * GitHub's, and GitHub rejects the entire review silently (issue #71). Only the
 * base is a variable; the seam worth testing is which base is chosen, so these
 * assert the exact argv.
 *
 * Argv, not a command string: the base ref reaches `git` as one argument via
 * `execFileSync` and is never shell-parsed (issue #75). The last case pins that
 * a metacharacter ref passes through verbatim — no escaping, no splitting; the
 * "no shell" half of that guarantee lives in `git()` in common.ts.
 */
describe("diffCommandAgainstBase", () => {
  it("diffs against the given base, three-dot, HEAD on the right", () => {
    expect(diffCommandAgainstBase("main")).toEqual(["diff", "main...HEAD"]);
  });

  it("uses the PR's real base on a stacked PR, not a literal main", () => {
    // A PR based on the intermediate branch of a stack. Diffing against `main`
    // here would fold that branch's commits into the allow-list and diff.
    expect(diffCommandAgainstBase("agent/issue-68-stacked")).toEqual([
      "diff",
      "agent/issue-68-stacked...HEAD",
    ]);
  });

  it("keeps the three-dot form — two-dot has different semantics and mis-filters", () => {
    // Exactly three dots between base and HEAD: `<base>...HEAD` is changes since
    // the merge-base, which is what GitHub shows.
    expect(diffCommandAgainstBase("release/1.x")).toEqual(["diff", "release/1.x...HEAD"]);
  });

  /**
   * It used to fall back to `main`, which was the same silent wrong-branch
   * failure one level down: on a `master` repo every review diffed against a ref
   * that did not exist, or worse, one that did and was stale. Every workflow now
   * supplies `BASE_REF` from the PR event with the `default-branch` input behind
   * it (#98), so an empty value is a misconfiguration rather than a case to
   * absorb — and the runner's `fail()` puts the message on the PR.
   */
  it("refuses an absent or empty base ref rather than guessing one", () => {
    for (const absent of [undefined, "", "   "]) {
      expect(() => diffCommandAgainstBase(absent)).toThrow(/BASE_REF/);
    }
  });

  it("keeps a shell-metacharacter ref as one argument rather than splitting it", () => {
    // `git check-ref-format --branch` permits `$()`, backticks, `;`, `|` and `&`
    // in a branch name (verified 2026-08-02). Under the old string form these
    // reached `/bin/sh`; as argv the ref stays a single, unparsed argument.
    for (const ref of ["$(id)", "a;id", "a|id", "a&b", "back`tick`"]) {
      expect(diffCommandAgainstBase(ref)).toEqual(["diff", `${ref}...HEAD`]);
    }
  });
});
