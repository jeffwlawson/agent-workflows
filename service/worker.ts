import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_WORKTREE } from "../engine/bwrap-args.js";
import { COMMANDS, RUNNERS, type Command, type Runner } from "../shared/contract.js";
import type { HostEnvironment } from "../shared/env.js";
import { sandboxRefusal } from "../shared/sandbox.js";
import { fixRescueBranch, issueRescueBranch, PRD_BRANCH_PREFIX, prdRescueBranch } from "../shared/record.js";
import type { DoorRequest, DoorResponse } from "./dispatcher.js";
import {
  FOLLOW_UPS_MINUTES,
  fixTimeLimit,
  HELD_REQUEST_MAX_AGE_MINUTES,
  HELD_REQUEST_MAX_SKEW_MINUTES,
  heldOf,
  parseHeldRequest,
  parseJob,
  reviewTimeLimit,
  SIGNATURE_HEADER,
  verifySignature,
  type FixJob,
  type FollowUpsJob,
  type ImplementJob,
  type JobKind,
  type ImplementPrdJob,
  type Job,
  type ReviewJob,
  type TokenKind,
  type UpdateBranchJob,
} from "./job.js";

/**
 * The service orchestrator's worker (#457): it receives jobs from the
 * dispatcher and runs each the way its workflow's reusable does, by running
 * the same subcommands in the same order, each told what the reusable tells
 * it: one run function per job kind, built from shared phase primitives. It writes nothing to the record and spells no record string: every
 * write is a command's. What it reads between them is the hand-over the
 * reusable's glue steps read, `gate.json`, `budget.json`, `verdict.json` and
 * `ended.json`, copied across as they are; where a phase is not started, the
 * reason, as `failure_reason.txt` in the directory it would have written.
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

/** The checkout a job runs in. */
export interface Git {
  /**
   * Check `sha` out in `dir`, a directory that does not exist yet, as the
   * local branch `branch`, with `baseRef` fetched as a local branch of the
   * same name beside it, every tag of `repo` fetched too, as `fetch-depth: 0`
   * fetches them on Actions, and `committer` the name commits made there are
   * made under. `sha` is a commit, or a branch of `repo` by its name, where
   * a run checks a branch out at whatever commit it is at, as
   * `actions/checkout` checks out a `ref:`. `token` reads `repo`, and is passed with each command that
   * needs it, never stored in the checkout's configuration.
   */
  checkout(options: {
    readonly dir: string;
    readonly repo: string;
    readonly branch: string;
    readonly sha: string;
    readonly baseRef: string;
    readonly token: string;
    /** The login the agent's commits are made as: the App's. */
    readonly committer: string;
    /** Aborted at the job's time limit, which ends the checkout. */
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
  /** The host directory bound read-write: the checkout. */
  readonly dir: string;
  /**
   * Where the checkout is seen inside the sandbox, and the script's working
   * directory: where the agent will work, so a path setup records still
   * holds there (#526). The agent's working path with `AGENT_SANDBOX=bwrap`,
   * and `dir` itself with `none`, where the agent works in the checkout.
   */
  readonly at: string;
  /** Host directories bound read-only at the same path inside: the toolchain. */
  readonly roBinds: readonly string[];
  /** `PATH` inside the sandbox. */
  readonly path: string;
  /**
   * The proxy every request from the sandbox leaves through, and its only way
   * out: the sandbox's network is its own, as the agent's is (#537). Absent is
   * none, possible only with `AGENT_SANDBOX=none`, and the one case whose
   * network is the host's, with no proxy variables.
   */
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
  /**
   * Waits for the worker's agent lane (`lanes`), for a job that runs in the
   * light lane until it would start an agent: an update-branch job whose merge
   * conflicted, before its agent's job. Resolves at once where unset.
   */
  readonly agentLane?: () => Promise<void>;
}

/**
 * Each posting command's own time limit, in minutes: the posting job's
 * `timeout-minutes` in `review.yml`. Each command gets the whole of it, so a
 * publish that hangs still leaves conclude its time to say so.
 */
export const POSTING_MINUTES = 10;

/** `review:advance`'s time limit, in minutes: the advance job's `timeout-minutes` in `review.yml`. */
export const ADVANCE_MINUTES = 5;

/** `fix:gate`'s time limit, in minutes: the gate job's `timeout-minutes` in `fix.yml`. */
export const FIX_GATE_MINUTES = 15;

/**
 * `fix:bundle`'s time limit, in minutes. On Actions it runs in the agent's
 * job, `always()`, in the time GitHub gives a cancelled job's last steps; the
 * worker gives it a limit of its own instead, so a round stopped at its time
 * limit still hands its commits over.
 */
export const BUNDLE_MINUTES = 5;

/**
 * The publish phase's checkout and `fix:publish`'s time limit, in minutes,
 * and `fix:conclude`'s, each: the publish job's `timeout-minutes` in
 * `fix.yml`.
 */
export const FIX_POSTING_MINUTES = 15;

/** `update-branch:gate`'s and `update-branch:merge`'s time limit, in minutes, together: the gate job's `timeout-minutes` in `update-branch.yml`. */
export const UPDATE_BRANCH_GATE_MINUTES = 15;

/**
 * The publish phase's checkout and `update-branch:publish`'s time limit, in
 * minutes, and `update-branch:conclude`'s, each: the publish job's
 * `timeout-minutes` in `update-branch.yml`.
 */
export const UPDATE_BRANCH_POSTING_MINUTES = 15;

/** `implement:gate`'s time limit, in minutes: the gate job's `timeout-minutes` in `implement.yml`. */
export const IMPLEMENT_GATE_MINUTES = 10;

/**
 * The publish phase's checkout and `implement:publish`'s time limit, in
 * minutes, and `implement:conclude`'s, each: the publish job's
 * `timeout-minutes` in `implement.yml`.
 */
export const IMPLEMENT_POSTING_MINUTES = 15;

/** `implement-prd:gate`'s time limit, in minutes: the gate job's `timeout-minutes` in `implement-prd.yml`. */
export const IMPLEMENT_PRD_GATE_MINUTES = 10;

/** The catch-up's checkout and `implement-prd:catch-up`'s time limit, in minutes, together: the catch-up job's `timeout-minutes` in `implement-prd.yml`. */
export const CATCH_UP_MINUTES = 10;

/**
 * The publish phase's checkout and `implement-prd:publish`'s time limit, in
 * minutes, and `implement-prd:conclude`'s, each: the publish job's
 * `timeout-minutes` in `implement-prd.yml`.
 */
export const IMPLEMENT_PRD_POSTING_MINUTES = 15;

/**
 * `RUN_URL` on the service, which has no run page: the App's own page, which
 * names the App that ran it. The implement commands require it, and link it
 * from the start comment, the pull request's frame, the link on the issue and
 * the failure comment, where Actions links the workflow run.
 */
export const serviceRunUrl = (appLogin: string): string => `https://github.com/apps/${appLogin.replace(/\[bot\]$/, "")}`;

/** The run summary's name in the run's directory. */
export const SUMMARY_FILE = "summary.json";

/** What stands in for a token in the run summary and the worker's log. */
export const REDACTED = "[redacted]";

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

/**
 * The slice a PRD gate's `gate.json` names, its number and title, as the
 * reusable's glue copies them into `sub` and `sub_title`, or none where it
 * names none: `decisions` leaves the nested `slice` out.
 */
const sliceOf = (dir: string): { readonly number?: string; readonly title?: string } => {
  try {
    const read: unknown = JSON.parse(fs.readFileSync(path.join(dir, "gate.json"), "utf8"));
    const slice = typeof read === "object" && read !== null ? (read as { readonly slice?: unknown }).slice : undefined;
    if (typeof slice !== "object" || slice === null) return {};
    const { number, title } = slice as { readonly number?: unknown; readonly title?: unknown };
    return {
      ...(typeof number === "number" ? { number: String(number) } : {}),
      ...(typeof title === "string" ? { title } : {}),
    };
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
   * bwrap sandbox, in the checkout, with no token, the sandbox's proxy its
   * only way out where the worker's settings name one, and notes how it
   * ended, as Actions runs a caller's `setup:` in the agent's job. A proxy
   * the relay would not take fails it unstarted, with the reason the worker's
   * start-up check would give under `bwrap`. Empty is skipped, and noted so, as an empty `setup:` is on Actions.
   * A setup that could not start, or exited non-zero, is a failure with its
   * reason; one still running at `signal` is ended with its sandbox.
   */
  readonly setup: (script: string, signal: AbortSignal) => Promise<SetupRan>;
  /**
   * Records that `subcommand` was not started, and why, as the
   * `failure_reason.txt` it would have written, in the directory it would
   * have written it to: so a command reading that directory gives the reason.
   */
  readonly notStarted: (subcommand: Subcommand, why: string) => void;
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
  /** What each subcommand, and the setup, was started with, for the run summary. */
  const started: {
    readonly subcommand: Subcommand | typeof SETUP_PHASE;
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly log: string;
  }[] = [];
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
    // A proxy is the sandbox's only way out (#537), so one the relay would not
    // take is refused here, by the rule the worker's start-up check reads
    // under `bwrap`: under `none` the worker starts with it, and a sandbox
    // started on it would reach nothing.
    const refused = proxy === "" ? undefined : sandboxRefusal("bwrap", proxy);
    if (refused !== undefined) {
      const failureReason = `The repository's setup (\`AGENT_SETUP\`) could not be started in the sandbox: ${refused}`;
      note(SETUP_PHASE, `failure: ${failureReason}`);
      return { ok: false, timedOut: false, failureReason };
    }
    let code: number;
    try {
      code = await edges.sandbox({
        script,
        dir: checkout,
        at: edges.agent["AGENT_SANDBOX"] === "bwrap" ? SANDBOX_WORKTREE : checkout,
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

  const notStarted = (subcommand: Subcommand, why: string): void => {
    const dir = outputDir(subcommand);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "failure_reason.txt"), why);
    note(subcommand, `not run: ${why}`);
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
    notStarted,
    done,
  };
};

/**
 * **One job**: its kind's run function, which follows that workflow's
 * `Actions orchestrator:` blocks in the spec, §6 for implement, §7 for
 * implement-prd, §8 for
 * review, §9 for fix, §10 for update-branch and §11 for follow-ups.
 * Never throws: how each phase ended is in what this returns, for the
 * worker's log.
 */
export const runJob = async (job: Job, edges: JobEdges): Promise<readonly Phase[]> => {
  switch (job.workflow) {
    case "review":
      return runReview(job, edges);
    case "fix":
      return runFix(job, edges);
    case "update-branch":
      return runUpdateBranch(job, edges);
    case "implement":
      return runImplement(job, edges);
    case "implement-prd":
      return runImplementPrd(job, edges);
    case "follow-ups":
      return runFollowUps(job, edges);
  }
};

/**
 * **A review job**: review on one pull request, in `review.yml`'s order and
 * under its conditions, which the `Actions orchestrator:` blocks of spec §8
 * describe.
 *
 * 1. A `read` token, then `review:gate`. Where it does not go ahead, on to 6.
 * 2. The checkout of the commit the gate settled, as `BRANCH`, with the base.
 * 3. `review:budget`, with the budget the gate settled from `AGENT_MAX_FIX_ROUNDS`.
 * 4. `review:collect-checks`, whose failure the review reads as checks unknown.
 * 5. A fresh `read` token, then the runner, with it as `GH_TOKEN`.
 * 6. A `resolve` token, then `review:publish`, where the review finished:
 *    `write`'s permissions and Contents: write, without which a thread on a
 *    pull request a person opened cannot be resolved (#571). Where it is
 *    refused, a `write` token instead: the review posts, and the threads it
 *    found fixed stay open and are listed so.
 * 7. A `write` token, or publish's where that was `write`, then
 *    `review:conclude`, however the phases before it ended, told how each did.
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
        committer: job.appLogin,
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
        FIX_ROUND_BUDGET: gate["budget"],
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
  // Publish alone is handed `resolve`, the one phase that resolves threads;
  // where it is refused, the `write` token publish falls back to is the one
  // conclude reuses, and a `resolve` token never is.
  const finished = proceeds && review.result === "success";
  let write: string | undefined;
  let mintOutcome = "";
  let publishOutcome = "";
  const publishDir = outputDir("review:publish");
  if (finished) {
    const resolving = await ask("resolve");
    if (resolving === undefined) {
      write = await ask("write");
      if (write !== undefined) {
        note(
          "thread resolution",
          "not possible: the `resolve` token was refused, so publish posts with a `write` token, and a thread on a pull request the App did not open stays open, listed as still open, until a review with Contents: write resolves it",
        );
      }
    }
    const publishing = resolving ?? write;
    mintOutcome = publishing === undefined ? "failure" : "success";
    if (publishing !== undefined) {
      const publishLimit = limit(POSTING_MINUTES);
      const published = await run(
        "review:publish",
        { ...common, GH_TOKEN: publishing, LOOP_TOKEN: publishing, LOOP_TOKEN_SOURCE: TOKEN_SOURCE, REVIEWED_SHA: sha, REVIEW_DIR: reviewDir },
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

/** How a job of a reusable ended, as Actions' `needs.<job>.result` says it. */
type JobResult = "success" | "failure" | "cancelled" | "skipped";

/**
 * **A fix job**: a fix round on one pull request, in `fix.yml`'s order and
 * under its conditions, which the `Actions orchestrator:` blocks of spec §9
 * describe.
 *
 * 1. The gate job: a `write` token, then `fix:gate`, which refuses or claims
 *    the pull request and writes as it does. A refusal ends the run there.
 * 2. The agent's job, where the gate succeeded and claimed the run: a `read`
 *    token, the checkout of the head the label's event named, as `BRANCH`,
 *    with the base; `fix:prepare`, which fetches the rescue branch; the
 *    repository's setup, in the sandbox; a fresh `read` token, then the
 *    runner, with it as `GH_TOKEN`; and `fix:bundle`, with no token, however
 *    the steps before it ended.
 * 3. The publish job: a `push` token, or where that is refused a `write`
 *    token for conclude; where the gate claimed the round, a checkout of the
 *    head of its own, with whichever was granted; then `fix:publish` in it,
 *    where the agent's job ran and the mint and the checkout succeeded, told
 *    how the agent's job ended.
 * 4. `fix:conclude`, however the run ended, in publish's checkout, with the
 *    `push` token, told how each job and step ended: it rescues a stopped
 *    round's commits. Where `push` was refused, the `write` token, since it
 *    then rescues nothing.
 *
 * **A checkout per job**, as on Actions, where the publish job checks the
 * head out again: nothing the agent's job touched is where `push` is used.
 *
 * The runner never holds a token that writes: `push` is asked for only once
 * the agent's job is over, and handed to publish and conclude alone, as both
 * `GH_TOKEN` and `LOOP_TOKEN`.
 *
 * **Every phase has a time limit**, as every job on Actions does: the gate
 * `FIX_GATE_MINUTES`; the checkout, prepare, the setup and the runner share
 * the agent's job's, `AGENT_TIMEOUT_MINUTES` (`fixTimeLimit`), and one still
 * running at it is ended and the round told to conclude as a timeout; the
 * bundle `BUNDLE_MINUTES`, so a stopped round still hands its commits over;
 * publish's checkout and publish share `FIX_POSTING_MINUTES`, and conclude
 * has as long.
 */
const runFix = async (job: FixJob, edges: JobEdges): Promise<readonly Phase[]> => {
  const { note, limit, outputDir, checkout, ask, run, runAgent, setup, notStarted, done } = startRun(job, edges);
  const publishCheckout = path.join(edges.runDir, "publish-checkout");
  const rescueBranch = fixRescueBranch(job.pr);

  /** What every phase of this job is told: the pull request, and the loop's account, the App's login (spec §4.1). */
  const common = {
    GH_REPO: job.repo,
    PR_NUMBER: String(job.pr),
    BRANCH: job.branch,
    AGENT_LOOP_LOGINS: job.appLogin,
  };
  /** The head the label's event named, as `BRANCH`, with the base, into `dir`, with `token`. */
  const checkOut = (dir: string, token: string, signal: AbortSignal): Promise<void> =>
    edges.git.checkout({ dir, repo: job.repo, branch: job.branch, sha: job.headSha, baseRef: job.baseRef, token, committer: job.appLogin, signal });

  // 1. The gate. It writes, its refusal and its label transitions, so its
  // token is `write`, as the gate job's own token has `pull-requests: write`.
  let gateResult: JobResult = "failure";
  let gateReason: string | undefined;
  let gate: Readonly<Record<string, string>> = {};
  const claiming = await ask("write");
  if (claiming === undefined) {
    note("fix:gate", "not run: the dispatcher granted no token to claim the pull request with");
  } else {
    const gateLimit = limit(FIX_GATE_MINUTES);
    const gated = await run(
      "fix:gate",
      { ...common, GH_TOKEN: claiming, HEAD_SHA: job.headSha, PR_STATE: job.state, PR_MERGED: String(job.merged) },
      edges.runDir,
      gateLimit.signal,
    );
    gateLimit.clear();
    gate = decisions(gated.dir, "gate.json");
    gateResult = gated.timedOut ? "cancelled" : gated.ok ? "success" : "failure";
    gateReason = reason(gated.dir, "failure_reason.txt");
  }
  // The gate job's `refused`: empty where the gate decided nothing.
  const refused = gate["proceed"] === "true" ? "false" : gate["proceed"] === "false" ? "true" : "";
  // The gate said it, and took the label off: the publish job does not run,
  // so no token is asked for after it and conclude does not run.
  if (refused === "true") {
    note("fix:gate", "refused: the run ends here, as the publish job does not run after a refusal");
    return done();
  }

  // 2. The agent's job, where the gate succeeded and claimed the run.
  const minutes = fixTimeLimit(job.variables.AGENT_TIMEOUT_MINUTES);
  const agent: { result: JobResult; timedOut: boolean } = { result: "skipped", timedOut: false };
  const fixDir = outputDir("fix");
  const bundleDir = outputDir("fix:bundle");
  if (gateResult === "success" && refused === "false") {
    agent.result = "success";
    const agentLimit = limit(minutes);
    /** The agent's job ran past its time limit, which ends it as Actions ends a job at its `timeout-minutes`. */
    const timedOut = (): void => {
      agent.result = "cancelled";
      agent.timedOut = true;
    };
    const going = (): boolean => agent.result === "success";

    const read = await ask("read");
    if (read === undefined) {
      agent.result = "failure";
      notStarted("fix:prepare", "The service's dispatcher granted no token to read the pull request with, so the fix did not start.");
    } else {
      try {
        await checkOut(checkout, read, agentLimit.signal);
        note("checkout", "success");
      } catch (error) {
        if (agentLimit.signal.aborted) {
          note("checkout", "timed out");
          timedOut();
        } else {
          note("checkout", `failure: ${message(error)}`);
          agent.result = "failure";
          notStarted("fix:prepare", `The pull request's head could not be checked out: ${message(error)}`);
        }
      }
    }
    if (going() && read !== undefined) {
      const prepared = await run(
        "fix:prepare",
        { ...common, GH_TOKEN: read, CHECKOUT: checkout, RESCUE_BRANCH: rescueBranch },
        edges.runDir,
        agentLimit.signal,
      );
      if (prepared.timedOut) timedOut();
      else if (!prepared.ok) agent.result = "failure";
    }
    if (going()) {
      const set = await setup(job.variables.AGENT_SETUP, agentLimit.signal);
      if (set.timedOut) timedOut();
      else if (!set.ok) {
        agent.result = "failure";
        notStarted("fix", set.failureReason ?? "The repository's setup (`AGENT_SETUP`) failed.");
      }
    }
    // The runner gets a `read` token of its own, minted as it starts, since
    // the setup before it can take a good part of the gate's token's hour.
    const runnerToken = going() ? await ask("read") : undefined;
    if (going() && runnerToken === undefined) {
      agent.result = "failure";
      notStarted("fix", "The service's dispatcher granted no token for the fix to read the pull request with.");
    }
    if (going() && runnerToken !== undefined) {
      const fixed = await runAgent(
        "fix",
        {
          ...common,
          GH_TOKEN: runnerToken,
          AGENT_MODEL: job.variables.AGENT_MODEL,
          AGENT_MODEL_FIX: job.variables.AGENT_MODEL_FIX,
          BASE_REF: job.baseRef,
          RESCUE_BRANCH: rescueBranch,
        },
        checkout,
        agentLimit.signal,
      );
      if (fixed.timedOut) timedOut();
      else if (!fixed.ok) agent.result = "failure";
    }
    agentLimit.clear();

    // However the steps before it ended, so a failed or stopped round hands
    // its commits over too. It is handed no token.
    const bundleLimit = limit(BUNDLE_MINUTES);
    const bundled = await run("fix:bundle", { CHECKOUT: checkout, BRANCH: job.branch, HEAD_SHA: job.headSha }, edges.runDir, bundleLimit.signal);
    bundleLimit.clear();
    if (bundled.timedOut && agent.result === "success") agent.result = "cancelled";
    else if (!bundled.ok && agent.result === "success") agent.result = "failure";
  }
  const agentRan = agent.result !== "skipped";

  // 3. The publish job's token, then, where the gate claimed the round, a
  // checkout of the head of its own, which publish checks the bundle in and
  // pushes from and conclude rescues from. Where `push` was refused, conclude
  // is told the mint failed and is handed a `write` token instead, for its
  // comment and labels: a second `push` would be refused for the reason the
  // first was. The checkout is made with whichever was granted, so conclude
  // still checks the bundle in it. There is nothing to download: the
  // hand-over is on this disk.
  const push = await ask("push");
  const mintOutcome = push === undefined ? "failure" : "success";
  const concluding = push ?? (await ask("write"));
  const publishLimit = limit(FIX_POSTING_MINUTES);
  let checkedOut = false;
  let checkoutFailed: { readonly timedOut: boolean; readonly why: string } | undefined;
  if (refused === "false" && concluding !== undefined) {
    try {
      await checkOut(publishCheckout, concluding, publishLimit.signal);
      note("checkout", "success");
      checkedOut = true;
    } catch (error) {
      const timedOut = publishLimit.signal.aborted;
      note("checkout", timedOut ? "timed out" : `failure: ${message(error)}`);
      checkoutFailed = { timedOut, why: message(error) };
    }
  }
  // Publish, where the agent's job ran and the mint and the checkout
  // succeeded. A checkout that failed is publish's failure, with its reason,
  // or its cancel where it ran out of time.
  let publishOutcome = "";
  const publishDir = outputDir("fix:publish");
  if (push !== undefined && agentRan && checkoutFailed !== undefined) {
    publishOutcome = checkoutFailed.timedOut ? "cancelled" : "failure";
    if (!checkoutFailed.timedOut) {
      notStarted("fix:publish", `The pull request's head could not be checked out to publish the fix: ${checkoutFailed.why}`);
    }
  }
  if (push !== undefined && agentRan && checkedOut) {
    const published = await run(
      "fix:publish",
      {
        ...common,
        GH_TOKEN: push,
        LOOP_TOKEN: push,
        LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
        HEAD_SHA: job.headSha,
        RESCUE_BRANCH: rescueBranch,
        AGENT_RESULT: agent.result,
        CHECKOUT: publishCheckout,
        FIX_DIR: fixDir,
        BUNDLE_DIR: bundleDir,
      },
      edges.runDir,
      publishLimit.signal,
    );
    publishOutcome = published.timedOut ? "cancelled" : published.ok ? "success" : "failure";
  }
  publishLimit.clear();

  // 4. Conclude, however the run ended, with the `push` token, since it
  // rescues, or the `write` token where that was refused, when it rescues
  // nothing.
  if (concluding === undefined) {
    // Nothing can say so on the pull request, so the worker's log says why
    // the run ended as well.
    const ended = agent.timedOut ? `the fix timed out after ${minutes} minutes` : `the gate's result was ${gateResult}, and the agent's ${agent.result}`;
    note("fix:conclude", `not run: the dispatcher granted no token to write the ending with, and the run had ended so: ${ended}`);
    return done();
  }
  const concludeLimit = limit(FIX_POSTING_MINUTES);
  await run(
    "fix:conclude",
    {
      ...common,
      GH_TOKEN: concluding,
      LOOP_TOKEN: concluding,
      LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
      HEAD_SHA: job.headSha,
      RESCUE_BRANCH: rescueBranch,
      CHECKOUT: publishCheckout,
      REFUSED: refused,
      GATE_RESULT: gateResult,
      GATE_REASON: gateReason,
      AGENT_RESULT: agent.result,
      TIMED_OUT: String(agent.timedOut),
      TIMEOUT_MINUTES: String(minutes),
      MINT_OUTCOME: mintOutcome,
      DOWNLOAD_OUTCOME: agentRan ? "success" : "",
      PUBLISH_OUTCOME: publishOutcome,
      PUBLISH_DIR: publishDir,
      PREPARE_DIR: outputDir("fix:prepare"),
      FIX_DIR: fixDir,
      BUNDLE_DIR: bundleDir,
    },
    edges.runDir,
    concludeLimit.signal,
  );
  concludeLimit.clear();
  return done();
};

/**
 * **An update-branch job**: a refresh of one pull request from its base, in
 * `update-branch.yml`'s order and under its conditions, which the `Actions
 * orchestrator:` blocks of spec §10 describe.
 *
 * 1. The gate job: a `write` token, then `update-branch:gate`, which refuses
 *    or claims the pull request. A refusal ends the run there, as on Actions
 *    it skips the publish job: no token is asked for after it, and neither
 *    publish nor conclude runs. Where it claimed the run, the checkout of the
 *    head the label's event named, as `BRANCH`, with the base, and
 *    `update-branch:merge` in it, with the same token. The merge runs none of
 *    the pull request's code and pushes nothing, so it holds no `push` token
 *    and runs outside the sandbox, as it runs in the gate job on Actions.
 * 2. The agent's job, only where the merge conflicted: a `read` token, a
 *    checkout of its own, `update-branch:prepare`, which makes the gate's
 *    merge again there; the repository's setup, in the sandbox; a fresh `read`
 *    token, then the runner, with it as `GH_TOKEN`; and, where those
 *    succeeded, `update-branch:bundle`, with no token. A clean merge runs none
 *    of it.
 * 3. The publish job: a `push` token, then, where the gate claimed the run
 *    and, on a conflict, the agent's job succeeded, a checkout of its own and
 *    `update-branch:publish` in it.
 * 4. `update-branch:conclude`, however the run ended, with the `push` token,
 *    or a `write` token where `push` was refused.
 *
 * **A checkout per job**, as on Actions, where each job checks the head out
 * again: the gate's merge leaves its own checkout merged, or stopped on its
 * conflicts, and `update-branch:prepare` and `update-branch:publish` each
 * make that merge again from the head the event named.
 *
 * **Every phase has a time limit**, as every job on Actions does: the gate,
 * its checkout and the merge share `UPDATE_BRANCH_GATE_MINUTES`; the agent's
 * job's steps share `AGENT_TIMEOUT_MINUTES` (`fixTimeLimit`), and one still
 * running at it is ended and conclude told the run timed out, which on
 * Actions the agent's job's last step measures; publish's checkout and
 * publish share `UPDATE_BRANCH_POSTING_MINUTES`, and conclude has as long.
 */
const runUpdateBranch = async (job: UpdateBranchJob, edges: JobEdges): Promise<readonly Phase[]> => {
  const { note, limit, outputDir, checkout, ask, run, runAgent, setup, notStarted, done } = startRun(job, edges);
  const gateCheckout = path.join(edges.runDir, "gate-checkout");
  const publishCheckout = path.join(edges.runDir, "publish-checkout");

  /** What every phase of this job is told: the pull request, its base, and the loop's account, the App's login (spec §4.1). */
  const common = {
    GH_REPO: job.repo,
    PR_NUMBER: String(job.pr),
    BRANCH: job.branch,
    BASE_REF: job.baseRef,
    AGENT_LOOP_LOGINS: job.appLogin,
  };
  /** The head the label's event named, as `BRANCH`, with the base, into `dir`, with `token`. */
  const checkOut = (dir: string, token: string, signal: AbortSignal): Promise<void> =>
    edges.git.checkout({ dir, repo: job.repo, branch: job.branch, sha: job.headSha, baseRef: job.baseRef, token, committer: job.appLogin, signal });

  // 1. The gate job. It writes, its refusal and its permission probe, so its
  // token is `write`, as the gate job's own token has `pull-requests: write`.
  let gateResult: JobResult = "failure";
  let gateReason: string | undefined;
  let gate: Readonly<Record<string, string>> = {};
  let merged: Readonly<Record<string, string>> = {};
  const claiming = await ask("write");
  if (claiming === undefined) {
    note("update-branch:gate", "not run: the dispatcher granted no token to claim the pull request with");
  } else {
    const gateLimit = limit(UPDATE_BRANCH_GATE_MINUTES);
    const gated = await run(
      "update-branch:gate",
      { ...common, GH_TOKEN: claiming, PR_STATE: job.state, PR_MERGED: String(job.merged) },
      edges.runDir,
      gateLimit.signal,
    );
    gate = decisions(gated.dir, "gate.json");
    gateResult = gated.timedOut ? "cancelled" : gated.ok ? "success" : "failure";
    gateReason = reason(gated.dir, "failure_reason.txt");
    if (gateResult === "success" && gate["proceed"] === "true") {
      try {
        await checkOut(gateCheckout, claiming, gateLimit.signal);
        note("checkout", "success");
      } catch (error) {
        if (gateLimit.signal.aborted) {
          note("checkout", "timed out");
          gateResult = "cancelled";
        } else {
          note("checkout", `failure: ${message(error)}`);
          gateResult = "failure";
          gateReason = `The pull request's head could not be checked out: ${message(error)}`;
        }
      }
    }
    if (gateResult === "success" && gate["proceed"] === "true") {
      const merging = await run("update-branch:merge", { ...common, GH_TOKEN: claiming, CHECKOUT: gateCheckout }, edges.runDir, gateLimit.signal);
      merged = decisions(merging.dir, "merge.json");
      gateResult = merging.timedOut ? "cancelled" : merging.ok ? "success" : "failure";
      gateReason = reason(merging.dir, "failure_reason.txt");
    }
    gateLimit.clear();
  }
  // The gate job's `refused`: empty where the gate decided nothing.
  const refused = gate["proceed"] === "true" ? "false" : gate["proceed"] === "false" ? "true" : "";
  // The gate said it, and took the label off: the publish job does not run,
  // so no token is asked for after it and conclude does not run, as for fix.
  if (refused === "true") {
    note("update-branch:gate", "refused: the run ends here, as the publish job does not run after a refusal");
    return done();
  }
  const claimed = gateResult === "success" && refused === "false";
  const status = merged["status"] ?? "";
  const base = merged["base"] ?? "";

  // 2. The agent's job, only where the gate claimed the run and the merge
  // stopped on its conflicts.
  const minutes = fixTimeLimit(job.variables.AGENT_TIMEOUT_MINUTES);
  const agent: { result: JobResult; timedOut: boolean } = { result: "skipped", timedOut: false };
  const runnerDir = outputDir("update-branch");
  const bundleDir = outputDir("update-branch:bundle");
  if (claimed && status === "conflicts") {
    // The hand-off (#582): the gate's end ran in the light lane, and the
    // agent's job waits its turn in the agent lane, behind the agent jobs that
    // arrived before this one. Its time limit starts once it has the lane; its
    // deadline is the dispatcher's, so a wait past it ends at the next token.
    await edges.agentLane?.();
    agent.result = "success";
    const agentLimit = limit(minutes);
    /** The agent's job ran past its time limit, which ends it as Actions ends a job at its `timeout-minutes`. */
    const timedOut = (): void => {
      agent.result = "cancelled";
      agent.timedOut = true;
    };
    const going = (): boolean => agent.result === "success";

    const read = await ask("read");
    if (read === undefined) {
      agent.result = "failure";
      notStarted("update-branch:prepare", "The service's dispatcher granted no token to read the pull request with, so the conflicts were not handed to the agent.");
    } else {
      try {
        await checkOut(checkout, read, agentLimit.signal);
        note("checkout", "success");
      } catch (error) {
        if (agentLimit.signal.aborted) {
          note("checkout", "timed out");
          timedOut();
        } else {
          note("checkout", `failure: ${message(error)}`);
          agent.result = "failure";
          notStarted("update-branch:prepare", `The pull request's head could not be checked out: ${message(error)}`);
        }
      }
    }
    if (going() && read !== undefined) {
      const prepared = await run(
        "update-branch:prepare",
        { ...common, GH_TOKEN: read, CHECKOUT: checkout, BASE_SHA: base },
        edges.runDir,
        agentLimit.signal,
      );
      if (prepared.timedOut) timedOut();
      else if (!prepared.ok) agent.result = "failure";
    }
    if (going()) {
      const set = await setup(job.variables.AGENT_SETUP, agentLimit.signal);
      if (set.timedOut) timedOut();
      else if (!set.ok) {
        agent.result = "failure";
        notStarted("update-branch", set.failureReason ?? "The repository's setup (`AGENT_SETUP`) failed.");
      }
    }
    // The runner gets a `read` token of its own, minted as it starts, since
    // the setup before it can take a good part of the first one's hour.
    const runnerToken = going() ? await ask("read") : undefined;
    if (going() && runnerToken === undefined) {
      agent.result = "failure";
      notStarted("update-branch", "The service's dispatcher granted no token for the agent to read the pull request with.");
    }
    if (going() && runnerToken !== undefined) {
      const resolved = await runAgent(
        "update-branch",
        {
          ...common,
          GH_TOKEN: runnerToken,
          AGENT_MODEL: job.variables.AGENT_MODEL,
          AGENT_MODEL_UPDATE_BRANCH: job.variables.AGENT_MODEL_UPDATE_BRANCH,
        },
        checkout,
        agentLimit.signal,
      );
      if (resolved.timedOut) timedOut();
      else if (!resolved.ok) agent.result = "failure";
    }
    // Only where the runner succeeded, as the bundle step's `if: success()`:
    // a resolution that stopped is never pushed. It is handed no token.
    if (going()) {
      const bundled = await run(
        "update-branch:bundle",
        { CHECKOUT: checkout, BRANCH: job.branch, HEAD_SHA: job.headSha, BASE_SHA: base },
        edges.runDir,
        agentLimit.signal,
      );
      if (bundled.timedOut) timedOut();
      else if (!bundled.ok) agent.result = "failure";
    }
    agentLimit.clear();
  }
  const agentRan = agent.result !== "skipped";

  // 3. The publish job: its token, then publish, in a checkout of its own. A
  // checkout that failed is publish's failure, with its reason, or its cancel
  // where it ran out of time, where Actions runs publish in an empty
  // workspace. There is nothing to download: the hand-over is on this disk.
  const push = await ask("push");
  const mintOutcome = push === undefined ? "failure" : "success";
  let publishOutcome = "";
  const publishDir = outputDir("update-branch:publish");
  if (push !== undefined && claimed && (status !== "conflicts" || agent.result === "success")) {
    const publishLimit = limit(UPDATE_BRANCH_POSTING_MINUTES);
    let checkedOut = false;
    try {
      await checkOut(publishCheckout, push, publishLimit.signal);
      note("checkout", "success");
      checkedOut = true;
    } catch (error) {
      if (publishLimit.signal.aborted) {
        note("checkout", "timed out");
        publishOutcome = "cancelled";
      } else {
        note("checkout", `failure: ${message(error)}`);
        publishOutcome = "failure";
        notStarted("update-branch:publish", `The pull request's head could not be checked out to publish the refresh: ${message(error)}`);
      }
    }
    if (checkedOut) {
      const published = await run(
        "update-branch:publish",
        {
          ...common,
          GH_TOKEN: push,
          LOOP_TOKEN: push,
          LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
          HEAD_SHA: job.headSha,
          STATUS: status,
          BASE_SHA: base,
          AGENT_RESULT: agent.result,
          CHECKOUT: publishCheckout,
          UPDATE_BRANCH_DIR: runnerDir,
          BUNDLE_DIR: bundleDir,
        },
        edges.runDir,
        publishLimit.signal,
      );
      publishOutcome = published.timedOut ? "cancelled" : published.ok ? "success" : "failure";
    }
    publishLimit.clear();
  }

  // 4. Conclude, however the run ended, with the `push` token. Where that was
  // refused it is told the mint failed, so it asks for `write` instead, for
  // its comment and labels: a second `push` would be refused for the reason
  // the first was.
  const concluding = push ?? (await ask("write"));
  if (concluding === undefined) {
    // Nothing can say so on the pull request, so the worker's log says why
    // the run ended as well.
    const ended = agent.timedOut
      ? `the refresh timed out after ${minutes} minutes`
      : `the gate's result was ${gateResult}, and the agent's ${agent.result}`;
    note("update-branch:conclude", `not run: the dispatcher granted no token to write the ending with, and the run had ended so: ${ended}`);
    return done();
  }
  const concludeLimit = limit(UPDATE_BRANCH_POSTING_MINUTES);
  await run(
    "update-branch:conclude",
    {
      ...common,
      GH_TOKEN: concluding,
      LOOP_TOKEN: concluding,
      LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
      HEAD_SHA: job.headSha,
      REFUSED: refused,
      GATE_RESULT: gateResult,
      GATE_REASON: gateReason,
      STATUS: status,
      AGENT_RESULT: agent.result,
      TIMED_OUT: String(agent.timedOut),
      TIMEOUT_MINUTES: String(minutes),
      MINT_OUTCOME: mintOutcome,
      DOWNLOAD_OUTCOME: agentRan ? "success" : "",
      PUBLISH_OUTCOME: publishOutcome,
      PUBLISH_DIR: publishDir,
      PREPARE_DIR: outputDir("update-branch:prepare"),
      UPDATE_BRANCH_DIR: runnerDir,
      BUNDLE_DIR: bundleDir,
    },
    edges.runDir,
    concludeLimit.signal,
  );
  concludeLimit.clear();
  return done();
};

/**
 * **An implement job**: one regular issue built into a pull request, in
 * `implement.yml`'s order and under each of its jobs' and steps' `if:`s, which
 * the `Actions orchestrator:` blocks of spec §6 describe.
 *
 * 1. The gate job: a `write` token, then `implement:gate`, which defers an
 *    issue with sub-issues to implement-prd without a word, refuses, or
 *    claims the issue. A refusal or a deferral (`refused` `true`) ends the
 *    run there, as on Actions it skips both jobs after the gate: no token is
 *    asked for after it, and neither the agent's job, publish nor conclude
 *    runs. A PRD therefore gets silence, as it does on Actions.
 * 2. The agent's job, where the gate succeeded and claimed the run: a `read`
 *    token, the checkout of `BASE_REF` by name; `implement:prepare`, with the
 *    same token, which creates the gate's `BRANCH` there at the commit the
 *    gate read the base at and fetches the rescue branch (#270); the
 *    repository's setup, in the sandbox; a fresh `read` token, then the
 *    runner, with it as `GH_TOKEN`; and `implement:bundle`, with no token,
 *    however those ended.
 * 3. The publish job, wherever the gate did not refuse, an undecided gate
 *    included: a `push` token, or where that is refused a `write` token, and
 *    where the gate claimed the run a checkout of the base, by name, of its
 *    own, which the bundle is checked in. Then, where the agent's job and the
 *    mint succeeded, `implement:publish` in it, which pushes, opens the
 *    pull request, deletes the rescue branch, links it on the issue and adds
 *    `agent:review`.
 * 4. `implement:conclude`, however the run ended, in the same checkout, with
 *    the `push` token, which it rescues a stopped run's commits with, or a
 *    `write` token where `push` was refused, and then no loop token.
 *
 * The runner never holds a token that writes: `push` is asked for only once
 * the agent's job is over, and handed to publish and conclude alone.
 *
 * **Every phase has a time limit**, as every job on Actions does: the gate
 * `IMPLEMENT_GATE_MINUTES`; the agent's job's steps share
 * `AGENT_TIMEOUT_MINUTES` (`fixTimeLimit`), and one still running at it is
 * ended and conclude told the run timed out; the bundle `BUNDLE_MINUTES`, so
 * a stopped run still hands its commits over; publish's checkout and publish
 * share `IMPLEMENT_POSTING_MINUTES`, and conclude has as long.
 */
const runImplement = async (job: ImplementJob, edges: JobEdges): Promise<readonly Phase[]> => {
  const { note, limit, outputDir, checkout, ask, run, runAgent, setup, notStarted, done } = startRun(job, edges);
  const publishCheckout = path.join(edges.runDir, "publish-checkout");
  const runUrl = serviceRunUrl(job.appLogin);
  const rescueBranch = issueRescueBranch(job.issue);
  /**
   * The base branch by its name, as each of the reusable's jobs checks it
   * out, into `dir`, with `token`: `implement:prepare` and
   * `implement:publish` each find `BASE_SHA` in it themselves.
   */
  const checkOut = (dir: string, token: string, signal: AbortSignal): Promise<void> =>
    edges.git.checkout({ dir, repo: job.repo, branch: job.baseRef, sha: job.baseRef, baseRef: job.baseRef, token, committer: job.appLogin, signal });

  /** What every phase of this job is told: the issue, its base, the run's link, and the loop's account, the App's login (spec §4.1). */
  const common = {
    GH_REPO: job.repo,
    ISSUE_NUMBER: String(job.issue),
    ISSUE_TITLE: job.title,
    BASE_REF: job.baseRef,
    RUN_URL: runUrl,
    AGENT_LOOP_LOGINS: job.appLogin,
  };

  // 1. The gate job. It writes, its refusals, the permission probe and the
  // start comment, so its token is `write`, as the gate job's own token has
  // `issues: write`.
  let gateResult: JobResult = "failure";
  let gateReason: string | undefined;
  let gate: Readonly<Record<string, string>> = {};
  const claiming = await ask("write");
  if (claiming === undefined) {
    note("implement:gate", "not run: the dispatcher granted no token to claim the issue with");
  } else {
    const gateLimit = limit(IMPLEMENT_GATE_MINUTES);
    const gated = await run("implement:gate", { ...common, GH_TOKEN: claiming, ISSUE_STATE: job.state }, edges.runDir, gateLimit.signal);
    gateLimit.clear();
    gate = decisions(gated.dir, "gate.json");
    gateResult = gated.timedOut ? "cancelled" : gated.ok ? "success" : "failure";
    gateReason = reason(gated.dir, "failure_reason.txt");
  }
  // The gate job's `refused`: empty where the gate decided nothing.
  const refused = gate["proceed"] === "true" ? "false" : gate["proceed"] === "false" ? "true" : "";
  // The gate said it and took the label off, or deferred to implement-prd and
  // says nothing by design: the agent's job and the publish job do not run, so
  // no token is asked for after it and conclude does not run.
  if (refused === "true") {
    note("implement:gate", "refused or deferred: the run ends here, as neither job after the gate runs then");
    return done();
  }
  const branch = gate["branch"];
  const base = gate["base"] ?? "";

  // 2. The agent's job, where the gate succeeded and claimed the run.
  const minutes = fixTimeLimit(job.variables.AGENT_TIMEOUT_MINUTES);
  const agent: { result: JobResult; timedOut: boolean } = { result: "skipped", timedOut: false };
  const bundleDir = outputDir("implement:bundle");
  // How `implement:bundle` ended, as the bundle step's `outcome`: one stopped
  // at its limit writes nothing, which conclude must not read as no commits.
  let bundleOutcome = "";
  if (gateResult === "success" && refused === "false") {
    agent.result = "success";
    const agentLimit = limit(minutes);
    /** The agent's job ran past its time limit, which ends it as Actions ends a job at its `timeout-minutes`. */
    const timedOut = (): void => {
      agent.result = "cancelled";
      agent.timedOut = true;
    };
    const going = (): boolean => agent.result === "success";

    const read = await ask("read");
    if (read === undefined) {
      agent.result = "failure";
      notStarted("implement:prepare", "The service's dispatcher granted no token to read the repository with, so the issue was not built.");
    } else {
      try {
        await checkOut(checkout, read, agentLimit.signal);
        note("checkout", "success");
      } catch (error) {
        if (agentLimit.signal.aborted) {
          note("checkout", "timed out");
          timedOut();
        } else {
          note("checkout", `failure: ${message(error)}`);
          agent.result = "failure";
          notStarted("implement:prepare", `\`${job.baseRef}\` could not be checked out: ${message(error)}`);
        }
      }
    }
    if (going() && read !== undefined) {
      // The agent's job's read token, as on Actions, where it fetches the
      // rescue branch.
      const prepared = await run(
        "implement:prepare",
        { ...common, GH_TOKEN: read, CHECKOUT: checkout, BRANCH: branch, BASE_SHA: base, RESCUE_BRANCH: rescueBranch },
        edges.runDir,
        agentLimit.signal,
      );
      if (prepared.timedOut) timedOut();
      else if (!prepared.ok) agent.result = "failure";
    }
    if (going()) {
      const set = await setup(job.variables.AGENT_SETUP, agentLimit.signal);
      if (set.timedOut) timedOut();
      else if (!set.ok) {
        agent.result = "failure";
        notStarted("implement", set.failureReason ?? "The repository's setup (`AGENT_SETUP`) failed.");
      }
    }
    // The runner gets a `read` token of its own, minted as it starts, since
    // the setup before it can take a good part of the first one's hour.
    const runnerToken = going() ? await ask("read") : undefined;
    if (going() && runnerToken === undefined) {
      agent.result = "failure";
      notStarted("implement", "The service's dispatcher granted no token for the agent to read the issue with.");
    }
    if (going() && runnerToken !== undefined) {
      const built = await runAgent(
        "implement",
        {
          ...common,
          GH_TOKEN: runnerToken,
          AGENT_MODEL: job.variables.AGENT_MODEL,
          AGENT_MODEL_IMPLEMENT: job.variables.AGENT_MODEL_IMPLEMENT,
          BRANCH: branch,
          RESCUE_BRANCH: rescueBranch,
        },
        checkout,
        agentLimit.signal,
      );
      if (built.timedOut) timedOut();
      else if (!built.ok) agent.result = "failure";
    }
    agentLimit.clear();

    // However the steps before it ended, as the bundle step's `always()`, so
    // a stopped run hands its commits over for conclude to rescue (#270). It
    // is handed no token, and has a limit of its own, since the agent's may
    // have fired.
    const bundleLimit = limit(BUNDLE_MINUTES);
    const bundled = await run("implement:bundle", { CHECKOUT: checkout, BRANCH: branch, BASE_SHA: base }, edges.runDir, bundleLimit.signal);
    bundleLimit.clear();
    bundleOutcome = bundled.timedOut ? "cancelled" : bundled.ok ? "success" : "failure";
    if (bundled.timedOut && agent.result === "success") agent.result = "cancelled";
    else if (!bundled.ok && agent.result === "success") agent.result = "failure";
  }
  const agentRan = agent.result !== "skipped";

  // 3. The publish job, which runs wherever the gate did not refuse: its
  // token, then, where the gate claimed the run, a checkout of the base of
  // its own, which publish pushes from and conclude checks a stopped run's
  // bundle in before it rescues it; then, where the agent's job succeeded and
  // the mint did, publish. Where `push` was refused, conclude is handed a
  // `write` token instead, for its comment and labels, and the checkout is
  // made with that. A checkout that failed is publish's failure, with its
  // reason, or its cancel where it ran out of time, where Actions skips
  // publish. There is nothing to download: the hand-over is on this disk.
  const push = await ask("push");
  const mintOutcome = push === undefined ? "failure" : "success";
  const concluding = push ?? (await ask("write"));
  const publishLimit = limit(IMPLEMENT_POSTING_MINUTES);
  let checkedOut = false;
  let checkoutFailed: { readonly timedOut: boolean; readonly why: string } | undefined;
  if (refused === "false" && concluding !== undefined) {
    try {
      await checkOut(publishCheckout, concluding, publishLimit.signal);
      note("checkout", "success");
      checkedOut = true;
    } catch (error) {
      const timedOut = publishLimit.signal.aborted;
      note("checkout", timedOut ? "timed out" : `failure: ${message(error)}`);
      checkoutFailed = { timedOut, why: message(error) };
    }
  }
  let publishOutcome = "";
  const publishDir = outputDir("implement:publish");
  if (push !== undefined && agent.result === "success") {
    if (checkoutFailed !== undefined) {
      publishOutcome = checkoutFailed.timedOut ? "cancelled" : "failure";
      if (!checkoutFailed.timedOut) {
        notStarted("implement:publish", `\`${job.baseRef}\` could not be checked out to publish the branch: ${checkoutFailed.why}`);
      }
    }
    if (checkedOut) {
      const published = await run(
        "implement:publish",
        {
          ...common,
          GH_TOKEN: push,
          LOOP_TOKEN: push,
          LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
          BRANCH: branch,
          BASE_SHA: base,
          BRANCH_TIP: gate["tip"],
          RESCUE_BRANCH: rescueBranch,
          CHECKOUT: publishCheckout,
          BUNDLE_DIR: bundleDir,
        },
        edges.runDir,
        publishLimit.signal,
      );
      publishOutcome = published.timedOut ? "cancelled" : published.ok ? "success" : "failure";
    }
  }
  publishLimit.clear();

  // 4. Conclude, however the run ended, with the `push` token. Where that was
  // refused it is told the mint failed, and holds the `write` token, which is
  // all its comment and labels need, and no loop token, so it rescues nothing.
  if (concluding === undefined) {
    // Nothing can say so on the issue, so the worker's log says why the run
    // ended as well.
    const ended = agent.timedOut ? `the build timed out after ${minutes} minutes` : `the gate's result was ${gateResult}, and the agent's ${agent.result}`;
    note("implement:conclude", `not run: the dispatcher granted no token to write the ending with, and the run had ended so: ${ended}`);
    return done();
  }
  const concludeLimit = limit(IMPLEMENT_POSTING_MINUTES);
  await run(
    "implement:conclude",
    {
      ...common,
      GH_TOKEN: concluding,
      // The loop's token is the `push` token alone: empty where the mint
      // failed, as the publish job's is, so conclude rescues nothing then.
      LOOP_TOKEN: push,
      LOOP_TOKEN_SOURCE: push === undefined ? undefined : TOKEN_SOURCE,
      CHECKOUT: publishCheckout,
      RESCUE_BRANCH: rescueBranch,
      BRANCH: branch,
      BASE_SHA: base,
      REFUSED: refused,
      GATE_RESULT: gateResult,
      GATE_REASON: gateReason,
      AGENT_RESULT: agent.result,
      TIMED_OUT: String(agent.timedOut),
      TIMEOUT_MINUTES: String(minutes),
      MINT_OUTCOME: mintOutcome,
      DOWNLOAD_OUTCOME: agentRan ? "success" : "",
      PUBLISH_OUTCOME: publishOutcome,
      BUNDLE_OUTCOME: bundleOutcome,
      PUBLISH_DIR: publishDir,
      PREPARE_DIR: outputDir("implement:prepare"),
      IMPLEMENT_DIR: outputDir("implement"),
      BUNDLE_DIR: bundleDir,
    },
    edges.runDir,
    concludeLimit.signal,
  );
  concludeLimit.clear();
  return done();
};

/**
 * **An implement-prd job**: one run of a PRD's chain, in `implement-prd.yml`'s
 * order and under each of its jobs' and steps' `if:`s, which the `Actions
 * orchestrator:` blocks of spec §7 describe. It is dispatched beside an
 * implement job on every `agent:implement`, and each gate defers the other's
 * issue shape without a word.
 *
 * 1. The gate job: a `write` token, then `implement-prd:gate`, which defers a
 *    regular issue to implement without a word, refuses, or claims the PRD and
 *    decides what the run does: `build` the next slice, `open-only` a missing
 *    PRD PR, or `finishing`, hand the PRD PR over. A refusal or a deferral
 *    (`refused` `true`) ends the run there, as on Actions it skips every job
 *    after the gate: no token is asked for after it, and neither the
 *    catch-up, the agent's job, publish nor conclude runs.
 * 2. The catch-up job, only where the gate succeeded, claimed the run and
 *    decided to build: a `push` token, a checkout of the base branch, and
 *    `implement-prd:catch-up` in it, which merges the base into the PRD
 *    branch and pushes, or parks the chain on a conflict.
 * 3. The agent's job, only where the catch-up succeeded and did not park: a
 *    `read` token, a checkout of the base branch, by name, of its own;
 *    `implement-prd:prepare`, with the same token, which fetches the PRD
 *    branch and checks it out at the tip the catch-up left, and the rescue
 *    branch; the repository's setup, in the sandbox; a fresh `read`
 *    token, then the runner, with it as `GH_TOKEN`; and
 *    `implement-prd:bundle`, with no token, however those ended.
 * 4. The publish job, wherever the gate did not refuse, an undecided gate
 *    included: a `push` token, or where that is refused a `write` token, and
 *    where the gate claimed the run a checkout of its own: of the tip the
 *    catch-up left, as the PRD branch, where it left one, which the bundle
 *    needs, and of the base branch by name otherwise. Then
 *    `implement-prd:publish`, only where the gate succeeded, the push token
 *    was granted and the checkout made, and the run is the finishing one,
 *    builds nothing, or its agent's job succeeded; and
 *    `implement-prd:conclude`, however the run ended.
 *
 * The runner never holds a token that writes: `push` is asked for by the
 * catch-up, before the agent's job and in a checkout of its own, and again
 * once the agent's job is over, and handed to the commands alone.
 *
 * **Every phase has a time limit**, as every job on Actions does: the gate
 * `IMPLEMENT_PRD_GATE_MINUTES`; the catch-up's checkout and the catch-up
 * `CATCH_UP_MINUTES`; the agent's job's steps share `AGENT_TIMEOUT_MINUTES`
 * (`fixTimeLimit`), and one still running at it is ended and conclude told
 * the run timed out; the bundle `BUNDLE_MINUTES`, so a stopped build still
 * hands its commits over for the rescue; publish's checkout and publish share
 * `IMPLEMENT_PRD_POSTING_MINUTES`, and conclude has as long.
 */
const runImplementPrd = async (job: ImplementPrdJob, edges: JobEdges): Promise<readonly Phase[]> => {
  const { note, limit, outputDir, checkout, ask, run, runAgent, setup, notStarted, done } = startRun(job, edges);
  const catchUpCheckout = path.join(edges.runDir, "catch-up-checkout");
  const publishCheckout = path.join(edges.runDir, "publish-checkout");
  const rescueBranch = prdRescueBranch(job.issue);

  /** What every phase of this job is told: the parent, its base, the run's link, and the loop's account, the App's login (spec §4.1). */
  const common = {
    GH_REPO: job.repo,
    ISSUE_NUMBER: String(job.issue),
    ISSUE_TITLE: job.title,
    BASE_REF: job.baseRef,
    RUN_URL: serviceRunUrl(job.appLogin),
    AGENT_LOOP_LOGINS: job.appLogin,
  };

  // 1. The gate job. It writes, its refusals, the permission probe, the start
  // comments and the slice building in the PRD PR's list, so its token is
  // `write`, as the gate job's own token has `issues: write` and
  // `pull-requests: write`.
  let gateResult: JobResult = "failure";
  let gateReason: string | undefined;
  let gate: Readonly<Record<string, string>> = {};
  let slice: { readonly number?: string; readonly title?: string } = {};
  const gateDir = outputDir("implement-prd:gate");
  const claiming = await ask("write");
  if (claiming === undefined) {
    note("implement-prd:gate", "not run: the dispatcher granted no token to claim the PRD with");
  } else {
    const gateLimit = limit(IMPLEMENT_PRD_GATE_MINUTES);
    const gated = await run("implement-prd:gate", { ...common, GH_TOKEN: claiming, ISSUE_STATE: job.state }, edges.runDir, gateLimit.signal);
    gateLimit.clear();
    gate = decisions(gated.dir, "gate.json");
    slice = sliceOf(gated.dir);
    gateResult = gated.timedOut ? "cancelled" : gated.ok ? "success" : "failure";
    gateReason = reason(gated.dir, "failure_reason.txt");
  }
  // The gate job's `refused`: empty where the gate decided nothing.
  const refused = gate["proceed"] === "true" ? "false" : gate["proceed"] === "false" ? "true" : "";
  // The gate said it and took the label off, or deferred a regular issue to
  // implement and says nothing by design: no job after the gate runs, so no
  // token is asked for after it and conclude does not run.
  if (refused === "true") {
    note("implement-prd:gate", "refused or deferred: the run ends here, as no job after the gate runs then");
    return done();
  }
  // The gate job's outputs, as its glue step copies them out of `gate.json`:
  // `build` and `finishing` empty where it decided nothing.
  const decision = gate["decision"];
  const build = decision === undefined ? "" : String(decision === "build");
  const finishing = decision === undefined ? "" : String(decision === "finishing");
  const prdBranch = gate["prdBranch"] ?? "";
  const prdTip = gate["prdTip"] ?? "";
  const prdPr = gate["prdPr"];
  const sub = slice.number;

  /**
   * A checkout into `dir`, with `token`: of the base branch by its name, as
   * each of the reusable's jobs checks it out, unless `head` is given, the tip
   * the catch-up left, which is then checked out as the PRD branch, with the
   * base fetched beside it. `implement-prd:prepare` fetches the PRD branch
   * and checks it out at that tip itself, so the agent's job takes the base.
   * The publish job takes `head` where there is one: the bundle is the PRD
   * branch less that tip, and `implement-prd:publish` and
   * `implement-prd:conclude` each check it before fetching anything, so the
   * checkout must already hold it. On Actions `fetch-depth: 0` fetches every
   * branch, the PRD branch among them; this checkout fetches the base alone,
   * with every tag, as `fetch-depth: 0` brings them.
   */
  const checkOut = (dir: string, token: string, signal: AbortSignal, head = ""): Promise<void> =>
    edges.git.checkout({
      dir,
      repo: job.repo,
      branch: head === "" ? job.baseRef : prdBranch,
      sha: head === "" ? job.baseRef : head,
      baseRef: job.baseRef,
      token,
      committer: job.appLogin,
      signal,
    });

  // 2. The catch-up job, where the gate succeeded, claimed the run and decided
  // to build. It pushes, the merge of the base, and parks on a conflict, so
  // its token is `push`.
  let catchUpResult: JobResult = "skipped";
  let caughtUp: Readonly<Record<string, string>> = {};
  if (gateResult === "success" && refused === "false" && build === "true") {
    const pushing = await ask("push");
    if (pushing === undefined) {
      catchUpResult = "failure";
      notStarted("implement-prd:catch-up", "The service's dispatcher granted no token to bring the PRD branch up to date with, so nothing was built.");
    } else {
      const catchUpLimit = limit(CATCH_UP_MINUTES);
      let checkedOut = false;
      try {
        await checkOut(catchUpCheckout, pushing, catchUpLimit.signal);
        note("checkout", "success");
        checkedOut = true;
      } catch (error) {
        if (catchUpLimit.signal.aborted) {
          note("checkout", "timed out");
          catchUpResult = "cancelled";
        } else {
          note("checkout", `failure: ${message(error)}`);
          catchUpResult = "failure";
          notStarted("implement-prd:catch-up", `\`${job.baseRef}\` could not be checked out to bring the PRD branch up to date, so nothing was built: ${message(error)}`);
        }
      }
      if (checkedOut) {
        const caught = await run(
          "implement-prd:catch-up",
          {
            ...common,
            GH_TOKEN: pushing,
            LOOP_TOKEN: pushing,
            LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
            PRD_BRANCH: prdBranch,
            PRD_TIP: prdTip,
            PRD_PR: prdPr,
            SUB: sub,
            CHECKOUT: catchUpCheckout,
          },
          edges.runDir,
          catchUpLimit.signal,
        );
        caughtUp = decisions(caught.dir, "catch-up.json");
        catchUpResult = caught.timedOut ? "cancelled" : caught.ok ? "success" : "failure";
      }
      catchUpLimit.clear();
    }
  }
  // The catch-up job's outputs: whether it parked, the merge it pushed, and the tip it left.
  const parked = caughtUp["parked"] ?? "";
  const head = caughtUp["head"] ?? "";

  // 3. The agent's job, where the gate and the catch-up succeeded and the
  // catch-up did not park the chain.
  const minutes = fixTimeLimit(job.variables.AGENT_TIMEOUT_MINUTES);
  const agent: { result: JobResult; timedOut: boolean } = { result: "skipped", timedOut: false };
  const runnerDir = outputDir("implement-prd");
  const bundleDir = outputDir("implement-prd:bundle");
  if (gateResult === "success" && refused === "false" && build === "true" && catchUpResult === "success" && parked !== "true") {
    agent.result = "success";
    const agentLimit = limit(minutes);
    /** The agent's job ran past its time limit, which ends it as Actions ends a job at its `timeout-minutes`. */
    const timedOut = (): void => {
      agent.result = "cancelled";
      agent.timedOut = true;
    };
    const going = (): boolean => agent.result === "success";

    const read = await ask("read");
    if (read === undefined) {
      agent.result = "failure";
      notStarted("implement-prd:prepare", "The service's dispatcher granted no token to read the repository with, so nothing was built.");
    } else {
      try {
        await checkOut(checkout, read, agentLimit.signal);
        note("checkout", "success");
      } catch (error) {
        if (agentLimit.signal.aborted) {
          note("checkout", "timed out");
          timedOut();
        } else {
          note("checkout", `failure: ${message(error)}`);
          agent.result = "failure";
          notStarted("implement-prd:prepare", `\`${job.baseRef}\` could not be checked out to build on, so nothing was built: ${message(error)}`);
        }
      }
    }
    if (going() && read !== undefined) {
      // The agent's job's read token, as on Actions, where it fetches the PRD
      // branch and the rescue branch.
      const prepared = await run(
        "implement-prd:prepare",
        { ...common, GH_TOKEN: read, CHECKOUT: checkout, PRD_BRANCH: prdBranch, PRD_TIP: prdTip, BASE_SHA: head, SUB: sub, RESCUE_BRANCH: rescueBranch },
        edges.runDir,
        agentLimit.signal,
      );
      if (prepared.timedOut) timedOut();
      else if (!prepared.ok) agent.result = "failure";
    }
    if (going()) {
      const set = await setup(job.variables.AGENT_SETUP, agentLimit.signal);
      if (set.timedOut) timedOut();
      else if (!set.ok) {
        agent.result = "failure";
        notStarted("implement-prd", set.failureReason ?? "The repository's setup (`AGENT_SETUP`) failed.");
      }
    }
    // The runner gets a `read` token of its own, minted as it starts, since
    // the setup before it can take a good part of the first one's hour.
    const runnerToken = going() ? await ask("read") : undefined;
    if (going() && runnerToken === undefined) {
      agent.result = "failure";
      notStarted("implement-prd", "The service's dispatcher granted no token for the agent to read the PRD with.");
    }
    if (going() && runnerToken !== undefined) {
      const built = await runAgent(
        "implement-prd",
        {
          ...common,
          GH_TOKEN: runnerToken,
          AGENT_MODEL: job.variables.AGENT_MODEL,
          AGENT_MODEL_IMPLEMENT_PRD: job.variables.AGENT_MODEL_IMPLEMENT_PRD,
          BRANCH: prdBranch,
          SUB_NUMBER: sub,
          SUB_TITLE: slice.title,
          RESCUE_BRANCH: rescueBranch,
        },
        checkout,
        agentLimit.signal,
      );
      if (built.timedOut) timedOut();
      else if (!built.ok) agent.result = "failure";
    }
    agentLimit.clear();

    // However the steps before it ended, as the bundle step's `always()`, so
    // a stopped build hands its commits over for conclude to rescue. It is
    // handed no token.
    const bundleLimit = limit(BUNDLE_MINUTES);
    const bundled = await run("implement-prd:bundle", { CHECKOUT: checkout, PRD_BRANCH: prdBranch, BASE_SHA: head }, edges.runDir, bundleLimit.signal);
    bundleLimit.clear();
    if (bundled.timedOut && agent.result === "success") agent.result = "cancelled";
    else if (!bundled.ok && agent.result === "success") agent.result = "failure";
  }
  const agentRan = agent.result !== "skipped";

  // 4. The publish job, which runs wherever the gate did not refuse. Its
  // token, then, where the gate claimed the run, a checkout of its own: of
  // the tip the catch-up left, as the PRD branch, where it left one, since
  // the bundle is built on it and publish and conclude's rescue check it
  // there before fetching anything; of the base by name otherwise. Where
  // `push` was refused,
  // conclude is told the mint failed and is handed a `write` token instead,
  // for its comment and labels, and the checkout is made with that. There is
  // nothing to download: the hand-over is on this disk.
  const push = await ask("push");
  const mintOutcome = push === undefined ? "failure" : "success";
  const concluding = push ?? (await ask("write"));
  const publishLimit = limit(IMPLEMENT_PRD_POSTING_MINUTES);
  let checkedOut = false;
  let checkoutFailed: { readonly timedOut: boolean; readonly why: string } | undefined;
  if (refused === "false" && concluding !== undefined) {
    try {
      await checkOut(publishCheckout, concluding, publishLimit.signal, head);
      note("checkout", "success");
      checkedOut = true;
    } catch (error) {
      const timedOut = publishLimit.signal.aborted;
      note("checkout", timedOut ? "timed out" : `failure: ${message(error)}`);
      checkoutFailed = { timedOut, why: message(error) };
    }
  }
  // "Publish the slice" runs where the gate succeeded and the run is the
  // finishing one, builds nothing, or its agent's job succeeded, and every
  // step before it in the publish job did, the mint and the checkout among
  // them. A checkout that failed is publish's failure, with its reason, or
  // its cancel where it ran out of time, where Actions skips publish; a
  // publish its own `if:` skips is `skipped`, which conclude reads for a
  // parked chain.
  const publishes = gateResult === "success" && (finishing === "true" || build === "false" || agent.result === "success");
  let publishOutcome = "skipped";
  const publishDir = outputDir("implement-prd:publish");
  if (publishes && push !== undefined && checkoutFailed !== undefined) {
    publishOutcome = checkoutFailed.timedOut ? "cancelled" : "failure";
    if (!checkoutFailed.timedOut) {
      notStarted("implement-prd:publish", `\`${head === "" ? job.baseRef : prdBranch}\` could not be checked out to publish with: ${checkoutFailed.why}`);
    }
  }
  if (publishes && push !== undefined && checkedOut) {
    const published = await run(
      "implement-prd:publish",
      {
        ...common,
        GH_TOKEN: push,
        LOOP_TOKEN: push,
        LOOP_TOKEN_SOURCE: TOKEN_SOURCE,
        CHECKOUT: publishCheckout,
        GATE_DIR: gateDir,
        BUNDLE_DIR: bundleDir,
        PRD_BRANCH: prdBranch,
        PRD_TIP: prdTip,
        BUILD: build,
        FINISHING: finishing,
        PRD_PR: prdPr,
        LANDED: gate["landed"],
        BASE_SHA: head,
        SUB: sub,
        RESCUE_BRANCH: rescueBranch,
      },
      edges.runDir,
      publishLimit.signal,
    );
    publishOutcome = published.timedOut ? "cancelled" : published.ok ? "success" : "failure";
  }
  publishLimit.clear();

  // Conclude, however the run ended.
  if (concluding === undefined) {
    // Nothing can say so on the parent, so the worker's log says why the run
    // ended as well.
    const ended = agent.timedOut
      ? `the build timed out after ${minutes} minutes`
      : `the gate's result was ${gateResult}, the catch-up's ${catchUpResult}, and the agent's ${agent.result}`;
    note("implement-prd:conclude", `not run: the dispatcher granted no token to write the ending with, and the run had ended so: ${ended}`);
    return done();
  }
  const concludeLimit = limit(IMPLEMENT_PRD_POSTING_MINUTES);
  await run(
    "implement-prd:conclude",
    {
      ...common,
      GH_TOKEN: concluding,
      // The loop's token is the `push` token alone: empty where the mint
      // failed, as the publish job's is, so conclude rescues nothing then.
      LOOP_TOKEN: push,
      LOOP_TOKEN_SOURCE: push === undefined ? undefined : TOKEN_SOURCE,
      CHECKOUT: publishCheckout,
      RESCUE_BRANCH: rescueBranch,
      REFUSED: refused,
      BUILD: build,
      FINISHING: finishing,
      PRD_BRANCH: prdBranch,
      PRD_PR: prdPr,
      SUB: sub,
      BASE_SHA: head,
      MERGED: caughtUp["merged"],
      GATE_RESULT: gateResult,
      GATE_REASON: gateReason,
      CATCH_UP_RESULT: catchUpResult,
      AGENT_RESULT: agent.result,
      TIMED_OUT: String(agent.timedOut),
      TIMEOUT_MINUTES: String(minutes),
      MINT_OUTCOME: mintOutcome,
      // The agent's hand-over is fetched on a build alone, and is missing
      // where the agent's job did not run, as an artifact never uploaded is.
      DOWNLOAD_OUTCOME: build === "true" ? (agentRan ? "success" : "failure") : "skipped",
      PUBLISH_OUTCOME: publishOutcome,
      GATE_DIR: gateDir,
      // Holds a reason only where the catch-up failed, as its hand-over is
      // uploaded only then.
      CATCH_UP_DIR: outputDir("implement-prd:catch-up"),
      PREPARE_DIR: outputDir("implement-prd:prepare"),
      IMPLEMENT_PRD_DIR: runnerDir,
      BUNDLE_DIR: bundleDir,
      PUBLISH_DIR: publishDir,
    },
    edges.runDir,
    concludeLimit.signal,
  );
  concludeLimit.clear();
  return done();
};

/**
 * **A follow-ups job**: the filing run on one closed pull request, as
 * `follow-ups.yml`'s one job runs it, which the `Actions orchestrator:`
 * blocks of spec §11 describe.
 *
 * 1. A `write` token, the job's one: `follow-ups:file` files the stubs,
 *    posts the report and takes the marker off with it, as the job's token
 *    has `issues: write` and `pull-requests: write`.
 * 2. `follow-ups:file`, held to the job's `FOLLOW_UPS_MINUTES`.
 * 3. `follow-ups:conclude`, however file ended, told how and whether it ran
 *    out of time, and pointed at its directory, with the same token.
 *
 * No checkout, no setup and no agent: nothing here reads the repository's
 * code. Each command runs in the run's own directory.
 *
 * **One at a time per pull request is the lock.** Actions holds this job in
 * the pull request's concurrency group, so a label added while a merge's run
 * files cannot file twice. Here the worker's queue (`lanes`) runs one job at a
 * time for each pull request, in the order they arrived, whatever lane each
 * runs in, so the second run finds the marker the first took off and ends
 * silently. That holds on one worker only.
 */
const runFollowUps = async (job: FollowUpsJob, edges: JobEdges): Promise<readonly Phase[]> => {
  const { note, limit, ask, run, done } = startRun(job, edges);
  const common = { GH_REPO: job.repo, PR_NUMBER: String(job.pr) };

  const write = await ask("write");
  if (write === undefined) {
    // Nothing can say so on the pull request, so the worker's log says it.
    // The marker stays on, so adding it again is the retry.
    note("follow-ups:file", "not run: the dispatcher granted no token to file with, so neither it nor follow-ups:conclude ran, and nothing was written");
    return done();
  }

  const fileLimit = limit(FOLLOW_UPS_MINUTES);
  const filed = await run("follow-ups:file", { ...common, GH_TOKEN: write, AGENT_LOOP_LOGINS: job.appLogin }, edges.runDir, fileLimit.signal);
  fileLimit.clear();

  // `always()` on Actions, cancel and timeout included: conclude gets a limit
  // of its own, as a step after a timed-out one still runs there.
  const concludeLimit = limit(FOLLOW_UPS_MINUTES);
  await run(
    "follow-ups:conclude",
    {
      ...common,
      GH_TOKEN: write,
      RUN_URL: serviceRunUrl(job.appLogin),
      // A time limit ends a job on Actions as a cancel, which the measuring
      // step then reads as a timeout.
      JOB_STATUS: filed.timedOut ? "cancelled" : filed.ok ? "success" : "failure",
      TIMED_OUT: String(filed.timedOut),
      TIMEOUT_MINUTES: String(FOLLOW_UPS_MINUTES),
      FILE_DIR: filed.dir,
    },
    edges.runDir,
    concludeLimit.signal,
  );
  concludeLimit.clear();
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
    // The release first (#601): a job from another reads as malformed wherever the format moved, and the mismatch is the cause.
    const { version, id } = typeof body === "object" && body !== null ? (body as Readonly<Record<string, unknown>>) : {};
    if (typeof version === "string" && version !== "" && version !== edges.version) {
      const which = typeof id === "string" && id !== "" ? `job ${id}` : "the job";
      return answer(409, { refusal: `${which} is from a dispatcher at ${version}, and this worker is at ${edges.version}` });
    }
    const job = parseJob(body);
    if (typeof job === "string") return answer(400, { refusal: job });
    edges.accept(job);
    return answer(202, { accepted: job.id });
  };

/** What the held door needs: the shared secret, what the worker holds now, and how it drops a queued job. */
export interface HeldDoorEdges {
  readonly secret: string;
  /** Every job queued or running, in the order they arrived. */
  readonly held: () => readonly Job[];
  /** Takes every queued job `dropped` matches out of the queue, never one that has started, so it never runs. */
  readonly drop: (dropped: (job: Job) => boolean) => readonly Job[];
  /** The worker's clock, which a question's `asked` is held to. */
  readonly now?: () => Date;
}

/**
 * **The held door** (#581). The dispatcher's scan asks, signed with the
 * shared secret as a job is, which jobs the worker has queued or is running,
 * so a label a job is already held for is not dispatched twice. A request
 * whose signature does not verify is refused, `401`, and one that is not the
 * question, `400`, as is one asked more than `HELD_REQUEST_MAX_AGE_MINUTES`
 * ago or `HELD_REQUEST_MAX_SKEW_MINUTES` ahead (#601), so a captured question
 * cannot be replayed later to empty the queue. The question names the
 * dispatcher instance asking (#597): every job queued from another is
 * dropped first, since no dispatcher running now would mint for it, and the
 * scan dispatches its item again. A job that has started is not, running in
 * either lane (`lanes`) or waiting for the agent lane: this door cannot stop
 * it, and it ends at its next token request. A question naming no
 * instance drops nothing (#601): it only reads. Every other request is
 * answered `200` with each job still held: its id, kind, repository and number.
 */
export const heldDoor =
  (edges: HeldDoorEdges) =>
  (request: DoorRequest): DoorResponse => {
    if (!verifySignature(edges.secret, request.body, request.headers[SIGNATURE_HEADER])) return answer(401, { refusal: "bad signature" });
    let body: unknown;
    try {
      body = JSON.parse(request.body.toString("utf8"));
    } catch {
      return answer(400, { refusal: "the body is not JSON" });
    }
    const asked = parseHeldRequest(body);
    if (typeof asked === "string") return answer(400, { refusal: asked });
    const age = ((edges.now ?? (() => new Date()))().getTime() - Date.parse(asked.asked)) / 60_000;
    if (age > HELD_REQUEST_MAX_AGE_MINUTES) {
      return answer(400, { refusal: `\`asked\` is ${asked.asked}, more than ${HELD_REQUEST_MAX_AGE_MINUTES} minutes ago by this worker's clock` });
    }
    if (-age > HELD_REQUEST_MAX_SKEW_MINUTES) {
      return answer(400, { refusal: `\`asked\` is ${asked.asked}, more than ${HELD_REQUEST_MAX_SKEW_MINUTES} minute ahead of this worker's clock` });
    }
    const { instance } = asked;
    if (instance !== undefined) edges.drop((job) => job.instance !== instance);
    return answer(200, { jobs: edges.held().map(heldOf) });
  };

/** A queue, and what it holds. */
export interface Queue<T> {
  /** Puts `item` at the back. */
  readonly add: (item: T) => void;
  /** Every item queued or running, in the order they arrived: one leaves once its work has ended, or when it is dropped before its turn. */
  readonly held: () => readonly T[];
  /**
   * Takes every queued item `dropped` matches out of the queue, so its work
   * never starts, and answers them in the order they arrived. An item
   * whose work has started is never taken, waiting for a lane or not.
   */
  readonly drop: (dropped: (item: T) => boolean) => readonly T[];
}

/**
 * Which of the worker's two lanes a kind runs in (#582), decided by what the
 * kind *can* do, since whether a job starts an agent is often known only once
 * its gate or merge has run. `light` starts no agent: follow-ups. `agent` can
 * start one, and a gate that refuses ends it early in the same lane.
 * `hand-off` runs in the light lane until it would start an agent, then waits
 * for the agent lane: update-branch, whose clean merge needs no agent.
 */
export const LANES: Readonly<Record<JobKind, "light" | "agent" | "hand-off">> = {
  review: "agent",
  fix: "agent",
  "update-branch": "hand-off",
  implement: "agent",
  "implement-prd": "agent",
  "follow-ups": "light",
};

/** A job the queue holds, and how far it has got. */
interface Held {
  readonly job: Job;
  readonly lane: (typeof LANES)[JobKind];
  /** The pull request or issue it is for: two jobs for one never run at once. */
  readonly item: string;
  /** Waiting its turn; in the light lane; handed off and waiting for the agent lane; in the agent lane. */
  state: "queued" | "light" | "waiting" | "agent";
  /** Ends a hand-off's wait, once it has the agent lane. */
  resume?: () => void;
}

/**
 * **The worker's queue** (#582): two lanes, each running one job at a time,
 * beneath a chain per pull request or issue.
 *
 * - **The agent lane** runs `agent` jobs, and a `hand-off` job's agent part,
 *   strictly in the order they arrived: a `hand-off` job holds its place in it
 *   from its arrival, so the lane waits at that place until the job either
 *   asks for the lane (`agentLane`, handed to its work) or ends without one.
 *   So two agent jobs never run at once, and no agent job waits behind one
 *   that arrived after it, nor longer than it would have in one queue.
 * - **The light lane** runs `light` jobs and a `hand-off` job until it asks
 *   for the agent lane, which frees the light lane for the next. It takes the
 *   first that arrived whose item is free, so a light job waiting on its item
 *   holds up no other.
 * - **Per item**, a job starts only once every job for its item that arrived
 *   before it has ended, so two jobs for one item run in arrival order and
 *   never overlap, whatever their lanes.
 *
 * Nothing here reads a deadline: it is the dispatcher's, set at dispatch, so a
 * job's wait counts against it in either lane, and a job late by its turn ends
 * at its first token request, as one late in a single queue did. A job that
 * throws does not stop the ones behind it, and one dropped before its turn is
 * passed over.
 */
export const lanes = (work: (job: Job, agentLane: () => Promise<void>) => Promise<void>, onError: (error: unknown) => void): Queue<Job> => {
  const entries: Held[] = [];
  let light: Held | undefined;
  let agent: Held | undefined;

  /** No job for its item arrived before it and is still held. */
  const itemFree = (entry: Held): boolean => !entries.slice(0, entries.indexOf(entry)).some((before) => before.item === entry.item);

  const start = (entry: Held): void => {
    const agentLane = (): Promise<void> => {
      // Only a hand-off waits: any other job is already in the lane it ends in.
      if (entry.state !== "light" || entry.lane !== "hand-off") return Promise.resolve();
      return new Promise<void>((resolve) => {
        entry.state = "waiting";
        entry.resume = resolve;
        light = undefined;
        pump();
      });
    };
    void Promise.resolve()
      .then(() => work(entry.job, agentLane))
      .catch(onError)
      .finally(() => {
        entries.splice(entries.indexOf(entry), 1);
        if (light === entry) light = undefined;
        if (agent === entry) agent = undefined;
        pump();
      });
  };

  const pump = (): void => {
    if (agent === undefined) {
      const front = entries.find((entry) => entry.lane !== "light");
      if (front?.state === "waiting") {
        agent = front;
        front.state = "agent";
        front.resume?.();
      } else if (front?.lane === "agent" && front.state === "queued" && itemFree(front)) {
        agent = front;
        front.state = "agent";
        start(front);
      }
    }
    if (light === undefined) {
      const next = entries.find((entry) => entry.lane !== "agent" && entry.state === "queued" && itemFree(entry));
      if (next !== undefined) {
        light = next;
        next.state = "light";
        start(next);
      }
    }
  };

  return {
    add: (job) => {
      const { repo, number } = heldOf(job);
      entries.push({ job, lane: LANES[job.workflow], item: `${repo}#${number}`, state: "queued" });
      pump();
    },
    held: () => entries.map((entry) => entry.job),
    drop: (dropped) => {
      const taken = entries.filter((entry) => entry.state === "queued" && dropped(entry.job));
      for (const entry of taken) entries.splice(entries.indexOf(entry), 1);
      pump();
      return taken.map((entry) => entry.job);
    },
  };
};
