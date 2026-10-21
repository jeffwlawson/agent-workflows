import * as fs from "node:fs";
import * as path from "node:path";
import { COMMANDS, RUNNERS, type Command, type Runner } from "../shared/contract.js";
import type { HostEnvironment } from "../shared/env.js";
import { PRD_BRANCH_PREFIX } from "../shared/record.js";
import type { DoorRequest, DoorResponse } from "./dispatcher.js";
import { parseJob, reviewTimeLimit, SIGNATURE_HEADER, verifySignature, type Job, type ReviewJob, type TokenKind } from "./job.js";

/**
 * The service orchestrator's worker (#457): it receives jobs from the
 * dispatcher and runs each the way its workflow's reusable does, by running
 * the same subcommands in the same order, each told what the reusable tells
 * it: one run function per job kind, built from shared phase primitives. It writes nothing to the record and spells no record string: every
 * write is a command's. What it reads between them is the hand-over the
 * reusable's glue steps read, `gate.json`, `budget.json`, `verdict.json` and
 * `ended.json`, copied across as they are.
 *
 * Its decisions are here, over edges it is handed: the dispatcher's token
 * door, the launcher that starts a subcommand, git, and the host. `serve.ts`
 * puts them behind HTTP, over the live ones in `worker-live.ts`.
 */

/** A subcommand the worker starts. */
export type Subcommand = Runner | Command;

/**
 * One subcommand to start: its name, its whole environment, where it runs,
 * the file its output goes to, and the signal its time limit aborts, on which
 * it is ended.
 */
export interface Launch {
  readonly subcommand: Subcommand;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly log: string;
  readonly signal: AbortSignal;
}

/**
 * Starts a subcommand of the worker's own package, and answers with its exit
 * code once it has ended, which it is made to where `signal` aborts.
 */
export type Launcher = (launch: Launch) => Promise<number>;

/** The checkout a review runs in. */
export interface Git {
  /**
   * Check `sha` out in `dir`, a directory that does not exist yet, as the
   * local branch `branch`, with `baseRef` fetched as a local branch of the
   * same name beside it. `token` reads `repo`, and is passed with each command
   * that needs it, never stored in the checkout's configuration.
   */
  checkout(options: {
    readonly dir: string;
    readonly repo: string;
    readonly branch: string;
    readonly sha: string;
    readonly baseRef: string;
    readonly token: string;
    /** Aborted at the review's time limit, which ends the checkout. */
    readonly signal: AbortSignal;
  }): Promise<void>;
}

/**
 * One script to run in the sandbox: the repository's setup, in the checkout.
 * Nothing in it is a token, and nothing of the worker's environment reaches
 * the sandbox but what the sandbox's own settings give it.
 */
export interface SandboxRun {
  /**
   * The script, which reaches the sandbox's shell through its environment, as
   * `AGENT_SETUP`, and is never spliced into a command line.
   */
  readonly script: string;
  /** The host directory bound read-write at its own path, and the script's working directory: the checkout. */
  readonly dir: string;
  /** Host directories bound read-only at the same path inside: the toolchain. */
  readonly roBinds: readonly string[];
  /** `PATH` inside the sandbox. */
  readonly path: string;
  /** The proxy every request from the sandbox leaves through. Absent is none. */
  readonly proxy?: string;
  /** The file its output goes to. */
  readonly log: string;
  /** Aborted at its time limit, which ends the sandbox and everything in it. */
  readonly signal: AbortSignal;
}

/**
 * Runs a script in the bwrap sandbox, never on the worker's host, and answers
 * with its exit code once it has ended, which it is made to where `signal`
 * aborts. Throws where the sandbox could not be started.
 */
export type Sandbox = (run: SandboxRun) => Promise<number>;

/** Asks the dispatcher for a token for one phase of this job. Throws, with the dispatcher's reason, where none is granted. */
export type TokenSource = (kind: TokenKind) => Promise<string>;

