import { FetchFailed } from "../engine/git.js";
import { describe } from "../shared/command-helpers.js";
import type { MergingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { LOOP_COMMITTER } from "../shared/record.js";

type Declared = (typeof COMMANDS)["update-branch:merge"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = MergingIo<Declared["outputs"]>;

/**
 * `update-branch:merge` (#481): the merge the gate job tries, to decide
 * whether there is anything for an agent to do. `BASE_REF` is fetched and
 * merged into the commit checked out in `CHECKOUT`, as `BRANCH`, by the
 * loop's committer, through the engine's merge, which the agent's job and
 * the publish job will repeat.
 *
 * `merge.json` is what it came to: `status`, `uptodate` where the branch
 * already holds the base, `clean`, or `conflicts`; `base`, the base commit
 * it merged, which the later jobs merge again rather than the branch's tip
 * by then; and `conflicts`, the conflicted paths, empty but on a conflict.
 *
 * It reads with the workflow token, the fetch, and writes nothing to the
 * record: it is handed no writer. A fetch that fails, a deleted base among
 * its causes, stops the run with a sentence, where the shell step it
 * replaced ended with a bare `exit 1` and the failure comment had no reason
 * to give.
 */
export const merge = async (inputs: Inputs, io: Io): Promise<void> => {
  const base = inputs.BASE_REF;
  let merged;
  try {
    merged = await io.merger.merge({ base, into: inputs.BRANCH, identity: LOOP_COMMITTER });
  } catch (error) {
    if (error instanceof FetchFailed) {
      throw new Error(`Couldn't fetch \`${base}\` to merge it, so the branch was left untouched: ${error.message}`, { cause: error });
    }
    throw new Error(`Couldn't merge \`${base}\` into \`${inputs.BRANCH}\`, so the branch was left untouched: ${describe(error)}`, {
      cause: error,
    });
  }
  io.outputs.writeJson("merge.json", {
    status: merged.status,
    base: merged.base,
    conflicts: merged.status === "conflicts" ? merged.conflicts : [],
  });
  if (merged.status === "uptodate") console.log(`Already contains ${base}, so there is nothing to do.`);
  else if (merged.status === "clean") console.log(`Merged ${base} (${merged.base}) cleanly.`);
  else console.log(`Conflicts merging ${base} (${merged.base}) in: ${merged.conflicts.join(" ")}`);
};

