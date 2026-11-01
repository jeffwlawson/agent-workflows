import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitCheck } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import { gate, MAX_REFRESHES } from "../../merge/gate.js";
import { CI_WAIT_SECONDS, POLL_SECONDS } from "../../review/collect-checks.js";
import type { LoopReadingIo, Token } from "../../shared/command-io.js";
import { COMMANDS } from "../../shared/contract.js";
import {
  armDescription,
  BLOCKED_LABEL,
  FIX_LABEL,
  MERGE_CONTEXT,
  MERGE_LABEL,
  mergeBehindMark,
  mergeRedMark,
  readArmDescription,
  REVIEW_LABEL,
  UPDATE_BRANCH_LABEL,
  VERDICT_CONTEXT,
} from "../../shared/record.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `merge:gate` (#588), called the way the CLI calls it: its declared inputs,
 * the fake reader twice (the workflow token's and the loop token's), and the
 * engine's writers over a fake GitHub. What is asserted is the record: the
 * writes in order and their tokens, what was read with which token, and the
 * decision handed on in `gate.json`. A decision table, row by row.
 *
 * The fake posts a status as the token's name, so the loop token's account is
 * `loop` here and the workflow token's `workflow`; `github-actions[bot]` is
 * how a forged arm from a pull request's branch reads.
 */

const PR = 7;
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const LOOP = "loop";
/** An arm's description as the gate writes it, at no refresh yet. */
const ARMED = armDescription({ login: "alice", at: "2026-11-01T03:59:35Z", refreshes: 0 });

let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let reads: ReturnType<typeof fakeReader>;
let loopReads: ReturnType<typeof fakeReader>;
let decided: unknown;
let logged: string[];

const check = (name: string, conclusion: string | null, required = true): CommitCheck => ({
  kind: "checkRun",
  name,
  status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
  conclusion,
  required,
});

const verdict = (state: string, creator = "github-actions[bot]") => ({
  context: VERDICT_CONTEXT,
  state,
  targetUrl: null,
  description: "",
  creator,
});

beforeEach(() => {
  github = fakeGitHub([{ number: PR, headSha: HEAD, baseRef: "main", labels: [MERGE_LABEL], title: "Do the thing" }]);
  github.permissions.set("alice", "write");
  github.comparisons.set(`main...${HEAD}`, "ahead");
  github.checks.set(HEAD, [check("CI / verify", "SUCCESS")]);
  github.statuses.set(HEAD, [verdict("success")]);
  made = undefined;
  asked = undefined;
  reads = fakeReader(github);
  loopReads = fakeReader(github);
  decided = undefined;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Inputs = Parameters<typeof gate>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "app",
  AGENT_LOOP_LOGINS: "",
  LOOP_LOGIN: LOOP,
  PR_NUMBER: String(PR),
  BASE_REF: "main",
  ACTION: "labeled",
  SENDER: "alice",
  HEAD_SHA: HEAD,
  HEAD_REPO: "o/r",
  PR_STATE: "open",
  PR_MERGED: "false",
  PR_DRAFT: "false",
  CHECK_WAIT_SECONDS: "0",
  CHECK_POLL_SECONDS: "0",
  ...over,
});

const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: LoopReadingIo<(typeof COMMANDS)["merge:gate"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: reads.reader,
    loopGithub: loopReads.reader,
    outputs: {
      writeJson: (name, value) => {
        expect(name).toBe("gate.json");
        decided = JSON.parse(JSON.stringify(value));
      },
      writeText: () => {},
      writeBytes: () => {},
      appendLine: () => {},
    },
  };
  await gate(inputs, io);
};

const writes = () => (made?.writes ?? []).map((w) => `${w.token} ${w.type}`);
const comments = () => github.comments.map((c) => c.body);
const labels = () => github.pullRequests.get(PR)?.labels ?? [];
const arms = (sha = HEAD) => (github.statuses.get(sha) ?? []).filter((s) => s.context === MERGE_CONTEXT);

