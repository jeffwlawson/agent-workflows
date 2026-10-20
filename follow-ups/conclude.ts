import type { Limits } from "../engine/writer.js";
import { describe, pullRequestNumber, tolerated } from "../shared/command-helpers.js";
import type { CommandIo } from "../shared/command-io.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { readDirectory, text } from "../shared/hand-over.js";
import { FOLLOW_UPS_STOPPED, followUpsStoppedComment } from "../shared/record.js";

type Declared = (typeof COMMANDS)["follow-ups:conclude"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * `follow-ups:conclude` (#511): how every filing run ends, success included.
 * It runs `always()`, after `follow-ups:file`, in the same job, and replaces
 * the shell step *Report the failure on the PR*, word for word.
 *
 * - **A run that finished**: nothing. A filing run's report is
 *   `follow-ups:file`'s, and a merge with nothing to file is a silent exit.
 * - **A run that stopped**, failed, cancelled or timed out: one comment, the
 *   reason as a sentence, the run's link and the retry.
 *
 * The reason is, in the shell step's order: the time limit, where the job's
 * last step measured that it ran out of time; a cancel; the reason
 * `follow-ups:file` wrote; and failing those, that it gave none. The reason
 * file is not read on a cancel or a timeout: what wrote one was stopped, not
 * failing.
 *
 * What it never does is the point of having a conclude of its own here.
 * `agent:follow-ups` stays on: `follow-ups:file` takes it off last, and only
 * on a plan that asked, so on a run that stopped it still says the stubs are
 * unfiled, and removing and re-adding it is the retry. And no
 * `agent:blocked`: that is the open pipeline's label, and a merged pull
 * request has no pipeline left to block.
 */
export const conclude = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  if (inputs.JOB_STATUS === "success") {
    console.log("The filing run finished, so there is nothing to conclude.");
    return;
  }

  // Read before the first write, and only where it can be the reason.
  const reason =
    inputs.TIMED_OUT === "true"
      ? FOLLOW_UPS_STOPPED.timedOut(inputs.TIMEOUT_MINUTES)
      : inputs.JOB_STATUS === "cancelled"
        ? FOLLOW_UPS_STOPPED.cancelled
        : readReason(inputs)?.trim() || FOLLOW_UPS_STOPPED.noReason;

  const { workflow } = io.writers(LIMITS);
  await tolerated(`Could not post the failure comment on #${pr}.`, () =>
    workflow.comment(pr, followUpsStoppedComment(sentenceOf(reason), inputs.RUN_URL)),
  );
};

/**
 * The reason `follow-ups:file` wrote, where it wrote one. A file that cannot
 * be read is said and read as not written, so it costs the comment its
 * reason and never the comment.
 */
const readReason = (inputs: Inputs): string | undefined => {
  try {
    return readDirectory(COMMANDS["follow-ups:conclude"].inputs.FILE_DIR, inputs.FILE_DIR, { "failure_reason.txt": text })[
      "failure_reason.txt"
    ];
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

/** What conclude may write, and how many (ADR 0005): the one failure comment, and nothing else. */
const LIMITS: Limits = { comment: 1 };
