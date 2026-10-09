import type { CheckRun, GitHubReader, LatestStatus, WorkflowRun } from "../engine/read.js";
import type { ReadingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { VERDICT_CONTEXT } from "../shared/record.js";

type Inputs = InputValues<(typeof COMMANDS)["review:collect-checks"]["inputs"]>;
type Io = ReadingIo<(typeof COMMANDS)["review:collect-checks"]["outputs"]>;

/**
 * The ceiling on the wait, and not a fixed wait: it ends as soon as nothing it
 * can see is pending. Reaching it reads `unknown`, never `red`. The review's
 * time limit is this plus its own, so the `time-limit` job adds the same
 * figure as `CI_WAIT_MINUTES`, and `tests/workflows.test.ts` holds the two
 * equal.
 */
export const CI_WAIT_SECONDS = 900;

/**
 * How long the wait keeps looking when no CI has reported at all, because a
 * run is created a moment after the push that starts it (#221). Never longer
 * than the ceiling.
 */
export const GRACE_SECONDS = 60;

/** How long it sleeps between looks. */
export const POLL_SECONDS = 20;

/**
 * The loop's own jobs, which are not CI. A called workflow's job appears as
 * `<caller job id> / <called job id>`, so `agent-fix.yml` produces `fix / fix`.
 * The pattern matches a name whose *either* half is an agent job, because the
 * two halves are owned by different people: the second is a job id in one of
 * the reusable files and cannot change under an adopter, the first is whatever
 * they called their caller job. `^(…)$` alone stopped matching every sibling
 * the moment the loop was split, which put a queued `fix` back in the wait:
 * review would burn the full ceiling on a job that cannot start until review
 * ends, then review on degraded evidence after all.
 *
 * Still bounded at both ends, which is the point of anchoring at all:
 * `fixtures`, `CI / fix-lint` and `build / fixtures` are repo checks, not
 * agents, and none of them match.
 *
 * - `follow-ups` is **not** named (#224): that workflow fires only on a closed
 *   pull request (#50), and this wait runs on an open one, so its check run
 *   can never be here to exclude.
 * - `post-review` (#257) and `advance` (PRD #222) run after the review job, so
 *   a review never waits on its own, but a later round on the same head would
 *   read them as CI, as it would under a renamed caller job. `post-review`
 *   rather than `post`, so a repository's own CI job called `post` is still CI.
 *   `( / |$)` keeps `advance` from matching a name that goes on past it.
 * - `time-limit` (#220) has finished by the time this reads anything, and a
 *   job that sums two numbers is not CI.
 * - `red-check` (#231) is **never** CI: it runs the PR's tests against the
 *   merge-base, where a fix's new test is meant to fail, so its check run
 *   reading red is the check working. Counted here, it would turn the result
 *   red on every PR it found a red test on. Its report reaches the review
 *   instead.
 */
export const AGENT_CHECKS = /(^|\/ )(review|time-limit|red-check|post-review|advance|fix|update-branch|implement-prd|implement)( \/ |$)/;

/** A caller of one of the loop's reusable workflows, by the path it calls. */
const LOOP_WORKFLOW = /^[^/]+\/agent-workflows\/\.github\/workflows\//;

/** One surface's answer, before `none` is read as green. */
type Word = "green" | "red" | "unknown" | "none";

/** A workflow run with what the wait and the word read off it. */
interface Run extends WorkflowRun {
  /** It needs a maintainer to approve it, or a protection rule holds it. */
  readonly awaiting: boolean;
  /** It completed with a conclusion a check run would read as red, approval aside. */
  readonly failed: boolean;
}

/** Which of the commit's check runs, statuses and workflow runs are CI, and not the loop's own. */
interface Filters {
  readonly check: (run: CheckRun) => boolean;
  readonly status: (status: LatestStatus) => boolean;
  readonly run: (run: WorkflowRun) => boolean;
}

/**
 * `review:collect-checks` (#421): waits for the pull request's other checks
 * on the reviewed commit, then hands the agent their results.
 *
 * Why: a review running while CI is still going has no evidence beyond the
 * diff, so it reasons from the issue's spec. That is exactly how a review once
 * certified a rule "corpus-safe" 96 seconds before the corpus failed with 13
 * false positives from that very rule. Waiting alone would not have helped:
 * the *results* have to reach the prompt.
 *
 * Three surfaces, because each sees something the others cannot: check runs,
 * commit statuses for CI outside Actions, and the commit's workflow runs, the
 * only place a run that is queued or waiting for approval shows (#221).
 *
 * Two files, and the runner reads them apart. `ci_status.md` is evidence, the
 * prose the agent reads. `ci_result.txt` is one word, `green`, `red` or
 * `unknown`, the CI half of the verdict the runner derives (#96), so the
 * derivation never parses prose. `unknown` is not folded into `red`: a review
 * that could not see the checks has not seen a failure, it has seen nothing.
 * Both send a finding-free review to a human, and they say different things
 * about why. A command that dies before writing leaves no word at all, which
 * the runner reads as `unknown` too.
 *
 * It never fails on GitHub: missing CI context degrades the review, it does
 * not invalidate it. Every read that fails is said in the log, with what
 * GitHub answered, and in the evidence where the agent is missing something
 * for it, and reads as `unknown`, never as green.
 */
export const collectChecks = async (inputs: Inputs, io: Io): Promise<void> => {
  const sha = inputs.REVIEWED_SHA;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`REVIEWED_SHA is ${JSON.stringify(sha)}, which is not a commit.`);
  const filters: Filters = {
    // This job's own check run, by the exact name the caller states, as well
    // as by the pattern. The overlap is deliberate: the pattern is a heuristic
    // over names nobody declares, and self-exclusion is the case with no
    // error to read when it is wrong. Compared as a literal: a job id is not
    // a pattern, and a `.` in one would quietly match a neighbouring check.
    check: (run) => run.name !== inputs.SELF_CHECK && !AGENT_CHECKS.test(run.name),
    // The verdict's own context is this job's answer, not yet written: counted,
    // a `failure` verdict on the previous round would be evidence for the next
    // one, and every "changes recommended" would derive "needs a closer look"
    // one round later, by reading its own answer back.
    status: (status) => status.context !== VERDICT_CONTEXT,
    // The loop's own runs, on `AGENT_CHECKS`'s grounds and three ways, each
    // for a case the others miss: this run by its id (the caller's, since a
    // called workflow contributes no run of its own), an `Agent …` workflow by
    // its name, and a renamed caller by what it calls, which is how `init` and
    // `doctor` recognise one too.
    run: (run) =>
      String(run.id) !== inputs.SELF_RUN_ID &&
      !run.name.startsWith("Agent ") &&
      !run.referencedWorkflows.some((called) => LOOP_WORKFLOW.test(called)),
  };

  const evidence: string[] = [];
  await waitForChecks(io.github, sha, filters, evidence);

  const checks = await checkRunsWord(io.github, sha, filters, evidence);
  const statuses = await statusesWord(io.github, sha, filters);
  const { word: runs, listed } = await workflowRunsWord(io.github, sha, filters, evidence);

  // **No CI at all**, `none` from every surface, stays green (PRD #171, story
  // 58), so an adopter with no CI anywhere is unchanged, but the evidence says
  // plainly that nothing ran (#221): "no failures" is not "CI passed". Every
  // surface, not check runs alone: CI that reports only through commit
  // statuses ran. A PRD PR is no exception (PRD #222): its base is the default
  // branch, so CI configured for it runs on every slice round there.
  if (checks === "none" && statuses === "none" && runs === "none") {
    evidence.push(
      "_No CI ran on this commit: nothing but the loop's own jobs reported on it, so there are no CI results to read here, passing or failing._",
    );
  }
  // One word out of three, and `red` beats `unknown`: a failure that was seen
  // is more than another surface failing to be read, and the three fail
  // independently. `green` needs every one to have answered it.
  const words = [checks, statuses, runs];
  const result = words.includes("red") ? "red" : words.includes("unknown") ? "unknown" : "green";
  const green = (word: Word): string => (word === "none" ? "green" : word);
  console.log(
    `Checks on this commit are: ${result} (check runs ${green(checks)}, commit statuses ${green(statuses)}, workflow runs ${green(runs)}).`,
  );

  await tailFailures(io.github, listed, evidence);

  const text = evidence.map((line) => `${line}\n`).join("");
  io.outputs.writeText("ci_status.md", text);
  io.outputs.writeText("ci_result.txt", `${result}\n`);
  console.log("--- collected CI context ---");
  console.log(text);
};

