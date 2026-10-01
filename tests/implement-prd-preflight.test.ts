import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUMMARY_END, SUMMARY_START } from "../shared/pr-summary.js";
import {
  FINAL_REVIEW_MARK,
  FINAL_REVIEW_REQUESTED_LINES,
  PROGRESS_END,
  PROGRESS_START,
  renderProgressList,
} from "../shared/progress-list.js";
import { renderCriteriaGroup, VERDICTS, type CriterionResult } from "../shared/review-output.js";
import { sliceRanges } from "../shared/slice-ranges.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs `implement-prd`'s preflight — the real `run:` block, read out of
 * `.github/workflows/implement-prd.yml` — under `bash -e` against the recorded
 * `gh` in `tests/fixtures/gh-replay`, the seam `tests/review-ci-wait.test.ts`
 * built for the same reason: a string assertion passes on a step `gh` refuses
 * (#28).
 *
 * What it executes is the preflight's state table (PRD #222, #243), every row
 * of it. Which sub-issues are built is read off the PRD branch, from the
 * `Agent-Slice` trailers of the commits it has and the default branch lacks,
 * and never from which sub-issues are closed. A built slice moves the chain on
 * only when the PRD PR's head carries an approval: every other verdict, and no
 * verdict, refuses and names the ways on. Before the first build, and only
 * then, the sub-issues' "blocked by" links are checked against their order.
 *
 * And the steps that come after it: the step that opens or reuses the PRD PR,
 * and the finishing run's handover of it, executed the same way, against the
 * same replay.
 *
 * Skipped where `bash`, `jq` or `node` are not on PATH, as that file is.
 */

const PRD = path.join(".github", "workflows", "implement-prd.yml");
const REPLAY_DIR = path.join("tests", "fixtures", "gh-replay");

interface Step {
  readonly id?: string;
  readonly shell?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const stepById = (id: string): Step => {
  const step = ((parse(fs.readFileSync(PRD, "utf8")) as Workflow).jobs["implement-prd"]?.steps ?? []).find(
    (s) => s.id === id,
  );

  expect(step).toBeDefined();
  return step as Step;
};

const preflight = (): Step => stepById("preflight");

/** Bounded, for the reason `review-ci-wait.test.ts` gives its own copy. */
const onPath = (command: string): boolean =>
  process.platform === "win32"
    ? spawnSync("where", [command], { timeout: SUBPROCESS_TIMEOUT }).status === 0
    : spawnSync("sh", ["-c", `command -v ${command}`], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

const CAN_RUN = ["bash", "jq", "node"].every(onPath);

const GH_REPO = "acme/widgets";
const PARENT = "171";
const PRD_BRANCH = "agent/prd-171-slices-on-the-prd-branch";
const PRD_TIP = "0123456789abcdef0123456789abcdef01234567";

/** A PRD whose sub-issues, #172 on, are in `states`: open, all three, unless said. */
const issue = (states: readonly string[] = ["OPEN", "OPEN", "OPEN"]): Record<string, unknown> => ({
  parent: null,
  labels: { nodes: [{ name: "agent:implement" }] },
  subIssues: {
    totalCount: states.length,
    nodes: states.map((state, i) => ({ number: 172 + i, title: `Slice ${i + 1}`, state })),
  },
});

const pull = (
  number: number,
  headRefName: string,
  baseRefName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  number,
  headRefName,
  baseRefName,
  state: "OPEN",
  isDraft: true,
  headRefOid: `sha-of-${number}`,
  labels: [],
  ...extra,
});

/** The PRD PR, #201: a draft from the PRD branch into the base. */
const PRD_PR = pull(201, PRD_BRANCH, "main");

/** What the handover of a PRD of more than one slice leaves in the PRD PR's body. */
const FINAL_REVIEW = "<!-- agent:final-review requested -->";

/**
 * What the lookups must look past: an ordinary PR into the base branch, and
 * the PRD PR of PRD #1710, whose branch starts with this one's number and is
 * kept out only by the dash after it.
 */
const BYSTANDERS = [pull(200, "agent/issue-9-typo", "main"), pull(203, "agent/prd-1710-other", "main")];

/**
 * The commits the PRD branch has and the base lacks, each slice's carrying the
 * trailer a build run gives it, with an untrailered fix commit after each, as a
 * fix round leaves one.
 */
const sliceCommits = (subs: readonly number[]): Record<string, unknown>[] =>
  subs.flatMap((sub) => [
    { sha: `built-${sub}`, commit: { message: `feat: slice ${sub} (#${sub})\n\nWhy.\n\nAgent-Slice: #${sub}` } },
    { sha: `fixed-${sub}`, commit: { message: `fix: address review findings on slice ${sub}` } },
  ]);

/** One `agent-review` status on the PRD PR's head, as the combined status lists it. */
const verdictOn = (state: string, description: string): Record<string, unknown>[] => [
  {
    state: state === "success" ? "success" : "failure",
    total_count: 2,
    statuses: [
      { context: "agent-review", state, description },
      { context: "ci/build", state: "success", description: "Build passed" },
    ],
  },
];

const APPROVED = verdictOn("success", VERDICTS["approval recommended"].description);

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly output: string;
  readonly reason: string;
  readonly writes: readonly string[];
  /** A file the step wrote under `RUNNER_TEMP`, or "" if it wrote none. */
  readonly temp: (name: string) => string;
}

interface Scenario {
  readonly issue?: Record<string, unknown>;
  readonly pulls?: readonly Record<string, unknown>[];
  /** The `agent/prd-171-` branches on the remote; the PRD branch at `PRD_TIP` unless said. */
  readonly branches?: readonly { readonly name: string; readonly sha: string }[];
  /** The sub-issues whose slices are on the PRD branch, in the order they were built. */
  readonly built?: readonly number[];
  /** Extra commits, after the slices', for a scenario to say something odd. */
  readonly commits?: readonly Record<string, unknown>[];
  /** The combined-status pages on the PRD PR's head. */
  readonly statusPages?: readonly Record<string, unknown>[];
  /** The "blocked by" links, keyed by issue number. */
  readonly blockedBy?: Record<string, readonly Record<string, unknown>[]>;
  /** The step's own `env:`, supplied in the expressions' place. */
  readonly env?: Record<string, string>;
  /** The PRD PR's reviews, keyed by id. */
  readonly reviews?: Record<string, Record<string, unknown>>;
  /** Issue comments, an array per issue number. */
  readonly comments?: Record<string, readonly Record<string, unknown>[]>;
  /** Files an earlier step left under `RUNNER_TEMP`, by name. */
  readonly files?: Record<string, string>;
}

const runStep = (id: string, scenario: Scenario = {}): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-implement-prd-"));
  const script = path.join(temp, "step.sh");
  const files = {
    GH_REPLAY_ISSUE: ["issue.json", scenario.issue ?? issue()],
    GH_REPLAY_PULLS: ["pulls.json", scenario.pulls ?? [...BYSTANDERS, PRD_PR]],
    GH_REPLAY_REFS: ["refs.json", scenario.branches ?? [{ name: PRD_BRANCH, sha: PRD_TIP }]],
    GH_REPLAY_COMPARE: [
      "compare.json",
      { status: "ahead", commits: [...sliceCommits(scenario.built ?? []), ...(scenario.commits ?? [])] },
    ],
    GH_REPLAY_STATUS_PAGES: [
      "status.json",
      scenario.statusPages ?? [{ state: "pending", total_count: 0, statuses: [] }],
    ],
    GH_REPLAY_BLOCKED_BY: ["blocked-by.json", scenario.blockedBy ?? {}],
    GH_REPLAY_REVIEWS: ["reviews.json", scenario.reviews ?? {}],
    GH_REPLAY_COMMENTS: ["comments.json", scenario.comments ?? {}],
  } as const;
  const output = path.join(temp, "output");
  const log = path.join(temp, "writes.log");

  fs.writeFileSync(script, stepById(id).run ?? "");
  const replay: Record<string, string> = {};
  for (const [name, [file, value]] of Object.entries(files)) {
    replay[name] = path.join(temp, file);
    fs.writeFileSync(replay[name], JSON.stringify(value));
  }
  // The snapshot the preflight leaves for the steps after it, as a run that
  // got past the preflight has it.
  if (id !== "preflight") fs.writeFileSync(path.join(temp, "prd-issue.json"), JSON.stringify(scenario.issue ?? issue()));
  for (const [name, content] of Object.entries(scenario.files ?? {})) fs.writeFileSync(path.join(temp, name), content);
  fs.writeFileSync(output, "");

  const ghDir = path.resolve(REPLAY_DIR);
  for (const file of fs.readdirSync(ghDir)) fs.chmodSync(path.join(ghDir, file), 0o755);

  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      // The job-level env the step reads, supplied in the event's place.
      ISSUE_NUMBER: PARENT,
      ISSUE_TITLE: "Slices on the PRD branch",
      ISSUE_STATE: "open",
      BASE_REF: "main",
      GH_REPO,
      GH_TOKEN: "test-token",
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      ...replay,
      GH_REPLAY_LOG: log,
      PATH: `${ghDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      // The step's own `env:` where it is a literal rather than an expression.
      ...Object.fromEntries(Object.entries(stepById(id).env ?? {}).filter(([, value]) => !value.includes("${{"))),
      ...scenario.env,
    },
  });
  const read = (name: string): string => {
    const file = path.join(temp, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };

  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    output: fs.readFileSync(output, "utf8"),
    reason: read("failure_reason.txt"),
    writes: read("writes.log").split("\n").filter(Boolean),
    temp: read,
  };
};

const runPreflight = (scenario: Scenario = {}): Outcome => runStep("preflight", scenario);

/** One output a step wrote, read back as the expression after it would. */
const outputOf = (outcome: Outcome, name: string): string =>
  new RegExp(`^${name}=(.*)$`, "m").exec(outcome.output)?.[1] ?? "";

/** Every write, as the argv `gh` was called with. */
const writes = (outcome: Outcome): string[][] => outcome.writes.map((line) => JSON.parse(line) as string[]);

/** The comment a refusal posted on the parent, or "" if it posted none. */
const refusal = (outcome: Outcome): string =>
  writes(outcome).find((argv) => argv[0] === "issue" && argv[1] === "comment")?.at(-1) ?? "";

/** The ways on from a round that did not end on an approval, each named. */
const expectWaysOn = (comment: string): void => {
  expect(comment).toContain("add `agent:fix` to PRD PR #201");
  expect(comment).toMatch(/decline a finding by replying to it, then add `agent:review`/);
  expect(comment).toMatch(/push a commit, then add `agent:review`/);
};

describe.skipIf(!CAN_RUN)("agent-implement-prd's preflight, executed", () => {
  it("runs under the shell the workflow actually gets", () => {
    expect(preflight().shell).toBeUndefined();
  });

  /**
   * The first run of a chain: no PRD branch yet, so nothing is built. It
   * builds the first sub-issue on a branch named from the parent's title, and
   * touches nothing on the tracker on the way.
   */
  it("builds the first sub-issue on a new PRD branch when nothing is built", () => {
    const outcome = runPreflight({ branches: [], pulls: BYSTANDERS });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "sub")).toBe("172");
    expect(outputOf(outcome, "build")).toBe("true");
    expect(outputOf(outcome, "finishing")).toBe("false");
    expect(outputOf(outcome, "landed")).toBe("0");
    expect(outputOf(outcome, "prd_branch")).toBe(PRD_BRANCH);
    expect(outputOf(outcome, "prd_branch_exists")).toBe("false");
    expect(outputOf(outcome, "prd_pr")).toBe("");
    expect(outputOf(outcome, "refused")).toBe("false");
    expect(outcome.output).toContain("sub_title<<PRD_SUB_TITLE_EOF\nSlice 1\nPRD_SUB_TITLE_EOF\n");
    expect(outcome.writes).toEqual([]);
  });

  /** What `Open or reuse the PRD PR` writes its `Closes` lines from. */
  it("leaves its snapshot of the PRD for the steps after it", () => {
    const outcome = runPreflight({ branches: [] });

    expect(JSON.parse(outcome.temp("prd-issue.json"))).toEqual(issue());
  });

  /** A PRD of one sub-issue is a chain of one slice, not a shape to refuse. */
  it("accepts a PRD with one sub-issue", () => {
    const outcome = runPreflight({ issue: issue(["OPEN"]), branches: [], pulls: BYSTANDERS });

    expect(outcome.status).toBe(0);
    expect(outputOf(outcome, "sub")).toBe("172");
    expect(outputOf(outcome, "build")).toBe("true");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * The PRD branch is found by the half of its name a human cannot edit, so a
   * retitled parent still finds it, and a PRD whose number starts this one's
   * is not it.
   */
  it("finds the PRD branch by the parent's number, whatever its slug now is", () => {
    const outcome = runPreflight({
      branches: [
        { name: "agent/prd-1710-other", sha: "other" },
        { name: "agent/prd-171-an-old-title", sha: PRD_TIP },
      ],
      pulls: [...BYSTANDERS, { ...PRD_PR, headRefName: "agent/prd-171-an-old-title" }],
      built: [172],
      statusPages: APPROVED,
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "prd_branch")).toBe("agent/prd-171-an-old-title");
    expect(outputOf(outcome, "prd_branch_exists")).toBe("true");
    expect(outputOf(outcome, "prd_pr")).toBe("201");
    expect(outputOf(outcome, "sub")).toBe("173");
  });

  it("stops on two branches for one PRD, naming both", () => {
    const outcome = runPreflight({
      branches: [
        { name: PRD_BRANCH, sha: PRD_TIP },
        { name: "agent/prd-171-a-fork", sha: "fork" },
      ],
    });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain(`\`${PRD_BRANCH}\`, \`agent/prd-171-a-fork\``);
    expect(outcome.reason).toContain("Delete or rename all but one");
    expect(outcome.output).not.toContain("refused=");
    expect(outcome.writes).toEqual([]);
  });

  it("stops on two open PRs from the PRD branch, naming both", () => {
    const outcome = runPreflight({ pulls: [...BYSTANDERS, PRD_PR, pull(205, PRD_BRANCH, "release")], built: [172] });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("#201, #205");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * **The next slice is chosen by slice range, not by state.** #173 is open
   * and built, so it is not built again; #172 is closed and has no range, so
   * it is not skipped (counting it as landed before an upgrade is a later
   * rule's to add).
   */
  it("picks the first sub-issue with no slice range, open or closed", () => {
    const outcome = runPreflight({ issue: issue(["CLOSED", "OPEN", "OPEN"]), built: [173], statusPages: APPROVED });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "sub")).toBe("172");
    expect(outputOf(outcome, "landed")).toBe("1");
  });

  it("does not build again an open sub-issue that has a slice range", () => {
    const outcome = runPreflight({ built: [172], statusPages: APPROVED });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "sub")).toBe("173");
    expect(outputOf(outcome, "build")).toBe("true");
    expect(outputOf(outcome, "landed")).toBe("1");
  });

  /**
   * The trailer is read the way git's own parser reads it, any case. A trailer
   * naming an issue outside the PRD marks nothing, and a commit merged in from
   * the default branch never reaches the comparison at all.
   */
  it("reads the trailer in any case, and a trailer naming no sub-issue as nothing", () => {
    const outcome = runPreflight({
      commits: [
        { sha: "a", commit: { message: "feat: one\n\nagent-slice: #172" } },
        { sha: "b", commit: { message: "feat: elsewhere\n\nAgent-Slice: #9" } },
      ],
      statusPages: APPROVED,
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "sub")).toBe("173");
    expect(outputOf(outcome, "landed")).toBe("1");
  });

  /** "Could not look" is never read as "nothing built", which would build the first slice again. */
  it("stops, naming the branch, when it cannot read which sub-issues are built", () => {
    const outcome = runPreflight({ built: [172], statusPages: APPROVED, env: { GH_REPLAY_COMPARE_FAILURE: "1" } });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain(`already built on \`${PRD_BRANCH}\`, so nothing was built`);
    expect(outcome.output).not.toContain("sub=");
    expect(outcome.writes).toEqual([]);
  });

  /** The gate, open: an approval on the PRD PR's head moves the chain on. */
  it("builds the next slice when the PRD PR's head carries an approval", () => {
    const outcome = runPreflight({ built: [172], statusPages: APPROVED });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "sub")).toBe("173");
    expect(outputOf(outcome, "refused")).toBe("false");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * The gate, shut: every other ending of a round refuses, takes the label off
   * and names the ways on, and is not a block. The label is never the gate, so
   * a human re-adding `agent:implement` to a parked chain lands here too.
   */
  it.each([
    ["changes recommended", verdictOn("failure", VERDICTS["changes recommended"].description), "Changes recommended"],
    [
      "changes recommended after a fix round",
      verdictOn("failure", "Changes recommended after a fix round. Read the review, then add agent:fix again or fix it by hand."),
      "Changes recommended after a fix round",
    ],
    [
      "changes recommended, with a fix round started",
      verdictOn("failure", VERDICTS["changes recommended, fix round started"].description),
      "Changes recommended",
    ],
    ["needs a closer look", verdictOn("failure", VERDICTS["needs a closer look"].description), "Needs a closer look"],
    [
      "an error status",
      verdictOn("error", "The review run did not finish, so there's no verdict. Check the run, then re-add agent:review."),
      "didn't finish",
    ],
    ["no verdict at all", [{ state: "pending", total_count: 0, statuses: [] }], "hasn't been reviewed"],
  ])("refuses the next slice on %s, naming the ways on", (_case, statusPages, says) => {
    const outcome = runPreflight({ built: [172], statusPages });
    const comment = refusal(outcome);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "refused")).toBe("true");
    expect(outputOf(outcome, "sub")).toBe("");
    expect(comment).toContain("**`agent:implement` didn't run:**");
    expect(comment).toContain(says);
    expect(comment).toContain("the next slice wasn't started");
    expectWaysOn(comment);
    expect(writes(outcome).slice(1)).toEqual([["issue", "edit", PARENT, "--remove-label", "agent:implement"]]);
  });

  /**
   * #203, replayed: jeffwlawson/mealie-mcp-server#77's round ended with one
   * open Low finding and *changes recommended*, and the chain built on it
   * about thirty seconds later. Now the next slice does not start, whoever
   * re-adds the label.
   */
  it("does not start the next slice on the mealie#77 sequence: one open Low finding, changes recommended", () => {
    const outcome = runPreflight({
      issue: issue(["OPEN", "OPEN", "OPEN", "OPEN", "OPEN", "OPEN"]),
      built: [172, 173],
      statusPages: verdictOn("failure", VERDICTS["changes recommended"].description),
    });

    expect(outputOf(outcome, "refused")).toBe("true");
    expect(outputOf(outcome, "build")).toBe("");
    expectWaysOn(refusal(outcome));
  });

  /** A parked chain re-labelled by hand: the label alone moves nothing. */
  it("refuses a human re-adding the label to a parked chain", () => {
    const outcome = runPreflight({
      built: [172],
      statusPages: verdictOn("failure", VERDICTS["needs a closer look"].description),
    });

    expect(outputOf(outcome, "refused")).toBe("true");
    expect(writes(outcome).some((argv) => argv.includes("agent:blocked"))).toBe(false);
  });

  /** A round in flight is never cut short, whatever its head carries now. */
  it.each(["agent:review", "agent:fix", "agent:update-branch"])(
    "refuses while the PRD PR carries %s, its round still running",
    (label) => {
      const outcome = runPreflight({
        pulls: [...BYSTANDERS, { ...PRD_PR, labels: [{ name: label }] }],
        built: [172],
        statusPages: APPROVED,
      });

      expect(outputOf(outcome, "refused")).toBe("true");
      expect(refusal(outcome)).toContain(`PRD PR #201 still has \`${label}\``);
    },
  );

  /** Every sub-issue built and the last round approved: the finishing run. */
  it("makes the finishing run once every sub-issue is built and the head is approved", () => {
    const outcome = runPreflight({ built: [172, 173, 174], statusPages: APPROVED });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "finishing")).toBe("true");
    expect(outputOf(outcome, "build")).toBe("false");
    expect(outputOf(outcome, "sub")).toBe("");
    expect(outputOf(outcome, "landed")).toBe("3");
    expect(outputOf(outcome, "prd_pr")).toBe("201");
    expect(outcome.writes).toEqual([]);
  });

  /** …and not before its last round approves. */
  it("does not finish on a last slice whose round did not approve", () => {
    const outcome = runPreflight({
      built: [172, 173, 174],
      statusPages: verdictOn("failure", VERDICTS["changes recommended"].description),
    });

    expect(outputOf(outcome, "refused")).toBe("true");
    expect(outputOf(outcome, "finishing")).toBe("");
  });

  /**
   * A PRD PR handed over already is a finished PRD. With more than one slice,
   * that is the final-review mark the handover writes, whatever the draft
   * state: review marks the PRD PR ready after slice rounds too.
   */
  it.each([true, false])(
    "refuses a PRD of several slices whose final review was requested as finished (draft: %s)",
    (isDraft) => {
      const outcome = runPreflight({
        pulls: [...BYSTANDERS, { ...PRD_PR, isDraft, body: `Closes #171\n\n${FINAL_REVIEW}` }],
        built: [172, 173, 174],
        statusPages: APPROVED,
      });

      expect(outputOf(outcome, "refused")).toBe("true");
      expect(refusal(outcome)).toContain(
        "Every sub-issue of this PRD is built and the final review of PRD PR #201 was requested",
      );
      expect(refusal(outcome)).not.toMatch(/agent:review/);
      expect(writes(outcome).some((argv) => argv.includes("agent:blocked"))).toBe(false);
    },
  );

  /**
   * The sequence the draft test got wrong: slice 1's round ended and review
   * marked the PRD PR ready, as it does after any round that starts no fix,
   * and every later slice was built on it. Ready is not handed over, so the
   * last approval still makes the finishing run, and the final review is
   * still asked for.
   */
  it("makes the finishing run of a PRD of several slices whose PRD PR review already marked ready", () => {
    const outcome = runPreflight({
      pulls: [...BYSTANDERS, { ...PRD_PR, isDraft: false, body: "Closes #171" }],
      built: [172, 173, 174],
      statusPages: APPROVED,
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "refused")).toBe("false");
    expect(outputOf(outcome, "finishing")).toBe("true");
    expect(outputOf(outcome, "landed")).toBe("3");
    expect(outcome.writes).toEqual([]);
  });

  /** With one slice, ready is the whole handover, so ready is finished, whoever marked it. */
  it("refuses a one-slice PRD whose PRD PR is ready as finished", () => {
    const outcome = runPreflight({
      issue: issue(["OPEN"]),
      pulls: [...BYSTANDERS, { ...PRD_PR, isDraft: false }],
      built: [172],
      statusPages: APPROVED,
    });

    expect(outputOf(outcome, "refused")).toBe("true");
    expect(refusal(outcome)).toContain("Every sub-issue of this PRD is built and its PRD PR is ready for you.");
    expect(writes(outcome).some((argv) => argv.includes("agent:blocked"))).toBe(false);
  });

  it("makes the finishing run of a one-slice PRD whose PRD PR is still a draft", () => {
    const outcome = runPreflight({ issue: issue(["OPEN"]), built: [172], statusPages: APPROVED });

    expect(outputOf(outcome, "refused")).toBe("false");
    expect(outputOf(outcome, "finishing")).toBe("true");
    expect(outputOf(outcome, "landed")).toBe("1");
  });

  /**
   * A run that died between its push and opening the PRD PR leaves slices on
   * the branch and no PRD PR. The re-label opens it and asks for the review,
   * and builds nothing: there is no verdict to gate on until it has.
   */
  it("opens the missing PRD PR rather than building, when slices are built and none is open", () => {
    const outcome = runPreflight({ pulls: BYSTANDERS, built: [172] });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "build")).toBe("false");
    expect(outputOf(outcome, "finishing")).toBe("false");
    expect(outputOf(outcome, "refused")).toBe("false");
    expect(outputOf(outcome, "prd_pr")).toBe("");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * **Blocking links, checked once, before the first build.** A sub-issue
   * listed before one it is blocked by is refused, naming both, and nothing is
   * built.
   */
  it("refuses a sub-issue listed before one it is blocked by, naming both, before anything is built", () => {
    const outcome = runPreflight({
      branches: [],
      pulls: BYSTANDERS,
      blockedBy: { "173": [{ number: 174, state: "open" }] },
    });
    const comment = refusal(outcome);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "refused")).toBe("true");
    expect(outputOf(outcome, "build")).toBe("");
    expect(comment).toContain("Sub-issue #173 comes before #174");
    expect(comment).toContain("Reorder the sub-issues so #174 comes before #173");
    expect(writes(outcome).at(-1)).toEqual(["issue", "edit", PARENT, "--add-label", "agent:blocked"]);
  });

  it("refuses a sub-issue blocked by an issue outside the PRD, naming the link to move to the parent", () => {
    const outcome = runPreflight({
      branches: [],
      pulls: BYSTANDERS,
      blockedBy: { "173": [{ number: 99, state: "open" }] },
    });
    const comment = refusal(outcome);

    expect(outputOf(outcome, "refused")).toBe("true");
    expect(comment).toContain("Sub-issue #173 is blocked by #99, which isn't part of this PRD");
    expect(comment).toContain('Move that "blocked by" link from #173 to this issue');
    expect(writes(outcome).at(-1)).toEqual(["issue", "edit", PARENT, "--add-label", "agent:blocked"]);
  });

  /** A closed outside blocker is done with, as a closed blocker of the parent is. */
  it("does not refuse a sub-issue blocked by an outside issue that is closed", () => {
    const outcome = runPreflight({
      branches: [],
      pulls: BYSTANDERS,
      blockedBy: { "173": [{ number: 99, state: "closed" }] },
    });

    expect(outputOf(outcome, "refused")).toBe("false");
    expect(outputOf(outcome, "sub")).toBe("172");
  });

  /**
   * A correctly ordered PRD whose slices are each blocked by the one before
   * runs every slice: the links never clear while the chain runs, since
   * sub-issues stay open, and the check is made before the first build only.
   */
  it("runs every slice of a chain whose slices are each blocked by the one before", () => {
    const blockedBy = {
      "173": [{ number: 172, state: "open" }],
      "174": [{ number: 173, state: "open" }],
    };
    const first = runPreflight({ branches: [], pulls: BYSTANDERS, blockedBy });
    const second = runPreflight({ built: [172], statusPages: APPROVED, blockedBy });
    const third = runPreflight({ built: [172, 173], statusPages: APPROVED, blockedBy });
    const last = runPreflight({ built: [172, 173, 174], statusPages: APPROVED, blockedBy });

    expect([first, second, third].map((o) => outputOf(o, "sub"))).toEqual(["172", "173", "174"]);
    expect(outputOf(last, "finishing")).toBe("true");
    for (const outcome of [first, second, third, last]) expect(outcome.writes).toEqual([]);
  }, 4 * SUBPROCESS_TIMEOUT);

  /** Once a slice is built, links that would refuse the first build are not read. */
  it("does not check the links again once a slice is built", () => {
    const outcome = runPreflight({
      built: [172],
      statusPages: APPROVED,
      blockedBy: { "173": [{ number: 174, state: "open" }, { number: 99, state: "open" }] },
    });

    expect(outputOf(outcome, "refused")).toBe("false");
    expect(outputOf(outcome, "sub")).toBe("173");
  });

  /** The parent's own blockers still refuse a build, with their own message. */
  it("refuses a parent with an open blocker before it builds", () => {
    const outcome = runPreflight({
      branches: [],
      pulls: BYSTANDERS,
      blockedBy: { [PARENT]: [{ number: 50, state: "open" }] },
    });

    expect(outputOf(outcome, "refused")).toBe("true");
    expect(refusal(outcome)).toContain("It's blocked by #50, which is still open.");
  });

  /**
   * The contract the replay stands on, against the real binary: the flags
   * parse and every `--json` field exists, so gh gets as far as the connection
   * to `localhost` and no further. gh checks field names before any request,
   * so a misspelt one is refused here rather than on a PRD.
   */
  it.skipIf(!onPath("gh"))("gh accepts the pr list call the PRD PR lookup composes", () => {
    const run = preflight().run ?? "";
    const call = 'gh pr list --state open --head "$prd_branch" --limit 100 --json number,headRefOid,isDraft,labels,body';

    expect(run).toContain(call);

    const attempt = spawnSync(
      "gh",
      [...call.replace('"$prd_branch"', PRD_BRANCH).split(" ").slice(1), "--jq", "."],
      {
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT,
        env: { ...process.env, GH_TOKEN: "test-token", GH_HOST: "localhost", GH_REPO },
      },
    );

    expect(attempt.status).not.toBe(0);
    expect(attempt.stderr).not.toContain("unknown flag");
    expect(attempt.stderr).not.toContain("Unknown JSON field");
    expect(attempt.stderr).toContain("connection refused");
  });
});

