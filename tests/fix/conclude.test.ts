import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { BundleHead, GitReader } from "../../engine/git.js";
import type { GitHubReader } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import { conclude, MINT_FAILED } from "../../fix/conclude.js";
import type { CheckoutIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { BLOCKED_LABEL, FIX_LABEL } from "../../shared/record.js";
import { ignoredNote } from "../../shared/rescue.js";
import { fakeGit, fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `fix:conclude` (#469), called the way the CLI calls it: its declared
 * inputs, the three directories it reads (`fix:publish`'s, the runner's and
 * `fix:bundle`'s), a fake GitHub reader, a fake git reader standing for the
 * checkout, and the engine's writers over a fake GitHub, sharing one log.
 * What is asserted is what it did to the record: the writes it attempted, in
 * what order and with which token, what the failure comment said, and the
 * rescue branch.
 *
 * The scenarios are the retired step tests' (fix's halves of
 * `tests/failure-step.test.ts`, `tests/rescue-step.test.ts` and
 * `tests/trigger-label-step.test.ts`, and the publish job's failure-arm
 * assertions in `tests/workflows.test.ts`), carried over by behaviour. The
 * rescue's git is a fake here; the engine's own push is tested against a real
 * repository in `tests/engine/git.test.ts`.
 */

const PR = 7;
const BRANCH = "agent/issue-12-do-the-thing";
const RESCUE = `agent/rescue/fix-${PR}`;
/** The head the label's event named, which the run started from. */
const HEAD = "a".repeat(40);
/** The agent's commit on top of it. */
const TIP = "b".repeat(40);
/** An earlier run's rescue. */
const EARLIER = "c".repeat(40);
const RUN_URL = "https://github.com/o/r/actions/runs/42";

let root: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let git: ReturnType<typeof fakeGit>;
let reader: GitHubReader;
let logged: string[];

const dirOf = (name: "publish" | "prepare" | "fix" | "bundle"): string => path.join(root, name);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fix-conclude-"));
  for (const name of ["publish", "prepare", "fix", "bundle"] as const) fs.mkdirSync(dirOf(name));
  github = fakeGitHub([{ number: PR, nodeId: "PR_node7", headSha: HEAD, draft: true, labels: [FIX_LABEL] }]);
  github.branches.set(BRANCH, HEAD);
  made = undefined;
  asked = undefined;
  git = holding([{ ref: `refs/heads/${BRANCH}`, commit: TIP }]);
  reader = fakeReader(github).reader;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const bundlePath = (): string => path.join(dirOf("bundle"), "branch.bundle");

/** A checkout where the bundle, once handed over, carries `heads`, and the agent's commit builds on the head. */
const holding = (heads: readonly BundleHead[]) => fakeGit({ bundles: { [bundlePath()]: heads }, history: { [TIP]: [HEAD, TIP] } });

const put = (dir: "publish" | "prepare" | "fix" | "bundle", name: string, value: unknown): void =>
  fs.writeFileSync(path.join(dirOf(dir), name), typeof value === "string" ? value : JSON.stringify(value));

/** `fix:bundle`'s bundle: the agent made commits. */
const bundled = (): void => put("bundle", "branch.bundle", "a bundle");
/** What `fix:publish` wrote, as it writes it. */
const published = (
  over: Partial<{ pushed: boolean; head: string; notesPosted: boolean; nothingToDo: boolean; rescueNoted: boolean }> = {},
): void => put("publish", "published.json", { pushed: false, notesPosted: false, nothingToDo: false, rescueNoted: false, ...over });

type Inputs = Parameters<typeof conclude>[0];

/** A run that finished, fix:publish included. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(root, "out"),
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "app",
  PR_NUMBER: String(PR),
  BRANCH,
  HEAD_SHA: HEAD,
  RESCUE_BRANCH: RESCUE,
  CHECKOUT: "/checkout",
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
  FIX_DIR: dirOf("fix"),
  BUNDLE_DIR: dirOf("bundle"),
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "42",
  ...over,
});

/** An agent's job that stopped on its own terms, having written `reason`. */
const AGENT_FAILED = (over: Partial<Inputs> = {}): Partial<Inputs> => ({ AGENT_RESULT: "failure", ...over });

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CheckoutIo<(typeof COMMANDS)["fix:conclude"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: reader,
    git: git.git as GitReader,
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
    const what = w.type === "pushRef" ? (first as { ref: string }).ref : w.type === "comment" ? "" : String(second);
    return `${w.token} ${w.type}${what === "" ? "" : ` ${what}`}`;
  });
const comments = (): string[] => github.comments.map((c) => c.body);
const comment = (): string => comments().at(-1) ?? "";
const labels = (): string[] => github.pullRequests.get(PR)?.labels ?? [];
const warnings = (): string[] => logged.filter((line) => line.startsWith("::warning::"));

/** The one pattern for every run that stopped (#253). */
const STOPPED = /^\*\*`agent:fix` stopped:\*\* [A-Z][^\n]*[.!?]\n\n\[Workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\) · [A-Z][^\n]*\.\n$/;

/** What every stopped run ends with, in the loop's one order. */
const STOPPED_WRITES = ["workflow comment", `workflow removeLabel ${FIX_LABEL}`, `workflow addLabel ${BLOCKED_LABEL}`];

describe("fix:conclude ends a run that finished", () => {
  it("takes agent:fix off, and says nothing else: the rest is fix:publish's", async () => {
    published({ pushed: true, head: TIP });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${FIX_LABEL}`]);
    expect(labels()).toEqual([]);
    expect(comments()).toEqual([]);
  });

  it("takes agent:fix off a run that had nothing to do, and blocks nothing", async () => {
    published({ nothingToDo: true });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${FIX_LABEL}`]);
  });

  it("rescues nothing from a run that finished, whatever it handed over", async () => {
    bundled();
    published({ pushed: true, head: TIP });

    await run();

    expect(github.branches.has(RESCUE)).toBe(false);
    expect(git.calls).toEqual([]);
  });

  /** Where publish said the rescue was set aside, as its first write, it recorded so. */
  it("leaves the rescue-set-aside note to fix:publish where it posted it", async () => {
    published({ rescueNoted: true });
    put("fix", "rescue_ignored.json", { branch: RESCUE, movedPast: EARLIER });

    await run();

    expect(comments()).toEqual([]);
  });
});

