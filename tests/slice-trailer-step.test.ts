import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SLICE_TRAILER } from "../shared/slice-ranges.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs `implement-prd`'s `Mark the slice's commits`, the real `run:` block read
 * out of `.github/workflows/implement-prd.yml`, under `bash -e` in a **real**
 * git checkout shaped like the one the runner leaves: a PRD branch with an
 * earlier slice on the remote, checked out at its tip, and the commits this run
 * made on top of it, one of them a merge of the default branch.
 *
 * What it executes is #242: every commit the run made carries exactly one
 * `Agent-Slice: #<sub>` trailer naming the sub-issue it built, and nothing
 * already published, nor the working tree, is touched.
 *
 * Skipped where `bash` or `git` is not on PATH.
 */

const PRD = path.join(".github", "workflows", "implement-prd.yml");
const STEP = "Mark the slice's commits";

const onPath = (command: string): boolean =>
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", `command -v ${command}`], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

const CAN_RUN = ["bash", "git"].every(onPath);

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const steps = (): readonly Step[] =>
  (parse(fs.readFileSync(PRD, "utf8")) as Workflow).jobs["implement-prd"]?.steps ?? [];

const PRD_BRANCH = "agent/prd-222-slices";
const SUB = "242";

/** Bounded, as `CLAUDE.md` asks of every synchronous spawn in a test. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
  }).trim();

/** One `--allow-empty` commit with `message`, by `who`, returning its sha. */
const commit = (cwd: string, message: string, who = "agent"): string => {
  git(cwd, "-c", `user.name=${who}`, "commit", "-q", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

const checkout = (): { work: string; published: readonly string[]; mainMoved: string; tree: string } => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-slice-trailer-"));
  const seed = path.join(temp, "seed");
  const remote = path.join(temp, "remote.git");
  const work = path.join(temp, "work");

  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  const base = commit(seed, "chore: the default branch");
  git(seed, "checkout", "-q", "-b", PRD_BRANCH);
  const earlier = commit(seed, "feat: an earlier slice\n\nAgent-Slice: #241");
  git(seed, "checkout", "-q", "main");
  git(temp, "clone", "-q", "--bare", seed, remote);
  git(temp, "clone", "-q", remote, work);

  // The default branch moves on the remote while the slice is built.
  git(seed, "commit", "-q", "--allow-empty", "-m", "ci: a change on main");
  git(seed, "push", "-q", remote, "main");
  git(work, "fetch", "-q", "origin");
  const mainMoved = git(work, "rev-parse", "origin/main");

  // What `Prepare the PRD branch` leaves.
  git(work, "checkout", "-q", "-B", PRD_BRANCH, `origin/${PRD_BRANCH}`);

  // What the agent leaves: a plain commit, one with a wrong trailer, one with
  // two, a merge of the default branch, two whose bodies hold a `---` line
  // (a horizontal rule, and a quoted diff), and an uncommitted file.
  fs.writeFileSync(path.join(work, "built.txt"), "built\n");
  git(work, "add", "built.txt");
  commit(work, "feat: build the slice (#242)\n\nWhy it is built this way.\n\nCo-Authored-By: a <a@example.com>");
  commit(work, "test: cover it\n\nAgent-Slice: #9");
  commit(work, "fix: tidy\n\nAgent-Slice: #241\nagent-slice: #7");
  git(work, "merge", "-q", "--no-ff", "--no-edit", "origin/main");
  commit(work, "docs: note it");
  commit(work, "docs: a rule\n\nSome body.\n\n---\n\nMore.");
  commit(work, "fix: quote the diff\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n\nCo-Authored-By: a <a@example.com>");
  fs.writeFileSync(path.join(work, "uncommitted.txt"), "left alone\n");
  const tree = git(work, "rev-parse", "HEAD^{tree}");

  return { work, published: [base, earlier], mainMoved, tree };
};

const runStep = (cwd: string): { status: number | null; stderr: string } => {
  const script = steps().find((s) => s.name === STEP)?.run ?? "";
  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SUB },
    timeout: SUBPROCESS_TIMEOUT,
  });
  return { status: result.status, stderr: result.stderr };
};

