import * as path from "node:path";
import { GitHubError } from "../engine/github.js";
import { WriteFailed, type Lease, type Limits, type Writer } from "../engine/writer.js";
import { checkBundle } from "../shared/bundle.js";
import { describe, inWriteLog, issueNumber, tolerated } from "../shared/command-helpers.js";
import type { CheckoutIo } from "../shared/command-io.js";
import { COMMANDS, type DirectoryFiles, type DirectoryInput } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { choice, count, json, matching, object, optional, readDirectory, text, type FileParsers, type HandOver, type Parser } from "../shared/hand-over.js";
import { loopAccounts } from "../shared/loop-accounts.js";
import { BLOCKED_LABEL, IMPLEMENT_LABEL, REVIEW_LABEL, USAGE_LIMIT } from "../shared/record.js";
import { limitEnding } from "../shared/usage-limit.js";
import { present, rescueIgnored, setAsideNote } from "./hand-over.js";

type Declared = (typeof COMMANDS)["implement:conclude"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CheckoutIo<Declared["outputs"]>;

/**
 * `implement:conclude` (#493): how every implement run ends, success
 * included. It runs `always()`, after `implement:publish`, and writes in the
 * loop's one order (#236): every result posted, then `agent:implement` off,
 * then `agent:blocked` where the run stopped.
 *
 * - **A rescue the runner set aside** (#270) is said on the issue however the
 *   run ended, so work nobody built on is not dropped silently. Publish never
 *   says it, so this is the one place it is said.
 * - **A run that finished**, `implement:publish` included: `agent:implement`
 *   off, again where publish took it off already, since publish's removal is
 *   tolerated. Every other word of a finished run is publish's.
 * - **A run that stopped**, any of its three jobs, after a gate that decided
 *   the issue was its own: its commits rescued, where nothing was pushed to
 *   `BRANCH` (#270); the failure comment, with the reason and the retry,
 *   naming the rescue; `agent:implement` off; `agent:blocked`. Where publish
 *   opened a pull request before it stopped, the comment names it and says to
 *   add `agent:review` on it, since a retry would be refused for it.
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
 * off, and a rescue that fails is said and skipped.
 */
export const conclude = async (inputs: Inputs, io: Io): Promise<void> => {
  const issue = issueNumber(inputs.ISSUE_NUMBER);
  const accounts = loopAccounts(inputs.AGENT_LOOP_LOGINS);
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
  // The runner's two files each on their own, since the agent's runner can
  // write anything into either: a set-aside note that does not read must not
  // cost the comment the reason beside it.
  const ran = readEach(declared.IMPLEMENT_DIR, inputs.IMPLEMENT_DIR, { "failure_reason.txt": text, "rescue_ignored.json": SKIPPED });
  const setAside = readEach(declared.IMPLEMENT_DIR, inputs.IMPLEMENT_DIR, {
    "failure_reason.txt": SKIPPED,
    "rescue_ignored.json": rescueIgnored(inputs.RESCUE_BRANCH),
  })["rescue_ignored.json"];
  const bundled = readEach(declared.BUNDLE_DIR, inputs.BUNDLE_DIR, { "branch.bundle": present, "failure_reason.txt": text });

  const { workflow, loop } = io.writers(LIMITS);
  const state = published["published.json"];

  if (setAside !== undefined) {
    await tolerated(`Could not say on #${issue} that ${setAside.branch} was set aside.`, () =>
      workflow.comment(issue, setAsideNote(setAside.branch, inputs.BASE_REF)),
    );
  }

  if (ending.kind === "finished") {
    // Publish takes the label off before it asks for the review (#236), but
    // that removal is tolerated and may have failed, so it comes off here
    // again, as on every decided run: removing a label that is absent is
    // already done.
    await removeTrigger(issue, workflow);
    return;
  }

  const reason = ending.reason({
    runner: ran["failure_reason.txt"],
    prepare: prepared["failure_reason.txt"],
    bundle: bundled["failure_reason.txt"],
    publish: published["failure_reason.txt"],
  });
  const saved =
    ending.kind === "stopped" && state?.pushed !== true
      ? await rescueCommits(inputs, io, loop, bundled["branch.bundle"] !== undefined, bundled["failure_reason.txt"] !== undefined)
      : ({ kind: "none" } as const);
  // The plan's usage limit (#635), on a run that decided and left nothing on
  // the record but its rescue: a wait, which resumes by itself on the service,
  // label on and nothing blocked, and builds on the rescue when it does.
  const limited =
    ending.kind !== "stopped" || state?.pushed === true || state?.pr !== undefined
      ? undefined
      : await limitEnding({ reason, orchestrator: inputs.ORCHESTRATOR, item: issue, label: IMPLEMENT_LABEL, github: io.github, accounts, now: new Date() });
  if (limited?.kind === "resumes") {
    await tolerated(`Could not post the usage-limit comment on #${issue}.`, () =>
      workflow.comment(issue, USAGE_LIMIT.resumes(IMPLEMENT_LABEL, limited.until, limited.stopped)),
    );
    return;
  }
  const comment =
    limited === undefined
      ? failureComment(inputs, reason, retryOf(ending.kind === "undecided", state?.pr, saved, inputs.RESCUE_BRANCH))
      : USAGE_LIMIT.waits(IMPLEMENT_LABEL, limited.until, inputs.RUN_URL);
  await tolerated(`Could not post the failure comment on #${issue}.`, () => workflow.comment(issue, comment));
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

/** A file of a directory read on its own, by another call. */
const SKIPPED: Parser<undefined> = () => undefined;

/**
 * What became of a stopped run's commits: none to save, saved, or not saved,
 * with `why` the clause the failure comment gives for it.
 */
type Saved = { readonly kind: "none" } | { readonly kind: "rescued" } | { readonly kind: "unsaved"; readonly why: string };

/**
 * **A stopped run's commits, kept on a side branch** (#270), as fix and
 * implement-prd keep theirs (#303): the rescue branch, keyed to the issue's
 * number so a retitled issue still finds it, and never `BRANCH`, which
 * `implement:publish` pushes leased on the tip the gate read. Rescued work
 * reaches a pull request only through the resumed run's own push, after its
 * verify. Nothing else: no pull request, no review asked for, no label.
 *
 * Only where nothing was pushed to `BRANCH`, which the caller checks, and
 * where there is a bundle: none is a run with no commits ahead of the base it
 * started from, unless `implement:bundle` failed, was stopped before it
 * wrote anything (`BUNDLE_OUTCOME`), or the hand-over could not be fetched,
 * when what the run made is unknown and said to be unsaved. The
 * bundle is checked as `implement:publish` checks it, and one that fails a
 * check is not rescued.
 *
 * **Every way the commits go unsaved is said in the comment**, with why
 * (#270): a retry that read as though there were none would start over
 * without them, and nobody would look for them in the log.
 *
 * Under a lease on the rescue as it is read here: a run that stops again
 * overwrites the earlier rescue, which it started from and so holds all of,
 * and nothing that moved it in between is lost silently. With the loop's
 * token, as publish pushes, since the agent's commits may touch a workflow
 * file; a mint that failed leaves none to push with, which the comment says.
 */
const rescueCommits = async (inputs: Inputs, io: Io, loop: Writer, bundled: boolean, bundleFailed: boolean): Promise<Saved> => {
  const rescue = inputs.RESCUE_BRANCH;
  if (!bundled) {
    if (bundleFailed) {
      console.log(`::warning::The agent's commits could not be bundled, so none were saved on ${rescue}.`);
      return { kind: "unsaved", why: UNBUNDLED };
    }
    if (inputs.DOWNLOAD_OUTCOME === "failure") {
      console.log(`::warning::What the agent's job handed over could not be fetched, so no commits were saved on ${rescue}.`);
      return { kind: "unsaved", why: UNFETCHED };
    }
    // A bundle step ended before it wrote anything, by its time limit, a
    // cancel, or a failure before the command could write its reason: what
    // the run made is unknown, not none.
    if (inputs.BUNDLE_OUTCOME === "cancelled") {
      console.log(`::warning::The agent's commits were not bundled before the bundle step was stopped, so none were saved on ${rescue}.`);
      return { kind: "unsaved", why: UNFINISHED };
    }
    if (inputs.BUNDLE_OUTCOME === "failure") {
      console.log(`::warning::The agent's commits could not be bundled, so none were saved on ${rescue}.`);
      return { kind: "unsaved", why: UNBUNDLED };
    }
    console.log("No commits ahead of the base this run started from, so there is nothing to rescue.");
    return { kind: "none" };
  }
  // The token first: with none there is nothing to push with whatever the
  // bundle holds, and a check that failed for another reason would hide that
  // the commits went unsaved.
  if (inputs.LOOP_TOKEN === "" || inputs.MINT_OUTCOME !== "success") {
    console.log(`::warning::The loop's token was not minted, so the agent's commits were not saved on ${rescue}.`);
    return { kind: "unsaved", why: NO_TOKEN };
  }
  let tip: string;
  try {
    tip = await checkBundle(io.git, path.join(inputs.BUNDLE_DIR, "branch.bundle"), inputs.BRANCH, inputs.BASE_SHA, "rescued", `\`${inputs.BASE_REF}\``);
  } catch (error) {
    console.log(`::warning::${describe(error)}`);
    return { kind: "unsaved", why: UNCHECKED(inputs.BASE_REF) };
  }

  let lease: Lease;
  try {
    lease = { tip: await io.github.branchTip(rescue) };
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) {
      console.log(`::warning::Could not read ${rescue}, so the agent's commits were not saved there: ${describe(error)}`);
      return { kind: "unsaved", why: UNREAD };
    }
    lease = { absent: true };
  }
  try {
    await loop.pushRef({ ref: `refs/heads/${rescue}`, commit: tip, lease });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::${inWriteLog(`Could not push the agent's commits to ${rescue}, so nothing was rescued.`)}`);
    return { kind: "unsaved", why: UNPUSHED };
  }
  console.log(`Rescued the agent's commits, up to ${tip}, to ${rescue}.`);
  return { kind: "rescued" };
};

/** Why a stopped run's commits went unsaved, each as the comment says it after "were not saved on `<rescue>`:". */
const NO_TOKEN = "the loop's token was not minted, so there was nothing to push them with.";
const UNBUNDLED = "the agent's job could not bundle them, and the workflow run's log says why.";
const UNFINISHED = "the agent's job was stopped before it finished bundling them, and the workflow run's log says why.";
const UNFETCHED = "what the agent's job handed over could not be fetched, so there were none to push.";
const UNCHECKED = (base: string): string => `they could not be checked against \`${base}\` before the push, and the workflow run's log says why.`;
const UNREAD = "GitHub would not say whether the branch already holds commits, so pushing could have overwritten them.";
const UNPUSHED = "GitHub refused the push, and the workflow run's log says why.";

/**
 * What to do next. The label comes off at the end of a decided run since
 * #236, so adding it is the retry. Not after a gate that died before
 * deciding: that run leaves the label on, and adding a label that is already
 * there fires no event. And not where publish opened the pull request before
 * it stopped: the gate refuses an issue an open pull request closes, so the
 * way on is that pull request's review.
 *
 * A rescue is named whatever else the retry says, and is the retry where
 * nothing else was: adding the label resumes from it (#270). Where commits
 * went unsaved, for whatever reason, the comment says so, and why.
 */
const retryOf = (undecided: boolean, pr: number | undefined, saved: Saved, rescue: string): string => {
  const plain = `To try again, add \`${IMPLEMENT_LABEL}\`.`;
  const retry =
    pr !== undefined
      ? `It opened PR #${pr} before it stopped, so adding \`${IMPLEMENT_LABEL}\` again would be refused. Fix the problem above, then add \`${REVIEW_LABEL}\` to PR #${pr}.`
      : undecided
        ? `To try again, remove \`${IMPLEMENT_LABEL}\` if it is still on this issue, then add it.`
        : plain;
  if (saved.kind === "rescued") {
    return retry === plain
      ? `Its commits so far are saved on \`${rescue}\`. To resume from them, add \`${IMPLEMENT_LABEL}\`.`
      : `${retry} Its commits so far are saved on \`${rescue}\`, and adding \`${IMPLEMENT_LABEL}\` resumes from them.`;
  }
  if (saved.kind === "unsaved") return `${retry} Its commits were not saved on \`${rescue}\`: ${saved.why}`;
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
  return `**\`${IMPLEMENT_LABEL}\` stopped:** ${sentence}\n\n[Workflow run](${inputs.RUN_URL}) · ${retry}\n`;
};

/**
 * The trigger label comes off however a decided run ends (#236), so it never
 * outlives the run that decided the issue was its own.
 */
const removeTrigger = (issue: number, workflow: Writer): Promise<boolean> =>
  tolerated(undefined, () => workflow.removeLabel(issue, IMPLEMENT_LABEL));

/**
 * What conclude may write, and how many of each (ADR 0005): with the
 * workflow's token, the set-aside note and the failure comment,
 * `agent:implement` off and `agent:blocked` on; with the loop's, the rescue
 * push.
 */
const LIMITS: Limits = { comment: 2, removeLabel: 1, addLabel: 1, pushRef: 1 };

const FLAG = choice([true, false]);

