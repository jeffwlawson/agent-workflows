import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PinForm, Pinning } from "../shared/pins.ts";
import { assertPinnable, rewritePins, WORKFLOW_DIR } from "../shared/pins.ts";

/**
 * The half of `npm version` npm will not do.
 *
 * A release names its version in twenty files. `npm version` bumps two of
 * them — the manifest and the lockfile — and the other eighteen are pins: one
 * `--package=…@<version>` per reusable workflow, and one `…yml@v<version>` in
 * each of the two caller sets. `v0.1.4` and `v0.1.5` were both cut by editing
 * them by hand and folding the result into the version commit.
 *
 * This **propagates; it never decides**. The bump is npm's, the version is read
 * from the manifest npm has already written, and nothing here commits or tags —
 * `npm version` does both, and `publish.yml` fires on the tag push, so a second
 * tagging path here would be a second way to publish a release.
 *
 * It is a module with a thin CLI on the end rather than a script so the tests
 * can point it at a scratch copy of the tree. A propagator that can only run
 * against the checkout it lives in is one whose refusals — the half that matters
 * — can only be exercised by breaking this repository on purpose.
 *
 * `syncVersion` is the **release** half and nothing else can use it: the
 * three-directory cross-check below is *this* repository's shape, and an
 * unexpected count is an error here precisely because a missed site is a broken
 * release. `init` (#6) does the same rewrite for the opposite reason — this
 * package's name and version, written into *someone else's* repository, over
 * whatever subset of the callers an adopter took.
 *
 * What the two share is `rewritePins`, and it lives in `shared/pins.ts` rather
 * than here: this file is deliberately kept out of the published tarball, and an
 * `exclude` does not survive being imported. Both callers bring their own file
 * discovery, their own version source and their own policy on a surprising
 * count — which is why that one is the seam.
 */

/** Forward slashes on purpose: these are paths *inside* YAML, not on disk. */
const CALLER_DIR = "examples/callers";

/**
 * A caller is `agent-<name>.yml` and the reusable it calls is `<name>.yml`, in
 * the same directory — the prefix exists so the two do not collide by filename.
 */
const CALLER_PREFIX = "agent-";

export interface VersionSite {
  /** Repo-relative, forward-slashed — the path as a human would write it. */
  readonly file: string;
  readonly form: PinForm;
}

const ymlIn = (root: string, dir: string): readonly string[] => {
  const full = path.join(root, ...dir.split("/"));
  if (!fs.existsSync(full)) {
    throw new Error(`${dir} does not exist under ${root}; there is nothing to propagate a version into.`);
  }
  return fs
    .readdirSync(full)
    .filter((entry) => entry.endsWith(".yml"))
    .sort();
};

const nameOf = (file: string): string => path.basename(file, ".yml");

const readFile = (root: string, rel: string): string =>
  fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

/** Compared as sets: the three directories sort the same way only by accident. */
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const [left, right] = [[...a].sort(), [...b].sort()];
  return left.length === right.length && left.every((name, i) => name === right[i]);
};

/**
 * One site, with the count as the assertion.
 *
 * Every site of a release holds **exactly one** pin, of one known form, and that
 * is the property that makes a silent partial success impossible: a file whose
 * pin has been reworded, moved or written in a form the core does not know
 * matches zero times, and zero is an error rather than a no-op. Returns the new
 * text; nothing is written from here, so a refusal later in the run leaves the
 * tree untouched.
 */
const pinnedOnce = (rel: string, text: string, form: PinForm, pinning: Pinning): string => {
  const { text: rewritten, found } = rewritePins(text, pinning);
  if (found.length !== 1 || found[0] !== form) {
    throw new Error(
      `${rel}: expected exactly 1 version pin of the ${form} form, found ${found.length} ` +
        `[${found.join(", ")}]. A site carries one pin, of one form: none means a pin this does ` +
        `not recognise and the release would leave behind, and any other set means a file whose ` +
        `shape the release does not know how to pin.`,
    );
  }
  return rewritten;
};

/**
 * Rewrite every version pin in the tree at `root` to `version`.
 *
 * The three sites of one workflow live in three directories, so the set is
 * cross-checked rather than walked: a walk of any one directory finds the old
 * count when a new workflow is half-landed, and reports success. Every directory must
 * name the same workflows, every named file must exist, and every file must
 * carry its one pin — otherwise nothing is written at all.
 */
