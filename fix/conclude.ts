import * as path from "node:path";
import { GitHubError } from "../engine/github.js";
import { WriteFailed, type Lease, type Limits, type Writer } from "../engine/writer.js";
import { checkBundle } from "../shared/bundle.js";
import { describe, pullRequestNumber, tolerated } from "../shared/command-helpers.js";
import type { CheckoutIo } from "../shared/command-io.js";
import { workflowRunUrl } from "../shared/common.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { choice, json, matching, object, optional, readDirectory, text } from "../shared/hand-over.js";
import { BLOCKED_LABEL, FIX_LABEL, REVIEW_LABEL } from "../shared/record.js";
import { present, rescueIgnored, setAsideNote } from "./hand-over.js";

type Declared = (typeof COMMANDS)["fix:conclude"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CheckoutIo<Declared["outputs"]>;

/**
 * `fix:conclude` (#469): how every fix run ends, success included. It runs
 * `always()`, after `fix:publish`, and writes in the loop's one order: every
 * result posted, then `agent:fix` off, then `agent:blocked` where the run
 * stopped.
 *
 * - **A pre-flight that died before deciding**: `agent:fix` off, and nothing
 *   else, since nothing is known to say.
 * - **A run that finished**, `fix:publish` included: `agent:fix` off. Every
 *   other word of a finished run is publish's.
 * - **A run that stopped**, the agent's job's or this job's: its commits
 *   rescued, where nothing was pushed to the pull request; the failure
 *   comment, with the reason and the retry the ending calls for; `agent:fix`
 *   off; `agent:blocked`.
 *
 * What ran and how it ended are inputs, each job's result and each step's
 * outcome as the adapter saw it, and this works out the ending from them.
 * What publish did, and the reasons `fix:prepare`, the runner and
 * `fix:bundle` stopped with, it reads from each producer's own directory
 * (ADR 0006), so which reason the comment gives is decided here, in the order
 * the publish job's failure step read them.
 *
 * Every write is tolerated, as the shell before it tolerated each with
 * `|| true`, `continue-on-error` or a warning: a run that cannot comment still
 * takes its label off, and a rescue that fails is said and skipped.
 */
export const conclude = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const ending = endingOf(inputs);
  if (ending.kind === "refused") {
    // The gate said it and took the label off: there is nothing left to say.
    console.log("The gate refused this run and said why, so there is nothing to conclude.");
    return;
  }
  const started = commit(inputs.HEAD_SHA);

  // What each producer left, read and checked before the first write.
  const published = readDirectory(COMMANDS["fix:conclude"].inputs.PUBLISH_DIR, inputs.PUBLISH_DIR, {
    "published.json": json(
      object({ pushed: FLAG, head: optional(matching(/[0-9a-f]{40}/, "a full commit id")), notesPosted: FLAG, nothingToDo: FLAG, rescueNoted: FLAG }),
    ),
    "failure_reason.txt": text,
  });
  const prepared = readDirectory(COMMANDS["fix:conclude"].inputs.PREPARE_DIR, inputs.PREPARE_DIR, {
    "failure_reason.txt": text,
  });
  const handOver = readRunner(inputs);
  const bundled = readDirectory(COMMANDS["fix:conclude"].inputs.BUNDLE_DIR, inputs.BUNDLE_DIR, {
    "branch.bundle": present,
    "failure_reason.txt": text,
  });

  const { workflow, loop } = io.writers(LIMITS);

  // A rescue the runner set aside, said however the run ended, wherever
  // publish did not say it: it did not run, or stopped before its first write
  // (reading the pull request or checking the hand-over), or GitHub refused
  // its note. What it said, it records in `published.json`.
  const setAside = handOver["rescue_ignored.json"];
  if (setAside !== undefined && published["published.json"]?.rescueNoted !== true) {
    await tolerated(`Could not say on PR #${pr} that ${setAside.branch} was set aside.`, () =>
      workflow.comment(pr, setAsideNote(setAside.branch)),
    );
  }

  if (ending.kind === "undecided" || ending.kind === "finished") {
    await removeTrigger(pr, workflow);
    return;
  }

  const state = published["published.json"];
  const pushed = state?.pushed === true;
  const reason = ending.reason({
    prepare: prepared["failure_reason.txt"],
    runner: handOver["failure_reason.txt"],
    bundle: bundled["failure_reason.txt"],
    publish: published["failure_reason.txt"],
  });
  const saved = pushed ? { kind: "none" as const } : await rescueCommits(inputs, io, loop, started, bundled["branch.bundle"] !== undefined);
  const comment = failureComment(inputs, reason, retryOf(pushed, state?.notesPosted === true, saved, inputs.RESCUE_BRANCH));

  await tolerated(`Could not post the failure comment on PR #${pr}.`, () => workflow.comment(pr, comment));
  await removeTrigger(pr, workflow);
  await tolerated(undefined, () => workflow.addLabel(pr, BLOCKED_LABEL));
};

