import type { PullRequest } from "../engine/read.js";
import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import type { CommandIo } from "../shared/command-io.js";
import { workflowRunUrl } from "../shared/common.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { json, matching, object, readDirectory, text } from "../shared/hand-over.js";
import { isWorkflowBot, loopAccounts, type LoopAccounts } from "../shared/loop-accounts.js";
import {
  BLOCKED_LABEL,
  FIX_LABEL,
  FIX_ROUND_STATUS,
  PRD_BRANCH_PREFIX,
  REVIEW_LABEL,
  UPDATE_BRANCH_LABEL,
  VERDICT_CONTEXT,
} from "../shared/record.js";

/**
 * `review:conclude`: how every review run ends, success included (#408,
 * #419). It runs `always()`, after `review:publish`, and writes in the loop's
 * one order: every result posted, then `agent:review` off, then the label that
 * names the next step.
 *
 * - **A refusal** the review job decided and could not say: the note, then
 *   `agent:review` off, then `agent:blocked` where a maintainer has to act.
 * - **A run that did not finish**, the review job's or this job's: the error
 *   verdict, the failure comment, `agent:review` off, `agent:blocked`.
 * - **A review that was posted**: `agent:blocked` off, the ready mark, then
 *   `agent:review` off, and the hand-off: `agent:review` again where the head
 *   moved while the review ran, else `agent:fix` where it asked for a round.
 *
 * "A failed hand-off is not a failed review" used to be step order: the error
 * verdict sat above the hand-off, so a hand-off that failed after the review
 * was posted could not reach it. It is data now (#399). What ran and how it
 * ended are inputs, each step's outcome as the adapter saw it, and this works
 * out the ending from them, so a hand-off that fails is said as one and ends
 * red, and posts no error verdict over the one the review posted.
 *
 * Every write the loop can live without is tolerated, as the shell before it
 * tolerated each with `|| true` or a warning: a run that cannot comment still
 * takes its label off. The one throw is a fix round the review asked for that
 * does not start, which the job's result has to say, since the advance job
 * reads "everything posted" off it.
 */
export const conclude = async (
  inputs: InputValues<(typeof COMMANDS)["review:conclude"]["inputs"]>,
  io: CommandIo<(typeof COMMANDS)["review:conclude"]["outputs"]>,
): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  // The loop's accounts (#376), read and checked before the first write, like
  // what publish left: its URL where it posted, and its reason where it stopped.
  const accounts = loopAccounts(inputs.AGENT_LOOP_LOGINS);
  const published = readDirectory(COMMANDS["review:conclude"].inputs.PUBLISH_DIR, inputs.PUBLISH_DIR, {
    "published.json": json(object({ reviewUrl: LINK })),
    "failure_reason.txt": text,
  });
  const ending = endingOf(inputs, published["failure_reason.txt"]);
  const { workflow, loop } = io.writers(LIMITS);
  const say = { pr, workflow };

  if (ending.kind === "undecided") {
    // The review job was cancelled before its gate decided anything: nothing
    // is known to say, and the label is all there is to take off.
    await removeTrigger(say);
    io.outputs.writeJson("ended.json", { moved: false });
    return;
  }

  if (ending.kind === "refused") {
    // The pre-flight's refusal (#257). A closed pull request gets the note
    // alone (#253): there is nothing left for anyone to act on.
    await tolerated(`Could not post the refusal comment on PR #${pr}.`, () =>
      workflow.comment(pr, `**\`${REVIEW_LABEL}\` didn't run:** ${inputs.REFUSAL}`),
    );
    await removeTrigger(say);
    if (inputs.BLOCKED === "true") await tolerated(undefined, () => workflow.addLabel(pr, BLOCKED_LABEL));
    io.outputs.writeJson("ended.json", { moved: false });
    return;
  }

  if (ending.kind === "stopped") {
    await stopped(inputs, say, ending.comment);
    io.outputs.writeJson("ended.json", { moved: false });
    return;
  }

  // The review is posted. publish wrote its URL the moment it was, so a
  // finished publish without one is a publish this cannot read.
  const reviewUrl = published["published.json"]?.reviewUrl;
  if (reviewUrl === undefined) {
    throw new Error(
      "review:publish finished but handed over no `published.json`, so the posted review cannot be linked and nothing after it was done. Check the run's log, then add `agent:review` again.",
    );
  }

  // The label an earlier run left: a review that finished clears its block,
  // and one that failed adds it straight back.
  await tolerated(undefined, () => workflow.removeLabel(pr, BLOCKED_LABEL));
  await markReady(inputs, pr, loop);
  await removeTrigger(say);

  const live = await readLive(io, pr);
  const moved = await askAgainIfMoved(inputs, say, loop, live);
  // Before the hand-off, which may stop this: the advance job reads both
  // either way, and a round that did not start still has a posted review.
  io.outputs.writeJson("ended.json", { moved, reviewUrl });
  if (moved) return;

  if (inputs.VERDICT === "changes recommended" && inputs.FIX_ROUND === "true") {
    await startFixRound(inputs, io, { pr, loop, live, reviewUrl, accounts });
  }
};

