import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  finalReviewRequestedLines,
  renderPrdStatus,
  renderProgressList,
  statusBlock,
  type ProgressInputs,
} from "../shared/progress-list.js";
import { renderCriteriaGroup, type CriterionResult } from "../shared/review-output.js";
import { sliceRanges } from "../shared/slice-ranges.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";
import {
  DRAFT_NOTE_END,
  DRAFT_NOTE_START,
  FINAL_REVIEW_MARK,
  PROGRESS_END,
  PROGRESS_START,
  STATUS_END,
  STATUS_START,
  SUMMARY_END,
  SUMMARY_START,
} from "../shared/record.js";

/**
 * Runs `implement-prd`'s shell steps (the real `run:` blocks, read out of
 * `.github/workflows/implement-prd.yml`) under `bash -e` against the recorded
 * `gh` in `tests/fixtures/gh-replay`, the seam the review's CI-wait test built
 * before that step became `review:collect-checks` (#421), for this reason: a
 * string assertion passes on a step `gh` refuses (#28).
 *
 * What it executes is the note on the approved slice, the step that opens or
 * reuses the PRD PR, and the finishing run's handover of it. The preflight's
 * state table and the start comments are `implement-prd:gate`'s since #498,
 * and are executed in `tests/implement-prd/`.
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
  // Across the run's jobs (#308): the approved note is the gate's, the PRD
  // PR and the handover the publish job's.
  const step = Object.values((parse(fs.readFileSync(PRD, "utf8")) as Workflow).jobs)
    .flatMap((job) => job.steps ?? [])
    .find((s) => s.id === id);

  expect(step).toBeDefined();
  return step as Step;
};

/**
 * Bounded like every spawn here, and the one place it matters most: this runs
 * at module scope, outside any test body, where no `testTimeout` could reach a
 * hang. A killed spawn reports `null`, so an overrun skips the suite rather
 * than stalling the run.
 */
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
  // The snapshot the gate leaves for the steps after it, as a run that got
  // past the gate has it.
  fs.writeFileSync(path.join(temp, "prd-issue.json"), JSON.stringify(scenario.issue ?? issue()));
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

/** Every write, as the argv `gh` was called with. */
const writes = (outcome: Outcome): string[][] => outcome.writes.map((line) => JSON.parse(line) as string[]);

const prWrites = (outcome: Outcome): string[][] => writes(outcome).filter((argv) => argv[0] === "pr");