/**
 * The wait. It ends when nothing it can see is pending, after a short grace
 * period for a run to appear, or at the ceiling.
 *
 * This job is itself a check on the PR, so `gh pr checks --watch` would
 * deadlock waiting on itself, and so would waiting on any sibling agent job:
 * since review joined the per-PR concurrency group, a `fix` labelled
 * mid-review sits queued behind it, and a queued job is a check run that has
 * not completed.
 *
 * Pending is a check run that has not completed and is not `waiting` on an
 * environment's reviewers, a status still `pending`, or a workflow run that
 * has not completed and is not awaiting a human. A run waiting for approval
 * cannot start until a human acts, so waiting for it would spend the whole
 * ceiling on nothing; the word still reads it as unfinished. Runs are counted
 * apart from checks, not summed into them: a running workflow has running
 * check runs too, so one sum would count most CI twice.
 *
 * A check-run read that fails stops the wait at once, says so in the log and
 * in the evidence: waiting cannot fix it, and spinning to the ceiling turns a
 * diagnosable failure into fifteen quiet minutes. A status or run read that
 * fails counts as none pending here; the reads after the wait report it.
 */
const waitForChecks = async (github: GitHubReader, sha: string, filters: Filters, evidence: string[]): Promise<void> => {
  const started = Date.now();
  const deadline = started + CI_WAIT_SECONDS * 1000;
  const grace = started + Math.min(GRACE_SECONDS, CI_WAIT_SECONDS) * 1000;
  for (;;) {
    let checks: readonly CheckRun[];
    try {
      checks = (await github.checkRuns(sha)).filter(filters.check);
    } catch (error) {
      console.log(
        `::error::Could not read check runs for ${sha}. It is not the caller's \`checks: read\` grant: a caller granting less than this job declares fails the run before any job starts, so a token that got this far holds the read (jeffwlawson/agent-workflows docs/ADOPTING.md §4). Reviewing without CI evidence.`,
      );
      console.log("…and this is what GitHub said, which is the part that tells the causes apart:");
      console.log(said(error));
      evidence.push("_Could not read this commit's check runs, so the review below has no CI evidence._");
      return;
    }
    const statuses = (await orNothing(() => github.latestStatuses(sha))).filter(filters.status);
    const runs = (await orNothing(() => github.workflowRuns(sha))).filter(filters.run).map(classify);

    const pending =
      checks.filter((run) => run.status !== "completed" && run.status !== "waiting").length +
      statuses.filter((status) => status.state === "pending").length;
    const runsPending = runs.filter((run) => run.status !== "completed" && !run.awaiting).length;
    if (pending === 0 && runsPending === 0) {
      const seen = checks.length > 0 || statuses.length > 0 || runs.length > 0;
      if (Date.now() < grace && !seen) {
        console.log(`No CI has reported on this commit yet; looking again for up to ${GRACE_SECONDS} s in case a run is still being created…`);
        await sleep(POLL_SECONDS);
        continue;
      }
      return;
    }
    // The ceiling is not a failure (#221). A check still running has not
    // failed, so this reads `unknown` rather than `red`, and the evidence says
    // what it was rather than that something broke.
    if (Date.now() >= deadline) {
      evidence.push(
        `_Still running after ${CI_WAIT_SECONDS / 60} minutes: ${pending} check(s) and ${runsPending} workflow run(s) had not finished, so CI is unknown here rather than failed, and the results below may be incomplete._`,
      );
      return;
    }
    console.log(`Waiting for ${pending} check(s) and ${runsPending} workflow run(s)…`);
    await sleep(POLL_SECONDS);
  }
};

