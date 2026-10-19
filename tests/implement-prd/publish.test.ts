import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitFetcher, gitMerger, gitReader, gitRewriter, gitWrites, type GitEnvironment } from "../../engine/git.js";
import type { Limits } from "../../engine/writer.js";
import { chainOf } from "../../implement-prd/chain.js";
import { publish } from "../../implement-prd/publish.js";
import type { RewritingCheckoutIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import type { InputValues } from "../../shared/env.js";
import { SLICE_TRAILER } from "../../shared/record.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `implement-prd:publish` (#502), called the way the CLI calls it: its
 * declared inputs, `implement-prd:bundle`'s hand-over directory, and the
 * engine's real git reader, fetcher and rewriter working in a clone checked
 * out at the base, as the publish job's checkout leaves it. Its writers are
 * the engine's, whose loop push and delete are the real `gitWrites` against a
 * temporary bare repository standing in for the one on GitHub; the rescue
 * branch's tip is read from a fake GitHub. What is asserted is the remote's
 * PRD branch and rescue branch, `published.json`, and the sentence it stopped
 * with.
 *
 * The scenarios are the retired *Mark the slice's commits* step's
 * (`tests/slice-trailer-step.test.ts`) and implement-prd's half of
 * `tests/publish-push-step.test.ts`, carried over by behaviour, and the ones
 * the move adds: the mark is read back as the next gate reads it, rescued
 * commits are marked, an empty range is refused, and a push someone made
 * meanwhile is refused by the lease rather than overwritten.
 */

type Inputs = InputValues<(typeof COMMANDS)["implement-prd:publish"]["inputs"]>;

const PARENT = 222;
const PRD_BRANCH = "agent/prd-222-slices";
const RESCUE = `agent/rescue/prd-${PARENT}`;
const SUB = 242;
const TOKEN = "ghs_workflow-token-0123456789";
const LOOP_TOKEN = "ghs_loop-token-0123456789";
/** Building the repositories spawns git a few dozen times, and a case a dozen more. */
const CEILING = 60 * SUBPROCESS_TIMEOUT;

let scratch: string;
let origin: string;
let seed: string;
let agent: string;
let work: string;
let handed: string;
let env: GitEnvironment;
/** `main` as the chain started. */
let base: string;
/** The PRD branch's tip as the catch-up left it: an earlier slice, #241. */
let tip: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let written: Map<string, unknown>;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT,
    env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();

/** One commit in `dir` with `message`, by `who`, touching a file of its own, returning its sha. */
const commit = (dir: string, message: string, who = "agent"): string => {
  const name = `${git(dir, "rev-list", "--count", "--all")}-${who}.txt`;
  fs.writeFileSync(path.join(dir, name), `${message}\n`);
  git(dir, "add", name);
  execFileSync("git", ["commit", "--quiet", "-F", "-"], {
    cwd: dir,
    input: message,
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...env,
      GIT_AUTHOR_NAME: who,
      GIT_AUTHOR_EMAIL: `${who}@example.com`,
      GIT_AUTHOR_DATE: "1700000000 +0200",
      GIT_COMMITTER_NAME: who,
      GIT_COMMITTER_EMAIL: `${who}@example.com`,
      GIT_COMMITTER_DATE: "1700000100 +0200",
    },
  });
  return git(dir, "rev-parse", "HEAD");
};

/** `main` moving on the remote while the slice is built, on `from`, returning its new tip. */
const moveMain = (from = base): string => {
  git(seed, "checkout", "--quiet", "--detach", from);
  const moved = commit(seed, "ci: a change on main", "main");
  git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
  return moved;
};

/** The agent's branch bundled ahead of `tip`, into the hand-over directory, as `implement-prd:bundle` writes it. */
const bundle = (prerequisite = tip): void => {
  git(agent, "bundle", "create", "--quiet", path.join(handed, "branch.bundle"), `refs/heads/${PRD_BRANCH}`, `^${prerequisite}`);
};

