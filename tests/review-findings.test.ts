import { describe, expect, it } from "vitest";
import { parseDiffLines } from "../shared/diff-lines.js";
import {
  FINDING_MARKER,
  findingMarker,
  isPreviouslyMissed,
  lastFindingMarker,
  newFindingId,
  openingClaim,
  parseFinding,
  parseFindingMarkers,
  parseSeverity,
  placeFindings,
  PREVIOUSLY_MISSED_LABEL,
  reviewMutation,
  reviewThreads,
  severityBadge,
  severityRank,
  type Finding,
  type PlacedFinding,
} from "../shared/review-findings.js";
import {
  deriveVerdict,
  renderReviewBody,
  reviewOutputSchema,
  VERDICTS,
  type ReviewOutput,
} from "../shared/review-output.js";
import { carriedFindings } from "../shared/review-verification.js";

/**
 * Where a finding is posted is the workflow's decision, taken from the diff —
 * never the model's, which routinely invents a plausible line number. Two
 * placements, and both of them are a thread: an off-hunk anchor in a changed
 * file becomes a thread on the file rather than being dropped, which is what
 * kept a review from counting a finding it posted no record of. An anchor in a
 * file the diff does not cover reaches neither, and since #127 leaves here as a
 * follow-up rather than as an entry nobody can answer.
 *
 * The fixture is real `git diff` output. `src/queue.ts` is changed and its one
 * hunk covers new-side lines 8..15; `docs/notes.md` is changed too, so the
 * parser knows the file without every line of it being an anchor.
 */
const DIFF = `diff --git a/src/queue.ts b/src/queue.ts
index 0ff3bbb..c6ca7ae 100644
--- a/src/queue.ts
+++ b/src/queue.ts
@@ -8,6 +8,8 @@ export const drain = () => {
 const eight = 8;
 const nine = 9;
 const ten = 10;
+const eleven = 11;
+const twelve = 12;
 const thirteen = 13;
 const fourteen = 14;
 const fifteen = 15;
diff --git a/docs/notes.md b/docs/notes.md
index 1111111..2222222 100644
--- a/docs/notes.md
+++ b/docs/notes.md
@@ -1,2 +1,3 @@
 one
+two
 three
`;

const DIFF_LINES = parseDiffLines(DIFF);

const finding = (over: Partial<Finding> = {}): Finding => ({
  title: "the guard runs after the return",
  path: "src/queue.ts",
  line: 10,
  body: "**Fix before merge.** the guard runs after the return",
  severity: "medium",
  ...over,
});

/** A counter, so a test can name the id the workflow wrote. */
const counting = (): (() => string) => {
  let n = 0;
  return () => `f-${++n}`;
};

const place = (findings: readonly Finding[]): PlacedFinding[] =>
  placeFindings(findings, DIFF_LINES, counting()).placed;

/** The other half of the same call: what the diff gave no anchor to. */
const unanchored = (findings: readonly Finding[]): Finding[] =>
  placeFindings(findings, DIFF_LINES, counting()).unanchored;