describe("merge:gate refuses", () => {
  it.each([
    ["a closed pull request", { PR_STATE: "closed" }, "This PR is closed."],
    ["a merged one", { PR_MERGED: "true" }, "This PR is closed."],
    ["a draft", { PR_DRAFT: "true" }, "This PR is a draft."],
    ["a fork", { HEAD_REPO: "stranger/r" }, "This PR is from a fork"],
    ["the workflow token alone, naming the App and AGENT_PAT", { LOOP_TOKEN_SOURCE: "workflow" }, "Neither the loop's App nor `AGENT_PAT` is set"],
  ] as const)("%s, with a comment, the label off, and nothing armed or merged", async (_name, over, sentence) => {
    await run(INPUTS(over));

    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toMatch(new RegExp(`^\\*\\*\`${MERGE_LABEL}\` didn't run:\\*\\* `));
    expect(comments()[0]).toContain(sentence);
    expect(labels()).not.toContain(MERGE_LABEL);
    expect(writes()).toEqual(["workflow comment", "workflow removeLabel"]);
    expect(arms()).toEqual([]);
    expect(decided).toEqual({ decision: "refused" });
  });

  it.each(["triage", "read", "none", "unknown"] as const)("a labeller whose permission is %s, read with the loop's token", async (permission) => {
    github.permissions.set("mallory", permission);
    await run(INPUTS({ SENDER: "mallory" }));

    expect(loopReads.reads).toContainEqual({ method: "permission", args: ["mallory"] });
    expect(reads.reads.some((r) => r.method === "permission")).toBe(false);
    expect(comments()[0]).toContain("@mallory added it");
    expect(labels()).not.toContain(MERGE_LABEL);
    expect(arms()).toEqual([]);
    expect(decided).toEqual({ decision: "refused" });
  });

  it("stops, writing nothing, where the labeller's permission cannot be read", async () => {
    await expect(run(INPUTS({ SENDER: "ghost" }))).rejects.toThrow("permission of ghost");
    expect(writes()).toEqual([]);
    expect(labels()).toContain(MERGE_LABEL);
  });
});

describe("merge:gate arms", () => {
  it("arms a writer's head with the loop's token, naming them, and merges a current, green, approved head", async () => {
    await run();

    expect(arms()).toEqual([{ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: expect.any(String), creator: LOOP }]);
    // From #589 it says when, and the count of clean refreshes, 0 when armed.
    expect(readArmDescription(arms()[0]?.description ?? "")).toEqual({ login: "alice", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/), refreshes: 0 });
    expect(writes()).toEqual(["loop setCommitStatus"]);
    expect(comments()).toEqual([]);
    expect(labels()).toContain(MERGE_LABEL);
    expect(decided).toEqual({ decision: "merge", head: HEAD });
    expect(asked).toEqual({ comment: 1, removeLabel: 1, addLabel: 1, setCommitStatus: 1 });
  });

  it.each(["admin", "maintain"] as const)("takes %s as able to write", async (permission) => {
    github.permissions.set("alice", permission);
    await run();

    expect(decided).toEqual({ decision: "merge", head: HEAD });
  });

  it("disarms rather than arming where the live head already moved past the labelled one", async () => {
    github.pullRequests.get(PR)!.headSha = MOVED;
    await run();

    expect(arms()).toEqual([]);
    expect(arms(MOVED)).toEqual([]);
    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toContain(`@alice armed \`${HEAD}\`, but the head of this PR is now \`${MOVED}\``);
    expect(comments()[0]).toContain(`run \`/merge-check\` on \`${MOVED}\` and add \`${MERGE_LABEL}\` again`);
    expect(labels()).not.toContain(MERGE_LABEL);
    expect(decided).toEqual({ decision: "disarmed", head: MOVED });
  });

  it("stops, naming the grant, where GitHub refuses the arm", async () => {
    github.fails = (write) => write.type === "setCommitStatus";

    await expect(run()).rejects.toThrow("Commit statuses: write");
    expect(decided).toEqual({});
  });
});

describe("merge:gate on a label the loop's own account added", () => {
  it("never arms, and disarms a head with no arm", async () => {
    await run(INPUTS({ SENDER: LOOP }));

    expect(loopReads.reads.some((r) => r.method === "permission")).toBe(false);
    expect(arms()).toEqual([]);
    expect(comments()[0]).toContain(`No one armed \`${HEAD}\``);
    // A maintainer whose own account is the loop's, through `AGENT_PAT`, is told why their label did nothing.
    expect(comments()[0]).toContain(`It was added as @${LOOP}, the account the loop writes as, and a label the loop adds never arms.`);
    expect(labels()).not.toContain(MERGE_LABEL);
    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
  });

  it("merges a head the loop's account armed", async () => {
    github.statuses.get(HEAD)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: ARMED, creator: LOOP });
    await run(INPUTS({ SENDER: "LOOP" }));

    expect(writes()).toEqual([]);
    expect(decided).toEqual({ decision: "merge", head: HEAD });
  });
});

