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
 */
export const parseDiffLines = (diff: string): Map<string, Set<number>> => {
  const files = new Map<string, Set<number>>();
  let currentFile: string | undefined;
  let newLine = 0;

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
    // A new file starts here, and nothing is counted against it until its new
    // side is named. Clearing `currentFile` is the half that matters even for a
    // file this branch cannot name: a deletion's `@@ -1,2 +0,0 @@` used to
    // reset the counter while the parser still pointed at the *previous* file.
    if (line.startsWith(DIFF_HEADER)) {
      currentFile = undefined;
      const path = symmetricHeaderPath(line);
      if (path !== undefined) touch(path);
      continue;
    }

    // A rename's header names two different paths, which is the reading
    // `symmetricHeaderPath` declines to guess at; this line names the
    // destination on its own. A rename that also changed lines reaches
    // `+++ b/` below and fills the set in.
    if (line.startsWith(RENAME_TO)) {
      touch(line.slice(RENAME_TO.length));
      continue;
    }

    if (line.startsWith(NEW_SIDE)) {
      currentFile = line.slice(NEW_SIDE.length);
      touch(currentFile);
      continue;
    }

    // A deleted file's new side. Its path is a key already, written by the
    // header above; what this branch is for is that nothing below is counted
    // against whatever the parser was last pointed at.
    if (line === DELETED_SIDE) {
      currentFile = undefined;
      continue;
    }

    if (!currentFile) continue;

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      files.get(currentFile)?.add(newLine);
      newLine++;
      continue;
    }

    if (line.startsWith(" ") || line === "") {
      files.get(currentFile)?.add(newLine);
      newLine++;
    }
  }

  return files;
};

const DIFF_HEADER = "diff --git ";
const RENAME_TO = "rename to ";
const NEW_SIDE = "+++ b/";
const DELETED_SIDE = "+++ /dev/null";

/**
 * The path a `diff --git a/<src> b/<dst>` line names, for the lines where that
 * can be read rather than guessed at — which is every one whose two halves are
 * the same path.
 *
 * Git quotes neither half unless the path needs escaping, so `a/x y b/x y` is
 * ambiguous in general: `x` renamed to `y b/x y`, or `x y` unchanged. It stops
 * being ambiguous once the halves are known to be equal, because then the line
 * is `a/P b/P` and the length of `P` is fixed by the length of the line. A line
 * whose halves differ is a rename, and a rename names its destination on a
 * `rename to` line a moment later — so nothing here has to guess.
 */
const symmetricHeaderPath = (line: string): string | undefined => {
  const rest = line.slice(DIFF_HEADER.length);
  // `a/P b/P` is `2 + p + 3 + p` characters, so a readable one is odd and at
  // least seven, and `p` follows from the length.
  if (rest.length < 7 || rest.length % 2 === 0) return undefined;
  const path = rest.slice(2, (rest.length - 1) / 2);
  return rest === `a/${path} b/${path}` ? path : undefined;
};
