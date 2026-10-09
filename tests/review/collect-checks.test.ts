import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubError } from "../../engine/github.js";
import type { CheckRun, GitHubReader, WorkflowRun } from "../../engine/read.js";
import { AGENT_CHECKS, CI_WAIT_SECONDS, collectChecks, GRACE_SECONDS, POLL_SECONDS } from "../../review/collect-checks.js";
import type { ReadingIo } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { VERDICT_CONTEXT } from "../../shared/record.js";
import { fakeGitHub, fakeReader, type FakeGitHub, type ReceivedRead } from "../engine/fakes.js";

/**
 * `review:collect-checks` (#421), called the way the CLI calls it: its
 * declared inputs, a fake GitHub reader holding the commit's check runs,
 * statuses and workflow runs, and its declared outputs. What is asserted is
 * what the agent is handed, `ci_status.md`, the one word the verdict is
 * derived from, `ci_result.txt`, and what it said in the log.
 *
 * The clock is faked, so the wait runs at its real ceiling and grace period:
 * a wait that counted something it should not would spin to the ceiling, and
 * the evidence would say so, rather than the test hanging.
 *
 * The scenarios are the retired step test's, `tests/review-ci-wait.test.ts`,
 * carried over by behaviour. Its checks of the `gh` invocations the shell
 * composed (#28) went with the shell: the reads are the engine's now.
 */

const SHA = "35da2fc0e3a94c2d8b1b0e4e9f1c2d3a4b5c6d7e";
const SELF_CHECK = "review / review";
const SELF_RUN_ID = 4242;
const RUNS = "https://github.com/acme/widgets/actions/runs";

let github: FakeGitHub;
let reads: ReceivedRead[];
let files: Map<string, string>;
let logged: string[];

beforeEach(() => {
  vi.useFakeTimers();
  github = fakeGitHub();
  files = new Map();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Inputs = Parameters<typeof collectChecks>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: "acme/widgets",
  GH_TOKEN: "workflow-token",
  REVIEWED_SHA: SHA,
  SELF_CHECK,
  SELF_RUN_ID: String(SELF_RUN_ID),
  ...over,
});

const done = (name: string, conclusion = "success"): CheckRun => ({ name, status: "completed", conclusion });
const running = (name: string, status: string): CheckRun => ({ name, status, conclusion: null });

/**
 * This job's own check run and a sibling agent's, both excluded, and both
 * unfinished, so a wait that failed to exclude them would never end; and
 * thirty that passed, more than one page of the shell's reads held.
 */
const CHECKS: readonly CheckRun[] = [
  running(SELF_CHECK, "in_progress"),
  running("fix / fix", "queued"),
  ...Array.from({ length: 28 }, (_, i) => done(`unit-${String(i + 1).padStart(2, "0")}`)),
  done("verify"),
  done(".github/dependabot.yml"),
];

/** What a commit no CI ran on looks like from inside the review: only the loop's own. */
const NO_CI: readonly CheckRun[] = [running(SELF_CHECK, "in_progress"), running("fix / fix", "queued")];

const run = (id: number, name: string, status: string, conclusion: string | null = null, referencedWorkflows: readonly string[] = []): WorkflowRun => ({
  id,
  name,
  status,
  conclusion,
  url: `${RUNS}/${id}`,
  referencedWorkflows,
});

/** A status as the loop's fake holds them: newest first, of which the reader gives the latest per context. */
const status = (context: string, state: string) => ({ context, state, targetUrl: null, description: "", creator: "ci" });

const set = (state: { checks?: readonly CheckRun[]; statuses?: readonly [string, string][]; runs?: readonly WorkflowRun[] }): void => {
  github.checkRuns.set(SHA, [...(state.checks ?? CHECKS)]);
  github.statuses.set(SHA, (state.statuses ?? []).map(([context, s]) => status(context, s)));
  github.workflowRuns.set(SHA, [...(state.runs ?? [])]);
};

/**
 * A failure of the read `method`, as GitHub answering 403 or not at all, on
 * its calls from the `from`th to the `to`th (1-based), every one by default.
 */
