import { isServerError } from "../engine/github.js";
import { dropBlock, spliceBlock } from "../engine/splice.js";
import { LimitReached, WriteFailed, type Limits, type ReviewThread, type Writer } from "../engine/writer.js";
import type { CommandIo } from "../shared/command-io.js";
import { workflowRunUrl } from "../shared/common.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { readDirectory } from "../shared/hand-over.js";
import { renderMergeDanger } from "../shared/merge-danger.js";
import { renderPrdSummary } from "../shared/prd-round.js";
import { renderPrStatus, spliceStatus, statusBlock } from "../shared/progress-list.js";
import { renderRedTestsBlock, withEvidence } from "../shared/red-check.js";
import {
  DRAFT_NOTE_END,
  DRAFT_NOTE_START,
  FIX_ROUND_STATUS,
  FOLLOW_UPS_LABEL,
  PRD_BRANCH_PREFIX,
  SUMMARY_END,
  SUMMARY_START,
  VERDICT_CONTEXT,
} from "../shared/record.js";
import { reviewThreads } from "../shared/review-findings.js";
import { renderReviewPost, verdictRow, type FollowUp, type ReviewBodyParts } from "../shared/review-output.js";
import { closingReply } from "../shared/review-verification.js";
import { roundHeader } from "../shared/round-header.js";
import { handOverParsers, MAX_RESOLUTIONS, type PrSummary, type VerdictHandOver } from "./hand-over.js";
import { summaryBlock } from "./pr-summary.js";
import { unreadableHistoryNote } from "./review-round.js";

/**
 * `review:publish`: the posting job's first command (ADR 0003, ADR 0005). It
 * resolves the threads this review closed and posts the review, in that order
 * and with the text the loop has always posted, and marks the pull request as
 * carrying follow-ups where the review recorded any. Then it writes the
 * pull request's title and summary block, its status line, and the verdict as
 * a commit status. What the posting job does after that (ready for review,
 * the trigger label and the hand-off) is `review:conclude`'s, which reads
 * the review's URL from `published.json`.
 *
 * **It writes every final string itself** (ADR 0007). The runner hands over
 * decisions and the agent's raw text in five files (`review/hand-over.ts`),
 * and every marker, badge, group, closing reply, summary section, status line
 * and status is composed here, from text the readers give out cleaned and
 * from publish's own constants. So the agent's runner, which can write those
 * files, cannot write a loop string into the record, name a status context,
 * or start a fix round by adding a field: it can claim a verdict and a fix
 * round, each one of a fixed set, and what is posted for them is publish's.
 *
 * **Everything it is aimed at, it found itself.** The pull request's node id is
 * read from the pull request the declared number names, and every thread id
 * the hand-over names has to be a review thread on it. The review is posted on
 * `REVIEWED_SHA`, which the review job recorded before the agent ran (ADR
 * 0006), and no hand-over file names a commit. Every file is read and checked
 * before the first write, and so is the body's size, so a hand-over that is
 * wrong anywhere writes nothing.
 *
 * Throws to stop, in a sentence a human can act on, which the CLI turns into
 * `fail()` and the posting job into the failure comment. A write the loop can
 * live without is caught here, on purpose, said as a warning, and stays in the
 * write log as a failure its last line does not name.
 */
