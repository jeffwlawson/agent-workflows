import { defineConfig } from "vitest/config";

/**
 * How long one test may take, and how long any one synchronous spawn inside it
 * may run. Two roles, one figure — the spawning tests import this rather than
 * repeat it (`tests/review-ci-wait.test.ts`), so the ceiling and the bound
 * cannot drift apart.
 *
 * As `testTimeout` it is a **flake guard, not a hang guard.** Several tests here
 * spawn `bash`, `jq`, `node`, a replay `gh` or the real `gh` through
 * `spawnSync`, and vitest's timeout cannot interrupt a synchronous spawn: the
 * event loop is blocked until the child exits, so the timer can only fire once
 * the test body has already returned. What ends a hang is the spawn's own
 * `timeout` option, and that stays the thing every such call passes. This is
 * sized instead for a *cold start under a loaded parallel run*, which is what
 * put the real-`gh` tests past vitest's 5-second default (#139) and left the
 * replay-based ones at 14–29x headroom against it (#144).
 *
 * Which is also why it must not sit *above* a spawn bound: a spawn that overran
 * would be killed by its own bound first and reported as a spawn failure —
 * SIGTERM, no output — rather than as the test taking too long. Held equal to
 * the bounds here, so a report of *this* limit means a test accumulated several
 * spawns, never that one of them hung.
 */
export const SUBPROCESS_TIMEOUT = 60_000;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: SUBPROCESS_TIMEOUT,
  },
});
