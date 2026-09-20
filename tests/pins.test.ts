import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncVersion } from "../scripts/sync-version.js";
import { rewritePins } from "../shared/pins.js";

/**
 * The shared core, called the way the second caller would.
 *
 * `tests/sync-version.test.ts` covers the **release** half and all of its
 * policy: this repository's three directories, fifteen sites, and a refusal on
 * any count but one. `init` (#6) does the same rewrite for the opposite reason —
 * it writes **this** package's name and version into *someone else's*
 * repository, over whatever subset of the callers an adopter took, with no
 * `examples/` and no reusable workflows behind them.
 *
 * `syncVersion` cannot serve that, and the checks here say so in both
 * directions: the core does the adopter's job, and `syncVersion` refuses the
 * same root by name. What is shared is one file's text in, the rewritten text
 * and the forms found out — no directories, and no manifest. A header claiming
 * a reuse with only one caller written is a claim nothing checks, so this is the
 * check: call it as the caller that does not exist yet.
 *
 * The file mirrors `shared/pins.ts` rather than sitting beside the release
 * tests, for the reason the source does: the core is the half that ships, and
 * the release hook is the half deliberately kept out of the tarball.
 */

const scratches: string[] = [];

afterEach(() => {
  for (const root of scratches.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const read = (root: string, rel: string): string =>
  fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

const write = (root: string, rel: string, text: string): void =>
  fs.writeFileSync(path.join(root, ...rel.split("/")), text);

/** The version written by every rewrite test: recognisable, and no repo's own. */
const TARGET = "9.9.9";

describe("the pin rewrite is a core init can use", () => {
  /** This package's name — the parameter `init` supplies, not the root's own. */
  const PACKAGE = "@jeffwlawson/agent-workflows";

  /**
   * An adopter's repository once `init` has copied the callers in: one
   * `.github/workflows/agent-*.yml` per reference caller, and nothing else this
   * rewrite knows about.
   *
   * The manifest is deliberately somebody else's. An adopter's `package.json`
   * names an unrelated project — or, for a repository whose toolchain is not
   * Node, is not there at all — so a rewrite that reads the package name from
   * the root it is pointed at looks for the wrong pin, or for none.
   */
  const adopted = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pins-adopter-"));
    scratches.push(root);
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    for (const file of fs.readdirSync("examples/callers").filter((entry) => entry.endsWith(".yml"))) {
      fs.copyFileSync(path.join("examples", "callers", file), path.join(root, ".github", "workflows", `agent-${file}`));
    }
    fs.writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "an-adopting-project", version: "3.2.1" }, null, 2)}\n`,
    );
    return root;
  };

  const callersIn = (root: string): readonly string[] =>
    fs.readdirSync(path.join(root, ".github", "workflows")).sort().map((file) => `.github/workflows/${file}`);

  it("rewrites an adopter's callers: no examples/, no reusable workflows, no manifest of ours", () => {
    const root = adopted();

    const found = callersIn(root).flatMap((file) => {
      const rewrite = rewritePins(read(root, file), { packageName: PACKAGE, version: TARGET });
      write(root, file, rewrite.text);
      return rewrite.found;
    });

    // One `ref` pin per caller and no `package` pin anywhere: an adopter's tree
    // holds no reusable half. Derived from the fixture rather than written out,
    // because the count is the reference set's and moves with it — it went from
    // five to six when `follow-ups` landed (#50) — while the property being
    // asserted, one pin of one form per file, does not.
    expect(found).toEqual(callersIn(root).map(() => "ref"));
    expect(found.length).toBeGreaterThan(1);
    for (const file of callersIn(root)) {
      expect(read(root, file)).toContain(`${PACKAGE.replace(/^@/, "")}/.github/workflows/`);
      expect(read(root, file)).toContain(`.yml@v${TARGET}`);
    }
  });

  /**
   * The same root, through the release half. Not a second way of saying the
   * above: it is the reason the core had to be exposed at all, and it fails with
   * the message the review on #23 saw — so a later change that quietly widens
   * `syncVersion` to accept an adopter's tree lands here rather than in a
   * release.
   */
  it("is the root syncVersion refuses, which is why the core is separate", () => {
    const root = adopted();

    expect(() => syncVersion(TARGET, root)).toThrow(/reusable workflows for \[\]/);
  });

  /** Both parameters, and neither read from anywhere: a different name matches nothing. */
  it("takes the package name as a parameter, and rewrites nothing for another package", () => {
    const root = adopted();
    const before = read(root, ".github/workflows/agent-review.yml");

    const rewrite = rewritePins(before, { packageName: "@someone/else", version: TARGET });

    expect(rewrite.found).toEqual([]);
    expect(rewrite.text).toBe(before);
  });

  /**
   * The count is reported, never judged. A surprising one is the release's
   * failure and the adopter's normal — `syncVersion` throws on anything but one
   * site of the expected form, and `init` takes whatever subset of the callers
   * the adopter installed.
   */
  it("reports what it found rather than ruling on it", () => {
    const caller = read(adopted(), ".github/workflows/agent-review.yml");

    expect(rewritePins("", { packageName: PACKAGE, version: TARGET })).toEqual({ text: "", found: [] });
    expect(rewritePins(caller + caller, { packageName: PACKAGE, version: TARGET }).found).toEqual(["ref", "ref"]);
  });

  /** Both forms, from one text: the reusable's npm spec and the caller's git ref. */
  it("tells the two forms apart in one file, and writes each in its own shape", () => {
    const text = [
      `        run: npm exec --yes --package=${PACKAGE}@0.0.1 -- agent-workflows review`,
      `    uses: ${PACKAGE.replace(/^@/, "")}/.github/workflows/review.yml@v0.0.1`,
    ].join("\n");

    const rewrite = rewritePins(text, { packageName: PACKAGE, version: TARGET });

    expect(rewrite.found).toEqual(["package", "ref"]);
    expect(rewrite.text).toContain(`--package=${PACKAGE}@${TARGET} --`);
    expect(rewrite.text).toContain(`/review.yml@v${TARGET}`);
  });

  /** The one policy it does keep: a version that cannot be written as a pin. */
  it("refuses a version that is not a pin, wherever it is being written", () => {
    expect(() => rewritePins("", { packageName: PACKAGE, version: "latest" })).toThrow(/version/i);
  });
});
