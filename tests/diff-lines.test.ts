import { describe, expect, it } from "vitest";
import { parseDiffLines } from "../shared/diff-lines.js";

/**
 * `parseDiffLines` builds the allow-list that inline review comments are
 * filtered against. GitHub rejects an *entire* review if one comment anchors
 * outside the diff, so an off-by-one here does not degrade a review — it
 * silently posts nothing. The core is the new-file line counter: added and
 * context lines advance it, removed lines do not, and each `@@` header reloads
 * it from the new-file start.
 *
 * Every diff below is real `git diff` output (generated, then pasted), including
 * its trailing newline — that is what `git(["diff", …])` hands the parser in
 * production. The parser strips that trailing newline before splitting, so the
 * trailing empty string it would otherwise yield is not counted: no phantom line
 * is emitted past the end of the diff's final file. The tests below can and do
 * assert exact set equality on the line sets they target.
 */

const linesOf = (diff: string, file: string): Set<number> => {
  const set = parseDiffLines(diff).get(file);
  if (!set) throw new Error(`parseDiffLines produced no entry for ${file}`);
  return set;
};

const exactly = (diff: string, file: string): number[] =>
  [...linesOf(diff, file)].sort((a, b) => a - b);

describe("parseDiffLines — added and context lines", () => {
  // Additions live deep in the file, so the hunk header is `+8`, not `+1`. The
  // added lines must be numbered from that header start, not from 1.
  const midFile = `diff --git a/big.txt b/big.txt
index 0ff3bbb..c6ca7ae 100644
--- a/big.txt
+++ b/big.txt
@@ -8,6 +8,8 @@
 8
 9
 10
+NEWA
+NEWB
 11
 12
 13
`;

  it("numbers added lines from the hunk header's new-file start", () => {
    const lines = linesOf(midFile, "big.txt");
    // Context 8, 9, 10 → then NEWA is 11 and NEWB is 12, counting on from +8.
    expect(lines.has(11)).toBe(true);
    expect(lines.has(12)).toBe(true);
    // Nothing before the hunk's new-file start is in range.
    expect(lines.has(7)).toBe(false);
  });

  it("includes context lines — they are valid comment anchors", () => {
    const lines = linesOf(midFile, "big.txt");
    expect(lines.has(8)).toBe(true);
    expect(lines.has(9)).toBe(true);
    expect(lines.has(10)).toBe(true);
  });

  it("emits exactly the hunk's new-file lines and nothing past the end", () => {
    // Context 8–10, NEWA=11, NEWB=12, context 11–13 → new lines 13–15. No
    // trailing phantom line 16 from the diff's final newline.
    expect(exactly(midFile, "big.txt")).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe("parseDiffLines — removed lines", () => {
  // k1 / k2 are context; `removeme` is deleted and `ADDED` inserted in its
  // place. In the new file: k1=1, ADDED=2, k2=3.
  const removal = `diff --git a/rem.txt b/rem.txt
index 07795f6..1450354 100644
--- a/rem.txt
+++ b/rem.txt
@@ -1,3 +1,3 @@
 k1
-removeme
+ADDED
 k2
`;

  it("excludes removed lines and does not advance the counter past them", () => {
    const lines = linesOf(removal, "rem.txt");
    expect(lines.has(1)).toBe(true); // k1
    // ADDED is line 2, NOT 3: the removed `removeme` did not advance the count.
    expect(lines.has(2)).toBe(true);
    // k2 is line 3, NOT 4: still no shift from the removal.
    expect(lines.has(3)).toBe(true);
    // Exactly 1–3: no phantom line 4 past the end of the file.
    expect(exactly(removal, "rem.txt")).toEqual([1, 2, 3]);
  });
});

describe("parseDiffLines — trailing addition at end of file", () => {
  // The last line of the last file is an added line — exactly the anchor a
  // reviewer commenting on a trailing addition produces. one=1, two=2,
  // three=3; the diff's trailing newline must not append a phantom line 4.
  const trailingAdd = `diff --git a/tail.txt b/tail.txt
index 814f4a4..4cb29ea 100644
--- a/tail.txt
+++ b/tail.txt
@@ -1,2 +1,3 @@
 one
 two
+three
`;

  it("emits no phantom line past the final added line", () => {
    expect(exactly(trailingAdd, "tail.txt")).toEqual([1, 2, 3]);
  });
});

describe("parseDiffLines — multiple hunks in one file", () => {
  // Two hunks. The second's header (`@@ -8,5 +8,5 @@ l7`) is non-contiguous with
  // the first, so line 7 falls between them and belongs to no hunk.
  const twoHunks = `diff --git a/m.txt b/m.txt
index 1b2a1c5..f52caf0 100644
--- a/m.txt
+++ b/m.txt
@@ -1,6 +1,6 @@
 l1
 l2
-l3
+ADDED
 l4
 l5
 l6
@@ -8,5 +8,5 @@ l7
 l8
 l9
 l10
-l11
+CHANGED
 l12
`;

  it("resets the counter at each hunk header instead of running on", () => {
    const lines = linesOf(twoHunks, "m.txt");
    // First hunk: ADDED replaces l3 at line 3, and l4 stays at 4 (no shift).
    expect(lines.has(3)).toBe(true);
    expect(lines.has(4)).toBe(true);
    // Line 7 is between the hunks — never emitted. If the counter had run on
    // from the first hunk rather than reloading from `+8`, 7 would be present.
    expect(lines.has(7)).toBe(false);
    // Second hunk picks up from its header start of 8; CHANGED lands at 11.
    expect(lines.has(8)).toBe(true);
    expect(lines.has(11)).toBe(true);
    // Exactly the two hunks' new-file lines: 1–6 then 8–12, with 7 (between the
    // hunks) and any trailing phantom line 13 both absent.
    expect(exactly(twoHunks, "m.txt")).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
  });
});

describe("parseDiffLines — multiple files in one diff", () => {
  const twoFiles = `diff --git a/add.txt b/add.txt
index 9405325..f7e12a9 100644
--- a/add.txt
+++ b/add.txt
@@ -1,5 +1,7 @@
 a
 b
 c
+NEW1
+NEW2
 d
 e
diff --git a/rem.txt b/rem.txt
index 07795f6..1450354 100644
--- a/rem.txt
+++ b/rem.txt
@@ -1,3 +1,3 @@
 k1
-removeme
+ADDED
 k2
`;

  it("keeps each file's line set separate", () => {
    const parsed = parseDiffLines(twoFiles);
    expect([...parsed.keys()].sort()).toEqual(["add.txt", "rem.txt"]);

    const add = linesOf(twoFiles, "add.txt");
    expect(add.has(4)).toBe(true); // NEW1
    expect(add.has(5)).toBe(true); // NEW2
    expect(add.has(7)).toBe(true); // context `e`
    // add.txt is not the diff's final file, so it never carried the phantom
    // line — its set is exactly 1–7.
    expect(exactly(twoFiles, "add.txt")).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const rem = linesOf(twoFiles, "rem.txt");
    // rem.txt only ever spans lines 1–3; add.txt's higher lines are not here,
    // and the trailing newline no longer appends a phantom line 4.
    expect(rem.has(7)).toBe(false);
    expect(exactly(twoFiles, "rem.txt")).toEqual([1, 2, 3]);
  });
});

describe("parseDiffLines — file with no trailing newline", () => {
  // Identical change, once with the `\ No newline at end of file` marker and
  // once without. The marker line starts with `\`, so it is skipped; proving the
  // two diffs yield the same line set shows the marker adds no spurious line.
  const withMarker = `diff --git a/f.txt b/f.txt
index 81d69cd..0bfc124 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 first
-old
+second
\\ No newline at end of file
`;
  const withoutMarker = `diff --git a/f.txt b/f.txt
index 81d69cd..0bfc124 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 first
-old
+second
`;

  it("does not count the \\ No newline at end of file marker", () => {
    const marked = linesOf(withMarker, "f.txt");
    expect(marked.has(2)).toBe(true); // the added `second`
    expect([...marked].sort((a, b) => a - b)).toEqual(
      [...linesOf(withoutMarker, "f.txt")].sort((a, b) => a - b),
    );
  });
});

describe("parseDiffLines — deleted file", () => {
  // A modified file followed by a deleted one whose name sorts later. The
  // deletion emits `+++ /dev/null`, so its path is never named on a `+++ b/`
  // line; the `diff --git` header above it is the only place it appears.
  const withDeletion = `diff --git a/keep.txt b/keep.txt
index 0f7bc76..de98044 100644
--- a/keep.txt
+++ b/keep.txt
@@ -1,2 +1,3 @@
 a
+b
 c
diff --git a/zzz.txt b/zzz.txt
deleted file mode 100644
index b77b4eb..0000000
--- a/zzz.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
`;

  /**
   * **A key, and an empty one** (#127). The file is one this pull request
   * changes, so a finding about it must be anchorable — an empty set is a
   * file-level thread, which is the only anchor GitHub has for a deleted file
   * either. Keyed off `+++ b/` alone it was no key at all, and
   * `placeFindings` reads a missing key as "nothing this pull request changed
   * causes it" and moves the finding to the follow-ups: "you deleted
   * `zzz.txt`, which `keep.txt` still reads" stopped blocking the merge.
   */
  it("keys the deleted file with no line to anchor at", () => {
    const parsed = parseDiffLines(withDeletion);

    expect(parsed.has("zzz.txt")).toBe(true);
    expect([...(parsed.get("zzz.txt") ?? [])]).toEqual([]);
  });

  // The invariant "no line is attributed to a file that does not own it" holds,
  // and since #127 it holds by construction rather than by luck: the deletion's
  // `diff --git` header clears `currentFile`, so its `@@ -1,2 +0,0 @@` resets a
  // counter nothing is reading. It held before that too — the deletion's body
  // is only removed lines, which never advance the counter, and the trailing
  // newline is stripped before splitting — but on those two facts rather than
  // on the parser having stopped pointing at keep.txt.
  it("attributes no phantom line to the file preceding a deletion", () => {
    const keep = linesOf(withDeletion, "keep.txt");
    expect(keep.has(0)).toBe(false); // no phantom sourced from the deletion
    expect(exactly(withDeletion, "keep.txt")).toEqual([1, 2, 3]);
  });
});

/**
 * **The three other ways a changed file names no new side** (#127).
 *
 * A deletion at least writes `+++ /dev/null`. A pure rename, a binary change
 * and a mode change write no `+++` line at all, so keying off `+++ b/` alone
 * left each of them out of the map entirely — and since #127 a path the map
 * does not hold is read as "nothing this pull request changed causes it", which
 * demotes a finding about a file the pull request plainly did change out of the
 * verdict's count and out of the record.
 *
 * Each is keyed, with an empty set, which `placeFindings` reads as a file-level
 * thread — the only anchor GitHub has for any of them either. The diff below is
 * real `git diff` output for all three in one change.
 */
describe("parseDiffLines — a changed file with no new side", () => {
  const noNewSide = `diff --git a/bin.dat b/bin.dat
index 742c16a..b0e7c0e 100644
Binary files a/bin.dat and b/bin.dat differ
diff --git a/mode.sh b/mode.sh
old mode 100644
new mode 100755
diff --git a/gone.txt b/new.txt
similarity index 100%
rename from gone.txt
rename to new.txt
`;

  it.each(["bin.dat", "mode.sh", "new.txt"])("keys %s with no line to anchor at", (file) => {
    const parsed = parseDiffLines(noNewSide);

    expect(parsed.has(file)).toBe(true);
    expect([...(parsed.get(file) ?? [])]).toEqual([]);
  });

  /** And a rename is keyed by where the file now is, which is where GitHub shows it. */
  it("keys a rename by its destination and not by its source", () => {
    expect(parseDiffLines(noNewSide).has("gone.txt")).toBe(false);
  });

  /**
   * A rename that also changed lines writes both — `rename to` and then
   * `+++ b/` — and the second must fill the set the first opened rather than
   * replace it with an empty one.
   */
  it("fills in the lines of a rename that also changed some", () => {
    const renameWithEdit = `diff --git a/old.txt b/new.txt
similarity index 60%
rename from old.txt
rename to new.txt
index 422c2b7..b2e9670 100644
--- a/old.txt
+++ b/new.txt
@@ -1,2 +1,3 @@
 a
+b
 c
`;

    expect(exactly(renameWithEdit, "new.txt")).toEqual([1, 2, 3]);
  });

  /**
   * **A path with a space in it, read rather than guessed at.** Git quotes
   * neither half of `diff --git a/<src> b/<dst>`, so `a/x y b/x y` could be
   * `x` renamed to `y b/x y`. It is only readable because the two halves are
   * known to be equal — which is every header but a rename's, and a rename
   * names its destination on a line of its own.
   */
  it("reads a symmetric header whose path contains a space", () => {
    const spaced = `diff --git a/src/my notes.md b/src/my notes.md
old mode 100644
new mode 100755
`;

    expect([...parseDiffLines(spaced).keys()]).toEqual(["src/my notes.md"]);
  });

  /**
   * A quoted header is read, not skipped. Git quotes a path the same way on
   * both halves, so two quoted strings that name `a/P` and `b/P` are as
   * unambiguous as the unquoted symmetric form — and skipping them left a
   * non-ASCII file's mode change with no key, which since #127 demotes every
   * finding about it.
   */
  it("reads a symmetric header whose halves are quoted", () => {
    const quoted = `diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
old mode 100644
new mode 100755
`;

    expect([...parseDiffLines(quoted).keys()]).toEqual(["src/café.ts"]);
  });

  /** And a header it cannot read is still left alone rather than keyed on a guess. */
  it("keys nothing from a header whose quoting is malformed", () => {
    const malformed = `diff --git "a/src/caf\\q.ts" "b/src/caf\\q.ts"
old mode 100644
new mode 100755
`;

    expect([...parseDiffLines(malformed).keys()]).toEqual([]);
  });
});

/**
 * **Paths as git writes them.** Every key must be the real path — it is what a
 * finding's `path` is matched against, and a miss demotes the finding (#127) —
 * and git decorates a path two ways on the lines this reads. Each diff below is
 * real `git diff` output.
 */
describe("parseDiffLines — quoted and spaced paths", () => {
  // Default `core.quotePath`: a non-ASCII path is quoted, octal-escaped by
  // byte, on every line that names it.
  const nonAscii = `diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"
index 422c2b7..55dce13 100644
--- "a/caf\\303\\251.ts"
+++ "b/caf\\303\\251.ts"
@@ -1,2 +1,2 @@
 a
-b
+B
`;

  it("keys a quoted new side by its decoded path, with its lines", () => {
    expect([...parseDiffLines(nonAscii).keys()]).toEqual(["café.ts"]);
    expect(exactly(nonAscii, "café.ts")).toEqual([1, 2]);
  });

  // A `"` is quoted under any `core.quotePath`, which is why the parser
  // unquotes even though the diff command turns the setting off.
  const doubleQuote = `diff --git "a/quo\\"te.ts" "b/quo\\"te.ts"
index bca70f3..d169a2f 100644
--- "a/quo\\"te.ts"
+++ "b/quo\\"te.ts"
@@ -1 +1 @@
-q
+q2
`;

  it("decodes an escaped quote in a path", () => {
    expect(exactly(doubleQuote, 'quo"te.ts')).toEqual([1]);
  });

  it("decodes a quoted rename destination", () => {
    const rename = `diff --git a/old.ts "b/new \\303\\251.ts"
similarity index 100%
rename from old.ts
rename to "new \\303\\251.ts"
`;

    expect([...parseDiffLines(rename).keys()]).toEqual(["new é.ts"]);
  });

  // With `core.quotePath=false`, which is how the review's diff is made: the
  // path arrives as itself and needs nothing undone.
  it("reads an unquoted non-ASCII path as it is", () => {
    const plain = `diff --git a/café.ts b/café.ts
index 422c2b7..55dce13 100644
--- a/café.ts
+++ b/café.ts
@@ -1,2 +1,2 @@
 a
-b
+B
`;

    expect(exactly(plain, "café.ts")).toEqual([1, 2]);
  });

  // Git ends a `---`/`+++` line with a tab when the path has a space in it.
  const spaced = `diff --git a/sp ace.ts b/sp ace.ts
index 587be6b..b77b4eb 100644
--- a/sp ace.ts\t
+++ b/sp ace.ts\t
@@ -1 +1,2 @@
 x
+y
`;

  it("keys a spaced path without the tab git appends, with its lines", () => {
    expect([...parseDiffLines(spaced).keys()]).toEqual(["sp ace.ts"]);
    expect(exactly(spaced, "sp ace.ts")).toEqual([1, 2]);
  });
});

/**
 * **Inside a hunk, every line is content.** An added line whose text starts
 * `++` arrives as `+++…`, which a parser matching on prefixes reads as a file
 * header. The hunk's `@@` counts say where it ends, so it is consumed by count.
 */
describe("parseDiffLines — content that looks like a header", () => {
  it("counts an added line that starts with ++, and numbers the rest from it", () => {
    const increment = `diff --git a/inc.c b/inc.c
index 7388135..82769a4 100644
--- a/inc.c
+++ b/inc.c
@@ -1,2 +1,3 @@
-i
+++i;
 j
+k
`;

    expect(exactly(increment, "inc.c")).toEqual([1, 2, 3]);
  });

  it("does not follow a +++ b/ line inside a hunk to a file that is not there", () => {
    const lookalike = `diff --git a/md.md b/md.md
new file mode 100644
index 0000000..b4ebec0
--- /dev/null
+++ b/md.md
@@ -0,0 +1,3 @@
+x
+++ b/ghost.ts
+y
`;

    expect([...parseDiffLines(lookalike).keys()]).toEqual(["md.md"]);
    expect(exactly(lookalike, "md.md")).toEqual([1, 2, 3]);
  });

  it("reads the next file's header once a hunk's counts are spent", () => {
    const twoFiles = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/b.ts b/b.ts
index 3333333..4444444 100644
--- a/b.ts
+++ b/b.ts
@@ -3,2 +3,3 @@
 c
+d
 e
`;

    expect(exactly(twoFiles, "a.ts")).toEqual([1]);
    expect(exactly(twoFiles, "b.ts")).toEqual([3, 4, 5]);
  });
});
