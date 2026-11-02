import * as path from "node:path";
import type { GitFetcher } from "../engine/git.js";
import { GitHubError } from "../engine/github.js";
import { WriteFailed, type Lease, type Limits, type Writer } from "../engine/writer.js";
import { checkBundle } from "../shared/bundle.js";
import { describe, inWriteLog, issueNumber, tolerated } from "../shared/command-helpers.js";
import type { CheckoutIo } from "../shared/command-io.js";
import { COMMANDS, type DirectoryFiles, type DirectoryInput } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { choice, count, json, matching, object, optional, readDirectory, text, type FileParsers, type Parser } from "../shared/hand-over.js";
import { loopAccounts } from "../shared/loop-accounts.js";
import { readBranchLog } from "../shared/prd-round.js";
import { renderPrdStatus, renderProgressList, spliceProgressList, spliceStatus, statusBlock, type ProgressInputs } from "../shared/progress-list.js";
import { BLOCKED_LABEL, FIX_LABEL, IMPLEMENT_LABEL, PROGRESS_END, PROGRESS_START, REVIEW_LABEL, USAGE_LIMIT } from "../shared/record.js";
import { roundCounts, type RoundCounts } from "../shared/round-header.js";
import { sliceRanges } from "../shared/slice-ranges.js";
import { limitEnding, type LimitEnding } from "../shared/usage-limit.js";
import { present, rescueIgnored, setAsideNote, SNAPSHOT } from "./hand-over.js";

