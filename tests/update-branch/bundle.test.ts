import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundle } from "../../update-branch/bundle.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `update-branch:bundle` (#483), called the way the CLI calls it: its
 * declared inputs, with `CHECKOUT` a real git repository shaped as the agent's
 * job leaves one, the pull request's head checked out as `BRANCH` with the
 * base merged into it, and its declared outputs. What is asserted is the
 * bundle it wrote, read back by git in a repository holding only what the
 * publish job holds, or the sentence it refused with. The scenarios are the
 * retired *Bundle the branch* step's.
 */

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Building the repositories spawns git about a dozen times, and a case a few more. */
const CEILING = 20 * SUBPROCESS_TIMEOUT;

const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "update-branch-bundle-"));

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

const commit = (root: string, file: string, text: string): string => {
  fs.writeFileSync(path.join(root, file), text);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", `${file}: ${text}`);
  return git(root, "rev-parse", "HEAD");
};

const BRANCH = "agent/issue-7-add-a-widget";

/**
 * A checkout whose `main` and `BRANCH` both changed one file since they
 * parted, with `main` merged into `BRANCH` and stopped on that conflict, as
 * `update-branch:prepare` leaves it for the agent.
 */
const conflicted = (): { readonly root: string; readonly head: string; readonly base: string } => {
  const root = scratch();
  git(root, "init", "--quiet", "--initial-branch=main");
  commit(root, "shared.txt", "start\n");
  git(root, "checkout", "--quiet", "-b", BRANCH);
  const head = commit(root, "shared.txt", "branch\n");
  git(root, "checkout", "--quiet", "main");
  const base = commit(root, "shared.txt", "main\n");
  git(root, "checkout", "--quiet", BRANCH);
  expect(() => git(root, "merge", "--no-edit", "main")).toThrow();
  return { root, head, base };
};

/** The agent's resolution: the conflict resolved and the merge committed. */
const resolve = (root: string): string => {
  fs.writeFileSync(path.join(root, "shared.txt"), "both\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "--quiet", "--no-edit");
  return git(root, "rev-parse", "HEAD");
};

/** The files `bundle` writes, as the CLI would hand it its outputs. */
const run = (root: string, head: string, base: string, branch = BRANCH): ReadonlyMap<string, Uint8Array> => {
  const written = new Map<string, Uint8Array>();
  bundle(
    { OUTPUT_DIR: "", CHECKOUT: root, BRANCH: branch, HEAD_SHA: head, BASE_SHA: base },
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

describe("update-branch:bundle", () => {
  it(
    "bundles a resolved merge, which unbundles in a checkout holding only the head and the base commit",
    () => {
      const { root, head, base } = conflicted();
      const tip = resolve(root);
      git(root, "branch", "unrelated");

      const file = saved(run(root, head, base).get("branch.bundle"));

      expect(git(root, "bundle", "list-heads", file)).toBe(`${tip} refs/heads/${BRANCH}`);
      // Thin: the head and the base commit are its prerequisites, so a
      // repository holding neither cannot read it.
      const empty = scratch();
      git(empty, "init", "--quiet");
      expect(() => git(empty, "bundle", "verify", file)).toThrow();
      // One holding only the head is short of the base commit too.
      const headOnly = scratch();
      git(headOnly, "init", "--quiet");
      git(headOnly, "fetch", "--quiet", root, head);
      expect(() => git(headOnly, "bundle", "verify", file)).toThrow();
      // The publish job holds both, and the bundle carries the merge alone.
      const publish = scratch();
      git(publish, "init", "--quiet");
      git(publish, "fetch", "--quiet", root, head, base);
      git(publish, "bundle", "verify", "--quiet", file);
      git(publish, "fetch", "--quiet", file, `refs/heads/${BRANCH}:refs/heads/fetched`);
      expect(git(publish, "rev-parse", "fetched")).toBe(tip);
      expect(git(publish, "rev-list", "--count", "fetched", `^${head}`, `^${base}`)).toBe("1");
    },
    CEILING,
  );

  it(
    "refuses, with a reason, where the agent committed nothing on the branch",
    () => {
      const { root, head, base } = conflicted();
      git(root, "merge", "--abort");

      expect(() => run(root, head, base)).toThrow(
        "The agent finished without committing a merge of the base into `agent/issue-7-add-a-widget`, so there was no resolution to push and the branch was left untouched.",
      );
    },
    CEILING,
  );

  it(
    "refuses, with a reason, where the branch holds nothing the base did not already",
    () => {
      const { root, head, base } = conflicted();
      git(root, "merge", "--abort");
      git(root, "reset", "--quiet", "--hard", base);

      expect(() => run(root, head, base)).toThrow(/^The agent finished without committing a merge of the base/);
    },
    CEILING,
  );

  it(
    "refuses, naming it, where the branch was never created",
    () => {
      const { root, head, base } = conflicted();

      expect(() => run(root, head, base, "agent/never-checked-out")).toThrow(
        "The agent's job has no `agent/never-checked-out` to hand over, so the branch was left untouched.",
      );
    },
    CEILING,
  );

  it(
    "fails, naming the branch, where the base commit is not in the checkout",
    () => {
      const { root, head } = conflicted();
      resolve(root);

      expect(() => run(root, head, "0123456789abcdef0123456789abcdef01234567")).toThrow(
        /^Couldn't bundle the agent's resolution on `agent\/issue-7-add-a-widget`, so none was handed to the publish job/,
      );
    },
    CEILING,
  );
});
