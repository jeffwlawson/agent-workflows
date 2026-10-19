import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { Limits } from "../../engine/writer.js";
import { conclude, MINT_FAILED } from "../../implement/conclude.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { BLOCKED_LABEL, IMPLEMENT_LABEL } from "../../shared/record.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `implement:conclude` (#493), called the way the CLI calls it: its declared
 * inputs, the four directories it reads (`implement:publish`'s,
 * `implement:prepare`'s, the runner's and `implement:bundle`'s), a fake
 * GitHub reader, and the engine's writers over a fake GitHub, sharing one
 * log. What is asserted is what it did to the record: the writes it
 * attempted, in what order and with which token, and what the failure comment
 * said.
 *
 * The scenarios are the retired shell steps' (implement's halves of
 * `tests/failure-step.test.ts` and `tests/trigger-label-step.test.ts`, its
 * implement-only cases included), carried over by behaviour, with the PR a
 * run opened and then stopped named. The agent's job's own measure of whether
 * it timed out stays YAML, and stays there.
 */

const ISSUE = 135;
const PR = 152;
const RUN_URL = "https://github.com/acme/widgets/actions/runs/1";

let root: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let logged: string[];

type Dir = "publish" | "prepare" | "runner" | "bundle";
const dirOf = (name: Dir): string => path.join(root, name);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "implement-conclude-"));
  for (const name of ["publish", "prepare", "runner", "bundle"] as const) fs.mkdirSync(dirOf(name));
  github = fakeGitHub([]);
  github.issueLabels.set(ISSUE, [IMPLEMENT_LABEL]);
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

const put = (dir: Dir, name: string, value: unknown): void =>
  fs.writeFileSync(path.join(dirOf(dir), name), typeof value === "string" ? value : JSON.stringify(value));

/** What `implement:publish` wrote, as it writes it. */
const published = (over: Partial<{ pushed: boolean; head: string; pr: number; requested: boolean }> = {}): void =>
  put("publish", "published.json", { pushed: false, requested: false, ...over });

type Inputs = Parameters<typeof conclude>[0];

/** A run that finished, implement:publish included. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(root, "out"),
  GH_REPO: "acme/widgets",
  GH_TOKEN: "workflow-token",
  ISSUE_NUMBER: String(ISSUE),
  RUN_URL,
  REFUSED: "false",
  GATE_RESULT: "success",
  GATE_REASON: "",
  AGENT_RESULT: "success",
  TIMED_OUT: "false",
  TIMEOUT_MINUTES: "30",
  MINT_OUTCOME: "success",
  DOWNLOAD_OUTCOME: "success",
  PUBLISH_OUTCOME: "success",
  PUBLISH_DIR: dirOf("publish"),
  PREPARE_DIR: dirOf("prepare"),
  IMPLEMENT_DIR: dirOf("runner"),
  BUNDLE_DIR: dirOf("bundle"),
  ...over,
});

/** An agent's job that ended `result`, publish skipped behind it. */
const AGENT = (result: "failure" | "cancelled", over: Partial<Inputs> = {}): Partial<Inputs> => ({
  AGENT_RESULT: result,
  PUBLISH_OUTCOME: "skipped",
  ...over,
});

/** A gate that ended `result` after claiming the run, so the agent's job never ran. */
const GATE = (result: "failure" | "cancelled", over: Partial<Inputs> = {}): Partial<Inputs> => ({
  GATE_RESULT: result,
  AGENT_RESULT: "skipped",
  DOWNLOAD_OUTCOME: "skipped",
  PUBLISH_OUTCOME: "skipped",
  TIMED_OUT: "",
  ...over,
});

