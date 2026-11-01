import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { GitHubError } from "../../engine/github.js";
import type { GitHubReader } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { BLOCKED_LABEL, FIX_LABEL, MERGE_LABEL, REVIEW_LABEL, UPDATE_BRANCH_LABEL } from "../../shared/record.js";
import { conclude, MINT_FAILED } from "../../update-branch/conclude.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `update-branch:conclude` (#485), called the way the CLI calls it: its
 * declared inputs, the four directories it reads (`update-branch:publish`'s,
 * `update-branch:prepare`'s, the runner's and `update-branch:bundle`'s), a
 * fake GitHub reader, and the engine's writers over a fake GitHub, sharing one
 * log. What is asserted is what it did to the record: the writes it
 * attempted, in what order and with which token, and what the failure comment
 * said.
 *
 * The scenarios are the retired shell steps' (update-branch's halves of
 * `tests/failure-step.test.ts` and `tests/trigger-label-step.test.ts`, its
 * update-branch-only cases included), carried over by behaviour. The agent's
 * job's own measure of whether it timed out stays YAML, and stays there.
 */

const PR = 7;
/** The head the label's event named, which the run started from. */
const HEAD = "a".repeat(40);
/** The merge `update-branch:publish` pushed. */
const MERGE = "b".repeat(40);
/** A head somebody pushed while the run worked. */
const PUSHED = "c".repeat(40);
const RUN_URL = "https://github.com/o/r/actions/runs/42";

let root: string;
let github: FakeGitHub;
let reader: GitHubReader;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let logged: string[];

type Dir = "publish" | "prepare" | "runner" | "bundle";
const dirOf = (name: Dir): string => path.join(root, name);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "update-branch-conclude-"));
  for (const name of ["publish", "prepare", "runner", "bundle"] as const) fs.mkdirSync(dirOf(name));
  github = fakeGitHub([{ number: PR, headSha: HEAD, labels: [UPDATE_BRANCH_LABEL] }]);
  reader = fakeReader(github).reader;
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

/** What `update-branch:publish` wrote, as it writes it. */
const published = (over: Partial<{ pushed: boolean; head: string; requested: boolean }> = {}): void =>
  put("publish", "published.json", { pushed: false, requested: false, ...over });

/** The pull request as it is now: its head moved to `head`, carrying `labels`. */
const live = (over: Partial<{ headSha: string; labels: string[]; state: "open" | "closed" }>): void => {
  const pr = github.pullRequests.get(PR);
  if (pr !== undefined) Object.assign(pr, over);
};

type Inputs = Parameters<typeof conclude>[0];