describe("merge:gate reads an arm only off the loop token's account", () => {
  it.each(["github-actions[bot]", "workflow", "alice"])("an agent-merge status by %s is no arm", async (creator) => {
    github.statuses.get(HEAD)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: ARMED, creator });
    await run(INPUTS({ SENDER: LOOP }));

    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
    expect(labels()).not.toContain(MERGE_LABEL);
  });

  it("reads none at all where the loop token's account is github-actions[bot]", async () => {
    github.statuses.get(HEAD)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: ARMED, creator: "github-actions[bot]" });
    await run(INPUTS({ SENDER: "github-actions[bot]", LOOP_LOGIN: "github-actions[bot]" }));

    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
  });

  it("names the human who armed the labelled head, where the head moved past it since", async () => {
    github.statuses.get(HEAD)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: ARMED, creator: LOOP });
    github.pullRequests.get(PR)!.headSha = MOVED;
    await run(INPUTS({ SENDER: LOOP }));

    expect(comments()[0]).toContain(`@alice armed \`${HEAD}\`, but the head of this PR is now \`${MOVED}\``);
    expect(decided).toEqual({ decision: "disarmed", head: MOVED });
  });
});

describe("merge:gate waits", () => {
  it.each([REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL])("while %s is on, and ends armed", async (label) => {
    github.pullRequests.get(PR)!.labels.push(label);
    await run();

    expect(decided).toEqual({ decision: "wait", head: HEAD });
    expect(labels()).toContain(MERGE_LABEL);
    expect(arms()).toHaveLength(1);
    expect(comments()).toEqual([]);
  });

  it("while a required check is pending", async () => {
    github.checks.set(HEAD, [check("CI / verify", null)]);
    await run();

    expect(decided).toEqual({ decision: "wait", head: HEAD });
    expect(logged.join("\n")).toContain("`CI / verify`");
  });

  it("while no verdict, or a pending one, stands", async () => {
    github.statuses.set(HEAD, []);
    await run();
    expect(decided).toEqual({ decision: "wait", head: HEAD });

    github.statuses.set(HEAD, [verdict("pending")]);
    await run();
    expect(decided).toEqual({ decision: "wait", head: HEAD });
  });

  it("does not take a verdict posted by anyone but the loop's accounts", async () => {
    github.statuses.set(HEAD, [verdict("success", "mallory")]);
    await run();

    expect(decided).toEqual({ decision: "wait", head: HEAD });
  });

  it("polls until it goes green inside the bound, then merges", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const pending = [check("CI / verify", null)];
      github.checks.set(HEAD, pending);
      const read = reads.reader.commitChecks;
      reads.reader.commitChecks = async (sha, n) => {
        polls += 1;
        if (polls === 3) github.checks.set(HEAD, [check("CI / verify", "SUCCESS")]);
        return read(sha, n);
      };
      const done = run(INPUTS({ CHECK_WAIT_SECONDS: "60", CHECK_POLL_SECONDS: "5" }));
      await vi.runAllTimersAsync();
      await done;

      expect(polls).toBe(3);
      expect(decided).toEqual({ decision: "merge", head: HEAD });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing where whether it is behind could not be told, and waits", async () => {
    github.comparisons.set(`main...${HEAD}`, "mystery");
    await run();

    expect(decided).toEqual({ decision: "wait", head: HEAD });
    expect(comments()).toEqual([]);
  });

  it("waits on the review's CI wait by default", () => {
    const inputs = COMMANDS["merge:gate"].inputs;

    expect(inputs.CHECK_WAIT_SECONDS.default).toBe(String(CI_WAIT_SECONDS));
    expect(inputs.CHECK_POLL_SECONDS.default).toBe(String(POLL_SECONDS));
  });
});

/** An arm the loop token's account posted on `sha`, after `refreshes` clean refreshes. */
const armed = (sha: string, refreshes = 0, login = "alice"): void => {
  const statuses = github.statuses.get(sha) ?? [];
  statuses.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription({ login, at: "2026-11-01T03:59:35Z", refreshes }), creator: LOOP });
  github.statuses.set(sha, statuses);
};

