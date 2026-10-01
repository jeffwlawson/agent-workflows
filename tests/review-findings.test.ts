import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseDiffLines } from "../shared/diff-lines.js";
import { PACKAGE_NAME, VERSION } from "../shared/manifest.js";
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
  pathErrorNote,
  pathErrors,
  placeFindings,
  PREVIOUSLY_MISSED_LABEL,
  reviewMutation,
  reviewThreads,
  severityAssetPath,
  severityBadge,
  severityRank,
  severityTextBadge,
  severityWord,
  SEVERITIES,
  withoutFindingMarkers,
  withoutSeverityBadge,
  withSeverityBadgesAsText,
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

/**
 * **A path that names nothing is not "outside the change".** Demotion rests on
 * the path being a real file the pull request did not touch. A path that is no
 * file at all is a slip in the review, so it must not turn into a green verdict.
 */
describe("pathErrors", () => {
  const files = new Set(["src/queue.ts", "src/other.ts", "b/queue.ts", "src/café.ts"]);
  const repo = (path: string): boolean => files.has(path);

  it("passes over a real file the change did not touch — that one is a follow-up", () => {
    expect(pathErrors([finding({ path: "src/other.ts" })], repo)).toEqual([]);
  });

  it.each([
    ["a leading ./", "./src/other.ts"],
    ["surrounding space", " src/other.ts "],
    ["git's quoting", '"b/src/caf\\303\\251.ts"'],
    ["a directory really called b", "b/queue.ts"],
  ])("recognises a real file under %s", (_case, path) => {
    expect(pathErrors([finding({ path })], repo)).toEqual([]);
  });

  /**
   * Asked per path, and only of the unanchored ones — never the whole tree,
   * whose listing is unbounded output on a large repository.
   */
  it("asks about nothing when every finding was placed", () => {
    const asked: string[] = [];
    pathErrors([], (path) => (asked.push(path), true));

    expect(asked).toEqual([]);
  });

  it("reports a path that is no file in the repository", () => {
    const typo = finding({ path: "src/qeueu.ts" });

    expect(pathErrors([typo, finding({ path: "src/other.ts" })], repo)).toEqual([typo]);
  });
});