const remoteTip = (branch: string): string | undefined => {
  try {
    return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
};

/** Every line of a commit's message naming the key, wherever in the message it sits. */
const trailerLines = (sha: string): string[] =>
  git(origin, "log", "-1", "--format=%B", sha)
    .split("\n")
    .filter((line) => /^agent-slice:/i.test(line));

/** The key's values as git's own trailer parser reads them: a line git does not count as a trailer is absent. */
const parsed = (sha: string): string => git(origin, "log", "-1", `--format=%(trailers:key=${SLICE_TRAILER},valueonly,separator=%x2C)`, sha);

/** A remote whose PRD branch holds slice #241, and an agent's clone checked out on it, as `implement-prd:prepare` leaves it. */
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "implement-prd-publish-"));
  env = { PATH: process.env["PATH"] ?? "", HOME: scratch };
  origin = path.join(scratch, "origin.git");
  seed = path.join(scratch, "seed");
  agent = path.join(scratch, "agent");
  work = path.join(scratch, "work");
  handed = path.join(scratch, "bundle");
  fs.mkdirSync(handed);
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(scratch, "init", "--quiet", "--initial-branch=main", seed);
  base = commit(seed, "chore: the default branch", "main");
  git(seed, "push", "--quiet", origin, "main");
  git(seed, "checkout", "--quiet", "-b", PRD_BRANCH);
  tip = commit(seed, `feat: an earlier slice\n\n${SLICE_TRAILER}: #241`);
  git(seed, "push", "--quiet", origin, PRD_BRANCH);
  git(scratch, "clone", "--quiet", origin, agent);
  git(agent, "checkout", "--quiet", "-B", PRD_BRANCH, tip);
  github = fakeGitHub();
  made = undefined;
  asked = undefined;
  written = new Map();
  vi.spyOn(console, "log").mockImplementation(() => {});
}, CEILING);

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: "acme/widgets",
  GH_TOKEN: TOKEN,
  LOOP_TOKEN,
  LOOP_TOKEN_SOURCE: "app",
  BASE_REF: "main",
  PRD_BRANCH,
  PRD_TIP: tip,
  BASE_SHA: tip,
  SUB: String(SUB),
  RESCUE_BRANCH: RESCUE,
  CHECKOUT: work,
  BUNDLE_DIR: handed,
  ...over,
});

