import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncVersion } from "../scripts/sync-version.js";

/**
 * `npm version` bumps two files — the manifest and the lockfile — and there are
 * seventeen. The other fifteen are the version pins: one `--package=…@<version>`
 * per reusable workflow, and one `…yml@v<version>` in each of the two caller
 * sets. Both `v0.1.4` and `v0.1.5` were cut by editing them by hand and folding
 * the result into the version commit.
 *
 * This is tedium rather than hazard, and the distinction shapes what is tested
 * here. `tests/workflows.test.ts` already derives `PIN` from `package.json` and
 * holds both caller sets to it, another describe there holds the `npm exec` line
 * equal to the manifest, and `publish.yml` refuses a tag whose version disagrees
 * — a missed pin is a red build, never a bad release. So the property worth
 * asserting is not "the pins are right" (that is covered, three times over) but
 * **"the propagation reached every site, and said so when it could not"**.
 *
 * Which is why the loud-failure checks below outnumber the rewrite checks. A
 * propagator that silently rewrites fourteen of fifteen sites is strictly worse
 * than the hand edit it replaces: the hand edit is visible work that someone
 * knows to check, and a quiet partial success is fifteen files that were
 * *believed* to be done.
 */

/**
 * A throwaway copy of the real tree — the real workflow files, the real
 * manifest, the real lockfile.
 *
 * Copied rather than synthesised, because the shapes being rewritten are the
 * thing under test: a hand-written fixture of what a caller *looks like* would
 * keep passing after the real callers changed shape, which is the coverage
 * failure `tests/workflows.test.ts` exists to avoid one layer up. And a
 * temporary directory rather than the checkout, because this test writes.
 */
const scratches: string[] = [];

const fixture = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-version-"));
  scratches.push(root);
  fs.cpSync(".github/workflows", path.join(root, ".github", "workflows"), { recursive: true });
  fs.cpSync("examples/callers", path.join(root, "examples", "callers"), { recursive: true });
  fs.copyFileSync("package.json", path.join(root, "package.json"));
  fs.copyFileSync("package-lock.json", path.join(root, "package-lock.json"));
  return root;
};

