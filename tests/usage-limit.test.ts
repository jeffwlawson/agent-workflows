import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopAccounts } from "../shared/loop-accounts.js";
import { IMPLEMENT_LABEL, resetTime, resumeNoteMark, SERVICE_ORCHESTRATOR, USAGE_LIMIT } from "../shared/record.js";
import { limitEnding, newestResumeNote, RESET_GRACE_MINUTES, usageLimitReset } from "../shared/usage-limit.js";

/**
 * The plan's usage limit (#635): the recogniser that reads the reset instant
 * off a failure reason, the resume note's reader, and which ending a conclude
 * command takes, with the bound on one automatic resume per item.
 */

const SESSION = "claude-code exited with code 1: You've hit your session limit · resets 5:50am (UTC)";
const HOURLY = "claude-code exited with code 1: You've hit your session limit · resets 11am (UTC)";
const at = (iso: string): Date => new Date(iso);
const MINUTE_MS = 60 * 1000;

describe("usageLimitReset reads the reset instant off the CLI's message", () => {
  it("answers the stated time later the same day", () => {
    expect(usageLimitReset(SESSION, at("2026-11-01T01:10:00Z"))).toEqual(at("2026-11-01T05:50:00Z"));
    expect(usageLimitReset(HOURLY, at("2026-11-01T06:00:00Z"))).toEqual(at("2026-11-01T11:00:00Z"));
  });

  it("answers the next day's where today's has passed, across midnight", () => {
    expect(usageLimitReset(SESSION, at("2026-11-01T23:30:00Z"))).toEqual(at("2026-11-02T05:50:00Z"));
    expect(usageLimitReset(HOURLY, at("2026-11-01T12:30:00Z"))).toEqual(at("2026-11-02T11:00:00Z"));
    expect(usageLimitReset(SESSION, at("2026-12-31T22:00:00Z"))).toEqual(at("2027-01-01T05:50:00Z"));
  });

  // The message is read after it was written: by conclude a phase or a job
  // after the worker, each on its own clock. Each reads the same instant.
  it("answers today's where it passed within the grace, as a reader later than the run, or on a clock ahead of it, reads it", () => {
    expect(usageLimitReset(SESSION, at("2026-11-01T05:49:00Z"))).toEqual(at("2026-11-01T05:50:00Z"));
    expect(usageLimitReset(SESSION, at("2026-11-01T05:50:00Z"))).toEqual(at("2026-11-01T05:50:00Z"));
    expect(usageLimitReset(SESSION, at("2026-11-01T05:51:00Z"))).toEqual(at("2026-11-01T05:50:00Z"));
    expect(usageLimitReset(SESSION, new Date(Date.parse("2026-11-01T05:50:00Z") + RESET_GRACE_MINUTES * MINUTE_MS - 1))).toEqual(at("2026-11-01T05:50:00Z"));
    expect(usageLimitReset(SESSION, new Date(Date.parse("2026-11-01T05:50:00Z") + RESET_GRACE_MINUTES * MINUTE_MS))).toEqual(at("2026-11-02T05:50:00Z"));
  });

  it("answers yesterday's where it passed within the grace across midnight", () => {
    const LATE = "You've hit your session limit · resets 11:50pm (UTC)";
    expect(usageLimitReset(LATE, at("2026-11-01T23:49:00Z"))).toEqual(at("2026-11-01T23:50:00Z"));
    expect(usageLimitReset(LATE, at("2026-11-02T00:10:00Z"))).toEqual(at("2026-11-01T23:50:00Z"));
    expect(usageLimitReset(LATE, at("2027-01-01T00:10:00Z"))).toEqual(at("2026-12-31T23:50:00Z"));
  });

  it("reads 12am as midnight and 12pm as noon", () => {
    expect(usageLimitReset("You've hit your session limit · resets 12am (UTC)", at("2026-11-01T20:00:00Z"))).toEqual(at("2026-11-02T00:00:00Z"));
    expect(usageLimitReset("You've hit your weekly limit · resets 12:30pm (UTC)", at("2026-11-01T08:00:00Z"))).toEqual(at("2026-11-01T12:30:00Z"));
  });

  it("answers nothing for any other shape", () => {
    const ended = at("2026-11-01T01:10:00Z");
    for (const reason of [
      "You've hit your session limit · resets 5:50am (Europe/London)",
      "You've hit your session limit · resets 5:50am",
      "You've hit your session limit",
      "You've hit your session limit · resets 13:50am (UTC)",
      "You've hit your session limit · resets 5:75am (UTC)",
      "claude-code exited with code 1: rate limited, try again later",
      "It timed out after 30 minutes.",
      "",
      undefined,
    ]) {
      expect(usageLimitReset(reason, ended), String(reason)).toBeUndefined();
    }
  });
});

