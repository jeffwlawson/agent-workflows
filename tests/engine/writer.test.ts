/**
 * The writer's discipline (ADR 0005), through the fakes a command's test uses:
 * limits, the throw, the log and its last line, over two tokens at once.
 */
import { describe, expect, it } from "vitest";
import { GitHubError } from "../../engine/github.js";
import { LimitReached, WriteFailed } from "../../engine/writer.js";
import { fakeGitHub, fakeReader, fakeWriters } from "./fakes.js";

const SHA = "a".repeat(40);

const parsed = (lines: readonly string[]): unknown[] => lines.map((line) => JSON.parse(line));

describe("the writer", () => {
  it("logs each write as it lands, one line each, in order across both tokens", async () => {
    const github = fakeGitHub([{ number: 7, labels: ["agent:x"] }]);
    const { writers, writes, lines } = fakeWriters(github, ["workflow", "loop"], { removeLabel: 1, addLabel: 1, comment: 1 });

    await writers.workflow.removeLabel(7, "agent:x");
    const posted = await writers.loop.comment(7, "hello");
    await writers.loop.addLabel(7, "agent:y");

    expect(writes.map((w) => `${w.token} ${w.type}`)).toEqual(["workflow removeLabel", "loop comment", "loop addLabel"]);
    expect(parsed(lines)).toEqual([
      { seq: 1, token: "workflow", type: "removeLabel", target: "#7 agent:x", outcome: "applied", calls: ["DELETE label ok"] },
      { seq: 2, token: "loop", type: "comment", target: "#7", outcome: "applied", calls: ["POST comment ok"], url: posted.url },
      { seq: 3, token: "loop", type: "addLabel", target: "#7 agent:y", outcome: "applied", calls: ["POST labels ok"] },
    ]);
    expect(github.pullRequests.get(7)?.labels).toEqual(["agent:y"]);
  });

  it("refuses the write past its type's limit, counted across both tokens, and undoes nothing before it", async () => {
    const github = fakeGitHub();
    const { writers, writes, lines } = fakeWriters(github, ["workflow", "loop"], { addLabel: 2 });

    await writers.workflow.addLabel(7, "a");
    await writers.loop.addLabel(7, "b");
    const refused = writers.workflow.addLabel(7, "c");

    await expect(refused).rejects.toBeInstanceOf(LimitReached);
    await expect(refused).rejects.toThrow("addLabel #7 c refused: past the limit of 2");
    expect(writes).toHaveLength(3);
    expect(github.pullRequests.get(7)?.labels).toEqual(["a", "b"]);
    expect(parsed(lines).at(-1)).toEqual({ seq: 3, token: "workflow", type: "addLabel", target: "#7 c", outcome: "refused", calls: [] });
  });

  /** The arm `agent:merge` records is a status the loop's token posts: a cap on the type is all it needs. */
  it("posts a status with the loop's writer under the command's cap, read back with its creator", async () => {
    const github = fakeGitHub();
    const { writers, entries } = fakeWriters(github, ["workflow", "loop"], { setCommitStatus: 1 });

    await writers.loop.setCommitStatus({ sha: SHA, context: "ctx", state: "success", description: "by @someone" });

    expect(entries[0]).toMatchObject({ token: "loop", type: "setCommitStatus", outcome: "applied" });
    expect(await fakeReader(github).reader.commitStatuses(SHA)).toEqual([
      { context: "ctx", state: "success", targetUrl: null, description: "by @someone", creator: "loop" },
    ]);
    await expect(writers.workflow.setCommitStatus({ sha: SHA, context: "ctx", state: "success", description: "" })).rejects.toBeInstanceOf(LimitReached);
  });

  it("refuses a type the command set no limit for", async () => {
    const github = fakeGitHub();
    const { writers } = fakeWriters(github, ["workflow"], { addLabel: 1 });

    await expect(writers.workflow.comment(7, "x")).rejects.toThrow("past the limit of 0");
    expect(github.comments).toEqual([]);
  });

  it("throws a failed write with its entry, and does not latch: the next write still goes", async () => {
    const github = fakeGitHub();
    github.fails = (write) => write.type === "comment";
    const { writers, lines } = fakeWriters(github, ["workflow"], { comment: 1, addLabel: 1 });

    const failed = await writers.workflow.comment(7, "x").catch((error: unknown) => error);
    await writers.workflow.addLabel(7, "after");

    expect(failed).toBeInstanceOf(WriteFailed);
    expect((failed as WriteFailed).entry).toMatchObject({ seq: 1, outcome: "failed", calls: ["POST comment 422 refused by the fake"] });
    expect(parsed(lines).map((l) => (l as { outcome: string }).outcome)).toEqual(["failed", "applied"]);
    expect(github.pullRequests.get(7)?.labels).toEqual(["after"]);
  });

  it("logs a refused call as its label, GitHub's status and its reason, and keeps the raw answer apart, on the failed write only", async () => {
    const github = fakeGitHub();
    github.fails = (write) => write.type === "comment";
    const { writers, entries } = fakeWriters(github, ["workflow"], { comment: 1, addLabel: 1 });

    const failed = (await writers.workflow.comment(7, "x").catch((error: unknown) => error)) as WriteFailed;
    await writers.workflow.addLabel(7, "after");

    expect(entries[0]?.calls).toEqual(["POST comment 422 refused by the fake"]);
    expect(entries[0]?.response).toBe(JSON.stringify({ message: "refused by the fake", documentation_url: "https://docs.github.com/rest" }));
    expect(entries[1]).toEqual({ seq: 2, token: "workflow", type: "addLabel", target: "#7 after", outcome: "applied", calls: ["POST labels ok"] });
    // The sentence a failure comment is built from still names the call and GitHub's reason.
    expect(failed.message).toBe("comment #7 failed: POST comment 422 refused by the fake");
  });

  it("logs a GitHub failure with no status as its label and reason", async () => {
    const github = fakeGitHub();
    github.fails = () => ({ landed: false });
    const { writers, entries } = fakeWriters(github, ["workflow"], { addLabel: 1 });

    await expect(writers.workflow.addLabel(7, "a")).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]).toEqual({
      seq: 1,
      token: "workflow",
      type: "addLabel",
      target: "#7 a",
      outcome: "failed",
      calls: ["POST labels An internal error occurred, by the fake"],
    });
  });

  it("logs reply-then-resolve partial where the reply landed and the resolve did not", async () => {
    const github = fakeGitHub();
    github.threads.set(7, new Map([["T1", { replies: [] }]]));
    github.fails = (_write, call) => call === "resolve";
    const { writers, entries } = fakeWriters(github, ["workflow"], { replyAndResolve: 1 });

    await expect(writers.workflow.replyAndResolve({ threadId: "T1", reply: "done", reason: "ADDRESSED" })).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]?.response).toContain("refused by the fake");
    expect(entries[0]).toMatchObject({ target: "T1 ADDRESSED", outcome: "partial", calls: ["reply ok", "resolve 422 refused by the fake"] });
    expect(github.threads.get(7)?.get("T1")).toEqual({ replies: ["done"] });
  });

  it("logs reply-then-resolve failed where the reply did not land, and never resolves without it", async () => {
    const github = fakeGitHub();
    github.threads.set(7, new Map([["T1", { replies: [] }]]));
    github.fails = (_write, call) => call === "reply";
    const { writers, entries } = fakeWriters(github, ["workflow"], { replyAndResolve: 1 });

    await expect(writers.workflow.replyAndResolve({ threadId: "T1", reply: "done", reason: "WONT_FIX" })).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]).toMatchObject({ outcome: "failed", calls: ["reply 422 refused by the fake"] });
    expect(github.threads.get(7)?.get("T1")).toEqual({ replies: [] });
  });

  it("replies and leaves the thread open, and a command limited to replies cannot close one", async () => {
    const github = fakeGitHub();
    github.threads.set(7, new Map([["T1", { replies: [] }]]));
    const { writers, writes, entries } = fakeWriters(github, ["workflow"], { reply: 2 });

    await writers.workflow.reply({ threadId: "T1", body: "fixed in the next push" });
    await expect(writers.workflow.replyAndResolve({ threadId: "T1", reply: "x", reason: "ADDRESSED" })).rejects.toBeInstanceOf(LimitReached);

    expect(entries[0]).toEqual({ seq: 1, token: "workflow", type: "reply", target: "T1", outcome: "applied", calls: ["reply ok"] });
    expect(github.threads.get(7)?.get("T1")).toEqual({ replies: ["fixed in the next push"] });
    expect(writes.map((w) => w.type)).toEqual(["reply", "replyAndResolve"]);
  });

  it("logs a failed reply as failed, and resolves nothing", async () => {
    const github = fakeGitHub();
    github.threads.set(7, new Map([["T1", { replies: [] }]]));
    github.fails = (write) => write.type === "reply";
    const { writers, entries } = fakeWriters(github, ["workflow"], { reply: 1 });

    await expect(writers.workflow.reply({ threadId: "T1", body: "b" })).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]).toMatchObject({ outcome: "failed", calls: ["reply 422 refused by the fake"] });
    expect(github.threads.get(7)?.get("T1")).toEqual({ replies: [] });
  });

  it("pushes and deletes a ref under its lease in the fake, logs a lost lease failed, and caps both", async () => {
    const github = fakeGitHub();
    github.branches.set("feature", SHA);
    const next = "b".repeat(40);
    const { writers, entries } = fakeWriters(github, ["loop"], { pushRef: 3, deleteRef: 1 });

    await writers.loop.pushRef({ ref: "refs/heads/feature", commit: next, lease: { tip: SHA } });
    await expect(writers.loop.pushRef({ ref: "refs/heads/feature", commit: SHA, lease: { tip: SHA } })).rejects.toBeInstanceOf(WriteFailed);
    await writers.loop.pushRef({ ref: "refs/heads/rescue", commit: next, lease: { absent: true } });
    await writers.loop.deleteRef({ ref: "refs/heads/rescue", lease: { tip: next } });
    await expect(writers.loop.pushRef({ ref: "refs/heads/other", commit: next, lease: { absent: true } })).rejects.toBeInstanceOf(LimitReached);

    expect(entries.map((e) => `${e.type} ${e.target} ${e.outcome}`)).toEqual([
      "pushRef refs/heads/feature bbbbbbb over aaaaaaa applied",
      "pushRef refs/heads/feature aaaaaaa over aaaaaaa failed",
      "pushRef refs/heads/rescue bbbbbbb new applied",
      "deleteRef refs/heads/rescue at bbbbbbb applied",
      "pushRef refs/heads/other bbbbbbb new refused",
    ]);
    expect(entries[1]?.calls).toEqual(["git push rejected: [rejected] (stale info)"]);
    expect([...github.branches]).toEqual([["feature", next]]);
  });

  it("is unchanged in the fake where the ref is already at the commit, whatever the lease says, as git reports it", async () => {
    const github = fakeGitHub();
    github.branches.set("feature", SHA);
    const { writers, entries } = fakeWriters(github, ["loop"], { pushRef: 2 });

    expect(await writers.loop.pushRef({ ref: "refs/heads/feature", commit: SHA, lease: { tip: "b".repeat(40) } })).toEqual({ outcome: "unchanged" });
    expect(await writers.loop.pushRef({ ref: "refs/heads/feature", commit: SHA, lease: { absent: true } })).toEqual({ outcome: "unchanged" });

    expect(entries.map((e) => e.outcome)).toEqual(["unchanged", "unchanged"]);
    expect([...github.branches]).toEqual([["feature", SHA]]);
  });

  it("resolves alone a thread that already carries its reply", async () => {
    const github = fakeGitHub();
    github.threads.set(7, new Map([["T1", { replies: ["earlier"] }]]));
    const { writers, entries } = fakeWriters(github, ["workflow"], { replyAndResolve: 1 });

    await writers.workflow.replyAndResolve({ threadId: "T1", reply: undefined, reason: "ADDRESSED" });

    expect(entries[0]).toMatchObject({ target: "T1 ADDRESSED (already replied)", outcome: "applied", calls: ["resolve ok"] });
    expect(github.threads.get(7)?.get("T1")).toEqual({ replies: ["earlier"], resolved: "ADDRESSED" });
  });

  it("edits a pull request's body against the live body, and leaves it where the edit returns nothing", async () => {
    const github = fakeGitHub([{ number: 7, title: "Old", body: "A maintainer wrote this." }]);
    const { writers, entries } = fakeWriters(github, ["workflow"], { editPullRequest: 2 });
    github.pullRequests.get(7)!.body = "A maintainer wrote this, and more while the run worked.";

    await writers.workflow.editPullRequest(7, { title: "New", body: (live) => `${live}\n\nAppended.` });
    const left = await writers.workflow.editPullRequest(7, { body: () => undefined });

    expect(github.pullRequests.get(7)).toMatchObject({ title: "New", body: "A maintainer wrote this, and more while the run worked.\n\nAppended." });
    expect(left).toEqual({ outcome: "unchanged" });
    expect(entries.map((e) => [e.target, e.outcome, e.calls])).toEqual([
      ["#7 title body", "applied", ["GET pull ok", "PATCH title+body ok"]],
      ["#7 body", "unchanged", ["GET pull ok"]],
    ]);
  });

  it("logs a throw from an edit's own body function, with no GitHub write made", async () => {
    const github = fakeGitHub();
    const { writers, entries } = fakeWriters(github, ["workflow"], { editPullRequest: 1 });

    await expect(
      writers.workflow.editPullRequest(7, {
        body: () => {
          throw new Error("half a block");
        },
      }),
    ).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]).toMatchObject({ outcome: "failed", calls: ["GET pull ok", "half a block"] });
  });

  it("is what the fake reader reads next", async () => {
    const github = fakeGitHub([{ number: 7, draft: true }]);
    const { reader, reads } = fakeReader(github);
    const { writers } = fakeWriters(github, ["workflow"], { markReadyForReview: 2, setCommitStatus: 1 });

    expect((await reader.pullRequest(7)).draft).toBe(true);
    await writers.workflow.markReadyForReview(7);
    const again = await writers.workflow.markReadyForReview(7);
    await writers.workflow.setCommitStatus({ sha: SHA, context: "ctx", state: "success", description: "d" });

    expect((await reader.pullRequest(7)).draft).toBe(false);
    expect(again).toEqual({ outcome: "unchanged" });
    expect(await reader.commitStatuses(SHA)).toEqual([{ context: "ctx", state: "success", targetUrl: null, description: "d", creator: "workflow" }]);
    expect(reads.map((r) => r.method)).toEqual(["pullRequest", "pullRequest", "commitStatuses"]);
  });
});

