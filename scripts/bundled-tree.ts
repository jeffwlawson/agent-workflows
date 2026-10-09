import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The release's dependency tree, shipped inside it (#430).
 *
 * `npm exec` installs the package fresh on every run, and left to resolve each
 * dependency range it takes whatever is newest that day (#403): code nobody
 * tested, running in the same process as the loop's write token. #414 shipped an
 * `npm-shrinkwrap.json` to pin it, but npm reads a dependency's shrinkwrap only
 * when the registry's metadata sets `_hasShrinkwrap`, and GitHub Packages never
 * sets it. So the package lists every runtime dependency in `bundleDependencies`
 * instead, and npm installs those from the tarball as they are, whatever the
 * registry says.
 *
 * What can go wrong is a tarball whose bundled dependencies are not the tree
 * `package-lock.json` resolves, which is the tree the suite and CI installed and
 * ran. `npm pack` bundles whatever `node_modules` holds, so a pack from a tree
 * `npm ci` did not build ships it silently. This compares the two: every runtime
 * entry of the lockfile, at its version, and nothing else.
 *
 * **Run from source and never emitted**, as `sync-version.ts` is: `publish.yml`
 * runs it with Node's type stripping against a pack and against an install of
 * the release, and `tsconfig.build.json` excludes it.
 */

/** The fields of a lockfile this reads. */
interface Lockfile {
  readonly packages: Readonly<Record<string, LockEntry>>;
}

interface LockEntry {
  readonly version?: string;
  readonly dev?: boolean;
  readonly hasInstallScript?: boolean;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
}

/** A tree of packages: each location under a package root, `node_modules/…`, to its version. */
export type Tree = ReadonlyMap<string, string>;

/**
 * The runtime tree `lock` resolves: every entry but the root and the dev ones.
 * An entry marked `devOptional` is kept, since some platform needs it at runtime.
 */
export const lockedTree = (lock: Lockfile): Tree =>
  new Map(
    Object.entries(lock.packages)
      .filter(([location, entry]) => location !== "" && entry.dev !== true)
      .map(([location, entry]) => [location, entry.version ?? ""]),
  );

/**
 * The runtime entries of `lock` that would run code at install or refuse a
 * platform: an install script, an `os` field or a `cpu` field. Bundling builds
 * the tree once, on the publishing runner, so either would ship what that runner
 * built or allowed to every platform the loop runs on.
 */
export const platformBound = (lock: Lockfile): readonly string[] =>
  Object.entries(lock.packages)
    .filter(([location, entry]) => location !== "" && entry.dev !== true)
    .filter(([, entry]) => entry.hasInstallScript === true || entry.os !== undefined || entry.cpu !== undefined)
    .map(([location]) => location);

/**
 * The packages under `packageDir/node_modules`, at any depth, read from each
 * one's `package.json`. A scope folder holds packages rather than being one, and
 * a dot entry (`.bin`, `.package-lock.json`) is npm's own and not a package.
 */
export const bundledTree = (packageDir: string): Tree => {
  const tree = new Map<string, string>();
  const walk = (location: string): void => {
    const modules = path.join(packageDir, location, "node_modules");
    if (!fs.existsSync(modules)) return;
    for (const name of fs.readdirSync(modules)) {
      if (name.startsWith(".")) continue;
      const names = name.startsWith("@")
        ? fs.readdirSync(path.join(modules, name)).map((child) => `${name}/${child}`)
        : [name];
      for (const each of names) {
        const at = path.posix.join(location, "node_modules", each);
        const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, at, "package.json"), "utf8")) as {
          readonly version?: string;
        };
        tree.set(at, manifest.version ?? "");
        walk(at);
      }
    }
  };
  walk("");
  return tree;
};

/** Each way `bundled` differs from the runtime tree `lock` resolves, one sentence apiece. */
export const treeMismatches = (lock: Lockfile, bundled: Tree): readonly string[] => {
  const locked = lockedTree(lock);
  const problems: string[] = [];
  for (const [location, version] of locked) {
    const found = bundled.get(location);
    if (found === undefined) problems.push(`${location} ${version} is in package-lock.json and missing.`);
    else if (found !== version) problems.push(`${location} is ${found}, and package-lock.json resolves ${version}.`);
  }
  for (const [location, version] of bundled) {
    if (locked.has(location)) continue;
    problems.push(
      lock.packages[location]?.dev === true
        ? `${location} ${version} is a dev dependency, which must not ship.`
        : `${location} ${version} is not in package-lock.json's runtime tree.`,
    );
  }
  return problems;
};

// Run by `publish.yml`, not when imported by a test: the same realpath guard
// `copy-assets.ts` uses. Run from source in `scripts/`, so the lockfile is one
// level up. The argument is the package root to read, a pack extracted or an
// install of the release.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [packageDir] = args;
  if (packageDir === undefined || args.length !== 1) {
    console.error(`Usage: bundled-tree.ts <package-dir>. Refusing: ${args.join(" ")}`);
    process.exit(1);
  }
  const lock = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "package-lock.json"), "utf8"),
  ) as Lockfile;
  const problems = treeMismatches(lock, bundledTree(packageDir));
  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error::${problem}`);
    console.log(
      `::error::The bundled dependencies under ${packageDir} are not the tree package-lock.json resolves, so a run would use packages the suite never ran. Pack from a tree npm ci built.`,
    );
    process.exit(1);
  }
  console.log(`The bundled dependencies under ${packageDir} are package-lock.json's runtime tree, ${lockedTree(lock).size} packages.`);
}
