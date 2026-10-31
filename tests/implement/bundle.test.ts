import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundle } from "../../implement/bundle.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `implement:bundle` (#491), called the way the CLI calls it: its declared
 * inputs, with `CHECKOUT` a real git repository shaped as the agent's job
 * leaves one, the agent's branch created at the gate's base commit and
 * committed on, and its declared outputs. What is asserted is the bundle it
 * wrote, read back by git in a repository holding only what the publish job
 * holds, or the sentence it refused with. The scenarios are the retired
 * *Bundle the branch* step's, with the gate's base commit in place of the
 * base branch as its prerequisite.
 */

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Building the repositories spawns git about a dozen times, and a case a few more. */
const CEILING = 20 * SUBPROCESS_TIMEOUT;

const BRANCH = "agent/issue-7-add-a-widget";

const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "implement-bundle-"));

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

const commit = (root: string, file: string): string => {
  fs.writeFileSync(path.join(root, file), file);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", file);
  return git(root, "rev-parse", "HEAD");
};

/**
 * The agent's job's checkout: `main` with the gate's base commit and one
 * landed after it, and the agent's branch created at the base commit and
 * checked out, as `implement:prepare` leaves it.
 */
const checkout = (): { readonly root: string; readonly base: string } => {
  const root = scratch();
  git(root, "init", "--quiet", "--initial-branch=main");
  const base = commit(root, "base.txt");
  commit(root, "later.txt");
  git(root, "checkout", "--quiet", "-b", BRANCH, base);
  return { root, base };
};

/** The files `bundle` writes, as the CLI would hand it its outputs. */
const run = (root: string, base: string, branch = BRANCH): ReadonlyMap<string, Uint8Array> => {
  const written = new Map<string, Uint8Array>();
  bundle(
    { OUTPUT_DIR: "", CHECKOUT: root, BRANCH: branch, BASE_SHA: base },
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

describe("implement:bundle", () => {
  it(
    "bundles the branch and nothing else, with the gate's base commit its prerequisite",
    () => {
      const { root, base } = checkout();
      commit(root, "one.txt");
      const tip = commit(root, "two.txt");
      git(root, "branch", "unrelated");

      const file = saved(run(root, base).get("branch.bundle"));

      expect(git(root, "bundle", "list-heads", file)).toBe(`${tip} refs/heads/${BRANCH}`);
      // Thin: the base commit is its one prerequisite, so it carries the
      // agent's two commits and nothing of the base's.
      const clone = scratch();
      git(clone, "init", "--quiet");
      expect(() => git(clone, "bundle", "verify", file)).toThrow(new RegExp(base));
      git(clone, "fetch", "--quiet", root, base);
      git(clone, "bundle", "verify", file);
      git(clone, "fetch", "--quiet", file, `refs/heads/${BRANCH}:refs/heads/fetched`);
      expect(git(clone, "rev-list", "--count", `${base}..fetched`)).toBe("2");
    },
    CEILING,
  );

  it(
    "refuses where the agent made no commits on the branch",
    () => {
      const { root, base } = checkout();

      expect(() => run(root, base)).toThrow(
        `The agent finished without committing on \`${BRANCH}\`, so nothing was handed to the publish job.`,
      );
    },
    CEILING,
  );

  it(
    "refuses where the branch was never created",
    () => {
      const { root, base } = checkout();

      expect(() => run(root, base, "agent/never-checked-out")).toThrow(
        "The agent's job has no `agent/never-checked-out` to hand over, so nothing was handed to the publish job.",
      );
    },
    CEILING,
  );

  it(
    "fails, naming the branch, where the base commit is not in the checkout",
    () => {
      const { root } = checkout();
      commit(root, "one.txt");

      expect(() => run(root, "0123456789abcdef0123456789abcdef01234567")).toThrow(
        /^Couldn't bundle the agent's commits on `agent\/issue-7-add-a-widget`, so none were handed to the publish job: /,
      );
    },
    CEILING,
  );
});