type Declared = (typeof COMMANDS)["implement-prd:conclude"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CheckoutIo<Declared["outputs"]> & { readonly fetcher: GitFetcher };

/**
 * `implement-prd:conclude` (#505): how every implement-prd run ends, success
 * included. It runs `always()`, after `implement-prd:publish`, and writes in
 * the loop's one order (#236): every result posted, then `agent:implement`
 * off, then `agent:blocked` where the run stopped, then the progress list,
 * which is a view of the chain.
 *
 * - **A rescue the runner set aside** (#303) is said on the PRD however the
 *   run ended, so work nobody built on is not dropped silently. Publish never
 *   says it, so this is the one place it is said.
 * - **A run that finished**, publish included: `agent:implement` off, again
 *   where publish took it off already, since publish's removal is tolerated
 *   (#494's review finding). Every other word of a finished run is
 *   publish's.
 * - **A chain the catch-up parked**: the catch-up said why and took the
 *   label off. The label comes off again, and the stopped slice's row is
 *   written back, since the gate showed it building.
 * - **A run that stopped**, any of its four jobs, after a gate that decided:
 *   its commits rescued, where nothing was pushed to the PRD branch; the
 *   failure comment, with the reason and the retry the ending calls for;
 *   `agent:implement` off; `agent:blocked`; and, on a build, the stopped
 *   slice's row.
 * - **A run the plan's usage limit stopped** (#635), after a gate that
 *   decided, where nothing was pushed: its commits rescued and the stopped
 *   slice's row written, as for any stop. On the service, the comment on the
 *   parent saying it will resume after the reset: `agent:implement` stays on
 *   and `agent:blocked` is not added, since the service resumes it. On
 *   Actions, the comment giving the reset time and saying to add the label
 *   after it, then `agent:implement` off and `agent:blocked`. A second such
 *   stop with no add of the label since the first ends as a run that stopped.
 * - **A gate that died before deciding**, in either shape (no `gate.json`, or
 *   one with no `proceed`, both of which leave `REFUSED` empty): the failure
 *   comment, with the retry that says to remove the label first, and
 *   `agent:blocked`, but **`agent:implement` stays on**. That run may have
 *   been the one that would have deferred, and `agent-implement` owns that
 *   label event and holds the label while it works.
 *
 * **The stopped slice's row** is rendered from the PRD branch as it stands
 * after the run, read off its trailers, not from a copy of the list the gate
 * replaced (#325): after a catch-up merge was pushed and nothing else was,
 * the PRD PR's head is that merge, which no review has seen, so the slice
 * under review shows parked, as the failure comment says, not approved.
 *
 * What ran and how it ended are inputs, each job's result and each step's
 * outcome as the adapter saw it, and this works out the ending from them.
 * Every file it reads, it reads from its producer's own directory, one file
 * at a time (ADR 0006): a file that does not read is said and read as not
 * written, so it cannot cost the comment what another file gave it.
 *
 * Every write is tolerated, as the shell before it tolerated each with
 * `|| true` or a warning: a run that cannot comment still takes its label
 * off, and a rescue that fails is said and skipped.
 */
export const conclude = async (inputs: Inputs, io: Io): Promise<void> => {
  const parent = issueNumber(inputs.ISSUE_NUMBER);
  const ending = endingOf(inputs);
  if (ending.kind === "refused") {
    // The gate said it and took the label off, or deferred and must say nothing.
    console.log("The gate refused or deferred this run, so there is nothing to conclude.");
    return;
  }

  // Every file, each on its own, before the first write.
  const declared = COMMANDS["implement-prd:conclude"].inputs;
  const reasons: Reasons = {
    catchUp: readFile(declared.CATCH_UP_DIR, inputs.CATCH_UP_DIR, "failure_reason.txt", text),
    runner: readFile(declared.IMPLEMENT_PRD_DIR, inputs.IMPLEMENT_PRD_DIR, "failure_reason.txt", text),
    publish: readFile(declared.PUBLISH_DIR, inputs.PUBLISH_DIR, "failure_reason.txt", text),
    prepare: readFile(declared.PREPARE_DIR, inputs.PREPARE_DIR, "failure_reason.txt", text),
    bundle: readFile(declared.BUNDLE_DIR, inputs.BUNDLE_DIR, "failure_reason.txt", text),
  };
  const setAside = readFile(declared.IMPLEMENT_PRD_DIR, inputs.IMPLEMENT_PRD_DIR, "rescue_ignored.json", rescueIgnored(inputs.RESCUE_BRANCH));
  const state = readFile(declared.PUBLISH_DIR, inputs.PUBLISH_DIR, "published.json", PUBLISHED);
  const bundled = readFile(declared.BUNDLE_DIR, inputs.BUNDLE_DIR, "branch.bundle", present) === true;
  const snapshot = readFile(declared.GATE_DIR, inputs.GATE_DIR, "prd-issue.json", SNAPSHOT);

  const { workflow, loop } = io.writers(LIMITS);

  if (setAside !== undefined) {
    await tolerated(`Could not say on #${parent} that ${setAside.branch} was set aside.`, () =>
      workflow.comment(parent, setAsideNote(setAside.branch)),
    );
  }

  const decided = inputs.REFUSED === "false";
  const pushed = state?.pushed === true;
  let limited: LimitEnding | undefined;
  if (ending.kind === "undecided" || ending.kind === "stopped") {
    const rescued = ending.kind === "stopped" && inputs.BUILD === "true" && !pushed && (await rescueCommits(inputs, io, loop, bundled));
    const reason = ending.reason(reasons);
    // The plan's usage limit (#635), on a build that decided and pushed
    // nothing: a wait, which resumes by itself on the service, the parent's
    // label on and nothing blocked, and builds on the rescue when it does.
    limited =
      ending.kind !== "stopped" || pushed
        ? undefined
        : await limitEnding({
            reason,
            orchestrator: inputs.ORCHESTRATOR,
            item: parent,
            label: IMPLEMENT_LABEL,
            github: io.github,
            accounts: loopAccounts(inputs.AGENT_LOOP_LOGINS),
            now: new Date(),
          });
    const comment =
      limited === undefined
        ? failureComment(inputs, reason, retryOf(inputs, ending.kind === "undecided", pushed, state?.pr ?? prdPr(inputs), rescued))
        : limited.kind === "resumes"
          ? USAGE_LIMIT.resumes(IMPLEMENT_LABEL, limited.until, limited.stopped)
          : USAGE_LIMIT.waits(IMPLEMENT_LABEL, limited.until, inputs.RUN_URL);
    await tolerated(`Could not post the failure comment on #${parent}.`, () => workflow.comment(parent, comment));
  }
  const waiting = limited?.kind === "resumes";
  if (decided && !waiting) await tolerated(undefined, () => workflow.removeLabel(parent, IMPLEMENT_LABEL));
  if ((ending.kind === "undecided" || ending.kind === "stopped") && !waiting) await tolerated(undefined, () => workflow.addLabel(parent, BLOCKED_LABEL));

  if (decided && inputs.BUILD === "true" && ending.kind !== "finished") {
    await showStopped(inputs, io, loop, { pr: state?.pr ?? prdPr(inputs), pushed, subIssues: snapshot?.subIssues.nodes });
  }
};

/** The reasons a stopped run can give, each where its producer wrote one. */
interface Reasons {
  readonly catchUp: string | undefined;
  readonly runner: string | undefined;
  readonly publish: string | undefined;
  readonly prepare: string | undefined;
  readonly bundle: string | undefined;
}

/**
 * How the run ended, from what the adapter reported: the gate's decision,
 * result and reason, the catch-up's and the agent's job's results, whether
 * the agent's job timed out, and the outcome of the mint, the download and
 * publish. A stopped run's `reason` is chosen once the producers' files are
 * read.
 */
type Ending =
  | { readonly kind: "refused" | "finished" | "parked" }
  | { readonly kind: "undecided" | "stopped"; readonly reason: (reasons: Reasons) => string };

const endingOf = (inputs: Inputs): Ending => {
  if (inputs.REFUSED === "true") return { kind: "refused" };
  // `REFUSED` is empty where the gate died, or was cancelled, before it
  // decided: whether this run was ever the PRD's is not known.
  const kind = inputs.REFUSED === "false" ? "stopped" : "undecided";
  const ended = (result: string): boolean => result === "failure" || result === "cancelled";
  // The download is tolerated, so its failure stops nothing by itself:
  // publish, finding no bundle, says so.
  const steps = [inputs.MINT_OUTCOME, inputs.PUBLISH_OUTCOME];
  // Fail closed, as `implement:conclude` does: a run finished only where
  // every step it needed says `success`. A publish skipped because the
  // checkout or the Node setup before it failed is `skipped`, not `failure`,
  // and must not read as a run that finished. The one skip that is an ending
  // of its own is the park: a build whose catch-up succeeded and whose
  // agent's job, and so publish, never ran.
  if (kind === "stopped" && inputs.GATE_RESULT === "success" && inputs.MINT_OUTCOME === "success") {
    const build = inputs.BUILD === "true";
    if (build && inputs.CATCH_UP_RESULT === "success" && inputs.AGENT_RESULT === "skipped" && inputs.PUBLISH_OUTCOME === "skipped") {
      return { kind: "parked" };
    }
    const jobsRan = build
      ? inputs.CATCH_UP_RESULT === "success" && inputs.AGENT_RESULT === "success"
      : !ended(inputs.CATCH_UP_RESULT) && !ended(inputs.AGENT_RESULT);
    if (jobsRan && inputs.PUBLISH_OUTCOME === "success") return { kind: "finished" };
  }

  // Cancelled is not failed (#220), and a job that reached its limit is
  // cancelled too, or may read as failed: so a cancel, and an agent's job that
  // failed with no reason, are measured against the time limit, which the
  // agent's job measured. A reason file is not read on a cancel; what wrote
  // one was stopped, not failing.
  const measured = (otherwise: string): string =>
    inputs.TIMED_OUT === "true"
      ? `It timed out after ${inputs.TIMEOUT_MINUTES} minutes. The repository variable \`AGENT_TIMEOUT_MINUTES\` raises the limit.`
      : otherwise;
  if ([inputs.GATE_RESULT, inputs.CATCH_UP_RESULT, inputs.AGENT_RESULT, ...steps].includes("cancelled")) {
    return { kind, reason: () => measured(CANCELLED) };
  }

  // The first reason given, in the order the shell failure step before this
  // read them: the gate's, which its job hands on as an output since its file
  // is on its own runner, the catch-up's, the runner's, publish's, then
  // `implement-prd:prepare`'s and `implement-prd:bundle`'s. Then the mint's,
  // which wrote its reason where only a step in its own job could read it, so
  // the sentence is said here, word for word as `.github/actions/loop-token`
  // writes it, and a test holds the two equal. Then a hand-over that could
  // not be fetched, where the agent finished.
  return {
    kind,
    reason: ({ catchUp, runner, publish, prepare, bundle }) => {
      const given = [inputs.GATE_REASON, catchUp, runner, publish, prepare, bundle].map((r) => r?.trim()).find((r) => r !== undefined && r !== "");
      if (given !== undefined) return given;
      if (inputs.MINT_OUTCOME === "failure") return MINT_FAILED;
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
 * `name` in `declared`'s directory, read on its own: one that does not read
 * is said and read as not written, so it costs nothing another file gave.
 */
const readFile = <F extends DirectoryFiles, T>(declared: DirectoryInput<F>, dir: string, name: keyof F & string, parser: Parser<T>): T | undefined => {
  const parsers: FileParsers<DirectoryFiles> = Object.fromEntries(Object.keys(declared.files).map((file) => [file, file === name ? parser : SKIPPED]));
  try {
    return readDirectory<DirectoryFiles, FileParsers<DirectoryFiles>>(declared, dir, parsers)[name] as T | undefined;
  } catch (error) {
    console.log(`::warning::${describe(error)} So it is read as not written.`);
    return undefined;
  }
};

const SKIPPED: Parser<undefined> = () => undefined;

/** The PRD PR the gate found, where it found one. */
const prdPr = (inputs: Inputs): number | undefined => (/^[1-9][0-9]{0,9}$/.test(inputs.PRD_PR) ? Number(inputs.PRD_PR) : undefined);

/**
 * **A stopped run's commits, kept on a side branch** (#303): the rescue
 * branch, with a fixed name, and never the PRD branch. A commit pushed there
 * would stand on the PRD PR's head unverified, with no verdict and without the
 * `Agent-Slice` trailer `implement-prd:publish` gives a finished run's, so
 * rescued work reaches the PRD branch only through the resumed run's own
 * push, after its verify. Nothing else: no PRD PR, no review asked for, no
 * label.
 *
 * Only on a build where nothing was pushed to the PRD branch, which the
 * caller checks, and where there is a bundle: none is a run with no commits
 * ahead of the tip it started from. The bundle is checked as publish checks
 * it, and one that fails a check is not rescued.
 *
 * Under a lease on the rescue as it is read here: a run that stops again
 * overwrites the earlier rescue, which it started from and so holds all of,
 * and nothing that moved it in between is lost silently. With the loop's
 * token, as the PRD branch is pushed, since the agent's commits may touch a
 * workflow file. Whether it rescued them, which the comment says.
 */
const rescueCommits = async (inputs: Inputs, io: Io, loop: Writer, bundled: boolean): Promise<boolean> => {
  if (!bundled) {
    console.log("No commits ahead of the tip this run started from, so there is nothing to rescue.");
    return false;
  }
  const rescue = inputs.RESCUE_BRANCH;
  if (inputs.LOOP_TOKEN === "" || inputs.MINT_OUTCOME !== "success") {
    console.log(`::warning::The loop's token was not minted, so the agent's commits were not saved on ${rescue}.`);
    return false;
  }
  let tip: string;
  try {
    tip = await checkBundle(io.git, path.join(inputs.BUNDLE_DIR, "branch.bundle"), inputs.PRD_BRANCH, inputs.BASE_SHA, "rescued", `\`${inputs.PRD_BRANCH}\``);
  } catch (error) {
    console.log(`::warning::${describe(error)}`);
    return false;
  }

  let lease: Lease;
  try {
    lease = { tip: await io.github.branchTip(rescue) };
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) {
      console.log(`::warning::Could not read ${rescue}, so the agent's commits were not saved there: ${describe(error)}`);
      return false;
    }
    lease = { absent: true };
  }
  try {
    await loop.pushRef({ ref: `refs/heads/${rescue}`, commit: tip, lease });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::${inWriteLog(`Could not push the agent's commits to ${rescue}, so nothing was rescued.`)}`);
    return false;
  }
  console.log(`Rescued the agent's commits, up to ${tip}, to ${rescue}.`);
  return true;
};

/**
 * What to do next (#105), which depends on what the run left behind. The
 * label comes off at the end of a decided run since #236, so adding it is the
 * retry, and the rest are the ways it is not:
 *
 * - The finishing run built nothing, so there is no sub-issue to retry; a
 *   retry resumes the hand-over, since its gate still passes, and says so.
 * - Not after a gate that died before deciding: that run leaves the label on,
 *   and adding a label that is already present fires no event.
 * - Not once the default branch is merged in and pushed, with the slice not:
 *   the PRD PR's head is then that merge, which no review has seen, so the
 *   gate refuses the retry. Its review is the way on, a round of the slice
 *   already built, whose approval moves the chain on by itself.
 * - Not once the slice is pushed: the PRD branch then holds it, so the retry
 *   does not build it again, and its gate refuses while the slice has no
 *   review. With no PRD PR open yet, the retry is still the remedy: it opens
 *   one and asks for the review, and builds nothing.
 *
 * A rescue is named whatever else the retry says, and is the retry where
 * nothing else was: adding the label resumes from it.
 */
const retryOf = (inputs: Inputs, undecided: boolean, pushed: boolean, pr: number | undefined, rescued: boolean): string => {
  const plain = `To try again, add \`${IMPLEMENT_LABEL}\`.`;
  let retry = plain;
  if (inputs.FINISHING === "true") retry = `To try again, add \`${IMPLEMENT_LABEL}\`; it resumes the handover and builds nothing.`;
  if (undecided) retry = `To try again, remove \`${IMPLEMENT_LABEL}\` if it is still on this issue, then add it.`;
  if (!pushed && inputs.MERGED !== "" && pr !== undefined) {
    retry = `The default branch \`${inputs.BASE_REF}\` was merged into the PRD branch before it stopped, and that merge has no review yet, so adding \`${IMPLEMENT_LABEL}\` would be refused. Add \`${REVIEW_LABEL}\` to PRD PR #${pr}; the chain moves on once it recommends approval.`;
  }
  if (pushed) {
    const built = `Sub-issue #${inputs.SUB} was built and pushed to the PRD branch before it stopped, so it won't be built again.`;
    retry =
      pr === undefined
        ? `${built} To open the PRD PR and ask for its review, add \`${IMPLEMENT_LABEL}\`.`
        : `${built} Add \`${REVIEW_LABEL}\` to PRD PR #${pr} if it doesn't have it.`;
  }
  if (!rescued) return retry;
  const rescue = inputs.RESCUE_BRANCH;
  return retry === plain
    ? `Its commits so far are saved on \`${rescue}\`. To resume from them, add \`${IMPLEMENT_LABEL}\`.`
    : `${retry} Its commits so far are saved on \`${rescue}\`, and the next \`${IMPLEMENT_LABEL}\` run resumes from them.`;
};

/**
 * One pattern for every run that stopped (#253): the reason as a sentence,
 * starting with a capital and ending in a full stop, and what the run was
 * doing, then the run and what to do.
 */
const failureComment = (inputs: Inputs, reason: string, retry: string): string => {
  const trimmed = reason.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const sentence = /[.!?]$/.test(capital) ? capital : `${capital}.`;
  const doing =
    inputs.FINISHING === "true"
      ? " It was handing the PRD PR over, with every sub-issue built."
      : inputs.SUB !== ""
        ? ` It was building sub-issue #${inputs.SUB}.`
        : "";
  return `**\`${IMPLEMENT_LABEL}\` stopped:** ${sentence}${doing}\n\n[Workflow run](${inputs.RUN_URL}) · ${retry}\n`;
};

/**
 * **The stopped slice in the progress list** (#246, #325). The gate showed
 * this sub-issue building in the PRD PR's progress list (#312), and a run that
 * parks, fails or is cancelled after that starts no round, so no advance job
 * writes the list again. This writes it back, rendered from the PRD branch as
 * it stands after the run, read off its trailers over the default branch,
 * with the gate's snapshot of the sub-issues and the PRD PR's rounds: the
 * sub-issue not started where nothing of it was pushed, and the slice under
 * review parked where this run pushed its slice, or pushed a catch-up merge
 * and nothing else, with its review the way on, as the comment says.
 * Otherwise the slice before it approved, which is what the gate built on.
 *
 * Only into a body that has a list: one that never had one never showed the
 * slice building. Spliced as every writer of the list splices it, with the
 * status line beside it, and half a list, or two, left alone with a warning.
 * Never fails the run: the list is a view of the chain.
 */
const showStopped = async (
  inputs: Inputs,
  io: Io,
  loop: Writer,
  run: { readonly pr: number | undefined; readonly pushed: boolean; readonly subIssues: ProgressInputs["subIssues"] | undefined },
): Promise<void> => {
  const { pr, pushed, subIssues } = run;
  if (pr === undefined) {
    console.log("No PRD PR shows this slice building, so no progress list is written.");
    return;
  }
  const still = `so its progress list still shows the slice building`;
  if (subIssues === undefined) {
    console.log(`::warning::The gate's snapshot of the PRD could not be read, ${still}.`);
    return;
  }
  if (inputs.LOOP_TOKEN === "" || inputs.MINT_OUTCOME !== "success") {
    console.log(`::warning::The loop's token was not minted, so PRD PR #${pr}'s progress list still shows the slice building.`);
    return;
  }
  let ranges;
  try {
    const base = await io.fetcher.fetchRef(`refs/heads/${inputs.BASE_REF}`, `refs/remotes/origin/${inputs.BASE_REF}`);
    const head = await io.fetcher.fetchRef(`refs/heads/${inputs.PRD_BRANCH}`, `refs/remotes/origin/${inputs.PRD_BRANCH}`);
    ranges = sliceRanges(await readBranchLog(io.git, base, head), subIssues);
  } catch (error) {
    console.log(`::warning::The PRD branch could not be read, ${still}: ${describe(error)}`);
    return;
  }
  let rounds: RoundCounts | undefined;
  try {
    const [reviews, fixes] = await Promise.all([io.github.reviews(pr), io.github.labelledAt(pr, FIX_LABEL)]);
    rounds = roundCounts({ reviews, fixes }, loopAccounts(inputs.AGENT_LOOP_LOGINS), ranges);
  } catch (error) {
    console.log(`::warning::The PRD PR's rounds could not be read, so the progress table does not count them: ${describe(error)}`);
  }
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = inputs;
  const progress: ProgressInputs = {
    subIssues,
    ranges,
    // The gate builds only past an approval, so the head it left is approved
    // unless this run moved it: its slice pushed, or a catch-up merge.
    verdict: pushed || inputs.MERGED !== "" ? "none" : "approval",
    running: null,
    finalReview: "not requested",
    prUrl: server !== "" && repo !== "" ? `${server}/${repo}/pull/${pr}` : undefined,
    rounds,
  };
  const list = renderProgressList(progress);
  const status = statusBlock(renderPrdStatus(progress));

  let half = false;
  let none = false;
  try {
    const edited = await loop.editPullRequest(pr, {
      body: (live) => {
        if (!live.includes(PROGRESS_START) && !live.includes(PROGRESS_END)) {
          none = true;
          return undefined;
        }
        const listed = spliceProgressList(live, list);
        if (listed === undefined) {
          half = true;
          return undefined;
        }
        return spliceStatus(listed, status) ?? listed;
      },
    });
    if (none) {
      console.log(`PRD PR #${pr}'s body carries no progress list, so none is written.`);
    } else if (half) {
      console.log(
        `::warning::PRD PR #${pr}'s body carries half a progress list, or two, so it was not written. Restore the missing marker, or delete the markers and the text between them, and the next ending of a round writes it again.`,
      );
    } else if (edited.outcome === "applied") {
      console.log(`Wrote PRD PR #${pr}'s progress list: the slice stopped${pushed ? " after its push" : ""}.`);
    }
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::${inWriteLog(`Could not write PRD PR #${pr}'s progress list, ${still}.`)}`);
  }
};

/**
 * What conclude may write, and how many of each (ADR 0005): with the
 * workflow's token, the set-aside note and the failure comment,
 * `agent:implement` off and `agent:blocked` on; with the loop's, the rescue
 * push and the stopped slice's row.
 */
const LIMITS: Limits = { comment: 2, removeLabel: 1, addLabel: 1, pushRef: 1, editPullRequest: 1 };

const FLAG = choice([true, false]);

/** `published.json`, as `implement-prd:publish` writes it. */
const PUBLISHED = json(
  object({
    pushed: FLAG,
    head: optional(matching(/[0-9a-f]{40}/, "a full commit id")),
    pr: optional(count({ min: 1, max: 9_999_999_999 })),
    requested: FLAG,
    handedOver: FLAG,
  }),
);
