import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CI_WAIT_SECONDS } from "../../review/collect-checks.js";
import {
  DEFAULT_FIX_MINUTES,
  DEFAULT_REVIEW_MINUTES,
  sign,
  SIGNATURE_HEADER,
  type FixJob,
  type ImplementJob,
  type Job,
  type ReviewJob,
  type TokenKind,
  type UpdateBranchJob,
} from "../../service/job.js";
import {
  IMPLEMENT_GATE_MINUTES,
  IMPLEMENT_POSTING_MINUTES,
  jobDoor,
  REDACTED,
  runJob,
  SETUP_PHASE,
  startRun,
  SUMMARY_FILE,
  type JobEdges,
  type Launch,
  type SandboxRun,
  type Subcommand,
} from "../../service/worker.js";
import { COMMANDS, RUNNERS, type Command, type Runner } from "../../shared/contract.js";
import type { HostEnvironment } from "../../shared/env.js";

/**
 * Seam 1 of PRD #453: the worker's job, driven through `runJob` with fakes at
 * its edges: a dispatcher handing out labelled tokens, a launcher recording
 * each subcommand it is asked to start and writing the files that subcommand
 * would, and git. What is asserted is what reached the child processes, never
 * the order of the worker's own calls.
 */

const HEAD = "a".repeat(40);
const HOST = { PATH: "/host/bin", HOME: "/host/home", LANG: "C.UTF-8" } as const;
const AGENT = {
  CLAUDE_CODE_OAUTH_TOKEN: "the-model-token",
  AGENT_SANDBOX: "bwrap",
  AGENT_SANDBOX_RO_BINDS: "/opt/node:/work/claude-code",
  AGENT_SANDBOX_PATH: "/work/claude-code/bin:/usr/bin",
  AGENT_SANDBOX_PROXY: "http://proxy:3128",
} as const;

const JOB: ReviewJob = {
  workflow: "review",
  id: "job-1",
  version: "9.9.9",
  deadline: "2026-10-11T14:00:00.000Z",
  repo: "owner/repo",
  pr: 7,
  branch: "agent/issue-7-a-thing",
  headSha: HEAD,
  baseRef: "main",
  state: "open",
  merged: false,
  appLogin: "loop-app[bot]",
  variables: {
    AGENT_MODEL: "a-model",
    AGENT_MODEL_REVIEW: "",
    AGENT_MODEL_FIX: "",
    AGENT_MODEL_UPDATE_BRANCH: "",
    AGENT_MODEL_IMPLEMENT: "",
    AGENT_REVIEW_TIMEOUT_MINUTES: "",
    AGENT_TIMEOUT_MINUTES: "",
    AGENT_MAX_FIX_ROUNDS: "3",
    AGENT_SETUP: "",
  },
};

/** What a subcommand writes into its `OUTPUT_DIR`, and how it exits, or that it hangs until its time limit ends it. */
interface Canned {
  readonly files?: Readonly<Record<string, unknown>>;
  readonly exit?: number;
  readonly hangs?: boolean;
}

/** Ends once `signal` aborts, as a hung process does once it is killed. */
const hang = (signal: AbortSignal, code: number): Promise<number> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve(code);
    else signal.addEventListener("abort", () => resolve(code), { once: true });
  });

/** The files each subcommand writes on an ordinary pull request, where every phase goes ahead. */
const ORDINARY: Readonly<Partial<Record<Subcommand, Canned>>> = {
  "review:gate": { files: { "gate.json": { proceed: "true", sha: HEAD, budget: "3" } } },
  "review:budget": { files: { "budget.json": { budget: "0", spent: "0", start: "false" } } },
  "review:collect-checks": { files: { "ci_status.md": "All green.", "ci_result.txt": "green" } },
  review: { files: { "verdict.json": { verdict: "approve", fixRound: false, open: 0 } } },
  "review:publish": { files: { "published.json": { reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1" } } },
  "review:conclude": { files: { "ended.json": { moved: false } } },
};

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "worker-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const setup = (
  canned: Readonly<Partial<Record<Subcommand, Canned>>> = ORDINARY,
  options: {
    readonly minuteMs?: number;
    readonly checkoutHangs?: boolean;
    /** The token requests the dispatcher refuses, counted from 1. */
    readonly refused?: readonly number[];
    readonly host?: HostEnvironment;
    /** How the repository's setup ends in the sandbox: its exit, the output it writes, or that it hangs or cannot start. */
    readonly setupRun?: { readonly exit?: number; readonly output?: string; readonly hangs?: boolean; readonly throws?: string };
  } = {},
) => {
  const sandboxed: SandboxRun[] = [];
  /** Every edge the job touched, in the order it touched them. */
  const events: string[] = [];
  const launched: (Launch & { readonly emptyAtStart: boolean })[] = [];
  const asked: TokenKind[] = [];
  // A run's own directory, fresh, so a test can run more than one job.
  const runDir = fs.mkdtempSync(path.join(scratch, "run-"));
  const edges = {
    token: async (kind: TokenKind) => {
      asked.push(kind);
      events.push(`${kind} token`);
      if (options.refused?.includes(asked.length)) throw new Error("the dispatcher answered 403: the job is past its deadline");
      return `${kind}-token-${asked.length}`;
    },
    launch: async (launch: Launch) => {
      const dir = launch.env["OUTPUT_DIR"];
      if (dir === undefined) throw new Error(`${launch.subcommand} was started with no OUTPUT_DIR`);
      launched.push({ ...launch, emptyAtStart: fs.readdirSync(dir).length === 0 });
      events.push(launch.subcommand);
      const { files = {}, exit = 0, hangs = false } = canned[launch.subcommand] ?? {};
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
      }
      return hangs ? hang(launch.signal, 143) : exit;
    },
    git: {
      checkout: async ({
        signal,
        ...rest
      }: {
        dir: string;
        sha: string;
        branch: string;
        baseRef: string;
        token: string;
        committer: string;
        signal: AbortSignal;
      }) => {
        events.push("checkout");
        checkouts.push(rest);
        if (options.checkoutHangs === true) {
          await hang(signal, 0);
          throw new Error("The operation was aborted");
        }
      },
    },
    sandbox: async (run: SandboxRun) => {
      sandboxed.push(run);
      events.push("sandbox");
      const { exit = 0, output, hangs = false, throws } = options.setupRun ?? {};
      if (throws !== undefined) throw new Error(throws);
      if (output !== undefined) fs.appendFileSync(run.log, output);
      return hangs ? hang(run.signal, 143) : exit;
    },
    host: options.host ?? HOST,
    agent: AGENT,
    cliBin: "/work/claude-code/bin",
    runDir,
    ...(options.minuteMs === undefined ? {} : { minuteMs: options.minuteMs }),
  };
  const checkouts: { dir: string; sha: string; branch: string; baseRef: string; token: string; committer: string }[] = [];
  const env = (subcommand: Subcommand): Readonly<Record<string, string>> => {
    const found = launched.find((launch) => launch.subcommand === subcommand);
    if (found === undefined) throw new Error(`${subcommand} was not started`);
    return found.env;
  };
  return { edges, events, launched, asked, checkouts, env, runDir, sandboxed };
};

const declared = (subcommand: Subcommand) =>
  subcommand in RUNNERS ? RUNNERS[subcommand as Runner].inputs : COMMANDS[subcommand as Command].inputs;

/** The subcommands that read and never write, which get the `read` token alone. */
const READ_ONLY: readonly Subcommand[] = ["review:gate", "review:budget", "review:collect-checks", "review"];

describe("the worker's job, where the gate refuses", () => {
  const REFUSED = { ...ORDINARY, "review:gate": { files: { "gate.json": { proceed: "false", refusal: "The PR changed.", blocked: "false" } } } };

  it("runs the gate, then concludes, and nothing between", async () => {
    const s = setup(REFUSED);
    await runJob(JOB, s.edges);

    expect(s.events).toEqual(["read token", "review:gate", "write token", "review:conclude"]);
    expect(s.checkouts).toEqual([]);
  });

  it("tells the gate the pull request as the label's event saw it", async () => {
    const s = setup(REFUSED);
    await runJob(JOB, s.edges);

    expect(s.env("review:gate")).toMatchObject({
      GH_REPO: "owner/repo",
      GH_TOKEN: "read-token-1",
      PR_NUMBER: "7",
      BRANCH: "agent/issue-7-a-thing",
      HEAD_SHA: HEAD,
      PR_STATE: "open",
      PR_MERGED: "false",
      MAX_FIX_ROUNDS: "3",
    });
  });

  it("tells conclude the gate's refusal, with a token that writes", async () => {
    const s = setup(REFUSED);
    await runJob(JOB, s.edges);

    expect(s.env("review:conclude")).toMatchObject({
      GH_TOKEN: "write-token-2",
      LOOP_TOKEN: "write-token-2",
      LOOP_TOKEN_SOURCE: "app",
      REVIEW_RESULT: "success",
      PROCEED: "false",
      REFUSAL: "The PR changed.",
      BLOCKED: "false",
      AGENT_LOOP_LOGINS: "loop-app[bot]",
    });
    expect(s.env("review:conclude")).not.toHaveProperty("MINT_OUTCOME");
    expect(s.env("review:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });
});

describe("the worker's job, on an ordinary pull request", () => {
  it("runs gate, checkout, budget, collect-checks, the runner, publish and conclude, in that order", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.events).toEqual([
      "read token",
      "review:gate",
      "checkout",
      "review:budget",
      "review:collect-checks",
      "read token",
      "review",
      "write token",
      "review:publish",
      "review:conclude",
    ]);
  });

  it("checks out the commit the gate settled, as the branch, with the base, using the read token", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.checkouts).toEqual([
      {
        dir: path.join(s.runDir, "checkout"),
        repo: "owner/repo",
        branch: "agent/issue-7-a-thing",
        sha: HEAD,
        baseRef: "main",
        token: "read-token-1",
        committer: "loop-app[bot]",
      },
    ]);
    for (const subcommand of ["review:budget", "review:collect-checks", "review"] as const) {
      expect(s.launched.find((launch) => launch.subcommand === subcommand)?.cwd).toBe(path.join(s.runDir, "checkout"));
    }
  });

  it("gives each subcommand exactly the inputs it declares, the host's PATH, HOME and LANG, and nothing of the test's own environment", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.launched).toHaveLength(6);
    for (const { subcommand, env } of s.launched) {
      const inputs = declared(subcommand);
      const allowed = new Set([...Object.keys(inputs), "PATH", "HOME", "LANG"]);
      expect(Object.keys(env).filter((name) => !allowed.has(name)), subcommand).toEqual([]);
      const missing = Object.entries(inputs).filter(([name, input]) => input.required && env[name] === undefined);
      expect(missing.map(([name]) => name), subcommand).toEqual([]);
      expect(env["HOME"], subcommand).toBe(HOST.HOME);
      expect(env["LANG"], subcommand).toBe(HOST.LANG);
      // The host's three are the ones the worker was handed, not the test's own.
      expect(env["PATH"]?.endsWith(HOST.PATH), subcommand).toBe(true);
    }
  });

  it("tells each subcommand to use the worker's proxy, for HTTP and HTTPS, in both cases, and Node's fetch to read them, where it has one", async () => {
    const proxy = "http://127.0.0.1:8888";
    const PROXY = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NODE_USE_ENV_PROXY: "1" };
    const s = setup(ORDINARY, { host: { ...HOST, ...PROXY } });
    await runJob(JOB, s.edges);

    expect(s.launched).toHaveLength(6);
    for (const { subcommand, env } of s.launched) {
      expect(env, subcommand).toMatchObject(PROXY);
      const allowed = new Set([...Object.keys(declared(subcommand)), "PATH", "HOME", "LANG", ...Object.keys(PROXY)]);
      expect(Object.keys(env).filter((name) => !allowed.has(name)), subcommand).toEqual([]);
    }
  });

  it("puts the worker's own claude first on the runner's PATH, and no other's", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.env("review")["PATH"]).toBe(`/work/claude-code/bin:${HOST.PATH}`);
    expect(s.env("review:gate")["PATH"]).toBe(HOST.PATH);
  });

  it("hands the runner the agent's token, the sandbox's settings, and a read token of its own as GH_TOKEN", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.env("review:collect-checks")["GH_TOKEN"]).toBe("read-token-1");
    expect(s.env("review")).toMatchObject({ ...AGENT, GH_TOKEN: "read-token-2", AGENT_MODEL: "a-model", AGENT_LOOP_LOGINS: "loop-app[bot]" });
    expect(s.env("review")).not.toHaveProperty("AGENT_MODEL_REVIEW");
    expect(s.env("review")).not.toHaveProperty("RED_CHECK_CONFIGURED");
  });

  it("puts no write token in the runner's environment, or in any command's that only reads", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    for (const subcommand of READ_ONLY) {
      expect(Object.values(s.env(subcommand)).filter((value) => value.includes("write-token")), subcommand).toEqual([]);
    }
    expect(s.env("review:publish")).toMatchObject({ GH_TOKEN: "write-token-3", LOOP_TOKEN: "write-token-3", LOOP_TOKEN_SOURCE: "app" });
    expect(s.env("review:conclude")).toMatchObject({ GH_TOKEN: "write-token-3", LOOP_TOKEN: "write-token-3", LOOP_TOKEN_SOURCE: "app" });
    expect(s.asked).toEqual(["read", "read", "write"]);
  });

  it("hands review:budget the budget the gate settled from AGENT_MAX_FIX_ROUNDS, as review.yml does", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(JOB.variables.AGENT_MAX_FIX_ROUNDS).toBe("3");
    expect(s.env("review:gate")["MAX_FIX_ROUNDS"]).toBe("3");
    expect(s.env("review:budget")).toMatchObject({ FIX_ROUND_BUDGET: "3", LOOP_TOKEN_SOURCE: "app", BASE_REF: "main" });
  });

  it("hands the runner and conclude a round to start, where the budget has one left, and none where it is spent", async () => {
    const changes = { "verdict.json": { verdict: "request_changes", fixRound: true, open: 2 } };
    const left = setup({
      ...ORDINARY,
      "review:budget": { files: { "budget.json": { budget: "3", spent: "1", start: "true" } } },
      review: { files: changes },
    });
    await runJob(JOB, left.edges);
    expect(left.env("review")).toMatchObject({ AUTO_FIX: "true", FIX_ROUND_BUDGET: "3", FIX_ROUNDS_SPENT: "1" });
    expect(left.env("review:conclude")).toMatchObject({ VERDICT: "request_changes", FIX_ROUND: "true", FIX_ROUND_BUDGET: "3", FIX_ROUNDS_SPENT: "1" });

    const spent = setup({
      ...ORDINARY,
      "review:budget": { files: { "budget.json": { budget: "3", spent: "3", start: "false" } } },
      review: { files: { "verdict.json": { verdict: "request_changes", fixRound: false, open: 2 } } },
    });
    await runJob(JOB, spent.edges);
    expect(spent.env("review")).toMatchObject({ AUTO_FIX: "false", FIX_ROUND_BUDGET: "3", FIX_ROUNDS_SPENT: "3" });
    expect(spent.env("review:conclude")).toMatchObject({ FIX_ROUND: "false", FIX_ROUND_BUDGET: "3", FIX_ROUNDS_SPENT: "3" });
  });

  it("gives every subcommand a fresh output directory of its own", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    const dirs = s.launched.map(({ env }) => env["OUTPUT_DIR"]);
    expect(new Set(dirs).size).toBe(s.launched.length);
    expect(s.launched.filter(({ emptyAtStart }) => !emptyAtStart).map(({ subcommand }) => subcommand)).toEqual([]);
  });

  it("points each command that reads another's files at that one's directory", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    const out = (subcommand: Subcommand): string | undefined => s.env(subcommand)["OUTPUT_DIR"];
    expect(s.env("review")["CI_STATUS_FILE"]).toBe(path.join(out("review:collect-checks")!, "ci_status.md"));
    expect(s.env("review")["CI_RESULT_FILE"]).toBe(path.join(out("review:collect-checks")!, "ci_result.txt"));
    expect(s.env("review:publish")["REVIEW_DIR"]).toBe(out("review"));
    expect(s.env("review:conclude")["PUBLISH_DIR"]).toBe(out("review:publish"));
  });

  it("hands on what the gate and the budget decided, as the reusable's glue does", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.env("review:collect-checks")).toMatchObject({ REVIEWED_SHA: HEAD, SELF_CHECK: "review" });
    expect(s.env("review:collect-checks")).not.toHaveProperty("SELF_RUN_ID");
    expect(s.env("review")).toMatchObject({ AUTO_FIX: "false", FIX_ROUNDS_SPENT: "0", FIX_ROUND_BUDGET: "0" });
    expect(s.env("review:publish")).toMatchObject({ REVIEWED_SHA: HEAD, BRANCH: "agent/issue-7-a-thing" });
  });

  it("tells conclude how each phase ended, and what the review decided", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.env("review:conclude")).toMatchObject({
      REVIEW_RESULT: "success",
      PROCEED: "true",
      REVIEWED_SHA: HEAD,
      VERDICT: "approve",
      FIX_ROUND: "false",
      MINT_OUTCOME: "success",
      DOWNLOAD_OUTCOME: "success",
      PUBLISH_OUTCOME: "success",
      FIX_ROUND_BUDGET: "0",
      FIX_ROUNDS_SPENT: "0",
      TIMED_OUT: "false",
      TIMEOUT_MINUTES: String(CI_WAIT_SECONDS / 60 + DEFAULT_REVIEW_MINUTES),
    });
    // There is no Actions run to link to.
    for (const name of ["GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"]) {
      expect(s.env("review:conclude")).not.toHaveProperty(name);
    }
  });
});

