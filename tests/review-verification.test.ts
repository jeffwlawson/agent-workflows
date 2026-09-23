import { afterEach, describe, expect, it, vi } from "vitest";
import { findingMarker } from "../shared/review-findings.js";
import {
  carriedFindings,
  parseVerification,
  renderCarriedFindings,
  renderSettledFindings,
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
        reason: "ADDRESSED",
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
    expect(verifyCarried([], [])).toEqual({ resolutions: [], stillOpen: [], resolved: [] });
  });

  /**
   * And what closed is reported separately from what was *resolved on GitHub*,
   * because a body-recorded finding has no thread to close: it stops being
   * re-listed, and the record is the only place that closure is ever visible.
   */
  it("reports a landed body entry as resolved though there is no thread to close", () => {
    const { resolutions, resolved, stillOpen } = verifyCarried(
      [{ id: "f-9", text: "`src/other.ts:88` — the cache key omits the tenant" }],
      [landed("f-9")],
    );

    expect(resolutions).toEqual([]);
    expect(stillOpen).toEqual([]);
    expect(resolved.map((f) => f.id)).toEqual(["f-9"]);
  });
});

/**
 * **The maintainer's decisions stick** (#109, decision 10; #112). Two halves,
 * and they fail in opposite directions if either is got wrong.
 *
 * A thread a human resolved is settled: raising it again — in the same words or
 * in new ones — is the loop overruling the person it works for, and it does so
 * silently, because nothing on the pull request records that the finding is one
 * a maintainer already closed.
 *
 * A thread a maintainer replied to declining the finding is settled too, but
 * only the **workflow** may say so. The gate is `maintainerReply`, which is
 * present only where a trusted author wrote it (`shared/pr-feedback.ts`), so a
 * decline typed by anyone at all cannot close a finding by being believed.
 */
describe("a maintainer's decision settles a finding", () => {
  const declined = (id: string): VerificationEntry => ({ id, status: "declined" });

  const REPLY = { login: "maintainer", body: "Won't fix — the duplicate write is intended here." };

  describe("renderSettledFindings", () => {
    it("names who settled it, so the reviewer can see it was not this loop", () => {
      const rendered = renderSettledFindings([
        { findingId: "f-7", resolvedBy: "maintainer", text: "src/queue.ts:206 — the guard runs after the return" },
      ]);

      expect(rendered).toContain("@maintainer");
      expect(rendered).toContain("src/queue.ts:206 — the guard runs after the return");
      expect(rendered).toMatch(/do not raise/i);
    });

    /**
     * An empty section reads as one the run failed to fill in, which is the
     * reading that makes a reviewer discount the heading above it.
     */
    it("says so in words when the maintainer has settled nothing", () => {
      expect(renderSettledFindings([])).toContain("no finding");
    });
  });

  describe("parseVerification", () => {
    it("reads a decline, which is the third thing a review may say", () => {
      expect(parseVerification({ id: "f-1", status: "declined" })).toEqual({
        id: "f-1",
        status: "declined",
      });
    });
  });

  describe("verifyCarried", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const CARRIED: readonly CarriedFinding[] = [
      { id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return", maintainerReply: REPLY },
      { id: "f-2", threadId: "PRRT_two", text: "the new test asserts the old behaviour" },
    ];

    /**
     * `WONT_FIX` rather than `ADDRESSED`: the code did not change, the person
     * who owns it decided. GitHub takes the reason and shows it to nobody, so
     * the reply is where that distinction survives.
     */
    it("closes a declined thread as won't fix, quoting the maintainer", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { resolutions, stillOpen } = verifyCarried(CARRIED, [declined("f-1")]);

      expect(resolutions).toEqual([
        {
          threadId: "PRRT_one",
          findingId: "f-1",
          reason: "WONT_FIX",
          reply: expect.stringContaining("> Won't fix — the duplicate write is intended here."),
        },
      ]);
      expect(resolutions[0]?.reply).toContain("@maintainer");
      expect(stillOpen.map((f) => f.id)).toEqual(["f-2"]);
    });

    /** And a verified fix still closes as addressed, which is the other reason. */
    it("closes a landed thread as addressed", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(verifyCarried(CARRIED, [landed("f-2")]).resolutions[0]?.reason).toBe("ADDRESSED");
    });

    /**
     * **The author gate, structurally.** A review may misread a reply — it is
     * prose — but it can only misread one that reached it, and only a trusted
     * author's reply is carried. So a decline with no maintainer behind it
     * leaves the thread open, which is the direction this has to fail in: the
     * loop never closes a finding on an untrusted stranger's say-so.
     */
    it("leaves a decline open where no maintainer replied on the thread", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { resolutions, stillOpen } = verifyCarried(CARRIED, [declined("f-2"), landed("f-1")]);

      expect(resolutions.map((r) => r.findingId)).toEqual(["f-1"]);
      expect(stillOpen.map((f) => f.id)).toEqual(["f-2"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("f-2"));
    });

    /**
     * A body-recorded finding has no thread for anybody to reply on, so a
     * decline of one is a ruling about a conversation that cannot have
     * happened. It stays open and keeps counting.
     */
    it("leaves a declined body entry open, since no maintainer could have replied", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const carried: readonly CarriedFinding[] = [{ id: "f-3", text: "the cache key omits the tenant" }];

      const { resolutions, stillOpen } = verifyCarried(carried, [declined("f-3")]);

      expect(resolutions).toEqual([]);
      expect(stillOpen.map((f) => f.id)).toEqual(["f-3"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("f-3"));
    });
  });
});
