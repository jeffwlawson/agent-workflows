import { bundleBranch } from "../shared/bundle.js";
import type { OutputWriters } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";

type Inputs = InputValues<(typeof COMMANDS)["update-branch:bundle"]["inputs"]>;
type Outputs = OutputWriters<(typeof COMMANDS)["update-branch:bundle"]["outputs"]>;

/**
 * `update-branch:bundle` (#483): the agent's resolution, as the one thing the
 * publish job pushes on the conflicts path, written to `branch.bundle`. A
 * bundle rather than a push from the agent's job, which holds no token that
 * can write, made the way `fix:bundle` makes its own (`shared/bundle.ts`).
 *
 * Thin, the head the run started from, `HEAD_SHA`, and the base commit the
 * gate merged, `BASE_SHA`, being its prerequisites, which the publish job has
 * from its own checkout and fetch, and holding exactly `refs/heads/<BRANCH>`.
 *
 * Unlike `fix:bundle`, nothing to bundle is a refusal, not nothing to push:
 * it runs only where the agent succeeded, and a run that resolved the
 * conflicts committed a merge of the two, which neither holds. It reads
 * nothing but `CHECKOUT`: no repository, and no token.
 */
export const bundle = (inputs: Inputs, outputs: Outputs): void => {
  let bundled;
  try {
    bundled = bundleBranch(inputs.CHECKOUT, inputs.BRANCH, [inputs.HEAD_SHA, inputs.BASE_SHA]);
  } catch (error) {
    throw new Error(
      `Couldn't bundle the agent's resolution on \`${inputs.BRANCH}\`, so none was handed to the publish job and the branch was left untouched: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (bundled.kind === "no-branch") {
    throw new Error(`The agent's job has no \`${inputs.BRANCH}\` to hand over, so the branch was left untouched.`);
  }
  if (bundled.kind === "no-commits") {
    throw new Error(
      `The agent finished without committing a merge of the base into \`${inputs.BRANCH}\`, so there was no resolution to push and the branch was left untouched.`,
    );
  }
  outputs.writeBytes("branch.bundle", bundled.bytes);
  console.log(`Bundled refs/heads/${inputs.BRANCH} ahead of ${inputs.HEAD_SHA} and ${inputs.BASE_SHA}.`);
};