export const publish = async (
  inputs: InputValues<(typeof COMMANDS)["review:publish"]["inputs"]>,
  io: CommandIo<(typeof COMMANDS)["review:publish"]["outputs"]>,
): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const reviewed = commit(inputs.REVIEWED_SHA);

  // What the hand-over is checked against, read before it is: the pull
  // request the number names, and the threads on it.
  const pullRequest = await read(`PR #${pr}`, () => io.github.pullRequest(pr));
  const threadIds = await read(`PR #${pr}'s review threads`, () => io.github.reviewThreadIds(pr));
  const handOver = readDirectory(
    COMMANDS["review:publish"].inputs.REVIEW_DIR,
    inputs.REVIEW_DIR,
    handOverParsers({ pr, threads: threadIds }),
  );
  const findings = handOver["findings.json"];
  const resolutions = handOver["thread_resolutions.json"];
  const { header, historyUnreadable, redTests, ...body } = handOver["review_body.json"];
  const verdict = handOver["verdict.json"];
  // Two files that name the verdict, and they have to name the same one: the
  // body says it, and the status posts it.
  if (verdict.verdict !== body.verdict) {
    throw new Error(
      `review's verdict.json names the verdict ${JSON.stringify(verdict.verdict)}, and its review_body.json ${JSON.stringify(body.verdict)}, so nothing was posted.`,
    );
  }

  const runUrl = workflowRunUrl(inputs);
  const parts: Omit<ReviewBodyParts, "closed"> = {
    ...body,
    ...(header === undefined ? {} : { header: roundHeader(header.scope, "review", header.number) }),
    ...(historyUnreadable === undefined
      ? {}
      : { roundNote: unreadableHistoryNote({ afterFixRound: true, unreviewedCommits: false, unreadable: historyUnreadable }) }),
    ...(redTests === undefined ? {} : { redTestsBlock: renderRedTestsBlock(redTests) }),
    ...(runUrl === undefined ? {} : { runUrl }),
    log: (line) => console.log(line),
  };
  const threads: readonly ReviewThread[] = reviewThreads(findings);
  // The body as it reads where every closure holds, rendered now so that one
  // which cannot be made to fit stops the command before it resolves a thread.
  renderReviewPost({ ...parts, closed: threadIds, log: undefined });

  const { workflow } = io.writers(LIMITS);

  // Step 1: the earlier findings this review ruled on (#111, and #109
  // decision 1). The **reviewer** closes a finding and the fixer never does:
  // a fix run replies and resolves nothing, so nothing is marked done by the
  // run that claims to have done it. First, so the review posted next can say
  // what actually closed (#257).
  //
  // The reply goes first and the resolve only once it landed, which is the
  // writer's (`replyAndResolve`): GitHub exposes `resolutionReason` on no
  // field afterwards, so the reply is the only record of why a thread closed.
  // Unless the thread already carries that reply (`alreadyReplied`, #133),
  // where only the resolve is retried: without it every round would add
  // another `**Verified fixed.**`, which is how #130 collected nine.
  //
  // **A thread that will not close is tolerated**, on purpose: the next review
  // retries it and a human can close it, and the review lists it as still
  // open rather than resolved. So one bad thread never takes the rest of the
  // list, or the review, with it.
  const closed = new Set<string>();
  for (const resolution of resolutions) {
    try {
      await workflow.replyAndResolve({
        threadId: resolution.threadId,
        reply: resolution.alreadyReplied ? undefined : closingReply(resolution),
        reason: resolution.reason,
      });
      closed.add(resolution.threadId);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      // `partial` is a reply that landed and a resolve that did not; a thread
      // that already carried its reply had only the resolve to make.
      console.log(
        resolution.alreadyReplied || error.entry.outcome === "partial"
          ? `::warning::Could not resolve review thread ${resolution.threadId} (${resolution.reason}). Its reply is posted, the review lists it as still open, and the thread stays open until the next review retries it, which it does without replying again. GitHub's reply is in the write log.`
          : `::warning::Could not reply to review thread ${resolution.threadId}, so it is left open: a thread that closes with no reply loses the only record of why. The review lists it as still open.`,
      );
    }
  }

  // Step 2: the review and its new findings, in one call, its *Resolved since
  // last review* naming only the threads step 1 resolved (#257). The
  // mutation is the engine's; this hands it values.
  const post = renderReviewPost({ ...parts, closed });
  const unclosed = body.resolved.filter((entry) => entry.threadId !== undefined && !closed.has(entry.threadId)).length;
  if (unclosed > 0) {
    console.log(`::warning::${unclosed} thread(s) this review closed could not be resolved, so the review lists them as still open.`);
  }
  const url = await postReview(io, workflow, pr, {
    pullRequestId: pullRequest.nodeId,
    commitOID: reviewed,
    body: post.body,
    threads,
  });
  // What `review:conclude` reads after this, written the moment the review
  // is posted, so a later failure here still leaves it.
  io.outputs.writeJson("published.json", { reviewUrl: url });
  console.log(`Posted the review on ${reviewed}: ${url}`);

  // The marker for the filing half (#47): this review recorded out-of-scope
  // findings, and a human still has a say before they become issues, which
  // is removing the label. **Added only where follow-ups survive the body's
  // shedding**, so the label never points at an empty list, and never removed
  // here: removal is the human's opt-out, and a step that cleared it would race
  // the person it exists to serve.
  //
  // After the review, since the label points at a record in its body, and
  // tolerated: an adopter can be current on the pin without the label, and a
  // posted review is worth more than a marker.
  if (post.followUps.length > 0) {
    try {
      await workflow.addLabel(pr, FOLLOW_UPS_LABEL);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      console.log(
        `::warning::Could not add \`${FOLLOW_UPS_LABEL}\` to PR #${pr}. Its out-of-scope findings stay in the review body and nothing will file them. If the label does not exist in this repository, create it.`,
      );
    }
  }

  // Step 3: the title, and the summary block in the body (#218), where the
  // runner said this review rewrites them by writing `pr_summary.json` at all.
  const summary = handOver["pr_summary.json"];
  if (summary === undefined) {
    console.log("Nothing was pushed since the summary was last written, so the title and the summary are left as they are.");
  } else {
    await writeSummary(workflow, pr, reviewed, summary, body.followUps);
  }

  // Step 3b: off a PRD PR, the status line at the top of the body's note
  // (#298), as this review leaves the pull request: ready for a human,
  // fixing, or parked on one, linking the review just posted. A PRD PR's is
  // the advance job's, beside its progress table, since only that job knows
  // how the round ended.
  if (!inputs.BRANCH.startsWith(PRD_BRANCH_PREFIX)) await writeStatusLine(workflow, pr, verdict, url);

  // Step 4: the verdict, on the commit it is about.
  await postVerdict(workflow, reviewed, verdict, verdictRow(verdict.verdict, body.cause), url);
};

