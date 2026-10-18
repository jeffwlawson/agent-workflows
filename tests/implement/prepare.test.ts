import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepare } from "../../implement/prepare.js";
import { LOOP_COMMITTER } from "../../shared/record.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `implement:prepare` (#491), called the way the CLI calls it: its declared
 * inputs, with `CHECKOUT` a real git repository shaped as the agent's job's
 * checkout of the base branch leaves it. What is asserted is the branch it
 * leaves checked out for the agent, the identity the agent commits as, and
 * the sentence it stopped with. The scenarios are the retired *Create branch*
 * step's, and the base commit the gate read in place of the base's tip.
 */

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Building the repository spawns git about ten times, and a case a few more. */
const CEILING = 20 * SUBPROCESS_TIMEOUT;

const BRANCH = "agent/issue-7-add-a-widget";

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
 * The base branch checked out, as the agent's job's checkout leaves it, with
 * the commit the gate read and one landed on the base after it.
 */
const checkout = (): { readonly root: string; readonly base: string; readonly tip: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "implement-prepare-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  const base = commit(root, "base.txt");
  const tip = commit(root, "later.txt");
  return { root, base, tip };
};

const run = (root: string, base: string): void => {
  prepare({ OUTPUT_DIR: "", CHECKOUT: root, BRANCH, BASE_REF: "main", BASE_SHA: base });
};

describe("implement:prepare", () => {
  it(
    "checks out the agent's branch at the base commit the gate read, not the base's tip",
    () => {
      const { root, base, tip } = checkout();

      run(root, base);

      expect(git(root, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
      expect(git(root, "rev-parse", "HEAD")).toBe(base);
      expect(git(root, "rev-parse", "main")).toBe(tip);
    },
    CEILING,
  );

  it(
    "gives the checkout the loop's committer, so the agent's commits are made by it",
    () => {
      const { root, base } = checkout();

      run(root, base);
      fs.writeFileSync(path.join(root, "work.txt"), "work");
      git(root, "add", "-A");
      // With no identity in the environment, so the checkout's config is what git reads.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(name)));
      execFileSync("git", ["commit", "--quiet", "-m", "work"], { cwd: root, env, stdio: "ignore", timeout: SUBPROCESS_TIMEOUT });

      expect(git(root, "config", "user.name")).toBe(LOOP_COMMITTER.name);
      expect(git(root, "config", "user.email")).toBe(LOOP_COMMITTER.email);
      expect(git(root, "log", "-1", "--format=%an <%ae>")).toBe(`${LOOP_COMMITTER.name} <${LOOP_COMMITTER.email}>`);
    },
    CEILING,
  );

  it(
    "refuses with a sentence, and makes no branch, where the checkout doesn't hold the base commit",
    () => {
      const { root } = checkout();
      const missing = "0123456789abcdef0123456789abcdef01234567";

      expect(() => run(root, missing)).toThrow(
        `The checkout of \`main\` doesn't hold ${missing}, the commit this run found it at, so no branch was made for the agent.`,
      );
      expect(() => git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`)).toThrow();
      expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    },
    CEILING,
  );
});
