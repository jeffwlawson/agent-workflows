import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_WORKTREE } from "../../engine/bwrap-args.js";
import { CI_WAIT_SECONDS } from "../../review/collect-checks.js";
import { issueRescueBranch } from "../../shared/record.js";
import {
  DEFAULT_FIX_MINUTES,
  DEFAULT_REVIEW_MINUTES,
  heldOf,
  HELD_REQUEST_MAX_AGE_MINUTES,
  HELD_REQUEST_MAX_SKEW_MINUTES,
  parseHeld,
  sign,
  SIGNATURE_HEADER,
  FOLLOW_UPS_MINUTES,
  MERGE_MINUTES,
  REPOSITORY_VARIABLES,
  SETUP_CHECK_REPORT_MINUTES,
  type FixJob,
  type FollowUpsJob,
  type ImplementJob,
  type ImplementPrdJob,
  type Job,
  type MergeJob,
  type ReviewJob,
  type SetupCheckJob,
  type TokenKind,
  type UpdateBranchJob,
} from "../../service/job.js";
import {
  CATCH_UP_MINUTES,
  IMPLEMENT_GATE_MINUTES,
  IMPLEMENT_POSTING_MINUTES,
  IMPLEMENT_PRD_GATE_MINUTES,
  IMPLEMENT_PRD_POSTING_MINUTES,
  admit,
  heldDoor,
  MERGE_WAIT_SECONDS,
  jobDoor,
  lanes,
  LANES,
  RESET_MARGIN_MINUTES,
  REDACTED,
  runJob,
  serviceRunUrl,
  SETUP_PHASE,
  startRun,
  TOOLCHAIN_BIN_PATHS,
  TOOLCHAIN_DIR,
  TOOLCHAIN_PHASE,
  TOOLCHAIN_VARIABLE,
  VERIFY_PHASE,
  SUMMARY_FILE,
  type JobEdges,
  type Launch,
  type Phase,
  type SandboxRun,
  type SandboxScript,
  type Subcommand,
} from "../../service/worker.js";
import { COMMANDS, RUNNERS, SANDBOX, type Command, type Runner } from "../../shared/contract.js";
import type { HostEnvironment } from "../../shared/env.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

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
  instance: "dispatcher-1",
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
    AGENT_MODEL_IMPLEMENT_PRD: "",
    AGENT_EFFORT: "",
    AGENT_EFFORT_REVIEW: "",
    AGENT_EFFORT_FIX: "",
    AGENT_EFFORT_UPDATE_BRANCH: "",
    AGENT_EFFORT_IMPLEMENT: "",
    AGENT_EFFORT_IMPLEMENT_PRD: "",
    AGENT_PROMPT_CACHE_TTL: "",
    AGENT_REVIEW_TIMEOUT_MINUTES: "",
    AGENT_TIMEOUT_MINUTES: "",
    AGENT_MAX_FIX_ROUNDS: "3",
    AGENT_FIX_MIN_SEVERITY: "high",
    AGENT_SETUP: "",
    AGENT_VERIFY: "",
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
  "review:gate": { files: { "gate.json": { proceed: "true", sha: HEAD, budget: "3", threshold: "high" } } },
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
    /** The same, per variable the sandbox runs, where a job runs more than one script there: a setup check's (#821). */
    readonly sandboxRuns?: Partial<Record<SandboxScript, { readonly exit?: number; readonly output?: string; readonly hangs?: boolean; readonly throws?: string }>>;
    /** Why the checkout fails, where it does. */
    readonly checkoutFails?: string;
    /** Directories every checkout leaves in its directory, made before its files (#822). */
    readonly checkoutDirs?: readonly string[];
    /** Files every checkout leaves in its directory, such as a `mise.toml` (#822). */
    readonly checkoutFiles?: Readonly<Record<string, string>>;
    /** Whether every checkout is a real git repository, made with `git init`. */
    readonly gitCheckout?: boolean;
    /**
     * What the toolchain's `mise bin-paths` writes, one line each, where its
     * sandbox exits 0 (#822): or made from the checkout's host path.
     */
    readonly toolchainBins?: readonly string[] | ((checkout: string) => readonly string[]);
    /** Whether the box has no mise, at the path the worker is pointed at. */
    readonly noMise?: boolean;
  } = {},
) => {
  const sandboxed: SandboxRun[] = [];
  /** Every edge the job touched, in the order it touched them. */
  const events: string[] = [];
  const launched: (Launch & { readonly emptyAtStart: boolean })[] = [];
  const asked: TokenKind[] = [];
  // A run's own directory, fresh, so a test can run more than one job.
  const runDir = fs.mkdtempSync(path.join(scratch, "run-"));
  // The box's mise, which the worker only checks is there: the sandbox is a fake.
  const mise = path.join(scratch, "mise");
  fs.writeFileSync(mise, "");
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
        if (options.checkoutFails !== undefined) throw new Error(options.checkoutFails);
        fs.mkdirSync(rest.dir, { recursive: true });
        if (options.gitCheckout === true) execFileSync("git", ["init", "--quiet", rest.dir], { stdio: "ignore", timeout: SUBPROCESS_TIMEOUT });
        for (const name of options.checkoutDirs ?? []) fs.mkdirSync(path.join(rest.dir, name), { recursive: true });
        for (const [name, content] of Object.entries(options.checkoutFiles ?? {})) fs.writeFileSync(path.join(rest.dir, name), content);
      },
    },
    sandbox: async (run: SandboxRun) => {
      sandboxed.push(run);
      events.push("sandbox");
      const { exit = 0, output, hangs = false, throws } = options.sandboxRuns?.[run.variable] ?? options.setupRun ?? {};
      if (throws !== undefined) throw new Error(throws);
      if (output !== undefined) fs.appendFileSync(run.log, output);
      if (run.variable === TOOLCHAIN_VARIABLE && exit === 0 && !hangs) {
        // What mise leaves in the folder: an install, and its bin-paths.
        const folder = path.join(run.dir, TOOLCHAIN_DIR);
        fs.mkdirSync(path.join(folder, "installs", "node", "24", "bin"), { recursive: true });
        fs.writeFileSync(path.join(folder, "installs", "node", "24", "bin", "node"), "");
        fs.writeFileSync(path.join(folder, TOOLCHAIN_BIN_PATHS), (typeof options.toolchainBins === "function" ? options.toolchainBins(run.dir) : (options.toolchainBins ?? [])).map((line) => `${line}\n`).join(""));
      }
      return hangs ? hang(run.signal, 143) : exit;
    },
    mise: options.noMise === true ? path.join(scratch, "no-such-dir", "mise") : mise,
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
      FIX_MIN_SEVERITY: "high",
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
      "ci token",
      "review:collect-checks",
      "read token",
      "review",
      "resolve token",
      "review:publish",
      "write token",
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

    expect(s.env("review:collect-checks")["GH_TOKEN"]).toBe("ci-token-2");
    expect(s.env("review")).toMatchObject({ ...AGENT, GH_TOKEN: "read-token-3", AGENT_MODEL: "a-model", AGENT_LOOP_LOGINS: "loop-app[bot]" });
    expect(s.env("review")).not.toHaveProperty("AGENT_MODEL_REVIEW");
    expect(s.env("review")).not.toHaveProperty("RED_CHECK_CONFIGURED");
  });

  // #632: the failed runs' logs need Actions: read, which only the `ci`
  // token asks for; an installation that has not accepted it refuses that
  // token, and the CI wait reads with the gate's instead.
  it("reads CI with a ci token, which the runner never holds, and with the gate's read token where it is refused", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    const holders = s.launched.filter(({ env }) => Object.values(env).some((value) => value.includes("ci-token"))).map(({ subcommand }) => subcommand);
    expect(holders).toEqual(["review:collect-checks"]);

    const refused = setup(ORDINARY, { refused: [2] });
    const phases = await runJob(JOB, refused.edges);

    expect(refused.env("review:collect-checks")["GH_TOKEN"]).toBe("read-token-1");
    expect(refused.events).toContain("review");
    expect(phases).toContainEqual({ name: "ci token", outcome: "failure: the dispatcher answered 403: the job is past its deadline" });
  });

  it("puts no write token in the runner's environment, or in any command's that only reads", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    for (const subcommand of READ_ONLY) {
      expect(Object.values(s.env(subcommand)).filter((value) => value.includes("write-token")), subcommand).toEqual([]);
    }
    for (const subcommand of READ_ONLY) {
      expect(Object.values(s.env(subcommand)).filter((value) => value.includes("resolve-token")), subcommand).toEqual([]);
    }
    expect(s.env("review:publish")).toMatchObject({ GH_TOKEN: "resolve-token-4", LOOP_TOKEN: "resolve-token-4", LOOP_TOKEN_SOURCE: "app" });
    expect(s.env("review:conclude")).toMatchObject({ GH_TOKEN: "write-token-5", LOOP_TOKEN: "write-token-5", LOOP_TOKEN_SOURCE: "app" });
    expect(s.asked).toEqual(["read", "ci", "read", "resolve", "write"]);
  });

  it("hands the resolve token to review:publish alone: not conclude, not advance", async () => {
    const s = setup({ ...ORDINARY, "review:conclude": { files: { "ended.json": { moved: false } } } });
    await runJob({ ...JOB, branch: "agent/prd-453-the-service" }, s.edges);

    expect(s.asked).toEqual(["read", "ci", "read", "resolve", "write", "write"]);
    const holders = s.launched.filter(({ env }) => Object.values(env).some((value) => value.includes("resolve-token"))).map(({ subcommand }) => subcommand);
    expect(holders).toEqual(["review:publish"]);
  });

  it("publishes with a write token where the resolve token is refused, reuses it for conclude, and logs that threads stay open", async () => {
    const s = setup(ORDINARY, { refused: [4] });
    const phases = await runJob(JOB, s.edges);

    expect(s.asked).toEqual(["read", "ci", "read", "resolve", "write"]);
    expect(s.env("review:publish")).toMatchObject({ GH_TOKEN: "write-token-5", LOOP_TOKEN: "write-token-5" });
    expect(s.env("review:conclude")).toMatchObject({ GH_TOKEN: "write-token-5", MINT_OUTCOME: "success", PUBLISH_OUTCOME: "success" });
    expect(phases).toContainEqual({ name: "resolve token", outcome: "failure: the dispatcher answered 403: the job is past its deadline" });
    const resolution = phases.find(({ name }) => name === "thread resolution");
    expect(resolution?.outcome).toContain("`resolve` token was refused");
    expect(resolution?.outcome).toContain("stays open");
  });

  it("hands review:budget the budget the gate settled from AGENT_MAX_FIX_ROUNDS, as review.yml does", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(JOB.variables.AGENT_MAX_FIX_ROUNDS).toBe("3");
    expect(s.env("review:gate")["MAX_FIX_ROUNDS"]).toBe("3");
    expect(s.env("review:budget")).toMatchObject({ FIX_ROUND_BUDGET: "3", LOOP_TOKEN_SOURCE: "app", BASE_REF: "main" });
  });

  it("hands the runner the fix threshold the gate settled from AGENT_FIX_MIN_SEVERITY, as review.yml does", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.env("review:gate")["FIX_MIN_SEVERITY"]).toBe("high");
    expect(s.env("review")["FIX_MIN_SEVERITY"]).toBe("high");
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
    const s = setup(ORDINARY, { refused: [3] });
    await runJob(JOB, s.edges);

    expect(s.events).not.toContain("review");
    expect(s.env("review:conclude")).toMatchObject({ REVIEW_RESULT: "failure", PROCEED: "true" });
    expect(s.env("review:conclude")["FAILURE_REASON"]).toContain("granted no token");
  });

  it("tells conclude the posting token's mint failed, and publishes nothing", async () => {
    const s = setup(ORDINARY, { refused: [4, 5] });
    await runJob(JOB, s.edges);

    expect(s.asked).toEqual(["read", "ci", "read", "resolve", "write", "write"]);
    expect(s.events).not.toContain("review:publish");
    expect(s.env("review:conclude")).toMatchObject({
      REVIEW_RESULT: "success",
      VERDICT: "approve",
      MINT_OUTCOME: "failure",
      GH_TOKEN: "write-token-6",
    });
    expect(s.env("review:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  it("tells conclude publish failed", async () => {
    const s = setup({ ...ORDINARY, "review:publish": { files: { "failure_reason.txt": "GitHub answered 502." }, exit: 1 } });
    await runJob(JOB, s.edges);

    expect(s.env("review:conclude")).toMatchObject({ REVIEW_RESULT: "success", MINT_OUTCOME: "success", PUBLISH_OUTCOME: "failure" });
  });

  it("puts the reason in the worker's log where nothing can write the ending to the pull request", async () => {
    const s = setup({ ...ORDINARY, review: { files: { "failure_reason.txt": "The agent stopped." }, exit: 1 } }, { refused: [4] });
    const phases = await runJob(JOB, s.edges);

    expect(s.events).not.toContain("review:conclude");
    expect(phases.at(-2)).toEqual({ name: "write token", outcome: "failure: the dispatcher answered 403: the job is past its deadline" });
    expect(phases.at(-1)?.name).toBe("review:conclude");
    expect(phases.at(-1)?.outcome).toContain("not run");
    expect(phases.at(-1)?.outcome).toContain("The agent stopped.");
  });
});

