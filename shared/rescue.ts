import { git } from "./common.js";

/**
 * Rescue and resume (#303): a fix or implement-prd run that stops before it
 * finishes (its time limit, a cancel, a failure) leaves the commits it made on
 * a side branch with a fixed name, and the next run of the same label starts
 * from them where they still build on the head it starts from.
 *
 * The publish job pushes the rescue and deletes it; the agent's job fetches it
 * to `rescueRef(branch)`, and the runner decides here whether to build on it.
 */

/**
 * Where the agent's job fetches the rescue branch to. Outside `refs/remotes/`
 * on purpose: implement-prd's `Mark the slice's commits` marks every commit
 * reachable from `HEAD` and from nothing under `--remotes`, and a rescued
 * commit is this run's to mark, since it was never pushed anywhere it counts.
 * The workflows name the same ref, and a test holds them equal.
 */
export const rescueRef = (branch: string): string => `refs/rescue/${branch}`;

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
