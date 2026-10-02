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

/**
 * The same check in the three runs split after implement's (#308), each
 * executed on the arms its own push differs on: what the bundle must build
 * on, and what the push leases against.
 */
const pushStepOf = (file: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", file), "utf8")) as Workflow;
  const run = (workflow.jobs["publish"]?.steps ?? []).find((s) => s.id === "push")?.run;

  expect(run, `${file}'s publish job has no \`push\` step`).toBeDefined();
  return run ?? "";
};

const pushWith = (w: World, file: string, env: Readonly<Record<string, string>>): Outcome => {
  const script = path.join(w.temp, "step.sh");
  const output = path.join(w.temp, "output");
  fs.writeFileSync(script, pushStepOf(file));
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
      BASE_REF: "main",
      GH_TOKEN: "not-a-token",
      PUSH_TOKEN: "not-a-token",
      ...env,
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

/** The pull request's branch on `origin` at the base, as a fix or a refresh finds it. */
const prBranch = (w: World): void => {
  git(w.agent, "push", "--quiet", "origin", `${w.base}:refs/heads/${BRANCH}`);
  git(w.publish, "fetch", "--quiet", "origin");
  git(w.publish, "checkout", "--quiet", "--detach", w.base);
};

describe.skipIf(!CAN_RUN)("implement-prd's publish job pushes the slice only once it checks out", () => {
  const env = (w: World): Record<string, string> => ({ PRD_BRANCH: BRANCH, BASE_SHA: w.base });

  it(
    "pushes the PRD branch at the agent's commit, plainly, and reports it",
    () => {
      const w = world();
      bundle(w, `refs/heads/${BRANCH}`);
      const outcome = pushWith(w, "implement-prd.yml", env(w));
      const commit = git(w.agent, "rev-parse", "HEAD");

      expect(outcome.status).toBe(0);
      expect(outcome.pushed).toBe(commit);
      expect(outcome.head).toBe(commit);
    },
    CEILING,
  );

  it(
    "refuses a branch that does not build on the tip the catch-up left",
    () => {
      const w = world();
      git(w.agent, "checkout", "--quiet", "--orphan", "unrelated");
      git(w.agent, "commit", "--quiet", "-m", "unrelated history");
      git(w.agent, "branch", "--quiet", "-D", BRANCH);
      git(w.agent, "branch", "--quiet", "-m", BRANCH);
      bundle(w, `refs/heads/${BRANCH}`);

      refused(pushWith(w, "implement-prd.yml", env(w)), /don't build on `agent\/issue-7-add-a-widget` as this run left it/);
    },
    CEILING,
  );
});

describe.skipIf(!CAN_RUN)("fix's publish job pushes the agent's commits only once they check out", () => {
  const env = (w: World): Record<string, string> => ({ BRANCH, BRANCH_HEAD_SHA: w.base });

  it(
    "pushes the commits on the pull request's head, under its lease, and reports it",
    () => {
      const w = world();
      prBranch(w);
      bundle(w, `refs/heads/${BRANCH}`);
      const outcome = pushWith(w, "fix.yml", env(w));
      const commit = git(w.agent, "rev-parse", "HEAD");

      expect(outcome.status).toBe(0);
      expect(outcome.pushed).toBe(commit);
      expect(outcome.head).toBe(commit);
    },
    CEILING,
  );

  it(
    "reads no bundle as no commits, and pushes nothing without failing",
    () => {
      const w = world();
      prBranch(w);
      const outcome = pushWith(w, "fix.yml", env(w));

      expect(outcome.status).toBe(0);
      expect(outcome.pushed).toBe(w.base);
      expect(outcome.reason).toBe("");
    },
    CEILING,
  );

  it(
    "refuses a branch that does not build on the pull request's head",
    () => {
      const w = world();
      prBranch(w);
      git(w.agent, "checkout", "--quiet", "--orphan", "unrelated");
      git(w.agent, "commit", "--quiet", "-m", "unrelated history");
      git(w.agent, "branch", "--quiet", "-D", BRANCH);
      git(w.agent, "branch", "--quiet", "-m", BRANCH);
      bundle(w, `refs/heads/${BRANCH}`);
      const outcome = pushWith(w, "fix.yml", env(w));

      expect(outcome.status).not.toBe(0);
      expect(outcome.pushed).toBe(w.base);
      expect(outcome.reason).toMatch(/don't build on the PR's head as this run found it, so nothing was pushed\.\n$/);
    },
    CEILING,
  );
});

describe.skipIf(!CAN_RUN)("update-branch's publish job pushes a merge it made, or a resolution it checked", () => {
  /**
   * The pull request's branch on `origin` at a commit of its own, the agent's
   * clone's widget, and `main` moved on past the base it was cut from: a
   * refresh with something to merge. Returns the two commits the merge joins.
   */
  const diverged = (w: World): { readonly head: string; readonly merged: string } => {
    const head = git(w.agent, "rev-parse", "HEAD");
    git(w.agent, "push", "--quiet", "origin", `${head}:refs/heads/${BRANCH}`);
    const seed = path.join(w.temp, "seed");
    fs.writeFileSync(path.join(seed, "CHANGES.md"), "moved\n");
    git(seed, "add", "CHANGES.md");
    git(seed, "commit", "--quiet", "-m", "main moves on");
    git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    git(w.publish, "fetch", "--quiet", "origin");
    git(w.publish, "checkout", "--quiet", "--detach", head);
    return { head, merged: git(seed, "rev-parse", "HEAD") };
  };
  const env = (head: string, merged: string, status: string): Record<string, string> => ({
    BRANCH,
    BRANCH_HEAD_SHA: head,
    BASE_SHA: merged,
    STATUS: status,
  });

  it(
    "makes the clean merge again itself, of the base commit the gate merged, and pushes it",
    () => {
      const w = world();
      const { head, merged } = diverged(w);
      const outcome = pushWith(w, "update-branch.yml", env(head, merged, "clean"));

      expect(outcome.status).toBe(0);
      expect(outcome.reason).toBe("");
      expect(outcome.head).toBe(outcome.pushed);
      expect(git(w.origin, "rev-list", "--parents", "-n", "1", outcome.pushed).split(" ").slice(1)).toEqual([head, merged]);
      expect(git(w.origin, "log", "-1", "--format=%s", outcome.pushed)).toBe(`Merge remote-tracking branch 'origin/main' into ${BRANCH}`);
    },
    CEILING,
  );

  it(
    "pushes a resolution that merges the base into the pull request's head",
    () => {
      const w = world();
      const { head, merged } = diverged(w);
      git(w.agent, "fetch", "--quiet", "origin");
      git(w.agent, "merge", "--quiet", "--no-edit", merged);
      git(w.agent, "bundle", "create", "--quiet", path.join(w.runner, "branch.bundle"), `refs/heads/${BRANCH}`, `^${head}`, `^${merged}`);
      const outcome = pushWith(w, "update-branch.yml", env(head, merged, "conflicts"));

      expect(outcome.status).toBe(0);
      expect(outcome.pushed).toBe(git(w.agent, "rev-parse", "HEAD"));
    },
    CEILING,
  );

  it(
    "refuses a resolution that does not take the base in",
    () => {
      const w = world();
      const { head, merged } = diverged(w);
      fs.writeFileSync(path.join(w.agent, "widget.txt"), "resolved, without main\n");
      git(w.agent, "commit", "--quiet", "-am", "Not a merge");
      git(w.agent, "bundle", "create", "--quiet", path.join(w.runner, "branch.bundle"), `refs/heads/${BRANCH}`, `^${head}`);
      const outcome = pushWith(w, "update-branch.yml", env(head, merged, "conflicts"));

      expect(outcome.status).not.toBe(0);
      expect(outcome.pushed).toBe(head);
      expect(outcome.reason).toMatch(/isn't a merge of `main` into the PR's head as this run found them, so the branch was left untouched\.\n$/);
    },
    CEILING,
  );
});

/**
 * fix's publish job reads no bundle as no commits, so it must first know the
 * hand-over arrived at all: a finished runner always writes its thread
 * outcomes or its nothing-to-do note, and where neither came, the run fails
 * with that said rather than marking the PR ready with the work dropped.
 */
describe.skipIf(!CAN_RUN)("fix's publish job refuses a finished agent's hand-over that never arrived", () => {
  const STEP = "Check the agent's hand-over arrived";
  const step = (): { readonly if?: string; readonly run?: string } => {
    const workflow = parse(fs.readFileSync(path.join(".github", "workflows", "fix.yml"), "utf8")) as {
      readonly jobs: Record<string, { readonly steps?: readonly { readonly name?: string; readonly if?: string; readonly run?: string }[] }>;
    };
    const steps = workflow.jobs["publish"]?.steps ?? [];
    const at = steps.findIndex((s) => s.name === STEP);

    expect(at, `fix.yml's publish job has no \`${STEP}\` step`).toBeGreaterThan(-1);
    // After the fetch, and before anything that reads a missing file as none.
    expect(steps[at - 1]?.name).toBe("Fetch what the agent handed over");
    return steps[at] ?? {};
  };

  const check = (files: readonly string[]): { readonly status: number | null; readonly reason: string } => {
    const runner = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fix-handover-"));
    for (const file of files) fs.writeFileSync(path.join(runner, file), "");
    const result = spawnSync("bash", ["-e", "-c", step().run ?? ""], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
      env: { ...process.env, RUNNER_TEMP: runner },
    });
    const reason = path.join(runner, "failure_reason.txt");
    return { status: result.status, reason: fs.existsSync(reason) ? fs.readFileSync(reason, "utf8") : "" };
  };

  it("runs only where the agent's job succeeded", () => {
    expect(step().if).toBe("needs.fix.result == 'success'");
  });

  it.each([["thread_outcomes.json"], ["nothing_to_do.txt"]])("goes on where %s arrived", (file) => {
    expect(check([file])).toEqual({ status: 0, reason: "" });
  });

  it("fails with a reason where neither arrived, even beside a bundle", () => {
    const outcome = check(["branch.bundle"]);

    expect(outcome.status).not.toBe(0);
    expect(outcome.reason).toBe("The agent finished, but what it handed over did not arrive, so nothing was pushed or posted.\n");
  });
});