/**
 * How the run ended, from what the adapter reported: the review job's result
 * and outputs, and the outcome of each of this job's steps that runs before
 * this one. `comment` is the failure comment's body, where it stopped.
 */
type Ending =
  | { readonly kind: "undecided" }
  | { readonly kind: "refused" }
  | { readonly kind: "stopped"; readonly comment: string }
  | { readonly kind: "posted" };

type Inputs = InputValues<(typeof COMMANDS)["review:conclude"]["inputs"]>;

const endingOf = (inputs: Inputs, publishReason: string | undefined): Ending => {
  if (inputs.PROCEED === "false") return { kind: "refused" };
  const runUrl = workflowRunUrl(inputs) ?? "";
  const stoppedWith = (reason: string): Ending => ({ kind: "stopped", comment: stoppedComment(reason, runUrl) });
  // A gate that failed before it decided (#420), as a package that would not
  // install does, is a run that stopped, said with what reason it gave and
  // with no verdict, since no commit was settled. Only a cancel that early
  // has nothing to say.
  if (inputs.PROCEED !== "true") {
    return inputs.REVIEW_RESULT === "failure" ? stoppedWith(inputs.FAILURE_REASON === "" ? NO_REASON : inputs.FAILURE_REASON) : { kind: "undecided" };
  }

  if (inputs.REVIEW_RESULT === "cancelled") {
    return stoppedWith(
      inputs.TIMED_OUT === "true"
        ? `It timed out after ${inputs.TIMEOUT_MINUTES} minutes. The repository variable \`AGENT_REVIEW_TIMEOUT_MINUTES\` raises the review's own time, which its CI wait is added to.`
        : CANCELLED,
    );
  }
  if (inputs.REVIEW_RESULT !== "success") {
    // A variable the review refused before it reviewed anything is the other
    // pattern (#253): it didn't run, and the sentence says what to do. Still
    // `agent:blocked`, since the maintainer has to fix it.
    if (inputs.REFUSAL_REASON !== "") return { kind: "stopped", comment: `**\`${REVIEW_LABEL}\` didn't run:** ${inputs.REFUSAL_REASON}\n` };
    return stoppedWith(inputs.FAILURE_REASON === "" ? NO_REASON : inputs.FAILURE_REASON);
  }

  // The review finished; what stopped is the first of this job's steps that
  // did not succeed. Cancelled is not failed (#220), and a step a cancel
  // skipped did not fail either. The mint wrote its reason where only a step
  // in its own job could read it, so the sentence is said here, word for
  // word as `.github/actions/loop-token` writes it, and a test holds the two
  // equal.
  const steps: readonly (readonly [string, string | undefined])[] = [
    [inputs.MINT_OUTCOME, MINT_FAILED],
    [inputs.DOWNLOAD_OUTCOME, DOWNLOAD_FAILED],
    [inputs.PUBLISH_OUTCOME, publishReason?.trim() || NO_REASON],
  ];
  for (const [outcome, reason] of steps) {
    if (outcome === "success") continue;
    return stoppedWith(outcome === "failure" && reason !== undefined ? reason : CANCELLED);
  }
  return { kind: "posted" };
};

