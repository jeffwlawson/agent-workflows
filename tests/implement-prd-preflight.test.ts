import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs `implement-prd`'s preflight — the real `run:` block, read out of
 * `.github/workflows/implement-prd.yml` — under `bash -e` against the recorded
 * `gh` in `tests/fixtures/gh-replay`, the seam `tests/review-ci-wait.test.ts`
 * built for the same reason: a string assertion passes on a step `gh` refuses
 * (#28).
 *
 * What it executes is the slice PR lookup (#172). Open slice PRs are found by
 * their **base**, the PRD branch, and the outcomes are different runs: none
 * builds the next slice, one is merged and then the next slice built on it
 * (#173) — or, with no sub-issue left, stops and names it — and more than one
 * stops and names them all. A stop fails into `Mark blocked on failure` with a
 * reason file, so what is asserted is the reason file, the exit, and that the
 * step itself touched nothing on the tracker.
 *
 * And the steps that come after it (#173): `Merge slice PR`, the step that
 * gathers the merged slice's row of the slices table (#174), and the step that
 * opens or reuses the PRD PR once a slice has merged — executed the same way,
 * against the same replay.
 *
 * Skipped where `bash`, `jq` or `node` are not on PATH, as that file is.
 */

const PRD = path.join(".github", "workflows", "implement-prd.yml");
const REPLAY_DIR = path.join("tests", "fixtures", "gh-replay");

interface Step {
  readonly id?: string;
  readonly shell?: string;
  readonly run?: string;
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
const PRD_BRANCH = "agent/prd-171-slice-prs";

/** A PRD with its first sub-issue built and the next two still open. */
const issue = (states: readonly string[] = ["CLOSED", "OPEN", "OPEN"]): Record<string, unknown> => ({
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
  state = "OPEN",
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  number,
  headRefName,
  baseRefName,
  state,
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: `sha-of-${number}`,
  labels: [],
  ...extra,
});

/**
 * What the preflight must look past: an ordinary PR into the base branch, the
 * PRD PR itself (whose *head* is the PRD branch), a merged slice PR, and an
 * open slice PR of PRD #1710 — whose branch starts with this one's number, and
 * is kept out only by the dash after it.
 */
const BYSTANDERS = [
  pull(200, "agent/issue-9-typo", "main"),
  pull(201, PRD_BRANCH, "main"),
  pull(202, "agent/slice-171-172-slice-1", PRD_BRANCH, "MERGED"),
  pull(203, "agent/slice-1710-1711-other", "agent/prd-1710-other"),
];

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly output: string;
  readonly reason: string;
  readonly writes: readonly string[];
}

interface StepOutcome extends Outcome {
  /** A file the step wrote under `RUNNER_TEMP`, or "" if it wrote none. */
  readonly temp: (name: string) => string;
}

const runStep = (
  id: string,
  options: {
    readonly pulls: readonly Record<string, unknown>[];
    readonly issue?: Record<string, unknown>;
    readonly repo?: Record<string, unknown>;
    /** The slice PR's review thread nodes, as the GraphQL read returns them. */
    readonly threads?: readonly Record<string, unknown>[];
    /** The combined-status pages on the slice PR's head. */
    readonly statusPages?: readonly Record<string, unknown>[];
    /** The step's own `env:`, supplied in the expressions' place. */
    readonly env?: Record<string, string>;
  },
): StepOutcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-implement-prd-"));
  const script = path.join(temp, "step.sh");
  const issueFile = path.join(temp, "issue.json");
  const pullsFile = path.join(temp, "pulls.json");
  const repoFile = path.join(temp, "repo.json");
  const threadsFile = path.join(temp, "threads.json");
  const statusFile = path.join(temp, "status.json");
  const output = path.join(temp, "output");
  const log = path.join(temp, "writes.log");

  fs.writeFileSync(script, stepById(id).run ?? "");
  fs.writeFileSync(issueFile, JSON.stringify(options.issue ?? issue()));
  fs.writeFileSync(pullsFile, JSON.stringify(options.pulls));
  fs.writeFileSync(repoFile, JSON.stringify(options.repo ?? {}));
  fs.writeFileSync(threadsFile, JSON.stringify(options.threads ?? []));
  fs.writeFileSync(statusFile, JSON.stringify(options.statusPages ?? [{ state: "pending", total_count: 0, statuses: [] }]));
  // The snapshot the preflight leaves for the steps after it, as a run that
  // got past the preflight has it.
  if (id !== "preflight") fs.writeFileSync(path.join(temp, "prd-issue.json"), JSON.stringify(options.issue ?? issue()));
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
      ISSUE_TITLE: "Slice PRs into a PRD branch",
      ISSUE_STATE: "open",
      BASE_REF: "main",
      GH_REPO,
      GH_TOKEN: "test-token",
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      GH_REPLAY_ISSUE: issueFile,
      GH_REPLAY_PULLS: pullsFile,
      GH_REPLAY_REPO: repoFile,
      GH_REPLAY_THREADS: threadsFile,
      GH_REPLAY_STATUS_PAGES: statusFile,
      GH_REPLAY_LOG: log,
      PATH: `${ghDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      ...options.env,
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

const runPreflight = (options: {
  readonly pulls: readonly Record<string, unknown>[];
  readonly issue?: Record<string, unknown>;
}): Outcome => runStep("preflight", options);

describe.skipIf(!CAN_RUN)("agent-implement-prd's preflight, executed", () => {
  it("runs under the shell the workflow actually gets", () => {
    expect(preflight().shell).toBeUndefined();
  });

  it("builds the next slice when no slice PR is open against the PRD branch", () => {
    const outcome = runPreflight({ pulls: BYSTANDERS });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("sub=173\n");
    expect(outcome.output).toContain("refused=false\n");
    expect(outcome.reason).toBe("");
    expect(outcome.writes).toEqual([]);
  });

  /** What `Merge slice PR` titles the slices table's rows from (#174). */
  it("leaves its snapshot of the PRD for the steps after it", () => {
    const outcome = runStep("preflight", { pulls: BYSTANDERS });

    expect(JSON.parse(outcome.temp("prd-issue.json"))).toEqual(issue());
  });

  it("hands no slice PR to the merge step when none is open", () => {
    expect(runPreflight({ pulls: BYSTANDERS }).output).toContain("slice_pr=\n");
  });

  /**
   * One open slice PR with a sub-issue left is the chain mid-flight: the run
   * merges it and builds the next slice (#173). By base, never by name — the
   * slice branch here was renamed away from `agent/slice-`, and it is still
   * the slice PR the merge step is handed.
   */
  it("hands one open slice PR to the merge step and builds the next slice, whatever its branch is called", () => {
    const outcome = runPreflight({ pulls: [...BYSTANDERS, pull(210, "renamed-by-hand", PRD_BRANCH)] });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("slice_pr=210\n");
    expect(outcome.output).toContain("sub=173\n");
    expect(outcome.output).toContain("refused=false\n");
    expect(outcome.reason).toBe("");
    expect(outcome.writes).toEqual([]);
  });

  it("stops on more than one open slice PR, naming every one", () => {
    const outcome = runPreflight({
      pulls: [
        ...BYSTANDERS,
        pull(210, "agent/slice-171-173-slice-2", PRD_BRANCH),
        pull(211, "agent/slice-171-174-slice-3", PRD_BRANCH),
      ],
    });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("2 slice PRs are open");
    expect(outcome.reason).toContain("#210 (`agent/slice-171-173-slice-2`");
    expect(outcome.reason).toContain("#211 (`agent/slice-171-174-slice-3`");
    expect(outcome.reason).toMatch(/will not guess/);
    expect(outcome.output).not.toContain("refused=");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * The last slice PR still open is a PRD waiting on it, not a finished one:
   * the lookup sits before the finished refusal, which would otherwise tell a
   * human there is nothing left to do. Merging it is the finishing run's, which
   * does not exist yet, so this run stops and names it rather than merge it.
   */
  it("stops on the last slice PR rather than calling the PRD finished", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED"]),
      pulls: [...BYSTANDERS, pull(212, "agent/slice-171-174-slice-3", PRD_BRANCH)],
    });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("slice PR #212");
    expect(outcome.reason).toMatch(/merge it into the PRD branch by hand/);
    expect(outcome.reason).not.toContain("finished");
    expect(outcome.stdout).toContain("::error::Refused to run: slice PR #212");
    // Not a refusal: `Mark blocked on failure` is gated on `refused != 'true'`,
    // and it is what gives the parent `agent:blocked` and the comment.
    expect(outcome.output).not.toContain("refused=");
    expect(outcome.output).not.toContain("sub=");
    expect(outcome.writes).toEqual([]);
  });

  /** …and with nothing open anywhere, it is finished, refused as before. */
  it("refuses a PRD with no open sub-issue and no open slice PR as finished", () => {
    const outcome = runPreflight({ issue: issue(["CLOSED", "CLOSED", "CLOSED"]), pulls: BYSTANDERS });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("refused=true\n");
    expect(outcome.reason).toBe("");
    expect(outcome.writes.some((w) => w.includes('"comment"') && w.includes("the PRD is finished"))).toBe(true);
  });

  /**
   * The contract the `pr list` replay stands on, against the real binary: the
   * flags parse and every `--json` field exists, so gh gets as far as the
   * connection to `localhost` and no further. gh checks field names before any
   * request, so a misspelt one is refused here rather than on a PRD.
   */
  it.skipIf(!onPath("gh"))("gh accepts the pr list call the lookup composes", () => {
    const run = preflight().run ?? "";
    const call = "gh pr list --state open --limit 1000 --json number,headRefName,baseRefName";

    expect(run).toContain(call);

    const attempt = spawnSync("gh", [...call.split(" ").slice(1), "--jq", "."], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
      env: { ...process.env, GH_TOKEN: "test-token", GH_HOST: "localhost", GH_REPO },
    });

    expect(attempt.status).not.toBe(0);
    expect(attempt.stderr).not.toContain("unknown flag");
    expect(attempt.stderr).not.toContain("Unknown JSON field");
    expect(attempt.stderr).toContain("connection refused");
  });
});

/** What the merge step reads the settings from: every method on unless said. */
const REPO = { allow_squash_merge: true, allow_rebase_merge: true, allow_merge_commit: true };

const SLICE = 210;
const SLICE_BRANCH = "agent/slice-171-172-slice-1";

/** The merge step, handed slice PR #210 in the state `extra` describes. */
const runMerge = (
  extra: Record<string, unknown> = {},
  options: { readonly repo?: Record<string, unknown>; readonly pat?: boolean } = {},
): StepOutcome =>
  runStep("merge", {
    pulls: [...BYSTANDERS, pull(SLICE, SLICE_BRANCH, PRD_BRANCH, "OPEN", extra)],
    repo: options.repo ?? REPO,
    env: { SLICE_PR: String(SLICE), HAS_PAT: String(options.pat ?? true) },
  });

/** The pull request writes, as the argv each was made with. */
const prWrites = (outcome: Outcome): string[][] =>
  outcome.writes.map((w) => JSON.parse(w) as string[]).filter((argv) => argv[0] === "pr" || argv[0] === "api");

const merges = (outcome: Outcome): string[][] => prWrites(outcome).filter((argv) => argv[1] === "merge");

/**
 * `Merge slice PR #<n>` (#173), executed. It never reads the verdict; what it
 * rules on is whether the round is still running and whether GitHub can merge
 * the thing at all, and every refusal names the slice PR and fails into `Mark
 * blocked on failure` with a reason file — touching nothing on the way.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd's merge step, executed", () => {
  it("runs under the shell the workflow actually gets", () => {
    expect(stepById("merge").shell).toBeUndefined();
  });

  it.each(["agent:review", "agent:fix", "agent:in-progress"])(
    "refuses while %s is on the slice PR, naming it",
    (label: string) => {
      const outcome = runMerge({ labels: [{ name: "agent:follow-ups" }, { name: label }] });

      expect(outcome.status).toBe(1);
      expect(outcome.reason).toContain(`slice PR #${SLICE}`);
      expect(outcome.reason).toContain(`\`${label}\``);
      expect(outcome.reason).toMatch(/round has not ended/);
      expect(outcome.stdout).toContain(`::error::Refused to merge slice PR #${SLICE}`);
      expect(outcome.writes).toEqual([]);
      expect(outcome.output).not.toContain("merged=");
    },
  );

  /**
   * UNKNOWN — GitHub still computing — is waited on before it lands here, and
   * is not executed: the replay answers the same every time, so that scenario
   * would be half a minute of sleeping to reach this same refusal.
   */
  it("refuses a conflicted slice PR, naming it and pointing at agent:update-branch on it", () => {
    const outcome = runMerge({ mergeable: "CONFLICTING" });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain(`slice PR #${SLICE}`);
    expect(outcome.reason).toContain("conflicting");
    expect(outcome.reason).toContain(`Add \`agent:update-branch\` to slice PR #${SLICE}`);
    expect(outcome.writes).toEqual([]);
  });

  it("refuses a slice PR closed without merging, naming it", () => {
    const outcome = runMerge({ state: "CLOSED" });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain(`slice PR #${SLICE}`);
    expect(outcome.reason).toContain("closed");
    expect(outcome.writes).toEqual([]);
  });

  it.each([
    [REPO, "--squash"],
    [{ ...REPO, allow_squash_merge: false }, "--rebase"],
    [{ ...REPO, allow_squash_merge: false, allow_rebase_merge: false }, "--merge"],
  ])("merges with the first method the repo allows (%j → %s)", (repo: Record<string, unknown>, flag: string) => {
    const outcome = runMerge({}, { repo });

    expect(outcome.status).toBe(0);
    expect(merges(outcome)).toEqual([["pr", "merge", String(SLICE), flag, "--match-head-commit", `sha-of-${SLICE}`]]);
  });

  /** Settings this token cannot read come back absent, which is no method. */
  it("refuses rather than guessing when the repo allows no method it can read", () => {
    const outcome = runMerge({}, { repo: {} });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain(`slice PR #${SLICE}`);
    expect(merges(outcome)).toEqual([]);
  });

  it("pins the merge to the head it inspected", () => {
    const outcome = runMerge({ headRefOid: "0123abc" });

    expect(merges(outcome)[0]).toContain("--match-head-commit");
    expect(merges(outcome)[0]?.at(-1)).toBe("0123abc");
  });

  it("marks a still-draft slice PR ready first", () => {
    const outcome = runMerge({ isDraft: true });
    const verbs = prWrites(outcome).map((argv) => argv[1]);

    expect(outcome.status).toBe(0);
    expect(prWrites(outcome)[0]).toEqual(["pr", "ready", String(SLICE)]);
    expect(verbs.indexOf("ready")).toBeLessThan(verbs.indexOf("merge"));
  });

  it("leaves a slice PR that is already ready alone", () => {
    expect(prWrites(runMerge()).map((argv) => argv[1])).not.toContain("ready");
  });

  it("deletes the slice branch once it has merged, and hands the PRD branch on", () => {
    const outcome = runMerge();
    const writes = prWrites(outcome);

    expect(writes.at(-1)).toEqual(["api", "-X", "DELETE", `repos/${GH_REPO}/git/refs/heads/${SLICE_BRANCH}`]);
    expect(writes.findIndex((argv) => argv[1] === "merge")).toBeLessThan(writes.length - 1);
    expect(outcome.output).toContain(`prd_branch=${PRD_BRANCH}\n`);
    expect(outcome.output).toContain("merged=true\n");
  });

  /** A re-run after a merge that landed merges nothing twice. */
  it("does not merge a slice PR that is already merged, and still carries on", () => {
    const outcome = runMerge({ state: "MERGED" });

    expect(outcome.status).toBe(0);
    expect(merges(outcome)).toEqual([]);
    expect(outcome.output).toContain("merged=true\n");
  });

  it("says nothing about the token when AGENT_PAT merged it", () => {
    expect(runMerge({ labels: [{ name: "agent:follow-ups" }] }).stdout).not.toContain("::warning::AGENT_PAT");
  });

  it("warns on a GITHUB_TOKEN merge that the PRD PR's CI did not run", () => {
    const outcome = runMerge({}, { pat: false });

    expect(outcome.status).toBe(0);
    expect(merges(outcome)).toHaveLength(1);
    expect(outcome.stdout).toContain("::warning::AGENT_PAT is not set");
    expect(outcome.stdout).toContain("the PRD PR's CI did not run");
    expect(outcome.stdout).not.toContain("follow-ups were not filed");
  });

  it("adds, when the slice PR carries agent:follow-ups, that they were not filed and how to file them", () => {
    const outcome = runMerge({ labels: [{ name: "agent:follow-ups" }] }, { pat: false });

    expect(outcome.stdout).toContain("the PRD PR's CI did not run");
    expect(outcome.stdout).toContain("follow-ups were not filed");
    expect(outcome.stdout).toContain(`remove \`agent:follow-ups\` from slice PR #${SLICE} and add it back`);
  });
});

const SLICE_URL = `https://github.com/${GH_REPO}/pull/${SLICE}`;

/** The step after the merge, handed merged slice PR #210 as `extra` describes it. */
const runSliceRow = (
  extra: Record<string, unknown> = {},
  options: {
    readonly issue?: Record<string, unknown>;
    readonly bystanders?: readonly Record<string, unknown>[];
    readonly threads?: readonly Record<string, unknown>[];
    readonly statusPages?: readonly Record<string, unknown>[];
  } = {},
): StepOutcome =>
  runStep("slice_row", {
    pulls: [
      ...(options.bystanders ?? BYSTANDERS),
      pull(SLICE, SLICE_BRANCH, PRD_BRANCH, "MERGED", {
        title: "Slice 1 (#172)",
        body: "Part of #172\n\nOne slice of PRD #171.",
        url: SLICE_URL,
        ...extra,
      }),
    ],
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.threads === undefined ? {} : { threads: options.threads }),
    ...(options.statusPages === undefined ? {} : { statusPages: options.statusPages }),
    env: { SLICE_PR: String(SLICE), PRD_BRANCH },
  });

/** The facts the step left for the slices table, read back. */
const facts = (outcome: StepOutcome): Record<string, unknown> => JSON.parse(outcome.temp("slices-table.json")) as Record<string, unknown>;

const merged = (outcome: StepOutcome): Record<string, unknown> => facts(outcome)["merged"] as Record<string, unknown>;

/** A review thread node, as the GraphQL read returns it. */
const reviewThread = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  isResolved: false,
  path: ".github/workflows/review.yml",
  line: 88,
  originalLine: 80,
  comments: { nodes: [{ url: `${SLICE_URL}#discussion_r1` }] },
  ...over,
});

