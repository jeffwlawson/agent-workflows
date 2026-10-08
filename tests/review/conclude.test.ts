import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { conclude, MINT_FAILED } from "../../review/conclude.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { FIX_ROUND_STATUS, VERDICT_CONTEXT } from "../../shared/record.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `review:conclude` (#419), called the way the CLI calls it: its declared
 * inputs, a directory holding what `review:publish` wrote, a fake GitHub
 * reader, and the engine's writers over a fake GitHub, sharing one log. What
 * is asserted is what it did to the record: the writes it attempted, in what
 * order and with which token, the log, and `ended.json`.
 *
 * The scenarios are the retired step tests' (`tests/failure-step.test.ts`'s
 * review cases, `tests/trigger-label-step.test.ts`'s, the ready mark in
 * `tests/loop-token-step.test.ts`, and the posting job's hand-off assertions
 * in `tests/workflows.test.ts`), carried over by behaviour, and prototype
 * #399's: success, a fix round, a refused review, the head moved, a failed
 * hand-off and a failed mint.
 */

const PR = 7;
const SHA = "c".repeat(40);
const PUSHED = "e".repeat(40);
const RUN_URL = "https://github.com/o/r/actions/runs/42";
const REVIEW_URL = "https://github.com/o/r/pull/7#pullrequestreview-1";
const LOOP = "github-actions[bot]";

let dir: string;
let github: FakeGitHub;
let files: Map<string, unknown>;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let logged: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "conclude-"));
  github = fakeGitHub([{ number: PR, nodeId: "PR_node7", headSha: SHA, draft: true, labels: ["agent:review", "agent:blocked"] }]);
  files = new Map();
  made = undefined;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What publish wrote, as it writes it: `published.json` the moment the review is posted. */
const publishedReview = (url = REVIEW_URL): void => fs.writeFileSync(path.join(dir, "published.json"), JSON.stringify({ reviewUrl: url }));
const publishFailed = (reason: string): void => fs.writeFileSync(path.join(dir, "failure_reason.txt"), reason);

/** The statuses publish posted on the reviewed commit, as the loop's account, newest first. */
const verdictPosted = (over: { fixRound?: boolean; url?: string; sha?: string } = {}): void => {
  const url = over.url ?? REVIEW_URL;
  github.statuses.set(over.sha ?? SHA, [
    ...(over.fixRound === false ? [] : [{ context: FIX_ROUND_STATUS.context, state: "success", targetUrl: url, description: "", creator: LOOP }]),
    { context: VERDICT_CONTEXT, state: "failure", targetUrl: url, description: "", creator: LOOP },
  ]);
};

type Inputs = Parameters<typeof conclude>[0];

/** A review that finished and posted, on an ordinary pull request, approving. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(dir, "out"),
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "app",
  PR_NUMBER: String(PR),
  BRANCH: "agent/issue-12-do-the-thing",
  REVIEW_RESULT: "success",
  PROCEED: "true",
  REFUSAL: "",
  BLOCKED: "",
  REVIEWED_SHA: SHA,
  VERDICT: "approval recommended",
  FIX_ROUND: "false",
  ROUND: "",
  FAILURE_REASON: "",
  REFUSAL_REASON: "",
  TIMED_OUT: "false",
  TIMEOUT_MINUTES: "20",
  MINT_OUTCOME: "success",
  DOWNLOAD_OUTCOME: "success",
  PUBLISH_OUTCOME: "success",
  PUBLISH_DIR: dir,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "42",
  ...over,
});

/** A changes-recommended review that asked for a fix round, as publish leaves it. */
const FIX_ROUND = { VERDICT: "changes recommended", FIX_ROUND: "true" } as const satisfies Partial<Inputs>;

