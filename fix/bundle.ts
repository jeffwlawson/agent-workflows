import { bundleBranch } from "../shared/bundle.js";
import type { OutputWriters } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";

type Inputs = InputValues<(typeof COMMANDS)["fix:bundle"]["inputs"]>;
type Outputs = OutputWriters<(typeof COMMANDS)["fix:bundle"]["outputs"]>;

/**
 * `fix:bundle` (#472): the agent's commits, as the one thing the publish job
 * pushes or rescues, written to `branch.bundle`. A bundle rather than a push
 * from the agent's job, which holds no token that can write: the runner that
 * ran the agent is not one to spend a token on.
 *
 * Thin, the head the run started from, `HEAD_SHA`, being its prerequisite,
 * which the publish job has from its own checkout, and holding exactly
 * `refs/heads/<BRANCH>`. No commits ahead of that head is no bundle, which the
 * publish job reads as nothing to push, and neither is a branch the run never
 * got as far as creating. Commits the run resumed from a rescue count, so a
 * rescue holds all of them.
 *
 * It runs however the agent ended, so a failed, cancelled or timed-out run
 * hands its commits over too, and reads nothing but `CHECKOUT`: no
 * repository, and no token.
 */
export const bundle = (inputs: Inputs, outputs: Outputs): void => {
  const ref = `refs/heads/${inputs.BRANCH}`;
  let bundled;
  try {
    bundled = bundleBranch(inputs.CHECKOUT, inputs.BRANCH, [inputs.HEAD_SHA]);
  } catch (error) {
    throw new Error(
      `Couldn't bundle the agent's commits on \`${inputs.BRANCH}\` ahead of ${inputs.HEAD_SHA}, so none were handed to the publish job: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (bundled.kind === "no-branch") {
    console.log(`No ${ref}, so there is nothing to bundle.`);
    return;
  }
  if (bundled.kind === "no-commits") {
    console.log("No new commits, so there is nothing to bundle.");
    return;
  }
  outputs.writeBytes("branch.bundle", bundled.bytes);
  console.log(`Bundled ${ref} ahead of ${inputs.HEAD_SHA}.`);
};