/** The CLI's half, in the publish job's fresh clone of the base: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  git(scratch, "clone", "--quiet", origin, work);
  const fetcher = gitFetcher({ dir: work, env, remote: origin }, TOKEN);
  const io: RewritingCheckoutIo<(typeof COMMANDS)["implement-prd:publish"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits, {
        loop: gitWrites({ dir: work, env, remote: origin }, LOOP_TOKEN),
      });
      return made.writers;
    },
    github: fakeReader(github).reader,
    git: gitReader({ dir: work, env }),
    fetcher,
    merger: gitMerger({ dir: work, env }, fetcher),
    rewriter: gitRewriter({ dir: work, env }),
    outputs: {
      writeJson: (name, value) => written.set(name, structuredClone(value)),
      writeText: (name, value) => written.set(name, value),
      writeBytes: () => {},
      appendLine: () => {},
    },
  };
  try {
    await publish(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

const writes = (): string[] => (made?.writes ?? []).map((w) => `${w.token} ${w.type}`);

describe("implement-prd:publish marks the slice's commits and pushes them", { timeout: CEILING }, () => {
  /** What the agent leaves, on top of a rescue an earlier stopped run pushed unmarked. */
  let rescued: string;
  let mainMoved: string;

  beforeEach(() => {
    rescued = commit(agent, "feat: half the slice, rescued (#242)");
    git(agent, "push", "--quiet", origin, `HEAD:refs/heads/${RESCUE}`);
    github.branches.set(RESCUE, rescued);
    mainMoved = moveMain();
    git(agent, "fetch", "--quiet", "origin");
    commit(agent, "feat: build the slice (#242)\n\nWhy it is built this way.\n\nCo-Authored-By: a <a@example.com>");
    commit(agent, "test: cover it\n\nAgent-Slice: #9");
    commit(agent, "fix: tidy\n\nAgent-Slice: #241\nagent-slice: #7");
    git(agent, "merge", "--quiet", "--no-ff", "--no-edit", "origin/main");
    commit(agent, "docs: a rule\n\nSome body.\n\n---\n\nMore.");
    commit(agent, "fix: quote the diff\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n\nCo-Authored-By: a <a@example.com>");
    bundle();
  }, CEILING);

  it("gives every commit of the slice exactly one Agent-Slice trailer naming it, as git's parser reads it, and pushes them", async () => {
    await run();

    const pushed = remoteTip(PRD_BRANCH) ?? "";
    expect(written.get("published.json")).toEqual({ pushed: true, head: pushed });
    const slice = git(origin, "rev-list", pushed, `^${tip}`, `^${mainMoved}`).split("\n");
    expect(slice).toHaveLength(7);
    for (const sha of slice) {
      expect(trailerLines(sha), sha).toEqual([`${SLICE_TRAILER}: #${SUB}`]);
      expect(parsed(sha), sha).toBe(`#${SUB}`);
    }
    // Everything else in a message is kept, and the trailer joins its block.
    expect(git(origin, "log", "-1", "--format=%B", `${pushed}~5`)).toBe(
      `feat: build the slice (#242)\n\nWhy it is built this way.\n\nCo-Authored-By: a <a@example.com>\n${SLICE_TRAILER}: #${SUB}`,
    );
    expect(writes()).toEqual(["loop pushRef", "loop deleteRef"]);
    expect(asked).toEqual({ pushRef: 1, deleteRef: 1 });
  });

  it("keeps every commit's tree, author and dates, so only messages change", async () => {
    const before = git(agent, "log", "--format=%T %an %ae %ad %cn %ce %cd", PRD_BRANCH, `^${tip}`, `^${mainMoved}`);
    const tree = git(agent, "rev-parse", `${PRD_BRANCH}^{tree}`);

    await run();

    const pushed = remoteTip(PRD_BRANCH) ?? "";
    expect(git(origin, "log", "--format=%T %an %ae %ad %cn %ce %cd", pushed, `^${tip}`, `^${mainMoved}`)).toBe(before);
    expect(git(origin, "rev-parse", `${pushed}^{tree}`)).toBe(tree);
  });

  it("rewrites nothing already published: the earlier slice and the merged default branch keep their shas, and the merge's parents are remapped", async () => {
    await run();

    const pushed = remoteTip(PRD_BRANCH) ?? "";
    const reachable = git(origin, "rev-list", pushed).split("\n");
    for (const sha of [base, tip, mainMoved]) expect(reachable).toContain(sha);
    expect(trailerLines(mainMoved)).toEqual([]);
    const merge = git(origin, "rev-list", "--merges", pushed, `^${tip}`);
    const [first, second] = git(origin, "log", "-1", "--format=%P", merge).split(" ");
    expect(second).toBe(mainMoved);
    expect(parsed(first ?? "")).toBe(`#${SUB}`);
  });

  it("marks the commits it resumed from a rescue, and deletes the rescue branch under a lease on its tip", async () => {
    await run();

    const pushed = remoteTip(PRD_BRANCH) ?? "";
    const oldest = git(origin, "rev-list", "--reverse", pushed, `^${tip}`, `^${mainMoved}`).split("\n")[0] ?? "";
    expect(git(origin, "log", "-1", "--format=%s", oldest)).toBe("feat: half the slice, rescued (#242)");
    expect(oldest).not.toBe(rescued);
    expect(parsed(oldest)).toBe(`#${SUB}`);
    expect(remoteTip(RESCUE)).toBeUndefined();
    expect(made?.writes.find((w) => w.type === "deleteRef")?.args).toEqual([{ ref: `refs/heads/${RESCUE}`, lease: { tip: rescued } }]);
  });

  it("writes the trailers the next gate reads: the slice it built is built, and the next one is next", async () => {
    await run();

    const messages = git(origin, "log", "--format=%B%x00", `main..refs/heads/${PRD_BRANCH}`)
      .split("\0")
      .filter((m) => m.trim() !== "");
    const chain = chainOf(
      [
        { number: 241, title: "first", state: "OPEN" },
        { number: SUB, title: "second", state: "OPEN" },
        { number: 243, title: "third", state: "OPEN" },
      ],
      messages,
    );
    expect(chain.built).toBe(2);
    expect(chain.next?.subIssue.number).toBe(243);
  });

  it("refuses a push someone made to the PRD branch during the run, rather than overwriting it", async () => {
    git(seed, "checkout", "--quiet", PRD_BRANCH);
    const theirs = commit(seed, "fix: someone else's", "someone");
    git(seed, "push", "--quiet", origin, PRD_BRANCH);

    await expect(run()).rejects.toThrow(
      `\`${PRD_BRANCH}\` changed while this run worked, so sub-issue #${SUB}'s commits were not pushed over what is there now. Trying again builds it on top of that.`,
    );
    expect(remoteTip(PRD_BRANCH)).toBe(theirs);
    expect(written.get("published.json")).toEqual({ pushed: false });
    expect(remoteTip(RESCUE)).toBe(rescued);
  });

  it("warns and still succeeds where the rescue branch moved since it was read, leaving it there", async () => {
    github.branches.set(RESCUE, tip);

    await run();

    expect(written.get("published.json")).toMatchObject({ pushed: true });
    expect(remoteTip(RESCUE)).toBe(rescued);
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^::warning::Could not delete agent\/rescue\/prd-222\./));
  });

  it("deletes nothing where there is no rescue branch", async () => {
    github.branches.delete(RESCUE);

    await run();

    expect(writes()).toEqual(["loop pushRef"]);
    expect(console.log).toHaveBeenCalledWith(`No ${RESCUE} to delete.`);
  });
});

