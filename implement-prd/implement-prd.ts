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
  writeText,
} from "../shared/common.js";
import { firstLine, readPrdBranch } from "../shared/prd-round.js";
import { renderPrdStatus, renderProgressList, statusBlock, type ProgressInputs } from "../shared/progress-list.js";
import { readRoundRecord, roundCounts, type RoundCounts } from "../shared/round-header.js";
import { sliceRanges } from "../shared/slice-ranges.js";

/** The parent PRD. Context only — the work is the sub-issue below. */
const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");

/** The one sub-issue this run implements, chosen by the workflow's preflight. */
const SUB_NUMBER = required("SUB_NUMBER");
const SUB_TITLE = required("SUB_TITLE");

/**
 * The PRD branch this run builds on, at its tip: every earlier slice of the
 * PRD is on it, which is what the agent builds on. The workflow pushes it
 * once this exits.
 */
const BRANCH = required("BRANCH");

/**
 * The branch the chain is based on. Only the prompt uses it — it is what the
 * agent diffs to see the slices already on this branch — and it is the
 * workflow's `default-branch` input rather than a literal, so the instruction
 * names a ref that exists on a repo whose default branch is not `main`.
 */
const BASE_REF = required("BASE_REF");

/** The PRD PR, or "" on the first slice, which opens it once this exits. */
const PRD_PR = process.env["PRD_PR"] ?? "";

/**
 * The merge of the default branch the run pushed before this started (#245),
 * or "": the PRD PR's head is then that merge, which no review has seen.
 */
const MERGED = process.env["MERGED"] ?? "";

/**
 * The PRD PR's progress list (#246), a table since #298 with the status line
 * beside it, rendered from the PRD branch as it stands, the parent's
 * sub-issues and the rounds on the PRD PR: with this slice **in review**, left
 * in `progress.md` for the step that asks for its round once the slice is
 * pushed, with its status line in `status.md`. That one is rendered over the
 * branch with this slice's commits on it, which is what the push puts there;
 * they are not made yet, so its row links no diff until its round ends.
 *
 * And for a run that stops, two more, for `Show the stopped slice in the
 * progress list` to write over the list the gate showed this slice building
 * in (#312): `progress_stopped.md` with nothing pushed, this slice not started
 * and the head's verdict as it now stands, and `progress_stopped_pushed.md`
 * with this slice pushed and parked, since no round of it is running, each
 * with its `status_` twin.
 *
 * Nothing here writes the PRD PR's body: this job's token reads only (#308),
 * and the gate wrote the building list before the agent's job started. Never
 * fails the run: the list is a view of the chain, and a slice is worth more
 * than it. A list that cannot be rendered says so.
 */
const writeProgress = (): void => {
  try {
    const sub = Number(SUB_NUMBER);
    const { subIssues, log, ranges } = readPrdBranch(ISSUE_NUMBER, BASE_REF);
    const pushed = sliceRanges(
      [{ sha: "(this slice)", parents: [git(["rev-parse", "HEAD"]).trim()], slice: sub }, ...log],
      subIssues,
    );
    // Each slice's reviews and fix rounds so far (#298), off the PRD PR; none
    // before it is open. Left out where they cannot be read, and the table
    // says so in each cell.
    let rounds: RoundCounts | undefined;
    if (PRD_PR !== "") {
      try {
        rounds = roundCounts(readRoundRecord(PRD_PR), ranges);
      } catch (error) {
        console.log(`::warning::The PRD PR's rounds could not be read, so the progress table does not count them: ${firstLine(error)}`);
      }
    }
    const server = process.env["GITHUB_SERVER_URL"];
    const repo = process.env["GITHUB_REPOSITORY"];
    const prUrl = PRD_PR !== "" && server && repo ? `${server}/${repo}/pull/${PRD_PR}` : undefined;
    const common = { subIssues, finalReview: "not requested" as const, prUrl, rounds };
    const write = (name: string, inputs: ProgressInputs): void => {
      writeText(`progress${name}.md`, renderProgressList(inputs));
      writeText(`status${name}.md`, statusBlock(renderPrdStatus(inputs)));
    };
    write("", { ...common, ranges: pushed, verdict: "none", running: { kind: "review" } });
    write("_stopped", { ...common, ranges, verdict: MERGED === "" ? "approval" : "none", running: null });
    write("_stopped_pushed", { ...common, ranges: pushed, verdict: "none", running: null });
  } catch (error) {
    console.log(`::warning::The PRD PR's progress list could not be rendered: ${firstLine(error)}`);
  }
};

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
  writeProgress();

  // Context fetched and the progress list rendered; the agent has no
  // legitimate use for the GitHub token.
  // Pushing, opening the PRD PR and re-labelling all happen in workflow steps,
  // after this process has exited.
  scrubGitHubTokens();

  // The branch tip *before* the agent runs. Counting against `main` — which is
  // what the single-issue runner does — would count every earlier slice too, so
  // from slice 2 on a run where the agent committed nothing at all would still
  // look productive, and the workflow would go on to ask for a review of a
  // slice nobody implemented.
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
      BASE_REF,
      PRD_CONTEXT: prdContext,
      SUB_CONTEXT: subContext,
    },
    maxIterations: 1,
  });

  const commitsAhead = Number(git(["rev-list", "--count", `${before}..HEAD`]).trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail(`The agent finished without making any changes for sub-issue #${SUB_NUMBER}.`);
  }

  console.log(`Sub-issue #${SUB_NUMBER} produced ${commitsAhead} commit(s) on ${BRANCH}.`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
