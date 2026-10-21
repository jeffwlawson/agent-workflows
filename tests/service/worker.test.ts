import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CI_WAIT_SECONDS } from "../../review/collect-checks.js";
import { DEFAULT_REVIEW_MINUTES, sign, SIGNATURE_HEADER, type ReviewJob, type TokenKind } from "../../service/job.js";
import { jobDoor, REDACTED, runJob, SUMMARY_FILE, type Launch, type Subcommand } from "../../service/worker.js";
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
  variables: { AGENT_MODEL: "a-model", AGENT_MODEL_REVIEW: "", AGENT_REVIEW_TIMEOUT_MINUTES: "", AGENT_MAX_FIX_ROUNDS: "3" },
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
  } = {},
) => {
  /** Every edge the job touched, in the order it touched them. */
  const events: string[] = [];
  const launched: (Launch & { readonly emptyAtStart: boolean })[] = [];
  const asked: TokenKind[] = [];
  const runDir = path.join(scratch, "run");
  fs.mkdirSync(runDir);
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
      checkout: async ({ signal, ...rest }: { dir: string; sha: string; branch: string; baseRef: string; token: string; signal: AbortSignal }) => {
        events.push("checkout");
        checkouts.push(rest);
        if (options.checkoutHangs === true) {
          await hang(signal, 0);
          throw new Error("The operation was aborted");
        }
      },
    },
    host: options.host ?? HOST,
    agent: AGENT,
    cliBin: "/work/claude-code/bin",
    runDir,
    ...(options.minuteMs === undefined ? {} : { minuteMs: options.minuteMs }),
  };
  const checkouts: { dir: string; sha: string; branch: string; baseRef: string; token: string }[] = [];
  const env = (subcommand: Subcommand): Readonly<Record<string, string>> => {
    const found = launched.find((launch) => launch.subcommand === subcommand);
    if (found === undefined) throw new Error(`${subcommand} was not started`);
    return found.env;
  };
  return { edges, events, launched, asked, checkouts, env, runDir };
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
      { dir: path.join(s.runDir, "checkout"), repo: "owner/repo", branch: "agent/issue-7-a-thing", sha: HEAD, baseRef: "main", token: "read-token-1" },
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

  it("hands review:budget a fix-round budget of 0, whatever the repository's variable says", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(JOB.variables.AGENT_MAX_FIX_ROUNDS).toBe("3");
    expect(s.env("review:budget")).toMatchObject({ FIX_ROUND_BUDGET: "0", LOOP_TOKEN_SOURCE: "app", BASE_REF: "main" });
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
    const accepted: ReviewJob[] = [];
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
    expect(JSON.parse(response.body)).toEqual({ refusal: "`workflow` is not one of `review`" });
    expect(d.accepted).toEqual([]);
  });

  it("refuses a body that is not a job", () => {
    const d = door();

    expect(d.handle(request({ ...JOB, headSha: "not-a-commit" })).status).toBe(400);
    expect(d.accepted).toEqual([]);
  });
});