describe("placeFindings", () => {
  it("threads a finding on a line inside a hunk", () => {
    expect(place([finding({ line: 11 })])[0]?.placement).toBe("line");
  });

  /** Context lines are anchors too — a hunk is its changes plus three either side. */
  it("threads a finding on a context line, not just an added one", () => {
    expect(place([finding({ line: 8 })])[0]?.placement).toBe("line");
    expect(place([finding({ line: 15 })])[0]?.placement).toBe("line");
  });

  it("threads a range whose every line is inside a hunk", () => {
    expect(place([finding({ startLine: 9, line: 12 })])[0]?.placement).toBe("line");
  });

  /**
   * The reroute that replaced the drop. A line anchor GitHub would reject takes
   * the finding to the file it is in rather than out of the review — and one
   * unresolvable anchor rejects the *whole* review, so this is still the guard
   * it was, with somewhere to put what it catches.
   */
  it("puts a finding past the hunks of a changed file on the file itself", () => {
    expect(place([finding({ line: 400 })])[0]?.placement).toBe("file");
  });

  it("puts a range that starts outside a hunk on the file, rather than dropping it", () => {
    expect(place([finding({ startLine: 4, line: 10 })])[0]?.placement).toBe("file");
  });

  it("puts a range with a gap in the middle on the file", () => {
    expect(place([finding({ path: "docs/notes.md", startLine: 1, line: 9 })])[0]?.placement).toBe(
      "file",
    );
  });

  /**
   * And a file the pull request never touched has no thread of any kind to hang
   * on — not even a file-level one. Since #127 that is not a third placement
   * but the answer that takes the finding out of the review: nothing the change
   * did causes it, so it is a follow-up rather than a blocker, and it leaves
   * here in the other list.
   */
  it("places nothing for a finding in a file the pull request never touched", () => {
    const findings = [finding({ path: "src/other.ts", line: 88 })];

    expect(place(findings)).toEqual([]);
    expect(unanchored(findings)).toEqual(findings);
  });

  /**
   * And it carries **no id**, which is the mechanical half of "it is not a
   * finding this pull request owns": an id exists so a later round recognises
   * something it raised, and this is never raised.
   */
  it("spends no id on a finding it could not anchor", () => {
    const placed = place([finding({ path: "src/other.ts", line: 88 }), finding({ line: 11 })]);

    expect(placed.map((p) => p.id)).toEqual(["f-1"]);
  });

  it("keeps every finding, whichever list it went to", () => {
    const findings = [
      finding({ line: 11 }),
      finding({ line: 400 }),
      finding({ path: "src/other.ts", line: 88 }),
    ];
    const { placed, unanchored: moved } = placeFindings(findings, DIFF_LINES, counting());

    expect(placed.map((p) => p.placement)).toEqual(["line", "file"]);
    expect(placed.map((p) => p.finding.line)).toEqual([11, 400]);
    expect(moved.map((f) => f.line)).toEqual([88]);
  });

  it("gives each finding its own id, in order", () => {
    expect(place([finding(), finding({ line: 400 })]).map((p) => p.id)).toEqual(["f-1", "f-2"]);
  });

  /** Two runs of the real generator must not collide, which is the whole of its job. */
  it("generates ids that differ", () => {
    expect(newFindingId()).not.toBe(newFindingId());
  });
});

/** The schema, which is the boundary every string the model wrote comes through. */
const parse = (value: unknown): ReviewOutput => {
  const result = reviewOutputSchema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error(result.issues.map((i) => i.message).join("; "));
  }
  return (result as { value: ReviewOutput }).value;
};

describe("the id is the workflow's to write", () => {
  /**
   * A model-written id would be matched against a thread it did not open. The
   * schema has no field for one, so an id in the output is dropped before
   * anything can read it — and the id the thread carries is the one
   * `placeFindings` assigned.
   */
  it("drops an id the model wrote and posts its own", () => {
    const output = parse({
      summary: "s",
      findings: [{ id: "f-modelwrote", title: "t", path: "src/queue.ts", line: 11, body: "b" }],
    });

    expect("id" in (output.findings[0] ?? {})).toBe(false);

    const [thread] = reviewThreads(place(output.findings));
    expect(thread?.body).toContain(findingMarker("f-1", "medium"));
    expect(thread?.body).not.toContain("f-modelwrote");
  });

  /**
   * A title is what the body lists a finding under, so a model that omitted one
   * must not cost the review. It falls back to the claim the finding opens
   * with, past the label.
   */
  it("falls back to the claim when the model wrote no title", () => {
    const output = parse({
      summary: "s",
      findings: [
        {
          path: "src/queue.ts",
          line: 11,
          body: "**Fix before merge.** the guard runs after the return\n\nmore",
        },
      ],
    });

    expect(output.findings[0]?.title).toBe("the guard runs after the return");
  });
});

