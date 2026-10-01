import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";
import {
  parkReasonOf,
  readSliceRound,
  renderFinalReviewBrief,
  renderParkComment,
  renderSliceRoundBrief,
  roundName,
  type ParkFinding,
  type ParkReason,
  type PrdRound,
  type RangeCommit,
} from "../shared/prd-round.js";
import { deriveVerdict, VERDICTS, type ReviewOutput, type VerdictInputs } from "../shared/review-output.js";

/**
 * A review round on a PRD PR (PRD #222, #244): the slice-round and final-review
 * briefs, and the park comment the advance job posts on the parent when a
 * round ends without moving the chain on.
 */

/** Where `readSliceRound`'s git runs, and what its `gh` answers. */
const fixture = vi.hoisted(() => ({ dir: "", subIssues: [] as { number: number; state: string }[] }));

vi.mock("../shared/common.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/common.js")>()),
  gh: () => JSON.stringify({ data: { repository: { issue: { subIssues: { nodes: fixture.subIssues } } } } }),
  git: (args: readonly string[]) =>
    execFileSync("git", ["-C", fixture.dir, ...args], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT }),
}));

const commit = (sha: string, subject: string): RangeCommit => ({ sha, subject, merge: false, resolution: "" });
const merge = (sha: string, subject: string, resolution: string): RangeCommit => ({
  sha,
  subject,
  merge: true,
  resolution,
});

const slice = (commits: readonly RangeCommit[]): Extract<PrdRound, { kind: "slice" }> => ({
  kind: "slice",
  parent: "222",
  slice: { subIssue: 244, k: 3, n: 7, commits },
});

const BRANCH = "agent/prd-222-build-each-slice";

describe("the slice-round brief", () => {
  const brief = (commits: readonly RangeCommit[]): string => renderSliceRoundBrief(slice(commits), BRANCH, "main");

  it("names the slice as k of n and lists the range's commits", () => {
    const text = brief([commit("aaaaaaa1111", "feat: the brief"), commit("bbbbbbb2222", "fix: a finding")]);

    expect(text).toContain("**slice 3 of 7: #244**");
    expect(text).toContain("PRD #222");
    expect(text).toContain("- `aaaaaaa` feat: the brief");
    expect(text).toContain("- `bbbbbbb` fix: a finding");
    expect(text.indexOf("`aaaaaaa`")).toBeLessThan(text.indexOf("`bbbbbbb`"));
  });

  /**
   * A merge that resolved nothing brings in the base branch's own commits,
   * which are not this slice's: it contributes nothing to the list.
   */
  it("leaves out a merge of the default branch that resolved no conflict", () => {
    const text = brief([commit("aaaaaaa1111", "feat: the brief"), merge("ccccccc3333", "Merge branch 'main'", "")]);

    expect(text).not.toContain("ccccccc");
    expect(text).not.toContain("Merge branch 'main'");
    expect(text).toContain("1 merge of the base branch that resolved no conflict, left out");
  });

  /** A conflict resolution is code the loop wrote, and is this slice's to review. */
  it("includes a conflict resolution, by what it chose", () => {
    const resolution = "diff --git a/x.ts b/x.ts\n-<<<<<<< ours\n+const both = true;";
    const text = brief([commit("aaaaaaa1111", "feat: the brief"), merge("ddddddd4444", "Merge branch 'main'", resolution)]);

    expect(text).toContain("- `ddddddd` Merge branch 'main': a merge whose **conflict resolution** is this slice's");
    expect(text).toContain("  +const both = true;");
    expect(text).not.toContain("left out");
  });

  it("bounds what may be raised, and keeps the diff and the anchoring as they are", () => {
    const text = brief([commit("aaaaaaa1111", "feat: the brief")]);

    expect(text).toContain("still the whole pull request's three-dot diff against `main`");
    expect(text).toContain("**A finding must be caused by this slice's commits.**");
    expect(text).toContain("anchor it at **this slice's change** that causes it");
    expect(text).toContain("Earlier, already-approved code this slice does not touch is **not raised**");
    expect(text).toContain("carried and verified as on any round");
  });

  /** A slice nobody could tell falls back to the whole pull request, not to a guess. */
  it("asks for the whole pull request where the slice could not be told", () => {
    const text = renderSliceRoundBrief(
      { kind: "slice", parent: "222", slice: undefined, unknownBecause: "the log could not be read" },
      BRANCH,
      "main",
    );

    expect(text).toContain("could not be told (the log could not be read)");
    expect(text).toContain("review the whole pull request");
    expect(text).not.toMatch(/slice \d+ of \d+/);
  });
});

