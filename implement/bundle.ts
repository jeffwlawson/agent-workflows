import { bundleBranch } from "../shared/bundle.js";
import type { OutputWriters } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";

type Inputs = InputValues<(typeof COMMANDS)["implement:bundle"]["inputs"]>;
type Outputs = OutputWriters<(typeof COMMANDS)["implement:bundle"]["outputs"]>;

/**
 * `implement:bundle` (#491): the agent's commits, as the one thing the
 * publish job pushes, written to `branch.bundle`. A bundle rather than a push
 * from the agent's job, which holds no token that can write, made the way
 * `fix:bundle` makes its own (`shared/bundle.ts`).
 *
 * Thin, `BASE_SHA`, the commit the gate read the base at and the agent's
 * branch was created at, being its prerequisite, which the publish job has
 * from its own checkout, and holding exactly `refs/heads/<BRANCH>`.
 *
 * Unlike `fix:bundle`, nothing to bundle is a refusal: it runs only where the
 * agent succeeded, and the runner refuses a run that made no commits. It
 * reads nothing but `CHECKOUT`: no repository, and no token.
 */
export const bundle = (inputs: Inputs, outputs: Outputs): void => {
  let bundled;
  try {
    bundled = bundleBranch(inputs.CHECKOUT, inputs.BRANCH, [inputs.BASE_SHA]);
  } catch (error) {
    throw new Error(
      `Couldn't bundle the agent's commits on \`${inputs.BRANCH}\`, so none were handed to the publish job: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (bundled.kind === "no-branch") {
    throw new Error(`The agent's job has no \`${inputs.BRANCH}\` to hand over, so nothing was handed to the publish job.`);
  }
  if (bundled.kind === "no-commits") {
    throw new Error(`The agent finished without committing on \`${inputs.BRANCH}\`, so nothing was handed to the publish job.`);
  }
  outputs.writeBytes("branch.bundle", bundled.bytes);
  console.log(`Bundled refs/heads/${inputs.BRANCH} ahead of ${inputs.BASE_SHA}.`);
};