describe("fix:conclude ends a run whose pre-flight did not decide", () => {
  /** The pre-flight died before it decided, so nothing is known to say; the label still comes off (#236). */
  it("takes agent:fix off and nothing else", async () => {
    await run(INPUTS({ REFUSED: "", GATE_RESULT: "failure", AGENT_RESULT: "skipped", MINT_OUTCOME: "success", DOWNLOAD_OUTCOME: "skipped", PUBLISH_OUTCOME: "skipped" }));

    expect(writes()).toEqual([`workflow removeLabel ${FIX_LABEL}`]);
    expect(labels()).toEqual([]);
  });

  /** A refusal was the gate's to say, and it took the label off. */
  it("writes nothing after a refusal", async () => {
    await run(INPUTS({ REFUSED: "true", AGENT_RESULT: "skipped" }));

    expect(made).toBeUndefined();
  });
});

describe("fix:conclude says how a stopped run ended, in the one pattern", () => {
  it("gives the agent's reason, and the plain retry", async () => {
    put("fix", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT_FAILED()));

    expect(comment()).toBe(
      `**\`agent:fix\` stopped:** The runner wrote this.\n\n[Workflow run](${RUN_URL}) · To try again, add \`agent:fix\`.\n`,
    );
    expect(writes()).toEqual(STOPPED_WRITES);
    expect(labels()).toEqual([BLOCKED_LABEL]);
  });

  /** Whatever the clock says: a reason is the runner's own word that it failed. */
  it("reads the agent's reason, not the clock, where there is one", async () => {
    put("fix", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT_FAILED({ TIMED_OUT: "true" })));

    expect(comment()).toContain("The runner wrote this.");
    expect(comment()).not.toMatch(/timed out|cancelled/);
  });

  it("says a run that failed with no reason gave none", async () => {
    await run(INPUTS(AGENT_FAILED()));

    expect(comment()).toMatch(STOPPED);
    expect(comment()).toContain("It stopped without giving a reason. The workflow run's log has the details.");
    expect(comment()).not.toContain("timed out");
  });

  /** `needs` may read a job that reached its limit as failed, and a killed runner wrote no reason. */
  it("says a run that failed at its limit with no reason timed out", async () => {
    await run(INPUTS(AGENT_FAILED({ TIMED_OUT: "true" })));

    expect(comment()).toContain("stopped:** It timed out after 30 minutes. The repository variable `AGENT_TIMEOUT_MINUTES` raises the limit.\n");
  });

  it("says a run that timed out did, naming the limit, and not its reason", async () => {
    put("fix", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS({ AGENT_RESULT: "cancelled", TIMED_OUT: "true", TIMEOUT_MINUTES: "45" }));

    expect(comment()).toContain("It timed out after 45 minutes.");
    expect(comment()).not.toMatch(/cancelled|The runner wrote this/);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a run stopped by hand was cancelled, not timed out", async () => {
    await run(INPUTS({ AGENT_RESULT: "cancelled" }));

    expect(comment()).toContain("stopped:** It was cancelled before it finished, by hand or by GitHub.\n");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("says a run cancelled in its gate was cancelled, though the agent's job never ran", async () => {
    await run(INPUTS({ GATE_RESULT: "cancelled", AGENT_RESULT: "skipped", PUBLISH_OUTCOME: "skipped" }));

    expect(comment()).toContain("cancelled");
    expect(comment()).not.toContain("timed out");
  });

  /** The gate claimed the run and then failed, its permission probe say: no reason reached this job. */
  it("says a run whose gate failed after claiming it, and handed on no reason, gave none", async () => {
    await run(INPUTS({ GATE_RESULT: "failure", AGENT_RESULT: "skipped", PUBLISH_OUTCOME: "skipped" }));

    expect(comment()).toContain("It stopped without giving a reason.");
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  /** The gate's reason file is on its own runner, so its job hands the sentence on as an output. */
  it("gives the reason a gate that failed after claiming the run handed on", async () => {
    const probe =
      "Couldn't add `agent:fix` to PR #7, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants `pull-requests: write`.";

    await run(INPUTS({ GATE_RESULT: "failure", GATE_REASON: `${probe}\n`, AGENT_RESULT: "skipped", PUBLISH_OUTCOME: "skipped" }));

    expect(comment()).toBe(`**\`agent:fix\` stopped:** ${probe}\n\n[Workflow run](${RUN_URL}) · To try again, add \`agent:fix\`.\n`);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  /** A gate that succeeded has nothing to say for itself, whatever its output holds. */
  it("reads the gate's reason only where the gate failed", async () => {
    put("fix", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT_FAILED({ GATE_REASON: "The gate wrote this." })));

    expect(comment()).toContain("The runner wrote this.");
    expect(comment()).not.toContain("The gate wrote this.");
  });

  it("says a run cancelled while it published was cancelled, though the agent's job succeeded", async () => {
    await run(INPUTS({ PUBLISH_OUTCOME: "cancelled" }));

    expect(comment()).toContain("cancelled");
    expect(comment()).not.toContain("timed out");
  });

  it("says a finished run whose publish a cancel skipped was cancelled", async () => {
    await run(INPUTS({ PUBLISH_OUTCOME: "skipped" }));

    expect(comment()).toContain("It was cancelled before it finished");
  });

  it("makes a reason written in lower case and with no full stop a sentence", async () => {
    put("fix", "failure_reason.txt", "the push was rejected\n");

    await run(INPUTS(AGENT_FAILED()));

    expect(comment()).toContain("stopped:** The push was rejected.\n");
    expect(comment()).toMatch(STOPPED);
  });

  it("writes every ending in the one pattern", async () => {
    for (const over of [AGENT_FAILED(), { AGENT_RESULT: "cancelled" as const }, AGENT_FAILED({ TIMED_OUT: "true" }), { MINT_OUTCOME: "failure" }]) {
      github.comments.length = 0;
      await run(INPUTS(over));
      expect(comment(), JSON.stringify(over)).toMatch(STOPPED);
    }
  });
});

/**
 * The reason files each sit where their producer wrote them (#468, #469):
 * `fix:publish`'s in its directory, the runner's and `fix:bundle`'s in the
 * hand-over. Each ending reads the first of the ones it can have, so none is
 * dropped for "no reason", and none is read on an ending it is not about.
 */
describe("fix:conclude gives the reason the ending calls for", () => {
  it("reads fix:publish's reason on a finished agent's run, ahead of any other", async () => {
    put("publish", "failure_reason.txt", "Couldn't add `agent:review` after this run, so no re-review was requested.\n");
    put("fix", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("stopped:** Couldn't add `agent:review` after this run");
    expect(comment()).not.toContain("The runner wrote this.");
  });

  it("says a publish that stopped with no reason gave none", async () => {
    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("It stopped without giving a reason.");
  });

  /** The mint wrote its reason where only a step in its own job reads it, so it is said here, in the resolver's words. */
  it("says the mint failed where it did, on a finished agent's run", async () => {
    await run(INPUTS({ LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "", MINT_OUTCOME: "failure", PUBLISH_OUTCOME: "skipped" }));

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

  it("says a hand-over that could not be fetched was lost, on a finished agent's run", async () => {
    await run(INPUTS({ DOWNLOAD_OUTCOME: "failure", PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain("stopped:** The agent finished, but what it handed over could not be fetched from its job");
  });

  it("reads fix:bundle's reason where the agent's job failed only at the bundle, whatever the clock says", async () => {
    put("bundle", "failure_reason.txt", "Couldn't bundle the agent's commits on `x` ahead of y.\n");

    await run(INPUTS(AGENT_FAILED({ TIMED_OUT: "true" })));

    expect(comment()).toContain("Couldn't bundle the agent's commits");
    expect(comment()).not.toContain("timed out");
  });

  it("reads fix:prepare's reason where the agent's job stopped before the runner, ahead of fix:bundle's", async () => {
    put("prepare", "failure_reason.txt", "Couldn't check whether an earlier run left commits on `agent/rescue/fix-7`, so this run stopped rather than start over without them.\n");
    put("bundle", "failure_reason.txt", "Couldn't bundle the agent's commits.\n");

    await run(INPUTS(AGENT_FAILED()));

    expect(comment()).toContain("Couldn't check whether an earlier run left commits on `agent/rescue/fix-7`");
    expect(comment()).not.toContain("bundle");
  });

  it("reads the runner's reason ahead of fix:bundle's", async () => {
    put("fix", "failure_reason.txt", "The runner wrote this.\n");
    put("bundle", "failure_reason.txt", "Couldn't bundle the agent's commits.\n");

    await run(INPUTS(AGENT_FAILED()));

    expect(comment()).toContain("The runner wrote this.");
    expect(comment()).not.toContain("bundle");
  });

  /** On an agent's run that stopped, publish's directory holds nothing it reads as a reason. */
  it("reads no publish reason on a run whose agent stopped", async () => {
    put("publish", "failure_reason.txt", "Publish wrote this.\n");
    put("fix", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT_FAILED()));

    expect(comment()).toContain("The runner wrote this.");
    expect(comment()).not.toContain("Publish wrote this.");
  });
});

/**
 * The retry depends on what the run left behind (#105): past the push, a
 * second fix run would answer threads this one answered, which stay open
 * until a review verifies them (#111).
 */
describe("fix:conclude gives the retry the ending calls for", () => {
  /** The push's `agent:review` add failed after the push landed. */
  it("asks for the review, not the label, after a run that pushed", async () => {
    bundled();
    published({ pushed: true, head: TIP });
    put("publish", "failure_reason.txt", "Couldn't add `agent:review` after this run, so no re-review was requested.\n");

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain(
      " · Its changes were pushed before it stopped, so running it again would repeat work. Fix the problem above, then add `agent:review`.\n",
    );
    expect(github.branches.has(RESCUE)).toBe(false);
    expect(writes()).toEqual(STOPPED_WRITES);
  });

  it("asks for the review that rules on its notes after a run that posted some", async () => {
    published({ notesPosted: true });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain(
      " · Its out-of-scope notes were posted before it stopped, so running it again would repeat work. Fix the problem above, then add `agent:review` to have them ruled on.\n",
    );
  });

  it("takes its label off and blocks, though the comment could not be posted", async () => {
    github.fails = (write) => write.type === "comment";

    await run(INPUTS(AGENT_FAILED()));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(labels()).toEqual([BLOCKED_LABEL]);
    expect(warnings()).toContain("::warning::Could not post the failure comment on PR #7.");
  });

  /** The loop's one order (#236): every result posted, then the run's own label off, then the label naming the next step. */
  it("comments, then takes agent:fix off, then blocks, however it stopped", async () => {
    for (const over of [AGENT_FAILED(), { AGENT_RESULT: "cancelled" as const }, { PUBLISH_OUTCOME: "failure" }]) {
      bundled();
      await run(INPUTS(over));
      expect(writes().slice(-3), JSON.stringify(over)).toEqual(STOPPED_WRITES);
    }
  });
});

/**
 * Rescue (#303): a run that stopped with commits the pull request does not
 * have keeps them on a side branch with a fixed name, never the pull
 * request's, and the comment names it.
 */
describe("fix:conclude rescues a stopped run's commits", () => {
  it("pushes the agent's commits to the rescue branch with the loop's token, before the comment that names it", async () => {
    bundled();

    await run(INPUTS(AGENT_FAILED({ AGENT_RESULT: "cancelled", TIMED_OUT: "true" })));

    expect(writes()).toEqual([`loop pushRef refs/heads/${RESCUE}`, ...STOPPED_WRITES]);
    expect(made?.writes[0]?.args).toEqual([{ ref: `refs/heads/${RESCUE}`, commit: TIP, lease: { absent: true } }]);
    expect(github.branches.get(RESCUE)).toBe(TIP);
    expect(github.branches.get(BRANCH)).toBe(HEAD);
    expect(comment()).toContain("It timed out after 30 minutes.");
    expect(comment()).toContain(" · Its commits so far are saved on `agent/rescue/fix-7`. To resume from them, add `agent:fix`.\n");
    expect(git.calls).toEqual([`verifyBundle ${bundlePath()}`, `isAncestor ${HEAD} ${TIP}`]);
  });

  /** A run that resumed from a rescue and stopped again holds everything the rescue held, so its own replaces it, leased on it. */
  it("overwrites an earlier rescue, leased on it as it read it", async () => {
    bundled();
    github.branches.set(RESCUE, EARLIER);

    await run(INPUTS(AGENT_FAILED()));

    expect(made?.writes[0]?.args).toEqual([{ ref: `refs/heads/${RESCUE}`, commit: TIP, lease: { tip: EARLIER } }]);
    expect(github.branches.get(RESCUE)).toBe(TIP);
  });

  /** Whatever moved the rescue between the read and the push is not lost silently. */
  it("rescues nothing over a rescue that moved, and still comments", async () => {
    bundled();
    github.branches.set(RESCUE, EARLIER);
    reader = { ...reader, branchTip: async () => HEAD };

    await run(INPUTS(AGENT_FAILED()));

    expect(github.branches.get(RESCUE)).toBe(EARLIER);
    expect(comment()).not.toContain("agent/rescue/");
    expect(writes().slice(1)).toEqual(STOPPED_WRITES);
    expect(warnings().some((line) => line.includes("nothing was rescued"))).toBe(true);
  });

  /** The push's lease lost: nothing reached the pull request, so the agent's commits are rescued. */
  it("rescues the commits of a run whose push lost its lease", async () => {
    bundled();
    published();
    put("publish", "failure_reason.txt", `\`${BRANCH}\` moved while this run worked, so the agent's commits were not pushed over what is there now.\n`);

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(github.branches.get(RESCUE)).toBe(TIP);
    expect(comment()).toBe(
      `**\`agent:fix\` stopped:** \`${BRANCH}\` moved while this run worked, so the agent's commits were not pushed over what is there now.\n\n[Workflow run](${RUN_URL}) · Its commits so far are saved on \`${RESCUE}\`. To resume from them, add \`agent:fix\`.\n`,
    );
  });

  it("names the rescue beside a retry that names something else", async () => {
    bundled();
    published({ notesPosted: true });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toContain(
      "then add `agent:review` to have them ruled on. Its commits so far are saved on `agent/rescue/fix-7`, and adding `agent:fix` resumes from them.\n",
    );
  });

  it("pushes nothing where the run made no commits, and says nothing of a rescue", async () => {
    await run(INPUTS(AGENT_FAILED()));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(github.branches.has(RESCUE)).toBe(false);
    expect(comment()).not.toContain("agent/rescue/");
    expect(git.calls).toEqual([]);
  });

  /** Only where nothing was pushed to the pull request: the commits are on it already. */
  it("rescues nothing from a run that pushed before it stopped", async () => {
    bundled();
    published({ pushed: true, head: TIP });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(git.calls).toEqual([]);
  });

  /** Checked as the push is, and a bundle that fails a check is not rescued, nor costs the run its comment. */
  it.each([
    ["damaged", [] as BundleHead[], "verify", "The agent's commits arrived damaged or incomplete, so nothing was rescued."],
    [
      "of another branch",
      [{ ref: "refs/heads/main", commit: TIP }],
      "heads",
      `The agent's commits arrived on a branch other than \`${BRANCH}\`, or beside other branches, so nothing was rescued.`,
    ],
    [
      "beside another branch",
      [
        { ref: `refs/heads/${BRANCH}`, commit: TIP },
        { ref: "refs/heads/main", commit: TIP },
      ],
      "heads",
      `The agent's commits arrived on a branch other than \`${BRANCH}\`, or beside other branches, so nothing was rescued.`,
    ],
    [
      "whose commit the checkout cannot place",
      [{ ref: `refs/heads/${BRANCH}`, commit: "d".repeat(40) }],
      "history",
      "Couldn't tell whether the agent's commits build on the PR's head as this run found it, so nothing was rescued",
    ],
  ] as const)("rescues nothing from a bundle %s", async (_, heads, broken, warning) => {
    bundled();
    git = broken === "verify" ? fakeGit({}) : holding(heads);

    await run(INPUTS(AGENT_FAILED()));

    expect(github.branches.has(RESCUE)).toBe(false);
    expect(writes()).toEqual(STOPPED_WRITES);
    expect(comment()).not.toContain("agent/rescue/");
    expect(warnings().some((line) => line.startsWith(`::warning::${warning}`))).toBe(true);
  });

  it("rescues nothing that does not build on the head the run started from", async () => {
    bundled();
    git = fakeGit({ bundles: { [bundlePath()]: [{ ref: `refs/heads/${BRANCH}`, commit: TIP }] }, history: { [TIP]: [TIP] } });

    await run(INPUTS(AGENT_FAILED()));

    expect(github.branches.has(RESCUE)).toBe(false);
    expect(warnings()).toContain("::warning::The agent's commits don't build on the PR's head as this run found it, so nothing was rescued.");
  });

  /** A failed mint leaves nothing to push with: the rescue is skipped with a warning, and the comment says so. */
  it("says the commits were not saved where the mint failed", async () => {
    bundled();
    put("fix", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT_FAILED({ MINT_OUTCOME: "failure", LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "", PUBLISH_OUTCOME: "skipped" })));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(github.branches.has(RESCUE)).toBe(false);
    expect(comment()).toContain(
      " · To try again, add `agent:fix`. Its commits were not saved on `agent/rescue/fix-7`: the loop's token was not minted, so there was nothing to push them with.\n",
    );
    expect(warnings()).toContain("::warning::The loop's token was not minted, so the agent's commits were not saved on agent/rescue/fix-7.");
  });

  it("rescues nothing, and still comments, where the rescue could not be read", async () => {
    bundled();
    reader = {
      ...reader,
      branchTip: async () => {
        throw new Error("GitHub is down");
      },
    };

    await run(INPUTS(AGENT_FAILED()));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(warnings()).toContain("::warning::Could not read agent/rescue/fix-7, so the agent's commits were not saved there: GitHub is down");
  });
});

describe("fix:conclude says a rescue was set aside where fix:publish did not", () => {
  /** A mint that failed skipped publish, whose first write it is. */
  it("posts the note first, with the workflow token, where publish did not run", async () => {
    put("fix", "rescue_ignored.json", { branch: RESCUE, movedPast: EARLIER });

    await run(INPUTS({ MINT_OUTCOME: "failure", LOOP_TOKEN: "", PUBLISH_OUTCOME: "skipped" }));

    expect(writes()).toEqual(["workflow comment", ...STOPPED_WRITES]);
    expect(comments()[0]).toBe(ignoredNote(FIX_LABEL, RESCUE, "this pull request's head"));
  });

  /**
   * On a stopped run publish reads the pull request and checks the whole
   * hand-over before its first write: a read GitHub fails, or a file it
   * refuses, ends it before the note, so the note is said here.
   */
  it("posts the note where publish failed before posting it", async () => {
    put("fix", "rescue_ignored.json", { branch: RESCUE, movedPast: EARLIER });
    put("publish", "failure_reason.txt", "Could not read PR #7's review threads from GitHub, so nothing was pushed or posted: 502\n");

    await run(INPUTS(AGENT_FAILED({ PUBLISH_OUTCOME: "failure" })));

    expect(writes()).toEqual(["workflow comment", ...STOPPED_WRITES]);
    expect(comments()[0]).toBe(ignoredNote(FIX_LABEL, RESCUE, "this pull request's head"));
  });

  it("posts the note where publish ran but GitHub refused it", async () => {
    put("fix", "rescue_ignored.json", { branch: RESCUE, movedPast: EARLIER });
    published({ rescueNoted: false });

    await run();

    expect(writes()).toEqual(["workflow comment", `workflow removeLabel ${FIX_LABEL}`]);
    expect(comments()).toEqual([ignoredNote(FIX_LABEL, RESCUE, "this pull request's head")]);
  });

  /** The runner's files are the agent's to write: one that does not read is said, and the run still ends. */
  it("posts no note naming another branch, and still ends the run", async () => {
    put("fix", "rescue_ignored.json", { branch: "main", movedPast: EARLIER });
    put("fix", "failure_reason.txt", "The runner wrote this.\n");

    await run(INPUTS(AGENT_FAILED({ PUBLISH_OUTCOME: "skipped" })));

    expect(writes()).toEqual(STOPPED_WRITES);
    expect(comment()).toContain("It stopped without giving a reason.");
    expect(warnings().some((line) => /rescue_ignored\.json `branch` is "main"/.test(line))).toBe(true);
  });
});

describe("fix:conclude writes within its limits", () => {
  /** The rescue push, the note and the failure comment, `agent:fix` off and `agent:blocked` on. */
  it("asks for the writes it can make and no more", async () => {
    await run(INPUTS(AGENT_FAILED()));

    expect(asked).toEqual({ pushRef: 1, comment: 2, removeLabel: 1, addLabel: 1 });
  });

  it("reads none of the runner's files but the two it declares", async () => {
    put("fix", "thread_outcomes.json", "not json");
    put("fix", "nothing_to_do.txt", "");

    await run(INPUTS(AGENT_FAILED()));

    expect(writes()).toEqual(STOPPED_WRITES);
  });
});
