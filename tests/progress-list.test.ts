import { describe, expect, it } from "vitest";
import {
  FINAL_REVIEW_MARK,
  FINAL_REVIEW_REQUESTED_LINES,
  PROGRESS_END,
  PROGRESS_START,
  progressAtRoundEnd,
  renderProgressList,
  sliceStates,
  spliceProgressList,
  type ProgressInputs,
  type ProgressSubIssue,
} from "../shared/progress-list.js";
import { sliceRanges, type BranchCommit } from "../shared/slice-ranges.js";

/**
 * The PRD PR's progress list (#246): one line per sub-issue, rendered from the
 * sub-issues, the slice ranges, the head's verdict, what is running and the
 * finishing state, and nothing else.
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

const inputs = (over: Partial<ProgressInputs> & { readonly built?: readonly number[] } = {}): ProgressInputs => {
  const subIssues = over.subIssues ?? SUBS;
  return {
    subIssues,
    ranges: over.ranges ?? sliceRanges(built(...(over.built ?? [])), subIssues),
    verdict: over.verdict ?? "none",
    running: over.running ?? null,
    finalReview: over.finalReview ?? "not requested",
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

describe("the rendered list", () => {
  it("renders every state between its markers, one line per sub-issue", () => {
    const subIssues: ProgressSubIssue[] = [
      { number: 9, title: "Before the upgrade", state: "CLOSED" },
      ...SUBS,
      { number: 13, title: "Later", state: "OPEN" },
    ];
    const ranges = sliceRanges(built(10, 11), subIssues);

    expect(renderProgressList(inputs({ subIssues, ranges, running: { kind: "review" } }))).toBe(
      [
        PROGRESS_START,
        "**Progress**",
        "",
        "- ☑️ **Landed before upgrade:** #9 Before the upgrade",
        "- ✅ **Approved:** #10 Slice ranges",
        "- 🔍 **In review:** #11 The approval gate",
        "- ⬜ **Not started:** #12 The progress list",
        "- ⬜ **Not started:** #13 Later",
        PROGRESS_END,
      ].join("\n"),
    );
    expect(renderProgressList(inputs({ built: [10], verdict: "other" }))).toContain("- ⏸️ **Parked:** #10 Slice ranges");
    expect(renderProgressList(inputs({ running: { kind: "build", subIssue: 10 } }))).toContain(
      "- 🔨 **Building:** #10 Slice ranges",
    );
  });

  it("is byte for byte the same when rendered again from the same state", () => {
    const state = inputs({ built: [10, 11], running: { kind: "review" } });

    expect(renderProgressList(state)).toBe(renderProgressList(state));
    expect(renderProgressList(state)).toBe(
      renderProgressList(inputs({ built: [10, 11], running: { kind: "review" } })),
    );
  });

  it("keeps a title on its line", () => {
    const subIssues: ProgressSubIssue[] = [{ number: 10, title: "Two\nlines  and\tspaces ", state: "OPEN" }];

    expect(renderProgressList(inputs({ subIssues }))).toContain("- ⬜ **Not started:** #10 Two lines and spaces\n");
  });

  it("holds the final review's mark, and the final review's state, once it is requested", () => {
    const final = (verdict: ProgressInputs["verdict"], running: ProgressInputs["running"]): string =>
      renderProgressList(inputs({ built: [10, 11, 12], verdict, running, finalReview: "requested" }));

    expect(final("approval", { kind: "review" })).toContain(`\n\n**Final review:** 🔍 in review\n${FINAL_REVIEW_MARK}\n${PROGRESS_END}`);
    expect(final("approval", null)).toContain("**Final review:** ✅ approved\n");
    expect(final("other", null)).toContain("**Final review:** ⏸️ parked\n");
    expect(renderProgressList(inputs({ built: [10, 11, 12], verdict: "approval" }))).not.toContain(FINAL_REVIEW_MARK);
  });

  /**
   * The finishing run runs no toolchain, so it writes these lines in front of
   * the end marker of the list the last slice's round left. That has to be
   * the render, or the list it leaves is one nothing rendered.
   */
  it("is, for the final review requested, the approved list with the finishing run's lines before its end", () => {
    const approved = renderProgressList(inputs({ built: [10, 11, 12], verdict: "approval" }));
    const requested = renderProgressList(
      inputs({ built: [10, 11, 12], verdict: "approval", running: { kind: "review" }, finalReview: "requested" }),
    );

    expect(approved.replace(PROGRESS_END, `${FINAL_REVIEW_REQUESTED_LINES}${PROGRESS_END}`)).toBe(requested);
  });
});

describe("the list for each way a round ends", () => {
  it("renders approved, parked and still running from one reading of the branch", () => {
    const branch = { subIssues: SUBS, ranges: sliceRanges(built(10, 11), SUBS), finalReview: "not requested" as const };
    const lists = progressAtRoundEnd(branch);

    expect(lists.approved).toContain("- ✅ **Approved:** #11");
    expect(lists.parked).toContain("- ⏸️ **Parked:** #11");
    expect(lists.running).toContain("- 🔍 **In review:** #11");
  });

  it("renders the final review's ending on the final review", () => {
    const lists = progressAtRoundEnd({ subIssues: SUBS, ranges: sliceRanges(built(10, 11, 12), SUBS), finalReview: "requested" });

    expect(lists.approved).toContain("**Final review:** ✅ approved");
    expect(lists.parked).toContain("**Final review:** ⏸️ parked");
    expect(lists.running).toContain("**Final review:** 🔍 in review");
    for (const list of Object.values(lists)) expect(list).toContain(FINAL_REVIEW_MARK);
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
