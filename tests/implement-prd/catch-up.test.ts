import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitFetcher, gitMerger, gitReader, gitWrites, type GitEnvironment } from "../../engine/git.js";
import type { Limits } from "../../engine/writer.js";
import { catchUp } from "../../implement-prd/catch-up.js";
import type { MergingCheckoutIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import type { InputValues } from "../../shared/env.js";
import { CATCH_UP_TRAILER, IMPLEMENT_LABEL, LOOP_COMMITTER, SLICE_TRAILER } from "../../shared/record.js";
import { sliceRanges, type BranchCommit } from "../../shared/slice-ranges.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `implement-prd:catch-up` (#500), called the way the CLI calls it: its
 * declared inputs, the engine's real fetcher, merger and git reader working in
 * a clone checked out at the base, as the catch-up job's checkout leaves it,
 * and the engine's writers, whose loop push is the real `gitWrites` against a
 * temporary bare repository standing in for the one on GitHub, and whose
 * comment and label go to a fake GitHub. What is asserted is the remote's
 * PRD branch, the record's writes, `catch-up.json` and the sentence it
 * stopped with.
 *
 * The scenarios are the retired *Merge the default branch into the PRD
 * branch* step's (`tests/default-branch-merge-step.test.ts`), carried over by
 * behaviour, the park's comment word for word, and the two it gains: a fetch
 * that fails says why, and a push someone made meanwhile is refused by the
 * lease rather than overwritten.
 */

type Inputs = InputValues<(typeof COMMANDS)["implement-prd:catch-up"]["inputs"]>;

const PARENT = 222;
const PRD_BRANCH = "agent/prd-222-slices";
const PRD_PR = 286;
const SUB = 245;
const TOKEN = "ghs_workflow-token-0123456789";
const LOOP_TOKEN = "ghs_loop-token-0123456789";
const CI = ".github/workflows/ci.yml";
/** Building the repositories spawns git a dozen times or so, and a case a dozen more. */
const CEILING = 30 * SUBPROCESS_TIMEOUT;

let scratch: string;
let origin: string;
let seed: string;
let work: string;
let env: GitEnvironment;
/** The PRD branch's tip on the remote before the run, which the gate read. */
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

/** Writes `files` in `seed`, then commits them with `message`, returning the commit. */
const commit = (message: string, files: Readonly<Record<string, string>>): string => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true });
    fs.writeFileSync(path.join(seed, name), text);
    git(seed, "add", name);
  }
  git(seed, "commit", "--quiet", "-m", message);
  return git(seed, "rev-parse", "HEAD");
};

/** What the default branch does next, on the remote, while the chain waits. */
const moveMain = (moves: "ci" | "docs" | "conflict"): string => {
  git(seed, "checkout", "--quiet", "main");
  if (moves === "ci") commit("ci: run on pull requests too", { [CI]: "on: [push, pull_request]\n" });
  if (moves === "docs") commit("docs: a second note", { "more.md": "two\n" });
  if (moves === "conflict") commit("docs: a different note", { "notes.md": "one, from main\n" });
  git(seed, "push", "--quiet", origin, "main");
  return git(seed, "rev-parse", "main");
};

/** The clone at the base branch, as the catch-up job's `actions/checkout` leaves it. */
const checkOut = (): void => {
  git(scratch, "clone", "--quiet", origin, work);
};