describe("the worker's job, where the plan's usage limit stops its agent (#635)", () => {
  const LIMIT = "claude-code exited with code 1: You've hit your session limit · resets 5:50am (UTC)";
  // The worker reads the message on its own clock, so the test holds that
  // clock: on the real one the answer is today's 05:50 for the grace after it
  // (#665).
  afterEach(() => {
    vi.useRealTimers();
  });

  // The CLI's wording on 2026-11-03 (#739).
  const FIVE_HOUR = "Claude-code exited with code 1: You've hit your 5-hour limit · resets 6:50pm (UTC).";

  it.each([
    { reason: LIMIT, stopped: "2026-11-01T01:10:00Z", resets: "2026-11-01T05:50:00.000Z" },
    { reason: LIMIT, stopped: "2026-11-01T07:00:00Z", resets: "2026-11-02T05:50:00.000Z" },
    { reason: FIVE_HOUR, stopped: "2026-11-03T17:31:00Z", resets: "2026-11-03T18:50:00.000Z" },
  ])("tells the queue the next reset instant, at $resets for a run stopped at $stopped, and tells conclude it runs on the service, with the loop's account", async ({ reason, stopped, resets }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(stopped));
    const s = setup({ ...ORDINARY, review: { files: { "failure_reason.txt": `${reason}\n` }, exit: 1 } });
    const limited: Date[] = [];
    const phases = await runJob(JOB, { ...s.edges, limited: (until) => limited.push(until) });

    expect(limited).toHaveLength(1);
    const until = limited[0]!;
    expect(until.toISOString()).toBe(resets);
    expect(phases).toContainEqual({ name: "usage limit", outcome: `the plan's usage limit stopped review; it resets at ${until.toISOString()}` });
    expect(s.env("review:conclude")).toMatchObject({ ORCHESTRATOR: "service", AGENT_LOOP_LOGINS: JOB.appLogin, FAILURE_REASON: reason });
  });

  it("tells the queue nothing where the runner failed any other way, or a command gave the message", async () => {
    const s = setup({
      ...ORDINARY,
      review: { files: { "failure_reason.txt": "The agent's model refused the token.\n" }, exit: 1 },
      "review:conclude": { files: { "failure_reason.txt": LIMIT }, exit: 1 },
    });
    const limited: Date[] = [];
    await runJob(JOB, { ...s.edges, limited: (until) => limited.push(until) });

    expect(limited).toEqual([]);
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

    expect(s.events.slice(-5)).toEqual(["review:publish", "write token", "review:conclude", "write token", "review:advance"]);
    expect(s.env("review:advance")).toMatchObject({
      GH_TOKEN: "write-token-6",
      LOOP_TOKEN: "write-token-6",
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

  it("does not advance where the plan's usage limit stopped the review and it resumes (#635)", async () => {
    const s = setup({ ...ORDINARY, review: { exit: 1 }, "review:conclude": { files: { "ended.json": { moved: false, resumes: true } } } });
    await runJob(PRD, s.edges);

    expect(s.events.at(-1)).toBe("review:conclude");
    expect(s.events).not.toContain("review:advance");
  });

  it("logs that the chain was not advanced where no token to advance it with was granted", async () => {
    const s = setup(reviewed, { refused: [6] });
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
        variable: "AGENT_SETUP",
        dir: path.join(s.runDir, "checkout"),
        at: SANDBOX_WORKTREE,
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

  it("shows setup the checkout at its own path where the agent works in the checkout itself, under AGENT_SANDBOX=none", async () => {
    const s = setup();
    await ranSetup({ ...s.edges, agent: { ...AGENT, AGENT_SANDBOX: "none" } }, "npm ci");

    expect(s.sandboxed[0]?.at).toBe(path.join(s.runDir, "checkout"));
  });

  it("hands the sandbox no proxy where the worker's settings give it none", async () => {
    const s = setup();
    await ranSetup({ ...s.edges, agent: { ...AGENT, AGENT_SANDBOX_PROXY: "" } }, "npm ci");

    expect(s.sandboxed[0]).not.toHaveProperty("proxy");
  });

  it("hands the sandbox the proxy under AGENT_SANDBOX=none too, so setup's network is its own wherever there is one (#537)", async () => {
    const s = setup();
    await ranSetup({ ...s.edges, agent: { ...AGENT, AGENT_SANDBOX: "none" } }, "npm ci");

    expect(s.sandboxed[0]?.proxy).toBe("http://proxy:3128");
  });

  it("fails unstarted, naming AGENT_SANDBOX_PROXY and no credential, under AGENT_SANDBOX=none with a proxy the relay would not take", async () => {
    for (const proxy of ["https://someone:hunter2@proxy:3128", "someone:hunter2@proxy:3128"]) {
      const s = setup();
      const { ran, phases } = await ranSetup({ ...s.edges, agent: { ...AGENT, AGENT_SANDBOX: "none", AGENT_SANDBOX_PROXY: proxy } }, "npm ci");

      expect(ran.ok).toBe(false);
      expect(ran.timedOut).toBe(false);
      expect(ran.failureReason).toMatch(/^The repository's setup \(`AGENT_SETUP`\) could not be started in the sandbox: `AGENT_SANDBOX_PROXY` is /);
      expect(ran.failureReason).not.toMatch(/someone|hunter2/);
      expect(s.sandboxed).toEqual([]);
      expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: `failure: ${ran.failureReason}` });
    }
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
  it("runs the gate, the checkout, prepare, the setup, the runner, bundle, then publish in a checkout of its own and conclude, in that order", async () => {
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
      "checkout",
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

  it("checks out the head the label's event named, as the branch, with the base, committing as the App, once for the agent and once for publish, each a directory of its own", async () => {
    const s = setup(FIX_ORDINARY);
    await runJob(FIX_JOB, s.edges);

    const checkout = path.join(s.runDir, "checkout");
    const publishCheckout = path.join(s.runDir, "publish-checkout");
    const head = { repo: "owner/repo", branch: "agent/issue-7-a-thing", sha: HEAD, baseRef: "main", committer: "loop-app[bot]" };
    expect(s.checkouts).toEqual([
      { ...head, dir: checkout, token: "read-token-2" },
      { ...head, dir: publishCheckout, token: "push-token-4" },
    ]);
    expect(s.launched.find((launch) => launch.subcommand === "fix")?.cwd).toBe(checkout);
    for (const subcommand of ["fix:prepare", "fix:bundle"] as const) {
      expect(s.env(subcommand)["CHECKOUT"], subcommand).toBe(checkout);
    }
    for (const subcommand of ["fix:publish", "fix:conclude"] as const) {
      expect(s.env(subcommand)["CHECKOUT"], subcommand).toBe(publishCheckout);
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

    expect(s.events).toEqual(["write token", "fix:gate", "push token", "checkout", "fix:conclude"]);
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

    expect(s.events.slice(-5)).toEqual(["fix:bundle", "push token", "checkout", "fix:publish", "fix:conclude"]);
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
    expect(s.checkouts.at(-1)).toMatchObject({ dir: path.join(s.runDir, "publish-checkout"), token: "write-token-5" });
    expect(s.env("fix:conclude")).toMatchObject({ MINT_OUTCOME: "failure", GH_TOKEN: "write-token-5", LOOP_TOKEN: "write-token-5" });
    expect(s.env("fix:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  it("leaves publish's reason where conclude reads it where publish's checkout failed", async () => {
    const s = setup(FIX_ORDINARY);
    const checkout = s.edges.git.checkout;
    s.edges.git.checkout = async (options) => {
      if (options.dir.endsWith("publish-checkout")) throw new Error("fatal: the remote hung up");
      return checkout(options);
    };
    await runJob(FIX_JOB, s.edges);

    expect(s.events).not.toContain("fix:publish");
    expect(s.env("fix:conclude")).toMatchObject({ AGENT_RESULT: "success", PUBLISH_OUTCOME: "failure" });
    expect(fs.readFileSync(path.join(s.env("fix:conclude")["PUBLISH_DIR"]!, "failure_reason.txt"), "utf8")).toBe(
      "The pull request's head could not be checked out to publish the fix: fatal: the remote hung up",
    );
  });

  it("tells conclude publish was cancelled where publish's checkout ran past the publish job's time limit", async () => {
    const s = setup(FIX_ORDINARY, { minuteMs: 5 });
    const checkout = s.edges.git.checkout;
    s.edges.git.checkout = async (options) => {
      if (!options.dir.endsWith("publish-checkout")) return checkout(options);
      await hang(options.signal, 0);
      throw new Error("The operation was aborted");
    };
    const phases = await runJob(FIX_JOB, s.edges);

    expect(s.events).not.toContain("fix:publish");
    expect(phases).toContainEqual({ name: "checkout", outcome: "timed out" });
    expect(s.env("fix:conclude")).toMatchObject({ AGENT_RESULT: "success", PUBLISH_OUTCOME: "cancelled" });
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
  ])("ends %s, still bundles, publishes and concludes, and tells conclude it timed out", async (_name, canned, { checkoutHangs, ...options }) => {
    const s = setup(canned, { minuteMs: MINUTE_MS, ...options });
    if (checkoutHangs === true) {
      // The agent's checkout alone: publish's is a job of its own, which checks the head out again.
      const checkout = s.edges.git.checkout;
      s.edges.git.checkout = async (given) => {
        if (given.dir.endsWith("publish-checkout")) return checkout(given);
        await hang(given.signal, 0);
        throw new Error("The operation was aborted");
      };
    }
    const phases = await runJob({ ...FIX_JOB, variables: { ...FIX_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(phases.filter(({ outcome }) => outcome === "timed out")).toHaveLength(1);
    expect(s.events.slice(-5)).toEqual(["fix:bundle", "push token", "checkout", "fix:publish", "fix:conclude"]);
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

  /**
   * The App's login as the loop token's account (#589, #591): without it
   * `update-branch:publish` carries no `agent-merge` arm on to a clean
   * refresh, and the merge gate disarms every armed pull request it refreshed.
   */
  it("hands update-branch:publish the App's login as LOOP_LOGIN, the account an arm is read back by", async () => {
    const s = setup(UB_CLEAN);
    await runJob(UPDATE_BRANCH_JOB, s.edges);

    expect(s.env("update-branch:publish")["LOOP_LOGIN"]).toBe("loop-app[bot]");
    expect(s.env("update-branch:publish")["LOOP_LOGIN"]).toBe(s.env("update-branch:publish")["AGENT_LOOP_LOGINS"]);
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
    expect(s.asked).toHaveLength(6);
    for (const token of [...s.asked.map((kind, at) => `${kind}-token-${at + 1}`), AGENT.CLAUDE_CODE_OAUTH_TOKEN]) {
      expect(text).not.toContain(token);
    }
    expect(text).toContain(REDACTED);
  });

  it("redacts a token wherever a phase's outcome quotes it, in the summary and in what the worker logs", async () => {
    const s = setup({ ...ORDINARY, review: { files: { "failure_reason.txt": "GH_TOKEN read-token-3 was refused." }, exit: 1 } });
    const phases = await runJob(JOB, s.edges);

    expect(read(s.runDir)).not.toContain("read-token-3");
    expect(JSON.stringify(phases)).not.toContain("read-token-3");
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

  it.each<[string, unknown, string]>([
    ["lacks a field its own release requires", { ...JOB, version: "9.9.8", instance: undefined }, "job job-1 is from a dispatcher at 9.9.8, and this worker is at 9.9.9"],
    ["is malformed by this release's format", { ...JOB, version: "9.9.8", workflow: "deploy", pr: "seven" }, "job job-1 is from a dispatcher at 9.9.8, and this worker is at 9.9.9"],
    ["carries no id", { ...JOB, version: "9.9.8", id: undefined }, "the job is from a dispatcher at 9.9.8, and this worker is at 9.9.9"],
  ])("refuses a job from another release that %s as from another release, not as malformed (#601)", (_name, job, refusal) => {
    const d = door();
    const response = d.handle(request(job));

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ refusal });
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
    expect(JSON.parse(response.body)).toEqual({ refusal: "`workflow` is not one of `review`, `fix`, `update-branch`, `implement`, `implement-prd`, `follow-ups`, `merge`, `setup-check`" });
    expect(d.accepted).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["no", { ...JOB, instance: undefined }],
    ["an empty", { ...JOB, instance: "" }],
    ["a malformed", { ...JOB, instance: "dispatcher 1; rm" }],
    ["a non-string", { ...JOB, instance: 1 }],
  ])("refuses a job with %s dispatcher instance id, naming the field", (_name, job) => {
    const d = door();
    const response = d.handle(request(job));

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ refusal: "`instance` is not a dispatcher instance's id, up to 64 letters, digits, `-` and `_`" });
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

  it("queues an implement-prd job, and refuses one with no title, naming the field", () => {
    const d = door();
    const job = { ...IMPLEMENT_JOB, workflow: "implement-prd" };

    expect(d.handle(request(job)).status).toBe(202);
    expect(d.accepted).toEqual([job]);

    const malformed = d.handle(request({ ...job, title: "" }));
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ refusal: "`title` is not a non-empty string" });
    expect(d.accepted).toEqual([job]);
  });
});

const IMPLEMENT_JOB: ImplementJob = {
  workflow: "implement",
  id: "job-1",
  version: "9.9.9",
  instance: "dispatcher-1",
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
const RUN_URL = "https://github.com/apps/loop-app#job-job-1";

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

  it("hands each subcommand its job's token kind: write to the gate, read to prepare and the runner, none to bundle, push to publish and conclude", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.asked).toEqual(["write", "read", "read", "push"]);
    expect(tokensIn(s.env("implement:gate"))).toEqual(["write-token-1"]);
    // The agent's job's read token, which it fetches the rescue with (#270).
    expect(tokensIn(s.env("implement:prepare"))).toEqual(["read-token-2"]);
    expect(tokensIn(s.env("implement"))).toEqual(["read-token-3"]);
    expect(tokensIn(s.env("implement:bundle"))).toEqual([]);
    expect(s.env("implement:publish")).toMatchObject({ GH_TOKEN: "push-token-4", LOOP_TOKEN: "push-token-4", LOOP_TOKEN_SOURCE: "app" });
    expect(s.env("implement:conclude")).toMatchObject({ GH_TOKEN: "push-token-4", LOOP_TOKEN: "push-token-4", LOOP_TOKEN_SOURCE: "app" });
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

  it("checks the base out by name, once for the agent and once for publish, each a directory of its own", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    await runJob(IMPLEMENT_JOB, s.edges);

    const checkout = path.join(s.runDir, "checkout");
    const publishCheckout = path.join(s.runDir, "publish-checkout");
    const base = { repo: "owner/repo", branch: "main", sha: "main", baseRef: "main", committer: "loop-app[bot]" };
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
    const rescue = { RESCUE_BRANCH: "agent/rescue/issue-12" };
    expect(issueRescueBranch(12)).toBe(rescue.RESCUE_BRANCH);
    expect(s.env("implement:prepare")).toMatchObject({ GH_REPO: "owner/repo", BRANCH, BASE_REF: "main", BASE_SHA: BASE, ...rescue });
    expect(s.env("implement")).toMatchObject({
      ...AGENT,
      ...issue,
      ISSUE_TITLE: "Add a thing",
      BRANCH,
      BASE_REF: "main",
      AGENT_MODEL: "a-model",
      AGENT_MODEL_IMPLEMENT: "a-build-model",
      AGENT_LOOP_LOGINS: "loop-app[bot]",
      ...rescue,
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
      ...rescue,
    });
    expect(s.env("implement:conclude")).toMatchObject({
      ...issue,
      RUN_URL,
      BASE_REF: "main",
      BRANCH,
      BASE_SHA: BASE,
      CHECKOUT: s.env("implement:publish")["CHECKOUT"],
      ...rescue,
    });
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

    // The publish job's checkout runs wherever the gate claimed the run, as on Actions.
    expect(s.events).toEqual(["write token", "implement:gate", "push token", "checkout", "implement:conclude"]);
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
    expect(s.events.slice(-3)).toEqual(["push token", "checkout", "implement:conclude"]);
    expect(s.checkouts).toHaveLength(2);
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "failure", MINT_OUTCOME: "success", DOWNLOAD_OUTCOME: "success" });
    expect(s.env("implement:conclude")).not.toHaveProperty("PUBLISH_OUTCOME");
  });

  /** #270: as the bundle step's `always()`, so a stopped run's commits reach conclude's rescue. */
  it("still bundles where the runner failed, and hands conclude the bundle, the rescue branch and the push token", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, implement: { exit: 1 } });
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.events.slice(-5)).toEqual(["implement", "implement:bundle", "push token", "checkout", "implement:conclude"]);
    expect(s.env("implement:conclude")).toMatchObject({
      AGENT_RESULT: "failure",
      BUNDLE_DIR: s.env("implement:bundle")["OUTPUT_DIR"],
      RESCUE_BRANCH: "agent/rescue/issue-12",
      LOOP_TOKEN: "push-token-4",
      CHECKOUT: path.join(s.runDir, "publish-checkout"),
    });
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

  it("ends a runner still running at AGENT_TIMEOUT_MINUTES, still bundles, publishes nothing, and tells conclude it timed out", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, implement: { hangs: true } }, { minuteMs: 5 });
    await runJob({ ...IMPLEMENT_JOB, variables: { ...IMPLEMENT_JOB.variables, AGENT_TIMEOUT_MINUTES: "2" } }, s.edges);

    expect(s.events).toContain("implement:bundle");
    expect(s.events).not.toContain("implement:publish");
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "cancelled", TIMED_OUT: "true", TIMEOUT_MINUTES: "2" });
  });

  /** #270: the agent's limit has fired by then, so the bundle has `BUNDLE_MINUTES` of its own, as `fix:bundle` does. */
  it("bundles under a limit of its own after a timed-out runner, which the agent's having run out does not abort", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, implement: { hangs: true } }, { minuteMs: 5 });
    await runJob(IMPLEMENT_JOB, s.edges);

    const signals = Object.fromEntries(s.launched.map(({ subcommand, signal }) => [subcommand, signal.aborted]));
    expect(signals).toMatchObject({ implement: true, "implement:bundle": false, "implement:conclude": false });
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "cancelled", TIMED_OUT: "true", BUNDLE_DIR: s.env("implement:bundle")["OUTPUT_DIR"] });
  });

  /**
   * #270: a bundle step ended at its limit writes nothing, so conclude is
   * told how it ended, as the step's outcome on Actions, rather than reading
   * the missing bundle as no commits.
   */
  it.each([
    ["stopped at its limit", { hangs: true }, "cancelled"],
    ["failed", { exit: 1 }, "failure"],
    ["succeeded", {}, "success"],
  ] as const)("tells conclude the bundle step's outcome where it %s", async (_name, bundle, outcome) => {
    const s = setup({ ...IMPLEMENT_ORDINARY, "implement:bundle": bundle }, { minuteMs: 5 });
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.env("implement:conclude")).toMatchObject({ BUNDLE_OUTCOME: outcome });
  });

  it("hands conclude no loop token, so it rescues nothing, where the push token was refused", async () => {
    const s = setup({ ...IMPLEMENT_ORDINARY, implement: { exit: 1 } }, { refused: [4] });
    await runJob(IMPLEMENT_JOB, s.edges);

    expect(s.env("implement:conclude")).toMatchObject({ MINT_OUTCOME: "failure", GH_TOKEN: "write-token-5" });
    expect(s.env("implement:conclude")).not.toHaveProperty("LOOP_TOKEN");
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

const PRD_JOB: ImplementPrdJob = { ...IMPLEMENT_JOB, workflow: "implement-prd", title: "Build the chain" };
const PRD_BRANCH = "agent/prd-12-build-the-chain";
const PRD_TIP = "d".repeat(40);
/** The tip the catch-up left the PRD branch at: its merge of the base. */
const CAUGHT_UP = "9".repeat(40);
const PRD_RESCUE = "agent/rescue/prd-12";

/** What `implement-prd:gate` writes where it claims the run and decides `decision`. */
const prdGate = (decision: "build" | "open-only" | "finishing"): Canned => ({
  files: {
    "gate.json": {
      proceed: "true",
      decision,
      prdBranch: PRD_BRANCH,
      prdBranchExists: true,
      prdTip: PRD_TIP,
      prdPr: 30,
      landed: decision === "finishing" ? 3 : 1,
      total: 3,
      ...(decision === "build" ? { slice: { number: 21, position: 2, title: "Second slice" } } : {}),
    },
    "prd-issue.json": { subIssues: { nodes: [] } },
  },
});

/** The files each implement-prd subcommand writes on a run that builds a slice and pushes it. */
const PRD_BUILD: Readonly<Partial<Record<Subcommand, Canned>>> = {
  "implement-prd:gate": prdGate("build"),
  "implement-prd:catch-up": { files: { "catch-up.json": { parked: false, merged: CAUGHT_UP, head: CAUGHT_UP } } },
  "implement-prd:bundle": { files: { "branch.bundle": "the agent's commits" } },
  "implement-prd:publish": { files: { "published.json": { pushed: true, head: "f".repeat(40), pr: 30, requested: true, handedOver: false } } },
};

/**
 * An implement-prd job, run as `implement-prd.yml` runs one (spec §7): the
 * gate job; the catch-up job and the agent's job on a build; and the publish
 * job, with publish under its step's `if:` and conclude always, each under
 * its job's and step's `if:` rather than in order alone.
 */
describe("the worker's implement-prd job, on a build", () => {
  it("runs the gate, the catch-up in a checkout of its own, the agent's job, bundle, then publish in a third checkout and conclude, in that order", async () => {
    const s = setup(PRD_BUILD);
    await runJob({ ...PRD_JOB, variables: { ...PRD_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).toEqual([
      "write token",
      "implement-prd:gate",
      "push token",
      "checkout",
      "implement-prd:catch-up",
      "read token",
      "checkout",
      "implement-prd:prepare",
      "sandbox",
      "read token",
      "implement-prd",
      "implement-prd:bundle",
      "push token",
      "checkout",
      "implement-prd:publish",
      "implement-prd:conclude",
    ]);
  });

  it("hands each subcommand its job's token kind: write to the gate, push to the catch-up, read to prepare and alone to the runner, none to bundle, push to publish and conclude", async () => {
    const s = setup(PRD_BUILD);
    await runJob(PRD_JOB, s.edges);

    expect(s.asked).toEqual(["write", "push", "read", "read", "push"]);
    expect(tokensIn(s.env("implement-prd:gate"))).toEqual(["write-token-1"]);
    expect(s.env("implement-prd:catch-up")).toMatchObject({ GH_TOKEN: "push-token-2", LOOP_TOKEN: "push-token-2", LOOP_TOKEN_SOURCE: "app" });
    expect(tokensIn(s.env("implement-prd:prepare"))).toEqual(["read-token-3"]);
    expect(tokensIn(s.env("implement-prd"))).toEqual(["read-token-4"]);
    expect(tokensIn(s.env("implement-prd:bundle"))).toEqual([]);
    expect(s.env("implement-prd:publish")).toMatchObject({ GH_TOKEN: "push-token-5", LOOP_TOKEN: "push-token-5", LOOP_TOKEN_SOURCE: "app" });
    expect(s.env("implement-prd:conclude")).toMatchObject({ GH_TOKEN: "push-token-5", LOOP_TOKEN: "push-token-5", LOOP_TOKEN_SOURCE: "app" });
  });

  it("puts only the read token in the runner's environment, beside the agent's own", async () => {
    const s = setup(PRD_BUILD);
    await runJob(PRD_JOB, s.edges);

    const runner = s.env("implement-prd");
    expect(Object.entries(runner).filter(([name]) => name.endsWith("TOKEN")).sort()).toEqual([
      ["CLAUDE_CODE_OAUTH_TOKEN", AGENT.CLAUDE_CODE_OAUTH_TOKEN],
      ["GH_TOKEN", "read-token-4"],
    ]);
    expect(Object.values(runner).filter((value) => /write-token|push-token/.test(value))).toEqual([]);
  });

  it("checks the base out by name for the catch-up and the agent, and the tip the catch-up left, as the PRD branch, for publish, which the bundle needs, each a directory of its own", async () => {
    const s = setup(PRD_BUILD);
    await runJob(PRD_JOB, s.edges);

    const at = { repo: "owner/repo", baseRef: "main", committer: "loop-app[bot]" };
    const checkout = path.join(s.runDir, "checkout");
    const publishCheckout = path.join(s.runDir, "publish-checkout");
    expect(s.checkouts).toEqual([
      { ...at, dir: path.join(s.runDir, "catch-up-checkout"), branch: "main", sha: "main", token: "push-token-2" },
      { ...at, dir: checkout, branch: "main", sha: "main", token: "read-token-3" },
      { ...at, dir: publishCheckout, branch: PRD_BRANCH, sha: CAUGHT_UP, token: "push-token-5" },
    ]);
    expect(s.env("implement-prd:catch-up")["CHECKOUT"]).toBe(path.join(s.runDir, "catch-up-checkout"));
    expect(s.launched.find((launch) => launch.subcommand === "implement-prd")?.cwd).toBe(checkout);
    expect(s.env("implement-prd:prepare")["CHECKOUT"]).toBe(checkout);
    expect(s.env("implement-prd:bundle")["CHECKOUT"]).toBe(checkout);
    expect(s.env("implement-prd:publish")["CHECKOUT"]).toBe(publishCheckout);
    expect(s.env("implement-prd:conclude")["CHECKOUT"]).toBe(publishCheckout);
  });

  it("hands each subcommand the inputs implement-prd.yml hands it, with the gate's and the catch-up's facts as their jobs' outputs", async () => {
    const s = setup(PRD_BUILD);
    await runJob({ ...PRD_JOB, variables: { ...PRD_JOB.variables, AGENT_MODEL_IMPLEMENT_PRD: "a-chain-model" } }, s.edges);

    const parent = { GH_REPO: "owner/repo", ISSUE_NUMBER: "12" };
    const gateDir = s.env("implement-prd:gate")["OUTPUT_DIR"];
    expect(s.env("implement-prd:gate")).toMatchObject({ ...parent, ISSUE_TITLE: "Build the chain", ISSUE_STATE: "open", BASE_REF: "main", RUN_URL });
    expect(s.env("implement-prd:catch-up")).toMatchObject({ ...parent, BASE_REF: "main", PRD_BRANCH, PRD_TIP, PRD_PR: "30", SUB: "21" });
    expect(s.env("implement-prd:prepare")).toMatchObject({ PRD_BRANCH, PRD_TIP, BASE_SHA: CAUGHT_UP, SUB: "21", RESCUE_BRANCH: PRD_RESCUE });
    expect(s.env("implement-prd")).toMatchObject({
      ...AGENT,
      ...parent,
      ISSUE_TITLE: "Build the chain",
      SUB_NUMBER: "21",
      SUB_TITLE: "Second slice",
      BRANCH: PRD_BRANCH,
      BASE_REF: "main",
      RESCUE_BRANCH: PRD_RESCUE,
      AGENT_MODEL: "a-model",
      AGENT_MODEL_IMPLEMENT_PRD: "a-chain-model",
      AGENT_LOOP_LOGINS: "loop-app[bot]",
    });
    expect(s.env("implement-prd:bundle")).toMatchObject({ PRD_BRANCH, BASE_SHA: CAUGHT_UP });
    expect(s.env("implement-prd:publish")).toMatchObject({
      ...parent,
      ISSUE_TITLE: "Build the chain",
      BASE_REF: "main",
      RUN_URL,
      PRD_BRANCH,
      PRD_TIP,
      BUILD: "true",
      FINISHING: "false",
      PRD_PR: "30",
      LANDED: "1",
      BASE_SHA: CAUGHT_UP,
      SUB: "21",
      RESCUE_BRANCH: PRD_RESCUE,
      GATE_DIR: gateDir,
      BUNDLE_DIR: s.env("implement-prd:bundle")["OUTPUT_DIR"],
    });
  });

  it("tells conclude how each job and step ended, pointed at each producer's directory", async () => {
    const s = setup(PRD_BUILD);
    await runJob(PRD_JOB, s.edges);

    const out = (subcommand: Subcommand): string | undefined => s.env(subcommand)["OUTPUT_DIR"];
    expect(s.env("implement-prd:conclude")).toMatchObject({
      ISSUE_NUMBER: "12",
      RUN_URL,
      RESCUE_BRANCH: PRD_RESCUE,
      REFUSED: "false",
      BUILD: "true",
      FINISHING: "false",
      PRD_BRANCH,
      PRD_PR: "30",
      SUB: "21",
      BASE_SHA: CAUGHT_UP,
      MERGED: CAUGHT_UP,
      GATE_RESULT: "success",
      CATCH_UP_RESULT: "success",
      AGENT_RESULT: "success",
      TIMED_OUT: "false",
      TIMEOUT_MINUTES: String(DEFAULT_FIX_MINUTES),
      MINT_OUTCOME: "success",
      DOWNLOAD_OUTCOME: "success",
      PUBLISH_OUTCOME: "success",
      GATE_DIR: out("implement-prd:gate"),
      CATCH_UP_DIR: out("implement-prd:catch-up"),
      PREPARE_DIR: out("implement-prd:prepare"),
      IMPLEMENT_PRD_DIR: out("implement-prd"),
      BUNDLE_DIR: out("implement-prd:bundle"),
      PUBLISH_DIR: out("implement-prd:publish"),
    });
    expect(s.env("implement-prd:conclude")).not.toHaveProperty("GATE_REASON");
  });

  it("holds the gate and the catch-up to their jobs' 10 minutes each, and publish and conclude to the publish job's 15", () => {
    expect(IMPLEMENT_PRD_GATE_MINUTES).toBe(10);
    expect(CATCH_UP_MINUTES).toBe(10);
    expect(IMPLEMENT_PRD_POSTING_MINUTES).toBe(15);
  });
});

/**
 * Each way an implement-prd run ends early, as `implement-prd.yml`'s `if:`s
 * end it: which phases ran, and how many tokens were asked for.
 */
describe("the worker's implement-prd job, where it ends early", () => {
  it("runs nothing after a refusal and asks for no other token, since the gate said it and took the label off", async () => {
    const s = setup({ ...PRD_BUILD, "implement-prd:gate": { files: { "gate.json": { proceed: "false" }, "write_log.jsonl": "{}" } } });
    const phases = await runJob(PRD_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement-prd:gate"]);
    expect(s.asked).toEqual(["write"]);
    expect(s.checkouts).toEqual([]);
    expect(phases.at(-1)).toEqual({ name: "implement-prd:gate", outcome: "refused or deferred: the run ends here, as no job after the gate runs then" });
  });

  it("runs nothing after deferring an issue with no sub-issues to implement, asks for no other token, and writes nothing", async () => {
    // A deferral is the gate's `proceed: false` with no write: it leaves no write log.
    const s = setup({ ...PRD_BUILD, "implement-prd:gate": { files: { "gate.json": { proceed: "false" } } } });
    const phases = await runJob(PRD_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement-prd:gate"]);
    expect(s.asked).toEqual(["write"]);
    expect(s.launched.map(({ subcommand }) => subcommand)).toEqual(["implement-prd:gate"]);
    expect(s.checkouts).toEqual([]);
    expect(s.sandboxed).toEqual([]);
    expect(fs.readdirSync(s.env("implement-prd:gate")["OUTPUT_DIR"]!)).toEqual(["gate.json"]);
    expect(phases.map(({ name }) => name)).toEqual(["write token", "implement-prd:gate", "implement-prd:gate"]);
  });

  it("runs no catch-up and no agent's job where the gate decided nothing, makes no checkout, and concludes undecided", async () => {
    const s = setup({ ...PRD_BUILD, "implement-prd:gate": { exit: 1, files: { "failure_reason.txt": "Couldn't read the PRD's sub-issues." } } });
    await runJob(PRD_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement-prd:gate", "push token", "implement-prd:conclude"]);
    expect(s.asked).toEqual(["write", "push"]);
    expect(s.checkouts).toEqual([]);
    expect(s.env("implement-prd:conclude")).toMatchObject({
      GH_TOKEN: "push-token-2",
      GATE_RESULT: "failure",
      GATE_REASON: "Couldn't read the PRD's sub-issues.",
      CATCH_UP_RESULT: "skipped",
      AGENT_RESULT: "skipped",
      MINT_OUTCOME: "success",
      DOWNLOAD_OUTCOME: "skipped",
      PUBLISH_OUTCOME: "skipped",
    });
    for (const name of ["REFUSED", "BUILD", "FINISHING"]) expect(s.env("implement-prd:conclude")).not.toHaveProperty(name);
  });

  it("runs no catch-up where the gate failed after claiming a build, and hands conclude its reason", async () => {
    const claimed = prdGate("build");
    const s = setup({ ...PRD_BUILD, "implement-prd:gate": { exit: 1, files: { ...claimed.files, "failure_reason.txt": "Couldn't add `agent:implement`." } } });
    await runJob(PRD_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement-prd:gate", "push token", "checkout", "implement-prd:conclude"]);
    expect(s.asked).toEqual(["write", "push"]);
    expect(s.env("implement-prd:conclude")).toMatchObject({
      REFUSED: "false",
      BUILD: "true",
      GATE_RESULT: "failure",
      GATE_REASON: "Couldn't add `agent:implement`.",
      CATCH_UP_RESULT: "skipped",
      AGENT_RESULT: "skipped",
      PUBLISH_OUTCOME: "skipped",
    });
  });

  it("runs no agent's job and publishes nothing where the catch-up parked the chain, and tells conclude the publish was skipped", async () => {
    const s = setup({ ...PRD_BUILD, "implement-prd:catch-up": { files: { "catch-up.json": { parked: true }, "write_log.jsonl": "{}" } } });
    await runJob(PRD_JOB, s.edges);

    expect(s.events).toEqual([
      "write token",
      "implement-prd:gate",
      "push token",
      "checkout",
      "implement-prd:catch-up",
      "push token",
      "checkout",
      "implement-prd:conclude",
    ]);
    expect(s.asked).toEqual(["write", "push", "push"]);
    expect(s.sandboxed).toEqual([]);
    expect(s.env("implement-prd:conclude")).toMatchObject({
      BUILD: "true",
      GATE_RESULT: "success",
      CATCH_UP_RESULT: "success",
      AGENT_RESULT: "skipped",
      MINT_OUTCOME: "success",
      PUBLISH_OUTCOME: "skipped",
    });
    expect(s.env("implement-prd:conclude")).not.toHaveProperty("BASE_SHA");
  });

  it("runs no agent's job and publishes nothing where the catch-up failed, and leaves its reason where conclude reads it", async () => {
    const s = setup({ ...PRD_BUILD, "implement-prd:catch-up": { exit: 1, files: { "failure_reason.txt": "Couldn't push the merge." } } });
    await runJob(PRD_JOB, s.edges);

    expect(s.events).toEqual([
      "write token",
      "implement-prd:gate",
      "push token",
      "checkout",
      "implement-prd:catch-up",
      "push token",
      "checkout",
      "implement-prd:conclude",
    ]);
    expect(s.asked).toEqual(["write", "push", "push"]);
    expect(s.env("implement-prd:conclude")).toMatchObject({ CATCH_UP_RESULT: "failure", AGENT_RESULT: "skipped", DOWNLOAD_OUTCOME: "failure", PUBLISH_OUTCOME: "skipped" });
    expect(fs.readFileSync(path.join(s.env("implement-prd:conclude")["CATCH_UP_DIR"]!, "failure_reason.txt"), "utf8")).toBe("Couldn't push the merge.");
  });

  it("starts no catch-up where its push token was refused, and says why where conclude reads the catch-up's reason", async () => {
    const s = setup(PRD_BUILD, { refused: [2] });
    await runJob(PRD_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement-prd:gate", "push token", "push token", "checkout", "implement-prd:conclude"]);
    expect(s.asked).toEqual(["write", "push", "push"]);
    expect(s.env("implement-prd:conclude")).toMatchObject({ CATCH_UP_RESULT: "failure", AGENT_RESULT: "skipped" });
    expect(fs.readFileSync(path.join(s.env("implement-prd:conclude")["CATCH_UP_DIR"]!, "failure_reason.txt"), "utf8")).toMatch(
      /^The service's dispatcher granted no token to bring the PRD branch up to date with/,
    );
  });

  it.each<[string, Readonly<Partial<Record<Subcommand, Canned>>>]>([
    ["the runner", { ...PRD_BUILD, "implement-prd": { exit: 1, files: { "failure_reason.txt": "The sub-issue no longer matches the code." } } }],
    ["bundle", { ...PRD_BUILD, "implement-prd:bundle": { exit: 1, files: { "failure_reason.txt": "The bundle could not be written." } } }],
  ])("still bundles, publishes nothing and concludes with push for the rescue, where %s failed", async (_name, canned) => {
    const s = setup(canned);
    await runJob(PRD_JOB, s.edges);

    expect(s.events.slice(-6)).toEqual(["read token", "implement-prd", "implement-prd:bundle", "push token", "checkout", "implement-prd:conclude"]);
    expect(s.asked).toEqual(["write", "push", "read", "read", "push"]);
    expect(s.env("implement-prd:conclude")).toMatchObject({
      AGENT_RESULT: "failure",
      MINT_OUTCOME: "success",
      DOWNLOAD_OUTCOME: "success",
      PUBLISH_OUTCOME: "skipped",
      LOOP_TOKEN: "push-token-5",
      BASE_SHA: CAUGHT_UP,
      BUNDLE_DIR: s.env("implement-prd:bundle")["OUTPUT_DIR"],
    });
  });

  it("ends a runner still running at AGENT_TIMEOUT_MINUTES, still bundles, publishes nothing, and tells conclude it timed out", async () => {
    const s = setup({ ...PRD_BUILD, "implement-prd": { hangs: true } }, { minuteMs: 5 });
    await runJob({ ...PRD_JOB, variables: { ...PRD_JOB.variables, AGENT_TIMEOUT_MINUTES: "2" } }, s.edges);

    expect(s.events).toContain("implement-prd:bundle");
    expect(s.events).not.toContain("implement-prd:publish");
    expect(s.asked).toEqual(["write", "push", "read", "read", "push"]);
    expect(s.env("implement-prd:conclude")).toMatchObject({ AGENT_RESULT: "cancelled", TIMED_OUT: "true", TIMEOUT_MINUTES: "2", PUBLISH_OUTCOME: "skipped" });
  });

  it("starts no runner where the setup failed, and gives conclude the setup's reason as the runner's", async () => {
    const s = setup(PRD_BUILD, { setupRun: { exit: 2, output: "npm ERR! missing script\n" } });
    await runJob({ ...PRD_JOB, variables: { ...PRD_JOB.variables, AGENT_SETUP: "npm ci" } }, s.edges);

    expect(s.events).not.toContain("implement-prd");
    expect(s.events).not.toContain("implement-prd:publish");
    expect(fs.readFileSync(path.join(s.env("implement-prd:conclude")["IMPLEMENT_PRD_DIR"]!, "failure_reason.txt"), "utf8")).toMatch(
      /^The repository's setup \(`AGENT_SETUP`\) exited with status 2\./,
    );
  });

  it.each<["open-only" | "finishing", string]>([
    ["open-only", "false"],
    ["finishing", "true"],
  ])("runs no catch-up and no agent's job on a run that is %s, and publishes in a checkout of the base, by name", async (decision, finishing) => {
    const s = setup({ ...PRD_BUILD, "implement-prd:gate": prdGate(decision) });
    await runJob(PRD_JOB, s.edges);

    expect(s.events).toEqual(["write token", "implement-prd:gate", "push token", "checkout", "implement-prd:publish", "implement-prd:conclude"]);
    expect(s.asked).toEqual(["write", "push"]);
    expect(s.checkouts).toEqual([
      { dir: path.join(s.runDir, "publish-checkout"), repo: "owner/repo", branch: "main", sha: "main", baseRef: "main", token: "push-token-2", committer: "loop-app[bot]" },
    ]);
    expect(s.env("implement-prd:publish")).toMatchObject({ BUILD: "false", FINISHING: finishing, PRD_PR: "30", LANDED: decision === "finishing" ? "3" : "1" });
    expect(s.env("implement-prd:publish")).not.toHaveProperty("BASE_SHA");
    expect(s.env("implement-prd:publish")).not.toHaveProperty("SUB");
    expect(s.env("implement-prd:conclude")).toMatchObject({
      REFUSED: "false",
      BUILD: "false",
      FINISHING: finishing,
      GATE_RESULT: "success",
      CATCH_UP_RESULT: "skipped",
      AGENT_RESULT: "skipped",
      DOWNLOAD_OUTCOME: "skipped",
      PUBLISH_OUTCOME: "success",
    });
  });

  it("publishes nothing where the push token was refused, and concludes with a write token and no loop token, told the mint failed", async () => {
    const s = setup(PRD_BUILD, { refused: [5] });
    await runJob(PRD_JOB, s.edges);

    expect(s.events).not.toContain("implement-prd:publish");
    expect(s.asked).toEqual(["write", "push", "read", "read", "push", "write"]);
    expect(s.checkouts.at(-1)).toMatchObject({ dir: path.join(s.runDir, "publish-checkout"), token: "write-token-6" });
    expect(s.env("implement-prd:conclude")).toMatchObject({ GH_TOKEN: "write-token-6", MINT_OUTCOME: "failure", PUBLISH_OUTCOME: "skipped" });
    expect(s.env("implement-prd:conclude")).not.toHaveProperty("LOOP_TOKEN");
    expect(s.env("implement-prd:conclude")).not.toHaveProperty("LOOP_TOKEN_SOURCE");
  });

  it("leaves publish's reason where conclude reads it where publish's checkout failed", async () => {
    const s = setup(PRD_BUILD);
    const checkout = s.edges.git.checkout;
    s.edges.git.checkout = async (options) => {
      if (options.dir.endsWith("publish-checkout")) throw new Error("fatal: unable to access");
      return checkout(options);
    };
    await runJob(PRD_JOB, s.edges);

    expect(s.events).not.toContain("implement-prd:publish");
    expect(s.env("implement-prd:conclude")).toMatchObject({ PUBLISH_OUTCOME: "failure" });
    expect(fs.readFileSync(path.join(s.env("implement-prd:conclude")["PUBLISH_DIR"]!, "failure_reason.txt"), "utf8")).toBe(
      `\`${PRD_BRANCH}\` could not be checked out to publish with: fatal: unable to access`,
    );
  });

  it("logs why the run ended where nothing can write its ending", async () => {
    const s = setup({ ...PRD_BUILD, "implement-prd": { exit: 1 } }, { refused: [5, 6] });
    const phases = await runJob(PRD_JOB, s.edges);

    expect(s.events).not.toContain("implement-prd:conclude");
    expect(phases.at(-1)).toEqual({
      name: "implement-prd:conclude",
      outcome:
        "not run: the dispatcher granted no token to write the ending with, and the run had ended so: the gate's result was success, the catch-up's success, and the agent's failure",
    });
  });

  it("redacts every token it held in the run's summary", async () => {
    const s = setup(PRD_BUILD);
    await runJob(PRD_JOB, s.edges);

    const summary = fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8");
    expect(summary).not.toMatch(/(write|read|push)-token-\d/);
    expect(summary).not.toContain(AGENT.CLAUDE_CODE_OAUTH_TOKEN);
  });
});

const FOLLOW_UPS_JOB: FollowUpsJob = {
  workflow: "follow-ups",
  id: "job-1",
  version: "9.9.9",
  instance: "dispatcher-1",
  deadline: "2026-10-11T14:00:00.000Z",
  repo: "owner/repo",
  pr: 7,
  appLogin: "loop-app[bot]",
  variables: JOB.variables,
};

/**
 * A follow-ups job, run as `follow-ups.yml` runs its one job (spec §11):
 * `follow-ups:file`, then `follow-ups:conclude` however it ended, told how.
 * No checkout, no agent and no setup.
 */
describe("the worker's follow-ups job", () => {
  it("runs file, then conclude, with one write token, and checks nothing out, runs no setup and no agent", async () => {
    const s = setup({});
    await runJob(FOLLOW_UPS_JOB, s.edges);

    expect(s.events).toEqual(["write token", "follow-ups:file", "follow-ups:conclude"]);
    expect(s.checkouts).toEqual([]);
    expect(s.sandboxed).toEqual([]);
    expect(s.launched.every((launch) => launch.cwd === s.runDir)).toBe(true);
  });

  it("hands each command the inputs follow-ups.yml hands it, with the App as the loop's account", async () => {
    const s = setup({});
    await runJob(FOLLOW_UPS_JOB, s.edges);

    expect(s.env("follow-ups:file")).toMatchObject({ GH_REPO: "owner/repo", GH_TOKEN: "write-token-1", PR_NUMBER: "7", AGENT_LOOP_LOGINS: "loop-app[bot]" });
    expect(s.env("follow-ups:conclude")).toEqual({
      ...HOST,
      GH_REPO: "owner/repo",
      GH_TOKEN: "write-token-1",
      PR_NUMBER: "7",
      RUN_URL,
      JOB_STATUS: "success",
      TIMED_OUT: "false",
      TIMEOUT_MINUTES: String(FOLLOW_UPS_MINUTES),
      FILE_DIR: s.env("follow-ups:file")["OUTPUT_DIR"],
      OUTPUT_DIR: s.env("follow-ups:conclude")["OUTPUT_DIR"],
    });
    for (const subcommand of ["follow-ups:file", "follow-ups:conclude"] as const) {
      for (const name of Object.keys(s.env(subcommand))) expect([...Object.keys(declared(subcommand)), ...Object.keys(HOST)], name).toContain(name);
    }
  });

  it("concludes a file that failed, told it failed, pointed at the reason it left", async () => {
    const s = setup({ "follow-ups:file": { exit: 1, files: { "failure_reason.txt": "Couldn't file \"A thing\"." } } });
    await runJob(FOLLOW_UPS_JOB, s.edges);

    expect(s.env("follow-ups:conclude")).toMatchObject({ JOB_STATUS: "failure", TIMED_OUT: "false" });
    expect(fs.readFileSync(path.join(s.env("follow-ups:conclude")["FILE_DIR"]!, "failure_reason.txt"), "utf8")).toBe("Couldn't file \"A thing\".");
  });

  it("ends a file still running at follow-ups.yml's time limit, and concludes it as a timeout", async () => {
    const s = setup({ "follow-ups:file": { hangs: true } }, { minuteMs: 5 });
    await runJob(FOLLOW_UPS_JOB, s.edges);

    expect(s.events.at(-1)).toBe("follow-ups:conclude");
    expect(s.env("follow-ups:conclude")).toMatchObject({ JOB_STATUS: "cancelled", TIMED_OUT: "true", TIMEOUT_MINUTES: "10" });
  });

  it("logs why nothing ran where no token was granted, since nothing can say so on the pull request", async () => {
    const s = setup({}, { refused: [1] });
    const phases = await runJob(FOLLOW_UPS_JOB, s.edges);

    expect(s.launched).toEqual([]);
    expect(phases.at(-1)).toEqual({
      name: "follow-ups:file",
      outcome: "not run: the dispatcher granted no token to file with, so neither it nor follow-ups:conclude ran, and nothing was written",
    });
  });

  it("queues a follow-ups job at the door, and refuses one with no pull request, naming the field", () => {
    const accepted: Job[] = [];
    const handle = jobDoor({ secret: "s", version: "9.9.9", accept: (job) => accepted.push(job) });
    const send = (job: unknown) => {
      const body = Buffer.from(JSON.stringify(job));
      return handle({ headers: { [SIGNATURE_HEADER]: sign("s", body) }, body });
    };

    expect(send(FOLLOW_UPS_JOB).status).toBe(202);
    expect(accepted).toEqual([FOLLOW_UPS_JOB]);
    const malformed = send({ ...FOLLOW_UPS_JOB, pr: 0 });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ refusal: "`pr` is not a positive integer" });
  });
});

const SETUP_CHECK_JOB: SetupCheckJob = {
  workflow: "setup-check",
  id: "job-1",
  version: "9.9.9",
  instance: "dispatcher-1",
  deadline: "2026-10-11T14:00:00.000Z",
  repo: "owner/repo",
  issue: 12,
  title: "Check the setup",
  state: "open",
  baseRef: "main",
  appLogin: "loop-app[bot]",
  variables: { ...JOB.variables, AGENT_SETUP: "npm ci", AGENT_VERIFY: "npm test" },
};

/**
 * A setup check (#821), which no reusable runs: a `read` token, the checkout
 * of the default branch, `AGENT_SETUP` and then `AGENT_VERIFY` in the sandbox,
 * and `setup-check:report` with a `write` token, handed how each step ended.
 * No agent, so no runner.
 */
describe("the worker's setup-check job", () => {
  /** What the report was handed of the steps, and nothing of the host's. */
  const handed = (s: ReturnType<typeof setup>) => {
    const env = s.env("setup-check:report");
    return Object.fromEntries(Object.entries(env).filter(([name]) => /^(CHECKOUT|SETUP|VERIFY)/.test(name)));
  };

  it("checks out the default branch with a read token, runs AGENT_SETUP and then AGENT_VERIFY in the sandbox in the checkout, reports with a write token, and starts no agent", async () => {
    const s = setup({});
    const phases = await runJob(SETUP_CHECK_JOB, s.edges);

    expect(s.events).toEqual(["read token", "checkout", "sandbox", "sandbox", "write token", "setup-check:report"]);
    expect(s.asked).toEqual(["read", "write"]);
    expect(s.checkouts).toEqual([
      { dir: path.join(s.runDir, "checkout"), repo: "owner/repo", branch: "main", sha: "main", baseRef: "main", token: "read-token-1", committer: "loop-app[bot]" },
    ]);
    expect(s.sandboxed.map(({ variable, script, dir }) => ({ variable, script, dir }))).toEqual([
      { variable: "AGENT_SETUP", script: "npm ci", dir: path.join(s.runDir, "checkout") },
      { variable: "AGENT_VERIFY", script: "npm test", dir: path.join(s.runDir, "checkout") },
    ]);
    // No token in what either script is handed, and no runner started.
    const sandboxed = JSON.stringify(s.sandboxed);
    for (const token of ["read-token-1", "write-token-2", AGENT.CLAUDE_CODE_OAUTH_TOKEN]) expect(sandboxed).not.toContain(token);
    expect(s.launched.map(({ subcommand }) => subcommand)).toEqual(["setup-check:report"]);
    expect(s.launched.some(({ subcommand }) => subcommand in RUNNERS)).toBe(false);
    expect(phases).toContainEqual({ name: VERIFY_PHASE, outcome: "success" });
    expect(s.env("setup-check:report")).toEqual({
      ...HOST,
      OUTPUT_DIR: s.env("setup-check:report")["OUTPUT_DIR"],
      GH_REPO: "owner/repo",
      GH_TOKEN: "write-token-2",
      ISSUE_NUMBER: "12",
      BASE_REF: "main",
      RUN_URL,
      CHECKOUT: path.join(s.runDir, "checkout"),
      TIMEOUT_MINUTES: String(DEFAULT_FIX_MINUTES),
      CHECKOUT_RESULT: "passed",
      TOOLCHAIN_RESULT: "skipped",
      SETUP_RESULT: "passed",
      VERIFY_RESULT: "passed",
    });
  });

  it("reports a failed setup's exit code and the end of its output, and does not start verify", async () => {
    const s = setup({}, { sandboxRuns: { AGENT_SETUP: { exit: 2, output: "npm ERR! missing python3-venv\n" } } });
    await runJob(SETUP_CHECK_JOB, s.edges);

    expect(s.sandboxed.map(({ variable }) => variable)).toEqual(["AGENT_SETUP"]);
    expect(handed(s)).toEqual({
      CHECKOUT: path.join(s.runDir, "checkout"),
      CHECKOUT_RESULT: "passed",
      SETUP_RESULT: "failed",
      SETUP_EXIT: "2",
      SETUP_OUTPUT: "npm ERR! missing python3-venv",
      VERIFY_RESULT: "not-run",
    });
  });

  it("reports a failed verify's exit code and the end of its output", async () => {
    const s = setup({}, { sandboxRuns: { AGENT_VERIFY: { exit: 1, output: "1 test failed\n" } } });
    await runJob(SETUP_CHECK_JOB, s.edges);

    expect(handed(s)).toMatchObject({ SETUP_RESULT: "passed", VERIFY_RESULT: "failed", VERIFY_EXIT: "1", VERIFY_OUTPUT: "1 test failed" });
  });

  it("skips verify where AGENT_VERIFY is unset, and still runs verify where AGENT_SETUP is unset", async () => {
    const noVerify = setup({});
    await runJob({ ...SETUP_CHECK_JOB, variables: { ...SETUP_CHECK_JOB.variables, AGENT_VERIFY: "" } }, noVerify.edges);
    expect(noVerify.sandboxed.map(({ variable }) => variable)).toEqual(["AGENT_SETUP"]);
    expect(handed(noVerify)).toMatchObject({ SETUP_RESULT: "passed", VERIFY_RESULT: "unset" });

    const noSetup = setup({});
    await runJob({ ...SETUP_CHECK_JOB, variables: { ...SETUP_CHECK_JOB.variables, AGENT_SETUP: "" } }, noSetup.edges);
    expect(noSetup.sandboxed.map(({ variable }) => variable)).toEqual(["AGENT_VERIFY"]);
    expect(handed(noSetup)).toMatchObject({ SETUP_RESULT: "unset", VERIFY_RESULT: "passed" });
  });

  it("hands AGENT_VERIFY to the sandbox as the repository set it, `$(…)` and `;` and all, never evaluated", async () => {
    const script = "npm test -- $(cat suites.txt); echo `date` > ran.txt";
    const s = setup({});
    await runJob({ ...SETUP_CHECK_JOB, variables: { ...SETUP_CHECK_JOB.variables, AGENT_VERIFY: script } }, s.edges);

    expect(s.sandboxed[1]).toMatchObject({ variable: "AGENT_VERIFY", script });
    const summary = JSON.parse(fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8")) as { subcommands: { subcommand: string; env: unknown }[] };
    expect(summary.subcommands.find(({ subcommand }) => subcommand === VERIFY_PHASE)?.env).toEqual({ AGENT_VERIFY: script });
  });

  it("reports a checkout that failed, with its reason, runs neither script, and still reports", async () => {
    const s = setup({}, { checkoutFails: "remote: Repository not found." });
    await runJob(SETUP_CHECK_JOB, s.edges);

    expect(s.sandboxed).toEqual([]);
    expect(s.events.at(-1)).toBe("setup-check:report");
    expect(handed(s)).toEqual({
      CHECKOUT_RESULT: "failed",
      CHECKOUT_REASON: "`main` could not be checked out: remote: Repository not found.",
      SETUP_RESULT: "not-run",
      VERIFY_RESULT: "not-run",
    });
  });

  it("reports a checkout the dispatcher granted no read token for as failed, and still reports", async () => {
    const s = setup({}, { refused: [1] });
    await runJob(SETUP_CHECK_JOB, s.edges);

    expect(s.checkouts).toEqual([]);
    expect(handed(s)).toMatchObject({ CHECKOUT_RESULT: "failed", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" });
    expect(handed(s)["CHECKOUT_REASON"]).toMatch(/granted no token/);
  });

  it("ends a setup still running at the agent's job's time limit, and reports it timed out, with verify not run", async () => {
    const s = setup({}, { minuteMs: 5, sandboxRuns: { AGENT_SETUP: { hangs: true } } });
    await runJob(SETUP_CHECK_JOB, s.edges);

    expect(s.sandboxed[0]?.signal.aborted).toBe(true);
    expect(s.sandboxed).toHaveLength(1);
    expect(s.events.at(-1)).toBe("setup-check:report");
    expect(handed(s)).toMatchObject({ CHECKOUT_RESULT: "passed", SETUP_RESULT: "timed-out", VERIFY_RESULT: "not-run" });
    expect(s.env("setup-check:report")["TIMEOUT_MINUTES"]).toBe(String(DEFAULT_FIX_MINUTES));
  });

  it("reports a checkout that ran out of time as timed out", async () => {
    const s = setup({}, { minuteMs: 5, checkoutHangs: true });
    await runJob(SETUP_CHECK_JOB, s.edges);

    expect(handed(s)).toEqual({ CHECKOUT_RESULT: "timed-out", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" });
  });

  it("gives the report a time limit of its own, past the check's", async () => {
    const s = setup({ "setup-check:report": { hangs: true } }, { minuteMs: 5 });
    const phases = await runJob(SETUP_CHECK_JOB, s.edges);

    expect(SETUP_CHECK_REPORT_MINUTES).toBe(5);
    expect(phases).toContainEqual({ name: "setup-check:report", outcome: "timed out" });
  });

  it("logs why nothing was reported where no write token was granted, and leaves the label for the next scan", async () => {
    const s = setup({}, { refused: [2] });
    const phases = await runJob(SETUP_CHECK_JOB, s.edges);

    expect(s.launched).toEqual([]);
    expect(phases.at(-1)).toEqual({
      name: "setup-check:report",
      outcome: "not run: the dispatcher granted no token to report with, so nothing was written and the label stays on",
    });
  });

  it("hands the report only what it declares", async () => {
    const s = setup({});
    await runJob(SETUP_CHECK_JOB, s.edges);

    for (const name of Object.keys(s.env("setup-check:report"))) expect([...Object.keys(declared("setup-check:report")), ...Object.keys(HOST)], name).toContain(name);
  });
});

/**
 * The toolchain layer (#822): where the checkout has a `mise.toml` at its
 * root, `mise install` in the sandbox right before setup, into a git-ignored
 * folder in the checkout, and its `bin` directories first on every later
 * `PATH`. Through `runJob`, with the fakes above standing for the sandbox and
 * the checkout.
 */
describe("the toolchain, before the setup (#822)", () => {
  const MISE_TOML = { "mise.toml": '[tools]\npython = "3.12"\n' };
  const INSIDE = `${SANDBOX_WORKTREE}/${TOOLCHAIN_DIR}`;
  const BINS = [`${INSIDE}/installs/python/3.12/bin`, `${INSIDE}/installs/node/24/bin`];
  const WITH_SETUP = { ...IMPLEMENT_JOB, variables: { ...IMPLEMENT_JOB.variables, AGENT_SETUP: "npm ci" } };
  const phaseNames = (phases: readonly Phase[]): string[] => phases.map(({ name }) => name);

  it("runs mise install in the sandbox, in the checkout at the agent's path, with no token, before the setup, its data in the toolchain folder", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: MISE_TOML });
    const phases = await runJob(WITH_SETUP, s.edges);

    expect(s.events.slice(s.events.indexOf("implement:prepare"), s.events.indexOf("implement") + 1)).toEqual(["implement:prepare", "sandbox", "sandbox", "read token", "implement"]);
    expect(s.sandboxed.map(({ variable }) => variable)).toEqual([TOOLCHAIN_VARIABLE, "AGENT_SETUP"]);
    const [toolchain] = s.sandboxed;
    expect(toolchain).toMatchObject({
      variable: "AGENT_TOOLCHAIN",
      dir: path.join(s.runDir, "checkout"),
      at: SANDBOX_WORKTREE,
      path: AGENT.AGENT_SANDBOX_PATH,
      proxy: AGENT.AGENT_SANDBOX_PROXY,
      env: { MISE_DATA_DIR: INSIDE, MISE_TRUSTED_CONFIG_PATHS: SANDBOX_WORKTREE, MISE_YES: "1", NO_COLOR: "1" },
      log: path.join(s.runDir, "logs", "toolchain.log"),
    });
    expect(toolchain?.script).toMatch(/' install\n/);
    expect(toolchain?.script).toContain(`' bin-paths > "$MISE_DATA_DIR/${TOOLCHAIN_BIN_PATHS}"`);
    for (const token of ["write-token-1", "read-token-2", "read-token-3", AGENT.CLAUDE_CODE_OAUTH_TOKEN]) expect(JSON.stringify(toolchain)).not.toContain(token);
    const names = phaseNames(phases);
    expect(names.indexOf(TOOLCHAIN_PHASE)).toBeLessThan(names.indexOf(SETUP_PHASE));
    expect(phases).toContainEqual({ name: TOOLCHAIN_PHASE, outcome: "success" });
    const summary = JSON.parse(fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8")) as { subcommands: { subcommand: string; env: Record<string, string> }[] };
    expect(summary.subcommands.find(({ subcommand }) => subcommand === TOOLCHAIN_PHASE)?.env).toMatchObject({ MISE_DATA_DIR: INSIDE });
  });

  it("runs mise with colour off, so its error output reaches a failure reason with no escape codes", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: MISE_TOML });
    await runJob(WITH_SETUP, s.edges);

    expect(s.sandboxed[0]?.env).toMatchObject({ NO_COLOR: "1" });
  });

  it("is asked for by a .mise.toml too", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: { ".mise.toml": "[tools]\n" } });
    await runJob(WITH_SETUP, s.edges);

    expect(s.sandboxed.map(({ variable }) => variable)).toEqual([TOOLCHAIN_VARIABLE, "AGENT_SETUP"]);
  });

  it("is noted as skipped, with no sandbox started for it, where the checkout has no mise.toml, and the job runs as before", async () => {
    const s = setup(IMPLEMENT_ORDINARY);
    const phases = await runJob(WITH_SETUP, s.edges);

    expect(s.sandboxed.map(({ variable }) => variable)).toEqual(["AGENT_SETUP"]);
    expect(phases).toContainEqual({ name: TOOLCHAIN_PHASE, outcome: "skipped: the checkout has no mise.toml at its root" });
    expect(s.sandboxed[0]?.path).toBe(AGENT.AGENT_SANDBOX_PATH);
    expect(s.env("implement")["AGENT_SANDBOX_PATH"]).toBe(AGENT.AGENT_SANDBOX_PATH);
    expect(s.env("implement")["PATH"]).toBe(`/work/claude-code/bin:${HOST.PATH}`);
  });

  it.each<[string, Job, Readonly<Partial<Record<Subcommand, Canned>>>, Subcommand | undefined]>([
    ["fix", { ...FIX_JOB, variables: { ...FIX_JOB.variables, AGENT_SETUP: "npm ci" } }, FIX_ORDINARY, "fix"],
    ["update-branch", { ...UPDATE_BRANCH_JOB, variables: { ...UPDATE_BRANCH_JOB.variables, AGENT_SETUP: "npm ci" } }, UB_CONFLICTS, "update-branch"],
    ["implement-prd", { ...PRD_JOB, variables: { ...PRD_JOB.variables, AGENT_SETUP: "npm ci" } }, PRD_BUILD, "implement-prd"],
    ["setup-check", SETUP_CHECK_JOB, {}, undefined],
  ])("runs in the %s job too, right before the setup", async (_, job, canned, runner) => {
    const s = setup(canned, { checkoutFiles: MISE_TOML });
    await runJob(job, s.edges);

    expect(s.sandboxed.map(({ variable }) => variable).slice(0, 2)).toEqual([TOOLCHAIN_VARIABLE, "AGENT_SETUP"]);
    if (runner !== undefined) expect(s.events.indexOf(runner)).toBeGreaterThan(s.events.lastIndexOf("sandbox"));
  });

  it("puts the reported bin directories first on setup's PATH and the agent's, under bwrap, and drops any outside the toolchain folder", async () => {
    const reported = [...BINS, "/usr/local/evil/bin", "relative/bin", `${INSIDE}/../escaped/bin`, `${SANDBOX_WORKTREE}/other/bin`, ""];
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: MISE_TOML, toolchainBins: reported });
    await runJob(WITH_SETUP, s.edges);

    const kept = BINS.join(":");
    expect(s.sandboxed[1]?.path).toBe(`${kept}:${AGENT.AGENT_SANDBOX_PATH}`);
    expect(s.env("implement")["AGENT_SANDBOX_PATH"]).toBe(`/work/claude-code/bin:${kept}:/usr/bin`);
    // The runner itself runs on the host, where the sandbox's paths mean nothing.
    expect(s.env("implement")["PATH"]).toBe(`/work/claude-code/bin:${HOST.PATH}`);
  });

  it("keeps them off the runner's PATH under AGENT_SANDBOX=none, where the runner holds the tokens on the host, and notes that only setup and verify get them", async () => {
    const binOf = (checkout: string): string => `${checkout}/${TOOLCHAIN_DIR}/installs/python/3.12/bin`;
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: MISE_TOML, toolchainBins: (checkout) => [binOf(checkout), `${INSIDE}/x/bin`, "/opt/elsewhere/bin"] });
    const phases = await runJob(WITH_SETUP, { ...s.edges, agent: { ...AGENT, AGENT_SANDBOX: "none" } });

    const checkout = path.join(s.runDir, "checkout");
    const bin = binOf(checkout);
    expect(s.sandboxed[0]).toMatchObject({ at: checkout, env: { MISE_DATA_DIR: path.join(checkout, TOOLCHAIN_DIR), MISE_TRUSTED_CONFIG_PATHS: checkout } });
    expect(s.sandboxed[1]?.path).toBe(`${bin}:${AGENT.AGENT_SANDBOX_PATH}`);
    expect(s.env("implement")["PATH"]).toBe(`/work/claude-code/bin:${HOST.PATH}`);
    expect(s.env("implement")["PATH"]?.split(":").some((part) => part.includes(TOOLCHAIN_DIR))).toBe(false);
    expect(s.env("implement")["AGENT_SANDBOX_PATH"]).toBe(AGENT.AGENT_SANDBOX_PATH);
    expect(phases).toContainEqual({
      name: TOOLCHAIN_PHASE,
      outcome: "not on the agent's PATH: with AGENT_SANDBOX=none the agent runs on the host, so the toolchain reaches the setup and the verify command only",
    });
  });

  it.each(["bwrap", "none"])(
    "keeps the worker's own claude first under AGENT_SANDBOX=%s, ahead of a claude the toolchain installed",
    async (mode) => {
      const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: MISE_TOML, toolchainBins: (checkout) => [`${mode === "bwrap" ? SANDBOX_WORKTREE : checkout}/${TOOLCHAIN_DIR}/installs/node/24/bin`] });
      const sandbox = s.edges.sandbox;
      const edges = {
        ...s.edges,
        agent: { ...AGENT, AGENT_SANDBOX: mode },
        sandbox: async (run: SandboxRun) => {
          const code = await sandbox(run);
          // A `claude` the repository's toolchain put beside its node.
          if (run.variable === TOOLCHAIN_VARIABLE) fs.writeFileSync(path.join(run.dir, TOOLCHAIN_DIR, "installs", "node", "24", "bin", "claude"), "");
          return code;
        },
      };
      await runJob(WITH_SETUP, edges);

      const checkout = path.join(s.runDir, "checkout");
      const tools = `${mode === "bwrap" ? SANDBOX_WORKTREE : checkout}/${TOOLCHAIN_DIR}/installs/node/24/bin`;
      expect(fs.existsSync(path.join(checkout, TOOLCHAIN_DIR, "installs", "node", "24", "bin", "claude"))).toBe(true);
      for (const name of ["PATH", "AGENT_SANDBOX_PATH"]) {
        const parts = (s.env("implement")[name] ?? "").split(":");
        if (!parts.includes(tools)) continue;
        expect(parts[0]).toBe("/work/claude-code/bin");
        expect(parts.indexOf(tools)).toBeGreaterThan(parts.indexOf("/work/claude-code/bin"));
      }
      if (mode === "bwrap") expect(s.env("implement")["AGENT_SANDBOX_PATH"]?.split(":")).toContain(tools);
      expect(s.env("implement")["PATH"]?.split(":")[0]).toBe("/work/claude-code/bin");
    },
  );

  it("puts them first on the setup check's verify PATH too", async () => {
    const s = setup({}, { checkoutFiles: MISE_TOML, toolchainBins: BINS });
    await runJob(SETUP_CHECK_JOB, s.edges);

    expect(s.sandboxed.map(({ variable, path: sandboxPath }) => [variable, sandboxPath])).toEqual([
      [TOOLCHAIN_VARIABLE, AGENT.AGENT_SANDBOX_PATH],
      ["AGENT_SETUP", `${BINS.join(":")}:${AGENT.AGENT_SANDBOX_PATH}`],
      ["AGENT_VERIFY", `${BINS.join(":")}:${AGENT.AGENT_SANDBOX_PATH}`],
    ]);
  });

  it("ends the agent's job before the setup where the install fails, naming mise.toml and quoting the end of its output, redacted", async () => {
    const s = setup(IMPLEMENT_ORDINARY, {
      checkoutFiles: MISE_TOML,
      sandboxRuns: { AGENT_TOOLCHAIN: { exit: 1, output: `mise ERROR python@9.9 not found\nleaked ${AGENT.CLAUDE_CODE_OAUTH_TOKEN}\n` } },
    });
    const phases = await runJob(WITH_SETUP, s.edges);

    expect(s.sandboxed.map(({ variable }) => variable)).toEqual([TOOLCHAIN_VARIABLE]);
    expect(s.events).not.toContain("implement");
    expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: "not run: the toolchain mise.toml asks for was not installed" });
    const why = fs.readFileSync(path.join(s.env("implement:conclude")["IMPLEMENT_DIR"]!, "failure_reason.txt"), "utf8");
    expect(why).toMatch(/^The toolchain `mise\.toml` asks for \(`mise install`\) exited with status 1\. The end of its output:/);
    expect(why).toContain("mise ERROR python@9.9 not found");
    expect(why).toContain(`leaked ${REDACTED}`);
    expect(why).not.toContain(AGENT.CLAUDE_CODE_OAUTH_TOKEN);
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "failure" });
  });

  it("ends the agent's job before the setup where the install runs past the job's time limit", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { minuteMs: 5, checkoutFiles: MISE_TOML, sandboxRuns: { AGENT_TOOLCHAIN: { hangs: true } } });
    const phases = await runJob(WITH_SETUP, s.edges);

    expect(s.sandboxed.map(({ variable }) => variable)).toEqual([TOOLCHAIN_VARIABLE]);
    expect(s.sandboxed[0]?.signal.aborted).toBe(true);
    expect(s.events).not.toContain("implement");
    expect(phases).toContainEqual({ name: TOOLCHAIN_PHASE, outcome: "timed out" });
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "cancelled", TIMED_OUT: "true" });
  });

  it("starts no sandbox where the box has no mise, and says to re-run install-box.sh", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: MISE_TOML, noMise: true });
    await runJob(WITH_SETUP, s.edges);

    expect(s.sandboxed).toEqual([]);
    expect(s.events).not.toContain("implement");
    const why = fs.readFileSync(path.join(s.env("implement:conclude")["IMPLEMENT_DIR"]!, "failure_reason.txt"), "utf8");
    expect(why).toMatch(/^The toolchain `mise\.toml` asks for \(`mise install`\) could not be installed: `[^`]+` is missing from the agent box\. Re-run `install-box\.sh` on the agent box/);
  });

  it("makes git ignore the toolchain folder before mise runs, so a real checkout holding it shows nothing of it", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: MISE_TOML, gitCheckout: true, toolchainBins: BINS });
    const excludedAtStart: boolean[] = [];
    const sandbox = s.edges.sandbox;
    const edges = {
      ...s.edges,
      sandbox: async (run: SandboxRun) => {
        if (run.variable === TOOLCHAIN_VARIABLE) {
          const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: run.dir, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT });
          fs.mkdirSync(path.join(run.dir, TOOLCHAIN_DIR), { recursive: true });
          fs.writeFileSync(path.join(run.dir, TOOLCHAIN_DIR, "probe"), "");
          const after = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: run.dir, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT });
          excludedAtStart.push(status === after);
        }
        return sandbox(run);
      },
    };
    await runJob(WITH_SETUP, edges);

    expect(excludedAtStart).toEqual([true]);
    const checkout = path.join(s.runDir, "checkout");
    expect(fs.existsSync(path.join(checkout, TOOLCHAIN_DIR, "installs", "node", "24", "bin", "node"))).toBe(true);
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--ignored=no"], { cwd: checkout, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT });
    expect(status.split("\n").filter((line) => line.includes(TOOLCHAIN_DIR))).toEqual([]);
    expect(status).toContain("mise.toml");
  });

  it.each(["!/.agent-toolchain/", "!.*"])("refuses, as a failed install, a real checkout whose .gitignore holds %s, which the git exclude does not win against", async (line) => {
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: { ...MISE_TOML, ".gitignore": `${line}\n` }, gitCheckout: true, toolchainBins: BINS });
    const phases = await runJob(WITH_SETUP, s.edges);

    expect(s.sandboxed).toEqual([]);
    expect(s.events).not.toContain("implement");
    expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: "not run: the toolchain mise.toml asks for was not installed" });
    const reason = fs.readFileSync(path.join(s.env("implement:conclude")["IMPLEMENT_DIR"]!, "failure_reason.txt"), "utf8");
    expect(reason).toMatch(/^The toolchain `mise\.toml` asks for \(`mise install`\) was not installed: git does not ignore `\.agent-toolchain\/`/);
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "failure" });
  });

  it.each<[string, { readonly checkoutDirs?: readonly string[]; readonly checkoutFiles?: Readonly<Record<string, string>>; readonly gitCheckout?: boolean }, RegExp]>([
    ["the toolchain folder committed as a file", { checkoutFiles: { ...MISE_TOML, [TOOLCHAIN_DIR]: "a file\n" } }, /already has `\.agent-toolchain`/],
    ["bin-paths.txt committed as a directory", { checkoutDirs: [`${TOOLCHAIN_DIR}/${TOOLCHAIN_BIN_PATHS}`], checkoutFiles: MISE_TOML }, /already has `\.agent-toolchain`/],
    ["the toolchain folder committed as a directory", { checkoutDirs: [TOOLCHAIN_DIR], checkoutFiles: { ...MISE_TOML, [`${TOOLCHAIN_DIR}/x`]: "" } }, /already has `\.agent-toolchain`/],
    ["a preparation that throws (the git exclude a directory)", { checkoutDirs: [".git/info/exclude"], checkoutFiles: MISE_TOML }, /could not be prepared: .*EISDIR/],
  ])("refuses, as a failed install, a checkout with %s, starting no sandbox", async (_, checkout, why) => {
    const s = setup(IMPLEMENT_ORDINARY, checkout);
    const phases = await runJob(WITH_SETUP, s.edges);

    expect(s.sandboxed).toEqual([]);
    expect(s.events).not.toContain("implement");
    expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: "not run: the toolchain mise.toml asks for was not installed" });
    const reason = fs.readFileSync(path.join(s.env("implement:conclude")["IMPLEMENT_DIR"]!, "failure_reason.txt"), "utf8");
    expect(reason).toMatch(/^The toolchain `mise\.toml` asks for \(`mise install`\) /);
    expect(reason).toMatch(why);
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "failure" });
  });

  it("reports an error reading what mise wrote as a failed install, not an exception out of the job", async () => {
    const s = setup(IMPLEMENT_ORDINARY, { checkoutFiles: MISE_TOML, toolchainBins: BINS });
    const sandbox = s.edges.sandbox;
    const edges = {
      ...s.edges,
      sandbox: async (run: SandboxRun) => {
        const code = await sandbox(run);
        // The folder unreadable once mise is done.
        if (run.variable === TOOLCHAIN_VARIABLE) fs.chmodSync(path.join(run.dir, TOOLCHAIN_DIR, TOOLCHAIN_BIN_PATHS), 0);
        return code;
      },
    };
    const phases = await runJob(WITH_SETUP, edges);

    if (process.getuid?.() === 0) return; // root reads it regardless
    expect(s.events).not.toContain("implement");
    expect(phases).toContainEqual({ name: SETUP_PHASE, outcome: "not run: the toolchain mise.toml asks for was not installed" });
    expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "failure" });
  });

  describe("in the setup check's report", () => {
    const toolchainHanded = (s: ReturnType<typeof setup>) =>
      Object.fromEntries(Object.entries(s.env("setup-check:report")).filter(([name]) => /^(TOOLCHAIN|SETUP|VERIFY)_/.test(name)));

    it("hands the report a toolchain that passed", async () => {
      const s = setup({}, { checkoutFiles: MISE_TOML, toolchainBins: BINS });
      await runJob(SETUP_CHECK_JOB, s.edges);

      expect(toolchainHanded(s)).toEqual({ TOOLCHAIN_RESULT: "passed", SETUP_RESULT: "passed", VERIFY_RESULT: "passed" });
    });

    it("hands the report a tree's own toolchain folder as a toolchain that failed unstarted, and runs neither setup nor verify", async () => {
      const s = setup({}, { checkoutFiles: { ...MISE_TOML, [TOOLCHAIN_DIR]: "" } });
      await runJob(SETUP_CHECK_JOB, s.edges);

      expect(s.sandboxed).toEqual([]);
      expect(toolchainHanded(s)).toMatchObject({ TOOLCHAIN_RESULT: "failed", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" });
      expect(toolchainHanded(s)["TOOLCHAIN_OUTPUT"]).toContain("already has `.agent-toolchain`");
      expect(toolchainHanded(s)).not.toHaveProperty("TOOLCHAIN_EXIT");
    });

    it("hands the report a toolchain skipped for want of a mise.toml", async () => {
      const s = setup({});
      await runJob(SETUP_CHECK_JOB, s.edges);

      expect(toolchainHanded(s)).toEqual({ TOOLCHAIN_RESULT: "skipped", SETUP_RESULT: "passed", VERIFY_RESULT: "passed" });
    });

    it("hands the report a failed toolchain's exit code and output, and runs neither setup nor verify", async () => {
      const s = setup({}, { checkoutFiles: MISE_TOML, sandboxRuns: { AGENT_TOOLCHAIN: { exit: 1, output: "mise ERROR no such version\n" } } });
      const phases = await runJob(SETUP_CHECK_JOB, s.edges);

      expect(s.sandboxed.map(({ variable }) => variable)).toEqual([TOOLCHAIN_VARIABLE]);
      expect(toolchainHanded(s)).toEqual({
        TOOLCHAIN_RESULT: "failed",
        TOOLCHAIN_EXIT: "1",
        TOOLCHAIN_OUTPUT: "mise ERROR no such version",
        SETUP_RESULT: "not-run",
        VERIFY_RESULT: "not-run",
      });
      expect(phases).toContainEqual({ name: VERIFY_PHASE, outcome: "not run: the toolchain mise.toml asks for was not installed" });
    });

    it("hands the report a missing mise as a toolchain that failed unstarted, naming install-box.sh", async () => {
      const s = setup({}, { checkoutFiles: MISE_TOML, noMise: true });
      await runJob(SETUP_CHECK_JOB, s.edges);

      expect(s.sandboxed).toEqual([]);
      expect(toolchainHanded(s)).toMatchObject({ TOOLCHAIN_RESULT: "failed", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" });
      expect(toolchainHanded(s)["TOOLCHAIN_OUTPUT"]).toContain("install-box.sh");
      expect(toolchainHanded(s)).not.toHaveProperty("TOOLCHAIN_EXIT");
    });

    it("hands the report a toolchain that timed out, and runs neither setup nor verify", async () => {
      const s = setup({}, { minuteMs: 5, checkoutFiles: MISE_TOML, sandboxRuns: { AGENT_TOOLCHAIN: { hangs: true } } });
      await runJob(SETUP_CHECK_JOB, s.edges);

      expect(s.sandboxed).toHaveLength(1);
      expect(toolchainHanded(s)).toEqual({ TOOLCHAIN_RESULT: "timed-out", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" });
    });

    it("hands the report a toolchain not run where the checkout failed", async () => {
      const s = setup({}, { checkoutFails: "remote: Repository not found." });
      await runJob(SETUP_CHECK_JOB, s.edges);

      expect(toolchainHanded(s)).toEqual({ TOOLCHAIN_RESULT: "not-run", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" });
    });
  });
});

describe("the run's link, on the service (#604)", () => {
  /** An id shaped as the dispatcher mints one, `randomUUID`. */
  const ID = "3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b";

  it("is the App's own page, with a fragment naming the job", () => {
    expect(serviceRunUrl("loop-app[bot]", ID)).toBe(`https://github.com/apps/loop-app#job-${ID}`);
    expect(serviceRunUrl("loop-app", "job-1")).toBe("https://github.com/apps/loop-app#job-job-1");
  });

  it.each([
    ["implement", { ...IMPLEMENT_JOB, id: ID }, IMPLEMENT_ORDINARY],
    ["implement-prd", { ...PRD_JOB, id: ID }, PRD_BUILD],
    ["follow-ups", { ...FOLLOW_UPS_JOB, id: ID }, {}],
  ] as const)("names, for a %s job, the id its run's summary holds, in every subcommand handed it", async (_kind, job, canned) => {
    const s = setup(canned);
    await runJob(job, s.edges);

    const given = s.launched.flatMap((launch) => (launch.env["RUN_URL"] === undefined ? [] : [launch.env["RUN_URL"]]));
    expect(given.length).toBeGreaterThan(0);
    expect(new Set(given)).toEqual(new Set([`https://github.com/apps/loop-app#job-${ID}`]));
    const summary = JSON.parse(fs.readFileSync(path.join(s.runDir, SUMMARY_FILE), "utf8")) as { job: Job };
    expect(summary.job.id).toBe(ID);
    expect(given[0]?.endsWith(`#job-${summary.job.id}`)).toBe(true);
  });

  it.each([
    ["review", JOB, ORDINARY],
    ["fix", FIX_JOB, FIX_ORDINARY],
    ["update-branch", UPDATE_BRANCH_JOB, UB_CLEAN],
  ] as const)("is handed to no subcommand of a %s job, whose commands take none on the service", async (_kind, job, canned) => {
    const s = setup(canned);
    await runJob(job, s.edges);

    expect(s.launched.length).toBeGreaterThan(0);
    expect(s.launched.filter((launch) => "RUN_URL" in launch.env)).toEqual([]);
  });
});

