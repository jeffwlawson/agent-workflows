import { describe, expect, it } from "vitest";
import {
  FINAL_REVIEW_MARK,
  finalReviewRequestedLines,
  PROGRESS_END,
  PROGRESS_START,
  progressAtRoundEnd,
  renderPrdStatus,
  renderPrStatus,
  renderProgressList,
  sliceStates,
  spliceProgressList,
  spliceStatus,
  STATUS_END,
  STATUS_START,
  statusBlock,
  type ProgressInputs,
  type ProgressSubIssue,
} from "../shared/progress-list.js";
import type { RoundCounts } from "../shared/round-header.js";
import { sliceRanges, type BranchCommit } from "../shared/slice-ranges.js";

/**
 * The PRD PR's progress list (#246), a table since #298: one row per
 * sub-issue, rendered from the sub-issues, the slice ranges, the head's
 * verdict, what is running, the finishing state and the rounds counted off the
 * PRD PR, and nothing else. And the status line beside it.
 */

const SUBS: readonly ProgressSubIssue[] = [
  { number: 10, title: "Slice ranges", state: "OPEN" },
  { number: 11, title: "The approval gate", state: "OPEN" },
  { number: 12, title: "The progress list", state: "OPEN" },
];

/** A first-parent log, newest first, with one trailered commit per sub-issue built, in order. */
const built = (...subs: readonly number[]): BranchCommit[] =>
  subs
    .map((sub, i): BranchCommit => ({ sha: `c${i + 1}`, parents: [`c${i}`], slice: sub }))
    .reverse();

const PR = "https://github.com/acme/widgets/pull/9";

const inputs = (over: Partial<ProgressInputs> & { readonly built?: readonly number[] } = {}): ProgressInputs => {
  const subIssues = over.subIssues ?? SUBS;
  return {
    subIssues,
    ranges: over.ranges ?? sliceRanges(built(...(over.built ?? [])), subIssues),
    verdict: over.verdict ?? "none",
    running: over.running ?? null,
    finalReview: over.finalReview ?? "not requested",
    ...(over.prUrl === undefined ? {} : { prUrl: over.prUrl }),
    ...(over.rounds === undefined ? {} : { rounds: over.rounds }),
    ...(over.open === undefined ? {} : { open: over.open }),
  };
};

const states = (input: ProgressInputs): string[] => sliceStates(input).map((s) => `#${s.subIssue} ${s.state}`);

describe("each sub-issue's state", () => {
  it("shows nothing started before the first build", () => {
    expect(states(inputs())).toEqual(["#10 not started", "#11 not started", "#12 not started"]);
  });

  it("shows the sub-issue a build run is building", () => {
    expect(states(inputs({ running: { kind: "build", subIssue: 10 } }))).toEqual([
      "#10 building",
      "#11 not started",
      "#12 not started",
    ]);
  });

  it("shows the current slice in review while its round runs, and the slices before it approved", () => {
    expect(states(inputs({ built: [10, 11], running: { kind: "review" } }))).toEqual([
      "#10 approved",
      "#11 in review",
      "#12 not started",
    ]);
  });

  it("shows the current slice approved on an approval, and building the next one after it", () => {
    expect(states(inputs({ built: [10, 11], verdict: "approval" }))).toEqual([
      "#10 approved",
      "#11 approved",
      "#12 not started",
    ]);
    expect(states(inputs({ built: [10, 11], verdict: "approval", running: { kind: "build", subIssue: 12 } }))).toEqual([
      "#10 approved",
      "#11 approved",
      "#12 building",
    ]);
  });

  it.each(["other", "none"] as const)("shows the current slice parked on %s verdict with no round running", (verdict) => {
    expect(states(inputs({ built: [10, 11], verdict }))).toEqual(["#10 approved", "#11 parked", "#12 not started"]);
  });

  /** A release before #222 closed each sub-issue as its slice landed, with no trailer. */
  it("shows a closed sub-issue with no slice range as landed before the upgrade", () => {
    const subIssues: ProgressSubIssue[] = [{ ...SUBS[0], state: "CLOSED" } as ProgressSubIssue, ...SUBS.slice(1)];

    expect(states(inputs({ subIssues, built: [11], running: { kind: "review" } }))).toEqual([
      "#10 landed before upgrade",
      "#11 in review",
      "#12 not started",
    ]);
  });

  /** Closed is not progress: a sub-issue with a range is read off the branch, whatever its state. */
  it("reads a closed sub-issue with a slice range off the branch, not off its state", () => {
    const subIssues: ProgressSubIssue[] = SUBS.map((s) => ({ ...s, state: "CLOSED" }));

    expect(states(inputs({ subIssues, built: [10], running: { kind: "review" } }))[0]).toBe("#10 in review");
  });

  it("shows every slice approved once the final review is requested, whatever the final review does", () => {
    for (const verdict of ["approval", "other"] as const) {
      expect(states(inputs({ built: [10, 11, 12], verdict, running: { kind: "review" }, finalReview: "requested" }))).toEqual([
        "#10 approved",
        "#11 approved",
        "#12 approved",
      ]);
    }
  });
});

