import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitFetcher, type GitEnvironment } from "../../engine/git.js";
import { GitHubError } from "../../engine/github.js";
import type { GitHubReader } from "../../engine/read.js";
import { prepare } from "../../implement-prd/prepare.js";
import type { FetchingIo } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { LOOP_COMMITTER } from "../../shared/record.js";
import { rescueRef } from "../../shared/rescue.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader } from "../engine/fakes.js";

/**
 * `implement-prd:prepare` (#501), called the way the CLI calls it: its
 * declared inputs, a fake GitHub reader for the rescue's tip, and the
 * engine's real fetcher, fetching from a temporary bare repository standing
 * in for the one on GitHub into a clone of the default branch, as the agent's
 * job's checkout leaves it. What is asserted is the branch it checked out, the
 * refs it left, and the sentence it stopped with. The scenarios are the
 * retired *Prepare the PRD branch* step's, implement-prd's half of
 * `tests/rescue-step.test.ts`, and its unreadable answer.
 */

const BRANCH = "agent/prd-9-widgets";
const RESCUE = "agent/rescue/prd-9";
const TOKEN = "ghs_not-a-real-token-0123456789";
/** Building the repositories spawns git about a dozen times, and a case a few more. */
const CEILING = 20 * SUBPROCESS_TIMEOUT;

let scratch: string;
let origin: string;
let seed: string;
let work: string;
let env: GitEnvironment;
/** The default branch's tip, which the agent's job's checkout holds. */
let base: string;
/** The PRD branch's tip on `origin`, as the catch-up left it. */
let head: string;
let logged: string[];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT,
    env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();

const commit = (cwd: string, file: string): string => {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
};

/** What `ref` points at in `cwd`, or "" where it is not there. */
const tip = (cwd: string, ref: string): string => {
  try {
    return git(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "implement-prd-prepare-"));
  env = { PATH: process.env["PATH"] ?? "", HOME: scratch };
  origin = path.join(scratch, "origin.git");
  seed = path.join(scratch, "seed");
  work = path.join(scratch, "work");
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(scratch, "init", "--quiet", "--initial-branch=main", seed);
  base = commit(seed, "README.md");
  git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
  git(seed, "checkout", "--quiet", "-b", BRANCH);
  head = commit(seed, "earlier-slice.txt");
  git(seed, "push", "--quiet", origin, `HEAD:refs/heads/${BRANCH}`);
  // The agent's job checks the default branch out, and only that: the PRD
  // branch reaches it through the fetch.
  git(scratch, "clone", "--quiet", "--single-branch", "--branch", "main", origin, work);
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
}, CEILING);

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A commit on the rescue branch on `origin`, as an earlier stopped run left it. */
const leaveRescue = (): string => {
  git(seed, "checkout", "--quiet", "-b", "stopped", head);
  const rescued = commit(seed, "stopped.txt");
  git(seed, "push", "--quiet", origin, `HEAD:refs/heads/${RESCUE}`);
  return rescued;
};

/** The fake's reader, holding `origin`'s branches as GitHub would report them. */
const readerOfOrigin = (): GitHubReader => {
  const github = fakeGitHub();
  for (const line of git(origin, "for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads").split("\n")) {
    const [name, sha] = line.split(" ");
    if (name !== undefined && sha !== undefined) github.branches.set(name, sha);
  }
  return fakeReader(github).reader;
};

/** A reader whose `branchTip` throws `error`, otherwise the fake's. */
const tipThrows = (error: unknown): GitHubReader => ({
  ...readerOfOrigin(),
  branchTip: async () => {
    throw error;
  },
});