/**
 * The facts for the merged slice's row of the slices table (#174), gathered
 * through `gh` by the step after the merge and left under `RUNNER_TEMP` for the
 * runner, which renders them into the PRD PR body.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd's slices table row, gathered, executed", () => {
  it("names the sub-issue by its title in the preflight's snapshot, and the slice PR by number and URL", () => {
    const outcome = runSliceRow();

    expect(outcome.status).toBe(0);
    expect(merged(outcome)).toMatchObject({ title: "Slice 1", subIssue: 172, slicePr: SLICE, slicePrUrl: SLICE_URL });
  });

  it("reads the verdict from the agent-review status on the merged head, and only that context", () => {
    const outcome = runSliceRow(
      {},
      {
        statusPages: [
          {
            state: "failure",
            total_count: 2,
            statuses: [
              { context: "ci/build", state: "success", description: "Build passed." },
              { context: "agent-review", state: "failure", description: "Needs a closer look. Read the review." },
            ],
          },
        ],
      },
    );

    expect(merged(outcome)["verdict"]).toBe("Needs a closer look. Read the review.");
  });

  it("records no verdict when the merged head carries none", () => {
    expect(merged(runSliceRow())["verdict"]).toBeNull();
  });

  it("links the unresolved threads only, falling back to the original line of an outdated one", () => {
    const outcome = runSliceRow(
      {},
      {
        threads: [
          reviewThread(),
          reviewThread({ isResolved: true, path: "resolved.ts" }),
          reviewThread({ path: "outdated.ts", line: null, originalLine: 12 }),
          reviewThread({ path: "file-level.md", line: null, originalLine: null }),
        ],
      },
    );

    expect(merged(outcome)["openThreads"]).toEqual([
      { path: ".github/workflows/review.yml", line: 88, url: `${SLICE_URL}#discussion_r1` },
      { path: "outdated.ts", line: 12, url: `${SLICE_URL}#discussion_r1` },
      { path: "file-level.md", line: null, url: `${SLICE_URL}#discussion_r1` },
    ]);
  });

  /**
   * #172 and #173 were built before slice PRs: closed, and no slice PR says
   * `Part of` either. #174 is the slice being merged, and #175 is still open.
   */
  it("offers every closed sub-issue with no slice PR as a pre-upgrade slice, in sub-issue order", () => {
    const outcome = runSliceRow(
      { body: "Part of #174", title: "Slice 3 (#174)" },
      {
        issue: {
          ...issue(["CLOSED", "CLOSED", "CLOSED", "OPEN"]),
        },
        bystanders: BYSTANDERS.filter((p) => p["number"] !== 202),
      },
    );

    expect(outcome.status).toBe(0);
    expect(merged(outcome)).toMatchObject({ title: "Slice 3", subIssue: 174 });
    expect(facts(outcome)["preUpgrade"]).toEqual([
      { title: "Slice 1", subIssue: 172 },
      { title: "Slice 2", subIssue: 173 },
    ]);
  });

  /** #202 is a merged slice PR for #172, found by its branch: it has no body. */
  it("does not offer a sub-issue a slice PR of any state built", () => {
    const outcome = runSliceRow(
      { body: "Part of #174" },
      { issue: issue(["CLOSED", "CLOSED", "CLOSED", "OPEN"]) },
    );

    expect(facts(outcome)["preUpgrade"]).toEqual([{ title: "Slice 2", subIssue: 173 }]);
  });

  it("offers none on an ordinary chain, whose closed sub-issues each had a slice PR", () => {
    expect(facts(runSliceRow())["preUpgrade"]).toEqual([]);
  });

  it("falls back to the slice branch's name when the body no longer says Part of", () => {
    expect(merged(runSliceRow({ body: "Edited by hand." }))["subIssue"]).toBe(172);
  });

  it("stops, naming the slice PR, when it cannot tell which sub-issue the slice built", () => {
    const outcome = runSliceRow({ body: "Edited by hand.", headRefName: "renamed-by-hand" });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain(`slice PR #${SLICE}`);
    expect(outcome.reason).toContain("Part of #<sub-issue>");
    expect(outcome.reason).toContain("the merge is not repeated");
    expect(outcome.temp("slices-table.json")).toBe("");
  });

  it("only reads", () => {
    expect(runSliceRow().writes).toEqual([]);
  });
});

