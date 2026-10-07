import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";
import {
  parkReasonOf,
  readPrdBranch,
  readSliceRound,
  renderFinalReviewBrief,
  renderParkComment,
  renderPrdSummary,
  renderSliceRoundBrief,
  roundName,
  sliceCriteria,
  sliceRedTests,
  type PostedReview,
  type ParkFinding,
  type ParkReason,
  type PrdRound,
  type RangeCommit,
} from "../shared/prd-round.js";
import {
  deriveVerdict,
  renderCriteriaGroup,
  renderReviewBody,
  reviewOutputSchema,
  VERDICTS,
  type CriterionResult,
  type ReviewOutput,
  type VerdictInputs,
} from "../shared/review-output.js";
import { verifyCarried, type CarriedFinding } from "../shared/review-verification.js";
import { renderRedTestsBlock, type RedTestsRecord } from "../shared/red-check.js";
import { sliceRanges } from "../shared/slice-ranges.js";

/**
 * A review round on a PRD PR (PRD #222, #244): the slice-round and final-review
 * briefs, and the park comment the advance job posts on the parent when a
 * round ends without moving the chain on.
 */

/** Where `readSliceRound`'s git runs, and what its `gh` answers. */
const fixture = vi.hoisted(() => ({ dir: "", subIssues: [] as { number: number; title?: string; state: string }[] }));

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
  /** #215: every open finding, from any slice, and nothing a maintainer settled. */
  it("asks for a ruling on every open finding from any slice, and never a settled one again", () => {
    const text = renderFinalReviewBrief("222", BRANCH, "main");

    expect(text).toContain("Rule on **every** open finding");
    expect(text).toContain("whichever slice's round raised it");
    expect(text).toContain("declined or resolved by hand is raised again");
    expect(text).toContain("what no slice round could see");
  });
});

/**
 * **#215 on the final review**: a finding a slice round raised and nothing
 * closed stays open whatever the final review says of it, so the verdict
 * cannot be the one that says nothing is left to fix.
 */
describe("a finding still open from an earlier slice", () => {
  const carried: CarriedFinding = {
    id: "f-0badc0de",
    threadId: "PRRT_1",
    text: "src/a.ts:3 the guard runs after the return",
    title: "the guard runs after the return",
    anchor: "src/a.ts:3",
  };
  const clean = reviewOutputSchema["~standard"].validate({ summary: "s", findings: [] }) as { value: ReviewOutput };
  const inputs: VerdictInputs = {
    ci: "green",
    fixRoundProgress: undefined,
    stillOpen: 0,
    movedToFollowUps: 0,
    autoFix: false,
  };

  it("keeps the verdict off approval where the final review ruled on nothing", () => {
    const { stillOpen, resolved } = verifyCarried([carried], []);
    const verdict = deriveVerdict(clean.value, { ...inputs, stillOpen: stillOpen.length });
    const posted = renderReviewBody({
      verdict,
      output: clean.value,
      placed: [],
      movedToFollowUps: 0,
      stillOpen,
      resolved,
      followUps: [],
      droppedFollowUps: 0,
    });

    expect(stillOpen).toHaveLength(1);
    expect(verdict.verdict).not.toBe("approval recommended");
    expect(posted).not.toContain("Nothing left to fix");
    expect(posted).not.toContain("Nothing is open");
    expect(posted).toContain("the guard runs after the return");
  });

  it("approves only once the finding is ruled closed", () => {
    const { stillOpen } = verifyCarried([carried], [{ id: "f-0badc0de", status: "landed", note: "fixed" }]);

    expect(deriveVerdict(clean.value, { ...inputs, stillOpen: stillOpen.length }).verdict).toBe(
      "approval recommended",
    );
  });
});

/**
 * The final review's record of what each slice changed or dropped (#247),
 * read off the slice rounds' review bodies by the commit each one reviewed,
 * through the slice ranges.
 */
