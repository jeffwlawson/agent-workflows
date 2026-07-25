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
} from "../shared/common.js";
import { filterOutcomes, fixOutputSchema } from "../shared/fix-output.js";
import { fetchPullRequestFeedback } from "../shared/pr-feedback.js";
import { runWithExtraction } from "../shared/run-with-extraction.js";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");

try {
  const feedback = fetchPullRequestFeedback(PR_NUMBER);

  // The workflow pre-flights this too, but re-check here: between the pre-flight
  // and now, the only *trusted* feedback could have been from an author the gate
  // rejects. Refusing beats letting the agent invent work to do.
  if (!feedback.hasFeedback) {
    fail(
      "No unresolved feedback from a repo collaborator (or our review agent) to act on. " +
        "Resolved threads and comments from non-collaborators are deliberately ignored.",
    );
  }

  // Context is gathered; the agent must not hold the GitHub token. This matters
  // more here than anywhere else — this workflow can push.
  scrubGitHubTokens();

  const before = sh("git rev-parse HEAD").trim();

  const result = await runWithExtraction({
    name: `implement-pr-${PR_NUMBER}`,
    agent: claudeAgent(),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      PR_NUMBER,
      BRANCH,
      REVIEW_SUMMARIES: feedback.summaries || "(none)",
      INLINE_COMMENTS: feedback.inline || "(none)",
      CONVERSATION: feedback.conversation || "(none)",
      DIFF_TO_MAIN: feedback.diff,
    },
    output: sandcastle.Output.object({ tag: "output", schema: fixOutputSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, "extraction.md"), "utf8"),
  });

  const outcomes = filterOutcomes(result.output.threadOutcomes, feedback.threadIds);
  writeJson("thread_outcomes.json", outcomes);

  const after = sh("git rev-parse HEAD").trim();
  if (before === after) {
    // Not a failure: the agent may have judged every comment already handled or
    // not worth acting on. It still owes replies, which the workflow posts.
    console.log("Agent made no commits — nothing to push.");
  } else {
    console.log(`Agent committed changes on ${BRANCH} (${before.slice(0, 7)} -> ${after.slice(0, 7)}).`);
  }
  console.log(
    `Thread outcomes: ${outcomes.filter((o) => o.status === "addressed").length} addressed, ` +
      `${outcomes.filter((o) => o.status === "declined").length} declined ` +
      `(${result.output.threadOutcomes.length} produced, ${outcomes.length} kept).`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