afterEach(() => {
  for (const root of scratches.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const read = (root: string, rel: string): string =>
  fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

const write = (root: string, rel: string, text: string): void =>
  fs.writeFileSync(path.join(root, ...rel.split("/")), text);

/** `git` in a scratch tree, loud on failure: a silent one would read as a pass. */
const git = (root: string, args: readonly string[]): string => {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${root}: ${result.stderr}`);
  return result.stdout;
};

/** The version written by every rewrite test: recognisable, and no repo's own. */
const TARGET = "9.9.9";

/**
 * Fifteen sites, named. The count is the acceptance criterion's own number and
 * the list is what the release used to be: five reusables, five local callers,
 * five reference callers.
 *
 * Written out rather than derived, so that it is also the answer to "what
 * belongs in the release commit" — which is what the staging check below reads
 * it as. That the propagator's own set is *not* a written-out fifteen is a
 * separate property, and has its own test: the complete sixth trio below.
 */
const EVERY_SITE = [
  ".github/workflows/agent-fix.yml",
  ".github/workflows/agent-implement-prd.yml",
  ".github/workflows/agent-implement.yml",
  ".github/workflows/agent-review.yml",
  ".github/workflows/agent-update-branch.yml",
  ".github/workflows/fix.yml",
  ".github/workflows/implement-prd.yml",
  ".github/workflows/implement.yml",
  ".github/workflows/review.yml",
  ".github/workflows/update-branch.yml",
  "examples/callers/fix.yml",
  "examples/callers/implement-prd.yml",
  "examples/callers/implement.yml",
  "examples/callers/review.yml",
  "examples/callers/update-branch.yml",
] as const;

describe("the version propagator rewrites every pin", () => {
  it("reports every site it rewrote", () => {
    const root = fixture();

    const files = syncVersion(TARGET, root).map((site) => site.file).sort();

    expect(files).toEqual([...EVERY_SITE]);
  });

  it("leaves no site still naming the version it replaced", () => {
    const root = fixture();
    const { version } = JSON.parse(read(root, "package.json")) as { version: string };

    const stale = syncVersion(TARGET, root)
      .map((site) => site.file)
      .filter((file) => read(root, file).includes(`agent-workflows@v${version}`) ||
        read(root, file).includes(`agent-workflows@${version}`));

    expect(stale).toEqual([]);
  });

  /**
   * The two forms are not interchangeable and neither is a superset of the
   * other: `--package=` takes an npm spec, which has no `v`, and `uses:` takes a
   * git ref, which is the tag — and the tags here are `v`-prefixed because
   * `publish.yml` triggers on `v*`. Writing either form into the other's slot
   * produces a file that looks updated and resolves to nothing.
   */
  it("writes the npm spec without a `v` and the git ref with one", () => {
    const root = fixture();

    syncVersion(TARGET, root);

    expect(read(root, ".github/workflows/review.yml")).toContain(
      `--package=@jeffwlawson/agent-workflows@${TARGET} --`,
    );
    expect(read(root, ".github/workflows/agent-review.yml")).toContain(
      `jeffwlawson/agent-workflows/.github/workflows/review.yml@v${TARGET}`,
    );
    expect(read(root, "examples/callers/review.yml")).toContain(
      `jeffwlawson/agent-workflows/.github/workflows/review.yml@v${TARGET}`,
    );
  });

  it("tells the two forms apart in what it reports", () => {
    const root = fixture();

    const sites = syncVersion(TARGET, root);

    expect(sites.filter((s) => s.form === "package").map((s) => s.file).sort()).toEqual([
      ".github/workflows/fix.yml",
      ".github/workflows/implement-prd.yml",
      ".github/workflows/implement.yml",
      ".github/workflows/review.yml",
      ".github/workflows/update-branch.yml",
    ]);
    expect(sites.filter((s) => s.form === "ref")).toHaveLength(10);
  });

  /**
   * `npm version` writes both of those itself, in its own formatting, *before*
   * the `version` hook runs. A propagator that reformats the lockfile on the way
   * past turns a two-line diff into a 57 kB one in the release commit.
   */
  it("touches neither the manifest nor the lockfile", () => {
    const root = fixture();
    const manifest = read(root, "package.json");
    const lock = read(root, "package-lock.json");

    syncVersion(TARGET, root);

    expect(read(root, "package.json")).toBe(manifest);
    expect(read(root, "package-lock.json")).toBe(lock);
  });

  /**
   * Fifteen is today's count, not the rule. `EVERY_SITE` above is a written-out
   * list, and so is every refusal below a *half*-landed sixth workflow — between
   * them they would all still pass against an implementation holding fifteen
   * hardcoded paths, which on the day a sixth workflow actually lands rewrites
   * fifteen of eighteen and reports success.
   *
   * So this is the one that lands the whole trio: the reusable, the local caller
   * and the reference caller. The site set is derived from what is on disk, and
   * the number that proves it is eighteen.
   */
  it("derives the site set: a complete sixth workflow is eighteen sites, not fifteen", () => {
    const root = fixture();
    for (const [from, to] of [
      [".github/workflows/review.yml", ".github/workflows/plan.yml"],
      [".github/workflows/agent-review.yml", ".github/workflows/agent-plan.yml"],
      ["examples/callers/review.yml", "examples/callers/plan.yml"],
    ] as const) {
      fs.copyFileSync(path.join(root, ...from.split("/")), path.join(root, ...to.split("/")));
    }

    const sites = syncVersion(TARGET, root);

    expect(sites).toHaveLength(EVERY_SITE.length + 3);
    expect(sites.filter((s) => s.form === "package")).toHaveLength(6);
    expect(sites.filter((s) => s.form === "ref")).toHaveLength(12);
    expect(sites.filter((s) => s.file.includes("plan")).map((s) => `${s.file} ${s.form}`).sort()).toEqual([
      ".github/workflows/agent-plan.yml ref",
      ".github/workflows/plan.yml package",
      "examples/callers/plan.yml ref",
    ]);
    expect(read(root, ".github/workflows/plan.yml")).toContain(
      `--package=@jeffwlawson/agent-workflows@${TARGET} --`,
    );
    for (const caller of [".github/workflows/agent-plan.yml", "examples/callers/plan.yml"]) {
      expect(read(root, caller)).toContain(`.yml@v${TARGET}`);
    }
  });

  /**
   * Run twice, the second run writes nothing. The hook is one command in a
   * release, but `init` (#6) is the other caller of the core this shares
   * (`tests/pins.test.ts`), and a rewrite that is not a fixed point is one that
   * cannot be re-run to check itself.
   */
  it("is a fixed point: a second run over its own output changes nothing", () => {
    const root = fixture();

    const after = syncVersion(TARGET, root).map((site) => ({
      file: site.file,
      text: read(root, site.file),
    }));

    syncVersion(TARGET, root);

    for (const { file, text } of after) expect(read(root, file)).toBe(text);
  });
});

/**
 * Every check here is the same acceptance criterion: an unexpected count fails
 * loudly rather than rewriting nothing and returning success.
 *
 * The failure mode it guards is specific and has happened to the adjacent
 * machinery twice — a set defined by walking grows when the repo does, and a set
 * defined by a list does not. `copy-assets.ts` walks for that reason; so does
 * `tests/workflows.test.ts`. Here the walk alone is not enough, because the
 * three sites of a sixth workflow live in three directories and a walk of any
 * one of them is a walk that finds five when the truth is six.
 */
describe("the version propagator refuses an unexpected set of pins", () => {
  it("refuses a reusable workflow whose pin it cannot find", () => {
    const root = fixture();
    write(
      root,
      ".github/workflows/review.yml",
      read(root, ".github/workflows/review.yml").replace(/--package=(\S+)@\d+\.\d+\.\d+/, "--package=$1@latest"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(/review\.yml/);
  });

  it("refuses a caller whose pin it cannot find", () => {
    const root = fixture();
    write(
      root,
      "examples/callers/fix.yml",
      read(root, "examples/callers/fix.yml").replace(/\.yml@v\d+\.\d+\.\d+/, ".yml@main"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(/examples\/callers\/fix\.yml/);
  });

  /**
   * A site carrying a *second* recognised pin, which the count check refuses
   * along with the rest. The message is asserted rather than just the filename,
   * because this is the one refusal whose cause the count alone misdescribes:
   * both pins here are recognised, so "a pin this does not recognise" would send
   * the reader hunting for one that does not exist.
   */
  it("refuses a site carrying a second pin, and says which forms it found", () => {
    const root = fixture();
    write(
      root,
      ".github/workflows/review.yml",
      `${read(root, ".github/workflows/review.yml")}\n# jeffwlawson/agent-workflows/.github/workflows/review.yml@v0.1.7\n`,
    );

    expect(() => syncVersion(TARGET, root)).toThrow(/found 2 \[package, ref\]/);
  });

  /**
   * The sixth workflow, arriving one file at a time. Each of the three
   * directories can be the one that is ahead, and in each case the honest answer
   * is "this release would rewrite fifteen sites and there are eighteen", not a
   * count of what happened to be found.
   */
  it("refuses a sixth caller with no reusable workflow behind it", () => {
    const root = fixture();
    fs.copyFileSync(
      path.join(root, ".github", "workflows", "agent-review.yml"),
      path.join(root, ".github", "workflows", "agent-plan.yml"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(/plan/);
  });

  it("refuses a sixth reusable workflow with no callers in front of it", () => {
    const root = fixture();
    fs.copyFileSync(
      path.join(root, ".github", "workflows", "review.yml"),
      path.join(root, ".github", "workflows", "plan.yml"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(/plan/);
  });

  it("refuses a reference caller the local callers do not have", () => {
    const root = fixture();
    fs.copyFileSync(
      path.join(root, "examples", "callers", "review.yml"),
      path.join(root, "examples", "callers", "plan.yml"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(/plan/);
  });

  it("refuses a reference caller that is missing", () => {
    const root = fixture();
    fs.rmSync(path.join(root, "examples", "callers", "fix.yml"));

    expect(() => syncVersion(TARGET, root)).toThrow(/fix/);
  });

  /**
   * And it writes nothing at all when it refuses. A propagator that rewrites the
   * files it recognised and then throws leaves the release commit half-done,
   * which is the state it exists to make impossible.
   */
  it("writes nothing when it refuses", () => {
    const root = fixture();
    fs.copyFileSync(
      path.join(root, ".github", "workflows", "agent-review.yml"),
      path.join(root, ".github", "workflows", "agent-plan.yml"),
    );
    const before = read(root, ".github/workflows/review.yml");

    expect(() => syncVersion(TARGET, root)).toThrow();

    expect(read(root, ".github/workflows/review.yml")).toBe(before);
  });

  /**
   * A pin is an exact `major.minor.patch` version everywhere it appears — the
   * `npm exec` check in `tests/workflows.test.ts` matches no `^`, no `~` and no
   * dist-tag, and the `uses:` ref must be a tag `publish.yml` would accept. So a
   * version this script cannot write as a valid pin is refused before it writes
   * any of them, rather than distributed to fifteen files for the suite to
   * reject one at a time.
   */
  it.each(["0.2", "v0.2.0", "0.2.0-rc.1", "", "latest"])(
    "refuses to propagate %o, which is not a pin",
    (version) => {
      const root = fixture();

      expect(() => syncVersion(version, root)).toThrow(/version/i);
    },
  );
});

/**
 * The exclusion that keeps this file out of the tarball, and the one condition
 * under which it works.
 *
 * `tsconfig.build.json` names `scripts/sync-version.ts` in `exclude`, because
 * compiled it is a file with no runtime role and one that would be *wrong* if
 * anyone ran it — its package root is `import.meta.dirname/..`, which from
 * `dist/scripts/` is `dist/`. But `exclude` only trims the entry set: a file
 * something in the build **imports** is pulled back in and emitted anyway, side
 * effects and all, and this one's side effect is a CLI that stages and rewrites.
 *
 * Nothing downstream would report it. `ci.yml`'s tarball guard filters `tests/`,
 * `.test.` and `vitest` — a `dist/scripts/sync-version.js` matches none of
 * those, and the release hook would simply ship. Hence the rule this asserts:
 * the shared core lives in `shared/pins.ts`, which ships on purpose, and the
 * release half is imported by tests only.
 *
 * Put to `tsc` rather than reconstructed from the config, because the two ways
 * this breaks have one symptom and the compiler is what decides it: drop the
 * `exclude` entry and the hook is an entry file again; import it from anything
 * built and it comes back regardless. Both were run against this repo's own
 * `tsc`, in both directions. Restating the source directories here instead
 * would be a second copy of the build's entry set, and a sixth runner directory
 * — a routine change, per `CLAUDE.md` — would be compiled and unread.
 */
describe("the release hook stays out of what ships", () => {
  /**
   * The program `tsconfig.build.json` defines: its entry files and everything
   * they import, which is exactly the set `tsc` would emit. `--listFilesOnly`
   * prints that set and stops, so it neither typechecks nor writes `dist/`.
   */
  const compiled = (): readonly string[] => {
    const tsc = path.join("node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--listFilesOnly"], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((file) => path.relative(".", file))
      // The lib and `@types` files every program carries, and anything outside
      // this checkout: neither is what ships, and neither can be this hook.
      .filter((file) => !file.startsWith("..") && !file.startsWith(`node_modules${path.sep}`));
  };

  it("is in no build of this package: not as an entry file, and not through an import", () => {
    const program = compiled();

    // The other half of the same question, and the reason the first assertion
    // is not vacuous: the build this is being asked about is the real one, and
    // it carries both the CLI and the core the hook shares with `init`.
    expect(program).toContain("cli.ts");
    expect(program).toContain(path.join("shared", "pins.ts"));

    expect(program).not.toContain(path.join("scripts", "sync-version.ts"));
  });
});

/**
 * The hook, which is the whole point: `npm version patch` has to produce the
 * seventeen-file commit on its own.
 *
 * npm runs `version` after the manifest is bumped and before the commit is
 * created, and stages only the manifest and the lockfile itself — so the hook
 * both propagates and stages, and npm commits and tags. It must not do either of
 * those last two: `npm version` already does both, and `publish.yml` fires on
 * the tag push. A second tagging path is a second way to publish a release.
 */
describe("the release is one command", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const hook = manifest.scripts?.["version"] ?? "";

  it("runs the propagator from the `version` lifecycle script", () => {
    expect(hook).toContain("scripts/sync-version.ts");
  });

  /**
   * npm makes the commit, and by default names it `<version>` — every release
   * commit in this history is `v<version>`, matching the tag `publish.yml`
   * triggers on. `.npmrc` is the only place `npm version` reads that from, and
   * the only reason this repository has one: the registry and the auth token
   * live in the `.npmrc` `actions/setup-node` writes under `RUNNER_TEMP`, and a
   * second copy of the scope here would be a second place for it to be wrong.
   */
  it("names the release commit after the tag", () => {
    const npmrc = fs
      .readFileSync(".npmrc", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(npmrc).toEqual(["message=v%s"]);
  });

  /**
   * The version is read from the manifest npm has already bumped, never passed
   * in — same reason the runners take no arguments. An argument is a second
   * source of truth for the one value `publish.yml` cross-checks against the
   * tag.
   */
  it("passes no version to the propagator", () => {
    expect(hook.trim()).toBe("node scripts/sync-version.ts");
  });

  /**
   * And the entry point refuses one rather than ignoring it, for the reason the
   * runners do: a silently-dropped argument runs the real thing while its author
   * believes it took effect — here, propagating the manifest's version to fifteen
   * files while the person who typed a different one watches it report success.
   *
   * Run for real, which also covers the one thing no unit test reaches: `npm
   * version` executes the TypeScript source directly, through Node's type
   * stripping. A syntax this repo compiles but Node cannot strip would fail
   * nowhere else until a release.
   */
  it("refuses an argument rather than taking a version from one", () => {
    const result = spawnSync(process.execPath, ["scripts/sync-version.ts", "9.9.9"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("9.9.9");
  });

  /**
   * And the rest of the hook, run the way `npm version` runs it: over a scratch
   * repository already committed at its current version, with the manifest
   * bumped in the working tree and a stray untracked file lying beside it.
   *
   * The stray is the point. `npm version` refuses a tree with *tracked*
   * modifications and lets untracked files straight through, so a `git add -A`
   * in this hook carries whatever happens to be there into the release commit
   * and the tag `publish.yml` fires on — an eighteenth file inside a release,
   * which `PIN` cannot see and no check downstream reads.
   */
  const released = (): string => {
    const root = fixture();
    // Both files: the hook imports the shared core from `shared/`, and a scratch
    // copy missing it fails at module resolution — which is the one failure
    // `CLAUDE.md` calls indistinguishable from a bare `exit 1`.
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "shared"), { recursive: true });
    fs.copyFileSync("scripts/sync-version.ts", path.join(root, "scripts", "sync-version.ts"));
    fs.copyFileSync("shared/pins.ts", path.join(root, "shared", "pins.ts"));

    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "scratch@example.invalid"]);
    git(root, ["config", "user.name", "scratch"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "the tree at its current version"]);

    // What npm has already done by the time the hook runs: the manifest bumped,
    // unstaged. npm stages that one and the lockfile itself, afterwards.
    write(root, "package.json", read(root, "package.json").replace(/"version": "[^"]+"/, `"version": "${TARGET}"`));
    write(root, "STRAY-NOTES.md", "left lying around\n");

    const result = spawnSync(process.execPath, [path.join(root, "scripts", "sync-version.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Synced ${EVERY_SITE.length} version pin(s) to ${TARGET}.`);

    return root;
  };

  /**
   * Staged inside the hook, or npm commits the bump alone and the fifteen
   * rewritten files are left in the working tree — the exact state the hand edit
   * produced, minus the knowledge that they are there. By path, and only the
   * paths it wrote.
   */
  it("stages the fifteen files it rewrote, and nothing else in the tree", () => {
    const root = released();

    const staged = git(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).sort();

    expect(staged).toEqual([...EVERY_SITE]);
  });

  /**
   * `npm version` makes the commit and the tag, and `publish.yml` fires on the
   * tag push. A second one here would be a second way to publish a release.
   */
  it("makes no commit and no tag of its own", () => {
    const root = released();

    expect(git(root, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    expect(git(root, ["tag", "--list"]).trim()).toBe("");
  });
});
