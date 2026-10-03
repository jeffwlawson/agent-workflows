import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { rescueRef } from "../shared/rescue.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs both halves of rescue and resume (#303) as the workflows hold them, the
 * real `run:` blocks under `bash -e` against real git: a bare repository as
 * `origin`, a clone as the publish job's checkout, and a second clone standing
 * in for the agent's runner, which hands over a bundle.
 *
 * - `Rescue the agent's commits`, in fix's and implement-prd's publish jobs:
 *   pushes a stopped run's commits to the rescue branch and nowhere else,
 *   overwrites an earlier rescue, and pushes nothing where there were none.
 * - The agent's job's prepare step: fetches the rescue branch to where the
 *   runner looks for it (`rescueRef`), and nothing where there is none.
 *
 * Skipped where `bash` or `git` is not on PATH.
 */

const CAN_RUN =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v bash && command -v git"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

/** Each case spawns git about a dozen times to build its repositories, and a step once or twice. */
const CEILING = 20 * SUBPROCESS_TIMEOUT;

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const stepOf = (file: string, job: string, name: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", file), "utf8")) as Workflow;
  const run = (workflow.jobs[job]?.steps ?? []).find((s) => s.name === name)?.run;

  expect(run, `${file}'s ${job} job has no \`${name}\` step`).toBeDefined();
  return run ?? "";
};

const IDENTITY = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: { ...process.env, ...IDENTITY },
  }).trim();

const commit = (cwd: string, file: string): string => {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
};

/**
 * Each workflow's names: the branch the agent works on, the variable the
 * rescue step reads it from, the variable holding the head it started from,
 * and the rescue branch.
 */
const CASES = [
  {
    file: "fix.yml",
    agent: "fix",
    prepare: "Prepare branch and make the PR base available for diffing",
    branch: "agent/issue-7-add-a-widget",
    branchVar: "BRANCH",
    startVar: "BRANCH_HEAD_SHA",
    rescue: "agent/rescue/fix-12",
  },
  {
    file: "implement-prd.yml",
    agent: "implement-prd",
    prepare: "Prepare the PRD branch",
    branch: "agent/prd-9-widgets",
    branchVar: "PRD_BRANCH",
    startVar: "BASE_SHA",
    rescue: "agent/rescue/prd-9",
  },
] as const;

type Case = (typeof CASES)[number];

interface World {
  readonly temp: string;
  readonly origin: string;
  readonly publish: string;
  readonly agent: string;
  readonly runner: string;
  readonly start: string;
}

