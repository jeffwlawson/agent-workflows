import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubError } from "../../engine/github.js";
import type { GitHubReader } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import { COMMANDS } from "../../shared/contract.js";
import { BLOCKED_LABEL, REVIEW_LABEL, UPDATE_BRANCH_LABEL } from "../../shared/record.js";
import { gate } from "../../update-branch/gate.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `update-branch:gate` (#481), called the way the CLI calls it: its declared
 * inputs, a fake GitHub reader, and the engine's writers over a fake GitHub,
 * sharing one log. What is asserted is what it did to the record, the writes
 * it attempted in order, and the decision it handed on in `gate.json`.
 *
 * The scenarios are the retired shell steps' (*Pre-flight*, *Transition
 * labels* and update-branch's half of `tests/post-wait-step.test.ts`),
 * carried over by behaviour. The wait itself is `shared/review-posting.ts`,
 * held in `tests/review-posting.test.ts`.
 */

const PR = 7;
const BRANCH = "agent/issue-12-do-the-thing";
const CLOSED = `**\`${UPDATE_BRANCH_LABEL}\` didn't run:** This PR is closed.`;

let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let reader: GitHubReader;
let reads: ReturnType<typeof fakeReader>["reads"];
let decided: unknown;
let logged: string[];

beforeEach(() => {
  github = fakeGitHub([{ number: PR, labels: [UPDATE_BRANCH_LABEL] }]);
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
  PR_STATE: "open",
  PR_MERGED: "false",
  POST_WAIT_SECONDS: "600",
  POST_POLL_SECONDS: "0",
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS(), github_: GitHubReader = reader): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["update-branch:gate"]["outputs"]> = {
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

describe("update-branch:gate refuses a closed pull request", () => {
  it.each([
    ["closed", INPUTS({ PR_STATE: "closed" })],
    ["merged", INPUTS({ PR_STATE: "open", PR_MERGED: "true" })],
  ])("refuses a %s PR before reading anything: the comment, then its label off, and no block", async (_, inputs) => {
    await run(inputs);

    expect(writes()).toEqual([`workflow comment ${CLOSED}`, `workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
    expect(comments()).toEqual([CLOSED]);
    expect(labels()).toEqual([]);
    expect(reads).toEqual([]);
    expect(decided).toEqual({ proceed: "false" });
  });

  /** A comment that fails still takes the label off, so the label never outlives the run with nothing behind it. */
  it("takes the label off even where the comment fails", async () => {
    github.fails = (write) => write.type === "comment";

    await run(INPUTS({ PR_STATE: "closed" }));

    expect(comments()).toEqual([]);
    expect(labels()).toEqual([]);
    expect(logged).toContain(`::warning::Could not post the refusal comment on PR #${PR}.`);
    expect(decided).toEqual({ proceed: "false" });
  });

  it("tolerates a label removal that fails on a refusal", async () => {
    github.fails = (write) => write.type === "removeLabel";

    await run(INPUTS({ PR_STATE: "closed" }));

    expect(comments()).toEqual([CLOSED]);
    expect(decided).toEqual({ proceed: "false" });
  });

  /** A refusal makes no probe and does not wait. */
  it("never probes or waits on a refusal", async () => {
    github.pullRequests.get(PR)?.labels.push(REVIEW_LABEL);

    await run(INPUTS({ PR_STATE: "closed" }));

    expect(writes().filter((w) => w.startsWith("workflow addLabel"))).toEqual([]);
    expect(reads.map((r) => r.method)).not.toContain("pullRequest");
  });

  /**
   * No refusal the shell pre-flight lacked: it reads no branch tip, so a
   * branch the API cannot find is the merge's fetch to fail on, not this.
   */
  it("reads no branch tip on an open pull request", async () => {
    await run();

    expect(reads.map((r) => r.method)).toEqual(["pullRequest"]);
    expect(decided).toEqual({ proceed: "true" });
  });
});

describe("update-branch:gate claims an open pull request", () => {
  /**
   * The probe adds the label this run already holds, then `agent:blocked`
   * an earlier run left comes off, then it waits; nothing is said.
   */
  it("probes with agent:update-branch, takes agent:blocked off, waits, and goes ahead", async () => {
    github.pullRequests.get(PR)?.labels.push(BLOCKED_LABEL);

    await run();

    expect(writes()).toEqual([`workflow addLabel ${UPDATE_BRANCH_LABEL}`, `workflow removeLabel ${BLOCKED_LABEL}`]);
    expect(labels()).toEqual([UPDATE_BRANCH_LABEL]);
    expect(comments()).toEqual([]);
    expect(logged).toContain(`No review is posting on PR #${PR}.`);
    expect(decided).toEqual({ proceed: "true" });
    expect(made?.entries.map((e) => e.token)).toEqual(["workflow", "workflow"]);
  });

  /**
   * A short token fails the run at the probe, before the checkout: the job
   * fails, and its decision still reads as going ahead, as the shell's did,
   * so the publish job reports a run that failed rather than one refused.
   */
  it("fails the run at the probe on a token that cannot write labels, naming the fix", async () => {
    github.fails = (write) => write.type === "addLabel";

    await expect(run()).rejects.toThrow(
      `Couldn't add \`${UPDATE_BRANCH_LABEL}\` to PR #${PR}, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants \`pull-requests: write\`.`,
    );
    expect(writes()).toEqual([`workflow addLabel ${UPDATE_BRANCH_LABEL}`]);
    expect(reads).toEqual([]);
    expect(decided).toEqual({ proceed: "true" });
    expect(made?.log.entries.at(-1)?.outcome).toBe("failed");
  });

  it("goes ahead though agent:blocked cannot come off", async () => {
    github.pullRequests.get(PR)?.labels.push(BLOCKED_LABEL);
    github.fails = (write) => write.type === "removeLabel";

    await run();

    expect(decided).toEqual({ proceed: "true" });
  });

  it("waits while agent:review is on, and goes on once it is off", async () => {
    const pr = github.pullRequests.get(PR);
    pr?.labels.push(REVIEW_LABEL);
    let looked = 0;
    const waiting: GitHubReader = {
      ...reader,
      pullRequest: async (number) => {
        looked += 1;
        if (looked === 2 && pr !== undefined) pr.labels = pr.labels.filter((l) => l !== REVIEW_LABEL);
        return reader.pullRequest(number);
      },
    };

    await run(INPUTS(), waiting);

    expect(looked).toBe(2);
    expect(logged.filter((l) => l.includes("waiting for the review's posting job"))).toHaveLength(1);
    expect(decided).toEqual({ proceed: "true" });
  });

  /** A label nobody will take off costs the bound, then a warning, never the run. */
  it("stops waiting at its bound, and goes ahead", async () => {
    github.pullRequests.get(PR)?.labels.push(REVIEW_LABEL);

    await run(INPUTS({ POST_WAIT_SECONDS: "0" }));

    expect(logged.some((l) => l.startsWith(`::warning::\`${REVIEW_LABEL}\` is still on PR #${PR}`))).toBe(true);
    expect(decided).toEqual({ proceed: "true" });
  });

  /** The bound is a review's posting job's own `timeout-minutes`, ten, as `fix:gate`'s is. */
  it("is bounded by the posting job's limit by default, as fix:gate is", () => {
    expect(COMMANDS["update-branch:gate"].inputs.POST_WAIT_SECONDS).toEqual(COMMANDS["fix:gate"].inputs.POST_WAIT_SECONDS);
    expect(COMMANDS["update-branch:gate"].inputs.POST_POLL_SECONDS).toEqual(COMMANDS["fix:gate"].inputs.POST_POLL_SECONDS);
  });

  it("limits itself to the writes a gate makes", async () => {
    await run();

    expect(asked).toEqual({ comment: 1, removeLabel: 2, addLabel: 1 });
  });
});

describe("update-branch:gate's decision", () => {
  /** A cancel during the probe or the wait still finds the run claimed on disk. */
  it("writes that it went ahead before the probe and before the wait", async () => {
    const seen: unknown[] = [];
    const watching: GitHubReader = {
      ...reader,
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
  it.each([
    ["PR_NUMBER", INPUTS({ PR_NUMBER: "seven" })],
    ["POST_WAIT_SECONDS", INPUTS({ POST_WAIT_SECONDS: "ten" })],
  ])("writes nothing on a %s it cannot read, so the run reads as undecided", async (name, inputs) => {
    await expect(run(inputs)).rejects.toThrow(name);
    expect(decided).toBeUndefined();
  });

  it("keeps waiting through a read that fails, and still goes ahead", async () => {
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
    expect(decided).toEqual({ proceed: "true" });
  });
});