describe("the fake reader's follow-ups reads", () => {
  it("reads a pull request's review history, the issues carrying a label newest first, and the repository's labels", async () => {
    const github = fakeGitHub([{ number: 7 }]);
    const history = [{ author: "bot", body: "b", lastEditedAt: null, url: "u" }];
    github.reviewHistory.set(7, history);
    github.repoLabels.push("pr-follow-up");
    github.filed.set(3, { title: "a", body: "old", state: "CLOSED", stateReason: "COMPLETED" });
    github.filed.set(5, { title: "b", body: "new", state: "OPEN", stateReason: null });
    github.filed.set(4, { title: "c", body: "unlabelled", state: "OPEN", stateReason: null });
    github.issueLabels.set(3, ["pr-follow-up"]);
    github.issueLabels.set(5, ["pr-follow-up"]);
    const { reader, reads } = fakeReader(github);

    expect(await reader.reviewHistory(7)).toEqual(history);
    expect((await reader.labelledIssues("pr-follow-up")).map((issue) => [issue.number, issue.state, issue.body])).toEqual([
      [5, "OPEN", "new"],
      [3, "CLOSED", "old"],
    ]);
    expect(await reader.repoLabels()).toEqual(["pr-follow-up"]);
    await expect(reader.reviewHistory(8)).rejects.toBeInstanceOf(GitHubError);
    expect(reads.map((r) => r.method)).toEqual(["reviewHistory", "labelledIssues", "repoLabels", "reviewHistory"]);
  });

  it("lists an issue the fake writer creates", async () => {
    const github = fakeGitHub([{ number: 7 }]);
    const { reader } = fakeReader(github);
    const { writers } = fakeWriters(github, ["workflow"], { createIssue: 1 });

    const created = await writers.workflow.createIssue({ title: "t", body: "b", labels: ["x"], readBack: { label: "x", matches: () => true } });

    expect(created).toEqual({ outcome: "applied", number: 8, url: "https://github.com/o/r/issues/8" });
    expect(await reader.labelledIssues("x")).toEqual([{ number: 8, url: created.url, state: "OPEN", stateReason: null, body: "b" }]);
  });
});

