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

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");
/**
 * The branch `BRANCH` was cut from, this run, in the step before this one. Two
 * uses: the prompt says what the agent's branch is based on, and the commit
 * count below measures against it.
 *
 * `required`, and an input rather than the literal `main` it was until #98 —
 * this was the only unconditional `main` in a runner rather than in YAML, and
 * the only one that *hard-errored*: a repo whose default branch is `master` got
 * all the way through the agent run and then aborted on a ref that does not
 * exist (docs/ADOPTING.md §5).
 */
const BASE_REF = required("BASE_REF");

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
    agent: claudeAgent("implement"),
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
      BASE_REF,
      ISSUE_CONTEXT: issueContext,
    },
    maxIterations: 1,
  });

  // argv, not a command string: a ref may legally contain `` ` ``, `$()`, `;`,
  // `|` and `&`, and `git()` runs `execFileSync` so this one arrives unparsed
  // (#75). It used to be an `sh()` call with the base branch written into it as
  // a literal, where the question could not arise.
  const commitsAhead = Number(git(["rev-list", "--count", `${BASE_REF}..HEAD`]).trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("Agent finished but no commits were made on the branch.");
  }

  console.log(`Implementation produced ${commitsAhead} commit(s) on ${BRANCH}.`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
