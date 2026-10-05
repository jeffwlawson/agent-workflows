import { execFileSync } from "node:child_process";
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
import { applyCriteriaRulings, renderCriteriaForReview } from "../shared/acceptance-criteria.js";
import { applyNoteRulings, renderNotesForReview } from "../shared/fix-notes.js";
import { fetchReviews } from "../shared/follow-up-filing.js";
import { earlierFollowUps } from "../shared/follow-up-plan.js";
import { renderMergeDanger } from "../shared/merge-danger.js";
import { describeUnreadable } from "../shared/pr-feedback.js";
import {
  firstLine,
  parkReasonOf,
  readPrdBranch,
  readSliceRound,
  renderFinalReviewBrief,
  renderParkComment,
  renderPrdSummary,
  renderSliceRoundBrief,
  REVIEW_URL_SLOT,
  roundName,
  sliceCriteria,
  sliceRedTests,
  type ParkFinding,
  type PrdBranch,
  type PrdRound,
  type SliceCriteria,
} from "../shared/prd-round.js";
import { currentSummary, summaryDue, summaryUpdate } from "../shared/pr-summary.js";
import { progressAtRoundEnd, renderPrStatus, statusBlock } from "../shared/progress-list.js";
import {
  describeRedCheck,
  readRedCheck,
  redTestsRecord,
  renderRedCheck,
  renderRedCheckForFinal,
  renderRedTestsBlock,
  withEvidence,
  type SliceRedTests,
} from "../shared/red-check.js";
import { fetchPullRequestContext } from "../shared/review-context.js";
import {
  isPreviouslyMissed,
  pathErrorNote,
  pathErrors,
  placeFindings,
  reviewMutation,
  type Severity,
} from "../shared/review-findings.js";
import {
  countFixBeforeMerge,
  dedupeFollowUps,
  deriveVerdict,
  FIX_ROUND_STATUS,
  followUpsCap,
  MAX_FOLLOW_UPS,
  recordFollowUps,
  type EarlierFollowUps,
  renderFollowUpsBlock,
  renderReviewPost,
  reviewOutputSchema,
  VERDICT_CONTEXT,
  type CiResult,
  type FixRounds,
} from "../shared/review-output.js";
import {
  describeHistory,
  fixRoundProgress,
  readReviewHistory,
  unreadableHistoryNote,
} from "../shared/review-round.js";
import {
  renderCarriedFindings,
  renderSettledFindings,
  verifyCarried,
  type CarriedFinding,
  type ResolutionReason,
} from "../shared/review-verification.js";
import { readRoundRecord, reviewHeader, roundCounts, type RoundCounts, type RoundScope } from "../shared/round-header.js";
import { runWithExtraction } from "../shared/run-with-extraction.js";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");
const BASE_REF = required("BASE_REF");

/**
 * The PRD this pull request delivers, when its head is a PRD branch:
 * `agent/prd-<parent>-<slug>`, the name `implement-prd` gives it. Every slice of
 * the PRD is built on that branch and reviewed on this pull request, one
 * **slice round** at a time, and then, where more than one slice landed, once
 * more as the **final review** (PRD #222).
 */
const PRD_MATCH = /^agent\/prd-(\d+)-/.exec(BRANCH);
const prdParent = PRD_MATCH?.[1];

/**
 * Which round of a PRD PR this is, as the workflow decided it from the final
 * review's mark in the PRD PR's body before this process started: `final`, or
 * a slice round. Decided there rather than here so that a run which fails
 * before it gets this far still knows which round it was.
 */
const FINAL_REVIEW = process.env["ROUND"] === "final";

/**
 * What kind of pull request the reviewer is reading. An ordinary one is the
 * whole change; a PRD PR's slice round is one slice of it, bounded by that
 * slice's commits; its final review is every slice together.
 */
const pullRequestKind = (round: PrdRound | undefined): string =>
  round === undefined
    ? `An ordinary pull request into \`${BASE_REF}\`. Review the whole change.`
    : round.kind === "final"
      ? renderFinalReviewBrief(round.parent, BRANCH, BASE_REF)
      : renderSliceRoundBrief(round, BRANCH, BASE_REF);