describe("the fake reader's merge reads", () => {
  it("reads a commit's checks, whether a head is behind, a login's permission and the labelled pull requests into a base, as a test scripts them", async () => {
    const github = fakeGitHub([
      { number: 7, baseRef: "main", labels: ["armed"] },
      { number: 8, baseRef: "main", labels: ["armed", "other"], headSha: "b".repeat(40) },
      { number: 9, baseRef: "main", labels: [] },
      { number: 10, baseRef: "next", labels: ["armed"] },
    ]);
    const checks = [{ kind: "checkRun" as const, name: "verify", status: "COMPLETED", conclusion: "SUCCESS", required: true }];
    github.checks.set(SHA, checks);
    github.comparisons.set(`main...${SHA}`, "ahead");
    github.comparisons.set(`main...${"b".repeat(40)}`, "diverged");
    github.comparisons.set("main...c", "odd");
    github.permissions.set("maintainer", "maintain");
    const { reader, reads } = fakeReader(github);

    expect(await reader.commitChecks(SHA, 7)).toEqual(checks);
    expect(await reader.commitChecks("b".repeat(40), 8)).toEqual([]);
    expect([await reader.behindBase("main", SHA), await reader.behindBase("main", "b".repeat(40)), await reader.behindBase("main", "c")]).toEqual([
      "current",
      "behind",
      "unknown",
    ]);
    await expect(reader.behindBase("main", "d")).rejects.toBeInstanceOf(GitHubError);
    expect(await reader.permission("maintainer")).toBe("maintain");
    await expect(reader.permission("stranger")).rejects.toBeInstanceOf(GitHubError);
    expect(await reader.openPullRequestsLabelled("main", "armed")).toEqual([
      { number: 8, headSha: "b".repeat(40), labels: ["armed", "other"], draft: false },
      { number: 7, headSha: SHA, labels: ["armed"], draft: false },
    ]);
    expect(reads.map((r) => r.method)).toEqual([
      "commitChecks",
      "commitChecks",
      "behindBase",
      "behindBase",
      "behindBase",
      "behindBase",
      "permission",
      "permission",
      "openPullRequestsLabelled",
    ]);
  });
});