const CANCELLED = "It was cancelled before it finished, by hand or by GitHub.";
const NO_REASON = "It stopped without giving a reason. The workflow run's log has the details.";
export const MINT_FAILED =
  "Couldn't mint a token for the loop's GitHub App, so nothing was written with it. Check that `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` belong to the same App, and that the App is installed on this repository.";
const DOWNLOAD_FAILED =
  "The review finished, but what it wrote for posting could not be fetched from its job, so nothing was posted.";

/**
 * One pattern for every run that stopped (#253): the reason as a sentence,
 * starting with a capital and ending in a full stop, then the run and what to
 * do.
 */
const stoppedComment = (reason: string, runUrl: string): string => {
  const trimmed = reason.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const sentence = /[.!?]$/.test(capital) ? capital : `${capital}.`;
  return `**\`${REVIEW_LABEL}\` stopped:** ${sentence}\n\n[Workflow run](${runUrl}) · To try again, add \`${REVIEW_LABEL}\`.\n`;
};

interface Say {
  readonly pr: number;
  readonly workflow: Writer;
}

/**
 * A run that did not finish, said where the verdict goes and on the pull
 * request (#220, #257). The error verdict first: a status is per commit and
 * per context, so a review that died half way reads from the outside exactly
 * like one that recommended approval until something replaces it. Then the
 * comment, then this run's own label off, then `agent:blocked` (#236).
 */
const stopped = async (inputs: Inputs, { pr, workflow }: Say, comment: string): Promise<void> => {
  const sha = inputs.REVIEWED_SHA;
  if (sha === "") {
    console.log("::warning::The review job named no reviewed commit, so no error verdict was posted.");
  } else {
    const runUrl = workflowRunUrl(inputs);
    await tolerated(
      `Could not post the failed \`${VERDICT_CONTEXT}\` verdict for ${sha}. The failure comment on the pull request is the only record of this run.`,
      () =>
        workflow.setCommitStatus({
          sha,
          context: VERDICT_CONTEXT,
          state: "error",
          description: "The review run did not finish, so there's no verdict. Check the run, then re-add agent:review.",
          ...(runUrl === undefined ? {} : { targetUrl: runUrl }),
        }),
    );
  }
  await tolerated(`Could not post the failure comment on PR #${pr}.`, () => workflow.comment(pr, comment));
  await removeTrigger({ pr, workflow });
  await tolerated(undefined, () => workflow.addLabel(pr, BLOCKED_LABEL));
};

/**
 * The trigger label comes off however the run ends (#236), after every result
 * and before every hand-off (#257): `fix` and `update-branch` wait while it is
 * on, so it coming off is what tells them the review is posted.
 */
const removeTrigger = ({ pr, workflow }: Say): Promise<void> => tolerated(undefined, () => workflow.removeLabel(pr, REVIEW_LABEL));

/**
 * Ready for review, on a posted review. Draft means "the automated pipeline
 * has not finished", so the human's turn begins here and not before.
 *
 * - **Not where a fix round is about to start** (#102): the next thing to
 *   happen is another agent run. Where the hand-off does not start the round
 *   it should have, it marks the pull request ready itself.
 * - **A PRD PR stays a draft through every slice round** (PRD #222): only
 *   the final review's approval marks it.
 *
 * With the loop's token: the workflow token cannot mark a draft ready even
 * with `pull-requests: write` (docs/ADOPTING.md §1). A warning, never a
 * failure: a pull request stuck in draft is not worth failing a review over,
 * and a warning keeps it visible where `|| true` did not.
 */
const markReady = async (inputs: Inputs, pr: number, loop: Writer): Promise<void> => {
  if (inputs.FIX_ROUND === "true") return;
  if (inputs.BRANCH.startsWith(PRD_BRANCH_PREFIX) && !(inputs.ROUND === "final" && inputs.VERDICT === "approval recommended")) return;
  await tolerated(
    `Could not mark PR #${pr} ready for review. If neither the loop's App nor AGENT_PAT is set this is expected: GITHUB_TOKEN cannot do it. Mark it ready by hand.`,
    () => loop.markReadyForReview(pr),
  );
};

