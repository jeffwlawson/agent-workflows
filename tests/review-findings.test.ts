import { describe, expect, it } from "vitest";
import { parseDiffLines } from "../shared/diff-lines.js";
import {
  FINDING_MARKER,
  findingMarker,
  isFixBeforeMerge,
  isPreviouslyMissed,
  newFindingId,
  openingClaim,
  parseFindingMarkers,
  placeFindings,
  PREVIOUSLY_MISSED_LABEL,
  renderBodyFindings,
  reviewMutation,
  reviewThreads,
  type Finding,
  type PlacedFinding,
} from "../shared/review-findings.js";
import { reviewOutputSchema, type ReviewOutput } from "../shared/review-output.js";

/**
 * Where a finding is posted is the workflow's decision, taken from the diff —
 * never the model's, which routinely invents a plausible line number. Three
 * placements, and the point of having three is that **none of them is
 * "nowhere"**: the filter this replaced dropped an off-hunk anchor outright, so
 * a review that found something could post a verdict counting it and no record
 * of what it was.
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
  ...over,
});

/** A counter, so a test can name the id the workflow wrote. */
const counting = (): (() => string) => {
  let n = 0;
  return () => `f-${++n}`;
};

const place = (findings: readonly Finding[]): PlacedFinding[] =>
  placeFindings(findings, DIFF_LINES, counting());

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
   * on, so it goes to the body with its `path:line` — the third placement, and
   * the one that used to be silence.
   */
  it("puts a finding in an untouched file in the review body", () => {
    expect(place([finding({ path: "src/other.ts", line: 88 })])[0]?.placement).toBe("body");
  });

  it("keeps every finding, whichever way it was placed", () => {
    const placed = place([
      finding({ line: 11 }),
      finding({ line: 400 }),
      finding({ path: "src/other.ts", line: 88 }),
    ]);

    expect(placed.map((p) => p.placement)).toEqual(["line", "file", "body"]);
    expect(placed.map((p) => p.finding.line)).toEqual([11, 400, 88]);
  });

  it("gives each finding its own id, in order", () => {
    expect(place([finding(), finding({ line: 400 })]).map((p) => p.id)).toEqual(["f-1", "f-2"]);
  });

  /** Two runs of the real generator must not collide, which is the whole of its job. */
  it("generates ids that differ", () => {
    expect(newFindingId()).not.toBe(newFindingId());
  });
});

describe("the id is the workflow's to write", () => {
  const parse = (value: unknown): ReviewOutput => {
    const result = reviewOutputSchema["~standard"].validate(value);
    if ("issues" in result && result.issues) {
      throw new Error(result.issues.map((i) => i.message).join("; "));
    }
    return (result as { value: ReviewOutput }).value;
  };

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
    expect(thread?.body).toContain(findingMarker("f-1"));
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

  it("makes no thread for a finding placed in the body", () => {
    expect(reviewThreads(place([finding({ path: "src/other.ts", line: 88 })]))).toEqual([]);
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
    expect(threads[0]?.body).toContain(findingMarker("f-1"));
    expect(threads[1]?.body).toContain(findingMarker("f-2"));
  });
});

describe("renderBodyFindings", () => {
  const rendered = (findings: readonly Finding[]): string | undefined =>
    renderBodyFindings(place(findings));

  it("is absent when every finding found a thread", () => {
    expect(rendered([finding({ line: 11 }), finding({ line: 400 })])).toBeUndefined();
  });

  it("lists an untouched file's finding with its anchor, its title, its id and its evidence", () => {
    const body = rendered([
      finding({
        path: "src/other.ts",
        line: 88,
        title: "the retry loop never terminates",
        body: "**Fix before merge.** `retry()` decrements a counter it never reads.",
      }),
    ]);

    expect(body).toContain("`src/other.ts:88`");
    expect(body).toContain("the retry loop never terminates");
    expect(body).toContain(findingMarker("f-1"));
    expect(body).toContain("`retry()` decrements a counter it never reads.");
  });

  /** A title the model wrapped cannot be allowed to break the entry it heads. */
  it("keeps a wrapped title on one line", () => {
    const body = rendered([
      finding({ path: "src/other.ts", title: "the retry loop\n  never terminates" }),
    ]);

    expect(body).toContain("the retry loop never terminates");
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
 * It counts as *fix before merge*, and that is the decision rather than a
 * detail of it — a finding the record missed says the record was wrong about
 * this pull request, which is a stronger reason to stop the merge than an
 * ordinary finding rather than a weaker one. Before #111 the round-2 brief sent
 * these to `followUps`, where they were filed as issues after the merge they
 * should have stopped.
 */
describe("a finding an earlier review missed", () => {
  const missed = (body: string): Finding => finding({ body });

  it("counts toward the merge on its own label", () => {
    expect(isFixBeforeMerge(missed("**Previously missed.** the cache key omits the tenant"))).toBe(
      true,
    );
    expect(isPreviouslyMissed(missed("**Previously missed.** the cache key omits the tenant"))).toBe(
      true,
    );
  });

  /** The same emphasis tolerance the other label has, for the same reason. */
  it.each([
    "**Previously missed.** the cache key omits the tenant",
    "__Previously missed__ — the cache key omits the tenant",
    "Previously missed: the cache key omits the tenant",
  ])("reads the label past whatever emphasis it was written in: %s", (body: string) => {
    expect(isPreviouslyMissed(missed(body))).toBe(true);
    expect(openingClaim(body)).toBe("the cache key omits the tenant");
  });

  it("is not read into a finding that merely says something was missed", () => {
    const body = "**Fix before merge.** the earlier round previously missed a case here";

    expect(isPreviouslyMissed(missed(body))).toBe(false);
    expect(isFixBeforeMerge(missed(body))).toBe(true);
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
  it("reads a body-findings entry, whose marker sits above its heading", () => {
    const body = renderBodyFindings(
      place([finding({ path: "src/other.ts", line: 88, title: "the cache key omits the tenant" })]),
    );

    expect(parseFindingMarkers(body ?? "")).toEqual([
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
