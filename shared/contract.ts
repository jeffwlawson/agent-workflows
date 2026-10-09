/**
 * What each subcommand needs from whatever invokes it: the package's half of
 * the runner ⇄ orchestrator contract, declared once. Two kinds, in two maps
 * (ADR 0004): `RUNNERS`, which start the agent, and `COMMANDS`, which do an
 * orchestrator's work on the record and start no agent. The kind is what tells
 * an orchestrator which subcommand may be handed the write token, a command
 * and never a runner, so it is declared here rather than read off the
 * package's folders, which an orchestrator cannot see.
 *
 * The prose of that contract is the platform spec, read at the release you
 * run: `https://github.com/jeffwlawson/agent-workflows/blob/v<version>/docs/platform-spec.md`,
 * with `<version>` the version you pinned. Written as a placeholder on purpose:
 * a literal version here would be a pin site `scripts/sync-version.ts` does
 * not know, and stale from the next release.
 *
 * No side effects and no imports, like `shared/pins.ts`, so an orchestrator
 * that is not Actions can import it to build the environment it hands a
 * subcommand without loading one, the agent SDK, or anything that reads the
 * environment on import. Reading is `readInputs` and `input` in
 * `shared/env.ts`, which take a declaration from here.
 */

/**
 * The values an input accepts, where it accepts only some: a value outside
 * them fails the run through `fail()` in `readInputs`, naming the input, the
 * value and these, rather than quietly reading as whatever the reader's
 * comparison makes of it. Unset is not a value, and reads as an optional
 * input's default, which has to be one of these or empty: empty is "not
 * given", which `ROUND` keeps for an ordinary pull request (#377).
 */
export type Accepts = readonly [string, ...string[]];

/** An input the subcommand cannot run without. Empty counts as missing. */
export interface RequiredInput {
  readonly required: true;
  readonly accepts?: Accepts;
}

/**
 * An input the subcommand can do without, and what it reads in its place. The
 * default is not optional: an input that may be absent and says nothing about
 * what that means is a quiet default nobody chose, so the type refuses one.
 */
export interface OptionalInput {
  readonly required: false;
  readonly default: string;
  readonly accepts?: Accepts;
}

/** Whether a producer writes a file every time it ends, or only on some outcomes. */
export type Presence = "always" | "sometimes";

/** File name to whether the producer always writes it. */
export type DirectoryFiles = Readonly<Record<string, Presence>>;

/**
 * An input naming a directory another subcommand wrote into, its
 * `OUTPUT_DIR`, and exactly the files read from it (ADR 0004, ADR 0006).
 * Required like any other, since the path is what the environment carries,
 * and with two more things declared: the **producer**, a subcommand by name,
 * and the **files**, each with whether the producer always writes it. A file
 * written only on some outcomes reads as absent where it is not there; one
 * always written is a failure where it is not.
 *
 * Built with `readsFrom`, which takes only names the producer declares as
 * outputs, and read with `readDirectory` in `shared/hand-over.ts`, which reads
 * these files and no others. So a renamed output is a type error at both.
 */
export interface DirectoryInput<F extends DirectoryFiles = DirectoryFiles> extends RequiredInput {
  readonly producer: string;
  readonly files: F;
}

export type Input = RequiredInput | OptionalInput | DirectoryInput;

/** Whether `input` is a directory input rather than a plain one. */
export const isDirectoryInput = (input: Input): input is DirectoryInput => "producer" in input;

/** Input name, as the environment variable the subcommand reads, to what it needs of it. */
export type Inputs = Readonly<Record<string, Input>>;