type Failure = { readonly method: keyof GitHubReader; readonly how: "403" | "unreachable"; readonly from?: number; readonly to?: number };

const refusal = (how: "403" | "unreachable"): GitHubError =>
  how === "403"
    ? new GitHubError("GET /repos/acme/widgets/…: 403 Resource not accessible by integration", 403)
    : new GitHubError("fetch failed: connect ECONNREFUSED");

/**
 * The CLI's half: the reader, the outputs, the call, and the fake clock run
 * until the command ends. `runsByCall` and `checksByCall` are the commit's
 * workflow runs or check runs on each read, in turn, the last one held: how a
 * run that appears or finishes partway through the wait is written.
 */
const collect = async (
  options: {
    inputs?: Inputs;
    fail?: readonly Failure[];
    runsByCall?: readonly (readonly WorkflowRun[])[];
    checksByCall?: readonly (readonly CheckRun[])[];
  } = {},
): Promise<{ readonly evidence: string; readonly result: string | undefined; readonly log: string }> => {
  const fake = fakeReader(github);
  reads = fake.reads as ReceivedRead[];
  const calls = new Map<string, number>();
  const failing = <M extends keyof GitHubReader>(method: M): GitHubReader[M] =>
    (async (...args: never[]) => {
      const n = (calls.get(method) ?? 0) + 1;
      calls.set(method, n);
      const failure = options.fail?.find((f) => f.method === method && n >= (f.from ?? 1) && n <= (f.to ?? Infinity));
      if (failure !== undefined) throw refusal(failure.how);
      const byCall = method === "workflowRuns" ? options.runsByCall : method === "checkRuns" ? options.checksByCall : undefined;
      if (byCall !== undefined) {
        reads.push({ method, args });
        return [...(byCall[Math.min(n, byCall.length) - 1] ?? [])];
      }
      return (fake.reader[method] as (...a: never[]) => unknown)(...args);
    }) as GitHubReader[M];
  const reader: GitHubReader = {
    ...fake.reader,
    checkRuns: failing("checkRuns"),
    latestStatuses: failing("latestStatuses"),
    workflowRuns: failing("workflowRuns"),
    failedJobLogs: failing("failedJobLogs"),
  };
  const io: ReadingIo<(typeof COMMANDS)["review:collect-checks"]["outputs"]> = {
    github: reader,
    outputs: {
      writeJson: (name, value) => files.set(name, JSON.stringify(value)),
      writeText: (name, value) => files.set(name, value),
      appendLine: () => {},
    },
  };
  const ended = collectChecks(options.inputs ?? INPUTS(), io);
  // Marked handled now, and awaited after the clock has run: a refusal is
  // still the caller's to see.
  ended.catch(() => {});
  await vi.runAllTimersAsync();
  await ended;
  return { evidence: files.get("ci_status.md") ?? "", result: files.get("ci_result.txt")?.trim(), log: logged.join("\n") };
};