export const syncVersion = (version: string, packageDir = "."): readonly VersionSite[] => {
  // Before the first file is opened, rather than distributed to every one of
  // them for the suite to reject one at a time.
  assertPinnable(version);

  const manifest = JSON.parse(readFile(packageDir, "package.json")) as { readonly name?: string };
  const packageName = manifest.name;
  if (packageName === undefined) {
    throw new Error(`${packageDir}/package.json declares no name; there is no pin to look for.`);
  }

  const workflows = ymlIn(packageDir, WORKFLOW_DIR);

  /**
   * The callers are the source of truth for *which* workflows exist: a caller is
   * the file an adopter installs, and nothing in the loop runs without one.
   */
  const expectedNames = workflows
    .filter((file) => file.startsWith(CALLER_PREFIX))
    .map((file) => nameOf(file).slice(CALLER_PREFIX.length));

  if (expectedNames.length === 0) {
    throw new Error(`${WORKFLOW_DIR} holds no ${CALLER_PREFIX}*.yml caller; the pin set would be empty.`);
  }

  /**
   * A reusable workflow is one that hands over to the published runner, found by
   * that line rather than by a list of the files that are *not* callers — `ci`,
   * `publish` and `token-expiry` are in the same directory and the next one
   * added would otherwise have to be remembered here.
   */
  const reusableNames = workflows
    .filter((file) => !file.startsWith(CALLER_PREFIX))
    .filter((file) => readFile(packageDir, `${WORKFLOW_DIR}/${file}`).includes(`--package=${packageName}@`))
    .map(nameOf);

  if (!sameSet(reusableNames, expectedNames)) {
    throw new Error(
      `${WORKFLOW_DIR} holds callers for [${expectedNames.join(", ")}] but reusable workflows for ` +
        `[${reusableNames.join(", ")}]. Every workflow is a caller and a reusable half; a set that ` +
        `disagrees is a release that would pin some of them.`,
    );
  }

  const exampleNames = ymlIn(packageDir, CALLER_DIR).map(nameOf);
  if (!sameSet(exampleNames, expectedNames)) {
    throw new Error(
      `${CALLER_DIR} holds callers for [${exampleNames.join(", ")}] but ${WORKFLOW_DIR} holds ` +
        `[${expectedNames.join(", ")}]. Both caller sets move together: a stale example is an ` +
        `adopter running last release's runners, a stale local caller is this repo running them.`,
    );
  }

  const sites: readonly VersionSite[] = [
    ...expectedNames.map((name) => ({
      file: `${WORKFLOW_DIR}/${name}.yml`,
      form: "package" as const,
    })),
    ...expectedNames.flatMap((name) =>
      [`${WORKFLOW_DIR}/${CALLER_PREFIX}${name}.yml`, `${CALLER_DIR}/${name}.yml`].map((file) => ({
        file,
        form: "ref" as const,
      })),
    ),
  ];

  // Every refusal is raised before the first write, so a run that throws leaves
  // every file as it was rather than some prefix of them rewritten.
  const pending = sites.map((site) => ({
    ...site,
    text: pinnedOnce(site.file, readFile(packageDir, site.file), site.form, { packageName, version }),
  }));

  for (const site of pending) {
    const full = path.join(packageDir, ...site.file.split("/"));
    // Write only on a real change: the rewrite is a fixed point, so re-running
    // over an already-pinned tree is how a release checks itself.
    if (fs.readFileSync(full, "utf8") !== site.text) fs.writeFileSync(full, site.text);
  }

  return pending.map(({ file, form }) => ({ file, form }));
};

/**
 * Run as npm's `version` lifecycle script, not when imported by a test — the
 * same realpath guard `scripts/copy-assets.ts` uses.
 *
 * Invoked from the source tree (`node scripts/sync-version.ts`, type-stripped by
 * Node 24), so the package root is one level up. **It takes no arguments**: the
 * version comes from the manifest npm has already bumped, which is the copy
 * `publish.yml` cross-checks against the tag. A version passed in would be a
 * second source of truth for the one value the release is about.
 *
 * It stages, because npm does not: the hook runs before the commit and npm adds
 * only the manifest and the lockfile. Staging happens **by path**, from what
 * `syncVersion` returned. `npm version` blocks a dirty tree only for *tracked*
 * modifications, so a `git add -A` here would sweep any untracked file lying
 * around into the release commit and the tag `publish.yml` fires on — an
 * twenty-first file inside a release, which nothing in the suite can see.
 */
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = path.resolve(import.meta.dirname, "..");
  const args = process.argv.slice(2);

  if (args.length > 0) {
    console.error(
      `sync-version takes no arguments, but got: ${args.join(" ")}. The version is read from package.json.`,
    );
    process.exit(2);
  }

  const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
    readonly version?: string;
  };

  /** argv, not a shell string — the convention every variable reaching git follows. */
  const stage = (files: readonly string[]): void => {
    try {
      execFileSync("git", ["add", "--", ...files], {
        cwd: packageDir,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      const { stderr } = error as { readonly stderr?: Buffer | string };
      throw new Error(
        `Rewrote ${files.length} pin(s) but could not stage them: ${String(stderr ?? error).trim()}. ` +
          `They are in the working tree; the release commit would not have contained them.`,
      );
    }
  };

  try {
    const sites = syncVersion(version ?? "", packageDir);
    stage(sites.map((site) => site.file));
    console.log(`Synced ${sites.length} version pin(s) to ${version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