const prWrites = (outcome: Outcome): string[][] => writes(outcome).filter((argv) => argv[0] === "pr");

const runPrdPr = (pulls: readonly Record<string, unknown>[], states?: readonly string[]): Outcome =>
  runStep("prd_pr", { pulls, ...(states === undefined ? {} : { issue: issue(states) }), env: { PRD_BRANCH, HAS_PAT: "true" } });

/**
 * The PRD PR: opened as a draft by the run that builds the first slice, found
 * by its **head** by every run after.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd's PRD PR, executed", () => {
  it("opens it as a draft from the PRD branch into the base", () => {
    const outcome = runPrdPr(BYSTANDERS);
    const creates = prWrites(outcome).filter((argv) => argv[1] === "create");

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.slice(0, 7)).toEqual(["pr", "create", "--draft", "--base", "main", "--head", PRD_BRANCH]);
    expect(outcome.output).toContain("number=300\n");
  });

  /**
   * The frame, byte for byte: the `Closes` block first, closing the parent and
   * every open sub-issue when the PRD PR merges, and nothing before; a closed
   * sub-issue gets no line. Then the progress list, which a run that built
   * nothing has none of and says when it is written, the note and the
   * unwritten summary.
   */
  it("writes the Closes block with the parent and every open sub-issue", () => {
    const outcome = runPrdPr(BYSTANDERS, ["OPEN", "CLOSED", "OPEN", "OPEN"]);

    expect(outcome.temp("prd-pr-body.md")).toBe(
      [
        "<!-- agent:closes -->",
        `Closes #${PARENT}`,
        "Closes #172",
        "Closes #174",
        "Closes #175",
        "<!-- /agent:closes -->",
        "",
        PROGRESS_START,
        "_The progress list is written when this slice's review round ends._",
        PROGRESS_END,
        "",
        "> [!NOTE]",
        `> The agent loop builds PRD #${PARENT} here, one sub-issue at a time, and reviews each on this PR before starting the next. It stays a draft until every slice is done. Don't merge it before then. Add your own notes outside the blocks the loop writes; it never edits them.`,
        "",
        SUMMARY_START,
        "_The final review will summarize the whole PRD here._",
        SUMMARY_END,
        "",
      ].join("\n"),
    );
  });

  /**
   * A build run opens the PRD PR with the progress list its runner rendered,
   * this slice in review, as it stands between the `Closes` block and the
   * note.
   */
  it("opens it with the progress list the runner rendered", () => {
    const list = renderProgressList({
      subIssues: [{ number: 172, title: "Slice 1", state: "OPEN" }],
      ranges: sliceRanges([{ sha: "a", parents: ["b"], slice: 172 }], [{ number: 172, state: "OPEN" }]),
      verdict: "none",
      running: { kind: "review" },
      finalReview: "not requested",
    });
    const outcome = runStep("prd_pr", {
      pulls: BYSTANDERS,
      env: { PRD_BRANCH, HAS_PAT: "true" },
      files: { "progress.md": list },
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.temp("prd-pr-body.md")).toContain(`<!-- /agent:closes -->\n\n${list}\n\n> [!NOTE]`);
  });

  it("reuses the PRD PR a run before it opened, rather than a second", () => {
    const outcome = runPrdPr([...BYSTANDERS, PRD_PR]);

    expect(outcome.status).toBe(0);
    expect(prWrites(outcome)).toEqual([]);
    expect(outcome.output).toContain("number=201\n");
  });

  it("refuses to guess between two open PRs from the PRD branch", () => {
    const outcome = runPrdPr([...BYSTANDERS, PRD_PR, pull(205, PRD_BRANCH, "release")]);

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("#201, #205");
    expect(prWrites(outcome)).toEqual([]);
  });
});

