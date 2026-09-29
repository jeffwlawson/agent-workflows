import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  claudeAgent,
  fail,
  fetchPullRequestBody,
  fetchTrustedComments,
  fetchTrustedIssue,
  git,
  outputDir,
  required,
  scrubGitHubTokens,
  updatePullRequestBody,
} from "../shared/common.js";
import { addMergedSlice, parseSlicesUpdate } from "../shared/slices-table.js";

/** The parent PRD. Context only — the work is the sub-issue below. */
const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");

/**
 * The **finishing run** (#177): every sub-issue is built, and this run merged
 * the last slice PR. It writes that slice's row and stops — no model, no
 * agent, nothing built — and the workflow hands the PRD PR over after it. So
 * everything below that only a build needs is required only of a build.
 */
const FINISHING = process.env["FINISHING"] === "true";
const forBuild = (name: string): string => (FINISHING ? "" : required(name));

/** The one sub-issue this run implements, chosen by the workflow's preflight. */
const SUB_NUMBER = forBuild("SUB_NUMBER");
const SUB_TITLE = forBuild("SUB_TITLE");

/** The slice branch this run builds on, cut from the PRD branch's tip. */
const BRANCH = forBuild("BRANCH");

/**
 * The PRD branch the slice branch was cut from, and the base of the slice PR
 * the workflow opens once this exits. Only the prompt uses it: it is where the
 * earlier slices are, which is what the agent builds on.
 */
const PRD_BRANCH = forBuild("PRD_BRANCH");

/**
 * The branch the chain is based on. Only the prompt uses it — it is what the
 * agent diffs to see the slices already on this branch — and it is the
 * workflow's `default-branch` input rather than a literal, so the instruction
 * names a ref that exists on a repo whose default branch is not `main`.
 */
const BASE_REF = forBuild("BASE_REF");

/**
 * The PRD PR, when this run merged a slice PR into the PRD branch; empty when
 * it merged none. Its body gets that slice's row of the slices table.
 */
const PRD_PR = process.env["PRD_PR"] ?? "";

/**
 * Write the merged slice's row into the PRD PR body (#174), from the facts the
 * workflow gathered once the merge landed.
 *
 * Here rather than in a step of its own because rendering is this package's,
 * and a workflow invokes this package exactly once — the one pinned `npm exec`
 * line the release rewrites. First, before the agent, so a build that fails
 * still leaves the row of the slice that did merge — and read, spliced and
 * written back within the same second, so a maintainer's edit to the body is
 * not overwritten with a copy read before a build that took minutes.
 */
const writeSliceRow = (prdPr: string): void => {
  const update = parseSlicesUpdate(
    JSON.parse(fs.readFileSync(path.join(outputDir(), "slices-table.json"), "utf8")) as unknown,
  );
  const body = fetchPullRequestBody(prdPr);
  const next = addMergedSlice(body, update);

  if (next === body) {
    console.log(`PRD PR #${prdPr} already has a row for sub-issue #${update.merged.subIssue}.`);
    return;
  }
  updatePullRequestBody(prdPr, next);
  console.log(`Wrote slice PR #${update.merged.slicePr}'s row into PRD PR #${prdPr}.`);
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
  if (PRD_PR !== "") {
    try {
      writeSliceRow(PRD_PR);
    } catch (error) {
      throw new Error(
        `Could not write the merged slice's row into the slices table of PRD PR #${PRD_PR} ` +
          `(${error instanceof Error ? error.message : String(error)}). The slice PR is merged; re-add ` +
          "`agent:implement` to retry — the merge is not repeated, and a row already written is left as it is.",
      );
    }
  }

  if (FINISHING) {
    console.log(`Finishing #${ISSUE_NUMBER}: every sub-issue is built, so no agent runs.`);
    process.exit(0);
  }

  // Both issues, through the same gate. The PRD is what makes the slice make
  // sense — it holds the ordering, the shared vocabulary and the reason the
  // seams are where they are — and it is exactly the context an agent working
  // one sub-issue in isolation would otherwise be missing.
  const prdContext = issueSection(ISSUE_NUMBER, ISSUE_TITLE);
  const subContext = issueSection(SUB_NUMBER, SUB_TITLE);

  // Context fetched and the slices table written; the agent has no legitimate
  // use for the GitHub token. Closing the sub-issue, pushing and re-labelling
  // all happen in workflow steps, after this process has exited.
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
      PRD_BRANCH,
      BASE_REF,
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