const remoteTip = (branch = PRD_BRANCH): string | undefined => {
  try {
    return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
};

/** A remote whose PRD branch holds slice #244, which touched `notes.md`, over a `main` with CI. */
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "implement-prd-catch-up-"));
  env = { PATH: process.env["PATH"] ?? "", HOME: scratch };
  origin = path.join(scratch, "origin.git");
  seed = path.join(scratch, "seed");
  work = path.join(scratch, "work");
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(scratch, "init", "--quiet", "--initial-branch=main", seed);
  commit("chore: the default branch", { "notes.md": "one\n", [CI]: "on: push\n" });
  git(seed, "push", "--quiet", origin, "main");
  git(seed, "checkout", "--quiet", "-b", PRD_BRANCH);
  tip = commit(`feat: slice 244\n\n${SLICE_TRAILER}: #244`, { "notes.md": "one, from slice 244\n" });
  git(seed, "push", "--quiet", origin, PRD_BRANCH);
  github = fakeGitHub();
  github.issueLabels.set(PARENT, [IMPLEMENT_LABEL]);
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
  ISSUE_NUMBER: String(PARENT),
  BASE_REF: "main",
  PRD_BRANCH,
  PRD_TIP: tip,
  PRD_PR: String(PRD_PR),
  SUB: String(SUB),
  CHECKOUT: work,
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const fetcher = gitFetcher({ dir: work, env, remote: origin }, TOKEN);
  const io: MergingCheckoutIo<(typeof COMMANDS)["implement-prd:catch-up"]["outputs"]> = {
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
    outputs: {
      writeJson: (name, value) => written.set(name, structuredClone(value)),
      writeText: (name, value) => written.set(name, value),
      writeBytes: () => {},
      appendLine: () => {},
    },
  };
  try {
    await catchUp(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

const writes = (): string[] => (made?.writes ?? []).map((w) => `${w.token} ${w.type}`);

/** The PRD branch's first-parent log over `main` on the remote, as `readPrdBranch` reads it. */
const branchLog = (): BranchCommit[] =>
  git(
    origin,
    "log",
    "--first-parent",
    `--format=%H%x1f%P%x1f%(trailers:key=${SLICE_TRAILER},valueonly)%x1f%(trailers:key=${CATCH_UP_TRAILER},valueonly)%x1e`,
    `main..refs/heads/${PRD_BRANCH}`,
  )
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", parents = "", slice = "", catchUpMark = ""] = record.split("\x1f");
      const number = /#(\d+)/.exec(slice)?.[1];
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        slice: number === undefined ? null : Number(number),
        ...(catchUpMark.trim() === "" ? {} : { catchUp: true }),
      };
    });

describe("implement-prd:catch-up on a PRD branch the default branch has not moved past", { timeout: CEILING }, () => {
  it("merges nothing and pushes nothing, and hands on the tip it found", async () => {
    checkOut();

    await run();

    expect(remoteTip()).toBe(tip);
    expect(git(work, "rev-parse", "HEAD")).toBe(tip);
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe(PRD_BRANCH);
    expect(written.get("catch-up.json")).toEqual({ parked: false, head: tip });
    expect(writes()).toEqual([]);
    expect(asked).toEqual({ pushRef: 1, comment: 1, removeLabel: 1 });
  });

  /**
   * The first slice's run: the gate found no PRD branch, so it is made at the
   * base here, merges nothing and pushes nothing, not even where the default
   * branch moved again since the checkout. It is pushed with its first slice.
   */
  it("makes a new PRD branch at the base, and merges and pushes nothing", async () => {
    checkOut();
    const moved = moveMain("docs");

    await run(INPUTS({ PRD_BRANCH: "agent/prd-222-new", PRD_TIP: "" }));

    expect(remoteTip("agent/prd-222-new")).toBeUndefined();
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("agent/prd-222-new");
    expect(git(work, "rev-parse", "HEAD")).toBe(moved);
    expect(written.get("catch-up.json")).toEqual({ parked: false, head: moved });
    expect(writes()).toEqual([]);
  });
});