/** Full commit ids, so the diff links render: slice 1 is `a1`, slice 2 is `b1`..`b2`. */
const SHA = { base: "0000000", a1: "a1a1a1a", b1: "b1b1b1b", b2: "b2b2b2b" };
const REAL_LOG: BranchCommit[] = [
  { sha: SHA.b2, parents: [SHA.b1], slice: null },
  { sha: SHA.b1, parents: [SHA.a1], slice: 11 },
  { sha: SHA.a1, parents: [SHA.base], slice: 10 },
];
const ROUNDS: RoundCounts = {
  slices: {
    10: { reviews: 3, latestReview: `${PR}#pullrequestreview-3`, fixes: 2 },
    11: { reviews: 1, latestReview: `${PR}#pullrequestreview-4`, fixes: 0 },
  },
  final: { reviews: 0, fixes: 0 },
  all: { reviews: 4, fixes: 2 },
};

describe("the rendered table", () => {
  it("renders every state between its markers, one row per sub-issue, with no title beside a reference", () => {
    const subIssues: ProgressSubIssue[] = [
      { number: 9, title: "Before the upgrade", state: "CLOSED" },
      ...SUBS,
      { number: 13, title: "Later", state: "OPEN" },
    ];
    const ranges = sliceRanges(REAL_LOG, subIssues);

    expect(renderProgressList(inputs({ subIssues, ranges, running: { kind: "review" }, prUrl: PR, rounds: ROUNDS }))).toBe(
      [
        PROGRESS_START,
        "## Progress",
        "",
        "| Slice | Status | Reviews | Fixes | Diff |",
        "|---|---|---|---|---|",
        "| 1 · #9 | ☑️ Landed before upgrade | – | – | – |",
        `| 2 · #10 | ✅ Approved | [3](${PR}#pullrequestreview-3) | 2 | [diff](${PR}/files/${SHA.base}..${SHA.a1}) |`,
        `| 3 · #11 | 🔍 In review | [1](${PR}#pullrequestreview-4) | 0 | [diff](${PR}/files/${SHA.a1}..${SHA.b2}) |`,
        "| 4 · #12 | ⏳ Not started | – | – | – |",
        "| 5 · #13 | ⏳ Not started | – | – | – |",
        PROGRESS_END,
      ].join("\n"),
    );
    expect(renderProgressList(inputs({ subIssues, ranges }))).not.toContain("Before the upgrade");
  });

  it("names building, fixing and parked, with the open findings beside the current slice where there are any", () => {
    const ranges = sliceRanges(REAL_LOG, SUBS);

    expect(renderProgressList(inputs({ running: { kind: "build", subIssue: 10 } }))).toContain("| 1 · #10 | 🔨 Building |");
    expect(renderProgressList(inputs({ ranges, running: { kind: "fix" }, open: 2 }))).toContain("| 2 · #11 | 🔧 Fixing · 2 open |");
    expect(renderProgressList(inputs({ ranges, verdict: "other", open: 1 }))).toContain("| 2 · #11 | ⏸️ Parked · 1 open |");
    expect(renderProgressList(inputs({ ranges, verdict: "other", open: 0 }))).toContain("| 2 · #11 | ⏸️ Parked |");
    expect(renderProgressList(inputs({ ranges, verdict: "approval", open: 3 }))).toContain("| 2 · #11 | ✅ Approved |");
  });

  it("says a count it could not read, and links no diff with no PRD PR or no commits made yet", () => {
    const ranges = sliceRanges([{ sha: "(this slice)", parents: [SHA.a1], slice: 11 }, ...REAL_LOG.slice(2)], SUBS);

    expect(renderProgressList(inputs({ ranges, running: { kind: "review" }, prUrl: PR }))).toContain(
      `| 1 · #10 | ✅ Approved | – | – | [diff](${PR}/files/${SHA.base}..${SHA.a1}) |\n| 2 · #11 | 🔍 In review | – | – | – |`,
    );
    expect(renderProgressList(inputs({ ranges, rounds: ROUNDS }))).toContain("| 1 · #10 | ✅ Approved | [3](");
    expect(renderProgressList(inputs({ ranges, rounds: ROUNDS }))).toContain("| 2 · #11 | ⏸️ Parked | [1](");
    expect(renderProgressList(inputs({ ranges, rounds: ROUNDS })).match(/\[diff\]/g)).toBeNull();
  });

  it("is byte for byte the same when rendered again from the same state", () => {
    const state = inputs({ built: [10, 11], running: { kind: "review" } });

    expect(renderProgressList(state)).toBe(renderProgressList(state));
    expect(renderProgressList(state)).toBe(
      renderProgressList(inputs({ built: [10, 11], running: { kind: "review" } })),
    );
  });

  it("holds the final review's row and mark, and the final review's state, once it is requested", () => {
    const final = (verdict: ProgressInputs["verdict"], running: ProgressInputs["running"], open?: number): string =>
      renderProgressList(
        inputs({ built: [10, 11, 12], verdict, running, finalReview: "requested", prUrl: PR, ...(open === undefined ? {} : { open }) }),
      );

    expect(final("approval", { kind: "review" })).toContain(
      `| 3 · #12 | ✅ Approved | – | – | – |\n| Final review | 🔍 In review | – | – | [all](${PR}/files) |\n${FINAL_REVIEW_MARK}\n${PROGRESS_END}`,
    );
    expect(final("approval", null)).toContain("| Final review | ✅ Approved |");
    expect(final("other", null, 1)).toContain("| Final review | ⏸️ Parked · 1 open |");
    expect(final("other", { kind: "fix" }, 2)).toContain("| Final review | 🔧 Fixing · 2 open |");
    expect(renderProgressList(inputs({ built: [10, 11, 12], verdict: "approval" }))).not.toContain(FINAL_REVIEW_MARK);
  });

  /**
   * The finishing run runs no toolchain, so it writes these lines in front of
   * the end marker of the list the last slice's round left. That has to be
   * the render, or the list it leaves is one nothing rendered.
   */
  it("is, for the final review requested, the approved list with the finishing run's lines before its end", () => {
    const ranges = sliceRanges(REAL_LOG, SUBS.slice(0, 2));
    const approved = renderProgressList(inputs({ subIssues: SUBS.slice(0, 2), ranges, verdict: "approval", prUrl: PR, rounds: ROUNDS }));
    const requested = renderProgressList(
      inputs({
        subIssues: SUBS.slice(0, 2),
        ranges,
        verdict: "approval",
        running: { kind: "review" },
        finalReview: "requested",
        prUrl: PR,
        rounds: ROUNDS,
      }),
    );

    expect(approved.replace(PROGRESS_END, `${finalReviewRequestedLines(PR)}${PROGRESS_END}`)).toBe(requested);
  });
});

