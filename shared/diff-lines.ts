/**
 * Map each file a unified diff touches to the set of *new-file* line numbers
 * that appear in its hunks (added or context lines). GitHub rejects a PR review
 * if an inline comment targets a line outside the diff, so this is the
 * allow-list the review output is filtered against before posting.
 *
 * **Every file the diff touches is a key, and one with no new side is an empty
 * one.** Two questions are read off this map and they are not the same
 * question: `placeFindings` asks *does this pull request change this file* and
 * only then *which of its lines may a thread anchor at*. Since #127 the first
 * answer decides whether a finding blocks the merge at all — a miss is read as
 * "nothing this pull request changed causes it", and the finding is moved to
 * the follow-ups rather than posted. So a file with no line to anchor at must
 * still be a key, or a finding about a file the pull request certainly changed
 * is demoted out of the count and out of the record for a reason that has
 * nothing to do with what it says.
 *
 * Four kinds of change name no new side. A **deletion** writes `+++ /dev/null`;
 * a **pure rename**, a **binary** change and a **mode** change write no `+++`
 * line at all. Keying off `+++ b/` alone reached none of them. They are keyed
 * off the `diff --git` header and the `rename to` line instead, with an empty
 * set — which `placeFindings` reads as a file-level thread, the only anchor
 * GitHub has for them either.
 *
 * **Every path is read the way git wrote it.** A path git had to escape is
 * quoted, and one with a space in it carries a trailing tab on its `+++` line;
 * a key read off either without undoing that is a key no finding's `path`
 * matches, which since #127 demotes the finding. Keys are always the real
 * path, which is also the spelling a review thread's `path` must carry.
 */
export const parseDiffLines = (diff: string): Map<string, Set<number>> => {
  const files = new Map<string, Set<number>>();
  let currentFile: string | undefined;
  let newLine = 0;
  // What is left of the current hunk, on each side, as its `@@` header counted
  // it. See "Inside a hunk" below.
  let oldLeft = 0;
  let newLeft = 0;

  const touch = (path: string): void => {
    if (!files.has(path)) files.set(path, new Set());
  };

  // `git diff` output ends in a newline, so a naive `split("\n")` yields a
  // trailing empty string. The blank-context branch below would count it,
  // appending one phantom line past the end of the last file the parser was
  // pointed at — an over-permissive allow-list that makes GitHub silently
  // reject the whole review. Strip exactly one trailing newline first. This
  // removes only that final phantom element: an empty *context* line (which
  // some tools emit as "" rather than " " after stripping trailing
  // whitespace) sits mid-diff, keeps its terminator, and is still counted.
  const body = diff.endsWith("\n") ? diff.slice(0, -1) : diff;

  for (const line of body.split("\n")) {
    // **Inside a hunk, every line is content, whatever it looks like.** An
    // added line whose text starts `++` arrives as `+++…` — `++i;` in C, a
    // Markdown horizontal rule of pluses — and read by its prefix alone it was
    // a file header: skipped, so every line after it in that file was
    // numbered one short, and `+++ b/<anything>` in a file's *content*
    // re-pointed the parser at a file that does not exist. The hunk header
    // says how many lines each side has, so the hunk is consumed by count and
    // header matching starts only once it is spent.
    if (currentFile !== undefined && (oldLeft > 0 || newLeft > 0)) {
      const kind = line.charAt(0);
      if (kind === "+") {
        files.get(currentFile)?.add(newLine);
        newLine++;
        newLeft--;
        continue;
      }
      if (kind === "-") {
        oldLeft--;
        continue;
      }
      if (kind === " " || line === "") {
        files.get(currentFile)?.add(newLine);
        newLine++;
        oldLeft--;
        newLeft--;
        continue;
      }
      // `\ No newline at end of file` belongs to the line before it and
      // counts toward neither side.
      if (kind === "\\") continue;
      // Anything else means the counts were wrong about where the hunk ends.
      // Stop trusting them and read the line as a header, which is what the
      // parser did before it counted at all.
      oldLeft = 0;
      newLeft = 0;
    }

    // A new file starts here, and nothing is counted against it until its new
    // side is named. Clearing `currentFile` is the half that matters even for a
    // file this branch cannot name: a deletion's `@@ -1,2 +0,0 @@` used to
    // reset the counter while the parser still pointed at the *previous* file.
    if (line.startsWith(DIFF_HEADER)) {
      currentFile = undefined;
      const path = symmetricHeaderPath(line.slice(DIFF_HEADER.length));
      if (path !== undefined) touch(path);
      continue;
    }

    // A rename's header names two different paths, which is the reading
    // `symmetricHeaderPath` declines to guess at; this line names the
    // destination on its own. A rename that also changed lines reaches the
    // new side below and fills the set in. A copy (`diff.renames=copies`) is
    // the same shape.
    const destination = line.startsWith(RENAME_TO)
      ? line.slice(RENAME_TO.length)
      : line.startsWith(COPY_TO)
        ? line.slice(COPY_TO.length)
        : undefined;
    if (destination !== undefined) {
      const path = unquotePath(destination);
      if (path !== undefined) touch(path);
      continue;
    }

    if (line.startsWith(NEW_SIDE_PREFIX)) {
      const side = line.slice(NEW_SIDE_PREFIX.length);
      // A deleted file's new side. Its path is a key already, written by the
      // header above; what this branch is for is that nothing below is counted
      // against whatever the parser was last pointed at.
      if (side === DEV_NULL) {
        currentFile = undefined;
        continue;
      }
      const path = newSidePath(side);
      currentFile = path;
      if (path !== undefined) touch(path);
      continue;
    }

    if (currentFile === undefined) continue;

    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk?.[2]) {
      newLine = Number(hunk[2]);
      // An omitted count is one line, not zero: `@@ -1 +1 @@`.
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }

  return files;
};

