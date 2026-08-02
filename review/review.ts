import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  claudeAgent,
  fail,
  required,
  scrubGitHubTokens,
  sh,
  writeJson,
  writeText,
} from "../shared/common.js";
import { fetchPullRequestContext } from "../shared/review-context.js";
import { filterInlineComments, reviewOutputSchema } from "../shared/review-output.js";
import { runWithExtraction } from "../shared/run-with-extraction.js";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");

/**
 * Results of the PR's other checks, gathered by the workflow after waiting for
 * them to finish. This is the only evidence in the prompt that comes from
 * *outside* the repo's own assumptions — the diff, the issue and the tests all
 * encode what the team already believes, whereas the corpus job compares the
 * rules against manifests Microsoft actually accepted. Absent (or timed out) it
 * degrades to a note; it never blocks the review.
 */
const readCiStatus = (): string => {
  const file = process.env["CI_STATUS_FILE"];
  if (!file) return "(CI results were not collected for this run.)";
  try {
    return fs.readFileSync(file, "utf8").trim() || "(no other checks reported.)";
  } catch {
    return "(CI results were not available.)";
  }
};

try {
  const context = fetchPullRequestContext(PR_NUMBER);

  // All `gh`-based context fetching is done; the review agent must not hold the
  // GitHub token (it has no legitimate use for it, and posting happens in a
  // separate workflow step). Remove it before the unsandboxed agent starts.
  scrubGitHubTokens();

  const result = await runWithExtraction({
    name: `review-pr-${PR_NUMBER}`,
    agent: claudeAgent("review"),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      PR_NUMBER,
      BRANCH,
      PR_TITLE: context.prTitle,
      ISSUE_NUMBER: context.issueNumber || "(none)",
      ISSUE_TITLE: context.issueTitle || "(no linked issue)",
      LINKED_ISSUE: context.linkedIssue,
      DISCUSSION: context.discussion || "(no collaborator comments)",
      CI_STATUS: readCiStatus(),
      PR_DIFF: context.diff,
    },
    output: sandcastle.Output.object({ tag: "output", schema: reviewOutputSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, "extraction.md"), "utf8"),
  });

  // Drop any inline comment that does not land on a changed line — GitHub
  // rejects the whole review otherwise.
  const validComments = filterInlineComments(result.output.inlineComments, context.diffLines);
  const headSha = sh("git rev-parse HEAD").trim();

  writeJson("review_payload.json", {
    commit_id: headSha,
    event: "COMMENT",
    body: result.output.summary,
    comments: validComments.map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT",
      // start_line/start_side turn the anchor into a range, which is what makes
      // a multi-line ```suggestion replace all of it rather than just the last
      // line. Omitted entirely for single-line comments — GitHub rejects
      // start_line == line.
      ...(c.startLine === undefined ? {} : { start_line: c.startLine, start_side: "RIGHT" }),
      body: c.body,
    })),
  });
  writeText("summary.md", result.output.summary);

  console.log("Review complete.");
  console.log(`Inline comments: ${validComments.length} kept of ${result.output.inlineComments.length} produced.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