describe("the final-review brief", () => {
  it("is handed the whole PRD PR, with no slice range", () => {
    const text = renderFinalReviewBrief("222", BRANCH, "main");

    expect(text).toContain("**final review**");
    expect(text).toContain("PRD #222");
    expect(text).toContain("with no slice range");
    expect(text).not.toMatch(/slice \d+ of \d+/);
    expect(text).not.toContain("commits, oldest first");
    expect(roundName({ kind: "final", parent: "222" })).toBe("the final review");
  });
});

describe("the park comment", () => {
  const FINDINGS: readonly ParkFinding[] = [
    { title: "The guard runs after the return", anchor: "src/a.ts:12", url: "https://example.test/thread/1" },
    { title: "A test asserts the old behaviour", anchor: "tests/a.test.ts:40", url: "https://example.test/review/9" },
  ];

  const park = (reason: ParkReason, round: PrdRound = slice([])): string =>
    renderParkComment({
      round,
      prNumber: "300",
      reason,
      ...(reason === "failed" || reason === "post failed" ? { runUrl: "https://example.test/run/5" } : { detail: "The verdict's own line." }),
      findings: FINDINGS,
    });

  it.each([
    ["changes recommended", "the review recommended changes, and no automatic fix round starts"],
    ["budget spent", "the automatic fix rounds are spent"],
    ["no progress", "no progress: the last fix round closed none of the findings it was given"],
    ["needs a closer look", "the review needs a closer look"],
    ["failed", "the review didn't finish"],
    ["post failed", "the review finished and its verdict was posted, but a later step of posting it failed"],
  ] as const)("on %s, names the slice, the reason, the open findings and the ways on", (reason, why) => {
    const text = park(reason);

    expect(text).toContain("**The PRD chain parked** at slice 3 of 7, #244, on PRD PR #300.");
    expect(text).toContain(`**Why:** ${why}`);
    expect(text).toContain("- [The guard runs after the return](https://example.test/thread/1) (`src/a.ts:12`)");
    expect(text).toContain("- [A test asserts the old behaviour](https://example.test/review/9) (`tests/a.test.ts:40`)");
    expect(text).toContain("- add `agent:fix` to PRD PR #300 for another fix round;");
    expect(text).toContain("- decline a finding by replying to it, then add `agent:review` there;");
    expect(text).toContain("- push a commit, then add `agent:review` there.");
    expect(text).toContain("The chain moves on once a review of the PRD PR's latest commit recommends approval.");
  });

  it("links the run a failed review ran in, and offers running the review again", () => {
    const text = park("failed");

    expect(text).toContain("[Workflow run](https://example.test/run/5)");
    expect(text).toContain("- add `agent:review` to PRD PR #300 to run the review again;");
    expect(text).toContain("**Open findings from earlier rounds:**");
    expect(park("budget spent")).not.toContain("run the review again");
  });

  /**
   * A verdict posted by a posting job that failed after it is not "no
   * verdict": the comment names it, and lists this round's findings as open
   * rather than only the earlier rounds'.
   */
  it("names the posted verdict where only posting failed after it", () => {
    const text = renderParkComment({
      round: slice([]),
      prNumber: "300",
      reason: "post failed",
      detail: "[The verdict](https://example.test/review/9) was *🟡 Changes recommended*.",
      runUrl: "https://example.test/run/5",
      findings: FINDINGS,
    });

    expect(text).toContain("[The verdict](https://example.test/review/9) was *🟡 Changes recommended*.");
    expect(text).not.toContain("there is no verdict");
    expect(text).toContain("**Open findings:**");
    expect(text).not.toContain("from earlier rounds");
    expect(text).toContain("- add `agent:review` to PRD PR #300 to run the review again;");
    expect(text).toContain("[Workflow run](https://example.test/run/5)");
  });

  it("names the final review, and what follows its approval", () => {
    const text = park("needs a closer look", { kind: "final", parent: "222" });

    expect(text).toContain("**The PRD chain parked** at the final review of PRD PR #300.");
    expect(text).toContain("marked ready for you once a review of its latest commit recommends approval");
    expect(text).not.toContain("The chain moves on");
  });

  it("says so where nothing is open", () => {
    const text = renderParkComment({ round: slice([]), prNumber: "300", reason: "needs a closer look", findings: [] });

    expect(text).toContain("**Open findings:** none.");
  });
});

/**
 * Which stop a verdict is, read off the row `deriveVerdict` gave, so the park
 * comment and the verdict line come from one decision.
 */