const RUN_URL = "https://github.com/acme/widgets/actions/runs/4242";
const REVIEW_URL = "https://github.com/acme/widgets/pull/201#pullrequestreview-123";

/** Every comment a step posted, as `[issue, body]`. */
const comments = (outcome: Outcome): [string, string][] =>
  writes(outcome)
    .filter((argv) => argv[0] === "issue" && argv[1] === "comment")
    .map((argv) => [argv[2] ?? "", argv.at(-1) ?? ""]);

/**
 * Progress without labels (#246): a build run says on the sub-issue it starts
 * and on the parent that it started, and the run past an approval notes the
 * approved slice on its sub-issue. Executed, against the same replay.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd's progress comments, executed", () => {
  /**
   * The slice the approval is for is the current one, the last sub-issue in
   * the list with a slice range, whatever is closed: the one the note goes on.
   */
  it("hands the approved slice, its head and its review to the steps after the gate", () => {
    const statusPages = [
      {
        state: "success",
        total_count: 1,
        statuses: [
          { context: "agent-review", state: "success", description: VERDICTS["approval recommended"].description, target_url: REVIEW_URL },
        ],
      },
    ];
    const outcome = runPreflight({ issue: issue(["CLOSED", "OPEN", "OPEN"]), built: [172, 173], statusPages });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outputOf(outcome, "approved_sub")).toBe("173");
    expect(outputOf(outcome, "approved_sha")).toBe("sha-of-201");
    expect(outputOf(outcome, "approved_review")).toBe(REVIEW_URL);
    expect(outputOf(outcome, "sub")).toBe("174");
    expect(outputOf(outcome, "sub_k")).toBe("3");
    expect(outputOf(outcome, "subs")).toBe("3");
  });

  it("names no approved slice on the first slice, which follows no round", () => {
    const outcome = runPreflight();

    expect(outputOf(outcome, "sub")).toBe("172");
    expect(outputOf(outcome, "sub_k")).toBe("1");
    expect(outputOf(outcome, "approved_sub")).toBe("");
  });

  const START = {
    SUB: "173",
    SUB_TITLE: "Slice 2",
    SUB_K: "2",
    SUBS: "3",
    PRD_BRANCH,
    BUILD: "true",
    FINISHING: "false",
    RUN_URL,
  };

  it("posts the start comment on the sub-issue a build run starts, and a one-line note on the parent", () => {
    const outcome = runStep("start", { env: START });
    const posted = comments(outcome);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(posted.map(([n]) => n)).toEqual([PARENT, "173"]);
    expect(posted[0]?.[1]).toBe(
      `**\`agent:implement\` started:** Building sub-issue #173 (Slice 2) on the PRD branch. [Workflow run](${RUN_URL})`,
    );
    expect(posted[0]?.[1]).not.toContain("\n");
    expect(posted[1]?.[1]).toBe(
      `**\`agent:implement\` started building this sub-issue**, slice 2 of 3 of PRD #${PARENT}, on the PRD branch \`${PRD_BRANCH}\`. [Workflow run](${RUN_URL})`,
    );
  });

  it("comments on no sub-issue on a run that builds none", () => {
    const outcome = runStep("start", { env: { ...START, SUB: "", SUB_K: "", BUILD: "false", FINISHING: "true" } });

    expect(comments(outcome).map(([n]) => n)).toEqual([PARENT]);
  });

  it("goes on with a warning where neither start comment can be posted", () => {
    const outcome = runStep("start", { env: { ...START, GH_REPLAY_COMMENT_FAILURE: "1" } });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.stdout).toContain(`::warning::Could not post the start comment on #${PARENT}.`);
    expect(outcome.stdout).toContain("::warning::Could not post the start comment on sub-issue #173.");
  });

  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const NOTE = { APPROVED_SUB: "173", APPROVED_SHA: HEAD, APPROVED_REVIEW: REVIEW_URL, PRD_PR: "201", SERVER_URL: "https://github.com" };
  /** An approving review's body, its #214 record rendered as the review renders it. */
  const reviewBody = (criteria: readonly CriterionResult[]): string =>
    ["## Agent review", "", "Approved.", "", renderCriteriaGroup(criteria) ?? "", "", "Footer."].join("\n");

  it("notes the approved slice on its sub-issue, with the criteria the approving round changed or left unmet", () => {
    const outcome = runStep("approved_note", {
      env: NOTE,
      reviews: {
        "123": {
          body: reviewBody([
            { id: "C1", text: "It renders every state.", status: "met" },
            { id: "C2", text: "It survives the splice.", status: "changed", reason: "the splice moved" },
            { id: "C3", text: "No label is added.", status: "unmet" },
          ]),
        },
      },
    });
    const posted = comments(outcome);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.[0]).toBe("173");
    expect(posted[0]?.[1]).toBe(
      [
        `**Slice approved:** built in [\`0123456\`](https://github.com/${GH_REPO}/commit/${HEAD}), [reviewed](${REVIEW_URL}) on PRD PR #201. This sub-issue stays open until the PRD PR merges.`,
        "",
        "**Acceptance criteria changed or unmet:**",
        "",
        "- **Changed:** It survives the splice. · the splice moved",
        "- **Unmet:** No label is added.",
        "",
        `<!-- agent:slice-approved ${HEAD} -->`,
      ].join("\n"),
    );
  });

  /** A retry past the same approval, after a run that failed, posts no second note. */
  it("notes an approved head once", () => {
    const outcome = runStep("approved_note", {
      env: NOTE,
      comments: { "173": [{ body: "Started." }, { body: `**Slice approved:** …\n\n<!-- agent:slice-approved ${HEAD} -->` }] },
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(comments(outcome)).toEqual([]);
    expect(outcome.stdout).toContain("already has its approved-slice note");
  });

  it("says none changed or went unmet where the approving round met every criterion", () => {
    const outcome = runStep("approved_note", {
      env: NOTE,
      reviews: { "123": { body: reviewBody([{ id: "C1", text: "It renders every state.", status: "met" }]) } },
    });

    expect(comments(outcome)[0]?.[1]).toContain("\n\n**Acceptance criteria changed or unmet:** none.\n\n<!-- agent:slice-approved");
  });

  it("still notes the slice, saying so, where the approving review cannot be read", () => {
    const outcome = runStep("approved_note", { env: NOTE });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.stdout).toContain("::warning::Could not read the review that approved sub-issue #173");
    expect(comments(outcome)[0]?.[1]).toContain("the approving review couldn't be read");
  });

  it("goes on with a warning where the note cannot be posted", () => {
    const outcome = runStep("approved_note", { env: { ...NOTE, GH_REPLAY_COMMENT_FAILURE: "1" } });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.stdout).toContain("::warning::Could not post the approved-slice note on sub-issue #173.");
  });
});

