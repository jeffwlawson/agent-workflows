import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import type { CommandIo } from "../shared/command-io.js";
import { workflowRunUrl } from "../shared/common.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { readDirectory } from "../shared/hand-over.js";
import { renderParkComment, type ParkInputs } from "../shared/prd-round.js";
import { progressAtRoundEnd, spliceProgressList, spliceStatus, type RoundEnding } from "../shared/progress-list.js";
import { IMPLEMENT_LABEL, REVIEW_LABEL } from "../shared/record.js";
import { verdictRow } from "../shared/review-output.js";
import { MINT_FAILED } from "./conclude.js";
import { PARK_PARSERS, type ParkHandOver, type ParkReview, type ProgressRead } from "./hand-over.js";

/**
 * `review:advance`: the PRD chain's **advance** (PRD #222, #423), and the one
 * place the chain moves on from or parks at after a review of a PRD PR. A PRD
 * is built as slices on one PRD branch and reviewed on one PRD PR, a **slice
 * round** per slice, and the next slice is built only after an approval. Every
 * way a round can end lands here, since on a PRD PR every fix run ends by
 * asking for a review: so this is the whole of it, and `fix` carries no copy.
 *
 * **At every ending** it first writes the PRD PR's progress table and status
 * line (#246, #298) for how the round ended. Then, by that ending:
 *
 * - a slice round's **approval**: `agent:implement` back on the parent, read
 *   off the head, `agent/prd-<parent>-…`, and the `implement-prd` run that
 *   starts builds the next slice, or finishes. That run's preflight reads the
 *   head's verdict again, so the label is never the gate;
 * - the **final review's approval**: nothing more. `review:conclude` marked
 *   the PRD PR ready, and the PRD is the maintainer's to merge;
 * - **a fix round started**: nothing more. The round has not ended; the fix
 *   run's re-review ends it, and comes back here;
 * - **the head moved** while the review ran: nothing at all. The review of the
 *   new head decides;
 * - **any other ending**, a slice round's or the final review's: the park
 *   comment on the parent, naming the round, why it stopped, the open findings
 *   with links, and the ways on. A parked chain says so where a maintainer
 *   watching it looks, rather than nowhere.
 *
 * The runner hands over data (ADR 0007): the round, the park reason, the open
 * findings and what the table is rendered from. Every string written here,
 * the comment, the table, the status line and their markers, is this
 * command's own. How the run ended is told it as inputs, the review job's
 * result and outputs and the posting job's, never read off which steps ran.
 *
 * Everything on the parent is written with the loop's token, the App's or
 * `AGENT_PAT`: the workflow token holds no issue scope there, and a label it
 * added would start nothing. Without either, or where the mint failed, what
 * would have gone on the parent is said on the PRD PR instead, with the
 * workflow token. It cannot cycle: it labels and comments on an issue, never a
 * pull request.
 */
export const advance = async (inputs: Inputs, io: CommandIo<(typeof COMMANDS)["review:advance"]["outputs"]>): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  // What the runner handed over, read and checked before the first write.
  // Either may be missing, where the review stopped before it wrote them, and
  // each use below says so in its own words.
  const handed = readDirectory(COMMANDS["review:advance"].inputs.PARK_DIR, inputs.PARK_DIR, PARK_PARSERS);
  const { workflow, loop } = io.writers(LIMITS);

  // The review of the new head decides, and its own advance follows it.
  if (inputs.MOVED === "true") {
    console.log(`PRD PR #${pr} moved on while its review ran, so the review of the new head decides. Nothing to do.`);
    return;
  }

  // The round ended where the review and its posting both finished: a verdict
  // that was never posted ends nothing on its own.
  const ended = inputs.REVIEW_RESULT === "success" && inputs.POSTING_RESULT === "success";
  const ending: RoundEnding =
    ended && inputs.VERDICT === "approval recommended"
      ? "approved"
      : ended && inputs.VERDICT === "changes recommended" && inputs.FIX_ROUND === "true"
        ? "running"
        : "parked";

  await writeProgress(inputs, { pr, workflow }, handed["progress.json"], ending);

  if (ending === "approved" && inputs.ROUND === "slice") await moveOn(inputs, { pr, workflow, loop });
  if (ending === "parked") await park(inputs, { pr, workflow, loop }, handed["park.json"], ended);
};

type Inputs = InputValues<(typeof COMMANDS)["review:advance"]["inputs"]>;

interface Writers {
  readonly pr: number;
  readonly workflow: Writer;
  readonly loop: Writer;
}

