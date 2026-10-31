import { afterEach, describe as group, expect, it, vi } from "vitest";
import { LimitReached, WriteFailed, type LogEntry } from "../engine/writer.js";
import { describe, inWriteLog, issueNumber, pullRequestNumber, seconds, tolerated } from "../shared/command-helpers.js";

const entry: LogEntry = { seq: 1, token: "workflow", type: "comment", target: "#7", outcome: "failed", calls: ["POST comment 500 boom"] };

afterEach(() => vi.restoreAllMocks());

group("tolerated", () => {
  it("is true where the write landed, and says nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await tolerated("Could not comment.", async () => {})).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("is false where GitHub refused the write, and says the warning as given", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      await tolerated("Could not comment.", async () => {
        throw new WriteFailed(entry);
      }),
    ).toBe(false);
    expect(log).toHaveBeenCalledWith("::warning::Could not comment.");
  });

  it("says nothing on a refused write that has no warning", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      await tolerated(undefined, async () => {
        throw new WriteFailed(entry);
      }),
    ).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("still throws a write past its limit, which is our own bug", async () => {
    await expect(
      tolerated("Could not comment.", async () => {
        throw new LimitReached(entry, 1);
      }),
    ).rejects.toBeInstanceOf(LimitReached);
  });

  it("still throws anything that is not a failed write", async () => {
    await expect(
      tolerated("Could not comment.", async () => {
        throw new TypeError("not a write");
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

group("inWriteLog", () => {
  it("points the reader at the write log, after the warning", () => {
    expect(inWriteLog("Could not comment.")).toBe("Could not comment. GitHub's reply is in the write log.");
  });
});

group("describe", () => {
  it("is an error's message, or the value as text", () => {
    expect(describe(new Error("boom"))).toBe("boom");
    expect(describe("plain")).toBe("plain");
  });
});

group("the shared input parsers", () => {
  it("read a number of seconds, and refuse anything else by its input's name", () => {
    expect(seconds("0", "HEAD_WAIT_SECONDS")).toBe(0);
    expect(() => seconds("1.5", "HEAD_WAIT_SECONDS")).toThrow('HEAD_WAIT_SECONDS is "1.5", which is not a number of seconds.');
  });

  it("read an issue number, never zero", () => {
    expect(issueNumber("42")).toBe(42);
    expect(() => issueNumber("0")).toThrow('ISSUE_NUMBER is "0", which is not an issue number.');
  });

  it("read a pull request number, never one with a sign", () => {
    expect(pullRequestNumber("7")).toBe(7);
    expect(() => pullRequestNumber("-7")).toThrow('PR_NUMBER is "-7", which is not a pull request number.');
  });
});
