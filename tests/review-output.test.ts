import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiffLines } from "../shared/diff-lines.js";
import {
  findingMarker,
  placeFindings,
  findingsHandOver,
  reviewThreads,
  severityBadge,
  type Finding,
  type PlacedFinding,
  type Severity,
} from "../shared/review-findings.js";
import type { CarriedFinding } from "../shared/review-verification.js";
import {
  capFollowUps,
  CLOSER_LOOK,
  followUpsCap,
  countFixBeforeMerge,
  deriveVerdict,
  hasFollowUpsBlock,
  MAX_FOLLOW_UPS,
  MAX_HOW_CHECKED_WORDS,
  MAX_SUMMARY_WORDS,
  MAX_TITLE_LENGTH,
  parseFollowUpsBlock,
  recordFollowUps,
  renderFollowUpsBlock,
  renderFollowUpsGroup,
  RESOLVED_GROUP,
  reviewBodyHandOver,
  UNCLOSED_GROUP,
  REVIEW_BODY_LIMIT,
  reviewBodySize,
  PREVIOUSLY_MISSED_SUBTITLE,
  reviewOutputSchema,
  reviewRecord,
  VERDICTS,
  type CiResult,
  type FollowUp,
  type ReviewOutput,
  type VerdictRow,
} from "../shared/review-output.js";
import { FOLLOW_UPS_MARKER, VERDICT_CONTEXT } from "../shared/record.js";
import { renderDecided, postDecided, type Decided } from "./review/decided.js";

/** Every row a verdict can post: the table's three, and each cause of a closer look. */
const EVERY_ROW: readonly VerdictRow[] = [
  ...Object.values(VERDICTS),
  ...Object.values(CLOSER_LOOK).map((lines) => ({ ...VERDICTS["needs a closer look"], ...lines })),
];

/**
 * These guard the review's posting path rather than the linter. GitHub rejects
 * an *entire* review if any one anchor falls outside the diff, so a bug here
 * does not degrade a review — it silently posts nothing. Where each finding is
 * anchored, and what happens to one that cannot be, is
 * `tests/review-findings.test.ts`.
 */

const parse = (value: unknown) => {
  const result = reviewOutputSchema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error(result.issues.map((i) => i.message).join("; "));
  }
  return (result as { value: ReviewOutput }).value;
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  title: "t",
  path: "src/a.ts",
  line: 10,
  body: "x",
  severity: "medium",
  ...over,
});

describe("reviewOutputSchema", () => {
  it("accepts a multi-line range and keeps startLine", () => {
    const out = parse({
      summary: "s",
      findings: [{ path: "src/a.ts", startLine: 8, line: 10, body: "b" }],
    });
    expect(out.findings[0]).toMatchObject({ startLine: 8, line: 10 });
  });

  it("accepts snake_case start_line, since the model emits both", () => {
    const out = parse({
      summary: "s",
      findings: [{ path: "src/a.ts", start_line: 8, line: 10, body: "b" }],
    });
    expect(out.findings[0]?.startLine).toBe(8);
  });

  /**
   * And the field's own former name. `inlineComments` was what this list was
   * called until placement stopped being the model's to state (#110); a model
   * prompted for one shape still reaches for the other, and a review whose
   * findings silently defaulted to empty would post *approval recommended*.
   */
  it("accepts the field's former name, since the model reaches for it", () => {
    const out = parse({
      summary: "s",
      inlineComments: [{ path: "src/a.ts", line: 10, body: "b" }],
    });
    expect(out.findings).toHaveLength(1);
  });

  it("drops startLine when it equals line — GitHub rejects a zero-width range", () => {
    const out = parse({
      summary: "s",
      findings: [{ path: "src/a.ts", startLine: 10, line: 10, body: "b" }],
    });
    expect(out.findings[0]?.startLine).toBeUndefined();
  });

  it("rejects an inverted range rather than posting a 422", () => {
    expect(() =>
      parse({ summary: "s", findings: [{ path: "src/a.ts", startLine: 11, line: 10, body: "b" }] }),
    ).toThrow(/startLine must be <= line/);
  });

  it("omits startLine entirely for a single-line anchor", () => {
    const out = parse({ summary: "s", findings: [{ path: "src/a.ts", line: 10, body: "b" }] });
    expect("startLine" in (out.findings[0] ?? {})).toBe(false);
  });
});

/**
 * The third output channel (#47). It is not a posting hazard like the two
 * above — an over-long list cannot 422 a review — but it is the only record of
 * a finding this PR will not fix, and it survives the merge by being written
 * into the review body. So the properties worth holding are: the schema never
 * loses a review over it, the cap is applied where it can be counted, and what
 * the renderer writes a reader can parse back.
 */

const followUp = (over: Partial<FollowUp> = {}): FollowUp => ({
  title: "t",
  location: "src/a.ts",
  body: "b",
  severity: "medium",
  ...over,
});

const followUps = (n: number): FollowUp[] =>
  Array.from({ length: n }, (_, i) => followUp({ title: `t${i}`, location: `src/${i}.ts` }));

/**
 * What a reader of the block does, written out here rather than imported.
 * `parseFollowUpsBlock` is the real one and is exercised below, but a
 * round-trip test that only ever reads through it cannot tell a format from a
 * pair of functions that happen to agree. The regex is the whole contract — a
 * marker, a space, one line of JSON — so pinning it here is pinning what any
 * reader may assume.
 */
const payloadOf = (block: string): { version: number; dropped: number; followUps: FollowUp[] } => {
  const match = new RegExp(`<!-- ${FOLLOW_UPS_MARKER} (.*) -->`).exec(block);
  if (!match?.[1]) throw new Error("no payload comment in the block");
  return JSON.parse(match[1]) as { version: number; dropped: number; followUps: FollowUp[] };
};

/**
 * **The three prose fields**, and the two of them the schema holds to a size.
 *
 * A prompt-only "under 250 words" is a limit with nothing behind it, and the
 * body it produced ran long enough to bury the record above it. So the cap is
 * here, where a review cannot talk its way past it — and it **truncates**
 * rather than refuses, which is the choice `capFollowUps` and `parseFinding`
 * both make: a reviewer that wrote a long paragraph has not produced a broken
 * review, and refusing it would lose every finding in it.
 */
