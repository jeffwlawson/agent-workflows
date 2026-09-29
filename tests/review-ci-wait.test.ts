import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The bound every synchronous spawn below carries, and — since #144 — the whole
 * suite's `testTimeout` as well, which is why it is imported rather than written
 * here. The tests that spawn the real `gh` are what first needed it: none of
 * them reaches a network (gh refuses at flag-parse time or at a connection to
 * `localhost`), so their cost is starting a cold Go binary, which under a
 * parallel `verify` ran past vitest's 5-second default (#139). Every spawn
 * still takes it, because vitest's timeout cannot interrupt a synchronous one.
 *
 * A single-spawn test passes it to `it()` no longer: the suite-wide ceiling is
 * that same figure, so the argument would be a second copy saying nothing. The
 * two tests below that spawn *twice* do carry a ceiling, written as a multiple
 * of this figure rather than as a number — a ceiling under the sum of its
 * children's bounds fails while every one of them is still inside its own, and
 * reports the limit instead of the command.
 */
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs `agent-review`'s CI-collection step — the real `run:` block, read out of
 * `.github/workflows/review.yml` — against a recorded `gh`.
 *
 * Everything else in `tests/workflows.test.ts` asserts over the *text* of these
 * workflows, which is the right tool for "do the two halves agree" and the
 * wrong one for "does this command run". `--paginate --slurp --jq` is an
 * invocation `gh` refuses outright; it passed review, the tests and CI, shipped
 * in v0.1.5, and collected no CI evidence for a day before anyone noticed the
 * reviews were blind (#28). Three checks held it green, and all three matched
 * strings.
 *
 * So this file executes instead:
 *
 *  - the composed script runs under `bash -e`, which is the shell GitHub gives
 *    a `run:` block that declares no `shell:` — `bash -e {0}`. That `-e` is not
 *    a detail: it is why the step has been dying *before* its own `::error::`
 *    since v0.1.5, and why every affected review said "no checks reported"
 *    rather than the "could not read this commit's check runs" sentence the arm
 *    writes;
 *  - `gh` is a replay (`tests/fixtures/gh-replay/gh`) that refuses any
 *    invocation it has no recording for, so a call this file has never seen
 *    fails loudly rather than being improvised;
 *  - and the one recorded behaviour everything here rests on — that gh rejects
 *    `--slurp` alongside `--jq` — is re-verified against the installed `gh`
 *    below, so the replay cannot drift away from the binary it stands in for.
 *
 * Skipped where `bash`, `jq` or `node` are not on PATH: this is authored on
 * Windows and gated on Linux CI, where all three are present and the coverage
 * is real.
 */

const REVIEW = path.join(".github", "workflows", "review.yml");
const REPLAY_DIR = path.join("tests", "fixtures", "gh-replay");

interface Step {
  readonly name?: string;
  readonly shell?: string;
  readonly env?: Record<string, string>;
  readonly run?: string;
}
interface Workflow {
  readonly jobs: Record<string, { readonly env?: Record<string, string>; readonly steps?: readonly Step[] }>;
}

/**
 * The `review` job by id. Since #133 the file has a second job, `resolve`,
 * which runs no wait.
 */
const reviewJob = (): { readonly env?: Record<string, string>; readonly steps?: readonly Step[] } => {
  const job = (parse(fs.readFileSync(REVIEW, "utf8")) as Workflow).jobs["review"];

  expect(job).toBeDefined();
  return job as { readonly env?: Record<string, string>; readonly steps?: readonly Step[] };
};

const waitStep = (): Step => {
  const step = (reviewJob().steps ?? []).find((s) => (s.name ?? "").startsWith("Wait for other checks"));

  expect(step).toBeDefined();
  return step as Step;
};

/**
 * Bounded like every other spawn here, and the one place it matters most: this
 * runs at module scope for `CAN_RUN` and again in each `it.skipIf`, so a hang is
 * outside any test body and no `testTimeout` could reach it. A killed spawn
 * reports `null` rather than `0`, so an overrun skips the suite — the same
 * answer as the tool being absent — instead of stalling the run.
 */
const onPath = (command: string): boolean =>
  process.platform === "win32"
    ? spawnSync("where", [command], { timeout: SUBPROCESS_TIMEOUT }).status === 0
    : spawnSync("sh", ["-c", `command -v ${command}`], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

const CAN_RUN = ["bash", "jq", "node"].every(onPath);

/**
 * The values the workflow gets from the event, which the harness has to supply
 * in its place. Every `${{ … }}` in the step's `env:` must be listed: an
 * expression this map does not know about throws rather than expanding to the
 * empty string, so a new one cannot quietly turn a scenario into a test of
 * nothing.
 */
const HEAD_SHA = "35da2fc0e3a94c2d8b1b0e4e9f1c2d3a4b5c6d7e";
const SELF_CHECK = "review / review";
const GH_REPO = "acme/widgets";
const EXPRESSIONS: Readonly<Record<string, string>> = {
  "${{ github.event.pull_request.head.sha }}": HEAD_SHA,
  "${{ inputs.self-check }}": SELF_CHECK,
};

/**
 * A commit status, as the combined endpoint returns one. The loop's own verdict
 * posts under `agent-review`, which is the context the step must skip: it is
 * the answer this very job is about to write, so counting it would make one
 * round's verdict part of the evidence for the next one's.
 */
const status = (context: string, state: string): Record<string, unknown> => ({ context, state });
const statusPage = (statuses: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  state: "success",
  total_count: statuses.length,
  statuses,
});

const resolved = (env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      const literal = EXPRESSIONS[value] ?? value;

      if (literal.includes("${{")) throw new Error(`no test value for ${key}: ${value}`);
      return [key, literal];
    }),
  );