/** `origin` with the work branch at `start`, the publish job's clone, and the agent's clone of the branch. */
const world = (c: Case): World => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rescue-step-"));
  const origin = path.join(temp, "origin.git");
  const seed = path.join(temp, "seed");
  const publish = path.join(temp, "publish");
  const agent = path.join(temp, "agent");
  const runner = path.join(temp, "runner");
  fs.mkdirSync(runner);

  git(temp, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(temp, "clone", "--quiet", origin, seed);
  commit(seed, "README.md");
  git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const start = commit(seed, "earlier.txt");
  git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${c.branch}`);

  git(temp, "clone", "--quiet", "--branch", c.branch, origin, agent);
  git(temp, "clone", "--quiet", origin, publish);
  return { temp, origin, publish, agent, runner, start };
};

/** The agent's job's bundle, as `Bundle the branch` builds it: its branch, past the head it started from. */
const bundle = (w: World, c: Case): void => {
  git(w.agent, "bundle", "create", "--quiet", path.join(w.runner, "branch.bundle"), `refs/heads/${c.branch}`, `^${w.start}`);
};

interface Outcome {
  readonly status: number | null;
  readonly output: string;
  readonly stdout: string;
  /** The rescue branch on `origin`, or "" where there is none. */
  readonly rescued: string;
  /** The work branch on `origin`. */
  readonly branch: string;
}

const onOrigin = (w: World, ref: string): string =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: w.origin, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT }).stdout.trim();

const rescue = (w: World, c: Case): Outcome => {
  const script = path.join(w.temp, "rescue.sh");
  const output = path.join(w.temp, "output");
  fs.writeFileSync(script, stepOf(c.file, "publish", "Rescue the agent's commits"));
  fs.writeFileSync(output, "");

  const result = spawnSync("bash", ["-e", script], {
    cwd: w.publish,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      ...IDENTITY,
      RUNNER_TEMP: w.runner,
      GITHUB_OUTPUT: output,
      [c.branchVar]: c.branch,
      [c.startVar]: w.start,
      RESCUE_BRANCH: c.rescue,
      GH_TOKEN: "not-a-token",
      PUSH_TOKEN: "not-a-token",
    },
  });

  return {
    status: result.status,
    output: fs.readFileSync(output, "utf8"),
    stdout: result.stdout,
    rescued: onOrigin(w, `refs/heads/${c.rescue}`),
    branch: onOrigin(w, `refs/heads/${c.branch}`),
  };
};

describe.skipIf(!CAN_RUN)("a stopped run's commits are rescued to a side branch", () => {
  it.each(CASES)(
    "$file: pushes the agent's commits to $rescue, names it, and leaves the work branch alone",
    (c) => {
      const w = world(c);
      commit(w.agent, "one.txt");
      const tip = commit(w.agent, "two.txt");
      bundle(w, c);

      const outcome = rescue(w, c);

      expect(outcome.status).toBe(0);
      expect(outcome.rescued).toBe(tip);
      expect(outcome.branch).toBe(w.start);
      expect(outcome.output).toBe(`branch=${c.rescue}\n`);
      expect(outcome.stdout).toContain(`Rescued 2 commit(s) to ${c.rescue}.`);
    },
    CEILING,
  );

  it.each(CASES)(
    "$file: pushes nothing where the run made no commits",
    (c) => {
      const w = world(c);

      const outcome = rescue(w, c);

      expect(outcome.status).toBe(0);
      expect(outcome.rescued).toBe("");
      expect(outcome.output).toBe("");
    },
    CEILING,
  );

  /**
   * A run that resumed from a rescue and stopped again holds everything the
   * rescue held, so its own replaces it.
   */
  it.each(CASES)(
    "$file: overwrites an earlier rescue",
    (c) => {
      const w = world(c);
      commit(w.agent, "one.txt");
      git(w.agent, "push", "--quiet", "origin", `HEAD:refs/heads/${c.rescue}`);
      const tip = commit(w.agent, "two.txt");
      bundle(w, c);

      const outcome = rescue(w, c);

      expect(outcome.status).toBe(0);
      expect(outcome.rescued).toBe(tip);
      expect(outcome.output).toBe(`branch=${c.rescue}\n`);
    },
    CEILING,
  );

  /** Checked as the push is, and a bundle that fails the check is not rescued, nor fails the run. */
  it.each(CASES)(
    "$file: rescues nothing that does not build on the head the run started from",
    (c) => {
      const w = world(c);
      git(w.agent, "checkout", "--quiet", "--orphan", "unrelated");
      commit(w.agent, "unrelated.txt");
      git(w.agent, "branch", "--quiet", "-D", c.branch);
      git(w.agent, "branch", "--quiet", "-m", c.branch);
      git(w.agent, "bundle", "create", "--quiet", path.join(w.runner, "branch.bundle"), `refs/heads/${c.branch}`);

      const outcome = rescue(w, c);

      expect(outcome.status).toBe(0);
      expect(outcome.rescued).toBe("");
      expect(outcome.output).toBe("");
      expect(outcome.stdout).toContain("Nothing was rescued.");
    },
    CEILING,
  );
});

/**
 * The agent's job's prepare step, run in a clone checked out at the head the
 * run starts from, as `actions/checkout` leaves it.
 */
const prepare = (w: World, c: Case): { readonly status: number | null; readonly fetched: string } => {
  const script = path.join(w.temp, "prepare.sh");
  fs.writeFileSync(script, stepOf(c.file, c.agent, c.prepare));
  const work = path.join(w.temp, "work");
  git(w.temp, "clone", "--quiet", "--branch", "main", w.origin, work);
  git(work, "checkout", "--quiet", "--detach", w.start);

  const result = spawnSync("bash", ["-e", script], {
    cwd: work,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      ...IDENTITY,
      RUNNER_TEMP: w.runner,
      BRANCH: c.branch,
      PRD_BRANCH: c.branch,
      EXISTS: "true",
      SUB: "10",
      BASE_REF: "main",
      RESCUE_BRANCH: c.rescue,
      GH_TOKEN: "not-a-token",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const fetched = spawnSync("git", ["rev-parse", "--verify", "--quiet", rescueRef(c.rescue)], {
    cwd: work,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
  });
  return { status: result.status, fetched: fetched.stdout.trim() };
};

describe.skipIf(!CAN_RUN)("the agent's job fetches the rescue branch for the runner to resume from", () => {
  it.each(CASES)(
    "$file: fetches $rescue to where the runner looks for it",
    (c) => {
      const w = world(c);
      const tip = commit(w.agent, "one.txt");
      git(w.agent, "push", "--quiet", "origin", `HEAD:refs/heads/${c.rescue}`);

      expect(prepare(w, c).fetched).toBe(tip);
    },
    CEILING,
  );

  it.each(CASES)(
    "$file: fetches nothing where there is no rescue branch",
    (c) => {
      expect(prepare(world(c), c).fetched).toBe("");
    },
    CEILING,
  );
});
