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
import { renderPullRequestFrame } from "../../shared/pr-frame.js";
import { renderPrdStatus, renderProgressList, statusBlock, type ProgressInputs } from "../../shared/progress-list.js";
import { CATCH_UP_TRAILER, FINAL_REVIEW_MARK, IMPLEMENT_LABEL, REVIEW_LABEL, SLICE_TRAILER } from "../../shared/record.js";
import { sliceRanges, type BranchCommit } from "../../shared/slice-ranges.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `implement-prd:publish` (#502, #503), called the way the CLI calls it: its
 * declared inputs, `implement-prd:gate`'s and `implement-prd:bundle`'s
 * hand-over directories, and the engine's real git reader, fetcher and
 * rewriter working in a clone checked out at the base, as the publish job's
 * checkout leaves it. Its writers are the engine's, whose loop push and
 * delete are the real `gitWrites` against a temporary bare repository
 * standing in for the one on GitHub, and whose other writes land on a fake
 * GitHub, which the push moves the PRD branch and its pull request's head on
 * too; the rescue branch's tip, the open pull requests and a PRD PR's rounds
 * are read from it. What is asserted is the remote's PRD branch and rescue
 * branch, the PRD PR and its labels, the writes and their order,
 * `published.json`, and the sentence it stopped with.
 *
 * The scenarios are the retired *Mark the slice's commits* step's
 * (`tests/slice-trailer-step.test.ts`), implement-prd's half of
 * `tests/publish-push-step.test.ts`, *Open or reuse the PRD PR*'s
 * (`tests/pr-body-steps.test.ts` and the `prd_pr` cases of
 * `tests/implement-prd-preflight.test.ts`) and *Request review*'s
 * (`tests/loop-token-step.test.ts` and `tests/workflows.test.ts`), and
 * *Hand over PRD PR*'s (the `handover` cases of the same retired file),
 * carried over by behaviour, and the ones the move adds: the mark is read
 * back as the next gate reads it, rescued commits are marked, an empty range is refused,
 * a push someone made meanwhile is refused by the lease rather than
 * overwritten, the PRD PR GitHub opened while erroring is carried on with,
 * and the list is rendered from data.
 */

type Inputs = InputValues<(typeof COMMANDS)["implement-prd:publish"]["inputs"]>;

const PARENT = 222;
const PRD_BRANCH = "agent/prd-222-slices";
const RESCUE = `agent/rescue/prd-${PARENT}`;
const SUB = 242;
/**
 * The gate's snapshot: #240 landed before the upgrade, closed with no slice,
 * #241 is on the PRD branch, #242 is this run's, and #243 is next.
 */
const SUB_ISSUES = [
  { number: 240, title: "landed before the upgrade", state: "CLOSED" },
  { number: 241, title: "an earlier slice", state: "OPEN" },
  { number: SUB, title: "this run's", state: "OPEN" },
  { number: 243, title: "next", state: "OPEN" },
] as const;
const PRD_TITLE = "A PRD";
const RUN_URL = "https://github.com/acme/widgets/actions/runs/7";
const SERVER = "https://github.com";
const REPO = "acme/widgets";
/** The account the loop's reviews are posted as. */
const BOT = "github-actions[bot]";
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
let gated: string;
let env: GitEnvironment;
/** `main` as the chain started. */
let base: string;
/** The PRD branch's tip as the catch-up left it: an earlier slice, #241. */
let tip: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let written: Map<string, unknown>;
/** Whether GitHub moves the head of the pull request from a branch a push moved, as it does, eventually. */
let headsFollow: boolean;

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
  gated = path.join(scratch, "gate");
  fs.mkdirSync(gated);
  fs.writeFileSync(
    path.join(gated, "prd-issue.json"),
    JSON.stringify({
      parent: null,
      labels: { nodes: [{ name: IMPLEMENT_LABEL }] },
      subIssues: { totalCount: SUB_ISSUES.length, nodes: SUB_ISSUES },
    }),
  );
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(scratch, "init", "--quiet", "--initial-branch=main", seed);
  base = commit(seed, "chore: the default branch", "main");
  git(seed, "push", "--quiet", origin, "main");
  git(seed, "checkout", "--quiet", "-b", PRD_BRANCH);
  tip = commit(seed, `feat: an earlier slice\n\n${SLICE_TRAILER}: #241`);
  git(seed, "push", "--quiet", origin, PRD_BRANCH);
  git(scratch, "clone", "--quiet", origin, agent);
  git(agent, "checkout", "--quiet", "-B", PRD_BRANCH, tip);
  github = fakeGitHub([]);
  github.issueLabels.set(PARENT, [IMPLEMENT_LABEL]);
  headsFollow = true;
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
  GH_REPO: REPO,
  GH_TOKEN: TOKEN,
  LOOP_TOKEN,
  LOOP_TOKEN_SOURCE: "app",
  AGENT_LOOP_LOGINS: "",
  GITHUB_SERVER_URL: SERVER,
  GITHUB_REPOSITORY: REPO,
  ISSUE_NUMBER: String(PARENT),
  ISSUE_TITLE: PRD_TITLE,
  BASE_REF: "main",
  PRD_BRANCH,
  PRD_TIP: tip,
  BUILD: "true",
  FINISHING: "false",
  PRD_PR: "",
  LANDED: "",
  RUN_URL: RUN_URL,
  BASE_SHA: tip,
  SUB: String(SUB),
  RESCUE_BRANCH: RESCUE,
  CHECKOUT: work,
  HEAD_WAIT_SECONDS: "0",
  HEAD_POLL_SECONDS: "0",
  GATE_DIR: gated,
  BUNDLE_DIR: handed,
  ...over,
});