/**
 * A page of the check-runs endpoint, in the shape it actually returns:
 * `{"total_count":N,"check_runs":[{"name","status","conclusion"},…]}`. A
 * `conclusion` is `null` until the run completes.
 */
const page = (checkRuns: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  total_count: checkRuns.length,
  check_runs: checkRuns,
});
const done = (name: string, conclusion = "success"): Record<string, unknown> => ({
  name,
  status: "completed",
  conclusion,
});
const running = (name: string, status: string): Record<string, unknown> => ({ name, status, conclusion: null });

/**
 * Two pages, because one page hides the bug this file is about: with 30 check
 * runs on the first page and two on the second, a filter applied *per page*
 * prints one count per page and none of them is the total.
 *
 * Page one holds this job's own check run and a sibling agent's — both
 * excluded, and both non-completed, so a wait that failed to exclude them would
 * never end.
 */
const PAGE_ONE = page([
  running(SELF_CHECK, "in_progress"),
  running("fix / fix", "queued"),
  ...Array.from({ length: 28 }, (_, i) => done(`unit-${String(i + 1).padStart(2, "0")}`)),
]);
const PAGE_TWO = [done("verify"), done(".github/dependabot.yml")];

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** What the step collected for the agent — `RUNNER_TEMP/ci_status.md`. */
  readonly evidence: string;
  /**
   * And the one word the verdict is derived from — `RUNNER_TEMP/ci_result.txt`.
   * Empty when the step wrote none, which the runner reads as `unknown` too.
   */
  readonly ciResult: string;
}

/**
 * Executes the step's `run:` block the way the runner does: written to a file
 * and handed to `bash -e`, with the step's own `env:` block around it.
 */