const MERGE_JOB: MergeJob = {
  ...JOB,
  workflow: "merge",
  draft: false,
  action: "labeled",
  sender: "maintainer",
};

/** The gate's decision, as `merge:gate` writes it. */
const decided = (decision: string): Readonly<Partial<Record<Subcommand, Canned>>> => ({ "merge:gate": { files: { "gate.json": { decision, head: HEAD } } } });

/**
 * A merge job (#591), run as `merge.yml`'s one job runs it (spec §12):
 * `merge:gate`, `merge:publish` on `merge`, and `merge:conclude` however it
 * went, with `write`, `push` and `write` tokens. No checkout, no setup and no
 * runner.
 */
describe("the worker's merge job", () => {
  it("runs gate, publish on merge, and conclude, in that order, with write, push and write tokens, and checks nothing out, runs no setup and no runner", async () => {
    const s = setup(decided("merge"));
    await runJob(MERGE_JOB, s.edges);

    expect(s.events).toEqual(["write token", "merge:gate", "push token", "merge:publish", "write token", "merge:conclude"]);
    expect(s.checkouts).toEqual([]);
    expect(s.sandboxed).toEqual([]);
    expect(s.launched.every((launch) => launch.cwd === s.runDir)).toBe(true);
    expect(s.env("merge:gate")["GH_TOKEN"]).toBe("write-token-1");
    expect(s.env("merge:publish")["GH_TOKEN"]).toBe("push-token-2");
    expect(s.env("merge:conclude")["GH_TOKEN"]).toBe("write-token-3");
  });

  it.each(["wait", "behind", "red", "disarmed", "refused"])("does not publish on %s, and holds no push token", async (decision) => {
    const s = setup(decided(decision));
    await runJob(MERGE_JOB, s.edges);

    expect(s.events).toEqual(["write token", "merge:gate", "write token", "merge:conclude"]);
    expect(s.asked).not.toContain("push");
    expect(s.env("merge:conclude")).toMatchObject({ JOB_STATUS: "success", TIMED_OUT: "false" });
  });

  it("hands the gate what merge.yml hands it, the App as the loop's account, and a wait bound of 0", async () => {
    const s = setup(decided("wait"));
    await runJob({ ...MERGE_JOB, action: "synchronize", sender: "pusher", draft: true }, s.edges);

    expect(MERGE_WAIT_SECONDS).toBe(0);
    expect(s.env("merge:gate")).toEqual({
      ...HOST,
      GH_REPO: "owner/repo",
      GH_TOKEN: "write-token-1",
      LOOP_TOKEN: "write-token-1",
      LOOP_TOKEN_SOURCE: "app",
      LOOP_LOGIN: "loop-app[bot]",
      AGENT_LOOP_LOGINS: "loop-app[bot]",
      PR_NUMBER: "7",
      BASE_REF: "main",
      ACTION: "synchronize",
      SENDER: "pusher",
      HEAD_SHA: HEAD,
      HEAD_REPO: "owner/repo",
      PR_STATE: "open",
      PR_MERGED: "false",
      PR_DRAFT: "true",
      CHECK_WAIT_SECONDS: "0",
      OUTPUT_DIR: s.env("merge:gate")["OUTPUT_DIR"],
    });
  });

  it("hands publish the push token as the loop's, pointed at the gate's directory, and conclude every directory", async () => {
    const s = setup(decided("merge"));
    await runJob(MERGE_JOB, s.edges);

    expect(s.env("merge:publish")).toEqual({
      ...HOST,
      GH_REPO: "owner/repo",
      GH_TOKEN: "push-token-2",
      LOOP_TOKEN: "push-token-2",
      LOOP_TOKEN_SOURCE: "app",
      LOOP_LOGIN: "loop-app[bot]",
      AGENT_LOOP_LOGINS: "loop-app[bot]",
      PR_NUMBER: "7",
      BASE_REF: "main",
      GATE_DIR: s.env("merge:gate")["OUTPUT_DIR"],
      OUTPUT_DIR: s.env("merge:publish")["OUTPUT_DIR"],
    });
    expect(s.env("merge:conclude")).toEqual({
      ...HOST,
      GH_REPO: "owner/repo",
      GH_TOKEN: "write-token-3",
      PR_NUMBER: "7",
      JOB_STATUS: "success",
      TIMED_OUT: "false",
      TIMEOUT_MINUTES: String(MERGE_MINUTES),
      GATE_DIR: s.env("merge:gate")["OUTPUT_DIR"],
      PUBLISH_DIR: s.env("merge:publish")["OUTPUT_DIR"],
      OUTPUT_DIR: s.env("merge:conclude")["OUTPUT_DIR"],
    });
    for (const subcommand of ["merge:gate", "merge:publish", "merge:conclude"] as const) {
      for (const name of Object.keys(s.env(subcommand))) expect([...Object.keys(declared(subcommand)), ...Object.keys(HOST)], name).toContain(name);
    }
  });

  it("concludes a gate that failed as a failure, and publishes nothing", async () => {
    const s = setup({ "merge:gate": { exit: 1, files: { "failure_reason.txt": "Couldn't arm it." } } });
    await runJob(MERGE_JOB, s.edges);

    expect(s.events).toEqual(["write token", "merge:gate", "write token", "merge:conclude"]);
    expect(s.env("merge:conclude")).toMatchObject({ JOB_STATUS: "failure", TIMED_OUT: "false" });
  });

  it("concludes a publish that failed as a failure", async () => {
    const s = setup({ ...decided("merge"), "merge:publish": { exit: 1, files: { "failure_reason.txt": "GitHub refused the merge." } } });
    await runJob(MERGE_JOB, s.edges);

    expect(s.env("merge:conclude")).toMatchObject({ JOB_STATUS: "failure" });
  });

  it("publishes nothing where no push token is granted, and concludes with the reason in publish's directory", async () => {
    const s = setup(decided("merge"), { refused: [2] });
    await runJob(MERGE_JOB, s.edges);

    expect(s.events).toEqual(["write token", "merge:gate", "push token", "write token", "merge:conclude"]);
    expect(s.env("merge:conclude")).toMatchObject({ JOB_STATUS: "failure", GH_TOKEN: "write-token-3" });
    expect(fs.readFileSync(path.join(s.env("merge:conclude")["PUBLISH_DIR"]!, "failure_reason.txt"), "utf8")).toContain("no `push` token");
  });

  it("concludes with the gate's token where a fresh one is refused", async () => {
    const s = setup(decided("wait"), { refused: [2] });
    await runJob(MERGE_JOB, s.edges);

    expect(s.env("merge:conclude")["GH_TOKEN"]).toBe("write-token-1");
  });

  it("ends a gate still running at merge.yml's time limit, and concludes it as a timeout", async () => {
    const s = setup({ "merge:gate": { hangs: true } }, { minuteMs: 5 });
    await runJob(MERGE_JOB, s.edges);

    expect(s.events.at(-1)).toBe("merge:conclude");
    expect(s.env("merge:conclude")).toMatchObject({ JOB_STATUS: "cancelled", TIMED_OUT: "true", TIMEOUT_MINUTES: "20" });
  });

  it("logs why nothing ran where no token was granted, since nothing can say so on the pull request", async () => {
    const s = setup({}, { refused: [1] });
    const phases = await runJob(MERGE_JOB, s.edges);

    expect(s.launched).toEqual([]);
    expect(phases.at(-1)).toEqual({
      name: "merge:gate",
      outcome: "not run: the dispatcher granted no token to decide with, so neither it nor merge:conclude ran, and nothing was written",
    });
  });

  it("queues a merge job at the door, and refuses one with no action, naming the field", () => {
    const accepted: Job[] = [];
    const handle = jobDoor({ secret: "s", version: "9.9.9", accept: (job) => accepted.push(job) });
    const send = (job: unknown) => {
      const body = Buffer.from(JSON.stringify(job));
      return handle({ headers: { [SIGNATURE_HEADER]: sign("s", body) }, body });
    };

    expect(send(MERGE_JOB).status).toBe(202);
    expect(accepted).toEqual([MERGE_JOB]);
    expect(JSON.parse(send({ ...MERGE_JOB, action: "opened" }).body)).toEqual({ refusal: "`action` is not one of `labeled`, `synchronize`" });
    expect(JSON.parse(send({ ...MERGE_JOB, draft: "no" }).body)).toEqual({ refusal: "`draft` is not a boolean" });
    expect(JSON.parse(send({ ...MERGE_JOB, sender: "" }).body)).toEqual({ refusal: "`sender` is not a non-empty string" });
  });
});

