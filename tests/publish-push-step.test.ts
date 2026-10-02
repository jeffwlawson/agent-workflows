import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs implement's `Push branch`, the real `run:` block read out of its publish
 * job, under `bash -e` against real git: a bare repository as `origin`, a
 * clone of it as the publish job's fresh checkout, and a second clone standing
 * in for the agent's runner, which hands over a bundle.
 *
 * What it executes is the check between the two runners. The bundle's content
 * is the agent's to write; the step pushes it only where it is intact, holds
 * exactly the branch the gate named, and builds on the base the gate read —
 * and where it does not, it pushes nothing and says which, in the reason file
 * the failure step posts.
 *
 * Skipped where `bash` or `git` is not on PATH.
 */

const CAN_RUN =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v bash && command -v git"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

/** Each case spawns git about a dozen times to build its repositories, and the step once. */
const CEILING = 16 * SUBPROCESS_TIMEOUT;

const BRANCH = "agent/issue-7-add-a-widget";

interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly { readonly id?: string; readonly run?: string }[] }>;
}

const pushStep = (): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", "implement.yml"), "utf8")) as Workflow;
  const run = (workflow.jobs["publish"]?.steps ?? []).find((s) => s.id === "push")?.run;

  expect(run, "implement.yml's publish job has no `push` step").toBeDefined();
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

interface World {
  readonly temp: string;
  readonly origin: string;
  readonly publish: string;
  readonly agent: string;
  readonly runner: string;
  readonly base: string;
}

/** `origin` with one commit on `main`, the publish job's clone, and the agent's branch with a commit on it. */
const world = (): World => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-publish-push-"));
  const origin = path.join(temp, "origin.git");
  const seed = path.join(temp, "seed");
  const publish = path.join(temp, "publish");
  const agent = path.join(temp, "agent");
  const runner = path.join(temp, "runner");
  fs.mkdirSync(runner);

  git(temp, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(temp, "clone", "--quiet", origin, seed);
  fs.writeFileSync(path.join(seed, "README.md"), "base\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "--quiet", "-m", "base");
  git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const base = git(seed, "rev-parse", "HEAD");

  git(temp, "clone", "--quiet", "--branch", "main", origin, agent);
  git(agent, "checkout", "--quiet", "-b", BRANCH);
  fs.writeFileSync(path.join(agent, "widget.txt"), "widget\n");
  git(agent, "add", "widget.txt");
  git(agent, "commit", "--quiet", "-m", "Add a widget");

  git(temp, "clone", "--quiet", "--branch", "main", origin, publish);
  return { temp, origin, publish, agent, runner, base };
};

const bundle = (w: World, ...refs: string[]): void => {
  git(w.agent, "bundle", "create", "--quiet", path.join(w.runner, "branch.bundle"), ...refs, "^refs/heads/main");
};

interface Outcome {
  readonly status: number | null;
  readonly reason: string;
  readonly head: string;
  readonly pushed: string;
}

const push = (w: World): Outcome => {
  const script = path.join(w.temp, "step.sh");
  const output = path.join(w.temp, "output");
  fs.writeFileSync(script, pushStep());
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
      BRANCH,
      BASE_REF: "main",
      BASE_SHA: w.base,
      PUSH_TOKEN: "not-a-token",
    },
  });
  const reason = path.join(w.runner, "failure_reason.txt");
  const pushed = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], {
    cwd: w.origin,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
  });

  return {
    status: result.status,
    reason: fs.existsSync(reason) ? fs.readFileSync(reason, "utf8") : "",
    head: /^head=(.*)$/m.exec(fs.readFileSync(output, "utf8"))?.[1] ?? "",
    pushed: pushed.stdout.trim(),
  };
};

/** A refusal pushes nothing, fails the step, and names itself for the failure comment. */
const refused = (outcome: Outcome, says: RegExp): void => {
  expect(outcome.status).not.toBe(0);
  expect(outcome.pushed).toBe("");
  expect(outcome.reason).toMatch(says);
  expect(outcome.reason).toMatch(/nothing was pushed\.\n$/);
};

describe.skipIf(!CAN_RUN)("implement's publish job pushes the agent's bundle only once it checks out", () => {
  it(
    "pushes the branch the gate named, at the agent's commit, and reports it",
    () => {
      const w = world();
      bundle(w, `refs/heads/${BRANCH}`);
      const outcome = push(w);
      const commit = git(w.agent, "rev-parse", "HEAD");

      expect(outcome.status).toBe(0);
      expect(outcome.pushed).toBe(commit);
      expect(outcome.head).toBe(commit);
      expect(outcome.reason).toBe("");
    },
    CEILING,
  );

  it(
    "refuses where the agent's job handed nothing over",
    () => {
      refused(push(world()), /finished without handing over its commits/);
    },
    CEILING,
  );

  /**
   * Cut short in its commits, past a header that still reads whole: `git
   * bundle verify` passes that, since it reads the header and the
   * prerequisites and not the pack, so it is unbundling that refuses it.
   */
  it(
    "refuses a bundle cut short in its commits",
    () => {
      const w = world();
      bundle(w, `refs/heads/${BRANCH}`);
      const file = path.join(w.runner, "branch.bundle");
      const bytes = fs.readFileSync(file);
      fs.writeFileSync(file, bytes.subarray(0, bytes.indexOf("\n\n") + 2 + 20));

      refused(push(w), /arrived damaged or incomplete/);
    },
    CEILING,
  );

  it(
    "refuses a bundle cut short in its header",
    () => {
      const w = world();
      bundle(w, `refs/heads/${BRANCH}`);
      const file = path.join(w.runner, "branch.bundle");
      fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 30));

      refused(push(w), /arrived damaged or incomplete/);
    },
    CEILING,
  );

  it(
    "refuses a bundle that carries a second branch beside the one named",
    () => {
      const w = world();
      git(w.agent, "branch", "other");
      bundle(w, `refs/heads/${BRANCH}`, "refs/heads/other");

      refused(push(w), /on a branch other than `agent\/issue-7-add-a-widget`, or beside other branches/);
    },
    CEILING,
  );

  it(
    "refuses a bundle of another branch",
    () => {
      const w = world();
      git(w.agent, "branch", "other");
      bundle(w, "refs/heads/other");

      refused(push(w), /on a branch other than/);
    },
    CEILING,
  );

  it(
    "refuses a branch that does not build on the base the gate read",
    () => {
      const w = world();
      git(w.agent, "checkout", "--quiet", "--orphan", "unrelated");
      git(w.agent, "commit", "--quiet", "-m", "unrelated history");
      git(w.agent, "branch", "--quiet", "-D", BRANCH);
      git(w.agent, "branch", "--quiet", "-m", BRANCH);
      bundle(w, `refs/heads/${BRANCH}`);

      refused(push(w), /don't build on `main` as this run found it/);
    },
    CEILING,
  );
});