/**
 * The check runs, listed for the agent and reduced to a word. A check that
 * has not *passed* is not green, and one that has not *finished* has not
 * failed either (#221): one still pending at the ceiling is `unknown`. A
 * failure seen beside it still reads `red`.
 */
const checkRunsWord = async (github: GitHubReader, sha: string, filters: Filters, evidence: string[]): Promise<Word> => {
  evidence.push("Checks on this commit:");
  let checks: readonly CheckRun[];
  try {
    checks = (await github.checkRuns(sha)).filter(filters.check);
  } catch (error) {
    evidence.push("- (could not read check runs)");
    console.log(
      `::warning::Could not list check runs for ${sha}, so the review's check list is empty. It is not the \`checks: read\` grant, which a run that started holds. See what GitHub said below.`,
    );
    console.log(
      "::warning::Could not decide whether this commit's check runs are green, so the verdict below will ask for a human rather than claim the pull request is ready.",
    );
    console.log(said(error));
    return "unknown";
  }
  for (const run of checks) evidence.push(`- ${run.name}: ${run.conclusion ?? run.status}`);
  if (checks.length === 0) return "none";
  if (checks.some((run) => run.status === "completed" && !["success", "neutral", "skipped"].includes(run.conclusion ?? ""))) return "red";
  if (checks.some((run) => run.status !== "completed")) return "unknown";
  return "green";
};