/**
 * What the job door queues (#591): a merge job is coalesced per pull request,
 * at most one running and one waiting; every other kind is queued as it comes.
 */
describe("admitting a job to the queue", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const queued = () => {
    const releases: (() => void)[] = [];
    const queue = lanes(() => new Promise<void>((resolve) => releases.push(resolve)), () => {});
    return { queue, releases };
  };
  const pushed = (id: string, pr = 7): MergeJob => ({ ...MERGE_JOB, id, pr, action: "synchronize", sender: "pusher" });

  it("absorbs five merge jobs for a pull request whose merge job waits, and queues every other kind", async () => {
    const { queue } = queued();
    admit(queue, JOB);
    admit(queue, pushed("m-1"));
    await settle();

    const lines = ["m-2", "m-3", "m-4", "m-5", "m-6"].map((id) => admit(queue, pushed(id)));

    expect(queue.held().map((job) => job.id)).toEqual(["job-1", "m-1"]);
    expect(lines.every((line) => line?.includes("absorbed by merge job m-1"))).toBe(true);
    expect(admit(queue, { ...JOB, id: "job-2" })).toBeUndefined();
    expect(queue.held().map((job) => job.id)).toEqual(["job-1", "m-1", "job-2"]);
  });

  it("queues one successor behind a running merge job, which the rest are absorbed by", async () => {
    const { queue, releases } = queued();
    admit(queue, pushed("m-1"));
    await settle();

    for (const id of ["m-2", "m-3", "m-4", "m-5", "m-6"]) admit(queue, pushed(id));

    expect(queue.running()?.id).toBe("m-1");
    expect(queue.held().map((job) => job.id)).toEqual(["m-1", "m-2"]);
    releases[0]?.();
    await settle();
    expect(queue.running()?.id).toBe("m-2");
  });

  it("absorbs nothing for another pull request", () => {
    const { queue } = queued();
    admit(queue, JOB);
    admit(queue, pushed("m-1"));

    expect(admit(queue, pushed("m-2", 8))).toBeUndefined();
    expect(queue.held().map((job) => job.id)).toEqual(["job-1", "m-1", "m-2"]);
  });

  it("lets a person's agent:merge replace the one queued, and absorbs the App's own as any", () => {
    const { queue } = queued();
    admit(queue, JOB);
    admit(queue, pushed("m-1"));

    expect(admit(queue, { ...MERGE_JOB, id: "m-2", sender: "loop-app[bot]" })).toContain("absorbed by merge job m-1");
    expect(admit(queue, { ...MERGE_JOB, id: "m-3" })).toContain("replaced merge job m-1");
    expect(queue.held().map((job) => job.id)).toEqual(["job-1", "m-3"]);
    expect(admit(queue, pushed("m-4"))).toContain("absorbed by merge job m-3");
  });

  it("lets a delivery with a later deadline replace the one queued, so the gate that runs is inside its own (#645)", async () => {
    // The dispatcher's clock: it refuses every token once the job's deadline has passed.
    let clock = new Date("2026-10-11T13:00:00.000Z");
    const s = setup({});
    const releases: (() => void)[] = [];
    const ran: Job[] = [];
    const queue = lanes(async (job) => {
      ran.push(job);
      if (job.workflow !== "merge") return new Promise<void>((resolve) => releases.push(resolve));
      await runJob(job, {
        ...s.edges,
        token: async (kind) => {
          if (clock.getTime() >= Date.parse(job.deadline)) throw new Error(`the dispatcher answered 403: job ${job.id} is past its deadline, ${job.deadline}`);
          return s.edges.token(kind);
        },
      });
    }, () => {});

    admit(queue, JOB);
    admit(queue, { ...pushed("m-1"), deadline: "2026-10-11T13:30:00.000Z" });
    await settle();
    clock = new Date("2026-10-11T13:20:00.000Z");
    const line = admit(queue, { ...pushed("m-2"), deadline: "2026-10-11T13:50:00.000Z" });

    expect(line).toContain("replaced merge job m-1");
    expect(queue.held().map((job) => job.id)).toEqual(["job-1", "m-2"]);
    // The review ends past m-1's deadline, inside m-2's.
    clock = new Date("2026-10-11T13:40:00.000Z");
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ran.map((job) => [job.id, job.deadline])).toEqual([
      ["job-1", JOB.deadline],
      ["m-2", "2026-10-11T13:50:00.000Z"],
    ]);
    expect(s.events).toContain("merge:gate");
  });

  it("absorbs a delivery whose deadline is no later than the queued one's, and one that does not arm into one that does", () => {
    const { queue } = queued();
    admit(queue, JOB);
    admit(queue, { ...pushed("m-1"), deadline: "2026-10-11T13:30:00.000Z" });

    expect(admit(queue, { ...pushed("m-2"), deadline: "2026-10-11T13:30:00.000Z" })).toContain("absorbed by merge job m-1");
    expect(admit(queue, { ...pushed("m-3"), deadline: "2026-10-11T13:10:00.000Z" })).toContain("absorbed by merge job m-1");
    expect(admit(queue, { ...MERGE_JOB, id: "m-4", deadline: "2026-10-11T13:30:00.000Z" })).toContain("replaced merge job m-1");
    expect(admit(queue, { ...pushed("m-5"), deadline: "2026-10-11T13:50:00.000Z" })).toContain("absorbed by merge job m-4");
    expect(queue.held().map((job) => job.id)).toEqual(["job-1", "m-4"]);
  });
});

