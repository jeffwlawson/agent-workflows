import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PinForm, Pinning } from "../shared/pins.ts";
import { ACTION_DIR, assertPinnable, escapeRe, rewritePins, WORKFLOW_DIR } from "../shared/pins.ts";

/**
 * The half of `npm version` npm will not do.
 *
 * A release names its version in twelve files. `npm version` bumps two of
 * them — the manifest and the lockfile — and the other ten hold the pins: one
 * `--package=…@<version>` per step of a reusable workflow that runs the
 * package (review's runner and each of its commands, #417), one
 * `npm install … @<version>` per step that installs it ahead of them (the red
 * check's, #422), and one `…yml@v<version>` per
 * caller in each of the two caller sets, whose callers sit two caller files to
 * a set (#225). `v0.1.4` and `v0.1.5` were both cut by editing
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
 * A local caller file is `agent-<name>.yml`, and its reference copy is
 * `examples/callers/<name>.yml`. The prefix exists so a caller file does not
 * collide by filename with a reusable workflow in the same directory.
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
 * One file's sites, with the count as the assertion.
 *
 * Every site of a release holds **exactly one** pin, of one known form, and that
 * is the property that makes a silent partial success impossible: a file whose
 * pin has been reworded, moved or written in a form the core does not know
 * matches zero times, and zero is an error rather than a no-op. A file can hold
 * more than one site: a reusable workflow's `npm exec` pin per step that runs
 * the package (#417) and one `action` pin per step naming a composite action
 * in this repository (#257), and a caller
 * file's one `ref` pin per caller it holds (#225). So the
 * forms found are compared with the forms expected, as a list. Returns the new
 * text; nothing is written from here, so a refusal later in the run leaves the
 * tree untouched.
 */
const pinned = (rel: string, text: string, forms: readonly PinForm[], pinning: Pinning): string => {
  const { text: rewritten, found } = rewritePins(text, pinning);
  if (found.length !== forms.length || [...found].sort().some((form, i) => form !== [...forms].sort()[i])) {
    throw new Error(
      `${rel}: expected ${forms.length === 1 ? "exactly 1 version pin" : `${forms.length} version pins`} ` +
        `[${forms.join(", ")}], found ${found.length} [${found.join(", ")}]. A site carries one pin, ` +
        `of one form: none means a pin this does not recognise and the release would leave behind, ` +
        `and any other set means a file whose shape the release does not know how to pin.`,
    );
  }
  return rewritten;
};