/**
 * The title and the summary block, in one edit against the body as it stands
 * now, not as the review read it. A review spends minutes waiting on CI, and
 * a maintainer's edit outside the block in that window has to survive: every
 * byte outside the markers is kept as it is, `Closes #N` and a PRD PR's own
 * blocks included, and the review's text goes between them. A body with no
 * block gets one appended; a body with half of one, or two, is not written at
 * all, since guessing which marker is the real one is guessing where a
 * maintainer's text ends. The title is written either way.
 *
 * The block's text is laid out here (ADR 0007): the agent's summary with the
 * Evidence (#355) and the Merge Danger (#356) under it, or on a PRD PR's
 * final review the PRD's (#247, #356), headed by the head it was written at,
 * `REVIEWED_SHA`. The final review also drops the frame's draft-only note
 * (#247), markers and all, where the body holds exactly one: every slice is
 * built, and a PRD PR marked ready carries nothing that says it is a draft.
 *
 * After the review, and tolerated: a posted review is worth more than its
 * description, and a warning says so.
 */
const writeSummary = async (
  workflow: Writer,
  pr: number,
  head: string,
  summary: PrSummary,
  followUps: readonly FollowUp[],
): Promise<void> => {
  const evidence = { ci: summary.ci, head, testSketches: summary.testSketches };
  const text = summary.final
    ? renderPrdSummary({
        outcome: summary.summary,
        danger: summary.danger,
        slices: summary.prd.criteria,
        followUps,
        ...(summary.prd.redTests === undefined ? {} : { redTests: { slices: summary.prd.redTests.slices } }),
        evidence,
      })
    : summary.summary === undefined
      ? undefined
      : `${withEvidence(summary.summary, summary.redCheck, evidence)}\n\n${renderMergeDanger(summary.danger, followUps)}`;
  const block = text === undefined ? undefined : summaryBlock(text, head, summary.final);

  let broken = false;
  const body = (live: string): string | undefined => {
    let written = live;
    if (block !== undefined) {
      const spliced = spliceBlock(live, { start: SUMMARY_START, end: SUMMARY_END }, block, "append");
      if (spliced === undefined) {
        broken = true;
        return undefined;
      }
      written = spliced;
    }
    return summary.final ? (dropBlock(written, { start: DRAFT_NOTE_START, end: DRAFT_NOTE_END }) ?? written) : written;
  };
  let done;
  try {
    done = await workflow.editPullRequest(pr, {
      ...(summary.title === undefined ? {} : { title: summary.title }),
      ...(block === undefined && !summary.final ? {} : { body }),
    });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::Could not write the title and summary of PR #${pr}, so both are left as they are. GitHub's reply is in the write log; the review is posted.`);
    return;
  }
  if (broken) {
    console.log(
      `::warning::PR #${pr}'s body carries half a summary block, or two, so the summary was not written. Restore the missing marker, or delete the markers and the text between them, and the next review writes it again.`,
    );
  } else {
    console.log(done.outcome === "applied" ? `Wrote PR #${pr}'s title and summary.` : `PR #${pr}'s title and summary already say this.`);
  }
};

