/**
 * What each runner needs from whatever invokes it: the runner half of the
 * runner ⇄ orchestrator contract, declared once.
 *
 * The prose of that contract is the platform spec, read at the release you
 * run: `https://github.com/jeffwlawson/agent-workflows/blob/v<version>/docs/platform-spec.md`,
 * with `<version>` the version you pinned. Written as a placeholder on purpose:
 * a literal version here would be a pin site `scripts/sync-version.ts` does
 * not know, and stale from the next release.
 *
 * No side effects and no imports, like `shared/pins.ts`, so an orchestrator
 * that is not Actions can import it to build the environment it hands a runner
 * without loading a runner, the agent SDK, or anything that reads the
 * environment on import. Reading is `readInputs` and `input` in
 * `shared/common.ts`, which take a declaration from here.
 */

/** An input the runner cannot run without. Empty counts as missing. */
export interface RequiredInput {
  readonly required: true;
}

/**
 * An input the runner can do without, and what it reads in its place. The
 * default is not optional: an input that may be absent and says nothing about
 * what that means is a quiet default nobody chose, so the type refuses one.
 */
export interface OptionalInput {
  readonly required: false;
  readonly default: string;
}

export type Input = RequiredInput | OptionalInput;

/** Input name, as the environment variable the runner reads, to what it needs of it. */
export type Inputs = Readonly<Record<string, Input>>;

/**
 * The inputs every runner reads, so an orchestrator sets them once for any of
 * them.
 *
 * - `OUTPUT_DIR`: where the runner writes its results and its
 *   `failure_reason.txt`. Fresh and empty for every run.
 * - `GH_REPO`: the repository, `owner/name`. Required rather than left to
 *   whatever `gh` infers from the working directory, which is a guess.
 * - `GH_TOKEN`: read by `gh` rather than by the runner, and declared anyway, so
 *   a missing token stops the run at start instead of every read degrading to
 *   "untrusted, empty".
 *
 * `OUTPUT_DIR` is first so that, when several are missing, the one the
 * failure report is written into is checked before the others.
 */
export const EVERY_RUNNER = {
  OUTPUT_DIR: { required: true },
  GH_REPO: { required: true },
  GH_TOKEN: { required: true },
} as const satisfies Inputs;

/** One runner's side of the contract. */
export interface RunnerContract {
  readonly inputs: Inputs;
}

/**
 * Every runner, by the subcommand that invokes it. A runner's own inputs join
 * `EVERY_RUNNER` here as each one moves onto the accessor.
 */
export const CONTRACT = {
  implement: { inputs: { ...EVERY_RUNNER } },
  "implement-prd": { inputs: { ...EVERY_RUNNER } },
  review: { inputs: { ...EVERY_RUNNER } },
  fix: { inputs: { ...EVERY_RUNNER } },
  "update-branch": { inputs: { ...EVERY_RUNNER } },
  "follow-ups": { inputs: { ...EVERY_RUNNER } },
} as const satisfies Readonly<Record<string, RunnerContract>>;

export type Runner = keyof typeof CONTRACT;
