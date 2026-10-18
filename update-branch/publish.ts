import * as path from "node:path";
import { BaseMoved, FetchFailed, GitError } from "../engine/git.js";
import type { CommitStatus } from "../engine/read.js";
import { WriteFailed, type CommitStatusWrite, type Limits, type Writer } from "../engine/writer.js";
import { checkBundle } from "../shared/bundle.js";
import type { Cleaned } from "../shared/clean.js";
import type { MergingCheckoutIo } from "../shared/command-io.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { readDirectory, text, type Parser } from "../shared/hand-over.js";
import { waitForHead } from "../shared/head-wait.js";
import { loopAccounts } from "../shared/loop-accounts.js";
import { LOOP_COMMITTER, REVIEW_LABEL, UPDATE_BRANCH_LABEL, VERDICT_CONTEXT } from "../shared/record.js";
import { newestVerdict } from "../shared/verdict-status.js";

type Declared = (typeof COMMANDS)["update-branch:publish"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = MergingCheckoutIo<Declared["outputs"]>;

/**
 * `update-branch:publish` (#484): the publish job's success arm, as a
 * command. It pushes what the gate's merge came to, carries the verdict over
 * to a clean merge, says on the pull request what it did, and asks for a
 * review of a resolution, in that order and with the text the loop has always
 * posted. Each path does one of the two hand-offs, never both: a clean merge
 * carries the old verdict forward because it is still true, and a resolution
 * carries nothing forward because it is not, so it asks for a review instead
 * (#96, decision 6). The failure comment and the trigger label stay the
 * publish job's shell steps until `update-branch:conclude`.
 *
 * **What is pushed is never the agent's job's word alone** (ADR 0006). A
 * clean merge is made here again, through the engine's merge, of `BASE_SHA`,
 * the base commit the gate merged cleanly: the same two commits under the
 * same name, so the same merge. A resolution is `update-branch:bundle`'s
 * bundle, checked the way `fix:publish` checks its own (`shared/bundle.ts`),
 * and then for holding `BASE_SHA` too. Its content is the agent's to write and
 * the review's to judge. All of it is checked before the first write, and
 * every push is leased on `HEAD_SHA`, the head the label's event named, so a
 * branch someone pushed to during the run is refused rather than clobbered.
 *
 * Throws to stop, in a sentence a human can act on, which the CLI turns into
 * `fail()` and the publish job into the failure comment. The verdict
 * carry-over never stops it: the merge is pushed by then, so a failure there
 * would mark the pull request blocked over a branch that moved.
 */
export const publish = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const started = commit(inputs.HEAD_SHA, "HEAD_SHA");
  const base = commit(inputs.BASE_SHA, "BASE_SHA");
  const accounts = loopAccounts(inputs.AGENT_LOOP_LOGINS);
  const status = inputs.STATUS;

  const state: Published = { pushed: false, requested: false };
  const record = (): void => io.outputs.writeJson("published.json", state);
  record();

  if (status === "conflicts" && inputs.AGENT_RESULT !== "success") {
    console.log(`The agent's job ended ${inputs.AGENT_RESULT}, so nothing is pushed or posted here.`);
    return;
  }

  const ran = readDirectory(COMMANDS["update-branch:publish"].inputs.UPDATE_BRANCH_DIR, inputs.UPDATE_BRANCH_DIR, {
    "update_comment.md": text,
  });
  const bundled = readDirectory(COMMANDS["update-branch:publish"].inputs.BUNDLE_DIR, inputs.BUNDLE_DIR, { "branch.bundle": present });

  // What is pushed, settled before anything is written.
  const tip =
    status === "clean"
      ? await mergeAgain(inputs, io, base)
      : status === "conflicts"
        ? await checkResolution(inputs, io, started, base, bundled["branch.bundle"] !== undefined)
        : undefined;

  const { loop, workflow } = io.writers(LIMITS);

  // Step 1: the push, with the loop's token, since a merge may touch a
  // workflow file and a push made with the workflow token starts CI that
  // waits for a maintainer's approval. An up-to-date branch pushes nothing.
  if (tip === undefined) {
    console.log(`Already up to date with ${inputs.BASE_REF}, so there is nothing to push.`);
  } else {
    await push(inputs, loop, tip, started, status === "clean" ? "the merge" : "the agent's resolution");
    state.pushed = true;
    state.head = tip;
    record();
    console.log(`Pushed ${tip} to ${inputs.BRANCH}.`);
  }

  // Step 2: the verdict standing on the old head, carried on to a clean merge.
  if (status === "clean" && tip !== undefined) await carryVerdict(io, workflow, accounts, started, tip);

  // Step 3: what this run did, said on the pull request.
  const body =
    status === "uptodate"
      ? `\`${UPDATE_BRANCH_LABEL}\`: already up to date with \`${inputs.BASE_REF}\`, so no merge was needed.`
      : status === "clean"
        ? `\`${UPDATE_BRANCH_LABEL}\`: merged \`${inputs.BASE_REF}\` (\`${base.slice(0, 7)}\`) cleanly, with no conflicts.`
        : resolutionComment(ran["update_comment.md"], inputs.BASE_REF);
  try {
    await workflow.comment(pr, body);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(`Couldn't comment on PR #${pr} to say what this run did. GitHub's reply is in the write log.`, { cause: error });
  }

  // Step 4: a resolution closes itself out, last of the success arms, so the
  // review it asks for reads the pull request after this run has finished
  // speaking.
  if (status === "conflicts" && tip !== undefined) {
    await requestReview(inputs, io, pr, loop, workflow, tip);
    state.requested = true;
    record();
  }
};

