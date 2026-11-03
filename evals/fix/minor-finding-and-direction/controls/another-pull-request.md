---
source: >-
  Another pull request's fix round, which answered a maintainer's comment and two threads and was handed no minor finding: PR #698's third round (2026-11-03T02:46Z), 5528a12's change against e0bd934, its commit message, its replies on its two threads (https://github.com/jeffwlawson/agent-workflows/pull/698#discussion_r4450406434 and #discussion_r4450406539), and its outcome on the conversation comment (https://github.com/jeffwlawson/agent-workflows/pull/698#issuecomment-6594136451), laid out as the replay note asks.
expect:
  "01": fail
  "02": fail
  "03": fail
  "04": fail
---

1. The change, as `git diff` prints it against the head:

```diff
diff --git a/review/review-diff.ts b/review/review-diff.ts
index 3e9b03e..af3c14a 100644
--- a/review/review-diff.ts
+++ b/review/review-diff.ts
@@ -18,8 +18,15 @@ import type { ReviewHistory } from "./review-round.js";
  * placed on that line.
  */
 export type PromptDiff =
-  /** The whole pull request's diff: a first review, a final review, a slice round, or a round that pushed nothing. */
-  | { readonly kind: "whole"; readonly diff: string }
+  /**
+   * The whole pull request's diff: a first review, a final review, a slice
+   * round, or a round that pushed nothing. `scopedSize` is present where this
+   * was a verification pass whose scoped form would have been no smaller than
+   * the whole diff (its size, as `scopedSize` measures it): a prompt that is
+   * no smaller gains nothing and costs the reviewer the whole context, and
+   * nothing is left out, so `howChecked` owes no note.
+   */
+  | { readonly kind: "whole"; readonly diff: string; readonly scopedSize?: number }
   /**
    * The whole diff, because this pass follows a fix round but the commits
    * since the last review could not be read. `reason` is a clause, for the
@@ -48,6 +55,10 @@ export type PromptDiff =
       readonly diff: string;
     };
 
+/** The size of the scoped form's text the prompt carries: the stat, the commits since, and the touched files' diff. */
+export const scopedSize = (d: { readonly stat: string; readonly since: string; readonly diff: string }): number =>
+  d.stat.length + d.since.length + d.diff.length;
+
 const firstLine = (error: unknown): string =>
   (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() ?? "";
 
@@ -96,14 +107,18 @@ export const readPromptDiff = (
       .sort();
     const stat = read([...diffCommandAgainstBase(baseRef), "--stat=1000"]);
     const diff = files.length === 0 ? "" : read(["--literal-pathspecs", ...diffCommandAgainstBase(baseRef), "--", ...files]);
+    const scoped = { stat: stat.trimEnd(), since: since.trimEnd(), diff };
+    // Where the round touched most of the pull request, the commits since and
+    // the whole diff of the same files overlap, and the scoped form can be
+    // larger than the whole (#698): carry the whole, which leaves nothing out.
+    const size = scopedSize(scoped);
+    if (size >= whole.length) return { kind: "whole", diff: whole, scopedSize: size };
     return {
       kind: "since",
       reviewedHead: head,
       ...(old.mergedBase === undefined ? {} : { mergedBase: old.mergedBase }),
-      stat: stat.trimEnd(),
-      since: since.trimEnd(),
+      ...scoped,
       files,
-      diff,
     };
   } catch (error) {
     return {
diff --git a/review/review.ts b/review/review.ts
index 108e8ef..c200e03 100644
--- a/review/review.ts
+++ b/review/review.ts
@@ -44,7 +44,7 @@ import {
   type SliceRedTests,
 } from "../shared/red-check.js";
 import { fetchPullRequestContext } from "./review-context.js";
-import { readPromptDiff, renderDiffScope } from "./review-diff.js";
+import { readPromptDiff, renderDiffScope, scopedSize } from "./review-diff.js";
 import { checkSinceBrief, renderSinceBriefForReview } from "./since-brief.js";
 import {
   findingsHandOver,
@@ -274,10 +274,12 @@ try {
   const promptDiff = readPromptDiff(history, round, BASE_REF, context.diff, context.diffLines.keys());
   console.log(
     promptDiff.kind === "since"
-      ? `Prompt diff: scoped to the commits since ${promptDiff.reviewedHead.slice(0, 7)}, ${promptDiff.stat.length + promptDiff.since.length + promptDiff.diff.length} bytes of the pull request's ${context.diff.length}.`
+      ? `Prompt diff: scoped to the commits since ${promptDiff.reviewedHead.slice(0, 7)}, ${scopedSize(promptDiff)} bytes of the pull request's ${context.diff.length}.`
       : promptDiff.kind === "unreadable"
         ? `Prompt diff: the whole pull request's, ${context.diff.length} bytes, because ${promptDiff.reason}.`
