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
 * **The sandbox the agent runs in** (`docs/platform-spec.md` §3), chosen by the
 * agent driver, `agentSandbox` in `shared/agent.ts`, from these. Every runner
 * starts the agent, so every runner reads them, and an orchestrator that sets
 * none of them gets `none`, which is the Actions orchestrator's.
 *
 * - `AGENT_SANDBOX`: `none` or `bwrap`. Unset or empty is `none`, and any
 *   other value fails the run, naming it, so a typo never runs the agent
 *   unsandboxed. No `docker` or `podman`: in Sandcastle 0.12.0 they are
 *   isolated providers that resume no session, and a runner that extracts a
 *   structured result resumes one.
 * - `AGENT_SANDBOX_RO_BINDS`: host directories, `:`-separated, that `bwrap`
 *   binds read-only at the same path, for the toolchain. Empty is none.
 * - `AGENT_SANDBOX_PATH`: `PATH` inside `bwrap`.
 * - `AGENT_SANDBOX_PROXY`: the proxy every `bwrap` request leaves through,
 *   and the only way out of its network (#461), an `http:` URL with a host.
 *   Optional here, since `none` needs none, but required with `bwrap`:
 *   `agentSandbox` refuses it empty, or `https:` (#535), through
 *   `shared/sandbox.ts`.
 *
 * The last three mean nothing under `none`, where the agent has the runner's
 * own environment and filesystem.
 */
export const SANDBOX = {
  AGENT_SANDBOX: { required: false, default: "none", accepts: ["none", "bwrap"] },
  AGENT_SANDBOX_RO_BINDS: EMPTY,
  AGENT_SANDBOX_PATH: { required: false, default: "/usr/local/bin:/usr/bin:/bin" },
  AGENT_SANDBOX_PROXY: EMPTY,
} as const satisfies Inputs;

/**
 * What a runner that drives the agent reads to start it: the model token, the
 * sandbox it runs in, and the model, resolved in `shared/agent.ts`'s
 * `agentModel` from the runner's own override, then `AGENT_MODEL`, then the
 * baked default. The override's
 * name is computed from the runner's (`update-branch` reads
 * `AGENT_MODEL_UPDATE_BRANCH`), so each runner below names its own, and a test
 * holds the name to the one `agentModel` computes.
 */
const AGENT = {
  CLAUDE_CODE_OAUTH_TOKEN: REQUIRED,
  AGENT_MODEL: EMPTY,
  ...SANDBOX,
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
 *
 * And the files each writes:
 *
 * - `implement-prd`'s `rescue_ignored.json` is the rescue it set aside, as
 *   `fix`'s is: data, which `implement-prd:conclude` writes the note from.
 *   `implement`'s is the same, for `implement:conclude` (#270).
 * - `review`'s `park.json` and `progress.json`, on a PRD PR, are what
 *   `review:advance` parks the chain and writes the progress table from, as
 *   data (ADR 0007): written before the agent runs, and again once the
 *   review knows what it leaves open.
 * - `fix`'s files are what `fix:publish` posts from, as data and raw text
 *   with no marker and no finished comment (ADR 0006, ADR 0007): each thread
 *   outcome's id, status and reply, each conversation outcome's comment id,
 *   status and reply, each top-level comment's text, each out-of-scope note's
 *   fields, the rescue it set aside (`rescue_ignored.json`), and the round
 *   header the comments open with, as plain text (`round_header.txt`), where
 *   the rounds could be read.
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
      RESCUE_BRANCH: REQUIRED,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "rescue_ignored.json"],
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
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "rescue_ignored.json"],
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
      "rescue_ignored.json",
      "round_header.txt",
      "thread_outcomes.json",
      "conversation_outcomes.json",
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
 * never minted: `review:conclude`, `review:advance`, `fix:conclude` and
 * `update-branch:conclude`, since a failed mint is one of the endings each
 * reports (ADR 0004). Empty is "no loop token", and the command makes no write
 * that needs one.
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
 * (#422), whose job runs the pull request's own code, `fix:bundle`
 * (#472), `update-branch:bundle` (#483), `implement:bundle` (#491) and
 * `implement-prd:bundle` (#501), which run after the agent.
 */
export const TOKENLESS = {
  OUTPUT_DIR: EVERY_SUBCOMMAND.OUTPUT_DIR,
} as const satisfies Inputs;

/**
 * `follow-ups:file`, declared ahead of `COMMANDS` so that
 * `follow-ups:conclude` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const FOLLOW_UPS_FILE = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP_ACCOUNTS,
    PR_NUMBER: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
} as const satisfies CommandContract;

/**
 * `fix:bundle`, declared ahead of `COMMANDS` so that `fix:publish` can read
 * its outputs (`readsFromCommand`). See `COMMANDS`.
 */
const FIX_BUNDLE = {
  inputs: {
    ...TOKENLESS,
    CHECKOUT: REQUIRED,
    BRANCH: REQUIRED,
    HEAD_SHA: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "branch.bundle"],
} as const satisfies CommandContract;

/**
 * `fix:prepare`, declared ahead of `COMMANDS` so that `fix:conclude` can read
 * its outputs (`readsFromCommand`). See `COMMANDS`.
 */
const FIX_PREPARE = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    CHECKOUT: REQUIRED,
    RESCUE_BRANCH: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS],
} as const satisfies CommandContract;

/** How a job ended, as Actions' `needs.<job>.result` says it. */
const RESULTS = ["success", "failure", "cancelled", "skipped"] as const satisfies Accepts;

/**
 * `fix:publish`, declared ahead of `COMMANDS` so that `fix:conclude` can read
 * its outputs (`readsFromCommand`). See `COMMANDS`.
 */
const FIX_PUBLISH = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP,
    PR_NUMBER: REQUIRED,
    BRANCH: REQUIRED,
    HEAD_SHA: REQUIRED,
    RESCUE_BRANCH: REQUIRED,
    AGENT_RESULT: { required: true, accepts: RESULTS },
    CHECKOUT: REQUIRED,
    HEAD_WAIT_SECONDS: { required: false, default: "60" },
    HEAD_POLL_SECONDS: { required: false, default: "5" },
    FIX_DIR: readsFrom("fix", {
      "nothing_to_do.txt": "sometimes",
      "rescue_ignored.json": "sometimes",
      "round_header.txt": "sometimes",
      "thread_outcomes.json": "sometimes",
      "conversation_outcomes.json": "sometimes",
      "top_level_comments.json": "sometimes",
      "out_of_scope_notes.json": "sometimes",
    }),
    BUNDLE_DIR: readsFromCommand("fix:bundle", FIX_BUNDLE, {
      "branch.bundle": "sometimes",
    }),
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "published.json", WRITE_LOG],
} as const satisfies CommandContract;