describe("merge:gate on a behind head", () => {
  it("asks for agent:update-branch with the loop's token, removing it first, says so once per head, and keeps the arm", async () => {
    github.comparisons.set(`main...${HEAD}`, "diverged");
    await run();

    expect(decided).toEqual({ decision: "behind", head: HEAD });
    expect(writes()).toEqual(["loop setCommitStatus", "workflow comment", "loop removeLabel", "loop addLabel"]);
    expect(made?.writes.slice(2).map((w) => w.args)).toEqual([[PR, UPDATE_BRANCH_LABEL], [PR, UPDATE_BRANCH_LABEL]]);
    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toContain(`\`${HEAD}\` is behind \`main\``);
    expect(comments()[0]).toContain(`\`${UPDATE_BRANCH_LABEL}\` was asked for`);
    expect(comments()[0]).toContain(mergeBehindMark(HEAD));
    expect(labels()).toEqual([MERGE_LABEL, UPDATE_BRANCH_LABEL]);

    // The refresh it asked for is on: the next gate waits on it, and says nothing.
    await run(INPUTS({ SENDER: LOOP }));
    expect(decided).toEqual({ decision: "wait", head: HEAD });
    expect(comments()).toHaveLength(1);
  });

  it("says nothing twice of one head, and asks again", async () => {
    github.comparisons.set(`main...${HEAD}`, "diverged");
    await run();
    github.pullRequests.get(PR)!.labels = [MERGE_LABEL];
    await run(INPUTS({ SENDER: LOOP }));

    expect(comments()).toHaveLength(1);
    expect(writes()).toEqual(["loop removeLabel", "loop addLabel"]);
    expect(labels()).toContain(UPDATE_BRANCH_LABEL);
  });

  it.each([REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL])("adds no agent:update-branch while %s is on, and waits", async (label) => {
    github.comparisons.set(`main...${HEAD}`, "diverged");
    armed(HEAD);
    github.pullRequests.get(PR)!.labels.push(label);
    await run(INPUTS({ SENDER: LOOP }));

    expect(decided).toEqual({ decision: "wait", head: HEAD });
    expect(writes()).toEqual([]);
  });

  it("stops, naming the way on, where agent:update-branch cannot be added", async () => {
    github.comparisons.set(`main...${HEAD}`, "diverged");
    github.fails = (write) => write.type === "addLabel";

    await expect(run()).rejects.toThrow(`adding \`${UPDATE_BRANCH_LABEL}\` to refresh it failed`);
  });
});

/**
 * The refresh cap (#589): an arm survives at most `MAX_REFRESHES` clean
 * refreshes, so a base that keeps moving cannot hold a pull request in an
 * endless behind, refresh, behind loop.
 */
describe("merge:gate caps the clean refreshes an arm survives", () => {
  it("is three", () => {
    expect(MAX_REFRESHES).toBe(3);
  });

  it("asks for agent:update-branch on an arm with two refreshes and a behind head", async () => {
    github.comparisons.set(`main...${HEAD}`, "diverged");
    armed(HEAD, 2);
    await run(INPUTS({ SENDER: LOOP }));

    expect(decided).toEqual({ decision: "behind", head: HEAD });
    expect(labels()).toEqual([MERGE_LABEL, UPDATE_BRANCH_LABEL]);
  });

  it("disarms an arm with three, naming the human and why, asking for no fourth refresh and no fresh merge-check", async () => {
    github.comparisons.set(`main...${HEAD}`, "diverged");
    armed(HEAD, 3);
    await run(INPUTS({ SENDER: LOOP }));

    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
    expect(writes()).toEqual(["workflow comment", "workflow removeLabel"]);
    expect(labels()).toEqual([]);
    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toMatch(new RegExp(`^\\*\\*\`${MERGE_LABEL}\` disarmed:\\*\\* @alice armed this PR`));
    expect(comments()[0]).toContain("moved past it 3 times while it waited");
    expect(comments()[0]).toContain(`adding \`${MERGE_LABEL}\` again re-arms it`);
    expect(comments()[0]).not.toContain("/merge-check");
  });

  it("does not count refreshes on a head that is current", async () => {
    armed(HEAD, 3);
    await run(INPUTS({ SENDER: LOOP }));

    expect(decided).toEqual({ decision: "merge", head: HEAD });
  });

  it("starts a human's re-add at count 0", async () => {
    armed(HEAD, 3);
    await run();

    expect(readArmDescription(arms()[0]?.description ?? "")?.refreshes).toBe(0);
  });
});

/**
 * The hand-back (#589): a refresh's own push starts a gate before its carry
 * of the arm may have landed, so a head with no arm while
 * `agent:update-branch` is on waits, and the refresh's conclusion re-adds
 * `agent:merge`, which rules then.
 */
describe("merge:gate on an unarmed head while a refresh works", () => {
  it("waits, and neither disarms nor removes a label", async () => {
    github.pullRequests.get(PR)!.labels.push(UPDATE_BRANCH_LABEL);
    await run(INPUTS({ ACTION: "synchronize", SENDER: "loop" }));

    expect(decided).toEqual({ decision: "wait", head: HEAD });
    expect(writes()).toEqual([]);
    expect(labels()).toEqual([MERGE_LABEL, UPDATE_BRANCH_LABEL]);
  });
});

