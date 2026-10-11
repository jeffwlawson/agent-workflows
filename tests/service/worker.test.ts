import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sign, SIGNATURE_HEADER, type ReviewJob, type TokenKind } from "../../service/job.js";
import { jobDoor, runJob, type Launch, type Subcommand } from "../../service/worker.js";
import { COMMANDS, RUNNERS, type Command, type Runner } from "../../shared/contract.js";

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

/** What a subcommand writes into its `OUTPUT_DIR`, and how it exits. */
interface Canned {
  readonly files?: Readonly<Record<string, unknown>>;
  readonly exit?: number;
}

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

const setup = (canned: Readonly<Partial<Record<Subcommand, Canned>>> = ORDINARY) => {
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
      return `${kind}-token-${asked.length}`;
    },
    launch: async (launch: Launch) => {
      const dir = launch.env["OUTPUT_DIR"];
      if (dir === undefined) throw new Error(`${launch.subcommand} was started with no OUTPUT_DIR`);
      launched.push({ ...launch, emptyAtStart: fs.readdirSync(dir).length === 0 });
      events.push(launch.subcommand);
      const { files = {}, exit = 0 } = canned[launch.subcommand] ?? {};
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
      }
      return exit;
    },
    git: {
      checkout: async (options: { dir: string; sha: string; branch: string; baseRef: string; token: string }) => {
        events.push("checkout");
        checkouts.push(options);
      },
    },
    host: HOST,
    agent: AGENT,
    cliBin: "/work/claude-code/bin",
    runDir,
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

  it("puts the worker's own claude first on the runner's PATH, and no other's", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.env("review")["PATH"]).toBe(`/work/claude-code/bin:${HOST.PATH}`);
    expect(s.env("review:gate")["PATH"]).toBe(HOST.PATH);
  });

  it("hands the runner the agent's token, the sandbox's settings, and the read token as GH_TOKEN", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    expect(s.env("review")).toMatchObject({ ...AGENT, GH_TOKEN: "read-token-1", AGENT_MODEL: "a-model", AGENT_LOOP_LOGINS: "loop-app[bot]" });
    expect(s.env("review")).not.toHaveProperty("AGENT_MODEL_REVIEW");
    expect(s.env("review")).not.toHaveProperty("RED_CHECK_CONFIGURED");
  });

  it("puts no write token in the runner's environment, or in any command's that only reads", async () => {
    const s = setup();
    await runJob(JOB, s.edges);

    for (const subcommand of READ_ONLY) {
      expect(Object.values(s.env(subcommand)).filter((value) => value.includes("write-token")), subcommand).toEqual([]);
    }
    expect(s.env("review:publish")).toMatchObject({ GH_TOKEN: "write-token-2", LOOP_TOKEN: "write-token-2", LOOP_TOKEN_SOURCE: "app" });
    expect(s.env("review:conclude")).toMatchObject({ GH_TOKEN: "write-token-2", LOOP_TOKEN: "write-token-2", LOOP_TOKEN_SOURCE: "app" });
    expect(s.asked).toEqual(["read", "write"]);
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
    });
    // There is no Actions run to link to.
    for (const name of ["GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"]) {
      expect(s.env("review:conclude")).not.toHaveProperty(name);
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

  it("refuses a body that is not a job", () => {
    const d = door();

    expect(d.handle(request({ ...JOB, headSha: "not-a-commit" })).status).toBe(400);
    expect(d.accepted).toEqual([]);
  });
});
