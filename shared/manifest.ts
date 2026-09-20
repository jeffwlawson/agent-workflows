import * as fs from "node:fs";
import * as path from "node:path";

/**
 * This package's own identity: the name a pin carries and the version a pin
 * names.
 *
 * Read from the manifest rather than written down, for the reason every other
 * copy of the version is derived — seventeen sites already name it and an
 * eighteenth that nothing checks is the one that goes stale. `init` writes both
 * of these into *someone else's* repository, so they are the package's own
 * answer to "who am I", never the target tree's.
 *
 * The lookup has two candidates because the layout differs between a checkout
 * and the tarball: from `shared/` in the source tree the manifest is one level
 * up, and from `dist/shared/` it is two. `dist/` holds no manifest of its own,
 * so the first hit is always the real one.
 *
 * It lives here rather than in `cli.ts` because `setup/` needs it too, and a
 * `setup` module importing the CLI entry point to ask what version it is would
 * be importing the realpath guard and the dispatch table with it.
 */
const MANIFEST = [
  path.join("..", "package.json"),
  path.join("..", "..", "package.json"),
]
  .map((rel) => path.join(import.meta.dirname, rel))
  .find((file) => fs.existsSync(file));

const manifest: { readonly name?: string; readonly version?: string } = MANIFEST
  ? (JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as { name?: string; version?: string })
  : {};

/** Exact `major.minor.patch`, or `"unknown"` if the manifest could not be found. */
export const VERSION: string = manifest.version ?? "unknown";

/** The npm name — `@owner/repo`, which on GitHub is `owner/repo`. */
export const PACKAGE_NAME: string = manifest.name ?? "unknown";