describe("the status line", () => {
  const ranges = sliceRanges(REAL_LOG, SUBS);

  it("says what is building, in review, fixing, parked or approved, and on which slice", () => {
    expect(renderPrdStatus(inputs())).toBe("**⏳ Not started**");
    expect(renderPrdStatus(inputs({ ranges, verdict: "approval", running: { kind: "build", subIssue: 12 } }))).toBe(
      "**🔨 Building slice 3 of 3** · #12",
    );
    expect(renderPrdStatus(inputs({ ranges, running: { kind: "review" } }))).toBe("**🔍 Reviewing slice 2 of 3** · #11");
    expect(renderPrdStatus(inputs({ ranges, running: { kind: "fix" }, open: 2, rounds: ROUNDS }))).toBe(
      `**🔧 Fixing slice 2 of 3** · #11 · 2 findings open. [See it](${PR}#pullrequestreview-4)`,
    );
    expect(renderPrdStatus(inputs({ ranges, verdict: "other", open: 1 }))).toBe("**⏸️ Slice 2 of 3 parked** · #11 · 1 finding open.");
    expect(renderPrdStatus(inputs({ ranges, verdict: "approval" }))).toBe("**✅ Slice 2 of 3 approved** · #11");
  });

  it("says where the final review is once it is requested", () => {
    const final = (over: Partial<ProgressInputs>): string =>
      renderPrdStatus(inputs({ built: [10, 11, 12], finalReview: "requested", ...over }));
    const rounds: RoundCounts = { ...ROUNDS, final: { reviews: 1, latestReview: `${PR}#pullrequestreview-9`, fixes: 0 } };

    expect(final({ running: { kind: "review" } })).toBe("**🔍 Final review of all 3 slices**");
    expect(final({ verdict: "other", open: 1, rounds })).toBe(
      `**⏸️ Final review parked:** 1 finding open. [See it](${PR}#pullrequestreview-9)`,
    );
    expect(final({ verdict: "approval", rounds })).toBe(
      `**✅ Final review approved:** ready for you to merge. [See it](${PR}#pullrequestreview-9)`,
    );
  });

  it("goes between its own markers, and is replaced only where the body has them", () => {
    const block = statusBlock("**🔍 Reviewing slice 1 of 2** · #10");
    const body = `> [!NOTE]\n> ${statusBlock("old")}\n>\n> Mine.`;

    expect(block).toBe(`${STATUS_START}**🔍 Reviewing slice 1 of 2** · #10${STATUS_END}`);
    expect(spliceStatus(body, block)).toBe(`> [!NOTE]\n> ${block}\n>\n> Mine.`);
    expect(spliceStatus("Mine.", block)).toBe("Mine.");
    expect(spliceStatus(`${STATUS_START}x`, block)).toBeUndefined();
    expect(spliceStatus(`${statusBlock("a")}${statusBlock("b")}`, block)).toBeUndefined();
  });
});

