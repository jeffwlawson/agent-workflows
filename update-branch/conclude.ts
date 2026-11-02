import { GitHubError } from "../engine/github.js";
import type { PullRequest } from "../engine/read.js";
import type { Limits, Writer } from "../engine/writer.js";
import { describe, pullRequestNumber, tolerated } from "../shared/command-helpers.js";
import type { CommandIo } from "../shared/command-io.js";
import { workflowRunUrl } from "../shared/common.js";
import { COMMANDS, type DirectoryFiles, type DirectoryInput } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { choice, json, matching, object, optional, readDirectory, text, type FileParsers, type HandOver } from "../shared/hand-over.js";
import { loopAccounts } from "../shared/loop-accounts.js";
import { BLOCKED_LABEL, FIX_LABEL, MERGE_LABEL, REVIEW_LABEL, UPDATE_BRANCH_LABEL, USAGE_LIMIT } from "../shared/record.js";
import { limitEnding } from "../shared/usage-limit.js";

type Declared = (typeof COMMANDS)["update-branch:conclude"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * `update-branch:conclude` (#485): how every update-branch run ends, success
 * included. It runs `always()`, after `update-branch:publish`, and writes in
 * the loop's one order: every result posted, then `agent:update-branch` off,
 * then the label that names the next step.
 *
 * - **A pre-flight that died before deciding**: `agent:update-branch` off,
 *   and nothing else, since nothing is known to say.
 * - **A run that stopped**, any of its three jobs: the failure comment, with
 *   the reason and the retry the ending calls for; `agent:update-branch`
 *   off; `agent:blocked`.
 * - **A run the plan's usage limit stopped** (#635), where nothing was
 *   pushed: on the service, the comment saying it will resume after the
 *   reset, and nothing more: `agent:update-branch` stays on and
 *   `agent:blocked` is not added, since the service resumes it. On Actions,
 *   the comment giving the reset time and saying to add the label after it,
 *   then `agent:update-branch` off and `agent:blocked`. A second such stop
 *   with no add of the label since the first ends as a run that stopped.
 * - **A run that finished**, `update-branch:publish` included:
 *   `agent:update-branch` off, and asked for again where the pull request's
 *   head moved on from the one this run left; then, on a pull request
 *   carrying `agent:merge`, that label handed back to the merge gate (#589).
 *   Every other word of a finished run is publish's.
 *
 * What ran and how it ended are inputs, each job's result and each step's
 * outcome as the adapter saw it, and this works out the ending from them.
 * What publish did, and the reasons `update-branch:prepare`, the runner and
 * `update-branch:bundle` stopped with, it reads from each producer's own
 * directory (ADR 0006), each on its own: a file that does not read is said
 * and skipped, so it cannot cost the comment a reason another producer gave.
 *
 * Every write is tolerated, as the shell before it tolerated each with
 * `|| true` or a warning: a run that cannot comment still takes its label
 * off.
 */
export const conclude = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const accounts = loopAccounts(inputs.AGENT_LOOP_LOGINS);
  const ending = endingOf(inputs);
  if (ending.kind === "refused") {
    // The gate said it and took the label off: there is nothing left to say.
    console.log("The gate refused this run and said why, so there is nothing to conclude.");
    return;
  }
  const started = commit(inputs.HEAD_SHA);

  // What each producer left, read and checked before the first write.
  const declared = COMMANDS["update-branch:conclude"].inputs;
  const published = readEach(declared.PUBLISH_DIR, inputs.PUBLISH_DIR, {
    "published.json": json(object({ pushed: FLAG, head: optional(matching(/[0-9a-f]{40}/, "a full commit id")), requested: FLAG })),
    "failure_reason.txt": text,
  });
  const prepared = readEach(declared.PREPARE_DIR, inputs.PREPARE_DIR, { "failure_reason.txt": text });
  const ran = readEach(declared.UPDATE_BRANCH_DIR, inputs.UPDATE_BRANCH_DIR, { "failure_reason.txt": text });
  const bundled = readEach(declared.BUNDLE_DIR, inputs.BUNDLE_DIR, { "failure_reason.txt": text });

  const { workflow, loop } = io.writers(LIMITS);

  if (ending.kind === "undecided") {
    await removeTrigger(pr, workflow);
    return;
  }

  const state = published["published.json"];
  if (ending.kind === "stopped") {
    const reason = ending.reason({
      prepare: prepared["failure_reason.txt"],
      runner: ran["failure_reason.txt"],
      bundle: bundled["failure_reason.txt"],
      publish: published["failure_reason.txt"],
    });
    // The plan's usage limit (#635), where nothing was pushed: a wait, which
    // resumes by itself on the service, label on and nothing blocked.
    const limited =
      state?.pushed === true
        ? undefined
        : await limitEnding({ reason, orchestrator: inputs.ORCHESTRATOR, item: pr, label: UPDATE_BRANCH_LABEL, github: io.github, accounts, now: new Date() });
    if (limited?.kind === "resumes") {
      await tolerated(`Could not post the usage-limit comment on PR #${pr}.`, () =>
        workflow.comment(pr, USAGE_LIMIT.resumes(UPDATE_BRANCH_LABEL, limited.until, limited.stopped)),
      );
      return;
    }
    const comment =
      limited === undefined
        ? failureComment(inputs, reason, retryOf(state?.pushed === true))
        : USAGE_LIMIT.waits(UPDATE_BRANCH_LABEL, limited.until, workflowRunUrl(inputs));
    await tolerated(`Could not post the failure comment on PR #${pr}.`, () => workflow.comment(pr, comment));
    await removeTrigger(pr, workflow);
    await tolerated(undefined, () => workflow.addLabel(pr, BLOCKED_LABEL));
    return;
  }

  await removeTrigger(pr, workflow);
  const live = await readLive(io, pr);
  if (published.unread) {
    console.log(`::warning::What update-branch:publish did could not be read, so whether it asked for a review could not be told, and ${UPDATE_BRANCH_LABEL} was not asked for again.`);
  } else if (state?.requested === true) {
    // One hand-off or the other, never both: the review publish asked for is
    // queued in this pull request's concurrency group, and a second request
    // here would queue behind it and cancel it while pending, before it could
    // take `agent:review` off.
    console.log("This run asked for the review of its resolution, so it asks for nothing more.");
  } else {
    await askAgainIfMoved(inputs, live, { pr, workflow, loop }, state?.head ?? started);
  }
  await handBackToMerge(inputs, live, pr, loop);
};

/**
 * The pull request as it is now, once its label is off. A 404 is a pull
 * request that is gone, and anything else is a read that failed.
 */
const readLive = async (io: Io, pr: number): Promise<Live> => {
  try {
    return await io.github.pullRequest(pr);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return "gone";
    return { unread: describe(error) };
  }
};

/** The pull request as `readLive` read it: itself, gone, or why it could not be read. */
type Live = PullRequest | "gone" | { readonly unread: string };

/**
 * **The refresh hands back to the gate** (#589). A gate that asked for this
 * refresh ended there, and the gate this run's own push started may have
 * found the head before the arm was carried on to it, and waited. So on a
 * run that finished, on a pull request carrying `agent:merge`, the label is
 * re-added, removed first so the add fires (#236), with the loop's token,
 * since a label the workflow token adds starts nothing. That gate then
 * merges, waits, or disarms a resolution's head. A label the loop adds never
 * arms. A run that stopped hands back nothing: `agent:blocked` and the arm
 * are the maintainer's to act on. A pull request that could not be read is
 * said, on every path, since a skipped hand-back can leave the arm on with
 * nothing to re-start the gate.
 */
const handBackToMerge = async (inputs: Inputs, live: Live, pr: number, loop: Writer): Promise<void> => {
  if (live === "gone") return;
  // Unread is not "carries no agent:merge": the gate the refresh's push
  // started may have ended `wait`, and with no hand-back nothing re-starts it.
  if ("unread" in live) {
    console.log(
      `::warning::Could not read PR #${pr} (${live.unread}), so whether it carries ${MERGE_LABEL} could not be told, and it was not handed back to the merge gate. If it carries ${MERGE_LABEL}, remove it and add it again to re-start the gate.`,
    );
    return;
  }
  if (live.state !== "open" || !live.labels.includes(MERGE_LABEL)) return;
  if (inputs.LOOP_TOKEN === "" || (inputs.LOOP_TOKEN_SOURCE !== "app" && inputs.LOOP_TOKEN_SOURCE !== "pat")) {
    console.log(
      `::warning::PR #${pr} carries ${MERGE_LABEL}, but neither the loop's App nor AGENT_PAT is set, so it was not handed back to the merge gate: a label added with GITHUB_TOKEN starts nothing. Remove ${MERGE_LABEL} and add it again to re-start it.`,
    );
    return;
  }
  await tolerated(undefined, () => loop.removeLabel(pr, MERGE_LABEL));
  await tolerated(
    `PR #${pr} carries ${MERGE_LABEL}, and it could not be added again to hand the refreshed head back to the merge gate. Remove ${MERGE_LABEL} and add it again to re-start it.`,
    () => loop.addLabel(pr, MERGE_LABEL),
  );
};

/** The reasons a stopped run can give, each where its producer wrote one. */
interface Reasons {
  readonly prepare: string | undefined;
  readonly runner: string | undefined;
  readonly bundle: string | undefined;
  readonly publish: string | undefined;
}

/**
 * How the run ended, from what the adapter reported: the gate's decision,
 * result and merge, the agent's job's result, and the outcome of each of this
 * job's steps that runs before this one. A stopped run's `reason` is chosen
 * once the producers' files are read.
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
  // cancelled too, or may read as failed: so a cancel, and an agent's job that
  // failed with no reason, are measured against the time limit, which the
  // adapter measured. A reason file is not read on either; what wrote one was
  // stopped, not failing.
  const measured = (otherwise: string): string =>
    inputs.TIMED_OUT === "true"
      ? `It timed out after ${inputs.TIMEOUT_MINUTES} minutes. The repository variable \`AGENT_TIMEOUT_MINUTES\` raises the limit.`
      : otherwise;
  const stopped = (reason: (reasons: Reasons) => string): Ending => ({ kind: "stopped", reason });
  const conflicts = inputs.STATUS === "conflicts";
  // The download runs only where there was an agent's hand-over to fetch.
  const steps = [inputs.MINT_OUTCOME, conflicts ? inputs.DOWNLOAD_OUTCOME : "success", inputs.PUBLISH_OUTCOME];

  // The agent's job is skipped on a clean merge or an up-to-date branch,
  // which is not a failure: there was nothing for an agent to do.
  const agentDone = conflicts ? inputs.AGENT_RESULT === "success" : inputs.AGENT_RESULT === "skipped";
  if (inputs.GATE_RESULT === "success" && agentDone) {
    // What stopped is the first of this job's steps that did not succeed. A
    // step a cancel skipped did not fail. The mint wrote its reason where only
    // a step in its own job could read it, so the sentence is said here, word
    // for word as `.github/actions/loop-token` writes it, and a test holds the
    // two equal.
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
  // since its file is on its own runner; then `update-branch:prepare`'s, for
  // an agent's job that stopped before the runner started, then
  // `update-branch:bundle`'s, for one that failed only at the bundle, then the
  // runner's.
  const gate = inputs.GATE_RESULT === "failure" ? inputs.GATE_REASON.trim() : "";
  return stopped(({ prepare, runner, bundle }) => {
    const reason = gate || prepare?.trim() || bundle?.trim() || runner?.trim();
    if (reason !== undefined && reason !== "") return reason;
    return inputs.AGENT_RESULT === "failure" ? measured(NO_REASON) : NO_REASON;
  });
};

const CANCELLED = "It was cancelled before it finished, by hand or by GitHub.";
const NO_REASON = "It stopped without giving a reason. The workflow run's log has the details.";
export const MINT_FAILED =
  "Couldn't mint a token for the loop's GitHub App, so nothing was written with it. Check that `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` belong to the same App, and that the App is installed on this repository.";
const DOWNLOAD_FAILED = "The agent finished, but what it handed over could not be fetched from its job, so nothing was pushed or posted.";

/**
 * Each directory, read on its own: one whose file does not read is said and
 * read as empty, so a bad file costs the comment nothing another producer
 * gave it. `unread` says it was.
 */
const readEach = <F extends DirectoryFiles, const P extends FileParsers<F>>(
  declared: DirectoryInput<F>,
  dir: string,
  parsers: P & Readonly<Record<Exclude<keyof P, keyof F>, never>>,
): Partial<HandOver<F, P>> & { readonly unread: boolean } => {
  try {
    return { ...readDirectory(declared, dir, parsers), unread: false };
  } catch (error) {
    console.log(`::warning::${describe(error)} So it is read as not written.`);
    // Every file read as not written: each is one a producer writes only sometimes.
    const none: Partial<HandOver<F, P>> = {};
    return { ...none, unread: true };
  }
};

/**
 * What to do next, which depends on whether the branch moved. What can fail
 * after `update-branch:publish`'s push is its comment and the review it asks
 * for, and re-adding the label does nothing on a branch that is merged
 * already.
 */
const retryOf = (pushed: boolean): string =>
  pushed
    ? "The merge was pushed before it stopped, so running it again would do nothing. Fix the problem above."
    : `To try again, add \`${UPDATE_BRANCH_LABEL}\`.`;

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
  return `**\`${UPDATE_BRANCH_LABEL}\` stopped:** ${sentence}\n\n${runUrl === undefined ? "" : `[Workflow run](${runUrl}) · `}${retry}\n`;
};

/** The trigger label comes off however the run ends (#236), so it never outlives the run. */
const removeTrigger = (pr: number, workflow: Writer): Promise<boolean> =>
  tolerated(undefined, () => workflow.removeLabel(pr, UPDATE_BRANCH_LABEL));

/** The labels a run queued in this pull request's concurrency group carries. */
const TRIGGERS = [REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL];

/**
 * **A request made while this run worked is not lost**, as in
 * `review:conclude`, which carries the reasoning. Adding
 * `agent:update-branch` then fired nothing, since it was on. So where the
 * head moved on from `left`, the head this run left (the merge it pushed, or
 * the head it found up to date), it asks for its own step again, with the
 * loop's token, since a label added with the workflow token starts nothing.
 *
 * **Not while another trigger label is on**: that label is a run queued in the
 * group, whose waiting slot holds one run, and a request now would cancel it
 * while pending and leave its label on with nothing behind it.
 *
 * A pull request that cannot be read is not one whose head stayed put: a 404
 * is a pull request that is gone, and anything else is a read that failed,
 * and each is said in its own words (`readLive`). Neither blocks: the run
 * finished.
 */
const askAgainIfMoved = async (
  inputs: Inputs,
  live: Live,
  { pr, workflow, loop }: { pr: number; workflow: Writer; loop: Writer },
  left: string,
): Promise<void> => {
  if (live === "gone") {
    console.log(`PR #${pr} is not there any more, so there is nothing to ask for again.`);
    return;
  }
  if ("unread" in live) {
    console.log(
      `::warning::Could not read PR #${pr} to tell whether its head moved on from ${left} while this run worked: ${live.unread} If it did, add ${UPDATE_BRANCH_LABEL} by hand to refresh the new head.`,
    );
    return;
  }
  if (live.state !== "open" || live.headSha === left) return;
  const head = live.headSha;
  const busy = live.labels.filter((label) => TRIGGERS.includes(label)).join(",");
  if (busy !== "") {
    console.log(
      `::notice::PR #${pr} moved on to ${head} while this run left ${left}, but it carries ${busy}, so ${UPDATE_BRANCH_LABEL} was not asked for again: that run is queued, and a new one would cancel it and leave its label on with no run behind it. Add ${UPDATE_BRANCH_LABEL} by hand once ${busy} is off, if the new head still needs it.`,
    );
    return;
  }
  if (inputs.LOOP_TOKEN === "" || (inputs.LOOP_TOKEN_SOURCE !== "app" && inputs.LOOP_TOKEN_SOURCE !== "pat")) {
    console.log(
      `::warning::PR #${pr} moved on to ${head} while this run left ${left}, but neither the loop's App nor AGENT_PAT is set, so ${UPDATE_BRANCH_LABEL} was not asked for again: a label added with GITHUB_TOKEN starts nothing. Add ${UPDATE_BRANCH_LABEL} by hand to refresh the new head.`,
    );
    await tolerated("…and that could not be said on the pull request either.", () =>
      workflow.comment(
        pr,
        `This PR moved on to \`${head}\` while \`${UPDATE_BRANCH_LABEL}\` worked on \`${left}\`. No refresh of the new head will start on its own: neither the loop's App nor \`AGENT_PAT\` is set, and a label added with \`GITHUB_TOKEN\` starts nothing. Add \`${UPDATE_BRANCH_LABEL}\` by hand to refresh it.`,
      ),
    );
    return;
  }
  await tolerated(
    `PR #${pr} moved on to ${head} while this run left ${left}, and ${UPDATE_BRANCH_LABEL} could not be added again. Add it by hand to refresh the new head.`,
    () => loop.addLabel(pr, UPDATE_BRANCH_LABEL),
  );
};

/**
 * What conclude may write, and how many of each (ADR 0005): two comments (the
 * failure comment, and the note that the head moved with no token to ask
 * again; never both), `agent:update-branch` off and `agent:merge` before it
 * is added again, and two labels added (`agent:blocked`, or
 * `agent:update-branch` asked for again and `agent:merge` handed back).
 */
const LIMITS: Limits = { comment: 2, removeLabel: 2, addLabel: 2 };

const FLAG = choice([true, false]);

const commit = (value: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`HEAD_SHA is ${JSON.stringify(value)}, which is not a full commit id.`);
  return value;
};
