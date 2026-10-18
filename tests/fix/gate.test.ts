import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubError } from "../../engine/github.js";
import type { GitHubReader } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import { gate } from "../../fix/gate.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import { COMMANDS } from "../../shared/contract.js";
import { BLOCKED_LABEL, FIX_LABEL, REVIEW_LABEL } from "../../shared/record.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `fix:gate` (#470), called the way the CLI calls it: its declared inputs, a
 * fake GitHub reader, and the engine's writers over a fake GitHub, sharing one
 * log. What is asserted is what it did to the record, the writes it attempted
 * in order, and the decision it handed on in `gate.json`.
 *
 * The scenarios are the retired step tests' (fix's half of the pre-flight's
 * assertions in `tests/workflows.test.ts`, and fix's half of
 * `tests/post-wait-step.test.ts`), carried over by behaviour. The wait
 * itself, `shared/review-posting.ts`, is held to `update-branch.yml`'s shell
 * copy in `tests/post-wait-step.test.ts`.
 */

const PR = 7;
const BRANCH = "agent/issue-12-do-the-thing";
/** The head the label's event named. */
const HEAD = "a".repeat(40);
/** A commit the branch moved on to after the label. */
const MOVED = "b".repeat(40);

let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let reader: GitHubReader;
let reads: ReturnType<typeof fakeReader>["reads"];
let decided: unknown;
let logged: string[];

