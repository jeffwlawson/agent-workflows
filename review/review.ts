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
  workflowRunUrl,
  writeJson,
  writeText,
} from "../shared/common.js";
import { describeUnreadable } from "../shared/pr-feedback.js";
import { fetchPullRequestContext } from "../shared/review-context.js";
import {
  isPreviouslyMissed,
  placeFindings,
  reviewMutation,
  type Severity,
} from "../shared/review-findings.js";
import {
  capFollowUps,
  countFixBeforeMerge,
  deriveVerdict,
  renderFollowUpsBlock,
  renderReviewBody,
  reviewOutputSchema,
  VERDICT_CONTEXT,
  withMovedFindings,
  type CiResult,
} from "../shared/review-output.js";
import {
  describeRound,
  describesTheChange,
  detectReviewRound,
  unreadableRoundNote,
} from "../shared/review-round.js";
import {
  renderCarriedFindings,
  renderSettledFindings,
  verifyCarried,
  type ResolutionReason,
} from "../shared/review-verification.js";
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
 * is not one that can recommend approving a pull request.
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
      OPEN_FINDINGS: renderCarriedFindings(context.carriedFindings),
      SETTLED_FINDINGS: renderSettledFindings(context.settledFindings),
      PR_DIFF: context.diff,
    },
    output: sandcastle.Output.object({ tag: "output", schema: reviewOutputSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, "extraction.md"), "utf8"),
  });

  // Where each finding goes, decided here from the diff rather than by the
  // agent (#110). The guard that kept an unresolvable line anchor out of the
  // payload is still the guard it was — one such anchor makes GitHub reject the
  // whole review — but it reroutes the finding to a thread on the file instead
  // of dropping it. A finding the verdict counted and the review never showed
  // is the failure that change removed.
  //
  // And a finding in a file this pull request never touched is not posted as a
  // blocking finding at all (#127, decision 3): there is no thread for a
  // maintainer to answer it on, so it would count against a merge nobody could
  // release it from (#124). The brief asks the model to anchor such a problem
  // at the change that causes it; where it did not, nothing in the diff causes
  // it, and `unanchored` is what comes back — recorded below as a follow-up.
  const { placed, unanchored } = placeFindings(result.output.findings, context.diffLines);

  // What the review said about the findings it was handed: which threads the
  // workflow closes, and which findings are still owed (#111). The reviewer
  // decides this and the fixer no longer does — a fix run replies and resolves
  // nothing, so the only thing that closes a finding is a pass that read the
  // code afterwards.
  //
  // A carried finding the review said nothing about stays open. That is the
  // safe direction and it is `verifyCarried`'s to take, not this file's.
  const { resolutions, stillOpen, resolved } = verifyCarried(
    context.carriedFindings,
    result.output.verified,
  );
  const headSha = sh("git rev-parse HEAD").trim();

  // The third channel, serialised into the body on the way out. It cannot stay
  // a sibling of the findings in the posted artifact: a review has one body, and
  // the body is the only part of a review that is still readable — by a human
  // or by anything else — after the pull request has merged.
  //
  // Capped here rather than in the schema. A fourth follow-up is not a broken
  // review, and rejecting the output would lose every finding with it.
  //
  // **Posted on every run, including the run that recorded nothing**, where the
  // group renders not at all and the payload goes out alone. The list is a
  // complete restatement each round and the filing half reads the latest one,
  // so recording none has to be sayable: otherwise round 1's findings stay the
  // newest thing on the pull request and a merge after round 2 fixed them files
  // a stub for work already done. Both halves are `renderReviewBody`'s to
  // place; what is written here is the artifact a human debugging the run
  // opens.
  //
  // The findings the diff gave no anchor to lead the list, so the cap — which
  // drops from the end — spends its three slots on those before the
  // out-of-scope notes: a moved finding is one the review meant to stop the
  // merge with, which outranks a note about a function the diff only calls.
  const { kept: followUps, dropped: droppedFollowUps } = capFollowUps(
    withMovedFindings(unanchored, result.output.followUps),
  );

  // The verdict, derived from the review and the checks rather than written by
  // the agent (#96). Its heading and next-step line open the body, so the
  // outcome is the first thing a reader sees and the same words the commit
  // status carries — one statement in two places, not two that can disagree.
  const ci = readCiResult();
  const verdict = deriveVerdict(result.output, {
    ci,
    round: round.round,
    stillOpen: stillOpen.length,
    movedToFollowUps: unanchored.length,
  });
  // And a round nothing could establish says so in the body as well as in the
  // brief. The agent was told it was a second round; what it cannot say — and
  // what changes how a reader weighs the review — is that the round was the
  // stricter reading rather than a fact about this pull request.
  //
  // What the body is made of, and in what order, is `renderReviewBody`'s: it is
  // the part of the review a human acts on, and this file is a script with no
  // test around it (#105). It is handed the output whole rather than the fields
  // it reads, so the record it renders is the set the verdict above was counted
  // from and not a second reading of it (#113).
  //
  // The follow-ups are a group in it now rather than a block appended after it
  // (#109, decision 8 as the maintainer settled it), and the payload the filing
  // half reads on merge goes out last and invisibly — so the posted body is
  // what this returns, with nothing concatenated on afterwards.
  const reviewBody = renderReviewBody({
    verdict,
    output: result.output,
    roundNote: unreadableRoundNote(round),
    placed,
    movedToFollowUps: unanchored.length,
    stillOpen,
    resolved,
    followUps,
    droppedFollowUps,
    // *What changed in this PR* describes the change, so it is rendered where
    // there is a change nothing has described. Which rounds those are is
    // `describesTheChange`'s, beside the detection it reads — a fact about the
    // round rather than about the review, and one this file has no test around
    // it to hold.
    showWhatChanged: describesTheChange(round),
    runUrl: workflowRunUrl(),
  });

  // A GraphQL request body, posted by the workflow with `gh api graphql
  // --input`. REST `POST /pulls/{n}/reviews` cannot open a **file-level**
  // thread — it answers one with a 422 — and its `comments` field is deprecated
  // in favour of `threads` besides (#109, decision 5). `commitOID` pins the
  // review to the head that was reviewed, exactly as `commit_id` did.
  //
  // Composed by a tested function rather than written out here, for the reason
  // the body is: this file is a script with no test around it, and the shape it
  // writes is the shape a `--jq` path in the workflow reads back.
  writeJson(
    "review_payload.json",
    reviewMutation({ pullRequestId: context.prId, commitOID: headSha, body: reviewBody, placed }),
  );
  writeText("summary.md", reviewBody);

  // The threads this review verified, for the workflow step that closes them.
  // Written on every run, empty list included: the step reads the file rather
  // than deciding anything, and "there was nothing to resolve" is an answer it
  // should not have to infer from a missing file.
  //
  // The reply is composed here rather than in YAML for the reason the body is:
  // it is the only record of *why* a thread closed — GitHub takes
  // `resolutionReason` and then exposes it nowhere — and this file is a script
  // with no test around it.
  writeJson("thread_resolutions.json", resolutions);

  // What the workflow posts the commit status from — context, state and line.
  // A file rather than a step output, for the same reason the payload above is
  // one: the step that posts cannot read this process, and the table all three
  // come from is tested here rather than restated in YAML. The only copy of the
  // context that is *not* read from here is the one the failure arm posts,
  // which by definition runs on a review that wrote no file.
  //
  // `verdict` is the row's key rather than its heading, because the round-1 and
  // round-2 rows share a heading and a reader of this file has to tell them
  // apart — PRD #101's automatic fix may fire on the round-1 case and no other.
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
  if (followUps.length > 0) {
    writeText("follow_ups.md", renderFollowUpsBlock(followUps, droppedFollowUps));
  }

  console.log("Review complete.");
  console.log(
    `Verdict: ${verdict.verdict} (${countFixBeforeMerge(result.output, unanchored.length)} to fix before merge, checks ${ci}, round ${round.round}).`,
  );
  const placements = (kind: string): number => placed.filter((p) => p.placement === kind).length;
  const missed = result.output.findings.filter(isPreviouslyMissed).length;
  console.log(
    `Findings: ${result.output.findings.length} produced — ${placements("line")} on a line, ${placements("file")} on a file, ${unanchored.length} moved to follow-ups for having no anchor in the diff; ${missed} in code an earlier review had already read.`,
  );
  // The ratings, for a human explaining why the record reads the way it does.
  // They change no outcome above (#113) — which is exactly why the log is the
  // only place this run says them out loud besides the body.
  const rated = (severity: Severity): number =>
    result.output.findings.filter((f) => f.severity === severity).length;
  console.log(`Severity: ${rated("high")} high, ${rated("medium")} medium, ${rated("low")} low.`);
  // Split by reason rather than counted together: "the code was fixed" and "a
  // maintainer said no" are the two ways a finding stops counting, and a human
  // reading this log to explain a verdict needs to know which one happened.
  const closedAs = (reason: ResolutionReason): number =>
    resolutions.filter((r) => r.reason === reason).length;
  console.log(
    `Earlier findings: ${context.carriedFindings.length} open before this review — ${closedAs("ADDRESSED")} verified fixed, ${closedAs("WONT_FIX")} closed on a maintainer's decline, ${stillOpen.length} still open.`,
  );
  console.log(`Settled by a maintainer and not raised again: ${context.settledFindings.length}.`);
  console.log(`Follow-ups: ${followUps.length} recorded, ${droppedFollowUps} dropped by the cap.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