export interface JobEdges {
  readonly token: TokenSource;
  readonly launch: Launcher;
  readonly git: Git;
  /** Where the repository's setup runs: the bwrap sandbox, whatever `AGENT_SANDBOX` says of the agent's. */
  readonly sandbox: Sandbox;
  /**
   * The worker's own `PATH`, `HOME` and `LANG`, and its proxy where it has one
   * (`hostEnvironment`): the only part of its environment a subcommand gets.
   */
  readonly host: HostEnvironment;
  /**
   * What the runner is handed from the worker's settings: the agent's token
   * and the sandbox's four inputs, the CLI's prefix already in them.
   */
  readonly agent: Readonly<Record<string, string>>;
  /** Where the worker's own `claude` is, put first on the runner's `PATH`. */
  readonly cliBin: string;
  /** The run's own directory, fresh: the checkout, and each subcommand's output directory and log, go under it. */
  readonly runDir: string;
  /** How long a minute of a time limit is, in milliseconds: a minute, but where a test shortens it. */
  readonly minuteMs?: number;
}

/**
 * Each posting command's own time limit, in minutes: the posting job's
 * `timeout-minutes` in `review.yml`. Each command gets the whole of it, so a
 * publish that hangs still leaves conclude its time to say so.
 */
export const POSTING_MINUTES = 10;

/** `review:advance`'s time limit, in minutes: the advance job's `timeout-minutes` in `review.yml`. */
export const ADVANCE_MINUTES = 5;

/** The run summary's name in the run's directory. */
export const SUMMARY_FILE = "summary.json";

/** What stands in for a token in the run summary and the worker's log. */
export const REDACTED = "[redacted]";

/**
 * The fix-round budget the worker hands `review:budget`, whatever the
 * repository's `AGENT_MAX_FIX_ROUNDS` says, while the service answers no
 * `agent:fix` (PRD #453): so no review asks for a round nobody would start,
 * and a verdict asking for changes leaves the round to a human, which is
 * what a budget of 0 means on Actions too. Goes in the release where the
 * service answers `agent:fix`.
 */
export const SERVICE_FIX_ROUND_BUDGET = "0";

/**
 * `review:collect-checks`'s `SELF_CHECK`. On Actions it is the check run the
 * review job appears under, left out of the wait as not CI. The service has no
 * check of its own on the pull request, so it names the review job's id, which
 * the command leaves out anyway: nothing more is left out of the wait.
 */
export const SERVICE_SELF_CHECK = "review";

/** The setup phase's name, in the summary and the worker's log. */
export const SETUP_PHASE = "setup";

/** How many of its output's last lines a failed setup's reason quotes. */
const SETUP_TAIL_LINES = 20;

/** Every token source a command reads `app` from: the service's tokens are its App's. */
const TOKEN_SOURCE = "app";

/**
 * A subcommand's whole environment, built from its declaration in the
 * contract: every input it declares that `values` has a value for, and the
 * host's `PATH`, `HOME` and `LANG`, with the proxy variables where the worker
 * has a proxy. Nothing else, so nothing of the worker's
 * own environment, its settings or a token another phase holds reaches it
 * unless its declaration names it. An empty value is left out, which every
 * subcommand reads as unset.
 */