/**
 * The status line, replaced between its markers and nowhere else
 * (`spliceStatus`): a body with none, one opened before #298, is left as it
 * is, since the line belongs at the top of the note the opening run wrote,
 * and so is half a line, or two. Tolerated, for the summary's reason.
 */
const writeStatusLine = async (workflow: Writer, pr: number, verdict: VerdictHandOver, review: string): Promise<void> => {
  const line = statusBlock(renderPrStatus({ verdict: verdict.verdict, startsFixRound: verdict.fixRound, open: verdict.open, review }));
  try {
    const done = await workflow.editPullRequest(pr, { body: (live) => spliceStatus(live, line) });
    console.log(
      done.outcome === "applied"
        ? `Wrote PR #${pr}'s status line.`
        : `PR #${pr}'s body has no status line, or half of one, or two, or it already says this, so none is written.`,
    );
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::Could not write PR #${pr}'s status line. GitHub's reply is in the write log; the review is posted.`);
  }
};

/**
 * The verdict, what a maintainer does next, as a commit status on the commit
 * it is about, linking the review.
 *
 * A commit status rather than a comment or a label, for the one property
 * neither of those has: it is attached to a **commit**. A new commit carries
 * no verdict until one is posted for it, so a stale "ready to merge" cannot
 * survive a push, and the status history is the only record of what earlier
 * rounds said. One context, so a later review of the same commit replaces its
 * own verdict and nothing else.
 *
 * The context is `VERDICT_CONTEXT`, and the state and the line are the
 * verdict's row: publish's own, chosen by the key and the cause the runner
 * handed over. So is the `agent-fix-round` status posted beside it where the
 * review asked for an automatic fix round (#297): `FIX_ROUND_STATUS`, the
 * record `review:gate` counts rounds by, linking the same
 * review. A claimed round still has to pass the hand-off's live guard, which
 * looks for this status on the head, and the budget, which counts it.
 *
 * Tolerated, as the summary is: a posted review is worth more than its
 * verdict. A caller short of `statuses: write` is refused before any job
 * starts (#146), so what lands here is GitHub refusing the status itself, and
 * a warning says so where silence would leave a loop posting no verdicts and
 * looking healthy.
 */
