import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { claudeAgent, fail, required, scrubGitHubTokens, sh } from "../shared/common.js";
import { fetchPullRequestFeedback } from "../shared/pr-feedback.js";

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

  await sandcastle.run({
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
    maxIterations: 1,
  });

  const after = sh("git rev-parse HEAD").trim();
  if (before === after) {
    // Not a failure: the agent may have judged every comment already-addressed
    // or not worth acting on. Say so plainly and let the workflow skip the push.
    console.log("Agent made no commits — nothing to push.");
  } else {
    console.log(`Agent committed changes on ${BRANCH} (${before.slice(0, 7)} -> ${after.slice(0, 7)}).`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
