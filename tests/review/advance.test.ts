import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advance } from "../../review/advance.js";
import { MINT_FAILED } from "../../review/conclude.js";
import type { ParkHandOver, ProgressHandOver } from "../../review/hand-over.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { renderParkComment } from "../../shared/prd-round.js";
import { progressAtRoundEnd, spliceProgressList, spliceStatus, statusBlock } from "../../shared/progress-list.js";
import { PROGRESS_END, PROGRESS_START, STATUS_END, STATUS_START } from "../../shared/record.js";
import { VERDICTS } from "../../shared/review-output.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `review:advance` (#423), called the way the CLI calls it: its declared
 * inputs, a directory holding what the review runner handed over, a fake
 * GitHub reader, and the engine's writers over a fake GitHub, sharing one log.
 * What is asserted is what it did to the record: the PRD PR's body, the
 * parent's labels, the comments, in what order and with which token.
 *
 * The scenarios are the retired steps' (`Re-render the progress list`,
 * `Advance the PRD chain` and its composite action, `Say the PRD chain did
 * not advance` and `Park the PRD chain`), from `tests/pr-body-steps.test.ts`,
 * `tests/loop-token-step.test.ts` and `tests/workflows.test.ts`, carried over
 * by behaviour.
 */

const PR = 201;
const PARENT = 14;
const BRANCH = `agent/prd-${PARENT}-a-prd`;
const SERVER = "https://github.com";
const REPO = "acme/widgets";
const PR_URL = `${SERVER}/${REPO}/pull/${PR}`;
const RUN_URL = `${SERVER}/${REPO}/actions/runs/42`;
const REVIEW_URL = `${PR_URL}#pullrequestreview-9`;

let dir: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let logged: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-"));
  github = fakeGitHub([{ number: PR, body: "Mine." }]);
  github.issueLabels.set(PARENT, []);
  made = undefined;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Inputs = Parameters<typeof advance>[0];

/** A slice round whose review and posting both finished, approving. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(dir, "out"),
  GH_REPO: REPO,
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "app",
  PR_NUMBER: String(PR),
  BRANCH,
  REVIEW_RESULT: "success",
  POSTING_RESULT: "success",
  MOVED: "false",
  REVIEW_URL,
  VERDICT: "approval recommended",
  FIX_ROUND: "false",
  ROUND: "slice",
  MINT_OUTCOME: "success",
  PARK_DIR: dir,
  GITHUB_SERVER_URL: SERVER,
  GITHUB_REPOSITORY: REPO,
  GITHUB_RUN_ID: "42",
  ...over,
});

const CARRIED = [{ title: "The guard runs after the return", anchor: "src/a.ts:12", url: `${PR_URL}#discussion_r1` }];
const ROUND = { kind: "slice", slice: { subIssue: 16, k: 2, n: 2 } } as const;

/** What the runner writes before the agent runs. */
const BEFORE: ParkHandOver = { round: ROUND, carried: CARRIED };

/** What it writes once the review ruled: changes recommended, the budget spent. */
const RULED: ParkHandOver = {
  ...BEFORE,
  review: {
    verdict: "changes recommended",
    reason: "budget spent",
    stillOpen: CARRIED,
    raised: [{ title: "A test asserts the old behaviour", anchor: "tests/a.test.ts:40" }],
  },
};

const PROGRESS: ProgressHandOver = {
  subIssues: [
    { number: 15, state: "OPEN" },
    { number: 16, state: "OPEN" },
  ],
  ranges: {
    slices: [
      { subIssue: 15, range: { base: "1".repeat(40), commits: ["2".repeat(40)] } },
      { subIssue: 16, range: { base: "2".repeat(40), commits: ["3".repeat(40)] } },
    ],
    next: null,
    current: { subIssue: 16, k: 2, n: 2 },
  },
  finalReview: "not requested",
  rounds: {
    slices: [
      { subIssue: 15, reviews: 1, fixes: 0, latestReview: `${PR_URL}#pullrequestreview-1` },
      { subIssue: 16, reviews: 2, fixes: 1 },
    ],
    final: { reviews: 0, fixes: 0 },
    all: { reviews: 3, fixes: 1 },
  },
  open: 2,
};