export const environmentFor = (
  subcommand: Subcommand,
  values: Readonly<Record<string, string | undefined>>,
  host: HostEnvironment,
): Record<string, string> => {
  const declared = subcommand in RUNNERS ? RUNNERS[subcommand as Runner].inputs : COMMANDS[subcommand as Command].inputs;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) if (value !== undefined) env[name] = value;
  for (const name of Object.keys(declared)) {
    const value = values[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
};

/** How one phase of a run ended, for the worker's log. */
export interface Phase {
  readonly name: string;
  readonly outcome: string;
}

/** A hand-over's values, every one as a string the way the reusable's `jq` copies them, or none where the file is missing or unreadable. */
const decisions = (dir: string, file: string): Readonly<Record<string, string>> => {
  try {
    const read: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (typeof read !== "object" || read === null || Array.isArray(read)) return {};
    return Object.fromEntries(
      Object.entries(read).flatMap(([name, value]) =>
        value === null || typeof value === "object" ? [] : [[name, String(value)] as const],
      ),
    );
  } catch {
    return {};
  }
};

/** A reason a subcommand wrote, or `undefined` where it wrote none. */
const reason = (dir: string, file: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(dir, file), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/** The last lines of a log, as a sentence's continuation, or that it wrote nothing. */
const tail = (log: string): string => {
  let text = "";
  try {
    text = fs.readFileSync(log, "utf8").trimEnd();
  } catch {
    // Nothing was written.
  }
  if (text === "") return "It wrote no output.";
  return `The end of its output:\n\n\`\`\`\n${text.split("\n").slice(-SETUP_TAIL_LINES).join("\n")}\n\`\`\``;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How a subcommand a run started ended, and the output directory it wrote into. */
interface Ran {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly dir: string;
}

/** How the repository's setup ended: skipped and succeeded are both `ok`. */
export interface SetupRan {
  readonly ok: boolean;
  readonly timedOut: boolean;
  /** Where it failed, the sentence a person can act on: its exit status and the end of its output. */
  readonly failureReason?: string;
}

/**
 * The phase primitives every kind's run function is built from (ADR 0008):
 * each is a step one of the reusables' jobs takes, and a run function says in
 * which order, under which conditions and handed what.
 */
export interface Run {
  /** Records how a phase ended, for the summary and the worker's log. */
  readonly note: (name: string, outcome: string) => void;
  /** A time limit of `minutes` from now: the signal it aborts, and the timer to clear once what it bounds has ended. */
  readonly limit: (minutes: number) => { readonly signal: AbortSignal; readonly clear: () => void };
  /** The fresh output directory `subcommand` writes into, which a command reading its files is pointed at. */
  readonly outputDir: (subcommand: Subcommand) => string;
  /** Where the pull request is checked out. */
  readonly checkout: string;
  /**
   * Asks the dispatcher for a token of `kind`, which the run then redacts
   * wherever it appears. `undefined`, and the refusal noted, where none is granted.
   */
  readonly ask: (kind: TokenKind) => Promise<string | undefined>;
  /**
   * Starts a subcommand in a fresh output directory, with the environment its
   * declaration builds from `values`, and notes how it ended. A launch that
   * throws, or ends at `signal`, is an ending like an exit.
   */
  readonly run: (subcommand: Subcommand, values: Readonly<Record<string, string | undefined>>, cwd: string, signal: AbortSignal) => Promise<Ran>;
  /**
   * Starts a runner as `run` does, handed what the worker's settings give the
   * agent and the sandbox, with the worker's own `claude` first on its `PATH`.
   */
  readonly runAgent: (runner: Runner, values: Readonly<Record<string, string | undefined>>, cwd: string, signal: AbortSignal) => Promise<Ran>;
  /**
   * Runs the repository's setup, `script`, the job's `AGENT_SETUP`, in the
   * bwrap sandbox, in the checkout, with no token, behind the sandbox's proxy,
   * and notes how it ended, as Actions runs a caller's `setup:` in the agent's
   * job. Empty is skipped, and noted so, as an empty `setup:` is on Actions.
   * A setup that could not start, or exited non-zero, is a failure with its
   * reason; one still running at `signal` is ended with its sandbox.
   */
  readonly setup: (script: string, signal: AbortSignal) => Promise<SetupRan>;
  /** Writes the run summary, and answers the phases, redacted: the end of every path through a run. */
  readonly done: () => readonly Phase[];
}

/**
 * A run of `job` begun: its directories made, and the primitives its kind's
 * run function is built from.
 *
 * **The run leaves a summary**, `SUMMARY_FILE` in the run's directory: the
 * job, each phase's outcome, and each subcommand's directory, log and
 * environment, with every token it was handed redacted, as are the phases
 * `done` returns.
 */
export const startRun = (job: Job, edges: JobEdges): Run => {
  const phases: Phase[] = [];
  const note = (name: string, outcome: string): void => {
    phases.push({ name, outcome });
  };
  /** What each subcommand was started with, for the run summary. */
  const started: { readonly subcommand: Subcommand | typeof SETUP_PHASE; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly log: string }[] =
    [];
  /**
   * Every token this run holds, the dispatcher's and the agent's, each
   * replaced wherever it appears in what the run leaves for a person to read.
   */
  const secrets = new Set(Object.entries(edges.agent).flatMap(([name, value]) => (name.endsWith("TOKEN") && value !== "" ? [value] : [])));
  const redact = (text: string): string => [...secrets].reduce((done, secret) => done.split(secret).join(REDACTED), text);
  const done = (): readonly Phase[] => {
    const summary = {
      job,
      phases,
      subcommands: started.map((launch) => ({ ...launch, outputDir: launch.env["OUTPUT_DIR"] })),
    };
    fs.writeFileSync(path.join(edges.runDir, SUMMARY_FILE), `${redact(JSON.stringify(summary, null, 2))}\n`);
    return phases.map(({ name, outcome }) => ({ name, outcome: redact(outcome) }));
  };
  const checkout = path.join(edges.runDir, "checkout");
  const outputDir = (name: Subcommand): string => path.join(edges.runDir, "out", name.replace(":", "-"));
  const logs = path.join(edges.runDir, "logs");
  const logFile = (name: Subcommand): string => path.join(logs, `${name.replace(":", "-")}.log`);
  fs.mkdirSync(logs, { recursive: true });

  const minuteMs = edges.minuteMs ?? 60_000;
  const limit = (minutes: number): { readonly signal: AbortSignal; readonly clear: () => void } => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), minutes * minuteMs);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  };

  const launch = async (
    subcommand: Subcommand,
    values: Readonly<Record<string, string | undefined>>,
    cwd: string,
    signal: AbortSignal,
    host: HostEnvironment,
  ): Promise<Ran> => {
    const dir = outputDir(subcommand);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const env = environmentFor(subcommand, { ...values, OUTPUT_DIR: dir }, host);
    started.push({ subcommand, env, cwd, log: logFile(subcommand) });
    let code: number;
    try {
      code = await edges.launch({ subcommand, env, cwd, log: logFile(subcommand), signal });
    } catch (error) {
      fs.writeFileSync(path.join(dir, "failure_reason.txt"), `It could not be started: ${message(error)}`);
      code = -1;
    }
    // Ended by its time limit, whatever it exited with, as Actions cancels a
    // step at its job's `timeout-minutes`.
    if (signal.aborted) {
      note(subcommand, "timed out");
      return { ok: false, timedOut: true, dir };
    }
    const why = code === 0 ? undefined : reason(dir, "failure_reason.txt");
    note(subcommand, code === 0 ? "success" : `failure (exit ${code})${why === undefined ? "" : `: ${why}`}`);
    return { ok: code === 0, timedOut: false, dir };
  };

  const ask = async (kind: TokenKind): Promise<string | undefined> => {
    try {
      const token = await edges.token(kind);
      if (token !== "") secrets.add(token);
      note(`${kind} token`, "success");
      return token;
    } catch (error) {
      note(`${kind} token`, `failure: ${message(error)}`);
      return undefined;
    }
  };

  const setup = async (script: string, signal: AbortSignal): Promise<SetupRan> => {
    if (script === "") {
      note(SETUP_PHASE, "skipped: AGENT_SETUP is unset");
      return { ok: true, timedOut: false };
    }
    const log = path.join(logs, `${SETUP_PHASE}.log`);
    const proxy = edges.agent["AGENT_SANDBOX_PROXY"] ?? "";
    started.push({ subcommand: SETUP_PHASE, env: { AGENT_SETUP: script }, cwd: checkout, log });
    let code: number;
    try {
      code = await edges.sandbox({
        script,
        dir: checkout,
        roBinds: (edges.agent["AGENT_SANDBOX_RO_BINDS"] ?? "").split(":").filter((dir) => dir !== ""),
        path: edges.agent["AGENT_SANDBOX_PATH"] ?? "",
        ...(proxy === "" ? {} : { proxy }),
        log,
        signal,
      });
    } catch (error) {
      const failureReason = `The repository's setup (\`AGENT_SETUP\`) could not be started in the sandbox: ${message(error)}`;
      note(SETUP_PHASE, `failure: ${failureReason}`);
      return { ok: false, timedOut: false, failureReason };
    }
    if (signal.aborted) {
      note(SETUP_PHASE, "timed out");
      return { ok: false, timedOut: true };
    }
    if (code === 0) {
      note(SETUP_PHASE, "success");
      return { ok: true, timedOut: false };
    }
    const failureReason = `The repository's setup (\`AGENT_SETUP\`) exited with status ${code}. ${tail(log)}`;
    note(SETUP_PHASE, `failure (exit ${code})`);
    return { ok: false, timedOut: false, failureReason: redact(failureReason) };
  };

  return {
    note,
    limit,
    outputDir,
    checkout,
    ask,
    run: (subcommand, values, cwd, signal) => launch(subcommand, values, cwd, signal, edges.host),
    runAgent: (runner, values, cwd, signal) =>
      launch(runner, { ...edges.agent, ...values }, cwd, signal, {
        ...edges.host,
        PATH: [edges.cliBin, edges.host.PATH].filter((part) => part !== undefined && part !== "").join(":"),
      }),
    setup,
    done,
  };
};