/**
 * Results of the PR's other checks, gathered by the workflow after waiting for
 * them to finish. This is the only evidence in the prompt that comes from
 * *outside* the repo's own assumptions — the diff, the issue and the tests all
 * encode what the team already believes, whereas a check that compares the
 * code against real-world inputs does not. Absent (or timed out) it
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

/**
 * Whether the workflow will start a fix round itself if this review recommends
 * changes (#201): what *Settle the fix-round budget* decided from the
 * repository's budget, the rounds this pull request has spent and the PAT.
 * None of those is readable here once the token is gone, and the job that adds
 * `agent:fix` selects on the field this decides, so the step's one answer is
 * taken rather than a second one worked out.
 *
 * Absent is off: a run that could not say must not claim a fix round started.
 */
const willAutoFix = (): boolean => process.env["AUTO_FIX"] === "true";

/**
 * The budget and the rounds spent against it, where the same step could count
 * them, for the stop a spent budget records. Anything unreadable is left out,
 * and the row records no stop.
 */
const fixRounds = (): FixRounds | undefined => {
  const count = (name: string): number | undefined => {
    const value = process.env[name] ?? "";
    return /^[0-9]+$/.test(value) ? Number(value) : undefined;
  };
  const spent = count("FIX_ROUNDS_SPENT");
  const budget = count("FIX_ROUND_BUDGET");
  return spent === undefined || budget === undefined ? undefined : { spent, budget };
};

/**
 * The final review's summary shape (#247, #356). The review writes the
 * outcome, and the Merge Danger's fields as every summary write does; the
 * workflow adds the *Differs from the PRD* lines and the Evidence from the
 * slice rounds' records, and the known issues from this review's follow-ups.
 */
const FINAL_SUMMARY_SHAPE = [
  "**This is the final review of a PRD PR, so the summary is the whole PRD's**, in the layout the summary section above describes. Write:",
  "",
  "- **`summary`**: the **outcome**, what the PRD delivered as a whole. Open it as the summary section above asks, with the **smallest view that makes the point**: zero, one or two sketches of the whole change, drawn from the diff as it stands and never from the PRD, each beside the short text it supports. Then a few sentences, brief and with no preamble, and a bullet per behaviour the PRD changes, cut to what the sketches do not already show; sketches do not count against the word budget, which stays for the prose. Nothing about the review, and no list of slices: the body already shows them.",
  "- **`door`**, **`blastRadius`**, their notes and **`breaking`**: as the summary section above asks, of the whole PRD. A breaking change goes in `breaking`, never in a bullet.",
  "",
  "A **Differs from the PRD:** line for each slice that changed or dropped one of its criteria, and the Evidence (each slice's failing-first tests, where the red check is configured, beside CI's result), are added from each slice round's record, and the known issues from the follow-ups this review records, so write none of them. The title is the whole PRD's, never the PRD issue's title copied. Nothing in what you write may say the pull request is a draft or that slices are still to come: every slice is built.",
].join("\n");

/** Off a PRD PR, the brief's follow-ups section is the ordinary one. */
const NOT_CARRIED =
  "(None. `followUps` is a complete restatement every round on this pull request, so re-record the entries an earlier round listed that are still true.)";

