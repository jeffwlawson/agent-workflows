import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs `implement-prd`'s `Merge the default branch into the PRD branch`, the
 * real `run:` block read out of `.github/workflows/implement-prd.yml`, under
 * `bash -e` in a **real** git checkout shaped like the one `Prepare the PRD
 * branch` leaves: the PRD branch checked out at its tip, with a slice already
 * built on it, and a bare remote standing in for GitHub. Tracker writes go to
 * the recorded `gh` in `tests/fixtures/gh-replay`, which logs them.
 *
 * What it executes is #245: a default branch that has moved is merged into the
 * PRD branch and pushed before the build, one that has not moves nothing, and
 * one that conflicts builds nothing, pushes nothing and parks the chain naming
 * `agent:update-branch`, without failing the run.
 *
 * Skipped where `bash`, `git` or `node` is not on PATH.
 */

const PRD = path.join(".github", "workflows", "implement-prd.yml");
const STEP = "Merge the default branch into the PRD branch";
const REPLAY_DIR = path.join("tests", "fixtures", "gh-replay");

const onPath = (command: string): boolean =>
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", `command -v ${command}`], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

const CAN_RUN = ["bash", "git", "node"].every(onPath);

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const steps = (): readonly Step[] =>
  (parse(fs.readFileSync(PRD, "utf8")) as Workflow).jobs["implement-prd"]?.steps ?? [];

const PARENT = "222";
const PRD_BRANCH = "agent/prd-222-slices";
const PRD_PR = "286";
const SUB = "245";
const CI = path.join(".github", "workflows", "ci.yml");

/** Bounded, as `CLAUDE.md` asks of every synchronous spawn in a test. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
  }).trim();

/** Writes `files`, then commits them with `message`, returning the commit's sha. */
const commit = (cwd: string, message: string, files: Readonly<Record<string, string>>): string => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), text);
    git(cwd, "add", name);
  }
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** What the default branch does next, on the remote, while the chain waits. */
type MainMoves = "nothing" | "ci" | "docs" | "conflict";

interface Checkout {
  readonly temp: string;
  readonly work: string;
  readonly remote: string;
  /** The PRD branch's tip on the remote before the step. */
  readonly tip: string;
  /** The default branch's tip on the remote before the step. */
  readonly main: string;
}

/**
 * A remote whose PRD branch holds slice #244, which touched `notes.md`, and a
 * work clone with the PRD branch checked out, as `Prepare the PRD branch`
 * leaves it. Then the default branch does `moves` on the remote.
 */
const checkout = (moves: MainMoves): Checkout => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-default-merge-"));
  const seed = path.join(temp, "seed");
  const remote = path.join(temp, "remote.git");
  const work = path.join(temp, "work");

  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  commit(seed, "chore: the default branch", { "notes.md": "one\n", [CI]: "on: push\n" });
  git(seed, "checkout", "-q", "-b", PRD_BRANCH);
  const tip = commit(seed, "feat: slice 244\n\nAgent-Slice: #244", { "notes.md": "one, from slice 244\n" });
  git(seed, "checkout", "-q", "main");
  git(temp, "clone", "-q", "--bare", seed, remote);
  git(temp, "clone", "-q", remote, work);

  if (moves === "ci") commit(seed, "ci: run on pull requests too", { [CI]: "on: [push, pull_request]\n" });
  if (moves === "docs") commit(seed, "docs: a second note", { "more.md": "two\n" });
  if (moves === "conflict") commit(seed, "docs: a different note", { "notes.md": "one, from main\n" });
  if (moves !== "nothing") git(seed, "push", "-q", remote, "main");
  const main = git(seed, "rev-parse", "main");

  git(work, "checkout", "-q", "-B", PRD_BRANCH, `origin/${PRD_BRANCH}`);
  git(work, "config", "user.name", "sandcastle-agent[bot]");
  git(work, "config", "user.email", "sandcastle-agent[bot]@users.noreply.github.com");

  return { temp, work, remote, tip, main };
};

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly output: string;
  readonly reason: string;
  readonly writes: readonly string[][];
}

