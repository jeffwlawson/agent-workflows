import type { Limits } from "../engine/writer.js";
import { describe, pullRequestNumber, tolerated } from "../shared/command-helpers.js";
import type { CommandIo } from "../shared/command-io.js";
import { workflowRunUrl } from "../shared/common.js";
import { COMMANDS, type DirectoryFiles, type DirectoryInput } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { readDirectory, text } from "../shared/hand-over.js";
import { BLOCKED_LABEL, MERGE_LABEL, mergeStoppedComment } from "../shared/record.js";

type Declared = (typeof COMMANDS)["merge:conclude"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * `merge:conclude` (#588): how a merge run that stopped ends, in the loop's
 * one order: the failure comment with the reason, the run's link and the
 * retry, then `agent:merge` off, then `agent:blocked`. A merge GitHub refused
 * is not retried on every event that follows, since the label that would
 * re-start it is off, and re-adding it is the retry.
 *
 * On a run that finished it does nothing: the gate or publish said what there
 * was to say, and `agent:merge` is a standing decision, not a run's label, so
 * a run that merely ended does not take it off.
 *
 * The reason is, in order: the time limit, where the job measured that it ran
 * out; a cancel; the mint's failure; the reason `merge:publish` wrote; the
 * reason `merge:gate` wrote; and failing those, that it gave none. The reason
 * files are not read on a cancel or a timeout: what wrote one was stopped, not
 * failing.
 *
 * A pull request that merged before the run stopped is left alone: there is
 * nothing to retry, and nothing left to block.
 */
export const conclude = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  if (inputs.JOB_STATUS === "success") {
    console.log("The merge run finished, so there is nothing to conclude.");
    return;
  }

  // Read before the first write, and only where it can be the reason.
  const declared = COMMANDS["merge:conclude"].inputs;
  const reason =
    inputs.TIMED_OUT === "true"
      ? `It timed out after ${inputs.TIMEOUT_MINUTES} minutes.`
      : inputs.JOB_STATUS === "cancelled"
        ? CANCELLED
        : inputs.MINT_OUTCOME === "failure"
          ? MINT_FAILED
          : readReason(declared.PUBLISH_DIR, inputs.PUBLISH_DIR)?.trim() || readReason(declared.GATE_DIR, inputs.GATE_DIR)?.trim() || NO_REASON;

  try {
    if ((await io.github.pullRequest(pr)).merged) {
      console.log(`PR #${pr} merged before this run stopped, so there is nothing to retry and nothing to block.`);
      return;
    }
  } catch (error) {
    console.log(`::warning::Could not read whether PR #${pr} merged (${describe(error)}), so it is read as not merged.`);
  }

  const { workflow } = io.writers(LIMITS);
  await tolerated(`Could not post the failure comment on PR #${pr}.`, () =>
    workflow.comment(pr, mergeStoppedComment(sentenceOf(reason), workflowRunUrl(inputs))),
  );
  await tolerated(undefined, () => workflow.removeLabel(pr, MERGE_LABEL));
  await tolerated(undefined, () => workflow.addLabel(pr, BLOCKED_LABEL));
};

const CANCELLED = "It was cancelled before it finished, by hand or by GitHub.";
const NO_REASON = "It stopped without giving a reason. The workflow run's log has the details.";
/** Word for word as `.github/actions/loop-token` writes it, which a test holds. */
export const MINT_FAILED =
  "Couldn't mint a token for the loop's GitHub App, so nothing was written with it. Check that `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` belong to the same App, and that the App is installed on this repository.";

/**
 * The reason a producer wrote, where it wrote one. A file that cannot be read
 * is said and read as not written, so it costs the comment its reason and
 * never the comment.
 */
const readReason = (input: DirectoryInput<{ readonly "failure_reason.txt": "sometimes" } & DirectoryFiles>, dir: string): string | undefined => {
  try {
    return readDirectory(input, dir, { "failure_reason.txt": text })["failure_reason.txt"];
  } catch (error) {
    console.log(`::warning::${describe(error)} So it is read as not written.`);
    return undefined;
  }
};

/** One pattern for every run that stopped (#253): a capital first letter and a closing full stop. */
const sentenceOf = (reason: string): string => {
  const capital = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/** What conclude may write, and how many of each (ADR 0005): the failure comment, `agent:merge` off and `agent:blocked`. */
const LIMITS: Limits = { comment: 1, removeLabel: 1, addLabel: 1 };