/**
 * What `published.json` holds, written as each becomes true, so a later
 * failure still leaves it: whether the branch moved, which is what the
 * failure comment's remedy turns on; the head this run left; and whether it
 * asked for a review, so the trigger-label step asks for nothing more.
 */
interface Published {
  pushed: boolean;
  head?: string;
  requested: boolean;
}

/** A file whose presence is the whole of it. */
const present: Parser<true> = () => true;

const UNTOUCHED = "so the branch was left untouched";

/**
 * The clean merge, made again in the checkout, of the base commit the gate
 * merged: a merge that no longer goes cleanly, or a base that no longer holds
 * that commit, is not the run the gate decided on.
 */
const mergeAgain = async (inputs: Inputs, io: Io, base: string): Promise<string> => {
  const name = inputs.BASE_REF;
  let merged;
  try {
    merged = await io.merger.merge({ base: name, into: inputs.BRANCH, identity: LOOP_COMMITTER, commit: base });
  } catch (error) {
    if (error instanceof FetchFailed) {
      throw new Error(`Couldn't fetch \`${name}\` to merge it, ${UNTOUCHED}: ${error.message}`, { cause: error });
    }
    if (error instanceof BaseMoved) {
      throw new Error(`\`${name}\` no longer holds the commit this run set out to merge, ${UNTOUCHED}.`, { cause: error });
    }
    throw new Error(`Couldn't merge \`${name}\` into \`${inputs.BRANCH}\` again, ${UNTOUCHED}: ${describe(error)}`, { cause: error });
  }
  if (merged.status !== "clean") {
    throw new Error(`Merging \`${name}\` again didn't go cleanly, though it did a moment before, ${UNTOUCHED}.`);
  }
  return merged.commit;
};

/**
 * The agent's resolution, checked: the base fetched, so the bundle's
 * prerequisites are here and the base still holds the commit the gate merged;
 * the shared bundle check, against the head this run started from; and the
 * base commit in its history, so what is pushed is a merge of the two.
 */
const checkResolution = async (inputs: Inputs, io: Io, started: string, base: string, handedOver: boolean): Promise<string> => {
  const name = inputs.BASE_REF;
  if (!handedOver) throw new Error(`The agent's job finished without handing over its resolution, ${UNTOUCHED}.`);
  let fetched: string;
  try {
    fetched = await io.fetcher.fetchRef(`refs/heads/${name}`, `refs/remotes/origin/${name}`);
  } catch (error) {
    throw new Error(`Couldn't fetch \`${name}\` to merge it, ${UNTOUCHED}: ${describe(error)}`, { cause: error });
  }
  let holds: boolean;
  try {
    holds = await io.git.isAncestor(base, fetched);
  } catch {
    // The one commit the repository can lack here is the base commit, which
    // a base rewritten since the gate read it no longer reaches.
    holds = false;
  }
  if (!holds) throw new Error(`\`${name}\` no longer holds the commit this run set out to merge, ${UNTOUCHED}.`);

  const tip = await checkBundle(io.git, path.join(inputs.BUNDLE_DIR, "branch.bundle"), inputs.BRANCH, started, "pushed");
  let merges: boolean;
  try {
    merges = await io.git.isAncestor(base, tip);
  } catch (error) {
    throw new Error(`Couldn't tell whether the agent's resolution takes in \`${name}\` as this run found it, ${UNTOUCHED}: ${describe(error)}`, {
      cause: error,
    });
  }
  if (!merges) {
    throw new Error(`The agent's resolution isn't a merge of \`${name}\` into the PR's head as this run found them, ${UNTOUCHED}.`);
  }
  return tip;
};

