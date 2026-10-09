import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledTree, lockedTree, platformBound, treeMismatches } from "../scripts/bundled-tree.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The release ships the dependency tree it was tested with, inside it (#430).
 *
 * #414 shipped a shrinkwrap for this, and GitHub Packages never sets the
 * `_hasShrinkwrap` flag npm needs before it reads one, so the package bundles its
 * runtime dependencies instead. What can go wrong is a tarball whose bundled tree
 * is not the lockfile's, or an install that resolves a range afresh anyway. These
 * hold the declaration, the comparison, and a real pack and install of it.
 */

interface Manifest {
  readonly files: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly bundleDependencies?: readonly string[];
}

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as Manifest;
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as Parameters<typeof lockedTree>[0];

const bounded = (command: string, args: readonly string[], cwd?: string): SpawnSyncReturns<string> => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT, ...(cwd ? { cwd } : {}) });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result;
};

/** The vitest ceiling for a test or hook making `spawns` bounded spawns. */
const ceiling = (spawns: number): number => spawns * SUBPROCESS_TIMEOUT;

const scratches: string[] = [];
const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-tree-"));
  scratches.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the manifest", () => {
  it("bundles every runtime dependency, and only those", () => {
    expect(Object.keys(manifest.dependencies)).not.toHaveLength(0);
    expect([...(manifest.bundleDependencies ?? [])].sort()).toEqual(Object.keys(manifest.dependencies).sort());
  });

  it("ships no shrinkwrap and generates none: GitHub Packages makes npm ignore it", () => {
    expect(manifest.files).toEqual(["dist"]);
    expect(manifest.scripts["prepack"]).toBe("npm run build");
    expect(manifest.scripts).not.toHaveProperty("postpack");
  });
});

/**
 * Bundling builds the tree once, on the publishing runner, and every platform
 * then runs what it built. A package with an install script or an `os`/`cpu`
 * field is one that tree may be wrong for, so adding one is a decision to make
 * on purpose: this names it.
 */
describe("the runtime tree", () => {
  it("has no package with an install script or an os or cpu restriction", () => {
    expect(platformBound(lock)).toEqual([]);
  });

  it("finds one that has", () => {
    const packages = {
      "": { version: "1.0.0", hasInstallScript: true },
      "node_modules/a": { version: "1.0.0" },
      "node_modules/b": { version: "1.0.0", hasInstallScript: true },
      "node_modules/c": { version: "1.0.0", os: ["linux"] },
      "node_modules/d": { version: "1.0.0", cpu: ["x64"] },
      "node_modules/e": { version: "1.0.0", dev: true, hasInstallScript: true },
    };

    expect(platformBound({ packages })).toEqual(["node_modules/b", "node_modules/c", "node_modules/d"]);
  });
});

describe("treeMismatches", () => {
  const packages = {
    "": { version: "1.0.0" },
    "node_modules/a": { version: "1.0.0" },
    "node_modules/@s/b": { version: "2.0.0" },
    "node_modules/a/node_modules/c": { version: "3.0.0", devOptional: true },
    "node_modules/d": { version: "4.0.0", dev: true },
  };
  const exact = new Map([
    ["node_modules/a", "1.0.0"],
    ["node_modules/@s/b", "2.0.0"],
    ["node_modules/a/node_modules/c", "3.0.0"],
  ]);

  it("passes the lockfile's runtime tree, nested and scoped entries included", () => {
    expect(treeMismatches({ packages }, exact)).toEqual([]);
  });

  it("names a different version, a missing package, an extra one and a dev one", () => {
    const bundled = new Map(exact);
    bundled.set("node_modules/a", "1.1.0");
    bundled.delete("node_modules/@s/b");
    bundled.set("node_modules/e", "5.0.0");
    bundled.set("node_modules/d", "4.0.0");

    expect(treeMismatches({ packages }, bundled)).toEqual([
      "node_modules/a is 1.1.0, and package-lock.json resolves 1.0.0.",
      "node_modules/@s/b 2.0.0 is in package-lock.json and missing.",
      "node_modules/e 5.0.0 is not in package-lock.json's runtime tree.",
      "node_modules/d 4.0.0 is a dev dependency, which must not ship.",
    ]);
  });
});

describe("bundledTree", () => {
  const put = (root: string, location: string, version: string): void => {
    fs.mkdirSync(path.join(root, location), { recursive: true });
    fs.writeFileSync(path.join(root, location, "package.json"), JSON.stringify({ version }));
  };

  it("reads every package at any depth, through scopes, and skips npm's dot entries", () => {
    const root = scratch();
    put(root, "node_modules/a", "1.0.0");
    put(root, "node_modules/@s/b", "2.0.0");
    put(root, "node_modules/@s/b/node_modules/c", "3.0.0");
    // A package's own nested manifest, as `yaml/browser/package.json` is, is not a package.
    put(root, "node_modules/a/browser", "9.9.9");
    fs.mkdirSync(path.join(root, "node_modules", ".bin"));
    fs.writeFileSync(path.join(root, "node_modules", ".package-lock.json"), "{}");

    expect(bundledTree(root)).toEqual(
      new Map([
        ["node_modules/@s/b", "2.0.0"],
        ["node_modules/@s/b/node_modules/c", "3.0.0"],
        ["node_modules/a", "1.0.0"],
      ]),
    );
  });

  it("reads a package with no node_modules as an empty tree", () => {
    expect(bundledTree(scratch())).toEqual(new Map());
  });
});

/**
 * The real artefact. `--ignore-scripts` skips `prepack`'s build, which changes
 * `dist/` and nothing that is bundled. `publish.yml` runs the same comparison
 * against the pack it is about to publish, and against the published release
 * installed through `npm exec`.
 */
describe("a pack of this package", () => {
  let tarball = "";
  let unpacked = "";

  beforeAll(() => {
    const out = scratch();
    const packed = bounded("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out]);
    const [entry] = JSON.parse(packed.stdout) as readonly { readonly filename: string }[];
    tarball = path.join(out, entry?.filename ?? "");
    bounded("tar", ["-xzf", tarball, "-C", out]);
    unpacked = path.join(out, "package");
  }, ceiling(2));

  it("carries exactly the lockfile's runtime tree", () => {
    expect(treeMismatches(lock, bundledTree(unpacked))).toEqual([]);
  });

  /**
   * The install a run makes, from the tarball rather than the registry, which
   * nothing can be published to before a release. `yaml` is the witness: the
   * lockfile resolves 2.8.1 where the registry has had 2.9.1 inside `^2.8.1`, and
   * an install that resolved the range would take the newer one.
   */
  it("installs its bundled versions, not whatever the ranges resolve to today", () => {
    const into = scratch();
    fs.writeFileSync(path.join(into, "package.json"), "{}");
    bounded("npm", ["install", "--no-audit", "--no-fund", tarball], into);
    const installed = path.join(into, "node_modules", "@jeffwlawson", "agent-workflows");
    const yaml = JSON.parse(fs.readFileSync(path.join(installed, "node_modules", "yaml", "package.json"), "utf8")) as {
      readonly version: string;
    };

    expect(yaml.version).toBe(lockedTree(lock).get("node_modules/yaml"));
    expect(treeMismatches(lock, bundledTree(installed))).toEqual([]);
  });
});