const runWaitStep = (options: {
  readonly pages?: readonly unknown[];
  readonly waitSeconds?: string;
  readonly unreadable?: "403" | "unreachable";
  /**
   * The check-runs call at which `unreadable` starts biting, 1-based and
   * counted across the whole step. The count polls that endpoint once per
   * iteration and the listing hits it once more with identical argv, so this
   * is the only way to express "the count answered and the listing did not".
   */
  readonly unreadableFrom?: number;
  /**
   * The commit's statuses — the *other* CI surface, which check runs do not
   * cover. Default: a commit carrying none, which is every repository whose CI
   * is Actions and what the check-run scenarios want standing behind them.
   */
  readonly statuses?: readonly Record<string, unknown>[];
  /** How the combined-status call fails, when the scenario is about that. */
  readonly statusesUnreadable?: "403" | "unreachable";
  readonly failedRuns?: readonly { readonly id: number; readonly name: string }[];
  /** How the workflow-runs listing fails, when the scenario is about that. */
  readonly runsUnreadable?: "403" | "unreachable";
  readonly gh?: string;
  /**
   * The pull request's head branch — the job's `BRANCH`, which the step reads
   * to tell a slice PR from an ordinary one. Default: an ordinary branch.
   */
  readonly branch?: string;
  readonly extraEnv?: Record<string, string>;
}): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-ci-"));
  const script = path.join(temp, "step.sh");
  const pages = path.join(temp, "check-runs.json");
  const statusPages = path.join(temp, "statuses.json");
  const runs = path.join(temp, "runs.json");

  fs.writeFileSync(script, waitStep().run ?? "");
  fs.writeFileSync(pages, JSON.stringify(options.pages ?? [PAGE_ONE, page(PAGE_TWO)]));
  fs.writeFileSync(statusPages, JSON.stringify([statusPage(options.statuses ?? [])]));
  fs.writeFileSync(runs, JSON.stringify((options.failedRuns ?? []).map((run) => ({ ...run, conclusion: "failure" }))));

  const ghDir = path.resolve(options.gh ?? REPLAY_DIR);
  // The checkout may not carry the execute bit (Windows, or an archive).
  for (const file of fs.readdirSync(ghDir)) fs.chmodSync(path.join(ghDir, file), 0o755);

  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    // Bounded, because vitest's own timeout cannot interrupt a synchronous
    // spawn. The scenarios that do not override `waitSeconds` run at the
    // workflow's real 900 on purpose — that is what makes `not.toContain
    // ("Waiting for")` mean "stopped" rather than "was not given time to
    // spin" — so an arm that regressed out of its `break` would hang CI for
    // fifteen minutes per case instead of failing it. Well above every
    // scenario's real cost: the rest pass `waitSeconds: "0"`.
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      ...resolved(waitStep().env ?? {}),
      BRANCH: options.branch ?? "feature/widgets",
      ...(options.waitSeconds === undefined ? {} : { WAIT_SECONDS: options.waitSeconds }),
      GH_REPO,
      GH_TOKEN: "test-token",
      RUNNER_TEMP: temp,
      GH_REPLAY_PAGES: pages,
      GH_REPLAY_STATUS_PAGES: statusPages,
      ...(options.statusesUnreadable === undefined
        ? {}
        : { GH_REPLAY_STATUS_FAILURE: options.statusesUnreadable }),
      GH_REPLAY_RUNS: runs,
      ...(options.runsUnreadable === undefined ? {} : { GH_REPLAY_RUNS_FAILURE: options.runsUnreadable }),
      GH_REPLAY_COUNTER: path.join(temp, "check-runs.calls"),
      ...(options.unreadable === undefined ? {} : { GH_REPLAY_FAILURE: options.unreadable }),
      ...(options.unreadableFrom === undefined ? {} : { GH_REPLAY_FAILURE_AT: String(options.unreadableFrom) }),
      PATH: `${ghDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      ...options.extraEnv,
    },
  });

  const collected = path.join(temp, "ci_status.md");
  const verdictHalf = path.join(temp, "ci_result.txt");

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    evidence: fs.existsSync(collected) ? fs.readFileSync(collected, "utf8") : "",
    ciResult: fs.existsSync(verdictHalf) ? fs.readFileSync(verdictHalf, "utf8").trim() : "",
  };
};

describe.skipIf(!CAN_RUN)("agent-review's CI collection, executed", () => {
  /**
   * The harness runs the script under `bash -e` because that is what GitHub
   * does with a `run:` block carrying no `shell:` key. If one is ever added,
   * this harness is testing a different shell from the one in production.
   */
  it("runs under the shell the workflow actually gets", () => {
    expect(waitStep().shell).toBeUndefined();
    expect(reviewJob().env?.["GH_REPO"]).toBe("${{ github.repository }}");
    // Supplied by the harness as `branch`, so it has to be what the job says.
    expect(reviewJob().env?.["BRANCH"]).toBe("${{ github.event.pull_request.head.ref }}");
  });

  /**
   * The contract the replay stands on, checked against the real binary. gh
   * refuses `--slurp` next to `--jq` at flag-parse time — no request is made —
   * so this needs neither a network nor a token.
   */
  it.skipIf(!onPath("gh"))("gh really does refuse --slurp alongside --jq", () => {
    const refused = spawnSync(
      "gh",
      ["api", `repos/${GH_REPO}/commits/${HEAD_SHA}/check-runs`, "--hostname", "localhost", "--paginate", "--slurp", "--jq", "."],
      { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT, env: { ...process.env, GH_TOKEN: "test-token" } },
    );

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("the `--slurp` option is not supported with `--jq` or `--template`");
  });

  /**
   * …and the same binary accepts every call the *wait* composes. The real `gh`
   * is put on PATH behind a wrapper that keeps its stderr (the step sends it
   * to `/dev/null`, which is how an invalid invocation stayed invisible for a
   * release) and pointed at `localhost`, where the connection is refused the
   * moment a request is attempted. Reaching *that* error is the assertion: it
   * means the flags parsed.
   *
   * Five of the step's calls since #107 polled the commit statuses in the
   * wait as well as reading them for the verdict (#105), and it cannot be more
   * than five: an unreachable host fails the runs listing, so the loop over
   * the failed runs it would have named iterates nothing and the two calls in
   * its body are never composed at all.
   * Those two are the sibling test below — they are otherwise seen only by the
   * replay, which is the thing that can drift from the binary.
   */
  it.skipIf(!onPath("gh"))("every gh call the wait composes is one gh accepts", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-gh-"));
    const log = path.join(temp, "gh-stderr.log");
    const real = execFileSync("bash", ["-c", "command -v gh"], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
    }).trim();

    fs.writeFileSync(path.join(temp, "gh"), `#!/usr/bin/env bash\nexec "${real}" "$@" 2>>"${log}"\n`);
    const outcome = runWaitStep({ gh: temp, waitSeconds: "0", extraEnv: { GH_HOST: "localhost" } });
    const stderr = fs.readFileSync(log, "utf8");

    // Live rather than vacuous: gh got as far as building the request — and
    // both endpoints did, since the two are read by separate invocations that
    // can carry separate flags.
    expect(stderr).toContain("check-runs");
    expect(stderr).toContain(`commits/${HEAD_SHA}/status`);
    // Two ways a composed call can be one gh refuses, and only the first has
    // ever happened here. The runs listing below the wait is seen by the real
    // binary *only* through this test — the sibling below spawns the two calls
    // inside its loop, not the listing that feeds it — so a bad flag added
    // there has this assertion and nothing else.
    expect(stderr).not.toContain("is not supported with");
    expect(stderr).not.toContain("unknown flag");
    // Unreachable host, so the step still reports itself blind — loudly.
    expect(outcome.stdout).toContain("::error::Could not read check runs");
    // Two bounded spawns in the body — `command -v gh` above and `runWaitStep`'s
    // own — so the ceiling is two of theirs. At one it could fire while both
    // children were still inside their bounds, and report a limit rather than a
    // command.
  }, 2 * SUBPROCESS_TIMEOUT);

  /**
   * The failure-log tail's two calls, which no run of the step above can put
   * in front of the real binary: they live inside a loop whose own `gh api`
   * has already failed against the dead host. Spawned directly instead, at the
   * same `localhost`, where reaching the connection error is again the
   * assertion that the flags parsed.
   *
   * Each form is asserted to be *the step's* first. A call composed only here
   * would be a test of a command nothing runs — which is the failure mode this
   * whole file exists to answer, one level up.
   */
  it.skipIf(!onPath("gh"))("gh accepts the two calls the failure-log tail composes", () => {
    const run = waitStep().run ?? "";
    const tail = [
      { inStep: 'gh api "repos/${GH_REPO}/actions/runs/${rid}" --jq .name', argv: ["api", `repos/${GH_REPO}/actions/runs/101`, "--jq", ".name"] },
      { inStep: 'gh run view "$rid" --log-failed', argv: ["run", "view", "101", "--log-failed"] },
    ] as const;

    for (const { inStep, argv } of tail) {
      expect(run).toContain(inStep);

      const attempt = spawnSync("gh", [...argv], {
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT,
        // `GH_REPO` is gh's own repo override, and it is what makes the bare
        // `gh run view` above resolve a repo at all: the step runs it with no
        // `-R` and from a checkout of a different repository.
        env: { ...process.env, GH_TOKEN: "test-token", GH_HOST: "localhost", GH_REPO },
      });

      expect(attempt.status).not.toBe(0);
      expect(attempt.stderr).not.toContain("unknown flag");
      expect(attempt.stderr).not.toContain("is not supported with");
      expect(attempt.stderr).toContain("connection refused");
    }
    // One bounded spawn per `tail` entry, and there are two — same arithmetic as
    // the test above.
  }, 2 * SUBPROCESS_TIMEOUT);

  /**
   * The count is **one number over every page**. Per page it is one number per
   * page, which the non-numeric arm reads as an API failure — so this scenario
   * fails as an unreadable API rather than as a miscount, and the assertion is
   * that nothing here looks like a failure at all.
   */
  it("waits for no check when every non-agent check has finished", () => {
    const outcome = runWaitStep({ waitSeconds: "0" });

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).not.toContain("::error::");
    expect(outcome.stdout).not.toContain("Waiting for");
    expect(outcome.evidence).not.toContain("no CI evidence");
    // Zero seconds is how this scenario avoids hanging for the real 900 if the
    // count ever regresses — so the count has to be asserted to be *zero*, not
    // merely to have stopped. Without this a miscount would pass through the
    // deadline branch and look exactly like nothing pending.
    expect(outcome.evidence).not.toContain("Timed out");
  });

  /**
   * Both pages reach the agent, and no agent job does.
   *
   * Whole lines, not substrings: gh's `--jq` prints a string result unquoted
   * and standalone `jq` does not, so a pipe that forgot `-r` would hand the
   * agent `"- verify: success"` — which contains every substring this test
   * could otherwise have asked for.
   */
  it("hands the agent every non-agent check on the commit", () => {
    const { evidence } = runWaitStep({ waitSeconds: "0" });
    const lines = evidence.split("\n");

    expect(evidence).not.toContain("Timed out");

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
   * A check still running on the *second* page is the case the per-page filter
   * cannot report: it prints `0` for page one and `1` for page two, and the
   * step reads the pair as no answer at all. Waiting zero seconds so the count
   * is asserted through the timeout message rather than through a sleep.
   */
  it("counts a pending check on a later page as one number", () => {
    const outcome = runWaitStep({
      pages: [PAGE_ONE, page([...PAGE_TWO, running("deploy", "in_progress")])],
      waitSeconds: "0",
    });

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).not.toContain("::error::");
    expect(outcome.evidence).toContain("Timed out waiting for 1 check(s)");
    // A check that has not passed has not passed: the verdict reads a still
    // pending one with the failures rather than waiting for it a second time.
    expect(outcome.ciResult).toBe("red");
  });

  /**
   * The verdict's CI half (#96), which is the same check runs reduced to one
   * word. It is a *separate* pass over the API rather than a parse of the
   * evidence above, so it gets its own scenarios: the derivation reads anything
   * but `green` as "a human is needed", and a word that said `green` on a
   * commit whose checks are red is the one failure here that ends in a merge.
   */
  it.each([
    ["green when every non-agent check passed", "success", "green"],
    ["red when one of them failed", "failure", "red"],
    ["green for a check that was neutral", "neutral", "green"],
    ["green for a check that was skipped", "skipped", "green"],
  ])("is %s", (_case: string, conclusion: string, expected: string) => {
    const outcome = runWaitStep({
      pages: [PAGE_ONE, page([...PAGE_TWO, done("deploy", conclusion)])],
      waitSeconds: "0",
    });

    expect(outcome.status).toBe(0);
    expect(outcome.ciResult).toBe(expected);
  });

  /**
   * And the agent jobs are excluded from it on exactly the grounds they are
   * excluded from the wait: a sibling agent job queued behind this one is not
   * evidence about the diff, and reading its `queued` as a red check would send
   * every review with a pending `fix` to a human.
   */
  it("is green when the only unfinished checks are agent jobs", () => {
    expect(runWaitStep({ waitSeconds: "0" }).ciResult).toBe("green");
  });

  /**
   * And the other CI surface (#105). Check runs are an Actions concept; a
   * repository whose CI reports through the commit-status API has none to
   * read, so a word derived from check runs alone calls that commit green and
   * lets the review recommend approving a red one.
   */
  it.each([
    ["red when a commit status failed", [status("ci/build", "failure")], "red"],
    ["red when one errored", [status("ci/build", "error")], "red"],
    ["red when one is still pending", [status("ci/build", "pending")], "red"],
    ["green when every one of them passed", [status("ci/build", "success")], "green"],
  ])("is %s", (_case: string, statuses: readonly Record<string, unknown>[], expected: string) => {
    expect(runWaitStep({ waitSeconds: "0", statuses }).ciResult).toBe(expected);
  });

  /**
   * With one context skipped, and it is this job's own answer. `agent-review`
   * is the context the verdict is posted under, so counting it would feed the
   * last round's verdict into the next round's evidence: every "changes
   * recommended" — a `failure` status — would derive "needs a closer
   * look" one round later, off nothing but its own reply.
   */
  it("ignores the verdict's own context, which is this job's previous answer", () => {
    const outcome = runWaitStep({
      waitSeconds: "0",
      statuses: [status("agent-review", "failure"), status("ci/build", "success")],
    });

    expect(outcome.ciResult).toBe("green");
  });

  /**
   * And the *wait* reads that surface too (#107). Without it a review that
   * starts before status-based CI finishes reads the status as pending, derives
   * `red`, and asks for a human on a pull request that would have been ready a
   * minute later. Zero seconds, so the count is asserted through the timeout
   * message — the check runs here are all finished or agent jobs, so the one
   * being waited for can only be the status.
   */
  it("waits for a pending commit status like a pending check run", () => {
    const outcome = runWaitStep({ waitSeconds: "0", statuses: [status("ci/build", "pending")] });

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).not.toContain("::error::");
    expect(outcome.evidence).toContain("Timed out waiting for 1 check(s)");
  });

  /**
   * One count over both surfaces, so the timeout names every one still pending
   * rather than whichever half was asked first.
   */
  it("counts pending check runs and pending statuses together", () => {
    const outcome = runWaitStep({
      pages: [PAGE_ONE, page([...PAGE_TWO, running("deploy", "in_progress")])],
      waitSeconds: "0",
      statuses: [status("ci/build", "pending"), status("ci/lint", "pending"), status("ci/docs", "success")],
    });

    expect(outcome.evidence).toContain("Timed out waiting for 3 check(s)");
  });

  /**
   * `agent-review` is this job's own output, so waiting for it would wait for
   * the answer this job has not written yet — the full 900 s on every round
   * after a human re-labels. Run at the real 900 for the same reason the first
   * scenario is: a wait that counted it would spin rather than fail, and the
   * spawn's bound is what would end it.
   */
  it("never waits for the verdict's own context", () => {
    const outcome = runWaitStep({ statuses: [status("agent-review", "pending"), status("ci/build", "success")] });

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).not.toContain("Waiting for");
    expect(outcome.evidence).not.toContain("Timed out");
    expect(outcome.ciResult).toBe("green");
  });

  /**
   * **No CI at all is green on an ordinary pull request, and `unknown` on a
   * slice PR** (#175). A slice PR's base is a PRD branch, so a CI workflow that
   * filters `pull_request` to the base branch never runs on it — and a clean
   * review of code no CI ran on would recommend approving it, which on a slice
   * PR advances the chain onto it. `unknown` sends that review to a human
   * instead, and the evidence line says why and where the fix is.
   *
   * The only check runs here are this job's and a sibling agent's, which is
   * what a commit no CI ran on looks like from inside the review.
   */
  const NO_CI = [page([running(SELF_CHECK, "in_progress"), running("fix / fix", "queued")])];
  const SLICE_BRANCH = "agent/slice-171-175-review-knows-it-is-reading-a-slice-pr";

  it("does not know on a slice PR that no CI ran on", () => {
    const outcome = runWaitStep({ pages: NO_CI, waitSeconds: "0", branch: SLICE_BRANCH });

    expect(outcome.status).toBe(0);
    expect(outcome.ciResult).toBe("unknown");
    expect(outcome.evidence).toContain("No CI ran on this slice PR");
    expect(outcome.evidence).toContain("docs/ADOPTING.md");
    expect(outcome.evidence).toContain("agent/prd-**");
    expect(outcome.stdout).toContain("::warning::No CI ran on this slice PR");
  });

  it("is still green on an ordinary pull request that no CI ran on", () => {
    const outcome = runWaitStep({ pages: NO_CI, waitSeconds: "0" });

    expect(outcome.status).toBe(0);
    expect(outcome.ciResult).toBe("green");
    expect(outcome.evidence).not.toContain("No CI ran");
    expect(outcome.stdout).not.toContain("::warning::");
  });

  /**
   * "No CI ran" is both surfaces empty, not check runs alone: a slice PR whose
   * CI reports through the commit-status API had CI run on it, and a slice PR
   * whose checks ran is an ordinary one as far as this word goes.
   */
  it.each([
    ["CI that reports only a commit status", NO_CI, [status("ci/build", "success")]],
    ["CI that reports check runs", undefined, []],
  ])("is green on a slice PR with %s", (_case, pages, statuses) => {
    const outcome = runWaitStep({
      ...(pages === undefined ? {} : { pages }),
      waitSeconds: "0",
      branch: SLICE_BRANCH,
      statuses,
    });

    expect(outcome.ciResult).toBe("green");
    expect(outcome.evidence).not.toContain("No CI ran");
  });

  /**
   * Unreadable stays `unknown` rather than collapsing into either answer. The
   * two halves fail independently — this one can 403 on a repository whose
   * check runs read fine — and a review that could not see one of them has not
   * seen a failure, it has seen nothing.
   */
  it.each([["403"], ["unreachable"]])(
    "does not know when the statuses cannot be read (%s)",
    (how: string) => {
      // At the real 900: an unreadable status must neither spin the wait nor
      // be blamed on the check runs, which read fine.
      const outcome = runWaitStep({ statusesUnreadable: how as "403" | "unreachable" });

      expect(outcome.status).toBe(0);
      expect(outcome.ciResult).toBe("unknown");
      expect(outcome.stdout).toContain("::warning::Could not read this commit's statuses");
      expect(outcome.stdout).not.toContain("::error::");
      expect(outcome.stdout).not.toContain("Waiting for");
    },
  );

  /**
   * And a failure that *was* seen outranks a half that could not be read: both
   * send the review to a human, and `red` is the one that says why.
   */
  it("is red when one half failed and the other could not be read", () => {
    const outcome = runWaitStep({
      pages: [PAGE_ONE, page([...PAGE_TWO, done("deploy", "failure")])],
      waitSeconds: "0",
      statusesUnreadable: "403",
    });

    expect(outcome.ciResult).toBe("red");
  });

  /**
   * The arm #16 added, which is the only reason any of this was noticed: an
   * unreadable endpoint stops the wait, says so in the log, and says so again
   * in the evidence handed to the agent.
   *
   * Both ways the call can fail, because under `--slurp` they do not look
   * alike on stdout — a 403 writes its error body into the outer array, and a
   * connection failure writes `[]`, which this filter counts as zero. A count
   * read off stdout would call the second one "nothing pending" and review
   * blind without saying so, which is the v0.1.4 defect with a new source.
   *
   * And it has to survive `bash -e` to report anything at all: a `gh` that
   * exits non-zero inside a command substitution otherwise takes the whole
   * step with it, leaving the agent an empty file.
   */
  it.each([
    ["403", "Resource not accessible by integration"],
    ["unreachable", "connection refused"],
  ] as const)("reports itself blind when the check-runs endpoint fails (%s)", (unreadable, said) => {
    const outcome = runWaitStep({ unreadable });

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("::error::Could not read check runs");
    expect(outcome.stdout).toContain("checks: read");
    expect(outcome.evidence).toContain("Could not read this commit's check runs");
    expect(outcome.evidence).toContain("- (could not read check runs)");
    // It stops rather than spinning: one attempt, no sleep, no second count.
    expect(outcome.stdout).not.toContain("Waiting for");
    // The `::error::` names the grant as the one thing this cannot be — a
    // caller short of it is refused before any job starts (#146) — and what
    // tells the causes that remain apart is gh's own stderr, which reaches the
    // log only because the step stopped sending it to `/dev/null`.
    expect(outcome.stdout).toContain(said);
    // And the verdict's half says it does not know, rather than defaulting to
    // the one value that would let the review call a pull request ready.
    expect(outcome.ciResult).toBe("unknown");
    expect(outcome.stdout).toContain("::warning::Could not decide whether this commit's check runs are green");
  });

  /**
   * The listing is its own call and can fail on its own — a transient 5xx, a
   * secondary rate limit, a later change to that filter alone — on a run where
   * the count answered and the arm above therefore never fires. It used to
   * discard its stderr, so that run handed the agent `- (could not read check
   * runs)` and left the log with nothing to say about why.
   *
   * Failing from the *second* check-runs call is what expresses it: the count
   * polls the same endpoint with the same argv, so only the ordinal separates
   * them.
   */
  it("says why when the listing fails on a commit whose count was read", () => {
    const outcome = runWaitStep({ waitSeconds: "0", unreadable: "unreachable", unreadableFrom: 2 });

    expect(outcome.status).toBe(0);
    // The count succeeded, so the wait's own arm is silent — this is the one
    // path on which the listing is the only thing that can report anything.
    expect(outcome.stdout).not.toContain("::error::Could not read check runs");
    expect(outcome.evidence).toContain("- (could not read check runs)");

    expect(outcome.stdout).toContain("::warning::Could not list check runs");
    expect(outcome.stdout).toContain("connection refused");
  });

  /**
   * The failure-log tail, which is the third thing this step collects and the
   * one with the least to say when it breaks. `gh run view --log-failed` exits
   * non-zero whenever a failed run's logs are unavailable — expired, still
   * uploading, a token without `actions: read` — and `pipefail` makes that a
   * failing pipeline inside a group already redirected to the evidence file.
   * Under `bash -e` that ends the step: the runs after this one are never
   * tailed, `cat "$out"` never runs, and `continue-on-error` keeps the job
   * green while the agent reviews from a file that stops mid-sentence.
   *
   * Two failing runs, so the assertion is that the *second* is still reached
   * rather than merely that the first did not kill the process.
   */
  it("keeps collecting when a failed run's log cannot be read", () => {
    const outcome = runWaitStep({
      waitSeconds: "0",
      failedRuns: [
        { id: 101, name: "CI" },
        { id: 102, name: "Agent Review" },
        { id: 103, name: "Corpus" },
      ],
    });

    expect(outcome.status).toBe(0);
    expect(outcome.evidence).toContain("### Failure output: CI");
    expect(outcome.evidence).toContain("### Failure output: Corpus");
    expect(outcome.evidence).toContain("(no failure log available for run 101)");
    // Excluded by the `Agent ` prefix, on the same grounds as AGENT_CHECKS.
    expect(outcome.evidence).not.toContain("Agent Review");
    // The end of the script, which is the whole point: reaching it means the
    // step handed the agent everything rather than stopping where it stood.
    expect(outcome.stdout).toContain("--- collected CI context ---");
    expect(outcome.stdout).toContain("### Failure output: Corpus");
  });

  /**
   * The listing that feeds the tail needs `actions: read`, which the loop does
   * not request (#80), so on a private repository it is refused. Fed straight to
   * `for`, that was silent — or worse: an HTTP error's body reaches stdout
   * unfiltered, and its JSON words were iterated as run ids. The evidence now
   * says the tail is missing rather than absent, and names no remedy: the grant
   * is a trust decision the workflow cannot make.
   */
  it.each([
    ["403", "Resource not accessible by integration"],
    ["unreachable", "connection refused"],
  ] as const)("says the failure logs are missing when the runs cannot be listed (%s)", (runsUnreadable, said) => {
    const outcome = runWaitStep({ waitSeconds: "0", runsUnreadable });

    expect(outcome.status).toBe(0);
    expect(outcome.evidence).toContain("Could not list this commit's workflow runs");
    expect(outcome.evidence).toContain("actions: read");
    expect(outcome.evidence).not.toMatch(/grant|must|required/i);
    // No run id was invented out of the error body.
    expect(outcome.evidence).not.toContain("### Failure output");
    expect(outcome.stdout).toContain("::warning::Could not list this commit's workflow runs");
    expect(outcome.stdout).toContain(said);
    // …and the step still reaches its end.
    expect(outcome.stdout).toContain("--- collected CI context ---");
    // The check runs were read, so the verdict's half is unaffected.
    expect(outcome.ciResult).toBe("green");
  });

  /** A listing that answered with no failed run adds nothing, as before. */
  it("adds no line when the runs were listed and none failed", () => {
    const outcome = runWaitStep({ waitSeconds: "0" });

    expect(outcome.evidence).not.toContain("Could not list this commit's workflow runs");
    expect(outcome.stdout).not.toContain("Could not list this commit's workflow runs");
  });
});