describe("pathErrorNote", () => {
  it("says nothing when every path is a real file", () => {
    expect(pathErrorNote([])).toBeUndefined();
  });

  it("names each path once and says why a human has to look", () => {
    const note = pathErrorNote([
      finding({ path: "src/qeueu.ts" }),
      finding({ path: "src/qeueu.ts", line: 20 }),
      finding({ path: "lib/nope.ts" }),
    ]);

    expect(note).toContain("3 findings name a path that is no file in this repository");
    expect(note).toContain("(`src/qeueu.ts`, `lib/nope.ts`)");
    expect(note).toContain("can hide a real blocker");
  });
});

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
   * **One reason, not two.** "Nothing this pull request changed causes it" is
   * inferred from a lookup failing, and that inference is only sound while the
   * lookup can fail for that reason alone. The keys are sliced off `+++ b/` and
   * `parseFinding` stores the model's path verbatim, so before this a model
   * that wrote `./src/queue.ts` — or the `b/` prefix it read off the diff
   * header, or a trailing space — had its finding demoted out of the count: no
   * thread, no record entry, *approval recommended* and a `success` status over
   * a blocker the review meant.
   *
   * So a miss is retried against the spellings a model reaches for. The anchor
   * comes back in the **diff's** spelling, not the model's, because the thread
   * is posted under this path and GitHub matches it against the diff the same
   * way this map does — a placement that then fails to post is the whole review
   * rejected.
   */
  it.each([
    ["a leading ./", "./src/queue.ts"],
    ["the diff header's b/", "b/src/queue.ts"],
    ["the diff header's a/", "a/src/queue.ts"],
    ["a leading /", "/src/queue.ts"],
    ["surrounding space", "  src/queue.ts "],
    ["both at once", " ./src/queue.ts"],
  ])("anchors a finding whose path carries %s", (_case, path) => {
    const placed = place([finding({ path, line: 11 })]);

    expect(placed[0]?.placement).toBe("line");
    expect(placed[0]?.finding.path).toBe("src/queue.ts");
    expect(reviewThreads(placed)[0]?.path).toBe("src/queue.ts");
  });

  /**
   * And nothing is normalised into existence. A repository whose diff really
   * does hold `b/queue.ts` matches on the first try, so the stripping below it
   * is never reached and its finding is not silently re-pointed at `queue.ts`.
   */
  it("prefers the spelling the diff holds over the one stripping would produce", () => {
    const lines = parseDiffLines(`diff --git a/b/queue.ts b/b/queue.ts
index 0ff3bbb..c6ca7ae 100644
--- a/b/queue.ts
+++ b/b/queue.ts
@@ -8,6 +8,7 @@
 const eight = 8;
+const nine = 9;
 const ten = 10;
`);
    const { placed } = placeFindings([finding({ path: "b/queue.ts", line: 9 })], lines, counting());

    expect(placed[0]?.finding.path).toBe("b/queue.ts");
    expect(placed[0]?.placement).toBe("line");
  });

  /**
   * A path copied out of the diff the way git quoted it — the `b/` inside the
   * quotes, the bytes octal-escaped — meets the key at the real path, which is
   * also the spelling the thread is posted under.
   */
  it("anchors a finding whose path is the diff's quoted spelling", () => {
    const lines = parseDiffLines(`diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
index 422c2b7..55dce13 100644
--- "a/src/caf\\303\\251.ts"
+++ "b/src/caf\\303\\251.ts"
@@ -1,2 +1,2 @@
 a
-b
+B
`);
    const { placed } = placeFindings(
      [finding({ path: '"b/src/caf\\303\\251.ts"', line: 2 })],
      lines,
      counting(),
    );

    expect(placed[0]?.finding.path).toBe("src/café.ts");
    expect(placed[0]?.placement).toBe("line");
  });

  /** A path no spelling reaches is still unanchored, which is the arm the rest rests on. */
  it("moves a finding whose path no spelling of it is in the diff", () => {
    expect(unanchored([finding({ path: "./src/other.ts", line: 88 })])).toHaveLength(1);
  });

  /**
   * **A file the change deleted, renamed or rewrote wholesale is still a file
   * the change touched** (#127). None of them names a new side — a deletion
   * writes `+++ /dev/null`, and a pure rename, a binary change and a mode
   * change write no `+++` line at all — so the diff holds no line for a thread
   * to anchor at, and `parseDiffLines` keys each of them with an empty set for
   * that reason (`shared/diff-lines.ts`).
   *
   * What that buys is the arm below: a file-level thread. Read as unanchored
   * instead, "you deleted `src/gone.ts`, which `src/index.ts` still imports"
   * would be subtracted from the count and filed as a follow-up — a finding
   * anchored at precisely what the change *did*, demoted for having been
   * anchored well.
   */
  it.each([
    ["a file it deleted", "src/gone.ts"],
    ["a file it renamed with no other change", "src/renamed.ts"],
    ["a file it changed in binary", "assets/logo.png"],
    ["a file whose mode alone it changed", "scripts/deploy.sh"],
  ])("threads a finding about %s on the file", (_case, path) => {
    const lines = parseDiffLines(`diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 422c2b7..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;
diff --git a/src/was.ts b/src/renamed.ts
similarity index 100%
rename from src/was.ts
rename to src/renamed.ts
diff --git a/assets/logo.png b/assets/logo.png
index 742c16a..b0e7c0e 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/scripts/deploy.sh b/scripts/deploy.sh
old mode 100644
new mode 100755
`);
    const { placed, unanchored: moved } = placeFindings([finding({ path, line: 1 })], lines, counting());

    expect(moved).toEqual([]);
    expect(placed[0]?.placement).toBe("file");
    // A file-level thread, which is the one shape GitHub takes here: the path
    // and no line at all.
    expect(reviewThreads(placed)).toEqual([{ path, body: expect.stringContaining("the guard") }]);
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
    expect(thread?.body).toContain(findingMarker("f-1", "medium", "t"));
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
   * The marker goes at the **end**. The badge and the claim are what a reader's
   * eye lands on and what the checklist reads, and a hidden comment ahead of
   * them displaces both.
   */
  it("ends every thread with the finding's id and leaves the badge in front", () => {
    const threads = reviewThreads(place([finding({ line: 11 }), finding({ line: 400 })]));

    for (const thread of threads) {
      expect(thread.body.startsWith(severityBadge("medium"))).toBe(true);
      expect(thread.body.trimEnd().endsWith("-->")).toBe(true);
      expect(thread.body.match(new RegExp(FINDING_MARKER, "g"))).toHaveLength(1);
    }
    expect(threads[0]?.body).toContain(findingMarker("f-1", "medium", "the guard runs after the return"));
    expect(threads[1]?.body).toContain(findingMarker("f-2", "medium", "the guard runs after the return"));
  });
});

