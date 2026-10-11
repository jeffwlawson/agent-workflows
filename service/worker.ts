import * as fs from "node:fs";
import * as path from "node:path";
import { COMMANDS, RUNNERS, type Command, type Runner } from "../shared/contract.js";
import type { HostEnvironment } from "../shared/env.js";
import type { DoorRequest, DoorResponse } from "./dispatcher.js";
import { parseJob, SIGNATURE_HEADER, verifySignature, type ReviewJob, type TokenKind } from "./job.js";

/**
 * The service orchestrator's worker (#457): it receives jobs from the
 * dispatcher and runs review on each the way `review.yml` does, by running
 * the same subcommands in the same order, each told what the reusable tells
 * it. It writes nothing to the record and spells no record string: every
 * write is a command's. What it reads between them is the hand-over the
 * reusable's glue steps read, `gate.json`, `budget.json` and `verdict.json`,
 * copied across as they are.
 *
 * Its decisions are here, over edges it is handed: the dispatcher's token
 * door, the launcher that starts a subcommand, git, and the host. `serve.ts`
 * puts them behind HTTP, over the live ones in `worker-live.ts`.
 */

/** A subcommand the worker starts. */
export type Subcommand = Runner | Command;

/** One subcommand to start: its name, its whole environment, where it runs, and the file its output goes to. */
export interface Launch {
  readonly subcommand: Subcommand;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly log: string;
}

/** Starts a subcommand of the worker's own package, and answers with its exit code once it has ended. */
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
  }): Promise<void>;
}

/** Asks the dispatcher for a token for one phase of this job. Throws, with the dispatcher's reason, where none is granted. */
export type TokenSource = (kind: TokenKind) => Promise<string>;

export interface JobEdges {
  readonly token: TokenSource;
  readonly launch: Launcher;
  readonly git: Git;
  /** The worker's own `PATH`, `HOME` and `LANG` (`hostEnvironment`), the only part of its environment a subcommand gets. */
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
}

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

/** Every token source a command reads `app` from: the service's tokens are its App's. */
const TOKEN_SOURCE = "app";

/**
 * A subcommand's whole environment, built from its declaration in the
 * contract: every input it declares that `values` has a value for, and the
 * host's `PATH`, `HOME` and `LANG`. Nothing else, so nothing of the worker's
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

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * **One job**: review on one pull request, in `review.yml`'s order and under
 * its conditions, which the `Actions orchestrator:` blocks of spec §8
 * describe.
 *
 * 1. A `read` token, then `review:gate`. Where it does not go ahead, on to 6.
 * 2. The checkout of the commit the gate settled, as `BRANCH`, with the base.
 * 3. `review:budget`, with a budget of 0 (`SERVICE_FIX_ROUND_BUDGET`).
 * 4. `review:collect-checks`, whose failure the review reads as checks unknown.
 * 5. The runner, with the `read` token as `GH_TOKEN`.
 * 6. A `write` token, then `review:publish`, where the review finished.
 * 7. `review:conclude`, however the phases before it ended, told how each did.
 *
 * Each subcommand gets a fresh output directory of its own, and a command
 * that reads another's files is pointed at that one's. Never throws: a phase
 * that fails is an ending conclude is told, and one conclude cannot be run for
 * is the last phase in what this returns, for the worker's log.
 */