/**
 * The inputs every subcommand reads, runner or command, so an orchestrator
 * sets them once for any of them.
 *
 * - `OUTPUT_DIR`: where the subcommand writes its results and its
 *   `failure_reason.txt`. Fresh and empty for every run.
 * - `GH_REPO`: the repository, `owner/name`. Required rather than left to
 *   whatever `gh` infers from the working directory, which is a guess.
 * - `GH_TOKEN`: read by `gh` rather than by the subcommand, and declared anyway, so
 *   a missing token stops the run at start instead of every read degrading to
 *   "untrusted, empty".
 *
 * `OUTPUT_DIR` is first so that, when several are missing, the one the
 * failure report is written into is checked before the others.
 *
 * Every subcommand but a command that runs where no token is held, which
 * reads `OUTPUT_DIR` alone of these (`TOKENLESS`).
 */
export const EVERY_SUBCOMMAND = {
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
 * **Which round of a PRD PR's review this is** (#377), as `review:gate`
 * decided it: `slice` or `final` on a PRD PR, and unset on an ordinary pull
 * request. Read by the review runner, `review:conclude` and `review:advance`,
 * each from this one declaration, so a value none of them expects (`Final`, a
 * new round kind) fails the run rather than quietly reading as a slice round,
 * as not the final review, or as not one to advance from.
 */
const ROUND = { required: false, default: "", accepts: ["slice", "final"] } as const satisfies Input;

/**
 * **The loop's accounts** (#376, `docs/platform-spec.md` §4.1): a
 * comma-separated list of the logins the orchestrator posts the loop's
 * reviews, comments and statuses as, each in either spelling, `<slug>[bot]`
 * or `<slug>`. Read by every runner and command that asks whether something
 * was posted by the loop, through `loopAccounts` (`shared/loop-accounts.ts`),
 * which always adds `github-actions[bot]` and reads an empty entry as none. A
 * list, not one name: at a migration, pull requests in flight carry both
 * accounts. Empty is that default alone, which is the loop before this input.
 * A malformed entry fails the run, naming it.
 *
 * **This is trust.** The list feeds `isTrustedAuthor`, so whatever posts as
 * an account on it becomes text `fix` acts on and commits code from, whatever
 * its author association. That is safe only because the orchestrator that
 * sets it already holds the write token: it can name no account it could not
 * already write as. An orchestrator ***must not*** list an account anything
 * it does not control can post as.
 */
const LOOP_ACCOUNTS = {
  AGENT_LOOP_LOGINS: EMPTY,
} as const satisfies Inputs;

/**
 * What a runner that drives the agent reads to start it: the model token, and
 * the model, resolved in `shared/agent.ts`'s `agentModel` from the runner's
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
 * The files a subcommand writes into `OUTPUT_DIR`, by name. Every file it can
 * write is listed, including one written only on some outcomes, whose
 * existence is the signal. The writers in `shared/env.ts` take a subcommand's list
 * and accept no other name, so a new output file fails typechecking until it
 * is declared here.
 *
 * A name a subcommand computes is computed over a fixed set, typed where it is
 * written as a template literal over that set, and listed here one literal per
 * name: a name the set gains and this list lacks fails typechecking at the
 * write.
 */
export type Outputs = readonly string[];

/**
 * The file every subcommand writes when it fails: the reason, in words a human
 * can act on. The CLI's own refusals and `doctor` write it too, through the
 * same writer, and nothing else.
 */
export const EVERY_SUBCOMMAND_OUTPUTS = ["failure_reason.txt"] as const satisfies Outputs;

/**
 * A runner's inputs: any but `LOOP_TOKEN`, the token whose writes start the
 * loop's next workflow. A runner that starts the agent leaves its environment
 * where the agent can read it, so the write token is refused here, by the
 * compiler, rather than by a check that has to be remembered (ADR 0004). A
 * command may declare it.
 */
export type RunnerInputs = Inputs & { readonly LOOP_TOKEN?: never };

/** One runner's side of the contract. */
export interface RunnerContract {
  readonly inputs: RunnerInputs;
  readonly outputs: Outputs;
}

/**
 * One command's side of the contract. The same shape as a runner's today; a
 * command differs in what it may declare, not in how it is declared.
 */
export interface CommandContract {
  readonly inputs: Inputs;
  readonly outputs: Outputs;
}

/**
 * Every runner, by the subcommand that invokes it: the inputs every
 * subcommand reads, and its own.
 *
 * - `ROUND` is `final` on a PRD PR's final review, `slice` on a slice round,
 *   and unset on an ordinary pull request. Anything else fails the run (#377).
 * - `AUTO_FIX` is `true` where the workflow will start a fix round itself, and
 *   `false` or unset where it will not. Anything else fails the run (#378): a
 *   run that could not say must not claim a fix round started.
 * - `FIX_ROUNDS_SPENT` and `FIX_ROUND_BUDGET` are counted by the same step,
 *   and a stop on a spent budget is recorded only where both are numbers.
 * - `PRD_PR` is empty on a PRD's first slice, which opens it.
 *
 * And the files each writes:
 *
 * - `implement-prd`'s `progress${name}.md` and `status${name}.md` are over
 *   `name` in `""`, `_stopped` and `_stopped_pushed`.
 * - `review`'s `park.json` and `progress.json`, on a PRD PR, are what
 *   `review:advance` parks the chain and writes the progress table from, as
 *   data (ADR 0007): written before the agent runs, and again once the
 *   review knows what it leaves open.
 */
export const RUNNERS = {
  implement: {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...AGENT,
      ...LOOP_ACCOUNTS,
      AGENT_MODEL_IMPLEMENT: EMPTY,
      ISSUE_NUMBER: REQUIRED,
      ISSUE_TITLE: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS],
  },
  "implement-prd": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...AGENT,
      ...LOOP_ACCOUNTS,
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
      ...EVERY_SUBCOMMAND_OUTPUTS,
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
      ...EVERY_SUBCOMMAND,
      ...AGENT,
      ...LOOP_ACCOUNTS,
      AGENT_MODEL_REVIEW: EMPTY,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
      ROUND,
      CI_STATUS_FILE: EMPTY,
      CI_RESULT_FILE: EMPTY,
      AUTO_FIX: { required: false, default: "false", accepts: ["true", "false"] },
      FIX_ROUNDS_SPENT: EMPTY,
      FIX_ROUND_BUDGET: EMPTY,
      RED_CHECK_CONFIGURED: EMPTY,
      RED_CHECK_FILE: EMPTY,
    },
    outputs: [
      ...EVERY_SUBCOMMAND_OUTPUTS,
      "park.json",
      "progress.json",
      "findings.json",
      "review_body.json",
      "thread_resolutions.json",
      "pr_summary.json",
      "verdict.json",
    ],
  },
  fix: {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...AGENT,
      ...LOOP_ACCOUNTS,
      AGENT_MODEL_FIX: EMPTY,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
      RESCUE_BRANCH: REQUIRED,
    },
    outputs: [
      ...EVERY_SUBCOMMAND_OUTPUTS,
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
      ...EVERY_SUBCOMMAND,
      ...AGENT,
      AGENT_MODEL_UPDATE_BRANCH: EMPTY,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "update_comment.md"],
  },
} as const satisfies Readonly<Record<string, RunnerContract>>;