describe("sliceCriteria", () => {
  const subIssues = [
    { number: 242, state: "OPEN" as const },
    { number: 243, state: "OPEN" as const },
    { number: 244, state: "OPEN" as const },
    { number: 245, state: "OPEN" as const },
  ];
  // Newest first, as `git log` lists it: two commits of 242, a fix of 242,
  // a merge of the default branch, one of 243 and one of 244. 245 is not built.
  const ranges = sliceRanges(
    [
      { sha: "c6", parents: ["c5"], slice: 244 },
      { sha: "c5", parents: ["c4"], slice: 243 },
      { sha: "c4", parents: ["c3", "main1"], slice: null },
      { sha: "c3", parents: ["c2"], slice: null },
      { sha: "c2", parents: ["c1"], slice: 242 },
      { sha: "c1", parents: ["c0"], slice: 242 },
    ],
    subIssues,
  );
  const group = (results: CriterionResult[]): string =>
    `## Agent review\n\n${renderCriteriaGroup(results) ?? ""}\n\n<!-- agent-follow-ups {} -->`;
  const bot = (commit: string, body: string): PostedReview => ({ author: "github-actions", commit, body });

  it("takes each slice's newest round with a record, and reads its changed and unmet criteria", () => {
    const reviews = [
      bot("c2", group([{ id: "C1", text: "It refuses a stale tag.", status: "unmet", reason: "not yet" }])),
      // The fix round's re-review, which approved slice 242.
      bot("c3", group([
        { id: "C1", text: "It refuses a stale tag.", status: "unmet", reason: "declined by the maintainer" },
        { id: "C2", text: "It logs the tag.", status: "changed", reason: "the log is a warning now" },
        { id: "C3", text: "It is fast.", status: "met" },
      ])),
      bot("c5", group([{ id: "C1", text: "Everything as written.", status: "met" }])),
      // A slice whose sub-issue named no criteria.
      bot("c6", "## Agent review\n\nNo criteria group."),
    ];

    expect(sliceCriteria(reviews, ranges)).toEqual([
      {
        subIssue: 242,
        record: {
          kind: "recorded",
          changes: [
            { status: "unmet", line: "It refuses a stale tag. · declined by the maintainer" },
            { status: "changed", line: "It logs the tag. · the log is a warning now" },
          ],
        },
      },
      { subIssue: 243, record: { kind: "recorded", changes: [] } },
      { subIssue: 244, record: { kind: "none checked" } },
    ]);
  });

  /** Anyone may post a review, and this text goes into the PRD PR's body. */
  it("reads only reviews this loop posted, and says where a slice has none", () => {
    const forged = { author: "someone", commit: "c5", body: group([{ id: "C1", text: "x", status: "changed", reason: "y" }]) };

    expect(sliceCriteria([forged], ranges).map((s) => s.record.kind)).toEqual(["no record", "no record", "no record"]);
  });
});

/**
 * Each slice's red tests (#235), read off the slice rounds' review bodies the
 * way `sliceCriteria` reads their criteria: by the commit each one reviewed.
 */
describe("sliceRedTests", () => {
  const ranges = sliceRanges(
    [
      { sha: "c4", parents: ["c3"], slice: 244 },
      { sha: "c3", parents: ["c2"], slice: 243 },
      { sha: "c2", parents: ["c1"], slice: null },
      { sha: "c1", parents: ["c0"], slice: 242 },
    ],
    [242, 243, 244, 245].map((number) => ({ number, state: "OPEN" as const })),
  );
  const record = (name: string): RedTestsRecord => ({ known: true, red: [{ name, classname: "c" }], more: 0 });
  const body = (r: RedTestsRecord): string => `## Agent review\n\nText.\n\n${renderRedTestsBlock(r)}\n\n<!-- agent-follow-ups {} -->`;
  const bot = (commit: string, text: string): PostedReview => ({ author: "github-actions", commit, body: text });

  it("takes each landed slice's newest round that carries the record", () => {
    const reviews = [
      bot("c1", body(record("first round"))),
      // The fix round's re-review, which approved slice 242.
      bot("c2", body(record("after the fix"))),
      bot("c3", body({ known: false, red: [], more: 0 })),
      // A slice round from before the record existed.
      bot("c4", "## Agent review\n\nNo record."),
    ];

    expect(sliceRedTests(reviews, ranges)).toEqual([
      { subIssue: 242, record: record("after the fix") },
      { subIssue: 243, record: { known: false, red: [], more: 0 } },
      { subIssue: 244, record: undefined },
    ]);
  });

  /** Anyone may post a review, and this text goes into the PRD PR's body. */
  it("reads only reviews this loop posted", () => {
    const forged = { author: "someone", commit: "c3", body: body(record("forged")) };

    expect(sliceRedTests([forged], ranges).map((s) => s.record)).toEqual([undefined, undefined, undefined]);
  });
});

