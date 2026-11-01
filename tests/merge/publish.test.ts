import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Limits } from "../../engine/writer.js";
import { publish } from "../../merge/publish.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { NEXT_READS, NEXT_TRIES } from "../../merge/queue.js";
import { armDescription, FIX_LABEL, MERGE_CONTEXT, MERGE_LABEL, REVIEW_LABEL, UPDATE_BRANCH_LABEL, VERDICT_CONTEXT } from "../../shared/record.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `merge:publish` (#588), called the way the CLI calls it: its declared
 * inputs, the gate's directory, a fake reader and the engine's writers over a
 * fake GitHub. What is asserted is the merge it made, with which token,
 * guarded on what and titled how, and what came off after.
 */

const PR = 7;
const HEAD = "a".repeat(40);

let root: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let logged: string[];

const gateDir = (): string => path.join(root, "gate");
const decided = (value: unknown): void => fs.writeFileSync(path.join(gateDir(), "gate.json"), JSON.stringify(value));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-publish-"));
  fs.mkdirSync(gateDir());
  github = fakeGitHub([{ number: PR, headSha: HEAD, baseRef: "main", labels: [MERGE_LABEL], title: "Do the thing" }]);
  github.branches.set("main", "c".repeat(40));
  made = undefined;
  asked = undefined;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

type Inputs = Parameters<typeof publish>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(root, "publish"),
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "app",
  AGENT_LOOP_LOGINS: "",
  LOOP_LOGIN: "loop",
  PR_NUMBER: String(PR),
  BASE_REF: "main",
  GATE_DIR: gateDir(),
  ...over,
});

const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["merge:publish"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: fakeReader(github).reader,
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  await publish(inputs, io);
};

describe("merge:publish", () => {
  it("squash-merges with the loop's token, guarded on the gate's head, titled `<title> (#<n>)`, then takes the label off", async () => {
    decided({ decision: "merge", head: HEAD });
    await run();

    expect(made?.writes.map((w) => `${w.token} ${w.type}`)).toEqual(["loop mergePullRequest", "workflow removeLabel"]);
    expect(made?.writes[0]?.args).toEqual([{ pr: PR, sha: HEAD, title: `Do the thing (#${PR})` }]);
    expect(github.pullRequests.get(PR)?.merged).toBe(true);
    expect(github.pullRequests.get(PR)?.labels).not.toContain(MERGE_LABEL);
    expect(asked).toEqual({ mergePullRequest: 1, removeLabel: 1 + NEXT_TRIES, addLabel: NEXT_TRIES });
  });

  it("leaves the message to the repository's squash setting", async () => {
    decided({ decision: "merge", head: HEAD });
    await run();

    expect(made?.writes[0]?.args[0]).not.toHaveProperty("message");
  });

  it.each(["wait", "behind", "red", "disarmed", "refused"])("does nothing on `%s`", async (decision) => {
    decided({ decision, head: HEAD });
    await run();

    expect(made).toBeUndefined();
    expect(github.pullRequests.get(PR)?.merged).toBeUndefined();
  });

  it("stops with GitHub's reason, and nothing merged, where the head moved since the gate checked it", async () => {
    decided({ decision: "merge", head: HEAD });
    github.pullRequests.get(PR)!.headSha = "b".repeat(40);

    await expect(run()).rejects.toThrow(
      `GitHub refused to squash-merge \`${HEAD}\`, answering "Head branch was modified. Review and try the merge again", so nothing was merged.`,
    );
    expect(github.pullRequests.get(PR)?.merged).toBeUndefined();
    expect(github.pullRequests.get(PR)?.labels).toContain(MERGE_LABEL);
  });

  it("stops where GitHub refuses the merge outright", async () => {
    decided({ decision: "merge", head: HEAD });
    github.fails = (write) => write.type === "mergePullRequest";

    await expect(run()).rejects.toThrow("so nothing was merged");
  });

  it("still counts as merged where the label cannot come off", async () => {
    decided({ decision: "merge", head: HEAD });
    github.fails = (write) => write.type === "removeLabel";
    await run();

    expect(github.pullRequests.get(PR)?.merged).toBe(true);
  });

  it("refuses a gate's file it cannot read, or a merge with no head, before any write", async () => {
    decided({ decision: "ship-it" });
    await expect(run()).rejects.toThrow("decision");

    decided({ decision: "merge" });
    await expect(run()).rejects.toThrow("named no head");
    expect(made).toBeUndefined();
  });
});

