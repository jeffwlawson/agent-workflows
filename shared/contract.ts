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
 * `shared/env.ts`, which take a declaration from here.
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

const REQUIRED = { required: true } as const satisfies Input;

/**
 * An optional input that is empty where it is not given, which is the reading
 * every one of these had before it was declared: a reader that treats `""` as
 * "not given" is told nothing new by a default it would treat the same way.
 */
const EMPTY = { required: false, default: "" } as const satisfies Input;

/**
 * What a runner that drives the agent reads to start it: the model token, and
 * the model, resolved in `shared/common.ts`'s `agentModel` from the runner's
 * own override, then `AGENT_MODEL`, then the baked default. The override's
 * name is computed from the runner's (`update-branch` reads
 * `AGENT_MODEL_UPDATE_BRANCH`), so each runner below names its own, and a test
 * holds the name to the one `agentModel` computes.
 */
const AGENT = {
  CLAUDE_CODE_OAUTH_TOKEN: REQUIRED,
  AGENT_MODEL: EMPTY,
} as const satisfies Inputs;

/**
 * Two of the three variables Actions gives every step, read for a link to the
 * pull request. Empty renders no link, as an unset one always has.
 */
const PULL_REQUEST_LINK = {
  GITHUB_SERVER_URL: EMPTY,
  GITHUB_REPOSITORY: EMPTY,
} as const satisfies Inputs;

/** The same two and the run's id, for a link to the run as well. */
const RUN_LINK = {
  ...PULL_REQUEST_LINK,
  GITHUB_RUN_ID: EMPTY,
} as const satisfies Inputs;

/**
 * The files a runner writes into `OUTPUT_DIR`, by name. Every file it can
 * write is listed, including one written only on some outcomes, whose
 * existence is the signal. The writers in `shared/env.ts` take a runner's list
 * and accept no other name, so a new output file fails typechecking until it
 * is declared here.
 *
 * A name a runner computes is computed over a fixed set, typed where it is
 * written as a template literal over that set, and listed here one literal per
 * name: a name the set gains and this list lacks fails typechecking at the
 * write.
 */
export type Outputs = readonly string[];

/**
 * The file every runner writes when it fails: the reason, in words a human
 * can act on. The CLI's own refusals and `doctor` write it too, through the
 * same writer, and nothing else.
 */
export const EVERY_RUNNER_OUTPUTS = ["failure_reason.txt"] as const satisfies Outputs;

/** One runner's side of the contract. */
export interface RunnerContract {
  readonly inputs: Inputs;
  readonly outputs: Outputs;
}

/**
 * Every runner, by the subcommand that invokes it: the inputs every runner
 * reads, and its own.
 *
 * - `ROUND` is `final` on a PRD PR's final review, and anything else is a
 *   slice round or an ordinary pull request.
 * - `AUTO_FIX` is `true` where the workflow will start a fix round itself, and
 *   anything else is off.
 * - `FIX_ROUNDS_SPENT` and `FIX_ROUND_BUDGET` are counted by the same step,
 *   and a stop on a spent budget is recorded only where both are numbers.
 * - `PRD_PR` is empty on a PRD's first slice, which opens it.
 *
 * And the files each writes:
 *
 * - `implement-prd`'s `progress${name}.md` and `status${name}.md` are over
 *   `name` in `""`, `_stopped` and `_stopped_pushed`.
 * - `review`'s `progress_${ending}.md` and `status_${ending}.md` are over
 *   `RoundEnding` in `shared/progress-list.ts`.
 */
export const CONTRACT = {
  implement: {
    inputs: {
      ...EVERY_RUNNER,
      ...AGENT,
      AGENT_MODEL_IMPLEMENT: EMPTY,
      ISSUE_NUMBER: REQUIRED,
      ISSUE_TITLE: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
    },
    outputs: [...EVERY_RUNNER_OUTPUTS],
  },
  "implement-prd": {
    inputs: {
      ...EVERY_RUNNER,
      ...AGENT,
      AGENT_MODEL_IMPLEMENT_PRD: EMPTY,
      ISSUE_NUMBER: REQUIRED,
      ISSUE_TITLE: REQUIRED,
      SUB_NUMBER: REQUIRED,
      SUB_TITLE: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
      RESCUE_BRANCH: REQUIRED,
      PRD_PR: EMPTY,
      MERGED: EMPTY,
      ...PULL_REQUEST_LINK,
    },
    outputs: [
      ...EVERY_RUNNER_OUTPUTS,
      "progress.md",
      "status.md",
      "progress_stopped.md",
      "status_stopped.md",
      "progress_stopped_pushed.md",
      "status_stopped_pushed.md",
      "rescue_ignored.md",
    ],
  },
  review: {
    inputs: {
      ...EVERY_RUNNER,
      ...AGENT,
      AGENT_MODEL_REVIEW: EMPTY,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
      ROUND: EMPTY,
      CI_STATUS_FILE: EMPTY,
      CI_RESULT_FILE: EMPTY,
      AUTO_FIX: EMPTY,
      FIX_ROUNDS_SPENT: EMPTY,
      FIX_ROUND_BUDGET: EMPTY,
      RED_CHECK_CONFIGURED: EMPTY,
      RED_CHECK_FILE: EMPTY,
      ...RUN_LINK,
    },
    outputs: [
      ...EVERY_RUNNER_OUTPUTS,
      "park_failed.md",
      "progress_approved.md",
      "status_approved.md",
      "progress_parked.md",
      "status_parked.md",
      "progress_running.md",
      "status_running.md",
      "review_payload.json",
      "summary.md",
      "review_body.json",
      "thread_resolutions.json",
      "pr_summary.json",
      "verdict.json",
      "park.md",
      "park_posted.md",
      "pr_status.md",
      "follow_ups.md",
    ],
  },
  fix: {
    inputs: {
      ...EVERY_RUNNER,
      ...AGENT,
      AGENT_MODEL_FIX: EMPTY,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
      RESCUE_BRANCH: REQUIRED,
    },
    outputs: [
      ...EVERY_RUNNER_OUTPUTS,
      "nothing_to_do.txt",
      "rescue_ignored.md",
      "thread_outcomes.json",
      "conversation_outcomes.md",
      "top_level_comments.json",
      "out_of_scope_notes.json",
    ],
  },
  "update-branch": {
    inputs: {
      ...EVERY_RUNNER,
      ...AGENT,
      AGENT_MODEL_UPDATE_BRANCH: EMPTY,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
    },
    outputs: [...EVERY_RUNNER_OUTPUTS, "update_comment.md"],
  },
  "follow-ups": {
    inputs: {
      ...EVERY_RUNNER,
      PR_NUMBER: REQUIRED,
    },
    outputs: [...EVERY_RUNNER_OUTPUTS],
  },
} as const satisfies Readonly<Record<string, RunnerContract>>;

export type Runner = keyof typeof CONTRACT;