export type Runner = keyof typeof RUNNERS;

/**
 * A directory input reading `files` from the runner `producer`'s `OUTPUT_DIR`.
 * Each name has to be one of the runner's declared outputs: one it does not
 * declare, or one renamed since, fails typechecking here.
 */
export const readsFrom = <P extends Runner, const F extends DirectoryFiles>(
  producer: P,
  files: F & Readonly<Record<Exclude<keyof F, (typeof RUNNERS)[P]["outputs"][number]>, never>>,
): DirectoryInput<F> => ({ required: true, producer, files });

/**
 * The same, from a command: `_declared` is the producing command's own
 * declaration, which is declared ahead of `COMMANDS` so that a command after
 * it in the map can name its outputs, and is read for its type alone. Each
 * name has to be one of them.
 * `tests/platform-spec.test.ts` holds `producer` to a command whose outputs
 * these are.
 */
const readsFromCommand = <O extends Outputs, const F extends DirectoryFiles>(
  producer: string,
  _declared: { readonly outputs: O },
  files: F & Readonly<Record<Exclude<keyof F, O[number]>, never>>,
): DirectoryInput<F> => ({ required: true, producer, files });

/**
 * What a command that writes through the engine's writer reads beside
 * `GH_TOKEN` (ADR 0004): the token whose writes start the loop's next
 * workflow, and where it came from, `app`, `pat` or `workflow`. A command
 * picks the token per write, since which writes have to start a run is loop
 * knowledge every orchestrator gets. A runner may not declare `LOOP_TOKEN`
 * (`RunnerInputs`).
 */