/**
 * `update-branch:bundle`, declared ahead of `COMMANDS` so that
 * `update-branch:publish` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const UPDATE_BRANCH_BUNDLE = {
  inputs: {
    ...TOKENLESS,
    CHECKOUT: REQUIRED,
    BRANCH: REQUIRED,
    HEAD_SHA: REQUIRED,
    BASE_SHA: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "branch.bundle"],
} as const satisfies CommandContract;

/**
 * `update-branch:prepare`, declared ahead of `COMMANDS` so that
 * `update-branch:conclude` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const UPDATE_BRANCH_PREPARE = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    CHECKOUT: REQUIRED,
    BRANCH: REQUIRED,
    BASE_REF: REQUIRED,
    BASE_SHA: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS],
} as const satisfies CommandContract;

/**
 * `update-branch:publish`, declared ahead of `COMMANDS` so that
 * `update-branch:conclude` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const UPDATE_BRANCH_PUBLISH = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP,
    ...LOOP_ACCOUNTS,
    PR_NUMBER: REQUIRED,
    BRANCH: REQUIRED,
    BASE_REF: REQUIRED,
    HEAD_SHA: REQUIRED,
    STATUS: { required: true, accepts: ["uptodate", "clean", "conflicts"] },
    BASE_SHA: REQUIRED,
    AGENT_RESULT: { required: true, accepts: RESULTS },
    CHECKOUT: REQUIRED,
    LOOP_LOGIN: EMPTY,
    HEAD_WAIT_SECONDS: { required: false, default: "60" },
    HEAD_POLL_SECONDS: { required: false, default: "5" },
    UPDATE_BRANCH_DIR: readsFrom("update-branch", {
      "update_comment.md": "sometimes",
    }),
    BUNDLE_DIR: readsFromCommand("update-branch:bundle", UPDATE_BRANCH_BUNDLE, {
      "branch.bundle": "sometimes",
    }),
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "published.json", WRITE_LOG],
} as const satisfies CommandContract;

/**
 * `implement:bundle`, declared ahead of `COMMANDS` so that
 * `implement:publish` and `implement:conclude` can read its outputs
 * (`readsFromCommand`). See `COMMANDS`.
 */
const IMPLEMENT_BUNDLE = {
  inputs: {
    ...TOKENLESS,
    CHECKOUT: REQUIRED,
    BRANCH: REQUIRED,
    BASE_SHA: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "branch.bundle"],
} as const satisfies CommandContract;

/**
 * `implement:prepare`, declared ahead of `COMMANDS` so that
 * `implement:conclude` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const IMPLEMENT_PREPARE = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    CHECKOUT: REQUIRED,
    BRANCH: REQUIRED,
    BASE_REF: REQUIRED,
    BASE_SHA: REQUIRED,
    RESCUE_BRANCH: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS],
} as const satisfies CommandContract;

/**
 * `implement-prd:prepare`. See `COMMANDS`.
 */
const IMPLEMENT_PRD_PREPARE = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    CHECKOUT: REQUIRED,
    PRD_BRANCH: REQUIRED,
    PRD_TIP: EMPTY,
    BASE_SHA: REQUIRED,
    SUB: REQUIRED,
    RESCUE_BRANCH: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS],
} as const satisfies CommandContract;

/**
 * `implement-prd:bundle`, declared ahead of `COMMANDS` so that the publish
 * job's commands can read its outputs (`readsFromCommand`). See `COMMANDS`.
 */
const IMPLEMENT_PRD_BUNDLE = {
  inputs: {
    ...TOKENLESS,
    CHECKOUT: REQUIRED,
    PRD_BRANCH: REQUIRED,
    BASE_SHA: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "branch.bundle"],
} as const satisfies CommandContract;

/**
 * `implement-prd:gate`, declared ahead of `COMMANDS` so that
 * `implement-prd:publish` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const IMPLEMENT_PRD_GATE = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ISSUE_NUMBER: REQUIRED,
    ISSUE_TITLE: REQUIRED,
    ISSUE_STATE: REQUIRED,
    BASE_REF: REQUIRED,
    RUN_URL: REQUIRED,
    GITHUB_SERVER_URL: EMPTY,
  },
  outputs: [
    ...EVERY_SUBCOMMAND_OUTPUTS,
    "gate.json",
    "prd-issue.json",
    WRITE_LOG,
  ],
} as const satisfies CommandContract;

/**
 * `implement-prd:catch-up`, declared ahead of `COMMANDS` so that
 * `implement-prd:conclude` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const IMPLEMENT_PRD_CATCH_UP = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP,
    ISSUE_NUMBER: REQUIRED,
    BASE_REF: REQUIRED,
    PRD_BRANCH: REQUIRED,
    PRD_TIP: EMPTY,
    PRD_PR: EMPTY,
    SUB: REQUIRED,
    CHECKOUT: REQUIRED,
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "catch-up.json", WRITE_LOG],
} as const satisfies CommandContract;

/**
 * `implement-prd:publish`, declared ahead of `COMMANDS` so that the commands
 * after it in the publish job can read its outputs. See `COMMANDS`.
 */
