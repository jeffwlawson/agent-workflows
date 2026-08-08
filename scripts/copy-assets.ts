import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The half of the build `tsc` will not do.
 *
 * Every runner resolves its prompt relative to `import.meta.dirname` —
 * `implement/prompt.md` sits beside `implement/implement.ts`. Compiled, that
 * path becomes `dist/implement/`, and `tsc` emits `.js` and nothing else. The
 * package publishes `files: ["dist"]`, so a prompt that is not copied resolves
 * fine in a checkout and is simply absent from the tarball — a failure that
 * appears only on a published version, in another repo's CI.
 *
 * Copies by walking rather than from a list, for the same reason the checks in
 * `tests/workflows.test.ts` do: a prompt added with a new runner is the exact
 * file nobody would remember to add to a list.
 */

/** Build output and scratch: never inputs, and `output/` is gitignored. */
const SKIPPED_DIRS = new Set(["dist", "node_modules", "output"]);

/**
 * Relative paths of every asset under `packageDir` that a runner may resolve.
 *
 * Root-level `.md` is deliberately excluded: the only one is the package's own
 * README, which npm serves from the tarball root anyway, and which no runner
 * reads. Nothing in `dist/` is an input.
 */
const assetsUnder = (dir: string, prefix = ""): readonly string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : assetsUnder(path.join(dir, entry.name), rel);
    }
    // `prefix` is empty only at the package root, which is the one level whose
    // Markdown is documentation rather than an asset.
    return prefix && entry.name.endsWith(".md") ? [rel] : [];
  });

/** Copy every prompt into `outDir`, keeping the path a runner will look under. */
export const copyAssets = (packageDir: string, outDir: string): readonly string[] => {
  const assets = assetsUnder(packageDir);
  for (const rel of assets) {
    const destination = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(packageDir, rel), destination);
  }
  return assets;
};

// Run as a build step, not when imported by a test — the same realpath guard
// `src/cli.ts` uses. Invoked from `dist/scripts/`, so the package root is two
// levels up and `dist` is one.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = path.resolve(import.meta.dirname, "..", "..");
  const copied = copyAssets(packageDir, path.join(packageDir, "dist"));
  console.log(`Copied ${copied.length} prompt file(s) into dist.`);
}