/** Every line of the message naming the key, wherever in the message it sits. */
const trailers = (cwd: string, sha: string): string[] =>
  git(cwd, "log", "-1", "--format=%B", sha)
    .split("\n")
    .filter((line) => /^agent-slice:/i.test(line));

/**
 * The key's values as **git's own trailer parser** reads them, which is how
 * the slice ranges are read: a line git does not count as a trailer is absent.
 */
const parsed = (cwd: string, sha: string): string =>
  git(cwd, "log", "-1", `--format=%(trailers:key=${SLICE_TRAILER},valueonly,separator=%x2C)`, sha);

/**
 * The vitest ceiling for a body making `spawns` bounded children: their sum,
 * since a ceiling under it fails while each child is still inside its own bound.
 */
const ceiling = (spawns: number): number => spawns * SUBPROCESS_TIMEOUT;

/** `checkout()`'s spawns, and the step's one. */
const SETUP_SPAWNS = 33;

describe.skipIf(!CAN_RUN)("implement-prd's Mark the slice's commits", () => {
  let built: ReturnType<typeof checkout>;
  let authors: string;
  let ran: ReturnType<typeof runStep>;

  beforeAll(() => {
    built = checkout();
    authors = git(built.work, "log", "--format=%an %ad", "HEAD", "--not", "--remotes");
    ran = runStep(built.work);
  }, ceiling(SETUP_SPAWNS));

  it("gives every commit the run made exactly one Agent-Slice trailer naming the sub-issue", () => {
    const { work, tree } = built;
    expect(ran.status, ran.stderr).toBe(0);

    const made = git(work, "rev-list", "HEAD", "--not", "--remotes").split("\n");
    expect(made).toHaveLength(7);
    for (const sha of made) {
      expect(trailers(work, sha)).toEqual([`${SLICE_TRAILER}: #${SUB}`]);
      expect(parsed(work, sha), sha).toBe(`#${SUB}`);
    }

    // Everything else in a message is kept, and the trailer joins its block.
    expect(git(work, "log", "-1", "--format=%B", "HEAD~6")).toBe(
      `feat: build the slice (#242)\n\nWhy it is built this way.\n\nCo-Authored-By: a <a@example.com>\nAgent-Slice: #${SUB}`,
    );
    expect(git(work, "log", "--format=%an %ad", "HEAD", "--not", "--remotes")).toBe(authors);
    expect(git(work, "rev-parse", "HEAD^{tree}")).toBe(tree);
  }, ceiling(20));

  it("rewrites nothing published: the remote PRD branch, the earlier slice and the merged default branch keep their shas", () => {
    const { work, published, mainMoved } = built;
    expect(ran.status, ran.stderr).toBe(0);

    const reachable = git(work, "rev-list", "HEAD").split("\n");
    for (const sha of [...published, mainMoved]) expect(reachable).toContain(sha);
    expect(trailers(work, mainMoved)).toEqual([]);
    expect(git(work, "rev-parse", `refs/remotes/origin/${PRD_BRANCH}`)).toBe(published[1]);
  }, ceiling(3));

  it("moves the PRD branch without touching the working tree", () => {
    const { work } = built;
    expect(ran.status, ran.stderr).toBe(0);

    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe(PRD_BRANCH);
    expect(git(work, "rev-parse", `refs/heads/${PRD_BRANCH}`)).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(work, "status", "--porcelain")).toBe("?? uncommitted.txt");
  }, ceiling(3));

  it("sits after the runner and before the push, and writes the trailer the slice ranges read", () => {
    const all = steps();
    const at = all.findIndex((s) => s.name === STEP);
    const runner = all.findIndex((s) => (s.run ?? "").includes("agent-workflows implement-prd"));
    const push = all.findIndex((s) => s.id === "push");

    expect(at).toBeGreaterThan(runner);
    expect(at).toBeLessThan(push);
    expect(all[at]?.run).toContain(`--trailer "${SLICE_TRAILER}: #\${SUB}"`);
  });
});

describe("the build prompt", () => {
  it("does not mention the trailer, which the workflow writes and the agent is never asked to", () => {
    expect(fs.readFileSync(path.join("implement-prd", "prompt.md"), "utf8")).not.toMatch(/agent-slice|trailer/i);
  });
});