/**
 * The final review's PRD summary (#247, #356), laid out as a regular pull
 * request's: the review's outcome, a *Differs from the PRD* line per slice
 * that changed or dropped a criterion, the Evidence and the Merge Danger, its
 * known issues naming the follow-ups filed on merge.
 */
describe("renderPrdSummary", () => {
  const followUp = { title: "the cache key omits the tenant", location: "src/cache.ts:12", body: "b", severity: "medium" as const };
  const evidence = { ci: "green", head: "h".repeat(40) } as const;
  const danger = { door: "two-way", blastRadius: "adopters" } as const;
  const quiet = { outcome: "o", danger, slices: [], followUps: [], evidence };

  it("lays out the outcome, a line per slice that differs, the Evidence and the Merge Danger, in that order", () => {
    const text = renderPrdSummary({
      outcome: "Each slice is built on one branch.\n\n- Slice PRs are no longer opened.",
      danger: { ...danger, breaking: ["Adopters must drop the `closed` trigger."] },
      slices: [
        { subIssue: 242, record: { kind: "recorded", changes: [] } },
        {
          subIssue: 243,
          record: {
            kind: "recorded",
            changes: [
              { status: "unmet", line: "It refuses a stale tag. · declined" },
              { status: "changed", line: "It logs the tag. · a warning now" },
            ],
          },
        },
        { subIssue: 244, record: { kind: "none checked" } },
        { subIssue: 245, record: { kind: "no record" } },
      ],
      followUps: [followUp],
      evidence,
    });

    expect(text).toBe(
      [
        "Each slice is built on one branch.\n\n- Slice PRs are no longer opened.",
        "**Differs from the PRD:** #243 dropped: It refuses a stale tag. · declined; changed: It logs the tag. · a warning now",
        "**Differs from the PRD:** #245: no review of this slice could be read, so whether it changed or dropped a criterion is not known.",
        "## Evidence",
        "- **Before:** not checked. The test-first check is off, so no test in any slice is shown to fail without its change.\n  **After:** CI is green at `hhhhhhh`.",
        "## Merge Danger",
        "**Door:** two-way",
        "**Blast Radius:** adopters",
        "**Breaking:** Adopters must drop the `closed` trigger.",
        "**Known issues**, filed when this merges:\n\n- the cache key omits the tenant (`src/cache.ts:12`)",
      ].join("\n\n"),
    );
  });

  /** #356: the old sections are gone, their content in Summary and Merge Danger. */
  it("carries none of the retired sections", () => {
    const text = renderPrdSummary({ ...quiet, followUps: [followUp] });

    for (const heading of ["### Outcome", "### Behaviour changes", "### Acceptance criteria changed or dropped", "### Known issues"]) {
      expect(text).not.toContain(heading);
    }
  });

  it("leaves the Differs lines and the known issues out where there are none, and says where the history could not be read", () => {
    const none = renderPrdSummary({
      ...quiet,
      outcome: undefined,
      slices: [{ subIssue: 242, record: { kind: "recorded", changes: [] } }],
    });

    expect(none).toMatch(/^_The final review wrote no outcome\._\n\n## Evidence/);
    expect(none).not.toContain("Differs from the PRD");
    expect(none).not.toContain("Known issues");
    expect(none).toMatch(/\*\*Blast Radius:\*\* adopters$/);
    expect(renderPrdSummary({ ...quiet, slices: undefined })).toContain(
      "o\n\n**Differs from the PRD:** not known. The PRD branch's history could not be read",
    );
  });

  /** #235, #355: the Evidence, by slice where the red check is configured and in one entry where it is not, before the Merge Danger. */
  it("gives the Evidence by slice where the red check is configured, and in one entry where it is not", () => {
    const listed = renderPrdSummary({
      ...quiet,
      redTests: { slices: [{ subIssue: 242, record: { known: true, red: [{ name: "test_a", classname: "c" }], more: 0 } }] },
    });

    expect(listed).toContain("## Evidence\n\n- #242\n  **Before:** 1 test(s) fail without this slice.");
    expect(listed).toContain("  - `test_a` (`c`)\n\n  **After:** CI is green at `hhhhhhh`.\n\n## Merge Danger");
    expect(renderPrdSummary({ ...quiet, redTests: { slices: undefined } })).toContain("history could not be read");
    expect(renderPrdSummary(quiet)).toContain("## Evidence\n\n- **Before:** not checked.");
    expect(renderPrdSummary(quiet)).not.toContain("Failing-first");
  });

  /**
   * The final review is handed the whole block and rewrites it whenever the
   * head moved, so an outcome may carry what this render writes afresh. Each
   * such part is dropped, so the body never shows it twice.
   */
  it("drops the Differs lines, the Evidence and the Merge Danger an outcome carried forward", () => {
    const previous = renderPrdSummary({
      ...quiet,
      outcome: "Each slice is built on one branch.",
      slices: [{ subIssue: 245, record: { kind: "no record" } }],
      followUps: [followUp],
    });
    const fresh = renderPrdSummary({ ...quiet, outcome: "Each slice is built on one branch." });

    expect(renderPrdSummary({ ...quiet, outcome: previous })).toBe(fresh);
    expect(renderPrdSummary({ ...quiet, outcome: "Each slice is built on one branch.\n\n## Merge Danger\n\n**Door:** stale" })).toBe(fresh);
    expect(
      renderPrdSummary({ ...quiet, outcome: "Each slice is built on one branch.\n\n### Failing-first tests\n\n- `stale`" }),
    ).toBe(fresh);
  });

  /** A block written before #356 carries the old sections; the outcome keeps its text and none of them. */
  it("keeps only the outcome's text from a block written in the old layout", () => {
    const legacy = [
      "### Outcome",
      "Each slice is built on one branch.",
      "### Behaviour changes",
      "- **Breaking:** stale",
      "### Acceptance criteria changed or dropped",
      "None.",
      "### Known issues",
      "None recorded to be filed.",
    ].join("\n\n");

    expect(renderPrdSummary({ ...quiet, outcome: legacy })).toBe(
      renderPrdSummary({ ...quiet, outcome: "Each slice is built on one branch." }),
    );
  });

  /** #216: nothing in what the workflow lays out says the PRD PR is a draft. */
  it("carries no draft-only text", () => {
    expect(renderPrdSummary(quiet)).not.toMatch(/draft|summarize the whole PRD here/i);
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
    expect(parkReasonOf({ ...VERDICTS["changes recommended"], startsFixRound: true })).toBeUndefined();
  });
});

/**
 * `readSliceRound` against a real PRD branch: the first-parent log, the
 * `Agent-Slice` trailers and git's own remerge diff, which is what tells a
 * merge that resolved a conflict from one that resolved nothing.
 */
describe("readSliceRound", () => {
  const SPAWNS = 40;

  // The sub-issues are read under `GH_REPO`, a required input, so it is set
  // here rather than borrowed from whatever environment runs the suite.
  const REPO = process.env["GH_REPO"];
  beforeEach(() => {
    process.env["GH_REPO"] = "o/r";
  });
  afterEach(() => {
    if (REPO === undefined) delete process.env["GH_REPO"];
    else process.env["GH_REPO"] = REPO;
  });

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

  /** The one reading the progress list is rendered from (#246), titles and all. */
  it(
    "reads the sub-issues with their titles, and the ranges, for the progress list",
    () => {
      fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-branch-"));
      fixture.subIssues = [
        { number: 10, title: "One", state: "OPEN" },
        { number: 11, title: "Two", state: "OPEN" },
      ];
      g("init", "-q", "-b", "main");
      g("config", "user.email", "test@example.test");
      g("config", "user.name", "test");
      write("base.txt", "base\n");
      commitAll("base");
      g("checkout", "-q", "-b", "agent/prd-222-x");
      write("one.txt", "one\n");
      const one = commitAll("feat: slice one\n\nAgent-Slice: #10");
      g("commit", "-q", "--allow-empty", "-m", "Merge main into agent/prd-222-x\n\nAgent-Catch-Up: #11");
      const caughtUp = g("rev-parse", "HEAD");

      const branch = readPrdBranch("222", "main");

      expect(branch.subIssues).toEqual(fixture.subIssues);
      expect(branch.log.map((c) => [c.sha, c.slice, c.catchUp])).toEqual([
        [caughtUp, null, true],
        [one, 10, false],
      ]);
      expect(branch.ranges.current).toEqual({ subIssue: 10, k: 1, n: 2 });
      expect(branch.ranges.next).toBe(11);
    },
    20 * SUBPROCESS_TIMEOUT,
  );

  it("says why where no slice can be told", () => {
    fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-round-missing-"));

    const round = readSliceRound("222", "main");

    expect(round.slice).toBeUndefined();
    expect(round.unknownBecause).toContain("could not be read");
  });
});