/** The command, on a PRD branch that exists unless `PRD_TIP` says otherwise, at the catch-up's `BASE_SHA`. */
const run = (inputs: { readonly PRD_TIP?: string; readonly BASE_SHA?: string } = {}, github: GitHubReader = readerOfOrigin()): Promise<void> => {
  const io: FetchingIo<(typeof COMMANDS)["implement-prd:prepare"]["outputs"]> = {
    github,
    fetcher: gitFetcher({ dir: work, env, remote: origin }, TOKEN),
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  return prepare(
    {
      OUTPUT_DIR: "/out",
      GH_REPO: "o/r",
      GH_TOKEN: TOKEN,
      CHECKOUT: work,
      PRD_BRANCH: BRANCH,
      PRD_TIP: inputs.PRD_TIP ?? head,
      BASE_SHA: inputs.BASE_SHA ?? head,
      SUB: "10",
      RESCUE_BRANCH: RESCUE,
    },
    io,
  );
};

describe("implement-prd:prepare checks the PRD branch out at the catch-up's tip", { timeout: CEILING }, () => {
  it("fetches an existing PRD branch and checks it out at the tip the catch-up left, as the loop's committer", async () => {
    await run();

    expect(git(work, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
    expect(tip(work, "HEAD")).toBe(head);
    // Under `refs/remotes/`, as the remote's.
    expect(tip(work, `refs/remotes/origin/${BRANCH}`)).toBe(head);
    expect(git(work, "config", "user.name")).toBe(LOOP_COMMITTER.name);
    expect(git(work, "config", "user.email")).toBe(LOOP_COMMITTER.email);
    expect(logged).toContain(`Building sub-issue #10 on ${BRANCH} at ${head}.`);
  });

  /** The agent builds on exactly the tip the publish job checks against, not one pushed since. */
  it("checks out the catch-up's tip, not a tip pushed to the PRD branch since", async () => {
    git(seed, "checkout", "--quiet", BRANCH);
    const later = commit(seed, "pushed-since.txt");
    git(seed, "push", "--quiet", origin, `HEAD:refs/heads/${BRANCH}`);

    await run();

    expect(tip(work, "HEAD")).toBe(head);
    expect(tip(work, `refs/remotes/origin/${BRANCH}`)).toBe(later);
  });

  it("makes a PRD branch the gate found none of at the catch-up's tip, the base, fetching nothing", async () => {
    await run({ PRD_TIP: "", BASE_SHA: base });

    expect(git(work, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
    expect(tip(work, "HEAD")).toBe(base);
    expect(tip(work, `refs/remotes/origin/${BRANCH}`)).toBe("");
  });

  it("stops, naming the branch, where the PRD branch cannot be fetched", async () => {
    git(origin, "update-ref", "-d", `refs/heads/${BRANCH}`);

    await expect(run()).rejects.toThrow(new RegExp(`^Couldn't fetch \`${BRANCH}\` to build sub-issue #10 on it, so nothing was built: `));
    expect(tip(work, `refs/heads/${BRANCH}`)).toBe("");
  });

  it("stops where the checkout doesn't hold the catch-up's tip, and checks nothing out", async () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";

    await expect(run({ PRD_TIP: "", BASE_SHA: missing })).rejects.toThrow(
      `The checkout doesn't hold ${missing}, the tip \`${BRANCH}\` was brought up to date at for this run, so nothing was built.`,
    );
    expect(tip(work, `refs/heads/${BRANCH}`)).toBe("");
  });
});

describe("implement-prd:prepare fetches the rescue branch for the runner to resume from", { timeout: CEILING }, () => {
  it("fetches a rescue an earlier run left to where the runner looks for it, outside refs/remotes/", async () => {
    const rescued = leaveRescue();

    await run();

    expect(tip(work, rescueRef(RESCUE))).toBe(rescued);
    expect(rescueRef(RESCUE).startsWith("refs/remotes/")).toBe(false);
    expect(tip(work, "HEAD")).toBe(head);
    expect(logged).toContain(`Fetched ${RESCUE}, which an earlier run left, for the runner to resume from.`);
  });

  it("fetches nothing where there is no rescue branch, a 404, and goes on", async () => {
    await run();

    expect(tip(work, rescueRef(RESCUE))).toBe("");
    expect(logged).toContain(`No ${RESCUE}, so there is nothing to resume from.`);
  });

  it("stops, with today's sentence, where the rescue's tip cannot be read", async () => {
    leaveRescue();

    await expect(run({}, tipThrows(new GitHubError("GET branches failed", 502)))).rejects.toThrow(
      `Couldn't check whether an earlier run left commits on \`${RESCUE}\`, so this run stopped rather than start over without them.`,
    );
    expect(tip(work, rescueRef(RESCUE))).toBe("");
  });

  it("stops, naming the branch, where the rescue is there but cannot be fetched", async () => {
    // GitHub reports a rescue the remote does not hold: the fetch's answer is the one that fails.
    const github = fakeGitHub();
    github.branches.set(RESCUE, "f".repeat(40));

    await expect(run({}, fakeReader(github).reader)).rejects.toThrow(
      new RegExp(`^Couldn't fetch \`${RESCUE}\`, which an earlier run left, so this run stopped rather than start over without it: `),
    );
  });
});
