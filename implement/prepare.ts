import { execFileSync } from "node:child_process";
import type { FetchingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { LOOP_COMMITTER } from "../shared/record.js";
import { fetchRescue } from "../shared/rescue.js";

type Declared = (typeof COMMANDS)["implement:prepare"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = FetchingIo<Declared["outputs"]>;

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
 * **The rescue** (#270), `RESCUE_BRANCH`, where an earlier stopped run of
 * this issue left one, fetched to `refs/rescue/` as `fix:prepare` fetches it
 * (`fetchRescue`), for the runner to resume from. None is fine; one that
 * couldn't be read stops the run, since a run that started over without it,
 * and succeeded, would delete it.
 *
 * It runs before anything of the adopter's has run on the runner, reads with
 * the workflow token and writes nothing to the record: it is handed no writer.
 */
export const prepare = async (inputs: Inputs, io: Io): Promise<void> => {
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

  await fetchRescue(io.github, io.fetcher, inputs.RESCUE_BRANCH);
};
