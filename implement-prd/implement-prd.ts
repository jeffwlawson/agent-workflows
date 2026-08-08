import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  claudeAgent,
  fail,
  fetchTrustedComments,
  fetchTrustedIssue,
  git,
  required,
  scrubGitHubTokens,
} from "../shared/common.js";

/** The parent PRD. Context only — the work is the sub-issue below. */
const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");

/** The one sub-issue this run implements, chosen by the workflow's preflight. */
const SUB_NUMBER = required("SUB_NUMBER");
const SUB_TITLE = required("SUB_TITLE");

const BRANCH = required("BRANCH");

/**
 * Read an issue and its collaborator comments into one prompt section.
 *
 * SECURITY: title/body and comments are author-gated to repo collaborators —
 * never world-writable. A maintainer can steer the agent with a comment; a
 * non-collaborator's text is dropped. Collaborator comments are included even
 * when the body is withheld, so a maintainer can annotate a community-reported
 * issue.
 */
const issueSection = (number: string, fallbackTitle: string): string => {
  const issue = fetchTrustedIssue(number);
  const comments = fetchTrustedComments(number);
  const parts = [
    issue.trusted
      ? `# ${issue.title || fallbackTitle}\n\n${issue.body || "(no description)"}`
      : `Issue #${number}: ${fallbackTitle}\n\n(Issue body withheld: the issue author is not a repo collaborator.)`,
  ];
  if (comments) parts.push(`## Collaborator comments\n\n${comments}`);
  return parts.join("\n\n");
};

try {
  // Both issues, through the same gate. The PRD is what makes the slice make
  // sense — it holds the ordering, the shared vocabulary and the reason the
  // seams are where they are — and it is exactly the context an agent working
  // one sub-issue in isolation would otherwise be missing.
  const prdContext = issueSection(ISSUE_NUMBER, ISSUE_TITLE);
  const subContext = issueSection(SUB_NUMBER, SUB_TITLE);

  // Context fetched; the agent has no legitimate use for the GitHub token.
  // Closing the sub-issue, pushing and re-labelling all happen in workflow
  // steps, after this process has exited.
  scrubGitHubTokens();

  // The branch tip *before* the agent runs. Counting against `main` — which is
  // what the single-issue runner does — would count every earlier slice too, so
  // from slice 2 on a run where the agent committed nothing at all would still
  // look productive, and the workflow would go on to close a sub-issue nobody
  // implemented.
  const before = git(["rev-parse", "HEAD"]).trim();

  const result = await sandcastle.run({
    name: `implement-prd-#${ISSUE_NUMBER}-sub-#${SUB_NUMBER}`,
    agent: claudeAgent("implement-prd"),
    // The ephemeral Actions runner IS the isolation — same reasoning as the
    // other runners; see implement.ts.
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      ISSUE_NUMBER,
      ISSUE_TITLE,
      SUB_NUMBER,
      SUB_TITLE,
      BRANCH,
      PRD_CONTEXT: prdContext,
      SUB_CONTEXT: subContext,
    },
    maxIterations: 1,
  });

  const commitsAhead = Number(git(["rev-list", "--count", `${before}..HEAD`]).trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail(`Agent finished but made no commits for sub-issue #${SUB_NUMBER}.`);
  }

  console.log(`Sub-issue #${SUB_NUMBER} produced ${commitsAhead} commit(s) on ${BRANCH}.`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