/**
 * Rewrite every version pin in the tree at `root` to `version`.
 *
 * The sites of one workflow live in three directories, so the set is
 * cross-checked rather than walked: a walk of any one directory finds the old
 * count when a new workflow is half-landed, and reports success. Both caller
 * sets must hold the same caller files, each set must call every reusable
 * workflow exactly once, and every file must carry exactly the pins expected
 * of it — otherwise nothing is written at all.
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
   * A reusable workflow is one that hands over to the published runner, found by
   * that line rather than by a list of the files that are *not* callers — `ci`,
   * `publish` and `token-expiry` are in the same directory and the next one
   * added would otherwise have to be remembered here.
   */
  const reusableNames = workflows
    .filter((file) => !file.startsWith(CALLER_PREFIX))
    .filter((file) => readFile(packageDir, `${WORKFLOW_DIR}/${file}`).includes(`--package=${packageName}@`))
    .map(nameOf);

  if (reusableNames.length === 0) {
    throw new Error(`${WORKFLOW_DIR} holds no reusable workflow naming ${packageName}; the pin set would be empty.`);
  }

  /**
   * The caller files, in both sets. A caller file holds one or more callers
   * (#225), so its name says nothing about which workflows it calls: the
   * local `agent-<name>.yml` and the reference `<name>.yml` are paired by
   * name, and what each calls is read out of it below.
   */
  const callerFiles = workflows.filter((file) => file.startsWith(CALLER_PREFIX)).map(nameOf);
  if (callerFiles.length === 0) {
    throw new Error(`${WORKFLOW_DIR} holds no ${CALLER_PREFIX}*.yml caller file; the pin set would be empty.`);
  }
  const localNames = callerFiles.map((name) => name.slice(CALLER_PREFIX.length));

  const exampleNames = ymlIn(packageDir, CALLER_DIR).map(nameOf);
  if (!sameSet(exampleNames, localNames)) {
    throw new Error(
      `${CALLER_DIR} holds caller files [${exampleNames.join(", ")}] but ${WORKFLOW_DIR} holds ` +
        `[${localNames.map((name) => `${CALLER_PREFIX}${name}`).join(", ")}]. Both caller sets move ` +
        `together: a stale example is an adopter running last release's runners, a stale local ` +
        `caller is this repo running them.`,
    );
  }

  /**
   * What a file names, counted by the path rather than by the pin: a `uses:`
   * that names one under any ref but a pin is a site this would otherwise skip,
   * and is refused instead. The composite actions a reusable names (#257) and
   * the reusable workflows a caller file names are found the same way, and so
   * is each step that runs the package (#417), by `--package=<name>@` under
   * any spec, and each that installs it (#422), by `npm install … <name>@`.
   */
  const packageUse = new RegExp(`--package=${escapeRe(packageName)}@`, "g");
  const packagesIn = (file: string): readonly PinForm[] =>
    (readFile(packageDir, file).match(packageUse) ?? []).map(() => "package" as const);
  const installUse = new RegExp(`npm install [^\\n]*?${escapeRe(packageName)}@`, "g");
  const installsIn = (file: string): readonly PinForm[] =>
    (readFile(packageDir, file).match(installUse) ?? []).map(() => "install" as const);
  const slug = escapeRe(packageName.replace(/^@/, ""));
  const actionUse = new RegExp(`${slug}/${escapeRe(ACTION_DIR)}/`, "g");
  const workflowUse = new RegExp(`${slug}/${escapeRe(WORKFLOW_DIR)}/([A-Za-z0-9._-]+)\\.yml@`, "g");
  const actionsIn = (file: string): readonly PinForm[] =>
    (readFile(packageDir, file).match(actionUse) ?? []).map(() => "action" as const);
  const calledBy = (file: string): readonly string[] =>
    [...readFile(packageDir, file).matchAll(workflowUse)].map((match) => match[1] ?? "");

  /**
   * Each caller set calls every reusable workflow exactly **once**. Fewer is a
   * workflow the set's adopters cannot run, and more is one that runs twice on
   * every label; either way the count a file is held to below would be the
   * count of a set that is wrong.
   */
  const sets = [
    { dir: WORKFLOW_DIR, files: localNames.map((name) => `${WORKFLOW_DIR}/${CALLER_PREFIX}${name}.yml`) },
    { dir: CALLER_DIR, files: localNames.map((name) => `${CALLER_DIR}/${name}.yml`) },
  ];
  for (const { dir, files } of sets) {
    const idle = files.find((file) => calledBy(file).length === 0);
    if (idle !== undefined) {
      throw new Error(`${idle} calls no reusable workflow; a caller file with no pin is one the release cannot move.`);
    }
    const called = files.flatMap(calledBy);
    if (!sameSet(called, reusableNames)) {
      throw new Error(
        `The caller files in ${dir} call [${called.join(", ")}] but the reusable workflows are ` +
          `[${[...reusableNames].sort().join(", ")}]. Each caller set calls every reusable workflow ` +
          `exactly once; a set that disagrees is a release that would pin some of them.`,
      );
    }
  }

  const sites: readonly VersionSite[] = [
    ...reusableNames.flatMap((name) => {
      const file = `${WORKFLOW_DIR}/${name}.yml`;
      return [...packagesIn(file), ...installsIn(file), ...actionsIn(file)].map((form) => ({ file, form }));
    }),
    ...sets.flatMap(({ files }) =>
      files.flatMap((file) => calledBy(file).map(() => ({ file, form: "ref" as const }))),
    ),
  ];

  // Every refusal is raised before the first write, so a run that throws leaves
  // every file as it was rather than some prefix of them rewritten.
  const files = [...new Set(sites.map((site) => site.file))];
  const pending = files.map((file) => ({
    file,
    text: pinned(
      file,
      readFile(packageDir, file),
      sites.filter((site) => site.file === file).map((site) => site.form),
      { packageName, version },
    ),
  }));

  for (const { file, text } of pending) {
    const full = path.join(packageDir, ...file.split("/"));
    // Write only on a real change: the rewrite is a fixed point, so re-running
    // over an already-pinned tree is how a release checks itself.
    if (fs.readFileSync(full, "utf8") !== text) fs.writeFileSync(full, text);
  }

  return sites;
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
 * around into the release commit and the tag `publish.yml` fires on — a
 * thirteenth file inside a release, which nothing in the suite can see.
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
  const git = (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd: packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /**
   * A release is cut from the tip of `origin`'s default branch, and from nowhere
   * else.
   *
   * `publish.yml` already refuses a tag on a commit that branch does not
   * contain, but only once the tag is pushed — and v0.7.9 was first cut in a
   * worktree one merge behind, which would have tagged a release missing the
   * change it was cut to ship. Asked of `origin` itself rather than of a
   * remote-tracking ref, because a stale `origin/main` is exactly how a
   * checkout comes to be behind without knowing it; and the branch is the one
   * origin names, as `publish.yml` takes it from the repository. Ahead is
   * refused too: a commit that reaches the default branch only inside a release
   * push is one no pull request reviewed.
   */
  const assertReleaseTip = (): void => {
    let remote = "";
    let branch = "";
    let head = "";
    try {
      remote = git(["ls-remote", "--symref", "origin", "HEAD"]);
      branch = git(["branch", "--show-current"]);
      head = git(["rev-parse", "HEAD"]);
    } catch (error) {
      const { stderr } = error as { readonly stderr?: Buffer | string };
      throw new Error(`Could not ask git where this release would be cut: ${String(stderr ?? error).trim()}.`);
    }
    // `ref: refs/heads/<branch>\tHEAD`, then `<sha>\tHEAD`.
    const base = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote)?.[1];
    const tip = /^([0-9a-f]{40,64})\tHEAD$/m.exec(remote)?.[1];
    const where =
      base === undefined || tip === undefined
        ? "origin names no default branch"
        : branch !== base
          ? `the branch here is ${branch === "" ? "a detached HEAD" : `\`${branch}\``}, not \`${base}\``
          : head !== tip
            ? `HEAD is ${head.slice(0, 7)} but origin's \`${base}\` is ${tip.slice(0, 7)}`
            : undefined;
    if (where !== undefined) {
      throw new Error(
        `Refusing to release: ${where}. A release is cut at the tip of origin's default branch, so the ` +
          `tag carries what is merged and nothing else. Undo npm's bump with ` +
          `\`git checkout -- package.json package-lock.json\`, bring the checkout level with origin, and retry.`,
      );
    }
  };

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
    assertReleaseTip();
    const sites = syncVersion(version ?? "", packageDir);
    stage(sites.map((site) => site.file));
    console.log(`Synced ${sites.length} version pin(s) to ${version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