describe("reviewThreads", () => {
  it("anchors a line thread on the right side, with no range for a single line", () => {
    const [thread] = reviewThreads(place([finding({ line: 11 })]));

    expect(thread).toMatchObject({ path: "src/queue.ts", line: 11, side: "RIGHT" });
    expect("startLine" in (thread ?? {})).toBe(false);
  });

  it("carries a range as startLine/startSide, which is what a multi-line suggestion replaces", () => {
    const [thread] = reviewThreads(place([finding({ startLine: 9, line: 12 })]));

    expect(thread).toMatchObject({ startLine: 9, startSide: "RIGHT", line: 12, side: "RIGHT" });
  });

  /** A file-level thread is the same call with no `line` at all — not line 0, not a null. */
  it("names the path and no line for a file-level thread", () => {
    const [thread] = reviewThreads(place([finding({ line: 400 })]));

    expect(thread?.path).toBe("src/queue.ts");
    expect("line" in (thread ?? {})).toBe(false);
    expect("side" in (thread ?? {})).toBe(false);
  });

  /**
   * Nothing is filtered here any more, and nothing needs to be: every placement
   * `placeFindings` returns is one GitHub will open a thread for, so the count
   * of threads is the count of placed findings.
   */
  it("opens a thread for every placed finding", () => {
    const placed = place([finding({ line: 11 }), finding({ line: 400 })]);

    expect(reviewThreads(placed)).toHaveLength(placed.length);
  });

  /**
   * The marker goes at the **end**. The claim a finding opens with is what the
   * checklist reads and what a reader's eye lands on, and a hidden comment
   * ahead of it displaces both.
   */
  it("ends every thread with the finding's id and leaves the claim in front", () => {
    const threads = reviewThreads(place([finding({ line: 11 }), finding({ line: 400 })]));

    for (const thread of threads) {
      expect(thread.body.startsWith("**Fix before merge.**")).toBe(true);
      expect(thread.body.trimEnd().endsWith("-->")).toBe(true);
      expect(thread.body.match(new RegExp(FINDING_MARKER, "g"))).toHaveLength(1);
    }
    expect(threads[0]?.body).toContain(findingMarker("f-1", "medium"));
    expect(threads[1]?.body).toContain(findingMarker("f-2", "medium"));
  });
});

/**
 * Severity is display and ordering (#109, decision 9), and the properties worth
 * holding are the ones that keep it from becoming anything else: it never loses
 * a review, it never *invents* a rating that reads as the model's, and it
 * survives a round so the record can sort a carried finding beside a fresh one.
 */
describe("severity", () => {
  it.each([
    ["High", "high"],
    ["  medium  ", "medium"],
    ["LOW", "low"],
  ] as const)("reads %s in whatever casing the model wrote it", (written, expected) => {
    expect(parseSeverity(written)).toBe(expected);
  });

  /**
   * The middle, for anything absent or unrecognised. `high` would make every
   * unlabelled finding shout and `low` would bury one, and refusing the output
   * would lose the whole review over a display field.
   */
  it.each([undefined, null, "", "critical", 3] as const)(
    "defaults %s to the middle rather than refusing it",
    (written) => {
      expect(parseSeverity(written)).toBe("medium");
    },
  );

  it("defaults a finding the model rated nothing, rather than losing it", () => {
    const parsed = parseFinding({ path: "src/a.ts", line: 4, body: "b" });

    expect(parsed.severity).toBe("medium");
  });

  /** Text, never one of GitHub's severity images — decision 9 rules the hotlink out. */
  it("renders a badge as text rather than an image", () => {
    expect(severityBadge("high")).toBe("`High`");
    expect(severityBadge("low")).toBe("`Low`");
    expect(severityBadge("medium")).not.toContain("http");
  });

  it("ranks worst first, and an unrated entry last of all", () => {
    expect(severityRank("high")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("low"));
    expect(severityRank("low")).toBeLessThan(severityRank(undefined));
  });
});

/**
 * The marker carries the rating beside the id because a later round has nowhere
 * else to read it from: a carried finding arrives as an id and one line of
 * text, so without this the record would badge what this round found and
 * nothing it carried.
 */
describe("the finding marker", () => {
  it("writes the severity beside the id, and reads both back", () => {
    expect(parseFindingMarkers(`- a claim ${findingMarker("f-1", "high")}`)).toEqual([
      { id: "f-1", severity: "high", text: "a claim" },
    ]);
  });

  /**
   * And a marker from a release that wrote no severity still yields its id.
   * Identity is the half that has to survive a format this version has not met
   * — a body it cannot read is a finding raised again in the next round.
   */
  it("still reads the id off a marker written before severities existed", () => {
    expect(parseFindingMarkers(`- a claim ${findingMarker("f-1")}`)).toEqual([
      { id: "f-1", text: "a claim" },
    ]);
  });

  it("puts the finding's severity on the thread it opens", () => {
    const threads = reviewThreads(place([finding({ line: 11, severity: "high" })]));

    expect(threads[0]?.body).toContain(findingMarker("f-1", "high"));
  });
});

