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

  for (const line of diff.split("\n")) {
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
