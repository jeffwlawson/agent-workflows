import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncVersion } from "../scripts/sync-version.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * `npm version` bumps two files — the manifest and the lockfile — and there are
 * twelve. The other ten hold the version pins: one `--package=…@<version>` per
 * step that runs the package, and one `…yml@v<version>` per caller in each of the two
 * caller sets, two caller files to a set (#225). Both `v0.1.4` and `v0.1.5` were cut by editing them by hand and folding
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
 * propagator that silently rewrites all but one of the sites is strictly worse
 * than the hand edit it replaces: the hand edit is visible work that someone
 * knows to check, and a quiet partial success is a set of files that were
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

/**
 * The vitest ceiling for a test that spawns `spawns` bounded children, in units
 * of the bound each one carries.
 *
 * Four things here run a real program: the compiler against
 * `tsconfig.build.json`, `git` in a scratch tree, and the release hook itself,
 * twice. vitest cannot interrupt a synchronous spawn, so an unbounded one is a
 * run that never ends rather than one that fails late (#145) — and the two
 * `tsc` spawns are the tightest case in the suite against vitest's 5-second
 * default, while guarding the `.js`-specifier convention `CLAUDE.md` states.
 *
 * The bound itself is `vitest.config.ts`'s, imported rather than written here:
 * this file wrote its own copy of the same figure until #144, which was equal by
 * coincidence — #144 and #145 were in flight at the same time and neither branch
 * could see the other's literal. `tests/vitest-config.test.ts` now checks that
 * no test file writes it, so the coincidence cannot recur.
 *
 * Sized against a *hang*, not against slowness: the compiler is the dearest of
 * the four at about a second, so the bound is a wide multiple of the real cost.
 *
 * A ceiling is still given per test, because the two bound different failures —
 * the spawn bound is the only thing that can stop a hang, and the test bound is
 * what keeps a run that is merely slow under a parallel `verify` from failing at
 * five seconds. The suite-wide setting is one spawn's worth, so a test making
 * one needs no ceiling of its own; a test making several has to clear the *sum*
 * of their bounds or it fails while every child is still inside its own, and
 * says so as a multiple of the same figure rather than a number of its own.
 */
const ceiling = (spawns: number): number => spawns * SUBPROCESS_TIMEOUT;

/**
 * Every child this file spawns, bounded and loud about the bound.
 *
 * `spawnSync` reports a timeout as `status: null`, with `ETIMEDOUT` in
 * `result.error` and the signal it was killed with in `result.signal` — so a
 * caller that reads `status` alone turns a hang into `expected null to be 0`
 * or into an empty stderr, which names neither the command nor the cause and
 * is indistinguishable from a command that is not installed. Both are checked:
 * nothing here is killed by a signal for any other reason, and a run that was
 * cut short is the bound firing whichever of the two says so.
 *
 * `timeout` is an override for one caller only — the test that forces the
 * bound to fire. Every real spawn takes `SUBPROCESS_TIMEOUT`, so the bound stays
 * one constant rather than a number per site.
 */
const bounded = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeout?: number } = {},
): SpawnSyncReturns<string> => {
  const timeout = options.timeout ?? SUBPROCESS_TIMEOUT;
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    timeout,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  const label = `${command} ${args.join(" ")}`;
  if (result.error !== undefined || result.signal !== null) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      code === "ETIMEDOUT" || result.signal !== null
        ? `${label} timed out after ${timeout}ms`
        : `${label} could not be run: ${result.error?.message ?? ""}`,
    );
  }

  return result;
};

