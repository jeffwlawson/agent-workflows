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
  /** The whole pull request's diff: a first review, a final review, a slice round, or a round that pushed nothing. */
  | { readonly kind: "whole"; readonly diff: string }
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
   */
  | {
      readonly kind: "since";
      readonly reviewedHead: string;
      readonly stat: string;
      readonly since: string;
      readonly files: readonly string[];
      readonly diff: string;
    };

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
 * base has it, or one a merge of the base brought in) has no hunk of the pull
 * request's to show, and its change is in `since`.
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
    const since = read(["-c", "core.quotePath=false", "diff", head, "HEAD"]);
    const changed = new Set(changedFiles);
    const files = read(["diff", "--name-only", "-z", head, "HEAD"])
      .split("\0")
      .filter((file) => file !== "" && changed.has(file))
      .sort();
    const stat = read([...diffCommandAgainstBase(baseRef), "--stat=1000"]);
    const diff = files.length === 0 ? "" : read(["--literal-pathspecs", ...diffCommandAgainstBase(baseRef), "--", ...files]);
    return { kind: "since", reviewedHead: head, stat: stat.trimEnd(), since: since.trimEnd(), files, diff };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `git could not read the commits since ${short}, the head the last review read (${firstLine(error)})`,
      diff: whole,
    };
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
      "**Say so in `howChecked`**: that this verification pass read the whole diff, and why.",
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
    `The commits since \`${short}\`, \`git diff ${short} HEAD\`:`,
    fence("diff", promptDiff.since),
    touched,
  ].join("\n\n");
};