describe("the log's last line", () => {
  it("says the command finished, and how many writes it made", async () => {
    const github = fakeGitHub();
    const { writers, log, lines } = fakeWriters(github, ["workflow"], { addLabel: 1 });

    await writers.workflow.addLabel(7, "a");
    log.end();

    expect(parsed(lines).at(-1)).toEqual({ ended: "finished", writes: 1 });
  });

  /** A failure the loop caught is a `failed` line the ending does not name; the one that stopped it, it does. */
  it("names the write that stopped the command, apart from one the loop tolerated", async () => {
    const github = fakeGitHub();
    github.threads.set(7, new Map([["T1", { replies: [] }]]));
    github.fails = (write, call) => call === "resolve" || write.type === "postReview";
    const { writers, log, lines } = fakeWriters(github, ["workflow"], { replyAndResolve: 1, postReview: 1 });

    const command = async (): Promise<void> => {
      await writers.workflow.replyAndResolve({ threadId: "T1", reply: "r", reason: "ADDRESSED" }).catch(() => undefined);
      await writers.workflow.postReview({ pullRequestId: "PR_7", commitOID: SHA, body: "b", threads: [] });
    };
    const error = await command().catch((e: unknown) => e);
    log.end(error);

    expect(parsed(lines)).toEqual([
      expect.objectContaining({ seq: 1, outcome: "partial" }),
      expect.objectContaining({ seq: 2, outcome: "failed" }),
      { ended: "stopped", writes: 2, by: 2, reason: (error as Error).message },
    ]);
  });

  /** The loop rethrows a write's failure as a sentence, with the write's error as its cause, and the log still names the write. */
  it("names the write a sentence was thrown for, through its cause", async () => {
    const github = fakeGitHub();
    github.fails = (write) => write.type === "postReview";
    const { writers, log, lines } = fakeWriters(github, ["workflow"], { postReview: 1 });

    const failed = await writers.workflow
      .postReview({ pullRequestId: "PR_7", commitOID: SHA, body: "b", threads: [] })
      .catch((e: unknown) => e);
    log.end(new Error("GitHub refused the review, so it was not posted.", { cause: failed }));

    expect(parsed(lines).at(-1)).toEqual({ ended: "stopped", writes: 1, by: 1, reason: "GitHub refused the review, so it was not posted." });
  });

  it("records a stop no write caused, by its reason alone", () => {
    const { log, lines } = fakeWriters(fakeGitHub(), ["workflow"], {});

    log.end(new Error("the hand-over names another pull request"));

    expect(parsed(lines)).toEqual([{ ended: "stopped", writes: 0, reason: "the hand-over names another pull request" }]);
  });
});
