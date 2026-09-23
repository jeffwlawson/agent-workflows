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
import { describeUnreadable } from "../shared/pr-feedback.js";
import { fetchPullRequestContext } from "../shared/review-context.js";
import {
  capFollowUps,
  countFixBeforeMerge,
  deriveVerdict,
  filterInlineComments,
  renderFollowUpsBlock,
  renderReviewSummary,
  reviewOutputSchema,
  VERDICT_CONTEXT,
  type CiResult,
} from "../shared/review-output.js";
import {
  describeRound,
  detectReviewRound,
  unreadableRoundNote,
} from "../shared/review-round.js";
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

/**
 * The same checks as one word, written by the same workflow step — and the
 * half of the verdict that is not the agent's to decide.
 *
 * Deliberately not read out of the prose above: that file is evidence for the
 * agent, and a derivation that parsed it would be a second description of a
 * format written two steps away. Anything this cannot read is `unknown`, which
 * the derivation treats as "not green" — a review that could not see the checks
 * is not one that can say a pull request is ready to merge.
 */
const readCiResult = (): CiResult => {
  const file = process.env["CI_RESULT_FILE"];
  if (!file) return "unknown";
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value === "green" || value === "red" ? value : "unknown";
  } catch {
    return "unknown";
  }
};

try {
  const context = fetchPullRequestContext(PR_NUMBER);

  // Which pass over this pull request this is, read off the repository before
  // the token goes (#96). It changes what the agent is asked to do — round 2
  // verifies that the last round's findings landed — and it changes what the
  // derivation may conclude, which is the half that is not the agent's.
  const round = detectReviewRound(PR_NUMBER);
  console.log(
    `Round: ${round.round}${round.unreadable === undefined ? "" : ` — assumed, because ${round.unreadable}`}.`,
  );

  // A review proceeds on what survived a partial answer — but says so twice:
  // here, for whoever reads the run, and in the discussion the agent is handed.
  // An unreadable selection that is only *absent* is indistinguishable from a
  // PR nobody has commented on (#76).
  if (context.unreadableFeedback.length > 0) {
    console.log(
      `Feedback selections that could not be read: ${describeUnreadable(context.unreadableFeedback)}`,
    );
  }

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
      ROUND: describeRound(round),
      PR_DIFF: context.diff,
    },
    output: sandcastle.Output.object({ tag: "output", schema: reviewOutputSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, "extraction.md"), "utf8"),
  });

  // Drop any inline comment that does not land on a changed line — GitHub
  // rejects the whole review otherwise.
  const validComments = filterInlineComments(result.output.inlineComments, context.diffLines);
  const headSha = sh("git rev-parse HEAD").trim();

  // The third channel, serialised into the body on the way out. It cannot stay
  // a sibling of `summary` in the posted artifact: a review has one body, and
  // the body is the only part of a review that is still readable — by a human
  // or by anything else — after the pull request has merged.
  //
  // Capped here rather than in the schema. A fourth follow-up is not a broken
  // review, and rejecting the output would lose the summary and every inline
  // comment with it.
  //
  // **Appended on every run, including the run that recorded nothing**, where
  // it renders as the bare payload and shows a reader nothing at all. The list
  // is a complete restatement each round and the filing half reads the latest
  // one, so recording none has to be sayable: otherwise round 1's findings stay
  // the newest thing on the pull request and a merge after round 2 fixed them
  // files a stub for work already done.
  const { kept: followUps, dropped: droppedFollowUps } = capFollowUps(result.output.followUps);
  const followUpsBlock = renderFollowUpsBlock(followUps, droppedFollowUps);

  // The verdict, derived from the review and the checks rather than written by
  // the agent (#96). Its next-step line opens the summary, so the outcome is
  // the first thing a reader sees and the same sentence the commit status
  // carries — one statement in two places, not two that can disagree.
  const ci = readCiResult();
  const verdict = deriveVerdict(result.output, { ci, round: round.round });
  // And a round nothing could establish says so in the body as well as in the
  // brief. The agent was told it was a second round; what it cannot say — and
  // what changes how a reader weighs the review — is that the round was the
  // stricter reading rather than a fact about this pull request.
  //
  // What the body is made of, and in what order, is `renderReviewSummary`'s:
  // it is the part of the review a human acts on, and this file is a script
  // with no test around it (#105).
  const summary = renderReviewSummary({
    verdict: verdict.description,
    needsYou: result.output.needsYou,
    roundNote: unreadableRoundNote(round),
    fixBeforeMerge: result.output.fixBeforeMerge,
    summary: result.output.summary,
  });
  const body = `${summary}\n\n${followUpsBlock}`;

  writeJson("review_payload.json", {
    commit_id: headSha,
    event: "COMMENT",
    body,
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
  writeText("summary.md", summary);

  // What the workflow posts the commit status from — context, state and line.
  // A file rather than a step output, for the same reason the payload above is
  // one: the step that posts cannot read this process, and the table all three
  // come from is tested here rather than restated in YAML. The only copy of the
  // context that is *not* read from here is the one the failure arm posts,
  // which by definition runs on a review that wrote no file.
  writeJson("verdict.json", {
    context: VERDICT_CONTEXT,
    verdict: verdict.verdict,
    state: verdict.state,
    description: verdict.description,
  });

  // How the workflow knows to mark the pull request: a step cannot read this
  // process's memory, and the marker label has to go on when — and only when —
  // this run recorded something. Written only in that case, so its *existence*
  // is the whole condition and the step needs no parsing. The content is the
  // block exactly as posted, which is what a human debugging the run wants.
  //
  // Keyed on the findings rather than on the block, which is no longer the same
  // question: the block is posted either way, and a retraction is precisely the
  // run that must not mark the pull request.
  if (followUps.length > 0) writeText("follow_ups.md", followUpsBlock);

  console.log("Review complete.");
  console.log(
    `Verdict: ${verdict.verdict} (${countFixBeforeMerge(result.output)} to fix before merge, checks ${ci}, round ${round.round}).`,
  );
  console.log(`Inline comments: ${validComments.length} kept of ${result.output.inlineComments.length} produced.`);
  console.log(`Follow-ups: ${followUps.length} recorded, ${droppedFollowUps} dropped by the cap.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