/** A clean merge that finished, update-branch:publish included. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(root, "out"),
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "pat",
  PR_NUMBER: String(PR),
  HEAD_SHA: HEAD,
  REFUSED: "false",
  GATE_RESULT: "success",
  GATE_REASON: "",
  STATUS: "clean",
  AGENT_RESULT: "skipped",
  TIMED_OUT: "",
  TIMEOUT_MINUTES: "30",
  MINT_OUTCOME: "success",
  DOWNLOAD_OUTCOME: "skipped",
  PUBLISH_OUTCOME: "success",
  PUBLISH_DIR: dirOf("publish"),
  PREPARE_DIR: dirOf("prepare"),
  UPDATE_BRANCH_DIR: dirOf("runner"),
  BUNDLE_DIR: dirOf("bundle"),
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "42",
  ...over,
});

/** A conflicted merge whose agent's job ended `result`, the download and publish as they would then. */
const CONFLICTS = (result: "success" | "failure" | "cancelled", over: Partial<Inputs> = {}): Partial<Inputs> => ({
  STATUS: "conflicts",
  AGENT_RESULT: result,
  DOWNLOAD_OUTCOME: "success",
  PUBLISH_OUTCOME: result === "success" ? "success" : "skipped",
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["update-branch:conclude"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: reader,
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
    const [, second] = w.args;
    return `${w.token} ${w.type}${w.type === "comment" ? "" : ` ${String(second)}`}`;
  });
const comments = (): string[] => github.comments.map((c) => c.body);
const comment = (): string => comments().at(-1) ?? "";
const warnings = (): string[] => logged.filter((line) => line.startsWith("::warning::"));

/** The one pattern for every run that stopped (#253). */
const STOPPED =
  /^\*\*`agent:update-branch` stopped:\*\* [A-Z][^\n]*[.!?]\n\n\[Workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\) · [A-Z][^\n]*\.\n$/;

/** What every stopped run writes, in the loop's one order (#236): the comment, the run's own label off, then `agent:blocked`. */
const STOPPED_WRITES = ["workflow comment", `workflow removeLabel ${UPDATE_BRANCH_LABEL}`, `workflow addLabel ${BLOCKED_LABEL}`];

const RETRY = "To try again, add `agent:update-branch`.";

describe("update-branch:conclude says how a stopped run stopped", () => {
  it("says a run that reached its limit timed out, naming the limit, and reads no reason file", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(CONFLICTS("cancelled", { TIMED_OUT: "true" })));

    expect(comment()).toContain("timed out after 30 minutes");
    expect(comment()).toContain("`AGENT_TIMEOUT_MINUTES` raises the limit");
    expect(comment()).not.toMatch(/cancelled|failed/);
    expect(comment()).not.toContain("The runner wrote this.");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a run stopped by hand was cancelled, not timed out", async () => {
    await run(INPUTS(CONFLICTS("cancelled", { TIMED_OUT: "false" })));

    expect(comment()).toContain("It was cancelled before it finished, by hand or by GitHub.");
    expect(comment()).not.toContain("timed out");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("reads a failed run's reason, whatever the clock says", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(CONFLICTS("failure", { TIMED_OUT: "true" })));

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
    await run(INPUTS(CONFLICTS("failure", { TIMED_OUT: "true" })));

    expect(comment()).toContain("timed out after 30 minutes");
  });

  it("says a run that failed early with no reason gave none", async () => {
    await run(INPUTS(CONFLICTS("failure", { TIMED_OUT: "false" })));

    expect(comment()).toContain("stopped:** It stopped without giving a reason. The workflow run's log has the details.\n");
    expect(comment()).not.toContain("timed out");
  });

  it("says a run cancelled while it published was cancelled, though the agent's job succeeded", async () => {
    await run(INPUTS(CONFLICTS("success", { PUBLISH_OUTCOME: "cancelled", TIMED_OUT: "false" })));

    expect(comment()).toContain("cancelled");
    expect(comment()).not.toContain("timed out");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a clean merge cancelled while it published was cancelled", async () => {
    await run(INPUTS({ PUBLISH_OUTCOME: "cancelled" }));

    expect(comment()).toContain("It was cancelled before it finished");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a run cancelled in its gate was cancelled, though the agent's job never ran", async () => {
    await run(INPUTS({ GATE_RESULT: "cancelled", STATUS: "", AGENT_RESULT: "skipped", PUBLISH_OUTCOME: "skipped" }));

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
    ["failed", CONFLICTS("failure")],
    ["cancelled", CONFLICTS("cancelled")],
    ["timed out", CONFLICTS("cancelled", { TIMED_OUT: "true" })],
    ["failed at publish", { PUBLISH_OUTCOME: "failure" }],
  ] as const)("says it stopped in the one pattern, where it %s", async (_, over) => {
    await run(INPUTS(over));

    expect(comment()).toMatch(STOPPED);
    expect(comment()).toContain(`[Workflow run](${RUN_URL}) · ${RETRY}\n`);
  });

  // The service has no run page, so no run id: an empty `[Workflow run]()`
  // links nowhere, and #463's failure comment carried one.
  it("links no run where it has none, as on the service", async () => {
    await run(INPUTS({ ...CONFLICTS("failure"), GITHUB_RUN_ID: "" }));

    expect(comment()).not.toContain("[Workflow run]");
    expect(comment()).toMatch(/^\*\*`agent:update-branch` stopped:\*\* [^\n]+\n\nTo try again, add `agent:update-branch`\.\n$/);
  });

  it("makes a reason written in lower case and with no full stop a sentence", async () => {
    put("runner", "failure_reason.txt", "the push was rejected\n");

    await run(INPUTS(CONFLICTS("failure")));

    expect(comment()).toContain("stopped:** The push was rejected.\n");
  });

  /**
   * A gate command that failed after claiming the run, at the probe or the
   * merge's fetch (#481), wrote its reason on the gate job's runner, which
   * the publish job cannot read: it arrives as `GATE_REASON`.
   */
  it("names the reason a gate that failed after claiming the run handed on", async () => {
    await run(
      INPUTS({
        GATE_RESULT: "failure",
        GATE_REASON: "Couldn't fetch `main` to merge it, so the branch was left untouched: gone",
        STATUS: "",
        AGENT_RESULT: "skipped",
        PUBLISH_OUTCOME: "skipped",
      }),
    );

    expect(comment()).toContain("**`agent:update-branch` stopped:** Couldn't fetch `main` to merge it, so the branch was left untouched: gone.\n");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a gate that failed after claiming the run with no reason gave none", async () => {
    await run(INPUTS({ GATE_RESULT: "failure", STATUS: "", AGENT_RESULT: "skipped", PUBLISH_OUTCOME: "skipped" }));

    expect(comment()).toContain("It stopped without giving a reason.");
    expect(comment()).not.toContain("timed out");
  });

  /** `update-branch:prepare` (#482) refuses before the runner runs, under `prepare/`. */
  it("names update-branch:prepare's reason, not a timeout, where the agent's job failed at its limit", async () => {
    put("prepare", "failure_reason.txt", "Merging `main` again didn't conflict, so there was nothing for the agent to resolve and the branch was left untouched.\n");

    await run(INPUTS(CONFLICTS("failure", { TIMED_OUT: "true" })));

    expect(comment()).toContain(
      "**`agent:update-branch` stopped:** Merging `main` again didn't conflict, so there was nothing for the agent to resolve and the branch was left untouched.\n",
    );
    expect(comment()).not.toContain("timed out");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  /** `update-branch:bundle` (#483) refuses after the runner succeeded, under `bundle/`. */
  it("names update-branch:bundle's reason", async () => {
    const reason =
      "The agent finished without committing a merge of the base into `agent/issue-7`, so there was no resolution to push and the branch was left untouched.";
    put("bundle", "failure_reason.txt", `${reason}\n`);

    await run(INPUTS(CONFLICTS("failure")));

    expect(comment()).toContain(`**\`agent:update-branch\` stopped:** ${reason}\n`);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("names update-branch:publish's reason where it stopped", async () => {
    put("publish", "failure_reason.txt", "`agent/issue-7` moved while this run worked, so the merge was not pushed over what is there now.\n");
    published();

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("stopped:** `agent/issue-7` moved while this run worked");
    expect(comment()).toContain(RETRY);
  });

  it("says a publish that stopped with no reason gave none", async () => {
    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("It stopped without giving a reason.");
  });

  /** On an agent's run that stopped, publish's directory holds nothing it reads as a reason. */
  it("reads no publish reason on a run whose agent stopped", async () => {
    put("publish", "failure_reason.txt", "Publish wrote this.\n");
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(CONFLICTS("failure")));

    expect(comment()).toContain("The runner wrote this.");
    expect(comment()).not.toContain("Publish wrote this.");
  });

  /**
   * Since #99 a run can fail after its push: its comment, or the review it
   * asks for. Re-adding the label does nothing on a branch already merged.
   */
  it("says the merge was pushed, where publish stopped after its push", async () => {
    put("publish", "failure_reason.txt", "Couldn't comment on PR #7 to say what this run did. GitHub's reply is in the write log.\n");
    published({ pushed: true, head: MERGE });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("stopped:** Couldn't comment on PR #7");
    expect(comment()).toContain(
      "· The merge was pushed before it stopped, so running it again would do nothing. Fix the problem above.\n",
    );
    expect(comment()).not.toContain(RETRY);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  /** A failed mint is an ending, not a run with no comment. */
  it("says the mint failed where it did", async () => {
    await run(INPUTS({ LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "", MINT_OUTCOME: "failure", PUBLISH_OUTCOME: "skipped" }));

    expect(comment()).toContain(`stopped:** ${MINT_FAILED}\n`);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says the mint failed on a resolution too, ahead of what publish did not do", async () => {
    await run(INPUTS(CONFLICTS("success", { LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "", MINT_OUTCOME: "failure", PUBLISH_OUTCOME: "skipped" })));

    expect(comment()).toContain(`stopped:** ${MINT_FAILED}\n`);
  });

  it("says the mint's reason in the resolver's words", () => {
    const action = parse(fs.readFileSync(path.join(".github", "actions", "loop-token", "action.yml"), "utf8")) as {
      runs: { steps: { name?: string; run?: string }[] };
    };
    const say = action.runs.steps.find((step) => step.name === "Say why the App's token was not minted");

    expect(say?.run).toContain(`printf '%s\\n' "${MINT_FAILED.replace(/`/g, "\\`")}"`);
  });

  it("says a hand-over that could not be fetched was lost, on a finished agent's run", async () => {
    await run(INPUTS(CONFLICTS("success", { DOWNLOAD_OUTCOME: "failure", PUBLISH_OUTCOME: "failure" })));

    expect(comment()).toContain("stopped:** The agent finished, but what it handed over could not be fetched from its job");
  });

  /** A clean merge downloads nothing, so its skipped download is no failure. */
  it("reads a skipped download as nothing on a clean merge", async () => {
    published({ pushed: true, head: MERGE });

    await run(INPUTS({ DOWNLOAD_OUTCOME: "skipped" }));

    expect(comments()).toEqual([]);
  });

  /** A file that does not read costs the comment nothing another producer gave it. */
  it("still names a reason where publish's published.json does not read", async () => {
    put("publish", "published.json", "{not json");
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(CONFLICTS("failure")));

    expect(comment()).toContain("The runner wrote this.");
    expect(comment()).toContain(RETRY);
    expect(warnings().some((line) => line.includes("published.json"))).toBe(true);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("takes its label off and blocks, where the comment cannot be posted", async () => {
    github.fails = (write) => write.type === "comment";

    await run(INPUTS(CONFLICTS("failure")));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(github.pullRequests.get(PR)?.labels).toEqual([BLOCKED_LABEL]);
    expect(warnings()).toEqual(["::warning::Could not post the failure comment on PR #7."]);
  });
});

describe("update-branch:conclude takes the trigger label off however the run ends", () => {
  it.each([
    ["finished", {}],
    ["failed", CONFLICTS("failure")],
    ["was cancelled", CONFLICTS("cancelled")],
  ] as const)("takes it off a run that %s", async (_, over) => {
    published();

    await run(INPUTS(over));

    expect(writes()).toContain(`workflow removeLabel ${UPDATE_BRANCH_LABEL}`);
    expect(github.pullRequests.get(PR)?.labels).not.toContain(UPDATE_BRANCH_LABEL);
  });

  it("takes it off a run whose pre-flight never decided, and does nothing else", async () => {
    live({ headSha: PUSHED });

    await run(INPUTS({ REFUSED: "", GATE_RESULT: "failure", STATUS: "", PUBLISH_OUTCOME: "skipped" }));

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
    expect(comments()).toEqual([]);
  });

  it("does nothing after a refusal, which the gate said and took the label off for", async () => {
    await run(INPUTS({ REFUSED: "true" }));

    expect(made).toBeUndefined();
  });

  it("writes within its limits", async () => {
    await run(INPUTS(CONFLICTS("failure")));

    expect(asked).toEqual({ comment: 2, removeLabel: 2, addLabel: 2 });
  });
});

/**
 * #236: a refresh whose pull request moved while it worked, because somebody
 * pushed, asks for itself again. Adding the label then fired nothing, since
 * it was on.
 */
describe("update-branch:conclude asks again where the head moved while the run worked", () => {
  it("asks again with the loop's token, after taking its label off with the workflow's", async () => {
    published();
    live({ headSha: PUSHED });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`, `loop addLabel ${UPDATE_BRANCH_LABEL}`]);
    expect(github.pullRequests.get(PR)?.labels).toEqual([UPDATE_BRANCH_LABEL]);
  });

  it("reads the head it left as the merge it pushed", async () => {
    published({ pushed: true, head: MERGE });
    live({ headSha: MERGE });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
  });

  it("asks again where the head moved past the merge it pushed", async () => {
    published({ pushed: true, head: MERGE });
    live({ headSha: PUSHED });

    await run();

    expect(writes()).toContain(`loop addLabel ${UPDATE_BRANCH_LABEL}`);
  });

  it("asks for nothing where the head is still the one it left", async () => {
    published();

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
  });

  /**
   * Another trigger label is a run queued in the same concurrency group, and
   * a request now would cancel it while pending, before its own conclude
   * could take its label off.
   */
  it.each([FIX_LABEL, UPDATE_BRANCH_LABEL, REVIEW_LABEL])("asks for nothing, and leaves a queued run alone, where %s is on", async (other) => {
    published();
    // As read after this run's own label came off: what is on is another run's.
    const base = reader;
    reader = { ...base, pullRequest: async (number) => ({ ...(await base.pullRequest(number)), headSha: PUSHED, labels: [other] }) };

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
    expect(logged.some((line) => line.startsWith("::notice::") && line.includes(`carries ${other}`))).toBe(true);
  });

  it.each([
    ["failed", CONFLICTS("failure")],
    ["was cancelled", CONFLICTS("cancelled")],
    ["failed at publish", { PUBLISH_OUTCOME: "failure" }],
    ["was cancelled at publish", { PUBLISH_OUTCOME: "cancelled" }],
    ["had a gate that failed", { GATE_RESULT: "failure", AGENT_RESULT: "skipped", PUBLISH_OUTCOME: "skipped" }],
    ["had a gate that was cancelled", { GATE_RESULT: "cancelled", AGENT_RESULT: "skipped", PUBLISH_OUTCOME: "skipped" }],
  ] as const)("asks for nothing after a run that %s", async (_, over) => {
    published();
    live({ headSha: PUSHED });

    await run(INPUTS(over));

    expect(writes().filter((w) => w.includes(`addLabel ${UPDATE_BRANCH_LABEL}`))).toEqual([]);
  });

  it("asks again after a resolution where the agent's job succeeded and no review was asked for", async () => {
    published();
    live({ headSha: PUSHED });

    await run(INPUTS(CONFLICTS("success")));

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`, `loop addLabel ${UPDATE_BRANCH_LABEL}`]);
  });

  /**
   * One hand-off or the other, never both: where publish asked for the review
   * of its resolution, that review is queued in the group, and a second
   * request would cancel it while pending and strand `agent:review`.
   */
  it("asks for nothing more where publish asked for the review of its resolution", async () => {
    published({ pushed: true, head: MERGE, requested: true });
    live({ headSha: PUSHED });

    await run(INPUTS(CONFLICTS("success")));

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
    expect(logged).toContain("This run asked for the review of its resolution, so it asks for nothing more.");
  });

  it("asks for nothing where what publish did does not read", async () => {
    put("publish", "published.json", JSON.stringify({ pushed: true, requested: "yes" }));
    live({ headSha: PUSHED });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
    expect(warnings().some((line) => line.includes("was not asked for again"))).toBe(true);
  });

  it.each(["closed"] as const)("asks for nothing on a pull request that is %s", async (state) => {
    published();
    live({ headSha: PUSHED, state });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
  });

  /** A 404 is a pull request that is gone; any other failure is a read that failed, and the two are said apart. */
  it("says a pull request that is gone, and one that could not be read, in different words", async () => {
    published();
    github.pullRequests.delete(PR);

    await run();

    expect(warnings()).toEqual([]);
    expect(logged).toContain("PR #7 is not there any more, so there is nothing to ask for again.");

    logged.length = 0;
    reader = { ...reader, pullRequest: () => Promise.reject(new GitHubError("pull request #7: 502 Bad Gateway", 502)) };
    await run();

    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toContain("Could not read PR #7 to tell whether its head moved on");
    expect(warnings()[1]).toContain("so whether it carries agent:merge could not be told");
    expect(writes().filter((w) => w.includes("addLabel"))).toEqual([]);
  });

  /** The App's token fires the label as the PAT's does (#320). */
  it("asks again with the App's token, where the App is set up", async () => {
    published();
    live({ headSha: PUSHED });

    await run(INPUTS({ LOOP_TOKEN_SOURCE: "app" }));

    expect(writes()).toContain(`loop addLabel ${UPDATE_BRANCH_LABEL}`);
    expect(comments()).toEqual([]);
  });

  /** A label added with `GITHUB_TOKEN` starts nothing, so it says so instead of adding one. */
  it("says so on the pull request rather than adding a label that starts nothing, with neither the App nor the PAT", async () => {
    published();
    live({ headSha: PUSHED });

    await run(INPUTS({ LOOP_TOKEN_SOURCE: "workflow" }));

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`, "workflow comment"]);
    expect(comment()).toContain(PUSHED);
    expect(comment()).toContain("Add `agent:update-branch` by hand");
    expect(warnings().some((line) => line.includes("neither the loop's App nor AGENT_PAT is set"))).toBe(true);
  });

  it("warns, and fails nothing, where the label cannot be added again", async () => {
    published();
    live({ headSha: PUSHED });
    github.fails = (write) => write.type === "addLabel";

    await run();

    expect(warnings().some((line) => line.includes("could not be added again"))).toBe(true);
  });
});

/**
 * **The refresh hands back to the gate** (#589): the gate that asked for this
 * refresh ended, and the one its own push started may have found the head
 * before the arm was carried and waited. So a run that finished on a pull
 * request carrying `agent:merge` re-adds it with the loop's token, after its
 * own label is off; one that stopped leaves `agent:blocked` and the arm to the
 * maintainer.
 */
describe("update-branch:conclude hands an armed pull request back to the merge gate", () => {
  const HAND_BACK = [`loop removeLabel ${MERGE_LABEL}`, `loop addLabel ${MERGE_LABEL}`];

  it.each([
    ["a clean merge", {}],
    ["an up-to-date branch", { STATUS: "uptodate" }],
    ["a resolution", CONFLICTS("success")],
  ] as const)("re-adds agent:merge with the loop's token, removing it first, after its own label is off, on %s", async (_, over) => {
    published({ pushed: true, head: MERGE });
    live({ headSha: MERGE, labels: [MERGE_LABEL, UPDATE_BRANCH_LABEL] });

    await run(INPUTS(over));

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`, ...HAND_BACK]);
    expect(github.pullRequests.get(PR)?.labels).toEqual([MERGE_LABEL]);
  });

  it("hands back after a resolution whose review publish asked for, which the gate then disarms", async () => {
    published({ pushed: true, head: MERGE, requested: true });
    live({ headSha: MERGE, labels: [MERGE_LABEL, UPDATE_BRANCH_LABEL, REVIEW_LABEL] });

    await run(INPUTS(CONFLICTS("success")));

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`, ...HAND_BACK]);
  });

  it("hands back after asking for its own step again", async () => {
    published({ pushed: true, head: MERGE });
    live({ headSha: PUSHED, labels: [MERGE_LABEL, UPDATE_BRANCH_LABEL] });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`, `loop addLabel ${UPDATE_BRANCH_LABEL}`, ...HAND_BACK]);
  });

  it("re-adds nothing on a pull request without agent:merge", async () => {
    published({ pushed: true, head: MERGE });
    live({ headSha: MERGE, labels: [UPDATE_BRANCH_LABEL] });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
  });

  it.each([
    ["failed", CONFLICTS("failure")],
    ["was cancelled", CONFLICTS("cancelled")],
    ["failed at publish", { PUBLISH_OUTCOME: "failure" }],
  ] as const)("re-adds nothing on a run that %s, leaving agent:blocked and the arm", async (_, over) => {
    published();
    live({ headSha: MERGE, labels: [MERGE_LABEL, UPDATE_BRANCH_LABEL] });

    await run(INPUTS(over));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(github.pullRequests.get(PR)?.labels).toEqual([MERGE_LABEL, BLOCKED_LABEL]);
  });

  it("re-adds nothing on a refused run", async () => {
    live({ headSha: MERGE, labels: [MERGE_LABEL] });

    await run(INPUTS({ REFUSED: "true" }));

    expect(made).toBeUndefined();
  });

  it("re-adds nothing with the workflow token alone, which would start nothing, and says so", async () => {
    published({ pushed: true, head: MERGE });
    live({ headSha: MERGE, labels: [MERGE_LABEL, UPDATE_BRANCH_LABEL] });

    await run(INPUTS({ LOOP_TOKEN_SOURCE: "workflow" }));

    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
    expect(warnings().some((line) => line.includes(`carries ${MERGE_LABEL}`))).toBe(true);
  });

  /**
   * A read that failed is not a pull request without `agent:merge`: the
   * hand-back it skips is said, naming the label and the retry, on each path
   * the run can finish by, the ones that ask for nothing again included.
   */
  it.each([
    ["a clean merge", () => published({ pushed: true, head: MERGE }), {}],
    ["a resolution whose review publish asked for", () => published({ pushed: true, head: MERGE, requested: true }), CONFLICTS("success")],
    ["a published.json that does not read", () => put("publish", "published.json", "{not json"), {}],
  ] as const)("says the hand-back was skipped where the pull request could not be read, after %s", async (_, arrange, over) => {
    arrange();
    reader = { ...reader, pullRequest: () => Promise.reject(new GitHubError("pull request #7: 502 Bad Gateway", 502)) };

    await run(INPUTS(over));

    const said = warnings().filter((line) => line.includes(`whether it carries ${MERGE_LABEL} could not be told`));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("502 Bad Gateway");
    expect(said[0]).toContain(`remove it and add it again to re-start the gate`);
    expect(writes()).toEqual([`workflow removeLabel ${UPDATE_BRANCH_LABEL}`]);
  });

  it("says nothing of the hand-back where the pull request is gone", async () => {
    published({ pushed: true, head: MERGE });
    github.pullRequests.delete(PR);

    await run();

    expect(warnings()).toEqual([]);
  });

  it("warns, and fails nothing, where agent:merge cannot be added again", async () => {
    published({ pushed: true, head: MERGE });
    live({ headSha: MERGE, labels: [MERGE_LABEL, UPDATE_BRANCH_LABEL] });
    github.fails = (write) => write.type === "addLabel";

    await run();

    expect(warnings().some((line) => line.includes("hand the refreshed head back to the merge gate"))).toBe(true);
  });
});