/**
 * The runner's two files, which the agent's runner can write anything into,
 * each read on its own. The reason is text, which always reads. The
 * set-aside note is checked against this pull request's rescue branch, and
 * one that does not read is said and skipped rather than stopping this: a
 * hand-over nobody can trust must not keep the run's label on, nor cost the
 * comment the reason the runner gave beside it. On a finished agent's run
 * `fix:publish` refuses the same note, and the comment gives its reason.
 */
const readRunner = (
  inputs: Inputs,
): { readonly "failure_reason.txt"?: string | undefined; readonly "rescue_ignored.json"?: { readonly branch: string } | undefined } => {
  const declared = COMMANDS["fix:conclude"].inputs.FIX_DIR;
  const skipped = () => undefined;
  const reason = readDirectory(declared, inputs.FIX_DIR, { "failure_reason.txt": text, "rescue_ignored.json": skipped })[
    "failure_reason.txt"
  ];
  try {
    const note = readDirectory(declared, inputs.FIX_DIR, {
      "failure_reason.txt": skipped,
      "rescue_ignored.json": rescueIgnored(inputs.RESCUE_BRANCH),
    })["rescue_ignored.json"];
    return { "failure_reason.txt": reason, "rescue_ignored.json": note };
  } catch (error) {
    console.log(`::warning::${describe(error)} So no rescue is said to have been set aside here.`);
    return { "failure_reason.txt": reason };
  }
};

/** The reasons a stopped run can give, each where its producer wrote one. */
interface Reasons {
  readonly prepare: string | undefined;
  readonly runner: string | undefined;
  readonly bundle: string | undefined;
  readonly publish: string | undefined;
}

/**
 * How the run ended, from what the adapter reported: the gate's decision and
 * result, the agent's job's result, and the outcome of each of this job's
 * steps that runs before this one. A stopped run's `reason` is chosen once
 * the producers' files are read.
 */
type Ending =
  | { readonly kind: "refused" }
  | { readonly kind: "undecided" }
  | { readonly kind: "finished" }
  | { readonly kind: "stopped"; readonly reason: (reasons: Reasons) => string };