/**
 * What a build run that stops writes back (#246), as its runner renders it:
 * no round running, and the sub-issue it was building either not pushed or
 * pushed with no review.
 */
describe("the list a stopped build run writes back", () => {
  it("shows the sub-issue not started where nothing was pushed, and the slice before it as its verdict has it", () => {
    expect(states(inputs({ built: [10], verdict: "approval" }))).toEqual(["#10 approved", "#11 not started", "#12 not started"]);
    // A merge of the default branch pushed first leaves the head unreviewed.
    expect(states(inputs({ built: [10], verdict: "none" }))).toEqual(["#10 parked", "#11 not started", "#12 not started"]);
  });

  it("shows the sub-issue parked where it was pushed", () => {
    expect(states(inputs({ built: [10, 11], verdict: "none" }))).toEqual(["#10 approved", "#11 parked", "#12 not started"]);
  });
});

describe("the list for each way a round ends", () => {
  const end = { review: "{{AGENT_REVIEW_URL}}", open: 2, prUrl: PR, rounds: ROUNDS };

  it("renders approved, parked and fixing from one reading of the branch, counting this review", () => {
    const branch = { subIssues: SUBS, ranges: sliceRanges(REAL_LOG, SUBS), finalReview: "not requested" as const };
    const lists = progressAtRoundEnd(branch, end);

    expect(lists.approved.progress).toContain("| 2 · #11 | ✅ Approved | [2]({{AGENT_REVIEW_URL}}) | 0 |");
    expect(lists.parked.progress).toContain("| 2 · #11 | ⏸️ Parked · 2 open | [2]({{AGENT_REVIEW_URL}}) | 0 |");
    expect(lists.running.progress).toContain("| 2 · #11 | 🔧 Fixing · 2 open | [2]({{AGENT_REVIEW_URL}}) | 1 |");
    expect(lists.parked.status).toBe(statusBlock("**⏸️ Slice 2 of 3 parked** · #11 · 2 findings open. [See it]({{AGENT_REVIEW_URL}})"));
    expect(lists.approved.status).toBe(statusBlock("**✅ Slice 2 of 3 approved** · #11"));
  });

  it("renders the final review's ending on the final review", () => {
    const lists = progressAtRoundEnd({ subIssues: SUBS, ranges: sliceRanges(built(10, 11, 12), SUBS), finalReview: "requested" }, end);

    expect(lists.approved.progress).toContain("| Final review | ✅ Approved | [1]({{AGENT_REVIEW_URL}}) | 0 |");
    expect(lists.parked.progress).toContain("| Final review | ⏸️ Parked · 2 open |");
    expect(lists.running.progress).toContain("| Final review | 🔧 Fixing · 2 open | [1]({{AGENT_REVIEW_URL}}) | 1 |");
    expect(lists.parked.status).toBe(statusBlock("**⏸️ Final review parked:** 2 findings open. [See it]({{AGENT_REVIEW_URL}})"));
    for (const list of Object.values(lists)) expect(list.progress).toContain(FINAL_REVIEW_MARK);
  });

  it("leaves the counts unknown where the rounds could not be read", () => {
    const branch = { subIssues: SUBS, ranges: sliceRanges(REAL_LOG, SUBS), finalReview: "not requested" as const };

    expect(progressAtRoundEnd(branch, { review: "x", open: 0 }).approved.progress).toContain("| 2 · #11 | ✅ Approved | – | – | – |");
  });
});