const IMPLEMENT_PRD_PUBLISH = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP,
    ...LOOP_ACCOUNTS,
    ...PULL_REQUEST_LINK,
    ISSUE_NUMBER: REQUIRED,
    ISSUE_TITLE: REQUIRED,
    BASE_REF: REQUIRED,
    PRD_BRANCH: REQUIRED,
    PRD_TIP: EMPTY,
    BUILD: { required: true, accepts: ["true", "false"] },
    FINISHING: { required: true, accepts: ["true", "false"] },
    PRD_PR: EMPTY,
    LANDED: EMPTY,
    RUN_URL: REQUIRED,
    BASE_SHA: EMPTY,
    SUB: EMPTY,
    RESCUE_BRANCH: REQUIRED,
    CHECKOUT: REQUIRED,
    HEAD_WAIT_SECONDS: { required: false, default: "60" },
    HEAD_POLL_SECONDS: { required: false, default: "5" },
    GATE_DIR: readsFromCommand("implement-prd:gate", IMPLEMENT_PRD_GATE, {
      "prd-issue.json": "always",
    }),
    BUNDLE_DIR: readsFromCommand("implement-prd:bundle", IMPLEMENT_PRD_BUNDLE, {
      "branch.bundle": "sometimes",
    }),
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "published.json", WRITE_LOG],
} as const satisfies CommandContract;

/**
 * `implement:publish`, declared ahead of `COMMANDS` so that
 * `implement:conclude` can read its outputs (`readsFromCommand`). See
 * `COMMANDS`.
 */
const IMPLEMENT_PUBLISH = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP,
    ISSUE_NUMBER: REQUIRED,
    ISSUE_TITLE: REQUIRED,
    BASE_REF: REQUIRED,
    BRANCH: REQUIRED,
    BASE_SHA: REQUIRED,
    BRANCH_TIP: EMPTY,
    RESCUE_BRANCH: REQUIRED,
    RUN_URL: REQUIRED,
    CHECKOUT: REQUIRED,
    HEAD_WAIT_SECONDS: { required: false, default: "60" },
    HEAD_POLL_SECONDS: { required: false, default: "5" },
    BUNDLE_DIR: readsFromCommand("implement:bundle", IMPLEMENT_BUNDLE, {
      "branch.bundle": "sometimes",
    }),
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "published.json", WRITE_LOG],
} as const satisfies CommandContract;

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
 * `merge:gate`, declared ahead of `COMMANDS` so that `merge:publish` and
 * `merge:conclude` can read its outputs (`readsFromCommand`). See `COMMANDS`.
 *
 * `CHECK_WAIT_SECONDS` defaults to the review's CI wait, `CI_WAIT_SECONDS` in
 * `review/collect-checks.ts`, which this module cannot import: a test holds
 * the two equal.
 */
const MERGE_GATE = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP,
    ...LOOP_ACCOUNTS,
    LOOP_LOGIN: REQUIRED,
    PR_NUMBER: REQUIRED,
    BASE_REF: REQUIRED,
    ACTION: { required: true, accepts: ["labeled", "synchronize"] },
    SENDER: REQUIRED,
    HEAD_SHA: REQUIRED,
    HEAD_REPO: REQUIRED,
    PR_STATE: REQUIRED,
    PR_MERGED: EMPTY,
    PR_DRAFT: { required: false, default: "false", accepts: ["true", "false"] },
    CHECK_WAIT_SECONDS: { required: false, default: "900" },
    CHECK_POLL_SECONDS: { required: false, default: "20" },
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "gate.json", WRITE_LOG],
} as const satisfies CommandContract;

/**
 * `merge:publish`, declared ahead of `COMMANDS` so that `merge:conclude` can
 * read its outputs (`readsFromCommand`). See `COMMANDS`.
 */
const MERGE_PUBLISH = {
  inputs: {
    ...EVERY_SUBCOMMAND,
    ...LOOP,
    ...LOOP_ACCOUNTS,
    LOOP_LOGIN: REQUIRED,
    PR_NUMBER: REQUIRED,
    BASE_REF: REQUIRED,
    GATE_DIR: readsFromCommand("merge:gate", MERGE_GATE, {
      "gate.json": "always",
    }),
  },
  outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
} as const satisfies CommandContract;