describe("review:collect-checks hands the agent the other checks", () => {
  /**
   * The count is one number over every check run, the self-check and the
   * queued sibling left out, so nothing here is pending and the wait ends at
   * once, with no ceiling reached.
   */
  it("waits for no check when every non-agent check has finished", async () => {
    set({});
    const { evidence, log } = await collect();

    expect(log).not.toContain("::error::");
    expect(log).not.toContain("Waiting for");
    expect(evidence).not.toContain("no CI evidence");
    expect(evidence).not.toContain("Still running after");
    expect(reads.filter((r) => r.method === "checkRuns").every((r) => r.args[0] === SHA)).toBe(true);
  });

  /** Whole lines, and no agent job among them. */
  it("hands the agent every non-agent check on the commit", async () => {
    set({});
    const { evidence } = await collect();
    const lines = evidence.split("\n");

    expect(lines).toContain("Checks on this commit:");
    expect(lines).toContain("- verify: success");
    expect(lines).toContain("- .github/dependabot.yml: success");
    expect(lines).toContain("- unit-01: success");
    expect(lines).toContain("- unit-28: success");
    expect(evidence).not.toContain(SELF_CHECK);
    expect(evidence).not.toContain("fix / fix");
    expect(evidence).not.toContain("could not read");
  });

  /**
   * A check still running at the ceiling: the wait spends its whole bound,
   * polling, and then says what it was still waiting for. A check that has
   * not finished has not failed either (#221), so the word is `unknown`.
   */
  it("waits up to its ceiling for a check still running, and does not know at it", async () => {
    set({ checks: [...CHECKS, running("deploy", "in_progress")] });
    const { evidence, result, log } = await collect();

    expect(log).toContain("Waiting for 1 check(s) and 0 workflow run(s)…");
    expect(evidence).toContain(`Still running after ${CI_WAIT_SECONDS / 60} minutes: 1 check(s) and 0 workflow run(s)`);
    expect(evidence.split("\n")).toContain("- deploy: in_progress");
    expect(result).toBe("unknown");
    expect(reads.filter((r) => r.method === "checkRuns").length).toBeGreaterThan(CI_WAIT_SECONDS / POLL_SECONDS);
  });

  /** And ends as soon as it finishes, rather than at the ceiling. */
  it("stops waiting the moment the check finishes", async () => {
    set({});
    const { evidence, result, log } = await collect({
      checksByCall: [[...CHECKS, running("deploy", "in_progress")], [...CHECKS, running("deploy", "in_progress")], [...CHECKS, done("deploy")]],
    });

    expect(log.match(/Waiting for 1 check\(s\)/g)).toHaveLength(2);
    expect(evidence).not.toContain("Still running after");
    expect(evidence.split("\n")).toContain("- deploy: success");
    expect(result).toBe("green");
  });

  /**
   * The verdict's CI half (#96). A word that said `green` on a commit whose
   * checks are red is the one failure here that ends in a merge.
   */
  it.each([
    ["green when every non-agent check passed", "success", "green"],
    ["red when one of them failed", "failure", "red"],
    ["green for a check that was neutral", "neutral", "green"],
    ["green for a check that was skipped", "skipped", "green"],
    ["red for one that was cancelled", "cancelled", "red"],
  ])("is %s", async (_case, conclusion, expected) => {
    set({ checks: [...CHECKS, done("deploy", conclusion)] });

    expect((await collect()).result).toBe(expected);
  });

  /**
   * The agent jobs are excluded from the word on the grounds they are from the
   * wait: a sibling queued behind this one is not a red check.
   */
  it("is green when the only unfinished checks are agent jobs", async () => {
    set({});

    expect((await collect()).result).toBe("green");
  });

  /** The other CI surface (#105), which check runs are not. */
  it.each([
    ["red when a commit status failed", "failure", "red"],
    ["red when one errored", "error", "red"],
    ["unknown when one is still pending at the ceiling", "pending", "unknown"],
    ["green when every one of them passed", "success", "green"],
  ])("is %s", async (_case, state, expected) => {
    set({ statuses: [["ci/build", state]] });

    expect((await collect()).result).toBe(expected);
  });

  /** The latest status per context: one that went `pending → success` is one status, and green. */
  it("reads each context's latest status", async () => {
    set({});
    github.statuses.set(SHA, [status("ci/build", "success"), status("ci/build", "pending")]);

    expect((await collect()).result).toBe("green");
  });

  /**
   * With this job's own answer skipped. Counted, the last round's `failure`
   * verdict would be evidence for the next one, and every "changes
   * recommended" would derive "needs a closer look" one round later.
   */
  it("ignores the verdict's own context, which is this job's previous answer", async () => {
    set({ statuses: [[VERDICT_CONTEXT, "failure"], ["ci/build", "success"]] });

    expect((await collect()).result).toBe("green");
  });

  /** The wait reads that surface too (#107), and counts it with the check runs. */
  it("waits for a pending commit status like a pending check run", async () => {
    set({ statuses: [["ci/build", "pending"]] });
    const { evidence, log } = await collect();

    expect(log).not.toContain("::error::");
    expect(evidence).toContain("Still running after 15 minutes: 1 check(s)");
  });

  it("counts pending check runs and pending statuses together", async () => {
    set({
      checks: [...CHECKS, running("deploy", "in_progress")],
      statuses: [["ci/build", "pending"], ["ci/lint", "pending"], ["ci/docs", "success"]],
    });

    expect((await collect()).evidence).toContain("Still running after 15 minutes: 3 check(s)");
  });

  /** Waiting for its own context would be waiting for the answer it has not written. */
  it("never waits for the verdict's own context", async () => {
    set({ statuses: [[VERDICT_CONTEXT, "pending"], ["ci/build", "success"]] });
    const { evidence, result, log } = await collect();

    expect(log).not.toContain("Waiting for");
    expect(evidence).not.toContain("Still running after");
    expect(result).toBe("green");
  });

  /**
   * An adopter with no CI anywhere keeps the verdict it had (PRD #171, story
   * 58), and the evidence says plainly that nothing ran (#221). A PRD PR is no
   * exception (PRD #222): nothing here reads the branch.
   */
  it("is green on a commit no CI ran on, and says so, once the grace period passes", async () => {
    set({ checks: NO_CI });
    const { evidence, result, log } = await collect();

    expect(result).toBe("green");
    expect(evidence).toContain("No CI ran on this commit");
    expect(log).toContain(`No CI has reported on this commit yet; looking again for up to ${GRACE_SECONDS} s`);
    expect(log).not.toContain("::warning::");
    // It looked for the whole grace period, and no longer.
    expect(reads.filter((r) => r.method === "checkRuns").length).toBe(GRACE_SECONDS / POLL_SECONDS + 1 + 1);
  });

  /**
   * **A run waiting for approval** (#221) has created no check run, so a wait
   * over check runs and statuses alone called the commit green. It cannot
   * start until a human acts, so the wait does not wait for it.
   */
  it.each([
    ["needing approval", run(201, "CI", "completed", "action_required")],
    ["held by a protection rule", run(201, "CI", "waiting")],
  ])("does not know when a CI run is %s, and names it", async (_case, waiting) => {
    set({ checks: NO_CI, runs: [waiting] });
    const { evidence, result, log } = await collect();

    expect(result).toBe("unknown");
    expect(log).not.toContain("Waiting for");
    expect(log).toContain("::warning::A CI run on this commit is waiting for approval");
    expect(evidence).toContain("_CI waiting for approval:");
    expect(evidence.split("\n")).toContain(`- CI: waiting for approval, ${RUNS}/201`);
    expect(evidence).not.toContain("No CI ran");
  });

  /** …and not green beside checks that passed: one workflow finishing says nothing about another. */
  it("does not know when one run waits for approval and the rest passed", async () => {
    set({ runs: [run(201, "Corpus", "completed", "action_required")] });
    const { evidence, result } = await collect();

    expect(result).toBe("unknown");
    expect(evidence).toContain("- Corpus: waiting for approval");
  });

  it("does not know when a run is still in progress at the ceiling", async () => {
    set({ checks: NO_CI, runs: [run(202, "CI", "in_progress")] });
    const { evidence, result } = await collect();

    expect(result).toBe("unknown");
    expect(evidence).toContain("Still running after 15 minutes: 0 check(s) and 1 workflow run(s)");
    expect(evidence).not.toContain("No CI ran");
  });

  /**
   * A run is created a moment after the push that starts it. The grace period
   * keeps that from reading as "no CI": the wait keeps looking, finds the run,
   * and waits for it to finish.
   */
  it("waits for a run that appears within the grace period", async () => {
    set({ checks: NO_CI });
    const { evidence, result, log } = await collect({
      runsByCall: [[], [run(203, "CI", "queued")], [run(203, "CI", "completed", "success")]],
    });

    expect(log).toContain("No CI has reported on this commit yet");
    expect(log).toContain("Waiting for 0 check(s) and 1 workflow run(s)");
    expect(result).toBe("green");
    expect(evidence).not.toContain("No CI ran");
    expect(evidence).not.toContain("Still running after");
  });

  /**
   * The loop's own runs are not CI: this run by its id, an `Agent …` workflow
   * by its name, and a renamed caller by what it calls. A wait that counted
   * any of them would spin to the ceiling.
   */
  it("never waits for the loop's own workflow runs", async () => {
    set({
      runs: [
        run(SELF_RUN_ID, "Code review", "in_progress"),
        run(204, "Agent Fix", "queued"),
        run(205, "Bot fixes", "pending", null, ["jeffwlawson/agent-workflows/.github/workflows/fix.yml@v0.7.4"]),
      ],
    });
    const { evidence, result, log } = await collect();

    expect(log).not.toContain("Waiting for");
    expect(evidence).not.toContain("Still running after");
    expect(result).toBe("green");
  });

  /** Where there is no run of its own to drop, every run is read. */
  it("reads every run where it is told of no run of its own", async () => {
    set({ checks: NO_CI, runs: [run(SELF_RUN_ID, "CI", "completed", "failure")] });

    expect((await collect({ inputs: INPUTS({ SELF_RUN_ID: "" }) })).result).toBe("red");
  });

  /**
   * A run that completed without passing is `red` from the runs surface too:
   * a `startup_failure` creates no job, so no check run, and with no statuses
   * either the commit read as no CI and green.
   */
  it.each(["startup_failure", "failure", "cancelled", "timed_out", "stale"])("is red when a run completed as %s, and names it", async (conclusion) => {
    set({ checks: NO_CI, runs: [run(206, "CI", "completed", conclusion)] });
    const { evidence, result } = await collect();

    expect(result).toBe("red");
    expect(evidence).toContain("_Workflow runs that did not pass:_");
    expect(evidence.split("\n")).toContain(`- CI: ${conclusion}, ${RUNS}/206`);
    expect(evidence).not.toContain("No CI ran");
  });

  it.each(["success", "neutral", "skipped"])("is green when a run completed as %s", async (conclusion) => {
    set({ checks: NO_CI, runs: [run(207, "CI", "completed", conclusion)] });
    const { evidence, result } = await collect();

    expect(result).toBe("green");
    expect(evidence).not.toContain("did not pass");
  });

  /**
   * A job held by an environment's reviewers has a check run `waiting` beside
   * a run `waiting` too. Neither moves until a human acts, so the wait counts
   * neither; the word still reads it as unfinished.
   */
  it("does not wait for a check run held by a protection rule", async () => {
    set({ checks: [running(SELF_CHECK, "in_progress"), running("deploy", "waiting")], runs: [run(208, "Deploy", "waiting")] });
    const { evidence, result, log } = await collect();

    expect(log).not.toContain("Waiting for");
    expect(result).toBe("unknown");
    expect(evidence).toContain("- Deploy: waiting for approval");
  });

  /** "No CI ran" is every surface empty: CI that reports only a commit status ran. */
  it("is green, and says nothing of no CI, where CI reports only a commit status", async () => {
    set({ checks: NO_CI, statuses: [["ci/build", "success"]] });
    const { evidence, result } = await collect();

    expect(result).toBe("green");
    expect(evidence).not.toContain("No CI ran");
  });
});