/**
 * **One badge, two surfaces** (#135). The record entry and the thread it points
 * at used to label one finding two ways — the body said `Medium`, the thread
 * said *Fix before merge*, which every finding is — so the tests below hold the
 * thread to the same `severityBadge` the body renders, and hold the label that
 * said nothing out of it.
 */
describe("the thread a finding opens", () => {
  const bodyOf = (over: Partial<Finding> = {}): string =>
    reviewThreads(place([finding({ line: 11, ...over })]))[0]?.body ?? "";

  it.each(SEVERITIES)("opens with the badge the record entry shows, for %s", (severity) => {
    const body = bodyOf({ severity });

    expect(body.startsWith(`${severityBadge(severity)}\n\n`)).toBe(true);
    expect(body).toContain("the guard runs after the return");
  });

  /**
   * The label every finding carries by definition, gone: on a thread it told a
   * reader nothing, and it displaced the one thing that does say something.
   */
  it("no longer carries the label every finding carries", () => {
    expect(bodyOf()).not.toMatch(/fix before merge/i);
  });

  /**
   * *Previously missed* stays, because it is the label that decides something —
   * the group the record files the finding under — and a reader of the thread
   * should see the same fact.
   */
  it("keeps previously missed beside the badge, where it applies", () => {
    const body = bodyOf({
      // Both labels, in the order the label reader recognises: the badge
      // replaces one of them and the group keeps the other.
      body: "**Previously missed — fix before merge.** the guard runs after the return",
    });

    expect(body.startsWith(`${severityBadge("medium")} · ${PREVIOUSLY_MISSED_LABEL}\n\n`)).toBe(
      true,
    );
    expect(body).toContain("the guard runs after the return");
    expect(body).not.toMatch(/fix before merge/i);
  });

  /**
   * And a finding with no rating at all opens with something rather than with
   * an empty chip. Unreachable from a parsed output — `parseFinding` defaults
   * the severity — which is exactly why it is asserted here.
   */
  it("opens with no empty badge where there is no severity", () => {
    const rated = { severity: undefined } as unknown as Partial<Finding>;
    const plain = bodyOf(rated);
    const missed = bodyOf({
      ...rated,
      body: "**Previously missed.** the guard runs after the return",
    });

    expect(plain).not.toContain("<img");
    expect(plain.startsWith("the guard runs after the return")).toBe(true);
    expect(missed.startsWith(`${PREVIOUSLY_MISSED_LABEL}\n\n`)).toBe(true);
  });

  /**
   * The emphasis the label opened is closed after the claim where a model wrote
   * the two in one span, so taking the label leaves a `**` with nothing to pair
   * with — two literal asterisks on a thread that posts this verbatim.
   */
  it("leaves no half of an emphasis span the label opened", () => {
    expect(bodyOf({ body: "**Fix before merge. The guard runs after the return.**" })).toContain(
      "The guard runs after the return.\n",
    );
    expect(bodyOf({ body: "**Fix before merge. The guard runs late.**" })).not.toContain("**");
  });

  /** A body the model opened with no label of ours is posted as it was written. */
  it("leaves a body carrying no label of ours alone", () => {
    expect(bodyOf({ body: "> the guard runs after the return" })).toContain(
      "> the guard runs after the return",
    );
  });

  /**
   * And the claim is still readable back off the thread, which is what a later
   * round's record entry is built from: a reader that stopped at the labels
   * would take the `<img>` tag for the finding's claim.
   */
  it("still reads back as its claim rather than as the badge", () => {
    expect(openingClaim(bodyOf({ severity: "high" }))).toBe("the guard runs after the return");
    expect(
      openingClaim(
        bodyOf({ body: "**Fix before merge — previously missed.** the cache key omits the tenant" }),
      ),
    ).toBe("the cache key omits the tenant");
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

  /**
   * The badge a review surface renders: a chip **this repository hosts**, at a
   * URL built out of the manifest (#135). Decision 9 ruled out hotlinking
   * GitHub's own; a tag-pinned asset of our own is immutable, so a body written
   * today does not acquire a broken image on the day an upstream URL moves.
   *
   * The URL is built here rather than compared to a constant, because building
   * it from anything but the manifest is what the check is against: a version
   * written into source would be a nineteenth pin site and the one nothing
   * rewrites.
   */
  it.each(SEVERITIES)("renders %s as an image chip pinned to this release", (severity) => {
    const owner = PACKAGE_NAME.replace(/^@/, "");

    expect(severityBadge(severity)).toBe(
      `<picture><img src="https://raw.githubusercontent.com/${owner}/v${VERSION}/assets/severity-${severity}.svg" height="18" alt="${severityWord(severity)}" align="top"></picture>`,
    );
  });

  /**
   * And the three files are there, at the path the URL names — read through
   * `severityAssetPath` so the test cannot agree with a URL that moved. A
   * missing one is a broken image in every review of the release that ships it,
   * and nothing else would notice.
   */
  it.each(SEVERITIES)("ships a well-formed chip for %s at the path the URL names", (severity) => {
    const svg = fs.readFileSync(severityAssetPath(severity), "utf8").trim();

    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // The word, twice: the accessible name a reader of the file gets, and the
    // text drawn in the pill.
    expect(svg).toContain(`aria-label="${severityWord(severity)}"`);
    expect(svg).toContain(`>${severityWord(severity)}</text>`);

    // Well-formed, checked as nesting rather than by eye: every element opened
    // is closed, and in the order it was opened.
    const open: string[] = [];
    for (const [, closing, name, selfClosing] of svg.matchAll(
      /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g,
    )) {
      if (closing === "/") expect(open.pop()).toBe(name);
      else if (selfClosing !== "/") open.push(name ?? "");
    }
    expect(open).toEqual([]);
  });

  /**
   * The **alt text is the word**, which is what keeps the image from being the
   * only copy: an email that blocks images, and anything that turns a body or a
   * thread into prompt text for an agent, gets `Medium`.
   */
  it.each(SEVERITIES)("reduces a badge to its alt text for a reader of text, %s", (severity) => {
    expect(withSeverityBadgesAsText(`- ${severityBadge(severity)} the claim`)).toBe(
      `- ${severityWord(severity)} the claim`,
    );
  });

  /** And a badge from another release reduces too: the tag in the URL differs. */
  it("reduces a badge written by another release", () => {
    const older =
      '<img src="https://raw.githubusercontent.com/o/r/v0.4.0/assets/severity-high.svg" height="18" alt="High" align="top">';

    expect(withSeverityBadgesAsText(`${older} and ${older}`)).toBe("High and High");
    expect(withSeverityBadgesAsText(`<picture>${older}</picture> x`)).toBe("High x");
  });

  /** One surface renders no image, and it is not a review surface — see #135. */
  it("keeps a text badge for the surface that must render no image", () => {
    expect(severityTextBadge("high")).toBe("`High`");
    expect(severityTextBadge("low")).toBe("`Low`");
  });

  /**
   * And a runner that cannot say which version it is renders the text badge
   * rather than an `<img>` naming a tag like `vunknown`. Never a broken image:
   * a plain word is a worse chip and a far better failure.
   */
  it("falls back to the text badge where the manifest could not be read", async () => {
    vi.resetModules();
    vi.doMock("../shared/manifest.js", () => ({ VERSION: "unknown", PACKAGE_NAME: "unknown" }));
    try {
      const unread = await import("../shared/review-findings.js");

      expect(unread.severityBadge("medium")).toBe("`Medium`");
      expect(unread.severityBadge("medium")).not.toContain("<img");
    } finally {
      vi.doUnmock("../shared/manifest.js");
      vi.resetModules();
    }
  });

  /**
   * The strip `carriedClaim` reads a body entry back with, in every form a
   * release has written a badge in — the image, the bold code span of the
   * decision the image superseded, and the plain span v0.4.0 and v0.5.0 bodies
   * carry. A form this does not know is an entry that collects a second badge
   * every round it stays open.
   */
  it.each([
    ["the image chip", severityBadge("medium")],
    ["the bold code span", "**`Medium`**"],
    ["the plain code span", "`Medium`"],
    ["a bare chip from another release", '<img src="https://x/assets/severity-medium.svg" alt="Medium">'],
  ])("strips %s off a carried claim", (_form, badge) => {
    expect(withoutSeverityBadge(`${badge} the cache key omits the tenant`, "medium")).toBe(
      "the cache key omits the tenant",
    );
  });

  /** This entry's own badge and no other: a claim may legitimately quote one. */
  it("leaves a badge this entry's severity would not have written", () => {
    expect(withoutSeverityBadge("`Low` is not a place for preferences", "high")).toBe(
      "`Low` is not a place for preferences",
    );
    expect(withoutSeverityBadge(`${severityBadge("low")} chips`, "high")).toContain("<img");
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

    expect(lastFindingMarker(threads[0]?.body ?? "")?.severity).toBe("high");
  });

  /**
   * And the title (#134): a later round reads a threaded finding back off its
   * thread, and the record lists it under the words the raising review wrote
   * rather than the thread's opening paragraph.
   */
  it("puts the finding's title on the thread it opens, and reads it back", () => {
    const threads = reviewThreads(
      place([finding({ line: 11, title: "Warning asserts a verdict it could not see" })]),
    );

    expect(lastFindingMarker(threads[0]?.body ?? "")?.title).toBe(
      "Warning asserts a verdict it could not see",
    );
  });

  /**
   * The title is the model's prose inside an HTML comment, which ends at the
   * first `-->`. Written raw, a title holding one would close the marker early
   * and render the rest of it into the thread.
   */
  it("round-trips a title that could break an HTML comment", () => {
    const title = "a --> b -- c > d <!-- e — f";
    const marker = findingMarker("f-1", "low", title);

    expect(marker.match(/-->/g)).toHaveLength(1);
    expect(parseFindingMarkers(`- a claim ${marker}`)).toEqual([
      { id: "f-1", severity: "low", title, text: "a claim" },
    ]);
  });

  it("reads a title with no severity beside it", () => {
    expect(parseFindingMarkers(`- a claim ${findingMarker("f-1", undefined, "the title")}`)).toEqual([
      { id: "f-1", title: "the title", text: "a claim" },
    ]);
  });

  /** A marker holding a title is still a marker, so a model's copy is stripped whole. */
  it("strips a marker carrying a title out of what a model wrote", () => {
    expect(withoutFindingMarkers(`claim ${findingMarker("f-1", "high", "t")}`)).toBe("claim");
  });

  /**
   * A later release's marker keeps its id here: a token this version does not
   * know is dropped rather than failing the match, wherever it sits after the
   * id — the claim the pattern's comment makes, which before this it did not
   * keep (#134 review).
   */
  it.each([
    ["an unknown word where the severity goes", "<!-- agent-finding f-1 critical -->", { id: "f-1" }],
    ["an unknown word after the severity", "<!-- agent-finding f-1 high scope:x -->", { id: "f-1", severity: "high" }],
    [
      "an unknown word after the title",
      `<!-- agent-finding f-1 low title:${Buffer.from("t").toString("base64")} more:y -->`,
      { id: "f-1", severity: "low", title: "t" },
    ],
    ["several unknown words", "<!-- agent-finding f-1 a b c-->", { id: "f-1" }],
  ])("keeps the id through %s", (_, marker, expected) => {
    expect(parseFindingMarkers(`- a claim ${marker}`)).toEqual([{ ...expected, text: "a claim" }]);
    expect(withoutFindingMarkers(`claim ${marker}`)).toBe("claim");
  });

  it("ends a marker with an unknown tail at its own close", () => {
    expect(withoutFindingMarkers("a <!-- agent-finding f-1 x --> b <!-- c -->")).toBe("a  b <!-- c -->");
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
    title: `fix: move the guard ${CLOSED}`,
    summary: `It moves the guard above the return. ${LIVE}\n\n- the guard moved ${CLOSED}`,
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
    expect(output.title).toBe("fix: move the guard");
    expect(output.summary).toBe("It moves the guard above the return.\n\n- the guard moved");
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
    });

    const carried = carriedFindings({ threads: [], latestReviewBody: body });

    expect(carried).toEqual([]);
    expect(
      deriveVerdict(parse({}), { autoFix: false,
        ci: "green",
        fixRoundProgress: { given: 0, closed: 0 },
        stillOpen: carried.length,
        movedToFollowUps: 0,
        base: "main",
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

  /**
   * A thread a v0.4.0 review opened joins its labels with an em dash, and one
   * this release's prompt shapes joins them with a colon; the claim reader
   * takes both, plus the en dash and hyphen a model reaches for (#136). The
   * prompts stopped writing the dash; the reader must not stop reading it.
   */
  it.each(["—", "–", "-", ":"])("strips both labels joined by %s", (joint: string) => {
    expect(openingClaim(`**Fix before merge ${joint} previously missed.** the cache key omits the tenant`)).toBe(
      "the cache key omits the tenant",
    );
    expect(openingClaim(`**Fix before merge${joint}** the cache key omits the tenant`)).toBe(
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
