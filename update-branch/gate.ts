import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import type { CommandIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { BLOCKED_LABEL, UPDATE_BRANCH_LABEL } from "../shared/record.js";
import { waitForReviewPosting } from "../shared/review-posting.js";

type Declared = (typeof COMMANDS)["update-branch:gate"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * `update-branch:gate` (#481): everything the gate job settles before its
 * checkout, in the order it settles it. Whether this run goes ahead, said on
 * the pull request where it does not; the permission probe; `agent:blocked`
 * off; and the wait for a review's posting to finish, since this run reads
 * the verdict a review posts and carries it on to the merge commit.
 *
 * The same shape as `fix:gate`, with one refusal fewer: a closed or merged
 * pull request is the only one, as it was in the shell pre-flight this
 * replaced. It reads no branch tip, so a deleted base or head is not refused
 * here; `update-branch:merge`'s fetch fails on it, and says so.
 *
 * `gate.json` is its decision, `proceed`, written as soon as it is decided
 * and again however this ends, as `fix:gate`'s is, for the same reason: a
 * cancel reaches Node as a signal, which runs no `finally`. A gate that died
 * before deciding writes none, which the job's `refused` reads as empty.
 *
 * Every write is the workflow token's: nothing here has to start a run.
 */
export const gate = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const waitSeconds = seconds(inputs.POST_WAIT_SECONDS, "POST_WAIT_SECONDS");
  const pollSeconds = seconds(inputs.POST_POLL_SECONDS, "POST_POLL_SECONDS");
  const decided: { proceed?: "true" | "false" } = {};
  const decide = (proceed: "true" | "false"): void => {
    decided.proceed = proceed;
    io.outputs.writeJson("gate.json", decided);
  };
  try {
    const { workflow } = io.writers(LIMITS);
    if (inputs.PR_STATE !== "open" || inputs.PR_MERGED === "true") {
      await refuse(pr, workflow, "This PR is closed.");
      decide("false");
      return;
    }
    decide("true");

    // **The permission probe**: the label write a short token feels first,
    // ahead of the agent pass it would otherwise spend. It adds the label
    // this run already holds, which changes nothing, and is not tolerated,
    // so a short token fails the run here, before the checkout.
    try {
      await workflow.addLabel(pr, UPDATE_BRANCH_LABEL);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      throw new Error(
        `Couldn't add \`${UPDATE_BRANCH_LABEL}\` to PR #${pr}, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants \`pull-requests: write\`.`,
        { cause: error },
      );
    }
    // The trigger label stays on while this run works and comes off in its
    // last step (#236), so the one label to take off here is a block an
    // earlier run left. Re-adding `agent:update-branch` is the retry.
    await tolerated(undefined, () => workflow.removeLabel(pr, BLOCKED_LABEL));

    await waitForReviewPosting(io.github, pr, { waitSeconds, pollSeconds });
    console.log(`Claimed PR #${pr} to refresh ${inputs.BRANCH}.`);
  } finally {
    io.outputs.writeJson("gate.json", decided);
  }
};

/**
 * A refusal, in the loop's one order (#236): the comment first, then this
 * run's own label off. A closed pull request leaves nothing to act on, so
 * nothing is blocked (#253). Each write is tolerated: a comment that fails
 * still takes the label off.
 */
const refuse = async (pr: number, workflow: Writer, sentence: string): Promise<void> => {
  await tolerated(`Could not post the refusal comment on PR #${pr}.`, () =>
    workflow.comment(pr, `**\`${UPDATE_BRANCH_LABEL}\` didn't run:** ${sentence}`),
  );
  await tolerated(undefined, () => workflow.removeLabel(pr, UPDATE_BRANCH_LABEL));
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
 * What the gate may write, and how many of each (ADR 0005). A refusal is one
 * comment and `agent:update-branch` off; a run that goes ahead is the probe's
 * `agent:update-branch` and `agent:blocked` off. Never both.
 */
const LIMITS: Limits = { comment: 1, removeLabel: 2, addLabel: 1 };

const seconds = (value: string, name: string): number => {
  if (!/^[0-9]{1,6}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a number of seconds.`);
  return Number(value);
};

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};