describe("reviewOutputSchema: the prose beside the findings", () => {
  it("keeps the review's assessment, and reads a blank one as absent", () => {
    expect(parse({ assessment: "Undo-safe state handling is wrong here." }).assessment).toBe(
      "Undo-safe state handling is wrong here.",
    );
    for (const blank of [undefined, null, "", "   "]) {
      expect(parse({ assessment: blank }).assessment).toBeUndefined();
    }
  });

  it("truncates howChecked at the hard limit rather than losing the review", () => {
    const long = Array.from({ length: MAX_HOW_CHECKED_WORDS + 40 }, (_, i) => `w${i}`).join(" ");

    const kept = parse({ howChecked: long }).howChecked ?? "";

    expect(kept.split(/\s+/)).toHaveLength(MAX_HOW_CHECKED_WORDS);
    expect(kept.endsWith("…")).toBe(true);
    expect(kept.startsWith("w0 w1 ")).toBe(true);
  });

  it("leaves a howChecked inside the limit exactly as written", () => {
    expect(parse({ howChecked: "Ran the suite; traced `apply()`." }).howChecked).toBe(
      "Ran the suite; traced `apply()`.",
    );
  });

  /**
   * The PR's title and its summary block (#218), capped by the schema like the
   * other prose fields rather than only asked for in the brief.
   */
  it("holds the title to one line and the length cap", () => {
    expect(parse({ title: "  feat(review):\nwrite the title  " }).title).toBe("feat(review): write the title");

    const long = parse({ title: "x".repeat(MAX_TITLE_LENGTH + 20) }).title ?? "";
    expect(Array.from(long)).toHaveLength(MAX_TITLE_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("caps the summary by words and keeps its lines as written", () => {
    const summary = "Moves the description.\n\n- one\n- two";
    expect(parse({ summary }).summary).toBe(summary);

    const words = Array.from({ length: MAX_SUMMARY_WORDS + 10 }, (_, i) => `w${i}`);
    const long = parse({ summary: `${words.slice(0, 5).join(" ")}\n\n- ${words.slice(5).join(" ")}` }).summary ?? "";
    expect(long.startsWith("w0 w1 w2 w3 w4\n\n- w5 ")).toBe(true);
    // The bullet's `-` is a word as well, so the last one kept is one sooner.
    expect(long.endsWith(` w${MAX_SUMMARY_WORDS - 2}…`)).toBe(true);
  });

  /**
   * **A sketch is outside the budget** (#354). The brief asks for up to two
   * fenced sketches beside the prose and holds only the prose to the cap, so
   * the cap counts no word inside a fence: a sketch neither spends the prose's
   * words nor is cut mid-fence, which would leave the fence open over the rest
   * of the body.
   */
  it("counts no word inside a fenced sketch, and never cuts one", () => {
    const sketch = ["```diff", ...Array.from({ length: MAX_SUMMARY_WORDS }, (_, i) => `+ s${i} x`), "```"].join("\n");
    const tilde = "~~~text\nloop-token\n  App secrets set? → App token\n~~~";
    const prose = Array.from({ length: MAX_SUMMARY_WORDS - 1 }, (_, i) => `w${i}`).join(" ");
    const summary = `${prose}\n\n${sketch}\n\n${tilde}\n\nlast`;
    expect(parse({ summary }).summary).toBe(summary);

    const over = parse({ summary: `${sketch}\n\n${prose} one two` }).summary ?? "";
    expect(over).toBe(`${sketch}\n\n${prose} one…`);
  });

  /**
   * The block's own markers are HTML comments, so a summary carrying one would
   * end the block early, or open a second, the next time it is spliced.
   */
  it("takes HTML comments out of the title and the summary", () => {
    const out = parse({
      title: "fix: <!-- agent:summary -->the guard",
      summary: "Text.\n<!-- /agent:summary -->\nMore.<!-- unterminated",
    });

    expect(out.title).toBe("fix: the guard");
    expect(out.summary).toBe("Text.\n\nMore.");
  });

  /**
   * `whatChanged` is the field `summary` replaced, and a model prompted for the
   * new shape may still reach for the old one: its sentence and lines are kept
   * as the summary, never read as the assessment.
   */
  it("reads the field this replaced as the summary, never as the assessment", () => {
    const out = parse({ whatChanged: { summary: "It moves thread resolution.", changes: ["a", "b"] } });

    expect(out.summary).toBe("It moves thread resolution.\n\n- a\n- b");
    expect(out.assessment).toBeUndefined();
  });

  it("reads a summary that is not prose as no summary rather than refusing the review", () => {
    expect(parse({ summary: ["a"] }).summary).toBeUndefined();
    expect(parse({ summary: 3, title: 4 }).title).toBeUndefined();
  });

  it("carries none of the prose fields when the model wrote none of them", () => {
    const out = parse({});

    expect(out.assessment).toBeUndefined();
    expect(out.howChecked).toBeUndefined();
    expect(out.title).toBeUndefined();
    expect(out.summary).toBeUndefined();
  });
});

describe("reviewOutputSchema: follow-ups", () => {
  it("defaults followUps to empty when the model emits none", () => {
    expect(parse({ summary: "s" }).followUps).toEqual([]);
  });

  it("keeps a follow-up's fields, and rates an unrated one in the middle", () => {
    const out = parse({
      summary: "s",
      followUps: [{ title: "Leak in parse()", location: "src/a.ts:12", body: "evidence" }],
    });

    expect(out.followUps).toEqual([
      { title: "Leak in parse()", location: "src/a.ts:12", body: "evidence", severity: "medium" },
    ]);
  });

  it("accepts snake_case follow_ups, since the model emits both", () => {
    expect(parse({ summary: "s", follow_ups: [followUp()] }).followUps).toHaveLength(1);
  });

  /**
   * The cap is a *runner* concern and must never be a schema one. Extraction
   * throwing here fails the whole output — every finding and all three prose
   * fields with it — so a model that emitted a fourth follow-up would cost the
   * entire review.
   */
  it("does not throw on more than the cap", () => {
    expect(parse({ summary: "s", followUps: followUps(5) }).followUps).toHaveLength(5);
  });
});

/** The body's Merge Danger (#356): the review's door, blast radius and breaking changes, read leniently. */
describe("the Merge Danger fields", () => {
  it("reads each part, and leaves each out where there is none", () => {
    expect(
      parse({
        summary: "s",
        door: "One way",
        doorNote: "  A published\n release.  ",
        blastRadius: "**adopters**.",
        blastRadiusNote: "From the next release.",
        breaking: ["Rename the input.", "- **Breaking:** Drop the trigger.", "  ", 4],
      }),
    ).toMatchObject({
      door: "one-way",
      doorNote: "A published release.",
      blastRadius: "adopters",
      blastRadiusNote: "From the next release.",
      breaking: ["Rename the input.", "Drop the trigger."],
    });
    const none = parse({ summary: "s", door: "sideways", doorNote: " ", blastRadius: "", breaking: [] });
    for (const field of ["door", "doorNote", "blastRadius", "blastRadiusNote", "breaking"]) {
      expect(none).not.toHaveProperty(field);
    }
  });

  it("takes either spelling of the door, and the first word of a blast radius", () => {
    expect(parse({ door: "two_way", blast_radius: "every adopter" })).toMatchObject({ door: "two-way", blastRadius: "every" });
    expect(parse({ door: "TWO-WAY", breaking: "One bare line." })).toMatchObject({ door: "two-way", breaking: ["One bare line."] });
  });

  /** Retired (#356): breaking changes are `breaking`, and the rest are the summary's own bullets. */
  it("no longer reads behaviourChanges", () => {
    expect(parse({ summary: "s", behaviourChanges: [{ change: "c", breaking: true }] })).not.toHaveProperty(
      "behaviourChanges",
    );
  });
});

/** The Evidence's test sketches (#355): which test, and what it checks, the placing left to the workflow. */
describe("testSketches", () => {
  it("reads each sketch, unwraps one fenced whole, drops one naming no test or sketching nothing, and leaves the field out where there are none", () => {
    expect(
      parse({
        summary: "s",
        testSketches: [
          { test: " test_a ", sketch: "call a\nexpect b\n" },
          { test: "test_b", sketch: "```python\nb()\n```" },
          { test: "", sketch: "x" },
          { test: "test_c", sketch: "  " },
          "test_d",
        ],
      }).testSketches,
    ).toEqual([
      { test: "test_a", sketch: "call a\nexpect b" },
      { test: "test_b", sketch: "b()" },
    ]);
    expect(parse({ summary: "s", test_sketches: [{ test: "t", sketch: "k" }] }).testSketches).toHaveLength(1);
    expect(parse({ summary: "s" })).not.toHaveProperty("testSketches");
  });
});

describe("capFollowUps", () => {
  it("keeps the first three and reports what it dropped", () => {
    const { kept, dropped } = capFollowUps(followUps(5));

    expect(kept.map((f) => f.title)).toEqual(["t0", "t1", "t2"]);
    expect(dropped).toBe(2);
  });

  it("drops nothing under the cap", () => {
    expect(capFollowUps(followUps(2))).toEqual({ kept: followUps(2), dropped: 0 });
  });

  it("caps at three", () => {
    expect(MAX_FOLLOW_UPS).toBe(3);
  });
});

/**
 * **A moved finding leads the follow-ups, and the cap does not reach it**
 * (#127, decision 3).
 *
 * Leading is the ordinary half: the order is the filing order, and a finding
 * the review meant to stop the merge with reads ahead of a note about a
 * function the diff only calls.
 *
 * Exempt is the half that matters. The cap is a *survivable* loss for the
 * model's list — it wrote that list knowing it was out of scope and was told in
 * the brief where it would be cut, and the body and the post-merge report both
 * announce what went. For a moved finding it is not a loss at all but a
 * deletion: it is already off the `**Findings:**` count and out of the record,
 * so the follow-ups are the last surface it has. Four unanchored findings
 * behind a plain `slice(0, 3)` put the fourth nowhere — no thread, no record
 * entry, no payload, no stub — under a body stating that four were moved.
 */
describe("recordFollowUps", () => {
  const moved = (over: Partial<Finding> = {}): Finding => ({
    title: "the cache key omits the tenant",
    path: "src/other.ts",
    line: 88,
    body: "**Fix before merge.** `key()` hashes the id and not the tenant.",
    severity: "high",
    ...over,
  });

  it("puts the moved findings in front of the ones the model recorded", () => {
    const { followUps: list, moved: prefix } = recordFollowUps([moved()], followUps(2));

    expect(list.map((f) => f.title)).toEqual(["the cache key omits the tenant", "t0", "t1"]);
    expect(prefix).toBe(1);
  });

  /**
   * A mistyped path is the one case the moved note's inference does not hold
   * for, and the filed stub is where its reader meets it — so that entry says
   * the path was a slip rather than that the change is uninvolved.
   */
  it("tells a path error's reader the change may still be involved", () => {
    const typo = moved({ path: "src/othr.ts" });
    const placedElsewhere = moved({ title: "a second one" });
    const [first, second] = recordFollowUps([typo, placedElsewhere], [], [typo]).followUps;

    expect(first?.body).toContain("its path is no file in the repository");
    expect(first?.body).not.toContain("nothing in the change caused it");
    expect(second?.body).toContain("nothing in the change caused it");
  });

  it("keeps the finding whole, and says how it got here", () => {
    const [entry] = recordFollowUps([moved()], []).followUps;

    expect(entry).toMatchObject({
      title: "the cache key omits the tenant",
      location: "src/other.ts:88",
      severity: "high",
    });
    expect(entry?.body).toContain("`key()` hashes the id and not the tenant.");
    expect(entry?.body).toContain("moved");
  });

  /** The cap reads the model's list, and reads it from the start of that list. */
  it("spends the cap on the model's entries, not on the slots the moved ones took", () => {
    const { followUps: list, dropped } = recordFollowUps([moved()], followUps(4));

    expect(list.map((f) => f.title)).toEqual([
      "the cache key omits the tenant",
      "t0",
      "t1",
      "t2",
    ]);
    expect(dropped).toBe(1);
  });

  /**
   * And past the cap in *moved* findings the list simply runs longer, because
   * the alternative is deleting one. This is the case the body's
   * "4 findings were moved" line would otherwise be counting over three.
   */
  it("keeps every moved finding, however many the diff gave no anchor to", () => {
    const four = [1, 2, 3, 4].map((n) => moved({ title: `moved ${n}`, line: n }));
    const { followUps: list, moved: prefix, dropped } = recordFollowUps(four, followUps(1));

    expect(list).toHaveLength(5);
    expect(list.slice(0, 4).map((f) => f.title)).toEqual([
      "moved 1",
      "moved 2",
      "moved 3",
      "moved 4",
    ]);
    expect(prefix).toBe(4);
    expect(dropped).toBe(0);
  });

  it("changes nothing where nothing was moved, but the id each entry is given", () => {
    const ids = ["fu-00000001", "fu-00000002"];
    expect(recordFollowUps([], followUps(2), [], { nextId: () => ids.shift() ?? "" })).toEqual({
      followUps: followUps(2).map((f, i) => ({ ...f, id: `fu-0000000${i + 1}` })),
      moved: 0,
      dropped: 0,
      cap: 3,
      carried: false,
    });
  });

  /** The id is the workflow's: one the model wrote cannot name an earlier round's entry. */
  it("gives everything this round records a fresh id, whatever the model wrote", () => {
    const { followUps: list } = recordFollowUps([moved()], [followUp({ id: "fu-forged00" })]);

    expect(list.map((f) => f.id)).not.toContain("fu-forged00");
    expect(list.every((f) => /^fu-[0-9a-f]{8}$/.test(f.id ?? ""))).toBe(true);
  });
});

/**
 * **A PRD PR's newest review carries forward every earlier round's follow-ups**
 * (#247), de-duplicated by id, under a cap of three per landed slice: the body
 * the filing end reads is the newest one alone, and each round there is scoped
 * to one slice, so no round restates another's.
 */
describe("recordFollowUps on a PRD PR", () => {
  const entry = (id: string, over: Partial<FollowUp> = {}): FollowUp =>
    followUp({ id, title: id, location: `src/${id}.ts`, ...over });
  const counter = (): (() => string) => {
    let n = 0;
    return () => `fu-new0000${(n += 1)}`;
  };

  it("carries forward what earlier rounds recorded, each once by id, ahead of this round's", () => {
    const slice1 = { moved: [], rest: [entry("fu-aaaaaaa1"), entry("fu-aaaaaaa2")] };
    // The same slice's next round, holding one of the same entries.
    const slice1Again = { moved: [], rest: [entry("fu-aaaaaaa2"), entry("fu-aaaaaaa3")] };
    const { followUps: list, dropped } = recordFollowUps([], [followUp({ title: "new" })], [], {
      cap: followUpsCap(2),
      carried: [slice1, slice1Again],
      nextId: counter(),
    });

    expect(list.map((f) => f.title)).toEqual(["fu-aaaaaaa1", "fu-aaaaaaa2", "fu-aaaaaaa3", "new"]);
    expect(list.map((f) => f.id)).toEqual(["fu-aaaaaaa1", "fu-aaaaaaa2", "fu-aaaaaaa3", "fu-new00001"]);
    expect(dropped).toBe(0);
  });

  it("keeps an earlier round's moved findings in the exempt prefix", () => {
    const earlier = { moved: [entry("fu-moved001")], rest: [entry("fu-rest0001")] };
    const { followUps: list, moved: prefix } = recordFollowUps([], [followUp({ title: "new" })], [], {
      carried: [earlier, earlier],
      nextId: counter(),
    });

    expect(list.map((f) => f.title)).toEqual(["fu-moved001", "fu-rest0001", "new"]);
    expect(prefix).toBe(1);
  });

  it("de-duplicates an entry from before ids only where it is the same entry byte for byte", () => {
    const old = followUp({ title: "no id" });
    const { followUps: list } = recordFollowUps([], [], [], {
      carried: [{ moved: [], rest: [old] }, { moved: [], rest: [old, followUp({ title: "no id", body: "reworded" })] }],
    });

    expect(list.map((f) => f.body)).toEqual([old.body, "reworded"]);
  });

  it("caps at three per landed slice, dropping the newest", () => {
    const earlier = { moved: [], rest: [1, 2, 3, 4, 5].map((n) => entry(`fu-0000000${n}`)) };
    const { followUps: list, dropped, cap } = recordFollowUps([], followUps(3), [], {
      cap: followUpsCap(2),
      carried: [earlier],
      nextId: counter(),
    });

    expect(cap).toBe(6);
    expect(list).toHaveLength(6);
    expect(list.map((f) => f.title)).toEqual([
      "fu-00000001",
      "fu-00000002",
      "fu-00000003",
      "fu-00000004",
      "fu-00000005",
      "t0",
    ]);
    expect(dropped).toBe(2);
  });

  /**
   * The order is not re-ranked, so where earlier rounds lead the list the cap
   * drops the newest whatever their severity, and the body says that rather
   * than that it kept the most serious.
   */
  it("says the cap dropped the newest, not the least serious, where earlier rounds lead", () => {
    const earlier = { moved: [], rest: [1, 2, 3].map((n) => entry(`fu-0000000${n}`, { severity: "low" })) };
    const recorded = recordFollowUps([], [followUp({ title: "new", severity: "high" })], [], {
      carried: [earlier],
      nextId: counter(),
    });
    const visible = renderFollowUpsBlock(recorded.followUps, recorded.dropped, recorded.moved, recorded.cap, recorded.carried);

    expect(recorded.carried).toBe(true);
    expect(recorded.followUps.map((f) => f.title)).not.toContain("new");
    expect(visible).toContain("Only 3 out-of-scope findings are listed, earlier rounds' first; the newest was dropped by the cap");
    expect(visible).not.toContain("most serious");
    expect(renderFollowUpsGroup(recorded.followUps, recorded.dropped, false, recorded.cap, recorded.carried)).toContain(
      "The cap keeps 3 out-of-scope findings, earlier rounds' first; the newest was dropped by it",
    );
  });

  /** A PRD PR's first round carries nothing, so its list is the model's own order, most serious first. */
  it("keeps the most-serious wording where nothing was carried", () => {
    const recorded = recordFollowUps([], followUps(4), [], { carried: [{ moved: [], rest: [] }] });

    expect(recorded.carried).toBe(false);
    expect(renderFollowUpsBlock(recorded.followUps, recorded.dropped, recorded.moved, recorded.cap, recorded.carried)).toContain(
      "Only the 3 most serious out-of-scope findings are listed; 1 more were dropped by the cap.",
    );
  });

  it("records the cap in the payload, where the filing end reads it back", () => {
    const recorded = recordFollowUps([], followUps(7), [], { cap: followUpsCap(3) });
    const block = parseFollowUpsBlock(
      renderFollowUpsBlock(recorded.followUps, recorded.dropped, recorded.moved, recorded.cap),
    );

    expect(block?.cap).toBe(9);
    expect(block?.followUps).toHaveLength(7);
    expect(block?.followUps.map((f) => f.id)).toEqual(recorded.followUps.map((f) => f.id));
  });
});

describe("followUpsCap", () => {
  it("is three per landed slice", () => {
    expect(followUpsCap(1)).toBe(3);
    expect(followUpsCap(2)).toBe(6);
    expect(followUpsCap(6)).toBe(18);
  });

  /** A regular pull request is one slice, so its cap stays three. */
  it("is three for a regular pull request, and for anything under one slice", () => {
    expect(followUpsCap(1)).toBe(MAX_FOLLOW_UPS);
    expect(followUpsCap(0)).toBe(MAX_FOLLOW_UPS);
    expect(followUpsCap(Number.NaN)).toBe(MAX_FOLLOW_UPS);
    expect(recordFollowUps([], followUps(5)).cap).toBe(MAX_FOLLOW_UPS);
    expect(recordFollowUps([], followUps(5)).dropped).toBe(2);
  });

  /** The filing end reads a cap it cannot trust as three, never as more. */
  it("reads an unreadable recorded cap as three", () => {
    for (const cap of ['"9"', "2", "4.5", "-6", "null"]) {
      const body = `<!-- ${FOLLOW_UPS_MARKER} {"version":1,"dropped":0,"moved":0,"cap":${cap},"followUps":[]} -->`;
      expect(parseFollowUpsBlock(body)?.cap).toBe(MAX_FOLLOW_UPS);
    }
  });
});

describe("renderFollowUpsBlock", () => {
  it("is collapsed, and its summary line names the gesture that opts out", () => {
    const block = renderFollowUpsBlock(followUps(1), 0, 0);

    expect(block).toContain("<details>");
    expect(block).toContain("</details>");
    expect(block).not.toContain("<details open");
    // The opt-out is *removing* a label, and an author who has never seen one
    // of these before learns the mechanism from this line or not at all.
    expect(block).toMatch(/remove[\s\S]*agent:follow-ups/);
  });

  /**
   * Titles and locations, never bodies. The body is in the payload, which is
   * what gets filed; duplicating it into the visible half spends a body with a
   * 65,536-character ceiling to answer a question — *do I want these filed* —
   * that the titles already answer.
   */
  it("renders titles and locations only", () => {
    const block = renderFollowUpsBlock([followUp({ title: "Leak", location: "src/a.ts:12", body: "PROSE" })], 0, 0);
    const visible = block.split(`<!-- ${FOLLOW_UPS_MARKER}`)[0] ?? "";

    expect(visible).toContain("Leak");
    expect(visible).toContain("src/a.ts:12");
    expect(visible).not.toContain("PROSE");
  });

  /**
   * The pre-merge half of announcing truncation. It reaches the author while
   * the PR is still open, which is the only point at which raising the dropped
   * finding is cheap.
   */
  it("states the truncation when the cap bit, and says nothing when it did not", () => {
    const visible = (block: string): string => block.split(`<!-- ${FOLLOW_UPS_MARKER}`)[0] ?? "";

    expect(visible(renderFollowUpsBlock(followUps(3), 2, 0))).toMatch(/2 more were dropped/);
    expect(visible(renderFollowUpsBlock(followUps(3), 0, 0))).not.toMatch(/dropped/i);
  });

  it("carries a versioned payload a reader can parse back", () => {
    const list = [followUp({ title: "Leak", location: "src/a.ts:12", body: "evidence, then why not here" })];

    const payload = payloadOf(renderFollowUpsBlock(list, 1, 0));

    expect(payload).toEqual({ version: 1, dropped: 1, moved: 0, cap: 3, followUps: list });
  });

  /**
   * Model prose is arbitrary text, and `-->` in it would end the comment early
   * — truncating the JSON, which is the difference between a reader that files
   * three findings and one that files none. The escape is in the JSON, so the
   * parse gives the original string back.
   */
  it("survives a body that contains an HTML comment terminator", () => {
    const list = [followUp({ body: "the guard is <!-- gone --> entirely" })];

    expect(payloadOf(renderFollowUpsBlock(list, 0, 0)).followUps).toEqual(list);
  });

  it("names the marker a reader selects on", () => {
    expect(FOLLOW_UPS_MARKER).toBe("agent-follow-ups");
  });

  /**
   * The retraction, and the shape of every review that found nothing out of
   * scope. It has to be *a block* — the reader takes the latest one, so a round
   * that recorded nothing can only supersede round 1 by leaving something — and
   * it has to be invisible, because there is no finding to show and no opt-out
   * to describe. An empty disclosure widget on every review is how a channel
   * teaches people to stop opening it.
   */
  it("writes the empty list as a bare payload, with nothing for a reader to see", () => {
    const block = renderFollowUpsBlock([], 0, 0);

    expect(block).toBe(
      `<!-- ${FOLLOW_UPS_MARKER} {"version":1,"dropped":0,"moved":0,"cap":3,"followUps":[]} -->`,
    );
    expect(block).not.toContain("<details>");
    expect(hasFollowUpsBlock(block)).toBe(true);
    expect(parseFollowUpsBlock(block)).toEqual({ followUps: [], dropped: 0, moved: 0, cut: 0, cap: 3 });
  });
});

/**
 * The other end of the same format (#48). It lives beside the renderer because
 * the two *are* one format: a parser written in the half that files would be a
 * second description of it, drifting from the first on the release that changes
 * either.
 *
 * Its two absences are different answers, which is the whole shape of it. No
 * block is the ordinary case and is answered with silence. A block that cannot
 * be read is a shape this version does not know, and it has to say so rather
 * than guess at fields that may have moved.
 */
describe("parseFollowUpsBlock", () => {
  it("reads back what the renderer wrote, findings and cap alike", () => {
    const list = [followUp({ title: "Leak", location: "src/a.ts:12", body: "evidence" })];

    expect(parseFollowUpsBlock(renderFollowUpsBlock(list, 2, 0))).toEqual({
      followUps: list,
      dropped: 2,
      moved: 0,
      cut: 0,
      cap: 3,
    });
  });

  /**
   * A body posted before #136 opens the group `<b>Follow-ups</b> — 1`, and the
   * merge that files it may run after the upgrade. The reader keys on the
   * marker and never on that summary, so the old prose reads exactly as the new.
   */
  it("reads a v0.4.0 body, whose summary carries an em dash, by its marker alone", () => {
    const list = [followUp({ title: "Leak in parse()", location: "src/other.ts:88" })];
    const body = [
      "<details>",
      "<summary><b>Follow-ups</b> — 1 · filed as issues on merge; remove <code>agent:follow-ups</code> to skip</summary>",
      "",
      "- `Medium` **Leak in parse()** — `src/other.ts:88`",
      "",
      "</details>",
      "",
      renderFollowUpsBlock(list, 0, 0),
    ].join("\n");

    expect(parseFollowUpsBlock(body)?.followUps).toEqual(list);
  });

  it("finds the block wherever it sits in a review body", () => {
    const body = `A summary, with prose above and below.\n\n${renderFollowUpsBlock(followUps(1), 0, 0)}\n\nMore prose.`;

    expect(parseFollowUpsBlock(body)?.followUps).toHaveLength(1);
  });

  /**
   * The block is appended after the summary, and the summary is model prose
   * that may quote one. A body holding two therefore carries the real one last.
   */
  it("takes the last block when a body somehow carries two", () => {
    const body = [
      renderFollowUpsBlock([followUp({ location: "src/quoted.ts" })], 0, 0),
      renderFollowUpsBlock([followUp({ location: "src/real.ts" })], 0, 0),
    ].join("\n\n");

    expect(parseFollowUpsBlock(body)?.followUps.map((f) => f.location)).toEqual(["src/real.ts"]);
  });

  it("returns nothing at all for a body with no block", () => {
    expect(parseFollowUpsBlock("A summary and nothing else.")).toBe(undefined);
    expect(hasFollowUpsBlock("A summary and nothing else.")).toBe(false);
  });

  it("refuses a version it does not know, naming the one it found", () => {
    const body = `<!-- ${FOLLOW_UPS_MARKER} {"version":2,"dropped":0,"followUps":[]} -->`;

    expect(hasFollowUpsBlock(body)).toBe(true);
    expect(() => parseFollowUpsBlock(body)).toThrow(/2/);
  });

  it("refuses a payload it cannot parse", () => {
    expect(() => parseFollowUpsBlock(`<!-- ${FOLLOW_UPS_MARKER} {"version":1, -->`)).toThrow(
      /readable JSON/,
    );
  });

  /**
   * `moved` was added to a payload that keeps its version (#127): it says how
   * many entries at the front of the list the cap must not reach, and a block
   * written before it existed marked none — which is the behaviour that release
   * had. Bumping the version instead would make an *older* filing run refuse
   * the block outright and file nothing at all, which is the worse half of the
   * same compatibility question.
   */
  it("reads a block with no exempt prefix as exempting nothing", () => {
    const body = `<!-- ${FOLLOW_UPS_MARKER} {"version":1,"dropped":0,"followUps":[]} -->`;

    expect(parseFollowUpsBlock(body)).toEqual({ followUps: [], dropped: 0, moved: 0, cut: 0, cap: 3 });
  });

  /**
   * And it is an index into the list, so it is clamped to it. A prefix longer
   * than the list would exempt the whole of one this block did not come from —
   * the cap at the filing end is a belt against exactly that payload.
   */
  it("clamps an exempt prefix longer than the list it indexes", () => {
    const body = renderFollowUpsBlock([followUp()], 0, 9);

    expect(parseFollowUpsBlock(body)?.moved).toBe(1);
    expect(parseFollowUpsBlock(renderFollowUpsBlock([followUp()], 0, -1))?.moved).toBe(0);
  });

  it("refuses a finding missing one of its three fields", () => {
    const body = `<!-- ${FOLLOW_UPS_MARKER} {"version":1,"dropped":0,"followUps":[{"title":"t","body":"b"}]} -->`;

    expect(() => parseFollowUpsBlock(body)).toThrow(/location/);
  });
});

/**
 * The two finding types (#97). Every finding is *fix before merge* or a
 * follow-up, and the first of those has to be **countable from the structured
 * output** rather than read out of the summary: the verdict is derived from the
 * count, and a verdict derived from prose is the sentence nothing acts on that
 * this replaced.
 *
 * Counted from `findings` alone (#224). A second list restating each finding
 * was asked for until then; a model that still writes one has it ignored,
 * neither refused nor counted.
 */
describe("reviewOutputSchema: the two finding types", () => {
  it.each([
    ["fixBeforeMerge", { fixBeforeMerge: ["the guard runs after the return", "a second line"] }],
    ["fix_before_merge", { fix_before_merge: ["the guard runs after the return", "a second line"] }],
    ["a list of objects", { fixBeforeMerge: [{ title: "x" }] }],
  ])("parses an output that still carries %s, and counts and records none of it", (_case, over) => {
    const out = parse({ summary: "s", findings: [{ path: "src/a.ts", line: 10, body: "b" }], ...over });

    expect(out).not.toHaveProperty("fixBeforeMerge");
    expect(out).not.toHaveProperty("fix_before_merge");
    expect(countFixBeforeMerge(out, 0)).toBe(1);
    const record = reviewRecord({ output: out, placed: [], stillOpen: [], resolved: [] });
    expect(record.findings).toBe(0);
    expect(record.open).toEqual([]);
  });

  it("keeps needsYou when the model named the case", () => {
    expect(parse({ summary: "s", needsYou: "the issue asked for the opposite" }).needsYou).toBe(
      "the issue asked for the opposite",
    );
  });

  it("accepts snake_case needs_you, since the model emits both", () => {
    expect(parse({ summary: "s", needs_you: "CI fails and the diff does not explain it" }).needsYou)
      .toBe("CI fails and the diff does not explain it");
  });

  /**
   * Absent is the answer on nearly every review, and a model asked for an
   * optional string says so in three ways. All three have to mean the same
   * thing: read as *present*, an empty string is a review that sends every
   * pull request to a human with no reason given.
   */
  it.each([
    ["omitted", {}],
    ["null", { needsYou: null }],
    ["empty", { needsYou: "" }],
    ["whitespace", { needsYou: "  " }],
  ])("reads %s needsYou as absent", (_case: string, over: Record<string, unknown>) => {
    expect(parse({ summary: "s", ...over }).needsYou).toBeUndefined();
  });
});

/**
 * The verdicts, derived rather than written (#96 decision 2), and named after
 * GitHub's own Copilot code review headings so that a reader who has met one of
 * those already knows what ours mean.
 *
 * The order of the arms is the whole of it: each one is reachable, and a
 * rearrangement that made an earlier arm swallow a later one would still pass a
 * test that only checked the outcomes it happens to produce.
 */
describe("deriveVerdict", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    findings: [],
    followUps: [],
    verified: [],
    ...over,
  });

  it("recommends approval when nothing is wrong and the checks are green", () => {
    expect(deriveVerdict(output(), { autoFix: false, ci: "green", fixRoundProgress: undefined, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe("approval recommended");
  });

  it("recommends changes when the findings are the only thing wrong", () => {
    expect(
      deriveVerdict(output({ findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })] }), { autoFix: false,
        ci: "green",
        fixRoundProgress: undefined,
        stillOpen: 0, movedToFollowUps: 0 }).verdict,
    ).toBe("changes recommended");
  });

  it("needs a closer look when the agent says a fix round cannot settle it", () => {
    expect(
      deriveVerdict(output({ needsYou: "the issue asked for the opposite" }), { autoFix: false,
        ci: "green",
        fixRoundProgress: undefined,
        stillOpen: 0, movedToFollowUps: 0 }).verdict,
    ).toBe("needs a closer look");
  });

  /**
   * The arm with no finding behind it: the checks are red and the review found
   * nothing to fix, so nobody has said what a fix round would even change.
   * That is a human's problem by construction, and it is the case a derivation
   * keyed only on findings would recommend approving.
   */
  it.each([
    ["red", "red"],
    ["unreadable", "unknown"],
  ])("needs a closer look when the checks are %s and the review found nothing", (_case, ci) => {
    expect(deriveVerdict(output(), { autoFix: false, ci: ci as CiResult, fixRoundProgress: undefined, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe(
      "needs a closer look",
    );
  });

  /**
   * Three ways into *needs a closer look*, and one step for each (#209). The
   * action differs by cause and the review knows the cause, so the lines
   * differ; none depends on PRD, auto-fix or round (#297). The key stays the
   * one row's, so everything selecting on it reads all three alike.
   */
  describe("the step a closer look gives, by cause", () => {
    const inputs = { autoFix: false, fixRoundProgress: undefined, stillOpen: 0, movedToFollowUps: 0 } as const;

    /**
     * #201's *Verdict lines*, quoted rather than read back out of
     * `CLOSER_LOOK`, for the reason the commit-status table below is: an
     * expectation derived from the thing it tests moves when that thing is
     * wrong. Each offers merging as is among its ways on (#297).
     */
    it.each([
      [
        "the reviewer asked for a human",
        { needsYou: "the issue asked for the opposite" },
        "green",
        "This needs your judgement before anything is changed. Read the review, then do one of these: (1) comment with what to change and add the `agent:fix` label, (2) push a fix yourself, (3) merge as is if you're satisfied, or (4) close the PR.",
        "Needs a closer look. Read the review, then tell the agent what to fix, fix it yourself, merge as is, or close the PR.",
      ],
      [
        "a check failed with nothing found",
        {},
        "red",
        "A CI check failed, and the review couldn't trace it to the code. Read the failing check named in the review, then do one of these: (1) comment with what to change and add the `agent:fix` label, (2) push a fix yourself, (3) merge as is if the failure doesn't matter here, or (4) close the PR.",
        "Needs a closer look. A CI check failed and the review couldn't trace it to the code. Read the failing check, then fix it or merge as is.",
      ],
      [
        "CI had not finished or could not be read",
        {},
        "unknown",
        "CI hadn't finished, or couldn't be read, when the review ran. Approve any run that's waiting for approval, and once CI is done, add the `agent:review` label to review again. If this change doesn't need CI, you can merge it as is.",
        "Needs a closer look. CI hadn't finished or couldn't be read. Once it's done, add agent:review, or merge as is if CI isn't needed.",
      ],
    ] as const)("gives the table's lines where %s", (_case, over, ci, nextStep, description) => {
      const row = deriveVerdict(output(over), { ...inputs, ci });

      expect(row.verdict).toBe("needs a closer look");
      expect(row.heading).toBe(VERDICTS["needs a closer look"].heading);
      expect(row.state).toBe("failure");
      expect(row.nextStep).toBe(nextStep);
      expect(row.description).toBe(description);
    });

    it.each(["green", "red", "unknown"] as const)(
      "keeps the status line on %s checks inside GitHub's limit, plain, and in the BMP",
      (ci) => {
        const over = ci === "green" ? { needsYou: "x" } : {};
        const row = deriveVerdict(output(over), { ...inputs, ci });

        expect(row.description.length).toBeLessThanOrEqual(140);
        expect(row.description.startsWith(`${row.label}. `)).toBe(true);
        expect(row.description).not.toMatch(/[`—]/);
        expect([...row.description].every((ch) => (ch.codePointAt(0) ?? 0) <= 0xffff)).toBe(true);
        expect(row.nextStep).not.toContain("—");
      },
    );
  });

  /**
   * And red checks *with* findings stay a fix, because the findings are the
   * explanation: the fix round has something to aim at, and the re-review is
   * what re-reads the checks.
   */
  it("recommends changes when red checks come with findings that explain them", () => {
    expect(
      deriveVerdict(output({ findings: [finding({ body: "**Fix before merge.** the new test asserts the old behaviour" })] }), { autoFix: false,
        ci: "red",
        fixRoundProgress: undefined,
        stillOpen: 0, movedToFollowUps: 0 }).verdict,
    ).toBe("changes recommended");
  });

  /**
   * A finding counts from `findings` with nothing else beside it: one written
   * there and left off the restating list that existed until #224 used to
   * derive *approval recommended*, which puts the unsafe answer on the one
   * signal meant to be acted on without reading (#105).
   */
  it("counts a finding from the findings list alone", () => {
    const listless = output({
      findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })],
    });

    expect(deriveVerdict(listless, { autoFix: false, ci: "green", fixRoundProgress: undefined, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe("changes recommended");
  });

  /**
   * **However the body is written, label or none.** The label is presentation
   * and no predicate reads it: by #96's decision 1 a finding is one of two
   * kinds and `followUps` is the other, so an entry in `findings` is
   * fix-before-merge by definition.
   *
   * What a predicate over the label cost is the unsafe direction twice over. A
   * finding it did not recognise in an untouched file was counted nowhere and
   * posted nowhere — the body is that one's only surface — so a review
   * recommended approval over a populated *Open* group; and one on a diff line
   * got a thread and an id, counted in no round that raised it, then counted
   * through `stillOpen` in every round after, turning non-blocking into
   * blocking with no code change.
   */
  it.each([
    "**Fix before merge.** x",
    "Fix before merge. x",
    "__Fix before merge__ x",
    "  **fix before merge:** x",
    "### Fix before merge\n\nx",
    "Worth a look before merge — the guard runs after the return.",
    "the guard runs after the return",
  ])("counts a finding whatever its body opens with: %s", (body: string) => {
    expect(
      deriveVerdict(output({ findings: [finding({ body })] }), { autoFix: false, ci: "green", fixRoundProgress: undefined, stillOpen: 0, movedToFollowUps: 0 })
        .verdict,
      body,
    ).toBe("changes recommended");
  });

  it("prefers a closer look over a fix-before-merge finding", () => {
    expect(
      deriveVerdict(output({ findings: [finding()], needsYou: "the wrong thing was built" }), { autoFix: false,
        ci: "green",
        fixRoundProgress: undefined,
        stillOpen: 0, movedToFollowUps: 0 }).verdict,
    ).toBe("needs a closer look");
  });

  /**
   * **The round rule is retired** (#202, PRD #200 decision 6). A review after a
   * fix round may recommend changes and, with budget left, start another round:
   * the budget and the early stop bound the loop now, and the bar on a later
   * round did not (it asked for guidance 9 times in 40 PRs and got it 0 times).
   * Here the fix round closed 2 of its 3 findings, and the re-review raised a
   * new one besides, which neither counts as progress nor takes it away.
   */
  it("starts another round after a fix round that closed some of its findings", () => {
    const row = deriveVerdict(output({ findings: [finding({ body: "**Fix before merge.** the fix broke the retry path" })] }), {
      ci: "green",
      fixRoundProgress: { given: 3, closed: 2 },
      stillOpen: 1,
      movedToFollowUps: 0,
      autoFix: true,
    });

    expect(row).toEqual({ ...VERDICTS["changes recommended"], startsFixRound: true });
    // And no row of the retired rule is left to reach.
    expect(Object.keys(VERDICTS)).not.toContain("changes recommended after a fix round");
  });

  /**
   * **🟡 is one row** (#297, #201's *Verdict lines*). Whether a round starts,
   * the budget is spent, or the last round made no progress, a maintainer
   * reads the same line, and only the fields no line is made of differ: the
   * `startsFixRound` the automatic fix selects on and the `stop` the park
   * comment names. The *fix round started* key is retired with its line.
   */
  it.each([
    ["no round is starting", {}, {}],
    ["a round is starting", { autoFix: true }, { startsFixRound: true }],
    ["the budget is spent", { fixRounds: { spent: 3, budget: 3 } }, { stop: "budget spent" }],
    ["rounds are left and none starts", { fixRounds: { spent: 1, budget: 3 } }, {}],
    ["the budget is 0", { fixRounds: { spent: 0, budget: 0 } }, {}],
    [
      "the last round made no progress",
      { autoFix: true, fixRoundProgress: { given: 3, closed: 0 }, fixRounds: { spent: 1, budget: 3 } },
      { stop: "no progress" },
    ],
    [
      "both stops hold",
      { fixRoundProgress: { given: 2, closed: 0 }, fixRounds: { spent: 3, budget: 3 } },
      { stop: "no progress" },
    ],
  ] as const)("gives the one changes-recommended line where %s", (_case, over, fields) => {
    const row = deriveVerdict(output({ findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })] }), {
      ci: "green",
      fixRoundProgress: undefined,
      stillOpen: 0,
      movedToFollowUps: 0,
      autoFix: false,
      ...over,
    });

    expect(row).toEqual({ ...VERDICTS["changes recommended"], ...fields });
    expect(Object.keys(VERDICTS)).not.toContain("changes recommended, fix round started");
  });

  /**
   * A pull request with one review round so far never early-stops: it follows
   * no fix round, so there is nothing to judge. Nor does a fix round that was
   * given nothing, which cannot have failed to close any of it.
   */
  it.each([
    ["no fix round", undefined],
    ["a fix round given nothing", { given: 0, closed: 0 }],
  ])("never early-stops after %s", (_case, fixRoundProgress) => {
    expect(
      deriveVerdict(output({ findings: [finding({ body: "**Fix before merge.** the guard runs after the return" })] }), {
        ci: "green", fixRoundProgress, stillOpen: 0, movedToFollowUps: 0, autoFix: true,
      }).startsFixRound,
    ).toBe(true);
  });

  /**
   * **A fix round that made no progress can never start another**, whatever
   * the workflow passes in: the early stop is one of the two bounds on the
   * automatic fix now (#202), beside the budget. The job selects on
   * `startsFixRound`, so a review that set it after a round that changed
   * nothing would spend the rest of the budget on the same findings.
   *
   * Enforced by the arm order here rather than by the caller: `review.ts`
   * passes `autoFix` from the budget step's answer and never from the
   * progress, so this file is the only place the two facts meet.
   */
  it("never starts a fix round after one that closed nothing", () => {
    const after = (over: Partial<ReviewOutput>, stillOpen: number): VerdictRow =>
      deriveVerdict(output(over), {
        ci: "green",
        fixRoundProgress: { given: 1, closed: 0 },
        stillOpen,
        movedToFollowUps: 0,
        autoFix: true,
      });

    expect(after({ findings: [finding({ body: "**Fix before merge.** the guard still runs after the return" })] }, 0).startsFixRound).toBeUndefined();
    // The carried half of the count reaches the same arm, so it cannot be the
    // way in either.
    expect(after({}, 1).startsFixRound).toBeUndefined();
    expect(after({}, 1).stop).toBe("no progress");
  });

  /**
   * …and neither can a review with nothing to fix. A pull request the loop is
   * about to fix is a pull request with findings on it.
   */
  it.each([
    ["approval recommended", "green"],
    ["needs a closer look", "red"],
  ])("still answers %s with the input on and nothing to fix", (verdict, ci) => {
    const row = deriveVerdict(output(), {
      ci: ci as CiResult,
      fixRoundProgress: undefined,
      stillOpen: 0,
      movedToFollowUps: 0,
      autoFix: true,
    });
    expect(row.verdict).toBe(verdict);
    expect(row.startsFixRound).toBeUndefined();
  });

  /**
   * The agent's own "a fix round cannot settle this" still comes first. It is a
   * statement about the findings rather than one more of them, and a loop that
   * started a fix round over it would be answering the one verdict that says a
   * fix round is the wrong answer.
   */
  it("does not start a fix round over a review that asked for a human", () => {
    const row = deriveVerdict(output({ needsYou: "the issue asked for the opposite" }), {
      ci: "green",
      fixRoundProgress: undefined,
      stillOpen: 0,
      movedToFollowUps: 0,
      autoFix: true,
    });
    expect(row.verdict).toBe("needs a closer look");
    expect(row.startsFixRound).toBeUndefined();
  });

  /**
   * And it is the *findings* that change the line, not the history. A fix round
   * that worked is a pull request that is ready, which is the outcome the whole
   * round exists to reach.
   */
  it("still recommends approval after a fix round that closed everything", () => {
    expect(deriveVerdict(output(), { autoFix: true, ci: "green", fixRoundProgress: { given: 2, closed: 2 }, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe(
      "approval recommended",
    );
  });

  /**
   * A finding this review **carried** rather than found: an earlier round
   * raised it, this one checked and it is still not fixed (#111). It counts
   * exactly as one of this review's own would — a review that found nothing new
   * and three things still unfixed is not an approval, and the fixer no longer
   * closes anything, so nothing else would stop it.
   */
  it("recommends changes when the only thing wrong is what an earlier round asked for", () => {
    expect(deriveVerdict(output(), { autoFix: false, ci: "green", fixRoundProgress: undefined, stillOpen: 1, movedToFollowUps: 0 }).verdict).toBe(
      "changes recommended",
    );
  });

  /**
   * *Previously missed* (#109, decision 4) — a real problem in code an earlier
   * review already read. It is a fix-before-merge finding carrying one extra
   * statement, so it derives the row any other finding would: after a fix
   * round that made progress, with budget left, another round (#202).
   *
   * This is the rule #96 set and this slice changed. Such a finding used to be
   * a `followUps` entry — filed as an issue after the merge it should have
   * stopped (`docs/parity.md` §10).
   */
  it("counts a previously-missed finding like any other", () => {
    const missed = output({
      findings: [
        finding({ body: "**Previously missed.** the cache key omits the tenant" }),
      ],
    });

    expect(countFixBeforeMerge(missed, 0)).toBe(1);
    expect(deriveVerdict(missed, { autoFix: true, ci: "green", fixRoundProgress: { given: 1, closed: 1 }, stillOpen: 0, movedToFollowUps: 0 })).toEqual(
      { ...VERDICTS["changes recommended"], startsFixRound: true },
    );
    expect(deriveVerdict(missed, { autoFix: false, ci: "green", fixRoundProgress: undefined, stillOpen: 0, movedToFollowUps: 0 }).verdict).toBe(
      "changes recommended",
    );
  });
});

/**
 * The commit status each verdict posts. The descriptions are quoted from #201's
 * table rather than read back out of the constant — an expectation derived from
 * the thing it tests moves when that thing is wrong, and this one is the whole
 * of what a maintainer sees: the promise of the feature is that the status line
 * is enough, so a reworded one is a different feature.
 */
describe("the verdict's commit status", () => {
  it("posts under a context of its own", () => {
    expect(VERDICT_CONTEXT).toBe("agent-review");
  });

  /**
   * #201's *Verdict lines*, settled with the maintainer on 2026-09-30 and
   * shipped by #297: the body's line and the status line, which may differ on
   * every row. *Needs a closer look*'s row here is the reviewer asking for a
   * human; its other two causes are pinned beside `deriveVerdict` above.
   */
  it.each([
    [
      "approval recommended",
      "🟢 Approval recommended",
      "success",
      "Nothing left to fix. You can merge once the PR is ready and no longer a draft.",
      "Approval recommended. Nothing left to fix. You can merge once the PR is ready and no longer a draft.",
    ],
    [
      "changes recommended",
      "🟡 Changes recommended",
      "failure",
      "The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label.",
      "Changes recommended. If the agent isn't already working on them, add the agent:fix label to have it make the changes.",
    ],
    [
      "needs a closer look",
      "🔵 Needs a closer look",
      "failure",
      "This needs your judgement before anything is changed. Read the review, then do one of these: (1) comment with what to change and add the `agent:fix` label, (2) push a fix yourself, (3) merge as is if you're satisfied, or (4) close the PR.",
      "Needs a closer look. Read the review, then tell the agent what to fix, fix it yourself, merge as is, or close the PR.",
    ],
  ] as const)(
    "states %s under its heading, with the state that shows it",
    (verdict, heading, state, nextStep, description) => {
      expect(VERDICTS[verdict].heading).toBe(heading);
      expect(VERDICTS[verdict].state).toBe(state);
      expect(VERDICTS[verdict].nextStep).toBe(nextStep);
      expect(VERDICTS[verdict].description).toBe(description);
      expect(VERDICTS[verdict].verdict).toBe(verdict);
    },
  );

  it("has one row per heading, and no fix-round-started row", () => {
    expect(Object.keys(VERDICTS).sort()).toEqual([
      "approval recommended",
      "changes recommended",
      "needs a closer look",
    ]);
  });

  /** Three headings, which are Copilot code review's own. */
  it("offers the three headings Copilot code review uses, and no fourth", () => {
    expect(new Set(Object.values(VERDICTS).map((row) => row.heading))).toEqual(
      new Set(["🟢 Approval recommended", "🟡 Changes recommended", "🔵 Needs a closer look"]),
    );
  });

  /**
   * Two renderings of one row. The body is the heading over the step; the status
   * line is the `label` (the heading without its marker, which a description
   * refuses) and the short form of the step. Every closer-look cause, too.
   */
  it("opens every status line with the label the heading carries", () => {
    for (const row of EVERY_ROW) {
      expect(row.heading, row.verdict).toMatch(new RegExp(` ${row.label}$`));
      expect(row.description.startsWith(`${row.label}. `), row.description).toBe(true);
    }
  });

  /**
   * GitHub refuses a status description holding any character outside the
   * Basic Multilingual Plane (`422 Description doesn't accept 4-byte Unicode`),
   * and every assessment marker is one. v0.3.0 shipped them there, so every
   * verdict post was rejected — and the step's warning named a missing grant,
   * which is why it read as an adopter's misconfiguration rather than ours
   * (#121). The heading keeps its marker: a review body accepts it.
   */
  it("keeps every status description to characters GitHub accepts there", () => {
    for (const row of EVERY_ROW) {
      const astral = [...row.description].filter((ch) => (ch.codePointAt(0) ?? 0) > 0xffff);
      expect(astral, row.verdict).toEqual([]);
    }
  });

  /**
   * And none of it carries an em dash (#136). The row is posted twice, as the
   * status and as the body's heading and step, so this is the one place it
   * can come back from.
   */
  it("writes no em dash into any verdict row", () => {
    for (const row of EVERY_ROW) {
      expect([row.heading, row.label, row.nextStep, row.description].join("\n"), row.verdict).not.toContain("—");
    }
  });

  /**
   * GitHub truncates a status description past 140 characters, and truncates it
   * where the character ran out rather than where the sentence ends. The line
   * is the feature, so a line that arrives half-written is the feature broken
   * in the one place nothing else reports.
   */
  it("keeps every next step inside GitHub's 140-character limit", () => {
    for (const row of EVERY_ROW) {
      expect(row.description.length, row.verdict).toBeLessThanOrEqual(140);
    }
  });
});

/**
 * The body a maintainer actually reads, which is now a **record** rather than a
 * rendering (#109, decision 8).
 *
 * What it replaced was a flat checklist of restated finding lines, and the
 * things it could not say are why this exists: a finding the last round asked
 * for and this one verified fixed disappeared with nothing saying it had ever
 * been raised, a finding an earlier review had already read the code for looked
 * exactly like one it had never seen, and nine findings read the same as one.
 * The record keeps the rounds in it, and a severity on each entry so the worst
 * is the first one a reader meets.
 *
 * Two parts of the old body survive unchanged because their reason did (#105):
 * `needsYou` fed the derivation and reached nobody, and the set the body
 * records is the set the verdict was counted from.
 */
describe("the posted review body", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    findings: [],
    followUps: [],
    verified: [],
    ...over,
  });
  const parts = {
    verdict: VERDICTS["changes recommended"],
    output: output(),
    placed: [],
    movedToFollowUps: 0,
    stillOpen: [],
    resolved: [],
    followUps: [],
    droppedFollowUps: 0,
  };
  const render = (over: Partial<Decided> = {}): string =>
    renderDecided({ ...parts, ...over });

  /** The same finding, in code an earlier review had already read. */
  const missedFinding = (over: Partial<Finding> = {}): PlacedFinding[] => [
    {
      id: "f-missed",
      placement: "line",
      finding: finding({
        path: "src/queue.ts",
        line: 206,
        title: "the guard runs after the return",
        body: "**Previously missed.** the guard runs after the return",
        ...over,
      }),
    },
  ];

  /** One labelled finding on a line the diff covers, placed with a known id. */
  const placedFinding = (over: Partial<Finding> = {}): PlacedFinding[] => [
    {
      id: "f-new",
      placement: "line",
      finding: finding({
        path: "src/queue.ts",
        line: 206,
        title: "the guard runs after the return",
        body: "**Fix before merge.** the guard runs after the return",
        ...over,
      }),
    },
  ];

  /**
   * Decision 8's order, which is Copilot code review's overview: the heading
   * that says which comment this is, the assessment a reader recognises, what
   * is unresolved, the step to take, then the count that sizes it. The step is
   * italic and does **not** repeat the heading, which is what makes this a
   * rendering of the verdict row rather than the status line pasted in.
   */
  it("opens with its own heading, the assessment, a sentence, the step, then the count", () => {
    const body = render({ placed: placedFinding() });

    // Level 2, because `#` renders very large inside a comment — and the
    // assessment heading stays level 3 directly beneath it.
    expect(body.startsWith("## Agent review\n\n### 🟡 Changes recommended\n\n")).toBe(true);
    expect(body).toContain("1 finding is open.");
    expect(body).not.toContain(parts.verdict.description);
    expect(body.indexOf("1 finding is open.")).toBeLessThan(body.indexOf("**Findings:** 1"));
    expect(body.indexOf("_The review found changes to make.")).toBeGreaterThan(-1);
    expect(body.indexOf("_The review found changes to make.")).toBeLessThan(body.indexOf("**Findings:**"));
  });

  /**
   * **Every agent in the loop posts as `github-actions[bot]`**, so in the
   * timeline a review overview and a fix run's thread replies are the same
   * author saying more things. The heading is what marks the one to read, and
   * it matches the `agent-review` status and the `agent:review` label the way
   * Copilot's overview opens with "Copilot review overview".
   */
  it("names itself in the first line, and puts the assessment in the second", () => {
    const [first = "", second = ""] = render()
      .split("\n")
      .filter((line) => line.trim() !== "");

    expect(first).toBe("## Agent review");
    expect(second).toBe(`### ${VERDICTS["changes recommended"].heading}`);
  });

  /**
   * **The round's header goes above the heading** (#298): which slice and
   * which review this is, the first line a reader of a long PRD PR scans for.
   */
  it("opens with the round's header, above the heading, where it is given one", () => {
    const body = render({ header: "**Slice 2 of 5 · #232 · review 3**" });

    expect(body.startsWith("**Slice 2 of 5 · #232 · review 3**\n\n## Agent review\n\n### ")).toBe(true);
  });

  /**
   * **A label name renders as code in the body and as plain text in the
   * status**, from one copy of the sentence. A status description renders no
   * Markdown at all, so a backtick shows up in it literally — which is why
   * `VERDICTS` holds the plain wording and the body decorates it on the way
   * out, rather than the table holding two spellings that can disagree.
   */
  it("renders a label name as code in the body, and leaves the status plain", () => {
    const body = render();

    expect(body).toContain("add the `agent:fix` label._");
    expect(body).not.toContain("``agent:fix``");
    expect(body).not.toContain(" agent:fix ");
    for (const row of EVERY_ROW) expect(row.description).not.toContain("`");
  });

  /** And any other label a line this file composes happens to name. */
  it("renders a label in the round note as code too", () => {
    expect(render({ roundNote: "_Re-run by adding agent:review._" })).toContain("`agent:review`");
  });

  /**
   * The sentence is what the heading cannot say: *changes recommended* is the
   * same three words over a round that found something new and over one that
   * found nothing and left the last round's findings unfixed.
   */
  it("names what is unresolved, and where it came from", () => {
    const body = render({
      placed: placedFinding(),
      stillOpen: [{ id: "f-1", threadId: "PRRT_one", text: "src/a.ts:4 · the cache key omits the tenant", title: "the cache key omits the tenant", anchor: "src/a.ts:4" }],
    });

    expect(body).toContain("2 findings are open, 1 carried from an earlier review.");
  });

  it("says so plainly when nothing is open", () => {
    expect(render()).toContain("Nothing is open on this pull request.");
    expect(render()).toContain("**Findings:** 0");
  });

  /**
   * **The review's own sentence wins**, which is the point of the field: a
   * count says how many and this says *what*, and the count is already on its
   * own line two below. Modelled on Copilot's, which names the subjects.
   */
  it("carries the review's own sentence under the heading, in place of the count", () => {
    const assessment = "Sequence validation and undo-safe state handling are each wrong here.";
    const body = render({ placed: placedFinding(), output: output({ assessment }) });

    expect(body).toContain(`### 🟡 Changes recommended\n\n${assessment}\n\n_`);
    expect(body).not.toContain("1 finding is open.");
    // Once, not twice: the sentence's job is to be the first thing read, and a
    // second copy lower down is the body repeating itself.
    expect(body.split(assessment)).toHaveLength(2);
    // And the counting stays where a reader looks for it.
    expect(body).toContain("**Findings:** 1");
  });

  /**
   * A blank one is an absent one — the same four shapes `needsYou` normalises —
   * because an empty line in a fixed layout reads as a rendering fault. The
   * fallback says less, and saying less is not the same as saying nothing.
   */
  it.each([undefined, "", "   "] as const)(
    "falls back to a sentence built from the record when the field is %p",
    (assessment) => {
      const built = render({
        placed: placedFinding(),
        output: output(assessment === undefined ? {} : { assessment }),
      });

      expect(built).toContain("1 finding is open.");
    },
  );

  /**
   * And says what closed, which is the half a body with no memory could not:
   * the thread is gone from the next round's feedback, so this line is the only
   * trace that the work was done.
   */
  it("counts the round's closures even when nothing is left open", () => {
    const body = render({ resolved: [{ id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return", title: "the guard runs after the return", anchor: "src/a.ts:1" }] });

    expect(body).toContain("1 finding an earlier review raised was closed this round.");
    expect(body).toContain("<summary><b>Resolved since last review</b> (1)</summary>");
  });

  /**
   * **What resolved, and what did not** (#257). Publish resolves the threads
   * before it posts, so the runner hands every resolved entry over with the
   * thread whose closure it stands on, and the body publish renders lists an
   * entry whose thread it could not resolve as still open, in the place the
   * resolved group has, rather than claiming a closure that never happened.
   */
  describe("the resolved group, from the closures that held", () => {
    const resolved = [
      { id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return", title: "the guard runs after the return", anchor: "src/a.ts:1", severity: "low" as const },
      { id: "f-2", threadId: "PRRT_two", text: "the cache key omits the tenant", title: "the cache key omits the tenant", anchor: "src/a.ts:1", severity: "high" as const },
    ];
    const lines = (body: string, title: string): string[] => {
      const at = body.indexOf(`<summary><b>${title}</b>`);
      return at < 0 ? [] : body.slice(at, body.indexOf("</details>", at)).split("\n").filter((line) => line.startsWith("- "));
    };

    it("hands over each resolved entry worst first, with the thread it needs resolved", () => {
      const handed = reviewBodyHandOver({ ...parts, resolved });

      expect(handed.resolved.map((entry) => entry.threadId)).toEqual(["PRRT_two", "PRRT_one"]);
      expect(handed.resolved.map((entry) => entry.title)).toEqual([
        "the cache key omits the tenant",
        "the guard runs after the return",
      ]);
    });

    it("lists every entry as resolved where every closure held", () => {
      const body = render({ resolved });

      expect(lines(body, RESOLVED_GROUP.title)).toHaveLength(2);
      expect(body).not.toContain(UNCLOSED_GROUP.title);
    });

    it("lists an entry whose thread did not close as still open, ahead of the resolved ones", () => {
      const body = render({ resolved, closed: new Set(["PRRT_two"]) });
      const open = lines(body, UNCLOSED_GROUP.title);

      expect(open).toHaveLength(1);
      expect(open[0]).toContain("the guard runs after the return");
      expect(lines(body, RESOLVED_GROUP.title).join("\n")).not.toContain("the guard runs after the return");
      expect(body).toContain("<summary><b>Still open</b> (1)</summary>");
      expect(body).toContain(`_${UNCLOSED_GROUP.subtitle ?? ""}_`);
      expect(body).toContain("<summary><b>Resolved since last review</b> (1)</summary>");
      expect(body.indexOf(UNCLOSED_GROUP.title)).toBeLessThan(body.indexOf(RESOLVED_GROUP.title));
    });

    it("lists every entry as still open where no closure held", () => {
      const body = render({ resolved, closed: new Set() });

      expect(lines(body, UNCLOSED_GROUP.title)).toHaveLength(2);
      expect(body).not.toContain(RESOLVED_GROUP.title);
    });

    it("drops both groups where nothing was resolved", () => {
      const body = render();

      expect(body).not.toContain(RESOLVED_GROUP.title);
      expect(body).not.toContain(UNCLOSED_GROUP.title);
    });
  });

  /**
   * A threaded finding carried into this round is listed by the title the
   * review that raised it wrote, linked to its thread, with its anchor beside
   * the link as every other entry's is (#134) — not by the thread's text,
   * which is the anchor, an `(outdated …)` clause and the whole opening
   * paragraph, all of it inside the link.
   */
  describe("a threaded finding carried from an earlier review", () => {
    const threaded = {
      id: "f-1",
      threadId: "PRRT_one",
      text: "src/a.ts:4 (outdated — the code here has changed since) — The warning asserts a verdict stands. It cannot see the commit. Several sentences follow.",
      title: "Warning asserts a verdict stands on a commit the read could not see",
      anchor: "src/a.ts:4",
      severity: "low" as const,
      url: "https://github.com/o/r/pull/1#discussion_r1",
    };
    const line =
      "[Warning asserts a verdict stands on a commit the read could not see](https://github.com/o/r/pull/1#discussion_r1) · `src/a.ts:4`";

    it("is listed by its title under Resolved since last review", () => {
      const body = render({ resolved: [threaded] });

      expect(body).toContain(`${severityBadge("low")} ${line}\n`);
      expect(body).not.toContain("outdated");
      expect(body).not.toContain("Several sentences");
    });

    it("is listed by its title under Open while it is still open", () => {
      const body = render({ stillOpen: [threaded] });

      expect(body).toContain(`${severityBadge("low")} ${line}\n`);
      expect(body).not.toContain("outdated");
    });

  });

  it("names the case when the agent said a fix round cannot settle it", () => {
    const body = render({ output: output({ needsYou: "the issue asked for the opposite" }) });

    // Above the count, because it qualifies the assessment rather than the
    // record: a reader meets it before deciding what the count means.
    expect(body).toContain("the issue asked for the opposite");
    expect(body.indexOf("the issue asked for the opposite")).toBeLessThan(
      body.indexOf("**Findings:**"),
    );
  });

  /**
   * And the round note, which is the one thing in the body that is a fact about
   * how the run read the repository rather than about the change.
   */
  it("says when the round was assumed rather than established", () => {
    expect(render({ roundNote: "_Reviewed as a second round._" })).toContain(
      "_Reviewed as a second round._",
    );
  });

  /**
   * Collapsible, not collapsed. *Open* and *Previously missed* are what the
   * verdict has just told a reader to act on, so a disclosure widget over
   * either would be one more click between the line and the work — and
   * *Previously missed* counts toward that verdict, which is why it is not
   * folded the way Copilot folds its equivalent. *Resolved since last review*
   * is the record's memory and starts closed.
   */
  it("expands what is owed and folds what is done", () => {
    const body = render({
      placed: [...placedFinding(), ...missedFinding()],
      resolved: [{ id: "f-1", threadId: "PRRT_one", text: "an earlier finding", title: "an earlier finding", anchor: "src/a.ts:1" }],
    });

    expect(body).toContain("<details open>\n<summary><b>Open</b> (1)</summary>");
    expect(body).toContain("<details open>\n<summary><b>Previously missed</b> (1)</summary>");
    expect(body).toContain("<details>\n<summary><b>Resolved since last review</b> (1)</summary>");
  });

  /**
   * And in that order: what is owed, then what the record was wrong about,
   * then what closed. *Resolved* used to sit between the two expanded groups,
   * which put a folded widget in the middle of the list a reader is acting on.
   */
  it("orders the groups Open, Previously missed, Resolved", () => {
    const body = render({
      placed: [...placedFinding(), ...missedFinding()],
      resolved: [{ id: "f-1", threadId: "PRRT_one", text: "an earlier finding", title: "an earlier finding", anchor: "src/a.ts:1" }],
    });

    expect([...body.matchAll(/<summary><b>(.*?)<\/b>/g)].map(([, title]) => title)).toEqual([
      "Open",
      "Previously missed",
      "Resolved since last review",
    ]);
  });

  /**
   * **The group says what it means, in Copilot code review's words for it**
   * (#127). *Previously missed* names what happened to the record and not what
   * the finding is about; the subtitle is the line that says the code it is in
   * has not changed since a review already read it — and it sits directly under
   * the summary, where a reader meets it before the entries rather than after
   * deciding what they meant.
   *
   * The blank line between `</summary>` and it is load-bearing: GitHub renders
   * no Markdown inside a `<details>` until the content is separated from the
   * summary, so without it the subtitle arrives as literal underscores.
   */
  it("carries the previously-missed subtitle directly under the summary line", () => {
    const body = render({ placed: missedFinding() });

    expect(body).toContain(
      `<summary><b>Previously missed</b> (1)</summary>\n\n_${PREVIOUSLY_MISSED_SUBTITLE}_`,
    );
    expect(PREVIOUSLY_MISSED_SUBTITLE).toBe("In code that hasn't changed since last review");
  });

  /** And no other group carries one — it is this group's fact, not furniture. */
  it("gives the subtitle to no other group", () => {
    const body = render({
      placed: placedFinding(),
      resolved: [{ id: "f-1", threadId: "PRRT_one", text: "an earlier finding", title: "an earlier finding", anchor: "src/a.ts:1" }],
    });

    expect(body).not.toContain(PREVIOUSLY_MISSED_SUBTITLE);
  });

  /**
   * A *previously missed* entry is formatted exactly like an *Open* one —
   * badge, claim, anchor, the *new* mark — because it is one, with one more
   * thing said about it. A group that rendered its entries differently would
   * read as a lesser kind of finding, which is the opposite of decision 4.
   */
  it("renders a previously missed entry exactly as it renders an open one", () => {
    const missed = render({ placed: missedFinding({ severity: "high" }) });
    const open = render({ placed: placedFinding({ severity: "high" }) });
    const entryOf = (body: string): string =>
      body.split("\n").find((line) => line.startsWith("- ")) ?? "";

    expect(entryOf(missed)).toBe(entryOf(open));
  });

  it("drops a group with nothing in it rather than showing an empty widget", () => {
    const body = render();

    expect(body).not.toContain("<details");
  });

  /** A badge, the claim, where it is, and that this round is the one that found it. */
  it("enters a finding with its severity, its title, its anchor and a new marker", () => {
    const body = render({ placed: placedFinding({ severity: "high" }) });

    expect(body).toContain(
      `- ${severityBadge("high")} the guard runs after the return · \`src/queue.ts:206\` *new*`,
    );
  });

  it("marks a carried finding as anything but new", () => {
    const body = render({
      stillOpen: [{ id: "f-1", threadId: "PRRT_one", text: "src/a.ts:4 · the cache key omits the tenant", title: "the cache key omits the tenant", anchor: "src/a.ts:4" }],
    });

    expect(body).toContain("- the cache key omits the tenant · `src/a.ts:4`\n");
    expect(body).not.toContain("*new*");
  });

  /**
   * Worst first, and **stable** inside a rating: the order the review produced
   * its findings in is the order it thought about them.
   */
  it("sorts a group worst first, keeping the review's order inside a rating", () => {
    const at = (title: string, severity: Severity, id: string): PlacedFinding => ({
      id,
      placement: "line",
      finding: finding({ title, severity, body: `**Fix before merge.** ${title}` }),
    });
    const body = render({
      placed: [
        at("a low one", "low", "f-1"),
        at("the first high one", "high", "f-2"),
        at("a medium one", "medium", "f-3"),
        at("the second high one", "high", "f-4"),
      ],
    });

    expect(
      ["the first high one", "the second high one", "a medium one", "a low one"].map((t) =>
        body.indexOf(t),
      ),
    ).toEqual([...["the first high one", "the second high one", "a medium one", "a low one"]
      .map((t) => body.indexOf(t))
      .sort((a, b) => a - b)]);
  });

  /**
   * Decision 4, shown rather than stated: a real problem in code an earlier
   * review already read counts exactly as any other finding, and gets a group
   * of its own because *the record was wrong about this change* is the part
   * worth seeing. It is listed there and nowhere else.
   */
  it("puts a previously missed finding in its own group and not in Open", () => {
    const body = render({
      placed: [
        {
          id: "f-m",
          placement: "line",
          finding: finding({
            title: "the retry loop never terminates",
            body: "**Previously missed.** the retry loop never terminates",
          }),
        },
      ],
    });

    expect(body).toContain("<summary><b>Previously missed</b> (1)</summary>");
    expect(body).not.toContain("<summary><b>Open</b>");
    expect(body).toContain("**Findings:** 1");
    expect(body).toContain("1 finding is open, 1 in code an earlier review had already read.");
  });

  /**
   * A threaded finding is listed **without** its id: the thread is its record,
   * and a second copy in the body is one a maintainer cannot close. Resolving a
   * thread by hand is how they settle a finding, and a body that named it again
   * would raise it in the next round anyway.
   */
  it("leaves the id off a finding whose thread is already the record", () => {
    const threaded = { id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return", title: "the guard runs after the return", anchor: "src/a.ts:1" };
    const body = render({ stillOpen: [threaded] });

    expect(body).not.toContain(findingMarker("f-1"));
    expect(body).not.toContain("agent-finding");
  });

  /**
   * **A finding this review raised carries neither an id nor its evidence**,
   * because it now always has a thread to carry both (#127, decision 1). The
   * entry is the one-line version of something a maintainer can reply to,
   * decline and resolve — which is the whole of what the body entry could not
   * be (#124).
   */
  it("writes no id and quotes no evidence for a finding it raised this round", () => {
    const body = render({
      placed: [
        {
          id: "f-b",
          placement: "file",
          finding: finding({
            path: "src/queue.ts",
            line: 88,
            title: "the cache key omits the tenant",
            body: "**Fix before merge.** `key()` hashes the id and not the tenant.",
          }),
        },
      ],
    });

    expect(body).toContain(
      `- ${severityBadge("medium")} the cache key omits the tenant · \`src/queue.ts:88\` *new*`,
    );
    expect(body).not.toContain("  **Fix before merge.**");
    expect(body).not.toContain(findingMarker("f-b", "medium"));
    expect(body).not.toContain("is in a file this pull request does not change");
    // And so the next round reads it off its thread rather than off this body.
    expect(body).not.toContain("agent-finding");
  });

  /**
   * The count line badges the ratings it breaks the number down by, and it is a
   * review surface, so it takes the image chip with the rest of the body (#135).
   */
  it("badges the count line's breakdown with the same chip", () => {
    const body = render({
      placed: [
        ...placedFinding({ severity: "high" }),
        ...placedFinding({ severity: "low", line: 207 }),
      ],
    });

    expect(body).toContain(
      `**Findings:** 2 (1 ${severityBadge("high")}, 1 ${severityBadge("low")})`,
    );
  });

  /**
   * **A carried entry links to the thread it lives in** (#109, decision 8).
   * That thread sits under an *older* review, several screens up, which is
   * where a link earns its keep — and where `path:line` as plain text, which
   * GitHub does not linkify, left a reader to go and find it.
   */
  it("links a carried entry to the thread it was raised in", () => {
    const body = render({
      stillOpen: [
        {
          id: "f-1",
          threadId: "PRRT_one",
          url: "https://github.com/o/r/pull/12#discussion_r1",
          text: "src/a.ts:4 · the cache key omits the tenant",
          title: "the cache key omits the tenant",
          anchor: "src/a.ts:4",
        },
      ],
    });

    expect(body).toContain(
      "- [the cache key omits the tenant](https://github.com/o/r/pull/12#discussion_r1) · `src/a.ts:4`",
    );
  });

  /**
   * And a **fresh** one carries none, which is a fact about GitHub rather than
   * a choice: its thread is opened by the same `addPullRequestReview` call that
   * posts this body, so there is no URL to write while the body is being
   * composed — and its thread renders directly beneath this review anyway.
   */
  it("leaves a fresh entry unlinked, since its thread does not exist yet", () => {
    expect(render({ placed: placedFinding() })).not.toContain("](http");
  });

  /** Nothing this body writes carries an em dash (#136), in any verdict and any group. */
  it("writes no em dash, whatever it renders", () => {
    const carried: CarriedFinding[] = [
      {
        id: "f-legacy",
        threadId: "PRRT_one",
        severity: "high",
        text: "src/other.ts:88 · the cache key omits the tenant",
        title: "the cache key omits the tenant",
        anchor: "src/other.ts:88",
      },
    ];
    for (const verdict of Object.values(VERDICTS)) {
      const body = render({
        verdict,
        placed: [...placedFinding(), ...missedFinding()],
        movedToFollowUps: 1,
        stillOpen: carried,
        resolved: [
          {
            id: "f-9",
            threadId: "PRRT_two",
            title: "the key omits the tenant",
            anchor: "src/a.ts:4",
            text: "src/a.ts:4 · the key omits the tenant",
            url: "https://github.com/o/r/pull/1#discussion_r1",
          },
        ],
        followUps: [followUp({ title: "Leak in parse()", location: "src/other.ts:88" })],
        droppedFollowUps: 1,
      });

      expect(body.split("\n").filter((line) => line.includes("—")), verdict.verdict).toEqual([]);
    }
  });

  /**
   * The follow-ups are a **group** now, shaped like the others and placed with
   * them, rather than a block appended below the run link where it looked
   * unlike everything above it. Collapsed, because it is not what blocks this
   * pull request — and **not counted** on the `**Findings:**` line for the same
   * reason.
   */
  it("renders the follow-ups as a collapsed group after Resolved, uncounted", () => {
    const body = render({
      placed: placedFinding(),
      followUps: [followUp({ title: "Leak in parse()", location: "src/other.ts:88" })],
    });

    expect(body).toContain("<details>\n<summary><b>Follow-ups</b> (1) ·");
    expect(body).toMatch(/remove <code>agent:follow-ups<\/code> to skip/);
    expect(body).toContain(
      `- ${severityBadge("medium")} **Leak in parse()** · \`src/other.ts:88\``,
    );
    // Uncounted: the number is what blocks this pull request, and a follow-up
    // is by definition what does not.
    expect(body).toContain("**Findings:** 1");
    expect(body.indexOf("<summary><b>Open</b>")).toBeLessThan(
      body.indexOf("<summary><b>Follow-ups</b>"),
    );
  });

  /**
   * **The payload is untouched** — content, version and all — and goes out on
   * every review including the one that recorded nothing. The filing half reads
   * it on merge, and an empty list is how a round retracts an earlier round's.
   */
  it("carries the follow-ups payload unchanged, empty list included", () => {
    const list = [followUp({ title: "Leak in parse()", location: "src/other.ts:88" })];

    expect(parseFollowUpsBlock(render({ followUps: list, droppedFollowUps: 2 }))).toEqual({
      followUps: list,
      dropped: 2,
      moved: 0,
      cut: 0,
      cap: 3,
    });

    const empty = render();
    expect(empty).not.toContain("<summary><b>Follow-ups</b>");
    expect(hasFollowUpsBlock(empty)).toBe(true);
    expect(parseFollowUpsBlock(empty)).toEqual({ followUps: [], dropped: 0, moved: 0, cut: 0, cap: 3 });
  });

  /**
   * *How this was checked* is what tells a reader how much weight the review
   * carries, and it is on every one of them. Collapsed, because it is
   * supporting evidence rather than the answer.
   */
  it("folds how this was checked under the record, on every review", () => {
    const body = render({ output: output({ howChecked: "Ran the suite; traced `apply()`." }) });

    expect(body).toContain(
      "<details>\n<summary><b>How this was checked</b></summary>\n\nRan the suite; traced `apply()`.",
    );
    expect(body.indexOf("**Findings:**")).toBeLessThan(body.indexOf("How this was checked"));
  });

  /**
   * *What changed in this PR* is gone from the review (#218): the description
   * is the summary block in the pull request's body, written from the same
   * output, and a second copy here is the one that goes stale.
   */
  it("carries no description of the change, whatever the output says", () => {
    const body = render({
      output: output({
        title: "feat: move thread resolution",
        summary: "It moves thread resolution to the review.",
      }),
    });

    expect(body).not.toContain("What changed in this PR");
    expect(body).not.toContain("It moves thread resolution to the review.");
    expect(body).not.toContain("feat: move thread resolution");
  });

  /**
   * **One horizontal rule in the whole body, directly above the run link.** A
   * divider between the groups reads as a section break in a list that is one
   * record; this one is where the subject actually changes — everything above
   * is the review, and this is the run that posted it.
   */
  it("links the run under the body's only rule, and renders neither without one", () => {
    const body = render({
      placed: placedFinding(),
      followUps: [followUp()],
      output: output({ howChecked: "Ran the suite.", summary: "x" }),
      runUrl: "https://github.com/o/r/actions/runs/7",
    });

    expect(body).toContain(
      "---\n\n_Posted by the review agent · [Workflow run](https://github.com/o/r/actions/runs/7)_",
    );
    expect(body.split("\n").filter((line) => line.trim() === "---")).toHaveLength(1);
    expect(render()).not.toContain("Workflow run");
    expect(render().split("\n")).not.toContain("---");
  });
});

/**
 * The record is the set the **verdict was counted from** (#105). When the model
 * restated its findings in a second list, a finding labelled in a finding body
 * and left off the list posted *changes recommended* over an empty checklist.
 * Both are `findings` alone since #224.
 */
describe("the record and the count are one set", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    findings: [],
    followUps: [],
    verified: [],
    ...over,
  });
  // Every path these findings name is in the diff, on the line they name, so
  // each one becomes a line thread: what is under test here is the record's
  // arithmetic, not where GitHub would let a thread hang.
  const DIFF_LINES = new Map([
    ["src/a.ts", new Set([10])],
    ["src/queue.ts", new Set([206])],
    ["a.ts", new Set([10])],
  ]);
  const place = (over: Partial<ReviewOutput>): PlacedFinding[] =>
    placeFindings(output(over).findings, DIFF_LINES, () => "f-x").placed;
  const record = (over: Partial<ReviewOutput>) =>
    reviewRecord({ output: output(over), placed: place(over), stillOpen: [], resolved: [] });
  const body = (over: Partial<ReviewOutput>): string =>
    renderDecided({
      verdict: VERDICTS["changes recommended"],
      output: output(over),
      placed: place(over),
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [],
      followUps: [],
      droppedFollowUps: 0,
    });

  it("records a labelled finding, anchored where it was made", () => {
    const missing = {
      findings: [
        finding({
          path: "src/queue.ts",
          line: 206,
          title: "the guard runs after the return",
          body: "**Fix before merge.** the guard runs after the return.",
        }),
      ],
    };

    expect(countFixBeforeMerge(output(missing), 0)).toBe(1);
    expect(record(missing).findings).toBe(1);
    expect(body(missing)).toContain("the guard runs after the return · `src/queue.ts:206`");
  });

  /**
   * A finding the model gave no title of its own is entered under the claim its
   * body opens with, up to the first line break — so a ```suggestion block
   * stays in the finding it belongs to rather than being collapsed into the
   * record.
   */
  it("takes the claim a finding opens with, not the fix it carries", () => {
    const suggested = body({
      findings: [
        finding({
          title: "",
          body: "__Fix before merge__ this comment describes the old behaviour.\n\n```suggestion\n * Returns every match\n```",
        }),
      ],
    });

    expect(suggested).toContain("this comment describes the old behaviour.");
    expect(suggested).not.toContain("```suggestion");
  });
});

/**
 * **A finding is recorded and counted whatever its body opens with.**
 *
 * The label is presentation: by #96's decision 1 a finding is one of two kinds
 * and `followUps` is the other, so an entry in `findings` is fix-before-merge
 * by definition. A predicate over the label was a second definition of that,
 * and it disagreed with the first in the unsafe direction twice over.
 *
 * Past a changed file's **hunks** it got a file-level thread and nothing else:
 * the record listed it nowhere and the count did not see it, and the review
 * recommended approval over a populated *Open* group. On a **diff line** it got
 * a thread and an id and still reached no group and no count in the round that
 * raised it, then counted through `stillOpen` in every round after: a finding
 * that was not blocking when it was found and blocking for ever after, with no
 * code change between the two.
 *
 * Both halves are exercised on a file the pull request changes, which since
 * #127 is every finding there is: one with an anchor outside the diff is not a
 * finding with a weaker surface, it is a follow-up (decision 3), and the
 * describe below is where that is asserted.
 */
describe("a finding the record does not read a label on", () => {
  const output = (findings: Finding[]): ReviewOutput => ({
    findings,
    followUps: [],
    verified: [],
  });
  // One changed file with one line in a hunk: line 88 is past it, so the
  // unlabelled finding below gets a file-level thread.
  const CHANGED = new Map([["src/queue.ts", new Set([10])]]);
  const unlabelled = finding({
    path: "src/queue.ts",
    line: 88,
    title: "the cache key omits the tenant",
    body: "`key()` hashes the id and not the tenant.",
  });
  const place = (findings: Finding[]): PlacedFinding[] =>
    placeFindings(findings, CHANGED, () => "f-b").placed;

  it("is recorded even though it carries neither label", () => {
    const placed = place([unlabelled]);
    const record = reviewRecord({
      output: output([unlabelled]),
      placed,
      stillOpen: [],
      resolved: [],
    });

    expect(placed[0]?.placement).toBe("file");
    expect(record.open.map((entry) => entry.title)).toEqual(["the cache key omits the tenant"]);
  });

  it("is listed in the posted body and threaded, rather than posted nowhere", () => {
    const placed = place([unlabelled]);
    const body = renderDecided({
      verdict: VERDICTS["changes recommended"],
      output: output([unlabelled]),
      placed,
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [],
      followUps: [],
      droppedFollowUps: 0,
    });

    expect(body).toContain("the cache key omits the tenant");
    expect(reviewThreads(findingsHandOver(placed)).map((t) => t.path)).toEqual(["src/queue.ts"]);
  });

  /** And it must not derive *approval recommended* over the group it is in. */
  it("counts in the round that raised it, rather than recommending approval over itself", () => {
    expect(countFixBeforeMerge(output([unlabelled]), 0)).toBe(1);
    expect(
      deriveVerdict(output([unlabelled]), { autoFix: false, ci: "green", fixRoundProgress: undefined, stillOpen: 0, movedToFollowUps: 0 }).verdict,
    ).toBe("changes recommended");
  });

  /**
   * And the same finding on a **diff line**, which is the half the thread
   * disguises: it gets a thread and an id either way, so nothing about the
   * pull request looked wrong — the finding simply reached no group and no
   * count until the round *after* the one that raised it, when `stillOpen`
   * picked it up. Ran end to end, that read `approval recommended` and then
   * `changes recommended after a fix round` with no commit between them.
   */
  it("is recorded and counted in its first round when it got a thread of its own", () => {
    const threaded = finding({
      path: "src/queue.ts",
      line: 10,
      title: "a passing remark",
      body: "a passing remark",
    });
    const { placed } = placeFindings([threaded], CHANGED, () => "f-t");

    expect(placed[0]?.placement).toBe("line");
    expect(
      reviewRecord({ output: output([threaded]), placed, stillOpen: [], resolved: [] }).open.map(
        (entry) => entry.title,
      ),
    ).toEqual(["a passing remark"]);
    expect(countFixBeforeMerge(output([threaded]), 0)).toBe(1);
  });
});

/**
 * **The record and the count are one set, over every shape of review** — the
 * invariant the two failures above were each half of.
 *
 * Stated as arithmetic rather than as an example, because the ways they can
 * come apart are not enumerable by hand: any predicate either half reads and
 * the other does not reopens it, silently, and in whichever direction that
 * predicate happens to fall. The unsafe direction is a record longer than the
 * count — a body listing findings under a verdict saying there are none —
 * and the merely confusing one is a count longer than the record.
 *
 * Since #127 the shapes include a finding the diff gives no anchor to, which is
 * in neither: it is subtracted from the count and never enters the record, and
 * a caller that passed `movedToFollowUps: 0` would fail here by arithmetic
 * rather than by anybody having to notice the body was short an entry.
 */
describe("the record's size is the count the verdict was given", () => {
  const LINE = new Map([["src/queue.ts", new Set([10])]]);
  const at = (over: Partial<Finding>): Finding =>
    finding({ path: "src/queue.ts", line: 10, ...over });

  const SHAPES: readonly (readonly [string, Partial<ReviewOutput>])[] = [
    ["nothing found", {}],
    ["one labelled finding", { findings: [at({ body: "**Fix before merge.** x" })] }],
    ["one unlabelled finding on a diff line", { findings: [at({ body: "a passing remark" })] }],
    [
      "one finding the diff gives no anchor to, which is moved to follow-ups",
      { findings: [at({ path: "src/other.ts", line: 88, body: "a passing remark" })] },
    ],
    [
      "a finding moved to follow-ups beside one that stayed",
      {
        findings: [
          at({ body: "**Fix before merge.** x" }),
          at({ path: "src/other.ts", line: 88, body: "**Fix before merge.** y" }),
        ],
      },
    ],
    [
      "one previously missed finding",
      { findings: [at({ body: "**Previously missed.** x" })] },
    ],
    [
      "a labelled one, a missed one and an unanchored one",
      {
        findings: [
          at({ body: "**Fix before merge.** x" }),
          at({ body: "**Previously missed.** y" }),
          at({ path: "src/other.ts", line: 88, body: "z" }),
        ],
      },
    ],
  ];

  const CARRIED: readonly (readonly [string, CarriedFinding[]])[] = [
    ["nothing carried", []],
    ["one carried finding still open", [{ id: "f-1", threadId: "PRRT_one", text: "an earlier one", title: "an earlier one", anchor: "src/a.ts:1" }]],
    [
      "two carried findings still open",
      [
        { id: "f-1", threadId: "PRRT_one", text: "an earlier one", title: "an earlier one", anchor: "src/a.ts:1" },
        { id: "f-2", threadId: "PRRT_two", text: "another earlier one", title: "another earlier one", anchor: "src/b.ts:2" },
      ],
    ],
  ];

  const cases = SHAPES.flatMap(([shape, over]) =>
    CARRIED.map(([carried, stillOpen]) => [`${shape}, ${carried}`, over, stillOpen] as const),
  );

  it.each(cases)("%s", (_case, over, stillOpen) => {
    const reviewed: ReviewOutput = {
      findings: [],
      followUps: [],
      verified: [],
      ...over,
    };
    const { placed, unanchored } = placeFindings(reviewed.findings, LINE, () => "f-x");
    const record = reviewRecord({ output: reviewed, placed, stillOpen, resolved: [] });
    const counted = countFixBeforeMerge(reviewed, unanchored.length) + stillOpen.length;

    expect(record.open.length + record.missed.length).toBe(counted);
    expect(record.findings).toBe(counted);
    // And the verdict is the same question asked once: nothing is open exactly
    // when the record is empty.
    expect(
      deriveVerdict(reviewed, { autoFix: false,
        ci: "green",
        fixRoundProgress: undefined,
        stillOpen: stillOpen.length,
        movedToFollowUps: unanchored.length,
      }).verdict === "approval recommended",
    ).toBe(record.findings === 0);
  });
});

/**
 * **Severity decides nothing** (#109, decision 9). It is the property that
 * makes the rest of the record readable, and it is also the property most
 * likely to grow into a fourth verdict input by accident — which is exactly the
 * *judgement call* label #96 retired, because a dial the model turns means
 * every review has to be read to find out which way it was turned.
 *
 * So the test is not an example, it is every arrangement: permute the ratings
 * across a review's findings and its follow-ups, and the verdict, the count and
 * what is filed are byte-identical each time.
 */
describe("severity changes no outcome", () => {
  const RATINGS: readonly Severity[] = ["high", "medium", "low"];

  /** Every assignment of the three ratings to three findings — 27 of them. */
  const assignments: Severity[][] = RATINGS.flatMap((a) =>
    RATINGS.flatMap((b) => RATINGS.map((c) => [a, b, c])),
  );

  const reviewed = (severities: readonly Severity[]): ReviewOutput => ({
    findings: severities.map((severity, index) =>
      finding({
        path: `src/${index}.ts`,
        severity,
        body: "**Fix before merge.** the guard runs after the return",
      }),
    ),
    followUps: severities.map((severity) => followUp({ severity })),
    verified: [],
  });

  it.each(["green", "red", "unknown"] as const)(
    "derives the same verdict on %s checks however the findings are rated",
    (ci: CiResult) => {
      const baseline = deriveVerdict(reviewed(["medium", "medium", "medium"]), { autoFix: false,
        ci,
        fixRoundProgress: undefined,
        stillOpen: 0, movedToFollowUps: 0 });

      for (const severities of assignments) {
        expect(deriveVerdict(reviewed(severities), { autoFix: false, ci, fixRoundProgress: undefined, stillOpen: 0, movedToFollowUps: 0 }), severities.join()).toEqual(
          baseline,
        );
      }
    },
  );

  it("counts the same findings however they are rated", () => {
    for (const severities of assignments) {
      expect(countFixBeforeMerge(reviewed(severities), 0), severities.join()).toBe(3);
    }
  });

  /**
   * And the cap keeps the reviewer's order rather than re-ranking it. The
   * finding's place in that list is half the key a filing run recognises its
   * own work by, so a sort here would change which stub a retry matched.
   */
  it("keeps the follow-up order the reviewer gave, whatever the ratings", () => {
    for (const severities of assignments) {
      const kept = capFollowUps(reviewed(severities).followUps).kept;
      expect(kept.map((f) => f.severity), severities.join()).toEqual(severities);
    }
  });
});

/**
 * Every finding reaches the pull request, and the verdict counts the ones it
 * blocks on — the two halves of #110 and #127 that a placement decision could
 * quietly break.
 *
 * What #110 replaced dropped a finding whose anchor GitHub would reject, which
 * made the count and the record disagree in the one direction that matters: a
 * verdict saying *changes recommended* over a review showing nothing to change.
 * What #127 replaced posted a finding in an untouched file into the body, where
 * a maintainer had no thread to answer, decline or resolve it on — so one of
 * them could hold a pull request at *Changes recommended* for ever (#124).
 *
 * The property under test is therefore not "the line threads are right". It is
 * that **every finding leaves by one of exactly two doors** — a thread it
 * counts on, or a follow-up it does not — and that the body says which.
 */
describe("every finding leaves by a thread or by the follow-ups", () => {
  const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
    findings: [],
    followUps: [],
    verified: [],
    ...over,
  });

  // Real `git diff` output: one hunk on `src/queue.ts` covering new-side lines
  // 8..12, and nothing at all on `src/other.ts`.
  const DIFF_LINES = parseDiffLines(`diff --git a/src/queue.ts b/src/queue.ts
index 0ff3bbb..c6ca7ae 100644
--- a/src/queue.ts
+++ b/src/queue.ts
@@ -8,4 +8,5 @@ export const drain = () => {
 const eight = 8;
 const nine = 9;
+const ten = 10;
 const eleven = 11;
 const twelve = 12;
`);

  const ON_A_LINE = finding({
    path: "src/queue.ts",
    line: 10,
    title: "the guard runs after the return",
    body: "**Fix before merge.** the guard runs after the return",
  });
  const PAST_THE_HUNKS = finding({
    path: "src/queue.ts",
    line: 400,
    title: "the retry loop never terminates",
    body: "**Fix before merge.** the retry loop never terminates",
  });
  const IN_AN_UNTOUCHED_FILE = finding({
    path: "src/other.ts",
    line: 88,
    title: "the cache key omits the tenant",
    body: "**Fix before merge.** `key()` hashes the id and not the tenant.",
  });

  const findings = [ON_A_LINE, PAST_THE_HUNKS, IN_AN_UNTOUCHED_FILE];
  const { placed, unanchored } = placeFindings(findings, DIFF_LINES);
  const { followUps } = recordFollowUps(unanchored, []);
  const reviewed = output({ findings, followUps });
  const render = (): string =>
    renderDecided({
      verdict: deriveVerdict(reviewed, { autoFix: false,
        ci: "green",
        fixRoundProgress: undefined,
        stillOpen: 0,
        movedToFollowUps: unanchored.length,
      }),
      output: reviewed,
      placed,
      movedToFollowUps: unanchored.length,
      stillOpen: [],
      resolved: [],
      followUps,
      droppedFollowUps: 0,
    });

  it("threads the two the diff reaches and moves the one it does not", () => {
    expect(placed.map((p) => p.placement)).toEqual(["line", "file"]);
    expect(unanchored).toEqual([IN_AN_UNTOUCHED_FILE]);
  });

  it("opens a thread for every finding it placed", () => {
    const posted = reviewThreads(findingsHandOver(placed)).map((t) => t.body).join("\n");

    for (const f of [ON_A_LINE, PAST_THE_HUNKS]) expect(posted).toContain(f.title);
    expect(posted).not.toContain(IN_AN_UNTOUCHED_FILE.title);
  });

  /**
   * And the moved one keeps its evidence and its anchor. A follow-up is filed
   * as an issue once the pull request merges, and one that arrived as a
   * one-line claim would be a stub nobody can check — which is #126, on the
   * surface that outlives the pull request.
   */
  it("records the moved finding as a follow-up, whole, and says how it got there", () => {
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({
      title: "the cache key omits the tenant",
      location: "src/other.ts:88",
      severity: "medium",
    });
    expect(followUps[0]?.body).toContain("`key()` hashes the id and not the tenant.");
    expect(followUps[0]?.body).toContain("no file that pull request changed");
    // And no issue number: a stub is filed in the adopter's tracker, where a
    // cross-reference to this one's is a link to somebody else's issue.
    expect(followUps[0]?.body).not.toMatch(/#\d+/);
  });

  /** The two it threaded count; the one it moved does not, because it is a follow-up now. */
  it("counts what it threaded and not what it moved", () => {
    expect(countFixBeforeMerge(reviewed, unanchored.length)).toBe(2);
    expect(render()).toContain("**Findings:** 2");
  });

  /**
   * **And the body says so.** The moved finding is not in *Open*, is not in the
   * count, and the entry that does appear is folded under *Follow-ups* looking
   * like something nobody meant to block on — so a record that said nothing
   * would be demoting a blocker in silence.
   */
  it("says in the body that a finding was moved, and why", () => {
    const posted = render();

    expect(posted).toContain("1 finding was moved to follow-ups");
    expect(posted).toContain("it points at no file this pull request changes");
    // Where it could not go, not why: the causal claim is false for a path
    // error, and the body would contradict its own needs-you warning.
    expect(posted).toContain("nowhere in the diff to comment on it");
    expect(posted).not.toMatch(/causes? (it|them)/);
    // Under the count, which is the line it qualifies.
    expect(posted.indexOf("**Findings:** 2")).toBeLessThan(
      posted.indexOf("moved to follow-ups"),
    );
  });

  /**
   * **The sentence counts what is there.** Four unanchored findings behind one
   * cap on one list leave the fourth on no surface at all — it is subtracted
   * from the count, absent from the record, and absent from the payload the
   * filing run reads — under a body stating that four were moved. So the number
   * the body states, the entries in the group and the exempt prefix in the
   * payload are one quantity, asserted here as one.
   */
  it("moves four findings to a list of four, and says four", () => {
    const four = [1, 2, 3, 4].map((n) =>
      finding({
        path: "src/other.ts",
        line: n,
        title: `untouched finding ${n}`,
        body: `**Fix before merge.** untouched finding ${n}`,
      }),
    );
    const { placed: none, unanchored: moved } = placeFindings(four, DIFF_LINES);
    const recorded = recordFollowUps(moved, []);
    const reviewedFour = output({ findings: four, followUps: recorded.followUps });
    const posted = renderDecided({
      verdict: VERDICTS["approval recommended"],
      output: reviewedFour,
      placed: none,
      movedToFollowUps: recorded.moved,
      stillOpen: [],
      resolved: [],
      followUps: recorded.followUps,
      droppedFollowUps: recorded.dropped,
    });

    expect(posted).toContain("4 findings were moved to follow-ups");
    expect(posted).toContain("<summary><b>Follow-ups</b> (4)");
    for (const f of four) expect(posted).toContain(f.title);
    // And the payload, which is the surface that outlives the pull request: the
    // exempt prefix is all four, so the cap at the filing end reaches none.
    expect(parseFollowUpsBlock(posted)).toMatchObject({ moved: 4, dropped: 0 });
    expect(parseFollowUpsBlock(posted)?.followUps).toHaveLength(4);
  });

  it("says nothing about moving where it moved nothing", () => {
    const kept = output({ findings: [ON_A_LINE] });
    const body = renderDecided({
      verdict: VERDICTS["changes recommended"],
      output: kept,
      placed: placeFindings(kept.findings, DIFF_LINES).placed,
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [],
      followUps: [],
      droppedFollowUps: 0,
    });

    expect(body).not.toContain("moved to follow-ups");
  });

  /**
   * The case the count decides on its own: a review whose only finding has no
   * anchor in the diff has found nothing this pull request must fix before it
   * merges, so it recommends approval — with the finding recorded and filed
   * rather than lost.
   */
  it("recommends approval over a review whose only finding was moved", () => {
    const only = output({ findings: [IN_AN_UNTOUCHED_FILE] });
    const moved = placeFindings(only.findings, DIFF_LINES);

    expect(moved.placed).toEqual([]);
    expect(countFixBeforeMerge(only, moved.unanchored.length)).toBe(0);
    expect(
      deriveVerdict(only, { autoFix: false,
        ci: "green",
        fixRoundProgress: undefined,
        stillOpen: 0,
        movedToFollowUps: moved.unanchored.length,
      }).verdict,
    ).toBe("approval recommended");
  });

  /** Each thread carries the id the workflow wrote for it. */
  it("gives every posted finding an id a later round can read back", () => {
    const posted = [...reviewThreads(findingsHandOver(placed)).map((t) => t.body), render()].join("\n");

    expect(new Set(placed.map((p) => p.id)).size).toBe(2);
    for (const p of placed) {
      expect(posted).toContain(findingMarker(p.id, p.finding.severity, p.finding.title));
    }
  });
});

describe("the review's finding vocabulary", () => {
  const PROMPT = fs.readFileSync(path.join("review", "prompt.md"), "utf8");
  const EXTRACTION = fs.readFileSync(path.join("review", "extraction.md"), "utf8");
  const halves = [
    ["prompt.md", PROMPT],
    ["extraction.md", EXTRACTION],
  ] as const;
  /**
   * The brief without its emphasis or its wrapping, for a test about what it
   * *says*: `do **not** write it up again` is the same instruction as `do not
   * write it up again`, and a test that could tell them apart would fail on a
   * reword that changed nothing.
   */
  const plain = (text: string): string => text.replace(/[*_]/g, "").replace(/\s+/g, " ");

  it.each(halves)("%s labels a finding fix before merge", (_half, text) => {
    expect(text).toContain("fix before merge");
  });

  it.each(halves)("%s offers neither retired label", (_half, text) => {
    expect(text.toLowerCase()).not.toContain("judgement call");
    expect(text.toLowerCase()).not.toContain("blocking");
  });

  /**
   * Counted from `findings` alone (#224): neither half asks for the second
   * list that restated each finding, nor names it at all.
   */
  it.each(halves)("%s asks for no second list of findings", (_half, text) => {
    expect(text).toContain("`findings`");
    expect(text).not.toMatch(/fixBeforeMerge|fix_before_merge/);
  });

  /**
   * And the field that says a fix round is not the answer, with the three cases
   * #96 names. Without them it is a severity dial, and a severity dial is the
   * thing that was just retired.
   */
  /**
   * And the rating, which is the field most likely to be read as a fourth
   * verdict input — by the model first. Both halves say it decides nothing, and
   * both define *low* as a real but small defect rather than as a place to put
   * the preferences neither half posts (#109, decision 9).
   */
  it.each(halves)("%s asks for a severity on every finding", (_half, text) => {
    expect(text).toContain("severity");
    for (const rating of ["high", "medium", "low"]) expect(text).toContain(rating);
  });

  it.each(halves)("%s defines low as a real but small defect", (_half, text) => {
    expect(text).toContain("a real but small defect");
  });

  it.each(halves)("%s says the severity decides nothing", (_half, text) => {
    expect(text).toMatch(/display and ordering only/);
  });

  /**
   * **A finding is never restated in the prose**, and this is the guard on the
   * instruction rather than on the output.
   *
   * The two halves said opposite things for a release: line 118 of the brief
   * said the summary is posted under *What changed in this PR* and must not
   * enumerate the findings, while three other lines told the model to label
   * each finding "in the summary". A model given both does both — #122's body
   * was a checklist and then every finding again as a paragraph — and nothing
   * downstream could tell.
   *
   * Pinned on the phrasing that caused it: the label named beside the place it
   * is written. A brief that starts saying "in the summary" again fails here
   * rather than on somebody's pull request.
   */
  it.each(halves)("%s never tells the model to put a finding in the summary", (_half, text) => {
    for (const line of text.split("\n")) {
      if (!/fix before merge/i.test(line)) continue;
      expect(line.toLowerCase(), line).not.toContain("in the summary");
    }
    expect(text.toLowerCase()).not.toContain("the summary and the finding");
  });

  /**
   * And the field that paragraph became. Two of them, because one 250-word
   * `summary` mixed what the change is with what the reviewer verified — and
   * the assessment sentence is a third, which is what the heading cannot say.
   * The description of the change is the pull request's `summary` now, beside
   * its `title` (#218), and `whatChanged` is asked for nowhere.
   */
  it.each(halves)("%s asks for the prose fields by name", (_half, text) => {
    for (const field of ["assessment", "howChecked", "title", "summary"]) {
      expect(text, field).toContain(field);
    }
    expect(text).not.toContain("whatChanged");
  });

  /**
   * **Ruling a carried finding `open` is the whole of reporting it.** The
   * brief once forbade restating it only in a second list and said nothing
   * about `findings`, which is where the rest of it says every finding goes,
   * and nothing dedupes, by design: ids are the workflow's and text is never
   * matched. So a re-raise mints a second thread, a second id and a second
   * entry in the count, carried separately every round after.
   */
  it.each(halves)("%s forbids writing an open carried finding up again", (_half, text) => {
    expect(plain(text)).toMatch(/not (?:also )?(?:write it up again|restate it)[^.]{0,160}`findings`/i);
  });

  /**
   * **Anchored at the change that causes it** (#127, decision 2).
   *
   * The brief is the half that makes the workflow's half worth having. The
   * workflow can only ever ask *is this anchor in the diff* — so a model told
   * nothing would keep pointing at the file it read the problem in, and every
   * such finding would land in `followUps` correctly and uselessly. What turns
   * a demotion into an anchored, threaded, maintainer-answerable finding is the
   * model knowing there is always a changed line to point at, and which one.
   */
  it.each(halves)("%s says to anchor an untouched file's problem at its cause", (_half, text) => {
    expect(plain(text)).toMatch(/anchored at (?:\*\*)?the change that causes it/i);
  });

  /** With the untouched location named in the text, or a reader cannot follow it. */
  it.each(halves)("%s carries the worked example, naming the untouched path:line", (_half, text) => {
    expect(text).toContain("src/api.ts:42");
    expect(text).toContain("docs/api.md:18");
  });

  /**
   * And the other arm, which is the one that decides what the workflow then
   * does: no cause in the diff means it was never this pull request's to fix.
   */
  it.each(halves)("%s sends a finding with no cause in the diff to followUps", (_half, text) => {
    expect(text).toContain("followUps");
    expect(plain(text)).toMatch(/moved to `?followUps`?/i);
  });

  /**
   * And **no half of the brief offers the review body as a place to put a
   * finding.** It was the third placement for two releases; a sentence left
   * behind would have the model writing anchors it believes will be listed
   * rather than threaded, and choosing them accordingly.
   */
  it.each(halves)("%s offers no body placement", (_half, text) => {
    expect(plain(text).toLowerCase()).not.toContain("in the review body");
  });

  /**
   * And that a decline rests on the maintainer's **latest** reply, which is the
   * only comment the workflow quotes when it closes. Without the rule the
   * review can read one comment and the thread can close under another's
   * words — including one that reversed the refusal.
   */
  it.each(halves)("%s rules a decline on the maintainer's latest reply", (_half, text) => {
    expect(plain(text)).toMatch(/latest reply/i);
  });

  it("names needsYou and the three cases it is for", () => {
    expect(PROMPT).toContain("needsYou");
    expect(EXTRACTION).toContain("needsYou");
    expect(PROMPT).toContain("the wrong thing was built");
    expect(PROMPT).toContain("the issue itself was wrong");
    expect(PROMPT).toMatch(/cannot say why/);
  });
});

/**
 * **The summary opens with a sketch drawn from the diff** (#354), the `pr`
 * skill's Summary: the smallest view that makes the point, then brief prose.
 *
 * Drawn from the diff rather than the issue, because the issue is what was
 * asked and a sketch of it shows a change the reader is not merging; and
 * outside the word budget, which `cappedWordsKeepingLines` holds the parser
 * to as well. The final review of a PRD PR is asked for the same, of its
 * outcome, from the runner's own text since that is where its shape lives.
 */
describe("the review brief's summary sketch", () => {
  const PROMPT = fs.readFileSync(path.join("review", "prompt.md"), "utf8");
  const RUNNER = fs.readFileSync(path.join("review", "review.ts"), "utf8");
  const plain = (text: string): string => text.replace(/[*_]/g, "").replace(/\s+/g, " ");
  const section = (): string => plain(PROMPT).match(/# THE TITLE AND THE SUMMARY.*?(?= # )/s)?.[0] ?? "";
  const finalShape = (): string => plain(RUNNER.match(/const FINAL_SUMMARY_SHAPE = \[.*?\]\.join/s)?.[0] ?? "");

  it("asks for zero, one or two sketches, each beside the text it supports", () => {
    expect(section()).toMatch(/smallest view that makes the point/i);
    expect(section()).toMatch(/zero, one or two sketches/i);
    expect(section()).toMatch(/beside the short text it supports/i);
  });

  it("names the forms, and prefers a diff where the shape already exists", () => {
    for (const form of ["call tree", "file tree", "pseudocode", "component tree", "Mermaid"]) {
      expect(section(), form).toContain(form);
    }
    expect(section()).toMatch(/prefer a `diff`/i);
  });

  it("draws a sketch from the diff as it stands, never from the issue", () => {
    expect(section()).toMatch(/from the diff as it stands, never from the issue/i);
  });

  it("keeps sketches outside the word budget, which stays for the prose", () => {
    expect(section()).toMatch(/about 150 words/);
    expect(section()).toMatch(/sketches do not count against/i);
  });

  it("asks for the project's own terms without naming a file that defines them", () => {
    expect(section()).toMatch(/domain terms?/i);
    expect(section()).not.toMatch(/GLOSSARY/);
  });

  it("keeps Differs from the issue as one bold-led line, left out when nothing differs", () => {
    expect(PROMPT).toContain("**Differs from the issue:**");
    expect(section()).toMatch(/leave (?:the line|it) out when nothing differs/i);
  });

  it("asks the final review for the same sketch of the outcome", () => {
    expect(finalShape()).toMatch(/outcome/);
    expect(finalShape()).toMatch(/smallest view that makes the point/i);
    expect(finalShape()).toMatch(/zero, one or two sketches/i);
    expect(finalShape()).toMatch(/from the diff as it stands/i);
    expect(finalShape()).toMatch(/do not count against/i);
  });
});

/**
 * **Merge Danger** (#356): the review writes its parts beside `summary`, and
 * the workflow lays them out. The door is whether a revert undoes the change,
 * held apart from when the change takes effect, which is blast radius: #330
 * was cheap to revert, and its danger was that it was live on merge.
 */
describe("the review brief's Merge Danger", () => {
  const PROMPT = fs.readFileSync(path.join("review", "prompt.md"), "utf8");
  const EXTRACTION = fs.readFileSync(path.join("review", "extraction.md"), "utf8");
  const RUNNER = fs.readFileSync(path.join("review", "review.ts"), "utf8");
  const plain = (text: string): string => text.replace(/[*_]/g, "").replace(/\s+/g, " ");
  const section = (): string => plain(PROMPT).match(/# THE TITLE AND THE SUMMARY.*?(?= # )/s)?.[0] ?? "";
  const finalShape = (): string => plain(RUNNER.match(/const FINAL_SUMMARY_SHAPE = \[.*?\]\.join/s)?.[0] ?? "");

  it.each([
    ["prompt.md", PROMPT],
    ["extraction.md", EXTRACTION],
  ])("%s asks for every field", (_half, text) => {
    for (const field of ["door", "doorNote", "blastRadius", "blastRadiusNote", "breaking"]) {
      expect(text, field).toContain(`\`${field}\``);
    }
  });

  it("defines a one-way door as one a revert cannot undo, and keeps timing under blast radius", () => {
    expect(section()).toMatch(/one-way door is one a revert cannot undo/i);
    expect(section()).toMatch(/when.{0,20}takes effect.*blast radius/i);
    expect(section()).toMatch(/`blastRadius`: one word/);
    expect(section()).toMatch(/from when: on merge, or at the next release/i);
    expect(section()).toMatch(/only where something is/i);
  });

  it("moves Breaking out of the summary's prose", () => {
    expect(PROMPT).not.toContain("**Breaking:**");
    expect(EXTRACTION).not.toContain("**Breaking:**");
    expect(section()).toMatch(/breaking change is not marked in the prose/i);
  });

  it("retires behaviourChanges, and has the final review write the Merge Danger of the whole PRD", () => {
    for (const text of [PROMPT, EXTRACTION, RUNNER]) expect(text).not.toContain("behaviourChanges");
    expect(finalShape()).toMatch(/`breaking`/);
    expect(finalShape()).toMatch(/Differs from the PRD/);
    // The runner hands the review's danger fields over, and publish lays the
    // PRD's Merge Danger out from them (ADR 0007).
    expect(RUNNER).toMatch(/danger: \{\s*\.\.\.\(output\.door === undefined/);
    expect(fs.readFileSync(path.join("review", "publish.ts"), "utf8")).toMatch(
      /renderPrdSummary\(\{\s*outcome: summary\.summary,\s*danger: summary\.danger,/,
    );
  });
});

/**
 * **One round finds the class** (#137).
 *
 * On #130 the review found one member of one class per round, and each fix
 * round repaired the member it was shown: a list of changed files missed a
 * spelling, then a status, then a quoting, then the two together. Every one of
 * them was reachable in round 1, and what made them dangerous was the same
 * change that made a missing file demote a finding instead of blocking on it —
 * a failure that used to be loud, made quiet.
 *
 * So the brief asks for two things a reviewer does not do by default:
 * enumerate what can reach the quiet branch rather than confirm the one input
 * the change was written for, and get its fixtures from the program whose
 * output the code reads rather than from the code that reads it. Mechanical
 * checks, for the reason the de-domaining ones are: the instruction is easy to
 * write once and easy to lose to the next pass that tightens the list.
 *
 * Only `prompt.md` is held to these. `extraction.md` says where each field
 * goes, and neither instruction is about a field.
 */
describe("the review brief asks for the class rather than the member", () => {
  const PROMPT = fs.readFileSync(path.join("review", "prompt.md"), "utf8");
  const plain = (text: string): string => text.replace(/[*_]/g, "").replace(/\s+/g, " ");

  /**
   * Item 4 exactly — from its own number to the next one, rather than a
   * character window that would run into item 5 and let a clause deleted from
   * item 4 be satisfied by its neighbour.
   */
  const item4 = (): string => plain(PROMPT).match(/4\. Tests.*?(?= 5\. )/s)?.[0] ?? "";

  it("names the shape it wants checked: a failure that used to be loud", () => {
    expect(plain(PROMPT)).toMatch(/used to block, fail or/i);
  });

  it("asks for every input that can reach the quiet path, not only the intended one", () => {
    expect(plain(PROMPT)).toMatch(/every input that can reach/i);
  });

  it("asks for the gaps in one round, grouped as one class", () => {
    expect(plain(PROMPT)).toMatch(/in one round/i);
    expect(plain(PROMPT)).toMatch(/as one class/i);
  });

  it("asks whether it could fail loudly instead, and prefers that", () => {
    expect(plain(PROMPT)).toMatch(/could fail loudly instead/i);
    expect(plain(PROMPT)).toMatch(/fail closed/i);
  });

  /**
   * The *realistic fixtures* item, made concrete. A sample written by hand
   * agrees with whatever the person writing it believed the format to be,
   * which is the belief the parser already encodes — so the two agree and the
   * program's own output is the only thing that disagrees.
   */
  it("takes a fixture for such code from the program whose output it reads", () => {
    expect(plain(PROMPT)).toMatch(/reads the output of another program/i);
    expect(plain(PROMPT)).toMatch(/run it|running it/i);
  });

  it("asks for what was run in the field that already carries it", () => {
    expect(item4()).toContain("howChecked");
  });

  /**
   * And it says where the input may be written, because *BOUNDARIES* is
   * described on line 8 as the full list of what a reviewer must not do — so an
   * item asking for a run whose inputs the checkout does not contain either
   * names a place for them or is unreachable, and a reviewer keeping the
   * boundary falls back to reading the parser. That is the failure the item
   * exists to remove.
   */
  it("says where an input the checkout does not contain may be built", () => {
    expect(item4()).toMatch(/scratch directory/i);
    expect(item4()).toMatch(/outside it|outside the checkout/i);
    expect(item4()).toMatch(/BOUNDARIES/);
  });

  /**
   * The boundary's own half of that. Scoped to the checkout rather than to
   * files, and stating the exception in the section line 8 points at — a
   * permission that lives only in item 4 is one the section calling itself the
   * full list contradicts.
   */
  it("scopes the boundary to the checkout and admits the run there", () => {
    const boundaries = plain(PROMPT).match(/# BOUNDARIES.*/is)?.[0] ?? "";

    expect(boundaries).toMatch(/do not modify the checkout/i);
    expect(boundaries).toMatch(/scratch directory outside the checkout/i);
    expect(boundaries).toMatch(/not permission to touch the branch/i);
  });
});

/**
 * GitHub's ceiling on a review body (#140). Over it the post is a 422 that
 * loses the threads along with the body, so the body is measured and shed in a
 * stated order — and refused by name where shedding is not enough.
 */
describe("the review body against GitHub's size limit", () => {
  const output: ReviewOutput = { findings: [], followUps: [], verified: [] };
  const parts = {
    verdict: VERDICTS["changes recommended"],
    output,
    placed: [],
    movedToFollowUps: 0,
    stillOpen: [],
    resolved: [],
    followUps: [],
    droppedFollowUps: 0,
  };

  /** Carried findings, each with its whole claim as the title the Open group lists. */
  const carriedOpen = (n: number, text: string): CarriedFinding[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `f-${i}`,
      threadId: `PRRT_${i}`,
      severity: "medium",
      text: `${i} ${text}`,
      title: `${i} ${text}`,
      anchor: `src/${i}.ts:1`,
    }));

  it("renders a body that fits exactly as it did before anything measured it", () => {
    const stillOpen = carriedOpen(3, "the key omits the tenant");
    const lines: string[] = [];
    const body = renderDecided({ ...parts, stillOpen, log: (line) => lines.push(line) });

    expect(body).toBe(renderDecided({ ...parts, stillOpen }));
    expect(body).not.toContain("To fit GitHub's");
    expect(lines).toEqual([]);
  });

  it("shortens an oversized Open group's evidence, says so, and keeps every entry", () => {
    const stillOpen = carriedOpen(100, "x".repeat(2_000));
    const lines: string[] = [];
    const body = renderDecided({ ...parts, stillOpen, log: (line) => lines.push(line) });

    expect(reviewBodySize(body)).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
    expect(body).toContain("the evidence quoted in the entries below was shortened");
    expect(body).toContain("**Findings:** 100");
    expect(body.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(100);
    expect(lines.join("\n")).toMatch(/evidence .* was shortened/);
  });

  /**
   * Multibyte text is measured in bytes, the unit never smaller than whatever
   * GitHub counts: 30,000 CJK characters are well under the limit in UTF-16
   * units and three times it in bytes.
   */
  it("measures multibyte content in bytes rather than in string length", () => {
    const stillOpen = carriedOpen(10, "漢".repeat(3_000));
    const unmeasured = stillOpen.map((f) => f.text).join("");
    expect(unmeasured.length).toBeLessThan(REVIEW_BODY_LIMIT);
    expect(reviewBodySize(unmeasured)).toBeGreaterThan(REVIEW_BODY_LIMIT);

    const body = renderDecided({ ...parts, stillOpen });
    expect(reviewBodySize(body)).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
    expect(body).toContain("was shortened");
  });

  it("cuts the payload's out-of-scope tail and never its moved prefix", () => {
    const moved = Array.from({ length: 50 }, (_, i) =>
      followUp({ title: `moved ${i}`, location: `src/m${i}.ts`, body: "m".repeat(1_100) }),
    );
    const outOfScope = Array.from({ length: 3 }, (_, i) =>
      followUp({ title: `oos ${i}`, location: `src/o${i}.ts`, body: "o".repeat(5_000) }),
    );
    const lines: string[] = [];
    const body = renderDecided({
      ...parts,
      movedToFollowUps: 50,
      followUps: [...moved, ...outOfScope],
      droppedFollowUps: 2,
      log: (line) => lines.push(line),
    });

    expect(reviewBodySize(body)).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);

    const block = parseFollowUpsBlock(body);
    expect(block?.moved).toBe(50);
    expect(block?.followUps.slice(0, 50)).toEqual(moved);
    const kept = (block?.followUps.length ?? 0) - 50;
    expect(kept).toBeGreaterThanOrEqual(0);
    expect(kept).toBeLessThan(3);
    // Every entry is accounted for: what is in it, and what it says it dropped.
    expect(block?.dropped).toBe(2 + (3 - kept));
    // And the size's part of that is named apart from the cap's (#140).
    expect(block?.cut).toBe(3 - kept);
    // The filing end's own cap leaves the kept list whole.
    expect(capFollowUps(block?.followUps.slice(block.moved) ?? []).kept).toHaveLength(kept);

    expect(body).toContain("the follow-up titles were left out");
    expect(body).toContain(`cut from the end of the list filed on merge`);
    expect(body).toContain(`<summary><b>Follow-ups</b> (${50 + kept}) ·`);
    // The visible group blames the cap for the cap's two alone, and claims no
    // listing it no longer shows; the shed sentence carries the size's count.
    expect(body).toContain("The cap keeps the 3 most serious out-of-scope findings; 2 more were dropped by it.");
    expect(body).not.toContain("findings are listed");
    expect(body).toContain(`${3 - kept} out-of-scope follow-up`);
    expect(lines).toHaveLength(1);
  });

  it("reads a cut past the dropped count as no more than it", () => {
    const body = `<!-- ${FOLLOW_UPS_MARKER} {"version":1,"dropped":1,"cut":4,"followUps":[]} -->`;

    expect(parseFollowUpsBlock(body)).toEqual({ followUps: [], dropped: 1, moved: 0, cut: 1, cap: 3 });
  });

  it("refuses a body that cannot be made to fit, naming its size and the limit", () => {
    const moved = Array.from({ length: 70 }, (_, i) =>
      followUp({ title: `moved ${i}`, location: `src/m${i}.ts`, body: "m".repeat(1_000) }),
    );

    expect(() =>
      renderDecided({ ...parts, movedToFollowUps: 70, followUps: moved }),
    ).toThrow(new RegExp(`is \\d+ bytes .*${REVIEW_BODY_LIMIT}-character limit`));
  });
});
