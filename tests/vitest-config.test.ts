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
});