/** The PRD PR step, handed the PRD branch the merge step read off the slice PR. */
const runPrdPr = (pulls: readonly Record<string, unknown>[]): StepOutcome =>
  runStep("prd_pr", { pulls, env: { PRD_BRANCH } });

/**
 * The PRD PR (#173): opened as a draft carrying `Closes #<parent>` by the run
 * that merges the first slice, found by its **head** by every run after — which
 * is also what adopts the draft PR a pre-upgrade chain opened from the PRD
 * branch.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd's PRD PR, executed", () => {
  it("opens it as a draft from the PRD branch into the base, closing the parent", () => {
    const outcome = runPrdPr(BYSTANDERS.filter((p) => p["number"] !== 201));
    const creates = prWrites(outcome).filter((argv) => argv[1] === "create");

    expect(outcome.status).toBe(0);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.slice(0, 7)).toEqual(["pr", "create", "--draft", "--base", "main", "--head", PRD_BRANCH]);
    expect(outcome.temp("prd-pr-body.md").split("\n")[0]).toBe(`Closes #${PARENT}`);
    expect(outcome.output).toContain("number=300\n");
  });

  /** #201 is the PR whose head is the PRD branch: a pre-upgrade draft, or this chain's own. */
  it("reuses the PRD PR a run before it opened, or a pre-upgrade one, rather than a second", () => {
    const outcome = runPrdPr(BYSTANDERS);

    expect(outcome.status).toBe(0);
    expect(prWrites(outcome)).toEqual([]);
    expect(outcome.output).toContain("number=201\n");
  });

  it("refuses to guess between two open PRs from the PRD branch", () => {
    const outcome = runPrdPr([...BYSTANDERS, pull(205, PRD_BRANCH, "release")]);

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("#201, #205");
    expect(prWrites(outcome)).toEqual([]);
  });
});

