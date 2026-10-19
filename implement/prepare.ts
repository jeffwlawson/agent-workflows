import { execFileSync } from "node:child_process";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { LOOP_COMMITTER } from "../shared/record.js";

type Inputs = InputValues<(typeof COMMANDS)["implement:prepare"]["inputs"]>;

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
 * `implement:prepare` (#491): the agent's branch, `BRANCH`, created in
 * `CHECKOUT` at `BASE_SHA`, the commit the gate read `BASE_REF` at, and
 * checked out, with the loop's committer as the checkout's identity. So the
 * agent builds on exactly the base the publish job checks its commits
 * against, not the base branch's tip a moment later.
 *
 * A checkout that does not hold `BASE_SHA`, the base branch rewritten since
 * the gate read it, is refused with a sentence, and no branch is made.
 *
 * It reads nothing but `CHECKOUT`: no repository, and no token. It writes
 * nothing to the record.
 */
export const prepare = (inputs: Inputs): void => {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: inputs.CHECKOUT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const base = inputs.BASE_SHA;
  try {
    git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  } catch {
    throw new Error(
      `The checkout of \`${inputs.BASE_REF}\` doesn't hold ${base}, the commit this run found it at, so no branch was made for the agent.`,
    );
  }
  try {
    git("config", "user.name", LOOP_COMMITTER.name);
    git("config", "user.email", LOOP_COMMITTER.email);
    git("checkout", "--quiet", "-B", inputs.BRANCH, base);
  } catch (error) {
    throw new Error(`Couldn't create \`${inputs.BRANCH}\` at ${base} for the agent: ${gitReason(error)}`, { cause: error });
  }
  console.log(`Created ${inputs.BRANCH} at ${base}, the commit ${inputs.BASE_REF} was at when this run started.`);
};
