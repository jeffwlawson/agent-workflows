import { briefSection, type Brief } from "./acceptance-criteria.js";
import { git } from "../shared/common.js";
import {
  MAX_SINCE_COMMITS,
  sinceBriefListed,
  type SinceBrief,
  type SinceCommit,
  type SinceCommits,
} from "../shared/review-output.js";

/**
 * What merged since the linked issue's brief was read (#541).
 *
 * A brief names its files in a *Where things are* section, read at a commit on
 * the default branch it names there. Work merged after that can change what a
 * criterion assumed while leaving every name in place, which #447's check (do
 * the named things still exist) cannot see. So the workflow, before the agent
 * starts, lists the commits since that commit that touched those files, and
 * the review rules on whether any changes what a criterion means.
 *
 * Read leniently, because the briefs already written differ: the section opens
 * at a heading or a bold label on a line of its own containing "where things
 * are"; the read-at commit is the first 7-to-40-character hex word in it; and
 * the files are its backticked words that name a path at that commit.
 *
 * Every word here is issue text, so none reaches git as an option: the commit
 * is matched as hex before git sees it, a path goes after a `<commit>:` or
 * after `--`, and pathspecs are read literally.
 */

const WHERE_THINGS_ARE = /where things are/i;
/** A hex word: not part of a longer word, a path segment's neighbour excepted. */
const HEX_WORD = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/i;
const BACKTICKED = /`([^`\s]+)`/g;

/** A path as git looks it up: no leading `./` and no trailing `/`. */
const asPath = (word: string): string => word.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");

/** The commit `word` names, in full, or undefined where it names none. `word` is hex, so never an option. */
const resolveCommit = (word: string): string | undefined => {
  try {
    return git(["rev-parse", "--verify", "--quiet", `${word}^{commit}`]).trim() || undefined;
  } catch {
    return undefined;
  }
};

const isAncestor = (commit: string, base: string): boolean => {
  try {
    git(["merge-base", "--is-ancestor", commit, base]);
    return true;
  } catch {
    return false;
  }
};

/** Whether `path` is a file or a directory at `commit`. After the `:`, so a leading `-` is part of the path. */
const pathAt = (commit: string, path: string): boolean => {
  if (path === "") return false;
  try {
    const type = git(["cat-file", "-t", `${commit}:${path}`]).trim();
    return type === "blob" || type === "tree";
  } catch {
    return false;
  }
};

/** Every commit `revs` select that touched one of `paths`, newest first. */
const commitsTouching = (revs: readonly string[], paths: readonly string[]): SinceCommit[] =>
  git(["--literal-pathspecs", "log", "--format=%H%x1f%s%x1e", ...revs, "--", ...paths])
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = ""] = record.split("\x1f");
      return { sha, subject };
    });

/** `commits` cut to `room`, with how many were cut. */
const capped = (commits: readonly SinceCommit[], room: number): SinceCommits => ({
  commits: commits.slice(0, Math.max(0, room)),
  more: Math.max(0, commits.length - Math.max(0, room)),
});

/**
 * The check, against the checkout: `base` is the pull request's base branch,
 * a local ref, and `branchBefore`, on a PRD PR's slice round, the commit this
 * slice was built on, so the PRD branch's earlier slices and catch-up merges
 * are listed apart from the base's. The commits under review are on neither.
 *
 * At most `MAX_SINCE_COMMITS` in all, the base's first, each group with a
 * count of the rest.
 */
export const checkSinceBrief = (brief: Brief, base: string, branchBefore?: string): SinceBrief => {
  const section = briefSection(brief, WHERE_THINGS_ARE);
  if (section === undefined) return { kind: "not run", reason: "no section" };
  const text = section.join("\n");
  const commit = HEX_WORD.exec(text)?.[0]?.toLowerCase();
  if (commit === undefined) return { kind: "not run", reason: "no read-at commit" };
  const readAt = resolveCommit(commit);
  if (readAt === undefined) return { kind: "not run", reason: "unresolved", commit };
  if (!isAncestor(readAt, base)) return { kind: "not run", reason: "not an ancestor", commit };

  const named = [...new Set([...text.matchAll(BACKTICKED)].map((match) => match[1] ?? ""))];
  const files: string[] = [];
  const notFound: string[] = [];
  for (const word of named) {
    const path = asPath(word);
    if (pathAt(readAt, path)) {
      if (!files.includes(path)) files.push(path);
    } else if (word.includes("/")) {
      notFound.push(word);
    }
  }
  if (files.length === 0) {
    return { kind: "not run", reason: "no file found", commit, ...(notFound.length === 0 ? {} : { notFound }) };
  }

  const onBase = commitsTouching([base, `^${readAt}`], files);
  const onBranch = branchBefore === undefined ? undefined : commitsTouching([branchBefore, `^${base}`, `^${readAt}`], files);
  const baseGroup = capped(onBase, MAX_SINCE_COMMITS);
  return {
    kind: "ran",
    commit,
    files,
    gone: files.filter((path) => !pathAt(base, path)),
    notFound,
    onBase: baseGroup,
    ...(onBranch === undefined ? {} : { onBranch: capped(onBranch, MAX_SINCE_COMMITS - baseGroup.commits.length) }),
  };
};

const SKIPPED = "Nothing to rule on: leave `sinceBrief` out.";

/**
 * The check as the review agent is shown it, beside the criteria: the commits
 * to rule on, or one line saying why there are none.
 */
export const renderSinceBriefForReview = (since: SinceBrief | undefined): string => {
  if (since === undefined) return `(No check ran, since there are no criteria. ${SKIPPED})`;
  if (since.kind === "not run") return `(The check could not run: ${since.reason}. ${SKIPPED})`;
  if (!sinceBriefListed(since)) {
    return `(No commit since \`${since.commit}\`, where the brief was read, touched the files it names. ${SKIPPED})`;
  }
  const group = (title: string, group: SinceCommits | undefined): string[] =>
    group === undefined || group.commits.length + group.more === 0
      ? []
      : [
          title,
          "",
          ...group.commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`),
          ...(group.more === 0 ? [] : [`- (and ${group.more} more, which \`git log\` lists)`]),
          "",
        ];
  return [
    `The brief was read at \`${since.commit}\`, and names these files: ${since.files.map((f) => `\`${f}\``).join(", ")}.`,
    ...(since.gone.length === 0 ? [] : [`Of those, no longer at the base: ${since.gone.map((f) => `\`${f}\``).join(", ")}.`]),
    "",
    ...group("Commits on the base branch since then that touched them, newest first (`git show <sha>` reads one):", since.onBase),
    ...group(
      "Commits on this pull request's branch before this slice (earlier slices and merges of the base) that touched them, newest first:",
      since.onBranch,
    ),
  ]
    .join("\n")
    .trimEnd();
};