describe("implement-prd:catch-up on a default branch that has moved", { timeout: CEILING }, () => {
  /**
   * **#211 follows from this case.** The default branch changes its CI
   * workflow mid-chain, and that change is on the PRD branch before the next
   * slice is built, so the next slice's round runs the new CI. Nobody did
   * anything by hand.
   */
  it("merges it into the PRD branch with today's message and trailer, as the loop's committer, and pushes it with the loop's token", async () => {
    const main = moveMain("ci");
    checkOut();

    await run();

    const merge = remoteTip();
    expect(merge).not.toBe(tip);
    expect(git(origin, "rev-list", "--parents", "-n", "1", merge!).split(" ").slice(1)).toEqual([tip, main]);
    expect(git(origin, "show", `${merge}:${CI}`)).toBe("on: [push, pull_request]");
    expect(git(origin, "log", "-1", "--format=%B", merge!)).toBe(`Merge main into ${PRD_BRANCH}\n\n${CATCH_UP_TRAILER}: #${SUB}`);
    expect(git(origin, "log", "-1", `--format=%(trailers:key=${CATCH_UP_TRAILER},valueonly)`, merge!)).toBe(`#${SUB}`);
    expect(git(origin, "log", "-1", `--format=%(trailers:key=${SLICE_TRAILER},valueonly)`, merge!)).toBe("");
    expect(git(origin, "log", "-1", "--format=%cn <%ce>", merge!)).toBe(`${LOOP_COMMITTER.name} <${LOOP_COMMITTER.email}>`);
    expect(written.get("catch-up.json")).toEqual({ parked: false, merged: merge, head: merge });
    expect(writes()).toEqual(["loop pushRef"]);
    expect(made?.writes[0]?.args).toEqual([{ ref: `refs/heads/${PRD_BRANCH}`, commit: merge, lease: { tip } }]);
  });

  /**
   * Before the slice's first trailered commit and marked as the chain's own
   * catch-up, the merge falls outside every slice range, so no slice round
   * reviews it: `shared/slice-ranges.ts` still recognises it.
   */
  it("lands outside every slice range, by the trailer slice-ranges reads", async () => {
    moveMain("docs");
    checkOut();

    await run();

    const merge = remoteTip()!;
    git(seed, "fetch", "--quiet", origin, `${PRD_BRANCH}:${PRD_BRANCH}`, "--force");
    git(seed, "checkout", "--quiet", PRD_BRANCH);
    const slice = commit(`feat: slice ${SUB}\n\n${SLICE_TRAILER}: #${SUB}`, { "slice.md": "245\n" });
    git(seed, "push", "--quiet", origin, PRD_BRANCH);

    const ranges = sliceRanges(branchLog(), [
      { number: 244, state: "CLOSED" },
      { number: SUB, state: "OPEN" },
    ]);
    expect(ranges.slices).toEqual([
      { subIssue: 244, range: { base: git(origin, "rev-parse", `${tip}^`), commits: [tip] } },
      { subIssue: SUB, range: { base: merge, commits: [slice] } },
    ]);
  });

  /** Each token rides on its own command, so the agent that follows finds neither in a checkout. */
  it("leaves neither token in the checkout's git config", async () => {
    moveMain("ci");
    checkOut();

    await run();

    const config = git(work, "config", "--list", "--show-origin");
    for (const token of [TOKEN, LOOP_TOKEN]) {
      expect(config).not.toContain(token);
      expect(config).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
    }
    expect(config).not.toMatch(/extraheader/i);
  });
});

describe("implement-prd:catch-up on a conflicting default branch", { timeout: CEILING }, () => {
  const PARK = `**\`agent:implement\` didn't run:** The default branch \`main\` has changed since the PRD branch last took it in, and merging it into \`${PRD_BRANCH}\` conflicts in \`notes.md\`. The chain parked before sub-issue #${SUB}, and nothing was built or pushed.`;

  /**
   * A conflict is a refusal, not a failure: nothing is built or pushed, and
   * the chain parks with today's comment on the parent naming the conflict
   * and `agent:update-branch` on the PRD PR. The label comes off and no
   * `agent:blocked` goes on.
   */
  it("parks: today's comment naming agent:update-branch on the PRD PR, agent:implement off, and nothing pushed", async () => {
    moveMain("conflict");
    checkOut();

    await run();

    expect(remoteTip()).toBe(tip);
    expect(written.get("catch-up.json")).toEqual({ parked: true });
    expect(writes()).toEqual(["workflow comment", "workflow removeLabel"]);
    expect(github.comments).toEqual([
      {
        token: "workflow",
        issue: PARENT,
        body: `${PARK} Add \`agent:update-branch\` to PRD PR #${PRD_PR} to merge it there and resolve the conflict. The chain moves on once a review of the resolution recommends approval.`,
      },
    ]);
    expect(github.issueLabels.get(PARENT)).toEqual([]);
  });

  it("parks naming a merge by hand where there is no PRD PR yet", async () => {
    moveMain("conflict");
    checkOut();

    await run(INPUTS({ PRD_PR: "" }));

    expect(remoteTip()).toBe(tip);
    expect(github.comments.map((c) => c.body)).toEqual([
      `${PARK} Merge \`main\` into \`${PRD_BRANCH}\` and resolve the conflict by hand, then add \`agent:implement\` again.`,
    ]);
  });

  it("still parks, and warns, where the comment is refused", async () => {
    moveMain("conflict");
    checkOut();
    github.fails = (write) => write.type === "comment";

    await run();

    expect(written.get("catch-up.json")).toEqual({ parked: true });
    expect(github.issueLabels.get(PARENT)).toEqual([]);
    expect(vi.mocked(console.log).mock.calls.map((c) => String(c[0]))).toContain(`::warning::Could not post the conflict comment on #${PARENT}.`);
  });
});

