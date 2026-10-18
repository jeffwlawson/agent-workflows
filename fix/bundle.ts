import { execFileSync } from "node:child_process";
import type { OutputWriters } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";

type Inputs = InputValues<(typeof COMMANDS)["fix:bundle"]["inputs"]>;
type Outputs = OutputWriters<(typeof COMMANDS)["fix:bundle"]["outputs"]>;

/** Git's last word on stderr, which is its reason where it gives one. */
const gitReason = (error: unknown): string => {
  const stderr = typeof error === "object" && error !== null ? (error as { stderr?: unknown }).stderr : undefined;
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? (error instanceof Error ? error.message : String(error));
};

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
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: inputs.CHECKOUT, maxBuffer: Number.POSITIVE_INFINITY, stdio: ["ignore", "pipe", "pipe"] });
  const ref = `refs/heads/${inputs.BRANCH}`;

  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    console.log(`No ${ref}, so there is nothing to bundle.`);
    return;
  }
  let bundled: Buffer;
  try {
    if (git("rev-list", "-n", "1", `${inputs.HEAD_SHA}..${ref}`).toString().trim() === "") {
      console.log("No new commits, so there is nothing to bundle.");
      return;
    }
    bundled = git("bundle", "create", "-", ref, `^${inputs.HEAD_SHA}`);
  } catch (error) {
    throw new Error(
      `Couldn't bundle the agent's commits on \`${inputs.BRANCH}\` ahead of ${inputs.HEAD_SHA}, so none were handed to the publish job: ${gitReason(error)}`,
    );
  }
  outputs.writeBytes("branch.bundle", bundled);
  console.log(`Bundled ${ref} ahead of ${inputs.HEAD_SHA}.`);
};
