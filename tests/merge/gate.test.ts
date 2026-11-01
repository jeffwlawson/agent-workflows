import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitCheck } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import { gate } from "../../merge/gate.js";
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

    expect(arms()).toEqual([{ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription("alice"), creator: LOOP }]);
    expect(writes()).toEqual(["loop setCommitStatus"]);
    expect(comments()).toEqual([]);
    expect(labels()).toContain(MERGE_LABEL);
    expect(decided).toEqual({ decision: "merge", head: HEAD });
    expect(asked).toEqual({ comment: 1, removeLabel: 1, setCommitStatus: 1 });
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
    github.statuses.get(HEAD)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription("alice"), creator: LOOP });
    await run(INPUTS({ SENDER: "LOOP" }));

    expect(writes()).toEqual([]);
    expect(decided).toEqual({ decision: "merge", head: HEAD });
  });
});

describe("merge:gate reads an arm only off the loop token's account", () => {
  it.each(["github-actions[bot]", "workflow", "alice"])("an agent-merge status by %s is no arm", async (creator) => {
    github.statuses.get(HEAD)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription("alice"), creator });
    await run(INPUTS({ SENDER: LOOP }));

    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
    expect(labels()).not.toContain(MERGE_LABEL);
  });

  it("reads none at all where the loop token's account is github-actions[bot]", async () => {
    github.statuses.get(HEAD)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription("alice"), creator: "github-actions[bot]" });
    await run(INPUTS({ SENDER: "github-actions[bot]", LOOP_LOGIN: "github-actions[bot]" }));

    expect(decided).toEqual({ decision: "disarmed", head: HEAD });
  });

  it("names the human who armed the labelled head, where the head moved past it since", async () => {
    github.statuses.get(HEAD)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription("alice"), creator: LOOP });
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

describe("merge:gate on a behind head", () => {
  it("waits, says it is behind once per head, and keeps the arm", async () => {
    github.comparisons.set(`main...${HEAD}`, "diverged");
    await run();

    expect(decided).toEqual({ decision: "behind", head: HEAD });
    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toContain(`\`${HEAD}\` is behind \`main\``);
    expect(comments()[0]).toContain(mergeBehindMark(HEAD));
    expect(labels()).toContain(MERGE_LABEL);

    await run(INPUTS({ SENDER: LOOP }));
    expect(comments()).toHaveLength(1);
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