const endingOf = (inputs: Inputs): Ending => {
  if (inputs.REFUSED === "true") return { kind: "refused" };
  // The pre-flight died before it decided, or was cancelled there: whether
  // this run was ever the pull request's is not known, so nothing is said.
  if (inputs.REFUSED === "") return { kind: "undecided" };

  // Cancelled is not failed (#220), and a job that reached its limit is
  // cancelled too, or may read as failed: so a cancel, and a failure that left
  // no reason, are measured against the time limit, which the adapter
  // measured. A reason file is not read on either; what wrote one was stopped,
  // not failing.
  const measured = (otherwise: string): string =>
    inputs.TIMED_OUT === "true"
      ? `It timed out after ${inputs.TIMEOUT_MINUTES} minutes. The repository variable \`AGENT_TIMEOUT_MINUTES\` raises the limit.`
      : otherwise;
  const stopped = (reason: (reasons: Reasons) => string): Ending => ({ kind: "stopped", reason });
  const steps = [inputs.MINT_OUTCOME, inputs.DOWNLOAD_OUTCOME, inputs.PUBLISH_OUTCOME];

  if (inputs.AGENT_RESULT === "success") {
    // The agent finished; what stopped is the first of this job's steps that
    // did not succeed. A step a cancel skipped did not fail. The mint wrote
    // its reason where only a step in its own job could read it, so the
    // sentence is said here, word for word as `.github/actions/loop-token`
    // writes it, and a test holds the two equal.
    const reasons: readonly ((reasons: Reasons) => string)[] = [
      () => MINT_FAILED,
      () => DOWNLOAD_FAILED,
      ({ publish }) => publish?.trim() || NO_REASON,
    ];
    for (const [i, outcome] of steps.entries()) {
      if (outcome === "success") continue;
      return stopped(outcome === "failure" ? (reasons[i] ?? (() => NO_REASON)) : () => CANCELLED);
    }
    return { kind: "finished" };
  }

  if (inputs.GATE_RESULT === "cancelled" || inputs.AGENT_RESULT === "cancelled" || steps.includes("cancelled")) {
    return stopped(() => measured(CANCELLED));
  }
  // The agent's job failed, or never ran behind a gate that failed after it
  // claimed the run: the gate's reason, which its job hands on as an output
  // since its file is on its own runner; then `fix:prepare`'s, for an agent's
  // job that stopped before the runner started, then the runner's, and
  // failing that `fix:bundle`'s, for an agent's job that failed only at the
  // bundle.
  const gate = inputs.GATE_RESULT === "failure" ? inputs.GATE_REASON.trim() : "";
  return stopped(({ prepare, runner, bundle }) => {
    const reason = gate || prepare?.trim() || runner?.trim() || bundle?.trim();
    if (reason !== undefined && reason !== "") return reason;
    return inputs.AGENT_RESULT === "failure" ? measured(NO_REASON) : NO_REASON;
  });
};

const CANCELLED = "It was cancelled before it finished, by hand or by GitHub.";
const NO_REASON = "It stopped without giving a reason. The workflow run's log has the details.";
export const MINT_FAILED =
  "Couldn't mint a token for the loop's GitHub App, so nothing was written with it. Check that `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` belong to the same App, and that the App is installed on this repository.";
const DOWNLOAD_FAILED = "The agent finished, but what it handed over could not be fetched from its job, so nothing was pushed or posted.";

/** What became of a stopped run's commits. */
type Saved = { readonly kind: "none" } | { readonly kind: "rescued" } | { readonly kind: "no token" };

/**
 * **A stopped run's commits, kept on a side branch** (#303): the rescue
 * branch, with a fixed name, and never the pull request's. A commit pushed
 * there would stand on the pull request's head unverified and with no
 * verdict, so rescued work reaches the pull request only through the resumed
 * run's own push, after its verify. Nothing else: no pull request, no review
 * asked for, no label.
 *
 * Only where nothing was pushed to the pull request, which the caller checks,
 * and where there is a bundle: none is a run with no commits ahead of the
 * head it started from. The bundle is checked as `fix:publish` checks it, and
 * one that fails a check is not rescued.
 *
 * Under a lease on the rescue as it is read here: a run that stops again
 * overwrites the earlier rescue, which it started from and so holds all of,
 * and nothing that moved it in between is lost silently. With the loop's
 * token, as `fix:publish` pushes, since the agent's commits may touch a
 * workflow file; a mint that failed leaves none to push with, which the
 * comment says.
 */