/**
 * Every command, by the subcommand that invokes it, `<workflow>:<step>`: the
 * inputs every subcommand reads, and its own. Its code is `<step>.ts` in the
 * workflow's folder, and exports one function the CLI calls with the inputs
 * declared here.
 *
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
 *   posted, and its round header's data where it has one.
 * - `review:conclude` ends every run, success included: the refusal's note,
 *   the error verdict and the failure comment, the ready mark, `agent:review`
 *   off, and the hand-off after it: `agent:review` again, `agent:fix`, or,
 *   on an approval of a pull request carrying `agent:merge`, that label
 *   re-added with the loop's token (#589). It is told how the review job and the
 *   posting job's steps ended (`REVIEW_RESULT`, and `MINT_OUTCOME`,
 *   `DOWNLOAD_OUTCOME` and `PUBLISH_OUTCOME`, each a step's outcome, empty
 *   where it did not run), and the review job's outputs, and reads what
 *   publish wrote through `PUBLISH_DIR`. `STOP` is which of #200's stops the
 *   runner's verdict row records, and `FIX_ROUND_BUDGET` and
 *   `FIX_ROUNDS_SPENT` are `review:budget`'s, the rounds spent empty where
 *   they could not be counted: what it says no round is starting with
 *   (#425). `ended.json` is whether the head moved while the review ran, and
 *   the posted review's URL.
 * - `fix:gate` refuses or claims the pull request before the agent's job:
 *   a closed or merged one, or one whose `BRANCH` tip cannot be read, is
 *   gone or is not `HEAD_SHA`, is refused on the pull request, and one it
 *   claims has the permission probe, `agent:blocked` off and the wait,
 *   bounded by `POST_WAIT_SECONDS` and polled every `POST_POLL_SECONDS`,
 *   while a review is posting. `HEAD_SHA`, `PR_STATE` and `PR_MERGED` are
 *   the pull request as the label's event saw it. It declares no loop token:
 *   every write it makes is the workflow token's. `gate.json` is its
 *   decision, `proceed`, written as soon as it decides and however it ends, and absent where it died
 *   before deciding.
 * - `fix:prepare` fetches `RESCUE_BRANCH`, where an earlier stopped run left
 *   one, into `CHECKOUT` as `refs/rescue/<RESCUE_BRANCH>`, for the runner to
 *   resume from, and fetches nothing where there is none. A tip it cannot
 *   read stops the run rather than reading as no rescue. It reads with
 *   `GH_TOKEN` and writes nothing to the record.
 * - `fix:bundle` bundles the commits on `BRANCH`, in `CHECKOUT`, ahead of
 *   `HEAD_SHA`, the head the run started from as the label's event saw it,
 *   into `branch.bundle`, and writes nothing where there are none. It reads
 *   no repository and is handed no token.
 * - `fix:publish` posts a fix round from the runner's hand-over, read through
 *   `FIX_DIR`, and pushes the bundle `fix:bundle` wrote, read through
 *   `BUNDLE_DIR` and checked in `CHECKOUT` against `HEAD_SHA`, the head the
 *   run started from as the label's event saw it, never a file the agent's
 *   job wrote. `AGENT_RESULT` is how the agent's job ended: on any ending but
 *   `success` it says only that the rescue was set aside, where the runner
 *   set one aside, since the rest is `fix:conclude`'s. `HEAD_WAIT_SECONDS`
 *   and `HEAD_POLL_SECONDS` bound the wait for the pull request to show the
 *   pushed head before the re-review is asked for. `published.json` is
 *   whether it pushed, the pushed head, whether a note went up and whether
 *   there was nothing to do, and whether the rescue-set-aside note went up,
 *   written as each becomes true.
 * - `fix:conclude` ends every fix run, success included: a stopped run's
 *   commits rescued to `RESCUE_BRANCH` where nothing was pushed, the
 *   failure comment, `agent:fix` off and `agent:blocked`. It is told how the
 *   gate and the agent's job ended (`REFUSED`, `GATE_RESULT`, the gate's
 *   reason where it failed after claiming the run, `GATE_REASON`,
 *   `AGENT_RESULT`), whether the agent's job ran out of time (`TIMED_OUT`,
 *   `TIMEOUT_MINUTES`), and the publish job's steps' outcomes
 *   (`MINT_OUTCOME`, `DOWNLOAD_OUTCOME`, `PUBLISH_OUTCOME`), and reads what
 *   each producer left from its own directory: `fix:publish`'s through
 *   `PUBLISH_DIR`, `fix:prepare`'s reason through `PREPARE_DIR`, the
 *   runner's reason and set-aside rescue through `FIX_DIR`, and
 *   `fix:bundle`'s bundle and reason through `BUNDLE_DIR`,
 *   checked in `CHECKOUT` against `HEAD_SHA` before it is rescued.
 * - `follow-ups:conclude` ends every filing run, success included: nothing
 *   on `success`, and otherwise the one failure comment, with the time limit
 *   where `TIMED_OUT` is `true`, a cancel, or the reason `follow-ups:file`
 *   left in `FILE_DIR`. It never takes `agent:follow-ups` off, which is the
 *   retry, and never adds `agent:blocked`.
 * - `implement:gate` refuses, defers or claims the issue before any
 *   checkout. An issue with sub-issues is `implement-prd`'s and is deferred
 *   without a write; a closed one, a `wayfinder:*` one, a sub-issue, one
 *   with open blockers and one an open pull request already closes are
 *   refused on the issue, in that order. `ISSUE_STATE` is the issue as the
 *   label's event saw it; its shape, its blockers and the open pull requests
 *   it reads itself. One it claims has the permission probe, `agent:blocked`
 *   off and the start comment linking `RUN_URL`, and then its branch, named
 *   from `ISSUE_NUMBER` and `ISSUE_TITLE`, the commit `BASE_REF` is at, and
 *   the branch's current tip, empty where it does not exist. It declares no
 *   loop token. `gate.json` is its decision, `proceed`, written as soon as it
 *   decides and however it ends, with `branch`, `base` and `tip` once read.
 * - `implement-prd:gate` refuses, defers or claims a PRD parent before any
 *   checkout, and decides what the run does: build the next slice, only
 *   open a missing PRD PR, or hand a finished one over. An issue with no
 *   sub-issues is `implement`'s and is deferred without a write. It reads
 *   the shape, the sub-issues, the PRD branch by its stem, the old slice PRs
 *   into it, the commits it has over `BASE_REF`, the PRD PR, its head's
 *   verdict and, on a first build, every sub-issue's links, and the parent's
 *   blockers; `ISSUE_STATE` is the parent as the label's event saw it, and
 *   `ISSUE_TITLE` names a PRD branch that does not exist yet. One it claims
 *   has the permission probe, `agent:blocked` off and the start comments,
 *   the sub-issue's linking `RUN_URL`; past an approval, the note on the
 *   approved slice, linking its head under `GITHUB_SERVER_URL`; and on a
 *   build with a PRD PR, the slice building in its progress list. It
 *   declares no loop token. `gate.json` is its decision, `proceed`, written
 *   as soon as it decides and however it ends, with the decision and its
 *   facts beside it on a run it claims; `prd-issue.json` is the parent's
 *   snapshot, which the publish job writes the PRD PR's `Closes` lines and
 *   its progress list from.
 * - `implement-prd:catch-up` brings the PRD branch up to date with
 *   `BASE_REF` before a slice is built, in `CHECKOUT`, as the loop's
 *   committer: `PRD_BRANCH` fetched at its tip, or, where `PRD_TIP`, the tip
 *   the gate read, is empty, made at the base, and the base merged in with
 *   the `Agent-Catch-Up` trailer naming `SUB`. A clean merge is pushed with
 *   the loop's token, leased on `PRD_TIP`; a conflicting one parks the chain
 *   with a comment on the parent, `ISSUE_NUMBER`, naming `agent:update-branch`
 *   on `PRD_PR` where there is one, and takes `agent:implement` off.
 *   `catch-up.json` is whether it parked, the merge it pushed, where it
 *   pushed one, and the tip it left the branch at, where it did not park.
 * - `implement-prd:prepare` checks the PRD branch out in `CHECKOUT` for the
 *   agent: `PRD_BRANCH`, fetched with `GH_TOKEN` where `PRD_TIP`, the tip the
 *   gate read, says it exists, at `BASE_SHA`, the tip `implement-prd:catch-up`
 *   left it at, with the loop's committer as the checkout's identity. Then
 *   `RESCUE_BRANCH`, where an earlier stopped run left one, fetched as
 *   `refs/rescue/<RESCUE_BRANCH>`, as `fix:prepare` fetches it: a tip it
 *   cannot read stops the run rather than reading as no rescue. `SUB` is the
 *   sub-issue the run builds, named in its log. It writes nothing to the
 *   record.
 * - `implement-prd:bundle` bundles the commits on `PRD_BRANCH`, in
 *   `CHECKOUT`, ahead of `BASE_SHA`, the tip `implement-prd:catch-up` left,
 *   into `branch.bundle`, and writes nothing where there are none, as
 *   `fix:bundle` bundles. It reads no repository and is handed no token.
 * - `implement-prd:publish` checks the bundle `implement-prd:bundle` wrote,
 *   read through `BUNDLE_DIR`, in `CHECKOUT`: there, intact, holding exactly
 *   `PRD_BRANCH`, and building on `BASE_SHA`, the tip
 *   `implement-prd:catch-up` left. Then it marks the slice's commits, those
 *   in the bundle's head and in neither `BASE_SHA` nor `BASE_REF` as fetched
 *   with `GH_TOKEN`, with the `Agent-Slice` trailer naming `SUB`, refusing
 *   where there are none; pushes the marked head to `PRD_BRANCH` with the
 *   loop's token, leased on `BASE_SHA`, or on the branch not existing where
 *   `PRD_TIP` is empty; and deletes `RESCUE_BRANCH`, leased on its tip as
 *   read, tolerated. `published.json` is whether it pushed, and the head.
 *   On the finishing run, `FINISHING` `true`, it builds and pushes nothing
 *   and hands `PRD_PR` over instead: marked ready where `LANDED` is one
 *   slice, or its final review asked for, refused where the loop's token is
 *   the workflow token. `published.json` says whether it handed over.
 * - `implement-prd:conclude` ends every run the gate did not refuse or
 *   defer, success included, as `fix:conclude` does: the rescue the runner
 *   set aside, said on `ISSUE_NUMBER`; where the run stopped with nothing
 *   pushed to `PRD_BRANCH`, `implement-prd:bundle`'s bundle, checked in
 *   `CHECKOUT` against `BASE_SHA`, pushed to `RESCUE_BRANCH` with the loop's
 *   token, leased on its tip as read; the failure comment, linking `RUN_URL`,
 *   naming `SUB` or the hand-over `FINISHING` says it was, with the retry the
 *   ending calls for; `agent:implement` off wherever the gate decided
 *   (`REFUSED` `false`); `agent:blocked` where it stopped; and, on a build
 *   that did not finish, the stopped slice's row in the progress list of the
 *   PRD PR, `published.json`'s or `PRD_PR`, rendered from `PRD_BRANCH`'s
 *   trailers over `BASE_REF` as fetched, the gate's snapshot of the
 *   sub-issues and the PRD PR's rounds, with the current slice parked where
 *   this run pushed its slice or `MERGED`, the catch-up's merge, and
 *   approved otherwise. It is told how the gate, the catch-up and the
 *   agent's job ended, the gate's decision and reason, whether the agent's
 *   job ran out of time and its limit, and the outcome of the mint, the
 *   download and publish, and reads each producer's files from its own
 *   directory, one file at a time.
 * - `implement:prepare` creates the agent's `BRANCH` in `CHECKOUT` at
 *   `BASE_SHA`, the commit the gate read `BASE_REF` at, and checks it out,
 *   with the loop's committer as the checkout's identity. A checkout that
 *   does not hold `BASE_SHA` is refused. Then it fetches `RESCUE_BRANCH`,
 *   where an earlier stopped run left one, as `refs/rescue/<RESCUE_BRANCH>`,
 *   as `fix:prepare` fetches it (#270): a tip it cannot read stops the run
 *   rather than reading as no rescue. It reads with the workflow token and
 *   writes nothing to the record.
 * - `implement:bundle` bundles the agent's commits on `BRANCH`, in
 *   `CHECKOUT`, ahead of `BASE_SHA`, the gate's base commit, into
 *   `branch.bundle`, however the agent ended (#270). No commits, or no
 *   branch, is no bundle. It reads no repository and is handed no token.
 * - `implement:publish` checks the bundle `implement:bundle` wrote, read
 *   through `BUNDLE_DIR`, in `CHECKOUT`: there, intact, holding exactly
 *   `BRANCH`, and building on `BASE_SHA`, the gate's base commit. Then it
 *   pushes it with the loop's token, leased on `BRANCH_TIP`, the gate's tip,
 *   or on the branch not existing where that is empty; opens the draft pull
 *   request from `BRANCH` into `BASE_REF`, titled from `ISSUE_NUMBER` and
 *   `ISSUE_TITLE`, its frame linking `RUN_URL`, reading it back on a server
 *   error; links it on the issue; waits, bounded by `HEAD_WAIT_SECONDS` and
 *   polled every `HEAD_POLL_SECONDS`, for it to show the pushed head; and
 *   takes `agent:implement` off and puts `agent:review` on, removed first,
 *   with the loop's token. Once the pull request is open it deletes
 *   `RESCUE_BRANCH`, leased on its tip as read (#270). `published.json` is whether it pushed, the
 *   pushed head, the pull request's number and whether the review was
 *   requested, written as each becomes true.
 * - `review:advance` moves a PRD PR's chain on after a review, or parks it:
 *   the progress table and status line for how the round ended, then
 *   `agent:implement` back on the parent on a slice round's approval, or the
 *   park comment on it on any ending but an approval or a fix round
 *   starting. It is told how the review job and the posting job ended
 *   (`REVIEW_RESULT`, `POSTING_RESULT`), the review job's outputs, the
 *   posting job's (`MOVED`, `REVIEW_URL`) and the mint's outcome, and reads
 *   the runner's park hand-over through `PARK_DIR`.
 * - `merge:gate` decides an `agent:merge` run (#588) from the record and
 *   the event's facts: `ACTION`, `labeled` or `synchronize` (#589), `SENDER`,
 *   the label's sender or the pusher, `HEAD_SHA`, the payload's head, `PR_STATE`, `PR_MERGED`, `PR_DRAFT`, `HEAD_REPO`, the
 *   head's repository, and `BASE_REF`. A closed pull request, a draft, a fork,
 *   `LOOP_TOKEN_SOURCE` `workflow`, and a sender who can neither write nor is
 *   `LOOP_LOGIN`, the loop token's account, are refused on the pull request,
 *   `agent:merge` off. A writer's label arms the payload's head, posting
 *   `agent-merge` with the loop's token, or disarms where the live head moved;
 *   a push, or the loop's own label, arms nothing. A head with no arm
 *   disarms, but waits while `agent:update-branch` is on. A behind head gets
 *   `agent:update-branch` with the loop's token, or is disarmed after its
 *   arm's third clean refresh. A refusal, a disarm or the first red of a head
 *   asks for the next armed pull request's refresh, as `merge:publish` does
 *   after a merge (#590).
 *   Then it waits, bounded by `CHECK_WAIT_SECONDS` and polled every
 *   `CHECK_POLL_SECONDS`, while a required check or the verdict is pending or
 *   another trigger label is on. It reads the labeller's permission with the
 *   loop's token, and an arm only where `LOOP_LOGIN` posted it.
 *   `AGENT_LOOP_LOGINS` is whose verdicts and comments it reads. `gate.json`
 *   is its decision, `merge`, `wait`, `behind`, `red`, `disarmed` or
 *   `refused`, and the head it checked, written as soon as it decides and
 *   however it ends.
 * - `merge:publish` squash-merges the pull request on `merge`, the gate's
 *   decision read through `GATE_DIR`, guarded on the head the gate checked,
 *   titled with the pull request's title and ` (#<n>)`, with the loop's
 *   token, and then takes `agent:merge` off. Then (#590) it asks for
 *   `agent:update-branch`, with the loop's token, on the next armed pull
 *   request into `BASE_REF`: the oldest arm by `LOOP_LOGIN` that is behind,
 *   not red by the verdicts of `AGENT_LOOP_LOGINS`, and has no trigger label
 *   on. On any other decision it does nothing.
 * - `merge:conclude` ends every merge run: on one that stopped
 *   (`JOB_STATUS` `failure` or `cancelled`), the failure comment, with the
 *   time limit where `TIMED_OUT` is `true`, a cancel, the mint's failure
 *   (`MINT_OUTCOME`), or the reason `merge:publish` or `merge:gate` left in
 *   `PUBLISH_DIR` or `GATE_DIR`; then `agent:merge` off and `agent:blocked`.
 *   On a run that finished, nothing.
 * - `update-branch:gate` refuses or claims the pull request before the
 *   checkout: a closed or merged one is refused on the pull request, and one
 *   it claims has the permission probe, `agent:blocked` off and the wait,
 *   bounded by `POST_WAIT_SECONDS` and polled every `POST_POLL_SECONDS`,
 *   while a review is posting. `PR_STATE` and `PR_MERGED` are the pull
 *   request as the label's event saw it, and `BRANCH` its head branch. It
 *   declares no loop token, and reads no branch tip: it adds no refusal the
 *   shell pre-flight it replaced lacked. `gate.json` is its decision,
 *   `proceed`, as `fix:gate`'s is.
 * - `update-branch:merge` fetches `BASE_REF` and merges it into `BRANCH`, the
 *   commit checked out in `CHECKOUT`, as the loop's committer, and writes
 *   nothing to the record. `merge.json` is what it came to: `status`,
 *   `uptodate`, `clean` or `conflicts`; `base`, the base commit it fetched;
 *   and `conflicts`, the conflicted paths, empty but on a conflict.
 * - `update-branch:prepare` makes the gate's merge again in the agent's job,
 *   so the runner starts from the conflicted tree the gate found: it fetches
 *   `BASE_REF` into `CHECKOUT` and merges `BASE_SHA`, the base commit the
 *   gate merged, into `BRANCH`, as the loop's committer. It refuses where the
 *   base no longer holds `BASE_SHA` and where the merge does not conflict,
 *   and writes nothing to the record.
 * - `update-branch:bundle` bundles the agent's resolution on `BRANCH`, in
 *   `CHECKOUT`, ahead of `HEAD_SHA`, the head the run started from, and
 *   `BASE_SHA`, the base commit the gate merged, into `branch.bundle`, as
 *   `fix:bundle` bundles. Where there is nothing to bundle it refuses: a run
 *   that resolved the conflicts committed a merge. It reads no repository and
 *   is handed no token.
 * - `update-branch:publish` pushes what the merge came to, `STATUS`, the
 *   gate's: nothing where the branch was `uptodate`; on `clean`, the merge of
 *   `BASE_SHA`, the base commit the gate merged, made again in `CHECKOUT` as
 *   the loop's committer, and the verdict standing on `HEAD_SHA` copied on to
 *   it; on `conflicts`, the resolution `update-branch:bundle` wrote, read
 *   through `BUNDLE_DIR` and checked in `CHECKOUT` against `HEAD_SHA` and
 *   `BASE_SHA`. Each push is leased on `HEAD_SHA`, the head the run started
 *   from as the label's event saw it. Then the comment, the runner's
 *   `update_comment.md` on a resolution, read through `UPDATE_BRANCH_DIR`,
 *   and on a resolution the review of it, asked for once the pull request
 *   shows the pushed head, bounded by `HEAD_WAIT_SECONDS` and polled every
 *   `HEAD_POLL_SECONDS`. `AGENT_RESULT` is how the agent's job ended: on a
 *   conflict it does nothing on any ending but `success`, since the rest is
 *   `update-branch:conclude`'s. `AGENT_LOOP_LOGINS` is whose verdicts it
 *   copies. On a clean merge it also copies the arm (#589), the newest
 *   `agent-merge` `LOOP_LOGIN` posted on `HEAD_SHA`, its refresh count one
 *   higher, with the loop's token; with `LOOP_LOGIN` empty or
 *   `LOOP_TOKEN_SOURCE` `workflow` it copies none, and says so. `published.json` is whether it pushed, the pushed head and
 *   whether it asked for the review, written as each becomes true.
 * - `update-branch:conclude` ends every update-branch run, success included:
 *   the failure comment, `agent:update-branch` off and `agent:blocked` where
 *   the run stopped, and where it finished and the head moved on from the
 *   one it left, `agent:update-branch` asked for again; and where it
 *   finished on a pull request carrying `agent:merge`, that label re-added
 *   with the loop's token, so the gate rules on the head it left (#589). It is told how the
 *   gate and the agent's job ended (`REFUSED`, `GATE_RESULT`, the gate's
 *   reason where it failed after claiming the run, `GATE_REASON`, `STATUS`,
 *   what the gate's merge came to, `AGENT_RESULT`), whether the agent's job
 *   ran out of time (`TIMED_OUT`, `TIMEOUT_MINUTES`), and the publish job's
 *   steps' outcomes (`MINT_OUTCOME`, `DOWNLOAD_OUTCOME`, `PUBLISH_OUTCOME`),
 *   and reads what each producer left from its own directory:
 *   `update-branch:publish`'s through `PUBLISH_DIR`,
 *   `update-branch:prepare`'s reason through `PREPARE_DIR`, the runner's
 *   through `UPDATE_BRANCH_DIR`, and `update-branch:bundle`'s through
 *   `BUNDLE_DIR`. `HEAD_SHA` is the head the run started from, as the
 *   label's event saw it: the head it left where it pushed nothing.
 */
