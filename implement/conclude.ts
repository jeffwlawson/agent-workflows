import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import type { CommandIo } from "../shared/command-io.js";
import { COMMANDS, type DirectoryFiles, type DirectoryInput } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { choice, count, json, matching, object, optional, readDirectory, text, type FileParsers, type HandOver } from "../shared/hand-over.js";
import { BLOCKED_LABEL, IMPLEMENT_LABEL, REVIEW_LABEL } from "../shared/record.js";

type Declared = (typeof COMMANDS)["implement:conclude"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * `implement:conclude` (#493): how every implement run ends, success
 * included. It runs `always()`, after `implement:publish`, and writes in the
 * loop's one order (#236): the failure comment, then `agent:implement` off,
 * then `agent:blocked`.
 *
 * - **A run that finished**, `implement:publish` included: `agent:implement`
 *   off, where publish did not already take it off. Every other word of a
 *   finished run is publish's.
 * - **A run that stopped**, any of its three jobs, after a gate that decided
 *   the issue was its own: the failure comment, with the reason and the
 *   retry; `agent:implement` off; `agent:blocked`. Where publish opened a pull
 *   request before it stopped, the comment names it and says to add
 *   `agent:review` on it, since a retry would be refused for it.
 * - **A gate that died before deciding**: the failure comment, with the
 *   retry that says to remove the label first, and `agent:blocked`, but
 *   **`agent:implement` stays on**. That run may have been the one that
 *   would have deferred, and `agent-implement-prd` owns that label event and
 *   holds the label while it works.
 *
 * What ran and how it ended are inputs, each job's result and each step's
 * outcome as the adapter saw it, and this works out the ending from them.
 * What publish did, and the reasons `implement:prepare`, the runner,
 * `implement:bundle` and publish stopped with, it reads from each producer's
 * own directory (ADR 0006), each on its own: a file that does not read is
 * said and skipped, so it cannot cost the comment a reason another producer
 * gave.
 *
 * Every write is tolerated, as the shell before it tolerated each with
 * `|| true` or a warning: a run that cannot comment still takes its label
 * off.
 */
export const conclude = async (inputs: Inputs, io: Io): Promise<void> => {
  const issue = issueNumber(inputs.ISSUE_NUMBER);
  const ending = endingOf(inputs);
  if (ending.kind === "refused") {
    // The gate said it and took the label off, or deferred and must say nothing.
    console.log("The gate refused or deferred this run, so there is nothing to conclude.");
    return;
  }

  // What each producer left, read and checked before the first write.
  const declared = COMMANDS["implement:conclude"].inputs;
  const published = readEach(declared.PUBLISH_DIR, inputs.PUBLISH_DIR, {
    "published.json": json(
      object({
        pushed: FLAG,
        head: optional(matching(/[0-9a-f]{40}/, "a full commit id")),
        pr: optional(count({ min: 1, max: 9_999_999_999 })),
        requested: FLAG,
      }),
    ),
    "failure_reason.txt": text,
  });
  const prepared = readEach(declared.PREPARE_DIR, inputs.PREPARE_DIR, { "failure_reason.txt": text });
  const ran = readEach(declared.IMPLEMENT_DIR, inputs.IMPLEMENT_DIR, { "failure_reason.txt": text });
  const bundled = readEach(declared.BUNDLE_DIR, inputs.BUNDLE_DIR, { "failure_reason.txt": text });

  const { workflow } = io.writers(LIMITS);
  const state = published["published.json"];

  if (ending.kind === "finished") {
    // Publish takes the label off before it asks for the review (#236), so
    // there is nothing left to take off once it has asked.
    if (state?.requested === true) return;
    await removeTrigger(issue, workflow);
    return;
  }

  const reason = ending.reason({
    runner: ran["failure_reason.txt"],
    prepare: prepared["failure_reason.txt"],
    bundle: bundled["failure_reason.txt"],
    publish: published["failure_reason.txt"],
  });
  const retry = retryOf(ending.kind === "undecided", state?.pr);
  await tolerated(`Could not post the failure comment on #${issue}.`, () => workflow.comment(issue, failureComment(inputs, reason, retry)));
  if (ending.kind === "stopped") await removeTrigger(issue, workflow);
  await tolerated(undefined, () => workflow.addLabel(issue, BLOCKED_LABEL));
};

/** The reasons a stopped run can give, each where its producer wrote one. */
interface Reasons {
  readonly runner: string | undefined;
  readonly prepare: string | undefined;
  readonly bundle: string | undefined;
  readonly publish: string | undefined;
}

/**
 * How the run ended, from what the adapter reported: the gate's decision,
 * result and reason, the agent's job's result and whether it timed out, and
 * the outcome of each of this job's steps that runs before this one. A
 * stopped run's `reason` is chosen once the producers' files are read.
 */
type Ending =
  | { readonly kind: "refused" }
  | { readonly kind: "finished" }
  | { readonly kind: "undecided" | "stopped"; readonly reason: (reasons: Reasons) => string };

const endingOf = (inputs: Inputs): Ending => {
  if (inputs.REFUSED === "true") return { kind: "refused" };
  // `REFUSED` is empty where the gate died, or was cancelled, before it
  // decided: whether this run was ever the issue's is not known.
  const kind = inputs.REFUSED === "false" ? "stopped" : "undecided";
  const steps = [inputs.MINT_OUTCOME, inputs.DOWNLOAD_OUTCOME, inputs.PUBLISH_OUTCOME];
  if (kind === "stopped" && inputs.GATE_RESULT === "success" && inputs.AGENT_RESULT === "success" && steps.every((s) => s === "success")) {
    return { kind: "finished" };
  }

  // Cancelled is not failed (#220), and a job that reached its limit is
  // cancelled too, or may read as failed: so a cancel, and an agent's job that
  // failed with no reason, are measured against the time limit, which the
  // adapter measured. A reason file is not read on either; what wrote one was
  // stopped, not failing.
  const measured = (otherwise: string): string =>
    inputs.TIMED_OUT === "true"
      ? `It timed out after ${inputs.TIMEOUT_MINUTES} minutes. The repository variable \`AGENT_TIMEOUT_MINUTES\` raises the limit.`
      : otherwise;
  if (inputs.GATE_RESULT === "cancelled" || inputs.AGENT_RESULT === "cancelled" || steps.includes("cancelled")) {
    return { kind, reason: () => measured(CANCELLED) };
  }

  // The first reason file found, in the order the shell failure step before
  // this read them: the runner's, then `implement:prepare`'s, `implement:bundle`'s
  // and `implement:publish`'s. Then the mint's, which wrote its reason where
  // only a step in its own job could read it, so the sentence is said here,
  // word for word as `.github/actions/loop-token` writes it, and a test holds
  // the two equal. Then the gate's, which its job hands on as an output since
  // its file is on its own runner. Then a hand-over that could not be
  // fetched, where the agent finished.
  return {
    kind,
    reason: ({ runner, prepare, bundle, publish }) => {
      const filed = [runner, prepare, bundle, publish].map((r) => r?.trim()).find((r) => r !== undefined && r !== "");
      if (filed !== undefined) return filed;
      if (inputs.MINT_OUTCOME === "failure") return MINT_FAILED;
      const gate = inputs.GATE_REASON.trim();
      if (gate !== "") return gate;
      if (inputs.AGENT_RESULT === "failure") return measured(NO_REASON);
      if (inputs.AGENT_RESULT === "success" && inputs.DOWNLOAD_OUTCOME === "failure") return DOWNLOAD_FAILED;
      return NO_REASON;
    },
  };
};

const CANCELLED = "It was cancelled before it finished, by hand or by GitHub.";
const NO_REASON = "It stopped without giving a reason. The workflow run's log has the details.";
export const MINT_FAILED =
  "Couldn't mint a token for the loop's GitHub App, so nothing was written with it. Check that `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` belong to the same App, and that the App is installed on this repository.";
const DOWNLOAD_FAILED = "The agent finished, but what it handed over could not be fetched from its job, so nothing was pushed or posted.";

/**
 * Each directory, read on its own: one whose file does not read is said and
 * read as empty, so a bad file costs the comment nothing another producer
 * gave it.
 */
const readEach = <F extends DirectoryFiles, const P extends FileParsers<F>>(
  declared: DirectoryInput<F>,
  dir: string,
  parsers: P & Readonly<Record<Exclude<keyof P, keyof F>, never>>,
): Partial<HandOver<F, P>> => {
  try {
    return readDirectory(declared, dir, parsers);
  } catch (error) {
    console.log(`::warning::${describe(error)} So it is read as not written.`);
    // Every file read as not written: each is one a producer writes only sometimes.
    return {};
  }
};

/**
 * What to do next. The label comes off at the end of a decided run since
 * #236, so adding it is the retry. Not after a gate that died before
 * deciding: that run leaves the label on, and adding a label that is already
 * there fires no event. And not where publish opened the pull request before
 * it stopped: the gate refuses an issue an open pull request closes, so the
 * way on is that pull request's review.
 */
const retryOf = (undecided: boolean, pr: number | undefined): string => {
  if (pr !== undefined) {
    return `It opened PR #${pr} before it stopped, so adding \`${IMPLEMENT_LABEL}\` again would be refused. Fix the problem above, then add \`${REVIEW_LABEL}\` to PR #${pr}.`;
  }
  return undecided
    ? `To try again, remove \`${IMPLEMENT_LABEL}\` if it is still on this issue, then add it.`
    : `To try again, add \`${IMPLEMENT_LABEL}\`.`;
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
  return `**\`${IMPLEMENT_LABEL}\` stopped:** ${sentence}\n\n[Workflow run](${inputs.RUN_URL}) · ${retry}\n`;
};

/**
 * The trigger label comes off however a decided run ends (#236), so it never
 * outlives the run that decided the issue was its own.
 */
const removeTrigger = (issue: number, workflow: Writer): Promise<void> =>
  tolerated(undefined, () => workflow.removeLabel(issue, IMPLEMENT_LABEL));

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
 * What conclude may write, and how many of each (ADR 0005): the failure
 * comment, `agent:implement` off, and `agent:blocked` on.
 */
const LIMITS: Limits = { comment: 1, removeLabel: 1, addLabel: 1 };

const FLAG = choice([true, false]);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const issueNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`ISSUE_NUMBER is ${JSON.stringify(value)}, which is not an issue number.`);
  return Number(value);
};