describe("review:collect-checks says what it could not read", () => {
  /**
   * Unreadable stays `unknown` rather than collapsing into either answer. An
   * unreadable status must neither spin the wait nor be blamed on the check
   * runs, which read fine.
   */
  it.each(["403", "unreachable"] as const)("does not know when the statuses cannot be read (%s)", async (how) => {
    set({});
    const { result, log } = await collect({ fail: [{ method: "latestStatuses", how }] });

    expect(result).toBe("unknown");
    expect(log).toContain("::warning::Could not read this commit's statuses");
    expect(log).toContain(refusal(how).message);
    expect(log).not.toContain("::error::");
    expect(log).not.toContain("Waiting for");
  });

  /** A failure that was seen outranks a surface that could not be read. */
  it("is red when one surface failed and another could not be read", async () => {
    set({ checks: [...CHECKS, done("deploy", "failure")] });

    expect((await collect({ fail: [{ method: "latestStatuses", how: "403" }] })).result).toBe("red");
  });

  /**
   * An unreadable check-runs read stops the wait at once, says so in the log
   * with what GitHub said, and again in the evidence handed to the agent: a
   * review with no CI behind it should never look like one that had it. The
   * `::error::` names the grant as the one thing this cannot be, since a
   * caller short of it is refused before any job starts (#146).
   */
  it.each(["403", "unreachable"] as const)("reports itself blind when the check runs cannot be read (%s)", async (how) => {
    set({});
    const { evidence, result, log } = await collect({ fail: [{ method: "checkRuns", how }] });

    expect(log).toContain(`::error::Could not read check runs for ${SHA}`);
    expect(log).toContain("checks: read");
    expect(log).toContain("before any job starts");
    expect(log).toContain(refusal(how).message);
    expect(evidence).toContain("_Could not read this commit's check runs, so the review below has no CI evidence._");
    expect(evidence.split("\n")).toContain("- (could not read check runs)");
    // It stops rather than spinning: one look, no wait.
    expect(log).not.toContain("Waiting for");
    expect(reads.filter((r) => r.method === "checkRuns")).toHaveLength(0);
    expect(result).toBe("unknown");
    expect(log).toContain("::warning::Could not decide whether this commit's check runs are green");
  });

  /**
   * The listing is its own read and can fail on its own, on a run where the
   * wait's read answered: then the wait's arm is silent, and the listing is the
   * only thing that can say why.
   */
  it("says why when the listing fails on a commit whose wait read the check runs", async () => {
    set({});
    const { evidence, result, log } = await collect({ fail: [{ method: "checkRuns", how: "unreachable", from: 2 }] });

    expect(log).not.toContain("::error::Could not read check runs");
    expect(evidence.split("\n")).toContain("- (could not read check runs)");
    expect(log).toContain("::warning::Could not list check runs");
    expect(log).toContain(refusal("unreachable").message);
    expect(result).toBe("unknown");
  });

  /**
   * The runs listing feeds the tail and the word. Unreadable, the evidence
   * says what is missing rather than absent, and the word cannot be green on
   * a commit whose runs nobody could see.
   */
  it.each(["403", "unreachable"] as const)("says the failure logs are missing when the runs cannot be listed (%s)", async (how) => {
    set({});
    const { evidence, result, log } = await collect({ fail: [{ method: "workflowRuns", how }] });

    expect(evidence).toContain("Could not list this commit's workflow runs");
    expect(evidence).not.toMatch(/lacks|must|required/i);
    expect(evidence).not.toContain("### Failure output");
    expect(log).toContain("::warning::Could not list this commit's workflow runs");
    expect(log).toContain(refusal(how).message);
    expect(log).toContain("--- collected CI context ---");
    expect(result).toBe("unknown");
  });

  it("adds no line when the runs were listed and none failed", async () => {
    set({});
    const { evidence, log } = await collect();

    expect(evidence).not.toContain("Could not list this commit's workflow runs");
    expect(log).not.toContain("Could not list this commit's workflow runs");
  });
});

