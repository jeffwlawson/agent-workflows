import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitFetcher } from "../../engine/git.js";
import { GitHubError } from "../../engine/github.js";
import type { GitHubReader } from "../../engine/read.js";
import { prepare } from "../../implement/prepare.js";
import type { FetchingIo } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { LOOP_COMMITTER } from "../../shared/record.js";
import { rescueRef } from "../../shared/rescue.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader } from "../engine/fakes.js";

/**
 * `implement:prepare` (#491), called the way the CLI calls it: its declared
 * inputs, with `CHECKOUT` a real git repository shaped as the agent's job's
 * checkout of the base branch leaves it. What is asserted is the branch it
 * leaves checked out for the agent, the identity the agent commits as, and
 * the sentence it stopped with. The scenarios are the retired *Create branch*
 * step's, and the base commit the gate read in place of the base's tip. The
 * rescue (#270) is fetched with the engine's real fetcher from a temporary
 * bare repository standing in for the one on GitHub, its tip read from a
 * fake reader, as `tests/implement-prd/prepare.test.ts` does.
 */

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Building the repository spawns git about ten times, and a case a few more. */
const CEILING = 20 * SUBPROCESS_TIMEOUT;

const BRANCH = "agent/issue-7-add-a-widget";
const RESCUE = "agent/rescue/issue-7";
const TOKEN = "ghs_not-a-real-token-0123456789";

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

/** What `ref` points at in `cwd`, or "" where it is not there. */
const tipOf = (cwd: string, ref: string): string => {
  try {
    return git(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};

interface Checkout {
  readonly root: string;
  readonly origin: string;
  readonly base: string;
  readonly tip: string;
}

/**
 * The base branch checked out, as the agent's job's checkout leaves it, with
 * the commit the gate read and one landed on the base after it, and the bare
 * repository it stands in for GitHub's, which holds both.
 */
const checkout = (): Checkout => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "implement-prepare-"));
  const root = path.join(scratch, "work");
  const origin = path.join(scratch, "origin.git");
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  fs.mkdirSync(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  const base = commit(root, "base.txt");
  const tip = commit(root, "later.txt");
  git(root, "push", "--quiet", origin, "HEAD:refs/heads/main");
  return { root, origin, base, tip };
};

/** An earlier stopped run's commit on the rescue branch on `origin`, on `on`. */
const leaveRescue = ({ root, origin }: Checkout, on: string): string => {
  git(root, "checkout", "--quiet", "--detach", on);
  const rescued = commit(root, "stopped.txt");
  git(root, "push", "--quiet", origin, `HEAD:refs/heads/${RESCUE}`);
  git(root, "checkout", "--quiet", "main");
  return rescued;
};

/** The fake's reader, holding `origin`'s branches as GitHub would report them. */
const readerOf = (origin: string): GitHubReader => {
  const github = fakeGitHub();
  for (const line of git(origin, "for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads").split("\n")) {
    const [name, sha] = line.split(" ");
    if (name !== undefined && sha !== undefined) github.branches.set(name, sha);
  }
  return fakeReader(github).reader;
};

const run = (at: Checkout, base: string, github: GitHubReader = readerOf(at.origin)): Promise<void> => {
  const io: FetchingIo<(typeof COMMANDS)["implement:prepare"]["outputs"]> = {
    github,
    fetcher: gitFetcher({ dir: at.root, env: { PATH: process.env["PATH"] ?? "", HOME: path.dirname(at.root) }, remote: at.origin }, TOKEN),
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  return prepare(
    { OUTPUT_DIR: "", GH_REPO: "o/r", GH_TOKEN: TOKEN, CHECKOUT: at.root, BRANCH, BASE_REF: "main", BASE_SHA: base, RESCUE_BRANCH: RESCUE },
    io,
  );
};

describe("implement:prepare", () => {
  it(
    "checks out the agent's branch at the base commit the gate read, not the base's tip",
    async () => {
      const at = checkout();
      const { root, base, tip } = at;

      await run(at, base);

      expect(git(root, "symbolic-ref", "HEAD")).toBe(`refs/heads/${BRANCH}`);
      expect(git(root, "rev-parse", "HEAD")).toBe(base);
      expect(git(root, "rev-parse", "main")).toBe(tip);
    },
    CEILING,
  );

  it(
    "gives the checkout the loop's committer, so the agent's commits are made by it",
    async () => {
      const at = checkout();
      const { root, base } = at;

      await run(at, base);
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
    async () => {
      const at = checkout();
      const { root } = at;
      const missing = "0123456789abcdef0123456789abcdef01234567";

      await expect(run(at, missing)).rejects.toThrow(
        `The checkout of \`main\` doesn't hold ${missing}, the commit this run found it at, so no branch was made for the agent.`,
      );
      expect(() => git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`)).toThrow();
      expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    },
    CEILING,
  );
});

describe("implement:prepare fetches the rescue branch for the runner to resume from (#270)", () => {
  it(
    "fetches a rescue an earlier run left to where the runner looks for it, and leaves the agent's branch at the base",
    async () => {
      const at = checkout();
      const rescued = leaveRescue(at, at.base);

      await run(at, at.base);

      expect(tipOf(at.root, rescueRef(RESCUE))).toBe(rescued);
      expect(tipOf(at.root, "HEAD")).toBe(at.base);
      expect(logged).toContain(`Fetched ${RESCUE}, which an earlier run left, for the runner to resume from.`);
    },
    CEILING,
  );

  it(
    "fetches nothing where there is no rescue branch, a 404, and goes on",
    async () => {
      const at = checkout();

      await run(at, at.base);

      expect(tipOf(at.root, rescueRef(RESCUE))).toBe("");
      expect(logged).toContain(`No ${RESCUE}, so there is nothing to resume from.`);
    },
    CEILING,
  );

  it(
    "stops, with a sentence a person can act on, where the rescue's tip cannot be read",
    async () => {
      const at = checkout();
      leaveRescue(at, at.base);
      const github: GitHubReader = {
        ...readerOf(at.origin),
        branchTip: async () => {
          throw new GitHubError("GET branches failed", 502);
        },
      };

      await expect(run(at, at.base, github)).rejects.toThrow(
        `Couldn't check whether an earlier run left commits on \`${RESCUE}\`, so this run stopped rather than start over without them.`,
      );
      expect(tipOf(at.root, rescueRef(RESCUE))).toBe("");
    },
    CEILING,
  );
});