/**
 * **A marker the model wrote is taken out of every string it wrote it in.**
 *
 * The prompt says to write no identifier of any kind, and this is the
 * mechanical half of that — `docs/parity.md` §10: a channel the prompt bounds
 * is also bounded mechanically. The strip runs once, over the whole output, at
 * the schema boundary (`withoutFindingMarkers`), which is what makes that
 * sentence true of the *channel* rather than of one field of it.
 *
 * It was true of one field of five for a release. `body` was stripped and
 * `title` was not, and neither were `assessment`, `howChecked`, `whatChanged`
 * or a follow-up's three strings — so a marker in any of them reached the
 * posted body intact. This is deliberately a test of the whole surface rather
 * than of the field that was reported: the next field added is the one nobody
 * would remember to write a case for.
 *
 * The risk is not hypothetical. The feedback surface renders live markers
 * verbatim into the prompt, so the model is shown the exact syntax and this
 * round's real ids.
 */
describe("an identifier the model smuggled into its output", () => {
  /** An id this round really handed over, and one an earlier round closed. */
  const LIVE = findingMarker("f-live", "high");
  const CLOSED = findingMarker("f-closed", "low");

  /** One in every string field the schema reads, under both spellings of id. */
  const SMUGGLED = {
    assessment: `The guard and the cache key are each wrong. ${LIVE}`,
    howChecked: `Re-read the thread ${CLOSED} and the guard.`,
    whatChanged: {
      summary: `It moves the guard above the return. ${LIVE}`,
      changes: [`the guard moved ${CLOSED}`, `a test was added ${LIVE}`],
    },
    needsYou: `the issue asked for the opposite ${CLOSED}`,
    fixBeforeMerge: [`the guard runs after the return ${LIVE}`],
    findings: [
      {
        title: `the guard runs after the return ${CLOSED}`,
        path: "src/queue.ts",
        line: 11,
        severity: "high",
        body: `**Fix before merge.** the guard runs after the return ${LIVE}`,
      },
      {
        title: `the cache key omits the tenant ${LIVE}`,
        path: "docs/notes.md",
        line: 2,
        severity: "low",
        body: `**Fix before merge.** \`key()\` hashes the id and not the tenant ${CLOSED}`,
      },
    ],
    followUps: [
      {
        title: `Leak in parse() ${CLOSED}`,
        location: `src/other.ts:88 ${LIVE}`,
        body: `evidence it is real ${CLOSED}`,
        severity: "medium",
      },
    ],
    verified: [{ id: "f-1", status: "open", note: `still returns early ${LIVE}` }],
  };

  /** Every string anywhere in a parsed output, however deeply nested. */
  const stringsIn = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(stringsIn);
    if (typeof value === "object" && value !== null) {
      return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
    }
    return [];
  };

  it("leaves no marker in any field of the parsed output", () => {
    const strings = stringsIn(parse(SMUGGLED));

    // The fixture has to actually reach every field, or this passes by being
    // about nothing: eleven strings carried a marker going in.
    expect(strings.length).toBeGreaterThan(10);
    for (const written of strings) expect(written, written).not.toContain(FINDING_MARKER);
  });

  it("keeps the words around it, rather than losing the field", () => {
    const output = parse(SMUGGLED);

    expect(output.assessment).toBe("The guard and the cache key are each wrong.");
    expect(output.howChecked).toBe("Re-read the thread  and the guard.");
    expect(output.whatChanged?.changes).toEqual(["the guard moved", "a test was added"]);
    expect(output.needsYou).toBe("the issue asked for the opposite");
    expect(output.findings[0]?.title).toBe("the guard runs after the return");
    expect(output.followUps[0]?.location).toBe("src/other.ts:88");
    expect(output.verified[0]?.note).toBe("still returns early");
  });

  /**
   * And the end of it: what a later round reads back off the pull request is
   * the ids **this** workflow assigned, and no others. Asserted over everything
   * posted — the review body and every thread it opens — because a marker that
   * reached either is one a later round would rule on.
   */
  it("posts only the markers the workflow wrote, across the body and every thread", () => {
    const output = parse(SMUGGLED);
    const { placed } = placeFindings(output.findings, DIFF_LINES, counting());
    const body = renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output,
      placed,
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [],
      followUps: output.followUps,
      droppedFollowUps: 0,
      showWhatChanged: true,
    });
    const posted = [body, ...reviewThreads(placed).map((t) => t.body)].join("\n");

    expect(parseFindingMarkers(posted).map((m) => m.id).sort()).toEqual(["f-1", "f-2"]);
    for (const id of ["f-live", "f-closed"]) expect(posted).not.toContain(id);
  });

  /**
   * **The reviewer's own case**, which is why this is a fix-before-merge rather
   * than a tidy-up: a marker in `howChecked` carried a closed finding's id into
   * the posted body, where the next round reads the body as the record of what
   * is still open. Ran as reported, it turned round N's *approval recommended*
   * into round N+1's *changes recommended* with no code change between them,
   * under a fragment of the previous review's prose.
   */
  it("does not let a marker in the prose change the next round's verdict", () => {
    const clean = parse({
      assessment: "The change holds up.",
      howChecked: `Re-read the thread ${CLOSED} and the guard.`,
    });
    const body = renderReviewBody({
      verdict: VERDICTS["approval recommended"],
      output: clean,
      placed: [],
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [],
      followUps: [],
      droppedFollowUps: 0,
      showWhatChanged: true,
    });

    const carried = carriedFindings({ threads: [], latestReviewBody: body });

    expect(carried).toEqual([]);
    expect(
      deriveVerdict(parse({}), {
        ci: "green",
        round: 2,
        stillOpen: carried.length,
        movedToFollowUps: 0,
      }).verdict,
    ).toBe("approval recommended");
  });
});