/** The handover, handed PRD PR #201 and how many slices landed, as the finishing run has them. */
const runHandover = (landed: number, options: { readonly body?: string; readonly pat?: boolean } = {}): Outcome =>
  runStep("handover", {
    pulls: [...BYSTANDERS, { ...PRD_PR, body: options.body ?? "Closes #171" }],
    env: { PRD_PR: "201", LANDED: String(landed), HAS_PAT: String(options.pat ?? true) },
  });

/**
 * The finishing run's handover, executed. One slice was reviewed as the whole
 * PRD PR already, so it is marked ready and no review is asked for. More than
 * one asks for the final review: recorded in the body first, then
 * `agent:review`.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd's handover, executed", () => {
  it("runs under the shell the workflow actually gets", () => {
    expect(stepById("handover").shell).toBeUndefined();
  });

  it("marks the PRD PR of a one-slice PRD ready itself, and asks for no review", () => {
    const outcome = runHandover(1);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(prWrites(outcome)).toEqual([["pr", "ready", "201"]]);
    expect(writes(outcome).some((argv) => argv.includes("agent:review"))).toBe(false);
  });

  it("records the final review in the body, then asks for it, on a PRD of more than one slice", () => {
    const outcome = runHandover(3);
    const all = writes(outcome);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(all[0]?.slice(0, 4)).toEqual(["api", "-X", "PATCH", `repos/${GH_REPO}/pulls/201`]);
    expect(all[0]?.at(-1)).toBe(`body=Closes #171\n\n${FINAL_REVIEW}`);
    expect(prWrites(outcome)).toEqual([
      ["pr", "edit", "201", "--remove-label", "agent:review"],
      ["pr", "edit", "201", "--add-label", "agent:review"],
    ]);
    expect(prWrites(outcome).some((argv) => argv[1] === "ready")).toBe(false);
  });

  /**
   * The mark goes into the progress list (#246), with the final review shown
   * in review: what the list rendered for the final review requested is, byte
   * for byte, the one the last slice's round left with the lines written in
   * front of its end marker. The handover runs no toolchain, so this is how
   * it re-renders.
   */
  it("records the final review in the progress list as the list renders it", () => {
    const subIssues = [
      { number: 172, title: "Slice 1", state: "OPEN" as const },
      { number: 173, title: "Slice 2", state: "OPEN" as const },
    ];
    const ranges = sliceRanges(
      [
        { sha: "c", parents: ["b"], slice: 173 },
        { sha: "b", parents: ["a"], slice: 172 },
      ],
      subIssues,
    );
    const approved = renderProgressList({ subIssues, ranges, verdict: "approval", running: null, finalReview: "not requested" });
    const requested = renderProgressList({
      subIssues,
      ranges,
      verdict: "approval",
      running: { kind: "review" },
      finalReview: "requested",
    });
    const body = (list: string): string => `<!-- agent:closes -->\nCloses #171\n<!-- /agent:closes -->\n\n${list}\n\nMine.`;
    const outcome = runHandover(2, { body: body(approved) });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(writes(outcome)[0]?.at(-1)).toBe(`body=${body(requested)}`);
    expect(requested).toContain(FINAL_REVIEW);
    expect(FINAL_REVIEW_REQUESTED_LINES).toContain(FINAL_REVIEW_MARK);
  });

  /** A retry finds the record a run before it wrote, and writes it once. */
  it("does not record the final review twice", () => {
    const outcome = runHandover(2, { body: `Closes #171\n\n${FINAL_REVIEW}` });

    expect(writes(outcome).some((argv) => argv[2] === "PATCH")).toBe(false);
    expect(prWrites(outcome)).toHaveLength(2);
  });

  /**
   * The mark is what the preflight reads "finished" by, so a label that did
   * not go on takes it back out: left in, the retry the failure comment
   * offers would be refused as finished, and no final review would ever run.
   */
  it("takes the final-review mark back out when the label does not go on", () => {
    const outcome = runStep("handover", {
      pulls: [...BYSTANDERS, { ...PRD_PR, body: "Closes #171" }],
      env: { PRD_PR: "201", LANDED: "3", HAS_PAT: "true", GH_REPLAY_LABEL_FAILURE: "1" },
    });
    const all = writes(outcome);
    const added = all.findIndex((argv) => argv.includes("--add-label"));
    const restored = all.findIndex((argv, i) => i > added && argv[2] === "PATCH");

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("so its final review was not requested. Trying again resumes the handover");
    expect(all.filter((argv) => argv[2] === "PATCH").map((argv) => argv.at(-1))).toEqual([
      `body=Closes #171\n\n${FINAL_REVIEW}`,
      "body=Closes #171",
    ]);
    expect(added).toBeGreaterThan(0);
    expect(restored).toBeGreaterThan(added);
  });

  it("refuses without AGENT_PAT rather than add a label that starts nothing, touching nothing", () => {
    const outcome = runHandover(2, { pat: false });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("PRD PR #201");
    expect(outcome.reason).toContain("AGENT_PAT");
    expect(outcome.reason).toContain("resumes the handover");
    expect(outcome.writes).toEqual([]);
  });

  it("never merges the PRD PR, and never approves", () => {
    const run = stepById("handover").run ?? "";

    expect(run).not.toContain("gh pr merge");
    expect(run).not.toMatch(/gh pr review|--approve/);
  });
});