const rescueCommits = async (inputs: Inputs, io: Io, loop: Writer, started: string, bundled: boolean): Promise<Saved> => {
  if (!bundled) {
    console.log("No commits ahead of the head this run started from, so there is nothing to rescue.");
    return { kind: "none" };
  }
  const rescue = inputs.RESCUE_BRANCH;
  // The token first: with none there is nothing to push with whatever the
  // bundle holds, and checked after the bundle, a check that failed for
  // another reason (no checkout to place it in) would hide that the commits
  // went unsaved.
  if (inputs.LOOP_TOKEN === "" || inputs.MINT_OUTCOME !== "success") {
    console.log(`::warning::The loop's token was not minted, so the agent's commits were not saved on ${rescue}.`);
    return { kind: "no token" };
  }
  let tip: string;
  try {
    tip = await checkBundle(io.git, path.join(inputs.BUNDLE_DIR, "branch.bundle"), inputs.BRANCH, started, "rescued");
  } catch (error) {
    console.log(`::warning::${describe(error)}`);
    return { kind: "none" };
  }

  let lease: Lease;
  try {
    lease = { tip: await io.github.branchTip(rescue) };
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) {
      console.log(`::warning::Could not read ${rescue}, so the agent's commits were not saved there: ${describe(error)}`);
      return { kind: "none" };
    }
    lease = { absent: true };
  }
  try {
    await loop.pushRef({ ref: `refs/heads/${rescue}`, commit: tip, lease });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::Could not push the agent's commits to ${rescue}, so nothing was rescued. Git's reply is in the write log.`);
    return { kind: "none" };
  }
  console.log(`Rescued the agent's commits, up to ${tip}, to ${rescue}.`);
  return { kind: "rescued" };
};

/**
 * What to do next, which depends on what the run left behind (#105).
 * Everything after the push can fail on a branch that already moved: the
 * replies, the comments and the re-review. "Add `agent:fix` to retry" is the
 * wrong answer to all three, since the threads are answered by then and stay
 * open until a review verifies the fix (#111), so a second fix run would
 * answer them twice. A rescue is named whatever else it says, and is the
 * retry where nothing else was: adding the label resumes from it.
 */
const retryOf = (pushed: boolean, noted: boolean, saved: Saved, rescue: string): string => {
  const plain = `To try again, add \`${FIX_LABEL}\`.`;
  const retry = pushed
    ? `Its changes were pushed before it stopped, so running it again would repeat work. Fix the problem above, then add \`${REVIEW_LABEL}\`.`
    : noted
      ? `Its out-of-scope notes were posted before it stopped, so running it again would repeat work. Fix the problem above, then add \`${REVIEW_LABEL}\` to have them ruled on.`
      : plain;
  if (saved.kind === "rescued") {
    return retry === plain
      ? `Its commits so far are saved on \`${rescue}\`. To resume from them, add \`${FIX_LABEL}\`.`
      : `${retry} Its commits so far are saved on \`${rescue}\`, and adding \`${FIX_LABEL}\` resumes from them.`;
  }
  if (saved.kind === "no token") {
    return `${retry} Its commits were not saved on \`${rescue}\`: the loop's token was not minted, so there was nothing to push them with.`;
  }
  return retry;
};

/**
 * One pattern for every run that stopped (#253): the reason as a sentence,
 * starting with a capital and ending in a full stop, then the run and what to
 * do.
 */
const failureComment = (inputs: Inputs, reason: string, retry: string): string => {
  const trimmed = reason.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const sentence = /[.!?]$/.test(capital) ? capital : `${capital}.`;
  // No run, no link: the service has no run page, and `[Workflow run]()` links nowhere.
  const runUrl = workflowRunUrl(inputs);
  return `**\`${FIX_LABEL}\` stopped:** ${sentence}\n\n${runUrl === undefined ? "" : `[Workflow run](${runUrl}) · `}${retry}\n`;
};

/**
 * The trigger label comes off however the run ends (#236), so it never
 * outlives the run. Unlike review and update-branch, a fix run whose pull
 * request moved while it worked does **not** ask for itself again: a second
 * fix run reads the same threads, which stay open until a review verifies
 * them (#111), and answers them twice. A push made during a fix makes this
 * run's own push fail its lease anyway, which is `agent:blocked` and a
 * human's call.
 */
const removeTrigger = (pr: number, workflow: Writer): Promise<boolean> => tolerated(undefined, () => workflow.removeLabel(pr, FIX_LABEL));

/**
 * What conclude may write, and how many of each (ADR 0005): the rescue push,
 * two comments (the rescue-set-aside note and the failure comment),
 * `agent:fix` off and `agent:blocked` on.
 */
const LIMITS: Limits = { pushRef: 1, comment: 2, removeLabel: 1, addLabel: 1 };

const FLAG = choice([true, false]);

const commit = (value: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`HEAD_SHA is ${JSON.stringify(value)}, which is not a full commit id, so there is no head to check the agent's commits against.`);
  }
  return value;
};