describe("splicing the list into a body", () => {
  const list = renderProgressList(inputs({ built: [10], running: { kind: "review" } }));
  const old = renderProgressList(inputs({ running: { kind: "build", subIssue: 10 } }));

  it("replaces the list and keeps every other byte", () => {
    const body = `Closes #1\r\n\n${old}\n\nMine, with a CRLF.\r\n`;

    expect(spliceProgressList(body, list)).toBe(`Closes #1\r\n\n${list}\n\nMine, with a CRLF.\r\n`);
  });

  it("appends a list to a body that has none", () => {
    expect(spliceProgressList("Mine.", list)).toBe(`Mine.\n\n${list}`);
    expect(spliceProgressList("Mine.\n", list)).toBe(`Mine.\n\n${list}`);
    expect(spliceProgressList("", list)).toBe(list);
  });

  it.each([
    ["a start with no end", `Mine.\n${PROGRESS_START}\nrest`],
    ["two lists", `${old}\n${old}`],
    ["the end before the start", `${PROGRESS_END}\nmine\n${PROGRESS_START}`],
  ])("writes nothing over %s", (_case, body) => {
    expect(spliceProgressList(body, list)).toBeUndefined();
  });
});

/** A regular pull request's status line, as its review leaves it (#298). */
describe("a regular pull request's status line", () => {
  const review = "https://github.com/acme/widgets/pull/9#pullrequestreview-1";

  it("says ready, fixing or parked, with what is open, and links the review", () => {
    expect(renderPrStatus({ verdict: "approval recommended", startsFixRound: false, open: 0, review })).toBe(
      `**✅ Ready for you:** the review recommends approval. [See it](${review})`,
    );
    expect(renderPrStatus({ verdict: "changes recommended", startsFixRound: true, open: 2, review })).toBe(
      `**🔧 Fixing:** 2 findings open. [See it](${review})`,
    );
    expect(renderPrStatus({ verdict: "changes recommended", startsFixRound: false, open: 1, review })).toBe(
      `**⏸️ Parked:** 1 finding open. [See it](${review})`,
    );
    expect(renderPrStatus({ verdict: "needs a closer look", startsFixRound: false, open: 0, review })).toBe(
      `**⏸️ Parked:** the review needs a closer look. [See it](${review})`,
    );
  });
});
