import type { GitFetcher } from "../engine/git.js";
import { GitHubError } from "../engine/github.js";
import type { GitHubReader } from "../engine/read.js";
import { WriteFailed, type Writer } from "../engine/writer.js";
import { describe, inWriteLog } from "./command-helpers.js";
import { git } from "./common.js";

/**
 * Rescue and resume (#303): a fix, implement-prd or implement (#270) run that
 * stops before it finishes (its time limit, a cancel, a failure) leaves the
 * commits it made on a side branch with a fixed name, and the next run of the
 * same label starts from them where they still build on the head it starts
 * from.
 *
 * The publish job pushes the rescue and deletes it; the agent's job fetches it
 * to `rescueRef(branch)`, and the runner decides here whether to build on it.
 */

/**
 * Where the agent's job fetches the rescue branch to. Outside `refs/remotes/`
 * on purpose: a rescued commit was never pushed anywhere it counts, so it is
 * the resuming run's, and `implement-prd:publish` marks it as that run's
 * slice's (#502).
 * The workflows name the same ref, and a test holds them equal.
 */
export const rescueRef = (branch: string): string => `refs/rescue/${branch}`;

/**
 * The agent's job's half (#303): the rescue branch `branch`, where an earlier
 * stopped run left one, fetched into the checkout as `rescueRef(branch)` for
 * the runner to resume from, as `fix:prepare`, `implement-prd:prepare` and
 * `implement:prepare` fetch it. The runner decides whether it still builds on
 * the head; this only fetches it.
 *
 * **An unreadable answer stops the run**, rather than reading as "no
 * rescue": a run that started over without the rescue, and succeeded, would
 * delete it. So a 404 for the branch is the one answer that is "none", and any
 * other failure to read its tip, or to fetch a rescue that is there, throws a
 * sentence.
 */
export const fetchRescue = async (github: GitHubReader, fetcher: GitFetcher, branch: string): Promise<void> => {
  try {
    await github.branchTip(branch);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      console.log(`No ${branch}, so there is nothing to resume from.`);
      return;
    }
    console.log(`::warning::Could not read the tip of ${branch}. ${describe(error)}`);
    throw new Error(
      `Couldn't check whether an earlier run left commits on \`${branch}\`, so this run stopped rather than start over without them.`,
      { cause: error },
    );
  }
  try {
    await fetcher.fetchRef(`refs/heads/${branch}`, rescueRef(branch));
  } catch (error) {
    throw new Error(
      `Couldn't fetch \`${branch}\`, which an earlier run left, so this run stopped rather than start over without it: ${describe(error)}`,
      { cause: error },
    );
  }
  console.log(`Fetched ${branch}, which an earlier run left, for the runner to resume from.`);
};

/** What the runner did with the rescue branch, if there was one. */
export type Resume =
  /** No rescue branch, or one holding nothing the head does not already have. */
  | { readonly kind: "none" }
  /** Built on the head this run started from, and fast-forwarded onto. */
  | { readonly kind: "resumed"; readonly commits: number }
  /** Built on some other head: the branch moved since it was saved. */
  | { readonly kind: "ignored" };

const succeeds = (args: readonly string[]): boolean => {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
};

/**
 * Move `HEAD` onto the rescue branch's commits where they still build on it.
 *
 * "Still builds on it" is ancestry: the head this run started from is in the
 * rescue's history. A rescue saved before the head moved does not have the
 * new head, so it is set aside rather than merged: its commits are unverified,
 * and reconciling them with a moved head is a decision for a human or a fresh
 * run, not a silent merge. A fast-forward, never a reset, so a working tree
 * that is somehow dirty stops the run rather than losing anything.
 */