describe("implement-prd:publish refuses before it writes", { timeout: CEILING }, () => {
  it("refuses a slice whose commits are all on the default branch already, and pushes nothing", async () => {
    const moved = moveMain(tip);
    git(agent, "fetch", "--quiet", "origin");
    git(agent, "merge", "--quiet", "--ff-only", "origin/main");
    bundle();

    await expect(run()).rejects.toThrow(
      `The agent's commits on \`${PRD_BRANCH}\` are all on \`${PRD_BRANCH}\` as this run left it or on \`main\` already, so sub-issue #${SUB} has no commits of its own and nothing was pushed.`,
    );
    expect(git(agent, "rev-parse", PRD_BRANCH)).toBe(moved);
    expect(remoteTip(PRD_BRANCH)).toBe(tip);
    expect(made).toBeUndefined();
  });

  it("refuses where the agent's job handed over no bundle", async () => {
    await expect(run()).rejects.toThrow("The agent's job finished without handing over its commits, so nothing was pushed.");
    expect(made).toBeUndefined();
  });

  it("refuses a branch that does not build on the tip the catch-up left", async () => {
    git(agent, "checkout", "--quiet", "--orphan", "unrelated");
    commit(agent, "unrelated history");
    git(agent, "branch", "--quiet", "-D", PRD_BRANCH);
    git(agent, "branch", "--quiet", "-m", PRD_BRANCH);
    git(agent, "bundle", "create", "--quiet", path.join(handed, "branch.bundle"), `refs/heads/${PRD_BRANCH}`);

    await expect(run()).rejects.toThrow(`The agent's commits don't build on \`${PRD_BRANCH}\` as this run found it, so nothing was pushed.`);
    expect(remoteTip(PRD_BRANCH)).toBe(tip);
    expect(made).toBeUndefined();
  });

  it("pushes a PRD branch the catch-up made and did not push, leased on its not existing", async () => {
    git(origin, "update-ref", "-d", `refs/heads/${PRD_BRANCH}`);
    git(agent, "checkout", "--quiet", "-B", PRD_BRANCH, base);
    commit(agent, "feat: the first slice");
    bundle(base);

    await run(INPUTS({ PRD_TIP: "", BASE_SHA: base }));

    const pushed = remoteTip(PRD_BRANCH) ?? "";
    expect(parsed(pushed)).toBe(`#${SUB}`);
    expect(git(origin, "log", "-1", "--format=%P", pushed)).toBe(base);
    expect(made?.writes.find((w) => w.type === "pushRef")?.args).toEqual([{ ref: `refs/heads/${PRD_BRANCH}`, commit: pushed, lease: { absent: true } }]);
  });
});

describe("the build prompt", () => {
  it("does not mention the trailer, which implement-prd:publish writes and the agent is never asked to", () => {
    expect(fs.readFileSync(path.join("implement-prd", "prompt.md"), "utf8")).not.toMatch(/agent-slice|trailer/i);
  });
});