/**
 * **One job**: its kind's run function, which follows that workflow's
 * `Actions orchestrator:` blocks in spec §8. Never throws: how each phase
 * ended is in what this returns, for the worker's log.
 */
export const runJob = async (job: Job, edges: JobEdges): Promise<readonly Phase[]> => {
  switch (job.workflow) {
    case "review":
      return runReview(job, edges);
  }
};

/**
 * **A review job**: review on one pull request, in `review.yml`'s order and
 * under its conditions, which the `Actions orchestrator:` blocks of spec §8
 * describe.
 *
 * 1. A `read` token, then `review:gate`. Where it does not go ahead, on to 6.
 * 2. The checkout of the commit the gate settled, as `BRANCH`, with the base.
 * 3. `review:budget`, with a budget of 0 (`SERVICE_FIX_ROUND_BUDGET`).
 * 4. `review:collect-checks`, whose failure the review reads as checks unknown.
 * 5. A fresh `read` token, then the runner, with it as `GH_TOKEN`.
 * 6. A `write` token, then `review:publish`, where the review finished.
 * 7. `review:conclude`, however the phases before it ended, told how each did.
 * 8. On a PRD pull request, where the gate went ahead and the head did not
 *    move, a `write` token and `review:advance`, told how the review and the
 *    posting ended.
 *
 * Each subcommand gets a fresh output directory of its own, and a command
 * that reads another's files is pointed at that one's. A phase that fails is
 * an ending conclude is told, and one conclude cannot be run for is the last
 * phase in what this returns, with the reason the run ended, for the worker's
 * log, since nothing on the pull request will say it.
 *
 * **Every phase has a time limit**, as every job on Actions does. Phases 1 to
 * 5 share the review's, its CI wait plus `AGENT_REVIEW_TIMEOUT_MINUTES`
 * (`reviewTimeLimit`), and one still running at it is ended and told to
 * conclude as a timeout. Publish and conclude get `POSTING_MINUTES` each, and
 * advance `ADVANCE_MINUTES`.
 */
