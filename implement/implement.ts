import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  claudeAgent,
  fail,
  fetchTrustedComments,
  fetchTrustedIssue,
  required,
  scrubGitHubTokens,
  sh,
} from "../shared/common.js";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");

try {
  // Read the issue here and pass it in, rather than letting the agent shell out
  // to `gh`. SECURITY: title/body and comments are author-gated to repo
  // collaborators — never world-writable `--comments`. A maintainer can steer
  // the agent with a comment; a non-collaborator's text is dropped. Collaborator
  // comments are included even when the issue body is withheld, so a maintainer
  // can annotate a community-reported issue.
  const issue = fetchTrustedIssue(ISSUE_NUMBER);
  const comments = fetchTrustedComments(ISSUE_NUMBER);
  const parts = [
    issue.trusted
      ? `# ${issue.title || ISSUE_TITLE}\n\n${issue.body || "(no description)"}`
      : `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}\n\n(Issue body withheld: the issue author is not a repo collaborator.)`,
  ];
  if (comments) parts.push(`## Collaborator comments\n\n${comments}`);
  const issueContext = parts.join("\n\n");

  // Context fetched; the agent has no legitimate use for the GitHub token.
  scrubGitHubTokens();

  const result = await sandcastle.run({
    name: `implement-#${ISSUE_NUMBER}`,
    agent: claudeAgent(),
    // The ephemeral Actions runner IS the isolation. Running the agent directly
    // on it means the agent's environment and CI's environment are identical by
    // construction — no image drift, no "works in the sandbox, fails in CI".
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      ISSUE_NUMBER,
      ISSUE_TITLE,
      BRANCH,
      ISSUE_CONTEXT: issueContext,
    },
    maxIterations: 1,
  });

  const commitsAhead = Number(sh("git rev-list --count main..HEAD").trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("Agent finished but no commits were made on the branch.");
  }

  console.log(`Implementation produced ${commitsAhead} commit(s) on ${BRANCH}.`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
