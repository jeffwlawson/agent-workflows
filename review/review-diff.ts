import { git } from "../shared/common.js";
import { DIFF_READ_LIMIT_BYTES, diffCommandAgainstBase } from "../shared/pr-feedback.js";
import type { PrdRound } from "../shared/prd-round.js";
import type { ReviewHistory } from "./review-round.js";

/**
 * The diff a review's prompt carries under `# PR DIFF` (#641).
 *
 * A **verification pass**, a review that follows a fix round, judges the last
 * round's findings and the commits since. Its prompt carries those commits'
 * diff, the pull request's whole diff of every file they touch, and the
 * pull request's `git diff --stat`; the rest of the diff is on disk, a `git
 * diff` away. Every other review carries the whole diff, as before.
 *
 * Only the prompt is scoped. Where a finding may be placed is still read off
 * the whole pull request's diff (`diffLines` in `review-context.ts`), so a
 * finding on a line this prompt left out but the pull request changed is
 * placed on that line.
 */
export type PromptDiff =
  /**
   * The whole pull request's diff: a first review, a final review, a slice
   * round, or a round that pushed nothing. `scopedSize` is present where this
   * was a verification pass whose scoped form would have been no smaller than
   * the whole diff (its size, as `scopedSize` measures it): a prompt that is
   * no smaller gains nothing and costs the reviewer the whole context, and
   * nothing is left out, so `howChecked` owes no note.
   */
  | { readonly kind: "whole"; readonly diff: string; readonly scopedSize?: number }
  /**
   * The whole diff, because this pass follows a fix round but the commits
   * since the last review could not be read. `reason` is a clause, for the
   * brief's sentence: the agent says it in `howChecked`.
   */
  | { readonly kind: "unreadable"; readonly reason: string; readonly diff: string }
  /**
   * Scoped to the commits since `reviewedHead`: `since` is their diff, `stat`
   * the whole pull request's `git diff --stat`, and `diff` the pull request's
   * diff of `files`, the files those commits touch that the pull request
   * changes.
   *
   * `mergedBase` is present where a merge of the base branch landed since the
   * reviewed head (an `update-branch` run, or a merge pushed by hand): it is
   * the merge base the pull request now has, and `since` is read against the
   * reviewed head merged with it, so the base branch's own changes are not
   * presented as the pull request's.
   */
  | {
      readonly kind: "since";
      readonly reviewedHead: string;
      readonly mergedBase?: string;
      readonly stat: string;
      readonly since: string;
      readonly files: readonly string[];
      readonly diff: string;
    };

/** The size of the scoped form's text the prompt carries: the stat, the commits since, and the touched files' diff. */
export const scopedSize = (d: { readonly stat: string; readonly since: string; readonly diff: string }): number =>
  d.stat.length + d.since.length + d.diff.length;

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() ?? "";

const read = (args: readonly string[]): string => git(args, { maxBuffer: DIFF_READ_LIMIT_BYTES });

/**
 * Which diff this review's prompt carries.
 *
 * Scoped only on an ordinary pull request: a PRD PR's slice round is scoped
 * by its slice (#341), and its final review reads every slice together.
 *
 * `whole` is the diff the run already read, and `changedFiles` the files it
 * changes, as `review-context.ts` keyed them: a file the commits since touch
 * but the pull request does not change (a file the fix round put back as the
 * base has it) has no hunk of the pull request's to show, and its change is in
 * `since`. A merge of the base branch since the reviewed head is read past, not
 * into `since`: see `readSinceFrom`.
 */
export const readPromptDiff = (
  history: ReviewHistory,
  round: PrdRound | undefined,
  baseRef: string,
  whole: string,
  changedFiles: Iterable<string>,
): PromptDiff => {
  if (round !== undefined || !history.afterFixRound) return { kind: "whole", diff: whole };
  if (history.unreadable !== undefined) return { kind: "unreadable", reason: history.unreadable, diff: whole };
  const head = history.reviewedHead;
  if (head === undefined) return { kind: "whole", diff: whole };

  const short = head.slice(0, 7);
  try {
    const old = readSinceFrom(head, baseRef);
    if (old.kind === "conflict") {
      return {
        kind: "unreadable",
        reason: `the base branch merged since ${short}, the head the last review read, does not merge cleanly into ${short}, so what the pull request's own commits changed since cannot be told apart from what the merge brought in`,
        diff: whole,
      };
    }
    const since = read(["-c", "core.quotePath=false", "diff", old.from, "HEAD"]);
    const changed = new Set(changedFiles);
    const files = read(["diff", "--name-only", "-z", old.from, "HEAD"])
      .split("\0")
      .filter((file) => file !== "" && changed.has(file))
      .sort();
    const stat = read([...diffCommandAgainstBase(baseRef), "--stat=1000"]);
    const diff = files.length === 0 ? "" : read(["--literal-pathspecs", ...diffCommandAgainstBase(baseRef), "--", ...files]);
    const scoped = { stat: stat.trimEnd(), since: since.trimEnd(), diff };
    // Where the round touched most of the pull request, the commits since and
    // the whole diff of the same files overlap, and the scoped form can be
    // larger than the whole (#698): carry the whole, which leaves nothing out.
    const size = scopedSize(scoped);
    if (size >= whole.length) return { kind: "whole", diff: whole, scopedSize: size };
    return {
      kind: "since",
      reviewedHead: head,
      ...(old.mergedBase === undefined ? {} : { mergedBase: old.mergedBase }),
      ...scoped,
      files,
    };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `git could not read the commits since ${short}, the head the last review read (${firstLine(error)})`,
      diff: whole,
    };
  }
};

