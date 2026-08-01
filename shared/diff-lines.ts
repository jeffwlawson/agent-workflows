/**
 * Map each file in a unified diff to the set of *new-file* line numbers that
 * appear in its hunks (added or context lines). GitHub rejects a PR review if
 * an inline comment targets a line outside the diff, so this is the allow-list
 * the review output is filtered against before posting.
 */
export const parseDiffLines = (diff: string): Map<string, Set<number>> => {
  const files = new Map<string, Set<number>>();
  let currentFile: string | undefined;
  let newLine = 0;

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
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      if (!files.has(currentFile)) files.set(currentFile, new Set());
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