/** A gate that died, or was cancelled, before it decided: `refused` is empty, and the download and checkout never ran. */
const UNDECIDED = (result: "failure" | "cancelled" = "failure", over: Partial<Inputs> = {}): Partial<Inputs> => GATE(result, { REFUSED: "", ...over });

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["implement:conclude"]["outputs"]> = {
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

/** Each write, as `<token> <type> <what>`. */
const writes = (): string[] =>
  (made?.writes ?? []).map((w) => {
    const [first, second] = w.args;
    return `${w.token} ${w.type} ${String(first)}${w.type === "comment" ? "" : ` ${String(second)}`}`;
  });
const comments = (): string[] => github.comments.map((c) => c.body);
const comment = (): string => comments().at(-1) ?? "";
const warnings = (): string[] => logged.filter((line) => line.startsWith("::warning::"));

/** The one pattern for every run that stopped (#253). */
const STOPPED =
  /^\*\*`agent:implement` stopped:\*\* [A-Z][^\n]*[.!?]\n\n\[Workflow run\]\(https:\/\/github\.com\/acme\/widgets\/actions\/runs\/1\) · [A-Z][^\n]*\.\n$/;

/** What every stopped run writes, in the loop's one order (#236): the comment, the run's own label off, then `agent:blocked`. */
const STOPPED_WRITES = [`workflow comment ${ISSUE}`, `workflow removeLabel ${ISSUE} ${IMPLEMENT_LABEL}`, `workflow addLabel ${ISSUE} ${BLOCKED_LABEL}`];

/** And a gate that never decided: the same, but the label stays on. */
const UNDECIDED_WRITES = [`workflow comment ${ISSUE}`, `workflow addLabel ${ISSUE} ${BLOCKED_LABEL}`];

const RETRY = "To try again, add `agent:implement`.";
const UNDECIDED_RETRY = "To try again, remove `agent:implement` if it is still on this issue, then add it.";

describe("implement:conclude says how a stopped run stopped", () => {
  it("says a run that reached its limit timed out, naming the limit, and reads no reason file", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT("cancelled", { TIMED_OUT: "true" })));

    expect(comment()).toContain("timed out after 30 minutes");
    expect(comment()).toContain("`AGENT_TIMEOUT_MINUTES` raises the limit");
    expect(comment()).not.toMatch(/cancelled|failed/);
    expect(comment()).not.toContain("The runner wrote this.");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a run stopped by hand was cancelled, not timed out", async () => {
    await run(INPUTS(AGENT("cancelled")));

    expect(comment()).toContain("It was cancelled before it finished, by hand or by GitHub.");
    expect(comment()).not.toContain("timed out");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("reads a failed run's reason, whatever the clock says", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT("failure", { TIMED_OUT: "true" })));

    expect(comment()).toContain("stopped:** The runner wrote this.\n");
    expect(comment()).not.toMatch(/timed out|cancelled/);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  /**
   * The agent's job's result is the `needs` context's, where a job that
   * reached its limit may read as failed, and a runner that was killed wrote
   * no reason: so a failure without one is measured too.
   */
  it("says a run that failed at its limit with no reason timed out", async () => {
    await run(INPUTS(AGENT("failure", { TIMED_OUT: "true" })));

    expect(comment()).toContain("timed out after 30 minutes");
  });

  it("says a run that failed early with no reason gave none", async () => {
    await run(INPUTS(AGENT("failure")));

    expect(comment()).toContain("stopped:** It stopped without giving a reason. The workflow run's log has the details.\n");
    expect(comment()).not.toContain("timed out");
  });

  it("says a run cancelled while it published was cancelled, though the agent's job succeeded", async () => {
    await run(INPUTS({ PUBLISH_OUTCOME: "cancelled" }));

    expect(comment()).toContain("cancelled");
    expect(comment()).not.toContain("timed out");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a run cancelled in its gate after claiming the run was cancelled, though the agent's job never ran", async () => {
    await run(INPUTS(GATE("cancelled")));

    expect(comment()).toContain("cancelled");
    expect(comment()).not.toContain("timed out");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  /**
   * One pattern for every run that stopped (#253), whichever way it stopped:
   * the label in bold and `stopped:`, the reason as a sentence starting with a
   * capital and ending in a full stop, then the run's link and what to do.
   */
  it.each([
    ["failed", AGENT("failure")],
    ["cancelled", AGENT("cancelled")],
    ["timed out", AGENT("cancelled", { TIMED_OUT: "true" })],
    ["failed at publish", { PUBLISH_OUTCOME: "failure" }],
    ["failed in its gate", GATE("failure")],
  ] as const)("says it stopped in the one pattern, where it %s", async (_, over) => {
    await run(INPUTS(over));

    expect(comment()).toMatch(STOPPED);
    expect(comment()).toContain(`[Workflow run](${RUN_URL}) · ${RETRY}\n`);
  });

  it("makes a reason written in lower case and with no full stop a sentence", async () => {
    put("runner", "failure_reason.txt", "the push was rejected\n");

    await run(INPUTS(AGENT("failure")));

    expect(comment()).toContain("stopped:** The push was rejected.\n");
  });

  /**
   * `implement:gate` writes its reason on the gate's runner, so a gate that
   * failed after claiming the run, at the probe or a read after it, reaches
   * conclude as `GATE_REASON` (#490): said where no reason file came, and
   * never over one that did.
   */
  it("names the reason a gate that failed after claiming the run handed on", async () => {
    const reason = "Couldn't add `agent:implement` to #135, which it already carries.";

    await run(INPUTS(GATE("failure", { GATE_REASON: reason })));

    expect(comment()).toContain(`stopped:** ${reason}\n`);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("names a reason file over the gate's reason", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(GATE("failure", { GATE_REASON: "The gate wrote this." })));

    expect(comment()).toContain("The runner wrote this.");
    expect(comment()).not.toContain("The gate wrote this.");
  });

  it("says a gate that failed after claiming the run with no reason gave none", async () => {
    await run(INPUTS(GATE("failure")));

    expect(comment()).toContain("It stopped without giving a reason.");
    expect(comment()).not.toContain("timed out");
  });

  /**
   * `implement:prepare` and `implement:bundle` write their reasons in
   * directories of their own (#491): each is said, and a failure that left
   * one is never measured against the clock as a stop.
   */
  it.each(["prepare", "bundle"] as const)("names implement:%s's reason, not a timeout, where the agent's job failed at its limit", async (dir) => {
    put(dir, "failure_reason.txt", `The ${dir} step wrote this.\n`);

    await run(INPUTS(AGENT("failure", { TIMED_OUT: "true" })));

    expect(comment()).toContain(`stopped:** The ${dir} step wrote this.\n`);
    expect(comment()).not.toContain("timed out");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  /** The order the failure step read them in: the runner's, then prepare's, then bundle's. */
  it("names the runner's reason ahead of prepare's and bundle's", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.\n");
    put("prepare", "failure_reason.txt", "Prepare wrote this.\n");
    put("bundle", "failure_reason.txt", "Bundle wrote this.\n");

    await run(INPUTS(AGENT("failure")));

    expect(comment()).toContain("stopped:** The runner wrote this.\n");
  });

  it("names implement:publish's reason where it stopped", async () => {
    put("publish", "failure_reason.txt", "`agent/issue-135-widget` changed while this run worked, so the agent's commits were not pushed over what is there now.\n");
    published();

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("stopped:** `agent/issue-135-widget` changed while this run worked");
    expect(comment()).toContain(RETRY);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a publish that stopped with no reason gave none", async () => {
    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("It stopped without giving a reason.");
  });

  /** A failed mint is an ending, not a run with no comment. */
  it("says the mint failed where it did", async () => {
    await run(INPUTS({ MINT_OUTCOME: "failure", PUBLISH_OUTCOME: "skipped" }));

    expect(comment()).toContain(`stopped:** ${MINT_FAILED}\n`);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says the mint's reason in the resolver's words", () => {
    const action = parse(fs.readFileSync(path.join(".github", "actions", "loop-token", "action.yml"), "utf8")) as {
      runs: { steps: { name?: string; run?: string }[] };
    };
    const say = action.runs.steps.find((step) => step.name === "Say why the App's token was not minted");

    expect(say?.run).toContain(`printf '%s\\n' "${MINT_FAILED.replace(/`/g, "\\`")}"`);
  });

  /** A download that failed leaves publish no bundle, and publish says so: that is the reason. */
  it("names publish's reason where the download failed and publish ran without a bundle", async () => {
    put("publish", "failure_reason.txt", "The agent's job finished without handing over its commits, so nothing was pushed.\n");

    await run(INPUTS({ DOWNLOAD_OUTCOME: "failure", PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("stopped:** The agent's job finished without handing over its commits, so nothing was pushed.\n");
  });

  it("says a hand-over that could not be fetched was lost, where nothing else said why", async () => {
    await run(INPUTS({ DOWNLOAD_OUTCOME: "failure", PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("stopped:** The agent finished, but what it handed over could not be fetched from its job");
  });

  /** A file that does not read costs the comment nothing another producer gave it. */
  it("still names a reason where publish's published.json does not read", async () => {
    put("publish", "published.json", "{not json");
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT("failure")));

    expect(comment()).toContain("The runner wrote this.");
    expect(comment()).toContain(RETRY);
    expect(warnings().some((line) => line.includes("published.json"))).toBe(true);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("still names the PR where a reason file beside published.json does not read", async () => {
    published({ pushed: true, pr: PR });
    put("prepare", "failure_reason.txt", "Prepare wrote this.\n");
    fs.mkdirSync(path.join(dirOf("runner"), "failure_reason.txt", "not a file"), { recursive: true });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("stopped:** Prepare wrote this.\n");
    expect(comment()).toContain(`PR #${PR}`);
  });

  it("takes its label off and blocks, where the comment cannot be posted", async () => {
    github.fails = (write) => write.type === "comment";

    await run(INPUTS(AGENT("failure")));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(github.issueLabels.get(ISSUE)).toEqual([BLOCKED_LABEL]);
    expect(warnings()).toEqual([`::warning::Could not post the failure comment on #${ISSUE}.`]);
  });
});

/**
 * A run that opened its pull request and then stopped (#489): asking for the
 * review, or anything after the open. A retry would be refused, since the
 * gate refuses an issue an open PR closes, so the comment names the PR and
 * says to add `agent:review` on it.
 */
describe("implement:conclude names the pull request a stopped run opened", () => {
  it("names the PR, and says to add agent:review on it rather than retry", async () => {
    put("publish", "failure_reason.txt", `Couldn't add \`agent:review\` to PR #${PR}, so no review was requested.\n`);
    published({ pushed: true, head: "d".repeat(40), pr: PR });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toMatch(STOPPED);
    expect(comment()).toContain(
      `· It opened PR #${PR} before it stopped, so adding \`agent:implement\` again would be refused. Fix the problem above, then add \`agent:review\` to PR #${PR}.\n`,
    );
    expect(comment()).not.toContain(RETRY);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("names it where the run was cancelled after it opened the PR", async () => {
    published({ pushed: true, head: "d".repeat(40), pr: PR });

    await run(INPUTS({ PUBLISH_OUTCOME: "cancelled" }));

    expect(comment()).toContain("It was cancelled before it finished");
    expect(comment()).toContain(`add \`agent:review\` to PR #${PR}.`);
  });

  it("gives the plain retry where the push landed and no PR was opened", async () => {
    put("publish", "failure_reason.txt", "Couldn't open a pull request.\n");
    published({ pushed: true, head: "d".repeat(40) });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain(`· ${RETRY}\n`);
  });

  it("refuses a PR number that is not one, and still comments", async () => {
    put("publish", "published.json", JSON.stringify({ pushed: true, pr: "152; rm -rf", requested: false }));

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain(`· ${RETRY}\n`);
    expect(warnings().some((line) => line.includes("published.json"))).toBe(true);
  });
});

/**
 * A gate that died before it decided the issue was this run's, the shape
 * query erroring on a schema or permissions mismatch, writes no decision.
 * That is the run that most needs the comment, and the one whose label must
 * stay on: it may have been the event `agent-implement-prd` answers, which
 * holds the label while it works.
 */
describe("implement:conclude after a gate that never decided", () => {
  it("says why, blocks, and leaves agent:implement on", async () => {
    await run(INPUTS(UNDECIDED("failure", { GATE_REASON: "Couldn't read the shape of #135, so nothing was started." })));

    expect(comment()).toMatch(STOPPED);
    expect(comment()).toContain("stopped:** Couldn't read the shape of #135, so nothing was started.\n");
    expect(comment()).toContain(`· ${UNDECIDED_RETRY}\n`);
    expect(writes()).toEqual(UNDECIDED_WRITES);
    expect(github.issueLabels.get(ISSUE)).toEqual([IMPLEMENT_LABEL, BLOCKED_LABEL]);
  });

  it("says a gate that gave no reason gave none", async () => {
    await run(INPUTS(UNDECIDED()));

    expect(comment()).toContain("It stopped without giving a reason.");
    expect(comment()).toContain(UNDECIDED_RETRY);
    expect(writes()).toEqual(UNDECIDED_WRITES);
  });

  it("says a gate cancelled before it decided was cancelled", async () => {
    await run(INPUTS(UNDECIDED("cancelled")));

    expect(comment()).toContain("cancelled");
    expect(comment()).not.toContain("timed out");
    expect(writes()).toEqual(UNDECIDED_WRITES);
  });
});

describe("implement:conclude takes the trigger label off however a decided run ends", () => {
  it.each([
    ["failed", AGENT("failure")],
    ["was cancelled", AGENT("cancelled")],
    ["timed out", AGENT("cancelled", { TIMED_OUT: "true" })],
    ["failed at publish", { PUBLISH_OUTCOME: "failure" }],
    ["failed in its gate after claiming the run", GATE("failure")],
  ] as const)("takes it off a run that %s, after the comment and before agent:blocked", async (_, over) => {
    await run(INPUTS(over));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(github.issueLabels.get(ISSUE)).toEqual([BLOCKED_LABEL]);
  });

  it("takes it off a run that finished where publish did not", async () => {
    published({ pushed: true, pr: PR, requested: false });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${ISSUE} ${IMPLEMENT_LABEL}`]);
    expect(comments()).toEqual([]);
  });

  /**
   * Publish takes the label off before it asks for the review (#236), but
   * that removal is tolerated, so a finished run takes it off again: always
   * removed after a decided gate, whatever publish managed.
   */
  it("takes it off a run that finished where publish's own removal failed", async () => {
    published({ pushed: true, pr: PR, requested: true });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${ISSUE} ${IMPLEMENT_LABEL}`]);
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
    expect(comments()).toEqual([]);
  });

  it("removes it again, harmlessly, where publish already took it off", async () => {
    published({ pushed: true, pr: PR, requested: true });
    github.issueLabels.set(ISSUE, []);

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${ISSUE} ${IMPLEMENT_LABEL}`]);
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it("does nothing after a refusal or a deferral, which the gate said or must not", async () => {
    await run(INPUTS({ REFUSED: "true" }));

    expect(made).toBeUndefined();
  });

  it("writes within its limits", async () => {
    await run(INPUTS(AGENT("failure")));

    expect(asked).toEqual({ comment: 1, removeLabel: 1, addLabel: 1 });
  });

  it("writes everything with the workflow's token", async () => {
    published({ pr: PR });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(made?.writes.every((w) => w.token === "workflow")).toBe(true);
  });
});