describe("implement-prd:catch-up stops with a sentence", { timeout: CEILING }, () => {
  /** Today's step said only that it couldn't; this says why. */
  it("where the default branch cannot be fetched, and pushes nothing", async () => {
    checkOut();

    await expect(run(INPUTS({ BASE_REF: "gone" }))).rejects.toThrow(
      /^Couldn't fetch `gone` to bring the PRD branch up to date with it, so nothing was built: ./,
    );
    expect(remoteTip()).toBe(tip);
    expect(written.has("catch-up.json")).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("where the PRD branch the gate found cannot be fetched", async () => {
    checkOut();
    git(origin, "update-ref", "-d", `refs/heads/${PRD_BRANCH}`);

    await expect(run()).rejects.toThrow(new RegExp(`^Couldn't fetch \`${PRD_BRANCH}\` to build sub-issue #${SUB} on it, so nothing was built: .`));
    expect(written.has("catch-up.json")).toBe(false);
  });

  /** The lease: a push someone made to the PRD branch since the gate read it is refused, not overwritten. */
  it("where the PRD branch moved since the gate read it, and leaves what is there", async () => {
    moveMain("docs");
    git(seed, "checkout", "--quiet", PRD_BRANCH);
    const theirs = commit("docs: someone else's", { "theirs.md": "theirs\n" });
    git(seed, "push", "--quiet", origin, PRD_BRANCH);
    checkOut();

    await expect(run()).rejects.toThrow(
      `Couldn't push the merge of \`main\` into \`${PRD_BRANCH}\`, so nothing was built. \`${PRD_BRANCH}\` moved since this run read it at ${tip}, so the merge was not pushed over what is there now. Trying again merges on top of it.`,
    );
    expect(remoteTip()).toBe(theirs);
    expect(written.has("catch-up.json")).toBe(false);
  });
});

/**
 * A remote whose `pre-receive` refuses every push stands in for GitHub's
 * refusal of a token without Workflows: write.
 */
describe("implement-prd:catch-up on a push the remote refuses", { timeout: CEILING }, () => {
  const refuseEveryPush = (): void => {
    const hook = path.join(origin, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
  };

  it("names Workflows: write and AGENT_PAT where the merge changes a workflow file", async () => {
    moveMain("ci");
    checkOut();
    refuseEveryPush();

    await expect(run()).rejects.toThrow(
      `Couldn't push the merge of \`main\` into \`${PRD_BRANCH}\`, so nothing was built. The merge changes \`${CI}\`, and GitHub refuses a push that changes a workflow file from a token without Workflows: write, so trying again fails the same way until the loop pushes with a token that has Workflows: write: the loop's App, or \`AGENT_PAT\`.`,
    );
    expect(remoteTip()).toBe(tip);
    expect(written.has("catch-up.json")).toBe(false);
  });

  it("names neither where the merge changes no workflow file", async () => {
    moveMain("docs");
    checkOut();
    refuseEveryPush();

    const error = await run().then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message).toMatch(new RegExp(`^Couldn't push the merge of \`main\` into \`${PRD_BRANCH}\`, so nothing was built\\. `));
    expect(error?.message).not.toMatch(/Workflows: write|AGENT_PAT/);
    expect(remoteTip()).toBe(tip);
  });
});