/** The open-only run's inputs: nothing built, so no sub-issue, no catch-up and no bundle. */
const OPEN_ONLY = (over: Partial<Inputs> = {}): Inputs => INPUTS({ BUILD: "false", SUB: "", BASE_SHA: "", ...over });

/** The CLI's half, in the publish job's fresh clone of the base: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  git(scratch, "clone", "--quiet", origin, work);
  const fetcher = gitFetcher({ dir: work, env, remote: origin }, TOKEN);
  const real = gitWrites({ dir: work, env, remote: origin }, LOOP_TOKEN);
  const io: RewritingCheckoutIo<(typeof COMMANDS)["implement-prd:publish"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits, {
        loop: {
          ...real,
          // The real push, and GitHub seeing it: the branch moves, and so
          // does the head of the pull request from it.
          pushRef: async (call, push) => {
            const done = await real.pushRef(call, push);
            const name = push.ref.replace(/^refs\/heads\//, "");
            github.branches.set(name, push.commit);
            if (headsFollow) for (const pr of github.pullRequests.values()) if (pr.headRef === name) pr.headSha = push.commit;
            return done;
          },
        },
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

/** Every write a build run that opens the PRD PR makes, in order. */
const OPENED_WRITES = ["loop pushRef", "loop deleteRef", "loop openPullRequest", "loop comment", "loop removeLabel", "loop removeLabel", "loop addLabel"];

const LIMITS = { pushRef: 1, deleteRef: 1, openPullRequest: 1, editPullRequest: 2, markReadyForReview: 1, comment: 2, removeLabel: 2, addLabel: 1 };

const warnings = (): string[] =>
  vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.startsWith("::warning::"));

/** An open pull request on the fake, from `head` into `base`, its head where GitHub has `head`'s branch. */
const existing = (number: number, head: string, base = "main", body = ""): void => {
  github.pullRequests.set(number, {
    number,
    nodeId: `PR_${number}`,
    state: "open",
    draft: true,
    headSha: github.branches.get(head) ?? tip,
    title: PRD_TITLE,
    body,
    labels: [],
    headRef: head,
    baseRef: base,
  });
};

/** The pull request opened from the PRD branch, where one was. */
const prdPr = () => [...github.pullRequests.values()].find((pr) => pr.headRef === PRD_BRANCH && pr.state === "open");

/**
 * The PRD branch on the remote, read as a runner reads it (`readPrdBranch` in
 * `shared/prd-round.ts`), through git's own log rather than the engine's
 * reader: the slices the progress list is rendered from.
 */
const branchOnRemote = (): BranchCommit[] =>
  git(
    origin,
    "log",
    "--first-parent",
    `--format=%H%x1f%P%x1f%(trailers:key=${SLICE_TRAILER},valueonly,separator=%x2C)%x1f%(trailers:key=${CATCH_UP_TRAILER},valueonly,separator=%x2C)%x1e`,
    `refs/heads/main..refs/heads/${PRD_BRANCH}`,
  )
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", parents = "", trailer = "", catchUp = ""] = record.split("\x1f");
      const number = /#(\d+)/.exec(trailer.split(",")[0] ?? "")?.[1];
      return { sha, parents: parents.split(" ").filter(Boolean), slice: number === undefined ? null : Number(number), catchUp: catchUp.trim() !== "" };
    });

