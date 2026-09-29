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
 * their **base**, the PRD branch, and the three outcomes are three different
 * runs: none builds the next slice, one stops and names it, more than one stops
 * and names them all. A stop fails into `Mark blocked on failure` with a reason
 * file, so what is asserted is the reason file, the exit, and that the step
 * itself touched nothing on the tracker.
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

const preflight = (): Step => {
  const step = ((parse(fs.readFileSync(PRD, "utf8")) as Workflow).jobs["implement-prd"]?.steps ?? []).find(
    (s) => s.id === "preflight",
  );

  expect(step).toBeDefined();
  return step as Step;
};

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

const pull = (number: number, headRefName: string, baseRefName: string, state = "OPEN"): Record<string, unknown> => ({
  number,
  headRefName,
  baseRefName,
  state,
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

const runPreflight = (options: {
  readonly pulls: readonly Record<string, unknown>[];
  readonly issue?: Record<string, unknown>;
}): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-implement-prd-"));
  const script = path.join(temp, "step.sh");
  const issueFile = path.join(temp, "issue.json");
  const pullsFile = path.join(temp, "pulls.json");
  const output = path.join(temp, "output");
  const log = path.join(temp, "writes.log");

  fs.writeFileSync(script, preflight().run ?? "");
  fs.writeFileSync(issueFile, JSON.stringify(options.issue ?? issue()));
  fs.writeFileSync(pullsFile, JSON.stringify(options.pulls));
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
      GH_REPLAY_LOG: log,
      PATH: `${ghDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
    },
  });
  const reason = path.join(temp, "failure_reason.txt");

  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    output: fs.readFileSync(output, "utf8"),
    reason: fs.existsSync(reason) ? fs.readFileSync(reason, "utf8") : "",
    writes: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  };
};

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

  /**
   * By base, never by name: the slice branch here was renamed away from
   * `agent/slice-`, and the slice PR is still the one that stops the run.
   */
  it("stops on one open slice PR, naming it, whatever its branch is called", () => {
    const outcome = runPreflight({ pulls: [...BYSTANDERS, pull(210, "renamed-by-hand", PRD_BRANCH)] });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("slice PR #210 (`renamed-by-hand` into `agent/prd-171-slice-prs`)");
    expect(outcome.reason).toMatch(/merge it into the PRD branch by hand/);
    expect(outcome.stdout).toContain("::error::Refused to run: slice PR #210");
    // Not a refusal: `Mark blocked on failure` is gated on `refused != 'true'`,
    // and it is what gives the parent `agent:blocked` and the comment.
    expect(outcome.output).not.toContain("refused=");
    expect(outcome.output).not.toContain("sub=");
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
   * human there is nothing left to do.
   */
  it("stops on the last slice PR rather than calling the PRD finished", () => {
    const outcome = runPreflight({
      issue: issue(["CLOSED", "CLOSED", "CLOSED"]),
      pulls: [...BYSTANDERS, pull(212, "agent/slice-171-174-slice-3", PRD_BRANCH)],
    });

    expect(outcome.status).toBe(1);
    expect(outcome.reason).toContain("slice PR #212");
    expect(outcome.reason).not.toContain("finished");
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
