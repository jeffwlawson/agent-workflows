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
import { applyNoteRulings, renderNotesForReview } from "../shared/fix-notes.js";
import { describeUnreadable } from "../shared/pr-feedback.js";
import { fetchPrdContext, type PrdContext } from "../shared/prd-context.js";
import { currentSummary, summaryDue, summaryUpdate } from "../shared/pr-summary.js";
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
  deriveVerdict,
  recordFollowUps,
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
  type ResolutionReason,
} from "../shared/review-verification.js";
import { runWithExtraction } from "../shared/run-with-extraction.js";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");
const BASE_REF = required("BASE_REF");

/**
 * The slice this pull request builds, when its head is a slice branch (#175):
 * `agent/slice-<parent>-<sub>-<slug>`, the name `implement-prd` gives it. Its
 * base is the PRD branch, which holds the slices merged before it.
 */
const SLICE_MATCH = /^agent\/slice-(\d+)-(\d+)-/.exec(BRANCH);
const slice =
  SLICE_MATCH === null ? undefined : { prd: SLICE_MATCH[1] ?? "", subIssue: SLICE_MATCH[2] ?? "" };

/**
 * The PRD this pull request delivers, when its head is a PRD branch (#179):
 * `agent/prd-<parent>-<slug>`, the name `implement-prd` gives it. A PRD PR's
 * review is the chain's **integration review** — asked for only when the chain
 * holds more than one slice; a one-slice PRD's PRD PR is marked ready without
 * one.
 */
const PRD_MATCH = /^agent\/prd-(\d+)-/.exec(BRANCH);
const prdParent = PRD_MATCH?.[1];

const unreadable = (what: string): string =>
  `- ${what}: **could not be read**. Do not assume there are none: read the PRD branch's history ` +
  "and the slices table in this pull request's body, and review as though there were.";

/**
 * The integration review's brief. Everything on this pull request was reviewed
 * on a slice PR except the two things listed here, so those are reviewed in
 * full and the rest only for what no slice round could see.
 */
const integrationReview = (prd: PrdContext): string => {
  const slicePrs =
    prd.slicePrs === undefined
      ? unreadable("The slice PRs it holds")
      : prd.slicePrs.length === 0
        ? "- Slice PRs it holds: none."
        : `- Slice PRs it holds, in merge order: ${prd.slicePrs
            .map((pr) => `#${pr.number}${pr.subIssue === undefined ? "" : ` (sub-issue #${pr.subIssue})`}`)
            .join(", ")}. Each had a review round of its own.`;
  const preUpgrade =
    prd.preUpgrade === undefined
      ? unreadable("Slices built before slice PRs")
      : prd.preUpgrade.length === 0
        ? "- Slices built before slice PRs: none."
        : [
            "- **Slices built before slice PRs**, which had **no review of their own**. Review each one's " +
              "diff **in full**, on the same bar as an ordinary pull request:",
            ...prd.preUpgrade.map(
              (slice) =>
                `  - sub-issue #${slice.subIssue}: ${
                  slice.commits.length === 0
                    ? `no commit on this branch names \`(#${slice.subIssue})\`; find its work in the branch's history`
                    : `commit${slice.commits.length === 1 ? "" : "s"} ${slice.commits.join(", ")}`
                }`,
            ),
          ].join("\n");
  const merges =
    prd.resolvedMerges === undefined
      ? unreadable("Merge commits whose conflicts an agent resolved")
      : prd.resolvedMerges.length === 0
        ? "- Merge commits whose conflicts an agent resolved: none."
        : `- **Merge commits whose conflicts an agent resolved** while the chain was building, and nothing ` +
          `has reviewed since: ${prd.resolvedMerges.join(", ")}. Review each **resolution** (what the ` +
          "merge commit chose where the two sides conflicted) in full.";

  return [
    `This is a **PRD PR**: the PRD branch \`${BRANCH}\` into \`${BASE_REF}\`, delivering PRD ` +
      `#${prd.parent}, which the linked issue above describes. It is the one pull request of the chain a ` +
      "human merges. Its slices were each built and reviewed on a **slice PR** of their own, merged into " +
      "the PRD branch when that slice's review round ended. This review is the **integration review**.",
    [slicePrs, preUpgrade, merges].join("\n"),
    "Review the slices built before slice PRs and the agent-resolved merges above in full. " +
      "**Everything else, look at only for what spans slices**: the problems no slice review could see, " +
      "because each saw one slice:",
    [
      "- **contracts between slices**: one slice calling, reading or configuring what another wrote, " +
        "where the two do not agree;",
      "- **duplication**: two slices each building the same thing their own way;",
      "- **dead scaffolding**: something one slice left in place for a later one that the later slice " +
        "never used, or replaced beside it.",
    ].join("\n"),
    "A problem inside one slice that its slice review could have seen is **not** this review's: one no " +
      "slice round raised goes to `followUps` on the bar that list states. " +
      "And **never re-raise a slice's leftover findings**, not as a finding and not as a follow-up. " +
      "A slice round that ended with open findings left them on its slice PR, and the slices table in " +
      "this pull request's body links them: they are a pointer for the human who merges, not work for " +
      "this review or its fix.",
    "Your verdict is this pull request's own, and it means **the slices fit together**, not a roll-up " +
      "of the slice verdicts. Every finding anchors on a line the diff below shows; the diff is the whole " +
      "PRD against its base.",
  ].join("\n\n");
};