describe("a resume note", () => {
  const accounts = loopAccounts("loop-app[bot]");
  const note = (until: string, stopped: string): string => `waiting\n\n${resumeNoteMark(until, stopped)}\n`;

  it("is the newest the loop's accounts posted, never one anyone else did", () => {
    const comments = [
      { body: note("2026-11-01T05:50:00.000Z", "2026-11-01T01:00:00.000Z"), author: "loop-app[bot]" },
      { body: note("2026-11-02T05:50:00.000Z", "2026-11-01T02:00:00.000Z"), author: "loop-app" },
      { body: note("2026-11-09T05:50:00.000Z", "2026-11-01T03:00:00.000Z"), author: "someone" },
    ];
    expect(newestResumeNote(comments, accounts)).toEqual({ until: at("2026-11-02T05:50:00Z"), stopped: at("2026-11-01T02:00:00Z") });
    expect(newestResumeNote([comments[2]!], accounts)).toBeUndefined();
    expect(newestResumeNote([{ body: "no note", author: "loop-app[bot]" }], accounts)).toBeUndefined();
  });

  it("is what the service's ending ends with", () => {
    expect(newestResumeNote([{ body: USAGE_LIMIT.resumes(IMPLEMENT_LABEL, at("2026-11-01T05:50:00Z"), at("2026-11-01T01:00:00Z")), author: "loop-app" }], accounts)).toEqual({
      until: at("2026-11-01T05:50:00Z"),
      stopped: at("2026-11-01T01:00:00Z"),
    });
    expect(resetTime(at("2026-11-01T05:50:00Z"))).toBe("2026-11-01 05:50 UTC");
  });
});

describe("limitEnding decides which ending a stopped run takes", () => {
  const accounts = loopAccounts("loop-app[bot]");
  const now = at("2026-11-01T01:10:00Z");
  const reader = (comments: { body: string; author: string }[], events: { at: string; actor: string }[], fails = false) => ({
    authoredComments: async () => {
      if (fails) throw new Error("GitHub answered 502");
      return comments.map((comment) => ({ ...comment, association: "NONE" }));
    },
    labelledAt: async () => events.map((event) => event.at),
  });
  const ending = (github: ReturnType<typeof reader>, reason = SESSION, orchestrator: string = SERVICE_ORCHESTRATOR) =>
    limitEnding({ reason, orchestrator, item: 12, label: IMPLEMENT_LABEL, github, accounts, now });

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is nothing where the reason is not the usage limit", async () => {
    expect(await ending(reader([], []), "It stopped without giving a reason.")).toBeUndefined();
  });

  it("waits for a person on Actions, reading nothing", async () => {
    expect(await ending(reader([], [], true), SESSION, "actions")).toEqual({ kind: "waits", until: at("2026-11-01T05:50:00Z"), stopped: now });
  });

  it("resumes on the service the first time", async () => {
    expect(await ending(reader([], [{ at: "2026-11-01T01:00:00Z", actor: "maintainer" }]))).toEqual({
      kind: "resumes",
      until: at("2026-11-01T05:50:00Z"),
      stopped: now,
    });
  });

  it("ends as any stop where the item already resumed since the label was last added", async () => {
    const earlier = { body: resumeNoteMark("2026-10-31T05:50:00.000Z", "2026-10-31T01:00:00.000Z"), author: "loop-app[bot]" };
    const events = [
      { at: "2026-10-30T09:00:00Z", actor: "maintainer" },
      { at: "2026-10-30T23:00:00Z", actor: "loop-app[bot]" },
    ];
    expect(await ending(reader([earlier], events))).toBeUndefined();
  });

  it("resumes once more where a person added the label after the last resume note", async () => {
    const earlier = { body: resumeNoteMark("2026-10-31T05:50:00.000Z", "2026-10-31T01:00:00.000Z"), author: "loop-app[bot]" };
    expect((await ending(reader([earlier], [{ at: "2026-10-31T09:00:00Z", actor: "maintainer" }])))?.kind).toBe("resumes");
  });

  // The App adds most `agent:review` and `agent:fix` labels, and re-adds a PRD
  // parent's `agent:implement` after each slice: each a new request, which a
  // resume note from an earlier one does not use up.
  it("resumes once more where the loop's own account added the label after the last resume note", async () => {
    const earlier = { body: resumeNoteMark("2026-10-31T05:50:00.000Z", "2026-10-31T01:00:00.000Z"), author: "loop-app[bot]" };
    const events = [
      { at: "2026-10-30T09:00:00Z", actor: "maintainer" },
      { at: "2026-10-31T09:00:00Z", actor: "loop-app[bot]" },
    ];
    expect((await ending(reader([earlier], events)))?.kind).toBe("resumes");
  });

  it("ends as any stop where the record cannot be read", async () => {
    expect(await ending(reader([], [], true))).toBeUndefined();
  });
});
