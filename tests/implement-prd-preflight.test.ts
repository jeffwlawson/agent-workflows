import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SLICES_END, SLICES_HEADING, SLICES_START } from "../shared/slices-table.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs `implement-prd`'s preflight — the real `run:` block, read out of
 * `.github/workflows/implement-prd.yml` — under `bash -e` against the recorded
 * `gh` in `tests/fixtures/gh-replay`, the seam `tests/review-ci-wait.test.ts`
 * built for the same reason: a string assertion passes on a step `gh` refuses
 * (#28).
 *
 * What it executes is the preflight's state table (#172, #177), every row of
 * it. Open slice PRs are found by their **base**, the PRD branch, and the
 * outcomes are different runs: none builds the next slice, one is merged and
 * then the next slice built on it (#173), and more than one stops and names
 * them all. With no sub-issue left, one open slice PR is the finishing run's to
 * merge, none with a draft PRD PR resumes the handover, and none otherwise is a
 * finished PRD. A stop fails into `Mark blocked on failure` with a reason file,
 * so what is asserted is the reason file, the exit, and that the step itself
 * touched nothing on the tracker.
 *
 * And the steps that come after it (#173): `Merge slice PR`, the step that
 * gathers the merged slice's row of the slices table (#174), the step that
 * opens or reuses the PRD PR once a slice has merged, and the finishing run's
 * handover of it (#177) — executed the same way, against the same replay.
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

/** A PRD PR body whose slices table holds a row for each of `subs`. */
const prdBody = (subs: readonly number[]): string =>
  [
    `Closes #${PARENT}`,
    "",
    SLICES_HEADING,
    SLICES_START,
    "| Slice | PR | Verdict | Open findings |",
    "|---|---|---|---|",
    ...subs.map((sub) => `| Slice \\| ${sub - 171} (#${sub}) | #${sub + 30} | 🟢 | none |`),
    SLICES_END,
    "",
  ].join("\n");

/**
 * What the preflight must look past: an ordinary PR into the base branch, the
 * PRD PR itself (whose *head* is the PRD branch), a merged slice PR whose row
 * the PRD PR already has, and an open slice PR of PRD #1710, whose branch
 * starts with this one's number, and is kept out only by the dash after it.
 */
const BYSTANDERS = [
  pull(200, "agent/issue-9-typo", "main"),
  pull(201, PRD_BRANCH, "main", "OPEN", { body: prdBody([172]) }),
  pull(202, "agent/slice-171-172-slice-1", PRD_BRANCH, "MERGED", { mergedAt: "2026-09-01T10:00:00Z" }),
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

  it("says a run that builds a slice is not the finishing run", () => {
    expect(runPreflight({ pulls: BYSTANDERS }).output).toContain("finishing=false\n");
  });

  /**
   * The last slice PR still open is a PRD waiting on it, not a finished one:
   * the lookup sits before the finished refusal. With no sub-issue left, it is
   * the **finishing run** (#177): it merges that slice PR and hands the PRD PR
   * over, and builds nothing.
   */
  it("makes the finishing run of the last open slice PR, rather than calling the PRD finished", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED"]),
      pulls: [...BYSTANDERS, pull(212, "agent/slice-171-174-slice-3", PRD_BRANCH)],
    });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("slice_pr=212\n");
    expect(outcome.output).toContain("sub=\n");
    expect(outcome.output).toContain("finishing=true\n");
    expect(outcome.output).toContain("refused=false\n");
    expect(outcome.output).not.toContain("prd_pr=");
    expect(outcome.reason).toBe("");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * A run that died after the last merge leaves every sub-issue closed, no
   * slice PR open and the PRD PR still a draft. Re-labelled, it resumes the
   * handover — the one thing left — and merges and builds nothing.
   */
  it("resumes the handover when nothing is open and the PRD PR is still a draft", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED"]),
      pulls: BYSTANDERS.map((p) => (p["number"] === 201 ? { ...p, isDraft: true } : p)),
    });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("finishing=true\n");
    expect(outcome.output).toContain("slice_pr=\n");
    expect(outcome.output).toContain("prd_pr=201\n");
    expect(outcome.output).toContain(`prd_branch=${PRD_BRANCH}\n`);
    expect(outcome.output).toContain("refused=false\n");
    expect(outcome.writes).toEqual([]);
  });

  /** …with a handed-over PRD PR, it is finished, refused as before. */
  it("refuses a PRD with no open sub-issue, no open slice PR and a handed-over PRD PR as finished", () => {
    const outcome = runPreflight({ issue: issue(["CLOSED", "CLOSED", "CLOSED"]), pulls: BYSTANDERS });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("refused=true\n");
    expect(outcome.output).not.toContain("finishing=");
    expect(outcome.reason).toBe("");
    expect(outcome.writes.some((w) => w.includes('"comment"') && w.includes("the PRD is finished"))).toBe(true);
  });

  /**
   * …and with no PRD PR at all, the same: there is nothing to hand over. A
   * merged slice PR with no PRD PR is a row nobody wrote, resumed below, so
   * this chain's slices were all built before slice PRs.
   */
  it("refuses a PRD with no PRD PR at all as finished", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED"]),
      pulls: BYSTANDERS.filter((p) => p["number"] !== 201 && p["number"] !== 202),
    });

    expect(outcome.output).toContain("refused=true\n");
    expect(outcome.writes.some((w) => w.includes("the PRD is finished"))).toBe(true);
  });

  /**
   * The finished refusal no longer sends a human to hand the PRD PR over: the
   * resume-the-handover row does that, on the same re-label.
   */
  it("tells nobody to add agent:review by hand when it refuses a finished PRD", () => {
    const outcome = runPreflight({ issue: issue(["CLOSED", "CLOSED", "CLOSED"]), pulls: BYSTANDERS });
    const comment = outcome.writes.find((w) => w.includes('"comment"')) ?? "";

    expect(comment).not.toContain("agent:review");
    expect(comment).not.toMatch(/by hand/);
  });

  it("will not guess which of two draft PRD PRs to hand over", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED"]),
      pulls: [
        ...BYSTANDERS.map((p) => (p["number"] === 201 ? { ...p, isDraft: true } : p)),
        pull(205, PRD_BRANCH, "release", "OPEN", { isDraft: true }),
      ],
    });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("#201, #205");
    expect(outcome.output).not.toContain("refused=");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * A run that merged a slice PR and then died left it merged with no row in
   * the slices table (#207), and the PRD PR unopened if it was the first. The
   * re-label resumes it: the merged, rowless slice PR is handed to the merge
   * step, whose `MERGED` arm merges nothing twice, so the row and the PRD PR
   * steps run, and then the next slice is built as usual.
   */
  it("hands a merged slice PR with no row to the merge step, when no PRD PR was opened", () => {
    const outcome = runPreflight({ pulls: BYSTANDERS.filter((p) => p["number"] !== 201) });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("slice_pr=202\n");
    expect(outcome.output).toContain("backfill=\n");
    expect(outcome.output).toContain("sub=173\n");
    expect(outcome.output).toContain("finishing=false\n");
    expect(outcome.output).toContain("refused=false\n");
    expect(outcome.writes).toEqual([]);
  });

  it("hands a merged slice PR to the merge step when the PRD PR has no row for its sub-issue", () => {
    const outcome = runPreflight({
      pulls: BYSTANDERS.map((p) => (p["number"] === 201 ? { ...p, body: `Closes #${PARENT}\n` } : p)),
    });

    expect(outcome.output).toContain("slice_pr=202\n");
    expect(outcome.output).toContain("sub=173\n");
  });

  /** The row is keyed by sub-issue, read out of the table between its markers and nowhere else. */
  it("never picks a merged slice PR up again once its row is written", () => {
    const outcome = runPreflight({ pulls: BYSTANDERS });

    expect(outcome.output).toContain("slice_pr=\n");
    expect(outcome.output).toContain("backfill=\n");
  });

  it("does not take a mention of the sub-issue outside the table for its row", () => {
    const outcome = runPreflight({
      pulls: BYSTANDERS.map((p) =>
        p["number"] === 201 ? { ...p, body: `Closes #${PARENT}\n\n| Slice 1 (#172) | #202 | 🟢 | none |\n` } : p,
      ),
    });

    expect(outcome.output).toContain("slice_pr=202\n");
  });

  /**
   * The state the #207 retry left behind: the rowless slice PR, and the slice
   * PR the retry built on top of it, open and waiting. This run merges the open
   * one as it would anyway, and writes the rowless one's row first, in merge
   * order, rather than building a second slice on an unmerged one.
   */
  it("backfills a rowless merged slice PR beside the open one it merges", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "OPEN"]),
      pulls: [
        ...BYSTANDERS.filter((p) => p["number"] !== 201),
        pull(210, "agent/slice-171-173-slice-2", PRD_BRANCH),
      ],
    });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("slice_pr=210\n");
    expect(outcome.output).toContain("backfill=202\n");
    expect(outcome.output).toContain("sub=174\n");
  });

  /**
   * More than one is backfilled, not refused: each row is read off its own
   * merged slice PR, which no later run can change, so there is nothing for a
   * human to decide, and a refusal would leave them writing rows by hand.
   * The latest-merged goes through the merge step; the rest are written before
   * it, in the order they merged.
   */
  it("backfills every rowless merged slice PR, in the order they merged", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED", "OPEN"]),
      pulls: [
        ...BYSTANDERS.filter((p) => p["number"] !== 201 && p["number"] !== 202),
        pull(212, "agent/slice-171-174-slice-3", PRD_BRANCH, "MERGED", { mergedAt: "2026-09-03T10:00:00Z" }),
        pull(202, "agent/slice-171-172-slice-1", PRD_BRANCH, "MERGED", { mergedAt: "2026-09-01T10:00:00Z" }),
        pull(211, "agent/slice-171-173-slice-2", PRD_BRANCH, "MERGED", { mergedAt: "2026-09-02T10:00:00Z" }),
      ],
    });

    expect(outcome.output).toContain("slice_pr=212\n");
    expect(outcome.output).toContain("backfill=202 211\n");
    expect(outcome.output).toContain("sub=175\n");
  });

  /**
   * Found by base, as the open ones are. A merged PR into another PRD's branch
   * is not this chain's, and one into this PRD branch that names no sub-issue,
   * by body or by branch, is not a slice a row could be written for.
   */
  it("backfills nothing merged into another PRD branch, or that names no sub-issue", () => {
    const outcome = runPreflight({
      pulls: [
        ...BYSTANDERS,
        pull(204, "agent/slice-1710-1711-other", "agent/prd-1710-other", "MERGED", { body: "Part of #1711" }),
        pull(205, "hand-made", PRD_BRANCH, "MERGED", { body: "A fix by hand." }),
      ],
    });

    expect(outcome.output).toContain("slice_pr=\n");
    expect(outcome.output).toContain("backfill=\n");
  });

  /**
   * The same death on the last slice: every sub-issue closed, nothing open, and
   * the last merge rowless. That is not a finished PRD but a finishing run to
   * resume, which writes the row, opens the PRD PR if it has to, and hands it
   * over.
   */
  it("makes the finishing run of a rowless last slice PR, rather than calling the PRD finished", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED"]),
      pulls: [
        ...BYSTANDERS.filter((p) => p["number"] !== 201),
        pull(212, "agent/slice-171-174-slice-3", PRD_BRANCH, "MERGED", { mergedAt: "2026-09-03T10:00:00Z" }),
      ],
    });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("slice_pr=212\n");
    expect(outcome.output).toContain("backfill=202\n");
    expect(outcome.output).toContain("finishing=true\n");
    expect(outcome.output).toContain("refused=false\n");
    expect(outcome.writes).toEqual([]);
  });

  /**
   * A PRD reopened after its PRD PR merged, to add a sub-issue: its rows are in
   * a merged body. Read from open PRD PRs only, every slice would look rowless
   * and the run would try to open a PRD PR from a branch already merged. Rows
   * are read from PRD PRs in every state, so it builds the new sub-issue.
   */
  it("reads rows from a merged PRD PR, so a reopened PRD resumes nothing", () => {
    const outcome = runPreflight({
      pulls: BYSTANDERS.map((p) => (p["number"] === 201 ? { ...p, state: "MERGED" } : p)),
    });

    expect(outcome.status).toBe(0);
    expect(outcome.output).toContain("slice_pr=\n");
    expect(outcome.output).toContain("backfill=\n");
    expect(outcome.output).toContain("sub=173\n");
  });

  /** …and with nothing left to build, it is refused as finished, as before, not made a finishing run. */
  it("refuses a PRD whose PRD PR merged with every row as finished", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED"]),
      pulls: BYSTANDERS.map((p) => (p["number"] === 201 ? { ...p, state: "MERGED" } : p)),
    });

    expect(outcome.output).toContain("refused=true\n");
    expect(outcome.output).not.toContain("finishing=");
  });

  it("reads rows from a closed PRD PR too", () => {
    const outcome = runPreflight({
      pulls: BYSTANDERS.map((p) => (p["number"] === 201 ? { ...p, state: "CLOSED" } : p)),
    });

    expect(outcome.output).toContain("slice_pr=\n");
    expect(outcome.output).toContain("backfill=\n");
  });

  /** The markers the rows are read between are the ones the runner splices between. */
  it("reads rows between the slices table's own markers", () => {
    expect(preflight().run ?? "").toContain(`--arg start "${SLICES_START}" --arg end "${SLICES_END}"`);
  });

  /**
   * The contract the `pr list` replay stands on, against the real binary: the
   * flags parse and every `--json` field exists, so gh gets as far as the
   * connection to `localhost` and no further. gh checks field names before any
   * request, so a misspelt one is refused here rather than on a PRD.
   */
  it.skipIf(!onPath("gh"))("gh accepts the pr list calls the lookup composes", () => {
    const run = preflight().run ?? "";

    for (const call of [
      "gh pr list --state open --limit 1000 --json number,headRefName,baseRefName,isDraft",
      "gh pr list --state all --limit 1000 --json number,state,headRefName,baseRefName,body,mergedAt",
    ]) {
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
    }
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

  /**
   * The chain's mark (#209): written into the slice PR's body before the merge,
   * pinned to the head the merge is pinned to, so review's `advance-merged`
   * can tell this merge from one made by hand under the same login.
   */
  it("marks the slice PR's body with the head it merges, before it merges", () => {
    const outcome = runMerge({ headRefOid: "0123abc", body: "Part of #172" });
    const writes = prWrites(outcome);
    const mark = writes.findIndex((argv) => argv[0] === "api" && argv[2] === "PATCH");

    expect(outcome.status).toBe(0);
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(writes[mark]?.[3]).toBe(`repos/${GH_REPO}/pulls/${SLICE}`);
    expect(writes[mark]?.at(-1)).toBe("body=Part of #172\n\n<!-- agent-chain-merge 0123abc -->");
    expect(mark).toBeLessThan(writes.findIndex((argv) => argv[1] === "merge"));
  });

  it("does not mark a body that already carries the mark for this head", () => {
    const outcome = runMerge({ headRefOid: "0123abc", body: "Part of #172\n\n<!-- agent-chain-merge 0123abc -->" });

    expect(outcome.status).toBe(0);
    expect(prWrites(outcome).some((argv) => argv[2] === "PATCH")).toBe(false);
    expect(merges(outcome)).toHaveLength(1);
  });

  it("marks nothing on a slice PR that is already merged", () => {
    const outcome = runMerge({ state: "MERGED" });

    expect(prWrites(outcome).some((argv) => argv[2] === "PATCH")).toBe(false);
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
    /** The rowless merged slice PRs the preflight found before this one. */
    readonly backfill?: string;
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
    env: { SLICE_PR: String(SLICE), PRD_BRANCH, BACKFILL: options.backfill ?? "" },
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
    expect(outcome.reason).toContain("The merge is not repeated");
    expect(outcome.temp("slices-table.json")).toBe("");
  });

  it("only reads", () => {
    expect(runSliceRow().writes).toEqual([]);
  });

  it("backfills nothing when the preflight found no other rowless slice PR", () => {
    expect(facts(runSliceRow())["backfill"]).toEqual([]);
  });

  /**
   * #202 merged in a run that died before writing its row (#207). Its row is
   * gathered the way the merged slice's is, from its own merged head, and
   * listed in the order the preflight found them, before the merged slice's.
   */
  it("gathers the row of every backfilled slice PR, in the order it is handed them", () => {
    const outcome = runSliceRow(
      { body: "Part of #174", title: "Slice 3 (#174)" },
      {
        issue: issue(["CLOSED", "CLOSED", "CLOSED", "OPEN"]),
        backfill: "202 211",
        bystanders: [
          ...BYSTANDERS.map((p) => (p["number"] === 202 ? { ...p, url: `https://github.com/${GH_REPO}/pull/202` } : p)),
          pull(211, "agent/slice-171-173-slice-2", PRD_BRANCH, "MERGED", {
            body: "Part of #173",
            url: `https://github.com/${GH_REPO}/pull/211`,
          }),
        ],
      },
    );

    expect(outcome.status).toBe(0);
    expect(facts(outcome)["backfill"]).toEqual([
      expect.objectContaining({ title: "Slice 1", subIssue: 172, slicePr: 202, slicePrUrl: `https://github.com/${GH_REPO}/pull/202` }),
      expect.objectContaining({ title: "Slice 2", subIssue: 173, slicePr: 211 }),
    ]);
    expect(merged(outcome)).toMatchObject({ subIssue: 174, slicePr: SLICE });
    expect(facts(outcome)["preUpgrade"]).toEqual([]);
    expect(outcome.writes).toEqual([]);
  });

  it("stops, naming the backfilled slice PR, when it cannot tell which sub-issue that one built", () => {
    const outcome = runSliceRow(
      { body: "Part of #174" },
      {
        backfill: "205",
        bystanders: [...BYSTANDERS, pull(205, "renamed-by-hand", PRD_BRANCH, "MERGED", { body: "Edited by hand." })],
      },
    );

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("slice PR #205");
    expect(outcome.reason).toContain("The merge is not repeated");
    expect(outcome.temp("slices-table.json")).toBe("");
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

/** One output a step wrote, read back as the expression after it would. */
const outputOf = (outcome: Outcome, name: string): string =>
  new RegExp(`^${name}=(.*)$`, "m").exec(outcome.output)?.[1] ?? "";

/**
 * The #207 sequence, replayed: slice PR #202 merged in a run that died before
 * its row or the PRD PR, and a re-label. Every step up to the build is run on
 * the outputs of the one before it, as the workflow wires them.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd resumes a run that died after merging a slice", () => {
  it("merges nothing twice, gathers the missing row, opens the PRD PR, and builds the next slice", () => {
    const pulls = BYSTANDERS.filter((p) => p["number"] !== 201).map((p) =>
      p["number"] === 202 ? { ...p, body: "Part of #172", url: `https://github.com/${GH_REPO}/pull/202` } : p,
    );

    const preflighted = runPreflight({ pulls });
    expect(preflighted.status).toBe(0);
    expect(outputOf(preflighted, "sub")).toBe("173");
    expect(outputOf(preflighted, "finishing")).toBe("false");

    const env = { SLICE_PR: outputOf(preflighted, "slice_pr"), BACKFILL: outputOf(preflighted, "backfill") };
    const merge = runStep("merge", { pulls, repo: REPO, env: { ...env, HAS_PAT: "true" } });
    expect(merge.status).toBe(0);
    expect(merges(merge)).toEqual([]);
    expect(outputOf(merge, "merged")).toBe("true");

    const row = runStep("slice_row", { pulls, env: { ...env, PRD_BRANCH: outputOf(merge, "prd_branch") } });
    expect(row.status).toBe(0);
    expect(facts(row)["merged"]).toMatchObject({ subIssue: 172, slicePr: 202 });

    const prdPr = runStep("prd_pr", { pulls, env: { ...env, PRD_BRANCH: outputOf(merge, "prd_branch") } });
    expect(prdPr.status).toBe(0);
    expect(prWrites(prdPr).filter((argv) => argv[1] === "create")).toHaveLength(1);
    expect(outputOf(prdPr, "number")).toBe("300");
  });
});

/** The handover, handed PRD PR #201 and the PRD branch, as the finishing run has them. */
const runHandover = (
  options: { readonly issue: Record<string, unknown>; readonly pulls: readonly Record<string, unknown>[]; readonly pat?: boolean },
): StepOutcome =>
  runStep("handover", {
    issue: options.issue,
    pulls: options.pulls,
    env: { PRD_PR: "201", PRD_BRANCH, HAS_PAT: String(options.pat ?? true) },
  });

/**
 * The finishing run's handover (#177), executed. More than one slice asks for
 * the integration review with `agent:review`, and review marks the PRD PR
 * ready; one slice was reviewed on its slice PR already, so the PRD PR is
 * marked ready here. A slice built before slice PRs is a slice.
 */
describe.skipIf(!CAN_RUN)("agent-implement-prd's handover, executed", () => {
  it("runs under the shell the workflow actually gets", () => {
    expect(stepById("handover").shell).toBeUndefined();
  });

  it("marks the PRD PR of a one-slice PRD ready itself, and asks for no review", () => {
    const outcome = runHandover({ issue: issue(["CLOSED"]), pulls: BYSTANDERS });

    expect(outcome.status).toBe(0);
    expect(prWrites(outcome)).toEqual([["pr", "ready", "201"]]);
  });

  it("asks for the integration review on the PRD PR of a PRD with more than one slice PR", () => {
    const outcome = runHandover({
      issue: issue(["CLOSED", "CLOSED"]),
      pulls: [...BYSTANDERS, pull(210, "agent/slice-171-173-slice-2", PRD_BRANCH, "MERGED")],
    });

    expect(outcome.status).toBe(0);
    expect(prWrites(outcome)).toEqual([["pr", "edit", "201", "--add-label", "agent:review"]]);
  });

  /** #202 built #172; #173 was closed with no slice PR, before slice PRs existed. */
  it("counts a slice built before slice PRs as a slice", () => {
    const outcome = runHandover({ issue: issue(["CLOSED", "CLOSED"]), pulls: BYSTANDERS });

    expect(prWrites(outcome)).toEqual([["pr", "edit", "201", "--add-label", "agent:review"]]);
  });

  /** An open slice PR is the one the finishing run is about to merge; nothing else is built. */
  it("does not count a slice PR that has not merged", () => {
    const outcome = runHandover({
      issue: issue(["CLOSED", "CLOSED"]),
      pulls: [...BYSTANDERS, pull(210, "agent/slice-171-173-slice-2", PRD_BRANCH, "CLOSED")],
    });

    expect(prWrites(outcome)).toEqual([["pr", "ready", "201"]]);
  });

  it("refuses without AGENT_PAT rather than add a label that starts nothing, touching nothing", () => {
    const outcome = runHandover({ issue: issue(["CLOSED", "CLOSED"]), pulls: BYSTANDERS, pat: false });

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
 * binary, the way the preflight's `pr list` is checked: the flags parse and
 * every `--json` field exists, so gh gets as far as the connection to
 * `localhost` and no further.
 */
describe.skipIf(!onPath("gh"))("gh accepts the calls the merge, slice row, PRD PR and handover steps compose", () => {
  const attempt = (args: readonly string[]): ReturnType<typeof spawnSync> =>
    spawnSync("gh", [...args], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
      env: { ...process.env, GH_TOKEN: "test-token", GH_HOST: "localhost", GH_REPO },
    });

  it.each([
    ["pr view", ["pr", "view", "210", "--json", "number,state,isDraft,mergeable,headRefOid,headRefName,baseRefName,labels,body"]],
    ["api -X PATCH pulls, the chain's mark", ["api", "-X", "PATCH", `repos/${GH_REPO}/pulls/210`, "-f", "body=x"]],
    ["pr view, merged", ["pr", "view", "210", "--json", "number,headRefOid,headRefName,title,body,url"]],
    ["api graphql --paginate --slurp", ["api", "graphql", "--paginate", "--slurp", "-F", "number=210", "-f", "query=query($endCursor: String) { viewer { login } }"]],
    ["pr list --base", ["pr", "list", "--state", "all", "--base", PRD_BRANCH, "--limit", "1000", "--json", "number,body,headRefName"]],
    ["pr merge", ["pr", "merge", "210", "--squash", "--match-head-commit", "abc"]],
    ["pr list --head", ["pr", "list", "--state", "open", "--head", PRD_BRANCH, "--limit", "100", "--json", "number"]],
    ["pr list --base, with state", ["pr", "list", "--state", "all", "--base", PRD_BRANCH, "--limit", "1000", "--json", "number,state,body,headRefName"]],
    ["pr edit --add-label", ["pr", "edit", "201", "--add-label", "agent:review"]],
    ["pr ready", ["pr", "ready", "201"]],
  ])("%s", (_name: string, args: readonly string[]) => {
    const merge = stepById("merge").run ?? "";
    const prdPr = stepById("prd_pr").run ?? "";

    const row = stepById("slice_row").run ?? "";

    expect(merge).toContain("fields=number,state,isDraft,mergeable,headRefOid,headRefName,baseRefName,labels,body\n");
    expect(merge).toContain('gh api -X PATCH "repos/${GH_REPO}/pulls/${SLICE_PR}" -f body=');
    expect(row).toContain('gh pr view "$number" --json number,headRefOid,headRefName,title,body,url');
    expect(row).toContain("gh api graphql --paginate --slurp");
    expect(row).toContain('gh pr list --state all --base "$PRD_BRANCH" --limit 1000 --json number,body,headRefName');
    expect(merge).toContain('gh pr merge "$SLICE_PR" "--${method}" --match-head-commit "$head"');
    expect(prdPr).toContain('gh pr list --state open --head "$PRD_BRANCH" --limit 100 --json number');
    expect(stepById("handover").run ?? "").toContain(
      'gh pr list --state all --base "$PRD_BRANCH" --limit 1000 --json number,state,body,headRefName',
    );

    const result = attempt(args);

    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).not.toContain("unknown flag");
    expect(String(result.stderr)).not.toContain("Unknown JSON field");
    expect(String(result.stderr)).toContain("connection refused");
  });
});