/** The pull request as it is now, or `undefined` where it cannot be read, which each arm below says in its own words. */
const readLive = async (io: CommandIo<(typeof COMMANDS)["review:conclude"]["outputs"]>, pr: number): Promise<PullRequest | undefined> => {
  try {
    return await io.github.pullRequest(pr);
  } catch (error) {
    console.log(`::warning::Could not read PR #${pr} after the review was posted: ${describe(error)}`);
    return undefined;
  }
};

/** The labels a run queued in this pull request's concurrency group carries. */
const TRIGGERS = [REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL];

/**
 * **A request made while this run worked is not lost.** Adding `agent:review`
 * then fired nothing, since it was already on. So where the head moved on from
 * the commit this run reviewed, it asks for its own step again, with the
 * loop's token, since a label added with the workflow token starts nothing.
 *
 * **Not while another trigger label is on**: that label is a run queued in the
 * group, whose waiting slot holds one run, and a request now would cancel it
 * while pending and leave its label on with nothing behind it.
 *
 * **Whichever it does, it says the head moved**, and the fix round and the
 * advance stand down on it: this verdict is about a commit the pull request
 * has left. Never a cycle: nothing in the loop pushes while a review runs.
 */
const askAgainIfMoved = async (
  inputs: Inputs,
  { pr, workflow }: Say,
  loop: Writer,
  live: PullRequest | undefined,
): Promise<boolean> => {
  const left = inputs.REVIEWED_SHA;
  if (live === undefined || left === "" || live.state !== "open" || live.headSha === left) return false;
  const head = live.headSha;
  const busy = live.labels.filter((label) => TRIGGERS.includes(label)).join(",");
  if (busy !== "") {
    console.log(
      `::notice::PR #${pr} moved on to ${head} while this run reviewed ${left}, but it carries ${busy}, so ${REVIEW_LABEL} was not asked for again: that run is queued, and a new one would cancel it and leave its label on with no run behind it. Add ${REVIEW_LABEL} by hand once ${busy} is off, if the new head still needs it.`,
    );
    return true;
  }
  if (inputs.LOOP_TOKEN === "" || (inputs.LOOP_TOKEN_SOURCE !== "app" && inputs.LOOP_TOKEN_SOURCE !== "pat")) {
    console.log(
      `::warning::PR #${pr} moved on to ${head} while this run reviewed ${left}, but neither the loop's App nor AGENT_PAT is set, so ${REVIEW_LABEL} was not asked for again: a label added with GITHUB_TOKEN starts nothing. Add ${REVIEW_LABEL} by hand to review the new head.`,
    );
    await tolerated("…and that could not be said on the pull request either.", () =>
      workflow.comment(
        pr,
        `This PR moved on to \`${head}\` while its review of \`${left}\` ran. No review of the new head will start on its own: neither the loop's App nor \`AGENT_PAT\` is set, and a label added with \`GITHUB_TOKEN\` starts nothing. Add \`${REVIEW_LABEL}\` by hand to review it.`,
      ),
    );
    return true;
  }
  await tolerated(
    `PR #${pr} moved on to ${head} while this run reviewed ${left}, and ${REVIEW_LABEL} could not be added again. Add it by hand to review the new head.`,
    () => loop.addLabel(pr, REVIEW_LABEL),
  );
  return true;
};

/**
 * The automatic fix round (#102, #201, #297): `agent:fix`, added with the
 * loop's token, since one added with the workflow token fires nothing.
 * Whether a round starts was settled before the review, by the budget, and
 * the review asked for one only where that said it would; so the budget is
 * restated nowhere here.
 *
 * **Decided from live state** (#201): nothing is added where `agent:fix` is
 * already on, or where a newer verdict than this review's stands on the head,
 * by the review URL the status links. A head that moved is not a reason on its
 * own (#240): a clean `update-branch` copies this verdict on to the new head.
 *
 * **No record, no round** (#297): the `agent-fix-round` status publish posted
 * beside the verdict is what the budget counts, so a round without it is one
 * nothing bounds.
 *
 * **Say only what will happen.** The review left the pull request a draft for
 * this round, so every arm that does not start it when it should says so on
 * the pull request, marks it ready (off a PRD PR, which stays a draft until
 * its final review), and ends red.
 */
