import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubError } from "../../engine/github.js";
import type { CommitStatus, GitHubReader, SubIssue } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import { gate } from "../../implement-prd/gate.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import { COMMANDS } from "../../shared/contract.js";
import { renderPrdStatus, renderProgressList, spliceProgressList, statusBlock, type ProgressInputs } from "../../shared/progress-list.js";
import { renderCriteriaGroup, VERDICTS, type CriterionResult } from "../../shared/review-output.js";
import {
  BLOCKED_LABEL,
  FINAL_REVIEW_MARK,
  IMPLEMENT_LABEL,
  PRD_STARTED_MARK,
  PROGRESS_START,
  sliceApprovedMark,
} from "../../shared/record.js";
import { sliceRanges } from "../../shared/slice-ranges.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `implement-prd:gate` (#498), called the way the CLI calls it: its declared
 * inputs, a fake GitHub reader, and the engine's writers over a fake GitHub,
 * sharing one log. What is asserted is what it did to the record, the writes
 * it attempted in order, and what it handed on in `gate.json` and
 * `prd-issue.json`.
 *
 * The scenarios are the retired shell *Preflight*'s and *Transition
 * labels*', carried over by behaviour from
 * `tests/implement-prd-preflight.test.ts`, each refusal with today's sentence
 * word for word. Every row of the decision table is
 * `tests/implement-prd/chain.test.ts`'s; here is what the gate reads to reach
 * it and what it writes once there.
 */

const PARENT = 171;
const TITLE = "Slices on the PRD branch";
const PRD_BRANCH = "agent/prd-171-slices-on-the-prd-branch";
const TIP = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "e".repeat(40);
const RUN_URL = "https://github.com/acme/widgets/actions/runs/4242";
const REVIEW_URL = "https://github.com/acme/widgets/pull/201#pullrequestreview-123";

let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let reader: GitHubReader;
let reads: ReturnType<typeof fakeReader>["reads"];
let decided: unknown;
let snapshot: unknown;
/** The progress list and status line the building row replaced, as the gate kept them. */
let kept: Record<string, string>;
let logged: string[];

/** The PRD's sub-issues, #172 on, in `states`, each with no links. */
const setSubIssues = (...states: readonly ("OPEN" | "CLOSED")[]): SubIssue[] => {
  const children = states.map((state, i) => ({ number: 172 + i, title: `Slice ${i + 1}`, state }));
  github.issues.set(PARENT, { ...github.issues.get(PARENT)!, subIssues: children.length, children });
  for (const child of children) github.issues.set(child.number, { subIssues: 0, blockedBy: [] });
  return children;
};

/** The PRD branch on the remote, with the slices of `subs` built on it over `main`. */
const onBranch = (subs: readonly number[], extra: readonly string[] = []): void => {
  github.branches.set(PRD_BRANCH, TIP);
  github.ranges.set(`main...${TIP}`, [
    ...subs.flatMap((sub) => [`feat: slice ${sub} (#${sub})\n\nWhy.\n\nAgent-Slice: #${sub}`, `fix: address review findings on slice ${sub}`]),
    ...extra,
  ]);
};

/** The PRD PR, #201, a draft from the PRD branch into `main`. */
const prdPr = (over: { draft?: boolean; labels?: string[]; body?: string; headRef?: string } = {}): void => {
  github.pullRequests.set(201, {
    number: 201,
    nodeId: "PR_201",
    state: "open",
    draft: over.draft ?? true,
    headSha: HEAD,
    title: "",
    body: over.body ?? "Closes #171",
    labels: over.labels ?? [],
    headRef: over.headRef ?? PRD_BRANCH,
    baseRef: "main",
  });
};

/** An open pull request from `head` into `base`. */
const pull = (number: number, head: string, base: string, state: "open" | "closed" = "open"): void => {
  github.pullRequests.set(number, {
    number,
    nodeId: `PR_${number}`,
    state,
    draft: false,
    headSha: "d".repeat(40),
    title: "",
    body: "",
    labels: [],
    headRef: head,
    baseRef: base,
  });
};

/** The `agent-review` verdict on the PRD PR's head, with a CI status beside it. */
const verdictOnHead = (state: string, description: string, targetUrl: string | null = REVIEW_URL): void => {
  const statuses: CommitStatus[] = [
    { context: "ci/build", state: "success", targetUrl: null, description: "Build passed", creator: "ci" },
    { context: "agent-review", state, targetUrl, description, creator: "github-actions[bot]" },
  ];
  github.statuses.set(HEAD, statuses);
};
const approve = (): void => verdictOnHead("success", VERDICTS["approval recommended"].description);

