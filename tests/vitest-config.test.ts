import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import config, { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The suite's own timing, which nothing else here asserts over.
 *
 * `SUBPROCESS_TIMEOUT` being exported and `testTimeout` being set to it are two
 * separate facts: the spawning tests import the constant for their own spawn
 * bounds and would go on passing if the setting beside it were dropped, putting
 * the suite back on vitest's 5-second default with nothing red (#144). So the
 * wiring is asserted here rather than left to the config reading as if it were
 * obviously in force.
 */
describe("the suite's per-test timeout", () => {
  /** vitest's own `testTimeout` default, which the suite ran on until #144. */
  const VITEST_DEFAULT = 5_000;

  it("is set suite-wide, to the figure the spawn bounds use", () => {
    expect(config.test?.testTimeout).toBeGreaterThan(VITEST_DEFAULT);
    expect(config.test?.testTimeout).toBe(SUBPROCESS_TIMEOUT);
  });

  /**
   * And it is the only place the figure is written. Two branches bounded their
   * spawns at the same moment and each wrote its own copy of this number — #145
   * in `tests/sync-version.test.ts`, #144 in `tests/review-ci-wait.test.ts` —
   * equal by coincidence, and neither could see the other until they met on
   * `main`. `CLAUDE.md` said "imported rather than repeated" in prose and nothing
   * checked it. (Which is why the number itself is not written in this comment
   * either: the check below reads every file here, this one included.)
   *
   * Both spellings, derived from the constant so the check follows it rather
   * than pinning today's number. A digit grouped some other way would slip
   * through, which is the limit of a text search and still catches the copy that
   * happened: someone bounding a new spawn writes the figure they read.
   */
  it("is written in no test file, which imports it instead", () => {
    const plain = String(SUBPROCESS_TIMEOUT);
    const spellings = [plain, plain.replace(/\B(?=(\d{3})+$)/g, "_")];

    // The offenders rather than an assertion per file: a `.not.toContain` over a
    // file's text prints the whole file as its diff, and the finding is a list of
    // names.
    // Recursive, and `include` is `tests/**/*.test.ts`: a flat read would leave a
    // test in a subdirectory free to write the literal with nothing red, in the
    // one check that makes "imported, never repeated" enforced rather than
    // stated. The encoding is not optional — `{ recursive: true }` alone types
    // as `string[] | Buffer[]` and fails `--strict` at `.endsWith`.
    const written = fs
      .readdirSync("tests", { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => {
        const text = fs.readFileSync(path.join("tests", name), "utf8");
        return spellings.some((spelling) => text.includes(spelling));
      });

    expect(written, `these write ${spellings.join(" or ")} rather than importing it`).toEqual([]);
  });
});
