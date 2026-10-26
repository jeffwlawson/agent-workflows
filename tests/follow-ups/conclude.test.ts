import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Limits } from "../../engine/writer.js";
import { conclude } from "../../follow-ups/conclude.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { FOLLOW_UPS_LABEL } from "../../shared/record.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `follow-ups:conclude` (#511), called the way the CLI calls it: its declared
 * inputs, `follow-ups:file`'s directory, a fake GitHub reader, and the
 * engine's writers over a fake GitHub. What is asserted is what it did to the
 * record: the writes it made and what the comment said.
 *
 * The scenarios are the retired shell step's (*Report the failure on the PR*,
 * `follow-ups`' row of `tests/failure-step.test.ts`), carried over by
 * behaviour, and each comment is held byte for byte to what that step's
 * `printf` wrote. The job's own measure of whether it timed out stays YAML.
 */

const PR = 152;
const RUN_URL = "https://github.com/acme/widgets/actions/runs/1";

let root: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let logged: string[];

const fileDir = (): string => path.join(root, "file");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "follow-ups-conclude-"));
  fs.mkdirSync(fileDir());
  github = fakeGitHub([{ number: PR, state: "closed", labels: [FOLLOW_UPS_LABEL] }]);
  github.issueLabels.set(PR, [FOLLOW_UPS_LABEL]);
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

/** The reason `follow-ups:file`'s `fail()` wrote, as it writes it. */
const reason = (text: string): void => fs.writeFileSync(path.join(fileDir(), "failure_reason.txt"), text);

type Inputs = Parameters<typeof conclude>[0];

/** A run that finished. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(root, "conclude"),
  GH_REPO: "acme/widgets",
  GH_TOKEN: "workflow-token",
  PR_NUMBER: String(PR),
  RUN_URL,
  JOB_STATUS: "success",
  TIMED_OUT: "false",
  TIMEOUT_MINUTES: "10",
  FILE_DIR: fileDir(),
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["follow-ups:conclude"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: fakeReader(github).reader,
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  try {
    await conclude(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

/** Each write, as `<token> <type> <issue>`. */
const writes = (): string[] => (made?.writes ?? []).map((w) => `${w.token} ${w.type} ${String(w.args[0])}`);
const comments = (): string[] => github.comments.map((c) => c.body);

/** What the retired step's `printf` wrote for `sentence`, byte for byte. */
const SHELL = (sentence: string): string =>
  `**\`agent:follow-ups\` stopped:** ${sentence}\n\n[Workflow run](${RUN_URL}) · The post-merge checklist may not have been posted, and some follow-up issues may not have been filed. To try again, add \`agent:follow-ups\`, or remove it and add it back where it is on; nothing is posted or filed twice.\n`;

const NO_REASON = "It stopped without giving a reason. The workflow run's log has the details.";
const CANCELLED = "It was cancelled before it finished, by hand or by GitHub.";

describe("follow-ups:conclude says how a stopped run stopped", () => {
  it("writes nothing on a run that finished", async () => {
    reason("A stale reason.\n");

    await run();

    expect(made?.writes ?? []).toEqual([]);
    expect(comments()).toEqual([]);
  });

  it("gives a failed run the reason follow-ups:file wrote", async () => {
    reason("The runner wrote this.\n");

    await run(INPUTS({ JOB_STATUS: "failure" }));

    expect(comments()).toEqual([SHELL("The runner wrote this.")]);
    expect(writes()).toEqual([`workflow comment ${PR}`]);
  });

  it("says a failed run that wrote no reason gave none", async () => {
    await run(INPUTS({ JOB_STATUS: "failure" }));

    expect(comments()).toEqual([SHELL(NO_REASON)]);
  });

  it("says no reason where the reason file cannot be read, rather than losing the comment", async () => {
    // A directory where the file should be: there, and unreadable as text.
    fs.mkdirSync(path.join(fileDir(), "failure_reason.txt"));

    await run(INPUTS({ JOB_STATUS: "failure" }));

    expect(comments()).toEqual([SHELL(NO_REASON)]);
    expect(logged.some((line) => line.startsWith("::warning::"))).toBe(true);
  });

  it("says a run stopped by hand was cancelled, and reads no reason file", async () => {
    reason("The runner wrote this.\n");

    await run(INPUTS({ JOB_STATUS: "cancelled" }));

    expect(comments()).toEqual([SHELL(CANCELLED)]);
  });

  it("says a run that reached its limit timed out, naming the limit, and reads no reason file", async () => {
    reason("The runner wrote this.\n");

    await run(INPUTS({ JOB_STATUS: "cancelled", TIMED_OUT: "true" }));

    expect(comments()).toEqual([SHELL("It timed out after 10 minutes.")]);
  });

  it("makes a reason a sentence: a capital first letter and a closing full stop", async () => {
    reason("the push was rejected\n");

    await run(INPUTS({ JOB_STATUS: "failure" }));

    expect(comments()).toEqual([SHELL("The push was rejected.")]);
  });

  it("keeps a reason's own closing punctuation", async () => {
    reason("Nothing was filed!\n");

    await run(INPUTS({ JOB_STATUS: "failure" }));

    expect(comments()).toEqual([SHELL("Nothing was filed!")]);
  });

  /**
   * The marker means the stubs are still unfiled, and it is what the retry
   * removes and adds back; and a merged pull request has no pipeline left to
   * block.
   */
  it.each([
    ["success", "false"],
    ["failure", "false"],
    ["cancelled", "false"],
    ["cancelled", "true"],
  ] as const)("on %s (timed out: %s), leaves agent:follow-ups on and adds no label", async (status, timedOut) => {
    reason("The runner wrote this.\n");

    await run(INPUTS({ JOB_STATUS: status, TIMED_OUT: timedOut }));

    expect(writes().filter((w) => / (addLabel|removeLabel) /.test(w))).toEqual([]);
    expect(github.issueLabels.get(PR)).toEqual([FOLLOW_UPS_LABEL]);
    expect(writes()).toHaveLength(status === "success" ? 0 : 1);
  });

  it("asks for one comment and nothing else", async () => {
    await run(INPUTS({ JOB_STATUS: "failure" }));

    expect(asked).toEqual({ comment: 1 });
  });

  it("is said and not thrown where GitHub refuses the comment", async () => {
    github.fails = () => true;

    await run(INPUTS({ JOB_STATUS: "failure" }));

    expect(comments()).toEqual([]);
    expect(logged.some((line) => line.startsWith("::warning::") && line.includes(`#${PR}`))).toBe(true);
  });
});