/** What the runner rendered for the branch as it is on the remote, with the chain in review. */
const rendered = (over: Partial<ProgressInputs> = {}): { readonly progress: string; readonly status: string } => {
  const inputs: ProgressInputs = {
    subIssues: SUB_ISSUES,
    ranges: sliceRanges(branchOnRemote(), SUB_ISSUES),
    verdict: "none",
    running: { kind: "review" },
    finalReview: "not requested",
    ...over,
  };
  return { progress: renderProgressList(inputs), status: statusBlock(renderPrdStatus(inputs)) };
};

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
    expect(written.get("published.json")).toEqual({ pushed: true, head: pushed, pr: 1, requested: true, handedOver: false });
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
    expect(writes()).toEqual(OPENED_WRITES);
    expect(asked).toEqual(LIMITS);
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
    expect(written.get("published.json")).toEqual({ pushed: false, requested: false, handedOver: false });
    expect(remoteTip(RESCUE)).toBe(rescued);
    expect(prdPr()).toBeUndefined();
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

    expect(writes()).toEqual(OPENED_WRITES.filter((w) => w !== "loop deleteRef"));
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

/**
 * The PRD PR (#503): opened as a draft by the run that builds the first
 * slice, with the PRD frame and the list rendered from the branch it pushed,
 * then the slice's chapter marker, and its review asked for. The writes, the
 * frame and the labels are what a human sees.
 */