/**
 * What `since` is read from. Where the pull request's merge base is still an
 * ancestor of the reviewed head, no base change has come in since, and it is
 * the reviewed head itself. Where it is not, a merge of the base branch landed
 * since, and a two-dot diff from the reviewed head would present every base
 * change in between as the fix round's (#698): the reviewed head is merged
 * with the merge base the pull request has now (`git merge-tree`, which writes
 * a tree and touches neither the index nor the worktree), and `since` is read
 * from that tree, which is the pull request as it was reviewed, on the base it
 * is on now. A merge that conflicts has no such tree.
 */
const readSinceFrom = (
  head: string,
  baseRef: string,
): { readonly kind: "clean"; readonly from: string; readonly mergedBase?: string } | { readonly kind: "conflict" } => {
  const mergeBase = read(["merge-base", baseRef, "HEAD"]).trim();
  if (isAncestor(mergeBase, head)) return { kind: "clean", from: head };
  let tree: string;
  try {
    tree = read(["merge-tree", "--write-tree", "--no-messages", head, mergeBase]);
  } catch (error) {
    // Exit status 1 is a conflict; anything else is git failing to read.
    if ((error as { status?: unknown }).status === 1) return { kind: "conflict" };
    throw error;
  }
  return { kind: "clean", from: tree.split("\n")[0]?.trim() ?? "", mergedBase: mergeBase };
};

const isAncestor = (ancestor: string, of: string): boolean => {
  try {
    read(["merge-base", "--is-ancestor", ancestor, of]);
    return true;
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return false;
    throw error;
  }
};

const fence = (lang: string, body: string): string => `\`\`\`${lang}\n${body}\n\`\`\``;

/** The `# PR DIFF` section's text above the fenced diff, which says what the diff below it is. */
export const renderDiffScope = (promptDiff: PromptDiff, baseRef: string): string => {
  const range = `\`git diff ${baseRef}...HEAD\``;
  if (promptDiff.kind === "whole") return `The whole pull request's diff against \`${baseRef}\`, ${range}:`;
  if (promptDiff.kind === "unreadable") {
    return [
      `This review follows a fix round, so this section would hold only what changed since the last review, but ${promptDiff.reason}. It holds the whole pull request's diff against \`${baseRef}\` instead, ${range}.`,
      "(`howChecked` records that this verification pass read the whole diff, and why.)",
    ].join("\n\n");
  }

  const short = promptDiff.reviewedHead.slice(0, 7);
  const touched =
    promptDiff.files.length === 0
      ? "None of the files those commits touch is one the pull request changes, so the diff below is empty."
      : `Below that, the pull request's whole diff of each file those commits touch that it changes (${promptDiff.files.map((f) => `\`${f}\``).join(", ")}), ${range} limited to them.`;
  return [
    `This review follows a fix round, so this section holds **what changed since the last review**, which read \`${short}\`, rather than the whole pull request. The rest of the pull request's diff is on disk: ${range} reads it, and \`git diff ${baseRef}...HEAD -- <file>\` one file of it. Read it wherever a judgement needs more than is here. A finding may be anchored on any line the pull request changes, not only on the lines shown here.`,
    `The whole pull request, \`git diff --stat ${baseRef}...HEAD\`:`,
    fence("text", promptDiff.stat),
    promptDiff.mergedBase === undefined
      ? `The commits since \`${short}\`, \`git diff ${short} HEAD\`:`
      : `The commits since \`${short}\`, with what the merge of \`${baseRef}\` since brought in taken out: \`git diff <tree> HEAD\`, where the tree is \`git merge-tree --write-tree ${short} ${promptDiff.mergedBase.slice(0, 7)}\`, the pull request as \`${short}\` had it on the base it is on now. The merge's own changes are the base branch's, and are not this review's to judge:`,
    fence("diff", promptDiff.since),
    touched,
  ].join("\n\n");
};