/**
 * The contract the replay stands on for the steps above, against the real
 * binary, the way the preflight's `pr list` is checked.
 */
describe.skipIf(!onPath("gh"))("gh accepts the calls the PRD PR and handover steps compose", () => {
  const attempt = (args: readonly string[]): ReturnType<typeof spawnSync> =>
    spawnSync("gh", [...args], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
      env: { ...process.env, GH_TOKEN: "test-token", GH_HOST: "localhost", GH_REPO },
    });

  it.each([
    ["pr list --head", ["pr", "list", "--state", "open", "--head", PRD_BRANCH, "--limit", "100", "--json", "number"]],
    ["pr view --json body", ["pr", "view", "201", "--json", "body", "--jq", ".body"]],
    ["api -X PATCH pulls", ["api", "-X", "PATCH", `repos/${GH_REPO}/pulls/201`, "-f", "body=x"]],
    ["pr edit --remove-label", ["pr", "edit", "201", "--remove-label", "agent:review"]],
    ["pr edit --add-label", ["pr", "edit", "201", "--add-label", "agent:review"]],
    ["pr ready", ["pr", "ready", "201"]],
  ])("%s", (_name: string, args: readonly string[]) => {
    expect(stepById("prd_pr").run ?? "").toContain(
      'gh pr list --state open --head "$PRD_BRANCH" --limit 100 --json number',
    );
    expect(stepById("handover").run ?? "").toContain('gh pr view "$PRD_PR" --json body --jq \'.body\'');

    const result = attempt(args);

    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).not.toContain("unknown flag");
    expect(String(result.stderr)).not.toContain("Unknown JSON field");
    expect(String(result.stderr)).toContain("connection refused");
  });
});
