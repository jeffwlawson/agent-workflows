import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The body of a tag's GitHub Release (#621): the install sentence, and an
 * **Adopter action** section listing what a repository running the loop must
 * do on moving its pin to this release.
 *
 * The section is read from `Adopter-Action: <sentence>` lines in the messages
 * of the commits between the previous `v*` tag and this one. A trailer lives in
 * the history the tag points at, so this reads it offline and a re-run reads
 * the same thing. Plain lines rather than `git interpret-trailers`: a squash
 * merge puts each commit's message end to end, so a trailer of an early commit
 * sits mid-body rather than in the final paragraph.
 *
 * Release policy for this repository, not something an adopter's install runs:
 * run from source by `publish.yml` like `sync-version.ts`, and excluded from
 * the build. Nothing built may import it.
 */

export const INSTALL =
  "Install without a registry token: npm install the tarball attached below, by its URL. Check it against the .sha256 beside it first.";

export const NO_ACTION = "No adopter action.";

export const NO_EARLIER_RELEASE = "No earlier release to compare with.";

/** Each commit a record: the separator, the short SHA on its own line, then the whole message. */
export const LOG_FORMAT = "%x1e%h%n%B";

const TRAILER = /^adopter-action:(.*)$/i;
const PULL_REQUEST = /\(#(\d+)\)\s*$/;

/**
 * The section, from `git log --format=LOG_FORMAT` text, or from `undefined`
 * where there is no earlier tag to read a range from.
 */
export const adopterActionSection = (log: string | undefined): string => {
  const heading = "## Adopter action\n\n";
  if (log === undefined) return `${heading}${NO_EARLIER_RELEASE}\n`;

  const items: string[] = [];
  for (const record of log.split("\x1e")) {
    const [sha = "", subject = "", ...rest] = record.replace(/\r/g, "").split("\n");
    if (sha.trim() === "") continue;
    const pr = PULL_REQUEST.exec(subject)?.[1];
    const where = pr === undefined ? sha.trim() : `${sha.trim()}, #${pr}`;
    for (const line of rest) {
      const action = TRAILER.exec(line)?.[1]?.trim();
      if (action) items.push(`- ${action} (${where})`);
    }
  }
  return `${heading}${items.length === 0 ? NO_ACTION : items.join("\n")}\n`;
};

/** The whole Release body. */
export const releaseNotes = (log: string | undefined): string => `${INSTALL}\n\n${adopterActionSection(log)}`;

const git = (args: readonly string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * The nearest `v*` tag reachable from `tag`'s parent, or `undefined` where there
 * is none: the first release, or a tag on a root commit. A `tag` git does not
 * know is an error, never "no earlier release".
 */
const previousTag = (tag: string): string | undefined => {
  try {
    git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
  } catch {
    console.error(`::error::${tag} names no commit in this checkout, so there is no range to read the Release's adopter actions from.`);
    process.exit(1);
  }
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v*", `${tag}^`]).trim() || undefined;
  } catch {
    return undefined;
  }
};

// Run by `publish.yml`, not when imported by a test: the same realpath guard
// `bundled-tree.ts` uses. The argument is the tag being released; the body is
// written to stdout, which the workflow puts in a file for `gh release create`.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [tag] = args;
  if (tag === undefined || args.length !== 1) {
    console.error(`Usage: release-notes.ts <tag>. Refusing: ${args.join(" ")}`);
    process.exit(1);
  }
  const previous = previousTag(tag);
  const log = previous === undefined ? undefined : git(["log", `--format=${LOG_FORMAT}`, `${previous}..${tag}`]);
  process.stdout.write(releaseNotes(log));
}