const runReview = async (job: ReviewJob, edges: JobEdges): Promise<readonly Phase[]> => {
  const { note, limit, outputDir, checkout, ask, run, runAgent, done } = startRun(job, edges);

  /** What every phase of this job is told: the pull request, and the loop's account, the App's login (spec §4.1). */
  const common = {
    GH_REPO: job.repo,
    PR_NUMBER: String(job.pr),
    BRANCH: job.branch,
    AGENT_LOOP_LOGINS: job.appLogin,
  };

  /** How the review job ended, as the reusable's `needs.review` outputs say it. */
  const review: { result: "success" | "failure" | "cancelled"; timedOut: boolean; failureReason?: string; refusalReason?: string } = {
    result: "success",
    timedOut: false,
  };
  const failed = (why: string | undefined): void => {
    review.result = "failure";
    if (why !== undefined) review.failureReason = why;
  };
  /** The review's phases ran past its time limit, which ends them as Actions ends a job at its `timeout-minutes`. */
  const timedOut = (): void => {
    review.result = "cancelled";
    review.timedOut = true;
  };

  // The review job's time limit, `review.yml`'s `time-limit` sum, over the
  // phases that job runs: the gate, the checkout, the budget, the CI wait and
  // the runner. A phase still running at it is ended, and conclude is told
  // the review timed out, so a hung agent neither holds the queue nor leaves
  // the pull request without an ending.
  const minutes = reviewTimeLimit(job.variables.AGENT_REVIEW_TIMEOUT_MINUTES);
  const reviewLimit = limit(minutes);

  // 1. The gate, with the pull request as the label's event saw it, and the
  // repository's own variables, which it refuses the way it does on Actions.
  const read = await ask("read");
  let gate: Readonly<Record<string, string>> = {};
  if (read === undefined) {
    failed("The service's dispatcher granted no token to read the pull request with, so the review did not start.");
  } else {
    const ran = await run(
      "review:gate",
      {
        ...common,
        GH_TOKEN: read,
        HEAD_SHA: job.headSha,
        PR_STATE: job.state,
        PR_MERGED: String(job.merged),
        REVIEW_TIMEOUT_MINUTES: job.variables.AGENT_REVIEW_TIMEOUT_MINUTES,
        MAX_FIX_ROUNDS: job.variables.AGENT_MAX_FIX_ROUNDS,
      },
      edges.runDir,
      reviewLimit.signal,
    );
    gate = decisions(ran.dir, "gate.json");
    if (ran.timedOut) timedOut();
    else if (!ran.ok) {
      failed(reason(ran.dir, "failure_reason.txt"));
      const refusal = reason(ran.dir, "refusal_reason.txt");
      if (refusal !== undefined) review.refusalReason = refusal;
    }
  }
  const proceeds = read !== undefined && review.result === "success" && gate["proceed"] === "true";
  const sha = gate["sha"] ?? "";

  // 2 to 5: the checkout, the budget, the CI wait and the runner, each only
  // where everything before it succeeded, as the review job's steps run.
  let budget: Readonly<Record<string, string>> = {};
  let verdict: Readonly<Record<string, string>> = {};
  let reviewDir = outputDir("review");
  if (proceeds && read !== undefined) {
    try {
      await edges.git.checkout({
        dir: checkout,
        repo: job.repo,
        branch: job.branch,
        sha,
        baseRef: job.baseRef,
        token: read,
        signal: reviewLimit.signal,
      });
      note("checkout", "success");
    } catch (error) {
      if (reviewLimit.signal.aborted) {
        note("checkout", "timed out");
        timedOut();
      } else {
        note("checkout", `failure: ${message(error)}`);
        failed(`The pull request's head could not be checked out: ${message(error)}`);
      }
    }
  }
  if (proceeds && read !== undefined && review.result === "success") {
    const counted = await run(
      "review:budget",
      {
        ...common,
        GH_TOKEN: read,
        BASE_REF: job.baseRef,
        ROUND: gate["round"],
        FIX_ROUND_BUDGET: SERVICE_FIX_ROUND_BUDGET,
        LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
      },
      checkout,
      reviewLimit.signal,
    );
    budget = decisions(counted.dir, "budget.json");
    if (counted.timedOut) timedOut();
    else if (!counted.ok) failed(reason(counted.dir, "failure_reason.txt"));
  }
  if (proceeds && read !== undefined && review.result === "success") {
    // Its failure fails nothing: the runner reads checks it has no word for
    // as unknown, as on Actions, where the step continues on error.
    const checks = await run(
      "review:collect-checks",
      { ...common, GH_TOKEN: read, REVIEWED_SHA: sha, SELF_CHECK: SERVICE_SELF_CHECK },
      checkout,
      reviewLimit.signal,
    );
    if (checks.timedOut) timedOut();
  }
  // The runner gets a `read` token of its own, minted as it starts: one
  // installation token lasts an hour, and the CI wait before it can take a
  // quarter of that, so the gate's could expire while the agent still reads.
  const runnerToken = proceeds && review.result === "success" ? await ask("read") : undefined;
  if (proceeds && review.result === "success" && runnerToken === undefined) {
    failed("The service's dispatcher granted no token for the review to read the pull request with.");
  }
  if (proceeds && runnerToken !== undefined && review.result === "success") {
    const checks = outputDir("review:collect-checks");
    const reviewed = await runAgent(
      "review",
      {
        ...common,
        GH_TOKEN: runnerToken,
        AGENT_MODEL: job.variables.AGENT_MODEL,
        AGENT_MODEL_REVIEW: job.variables.AGENT_MODEL_REVIEW,
        BASE_REF: job.baseRef,
        ROUND: gate["round"],
        CI_STATUS_FILE: path.join(checks, "ci_status.md"),
        CI_RESULT_FILE: path.join(checks, "ci_result.txt"),
        AUTO_FIX: budget["start"],
        FIX_ROUNDS_SPENT: budget["spent"],
        FIX_ROUND_BUDGET: budget["budget"],
      },
      checkout,
      reviewLimit.signal,
    );
    reviewDir = reviewed.dir;
    if (reviewed.timedOut) timedOut();
    else if (reviewed.ok) verdict = decisions(reviewed.dir, "verdict.json");
    else failed(reason(reviewed.dir, "failure_reason.txt"));
  }
  reviewLimit.clear();

  // 6. The posting phase's token, then publish, only where the review
  // finished. There is nothing to download: the hand-over is on this disk,
  // so the download the reusable's posting job makes is always a success.
  const finished = proceeds && review.result === "success";
  let write: string | undefined;
  let mintOutcome = "";
  let publishOutcome = "";
  const publishDir = outputDir("review:publish");
  if (finished) {
    write = await ask("write");
    mintOutcome = write === undefined ? "failure" : "success";
    if (write !== undefined) {
      const publishLimit = limit(POSTING_MINUTES);
      const published = await run(
        "review:publish",
        { ...common, GH_TOKEN: write, LOOP_TOKEN: write, LOOP_TOKEN_SOURCE: TOKEN_SOURCE, REVIEWED_SHA: sha, REVIEW_DIR: reviewDir },
        edges.runDir,
        publishLimit.signal,
      );
      publishLimit.clear();
      // A publish ended by its limit is a step a cancel ended, which conclude
      // says as cancelled rather than as failed.
      publishOutcome = published.timedOut ? "cancelled" : published.ok ? "success" : "failure";
    }
  }

  // 7. Conclude, however the run ended. It writes, so it needs a token that
  // writes even where publish never asked for one.
  const concluding = write ?? (await ask("write"));
  if (concluding === undefined) {
    // Nothing can say so on the pull request, so the worker's log says why
    // the run ended as well.
    const ended = review.failureReason ?? (review.timedOut ? `the review timed out after ${minutes} minutes` : `the review's result was ${review.result}`);
    note("review:conclude", `not run: the dispatcher granted no token to write the ending with, and the run had ended so: ${ended}`);
    return done();
  }
  const concludeLimit = limit(POSTING_MINUTES);
  const concluded = await run(
    "review:conclude",
    {
      ...common,
      GH_TOKEN: concluding,
      LOOP_TOKEN: concluding,
      LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
      PUBLISH_DIR: publishDir,
      REVIEW_RESULT: review.result,
      PROCEED: gate["proceed"],
      REFUSAL: gate["refusal"],
      BLOCKED: gate["blocked"],
      REVIEWED_SHA: sha,
      VERDICT: verdict["verdict"],
      FIX_ROUND: verdict["fixRound"],
      STOP: verdict["stop"],
      ROUND: gate["round"],
      FAILURE_REASON: review.failureReason,
      REFUSAL_REASON: review.refusalReason,
      TIMED_OUT: String(review.timedOut),
      TIMEOUT_MINUTES: String(minutes),
      MINT_OUTCOME: mintOutcome,
      DOWNLOAD_OUTCOME: finished ? "success" : "",
      PUBLISH_OUTCOME: publishOutcome,
      FIX_ROUND_BUDGET: budget["budget"],
      FIX_ROUNDS_SPENT: budget["spent"],
    },
    edges.runDir,
    concludeLimit.signal,
  );
  concludeLimit.clear();
  const ended = decisions(concluded.dir, "ended.json");

  // 8. The PRD chain's advance, on a PRD pull request only, where the gate
  // went ahead, since a refusal ended no round, and where the head did not
  // move, since the review of the new head decides. Every job is from this
  // repository: the dispatcher refuses a fork.
  if (!job.branch.startsWith(PRD_BRANCH_PREFIX) || gate["proceed"] !== "true" || ended["moved"] === "true") return done();
  // The posting job's result: failed where a step of it did, cancelled where
  // one was ended at its limit, as `needs.post-review.result` says it.
  const postingResult =
    mintOutcome === "failure" || publishOutcome === "failure" || (!concluded.ok && !concluded.timedOut)
      ? "failure"
      : publishOutcome === "cancelled" || concluded.timedOut
        ? "cancelled"
        : "success";
  // A token of its own, as the advance job mints its own. Where none is
  // granted nothing can write the chain's progress, and the log says so.
  const advancing = await ask("write");
  if (advancing === undefined) {
    note("review:advance", "not run: the dispatcher granted no token to advance the PRD chain with");
    return done();
  }
  const advanceLimit = limit(ADVANCE_MINUTES);
  await run(
    "review:advance",
    {
      ...common,
      GH_TOKEN: advancing,
      LOOP_TOKEN: advancing,
      LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
      PARK_DIR: reviewDir,
      REVIEW_RESULT: review.result,
      POSTING_RESULT: postingResult,
      MOVED: ended["moved"],
      REVIEW_URL: ended["reviewUrl"],
      VERDICT: verdict["verdict"],
      FIX_ROUND: verdict["fixRound"],
      ROUND: gate["round"],
      MINT_OUTCOME: "success",
    },
    edges.runDir,
    advanceLimit.signal,
  );
  advanceLimit.clear();
  return done();
};

