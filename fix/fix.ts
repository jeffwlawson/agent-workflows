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
import { filterOutcomes, filterTopLevelComments, fixOutputSchema } from "../shared/fix-output.js";
import {
  describeUnreadable,
  fetchPullRequestFeedback,
  refusalReason,
  surfaceText,
} from "../shared/pr-feedback.js";
import { runWithExtraction } from "../shared/run-with-extraction.js";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");

try {
  const feedback = fetchPullRequestFeedback(PR_NUMBER);

  // Said in the log whether or not it is a reason to stop, because a run that
  // proceeded on a partial answer is one someone will later ask about.
  if (feedback.unreadable.length > 0) {
    console.log(
      `Feedback selections that could not be read: ${describeUnreadable(feedback.unreadable)}`,
    );
  }

  // This is the run that pushes, so it refuses where a review degrades. The
  // four-way decision lives with the fetch — an empty result, a refused
  // selection, a refused selection the author gate reads, and no answer at all
  // are different reasons, and a human can only act on one of them if it is
  // named (#76). `fail()` puts whichever it is on the PR.
  const refusal = refusalReason(feedback);
  if (refusal) fail(refusal);

  // Context is gathered; the agent must not hold the GitHub token. This matters
  // more here than anywhere else — this workflow can push.
  scrubGitHubTokens();

  const before = sh("git rev-parse HEAD").trim();

  const result = await runWithExtraction({
    name: `fix-${PR_NUMBER}`,
    agent: claudeAgent("fix"),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      PR_NUMBER,
      BRANCH,
      // Each surface as the agent should see it: its text, or a named refusal
      // where the API would not answer — never "(none)" for both, which is the
      // same collapse one level down from the fetch.
      REVIEW_SUMMARIES: surfaceText(feedback, "summaries"),
      INLINE_COMMENTS: surfaceText(feedback, "inline"),
      CONVERSATION: surfaceText(feedback, "conversation"),
      PR_DIFF: feedback.diff,
    },
    output: sandcastle.Output.object({ tag: "output", schema: fixOutputSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, "extraction.md"), "utf8"),
  });

  const outcomes = filterOutcomes(result.output.threadOutcomes, feedback.threadIds);
  writeJson("thread_outcomes.json", outcomes);

  // Findings that belong to no thread, capped and deduped against what earlier
  // runs already posted. Written unconditionally — an empty file is the normal
  // case, and the workflow posts nothing for it.
  const topLevelComments = filterTopLevelComments(
    result.output.topLevelComments,
    feedback.priorTopLevelComments,
  );
  writeJson("top_level_comments.json", topLevelComments);

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
  const produced = result.output.topLevelComments.length;
  console.log(
    topLevelComments.length > 0
      ? `Top-level comments: ${topLevelComments.length} to post (${produced} produced).`
      : produced === 0
        ? "Top-level comments: none — nothing outside the threads."
        : `Top-level comments: none posted (${produced} produced, all dropped — see warnings above).`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