/** The push, under a lease on the head this run started from. */
const push = async (inputs: Inputs, loop: Writer, tip: string, started: string, what: string): Promise<void> => {
  const branch = inputs.BRANCH;
  try {
    await loop.pushRef({ ref: `refs/heads/${branch}`, commit: tip, lease: { tip: started } });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    const lost = error.cause instanceof GitError && error.cause.leaseLost;
    throw new Error(
      lost
        ? `\`${branch}\` moved while this run worked, so ${what} was not pushed over what is there now.`
        : `Couldn't push ${what} to \`${branch}\`, ${UNTOUCHED}: ${describe(error.cause)}`,
      { cause: error },
    );
  }
};

/**
 * A verdict is per commit, so the merge commit carries none until something
 * posts one, and a clean refresh would otherwise wipe the review's answer off
 * every open pull request each time the base branch moves (#96, decision 6).
 * Sound because a clean merge changed nothing the review read, so the verdict
 * standing on the old head is still the verdict on this one, and it is
 * **copied, never parsed**: the state, the line a human acts on and the link
 * are the review's own words.
 *
 * Which status is the verdict is `newestVerdict`'s, the selection
 * `review:conclude` makes: never an outside integration's under the same
 * context. An `error` is copied with the rest: it says the last review of this
 * branch produced no verdict, which a merge does not make untrue.
 *
 * Posted with the **workflow** token, and that is the whole of why the copy is
 * worth making: a status created by any other account is one the next round
 * does not read as the loop's.
 *
 * Never stops the command. **A read that failed is not "there is no
 * verdict"** (#105): each is said its own way, and only the first warns. And
 * neither is a write GitHub refused. Re-running recovers none of these: the
 * branch is refreshed by then, so the next run has nothing to merge.
 */
const carryVerdict = async (
  io: Io,
  workflow: Writer,
  accounts: ReturnType<typeof loopAccounts>,
  from: string,
  to: string,
): Promise<void> => {
  let statuses: readonly CommitStatus[];
  try {
    statuses = await io.github.commitStatuses(from);
  } catch (error) {
    console.log(
      `::warning::Could not read the statuses on ${from}, so no \`${VERDICT_CONTEXT}\` verdict was carried on to ${to} and this pull request now reads as unreviewed, which is not the same as its having none. It is not the caller's \`statuses:\` grant: a caller granting less than this job declares fails the run before any job starts, so a token that got this far holds the write (jeffwlawson/agent-workflows docs/ADOPTING.md §4). What lands here is transient (a 5xx, a secondary rate limit, a dropped connection), and re-running this workflow recovers none of it: the branch is refreshed already. Any verdict that stood is still the one on ${from}; this read could not tell whether there was one; add \`${REVIEW_LABEL}\` for a fresh one. GitHub's reply: ${describe(error)}`,
    );
    return;
  }
  const verdict = newestVerdict(statuses, accounts);
  if (verdict === undefined) {
    console.log(`No ${VERDICT_CONTEXT} verdict of ours on ${from}, so there is nothing to carry over.`);
    return;
  }
  if (!isState(verdict.state)) {
    console.log(`::warning::The \`${VERDICT_CONTEXT}\` verdict on ${from} is in state ${JSON.stringify(verdict.state)}, which is not one GitHub sets, so it was not carried on to ${to}. Add \`${REVIEW_LABEL}\` for a fresh one.`);
    return;
  }
  const copy: CommitStatusWrite = {
    sha: to,
    context: VERDICT_CONTEXT,
    state: verdict.state,
    description: verdict.description,
    ...(verdict.targetUrl === null || verdict.targetUrl === "" ? {} : { targetUrl: verdict.targetUrl }),
  };
  try {
    await workflow.setCommitStatus(copy);
    console.log(`Carried the ${VERDICT_CONTEXT} verdict from ${from} on to ${to}.`);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(
      `::warning::Could not carry the \`${VERDICT_CONTEXT}\` verdict from ${from} on to ${to}. The merge is pushed; what is missing is the line saying what to do about it, so this pull request now reads as unreviewed. GitHub's reply is in the write log. It is not the caller's \`statuses:\` grant: a caller granting less than this job declares fails the run before any job starts, so a token that got this far holds the write (jeffwlawson/agent-workflows docs/ADOPTING.md §4); a 422 is the status itself being refused, which is ours to fix. Re-running this workflow recovers none of it: the branch is refreshed already, so the next run has nothing to merge and never reaches this write. The verdict still stands on ${from}; add \`${REVIEW_LABEL}\` for a fresh one on ${to}.`,
    );
  }
};