/**
 * The **other** CI surface, which check runs are not (#105). A repository
 * whose CI reports through the commit-status API, most things outside Actions,
 * has no check run to read at all, so a word over check runs alone calls that
 * commit green and can recommend approving a red one. The latest status per
 * context, since a context that went `pending → success` is one status, not
 * two. `pending` is `unknown`, for the reason a check run still running is.
 */
const statusesWord = async (github: GitHubReader, sha: string, filters: Filters): Promise<Word> => {
  let statuses: readonly LatestStatus[];
  try {
    statuses = (await github.latestStatuses(sha)).filter(filters.status);
  } catch (error) {
    console.log(
      "::warning::Could not read this commit's statuses, so the verdict below will ask for a human rather than claim the pull request is ready. What GitHub said is below.",
    );
    console.log(said(error));
    return "unknown";
  }
  if (statuses.length === 0) return "none";
  if (statuses.some((status) => status.state === "failure" || status.state === "error")) return "red";
  if (statuses.some((status) => status.state === "pending")) return "unknown";
  return "green";
};

/**
 * The **workflow runs** (#221), for the word, for the evidence and for the
 * failure-log tail. The only surface on which a run waiting for approval shows
 * at all, so it is the one that keeps such a commit from reading green: a run
 * that never started has failed nothing and passed nothing, and the evidence
 * names it with a link a maintainer can approve it from.
 *
 * A run that completed without passing is `red` here as well as in the check
 * runs, because not every such run has a check run to fail: a
 * `startup_failure` creates no job at all. A run still going at the ceiling is
 * `unknown`, as a check run is. Unreadable is `unknown` too: green needs every
 * surface to have answered, and a run waiting for approval would be missing
 * from the other two without a word. It is not the grant: the job declares
 * `actions: read`, so a caller short of it is refused before any job starts
 * (#146).
 */