describe("implement-prd:publish opens the PRD PR and asks for its review", { timeout: CEILING }, () => {
  let pushed: () => string;

  beforeEach(() => {
    commit(agent, "feat: build the slice (#242)");
    bundle();
    pushed = () => remoteTip(PRD_BRANCH) ?? "";
  }, CEILING);

  it("opens a draft from the PRD branch into the base, framed, with the list and status line the runner renders for the branch it pushed", async () => {
    await run();

    const pr = prdPr();
    const { progress, status } = rendered();
    expect(pr).toMatchObject({ number: 1, draft: true, baseRef: "main", title: PRD_TITLE, headSha: pushed() });
    expect(pr?.body).toBe(renderPullRequestFrame({ prd: PARENT, open: [241, SUB, 243], progress, status }));
    // What that render is, for this branch: the earlier slice approved, this
    // one in review, the next not started, and the one that landed before the
    // upgrade said so; the parent and the open sub-issues closed on merge.
    expect(status).toBe(statusBlock(`**🔍 Reviewing slice 3 of 4** · #${SUB}`));
    expect(progress).toContain("| 1 · #240 | ☑️ Landed before upgrade |");
    expect(progress).toContain("| 2 · #241 | ✅ Approved |");
    expect(progress).toContain(`| 3 · #${SUB} | 🔍 In review |`);
    expect(progress).toContain("| 4 · #243 | ⏳ Not started |");
    expect(pr?.body).toContain(`<!-- agent:closes -->\nCloses #${PARENT}, closes #241, closes #${SUB}, closes #243\n<!-- /agent:closes -->\n`);
  });

  it("marks the slice's start on the PRD PR it opened, then takes agent:implement off the parent and puts agent:review on, removed first", async () => {
    await run();

    expect(writes()).toEqual(OPENED_WRITES.filter((w) => w !== "loop deleteRef"));
    expect(github.comments).toEqual([{ token: "loop", issue: 1, body: `**Slice 3 of 4 · #${SUB} started**` }]);
    const labels = (made?.writes ?? []).filter((w) => w.type === "removeLabel" || w.type === "addLabel").map((w) => [w.type, ...w.args]);
    expect(labels).toEqual([
      ["removeLabel", PARENT, IMPLEMENT_LABEL],
      ["removeLabel", 1, REVIEW_LABEL],
      ["addLabel", 1, REVIEW_LABEL],
    ]);
    expect(github.issueLabels.get(PARENT)).toEqual([]);
    expect(prdPr()?.labels).toEqual([REVIEW_LABEL]);
    expect(written.get("published.json")).toEqual({ pushed: true, head: pushed(), pr: 1, requested: true, handedOver: false });
    expect(warnings()).toEqual([]);
  });

  it("cuts the title at 256 characters, never inside one", async () => {
    await run(INPUTS({ ISSUE_TITLE: `${"x".repeat(255)}😀😀` }));

    expect(prdPr()?.title).toBe(`${"x".repeat(255)}😀`);
  });

  it("goes on to the review where the slice's start cannot be said", async () => {
    github.fails = (write) => write.type === "comment";

    await run();

    expect(prdPr()?.labels).toEqual([REVIEW_LABEL]);
    expect(warnings()).toEqual([`::warning::Could not say on PRD PR #1 that sub-issue #${SUB} started. GitHub's reply is in the write log.`]);
  });

  it("asks for the review once the PRD PR shows the pushed commit, and warns, naming both, where it never does", async () => {
    existing(201, PRD_BRANCH);
    headsFollow = false;

    await run();

    expect(warnings()).toEqual([
      `::warning::PR #201 still shows ${tip} as its head 0s after ${pushed()} was pushed. Asking for the review anyway: it reads the branch tip itself, and refuses by name if it cannot settle on ${pushed()}.`,
    ]);
    expect(github.pullRequests.get(201)?.labels).toEqual([REVIEW_LABEL]);
  });

  it("warns where the loop's token is the workflow's, since the label it adds then starts nothing", async () => {
    await run(INPUTS({ LOOP_TOKEN_SOURCE: "workflow" }));

    expect(prdPr()?.labels).toEqual([REVIEW_LABEL]);
    expect(warnings()).toEqual([
      `::warning::Neither the loop's App nor AGENT_PAT is set, so this label was added with GITHUB_TOKEN and will NOT trigger agent-review. Add ${REVIEW_LABEL} by hand on PRD PR #1.`,
    ]);
  });

  it("stops, naming the review as what is missing, where agent:review cannot be added", async () => {
    github.fails = (write) => write.type === "addLabel";

    await expect(run()).rejects.toThrow(`Couldn't add \`${REVIEW_LABEL}\` to PRD PR #1, so no review was requested.`);
    expect(written.get("published.json")).toEqual({ pushed: true, head: pushed(), pr: 1, requested: false, handedOver: false });
  });

  it("never takes an open PR from another head as the PRD PR", async () => {
    existing(40, "their-branch", "main", `Closes #${PARENT}`);

    await run();

    expect(prdPr()?.number).toBe(41);
    expect(github.pullRequests.get(40)?.labels).toEqual([]);
  });

  it("refuses to guess between two open PRs from the PRD branch, with the slice pushed", async () => {
    existing(201, PRD_BRANCH);
    existing(205, PRD_BRANCH, "release");

    await expect(run()).rejects.toThrow(
      `2 open PRs come from this PRD's branch \`${PRD_BRANCH}\` (#201, #205), so it can't tell which one is the PRD PR. Close all but one.`,
    );
    expect(writes()).toEqual(["loop pushRef"]);
    expect(written.get("published.json")).toEqual({ pushed: true, head: pushed(), requested: false, handedOver: false });
  });

  /**
   * #329, for a PRD: GitHub has answered a pull request's open with an error
   * and opened it all the same, so a server error is read back, by this head
   * and this base, before it is called a failure.
   */
  describe("on a server error opening it", () => {
    const erroring = (landed: boolean, readBack: false | "fails" = false): void => {
      github.fails = (write, call) => {
        if (write.type !== "openPullRequest") return false;
        if (call === "POST pulls") return { status: 502, landed };
        return readBack === "fails" ? { status: 503, landed: false } : false;
      };
    };

    it("carries on with the PRD PR GitHub opened: marked, reviewed, and a warning", async () => {
      erroring(true);

      await run();

      expect(writes()).toEqual(OPENED_WRITES.filter((w) => w !== "loop deleteRef"));
      expect(prdPr()?.labels).toEqual([REVIEW_LABEL]);
      expect(warnings()).toEqual([
        expect.stringMatching(
          /^::warning::GitHub answered opening the PRD PR with a server error \(.*502.*\), but PR #1 from `agent\/prd-222-slices` into `main` is open, so this run goes on with it\.$/,
        ),
      ]);
      expect(written.get("published.json")).toEqual({ pushed: true, head: pushed(), pr: 1, requested: true, handedOver: false });
    });

    it("fails where the read-back fails too, saying to look for the PRD PR before adding agent:implement again", async () => {
      erroring(true, "fails");

      await expect(run()).rejects.toThrow(
        /^GitHub answered opening the PRD PR from `agent\/prd-222-slices` with a server error, and whether it opened anyway could not be read back \(.*503.*\)\. Look for an open pull request from `agent\/prd-222-slices` before adding `agent:implement` again; if there is one, add `agent:review` to it instead\.$/,
      );
      expect(writes()).toEqual(["loop pushRef", "loop openPullRequest"]);
    });

    it("fails where none opened, never taking a PR from another head", async () => {
      existing(40, "their-branch");
      erroring(false);

      await expect(run()).rejects.toThrow(/^Couldn't open the PRD PR from `agent\/prd-222-slices` into `main`: /);
      expect(github.pullRequests.get(40)?.labels).toEqual([]);
      expect(written.get("published.json")).toEqual({ pushed: true, head: pushed(), requested: false, handedOver: false });
    });
  });

  it("says to set the App or AGENT_PAT up where the workflow token was refused the open", async () => {
    github.fails = (write) => write.type === "openPullRequest";

    await expect(run(INPUTS({ LOOP_TOKEN_SOURCE: "workflow" }))).rejects.toThrow(
      "Couldn't open the PRD PR, because neither the loop's App nor `AGENT_PAT` is set and GitHub doesn't let the default token open PRs. Set up one of them first.",
    );
  });
});

/**
 * A later slice's run finds the PRD PR an earlier one opened by its head, and
 * splices the list and status line into it as every writer of them splices
 * them, counting its rounds off it, read through the reader.
 */
describe("implement-prd:publish reuses the PRD PR an earlier run opened", { timeout: CEILING }, () => {
  const PR = 201;
  const PR_URL = `${SERVER}/${REPO}/pull/${PR}`;
  const REVIEW_URL = `${PR_URL}#pullrequestreview-1`;
  const OLD_LIST = "<!-- agent:progress -->\nthe list as the last round left it\n<!-- /agent:progress -->";
  const OLD_STATUS = "<!-- agent:status -->\n> the line as the last round left it\n> <!-- /agent:status -->";
  const CLOSES = `<!-- agent:closes -->\nCloses #${PARENT}, closes #241, closes #${SUB}, closes #243\n<!-- /agent:closes -->`;
  /** A body as a PRD PR's frame left it, with a maintainer's note outside the blocks. */
  const FRAMED = `> [!NOTE]\n> ${OLD_STATUS}\n>\n> Mine.\r\n\n---\n\n${OLD_LIST}\n\n${CLOSES}\n`;
  let pushed: () => string;

  beforeEach(() => {
    commit(agent, "feat: build the slice (#242)");
    bundle();
    pushed = () => remoteTip(PRD_BRANCH) ?? "";
    github.branches.set(PRD_BRANCH, tip);
    existing(PR, PRD_BRANCH, "main", FRAMED);
    // Slice #241's round: one review by the loop, one fix round.
    github.reviews.push({
      token: BOT,
      pullRequestId: `PR_${PR}`,
      commit: tip,
      body: "**Slice 2 of 4 · #241 · review 1**\n\n## Agent review\n\nLooks right.",
      threads: [],
      url: REVIEW_URL,
      submittedAt: "2026-01-01T00:00:00Z",
    });
    github.labelled.set(PR, [{ label: "agent:fix", at: "2026-01-01T00:05:00Z" }]);
  }, CEILING);

  /** The list and status line the runner rendered for the branch, with the PRD PR's rounds and its diffs. */
  const reusedRender = () =>
    rendered({
      prUrl: PR_URL,
      rounds: {
        slices: { 241: { reviews: 1, latestReview: REVIEW_URL, fixes: 1 }, [SUB]: { reviews: 0, fixes: 0 } },
        final: { reviews: 0, fixes: 0 },
        all: { reviews: 1, fixes: 1 },
      },
    });

  it("splices in the list and status line the runner renders for the branch, its rounds counted, keeping every byte outside the markers, and opens none", async () => {
    await run();

    const { progress, status } = reusedRender();
    expect(github.pullRequests.get(PR)?.body).toBe(`> [!NOTE]\n> ${status}\n>\n> Mine.\r\n\n---\n\n${progress}\n\n${CLOSES}\n`);
    expect(progress).toContain(`| 2 · #241 | ✅ Approved | [1](${REVIEW_URL}) | 1 | [diff](${PR_URL}/files/${base}..${tip}) |`);
    expect(progress).toContain(`| 3 · #${SUB} | 🔍 In review | 0 | 0 | [diff](${PR_URL}/files/${tip}..${pushed()}) |`);
    expect(writes()).toEqual(["loop pushRef", "loop editPullRequest", "loop removeLabel", "loop removeLabel", "loop addLabel"]);
    expect(github.comments).toEqual([]);
    expect(github.pullRequests.size).toBe(1);
    expect(github.pullRequests.get(PR)?.labels).toEqual([REVIEW_LABEL]);
    expect(written.get("published.json")).toEqual({ pushed: true, head: pushed(), pr: PR, requested: true, handedOver: false });
  });

  /** Pre-upgrade compatibility, removable under #224: a body an older release opened has no `Closes` block. */
  it("appends the Closes block to a body with no Closes marker, once", async () => {
    const OLD = "Closes #222\n\n## Progress\n<!-- agent:slices -->\n| One (#241) | #20 |\n<!-- /agent:slices -->\n";
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = OLD;

    await run();

    const { progress } = reusedRender();
    expect(github.pullRequests.get(PR)?.body).toBe(`${OLD}\n${progress}\n\n${CLOSES}`);
  });

  it("leaves a body with half a list as it stands, warns, and still asks for the review", async () => {
    const HALF = "Mine.\n<!-- agent:progress -->\nrest";
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = HALF;

    await run();

    expect(github.pullRequests.get(PR)?.body).toBe(HALF);
    expect(warnings()).toEqual([
      `::warning::PRD PR #${PR}'s body carries half a progress list, or two, so it was not written. Restore the missing marker, or delete the markers and the text between them, and the next ending of a round writes it again.`,
    ]);
    expect(github.pullRequests.get(PR)?.labels).toEqual([REVIEW_LABEL]);
  });

  it("writes the list where the status line is half a pair, leaving the line as it stands", async () => {
    const HALF_LINE = FRAMED.replace("> <!-- /agent:status -->", ">");
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = HALF_LINE;

    await run();

    const { progress } = reusedRender();
    expect(github.pullRequests.get(PR)?.body).toBe(HALF_LINE.replace(OLD_LIST, progress));
  });

  it("warns where the list cannot be written, and still asks for the review", async () => {
    github.fails = (write) => write.type === "editPullRequest";

    await run();

    expect(github.pullRequests.get(PR)?.body).toBe(FRAMED);
    expect(warnings()).toEqual([`::warning::Could not write PRD PR #${PR}'s progress list. GitHub's reply is in the write log.`]);
    expect(github.pullRequests.get(PR)?.labels).toEqual([REVIEW_LABEL]);
  });
});

/**
 * The run that finds slices built and no PRD PR open, a run that died
 * between its push and its PRD PR (#246): no agent ran, so there is no
 * hand-over, and it opens the PRD PR over the slices on the branch and asks
 * for their review.
 */
describe("implement-prd:publish on a run that only opens a missing PRD PR", { timeout: CEILING }, () => {
  it("opens the PRD PR over the slices already built, without an agent's hand-over, and asks for its review", async () => {
    await run(OPEN_ONLY());

    const { progress, status } = rendered();
    expect(status).toBe(statusBlock("**🔍 Reviewing slice 2 of 4** · #241"));
    expect(prdPr()?.body).toBe(renderPullRequestFrame({ prd: PARENT, open: [241, SUB, 243], progress, status }));
    expect(remoteTip(PRD_BRANCH)).toBe(tip);
    expect(writes()).toEqual(["loop openPullRequest", "loop removeLabel", "loop removeLabel", "loop addLabel"]);
    expect(github.comments).toEqual([]);
    expect(prdPr()?.labels).toEqual([REVIEW_LABEL]);
    expect(written.get("published.json")).toEqual({ pushed: false, pr: 1, requested: true, handedOver: false });
  });

  it("refuses a build that names no sub-issue, rather than opening the PRD PR as though nothing was built", async () => {
    await expect(run(OPEN_ONLY({ BUILD: "true" }))).rejects.toThrow('SUB is "", which is not a sub-issue number.');
    expect(made).toBeUndefined();
  });
});

/**
 * The finishing run (#504): every sub-issue built and the last slice's round
 * approved, so no agent ran and nothing is pushed. One slice was reviewed as
 * the whole PRD PR already, so it is marked ready and no review is asked for.
 * More than one asks for the final review: recorded in the body first, then
 * `agent:review`. The handover cases of the retired
 * `tests/implement-prd-preflight.test.ts`, carried over by behaviour.
 */
describe("implement-prd:publish hands the PRD PR over on the finishing run", { timeout: CEILING }, () => {
  const PR = 201;
  const PR_URL = `${SERVER}/${REPO}/pull/${PR}`;
  const FINISHING = (landed: number, over: Partial<Inputs> = {}): Inputs =>
    OPEN_ONLY({ FINISHING: "true", PRD_PR: String(PR), LANDED: String(landed), ...over });
  const body = (): string | undefined => github.pullRequests.get(PR)?.body;
  const START = `**Final review of all ${SUB_ISSUES.length} slices started** · [Workflow run](${RUN_URL})`;

  beforeEach(() => {
    existing(PR, PRD_BRANCH, "main", `Closes #${PARENT}`);
  });

  it("marks the PRD PR of a one-slice PRD ready itself, and asks for no review", async () => {
    await run(FINISHING(1));

    expect(writes()).toEqual(["loop markReadyForReview"]);
    expect(github.pullRequests.get(PR)).toMatchObject({ draft: false, body: `Closes #${PARENT}`, labels: [] });
    expect(github.comments).toEqual([]);
    expect(written.get("published.json")).toEqual({ pushed: false, pr: PR, requested: false, handedOver: true });
    expect(remoteTip(PRD_BRANCH)).toBe(tip);
  });

  it("records the final review in the body, then takes agent:implement off and puts agent:review on, removed first, then says it started", async () => {
    await run(FINISHING(3));

    expect(body()).toBe(`Closes #${PARENT}\n\n${FINAL_REVIEW_MARK}`);
    expect(writes()).toEqual(["loop editPullRequest", "loop removeLabel", "loop removeLabel", "loop addLabel", "loop comment"]);
    const labels = (made?.writes ?? []).filter((w) => w.type === "removeLabel" || w.type === "addLabel").map((w) => [w.type, ...w.args]);
    expect(labels).toEqual([
      ["removeLabel", PARENT, IMPLEMENT_LABEL],
      ["removeLabel", PR, REVIEW_LABEL],
      ["addLabel", PR, REVIEW_LABEL],
    ]);
    expect(github.issueLabels.get(PARENT)).toEqual([]);
    expect(github.pullRequests.get(PR)).toMatchObject({ draft: true, labels: [REVIEW_LABEL] });
    expect(github.comments).toEqual([{ token: "loop", issue: PR, body: START }]);
    expect(written.get("published.json")).toEqual({ pushed: false, pr: PR, requested: true, handedOver: true });
    expect(warnings()).toEqual([]);
  });

  it("drops the body's trailing line breaks before the mark, as the shell read it", async () => {
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = `Closes #${PARENT}\n\n`;

    await run(FINISHING(2));

    expect(body()).toBe(`Closes #${PARENT}\n\n${FINAL_REVIEW_MARK}`);
  });

  /**
   * The mark goes into the progress list (#246), with the final review shown
   * in review: what the list rendered for the final review requested is, byte
   * for byte, the one the last slice's round left with the lines written in
   * front of its end marker, and the status line the one rendered for it.
   */
  it("records the final review in the progress table and the status line as they render it", async () => {
    const ranges = sliceRanges(
      [
        { sha: "d", parents: ["c"], slice: 243 },
        { sha: "c", parents: ["b"], slice: SUB },
        { sha: "b", parents: ["a"], slice: 241 },
      ],
      SUB_ISSUES,
    );
    const rounds = {
      slices: { 241: { reviews: 1, fixes: 0 }, [SUB]: { reviews: 1, fixes: 0 }, 243: { reviews: 2, fixes: 1 } },
      final: { reviews: 0, fixes: 0 },
      all: { reviews: 4, fixes: 1 },
    };
    const approved: ProgressInputs = { subIssues: SUB_ISSUES, ranges, verdict: "approval", running: null, finalReview: "not requested", prUrl: PR_URL, rounds };
    const requested: ProgressInputs = { ...approved, running: { kind: "review" }, finalReview: "requested" };
    const framed = (inputs: ProgressInputs): string =>
      `> [!NOTE]\n> ${statusBlock(renderPrdStatus(inputs))}\n\n${renderProgressList(inputs)}\n\nMine.`;
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = framed(approved);

    await run(FINISHING(3));

    expect(body()).toBe(framed(requested));
    expect(renderPrdStatus(requested)).toBe(`**🔍 Final review of all ${SUB_ISSUES.length} slices**`);
    expect(renderProgressList(requested)).toContain(FINAL_REVIEW_MARK);
  });

  /** A retry finds the record a run before it wrote, and writes it once. */
  it("does not record the final review twice on a retry, and still asks for it", async () => {
    const MARKED = `Closes #${PARENT}\n\n${FINAL_REVIEW_MARK}`;
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = MARKED;

    await run(FINISHING(2));

    expect(body()).toBe(MARKED);
    expect(made?.lines.filter((line) => line.includes("PATCH"))).toEqual([]);
    expect(github.pullRequests.get(PR)?.labels).toEqual([REVIEW_LABEL]);
    expect(written.get("published.json")).toEqual({ pushed: false, pr: PR, requested: true, handedOver: true });
  });

  /**
   * The mark is what `implement-prd:gate` reads "finished" by, so a label
   * that did not go on takes it back out: left in, the retry the failure
   * comment offers would be refused as finished, and no final review would
   * ever run.
   */
  it("takes the final-review mark back out when the label does not go on, and stops with a sentence", async () => {
    github.fails = (write) => write.type === "addLabel";

    await expect(run(FINISHING(3))).rejects.toThrow(
      `Couldn't add \`${REVIEW_LABEL}\` to PRD PR #${PR}, so its final review was not requested. Trying again resumes the handover and builds nothing.`,
    );
    expect(body()).toBe(`Closes #${PARENT}`);
    expect(writes()).toEqual(["loop editPullRequest", "loop removeLabel", "loop removeLabel", "loop addLabel", "loop editPullRequest"]);
    expect(github.comments).toEqual([]);
    expect(written.get("published.json")).toEqual({ pushed: false, pr: PR, requested: false, handedOver: false });
  });

  it("says to add agent:review by hand where the mark cannot be taken back out either", async () => {
    let edits = 0;
    github.fails = (write) => write.type === "addLabel" || (write.type === "editPullRequest" && ++edits > 1);

    await expect(run(FINISHING(3))).rejects.toThrow(
      `Couldn't add \`${REVIEW_LABEL}\` to PRD PR #${PR}, and couldn't take back out the note that its final review is due. Add \`${REVIEW_LABEL}\` to PRD PR #${PR} by hand.`,
    );
    expect(body()).toBe(`Closes #${PARENT}\n\n${FINAL_REVIEW_MARK}`);
  });

  it("leaves a mark a retry found in place where the label does not go on, since this run did not write it", async () => {
    const MARKED = `Closes #${PARENT}\n\n${FINAL_REVIEW_MARK}`;
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = MARKED;
    github.fails = (write) => write.type === "addLabel";

    await expect(run(FINISHING(2))).rejects.toThrow("so its final review was not requested.");
    expect(body()).toBe(MARKED);
  });

  it("stops before any label where the mark cannot be written", async () => {
    github.fails = (write) => write.type === "editPullRequest";

    await expect(run(FINISHING(3))).rejects.toThrow(
      `Couldn't note on PRD PR #${PR} that its final review is due, so it wasn't requested. Trying again builds nothing.`,
    );
    expect(writes()).toEqual(["loop editPullRequest"]);
  });

  it("goes on where the final review's start cannot be said", async () => {
    github.fails = (write) => write.type === "comment";

    await run(FINISHING(3));

    expect(written.get("published.json")).toEqual({ pushed: false, pr: PR, requested: true, handedOver: true });
    expect(warnings()).toEqual([
      `::warning::Could not post the final review's start comment on PRD PR #${PR}. GitHub's reply is in the write log.`,
    ]);
  });

  it("stops with a sentence where the PRD PR cannot be marked ready", async () => {
    github.fails = (write) => write.type === "markReadyForReview";

    await expect(run(FINISHING(1))).rejects.toThrow(
      `Couldn't mark PRD PR #${PR} ready for review. Trying again resumes the handover and builds nothing.`,
    );
    expect(written.get("published.json")).toEqual({ pushed: false, pr: PR, requested: false, handedOver: false });
  });

  /**
   * The App's token fires events as the PAT does, so it hands over the same
   * way (#319); the workflow token cannot mark a draft ready, and a label
   * added with it starts no review, so it touches nothing.
   */
  it.each(["app", "pat"] as const)("hands over on the %s token", async (source) => {
    await run(FINISHING(1, { LOOP_TOKEN_SOURCE: source }));

    expect(github.pullRequests.get(PR)?.draft).toBe(false);
  });

  it.each([1, 2])("refuses on the workflow token with %i slice(s) landed, touching nothing", async (landed) => {
    await expect(run(FINISHING(landed, { LOOP_TOKEN_SOURCE: "workflow" }))).rejects.toThrow(
      `Couldn't hand PRD PR #${PR} over, because neither the loop's App nor \`AGENT_PAT\` is set and GitHub doesn't let the default token mark a draft ready or start a review. Every sub-issue is built. Set up one of them; trying again resumes the handover and builds nothing.`,
    );
    expect(made).toBeUndefined();
    expect(github.pullRequests.get(PR)).toMatchObject({ draft: true, body: `Closes #${PARENT}`, labels: [] });
  });

  it("refuses a finishing run that names no PRD PR", async () => {
    await expect(run(FINISHING(2, { PRD_PR: "" }))).rejects.toThrow('PRD_PR is "", which is not a pull request number.');
    expect(made).toBeUndefined();
  });
});

describe("the build prompt", () => {
  it("does not mention the trailer, which implement-prd:publish writes and the agent is never asked to", () => {
    expect(fs.readFileSync(path.join("implement-prd", "prompt.md"), "utf8")).not.toMatch(/agent-slice|trailer/i);
  });
});
