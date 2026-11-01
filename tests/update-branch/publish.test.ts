import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseMoved, FetchFailed, GitError, type BundleHead, type GitFetcher, type GitMerger, type Merged } from "../../engine/git.js";
import { GitHubError } from "../../engine/github.js";
import type { CommitStatus, GitHubReader } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import type { MergingCheckoutIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { armDescription, LOOP_COMMITTER, MERGE_CONTEXT, readArmDescription, REVIEW_LABEL, UPDATE_BRANCH_LABEL, VERDICT_CONTEXT } from "../../shared/record.js";
import { publish } from "../../update-branch/publish.js";
import { fakeGit, fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `update-branch:publish` (#484), called the way the CLI calls it: its
 * declared inputs, the runner's hand-over directory and
 * `update-branch:bundle`'s, a fake GitHub reader, a fake git reader, fetcher
 * and merger standing for the checkout, and the engine's writers over a fake
 * GitHub, sharing one log. What is asserted is what it did to the record: the
 * writes it attempted, in what order and with which token, what each said,
 * what it refused before its first write, and `published.json`.
 *
 * The scenarios are the retired shell steps' (update-branch's half of
 * `tests/publish-push-step.test.ts`, and the publish job's assertions in
 * `tests/workflows.test.ts` on *Push branch*, *Carry the verdict over*,
 * *Comment on the PR* and *Request a review of the resolution*), carried over
 * by behaviour. The merge and the bundle check's git are fakes here; the
 * engine's own are tested against a real repository in
 * `tests/engine/git.test.ts`.
 */

const PR = 7;
const BRANCH = "agent/issue-12-do-the-thing";
/** The head the label's event named, which the run started from. */
const HEAD = "a".repeat(40);
/** The base commit the gate merged. */
const BASE = "b".repeat(40);
/** The base branch's tip now, which still holds it. */
const BASE_TIP = "c".repeat(40);
/** The merge: made again on the clean path, the agent's resolution on the conflicts one. */
const MERGE = "d".repeat(40);
const LOOP = "github-actions[bot]";
const REVIEW_URL = "https://github.com/o/r/pull/7#pullrequestreview-3";
/** The loop token's account, as the fake writer posts a status made with the loop's token. */
const ARM_ACCOUNT = "loop";
const ARMED_AT = "2026-11-01T03:59:35Z";

let root: string;
let runnerDir: string;
let bundleDir: string;
let github: FakeGitHub;
let reader: GitHubReader;
let files: Map<string, unknown>;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let git: ReturnType<typeof fakeGit>;
let merged: Merged | Error;
let fetched: string | Error;
let merges: Parameters<GitMerger["merge"]>[0][];
let fetches: string[];
let log: ReturnType<typeof vi.spyOn>;

const bundlePath = (): string => path.join(bundleDir, "branch.bundle");

/** A git reader over a checkout holding `history`, where the bundle, once handed over, carries `heads`. */
const holding = (
  history: Readonly<Record<string, readonly string[]>> = { [BASE_TIP]: [BASE, BASE_TIP], [MERGE]: [HEAD, BASE, MERGE] },
  heads: readonly BundleHead[] = [{ ref: `refs/heads/${BRANCH}`, commit: MERGE }],
) => fakeGit({ bundles: { [bundlePath()]: heads }, history });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "update-branch-publish-"));
  runnerDir = path.join(root, "runner");
  bundleDir = path.join(root, "runner", "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });
  github = fakeGitHub([{ number: PR, headSha: MERGE, labels: [UPDATE_BRANCH_LABEL] }]);
  github.branches.set(BRANCH, HEAD);
  reader = fakeReader(github).reader;
  files = new Map();
  made = undefined;
  asked = undefined;
  git = holding();
  merged = { status: "clean", base: BASE, commit: MERGE };
  fetched = BASE_TIP;
  merges = [];
  fetches = [];
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** `update-branch:bundle`'s bundle, its bytes the fake git's to read. */
const bundle = (): void => fs.writeFileSync(bundlePath(), "a bundle");
const comment = (text: string): void => fs.writeFileSync(path.join(runnerDir, "update_comment.md"), text);

/** A verdict on `sha`, newest first, as the endpoint lists them. */
const status = (over: Partial<CommitStatus> = {}): CommitStatus => ({
  context: VERDICT_CONTEXT,
  state: "success",
  targetUrl: REVIEW_URL,
  description: "Approval recommended. Merge it when you're ready.",
  creator: LOOP,
  ...over,
});

type Inputs = Parameters<typeof publish>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(root, "out"),
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "app",
  AGENT_LOOP_LOGINS: "",
  PR_NUMBER: String(PR),
  BRANCH,
  BASE_REF: "main",
  HEAD_SHA: HEAD,
  STATUS: "clean",
  BASE_SHA: BASE,
  AGENT_RESULT: "skipped",
  CHECKOUT: "/checkout",
  LOOP_LOGIN: ARM_ACCOUNT,
  HEAD_WAIT_SECONDS: "0",
  HEAD_POLL_SECONDS: "0",
  UPDATE_BRANCH_DIR: runnerDir,
  BUNDLE_DIR: bundleDir,
  ...over,
});
const CONFLICTS = (over: Partial<Inputs> = {}): Inputs => INPUTS({ STATUS: "conflicts", AGENT_RESULT: "success", ...over });

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const merger: GitMerger = {
    merge: async (options) => {
      merges.push(options);
      if (merged instanceof Error) throw merged;
      return merged;
    },
  };
  const fetcher: GitFetcher = {
    fetchRef: async (ref, into) => {
      fetches.push(`${ref} ${into}`);
      if (fetched instanceof Error) throw fetched;
      return fetched;
    },
  };
  const io: MergingCheckoutIo<(typeof COMMANDS)["update-branch:publish"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: reader,
    git: git.git,
    fetcher,
    merger,
    outputs: {
      writeJson: (name, value) => files.set(name, structuredClone(value)),
      writeText: (name, value) => files.set(name, value),
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

const writes = () => (made?.writes ?? []).map((w) => `${w.token} ${w.type}`);
const commentBodies = () => github.comments.map((c) => c.body);
const logged = () => log.mock.calls.map((call) => String(call[0]));
const warnings = () => logged().filter((line) => line.startsWith("::warning::"));
const labels = () => github.pullRequests.get(PR)?.labels ?? [];

describe("update-branch:publish on a branch already up to date", () => {
  it("writes only the comment, and pushes nothing", async () => {
    await run(INPUTS({ STATUS: "uptodate" }));

    expect(writes()).toEqual(["workflow comment"]);
    expect(commentBodies()).toEqual([`\`${UPDATE_BRANCH_LABEL}\`: already up to date with \`main\`, so no merge was needed.`]);
    expect(merges).toEqual([]);
    expect(fetches).toEqual([]);
    expect(git.calls).toEqual([]);
    expect(github.branches.get(BRANCH)).toBe(HEAD);
    expect(files.get("published.json")).toEqual({ pushed: false, requested: false });
  });
});

describe("update-branch:publish on a clean merge", () => {
  it("makes the merge again, of the base commit the gate merged, pushes it, carries the verdict over, then comments", async () => {
    github.statuses.set(HEAD, [status()]);

    await run();

    expect(merges).toEqual([{ base: "main", into: BRANCH, identity: LOOP_COMMITTER, commit: BASE }]);
    expect(writes()).toEqual(["loop pushRef", "workflow setCommitStatus", "workflow comment"]);
    expect(made?.writes[0]?.args).toEqual([{ ref: `refs/heads/${BRANCH}`, commit: MERGE, lease: { tip: HEAD } }]);
    expect(github.branches.get(BRANCH)).toBe(MERGE);
    expect(commentBodies()).toEqual([`\`${UPDATE_BRANCH_LABEL}\`: merged \`main\` (\`bbbbbbb\`) cleanly, with no conflicts.`]);
    expect(files.get("published.json")).toEqual({ pushed: true, head: MERGE, requested: false });
    expect(labels()).toEqual([UPDATE_BRANCH_LABEL]);
  });

  /**
   * Copied, never parsed: the state, the line a human acts on and the link
   * are the review's own words. And posted with the workflow token, the
   * account the next round reads a verdict as the loop's by.
   */
  it("copies the verdict's state, description and link as they are, with the workflow token", async () => {
    github.statuses.set(HEAD, [status({ state: "failure", description: "Changes recommended. Some of it.", targetUrl: REVIEW_URL })]);

    await run();

    expect(made?.writes.find((w) => w.type === "setCommitStatus")).toEqual({
      token: "workflow",
      type: "setCommitStatus",
      args: [{ sha: MERGE, context: VERDICT_CONTEXT, state: "failure", description: "Changes recommended. Some of it.", targetUrl: REVIEW_URL }],
    });
    expect(github.statuses.get(MERGE)).toEqual([
      { context: VERDICT_CONTEXT, state: "failure", targetUrl: REVIEW_URL, description: "Changes recommended. Some of it.", creator: "workflow" },
    ]);
  });

  /** An `error` too: "the last review produced no verdict" stays true of a merge. A verdict with no link is copied with none. */
  it("copies an error verdict, and one with no link without one", async () => {
    github.statuses.set(HEAD, [status({ state: "error", targetUrl: null, description: "" })]);

    await run();

    expect(made?.writes.find((w) => w.type === "setCommitStatus")?.args).toEqual([
      { sha: MERGE, context: VERDICT_CONTEXT, state: "error", description: "" },
    ]);
  });

  /**
   * The hard-to-see failure: a status is a thing any token holding
   * `statuses: write` can post under any context, so a selector without the
   * creator would launder an outside integration's approval on to the merge.
   */
  it("never copies an outside integration's status under the same context, newest or not", async () => {
    github.statuses.set(HEAD, [
      status({ creator: "deploy-bot[bot]", state: "success", description: "Looks great", targetUrl: "https://elsewhere.invalid" }),
      status({ state: "failure", description: "Changes recommended." }),
      status({ creator: "someone", state: "success" }),
    ]);

    await run();

    expect(made?.writes.find((w) => w.type === "setCommitStatus")?.args).toEqual([
      { sha: MERGE, context: VERDICT_CONTEXT, state: "failure", description: "Changes recommended.", targetUrl: REVIEW_URL },
    ]);
  });

  it("copies nothing where only an outside integration posted one, and says there is nothing of ours", async () => {
    github.statuses.set(HEAD, [status({ creator: "deploy-bot[bot]" }), status({ context: "ci", state: "success" })]);

    await run();

    expect(writes()).toEqual(["loop pushRef", "workflow comment"]);
    expect(logged()).toContain(`No ${VERDICT_CONTEXT} verdict of ours on ${HEAD}, so there is nothing to carry over.`);
    expect(warnings()).toEqual([]);
  });

  /** On the service the verdicts are posted as its App, which `AGENT_LOOP_LOGINS` names. */
  it("recognises a verdict posted by an account AGENT_LOOP_LOGINS names", async () => {
    github.statuses.set(HEAD, [status({ creator: "my-loop[bot]", state: "failure" })]);

    await run(INPUTS({ AGENT_LOOP_LOGINS: "my-loop" }));

    expect(made?.writes.find((w) => w.type === "setCommitStatus")?.args[0]).toMatchObject({ state: "failure" });
  });

  /**
   * A read that failed is not a commit with no verdict on it (#105): a
   * warning of its own, naming what the cause is not and the label that
   * recovers it, and the run goes on, since the merge is pushed.
   */
  it("warns where the statuses could not be read, which is not the same as none, and goes on", async () => {
    reader = {
      ...reader,
      commitStatuses: async () => {
        throw new GitHubError("statuses: 502 Bad Gateway", 502);
      },
    };

    await run();

    expect(writes()).toEqual(["loop pushRef", "workflow comment"]);
    expect(warnings()).toEqual([expect.stringContaining(`Could not read the statuses on ${HEAD}`)]);
    const [warning = ""] = warnings();
    expect(warning).toContain("could not tell whether there was one");
    expect(warning).toContain("before any job starts");
    expect(warning).toMatch(/transient/);
    expect(warning).toContain(REVIEW_LABEL);
    expect(warning).toContain("502 Bad Gateway");
    expect(logged().join("\n")).not.toContain("nothing to carry over");
  });

  it("warns where the copy is refused, naming agent:review, and goes on", async () => {
    github.statuses.set(HEAD, [status()]);
    github.fails = (write) => write.type === "setCommitStatus";

    await run();

    expect(writes()).toEqual(["loop pushRef", "workflow setCommitStatus", "workflow comment"]);
    expect(warnings()).toEqual([expect.stringContaining(`Could not carry the \`${VERDICT_CONTEXT}\` verdict from ${HEAD} on to ${MERGE}.`)]);
    const [warning = ""] = warnings();
    expect(warning).toContain("a 422 is the status itself being refused");
    expect(warning).toMatch(/re-running this workflow recovers none of it/i);
    expect(warning).toContain(REVIEW_LABEL);
    expect(warning).not.toMatch(/transient/);
    expect(files.get("published.json")).toEqual({ pushed: true, head: MERGE, requested: false });
  });

  it.each([
    ["the merge no longer goes cleanly", { status: "conflicts", base: BASE, conflicts: ["a.txt"] } as Merged, /Merging `main` again didn't go cleanly, though it did a moment before, so the branch was left untouched\./],
    ["the base no longer holds the gate's commit", new BaseMoved("moved"), /^`main` no longer holds the commit this run set out to merge, so the branch was left untouched\.$/],
    ["the base cannot be fetched", new FetchFailed("couldn't find remote ref refs/heads/main"), /^Couldn't fetch `main` to merge it, so the branch was left untouched: couldn't find remote ref/],
  ])("refuses where %s, before its first write", async (_, outcome, says) => {
    merged = outcome;

    await expect(run()).rejects.toThrow(says);
    expect(made).toBeUndefined();
    expect(github.branches.get(BRANCH)).toBe(HEAD);
    expect(files.get("published.json")).toEqual({ pushed: false, requested: false });
  });
});

/**
 * The arm's carry (#589, ADR 0009): a clean refresh adds only the base's code
 * to the commit the maintainer armed, so the arm the loop token's account
 * posted on the old head is copied on to the merge commit, with the loop's
 * token, its refresh count one higher and the human and the time kept.
 */
describe("update-branch:publish carries the arm on a clean merge", () => {
  const arm = (over: Partial<CommitStatus> = {}): CommitStatus => ({
    context: MERGE_CONTEXT,
    state: "success",
    targetUrl: null,
    description: armDescription({ login: "alice", at: ARMED_AT, refreshes: 1 }),
    creator: ARM_ACCOUNT,
    ...over,
  });
  const carried = () => (github.statuses.get(MERGE) ?? []).filter((s) => s.context === MERGE_CONTEXT);

  it("copies the arm with the loop's token, its count one higher and the human and the time kept, beside the verdict", async () => {
    github.statuses.set(HEAD, [arm(), status()]);

    await run();

    expect(writes()).toEqual(["loop pushRef", "workflow setCommitStatus", "loop setCommitStatus", "workflow comment"]);
    expect(carried()).toEqual([
      { context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription({ login: "alice", at: ARMED_AT, refreshes: 2 }), creator: ARM_ACCOUNT },
    ]);
    expect(readArmDescription(carried()[0]?.description ?? "")).toEqual({ login: "alice", at: ARMED_AT, refreshes: 2 });
  });

  it("reads an arm #588 wrote, naming the human alone, as count 0 made at its status's own time", async () => {
    github.statuses.set(HEAD, [arm({ description: "Armed by @alice to merge this commit.", createdAt: "2026-10-31T12:00:00Z" })]);

    await run();

    expect(readArmDescription(carried()[0]?.description ?? "")).toEqual({ login: "alice", at: "2026-10-31T12:00:00Z", refreshes: 1 });
  });

  it("copies only the newest arm of the loop token's account, never one github-actions[bot] or anyone else posted", async () => {
    github.statuses.set(HEAD, [
      arm({ creator: "github-actions[bot]", description: armDescription({ login: "mallory", at: ARMED_AT, refreshes: 0 }) }),
      arm({ creator: "mallory", description: armDescription({ login: "mallory", at: ARMED_AT, refreshes: 0 }) }),
      arm(),
      arm({ description: armDescription({ login: "alice", at: ARMED_AT, refreshes: 0 }) }),
    ]);

    await run();

    expect(carried().map((s) => readArmDescription(s.description))).toEqual([{ login: "alice", at: ARMED_AT, refreshes: 2 }]);
  });

  it("copies nothing where no arm of the loop's stands, or the newest is not success", async () => {
    github.statuses.set(HEAD, [arm({ creator: "github-actions[bot]" }), status()]);
    await run();
    expect(carried()).toEqual([]);
    expect(writes()).not.toContain("loop setCommitStatus");

    github.statuses.set(HEAD, [arm({ state: "failure" }), arm()]);
    await run();
    expect(carried()).toEqual([]);
  });

  it("copies nothing with the workflow token alone, and says so", async () => {
    github.statuses.set(HEAD, [arm()]);

    await run(INPUTS({ LOOP_TOKEN_SOURCE: "workflow" }));

    expect(carried()).toEqual([]);
    expect(warnings()).toEqual([expect.stringContaining(`the \`${MERGE_CONTEXT}\` arm was not carried on to ${MERGE}`)]);
  });

  it("copies nothing where no LOOP_LOGIN says whose an arm is, and says so", async () => {
    github.statuses.set(HEAD, [arm()]);

    await run(INPUTS({ LOOP_LOGIN: "" }));

    expect(carried()).toEqual([]);
    expect(logged().join("\n")).toContain("No `LOOP_LOGIN` was given");
  });

  it("warns where the copy is refused, and goes on", async () => {
    github.statuses.set(HEAD, [arm()]);
    github.fails = (write) => write.type === "setCommitStatus" && write.token === "loop";

    await run();

    expect(warnings()).toEqual([expect.stringContaining(`Could not carry the \`${MERGE_CONTEXT}\` arm from ${HEAD} on to ${MERGE}.`)]);
    expect(files.get("published.json")).toEqual({ pushed: true, head: MERGE, requested: false });
  });

  it("carries no arm on to a resolution, nor on an up-to-date branch", async () => {
    github.statuses.set(HEAD, [arm()]);
    bundle();
    await run(CONFLICTS());
    expect(carried()).toEqual([]);

    await run(INPUTS({ STATUS: "uptodate" }));
    expect(carried()).toEqual([]);
    expect(github.statuses.get(HEAD)?.filter((s) => s.context === MERGE_CONTEXT)).toHaveLength(1);
  });
});

describe("update-branch:publish on a resolution", () => {
  it("pushes the resolution, comments with the runner's words, then asks for its review, with the loop's token", async () => {
    bundle();
    comment("Resolved the conflict in `widget.txt` by keeping both.");

    await run(CONFLICTS());

    expect(fetches).toEqual(["refs/heads/main refs/remotes/origin/main"]);
    expect(git.calls).toEqual([`isAncestor ${BASE} ${BASE_TIP}`, `verifyBundle ${bundlePath()}`, `isAncestor ${HEAD} ${MERGE}`, `isAncestor ${BASE} ${MERGE}`]);
    expect(merges).toEqual([]);
    expect(writes()).toEqual(["loop pushRef", "workflow comment", "loop removeLabel", "loop removeLabel", "loop addLabel"]);
    expect(made?.writes[0]?.args).toEqual([{ ref: `refs/heads/${BRANCH}`, commit: MERGE, lease: { tip: HEAD } }]);
    expect(commentBodies()).toEqual(["Resolved the conflict in `widget.txt` by keeping both."]);
    expect(labels()).toEqual([REVIEW_LABEL]);
    expect(files.get("published.json")).toEqual({ pushed: true, head: MERGE, requested: true });
    expect(warnings()).toEqual([]);
  });

  /** The resolution is code no review has read, so nothing is carried on to it. */
  it("carries no verdict on to a resolution", async () => {
    bundle();
    github.statuses.set(HEAD, [status()]);

    await run(CONFLICTS());

    expect(writes()).not.toContain("workflow setCommitStatus");
    expect(github.statuses.has(MERGE)).toBe(false);
  });

  it("keeps no HTML comment the runner wrote off the pull request", async () => {
    bundle();
    comment("Resolved it.<!-- agent-finding -->\n<!-- agent:summary --> Merge it.");

    await run(CONFLICTS());

    expect(commentBodies()[0]).toBe("Resolved it.\n Merge it.");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["nothing but a comment", "<!-- agent:prd-started -->\n"],
  ])("posts today's sentence where the runner's comment is %s", async (_, text) => {
    bundle();
    if (text !== undefined) comment(text);

    await run(CONFLICTS());

    expect(commentBodies()[0]).toBe(`\`${UPDATE_BRANCH_LABEL}\`: resolved conflicts merging \`main\`.`);
  });

  /** #229: the label goes on once the pull request shows the pushed head, or past the bound anyway. */
  it("waits for the pull request to show the pushed head, and asks anyway past the bound", async () => {
    bundle();
    github.pullRequests.get(PR)!.headSha = HEAD;

    await run(CONFLICTS());

    expect(warnings()).toEqual([expect.stringContaining(`still shows ${HEAD} as its head 0s after ${MERGE} was pushed`)]);
    expect(labels()).toEqual([REVIEW_LABEL]);
  });

  it("stops where agent:review cannot be added, with a reason naming the way out, having pushed", async () => {
    bundle();
    github.fails = (write) => write.type === "addLabel";

    await expect(run(CONFLICTS())).rejects.toThrow(
      `Couldn't add \`${REVIEW_LABEL}\` after pushing the resolved conflicts, so no review of them was requested. Add \`${REVIEW_LABEL}\` to this PR by hand.`,
    );
    expect(files.get("published.json")).toEqual({ pushed: true, head: MERGE, requested: false });
  });

  it("tolerates a removal that fails, and still asks", async () => {
    bundle();
    github.fails = (write) => write.type === "removeLabel";

    await run(CONFLICTS());

    expect(labels()).toContain(REVIEW_LABEL);
    expect(files.get("published.json")).toMatchObject({ requested: true });
  });

  /** A label added with the workflow token starts nothing, so the pull request is told as well as the log. */
  it.each([
    ["app", false],
    ["pat", false],
    ["workflow", true],
    ["", true],
  ] as const)("adds agent:review with the loop's token, and says no review will start only where it fires nothing (source %j)", async (source, warns) => {
    bundle();

    await run(CONFLICTS({ LOOP_TOKEN_SOURCE: source }));

    expect(made?.writes.filter((w) => w.type === "addLabel")).toEqual([{ token: "loop", type: "addLabel", args: [PR, REVIEW_LABEL] }]);
    expect(files.get("published.json")).toMatchObject({ requested: true });
    if (warns) {
      expect(writes().at(-1)).toBe("workflow comment");
      expect(commentBodies().at(-1)).toContain("no review of the resolution will start on its own");
      expect(warnings()).toEqual([expect.stringContaining("will NOT trigger agent-review")]);
    } else {
      expect(writes().at(-1)).toBe("loop addLabel");
      expect(warnings()).toEqual([]);
    }
  });

  it.each(["failure", "cancelled"] as const)("does nothing where the agent's job ended %s", async (result) => {
    bundle();

    await run(CONFLICTS({ AGENT_RESULT: result }));

    expect(made).toBeUndefined();
    expect(git.calls).toEqual([]);
    expect(files.get("published.json")).toEqual({ pushed: false, requested: false });
  });
});

/**
 * What is pushed is never the agent's job's word alone: each check refuses
 * with a sentence of its own, for the failure comment, before the first
 * write, and leaves the branch where it was.
 */
describe("update-branch:publish refuses a resolution it cannot trust, before its first write", () => {
  const refused = async (says: RegExp | string): Promise<void> => {
    await expect(run(CONFLICTS())).rejects.toThrow(says);
    expect(made).toBeUndefined();
    expect(github.branches.get(BRANCH)).toBe(HEAD);
    expect(files.get("published.json")).toEqual({ pushed: false, requested: false });
  };

  it("refuses where the agent's job handed nothing over", async () => {
    await refused("The agent's job finished without handing over its resolution, so the branch was left untouched.");
  });

  it("refuses a damaged bundle", async () => {
    bundle();
    git = fakeGit({ bundles: {}, history: { [BASE_TIP]: [BASE, BASE_TIP] } });

    await refused("The agent's commits arrived damaged or incomplete, so nothing was pushed.");
  });

  it.each([
    ["of another branch", [{ ref: "refs/heads/other", commit: MERGE }]],
    [
      "beside another",
      [
        { ref: `refs/heads/${BRANCH}`, commit: MERGE },
        { ref: "refs/heads/other", commit: MERGE },
      ],
    ],
  ])("refuses a bundle %s", async (_, heads) => {
    bundle();
    git = holding(undefined, heads);

    await refused(/on a branch other than `agent\/issue-12-do-the-thing`, or beside other branches, so nothing was pushed\./);
  });

  it("refuses a resolution not built on the head the run started from", async () => {
    bundle();
    git = holding({ [BASE_TIP]: [BASE, BASE_TIP], [MERGE]: [BASE, MERGE] });

    await refused("The agent's commits don't build on the PR's head as this run found it, so nothing was pushed.");
  });

  it("refuses a resolution that does not take the base in", async () => {
    bundle();
    git = holding({ [BASE_TIP]: [BASE, BASE_TIP], [MERGE]: [HEAD, MERGE] });

    await refused("The agent's resolution isn't a merge of `main` into the PR's head as this run found them, so the branch was left untouched.");
  });

  it.each([
    ["no longer reaches the gate's commit", { [BASE_TIP]: [BASE_TIP] }],
    ["has lost the gate's commit altogether", {}],
  ])("refuses where the base %s", async (_, history) => {
    bundle();
    git = holding({ ...history, [MERGE]: [HEAD, BASE, MERGE] });

    await refused("`main` no longer holds the commit this run set out to merge, so the branch was left untouched.");
  });

  it("refuses where the base cannot be fetched", async () => {
    bundle();
    fetched = new GitError("fatal: couldn't find remote ref refs/heads/main");

    await refused(/^Couldn't fetch `main` to merge it, so the branch was left untouched: fatal: couldn't find remote ref/);
  });
});

describe("update-branch:publish pushes under a lease", () => {
  it.each([
    ["the merge", () => INPUTS()],
    ["the agent's resolution", () => CONFLICTS()],
  ])("stops on a lost lease pushing %s, saying the branch moved, and writes nothing more", async (what, inputs) => {
    bundle();
    github.branches.set(BRANCH, "e".repeat(40));

    await expect(run(inputs())).rejects.toThrow(`\`${BRANCH}\` moved while this run worked, so ${what} was not pushed over what is there now.`);
    expect(writes()).toEqual(["loop pushRef"]);
    expect(github.branches.get(BRANCH)).toBe("e".repeat(40));
    expect(files.get("published.json")).toEqual({ pushed: false, requested: false });
  });

  it("stops where the comment cannot be posted, having pushed", async () => {
    github.fails = (write) => write.type === "comment";

    await expect(run()).rejects.toThrow(`Couldn't comment on PR #${PR} to say what this run did.`);
    expect(files.get("published.json")).toEqual({ pushed: true, head: MERGE, requested: false });
  });

  it("asks for the writes it can make and no more", async () => {
    await run();

    expect(asked).toEqual({ pushRef: 1, setCommitStatus: 2, comment: 2, removeLabel: 2, addLabel: 1 });
  });
});