/**
 * What the worker holds (#581): the queue knows each job queued or running,
 * and the held door answers the dispatcher's scan with them, signed with the
 * shared secret as the job door is. The question names the dispatcher
 * instance asking (#597), and every job queued from another is dropped first.
 */
describe("the held door", () => {
  const SECRET = "the-worker-secret";
  const NOW = new Date("2026-10-31T12:00:00.000Z");
  const now = () => NOW;
  const ask = (handle: ReturnType<typeof heldDoor>, secret = SECRET, question: unknown = { asked: "2026-10-31T12:00:00.000Z", instance: "dispatcher-1" }) => {
    const body = Buffer.from(JSON.stringify(question));
    return handle({ headers: { [SIGNATURE_HEADER]: sign(secret, body) }, body });
  };
  /** A held door over a real queue, whose work waits until a test lets it end. */
  const queued = () => {
    const ran: Job[] = [];
    const releases: (() => void)[] = [];
    const queue = lanes(
      (job) =>
        new Promise<void>((resolve) => {
          ran.push(job);
          releases.push(resolve);
        }),
      () => {},
    );
    return { queue, ran, releases, handle: heldDoor({ secret: SECRET, held: queue.held, drop: queue.drop, now }) };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("answers each held job's id, kind, repository and number, which the dispatcher reads back", () => {
    const response = ask(heldDoor({ secret: SECRET, held: () => [JOB, IMPLEMENT_JOB, FOLLOW_UPS_JOB], drop: () => [], now }));

    expect(response.status).toBe(200);
    expect(parseHeld(JSON.parse(response.body))).toEqual([
      { id: JOB.id, workflow: "review", repo: JOB.repo, number: JOB.pr },
      { id: IMPLEMENT_JOB.id, workflow: "implement", repo: IMPLEMENT_JOB.repo, number: IMPLEMENT_JOB.issue },
      { id: FOLLOW_UPS_JOB.id, workflow: "follow-ups", repo: FOLLOW_UPS_JOB.repo, number: FOLLOW_UPS_JOB.pr },
    ]);
  });

  it("refuses a request whose signature does not verify, names no job, and drops none", () => {
    const w = queued();
    w.queue.add(JOB);
    w.queue.add({ ...IMPLEMENT_JOB, id: "job-2" });
    const response = ask(w.handle, "someone-elses-secret", { asked: "2026-10-31T12:00:00.000Z", instance: "dispatcher-2" });

    expect(response.status).toBe(401);
    expect(response.body).not.toContain(JOB.repo);
    expect(w.queue.held().map((job) => job.id)).toEqual(["job-1", "job-2"]);
  });

  it.each<[string, unknown, string]>([
    ["a non-string instance", { asked: "2026-10-31T12:00:00.000Z", instance: 1 }, "`instance` is not a dispatcher instance's id, up to 64 letters, digits, `-` and `_`"],
    ["an empty instance", { asked: "2026-10-31T12:00:00.000Z", instance: "" }, "`instance` is not a dispatcher instance's id, up to 64 letters, digits, `-` and `_`"],
    ["a malformed instance", { asked: "2026-10-31T12:00:00.000Z", instance: "not one; at all" }, "`instance` is not a dispatcher instance's id, up to 64 letters, digits, `-` and `_`"],
    ["no time", { instance: "dispatcher-1" }, "`asked` is not a time"],
  ])("refuses a question with %s, naming the field, and drops nothing", (_name, question, refusal) => {
    const w = queued();
    w.queue.add(JOB);
    w.queue.add({ ...IMPLEMENT_JOB, id: "job-2", instance: "dispatcher-0" });
    const response = ask(w.handle, SECRET, question);

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ refusal });
    expect(w.queue.held()).toHaveLength(2);
  });

  it("drops each job queued from another dispatcher instance before it runs, and answers only what it still holds", async () => {
    const w = queued();
    w.queue.add({ ...JOB, instance: "dispatcher-0" });
    w.queue.add({ ...IMPLEMENT_JOB, id: "job-2", instance: "dispatcher-0" });
    w.queue.add({ ...FOLLOW_UPS_JOB, id: "job-3", instance: "dispatcher-1" });
    await settle();
    expect(w.ran.map((job) => job.id)).toEqual(["job-1"]);

    const response = ask(w.handle);

    expect(response.status).toBe(200);
    // The running job is kept, whichever instance queued it: this door cannot stop it.
    expect(parseHeld(JSON.parse(response.body))).toEqual([
      { id: "job-1", workflow: "review", repo: JOB.repo, number: JOB.pr },
      { id: "job-3", workflow: "follow-ups", repo: FOLLOW_UPS_JOB.repo, number: FOLLOW_UPS_JOB.pr },
    ]);
    w.releases[0]?.();
    await settle();
    w.releases[1]?.();
    await settle();
    expect(w.ran.map((job) => job.id)).toEqual(["job-1", "job-3"]);
    expect(w.queue.held()).toEqual([]);
  });

  it("drops no job queued from the instance asking, however many times it asks", async () => {
    const w = queued();
    w.queue.add(JOB);
    w.queue.add({ ...IMPLEMENT_JOB, id: "job-2" });
    ask(w.handle);
    ask(w.handle);

    expect(w.queue.held().map((job) => job.id)).toEqual(["job-1", "job-2"]);
    await settle();
    w.releases[0]?.();
    await settle();
    expect(w.ran.map((job) => job.id)).toEqual(["job-1", "job-2"]);
  });

  it("only reads where the question names no instance: answers every job held and drops none (#601)", async () => {
    const w = queued();
    w.queue.add({ ...JOB, instance: "dispatcher-0" });
    w.queue.add({ ...IMPLEMENT_JOB, id: "job-2", instance: "dispatcher-0" });
    w.queue.add({ ...FOLLOW_UPS_JOB, id: "job-3", instance: "dispatcher-1" });
    await settle();

    const response = ask(w.handle, SECRET, { asked: NOW.toISOString() });

    expect(response.status).toBe(200);
    expect(parseHeld(JSON.parse(response.body))).toEqual(w.queue.held().map(heldOf));
    expect(w.queue.held().map((job) => job.id)).toEqual(["job-1", "job-2", "job-3"]);
  });

  it.each<[string, number, string | undefined]>([
    ["asked just inside the age allowed", -HELD_REQUEST_MAX_AGE_MINUTES, undefined],
    ["asked just past the age allowed, a replay", -HELD_REQUEST_MAX_AGE_MINUTES - 0.01, `more than ${HELD_REQUEST_MAX_AGE_MINUTES} minutes ago by this worker's clock`],
    ["asked ahead within the skew allowed", HELD_REQUEST_MAX_SKEW_MINUTES, undefined],
    ["asked further ahead than the skew allowed", HELD_REQUEST_MAX_SKEW_MINUTES + 0.01, `more than ${HELD_REQUEST_MAX_SKEW_MINUTES} minute ahead of this worker's clock`],
  ])("holds a question %s to the worker's clock, and drops nothing on one it refuses (#601)", async (_name, minutes, refused) => {
    const w = queued();
    w.queue.add({ ...JOB, instance: "dispatcher-0" });
    w.queue.add({ ...IMPLEMENT_JOB, id: "job-2", instance: "dispatcher-0" });
    await settle();
    const asked = new Date(NOW.getTime() + minutes * 60 * 1000).toISOString();
    const response = ask(w.handle, SECRET, { asked, instance: "dispatcher-1" });

    if (refused === undefined) {
      expect(response.status).toBe(200);
      expect(w.queue.held().map((job) => job.id)).toEqual(["job-1"]);
    } else {
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ refusal: `\`asked\` is ${asked}, ${refused}` });
      expect(w.queue.held().map((job) => job.id)).toEqual(["job-1", "job-2"]);
    }
  });

  it("holds a job from the moment it is queued until its work has ended, running or waiting, thrown or not", async () => {
    const releases: (() => void)[] = [];
    const queue = lanes(
      (job) => new Promise<void>((resolve, reject) => releases.push(() => (job.id === "throws" ? reject(new Error("no")) : resolve()))),
      () => {},
    );
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    queue.add({ ...JOB, id: "throws" });
    queue.add({ ...JOB, id: "second" });
    expect(queue.held().map((job) => job.id)).toEqual(["throws", "second"]);

    await settle();
    releases[0]?.();
    await settle();
    expect(queue.held().map((job) => job.id)).toEqual(["second"]);

    releases[1]?.();
    await settle();
    expect(queue.held()).toEqual([]);
  });

  it("drops a waiting job so its work never starts, keeps the running one, and runs the rest in order, behind one that throws", async () => {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const errors: unknown[] = [];
    const queue = lanes(
      (job) =>
        new Promise<void>((resolve, reject) => {
          started.push(job.id);
          releases.push(() => (job.id === "throws" ? reject(new Error("no")) : resolve()));
        }),
      (error) => errors.push(error),
    );
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const ids = () => queue.held().map((job) => job.id);

    for (const id of ["throws", "dropped", "kept", "dropped too"]) queue.add({ ...JOB, id });
    await settle();

    expect(queue.drop((job) => job.id !== "kept").map((job) => job.id)).toEqual(["dropped", "dropped too"]);
    expect(ids()).toEqual(["throws", "kept"]);

    releases[0]?.();
    await settle();
    expect(errors).toHaveLength(1);
    expect(started).toEqual(["throws", "kept"]);
    expect(ids()).toEqual(["kept"]);
    expect(queue.drop(() => true)).toEqual([]);

    releases[1]?.();
    await settle();
    expect(started).toEqual(["throws", "kept"]);
    expect(queue.held()).toEqual([]);
  });
});