const postVerdict = async (
  workflow: Writer,
  sha: string,
  verdict: VerdictHandOver,
  row: { readonly state: "success" | "failure"; readonly description: string },
  review: string,
): Promise<void> => {
  try {
    await workflow.setCommitStatus({ sha, context: VERDICT_CONTEXT, state: row.state, description: row.description, targetUrl: review });
    console.log(`Posted the \`${VERDICT_CONTEXT}\` verdict, ${verdict.verdict}, on ${sha}.`);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(
      `::warning::Could not post the \`${VERDICT_CONTEXT}\` verdict for ${sha}. The review is posted; what is missing is the one line saying what to do about it. GitHub's reply is in the write log. It is not the caller's \`statuses:\` grant: a caller granting less than this job declares fails the run before any job starts, so a token that got this far holds the write (jeffwlawson/agent-workflows docs/ADOPTING.md §4); a 422 is the status itself being refused, which is ours to fix.`,
    );
  }
  if (!verdict.fixRound) return;
  try {
    await workflow.setCommitStatus({ sha, ...FIX_ROUND_STATUS, targetUrl: review });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(
      `::warning::Could not post the \`${FIX_ROUND_STATUS.context}\` status for ${sha}, which is what the fix-round budget counts, so the automatic fix round will not start. GitHub's reply is in the write log.`,
    );
  }
};

/**
 * What publish may write, and how many of each (ADR 0005): a reply and a
 * resolve per thread the hand-over can name, one review, one label, two edits
 * of the pull request (the title and summary, then the status line) and two
 * statuses (the verdict, and the fix round's). Anything else is refused and
 * stops the command.
 */
const LIMITS: Limits = { replyAndResolve: MAX_RESOLUTIONS, postReview: 1, addLabel: 1, editPullRequest: 2, setCommitStatus: 2 };

/** The sentence the failure comment shows where the review did not post: today's, word for word. */
const NOT_POSTED =
  "GitHub refused the review, so it was not posted. Its threads are not on the pull request and there is no verdict; the earlier threads this review closed were resolved where GitHub allowed it, and the log names any that were not.";

/**
 * Post the review, and return its URL.
 *
 * **A server error is not "not posted".** GitHub has answered a review with a
 * 500 and posted it all the same (#424: slice 5's review 2, reported unposted,
 * set `agent-review` to `error` and blocked the chain). So on a 5xx, or
 * GraphQL's "An internal error occurred", publish reads the pull request's
 * reviews back before it fails: one on the reviewed commit with exactly this
 * body is this run's, and publish goes on with its URL. None, and it fails as
 * it always has.
 */
const postReview = async (
  io: CommandIo<(typeof COMMANDS)["review:publish"]["outputs"]>,
  workflow: Writer,
  pr: number,
  variables: Parameters<Writer["postReview"]>[0],
): Promise<string> => {
  try {
    return (await workflow.postReview(variables)).url;
  } catch (error) {
    if (error instanceof LimitReached) throw error;
    if (!(error instanceof WriteFailed)) throw error;
    if (!isServerError(error.cause)) throw new Error(NOT_POSTED, { cause: error });
    console.log(`::warning::GitHub answered the review with a server error (${error.message}), so whether it was posted is read back.`);
    let reviews;
    try {
      reviews = await io.github.reviews(pr);
    } catch (readError) {
      throw new Error(
        `GitHub answered the review with a server error, and whether it was posted anyway could not be read back (${describe(readError)}). Look for it on the pull request before adding \`agent:review\` again; if it is there, the verdict and the steps after it were not posted.`,
        { cause: readError },
      );
    }
    const posted = reviews.findLast(
      (review) => review.commit === variables.commitOID && normalised(review.body) === normalised(variables.body),
    );
    if (posted === undefined) throw new Error(NOT_POSTED, { cause: error });
    console.log(`The review is on the pull request after all, at ${posted.url}; going on as if the post had answered.`);
    return posted.url;
  }
};

/** A body as GitHub may store it: line endings and the ends trimmed, and nothing else. */
const normalised = (body: string): string => body.replace(/\r\n/g, "\n").trim();

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A read publish cannot go on without, its failure said as a sentence: nothing has been written yet. */
const read = async <T>(what: string, request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    throw new Error(`Could not read ${what} from GitHub, so nothing was posted: ${describe(error)}`, { cause: error });
  }
};

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};

const commit = (value: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`REVIEWED_SHA is ${JSON.stringify(value)}, which is not a full commit id, so there is no commit to post the review on.`);
  }
  return value;
};