/**
 * Every phase is bounded, as every job on Actions is: the review's phases by
 * its time limit, the CI wait plus its own time, and each posting command by
 * the posting job's. A minute is shortened here so a limit is reached at once.
 */
describe("the worker's job, where a phase runs past its time limit", () => {
  const MINUTE_MS = 5;
  const LIMIT = CI_WAIT_SECONDS / 60 + DEFAULT_REVIEW_MINUTES;

  it.each<[string, Readonly<Partial<Record<Subcommand, Canned>>>, boolean]>([
    ["the runner", { ...ORDINARY, review: { hangs: true } }, false],
    ["the CI wait", { ...ORDINARY, "review:collect-checks": { hangs: true } }, false],
    ["the budget", { ...ORDINARY, "review:budget": { hangs: true } }, false],
    ["the checkout", ORDINARY, true],
  ])("ends %s, posts no review, and tells conclude the review timed out", async (_name, canned, checkoutHangs) => {
    const s = setup(canned, { minuteMs: MINUTE_MS, checkoutHangs });
    const phases = await runJob(JOB, s.edges);

    expect(s.events).not.toContain("review:publish");
    expect(s.events.at(-1)).toBe("review:conclude");
    expect(phases.filter(({ outcome }) => outcome === "timed out")).toHaveLength(1);
    expect(s.env("review:conclude")).toMatchObject({
      REVIEW_RESULT: "cancelled",
      PROCEED: "true",
      TIMED_OUT: "true",
      TIMEOUT_MINUTES: String(LIMIT),
    });
    expect(s.env("review:conclude")).not.toHaveProperty("VERDICT");
    expect(s.env("review:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  it("reads the limit from the repository's own review time", async () => {
    const s = setup({ ...ORDINARY, review: { hangs: true } }, { minuteMs: MINUTE_MS });
    await runJob({ ...JOB, variables: { ...JOB.variables, AGENT_REVIEW_TIMEOUT_MINUTES: "2" } }, s.edges);

    expect(s.env("review:conclude")).toMatchObject({ TIMED_OUT: "true", TIMEOUT_MINUTES: String(CI_WAIT_SECONDS / 60 + 2) });
  });

  it("ends a publish that hangs, and still concludes, saying it was cancelled", async () => {
    const s = setup({ ...ORDINARY, "review:publish": { hangs: true } }, { minuteMs: MINUTE_MS });
    await runJob(JOB, s.edges);

    expect(s.events.at(-1)).toBe("review:conclude");
    expect(s.env("review:conclude")).toMatchObject({ REVIEW_RESULT: "success", TIMED_OUT: "false", PUBLISH_OUTCOME: "cancelled" });
  });

  it("ends a conclude that hangs, so the next job is not held behind it", async () => {
    const s = setup({ ...ORDINARY, "review:conclude": { hangs: true } }, { minuteMs: MINUTE_MS });
    const phases = await runJob(JOB, s.edges);

    expect(phases.at(-1)).toEqual({ name: "review:conclude", outcome: "timed out" });
  });

  it("hands every launch the signal its limit aborts, and none is aborted where nothing hangs", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.launched.filter(({ signal }) => signal.aborted).map(({ subcommand }) => subcommand)).toEqual([]);
  });
});