/** Another open pull request, armed by the loop token's account at `at`, behind `main` and green unless a test says. */
const other = (
  number: number,
  { at, base = "main", labels = [MERGE_LABEL], behind = true, red = false, armed = true }: { at?: string; base?: string; labels?: string[]; behind?: boolean; red?: boolean; armed?: boolean } = {},
): string => {
  const head = number.toString(16).padStart(40, "0");
  github.pullRequests.set(number, { number, nodeId: `PR_${number}`, state: "open", draft: false, headSha: head, title: "", body: "", labels, baseRef: base });
  github.statuses.set(head, [
    ...(armed ? [{ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription({ login: "alice", at: at ?? "2026-11-01T00:00:00Z", refreshes: 0 }), creator: "loop" }] : []),
    { context: VERDICT_CONTEXT, state: "success", targetUrl: null, description: "", creator: "github-actions[bot]" },
  ]);
  github.comparisons.set(`${base}...${head}`, behind ? "behind" : "ahead");
  github.checks.set(head, [{ kind: "checkRun", name: "CI / verify", status: "COMPLETED", conclusion: red ? "FAILURE" : "SUCCESS", required: true }]);
  return head;
};

/** The pull requests now carrying `agent:update-branch`. */
const refreshed = (): number[] => [...github.pullRequests.values()].filter((pr) => pr.labels.includes(UPDATE_BRANCH_LABEL)).map((pr) => pr.number);

