import * as path from "node:path";
import { GitError } from "../engine/git.js";
import { GitHubError } from "../engine/github.js";
import { ReadBackFailed, WriteFailed, type Lease, type Limits, type Writer } from "../engine/writer.js";
import { checkBundle } from "../shared/bundle.js";
import { describe, inWriteLog, issueNumber, seconds, tolerated } from "../shared/command-helpers.js";
import type { CheckoutIo } from "../shared/command-io.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { readDirectory, type Parser } from "../shared/hand-over.js";
import { waitForHead } from "../shared/head-wait.js";
import { renderPullRequestFrame } from "../shared/pr-frame.js";
import { IMPLEMENT_LABEL, REVIEW_LABEL } from "../shared/record.js";

type Declared = (typeof COMMANDS)["implement:publish"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CheckoutIo<Declared["outputs"]>;

/** What `published.json` holds, written as each becomes true, so a later failure still leaves it. */
interface Published {
  pushed: boolean;
  /** The commit pushed, which the pull request has to show before the review is asked for. */
  head?: string;
  /** The pull request opened, where one was. */
  pr?: number;
  /** Whether `agent:review` went on. */
  requested: boolean;
}

/**
 * `implement:publish` (#492): the publish job's success path, as a command.
 * It checks the agent's bundle, pushes it, opens the draft pull request with
 * its frame, links it on the issue, and hands it to the review, in that order
 * and with the text the loop has always written. What happens after it, the
 * failure comment and the trigger label, is `implement:conclude`'s.
 *
 * **The bundle is checked before anything is pushed from it**, against facts
 * the gate established and the agent could not reach: it is there, intact,
 * holds exactly `BRANCH` and nothing else, and builds on `BASE_SHA`, the
 * commit the gate read the base at. Its content is the agent's to write and
 * the review's to judge; what this rules out is a bundle that is not the
 * branch this run was for.
 *
 * **The push is leased on the gate's tip**, `BRANCH_TIP`, or on the branch
 * not existing where the gate found none: a retry still replaces what an
 * earlier failed run left, and a push someone else made during the run is
 * refused rather than overwritten.
 *
 * **The rescue branch is deleted once the pull request is open** (#270),
 * leased on its tip as read: the commits a run resumed from are in what it
 * pushed, and a rescue left behind is one the next run would set aside. Not
 * between the push and the open: an open that fails sends the retry back to
 * the base, whose push replaces `BRANCH`, so the rescue is all that is left
 * of those commits. A deletion that fails is a warning, never a stop.
 *
 * **A server error opening the pull request is read back** (#329): the open
 * pull request from exactly this head into exactly this base is this run's,
 * and the run goes on with it, warning that GitHub errored. Never one that
 * only says `Closes #N`: that could be an adopter's own, which a review
 * request would be aimed at. A read-back that fails too stops the run, saying
 * to look for the pull request before trying again, since "unknown" is not
 * "not opened".
 *
 * Throws to stop, in a sentence a human can act on, which the CLI turns into
 * `fail()` and the publish job into the failure comment. The link on the
 * issue and the two label removals are tolerated, said as a warning; a failed
 * push, open or `agent:review` add stops it.
 */
export const publish = async (inputs: Inputs, io: Io): Promise<void> => {
  const issue = issueNumber(inputs.ISSUE_NUMBER);
  const base = commit(inputs.BASE_SHA, "BASE_SHA");
  const lease: Lease = inputs.BRANCH_TIP === "" ? { absent: true } : { tip: commit(inputs.BRANCH_TIP, "BRANCH_TIP") };
  const branch = inputs.BRANCH;

  const bundled = readDirectory(COMMANDS["implement:publish"].inputs.BUNDLE_DIR, inputs.BUNDLE_DIR, { "branch.bundle": present });
  if (bundled["branch.bundle"] === undefined) {
    throw new Error("The agent's job finished without handing over its commits, so nothing was pushed.");
  }
  const tip = await checkBundle(io.git, path.join(inputs.BUNDLE_DIR, "branch.bundle"), branch, base, "pushed", `\`${inputs.BASE_REF}\``);

  const { loop, workflow } = io.writers(LIMITS);
  const state: Published = { pushed: false, requested: false };
  const record = (): void => io.outputs.writeJson("published.json", state);
  record();

  // Step 1: the push, with the loop's token, since a push made with the
  // workflow token starts CI on the pull request that waits for a
  // maintainer's approval (#221).
  try {
    await loop.pushRef({ ref: `refs/heads/${branch}`, commit: tip, lease });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    const lost = error.cause instanceof GitError && error.cause.leaseLost;
    throw new Error(
      lost
        ? `\`${branch}\` changed while this run worked, so the agent's commits were not pushed over what is there now.`
        : `Couldn't push the agent's commits to \`${branch}\`, so nothing was pushed: ${describe(error.cause)}`,
      { cause: error },
    );
  }
  state.pushed = true;
  state.head = tip;
  record();
  console.log(`Pushed ${tip} to ${branch}.`);

  // Step 2: the draft pull request, with the loop's token: the Actions bot is
  // forbidden from opening one. The title is the issue's until the first
  // review writes one true of the change, cut at GitHub's 256 characters.
  const pr = await openPullRequest(inputs, issue, loop);
  state.pr = pr;
  record();

  // The rescue, only once the pull request holds what it resumed from: a
  // failed open leaves `published.json` with no `pr`, the retry cuts `BRANCH`
  // afresh at the base and pushes over it, and the rescue is then the one
  // copy of those commits (#270).
  await deleteRescue(io, loop, inputs.RESCUE_BRANCH);

  // Step 3: the success outcome, said on the issue with the run link (#205),
  // before the review is asked for. A warning where it cannot be posted: the
  // pull request is open either way, and the review must still be requested.
  await tolerated(
    inWriteLog(`Could not comment PR #${pr} on #${issue}.`),
    () => workflow.comment(issue, `**\`${IMPLEMENT_LABEL}\` opened PR #${pr}:** [Workflow run](${inputs.RUN_URL})`),
  );

  // Step 4: the review, once the pull request shows the pushed head (#229).
  await requestReview(inputs, io, issue, pr, tip, loop);
  state.requested = true;
  record();
};

/**
 * The draft pull request from `BRANCH` into `BASE_REF`, and its number. A
 * pull request the read-back found after a server error is carried on with,
 * with a warning; a read-back that failed too is a sentence saying to look
 * for it first.
 */
const openPullRequest = async (inputs: Inputs, issue: number, loop: Writer): Promise<number> => {
  try {
    const opened = await loop.openPullRequest({
      base: inputs.BASE_REF,
      head: inputs.BRANCH,
      title: cut(`Fix #${issue}: ${inputs.ISSUE_TITLE}`, 256),
      body: renderPullRequestFrame({ issue, runUrl: inputs.RUN_URL }),
      draft: true,
    });
    if (opened.readBack !== undefined) {
      console.log(
        `::warning::GitHub answered opening the pull request with a server error (${opened.readBack}), but PR #${opened.number} from \`${inputs.BRANCH}\` into \`${inputs.BASE_REF}\` is open, so this run goes on with it.`,
      );
    }
    console.log(`Opened ${opened.url}`);
    return opened.number;
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    if (error.cause instanceof ReadBackFailed) {
      throw new Error(
        `GitHub answered opening the pull request from \`${inputs.BRANCH}\` with a server error, and whether it opened anyway could not be read back (${describe(error.cause.read)}). Look for an open pull request from \`${inputs.BRANCH}\` before adding \`${IMPLEMENT_LABEL}\` again; if there is one, add \`${REVIEW_LABEL}\` to it instead.`,
        { cause: error },
      );
    }
    throw new Error(
      `Couldn't open a pull request from \`${inputs.BRANCH}\` into \`${inputs.BASE_REF}\`, so the agent's commits are pushed but nothing asks for their review: ${describe(error.cause)}`,
      { cause: error },
    );
  }
};

/**
 * The review, asked for once the pull request shows the pushed head (#229):
 * GitHub moves a pull request's head asynchronously after a push, and a label
 * added first can carry the commit before it. Bounded: past it, the label
 * goes on anyway, since review reads the branch tip itself.
 *
 * Then this run's own label off the issue (#236): every result is posted by
 * now, so what is left is the hand-off. Then `agent:review` removed first, as
 * every trigger label the loop adds (#236), since an add on a label already
 * there fires nothing, and added. All three with the loop's token: a label
 * added with the workflow token triggers nothing, so without the App or
 * `AGENT_PAT` the label goes on and nothing happens, which is warned of
 * rather than passed off as working.
 *
 * Safe because the hop it starts is bounded at the other end: review adds
 * `agent:fix` back only within the pull request's fix-round budget (#201),
 * and never after a round that closed none of its findings (#202).
 */
const requestReview = async (inputs: Inputs, io: Io, issue: number, pr: number, pushed: string, loop: Writer): Promise<void> => {
  await waitForHead(io.github, pr, pushed, {
    waitSeconds: seconds(inputs.HEAD_WAIT_SECONDS, "HEAD_WAIT_SECONDS"),
    pollSeconds: seconds(inputs.HEAD_POLL_SECONDS, "HEAD_POLL_SECONDS"),
  });
  await tolerated(inWriteLog(`Could not take \`${IMPLEMENT_LABEL}\` off #${issue}.`), () => loop.removeLabel(issue, IMPLEMENT_LABEL));
  await tolerated(
    inWriteLog(`Could not take \`${REVIEW_LABEL}\` off PR #${pr} before adding it.`),
    () => loop.removeLabel(pr, REVIEW_LABEL),
  );
  try {
    await loop.addLabel(pr, REVIEW_LABEL);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(`Couldn't add \`${REVIEW_LABEL}\` to PR #${pr}, so no review was requested.`, { cause: error });
  }
  if (inputs.LOOP_TOKEN_SOURCE === "app" || inputs.LOOP_TOKEN_SOURCE === "pat") return;
  console.log(
    `::warning::Neither the loop's App nor AGENT_PAT is set, so this label was added with GITHUB_TOKEN and will NOT trigger agent-review. Add ${REVIEW_LABEL} by hand on PR #${pr}.`,
  );
};

/**
 * The rescue branch, deleted under a lease on its tip as read here, so one
 * rewritten during the run is not removed. Never stops the command: a branch
 * left behind is set aside by the next run, whose base has moved past it.
 */
const deleteRescue = async (io: Io, loop: Writer, rescue: string): Promise<void> => {
  let tip: string;
  try {
    tip = await io.github.branchTip(rescue);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      console.log(`No ${rescue} to delete.`);
    } else {
      console.log(`::warning::Could not read ${rescue}, so it was not deleted. The next run sets it aside; delete it by hand: ${describe(error)}`);
    }
    return;
  }
  const deleted = await tolerated(
    inWriteLog(`Could not delete ${rescue}. The next run sets it aside; delete it by hand.`),
    () => loop.deleteRef({ ref: `refs/heads/${rescue}`, lease: { tip } }),
  );
  if (deleted) console.log(`Deleted ${rescue}: this run succeeded.`);
};

/**
 * What `implement:publish` may write, and how many of each (ADR 0005): one
 * push, the rescue branch's deletion, one pull request and one
 * `agent:review`, with the loop's token; the link on the issue; and two
 * label removals, `agent:implement` off the issue and `agent:review` off the
 * pull request before it goes on. Anything else is refused and stops it.
 */
const LIMITS: Limits = { pushRef: 1, deleteRef: 1, openPullRequest: 1, addLabel: 1, comment: 1, removeLabel: 2 };

/** A file read for being there, and nothing more: the bundle's bytes are git's to check. */
const present: Parser<true> = () => true;

/** `text` cut to `max` characters, as bash's `${title:0:256}` cut it: by code point, never mid-character. */
const cut = (text: string, max: number): string => Array.from(text).slice(0, max).join("");

const commit = (value: string, name: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} is ${JSON.stringify(value)}, which is not a full commit id, so there is nothing to check the agent's commits against.`);
  }
  return value;
};
