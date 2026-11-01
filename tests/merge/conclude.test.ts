import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Limits } from "../../engine/writer.js";
import { conclude, MINT_FAILED } from "../../merge/conclude.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { BLOCKED_LABEL, MERGE_LABEL } from "../../shared/record.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `merge:conclude` (#588), called the way the CLI calls it: its declared
 * inputs, the gate's and publish's directories, a fake reader and the
 * engine's writers over a fake GitHub. What is asserted is the loop's one
 * order on a run that stopped, and silence on one that finished.
 */

const PR = 7;
const RUN = "https://github.com/o/r/actions/runs/42";

let root: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;

const dir = (name: string): string => path.join(root, name);
const reason = (name: string, text: string): void => fs.writeFileSync(path.join(dir(name), "failure_reason.txt"), text);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-conclude-"));
  fs.mkdirSync(dir("gate"));
  fs.mkdirSync(dir("publish"));
  github = fakeGitHub([{ number: PR, labels: [MERGE_LABEL] }]);
  made = undefined;
  asked = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

type Inputs = Parameters<typeof conclude>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: dir("conclude"),
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  PR_NUMBER: String(PR),
  JOB_STATUS: "failure",
  TIMED_OUT: "false",
  TIMEOUT_MINUTES: "20",
  MINT_OUTCOME: "success",
  GATE_DIR: dir("gate"),
  PUBLISH_DIR: dir("publish"),
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "42",
  ...over,
});

const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["merge:conclude"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: fakeReader(github).reader,
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  await conclude(inputs, io);
};

const comments = () => github.comments.map((c) => c.body);

describe("merge:conclude", () => {
  it("does nothing on a run that finished, whatever the gate decided", async () => {
    await run(INPUTS({ JOB_STATUS: "success" }));

    expect(made).toBeUndefined();
    expect(github.pullRequests.get(PR)?.labels).toEqual([MERGE_LABEL]);
  });

  it("says a refused merge with publish's reason, then takes agent:merge off, then adds agent:blocked", async () => {
    reason("publish", "GitHub refused to squash-merge it, so nothing was merged.\n");
    await run();

    expect(comments()).toEqual([
      `**\`${MERGE_LABEL}\` stopped:** GitHub refused to squash-merge it, so nothing was merged.\n\n[Workflow run](${RUN}) · To try again, add \`${MERGE_LABEL}\`.\n`,
    ]);
    expect(made?.writes.map((w) => `${w.token} ${w.type}`)).toEqual(["workflow comment", "workflow removeLabel", "workflow addLabel"]);
    expect(github.pullRequests.get(PR)?.labels).toEqual([BLOCKED_LABEL]);
    expect(asked).toEqual({ comment: 1, removeLabel: 1, addLabel: 1 });
  });

  it("falls back on the gate's reason, then on none, ending each as a sentence", async () => {
    reason("gate", "permission of ghost: 404 Not Found");
    await run();
    expect(comments()[0]).toContain("stopped:** Permission of ghost: 404 Not Found.\n");

    fs.rmSync(path.join(dir("gate"), "failure_reason.txt"));
    github.comments.length = 0;
    await run();
    expect(comments()[0]).toContain("stopped:** It stopped without giving a reason.");
  });

  it.each([
    ["a timeout", { JOB_STATUS: "cancelled", TIMED_OUT: "true" }, "It timed out after 20 minutes."],
    ["a cancel", { JOB_STATUS: "cancelled" }, "It was cancelled before it finished, by hand or by GitHub."],
    ["a mint that failed", { MINT_OUTCOME: "failure" }, MINT_FAILED],
  ] as const)("says %s, without reading a reason file", async (_name, over, sentence) => {
    reason("publish", "not this one");
    await run(INPUTS(over));

    expect(comments()[0]).toContain(`stopped:** ${sentence}\n`);
  });

  it("links no run where there is none", async () => {
    await run(INPUTS({ GITHUB_RUN_ID: "" }));

    expect(comments()[0]).not.toContain("[Workflow run]");
  });

  it("leaves a pull request that merged before the run stopped alone", async () => {
    github.pullRequests.get(PR)!.merged = true;
    await run();

    expect(made).toBeUndefined();
  });

  /** The sentence `.github/actions/loop-token` writes on a failed mint, word for word. */
  it("says the mint's failure as the token resolver does", () => {
    const action = parse(fs.readFileSync(path.join(".github", "actions", "loop-token", "action.yml"), "utf8")) as {
      readonly runs: { readonly steps: readonly { readonly run?: string; readonly name?: string }[] };
    };
    const say = action.runs.steps.find((s) => s.name === "Say why the App's token was not minted");

    expect(say?.run).toContain(`printf '%s\\n' "${MINT_FAILED.replace(/`/g, "\\`")}"`);
  });
});
