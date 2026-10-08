import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteLog, Writer } from "../../engine/writer.js";
import type { PrSummary, ReviewBody, VerdictHandOver } from "../../review/hand-over.js";
import { publish } from "../../review/publish.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { readSummaryBlock } from "../../review/pr-summary.js";
import { renderMergeDanger } from "../../shared/merge-danger.js";
import { renderPrdSummary } from "../../shared/prd-round.js";
import { renderPrStatus, spliceStatus, statusBlock } from "../../shared/progress-list.js";
import { withEvidence } from "../../shared/red-check.js";
import {
  DRAFT_NOTE_END,
  DRAFT_NOTE_START,
  FIX_ROUND_STATUS,
  FOLLOW_UPS_LABEL,
  FOLLOW_UPS_MARKER,
  RESOLUTION_MARKER,
  STATUS_END,
  STATUS_START,
  SUMMARY_END,
  SUMMARY_START,
  VERDICT_CONTEXT,
} from "../../shared/record.js";
import { findingsHandOver, severityBadge, type PlacedFinding } from "../../shared/review-findings.js";
import {
  CLOSER_LOOK,
  REVIEW_BODY_BUDGET,
  reviewBodyHandOver,
  VERDICTS,
  type FollowUp,
  type ReviewDecisions,
  type ReviewOutput,
} from "../../shared/review-output.js";
import { verifyCarried, type CarriedFinding, type ThreadResolution } from "../../shared/review-verification.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub, type ServerError } from "../engine/fakes.js";
import { renderDecided } from "./decided.js";

/**
 * `review:publish` (#417), called the way the CLI calls it: its declared
 * inputs, a hand-over directory of the runner's three files, a fake GitHub
 * reader, and the engine's writers over a fake GitHub, sharing one log. What
 * is asserted is what it did to the record: the writes it attempted, in what
 * order, what each said, the log's lines, and `published.json`.
 *
 * The hand-overs are built by the runner's own decision functions
 * (`verifyCarried`, `findingsHandOver`, `reviewBodyHandOver`), so each case is
 * the runner's decisions carried through the seam to the record. The
 * scenarios are the retired step tests' (`tests/review-post-step.test.ts`,
 * and the posting job's assertions in `tests/workflows.test.ts`), carried
 * over by behaviour, and prototype #399's.
 */

const PR = 7;
const SHA = "c".repeat(40);
const RUN_URL = "https://github.com/o/r/actions/runs/42";

const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
  findings: [],
  followUps: [],
  fixBeforeMerge: [],
  verified: [],
  assessment: "Two earlier findings are fixed, and one new one is open.",
  ...over,
});

/** Two threaded findings an earlier review raised, one a maintainer declined, and one legacy body entry. */
const CARRIED: readonly CarriedFinding[] = [
  { id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return", title: "The guard runs after the return", severity: "high" },
  { id: "f-2", threadId: "PRRT_two", text: "the cache key omits the tenant", title: "The cache key omits the tenant", severity: "low" },
  {
    id: "f-3",
    threadId: "PRRT_three",
    text: "the retry doubles the write",
    title: "The retry doubles the write",
    severity: "medium",
    maintainerReply: { login: "maintainer", body: "Won't fix: the duplicate write is intended." },
  },
  { id: "f-4", text: "a legacy body entry", severity: "medium" },
];

const VERIFIED = [
  { id: "f-1", status: "landed" as const, note: "The guard now runs before `apply()`." },
  { id: "f-2", status: "landed" as const },
  { id: "f-3", status: "declined" as const },
  { id: "f-4", status: "landed" as const },
];

const PLACED: readonly PlacedFinding[] = [
  {
    id: "f-new",
    placement: "line",
    finding: {
      title: "The lock is never released",
      path: "src/queue.ts",
      line: 12,
      startLine: 10,
      body: "**Fix before merge.** The lock is never released on the error path.",
      severity: "high",
    },
  },
  {
    id: "f-file",
    placement: "file",
    finding: { title: "", path: "docs/notes.md", line: 400, body: "**Previously missed.** The notes contradict the code.", severity: "low" },
  },
];

const FOLLOW_UP: FollowUp = { title: "Rate limit is unbounded", location: "src/api.ts:4", body: "Out of scope.", severity: "medium", id: "fu-1" };

/** The runner's decisions for one review, as the cases vary them. */
const decide = (over: Partial<ReviewDecisions> = {}): { decisions: ReviewDecisions; resolutions: ThreadResolution[] } => {
  const { resolutions, stillOpen, resolved } = verifyCarried(CARRIED, VERIFIED);
  return {
    resolutions,
    decisions: {
      verdict: VERDICTS["changes recommended"],
      output: output(),
      placed: PLACED,
      movedToFollowUps: 0,
      stillOpen,
      resolved,
      followUps: [FOLLOW_UP],
      droppedFollowUps: 0,
      ...over,
    },
  };
};

/** A regular pull request's `pr_summary.json`, as the runner writes it where the summary is due. */
const prSummary = (over: Partial<Extract<PrSummary, { final: false }>> = {}): PrSummary => ({
  title: "feat: release the lock on the error path",
  summary: "It releases the queue's lock on every path.",
  final: false,
  ci: "green",
  testSketches: [],
  danger: { door: "two-way", blastRadius: "small", blastRadiusNote: "Callers of the queue, on merge." },
  redCheck: { kind: "not-configured" },
  ...over,
});

let dir: string;
let github: FakeGitHub;
let files: Map<string, unknown>;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
  github = fakeGitHub([{ number: PR, nodeId: "PR_node7", headSha: "d".repeat(40) }]);
  github.threads.set(
    PR,
    new Map(["PRRT_one", "PRRT_two", "PRRT_three", "PRRT_old"].map((id) => [id, { replies: [] }])),
  );
  files = new Map();
  made = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (name: string, value: unknown): void =>
  fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));

