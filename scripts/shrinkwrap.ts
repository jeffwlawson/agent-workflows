import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The release's dependency tree, shipped with it (#414).
 *
 * `npm exec` installs the package fresh on every run, and without this it
 * resolves each dependency range to whatever is newest that day (#403). Once a
 * command's writes are package code, that is code nobody tested running in the
 * same process as the loop's write token. A published `npm-shrinkwrap.json` is
 * the one lockfile npm honours inside a dependency, so it fixes the tree the
 * release was tested with.
 *
 * It is **generated at pack time and never committed**. `package-lock.json`
 * stays the one copy a person or `npm install` edits, and `prepack` derives this
 * from it on every pack, so a dependency change cannot ship beside a stale
 * shrinkwrap: there is no second copy to forget. `postpack` removes it again,
 * because npm prefers `npm-shrinkwrap.json` over `package-lock.json` at a
 * project root, and a leftover one would quietly take every later `npm install`
 * in the checkout.
 */
export const SHRINKWRAP = "npm-shrinkwrap.json";

/** The fields of a lockfile this reads. Everything else is carried through untouched. */
interface Lockfile {
  readonly packages: Readonly<Record<string, LockEntry>>;
  readonly [key: string]: unknown;
}

interface LockEntry {
  readonly dev?: boolean;
  readonly devDependencies?: unknown;
  readonly [key: string]: unknown;
}

/**
 * `lock` with the development tree taken out: the runtime tree, entry for entry.
 *
 * Dev entries are dropped rather than shipped, although `npm shrinkwrap` keeps
 * them. They pin nothing a run uses and are most of this lockfile, and dropped,
 * no npm version can mistake them for something to install. An entry marked
 * `devOptional` is kept: it is needed at runtime on some platform.
 */
export const shrinkwrapOf = (lock: Lockfile): Lockfile => {
  const packages = Object.fromEntries(
    Object.entries(lock.packages)
      .filter(([, entry]) => entry.dev !== true)
      .map(([location, entry]) => {
        if (location !== "") return [location, entry];
        const { devDependencies: _, ...root } = entry;
        return [location, root];
      }),
  );
  return { ...lock, packages };
};

/** Write `packageDir`'s shrinkwrap from its lockfile, in npm's own formatting. */
export const writeShrinkwrap = (packageDir: string): void => {
  const lock = JSON.parse(fs.readFileSync(path.join(packageDir, "package-lock.json"), "utf8")) as Lockfile;
  fs.writeFileSync(path.join(packageDir, SHRINKWRAP), `${JSON.stringify(shrinkwrapOf(lock), null, 2)}\n`);
};

/** Remove `packageDir`'s shrinkwrap, if there is one. */
export const removeShrinkwrap = (packageDir: string): void => {
  fs.rmSync(path.join(packageDir, SHRINKWRAP), { force: true });
};

// Run from `prepack` and `postpack`, not when imported by a test: the same
// realpath guard `copy-assets.ts` uses. Invoked from `dist/scripts/`, so the
// package root is two levels up.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = path.resolve(import.meta.dirname, "..", "..");
  const [mode, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || (mode !== undefined && mode !== "--remove")) {
    console.error(`Usage: shrinkwrap.js [--remove]. Refusing: ${process.argv.slice(2).join(" ")}`);
    process.exit(1);
  }
  if (mode === "--remove") {
    removeShrinkwrap(packageDir);
  } else {
    writeShrinkwrap(packageDir);
    console.log(`Wrote ${SHRINKWRAP} from package-lock.json.`);
  }
}