const DIFF_HEADER = "diff --git ";
const RENAME_TO = "rename to ";
const COPY_TO = "copy to ";
const NEW_SIDE_PREFIX = "+++ ";
const DEV_NULL = "/dev/null";

/**
 * The path a `+++` line names, from what follows `+++ `.
 *
 * Two decorations come off before the `b/`, and a path can carry both. A path
 * git had to escape arrives **quoted** — `"b/caf\303\251.ts"` for any
 * non-ASCII name under the default `core.quotePath`, and for a `"`, a `\` or a
 * control character under any setting. And a path with a **space** in it gets
 * a trailing tab, which git writes so that `patch` can find where the name
 * ends — *outside* the closing quote when there is one.
 *
 * So the tab comes off first. Unquoting first leaves `unquotePath` trailing
 * text, and it declines the whole string: `+++ "b/quo\"te x.ts"\t` keyed
 * nothing, and every line in the file lost its anchor. Stripping it first is
 * safe because a literal tab is never part of a path git prints — a tab in a
 * name is written `\t`, inside the quotes.
 */
const newSidePath = (side: string): string | undefined => {
  const named = side.replace(/\t$/, "");
  const path = unquotePath(named);
  return path?.startsWith("b/") ? path.slice(2) : undefined;
};

/**
 * The path a `diff --git a/<src> b/<dst>` line names, for the lines where that
 * can be read rather than guessed at — which is every one whose two halves are
 * the same path.
 *
 * Unquoted, `a/x y b/x y` is ambiguous in general: `x` renamed to `y b/x y`,
 * or `x y` unchanged. It stops being ambiguous once the halves are known to be
 * equal, because then the line is `a/P b/P` and the length of `P` is fixed by
 * the length of the line.
 *
 * Quoted, it is not ambiguous at all: git quotes a path the same way on both
 * halves, so a symmetric header is two quoted strings, each read to its
 * closing quote. A header with one half quoted and one not names two different
 * paths — a rename, which names its destination on a `rename to` line a
 * moment later — so nothing here has to guess.
 */