const LOOP = {
  LOOP_TOKEN: REQUIRED,
  LOOP_TOKEN_SOURCE: REQUIRED,
} as const satisfies Inputs;

/**
 * The same two, for a command that has to run where the loop's token was
 * never minted: `review:conclude` and `review:advance`, since a failed mint
 * is one of the endings each reports (ADR 0004). Empty is "no loop token", and the command makes no
 * write that needs one.
 */
const LOOP_IF_MINTED = {
  LOOP_TOKEN: EMPTY,
  LOOP_TOKEN_SOURCE: EMPTY,
} as const satisfies Inputs;

/**
 * The write log a command that writes through the engine's writer keeps, one
 * line per write as it lands and a last line for how the command ended
 * (ADR 0005).
 */
const WRITE_LOG = "write_log.jsonl";

/**
 * `review:publish`, declared ahead of `COMMANDS` so that `review:conclude`
 * can read its outputs (`readsFromCommand`). See `COMMANDS`.
 */
const REVIEW_PUBLISH = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP,
    PR_NUMBER: REQUIRED,
    BRANCH: REQUIRED,
    REVIEWED_SHA: REQUIRED,
    REVIEW_DIR: readsFrom("review", {
      "findings.json": "always",
      "review_body.json": "always",
      "thread_resolutions.json": "always",
      "pr_summary.json": "sometimes",
      "verdict.json": "always",
    }),
    ...RUN_LINK,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "published.json", WRITE_LOG],
} as const satisfies CommandContract;

/**
 * What a command that runs where no token is held reads of
 * `EVERY_SUBCOMMAND`: `OUTPUT_DIR`, and neither the repository nor the token,
 * since it reads no repository and is handed none. The red check's two
 * (#422), whose job runs the pull request's own code.
 */
export const TOKENLESS = {
  OUTPUT_DIR: EVERY_SUBCOMMAND.OUTPUT_DIR,
} as const satisfies Inputs;

/**
 * What the red check's two commands read beside their own: `TOKENLESS`, and
 * the pull request's checkout, which they work in.
 */
const RED_CHECK = {
  ...TOKENLESS,
  CHECKOUT: REQUIRED,
} as const satisfies Inputs;