/**
 * **One reader, and it takes the last marker on the line.** The workflow writes
 * its own last — at the end of a thread body and at the end of a record entry —
 * so an earlier one on the same line is a marker the line quoted.
 *
 * Both halves used to answer this differently: `parseFindingMarkers` took the
 * first marker on a line and `shared/pr-feedback.ts` took the last, so the one
 * line the question matters on was the one they disagreed about. There is one
 * function now, and these are its two entry points.
 */
describe("a line carrying two markers", () => {
  it("is read as the last of them, whole-body and per-line alike", () => {
    const line = `- a claim ${findingMarker("f-OLD", "high")} and ${findingMarker("f-NEW", "low")}`;

    expect(parseFindingMarkers(line)).toEqual([
      { id: "f-NEW", severity: "low", text: "a claim  and" },
    ]);
    expect(lastFindingMarker(line)).toEqual({ id: "f-NEW", severity: "low", text: "a claim  and" });
  });

  /** Across lines too, where the workflow's own is on the last of them. */
  it("is read as the last of them across a body", () => {
    const body = `quoting ${findingMarker("f-OLD")}\n\n${findingMarker("f-NEW")}\n\na claim`;

    expect(lastFindingMarker(body)?.id).toBe("f-NEW");
  });

  it("carries no marker where a body holds none", () => {
    expect(lastFindingMarker("### \ud83d\udfe2 Approval recommended")).toBeUndefined();
  });
});

describe("reviewMutation", () => {
  const mutation = reviewMutation({
    pullRequestId: "PR_kwDOabc",
    commitOID: "abc123",
    body: "the review body",
    placed: place([finding({ line: 11 }), finding({ path: "src/other.ts", line: 88 })]),
  });

  /**
   * The mutation and the `--jq` path the workflow reads its answer out of are
   * one shape; a test in `tests/workflows.test.ts` holds the second half to
   * this one.
   */
  it("asks for the review's own url back, which is the only place it exists", () => {
    expect(mutation.query).toContain("addPullRequestReview");
    expect(mutation.query).toContain("pullRequestReview");
    expect(mutation.query).toContain("url");
  });

  it("pins the review to the head it reviewed and comments rather than approving", () => {
    expect(mutation.variables.input).toMatchObject({
      pullRequestId: "PR_kwDOabc",
      commitOID: "abc123",
      event: "COMMENT",
      body: "the review body",
    });
  });

  it("carries only the findings that became threads", () => {
    expect(mutation.variables.input.threads).toHaveLength(1);
    expect(mutation.variables.input.threads[0]).toMatchObject({ path: "src/queue.ts", line: 11 });
  });

  /** It has to survive `JSON.stringify` — the runner writes it to a file. */
  it("round-trips as JSON", () => {
    expect(JSON.parse(JSON.stringify(mutation))).toEqual(mutation);
  });
});

/**
 * *Previously missed* (#109, decision 4): a real problem a later review finds
 * in code an earlier review already read.
 *
 * It counts exactly as every other finding does — a finding the record missed
 * says the record was wrong about this pull request, which is a stronger
 * reason to stop the merge than an ordinary finding rather than a weaker one.
 * Before #111 the round-2 brief sent these to `followUps`, where they were
 * filed as issues after the merge they should have stopped.
 *
 * What the label decides is the **group**, and that is now the only thing any
 * label decides: there is no `isFixBeforeMerge` beside this, because a
 * predicate over the other label was a second definition of "a finding
 * counts", and a body it did not recognise was a finding the verdict did not
 * see.
 */