/** The runner's three files, from its decisions, as it writes them. */
const handOver = (decided = decide(), extra: Partial<ReviewBody> = {}): void => {
  put("findings.json", findingsHandOver(decided.decisions.placed));
  put("review_body.json", { ...reviewBodyHandOver(decided.decisions), ...extra } satisfies ReviewBody);
  put("thread_resolutions.json", decided.resolutions);
  put("verdict.json", verdictOf(decided.decisions));
};

/** `verdict.json` as the runner writes it from its decisions: the key, the fix round, and what it leaves open. */
const verdictOf = (decisions: ReviewDecisions): VerdictHandOver => ({
  verdict: decisions.verdict.verdict,
  fixRound: decisions.verdict.startsFixRound === true,
  open: decisions.stillOpen.length + decisions.placed.length,
});

type Inputs = Parameters<typeof publish>[0];

const INPUTS = (): Inputs => ({
  OUTPUT_DIR: path.join(dir, "out"),
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "app",
  PR_NUMBER: String(PR),
  BRANCH: "agent/issue-12-do-the-thing",
  REVIEWED_SHA: SHA,
  REVIEW_DIR: dir,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "42",
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const reader = fakeReader(github).reader;
  const io: CommandIo<(typeof COMMANDS)["review:publish"]["outputs"]> = {
    writers: (limits) => {
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: reader,
    outputs: {
      writeJson: (name, value) => files.set(name, value),
      writeText: (name, value) => files.set(name, value),
      appendLine: () => {},
    },
  };
  try {
    await publish(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

const writes = () => made?.writes ?? [];
const writeTypes = () => writes().map((w) => w.type);
const logLines = () => (made?.lines ?? []).map((line) => JSON.parse(line) as Record<string, unknown>);
const posted = () => github.reviews[0];

/** The lines of one `<details>` group in a body, or none where it has no such group. */
const group = (body: string, title: string): string[] => {
  const at = body.indexOf(`<summary><b>${title}</b>`);
  return at < 0 ? [] : body.slice(at, body.indexOf("</details>", at)).split("\n").filter((line) => line.startsWith("- "));
};

/** The `n`th call `call` makes, failed with `how`. */
const failing = (call: string, n: number, how: boolean | ServerError = true) => {
  let seen = 0;
  return (_write: unknown, made: string) => made === call && ++seen === n && how;
};

describe("review:publish resolves first, then posts what resolved", () => {
  /**
   * Every reply and resolve is made before the review goes out, so on the
   * pull request they are timestamped ahead of it, and the label after it.
   */
  it("answers and resolves the earlier threads, then posts the review, then marks the follow-ups", async () => {
    handOver();

    await run();

    expect(writeTypes()).toEqual([
      "replyAndResolve",
      "replyAndResolve",
      "replyAndResolve",
      "postReview",
      "addLabel",
      "editPullRequest",
      "setCommitStatus",
    ]);
    expect(writes().every((w) => w.token === "workflow")).toBe(true);
    expect(github.pullRequests.get(PR)?.labels).toEqual([FOLLOW_UPS_LABEL]);
    expect(files.get("published.json")).toEqual({ reviewUrl: "https://github.com/o/r/pull/0#pullrequestreview-1" });
  });

  /**
   * Where every closure held, the body is the one the runner's decisions
   * render, byte for byte: what publish posts is what was decided.
   */
  it("posts the body the decisions render where every thread resolved", async () => {
    const decided = decide();
    handOver(decided);

    await run();

    expect(posted()?.body).toBe(renderDecided({ ...decided.decisions, runUrl: RUN_URL }));
    expect(group(posted()?.body ?? "", "Resolved since last review")).toHaveLength(4);
    expect(posted()?.body).not.toContain("<summary><b>Still open</b>");
  });

  it("posts on the reviewed commit and the pull request the number names, whatever the head is now", async () => {
    handOver();

    await run();

    expect(posted()).toMatchObject({ token: "workflow", pullRequestId: "PR_node7", commit: SHA });
  });

  /** The acceptance case of #257: a thread whose resolve failed is listed as still open. */
  it("lists a thread whose resolve failed as still open, and goes on", async () => {
    github.fails = failing("resolve", 1);
    handOver();

    await run();

    const body = posted()?.body ?? "";
    expect(group(body, "Still open")).toEqual([expect.stringContaining("The guard runs after the return")]);
    expect(group(body, "Resolved since last review").join("\n")).not.toContain("The guard runs after the return");
    expect(group(body, "Resolved since last review").join("\n")).toContain("a legacy body entry");
    expect(body).toContain("their threads could not be resolved");
    expect(body.indexOf("Still open")).toBeLessThan(body.indexOf("Resolved since last review"));
    // Its reply is on the thread, and the log says so rather than claiming it failed.
    expect(github.threads.get(PR)?.get("PRRT_one")).toEqual({ replies: [expect.stringContaining("Verified fixed.")] });
    expect(logLines()[0]).toMatchObject({ type: "replyAndResolve", outcome: "partial" });
    // Tolerated: the last line names no write that stopped it.
    expect(logLines().at(-1)).toEqual({ ended: "finished", writes: 7 });
  });

  /** A reply that would not post leaves its thread open, and never resolved: the reply is its only record. */
  it("never resolves a thread whose reply failed, and lists it as still open", async () => {
    github.fails = failing("reply", 2);
    handOver();

    await run();

    expect(github.threads.get(PR)?.get("PRRT_two")).toEqual({ replies: [] });
    expect(group(posted()?.body ?? "", "Still open")).toEqual([expect.stringContaining("The cache key omits the tenant")]);
    expect(logLines()[1]).toMatchObject({ type: "replyAndResolve", outcome: "failed" });
  });

  it("drops the resolved group's threads to still open where none resolved, and keeps the legacy entry", async () => {
    github.fails = (_write, call) => call === "resolve";
    handOver();

    await run();

    const body = posted()?.body ?? "";
    expect(group(body, "Still open")).toHaveLength(3);
    expect(group(body, "Resolved since last review")).toEqual([expect.stringContaining("a legacy body entry")]);
  });

  /** #133: a thread already carrying its closing reply has only the resolve retried. */
  it("retries only the resolve on a thread that already carries the reply", async () => {
    const decided = decide();
    handOver({ ...decided, resolutions: decided.resolutions.map((r) => (r.threadId === "PRRT_one" ? { ...r, alreadyReplied: true } : r)) });

    await run();

    expect(github.threads.get(PR)?.get("PRRT_one")).toEqual({ replies: [], resolved: "ADDRESSED" });
    expect(writes()[0]?.args[0]).toEqual({ threadId: "PRRT_one", reply: undefined, reason: "ADDRESSED" });
  });
});

describe("review:publish writes every string it posts", () => {
  it("closes a verified thread as addressed, with the review's note and the resolution marker", async () => {
    handOver();

    await run();

    const thread = github.threads.get(PR)?.get("PRRT_one");
    expect(thread?.resolved).toBe("ADDRESSED");
    expect(thread?.replies[0]).toContain("**Verified fixed.** The guard now runs before `apply()`.");
    expect(thread?.replies[0]).toContain(`<!-- ${RESOLUTION_MARKER} ADDRESSED -->`);
  });

  it("closes a declined thread as won't fix, quoting the maintainer", async () => {
    handOver();

    await run();

    const thread = github.threads.get(PR)?.get("PRRT_three");
    expect(thread?.resolved).toBe("WONT_FIX");
    expect(thread?.replies[0]).toContain("@maintainer");
    expect(thread?.replies[0]).toContain("> Won't fix: the duplicate write is intended.");
    expect(thread?.replies[0]).toContain(`<!-- ${RESOLUTION_MARKER} WONT_FIX -->`);
  });

  it("opens a thread per finding, with the badge, the label it keeps and the marker", async () => {
    handOver();

    await run();

    const threads = posted()?.threads ?? [];
    expect(threads.map((t) => [t.path, t.line, t.startLine])).toEqual([
      ["src/queue.ts", 12, 10],
      ["docs/notes.md", undefined, undefined],
    ]);
    expect(threads[0]?.body).toMatch(new RegExp(`^${severityBadge("high").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n\nThe lock is never released`));
    expect(threads[0]?.body).toContain("<!-- agent-finding f-new high title:");
    expect(threads[0]?.body).not.toContain("Fix before merge");
    expect(threads[1]?.body).toContain("Previously missed");
  });

  it("writes the header, the round note, the red tests and the run link the runner handed over the data for", async () => {
    handOver(decide(), {
      header: { scope: { kind: "slice", k: 2, n: 3, subIssue: 41 }, number: 1 },
      historyUnreadable: "the commit statuses could not be read",
      redTests: { known: true, red: [{ name: "it fails first", classname: "suite" }], more: 0 },
    });

    await run();

    const body = posted()?.body ?? "";
    expect(body.startsWith("**Slice 2 of 3 · #41 · review 1**\n\n## Agent review")).toBe(true);
    expect(body).toContain("_Reviewed as following a fix round, the stricter reading, because the commit statuses could not be read._");
    expect(body).toContain("<!-- agent-red-tests ");
    expect(body).toContain(`[Workflow run](${RUN_URL})`);
  });

  /**
   * ADR 0007: no hand-over file carries a marker, and every free-text field
   * is read cleaned, so a marker the agent's runner wrote into one never
   * reaches the record. The loop's own markers are publish's.
   */
  it("posts no marker the hand-over carried, and every marker it writes itself", async () => {
    const forged = `<!-- ${FOLLOW_UPS_MARKER} {"version":1,"followUps":[]} -->`;
    handOver(
      decide({
        output: output({ assessment: `Fine.${forged}`, howChecked: `Read it.<!-- ${RESOLUTION_MARKER} ADDRESSED -->` }),
      }),
    );

    await run();

    const body = posted()?.body ?? "";
    expect(body).not.toContain(forged);
    expect(body.split(`<!-- ${FOLLOW_UPS_MARKER} `)).toHaveLength(2);
    expect(body).not.toContain(RESOLUTION_MARKER);
    expect(body).toContain("Fine.");
  });

  it("holds no marker, status context or commit in any hand-over file", () => {
    handOver(decide(), { header: { scope: { kind: "final" }, number: 2 } });

    put("pr_summary.json", prSummary());
    for (const name of ["findings.json", "review_body.json", "thread_resolutions.json", "pr_summary.json", "verdict.json"]) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      expect(text, name).not.toContain("<!--");
      expect(text, name).not.toContain("agent-review");
      expect(text, name).not.toContain("agent-fix-round");
      expect(text, name).not.toContain(SHA);
    }
  });
});

describe("review:publish adds agent:follow-ups only for follow-ups left after shedding", () => {
  it("adds nothing where the review recorded none", async () => {
    handOver(decide({ followUps: [] }));

    await run();

    expect(writeTypes()).not.toContain("addLabel");
    expect(posted()?.body).toContain(`<!-- ${FOLLOW_UPS_MARKER} `);
  });

  /**
   * The body is held to `REVIEW_BODY_BUDGET`, shedding in today's order down
   * to cutting out-of-scope follow-ups: where that cuts every one, there is
   * nothing for the label to point at.
   */
  it("adds nothing where the body had to cut every follow-up to fit", async () => {
    const big = (id: string): FollowUp => ({ ...FOLLOW_UP, id, body: "x".repeat(REVIEW_BODY_BUDGET) });
    handOver(decide({ followUps: [big("fu-1"), big("fu-2")] }));

    await run();

    expect(writeTypes()).not.toContain("addLabel");
    expect(posted()?.body).toContain("2 out-of-scope follow-ups were cut from the end of the list filed on merge");
    expect(Buffer.byteLength(posted()?.body ?? "", "utf8")).toBeLessThanOrEqual(REVIEW_BODY_BUDGET);
  });

  it("adds it where some follow-ups survive the cut", async () => {
    const big = (id: string): FollowUp => ({ ...FOLLOW_UP, id, body: "x".repeat(REVIEW_BODY_BUDGET) });
    handOver(decide({ followUps: [FOLLOW_UP, big("fu-2"), big("fu-3")] }));

    await run();

    expect(writeTypes()).toContain("addLabel");
    expect(posted()?.body).toContain("2 out-of-scope follow-ups were cut");
  });

  it("warns and finishes where the label cannot be added", async () => {
    github.fails = (_write, call) => call === "POST labels";
    handOver();

    await run();

    expect(logLines().find((line) => line["type"] === "addLabel")).toMatchObject({ outcome: "failed" });
    expect(logLines().at(-1)).toMatchObject({ ended: "finished" });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("::warning::Could not add `agent:follow-ups`"));
  });

  it("refuses a body that cannot be made to fit, before it resolves anything", async () => {
    handOver(decide({ output: output({ assessment: "y".repeat(REVIEW_BODY_BUDGET) }) }));

    await expect(run()).rejects.toThrow(/after shedding everything it can.*so nothing was posted/);
    expect(writes()).toEqual([]);
  });
});

describe("review:publish fails before its first write on a hand-over it cannot trust", () => {
  it("refuses a thread that is not a review thread on this pull request", async () => {
    const decided = decide();
    handOver({ ...decided, resolutions: [...decided.resolutions, { threadId: "PRRT_elsewhere", reason: "ADDRESSED", alreadyReplied: false }] });

    await expect(run()).rejects.toThrow(
      `review's thread_resolutions.json \`[3].threadId\` is "PRRT_elsewhere", which is not a review thread on PR #${PR}.`,
    );
    expect(writes()).toEqual([]);
  });

  it("refuses a resolved entry naming a thread elsewhere, though nothing would resolve it", async () => {
    const decided = decide();
    handOver(decided, {
      resolved: [{ title: "Elsewhere", isNew: false, threadId: "PRRT_elsewhere" }],
    });

    await expect(run()).rejects.toThrow("`resolved[0].threadId`");
    expect(writes()).toEqual([]);
  });

  it.each([
    ["a field it does not declare", "review_body.json", (body: Record<string, unknown>) => ({ ...body, context: "agent-review" })],
    ["an unknown verdict", "review_body.json", (body: Record<string, unknown>) => ({ ...body, verdict: "merge it" })],
  ])("refuses %s", async (_case, file, change) => {
    handOver();
    put(file, change(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>));

    await expect(run()).rejects.toThrow(/^review's review_body\.json /);
    expect(writes()).toEqual([]);
  });

  it("refuses a decline with no maintainer reply to quote", async () => {
    handOver();
    put("thread_resolutions.json", [{ threadId: "PRRT_one", reason: "WONT_FIX", alreadyReplied: false }]);

    await expect(run()).rejects.toThrow("closes a thread as WONT_FIX with no maintainer reply to quote");
    expect(writes()).toEqual([]);
  });

  it("refuses a finding whose path leaves the checkout", async () => {
    handOver();
    put("findings.json", [{ ...findingsHandOver(PLACED)[0], path: "../etc/passwd" }]);

    await expect(run()).rejects.toThrow("`[0].path`");
    expect(writes()).toEqual([]);
  });

  it("refuses a hand-over missing a file the runner always writes", async () => {
    handOver();
    fs.rmSync(path.join(dir, "findings.json"));

    await expect(run()).rejects.toThrow("review's findings.json is not in");
    expect(writes()).toEqual([]);
  });

  it.each([
    ["PR_NUMBER", "seven", "is not a pull request number"],
    ["REVIEWED_SHA", "HEAD", "is not a full commit id"],
  ])("refuses %s %j before it reads anything", async (name, value, message) => {
    handOver();

    await expect(run({ ...INPUTS(), [name]: value })).rejects.toThrow(message);
    expect(writes()).toEqual([]);
  });

  it("says what it could not read, and that nothing was posted", async () => {
    github.pullRequests.clear();
    handOver();

    await expect(run()).rejects.toThrow(/^Could not read PR #7 from GitHub, so nothing was posted: /);
    expect(writes()).toEqual([]);
  });
});

describe("review:publish when GitHub refuses or fails the review", () => {
  /**
   * The failure comment's sentence, the one the shell step wrote: the review
   * is not on the pull request, and what step 1 did is in the log.
   */
  it("stops with today's sentence on a refused review, after resolving what it could", async () => {
    github.fails = (_write, call) => call === "addPullRequestReview";
    handOver();

    await expect(run()).rejects.toThrow(
      "GitHub refused the review, so it was not posted. Its threads are not on the pull request and there is no verdict; the earlier threads this review closed were resolved where GitHub allowed it, and the log names any that were not.",
    );
    expect(writeTypes()).toEqual(["replyAndResolve", "replyAndResolve", "replyAndResolve", "postReview"]);
    expect(files.has("published.json")).toBe(false);
    expect(logLines().at(-1)).toMatchObject({ ended: "stopped", writes: 4, by: 4 });
  });

  /**
   * #424: GitHub answered slice 5's review 2 with a 500 and posted it, and
   * the step reported it unposted. A server error is read back before it is
   * taken as "not posted".
   */
  it.each([
    ["a 500", { status: 500, landed: true }],
    ["GraphQL's internal error", { landed: true }],
  ])("goes on with the review's URL where %s answered a review that posted", async (_case, how: ServerError) => {
    github.fails = (_write, call) => call === "addPullRequestReview" && how;
    handOver();

    await run();

    expect(github.reviews).toHaveLength(1);
    expect(files.get("published.json")).toEqual({ reviewUrl: github.reviews[0]?.url });
    expect(writeTypes().slice(-3)).toEqual(["addLabel", "editPullRequest", "setCommitStatus"]);
    expect(logLines().find((line) => line["type"] === "postReview")).toMatchObject({ outcome: "failed" });
    expect(logLines().at(-1)).toMatchObject({ ended: "finished" });
  });

  it("fails as today where a 500 answered a review that did not post", async () => {
    github.fails = (_write, call) => call === "addPullRequestReview" && { status: 502, landed: false };
    handOver();

    await expect(run()).rejects.toThrow("GitHub refused the review, so it was not posted.");
    expect(files.has("published.json")).toBe(false);
  });

  it("does not take an earlier review of another body or commit for this one", async () => {
    github.reviews.push(
      { token: "workflow", pullRequestId: "PR_node7", commit: SHA, body: "an earlier review", threads: [], url: "u1" },
      { token: "workflow", pullRequestId: "PR_node7", commit: "e".repeat(40), body: "", threads: [], url: "u2" },
    );
    github.fails = (_write, call) => call === "addPullRequestReview" && { status: 500, landed: false };
    handOver();

    await expect(run()).rejects.toThrow("GitHub refused the review, so it was not posted.");
  });

  it("says it cannot tell where the read-back fails too", async () => {
    github.fails = (_write, call) => call === "addPullRequestReview" && { status: 500, landed: true };
    handOver();
    const reader = fakeReader(github).reader;
    const io: CommandIo<(typeof COMMANDS)["review:publish"]["outputs"]> = {
      writers: (limits) => fakeWriters(github, ["loop", "workflow"] as const, limits).writers,
      github: { ...reader, reviews: () => Promise.reject(new Error("502 Bad Gateway")) },
      outputs: { writeJson: () => {}, writeText: () => {}, appendLine: () => {} },
    };

    await expect(publish(INPUTS(), io)).rejects.toThrow(/whether it was posted anyway could not be read back \(502 Bad Gateway\)/);
  });
});

describe("review:publish's writes are its own", () => {
  /** Two writers asked for once, limited to what publish writes, sharing the log the CLI appends to. */
  it("asks for its writers once, limited to the writes it makes", async () => {
    let asked = 0;
    let limits: unknown;
    handOver();
    const reader = fakeReader(github).reader;
    let log: WriteLog | undefined;
    const io: CommandIo<(typeof COMMANDS)["review:publish"]["outputs"]> = {
      writers: (given) => {
        asked += 1;
        limits = given;
        const fake = fakeWriters(github, ["loop", "workflow"] as const, given);
        log = fake.log;
        return fake.writers as Readonly<Record<Token, Writer>>;
      },
      github: reader,
      outputs: { writeJson: () => {}, writeText: () => {}, appendLine: () => {} },
    };

    await publish(INPUTS(), io);

    expect(asked).toBe(1);
    expect(limits).toEqual({ replyAndResolve: 200, postReview: 1, addLabel: 1, editPullRequest: 2, setCommitStatus: 2 });
    expect(log?.entries.map((e) => e.type)).toEqual([
      "replyAndResolve",
      "replyAndResolve",
      "replyAndResolve",
      "postReview",
      "addLabel",
      "editPullRequest",
      "setCommitStatus",
    ]);
  });

  it("keeps a log line per write, and a last line for how it ended", async () => {
    handOver();

    await run();

    expect(logLines().map((line) => line["type"] ?? line["ended"])).toEqual([
      "replyAndResolve",
      "replyAndResolve",
      "replyAndResolve",
      "postReview",
      "addLabel",
      "editPullRequest",
      "setCommitStatus",
      "finished",
    ]);
  });
});

/** The edits publish made, in order: what each set, as the fake received it. */
const edits = () => writes().filter((w) => w.type === "editPullRequest");
const body = () => github.pullRequests.get(PR)?.body ?? "";
const title = () => github.pullRequests.get(PR)?.title ?? "";
const statuses = () => github.statuses.get(SHA) ?? [];
const setPr = (over: { body?: string; title?: string }): void => {
  Object.assign(github.pullRequests.get(PR) ?? {}, over);
};

/** Every byte the review does not own: what surrounds the block. */
const outside = (text: string): [string, string] => {
  const start = text.indexOf(SUMMARY_START);
  const end = text.indexOf(SUMMARY_END) + SUMMARY_END.length;
  return [text.slice(0, start), text.slice(end)];
};

/** A regular pull request's frame, with a CRLF and a maintainer's note outside the block. */
const FRAME = [
  "Closes #123\r\n",
  "> [!NOTE]\r\n> Opened by the agent loop from #123.\r\n",
  SUMMARY_START,
  "_The review will summarize this change here after its first pass._",
  SUMMARY_END,
  "\r\nMy own note, with a trailing newline and a CRLF.\n",
].join("\n");

const PRD_BRANCH = "agent/prd-14-a-prd";

/**
 * Step 3, the title and the summary block (#218), carried over from the
 * retired step tests (`tests/pr-body-steps.test.ts`) by behaviour: spliced
 * against the body as it stands now, every byte outside the markers kept,
 * and the text laid out by publish from the runner's data (ADR 0007).
 */
describe("review:publish writes the title and the summary block", () => {
  it("splices the summary between the markers, keeps every other byte, and writes the title", async () => {
    setPr({ body: FRAME, title: "Fix #123: Do the thing" });
    handOver();
    put("pr_summary.json", prSummary());

    await run();

    expect(outside(body())).toEqual(outside(FRAME));
    expect(title()).toBe("feat: release the lock on the error path");
    expect(readSummaryBlock(body())).toMatchObject({ head: SHA, final: false });
    expect(edits()[0]?.token).toBe("workflow");
  });

  /**
   * The record is unchanged: the block holds what the runner's renderers made
   * of the same data before the formatting moved here, the agent's summary,
   * then the Evidence, then the Merge Danger naming the follow-ups.
   */
  it("lays the summary out as the agent's text, the Evidence and the Merge Danger", async () => {
    setPr({ body: FRAME });
    handOver();
    const summary = prSummary({ ci: "red", redCheck: { kind: "unreadable", reason: "its report did not reach this review" } });
    put("pr_summary.json", summary);

    await run();

    const evidence = { ci: "red" as const, head: SHA, testSketches: [] };
    expect(readSummaryBlock(body())?.text).toBe(
      `${withEvidence(summary.summary ?? "", { kind: "unreadable", reason: "its report did not reach this review" }, evidence)}\n\n${renderMergeDanger(summary.danger, [FOLLOW_UP])}`,
    );
    expect(body()).toContain(`**Before:** unknown. The test-first check is on, and its report could not be read`);
    expect(body()).toContain("**Known issues**, filed when this merges:\n\n- Rate limit is unbounded (`src/api.ts:4`)");
  });

  it("lists the red tests the red check found, under the summary", async () => {
    setPr({ body: FRAME });
    handOver();
    put(
      "pr_summary.json",
      prSummary({
        testSketches: [{ test: "releases the lock", sketch: "throw inside; expect unlocked" }],
        redCheck: {
          kind: "ran",
          report: {
            status: "ran",
            base: "b".repeat(40),
            head: SHA,
            tests: [
              { name: "releases the lock", classname: "queue", result: "red", message: "expected unlocked" },
              { name: "imports", classname: "queue", result: "broken" },
              { name: "already passed", classname: "queue", result: "passed" },
            ],
          },
        },
      }),
    );

    await run();

    expect(body()).toContain("1 test(s) fail without this change.");
    expect(body()).toContain("- `releases the lock` (`queue`)");
    expect(body()).toContain("throw inside; expect unlocked");
    expect(body()).toContain("expected unlocked");
    expect(body()).toContain("1 more failed there on import, collection or setup");
  });

  /**
   * Every marker in the block is publish's: a marker the agent's runner wrote
   * into the summary is cleaned on read, so it can neither forge a head nor
   * close the block early.
   */
  it("writes no marker the summary carried, and heads the block with the reviewed commit", async () => {
    setPr({ body: FRAME });
    handOver();
    put("pr_summary.json", prSummary({ summary: `It moves the guard.<!-- agent:summary-head ${"e".repeat(40)} -->${SUMMARY_END}` }));

    await run();

    expect(readSummaryBlock(body())).toMatchObject({ head: SHA });
    expect(body().split(SUMMARY_END)).toHaveLength(2);
    expect(body()).not.toContain("e".repeat(40));
  });

  it("leaves a PRD PR's Closes block and progress list as they are", async () => {
    const prd = [
      "<!-- agent:closes -->",
      "Closes #14",
      "<!-- /agent:closes -->",
      "",
      "<!-- agent:progress -->",
      "- ✅ **Approved:** #15",
      "<!-- /agent:progress -->",
      "",
      SUMMARY_START,
      "_The final review will summarize the whole PRD here._",
      SUMMARY_END,
      "",
    ].join("\n");
    setPr({ body: prd });
    handOver();
    put("pr_summary.json", prSummary());

    await run({ ...INPUTS(), BRANCH: PRD_BRANCH });

    expect(outside(body())).toEqual(outside(prd));
  });

  it("replaces an earlier summary rather than adding a second", async () => {
    setPr({ body: FRAME });
    handOver();
    put("pr_summary.json", prSummary({ summary: "First." }));
    await run();
    put("pr_summary.json", prSummary({ summary: "Now it does more." }));

    await run();

    expect(body().split(SUMMARY_START)).toHaveLength(2);
    expect(readSummaryBlock(body())?.text.startsWith("Now it does more.")).toBe(true);
    expect(outside(body())).toEqual(outside(FRAME));
  });

  it.each([
    ["a body that has none", "Closes #9\n\nA body from before the frame.", "Closes #9\n\nA body from before the frame.\n\n"],
    ["an empty body", "", ""],
  ])("appends a block to %s, keeping what is there", async (_case, before, kept) => {
    setPr({ body: before });
    handOver();
    put("pr_summary.json", prSummary());

    await run();

    expect(body().startsWith(`${kept}${SUMMARY_START}`)).toBe(true);
    expect(readSummaryBlock(body())?.head).toBe(SHA);
  });

  /**
   * Half a block, or two, is not written into: which marker is the real one is
   * where a maintainer's text ends, and that is not a guess to make. The title
   * still is.
   */
  it.each([
    ["a start with no end", `Closes #1\n${SUMMARY_START}\nmine`],
    ["two blocks", `${FRAME}\n${SUMMARY_START}\nx\n${SUMMARY_END}`],
    ["the end before the start", `${SUMMARY_END}\nmine\n${SUMMARY_START}`],
  ])("writes the title alone over %s, and says why", async (_case, broken) => {
    setPr({ body: broken });
    handOver();
    put("pr_summary.json", prSummary());

    await run();

    expect(body()).toBe(broken);
    expect(title()).toBe("feat: release the lock on the error path");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("half a summary block, or two"));
    expect(logLines().at(-1)).toMatchObject({ ended: "finished" });
  });

  it("writes only the half the review produced", async () => {
    setPr({ body: FRAME, title: "Fix #123: Do the thing" });
    handOver();
    const { summary: _summary, ...titleOnly } = prSummary();
    put("pr_summary.json", titleOnly);

    await run();

    expect(body()).toBe(FRAME);
    expect(title()).toBe("feat: release the lock on the error path");

    const { title: _title, ...summaryOnly } = prSummary();
    put("pr_summary.json", summaryOnly);
    setPr({ title: "Kept" });

    await run();

    expect(title()).toBe("Kept");
    expect(readSummaryBlock(body())?.head).toBe(SHA);
  });

  /** Nothing pushed since the summary was written: the runner wrote no file. */
  it("leaves the title and the summary as they are where the runner wrote no file", async () => {
    setPr({ body: FRAME, title: "Fix #123: Do the thing" });
    handOver();

    await run();

    expect(body()).toBe(FRAME);
    expect(title()).toBe("Fix #123: Do the thing");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("left as they are"));
  });

  /** After the review, and tolerated: a posted review is worth more than its description. */
  it("warns and goes on to the verdict where the edit fails", async () => {
    setPr({ body: FRAME });
    github.fails = (_write, call) => call === "PATCH";
    handOver();
    put("pr_summary.json", prSummary());

    await run();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("::warning::Could not write the title and summary of PR #7"));
    expect(statuses()).toHaveLength(1);
    expect(logLines().at(-1)).toMatchObject({ ended: "finished" });
  });

  describe("on a PRD PR's final review", () => {
    const NOTE = [
      DRAFT_NOTE_START,
      "> [!NOTE]",
      "> The agent loop builds PRD #14 here, one sub-issue at a time. It stays a draft until every slice is done.",
      DRAFT_NOTE_END,
    ].join("\n");
    const prd = (note: string): string =>
      [
        "<!-- agent:closes -->",
        "Closes #14",
        "<!-- /agent:closes -->",
        "",
        note,
        "",
        SUMMARY_START,
        "_The final review will summarize the whole PRD here._",
        SUMMARY_END,
        "",
        "A maintainer's note.",
      ].join("\n");
    const finalSummary = (): PrSummary => ({
      title: "feat: the whole PRD",
      summary: "The PRD delivers the queue.",
      final: true,
      ci: "green",
      testSketches: [],
      danger: { door: "one-way", doorNote: "A published release." },
      prd: {
        criteria: [
          { subIssue: 15, record: { kind: "recorded", changes: [{ status: "changed", line: "The lock is per queue: shared locks deadlocked." }] } },
          { subIssue: 16, record: { kind: "no record" } },
        ],
        redTests: { slices: [{ subIssue: 15, record: { known: true, red: [{ name: "locks per queue", classname: "queue" }], more: 0 } }, { subIssue: 16, record: undefined }] },
      },
    });

    it("removes the draft-only note and writes the PRD's summary, marked as the final review's", async () => {
      setPr({ body: prd(NOTE) });
      handOver();
      const summary = finalSummary();
      put("pr_summary.json", summary);

      await run({ ...INPUTS(), BRANCH: PRD_BRANCH });

      expect(body()).not.toContain(DRAFT_NOTE_START);
      expect(body()).not.toContain("stays a draft");
      expect(outside(body())).toEqual(outside(prd(NOTE).replace(`${NOTE}\n\n`, "")));
      expect(readSummaryBlock(body())).toMatchObject({ head: SHA, final: true });
      expect(title()).toBe("feat: the whole PRD");
      if (!summary.final) throw new Error("unreachable");
      expect(readSummaryBlock(body())?.text).toBe(
        renderPrdSummary({
          outcome: summary.summary,
          danger: summary.danger,
          slices: summary.prd.criteria,
          followUps: [FOLLOW_UP],
          redTests: { slices: summary.prd.redTests?.slices },
          evidence: { ci: "green", head: SHA, testSketches: [] },
        }),
      );
      expect(body()).toContain("**Differs from the PRD:** #15 changed: The lock is per queue: shared locks deadlocked.");
      expect(body()).toContain("- #15\n  **Before:** 1 test(s) fail without this slice.");
    });

    it("leaves a body with no note, or half of one, as it is outside the summary", async () => {
      for (const note of ["My own text.", DRAFT_NOTE_START]) {
        setPr({ body: prd(note) });
        handOver();
        put("pr_summary.json", finalSummary());

        await run({ ...INPUTS(), BRANCH: PRD_BRANCH });

        expect(outside(body())).toEqual(outside(prd(note)));
      }
    });

    /** A slice round's write is not the final review's, and the note stays. */
    it("leaves the note where a slice round writes the summary", async () => {
      setPr({ body: prd(NOTE) });
      handOver();
      put("pr_summary.json", prSummary());

      await run({ ...INPUTS(), BRANCH: PRD_BRANCH });

      expect(body()).toContain(NOTE);
      expect(readSummaryBlock(body())?.final).toBe(false);
    });
  });
});

/**
 * Step 3b, the status line (#298), off a PRD PR: replaced between its markers
 * and nowhere else, by `spliceStatus`'s rule, linking the review just posted.
 * Built here from the verdict and the open count, which `pr_status.md` once
 * carried as finished text.
 */
describe("review:publish writes the status line", () => {
  const note = (line: string): string => `> [!NOTE]\n> ${line}\n>\n> Mine.\r\n`;
  const bodies: readonly [string, string][] = [
    ["a body with a status line", note(statusBlock("old"))],
    ["a body with none", note("no line")],
    ["half a line", note(`${STATUS_START}old`)],
    ["two lines", note(statusBlock("a") + statusBlock("b"))],
  ];

  it.each(bodies)("over %s keeps spliceStatus's rule, linking the posted review", async (_case, before) => {
    setPr({ body: before });
    handOver();

    await run();

    const line = statusBlock(
      renderPrStatus({ verdict: "changes recommended", startsFixRound: false, open: 2, review: github.reviews[0]?.url ?? "" }),
    );
    expect(body()).toBe(spliceStatus(before, line) ?? before);
  });

  it("says the review is fixing where it starts a fix round, and how many findings are open", async () => {
    setPr({ body: note(statusBlock("old")) });
    handOver(decide({ verdict: { ...VERDICTS["changes recommended"], startsFixRound: true } }));

    await run();

    expect(body()).toContain(`${STATUS_START}\n> **🔧 Fixing:** 2 findings open. [See it](${github.reviews[0]?.url})\n> ${STATUS_END}`);
  });

  it("is the advance job's on a PRD PR, and not written here", async () => {
    setPr({ body: note(statusBlock("old")) });
    handOver();

    await run({ ...INPUTS(), BRANCH: PRD_BRANCH });

    expect(edits()).toEqual([]);
    expect(body()).toBe(note(statusBlock("old")));
  });
});

/**
 * Step 4, the verdict as a commit status (#96), and the fix round's beside it
 * (#297). The context, the state and the line are publish's own: the hand-over
 * names the verdict's key and whether it starts a round, and nothing more.
 */
describe("review:publish posts the verdict", () => {
  it("posts the verdict's row on the reviewed commit, linking the review, with the workflow token", async () => {
    handOver();

    await run();

    expect(statuses()).toEqual([
      { context: VERDICT_CONTEXT, state: "failure", targetUrl: github.reviews[0]?.url, description: expect.any(String), creator: "workflow" },
    ]);
    const posted = writes().find((w) => w.type === "setCommitStatus")?.args[0];
    expect(posted).toEqual({
      sha: SHA,
      context: VERDICT_CONTEXT,
      state: "failure",
      description: VERDICTS["changes recommended"].description,
      targetUrl: github.reviews[0]?.url,
    });
  });

  it("posts approval as success", async () => {
    handOver(decide({ verdict: VERDICTS["approval recommended"], placed: [], stillOpen: [] }));

    await run();

    expect(writes().find((w) => w.type === "setCommitStatus")?.args[0]).toMatchObject({
      state: "success",
      description: VERDICTS["approval recommended"].description,
    });
  });

  /** *Needs a closer look*'s line is its cause's, which the body's hand-over names. */
  it("takes a closer look's line from its cause", async () => {
    handOver(decide({ verdict: { ...VERDICTS["needs a closer look"], ...CLOSER_LOOK.red, cause: "red" } }));

    await run();

    expect(writes().find((w) => w.type === "setCommitStatus")?.args[0]).toMatchObject({
      state: "failure",
      description: CLOSER_LOOK.red.description,
    });
  });

  it("posts the fix round's status beside the verdict where the review asked for one", async () => {
    handOver(decide({ verdict: { ...VERDICTS["changes recommended"], startsFixRound: true } }));

    await run();

    expect(writes().filter((w) => w.type === "setCommitStatus").map((w) => w.args[0])).toEqual([
      expect.objectContaining({ context: VERDICT_CONTEXT }),
      { sha: SHA, ...FIX_ROUND_STATUS, targetUrl: github.reviews[0]?.url },
    ]);
  });

  it("posts the verdict last, after the review, the title and summary, and the status line", async () => {
    setPr({ body: `${statusBlock("old")}\n${FRAME}` });
    handOver(decide({ verdict: { ...VERDICTS["changes recommended"], startsFixRound: true } }));
    put("pr_summary.json", prSummary());

    await run();

    expect(writeTypes().slice(3)).toEqual([
      "postReview",
      "addLabel",
      "editPullRequest",
      "editPullRequest",
      "setCommitStatus",
      "setCommitStatus",
    ]);
  });

  it("warns and finishes where GitHub refuses the verdict or the fix round's status", async () => {
    github.fails = (_write, call) => call === "POST status";
    handOver(decide({ verdict: { ...VERDICTS["changes recommended"], startsFixRound: true } }));

    await run();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("::warning::Could not post the `agent-review` verdict for"));
    // Not the adopter's grant (#121, #146): a caller short of `statuses:
    // write` is refused before any job starts, so this is the status refused.
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("a 422 is the status itself being refused"));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/a 403 is a caller missing/));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("::warning::Could not post the `agent-fix-round` status for"));
    expect(logLines().at(-1)).toMatchObject({ ended: "finished" });
  });

  /**
   * ADR 0007: the agent's runner can claim a verdict and a fix round, each
   * read strictly into its fixed set, and can name no status. A file that
   * tries is refused before the first write.
   */
  it.each([
    ["a status context", (v: Record<string, unknown>) => ({ ...v, context: "agent-review" })],
    ["the old fix round's status", (v: Record<string, unknown>) => ({ ...v, fixRound: FIX_ROUND_STATUS })],
    ["an unknown verdict", (v: Record<string, unknown>) => ({ ...v, verdict: "merge it" })],
    ["a fix round on approval", (v: Record<string, unknown>) => ({ ...v, verdict: "approval recommended" })],
    ["a fix round claimed as a string", (v: Record<string, unknown>) => ({ ...v, fixRound: "true" })],
    ["a negative open count", (v: Record<string, unknown>) => ({ ...v, open: -1 })],
  ])("refuses a verdict.json carrying %s", async (_case, change) => {
    handOver(decide({ verdict: { ...VERDICTS["changes recommended"], startsFixRound: true } }));
    put("verdict.json", change(JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8")) as Record<string, unknown>));

    await expect(run()).rejects.toThrow(/^review's verdict\.json /);
    expect(writes()).toEqual([]);
  });

  it("refuses a verdict.json naming another verdict from the body's", async () => {
    handOver();
    put("verdict.json", { verdict: "approval recommended", fixRound: false, open: 0 });

    await expect(run()).rejects.toThrow(
      'review\'s verdict.json names the verdict "approval recommended", and its review_body.json "changes recommended", so nothing was posted.',
    );
    expect(writes()).toEqual([]);
  });

  it.each([
    ["a status context", { context: "agent-review" }],
    ["a finished block", { summary: { start: SUMMARY_START, end: SUMMARY_END, inner: "x" } }],
    ["the final review's records off it", { final: true }],
  ])("refuses a pr_summary.json carrying %s, before its first write", async (_case, change) => {
    handOver();
    put("pr_summary.json", { ...prSummary(), ...change });

    await expect(run()).rejects.toThrow(/^review's pr_summary\.json /);
    expect(writes()).toEqual([]);
  });

  it("refuses a missing verdict.json, which the runner writes on every review", async () => {
    handOver();
    fs.rmSync(path.join(dir, "verdict.json"));

    await expect(run()).rejects.toThrow("review's verdict.json is not in");
    expect(writes()).toEqual([]);
  });
});