const STATES = ["error", "failure", "pending", "success"] as const;
const isState = (state: string): state is CommitStatusWrite["state"] => (STATES as readonly string[]).includes(state);

/**
 * The runner's own account of what it resolved, cleaned, so no HTML comment
 * it wrote reaches the pull request (ADR 0007); today's sentence where it
 * wrote none, or nothing but what cleaning removed.
 */
const resolutionComment = (written: Cleaned | undefined, base: string): string =>
  written === undefined || written.trim() === "" ? `\`${UPDATE_BRANCH_LABEL}\`: resolved conflicts merging \`${base}\`.` : written;

const NO_REVIEW_STARTS = `The conflicts are resolved and pushed, but no review of the resolution will start on its own: neither the loop's App nor \`AGENT_PAT\` is set, so the \`${REVIEW_LABEL}\` label this run added triggers nothing. Remove and re-add \`${REVIEW_LABEL}\` by hand to review it.`;

/**
 * The review of the resolution, the one thing this loop writes that no review
 * has seen. On a PRD PR too (#249): it is a round of the current slice, and
 * its verdict is the one the chain's approval gate reads on the new head.
 *
 * Asked for once the pull request shows the pushed head (#229). Then this
 * run's own label off (#236), `agent:review` removed first so its add fires
 * (#236), and the add, with the loop's token, since a label added with the
 * workflow token triggers nothing. A failed add stops the command, naming
 * the way out: the failure comment's own remedy, re-adding
 * `agent:update-branch`, is inert on a branch that is merged already. Without
 * the App or `AGENT_PAT` the label goes on and fires nothing, so the pull
 * request is told (#105).
 */
const requestReview = async (inputs: Inputs, io: Io, pr: number, loop: Writer, workflow: Writer, pushed: string): Promise<void> => {
  await waitForHead(io.github, pr, pushed, {
    waitSeconds: seconds(inputs.HEAD_WAIT_SECONDS, "HEAD_WAIT_SECONDS"),
    pollSeconds: seconds(inputs.HEAD_POLL_SECONDS, "HEAD_POLL_SECONDS"),
  });
  await tolerated(() => loop.removeLabel(pr, UPDATE_BRANCH_LABEL), `Could not take \`${UPDATE_BRANCH_LABEL}\` off PR #${pr}.`);
  await tolerated(() => loop.removeLabel(pr, REVIEW_LABEL), `Could not take \`${REVIEW_LABEL}\` off PR #${pr} before adding it.`);
  try {
    await loop.addLabel(pr, REVIEW_LABEL);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(
      `Couldn't add \`${REVIEW_LABEL}\` after pushing the resolved conflicts, so no review of them was requested. Add \`${REVIEW_LABEL}\` to this PR by hand.`,
      { cause: error },
    );
  }
  if (inputs.LOOP_TOKEN_SOURCE === "app" || inputs.LOOP_TOKEN_SOURCE === "pat") return;
  console.log(
    `::warning::Neither the loop's App nor AGENT_PAT is set, so this label was added with GITHUB_TOKEN and will NOT trigger agent-review. Add ${REVIEW_LABEL} by hand on PR #${pr}.`,
  );
  await tolerated(() => workflow.comment(pr, NO_REVIEW_STARTS), "…and that could not be said on the pull request either.");
};

/**
 * What `update-branch:publish` may write, and how many of each (ADR 0005):
 * one push; the carried verdict, the one status; the comment saying what the
 * run did and the note that no review will start; this run's label and
 * `agent:review` off, and `agent:review` on. Anything else is refused and
 * stops it.
 */
const LIMITS: Limits = { pushRef: 1, setCommitStatus: 1, comment: 2, removeLabel: 2, addLabel: 1 };

/**
 * A write the loop can live without: made, or said as a warning where GitHub
 * refused it. A write past its limit is still thrown: that is our own bug,
 * never one to read past.
 */
const tolerated = async (write: () => Promise<unknown>, warning: string): Promise<void> => {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::${warning} GitHub's reply is in the write log.`);
  }
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const seconds = (value: string, name: string): number => {
  if (!/^[0-9]{1,6}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a number of seconds.`);
  return Number(value);
};

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};

const commit = (value: string, name: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a full commit id.`);
  return value;
};