export const runJob = async (job: ReviewJob, edges: JobEdges): Promise<readonly Phase[]> => {
  const phases: Phase[] = [];
  const note = (name: string, outcome: string): void => {
    phases.push({ name, outcome });
  };
  const checkout = path.join(edges.runDir, "checkout");
  const outputDir = (name: Subcommand): string => path.join(edges.runDir, "out", name.replace(":", "-"));
  const logs = path.join(edges.runDir, "logs");
  const logFile = (name: Subcommand): string => path.join(logs, `${name.replace(":", "-")}.log`);
  fs.mkdirSync(logs, { recursive: true });

  /** What every phase of this job is told: the pull request, and the loop's account, the App's login (spec §4.1). */
  const common = {
    GH_REPO: job.repo,
    PR_NUMBER: String(job.pr),
    BRANCH: job.branch,
    AGENT_LOOP_LOGINS: job.appLogin,
  };

  const run = async (
    subcommand: Subcommand,
    values: Readonly<Record<string, string | undefined>>,
    cwd: string,
    host: HostEnvironment = edges.host,
  ): Promise<{ readonly ok: boolean; readonly dir: string }> => {
    const dir = outputDir(subcommand);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const env = environmentFor(subcommand, { ...values, OUTPUT_DIR: dir }, host);
    let code: number;
    try {
      code = await edges.launch({ subcommand, env, cwd, log: logFile(subcommand) });
    } catch (error) {
      fs.writeFileSync(path.join(dir, "failure_reason.txt"), `It could not be started: ${message(error)}`);
      code = -1;
    }
    note(subcommand, code === 0 ? "success" : `failure (exit ${code})`);
    return { ok: code === 0, dir };
  };

  const ask = async (kind: TokenKind): Promise<string | undefined> => {
    try {
      const token = await edges.token(kind);
      note(`${kind} token`, "success");
      return token;
    } catch (error) {
      note(`${kind} token`, `failure: ${message(error)}`);
      return undefined;
    }
  };

  /** How the review job ended, as the reusable's `needs.review` outputs say it. */
  const review: { result: "success" | "failure"; failureReason?: string; refusalReason?: string } = { result: "success" };
  const failed = (why: string | undefined): void => {
    review.result = "failure";
    if (why !== undefined) review.failureReason = why;
  };

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
    );
    gate = decisions(ran.dir, "gate.json");
    if (!ran.ok) {
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
      await edges.git.checkout({ dir: checkout, repo: job.repo, branch: job.branch, sha, baseRef: job.baseRef, token: read });
      note("checkout", "success");
    } catch (error) {
      note("checkout", `failure: ${message(error)}`);
      failed(`The pull request's head could not be checked out: ${message(error)}`);
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
    );
    budget = decisions(counted.dir, "budget.json");
    if (!counted.ok) failed(reason(counted.dir, "failure_reason.txt"));
  }
  if (proceeds && read !== undefined && review.result === "success") {
    // Its failure fails nothing: the runner reads checks it has no word for
    // as unknown, as on Actions, where the step continues on error.
    const checks = await run("review:collect-checks", { ...common, GH_TOKEN: read, REVIEWED_SHA: sha, SELF_CHECK: SERVICE_SELF_CHECK }, checkout);
    const reviewed = await run(
      "review",
      {
        ...common,
        ...edges.agent,
        GH_TOKEN: read,
        AGENT_MODEL: job.variables.AGENT_MODEL,
        AGENT_MODEL_REVIEW: job.variables.AGENT_MODEL_REVIEW,
        BASE_REF: job.baseRef,
        ROUND: gate["round"],
        CI_STATUS_FILE: path.join(checks.dir, "ci_status.md"),
        CI_RESULT_FILE: path.join(checks.dir, "ci_result.txt"),
        AUTO_FIX: budget["start"],
        FIX_ROUNDS_SPENT: budget["spent"],
        FIX_ROUND_BUDGET: budget["budget"],
      },
      checkout,
      { ...edges.host, PATH: [edges.cliBin, edges.host.PATH].filter((part) => part !== undefined && part !== "").join(":") },
    );
    reviewDir = reviewed.dir;
    if (reviewed.ok) verdict = decisions(reviewed.dir, "verdict.json");
    else failed(reason(reviewed.dir, "failure_reason.txt"));
  }

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
      const published = await run(
        "review:publish",
        { ...common, GH_TOKEN: write, LOOP_TOKEN: write, LOOP_TOKEN_SOURCE: TOKEN_SOURCE, REVIEWED_SHA: sha, REVIEW_DIR: reviewDir },
        edges.runDir,
      );
      publishOutcome = published.ok ? "success" : "failure";
    }
  }

  // 7. Conclude, however the run ended. It writes, so it needs a token that
  // writes even where publish never asked for one.
  const concluding = write ?? (await ask("write"));
  if (concluding === undefined) {
    note("review:conclude", "not run: the dispatcher granted no token to write the ending with");
    return phases;
  }
  await run(
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
      MINT_OUTCOME: mintOutcome,
      DOWNLOAD_OUTCOME: finished ? "success" : "",
      PUBLISH_OUTCOME: publishOutcome,
      FIX_ROUND_BUDGET: budget["budget"],
      FIX_ROUNDS_SPENT: budget["spent"],
    },
    edges.runDir,
  );
  return phases;
};

/** What the job door needs: the shared secret, the worker's own release, and where an accepted job goes. */
export interface WorkerDoorEdges {
  readonly secret: string;
  readonly version: string;
  /** Queues the job; called only for one that is accepted. */
  readonly accept: (job: ReviewJob) => void;
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