/** What the job door needs: the shared secret, the worker's own release, and where an accepted job goes. */
export interface WorkerDoorEdges {
  readonly secret: string;
  readonly version: string;
  /** Queues the job; called only for one that is accepted. */
  readonly accept: (job: Job) => void;
}

const answer = (status: number, body: unknown): DoorResponse => ({ status, body: JSON.stringify(body) });

/**
 * **The job door.** A job whose signature does not verify is refused, `401`,
 * as is one that is not a job, `400`, and one from a dispatcher of another
 * release, `409`: the job's format only has to hold within one. Every other is
 * answered `202` and queued.
 */
export const jobDoor =
  (edges: WorkerDoorEdges) =>
  (request: DoorRequest): DoorResponse => {
    if (!verifySignature(edges.secret, request.body, request.headers[SIGNATURE_HEADER])) return answer(401, { refusal: "bad signature" });
    let body: unknown;
    try {
      body = JSON.parse(request.body.toString("utf8"));
    } catch {
      return answer(400, { refusal: "the body is not JSON" });
    }
    const job = parseJob(body);
    if (typeof job === "string") return answer(400, { refusal: job });
    if (job.version !== edges.version) {
      return answer(409, { refusal: `job ${job.id} is from a dispatcher at ${job.version}, and this worker is at ${edges.version}` });
    }
    edges.accept(job);
    return answer(202, { accepted: job.id });
  };

/**
 * A queue that runs one job at a time, in the order they arrived: one run per
 * pull request, and per box, at this stage. A job that throws does not stop
 * the ones behind it.
 */
export const oneAtATime = <T>(work: (item: T) => Promise<void>, onError: (error: unknown) => void): ((item: T) => void) => {
  let tail: Promise<void> = Promise.resolve();
  return (item) => {
    tail = tail.then(() => work(item)).catch(onError);
  };
};