describe("review:collect-checks tails the failed runs' logs", () => {
  /**
   * The failing step's lines, so the agent sees *what* failed: each log cut
   * after its last `##[error]`, so the clean-up steps after it do not take the
   * tail, its timestamps taken off, and capped at sixty lines.
   */
  it("hands the agent the end of each failed job's log, up to its error", async () => {
    set({ checks: NO_CI, runs: [run(101, "CI", "completed", "failure")] });
    const body = Array.from({ length: 70 }, (_, i) => `2026-10-08T10:00:${String(i).padStart(2, "0")}.0000000Z line ${i + 1}`);
    github.jobLogs.set(101, [
      [
        ...body,
        "2026-10-08T10:01:10.0000000Z ##[error]Process completed with exit code 1.",
        "2026-10-08T10:01:11.0000000Z Post job cleanup.",
        "",
      ].join("\n"),
    ]);
    const { evidence } = await collect();
    const lines = evidence.split("\n");
    const start = lines.indexOf("### Failure output: CI");

    expect(start).toBeGreaterThan(-1);
    expect(lines[start + 1]).toBe("```");
    expect(lines[start + 2]).toBe("line 12");
    expect(lines[start + 61]).toBe("##[error]Process completed with exit code 1.");
    expect(lines[start + 62]).toBe("```");
    expect(evidence).not.toContain("Post job cleanup");
  });

  /**
   * A log that cannot be had (expired, still uploading) is said, and the runs
   * after it are still tailed. An `Agent …` run is not tailed at all.
   */
  it("keeps collecting when a failed run's log cannot be read", async () => {
    set({
      runs: [run(101, "CI", "completed", "failure"), run(102, "Agent Review", "completed", "failure"), run(103, "Corpus", "completed", "failure")],
    });
    github.jobLogs.set(103, ["2026-10-08T10:00:00.0000000Z corpus broke\n"]);
    const { evidence, log } = await collect({ fail: [{ method: "failedJobLogs", how: "unreachable", to: 1 }] });

    expect(evidence).toContain("### Failure output: CI");
    expect(evidence).toContain("(no failure log available for run 101)");
    expect(evidence).toContain("### Failure output: Corpus");
    expect(evidence).not.toContain("Agent Review");
    expect(log).toContain("--- collected CI context ---");
    expect(log).toContain("### Failure output: Corpus");
  });

  it("names a run that has no name by its id", async () => {
    set({ checks: NO_CI, runs: [run(109, "", "completed", "failure")] });
    github.jobLogs.set(109, ["2026-10-08T10:00:00.0000000Z broke\n"]);

    expect((await collect()).evidence).toContain("### Failure output: run 109\n```\nbroke\n```");
  });
});