/**
 * The contract the replay stands on for the steps above, against the real
 * binary, the way the preflight's `pr list` is checked: the flags parse and
 * every `--json` field exists, so gh gets as far as the connection to
 * `localhost` and no further.
 */
describe.skipIf(!onPath("gh"))("gh accepts the calls the merge, slice row and PRD PR steps compose", () => {
  const attempt = (args: readonly string[]): ReturnType<typeof spawnSync> =>
    spawnSync("gh", [...args], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
      env: { ...process.env, GH_TOKEN: "test-token", GH_HOST: "localhost", GH_REPO },
    });

  it.each([
    ["pr view", ["pr", "view", "210", "--json", "number,state,isDraft,mergeable,headRefOid,headRefName,baseRefName,labels"]],
    ["pr view, merged", ["pr", "view", "210", "--json", "number,headRefOid,headRefName,title,body,url"]],
    ["api graphql --paginate --slurp", ["api", "graphql", "--paginate", "--slurp", "-F", "number=210", "-f", "query=query($endCursor: String) { viewer { login } }"]],
    ["pr list --base", ["pr", "list", "--state", "all", "--base", PRD_BRANCH, "--limit", "1000", "--json", "number,body,headRefName"]],
    ["pr merge", ["pr", "merge", "210", "--squash", "--match-head-commit", "abc"]],
    ["pr list --head", ["pr", "list", "--state", "open", "--head", PRD_BRANCH, "--limit", "100", "--json", "number"]],
  ])("%s", (_name: string, args: readonly string[]) => {
    const merge = stepById("merge").run ?? "";
    const prdPr = stepById("prd_pr").run ?? "";

    const row = stepById("slice_row").run ?? "";

    expect(merge).toContain("fields=number,state,isDraft,mergeable,headRefOid,headRefName,baseRefName,labels\n");
    expect(row).toContain('gh pr view "$SLICE_PR" --json number,headRefOid,headRefName,title,body,url');
    expect(row).toContain("gh api graphql --paginate --slurp");
    expect(row).toContain('gh pr list --state all --base "$PRD_BRANCH" --limit 1000 --json number,body,headRefName');
    expect(merge).toContain('gh pr merge "$SLICE_PR" "--${method}" --match-head-commit "$head"');
    expect(prdPr).toContain('gh pr list --state open --head "$PRD_BRANCH" --limit 100 --json number');

    const result = attempt(args);

    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).not.toContain("unknown flag");
    expect(String(result.stderr)).not.toContain("Unknown JSON field");
    expect(String(result.stderr)).toContain("connection refused");
  });
});
