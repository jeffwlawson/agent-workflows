import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import {
  fail,
  fetchTrustedComments,
  fetchTrustedIssue,
  git,
  readInputs,
  readLoopAccounts,
  scrubGitHubTokens,
  writers,
} from "../shared/common.js";
import { agentSandbox, claudeAgent } from "../shared/agent.js";
import { RUNNERS } from "../shared/contract.js";
import { staleFailure, staleReason } from "../shared/stale.js";
import { rescueRef, resumeFromRescue, resumeSection } from "../shared/rescue.js";

const INPUTS = readInputs(RUNNERS["implement-prd"].inputs);
const LOOP_ACCOUNTS = readLoopAccounts(INPUTS.AGENT_LOOP_LOGINS);
const { writeJson } = writers(RUNNERS["implement-prd"].outputs);

/** The parent PRD. Context only — the work is the sub-issue below. */
const ISSUE_NUMBER = INPUTS.ISSUE_NUMBER;
const ISSUE_TITLE = INPUTS.ISSUE_TITLE;

/** The one sub-issue this run implements, chosen by the workflow's preflight. */
const SUB_NUMBER = INPUTS.SUB_NUMBER;
const SUB_TITLE = INPUTS.SUB_TITLE;

/**
 * The PRD branch this run builds on, at its tip: every earlier slice of the
 * PRD is on it, which is what the agent builds on. The workflow pushes it
 * once this exits.
 */
const BRANCH = INPUTS.BRANCH;

/**
 * The branch the chain is based on. Only the prompt uses it — it is what the
 * agent diffs to see the slices already on this branch — and it is the
 * workflow's `default-branch` input rather than a literal, so the instruction
 * names a ref that exists on a repo whose default branch is not `main`.
 */
const BASE_REF = INPUTS.BASE_REF;

/**
 * Where a run of this PRD that stopped before it finished left its commits
 * (#303), and where this one looks for them to resume from.
 */
const RESCUE_BRANCH = INPUTS.RESCUE_BRANCH;

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
  const issue = fetchTrustedIssue(INPUTS.GH_REPO, number, LOOP_ACCOUNTS);
  const comments = fetchTrustedComments(INPUTS.GH_REPO, number, LOOP_ACCOUNTS);
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
  // Pushing, opening the PRD PR and re-labelling all happen in workflow steps,
  // after this process has exited.
  scrubGitHubTokens();

  // The branch tip *before* the agent runs. Counting against `main` — which is
  // what the single-issue runner does — would count every earlier slice too, so
  // from slice 2 on a run where the agent committed nothing at all would still
  // look productive, and the workflow would go on to ask for a review of a
  // slice nobody implemented.
  const before = git(["rev-parse", "HEAD"]).trim();

  // An earlier run's unpushed commits (#303), where they still build on the
  // tip this run starts from. After `before`, so they count as this run's,
  // which they are: none of them was pushed. Set aside, and said so on the
  // PRD by `implement-prd:conclude`, where the PRD branch moved since they
  // were saved: handed over as the branch and its tip, the commit this run
  // moved past.
  const resume = resumeFromRescue(RESCUE_BRANCH);
  if (resume.kind === "resumed") {
    console.log(`Resuming from ${resume.commits} commit(s) an earlier run saved on ${RESCUE_BRANCH}.`);
  } else if (resume.kind === "ignored") {
    console.log(`::warning::${RESCUE_BRANCH} was saved on an older tip of ${BRANCH}, so this run starts fresh.`);
    writeJson("rescue_ignored.json", { branch: RESCUE_BRANCH, movedPast: git(["rev-parse", rescueRef(RESCUE_BRANCH)]).trim() });
  }

  const result = await sandcastle.run({
    name: `implement-prd-#${ISSUE_NUMBER}-sub-#${SUB_NUMBER}`,
    agent: claudeAgent("implement-prd", INPUTS),
    ...agentSandbox(INPUTS),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      ISSUE_NUMBER,
      ISSUE_TITLE,
      SUB_NUMBER,
      SUB_TITLE,
      BRANCH,
      BASE_REF,
      PRD_CONTEXT: prdContext,
      SUB_CONTEXT: subContext,
      RESUME: resumeSection(resume, RESCUE_BRANCH),
    },
    maxIterations: 1,
  });

  // Before the commit count, and whatever it finds; see implement.ts.
  const stale = staleReason(result.stdout);
  if (stale !== undefined) fail(staleFailure(`sub-issue #${SUB_NUMBER}`, stale));

  const commitsAhead = Number(git(["rev-list", "--count", `${before}..HEAD`]).trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail(`The agent finished without making any changes for sub-issue #${SUB_NUMBER}.`);
  }

  console.log(`Sub-issue #${SUB_NUMBER} produced ${commitsAhead} commit(s) on ${BRANCH}.`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