describe("the worker's job, where a phase fails", () => {
  it("tells conclude the runner failed, with the reason it wrote, and posts no review", async () => {
    const s = setup({ ...ORDINARY, review: { files: { "failure_reason.txt": "The agent's model refused the token.\n" }, exit: 1 } });
    const phases = await runJob(JOB, s.edges);

    expect(s.events).not.toContain("review:publish");
    expect(s.events.at(-1)).toBe("review:conclude");
    expect(s.env("review:conclude")).toMatchObject({
      REVIEW_RESULT: "failure",
      PROCEED: "true",
      FAILURE_REASON: "The agent's model refused the token.",
      TIMED_OUT: "false",
    });
    expect(s.env("review:conclude")).not.toHaveProperty("VERDICT");
    expect(s.env("review:conclude")).not.toHaveProperty("MINT_OUTCOME");
    expect(phases).toContainEqual({ name: "review", outcome: "failure (exit 1): The agent's model refused the token." });
  });

  it("tells conclude the review did not start where no token to read with was granted", async () => {
    const s = setup(ORDINARY, { refused: [1] });
    await runJob(JOB, s.edges);

    expect(s.events).toEqual(["read token", "write token", "review:conclude"]);
    expect(s.env("review:conclude")).toMatchObject({ REVIEW_RESULT: "failure", GH_TOKEN: "write-token-2" });
    expect(s.env("review:conclude")["FAILURE_REASON"]).toContain("granted no token");
    expect(s.env("review:conclude")).not.toHaveProperty("PROCEED");
  });

  it("tells conclude the review failed where the runner's own token was not granted, and starts no runner", async () => {
    const s = setup(ORDINARY, { refused: [2] });
    await runJob(JOB, s.edges);

    expect(s.events).not.toContain("review");
    expect(s.env("review:conclude")).toMatchObject({ REVIEW_RESULT: "failure", PROCEED: "true" });
    expect(s.env("review:conclude")["FAILURE_REASON"]).toContain("granted no token");
  });

  it("tells conclude the posting token's mint failed, and publishes nothing", async () => {
    const s = setup(ORDINARY, { refused: [3] });
    await runJob(JOB, s.edges);

    expect(s.events).not.toContain("review:publish");
    expect(s.env("review:conclude")).toMatchObject({
      REVIEW_RESULT: "success",
      VERDICT: "approve",
      MINT_OUTCOME: "failure",
      GH_TOKEN: "write-token-4",
    });
    expect(s.env("review:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  it("tells conclude publish failed", async () => {
    const s = setup({ ...ORDINARY, "review:publish": { files: { "failure_reason.txt": "GitHub answered 502." }, exit: 1 } });
    await runJob(JOB, s.edges);

    expect(s.env("review:conclude")).toMatchObject({ REVIEW_RESULT: "success", MINT_OUTCOME: "success", PUBLISH_OUTCOME: "failure" });
  });

  it("puts the reason in the worker's log where nothing can write the ending to the pull request", async () => {
    const s = setup({ ...ORDINARY, review: { files: { "failure_reason.txt": "The agent stopped." }, exit: 1 } }, { refused: [3] });
    const phases = await runJob(JOB, s.edges);

    expect(s.events).not.toContain("review:conclude");
    expect(phases.at(-2)).toEqual({ name: "write token", outcome: "failure: the dispatcher answered 403: the job is past its deadline" });
    expect(phases.at(-1)?.name).toBe("review:conclude");
    expect(phases.at(-1)?.outcome).toContain("not run");
    expect(phases.at(-1)?.outcome).toContain("The agent stopped.");
  });
});

describe("the worker's job, on a PRD pull request", () => {
  const PRD: ReviewJob = { ...JOB, branch: "agent/prd-453-the-service" };
  const reviewed = {
    ...ORDINARY,
    "review:conclude": { files: { "ended.json": { moved: false, reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1" } } },
  };

  it("advances the chain after conclude, where the head did not move, with a write token of its own", async () => {
    const s = setup(reviewed);
    await runJob(PRD, s.edges);

    expect(s.events.slice(-4)).toEqual(["review:publish", "review:conclude", "write token", "review:advance"]);
    expect(s.env("review:advance")).toMatchObject({
      GH_TOKEN: "write-token-4",
      LOOP_TOKEN: "write-token-4",
      LOOP_TOKEN_SOURCE: "app",
      PR_NUMBER: "7",
      BRANCH: "agent/prd-453-the-service",
      REVIEW_RESULT: "success",
      POSTING_RESULT: "success",
      MOVED: "false",
      REVIEW_URL: "https://github.com/owner/repo/pull/7#pullrequestreview-1",
      VERDICT: "approve",
      FIX_ROUND: "false",
      MINT_OUTCOME: "success",
      PARK_DIR: s.env("review")["OUTPUT_DIR"],
    });
    const inputs = declared("review:advance");
    const allowed = new Set([...Object.keys(inputs), "PATH", "HOME", "LANG"]);
    expect(Object.keys(s.env("review:advance")).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("does not advance where the head moved while the review ran", async () => {
    const s = setup({ ...ORDINARY, "review:conclude": { files: { "ended.json": { moved: true } } } });
    await runJob(PRD, s.edges);

    expect(s.events.at(-1)).toBe("review:conclude");
    expect(s.events).not.toContain("review:advance");
  });

  it("does not advance where the gate refused", async () => {
    const s = setup({ ...reviewed, "review:gate": { files: { "gate.json": { proceed: "false", refusal: "The PR changed.", blocked: "false" } } } });
    await runJob(PRD, s.edges);

    expect(s.events).not.toContain("review:advance");
  });

  it("does not advance an ordinary pull request", async () => {
    const s = setup(reviewed);
    await runJob(JOB, s.edges);

    expect(s.events).not.toContain("review:advance");
  });

  it("tells advance how the review and the posting ended where the runner failed and publish never ran", async () => {
    const s = setup({ ...reviewed, review: { files: { "park.json": { round: "slice" } }, exit: 1 } });
    await runJob(PRD, s.edges);

    expect(s.env("review:advance")).toMatchObject({ REVIEW_RESULT: "failure", POSTING_RESULT: "success", PARK_DIR: s.env("review")["OUTPUT_DIR"] });
    expect(s.env("review:advance")).not.toHaveProperty("VERDICT");
  });

  it("tells advance the posting failed where publish did", async () => {
    const s = setup({ ...reviewed, "review:publish": { exit: 1 } });
    await runJob(PRD, s.edges);

    expect(s.env("review:advance")).toMatchObject({ REVIEW_RESULT: "success", POSTING_RESULT: "failure" });
  });

  it("tells advance a review that timed out was cancelled", async () => {
    const s = setup({ ...reviewed, review: { hangs: true } }, { minuteMs: 5 });
    await runJob(PRD, s.edges);

    expect(s.env("review:advance")).toMatchObject({ REVIEW_RESULT: "cancelled", POSTING_RESULT: "success" });
  });

  it("logs that the chain was not advanced where no token to advance it with was granted", async () => {
    const s = setup(reviewed, { refused: [4] });
    const phases = await runJob(PRD, s.edges);

    expect(s.events).not.toContain("review:advance");
    expect(phases.at(-1)?.name).toBe("review:advance");
    expect(phases.at(-1)?.outcome).toContain("not run");
  });
});

describe("the repository's setup, as a phase primitive", () => {
  /** A run of `JOB` begun, its tokens asked for as a job's phases would, and its setup run with `script` under a limit of `minutes`. */
  const ranSetup = async (edges: JobEdges, script: string, minutes = 60) => {
    const run = startRun(JOB, edges);
    await run.ask("read");
    await run.ask("push");
    const limit = run.limit(minutes);
    const ran = await run.setup(script, limit.signal);
    limit.clear();
    return { ran, phases: run.done() };
  };

  it("runs the script in the sandbox, in the checkout, with the sandbox's settings and no token anywhere in what it is handed", async () => {
    const s = setup();
    const { ran } = await ranSetup(s.edges, "npm ci");

    expect(ran).toEqual({ ok: true, timedOut: false });
    expect(s.launched).toEqual([]);
    expect(s.sandboxed).toEqual([
      {
        script: "npm ci",
        dir: path.join(s.runDir, "checkout"),
        roBinds: ["/opt/node", "/work/claude-code"],
        path: "/work/claude-code/bin:/usr/bin",
        proxy: "http://proxy:3128",
        log: path.join(s.runDir, "logs", "setup.log"),
        signal: expect.any(AbortSignal),
      },
    ]);
    const handed = JSON.stringify(s.sandboxed);
    for (const token of ["read-token-1", "push-token-2", AGENT.CLAUDE_CODE_OAUTH_TOKEN]) expect(handed).not.toContain(token);
  });

  it("hands the sandbox no proxy where the worker's settings give it none", async () => {
    const s = setup();
    await ranSetup({ ...s.edges, agent: { ...AGENT, AGENT_SANDBOX_PROXY: "" } }, "npm ci");

    expect(s.sandboxed[0]).not.toHaveProperty("proxy");
  });

  it("is skipped where AGENT_SETUP is unset, and noted as skipped", async () => {
    const s = setup();
    const { ran, phases } = await ranSetup(s.edges, "");

    expect(ran).toEqual({ ok: true, timedOut: false });
    expect(s.sandboxed).toEqual([]);
    expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: "skipped: AGENT_SETUP is unset" });
  });

  it("fails on a non-zero exit, with a sentence naming the exit status and quoting the end of its output", async () => {
    const output = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join("\n");
    const s = setup(ORDINARY, { setupRun: { exit: 3, output: `${output}\n` } });
    const { ran, phases } = await ranSetup(s.edges, "npm ci");

    expect(ran.ok).toBe(false);
    expect(ran.timedOut).toBe(false);
    expect(ran.failureReason).toMatch(/^The repository's setup \(`AGENT_SETUP`\) exited with status 3\. The end of its output:/);
    expect(ran.failureReason).toContain("line 11\nline 12");
    expect(ran.failureReason).toContain("line 30");
    expect(ran.failureReason).not.toContain("line 10\n");
    expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: "failure (exit 3)" });
  });

  it("says so where the failed setup wrote nothing", async () => {
    const s = setup(ORDINARY, { setupRun: { exit: 1 } });
    const { ran } = await ranSetup(s.edges, "false");

    expect(ran.failureReason).toBe("The repository's setup (`AGENT_SETUP`) exited with status 1. It wrote no output.");
  });

  it("fails, with the reason, where the sandbox could not be started", async () => {
    const s = setup(ORDINARY, { setupRun: { throws: "spawn bwrap ENOENT" } });
    const { ran, phases } = await ranSetup(s.edges, "npm ci");

    expect(ran).toEqual({
      ok: false,
      timedOut: false,
      failureReason: "The repository's setup (`AGENT_SETUP`) could not be started in the sandbox: spawn bwrap ENOENT",
    });
    expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: `failure: ${ran.failureReason}` });
  });

  it("is ended with its sandbox at the job's time limit, and noted as timed out", async () => {
    const s = setup(ORDINARY, { minuteMs: 20, setupRun: { hangs: true } });
    const { ran, phases } = await ranSetup(s.edges, "sleep 3600", 1);

    expect(ran).toEqual({ ok: false, timedOut: true });
    expect(s.sandboxed[0]?.signal.aborted).toBe(true);
    expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: "timed out" });
  });

  it("is in the run's summary, with the script and nothing else as its environment", async () => {
    const s = setup();
    await ranSetup(s.edges, "npm ci");

    const summary = JSON.parse(fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8")) as { subcommands: unknown[] };
    expect(summary.subcommands).toEqual([
      {
        subcommand: SETUP_PHASE,
        env: { AGENT_SETUP: "npm ci" },
        cwd: path.join(s.runDir, "checkout"),
        log: path.join(s.runDir, "logs", "setup.log"),
      },
    ]);
  });

  it("is not run by a review, whatever AGENT_SETUP says, as review.yml runs no setup", async () => {
    const s = setup();
    await runJob({ ...JOB, variables: { ...JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.sandboxed).toEqual([]);
    expect(s.events).not.toContain("sandbox");
  });
});

const FIX_JOB: FixJob = { ...JOB, workflow: "fix" };
const RESCUE = "agent/rescue/fix-7";

/** The files each fix subcommand writes on a round that goes ahead and pushes. */
const FIX_ORDINARY: Readonly<Partial<Record<Subcommand, Canned>>> = {
  "fix:gate": { files: { "gate.json": { proceed: "true" } } },
  fix: { files: { "thread_outcomes.json": [] } },
  "fix:bundle": { files: { "branch.bundle": "the agent's commits" } },
  "fix:publish": { files: { "published.json": { pushed: true, head: "b".repeat(40), notesPosted: false, nothingToDo: false, rescueNoted: false } } },
};

/** Every value in `env` that is one of the fake dispatcher's tokens. */
const tokensIn = (env: Readonly<Record<string, string>>): readonly string[] =>
  Object.values(env).filter((value) => /^(read|write|push)-token-/.test(value));

/**
 * A fix job, run as `fix.yml` runs one (spec §9): the gate, the agent's job,
 * the publish job, and conclude, each command told what the reusable tells it.
 */
describe("the worker's fix job, on a round that goes ahead", () => {
  it("runs the gate, the checkout, prepare, the setup, the runner, bundle, publish and conclude, in that order", async () => {
    const s = setup(FIX_ORDINARY);
    await runJob({ ...FIX_JOB, variables: { ...FIX_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).toEqual([
      "write token",
      "fix:gate",
      "read token",
      "checkout",
      "fix:prepare",
      "sandbox",
      "read token",
      "fix",
      "fix:bundle",
      "push token",
      "fix:publish",
      "fix:conclude",
    ]);
  });

  it("hands each command its token kind: write to the gate, read to prepare and the runner, none to bundle, push to publish and conclude", async () => {
    const s = setup(FIX_ORDINARY);
    await runJob(FIX_JOB, s.edges);

    expect(s.asked).toEqual(["write", "read", "read", "push"]);
    expect(tokensIn(s.env("fix:gate"))).toEqual(["write-token-1"]);
    expect(tokensIn(s.env("fix:prepare"))).toEqual(["read-token-2"]);
    expect(tokensIn(s.env("fix"))).toEqual(["read-token-3"]);
    expect(tokensIn(s.env("fix:bundle"))).toEqual([]);
    for (const subcommand of ["fix:publish", "fix:conclude"] as const) {
      expect(s.env(subcommand), subcommand).toMatchObject({ GH_TOKEN: "push-token-4", LOOP_TOKEN: "push-token-4", LOOP_TOKEN_SOURCE: "app" });
    }
  });

  it("puts only the read token in the runner's environment, beside the agent's own", async () => {
    const s = setup(FIX_ORDINARY);
    await runJob(FIX_JOB, s.edges);

    const runner = s.env("fix");
    expect(Object.entries(runner).filter(([name]) => name.endsWith("TOKEN")).sort()).toEqual([
      ["CLAUDE_CODE_OAUTH_TOKEN", AGENT.CLAUDE_CODE_OAUTH_TOKEN],
      ["GH_TOKEN", "read-token-3"],
    ]);
    expect(Object.values(runner).filter((value) => /write-token|push-token/.test(value))).toEqual([]);
    expect(runner).not.toHaveProperty("LOOP_TOKEN");
  });

  it("checks out the head the label's event named, as the branch, with the base, committing as the App", async () => {
    const s = setup(FIX_ORDINARY);
    await runJob(FIX_JOB, s.edges);

    const checkout = path.join(s.runDir, "checkout");
    expect(s.checkouts).toEqual([
      { dir: checkout, repo: "owner/repo", branch: "agent/issue-7-a-thing", sha: HEAD, baseRef: "main", token: "read-token-2", committer: "loop-app[bot]" },
    ]);
    expect(s.launched.find((launch) => launch.subcommand === "fix")?.cwd).toBe(checkout);
    for (const subcommand of ["fix:prepare", "fix:bundle", "fix:publish", "fix:conclude"] as const) {
      expect(s.env(subcommand)["CHECKOUT"], subcommand).toBe(checkout);
    }
  });

  it("hands each subcommand the inputs fix.yml hands it", async () => {
    const s = setup(FIX_ORDINARY);
    await runJob({ ...FIX_JOB, variables: { ...FIX_JOB.variables, AGENT_MODEL_FIX: "a-fix-model" } }, s.edges);

    expect(s.env("fix:gate")).toMatchObject({ GH_REPO: "owner/repo", PR_NUMBER: "7", BRANCH: "agent/issue-7-a-thing", HEAD_SHA: HEAD, PR_STATE: "open", PR_MERGED: "false" });
    expect(s.env("fix:prepare")).toMatchObject({ GH_REPO: "owner/repo", RESCUE_BRANCH: RESCUE });
    expect(s.env("fix")).toMatchObject({
      ...AGENT,
      PR_NUMBER: "7",
      BRANCH: "agent/issue-7-a-thing",
      BASE_REF: "main",
      RESCUE_BRANCH: RESCUE,
      AGENT_MODEL: "a-model",
      AGENT_MODEL_FIX: "a-fix-model",
      AGENT_LOOP_LOGINS: "loop-app[bot]",
    });
    expect(s.env("fix:bundle")).toMatchObject({ BRANCH: "agent/issue-7-a-thing", HEAD_SHA: HEAD });
    expect(s.env("fix:publish")).toMatchObject({ PR_NUMBER: "7", BRANCH: "agent/issue-7-a-thing", HEAD_SHA: HEAD, RESCUE_BRANCH: RESCUE, AGENT_RESULT: "success" });
    // No Actions run to link to.
    for (const name of ["GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"]) expect(s.env("fix:conclude")).not.toHaveProperty(name);
  });

  it("points each command that reads another's files at that one's directory", async () => {
    const s = setup(FIX_ORDINARY);
    await runJob(FIX_JOB, s.edges);

    const out = (subcommand: Subcommand): string | undefined => s.env(subcommand)["OUTPUT_DIR"];
    expect(s.env("fix:publish")).toMatchObject({ FIX_DIR: out("fix"), BUNDLE_DIR: out("fix:bundle") });
    expect(s.env("fix:conclude")).toMatchObject({
      PUBLISH_DIR: out("fix:publish"),
      PREPARE_DIR: out("fix:prepare"),
      FIX_DIR: out("fix"),
      BUNDLE_DIR: out("fix:bundle"),
    });
    const dirs = s.launched.map(({ env }) => env["OUTPUT_DIR"]);
    expect(new Set(dirs).size).toBe(s.launched.length);
  });

  it("tells conclude how each job and step ended", async () => {
    const s = setup(FIX_ORDINARY);
    await runJob(FIX_JOB, s.edges);

    expect(s.env("fix:conclude")).toMatchObject({
      REFUSED: "false",
      GATE_RESULT: "success",
      AGENT_RESULT: "success",
      TIMED_OUT: "false",
      TIMEOUT_MINUTES: String(DEFAULT_FIX_MINUTES),
      MINT_OUTCOME: "success",
      DOWNLOAD_OUTCOME: "success",
      PUBLISH_OUTCOME: "success",
    });
    expect(s.env("fix:conclude")).not.toHaveProperty("GATE_REASON");
  });
});

describe("the worker's fix job, where the gate does not claim the round", () => {
  it("runs nothing after the gate refused and mints no other token, since it said so and took the label off, and notes the refusal", async () => {
    const s = setup({ ...FIX_ORDINARY, "fix:gate": { files: { "gate.json": { proceed: "false" } } } });
    const phases = await runJob(FIX_JOB, s.edges);

    expect(s.events).toEqual(["write token", "fix:gate"]);
    expect(s.asked).toEqual(["write"]);
    expect(s.checkouts).toEqual([]);
    expect(s.launched.map(({ subcommand }) => subcommand)).toEqual(["fix:gate"]);
    expect(phases.at(-1)).toEqual({ name: "fix:gate", outcome: "refused: the run ends here, as the publish job does not run after a refusal" });
    expect(fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8")).toContain("refused: the run ends here");
  });

  it("concludes, with no agent's job, where the gate decided nothing", async () => {
    const s = setup({ ...FIX_ORDINARY, "fix:gate": { exit: 1 } });
    await runJob(FIX_JOB, s.edges);

    expect(s.events).toEqual(["write token", "fix:gate", "push token", "fix:conclude"]);
    expect(s.env("fix:conclude")).toMatchObject({ GATE_RESULT: "failure", AGENT_RESULT: "skipped", MINT_OUTCOME: "success" });
    for (const name of ["REFUSED", "DOWNLOAD_OUTCOME", "PUBLISH_OUTCOME"]) expect(s.env("fix:conclude")).not.toHaveProperty(name);
  });

  it("hands conclude the gate's reason where it failed after claiming the round", async () => {
    const s = setup({ ...FIX_ORDINARY, "fix:gate": { exit: 1, files: { "gate.json": { proceed: "true" }, "failure_reason.txt": "Couldn't add `agent:fix`." } } });
    await runJob(FIX_JOB, s.edges);

    expect(s.events).not.toContain("fix");
    expect(s.env("fix:conclude")).toMatchObject({
      REFUSED: "false",
      GATE_RESULT: "failure",
      GATE_REASON: "Couldn't add `agent:fix`.",
      AGENT_RESULT: "skipped",
    });
  });

  it("logs the reason where no token to claim the round with was granted, and concludes undecided", async () => {
    const s = setup(FIX_ORDINARY, { refused: [1] });
    const phases = await runJob(FIX_JOB, s.edges);

    expect(phases).toContainEqual({ name: "fix:gate", outcome: "not run: the dispatcher granted no token to claim the pull request with" });
    expect(s.events).toEqual(["write token", "push token", "fix:conclude"]);
    expect(s.env("fix:conclude")).toMatchObject({ GATE_RESULT: "failure", AGENT_RESULT: "skipped" });
  });
});

describe("the worker's fix job, where its agent's job fails", () => {
  it("still bundles, and tells publish and conclude, where the runner failed", async () => {
    const s = setup({ ...FIX_ORDINARY, fix: { exit: 1, files: { "failure_reason.txt": "The agent gave up." } } });
    await runJob(FIX_JOB, s.edges);

    expect(s.events.slice(-4)).toEqual(["fix:bundle", "push token", "fix:publish", "fix:conclude"]);
    expect(s.env("fix:publish")["AGENT_RESULT"]).toBe("failure");
    expect(s.env("fix:conclude")).toMatchObject({ AGENT_RESULT: "failure", TIMED_OUT: "false" });
  });

  it("starts no runner where the setup failed, and gives conclude the setup's reason as the runner's", async () => {
    const s = setup(FIX_ORDINARY, { setupRun: { exit: 2, output: "npm ERR! missing script\n" } });
    await runJob({ ...FIX_JOB, variables: { ...FIX_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).not.toContain("fix");
    expect(s.events).toContain("fix:bundle");
    const fixDir = s.env("fix:conclude")["FIX_DIR"]!;
    expect(fs.readFileSync(path.join(fixDir, "failure_reason.txt"), "utf8")).toMatch(/^The repository's setup \(`AGENT_SETUP`\) exited with status 2\./);
    expect(s.env("fix:conclude")).toMatchObject({ AGENT_RESULT: "failure" });
  });

  it("starts no runner where prepare failed, and leaves its reason where conclude reads it", async () => {
    const reason = "Couldn't check whether an earlier run left commits on `agent/rescue/fix-7`, so this run stopped rather than start over without them.";
    const s = setup({ ...FIX_ORDINARY, "fix:prepare": { exit: 1, files: { "failure_reason.txt": reason } } });
    await runJob(FIX_JOB, s.edges);

    expect(s.events).not.toContain("fix");
    expect(fs.readFileSync(path.join(s.env("fix:conclude")["PREPARE_DIR"]!, "failure_reason.txt"), "utf8")).toBe(reason);
  });

  it("writes prepare's reason where the head could not be checked out", async () => {
    const s = setup(FIX_ORDINARY);
    s.edges.git.checkout = async () => {
      throw new Error("fatal: couldn't find remote ref");
    };
    await runJob(FIX_JOB, s.edges);

    expect(s.events).not.toContain("fix:prepare");
    expect(fs.readFileSync(path.join(s.env("fix:conclude")["PREPARE_DIR"]!, "failure_reason.txt"), "utf8")).toBe(
      "The pull request's head could not be checked out: fatal: couldn't find remote ref",
    );
  });

  it("tells conclude the mint failed, publishes nothing, and asks for a write token for conclude's comment and labels", async () => {
    const s = setup(FIX_ORDINARY, { refused: [4] });
    await runJob(FIX_JOB, s.edges);

    expect(s.events).not.toContain("fix:publish");
    expect(s.asked).toEqual(["write", "read", "read", "push", "write"]);
    expect(s.env("fix:conclude")).toMatchObject({ MINT_OUTCOME: "failure", GH_TOKEN: "write-token-5", LOOP_TOKEN: "write-token-5" });
    expect(s.env("fix:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  it("logs why the round ended where nothing can write its ending", async () => {
    const s = setup({ ...FIX_ORDINARY, fix: { exit: 1 } }, { refused: [4, 5] });
    const phases = await runJob(FIX_JOB, s.edges);

    expect(s.events).not.toContain("fix:conclude");
    expect(phases.at(-1)).toEqual({
      name: "fix:conclude",
      outcome:
        "not run: the dispatcher granted no token to write the ending with, and the run had ended so: the gate's result was success, and the agent's failure",
    });
  });
});

/**
 * The agent's job's time limit is `AGENT_TIMEOUT_MINUTES`, as `fix.yml`'s is,
 * and a round stopped at it still bundles, publishes and concludes, so its
 * commits are rescued. A minute is shortened here so a limit is reached at once.
 */
describe("the worker's fix job, where its agent's job runs past its time limit", () => {
  const MINUTE_MS = 5;

  it.each<[string, Readonly<Partial<Record<Subcommand, Canned>>>, { readonly checkoutHangs?: boolean; readonly setupRun?: { readonly hangs: true } }]>([
    ["the runner", { ...FIX_ORDINARY, fix: { hangs: true } }, {}],
    ["prepare", { ...FIX_ORDINARY, "fix:prepare": { hangs: true } }, {}],
    ["the setup", FIX_ORDINARY, { setupRun: { hangs: true } }],
    ["the checkout", FIX_ORDINARY, { checkoutHangs: true }],
  ])("ends %s, still bundles, publishes and concludes, and tells conclude it timed out", async (_name, canned, options) => {
    const s = setup(canned, { minuteMs: MINUTE_MS, ...options });
    const phases = await runJob({ ...FIX_JOB, variables: { ...FIX_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(phases.filter(({ outcome }) => outcome === "timed out")).toHaveLength(1);
    expect(s.events.slice(-4)).toEqual(["fix:bundle", "push token", "fix:publish", "fix:conclude"]);
    expect(s.env("fix:publish")["AGENT_RESULT"]).toBe("cancelled");
    expect(s.env("fix:conclude")).toMatchObject({
      AGENT_RESULT: "cancelled",
      TIMED_OUT: "true",
      TIMEOUT_MINUTES: String(DEFAULT_FIX_MINUTES),
    });
  });

  it("reads the limit from the repository's AGENT_TIMEOUT_MINUTES", async () => {
    const s = setup({ ...FIX_ORDINARY, fix: { hangs: true } }, { minuteMs: MINUTE_MS });
    await runJob({ ...FIX_JOB, variables: { ...FIX_JOB.variables, AGENT_TIMEOUT_MINUTES: "2" } }, s.edges);

    expect(s.env("fix:conclude")).toMatchObject({ TIMED_OUT: "true", TIMEOUT_MINUTES: "2" });
  });

  it("bundles under a limit of its own, which the agent's having run out does not abort", async () => {
    const s = setup({ ...FIX_ORDINARY, fix: { hangs: true } }, { minuteMs: MINUTE_MS });
    await runJob(FIX_JOB, s.edges);

    const signals = Object.fromEntries(s.launched.map(({ subcommand, signal }) => [subcommand, signal.aborted]));
    expect(signals).toMatchObject({ fix: true, "fix:bundle": false, "fix:publish": false, "fix:conclude": false });
  });
});

/**
 * Rescue (#303) runs unchanged on the worker's checkout: a stopped round's
 * bundle reaches `fix:conclude`, which pushes it to the rescue branch with the
 * `push` token, and the next round's `fix:prepare` fetches that branch into
 * its own checkout before the runner starts.
 */
describe("the worker's fix job, rescuing a stopped round", () => {
  it("hands conclude the stopped round's bundle, the rescue branch and a token that pushes, and the next round's prepare the same branch", async () => {
    const stopped = setup({ ...FIX_ORDINARY, fix: { hangs: true } }, { minuteMs: 5 });
    await runJob(FIX_JOB, stopped.edges);

    const concluded = stopped.env("fix:conclude");
    expect(fs.existsSync(path.join(concluded["BUNDLE_DIR"]!, "branch.bundle"))).toBe(true);
    expect(concluded).toMatchObject({ RESCUE_BRANCH: RESCUE, LOOP_TOKEN: "push-token-4", MINT_OUTCOME: "success", AGENT_RESULT: "cancelled" });

    const next = setup(FIX_ORDINARY);
    await runJob({ ...FIX_JOB, id: "job-2" }, next.edges);

    expect(next.env("fix:prepare")).toMatchObject({ RESCUE_BRANCH: RESCUE, CHECKOUT: path.join(next.runDir, "checkout") });
    expect(next.events.indexOf("fix:prepare")).toBeLessThan(next.events.indexOf("fix"));
    expect(next.env("fix")["RESCUE_BRANCH"]).toBe(RESCUE);
  });
});

const UPDATE_BRANCH_JOB: UpdateBranchJob = { ...JOB, workflow: "update-branch" };
const BASE = "c".repeat(40);

/** The files each update-branch subcommand writes where the merge goes cleanly. */
const UB_CLEAN: Readonly<Partial<Record<Subcommand, Canned>>> = {
  "update-branch:gate": { files: { "gate.json": { proceed: "true" } } },
  "update-branch:merge": { files: { "merge.json": { status: "clean", base: BASE, conflicts: [] } } },
  "update-branch:publish": { files: { "published.json": { pushed: true, head: "d".repeat(40), requested: false } } },
};

/** The same, where the merge conflicts and the agent resolves it. */
const UB_CONFLICTS: Readonly<Partial<Record<Subcommand, Canned>>> = {
  ...UB_CLEAN,
  "update-branch:merge": { files: { "merge.json": { status: "conflicts", base: BASE, conflicts: ["a.ts", "b.ts"] } } },
  "update-branch": { files: { "update_comment.md": "Kept both." } },
  "update-branch:bundle": { files: { "branch.bundle": "the resolution" } },
  "update-branch:publish": { files: { "published.json": { pushed: true, head: "d".repeat(40), requested: true } } },
};

/**
 * An update-branch job, run as `update-branch.yml` runs one (spec §10): the
 * gate job's gate, checkout and merge; the agent's job only on a conflict;
 * and the publish job's publish and conclude, each in a checkout of its own,
 * as each job on Actions checks the head out again.
 */
describe("the worker's update-branch job, on a clean merge", () => {
  it("runs the gate, its checkout, the merge, then publish in a checkout of its own and conclude: no setup and no runner", async () => {
    const s = setup(UB_CLEAN);
    await runJob({ ...UPDATE_BRANCH_JOB, variables: { ...UPDATE_BRANCH_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).toEqual([
      "write token",
      "update-branch:gate",
      "checkout",
      "update-branch:merge",
      "push token",
      "checkout",
      "update-branch:publish",
      "update-branch:conclude",
    ]);
    expect(s.sandboxed).toEqual([]);
  });

  it("merges with the gate's write token, outside the sandbox, and holds push only for publish and conclude", async () => {
    const s = setup(UB_CLEAN);
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.asked).toEqual(["write", "push"]);
    expect(tokensIn(s.env("update-branch:gate"))).toEqual(["write-token-1"]);
    expect(tokensIn(s.env("update-branch:merge"))).toEqual(["write-token-1"]);
    for (const subcommand of ["update-branch:publish", "update-branch:conclude"] as const) {
      expect(s.env(subcommand), subcommand).toMatchObject({ GH_TOKEN: "push-token-2", LOOP_TOKEN: "push-token-2", LOOP_TOKEN_SOURCE: "app" });
    }
    expect(s.checkouts.map(({ token }) => token)).toEqual(["write-token-1", "push-token-2"]);
  });

  it("checks the head the label's event named out twice, once for the merge and once for publish, each a directory of its own", async () => {
    const s = setup(UB_CLEAN);
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    const merging = s.env("update-branch:merge")["CHECKOUT"];
    const publishing = s.env("update-branch:publish")["CHECKOUT"];
    expect(s.checkouts).toEqual([
      { dir: merging, repo: "owner/repo", branch: "agent/issue-7-a-thing", sha: HEAD, baseRef: "main", token: "write-token-1", committer: "loop-app[bot]" },
      { dir: publishing, repo: "owner/repo", branch: "agent/issue-7-a-thing", sha: HEAD, baseRef: "main", token: "push-token-2", committer: "loop-app[bot]" },
    ]);
    expect(merging).not.toBe(publishing);
    for (const dir of [merging, publishing]) expect(dir?.startsWith(s.runDir)).toBe(true);
  });

  it("hands each subcommand the inputs update-branch.yml hands it", async () => {
    const s = setup(UB_CLEAN);
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.env("update-branch:gate")).toMatchObject({ GH_REPO: "owner/repo", PR_NUMBER: "7", BRANCH: "agent/issue-7-a-thing", PR_STATE: "open", PR_MERGED: "false" });
    expect(s.env("update-branch:merge")).toMatchObject({ GH_REPO: "owner/repo", BRANCH: "agent/issue-7-a-thing", BASE_REF: "main" });
    expect(s.env("update-branch:publish")).toMatchObject({
      PR_NUMBER: "7",
      BRANCH: "agent/issue-7-a-thing",
      BASE_REF: "main",
      HEAD_SHA: HEAD,
      STATUS: "clean",
      BASE_SHA: BASE,
      AGENT_RESULT: "skipped",
      AGENT_LOOP_LOGINS: "loop-app[bot]",
    });
    expect(s.env("update-branch:conclude")).toMatchObject({
      PR_NUMBER: "7",
      HEAD_SHA: HEAD,
      REFUSED: "false",
      GATE_RESULT: "success",
      STATUS: "clean",
      AGENT_RESULT: "skipped",
      TIMED_OUT: "false",
      TIMEOUT_MINUTES: String(DEFAULT_FIX_MINUTES),
      MINT_OUTCOME: "success",
      PUBLISH_OUTCOME: "success",
      PUBLISH_DIR: s.env("update-branch:publish")["OUTPUT_DIR"],
    });
    for (const name of ["GATE_REASON", "DOWNLOAD_OUTCOME"]) expect(s.env("update-branch:conclude")).not.toHaveProperty(name);
  });
});

describe("the worker's update-branch job, on a conflicted merge", () => {
  it("runs prepare, the setup, the runner and bundle between the merge and publish", async () => {
    const s = setup(UB_CONFLICTS);
    await runJob({ ...UPDATE_BRANCH_JOB, variables: { ...UPDATE_BRANCH_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).toEqual([
      "write token",
      "update-branch:gate",
      "checkout",
      "update-branch:merge",
      "read token",
      "checkout",
      "update-branch:prepare",
      "sandbox",
      "read token",
      "update-branch",
      "update-branch:bundle",
      "push token",
      "checkout",
      "update-branch:publish",
      "update-branch:conclude",
    ]);
  });

  it("hands the runner a read token alone, prepare a read token, bundle none, and push only to publish and conclude", async () => {
    const s = setup(UB_CONFLICTS);
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.asked).toEqual(["write", "read", "read", "push"]);
    expect(tokensIn(s.env("update-branch:prepare"))).toEqual(["read-token-2"]);
    expect(tokensIn(s.env("update-branch:bundle"))).toEqual([]);
    const runner = s.env("update-branch");
    expect(Object.entries(runner).filter(([name]) => name.endsWith("TOKEN")).sort()).toEqual([
      ["CLAUDE_CODE_OAUTH_TOKEN", AGENT.CLAUDE_CODE_OAUTH_TOKEN],
      ["GH_TOKEN", "read-token-3"],
    ]);
    expect(runner).not.toHaveProperty("LOOP_TOKEN");
    // No phase but publish and conclude holds the push token: not a command, and not a checkout.
    for (const { subcommand, env } of s.launched) {
      const holds = Object.values(env).some((value) => value.startsWith("push-token-"));
      expect(holds, subcommand).toBe(subcommand === "update-branch:publish" || subcommand === "update-branch:conclude");
    }
    expect(s.checkouts.map(({ token }) => token)).toEqual(["write-token-1", "read-token-2", "push-token-4"]);
  });

  it("runs the agent's job in a checkout of its own, repeating the merge the gate found, and hands it on", async () => {
    const s = setup(UB_CONFLICTS);
    await runJob({ ...UPDATE_BRANCH_JOB, variables: { ...UPDATE_BRANCH_JOB.variables, AGENT_MODEL_UPDATE_BRANCH: "a-merge-model" } }, s.edges);

    const checkout = path.join(s.runDir, "checkout");
    expect(s.checkouts[1]).toMatchObject({ dir: checkout, sha: HEAD, branch: "agent/issue-7-a-thing", baseRef: "main" });
    expect(s.env("update-branch:merge")["CHECKOUT"]).not.toBe(checkout);
    expect(s.env("update-branch:prepare")).toMatchObject({ CHECKOUT: checkout, BRANCH: "agent/issue-7-a-thing", BASE_REF: "main", BASE_SHA: BASE });
    expect(s.launched.find((launch) => launch.subcommand === "update-branch")?.cwd).toBe(checkout);
    expect(s.env("update-branch")).toMatchObject({
      ...AGENT,
      PR_NUMBER: "7",
      BRANCH: "agent/issue-7-a-thing",
      BASE_REF: "main",
      AGENT_MODEL: "a-model",
      AGENT_MODEL_UPDATE_BRANCH: "a-merge-model",
    });
    expect(s.env("update-branch:bundle")).toMatchObject({ CHECKOUT: checkout, BRANCH: "agent/issue-7-a-thing", HEAD_SHA: HEAD, BASE_SHA: BASE });
  });

  it("points publish and conclude at the agent's job's directories, and tells them how it ended", async () => {
    const s = setup(UB_CONFLICTS);
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    const out = (subcommand: Subcommand): string | undefined => s.env(subcommand)["OUTPUT_DIR"];
    expect(s.env("update-branch:publish")).toMatchObject({
      STATUS: "conflicts",
      AGENT_RESULT: "success",
      UPDATE_BRANCH_DIR: out("update-branch"),
      BUNDLE_DIR: out("update-branch:bundle"),
    });
    expect(s.env("update-branch:conclude")).toMatchObject({
      STATUS: "conflicts",
      AGENT_RESULT: "success",
      TIMED_OUT: "false",
      DOWNLOAD_OUTCOME: "success",
      PUBLISH_OUTCOME: "success",
      PUBLISH_DIR: out("update-branch:publish"),
      PREPARE_DIR: out("update-branch:prepare"),
      UPDATE_BRANCH_DIR: out("update-branch"),
      BUNDLE_DIR: out("update-branch:bundle"),
    });
    const dirs = s.launched.map(({ env }) => env["OUTPUT_DIR"]);
    expect(new Set(dirs).size).toBe(s.launched.length);
  });
});

describe("the worker's update-branch job, where it stops", () => {
  it("runs nothing after the gate refused and mints no other token, as the publish job is skipped, and notes the refusal", async () => {
    const s = setup({ ...UB_CLEAN, "update-branch:gate": { files: { "gate.json": { proceed: "false" } } } });
    const phases = await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.events).toEqual(["write token", "update-branch:gate"]);
    expect(s.asked).toEqual(["write"]);
    expect(s.checkouts).toEqual([]);
    expect(s.launched.map(({ subcommand }) => subcommand)).toEqual(["update-branch:gate"]);
    expect(phases.at(-1)).toEqual({ name: "update-branch:gate", outcome: "refused: the run ends here, as the publish job does not run after a refusal" });
    expect(fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8")).toContain("refused: the run ends here");
  });

  it("concludes undecided where the gate decided nothing", async () => {
    const s = setup({ ...UB_CLEAN, "update-branch:gate": { exit: 1 } });
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.events).toEqual(["write token", "update-branch:gate", "push token", "update-branch:conclude"]);
    expect(s.env("update-branch:conclude")).toMatchObject({ GATE_RESULT: "failure", AGENT_RESULT: "skipped", MINT_OUTCOME: "success" });
    for (const name of ["REFUSED", "STATUS", "PUBLISH_OUTCOME"]) expect(s.env("update-branch:conclude")).not.toHaveProperty(name);
  });

  it("hands conclude the merge's reason as the gate's where the merge failed, and publishes nothing", async () => {
    const reason = "Couldn't fetch `main` to merge it, so the branch was left untouched: not found.";
    const s = setup({ ...UB_CLEAN, "update-branch:merge": { exit: 1, files: { "failure_reason.txt": reason } } });
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.events).not.toContain("update-branch:publish");
    expect(s.env("update-branch:conclude")).toMatchObject({ REFUSED: "false", GATE_RESULT: "failure", GATE_REASON: reason, AGENT_RESULT: "skipped" });
  });

  it("merges nothing where the head could not be checked out, and says why as the gate's reason", async () => {
    const s = setup(UB_CLEAN);
    s.edges.git.checkout = async () => {
      throw new Error("fatal: couldn't find remote ref");
    };
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.events).not.toContain("update-branch:merge");
    expect(s.env("update-branch:conclude")).toMatchObject({
      GATE_RESULT: "failure",
      GATE_REASON: "The pull request's head could not be checked out: fatal: couldn't find remote ref",
    });
  });

  it("starts no runner where the setup failed, and gives conclude the setup's reason as the runner's", async () => {
    const s = setup(UB_CONFLICTS, { setupRun: { exit: 2, output: "npm ERR! missing script\n" } });
    await runJob({ ...UPDATE_BRANCH_JOB, variables: { ...UPDATE_BRANCH_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).not.toContain("update-branch");
    expect(s.events).not.toContain("update-branch:bundle");
    expect(s.events).not.toContain("update-branch:publish");
    const ran = s.env("update-branch:conclude")["UPDATE_BRANCH_DIR"]!;
    expect(fs.readFileSync(path.join(ran, "failure_reason.txt"), "utf8")).toMatch(/^The repository's setup \(`AGENT_SETUP`\) exited with status 2\./);
    expect(s.env("update-branch:conclude")).toMatchObject({ AGENT_RESULT: "failure", TIMED_OUT: "false" });
  });

  it("bundles nothing and publishes nothing where the runner failed, and tells conclude", async () => {
    const s = setup({ ...UB_CONFLICTS, "update-branch": { exit: 1, files: { "failure_reason.txt": "The agent left conflicts unresolved in: a.ts." } } });
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.events.slice(-3)).toEqual(["update-branch", "push token", "update-branch:conclude"]);
    expect(s.env("update-branch:conclude")).toMatchObject({ AGENT_RESULT: "failure", TIMED_OUT: "false", DOWNLOAD_OUTCOME: "success" });
    expect(s.env("update-branch:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  it("ends a runner still running at AGENT_TIMEOUT_MINUTES, and tells conclude it timed out", async () => {
    const s = setup({ ...UB_CONFLICTS, "update-branch": { hangs: true } }, { minuteMs: 5 });
    const phases = await runJob({ ...UPDATE_BRANCH_JOB, variables: { ...UPDATE_BRANCH_JOB.variables, AGENT_TIMEOUT_MINUTES: "2" } }, s.edges);

    expect(phases).toContainEqual({ name: "update-branch", outcome: "timed out" });
    expect(s.events).not.toContain("update-branch:publish");
    expect(s.env("update-branch:conclude")).toMatchObject({ AGENT_RESULT: "cancelled", TIMED_OUT: "true", TIMEOUT_MINUTES: "2" });
  });

  it("publishes nothing where the push token was refused, and concludes with a token that writes", async () => {
    const s = setup(UB_CLEAN, { refused: [2] });
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.events).not.toContain("update-branch:publish");
    expect(s.asked).toEqual(["write", "push", "write"]);
    expect(s.checkouts).toHaveLength(1);
    expect(s.env("update-branch:conclude")).toMatchObject({ MINT_OUTCOME: "failure", GH_TOKEN: "write-token-3", LOOP_TOKEN: "write-token-3" });
    expect(s.env("update-branch:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  it("leaves publish's reason where conclude reads it where publish's checkout failed", async () => {
    const s = setup(UB_CLEAN);
    const checkout = s.edges.git.checkout;
    let calls = 0;
    s.edges.git.checkout = async (options) => {
      calls += 1;
      if (calls === 2) throw new Error("fatal: the remote hung up");
      return checkout(options);
    };
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.events).not.toContain("update-branch:publish");
    const publishDir = s.env("update-branch:conclude")["PUBLISH_DIR"]!;
    expect(fs.readFileSync(path.join(publishDir, "failure_reason.txt"), "utf8")).toBe(
      "The pull request's head could not be checked out to publish the refresh: fatal: the remote hung up",
    );
    expect(s.env("update-branch:conclude")).toMatchObject({ PUBLISH_OUTCOME: "failure" });
  });

  it("logs why the run ended where nothing can write its ending", async () => {
    const s = setup(UB_CLEAN, { refused: [2, 3] });
    const phases = await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.events).not.toContain("update-branch:conclude");
    expect(phases.at(-1)).toEqual({
      name: "update-branch:conclude",
      outcome: "not run: the dispatcher granted no token to write the ending with, and the run had ended so: the gate's result was success, and the agent's skipped",
    });
  });

  it("redacts every token it held in the run's summary", async () => {
    const s = setup(UB_CONFLICTS);
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    const text = fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8");
    expect(s.asked).toHaveLength(4);
    for (const token of [...s.asked.map((kind, at) => `${kind}-token-${at + 1}`), AGENT.CLAUDE_CODE_OAUTH_TOKEN]) {
      expect(text).not.toContain(token);
    }
    expect(text).toContain(REDACTED);
  });
});

describe("the run's directory", () => {
  const read = (runDir: string): string => fs.readFileSync(path.join(runDir, SUMMARY_FILE), "utf8");

  it("keeps a summary of the job and each phase's outcome, with every token redacted", async () => {
    const s = setup({ ...ORDINARY, "review:conclude": { files: { "ended.json": { moved: false } } } });
    await runJob({ ...JOB, branch: "agent/prd-453-the-service" }, s.edges);

    const text = read(s.runDir);
    const summary = JSON.parse(text) as { job: ReviewJob; phases: { name: string; outcome: string }[]; subcommands: { subcommand: string }[] };
    expect(summary.job.id).toBe("job-1");
    expect(summary.phases.map(({ name }) => name)).toContain("review:advance");
    expect(summary.subcommands.map(({ subcommand }) => subcommand)).toEqual([
      "review:gate",
      "review:budget",
      "review:collect-checks",
      "review",
      "review:publish",
      "review:conclude",
      "review:advance",
    ]);
    expect(s.asked).toHaveLength(4);
    for (const token of [...s.asked.map((kind, at) => `${kind}-token-${at + 1}`), AGENT.CLAUDE_CODE_OAUTH_TOKEN]) {
      expect(text).not.toContain(token);
    }
    expect(text).toContain(REDACTED);
  });

  it("redacts a token wherever a phase's outcome quotes it, in the summary and in what the worker logs", async () => {
    const s = setup({ ...ORDINARY, review: { files: { "failure_reason.txt": "GH_TOKEN read-token-2 was refused." }, exit: 1 } });
    const phases = await runJob(JOB, s.edges);

    expect(read(s.runDir)).not.toContain("read-token-2");
    expect(JSON.stringify(phases)).not.toContain("read-token-2");
    expect(phases).toContainEqual({ name: "review", outcome: `failure (exit 1): GH_TOKEN ${REDACTED} was refused.` });
  });

  it("keeps a summary where nothing could write the ending", async () => {
    const s = setup(ORDINARY, { refused: [1, 2] });
    await runJob(JOB, s.edges);

    expect(JSON.parse(read(s.runDir))).toMatchObject({ phases: [{ name: "read token" }, { name: "write token" }, { name: "review:conclude" }] });
  });

  it("keeps each subcommand's output directory and log under it", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    for (const { env, log } of s.launched) {
      expect(env["OUTPUT_DIR"]?.startsWith(s.runDir)).toBe(true);
      expect(log.startsWith(s.runDir)).toBe(true);
    }
  });
});

describe("the job door", () => {
  const SECRET = "the-worker-secret";
  const request = (job: unknown, secret = SECRET) => {
    const body = Buffer.from(JSON.stringify(job));
    return { headers: { [SIGNATURE_HEADER]: sign(secret, body) }, body };
  };
  const door = () => {
    const accepted: Job[] = [];
    return { accepted, handle: jobDoor({ secret: SECRET, version: "9.9.9", accept: (job) => accepted.push(job) }) };
  };

  it("queues a job from a dispatcher of its own release, answering 202", () => {
    const d = door();

    expect(d.handle(request(JOB)).status).toBe(202);
    expect(d.accepted).toEqual([JOB]);
  });

  it("refuses a job from a dispatcher of another release, naming both", () => {
    const d = door();
    const response = d.handle(request({ ...JOB, version: "9.9.8" }));

    expect(response.status).toBe(409);
    expect(response.body).toContain("9.9.8");
    expect(response.body).toContain("9.9.9");
    expect(d.accepted).toEqual([]);
  });

  it("refuses a job whose signature does not verify", () => {
    const d = door();

    expect(d.handle(request(JOB, "someone-elses-secret")).status).toBe(401);
    expect(d.accepted).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["an unknown", { ...JOB, workflow: "deploy" }],
    ["a missing", { ...JOB, workflow: undefined }],
  ])("refuses a job with %s workflow kind, naming the field", (_name, job) => {
    const d = door();
    const response = d.handle(request(job));

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ refusal: "`workflow` is not one of `review`, `fix`, `update-branch`, `implement`" });
    expect(d.accepted).toEqual([]);
  });

  it("refuses a body that is not a job", () => {
    const d = door();

    expect(d.handle(request({ ...JOB, headSha: "not-a-commit" })).status).toBe(400);
    expect(d.accepted).toEqual([]);
  });

  it("queues an update-branch job, and refuses a malformed one, naming the field", () => {
    const d = door();

    expect(d.handle(request(UPDATE_BRANCH_JOB)).status).toBe(202);
    expect(d.accepted).toEqual([UPDATE_BRANCH_JOB]);

    const malformed = d.handle(request({ ...UPDATE_BRANCH_JOB, baseRef: "" }));
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ refusal: "`baseRef` is not a non-empty string" });
    expect(d.accepted).toEqual([UPDATE_BRANCH_JOB]);
  });

  it("queues an implement job, and refuses one with no issue, naming the field", () => {
    const d = door();

    expect(d.handle(request(IMPLEMENT_JOB)).status).toBe(202);
    expect(d.accepted).toEqual([IMPLEMENT_JOB]);

    const malformed = d.handle(request({ ...IMPLEMENT_JOB, issue: undefined }));
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ refusal: "`issue` is not a positive integer" });
    expect(d.accepted).toEqual([IMPLEMENT_JOB]);
  });
});

const IMPLEMENT_JOB: ImplementJob = {
  workflow: "implement",
  id: "job-1",
  version: "9.9.9",
  deadline: "2026-10-11T14:00:00.000Z",
  repo: "owner/repo",
  issue: 12,
  title: "Add a thing",
  state: "open",
  baseRef: "main",
  appLogin: "loop-app[bot]",
  variables: JOB.variables,
};
const BRANCH = "agent/issue-12-add-a-thing";
const TIP = "e".repeat(40);
const RUN_URL = "https://github.com/apps/loop-app";

/** The files each implement subcommand writes on a run that goes ahead and opens its pull request. */
const IMPLEMENT_ORDINARY: Readonly<Partial<Record<Subcommand, Canned>>> = {
  "implement:gate": { files: { "gate.json": { proceed: "true", branch: BRANCH, base: BASE, tip: TIP } } },
  "implement:bundle": { files: { "branch.bundle": "the agent's commits" } },
  "implement:publish": { files: { "published.json": { pushed: true, head: "f".repeat(40), pr: 40, reviewRequested: true } } },
};

/**
 * An implement job, run as `implement.yml` runs one (spec §6): the gate job;
 * the agent's job where the gate claimed the run; and the publish job, with
 * publish only where the agent's job succeeded and conclude always, each
 * under its job's and step's `if:` rather than in order alone.
 */
describe("the worker's implement job, on a run that goes ahead", () => {
  it("runs the gate, the checkout, prepare, the setup, the runner, bundle, then publish in a checkout of its own and conclude, in that order", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    await runJob({ ...IMPLEMENT_JOB, variables: { ...IMPLEMENT_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).toEqual([
      "write token",
      "implement:gate",
      "read token",
      "checkout",
      "implement:prepare",
      "sandbox",
      "read token",
      "implement",
      "implement:bundle",
      "push token",
      "checkout",
      "implement:publish",
      "implement:conclude",
    ]);
  });

  it("hands each subcommand its job's token kind: write to the gate, none to prepare and bundle, read alone to the runner, push to publish and conclude", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.asked).toEqual(["write", "read", "read", "push"]);
    expect(tokensIn(s.env("implement:gate"))).toEqual(["write-token-1"]);
    expect(tokensIn(s.env("implement:prepare"))).toEqual([]);
    expect(tokensIn(s.env("implement"))).toEqual(["read-token-3"]);
    expect(tokensIn(s.env("implement:bundle"))).toEqual([]);
    expect(s.env("implement:publish")).toMatchObject({ GH_TOKEN: "push-token-4", LOOP_TOKEN: "push-token-4", LOOP_TOKEN_SOURCE: "app" });
    expect(tokensIn(s.env("implement:conclude"))).toEqual(["push-token-4"]);
  });

  it("puts only the read token in the runner's environment, beside the agent's own", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    await runJob(IMPLEMENT_JOB, s.edges);

    const runner = s.env("implement");
    expect(Object.entries(runner).filter(([name]) => name.endsWith("TOKEN")).sort()).toEqual([
      ["CLAUDE_CODE_OAUTH_TOKEN", AGENT.CLAUDE_CODE_OAUTH_TOKEN],
      ["GH_TOKEN", "read-token-3"],
    ]);
    expect(Object.values(runner).filter((value) => /write-token|push-token/.test(value))).toEqual([]);
  });

  it("checks out the commit the gate read the base at, once for the agent and once for publish, each a directory of its own", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    await runJob(IMPLEMENT_JOB, s.edges);

    const checkout = path.join(s.runDir, "checkout");
    const publishCheckout = path.join(s.runDir, "publish-checkout");
    const base = { repo: "owner/repo", branch: "main", sha: BASE, baseRef: "main", committer: "loop-app[bot]" };
    expect(s.checkouts).toEqual([
      { ...base, dir: checkout, token: "read-token-2" },
      { ...base, dir: publishCheckout, token: "push-token-4" },
    ]);
    expect(s.launched.find((launch) => launch.subcommand === "implement")?.cwd).toBe(checkout);
    expect(s.env("implement:prepare")["CHECKOUT"]).toBe(checkout);
    expect(s.env("implement:bundle")["CHECKOUT"]).toBe(checkout);
    expect(s.env("implement:publish")["CHECKOUT"]).toBe(publishCheckout);
  });

  it("hands each subcommand the inputs implement.yml hands it, with the gate's facts as the gate job's outputs", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    await runJob({ ...IMPLEMENT_JOB, variables: { ...IMPLEMENT_JOB.variables, AGENT_MODEL_IMPLEMENT: "a-build-model" } }, s.edges);

    const issue = { GH_REPO: "owner/repo", ISSUE_NUMBER: "12" };
    expect(s.env("implement:gate")).toMatchObject({ ...issue, ISSUE_TITLE: "Add a thing", ISSUE_STATE: "open", BASE_REF: "main", RUN_URL });
    expect(s.env("implement:prepare")).toMatchObject({ BRANCH, BASE_REF: "main", BASE_SHA: BASE });
    expect(s.env("implement")).toMatchObject({
      ...AGENT,
      ...issue,
      ISSUE_TITLE: "Add a thing",
      BRANCH,
      BASE_REF: "main",
      AGENT_MODEL: "a-model",
      AGENT_MODEL_IMPLEMENT: "a-build-model",
      AGENT_LOOP_LOGINS: "loop-app[bot]",
    });
    expect(s.env("implement:bundle")).toMatchObject({ BRANCH, BASE_SHA: BASE });
    expect(s.env("implement:publish")).toMatchObject({
      ...issue,
      ISSUE_TITLE: "Add a thing",
      BASE_REF: "main",
      BRANCH,
      BASE_SHA: BASE,
      BRANCH_TIP: TIP,
      RUN_URL,
      BUNDLE_DIR: s.env("implement:bundle")["OUTPUT_DIR"],
    });
    expect(s.env("implement:conclude")).toMatchObject({ ...issue, RUN_URL });
  });

  it("tells conclude how each job and step ended, pointed at each producer's directory", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    await runJob(IMPLEMENT_JOB, s.edges);

    const out = (subcommand: Subcommand): string | undefined => s.env(subcommand)["OUTPUT_DIR"];
    expect(s.env("implement:conclude")).toMatchObject({
      REFUSED: "false",
      GATE_RESULT: "success",
      AGENT_RESULT: "success",
      TIMED_OUT: "false",
      TIMEOUT_MINUTES: String(DEFAULT_FIX_MINUTES),
      MINT_OUTCOME: "success",
      DOWNLOAD_OUTCOME: "success",
      PUBLISH_OUTCOME: "success",
      PUBLISH_DIR: out("implement:publish"),
      PREPARE_DIR: out("implement:prepare"),
      IMPLEMENT_DIR: out("implement"),
      BUNDLE_DIR: out("implement:bundle"),
    });
    expect(s.env("implement:conclude")).not.toHaveProperty("GATE_REASON");
  });

  it("holds the gate to the gate job's 10 minutes and publish and conclude to the publish job's 15", () => {
    expect(IMPLEMENT_GATE_MINUTES).toBe(10);
    expect(IMPLEMENT_POSTING_MINUTES).toBe(15);
  });
});

describe("the worker's implement job, where the gate does not claim the run", () => {
  it("runs nothing after a refusal and asks for no other token, since the gate said it and took the label off, and notes the refusal", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, "implement:gate": { files: { "gate.json": { proceed: "false" }, "write_log.jsonl": "{}" } } });
    const phases = await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement:gate"]);
    expect(s.asked).toEqual(["write"]);
    expect(s.checkouts).toEqual([]);
    expect(phases.at(-1)).toEqual({
      name: "implement:gate",
      outcome: "refused or deferred: the run ends here, as neither job after the gate runs then",
    });
    expect(fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8")).toContain("refused or deferred: the run ends here");
  });

  it("hands a closed issue's state to the gate, and runs nothing after the gate refuses it, asking for no other token", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, "implement:gate": { files: { "gate.json": { proceed: "false" }, "write_log.jsonl": "{}" } } });
    await runJob({ ...IMPLEMENT_JOB, state: "closed" }, s.edges);

    expect(s.env("implement:gate")).toMatchObject({ ISSUE_STATE: "closed" });
    expect(s.events).toEqual(["write token", "implement:gate"]);
    expect(s.asked).toEqual(["write"]);
  });

  it("runs nothing after deferring an issue with sub-issues to implement-prd, asks for no other token, and writes nothing for the PRD", async () => {
    // A deferral is the gate's `proceed: false` with no write: it leaves no write log.
    const s = setup({ ...IMPLEMENT_ORDINARY, "implement:gate": { files: { "gate.json": { proceed: "false" } } } });
    const phases = await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement:gate"]);
    expect(s.asked).toEqual(["write"]);
    expect(s.launched.map(({ subcommand }) => subcommand)).toEqual(["implement:gate"]);
    expect(s.checkouts).toEqual([]);
    expect(s.sandboxed).toEqual([]);
    // The worker writes nothing to the record itself, and nothing but the gate ran to write it.
    expect(fs.readdirSync(s.env("implement:gate")["OUTPUT_DIR"]!)).toEqual(["gate.json"]);
    expect(phases.map(({ name }) => name)).toEqual(["write token", "implement:gate", "implement:gate"]);
  });

  it("runs no agent's job where the gate decided nothing, and concludes undecided under the publish job's own token", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, "implement:gate": { exit: 1, files: { "failure_reason.txt": "Couldn't read the issue's shape." } } });
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement:gate", "push token", "implement:conclude"]);
    expect(s.checkouts).toEqual([]);
    expect(s.env("implement:conclude")).toMatchObject({
      GH_TOKEN: "push-token-2",
      GATE_RESULT: "failure",
      GATE_REASON: "Couldn't read the issue's shape.",
      AGENT_RESULT: "skipped",
      MINT_OUTCOME: "success",
    });
    for (const name of ["REFUSED", "DOWNLOAD_OUTCOME", "PUBLISH_OUTCOME"]) expect(s.env("implement:conclude")).not.toHaveProperty(name);
  });

  it("runs no agent's job where the gate failed after claiming the run, and hands conclude its reason", async () => {
    const s = setup({
      ...IMPLEMENT_ORDINARY,
      "implement:gate": { exit: 1, files: { "gate.json": { proceed: "true" }, "failure_reason.txt": "Couldn't add `agent:implement`." } },
    });
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement:gate", "push token", "implement:conclude"]);
    expect(s.env("implement:conclude")).toMatchObject({
      REFUSED: "false",
      GATE_RESULT: "failure",
      GATE_REASON: "Couldn't add `agent:implement`.",
      AGENT_RESULT: "skipped",
    });
  });

  it("logs the reason where no token to claim the issue with was granted, and concludes undecided", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { refused: [1] });
    const phases = await runJob(IMPLEMENT_JOB, s.edges);

    expect(phases).toContainEqual({ name: "implement:gate", outcome: "not run: the dispatcher granted no token to claim the issue with" });
    expect(s.events).toEqual(["write token", "push token", "implement:conclude"]);
    expect(s.env("implement:conclude")).toMatchObject({ GATE_RESULT: "failure", AGENT_RESULT: "skipped" });
  });
});

