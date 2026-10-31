import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundle } from "../../fix/bundle.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `fix:bundle` (#472), called the way the CLI calls it: its declared inputs,
 * with `CHECKOUT` a real git repository shaped as the agent's job leaves one,
 * the pull request's head checked out as `BRANCH`, and its declared outputs.
 * What is asserted is the bundle it wrote, read back by git, or that it wrote
 * none. The scenarios are the retired *Bundle the branch* step's.
 */

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fix-bundle-"));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

const commit = (root: string, file: string, message: string): string => {
  fs.writeFileSync(path.join(root, file), message);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const BRANCH = "agent/fix-me";

/** A checkout with a base commit and the pull request's head on `BRANCH`, checked out. */
const checkout = (): { readonly root: string; readonly head: string } => {
  const root = scratch();
  git(root, "init", "--quiet", "--initial-branch=main");
  commit(root, "base.txt", "base");
  git(root, "checkout", "--quiet", "-b", BRANCH);
  const head = commit(root, "head.txt", "head");
  return { root, head };
};

/** The files `bundle` writes, as the CLI would hand it its outputs. */
const run = (root: string, head: string, branch = BRANCH): ReadonlyMap<string, Uint8Array> => {
  const written = new Map<string, Uint8Array>();
  bundle(
    { OUTPUT_DIR: "", CHECKOUT: root, BRANCH: branch, HEAD_SHA: head },
    {
      writeJson: () => {},
      writeText: () => {},
      writeBytes: (name, value) => written.set(name, value),
      appendLine: () => {},
    },
  );
  return written;
};

/** The bundle written to disk, where git can read it. */
const saved = (bytes: Uint8Array | undefined): string => {
  expect(bytes, "no branch.bundle written").toBeDefined();
  const file = path.join(scratch(), "branch.bundle");
  fs.writeFileSync(file, bytes ?? new Uint8Array());
  return file;
};

describe("fix:bundle", () => {
  it("bundles the commits ahead of the head the run started from, as the branch and nothing else", () => {
    const { root, head } = checkout();
    commit(root, "fix-1.txt", "fix one");
    const tip = commit(root, "fix-2.txt", "fix two");
    git(root, "branch", "unrelated");

    const file = saved(run(root, head).get("branch.bundle"));

    expect(git(root, "bundle", "list-heads", file)).toBe(`${tip} refs/heads/${BRANCH}`);
    // Thin: the head it started from is its one prerequisite, so it carries
    // the run's two commits and none of the pull request's.
    expect(git(root, "bundle", "verify", file)).toContain(head);
    const clone = scratch();
    git(clone, "init", "--quiet");
    expect(() => git(clone, "bundle", "verify", file)).toThrow();
    git(clone, "fetch", "--quiet", root, head);
    git(clone, "fetch", "--quiet", file, `refs/heads/${BRANCH}:refs/heads/fetched`);
    expect(git(clone, "rev-list", "--count", `${head}..fetched`)).toBe("2");
  });

  it("writes nothing where there are no commits ahead of the head", () => {
    const { root, head } = checkout();

    expect(run(root, head).size).toBe(0);
  });

  it("writes nothing where the branch was never created", () => {
    const { root, head } = checkout();

    expect(run(root, head, "agent/never-checked-out").size).toBe(0);
  });

  it("fails, naming the branch, where the head it started from is not in the checkout", () => {
    const { root } = checkout();
    commit(root, "fix.txt", "fix");

    expect(() => run(root, "0123456789abcdef0123456789abcdef01234567")).toThrow(
      /^Couldn't bundle the agent's commits on `agent\/fix-me` ahead of 0123456789abcdef0123456789abcdef01234567/,
    );
  });
});
