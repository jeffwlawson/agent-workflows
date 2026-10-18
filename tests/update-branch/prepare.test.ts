import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitFetcher, gitMerger, type GitEnvironment } from "../../engine/git.js";
import type { MergingIo } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { LOOP_COMMITTER } from "../../shared/record.js";
import { prepare } from "../../update-branch/prepare.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader } from "../engine/fakes.js";

/**
 * `update-branch:prepare` (#482), called the way the CLI calls it: its
 * declared inputs, and the engine's real fetcher and merger, fetching from a
 * temporary bare repository standing in for the one on GitHub into a clone
 * checked out at the pull request's head, as the agent's job's checkout
 * leaves it. What is asserted is the tree it leaves for the agent, and the
 * sentence it stopped with. The scenarios are the retired *Repeat the
 * conflicted merge* step's, each refusal with its sentence.
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
let logged: string[];

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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "update-branch-prepare-"));
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
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
}, CEILING);

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const run = (baseSha: string, base = "main"): Promise<void> => {
  const fetcher = gitFetcher({ dir: work, env, remote: origin }, TOKEN);
  const io: MergingIo<(typeof COMMANDS)["update-branch:prepare"]["outputs"]> = {
    github: fakeReader(fakeGitHub()).reader,
    fetcher,
    merger: gitMerger({ dir: work, env }, fetcher),
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  return prepare({ OUTPUT_DIR: "/out", GH_REPO: "o/r", GH_TOKEN: TOKEN, CHECKOUT: work, BRANCH, BASE_REF: base, BASE_SHA: baseSha }, io);
};

describe("update-branch:prepare makes the gate's conflicted merge again for the agent", { timeout: CEILING }, () => {
  it("leaves the agent's tree conflicted on BRANCH, merged by the loop's committer", async () => {
    const gate = moveMain("widget.txt", "main's widget\n");
    checkOut();

    await run(gate);

    expect(git(work, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "rev-parse", "MERGE_HEAD")).toBe(gate);
    expect(git(work, "diff", "--name-only", "--diff-filter=U")).toBe("widget.txt");
    expect(fs.readFileSync(path.join(work, "widget.txt"), "utf8")).toContain("<<<<<<<");
    expect(git(work, "config", "user.name")).toBe(LOOP_COMMITTER.name);
    expect(git(work, "config", "user.email")).toBe(LOOP_COMMITTER.email);
    expect(logged).toContain(`Conflicts merging main (${gate}) again, for the agent, in: widget.txt`);
  });

  /** The gate's base commit, not the base's tip by now, so the agent resolves the merge the gate decided on. */
  it("merges the base commit the gate merged, where the base has moved on since", async () => {
    const gate = moveMain("widget.txt", "main's widget\n");
    const later = moveMain("later.txt");
    checkOut();

    await run(gate);

    expect(git(work, "rev-parse", "MERGE_HEAD")).toBe(gate);
    expect(git(work, "rev-parse", `refs/remotes/origin/main`)).toBe(gate);
    expect(fs.existsSync(path.join(work, "later.txt"))).toBe(false);
    expect(later).not.toBe(gate);
  });

  it("refuses, with today's sentence, where the base no longer holds the commit the gate merged", async () => {
    const gate = moveMain("widget.txt", "main's widget\n");
    checkOut();
    git(seed, "reset", "--quiet", "--hard", "HEAD~1");
    commit(seed, "rewritten.txt");
    git(seed, "push", "--quiet", "--force", origin, "main");

    await expect(run(gate)).rejects.toThrow(
      new Error("`main` no longer holds the commit this run set out to merge, so the branch was left untouched."),
    );
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(() => git(work, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toThrow();
  });

  it("refuses, with today's sentence, where the merge no longer conflicts", async () => {
    const gate = moveMain("other.txt");
    checkOut();

    await expect(run(gate)).rejects.toThrow(
      new Error("Merging `main` again didn't conflict, so there was nothing for the agent to resolve and the branch was left untouched."),
    );
  });

  it("refuses with the same sentence where the branch already holds the base", async () => {
    checkOut();

    await expect(run(git(seed, "rev-parse", "main"))).rejects.toThrow(/^Merging `main` again didn't conflict/);
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
  });

  it("stops, with today's sentence and git's reason, where the base cannot be fetched", async () => {
    checkOut();

    await expect(run("f".repeat(40), "gone")).rejects.toThrow(
      /^Couldn't fetch `gone` to merge it again for the agent, so the branch was left untouched: /,
    );
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(() => git(work, "symbolic-ref", "--quiet", "HEAD")).toThrow();
  });
});