/**
 * The worker's two lanes (#582): a light lane for jobs that start no agent,
 * beside the agent lane, which still runs one agent job at a time in arrival
 * order, and beneath both a chain per pull request or issue. Each job's work
 * here is a fake that ends when the test says so; an update-branch job's asks
 * for the agent lane where the test says its merge conflicted.
 */
describe("the worker's queue", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const review = (id: string, pr = 7, branch = `agent/issue-${pr}-a-thing`): ReviewJob => ({ ...JOB, id, pr, branch });
  const implement = (id: string, issue = 12): ImplementJob => ({ ...IMPLEMENT_JOB, id, issue });
  const followUps = (id: string, pr = 7): FollowUpsJob => ({ ...FOLLOW_UPS_JOB, id, pr });
  const updateBranch = (id: string, pr = 7, branch = `agent/issue-${pr}-a-thing`): UpdateBranchJob => ({ ...UPDATE_BRANCH_JOB, id, pr, branch });
  const implementPrd = (id: string, issue: number): ImplementPrdJob => ({ ...PRD_JOB, id, issue });

  /** A queue whose jobs' work waits for the test: each start, each agent part's start and each end, in order. */
  const queued = (hold: Parameters<typeof lanes>[2] = {}) => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const ends = new Map<string, () => void>();
    const throws = new Map<string, () => void>();
    const agentLanes = new Map<string, () => Promise<void>>();
    const running = new Set<string>();
    /** The most jobs the agent lane ever ran at once: agent jobs, and hand-offs in their agent part. */
    let agentParts = 0;
    let mostAgentParts = 0;
    const inAgentLane = new Set<string>();
    const enter = (id: string): void => {
      inAgentLane.add(id);
      agentParts += 1;
      mostAgentParts = Math.max(mostAgentParts, agentParts);
    };
    const queue = lanes(
      (job, agentLane) =>
        new Promise<void>((resolve, reject) => {
          events.push(`${job.id} starts`);
          running.add(job.id);
          if (LANES[job.workflow] === "agent") enter(job.id);
          agentLanes.set(job.id, agentLane);
          const leave = (): void => {
            running.delete(job.id);
            if (inAgentLane.delete(job.id)) agentParts -= 1;
          };
          ends.set(job.id, () => {
            leave();
            events.push(`${job.id} ends`);
            resolve();
          });
          throws.set(job.id, () => {
            leave();
            events.push(`${job.id} throws`);
            reject(new Error(`${job.id} threw`));
          });
        }),
      (error) => errors.push(error),
      hold,
    );
    return {
      queue,
      events,
      errors,
      running,
      mostAgentParts: () => mostAgentParts,
      end: async (id: string) => {
        ends.get(id)?.();
        await settle();
      },
      throw: async (id: string) => {
        throws.get(id)?.();
        await settle();
      },
      /** An update-branch job's merge conflicted: it asks for the agent lane, and notes when it has it. */
      conflict: async (id: string) => {
        void agentLanes.get(id)?.().then(() => {
          enter(id);
          events.push(`${id} has the agent lane`);
        });
        await settle();
      },
    };
  };

  describe("while the plan's usage limit holds (#635)", () => {
    const MINUTE_MS = 60 * 1000;
    const HOUR_MS = 60 * MINUTE_MS;
    /** A clock the test moves, and the timers it fires as it does. */
    const fakeClock = (start: number) => {
      let now = start;
      const timers: { at: number; then: () => void }[] = [];
      return {
        clock: { now: () => now, after: (ms: number, then: () => void) => void timers.push({ at: now + ms, then }) },
        advance: async (minutes: number) => {
          now += minutes * MINUTE_MS;
          for (const timer of timers.filter((t) => t.at <= now)) {
            timers.splice(timers.indexOf(timer), 1);
            timer.then();
          }
          await settle();
        },
      };
    };
    const START = Date.parse("2026-11-01T01:10:00Z");
    const RESETS = new Date("2026-11-01T05:50:00Z");
    const UNTIL = (5 * 60 + 50 - 70) + RESET_MARGIN_MINUTES;
    /** A deadline past the hold, so the job keeps its place. */
    const LATER = "2026-11-01T09:00:00.000Z";

    it("starts no agent job until the reset, runs a job that starts no agent meanwhile, then the held jobs in arrival order, and asks for a scan", async () => {
      const time = fakeClock(START);
      let resets = 0;
      const w = queued({ clock: time.clock, reset: () => (resets += 1) });
      w.queue.add(review("limited"));
      await settle();
      w.queue.limit(RESETS);
      await w.end("limited");

      w.queue.add({ ...implement("build"), deadline: LATER });
      w.queue.add({ ...review("second", 8), deadline: LATER });
      w.queue.add({ ...followUps("file", 9), deadline: LATER });
      w.queue.add({ ...updateBranch("clean", 10), deadline: LATER });
      w.queue.add({ ...updateBranch("conflicted", 11), deadline: LATER });
      await settle();
      expect(w.queue.heldUntil()).toEqual(new Date(RESETS.getTime() + RESET_MARGIN_MINUTES * MINUTE_MS));

      // The light lane runs on: the filing, the clean refresh, and the conflicted one up to its agent part.
      await w.end("file");
      await w.end("clean");
      await w.conflict("conflicted");
      expect(w.events.slice(2)).toEqual(["file starts", "file ends", "clean starts", "clean ends", "conflicted starts"]);

      // At the reset itself the margin still holds; at its end the agent lane runs as before.
      await time.advance(UNTIL - RESET_MARGIN_MINUTES);
      expect(w.events.at(-1)).toBe("conflicted starts");
      expect(resets).toBe(0);
      await time.advance(RESET_MARGIN_MINUTES);
      expect(resets).toBe(1);
      expect(w.queue.heldUntil()).toBeUndefined();
      expect(w.events.at(-1)).toBe("build starts");
      await w.end("build");
      expect(w.events.at(-1)).toBe("second starts");
      await w.end("second");
      expect(w.events.at(-1)).toBe("conflicted has the agent lane");
      expect(w.mostAgentParts()).toBe(1);
    });

    it("is extended by a later reset, and not shortened by an earlier one", async () => {
      const time = fakeClock(START);
      let resets = 0;
      const w = queued({ clock: time.clock, reset: () => (resets += 1) });
      w.queue.limit(RESETS);
      w.queue.limit(new Date(RESETS.getTime() + HOUR_MS));
      w.queue.limit(new Date(RESETS.getTime() - HOUR_MS));
      w.queue.add({ ...implement("build"), deadline: LATER });
      await settle();

      await time.advance(UNTIL);
      expect(w.events).toEqual([]);
      expect(resets).toBe(0);
      await time.advance(60);
      expect(w.events).toEqual(["build starts"]);
      expect(resets).toBe(1);
    });

    // A hold is often hours, a deadline its kind's time limit and a margin:
    // a job queued past it would end at its first token with nothing posted.
    it("drops every queued job past its deadline as it ends, before asking for the scan, so the scan dispatches each again", async () => {
      const time = fakeClock(START);
      const late: string[][] = [];
      let heldAtReset: string[] = [];
      const w = queued({
        clock: time.clock,
        reset: (dropped) => {
          late.push(dropped.map((job) => job.id));
          heldAtReset = w.queue.held().map((job) => job.id);
        },
      });
      w.queue.limit(RESETS);
      w.queue.add({ ...implement("stale"), deadline: "2026-11-01T03:00:00.000Z" });
      w.queue.add({ ...review("fresh", 8), deadline: LATER });
      w.queue.add({ ...review("stale-behind", 9), deadline: "2026-11-01T05:52:00.000Z" });
      await settle();

      await time.advance(UNTIL);

      expect(late).toEqual([["stale", "stale-behind"]]);
      expect(heldAtReset).toEqual(["fresh"]);
      expect(w.events).toEqual(["fresh starts"]);
    });
  });

  it("classes each kind by what it can do: follow-ups and merge are light, update-branch hands off, and every other kind, a setup check's included, runs in the agent lane", () => {
    expect(LANES).toEqual({
      review: "agent",
      fix: "agent",
      "update-branch": "hand-off",
      implement: "agent",
      "implement-prd": "agent",
      "follow-ups": "light",
      merge: "light",
      "setup-check": "agent",
    });
  });

  // #821: a setup check's setup and verify can run for an agent's job's
  // limit, so it holds the agent lane, not the light one, and a merge job
  // queued after it does not wait behind its build.
  it("runs a setup check in the agent lane, behind an agent job, and lets a merge job queued after it start at once", async () => {
    const w = queued();
    w.queue.add(implement("build", 12));
    w.queue.add({ ...SETUP_CHECK_JOB, id: "check", issue: 40 });
    w.queue.add({ ...MERGE_JOB, id: "merge", pr: 50, branch: "agent/issue-50-a-thing" });
    await settle();

    expect(w.running).toEqual(new Set(["build", "merge"]));
    await w.end("merge");
    expect(w.running).toEqual(new Set(["build"]));
    await w.end("build");
    expect(w.running).toEqual(new Set(["check"]));
    await w.end("check");
    expect(w.mostAgentParts()).toBe(1);
  });

  it("starts a follow-ups job and a clean update-branch queued behind a long agent job at once, and ends both before it", async () => {
    const w = queued();
    w.queue.add(implement("build"));
    w.queue.add(followUps("file", 8));
    w.queue.add(updateBranch("refresh", 9));
    await settle();

    expect(w.events).toEqual(["build starts", "file starts"]);
    await w.end("file");
    await w.end("refresh");
    expect(w.events).toEqual(["build starts", "file starts", "file ends", "refresh starts", "refresh ends"]);
    expect(w.running).toEqual(new Set(["build"]));

    await w.end("build");
    expect(w.events.at(-1)).toBe("build ends");
    expect(w.queue.held()).toEqual([]);
  });

  it("never runs two agent jobs at once, and runs them in the order they arrived, whatever runs beside them", async () => {
    const w = queued();
    w.queue.add(implement("first", 12));
    w.queue.add(review("second", 20));
    w.queue.add(followUps("light", 30));
    w.queue.add(implement("third", 13));
    await settle();
    expect(w.running).toEqual(new Set(["first", "light"]));

    await w.end("light");
    await w.end("first");
    await w.end("second");
    await w.end("third");
    expect(w.events.filter((event) => event.endsWith("starts"))).toEqual(["first starts", "light starts", "second starts", "third starts"]);
    expect(w.mostAgentParts()).toBe(1);
  });

  it("runs two jobs for one item in the order they arrived and never together, whatever their kinds", async () => {
    const w = queued();
    // A review on the pull request, then its follow-ups after the merge, then a refresh: one item, three lanes' worth.
    w.queue.add(review("review", 7));
    w.queue.add(followUps("file", 7));
    w.queue.add(updateBranch("refresh", 7));
    w.queue.add(followUps("other", 8));
    await settle();
    // The light lane passes over the follow-ups waiting on its item, so another item's still starts.
    expect(w.running).toEqual(new Set(["review", "other"]));

    await w.end("other");
    expect(w.running).toEqual(new Set(["review"]));
    await w.end("review");
    expect(w.running).toEqual(new Set(["file"]));
    await w.end("file");
    expect(w.running).toEqual(new Set(["refresh"]));
    await w.end("refresh");
    expect(w.events).toEqual([
      "review starts",
      "other starts",
      "other ends",
      "review ends",
      "file starts",
      "file ends",
      "refresh starts",
      "refresh ends",
    ]);
  });

  it("runs a refresh after an agent job for its item, when that job arrived first, whichever lane either runs in", async () => {
    const w = queued();
    w.queue.add(updateBranch("refresh", 7));
    w.queue.add(review("review", 7));
    await settle();
    expect(w.running).toEqual(new Set(["refresh"]));

    // A clean merge: it ends without the agent lane, and the review starts.
    await w.end("refresh");
    expect(w.running).toEqual(new Set(["review"]));
  });

  it("holds an update-branch whose merge conflicts back from the agent lane while an agent job runs, as an agent job waits", async () => {
    const w = queued();
    w.queue.add(implement("build"));
    w.queue.add(updateBranch("refresh", 9));
    w.queue.add(followUps("file", 8));
    await settle();
    expect(w.events).toEqual(["build starts", "refresh starts"]);

    await w.conflict("refresh");
    // Handed off: the light lane is free for the next job, and the agent part waits.
    expect(w.events).toEqual(["build starts", "refresh starts", "file starts"]);

    await w.end("file");
    await w.end("build");
    expect(w.events.slice(-2)).toEqual(["build ends", "refresh has the agent lane"]);
    await w.end("refresh");
    expect(w.mostAgentParts()).toBe(1);
    expect(w.queue.held()).toEqual([]);
  });

  it("keeps a hand-off's place in the agent lane: an agent job that arrived after it waits for its merge, and then for its agent", async () => {
    const w = queued();
    w.queue.add(updateBranch("refresh", 9));
    w.queue.add(implement("build"));
    await settle();
    expect(w.running).toEqual(new Set(["refresh"]));

    await w.conflict("refresh");
    expect(w.events).toEqual(["refresh starts", "refresh has the agent lane"]);
    expect(w.running).toEqual(new Set(["refresh"]));

    await w.end("refresh");
    expect(w.running).toEqual(new Set(["build"]));
  });

  it("frees a hand-off's place in the agent lane where its merge was clean, so the agent job behind it starts", async () => {
    const w = queued();
    w.queue.add(updateBranch("refresh", 9));
    w.queue.add(implement("build"));
    await settle();

    await w.end("refresh");
    expect(w.events).toEqual(["refresh starts", "refresh ends", "build starts"]);
  });

  it("puts a PRD PR's refresh in line behind its parent's slice build, since both push to the PRD branch", async () => {
    const w = queued();
    w.queue.add(implementPrd("slice", 585));
    w.queue.add(updateBranch("refresh", 599, "agent/prd-585-the-two-lane-worker"));
    w.queue.add(updateBranch("other", 600, "agent/prd-586-another-chain"));
    await settle();
    // Another chain's refresh is not held back: only the chain the slice is building.
    expect(w.running).toEqual(new Set(["slice", "other"]));

    await w.end("other");
    expect(w.running).toEqual(new Set(["slice"]));
    await w.end("slice");
    expect(w.running).toEqual(new Set(["refresh"]));
  });

  it("puts a parent's slice build in line behind a refresh of its PRD PR that arrived first", async () => {
    const w = queued();
    w.queue.add(updateBranch("refresh", 599, "agent/prd-585-the-two-lane-worker"));
    w.queue.add(implementPrd("slice", 585));
    await settle();
    expect(w.running).toEqual(new Set(["refresh"]));

    await w.end("refresh");
    expect(w.running).toEqual(new Set(["slice"]));
  });

  it("puts an issue branch's PR in line with its issue's implement job, and keeps a PRD PR's own chain by its number too", async () => {
    const w = queued();
    w.queue.add(implement("build", 12));
    w.queue.add(updateBranch("refresh", 40, "agent/issue-12-a-thing"));
    w.queue.add(updateBranch("prd refresh", 599, "agent/prd-585-x"));
    w.queue.add(followUps("file", 599));
    await settle();
    // The follow-ups names no branch, and still waits for the refresh on its own pull request.
    expect(w.running).toEqual(new Set(["build", "prd refresh"]));

    await w.end("prd refresh");
    expect(w.running).toEqual(new Set(["build", "file"]));
    await w.end("build");
    expect(w.running).toEqual(new Set(["file"]));
    await w.end("file");
    expect(w.running).toEqual(new Set(["refresh"]));
  });

  it("goes on behind a job that throws, in its lane and in its item's chain", async () => {
    const w = queued();
    w.queue.add(implement("build", 12));
    w.queue.add(followUps("file", 7));
    w.queue.add(review("review", 7));
    w.queue.add(followUps("next", 8));
    w.queue.add(implement("later", 13));
    await settle();

    await w.throw("file");
    // The light lane takes the next light job, and the review behind it on its item waits only for the agent lane.
    expect(w.running).toEqual(new Set(["build", "next"]));
    await w.throw("build");
    expect(w.running).toEqual(new Set(["review", "next"]));
    await w.end("review");
    expect(w.running).toEqual(new Set(["later", "next"]));
    expect(w.errors.map((error) => (error as Error).message)).toEqual(["file threw", "build threw"]);
  });

  it("never drops a hand-off waiting for the agent lane: its work has started", async () => {
    const w = queued();
    w.queue.add(implement("build"));
    w.queue.add(updateBranch("refresh", 9));
    await settle();
    await w.conflict("refresh");

    expect(w.queue.drop(() => true)).toEqual([]);
    expect(w.queue.held().map((job) => job.id)).toEqual(["build", "refresh"]);
  });

  it("leaves a job's deadline as dispatched, and a conflicted refresh that reaches the agent lane past it ends at its next token, as a late job does", async () => {
    // The dispatcher's clock: it refuses every token once the job's deadline has passed.
    let clock = new Date("2026-10-11T13:00:00.000Z");
    const s = setup(UB_CONFLICTS);
    const refresh = { ...updateBranch("refresh", 9), deadline: "2026-10-11T14:00:00.000Z" };
    const handed: Job[] = [];
    const releases: (() => void)[] = [];
    let phases: readonly Phase[] = [];
    const queue = lanes(async (job, agentLane) => {
      handed.push(job);
      if (job.workflow !== "update-branch") return new Promise<void>((resolve) => releases.push(resolve));
      phases = await runJob(job, {
        ...s.edges,
        token: async (kind) => {
          if (clock.getTime() >= Date.parse(job.deadline)) {
            s.asked.push(kind);
            s.events.push(`${kind} token refused`);
            throw new Error(`the dispatcher answered 403: job ${job.id} is past its deadline, ${job.deadline}`);
          }
          return s.edges.token(kind);
        },
        agentLane,
      });
    }, () => {});

    queue.add(implement("build"));
    queue.add(refresh);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The gate and the merge ran beside the build, inside the deadline; the agent's job waits.
    expect(s.events).toEqual(["write token", "update-branch:gate", "checkout", "update-branch:merge"]);

    clock = new Date("2026-10-11T14:30:00.000Z");
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handed.map((job) => job.deadline)).toEqual([IMPLEMENT_JOB.deadline, "2026-10-11T14:00:00.000Z"]);
    expect(handed[1]).toBe(refresh);
    // Late: no agent, nothing published, and nothing can say so on the pull request but the worker's log.
    expect(s.events.slice(4)).toEqual(["read token refused", "push token refused", "write token refused"]);
    expect(phases.at(-1)?.name).toBe("update-branch:conclude");
    expect(phases.at(-1)?.outcome).toMatch(/^not run: the dispatcher granted no token/);
    expect(queue.held()).toEqual([]);
  });
});