-        : `Prompt diff: the whole pull request's, ${context.diff.length} bytes.`,
+        : promptDiff.scopedSize !== undefined
+          ? `Prompt diff: the whole pull request's, ${context.diff.length} bytes, because the scoped form would be ${promptDiff.scopedSize} bytes.`
+          : `Prompt diff: the whole pull request's, ${context.diff.length} bytes.`,
   );
 
   // A review proceeds on what survived a partial answer — but says so twice:
diff --git a/tests/review/review-diff.test.ts b/tests/review/review-diff.test.ts
index 4be4e5f..46ebe49 100644
--- a/tests/review/review-diff.test.ts
+++ b/tests/review/review-diff.test.ts
@@ -4,7 +4,7 @@ import * as os from "node:os";
 import * as path from "node:path";
 import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
 import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
-import { readPromptDiff, renderDiffScope, type PromptDiff } from "../../review/review-diff.js";
+import { readPromptDiff, renderDiffScope, scopedSize, type PromptDiff } from "../../review/review-diff.js";
 import type { ReviewHistory } from "../../review/review-round.js";
 import { keyedByChangedFiles, parseDiffLines, parseNameStatus } from "../../shared/diff-lines.js";
 import { changedFilesCommandAgainstBase, diffCommandAgainstBase } from "../../shared/pr-feedback.js";
