/**
 * A branch handed from the job that ran the agent to the job that pushes it,
 * as a `git bundle`, described once, here, for every workflow that hands one
 * over (PRD #466, #483): made by `fix:bundle` and `update-branch:bundle`, and
 * checked the one way before anything is pushed or rescued from it.
 */
import { execFileSync } from "node:child_process";
import type { GitReader } from "../engine/git.js";

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
 * What bundling a branch came to: the bundle, or why there is none. Which of
 * the two "none"s is a refusal is the command's to say.
 */
export type Bundled =
  | { readonly kind: "bundled"; readonly bytes: Buffer }
  | { readonly kind: "no-branch" }
  | { readonly kind: "no-commits" };

/**
 * `refs/heads/<branch>` in `checkout`, as a thin bundle holding exactly that
 * one ref, with each of `prerequisites` a prerequisite: the commits the
 * pushing job already has. No such ref is `no-branch`, and no commit on it
 * that none of `prerequisites` holds is `no-commits`, since git makes no empty
 * bundle. A failure of git throws, its message git's reason.
 */
export const bundleBranch = (checkout: string, branch: string, prerequisites: readonly string[]): Bundled => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: checkout, maxBuffer: Number.POSITIVE_INFINITY, stdio: ["ignore", "pipe", "pipe"] });
  const ref = `refs/heads/${branch}`;
  const excluded = prerequisites.map((commit) => `^${commit}`);

  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    return { kind: "no-branch" };
  }
  try {
    if (git("rev-list", "-n", "1", ref, ...excluded).toString().trim() === "") return { kind: "no-commits" };
    return { kind: "bundled", bytes: git("bundle", "create", "-", ref, ...excluded) };
  } catch (error) {
    throw new Error(gitReason(error), { cause: error });
  }
};

/**
 * The bundle's one tip, where it is intact, holds exactly the pull request's
 * branch and nothing else, and builds on the head this run was started for.
 * Each failure is its own sentence, ending in what was not done because of
 * it: `pushed` for a push, `rescued` for a rescue.
 */
export const checkBundle = async (
  git: GitReader,
  bundle: string,
  branch: string,
  started: string,
  unless: "pushed" | "rescued",
): Promise<string> => {
  let heads;
  try {
    heads = await git.verifyBundle(bundle);
  } catch (error) {
    throw new Error(`The agent's commits arrived damaged or incomplete, so nothing was ${unless}.`, { cause: error });
  }
  const [head, ...others] = heads;
  if (head === undefined || others.length > 0 || head.ref !== `refs/heads/${branch}`) {
    throw new Error(`The agent's commits arrived on a branch other than \`${branch}\`, or beside other branches, so nothing was ${unless}.`);
  }
  let builds: boolean;
  try {
    builds = await git.isAncestor(started, head.commit);
  } catch (error) {
    throw new Error(
      `Couldn't tell whether the agent's commits build on the PR's head as this run found it, so nothing was ${unless}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!builds) throw new Error(`The agent's commits don't build on the PR's head as this run found it, so nothing was ${unless}.`);
  return head.commit;
};