/** The review job's outcome where it did not finish, as the posting job reads it. */
const reviewEnded = (result: "failure" | "cancelled", over: Partial<Inputs> = {}): Partial<Inputs> => ({
  REVIEW_RESULT: result,
  VERDICT: "",
  FIX_ROUND: "",
  MINT_OUTCOME: "skipped",
  DOWNLOAD_OUTCOME: "skipped",
  PUBLISH_OUTCOME: "skipped",
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["review:conclude"]["outputs"]> = {
    writers: (limits) => {
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: fakeReader(github).reader,
    outputs: {
      writeJson: (name, value) => files.set(name, value),
      writeText: (name, value) => files.set(name, value),
      appendLine: () => {},
    },
  };
  try {
    await conclude(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

/** Every write attempted, as `<token> <type> <first argument after the target>`. */
const writes = (): string[] =>
  (made?.writes ?? []).map((w) => {
    const [first, second] = w.args;
    if (w.type === "setCommitStatus") {
      const status = first as { context: string; state: string };
      return `${w.token} setCommitStatus ${status.context}=${status.state}`;
    }
    return `${w.token} ${w.type}${typeof second === "string" && w.type !== "comment" ? ` ${second}` : ""}`;
  });
const comments = () => github.comments.map((c) => c.body);
const labels = () => github.pullRequests.get(PR)?.labels ?? [];
const ended = () => files.get("ended.json");
const logLines = () => (made?.lines ?? []).map((line) => JSON.parse(line) as Record<string, unknown>);

describe("review:conclude ends a refused review", () => {
  /**
   * The pre-flight's refusal, which the review job could decide and not say
   * (#257). The comment, then this run's label off, then `agent:blocked`
   * where a maintainer has to act (#236).
   */
  it("says why it didn't run, takes its label off, then blocks", async () => {
    await run(INPUTS({ PROCEED: "false", REFUSAL: "PR #7 is a draft.", BLOCKED: "true", REVIEWED_SHA: "" }));

    expect(writes()).toEqual(["workflow comment", "workflow removeLabel agent:review", "workflow addLabel agent:blocked"]);
    expect(comments()).toEqual(["**`agent:review` didn't run:** PR #7 is a draft."]);
    expect(labels()).toEqual(["agent:blocked"]);
    expect(ended()).toEqual({ moved: false });
  });

  /** A closed pull request gets the note alone (#253): there is nothing left for anyone to act on. */
  it("adds no block where the refusal needs no maintainer", async () => {
    await run(INPUTS({ PROCEED: "false", REFUSAL: "PR #7 is closed.", BLOCKED: "false" }));

    expect(writes()).toEqual(["workflow comment", "workflow removeLabel agent:review"]);
  });

  /** A failed comment would otherwise leave the label on with nothing behind it. */
  it("still takes its label off where the comment fails", async () => {
    github.fails = (write) => write.type === "comment";

    await run(INPUTS({ PROCEED: "false", REFUSAL: "PR #7 is a draft.", BLOCKED: "true" }));

    expect(labels()).toEqual(["agent:blocked"]);
    expect(logged).toContain("::warning::Could not post the refusal comment on PR #7.");
  });

  /** A review cancelled before its gate decided: there is nothing to say, and the label still comes off. */
  it("takes only its label off where the review was cancelled before deciding", async () => {
    await run(INPUTS({ ...reviewEnded("cancelled"), PROCEED: "", REVIEWED_SHA: "" }));

    expect(writes()).toEqual(["workflow removeLabel agent:review"]);
    expect(github.statuses.size).toBe(0);
  });

  /**
   * A gate that failed before it decided (#420), as one whose package would
   * not install, is a run that stopped, and says so: a label that vanished
   * with nothing said is the silent failure the convention exists against.
   * No verdict, since no commit was settled.
   */
  it("says a review that failed before deciding stopped, with no verdict, and blocks", async () => {
    await run(INPUTS({ ...reviewEnded("failure", { FAILURE_REASON: "PR_NUMBER is \"x\", which is not a pull request number." }), PROCEED: "", REVIEWED_SHA: "" }));

    expect(writes()).toEqual(["workflow comment", "workflow removeLabel agent:review", "workflow addLabel agent:blocked"]);
    expect(github.comments[0]?.body).toContain('**`agent:review` stopped:** PR_NUMBER is "x", which is not a pull request number.');
    expect(github.statuses.size).toBe(0);
    expect(logged).toContain("::warning::The review job named no reviewed commit, so no error verdict was posted.");
  });

  it("says one that failed before deciding without a reason stopped without giving one", async () => {
    await run(INPUTS({ ...reviewEnded("failure"), PROCEED: "", REVIEWED_SHA: "" }));

    expect(github.comments[0]?.body).toContain("It stopped without giving a reason.");
  });
});

describe("review:conclude ends a review that did not finish", () => {
  /** One pattern for every run that stopped (#253): the reason as a sentence, the run, and what to do. */
  const PATTERN =
    /^\*\*`agent:review` stopped:\*\* [A-Z][^\n]*[.!?]\n\n\[Workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\) · To try again, add `agent:review`\.\n$/;

  /**
   * The error verdict, then the comment, then the label off, then the block
   * (#220, #236, #257): a status is per commit and per context, so a review
   * that died half way reads like an approval until something replaces it.
   */
  it("posts the error verdict, then comments, then takes its label off, then blocks", async () => {
    await run(INPUTS(reviewEnded("failure", { FAILURE_REASON: "The agent stopped." })));

    expect(writes()).toEqual([
      `workflow setCommitStatus ${VERDICT_CONTEXT}=error`,
      "workflow comment",
      "workflow removeLabel agent:review",
      "workflow addLabel agent:blocked",
    ]);
    expect(github.statuses.get(SHA)).toEqual([{ context: VERDICT_CONTEXT, state: "error", targetUrl: RUN_URL, description: expect.any(String), creator: "workflow" }]);
    const description = (made?.writes[0]?.args[0] as { description: string }).description;
    expect(description).toBe("The review run did not finish, so there's no verdict. Check the run, then re-add agent:review.");
    // GitHub refuses a status description holding a 4-byte character (#121).
    expect([...description].filter((ch) => (ch.codePointAt(0) ?? 0) > 0xffff)).toEqual([]);
    expect(comments()).toEqual([
      `**\`agent:review\` stopped:** The agent stopped.\n\n[Workflow run](${RUN_URL}) · To try again, add \`agent:review\`.\n`,
    ]);
    expect(labels()).toEqual(["agent:blocked"]);
    expect(ended()).toEqual({ moved: false });
  });

  it("says a review that reached its limit timed out, naming the limit", async () => {
    await run(INPUTS(reviewEnded("cancelled", { TIMED_OUT: "true", TIMEOUT_MINUTES: "35" })));

    expect(comments()[0]).toMatch(PATTERN);
    expect(comments()[0]).toContain(
      "It timed out after 35 minutes. The repository variable `AGENT_REVIEW_TIMEOUT_MINUTES` raises the review's own time, which its CI wait is added to.",
    );
    expect(labels()).toContain("agent:blocked");
  });

  it("says a review stopped by hand was cancelled, not timed out, and reads no reason", async () => {
    await run(INPUTS(reviewEnded("cancelled", { FAILURE_REASON: "Something the runner wrote." })));

    expect(comments()[0]).toContain("It was cancelled before it finished, by hand or by GitHub.");
    expect(comments()[0]).not.toContain("timed out");
    expect(comments()[0]).not.toContain("Something the runner wrote.");
  });

  it("makes the reason a sentence, and says when there was none", async () => {
    await run(INPUTS(reviewEnded("failure", { FAILURE_REASON: "the push was rejected" })));
    expect(comments()[0]).toContain("stopped:** The push was rejected.\n");
    expect(comments()[0]).toMatch(PATTERN);

    github.comments.length = 0;
    await run(INPUTS(reviewEnded("failure")));
    expect(comments()[0]).toContain("It stopped without giving a reason. The workflow run's log has the details.");
    expect(comments()[0]).toMatch(PATTERN);
  });

  /**
   * The other pattern (#253): a variable the review refused before it
   * reviewed anything did not run, rather than stopped, and is still blocked.
   */
  it("says a review that refused a variable didn't run, and still blocks", async () => {
    const refusal =
      "The repository variable `AGENT_MAX_FIX_ROUNDS` is `abc`. It must be a whole number (0 or more), or delete it to use the default of 3. Then add `agent:review` again.";
    await run(INPUTS(reviewEnded("failure", { REFUSAL_REASON: refusal, FAILURE_REASON: "Also this." })));

    expect(comments()).toEqual([`**\`agent:review\` didn't run:** ${refusal}\n`]);
    expect(labels()).toContain("agent:blocked");
  });

  it("finishes, and still takes its label off and blocks, where the verdict and the comment fail", async () => {
    github.fails = (write) => write.type === "setCommitStatus" || write.type === "comment";

    await run(INPUTS(reviewEnded("failure")));

    expect(labels()).toEqual(["agent:blocked"]);
    expect(logged.some((line) => line.startsWith(`::warning::Could not post the failed \`${VERDICT_CONTEXT}\` verdict for ${SHA}.`))).toBe(true);
    expect(logged).toContain("::warning::Could not post the failure comment on PR #7.");
    expect(logLines().at(-1)).toMatchObject({ ended: "finished" });
  });
});

describe("review:conclude ends a review whose posting did not finish", () => {
  /**
   * A failed mint skips publish, so nothing is posted, and nothing is written
   * with the loop's token, which there is none of (prototype #399's 08).
   */
  it("reports a mint that failed, with the workflow token alone", async () => {
    await run(INPUTS({ LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "", MINT_OUTCOME: "failure", DOWNLOAD_OUTCOME: "success", PUBLISH_OUTCOME: "skipped" }));

    expect(writes()).toEqual([
      `workflow setCommitStatus ${VERDICT_CONTEXT}=error`,
      "workflow comment",
      "workflow removeLabel agent:review",
      "workflow addLabel agent:blocked",
    ]);
    expect(comments()[0]).toContain(`stopped:** ${MINT_FAILED}\n`);
    expect(ended()).toEqual({ moved: false });
  });

  /** The mint's reason is the resolver's, which writes it where only its own job can read it. */
  it("says the mint's reason in the resolver's words", () => {
    const action = parse(fs.readFileSync(path.join(".github", "actions", "loop-token", "action.yml"), "utf8")) as {
      runs: { steps: { name?: string; run?: string }[] };
    };
    const say = action.runs.steps.find((step) => step.name === "Say why the App's token was not minted");

    expect(say?.run).toContain(`printf '%s\\n' "${MINT_FAILED.replace(/`/g, "\\`")}"`);
  });

  /** Prototype #399's 03: a review GitHub refused, and the reason publish wrote. */
  it("reports publish's reason where it stopped", async () => {
    publishFailed("GitHub refused the review, so it was not posted.\n");

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(writes()[0]).toBe(`workflow setCommitStatus ${VERDICT_CONTEXT}=error`);
    expect(comments()).toEqual([
      `**\`agent:review\` stopped:** GitHub refused the review, so it was not posted.\n\n[Workflow run](${RUN_URL}) · To try again, add \`agent:review\`.\n`,
    ]);
    expect(labels()).toEqual(["agent:blocked"]);
    expect(ended()).toEqual({ moved: false });
  });

  it("says publish gave no reason where it wrote none", async () => {
    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    expect(comments()[0]).toContain("It stopped without giving a reason.");
  });

  /** Cancelled is not failed (#220): what wrote a reason was stopped, not failing. */
  it.each([
    { MINT_OUTCOME: "cancelled" },
    { DOWNLOAD_OUTCOME: "cancelled" },
    { DOWNLOAD_OUTCOME: "skipped", PUBLISH_OUTCOME: "skipped" },
    { PUBLISH_OUTCOME: "cancelled" },
  ] as const)("says a posting cancelled at %o was cancelled", async (outcomes) => {
    publishFailed("Half a reason.");

    await run(INPUTS(outcomes));

    expect(comments()[0]).toContain("It was cancelled before it finished, by hand or by GitHub.");
    expect(comments()[0]).not.toContain("Half a reason.");
  });

  it("says the hand-over could not be fetched where the download failed", async () => {
    await run(INPUTS({ DOWNLOAD_OUTCOME: "failure", PUBLISH_OUTCOME: "skipped" }));

    expect(comments()[0]).toContain("what it wrote for posting could not be fetched");
  });

  it("refuses a published.json it cannot read, before its first write", async () => {
    fs.writeFileSync(path.join(dir, "published.json"), JSON.stringify({ reviewUrl: "javascript:alert(1)" }));

    await expect(run()).rejects.toThrow(/^review:publish's published\.json `reviewUrl` is "javascript:alert\(1\)", where a link was expected\.$/);
    expect(writes()).toEqual([]);
  });

  it("refuses a publish that finished and handed over no URL, before its first write", async () => {
    await expect(run()).rejects.toThrow(/handed over no `published\.json`/);
    expect(writes()).toEqual([]);
  });
});

describe("review:conclude ends a posted review", () => {
  beforeEach(() => publishedReview());

  /**
   * In the loop's one order: the block an earlier run left off, the ready
   * mark, then this run's own label, last but for the hand-off, so `fix` and
   * `update-branch`, which wait on it, start only after the review posted.
   */
  it("clears the block, marks the pull request ready, then takes its label off", async () => {
    await run();

    expect(writes()).toEqual(["workflow removeLabel agent:blocked", "loop markReadyForReview", "workflow removeLabel agent:review"]);
    expect(labels()).toEqual([]);
    expect(github.pullRequests.get(PR)?.draft).toBe(false);
    expect(github.statuses.size).toBe(0);
    expect(github.comments).toEqual([]);
    expect(ended()).toEqual({ moved: false, reviewUrl: REVIEW_URL });
  });

  /** The loop's token: the workflow token cannot mark a draft ready, and a warning keeps it visible. */
  it.each(["app", "pat", "workflow"])("marks it ready with the loop's token (source %s), and warns where that fails", async (source) => {
    github.fails = (write) => write.type === "markReadyForReview";

    await run(INPUTS({ LOOP_TOKEN_SOURCE: source }));

    expect(writes()).toContain("loop markReadyForReview");
    expect(logged.some((line) => line.startsWith("::warning::Could not mark PR #7 ready for review."))).toBe(true);
    expect(labels()).toEqual([]);
  });

  it.each([
    ["a fix round is about to start", { ...FIX_ROUND }, false],
    ["a PRD PR's slice round approves", { BRANCH: "agent/prd-14-a-prd", ROUND: "slice" }, false],
    ["a PRD PR's final review recommends changes", { BRANCH: "agent/prd-14-a-prd", ROUND: "final", VERDICT: "changes recommended" }, false],
    ["a PRD PR's final review approves", { BRANCH: "agent/prd-14-a-prd", ROUND: "final" }, true],
    ["a review needs a closer look", { VERDICT: "needs a closer look" }, true],
    ["a review recommends changes with no round", { VERDICT: "changes recommended", FIX_ROUND: "false" }, true],
  ] as const)("marks it ready or not where %s", async (_case, over, ready) => {
    verdictPosted();

    await run(INPUTS(over));

    expect(writes().includes("loop markReadyForReview")).toBe(ready);
  });
});

describe("review:conclude asks for the review again where the head moved", () => {
  beforeEach(() => {
    publishedReview();
    Object.assign(github.pullRequests.get(PR) ?? {}, { headSha: PUSHED });
  });

  /**
   * The acceptance case: a push while the run worked moved the head, and a
   * label added then fired nothing, since it was on. So it asks again,
   * removed and then added, the add with the loop's token so it starts a run.
   */
  it.each(["app", "pat"])("re-adds agent:review with the loop's token (source %s)", async (source) => {
    await run(INPUTS({ LOOP_TOKEN_SOURCE: source }));

    expect(writes().slice(-2)).toEqual(["workflow removeLabel agent:review", "loop addLabel agent:review"]);
    expect(labels()).toEqual(["agent:review"]);
    expect(ended()).toEqual({ moved: true, reviewUrl: REVIEW_URL });
  });

  /**
   * Another trigger label is a run queued in the group, which a request now
   * would cancel while pending, leaving its label on with no run behind it.
   * Read after this run took its own label off, so an `agent:review` there is
   * one a human or another run added meanwhile.
   */
  it.each(["agent:fix", "agent:update-branch", "agent:review"])("asks for nothing, and leaves a queued run alone, where %s is on", async (other) => {
    const { reader } = fakeReader(github);
    const io: CommandIo<(typeof COMMANDS)["review:conclude"]["outputs"]> = {
      writers: (limits) => {
        made = fakeWriters(github, ["loop", "workflow"] as const, limits);
        return made.writers;
      },
      github: { ...reader, pullRequest: async (n) => ({ ...(await reader.pullRequest(n)), labels: [other] }) },
      outputs: { writeJson: (name, value) => files.set(name, value), writeText: () => {}, appendLine: () => {} },
    };

    await conclude(INPUTS(), io);

    expect(writes().filter((w) => w.includes("addLabel"))).toEqual([]);
    expect(github.comments).toEqual([]);
    expect(logged.some((line) => line.startsWith(`::notice::PR #7 moved on to ${PUSHED}`) && line.includes(`carries ${other}`))).toBe(true);
    expect(ended()).toEqual({ moved: true, reviewUrl: REVIEW_URL });
  });

  /** A label added with `GITHUB_TOKEN` starts nothing, so it says so instead of adding one. */
  it("says so on the pull request rather than adding a label that starts nothing, with neither the App nor the PAT", async () => {
    await run(INPUTS({ LOOP_TOKEN_SOURCE: "workflow" }));

    expect(writes().filter((w) => w.includes("addLabel"))).toEqual([]);
    expect(writes().at(-1)).toBe("workflow comment");
    expect(comments()[0]).toContain(PUSHED);
    expect(comments()[0]).toContain("Add `agent:review` by hand");
    expect(ended()).toEqual({ moved: true, reviewUrl: REVIEW_URL });
  });

  /** The verdict is about a commit the pull request has left, so no round starts off it. */
  it("starts no fix round", async () => {
    verdictPosted();

    await run(INPUTS(FIX_ROUND));

    expect(writes().filter((w) => w.includes("agent:fix"))).toEqual([]);
    expect(labels()).toEqual(["agent:review"]);
  });

  it.each([
    ["the pull request is closed", () => Object.assign(github.pullRequests.get(PR) ?? {}, { state: "closed" })],
    ["the pull request cannot be read", () => github.pullRequests.clear()],
  ] as const)("says nothing about the head where %s", async (_case, arrange) => {
    arrange();

    await run();

    expect(writes().filter((w) => w.includes("addLabel"))).toEqual([]);
    expect(ended()).toEqual({ moved: false, reviewUrl: REVIEW_URL });
  });

  it("asks for nothing after a review that did not finish", async () => {
    await run(INPUTS(reviewEnded("failure")));

    expect(writes().filter((w) => w.includes("agent:review"))).toEqual(["workflow removeLabel agent:review"]);
    expect(ended()).toEqual({ moved: false });
  });
});

describe("review:conclude starts the automatic fix round", () => {
  beforeEach(() => publishedReview());

  /**
   * Prototype #399's 01: the round the review asked for, `agent:fix`
   * removed then added with the loop's token, after `agent:review` came off,
   * so the timeline never shows the next step's label beside this run's.
   */
  it("adds agent:fix with the loop's token, after its own label came off", async () => {
    verdictPosted();

    await run(INPUTS(FIX_ROUND));

    expect(writes()).toEqual([
      "workflow removeLabel agent:blocked",
      "workflow removeLabel agent:review",
      "loop removeLabel agent:fix",
      "loop addLabel agent:fix",
    ]);
    expect(labels()).toEqual(["agent:fix"]);
    expect(github.pullRequests.get(PR)?.draft).toBe(true);
    expect(ended()).toEqual({ moved: false, reviewUrl: REVIEW_URL });
    expect(logLines().at(-1)).toMatchObject({ ended: "finished" });
  });

  it("adds nothing where agent:fix is already on: a round is starting anyway", async () => {
    verdictPosted();
    github.pullRequests.get(PR)?.labels.push("agent:fix");

    await run(INPUTS(FIX_ROUND));

    expect(writes().filter((w) => w.includes("agent:fix"))).toEqual([]);
    expect(github.comments).toEqual([]);
  });

  /** A newer verdict on the head stands, and this review's round is not started over it. */
  it("adds nothing where a newer verdict stands on the head", async () => {
    verdictPosted();
    github.statuses.get(SHA)?.unshift({ context: VERDICT_CONTEXT, state: "success", targetUrl: "https://github.com/o/r/pull/7#pullrequestreview-9", description: "", creator: LOOP });

    await run(INPUTS(FIX_ROUND));

    expect(writes().filter((w) => w.includes("agent:fix"))).toEqual([]);
    expect(github.comments).toEqual([]);
  });

  /** Only the loop's own statuses count (§4.1): a verdict anyone else set is not this one, nor newer. */
  it("reads only the loop's statuses", async () => {
    verdictPosted();
    github.statuses.get(SHA)?.unshift({ context: VERDICT_CONTEXT, state: "success", targetUrl: "https://elsewhere.invalid", description: "", creator: "someone" });

    await run(INPUTS(FIX_ROUND));

    expect(labels()).toEqual(["agent:fix"]);
  });

  /**
   * Say only what will happen (#297): every arm that does not start the round
   * it should says so on the pull request, with the loop's token, marks it
   * ready, since it is the human's turn now, and ends red.
   */
  it.each([
    [
      "the verdict is not on the head",
      () => github.statuses.clear(),
      `the verdict that asked for it is not on the head commit \`${SHA}\``,
    ],
    [
      "the fix round's status is not on the head",
      () => verdictPosted({ fixRound: false }),
      `the \`${FIX_ROUND_STATUS.context}\` status that counts it against the fix-round budget is not on the head commit \`${SHA}\`, and a round the budget cannot see is one nothing bounds`,
    ],
    [
      "adding agent:fix fails",
      () => {
        verdictPosted();
        github.fails = (write, call) => write.type === "addLabel" && call === "POST labels";
      },
      "adding `agent:fix` failed, and GitHub's reply is in the workflow run's log",
    ],
  ] as const)("says no round started, marks it ready and ends red where %s", async (_case, arrange, why) => {
    arrange();

    await expect(run(INPUTS(FIX_ROUND))).rejects.toThrow(`No fix round started on PR #7: ${why}.`);

    expect(github.comments).toEqual([
      { token: "loop", issue: PR, body: `No automatic fix round started: ${why}. Add \`agent:fix\` to start one by hand.` },
    ]);
    expect(writes().slice(-2)).toEqual(["loop comment", "loop markReadyForReview"]);
    expect(github.pullRequests.get(PR)?.draft).toBe(false);
    // The review is posted, so this is a failed hand-off and not a failed
    // review: no error verdict, no block, and the advance job still reads both.
    expect(writes().filter((w) => w.includes("setCommitStatus") || w.includes("agent:blocked") && w.includes("addLabel"))).toEqual([]);
    expect(ended()).toEqual({ moved: false, reviewUrl: REVIEW_URL });
    expect(logLines().at(-1)).toMatchObject({ ended: "stopped" });
  });

  it("says no round started where the head's statuses cannot be read", async () => {
    verdictPosted();
    const { reader } = fakeReader(github);
    const io: CommandIo<(typeof COMMANDS)["review:conclude"]["outputs"]> = {
      writers: (limits) => {
        made = fakeWriters(github, ["loop", "workflow"] as const, limits);
        return made.writers;
      },
      github: { ...reader, commitStatuses: () => Promise.reject(new Error("403")) },
      outputs: { writeJson: (name, value) => files.set(name, value), writeText: () => {}, appendLine: () => {} },
    };

    await expect(conclude(INPUTS(FIX_ROUND), io)).rejects.toThrow(
      "No fix round started on PR #7: the verdicts on its head could not be read, so whether a newer one stands could not be told.",
    );
  });

  it("says no round started where the pull request cannot be read", async () => {
    verdictPosted();
    const { reader } = fakeReader(github);
    const io: CommandIo<(typeof COMMANDS)["review:conclude"]["outputs"]> = {
      writers: (limits) => {
        made = fakeWriters(github, ["loop", "workflow"] as const, limits);
        return made.writers;
      },
      github: { ...reader, pullRequest: () => Promise.reject(new Error("502")) },
      outputs: { writeJson: (name, value) => files.set(name, value), writeText: () => {}, appendLine: () => {} },
    };

    await expect(conclude(INPUTS(FIX_ROUND), io)).rejects.toThrow(
      "No fix round started on PR #7: its labels could not be read, so whether a round was already starting could not be told.",
    );
  });

  /** A PRD PR stays a draft until its final review approves it (PRD #222), even when no round comes. */
  it("leaves a PRD PR a draft where no round started", async () => {
    await expect(run(INPUTS({ ...FIX_ROUND, BRANCH: "agent/prd-14-a-prd", ROUND: "slice" }))).rejects.toThrow(/No fix round started/);

    expect(writes().filter((w) => w.includes("markReadyForReview"))).toEqual([]);
    expect(github.pullRequests.get(PR)?.draft).toBe(true);
  });

  it.each([
    ["approval recommended", "false"],
    ["changes recommended", "false"],
    ["needs a closer look", "true"],
  ])("starts nothing on %s with fix-round %s", async (VERDICT, FIX) => {
    verdictPosted();

    await run(INPUTS({ VERDICT, FIX_ROUND: FIX }));

    expect(writes().filter((w) => w.includes("agent:fix"))).toEqual([]);
  });
});

describe("review:conclude's writes are its own", () => {
  it("asks for its writers once, limited to the writes it makes", async () => {
    let asked = 0;
    let limits: unknown;
    publishedReview();
    const io: CommandIo<(typeof COMMANDS)["review:conclude"]["outputs"]> = {
      writers: (given) => {
        asked += 1;
        limits = given;
        made = fakeWriters(github, ["loop", "workflow"] as const, given);
        return made.writers;
      },
      github: fakeReader(github).reader,
      outputs: { writeJson: () => {}, writeText: () => {}, appendLine: () => {} },
    };

    await conclude(INPUTS(), io);

    expect(asked).toBe(1);
    expect(limits).toEqual({ removeLabel: 3, addLabel: 1, comment: 1, markReadyForReview: 1, setCommitStatus: 1 });
  });

  it("keeps a log line per write, and a last line for how it ended", async () => {
    await run(INPUTS(reviewEnded("failure")));

    expect(logLines().map((line) => line["type"] ?? line["ended"])).toEqual([
      "setCommitStatus",
      "comment",
      "removeLabel",
      "addLabel",
      "finished",
    ]);
    expect(logLines().map((line) => line["token"]).slice(0, -1)).toEqual(["workflow", "workflow", "workflow", "workflow"]);
  });
});