const handOver = (park: ParkHandOver | undefined = RULED, progress: ProgressHandOver | undefined = PROGRESS): void => {
  if (park !== undefined) fs.writeFileSync(path.join(dir, "park.json"), JSON.stringify(park));
  if (progress !== undefined) fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify(progress));
};

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["review:advance"]["outputs"]> = {
    writers: (limits) => {
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: fakeReader(github).reader,
    outputs: { writeJson: () => {}, writeText: () => {}, appendLine: () => {} },
  };
  try {
    await advance(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

/** Every write attempted, as `<token> <type> <target>[ <label>]`. */
const writes = (): string[] =>
  (made?.writes ?? []).map((w) => {
    const [target, second] = w.args;
    return `${w.token} ${w.type} #${String(target)}${typeof second === "string" && w.type.endsWith("Label") ? ` ${second}` : ""}`;
  });
const body = (): string => github.pullRequests.get(PR)?.body ?? "";
const comments = () => github.comments.map(({ token, issue, body }) => ({ token, issue, body }));

/** The table and status line for `ending`, as the review's data renders them. */
const rendered = (ending: "approved" | "parked" | "running", review = REVIEW_URL) =>
  progressAtRoundEnd(
    { subIssues: PROGRESS.subIssues, ranges: PROGRESS.ranges, finalReview: PROGRESS.finalReview },
    {
      rounds: {
        slices: { 15: { reviews: 1, fixes: 0, latestReview: `${PR_URL}#pullrequestreview-1` }, 16: { reviews: 2, fixes: 1 } },
        final: { reviews: 0, fixes: 0 },
        all: { reviews: 3, fixes: 1 },
      },
      review,
      open: 2,
      prUrl: PR_URL,
    },
  )[ending];

describe("review:advance moves the chain on after a slice round's approval", () => {
  /**
   * The table first, with the workflow token, then `agent:implement` back on
   * the parent with the loop's: removed first, since an add on a label still
   * there fires nothing (#236).
   */
  it("writes the table, then re-adds agent:implement to the parent with the loop's token", async () => {
    handOver();

    await run();

    expect(writes()).toEqual([
      `workflow editPullRequest #${PR}`,
      `loop removeLabel #${PARENT} agent:implement`,
      `loop addLabel #${PARENT} agent:implement`,
    ]);
    expect(github.issueLabels.get(PARENT)).toEqual(["agent:implement"]);
    expect(body()).toBe(`Mine.\n\n${rendered("approved").progress}`);
    expect(body()).toContain("| 2 · #16 | ✅ Approved | [3](https://github.com/acme/widgets/pull/201#pullrequestreview-9) | 1 |");
    expect(comments()).toEqual([]);
    expect(logged).toContain(`Re-added agent:implement to #${PARENT}: the PRD chain advances past the slice round approved on PRD PR #${PR}.`);
  });

  /** Never from the final review: `review:conclude` marked it ready, and it is the maintainer's to merge. */
  it("writes only the table after the final review's approval", async () => {
    handOver();

    await run(INPUTS({ ROUND: "final" }));

    expect(writes()).toEqual([`workflow editPullRequest #${PR}`]);
    expect(github.issueLabels.get(PARENT)).toEqual([]);
  });

  /** A verdict that was never posted approves nothing: the chain parks. */
  it("parks rather than advancing where the posting job failed", async () => {
    handOver();

    await run(INPUTS({ POSTING_RESULT: "failure" }));

    expect(github.issueLabels.get(PARENT)).toEqual([]);
    expect(comments().map((c) => c.issue)).toEqual([PARENT]);
  });

  /**
   * Without the App or the PAT, a label added would start nothing, so none is
   * added, and the PRD PR says which re-label advances the chain by hand.
   */
  it("adds nothing without the App or the PAT, and says on the PRD PR what to re-add", async () => {
    handOver();

    await run(INPUTS({ LOOP_TOKEN_SOURCE: "workflow" }));

    expect(writes()).toEqual([`workflow editPullRequest #${PR}`, `workflow comment #${PR}`]);
    expect(comments()).toEqual([
      {
        token: "workflow",
        issue: PR,
        body: `This slice's round ended on an approval, but the PRD chain will not advance on its own: neither the loop's App nor \`AGENT_PAT\` is set, and a label added with \`GITHUB_TOKEN\` starts nothing. Re-add \`agent:implement\` to #${PARENT} by hand to build the next slice.`,
      },
    ]);
    expect(logged.some((line) => line.startsWith("::warning::Neither the loop's App nor AGENT_PAT is set"))).toBe(true);
  });

  /**
   * A mint that fails (#330 review) cannot cost the table, which is the
   * workflow token's; the PRD PR is told the chain did not advance and why,
   * and the command fails, since a chain that did not advance after an
   * approval is a stall with no other symptom.
   */
  it("says on the PRD PR that the chain did not advance where the mint failed, and fails", async () => {
    handOver();

    await expect(run(INPUTS({ MINT_OUTCOME: "failure", LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "" }))).rejects.toThrow(MINT_FAILED);

    expect(writes()).toEqual([`workflow editPullRequest #${PR}`, `workflow comment #${PR}`]);
    expect(comments()[0]?.body).toBe(
      `This slice's round ended on an approval, but the PRD chain did not advance: ${MINT_FAILED} [Workflow run](${RUN_URL})\n\nOnce that is fixed, re-add \`agent:implement\` to #${PARENT} by hand to build the next slice.`,
    );
    expect(body()).toContain(PROGRESS_START);
  });

  /** A failed add is a stall, and the command fails on it. */
  it("fails where the label cannot be added", async () => {
    handOver();
    github.fails = (write) => write.type === "addLabel";

    await expect(run()).rejects.toThrow();
    expect(made?.entries.at(-1)).toMatchObject({ type: "addLabel", outcome: "failed" });
  });

  it("fails, naming the head, where the head names no parent", async () => {
    handOver();

    await expect(run(INPUTS({ BRANCH: "agent/prd-x" }))).rejects.toThrow(
      "PRD PR #201's head `agent/prd-x` is not `agent/prd-<parent>-…`, so its PRD cannot be told.",
    );
  });
});

describe("review:advance does nothing more where the round goes on", () => {
  /** A fix round started: the round has not ended, and the fix run's re-review comes back here. */
  it("writes the table as fixing, and nothing else, where a fix round started", async () => {
    handOver();

    await run(INPUTS({ VERDICT: "changes recommended", FIX_ROUND: "true" }));

    expect(writes()).toEqual([`workflow editPullRequest #${PR}`]);
    expect(body()).toBe(`Mine.\n\n${rendered("running").progress}`);
    expect(body()).toContain("🔧 Fixing · 2 open");
  });

  /** The head moved while the review ran: the review of the new head decides, and writes its own table. */
  it("writes nothing at all where the head moved", async () => {
    handOver();

    await run(INPUTS({ MOVED: "true", VERDICT: "changes recommended" }));

    expect(made?.writes ?? []).toEqual([]);
    expect(body()).toBe("Mine.");
  });
});

describe("review:advance parks the chain on every other ending", () => {
  /**
   * A round that ended without approval or a fix round: the comment names the
   * round, the reason the review gave, the verdict's own next step, and every
   * finding still open, the ones this round raised linking the posted review.
   */
  it("posts the park comment on the parent with the loop's token, the raised findings linking the review", async () => {
    handOver();

    await run(INPUTS({ VERDICT: "changes recommended" }));

    expect(writes()).toEqual([`workflow editPullRequest #${PR}`, `loop comment #${PARENT}`]);
    expect(comments()).toEqual([
      {
        token: "loop",
        issue: PARENT,
        body: renderParkComment({
          round: ROUND,
          prNumber: String(PR),
          reason: "budget spent",
          detail: VERDICTS["changes recommended"].nextStep,
          findings: [...CARRIED, { title: "A test asserts the old behaviour", anchor: "tests/a.test.ts:40", url: REVIEW_URL }],
        }),
      },
    ]);
    expect(comments()[0]?.body).toContain("**The PRD chain parked** at slice 2 of 2, #16, on PRD PR #201.");
    expect(comments()[0]?.body).toContain(`- [A test asserts the old behaviour](${REVIEW_URL}) (\`tests/a.test.ts:40\`)`);
    expect(body()).toBe(`Mine.\n\n${rendered("parked").progress}`);
    expect(logged).toContain(`Posted the park comment on #${PARENT}.`);
  });

  /** *Needs a closer look* takes the line of its cause. */
  it("names a closer look's cause by its own line", async () => {
    handOver({ ...BEFORE, review: { verdict: "needs a closer look", cause: "unknown", reason: "needs a closer look", stillOpen: [], raised: [] } });

    await run(INPUTS({ VERDICT: "needs a closer look" }));

    expect(comments()[0]?.body).toContain("**Why:** the review needs a closer look. CI hadn't finished, or couldn't be read");
  });

  /**
   * A posting job that failed after the verdict went up parks on that verdict,
   * not on "no verdict": the posted review's URL is what says it went up.
   */
  it("names the posted verdict where the posting job failed after it", async () => {
    handOver();

    await run(INPUTS({ POSTING_RESULT: "failure", VERDICT: "changes recommended", FIX_ROUND: "true" }));

    const text = comments()[0]?.body ?? "";
    expect(text).toContain(`[The verdict](${REVIEW_URL}) was *🟡 Changes recommended*.`);
    expect(text).toContain("the review finished and its verdict was posted, but a later step of posting it failed");
    expect(text).toContain(`[Workflow run](${RUN_URL})`);
    expect(text).toContain(`- [A test asserts the old behaviour](${REVIEW_URL})`);
    expect(body()).toBe(`Mine.\n\n${rendered("parked").progress}`);
  });

  /** A review that did not finish lists what was open before it, and links the run. */
  it("parks a review that did not finish on what was open before it", async () => {
    handOver(BEFORE);

    await run(INPUTS({ REVIEW_RESULT: "failure", POSTING_RESULT: "success", REVIEW_URL: "", VERDICT: "" }));

    expect(comments()[0]?.body).toBe(
      renderParkComment({ round: ROUND, prNumber: String(PR), reason: "failed", findings: CARRIED, runUrl: RUN_URL }),
    );
    // No review was posted, so the table links the pull request instead.
    expect(body()).toBe(`Mine.\n\n${rendered("parked", PR_URL).progress}`);
  });

  /** A review that stopped before handing anything over: only where it ran is known. */
  it("says only that the review did not finish where nothing was handed over", async () => {
    await run(INPUTS({ REVIEW_RESULT: "failure", REVIEW_URL: "", VERDICT: "" }));

    expect(comments()).toEqual([
      {
        token: "loop",
        issue: PARENT,
        body: `**The PRD chain parked** on PRD PR #${PR}: its review didn't finish, so there is no verdict. [Workflow run](${RUN_URL})\n\nTo move on, add \`agent:review\` to PRD PR #${PR} to run the review again. The chain moves on once a review of the PRD PR's latest commit recommends approval.`,
      },
    ]);
    expect(logged).toContain(`::warning::The review handed over no progress list, so PRD PR #${PR}'s is left as it stands.`);
  });

  /** A round that ended, whose hand-over names no reason, is said the same way: the file it needed is not there. */
  it("falls back to the bare comment where the round ended and the hand-over gives no reason", async () => {
    handOver(BEFORE);

    await run(INPUTS({ VERDICT: "changes recommended" }));

    expect(comments()[0]?.body).toMatch(/^\*\*The PRD chain parked\*\* on PRD PR #201: its review didn't finish/);
  });

  /** On the PRD PR without the App or the PAT, saying where it was meant for, and the job stays green. */
  it("parks on the PRD PR without the App or the PAT", async () => {
    handOver();

    await run(INPUTS({ VERDICT: "changes recommended", LOOP_TOKEN_SOURCE: "workflow" }));

    expect(writes()).toEqual([`workflow editPullRequest #${PR}`, `workflow comment #${PR}`]);
    expect(comments()[0]?.body).toMatch(/\n\n_This was meant for #14, but neither the loop's App nor `AGENT_PAT` is set\._$/);
  });

  /** Where the mint failed, on the PRD PR with its reason, and the command fails (#330 review). */
  it("parks on the PRD PR with the mint's reason where the mint failed, and fails", async () => {
    handOver();

    await expect(run(INPUTS({ VERDICT: "changes recommended", MINT_OUTCOME: "failure", LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "" }))).rejects.toThrow(
      `The park comment went on PRD PR #${PR} rather than on #${PARENT}`,
    );

    expect(comments()[0]?.issue).toBe(PR);
    expect(comments()[0]?.body).toMatch(new RegExp(`\\n\\n_This was meant for #14, but it could not be posted there: ${MINT_FAILED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_$`));
  });

  /** A chain that parked without saying so is the silence this exists to end: a failed post fails the command. */
  it("fails where the park comment cannot be posted", async () => {
    handOver();
    github.fails = (write) => write.type === "comment";

    await expect(run(INPUTS({ VERDICT: "changes recommended" }))).rejects.toThrow();
  });

  it("fails, naming the head, where the head names no parent", async () => {
    handOver();

    await expect(run(INPUTS({ VERDICT: "changes recommended", BRANCH: "agent/prd-x" }))).rejects.toThrow(
      "and the park comment was not posted.",
    );
    expect(comments()).toEqual([]);
  });
});

describe("review:advance writes the progress table into the live body", () => {
  const list = rendered("parked").progress;
  const stale = rendered("approved").progress;
  const bodies: readonly [string, string][] = [
    ["a body with a list", `Closes #14\n\n${stale}\n\nMine.\r\n`],
    ["a body with none", "Closes #14\n\nMine."],
    ["a body ending in a newline", "Mine.\n"],
    ["no body", ""],
    ["half a list", `Mine.\n${PROGRESS_START}\nrest`],
    ["two lists", `${stale}\n${stale}`],
  ];

  /** Every byte outside the markers kept, a list appended to a body with none, and half a list, or two, not written. */
  it.each(bodies)("over %s keeps spliceProgressList's rule", async (_case, live) => {
    handOver();
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = live;

    await run(INPUTS({ VERDICT: "changes recommended" }));

    const expected = spliceProgressList(live, list);
    if (expected === undefined) {
      expect(body()).toBe(live);
      expect(logged.some((line) => line.includes("carries half a progress list, or two, so it was not written"))).toBe(true);
    } else {
      expect(body()).toBe(spliceStatus(expected, rendered("parked").status) ?? expected);
    }
    // The park comment follows either way.
    expect(comments().map((c) => c.issue)).toEqual([PARENT]);
  });

  /** The status line is replaced between its markers, left where there is none, and left alone where there is half of one. */
  it.each([
    ["a body with a status line", `> ${statusBlock("old")}\n${stale}`, true],
    ["a body with none", `> no line\n${stale}`, false],
    ["half a line", `> ${STATUS_START}old\n${stale}`, false],
    ["two lines", `> ${statusBlock("a")}${statusBlock("b")}\n${stale}`, false],
  ])("over %s keeps spliceStatus's rule, while the table is written", async (_case, live, replaced) => {
    handOver();
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = live;

    await run(INPUTS({ VERDICT: "changes recommended" }));

    expect(body()).toContain(list);
    expect(body().includes(rendered("parked").status)).toBe(replaced);
    if (replaced) expect(body()).toContain(`${STATUS_START}\n> **⏸️ Slice 2 of 2 parked** · #16 · 2 findings open. [See it](${REVIEW_URL})\n> ${STATUS_END}`);
  });

  /** The table is a view of the chain: a write that fails is a warning, and the advance after it still happens. */
  it("goes on with a warning where the table cannot be written", async () => {
    handOver();
    github.fails = (write) => write.type === "editPullRequest";

    await run();

    expect(logged.some((line) => line.startsWith(`::warning::Could not write PRD PR #${PR}'s progress list`))).toBe(true);
    expect(github.issueLabels.get(PARENT)).toEqual(["agent:implement"]);
  });

  it("writes nothing where the table is already as rendered", async () => {
    handOver();
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = `Mine.\n\n${rendered("approved").progress}`;

    await run();

    expect(made?.entries[0]).toMatchObject({ type: "editPullRequest", outcome: "unchanged" });
    expect(PROGRESS_END).toBe("<!-- /agent:progress -->");
  });
});

describe("review:advance reads the hand-over before it writes", () => {
  /** The agent's runner can write these files: a marker in a title is cleaned out before it reaches the record. */
  it("cleans free text, so a forged marker never reaches the comment", async () => {
    handOver({ ...BEFORE, carried: [{ title: "Real <!-- agent:progress --> title" }] });

    await run(INPUTS({ REVIEW_RESULT: "failure", REVIEW_URL: "" }));

    expect(comments()[0]?.body).toContain("- Real  title");
    expect(comments()[0]?.body).not.toContain("<!--");
  });

  it.each([
    ["a field it does not declare", { ...BEFORE, commentText: "posted as is" }, "park.json has `commentText`"],
    ["a reason it does not know", { ...RULED, review: { ...RULED.review, reason: "failed" } }, "park.json `review.reason`"],
    ["a link that is not one", { ...BEFORE, carried: [{ title: "t", url: "javascript:alert(1)" }] }, "park.json `carried[0].url`"],
    ["a cause on a verdict that has none", { ...RULED, review: { ...RULED.review, cause: "red" } }, "names a cause on changes recommended"],
  ])("fails before any write on %s", async (_case, park, message) => {
    handOver(park as unknown as ParkHandOver);

    await expect(run()).rejects.toThrow(message);
    expect(made).toBeUndefined();
    expect(body()).toBe("Mine.");
  });

  it("fails before any write on a slice range with no commits", async () => {
    handOver(RULED, { ...PROGRESS, ranges: { ...PROGRESS.ranges, slices: [{ subIssue: 15, range: { base: null, commits: [] } }] } });

    await expect(run()).rejects.toThrow("progress.json `ranges` has a slice range with no commits");
    expect(made).toBeUndefined();
  });
});
