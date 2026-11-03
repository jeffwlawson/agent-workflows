import { git } from "../shared/common.js";
import { parseRenameSources } from "../shared/diff-lines.js";
import {
  DIFF_READ_LIMIT_BYTES,
  changedFilesCommandAgainstBase,
  diffCommandAgainstBase,
  type PullRequestFeedback,
} from "../shared/pr-feedback.js";

/**
 * The diff a fix run's prompt carries under `# PR DIFF` (#642).
 *
 * A fix run works in a checkout at the head, and its work is the open
 * findings and comments. So its prompt carries the pull request's diff of the
 * files those name, the `--stat` of every other file the pull request changes,
 * and where the rest is (`git diff <base>...HEAD`), rather than the whole diff.
 *
 * The whole diff wherever anything asks for work without naming a file: a
 * conversation comment owed an answer, a maintainer's review body, a thread or
 * a minor finding on a path the pull request does not change (or whose path
 * did not come back), or a surface that could not be read, whose content is
 * unknown. And where the scoped form would be no smaller, since it would then
 * leave something out for nothing.
 */
export type FixDiff =
  | { readonly kind: "whole"; readonly diff: string }
  | {
      readonly kind: "named";
      /** The files the open findings name, each one the pull request changes. */
      readonly files: readonly string[];
      /** `git diff --stat` of every other file the pull request changes. */
      readonly stat: string;
      /** The pull request's diff of `files`. */
      readonly diff: string;
    };

/**
 * The path a minor finding's location names: `path:line`, `path:start-end`,
 * `path:?`, or a path alone for a file-level one (the shapes `locationOf` in
 * `shared/pr-feedback.ts` writes, and the review's own `path:line`).
 */
const pathOfLocation = (location: string): string => {
  const trimmed = location.trim();
  return /^(.+?):(?:\d+(?:-\d+)?|\?)$/.exec(trimmed)?.[1] ?? trimmed;
};

/**
 * The files the open findings name, or `undefined` where something owed work
 * names none, and the run needs the whole diff to see what it is about.
 */
const namedFiles = (feedback: PullRequestFeedback): string[] | undefined => {
  if (feedback.unreadable.length > 0) return undefined;
  if (feedback.conversationComments.length > 0 || feedback.humanSummaries !== "") return undefined;
  const changed = new Set(feedback.changedFiles);
  const named = new Set<string>();
  for (const path of [...feedback.threadPaths, ...feedback.minorFindings.map((f) => pathOfLocation(f.location))]) {
    if (path === undefined || !changed.has(path)) return undefined;
    named.add(path);
  }
  return named.size === 0 ? undefined : feedback.changedFiles.filter((file) => named.has(file));
};

const read = (args: readonly string[]): string => git(args, { maxBuffer: DIFF_READ_LIMIT_BYTES });

/** Which diff this fix run's prompt carries; `feedback.diff` is the whole one, already read. */
export const readFixDiff = (feedback: PullRequestFeedback, baseRef: string): FixDiff => {
  const whole: FixDiff = { kind: "whole", diff: feedback.diff };
  const files = namedFiles(feedback);
  if (files === undefined) return whole;
  const rest = feedback.changedFiles.filter((file) => !files.includes(file));
  if (rest.length === 0) return whole;

  // A rename's source beside its destination, in both pathspecs: with the
  // destination alone git cannot see the move, and shows moved code as a new
  // file this pull request wrote.
  const sources = parseRenameSources(read(changedFilesCommandAgainstBase(baseRef)));
  const withSources = (paths: readonly string[]): string[] =>
    paths.flatMap((file) => {
      const source = sources.get(file);
      return source === undefined ? [file] : [source, file];
    });

  const diff = read(["--literal-pathspecs", ...diffCommandAgainstBase(baseRef), "--", ...withSources(files)]);
  const stat = read(["--literal-pathspecs", ...diffCommandAgainstBase(baseRef), "--stat=1000", "--", ...withSources(rest)]).trimEnd();
  if (diff.length + stat.length >= feedback.diff.length) return whole;
  return { kind: "named", files, stat, diff };
};

const fence = (lang: string, body: string): string => `\`\`\`${lang}\n${body}\n\`\`\``;

/** The `# PR DIFF` section's text above the fenced diff, which says what the diff below it is. */
export const renderFixDiffScope = (fixDiff: FixDiff, baseRef: string): string => {
  const range = `\`git diff ${baseRef}...HEAD\``;
  if (fixDiff.kind === "whole") {
    return `The change under review: the pull request's whole diff against \`${baseRef}\`, ${range}, exactly what GitHub shows:`;
  }
  return [
    `The change under review, limited to the files the open findings name (${fixDiff.files.map((f) => `\`${f}\``).join(", ")}). The rest of the pull request's diff is on disk: ${range} reads it whole, and \`git diff ${baseRef}...HEAD -- <file>\` one file of it. Read it wherever a fix needs more than is here, and before you decide a finding's class has no other member: a member can sit in a file shown only in the stat.`,
    `The other files the pull request changes, \`git diff --stat ${baseRef}...HEAD\` of them:`,
    fence("text", fixDiff.stat),
    `The pull request's diff of the files the findings name, ${range} limited to them:`,
  ].join("\n\n");
};