/** `git` in a scratch tree, loud on failure: a silent one would read as a pass. */
const git = (root: string, args: readonly string[]): string => {
  const result = bounded("git", args, { cwd: root });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${root}: ${result.stderr}`);
  return result.stdout;
};

/** The version written by every rewrite test: recognisable, and no repo's own. */
const TARGET = "9.9.9";

/**
 * A caller of a `plan` workflow, as a job to append to a caller file, pinned
 * where the fixture's own callers are.
 */
const planJob = (root: string): string => {
  const { version } = JSON.parse(read(root, "package.json")) as { version: string };
  return `\n  plan:\n    uses: jeffwlawson/agent-workflows/.github/workflows/plan.yml@v${version}\n`;
};

/**
 * Every file holding a site, named: one per reusable workflow, and the two
 * caller files (#225) in each caller set.
 *
 * Written out rather than derived, so that it is also the answer to "what
 * belongs in the release commit" — which is what the staging check below reads
 * it as. That the propagator's own set is *not* a written-out list is a separate
 * property, and has its own test: the complete extra workflow below.
 *
 * It shrank by eight when the six caller files became two (#225), which is the
 * point of writing it out: a change to the set of files is a change here, in
 * the same commit, or the release propagates to a set nobody checked.
 */
const EVERY_SITE = [
  ".github/workflows/agent-issue.yml",
  ".github/workflows/agent-pr.yml",
  ".github/workflows/fix.yml",
  ".github/workflows/follow-ups.yml",
  ".github/workflows/implement-prd.yml",
  ".github/workflows/implement.yml",
  ".github/workflows/review.yml",
  ".github/workflows/update-branch.yml",
  "examples/callers/issue.yml",
  "examples/callers/pr.yml",
] as const;

/**
 * The callers each caller file holds, and so the `ref` pins it carries: the
 * four that run on a pull request, and the two that run on an issue.
 */
const CALLERS_PER_FILE: Readonly<Record<string, number>> = { pr: 4, issue: 2 };
const REF_COUNT = 2 * Object.values(CALLERS_PER_FILE).reduce((sum, n) => sum + n, 0);

/**
 * The pins that are not one a file (#257): a reusable workflow's step naming
 * one of this repository's composite actions, `…/.github/actions/<name>@v<version>`.
 * GitHub fetches the action from the tag, so it moves with the release like
 * the workflow that names it.
 *
 * Each file's, by action, one entry per step naming it: review's `advance`
 * job names `advance-prd`, and each job that resolves the loop's token names
 * `loop-token` (#319, #320): implement's publish job, implement-prd's catch-up
 * and publish jobs, fix's and update-branch's publish jobs, and review's
 * `time-limit`, `post-review` and `advance` jobs. Nine, beside the nine `npm
 * exec` pins and the twelve callers, so the release rewrites thirty pins in
 * ten files.
 */
const ACTION_SITES: Readonly<Record<string, readonly string[]>> = {
  ".github/workflows/fix.yml": ["loop-token"],
  ".github/workflows/implement-prd.yml": ["loop-token", "loop-token"],
  ".github/workflows/implement.yml": ["loop-token"],
  ".github/workflows/review.yml": ["loop-token", "loop-token", "loop-token", "advance-prd"],
  ".github/workflows/update-branch.yml": ["loop-token"],
};
const ACTION_COUNT = Object.values(ACTION_SITES).reduce((sum, actions) => sum + actions.length, 0);

/**
 * The steps that run the package, `npm exec … --package=…@<version>`, by
 * file: one per reusable workflow, the runner's or the filing command's,
 * and in `review.yml` `review:gate` (#420), `review:publish` (#417) and
 * `review:conclude` (#419) beside the runner.
 */
const PACKAGE_SITES: Readonly<Record<string, number>> = {
  ".github/workflows/fix.yml": 1,
  ".github/workflows/follow-ups.yml": 1,
  ".github/workflows/implement-prd.yml": 1,
  ".github/workflows/implement.yml": 1,
  ".github/workflows/review.yml": 4,
  ".github/workflows/update-branch.yml": 1,
};
const PACKAGE_COUNT = Object.values(PACKAGE_SITES).reduce((sum, n) => sum + n, 0);
const PIN_COUNT = PACKAGE_COUNT + REF_COUNT + ACTION_COUNT;

describe("the version propagator rewrites every pin", () => {
  it("reports every site it rewrote", () => {
    const root = fixture();

    const sites = syncVersion(TARGET, root);

    expect([...new Set(sites.map((site) => site.file))].sort()).toEqual([...EVERY_SITE]);
    expect(sites).toHaveLength(PIN_COUNT);
    expect(sites.filter((s) => s.form === "action").map((s) => s.file).sort()).toEqual(
      Object.entries(ACTION_SITES).flatMap(([file, actions]) => actions.map(() => file)).sort(),
    );
    for (const [name, count] of Object.entries(CALLERS_PER_FILE)) {
      for (const file of [`.github/workflows/agent-${name}.yml`, `examples/callers/${name}.yml`]) {
        expect(sites.filter((s) => s.file === file && s.form === "ref"), file).toHaveLength(count);
      }
    }
  });

  /**
   * The composite action's pin is the `v`-prefixed ref, as a caller's is: it is
   * the tag GitHub fetches the action from (#257).
   */
  it("writes the composite action's ref with a `v`", () => {
    const root = fixture();

    syncVersion(TARGET, root);

    for (const [file, actions] of Object.entries(ACTION_SITES)) {
      for (const action of new Set(actions)) {
        const ref = `jeffwlawson/agent-workflows/.github/actions/${action}@v${TARGET}`;
        expect(read(root, file).split(ref).length - 1, `${file} ${action}`).toBe(actions.filter((a) => a === action).length);
      }
    }
  });

  /**
   * And a step naming one of those actions under anything but a pin is a site
   * the release would leave behind, so it refuses rather than skipping it.
   */
  it("refuses a composite action named under a ref that is not a pin", () => {
    const root = fixture();
    write(
      root,
      ".github/workflows/review.yml",
      read(root, ".github/workflows/review.yml").replace(/\/advance-prd@v\d+\.\d+\.\d+/, "/advance-prd@main"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(
      /review\.yml: expected 8 version pins \[package, package, package, package, action, action, action, action\], found 7 \[package, package, package, package, action, action, action\]/,
    );
  });

  /** The same for the token resolver, in each job of a workflow naming it (#319). */
  it("refuses the token resolver named under a ref that is not a pin", () => {
    const root = fixture();
    write(
      root,
      ".github/workflows/implement-prd.yml",
      read(root, ".github/workflows/implement-prd.yml").replace(/\/loop-token@v\d+\.\d+\.\d+/, "/loop-token@main"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(
      /implement-prd\.yml: expected 3 version pins \[package, action, action\], found 2 \[package, action\]/,
    );
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
    expect(read(root, ".github/workflows/agent-pr.yml")).toContain(
      `jeffwlawson/agent-workflows/.github/workflows/review.yml@v${TARGET}`,
    );
    expect(read(root, "examples/callers/pr.yml")).toContain(
      `jeffwlawson/agent-workflows/.github/workflows/review.yml@v${TARGET}`,
    );
  });

  it("tells the two forms apart in what it reports", () => {
    const root = fixture();

    const sites = syncVersion(TARGET, root);

    expect(sites.filter((s) => s.form === "package").map((s) => s.file).sort()).toEqual(
      Object.entries(PACKAGE_SITES).flatMap(([file, n]) => Array.from({ length: n }, () => file)).sort(),
    );
    expect(sites.filter((s) => s.form === "ref")).toHaveLength(REF_COUNT);
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
   * Thirty is today's count, not the rule. `EVERY_SITE` above is a written-out
   * list, and so is every refusal below a *half*-landed extra workflow — between
   * them they would all still pass against an implementation holding today's
   * pins hardcoded, which on the day a seventh workflow lands rewrites all but
   * its pins and reports success.
   *
   * So this is the one that lands a whole workflow: the reusable, and a caller
   * of it in the PR-side caller file of each set. The site set is derived from
   * what is on disk, and the number that proves it is more than there were.
   */
  it("derives the site set: a complete extra workflow is more sites, not the same", () => {
    const root = fixture();
    fs.copyFileSync(
      path.join(root, ".github", "workflows", "review.yml"),
      path.join(root, ".github", "workflows", "plan.yml"),
    );
    for (const caller of [".github/workflows/agent-pr.yml", "examples/callers/pr.yml"]) {
      write(root, caller, `${read(root, caller)}${planJob(root)}`);
    }

    const sites = syncVersion(TARGET, root);

    // Ten pins, one file more: the copy of `review.yml` runs the package
    // four times and names the advance action and the token resolver's three
    // times too, and the two callers of it join the files already there.
    expect(sites).toHaveLength(PIN_COUNT + 10);
    expect(sites.filter((s) => s.form === "package")).toHaveLength(PACKAGE_COUNT + 4);
    expect(sites.filter((s) => s.form === "ref")).toHaveLength(REF_COUNT + 2);
    expect([...new Set(sites.map((s) => s.file))].sort()).toEqual(
      [...EVERY_SITE, ".github/workflows/plan.yml"].sort(),
    );
    expect(read(root, ".github/workflows/plan.yml")).toContain(
      `--package=@jeffwlawson/agent-workflows@${TARGET} --`,
    );
    for (const caller of [".github/workflows/agent-pr.yml", "examples/callers/pr.yml"]) {
      expect(read(root, caller)).toContain(`/plan.yml@v${TARGET}`);
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
 * three sites of a new workflow live in three directories and a walk of any one
 * of them is a walk that finds the old count when the truth is one more.
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
      "examples/callers/pr.yml",
      read(root, "examples/callers/pr.yml").replace(/\/fix\.yml@v\d+\.\d+\.\d+/, "/fix.yml@main"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(
      /examples\/callers\/pr\.yml: expected 4 version pins \[ref, ref, ref, ref\], found 3/,
    );
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

    expect(() => syncVersion(TARGET, root)).toThrow(/found 9 \[package, package, package, package, ref, action, action, action, action\]/);
  });

  /**
   * An extra workflow, arriving one file at a time. Each of the three
   * directories can be the one that is ahead, and in each case the honest answer
   * is "this release would rewrite every site it found and there is one more",
   * not a count of what happened to be found.
   */
  it("refuses an extra caller with no reusable workflow behind it", () => {
    const root = fixture();
    write(root, ".github/workflows/agent-pr.yml", `${read(root, ".github/workflows/agent-pr.yml")}${planJob(root)}`);

    expect(() => syncVersion(TARGET, root)).toThrow(/plan/);
  });

  /**
   * A caller file short of a caller, and one holding a caller twice: either
   * way its set no longer calls every reusable workflow once, and the count of
   * pins it would be held to is the count of a set that is wrong.
   */
  it("refuses a caller file missing one of its callers", () => {
    const root = fixture();
    const text = read(root, "examples/callers/pr.yml");
    write(root, "examples/callers/pr.yml", text.slice(0, text.indexOf("\n  # **This job is the off switch**")) + "\n");

    expect(() => syncVersion(TARGET, root)).toThrow(/examples\/callers.*follow-ups/);
  });

  it("refuses a caller set calling a reusable workflow twice", () => {
    const root = fixture();
    const fix = read(root, ".github/workflows/agent-pr.yml").match(/\n  fix:\n[\s\S]*?(?=\n\n)/)?.[0] ?? "";
    expect(fix).toContain("/fix.yml@v");
    write(root, ".github/workflows/agent-issue.yml", `${read(root, ".github/workflows/agent-issue.yml")}${fix}\n`);

    expect(() => syncVersion(TARGET, root)).toThrow(/\.github\/workflows call \[.*fix.*fix/);
  });

  it("refuses an extra reusable workflow with no callers in front of it", () => {
    const root = fixture();
    fs.copyFileSync(
      path.join(root, ".github", "workflows", "review.yml"),
      path.join(root, ".github", "workflows", "plan.yml"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(/plan/);
  });

  it("refuses a reference caller file the local callers do not have", () => {
    const root = fixture();
    fs.copyFileSync(
      path.join(root, "examples", "callers", "pr.yml"),
      path.join(root, "examples", "callers", "plan.yml"),
    );

    expect(() => syncVersion(TARGET, root)).toThrow(/plan/);
  });

  /** Either caller file, from either set. */
  it.each([
    [".github/workflows/agent-pr.yml", /\.github\/workflows holds \[agent-issue\]/],
    [".github/workflows/agent-issue.yml", /\.github\/workflows holds \[agent-pr\]/],
    ["examples/callers/pr.yml", /holds caller files \[issue\]/],
    ["examples/callers/issue.yml", /holds caller files \[pr\]/],
  ])("refuses when the caller file %s is missing", (file: string, message: RegExp) => {
    const root = fixture();
    fs.rmSync(path.join(root, ...file.split("/")));

    expect(() => syncVersion(TARGET, root)).toThrow(message);
  });

  /**
   * And it writes nothing at all when it refuses. A propagator that rewrites the
   * files it recognised and then throws leaves the release commit half-done,
   * which is the state it exists to make impossible.
   */
  it("writes nothing when it refuses", () => {
    const root = fixture();
    write(root, ".github/workflows/agent-pr.yml", `${read(root, ".github/workflows/agent-pr.yml")}${planJob(root)}`);
    const before = read(root, ".github/workflows/review.yml");

    expect(() => syncVersion(TARGET, root)).toThrow();

    expect(read(root, ".github/workflows/review.yml")).toBe(before);
  });

  /**
   * A pin is an exact `major.minor.patch` version everywhere it appears — the
   * `npm exec` check in `tests/workflows.test.ts` matches no `^`, no `~` and no
   * dist-tag, and the `uses:` ref must be a tag `publish.yml` would accept. So a
   * version this script cannot write as a valid pin is refused before it writes
   * any of them, rather than distributed to every file for the suite to
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
 * would be a second copy of the build's entry set, and a new runner directory
 * — a routine change, per `CLAUDE.md` — would be compiled and unread.
 */
/**
 * `tsc` against `tsconfig.build.json`, which is the only configuration that
 * describes what ships — `tsconfig.json` includes the tests and the release hook
 * and turns emit off. Both checks below are the compiler's to answer, and
 * neither has a symptom this suite could see any other way, so both spawn it
 * rather than reconstruct it from the config.
 */
const buildTsc = (flag: string): { readonly status: number | null; readonly output: string } => {
  const tsc = path.join("node_modules", "typescript", "bin", "tsc");
  const result = bounded(process.execPath, [tsc, "-p", "tsconfig.build.json", flag]);

  return { status: result.status, output: result.stderr || result.stdout };
};

describe("the release hook stays out of what ships", () => {
  /**
   * The program `tsconfig.build.json` defines: its entry files and everything
   * they import, which is exactly the set `tsc` would emit. `--listFilesOnly`
   * prints that set and stops, so it neither typechecks nor writes `dist/`.
   */
  const compiled = (): readonly string[] => {
    const { status, output } = buildTsc("--listFilesOnly");

    expect(status, output).toBe(0);
    return output
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
 * The `.js` specifier convention, put back inside the gate.
 *
 * `allowImportingTsExtensions` is on in `tsconfig.json` for the one file that is
 * **run from source**: `scripts/sync-version.ts`, which Node resolves literally
 * and so has to name `../shared/pins.ts`. But both halves of `npm run verify`
 * read that config — `tsc --noEmit` and vitest — so with it on, a file that
 * *ships* may name a `.ts` specifier and the gate stays green while the emitted
 * import resolves to nothing. Spelling `review/review.ts`'s `../shared/common`
 * with `.ts` leaves typecheck at 0 and the suite passing; only
 * `tsconfig.build.json`, where the option is off again, reports it (TS5097).
 *
 * `--listFilesOnly` above does not answer this — it prints the program and stops
 * without typechecking it — so this is the same configuration asked the other
 * question. CI's Build step catches it too, one red round trip later; asking it
 * here is what makes the convention `CLAUDE.md` states checkable by the command
 * `CLAUDE.md` calls the gate.
 */
describe("what ships typechecks under the configuration that emits it", () => {
  it("names no `.ts` specifier outside the file that is never emitted", () => {
    const { status, output } = buildTsc("--noEmit");

    expect(status, output).toBe(0);
  });
});

/**
 * The hook, which is the whole point: `npm version patch` has to produce the
 * twelve-file commit on its own.
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
   * believes it took effect — here, propagating the manifest's version to every
   * files while the person who typed a different one watches it report success.
   *
   * Run for real, which also covers the one thing no unit test reaches: `npm
   * version` executes the TypeScript source directly, through Node's type
   * stripping. A syntax this repo compiles but Node cannot strip would fail
   * nowhere else until a release.
   */
  it("refuses an argument rather than taking a version from one", () => {
    const result = bounded(process.execPath, ["scripts/sync-version.ts", "9.9.9"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("9.9.9");
  });

  /**
   * What `committed` below spawns: eight `git` calls to build the scratch
   * repository and its origin. `released` adds the hook itself. Their callers
   * add their own spawns on top and ceiling the sum, since a test bounded below
   * what it spawns fails while every child is still inside its own bound.
   */
  const COMMITTED_SPAWNS = 8;
  const RELEASED_SPAWNS = COMMITTED_SPAWNS + 1;

  /**
   * A scratch repository committed at its current version on `main`, pushed to
   * a bare origin whose default branch is `main` — what the hook asks of a
   * checkout before it writes anything is that it stand at that origin's tip.
   */
  const committed = (): string => {
    const root = fixture();
    // Both files: the hook imports the shared core from `shared/`, and a scratch
    // copy missing it fails at module resolution — which is the one failure
    // `CLAUDE.md` calls indistinguishable from a bare `exit 1`.
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "shared"), { recursive: true });
    fs.copyFileSync("scripts/sync-version.ts", path.join(root, "scripts", "sync-version.ts"));
    fs.copyFileSync("shared/pins.ts", path.join(root, "shared", "pins.ts"));

    // Beside the tree rather than in it, so `git add -A` does not take it in;
    // inside the fixture's own temporary directory would, so a sibling.
    const origin = `${root}.origin.git`;
    scratches.push(origin);

    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "scratch@example.invalid"]);
    git(root, ["config", "user.name", "scratch"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "the tree at its current version"]);
    git(root, ["init", "--bare", "-b", "main", origin]);
    git(root, ["push", "--quiet", origin, "main"]);
    // Set by config rather than `remote add` + push, which would be one spawn
    // more for the same state.
    fs.appendFileSync(path.join(root, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);

    return root;
  };

  /**
   * The hook, run the way `npm version` runs it: the manifest bumped in the
   * working tree and a stray untracked file lying beside it.
   *
   * The stray is the point. `npm version` refuses a tree with *tracked*
   * modifications and lets untracked files straight through, so a `git add -A`
   * in this hook carries whatever happens to be there into the release commit
   * and the tag `publish.yml` fires on — a thirteenth file inside a release,
   * which `PIN` cannot see and no check downstream reads.
   */
  const runHook = (root: string): SpawnSyncReturns<string> => {
    // What npm has already done by the time the hook runs: the manifest bumped,
    // unstaged. npm stages that one and the lockfile itself, afterwards.
    write(root, "package.json", read(root, "package.json").replace(/"version": "[^"]+"/, `"version": "${TARGET}"`));
    write(root, "STRAY-NOTES.md", "left lying around\n");

    return bounded(process.execPath, [path.join(root, "scripts", "sync-version.ts")], { cwd: root });
  };

  const released = (): string => {
    const root = committed();
    const result = runHook(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Synced ${PIN_COUNT} version pin(s) to ${TARGET}.`);

    return root;
  };

  /**
   * Staged inside the hook, or npm commits the bump alone and every rewritten
   * file is left in the working tree — the exact state the hand edit produced,
   * minus the knowledge that they are there. By path, and only the paths it
   * wrote.
   */
  it("stages every file it rewrote, and nothing else in the tree", () => {
    const root = released();

    const staged = git(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).sort();

    expect(staged).toEqual([...EVERY_SITE]);
  }, ceiling(RELEASED_SPAWNS + 1));

  /**
   * `npm version` makes the commit and the tag, and `publish.yml` fires on the
   * tag push. A second one here would be a second way to publish a release.
   */
  it("makes no commit and no tag of its own", () => {
    const root = released();

    expect(git(root, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    expect(git(root, ["tag", "--list"]).trim()).toBe("");
  }, ceiling(RELEASED_SPAWNS + 2));

  /**
   * A release cut anywhere but the tip of origin's default branch is refused
   * before a file is written. v0.7.9 was first cut in a worktree one merge
   * behind `main`; `publish.yml` would have refused the tag, but only after it
   * was pushed, and the tag in the local tree carried a release missing the
   * change it was cut to ship.
   *
   * Each case leaves the pins exactly as they were: the refusal comes first.
   */
  const refused = (root: string, message: RegExp): void => {
    const before = read(root, ".github/workflows/review.yml");
    const result = runHook(root);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain("git checkout -- package.json package-lock.json");
    expect(read(root, ".github/workflows/review.yml")).toBe(before);
  };

  it("refuses a checkout behind origin's default branch", () => {
    const root = committed();
    git(root, ["commit", "--quiet", "--allow-empty", "-m", "merged since"]);
    git(root, ["push", "--quiet", "origin", "main"]);
    git(root, ["reset", "--quiet", "--hard", "HEAD~1"]);

    refused(root, /HEAD is [0-9a-f]{7} but origin's `main` is [0-9a-f]{7}/);
  }, ceiling(COMMITTED_SPAWNS + 4));

  it("refuses a checkout ahead of origin's default branch", () => {
    const root = committed();
    git(root, ["commit", "--quiet", "--allow-empty", "-m", "never reviewed"]);

    refused(root, /HEAD is [0-9a-f]{7} but origin's `main` is [0-9a-f]{7}/);
  }, ceiling(COMMITTED_SPAWNS + 2));

  it("refuses a branch other than origin's default, even at the same commit", () => {
    const root = committed();
    git(root, ["switch", "--quiet", "-c", "claude/some-worktree"]);

    refused(root, /the branch here is `claude\/some-worktree`, not `main`/);
  }, ceiling(COMMITTED_SPAWNS + 2));
});

/**
 * The bound itself, which is the one thing in this file with no domain in it.
 *
 * Both halves are asserted because both have failed silently elsewhere: an
 * unbounded spawn hangs the run rather than failing it (#145), and a bounded
 * one whose caller reads only `status` reports the hang as `expected null to
 * be 0` — a message naming neither the command nor the cause.
 */
describe("every child this suite spawns is bounded", () => {
  /**
   * A child that would outlive any bound, against one it cannot: fifty
   * milliseconds, so the forced failure costs about that and the suite-wide
   * ceiling covers it without a `ceiling` of its own.
   */
  const outlived = (): Error => {
    try {
      bounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 });
    } catch (error) {
      return error as Error;
    }
    throw new Error("the bound did not fire on a child that never exits");
  };

  it("says which command timed out, rather than leaving a null status behind", () => {
    const { message } = outlived();

    expect(message).toContain(process.execPath);
    expect(message).toContain("setInterval");
    expect(message).toContain("timed out after 50ms");
  });

  /**
   * And nothing here spawns around the helper. A second raw `spawnSync` is the
   * state this file was already in — four of them, none bounded — and it is
   * invisible in review precisely because it looks like the call beside it.
   */
  it("spawns through the bounded helper and nowhere else", () => {
    const source = fs.readFileSync(import.meta.filename, "utf8");

    const raw = source.match(new RegExp(String.raw`spawnSync\(|execFileSync\(`, "g")) ?? [];

    expect(raw).toHaveLength(1);
  });
});
