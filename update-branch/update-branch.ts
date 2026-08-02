import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  asRecord,
  asString,
  claudeAgent,
  fail,
  outputDir,
  required,
  safeSh,
  scrubGitHubTokens,
  sh,
  standardSchema,
  writeText,
} from "../shared/common.js";
import { runWithExtraction } from "../shared/run-with-extraction.js";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");

/**
 * Only the *comment* is structured. The resolution itself is the working tree,
 * which the workflow pushes — there is nothing useful to extract about it that
 * the diff does not already say.
 */
const commentSchema = standardSchema<{ comment: string }>((value) => ({
  comment: asString(asRecord(value, "update output")["comment"], "comment"),
}));

try {
  // The workflow has already run `git merge origin/main` and left the tree
  // conflicted; this script exists only for that case.
  const conflicted = sh("git diff --name-only --diff-filter=U").trim();
  if (!conflicted) {
    fail("Nothing is conflicted — update-branch.ts should not have been invoked.");
  }

  // Read the PR before the token goes away; the agent has no `gh` afterwards.
  const prContext =
    safeSh(`gh pr view ${PR_NUMBER} --json title,body --jq '"# " + .title + "\n\n" + (.body // "")'`) ||
    `PR #${PR_NUMBER}`;

  scrubGitHubTokens();

  const result = await runWithExtraction({
    name: `update-branch-pr-${PR_NUMBER}`,
    agent: claudeAgent("update-branch"),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      PR_NUMBER,
      BRANCH,
      PR_CONTEXT: prContext,
      CONFLICTED_FILES: conflicted,
      MERGE_STATUS: sh("git status --short").trim(),
    },
    output: sandcastle.Output.object({ tag: "output", schema: commentSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, "extraction.md"), "utf8"),
    maxIterations: 1,
  });

  // A half-finished merge must never reach `git push` — it would put conflict
  // markers on the branch. Fail loudly instead; the workflow leaves the remote
  // untouched and labels the PR blocked.
  const stillConflicted = sh("git diff --name-only --diff-filter=U").trim();
  if (stillConflicted) {
    fail(`Merge left unresolved conflicts in: ${stillConflicted.split("\n").join(", ")}`);
  }
  if (fs.existsSync(path.join(sh("git rev-parse --git-dir").trim(), "MERGE_HEAD"))) {
    fail("Merge was not committed — the branch is mid-merge.");
  }

  writeText("update_comment.md", result.output.comment);
  console.log(`Resolved conflicts and committed the merge on ${BRANCH}.`);
  console.log(`Comment written to ${outputDir()}/update_comment.md`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
