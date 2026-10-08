import { defineConfig } from "vitest/config";

/**
 * How long one test may take, and how long any one synchronous spawn inside it
 * may run. Two roles, one figure — every test that spawns imports this rather
 * than repeating it (`tests/red-check.test.ts`, `tests/sync-version.test.ts`),
 * so the ceiling and the bound cannot drift apart.
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
 * Held *equal* to a spawn's bound rather than over it, so that one bounded spawn
 * is exactly covered and a report of this limit means a test accumulated several
 * spawns, never that one of them hung. A test that does accumulate several
 * raises its own ceiling to a multiple of this same figure, because a ceiling
 * under the sum of its children's bounds fails while every one of them is still
 * inside its own (`tests/sync-version.test.ts`'s `ceiling`). The raise hides
 * nothing: the spawn's bound still fires at this figure, and it is the spawn that
 * reports it.
 *
 * What a raised ceiling must not be is a literal of its own. #144 and #145 were
 * in flight together and each wrote this number separately; two copies drift,
 * and a ceiling that drifts *under* the bound fails a test whose child was still
 * within it — the flake the figure exists to prevent.
 */
export const SUBPROCESS_TIMEOUT = 60_000;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: SUBPROCESS_TIMEOUT,
  },
});