beforeEach(() => {
  github = fakeGitHub([{ number: PR, headSha: HEAD, labels: [FIX_LABEL] }]);
  github.branches.set(BRANCH, HEAD);
  made = undefined;
  asked = undefined;
  ({ reader, reads } = fakeReader(github));
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
  PR_NUMBER: String(PR),
  BRANCH,
  HEAD_SHA: HEAD,
  PR_STATE: "open",
  PR_MERGED: "false",
  POST_WAIT_SECONDS: "600",
  POST_POLL_SECONDS: "0",
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS(), github_: GitHubReader = reader): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["fix:gate"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: github_,
    outputs: {
      writeJson: (name, value) => {
        expect(name).toBe("gate.json");
        decided = value;
      },
      writeText: () => {},
      writeBytes: () => {},
      appendLine: () => {},
    },
  };
  try {
    await gate(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

/** Each write, as `<token> <type> <what>`. */
const writes = (): string[] =>
  (made?.writes ?? []).map((w) => {
    const [, second] = w.args;
    return `${w.token} ${w.type} ${typeof second === "string" ? second.split("\n")[0] : ""}`.trim();
  });

const labels = (): readonly string[] => github.pullRequests.get(PR)?.labels ?? [];
const comments = (): readonly string[] => github.comments.map((c) => c.body);

/** A reader whose `branchTip` throws `error`, otherwise the fake's. */
const tipThrows = (error: unknown): GitHubReader => ({
  ...reader,
  branchTip: async () => {
    throw error;
  },
});

describe("fix:gate refuses a pull request it should not work on", () => {
  const STALE =
    "**`agent:fix` didn't run:** The PR changed after `agent:fix` was added. Add `agent:fix` again to work on the latest version. If the PR still shows the old commit, close and reopen it so GitHub catches up.";
  const UNREADABLE = "**`agent:fix` didn't run:** Couldn't check whether the PR changed since `agent:fix` was added. Add `agent:fix` to try again.";
  const DELETED = "**`agent:fix` didn't run:** This PR's branch no longer exists, so there's nothing to fix.";
  const CLOSED = "**`agent:fix` didn't run:** This PR is closed.";

  it.each([
    ["closed", INPUTS({ PR_STATE: "closed" })],
    ["merged", INPUTS({ PR_STATE: "open", PR_MERGED: "true" })],
  ])("refuses a %s PR before reading anything, and does not block it", async (_, inputs) => {
    await run(inputs);

    expect(comments()).toEqual([CLOSED]);
    expect(writes()).toEqual([`workflow comment **\`${FIX_LABEL}\` didn't run:** This PR is closed.`, `workflow removeLabel ${FIX_LABEL}`]);
    expect(labels()).toEqual([]);
    expect(reads).toEqual([]);
    expect(decided).toEqual({ proceed: "false" });
  });

  /**
   * #188: the event's head is checked against the **branch ref**, never the
   * pull request's head, which went on reporting the old commit after the
   * branch moved in the case that raised it.
   */
  it("refuses a head the branch moved on from, names both commits in the log, and blocks it", async () => {
    github.branches.set(BRANCH, MOVED);

    await run();

    expect(comments()).toEqual([STALE]);
    expect(labels()).toEqual([BLOCKED_LABEL]);
    expect(writes().map((w) => w.split(" ").slice(0, 2).join(" "))).toEqual(["workflow comment", "workflow removeLabel", "workflow addLabel"]);
    expect(reads.map((r) => r.method)).toEqual(["branchTip"]);
    expect(logged.find((l) => l.startsWith("::warning::Stale head"))).toBe(
      `::warning::Stale head: this run was started for ${HEAD}, but ${BRANCH} is at ${MOVED}. Refusing rather than redo finished work.`,
    );
    expect(decided).toEqual({ proceed: "false" });
  });

  /** A 404 is the branch gone: nothing is left to act on, so it is not blocked. */
  it("refuses a deleted branch with its own sentence, and does not block it", async () => {
    github.branches.delete(BRANCH);

    await run();

    expect(comments()).toEqual([DELETED]);
    expect(labels()).toEqual([]);
    expect(logged).toContain(`::warning::Branch ${BRANCH} was not found on the remote.`);
    expect(decided).toEqual({ proceed: "false" });
  });

  /**
   * The opposite of `review:gate`, on purpose: this run pushes and replies,
   * and replying twice is the harm. "Could not tell" is not "not stale", so
   * any failure but a 404 refuses, blocked, with a sentence of its own.
   */
  it.each([
    ["a server error", new GitHubError("GET git/ref: 502 Bad Gateway", 502)],
    ["a refusal that is not a 404", new GitHubError("GET git/ref: 403 Forbidden", 403)],
    ["a GraphQL-style error with no status", new GitHubError("graphql: something")],
    ["a network failure", new TypeError("fetch failed")],
  ])("refuses an unreadable head, on %s, and blocks it", async (_, error) => {
    await run(INPUTS(), tipThrows(error));

    expect(comments()).toEqual([UNREADABLE]);
    expect(labels()).toEqual([BLOCKED_LABEL]);
    expect(logged.some((l) => l.startsWith(`::warning::Could not read the live head of ${BRANCH}; refusing`))).toBe(true);
    expect(decided).toEqual({ proceed: "false" });
  });

  /** A comment that fails still takes the label off, so the label never outlives the run with nothing behind it. */
  it("takes the label off and blocks even where the comment fails", async () => {
    github.branches.set(BRANCH, MOVED);
    github.fails = (write) => write.type === "comment";

    await run();

    expect(comments()).toEqual([]);
    expect(labels()).toEqual([BLOCKED_LABEL]);
    expect(logged).toContain(`::warning::Could not post the refusal comment on PR #${PR}.`);
    expect(decided).toEqual({ proceed: "false" });
  });

  it("tolerates a label write that fails on a refusal", async () => {
    github.branches.set(BRANCH, MOVED);
    github.fails = (write) => write.type !== "comment";

    await run();

    expect(comments()).toEqual([STALE]);
    expect(decided).toEqual({ proceed: "false" });
  });

  /** A refusal makes no probe and does not wait. */
  it("never probes or waits on a refusal", async () => {
    github.branches.set(BRANCH, MOVED);
    github.pullRequests.get(PR)?.labels.push(REVIEW_LABEL);

    await run();

    expect(writes().filter((w) => w === `workflow addLabel ${FIX_LABEL}`)).toEqual([]);
    expect(reads.map((r) => r.method)).not.toContain("pullRequest");
  });
});

describe("fix:gate claims a pull request it works on", () => {
  /**
   * The probe adds the label this run already holds, then `agent:blocked`
   * an earlier run left comes off, then it waits; nothing is said.
   */
  it("probes with agent:fix, takes agent:blocked off, and goes ahead", async () => {
    github.pullRequests.get(PR)?.labels.push(BLOCKED_LABEL);

    await run();

    expect(writes()).toEqual([`workflow addLabel ${FIX_LABEL}`, `workflow removeLabel ${BLOCKED_LABEL}`]);
    expect(labels()).toEqual([FIX_LABEL]);
    expect(comments()).toEqual([]);
    expect(decided).toEqual({ proceed: "true" });
    expect(made?.entries.map((e) => e.token)).toEqual(["workflow", "workflow"]);
  });

  /**
   * A short token fails the run at the probe, before the agent's job starts:
   * the job fails, and its decision still reads as going ahead, as the shell's
   * did, so the later jobs report a run that failed rather than one refused.
   */
  it("fails the run at the probe on a token that cannot write labels, naming the fix", async () => {
    github.fails = (write) => write.type === "addLabel";

    await expect(run()).rejects.toThrow(
      `Couldn't add \`${FIX_LABEL}\` to PR #${PR}, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants \`pull-requests: write\`.`,
    );
    expect(writes()).toEqual([`workflow addLabel ${FIX_LABEL}`]);
    expect(decided).toEqual({ proceed: "true" });
    expect(made?.log.entries.at(-1)?.outcome).toBe("failed");
  });

  it("goes ahead though agent:blocked cannot come off", async () => {
    github.fails = (write) => write.type === "removeLabel";

    await run();

    expect(decided).toEqual({ proceed: "true" });
  });

  it("limits itself to the writes a gate makes", async () => {
    await run();

    expect(asked).toEqual({ comment: 1, removeLabel: 1, addLabel: 1 });
  });
});

describe("fix:gate waits for a review's posting to finish", () => {
  /** The bound is the posting job's own `timeout-minutes`, ten. */
  it("is bounded by the posting job's limit by default", () => {
    expect(COMMANDS["fix:gate"].inputs.POST_WAIT_SECONDS).toEqual({ required: false, default: "600" });
    expect(COMMANDS["fix:gate"].inputs.POST_POLL_SECONDS).toEqual({ required: false, default: "10" });
  });

  it("goes straight on where no review is posting", async () => {
    await run();

    expect(reads.filter((r) => r.method === "pullRequest")).toHaveLength(1);
    expect(logged).toContain(`No review is posting on PR #${PR}.`);
  });

  it("waits while agent:review is on, and goes on once it is off", async () => {
    const pr = github.pullRequests.get(PR);
    pr?.labels.push(REVIEW_LABEL);
    let looked = 0;
    const waiting: GitHubReader = {
      ...reader,
      pullRequest: async (number) => {
        looked += 1;
        if (looked === 3 && pr !== undefined) pr.labels = pr.labels.filter((l) => l !== REVIEW_LABEL);
        return reader.pullRequest(number);
      },
    };

    await run(INPUTS(), waiting);

    expect(looked).toBe(3);
    expect(logged.filter((l) => l.includes("waiting for the review's posting job"))).toHaveLength(2);
    expect(logged.some((l) => l.startsWith("::warning::"))).toBe(false);
    expect(decided).toEqual({ proceed: "true" });
  });

  /** "Could not tell" is not "nothing is posting". */
  it("keeps waiting through a read that fails", async () => {
    let looked = 0;
    const flaky: GitHubReader = {
      ...reader,
      pullRequest: async (number) => {
        looked += 1;
        if (looked === 1) throw new GitHubError("GET pulls: 502", 502);
        return reader.pullRequest(number);
      },
    };

    await run(INPUTS(), flaky);

    expect(looked).toBe(2);
    expect(logged).toContain(`No review is posting on PR #${PR}.`);
  });

  /** A label nobody will take off costs the bound, then a warning, never the run. */
  it("stops waiting at the bound, says so, and does not fail", async () => {
    github.pullRequests.get(PR)?.labels.push(REVIEW_LABEL);

    await run(INPUTS({ POST_WAIT_SECONDS: "0" }));

    expect(logged.find((l) => l.startsWith("::warning::"))).toBe(
      `::warning::\`${REVIEW_LABEL}\` is still on PR #${PR} (or its labels could not be read) after 0 seconds, so this run goes on without waiting for a review to finish posting. If a review was posting, this run may not see its findings or its verdict.`,
    );
    expect(decided).toEqual({ proceed: "true" });
  });

  /** A label that is not `agent:review` but contains it is not a review posting. */
  it("matches the label exactly", async () => {
    github.pullRequests.get(PR)?.labels.push("agent:review-later", "x-agent:review");

    await run();

    expect(reads.filter((r) => r.method === "pullRequest")).toHaveLength(1);
  });
});

describe("fix:gate's decision", () => {
  /**
   * A cancel reaches Node as a signal, which ends it without running a
   * `finally`: so the decision is on disk before the probe and the wait, and
   * a run already claimed that is cancelled while it waits still reads as
   * claimed, and gets the cancel comment and `agent:blocked` from
   * `fix:conclude`, as the shell steps gave it.
   */
  it("writes that it went ahead before the probe and before the wait", async () => {
    const seen: unknown[] = [];
    const watching: GitHubReader = {
      ...reader,
      // A cancel at the wait's first read ends the process: what is on disk
      // by then is all `fix:conclude` will see.
      pullRequest: async (number) => {
        seen.push(structuredClone(decided));
        return reader.pullRequest(number);
      },
    };
    github.fails = (write) => {
      if (write.type === "addLabel") seen.push(structuredClone(decided));
      return false;
    };

    await run(INPUTS(), watching);

    expect(seen).toEqual([{ proceed: "true" }, { proceed: "true" }]);
  });

  /** No decision at all is the third value of `refused`, empty: a gate that died before deciding. */
  it("writes nothing on an input it cannot read, so the run reads as undecided", async () => {
    await expect(run(INPUTS({ PR_NUMBER: "seven" }))).rejects.toThrow("PR_NUMBER");
    expect(decided).toBeUndefined();
  });
});