describe("merge:publish drains the queue (#590)", () => {
  beforeEach(() => decided({ decision: "merge", head: HEAD }));

  it("refreshes only the oldest other armed pull request that is behind and not red, with the loop's token, removing the label first", async () => {
    other(20, { at: "2026-10-30T10:00:00Z", red: true });
    other(21, { at: "2026-10-31T10:00:00Z" });
    other(22, { at: "2026-11-01T10:00:00Z" });
    await run();

    expect(refreshed()).toEqual([21]);
    expect(made?.writes.slice(2).map((w) => `${w.token} ${w.type} ${w.args.join(" ")}`)).toEqual([
      `loop removeLabel 21 ${UPDATE_BRANCH_LABEL}`,
      `loop addLabel 21 ${UPDATE_BRANCH_LABEL}`,
    ]);
    expect(github.pullRequests.get(21)?.labels).toContain(UPDATE_BRANCH_LABEL);
    expect(github.pullRequests.get(20)?.labels).not.toContain(UPDATE_BRANCH_LABEL);
    expect(github.pullRequests.get(22)?.labels).not.toContain(UPDATE_BRANCH_LABEL);
    expect(logged.some((line) => line.includes("Not refreshing PR #20: it is red."))).toBe(true);
  });

  it("orders by the arm's time, not the number, and breaks a tie by the number", async () => {
    other(30, { at: "2026-11-01T10:00:00Z" });
    other(32, { at: "2026-10-31T10:00:00Z" });
    other(31, { at: "2026-10-31T10:00:00Z" });
    await run();

    expect(refreshed()).toEqual([31]);
  });

  it("labels none into another base, without agent:merge, with a trigger label on, current, red or unarmed, and names each it passed over", async () => {
    other(40, { at: "2026-10-01T00:00:00Z", base: "release" });
    other(41, { at: "2026-10-02T00:00:00Z", labels: [] });
    other(42, { at: "2026-10-03T00:00:00Z", labels: [MERGE_LABEL, REVIEW_LABEL] });
    other(43, { at: "2026-10-04T00:00:00Z", labels: [MERGE_LABEL, FIX_LABEL] });
    other(44, { at: "2026-10-05T00:00:00Z", behind: false });
    other(45, { at: "2026-10-06T00:00:00Z", red: true });
    other(46, { armed: false });
    await run();

    expect(refreshed()).toEqual([]);
    expect(made?.writes.map((w) => w.type)).toEqual(["mergePullRequest", "removeLabel"]);
    for (const n of [42, 43, 44, 45, 46]) expect(logged.some((line) => line.startsWith(`Not refreshing PR #${n}:`)), String(n)).toBe(true);
    expect(logged.some((line) => line.includes("#40") || line.includes("#41"))).toBe(false);
  });

  it("does not count a pending verdict as red: the refresh is what a behind head needs first", async () => {
    const head = other(50);
    github.statuses.get(head)!.splice(1, 1, { context: VERDICT_CONTEXT, state: "pending", targetUrl: null, description: "", creator: "github-actions[bot]" });
    await run();

    expect(refreshed()).toEqual([50]);
  });

  it("counts a rejection by the loop's accounts as red, and reads an arm only off the loop token's account", async () => {
    const rejected = other(60, { at: "2026-10-01T00:00:00Z" });
    github.statuses.get(rejected)!.unshift({ context: VERDICT_CONTEXT, state: "failure", targetUrl: null, description: "", creator: "github-actions[bot]" });
    const forged = other(61, { at: "2026-10-02T00:00:00Z", armed: false });
    github.statuses.get(forged)!.unshift({ context: MERGE_CONTEXT, state: "success", targetUrl: null, description: armDescription({ login: "alice", at: "2026-10-02T00:00:00Z", refreshes: 0 }), creator: "github-actions[bot]" });
    other(62, { at: "2026-10-03T00:00:00Z" });
    await run();

    expect(refreshed()).toEqual([62]);
  });

  it("warns where GitHub refuses the label on the chosen one, and asks the next", async () => {
    other(70, { at: "2026-10-01T00:00:00Z" });
    other(71, { at: "2026-10-02T00:00:00Z" });
    let adds = 0;
    github.fails = (write) => write.type === "addLabel" && adds++ === 0;
    await run();

    expect(github.pullRequests.get(70)?.labels).not.toContain(UPDATE_BRANCH_LABEL);
    expect(github.pullRequests.get(71)?.labels).toContain(UPDATE_BRANCH_LABEL);
    expect(logged).toContain(`::warning::GitHub refused ${UPDATE_BRANCH_LABEL} on PR #70, so the next armed pull request is asked instead.`);
  });

  it(`asks at most ${NEXT_TRIES}, and names those it did not ask`, async () => {
    for (let n = 80; n < 80 + NEXT_TRIES + 1; n++) other(n, { at: `2026-10-0${n - 79}T00:00:00Z` });
    github.fails = (write) => write.type === "addLabel";
    await run();

    expect(made?.writes.filter((w) => w.type === "addLabel")).toHaveLength(NEXT_TRIES);
    expect(logged.some((line) => line.startsWith("::warning::") && line.includes(`#${80 + NEXT_TRIES} were not asked`))).toBe(true);
    expect(github.pullRequests.get(PR)?.merged).toBe(true);
  });

  it("refuses a write past the cap", async () => {
    // The cap is the engine's: a fourth add on the limits publish asks for is refused before it is made.
    other(90);
    await run();
    const { writers } = fakeWriters(github, ["loop"] as const, asked ?? {});
    for (let n = 0; n < NEXT_TRIES; n++) await writers.loop.addLabel(90, UPDATE_BRANCH_LABEL);
    await expect(writers.loop.addLabel(90, UPDATE_BRANCH_LABEL)).rejects.toThrow("past the limit");
  });

  it(`reads at most ${NEXT_READS} armed pull requests, and warns naming those past it`, async () => {
    for (let n = 100; n < 100 + NEXT_READS + 2; n++) other(n, { behind: false });
    await run();

    expect(logged.some((line) => line.startsWith("::warning::") && line.includes(`#${100 + NEXT_READS}, #${101 + NEXT_READS} were not read`))).toBe(true);
  });

  it("still counts as merged where the listing cannot be read, and says the way on by hand", async () => {
    const io = fakeReader(github).reader;
    io.openPullRequestsLabelled = async () => {
      throw new Error("boom");
    };
    const commandIo: CommandIo<(typeof COMMANDS)["merge:publish"]["outputs"]> = {
      writers: (limits) => {
        made = fakeWriters(github, ["loop", "workflow"] as const, limits);
        return made.writers;
      },
      github: io,
      outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
    };
    await publish(INPUTS(), commandIo);

    expect(github.pullRequests.get(PR)?.merged).toBe(true);
    expect(logged.some((line) => line.startsWith("::warning::") && line.includes("could not be read (boom)") && line.includes(`Add \`${UPDATE_BRANCH_LABEL}\` to the next armed pull request into \`main\` by hand`))).toBe(true);
  });
});
