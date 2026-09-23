import { afterEach, describe, expect, it, vi } from "vitest";
import { findingMarker } from "../shared/review-findings.js";
import {
  carriedFindings,
  parseVerification,
  renderCarriedFindings,
  verifyCarried,
  type AgentThread,
  type CarriedFinding,
  type VerificationEntry,
} from "../shared/review-verification.js";

/**
 * The half of #109 decision 1 that is a derivation rather than a workflow step:
 * what an earlier review left open, and what this review's ruling on each one
 * means.
 *
 * Every failure here is silent by construction. A carried finding that is not
 * assembled is one nobody verifies; a landed one with no resolution is a thread
 * that stays open forever; and — the one that matters most — an *open* one read
 * as settled is a thread that closes with nobody having checked it, on a pull
 * request whose verdict then says there is nothing left to fix.
 */

const thread = (over: Partial<AgentThread> = {}): AgentThread => ({
  threadId: "PRRT_one",
  findingId: "f-1",
  text: "src/queue.ts:206 — the guard runs after the return",
  ...over,
});

const landed = (id: string, note?: string): VerificationEntry => ({
  id,
  status: "landed",
  ...(note === undefined ? {} : { note }),
});

const open = (id: string): VerificationEntry => ({ id, status: "open" });

describe("carriedFindings", () => {
  it("carries an open thread this loop opened, with the thread to close it on", () => {
    expect(carriedFindings({ threads: [thread()], latestReviewBody: "" })).toEqual([
      {
        id: "f-1",
        threadId: "PRRT_one",
        text: "src/queue.ts:206 — the guard runs after the return",
      },
    ]);
  });

  /**
   * A finding in a file the pull request never touched has no thread at all
   * (#110), so the review body is the only record of it. It is carried with no
   * `threadId`, which is what tells the caller there is nothing to resolve.
   */
  it("carries an entry from the latest review body, with no thread", () => {
    const body = [
      "**Still open from an earlier review**",
      "",
      `- [ ] \`src/other.ts:88\` — the cache key omits the tenant ${findingMarker("f-9")}`,
    ].join("\n");

    expect(carriedFindings({ threads: [], latestReviewBody: body })).toEqual([
      { id: "f-9", text: "`src/other.ts:88` — the cache key omits the tenant" },
    ]);
  });

  /**
   * The two surfaces should be disjoint — a threaded finding's id is left off
   * the body deliberately, so the thread stays its only record — and this is
   * what happens when they are not, whether from another version's body or an
   * id somehow written twice. The thread's copy wins because it is the one
   * carrying the id of a thing that can be *closed*: take the body's and a
   * landed finding leaves its thread open, which is the failure that looks like
   * everything working.
   */
  it("prefers the thread's copy of a finding the body also names", () => {
    const body = `- [ ] \`src/queue.ts:206\` — stated differently ${findingMarker("f-1")}`;

    expect(carriedFindings({ threads: [thread()], latestReviewBody: body })).toEqual([
      {
        id: "f-1",
        threadId: "PRRT_one",
        text: "src/queue.ts:206 — the guard runs after the return",
      },
    ]);
  });

  it("carries nothing for the first review of a pull request", () => {
    expect(carriedFindings({ threads: [], latestReviewBody: "" })).toEqual([]);
  });

  /**
   * A review body carries the follow-ups payload and whatever prose the model
   * wrote. Only the finding markers are entries.
   */
  it("reads only the finding markers out of a body full of other things", () => {
    const body = [
      "### 🟡 Changes recommended",
      "",
      "A paragraph mentioning agent-finding in passing.",
      "",
      '<!-- agent-follow-ups {"version":1,"dropped":0,"followUps":[]} -->',
      "",
      findingMarker("f-3"),
      "",
      "**`src/other.ts:88` — the cache key omits the tenant**",
    ].join("\n");

    expect(carriedFindings({ threads: [], latestReviewBody: body })).toEqual([
      { id: "f-3", text: "`src/other.ts:88` — the cache key omits the tenant" },
    ]);
  });
});

describe("renderCarriedFindings", () => {
  it("leads with the id, which is what the review answers on", () => {
    const rendered = renderCarriedFindings([
      { id: "f-1", threadId: "PRRT_one", text: "src/queue.ts:206 — the guard runs after the return" },
    ]);

    expect(rendered).toBe("- `f-1` — src/queue.ts:206 — the guard runs after the return");
  });

  /**
   * Nothing carried is a statement rather than a gap: a prompt section that
   * rendered as empty reads as a section the run failed to fill in.
   */
  it("says so in words when there is nothing to verify", () => {
    expect(renderCarriedFindings([])).toContain("no finding from an earlier review");
  });
});