/**
 * `review:red-check-place`, declared ahead of `COMMANDS` so that
 * `review:red-check-classify` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const REVIEW_RED_CHECK_PLACE = {
  inputs: {
    ...RED_CHECK,
    BRANCH: REQUIRED,
    BASE_REF: REQUIRED,
    PR_BODY: EMPTY,
    REPORT_PATH: EMPTY,
    TEST_GLOBS: EMPTY,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "place.json"],
} as const satisfies CommandContract;

/**
 * Every command, by the subcommand that invokes it, `<workflow>:<step>`: the
 * inputs every subcommand reads, and its own. Its code is `<step>.ts` in the
 * workflow's folder, and exports one function the CLI calls with the inputs
 * declared here.
 *
 * - `follow-ups:file` writes issues with its `GH_TOKEN` itself, outside the
 *   engine's writer, until its own workflow moves (ADR 0005).
 * - `review:gate` decides, before checkout, whether the review runs, which
 *   commit it reviews, the fix-round budget's value and, on a PRD branch,
 *   which round it is, and writes nothing to the record: the posting job says
 *   what it decided. `HEAD_SHA`, `PR_STATE` and `PR_MERGED` are the pull request as
 *   the event that asked for the review saw it; the branch's tip and the rest
 *   of the live state it reads itself. `gate.json` is its decisions, every
 *   value a string, under the names an orchestrator hands on, and
 *   `refusal_reason.txt` is a variable it refused, written before it fails.
 * - `review:budget` counts, after the checkout, the automatic fix rounds
 *   spent against `FIX_ROUND_BUDGET`, the budget `review:gate` settled, and
 *   decides whether a review that recommends changes starts one, with
 *   `LOOP_TOKEN_SOURCE` the token the loop writes with. On a PRD branch the
 *   rounds are this round's alone (#331): `ROUND` is `review:gate`'s, and a
 *   slice round's slice is read off the checkout's history against
 *   `BASE_REF`. `budget.json` is the budget, the rounds spent and the
 *   decision, every value a string, which the runner reads as
 *   `FIX_ROUND_BUDGET`, `FIX_ROUNDS_SPENT` and `AUTO_FIX`.
 * - `review:collect-checks` waits for the pull request's other checks on
 *   `REVIEWED_SHA`, the commit `review:gate` settled, and writes nothing to
 *   the record. `SELF_CHECK` is the name of the check run of the job it runs
 *   in, and `SELF_RUN_ID` the run it runs in, empty where there is none: its
 *   own, which it leaves out of the wait. `ci_status.md` is their results
 *   for the agent, and `ci_result.txt` the one word the runner derives the
 *   verdict's CI half from, which the runner reads as `CI_STATUS_FILE` and
 *   `CI_RESULT_FILE`.
 * - `review:red-check-place` puts the test files the pull request adds or
 *   changes over the code as it was before it, in `CHECKOUT`: the merge-base
 *   with `BASE_REF`, or on a slice round of a PRD PR the PRD branch before the
 *   slice. `BRANCH` and `PR_BODY` are the pull request's head branch and body
 *   as the event saw them, which say whether it is a PRD PR's final review.
 *   `REPORT_PATH` and `TEST_GLOBS` are the adopter's `red-check-report` and
 *   `red-check-test-globs`, and it refuses neither: a missing one is its
 *   `misconfigured` placement. `place.json` is what it placed and on what.
 * - `review:red-check-classify` classifies each test in the JUnit report at
 *   `REPORT_PATH`, in `CHECKOUT`, as red, broken or passed, and writes
 *   `red_check.json`, the report the review reads. `SETUP_OUTCOME` is the
 *   adopter's install step's outcome and `EXIT_CODE` their test command's,
 *   each empty where it did not run, and what place decided it reads through
 *   `PLACE_DIR`.
 * - `review:publish` resolves the threads a review closed and posts it on
 *   `REVIEWED_SHA`, the commit the review job recorded before the agent ran
 *   (ADR 0006), then writes the title, the summary, the status line and the
 *   verdict. `BRANCH` is the pull request's head branch, which says whether
 *   it is a PRD PR, whose status line is the advance job's.
 *   `published.json` is the posted review's URL, written the moment it is
 *   posted.
 * - `review:conclude` ends every run, success included: the refusal's note,
 *   the error verdict and the failure comment, the ready mark, `agent:review`
 *   off, and the hand-off after it. It is told how the review job and the
 *   posting job's steps ended (`REVIEW_RESULT`, and `MINT_OUTCOME`,
 *   `DOWNLOAD_OUTCOME` and `PUBLISH_OUTCOME`, each a step's outcome, empty
 *   where it did not run), and the review job's outputs, and reads what
 *   publish wrote through `PUBLISH_DIR`. `ended.json` is whether the head
 *   moved while the review ran, and the posted review's URL.
 * - `review:advance` moves a PRD PR's chain on after a review, or parks it:
 *   the progress table and status line for how the round ended, then
 *   `agent:implement` back on the parent on a slice round's approval, or the
 *   park comment on it on any ending but an approval or a fix round
 *   starting. It is told how the review job and the posting job ended
 *   (`REVIEW_RESULT`, `POSTING_RESULT`), the review job's outputs, the
 *   posting job's (`MOVED`, `REVIEW_URL`) and the mint's outcome, and reads
 *   the runner's park hand-over through `PARK_DIR`.
 */