/**
 * `synchronize` (#589): a push to a pull request carrying `agent:merge`
 * re-starts the gate, so a disarm is said when the head moves. A push never
 * arms, and its sender's permission is not what anything turns on.
 */
describe("merge:gate on a push", () => {
  it("merges a head a clean refresh carried the arm on to", async () => {
    armed(HEAD, 1);
    await run(INPUTS({ ACTION: "synchronize", SENDER: "bob" }));

    expect(decided).toEqual({ decision: "merge", head: HEAD });
    expect(writes()).toEqual([]);
    expect(loopReads.reads.some((r) => r.method === "permission")).toBe(false);
  });

  it("disarms any other new head, naming the human who armed the commit it moved off, and asking for a fresh merge-check", async () => {
    armed(MOVED);
    github.commits.set(PR, [MOVED, HEAD]);
    await run(INPUTS({ ACTION: "synchronize", SENDER: "alice" }));

    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
    expect(arms()).toEqual([]);
    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toContain(`@alice armed \`${MOVED}\`, but the head of this PR is now \`${HEAD}\``);
    expect(comments()[0]).toContain(`run \`/merge-check\` on \`${HEAD}\``);
    expect(comments()[0]).not.toContain("the account the loop writes as");
    expect(labels()).not.toContain(MERGE_LABEL);
  });

  it("names the human on a loop-added label too, as an update-branch run's conclusion re-adds it after a resolution", async () => {
    armed(MOVED);
    github.commits.set(PR, [MOVED, HEAD]);
    github.pullRequests.get(PR)!.labels.push(REVIEW_LABEL);
    await run(INPUTS({ SENDER: LOOP }));

    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
    expect(comments()[0]).toContain(`@alice armed \`${MOVED}\``);
  });

  it("disarms naming no one where the earlier commits cannot be read", async () => {
    reads.reader.pullRequestCommits = async () => {
      throw new Error("boom");
    };
    await run(INPUTS({ ACTION: "synchronize", SENDER: "alice" }));

    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
    expect(comments()[0]).toContain(`No one armed \`${HEAD}\``);
  });
});

describe("merge:gate on a red head", () => {
  it.each([
    ["a required check failed", () => github.checks.set(HEAD, [check("CI / verify", "FAILURE")]), "A required check failed: `CI / verify`."],
    ["the verdict is not an approval", () => github.statuses.set(HEAD, [verdict("failure")]), "is `failure`, not an approval"],
  ])("says so once per head when %s, and keeps the arm and the label", async (_name, arrange, reason) => {
    arrange();
    await run();

    expect(decided).toEqual({ decision: "red", head: HEAD });
    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toContain(reason);
    expect(comments()[0]).toContain(mergeRedMark(HEAD));
    expect(labels()).toContain(MERGE_LABEL);
    expect(labels()).not.toContain(BLOCKED_LABEL);
    expect(arms()).toHaveLength(1);

    await run(INPUTS({ SENDER: LOOP }));
    expect(decided).toEqual({ decision: "red", head: HEAD });
    expect(comments()).toHaveLength(1);
  });

  it("does not count a red mark someone else typed", async () => {
    github.checks.set(HEAD, [check("CI / verify", "FAILURE")]);
    github.discussion.set(PR, [{ body: mergeRedMark(HEAD), author: "mallory", association: "NONE" }]);
    await run();

    expect(comments()).toHaveLength(1);
  });
});

describe("merge:gate reads the checks the base requires, or else every check but the loop's", () => {
  it("ignores a failing check that is not required, where one is", async () => {
    github.checks.set(HEAD, [check("CI / verify", "SUCCESS"), check("CI / flaky", "FAILURE", false)]);
    await run();

    expect(decided).toEqual({ decision: "merge", head: HEAD });
  });

  it("where none is required, requires every check but the loop's own to pass", async () => {
    github.checks.set(HEAD, [check("CI / verify", "FAILURE", false)]);
    await run();
    expect(decided).toEqual({ decision: "red", head: HEAD });
  });

  it("where none is required, waits on none of the loop's own jobs or statuses", async () => {
    github.checks.set(HEAD, [
      check("CI / verify", "SUCCESS", false),
      check("merge / merge", null, false),
      check("review / red-check", "FAILURE", false),
      { kind: "status", context: VERDICT_CONTEXT, state: "PENDING", required: false },
      { kind: "status", context: MERGE_CONTEXT, state: "PENDING", required: false },
    ]);
    await run();

    expect(decided).toEqual({ decision: "merge", head: HEAD });
  });

  it("merges a head with no check at all, on its approval", async () => {
    github.checks.set(HEAD, []);
    await run();

    expect(decided).toEqual({ decision: "merge", head: HEAD });
  });
});