/**
 * The repository variables a runner reads (#651): the model, the effort and
 * the prompt cache's TTL, and each runner's own override of the first two,
 * which the job carries and the worker hands the runner as each reusable
 * hands it `vars.X`. Derived from the contract: every `AGENT_` input a runner
 * declares but the sandbox's settings and the loop's accounts, which are the
 * service's own, so a variable added there and left off the job's list fails
 * here rather than doing nothing on the service.
 */
describe("the repository variables a runner reads, on the service", () => {
  const SERVICE_OWN = new Set<string>([...Object.keys(SANDBOX), "AGENT_LOOP_LOGINS"]);
  const reads = (runner: Runner): string[] =>
    Object.keys(RUNNERS[runner].inputs).filter((name) => name.startsWith("AGENT_") && !SERVICE_OWN.has(name));

  it("names the effort and the prompt cache's TTL among them, so the derivation is not empty", () => {
    expect(reads("review")).toEqual(expect.arrayContaining(["AGENT_MODEL", "AGENT_MODEL_REVIEW", "AGENT_EFFORT", "AGENT_EFFORT_REVIEW", "AGENT_PROMPT_CACHE_TTL"]));
  });

  it.each(Object.keys(RUNNERS) as Runner[])("carries each %s reads on the job", (runner) => {
    expect([...REPOSITORY_VARIABLES]).toEqual(expect.arrayContaining(reads(runner)));
  });

  it("starts the review's runner with AGENT_EFFORT_REVIEW where the repository sets it", async () => {
    const s = setup();
    await runJob({ ...JOB, variables: { ...JOB.variables, AGENT_EFFORT_REVIEW: "low" } }, s.edges);

    expect(s.env("review")["AGENT_EFFORT_REVIEW"]).toBe("low");
  });

  const cases: readonly (readonly [Runner, Job, Readonly<Partial<Record<Subcommand, Canned>>>])[] = [
    ["review", JOB, ORDINARY],
    ["fix", FIX_JOB, FIX_ORDINARY],
    ["update-branch", UPDATE_BRANCH_JOB, UB_CONFLICTS],
    ["implement", IMPLEMENT_JOB, IMPLEMENT_ORDINARY],
    ["implement-prd", PRD_JOB, PRD_BUILD],
  ];

  it.each(cases)("hands %s's runner each it reads, as the repository set it", async (runner, job, canned) => {
    const s = setup(canned);
    const set = Object.fromEntries(reads(runner).map((name) => [name, `${name.toLowerCase()}-value`]));
    await runJob({ ...job, variables: { ...job.variables, ...set } } as Job, s.edges);

    expect(s.env(runner)).toMatchObject(set);
  });
});
