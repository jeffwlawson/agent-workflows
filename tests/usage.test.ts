import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { sumResults, sumTranscript, usageSummary, type PassUsage } from "../shared/usage.js";

/**
 * A recorded session (#637): a work pass and the extraction pass resumed into
 * the same file, as Claude Code writes them. One message written as two lines,
 * one per content block; a `<synthetic>` message no model answered; a cache
 * write with no TTL split; a torn last line. And each pass's stream, whose
 * result event carries the output the transcript's placeholders do not.
 */
const FIXTURES = path.join("tests", "fixtures", "usage");
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const lines = (name: string): string[] => fixture(name).split("\n");

describe("sumTranscript: a pass's tokens, from the session transcript", () => {
  it("sums each assistant message once, by id, and splits the cache write by TTL", () => {
    const { messages, ...totals } = sumTranscript(fixture("session.jsonl"), new Set());

    expect(totals).toEqual({
      turns: 3,
      models: ["claude-opus-5-5"],
      inputTokens: 3 + 1 + 2,
      cacheReadTokens: 0 + 5000 + 5300,
      // msg_02's 300 is 5m; msg_03's 120 has no split, and is the default's.
      cacheWrite5mTokens: 300 + 120,
      cacheWrite1hTokens: 5000,
    });
    expect(messages).toEqual(["msg_01", "msg_02", "msg_03"]);
  });

  it("counts none of the messages an earlier pass counted, for the pass that resumed its session", () => {
    const totals = sumTranscript(fixture("session.jsonl"), new Set(["msg_01", "msg_02"]));

    expect(totals).toMatchObject({ turns: 1, inputTokens: 2, cacheReadTokens: 5300, cacheWrite5mTokens: 120, cacheWrite1hTokens: 0 });
  });

  it("refuses a transcript with no assistant message to count, rather than reading it as nothing spent", () => {
    expect(() => sumTranscript("not a transcript\n{\"type\":\"user\"}\n", new Set())).toThrow(/no assistant message/);
    expect(() => sumTranscript(fixture("session.jsonl"), new Set(["msg_01", "msg_02", "msg_03"]))).toThrow(/no assistant message/);
  });
});

describe("sumResults: a pass's output and cost, from the stream's result events", () => {
  it("takes the output from modelUsage, every model's, not the transcript's placeholders", () => {
    const placeholders = 2 + 1 + 1;
    const totals = sumResults(lines("work-stream.jsonl"));

    expect(totals).toEqual({ outputTokens: 900 + 87, costUsd: 0.4321 });
    expect(totals.outputTokens).not.toBe(placeholders);
  });

  it("falls back to the event's usage where it has no modelUsage, and has no cost where it gives none", () => {
    expect(sumResults(lines("extract-stream.jsonl"))).toEqual({ outputTokens: 55, costUsd: null });
  });

  it("adds a pass's events up, one per agent process it started", () => {
    expect(sumResults([...lines("extract-stream.jsonl"), ...lines("extract-stream.jsonl")])).toEqual({ outputTokens: 110, costUsd: null });
  });

  it("has neither where the stream ended on no result event", () => {
    expect(sumResults([lines("work-stream.jsonl")[0] ?? ""])).toEqual({ outputTokens: null, costUsd: null });
  });
});

describe("usageSummary: the line a run's summary shows", () => {
  const work: PassUsage = {
    pass: "work",
    available: true,
    turns: 2,
    models: ["claude-opus-5-5"],
    inputTokens: 4,
    cacheReadTokens: 5000,
    cacheWrite5mTokens: 300,
    cacheWrite1hTokens: 5000,
    outputTokens: 987,
    costUsd: 0.4321,
  };

  it("names each pass's tokens by kind, its turns, its models and its cost, with the effort", () => {
    expect(usageSummary("default", [work, { ...work, pass: "extract", turns: 1, outputTokens: null, costUsd: null }])).toBe(
      "Agent usage (effort default): " +
        "work: 2 turns on claude-opus-5-5, input 4, cache read 5,000, cache write 300 (5m) and 5,000 (1h), output 987, about $0.43; " +
        "extract: 1 turn on claude-opus-5-5, input 4, cache read 5,000, cache write 300 (5m) and 5,000 (1h), output unavailable, cost unavailable.",
    );
  });

  it("says usage is unavailable, with each reason, where no pass could be read", () => {
    expect(usageSummary("default", [{ pass: "work", available: false, reason: "no transcript" }])).toBe(
      "Agent usage unavailable: work: usage unavailable (no transcript).",
    );
    expect(usageSummary("high", [work, { pass: "extract", available: false, reason: "no transcript" }])).toMatch(
      /^Agent usage \(effort high\): work: .*; extract: usage unavailable \(no transcript\)\.$/,
    );
  });
});
