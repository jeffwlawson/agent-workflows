import { GitHubError } from "../engine/github.js";
import type { GitHubReader } from "../engine/read.js";
import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import type { CommandIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { BLOCKED_LABEL, FIX_LABEL } from "../shared/record.js";
import { waitForReviewPosting } from "../shared/review-posting.js";

type Declared = (typeof COMMANDS)["fix:gate"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * `fix:gate` (#470): everything the gate job settles before the agent's job,
 * in the order it settles it. Whether this run goes ahead, said on the pull
 * request where it does not; the permission probe; `agent:blocked` off; and
 * the wait for a review's posting to finish.
 *
 * `gate.json` is its decision, `proceed`, `true` or `false`, which the
 * adapter copies into the job's `refused`. It is written however this ends,
 * with what was decided by then: a gate that died before deciding writes
 * none, and the later jobs read that as the third value of `refused`, empty.
 * One that decided to go ahead and then failed, at the probe, still says so,
 * and its job's failure is what keeps the agent's job from starting.
 *
 * Every write is the workflow token's: nothing here has to start a run.
 */
export const gate = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const waitSeconds = seconds(inputs.POST_WAIT_SECONDS, "POST_WAIT_SECONDS");
  const pollSeconds = seconds(inputs.POST_POLL_SECONDS, "POST_POLL_SECONDS");
  const decided: { proceed?: "true" | "false" } = {};
  try {
    const { workflow } = io.writers(LIMITS);
    const refusal = await preflight(inputs, io.github);
    if (refusal !== undefined) {
      await refuse(pr, workflow, refusal);
      decided.proceed = "false";
      return;
    }
    decided.proceed = "true";

    // **The permission probe**: the label write a short token feels first,
    // ahead of the agent pass it would otherwise spend. It adds the label
    // this run already holds, which changes nothing, and is not tolerated,
    // so a short token fails the run here, before the agent's job starts.
    try {
      await workflow.addLabel(pr, FIX_LABEL);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      throw new Error(
        `Couldn't add \`${FIX_LABEL}\` to PR #${pr}, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants \`pull-requests: write\`.`,
        { cause: error },
      );
    }
    // The trigger label stays on while this run works and comes off in its
    // last step (#236), so the one label to take off here is a block an
    // earlier run left. Re-adding `agent:fix` is the retry, and this clears it.
    await tolerated(undefined, () => workflow.removeLabel(pr, BLOCKED_LABEL));

    await waitForReviewPosting(io.github, pr, { waitSeconds, pollSeconds });
  } finally {
    io.outputs.writeJson("gate.json", decided);
  }
};

/** Why this run does not go ahead, and whether a human has to act on it. */
interface Refusal {
  readonly sentence: string;
  readonly blocked: boolean;
}

/**
 * **The pre-flight.** A closed or merged pull request is refused; then the
 * event's head, `HEAD_SHA`, is checked against `BRANCH`'s live tip (#188).
 * Everything after this is pinned to that commit, the checkout and the push's
 * lease, so a run started behind the branch fast-forwards onto work already
 * done, finds nothing to do, and re-posts its replies to threads it has
 * already answered. Each such run stacked another near-identical reply on
 * every thread.
 *
 * The tip is the **branch ref**, not the pull request's head: in the case that
 * raised this, the pull request went on reporting the old commit after the
 * branch had moved, so asking it would have agreed with the stale event.
 *
 * **An unreadable tip refuses, deliberately**, the opposite of `review:gate`,
 * which proceeds on an API blip. Review only reads; this run pushes and
 * replies, and replying twice is the harm the check exists to stop, so "could
 * not tell" must not read as "not stale". A 404 is the branch gone, and
 * anything else an unreadable tip, each with its own sentence. The cost is a
 * human re-adding the label after a blip, which is cheap.
 *
 * The ones the maintainer has to act on, an unreadable tip and a stale one,
 * are blocked (#253). A closed pull request and a deleted branch leave
 * nothing to act on, so they get the note alone.
 */
const preflight = async (inputs: Inputs, github: GitHubReader): Promise<Refusal | undefined> => {
  if (inputs.PR_STATE !== "open" || inputs.PR_MERGED === "true") return { sentence: "This PR is closed.", blocked: false };

  const branch = inputs.BRANCH;
  let tip: string;
  try {
    tip = await github.branchTip(branch);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      console.log(`::warning::Branch ${branch} was not found on the remote.`);
      return { sentence: "This PR's branch no longer exists, so there's nothing to fix.", blocked: false };
    }
    console.log(`::warning::Could not read the live head of ${branch}; refusing rather than risk working from a stale SHA. ${describe(error)}`);
    return { sentence: `Couldn't check whether the PR changed since \`${FIX_LABEL}\` was added. Add \`${FIX_LABEL}\` to try again.`, blocked: true };
  }
  if (tip !== inputs.HEAD_SHA) {
    console.log(
      `::warning::Stale head: this run was started for ${inputs.HEAD_SHA}, but ${branch} is at ${tip}. Refusing rather than redo finished work.`,
    );
    return {
      sentence: `The PR changed after \`${FIX_LABEL}\` was added. Add \`${FIX_LABEL}\` again to work on the latest version. If the PR still shows the old commit, close and reopen it so GitHub catches up.`,
      blocked: true,
    };
  }
  return undefined;
};

/**
 * A refusal, in the loop's one order (#236): the comment first, then this
 * run's own label off, then `agent:blocked`, so the label that names the next
 * step goes on last. One pattern for every refusal (#253): the label that did
 * not run, then a sentence saying why and what to do. Each write is tolerated:
 * a comment that fails still takes the label off, rather than leaving it on
 * with nothing behind it.
 */
const refuse = async (pr: number, workflow: Writer, refusal: Refusal): Promise<void> => {
  await tolerated(`Could not post the refusal comment on PR #${pr}.`, () =>
    workflow.comment(pr, `**\`${FIX_LABEL}\` didn't run:** ${refusal.sentence}`),
  );
  await tolerated(undefined, () => workflow.removeLabel(pr, FIX_LABEL));
  if (refusal.blocked) await tolerated(undefined, () => workflow.addLabel(pr, BLOCKED_LABEL));
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
 * comment, `agent:fix` off and `agent:blocked` on; a run that goes ahead is
 * the probe's `agent:fix` and `agent:blocked` off. Never both.
 */
const LIMITS: Limits = { comment: 1, removeLabel: 1, addLabel: 1 };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const seconds = (value: string, name: string): number => {
  if (!/^[0-9]{1,6}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a number of seconds.`);
  return Number(value);
};

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};