/**
 * What kind of pull request the reviewer is reading. An ordinary one is the
 * whole change; a slice PR is one slice of a PRD, reviewed on its own round,
 * over code the earlier slices' rounds already reviewed; a PRD PR is every
 * slice together, reviewed once more for how they fit.
 */
const pullRequestKind = (prd: PrdContext | undefined): string =>
  prd !== undefined ? integrationReview(prd) : sliceOrOrdinary();

const sliceOrOrdinary = (): string =>
  slice === undefined
    ? `An ordinary pull request into \`${BASE_REF}\`. Review the whole change.`
    : [
        `This is a **slice PR**: the slice of PRD #${slice.prd} that sub-issue #${slice.subIssue} ` +
          `describes, opened against the PRD branch \`${BASE_REF}\`. The linked issue above is that ` +
          "sub-issue, and it is what this slice has to do; the PRD is the whole it is a part of.",
        `The PRD branch holds every slice of the PRD merged before this one, and each of those had a ` +
          "review round of its own on its own slice PR. Treat them as **settled context**: read them to " +
          "understand what this slice builds on, and do not review them again. A problem you find in " +
          "one is outside this pull request's scope, and goes to `followUps` on the bar that list states.",
        `The diff below is this pull request's own three-dot diff against \`${BASE_REF}\` (this slice ` +
          "alone), and every finding anchors on a line it shows. Later slices are not written yet, so " +
          "work the PRD gives to a later slice is not missing from this one.",
      ].join("\n\n");

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
 * `agent:fix` selects on the key this decides, so the step's one answer is
 * taken rather than a second one worked out.
 *
 * Absent is off: a run that could not say must not claim a fix round started.
 */
const willAutoFix = (): boolean => process.env["AUTO_FIX"] === "true";

/**
 * The budget and the rounds spent against it, where the same step could count
 * them, for the line a spent budget gets. Anything unreadable is left out, and
 * the verdict falls back to the plain line that asks for the label.
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

try {
  const context = fetchPullRequestContext(PR_NUMBER, slice?.subIssue);
  const prd =
    prdParent === undefined ? undefined : fetchPrdContext(prdParent, BRANCH, BASE_REF, PR_NUMBER);

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
  const headSha = sh("git rev-parse HEAD").trim();
  const writesSummary = summaryDue(context.prBody, headSha);
  console.log(
    `Title and summary: ${writesSummary ? "rewritten, since something was pushed after the summary was last written" : "left as they are, since nothing was pushed after the summary was last written"}.`,
  );

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
      PULL_REQUEST_KIND: pullRequestKind(prd),
      ISSUE_NUMBER: context.issueNumber || "(none)",
      ISSUE_TITLE: context.issueTitle || "(no linked issue)",
      LINKED_ISSUE: context.linkedIssue,
      DISCUSSION: context.discussion || "(no collaborator comments)",
      CI_STATUS: readCiStatus(),
      HISTORY: describeHistory(history),
      OPEN_FINDINGS: renderCarriedFindings(context.carriedFindings),
      SETTLED_FINDINGS: renderSettledFindings(context.settledFindings),
      FIX_NOTES: renderNotesForReview(context.fixNotes),
      PR_DIFF: context.diff,
      CURRENT_SUMMARY: currentSummary(context.prBody),
      SUMMARY_RULE: writesSummary
        ? "**This review writes them.** Something was pushed since the summary was last written, so the workflow replaces the title and the summary block with yours."
        : "**This review leaves them as they are.** Nothing was pushed since the summary was last written, so the workflow writes neither; omit both fields.",
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
      ? result.output
      : {
          ...result.output,
          needsYou: [result.output.needsYou, pathErrorReason].filter(Boolean).join("\n\n"),
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
  } = recordFollowUps(unanchored, [...notes.promoted, ...output.followUps], unplaceable);

  // The verdict, derived from the review and the checks rather than written by
  // the agent (#96). Its heading and next-step line open the body, so the
  // outcome is the first thing a reader sees and the same words the commit
  // status carries — one statement in two places, not two that can disagree.
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
    base: BASE_REF,
    ...(slice === undefined ? {} : { sliceParent: slice.prd }),
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
    droppedNotes: notes.dropped,
    runUrl: workflowRunUrl(),
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
  const summary = writesSummary ? summaryUpdate(output, headSha) : undefined;
  if (summary !== undefined) writeJson("pr_summary.json", summary);

  // What the workflow posts the commit status from — context, state and line.
  // A file rather than a step output, for the same reason the payload above is
  // one: the step that posts cannot read this process, and the table all three
  // come from is tested here rather than restated in YAML. The only copy of the
  // context that is *not* read from here is the one the failure arm posts,
  // which by definition runs on a review that wrote no file.
  //
  // `verdict` is the row's key rather than its heading, because the two
  // *changes recommended* rows share a heading and a reader of this file has to
  // tell them apart: the automatic fix (#102) fires on exactly one of them,
  // and the workflow selects on the key this writes.
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
    writeText(
      "follow_ups.md",
      renderFollowUpsBlock(followUps, droppedFollowUps, movedFollowUps),
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
  console.log(`Follow-ups: ${followUps.length} recorded, ${droppedFollowUps} dropped by the cap.`);
  console.log(
    `Notes from the fix run: ${context.fixNotes.length} handed over, ${notes.promoted.length} recorded as follow-ups, ${notes.dropped.length} dropped with a reason.`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
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
