import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

const reviewJob = (): { readonly env?: Record<string, string>; readonly steps?: readonly Step[] } => {
  const jobs = Object.values((parse(fs.readFileSync(REVIEW, "utf8")) as Workflow).jobs);

  expect(jobs).toHaveLength(1);
  return jobs[0] as { readonly env?: Record<string, string>; readonly steps?: readonly Step[] };
};

const waitStep = (): Step => {
  const step = (reviewJob().steps ?? []).find((s) => (s.name ?? "").startsWith("Wait for other checks"));

  expect(step).toBeDefined();
  return step as Step;
};

const onPath = (command: string): boolean =>
  process.platform === "win32"
    ? spawnSync("where", [command]).status === 0
    : spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;

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
}

/**
 * Executes the step's `run:` block the way the runner does: written to a file
 * and handed to `bash -e`, with the step's own `env:` block around it.
 */
const runWaitStep = (options: {
  readonly pages?: readonly unknown[];
  readonly waitSeconds?: string;
  readonly unreadable?: "403" | "unreachable";
  readonly failedRuns?: readonly { readonly id: number; readonly name: string }[];
  readonly gh?: string;
  readonly extraEnv?: Record<string, string>;
}): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-ci-"));
  const script = path.join(temp, "step.sh");
  const pages = path.join(temp, "check-runs.json");
  const runs = path.join(temp, "runs.json");

  fs.writeFileSync(script, waitStep().run ?? "");
  fs.writeFileSync(pages, JSON.stringify(options.pages ?? [PAGE_ONE, page(PAGE_TWO)]));
  fs.writeFileSync(runs, JSON.stringify((options.failedRuns ?? []).map((run) => ({ ...run, conclusion: "failure" }))));

  const ghDir = path.resolve(options.gh ?? REPLAY_DIR);
  // The checkout may not carry the execute bit (Windows, or an archive).
  for (const file of fs.readdirSync(ghDir)) fs.chmodSync(path.join(ghDir, file), 0o755);

  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...resolved(waitStep().env ?? {}),
      ...(options.waitSeconds === undefined ? {} : { WAIT_SECONDS: options.waitSeconds }),
      GH_REPO,
      GH_TOKEN: "test-token",
      RUNNER_TEMP: temp,
      GH_REPLAY_PAGES: pages,
      GH_REPLAY_RUNS: runs,
      ...(options.unreadable === undefined ? {} : { GH_REPLAY_FAILURE: options.unreadable }),
      PATH: `${ghDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      ...options.extraEnv,
    },
  });

  const collected = path.join(temp, "ci_status.md");

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    evidence: fs.existsSync(collected) ? fs.readFileSync(collected, "utf8") : "",
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
      { encoding: "utf8", env: { ...process.env, GH_TOKEN: "test-token" } },
    );

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("the `--slurp` option is not supported with `--jq` or `--template`");
  });

  /**
   * …and the same binary accepts every call the step actually composes. The
   * real `gh` is put on PATH behind a wrapper that keeps its stderr (the step
   * sends it to `/dev/null`, which is how an invalid invocation stayed
   * invisible for a release) and pointed at `localhost`, where the connection
   * is refused the moment a request is attempted. Reaching *that* error is the
   * assertion: it means the flags parsed.
   */
  it.skipIf(!onPath("gh"))("every gh call the step composes is one gh accepts", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-gh-"));
    const log = path.join(temp, "gh-stderr.log");
    const real = execFileSync("bash", ["-c", "command -v gh"], { encoding: "utf8" }).trim();

    fs.writeFileSync(path.join(temp, "gh"), `#!/usr/bin/env bash\nexec "${real}" "$@" 2>>"${log}"\n`);
    const outcome = runWaitStep({ gh: temp, waitSeconds: "0", extraEnv: { GH_HOST: "localhost" } });
    const stderr = fs.readFileSync(log, "utf8");

    // Live rather than vacuous: gh got as far as building the request.
    expect(stderr).toContain("check-runs");
    expect(stderr).not.toContain("is not supported with");
    // Unreachable host, so the step still reports itself blind — loudly.
    expect(outcome.stdout).toContain("::error::Could not read check runs");
  });

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
    // The `::error::` names the grant, which is one of three causes it now
    // has. What tells them apart is gh's own stderr, which reaches the log
    // only because the step stopped sending it to `/dev/null`.
    expect(outcome.stdout).toContain(said);
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
    expect(outcome.evidence).toContain("### Failure output — CI");
    expect(outcome.evidence).toContain("### Failure output — Corpus");
    expect(outcome.evidence).toContain("(no failure log available for run 101)");
    // Excluded by the `Agent ` prefix, on the same grounds as AGENT_CHECKS.
    expect(outcome.evidence).not.toContain("Agent Review");
    // The end of the script, which is the whole point: reaching it means the
    // step handed the agent everything rather than stopping where it stood.
    expect(outcome.stdout).toContain("--- collected CI context ---");
    expect(outcome.stdout).toContain("### Failure output — Corpus");
  });
});