describe("a finding an earlier review missed", () => {
  const missed = (body: string): Finding => finding({ body });

  it("is read off its own label", () => {
    expect(isPreviouslyMissed(missed("**Previously missed.** the cache key omits the tenant"))).toBe(
      true,
    );
  });

  /** The same emphasis tolerance the claim reader has, for the same reason. */
  it.each([
    "**Previously missed.** the cache key omits the tenant",
    "__Previously missed__ — the cache key omits the tenant",
    "Previously missed: the cache key omits the tenant",
  ])("reads the label past whatever emphasis it was written in: %s", (body: string) => {
    expect(isPreviouslyMissed(missed(body))).toBe(true);
    expect(openingClaim(body)).toBe("the cache key omits the tenant");
  });

  /**
   * The drift a model actually produces, which `^[\\s*_]*` refused. Nothing is
   * counted or dropped on this answer any more, so what it costs is a
   * previously-missed finding filed under *Open* and a label left standing at
   * the front of the one-line claim the record shows.
   */
  it.each([
    "### Fix before merge\n\nthe cache key omits the tenant",
    "> **Fix before merge.** the cache key omits the tenant",
    "### Previously missed\n\nthe cache key omits the tenant",
  ])("reads a label a model wrote as a heading or inside a quote: %s", (body: string) => {
    expect(openingClaim(body)).toBe("the cache key omits the tenant");
  });

  it("reads it as a heading, which is where a group would otherwise be lost", () => {
    expect(isPreviouslyMissed(missed("### Previously missed\n\nthe cache key omits the tenant"))).toBe(
      true,
    );
  });

  it("is not read into a finding that merely says something was missed", () => {
    expect(
      isPreviouslyMissed(missed("**Fix before merge.** the earlier round previously missed a case here")),
    ).toBe(false);
  });

  /**
   * Both labels at once is the shape the brief asks for when a model writes the
   * ordinary label too, and the claim has to survive it: this is the line the
   * checklist and the body entry are built from.
   */
  it("strips both labels off the claim, in either order", () => {
    expect(openingClaim("**Fix before merge — previously missed.** the cache key omits the tenant")).toBe(
      "the cache key omits the tenant",
    );
    expect(openingClaim("**Previously missed — fix before merge.** the cache key omits the tenant")).toBe(
      "the cache key omits the tenant",
    );
  });

  it("spells the label in one place", () => {
    expect(PREVIOUSLY_MISSED_LABEL).toBe("Previously missed");
  });
});

/**
 * Reading ids back out of a body, which is what lets a finding with no thread
 * survive a round (#111). A body entry has no surface of its own to stay open
 * on, so the *newest* review body naming it is the whole of its record — and a
 * parser that could not find it there would lose it silently, one round after
 * it was raised.
 *
 * One rule covers both places a marker is written, which is what keeps the
 * marker one format: the rest of the marker's own line, or the next non-empty
 * line where it sits alone.
 */
describe("parseFindingMarkers", () => {
  it("reads an entry whose marker sits alone above it", () => {
    const body = [findingMarker("f-1"), "", "**`src/other.ts:88` — the cache key omits the tenant**"].join(
      "\n",
    );

    expect(parseFindingMarkers(body)).toEqual([
      { id: "f-1", text: "`src/other.ts:88` — the cache key omits the tenant" },
    ]);
  });

  it("reads a checklist entry, whose marker sits at the end of its line", () => {
    const body = `- [ ] \`src/queue.ts:206\` — the guard runs after the return ${findingMarker("f-7")}`;

    expect(parseFindingMarkers(body)).toEqual([
      { id: "f-7", text: "`src/queue.ts:206` — the guard runs after the return" },
    ]);
  });

  it("finds every marker in a body, in the order they appear", () => {
    const body = [
      `- [ ] one ${findingMarker("f-1")}`,
      `- [ ] two ${findingMarker("f-2")}`,
    ].join("\n");

    expect(parseFindingMarkers(body).map((e) => e.id)).toEqual(["f-1", "f-2"]);
  });

  it("finds nothing in a body that carries none", () => {
    expect(parseFindingMarkers("### 🟢 Approval recommended\n\nNothing to fix.")).toEqual([]);
  });
});
