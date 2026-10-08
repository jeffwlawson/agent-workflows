/**
 * The writer's discipline (ADR 0005), through the fakes a command's test uses:
 * limits, the throw, the log and its last line, over two tokens at once.
 */
import { describe, expect, it } from "vitest";
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
    expect((failed as WriteFailed).entry).toMatchObject({ seq: 1, outcome: "failed", calls: ["POST comment POST comment: 422 refused by the fake"] });
    expect(parsed(lines).map((l) => (l as { outcome: string }).outcome)).toEqual(["failed", "applied"]);
    expect(github.pullRequests.get(7)?.labels).toEqual(["after"]);
  });

  it("logs reply-then-resolve partial where the reply landed and the resolve did not", async () => {
    const github = fakeGitHub();
    github.threads.set(7, new Map([["T1", { replies: [] }]]));
    github.fails = (_write, call) => call === "resolve";
    const { writers, entries } = fakeWriters(github, ["workflow"], { replyAndResolve: 1 });

    await expect(writers.workflow.replyAndResolve({ threadId: "T1", reply: "done", reason: "ADDRESSED" })).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]).toMatchObject({ target: "T1 ADDRESSED", outcome: "partial", calls: ["reply ok", "resolve resolve: 422 refused by the fake"] });
    expect(github.threads.get(7)?.get("T1")).toEqual({ replies: ["done"] });
  });

  it("logs reply-then-resolve failed where the reply did not land, and never resolves without it", async () => {
    const github = fakeGitHub();
    github.threads.set(7, new Map([["T1", { replies: [] }]]));
    github.fails = (_write, call) => call === "reply";
    const { writers, entries } = fakeWriters(github, ["workflow"], { replyAndResolve: 1 });

    await expect(writers.workflow.replyAndResolve({ threadId: "T1", reply: "done", reason: "WONT_FIX" })).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]).toMatchObject({ outcome: "failed", calls: ["reply reply: 422 refused by the fake"] });
    expect(github.threads.get(7)?.get("T1")).toEqual({ replies: [] });
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
    expect(await reader.commitStatuses(SHA)).toEqual([{ context: "ctx", state: "success", targetUrl: null, creator: "workflow" }]);
    expect(reads.map((r) => r.method)).toEqual(["pullRequest", "pullRequest", "commitStatuses"]);
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