export const COMMANDS = {
  "fix:gate": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      HEAD_SHA: REQUIRED,
      PR_STATE: REQUIRED,
      PR_MERGED: EMPTY,
      POST_WAIT_SECONDS: { required: false, default: "600" },
      POST_POLL_SECONDS: { required: false, default: "10" },
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "gate.json", WRITE_LOG],
  },
  "fix:prepare": FIX_PREPARE,
  "fix:bundle": FIX_BUNDLE,
  "fix:publish": FIX_PUBLISH,
  "fix:conclude": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...LOOP_IF_MINTED,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      HEAD_SHA: REQUIRED,
      RESCUE_BRANCH: REQUIRED,
      CHECKOUT: REQUIRED,
      REFUSED: { required: false, default: "", accepts: ["true", "false"] },
      GATE_RESULT: { required: true, accepts: RESULTS },
      GATE_REASON: EMPTY,
      AGENT_RESULT: { required: true, accepts: RESULTS },
      TIMED_OUT: EMPTY,
      TIMEOUT_MINUTES: EMPTY,
      MINT_OUTCOME: EMPTY,
      DOWNLOAD_OUTCOME: EMPTY,
      PUBLISH_OUTCOME: EMPTY,
      PUBLISH_DIR: readsFromCommand("fix:publish", FIX_PUBLISH, {
        "published.json": "sometimes",
        "failure_reason.txt": "sometimes",
      }),
      PREPARE_DIR: readsFromCommand("fix:prepare", FIX_PREPARE, {
        "failure_reason.txt": "sometimes",
      }),
      FIX_DIR: readsFrom("fix", {
        "failure_reason.txt": "sometimes",
        "rescue_ignored.json": "sometimes",
      }),
      BUNDLE_DIR: readsFromCommand("fix:bundle", FIX_BUNDLE, {
        "branch.bundle": "sometimes",
        "failure_reason.txt": "sometimes",
      }),
      ...RUN_LINK,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
  },
  "follow-ups:file": FOLLOW_UPS_FILE,
  "follow-ups:conclude": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      PR_NUMBER: REQUIRED,
      RUN_URL: REQUIRED,
      JOB_STATUS: { required: true, accepts: ["success", "failure", "cancelled"] },
      TIMED_OUT: EMPTY,
      TIMEOUT_MINUTES: EMPTY,
      FILE_DIR: readsFromCommand("follow-ups:file", FOLLOW_UPS_FILE, {
        "failure_reason.txt": "sometimes",
      }),
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
  },
  "implement:gate": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ISSUE_NUMBER: REQUIRED,
      ISSUE_TITLE: REQUIRED,
      ISSUE_STATE: REQUIRED,
      BASE_REF: REQUIRED,
      RUN_URL: REQUIRED,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "gate.json", WRITE_LOG],
  },
  "implement:prepare": IMPLEMENT_PREPARE,
  "implement:bundle": IMPLEMENT_BUNDLE,
  "implement:publish": IMPLEMENT_PUBLISH,
  "implement:conclude": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...LOOP_IF_MINTED,
      ISSUE_NUMBER: REQUIRED,
      BASE_REF: REQUIRED,
      RUN_URL: REQUIRED,
      RESCUE_BRANCH: REQUIRED,
      CHECKOUT: REQUIRED,
      BRANCH: EMPTY,
      BASE_SHA: EMPTY,
      REFUSED: { required: false, default: "", accepts: ["true", "false"] },
      GATE_RESULT: { required: true, accepts: RESULTS },
      GATE_REASON: EMPTY,
      AGENT_RESULT: { required: true, accepts: RESULTS },
      TIMED_OUT: EMPTY,
      TIMEOUT_MINUTES: EMPTY,
      MINT_OUTCOME: EMPTY,
      DOWNLOAD_OUTCOME: EMPTY,
      PUBLISH_OUTCOME: EMPTY,
      BUNDLE_OUTCOME: EMPTY,
      PUBLISH_DIR: readsFromCommand("implement:publish", IMPLEMENT_PUBLISH, {
        "published.json": "sometimes",
        "failure_reason.txt": "sometimes",
      }),
      PREPARE_DIR: readsFromCommand("implement:prepare", IMPLEMENT_PREPARE, {
        "failure_reason.txt": "sometimes",
      }),
      IMPLEMENT_DIR: readsFrom("implement", {
        "failure_reason.txt": "sometimes",
        "rescue_ignored.json": "sometimes",
      }),
      BUNDLE_DIR: readsFromCommand("implement:bundle", IMPLEMENT_BUNDLE, {
        "branch.bundle": "sometimes",
        "failure_reason.txt": "sometimes",
      }),
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
  },
  "implement-prd:gate": IMPLEMENT_PRD_GATE,
  "implement-prd:prepare": IMPLEMENT_PRD_PREPARE,
  "implement-prd:bundle": IMPLEMENT_PRD_BUNDLE,
  "implement-prd:publish": IMPLEMENT_PRD_PUBLISH,
  "implement-prd:conclude": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...LOOP_IF_MINTED,
      ...LOOP_ACCOUNTS,
      ...PULL_REQUEST_LINK,
      ISSUE_NUMBER: REQUIRED,
      BASE_REF: REQUIRED,
      RUN_URL: REQUIRED,
      RESCUE_BRANCH: REQUIRED,
      CHECKOUT: REQUIRED,
      REFUSED: { required: false, default: "", accepts: ["true", "false"] },
      BUILD: { required: false, default: "", accepts: ["true", "false"] },
      FINISHING: { required: false, default: "", accepts: ["true", "false"] },
      PRD_BRANCH: EMPTY,
      PRD_PR: EMPTY,
      SUB: EMPTY,
      BASE_SHA: EMPTY,
      MERGED: EMPTY,
      GATE_RESULT: { required: true, accepts: RESULTS },
      GATE_REASON: EMPTY,
      CATCH_UP_RESULT: { required: true, accepts: RESULTS },
      AGENT_RESULT: { required: true, accepts: RESULTS },
      TIMED_OUT: EMPTY,
      TIMEOUT_MINUTES: EMPTY,
      MINT_OUTCOME: EMPTY,
      DOWNLOAD_OUTCOME: EMPTY,
      PUBLISH_OUTCOME: EMPTY,
      GATE_DIR: readsFromCommand("implement-prd:gate", IMPLEMENT_PRD_GATE, {
        "prd-issue.json": "sometimes",
      }),
      CATCH_UP_DIR: readsFromCommand("implement-prd:catch-up", IMPLEMENT_PRD_CATCH_UP, {
        "failure_reason.txt": "sometimes",
      }),
      PREPARE_DIR: readsFromCommand("implement-prd:prepare", IMPLEMENT_PRD_PREPARE, {
        "failure_reason.txt": "sometimes",
      }),
      IMPLEMENT_PRD_DIR: readsFrom("implement-prd", {
        "failure_reason.txt": "sometimes",
        "rescue_ignored.json": "sometimes",
      }),
      BUNDLE_DIR: readsFromCommand("implement-prd:bundle", IMPLEMENT_PRD_BUNDLE, {
        "branch.bundle": "sometimes",
        "failure_reason.txt": "sometimes",
      }),
      PUBLISH_DIR: readsFromCommand("implement-prd:publish", IMPLEMENT_PRD_PUBLISH, {
        "published.json": "sometimes",
        "failure_reason.txt": "sometimes",
      }),
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
  },
  "implement-prd:catch-up": IMPLEMENT_PRD_CATCH_UP,
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
      STOP: { required: false, default: "", accepts: ["budget spent", "no progress"] },
      FIX_ROUND_BUDGET: EMPTY,
      FIX_ROUNDS_SPENT: EMPTY,
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
  "merge:gate": MERGE_GATE,
  "merge:publish": MERGE_PUBLISH,
  "merge:conclude": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      PR_NUMBER: REQUIRED,
      JOB_STATUS: { required: true, accepts: ["success", "failure", "cancelled"] },
      TIMED_OUT: EMPTY,
      TIMEOUT_MINUTES: EMPTY,
      MINT_OUTCOME: EMPTY,
      GATE_DIR: readsFromCommand("merge:gate", MERGE_GATE, {
        "failure_reason.txt": "sometimes",
      }),
      PUBLISH_DIR: readsFromCommand("merge:publish", MERGE_PUBLISH, {
        "failure_reason.txt": "sometimes",
      }),
      ...RUN_LINK,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
  },
  "update-branch:gate": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      PR_NUMBER: REQUIRED,
      BRANCH: REQUIRED,
      PR_STATE: REQUIRED,
      PR_MERGED: EMPTY,
      POST_WAIT_SECONDS: { required: false, default: "600" },
      POST_POLL_SECONDS: { required: false, default: "10" },
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "gate.json", WRITE_LOG],
  },
  "update-branch:merge": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      CHECKOUT: REQUIRED,
      BRANCH: REQUIRED,
      BASE_REF: REQUIRED,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, "merge.json"],
  },
  "update-branch:prepare": UPDATE_BRANCH_PREPARE,
  "update-branch:bundle": UPDATE_BRANCH_BUNDLE,
  "update-branch:publish": UPDATE_BRANCH_PUBLISH,
  "update-branch:conclude": {
    inputs: {
      ...EVERY_SUBCOMMAND,
      ...LOOP_IF_MINTED,
      PR_NUMBER: REQUIRED,
      HEAD_SHA: REQUIRED,
      REFUSED: { required: false, default: "", accepts: ["true", "false"] },
      GATE_RESULT: { required: true, accepts: RESULTS },
      GATE_REASON: EMPTY,
      STATUS: { required: false, default: "", accepts: ["uptodate", "clean", "conflicts"] },
      AGENT_RESULT: { required: true, accepts: RESULTS },
      TIMED_OUT: EMPTY,
      TIMEOUT_MINUTES: EMPTY,
      MINT_OUTCOME: EMPTY,
      DOWNLOAD_OUTCOME: EMPTY,
      PUBLISH_OUTCOME: EMPTY,
      PUBLISH_DIR: readsFromCommand("update-branch:publish", UPDATE_BRANCH_PUBLISH, {
        "published.json": "sometimes",
        "failure_reason.txt": "sometimes",
      }),
      PREPARE_DIR: readsFromCommand("update-branch:prepare", UPDATE_BRANCH_PREPARE, {
        "failure_reason.txt": "sometimes",
      }),
      UPDATE_BRANCH_DIR: readsFrom("update-branch", {
        "failure_reason.txt": "sometimes",
      }),
      BUNDLE_DIR: readsFromCommand("update-branch:bundle", UPDATE_BRANCH_BUNDLE, {
        "failure_reason.txt": "sometimes",
      }),
      ...RUN_LINK,
    },
    outputs: [...EVERY_SUBCOMMAND_OUTPUTS, WRITE_LOG],
  },
} as const satisfies Readonly<Record<string, CommandContract>>;

export type Command = keyof typeof COMMANDS;