describe("review:collect-checks leaves the loop's own jobs out", () => {
  /**
   * Bounded at both ends, or the exclusion eats the CI it exists to collect.
   * `tests/workflows.test.ts` holds the pattern to every job name the loop
   * produces; these are the names it must not swallow.
   */
  it("matches either half of a name, and nothing that merely starts or ends near one", () => {
    for (const name of ["review / review", "agent-review / post-review", "agent-review / advance", "fix"]) {
      expect(name).toMatch(AGENT_CHECKS);
    }
    for (const name of ["fixtures", "CI", "CI / verify", "CI / fix-lint", "build / fixtures", "CI / post", "advanced"]) {
      expect(name).not.toMatch(AGENT_CHECKS);
    }
  });

  /**
   * `follow-ups` runs only on a closed pull request, so its check run never
   * meets this wait, and the pattern stopped naming it (#224). Every other
   * job of the loop's, bare or under a caller job, is still matched.
   */
  it("does not name follow-ups, and still names every other job of the loop's", () => {
    expect("follow-ups / follow-ups").not.toMatch(AGENT_CHECKS);
    expect("follow-ups").not.toMatch(AGENT_CHECKS);
    for (const job of ["review", "time-limit", "red-check", "post-review", "advance", "fix", "update-branch", "implement-prd", "implement"]) {
      expect(job).toMatch(AGENT_CHECKS);
      expect(`${job} / ${job}`).toMatch(AGENT_CHECKS);
      expect(`agent-caller / ${job}`).toMatch(AGENT_CHECKS);
    }
  });

  /** The caller's own name is compared as a literal, never as a pattern: a `.` in a job id matches only a `.`. */
  it("drops its own check run by the name the caller states, as written", async () => {
    set({ checks: [running("ci.gate", "in_progress"), running("ciXgate", "in_progress"), done("verify")] });
    const { evidence } = await collect({ inputs: INPUTS({ SELF_CHECK: "ci.gate" }) });

    expect(evidence).not.toContain("- ci.gate:");
    expect(evidence.split("\n")).toContain("- ciXgate: in_progress");
    expect(evidence).toContain("Still running after 15 minutes: 1 check(s)");
  });

  it("refuses a reviewed commit that is not one, before reading anything", async () => {
    await expect(collect({ inputs: INPUTS({ REVIEWED_SHA: "main" }) })).rejects.toThrow('REVIEWED_SHA is "main", which is not a commit.');
    expect(reads).toHaveLength(0);
    expect(files.size).toBe(0);
  });
});