@@ -143,6 +143,36 @@ describe("readPromptDiff on a verification pass", () => {
     ceiling,
   );
 
+  it(
+    "carries the whole diff, and says how large the scoped form would be, where the round touched most of the pull request",
+    () => {
+      write("src/a.ts", lines("a, changed", 40));
+      write("src/b.ts", lines("b, changed", 120));
+      write("docs/c.md", lines("c, changed", 80));
+      const reviewed = commitAll("feat: the change");
+      write("src/a.ts", lines("a, changed", 40).replace("a, changed line 7", "a, fixed line 7"));
+      write("src/b.ts", lines("b, changed", 120).replace("b, changed line 7", "b, fixed line 7"));
+      write("docs/c.md", lines("c, changed", 80).replace("c, changed line 7", "c, fixed line 7"));
+      commitAll("fix: the findings on a, b and c");
+      const { whole, changed } = pullRequest();
+
+      const d = readPromptDiff(afterFixRound(reviewed), undefined, "main", whole, changed);
+
+      expect(d.kind).toBe("whole");
+      if (d.kind !== "whole") return;
+      expect(d.diff).toBe(whole);
+      // The scoped form, read as readPromptDiff reads it, is no smaller.
+      const stat = g(...diffCommandAgainstBase("main"), "--stat=1000").trimEnd();
+      const since = g("-c", "core.quotePath=false", "diff", reviewed, "HEAD").trimEnd();
+      const touched = g("--literal-pathspecs", ...diffCommandAgainstBase("main"), "--", ...[...changed].sort());
+      expect(d.scopedSize).toBe(scopedSize({ stat, since, diff: touched }));
+      expect(d.scopedSize).toBeGreaterThanOrEqual(whole.length);
+      // Nothing was left out, so the brief asks howChecked for nothing.
+      expect(renderDiffScope(d, "main")).toBe("The whole pull request's diff against `main`, `git diff main...HEAD`:");
+    },
+    ceiling,
+  );
+
   it(
     "places a finding on a line the prompt left out but the pull request changed",
     () => {
@@ -263,6 +293,8 @@ describe("readPromptDiff after a merge of the base branch", () => {
     "leaves out the base branch's change to a file the pull request also changes",
     () => {
       write("src/b.ts", lines("b", 120).replace("b line 100", "b, changed line 100"));
+      // A second file the round leaves alone, so the scoped form is the smaller.
+      write("docs/c.md", lines("c, changed", 80));
       const reviewed = commitAll("feat: the change");
       onMain(() => write("src/b.ts", lines("b", 120).replace("b line 5", "b, on main line 5")));
       mergeMain();
@@ -359,6 +391,10 @@ describe("the review runner and its prompt", () => {
     expect(PROMPT).toContain("# PR DIFF\n\n{{DIFF_SCOPE}}\n\n```diff\n{{PR_DIFF}}\n```");
   });
 
+  it("logs both sizes where the scoped form was no smaller than the whole", () => {
+    expect(RUNNER).toContain("because the scoped form would be ${promptDiff.scopedSize} bytes");
+  });
+
   it("places findings off the whole pull request's diff, not the prompt's", () => {
     expect(RUNNER).toContain("placeFindings(reviewed.findings, context.diffLines)");
   });
```

2. The commit message I would have written:

```text
fix(review): a verification pass carries the whole diff where the scoped form is no smaller (#641)

Follows @jeffwlawson's direction in the conversation (IC_kwDOTzVKqM8AAAABiQnOCw):
on #658 the scoped prompt (stat + since + the touched files' whole diff) was
135% of the whole diff, because the since-diff and the touched files' diff
overlap. readPromptDiff now measures the scoped form (scopedSize) and returns
{ kind: "whole", scopedSize } where it is not smaller than the whole diff.
No howChecked note: nothing is left out. The "Prompt diff:" log line in
review/review.ts gives both sizes in that case.

Tests: a fixture whose fix round touches every file the pull request
changes returns the whole diff, with scopedSize recomputed from git's own
reads; the one-file fixtures are still scoped. The base-merge fixture that
changed only src/b.ts gained a second changed file, since a scoped form over
the pull request's only file is now, correctly, the whole diff.

Declined, by the maintainer's direction in the same comment: the golden-PR
eval criterion (threads PRRT_kwDOTzVKqM6y9E5L, PRRT_kwDOTzVKqM6y9M6l). The
eval cases replay first reviews, so a before and after run would measure the
unchanged whole-diff path; the maintainer decides on merging without it, and
the cases that would reach this path are tracked in a follow-up issue.
```

3. Each thread's outcome:

- `PRRT_kwDOTzVKqM6y9E5L` (`evals/review/suite.yaml:25`): **declined**. The reply I would post:

  > Not met in this pull request, on the maintainer's direction in the conversation. The eval cases replay old first reviews, so none of them takes a verification pass. A before and after run would only measure the whole-diff path, which has not changed. The maintainer will decide whether to merge without it. The cases that would reach this path are tracked in a follow-up issue. There is no commit for this criterion.

- `PRRT_kwDOTzVKqM6y9M6l` (`evals/review/suite.yaml:25`): **declined**. The reply I would post:

  > Same as the earlier thread on this criterion. The maintainer asked that this pull request not try to meet it: the eval cases replay first reviews, so none of them reaches the scoped path. The merge decision is theirs, and a follow-up issue tracks the cases that would reach it. There is no commit for this criterion.

4. Each conversation comment's outcome:

- `IC_kwDOTzVKqM8AAAABiQnOCw` (@jeffwlawson): **addressed**. The reason:

  > Done in c644596. readPromptDiff now returns the whole diff, with scopedSize set, when stat + since + the touched files' diff is at least as large as the whole diff, and it adds no howChecked note. The Prompt diff log line gives both sizes. New test: a fix round that touches every changed file gets the whole diff, while the one-file fixtures stay scoped. One base-merge fixture got a second changed file, so its scoped form is still the smaller one. I left the eval criterion alone, as you asked.
