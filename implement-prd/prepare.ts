import { execFileSync } from "node:child_process";
import { describe } from "../shared/command-helpers.js";
import type { FetchingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { LOOP_COMMITTER } from "../shared/record.js";
import { fetchRescue } from "../shared/rescue.js";

type Declared = (typeof COMMANDS)["implement-prd:prepare"];
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
 * `implement-prd:prepare` (#501): the PRD branch checked out for the agent,
 * and the rescue an earlier stopped run left fetched beside it.
 *
 * **The PRD branch**, `PRD_BRANCH`, at `BASE_SHA`, the tip
 * `implement-prd:catch-up` left it at, read from the catch-up job and never
 * from this one, so the agent builds on exactly the tip the publish job
 * checks its commits against. Where `PRD_TIP`, the tip the gate read, says
 * the branch exists, it is fetched first with the workflow token into
 * `refs/remotes/origin/`, as the remote's; where it does not, the catch-up made it at the base, which the
 * checkout already holds. A checkout that still does not hold `BASE_SHA` is
 * refused with a sentence. The checkout's identity is the loop's committer.
 *
 * **The rescue**, `RESCUE_BRANCH`, fetched to `refs/rescue/` as
 * `fix:prepare` fetches it (`fetchRescue`): outside `refs/remotes/`, since
 * its commits were never pushed anywhere they count, and are this run's,
 * which `implement-prd:publish` marks once they are pushed. None is fine; one that couldn't be
 * read stops the run.
 *
 * It runs before anything of the adopter's has run on the runner, reads with
 * the workflow token and writes nothing to the record: it is handed no writer.
 */
export const prepare = async (inputs: Inputs, io: Io): Promise<void> => {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: inputs.CHECKOUT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const branch = inputs.PRD_BRANCH;
  const head = inputs.BASE_SHA;

  if (inputs.PRD_TIP !== "") {
    try {
      await io.fetcher.fetchRef(`refs/heads/${branch}`, `refs/remotes/origin/${branch}`);
    } catch (error) {
      throw new Error(`Couldn't fetch \`${branch}\` to build sub-issue #${inputs.SUB} on it, so nothing was built: ${describe(error)}`, {
        cause: error,
      });
    }
  }
  try {
    git("rev-parse", "--verify", "--quiet", `${head}^{commit}`);
  } catch {
    throw new Error(
      `The checkout doesn't hold ${head}, the tip \`${branch}\` was brought up to date at for this run, so nothing was built.`,
    );
  }
  try {
    git("config", "user.name", LOOP_COMMITTER.name);
    git("config", "user.email", LOOP_COMMITTER.email);
    git("checkout", "--quiet", "-B", branch, head);
  } catch (error) {
    throw new Error(`Couldn't check \`${branch}\` out at ${head} for the agent: ${gitReason(error)}`, { cause: error });
  }
  console.log(`Building sub-issue #${inputs.SUB} on ${branch} at ${head}.`);

  await fetchRescue(io.github, io.fetcher, inputs.RESCUE_BRANCH);
};