const startFixRound = async (
  inputs: Inputs,
  io: CommandIo<(typeof COMMANDS)["review:conclude"]["outputs"]>,
  {
    pr,
    loop,
    live,
    reviewUrl,
    accounts,
  }: { pr: number; loop: Writer; live: PullRequest | undefined; reviewUrl: string; accounts: LoopAccounts },
): Promise<void> => {
  const noRound = async (why: string): Promise<never> => {
    await tolerated("…and that could not be said on the pull request either.", () =>
      loop.comment(pr, `No automatic fix round started: ${why}. Add \`${FIX_LABEL}\` to start one by hand.`),
    );
    if (!inputs.BRANCH.startsWith(PRD_BRANCH_PREFIX)) {
      await tolerated(`Could not mark PR #${pr} ready for review either. Mark it ready by hand.`, () => loop.markReadyForReview(pr));
    }
    throw new Error(`No fix round started on PR #${pr}: ${why}.`);
  };

  if (live === undefined) return noRound("its labels could not be read, so whether a round was already starting could not be told");
  if (live.labels.includes(FIX_LABEL)) {
    console.log(`PR #${pr} already carries ${FIX_LABEL}, so a fix round is starting anyway. Adding nothing.`);
    return;
  }

  const head = live.headSha;
  const where = `the head commit \`${head}\`${head === inputs.REVIEWED_SHA ? "" : `, which moved on from the reviewed \`${inputs.REVIEWED_SHA}\``}`;
  // Read with the workflow token (#345): the App `init` registers holds no
  // `statuses` scope, and the loop's token is kept for the label. The loop's
  // are those posted by one of its accounts, in a creator's REST spelling.
  let statuses;
  try {
    statuses = (await io.github.commitStatuses(head)).filter((status) => isWorkflowBot(status.creator, accounts));
  } catch {
    return noRound("the verdicts on its head could not be read, so whether a newer one stands could not be told");
  }
  // Newest first, which is the order the endpoint documents.
  const newest = statuses.find((status) => status.context === VERDICT_CONTEXT);
  if (newest === undefined) return noRound(`the verdict that asked for it is not on ${where}`);
  if ((newest.targetUrl ?? "") !== reviewUrl) {
    console.log(`A newer verdict stands on ${head} than the review that asked for this round. Adding nothing.`);
    return;
  }
  if (!statuses.some((status) => status.context === FIX_ROUND_STATUS.context && status.targetUrl === reviewUrl)) {
    return noRound(
      `the \`${FIX_ROUND_STATUS.context}\` status that counts it against the fix-round budget is not on ${where}, and a round the budget cannot see is one nothing bounds`,
    );
  }

  // Removed first, as every trigger label the loop adds (#236): an add on a
  // label that is somehow still there fires nothing.
  await tolerated(undefined, () => loop.removeLabel(pr, FIX_LABEL));
  try {
    await loop.addLabel(pr, FIX_LABEL);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    return noRound(`adding \`${FIX_LABEL}\` failed, and GitHub's reply is in the workflow run's log`);
  }
  console.log(`Added ${FIX_LABEL} to PR #${pr}: an automatic fix round starts.`);
};

/**
 * A write the loop can live without: a failure is said as `warning`, where
 * there is one, and stays in the write log as a failure its last line does not
 * name. Anything but a failed write, a limit reached included, still stops.
 */
const tolerated = async (warning: string | undefined, write: () => Promise<unknown>): Promise<void> => {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    if (warning !== undefined) console.log(`::warning::${warning}`);
  }
};

/**
 * What conclude may write, and how many of each (ADR 0005): three removals
 * (`agent:blocked`, `agent:review` and `agent:fix` before it is added), one
 * label added (`agent:blocked`, `agent:review` or `agent:fix`, never two),
 * one comment, one ready mark and one status, the error verdict.
 */
const LIMITS: Limits = { removeLabel: 3, addLabel: 1, comment: 1, markReadyForReview: 1, setCommitStatus: 1 };

const LINK = matching(/https?:\/\/[^\s<>()]+/, "a link");

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};