/**
 * The PRD PR's **progress table** and status line (#246, #298), rendered for
 * how this round ended: approved on an approval, fixing where the verdict
 * started a fix round, and parked on every other ending, a run that did not
 * finish included. First, so the table says where the chain is before
 * anything this starts reads it, and with the workflow token, so a mint that
 * failed cannot cost it.
 *
 * The posted review is what the table's review count and the status line
 * link; where none was posted, the pull request stands in for it.
 *
 * Spliced into the live body the way the review's summary is (#218): every
 * byte outside the markers is kept, a body with no table gets one appended,
 * and one with half a table, or two, is not written at all. A status line
 * that cannot be spliced is left as it stands while the table is written.
 *
 * Never stops the command: the table is a view of the chain, and the advance
 * or the park comment after it is the chain itself. A warning says so.
 */
const writeProgress = async (
  inputs: Inputs,
  { pr, workflow }: Pick<Writers, "pr" | "workflow">,
  handed: ProgressRead | undefined,
  ending: RoundEnding,
): Promise<void> => {
  if (handed === undefined) {
    console.log(`::warning::The review handed over no progress list, so PRD PR #${pr}'s is left as it stands.`);
    return;
  }
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = inputs;
  const prUrl = server && repo ? `${server}/${repo}/pull/${pr}` : undefined;
  const review = inputs.REVIEW_URL || (prUrl ?? "");
  const { progress, status } = progressAtRoundEnd(handed.branch, {
    ...(handed.rounds === undefined ? {} : { rounds: handed.rounds }),
    review,
    open: handed.open,
    prUrl,
  })[ending];
  let half = false;
  try {
    const edited = await workflow.editPullRequest(pr, {
      body: (live) => {
        const body = spliceProgressList(live, progress);
        if (body === undefined) {
          half = true;
          return undefined;
        }
        return spliceStatus(body, status) ?? body;
      },
    });
    if (half) {
      console.log(
        `::warning::PRD PR #${pr}'s body carries half a progress list, or two, so it was not written. Restore the missing marker, or delete the markers and the text between them, and the next ending of a round writes it again.`,
      );
    } else if (edited.outcome === "applied") {
      console.log(`Wrote PRD PR #${pr}'s progress list: the round ended ${ending}.`);
    }
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::Could not write PRD PR #${pr}'s progress list: ${error.message}`);
  }
};

