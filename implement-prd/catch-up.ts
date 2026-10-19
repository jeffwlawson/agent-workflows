import { FetchFailed, GitError, type Merged } from "../engine/git.js";
import { WriteFailed, type Limits } from "../engine/writer.js";
import { describe, issueNumber, tolerated } from "../shared/command-helpers.js";
import type { MergingCheckoutIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { WORKFLOW_DIR } from "../shared/pins.js";
import { catchUpMessage, IMPLEMENT_LABEL, LOOP_COMMITTER, UPDATE_BRANCH_LABEL } from "../shared/record.js";

type Declared = (typeof COMMANDS)["implement-prd:catch-up"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = MergingCheckoutIo<Declared["outputs"]>;

/**
 * What `catch-up.json` holds: whether the chain parked, the merge commit
 * where one was pushed, and the PRD branch's tip as this left it, which the
 * agent builds on, where it did not park.
 */
interface CaughtUp {
  readonly parked: boolean;
  readonly merged?: string;
  readonly head?: string;
}

/**
 * `implement-prd:catch-up` (#500): **keeping up with the default branch**
 * (#245), before a slice is built. Wherever `BASE_REF` has moved since the
 * PRD branch last took it in, it is merged in and pushed before any agent
 * runs, so a change made there mid-chain, CI's own workflow included, reaches
 * the next slice's round with no hand steps (#211). GitHub runs no
 * `pull_request` CI on a PR with conflicts, so a conflict found here, a slice
 * at a time, is one found before it can strand every later slice.
 *
 * **Prepare.** The PRD branch the gate found is fetched with the workflow
 * token and checked out at its tip. Where the gate found none, `PRD_TIP` is
 * empty, and the branch is made at the base as fetched: it is the base, so
 * nothing is merged, and nothing is pushed, since a PRD branch with no slice
 * on it is pushed with its first slice.
 *
 * **Merge.** Through the engine's merge, the one `update-branch:merge` uses,
 * as the loop's committer, with the message carrying the `Agent-Catch-Up`
 * trailer naming the slice it comes before. That trailer keeps the merge out
 * of every slice range (`shared/slice-ranges.ts`): `update-branch`'s conflict
 * resolution is a merge of the same shape, and belongs to its slice. A
 * **merge**, never a rebase: verdicts are commit statuses and review threads
 * are pinned to commits, so rewriting the PRD branch orphans both.
 *
 * **Park.** A conflict builds nothing and pushes nothing, and parks the
 * chain with a refusal on the parent naming the way on: `agent:update-branch`
 * on the PRD PR, whose agent resolves it and asks for a re-review, or a merge
 * by hand. `agent:implement` comes off and no `agent:blocked` goes on, since
 * the chain moves on by itself after it. Not a failure: every job after this
 * one stands down on `parked`.
 *
 * **Push.** With the loop's token, leased on `PRD_TIP`, the tip the gate
 * read, so a push someone made to the PRD branch during the run is refused
 * rather than overwritten.
 *
 * Throws to stop, in a sentence a human can act on, which the CLI turns into
 * `fail()`.
 */
export const catchUp = async (inputs: Inputs, io: Io): Promise<void> => {
  const parent = issueNumber(inputs.ISSUE_NUMBER);
  const sub = numbered(inputs.SUB, "SUB", "a sub-issue number");
  const pr = inputs.PRD_PR === "" ? undefined : numbered(inputs.PRD_PR, "PRD_PR", "a pull request number");
  const base = inputs.BASE_REF;
  const branch = inputs.PRD_BRANCH;
  const tip = inputs.PRD_TIP;
  const record = (caughtUp: CaughtUp): void => io.outputs.writeJson("catch-up.json", caughtUp);

  const { loop, workflow } = io.writers(LIMITS);

  let from: string;
  if (tip === "") {
    from = `refs/remotes/origin/${base}`;
  } else {
    try {
      from = await io.fetcher.fetchRef(`refs/heads/${branch}`, `refs/remotes/origin/${branch}`);
    } catch (error) {
      throw new Error(`Couldn't fetch \`${branch}\` to build sub-issue #${sub} on it, so nothing was built: ${describe(error)}`, { cause: error });
    }
  }

  let merged: Merged;
  try {
    merged = await io.merger.merge({ base, into: branch, identity: LOOP_COMMITTER, from, message: catchUpMessage(base, branch, sub) });
  } catch (error) {
    if (error instanceof FetchFailed) {
      throw new Error(`Couldn't fetch \`${base}\` to bring the PRD branch up to date with it, so nothing was built: ${error.message}`, {
        cause: error,
      });
    }
    // A merge that stopped on no conflict is git refusing for some other
    // reason, which is a failure, not a park.
    throw new Error(`Couldn't merge \`${base}\` into \`${branch}\`, and not because of a conflict, so nothing was built: ${describe(error)}`, {
      cause: error,
    });
  }

  if (merged.status === "uptodate") {
    const head = tip === "" ? merged.base : from;
    record({ parked: false, head });
    console.log(
      tip === ""
        ? `Created ${branch} from ${base} at ${head}; building sub-issue #${sub} on it, and it is pushed with this slice. Nothing to merge.`
        : `${branch} already has everything on ${base}; building sub-issue #${sub} on it at ${head}. Nothing to merge.`,
    );
    return;
  }

  if (merged.status === "conflicts") {
    await park(parent, sub, pr, base, branch, merged.conflicts, workflow, record);
    return;
  }

  try {
    await loop.pushRef({ ref: `refs/heads/${branch}`, commit: merged.commit, lease: { tip } });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(await pushRefused(io, base, branch, tip, merged.commit, error), { cause: error });
  }
  record({ parked: false, merged: merged.commit, head: merged.commit });
  console.log(`Merged ${base} into ${branch} at ${merged.commit}, before building sub-issue #${sub}.`);
};

/**
 * The conflict's refusal, in a refusal's order: the comment first, then this
 * run's own label off. `parked` is written before either, so a run that dies
 * between them still stands the later jobs down.
 */
const park = async (
  parent: number,
  sub: number,
  pr: number | undefined,
  base: string,
  branch: string,
  conflicts: readonly string[],
  workflow: ReturnType<Io["writers"]>["workflow"],
  record: (caughtUp: CaughtUp) => void,
): Promise<void> => {
  record({ parked: true });
  const files = conflicts.map((file) => `\`${file}\``).join(", ");
  const way =
    pr === undefined
      ? `Merge \`${base}\` into \`${branch}\` and resolve the conflict by hand, then add \`${IMPLEMENT_LABEL}\` again.`
      : `Add \`${UPDATE_BRANCH_LABEL}\` to PRD PR #${pr} to merge it there and resolve the conflict. The chain moves on once a review of the resolution recommends approval.`;
  console.log(`Conflicts merging ${base} into ${branch} in: ${conflicts.join(" ")}. The chain parks before sub-issue #${sub}.`);
  await tolerated(`Could not post the conflict comment on #${parent}.`, () =>
    workflow.comment(
      parent,
      `**\`${IMPLEMENT_LABEL}\` didn't run:** The default branch \`${base}\` has changed since the PRD branch last took it in, and merging it into \`${branch}\` conflicts in ${files}. The chain parked before sub-issue #${sub}, and nothing was built or pushed. ${way}`,
    ),
  );
  await tolerated(undefined, () => workflow.removeLabel(parent, IMPLEMENT_LABEL));
};

/**
 * Why the merge's push was refused. A lost lease is the PRD branch moving
 * since the gate read it. Otherwise, a merge that brings in a change to a
 * workflow file is a push GitHub rejects from a token without Workflows:
 * write, the `GITHUB_TOKEN` fallback included, and a retry fails the same
 * way, so that cause is named wherever the merge carries one: telling the
 * human only to retry is a loop that cannot end.
 */
const pushRefused = async (io: Io, base: string, branch: string, tip: string, commit: string, error: WriteFailed): Promise<string> => {
  const refused = `Couldn't push the merge of \`${base}\` into \`${branch}\`, so nothing was built.`;
  if (error.cause instanceof GitError && error.cause.leaseLost) {
    return `${refused} \`${branch}\` moved since this run read it at ${tip}, so the merge was not pushed over what is there now. Trying again merges on top of it.`;
  }
  let workflows: readonly string[];
  try {
    workflows = await io.git.changedPaths(`${commit}^1`, commit, WORKFLOW_DIR);
  } catch {
    workflows = [];
  }
  if (workflows.length > 0) {
    return `${refused} The merge changes ${workflows.map((file) => `\`${file}\``).join(", ")}, and GitHub refuses a push that changes a workflow file from a token without Workflows: write, so trying again fails the same way until the loop pushes with a token that has Workflows: write: the loop's App, or \`AGENT_PAT\`.`;
  }
  return `${refused} ${describe(error.cause)}`;
};

/** `value` as a positive number, or a sentence naming `name`. */
const numbered = (value: string, name: string, what: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not ${what}.`);
  return Number(value);
};

/** The push, with the loop's token; the park's comment and label, with the workflow's. */
const LIMITS: Limits = { pushRef: 1, comment: 1, removeLabel: 1 };