beforeEach(() => {
  github = fakeGitHub([]);
  github.issues.set(PARENT, { subIssues: 0, blockedBy: [] });
  github.issueLabels.set(PARENT, [IMPLEMENT_LABEL]);
  setSubIssues("OPEN", "OPEN", "OPEN");
  made = undefined;
  asked = undefined;
  ({ reader, reads } = fakeReader(github));
  decided = undefined;
  snapshot = undefined;
  kept = {};
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Inputs = Parameters<typeof gate>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: "acme/widgets",
  GH_TOKEN: "workflow-token",
  ISSUE_NUMBER: String(PARENT),
  ISSUE_TITLE: TITLE,
  ISSUE_STATE: "open",
  BASE_REF: "main",
  RUN_URL,
  GITHUB_SERVER_URL: "https://github.com",
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS(), github_: GitHubReader = reader): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["implement-prd:gate"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: github_,
    outputs: {
      writeJson: (name, value) => {
        if (name === "gate.json") decided = structuredClone(value);
        else if (name === "prd-issue.json") snapshot = structuredClone(value);
        else throw new Error(`wrote ${name}`);
      },
      writeText: (name, value) => {
        if (name !== "progress_unbuilt.md" && name !== "status_unbuilt.md") throw new Error(`wrote ${name}`);
        kept[name] = value;
      },
      writeBytes: () => {},
      appendLine: () => {},
    },
  };
  try {
    await gate(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

/** Each write, as `<token> <type> #<issue> <label or first line>`. */
const writes = (): string[] =>
  (made?.writes ?? []).map((w) => {
    const [first, second] = w.args;
    return `${w.token} ${w.type} #${String(first)} ${typeof second === "string" ? second.split("\n")[0] : ""}`.trim();
  });

const labels = (): readonly string[] => github.issueLabels.get(PARENT) ?? [];
const comments = (): [number, string][] => github.comments.map((c) => [c.issue, c.body]);
const refusal = (sentence: string): string => `**\`agent:implement\` didn't run:** ${sentence}`;

/** A refusal's writes, in the loop's order: the comment, the label off, and `agent:blocked` where it is durable. */
const refused = (sentence: string, blocked: boolean): void => {
  expect(writes()).toEqual([
    `workflow comment #${PARENT} ${refusal(sentence).split("\n")[0]}`,
    `workflow removeLabel #${PARENT} ${IMPLEMENT_LABEL}`,
    ...(blocked ? [`workflow addLabel #${PARENT} ${BLOCKED_LABEL}`] : []),
  ]);
  expect(comments()).toEqual([[PARENT, refusal(sentence)]]);
  expect(labels()).toEqual(blocked ? [BLOCKED_LABEL] : []);
  expect(decided).toEqual({ proceed: "false" });
};

/** A reader whose `method` throws `error`, otherwise the fake's. */
const throwing = (method: keyof GitHubReader, error: unknown = new GitHubError("GET x: 502 Bad Gateway", 502)): GitHubReader => ({
  ...reader,
  [method]: async () => {
    throw error;
  },
});

/** A run that stopped before deciding: no write, the label as it was, nothing decided. */
const stoppedUndecided = (): void => {
  expect(made?.writes).toEqual([]);
  expect(labels()).toEqual([IMPLEMENT_LABEL]);
  expect(decided).toEqual({});
};

describe("implement-prd:gate leaves an issue with no sub-issues to implement", () => {
  it("defers, writing nothing to the record, whatever else is true of it", async () => {
    github.issues.set(PARENT, { subIssues: 0, blockedBy: [], parent: 3 });

    await run(INPUTS({ ISSUE_STATE: "closed" }));

    expect(made?.writes).toEqual([]);
    expect(labels()).toEqual([IMPLEMENT_LABEL]);
    expect(decided).toEqual({ proceed: "false" });
    expect(snapshot).toBeUndefined();
    expect(reads.map((r) => r.method)).toEqual(["issueShape"]);
    expect(logged).toContain(`#${PARENT} has no sub-issues, so agent-implement owns this label event.`);
  });

  it("asks for the limits it writes within", async () => {
    await run();

    expect(asked).toEqual({ comment: 4, removeLabel: 2, addLabel: 2, editPullRequest: 1 });
  });
});

describe("implement-prd:gate refuses a PRD it should not build", () => {
  it("refuses a closed parent, unblocked, before anything else is read", async () => {
    await run(INPUTS({ ISSUE_STATE: "closed" }));

    refused("This issue is closed. Reopen it, then add `agent:implement` again.", false);
    expect(reads.map((r) => r.method)).toEqual(["issueShape"]);
  });

  it("refuses a planning issue, blocked", async () => {
    github.issueLabels.set(PARENT, [IMPLEMENT_LABEL, "wayfinder:map"]);

    await run();

    expect(github.comments[0]?.body).toBe(
      refusal("This is a planning issue (`wayfinder:*`), not buildable work. Add `agent:implement` to the issues it produces instead."),
    );
    expect(labels()).toEqual(["wayfinder:map", BLOCKED_LABEL]);
    expect(decided).toEqual({ proceed: "false" });
  });

  it("refuses a nested PRD, blocked, naming its parent", async () => {
    github.issues.set(PARENT, { ...github.issues.get(PARENT)!, parent: 9 });

    await run();

    refused("This PRD is itself a sub-issue of #9. Remove it from #9, or move its sub-issues up to #9, then label the top-level issue.", true);
  });

  it("refuses more than 100 sub-issues, blocked, counting every one", async () => {
    setSubIssues(...Array.from({ length: 101 }, () => "OPEN" as const));

    await run();

    refused("This PRD has 101 sub-issues, and the loop handles at most 100. Split it into smaller PRDs.", true);
  });

  it("takes the label off and blocks even where the comment fails", async () => {
    github.issues.set(PARENT, { ...github.issues.get(PARENT)!, parent: 9 });
    github.fails = (write) => write.type === "comment";

    await run();

    expect(comments()).toEqual([]);
    expect(labels()).toEqual([BLOCKED_LABEL]);
    expect(logged).toContain(`::warning::Could not post the refusal comment on #${PARENT}.`);
    expect(decided).toEqual({ proceed: "false" });
  });
});

describe("implement-prd:gate finds the PRD branch and the PRD PR", () => {
  /**
   * The first run of a chain: no PRD branch yet, so nothing is built. It
   * builds the first sub-issue on a branch named from the parent's title,
   * and does not look for slice PRs or a PRD PR from a branch that is not there.
   */
  it("builds the first sub-issue on a new PRD branch when nothing is built", async () => {
    pull(190, "agent/slice-171-173-slice-2", PRD_BRANCH);

    await run();

    expect(decided).toEqual({
      proceed: "true",
      decision: "build",
      prdBranch: PRD_BRANCH,
      prdBranchExists: false,
      prdTip: "",
      landed: 0,
      total: 3,
      slice: { number: 172, position: 1, title: "Slice 1" },
    });
    expect(reads.map((r) => r.method)).toEqual([
      "issueShape",
      "subIssues",
      "branchesStarting",
      "blockedBy",
      "blockedBy",
      "blockedBy",
      "openBlockers",
      "issueComments",
    ]);
    expect(reads.find((r) => r.method === "branchesStarting")?.args).toEqual(["agent/prd-171-"]);
  });

  /** What `Open or reuse the PRD PR` writes its `Closes` lines from, in the shape the shell query gave it. */
  it("leaves its snapshot of the PRD for the publish job", async () => {
    setSubIssues("CLOSED", "OPEN");

    await run();

    expect(snapshot).toEqual({
      parent: null,
      labels: { nodes: [{ name: IMPLEMENT_LABEL }] },
      subIssues: {
        totalCount: 2,
        nodes: [
          { number: 172, title: "Slice 1", state: "CLOSED" },
          { number: 173, title: "Slice 2", state: "OPEN" },
        ],
      },
    });
  });

  it("accepts a PRD with one sub-issue", async () => {
    setSubIssues("OPEN");

    await run();

    expect(decided).toMatchObject({ proceed: "true", decision: "build", slice: { number: 172, position: 1 }, total: 1 });
  });

  /**
   * Found by the half of its name a human cannot edit, so a retitled parent
   * still finds it, and a PRD whose number starts this one's is not it.
   */
  it("finds the PRD branch by the parent's number, whatever its slug now is", async () => {
    github.branches.set("agent/prd-1710-other", "f".repeat(40));
    github.branches.set("agent/prd-171-an-old-title", TIP);
    github.ranges.set(`main...${TIP}`, ["feat: one\n\nAgent-Slice: #172"]);
    prdPr({ headRef: "agent/prd-171-an-old-title" });
    pull(203, "agent/prd-1710-other", "main");
    approve();

    await run();

    expect(decided).toMatchObject({
      prdBranch: "agent/prd-171-an-old-title",
      prdBranchExists: true,
      prdTip: TIP,
      prdPr: 201,
      slice: { number: 173 },
    });
  });

  it("stops on two branches for one PRD, naming both", async () => {
    github.branches.set(PRD_BRANCH, TIP);
    github.branches.set("agent/prd-171-a-fork", "f".repeat(40));

    await expect(run()).rejects.toThrow(
      `More than one branch is named for this PRD: \`${PRD_BRANCH}\`, \`agent/prd-171-a-fork\`. It can't tell which one holds the slices already built. Delete or rename all but one.`,
    );
    stoppedUndecided();
  });

  it("stops on two open PRs from the PRD branch, naming both", async () => {
    onBranch([172]);
    prdPr();
    pull(205, PRD_BRANCH, "release");

    await expect(run()).rejects.toThrow(
      `#201, #205 are all open from this PRD's branch \`${PRD_BRANCH}\`, so it can't tell which one is the PRD PR. Close all but one.`,
    );
    stoppedUndecided();
  });

  /** "Could not look" is never "nothing there": each read the shell blocked on stops the run with a sentence. */
  it.each([
    ["the sub-issues", "subIssues", "Couldn't read this PRD's sub-issues, so nothing was built."],
    ["the branches", "branchesStarting", "Couldn't look for this PRD's branch, so nothing was built."],
    ["the slice PRs", "openPullRequests", `Couldn't look for slice PRs still open into \`${PRD_BRANCH}\`, so nothing was built.`],
    ["the built slices", "commitMessages", `Couldn't read which sub-issues are already built on \`${PRD_BRANCH}\`, so nothing was built.`],
    ["the PRD PR", "pullRequest", `Couldn't look for the PRD PR from \`${PRD_BRANCH}\`, so nothing was built.`],
    ["the verdict", "commitStatuses", "Couldn't read the review verdict on PRD PR #201's latest commit, so nothing was built."],
  ] as const)("stops, deciding nothing, where it cannot read %s", async (_case, method, sentence) => {
    onBranch([172]);
    prdPr();
    approve();

    await expect(run(INPUTS(), throwing(method))).rejects.toThrow(sentence);
    stoppedUndecided();
  });

  it("stops where a sub-issue's links cannot be read on a first build", async () => {
    await expect(run(INPUTS(), throwing("blockedBy"))).rejects.toThrow(
      `Couldn't read the "blocked by" links of sub-issue #172, so nothing was built.`,
    );
    stoppedUndecided();
  });

  /** A list that came back short would read its missing slices as never there. */
  it("stops where the sub-issue list comes back shorter than the count", async () => {
    github.issues.set(PARENT, { ...github.issues.get(PARENT)!, subIssues: 4 });
    const short: GitHubReader = { ...reader, issueShape: async () => ({ parent: undefined, subIssues: 4, labels: [IMPLEMENT_LABEL] }) };

    await expect(run(INPUTS(), short)).rejects.toThrow(
      "This PRD's sub-issue list came back with 3 of its 4 sub-issues, so nothing was built. Add `agent:implement` again.",
    );
    stoppedUndecided();
  });
});

describe("implement-prd:gate on the chain's state", () => {
  /** #173 is built; #172 is closed with no trailer, landed before the upgrade. The next is #174, and both count. */
  it("picks the first open sub-issue with no slice range", async () => {
    setSubIssues("CLOSED", "OPEN", "OPEN");
    onBranch([173]);
    prdPr();
    approve();

    await run();

    expect(decided).toMatchObject({ decision: "build", slice: { number: 174, position: 3, title: "Slice 3" }, landed: 2, total: 3 });
  });

  it("reads the trailer in any case, and a trailer naming no sub-issue as nothing", async () => {
    onBranch([], ["feat: one\n\nagent-slice: #172", "feat: elsewhere\n\nAgent-Slice: #9"]);
    prdPr();
    approve();

    await run();

    expect(decided).toMatchObject({ slice: { number: 173 }, landed: 1 });
    expect(reads.find((r) => r.method === "commitMessages")?.args).toEqual(["main", TIP]);
  });

  /** The gate, open: past an approval it builds the next slice, and hands the approved one on for its note. */
  it("builds the next slice past an approval, naming the approved slice, its head and its review", async () => {
    setSubIssues("CLOSED", "OPEN", "OPEN");
    onBranch([172, 173]);
    prdPr();
    approve();

    await run();

    expect(decided).toEqual({
      proceed: "true",
      decision: "build",
      prdBranch: PRD_BRANCH,
      prdBranchExists: true,
      prdTip: TIP,
      prdPr: 201,
      landed: 2,
      total: 3,
      slice: { number: 174, position: 3, title: "Slice 3" },
      approved: { number: 173, sha: HEAD, review: REVIEW_URL },
    });
    expect(logged).toContain(`PRD PR #201's latest commit ${HEAD} has an approval; the chain moves on.`);
  });

  /** The gate, shut: a refusal that names the ways on, and is not blocked. A human re-adding the label lands here too. */
  it("refuses the next slice where the head's round did not approve, unblocked", async () => {
    onBranch([172]);
    prdPr();
    verdictOnHead("failure", VERDICTS["needs a closer look"].description);

    await run();

    refused(
      "The review of PRD PR #201's latest commit didn't recommend approval (Needs a closer look), so the next slice wasn't started. To move on, add `agent:fix` to PRD PR #201 for another fix round; or decline a finding by replying to it, then add `agent:review` there; or push a commit, then add `agent:review` there. The chain moves on once a review of the PRD PR's latest commit recommends approval.",
      false,
    );
  });

  it("refuses while the PRD PR's round is running, before it reads the verdict", async () => {
    onBranch([172]);
    prdPr({ labels: ["agent:fix"] });

    await run();

    refused(
      "PRD PR #201 still has `agent:fix`, so its review round hasn't ended and nothing was built. Add `agent:implement` again once that label is gone.",
      false,
    );
    expect(reads.map((r) => r.method)).not.toContain("commitStatuses");
  });

  it("makes the finishing run once every sub-issue is built and the head is approved, starting nothing but noting the last slice", async () => {
    github.issueLabels.set(PARENT, [IMPLEMENT_LABEL, BLOCKED_LABEL]);
    onBranch([172, 173, 174]);
    prdPr();
    approve();

    await run();

    expect(decided).toMatchObject({ proceed: "true", decision: "finishing", landed: 3, prdPr: 201, approved: { number: 174 } });
    expect(decided).not.toHaveProperty("slice");
    expect(writes()).toEqual([
      `workflow addLabel #${PARENT} ${IMPLEMENT_LABEL}`,
      `workflow removeLabel #${PARENT} ${BLOCKED_LABEL}`,
      expect.stringMatching(/^workflow comment #174 \*\*Slice approved:\*\* /),
    ]);
    expect(logged).toContain(`Every sub-issue of #${PARENT} is built; finishing it.`);
  });

  it("refuses a PRD of several slices whose final review was requested as finished, unblocked", async () => {
    onBranch([172, 173, 174]);
    prdPr({ body: `Closes #171\n\n${FINAL_REVIEW_MARK}` });
    approve();

    await run();

    refused(
      "Every sub-issue of this PRD is built and the final review of PRD PR #201 was requested, so it's yours from here. To build more, add a sub-issue first.",
      false,
    );
  });

  it("refuses a one-slice PRD whose PRD PR is ready as finished, unblocked", async () => {
    setSubIssues("OPEN");
    onBranch([172]);
    prdPr({ draft: false });
    approve();

    await run();

    refused("Every sub-issue of this PRD is built and its PRD PR is ready for you. To build more, add a sub-issue first.", false);
  });

  /** A run that died between its push and opening the PRD PR: the re-label opens it, and builds nothing. */
  it("opens the missing PRD PR rather than building, when slices are built and none is open", async () => {
    onBranch([172]);

    await run();

    expect(decided).toEqual({
      proceed: "true",
      decision: "open-only",
      prdBranch: PRD_BRANCH,
      prdBranchExists: true,
      prdTip: TIP,
      landed: 1,
      total: 3,
    });
    expect(writes()).toEqual([`workflow addLabel #${PARENT} ${IMPLEMENT_LABEL}`, `workflow removeLabel #${PARENT} ${BLOCKED_LABEL}`]);
  });

  it("refuses a chain whose every sub-issue closed before the upgrade, unblocked", async () => {
    setSubIssues("CLOSED", "CLOSED");
    onBranch([]);
    prdPr();

    await run();

    refused(
      "Every sub-issue of this PRD was closed before this release built any of them, so there's nothing left to build. To build more, add a sub-issue, or reopen one, first.",
      false,
    );
  });
});

describe("implement-prd:gate on the links", () => {
  it("refuses a sub-issue listed before one it is blocked by, blocked, before anything is built", async () => {
    github.issues.set(173, { subIssues: 0, blockedBy: [{ number: 174, state: "open" }] });

    await run();

    refused(
      "Sub-issue #173 comes before #174 in this PRD's sub-issue list, but it's blocked by #174, so it would be built first. Reorder the sub-issues so #174 comes before #173, then add `agent:implement` again.",
      true,
    );
  });

  it("refuses a sub-issue blocked by an open issue outside the PRD, and not by a closed one", async () => {
    github.issues.set(173, { subIssues: 0, blockedBy: [{ number: 99, state: "open" }] });

    await run();

    refused(
      'Sub-issue #173 is blocked by #99, which isn\'t part of this PRD, and the chain can\'t build #173 until #99 is done. Move that "blocked by" link from #173 to this issue, then add `agent:implement` again.',
      true,
    );

    github = fakeGitHub([]);
    github.issues.set(PARENT, { subIssues: 0, blockedBy: [] });
    github.issueLabels.set(PARENT, [IMPLEMENT_LABEL]);
    setSubIssues("OPEN", "OPEN", "OPEN");
    github.issues.set(173, { subIssues: 0, blockedBy: [{ number: 99, state: "closed" }] });
    ({ reader, reads } = fakeReader(github));

    await run();

    expect(decided).toMatchObject({ proceed: "true", slice: { number: 172 } });
  });

  /**
   * A correctly ordered PRD whose slices are each blocked by the one before
   * runs every slice: the links never clear while the chain runs, and are
   * read before the first build only.
   */
  it("runs every slice of a chain whose slices are each blocked by the one before", async () => {
    github.issues.set(173, { subIssues: 0, blockedBy: [{ number: 172, state: "open" }] });
    github.issues.set(174, { subIssues: 0, blockedBy: [{ number: 173, state: "open" }] });
    const built: unknown[] = [];
    for (const done of [[], [172], [172, 173], [172, 173, 174]]) {
      github.branches.delete(PRD_BRANCH);
      github.pullRequests.clear();
      if (done.length > 0) {
        onBranch(done);
        prdPr();
        approve();
      }
      await run();
      built.push((decided as { slice?: { number: number }; decision?: string }).slice?.number ?? (decided as { decision?: string }).decision);
    }

    expect(built).toEqual([172, 173, 174, "finishing"]);
    expect(reads.filter((r) => r.method === "blockedBy")).toHaveLength(3);
  });

  it("refuses a parent with an open blocker before it builds, blocked", async () => {
    github.issues.set(PARENT, { ...github.issues.get(PARENT)!, blockedBy: [{ number: 50, state: "open" }] });

    await run();

    refused(
      'It\'s blocked by #50, which is still open. Add `agent:implement` again once #50 is closed, or remove the "blocked by" link if it no longer applies.',
      true,
    );
  });

  /** The one read the shell tolerated: a failed read of the parent's blockers is none. */
  it("goes ahead where the parent's blockers cannot be read", async () => {
    await run(INPUTS(), throwing("openBlockers"));

    expect(decided).toMatchObject({ proceed: "true", slice: { number: 172 } });
    expect(logged.some((line) => line.startsWith(`::warning::Could not read what blocks #${PARENT}; going ahead as though nothing does.`))).toBe(true);
  });

  /** A finished PRD is never handed `agent:blocked`: the finishing run reads no blockers. */
  it("does not read the parent's blockers on a finishing run", async () => {
    github.issues.set(PARENT, { ...github.issues.get(PARENT)!, blockedBy: [{ number: 50, state: "open" }] });
    onBranch([172, 173, 174]);
    prdPr();
    approve();

    await run();

    expect(decided).toMatchObject({ decision: "finishing" });
    expect(reads.map((r) => r.method)).not.toContain("openBlockers");
  });
});

/**
 * **A chain an older release started, at the upgrade** (#248): pre-upgrade
 * compatibility, removable under #224.
 */
describe("implement-prd:gate on a chain in flight at the upgrade", () => {
  it("builds the first open sub-issue, with no verdict to gate on and no links checked", async () => {
    setSubIssues("CLOSED", "CLOSED", "OPEN");
    github.issues.set(172, { subIssues: 0, blockedBy: [{ number: 174, state: "open" }] });
    onBranch([]);
    prdPr();

    await run();

    expect(decided).toMatchObject({ decision: "build", slice: { number: 174, position: 3 }, landed: 2, prdPr: 201 });
    expect(decided).not.toHaveProperty("approved");
    expect(reads.map((r) => r.method)).not.toContain("commitStatuses");
    expect(reads.map((r) => r.method)).not.toContain("blockedBy");
  });

  it("refuses an open slice PR into the PRD branch, naming every one, blocked", async () => {
    setSubIssues("CLOSED", "CLOSED", "OPEN");
    onBranch([]);
    prdPr();
    pull(190, "agent/slice-171-173-slice-2", PRD_BRANCH);
    pull(191, "agent/slice-171-174-slice-3", PRD_BRANCH);
    approve();

    await run();

    refused(
      `Slice PRs from an earlier release are still open into this PRD's branch \`${PRD_BRANCH}\`: #190 (\`agent/slice-171-173-slice-2\`), #191 (\`agent/slice-171-174-slice-3\`). This release builds every slice on the PRD branch itself and doesn't use slice PRs, so it won't build over them. Merge or close each by hand; if you close one without merging it, reopen its sub-issue so it's built again. Then add \`agent:implement\` again.`,
      true,
    );
  });

  it("does not refuse over a closed slice PR, a human's PR into the PRD branch, or another PRD's slice PR", async () => {
    setSubIssues("CLOSED", "OPEN", "OPEN");
    onBranch([]);
    prdPr();
    pull(190, "agent/slice-171-173-slice-2", PRD_BRANCH, "closed");
    pull(192, "fix/a-typo", PRD_BRANCH);
    pull(193, "agent/slice-1710-1711-other", "agent/prd-1710-other");

    await run();

    expect(decided).toMatchObject({ proceed: "true", slice: { number: 173 } });
  });
});

describe("implement-prd:gate claims a run it goes ahead on", () => {
  /** The chain's first run: the probe, a block cleared, the parent told once with no link, and the sub-issue linked. */
  it("probes, clears a block, and posts the first run's start comments in order", async () => {
    github.issueLabels.set(PARENT, [IMPLEMENT_LABEL, BLOCKED_LABEL]);

    await run();

    expect(writes()).toEqual([
      `workflow addLabel #${PARENT} ${IMPLEMENT_LABEL}`,
      `workflow removeLabel #${PARENT} ${BLOCKED_LABEL}`,
      `workflow comment #${PARENT} **\`agent:implement\` started:** building #172 first.`,
      `workflow comment #172 **\`agent:implement\` started:** Building now on the PRD branch \`${PRD_BRANCH}\`, whose PRD PR opens once this slice is pushed · [Workflow run](${RUN_URL})`,
    ]);
    expect(comments()[0]).toEqual([PARENT, `**\`agent:implement\` started:** building #172 first.\n\n${PRD_STARTED_MARK}`]);
    expect(comments()[0]?.[1]).not.toContain("actions/runs");
    expect(labels()).toEqual([IMPLEMENT_LABEL]);
  });

  /** A later run: the sub-issue linked, and a chapter marker on the PRD PR with no link; nothing on the parent. */
  it("links the run on the sub-issue a later run starts, and marks the chapter on the PRD PR", async () => {
    onBranch([172]);
    prdPr();
    approve();

    await run();

    expect(comments().slice(0, 2)).toEqual([
      [173, `**\`agent:implement\` started:** Building now on PRD PR #201 · [Workflow run](${RUN_URL})`],
      [201, "**Slice 2 of 3 · #173 started**"],
    ]);
    // Then the note on the slice approved, #172.
    expect(comments().map(([n]) => n)).toEqual([173, 201, 172]);
  });

  it("does not post the first run's comment on the parent twice on a retry", async () => {
    github.comments.push({ token: "workflow", issue: PARENT, body: `**\`agent:implement\` started:** building #172 first.\n\n${PRD_STARTED_MARK}` });

    await run();

    expect(comments().map(([n]) => n)).toEqual([PARENT, 172]);
  });

  it("goes on with a warning where no start comment can be posted", async () => {
    github.fails = (write) => write.type === "comment";

    await run();

    expect(decided).toMatchObject({ proceed: "true" });
    expect(logged).toContain(`::warning::Could not post the start comment on #${PARENT}. The run goes on; it is ${RUN_URL}.`);
    expect(logged).toContain(`::warning::Could not post the start comment on sub-issue #172. The run goes on; it is ${RUN_URL}.`);
  });

  /**
   * A gate that fails after claiming the run names its reason, and still
   * says it went ahead, with the slice it was building, so the failure
   * comment names both.
   */
  it("fails with a sentence where the probe is refused, having decided to go ahead", async () => {
    github.fails = (write) => write.type === "addLabel";

    await expect(run()).rejects.toThrow(
      `Couldn't add \`agent:implement\` to #${PARENT}, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants \`issues: write\`.`,
    );
    expect(decided).toMatchObject({ proceed: "true", decision: "build", slice: { number: 172 } });
    expect(comments()).toEqual([]);
  });
});

/**
 * The note on the approved slice (#246), carried over by behaviour from the
 * retired shell step's cases in `tests/implement-prd-preflight.test.ts`: a
 * build past an approval of #173's round, with #174 next.
 */
describe("implement-prd:gate notes the approved slice", () => {
  beforeEach(() => {
    onBranch([172, 173]);
    prdPr();
    approve();
  });

  /** An approving review's body, its #214 record rendered as the review renders it. */
  const approving = (criteria: readonly CriterionResult[]): void => {
    github.reviews.push({
      token: "workflow",
      pullRequestId: "PR_201",
      commit: HEAD,
      body: ["## Agent review", "", "Approved.", "", renderCriteriaGroup(criteria) ?? "", "", "Footer."].join("\n"),
      threads: [],
      url: REVIEW_URL,
    });
  };
  const notes = (): [number, string][] => comments().filter(([, body]) => body.startsWith("**Slice approved:**"));

  it("notes the approved slice on its sub-issue, with the criteria the approving round changed or left unmet", async () => {
    approving([
      { id: "C1", text: "It renders every state.", status: "met" },
      { id: "C2", text: "It survives the splice.", status: "changed", reason: "the splice moved" },
      { id: "C3", text: "No label is added.", status: "unmet" },
    ]);

    await run();

    expect(notes()).toEqual([
      [
        173,
        [
          `**Slice approved:** built in [\`eeeeeee\`](https://github.com/acme/widgets/commit/${HEAD}), [reviewed](${REVIEW_URL}) on PRD PR #201. This sub-issue stays open until the PRD PR merges.`,
          "",
          "**Acceptance criteria changed or unmet:**",
          "",
          "- **Changed:** It survives the splice. · the splice moved",
          "- **Unmet:** No label is added.",
          "",
          `<!-- agent:slice-approved ${HEAD} -->`,
        ].join("\n"),
      ],
    ]);
    // After the start comments, as the shell step ran after them.
    expect(comments().map(([n]) => n)).toEqual([174, 201, 173]);
  });

  /** A retry past the same approval, after a run that failed, posts no second note. */
  it("notes an approved head once", async () => {
    approving([]);
    github.comments.push({ token: "workflow", issue: 173, body: `**Slice approved:** …\n\n${sliceApprovedMark(HEAD)}` });

    await run();

    expect(notes()).toHaveLength(1);
    expect(logged).toContain(`Sub-issue #173 already has its approved-slice note for ${HEAD}.`);
  });

  it("says none changed or went unmet where the approving round met every criterion", async () => {
    approving([{ id: "C1", text: "It renders every state.", status: "met" }]);

    await run();

    expect(notes()[0]?.[1]).toContain("\n\n**Acceptance criteria changed or unmet:** none.\n\n<!-- agent:slice-approved");
  });

  it("still notes the slice, saying so, where the approving review cannot be read", async () => {
    await run(INPUTS(), throwing("reviews"));

    expect(logged).toContain(`::warning::Could not read the review that approved sub-issue #173 (${REVIEW_URL}), so its note does not list the criteria.`);
    expect(notes()[0]?.[1]).toContain("the approving review couldn't be read");
    expect(decided).toMatchObject({ proceed: "true", slice: { number: 174 } });
  });

  it("says it is reviewed on the PRD PR, unlinked, where the verdict links no review", async () => {
    verdictOnHead("success", VERDICTS["approval recommended"].description, null);

    await run();

    expect(notes()[0]?.[1]).toContain(", reviewed on PRD PR #201. This sub-issue");
    expect(logged).toContain("::warning::Could not read the review that approved sub-issue #173 (no link), so its note does not list the criteria.");
  });

  it("goes on with a warning where the note cannot be posted", async () => {
    github.fails = (write) => write.type === "comment";

    await run();

    expect(logged).toContain("::warning::Could not post the approved-slice note on sub-issue #173. The run goes on.");
    expect(decided).toMatchObject({ proceed: "true", slice: { number: 174 } });
  });
});

/**
 * The slice **building** in the PRD PR's progress list and status line
 * (#312), carried over by behaviour from the retired shell step's cases in
 * `tests/pr-body-steps.test.ts`: #173, slice 2 of 3, past #172's approval.
 * What it writes is what the renderer renders with the slice building.
 */
describe("implement-prd:gate shows the slice building", () => {
  const SUBS = [
    { number: 172, title: "Slice 1", state: "OPEN" as const },
    { number: 173, title: "Slice 2", state: "OPEN" as const },
    { number: 174, title: "Slice 3", state: "OPEN" as const },
  ];
  const prUrl = "https://github.com/acme/widgets/pull/201";
  const approved: ProgressInputs = {
    subIssues: SUBS,
    ranges: sliceRanges([{ sha: "0123456789abcdef", parents: ["fedcba9876543210"], slice: 172 }], SUBS),
    verdict: "approval",
    running: null,
    finalReview: "not requested",
    prUrl,
    rounds: {
      slices: { 172: { reviews: 2, fixes: 1, latestReview: `${prUrl}#pullrequestreview-9` } },
      final: { reviews: 0, fixes: 0 },
      all: { reviews: 2, fixes: 1 },
    },
  };
  const building: ProgressInputs = { ...approved, running: { kind: "build", subIssue: 173 } };
  const frame = (inputs: ProgressInputs): string =>
    [`> [!NOTE]\n> ${statusBlock(renderPrdStatus(inputs))}\n> Mine.`, "## Summary\n\nx", renderProgressList(inputs), "Closes #171\n"].join("\n\n");

  const withBody = (body: string): void => {
    onBranch([172]);
    prdPr({ body });
    approve();
  };
  const body = (): string | undefined => github.pullRequests.get(201)?.body;
  const edits = (): string[] => writes().filter((w) => w.includes("editPullRequest"));

  it("writes the table and the status line the renderer renders with the slice building", async () => {
    withBody(frame(approved));

    await run();

    expect(body()).toBe(frame(building));
    expect(renderProgressList(building)).toContain("| 2 · #173 | 🔨 Building | – | – | – |");
    expect(renderPrdStatus(building)).toBe("**🔨 Building slice 2 of 3** · #173");
    expect(kept).toEqual({
      "progress_unbuilt.md": renderProgressList(approved),
      "status_unbuilt.md": statusBlock(renderPrdStatus(approved)),
    });
    expect(edits()).toEqual(["workflow editPullRequest #201"]);
    expect(logged).toContain("PRD PR #201's progress list shows sub-issue #173 building.");
  });

  it("writes the table alone where the note has no status line, as the splice leaves one", async () => {
    const before = `Mine.\n\n${renderProgressList(approved)}`;
    withBody(before);

    await run();

    expect(body()).toBe(spliceProgressList(before, renderProgressList(building)));
    expect(kept).toEqual({ "progress_unbuilt.md": renderProgressList(approved) });
  });

  it.each([
    ["half a list", `Mine.\n${PROGRESS_START}\nrest`, "::warning::PRD PR #201's body carries half a progress list, or two, so it was not written."],
    [
      "two lists",
      `${renderProgressList(approved)}\n${renderProgressList(approved)}`,
      "::warning::PRD PR #201's body carries half a progress list, or two, so it was not written.",
    ],
    [
      "a list without the slice's row",
      renderProgressList({ ...approved, subIssues: SUBS.slice(0, 1) }),
      "::warning::PRD PR #201's progress list has no row for sub-issue #173 as slice 2, so it was not written.",
    ],
  ])("leaves %s alone, with a warning, and keeps nothing to write back", async (_case, before, warning) => {
    withBody(before);

    await run();

    expect(body()).toBe(before);
    expect(logged.some((line) => line.startsWith(warning))).toBe(true);
    expect(kept).toEqual({});
    expect(decided).toMatchObject({ proceed: "true", slice: { number: 173 } });
  });

  it("writes nothing to a body with no list", async () => {
    withBody("Mine.");

    await run();

    expect(body()).toBe("Mine.");
    expect(kept).toEqual({});
    expect(logged).toContain("PRD PR #201's body carries no progress list, so none shows sub-issue #173 building.");
  });

  it("goes on with a warning where the PRD PR cannot be written", async () => {
    withBody(frame(approved));
    github.fails = (write) => write.type === "editPullRequest";

    await run();

    expect(body()).toBe(frame(approved));
    expect(logged).toContain(
      "::warning::Could not write PRD PR #201's progress list, so it does not show sub-issue #173 building. GitHub's reply is in the write log.",
    );
    expect(decided).toMatchObject({ proceed: "true", slice: { number: 173 } });
  });

  it("writes no list on a first slice, with no PRD PR, nor on a finishing run", async () => {
    await run();
    expect(edits()).toEqual([]);

    github = fakeGitHub([]);
    github.issues.set(PARENT, { subIssues: 0, blockedBy: [] });
    github.issueLabels.set(PARENT, [IMPLEMENT_LABEL]);
    setSubIssues("OPEN", "OPEN", "OPEN");
    ({ reader } = fakeReader(github));
    onBranch([172, 173, 174]);
    prdPr({ body: frame(approved) });
    approve();

    await run();

    expect(decided).toMatchObject({ decision: "finishing" });
    expect(edits()).toEqual([]);
    expect(body()).toBe(frame(approved));
  });
});