/** The parent's number, off the head branch `agent/prd-<parent>-…`, or undefined where it names none. */
const parentOf = (branch: string): number | undefined => {
  const match = /^agent\/prd-([0-9]+)-/.exec(branch);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** Whether the loop's token is one a label added with starts a run: the App's or `AGENT_PAT`, and not the workflow token. */
const startsRuns = (inputs: Inputs): boolean =>
  inputs.LOOP_TOKEN !== "" && (inputs.LOOP_TOKEN_SOURCE === "app" || inputs.LOOP_TOKEN_SOURCE === "pat");

/**
 * A slice round's **approval**: `agent:implement` back on the parent, with the
 * loop's token, since one added with the workflow token sits there and starts
 * nothing. So without the App or the PAT nothing is added at all, and the PRD
 * PR, where a maintainer is already looking, says which re-label advances the
 * chain by hand. Where the mint failed, the same, with its reason, and the
 * command fails: a chain that did not advance after an approval is a stall
 * with no other symptom.
 */
const moveOn = async (inputs: Inputs, { pr, workflow, loop }: Writers): Promise<void> => {
  const parent = parentOf(inputs.BRANCH);
  if (parent === undefined) {
    throw new Error(
      `PRD PR #${pr}'s head \`${inputs.BRANCH}\` is not \`agent/prd-<parent>-…\`, so its PRD cannot be told. Re-add \`${IMPLEMENT_LABEL}\` to the PRD by hand to advance its chain.`,
    );
  }
  if (inputs.MINT_OUTCOME === "failure") {
    const runUrl = workflowRunUrl(inputs);
    await tolerated(`Could not say on PRD PR #${pr} that the chain did not advance.`, () =>
      workflow.comment(
        pr,
        `This slice's round ended on an approval, but the PRD chain did not advance: ${MINT_FAILED}${runUrl === undefined ? "" : ` [Workflow run](${runUrl})`}\n\nOnce that is fixed, re-add \`${IMPLEMENT_LABEL}\` to #${parent} by hand to build the next slice.`,
      ),
    );
    throw new Error(`The PRD chain did not advance past the slice round approved on PRD PR #${pr}: ${MINT_FAILED}`);
  }
  if (!startsRuns(inputs)) {
    console.log(
      `::warning::Neither the loop's App nor AGENT_PAT is set, so the PRD chain was not advanced: a label added with GITHUB_TOKEN starts nothing. Re-add ${IMPLEMENT_LABEL} to #${parent} by hand.`,
    );
    await tolerated("…and that could not be said on the pull request either.", () =>
      workflow.comment(
        pr,
        `This slice's round ended on an approval, but the PRD chain will not advance on its own: neither the loop's App nor \`AGENT_PAT\` is set, and a label added with \`GITHUB_TOKEN\` starts nothing. Re-add \`${IMPLEMENT_LABEL}\` to #${parent} by hand to build the next slice.`,
      ),
    );
    return;
  }
  // Removed first, as every trigger label the loop adds (#236): an add on a
  // label still there fires nothing, and the chain would stall.
  await tolerated(undefined, () => loop.removeLabel(parent, IMPLEMENT_LABEL));
  await loop.addLabel(parent, IMPLEMENT_LABEL);
  console.log(`Re-added ${IMPLEMENT_LABEL} to #${parent}: the PRD chain advances past the slice round approved on PRD PR #${pr}.`);
};

/**
 * Every other ending but a fix round starting: the **park comment**, on the
 * parent. Which one is by how far the round got:
 *
 * - **it ended**, the review and its posting both finished: the reason the
 *   review's verdict stops the round, and that verdict's next step;
 * - **its verdict was posted**, but the posting job failed after it (a fix
 *   round the review asked for that did not start, say): that verdict, linked,
 *   since "no verdict" would be false;
 * - **anything else**: the review did not finish, and what was open before
 *   it, with the run.
 *
 * The findings this round raised link the posted review, whose URL exists only
 * now. Where the review stopped before handing anything over, nothing is known
 * of the round but where it ran, and the comment says only that.
 *
 * On the parent with the loop's token. Without the App or the PAT, the comment
 * goes on the PRD PR instead, saying where it was meant for; where the mint
 * failed, the same with the reason, and the command fails. The post itself is
 * never tolerated: a chain that parked without saying so is the silence this
 * exists to end, and a failed command is the only thing left that says it.
 */
const park = async (
  inputs: Inputs,
  { pr, workflow, loop }: Writers,
  handed: ParkHandOver | undefined,
  ended: boolean,
): Promise<void> => {
  const parent = parentOf(inputs.BRANCH);
  if (parent === undefined) {
    throw new Error(
      `PRD PR #${pr}'s head \`${inputs.BRANCH}\` is not \`agent/prd-<parent>-…\`, so its PRD cannot be told, and the park comment was not posted.`,
    );
  }
  const runUrl = workflowRunUrl(inputs);
  const reviewUrl = inputs.REVIEW_URL;
  const comment = (reason: ParkInputs["reason"], review: ParkReview | undefined, extra: Partial<ParkInputs>): string | undefined =>
    handed === undefined
      ? undefined
      : renderParkComment({
          round: handed.round,
          prNumber: String(pr),
          reason,
          findings:
            review === undefined
              ? handed.carried
              : [...review.stillOpen, ...review.raised.map((f) => ({ ...f, ...(reviewUrl === "" ? {} : { url: reviewUrl }) }))],
          ...extra,
        });
  const review = handed?.review;
  const body =
    (ended
      ? review?.reason === undefined
        ? undefined
        : comment(review.reason, review, { detail: verdictRow(review.verdict, review.cause).nextStep })
      : inputs.REVIEW_RESULT === "success" && reviewUrl !== "" && review !== undefined
        ? comment("post failed", review, {
            detail: `[The verdict](${reviewUrl}) was *${verdictRow(review.verdict, review.cause).heading}*.`,
            ...(runUrl === undefined ? {} : { runUrl }),
          })
        : comment("failed", undefined, runUrl === undefined ? {} : { runUrl })) ??
    `**The PRD chain parked** on PRD PR #${pr}: its review didn't finish, so there is no verdict.${runUrl === undefined ? "" : ` [Workflow run](${runUrl})`}\n\nTo move on, add \`${REVIEW_LABEL}\` to PRD PR #${pr} to run the review again. The chain moves on once a review of the PRD PR's latest commit recommends approval.`;

  if (inputs.MINT_OUTCOME === "failure") {
    console.log(`::error::The loop's App's token was not minted, so the park comment goes on PRD PR #${pr} rather than on #${parent}.`);
    await workflow.comment(pr, `${body}\n\n_This was meant for #${parent}, but it could not be posted there: ${MINT_FAILED}_`);
    throw new Error(`The park comment went on PRD PR #${pr} rather than on #${parent}: ${MINT_FAILED}`);
  }
  if (!startsRuns(inputs)) {
    console.log(
      `::warning::Neither the loop's App nor AGENT_PAT is set, so the park comment goes on PRD PR #${pr} rather than on #${parent}: the workflow token cannot comment on an issue here.`,
    );
    await workflow.comment(pr, `${body}\n\n_This was meant for #${parent}, but neither the loop's App nor \`AGENT_PAT\` is set._`);
    return;
  }
  await loop.comment(parent, body);
  console.log(`Posted the park comment on #${parent}.`);
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
 * What advance may write, and how many of each (ADR 0005): the PRD PR's body
 * once, for the table and the status line; `agent:implement` removed and added
 * once each, on the parent; and one comment, the park or the note on the PRD
 * PR, never both.
 */
const LIMITS: Limits = { editPullRequest: 1, removeLabel: 1, addLabel: 1, comment: 1 };

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};
