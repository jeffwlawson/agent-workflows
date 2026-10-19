import { BaseMoved, FetchFailed } from "../engine/git.js";
import { describe } from "../shared/command-helpers.js";
import type { MergingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { LOOP_COMMITTER } from "../shared/record.js";

type Declared = (typeof COMMANDS)["update-branch:prepare"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = MergingIo<Declared["outputs"]>;

/**
 * `update-branch:prepare` (#482): the gate's merge, made again in the agent's
 * job, so the runner starts from the conflicted tree the gate found. The same
 * base commit, `BASE_SHA`, merged under the same name, `BASE_REF`, into
 * `BRANCH`, the commit checked out in `CHECKOUT`, by the loop's committer,
 * through the engine's merge: the gate's merge and its message, by
 * construction.
 *
 * A merge that does not stop on a conflict here is not the run the gate
 * decided on, so it refuses: where the base no longer holds the commit the
 * gate merged, and where the merge is clean or there is nothing to merge.
 * Each refusal is a sentence the failure comment gives, and leaves the branch
 * on GitHub as it was.
 *
 * It runs before anything of the pull request's has run on the runner, so the
 * token it fetches with meets no git config entry or hook the pull request's
 * code left behind. It reads with the workflow token and writes nothing to the
 * record: it is handed no writer.
 */
export const prepare = async (inputs: Inputs, io: Io): Promise<void> => {
  const base = inputs.BASE_REF;
  let merged;
  try {
    merged = await io.merger.merge({ base, into: inputs.BRANCH, identity: LOOP_COMMITTER, commit: inputs.BASE_SHA });
  } catch (error) {
    if (error instanceof FetchFailed) {
      throw new Error(`Couldn't fetch \`${base}\` to merge it again for the agent, so the branch was left untouched: ${error.message}`, {
        cause: error,
      });
    }
    if (error instanceof BaseMoved) {
      throw new Error(`\`${base}\` no longer holds the commit this run set out to merge, so the branch was left untouched.`, { cause: error });
    }
    throw new Error(`Couldn't merge \`${base}\` into \`${inputs.BRANCH}\` again for the agent, so the branch was left untouched: ${describe(error)}`, {
      cause: error,
    });
  }
  if (merged.status !== "conflicts") {
    throw new Error(
      `Merging \`${base}\` again didn't conflict, so there was nothing for the agent to resolve and the branch was left untouched.`,
    );
  }
  console.log(`Conflicts merging ${base} (${merged.base}) again, for the agent, in: ${merged.conflicts.join(" ")}`);
};

