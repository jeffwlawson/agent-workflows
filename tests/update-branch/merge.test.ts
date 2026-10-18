import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitFetcher, gitMerger, type GitEnvironment } from "../../engine/git.js";
import type { MergingIo } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { LOOP_COMMITTER } from "../../shared/record.js";
import { merge } from "../../update-branch/merge.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader } from "../engine/fakes.js";

/**
 * `update-branch:merge` (#481), called the way the CLI calls it: its declared
 * inputs, and the engine's real fetcher and merger, fetching from a temporary
 * bare repository standing in for the one on GitHub into a clone checked out
 * at the pull request's head, as the gate job's checkout leaves it. What is
 * asserted is `merge.json`, and the sentence it stopped with. The scenarios
 * are the retired *Attempt the merge* step's, and the reason its failed fetch
 * never gave.
 */

const BRANCH = "agent/issue-7-add-a-widget";
const TOKEN = "ghs_not-a-real-token-0123456789";
/** Building the repositories spawns git about a dozen times, and a case a few more. */
const CEILING = 20 * SUBPROCESS_TIMEOUT;

let scratch: string;
let origin: string;
let seed: string;
let work: string;
let env: GitEnvironment;
let head: string;
let written: Record<string, unknown>;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT,
    env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();

const commit = (cwd: string, file: string, text = `${file}\n`): string => {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
};

/** `main` on `origin` moved on by a commit to `file`. */
const moveMain = (file: string, text?: string): string => {
  git(seed, "checkout", "--quiet", "main");
  const moved = commit(seed, file, text);
  git(seed, "push", "--quiet", origin, "main");
  return moved;
};

/** The clone at the pull request's head, detached, as `actions/checkout` leaves it. */
const checkOut = (): void => {
  git(scratch, "clone", "--quiet", "--no-checkout", origin, work);
  git(work, "checkout", "--quiet", "--detach", head);
};

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "update-branch-merge-"));
  env = { PATH: process.env["PATH"] ?? "", HOME: scratch };
  origin = path.join(scratch, "origin.git");
  seed = path.join(scratch, "seed");
  work = path.join(scratch, "work");
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(scratch, "init", "--quiet", "--initial-branch=main", seed);
  commit(seed, "README.md");
  git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
  git(seed, "checkout", "--quiet", "-b", BRANCH);
  head = commit(seed, "widget.txt");
  git(seed, "push", "--quiet", origin, `HEAD:refs/heads/${BRANCH}`);
  written = {};
  vi.spyOn(console, "log").mockImplementation(() => {});
}, CEILING);

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const run = (base = "main"): Promise<void> => {
  const fetcher = gitFetcher({ dir: work, env, remote: origin }, TOKEN);
  const io: MergingIo<(typeof COMMANDS)["update-branch:merge"]["outputs"]> = {
    github: fakeReader(fakeGitHub()).reader,
    fetcher,
    merger: gitMerger({ dir: work, env }, fetcher),
    outputs: {
      writeJson: (name, value) => {
        written[name] = value;
      },
      writeText: () => {},
      writeBytes: () => {},
      appendLine: () => {},
    },
  };
  return merge({ OUTPUT_DIR: "/out", GH_REPO: "o/r", GH_TOKEN: TOKEN, CHECKOUT: work, BRANCH, BASE_REF: base }, io);
};

describe("update-branch:merge says what the merge came to", { timeout: CEILING }, () => {
  it("is up to date where the branch already holds the base", async () => {
    checkOut();

    await run();

    expect(written).toEqual({ "merge.json": { status: "uptodate", base: git(seed, "rev-parse", "main"), conflicts: [] } });
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
  });

  it("is clean where the base merges in without a conflict, with the base commit it merged, as the loop's committer", async () => {
    const moved = moveMain("other.txt");
    checkOut();

    await run();

    expect(written).toEqual({ "merge.json": { status: "clean", base: moved, conflicts: [] } });
    expect(git(work, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
    expect(git(work, "log", "-1", "--format=%cn <%ce>")).toBe(`${LOOP_COMMITTER.name} <${LOOP_COMMITTER.email}>`);
  });

  it("is conflicts where it stops on one, naming each conflicted path", async () => {
    const moved = moveMain("widget.txt", "main's widget\n");
    checkOut();

    await run();

    expect(written).toEqual({ "merge.json": { status: "conflicts", base: moved, conflicts: ["widget.txt"] } });
  });

  /** Today's step ended with a bare `exit 1` here, and the failure comment had no reason to give. */
  it("stops with a sentence, and writes no merge.json, where the base cannot be fetched", async () => {
    checkOut();

    await expect(run("gone")).rejects.toThrow(/^Couldn't fetch `gone` to merge it, so the branch was left untouched: /);
    expect(written).toEqual({});
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
  });

  /** A merge that fails on no conflict is no `conflicts` with nothing in it for an agent to resolve. */
  it("stops with a sentence where the merge fails without a conflict", async () => {
    git(seed, "checkout", "--quiet", "--orphan", "unrelated");
    git(seed, "rm", "--quiet", "-rf", ".");
    commit(seed, "elsewhere.txt");
    git(seed, "push", "--quiet", "--force", origin, "HEAD:refs/heads/main");
    checkOut();

    await expect(run()).rejects.toThrow(/^Couldn't merge `main` into `agent\/issue-7-add-a-widget`, so the branch was left untouched: .*unrelated histories/);
    expect(written).toEqual({});
  });
});