const runPrdPr = (pulls: readonly Record<string, unknown>[], states?: readonly string[]): Outcome =>
  runStep("prd_pr", {
    pulls,
    ...(states === undefined ? {} : { issue: issue(states) }),
    env: { PRD_BRANCH, TOKEN_SOURCE: "pat", SUB: "", SUB_K: "", SUBS: "3" },
  });

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
   * The frame, byte for byte, in the order #298 settled: the note, opening
   * with the status line; the summary; the progress table, which a run that
   * built nothing has none of and says when it is written; and the `Closes`
   * line at the bottom, closing the parent and every open sub-issue when the
   * PRD PR merges, and nothing before. A closed sub-issue gets no reference.
   */
  it("writes the note, the summary, the table and the Closes line with the parent and every open sub-issue", () => {
    const outcome = runPrdPr(BYSTANDERS, ["OPEN", "CLOSED", "OPEN", "OPEN"]);

    expect(outcome.temp("prd-pr-body.md")).toBe(
      [
        "> [!NOTE]",
        `> ${STATUS_START}`,
        "> **🔍 In review:** the slices built so far.",
        `> ${STATUS_END}`,
        ">",
        `> ${DRAFT_NOTE_START}The agent loop builds PRD #${PARENT} here, one sub-issue at a time, and reviews each on this PR before starting the next. It stays a draft until every slice is done. Don't merge it before then.${DRAFT_NOTE_END} Built by the agent loop from PRD #${PARENT}, one sub-issue per slice. Comment here to steer it; your notes outside the loop's blocks are never edited.`,
        "",
        "---",
        "",
        "## Summary",
        "",
        SUMMARY_START,
        "_The final review will summarize the whole PRD here._",
        SUMMARY_END,
        "",
        "---",
        "",
        PROGRESS_START,
        "_The progress table is written when this slice's review round ends._",
        PROGRESS_END,
        "",
        "<!-- agent:closes -->",
        `Closes #${PARENT}, closes #172, closes #174, closes #175`,
        "<!-- /agent:closes -->",
        "",
      ].join("\n"),
    );
  });

  /**
   * A build run opens the PRD PR with the table and the status line its
   * runner rendered, this slice in review, and the slice's chapter marker.
   */
  it("opens it with the progress table and status line the runner rendered, and the slice's chapter marker", () => {
    const inputs: ProgressInputs = {
      subIssues: [{ number: 172, state: "OPEN" }],
      ranges: sliceRanges([{ sha: "a", parents: ["b"], slice: 172 }], [{ number: 172, state: "OPEN" }]),
      verdict: "none",
      running: { kind: "review" },
      finalReview: "not requested",
    };
    const list = renderProgressList(inputs);
    const status = statusBlock(renderPrdStatus(inputs));
    const outcome = runStep("prd_pr", {
      pulls: BYSTANDERS,
      env: { PRD_BRANCH, TOKEN_SOURCE: "pat", SUB: "172", SUB_K: "1", SUBS: "3" },
      files: { "progress.md": list, "status.md": status },
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.temp("prd-pr-body.md")).toContain(`> [!NOTE]\n> ${status}\n>\n`);
    expect(outcome.temp("prd-pr-body.md")).toContain(`${SUMMARY_END}\n\n---\n\n${list}\n\n<!-- agent:closes -->`);
    expect(prWrites(outcome).at(-1)).toEqual(["pr", "comment", "300", "--body", "**Slice 1 of 3 · #172 started**"]);
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
 * Progress without labels (#246): the run past an approval notes the approved
 * slice on its sub-issue. Executed, against the same replay. The start
 * comments are `implement-prd:gate`'s since #498, in
 * `tests/implement-prd/gate.test.ts`.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd's progress comments, executed", () => {
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
/** What the handover reads besides the scenario: its PRD PR, the server, and the run it links. */
const HANDOVER_ENV = {
  PRD_PR: "201",
  SERVER_URL: "https://github.com",
  RUN_URL: "https://github.com/acme/widgets/actions/runs/7",
};

/** Which token the loop's resolver chose (#319): `app` and `pat` fire events, `workflow` does not. */
type TokenSource = "app" | "pat" | "workflow";

const runHandover = (landed: number, options: { readonly body?: string; readonly source?: TokenSource } = {}): Outcome =>
  runStep("handover", {
    pulls: [...BYSTANDERS, { ...PRD_PR, body: options.body ?? "Closes #171" }],
    env: { ...HANDOVER_ENV, LANDED: String(landed), SUBS: String(landed), TOKEN_SOURCE: options.source ?? "pat" },
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
      ["pr", "comment", "201", "--body", `**Final review of all 3 slices started** · [Workflow run](${HANDOVER_ENV.RUN_URL})`],
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
  it("records the final review in the progress table and the status line as they render it", () => {
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
    const prUrl = `https://github.com/${GH_REPO}/pull/201`;
    const rounds = {
      slices: { 172: { reviews: 1, fixes: 0 }, 173: { reviews: 2, fixes: 1 } },
      final: { reviews: 0, fixes: 0 },
      all: { reviews: 3, fixes: 1 },
    };
    const approved: ProgressInputs = { subIssues, ranges, verdict: "approval", running: null, finalReview: "not requested", prUrl, rounds };
    const requested: ProgressInputs = { ...approved, running: { kind: "review" }, finalReview: "requested" };
    const body = (inputs: ProgressInputs): string =>
      `> [!NOTE]\n> ${statusBlock(renderPrdStatus(inputs))}\n\n${renderProgressList(inputs)}\n\nMine.`;
    const outcome = runStep("handover", {
      pulls: [...BYSTANDERS, { ...PRD_PR, body: body(approved) }],
      env: { ...HANDOVER_ENV, LANDED: "2", SUBS: "2", TOKEN_SOURCE: "pat" },
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(writes(outcome)[0]?.at(-1)).toBe(`body=${body(requested)}`);
    expect(renderProgressList(requested)).toContain(FINAL_REVIEW);
    expect(finalReviewRequestedLines(prUrl)).toContain(FINAL_REVIEW_MARK);
  });

  /** Its start comment goes on the PRD PR, with the run's link, since no sub-issue holds one. */
  it("posts the final review's start comment on the PRD PR, with its link", () => {
    const outcome = runStep("handover", {
      pulls: [...BYSTANDERS, { ...PRD_PR, body: "Closes #171" }],
      env: { ...HANDOVER_ENV, LANDED: "3", SUBS: "3", TOKEN_SOURCE: "pat" },
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(prWrites(outcome).at(-1)).toEqual([
      "pr",
      "comment",
      "201",
      "--body",
      "**Final review of all 3 slices started** · [Workflow run](https://github.com/acme/widgets/actions/runs/7)",
    ]);
  });

  /** A retry finds the record a run before it wrote, and writes it once. */
  it("does not record the final review twice", () => {
    const outcome = runHandover(2, { body: `Closes #171\n\n${FINAL_REVIEW}` });

    expect(writes(outcome).some((argv) => argv[2] === "PATCH")).toBe(false);
    expect(prWrites(outcome).filter((argv) => argv[1] === "edit")).toHaveLength(2);
  });

  /**
   * The mark is what `implement-prd:gate` reads "finished" by, so a label
   * that did not go on takes it back out: left in, the retry the failure comment
   * offers would be refused as finished, and no final review would ever run.
   */
  it("takes the final-review mark back out when the label does not go on", () => {
    const outcome = runStep("handover", {
      pulls: [...BYSTANDERS, { ...PRD_PR, body: "Closes #171" }],
      env: { ...HANDOVER_ENV, LANDED: "3", SUBS: "3", TOKEN_SOURCE: "pat", GH_REPLAY_LABEL_FAILURE: "1" },
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

  it("refuses on the workflow token rather than add a label that starts nothing, touching nothing", () => {
    const outcome = runHandover(2, { source: "workflow" });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("PRD PR #201");
    expect(outcome.reason).toContain("AGENT_PAT");
    expect(outcome.reason).toContain("resumes the handover");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * The App's token fires events as the PAT does, so it hands over the same
   * way (#319). A source the resolver never reported, an empty one from a
   * step that did not run among them, is read as the workflow token.
   */
  it("hands over on the loop's App's token, and refuses on a source it does not know", () => {
    const app = runHandover(1, { source: "app" });
    const unknown = runStep("handover", {
      pulls: [...BYSTANDERS, { ...PRD_PR, body: "Closes #171" }],
      env: { ...HANDOVER_ENV, LANDED: "1", SUBS: "1", TOKEN_SOURCE: "" },
    });

    expect(app.status, app.stdout).toBe(0);
    expect(prWrites(app)).toEqual([["pr", "ready", "201"]]);
    expect(unknown.status).toBe(1);
    expect(unknown.writes).toEqual([]);
  });

  it("never merges the PRD PR, and never approves", () => {
    const run = stepById("handover").run ?? "";

    expect(run).not.toContain("gh pr merge");
    expect(run).not.toMatch(/gh pr review|--approve/);
  });
});

/**
 * The contract the replay stands on for the steps above, against the real
 * binary: the flags parse and every `--json` field exists.
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