describe("parkReasonOf", () => {
  const output = (fixBeforeMerge: readonly string[]): ReviewOutput =>
    ({ findings: [], followUps: [], fixBeforeMerge, verified: [] }) as unknown as ReviewOutput;
  const inputs: VerdictInputs = {
    ci: "green",
    fixRoundProgress: undefined,
    stillOpen: 0,
    movedToFollowUps: 0,
    autoFix: false,
    base: "main",
  };

  it("reads each of #200's stops, and nothing where the chain moves on or a round starts", () => {
    const open = output(["the guard runs after the return"]);

    expect(parkReasonOf(deriveVerdict(open, { ...inputs, fixRounds: { spent: 3, budget: 3 } }))).toBe("budget spent");
    expect(parkReasonOf(deriveVerdict(open, { ...inputs, fixRoundProgress: { given: 2, closed: 0 } }))).toBe(
      "no progress",
    );
    expect(parkReasonOf(deriveVerdict(open, inputs))).toBe("changes recommended");
    expect(parkReasonOf(deriveVerdict(output([]), { ...inputs, ci: "unknown" }))).toBe("needs a closer look");
    expect(parkReasonOf(deriveVerdict(output([]), inputs))).toBeUndefined();
    expect(parkReasonOf(deriveVerdict(open, { ...inputs, autoFix: true }))).toBeUndefined();
    expect(parkReasonOf(VERDICTS["changes recommended, fix round started"])).toBeUndefined();
  });
});

/**
 * `readSliceRound` against a real PRD branch: the first-parent log, the
 * `Agent-Slice` trailers and git's own remerge diff, which is what tells a
 * merge that resolved a conflict from one that resolved nothing.
 */
describe("readSliceRound", () => {
  const SPAWNS = 40;

  const g = (...args: string[]): string =>
    execFileSync("git", ["-C", fixture.dir, ...args], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT }).trim();
  const write = (file: string, text: string): void => fs.writeFileSync(path.join(fixture.dir, file), text);
  const commitAll = (message: string): string => {
    g("add", "-A");
    g("commit", "-q", "-m", message);
    return g("rev-parse", "HEAD");
  };

  it(
    "reads the current slice, k of n, and describes each merge by its resolution",
    () => {
      fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-round-"));
      fixture.subIssues = [
        { number: 10, state: "OPEN" },
        { number: 11, state: "OPEN" },
        { number: 12, state: "OPEN" },
      ];
      g("init", "-q", "-b", "main");
      g("config", "user.email", "test@example.test");
      g("config", "user.name", "test");
      write("shared.txt", "base\n");
      commitAll("base");
      g("checkout", "-q", "-b", "agent/prd-222-x");
      write("one.txt", "one\n");
      commitAll("feat: slice one\n\nAgent-Slice: #10");
      write("shared.txt", "prd\n");
      const built = commitAll("feat: slice two\n\nAgent-Slice: #11");

      g("checkout", "-q", "main");
      write("other.txt", "other\n");
      commitAll("main: an unrelated change");
      g("checkout", "-q", "agent/prd-222-x");
      g("merge", "-q", "--no-edit", "main");
      const clean = g("rev-parse", "HEAD");

      g("checkout", "-q", "main");
      write("shared.txt", "main\n");
      commitAll("main: a conflicting change");
      g("checkout", "-q", "agent/prd-222-x");
      try {
        g("merge", "-q", "--no-edit", "main");
      } catch {
        // The conflict this case is about.
      }
      write("shared.txt", "resolved\n");
      const resolved = commitAll("Merge branch 'main' into agent/prd-222-x");
      write("one.txt", "one, fixed\n");
      const fix = commitAll("fix: a finding");

      const round = readSliceRound("222", "main");

      expect(round.unknownBecause).toBeUndefined();
      expect(round.slice?.subIssue).toBe(11);
      expect(round.slice?.k).toBe(2);
      expect(round.slice?.n).toBe(3);
      expect(round.slice?.commits.map((c) => c.sha)).toEqual([built, clean, resolved, fix]);
      const [first, cleanMerge, resolvedMerge, last] = round.slice?.commits ?? [];
      expect(first).toMatchObject({ subject: "feat: slice two", merge: false, resolution: "" });
      expect(cleanMerge).toMatchObject({ merge: true, resolution: "" });
      expect(resolvedMerge?.merge).toBe(true);
      expect(resolvedMerge?.resolution).toContain("+resolved");
      expect(last).toMatchObject({ subject: "fix: a finding", merge: false });
    },
    SPAWNS * SUBPROCESS_TIMEOUT,
  );

  it("says why where no slice can be told", () => {
    fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-round-missing-"));

    const round = readSliceRound("222", "main");

    expect(round.slice).toBeUndefined();
    expect(round.unknownBecause).toContain("could not be read");
  });
});