export const resumeFromRescue = (branch: string): Resume => {
  const ref = rescueRef(branch);
  if (!succeeds(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return { kind: "none" };
  if (!succeeds(["merge-base", "--is-ancestor", "HEAD", ref])) return { kind: "ignored" };
  const commits = Number(git(["rev-list", "--count", `HEAD..${ref}`]).trim());
  if (commits === 0) return { kind: "none" };
  git(["merge", "--ff-only", "--quiet", ref]);
  return { kind: "resumed", commits };
};

/**
 * The prompt section a resumed run opens with, and "" otherwise. The commits
 * are the agent's own, from a run that never reached its verify, so it is told
 * to run the verify command before it builds on them.
 */
export const resumeSection = (resume: Resume, branch: string): string =>
  resume.kind !== "resumed"
    ? ""
    : [
        "# RESUMING AN EARLIER RUN",
        "",
        `An earlier run of this task stopped before it finished, and saved the ${resume.commits} ` +
          `commit(s) it had made on \`${branch}\`. You are starting from them: they are already on ` +
          "`HEAD`, on top of the branch as described below.",
        "",
        "**They are unverified.** Nothing checked them after they were made, and the run that made " +
          "them may have stopped partway through a change. Run the verify command `CLAUDE.md` names " +
          "before going further, read what they did, and carry on from there: fix what is broken, " +
          "finish what is unfinished, and do not redo what is already done.",
        "",
      ].join("\n");

/**
 * The note a run that set a rescue aside posts, so the work it did not use is
 * not lost silently. `label` is the run's trigger label, `moved` what moved.
 */
export const ignoredNote = (label: string, branch: string, moved: string): string =>
  `**\`${label}\` started fresh:** An earlier run saved its unfinished commits on \`${branch}\`, ` +
  `but ${moved} has moved since, so this run did not build on them. ` +
  "The branch is deleted once a run succeeds.\n";

/**
 * The branch a set-aside rescue is kept on before a stopped run's own commits
 * replace it (#578): the rescue's name, which is a valid ref, with a suffix
 * that keeps it one, and the first 7 of the tip it keeps, so a second
 * set-aside rescue gets a branch of its own.
 */
export const setAsideBranch = (rescue: string, tip: string): string => `${rescue}-set-aside-${tip.slice(0, 7)}`;

/**
 * Why a stopped run's commits went unsaved where its set-aside rescue was kept
 * on `side` but the push of its own was then refused (#773), as a comment says
 * it after "were not saved on `<rescue>`:": the side branch is named, so the
 * earlier commits are not taken for lost with the run's.
 */
export const unpushedButKept = (side: string): string =>
  `GitHub refused the push, and the workflow run's log says why. The earlier commits this run set aside there are kept on \`${side}\`; delete it once you are done with them.`;

/** Where the agent's job fetches a set-aside rescue to before it keeps it: a ref of its own, outside `refs/heads/`. */
const setAsideRef = (rescue: string): string => `refs/set-aside/${rescue}`;

/**
 * What became of a set-aside rescue: kept on `branch`, or not, with `why` the
 * clause a comment gives for it after "could not be kept on `<branch>`:".
 */
export type Kept = { readonly kind: "kept"; readonly branch: string } | { readonly kind: "unkept"; readonly branch: string; readonly why: string };

/**
 * **A set-aside rescue kept on a branch of its own** (#578), before a stopped
 * run pushes its own commits over it: the runner set the rescue at `tip`
 * aside, so the run's commits do not hold it, and overwriting it would leave
 * its commits on no branch.
 *
 * The rescue is fetched from the remote first, since the push sends a commit
 * the checkout must hold, and what is there must still be `tip`: a rescue that
 * moved or went since it was set aside is not what this run set aside, and is
 * not kept in its place. The side branch is pushed under `{ absent: true }`,
 * so a rerun cannot clobber one; a rerun that finds it already at `tip` has
 * nothing to push. With `writer`, the loop's token, since the commits may
 * touch a workflow file. A person deletes the side branch.
 *
 * Only a refused push is caught: anything else is our own bug, and throws.
 */
export const keepSetAside = async (fetcher: GitFetcher, writer: Writer, rescue: string, tip: string): Promise<Kept> => {
  const branch = setAsideBranch(rescue, tip);
  let fetched: string;
  try {
    fetched = await fetcher.fetchRef(`refs/heads/${rescue}`, setAsideRef(rescue));
  } catch (error) {
    console.log(`::warning::Could not fetch ${rescue} to keep it on ${branch}: ${describe(error)}`);
    return { kind: "unkept", branch, why: "it could not be fetched, and the workflow run's log says why." };
  }
  if (fetched !== tip) {
    console.log(`::warning::${rescue} is at ${fetched}, not at ${tip}, which this run set aside, so it was not kept on ${branch}.`);
    return { kind: "unkept", branch, why: `the branch moved since this run set it aside, to ${fetched}.` };
  }
  try {
    await writer.pushRef({ ref: `refs/heads/${branch}`, commit: tip, lease: { absent: true } });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::${inWriteLog(`Could not push ${rescue}'s set-aside commits to ${branch}.`)}`);
    return { kind: "unkept", branch, why: "GitHub refused the push, and the workflow run's log says why." };
  }
  console.log(`Kept the commits set aside on ${rescue}, up to ${tip}, on ${branch}.`);
  return { kind: "kept", branch };
};