describe("parseVerification", () => {
  it("keeps the id, the status and the note", () => {
    expect(parseVerification({ id: "f-1", status: "landed", note: "the guard moved" })).toEqual({
      id: "f-1",
      status: "landed",
      note: "the guard moved",
    });
  });

  it("accepts findingId, since the model reaches for it", () => {
    expect(parseVerification({ findingId: "f-1", status: "open" })).toEqual({
      id: "f-1",
      status: "open",
    });
  });

  /**
   * A note is display, and the review it is part of is not worth losing over
   * one. A *status* this file cannot read is refused, because there is no safe
   * reading of it: "landed" and "open" are opposite actions.
   */
  it("drops a blank note rather than refusing the entry", () => {
    expect(parseVerification({ id: "f-1", status: "landed", note: "   " })).toEqual({
      id: "f-1",
      status: "landed",
    });
  });

  it("refuses a status it does not know, naming what it got", () => {
    expect(() => parseVerification({ id: "f-1", status: "partly" })).toThrow(/"partly"/);
  });

  it("refuses an entry with no id at all", () => {
    expect(() => parseVerification({ status: "landed" })).toThrow(/verification id/);
  });
});

describe("verifyCarried", () => {
  // Restored whatever the assertions did, rather than at the end of each test:
  // an expectation that throws before its own cleanup leaves `console.warn`
  // mocked for every test after it.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const CARRIED: readonly CarriedFinding[] = [
    { id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return" },
    { id: "f-2", threadId: "PRRT_two", text: "the new test asserts the old behaviour" },
    { id: "f-3", text: "the cache key omits the tenant" },
  ];

  it("resolves a landed thread, quoting the review's reason", () => {
    const { resolutions, stillOpen } = verifyCarried(CARRIED, [
      landed("f-1", "The guard now runs before `apply()`."),
      open("f-2"),
      open("f-3"),
    ]);

    expect(resolutions).toEqual([
      {
        threadId: "PRRT_one",
        findingId: "f-1",
        reply: expect.stringContaining("The guard now runs before `apply()`."),
      },
    ]);
    expect(stillOpen.map((f) => f.id)).toEqual(["f-2", "f-3"]);
  });

  /**
   * `resolutionReason` is recorded by GitHub and exposed nowhere afterwards, so
   * the reply is the whole record — including of *who* closed it, which is the
   * decision this slice is about.
   */
  it("says in the reply that the review closed it rather than the fix", () => {
    const [resolution] = verifyCarried(CARRIED, [landed("f-1")]).resolutions;

    expect(resolution?.reply).toContain("Verified fixed.");
    expect(resolution?.reply).toContain("Resolved by the review that checked it");
  });

  /**
   * A body-recorded finding has no thread, so there is nothing to close: it
   * lands by ceasing to be re-listed, and must not become a resolution naming a
   * thread that does not exist.
   */
  it("closes a landed body entry by leaving it out of both lists", () => {
    const { resolutions, stillOpen } = verifyCarried(CARRIED, [
      landed("f-3"),
      open("f-1"),
      open("f-2"),
    ]);

    expect(resolutions).toEqual([]);
    expect(stillOpen.map((f) => f.id)).toEqual(["f-1", "f-2"]);
  });

  /**
   * The safe direction, and the one this whole design turns on. A review that
   * ran out of attention before it reached the last finding must not thereby
   * close it: a finding nobody checked is not a finding anybody settled.
   */
  it("keeps a finding the review said nothing about open", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolutions, stillOpen } = verifyCarried(CARRIED, [landed("f-1")]);

    expect(resolutions.map((r) => r.findingId)).toEqual(["f-1"]);
    expect(stillOpen.map((f) => f.id)).toEqual(["f-2", "f-3"]);
  });

  /**
   * Models invent plausible-looking ids, exactly as `filterOutcomes` says they
   * invent thread ids. An invented one here would resolve nothing at best and,
   * on a collision, close a finding this review never looked at.
   */
  it("drops a ruling on an id nobody handed over", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolutions } = verifyCarried(CARRIED, [landed("f-made-up"), landed("f-1")]);

    expect(resolutions.map((r) => r.findingId)).toEqual(["f-1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("f-made-up"));
  });

  /** One finding, one ruling: the first, so a thread cannot be replied to twice. */
  it("takes the first of two rulings on one finding", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolutions, stillOpen } = verifyCarried(CARRIED, [
      open("f-1"),
      landed("f-1"),
      landed("f-2"),
      landed("f-3"),
    ]);

    expect(resolutions.map((r) => r.findingId)).toEqual(["f-2"]);
    expect(stillOpen.map((f) => f.id)).toEqual(["f-1"]);
  });

  it("has nothing to do on the first review of a pull request", () => {
    expect(verifyCarried([], [])).toEqual({ resolutions: [], stillOpen: [] });
  });
});
