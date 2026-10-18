import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitFetcher, type GitEnvironment } from "../../engine/git.js";
import { GitHubError } from "../../engine/github.js";
import type { GitHubReader } from "../../engine/read.js";
import { prepare } from "../../fix/prepare.js";
import type { FetchingIo } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { rescueRef } from "../../shared/rescue.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader } from "../engine/fakes.js";

/**
 * `fix:prepare` (#471), called the way the CLI calls it: its declared inputs,
 * a fake GitHub reader for the rescue's tip, and the engine's real fetcher,
 * fetching from a temporary bare repository standing in for the one on
 * GitHub into a clone checked out as the agent's job leaves it. What is
 * asserted is the ref it left in the checkout, and the sentence it stopped
 * with. The scenarios are the retired prepare step's, fix's half of
 * `tests/rescue-step.test.ts`, and its unreadable answer.
 */

const BRANCH = "agent/issue-7-add-a-widget";
const RESCUE = "agent/rescue/fix-12";
const TOKEN = "ghs_not-a-real-token-0123456789";
/** Building the repositories spawns git about a dozen times, and a case a few more. */
const CEILING = 20 * SUBPROCESS_TIMEOUT;

let scratch: string;
let origin: string;
let work: string;
let env: GitEnvironment;
let start: string;
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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fix-prepare-"));
  env = { PATH: process.env["PATH"] ?? "", HOME: scratch };
  origin = path.join(scratch, "origin.git");
  const seed = path.join(scratch, "seed");
  work = path.join(scratch, "work");
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(scratch, "init", "--quiet", "--initial-branch=main", seed);
  commit(seed, "README.md");
  git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
  git(seed, "checkout", "--quiet", "-b", BRANCH);
  start = commit(seed, "earlier.txt");
  git(seed, "push", "--quiet", origin, `HEAD:refs/heads/${BRANCH}`);
  git(scratch, "clone", "--quiet", "--branch", BRANCH, origin, work);
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
  const seed = path.join(scratch, "seed");
  git(seed, "checkout", "--quiet", "-b", "stopped");
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

const run = (github: GitHubReader = readerOfOrigin()): Promise<void> => {
  const io: FetchingIo<(typeof COMMANDS)["fix:prepare"]["outputs"]> = {
    github,
    fetcher: gitFetcher({ dir: work, env, remote: origin }, TOKEN),
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  return prepare({ OUTPUT_DIR: "/out", GH_REPO: "o/r", GH_TOKEN: TOKEN, CHECKOUT: work, RESCUE_BRANCH: RESCUE }, io);
};

describe("fix:prepare fetches the rescue branch for the runner to resume from", { timeout: CEILING }, () => {
  it("fetches a rescue an earlier run left to where the runner looks for it", async () => {
    const rescued = leaveRescue();

    await run();

    expect(tip(work, rescueRef(RESCUE))).toBe(rescued);
    expect(logged).toContain(`Fetched ${RESCUE}, which an earlier run left, for the runner to resume from.`);
  });

  it("leaves the checkout as it found it", async () => {
    leaveRescue();

    await run();

    expect(tip(work, "HEAD")).toBe(start);
    expect(git(work, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
    expect(tip(work, `refs/heads/${RESCUE}`)).toBe("");
  });

  it("fetches nothing where there is no rescue branch, a 404", async () => {
    await run();

    expect(tip(work, rescueRef(RESCUE))).toBe("");
    expect(logged).toContain(`No ${RESCUE}, so there is nothing to resume from.`);
  });

  it("stops, with today's sentence, where the rescue's tip cannot be read", async () => {
    leaveRescue();

    await expect(run(tipThrows(new GitHubError("GET branches failed", 502)))).rejects.toThrow(
      `Couldn't check whether an earlier run left commits on \`${RESCUE}\`, so this run stopped rather than start over without them.`,
    );
    expect(tip(work, rescueRef(RESCUE))).toBe("");
  });

  it("stops on an unreadable answer that is not GitHub's either, rather than read it as no rescue", async () => {
    await expect(run(tipThrows(new Error("socket hang up")))).rejects.toThrow(/^Couldn't check whether an earlier run left commits/);
  });

  it("stops, naming the branch, where the rescue is there but cannot be fetched", async () => {
    // GitHub reports a rescue the remote does not hold: the fetch's answer is the one that fails.
    const github = fakeGitHub();
    github.branches.set(RESCUE, "f".repeat(40));

    await expect(run(fakeReader(github).reader)).rejects.toThrow(
      new RegExp(`^Couldn't fetch \`${RESCUE}\`, which an earlier run left, so this run stopped rather than start over without it: `),
    );
  });
});
