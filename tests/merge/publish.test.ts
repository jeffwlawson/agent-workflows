import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Limits } from "../../engine/writer.js";
import { publish } from "../../merge/publish.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { MERGE_LABEL } from "../../shared/record.js";
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

const gateDir = (): string => path.join(root, "gate");
const decided = (value: unknown): void => fs.writeFileSync(path.join(gateDir(), "gate.json"), JSON.stringify(value));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-publish-"));
  fs.mkdirSync(gateDir());
  github = fakeGitHub([{ number: PR, headSha: HEAD, baseRef: "main", labels: [MERGE_LABEL], title: "Do the thing" }]);
  github.branches.set("main", "c".repeat(40));
  made = undefined;
  asked = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
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
  PR_NUMBER: String(PR),
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
    expect(asked).toEqual({ mergePullRequest: 1, removeLabel: 1 });
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
