import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeShrinkwrap, SHRINKWRAP, shrinkwrapOf, writeShrinkwrap } from "../scripts/shrinkwrap.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The release ships the dependency tree it was tested with (#414).
 *
 * What can go wrong is a shrinkwrap that disagrees with the lockfile the suite
 * and CI installed from: a dependency bumped in one and not the other ships an
 * untested tree under a file that claims to pin it. The design answer is that
 * there is no second copy to disagree. The pack derives it from the lockfile
 * every time, and nothing commits it. These hold both halves of that.
 */

interface Manifest {
  readonly files: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as Manifest;
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as {
  readonly packages: Readonly<Record<string, { readonly dev?: boolean }>>;
};

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const scratchWith = (lockfile: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shrinkwrap-"));
  scratches.push(dir);
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lockfile));
  return dir;
};

describe("the shrinkwrap of this package's lockfile", () => {
  const shrinkwrap = shrinkwrapOf(lock);

  it("pins every runtime dependency at the lockfile's exact entry", () => {
    expect(Object.keys(manifest.dependencies)).not.toHaveLength(0);
    for (const name of Object.keys(manifest.dependencies)) {
      const location = `node_modules/${name}`;
      expect(shrinkwrap.packages[location], location).toBeDefined();
      expect(shrinkwrap.packages[location]).toEqual(lock.packages[location]);
    }
  });

  it("keeps every entry the runtime tree has, unchanged, and no development entry", () => {
    const runtime = Object.entries(lock.packages).filter(([location, entry]) => location !== "" && entry.dev !== true);

    expect(Object.entries(shrinkwrap.packages).filter(([location]) => location !== "")).toEqual(runtime);
    expect(shrinkwrap.packages[""]).not.toHaveProperty("devDependencies");
  });
});

describe("shrinkwrapOf", () => {
  it("drops a development entry and keeps one marked devOptional", () => {
    const shrinkwrap = shrinkwrapOf({
      lockfileVersion: 3,
      packages: {
        "": { name: "pkg", dependencies: { a: "^1" }, devDependencies: { b: "^1" } },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/b": { version: "1.0.0", dev: true },
        "node_modules/c": { version: "1.0.0", devOptional: true },
      },
    });

    expect(shrinkwrap).toEqual({
      lockfileVersion: 3,
      packages: {
        "": { name: "pkg", dependencies: { a: "^1" } },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/c": { version: "1.0.0", devOptional: true },
      },
    });
  });
});

describe("writing and removing it", () => {
  const read = (dir: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, SHRINKWRAP), "utf8"));

  it("writes from the lockfile as it stands, so a changed lockfile is never shipped stale", () => {
    const before = { lockfileVersion: 3, packages: { "": { name: "pkg" }, "node_modules/a": { version: "1.0.0" } } };
    const after = { lockfileVersion: 3, packages: { "": { name: "pkg" }, "node_modules/a": { version: "1.1.0" } } };
    const dir = scratchWith(before);

    writeShrinkwrap(dir);
    expect(read(dir)).toEqual(before);

    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(after));
    writeShrinkwrap(dir);
    expect(read(dir)).toEqual(after);
  });

  it("removes it, and removing an absent one is not an error", () => {
    const dir = scratchWith({ lockfileVersion: 3, packages: { "": { name: "pkg" } } });

    writeShrinkwrap(dir);
    removeShrinkwrap(dir);
    expect(fs.existsSync(path.join(dir, SHRINKWRAP))).toBe(false);
    expect(() => removeShrinkwrap(dir)).not.toThrow();
  });
});

/**
 * The wiring that makes "derived at every pack" true of the real release. Each
 * line is one way the shipped file could be absent or stale: not listed in
 * `files` (npm then leaves it out of the tarball without a word, as it does for
 * any root file `files` does not name), written before the build that could
 * fail, left behind for the checkout's next `npm install` to prefer over the
 * lockfile, or committed as a copy that a later dependency bump does not touch.
 */
describe("the pack", () => {
  it("ships the file it writes", () => {
    expect(manifest.files).toContain(SHRINKWRAP);
  });

  it("writes it after the build, from the compiled script, and removes it after", () => {
    expect(manifest.scripts["prepack"]).toBe("npm run build && node dist/scripts/shrinkwrap.js");
    expect(manifest.scripts["postpack"]).toBe("node dist/scripts/shrinkwrap.js --remove");
  });

  it("is the only writer: the file is ignored, so no committed copy can go stale", () => {
    const result = spawnSync("git", ["check-ignore", "--quiet", SHRINKWRAP], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