export const COMMANDS = {
  "follow-ups:file": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...LOOP_ACCOUNTS,
      PR_NUMBER: REQUIRED,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS],
  },
  "review:gate": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      HEAD_SHA: REQUIRED,
      PR_STATE: REQUIRED,
      PR_MERGED: EMPTY,
      HEAD_WAIT_SECONDS: { required: false, default: "60" },
      HEAD_POLL_SECONDS: { required: false, default: "5" },
      REVIEW_TIMEOUT_MINUTES: EMPTY,
      MAX_FIX_ROUNDS: EMPTY,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "gate.json", "refusal_reason.txt"],
  },
  "review:budget": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...LOOP_ACCOUNTS,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
      ROUND,
      FIX_ROUND_BUDGET: REQUIRED,
      LOOP_TOKEN_SOURCE: EMPTY,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "budget.json"],
  },
  "review:collect-checks": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      REVIEWED_SHA: REQUIRED,
      SELF_CHECK: REQUIRED,
      SELF_RUN_ID: EMPTY,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "ci_status.md", "ci_result.txt"],
  },
  "review:red-check-place": REVIEW_RED_CHECK_PLACE,
  "review:red-check-classify": {
    inputs: {
      ...RED_CHECK,
      REPORT_PATH: EMPTY,
      SETUP_OUTCOME: EMPTY,
      EXIT_CODE: EMPTY,
      PLACE_DIR: readsFromCommand("review:red-check-place", REVIEW_RED_CHECK_PLACE, {
        "place.json": "sometimes",
      }),
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "red_check.json"],
  },
  "review:publish": REVIEW_PUBLISH,
  "review:conclude": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...LOOP_IF_MINTED,
      ...LOOP_ACCOUNTS,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      REVIEW_RESULT: REQUIRED,
      PROCEED: EMPTY,
      REFUSAL: EMPTY,
      BLOCKED: EMPTY,
      REVIEWED_SHA: EMPTY,
      VERDICT: EMPTY,
      FIX_ROUND: EMPTY,
      ROUND,
      FAILURE_REASON: EMPTY,
      REFUSAL_REASON: EMPTY,
      TIMED_OUT: EMPTY,
      TIMEOUT_MINUTES: EMPTY,
      MINT_OUTCOME: EMPTY,
      DOWNLOAD_OUTCOME: EMPTY,
      PUBLISH_OUTCOME: EMPTY,
      PUBLISH_DIR: readsFromCommand("review:publish", REVIEW_PUBLISH, {
        "published.json": "sometimes",
        "failure_reason.txt": "sometimes",
      }),
      ...RUN_LINK,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "ended.json", WRITE_LOG],
  },
  "review:advance": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...LOOP_IF_MINTED,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      REVIEW_RESULT: REQUIRED,
      POSTING_RESULT: REQUIRED,
      MOVED: EMPTY,
      REVIEW_URL: EMPTY,
      VERDICT: EMPTY,
      FIX_ROUND: EMPTY,
      ROUND,
      MINT_OUTCOME: EMPTY,
      PARK_DIR: readsFrom("review", {
        "park.json": "sometimes",
        "progress.json": "sometimes",
      }),
      ...RUN_LINK,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
  },
} as const satisfies Readonly<Record<string, CommandContract>>;

export type Command = keyof typeof COMMANDS;