const runStep = ({ temp, work }: Checkout, env: Readonly<Record<string, string>> = {}): Outcome => {
  const output = path.join(temp, "output");
  const log = path.join(temp, "writes.log");
  const ghDir = path.resolve(REPLAY_DIR);
  for (const file of fs.readdirSync(ghDir)) fs.chmodSync(path.join(ghDir, file), 0o755);
  fs.writeFileSync(output, "");

  const result = spawnSync("bash", ["-e", "-c", steps().find((s) => s.name === STEP)?.run ?? ""], {
    cwd: work,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      ISSUE_NUMBER: PARENT,
      BASE_REF: "main",
      GH_REPO: "acme/widgets",
      GH_TOKEN: "test-token",
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      GH_REPLAY_LOG: log,
      PATH: `${ghDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      PRD_BRANCH,
      EXISTS: "true",
      PRD_PR,
      SUB,
      ...env,
    },
  });
  const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    output: read(output),
    reason: read(path.join(temp, "failure_reason.txt")),
    writes: read(log)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]),
  };
};

const outputOf = (outcome: Outcome, name: string): string =>
  new RegExp(`^${name}=(.*)$`, "m").exec(outcome.output)?.[1] ?? "";

const remoteTip = ({ remote }: Checkout): string => git(remote, "rev-parse", `refs/heads/${PRD_BRANCH}`);

/**
 * The vitest ceiling for a body making `spawns` bounded children: their sum,
 * since a ceiling under it fails while each child is still inside its own bound.
 */
const ceiling = (spawns: number): number => spawns * SUBPROCESS_TIMEOUT;

/** `checkout()`'s spawns at most, the step's own and its children, and the reads after. */
const SPAWNS = 40;

describe.skipIf(!CAN_RUN)("implement-prd's Merge the default branch into the PRD branch, executed", () => {
  /**
   * A default branch that has moved is merged in, as a merge commit on the PRD
   * branch, and pushed before the build: the PRD branch on the remote holds it
   * before the runner starts.
   *
   * **#211 follows from this case.** The default branch here changes its CI
   * workflow mid-chain, and that change is on the PRD branch before the next
   * slice is built, so the PRD PR's head, and with it the next slice's round,
   * runs the new CI. Nobody did anything by hand.
   */
  it("merges a default branch that has moved into the PRD branch, and pushes it before the build (#211)", () => {
    const built = checkout("ci");
    const outcome = runStep(built);

    expect(outcome.status, outcome.stdout).toBe(0);
    const merge = remoteTip(built);
    expect(merge).not.toBe(built.tip);
    expect(git(built.remote, "rev-list", "--parents", "-n", "1", merge).split(" ").slice(1)).toEqual([
      built.tip,
      built.main,
    ]);
    expect(git(built.remote, "show", `${merge}:${CI}`)).toBe("on: [push, pull_request]");
    expect(git(built.remote, "log", "-1", "--format=%s", merge)).toBe(`Merge main into ${PRD_BRANCH}`);
    expect(outputOf(outcome, "merged")).toBe(merge);
    expect(outputOf(outcome, "parked")).toBe("");
    expect(outcome.writes).toEqual([]);
  }, ceiling(SPAWNS));

  /**
   * Published, so `Mark the slice's commits` leaves it untrailered: it reads
   * "this run's" commits as those no remote-tracking ref has. Before the
   * slice's first trailered commit and with no trailer, the merge falls
   * outside every slice range, and no slice round reviews it.
   */
  it("leaves the merge as no commit of the slice's: published, and untrailered", () => {
    const built = checkout("ci");
    const outcome = runStep(built);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(git(built.work, "rev-list", "HEAD", "--not", "--remotes")).toBe("");
    expect(git(built.work, "log", "-1", "--format=%B", "HEAD")).not.toMatch(/agent-slice/i);
    expect(git(built.work, "symbolic-ref", "--short", "HEAD")).toBe(PRD_BRANCH);
  }, ceiling(SPAWNS));

  it("makes no merge commit when the default branch has not moved", () => {
    const built = checkout("nothing");
    const outcome = runStep(built);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(remoteTip(built)).toBe(built.tip);
    expect(git(built.work, "rev-parse", "HEAD")).toBe(built.tip);
    expect(outcome.output).toBe("");
    expect(outcome.writes).toEqual([]);
  }, ceiling(SPAWNS));

  /**
   * The first slice's run cuts the PRD branch from the default branch, so there
   * is nothing to merge, and nothing is pushed before the slice: not even where
   * the default branch moved again between the checkout and here.
   */
  it("makes no merge commit, and pushes nothing, on a PRD branch this run just cut", () => {
    const built = checkout("ci");
    const cut = git(built.work, "rev-parse", "origin/main");
    git(built.work, "checkout", "-q", "-B", "agent/prd-222-new", "origin/main");
    const outcome = runStep(built, { PRD_BRANCH: "agent/prd-222-new", EXISTS: "false" });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(git(built.work, "rev-parse", "HEAD")).toBe(cut);
    expect(git(built.remote, "branch", "--list", "agent/prd-222-new")).toBe("");
    expect(outcome.output).toBe("");
  }, ceiling(SPAWNS));

  /**
   * A conflict is a refusal, not a failure: the merge is aborted, nothing is
   * built or pushed, and the chain parks with a comment on the parent naming
   * the conflict and `agent:update-branch` on the PRD PR. The label comes off
   * and no `agent:blocked` goes on.
   */
  it("parks the chain on a conflicting default branch: builds nothing, pushes nothing, does not fail", () => {
    const built = checkout("conflict");
    const outcome = runStep(built);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.reason).toBe("");
    expect(outputOf(outcome, "parked")).toBe("true");
    expect(outputOf(outcome, "merged")).toBe("");
    expect(remoteTip(built)).toBe(built.tip);
    expect(git(built.work, "rev-parse", "HEAD")).toBe(built.tip);
    expect(fs.existsSync(path.join(built.work, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(built.work, "status", "--porcelain")).toBe("");

    const [comment, ...rest] = outcome.writes;
    expect(comment?.slice(0, 3)).toEqual(["issue", "comment", PARENT]);
    const body = comment?.at(-1) ?? "";
    expect(body).toMatch(/^\*\*`agent:implement` didn't run:\*\* [A-Z]/);
    expect(body).toContain("conflicts in `notes.md`");
    expect(body).toContain(`before sub-issue #${SUB}`);
    expect(body).toContain("nothing was built or pushed");
    expect(body).toContain(`Add \`agent:update-branch\` to PRD PR #${PRD_PR}`);
    expect(rest).toEqual([["issue", "edit", PARENT, "--remove-label", "agent:implement"]]);
  }, ceiling(SPAWNS));

  /**
   * A rejected push of the merge is a failure. Where the merge brings in a
   * workflow file, the likeliest cause is a token without Workflows: write,
   * the `GITHUB_TOKEN` fallback included, which every retry hits again: the
   * reason names it and `AGENT_PAT`. A remote whose `pre-receive` refuses
   * every push stands in for GitHub's refusal.
   */
  const rejecting = (moves: MainMoves): Checkout => {
    const built = checkout(moves);
    const hook = path.join(built.remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    return built;
  };

  it("names Workflows: write and AGENT_PAT when a push of a merge changing a workflow file is rejected", () => {
    const built = rejecting("ci");
    const outcome = runStep(built);

    expect(outcome.status).not.toBe(0);
    expect(remoteTip(built)).toBe(built.tip);
    expect(outputOf(outcome, "merged")).toBe("");
    expect(outcome.reason).toContain(`Couldn't push the merge of \`main\` into \`${PRD_BRANCH}\`, so nothing was built.`);
    expect(outcome.reason).toContain(`The merge changes \`${CI.split(path.sep).join("/")}\``);
    expect(outcome.reason).toContain("until `AGENT_PAT` is set with Workflows: write");
  }, ceiling(SPAWNS));

  it("names only the moved PRD branch when a push of a merge changing no workflow file is rejected", () => {
    const built = rejecting("docs");
    const outcome = runStep(built);

    expect(outcome.status).not.toBe(0);
    expect(remoteTip(built)).toBe(built.tip);
    expect(outcome.reason).toContain("Something else may have moved the PRD branch; trying again merges on top of it.");
    expect(outcome.reason).not.toMatch(/Workflows: write|AGENT_PAT/);
  }, ceiling(SPAWNS));

  /**
   * Every step that builds, pushes or asks for a review stands down on a park.
   * The step itself sits after the PRD branch is checked out, and before the
   * toolchain, the runner and the push.
   */
  it("sits after Prepare and before the build, and every later step that builds stands down on a park", () => {
    const all = steps();
    const at = all.findIndex((s) => s.name === STEP);
    const runner = all.findIndex((s) => (s.run ?? "").includes("agent-workflows implement-prd"));

    expect(all[at]?.id).toBe("catch_up");
    expect(at).toBe(all.findIndex((s) => s.id === "prepare") + 1);
    expect(at).toBeLessThan(runner);
    for (const step of all.slice(at + 1)) {
      if (/steps\.preflight\.outputs\.(build == 'true'|finishing == 'false')/.test(step.if ?? "")) {
        expect(step.if, step.name).toContain("steps.catch_up.outputs.parked != 'true'");
      }
    }
    for (const id of ["push", "prd_pr", "trailer"]) {
      expect(all.find((s) => s.id === id)?.if, id).toContain("steps.catch_up.outputs.parked != 'true'");
    }
    expect(all.find((s) => s.name === "Request review")?.if).toContain("steps.catch_up.outputs.parked != 'true'");
  });
});
