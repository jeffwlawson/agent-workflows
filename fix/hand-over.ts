/**
 * What `fix:publish` and `fix:conclude` both read of a fix run's hand-over,
 * described once, here: the rescue the runner set aside, said as the note
 * either command posts, and `fix:bundle`'s bundle, checked the one way before
 * either pushes from it (ADR 0006).
 */
import type { GitReader } from "../engine/git.js";
import { json, matching, object, target, type Parser } from "../shared/hand-over.js";
import { FIX_LABEL } from "../shared/record.js";
import { ignoredNote } from "../shared/rescue.js";

/** A file whose presence is the whole of it. */
export const present: Parser<true> = () => true;

/**
 * `rescue_ignored.json`: the rescue branch the runner set aside because the
 * pull request's head moved since it was saved (#303), which has to be this
 * pull request's, and the commit it moved past.
 */
export const rescueIgnored = (rescueBranch: string) =>
  json(
    object({
      branch: target(new Set([rescueBranch]), `this pull request's rescue branch, \`${rescueBranch}\``),
      movedPast: matching(/[0-9a-f]{40}/, "a full commit id"),
    }),
  );

/** The note that says so on the pull request, however the run ended. */
export const setAsideNote = (branch: string): string => ignoredNote(FIX_LABEL, branch, "this pull request's head");

/**
 * The bundle's one tip, where it is intact, holds exactly the pull request's
 * branch and nothing else, and builds on the head this run was started for.
 * Each failure is its own sentence, ending in what was not done because of
 * it: `pushed` for `fix:publish`, `rescued` for `fix:conclude`.
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