const workflowRunsWord = async (
  github: GitHubReader,
  sha: string,
  filters: Filters,
  evidence: string[],
): Promise<{ readonly word: Word; readonly listed: readonly Run[] }> => {
  let runs: readonly Run[];
  try {
    runs = (await github.workflowRuns(sha)).filter(filters.run).map(classify);
  } catch (error) {
    console.log(
      "::warning::Could not list this commit's workflow runs, so a run waiting for approval could not be seen and the review has no failure-log output. It is not the `actions: read` grant, which a run that started holds. What GitHub said is below.",
    );
    console.log(said(error));
    evidence.push(
      "_Could not list this commit's workflow runs, so a run waiting for approval or still going could not be seen here, and failure-log output is missing rather than absent._",
    );
    return { word: "unknown", listed: [] };
  }

  const failed = runs.filter((run) => run.failed);
  if (failed.length > 0) {
    evidence.push("", "_Workflow runs that did not pass:_", ...failed.map((run) => `- ${run.name}: ${String(run.conclusion)}, ${run.url}`));
  }
  const awaiting = runs.filter((run) => run.awaiting);
  if (awaiting.length > 0) {
    console.log("::warning::A CI run on this commit is waiting for approval, so CI is unknown here rather than green.");
    evidence.push(
      "",
      "_CI waiting for approval: these runs have not run, so CI is unknown here rather than green. A push made with `GITHUB_TOKEN` starts runs that wait for a maintainer to approve them (jeffwlawson/agent-workflows docs/ADOPTING.md §1)._",
      ...awaiting.map((run) => `- ${run.name}: waiting for approval, ${run.url}`),
    );
  }

  const word: Word =
    runs.length === 0
      ? "none"
      : failed.length > 0
        ? "red"
        : runs.some((run) => run.awaiting || run.status !== "completed")
          ? "unknown"
          : "green";
  return { word, listed: runs };
};

/** How many lines of each failed run's log the agent gets. */
const TAIL_LINES = 60;

/**
 * The failing jobs' logs, so the agent sees *what* failed, not merely that
 * something did, capped so a noisy failure cannot swamp the prompt. Read off
 * the workflow runs listed above, so excluded on the same grounds: a failed
 * `Agent Fix` says nothing about this diff, and its lines crowd out the CI
 * failure that does. A listing that failed lists nothing here and has already
 * said so in the evidence.
 *
 * Each log is cut after its last `##[error]` line, which is the step that
 * failed, so the steps that tidy up after it do not take the tail, and the
 * timestamp is taken off each line. A log that cannot be read (expired, still
 * uploading) is said, and the runs after it are still tailed.
 */
const tailFailures = async (github: GitHubReader, runs: readonly Run[], evidence: string[]): Promise<void> => {
  for (const run of runs) {
    if (run.conclusion !== "failure") continue;
    let lines: string[] = [];
    try {
      for (const log of await github.failedJobLogs(run.id)) {
        const own = log.split(/\r?\n/).map((line) => line.replace(/^[^Z]*Z /, ""));
        while (own.length > 0 && own.at(-1) === "") own.pop();
        const error = own.findLastIndex((line) => line.includes("##[error]"));
        lines.push(...(error === -1 ? own : own.slice(0, error + 1)));
      }
    } catch {
      lines = [];
    }
    evidence.push(
      "",
      `### Failure output: ${run.name === "" ? `run ${run.id}` : run.name}`,
      "```",
      ...(lines.length === 0 ? [`(no failure log available for run ${run.id})`] : lines.slice(-TAIL_LINES)),
      "```",
    );
  }
};

/**
 * A run is `awaiting` when it needs a maintainer to approve it
 * (`action_required`, as a status or a conclusion) or a protection rule holds
 * it (`waiting`), and `failed` when it completed with any conclusion but
 * success, neutral, skipped or approval.
 */
const classify = (run: WorkflowRun): Run => ({
  ...run,
  awaiting: run.status === "action_required" || run.status === "waiting" || run.conclusion === "action_required",
  failed: run.status === "completed" && !["success", "neutral", "skipped", "action_required"].includes(run.conclusion ?? ""),
});

/** What `read` returns, or nothing where it fails: the reads after the wait say why. */
const orNothing = async <T>(read: () => Promise<readonly T[]>): Promise<readonly T[]> => {
  try {
    return await read();
  } catch {
    return [];
  }
};

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sleep = (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