try {
  // On a PRD PR, which round this is, read while the token is still in hand.
  // A slice round reads its slice off the PRD branch's history, and is handed
  // that slice's sub-issue as its linked issue: the PRD PR's body closes the
  // parent and every sub-issue, and what this round checks is one of them.
  const round: PrdRound | undefined =
    prdParent === undefined
      ? undefined
      : FINAL_REVIEW
        ? { kind: "final", parent: prdParent }
        : readSliceRound(prdParent, BASE_REF);
  console.log(`Round: ${round === undefined ? "an ordinary pull request" : roundName(round)}.`);
  const subIssue = round?.kind === "slice" ? round.slice?.subIssue : undefined;
  const context = fetchPullRequestContext(PR_NUMBER, subIssue === undefined ? undefined : String(subIssue));

  // The linked issue's acceptance criteria, which this review rules on one by
  // one (#214): on a slice round, its sub-issue's. Not on the final review,
  // whose linked issue is the PRD: each slice was held to its own sub-issue's
  // criteria in its own round, and a PRD's checklist (often its slices) is not
  // this pass's.
  const criteria = round?.kind === "final" ? [] : context.criteria;
  console.log(`Acceptance criteria handed to the review: ${criteria.length}.`);

  // What the verdicts already on this pull request say about this review,
  // read off the repository before the token goes (#202). Whether it follows a
  // fix round changes what the agent is asked to do (verify that the last
  // round's findings landed) and what the derivation may conclude: the early
  // stop judges that round, which is the half that is not the agent's.
  // A fix round that pushed nothing but left a note asked for this review as
  // well (#213), and is one the early stop judges like any other.
  const history = readReviewHistory(PR_NUMBER, context.fixNotes.length > 0);
  console.log(
    `Follows a fix round: ${history.afterFixRound ? "yes" : "no"}${history.unreadable === undefined ? "" : `, assumed because ${history.unreadable}`}.`,
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

  // The head this review reads, and whether the title and the summary block
  // are rewritten by it (#218): only where anything was pushed since the
  // summary was last written, which the block records itself.
  // The final review writes them however little was pushed (#247): the last
  // slice round wrote them at this same head, about one slice.
  //
  // A slice round of a PRD of more than one slice writes neither (#298): the
  // PRD PR's summary is the final review's, and holds its placeholder until
  // then. A PRD of one slice has no final review, so its round writes them.
  const headSha = sh("git rev-parse HEAD").trim();
  const final = round?.kind === "final";
  const sliceOfMany = round?.kind === "slice" && (round.slice?.n ?? 2) > 1;
  const writesSummary = !sliceOfMany && summaryDue(context.prBody, headSha, final);
  console.log(
    `Title and summary: ${
      sliceOfMany
        ? "left for the final review, since this is a slice round of a PRD of more than one slice"
        : !writesSummary
        ? "left as they are, since nothing was pushed after the summary was last written"
        : final
          ? "rewritten with the PRD's sections, since this is the final review"
          : "rewritten, since something was pushed after the summary was last written"
    }.`,
  );

  // The red check's report (#232), where the caller configured the check: the
  // `red-check` job's artifact, downloaded beside the CI evidence. Whether it is
  // configured is the workflow's to say, since a check that is off and one
  // whose report was lost both leave no file, and only the second is unknown.
  const redCheck = readRedCheck(process.env["RED_CHECK_CONFIGURED"] === "true", process.env["RED_CHECK_FILE"]);
  console.log(`Red check: ${describeRedCheck(redCheck)}.`);

  // The park comment for a round that does not finish (PRD #222), written now
  // because a failure later has no chance to: the advance job posts it on the
  // PRD's parent if the review or its posting fails. What is open is what was
  // open before this review, since nothing after this point is known to have
  // happened.
  const runUrl = workflowRunUrl();
  if (round !== undefined) {
    writeText(
      "park_failed.md",
      renderParkComment({
        round,
        prNumber: PR_NUMBER,
        reason: "failed",
        findings: context.carriedFindings.map(carriedForPark),
        ...(runUrl === undefined ? {} : { runUrl }),
      }),
    );
  }

  // The PRD branch, read once for what follows, while the token is in hand.
  // Undefined off a PRD PR, or where it cannot be read, which each use below
  // says in its own words.
  let prdBranch: PrdBranch | undefined;
  if (round !== undefined) {
    try {
      prdBranch = readPrdBranch(round.parent, BASE_REF);
    } catch (error) {
      console.log(`::warning::The PRD branch's history could not be read: ${firstLine(error)}`);
    }
  }

  // Every review and fix round on this pull request so far, by slice on a PRD
  // PR (#298): what this review's header is numbered from, and what the
  // progress table counts. Undefined where they could not be read, and the
  // header and the counts are left out rather than guessed.
  let counts: RoundCounts | undefined;
  try {
    counts = roundCounts(readRoundRecord(PR_NUMBER), prdBranch?.ranges, round !== undefined);
  } catch (error) {
    console.log(`::warning::This pull request's earlier rounds could not be read, so the review is not numbered: ${firstLine(error)}`);
  }
  const scope: RoundScope =
    round?.kind === "final"
      ? { kind: "final" }
      : round?.kind === "slice" && round.slice !== undefined
        ? { kind: "slice", k: round.slice.k, n: round.slice.n, subIssue: round.slice.subIssue }
        : { kind: "regular" };
  const header = counts === undefined ? undefined : reviewHeader(scope, counts);
  console.log(`Header: ${header ?? "none, since the earlier rounds could not be read"}.`);
  const server = process.env["GITHUB_SERVER_URL"];
  const repo = process.env["GITHUB_REPOSITORY"];
  const prUrl = server && repo ? `${server}/${repo}/pull/${PR_NUMBER}` : undefined;

  // The PRD PR's progress table and status line for each way this round can
  // end (#246, #298), for the advance job, which knows how it ended and runs
  // no toolchain, to write into the body. Written now, so a run that fails
  // has them, and again once the review knows what it leaves open. A list
  // that cannot be rendered is left as it stands, and says so: it is a view
  // of the chain, and a review is worth more than it.
  const writeProgress = (open: number): void => {
    if (round === undefined) return;
    if (prdBranch === undefined) {
      console.log("::warning::The PRD PR's progress list could not be rendered, so it is left as it stands.");
      return;
    }
    const lists = progressAtRoundEnd(
      {
        subIssues: prdBranch.subIssues,
        ranges: prdBranch.ranges,
        finalReview: round.kind === "final" ? "requested" : "not requested",
      },
      { rounds: counts, review: REVIEW_URL_SLOT, open, prUrl },
    );
    for (const [ending, list] of Object.entries(lists)) {
      writeText(`progress_${ending}.md`, list.progress);
      writeText(`status_${ending}.md`, list.status);
    }
  };
  writeProgress(context.carriedFindings.length);

  // On a PRD PR, the follow-ups (#247): what every earlier round on it
  // recorded, carried forward into this review's record, since `follow-ups`
  // files from the newest body alone and each round here is scoped to one
  // slice; and the cap, three per landed slice. Off a PRD PR, neither: a
  // regular pull request's review restates its list every round, and its cap
  // stays three. The final review also reads each slice round's criteria
  // record off the same reviews, by the commit each one reviewed.
  let carried: EarlierFollowUps[] = [];
  let cap = MAX_FOLLOW_UPS;
  let slicesCriteria: SliceCriteria[] | undefined;
  let slicesRedTests: SliceRedTests[] | undefined;
  if (round !== undefined) {
    const reviews = fetchReviews(PR_NUMBER);
    const earlier = earlierFollowUps(reviews);
    carried = earlier.carried;
    for (const skipped of earlier.skipped) {
      console.log(`::warning::Follow-ups not carried forward from ${skipped}.`);
    }
    if (prdBranch === undefined) {
      console.log(`::warning::The landed slices could not be counted, so the follow-ups cap is ${cap}.`);
    } else {
      const landed = prdBranch.ranges.slices.filter((slice) => slice.range !== null).length;
      cap = followUpsCap(landed);
      if (round.kind === "final") {
        slicesCriteria = sliceCriteria(reviews, prdBranch.ranges);
        slicesRedTests = sliceRedTests(reviews, prdBranch.ranges);
      }
    }
    console.log(
      `Follow-ups: ${carried.reduce((n, e) => n + e.moved.length + e.rest.length, 0)} recorded by earlier rounds, carried forward under a cap of ${cap}.`,
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
      PULL_REQUEST_KIND: pullRequestKind(round),
      ISSUE_NUMBER: context.issueNumber || "(none)",
      ISSUE_TITLE: context.issueTitle || "(no linked issue)",
      LINKED_ISSUE: context.linkedIssue,
      ACCEPTANCE_CRITERIA: renderCriteriaForReview(criteria, context.prBody),
      DISCUSSION: context.discussion || "(no collaborator comments)",
      CI_STATUS: readCiStatus(),
      // The final review's red evidence is each slice round's record (#235),
      // not a run of its own: against the merge-base a later slice's tests
      // read as broken, and the job runs nothing on it.
      RED_CHECK:
        final && redCheck.kind !== "not-configured"
          ? renderRedCheckForFinal(slicesRedTests)
          : renderRedCheck(redCheck, headSha),
      HISTORY: describeHistory(history),
      OPEN_FINDINGS: renderCarriedFindings(context.carriedFindings),
      SETTLED_FINDINGS: renderSettledFindings(context.settledFindings),
      FIX_NOTES: renderNotesForReview(context.fixNotes),
      PR_DIFF: context.diff,
      CURRENT_SUMMARY: currentSummary(context.prBody),
      SUMMARY_RULE: sliceOfMany
        ? "**This review leaves them as they are.** This is a slice round, and the final review writes the pull request's title and summary for the whole PRD, so the workflow writes neither; omit both fields."
        : !writesSummary
        ? "**This review leaves them as they are.** Nothing was pushed since the summary was last written, so the workflow writes neither; omit both fields."
        : final
          ? "**This review writes them.** It is the final review, so the workflow replaces the title and the summary block with yours, laid out as the section below says."
          : "**This review writes them.** Something was pushed since the summary was last written, so the workflow replaces the title and the summary block with yours.",
      FINAL_SUMMARY: final ? FINAL_SUMMARY_SHAPE : "",
      CARRIED_FOLLOW_UPS: round === undefined ? NOT_CARRIED : renderCarriedFollowUps(carried),
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
  //
  // An unmet acceptance criterion is one of those findings (#214): the review
  // rules on each criterion, and `applyCriteriaRulings` makes each unmet one a
  // fix-before-merge finding at the anchor the review gave it. Added to the
  // output here, before anything reads it, so placement, the count and the
  // record all see one set.
  const criteriaRulings = applyCriteriaRulings(criteria, result.output.criteria ?? []);
  const reviewed = {
    ...result.output,
    findings: [...result.output.findings, ...criteriaRulings.findings],
  };
  const { placed, unanchored } = placeFindings(reviewed.findings, context.diffLines);

  // **Unless the path names nothing.** "Outside the diff" only means "not this
  // pull request's" for a file that exists; a path that is no file at the
  // reviewed head is a slip in the review, and the finding behind it may be a
  // blocker in a file the change did touch. Those still go to the follow-ups
  // with the rest — the record stays one set — but the review says a human has
  // to look, so the verdict cannot come out green over them (`pathErrors`).
  const unplaceable = pathErrors(unanchored, isFileAtHead);
  const pathErrorReason = pathErrorNote(unplaceable);
  const output =
    pathErrorReason === undefined
      ? reviewed
      : {
          ...reviewed,
          needsYou: [reviewed.needsYou, pathErrorReason].filter(Boolean).join("\n\n"),
        };

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
    output.verified,
  );
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
  // The findings the diff gave no anchor to lead the list and are exempt from
  // that cap: a moved finding is one the review meant to stop the merge with,
  // already off the count and out of the record, so the follow-ups are the last
  // door it has. `recordFollowUps` owns both halves — the order and the
  // exemption — because the payload carries the length of the exempt prefix and
  // a list assembled anywhere else would name the wrong entries to the filing
  // run.
  //
  // The fix run's out-of-scope notes join the review's own follow-ups here
  // (#213), ahead of them and inside the cap: the review chose to promote each
  // one over dropping it. A note it dropped is listed in the body with its
  // reason instead, so every note ends one way or the other.
  const notes = applyNoteRulings(context.fixNotes, output.noteRulings ?? []);
  const {
    followUps,
    dropped: droppedFollowUps,
    moved: movedFollowUps,
    cap: followUpsCapUsed,
    carried: followUpsCarried,
  } = recordFollowUps(unanchored, [...notes.promoted, ...output.followUps], unplaceable, { cap, carried });

  // The verdict, derived from the review and the checks rather than written by
  // the agent (#96). Its heading and next-step line open the body, so the
  // outcome is the first thing a reader sees, and the commit status carries
  // the short form of the same line from the same row (#297).
  const ci = readCiResult();
  const rounds = fixRounds();
  // What the fix round this review follows closed of the findings it was
  // given, matched by id (#202). New findings this review raised are in
  // neither half, so they neither count as progress nor reset anything.
  const progress = fixRoundProgress(history, context.carriedFindings, resolved);
  const verdict = deriveVerdict(output, {
    ci,
    fixRoundProgress: progress,
    stillOpen: stillOpen.length,
    movedToFollowUps: unanchored.length,
    autoFix: willAutoFix(),
    ...(rounds === undefined ? {} : { fixRounds: rounds }),
  });
  // And a history nothing could establish says so in the body as well as in
  // the brief. The agent was told it followed a fix round; what it cannot say,
  // and what changes how a reader weighs the review, is that this was the
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
  //
  // A slice round records its red tests in its review (#235), invisibly: the
  // body's failing-first list is rewritten by the next slice, and the review
  // is the one record of a slice that outlives it, for the final review to
  // list by slice.
  const redTests = round?.kind === "slice" ? redTestsRecord(redCheck) : undefined;
  const post = renderReviewPost({
    verdict,
    output,
    roundNote: unreadableHistoryNote(history),
    placed,
    movedToFollowUps: movedFollowUps,
    stillOpen,
    resolved,
    followUps,
    droppedFollowUps,
    followUpsCap: followUpsCapUsed,
    followUpsCarried,
    droppedNotes: notes.dropped,
    criteria: criteriaRulings.results,
    ...(redTests === undefined ? {} : { redTestsBlock: renderRedTestsBlock(redTests) }),
    runUrl: workflowRunUrl(),
    header,
    // What was shed, where the body had to be cut to fit GitHub's limit (#140).
    // A body that cannot be made to fit throws, and the catch below writes the
    // reason rather than letting the post meet the limit as a 422.
    log: (line) => console.log(line),
  });
  const reviewBody = post.body;

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

  // What the posting job puts *Resolved since last review* back together from
  // (#257), once it knows which of this review's closures held: this job runs
  // the model and posts nothing, and the job that resolves the threads posts
  // the body afterwards. A thread it could not resolve is listed as still open
  // rather than resolved. The payload above carries the body as it reads where
  // every closure held, which is also the body a human debugging the run reads.
  writeJson("review_body.json", {
    slotted: post.slotted,
    slot: post.slot,
    resolved: post.resolved,
    groups: post.groups,
  });

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

  // The title and the summary block, for the posting job to write (#218).
  // Written only where this review rewrites them, so the file's existence is
  // the whole condition, as `follow_ups.md`'s is. The posting job splices the
  // summary into the body as it stands then, not as it was read here, so an
  // edit made outside the block while this review ran survives it.
  //
  // The final review's summary is the PRD's (#247, #356): its outcome, then a
  // line per slice that changed or dropped a criterion, laid out here.
  //
  // Every summary write ends with the Merge Danger (#356), from the review's
  // door, blast radius and breaking changes, its known issues the follow-ups
  // this review records to be filed on merge.
  //
  // What the Evidence's After and its test sketches come from (#355): CI's
  // result at the head the summary describes, and the sketches the review
  // wrote, which the render attaches only to tests listed as failing first.
  const evidence = { ci, head: headSha, testSketches: output.testSketches };
  const written = final
    ? {
        ...output,
        summary: renderPrdSummary({
          outcome: output.summary,
          danger: output,
          slices: slicesCriteria,
          followUps,
          // Each slice's red tests (#235), where the check is configured.
          ...(redCheck.kind === "not-configured" ? {} : { redTests: { slices: slicesRedTests } }),
          evidence,
        }),
      }
    : output.summary === undefined
      ? output
      : // A slice or a regular pull request's body gives its Evidence under
        // the summary (#234, #355), from the red check's report and CI's
        // result rather than the agent's word, so the agent's text and the
        // Evidence are kept apart. The final review's is laid out by slice.
        {
          ...output,
          summary: `${withEvidence(output.summary, redCheck, evidence)}\n\n${renderMergeDanger(output, followUps)}`,
        };
  const summary = writesSummary ? summaryUpdate(written, headSha, final) : undefined;
  if (summary !== undefined) writeJson("pr_summary.json", summary);

  // What the workflow posts the commit status from — context, state and line.
  // A file rather than a step output, for the same reason the payload above is
  // one: the step that posts cannot read this process, and the table all three
  // come from is tested here rather than restated in YAML. The only copy of the
  // context that is *not* read from here is the one the failure arm posts,
  // which by definition runs on a review that wrote no file.
  //
  // `verdict` is the row's key rather than its heading, so the workflow
  // selects on something no rewording moves. `fixRound` is the status that
  // records a round this review asked for (#297), present only where the
  // automatic fix (#102) starts one: the posting step posts it beside the
  // verdict, and the hand-off selects on its presence.
  writeJson("verdict.json", {
    context: VERDICT_CONTEXT,
    verdict: verdict.verdict,
    state: verdict.state,
    description: verdict.description,
    ...(verdict.startsFixRound === true ? { fixRound: FIX_ROUND_STATUS } : {}),
  });

  // And on a PRD PR, what the advance job says on the parent where this round
  // ends without approval and with no fix round starting (PRD #222): the
  // round, the stop and every finding still open, the ones raised here linking
  // the review the posting job is about to post. Written only in that case,
  // so the file's existence is the whole condition, as `follow_ups.md`'s is.
  //
  // Beside it, whatever the verdict, `park_posted.md`: the comment for a round
  // whose verdict was posted but whose posting job failed after it, which
  // parks the chain on any verdict. It names the verdict and the same
  // findings, since the review that raised them is on the pull request.
  if (round !== undefined) {
    const openFindings: ParkFinding[] = [
      ...stillOpen.map(carriedForPark),
      ...placed.map(
        (p): ParkFinding => ({
          title: p.finding.title,
          anchor: `${p.finding.path}:${p.finding.line}`,
          url: REVIEW_URL_SLOT,
        }),
      ),
    ];
    const parkReason = parkReasonOf(verdict);
    if (parkReason !== undefined) {
      writeText(
        "park.md",
        renderParkComment({
          round,
          prNumber: PR_NUMBER,
          reason: parkReason,
          detail: verdict.nextStep,
          findings: openFindings,
        }),
      );
    }
    writeText(
      "park_posted.md",
      renderParkComment({
        round,
        prNumber: PR_NUMBER,
        reason: "post failed",
        detail: `[The verdict](${REVIEW_URL_SLOT}) was *${verdict.heading}*.`,
        findings: openFindings,
        ...(runUrl === undefined ? {} : { runUrl }),
      }),
    );
  }

  // The progress table and status line again, now that this review knows
  // what it leaves open (#298). Off a PRD PR, the status line the posting job
  // writes into the note (#298), linking this review once it is posted.
  const open = stillOpen.length + placed.length;
  writeProgress(open);
  if (round === undefined) {
    writeText(
      "pr_status.md",
      statusBlock(
        renderPrStatus({ verdict: verdict.verdict, startsFixRound: verdict.startsFixRound === true, open, review: REVIEW_URL_SLOT }),
      ),
    );
  }

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
    writeText(
      "follow_ups.md",
      renderFollowUpsBlock(followUps, droppedFollowUps, movedFollowUps, followUpsCapUsed, followUpsCarried),
    );
  }

  console.log("Review complete.");
  console.log(
    `Verdict: ${verdict.verdict} (${countFixBeforeMerge(output, unanchored.length)} to fix before merge, checks ${ci}).`,
  );
  if (progress !== undefined) {
    console.log(
      `Fix round progress: ${progress.closed} of the ${progress.given} findings it was given closed by this review.`,
    );
  }
  const placements = (kind: string): number => placed.filter((p) => p.placement === kind).length;
  const missed = output.findings.filter(isPreviouslyMissed).length;
  console.log(
    `Findings: ${output.findings.length} produced: ${placements("line")} on a line, ${placements("file")} on a file, ${unanchored.length} moved to follow-ups for having no anchor in the diff; ${missed} in code an earlier review had already read.`,
  );
  // The ratings, for a human explaining why the record reads the way it does.
  // They change no outcome above (#113) — which is exactly why the log is the
  // only place this run says them out loud besides the body.
  const rated = (severity: Severity): number =>
    output.findings.filter((f) => f.severity === severity).length;
  console.log(`Severity: ${rated("high")} high, ${rated("medium")} medium, ${rated("low")} low.`);
  // Split by reason rather than counted together: "the code was fixed" and "a
  // maintainer said no" are the two ways a finding stops counting, and a human
  // reading this log to explain a verdict needs to know which one happened.
  const closedAs = (reason: ResolutionReason): number =>
    resolutions.filter((r) => r.reason === reason).length;
  console.log(
    `Earlier findings: ${context.carriedFindings.length} open before this review: ${closedAs("ADDRESSED")} verified fixed, ${closedAs("WONT_FIX")} closed on a maintainer's decline, ${stillOpen.length} still open.`,
  );
  console.log(`Settled by a maintainer and not raised again: ${context.settledFindings.length}.`);
  console.log(`Follow-ups: ${followUps.length} recorded, ${droppedFollowUps} dropped by the cap of ${followUpsCapUsed}.`);
  const ruledAs = (status: string): number =>
    criteriaRulings.results.filter((r) => r.status === status).length;
  console.log(
    `Acceptance criteria: ${criteriaRulings.results.length} checked: ${ruledAs("met")} met, ${ruledAs("changed")} changed with a reason, ${ruledAs("unmet")} unmet and raised as findings, ${ruledAs("unchecked")} not ruled on.`,
  );
  console.log(
    `Notes from the fix run: ${context.fixNotes.length} handed over, ${notes.promoted.length} recorded as follow-ups, ${notes.dropped.length} dropped with a reason.`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

/**
 * The follow-ups the earlier rounds on a PRD PR recorded (#247), which the
 * workflow carries into this review's record itself: so the review records
 * only what is new, and a second copy of one of these would be filed twice.
 */
function renderCarriedFollowUps(carried: readonly EarlierFollowUps[]): string {
  const lines = dedupeFollowUps(
    carried.flatMap((earlier) => [...earlier.moved, ...earlier.rest]),
    new Set(),
  ).map((entry) => `- **${entry.title.replace(/\s+/g, " ").trim()}** · \`${entry.location}\``);
  return [
    lines.length === 0 ? "(None yet.)" : lines.join("\n"),
    "",
    "**These are carried forward by the workflow**, into this review's record, and filed when this pull request merges. Do not record any of them again in `followUps`: record only what is new in this round.",
  ].join("\n");
}

/** An earlier finding still open, as a park comment lists it: linked to its thread. */
function carriedForPark(finding: CarriedFinding): ParkFinding {
  return {
    title: finding.title ?? finding.text,
    ...(finding.anchor === undefined ? {} : { anchor: finding.anchor }),
    ...(finding.url === undefined ? {} : { url: finding.url }),
  };
}

/**
 * Whether `path` is a file at the reviewed head — one `git cat-file` per path
 * asked about, which prints a single word rather than the tree, so no size of
 * repository can overflow what is read back. Argv, not a shell string: the
 * path is the model's, and a path may legally hold anything a shell parses.
 * Anything git cannot answer — no such path, a directory, an unreadable
 * object — is "not a file", which is the loud direction: it asks a human.
 */
function isFileAtHead(candidate: string): boolean {
  if (candidate === "") return false;
  try {
    return (
      execFileSync("git", ["cat-file", "-t", `HEAD:${candidate}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "blob"
    );
  } catch {
    return false;
  }
}