const symmetricHeaderPath = (rest: string): string | undefined => {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest);
    if (first === undefined || rest.charAt(first.end) !== " ") return undefined;
    const second = readQuoted(rest.slice(first.end + 1));
    if (second === undefined || first.end + 1 + second.end !== rest.length) return undefined;
    const path = first.value.slice(2);
    return first.value === `a/${path}` && second.value === `b/${path}` ? path : undefined;
  }

  // `a/P b/P` is `2 + p + 3 + p` characters, so a readable one is odd and at
  // least seven, and `p` follows from the length.
  if (rest.length < 7 || rest.length % 2 === 0) return undefined;
  const path = rest.slice(2, (rest.length - 1) / 2);
  return rest === `a/${path} b/${path}` ? path : undefined;
};

/**
 * A path as git printed it, with its quoting undone — or `undefined` where the
 * quoting is malformed, which keys nothing rather than a guess. An unquoted
 * path comes back as it is.
 *
 * Exported for `diffKeyOf`, which accepts a model's path in the same spelling
 * the diff showed it.
 */
export const unquotePath = (text: string): string | undefined => {
  if (!text.startsWith('"')) return text;
  const quoted = readQuoted(text);
  return quoted !== undefined && quoted.end === text.length ? quoted.value : undefined;
};

/** The one-character escapes git's `quote_c_style` writes, and what they stand for. */
const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * One C-style quoted string from the start of `text`: its decoded value, and
 * the index just past its closing quote.
 *
 * Decoded as **bytes**, then as UTF-8, because that is what an octal escape
 * is: `\303\251` is the two bytes of `é`, not two characters. Decoding each
 * escape to a character on its own would key `cafÃ©.ts`, which is a file that
 * does not exist.
 */
const readQuoted = (text: string): { value: string; end: number } | undefined => {
  const bytes: number[] = [];
  let i = 1;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '"') {
      return { value: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    }
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      i++;
      continue;
    }
    const next = text.charAt(i + 1);
    const octal = text.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 4;
      continue;
    }
    const escaped = C_ESCAPES[next];
    if (escaped === undefined) return undefined;
    bytes.push(escaped);
    i += 2;
  }
  return undefined;
};

/**
 * The paths a `git diff --name-status -z` names, one per changed file: the
 * destination of a rename or a copy, and the path of everything else —
 * including a deletion, which is a file the change touched.
 *
 * **This is what decides which files are in the diff**, not the patch text.
 * `-z` is git's format for programs: NUL-separated, and never quoted or
 * decorated, so there is nothing to undo and no spelling to get wrong. The
 * patch parser above had to learn each of git's decorations in turn — a
 * deletion, a rename, a quoted name, a spaced one — and each one it had not
 * learned yet was a file missing from the map. Since #127 a missing file
 * demotes every finding in it, so the list the demotion rests on is read from
 * the format that cannot be misread. The patch is still what numbers the lines.
 *
 * Every status git documents is read. One it adds later is skipped rather
 * than guessed at, and its path is lost with it — so a new status is a change
 * here, with a test.
 */
export const parseNameStatus = (raw: string): string[] => {
  const fields = raw.split("\0");
  const paths: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i] ?? "";
    // `R100` and `C075` carry a similarity score and name two paths, source
    // then destination; every other status names one.
    if (/^[RC]\d*$/.test(status)) {
      const destination = fields[i + 2];
      if (destination) paths.push(destination);
      i += 3;
    } else if (/^[ADMTUXB]$/.test(status)) {
      const path = fields[i + 1];
      if (path) paths.push(path);
      i += 2;
    } else {
      i += 1;
    }
  }
  return paths;
};

/**
 * The map `placeFindings` reads: **one key per changed file** from
 * `parseNameStatus`, each with the lines the patch gave it, or none.
 *
 * The file list decides the keys in both directions. A changed file the patch
 * parser could not name still gets a key, with no lines — a file-level thread
 * rather than a demotion. And a key the parser produced for a file git does not
 * list is dropped: nothing a thread could anchor at, and a thread on a file not
 * in the pull request is the whole review rejected.
 */
export const keyedByChangedFiles = (
  lines: ReadonlyMap<string, Set<number>>,
  changedFiles: readonly string[],
): Map<string, Set<number>> =>
  new Map(changedFiles.map((path) => [path, lines.get(path) ?? new Set<number>()]));