describe("the worker's implement job, where it stops", () => {
  it.each<[string, Readonly<Partial<Record<Subcommand, Canned>>>]>([
    ["the runner", { ...IMPLEMENT_ORDINARY, implement: { exit: 1, files: { "failure_reason.txt": "The issue no longer matches the code." } } }],
    ["bundle", { ...IMPLEMENT_ORDINARY, "implement:bundle": { exit: 1, files: { "failure_reason.txt": "The agent made no commits." } } }],
  ])("publishes nothing where %s failed, and concludes, told the agent's job failed", async (_name, canned) => {
    const s = setup(canned);
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).not.toContain("implement:publish");
    expect(s.events.slice(-2)).toEqual(["push token", "implement:conclude"]);
    expect(s.checkouts).toHaveLength(1);
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "failure", MINT_OUTCOME: "success", DOWNLOAD_OUTCOME: "success" });
    expect(s.env("implement:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  it("bundles nothing where the runner failed, as the bundle step runs on success alone", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, implement: { exit: 1 } });
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).not.toContain("implement:bundle");
  });

  it("starts no runner where the setup failed, and gives conclude the setup's reason as the runner's", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { setupRun: { exit: 2, output: "npm ERR! missing script\n" } });
    await runJob({ ...IMPLEMENT_JOB, variables: { ...IMPLEMENT_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).not.toContain("implement");
    expect(s.events).not.toContain("implement:publish");
    const runnerDir = s.env("implement:conclude")["IMPLEMENT_DIR"]!;
    expect(fs.readFileSync(path.join(runnerDir, "failure_reason.txt"), "utf8")).toMatch(/^The repository's setup \(`AGENT_SETUP`\) exited with status 2\./);
  });

  it("starts nothing of the agent's where the base could not be checked out, and leaves the reason as prepare's", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    s.edges.git.checkout = async () => {
      throw new Error("fatal: couldn't find remote ref");
    };
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).not.toContain("implement:prepare");
    expect(s.events).not.toContain("implement");
    expect(fs.readFileSync(path.join(s.env("implement:conclude")["PREPARE_DIR"]!, "failure_reason.txt"), "utf8")).toBe(
      "`main` could not be checked out: fatal: couldn't find remote ref",
    );
  });

  it("ends a runner still running at AGENT_TIMEOUT_MINUTES, publishes nothing, and tells conclude it timed out", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, implement: { hangs: true } }, { minuteMs: 5 });
    await runJob({ ...IMPLEMENT_JOB, variables: { ...IMPLEMENT_JOB.variables, AGENT_TIMEOUT_MINUTES: "2" } }, s.edges);

    expect(s.events).not.toContain("implement:bundle");
    expect(s.events).not.toContain("implement:publish");
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "cancelled", TIMED_OUT: "true", TIMEOUT_MINUTES: "2" });
  });

  it("publishes nothing where the push token was refused, and concludes with a token that writes", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { refused: [4] });
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).not.toContain("implement:publish");
    expect(s.asked).toEqual(["write", "read", "read", "push", "write"]);
    expect(s.env("implement:conclude")).toMatchObject({ MINT_OUTCOME: "failure", GH_TOKEN: "write-token-5" });
  });

  it("leaves publish's reason where conclude reads it where publish's checkout failed", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    const checkout = s.edges.git.checkout;
    s.edges.git.checkout = async (options) => {
      if (options.dir.endsWith("publish-checkout")) throw new Error("fatal: unable to access");
      return checkout(options);
    };
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).not.toContain("implement:publish");
    expect(s.env("implement:conclude")).toMatchObject({ PUBLISH_OUTCOME: "failure" });
    expect(fs.readFileSync(path.join(s.env("implement:conclude")["PUBLISH_DIR"]!, "failure_reason.txt"), "utf8")).toBe(
      "`main` could not be checked out to publish the branch: fatal: unable to access",
    );
  });

  it("logs why the run ended where nothing can write its ending", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, implement: { exit: 1 } }, { refused: [4, 5] });
    const phases = await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events).not.toContain("implement:conclude");
    expect(phases.at(-1)).toEqual({
      name: "implement:conclude",
      outcome:
        "not run: the dispatcher granted no token to write the ending with, and the run had ended so: the gate's result was success, and the agent's failure",
    });
  });
});
