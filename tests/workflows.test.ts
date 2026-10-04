import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isWorkflowBot } from "../shared/common.js";
import {
  ADD_REVIEW_MUTATION,
  FIX_BEFORE_MERGE_LABEL,
  type Finding,
  type PlacedFinding,
  PREVIOUSLY_MISSED_LABEL,
  SEVERITIES,
  severityAssetPath,
  severityBadge,
  severityWord,
} from "../shared/review-findings.js";
import {
  CLOSER_LOOK,
  deriveVerdict,
  FIX_ROUND_STATUS,
  FOLLOW_UPS_LABEL,
  LEGACY_FIX_ROUND_STARTED,
  renderReviewBody,
  type Verdict,
  VERDICT_CONTEXT,
  VERDICTS,
} from "../shared/review-output.js";
import { REVIEW_URL_SLOT } from "../shared/prd-round.js";
import { rescueRef } from "../shared/rescue.js";
import {
  FINAL_REVIEW_MARK,
  finalReviewRequestedLines,
  OPENING_STATUS,
  renderPrdStatus,
  STATUS_END,
  STATUS_START,
  statusBlock,
  PROGRESS_END,
  PROGRESS_START,
} from "../shared/progress-list.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Guards `.github/workflows/**` against a failure class nothing else here
 * catches. `npm run verify` typechecks and runs tests; it never parses the
 * workflow files. So an invalid one reaches `main` with every check green and
 * then fails at *startup* — zero jobs, no log, and the run surfaces only under
 * `push` events the workflow was never meant to handle.
 *
 * The fix workflow was down that way for two days. The trigger was a comment
 * *about* expression interpolation that contained a literal empty expression.
 *
 * The rule being encoded: **GitHub evaluates `${{ … }}` everywhere except YAML
 * comments** — including inside a `run:` block, where a `#` line is a comment
 * to bash but still an expression host to GitHub. That is the whole distinction
 * between the harmless note in `agent-review-reusable.yml` and the fatal one it
 * was written about, which sat in the fix workflow's base-fetch step.
 */

const WORKFLOW_DIR = ".github/workflows";

/**
 * The reference callers, shipped as files rather than as a code block in
 * `docs/ADOPTING.md`. Two reasons, and the second is why they are under test.
 *
 * An adopter copies a file instead of transcribing a fenced block, so the thing
 * they install is the thing that was checked. And the caller/reusable coupling
 * — above all `self-check`, whose value is `<caller job id> / <called job id>`
 * and which has no runtime error when wrong — needs *both* halves present to be
 * asserted at all. Before these existed the reusable half lived here and the
 * caller half lived in whichever repo had adopted the loop, so the pair could
 * only be verified by hand, in a repo this one cannot see.
 */
const CALLER_DIR = "examples/callers";

/**
 * The version the reference callers pin. Read from the manifest rather than
 * written twice: a caller left on a stale pin is an adopter running last
 * release's runners against this release's docs.
 */
const PIN = `v${(JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }).version}`;

/**
 * The three PR workflows that act on a PR's branch. Every one of them has to
 * work against the PR's *real* base, not a hardcoded `main`
 * (jeffwlawson/winget-manifest-lint#71, jeffwlawson/winget-manifest-lint#100).
 *
 * All three are named by their **reusable** half: the guards, the env and every
 * step live there, and each caller is a trigger and two wires
 * (jeffwlawson/winget-manifest-lint#97 for review,
 * jeffwlawson/winget-manifest-lint#98 for the rest). A check aimed at a caller
 * would pass by reading a file that no longer contains the thing it is checking
 * — which is the coverage failure this whole file exists to catch, one level
 * up.
 */
const PR_WORKFLOWS = [
  "review.yml",
  "fix.yml",
  "update-branch.yml",
].map((f) => path.join(WORKFLOW_DIR, f));

/**
 * The fourth `pull_request_target` reusable, which is in none of the sets above
 * and gets its own describe at the bottom of this file (#50).
 *
 * It files a **closed** pull request's recorded findings, so five of the shared
 * set's assertions are false of it — no base ref, no state environment, an
 * *inverted* closed-PR guard, no checkout, no label transition, and two
 * of those assert that a checkout step and a transition step *exist*, which
 * the set's exemption idiom cannot express. Keeping it in would also make the
 * set's own premise ("every one of them has to work against the PR's real
 * base") false the moment a member has no base ref at all.
 *
 * Named as a set of one rather than as a lone constant because the partition
 * test below is what makes leaving the shared set safe: a seventh
 * `pull_request_target` reusable in neither set is a named failure there rather
 * than a workflow that quietly gets no assertions.
 */
const FOLLOW_UPS = path.join(WORKFLOW_DIR, "follow-ups.yml");
const MERGE_GATED: readonly string[] = [FOLLOW_UPS];

const workflowFiles = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => path.join(WORKFLOW_DIR, f));

/**
 * Everything committed under `.sandcastle/`, found by walking rather than by
 * listing: the point of the checks below is to hold a *file added later* to the
 * same rule, and a hand-maintained list is precisely what a new prompt would not
 * be added to.
 *
 * Three directory names are skipped, all gitignored and none authored here:
 * `output/` is scratch written by a local run (`shared/common.ts`'s
 * `outputDir()`), `dist/` is the compiled package a local build leaves behind —
 * checking it would test `tsc`'s copy of a file already checked — and
 * `node_modules/` is somebody else's source entirely. The last is latent today,
 * since the package's build resolves `tsc` from the hoisted root install and
 * nothing has ever run `npm install` in that prefix; the day something does, the
 * de-domain and gate-command greps below would walk the whole dependency tree
 * and fail on a stranger's word. `copy-assets.ts` — the walker over this same
 * tree, written in this same slice — already skips all three.
 */
const SKIPPED_DIRS = new Set(["output", "dist", "node_modules", ".git"]);

/**
 * The runner surface: the code and prompts that reach an adopter, which is what
 * the de-domain and gate-command checks below are actually about.
 *
 * Named explicitly rather than "the repo minus a skip list". While this package
 * lived at `.sandcastle/agent-workflows/` the walk started there and got that
 * scoping for free; at a repository root, "everything" sweeps in `tests/`,
 * `docs/`, `.github/` and the dotfiles, none of which ship — and one of which is
 * *this file*, whose `DOMAIN` regex contains the very words it searches for, so
 * a whole-repo walk fails on itself.
 */
const RUNNER_SURFACE = ["cli.ts", "shared", "scripts", "setup", "fix", "follow-ups", "implement", "implement-prd", "review", "update-branch"];

/**
 * A runner is a directory holding a file named after it — the same shape
 * `tests/agent-cli.test.ts` derives "the runners" from. Read here only to hold
 * the list above to it; see the check at the bottom of this file.
 */
const runnerDirs = fs
  .readdirSync(".", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(entry.name, `${entry.name}.ts`)))
  .map((entry) => entry.name)
  .sort();

const filesUnder = (dir: string): readonly string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? SKIPPED_DIRS.has(entry.name)
          ? []
          : filesUnder(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    );

const sandcastleFiles = RUNNER_SURFACE.flatMap((entry) =>
  fs.statSync(entry).isDirectory() ? filesUnder(entry) : [entry],
);

/**
 * The only workflows allowed to hold `issues: write`, each with the reason it
 * needs one. Everything else is derived, not listed: a workflow added later is
 * held to the rule on arrival rather than on someone remembering to add it to a
 * list — which is the same granted-but-unnoticed failure the check exists to
 * catch, one level up.
 */
const ISSUES_WRITE_EXEMPT = new Set([
  // Reads the issue and transitions its labels; the permission is used. Both
  // halves of the pair: the called job spends it, and the caller has to *grant*
  // it — a called workflow can only downgrade the token it is handed
  // (jeffwlawson/winget-manifest-lint#98).
  "implement.yml",
  // Same, plus it closes each sub-issue it finishes and re-labels the parent to
  // chain the next one. Note what it still cannot do: create an issue. Closing
  // one the PRD already lists is not filing work, so "an agent that raises work
  // never files it" (docs/parity.md §10) is untouched.
  "implement-prd.yml",
  // Files the AGENT_PAT expiry issue. Acts on no PR at all.
  "token-expiry.yml",
  // The first entry here that genuinely **creates** new issues — the others
  // close, re-label or file one fixed issue about the loop itself — so it is the
  // first that has to argue `docs/parity.md` §10's parity invariant rather than
  // sidestep it (#50).
  //
  // The argument: the invariant's concern is an unattended cycle, and the gate
  // has moved from *before filing* to *before building* — the stubs arrive
  // `needs-triage`, never `agent:implement`, so a human still decides what gets
  // built. Both halves of the invariant that carry the weight survive intact.
  // **The agent that raises the finding still never files it**: the review
  // agent emits the findings into its own review body under `contents: read`
  // and `issues: read`, which files nothing. And **the workflow holding the permission runs no
  // model** — this pair installs no Claude Code and invokes a runner whose
  // judgement is a pure function, which is also what keeps reading arbitrary
  // issue bodies with `issues: write` from being a prompt-injection surface.
  "follow-ups.yml",
]);

/**
 * The caller files (#225) are held to the same rule **per caller** rather than
 * per file: a caller file holds callers of exempt and unexempt workflows side
 * by side, so the exemption is the one its reusable half carries, and a caller
 * of anything else may not grant the scope. See the check beside the file one.
 */
const issuesWriteChecked = workflowFiles.filter(
  (f) => !ISSUES_WRITE_EXEMPT.has(path.basename(f)) && !path.basename(f).startsWith("agent-"),
);

const indentOf = (s: string): number => s.length - s.trimStart().length;

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  /** A step whose failure must not fail the run — the tidying after a posted review. */
  readonly "continue-on-error"?: boolean;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, string>;
  readonly "working-directory"?: string;
}

interface Job {
  readonly if?: string;
  /**
   * The job's display name, which GitHub writes into the check run in place of
   * the id. Read here so a reusable half that grew one could not rename the
   * second half of every adopter's `self-check` unnoticed.
   */
  readonly name?: string;
  readonly permissions?: Record<string, string>;
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: boolean };
  readonly steps?: readonly Step[];
  readonly needs?: string | readonly string[];
  readonly env?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  /** A number, or an expression that comes to one (#220). */
  readonly "timeout-minutes"?: number | string;
  /**
   * Set on a caller job — the reusable workflow it hands the work to
   * (jeffwlawson/winget-manifest-lint#97).
   */
  readonly uses?: string;
  readonly with?: Record<string, string>;
  readonly secrets?: Record<string, string> | "inherit";
}

interface CallInput {
  readonly description?: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly default?: string;
}

interface Workflow {
  readonly name?: string;
  readonly on?: {
    readonly workflow_call?: {
      readonly inputs?: Record<string, CallInput>;
      readonly secrets?: Record<string, { readonly required?: boolean }>;
    };
    readonly pull_request_target?: { readonly types?: readonly string[] };
    readonly issues?: { readonly types?: readonly string[] };
    readonly push?: { readonly tags?: readonly string[] };
    readonly workflow_dispatch?: unknown;
  };
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: boolean };
  readonly jobs: Record<string, Job>;
}

const workflowOf = (file: string): Workflow => parse(fs.readFileSync(file, "utf8")) as Workflow;

/**
 * The jobs a workflow declares **beside** the one that does its work, keyed by
 * file. This is a declared list rather than a derivation, the same shape as
 * `CALLER_FILES`. A second job in a reusable workflow is a second set of
 * permissions under the caller's grant, and it should arrive with an entry here
 * that says so, not slip past a check that picks "the" job.
 *
 * Not for a caller file, which holds one `uses:` job per caller (#225) and is
 * read through `callersOf` rather than through `jobOf`.
 */
const EXTRA_JOBS: Readonly<Record<string, readonly string[]>> = {
  /**
   * The posting job (#257): everything the review writes, in one job that runs
   * no model. The review job reads untrusted pull-request content and runs a
   * model over it, and holds no write scope at all; this job resolves the
   * threads the review closed (`resolveReviewThread` wants `contents: write`,
   * #133), posts the review and its verdict, takes the trigger label off and
   * hands off, spending the loop's token on the labels something fires on.
   *
   * …and the PRD chain's advance job (PRD #222), which follows the posting
   * job on a PRD PR and moves the chain on from a slice round's approval, or
   * parks it with a comment on the parent.
   *
   * …and the review's time limit (#220), which is its CI wait plus its own
   * time: an expression cannot add, so a job ahead of the review does the sum.
   * It holds no permission at all. It also says which token the loop writes
   * with, minting none, so the review job, which runs the agent, names no
   * secret that writes (#316, #320).
   *
   * …and the red check (#231), which runs the pull request's new and changed
   * tests against the merge-base ahead of the review. It runs the PR's code,
   * so it holds `contents: read` and no secret.
   */
  [path.join(WORKFLOW_DIR, "review.yml")]: ["time-limit", "red-check", "post-review", "advance"],
  /**
   * The gate and the publish job: implement's run split three ways so the job
   * that runs the agent holds no token that writes and names no PAT. The gate
   * refuses or claims the issue, and the publish job pushes the agent's
   * bundled commits and opens the PR from a runner the agent never touched.
   * See `SPLIT_RUNS`.
   */
  [path.join(WORKFLOW_DIR, "implement.yml")]: ["gate", "publish"],
  /** The same split as implement's, for fix (#308). */
  [path.join(WORKFLOW_DIR, "fix.yml")]: ["gate", "publish"],
  /**
   * The same split as implement's, for update-branch (#308). The gate also
   * tries the merge, so the agent's job runs only on a conflicted one.
   */
  [path.join(WORKFLOW_DIR, "update-branch.yml")]: ["gate", "publish"],
  /**
   * The same split as implement's, for implement-prd (#308), and one job
   * more: the catch-up, which merges the default branch into the PRD branch
   * and pushes it before the agent runs. It spends the PAT, so it is neither
   * the gate nor the agent's job.
   */
  [path.join(WORKFLOW_DIR, "implement-prd.yml")]: ["gate", "catch_up", "publish"],
};

/**
 * Runs split across jobs that hand off in a fixed order — a gate, the job that
 * runs the agent, and a publish job — read in that order wherever a check is
 * about the run's steps. The order is the run's: each job `needs` the one
 * before it, which a check below asserts, so a step's position in this list
 * is when it runs.
 *
 * The split is a security boundary, not a refactor. The agent runs with
 * `sudo` and can read every secret its own job names, from memory, and leave
 * something behind for a later step on the same runner; so the job that runs
 * it is read-only and names no PAT, and everything that writes runs on a
 * runner it never touched.
 */
const SPLIT_RUNS: Readonly<Record<string, readonly string[]>> = {
  [path.join(WORKFLOW_DIR, "implement.yml")]: ["gate", "implement", "publish"],
  [path.join(WORKFLOW_DIR, "fix.yml")]: ["gate", "fix", "publish"],
  [path.join(WORKFLOW_DIR, "update-branch.yml")]: ["gate", "update-branch", "publish"],
  [path.join(WORKFLOW_DIR, "implement-prd.yml")]: ["gate", "catch_up", "implement-prd", "publish"],
};

/**
 * A split run's three roles: the gate, first; the publish job, last; and the
 * agent's job, the one the runner is named for. Any job between the gate and
 * the agent's (implement-prd's catch-up) is neither.
 */
const rolesOf = (file: string): { readonly gate: string; readonly agent: string; readonly publish: string } => {
  const split = SPLIT_RUNS[file] ?? [];
  return { gate: split[0] as string, agent: path.basename(file, ".yml"), publish: split.at(-1) as string };
};

/**
 * The job each agent workflow does its work in. Parsed rather than pattern
 * matched: the checks below are about step *order* and which step carries which
 * `if:`, and a regex over the raw text cannot see either.
 *
 * Exactly one job remains once the declared extras are set aside, and every
 * declared extra has to exist, so an entry cannot outlive its job.
 */
const jobOf = (file: string): Job => {
  const jobs = workflowOf(file).jobs;
  const extra = EXTRA_JOBS[file] ?? [];

  for (const id of extra) expect(jobs[id], `${file} declares no job \`${id}\``).toBeDefined();
  const primary = Object.keys(jobs).filter((id) => !extra.includes(id));

  expect(primary).toHaveLength(1);
  return jobs[primary[0] as string] as Job;
};

/** A job by id, for the extras `jobOf` sets aside. */
const jobNamed = (file: string, id: string): Job => {
  const job = workflowOf(file).jobs[id];

  expect(job, `${file} declares no job \`${id}\``).toBeDefined();
  return job as Job;
};

/** Every job a file declares: its main one and the declared extras. */
const jobsOf = (file: string): readonly Job[] => Object.values(workflowOf(file).jobs);

const stepsOf = (file: string): readonly Step[] => {
  // A caller file holds one `uses:` job per caller and no steps, which the
  // caller-file checks assert; it has no single job to read them from (#225).
  if (path.basename(file).startsWith("agent-")) return jobsOf(file).flatMap((job) => job.steps ?? []);
  const split = SPLIT_RUNS[file];
  if (split === undefined) return jobOf(file).steps ?? [];
  jobOf(file);
  return split.flatMap((id) => jobNamed(file, id).steps ?? []);
};

/**
 * The job that carries a workflow's trigger-label guard: its gate, where the
 * run is split, since every job after it follows from the gate's outputs.
 */
const guardJobOf = (file: string): Job => {
  const split = SPLIT_RUNS[file];
  return split === undefined ? jobOf(file) : jobNamed(file, split[0] as string);
};

/**
 * Everything a step runs only if: its job's `if:` and its own, joined. Where a
 * run is split, a step's gate can sit on its job rather than on itself.
 */
const conditionOf = (file: string, step: Step): string => {
  const job = Object.values(workflowOf(file).jobs).find((j) => (j.steps ?? []).some((s) => JSON.stringify(s) === JSON.stringify(step)));
  return [job?.if, step.if].filter((c) => c !== undefined).join(" && ");
};

/**
 * The job a workflow writes from, where that is not the job that does its work
 * (#257). The review job runs the model and holds no write scope, so every
 * comment, label, status and post the review makes is its posting job's.
 */
const POSTING_JOB: Readonly<Record<string, string>> = {
  [path.join(WORKFLOW_DIR, "review.yml")]: "post-review",
};

/** The steps a workflow's labels, comments and failure arms live in. */
const writerStepsOf = (file: string): readonly Step[] => {
  const posting = POSTING_JOB[file];
  return posting === undefined ? stepsOf(file) : (jobNamed(file, posting).steps ?? []);
};

/** The go-ahead a writer step is gated on: its own job's, or the review job's handed over. */
const writerProceed = (file: string): string =>
  POSTING_JOB[file] === undefined ? "steps.state.outputs.proceed == 'true'" : "needs.review.outputs.proceed == 'true'";

/**
 * The step every runner workflow's job starts with (#220): it notes the time,
 * which is how the failure step tells a run that timed out from one cancelled
 * by hand, and does nothing else.
 */
const CLOCK = 'echo "JOB_STARTED=$(date +%s)" >> "$GITHUB_ENV"';

/**
 * A split run's clock: the gate's last step, an output rather than an env
 * entry, because the failure step that reads it is in another job. Read from
 * the gate and never from the agent's job, whose outputs the agent can write.
 */
const SPLIT_CLOCK = 'echo "started=$(date +%s)" >> "$GITHUB_OUTPUT"';

/**
 * The step a job's work starts with: the first after the clock. A split run's
 * gate has no clock ahead of its work: the limit is the agent's job's, so the
 * clock starts as the gate hands over, last in it (`SPLIT_CLOCK`).
 */
const firstWorkStep = (file: string): Step | undefined => {
  if (SPLIT_RUNS[file] !== undefined) return stepsOf(file)[0];
  const [clock, first] = stepsOf(file);

  expect(clock?.run).toBe(CLOCK);
  return first;
};

/**
 * Every workflow in the loop, split by which half of a `workflow_call` pair it
 * is. A **caller** declares the trigger and hands over (`uses:`); a **runner
 * workflow** is the one carrying the guards, the permissions and the steps.
 *
 * Derived from the job rather than from the file name, so a conversion cannot
 * put a file in the wrong bucket: the thing being asked is "does this file do
 * the work", and `uses:` is that question answered.
 */
const RUNNER_COMMANDS = ["fix", "follow-ups", "implement", "implement-prd", "review", "update-branch"];
/** Both halves of the loop: what a caller grants and what the called job bounds. */
const agentWorkflows = (): readonly string[] => [...callerFiles, ...runnerWorkflows];
const runnerWorkflows = RUNNER_COMMANDS.map((c) => path.join(WORKFLOW_DIR, `${c}.yml`));

/**
 * What a workflow's `permissions:` blocks say about themselves, unwrapped: one
 * string per block with no `scope`, and with one the comment attached to that
 * scope **inside** each block that grants it.
 *
 * Unwrapped before anything matches over it, because a claim in a YAML comment
 * wraps at whatever point the line ran out — a regex over the raw text only
 * catches a phrase that happens not to straddle a `#`. All the blocks rather
 * than the first, since a reusable has one per job.
 *
 * The per-scope form is the one worth having. A block read whole is a surface
 * where one correct paragraph satisfies a match that every scope under it
 * fails, which is how #146's sweep left `statuses: write` describing a failure
 * the docblock three lines above it had just retired.
 */
const permissionComments = (file: string, scope?: string): readonly string[] => {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  const unwrap = (from: number, to: number): string =>
    lines
      .slice(from, to)
      .filter((l) => l.trimStart().startsWith("#"))
      .map((l) => l.trimStart().replace(/^#\s?/, ""))
      .join(" ");
  /** Where the contiguous run of comment lines ending at `at` begins. */
  const commentsAbove = (at: number, floor: number): number => {
    let from = at;
    while (from > floor && (lines[from - 1] ?? "").trimStart().startsWith("#")) from -= 1;
    return from;
  };

  return lines.flatMap((line, at) => {
    if (line.trim() !== "permissions:") return [];
    const indent = indentOf(line);
    // The block ends where the indentation returns to the key's own or the
    // mapping runs out, whichever comes first.
    let to = at + 1;
    while (to < lines.length) {
      const next = lines[to] ?? "";
      if (next.trim() === "" || indentOf(next) <= indent) break;
      to += 1;
    }

    if (scope === undefined) return [unwrap(commentsAbove(at, 0), to)];

    const granted = lines.slice(at + 1, to).findIndex((l) => l.trim() === scope);

    return granted === -1 ? [] : [unwrap(commentsAbove(at + 1 + granted, at + 1), at + 1 + granted)];
  });
};

/**
 * Every caller under test, from **both** places they live.
 *
 * `examples/callers/` is the reference set an adopter copies. This repository
 * also installs its own, prefixed `agent-` so they do not collide by filename
 * with the reusable workflows they call — the job ids stay unprefixed, since
 * `self-check` is built from job ids and not from filenames.
 *
 * Both sets are read here rather than just the examples, because otherwise a
 * release could bump `package.json` and `examples/callers/`, pass, and leave
 * this repo's own callers on the previous tag. Silently — which is the exact
 * failure the version-derived `PIN` exists to prevent, reintroduced one
 * directory over.
 */
const callerFilesIn = (dir: string, prefix = ""): readonly string[] =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") && f.startsWith(prefix))
    .map((f) => path.join(dir, f));
const callerFiles = [...callerFilesIn(CALLER_DIR), ...callerFilesIn(WORKFLOW_DIR, "agent-")];

/**
 * One **caller**: a calling job, and the caller file it sits in (#225). A
 * caller file holds one or more of them and owns the trigger; each caller owns
 * its grant, its inputs and its secrets. So a check about a wire reads the
 * caller, and a check about the trigger reads the file.
 */
interface Caller {
  readonly file: string;
  readonly id: string;
  readonly job: Job;
}

const callersOf = (file: string): readonly Caller[] =>
  Object.entries(workflowOf(file).jobs).map(([id, job]) => ({ file, id, job }));
const callers: readonly Caller[] = callerFiles.flatMap(callersOf);

/** How a caller is named in a test title: its file, then its job. */
const callerName = (caller: Caller): string => `${caller.file} ${caller.id}`;

/** `it.each` rows for a set of callers, titled by `callerName`. */
const eachCaller = (set: readonly Caller[]): readonly (readonly [string, Caller])[] =>
  set.map((caller) => [callerName(caller), caller] as const);

/** The runner half a caller hands over to. */
const targetOf = (caller: Caller): string =>
  (caller.job.uses ?? "").replace(/^[^/]+\/[^/]+\//, "").replace(/@.*$/, "");

/** Every caller of one reusable workflow, from both caller sets. */
const callersOfWorkflow = (file: string): readonly Caller[] =>
  callers.filter((caller) => targetOf(caller) === file);

/**
 * The loop minus its merge-gated half, in both directions.
 *
 * Four of the checks below are about a **wire**: the three shared inputs, the
 * toolchain they configure, the auth step's position relative to that toolchain,
 * and the two secrets a caller hands over. `follow-ups.yml` declares no inputs
 * and no secrets on purpose — nothing is checked out, so there is no toolchain
 * to describe and no command to run, and it runs no model, so there is no
 * credential to pass (#50). Asserting the absence is that workflow's own
 * describe; what is excluded here is only the *presence*.
 *
 * Filtered rather than exempted by filename, because the question each of those
 * four asks is "does this half carry the wire the other half declares", and a
 * pair that declares none is out of that question rather than failing it.
 */
const wiredWorkflows = (): readonly string[] =>
  runnerWorkflows.filter((file) => !MERGE_GATED.includes(file));
const wiredCallers = (): readonly Caller[] =>
  callers.filter((caller) => !MERGE_GATED.includes(targetOf(caller)));

/**
 * The caller files, one per side (#225), and what each holds: the trigger it
 * fires on and the callers in it, by job id. Both caller sets hold exactly
 * these, the reference one under these names and this repository's own under
 * `agent-<name>.yml`.
 *
 * A declared table rather than a derivation, the same shape as `EXTRA_JOBS`.
 * `pull_request_target` reaching a job that holds write is a security surface,
 * so a caller file must not be able to widen its own trigger unnoticed, and
 * the job ids are the first half of every check-run name the loop produces
 * (`self-check`'s `review / review` among them), so they must not move either.
 *
 * `closed` on the PR side is `follow-ups`' (#50): what that feature is *for*,
 * findings filed when the pull request merges, and **not** a default
 * `pull_request_target` activity type, so a file that listed only `labeled`
 * would file nothing on a merge and read exactly like one that did. Every job
 * of the other three PR-side reusables skips it.
 */
const CALLER_FILES: Readonly<
  Record<string, { readonly event: "pull_request_target" | "issues"; readonly types: readonly string[]; readonly jobs: readonly string[] }>
> = {
  "pr.yml": {
    event: "pull_request_target",
    types: ["labeled", "closed"],
    jobs: ["review", "fix", "update-branch", "follow-ups"],
  },
  "issue.yml": { event: "issues", types: ["labeled"], jobs: ["implement", "implement-prd"] },
};

/** The table's entry for a caller file from either set. */
const callerFileSpec = (file: string) => CALLER_FILES[path.basename(file).replace(/^agent-/, "")];

/**
 * The review job — the reusable half, where every step now lives
 * (jeffwlawson/winget-manifest-lint#97).
 */
const REVIEW = path.join(WORKFLOW_DIR, "review.yml");

/** What advancing the PRD chain is, which review's `advance` job runs (#257, PRD #222). */
const ADVANCE_ACTION = path.join(".github", "actions", "advance-prd", "action.yml");
/** …and the reference caller file holding the caller that triggers it. */
const REVIEW_CALLER = path.join(CALLER_DIR, "pr.yml");

/**
 * The two workflows that share the `agent:implement` label
 * (jeffwlawson/winget-manifest-lint#92), again named by the half that holds the
 * steps (jeffwlawson/winget-manifest-lint#98).
 */
const IMPLEMENT = path.join(WORKFLOW_DIR, "implement.yml");
const PRD = path.join(WORKFLOW_DIR, "implement-prd.yml");

/**
 * The loop's token resolver (#319, PRD #314): the App's, else `AGENT_PAT`,
 * else the workflow token. The App's two secrets, and the workflows that
 * resolve their token through it and so are handed them: every one that
 * writes with more than the workflow token, both sides (#320).
 */
const TOKEN_ACTION = path.join(".github", "actions", "loop-token", "action.yml");
const APP_SECRETS = ["AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY"] as const;
const RESOLVING: readonly string[] = [
  IMPLEMENT,
  PRD,
  path.join(WORKFLOW_DIR, "review.yml"),
  path.join(WORKFLOW_DIR, "fix.yml"),
  path.join(WORKFLOW_DIR, "update-branch.yml"),
];

/** `agent-review`'s CI-collection step, which several checks below pick apart. */
const waitStep = (): Step => {
  const step = stepsOf(REVIEW).find((s) => (s.name ?? "").startsWith("Wait for other checks"));

  expect(step).toBeDefined();
  return step as Step;
};

/**
 * Line numbers (1-based) GitHub hands to the shell: the body of a `run:` block
 * scalar, and a single-line `run: <command>`. The inline form matters —
 * review's base fetch is written that way, so a check that only walked block
 * scalars would pass over the very line jeffwlawson/winget-manifest-lint#71
 * fixed.
 */
const runBlockLines = (lines: readonly string[]): ReadonlySet<number> => {
  const inside = new Set<number>();
  let runIndent: number | null = null;

  for (const [i, line] of lines.entries()) {
    if (/^\s*(- )?run:\s*[|>]/.test(line ?? "")) {
      runIndent = indentOf(line ?? "");
      continue;
    }
    if (/^\s*(- )?run:\s*\S/.test(line ?? "")) {
      inside.add(i + 1);
      runIndent = null;
      continue;
    }
    if (runIndent === null) continue;

    // The block ends at the first non-blank line indented no further than the
    // `run:` key itself.
    if ((line ?? "").trim() !== "" && indentOf(line ?? "") <= runIndent) {
      runIndent = null;
      continue;
    }
    inside.add(i + 1);
  }
  return inside;
};

/** The `run:` script of a step, found by id. */
const runOf = (file: string, id: string): string =>
  stepsOf(file).find((s) => s.id === id)?.run ?? "";

/**
 * The two steps that make a run *expensive* — the Node setup and the dependency
 * install — which a refusal must reach neither of. Keyed on the `setup` input
 * rather than on `npm ci`: the command is the adopter's since
 * jeffwlawson/winget-manifest-lint#98, and a filter still naming this repo's
 * would match nothing and pass by finding nothing.
 */
const isInstallStep = (s: Step): boolean =>
  (s.run ?? "").includes("${{ inputs.setup }}") ||
  (s.uses ?? "").startsWith("actions/setup-node@");

/**
 * The body of a bash function declared in a `run:` block. The parser has
 * already stripped the block scalar's own indent, so a top-level declaration
 * sits at column 0 and its closing brace is the next `}` at that same indent.
 *
 * Used to assert what a *refusal* does versus what a *deferral* does, which is
 * the whole difference between the two implement workflows' idle paths and is
 * invisible to a grep over the step as a whole.
 */
const bashFunctionBody = (run: string, name: string): string => {
  const lines = run.split("\n");
  const open = lines.findIndex((l) => l.trimStart().startsWith(`${name}() {`));

  expect(open).toBeGreaterThanOrEqual(0);
  const indent = indentOf(lines[open] ?? "");
  const close = lines.findIndex(
    (l, i) => i > open && l.trimStart() === "}" && indentOf(l) === indent,
  );

  expect(close).toBeGreaterThan(open);
  return lines.slice(open + 1, close).join("\n");
};

/** The body of an `if [ <condition> ]; then … fi` arm, up to its own `fi`. */
const armOf = (run: string, condition: string): string => {
  const start = run.indexOf(condition);

  expect(start).toBeGreaterThanOrEqual(0);
  const end = run.indexOf("\nfi", start);

  expect(end).toBeGreaterThan(start);
  return run.slice(start, end);
};

describe("workflow files", () => {
  it("finds workflows to check", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  /**
   * An empty `${{ }}` is not inert — GitHub tries to evaluate it and rejects
   * the entire file with "An expression was expected". It is also the exact
   * shape you reach for when writing *about* interpolation, which is how it
   * gets in.
   *
   * A YAML comment is exempt because GitHub never reads one. A `#` line inside
   * a `run:` block is NOT a YAML comment and gets no exemption.
   */
  it.each(workflowFiles)("%s: no empty expression where GitHub evaluates", (file) => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const inRun = runBlockLines(lines);

    const offenders = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line, n }) => {
        const isYamlComment = /^\s*#/.test(line) && !inRun.has(n);
        return !isYamlComment && /\$\{\{\s*\}\}/.test(line);
      })
      .map(({ line, n }) => `${file}:${n} ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  /**
   * Even a *non-empty* expression in a run-block comment is wrong: GitHub
   * substitutes it before bash ever sees the line, so the comment silently
   * stops saying what it was written to say. Prose about expressions belongs at
   * step level.
   */
  it.each(workflowFiles)("%s: no expression inside a run-block comment", (file) => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const inRun = runBlockLines(lines);

    const offenders = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line, n }) => inRun.has(n) && /^\s*#/.test(line) && line.includes("${{"))
      .map(({ line, n }) => `${file}:${n} ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  /**
   * `docs/parity.md` §10: an agent that raises work never files it. The
   * permission is what makes that technical rather than conventional, so it has
   * to stay absent from everything outside `ISSUES_WRITE_EXEMPT` — including
   * `review`, which was granted it unused
   * (jeffwlawson/winget-manifest-lint#101). Granted-but-unused reads as
   * sanctioned to the next person editing the file.
   */
  it.each(issuesWriteChecked)("%s: grants no issues: write", (file) => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const inRun = runBlockLines(lines);

    const offenders = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line, n }) => !inRun.has(n) && /^\s*issues:\s*write\s*$/.test(line))
      .map(({ n }) => `${file}:${n}`);

    expect(offenders).toEqual([]);
  });

  /** …and in a caller file, each caller whose reusable half is not exempt. */
  it("grants issues: write to no caller of an unexempt workflow", () => {
    const offenders = callers
      .filter((caller) => !ISSUES_WRITE_EXEMPT.has(path.basename(targetOf(caller))))
      .filter((caller) => caller.job.permissions?.["issues"] === "write")
      .map(callerName);

    expect(offenders).toEqual([]);
    // Not vacuous: the exempt callers are in the same files and do grant it.
    expect(callers.filter((caller) => caller.job.permissions?.["issues"] === "write")).toHaveLength(6);
  });
});

/**
 * A hardcoded `main` is the failure class of
 * jeffwlawson/winget-manifest-lint#71 and jeffwlawson/winget-manifest-lint#100:
 * on a PR stacked on another branch — or in a repo whose default branch is
 * `master` — every git operation silently addresses the wrong branch. No error,
 * wrong result.
 *
 * jeffwlawson/winget-manifest-lint#71 and jeffwlawson/winget-manifest-lint#100
 * fixed the three PR workflows, which read the base from the event. The two
 * `implement` workflows have no event field to read: they *choose* a branch to
 * work from, and jeffwlawson/winget-manifest-lint#98 made that choice the
 * `default-branch` input rather than a literal. So the rule is now one rule
 * over the whole loop — no workflow, and no runner, names a default branch of
 * its own.
 */
describe("the loop works against a base ref it is told, never a literal", () => {
  /**
   * Where the base comes from, per event. A PR event carries the real base and
   * the input is only the fallback for an event that somehow carries none; an
   * `issues` event carries nothing, so the input *is* the answer.
   *
   * Both are asserted as exact strings rather than a permissive regex: the
   * failure being prevented is a base read from somewhere else entirely, and a
   * pattern loose enough to allow either shape would allow that too.
   */
  it.each(PR_WORKFLOWS)("%s: falls back from the event to the input", (file) => {
    expect(fs.readFileSync(file, "utf8")).toContain(
      "BASE_REF: ${{ github.event.pull_request.base.ref || inputs.default-branch }}",
    );
  });

  it.each([IMPLEMENT, PRD])("%s: takes the base from the input alone", (file) => {
    expect(fs.readFileSync(file, "utf8")).toContain("BASE_REF: ${{ inputs.default-branch }}");
  });

  /**
   * The word, not just `origin/main`. The failure class is "a git verb was
   * handed `main`", which `git merge main --no-edit`, `git rev-parse main`,
   * `gh pr create --base main` and `base="main"` all are while matching no
   * `origin/`-shaped pattern.
   *
   * One exemption, and it is narrow: shell lines only, so a YAML comment may
   * still say `origin/main` while explaining what the input replaced. The
   * `${VAR:-main}` exemption this check used to carry is gone — every workflow
   * now gets a non-empty `BASE_REF` from an input whose own default is the
   * adopter's, so a second in-shell fallback would only ever fire on a repo
   * that had already said `default-branch: ''` and meant it.
   */
  it.each(runnerWorkflows)("%s: no shell line names main as a branch", (file) => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const inRun = runBlockLines(lines);

    const offenders = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line, n }) => inRun.has(n) && !/^\s*#/.test(line))
      .filter(({ line }) => /\bmain\b/.test(line))
      .map(({ line, n }) => `${file}:${n} ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  /**
   * The prompts, which are the half an adopter cannot edit: they ship inside the
   * package (jeffwlawson/winget-manifest-lint#96), so a `main` in one is not a
   * hand-edit an adopter forgot but a branch name they have no way to change at
   * all.
   *
   * Walked rather than listed, for the same reason the de-domaining checks below
   * are: the next prompt is written by someone with this repo's default branch
   * in their head. `update-branch/extraction.md` is the one that bites hardest —
   * on the conflicts path its output *is* the comment posted to the PR, and it
   * cannot be templated, because `runWithExtraction` drops `promptArgs` before
   * the extraction run and a `{{BASE_REF}}` there would arrive literal. A
   * `main`-shaped few-shot is the whole steer it gets.
   */
  const promptFiles = sandcastleFiles.filter((f) => f.endsWith(".md") && !f.endsWith("README.md"));

  it("finds prompts to check", () => {
    expect(promptFiles.length).toBeGreaterThan(0);
  });

  it.each(promptFiles)("%s: does not hardcode main", (file: string) => {
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/\borigin\/main\b|`main`|\bmain\.\.\.?/);
  });

  /**
   * The three prompts that talk about a branch relationship say which branch,
   * and say it from the environment. `update-branch` describes the merge it is
   * cleaning up after; the two `implement` prompts tell the agent what its own
   * branch was cut from and, for a PRD, what to diff to see the earlier slices.
   */
  it.each(["update-branch", "implement", "implement-prd"])(
    "%s/prompt.md is templated with the base ref",
    (dir: string) => {
      expect(
        fs.readFileSync(`${dir}/prompt.md`, "utf8"),
      ).toContain("{{BASE_REF}}");
    },
  );

  /**
   * `implement.ts` counted commits with `git rev-list --count main..HEAD` — the
   * only unconditional `main` in a runner rather than in YAML, and the only one
   * that *hard-errors*: `sh` is `execSync`, so on a repo with no `main` ref the
   * run aborts after the agent has done all of its work (docs/ADOPTING.md §5).
   */
  it("implement counts its commits against the base it was given", () => {
    const text = fs.readFileSync("implement/implement.ts", "utf8");

    expect(text).not.toContain("main..HEAD");
    expect(text).toContain('required("BASE_REF")');
  });

  /**
   * …and `update-branch.ts` renders the base into its prompt, so an unset
   * `BASE_REF` there described the wrong merge rather than failing. Required
   * now: the workflow always supplies one, so an absent value is a
   * misconfiguration to say out loud rather than to paper over.
   */
  it("update-branch requires the base ref rather than defaulting to one", () => {
    const text = fs.readFileSync(
      "update-branch/update-branch.ts",
      "utf8",
    );

    expect(text).toContain('required("BASE_REF")');
    expect(text).not.toMatch(/\|\|\s*"main"/);
  });
});

/**
 * One group per PR, across every workflow that touches it
 * (jeffwlawson/winget-manifest-lint#102). Review used to sit in
 * `agent-review-pr-*` while fix and update-branch shared `agent-mutate-pr-*`,
 * so a review could diff a branch *while* a fix pushed to it — a review of a
 * tree state that never existed. The hazard is review reading during another
 * job's write, which its `contents: read` does nothing to prevent.
 */
describe("every PR workflow shares one concurrency group per PR", () => {
  const PR_GROUP = "agent-pr-${{ github.event.pull_request.number }}";

  /**
   * A split run's group is the workflow's, keyed so another label's event
   * takes one of its own (#309): the same per-PR group for the run's own
   * label, which is the one that matters here.
   */
  const groupOf = (file: string): string => {
    if (SPLIT_RUNS[file] === undefined) return PR_GROUP;
    const label = `agent:${path.basename(file, ".yml")}`;
    return `${PR_GROUP}\${{ github.event.label.name != '${label}' && format('-other-{0}', github.run_id) || '' }}`;
  };

  it.each(PR_WORKFLOWS)("%s: is in the per-PR group, first-come", (file) => {
    const concurrency = SPLIT_RUNS[file] === undefined ? jobOf(file).concurrency : workflowOf(file).concurrency;

    expect(concurrency?.group).toBe(groupOf(file));
    expect(concurrency?.["cancel-in-progress"]).toBe(false);
  });

  /**
   * Sharing a group turns review's CI wait into a trap: a `fix` labelled
   * mid-review is queued behind it, a queued job is a check run in a
   * non-completed state, and review would spend 15 of its 20 minutes waiting
   * for a job that cannot start until review ends. Every agent job is excluded
   * from the wait, not just review's own.
   */
  it("agent-review waits on no agent job", () => {
    const excluded = new RegExp(waitStep().env?.["AGENT_CHECKS"] ?? "");

    // The names the loop actually produces, derived from the workflows rather
    // than listed: a called workflow's job is `<caller job id> / <called job
    // id>`, so every sibling was renamed by the conversion
    // (jeffwlawson/winget-manifest-lint#98). This check used to assert the
    // pattern *contained* the words `review`, `fix` and so on — which
    // `^(review|fix|update-branch|implement)$` did while matching none of the
    // names below, so it stayed green over a review that would queue behind a
    // labelled `fix` and burn its whole 900 s on it.
    //
    // Deduplicated because there are two caller sets — the reference copies and
    // this repo's own — and they deliberately share job ids, so both produce
    // the same five names. The property is about the names the loop emits, not
    // how many files happen to emit them.
    //
    // Every called job, not just the first: `review / post-review` is a check
    // run on the pull request too (#257).
    const checkRuns = [
      ...new Set(
        callers.flatMap((caller) =>
          Object.keys(workflowOf(targetOf(caller)).jobs).map((called) => `${caller.id} / ${called}`),
        ),
      ),
    ];

    expect(checkRuns).toHaveLength(19);
    // implement's gate and publish jobs, around the job that runs its agent,
    // and the same for fix, update-branch and implement-prd (#308), whose run
    // has a catch-up job besides. Matched by the caller job's id, as
    // `implement` always was.
    expect(checkRuns).toContain("implement / gate");
    expect(checkRuns).toContain("implement / publish");
    expect(checkRuns).toContain("fix / gate");
    expect(checkRuns).toContain("fix / publish");
    expect(checkRuns).toContain("update-branch / gate");
    expect(checkRuns).toContain("update-branch / publish");
    expect(checkRuns).toContain("implement-prd / gate");
    expect(checkRuns).toContain("implement-prd / catch_up");
    expect(checkRuns).toContain("implement-prd / publish");
    // The posting job (#257): it runs after this wait, and it is not evidence
    // about the diff whenever it does.
    expect(checkRuns).toContain("review / post-review");
    // …and the PRD chain's advance job (PRD #222), which runs after it on a
    // PRD PR, so a later round on the same head sees it.
    expect(checkRuns).toContain("review / advance");
    // …and the review's time limit (#220), which finishes before the review
    // starts and is no evidence about the diff either.
    expect(checkRuns).toContain("review / time-limit");
    expect("agent-review / time-limit").toMatch(excluded);
    // …and the red check (#231), whose check run reads red exactly when it
    // finds what it looks for, and so must never read as CI.
    expect(checkRuns).toContain("review / red-check");
    expect("agent-review / red-check").toMatch(excluded);
    for (const name of checkRuns) expect(name).toMatch(excluded);
    expect("agent-review / advance").toMatch(excluded);
    // And under a caller job an adopter renamed, where only the second half is
    // ours to know.
    expect("agent-review / post-review").toMatch(excluded);
    // Named `post-review` rather than `post`, so a repository's own CI job
    // called `post` is still CI.
    expect("CI / post").not.toMatch(excluded);
    // Bare job ids too — an adopter is free to inline a job rather than call
    // one, and the pattern predates the split.
    //
    // `follow-ups` is in the pattern even though excluding it is dead at
    // runtime: this wait only runs on an open pull request and that workflow
    // only fires on a closed one (#50). One word in one string, against a
    // carve-out whose comment would have to justify a timing argument that
    // could stop being true.
    for (const name of ["review", "fix", "follow-ups", "update-branch", "implement", "implement-prd"]) {
      expect(name).toMatch(excluded);
    }

    // Bounded at both ends, or the exclusion eats the CI it exists to collect.
    // These are repo checks whose names merely start or end near an agent's.
    for (const name of ["fixtures", "CI", "CI / verify", "CI / fix-lint", "build / fixtures"]) {
      expect(name).not.toMatch(excluded);
    }
    // Every jq pass over the check runs carries it — the one that decides
    // whether to keep waiting, the one that writes the list into the prompt,
    // and the one that reduces them to the verdict's single word (#96). Counted
    // against the passes rather than against a literal, so a fourth arrives
    // here as a failure rather than as a pattern nobody extended: one that
    // skipped this would deadlock on a queued agent job, or read a sibling
    // agent's failure as this commit's CI.
    const passes = [...(waitStep().run ?? "").matchAll(/\.\[\]\.check_runs\[\]/g)];
    const filters = [...(waitStep().run ?? "").matchAll(/test\(\\"\$\{AGENT_CHECKS\}\\"\)/g)];

    expect(passes.length).toBeGreaterThanOrEqual(3);
    expect(filters).toHaveLength(passes.length);
  });

  /**
   * The same set, one step further on: the failure-log tail skipped only
   * `Agent Review` while the wait above excluded all four, so a failed `Agent
   * Fix` still got 60 lines of its log into the prompt — not evidence about the
   * diff, and crowding out the CI failure that is. Matched on the workflow
   * *run* name, a different namespace from the check names in `AGENT_CHECKS`:
   * every agent workflow is `name: Agent …` and the repo's own are `CI` and
   * `Corpus`, so the prefix is the whole test. Since #221 the tail reads the
   * same filtered listing the wait does, so the prefix is applied once, there,
   * beside this run's own id and a renamed caller's `uses:` target.
   */
  it("agent-review tails no agent workflow's failure log", () => {
    const run = waitStep().run ?? "";

    expect(run).toContain('select((.name // "") | startswith("Agent ") | not)');
    expect(run).toContain("select((.id | tostring) != env.SELF_RUN_ID)");
    expect(run).toContain("agent-workflows/\\\\.github/workflows/");
    expect(waitStep().env?.["SELF_RUN_ID"]).toBe("${{ github.run_id }}");
    expect(run).toMatch(/failed_runs=\$\(printf '%s' "\$runs"/);
    expect(run).not.toContain('[ "$rname" = "Agent Review" ]');
  });

  /**
   * The runs listing feeds the tail and, since #221, the verdict, and it is
   * gated on gh's exit status: fed straight to `for`, a refusal was silent, or
   * iterated an error body's JSON words as run ids (#80). A failure says in the
   * evidence what is missing, and reads `unknown`. Behaviour is
   * `tests/review-ci-wait.test.ts`'s; this pins the shape and the ceiling.
   */
  it("agent-review says so when it cannot list the workflow runs", () => {
    const run = waitStep().run ?? "";

    expect(run).toContain('if ! runs=$(gh api "repos/${GH_REPO}/actions/runs?head_sha=${HEAD_SHA}');
    expect(run).toContain("for rid in $failed_runs; do");
    expect(run).not.toMatch(/for rid in \$\(gh api/);
    expect(run).toMatch(/Could not list this commit's workflow runs[^\n]*>> "\$out"/);
    expect(run).toMatch(/workflow_runs=unknown/);
  });

  /**
   * The grant the workflow-runs read spends (#221), in all three places it has
   * to be: the reusable half's ceiling, and both caller sets, where it is
   * actually granted. A run waiting for approval has created no check run, so
   * without the scope the wait cannot see it and reads "no CI" as green.
   */
  it("holds the actions grant in the review ceiling and in every review caller", () => {
    const halves = [jobOf(REVIEW), ...callersOfWorkflow(REVIEW).map((caller) => caller.job)];

    expect(halves).toHaveLength(3);
    for (const job of halves) expect(job.permissions?.["actions"]).toBe("read");
    // Only the review job: the posting job and the rest read no runs.
    expect(workflowOf(REVIEW).jobs["post-review"]?.permissions).not.toHaveProperty("actions");
  });

  /**
   * An unreadable check-runs API must stop the wait, not extend it.
   *
   * `pending_count` used to end `|| echo 0`, which had two failure shapes and
   * both were silent. A clean non-zero exit became `0` — "nothing pending" —
   * and the review ran blind. A 403 whose body reached stdout became
   * `{"message":…}0`, which `-eq` rejects as non-numeric on every iteration,
   * so the loop spun out all 900 s and *then* reviewed blind. The trigger for
   * both: check runs on a **private** repository need `checks: read`, and no
   * public repo in the pilot ever needed the grant to read them. That trigger
   * is gone — the job declares the scope and a caller short of it never starts
   * (#146) — and the two failure shapes are not, since a transient API failure
   * produces each of them just the same.
   *
   * What is asserted is the property, not the shell: a non-numeric count is
   * matched explicitly, it breaks rather than sleeps, and it says so in the
   * log *and* in the evidence handed to the agent — a review with no CI
   * behind it should never look like one that had it.
   */
  it("agent-review stops the CI wait when check runs cannot be read", () => {
    const run = waitStep().run ?? "";

    // The count is never defaulted over a failed call.
    expect(run).not.toContain("|| echo 0");

    // Non-numeric — including empty — is handled as its own case.
    expect(run).toContain('case "$pending" in');
    expect(run).toContain('"" | *[!0-9]*)');

    // …and the count is one number, so that arm means what it says. `gh api
    // --paginate --jq` applies the filter per page, so a commit with more
    // than one page of check runs (>30) prints `0\n0` — which the arm above
    // would classify as an API failure and report as a blind review, on a
    // repo whose permissions are fine. Slurped, the filter runs once over
    // every page.
    //
    // These two lines match *text*, and text is all they have ever matched.
    // They were green for a release over `--paginate --slurp --jq`, which gh
    // refuses outright and which therefore collected nothing at all (#28) —
    // the shape was right and the command could not run. What settles that
    // question is `tests/review-ci-wait.test.ts`, which executes this step
    // against a recorded `gh`; keep these as the cheap statement of intent
    // and put any new claim about *behaviour* there.
    expect(run).toContain("--paginate --slurp");
    expect(run).toContain("[.[].check_runs[]");

    // Loud in the run log, and named in the evidence the agent reads.
    expect(run).toContain("::error::Could not read check runs");
    expect(run).toMatch(/Could not read this commit's check runs[^\n]*>> "\$out"/);

    // And the grant is named as the thing it is *not*, where someone hitting
    // this will look for it: a caller short of `checks: read` is refused before
    // any job starts, so a step that ran holds the read and a reader sent to
    // their own caller is sent to a file that is already correct (#146).
    expect(run).toContain("checks: read");
    expect(run).toContain("before any job starts");
    expect(run).not.toMatch(/this is a missing `checks: read` grant/);
  });

  /**
   * A group declared at workflow level too would put the same job in two
   * groups, which GitHub rejects; a second job-level one would mean a second
   * job, which `jobOf` already refuses.
   */
  it.each(PR_WORKFLOWS)("%s: declares exactly one group", (file) => {
    const groups = [...fs.readFileSync(file, "utf8").matchAll(/^\s*group:\s*(.+)$/gm)].map((m) =>
      (m[1] ?? "").trim(),
    );

    expect(groups).toEqual([groupOf(file)]);
  });
});

/**
 * A closed or merged PR is refused before any work happens. `agent-review` had
 * no guard at all: labelling a merged PR ran a full agent pass over merged
 * work, then failed at `gh pr ready` — which cannot convert a merged PR — and
 * blamed a missing `AGENT_PAT` for it (jeffwlawson/winget-manifest-lint#102).
 */
describe("PR workflows refuse a closed or merged PR", () => {
  it.each(PR_WORKFLOWS)("%s: reads the PR state from the event", (file) => {
    const text = fs.readFileSync(file, "utf8");

    expect(text).toContain("PR_STATE: ${{ github.event.pull_request.state }}");
    expect(text).toContain("PR_MERGED: ${{ github.event.pull_request.merged }}");
  });

  // Second only to the clock a failure step reads its time limit off (#220),
  // which does nothing but note the time and is asserted exactly below, in
  // *a run that times out or is cancelled says so*.
  it.each(PR_WORKFLOWS)("%s: the guard is the first step and is itself ungated", (file) => {
    const first = firstWorkStep(file);

    expect(first?.id).toBe("state");
    expect(first?.if).toBeUndefined();
    expect(first?.run ?? "").toContain('"$PR_STATE" != "open"');
    expect(first?.run ?? "").toContain('"$PR_MERGED" = "true"');
  });

  const PROCEED = "steps.state.outputs.proceed == 'true'";

  /**
   * The two things a refused run must not have done: checked the branch out,
   * and told the PR an agent is working on it. Both are asserted on the step
   * that does them rather than on step order, so moving a step cannot quietly
   * escape the guard.
   */
  it.each(PR_WORKFLOWS)("%s: checkout is gated on the guard", (file) => {
    const checkout = stepsOf(file).filter((s) => (s.uses ?? "").startsWith("actions/checkout@"));

    expect(checkout).not.toHaveLength(0);
    // Where the run is split, a checkout past the gate is in a job that runs
    // only where the gate went ahead, or behind a step that needs the agent's
    // job to have succeeded, which it cannot have where it never ran.
    const goAhead = [PROCEED, "needs.gate.outputs.refused == 'false'", "needs.gate.outputs.status == '", `needs.${path.basename(file, ".yml")}.result == 'success'`];
    for (const step of checkout) {
      const condition = conditionOf(file, step);
      expect(goAhead.some((c) => condition.includes(c)), `${step.name}: ${condition}`).toBe(true);
    }
  });

  it.each(PR_WORKFLOWS)("%s: the label transition is gated on the guard", (file) => {
    const labelling = writerStepsOf(file).filter((s) => s.name === "Transition labels");

    expect(labelling).toHaveLength(1);
    for (const step of labelling) expect(step.if ?? "").toContain(writerProceed(file));
  });
});

/**
 * The pushing half of #229: every run that pushes and then asks for a review
 * waits for the pull request to show the pushed commit as its head first, so
 * the `labeled` payload names it. Bounded, and a timeout still labels, with a
 * warning naming both commits: the review side settles on the tip itself.
 */
describe("a run that pushed waits for the PR head before asking for a review", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["fix.yml", "Request re-review", "PR_NUMBER"],
    ["update-branch.yml", "Request a review of the resolution", "PR_NUMBER"],
    ["implement.yml", "Request review", "NEW_PR"],
    ["implement-prd.yml", "Request review", "PRD_PR"],
  ];

  it.each(cases)("%s: waits for headRefOid to equal the pushed commit, then labels", (file, name, pr) => {
    const steps = stepsOf(path.join(WORKFLOW_DIR, file));
    const push = steps.find((s) => s.id === "push");
    const step = steps.find((s) => s.name === name);
    const run = step?.run ?? "";

    // A split run's publish job never checks the agent's branch out: it
    // unbundles the commits into a ref and pushes the ref.
    const branch = file === "implement-prd.yml" ? "PRD_BRANCH" : "BRANCH";
    const head = SPLIT_RUNS[path.join(WORKFLOW_DIR, file)] !== undefined ? `"$(git rev-parse "refs/heads/\${${branch}}")"` : '"$(git rev-parse HEAD)"';
    expect(push?.run ?? "").toContain(`echo "head=${head.slice(1, -1)}"`);
    expect(step?.env?.["PUSHED_SHA"]).toBe("${{ steps.push.outputs.head }}");
    expect(step?.env?.["HEAD_WAIT_SECONDS"]).toBe("60");
    expect(run).toContain(`gh pr view "$${pr}" --json headRefOid --jq .headRefOid`);
    expect(run).toContain('[ "$head" = "$PUSHED_SHA" ]');
    expect(run.indexOf("--json headRefOid")).toBeLessThan(run.indexOf('--add-label "agent:review"'));
  });

  it.each(cases)("%s: a wait that times out warns, naming both commits, and labels anyway", (file, name) => {
    const run = stepsOf(path.join(WORKFLOW_DIR, file)).find((s) => s.name === name)?.run ?? "";
    const timeout = run.slice(run.indexOf('if [ "$SECONDS" -ge "$deadline" ]; then'));
    const arm = timeout.slice(0, timeout.search(/\n\s*fi\n/));

    expect(arm).toContain("::warning::");
    expect(arm).toContain("${head:-an unreadable head}");
    expect(arm).toContain("${PUSHED_SHA}");
    expect(arm).toContain("break");
    expect(arm).not.toContain("exit");
  });
});

/**
 * Which commit a review is about (#229). The `labeled` payload names the head
 * at label time, and that is stale twice over: a review queued behind a fix
 * starts after the fix has pushed, and GitHub moves a pull request's head
 * asynchronously after a push, so a label added the moment a run pushed can
 * carry the commit before the push, with `headRefOid` agreeing. #228 posted its
 * verdict on the pre-fix commit that way.
 *
 * So the pre-flight reads the branch tip from git, reviews it where it
 * descends from the payload's commit, refuses by name where it does not, and
 * everything after reads the one commit it settled on. The branches are
 * executed in `tests/review-preflight.test.ts`; what is held here is the
 * wiring, which no execution of one step can see.
 */
describe("agent-review settles on one commit and reads nothing else", () => {
  const guard = (): Step | undefined => firstWorkStep(REVIEW);
  const run = (): string => guard()?.run ?? "";
  const RESOLVED = "${{ steps.state.outputs.sha }}";

  it("reads the branch tip from git, not from the pull request", () => {
    expect(guard()?.id).toBe("state");
    expect(guard()?.env?.["HEAD_SHA"]).toBe("${{ github.event.pull_request.head.sha }}");
    expect(run()).toContain('ls-remote "${GITHUB_SERVER_URL}/${GH_REPO}.git" "refs/heads/${BRANCH}"');
    expect(run()).toContain(`awk -v ref="refs/heads/\${BRANCH}" '$2 == ref { print $1 }'`);
    expect(run()).toContain('[ "$tip" != "$HEAD_SHA" ]');
    // Distinct from the not-open refusal: same step, two states, and a human
    // reading only the comment has to be able to tell them apart.
    expect(run()).toContain('refuse "This PR is closed."');
    expect(run()).toContain("The PR changed after \\`agent:review\\` was added.");
  });

  it("follows the tip only where it descends from the labelled commit, and waits for the PR to show it", () => {
    const moved = run().slice(run().indexOf('[ "$tip" != "$HEAD_SHA" ]'));

    expect(moved).toContain('compare/${HEAD_SHA}...${tip}');
    expect(moved).toContain('[ "$relation" != "ahead" ]');
    expect(moved.indexOf('[ "$relation" != "ahead" ]')).toBeLessThan(moved.indexOf("--json headRefOid"));
    expect(moved).toContain('[ "$head" = "$tip" ]');
    expect(guard()?.env?.["HEAD_WAIT_SECONDS"]).toBe("60");
  });

  it("writes the commit it settled on beside the go-ahead, and nowhere else says proceed", () => {
    expect(run()).toContain('echo "sha=${tip}" >> "$GITHUB_OUTPUT"');
    expect(run().match(/proceed=true/g)).toHaveLength(1);
    expect(run().indexOf('echo "sha=${tip}"')).toBeLessThan(run().indexOf('echo "proceed=true"'));
  });

  /**
   * The acceptance criterion in one place: the checkout, the CI wait and both
   * status posts read the resolved commit, and no step past the guard reads the
   * payload's head again.
   */
  it("checks out, waits on CI for, and posts every status on the resolved commit", () => {
    const steps = stepsOf(REVIEW);
    const named = (prefix: string): Step | undefined => steps.find((s) => (s.name ?? "").startsWith(prefix));

    expect(named("Checkout PR head")?.with?.["ref"]).toBe(RESOLVED);
    expect(named("Wait for other checks")?.env?.["HEAD_SHA"]).toBe(RESOLVED);
    // The posting job reads the same answer, handed over as the review job's
    // `sha` (#257), and never the payload's.
    expect(jobOf(REVIEW).outputs?.["sha"]).toBe(RESOLVED);
    const posting = writerStepsOf(REVIEW);
    const posted = (prefix: string): Step | undefined => posting.find((s) => (s.name ?? "").startsWith(prefix));
    expect(posted("Post the verdict as a commit status")?.env?.["HEAD_SHA"]).toBe("${{ needs.review.outputs.sha }}");
    expect(posted("Post an error verdict")?.env?.["HEAD_SHA"]).toBe("${{ needs.review.outputs.sha }}");
    for (const step of [...steps.slice(steps.findIndex((s) => s.id === "state") + 1), ...posting]) {
      expect(JSON.stringify(step)).not.toContain("pull_request.head.sha");
    }
  });
});

/**
 * The fix's own version of that refusal (#188), against the **branch ref**
 * rather than the pull request's `headRefOid`: the case that raised it had the
 * pull request reporting the old SHA after the branch moved, so asking the pull
 * request would agree with the stale event. A fix run started behind the branch
 * fast-forwards, finds nothing to do, and replies to every thread again.
 */
describe("agent-fix refuses an event head behind the live branch", () => {
  const FIX = path.join(WORKFLOW_DIR, "fix.yml");
  const guard = (): Step | undefined => firstWorkStep(FIX);
  const run = (): string => guard()?.run ?? "";

  it("compares the event SHA with the branch ref, in the guard", () => {
    expect(guard()?.id).toBe("state");
    expect(run()).toContain('ls-remote "${GITHUB_SERVER_URL}/${GH_REPO}.git" "refs/heads/${BRANCH}"');
    expect(run()).toContain('[ "$live" != "$BRANCH_HEAD_SHA" ]');
    expect(run()).not.toContain("headRefOid");
    // Still the SHA the push's lease pins, so the two agree on what "current" is.
    expect(jobOf(FIX).env?.["BRANCH_HEAD_SHA"]).toBe("${{ github.event.pull_request.head.sha }}");
    expect(stepsOf(FIX).find((s) => s.name === "Push branch")?.run ?? "").toContain(
      '--force-with-lease="refs/heads/$BRANCH:$BRANCH_HEAD_SHA"',
    );
  });

  /**
   * `ls-remote` matches its pattern against the tail of each ref, so a branch
   * `x/refs/heads/<name>` would also answer. The exact ref is picked out.
   */
  it("reads the exact ref out of the answer", () => {
    expect(run()).toContain(`awk -v ref="refs/heads/\${BRANCH}" '$2 == ref { print $1 }'`);
  });

  /**
   * The SHAs go to the log, and the comment says what the review's says for
   * the same situation (#253): the PR changed, add the label again, and how
   * to make GitHub catch up where it has not.
   */
  it("says why, as a warning naming both SHAs and as one comment giving the way out", () => {
    const arm = run().slice(run().indexOf('[ "$live" != "$BRANCH_HEAD_SHA" ]'));
    const stale = arm.slice(0, arm.indexOf("exit 0"));

    expect(stale).toMatch(/::warning::[^\n]*\$\{BRANCH_HEAD_SHA\}[^\n]*\$\{live\}/);
    expect(stale.match(/refuse "/g)).toHaveLength(1);
    expect(stale).toContain(
      'refuse "The PR changed after \\`agent:fix\\` was added. Add \\`agent:fix\\` again to work on the latest version. If the PR still shows the old commit, close and reopen it so GitHub catches up." blocked',
    );
  });

  /**
   * The label the run consumed is gone and `agent:blocked` is on, so re-adding
   * `agent:fix` is the retry and `Transition labels` clears the block.
   */
  it("leaves labels a human can retry from", () => {
    const refuse = bashFunctionBody(run(), "refuse");

    expect(refuse).toContain('--remove-label "agent:fix"');
    expect(refuse).toContain('--add-label "agent:blocked"');
    expect(refuse).toContain('echo "proceed=false" >> "$GITHUB_OUTPUT"');
    expect(stepsOf(FIX).find((s) => s.name === "Transition labels")?.run ?? "").toContain(
      '--remove-label "agent:blocked"',
    );
  });

  /**
   * The opposite of review's choice, and on purpose: this run pushes and
   * replies, and replying twice is the harm. "Could not tell" must not read as
   * "not stale", so a failed `ls-remote` and an empty answer both refuse.
   */
  it("refuses when the live head cannot be read, and says so beside the check", () => {
    expect(run()).toContain("if ! remote=$(git");
    expect(run()).toContain('if [ -z "$live" ]; then');
    expect(run()).not.toContain('[ -n "$live" ] &&');
    const armOf = (arm: string): string => {
      const body = run().slice(run().indexOf(arm));
      return body.slice(0, body.indexOf("exit 0"));
    };
    // Blocked where the maintainer has to act, and not on a deleted branch,
    // which leaves nothing to act on (#253).
    expect(armOf("if ! remote=$(git")).toMatch(/refuse ".*" blocked/);
    expect(armOf('if [ -z "$live" ]; then')).toContain(
      `refuse "This PR's branch no longer exists, so there's nothing to fix."\n`,
    );
    expect(fs.readFileSync(FIX, "utf8")).toContain("**An unreadable head refuses, deliberately**");
  });

  /** And the proceed line is reached only past every refusal. */
  it("proceeds only after the head is confirmed", () => {
    expect(run().lastIndexOf('echo "proceed=true"')).toBeGreaterThan(run().indexOf('[ "$live" != "$BRANCH_HEAD_SHA" ]'));
    expect(run().match(/proceed=true/g)).toHaveLength(1);
  });
});

/**
 * A PRD PR's review is a **slice round** or the **final review** (PRD #222).
 * The workflow tells the two apart by the mark the finishing run writes into
 * the PRD PR's body, before anything can fail, and hands the runner that one
 * answer; a slice round reads its slice off the PRD branch with the one
 * function every "which slice" question uses. The briefs' wording is
 * `shared/prd-round.ts`'s, and tested in `tests/prd-round.test.ts`; what is
 * held here is the wiring, which has no runtime symptom when it breaks: a
 * slice round handed the wrong brief reviews the whole PRD again, and a final
 * review taken for a slice round advances the chain off it.
 */
describe("agent-review tells a slice round from the final review on a PRD PR", () => {
  const RUNNER = "review/review.ts";
  const runner = (): string => fs.readFileSync(RUNNER, "utf8");
  const roundStep = (): Step | undefined =>
    stepsOf(REVIEW).find((s) => s.name === "Tell a slice round from the final review");
  const runStep = (): Step | undefined => stepsOf(REVIEW).find((s) => s.name === "Run review agent");

  it("recognises a PRD PR by the prefix implement-prd names its branch with, and nothing else", () => {
    const prefix = /^agent\/prd-(\d+)-/;

    expect(fs.readFileSync(PRD, "utf8")).toContain('prd_branch="agent/prd-${ISSUE_NUMBER}-${slug}"');
    expect(runner()).toContain("/^agent\\/prd-(\\d+)-/");
    expect(prefix.test("agent/issue-179-integration-review")).toBe(false);
    expect(prefix.test("agent/prd-171-prd-slice-prs")).toBe(true);
    const condition = (roundStep()?.if ?? "").replace(/\s+/g, " ");
    expect(condition).toContain("steps.state.outputs.proceed == 'true'");
    expect(condition).toContain("startsWith(github.event.pull_request.head.ref, 'agent/prd-')");
  });

  /**
   * The mark is spelled in two workflows, the one that writes it and the one
   * that reads it, and held equal here: a reader looking for a mark nobody
   * writes would take every final review for a slice round.
   */
  it("reads the final review's mark the finishing run writes", () => {
    const mark = roundStep()?.env?.["FINAL_REVIEW_MARK"] ?? "";

    expect(mark).toBe("<!-- agent:final-review requested -->");
    expect(fs.readFileSync(PRD, "utf8")).toContain(`mark="${mark}"`);
    expect(fs.readFileSync(PRD, "utf8")).toContain(`final_review="${mark}"`);
    expect(roundStep()?.run ?? "").toContain('if [[ "$body" == *"$FINAL_REVIEW_MARK"* ]]; then');
    // Not `|| true`: a body that cannot be read fails the run, which parks the
    // chain, rather than guessing which round it is.
    expect(roundStep()?.run ?? "").toContain("set -euo pipefail");
  });

  it("hands the runner and every later job that one answer", () => {
    expect(runStep()?.env?.["ROUND"]).toBe("${{ steps.round.outputs.round }}");
    expect(jobOf(REVIEW).outputs?.["round"]).toBe("${{ steps.round.outputs.round }}");
    expect(runner()).toContain('process.env["ROUND"] === "final"');
    // Before the agent's checkout and every step that can fail after it.
    const names = stepsOf(REVIEW).map((s) => s.name ?? "");
    expect(names.indexOf("Tell a slice round from the final review")).toBeLessThan(names.indexOf("Checkout PR head"));
  });

  it("reads the slice off the PRD branch while the token is still in hand", () => {
    const text = runner();

    expect(text.indexOf("readSliceRound(prdParent, BASE_REF)")).toBeGreaterThan(-1);
    expect(text.indexOf("readSliceRound(prdParent, BASE_REF)")).toBeLessThan(text.indexOf("scrubGitHubTokens();"));
    expect(fs.readFileSync("shared/prd-round.ts", "utf8")).toContain("sliceRanges(");
  });

  /**
   * A PRD PR's body closes the parent and every sub-issue, so the first
   * closing keyword names the parent. A slice round is about one sub-issue,
   * and is handed it as its linked issue, with its acceptance criteria (#214).
   */
  it("hands a slice round its sub-issue as the linked issue", () => {
    expect(runner()).toMatch(
      /fetchPullRequestContext\(PR_NUMBER, subIssue === undefined \? undefined : String\(subIssue\)\)/,
    );
    expect(runner()).toContain('const criteria = round?.kind === "final" ? [] : context.criteria;');
  });

  it("has no integration review, no PRD context and no slice PR left", () => {
    expect(fs.existsSync("shared/prd-context.ts")).toBe(false);
    expect(runner()).not.toContain("integration");
    expect(runner()).not.toContain("slice PR");
    expect(runner()).not.toContain("agent\\/slice-");
    expect(fs.readFileSync("shared/review-output.ts", "utf8")).not.toContain("sliceParent");
  });

  it("needs no new required input, so no caller changes", () => {
    const inputs = [...runner().matchAll(/required\("([A-Z_]+)"\)/g)].map((m) => m[1]);
    expect(inputs).toEqual(["PR_NUMBER", "BRANCH", "BASE_REF"]);
  });
});

/**
 * The review's third output channel (#47). The findings themselves live in the
 * review body, where a human reads them before merging; the label is what a
 * later workflow selects on, and what removing opts a PR out of.
 *
 * Neither half of that has a runtime symptom when it breaks. A marker that
 * never goes on leaves the findings visible and unfiled — indistinguishable
 * from a review that found nothing out of scope — and a marker that goes on
 * every review makes the whole channel noise.
 */
describe("agent-review marks a PR whose review recorded follow-ups", () => {
  const markStep = (): Step | undefined =>
    writerStepsOf(REVIEW).find((s) => (s.run ?? "").includes("--add-label \"agent:follow-ups\""));

  it("adds the label the review body tells the author to remove", () => {
    // Pinned as a literal on both sides of the seam: the block's opt-out line
    // is rendered from this constant and the step spends the string, and a
    // drift between them is an instruction naming a label nothing adds.
    expect(FOLLOW_UPS_LABEL).toBe("agent:follow-ups");
    expect(markStep()?.run ?? "").toContain(`--add-label "${FOLLOW_UPS_LABEL}"`);
  });

  /**
   * When, and *only* when, the run recorded at least one. The runner writes
   * that file in no other case, so the file's existence is the whole condition
   * — nothing in the step can decide differently from what went into the body.
   */
  it("marks on a written record rather than on having run", () => {
    expect(markStep()?.run ?? "").toContain('[ -f "${RUNNER_TEMP}/follow_ups.md" ] || exit 0');
  });

  /**
   * And after the review is posted. The label points at a record that lives in
   * the review body, so a marker on a PR whose review failed to post points at
   * nothing — and `success()` is what makes the step's own position mean that.
   */
  it("runs after the review has posted, and only if it did", () => {
    expect(markStep()?.if).toBe("steps.review.outcome == 'success'");

    const names = writerStepsOf(REVIEW).map((s) => s.name ?? "");

    expect(names.indexOf(markStep()?.name ?? "")).toBeGreaterThan(names.indexOf("Post PR review"));
  });

  /**
   * Never removed here. Removal is the human's opt-out gesture and, later, the
   * filing step's on-success cleanup; a step that cleared a stale marker would
   * be racing the person it exists to serve. A marker left by a later empty run
   * costs nothing either: that run records an *empty* list, which is the latest
   * list, so the merge files nothing and clears the marker itself.
   */
  it("never removes the marker", () => {
    expect(fs.readFileSync(REVIEW, "utf8")).not.toContain(`--remove-label "${FOLLOW_UPS_LABEL}"`);
  });

  /**
   * A label add that fails must not fail the review. This label is newer than
   * the six `docs/ADOPTING.md` §3 mandates, so an adopter can be current on the
   * pin and not have it — and a posted review is worth more than its marker.
   * A warning says so; `|| true` would leave a loop that silently files nothing
   * and looks healthy.
   */
  it("warns rather than failing when the label cannot be added", () => {
    const run = markStep()?.run ?? "";

    expect(run).toContain("::warning::");
    expect(run).not.toContain("|| true");
  });
});

/**
 * The verdict (#96): an outcome a maintainer can act on without reading the
 * review, posted where GitHub already shows the state of a commit.
 *
 * A commit status rather than a comment or a label, for one property neither of
 * those has — it is attached to a **commit**. A new commit carries no verdict
 * until one is posted for it, so a stale approval cannot survive a
 * push, and the status history is the only record of what past rounds said.
 *
 * Nothing here has a runtime symptom when it breaks. A status posted under the
 * wrong context is a second opinion nobody reconciles; one posted on the wrong
 * commit is a verdict about a tree that was not reviewed; and a run that fails
 * without posting one leaves the last verdict standing, which is the stale
 * "ready" this design exists to make impossible.
 */
describe("agent-review posts its verdict as a commit status", () => {
  const stepNamed = (name: string): Step | undefined =>
    [...stepsOf(REVIEW), ...writerStepsOf(REVIEW)].find((s) => s.name === name);
  const postStep = (): Step | undefined => stepNamed("Post the verdict as a commit status");
  const errorStep = (): Step | undefined => stepNamed("Post an error verdict");

  /**
   * On the commit the pre-flight settled on (#229), which is the same one the
   * checkout, the CI wait and the review's own `commitOID` are pinned to, and
   * which the review job hands the posting job as `sha` (#257). Reading the
   * payload or the live head here instead would post a verdict about a diff
   * nobody read.
   */
  it.each([
    ["the verdict", "Post the verdict as a commit status"],
    ["an error", "Post an error verdict"],
  ])("posts %s on the commit that was reviewed", (_case: string, name: string) => {
    const step = stepNamed(name);

    expect(jobOf(REVIEW).outputs?.["sha"]).toBe("${{ steps.state.outputs.sha }}");
    expect(step?.env?.["HEAD_SHA"]).toBe("${{ needs.review.outputs.sha }}");
    expect(step?.run ?? "").toContain('/statuses/${HEAD_SHA}');
  });

  /**
   * One context, and one place it is written. A reader of these statuses
   * selects on it — it is how a later round tells the loop's own verdict from
   * anything else that can post a status — so a drift between the halves is a
   * verdict nothing recognises.
   *
   * The failure arm is the exception and has to be: a run that failed wrote no
   * `verdict.json` for it to read, so that one literal is held here instead.
   */
  it("posts the verdict under the context the runner wrote", () => {
    expect(VERDICT_CONTEXT).toBe("agent-review");
    expect(postStep()?.run ?? "").toContain(".context");
    expect(postStep()?.run ?? "").toContain("context=${context}");
  });

  it("posts an error under that same context, spelled out", () => {
    expect(errorStep()?.run ?? "").toContain(`context=${VERDICT_CONTEXT}`);
  });

  /**
   * The failure arm's description is the one written here rather than in
   * `VERDICTS`, so the test that keeps those free of characters GitHub refuses
   * in a status (`422 Description doesn't accept 4-byte Unicode`, #121) cannot
   * see it.
   */
  it("spells the error's description in characters a status accepts", () => {
    const description = /-f "description=([^"]*)"/.exec(errorStep()?.run ?? "")?.[1] ?? "";

    expect(description).not.toBe("");
    expect([...description].filter((ch) => (ch.codePointAt(0) ?? 0) > 0xffff)).toEqual([]);
  });

  /**
   * A refused post is ours rather than the adopter's. The warning used to name
   * only the missing grant, so v0.3.0's rejected verdicts (a 422 on the
   * description itself) read as every adopter's misconfiguration (#121) — and
   * the grant it named is not a cause at all: a caller short of
   * `statuses: write` is refused before any job starts, so a token that reached
   * this step holds it (#146).
   */
  it("does not blame the grant when the post is refused", () => {
    const run = postStep()?.run ?? "";

    expect(run).toContain("a 422 is the status itself being refused");
    expect(run).not.toMatch(/a 403 is a caller missing/);
    expect(run).toContain("before any job starts");
  });

  /**
   * The state and the line a human reads come from the runner's own derivation,
   * read out of the file it wrote. Deriving either here would be a second
   * description of #96's table — in YAML, where nothing can unit-test it.
   */
  it("takes the state and the next step from what the runner derived", () => {
    const run = postStep()?.run ?? "";

    expect(run).toContain("${RUNNER_TEMP}/verdict.json");
    expect(run).toContain(".state");
    expect(run).toContain(".description");
  });

  /**
   * And links the review it is the verdict on, so the one line has somewhere to
   * go when a reader does want the detail. The URL is the posted review's own,
   * which only the response to the mutation carries.
   */
  it("links the review it posted, by capturing the URL the mutation returned", () => {
    const post = stepNamed("Post PR review");

    expect(post?.id).toBe("review");
    expect(post?.run ?? "").toContain(".data.addPullRequestReview.pullRequestReview.url");
    expect(post?.run ?? "").toContain('"$GITHUB_OUTPUT"');
    expect(postStep()?.env?.["REVIEW_URL"]).toBe("${{ steps.review.outputs.url }}");
    expect(postStep()?.run ?? "").toContain("target_url=");
  });

  /**
   * The review goes up through GraphQL, which is the only call that can open a
   * **file-level** thread alongside the line ones (#110; REST review-create
   * answers one with a 422, and its `comments` field is deprecated in favour of
   * `threads`). The whole request body is the runner's file, sent verbatim:
   * nothing in YAML composes a query or names a field, so the mutation has one
   * description and it is the unit-tested one.
   */
  it("posts the review as the GraphQL mutation the runner wrote", () => {
    const run = stepNamed("Post PR review")?.run ?? "";

    expect(run).toContain("gh api graphql --input");
    expect(stepNamed("Post PR review")?.env?.["PAYLOAD"]).toContain("review_payload.json");
    // `graphql`, not `/graphql`: GraphQL returns its errors with HTTP 200, and
    // it is the endpoint name that makes `gh` fail the step on one rather than
    // capturing an empty URL and posting nothing.
    expect(run).not.toContain("/graphql");
    expect(run).not.toContain("/reviews");
  });

  /**
   * And the `--jq` path is the mutation's own selection set. The two are one
   * shape written in two files, which is exactly the pair that drifts: a
   * renamed selection would leave the review posted and the verdict linking
   * nothing, with nothing failing.
   */
  it("reads the url out of the selection the mutation asks for", () => {
    const run = stepNamed("Post PR review")?.run ?? "";
    const selections = run.match(/--jq \.data\.([\w.]+)/)?.[1]?.split(".") ?? [];

    expect(selections).toHaveLength(3);
    for (const selection of selections) expect(ADD_REVIEW_MUTATION).toContain(selection);
  });

  it("posts the verdict after the review it points at, and only if that posted", () => {
    const names = writerStepsOf(REVIEW).map((s) => s.name ?? "");

    expect(postStep()?.if).toBe("steps.review.outcome == 'success'");
    expect(names.indexOf(postStep()?.name ?? "")).toBeGreaterThan(names.indexOf("Post PR review"));
  });

  /**
   * A failed run posts `error` rather than nothing. Nothing is the dangerous
   * answer: the previous verdict on this commit stays the newest, so a run that
   * died half way reads from the outside exactly like the review that
   * recommended approval.
   */
  it("posts error when the run failed", () => {
    const step = errorStep();

    // A cancelled run too, and a timed-out one is cancelled (#220): it leaves
    // the last verdict standing exactly as a failed one would. And a review
    // job that failed, which is not a failure of this job's own (#257).
    expect(step?.if).toBe(
      "needs.review.outputs.proceed == 'true' && (failure() || cancelled() || needs.review.result != 'success')",
    );
    expect(step?.run ?? "").toContain("state=error");

    // Below every step it is the arm for, the verdict's own posting included:
    // a `failure()` step covers what precedes it, so one placed beside the
    // success arm would miss the failure that leaves no status at all.
    const names = writerStepsOf(REVIEW).map((s) => s.name ?? "");

    expect(names.indexOf(step?.name ?? "")).toBeGreaterThan(
      names.indexOf(postStep()?.name ?? ""),
    );
  });

  /**
   * Neither posting may fail the run: a posted review is worth more than its
   * verdict. The cause is not the adopter's caller — one short of
   * `statuses: write` is refused before any job starts (#146), so a step that
   * ran holds the write and what lands here is GitHub refusing the status
   * itself. A warning keeps the failure visible; `|| true` would leave a loop
   * that posts no verdicts and looks healthy, which is the shape the marker
   * step above is written against too.
   */
  it.each([
    ["the verdict", "Post the verdict as a commit status"],
    ["an error", "Post an error verdict"],
  ])("warns rather than failing when %s cannot be posted", (_case: string, name: string) => {
    const run = stepNamed(name)?.run ?? "";

    expect(run).toContain("::warning::");
    expect(run).not.toContain("|| true");
  });

  /**
   * The CI half of the derivation, which the runner must not read out of the
   * prose the same step writes for the agent. One word, from the check runs'
   * own `conclusion`, with the same two exclusions the evidence above uses —
   * a queued sibling agent job is not a red check.
   */
  /**
   * Check runs are an Actions concept, and CI that reports through the
   * commit-status API has none — so a word derived from check runs alone calls
   * that commit green and lets the review recommend approving a red one
   * (#105). Both surfaces, and the verdict's **own** context skipped: it is
   * the answer this job is about to post, so counting it would feed each
   * round's verdict into the next round's evidence.
   */
  it("reads the commit's statuses as well as its check runs, minus its own", () => {
    const wait = stepsOf(REVIEW).find((s) => (s.name ?? "").startsWith("Wait for other checks"));
    const run = wait?.run ?? "";

    expect(run).toContain("commits/${HEAD_SHA}/status");
    expect(run).toContain(".[].statuses[]");
    // Held to the runner's constant, not merely to a string: the exclusion is
    // only correct because it names the context the verdict posts under.
    expect(wait?.env?.["VERDICT_CONTEXT"]).toBe(VERDICT_CONTEXT);
    expect(run).toContain("select(.context != env.VERDICT_CONTEXT)");
    // A status that has not passed has not passed — the same reading the check
    // runs get, and the step has already spent its wait. Read past the YAML's
    // own backslashes, which is what the jq inside a double-quoted shell string
    // costs and not something this assertion is about.
    const unescaped = run.replace(/\\/g, "");

    for (const state of ["failure", "error", "pending"]) {
      expect(unescaped, state).toContain(`. == "${state}"`);
    }
  });

  it("hands the runner the checks' result as a word, not as prose", () => {
    const wait = stepsOf(REVIEW).find((s) => (s.name ?? "").startsWith("Wait for other checks"));
    const agent = stepsOf(REVIEW).find((s) => (s.name ?? "") === "Run review agent");

    expect(wait?.run ?? "").toContain('${RUNNER_TEMP}/ci_result.txt');
    expect(agent?.env?.["CI_RESULT_FILE"]).toBe("${{ runner.temp }}/ci_result.txt");
    // Distinct from the evidence file: one is what the agent reads, the other
    // is what the verdict is derived from, and collapsing them would put the
    // derivation back in the prose it was taken out of.
    expect(agent?.env?.["CI_STATUS_FILE"]).toBe("${{ runner.temp }}/ci_status.md");
  });
});

/**
 * The automatic fix round (#102, and the fix-round budget of #201, PRD #200).
 * Where the verdict is the round-1 *Changes recommended* and the pull request
 * has automatic rounds left in its budget, the review workflow adds
 * `agent:fix` itself.
 *
 * This is the review → fix leg `docs/parity.md` §10 forbade outright, so every
 * bound on it is asserted here rather than left to read correctly. None has a
 * runtime symptom when it breaks and each fails differently: a job that fires
 * on the wrong verdict spends a fix round on findings a maintainer was supposed
 * to read; one that fires past the budget is the cycle the invariant exists to prevent;
 * one that never fires is a feature switched on and silently off, under a
 * verdict telling a maintainer a fix round started.
 */
describe("agent-review starts fix rounds itself, within the fix-round budget", () => {
  const AUTO_FIX_VERDICT = "changes recommended";
  /** The posting job (#257), whose hand-off step starts the round. */
  const job = (): Job => jobNamed(REVIEW, "post-review");
  const startStep = (): Step | undefined =>
    (job().steps ?? []).find((s) => (s.run ?? "").includes('--add-label "agent:fix"'));
  const budgetStep = (): Step | undefined => stepsOf(REVIEW).find((s) => s.id === "budget");
  const runnerStep = (): Step | undefined =>
    stepsOf(REVIEW).find((s) => (s.name ?? "") === "Run review agent");

  /**
   * **It selects on 🟡 plus the budget, not on a verdict key** (#297). The
   * *fix round started* key is retired, and 🟡 is one row with one line, so
   * what tells the round apart is `fix-round`: the runner's `startsFixRound`,
   * set only where the budget step said a round would start and the early
   * stop did not fire, handed over from the file the runner wrote.
   */
  it("selects on changes recommended plus the round the review asked for", () => {
    const handOff = stepsOf(REVIEW).find((s) => s.id === "verdict");

    expect(VERDICTS[AUTO_FIX_VERDICT].verdict).toBe(AUTO_FIX_VERDICT);
    expect(Object.keys(VERDICTS)).not.toContain("changes recommended, fix round started");
    expect(startStep()?.name).toBe("Start the automatic fix round");
    expect(startStep()?.if ?? "").toContain(`needs.review.outputs.verdict == '${AUTO_FIX_VERDICT}'`);
    expect(startStep()?.if ?? "").toContain("needs.review.outputs.fix-round == 'true'");
    expect(jobNamed(REVIEW, "review").outputs?.["fix-round"]).toBe("${{ steps.verdict.outputs.fix-round }}");
    expect(handOff?.run ?? "").toContain('"fix-round=\\(.fixRound != null)"');
    expect(fs.readFileSync(path.join("review", "review.ts"), "utf8")).toContain(
      "...(verdict.startsFixRound === true ? { fixRound: FIX_ROUND_STATUS } : {}),",
    );
    // No step anywhere selects on the retired key.
    for (const file of fs.readdirSync(WORKFLOW_DIR)) {
      expect(fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"), file).not.toContain("fix round started'");
    }
  });

  /**
   * **The budget, and its default** (#201, PRD #200 decision 2). The
   * repository variable `AGENT_MAX_FIX_ROUNDS`, 3 where unset, read by the
   * reusable half: `vars.*` resolves against the caller's repository, so no
   * caller carries it. Settled before the agent runs, so a value that is not a
   * non-negative integer fails the run before an agent pass is spent, into the
   * refusal file the failure comment posts as "didn't run" (#253), naming the
   * variable and the value.
   */
  it("reads the budget from AGENT_MAX_FIX_ROUNDS, default 3, and refuses a value that is not a count", () => {
    const step = budgetStep();
    const run = step?.run ?? "";
    const names = stepsOf(REVIEW).map((s) => s.name ?? "");

    expect(step?.env?.["MAX_FIX_ROUNDS"]).toBe("${{ vars.AGENT_MAX_FIX_ROUNDS }}");
    expect(run).toContain('budget="${MAX_FIX_ROUNDS:-3}"');
    expect(run).toContain('[[ ! "$budget" =~ ^[0-9]+$ ]]');
    expect(run).toContain('> "${RUNNER_TEMP}/refusal_reason.txt"');
    const refusal = run.slice(run.indexOf('[[ ! "$budget"'));
    expect(refusal).toContain(
      'refuse "The repository variable \\`AGENT_MAX_FIX_ROUNDS\\` is \\`${MAX_FIX_ROUNDS}\\`. It must be a whole number (0 or more), or delete it to use the default of 3. Then add \\`agent:review\\` again."',
    );

    // After the pre-flight, so a refusal is the ordinary failure path, and
    // before the runner, which reads the answer.
    expect(step?.if).toBe("steps.state.outputs.proceed == 'true'");
    expect(names.indexOf(step?.name ?? "")).toBeGreaterThan(stepsOf(REVIEW).findIndex((s) => s.id === "state"));
    expect(names.indexOf(step?.name ?? "")).toBeLessThan(names.indexOf("Run review agent"));

    // And no caller passes it: the reusable reads the caller's variables itself.
    for (const caller of callersOfWorkflow(REVIEW)) {
      expect(caller.job.with ?? {}, callerName(caller)).not.toHaveProperty("max-fix-rounds");
      expect(fs.readFileSync(caller.file, "utf8")).not.toContain("max-fix-rounds");
    }
  });

  /**
   * **The comparison.** A round starts where the rounds already spent are fewer
   * than the budget, and only with the loop's App or `AGENT_PAT`, since a
   * label added with the workflow token starts nothing. Rounds spent are the `agent-fix-round` statuses this loop
   * posted beside the verdicts that asked for a round (#297), matched on the
   * context (held to `FIX_ROUND_STATUS` here, so renaming it cannot silently
   * zero the count) and counted once per review, because `update-branch`
   * copies a commit's statuses on to its merge commit.
   */
  it("starts a round only while the rounds spent are fewer than the budget", () => {
    const step = budgetStep();
    const run = step?.run ?? "";

    expect(run).toContain('[ "$spent" -lt "$budget" ] && { [ "$TOKEN_SOURCE" = "app" ] || [ "$TOKEN_SOURCE" = "pat" ]; }');
    // Which token the loop writes with, from a job that never runs the agent
    // (#316, #320): naming a secret here, even to compare it, puts it on the
    // agent's runner.
    expect(step?.env?.["TOKEN_SOURCE"]).toBe("${{ needs.time-limit.outputs.token-source }}");
    expect(jobNamed(REVIEW, "time-limit").outputs?.["token-source"]).toBe("${{ steps.token.outputs.source }}");
    expect(step?.env?.["FIX_ROUND_CONTEXT"]).toBe(FIX_ROUND_STATUS.context);
    expect(step?.env?.["STARTED"]).toBeUndefined();
    expect(run).toContain(".context == env.FIX_ROUND_CONTEXT");
    // And, for one release, a 0.7.6 verdict that started a round, which has
    // no `agent-fix-round` status to count (#297).
    expect(step?.env?.["VERDICT_CONTEXT"]).toBe(VERDICT_CONTEXT);
    expect(step?.env?.["LEGACY_STARTED"]).toBe(LEGACY_FIX_ROUND_STARTED);
    expect(run).toContain(
      "(.context == env.FIX_ROUND_CONTEXT or (.context == env.VERDICT_CONTEXT and .description == env.LEGACY_STARTED))",
    );
    expect(run).toContain(".creator.login == env.LOOP_ACCOUNT");
    expect(run).toContain("sort -u");
    // An unreadable count starts nothing.
    expect(run).toMatch(/if \[ -z "\$spent" \]; then\n\s*echo "::warning::/);
    expect(run).toContain('echo "start=${start}"');

    // The runner is handed the answer, not the facts, so the line it writes
    // and the job that makes it true come from one decision.
    expect(runnerStep()?.env?.["AUTO_FIX"]).toBe("${{ steps.budget.outputs.start }}");
    expect(runnerStep()?.env?.["FIX_ROUNDS_SPENT"]).toBe("${{ steps.budget.outputs.spent }}");
    expect(runnerStep()?.env?.["FIX_ROUND_BUDGET"]).toBe("${{ steps.budget.outputs.budget }}");
  });

  /**
   * **The deprecated alias** (decision 4). `auto-fix` stays one release, a
   * string so that unset can be told from `false`, and where a caller sets it
   * it wins: `true` is a budget of 1, `false` of 0, and the run warns, naming
   * the variable that replaces it.
   */
  it("keeps auto-fix one release as an alias that wins over the variable, and warns", () => {
    const input = workflowOf(REVIEW).on?.workflow_call?.inputs?.["auto-fix"];
    const run = budgetStep()?.run ?? "";

    expect(input?.type).toBe("string");
    expect(input?.default).toBe("");
    expect(input?.required).toBeUndefined();
    expect(input?.description ?? "").toContain("Deprecated");
    expect(budgetStep()?.env?.["AUTO_FIX"]).toBe("${{ inputs.auto-fix }}");

    expect(run).toContain("true) budget=1 ;;");
    expect(run).toContain("false) budget=0 ;;");
    expect(run).toMatch(/::warning::The \\`auto-fix\\` input is deprecated[^\n]*AGENT_MAX_FIX_ROUNDS/);
    // Wins: the variable is read only where the input is empty.
    expect(run.indexOf('if [ -n "$AUTO_FIX" ]; then')).toBeGreaterThanOrEqual(0);
    expect(run.indexOf('if [ -n "$AUTO_FIX" ]; then')).toBeLessThan(run.indexOf('budget="${MAX_FIX_ROUNDS:-3}"'));
  });

  /**
   * **Never after a fix round that made no progress** (#202). The key above is
   * unreachable from a derivation whose fix round closed none of the findings
   * it was given (`deriveVerdict`, asserted in `tests/review-output.test.ts`),
   * whatever budget is left.
   *
   * **And no round rule** (PRD #200 decision 6). The guard selected on
   * `round == '1'` and the review handed the round across; both are gone, so a
   * later round with open findings and budget left starts another.
   */
  it("cannot fire after a fix round that closed nothing, and reads no round", () => {
    const findings = { findings: [], followUps: [], fixBeforeMerge: ["the guard runs after the return"], verified: [] };
    const inputs = { ci: "green", stillOpen: 0, movedToFollowUps: 0, autoFix: true } as const;
    expect(
      deriveVerdict(findings, { ...inputs, fixRoundProgress: { given: 3, closed: 0 } }).startsFixRound,
      "a fix round that made no progress must not be able to ask for the round this job starts",
    ).toBeUndefined();
    expect(deriveVerdict(findings, { ...inputs, fixRoundProgress: { given: 3, closed: 2 } })).toMatchObject({
      verdict: AUTO_FIX_VERDICT,
      startsFixRound: true,
    });

    expect(startStep()?.if ?? "").not.toContain("outputs.round");
    // The one `round` the review hands across is which round of a PRD PR it
    // was, a slice round or the final review (PRD #222), and it is no count.
    expect(jobOf(REVIEW).outputs?.["round"]).toBe("${{ steps.round.outputs.round }}");
    expect(stepsOf(REVIEW).find((s) => s.name === "Hand the verdict to what reads it")?.run ?? "").not.toMatch(/"round=|spent|budget/);
    expect(jobOf(REVIEW).outputs?.["verdict"]).toBe("${{ steps.verdict.outputs.verdict }}");
  });

  /**
   * **Nothing writes or reads `agent:auto-fixed`** (#201). The count is the
   * pull request's own verdicts, so the marker label is retired from the
   * workflows, both caller sets, `init` and `doctor` alike.
   */
  it("neither writes nor reads the retired marker label", () => {
    const files = [
      ...workflowFiles,
      ...fs.readdirSync(CALLER_DIR).map((f) => path.join(CALLER_DIR, f)),
      ...fs.readdirSync("setup").filter((f) => f.endsWith(".ts")).map((f) => path.join("setup", f)),
      "review/review.ts",
    ];
    // `init` deletes it by name (#236), from the one list of retired labels,
    // which is the only place it may still be written.
    for (const file of files) {
      expect(
        fs.readFileSync(file, "utf8").replace(/^export const RETIRED_LABELS\b.*$/m, ""),
        file,
      ).not.toContain("agent:auto-fixed");
    }
    expect(startStep()?.if ?? "").not.toContain("labels");
    expect(runnerStep()?.env?.["AUTO_FIXED"]).toBeUndefined();
  });

  /**
   * **Decided from live state, not the event payload** (#201). The job can
   * start after a later verdict or a human's own label, so before adding
   * anything it re-reads the pull request, and adds nothing where `agent:fix`
   * is already there or the newest verdict on the head is not the one that
   * announced this round. Both checks come before the add.
   */
  it("re-reads the labels and the newest verdict, and adds nothing where either has moved on", () => {
    const step = startStep();
    const run = step?.run ?? "";
    const add = run.indexOf('gh pr edit "$PR_NUMBER" --add-label "agent:fix"');

    expect(run).toContain('gh pr view "$PR_NUMBER" --json labels,headRefOid');
    const labelled = run.indexOf('any(.labels[]; .name == "agent:fix")');
    expect(labelled).toBeGreaterThanOrEqual(0);
    expect(labelled).toBeLessThan(add);

    expect(step?.env?.["REVIEWED_SHA"]).toBe("${{ needs.review.outputs.sha }}");
    // The review this job posted itself, a few steps up (#257).
    expect(step?.env?.["REVIEW_URL"]).toBe("${{ steps.review.outputs.url }}");
    expect(jobOf(REVIEW).outputs?.["sha"]).toBe("${{ steps.state.outputs.sha }}");
    expect((job().steps ?? []).find((s) => s.id === "review")?.name).toBe("Post PR review");
    const newer = run.indexOf('!= "$REVIEW_URL" ]');
    // A moved head is not an arm of its own (#240): a clean update-branch
    // copies the verdict on to the new head, where the round still stands, and
    // an unreviewed push leaves no verdict there, which `no_round` says.
    expect(run).not.toMatch(/"\$head" != "\$REVIEWED_SHA" \]; then[^\n]*\n[^\n]*Adding nothing/);
    expect(run).toMatch(/if \[ -z "\$newest" \]; then\n\s*no_round /);
    expect(newer).toBeGreaterThanOrEqual(0);
    expect(newer).toBeLessThan(add);
    // Each "adds nothing" arm ends the job green: nothing went wrong.
    for (const arm of run.split(/\n\s*fi\n/).filter((a) => a.includes("Adding nothing."))) {
      expect(arm).toContain("exit 0");
    }
  });

  /**
   * **Say only what will happen.** The verdict has already announced a round,
   * so a round that did not start says so on the pull request, and why, and
   * the job ends red. Not `|| true` anywhere: a label this cannot add is a
   * loop that has stopped transitioning.
   */
  it("says on the pull request that no fix round started when the add fails", () => {
    const run = startStep()?.run ?? "";

    expect(run).toContain("set -euo pipefail");
    // The one tolerance is the removal before the add (#236): a label that is
    // not there is not a failure.
    expect(run.split("\n").filter((l) => l.includes("|| true"))).toEqual([
      'gh pr edit "$PR_NUMBER" --remove-label "agent:fix" || true',
    ]);
    expect(run).toMatch(
      /if ! gh pr edit "\$PR_NUMBER" --add-label "agent:fix"; then\n\s*no_round "adding \\`agent:fix\\` failed/,
    );
    const noRound = run.slice(run.indexOf("no_round() {"), run.indexOf("\n}", run.indexOf("no_round() {")));
    expect(noRound).toContain('gh pr comment "$PR_NUMBER" --body "No automatic fix round started: $1.');
    // The verdict's line no longer announces a round (#297), so the comment
    // does not say it did.
    expect(noRound).not.toContain("said one had");
    expect(noRound).toContain("exit 1");
  });

  /**
   * The two standing guards, restated rather than inherited through `needs:`:
   * the posting job is `always()`, so that a failed review still has its
   * comment written, and a status function drops the implicit "every need
   * succeeded" that would otherwise have carried both guards over.
   */
  it.each([
    ["the trigger label", "github.event.label.name == 'agent:review'"],
    ["the fork", "github.event.pull_request.head.repo.full_name == github.repository"],
  ])("restates %s guard rather than inheriting it", (_case: string, guard: string) => {
    expect(job().if ?? "").toContain(guard);
    expect(job().if ?? "").toContain("always()");
    expect(job().needs).toEqual(["time-limit", "review"]);
  });

  /**
   * **No checkout and no agent** (decision 2). This job spends the loop's
   * token, and it must not be the one that reads untrusted pull-request
   * content and runs a model over it. The two actions it uses resolve that
   * token and fetch what the review wrote, and check nothing out.
   */
  it("checks nothing out, installs nothing and runs no model", () => {
    const steps = job().steps ?? [];

    expect(steps.map((s) => s.uses).filter((uses) => uses !== undefined)).toEqual([
      "actions/download-artifact@v8",
      `jeffwlawson/agent-workflows/.github/actions/loop-token@${PIN}`,
    ]);
    for (const step of steps) {
      expect(step.run ?? "").not.toContain("npm exec");
      expect(step.run ?? "").not.toContain("claude");
    }
  });

  /**
   * …and holds the writes the review's three posting jobs held, and the status
   * write the review job held, and nothing more (#257). Not `issues: write`:
   * that covers labels on an *issue*, and the one thing this must never be
   * able to do is file work (docs/parity.md §10).
   */
  it("holds the writes the posting spends, and no others", () => {
    expect(job().permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      statuses: "write",
    });
  });

  /**
   * MUST use the loop's App or `AGENT_PAT`: a label added with `GITHUB_TOKEN`
   * fires no `labeled` event. The budget step starts no round without one, so
   * the resolver's fallback here is for the comment alone.
   */
  it("labels with the loop's token", () => {
    expect(startStep()?.env?.["GH_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
  });

  /**
   * **And this job is the only place review adds a trigger label at all.** The
   * invariant `docs/parity.md` §10 amended is about that arrow and no other, so
   * a second one added anywhere in this file — in the review job, or here — is
   * the cycle it bounds, arriving by a route nothing else would catch.
   *
   * The trigger labels are derived from the workflows' own guards rather than
   * listed, so a seventh workflow's label is covered on arrival — minus the
   * merge-gated half, whose label review has always added. `agent:follow-ups`
   * fires that workflow's `labeled` entry point and it refuses an open pull
   * request outright (#50), so it starts no run on the pull request being
   * reviewed. It is a marker this workflow writes for a later one to read, and
   * the arrow this test is about is the one that comes back here.
   */
  it("is the only place in the workflow that adds a label something fires on", () => {
    const triggers = new Set(
      runnerWorkflows
        .filter((file) => !MERGE_GATED.includes(file))
        .flatMap((file) =>
          [...(guardJobOf(file).if ?? "").matchAll(/github\.event\.label\.name == '(agent:[a-z-]+)'/g)].map(
            ([, label]) => label ?? "",
          ),
        ),
    );

    expect(triggers.size).toBeGreaterThan(0);
    const added = [...new Set(
      [...fs.readFileSync(REVIEW, "utf8").matchAll(/--add-label "(agent:[a-z-]+)"/g)].map(
        ([, label]) => label ?? "",
      ),
    )].filter((label) => triggers.has(label));

    // The second is the review asking for itself again (#236), which is no
    // arrow of the loop's: only where the head moved on from the commit it
    // reviewed while it worked, which nothing in the loop does, since every
    // run that pushes shares the review job's concurrency group. A human
    // pushed. The PRD chain's advance is not a label on the pull request
    // under review at all: it goes on the PRD PR's **parent issue**, through
    // `gh issue edit`, from the `advance-prd` action the `advance` job runs.
    expect([...added].sort()).toEqual(["agent:fix", "agent:review"]);
    // …and never in the review job, which writes nothing at all (#257).
    for (const step of stepsOf(REVIEW)) {
      expect(step.run ?? "").not.toContain("--add-label");
    }
    const rerequests = (job().steps ?? []).filter((s) => (s.run ?? "").includes('--add-label "agent:review"'));
    expect(rerequests.map((s) => s.name)).toEqual(["Always remove the trigger label"]);
    const run = rerequests[0]?.run ?? "";
    expect(run.indexOf('[ "$head" = "$LEFT_SHA" ]')).toBeLessThan(run.indexOf('--add-label "agent:review"'));
    expect(rerequests[0]?.env?.["LEFT_SHA"]).toBe("${{ needs.review.outputs.sha }}");
    expect(jobOf(REVIEW).concurrency?.group).toBe("agent-pr-${{ github.event.pull_request.number }}");
    expect(startStep()).toBeDefined();
    for (const step of job().steps ?? []) {
      expect(step.run ?? "").not.toContain('--add-label "agent:implement"');
    }
    expect(fs.readFileSync(ADVANCE_ACTION, "utf8")).toContain(
      'gh issue edit "$parent" --add-label "agent:implement"',
    );
  });

  /**
   * **Draft means the loop is still working** (decision 4). A pull request
   * whose fix round is about to start is not the human's turn. Predicted from
   * the same verdict key the job selects on, so the draft state and the job
   * cannot disagree.
   */
  it("leaves the pull request in draft exactly when the fix round is starting", () => {
    const ready = (job().steps ?? []).find((s) => (s.name ?? "") === "Mark PR ready for review");
    const condition = (ready?.if ?? "").replace(/\s+/g, " ").trim();

    expect(condition.startsWith(
      `steps.review.outcome == 'success' && ` + `needs.review.outputs.fix-round != 'true' && `,
    )).toBe(true);
  });

  /**
   * The wire the two halves meet on: the runner derives the key and writes it
   * into `verdict.json`; one step lifts it into a job output; the job and the
   * draft step read it back. A job cannot read another job's `RUNNER_TEMP`,
   * and nothing in YAML may re-derive the key: that would be a second copy of
   * #96's table where nothing can test it.
   */
  it("carries the key out of the file the runner wrote, deriving nothing", () => {
    const hand = stepsOf(REVIEW).find((s) => s.id === "verdict");

    expect(hand?.if).toBe("steps.state.outputs.proceed == 'true' && success()");
    expect(hand?.run ?? "").toContain("${RUNNER_TEMP}/verdict.json");
    expect(hand?.run ?? "").toContain("verdict=");
    expect(hand?.run ?? "").toContain("fix-round=");
    expect(hand?.run ?? "").not.toMatch(/(^|[^-])round=/);
    // A run that wrote no file hands over nothing, and this job does not run.
    expect(hand?.run ?? "").toContain('[ -f "$file" ]');
  });

  /**
   * **The record a round is counted by** (#297). The verdict's line is the
   * same whether or not a round starts, so the posting step writes the
   * `agent-fix-round` status beside it, out of the same file and linking the
   * same review, and the hand-off starts no round whose record is missing:
   * a round the budget cannot see is one nothing bounds.
   */
  it("posts the fix-round record beside the verdict, and starts no round without it", () => {
    const post = (job().steps ?? []).find((s) => (s.name ?? "") === "Post the verdict as a commit status");
    const run = post?.run ?? "";

    expect(run).toContain(`jq -e '.fixRound != null' "\${RUNNER_TEMP}/verdict.json"`);
    expect(run).toContain('-f "context=$(jq -r .fixRound.context "${RUNNER_TEMP}/verdict.json")"');
    expect(run).toContain('record+=(-f "target_url=${REVIEW_URL}")');
    expect(run).not.toContain("agent-fix-round\"");

    const start = startStep();
    expect(start?.env?.["FIX_ROUND_CONTEXT"]).toBe(FIX_ROUND_STATUS.context);
    expect(start?.run ?? "").toContain(
      ".context == env.FIX_ROUND_CONTEXT and .creator.login == env.LOOP_ACCOUNT and .target_url == env.REVIEW_URL",
    );
    const run2 = start?.run ?? "";
    expect(run2.indexOf("env.FIX_ROUND_CONTEXT")).toBeLessThan(run2.indexOf('--add-label "agent:fix"'));
    expect(FIX_ROUND_STATUS.description.length).toBeLessThanOrEqual(140);
  });

  /**
   * In no concurrency group: the `agent-pr-*` waiter slot has depth 1 and holds
   * the newest arrival, so joining would let this job evict a fix a human
   * queued while the review ran, or be evicted itself and post nothing.
   */
  it("joins no concurrency group", () => {
    expect(job().concurrency).toBeUndefined();
  });

  /**
   * And both caller sets move with it: neither offers the deprecated input,
   * and both name the variable instead. This repository's caller kept
   * `auto-fix: true` while its pin predated the budget, and it then capped
   * every pull request here at one round of three (#296); the alias wins
   * wherever it is passed, so no caller set carries it.
   */
  it("names the variable in both caller sets, and passes the deprecated input in neither", () => {
    for (const caller of callersOfWorkflow(REVIEW)) {
      const text = fs.readFileSync(caller.file, "utf8");
      expect(caller.job.with?.["auto-fix"], callerName(caller)).toBeUndefined();
      expect(text, caller.file).not.toMatch(/auto-fix:/);
      expect(text, caller.file).toContain("AGENT_MAX_FIX_ROUNDS");
    }
  });
});

/**
 * The fix round closes itself out (#96): a push asks for the review of what it
 * pushed, instead of leaving a pull request whose verdict says "add agent:fix"
 * on a branch where the fix has already landed.
 *
 * This is the `agent:fix` → `agent:review` leg that `docs/parity.md` §10
 * already calls safe, and the bounds it rests on are the fix-round budget
 * (#201) and the early stop (#202): the review this asks for starts another
 * round only within the budget, and never after a round that closed none of
 * its findings (`deriveVerdict`). (Not "review adds no trigger label of its
 * own", which stopped being true at #102, and no longer the round rule, which
 * PRD #200 retired.)
 *
 * Nothing here has a runtime symptom when it breaks, which is why it is
 * asserted against the workflow text. A request that never fires leaves a
 * pushed fix sitting unreviewed and looking finished; one that fires on a run
 * that pushed *nothing* asks for a review of a branch that did not move, which
 * re-reviews the same commit and re-posts the verdict that already stood.
 */
describe("agent-fix asks for the re-review its own push needs", () => {
  const FIX = path.join(WORKFLOW_DIR, "fix.yml");
  const stepNamed = (name: string): Step | undefined => stepsOf(FIX).find((s) => s.name === name);
  const request = (): Step | undefined => stepNamed("Request re-review");

  /**
   * Both arms of the push write the output, not just the one that pushed. An
   * unset output is indistinguishable from a step that never ran, and those two
   * differ in exactly what this gate has to know.
   */
  it("reports whether the branch actually moved", () => {
    const push = stepNamed("Push branch");

    expect(push?.id).toBe("push");
    expect(push?.run ?? "").toContain('echo "pushed=true"');
    expect(push?.run ?? "").toContain('echo "pushed=false" >> "$GITHUB_OUTPUT"');
  });

  /**
   * On a PRD PR, whatever it pushed (PRD #222): asserted with the PRD chain's
   * other rules, below.
   */
  it("requests the review only when the fix pushed something or posted a note", () => {
    expect((request()?.if ?? "").replace(/\s+/g, " ").trim()).toBe(
      "needs.fix.result == 'success' && success() && (steps.push.outputs.pushed == 'true' || steps.notes.outputs.posted == 'true' || (startsWith(github.event.pull_request.head.ref, 'agent/prd-') && steps.push.outputs.pushed == 'false'))",
    );
    expect(request()?.run ?? "").toContain('--add-label "agent:review"');
  });

  /**
   * **A run that pushed nothing but posted an out-of-scope note asks for a
   * re-review** (#213), because the review is what rules on the note: filed on
   * merge, or dropped with a reason. Unreviewed, a note is filed by nobody,
   * which is the loss jeffwlawson/mealie-mcp-server#82 showed.
   *
   * `posted` is written on both arms and is true only where a note actually
   * went up: one that failed to post is one no review can rule on.
   */
  it("posts the notes in a step that says whether any went up", () => {
    const notes = stepNamed("Post out-of-scope notes");

    expect(notes?.id).toBe("notes");
    expect(notes?.env?.["NOTES"]).toBe("${{ runner.temp }}/out_of_scope_notes.json");
    expect(notes?.run ?? "").toContain("posted=false");
    expect(notes?.run ?? "").toContain('echo "posted=${posted}" >> "$GITHUB_OUTPUT"');
    const post = notes?.run ?? "";
    expect(post.indexOf("posted=true")).toBeGreaterThan(post.indexOf('if gh pr comment "$PR_NUMBER"'));
  });

  /** A run that only posted notes moved no head, so it has no commit to wait for. */
  it("waits for the pushed head only where it pushed", () => {
    const run = request()?.run ?? "";

    expect(request()?.env?.["PUSHED"]).toBe("${{ steps.push.outputs.pushed }}");
    expect(run.indexOf('if [ "$PUSHED" = "true" ]; then')).toBeGreaterThan(-1);
    expect(run.indexOf('if [ "$PUSHED" = "true" ]; then')).toBeLessThan(run.indexOf("--json headRefOid"));
  });

  /**
   * **And the other arm hands the pull request back** (#159). Draft means the
   * loop is still working (`docs/parity.md` §10), and since #102 review leaves
   * a pull request whose automatic fix is about to start in draft, on the
   * reading that the re-review at the end of the round marks it ready. A round
   * that declines every finding pushes nothing and asks for nothing, so no
   * re-review comes: without this arm that pull request is a draft with no
   * state label, under a verdict saying a fix round started and a re-review
   * follows.
   *
   * The two arms partition the success path on the same output, which is what
   * makes "the loop marks it ready when it hands it back" a rule rather than
   * two steps that happen not to overlap.
   */
  const ready = (): Step | undefined => stepNamed("Mark PR ready for review");

  it("marks the pull request ready exactly where it asks for no review", () => {
    expect((ready()?.if ?? "").replace(/\s+/g, " ").trim()).toBe(
      "needs.fix.result == 'success' && success() && steps.push.outputs.pushed != 'true' && steps.notes.outputs.posted != 'true' && steps.nothing.outputs.nothing != 'true' && !startsWith(github.event.pull_request.head.ref, 'agent/prd-')",
    );
    expect(ready()?.run ?? "").toContain('gh pr ready "$PR_NUMBER"');
  });

  /**
   * MUST use the loop's App or `AGENT_PAT`, for the reason review's own step
   * does: `GITHUB_TOKEN` cannot convert a draft at all, whatever it is granted. A warning rather
   * than a failure, also for review's reason — by this point every thread has
   * its reply, and a pull request stuck in draft is not worth failing the run
   * that answered them.
   */
  it("marks it ready with the loop's token, and warns rather than failing without the App or the PAT", () => {
    expect(ready()?.env?.["GH_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
    expect(ready()?.run ?? "").toContain("::warning::");
    expect(ready()?.run ?? "").not.toContain("|| true");
  });

  /**
   * And a run that **failed** leaves it a draft, which is the half of the
   * invariant that predates all of this: a draft agreeing with `agent:blocked`
   * is the second signal that the pipeline did not complete. `success()` is
   * what carries that, in both arms.
   */
  it("leaves a failed run's pull request in draft", () => {
    expect(ready()?.if ?? "").toContain("success()");
  });

  /**
   * Last of the success arms. The review reads the feedback on the pull
   * request, so a request made before the replies and the top-level comments
   * are posted starts a round that reads the round before it.
   */
  it("asks only once this run has said everything it has to say", () => {
    const names = stepsOf(FIX).map((s) => s.name ?? "");

    for (const earlier of [
      "Reply to review threads",
      "Post conversation comment outcomes",
      "Post top-level comments",
      "Post out-of-scope notes",
    ]) {
      // `toContain` first: a renamed step makes `indexOf` return -1, which every
      // "is after" assertion passes vacuously.
      expect(names).toContain(earlier);
      expect(names.indexOf("Request re-review")).toBeGreaterThan(names.indexOf(earlier));
    }
  });

  /**
   * The same PAT requirement every label transition in this loop carries: a
   * label added with `GITHUB_TOKEN` triggers nothing, so the pull request would
   * carry `agent:review` and simply sit there — the silent no-op
   * `implement-prd`'s two adds are warned about in the same words.
   */
  /**
   * In the log **and** on the pull request (#105). A warning annotation is on a
   * run nobody opens, and what it contradicts is the verdict line the
   * maintainer acted on: "a re-review follows automatically" is what they were
   * told, and without the PAT the label goes on and nothing fires.
   */
  it("says on the pull request, not only in the log, that no review will start", () => {
    const run = request()?.run ?? "";

    expect(request()?.env?.["GH_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
    expect(request()?.env?.["TOKEN_SOURCE"]).toBe("${{ steps.token.outputs.source }}");
    expect(run).toContain("::warning::");
    expect(run).toContain("gh pr comment");
    expect(run).toContain("AGENT_PAT");
    // Inside the arm that knows there is no PAT, not on every run: a comment
    // on the pull requests where the re-review *did* start is noise on the
    // channel this one needs to be read on.
    const arm = run.slice(run.indexOf('if [ "$TOKEN_SOURCE" != "app" ] && [ "$TOKEN_SOURCE" != "pat" ]'));

    expect(arm).toContain("gh pr comment");
  });

  /**
   * …and fails the run when the add itself fails, naming the way out. The
   * failure comment's generic remedy — re-add `agent:fix` — is the wrong one
   * here: this run's threads are answered and resolved, so a second fix run
   * finds nothing trusted to act on and refuses. Without the reason file the
   * comment reads `(no reason file written)`, which is the signature of a run
   * that never reached the runner at all.
   */
  it("fails with a reason a human can act on rather than swallowing the add", () => {
    const run = request()?.run ?? "";

    expect(run).toContain("set -euo pipefail");
    expect(run).toContain("failure_reason.txt");
    expect(run).toContain("exit 1");
    // The two tolerances are removals (#236): this run's own label, which
    // comes off before the next step's goes on, and the removal before the
    // add. A label that is not there is not a failure.
    expect(run.split("\n").filter((l) => l.includes("|| true"))).toEqual([
      'gh pr edit "$PR_NUMBER" --remove-label "agent:fix" || true',
      'gh pr edit "$PR_NUMBER" --remove-label "agent:review" || true',
    ]);
  });

  /**
   * And the comment that reports a failure stops contradicting the reason it
   * just wrote (#105). The step above writes "re-adding `agent:fix` would …
   * refuse" and the failure comment appended its fixed "Re-add `agent:fix` to
   * retry" underneath it — one comment, two opposite instructions, on the one
   * surface a blocked pull request is read from. Now the remedy comes from
   * whether the branch moved, the way `update-branch`'s does.
   */
  it("does not tell a human to re-add the label after its threads are answered", () => {
    const blocked = stepNamed("Mark blocked on failure");

    expect(blocked?.env?.["PUSHED"]).toBe("${{ steps.push.outputs.pushed }}");
    expect(blocked?.run ?? "").toContain('"$PUSHED" = "true"');
  });

  /**
   * Nor after its out-of-scope notes are posted (#213): a second fix run would
   * answer the same threads again, and what is missing is the review that
   * rules on the notes.
   */
  it("sends a run that posted notes to the review, not back to the fix", () => {
    const blocked = stepNamed("Mark blocked on failure");
    const run = blocked?.run ?? "";
    const arm = run.slice(run.indexOf('elif [ "$NOTED" = "true" ]; then'));

    expect(blocked?.env?.["NOTED"]).toBe("${{ steps.notes.outputs.posted }}");
    expect(arm).toContain("add \\`agent:review\\`");
  });
});

/**
 * A refresh moves the branch, and a verdict is per commit — so without this
 * every merge into a base branch wipes the verdict off every open pull request
 * that refreshes against it (#99), and the trial of whether the verdicts can be
 * trusted is read off pull requests carrying none.
 *
 * Two paths, opposite answers, settled by #96's decision 6. A clean merge
 * reviewed nothing and changed nothing the review read, so the verdict standing
 * on the old head is still true of the new one and is copied verbatim. A
 * conflict resolution is the loop writing code no review has seen, so nothing is
 * copied and a review is asked for instead, one that follows no fix round
 * unless the latest verdict started one (`shared/review-round.ts`, #202).
 *
 * Neither has a runtime symptom when it breaks. A copy that never fires leaves a
 * refreshed pull request looking unreviewed, which is merely the cost of the
 * feature being off; a copy that fired on the conflicts path would put "ready to
 * merge" on code an agent wrote and nobody read.
 */
/**
 * A PRD PR's round ends in **one advance job**, in `review` (PRD #222). Each
 * slice of a PRD is reviewed in a slice round on the PRD PR, and the next slice
 * is built only after an approval. On a slice round's approval the job re-adds
 * `agent:implement` to the parent; on any other ending but a fix round
 * starting, a slice round's or the final review's, it posts the park comment
 * there. `fix` carries no copy: on a PRD PR every fix run ends by asking for a
 * review, so every ending of a round is a verdict, and every verdict lands
 * here.
 *
 * Nothing here has a runtime symptom when it breaks. An advance that never
 * fires is a chain that stops after one slice looking finished; one that fires
 * on a fix round starting builds the next slice under one still being fixed;
 * one that fires from the final review starts a run with nothing to build; and
 * a park that never posts is a chain that stopped and said so nowhere.
 */
describe("a PRD PR's round ends in one advance job", () => {
  const FIX = path.join(WORKFLOW_DIR, "fix.yml");
  const job = (): Job => jobNamed(REVIEW, "advance");
  const flat = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
  const step = (name: string): Step | undefined => (job().steps ?? []).find((s) => s.name === name);
  const advanceStep = (): Step | undefined => step("Advance the PRD chain");
  const parkStep = (): Step | undefined => step("Park the PRD chain");

  interface Action {
    readonly inputs?: Record<string, { readonly required?: boolean }>;
    readonly runs?: { readonly using?: string; readonly steps?: readonly Step[] };
  }
  /** What advancing is: `.github/actions/advance-prd`. */
  const action = (): Action => parse(fs.readFileSync(ADVANCE_ACTION, "utf8")) as Action;
  const script = (): string => action().runs?.steps?.[0]?.run ?? "";

  it("is exactly one job, in review: fix has no advance, and review no advance-merged", () => {
    const holders = runnerWorkflows.flatMap((file) =>
      Object.keys(workflowOf(file).jobs)
        .filter((id) => id.startsWith("advance"))
        .map((id) => `${path.basename(file)} ${id}`),
    );

    expect(holders).toEqual(["review.yml advance"]);
    expect(workflowOf(FIX).jobs).not.toHaveProperty("advance");
    expect(workflowOf(REVIEW).jobs).not.toHaveProperty("advance-merged");
    // And it is the one thing that runs the advance action.
    const users = runnerWorkflows.filter((file) => fs.readFileSync(file, "utf8").includes("/actions/advance-prd@"));
    expect(users).toEqual([REVIEW]);
    expect((job().steps ?? []).filter((s) => (s.uses ?? "").includes("/actions/advance-prd@"))).toHaveLength(1);
  });

  /**
   * On a PRD PR, recognised by its head, from this repository, on the review's
   * own label: the review job's guards, restated, because `always()` drops
   * them. `always()` because a failed review or a failed post is an ending
   * too, and the one a maintainer most needs told about.
   */
  it("fires on a same-repo PRD PR's agent:review, after the posting job, however it ended", () => {
    const condition = flat(job().if);

    expect(condition).toContain("always()");
    expect(condition).toContain("github.event.label.name == 'agent:review'");
    expect(condition).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(condition).toContain("startsWith(github.event.pull_request.head.ref, 'agent/prd-')");
    expect(job().needs).toEqual(["review", "post-review"]);
  });

  /**
   * Not on a refusal, which ended no round; and not where the head moved while
   * the review ran, since the review of the new head decides (#236).
   */
  it("stands down on a refusal and on a head that moved", () => {
    const condition = flat(job().if);

    expect(condition).toContain("needs.review.outputs.proceed == 'true'");
    expect(condition).toContain("needs.post-review.outputs.moved != 'true'");
    expect(jobNamed(REVIEW, "post-review").outputs?.["moved"]).toBe("${{ steps.trigger.outputs.moved }}");
  });

  /**
   * **Only a slice round's approval advances**, and only where the review and
   * its posting both finished: a verdict that was never posted approves
   * nothing. Never from the final review, after which the PRD PR is the
   * maintainer's to merge.
   */
  it("advances only on a slice round's approval, never from the final review", () => {
    const condition = flat(advanceStep()?.if);
    const keys = [...condition.matchAll(/needs\.review\.outputs\.verdict == '([^']+)'/g)].map(([, key]) => key);

    expect(keys).toEqual(["approval recommended"]);
    expect(condition).toContain("needs.review.outputs.round == 'slice'");
    expect(condition).not.toContain("final");
    expect(condition).toContain("needs.review.result == 'success'");
    expect(condition).toContain("needs.post-review.result == 'success'");
    expect(condition).not.toContain("||");
    expect(condition).not.toContain("!=");
  });

  /**
   * **Every other ending parks**, but a fix round starting: the round has not
   * ended, and the fix run's re-review comes back here. Every verdict key is
   * one of the three, so a fourth row added to the table arrives here as a
   * decision rather than as a gap.
   */
  it("parks on every other ending, but does nothing on a fix round starting", () => {
    expect(flat(parkStep()?.if)).toBe(
      "!cancelled() && !(needs.review.result == 'success' && needs.post-review.result == 'success' && " +
        "(needs.review.outputs.verdict == 'approval recommended' || " +
        "(needs.review.outputs.verdict == 'changes recommended' && needs.review.outputs.fix-round == 'true')))",
    );
    // Spared whatever else holds: a key the condition does not also tie to
    // `fix-round`. 🟡 is spared only where a round starts (#297).
    const spared = [...flat(parkStep()?.if).matchAll(/verdict == '([^']+)'(?! && needs\.review\.outputs\.fix-round)/g)].map(
      ([, key]) => key ?? "",
    );
    const parked = Object.keys(VERDICTS).filter((key) => !spared.includes(key));
    expect(parked.sort()).toEqual(["changes recommended", "needs a closer look"]);
  });

  /**
   * A mint that fails (#330 review) skips the advance, which needs the token,
   * and a step after it says so on the PRD PR for the same ending, with the
   * workflow token. The park runs anyway, on `!cancelled()`, and reads the
   * mint's outcome to post on the PRD PR instead of the parent.
   */
  it("says on the PRD PR when a failed mint stopped the advance or the park reaching the parent", () => {
    const said = step("Say the PRD chain did not advance");
    const advance = flat(advanceStep()?.if);

    expect(flat(said?.if)).toBe(`failure() && steps.token.outcome == 'failure' && ${advance}`);
    expect(said?.env?.["GH_TOKEN"]).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(parkStep()?.env?.["TOKEN_OUTCOME"]).toBe("${{ steps.token.outcome }}");
    const run = parkStep()?.run ?? "";
    expect(run.indexOf('if [ "$TOKEN_OUTCOME" = "failure" ]; then')).toBeGreaterThan(0);
    expect(run.indexOf('if [ "$TOKEN_OUTCOME" = "failure" ]; then')).toBeLessThan(run.indexOf('GH_TOKEN="$LOOP_TOKEN"'));
  });

  /**
   * The comment is the runner's, rendered by a tested function and handed over
   * as an artifact the review job uploads however it ended: `park.md` for a
   * verdict, `park_failed.md` for a run that did not finish. The findings this
   * round raised link the review, whose URL exists only once it is posted.
   */
  it("posts the comment the runner wrote, with the posted review's URL filled in", () => {
    const run = parkStep()?.run ?? "";
    const upload = stepsOf(REVIEW).find((s) => s.name === "Hand the park comment to the advance job");

    expect(upload?.uses).toBe("actions/upload-artifact@v7");
    expect(flat(upload?.if)).toBe("always() && steps.round.outputs.round != ''");
    expect(upload?.with?.["name"]).toBe("agent-review-park");
    expect(upload?.with?.["path"]).toContain("park.md");
    expect(upload?.with?.["path"]).toContain("park_failed.md");
    expect(upload?.with?.["path"]).toContain("park_posted.md");
    expect(step("Fetch the park comment")?.with?.["name"]).toBe("agent-review-park");
    expect(step("Fetch the park comment")?.["continue-on-error"]).toBe(true);

    expect(run).toContain('file="${RUNNER_TEMP}/park_failed.md"');
    expect(run).toContain('file="${RUNNER_TEMP}/park.md"');
    expect(parkStep()?.env?.["ENDED"]).toBe(
      "${{ needs.review.result == 'success' && needs.post-review.result == 'success' }}",
    );
    expect(parkStep()?.env?.["REVIEWED"]).toBe("${{ needs.review.result == 'success' }}");
    // A posting job that failed after the verdict went up parks on that
    // verdict, not on "no verdict": the posted review's URL is what says so.
    expect(run).toContain(
      'elif [ "$REVIEWED" = "true" ] && [ -n "$REVIEW_URL" ]; then\n  file="${RUNNER_TEMP}/park_posted.md"',
    );
    expect(parkStep()?.env?.["REVIEW_URL_SLOT"]).toBe(REVIEW_URL_SLOT);
    expect(parkStep()?.env?.["REVIEW_URL"]).toBe("${{ needs.post-review.outputs.review-url }}");
    expect(jobNamed(REVIEW, "post-review").outputs?.["review-url"]).toBe("${{ steps.review.outputs.url }}");
    expect(run).toContain('body="${body//"$REVIEW_URL_SLOT"/"$REVIEW_URL"}"');
  });

  /**
   * On the parent, which is an issue, so with the loop's App or `AGENT_PAT`:
   * the workflow token holds no issue scope here. Without either the comment
   * goes on the PRD PR. The
   * post is under `bash -e` with no `||`: a chain that parked without saying so
   * is what this exists to end.
   */
  it("parks on the parent with the loop's token, and on the PRD PR without the App or the PAT", () => {
    const run = parkStep()?.run ?? "";

    expect(run).toContain("set -euo pipefail");
    expect(run).toContain("^agent/prd-([0-9]+)-");
    expect(parkStep()?.env?.["LOOP_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
    expect(parkStep()?.env?.["TOKEN_SOURCE"]).toBe("${{ steps.token.outputs.source }}");
    const noPat = run.indexOf('if [ "$TOKEN_SOURCE" != "app" ] && [ "$TOKEN_SOURCE" != "pat" ]; then');
    const post = run.indexOf('GH_TOKEN="$LOOP_TOKEN" gh issue comment "$parent" --body "$body"');
    expect(noPat).toBeGreaterThanOrEqual(0);
    expect(post).toBeGreaterThan(noPat);
    const arm = run.slice(noPat, run.indexOf("\nfi", noPat));
    expect(arm).toContain('gh pr comment "$PR_NUMBER"');
    expect(arm).toContain("exit 0");
    expect(run.slice(post).split("\n")[0]).not.toContain("||");
  });

  it("checks nothing out, installs nothing and runs no model", () => {
    expect((job().steps ?? []).map((s) => s.uses).filter((uses) => uses !== undefined)).toEqual([
      "actions/download-artifact@v8",
      `jeffwlawson/agent-workflows/.github/actions/loop-token@${PIN}`,
      `jeffwlawson/agent-workflows/.github/actions/advance-prd@${PIN}`,
    ]);
    for (const s of [...(job().steps ?? []), ...(action().runs?.steps ?? [])]) {
      expect(s.run ?? "").not.toContain("npm exec");
      expect(s.run ?? "").not.toContain("claude");
      expect(s.run ?? "").not.toContain("git ");
    }
    expect(action().runs?.using).toBe("composite");
    expect(action().runs?.steps).toHaveLength(1);
    expect(action().runs?.steps?.[0]?.uses).toBeUndefined();
  });

  /**
   * **No new grant.** One scope, for the no-PAT comment on the PRD PR; the
   * parent is written with the loop's App or the PAT, or not at all, so `issues: write` stays out
   * of this job and out of every caller's grant, which already holds what it
   * does. The callers grant `issues: read`, for the review job's reads (#348),
   * and that is all they grant of it.
   */
  it("holds only what it needs, and asks no caller for more", () => {
    expect(job().permissions).toEqual({ "pull-requests": "write" });
    expect(job().concurrency).toBeUndefined();
    for (const caller of callersOfWorkflow(REVIEW)) {
      expect(caller.job.permissions?.["pull-requests"], callerName(caller)).toBe("write");
      expect(caller.job.permissions?.["issues"], callerName(caller)).toBe("read");
    }
  });

  /**
   * MUST use the loop's App or `AGENT_PAT`: `agent:implement` added with
   * `GITHUB_TOKEN` starts nothing. So without either nothing is added, and the
   * PRD PR is told which re-label advances the chain by hand. The add itself
   * is under `bash -e`.
   */
  it("advances by labelling the parent with the loop's token, and comments when it is the workflow token", () => {
    const s = advanceStep();
    const run = script();

    expect(s?.with?.["token"]).toBe("${{ steps.token.outputs.token }}");
    expect(s?.with?.["token-source"]).toBe("${{ steps.token.outputs.source }}");
    expect(action().runs?.steps?.[0]?.env?.["TOKEN_SOURCE"]).toBe("${{ inputs.token-source }}");
    expect(s?.with?.["pr-number"]).toBe("${{ github.event.pull_request.number }}");
    expect(s?.with?.["head-ref"]).toBe("${{ github.event.pull_request.head.ref }}");
    const inputs = Object.keys(action().inputs ?? {});
    expect(inputs.sort()).toEqual(Object.keys(s?.with ?? {}).sort());
    for (const input of inputs) expect(action().inputs?.[input]?.required).toBe(true);
    expect(action().runs?.steps?.[0]?.env?.["GH_TOKEN"]).toBe("${{ inputs.token }}");
    expect(run).toContain("set -euo pipefail");
    expect(run).toContain("^agent/prd-([0-9]+)-");

    const noPat = run.indexOf('if [ "$TOKEN_SOURCE" != "app" ] && [ "$TOKEN_SOURCE" != "pat" ]; then');
    const add = run.indexOf('gh issue edit "$parent" --add-label "agent:implement"');
    expect(noPat).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(noPat);
    const arm = run.slice(noPat, run.indexOf("\nfi", noPat));
    expect(arm).toContain('gh pr comment "$PR_NUMBER"');
    expect(arm).toContain("Re-add \\`agent:implement\\` to #${parent} by hand");
    expect(arm).toContain("exit 0");
    expect(arm).not.toContain("--add-label");
    expect(run.slice(add).split("\n")[0]).not.toContain("||");
  });

  it("leaves no slice PR reference in review or fix", () => {
    for (const file of [REVIEW, FIX, ADVANCE_ACTION]) {
      expect(fs.readFileSync(file, "utf8"), file).not.toContain("agent/slice-");
    }
  });
});

/**
 * **A PRD PR stays a draft through every slice round** (PRD #222), and every
 * ending of a round on it is a review verdict. "Ready" on a PRD PR means the
 * whole PRD is ready, so only the final review's approval marks it, from
 * `review`; a one-slice PRD is the finishing run's. And `fix` asks for a review
 * on a PRD PR whatever it pushed, so a round that declined every finding still
 * ends in a verdict the advance job reads.
 */
describe("a PRD PR's draft state and fix rounds", () => {
  const FIX = path.join(WORKFLOW_DIR, "fix.yml");
  const flat = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
  const posting = (name: string): Step | undefined =>
    (jobNamed(REVIEW, "post-review").steps ?? []).find((s) => s.name === name);
  const fixStep = (name: string): Step | undefined => stepsOf(FIX).find((s) => s.name === name);

  it("review marks a PRD PR ready only on the final review's approval", () => {
    expect(flat(posting("Mark PR ready for review")?.if)).toContain(
      "(!startsWith(github.event.pull_request.head.ref, 'agent/prd-') || " +
        "(needs.review.outputs.round == 'final' && needs.review.outputs.verdict == 'approval recommended'))",
    );
  });

  /**
   * The fix round's other way to ready, where a round the verdict announced
   * did not start: on a PRD PR that step ending red parks the chain instead.
   */
  it("review's announced-but-missing fix round leaves a PRD PR a draft", () => {
    const start = posting("Start the automatic fix round");
    const run = start?.run ?? "";
    const guard = run.indexOf('if [[ "$HEAD_REF" != agent/prd-* ]]; then');

    expect(start?.env?.["HEAD_REF"]).toBe("${{ github.event.pull_request.head.ref }}");
    expect(guard).toBeGreaterThan(-1);
    expect(run.indexOf('gh pr ready "$PR_NUMBER"')).toBeGreaterThan(guard);
    expect([...run.matchAll(/gh pr ready/g)]).toHaveLength(1);
  });

  it("fix never marks a PRD PR ready", () => {
    expect(flat(fixStep("Mark PR ready for review")?.if)).toContain(
      "!startsWith(github.event.pull_request.head.ref, 'agent/prd-')",
    );
    expect([...fs.readFileSync(FIX, "utf8").matchAll(/gh pr ready/g)]).toHaveLength(1);
  });

  /**
   * `== 'false'`, not `!= 'true'`: the push writes its output on both arms,
   * and unset is a run that never reached it, a refusal or one with nothing to
   * do, which asks for nothing.
   */
  it("fix asks for a re-review on a PRD PR whatever it pushed", () => {
    expect(flat(fixStep("Request re-review")?.if)).toContain(
      "(startsWith(github.event.pull_request.head.ref, 'agent/prd-') && steps.push.outputs.pushed == 'false')",
    );
    expect(fixStep("Request re-review")?.run ?? "").toContain('--add-label "agent:review"');
  });
});

/**
 * **The reviewer closes a thread and the fixer never does** (#109, decision 1;
 * #111). Two halves in two workflows, asserted together because either one
 * alone is a loop that loses findings: a fixer that still resolved would close
 * its own work unchecked, and a reviewer that resolved nothing would leave
 * every finding open for ever, counting against every later verdict.
 *
 * Neither half has a runtime symptom. A resolved thread is dropped from the
 * feedback the next review is handed, so a fixer closing its own threads
 * produces a review that looks clean because it cannot see what it is meant to
 * check — the failure #105 patched with a body checklist and this moved the
 * cause of.
 */
describe("the reviewer closes a thread, and the fix run never does", () => {
  const FIX = path.join(WORKFLOW_DIR, "fix.yml");
  const RESOLVE_MUTATION = "resolveReviewThread";
  const REPLY_MUTATION = "addPullRequestReviewThreadReply";
  /** The posting job (#257), which resolves before it posts. */
  const resolveJob = (): Job => jobNamed(REVIEW, "post-review");
  const resolveStep = (): Step | undefined =>
    (resolveJob().steps ?? []).find((s) => s.name === "Resolve the threads this review closed");
  const resolveRun = (): string => resolveStep()?.run ?? "";
  const handoff = (): Step | undefined => stepsOf(REVIEW).find((s) => s.name === "Hand the review to the posting job");

  /**
   * Over the file's whole text rather than its steps: the mutation is a string
   * inside a `run:` block, and what is being asserted is that no step anywhere
   * in the workflow performs it — including one added later for another reason.
   */
  it("has no step in agent-fix that resolves anything", () => {
    expect(fs.readFileSync(FIX, "utf8")).not.toContain(RESOLVE_MUTATION);
  });

  /**
   * And it still replies to every thread, which is the half that stays. "I
   * looked and declined" is worth saying out loud, and the reply is what the
   * next review reads before it rules.
   */
  it("still replies in every thread the fix run was shown", () => {
    const reply = stepsOf(FIX).find((s) => s.name === "Reply to review threads");

    expect(reply?.run ?? "").toContain(REPLY_MUTATION);
    expect(reply?.env?.["OUTCOMES"]).toBe("${{ runner.temp }}/thread_outcomes.json");
  });

  /**
   * **And the conversation gets the same report** (#104). The other surface has
   * no threads to reply into, so the outcomes are one comment on the pull
   * request, composed by the runner and posted here.
   *
   * The empty case is the one to get right, and it is why this reads `-s` rather
   * than `-f`: the runner writes the file on every run, so an empty file means
   * "no conversation comments" and an absent one means the runner never got
   * here. Posting an empty body would put a bot comment on every fix run, which
   * is the noise the top-level cap exists against.
   */
  it("records what it did with the conversation comments too", () => {
    const record = stepsOf(FIX).find((s) => s.name === "Post conversation comment outcomes");

    expect(record?.env?.["RECORD"]).toBe("${{ runner.temp }}/conversation_outcomes.md");
    expect(record?.run ?? "").toContain('[ ! -s "$RECORD" ]');
    expect(record?.run ?? "").toContain("gh pr comment");
    // A failure to post is reported and does not fail the run, as the sibling
    // reporting steps are: the fix is already pushed by this point.
    expect(record?.["continue-on-error"]).toBe(true);
  });

  /**
   * **Not in the review job** (#133). `resolveReviewThread` is refused there:
   * an installation token needs `contents: write` for it, and the review job
   * holds no write at all (#257). The step that tried it replied into every
   * thread and resolved none, for a release.
   */
  it("resolves nothing in the review job, which cannot", () => {
    for (const step of stepsOf(REVIEW)) expect(step.run ?? "").not.toContain(RESOLVE_MUTATION);
  });

  /**
   * The review job's half is a handoff: the list the runner wrote, in the
   * artifact the posting job fetches, on a review that finished (#257).
   */
  it("hands the runner's list over in the review artifact, only on a finished review", () => {
    expect(handoff()?.uses).toBe("actions/upload-artifact@v7");
    expect(handoff()?.with?.["path"] ?? "").toContain("${{ runner.temp }}/thread_resolutions.json");
    expect(handoff()?.if).toBe("steps.state.outputs.proceed == 'true' && success()");
    const fetch = (resolveJob().steps ?? []).find((s) => s.id === "fetch");
    expect(fetch?.uses).toBe("actions/download-artifact@v8");
    expect(fetch?.with?.["name"]).toBe(handoff()?.with?.["name"]);
    expect(fetch?.with?.["path"]).toBe("${{ runner.temp }}");
    expect(resolveStep()?.if).toBe("steps.fetch.outcome == 'success'");
  });

  /**
   * The posting job holds `contents: write`, so what it *cannot* do is the
   * point. It has no checkout, no toolchain and no runner, so the scope reaches
   * nothing but fixed mutations over data. One of those three added later
   * would bring the pull request's own code into a job holding the write.
   */
  it("resolves in a job with nothing to write with", () => {
    for (const step of resolveJob().steps ?? []) {
      expect(step.uses ?? "").not.toMatch(/checkout|setup-node/);
      // The runner's invocation and any git write, not the words: the warning
      // text names this repository, and that is not a checkout.
      expect(step.run ?? "").not.toMatch(/\bnpm\b|\bnpx\b|\bgit (clone|fetch|checkout|push)\b/);
    }
  });

  /**
   * And it is the only job in the file holding the write. The review job,
   * which reads untrusted content and runs the agent, stays read-only
   * (docs/parity.md §10).
   */
  it("is the only job in review.yml that can write contents", () => {
    const writers = Object.entries(workflowOf(REVIEW).jobs)
      .filter(([, job]) => job.permissions?.["contents"] === "write")
      .map(([id]) => id);

    expect(writers).toEqual(["post-review"]);
  });

  /**
   * The list is a file, read by path: a reply quotes a maintainer's words, and
   * an expression spliced into the script would make those words a script.
   */
  it("reads the list from the file the runner wrote, never interpolated", () => {
    expect(resolveStep()?.env?.["RESOLUTIONS"]).toBe("${{ runner.temp }}/thread_resolutions.json");
    expect(resolveRun()).not.toContain("${{");
  });

  /**
   * **And writes down what actually resolved** (#257): one thread id a line,
   * appended only on the arm where the resolve went through, which is what the
   * overview's *Resolved since last review* is made of.
   */
  it("records each thread it resolved, and only those", () => {
    const run = resolveRun();
    const resolve = run.lastIndexOf(RESOLVE_MUTATION);

    expect(resolveStep()?.env?.["RESOLVED"]).toBe("${{ runner.temp }}/resolved_threads.txt");
    expect(run).toContain(': > "$RESOLVED"');
    expect(run.slice(resolve)).toMatch(/if gh api graphql [^\n]*>\/dev\/null; then\n[^\n]*\n\s*echo "\$tid" >> "\$RESOLVED"\n\s*else/);
    expect(run.split('>> "$RESOLVED"')).toHaveLength(2);
  });

  /**
   * With the reason GitHub takes and then shows nobody. `resolutionReason` is
   * validated on the way in and exposed on no field afterwards, so the reply is
   * the only record of why a finding closed — which is why the reply is posted
   * and not merely offered.
   */
  it("closes it as addressed, and says so where a human can read it", () => {
    const run = resolveRun();

    expect(run).toContain("resolutionReason:ADDRESSED");
    expect(run).toContain(REPLY_MUTATION);
    expect(run.indexOf(REPLY_MUTATION)).toBeLessThan(run.indexOf(RESOLVE_MUTATION));
  });

  /**
   * **And a reply that failed takes the resolve down with it**, which ordering
   * alone does not buy: the assertion above passed for a release in which the
   * reply's failure arm was an `echo` and the thread closed anyway.
   *
   * Asserted over the text *between* the two mutations, so what is pinned is
   * "the reply's failure skips this iteration" rather than a wording.
   */
  it("leaves a thread open when the reply that is its only record failed", () => {
    const run = resolveRun();
    const between = run.slice(run.indexOf(REPLY_MUTATION), run.indexOf(RESOLVE_MUTATION));

    expect(between).toContain("continue");
    expect(between).toMatch(/::warning::Could not reply/);
  });

  /**
   * **One closing reply per thread** (#133). The reply is skipped only on the
   * literal `true` the runner writes where the thread already carries that
   * reply. Anything else posts, because a duplicate is the cheaper mistake.
   */
  it("replies only where the thread does not already carry the reply", () => {
    const run = resolveRun();
    const guard = run.indexOf('if [ "$already" = "true" ]');

    expect(run).toContain(".alreadyReplied");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(run.indexOf(REPLY_MUTATION));
    expect(run.slice(guard, run.indexOf(REPLY_MUTATION))).toContain("else");
  });

  /**
   * And as **won't fix** where a maintainer declined it (#109, decision 10;
   * #112) — a distinction this step cannot derive and must not try to. Which
   * reason a thread closes on is `verifyCarried`'s, read out of the list as the
   * reply is, and the enum is spelled out on both arms because it is an enum
   * literal in the document rather than a variable GitHub would coerce.
   */
  it("closes it as won't fix where a maintainer declined it", () => {
    const run = resolveRun();

    expect(run).toContain("resolutionReason:WONT_FIX");
    expect(run).toContain(".reason");
  });

  /**
   * A refused resolve is a warning on the run, where it used to be an `echo`
   * that a green run hid for a release. What it must **not** do is blame the
   * caller's grant: a caller granting less than this job declares fails the run
   * before any job starts, so a token that reached here holds the write and the
   * cause is something else. Printing GitHub's own reply is the answer, as it
   * is for the verdict status above.
   */
  it("warns when a resolve is refused, prints GitHub's reply, and never fails", () => {
    const run = resolveRun();
    const after = run.slice(run.lastIndexOf(RESOLVE_MUTATION));

    expect(after).toMatch(/else\n\s*echo "::warning::Could not resolve/);
    expect(after).toContain("GitHub's reply is printed above");
    expect(after).toMatch(/not the caller's .*contents:.* grant/);
    expect(run).not.toMatch(/\bexit 1\b/);
  });
});

/**
 * **The review posts last, from one job** (#257). The review job runs the model
 * and posts nothing; one job that runs no model then answers and resolves the
 * earlier findings, posts the overview and the new findings, sets the verdict,
 * marks the pull request ready, takes `agent:review` off and hands off, in that
 * order, which is the label order settled for every workflow: label on, do the
 * work, post every result, take your own label off, add the next step's label.
 * Until then the overview's *Resolved since last review* went out before
 * anything was resolved, and claimed closures that never happened wherever the
 * resolve failed.
 */
describe("the review posts last, from one job", () => {
  const posting = (): Job => jobNamed(REVIEW, "post-review");

  /**
   * The PRD chain's advance job (PRD #222) follows it on a PRD PR, and posts
   * nothing on the pull request under review but the no-PAT note.
   */
  it("has one posting job, and no resolve or auto-fix job beside it", () => {
    const jobs = Object.keys(workflowOf(REVIEW).jobs);

    expect(jobs).toEqual(["time-limit", "red-check", "review", "post-review", "advance"]);
    for (const retired of ["resolve", "auto-fix", "advance-merged"]) expect(jobs).not.toContain(retired);
  });

  /**
   * The order, step by step. The refusal and the block's removal open it; the
   * threads are resolved before the review is posted, so their replies are
   * timestamped ahead of the overview; every result, the failure arm's
   * included, is posted before the trigger label comes off; and the hand-offs
   * come after it.
   */
  it("resolves, posts, sets the verdict and the ready state, takes its label off, then hands off", () => {
    expect((posting().steps ?? []).map((s) => s.name)).toEqual([
      "Say why the review didn't run",
      "Transition labels",
      "Fetch what the review wrote",
      "Resolve the threads this review closed",
      "Post PR review",
      "Write the PR title and summary",
      "Write the PR status line",
      "Mark the PR as carrying follow-ups",
      "Post the verdict as a commit status",
      "Resolve the loop's token",
      "Mark PR ready for review",
      "Post an error verdict",
      "Mark blocked on failure",
      "Always remove the trigger label",
      "Start the automatic fix round",
    ]);
  });

  /**
   * Each posting step runs on the one before it having posted: the overview
   * only on a fetched review, and the verdict, the marker and the ready state
   * only on a posted overview, so a review that failed to post leaves the pull
   * request in draft under an error status.
   */
  it("posts each result only on the one before it", () => {
    const step = (name: string): Step | undefined => (posting().steps ?? []).find((s) => s.name === name);

    expect(step("Resolve the threads this review closed")?.if).toBe("steps.fetch.outcome == 'success'");
    expect(step("Post PR review")?.if).toBe("steps.fetch.outcome == 'success'");
    for (const name of [
      "Write the PR title and summary",
      "Mark the PR as carrying follow-ups",
      "Post the verdict as a commit status",
    ]) {
      expect(step(name)?.if, name).toBe("steps.review.outcome == 'success'");
    }
    expect(step("Mark PR ready for review")?.if ?? "").toContain("steps.review.outcome == 'success'");
    expect(step("Fetch what the review wrote")?.if).toBe(
      "needs.review.outputs.proceed == 'true' && needs.review.result == 'success'",
    );
  });

  /**
   * A refused post names the closures as they happened, not as planned: the
   * resolve step skips a thread whose reply or resolve failed, with a warning,
   * so "every thread resolved" is the claim this job exists to stop making.
   */
  it("says on a refused post that only the threads GitHub allowed were resolved", () => {
    const run = (posting().steps ?? []).find((s) => s.name === "Post PR review")?.run ?? "";
    const reason = run.split("\n").find((line) => line.includes("failure_reason.txt")) ?? "";

    expect(reason).toContain("resolved where GitHub allowed it, and the log names any that were not");
    expect(reason).not.toContain("closed are resolved");
  });

  /** And the review job writes nothing: no comment, label, status or review. */
  it("posts nothing from the job that runs the model", () => {
    for (const step of stepsOf(REVIEW)) {
      expect(step.run ?? "", step.name).not.toMatch(/gh pr (comment|edit|ready)|gh api graphql|--method POST|gh issue/);
    }
    expect(Object.values(jobOf(REVIEW).permissions ?? {})).not.toContain("write");
  });
});

describe("agent-update-branch carries the verdict, or asks for the round it made necessary", () => {
  const UPDATE = path.join(WORKFLOW_DIR, "update-branch.yml");
  const stepNamed = (name: string): Step | undefined =>
    stepsOf(UPDATE).find((s) => s.name === name);
  const push = (): Step | undefined => stepNamed("Push branch");
  const copy = (): Step | undefined => stepNamed("Carry the verdict over to the merge commit");
  const request = (): Step | undefined => stepNamed("Request a review of the resolution");

  /**
   * The push is what makes the new head exist, so it is what names it. Read
   * from `git rev-parse` in the step that pushed rather than re-read below: the
   * commit the verdict is posted on has to be the commit that was pushed, and
   * two reads of the working tree are two chances for that to stop being true.
   *
   * `pushed` is the other half, and it is written where `-e` can only mean the
   * push worked — a branch that did not move is not one to comment about as
   * though it had.
   */
  it("reports the commit it pushed, and that it pushed one", () => {
    expect(push()?.id).toBe("push");
    expect(push()?.run ?? "").toContain("pushed=true");
    // The branch's ref rather than `HEAD`: on the conflicts path the publish
    // job unbundles the resolution into the ref and never checks it out.
    expect(push()?.run ?? "").toContain('head=$(git rev-parse "refs/heads/${BRANCH}")');
  });

  it("copies the old head's verdict on to the commit it pushed", () => {
    expect(copy()?.env?.["OLD_SHA"]).toBe("${{ github.event.pull_request.head.sha }}");
    expect(copy()?.env?.["NEW_SHA"]).toBe("${{ steps.push.outputs.head }}");
    expect(copy()?.run ?? "").toContain("commits/${OLD_SHA}/statuses");
    expect(copy()?.run ?? "").toContain("/statuses/${NEW_SHA}");
  });

  /**
   * Copied, never parsed. The state, the line a human acts on and the link are
   * the review's own words about a tree this merge did not change; deriving any
   * of them here would be a second copy of the table `shared/review-output.ts`
   * holds — in YAML, where nothing can unit-test it — and one that is asked to
   * say something about a commit no review has read.
   */
  it("copies what the verdict says rather than deriving a second one", () => {
    const run = copy()?.run ?? "";

    for (const field of [".state", ".description", ".target_url"]) expect(run).toContain(field);
  });

  /**
   * And copies only the loop's own. A status is a thing any token holding
   * `statuses: write` can post under any context it likes, so the creator is
   * what stops a refresh laundering somebody else's approval on to a
   * commit — the same two conditions `verdictOn` selects on, because this writes
   * what that reads.
   */
  it("copies only a verdict this loop posted, under the context it posts under", () => {
    expect(copy()?.env?.["VERDICT_CONTEXT"]).toBe(VERDICT_CONTEXT);
    expect(isWorkflowBot(copy()?.env?.["LOOP_ACCOUNT"])).toBe(true);
    expect(copy()?.run ?? "").toContain("env.VERDICT_CONTEXT");
    expect(copy()?.run ?? "").toContain("env.LOOP_ACCOUNT");
  });

  /**
   * Posted under the job's own `GITHUB_TOKEN` rather than the PAT the push
   * prefers, and that is the whole of why the copy is worth making: a status
   * created by anything else is one `verdictOn` does not count, so the carried
   * verdict would be invisible to the round that reads it next.
   */
  it("posts the copy as the account that round detection reads", () => {
    expect(copy()?.env?.["GH_TOKEN"]).toBeUndefined();
  });

  /**
   * Nothing to copy is not a failure: a pull request nobody has reviewed yet
   * refreshes like any other, and the honest answer for its new head is the
   * absence of a verdict. Neither is a copy that could not be posted — the
   * merge has already landed and been pushed, so failing here would mark the
   * pull request blocked and tell a human the branch was left untouched.
   */
  it("posts nothing when there is nothing to carry, and never fails the run", () => {
    const run = copy()?.run ?? "";

    expect(run).toContain("set -uo pipefail");
    expect(run).toContain('if [ -z "$verdict" ]');
    expect(run).toContain("exit 0");
    expect(run).toContain("::warning::");
    expect(run).not.toContain("|| true");
  });

  /**
   * And a read that *failed* is not a commit with no verdict on it (#105).
   * Collapsed into one answer only the second is ever reported: a 5xx, a
   * secondary rate limit or a dropped connection would log "nothing to carry
   * over" and exit 0, with the warning below on the *write* and never reached,
   * and every refresh that hit one would drop the verdict with no signal
   * anywhere. It is the distinction `verdictOn` keeps as `undefined` against
   * `false`, and the CI word keeps as `unknown` against `red`.
   *
   * #105 wrote the arm for a caller predating the `statuses: write` grant,
   * 403ing here on a private repository. That caller is refused before any job
   * starts (#146), so the arm outlived its first cause — which is why the
   * assertion below is about the shape of the arm rather than about a 403.
   */
  it("says so when the statuses could not be read, rather than reading that as none", () => {
    const run = copy()?.run ?? "";
    const read = run.slice(0, run.indexOf('if [ -z "$verdict" ]'));

    // Its own arm, gated on the read rather than on what the read produced.
    expect(read).toContain('if ! statuses=$(gh api');
    // With a warning of its own — the one below is on the write, so a step
    // that gave up here would reach no warning at all.
    expect(read).toContain("::warning::");
    // And what `gh` said, which is what tells a 403 from an outage: the same
    // pair the review's CI arms use.
    expect(read).toContain('2>"$err"');
    expect(read).toContain('cat "$err"');
    // Still without failing the run: the merge is pushed by now.
    expect(read).toContain("exit 0");
  });

  /**
   * And it blames the caller's grant for none of them (#123, #146). The arm is
   * gated on the `gh` call, not on a status code, so a 5xx, a secondary rate
   * limit and a dropped connection land here — the same spread the CI arms in
   * `review.yml` keep as `unknown` rather than `red`. The grant is not among
   * them at all: a caller granting less than this job declares is refused
   * before any job starts, so a token that reached this step holds the write.
   * A warning naming the grant would send a reader whose caller is already
   * correct off to fix it, which is the failure this assertion exists to stop.
   *
   * Its own cause set, and not the write's below: a read cannot be the 422
   * that arm hedges against, and a write cannot be an outage that leaves the
   * verdict readable where it was posted.
   */
  it("does not blame the grant when the statuses could not be read", () => {
    const run = copy()?.run ?? "";
    const read = run.slice(0, run.indexOf('if [ -z "$verdict" ]'));

    expect(read).not.toMatch(/a 403 is a caller missing/);
    expect(read).toContain("before any job starts");
    expect(read).toMatch(/transient/i);
    // And what a reader does about it either way, since neither cause is one a
    // re-run of this workflow recovers from: the branch is refreshed, so the
    // next run has nothing to merge and this step never runs again.
    expect(read).toContain("agent:review");
  });

  /**
   * And it hedges in both directions. The arm is reached because the `GET`
   * failed, so "there is no verdict" is not the only thing it cannot assert —
   * neither is "a verdict stands on ${OLD_SHA}", which is the same collapse
   * the other way round. A pull request nobody has reviewed yet "refreshes
   * like any other", and told a verdict stands where none does, a reader reads
   * the remedy as an offer rather than the fix.
   */
  it("does not assert a verdict on the commit it could not read", () => {
    const run = copy()?.run ?? "";
    const read = run.slice(0, run.indexOf('if [ -z "$verdict" ]'));
    const warning = read.slice(read.indexOf("::warning::"));

    expect(warning).toContain("could not tell whether there was one");
    // The remedy is what the reader does, not an alternative to a verdict the
    // step has just said it cannot see.
    expect(warning).not.toMatch(/if you would rather/i);
  });

  /**
   * And the same on the write. This copies `.description` verbatim, so a
   * description GitHub refuses is refused here too — the 422 that lost every
   * v0.3.0 verdict (#121) would have lost every carried one as well. A warning
   * naming the grant sends the reader to their own caller for a fault that is
   * ours, and for a cause that cannot occur besides (#146); the twin assertion
   * is on `review.yml`'s post step.
   */
  it("does not blame the grant when the copy is refused", () => {
    const run = copy()?.run ?? "";

    expect(run).toContain("a 422 is the status itself being refused");
    expect(run).not.toMatch(/a 403 is a caller missing/);
    expect(run).toContain("before any job starts");
  });

  /**
   * And what a reader does about it (#132). The write has the read's gate —
   * this step runs only after a clean merge, and the merge is pushed by then —
   * so a re-run reports `uptodate` and never reaches the write again. A reader
   * who fixes the cause and re-runs is left with a head reading as unreviewed
   * and nothing naming the label that fixes it. Unlike `review.yml`'s post,
   * where a fresh review does post on the same head.
   *
   * Its own remedy rather than the read's warning copied down: the write's
   * causes are a refusal, not an outage, so it names no transient cause.
   */
  it("names agent:review when the copy is refused, since a re-run never reaches the write", () => {
    const run = copy()?.run ?? "";
    const write = run.slice(run.indexOf('gh api "${args[@]}"'));
    const warning = write.slice(write.indexOf("::warning::"));

    expect(warning).toContain("agent:review");
    expect(warning).toMatch(/re-running this workflow recovers none of it/i);
    expect(warning).not.toMatch(/transient/i);
  });

  it("asks for a review of the resolution it wrote", () => {
    expect(request()?.run ?? "").toContain('--add-label "agent:review"');
  });

  /**
   * On a PRD PR too, draft or not (#249). Every slice is reviewed as a round on
   * the draft PRD PR, so the review a resolution asks for is a round of the
   * current slice, and it is what the approval gate needs: a resolution with
   * no review leaves the head with no verdict, and the chain cannot move on.
   * The step that held the review for the retired integration review is gone,
   * and so is the marker it left, which nothing reads.
   */
  it("asks for the review on a draft PRD PR as on any other", () => {
    expect(stepsOf(UPDATE).some((s) => s.id === "prd")).toBe(false);
    expect(fs.readFileSync(UPDATE, "utf8")).not.toContain("agent-resolved-merge");
    expect(request()?.if).not.toContain("steps.prd");
  });

  /**
   * The two are opposite arms of the same merge, and the gates are what keep
   * them that way. A copy on the conflicts path is a verdict about code an
   * agent wrote unread; a request on the clean path is a review round nothing
   * happened to justify, and one that would post a fresh verdict over the
   * carried one.
   */
  it("never does both: the copy is the clean path, the request the conflicts one", () => {
    expect(copy()?.if).toBe("needs.gate.outputs.status == 'clean' && success()");
    expect(request()?.if).toBe("needs.gate.outputs.status == 'conflicts' && needs.update-branch.result == 'success' && success()");
  });

  /**
   * Both act on what the push left behind, and the request goes last of the
   * success arms — the review reads the pull request, so a round started before
   * this run's own comment is posted is a round reading the state before it.
   */
  it("acts only after the push, and asks last", () => {
    const names = stepsOf(UPDATE).map((s) => s.name ?? "");

    expect(names.indexOf(copy()?.name ?? "")).toBeGreaterThan(names.indexOf("Push branch"));
    for (const earlier of ["Push branch", "Comment on the PR"]) {
      expect(names.indexOf(request()?.name ?? "")).toBeGreaterThan(names.indexOf(earlier));
    }
  });

  /**
   * The same PAT requirement every label this loop adds carries: one added with
   * `GITHUB_TOKEN` triggers nothing, so the pull request would carry
   * `agent:review` and simply sit there.
   */
  it("says on the pull request, not only in the log, that no review will start", () => {
    const run = request()?.run ?? "";

    expect(request()?.env?.["GH_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
    expect(request()?.env?.["TOKEN_SOURCE"]).toBe("${{ steps.token.outputs.source }}");
    expect(run).toContain("::warning::");
    // What is unreviewed here is a conflict resolution an agent wrote, which
    // is the one thing this loop produces that no review has seen (#105).
    expect(run.slice(run.indexOf('if [ "$TOKEN_SOURCE" != "app" ] && [ "$TOKEN_SOURCE" != "pat" ]'))).toContain("gh pr comment");
  });

  /**
   * …and fails the run when the add itself fails, naming the way out. Unlike
   * the copy above, silence here leaves a resolution nobody reviews — and the
   * failure comment's own remedy is the wrong one, since re-adding
   * `agent:update-branch` finds a branch already merged and does nothing.
   */
  it("fails with a reason a human can act on rather than swallowing the add", () => {
    const run = request()?.run ?? "";

    expect(run).toContain("set -euo pipefail");
    expect(run).toContain("failure_reason.txt");
    expect(run).toContain("exit 1");
    // The two tolerances are removals (#236): this run's own label, which
    // comes off before the next step's goes on, and the removal before the
    // add. A label that is not there is not a failure.
    expect(run.split("\n").filter((l) => l.includes("|| true"))).toEqual([
      'gh pr edit "$PR_NUMBER" --remove-label "agent:update-branch" || true',
      'gh pr edit "$PR_NUMBER" --remove-label "agent:review" || true',
    ]);
  });

  /**
   * A failure after the push is now a real case rather than a corner of one, so
   * the comment that reports it stops asserting the opposite. "The branch was
   * left untouched" is true of everything above the push and false of
   * everything below it, and the remedy it carries — re-add the label — is
   * inert on a branch that is already merged.
   */
  it("does not tell a human the branch is untouched after it pushed", () => {
    const blocked = stepNamed("Mark blocked on failure");

    expect(blocked?.env?.["PUSHED"]).toBe("${{ steps.push.outputs.pushed }}");
    expect(blocked?.run ?? "").toContain('"$PUSHED" = "true"');
  });

  /**
   * The grant the copy spends, in all three places it has to be: the reusable
   * half's ceiling, which is the authoritative statement of what this job
   * costs, and both caller sets, which is where it is actually granted. The
   * generic check above holds caller and callee equal; this is the pair where
   * the value is the point, because a status is its own scope and nothing this
   * job already held covers it.
   */
  it("holds the statuses grant in the ceiling and in every caller", () => {
    // In the reusable half, the publish job's: it is the one that posts the
    // copy, the split having put every write there (#308).
    const halves = [jobNamed(UPDATE, "publish"), ...callersOfWorkflow(UPDATE).map((caller) => caller.job)];

    expect(halves).toHaveLength(3);
    for (const job of halves) expect(job.permissions?.["statuses"]).toBe("write");
  });
});

/**
 * The filing half (#50): the workflow that turns a merged pull request's
 * recorded findings into triageable issues. Its own describe, and its own
 * constant, because it is the one `pull_request_target` reusable that is **not**
 * in `PR_WORKFLOWS` — see the comment on `MERGE_GATED` for why five of that
 * set's assertions are false of it and two of them cannot be exempted at all.
 *
 * **The four properties below are restated, not inherited.** That is the cost of
 * leaving the shared set, paid here explicitly: the single-file precedent in this
 * file is *additive*, where this one gets none of the shared assertions, so the
 * properties that do still hold would silently lapse. The shape diverges on the
 * guard and on the checkout; it does not diverge on the fork guard or on the
 * concurrency group, and both of those are exactly as load-bearing here as they
 * are there — more so for the fork guard, since this is the one workflow in the
 * loop holding `issues: write`.
 *
 * **The residual, named so nobody closes it with a test that cannot.** Every
 * check here reads YAML: the trigger, the condition, the permissions, the
 * concurrency group, the pin, and the absence of the house guard. Nothing here
 * reaches *"GitHub really did dispatch this job on `merged == true`"* — that is
 * a statement about the platform, and the research behind the condition is
 * evidence rather than proof. It gets proven by this repository's own loop, one
 * release later: the callers here run on the last release, this repo merges pull
 * requests constantly, and the merged path is exercised on the first merge after
 * the tag. An unstated gap invites someone to add a test that pretends to close
 * it.
 */
describe("the follow-ups workflow files a merged PR rather than refusing it", () => {
  /** Both halves of the pair, found the way every other check here finds them. */
  const CALLERS = callersOfWorkflow(FOLLOW_UPS);

  /**
   * The file with its YAML comments dropped — what GitHub actually acts on.
   *
   * Needed because three of the absences below are *argued for in the header*,
   * at length: the file says why it installs no Claude Code and why it reaches
   * for no `AGENT_PAT`, and a raw-text search would then find the very strings
   * whose absence it is checking. A prose-shaped assertion that fails on prose
   * teaches the next editor to delete the explanation.
   */
  const declared = (file: string): string =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  it("has both caller sets pointing at it", () => {
    expect(CALLERS.map((caller) => `${path.basename(caller.file)} ${caller.id}`).sort()).toEqual([
      "agent-pr.yml follow-ups",
      "pr.yml follow-ups",
    ]);
  });

  /**
   * **The one assertion this workflow most needs, and the reason it is an exact
   * string.**
   *
   * This is the loop's first job-level condition mixing `&&` and `||`, and `&&`
   * binds tighter. Written flat — without the parentheses around the
   * disjunction — the fork guard attaches to the first disjunct only, and a fork
   * pull request reaches the `labeled` branch of the one workflow in the loop
   * holding `issues: write`. The broken expression and this one contain
   * **identical substrings**, so no amount of per-clause substring matching can
   * tell them apart: only comparing the whole thing can.
   *
   * Normalised on whitespace alone, because the YAML shape is folded across
   * lines and the newlines are not the property. Everything else — the hoisted
   * fork guard, both trigger branches, the literal `true`, and which clause
   * reads which field — is pinned byte for byte, so a rearrangement that changes
   * the meaning cannot pass.
   *
   * The marker string in it is held to `FOLLOW_UPS_LABEL` by the review describe
   * above, which is where the rendered opt-out line and the label step meet.
   */
  it("hoists the fork guard out of the disjunction, exactly", () => {
    const condition = (jobOf(FOLLOW_UPS).if ?? "").replace(/\s+/g, " ").trim();

    expect(condition).toBe(
      "github.event.pull_request.head.repo.full_name == github.repository && " +
        "( ( github.event.action == 'closed' && github.event.pull_request.merged == true ) || " +
        "( github.event.action == 'labeled' && github.event.label.name == 'agent:follow-ups' " +
        "&& github.event.pull_request.state == 'closed' ) )",
    );
  });

  /**
   * The tripwire the exact condition does **not** cover, and the one failure
   * here that is silent and green.
   *
   * A first step refusing a non-open pull request can be added *alongside* an
   * untouched condition — as a "consistency" fix, since the other three PR
   * workflows all have one — and since a merged pull request is not open, it
   * would refuse every single run. No failed job, no comment, nothing to
   * notice: the feature simply stops, and the workflow still reads correct.
   *
   * So this is the inversion stated as a test: **this workflow requires what
   * the other three refuse.** Merged is the normal case here, and the merge gate
   * is the job condition alone — no state step, no shell guard. A shell guard
   * exists elsewhere to explain a refusal in a comment; the case refused here is
   * a pull request closed without merging, where nobody is waiting and a comment
   * on a dead PR is noise.
   */
  it("carries neither the house state guard nor the environment that feeds it", () => {
    const text = fs.readFileSync(FOLLOW_UPS, "utf8");

    expect(stepsOf(FOLLOW_UPS).map((step) => step.id)).not.toContain("state");
    expect(text).not.toContain('"$PR_STATE" != "open"');
    expect(text).not.toContain("PR_MERGED");
  });

  /**
   * Restated (1): the per-pull-request concurrency group. Not conformism — this
   * workflow has **two entry points**, so a manual label add can race the
   * merge-triggered run, and both would list the existing stubs *before* either
   * filed: a read-then-write with no lock, whose result is two issues for one
   * finding. The usual objection to this group — a job waiting on CI deadlocking
   * behind a queued sibling — does not apply, because this job waits on no
   * checks at all.
   */
  it("joins the loop's per-PR group, first-come", () => {
    const { concurrency } = jobOf(FOLLOW_UPS);

    expect(concurrency?.group).toBe("agent-pr-${{ github.event.pull_request.number }}");
    expect(concurrency?.["cancel-in-progress"]).toBe(false);
  });

  /** Restated (2): one group, or GitHub rejects a job declared in two. */
  it("declares exactly one group", () => {
    const groups = [...fs.readFileSync(FOLLOW_UPS, "utf8").matchAll(/^\s*group:\s*(.+)$/gm)].map(
      (m) => (m[1] ?? "").trim(),
    );

    expect(groups).toEqual(["agent-pr-${{ github.event.pull_request.number }}"]);
  });

  /**
   * Restated (3): the fork guard, on this side of the seam. The exact-string
   * check above already pins it, and it is restated as its own case because
   * *this* is the property the shared set would have been asserting — losing it
   * to a rearrangement of that string should fail as "the fork guard", not as
   * "the condition changed".
   */
  it("guards the fork on this side of the seam", () => {
    expect(jobOf(FOLLOW_UPS).if ?? "").toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  /**
   * Zero inputs and zero declared secrets, which is why the wire checks above
   * skip this pair rather than exempting it.
   *
   * No `setup`: nothing is checked out, and executing an adopter-supplied
   * command is the sharpest edge in the reusable surface — declaring no input
   * keeps it structurally impossible rather than merely absent. No
   * `node-version-file`, whose default names a file that does not exist without
   * a checkout. No model credential, because no model runs, which is what keeps
   * a `pull_request_target` job holding `issues: write` free of one. And no
   * `AGENT_PAT`: the loop PAT is optional everywhere, so a filing step depending
   * on it would file **nothing**, silently, on a repository without one — which
   * is the exact failure class this feature exists to fix.
   */
  it("declares no inputs and no secrets, on either side", () => {
    const call = workflowOf(FOLLOW_UPS).on?.workflow_call;

    expect(call?.inputs).toBeUndefined();
    expect(call?.secrets).toBeUndefined();
    for (const caller of CALLERS) {
      expect(caller.job.with, callerName(caller)).toBeUndefined();
      expect(caller.job.secrets, callerName(caller)).toBeUndefined();
    }
  });

  /**
   * …and no model, stated as the three things that would have to be there for
   * one: a credential, the install, and a checkout for it to read.
   */
  it("installs no agent and checks nothing out", () => {
    const text = declared(FOLLOW_UPS);

    expect(text).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(text).not.toContain("@anthropic-ai/claude-code");
    expect(stepsOf(FOLLOW_UPS).filter((s) => (s.uses ?? "").startsWith("actions/checkout@"))).toEqual(
      [],
    );
  });

  /**
   * The half of the registry-auth ordering that survives having no toolchain.
   *
   * `%s: authenticates after the toolchain, before the run` runs over the wired
   * set only, because it asserts a toolchain step *exists* and there is none
   * here — but the reason that step is ordered at all is the second half of its
   * name: both it and a toolchain `setup-node` write the same `.npmrc` and the
   * last one wins, and the runner cannot install from GitHub Packages before the
   * entry exists. That half still applies, so it is restated rather than
   * dropped with the premise that carried it.
   */
  it("authenticates before the run, with no toolchain step to sit after", () => {
    const steps = stepsOf(FOLLOW_UPS);
    const auth = steps.findIndex((step) => (step.with ?? {})["registry-url"] !== undefined);
    const run = steps.findIndex((step) => (step.run ?? "").trim().startsWith("npm exec"));

    expect(auth).toBeGreaterThanOrEqual(0);
    expect(auth).toBeLessThan(run);
    expect(steps.filter((step) => step.with?.["node-version-file"] !== undefined)).toEqual([]);
  });

  /**
   * The permissions, by value rather than by equality between the halves — the
   * generic check already holds those equal to each other, and here the *values*
   * are the decision.
   *
   * `issues: write` is the grant this feature is about. `pull-requests: write`
   * posts the report and removes the marker, since a PR's labels live under that
   * scope. `packages: read` installs the runner and is needed in both halves,
   * because a called workflow can only downgrade. `contents: read` is strictly
   * unnecessary and kept on purpose: the block is a *replacement*, so omitting
   * it sets `contents: none`, an untested configuration for the install.
   *
   * What is absent is the security statement, which is why it is asserted rather
   * than merely commented in the file: no `contents: write`, no `checks: read`,
   * no `actions: write`.
   */
  it.each([
    ["the called job bounds", jobOf(FOLLOW_UPS)],
    ...CALLERS.map((caller): [string, Job] => [`${callerName(caller)} grants`, caller.job]),
  ] as [string, Job][])("%s exactly the four scopes the job spends", (_half: string, job: Job) => {
    expect(job.permissions).toEqual({
      contents: "read",
      issues: "write",
      packages: "read",
      "pull-requests": "write",
    });
  });

  /**
   * The issues are created with the workflow token, and the file says which one
   * it is: `GH_TOKEN` is what every `gh` call in the runner reads, and nothing
   * here ever reaches for the PAT. A repository without `AGENT_PAT` files
   * exactly as much as one with it.
   */
  it("files with the always-present workflow token", () => {
    const text = declared(FOLLOW_UPS);

    expect(text).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(text).not.toContain("AGENT_PAT");
  });

  /**
   * Three statements that live in the file's header because they are invisible
   * anywhere else, and each of which someone would otherwise have to re-derive
   * from a condition, an absence, and a thing that is not there at all.
   *
   * The behaviour table is the one artifact that says, per trigger and per pull
   * request state, whether the job fires and what it does. The structural
   * consequence is that a job condition cannot make an API call — so the marker
   * is re-read in the runner, this job starts on *every* merge in the repository,
   * and most runs end having done nothing and said nothing. And the manual entry
   * point does **not** override the edited-body refusal, which is an absence: a
   * control with a one-label bypass is not a control.
   */
  it("states the behaviour table, the silent exit and the absent bypass", () => {
    const header = fs.readFileSync(FOLLOW_UPS, "utf8").split("\non:")[0] ?? "";
    const rows = (header.match(/^# \|.*\|$/gm) ?? []).filter((row) => !/^# \|-+/.test(row));

    // A header, a separator and one row per case the trigger can produce.
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(header).toMatch(/job condition cannot make an API call/i);
    expect(header).toMatch(/silent exit/i);
    expect(header).toMatch(/does not override the edited-body refusal/i);
  });

  /**
   * And the seam this describe sits on, made into a named failure rather than a
   * silent gap.
   *
   * Leaving the shared set is safe exactly while the two sets **partition** the
   * `pull_request_target` reusables. A seventh workflow in neither would get the
   * general assertions at the top of this file and nothing else — the same
   * silent-coverage failure this whole suite exists to catch, one level up. The
   * file's stated preference is derived-not-listed, and this is what converts
   * "someone forgot" into a test that says so by name.
   */
  it("partitions the pull_request_target reusables with the shared set", () => {
    const triggered = [
      ...new Set(
        callers
          .filter((caller) => workflowOf(caller.file).on?.pull_request_target !== undefined)
          .map(targetOf),
      ),
    ].sort();

    expect(triggered).toEqual([...PR_WORKFLOWS, ...MERGE_GATED].sort());
    expect(PR_WORKFLOWS.filter((file) => MERGE_GATED.includes(file))).toEqual([]);
  });
});

/**
 * One caller file per side (#225). Every label on a pull request used to start
 * four caller runs and every label on an issue two, most of them only to skip;
 * now one label starts one run per side, and an adopter copies two files.
 *
 * What merging must not change is asserted here: each caller keeps exactly the
 * grant and the secrets it had in a file of its own (the generic checks below
 * hold every caller to its reusable's ceiling and its declared secrets), job
 * ids stay put, and the file adds no grant and no routing of its own.
 */
describe("each caller set holds one caller file per side", () => {
  it("holds exactly the PR-side and issue-side caller files, in both sets", () => {
    const names = Object.keys(CALLER_FILES).sort();

    expect(callerFilesIn(CALLER_DIR).map((f) => path.basename(f)).sort()).toEqual(names);
    expect(callerFilesIn(WORKFLOW_DIR, "agent-").map((f) => path.basename(f)).sort()).toEqual(
      names.map((name) => `agent-${name}`),
    );
  });

  /**
   * The trigger is the file's, so it is exact per file: `pull_request_target`
   * reaching a job that holds write is a security surface, and a file must not
   * be able to widen its own trigger. Nothing else is listed under `on:`.
   */
  it.each(callerFiles)("%s: triggers on exactly its side's event and types", (file) => {
    const spec = callerFileSpec(file);
    const on = workflowOf(file).on ?? {};

    expect(spec, file).toBeDefined();
    expect(Object.keys(on)).toEqual([spec?.event]);
    expect(on[spec?.event ?? "issues"]?.types).toEqual(spec?.types);
  });

  /**
   * Nothing at the top level, so every grant is on the job that spends it and
   * a job added later starts with nothing. A top-level grant would be every
   * caller's ceiling at once: the review's `contents: write` handed to
   * `follow-ups`, and `follow-ups`' `issues: write` to the review.
   */
  it.each(callerFiles)("%s: grants nothing at the top level, and every caller its own", (file) => {
    const text = parse(fs.readFileSync(file, "utf8")) as { readonly permissions?: unknown };

    expect(text).toHaveProperty("permissions");
    expect(text.permissions).toEqual({});
    for (const caller of callersOf(file)) {
      expect(Object.keys(caller.job.permissions ?? {}), callerName(caller)).not.toHaveLength(0);
    }
  });

  /**
   * No caller routes. Each reusable's own guard decides whether the event is
   * its label, as it did when each caller had a file to itself; a label `if:`
   * here would be a second copy of the routing, and one an adopter can drift.
   */
  it.each(callerFiles)("%s: carries no caller-level `if:`", (file) => {
    for (const caller of callersOf(file)) expect(caller.job.if, callerName(caller)).toBeUndefined();
  });

  /**
   * Job ids are the first half of every check-run name the loop produces, so
   * they are what they were when each caller had a file of its own, in order.
   */
  it.each(callerFiles)("%s: holds its side's callers under their job ids", (file) => {
    expect(callersOf(file).map((caller) => caller.id)).toEqual(callerFileSpec(file)?.jobs);
    for (const caller of callersOf(file)) {
      expect(targetOf(caller)).toBe(path.join(WORKFLOW_DIR, `${caller.id}.yml`));
    }
  });

  it("keeps `self-check` at `review / review`, in both sets", () => {
    const reviews = callersOfWorkflow(REVIEW);

    expect(reviews).toHaveLength(2);
    for (const caller of reviews) expect(caller.job.with?.["self-check"]).toBe("review / review");
  });

  /**
   * `follow-ups` runs no model and files with the workflow token, so it is
   * handed none of the loop's secrets. In a file beside three callers that are
   * handed the PAT, that is the line a tidy-up would add.
   */
  it("hands follow-ups none of the loop's secrets", () => {
    const filing = callersOfWorkflow(FOLLOW_UPS);

    expect(filing).toHaveLength(2);
    for (const caller of filing) expect(caller.job.secrets, callerName(caller)).toBeUndefined();
  });

  /**
   * The two sets are one design, checked against each other rather than each
   * against a copy of it: what this repository runs is what an adopter copies,
   * pin and comments included.
   */
  it.each(Object.keys(CALLER_FILES))("%s: the local and the reference copy are the same file", (name) => {
    expect(fs.readFileSync(path.join(WORKFLOW_DIR, `agent-${name}`), "utf8")).toBe(
      fs.readFileSync(path.join(CALLER_DIR, name), "utf8"),
    );
  });
});

/**
 * The whole loop is now callable (jeffwlawson/winget-manifest-lint#98, slice 4
 * of jeffwlawson/winget-manifest-lint#88; jeffwlawson/winget-manifest-lint#97
 * proved the pattern on review). The loop is the deliverable and it is
 * installed in other repos, so what an adopter writes per workflow has to be a
 * trigger and two wires — every control stays on this side, in a file they
 * reference rather than copy.
 *
 * A reusable workflow rather than a composite action for one reason: an action
 * cannot declare `on:`, `permissions:`, `concurrency:` or a job-level `if:`,
 * and **the fork guard is a job-level `if:`**. An action could have absorbed
 * checkout → node → install and left every control to be copy-pasted per repo,
 * which is how they drift.
 *
 * The checks here are about the seam itself. Everything about what each job
 * *does* is checked by the describes around them, which read the reusable files
 * because `PR_WORKFLOWS`, `REVIEW`, `IMPLEMENT` and `PRD` name them — that
 * redirection is the point, and a check still aimed at a caller would be green
 * over an empty file.
 */
describe("every workflow in the loop is called rather than copied", () => {
  const callOf = (file: string) => workflowOf(file).on?.workflow_call;

  /**
   * Every workflow is half of a pair, and *only* those: a workflow that is
   * neither half of one is a workflow an adopter would have to copy. Derived
   * from `uses:` rather than from the file names, so a half-done conversion — a
   * reusable with no caller, or a caller left doing the work itself — lands
   * here rather than being silently bucketed.
   *
   * The list is written out because a release is what keeps it honest: a new
   * workflow is three files carrying a version pin, and `scripts/sync-version.ts`
   * refuses the release until all three exist. Adding an entry here is the same
   * moment you add the third file.
   */
  it("splits every agent workflow into a caller and a runner", () => {
    expect(callerFiles.map((f) => path.basename(f)).sort()).toEqual([
      "agent-issue.yml",
      "agent-pr.yml",
      "issue.yml",
      "pr.yml",
    ]);
    // Each caller set calls every reusable exactly once: a reusable called
    // twice is every run of it happening twice, and one not called is a
    // workflow that set's adopters cannot run.
    for (const dir of [CALLER_DIR, WORKFLOW_DIR]) {
      expect(
        callers.filter((caller) => path.dirname(caller.file) === dir).map(targetOf).sort(),
        dir,
      ).toEqual(runnerWorkflows.slice().sort());
    }
  });

  /**
   * Whatever a caller hands over to has to be a file this suite reads. The
   * empty-expression guard is the one that bites: a `${{ }}` in the extracted
   * YAML rejects the whole file at *startup*, with no log and no failed job —
   * exactly the two-day failure this suite was written for — and the caller it
   * was extracted from would still parse clean.
   */
  it.each(eachCaller(callers))("%s: calls a workflow this suite already checks", (_name, caller) => {
    expect(runnerWorkflows).toContain(targetOf(caller));
    expect(workflowFiles).toContain(targetOf(caller));
  });

  /**
   * The trigger is the one thing `workflow_call` cannot carry, so it stays with
   * the caller — and nothing else does. A caller with `steps:` is a caller that
   * has started keeping a copy.
   */
  it.each(eachCaller(callers))("%s: is a call and nothing else", (_name, caller) => {
    expect(caller.job.steps).toBeUndefined();
    expect(caller.job.uses).toBe(`jeffwlawson/agent-workflows/${targetOf(caller)}@${PIN}`);
  });

  /**
   * The pin is a security control, not versioning hygiene, and it is the one
   * property here with no runtime symptom when it is wrong.
   *
   * `pull_request_target` takes its YAML from the base branch, so a pull request
   * cannot edit a caller to change what runs. While the `uses:` was local that
   * protection extended to the called workflow for free — same commit, same
   * base. Remote, it does not: the reference decides. `@main` would hand a job
   * holding `contents: write` and every secret to whatever currently sits on
   * another repository's default branch, and nothing anywhere would report it.
   *
   * A tag is accepted alongside a SHA because both repositories are the same
   * owner's, which makes an unmoved tag a self-trust decision rather than
   * third-party trust. A branch is never accepted.
   */
  it.each(eachCaller(callers))("%s: pins the called workflow to a tag or a SHA", (_name, caller) => {
    const ref = (caller.job.uses ?? "").split("@")[1] ?? "";

    expect(ref).toMatch(/^(v\d+\.\d+\.\d+|[0-9a-f]{40})$/);
  });

  /**
   * The run keeps the caller's name, and that is load-bearing rather than
   * cosmetic: review's failure-log tail skips workflow runs named `Agent …`
   * (`case "$rname" in "Agent "*`), and a called workflow contributes no run of
   * its own — there is one run, named here. Rename these and every agent run's
   * failure log starts arriving in review's prompt as evidence about the diff.
   */
  it.each(callerFiles)("%s: keeps the name the failure-log filter matches on", (file) => {
    expect(workflowOf(file).name ?? "").toMatch(/^Agent /);
  });

  /**
   * The label guard is on the **called** side, in every pair. A caller's `if:`
   * can only skip the job, never loosen it, so a guard put there is a guard an
   * adopter can leave behind.
   */
  it.each(runnerWorkflows)("%s: guards its trigger label on this side of the seam", (file) => {
    expect(guardJobOf(file).if ?? "").toMatch(/github\.event\.label\.name == 'agent:[a-z-]+'/);
  });

  /**
   * …and so is the fork guard, on the three `pull_request_target` workflows. A
   * fork PR reaching the checkout+install steps runs untrusted code with secrets
   * in scope, which is the one failure in this file that is not recoverable by
   * re-labelling.
   *
   * The two `implement` workflows are excluded because they trigger on `issues`,
   * where there is no head repo to compare: nothing is checked out from a
   * contributor at all.
   */
  it.each(PR_WORKFLOWS)("%s: guards the fork on this side of the seam", (file) => {
    expect(guardJobOf(file).if ?? "").toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  /**
   * …and `actions/checkout` enforces that same guard a second time inside the
   * action: it refuses to check a **fork** PR head out under
   * `pull_request_target` or `workflow_run` unless the step sets
   * `allow-unsafe-pr-checkout: true` — a total opt-out, the first branch of the
   * helper, not a narrowing of it.
   *
   * Not something the `@v7` bump bought. The refusal was backported as a
   * breaking change into `v6.1.0`, `v5.1.0`, `v4.4.0` and the two lines older
   * than those, and the moving `@v4` tag this repo sat on resolves to `v4.4.0`
   * — so the pin before the bump enforced it too. This check is therefore no
   * more tied to `@v7` than the pin is: it is about the input, which every
   * version reachable from here has.
   *
   * Nothing sets it and the job-level guard above means nothing needs to: only
   * a same-repo head reaches a checkout here, which the action lets through
   * untouched. What this asserts is that it stays that way. The input sits in
   * the **reusable** half, where an adopter cannot see it and their caller
   * cannot countermand it, so one line added here would hand fork code a job
   * holding `contents: write` and every secret — with the caller's `if:` still
   * reading exactly as it does today.
   *
   * Over every workflow rather than the three `pull_request_target` ones,
   * because the cost is one line and the file it would be added to next is the
   * one that is not in the list.
   */
  it.each(workflowFiles)("%s: never opts out of checkout's own fork guard", (file) => {
    for (const step of stepsOf(file).filter((s) => (s.uses ?? "").startsWith("actions/checkout@"))) {
      expect(step.with?.["allow-unsafe-pr-checkout"]).toBeUndefined();
    }
  });

  /**
   * …and the action's half of that guard is contingent on this `ref:`, which is
   * why it is asserted rather than assumed. From `v7.0.1` — and from the same
   * backports — `src/input-helper.ts` reads
   *
   *     const isDefaultCheckout = isWorkflowRepository && !core.getInput('ref')
   *     if (!isDefaultCheckout) { assertSafePrCheckout({ … }) }
   *
   * so the action skips its own check entirely for a default self-checkout, on
   * the reasoning that GitHub already resolved that ref for the event. The
   * second guard is thus a property of the *step* as much as of the version:
   * drop the `ref:` here and the count silently goes back to one, with the
   * job-level `if:` above reading exactly as it does today.
   *
   * The `ref:` is load-bearing before any of that — `pull_request_target`
   * checks the base branch out without it, and every run would then act on the
   * wrong tree. Two reasons, one line, and the weaker of them was the one with
   * no check.
   *
   * Review's ref is the commit its pre-flight settled on rather than the
   * payload's (#229), which is still an explicit ref and still the PR head.
   */
  it.each(PR_WORKFLOWS)("%s: checks the PR head out by explicit ref", (file) => {
    const checkout = stepsOf(file).filter((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    const ref = file.endsWith("review.yml")
      ? "${{ steps.state.outputs.sha }}"
      : "${{ github.event.pull_request.head.sha }}";

    expect(checkout).not.toHaveLength(0);
    for (const step of checkout) {
      expect(step.with?.["ref"]).toBe(ref);
    }
  });

  /**
   * Permissions are declared **twice** — for opposite reasons, which is why this
   * is not the duplication it looks like.
   *
   * A called workflow can only *downgrade* the token it is handed. So the
   * callee's block is the bound: it cannot be widened from the caller, which is
   * what keeps `contents: read` on review an invariant (docs/parity.md §10). And
   * the caller's block is the grant: a permission declared only in the callee
   * grants nothing, and GitHub refuses the elevation rather than trimming the
   * job to fit — the run is a `startup_failure` before any job starts, whichever
   * scope is short (#146). What each scope *buys* is accounted for in one place,
   * `setup/doctor.ts`'s `REQUIRED_PERMISSIONS`, which is also where an adopter is
   * told what the shortfall costs.
   *
   * Asserted as equality between the halves rather than against a table, so the
   * property held is the one that matters: neither half can drift from the
   * other, whatever the job ends up needing.
   *
   * Equal to the **widest** of the called jobs, scope by scope, since the
   * caller's grant is the ceiling for all of them. That is one job everywhere
   * except `review.yml`, where `resolve` holds `contents: write` and the review
   * job narrows it back to `read` (#133). A grant wider than every job is a
   * scope nothing spends; a narrower one is a run GitHub refuses outright.
   */
  it.each(eachCaller(callers))("%s: grants exactly what the called jobs bound", (_name, caller) => {
    const granted = caller.job.permissions;
    const RANK: Readonly<Record<string, number>> = { none: 0, read: 1, write: 2 };
    const widest: Record<string, string> = {};
    for (const job of jobsOf(targetOf(caller))) {
      for (const [scope, level] of Object.entries(job.permissions ?? {})) {
        const held = widest[scope];
        if (held === undefined || (RANK[level] ?? 0) > (RANK[held] ?? 0)) widest[scope] = level;
      }
    }

    expect(granted).toEqual(widest);
    expect(Object.keys(granted ?? {})).not.toHaveLength(0);
  });

  /**
   * What a missing grant actually costs on a PR workflow, pinned where it is
   * paid (#78). The comment above used to say the review ran, spent a full
   * agent pass and transitioned no label — and that is the one shape this
   * cannot take: `review`, `fix` and `update-branch` all transition labels in
   * one step *above* their checkout, and the probe opening it is deliberately
   * not written `|| true`, so Actions' default `bash -e` fails the run there.
   * Loud, and before the diff is fetched.
   *
   * The probe was the `agent:in-progress` add until that label retired (#236).
   * It is now the trigger label the run already holds, added again: the same
   * write under the same scope, which changes nothing, since the label is on.
   *
   * A property of these three workflows rather than an oversight in them: a
   * `|| true` added to that line would buy back exactly the silent, paid-for run
   * the prose once claimed. What it is *not* is what a caller's missing
   * `pull-requests: write` gets you — that run never starts (#146) — so this is
   * about a token that is short for some other reason, which is why the
   * assertion is about step order rather than about a grant.
   */
  it.each(PR_WORKFLOWS.filter((file) => file !== REVIEW))("%s: a 403 on the label transition fails before the checkout", (file) => {
    const steps = stepsOf(file);
    const label = (guardJobOf(file).if ?? "").match(/github\.event\.label\.name == '(agent:[a-z-]+)'/)?.[1];
    const probe = `gh pr edit "$PR_NUMBER" --add-label "${label}"`;
    const transition = steps.findIndex((s) => s.name === "Transition labels");
    const checkout = steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"));

    expect(label).toBeDefined();
    expect(transition).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeGreaterThan(transition);

    // The probe is the step's first line and bare; the removal after it is
    // `|| true` on purpose, since a label that is not there is not a failure.
    const lines = (steps[transition]?.run ?? "").trim().split("\n");
    expect(lines[0]).toBe(probe);
    expect(lines.slice(1).every((line) => line.endsWith("|| true"))).toBe(true);
  });

  /**
   * Except review, since #257: its agent pass runs in a job that holds no write
   * scope at all, so there is no write to probe with before the pass is spent,
   * and its labels move in the posting job afterwards. A caller short of a
   * scope is still refused before any job starts (#146); what is lost is only
   * the early failure for a token short for some other reason, which the
   * posting job now meets after the pass. The review job writes no label.
   */
  it("review.yml: probes nothing, because the job that runs the model writes nothing", () => {
    for (const step of stepsOf(REVIEW)) expect(step.run ?? "").not.toMatch(/gh pr (edit|comment|ready)|--method POST/);
    expect(stepsOf(REVIEW).map((s) => s.name)).not.toContain("Transition labels");
    expect(writerStepsOf(REVIEW).find((s) => s.name === "Transition labels")?.run).toBe(
      'gh pr edit "$PR_NUMBER" --remove-label "agent:blocked" || true',
    );
  });

  /**
   * And the sentence that describes the bound. Review is the one workflow whose
   * `permissions:` block spells the grant/bound split out at length, so it is
   * the one that can get the cost wrong; the claim also reached #45's issue
   * body and from there `REQUIRED_PERMISSIONS`, which is why the correction is
   * asserted rather than just made.
   */
  it("review.yml's permissions comment describes that failure, not a silent one", () => {
    // The review job's block, by the heading it opens with: the red check's
    // (#231) comes before it in the file.
    const comment = permissionComments(REVIEW).find((c) => c.startsWith("**Read-only, every scope**"));

    expect(comment).toBeDefined();
    expect(comment).toContain("grants nothing");
    expect(comment).not.toMatch(/silently transitions no label/i);
    expect(comment).toMatch(/before any job starts/i);
  });

  /**
   * The two scopes whose own comment makes a claim about what a caller short of
   * it pays, and so the two #146's correction had to reach: `statuses: write`,
   * whose comment survived the sweep saying the review posts and no verdict
   * appears, and `checks: read`, which a public repository's poll is served
   * without and which reads as optional for that reason.
   *
   * These two rather than every scope, because the property is "says the right
   * thing" and not "avoids a phrase". A blanket ban on the retired construction
   * was tried and rejected: `resolveReviewThread` really is refused to a token
   * *without it*, and no wording distinguishes that from a claim about a
   * caller's grant (docs/friction.md, 2026-09-27). A scope whose comment starts
   * making the claim is a scope to add here.
   */
  const CLAIMS_THE_COST: readonly (readonly [string, string])[] = [
    ["statuses", "write"],
    ["checks", "read"],
  ];

  const costComments = CLAIMS_THE_COST.flatMap(([permission, value]) =>
    agentWorkflows().flatMap((file) =>
      permissionComments(file, `${permission}: ${value}`).map(
        (comment) => [file, `${permission}: ${value}`, comment] as const,
      ),
    ),
  );

  /**
   * And what a caller short of one of them pays, which #146 corrected from the
   * step to the run — asserted on the **per-scope** comments and not just the
   * paragraph above them, because that is the distinction the correction's own
   * sweep fell down: the docblock was rewritten and `statuses: write`'s two
   * lines below it, saying "the caller has to grant it too. Without it the
   * review posts and no verdict appears", were not. The grep that carried the
   * sweep looked for `403` and "a caller missing", and a sentence naming no
   * status code contains neither.
   *
   * Written per scope rather than over the block joined, since a block read
   * whole passes on the docblock's copy while any number of scopes below it
   * still cost the step — a reusable contradicting its own caller on one scope,
   * which is the shape a file-at-a-time sweep leaves.
   */
  it.each(costComments)(
    "%s: says a caller short of %s costs the run",
    (_file: string, _scope: string, comment: string) => {
      expect(comment).toMatch(/before any job starts/);
      expect(comment).not.toMatch(/the review posts and no verdict appears/i);
    },
  );

  /**
   * …and that it read anything at all, which the guard above cannot say about
   * itself. `it.each` over an **empty** array registers no test and passes the
   * file, so a scope `permissionComments` stops matching — a quoted value, a
   * trailing inline comment on the scope's own line, a reindented block — takes
   * every case above with it and leaves `verify` green on precisely the sweep
   * they exist to catch.
   *
   * One entry per **block** that grants the scope rather than per file, because
   * a reusable has a block per job: `review.yml`'s `resolve` granting
   * `statuses: write` later would be a second comment to read rather than a
   * second copy of the first, and equality of the two lists says so either way.
   * Derived from the parsed YAML rather than listed, so a seventh half granting
   * one of these arrives as a case above rather than as a gap.
   */
  it.each(CLAIMS_THE_COST)(
    "reads a %s: %s comment on every block that grants the scope",
    (permission: string, value: string) => {
      const granting = agentWorkflows().flatMap((file) =>
        jobsOf(file)
          .filter((job) => job.permissions?.[permission] === value)
          .map(() => file),
      );

      expect(
        costComments.filter(([, scope]) => scope === `${permission}: ${value}`).map(([file]) => file),
      ).toEqual(granting);
    },
  );

  /**
   * Named, not inherited. `secrets: inherit` hands the called workflow every
   * secret the repository holds, including the ones this loop has no use for —
   * and it is the form that reads as tidier, so the list is worth pinning.
   */
  it.each(eachCaller(wiredCallers()))("%s: passes every secret by name", (_name, caller) => {
    const declared = callOf(targetOf(caller))?.secrets ?? {};
    // The App's two beside the PAT where the workflow resolves its token
    // through the loop's resolver (#319, #320): every workflow but follow-ups.
    const expected = [
      "AGENT_PAT",
      "CLAUDE_CODE_OAUTH_TOKEN",
      ...(RESOLVING.includes(targetOf(caller)) ? APP_SECRETS : []),
    ].sort();

    expect(Object.keys(declared).sort()).toEqual(expected);
    // The agent cannot run without its token. The PAT and the App are optional
    // everywhere (every use of them falls back to `GITHUB_TOKEN` under a
    // warning, §1), and an unset optional secret arrives as the empty string,
    // which is what those fallbacks test.
    expect(declared["CLAUDE_CODE_OAUTH_TOKEN"]?.required).toBe(true);
    for (const name of expected.filter((n) => n !== "CLAUDE_CODE_OAUTH_TOKEN")) {
      expect(declared[name]?.required, name).toBe(false);
    }

    expect(caller.job.secrets).not.toBe("inherit");
    // A reference caller ships beside this reusable, so it passes exactly what
    // this one declares. A local caller runs against the *released* reusable
    // its pin names, which may not declare a secret added since: it is held to
    // that release instead, by the describe below.
    if (caller.file.startsWith(CALLER_DIR)) {
      expect(caller.job.secrets ?? {}).toEqual(Object.fromEntries(expected.map((n) => [n, `\${{ secrets.${n} }}`])));
    }
  });

  /**
   * Every input is typed and says what it is for — an adopter reads only this.
   * `self-check` is review's alone and is checked with the rest of the CI wait
   * below; these three are the couplings docs/ADOPTING.md §5 used to ask every
   * adopter to hand-edit in every file.
   */
  const SHARED_INPUTS = [
    ["default-branch", "main"],
    ["node-version-file", ".nvmrc"],
    ["setup", "npm ci"],
  ] as const;

  it.each(wiredWorkflows())("%s: declares the three shared inputs, typed and described", (file) => {
    for (const [name, value] of SHARED_INPUTS) {
      const input = callOf(file)?.inputs?.[name];

      expect(input?.type).toBe("string");
      expect(input?.description ?? "").not.toBe("");
      // The defaults are this repo's own values, which is what lets every
      // caller here pass none of them — so the conversion changed no behaviour.
      expect(input?.default).toBe(value);
    }
  });

  /**
   * Both toolchain steps are skippable, and that is the whole of the non-Node
   * story: a repo with no `.nvmrc` and no `npm ci` passes empty strings and
   * still gets the loop, on the image's own Node.
   *
   * `npm install -g @anthropic-ai/claude-code` is deliberately not skippable —
   * that is the agent's own runtime rather than the adopter's toolchain, and
   * every runner image already has the Node it needs for it.
   */
  it.each(wiredWorkflows())("%s: takes the toolchain from the caller", (file) => {
    const node = stepsOf(file).find((s) => (s.uses ?? "").startsWith("actions/setup-node@"));
    const install = stepsOf(file).find((s) => (s.run ?? "").includes("${{ inputs.setup }}"));

    expect(node?.with?.["node-version-file"]).toBe("${{ inputs.node-version-file }}");
    expect(node?.if ?? "").toContain("inputs.node-version-file != ''");
    expect(install?.if ?? "").toContain("inputs.setup != ''");
  });
});

/**
 * This repository's own callers run on `main`, but the reusable each one calls
 * is the one at its pinned tag — the last release (`CLAUDE.md`, *This repo runs
 * its own loop*). So a local caller can name a secret or an input its own
 * branch declares and the release does not, and GitHub refuses the whole caller
 * file before a job starts: `startup_failure`, no log, every job in the file.
 * #330 did that by passing the App's two secrets ahead of v0.7.9, and every
 * agent run here failed to start until the release shipped.
 *
 * So the local callers are held to the release they pin, read out of git at
 * that tag rather than off the working tree: everything they pass is declared
 * there, and everything declared there as required is passed. A change to a
 * caller's interface therefore lands in two steps — the reusable, released,
 * then the local caller — while the reference callers, which ship with the
 * reusable they sit beside, move in the first.
 *
 * Needs the tag in the checkout. A clone with history has it; `ci.yml` checks
 * out with `fetch-depth: 0` for this. A missing tag fails here by name rather
 * than passing, since the check that cannot run is the one that would have
 * caught it.
 */
describe("a local caller passes only what the release it pins declares", () => {
  const localCallers = callers.filter((caller) => caller.file.startsWith(WORKFLOW_DIR));

  const released = new Map<string, Workflow>();
  const releasedOf = (caller: Caller): Workflow => {
    const ref = (caller.job.uses ?? "").replace(/^.*@/, "");
    const key = `${ref}:${targetOf(caller)}`;
    const cached = released.get(key);
    if (cached !== undefined) return cached;

    let text: string;
    try {
      text = execFileSync("git", ["show", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: SUBPROCESS_TIMEOUT,
      });
    } catch (error) {
      const { stderr } = error as { readonly stderr?: string };
      throw new Error(
        `${callerName(caller)} pins ${ref}, but \`git show ${key}\` failed: ${String(stderr ?? error).trim()}. ` +
          `Fetch the tags (\`git fetch --tags\`); a shallow checkout has none.`,
      );
    }
    const workflow = parse(text) as Workflow;
    released.set(key, workflow);
    return workflow;
  };

  it("reads both caller files", () => {
    expect(new Set(localCallers.map((caller) => path.basename(caller.file)))).toEqual(
      new Set(Object.keys(CALLER_FILES).map((file) => `agent-${file}`)),
    );
  });

  it.each(eachCaller(localCallers))("%s: passes no secret the release does not declare", (_name, caller) => {
    const declared = releasedOf(caller).on?.workflow_call?.secrets ?? {};
    const passed = caller.job.secrets === "inherit" ? {} : (caller.job.secrets ?? {});

    expect(Object.keys(passed).filter((name) => !(name in declared))).toEqual([]);
    expect(
      Object.entries(declared)
        .filter(([name, secret]) => secret.required === true && !(name in passed))
        .map(([name]) => name),
    ).toEqual([]);
  });

  it.each(eachCaller(localCallers))("%s: passes no input the release does not declare", (_name, caller) => {
    const declared = releasedOf(caller).on?.workflow_call?.inputs ?? {};
    const passed = caller.job.with ?? {};

    expect(Object.keys(passed).filter((name) => !(name in declared))).toEqual([]);
    expect(
      Object.entries(declared)
        .filter(([name, input]) => input.required === true && input.default === undefined && !(name in passed))
        .map(([name]) => name),
    ).toEqual([]);
  });
});

/**
 * The one input that is a fact about the *caller* rather than about the repo,
 * and the one control the extraction itself put at risk
 * (jeffwlawson/winget-manifest-lint#97).
 */
describe("agent-review tells its caller what it cannot know", () => {
  const caller = (): Job => jobNamed(REVIEW_CALLER, "review");
  const call = () => workflowOf(REVIEW).on?.workflow_call;

  /**
   * `contents: read` on the review job is the invariant that bounds what a
   * wrong review can do (docs/parity.md §10), and since #257 the job that runs
   * the model holds no write scope of any kind. The generic check above holds
   * the caller equal to the widest called job; this is the one set where the
   * *values* are the point. The caller grants the writes the posting job
   * spends, and the review job narrows each of them back to `read`.
   */
  it.each([
    ["the caller grants", REVIEW_CALLER, "write"],
    ["the called job bounds", REVIEW, "read"],
  ])("%s exactly the permissions the job uses", (_half: string, file: string, level: string) => {
    expect((file === REVIEW ? jobOf(file) : caller()).permissions).toEqual({
      // The CI wait reads the commit's workflow runs (#221): a run queued or
      // waiting for approval has no check run yet, so it shows nowhere else.
      actions: "read",
      // The CI wait polls the check-runs API. A public repository serves it
      // without this scope, so every repo in the pilot passed without it and
      // the first private adopter got a 403 that spent the whole wait budget.
      checks: "read",
      // Resolving a thread wants `contents: write` (#133), and only the
      // posting job spends it.
      contents: level,
      // The linked issue, its comments and a PRD's sub-issues (#348). A public
      // repository serves them without this scope, so on a private one every
      // review ran with no criteria and the PRD progress table went stale.
      // Read only, in both halves: nothing in the loop's PR side writes an
      // issue with this token (docs/parity.md §10).
      issues: "read",
      // Installing the runner package, not reading the PR — the one scope here
      // that is about the toolchain rather than about the review.
      packages: "read",
      // The posting job's review, replies, comments and labels; the review
      // job's reads of the same.
      "pull-requests": level,
      // The verdict (#96). A commit status is not a pull-request write, so
      // nothing else covers it. A caller short of it gets no run rather than a
      // review with no verdict on it (#146); what looks like the feature simply
      // being off is a token short for some other reason, since the step that
      // posts the status warns rather than failing. The review job reads the
      // verdicts already posted, to count the fix rounds spent.
      statuses: level,
    });
  });

  /**
   * **The model runs only in a job without write scopes** (#257). Whatever the
   * caller grants, the job whose steps run the review agent declares nothing
   * above `read`, and every job that can write runs no agent.
   */
  it("runs the model only in a job that can write nothing", () => {
    const jobs = Object.entries(workflowOf(REVIEW).jobs);
    const runsModel = (job: Job): boolean =>
      (job.steps ?? []).some((step) => (step.run ?? "").includes("agent-workflows review"));
    const writes = (job: Job): boolean => Object.values(job.permissions ?? {}).includes("write");

    expect(jobs.filter(([, job]) => runsModel(job)).map(([id]) => id)).toEqual(["review"]);
    for (const [id, job] of jobs) {
      if (runsModel(job)) expect(writes(job), id).toBe(false);
    }
  });

  /**
   * **And the caller `docs/ADOPTING.md` §4 prints grants the same set**, which
   * is the copy nothing else here can see (#133). `PIN` reads the two caller
   * *sets*; a fenced block in a document is read by no test, and this one sat on
   * `contents: read` through the commit that moved every other copy in the same
   * file. An adopter pastes it, and what a short grant now costs is the whole
   * run rather than the step — so it is held to the reference caller by value,
   * the way the two halves above are held to each other.
   *
   * Scoped to the subsection, and asserted as equality rather than against a
   * table, so the release that adds a scope cannot leave the paste-able copy
   * one behind.
   */
  it("prints that same grant in the caller docs/ADOPTING.md §4 shows", () => {
    const section = fs
      .readFileSync(path.join("docs", "ADOPTING.md"), "utf8")
      .split(/^(?=### )/m)
      .find((part) => part.startsWith("### `agent-review` needs one input more"));
    const snippet = (section ?? "").match(/```yaml\n([\s\S]*?)```/)?.[1];

    expect(snippet, "docs/ADOPTING.md §4 prints no review caller").toBeDefined();
    expect((parse(snippet as string) as Workflow).jobs["review"]?.permissions).toEqual(
      caller().permissions,
    );
  });

  it("declares the self-check input, typed and described", () => {
    const input = call()?.inputs?.["self-check"];

    expect(input?.type).toBe("string");
    expect(input?.description ?? "").not.toBe("");
  });

  /**
   * The CI wait polls every check on the head commit and excludes its own, or
   * it waits for itself: 15 of this job's 20 minutes, then a review with
   * degraded evidence — the failure mode jeffwlawson/winget-manifest-lint#48
   * exists to prevent, reintroduced by the extraction.
   *
   * The name changes as a *result* of the extraction. A called workflow's job
   * appears as `<caller job id> / <called job id>`, and nothing inside a called
   * workflow can read its caller's job id. Hence an input — compared as a
   * literal rather than folded into the regex, because a job id is not a regex
   * and `.` in one would quietly match a neighbour.
   *
   * `AGENT_CHECKS` now covers the same name, and the overlap is deliberate
   * rather than dead: that pattern is a heuristic over names nobody declares,
   * and this is the exact answer the caller was made to state. Self-exclusion
   * is the one case with no error to read when it is wrong, so it does not get
   * to depend on a heuristic.
   */
  it("excludes its own check run from the wait, in every filter", () => {
    const step = waitStep();

    expect(step.env?.["SELF_CHECK"]).toBe("${{ inputs.self-check }}");
    // Counted against the jq passes over the check runs rather than against a
    // literal: the verdict's word is a third one (#96), and a fourth must fail
    // here rather than quietly reading this job's own run as evidence.
    const passes = [...(step.run ?? "").matchAll(/\.\[\]\.check_runs\[\]/g)];
    const filters = [...(step.run ?? "").matchAll(/select\(\.name != env\.SELF_CHECK\)/g)];

    expect(passes.length).toBeGreaterThanOrEqual(3);
    expect(filters).toHaveLength(passes.length);
  });

  /**
   * …and the input is required, because the value is a fact about the *caller*
   * that only the caller knows. A default would be right for a caller that
   * copied this repo's job id and silently wrong — 15 minutes of waiting, no
   * error — for one that did not.
   */
  it("makes the caller state the check-run name it produces", () => {
    expect(call()?.inputs?.["self-check"]?.required).toBe(true);
    expect(call()?.inputs?.["self-check"]?.default).toBeUndefined();
  });

  /**
   * The coupling itself: the name is `<caller job id> / <called job id>`, and
   * both halves are right here to be read. Renaming either job without editing
   * the input is the deadlock above, and nothing at runtime would say so.
   */
  it("passes the name the two job ids actually produce", () => {
    const callerJob = callersOf(REVIEW_CALLER).find((held) => targetOf(held) === REVIEW)?.id;
    const [calledJob] = Object.keys(workflowOf(REVIEW).jobs).filter(
      (id) => !(EXTRA_JOBS[REVIEW] ?? []).includes(id),
    );

    expect(caller().with?.["self-check"]).toBe(`${callerJob} / ${calledJob}`);
  });

  /**
   * …and the second half is knowable from outside this repository, which is a
   * property rather than a coincidence: every reusable half declares one job
   * whose id is its own filename, so `review.yml@v…` is enough to say that the
   * check run ends in `/ review`.
   *
   * `setup/callers.ts` reads it exactly that way — an adopter's caller names
   * the file it calls and nothing else — so `doctor` can rule on *both* halves
   * of their `self-check` and name the whole of the fix. Rename a job here
   * without renaming its file and that advice becomes confidently wrong in
   * somebody else's repository, where no test of theirs could see it.
   */
  it.each(RUNNER_COMMANDS)("%s.yml declares a job of its own name", (command: string) => {
    const file = path.join(WORKFLOW_DIR, `${command}.yml`);
    const jobs = workflowOf(file).jobs;

    // Its declared extras aside: `review / resolve` is a second check run, not
    // a second answer to which one is the review (#133).
    expect(Object.keys(jobs).filter((id) => !(EXTRA_JOBS[file] ?? []).includes(id))).toEqual([
      command,
    ]);
    // And no `name:` on it, which is the other half of the same property:
    // GitHub writes a job's display name into the check run and falls back to
    // the id only where there is none. One added here would rename the second
    // half of every adopter's `self-check` at once, and `doctor` — which
    // composes it from the `uses:` filename, because that is all a caller
    // states — would go on telling them the old one was right.
    expect(jobs[command]?.name).toBeUndefined();
  });
});

/**
 * The issue-side equivalent (jeffwlawson/winget-manifest-lint#102).
 * `agent-implement`'s preflight only listed *open* PRs, so a merged-and-closed
 * issue that got relabelled checked out `main`, found the work already there,
 * and died at "no commits were made" — or, worse, invented a spurious change
 * and opened a duplicate PR.
 */
describe("agent-implement refuses a closed issue", () => {
  const FILE = IMPLEMENT;

  it("reads the issue state from the event", () => {
    expect(fs.readFileSync(FILE, "utf8")).toContain(
      "ISSUE_STATE: ${{ github.event.issue.state }}",
    );
  });

  it("refuses before the existing-PR query, with its own message", () => {
    const preflight = firstWorkStep(FILE);
    const run = preflight?.run ?? "";

    expect(preflight?.id).toBe("preflight");
    // Ungated, like the three PR guards: a guard with an `if:` is a guard that
    // can be skipped into the work it exists to prevent.
    expect(preflight?.if).toBeUndefined();
    expect(run).toContain('"$ISSUE_STATE" != "open"');
    expect(run).toContain('refuse "This issue is closed. Reopen it, then add \\`agent:implement\\` again."');
    // Distinct from the refusal that was already there — two refusals reading
    // the same is two states a human cannot tell apart from the comment alone.
    expect(run).toContain("already exists for this issue");
    expect(run.indexOf("$ISSUE_STATE")).toBeLessThan(run.indexOf("gh pr list"));
  });

  const NOT_REFUSED = "steps.preflight.outputs.refused == 'false'";
  /**
   * The same go-ahead across the split: the agent's job runs only where the
   * gate did not refuse, and the publish job's checkout only after the agent's
   * job succeeded, which it cannot have where it never ran.
   */
  const NOT_REFUSED_SPLIT = ["needs.gate.outputs.refused == 'false'", "needs.implement.result == 'success'"];
  const gatedOnGoAhead = (step: Step): void => {
    const condition = conditionOf(FILE, step);
    expect(NOT_REFUSED_SPLIT.some((c) => condition.includes(c)), `${step.name}: ${condition}`).toBe(true);
  };

  it("checks nothing out when it refuses", () => {
    const checkout = stepsOf(FILE).filter((s) => (s.uses ?? "").startsWith("actions/checkout@"));

    expect(checkout).not.toHaveLength(0);
    for (const step of checkout) gatedOnGoAhead(step);
  });

  it("transitions no label when it refuses", () => {
    const labelling = stepsOf(FILE).filter((s) => s.name === "Transition labels");

    expect(labelling).toHaveLength(1);
    for (const step of labelling) expect(step.if ?? "").toContain(NOT_REFUSED);
  });
});

/**
 * `gh pr list` returns 30 PRs unless told otherwise, and says nothing when it
 * stops there (#275). implement's duplicate-PR guard read only those 30, so in a
 * repo with more open PRs it could miss the one already closing the issue and
 * open a second. A guard that reads a page reads a sample: every call names its
 * limit, so a new one cannot quietly inherit the default.
 */
describe("every gh pr list names its limit", () => {
  // Each call with its `\` continuation lines joined, so a `--limit` wrapped
  // onto the next line still counts. Comment lines are prose, not calls.
  const callsIn = (text: string): string[] => {
    const lines = text.split("\n");
    const calls: string[] = [];
    lines.forEach((line, i) => {
      if (line.trim().startsWith("#") || !line.includes("gh pr list")) return;
      let call = line.slice(line.indexOf("gh pr list"));
      for (let n = i; (lines[n] ?? "").trimEnd().endsWith("\\") && n + 1 < lines.length; n++) {
        call += ` ${(lines[n + 1] ?? "").trim()}`;
      }
      calls.push(call);
    });
    return calls;
  };

  it("finds the calls to check", () => {
    const calls = workflowFiles.flatMap((file) => callsIn(fs.readFileSync(file, "utf8")));
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each([
    "gh pr list --state open --json number \\\n  --limit 1000",
    'x=$(gh pr list --head "$b" --limit 100 --json number)',
  ])("passes %s", (call: string) => {
    expect(callsIn(call).every((c) => /\s--limit\s+\d+/.test(c))).toBe(true);
  });

  it("catches a call relying on the default", () => {
    expect(callsIn("gh pr list --state open --json number \\\n  --jq '.[0]'")[0]).not.toMatch(/\s--limit\s+\d+/);
  });

  it.each(workflowFiles)("%s: every gh pr list passes --limit", (file: string) => {
    const unbounded = callsIn(fs.readFileSync(file, "utf8")).filter((c) => !/\s--limit\s+\d+/.test(c));
    expect(unbounded).toEqual([]);
  });

  it("implement's duplicate-PR guard reads up to 1000 open PRs", () => {
    const run = firstWorkStep(IMPLEMENT)?.run ?? "";
    expect(callsIn(run).some((c) => c.includes("--state open") && c.includes("--limit 1000"))).toBe(true);
  });
});

/**
 * Issue *shape* (jeffwlawson/winget-manifest-lint#90). An issue's position in a
 * hierarchy decides whether it can be implemented at all, and the workflow used
 * to accept anything carrying the label:
 *
 * - **has a parent** — a sub-issue implemented alone loses the ordering and the
 *   shared context its parent holds; the parent drives it or nobody does.
 * - **`wayfinder:*`** — maps and decision tickets are planning artifacts. They
 *   describe work; they are not work.
 *
 * Both are refused in the preflight step, which is what keeps them job-level
 * rather than agent-level: no checkout, no `npm ci`, no `agent:in-progress`.
 *
 * The third shape — **has sub-issues** — was refused too until
 * jeffwlawson/winget-manifest-lint#92, and is now handed to
 * `agent-implement-prd` instead. See the partition describe below.
 */
describe("agent-implement refuses issue shapes it cannot handle", () => {
  const FILE = IMPLEMENT;
  const preflightRun = (): string => firstWorkStep(FILE)?.run ?? "";

  /**
   * One query, not three. Parent and sub-issue count come back together —
   * asking twice is two chances to see a different answer, and the shape is
   * what every refusal below branches on.
   */
  it("computes the shape once, from a single API call", () => {
    const run = preflightRun();

    expect([...run.matchAll(/gh api graphql/g)]).toHaveLength(1);
    expect(run).toContain("parent {");
    expect(run).toContain("subIssues(");
  });

  it("exposes the shape as a step output", () => {
    expect(preflightRun()).toContain('echo "shape=$shape" >> "$GITHUB_OUTPUT"');
  });

  /**
   * Two refusals, two messages. A human reading only the comment has to be able
   * to tell which shape they hit — the remedy differs for each, and "refused"
   * alone sends them to the run log.
   */
  it.each([
    [
      "a sub-issue",
      'refuse_shape "This is a sub-issue of #${parent}. Add \\`agent:implement\\` to #${parent} instead; it builds its sub-issues in order."',
    ],
    [
      "a wayfinder ticket",
      'refuse_shape "This is a planning issue (\\`wayfinder:*\\`), not buildable work. Add \\`agent:implement\\` to the issues it produces instead."',
    ],
    ["an issue with open blockers", 'refuse_shape "It\'s blocked by ${blockers}, which is still open.'],
    [
      "an issue with an open PR",
      'refuse "PR #${existing} already exists for this issue. Keep working on that PR, or close it and add \\`agent:implement\\` again."',
    ],
  ])("refuses %s with its own message", (_shape: string, phrase: string) => {
    expect(preflightRun()).toContain(phrase);
  });

  /**
   * The blocked-by refusal, and why it is a refusal rather than a chain.
   *
   * A PRD parent **contains** its sub-issues, so authorising the parent
   * authorises the slices — that is what lets one label drive a five-run chain
   * onto one branch. `blocked_by` is **sequencing**: the blocker is a separate
   * deliverable with its own PR, and implementing it because somebody labelled
   * the issue downstream would authorise work nobody asked for, transitively.
   * Some blockers are decision tickets that are not implementable at all, which
   * is the same reason the wayfinder refusal above exists.
   *
   * Only **open** blockers refuse. A closed one has been satisfied, and treating
   * it otherwise would make every issue in a finished chain permanently
   * unrunnable.
   */
  it("refuses on open blockers only, read from the native edges", () => {
    const run = preflightRun();

    expect(run).toContain("/dependencies/blocked_by");
    expect(run).toContain('select(.state == "open")');
  });

  /**
   * The remedy has to name both halves. Re-adding a label that is still attached
   * fires no event (`docs/ADOPTING.md` §1), so "re-add" alone is inert on the
   * path where the refusal left it in place — and a human who believes the work
   * *can* proceed needs to be told the edge is the thing to remove, not the
   * label, or they will fight the preflight in a loop.
   */
  it("tells the reader to add the label again once the blocker closes, or to remove the link", () => {
    const run = preflightRun();

    expect(run).toContain(
      "Add \\`agent:implement\\` again once ${blockers} is closed, or remove the \\\"blocked by\\\" link if it no longer applies.",
    );
    expect(run).toContain("which are still open. Add \\`agent:implement\\` again once they are closed");
  });

  /**
   * Unlike the state and existing-PR refusals — "reopen it", "close that PR" —
   * a shape refusal is durable: nothing about the run will differ next time.
   * `agent:blocked` is what records that on the issue.
   */
  it("marks a shape refusal blocked, in the preflight step itself", () => {
    const run = preflightRun();

    expect(run).toContain('--add-label "agent:blocked"');
    expect(run).toContain('--remove-label "agent:implement"');
  });

  /**
   * An unreadable shape must not be read as "standalone". Every other guard in
   * these workflows proceeds when an API call comes back empty; this one is the
   * exception, because guessing wrong here *is* the isolation bug. Failing the
   * step leaves the trigger label in place and the run visibly red.
   */
  it("does not swallow a failed shape query", () => {
    // Keyed on the tolerance, not the command: `|| true` would land on the
    // *closing* line of a multi-line query, several lines below the one
    // naming `gh`, so a filter on `gh api graphql` never sees it.
    const tolerant = preflightRun()
      .split("\n")
      .filter((l) => l.includes("|| true") && !l.trimStart().startsWith("#"));

    expect(tolerant).not.toHaveLength(0);
    for (const line of tolerant) expect(line).toContain("gh issue edit");
  });

  const NOT_REFUSED = "steps.preflight.outputs.refused == 'false'";

  /**
   * Refusing to swallow a failed shape query only helps if the failure reaches
   * the issue. A preflight that dies mid-step writes no `refused` output at
   * all, and `''` is not `'false'` — so the failure notice has to be gated on
   * `!= 'true'`, or the one step that comments the reason is skipped exactly
   * when the reason is a red run nobody is watching.
   */
  it("comments on a preflight that fails rather than refuses", () => {
    // Identified by the reason file, not by `agent:blocked` — the preflight
    // step adds that label too, and it sorts first.
    const blocked = stepsOf(FILE).find((s) => s.name === "Mark blocked on failure");
    // On the publish job's `if:`, which a failed gate passes: `refused` is
    // `!= 'true'` there for the same reason.
    const condition = conditionOf(FILE, blocked as Step);

    expect(condition).toContain("needs.gate.outputs.refused != 'true'");
    expect(condition).toContain("needs.gate.result != 'success'");
    expect(blocked?.if ?? "").toContain("failure()");
  });

  /**
   * The job-level `if:` saves a runner for the wrong *label*; this saves the
   * expensive half of the run for the wrong *issue*. The note on the job-level
   * `if:` in `agent-implement-reusable.yml` records why that distinction is
   * worth keeping.
   */
  it("installs nothing when it refuses", () => {
    const install = stepsOf(FILE).filter(isInstallStep);

    expect(install).not.toHaveLength(0);
    // In the agent's job, which runs only where the gate did not refuse.
    for (const step of install) expect(conditionOf(FILE, step)).toContain("needs.gate.outputs.refused == 'false'");
  });

  /**
   * Shape is settled before the existing-PR query. An issue that must never be
   * implemented should not be told "close that PR, then re-add the label" — a
   * remedy that leads straight back to a refusal.
   */
  it("settles the shape before the existing-PR query", () => {
    const run = preflightRun();

    expect(run.indexOf("gh api graphql")).toBeLessThan(run.indexOf("gh pr list"));
  });
});

/**
 * `agent-implement-prd` (jeffwlawson/winget-manifest-lint#92) is triggered by
 * the **same label on the same event** as `agent-implement`, so both jobs start
 * on every `agent:implement` label event and the pair has to partition the work
 * between them. The key is the sub-issue count: an issue that has sub-issues
 * belongs to the PRD path, every other shape to `agent-implement`.
 *
 * The property worth encoding is not which one runs — it is that **exactly one
 * of them speaks**. Whichever does not own the shape has to step aside touching
 * nothing at all:
 *
 * - no comment, or a human sees two bot comments about one event, saying
 *   opposite things ("refused, the PRD path is not built" beside a run that is
 *   building it);
 * - no label edit, and this is the load-bearing half — the chain re-adds
 *   `agent:implement` to the parent to start the next slice, and a second job
 *   racing to *remove* it eats the chain silently.
 *
 * That is what `defer` is, in both preflights: a bare `exit 0` with a log line.
 */
describe("the two implement workflows partition issue shapes", () => {
  const preflight = (file: string): string => firstWorkStep(file)?.run ?? "";

  /**
   * The trigger is on the caller and the label guard on the called job
   * (jeffwlawson/winget-manifest-lint#98) — so the pair is read across both
   * halves, which is what the partition actually depends on: two workflows
   * woken by one event, each deciding for itself whether the shape is theirs.
   */
  it.each(eachCaller(callers.filter((caller) => [IMPLEMENT, PRD].includes(targetOf(caller)))))(
    "%s: is triggered by agent:implement on an issue",
    (_name, caller) => {
      expect(workflowOf(caller.file).on?.issues?.types).toEqual(["labeled"]);
      expect(guardJobOf(targetOf(caller)).if ?? "").toBe("github.event.label.name == 'agent:implement'");
    },
  );

  /**
   * Both callers of the pair sit in one caller file (#225), so one label event
   * starts one run holding both, and neither can be taken without the other.
   */
  it("holds both callers of the pair in one caller file, in each caller set", () => {
    for (const dir of [CALLER_DIR, WORKFLOW_DIR]) {
      const files = callers
        .filter((caller) => path.dirname(caller.file) === dir && [IMPLEMENT, PRD].includes(targetOf(caller)))
        .map((caller) => caller.file);

      expect(files, dir).toHaveLength(2);
      expect(new Set(files).size, dir).toBe(1);
    }
  });

  /**
   * A deferral that comments is a second voice; a deferral that edits a label
   * is a race with the other job. Asserted on the function body rather than the
   * step, because the same step legitimately does both when it *refuses*.
   */
  it.each([IMPLEMENT, PRD])("%s: defers without commenting or touching a label", (file) => {
    const body = bashFunctionBody(preflight(file), "defer");

    expect(body).toContain('echo "refused=true"');
    expect(body).not.toContain("gh ");
  });

  /** The other half of the contract: a refusal *does* speak, and consumes the label. */
  it.each([IMPLEMENT, PRD])("%s: refuses by commenting and consuming the label", (file) => {
    const body = bashFunctionBody(preflight(file), "refuse");

    expect(body).toContain("gh issue comment");
    expect(body).toContain('--remove-label "agent:implement"');
  });

  it("agent-implement hands every sub-issue-bearing issue to the PRD path", () => {
    const arm = armOf(preflight(IMPLEMENT), '"$shape" = "has-sub-issues"');

    expect(arm).toContain("defer ");
    expect(arm).not.toContain("refuse");
  });

  it("agent-implement-prd hands back anything without sub-issues", () => {
    const arm = armOf(preflight(PRD), '"$subs" -eq 0');

    expect(arm).toContain("defer ");
    expect(arm).not.toContain("refuse");
  });

  /**
   * The partition has to be settled before *either* workflow says anything,
   * including about a closed issue — otherwise a closed PRD parent collects the
   * same "this issue is not open" comment twice, from two runs, seconds apart.
   * So the shape query moved above the state check in `agent-implement` (it had
   * been first since jeffwlawson/winget-manifest-lint#102, when nothing else
   * claimed the label).
   */
  it.each([IMPLEMENT, PRD])("%s: settles the partition before the state check", (file) => {
    const run = preflight(file);

    expect(run.indexOf("gh api graphql")).toBeLessThan(run.indexOf('defer "'));
    expect(run.indexOf('defer "')).toBeLessThan(run.indexOf('"$ISSUE_STATE" != "open"'));
  });

  /**
   * Sub-issues *of a PRD* are refused by `agent-implement` and deferred by the
   * PRD path; a nested PRD — sub-issues **and** a parent — is the other way
   * round, since the PRD path is the one that can explain what is wrong with
   * it. Keyed on the shape computation testing the sub-issue count before the
   * parent, which is what routes the overlap.
   */
  it("routes a nested PRD to the PRD path, not to agent-implement", () => {
    const run = preflight(IMPLEMENT);

    expect(run.indexOf('subs" -gt 0')).toBeLessThan(run.indexOf('parent" ]'));
    expect(preflight(PRD)).toContain("nested");
  });
});

/**
 * The PRD chain itself (PRD #222). One sub-issue per run, in sub-issues API
 * order, each built as commits straight onto one PRD branch and reviewed as a
 * round on one PRD PR into the base branch. There are no slice branches and no
 * slice PRs. The next slice starts only when the PRD PR's head carries an
 * approval, read live in the preflight; the label that started the run is
 * never the gate.
 *
 * The preflight's state table, the gate and the link check are executed in
 * `tests/implement-prd-preflight.test.ts`; this pins what they stand on.
 */
describe("agent-implement-prd works one sub-issue per run", () => {
  const NOT_REFUSED = "steps.preflight.outputs.refused == 'false'";
  /**
   * The same go-ahead across the split (#308): the jobs past the gate run only
   * where it did not refuse, and the publish job's steps that touch the
   * agent's commits only after the agent's job succeeded, which it cannot
   * have where it never ran.
   */
  const GATE_WENT_AHEAD = "needs.gate.outputs.refused == 'false'";
  const AGENT_SUCCEEDED = "needs.implement-prd.result == 'success'";
  const BUILDING = "needs.gate.outputs.build == 'true'";
  const PRD_GROUP = `agent-implement-prd-issue-\${{ github.event.issue.number }}\${{ github.event.label.name != 'agent:implement' && format('-other-{0}', github.run_id) || '' }}`;
  /** Every line of the workflow that is not a comment, for a "nowhere" assertion. */
  const code = (): string[] =>
    fs
      .readFileSync(PRD, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"));

  /**
   * Per *parent issue*, first-come. Not the per-PR group the three PR workflows
   * share: an `issues` event carries no PR number, so the two cannot compute a
   * common key. That residual is recorded in docs/parity.md §10 rather than
   * papered over here.
   */
  it("serialises the chain on the parent issue", () => {
    const { concurrency } = workflowOf(PRD);

    expect(concurrency?.group).toBe(PRD_GROUP);
    expect(concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("declares exactly one group", () => {
    const groups = [...fs.readFileSync(PRD, "utf8").matchAll(/^\s*group:\s*(.+)$/gm)].map((m) =>
      (m[1] ?? "").trim(),
    );

    expect(groups).toEqual([PRD_GROUP]);
  });

  it("guards first, and the guard is itself ungated", () => {
    const first = firstWorkStep(PRD);

    expect(first?.id).toBe("preflight");
    expect(first?.if).toBeUndefined();
  });

  /**
   * One query for parent, labels and the sub-issue list together — see
   * jeffwlawson/winget-manifest-lint#90.
   */
  it("computes the shape once, from a single API call", () => {
    const run = runOf(PRD, "preflight");

    expect([...run.matchAll(/gh api graphql/g)]).toHaveLength(1);
    expect(run).toContain("parent {");
    expect(run).toContain("subIssues(");
    expect(run).toContain("nodes { number title state }");
  });

  /**
   * The whole scheduling policy, in one jq filter: keep the open sub-issues no
   * commit on the PRD branch names in its `Agent-Slice` trailer, in the order
   * the API returned them, take the head. An open one with a trailer is never
   * built again, whatever happened to its state; a closed one with none landed
   * before the upgrade (#248), `next` in `shared/slice-ranges.ts`.
   */
  it("targets the first sub-issue with no slice on the PRD branch, in API order", () => {
    const run = runOf(PRD, "preflight");
    const next = run.split("\n").findIndex((l) => l.trimStart().startsWith("next=$("));
    const filter = run.split("\n").slice(next, next + 2).join("\n");

    expect(run).toContain('gh api "repos/${GH_REPO}/compare/${BASE_REF}...${prd_sha}?per_page=100" --paginate');
    expect(run).toContain('capture("^agent-slice:[ \\t]*#(?<n>[0-9]+)[ \\t]*$"; "i")');
    expect(filter).toContain("any($built[]; . == $n) | not");
    expect(filter).toContain("| .[0]");
    expect(filter).toContain('select(.state == "OPEN" and (.number as $n | any($built[]; . == $n) | not))');
    expect(run).toContain('echo "sub=$(jq -r \'.number\' <<< "$next")"');
  });

  /**
   * Four refusals, four messages, and each one names a different thing to do
   * about it. `agent:blocked` on every shape but the finished one: a PRD whose
   * sub-issues are all built is *finished*, and labelling a completed parent
   * blocked leaves exactly the stale label docs/parity.md §10 warns about.
   */
  it.each([
    [
      "a nested PRD",
      'refuse_shape "This PRD is itself a sub-issue of #${parent}. Remove it from #${parent}, or move its sub-issues up to #${parent}, then label the top-level issue."',
    ],
    [
      "a wayfinder ticket",
      'refuse_shape "This is a planning issue (\\`wayfinder:*\\`), not buildable work. Add \\`agent:implement\\` to the issues it produces instead."',
    ],
    [
      "a PRD with nothing left to do",
      'refuse "Every sub-issue of this PRD is built and its PRD PR is ready for you. To build more, add a sub-issue first."',
    ],
    [
      "a PRD with too many sub-issues",
      'refuse_shape "This PRD has ${subs} sub-issues, and the loop handles at most 100. Split it into smaller PRDs."',
    ],
    ["a parent with open blockers", 'refuse_shape "It\'s blocked by ${blockers}, which is still open.'],
  ])("refuses %s with its own message", (_case: string, phrase: string) => {
    expect(runOf(PRD, "preflight")).toContain(phrase);
  });

  /**
   * The blocked-by refusal, mirrored from `agent-implement` (#14). Being a
   * coordinator exempts the parent from nothing. Only **open** blockers refuse:
   * a closed one has been satisfied.
   */
  it("refuses a blocked parent on open blockers only", () => {
    const run = runOf(PRD, "preflight");
    const read = run.split("\n").find((l) => l.includes("/issues/${ISSUE_NUMBER}/dependencies/blocked_by")) ?? "";
    const blockers = run.slice(run.indexOf(read));

    expect(read).not.toBe("");
    expect(blockers).toContain('select(.state == "open")');
    expect(blockers.slice(blockers.indexOf('if [ -n "$blockers" ]'))).toContain("refuse_shape");
  });

  /**
   * **After the finished refusal**, and only on a run that builds. The finished
   * shape can never run at all; a blocker is only *not yet*, so it gives way
   * when they collide, rather than hand a finished PRD `agent:blocked`.
   */
  it("settles the finished PRD before it reads the parent's blockers", () => {
    const run = runOf(PRD, "preflight");
    const read = run.indexOf("/issues/${ISSUE_NUMBER}/dependencies/blocked_by");

    expect(run.indexOf("Every sub-issue of this PRD is built")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("Every sub-issue of this PRD is built")).toBeLessThan(read);
    expect(run.lastIndexOf('if [ "$build" = "true" ]; then', read)).toBeGreaterThan(
      run.indexOf("Every sub-issue of this PRD is built"),
    );
  });

  /**
   * **The sub-issues' links, checked once, before the first build** (#222).
   * Read per sub-issue, only where nothing is built yet, and never as later
   * slices are reached: sub-issues stay open until the PRD PR merges, so a link
   * between two slices never clears while the chain runs. The amendment to
   * `docs/parity.md` §2a is cited where it is made.
   */
  it("reads the sub-issues' blocked_by only before the first build, and says why", () => {
    const run = runOf(PRD, "preflight");
    const calls = run
      .split("\n")
      .filter((l) => l.includes("dependencies/blocked_by") && !l.trimStart().startsWith("#"));
    const subs = calls.find((l) => l.includes("${sub}")) ?? "";

    expect(calls).toHaveLength(2);
    expect(calls.some((l) => l.includes("${ISSUE_NUMBER}"))).toBe(true);
    expect(subs).not.toBe("");
    expect(run.lastIndexOf('if [ "$slices_landed" -eq 0 ]; then', run.indexOf(subs))).toBeGreaterThanOrEqual(0);
    expect(run).toContain("docs/parity.md §2a");
    expect(run).toMatch(/Reorder the sub-issues so #\$\{late\} comes before #\$\{sub\}/);
    expect(run).toMatch(/Move that \\"blocked by\\" link from #\$\{sub\} to this issue/);
  });

  /**
   * The remedy names both halves, as the flat refusal does. Re-adding a label
   * that is still attached fires no event (`docs/ADOPTING.md` §1), so "re-add"
   * alone is inert on the path the refusal leaves it on.
   */
  it("tells the reader to add the label again once the blocker closes, or to remove the link", () => {
    const run = runOf(PRD, "preflight");

    expect(run).toContain(
      "Add \\`agent:implement\\` again once ${blockers} is closed, or remove the \\\"blocked by\\\" link if it no longer applies.",
    );
  });

  /**
   * `totalCount` is unpaged and `nodes` is not, so past the page size the head
   * of the unbuilt list can sit off the end of the page, and "nothing left"
   * is read as *finished*. Refusing loudly beats that.
   */
  it("refuses rather than silently reading a truncated sub-issue list", () => {
    const run = runOf(PRD, "preflight");

    expect(run).toContain("subIssues(first: 100)");
    expect(armOf(run, '"$subs" -gt 100')).toContain("refuse_shape");
    expect(run.indexOf('"$subs" -gt 100')).toBeLessThan(run.indexOf("Every sub-issue of this PRD is built"));
  });

  it("marks the durable shape refusals blocked, and the finished PRD and the gate not", () => {
    const run = runOf(PRD, "preflight");
    const line = (phrase: string): string => run.split("\n").find((l) => l.includes(phrase)) ?? "";

    expect(bashFunctionBody(run, "refuse_shape")).toContain('refuse "$1" blocked');
    expect(bashFunctionBody(run, "refuse")).toContain('--add-label "agent:blocked"');
    expect(line("Every sub-issue of this PRD is built")).toMatch(/^\s*refuse "/);
    expect(line("so the next slice wasn't started")).toMatch(/refuse "/);
    expect(line("so the next slice wasn't started")).not.toContain("refuse_shape");
  });

  /**
   * **The approval gate** (#203). A run that finds a slice built builds the
   * next only on an `agent-review` status of approval on the PRD PR's head,
   * which is the one verdict posted as `success`. Every other ending refuses
   * and names the three ways on. Read in the preflight, from live state, so
   * the label cannot skip it, which is the `statuses: read` it holds.
   */
  it("gates the next slice on an approval on the PRD PR's head, and names the ways on", () => {
    const run = runOf(PRD, "preflight");

    expect(run).toContain('gh api "repos/${GH_REPO}/commits/${head}/status" --paginate --slurp');
    expect(run).toContain('select(.context == "agent-review")');
    expect(run).toContain("head=$(jq -r '.[0].headRefOid' <<< \"$prd_prs\")");
    expect(run).toMatch(/^\s*success\)\n\s*echo "PRD PR #\$\{prd_pr\}'s latest commit \$\{head\} has an approval/m);
    expect(VERDICTS["approval recommended"].state).toBe("success");
    for (const row of Object.values(VERDICTS).filter((r) => r.verdict !== "approval recommended")) {
      expect(row.state).not.toBe("success");
    }
    const ways = run.split("\n").find((l) => l.trimStart().startsWith("ways=")) ?? "";
    expect(ways).toContain("add \\`agent:fix\\` to PRD PR #${prd_pr}");
    expect(ways).toContain("decline a finding by replying to it, then add \\`agent:review\\`");
    expect(ways).toContain("push a commit, then add \\`agent:review\\`");
    expect(run.match(/refuse "[^\n]*\$\{ways\}"/g)).toHaveLength(3);
  });

  it.each([
    ["checks nothing out", (s: Step) => (s.uses ?? "").startsWith("actions/checkout@")],
    ["installs nothing", isInstallStep],
    ["transitions no label", (s: Step) => s.name === "Transition labels"],
  ])("%s when it refuses or defers", (_case: string, match: (s: Step) => boolean) => {
    const steps = stepsOf(PRD).filter(match);

    expect(steps).not.toHaveLength(0);
    for (const step of steps) {
      const condition = conditionOf(PRD, step);
      expect([NOT_REFUSED, GATE_WENT_AHEAD, AGENT_SUCCEEDED].some((c) => condition.includes(c)), `${step.name}: ${condition}`).toBe(true);
    }
  });

  /**
   * The lookup is keyed on the **issue number**, not on the whole computed
   * name. The slug comes from the parent's *title*, which a human may edit at
   * any point; recomputing the whole name every run means a retitle mid-chain
   * misses the branch carrying slices 1..N-1 and forks slice N off the base.
   * So the slug may only ever *name* a branch, never find one.
   */
  it("finds the PRD branch by the half of its name a human cannot edit, and reuses it", () => {
    const run = runOf(PRD, "preflight");
    const prepare = runOf(PRD, "prepare");

    expect(run).toContain('gh api "repos/${GH_REPO}/git/matching-refs/heads/agent/prd-${ISSUE_NUMBER}-"');
    expect(run.indexOf("matching-refs")).toBeLessThan(run.indexOf("${slug}"));
    expect(run).toContain('prd_branch="agent/prd-${ISSUE_NUMBER}-${slug}"');
    expect(prepare.indexOf('"$EXISTS" = "true"')).toBeLessThan(prepare.indexOf("git checkout -b"));
    expect(prepare).toContain('git checkout -B "$PRD_BRANCH" "refs/remotes/origin/${PRD_BRANCH}"');
  });

  /**
   * **No slice branches.** The agent builds on the PRD branch itself, and is
   * handed it as the branch it is on. Nothing in this workflow names a slice
   * branch any more, in code or in comment, but the pre-upgrade refusal of a
   * slice PR an older release left open (#248): every line that does sits in
   * the paragraph its "Pre-upgrade compatibility" mark opens, with no blank
   * line between, which is how #224 finds what to remove.
   */
  it("builds every slice on the PRD branch, and names no agent/slice- branch outside the pre-upgrade rules", () => {
    const agent = stepsOf(PRD).find((s) => (s.run ?? "").includes("agent-workflows implement-prd"));
    const lines = fs.readFileSync(PRD, "utf8").split("\n");
    const naming = lines.flatMap((line, i) => (line.includes("agent/slice-") ? [i] : []));

    expect(agent?.env?.["BRANCH"]).toBe("${{ needs.gate.outputs.prd_branch }}");
    expect(naming.length).toBeGreaterThan(0);
    for (const at of naming) {
      const mark = lines.findLastIndex((line, i) => i <= at && line.includes("Pre-upgrade compatibility, removable under #224"));
      expect(mark, lines[at]).toBeGreaterThanOrEqual(0);
      expect(lines.slice(mark, at + 1).some((line) => line.trim() === ""), lines[at]).toBe(false);
    }
  });

  /**
   * **Plain `git push` of the PRD branch, and nothing forced.** It carries every
   * earlier slice, and verdicts and threads are pinned to its commits, so a
   * force push is a chain that eats its own history and orphans its reviews.
   * Two pushes: the slice's, and before it the merge of the default branch
   * (#245), which is a **merge**, never a rebase, for the same reason. The
   * third is the rescue (#303), to a side branch and never the PRD branch.
   */
  it("pushes the PRD branch without force, and never rebases it", () => {
    const pushes = code().filter((l) => /^\s*(if ! )?git (-c "[^"]*" )?push\b/.test(l));

    expect(pushes.map((l) => l.trim())).toEqual([
      'if ! git -c "http.extraHeader=AUTHORIZATION: basic ${push_auth}" push origin "$PRD_BRANCH"; then',
      'git -c "http.extraHeader=AUTHORIZATION: basic ${auth}" push origin "$PRD_BRANCH"',
      'git -c "http.extraHeader=AUTHORIZATION: basic ${auth}" push --force-with-lease="refs/heads/${RESCUE_BRANCH}:${current}" origin "${tip}:refs/heads/${RESCUE_BRANCH}"',
    ]);
    // The rescue's lease is the one force in the file, and it is not on the PRD branch.
    expect(code().filter((l) => /--force|\bpush -f\b|\+refs\/heads\/[^:]*:refs\/heads/.test(l)).map((l) => l.trim())).toEqual([
      'git -c "http.extraHeader=AUTHORIZATION: basic ${auth}" push --force-with-lease="refs/heads/${RESCUE_BRANCH}:${current}" origin "${tip}:refs/heads/${RESCUE_BRANCH}"',
    ]);
    expect(code().filter((l) => /\brebase\b|\breset --hard\b|\bpull --rebase\b/.test(l))).toEqual([]);
    expect(runOf(PRD, "catch_up")).toContain('git merge --no-ff --no-edit');
  });

  /**
   * Gone with the slice PRs: the step that merged one, the mark it left on the
   * slice PR's body for `advance-merged`, and the trap that took the mark back
   * out. Nothing merges into the PRD branch through a PR any more.
   */
  it("has no merge-slice step and no chain-merge mark", () => {
    const text = fs.readFileSync(PRD, "utf8");

    expect(stepsOf(PRD).map((s) => s.id)).not.toContain("merge");
    expect(stepsOf(PRD).map((s) => s.name ?? "")).not.toContainEqual(expect.stringMatching(/^Merge slice/));
    expect(text).not.toContain("agent-chain-merge");
    expect(text).not.toMatch(/\btrap\b/);
    expect(code().filter((l) => /\bgh pr merge\b/.test(l))).toEqual([]);
  });

  /**
   * **No step closes an issue.** A sub-issue stays open until the PRD PR merges,
   * and its `Closes` line closes it then; "closed" keeps meaning "merged to the
   * default branch" (#217).
   */
  it("closes no issue", () => {
    expect(code().filter((l) => /\bgh issue close\b|state_reason|-f state=closed/.test(l))).toEqual([]);
  });

  /**
   * Gone with the slices table: the resume and backfill of a slice merged
   * without its row, the "more than one open slice PR" refusal, and the
   * per-slice verdict reads that filled the table.
   */
  it("keeps no slices table, no backfill and no slice-PR refusal", () => {
    const text = fs.readFileSync(PRD, "utf8");
    const runner = fs.readFileSync("implement-prd/implement-prd.ts", "utf8");

    expect(text).not.toMatch(/agent:slices|slices-table|backfill|rowless|slice PRs are open/);
    expect(stepsOf(PRD).map((s) => s.id)).not.toContain("slice_row");
    expect(stepsOf(PRD).map((s) => s.id)).not.toContain("slice_pr");
    expect(runner).not.toMatch(/slices-table|FINISHING/);
    expect(fs.existsSync(path.join("shared", "slices-table.ts"))).toBe(false);
  });

  /**
   * The PRD PR opens in the run that builds the first slice (before that the
   * PRD branch has nothing the base lacks) as a draft into the base, after
   * the push, and is found by its **head** after. Its body opens with the
   * `Closes` block (byte for byte in `tests/pr-body-steps.test.ts`).
   */
  it("opens the PRD PR as a draft into the base after the push, and finds it by head after", () => {
    const steps = stepsOf(PRD);
    const at = steps.findIndex((s) => s.id === "prd_pr");
    const step = steps[at];
    const run = step?.run ?? "";

    expect(at).toBeGreaterThan(steps.findIndex((s) => s.id === "push"));
    // A run that builds nothing opens it too; one that builds, only where the
    // agent's job succeeded, which it did not where the chain parked.
    expect(step?.if).toBe(
      `needs.gate.result == 'success' && needs.gate.outputs.finishing == 'false' && (needs.gate.outputs.build == 'false' || ${AGENT_SUCCEEDED}) && success()`,
    );
    expect(step?.env?.["PRD_BRANCH"]).toBe("${{ needs.gate.outputs.prd_branch }}");
    expect(step?.env?.["GH_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
    expect(run).toContain('gh pr list --state open --head "$PRD_BRANCH"');
    expect(run).toContain('gh pr create --draft --base "$BASE_REF" --head "$PRD_BRANCH"');
    expect(run).toContain('["#\\($parent)", (.subIssues.nodes[] | select(.state == "OPEN") | "#\\(.number)")] | "Closes " + join(", closes ")');
    expect(run.indexOf("gh pr list")).toBeLessThan(run.indexOf("gh pr create"));
    expect(runOf(PRD, "preflight")).toContain('> "${RUNNER_TEMP}/prd-issue.json"');
  });

  /**
   * The slice's round is `agent:review` on the PRD PR, the way
   * `agent-implement`'s PR asks for its review. The one other trigger label it
   * adds is the finishing run's final review, which a building run never adds.
   * Neither re-labels the parent: the next slice waits for the gate.
   */
  it("requests review on the PRD PR, and re-labels nothing else", () => {
    // Past the probe opening `Transition labels`, which adds the label this run
    // already holds and requests nothing (#236).
    const adds = stepsOf(PRD).filter(
      (s) => s.name !== "Transition labels" && /--add-label "agent:(implement|review)"/.test(s.run ?? ""),
    );

    expect(adds).toHaveLength(2);
    expect(adds[0]?.name).toBe("Request review");
    expect(adds[0]?.run ?? "").toContain('gh pr edit "$PRD_PR" --add-label "agent:review"');
    expect(adds[0]?.env?.["PRD_PR"]).toBe("${{ steps.prd_pr.outputs.number }}");
    expect(adds[0]?.if ?? "").toContain("needs.gate.outputs.finishing == 'false'");
    expect(adds[1]?.id).toBe("handover");
    expect(adds[1]?.run ?? "").toContain('gh pr edit "$PRD_PR" --add-label "agent:review"');
    expect(adds[1]?.if ?? "").toContain("needs.gate.outputs.finishing == 'true'");
    for (const step of adds) expect(step.run ?? "").not.toContain('--add-label "agent:implement"');
  });

  /**
   * The label add is a silent no-op under `GITHUB_TOKEN` — the anti-recursion
   * rule (docs/ADOPTING.md §1), so the slice would sit asking nobody for
   * review. Warn loudly, and fail where the add itself fails.
   */
  it("warns loudly when neither the App nor AGENT_PAT is set for the review label, and fails on a failed add", () => {
    const step = stepsOf(PRD).find((s) => s.name === "Request review");

    expect(step?.env?.["GH_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
    expect(step?.env?.["TOKEN_SOURCE"]).toBe("${{ steps.token.outputs.source }}");
    expect(step?.run ?? "").toContain("::warning::");
    expect(step?.run ?? "").toContain("set -euo pipefail");
  });

  /**
   * Once the slice is pushed, re-applying `agent:implement` builds nothing,
   * and its gate refuses while the slice has no review. So the failure
   * comment says where to ask for the review instead, whenever the push
   * happened.
   */
  it("names the PRD PR as the way out when the chain dies after its push", () => {
    const failed = stepsOf(PRD).find((s) => s.name === "Mark blocked on failure");
    const run = failed?.run ?? "";

    expect(failed?.env?.["PUSHED"]).toBe("${{ steps.push.outputs.head }}");
    expect(failed?.env?.["PRD_PR"]).toBe("${{ steps.prd_pr.outputs.number || needs.gate.outputs.prd_pr }}");
    expect(run).toContain("Add \\`agent:review\\` to PRD PR #${PRD_PR} if it doesn't have it.");
    expect(run).toContain("so it won't be built again");
    expect(run).toContain('reason="${reason} It was building sub-issue #${SUB}."');
  });

  /**
   * The finishing run, and the run that only opens a missing PRD PR, **run no
   * model**: they check nothing out, install no toolchain and no Claude Code,
   * and start no runner. Every step a build does is gated on the preflight
   * saying this run builds.
   */
  it("runs no model unless the run builds a slice", () => {
    const steps = stepsOf(PRD);
    const building = steps.filter(
      (s) =>
        (s.uses ?? "").startsWith("actions/checkout@") ||
        (s.uses ?? "").startsWith("actions/setup-node@") ||
        (s.run ?? "").includes("${{ inputs.setup }}") ||
        (s.run ?? "").includes("@anthropic-ai/claude-code") ||
        (s.run ?? "").includes("agent-workflows implement-prd") ||
        ["prepare", "trailer", "push"].includes(s.id ?? ""),
    );

    // Four checkouts (the catch-up's, the agent's and the publish job's two,
    // one to push and one to rescue, #303), two `prepare`s (the catch-up's and
    // the agent's), and the agent's toolchain, runner and trailer, and the push.
    expect(building).toHaveLength(13);
    for (const step of building) {
      const condition = conditionOf(PRD, step);
      expect(condition.includes(`${GATE_WENT_AHEAD} && ${BUILDING}`) || condition.includes(AGENT_SUCCEEDED), `${step.name}: ${condition}`).toBe(true);
    }
  });

  /**
   * The handover. One slice landed: its round reviewed the whole PRD PR, so it
   * is marked ready and no review is asked for. More than one: the final
   * review is recorded in the PRD PR's body, then asked for. Both need the
   * loop's App or AGENT_PAT. The loop never merges the PRD PR nor approves
   * anything.
   */
  it("hands the PRD PR over on the finishing run, and never merges or approves it", () => {
    const steps = stepsOf(PRD);
    const at = steps.findIndex((s) => s.id === "handover");
    const step = steps[at];
    const run = step?.run ?? "";
    const many = armOf(run, 'if [ "$LANDED" -gt 1 ]');

    expect(at).toBeLessThan(steps.findIndex((s) => s.name === "Mark blocked on failure"));
    expect(step?.if).toBe("needs.gate.result == 'success' && needs.gate.outputs.finishing == 'true' && success()");
    expect(conditionOf(PRD, step as Step)).toContain("needs.gate.outputs.refused != 'true'");
    expect(step?.env?.["PRD_PR"]).toBe("${{ needs.gate.outputs.prd_pr }}");
    expect(step?.env?.["LANDED"]).toBe("${{ needs.gate.outputs.landed }}");
    expect(step?.env?.["GH_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
    expect(step?.env?.["TOKEN_SOURCE"]).toBe("${{ steps.token.outputs.source }}");
    expect(many).toContain('mark="<!-- agent:final-review requested -->"');
    expect(many.indexOf("gh api -X PATCH")).toBeLessThan(many.indexOf('--add-label "agent:review"'));
    expect(many.slice(many.indexOf("else"))).toContain('gh pr ready "$PRD_PR"');
    expect(many.slice(many.indexOf("else"))).not.toContain("agent:review");
    expect(run.indexOf('"$TOKEN_SOURCE" != "app"')).toBeLessThan(run.indexOf("gh pr edit"));
    expect(bashFunctionBody(run, "block")).toContain('> "${RUNNER_TEMP}/failure_reason.txt"');
    expect(code().filter((l) => /\bgh pr (merge|review)\b/.test(l))).toEqual([]);
  });

  /**
   * Every stop of the preflight and the PRD PR steps fails into `Mark blocked
   * on failure` with a reason file, rather than commenting from the step.
   */
  it.each(["preflight", "prd_pr", "handover"])("%s blocks through the reason file, not a comment of its own", (id) => {
    const body = bashFunctionBody(runOf(PRD, id), "block");

    expect(body).toContain('> "${RUNNER_TEMP}/failure_reason.txt"');
    expect(body).toContain("exit 1");
    expect(body).not.toContain("gh ");
    expect(body).not.toContain("refused=");
  });

  /**
   * The grant the gate's verdict read spends, in all three places it has to
   * be (#199). The combined-status endpoint needs `statuses: read`, and a
   * scope a `permissions:` block leaves out is `none`. No new grant comes with
   * the gate: the job's scopes are what they were.
   */
  it("holds the statuses grant the gate spends, in the ceiling and in every caller, and adds none", () => {
    // In the reusable half, the gate's, which is where the verdict is read
    // since the split (#308).
    const halves = [jobNamed(PRD, "gate"), ...callersOfWorkflow(PRD).map((caller) => caller.job)];

    expect(halves).toHaveLength(3);
    for (const job of halves) expect(job.permissions?.["statuses"]).toBe("read");
    // Across the split's jobs, each scope at the widest any of them holds it:
    // what the caller has to grant, which the split left as it was.
    const LEVEL = ["none", "read", "write"];
    const widest: Record<string, string> = {};
    for (const job of jobsOf(PRD)) {
      for (const [scope, level] of Object.entries(job.permissions ?? {})) {
        if (LEVEL.indexOf(level) > LEVEL.indexOf(widest[scope] ?? "none")) widest[scope] = level;
      }
    }
    expect(widest).toEqual({
      contents: "write",
      issues: "write",
      packages: "read",
      "pull-requests": "write",
      statuses: "read",
    });
  });

  /**
   * Same `!= 'true'` gate as jeffwlawson/winget-manifest-lint#90: a preflight
   * that *dies* writes no output.
   */
  it("comments on a preflight that fails rather than refuses", () => {
    const blocked = stepsOf(PRD).find((s) => s.name === "Mark blocked on failure");

    // On the publish job's `if:`, which a failed gate passes.
    expect(conditionOf(PRD, blocked as Step)).toContain("needs.gate.outputs.refused != 'true'");
    expect(blocked?.if ?? "").toContain("needs.gate.result != 'success'");
    expect(blocked?.if ?? "").toContain("failure()");
    expect(blocked?.run ?? "").toContain('--add-label "agent:blocked"');
  });

  it("removes agent:implement from the parent however the run ends", () => {
    const last = stepsOf(PRD).at(-1);

    expect(last?.if).toBe("always() && needs.gate.outputs.refused == 'false'");
    expect(last?.run ?? "").toContain('--remove-label "agent:implement"');
  });
});
/**
 * The two blocker refusals in this file — and the third place that
 * deliberately has none — partition on a rule that, until #19, lived only in a
 * comment thread on an issue being closed, and #5's own author predicted the
 * idea would come back: left as "Same argument applies.", the natural reading
 * is *check blockers everywhere*, which is the sub-issue loop the two tests
 * above exist to keep out.
 *
 * So the rule is asserted where it is written rather than only where it is
 * obeyed. **Containment transfers authorisation; sequencing does not.** A PRD
 * parent contains its sub-issues, so one label on the parent authorises every
 * slice; `blocked_by` sequences separate deliverables, and chaining through it
 * would authorise work nobody asked for, transitively.
 *
 * Two failures with no symptom, which is why this is a test and not a comment.
 * A section deleted or reworded away leaves `implement-prd.yml`'s preflight
 * citing `docs/parity.md §2a` for a rule that is no longer there — the citation
 * is a string, and nothing dereferences it. And the links between this section
 * and `docs/agents/ticket-shape.md`, which states the ordering contract this
 * explains, are anchors in both directions: renaming either heading breaks one
 * silently, since no Markdown here is ever rendered by a build that could
 * complain.
 */
describe("why blocker edges do not chain is written down, not re-derived", () => {
  const PARITY = path.join("docs", "parity.md");
  const TICKET_SHAPE = path.join("docs", "agents", "ticket-shape.md");

  const parity = fs.readFileSync(PARITY, "utf8");
  const ticketShape = fs.readFileSync(TICKET_SHAPE, "utf8");

  /**
   * GitHub's heading slug, close enough for the anchors this repo writes:
   * lowercased, punctuation dropped, spaces hyphenated. Computed from the
   * headings rather than hardcoded, so the check is "the link resolves" rather
   * than "the link matches a second copy of the heading".
   */
  const slugOf = (heading: string): string =>
    heading
      .replace(/^#+\s+/, "")
      .toLowerCase()
      .replace(/[^\w\- ]/g, "")
      .trim()
      .replace(/\s+/g, "-");

  const headingsOf = (doc: string): string[] => doc.match(/^#{2,6} .+$/gm) ?? [];

  const anchors = new Set(headingsOf(parity).map(slugOf));
  const ticketShapeAnchors = new Set(headingsOf(ticketShape).map(slugOf));

  /** The section itself: from its heading to the next one at any level. */
  const sectionNamed = (match: RegExp): string => {
    const headings = parity.split(/^(?=#{2,6} )/m);
    return headings.find((s) => match.test(s.split("\n")[0] ?? "")) ?? "";
  };

  /**
   * Which top-level section it has to sit in, and the one thing here written
   * out rather than derived. Both citations name it by **number**, not by
   * anchor — `implement-prd.yml`'s preflight and `ticket-shape.md`'s link text
   * each say `docs/parity.md §2a` — and a number is what no link checker and no
   * anchor test can follow. Move the section to §2b or §10 (§10 already
   * restates the rule) and every other assertion below still passes, the
   * anchor still resolves, and both citations quietly point at a section that
   * no longer holds the rule.
   */
  const SECTION = "## 2a.";

  /** Where §10 restates the rule and delegates the table back to §2a. */
  const INVARIANTS = "## 10.";

  const topLevel = (prefix: string): string =>
    parity.split(/^(?=## )/m).find((s) => s.startsWith(prefix)) ?? "";

  const doctrine = sectionNamed(/containment transfers authorisation/i);

  it("states the rule in full where the PRD chain's reader already is", () => {
    expect(doctrine).not.toBe("");
    expect(doctrine).toMatch(/sequencing does not/i);
    expect(doctrine).toMatch(/transitively/i);
    expect(topLevel(SECTION)).toContain(doctrine);
  });

  /**
   * The verdicts alone are the version that gets re-litigated. The sub-issue
   * row is the load-bearing one and the only one whose reasoning is not
   * self-evident, so it carries both halves: the contract it contradicts (the
   * walk is API order and reads no edge) and the design reason underneath —
   * slices are pieces of one feature on one branch, so a slice needing outside
   * work blocks the whole PRD.
   *
   * The row's own cell is asserted, not just the paragraph it points at: a row
   * gutted to `| PRD **sub-issue** | ❌ | no |` is the verdicts-only table this
   * section exists to prevent, and the paragraph below would still satisfy
   * every section-scoped assertion here while it sat there unreferenced.
   */
  it("keeps the three-row table, and the sub-issue row's reasoning with it", () => {
    const rows = (doctrine.match(/^\|.*\|$/gm) ?? []).filter((r) => /✅|❌/.test(r));

    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.includes("❌"))).toHaveLength(1);
    expect(rows.find((r) => r.includes("❌"))).toMatch(/sub-issue/i);
    expect(rows.find((r) => r.includes("❌"))).toMatch(/ordering contract/i);
    expect(doctrine).toContain("docs/agents/ticket-shape.md");
    expect(doctrine).toMatch(/whole PRD/i);
  });

  /**
   * Reachable from the contract it explains. `ticket-shape.md` is where the
   * topological sort is placed on whoever publishes the batch; a reader who
   * asks *why the chain does not just read the edges* is reading that file.
   *
   * Every direction is checked against the headings that exist: inbound from
   * `ticket-shape.md`, internal from §10, and outbound — the sub-issue row cites
   * the ordering contract by anchor, and that heading lives in a file this one
   * does not otherwise constrain. An anchor renamed out from under any of them
   * still renders as a link and still goes nowhere.
   *
   * Each direction gets both halves, existence and resolution, because the
   * half-done edit is the silent one. §10 states the rule and then delegates
   * the table and the sub-issue row's reasoning here; degrading that pointer to
   * plain italics leaves §10 delegating to a section it no longer names, which
   * no resolution check can see. It is asserted against §10's own text rather
   * than against every internal link, since the ordering note earlier in §2a
   * now carries the same anchor and would satisfy a bare search on its own.
   *
   * Existence is deliberately "a citation exists" rather than the slug spelled
   * out a second time: renaming a heading and moving its links with it is a
   * legitimate edit, and only the half-done version fails here.
   */
  it("is reachable from the ordering contract, by links that resolve both ways", () => {
    const inbound = [...ticketShape.matchAll(/\]\(\.\.\/parity\.md#([^)]+)\)/g)].map((m) => m[1] ?? "");
    const internal = [...parity.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] ?? "");
    const outbound = [...parity.matchAll(/\]\(\.\/agents\/ticket-shape\.md#([^)]+)\)/g)].map((m) => m[1] ?? "");

    const slug = slugOf(doctrine.split("\n")[0] ?? "");

    expect(inbound).toContain(slug);
    expect(topLevel(INVARIANTS)).toContain(`](#${slug})`);
    expect(doctrine).toMatch(/\]\(\.\/agents\/ticket-shape\.md#[^)]+\)/);
    for (const anchor of [...inbound, ...internal]) expect(anchors).toContain(anchor);
    for (const anchor of outbound) expect(ticketShapeAnchors).toContain(anchor);
  });
});

/**
 * The other half of `ISSUES_WRITE_EXEMPT`'s newest entry (#51).
 *
 * That list argues the parity invariant in a comment, because the pair it lets
 * through is the first in the loop that genuinely **creates** issues. The
 * invariant itself lives in `docs/parity.md` §10 — and until this slice it read
 * "an agent that raises work never files it. Filing is a separate,
 * human-labelled step", whose second clause the filing workflow overturns
 * outright: nothing labels a merged pull request by hand.
 *
 * An invariant amended only where it is *obeyed* is one the next reader finds
 * contradicted by the code citing it, and the citation is a string nothing
 * dereferences — the same failure the blocker-edge describe above exists for.
 * So the amendment is asserted where it is written: the two halves that survive
 * intact, and the reason the change is a move of the gate rather than the
 * removal of one.
 */
describe("the filing invariant is amended where it is written, not only where it is obeyed", () => {
  const parity = fs.readFileSync(path.join("docs", "parity.md"), "utf8");

  /** The bullet, from its bolded lede to the start of the next one. */
  const invariant = (): string =>
    parity
      .split(/^(?=- \*\*)/m)
      .find((bullet) => bullet.startsWith("- **An agent that raises work never files it.")) ?? "";

  /**
   * The headline survives the amendment and is not weakened to fit: the review
   * agent emits its findings into its own review body under `contents: read`
   * and `issues: read`, which files nothing, and the workflow that spends the permission runs no
   * model at all. Those two are what the invariant was protecting; the
   * human-labelled step was how it was protected, not what it was for.
   */
  it("restates the two halves that still hold", () => {
    expect(invariant()).not.toBe("");
    expect(invariant()).toMatch(/runs no model/);
    expect(invariant()).toMatch(/contents: read/);
    for (const file of MERGE_GATED) expect(invariant()).toContain(path.basename(file, ".yml"));
  });

  /**
   * And says what stopped being true, in the words it used to be true in. A
   * silently dropped clause reads as an oversight to whoever finds the
   * workflow; named, it reads as a decision with a reason under it — the
   * concern was an unattended cycle, and the gate has moved from before filing
   * to before building, which is `needs-triage` rather than `agent:implement`
   * on every stub.
   */
  it("names the clause it overturns, and the gate that replaced it", () => {
    expect(invariant()).toMatch(/human-labelled/);
    expect(invariant()).toMatch(/before building/);
    expect(invariant()).toMatch(/needs-triage/);
  });

  /**
   * And the comparison this file is *for* has a row for the workflow the
   * amendment is about. `docs/parity.md` states its own rule in a blockquote —
   * update the row in the same pull request that changes the behaviour, because
   * it drifted once already and a parity doc that contradicts itself is worse
   * than none — and nothing enforced it. This does, for the one table where the
   * set is knowable from here.
   */
  it("gives every workflow in the loop a row in the comparison", () => {
    const table = parity.split(/^(?=## )/m).find((s) => s.startsWith("## 1.")) ?? "";

    expect(table).not.toBe("");
    for (const command of RUNNER_COMMANDS) expect(table).toContain(`\`agent-${command}\``);
  });
});

/**
 * PRD #171 changed what a PRD chain's pull requests are — a **slice PR** per
 * sub-issue, each with its own review round, and one **PRD PR** a human merges
 * — and four docs stated the old shape as a rule: `docs/parity.md` §2a and §10
 * ("review is once per PR, never once per slice"), `CONTEXT.md` ("review adds a
 * trigger label in exactly one case"), `docs/agents/ticket-shape.md` ("one PR
 * per PRD"), and `docs/ADOPTING.md`, which had no word on what a verdict does
 * to a chain.
 *
 * The same failure the filing invariant's describe above exists for: a rule
 * amended only where it is obeyed is one the next reader finds contradicted by
 * the code citing it. So each amendment is asserted where the old rule was
 * written — the old wording gone as a rule, the new one present, and the half
 * that survived (no per-slice review *workflow*, the once-per-PR automatic fix)
 * restated rather than dropped.
 */
describe("the one-PR-per-PRD rule is amended where it is written, not only where it is obeyed", () => {
  const parity = fs.readFileSync(path.join("docs", "parity.md"), "utf8");
  const context = fs.readFileSync("CONTEXT.md", "utf8");
  const adopting = fs.readFileSync(path.join("docs", "ADOPTING.md"), "utf8");
  const ticketShape = fs.readFileSync(path.join("docs", "agents", "ticket-shape.md"), "utf8");

  const topLevel = (doc: string, prefix: string): string =>
    doc.split(/^(?=## )/m).find((s) => s.startsWith(prefix)) ?? "";

  const subsection = (doc: string, heading: RegExp): string =>
    doc.split(/^(?=#{2,6} )/m).find((s) => heading.test(s.split("\n")[0] ?? "")) ?? "";

  const bullet = (doc: string, lede: string): string =>
    doc.split(/^(?=- \*\*)/m).find((b) => b.startsWith(`- **${lede}`)) ?? "";

  /**
   * Rewritten, not patched: the trade's heading is the new rule, and the old
   * one survives only as what the section *used* to say. The table loses the
   * row that requested review once, on the last slice, and gains the rows the
   * chain now runs by.
   */
  it("rewrites parity §2a: the slice PR is the unit of review, the PRD PR the unit of merge", () => {
    const section = topLevel(parity, "## 2a.");
    const trade = subsection(section, /^### The trade/);

    expect(section).not.toMatch(/^### The trade: review is once per PR, not once per slice$/m);
    expect(section).not.toContain("Adds `agent:review` to the PR only when no sub-issues remain");
    expect(section).not.toMatch(/asks for `agent:review`\s+on it by hand/);
    expect(trade).toMatch(/^### The trade: the slice PR is the unit of review, the PRD PR the unit of merge$/m);
    expect(trade).toMatch(/no per-slice review\s+workflow/);
    expect(trade).toMatch(/integration review/);
    expect(trade).toMatch(/automatic-fix bound is per pull request/);
    expect(section).toContain("Adds `agent:review` to **every** slice PR");
    expect(section).toMatch(/resumes the handover/);
  });

  /**
   * §10 names the clause it overturns in the words it used to be true in, and
   * keeps the bound it did not touch: the automatic fix is still bounded per
   * pull request (once, until #201 made it a budget), so a slice PR and the PRD
   * PR each get the budget.
   */
  it("amends parity §10's review bullet, keeping the per-PR automatic-fix bound", () => {
    const invariants = topLevel(parity, "## 10.");
    const amended = bullet(invariants, "Review is requested once per slice PR, plus one integration review.");

    expect(bullet(invariants, "Review is requested once per PR, never once per slice.")).toBe("");
    expect(amended).not.toBe("");
    expect(amended).toContain('"once per PR, never once per slice"');
    expect(amended).toMatch(/no per-slice\s+review workflow/);
    expect(amended).toMatch(/bounded per pull\s+request/);
    expect(amended).toContain("](#the-trade-the-slice-pr-is-the-unit-of-review-the-prd-pr-the-unit-of-merge)");
  });

  /**
   * The advance job is a second arrow, and what makes it one rather than a
   * cycle is said where the first arrow's reasoning is: it lands on the parent,
   * never on a pull request, and is bounded by the number of sub-issues.
   */
  it("amends CONTEXT.md: review adds a trigger label in two cases, and the table has implement-prd's row", () => {
    expect(context).not.toContain("Review adds a trigger label in exactly one case");
    expect(context).toContain("Review adds a trigger label in two cases.");

    const second = context.split(/\n\n/).find((p) => p.includes("**advance**")) ?? "";
    expect(second).toMatch(/second arrow/);
    expect(second).toMatch(/\*\*parent\*\*/);
    expect(second).toMatch(/\*\*bounded by the number of sub-issues\*\*/);

    const rows = context.match(/^\| `agent:implement` on .*\|$/gm) ?? [];
    expect(rows.find((r) => r.includes("**issue**"))).toContain("| `implement` |");
    const prd = rows.find((r) => r.includes("**PRD parent**")) ?? "";
    expect(prd).toContain("| `implement-prd` |");
    expect(prd).toMatch(/approval/);
    expect(prd).toMatch(/hand the PRD PR over/);
  });

  /**
   * What an adopter sees per verdict on a slice round (#249): every heading
   * the verdict table names, since each one moves the chain differently, and
   * the three ways on from a park. Nothing about CI on the PRD branches: the
   * PRD PR's base is the default branch, so there is nothing to configure.
   */
  it("gives ADOPTING.md the slice-round experience per verdict", () => {
    const section = subsection(adopting, /^### The verdict on a slice round$/);

    expect(topLevel(adopting, "## 3b.")).toContain(section);
    expect(section).not.toBe("");
    for (const row of Object.values(VERDICTS)) expect(section).toContain(row.heading);
    expect(section).toMatch(/\*\*parks\*\*/);
    expect(section).toMatch(/\*\*waits\*\*/);
    expect(section).toContain("`agent:fix` for another fix round");
    expect(section).toContain("declining a finding by replying to it, then `agent:review`");
    expect(section).toContain("pushing your own commit, then `agent:review`");
    expect(adopting).not.toMatch(/reviews once at the end/);
  });

  /**
   * The chain without slice PRs (#249), in the two documents an adopter and
   * a contributor read: none of the retired terms is left describing the chain
   * as it is, and the CI requirement on PRD branches is gone with them.
   */
  it("retires the slice-PR vocabulary from CONTEXT.md and ADOPTING.md", () => {
    for (const doc of [context, adopting]) {
      expect(doc).not.toMatch(/slice PRs?\b/i);
      expect(doc).not.toMatch(/slice branch/i);
      expect(doc).not.toMatch(/integration review/i);
      expect(doc).not.toMatch(/slices table/i);
      expect(doc).not.toMatch(/chain-merge/);
      expect(doc).not.toContain("advance-merged");
    }
    expect(adopting).not.toContain("'agent/prd-**'");
    for (const term of ["**slice range**", "**slice round**", "**final review**", "**progress list**", "**finishing run**"]) {
      expect(context).toContain(term);
    }
  });

  it("amends ticket-shape.md: every slice on one PRD branch, one PRD PR per parent", () => {
    expect(ticketShape).not.toMatch(/one PR per PRD/);
    expect(ticketShape).not.toMatch(/slice PR/);
    expect(ticketShape).toMatch(/one PRD PR per parent/);
  });
});

/**
 * The runner contract, held to by every workflow in the set: fetch the context
 * before the agent starts, scrub the token, and leave every tracker mutation to
 * the workflow. `implement-prd` is the first runner handed *two* issues — the
 * PRD for context and the sub-issue for the task — so both go through the same
 * author gate.
 */
describe("the implement-prd runner keeps the agent off the tracker", () => {
  const RUNNER = "implement-prd/implement-prd.ts";
  const PROMPT = "implement-prd/prompt.md";

  it("author-gates both issues and scrubs the token before running", () => {
    const text = fs.readFileSync(RUNNER, "utf8");

    // Every issue this runner reads goes through the trusted helpers — nothing
    // shells out to `gh` for text. An ungated *PRD* body steers the agent just
    // as effectively as an ungated sub-issue body, so both are named here.
    expect(text).toContain("fetchTrustedIssue(");
    expect(text).toContain("fetchTrustedComments(");
    expect(text).not.toMatch(/safeSh\(|\bsh\(`gh /);
    for (const source of ["ISSUE_NUMBER", "SUB_NUMBER"]) {
      expect(text).toMatch(new RegExp(`issueSection\\(${source}`));
    }
    expect(text.indexOf("scrubGitHubTokens()")).toBeLessThan(text.indexOf("sandcastle.run"));
  });

  /**
   * Counting commits against `main` would count every earlier slice, so a run
   * where the agent did nothing at all would still look productive from the
   * second slice on. The tip at entry is the only honest baseline.
   */
  it("measures this run's commits from the branch tip, not from main", () => {
    const text = fs.readFileSync(RUNNER, "utf8");

    expect(text).not.toContain("main..HEAD");
    expect(text).toContain("rev-list");
  });

  it("tells the agent to implement one sub-issue and touch no tracker state", () => {
    const prompt = fs.readFileSync(PROMPT, "utf8");

    expect(prompt).toContain("{{SUB_NUMBER}}");
    expect(prompt).toContain("{{BRANCH}}");
    expect(prompt).toMatch(/Do not push\./);
    expect(prompt).toMatch(/Do not close/);
  });
});

/**
 * The runners are invoked as a **version-pinned npm package**, never as a script
 * addressed by path (jeffwlawson/winget-manifest-lint#96).
 *
 * That is what retires the stale-runner trap. `pull_request_target` takes the
 * workflow YAML from the *base* branch and checks out the **PR head**, so
 * `npx tsx .sandcastle/…/review.ts` ran whatever version of the runner the PR
 * happened to carry — silently, with no error, which is how
 * jeffwlawson/winget-manifest-lint#46 reviewed a diff with the pre-suggestion
 * `review.ts`. A version in the YAML is on the base side of that split, so the
 * runner is base-controlled like every other security control in these files.
 *
 * The pin has to live *here*. Depending on the package from the caller's
 * `package.json` would put the version back under the PR head's control and
 * change nothing at all.
 */
describe("every workflow invokes the runners at a pinned version", () => {
  const PACKAGE_DIR = ".";
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as {
    readonly name: string;
    readonly version: string;
    readonly bin?: Record<string, string>;
    readonly files?: readonly string[];
  };

  /**
   * `agent-<name>.yml` runs the `<name>` subcommand — derived, not tabulated,
   * and `-reusable` is dropped because the two halves of a converted workflow
   * are one workflow with one runner between them
   * (jeffwlawson/winget-manifest-lint#97).
   */
  const subcommandOf = (file: string): string =>
    path.basename(file, path.extname(file))
      .replace(/^agent-/, "")
      .replace(/-reusable$/, "");

  const escaped = manifest.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /**
   * An **exact** version, spelled out: `\d+\.\d+\.\d+` matches no `^`, no `~`,
   * no `latest` and no dist-tag. Same reasoning as `.nvmrc` — a floating pin is
   * a runner that changes under a PR nobody touched, which is the trap above
   * with a longer fuse.
   */
  const PIN = new RegExp(
    `^npm exec --prefix "\\$RUNNER_TEMP" --yes --package=${escaped}@(\\d+\\.\\d+\\.\\d+) -- agent-workflows ([a-z-]+)$`,
  );

  /**
   * The one hand-over line in a workflow: the step that runs the published
   * runner.
   *
   * `npm exec --prefix` and not a bare `npx`, because `npx pkg@version` reuses a
   * package already in the working directory when it satisfies the spec — and in
   * this repository the checkout *is* that package, with no `dist/` built, so the
   * bin resolves to nothing (#8). The prefix moves the install, not the `cwd`.
   */
  const invocation = (file: string): string => {
    const invocations = stepsOf(file)
      .map((step) => (step.run ?? "").trim())
      .filter((run) => run.startsWith("npm exec") || run.startsWith("npx "));

    expect(invocations).toHaveLength(1);
    return invocations[0] as string;
  };

  /**
   * One runner workflow per subcommand, still, after a conversion moved one of
   * them into a second file. A caller has no `npx` line of its own — it is the
   * file it calls that hands over — so this is the check that says the pin
   * moved *with* the steps rather than being left behind or lost.
   */
  it("finds the agent workflows", () => {
    expect(runnerWorkflows.map(subcommandOf).sort()).toEqual([
      "fix",
      "follow-ups",
      "implement",
      "implement-prd",
      "review",
      "update-branch",
    ]);
  });

  it.each(runnerWorkflows)("%s: runs its own subcommand, at an exact version", (file) => {
    const match = invocation(file).match(PIN);

    expect(match).not.toBeNull();
    expect(match?.[2]).toBe(subcommandOf(file));
  });

  /**
   * The pin and the package are edited in different files, and neither edit
   * fails on its own: publishing 0.2.0 without repinning leaves every workflow
   * on the old runner, and repinning without publishing takes the whole loop
   * down at `npx`. Both read as "done" to the person who did half of it.
   */
  it.each(runnerWorkflows)("%s: pins the version this repo publishes", (file) => {
    expect(invocation(file).match(PIN)?.[1]).toBe(manifest.version);
  });

  /**
   * The other half of the same property: nothing may execute a runner *source*
   * out of the checkout. A single surviving `npx tsx .sandcastle/…​.ts` line
   * would be one workflow still on the PR-head side of the split, and it would
   * look identical to the four that are not.
   *
   * Keyed on running a `.ts` file from that tree rather than on naming the tree
   * at all: `npm --prefix .sandcastle/agent-workflows run build` names it and
   * executes nothing the pull request wrote.
   */
  const RUNNER_BY_PATH = /\.sandcastle\/\S*\.ts\b/;

  it.each(workflowFiles)("%s: runs no runner source out of the checkout", (file) => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const inRun = runBlockLines(lines);

    const offenders = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line, n }) => inRun.has(n) && !/^\s*#/.test(line) && RUNNER_BY_PATH.test(line))
      .map(({ line, n }) => `${file}:${n} ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  /**
   * One binary for the whole set. The per-workflow runners and the operator
   * commands `init` / `doctor` (jeffwlawson/winget-manifest-lint#112) share an
   * entry point and therefore a version, so "which runner version is this repo
   * on?" has one answer rather than five.
   *
   * **The leading `./` is forbidden, not incidental.** `npm publish` normalises
   * the manifest before upload and *silently drops* a `bin` entry whose path
   * starts with `./`, reporting it as one warning among several and then
   * exiting 0. The tarball is unaffected — `dist/cli.js` is in it and the
   * packaged manifest names it — so only the registry manifest loses the entry,
   * and the sole symptom is `npx <pkg> <cmd>` resolving the package and finding
   * no command to run. Version 0.1.0 shipped exactly that.
   *
   * This assertion previously required `"./dist/cli.js"`, so the test encoded
   * the defect and would have blocked its fix. `.github/workflows/ci.yml` runs
   * `npm publish --dry-run` and fails on the one log line that reveals it; this
   * is the cheap check beside it.
   */
  it("publishes one binary, built from source", () => {
    expect(Object.values(manifest.bin ?? {})).toEqual(["dist/cli.js"]);
    expect(manifest.files).toContain("dist");
  });

  /**
   * **And the documentation writes no version down at all.**
   *
   * Every pin in YAML is checked against `package.json` by the tests above, so
   * the two that matter cannot drift. Prose was the third copy, read by nothing:
   * `CLAUDE.md` and `docs/ADOPTING.md` still said `@v0.1.1` two releases later,
   * and `ADOPTING.md` additionally showed the bare `npx` form that #8 replaced —
   * a reader following it would install the pattern the loop stopped using, at a
   * version it stopped publishing. Neither was noticed by a release that
   * otherwise renames the version in seventeen places.
   *
   * The rule is *no literal*, not *the right literal*: a correct copy is still a
   * copy, and the next release makes it wrong again. Docs say `@v<tag>` and
   * point at the callers, which carry the live one.
   *
   * `docs/friction.md` is exempt because it is a dated narrative log — its
   * `0.1.1` lines are records of what was true that day, and CLAUDE.md forbids
   * editing history into it.
   *
   * Walked rather than listed, for the reason `copy-assets.ts` walks: a doc
   * added next release is the one file nobody adds to a list.
   */
  it("names no version in prose, only in the pins under test", () => {
    const PIN_IN_PROSE = /agent-workflows\S*@v?\d+\.\d+\.\d+/g;
    const EXEMPT = new Set(["docs/friction.md"]);
    const SKIPPED = new Set(["node_modules", "dist", "output", ".git"]);

    const docsUnder = (dir: string): readonly string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : docsUnder(rel);
        return entry.name.endsWith(".md") && !EXEMPT.has(rel) ? [rel] : [];
      });

    const offenders = docsUnder(".").flatMap((doc) =>
      (fs.readFileSync(doc, "utf8").match(PIN_IN_PROSE) ?? []).map((hit) => `${doc}: ${hit}`),
    );

    expect(offenders).toEqual([]);
  });
});

/**
 * …and nothing here can see the pin in a repository that adopted the loop.
 *
 * Both copies of the `@ref` in *this* tree are derived from `package.json` and
 * checked by name, so a release cannot leave either behind. An adopter's five
 * callers are outside that: a release moves nothing in their repository and
 * tells nobody, so the pin sits where it was put. Measured in September 2026,
 * one of the three repositories running this loop was four releases behind —
 * the one it was piloted on. That is the failure `cc997af` fixed for prose
 * ("it sat two releases behind before anyone noticed") one layer out, where a
 * test of ours cannot reach.
 *
 * Dependabot can: `package-ecosystem: github-actions` reads a `uses:` ref the
 * same way it reads a dependency, compares it against the latest tag and opens
 * a pull request. `docs/ADOPTING.md` §4 documents the config as an adoption
 * step, and this repository runs the same file — for the *ordinary* action
 * pins, which nothing here tracks. Its `agent-loop` group is inert here, since
 * the release moves both caller sets and `PIN` above holds them to
 * `package.json`; it is an adopter, with no such test, who needs that group.
 *
 * What is asserted here is the half with no symptom. A config that updates
 * nothing is noticed the first time a release lands; a config whose *grouping*
 * is wrong works — it just opens five pull requests per release instead of one,
 * and a partially merged set is a repository running two releases at once.
 */
describe("Dependabot watches the caller pins no test here can reach", () => {
  const DEPENDABOT = path.join(".github", "dependabot.yml");
  const ADOPTING = path.join("docs", "ADOPTING.md");

  interface Group {
    readonly patterns?: readonly string[];
    readonly "exclude-patterns"?: readonly string[];
  }

  interface Update {
    readonly "package-ecosystem"?: string;
    readonly directory?: string;
    readonly schedule?: { readonly interval?: string };
    readonly groups?: Record<string, Group>;
  }

  interface Dependabot {
    readonly version?: number;
    readonly updates?: readonly Update[];
  }

  const configOf = (file: string): Dependabot => parse(fs.readFileSync(file, "utf8")) as Dependabot;

  /** The one `github-actions` block. Every grouping check below reads it. */
  const actions = (): Update => {
    const found = (configOf(DEPENDABOT).updates ?? []).filter(
      (u) => u["package-ecosystem"] === "github-actions",
    );

    expect(found).toHaveLength(1);
    return found[0] as Update;
  };

  /**
   * A `patterns` entry is a glob over the dependency *name* — for a `uses:` ref,
   * everything left of the `@` — and `*` is its only metacharacter.
   */
  const matches = (pattern: string, dependency: string): boolean =>
    new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    ).test(dependency);

  /**
   * The groups a dependency actually lands in. Zero means a pull request of its
   * own; two would be ambiguous, and both are the failure this describe exists
   * for, since neither says anything until a release.
   */
  const groupsFor = (dependency: string): readonly string[] =>
    Object.entries(actions().groups ?? {})
      .filter(
        ([, group]) =>
          (group.patterns ?? []).some((p) => matches(p, dependency)) &&
          !(group["exclude-patterns"] ?? []).some((p) => matches(p, dependency)),
      )
      .map(([name]) => name);

  /**
   * Every `uses:` in a set of workflow files, named the way Dependabot names it:
   * the ref stripped off. Read from the files rather than listed, so the loop's
   * own callers and the actions beside them are both whatever is really there.
   */
  const dependenciesIn = (files: readonly string[]): readonly string[] => [
    ...new Set(
      files.flatMap((file) =>
        (fs.readFileSync(file, "utf8").match(/^\s*(?:- )?uses: \S+/gm) ?? []).map(
          (line) => ((line.split("uses:")[1] ?? "").trim().split("@")[0] ?? ""),
        ),
      ),
    ),
  ];

  const LOOP = "jeffwlawson/agent-workflows";

  it("watches the directory the callers live in, on a schedule", () => {
    expect(configOf(DEPENDABOT).version).toBe(2);
    // `/` is the repository root for this ecosystem; Dependabot reads
    // `.github/workflows` under it. Naming the workflow directory finds nothing.
    expect(actions().directory).toBe("/");
    expect(actions().schedule?.interval).toMatch(/^(daily|weekly|monthly)$/);
  });

  /**
   * One pull request per release, not five. Ungrouped, each caller is its own
   * dependency and gets its own PR — and five PRs is five chances to merge
   * three, which leaves the repository calling two releases at once. The
   * reusable half is base-controlled and the runner version is baked into it,
   * so a half-merged set is two *runner* versions too.
   *
   * Both forms are asserted because the name Dependabot reports for a reusable
   * workflow is the path, while the same repository's actions would be the
   * `owner/repo`; a pattern that covers only one of them is a pattern that
   * stops covering on the day that changes.
   */
  it("moves every caller pin in one pull request", () => {
    const pinned = dependenciesIn(callerFiles).filter((d) => d.startsWith(LOOP));

    expect(pinned.length).toBeGreaterThan(0);
    for (const dependency of [...pinned, LOOP]) {
      expect(groupsFor(dependency)).toEqual([groupsFor(pinned[0] as string)[0]]);
    }
  });

  /**
   * …and the ordinary pins are grouped too, rather than filtered out. The
   * ecosystem is repository-wide: `actions/checkout` and `actions/setup-node`
   * are in scope whether or not anything is said about them, so the choice is
   * between a second group and a stray PR each. They are kept out of the loop
   * group by `exclude-patterns`, because "the pins moved" and "the loop moved"
   * are different reviews.
   */
  it("groups the ordinary action pins separately", () => {
    const actionsUsed = dependenciesIn(workflowFiles).filter((d) => !d.startsWith(LOOP));
    const loopGroup = groupsFor(LOOP)[0];

    expect(actionsUsed.length).toBeGreaterThan(0);
    for (const dependency of actionsUsed) {
      expect(groupsFor(dependency)).toHaveLength(1);
      expect(groupsFor(dependency)).not.toContain(loopGroup);
    }
  });

  /**
   * The documented config and the installed one are the same text, which is the
   * point of documenting it at all: an adopter-side issue asking for Dependabot
   * links §4 rather than restating the YAML, and a second copy is what makes
   * that link worth less than the copy beside it.
   */
  it("runs the config docs/ADOPTING.md tells an adopter to write", () => {
    const blocks = [...fs.readFileSync(ADOPTING, "utf8").matchAll(/```yaml\n([\s\S]*?)```/g)]
      .map((m) => m[1] as string)
      .filter((block) => block.includes("package-ecosystem"));

    expect(blocks).toHaveLength(1);
    expect(parse(blocks[0] as string)).toEqual(configOf(DEPENDABOT));
  });
});

/**
 * §3 of `docs/ADOPTING.md` is the only place a label's **lifecycle** is written
 * down, and until #51 it was written as a rule with an exception after it. Two
 * exceptions is not a rule with exceptions any more — it is a three-valued
 * property, and prose reading "the rule is X, except here, and also except
 * here" is read as "the rule is X" by everyone who is not currently editing it.
 *
 * So the lifecycle is a column, and this is what makes it one: a row that names
 * a label and leaves the column blank — or fills it with a fourth lifecycle
 * nobody has written the rules for — fails here rather than in whichever repo
 * copied the loop and waited for the label to be cleared by something.
 *
 * The second check is the other direction. A label the workflows *write* and
 * §3 never names is a label an adopter never creates, and a label that does not
 * exist makes its transition a silent no-op — the failure §3 opens by naming.
 */
describe("the adoption doc gives every label a lifecycle, in a column", () => {
  const ADOPTING = path.join("docs", "ADOPTING.md");
  const TRIAGE = path.join("docs", "agents", "triage-labels.md");

  /** §3, from its heading to the next top-level one. */
  const labelSection = (): string =>
    fs
      .readFileSync(ADOPTING, "utf8")
      .split(/^(?=## )/m)
      .find((section) => section.startsWith("## 3.")) ?? "";

  /**
   * The lifecycles that exist, spelled as the column spells them. Written out
   * rather than derived, because the point of the list is that adding a fourth
   * is a decision — a new lifecycle is new behaviour somewhere in the loop, and
   * it arrives here as a failing test rather than as a sentence in a table.
   */
  const LIFECYCLES = [
    "on while its run works",
    "cursor",
    "marker, removed on success",
  ];

  const cellsOf = (row: string): readonly string[] =>
    row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.replace(/\*/g, "").trim());

  /** Every row of the lifecycle table: the ones naming a label. */
  const rows = (): readonly string[] =>
    (labelSection().match(/^\|.*\|$/gm) ?? []).filter((row) => row.includes("`agent:"));

  it("fills the column in on every row, from the lifecycles that exist", () => {
    expect(rows().length).toBeGreaterThan(0);
    expect([...new Set(rows().map((row) => cellsOf(row)[1]))].sort()).toEqual(
      [...LIFECYCLES].sort(),
    );
  });

  /**
   * Comments count. A label named only in a `#` line is still a label somebody
   * reading the file will reach for, and a label named only in comments, as
   * the retired `agent:queued` once was in two, is exactly that case. An HTML comment
   * marker such as the slices table's `<!-- agent:slices -->` is body text a
   * step reads, never a label, and is not counted.
   */
  it("names every agent label the workflow files name", () => {
    const used = [
      ...new Set(
        workflowFiles.flatMap((file) => fs.readFileSync(file, "utf8").match(/(?<!<!-- \/?)agent:[a-z-]+/g) ?? []),
      ),
    ].sort();

    expect(used.length).toBeGreaterThan(0);
    for (const label of used) expect(labelSection()).toContain(`\`${label}\``);
  });

  /**
   * **The retired labels are nobody's to create** (#204). `agent:auto-fixed`
   * went with #201, when the rounds spent began to be counted from the pull
   * request's verdicts, and `agent:queued` because native "blocked by" links do
   * its job. Named as history where a doc explains the change, and never in
   * §3's list of labels to create nor in a `gh label create` line anywhere.
   */
  it("offers no retired label as a live one", () => {
    const docs = [
      "CONTEXT.md",
      ADOPTING,
      TRIAGE,
      path.join("docs", "parity.md"),
      path.join("docs", "agents", "ticket-shape.md"),
      path.join("setup", "SETUP.md"),
    ];
    for (const label of ["agent:auto-fixed", "agent:queued"]) {
      expect(labelSection(), label).not.toContain(label);
      for (const doc of docs) {
        expect(fs.readFileSync(doc, "utf8"), `${doc}: ${label}`).not.toMatch(
          new RegExp(`gh label create +"${label}"`),
        );
      }
    }
  });

  /**
   * **`agent:in-progress` retired with #236**, when the trigger labels began
   * staying on while their run works. §3 names it once, where it says `init`
   * deletes it, so it is in no row of the table and no `gh label create` line,
   * and no workflow names it at all.
   */
  it("offers agent:in-progress as nothing but retired", () => {
    const label = "agent:in-progress";
    for (const doc of ["CONTEXT.md", ADOPTING, TRIAGE, path.join("docs", "parity.md"), path.join("setup", "SETUP.md")]) {
      expect(fs.readFileSync(doc, "utf8"), doc).not.toMatch(new RegExp(`gh label create +"${label}"`));
    }
    for (const row of rows()) expect(row).not.toContain(label);
    for (const file of workflowFiles) expect(fs.readFileSync(file, "utf8"), file).not.toContain(label);
  });

  /**
   * And the labels this repo's own tracker defines are defined once. `init`'s
   * table is held to §3 by `tests/agent-cli.test.ts`; `docs/agents/triage-labels.md`
   * is the third copy, and the first two labels the loop files a stub with come
   * from *its* vocabulary rather than from the `agent:*` one. A colour is
   * harmless to get wrong twice; the **name** is not, and it is the same line
   * that carries both.
   */
  it("defines a label the same way wherever it is defined twice", () => {
    const LABEL_COMMAND = /^gh label create +"([^"]+)" +--color +(\S+) +--description +"([^"]+)"$/gm;
    const definitionsIn = (file: string): ReadonlyMap<string, string> =>
      new Map(
        [...fs.readFileSync(file, "utf8").matchAll(LABEL_COMMAND)].map(
          ([, name, color, description]) => [name ?? "", `${color} — ${description}`],
        ),
      );

    const adopting = definitionsIn(ADOPTING);
    const triage = definitionsIn(TRIAGE);
    const shared = [...adopting.keys()].filter((name) => triage.has(name));

    expect(shared.length).toBeGreaterThan(0);
    for (const name of shared) expect(triage.get(name)).toBe(adopting.get(name));
  });
});

/**
 * The verdict is machine-readable so a maintainer does not have to read the
 * review — which leaves exactly one thing that has to be written in prose:
 * **what they do about it.** That is the adoption doc's, and it is the copy
 * with no mechanism behind it. A `state` that changed, a description reworded,
 * a fourth state added: the derivation is unit-tested and the doc is not, so
 * the doc is where the loop and what an adopter was told it does come apart.
 *
 * Nothing here checks that the section reads well. What it checks is that the
 * section is about the verdicts the code actually posts — the names, the lines
 * GitHub shows and the states those lines arrive under — so a reader acting on
 * it is acting on this release rather than on the one it was written against.
 *
 * And that the section stays *documentation*. Making `agent-review` a required
 * check is a decision with a repository-wide cost — a verdict that is ever
 * wrong blocks every merge, including the pull requests this loop never
 * reviewed — so it is described for an adopter to take when they trust the
 * verdicts, and nothing here takes it for them.
 */
describe("the adoption doc says what to do with each verdict", () => {
  const ADOPTING = path.join("docs", "ADOPTING.md");

  /** The section, by what its heading is about rather than by its number. */
  const section = (): string =>
    fs
      .readFileSync(ADOPTING, "utf8")
      .split(/^(?=## )/m)
      .find((s) => /^## .*verdict/i.test(s.split("\n")[0] ?? "")) ?? "";

  it("names every verdict, with the line it posts and the state it posts under", () => {
    expect(section(), "docs/ADOPTING.md needs a section whose heading names the verdict").not.toBe(
      "",
    );
    expect(section()).toContain(`\`${VERDICT_CONTEXT}\``);

    const causes = Object.values(CLOSER_LOOK).map((lines) => ({ ...VERDICTS["needs a closer look"], ...lines }));
    for (const row of [...Object.values(VERDICTS), ...causes]) {
      // The heading rather than the key: the heading is what an adopter sees on
      // their own pull requests, and the key is the machine-readable half only
      // `verdict.json` carries. *Needs a closer look*'s three causes share a
      // heading, and the descriptions below are what tell them apart here.
      expect(section()).toContain(row.heading);
      // The description verbatim, because it is what GitHub shows beside the
      // status: a paraphrase here is an adopter told to do something other
      // than what their own pull requests will tell them.
      expect(section()).toContain(row.description);
      expect(section()).toContain(`\`${row.state}\``);
    }
  });

  /**
   * The inbox pair, derived from the states rather than listed. `status:` is a
   * search over the head commit's combined state, so one search per state a
   * verdict can post is what makes the pair exhaustive — a fourth state, or a
   * verdict moved from `failure` to `pending`, leaves open pull requests in
   * neither search and fails here instead.
   */
  it("gives a search per state a verdict posts, so no open pull request is in neither", () => {
    for (const state of new Set(Object.values(VERDICTS).map((row) => row.state))) {
      expect(section()).toContain(`is:pr is:open status:${state}`);
    }
  });

  /**
   * Written where the adopter decides, and nowhere else. Branch protection is
   * repository configuration a caller could reach — `init` runs in their
   * checkout and the loop holds a token — and the point of documenting it is
   * that it is theirs to switch on after the verdicts have earned it.
   */
  it("documents the required check without anything here enabling one", () => {
    expect(section()).toMatch(/required status check/i);

    const SKIPPED = new Set(["node_modules", "dist", "output", ".git", "tests"]);
    const PROTECTION =
      /required_status_checks|required_conversation_resolution|branches\/[^\s"'`]*\/protection|\/rulesets\b/i;

    const sourceUnder = (dir: string): readonly string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : sourceUnder(rel);
        return /\.(ts|yml|yaml)$/.test(entry.name) ? [rel] : [];
      });

    const offenders = sourceUnder(".").filter((file) =>
      PROTECTION.test(fs.readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * The body an adopter reads is now a **record** (#109, decision 8), and the
   * section that tells them what to do with a verdict is where they meet it.
   *
   * Derived from a rendered body rather than transcribed, for the reason the
   * verdict rows above are: the group headings, the badges and the *new* mark
   * are what a maintainer sees on their own pull requests, and a doc that names
   * three groups the renderer no longer writes is a reader looking for
   * something that is not there. Renaming a group is then a failure here rather
   * than a discovery on somebody else's repository.
   */
  it("names the groups, the badges and the *new* mark the body actually renders", () => {
    const labelled = (id: string, label: string, over: Partial<Finding> = {}): PlacedFinding => ({
      id,
      placement: "line",
      finding: {
        title: "the guard runs after the return",
        path: "src/queue.ts",
        line: 206,
        body: `**${label}.** the guard runs after the return`,
        severity: "high",
        ...over,
      },
    });

    // One entry in every group, so every heading a reader can meet is rendered.
    const body = renderReviewBody({
      verdict: VERDICTS["changes recommended"],
      output: {
        findings: [],
        followUps: [],
        fixBeforeMerge: [],
        verified: [],
        howChecked: "Ran the suite.",
      },
      placed: [
        labelled("f-open", FIX_BEFORE_MERGE_LABEL),
        labelled("f-missed", PREVIOUSLY_MISSED_LABEL, { severity: "low" }),
      ],
      movedToFollowUps: 0,
      stillOpen: [],
      resolved: [{ id: "f-done", threadId: "PRRT_one", text: "the cache key omits the tenant" }],
      followUps: [
        {
          title: "Leak in parse()",
          location: "src/other.ts:88",
          body: "evidence",
          severity: "medium",
        },
      ],
      droppedFollowUps: 0,
    });

    // `<b>` names a group; `Follow-ups` carries a trailing clause in its own
    // summary line, so the name is taken from the bold element rather than
    // from the line.
    const groups = [...body.matchAll(/<summary><b>(.*?)<\/b>/g)].map(([, title]) => title ?? "");
    expect(groups).toEqual([
      "Open",
      "Previously missed",
      "Resolved since last review",
      "Follow-ups",
      "How this was checked",
    ]);
    for (const group of groups) {
      expect(group).not.toBe("");
      expect(section()).toContain(`**${group}**`);
    }

    // The badge as a reader *sees* it, which since #135 is a chip with the word
    // drawn in it: the doc names the word, never the `<img>` tag that carries
    // it, and the alt text is what makes those the same thing.
    for (const severity of SEVERITIES) {
      expect(section()).toContain(severityWord(severity));
      expect(section()).not.toContain(severityBadge(severity));
    }
    expect(section()).toContain("*new*");

    // And the cost of the chip being an image, which is the one thing about the
    // body an adopter is taking on rather than reading: their review comments
    // load it from this repository, and a rename leaves the alt text behind
    // (#135).
    expect(section()).toMatch(/alt text/i);
    expect(section()).toContain("jeffwlawson/agent-workflows");
    expect(section()).toContain(severityAssetPath("high").replace("high", "<rating>"));
  });

  /**
   * Who closes a thread, which #111 moved. An adopter reading a review sees
   * threads open and close without either half naming itself, and the two
   * wrong conclusions are symmetrical: that the fix run's `addressed` reply
   * settled something, or that an open thread means no fix run has been near
   * it. Both are corrected by one sentence, and this is where it has to be.
   */
  it("says the review closes threads and the fix run does not", () => {
    expect(section()).toMatch(/the review[^.]{0,60}resolves\b/i);
    expect(section()).toMatch(/`agent:fix`[^.]{0,80}resolves none/i);
    // And the consequence a reader draws the wrong conclusion from without
    // it: a thread the fix run declined is nobody's to close but yours.
    expect(section()).toMatch(/declined[^.]{0,120}stays open/i);
  });

  /**
   * The second optional gate (#109, decision 11), written under the same rule
   * as the first: described for an adopter to switch on once the resolutions
   * have earned it, and switched on by nothing here. The file scan in the test
   * above is the half that holds the second clause — its pattern covers the
   * setting this one is about.
   */
  it("documents conversation resolution as an optional gate, beside the required check", () => {
    expect(section()).toMatch(/conversation resolution/i);
    // What it costs is the part an adopter cannot infer from GitHub's own
    // wording: the reviewer's resolutions become the merge gate, so a finding
    // the fix run declined holds the merge until a human rules on it.
    expect(section()).toMatch(/declined[^.]{0,200}stay open/i);
  });
});

/**
 * **A count no test reads is a count that goes stale.** The rule this repo
 * already applies to the version tag — prose is the one copy nothing checks,
 * and it sat two releases behind before anyone noticed — applied to the other
 * thing `docs/ADOPTING.md` used to write down nine times: how many workflows
 * there are. Adding the sixth (#50) made all nine wrong in one commit.
 *
 * One survives, and it is the one that is an **argument** rather than a fact:
 * ungrouped, Dependabot opens a pull request per caller, and the point of the
 * paragraph is that this is enough of them to merge some and leave the rest —
 * a repository then calling two releases at once. That sentence needs the
 * arithmetic, so the number stays and is derived here instead, from the
 * callers themselves.
 */
describe("the adoption doc counts nothing a release can falsify", () => {
  const ADOPTING = path.join("docs", "ADOPTING.md");
  const DEPENDABOT = path.join(".github", "dependabot.yml");

  const NUMBERS: Record<string, number> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  it("derives the one count it keeps from the callers it is counting", () => {
    const written = /a\s+release opens \*\*(\w+)\*\* pull requests/.exec(
      fs.readFileSync(ADOPTING, "utf8"),
    );

    expect(
      written?.[1],
      "the grouping paragraph must keep its `a release opens **N** pull requests` sentence",
    ).toBeDefined();
    // Counted in callers, not caller files: Dependabot reads one dependency
    // per `uses:`, and the reference set's two caller files hold six (#225).
    expect(NUMBERS[(written?.[1] ?? "").toLowerCase()]).toBe(
      callers.filter((caller) => path.dirname(caller.file) === CALLER_DIR).length,
    );
  });

  /**
   * Everywhere else is uncounted prose, in the adoption doc and in the
   * Dependabot config's header beside it — that header is written for the same
   * reader and goes stale in the same silence, and it is the file this repo
   * actually runs.
   *
   * One phrase is exempt, and it is exempt for the reason the kept count is
   * kept: *the two `implement` workflows* is a closed pair produced by one
   * design decision (they partition every label event by issue shape), so the
   * number is part of what is being said rather than a tally of a set that
   * grows.
   *
   * The emphasis markers between the number and the noun are skipped, which is
   * not cosmetic: *these six are \*workflow state\** is exactly the count this
   * check was written for and exactly the one it let through (#54), because
   * `\s+(workflows?)` wants the noun adjacent and Markdown had put an asterisk
   * in front of it. A guard that reads as though it covers a site it cannot see
   * is worse than one that never claimed to.
   */
  it("counts callers, workflows and files nowhere else", () => {
    const EXEMPT = ["two `implement` workflows", "two implement workflows"];
    const COUNTED = new RegExp(
      `\\b(${Object.keys(NUMBERS).join("|")})\\b(?:\\s+[\\w\`*-]+){0,2}\\s+[*_\`]*(callers?|workflows?|reusables?|files|pins?)\\b`,
      "gi",
    );

    const offenders = [ADOPTING, DEPENDABOT]
      .flatMap((file) =>
        [...fs.readFileSync(file, "utf8").matchAll(COUNTED)].map((hit) => `${file}: ${hit[0]}`),
      )
      .filter((hit) => !EXEMPT.some((phrase) => hit.includes(phrase)));

    expect(offenders).toEqual([]);
  });
});

/**
 * …and neither can it see the one `actions/*` pin this repository does not run.
 *
 * `README.md` shows the install snippet an adopter copies into a workflow of
 * their own, and Dependabot reads `.github/workflows` only — so that pin is
 * outside everything above. It sat on `@v4` while the workflows moved to `@v7`,
 * two majors, with `npm run verify` green throughout: the same shape as the
 * prose pin `cc997af` fixed, and the reason both are checked rather than
 * remembered.
 *
 * The snippet is also *the auth step*. It declares a registry and no toolchain,
 * which is exactly the step the `package-manager-cache: false` guard exists
 * for — a reader copying it onto `@v5` or later gets the implicit npm cache the
 * reusable half spends thirty lines turning off. So the check is equality with
 * the real step rather than a version match: a documented snippet that differs
 * from what the loop runs is worth less than no snippet.
 */
describe("the README's action pins are the ones this repository runs", () => {
  const README = "README.md";

  /** Every fenced `yaml` block, parsed as the step list it is written as. */
  const stepBlocks = (): readonly Step[] =>
    [...fs.readFileSync(README, "utf8").matchAll(/```yaml\n([\s\S]*?)```/g)]
      .flatMap((m) => {
        const parsed: unknown = parse(m[1] as string);
        return Array.isArray(parsed) ? (parsed as readonly Step[]) : [];
      })
      .filter((step) => (step.uses ?? "").startsWith("actions/"));

  it("pins every documented action at the major the workflows use", () => {
    const documented = stepBlocks().map((step) => step.uses as string);
    const run = new Set(
      workflowFiles.flatMap((file) =>
        stepsOf(file)
          .map((step) => step.uses ?? "")
          .filter((uses) => uses.startsWith("actions/")),
      ),
    );

    expect(documented.length).toBeGreaterThan(0);
    for (const uses of documented) expect([...run]).toContain(uses);
  });

  /** The registry half of `setup-node`, in either place: it names a registry. */
  const authStepsIn = (steps: readonly Step[]): readonly Step[] =>
    steps.filter((step) => step.with?.["registry-url"] !== undefined);

  it("documents the auth step the reusable half actually runs", () => {
    const documented = authStepsIn(stepBlocks());
    const real = authStepsIn(stepsOf(REVIEW));

    expect(documented).toHaveLength(1);
    expect(real).toHaveLength(1);
    expect(documented[0]?.with).toEqual(real[0]?.with);
  });
});

/**
 * …and the registry it is pinned *on* is GitHub Packages, not npmjs.
 *
 * That choice adds one thing to every workflow and one thing to every caller,
 * and neither fails in a way that names itself. GitHub Packages has **no
 * anonymous install** — even for a public package — so the install needs a
 * scoped `.npmrc` and a token, and a package the token may not read surfaces as
 * a 401 at `npx` time, which reads like a bad token rather than like the
 * package's access settings (docs/ADOPTING.md §4's cross-repo caveat). A
 * caller's missing `packages: read` is the other half of the same seam and never
 * gets that far: the run is refused before any job starts.
 *
 * Every check here is about that seam. The runner *version* is checked above;
 * this is about whether the pin can be resolved at all.
 */
describe("the runner package is installed from GitHub Packages", () => {
  const PACKAGE_DIR = ".";
  const REGISTRY = "https://npm.pkg.github.com";
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as {
    readonly name: string;
    readonly publishConfig?: Record<string, string>;
  };
  /** `@jeffwlawson`, derived — the scope the `.npmrc` entry must be limited to. */
  const SCOPE = manifest.name.split("/")[0] as string;

  /**
   * `access: public` is an npmjs concept and carries no meaning here — package
   * visibility on GitHub Packages follows the repository. Leaving it beside the
   * registry would read as a setting that does something.
   */
  it("publishes to the registry it installs from, and says nothing else", () => {
    expect(manifest.publishConfig).toEqual({ registry: REGISTRY });
  });

  // Indices, not the steps themselves: `stepsOf` re-parses the file on every
  // call, so two lookups never return the same object and `indexOf` finds
  // nothing.
  const authIndex = (file: string): number =>
    stepsOf(file).findIndex((s) => (s.with ?? {})["registry-url"] !== undefined);

  const authStep = (file: string): Step | undefined => stepsOf(file)[authIndex(file)];

  /**
   * The hand-over step. Matches `npm exec` as well as `npx`, because the
   * invocation moved to `npm exec --prefix` to stop npx reusing this
   * repository's own checkout as the package (#8).
   */
  const runnerStepIndex = (file: string): number =>
    stepsOf(file).findIndex((s) => {
      const run = (s.run ?? "").trim();
      return run.startsWith("npm exec") || run.startsWith("npx ");
    });

  /**
   * Scoped, so a caller's own `npm ci` still resolves everything else from
   * npmjs. An unscoped `registry-url` would point *every* install at GitHub
   * Packages, which is a working loop sitting on top of a broken repo.
   */
  it.each(runnerWorkflows)("%s: writes a scoped registry entry, not a global one", (file) => {
    const step = authStep(file);

    expect(step?.uses ?? "").toMatch(/^actions\/setup-node@/);
    expect(step?.with?.["registry-url"]).toBe(REGISTRY);
    expect(step?.with?.["scope"]).toBe(SCOPE);
  });

  /**
   * After the toolchain `setup-node` and before the runner. Both write the same
   * `.npmrc` and the last one wins, so an auth step placed first is one a repo
   * with a Node toolchain silently overwrites — and the toolchain step is the
   * one an adopter may skip entirely, which is why the auth step declares no
   * `node-version-file` of its own.
   */
  it.each(wiredWorkflows())("%s: authenticates after the toolchain, before the run", (file) => {
    const auth = authIndex(file);
    const toolchain = stepsOf(file).findIndex(
      (s) => s.with?.["node-version-file"] !== undefined,
    );

    expect(toolchain).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThan(toolchain);
    expect(auth).toBeLessThan(runnerStepIndex(file));
    expect(authStep(file)?.with?.["node-version-file"]).toBeUndefined();
  });

  /**
   * And it says so in the one place `setup-node` would otherwise infer it.
   * From v5 the action caches automatically when the repository's
   * `package.json` carries a `packageManager` field, and
   * `package-manager-cache` has defaulted to `true` since that same release
   * (v6 and v7 only widen detection to `devEngines.packageManager`) — so the
   * registry half of `setup-node` starts doing toolchain work the step above
   * was written to own.
   *
   * For an adopter whose manifest names npm with **no root lockfile**, the
   * restore throws `Dependencies lock file is not found` and the step fails
   * before the runner starts, which means no `failure_reason.txt` and a run
   * reporting `(no reason file written)` — a signature `CLAUDE.md` already has
   * two unrelated causes for. It would also add a cache save to a
   * `pull_request_target` job. This repository cannot reproduce it: it declares
   * only `engines`, never `packageManager`, so the caching never fires here and
   * the setting changes no behaviour in this repo's own runs. It was written at
   * the `@v4` pin, which had no such input; from `@v7` the input exists and is
   * honoured, so the guard is live for an adopter and still silent here.
   *
   * Both halves in one test on purpose. The input alone would stay green if
   * someone later gave the auth step a toolchain, at which point it is
   * redundant and describes nothing. The pair is the invariant: *this step does
   * no toolchain work, and says so.*
   */
  it.each(runnerWorkflows)("%s: opts out of the implicit toolchain cache", (file) => {
    const step = authStep(file);

    expect(step?.with?.["package-manager-cache"]).toBe(false);
    expect(step?.with?.["node-version-file"]).toBeUndefined();
  });

  /**
   * Gated exactly as the run it exists for. An ungated auth step would run on
   * every refusal — cheap, but it is the same `setup-node` the refusal checks
   * elsewhere in this file assert a refused run never reaches.
   */
  it.each(runnerWorkflows)("%s: is gated the same as the run it serves", (file) => {
    expect(authStep(file)?.if).toBe(stepsOf(file)[runnerStepIndex(file)]?.if);
  });

  /**
   * `setup-node` writes `_authToken=${NODE_AUTH_TOKEN}` into the `.npmrc`
   * literally, so the variable is not optional — without it npm leaves the
   * `${NODE_AUTH_TOKEN}` unexpanded (only `${NAME?}` falls back to empty) and
   * sends that literal to GitHub Packages, which has no anonymous read.
   *
   * v7 removed the dummy `NODE_AUTH_TOKEN` export v4 emitted
   * (`XXXXX-XXXXX-XXXXX-XXXXX`), so the symptom moved: it used to be a token
   * that was never a token, and is now an unresolved `${NODE_AUTH_TOKEN}` and a
   * plain 401. Neither reads as "nobody set the env".
   */
  it.each(runnerWorkflows)("%s: hands the runner step a token", (file) => {
    const step = stepsOf(file)[runnerStepIndex(file)];

    expect(step?.env?.["NODE_AUTH_TOKEN"]).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  /**
   * And the scope that makes that token able to read. Asserted on both halves
   * for the reason the generic permissions check is: the callee's is the bound
   * and the caller's is the grant, and a permission declared only in the callee
   * grants nothing at all.
   */
  it.each(runnerWorkflows)("%s: bounds packages: read", (file) => {
    expect(jobOf(file).permissions?.["packages"]).toBe("read");
  });

  it.each(eachCaller(callers))("%s: grants packages: read", (_name, caller) => {
    expect(caller.job.permissions?.["packages"]).toBe("read");
  });
});

/**
 * The publish side of the same registry (jeffwlawson/winget-manifest-lint#113
 * review). One workflow, one tag shape, two guards.
 *
 * **The trigger is the load-bearing part.** `workflow_dispatch` only registers
 * for workflows present on the *default branch*, so a dispatch-triggered publish
 * could not be run until the pull request adding it had merged — and a pull
 * request that pins a version cannot merge until that version resolves, or it
 * takes every agent run down at `npx`. A tag push runs the workflow from the
 * **tagged commit**, which is the only thing that makes the first publish
 * possible from a branch.
 */
describe("the runner package is published from a tag push", () => {
  const FILE = path.join(WORKFLOW_DIR, "publish.yml");
  const doc = (): Workflow => workflowOf(FILE);

  it("triggers on the prefixed tag, and on nothing that needs a merge first", () => {
    expect(doc().on?.push?.tags).toEqual(["v*"]);
    // The prefix, not a bare `v*`: this repo's headline artifact is the linter,
    // and one tag namespace for two version lines conflates them.
    expect(doc().on?.workflow_dispatch).toBeUndefined();
  });

  /**
   * Two tags pushed close together must not race the registry, and a
   * half-cancelled publish is worse than a queued one — hence first-come rather
   * than the `cancel-in-progress: true` that reads as tidier.
   */
  it("serialises publishes without cancelling one", () => {
    expect(doc().concurrency?.group).toBe("publish");
    expect(doc().concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("takes packages: write and nothing more than it spends", () => {
    expect(jobOf(FILE).permissions).toEqual({ contents: "read", packages: "write" });
  });

  /**
   * The two guards, in order and both present. They catch different mistakes: a
   * tag that names a version the package does not claim (unfindable once
   * published), and a tag that names a version the registry already has
   * (re-pushing a moved tag, which should be a no-op rather than a 409 surfacing
   * as a red run). Neither substitutes for the other.
   */
  it("checks the tag against the manifest before it checks the registry", () => {
    const steps = stepsOf(FILE);
    const version = steps.findIndex((s) => s.id === "version");
    const preflight = steps.findIndex((s) => s.id === "preflight");

    expect(version).toBeGreaterThanOrEqual(0);
    expect(steps[version]?.run ?? "").toContain("::error::");
    expect(steps[version]?.run ?? "").toContain("exit 1");
    expect(preflight).toBeGreaterThan(version);
    expect(steps[preflight]?.run ?? "").toContain("npm view");
  });

  it("publishes only when the preflight says the version is new", () => {
    const publish = stepsOf(FILE).find((s) => (s.run ?? "").includes("npm publish"));

    expect(publish?.if).toBe("steps.preflight.outputs.already-published == 'false'");
    expect(publish?.["working-directory"]).toBeUndefined();
    expect(publish?.env?.["NODE_AUTH_TOKEN"]).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  /**
   * The guard that is deliberately *not* here: requiring the tagged commit to be
   * reachable from the default branch. It would have blocked the bootstrap tag,
   * which had to be pushed on a pull request's head — the whole reason the
   * trigger is a tag push. A `TODO` naming it and its reason is the difference
   * between a deferred guard and a forgotten one, so the note is held in place
   * rather than left to be tidied away by the next reader.
   */
  /**
   * The guard is now present rather than owed. It was absent for exactly one
   * release: while this package lived inside the linter repo, the first publish
   * had to be tagged on a pull request head — the single commit an ancestor
   * check would reject — so the workflow carried a `TODO` instead. The
   * migration removed the bootstrap, and the guard landed with it.
   *
   * Asserted as a real step rather than as prose, because the failure it
   * prevents is publishing from a commit that never reached the default branch,
   * which leaves no trace on the registry afterwards.
   */
  it("refuses a tag on a commit that never reached the default branch", () => {
    const text = fs.readFileSync(FILE, "utf8");

    expect(text).toContain("merge-base --is-ancestor");
    expect(text).not.toMatch(/#\s*TODO/);

    // A shallow clone has no merge-base to compute against, and `--is-ancestor`
    // on a truncated history answers confidently and wrongly.
    const checkout = stepsOf(FILE).find((s) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });
});

/**
 * Every `gh` in the shipped **runner** surface arrives as argv, never as text a
 * shell re-parses: `gh()` or `safeGh()`, both of which pass an argv array and
 * never spawn a shell. Same rule as `git` (issue
 * jeffwlawson/winget-manifest-lint#75), and the same reason: a value that
 * reaches a subprocess as syntax is a value someone else can write. The
 * workflow half ships too and reaches `gh` from bash; there the boundary is a
 * quoted env var (`gh pr edit "$PR_NUMBER"`), not argv, and this test says
 * nothing about it.
 *
 * This test is the record, and the record is the point. Three sites once
 * interpolated into a shell string, and the only thing keeping a crafted issue
 * reference out of `/bin/sh` was a `\d+` capture in review-context.ts — a
 * control three files from the interpolation it protected (#2). #9 fixed two of
 * them and deleted the comment in `shared/common.ts` that had described the
 * whole class — correctly, since the sites it named were gone, except that the
 * third one (`update-branch.ts`'s `gh pr view`) went from documented to
 * invisible in the same change (#10). A prose note only covers the sites its
 * author knew about on the day; a grep goes on reading the file after everyone
 * has stopped.
 *
 * Comment lines are excluded on purpose, so that this class can go on being
 * described in prose. It was described on `safeSh` — the helper a reader
 * reaching for a swallowing shell command arrived at, and by then the only
 * caller of it was a `gh` call. #12 deleted the helper rather than leave a
 * documented, blessed-looking invitation to write the fourth site, and this
 * comment is where its note landed — with a short one on `sh`, which is where a
 * reader reaching for a shell arrives now that the swallowing wrapper is gone.
 */
describe("every gh call reaches argv, never a shell", () => {
  // `sh(`, `safeSh(` or `execSync(` opening a string that names `gh` before it
  // closes. Deliberately not anchored to a command name after `gh`: the defect
  // is the shell, whatever is being run through it. `safeSh` names nothing that
  // exists since #12 and stays here anyway — a re-introduction under the old
  // name is the exact shape this is for, and dropping it would exempt it.
  //
  // A grep, and priced as one. Matching is per line and `[^`'"]*` stops at the
  // first quote, so at least three shapes pass: the call hand-wrapped so the
  // string starts on the next line; the command built into a variable first
  // (`const cmd = `gh …`; sh(cmd)`); and an env prefix that closes a quote on
  // the way (`sh(`GH_TOKEN="x" gh …`)`). Catching those means parsing TypeScript,
  // at which point this stops being a grep and starts being a thing to maintain.
  // What it does catch is the shape that actually regressed, on arrival rather
  // than at review — which is the whole of the claim.
  const SHELLED_GH = /\b(?:safeSh|sh|execSync)\(\s*[`'"][^`'"]*\bgh\b/;
  const sources = sandcastleFiles.filter((file) => file.endsWith(".ts"));

  // The whole scan, not just the pattern — trim, then drop comment lines, then
  // match. The controls below go through this rather than calling the regex, so
  // that the exclusion is under the same guard the pattern is: widening it to
  // `line.includes("//")` exempts every offender carrying a trailing comment,
  // and a regex-only control would stay green while it did.
  const offendersIn = (text: string): { line: string; n: number }[] =>
    text
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith("*") && !line.startsWith("//"))
      .filter(({ line }) => SHELLED_GH.test(line));

  it("finds sources to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  /**
   * "Matched nothing" is only a result if the pattern can match something, and
   * after #12 nothing in the tree exercises it any more — the three sites are
   * fixed and the helper that carried two of them is deleted. Without a control
   * the grep could be narrowed to nothing at all, by an edit as small as pruning
   * a name that no longer resolves, and every file would still report clean.
   */
  it.each([
    "return safeSh(`gh api repos/${ghRepo}/issues/${n}`);",
    "const body = sh(`gh pr view ${prNumber} --json body`);",
    'execSync("gh issue comment 1 --body-file -")',
    "    const body = sh(`gh pr view ${prNumber} --json body`); // trusted, honest",
  ])("catches %s", (offender: string) => {
    expect(offendersIn(offender)).toHaveLength(1);
  });

  // The forms that are the point of the rule, plus a literal `git` through `sh`
  // — live across the runner surface and deliberately untouched (#12), so a
  // pattern that started failing them would be reported as a defect here rather
  // than once per call site.
  it.each([
    'safeGh(["pr", "view", prNumber, "--json", "title,body"])',
    "gh([`api`, `repos/${ghRepo}/issues/${n}`])",
    'sh("git rev-parse HEAD")',
  ])("passes %s, which reaches argv", (allowed: string) => {
    expect(offendersIn(allowed)).toEqual([]);
  });

  // The exclusion is the other half, and it is deliberate: this class has to be
  // describable in prose, including in the doc comment on `sh` that now carries
  // the note. Indented, because that is how a doc comment arrives — dropping the
  // trim would report every file that explains the rule as breaking it.
  it.each([
    " * or `safeSh(`gh api …`)`, which is the shape this forbids",
    "    // was `const body = sh(`gh pr view …`)` before #9",
  ])("exempts %s, which only describes it", (prose: string) => {
    expect(offendersIn(prose)).toEqual([]);
  });

  it.each(sources)("%s: reaches gh through argv", (file: string) => {
    const offenders = offendersIn(fs.readFileSync(file, "utf8")).map(
      ({ line, n }) => `${file}:${n} ${line}`,
    );

    expect(offenders).toEqual([]);
  });
});

/**
 * `.sandcastle/` is the agent loop, and the loop is the deliverable
 * (jeffwlawson/winget-manifest-lint#88) — it ships to other repos rather than
 * living in this one. So nothing in it may name this repo's domain, and nothing
 * in it may name this repo's toolchain.
 *
 * The seam that replaces both already exists and is load-bearing: every prompt
 * reads `CONTEXT.md` and `CLAUDE.md` first, so what is specific to a repo lives
 * with the adopter rather than with the template. The prompts point at those two
 * files; the files answer.
 *
 * These are deliberately mechanical. De-domaining is a one-off edit anyone can
 * do; *staying* de-domained is a habit, and the next prompt written under
 * deadline will be written by someone who has this repo's vocabulary in their
 * head and no reason to suspect it. A grep is what catches that; a review is
 * what misses it.
 */
describe(".sandcastle names no repo of its own", () => {
  it("finds files to check", () => {
    expect(sandcastleFiles.length).toBeGreaterThan(0);
  });

  /**
   * The surface is named rather than derived, for the reason given where it is
   * defined — so a runner added later and left off the list is one both checks
   * below skip, silently and green. That is the same omission the checks exist
   * to catch, one level up, so it is a named failure here rather than a gap.
   */
  it("covers every runner directory", () => {
    expect(runnerDirs.filter((dir) => !RUNNER_SURFACE.includes(dir))).toEqual([]);
  });

  /**
   * The four terms are this repo's domain vocabulary as it actually leaked
   * (jeffwlawson/winget-manifest-lint#95): the product name, the field that is
   * the whole role-vs-`ManifestType` distinction, the directory rules are
   * registered in, and the constructor a rule is defined with.
   *
   * `microsoft` is the fifth, and the reason the match is case-insensitive
   * (#151): `review/review.ts` described CI evidence as "manifests Microsoft
   * actually accepted" — the same domain in words none of the four spelled. The
   * vendor is specific enough to ban outright; `corpus` and `manifest` are not,
   * since this package has an npm manifest of its own.
   *
   * `.ts` files are in scope too, not only prompts — `shared/common.ts` carried
   * the repo name as a Standard Schema `vendor`, which is exactly the kind of
   * site a prompt-focused pass reads straight past.
   */
  const DOMAIN = /winget|ManifestType|src\/rules|defineRule|microsoft/i;

  it.each(sandcastleFiles)("%s: names nothing specific to this project", (file: string) => {
    const offenders = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => DOMAIN.test(line))
      .map(({ line, n }) => `${file}:${n} ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  /**
   * The gate command is the other half. It cannot become a `{{…}}` argument:
   * `runWithExtraction` drops `promptArgs` before the extraction run, so
   * `update-branch/extraction.md` — whose output *is* the comment posted to the
   * PR — would receive one literal, the same trap the base-ref checks above
   * record. The placeholder is therefore the pointer the prompts already carry:
   * `CLAUDE.md` names the command and the prompt names `CLAUDE.md`, which is what
   * `docs/ADOPTING.md` §6 asks an adopter to write down anyway.
   */
  it.each(sandcastleFiles)("%s: points at the gate rather than naming it", (file: string) => {
    expect(fs.readFileSync(file, "utf8")).not.toContain("npm run verify");
  });
});

/**
 * Nothing the loop posts carries an em dash (#136). The agents write most of
 * what a review, a reply or a comment says, and they write in the style of the
 * prompt they were handed, so the prompts are held to it as well as the
 * strings the workflows post themselves.
 *
 * The prompts are found by name under the runner surface, so a prompt added
 * later is held on arrival. The workflow half reads only the lines that post:
 * a YAML comment or an input's `description:` reaches no pull request, and
 * those keep their dashes along with every other comment in this repo.
 */
describe("what the loop posts carries no em dash", () => {
  const prompts = sandcastleFiles.filter((file) => /(^|[\\/])(prompt|extraction)\.md$/.test(file));

  it("finds the prompts", () => {
    expect(prompts.length).toBeGreaterThan(0);
  });

  it.each(prompts)("%s: is written without one", (file: string) => {
    const offenders = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes("—"))
      .map(({ line, n }) => `${file}:${n} ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  /**
   * A line that posts: a message command, or an assignment to one of the
   * variables a message is built in before it is posted.
   */
  const POSTS =
    /(^|[\s|&(])(echo|printf|refuse|refuse_shape|block|fail)\s|\b(body|headline|no_ci|pr_note|reason|retry|what)=/;

  it.each(workflowFiles)("%s: posts nothing with one", (file: string) => {
    const offenders = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trimStart().startsWith("#") && POSTS.test(line) && line.includes("—"))
      .map(({ line, n }) => `${file}:${n} ${line.trim()}`);

    expect(offenders).toEqual([]);
  });
});

/**
 * A job that reaches its `timeout-minutes` is **cancelled**, not failed (#220).
 * Every failure step here was gated on `failure()` alone, so a run that timed
 * out posted nothing and added no `agent:blocked`, while the `always()`
 * cleanup still took `agent:in-progress` off: the issue looked as if nothing
 * had run. Observed on #152, whose implement run hit 30 minutes and vanished.
 *
 * So each failure step also runs on `cancelled()`, and is told which it was by
 * `job.status` and the clock. What the comment then says is executed in
 * `tests/failure-step.test.ts`; this is the wiring it depends on.
 */
describe("a run that times out or is cancelled says so, as a failure does", () => {
  /** The failure step of each workflow, and the guard it carried before #220. */
  const FAILURE_STEPS: Readonly<Record<string, { readonly name: string; readonly guard: string }>> = {
    implement: { name: "Mark blocked on failure", guard: "steps.preflight.outputs.refused != 'true'" },
    "implement-prd": { name: "Mark blocked on failure", guard: "steps.preflight.outputs.refused != 'true'" },
    fix: { name: "Mark blocked on failure", guard: "steps.state.outputs.proceed == 'true'" },
    "update-branch": { name: "Mark blocked on failure", guard: "steps.state.outputs.proceed == 'true'" },
    // In the posting job (#257), which also posts for a review job that
    // failed: that is a result of the job it needs, not a status of its own.
    review: { name: "Mark blocked on failure", guard: "needs.review.outputs.proceed == 'true'" },
    "follow-ups": { name: "Report the failure on the PR", guard: "" },
  };

  /**
   * The four agent jobs share one variable. `vars` is in the contexts
   * `jobs.<id>.timeout-minutes` may read, and in a called workflow it resolves
   * against the caller's repository; `fromJSON` because a variable is a string
   * and the key wants a number.
   */
  const AGENT_LIMIT = "${{ fromJSON(vars.AGENT_TIMEOUT_MINUTES || '30') }}";
  const AGENT_MINUTES = "${{ vars.AGENT_TIMEOUT_MINUTES || '30' }}";

  /** Each job's limit, and the same figure as its failure step reads it. */
  const LIMITS: Readonly<Record<string, { readonly job: number | string; readonly step: string }>> = {
    implement: { job: AGENT_LIMIT, step: AGENT_MINUTES },
    "implement-prd": { job: AGENT_LIMIT, step: AGENT_MINUTES },
    fix: { job: AGENT_LIMIT, step: AGENT_MINUTES },
    "update-branch": { job: AGENT_LIMIT, step: AGENT_MINUTES },
    review: { job: "${{ fromJSON(needs.time-limit.outputs.minutes) }}", step: "${{ needs.time-limit.outputs.minutes }}" },
    "follow-ups": { job: 10, step: "10" },
  };

  const fileOf = (command: string): string => path.join(WORKFLOW_DIR, `${command}.yml`);
  const failureStep = (command: string): Step => {
    const want = FAILURE_STEPS[command];
    const step = writerStepsOf(fileOf(command)).find((s) => s.name === want?.name);

    expect(step, `${command} has no \`${want?.name}\` step`).toBeDefined();
    return step as Step;
  };

  it("covers every runner workflow", () => {
    expect(Object.keys(FAILURE_STEPS).sort()).toEqual([...RUNNER_COMMANDS].sort());
  });

  it.each(RUNNER_COMMANDS)("%s: runs its failure step on a cancelled job too", (command: string) => {
    const { guard } = FAILURE_STEPS[command] ?? { guard: "" };
    const step = failureStep(command);

    // A split run reports from its publish job, which runs `always()` after a
    // gate that did not refuse: what failed or was cancelled may be either job
    // ahead of it, read by name since `failure()` does not see a cancel there.
    if (SPLIT_RUNS[fileOf(command)] !== undefined) {
      // Each names the jobs ahead of it whose failure is its to report: a
      // fix or a refresh only once the gate claimed the pull request, as
      // before the split; a refresh's agent only on the conflicts path it
      // runs on; and implement-prd's catch-up, and its agent's job only where
      // it ran, either being skipped on a run that builds nothing.
      const SPLIT_FAILURE: Readonly<Record<string, string>> = {
        implement: "always() && (failure() || cancelled() || needs.gate.result != 'success' || needs.implement.result != 'success')",
        fix: "always() && needs.gate.outputs.refused == 'false' && (failure() || cancelled() || needs.gate.result != 'success' || needs.fix.result != 'success')",
        "update-branch":
          "always() && needs.gate.outputs.refused == 'false' && (failure() || cancelled() || needs.gate.result != 'success' || (needs.gate.outputs.status == 'conflicts' && needs.update-branch.result != 'success'))",
        "implement-prd":
          "always() && (failure() || cancelled() || needs.gate.result != 'success' || needs.catch_up.result == 'failure' || needs.catch_up.result == 'cancelled' || needs.implement-prd.result == 'failure' || needs.implement-prd.result == 'cancelled')",
      };
      expect(step.if).toBe(SPLIT_FAILURE[command]);
      expect(step.env?.["AGENT_RESULT"]).toBe(`\${{ needs.${command}.result }}`);
      expect(step.env?.["GATE_RESULT"]).toBe("${{ needs.gate.result }}");
      expect(step.env?.["JOB_STATUS"]).toBe("${{ job.status }}");
      // implement-prd's catch-up between the gate's and the agent's.
      const between = command === "implement-prd" ? ' || [ "$CATCH_UP_RESULT" = "cancelled" ]' : "";
      expect(step.run ?? "").toContain(
        `if [ "$JOB_STATUS" = "cancelled" ] || [ "$GATE_RESULT" = "cancelled" ]${between} || [ "$AGENT_RESULT" = "cancelled" ]; then`,
      );
      return;
    }

    const review = command === "review" ? " || needs.review.result != 'success'" : "";
    expect(step.if).toBe(guard === "" ? "failure() || cancelled()" : `${guard} && (failure() || cancelled()${review})`);
    expect(step.env?.["JOB_STATUS"]).toBe("${{ job.status }}");
    expect(step.run ?? "").toContain('if [ "$JOB_STATUS" = "cancelled" ]; then');
  });

  /**
   * The review's clock is the review job's, so that job decides whether a
   * cancel was its limit, in an `always()` step, and hands the answer over
   * with the reasons its steps wrote (#257).
   */
  it("review: measures its own limit and hands the outcome over, however it ended", () => {
    const outcome = stepsOf(fileOf("review")).find((s) => s.id === "outcome");
    const names = stepsOf(fileOf("review")).map((s) => s.name);

    expect(outcome?.if).toBe("always()");
    expect(names.indexOf(outcome?.name)).toBe(names.length - 1);
    expect(outcome?.env?.["JOB_STATUS"]).toBe("${{ job.status }}");
    expect(outcome?.env?.["TIMEOUT_MINUTES"]).toBe("${{ needs.time-limit.outputs.minutes }}");
    expect(outcome?.run ?? "").toContain('[ "$JOB_STATUS" = "cancelled" ] && [ -n "${JOB_STARTED:-}" ]');
    expect(outcome?.run ?? "").toContain("TIMEOUT_MINUTES * 60 - 60");
    for (const output of ["timed-out", "failure-reason", "refusal-reason"]) {
      expect(jobOf(fileOf("review")).outputs?.[output]).toBe(`\${{ steps.outcome.outputs.${output} }}`);
    }
    const failed = failureStep("review");
    expect(failed.env?.["TIMED_OUT"]).toBe("${{ needs.review.outputs.timed-out }}");
    expect(failed.env?.["REVIEW_REASON"]).toBe("${{ needs.review.outputs.failure-reason }}");
    expect(failed.env?.["REVIEW_REFUSAL"]).toBe("${{ needs.review.outputs.refusal-reason }}");
  });

  it.each(RUNNER_COMMANDS)("%s: starts the clock before anything else", (command: string) => {
    const split = SPLIT_RUNS[fileOf(command)];
    if (split !== undefined) {
      const gate = jobNamed(fileOf(command), split[0] as string);
      const clock = (gate.steps ?? []).at(-1);

      expect(clock?.id).toBe("clock");
      expect(clock?.run).toBe(SPLIT_CLOCK);
      expect(gate.outputs?.["started"]).toBe("${{ steps.clock.outputs.started }}");
      expect(failureStep(command).env?.["JOB_STARTED"]).toBe(`\${{ needs.${split[0]}.outputs.started }}`);
      return;
    }
    const [first] = stepsOf(fileOf(command));

    expect(first?.if).toBeUndefined();
    expect(first?.run).toBe(CLOCK);
  });

  it.each(RUNNER_COMMANDS)("%s: names the limit it runs under, as the job states it", (command: string) => {
    expect(jobOf(fileOf(command))["timeout-minutes"]).toBe(LIMITS[command]?.job);
    expect(failureStep(command).env?.["TIMEOUT_MINUTES"]).toBe(LIMITS[command]?.step);
  });

  /**
   * A time limit is not a reason to stop a run: nothing in the loop cancels a
   * job but its limit and a person, and a queued label waits its turn.
   */
  it.each(RUNNER_COMMANDS)("%s: cancels no run in progress", (command: string) => {
    for (const job of jobsOf(fileOf(command))) expect(job.concurrency?.["cancel-in-progress"] ?? false).toBe(false);
  });

  /**
   * **The review's limit is its CI wait plus its own time**, so a slow CI no
   * longer eats the review. An expression cannot add, so a job ahead of it
   * does the sum and the review reads it through `needs`, which
   * `timeout-minutes` may also read.
   */
  describe("the review's limit", () => {
    const limits = (): Job => jobNamed(REVIEW, "time-limit");
    const sum = (): Step => {
      const step = limits().steps?.find((s) => s.id === "limits");

      expect(step).toBeDefined();
      return step as Step;
    };

    it("is summed by a job that runs where the review does, and holds nothing", () => {
      expect(jobOf(REVIEW).needs).toEqual(["time-limit", "red-check"]);
      // The review's two guards, which its own `if:` now follows with the
      // checks on its needs (#231).
      expect(limits().if).toBe(
        "github.event.label.name == 'agent:review' && github.event.pull_request.head.repo.full_name == github.repository",
      );
      expect(jobOf(REVIEW).if ?? "").toContain(limits().if ?? "");
      expect(limits().permissions).toEqual({});
      expect(limits().outputs?.["minutes"]).toBe("${{ steps.limits.outputs.minutes }}");
    });

    it("adds the CI wait the review actually waits", () => {
      const wait = Number(sum().env?.["CI_WAIT_MINUTES"]);

      expect(wait * 60).toBe(Number(waitStep().env?.["WAIT_SECONDS"]));
      expect(sum().run ?? "").toContain('minutes=$((CI_WAIT_MINUTES + own))');
    });

    it("is 20 minutes, today's, where the variable is unset", () => {
      expect(sum().env?.["REVIEW_MINUTES"]).toBe("${{ vars.AGENT_REVIEW_TIMEOUT_MINUTES }}");
      expect(sum().run ?? "").toContain('own="${REVIEW_MINUTES:-5}"');
      expect(Number(sum().env?.["CI_WAIT_MINUTES"]) + 5).toBe(20);
    });

    /**
     * A value that is not a positive integer is refused by the review, naming
     * it, the way the fix-round budget is: summed, it would be a limit nobody
     * wrote down, and failed in `limits` it would skip the review silently.
     */
    it("refuses a variable that is not a positive integer in the review, where it is said", () => {
      const refusal = stepsOf(REVIEW).find((s) => (s.if ?? "").includes("needs.time-limit.outputs.refused == 'true'"));

      expect(sum().run ?? "").toContain("^[1-9][0-9]*$");
      expect(refusal?.if).toBe("steps.state.outputs.proceed == 'true' && needs.time-limit.outputs.refused == 'true'");
      // Into the refusal file, so the comment says it didn't run (#253).
      expect(refusal?.run ?? "").toContain("refusal_reason.txt");
      expect(refusal?.run ?? "").toContain("AGENT_REVIEW_TIMEOUT_MINUTES");
    });
  });
});

/**
 * A run links itself on the issue it was triggered from as soon as it starts
 * (#205). Before, the only comment carrying the run link was the failure
 * comment, so a run in progress, or one that succeeded, was found by opening
 * Actions and matching timestamps; harder still on a PRD, whose chain starts
 * one run per slice on the same parent.
 *
 * The comment is posted in the step that takes the issue, before the checkout
 * and so before any agent work, and it is a warning where it fails: it is a
 * courtesy, and must never stop a run that has not done anything yet.
 */
describe("an implement run links itself on the issue when it starts", () => {
  const RUN_URL = "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}";
  const START = 'gh issue edit "$ISSUE_NUMBER" --remove-label "agent:blocked" || true';

  const transition = (file: string): Step => {
    const step = stepsOf(file).find((s) => s.name === "Transition labels");

    expect(step, `${file} has no \`Transition labels\` step`).toBeDefined();
    return step as Step;
  };
  /** The lines of a step's script that post a comment on the triggering issue. */
  const commentLines = (run: string): readonly string[] =>
    run.split("\n").filter((l) => l.includes('gh issue comment "$ISSUE_NUMBER"'));
  /** Every line of a step's script that posts a comment, on any issue. */
  const anyCommentLines = (run: string): readonly string[] =>
    run.split("\n").filter((l) => l.includes("gh issue comment "));

  it.each([IMPLEMENT, PRD])("%s: defines the run link once, for the job", (file: string) => {
    // A split run defines it on each job that posts — the gate and the
    // publish job — and not on the agent's, which posts nothing.
    if (SPLIT_RUNS[file] !== undefined) {
      const roles = rolesOf(file);
      const [gate, agent, publish] = [roles.gate, roles.agent, roles.publish].map((id) => jobNamed(file, id));
      expect(gate?.env?.["RUN_URL"]).toBe(RUN_URL);
      expect(publish?.env?.["RUN_URL"]).toBe(RUN_URL);
      expect(agent?.env?.["RUN_URL"]).toBeUndefined();
    } else {
      expect(jobOf(file).env?.["RUN_URL"]).toBe(RUN_URL);
    }
    for (const step of stepsOf(file)) expect(step.env?.["RUN_URL"], step.name).toBeUndefined();
  });

  it.each([IMPLEMENT])("%s: comments the run link where it takes the issue, before the checkout", (file: string) => {
    const steps = stepsOf(file);
    const step = transition(file);
    const run = step.run ?? "";
    const [comment, ...rest] = commentLines(run);

    expect(step.if).toBe("steps.preflight.outputs.refused == 'false'");
    expect(rest).toEqual([]);
    expect(comment).toContain("${RUN_URL}");
    expect(run.indexOf(comment ?? "")).toBeGreaterThan(run.indexOf(START));
    expect(steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"))).toBeGreaterThan(
      steps.indexOf(step),
    );
  });

  /**
   * A warning, never a failure: `|| echo "::warning::…"` on each comment line
   * itself, so the step's `bash -e` cannot end on it, and on a single issue
   * nothing after the first in the step that could fail in its place. On a
   * PRD that is the note on the parent, the comment on the sub-issue the run
   * starts (#246), and the chapter marker on the PRD PR (#298), which only a
   * build run posts.
   */
  it.each([IMPLEMENT, PRD])("%s: a start comment that cannot be posted is a warning, not a failure", (file: string) => {
    const step = transition(file);
    const run = step.run ?? "";
    const comments = [...anyCommentLines(run), ...run.split("\n").filter((l) => l.includes("gh pr comment "))];

    expect(comments.length).toBeGreaterThan(0);
    for (const line of comments) expect(line).toMatch(/\|\| echo "::warning::[^"]+"$/);
    expect(step["continue-on-error"]).toBeUndefined();
  });

  it.each([IMPLEMENT])("%s: does nothing after the start comment that could fail in its place", (file: string) => {
    const step = transition(file);
    const run = step.run ?? "";
    const comments = anyCommentLines(run);
    const [comment] = commentLines(run);

    expect(comments.length).toBeGreaterThan(0);
    for (const line of comments) expect(line).toMatch(/\|\| echo "::warning::[^"]+"$/);
    expect(step["continue-on-error"]).toBeUndefined();
    const after = run
      .slice(run.indexOf(comment ?? "") + (comment ?? "").length)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !comments.some((c) => c.trim() === line));

    expect(after.every((line) => line === 'if [ "$BUILD" = "true" ]; then' || line === "fi"), after.join("\n")).toBe(true);
  });

  /**
   * On a PRD the run's link lives on the sub-issue it builds (#298), so a
   * running build is found from the work it is for, and is posted before the
   * checkout, as on a single issue.
   */
  it("implement-prd.yml: comments the run link on the sub-issue a build run starts, before the checkout", () => {
    const steps = stepsOf(PRD);
    const step = transition(PRD);
    const run = step.run ?? "";
    const sub = anyCommentLines(run).filter((l) => l.includes('gh issue comment "$SUB"'));

    expect(step.if).toBe("steps.preflight.outputs.refused == 'false'");
    expect(sub).toHaveLength(1);
    expect(sub[0]).toContain("· [Workflow run](${RUN_URL})");
    expect(run.indexOf(sub[0] ?? "")).toBeGreaterThan(run.indexOf('[ "$BUILD" = "true" ] || exit 0'));
    expect(run.indexOf('[ "$BUILD" = "true" ] || exit 0')).toBeGreaterThan(run.indexOf(START));
    expect(steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"))).toBeGreaterThan(steps.indexOf(step));
    expect(step.env?.["SUB_K"]).toBe("${{ steps.preflight.outputs.sub_k }}");
  });

  /**
   * The parent gets one comment from the whole chain, on its first run, with
   * no link: the sub-issue holds that. And the PRD PR a chapter marker per
   * slice, with no link either. Neither repeats a title beside its `#N`.
   */
  it("implement-prd.yml: links the run nowhere but the sub-issue, and names no title", () => {
    const step = transition(PRD);
    const run = step.run ?? "";
    const parent = commentLines(run);
    const marker = run.split("\n").filter((l) => l.includes('gh pr comment "$PRD_PR"'));

    expect(parent).toHaveLength(1);
    expect(parent[0]).toContain('--body "$body"');
    expect(run).toContain("**`agent:implement` started:** building #%s first.");
    expect(run).toContain('if [ "$LANDED" = "0" ]; then');
    expect(marker).toHaveLength(1);
    expect(marker[0]).toContain('--body "**Slice ${SUB_K} of ${SUBS} · #${SUB} started**"');
    expect(step.env?.["SUB_TITLE"]).toBeUndefined();
    expect(run).not.toContain("SUB_TITLE");
    expect(run).not.toContain("slice PR");
  });

  /**
   * `implement.yml`'s success outcome is the PR it opens, so that is the
   * comment that carries the link on success, and it is a warning where it
   * fails for the same reason: the PR is open by then, and the review it asks
   * for must still be requested.
   */
  it("implement.yml: says which PR it opened, with the run link, and cannot fail the job on it", () => {
    const steps = stepsOf(IMPLEMENT);
    const opened = steps.findIndex((s) => s.id === "open_pr");
    const step = steps.find((s, i) => i > opened && commentLines(s.run ?? "").length > 0);
    const [comment] = commentLines(step?.run ?? "");

    expect(step?.if).toBe("needs.implement.result == 'success' && success()");
    expect(step?.env?.["NEW_PR"]).toBe("${{ steps.open_pr.outputs.number }}");
    expect(steps.indexOf(step as Step)).toBeLessThan(steps.findIndex((s) => s.name === "Request review"));
    expect(step?.run ?? "").toContain("opened PR #${NEW_PR}");
    expect(comment).toContain("${RUN_URL}");
    expect(comment).toMatch(/\|\| echo "::warning::[^"]+"$/);
  });
});

/**
 * **A trigger label is on while its run works** (#236), and comes off when the
 * run ends, however it ends. That retired `agent:in-progress`, which every run
 * wrote and three places read: a review → fix → re-review cycle wrote about
 * thirteen label events, and with the PAT acting as the maintainer several of
 * them read as the maintainer's.
 */
describe("a trigger label is on while its run works, and off when it ends", () => {
  const TRIGGERED: readonly (readonly [string, string, string])[] = [
    ["implement.yml", "agent:implement", "always() && needs.gate.outputs.refused == 'false'"],
    ["implement-prd.yml", "agent:implement", "always() && needs.gate.outputs.refused == 'false'"],
    ["review.yml", "agent:review", "always()"],
    ["fix.yml", "agent:fix", "always()"],
    ["update-branch.yml", "agent:update-branch", "always()"],
  ];
  const TRIGGER_LABELS = ["agent:implement", "agent:review", "agent:fix", "agent:update-branch"];
  /** The steps that add the next step's label after the run's own comes off (#257). */
  const HANDOFFS: Readonly<Record<string, readonly string[]>> = {
    "review.yml": ["Start the automatic fix round"],
  };
  const fileOf = (name: string): string => path.join(WORKFLOW_DIR, name);
  const removal = (label: string): RegExp =>
    new RegExp(`gh (?:pr|issue) edit "\\$[A-Z_a-z]+" --remove-label "${label}"`);

  it("covers every workflow a trigger label starts", () => {
    const started = runnerWorkflows
      .filter((file) => !MERGE_GATED.includes(file))
      .map((file) => path.basename(file))
      .sort();

    expect(TRIGGERED.map(([file]) => file).sort()).toEqual(started);
  });

  /**
   * The last step, so every failure arm above it has run: `agent:blocked` and
   * the comment go on first, and the label comes off whatever happened. Gated
   * on `always()`; the implement pair also on a preflight that decided the
   * issue was this run's, since a deferral, or a preflight that died before it
   * could defer, may be the sibling's event, and the sibling's run holds the
   * label.
   */
  it.each(TRIGGERED)("%s: takes %s off in its last step, however the run ends", (name, label, guard) => {
    // The review's hand-offs follow it (#257): the next step's label goes on
    // after this run's comes off, in the job that posts.
    const last = writerStepsOf(fileOf(name))
      .filter((s) => !(HANDOFFS[name] ?? []).includes(s.name ?? ""))
      .at(-1);

    expect(last?.name).toBe("Always remove the trigger label");
    expect(last?.if).toBe(guard);
    expect((last?.run ?? "").trim().split("\n")[0]).toMatch(removal(label));
    expect(last?.run ?? "").toMatch(new RegExp(`${removal(label).source} \\|\\| true`));
  });

  it.each(TRIGGERED)("%s: leaves %s on as the run starts", (name, label) => {
    const transition = writerStepsOf(fileOf(name)).find((s) => s.name === "Transition labels");

    expect(transition).toBeDefined();
    // The review's job that runs the model writes nothing, so it has no probe,
    // and its posting job clears the block once the review has finished (#257).
    if (name === "review.yml") {
      expect(transition?.run ?? "").not.toMatch(removal(label));
      expect(transition?.run ?? "").not.toContain("--add-label");
      expect(transition?.run ?? "").toMatch(removal("agent:blocked"));
      return;
    }
    // The probe: the label the run holds, added again, bare, before anything.
    expect((transition?.run ?? "").trim().split("\n")[0]).toMatch(
      new RegExp(`^gh (?:pr|issue) edit "\\$[A-Z_]+" --add-label "${label}"$`),
    );
    expect(transition?.run ?? "").not.toMatch(removal(label));
    expect(transition?.run ?? "").toMatch(removal("agent:blocked"));
  });

  /**
   * Adding a label that is already there fires nothing (`docs/ADOPTING.md`
   * §1), and removing one that is not leaves nothing on the timeline. So a
   * stale label can never swallow a request the loop makes: each add is
   * preceded, in the same script and on the same issue or pull request, by a
   * removal of the same label.
   *
   * Except the permission probe opening `Transition labels`, which requests
   * nothing: it adds the label the run already holds, so that a short token
   * fails there, before the checkout, and a removal before it would fire the
   * run all over again.
   */
  it.each(workflowFiles)("%s: adds every trigger label by removing it first", (file: string) => {
    for (const job of jobsOf(file)) {
      for (const step of job.steps ?? []) {
        const lines = (step.run ?? "").split("\n");
        lines.forEach((line, i) => {
          if (step.name === "Transition labels" && i === 0) return;
          const add = line.match(/gh (pr|issue) edit ("\$[A-Za-z_]+") --add-label "(agent:[a-z-]+)"/);
          if (add === null || !TRIGGER_LABELS.includes(add[3] ?? "")) return;
          const remove = `gh ${add[1]} edit ${add[2]} --remove-label "${add[3]}"`;
          expect(
            lines.slice(0, i).some((before) => before.includes(remove)),
            `${file}: ${step.name}: ${line.trim()}`,
          ).toBe(true);
        });
      }
    }
  });

  /**
   * **A request made while a run works is not lost.** Adding the trigger label
   * then fires nothing, since it is on. So a review or a refresh that finished
   * to find the head moved on from what it left asks for itself again, with
   * the PAT, since a label added with `GITHUB_TOKEN` starts nothing. Only on
   * success: a failure is `agent:blocked` and a human's retry.
   */
  it.each([
    [
      "review.yml",
      "agent:review",
      "${{ needs.review.outputs.sha }}",
      "${{ needs.review.outputs.proceed }}",
      'if [ "$PROCEEDED" != "true" ] || [ "$REVIEW_RESULT" != "success" ] || [ "$JOB_STATUS" != "success" ] || [ -z "$LEFT_SHA" ]; then',
    ],
    [
      "update-branch.yml",
      "agent:update-branch",
      "${{ steps.push.outputs.head || github.event.pull_request.head.sha }}",
      "${{ needs.gate.outputs.refused == 'false' }}",
      // Across the split: the gate's result, and the agent's, which is
      // skipped on a clean merge or an up-to-date branch and fails nothing.
      'if [ "$PROCEEDED" != "true" ] || [ "$JOB_STATUS" != "success" ] || [ "$GATE_RESULT" != "success" ] \\\n  || [ "$AGENT_RESULT" = "failure" ] || [ "$AGENT_RESULT" = "cancelled" ] || [ -z "$LEFT_SHA" ]; then',
    ],
  ])("%s: asks for %s again where the head moved while it worked", (name, label, left, proceeded, gated) => {
    const last = writerStepsOf(fileOf(name)).find((s) => s.name === "Always remove the trigger label");
    const run = last?.run ?? "";
    const add = run.indexOf(`GH_TOKEN="$REQUEST_TOKEN" gh pr edit "$PR_NUMBER" --add-label "${label}"`);

    expect(last?.env?.["LEFT_SHA"]).toBe(left);
    expect(last?.env?.["JOB_STATUS"]).toBe("${{ job.status }}");
    expect(last?.env?.["PROCEEDED"]).toBe(proceeded);
    expect(last?.env?.["REQUEST_TOKEN"]).toBe("${{ steps.token.outputs.token }}");
    expect(add).toBeGreaterThan(0);
    const gate = run.indexOf(gated);
    const moved = run.indexOf('if [ "$state" != "OPEN" ] || [ "$head" = "$LEFT_SHA" ]; then');
    // Another trigger label is a run queued behind this one, and a request
    // would cancel it and strand its label.
    const busy = run.indexOf('if [ -n "$busy" ]; then');
    const noPat = run.indexOf('if [ "$TOKEN_SOURCE" != "app" ] && [ "$TOKEN_SOURCE" != "pat" ]; then');
    expect(gate).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(gate);
    expect(run).toContain('select(. == "agent:review" or . == "agent:fix" or . == "agent:update-branch")');
    expect(busy).toBeGreaterThan(moved);
    expect(noPat).toBeGreaterThan(busy);
    expect(add).toBeGreaterThan(noPat);
    // Without the PAT the add would start nothing, so it is said instead.
    const arm = run.slice(noPat, run.indexOf("\n          fi", noPat));
    expect(arm).toContain("::warning::");
    expect(arm).toContain('gh pr comment "$PR_NUMBER"');
    expect(arm).toContain("exit 0");
  });

  /**
   * Not `fix`: a second fix run would answer the threads this one answered,
   * which stay open until a review verifies them (#111).
   */
  it("fix.yml: does not ask for itself again", () => {
    // The probe opening `Transition labels` adds the label the run holds,
    // which requests nothing; asserted above.
    for (const job of jobsOf(fileOf("fix.yml"))) {
      for (const step of job.steps ?? []) {
        if (step.name === "Transition labels") continue;
        expect(step.run ?? "").not.toContain('--add-label "agent:fix"');
      }
    }
  });

  /**
   * **The loop's one order** (#236): label on, do the work, post every
   * result, take your own label off, add the next step's label. A refusal is
   * a run that ends at once, so its comment goes first, then its own label
   * off, then `agent:blocked` where it applies.
   */
  it.each([
    ["implement.yml", "preflight", 'gh issue comment "$ISSUE_NUMBER"', 'gh issue edit "$ISSUE_NUMBER" --remove-label "agent:implement"', 'gh issue edit "$ISSUE_NUMBER" --add-label "agent:blocked"'],
    ["implement-prd.yml", "preflight", 'gh issue comment "$ISSUE_NUMBER"', 'gh issue edit "$ISSUE_NUMBER" --remove-label "agent:implement"', 'gh issue edit "$ISSUE_NUMBER" --add-label "agent:blocked"'],
    ["fix.yml", "state", 'gh pr comment "$PR_NUMBER"', 'gh pr edit "$PR_NUMBER" --remove-label "agent:fix"', 'gh pr edit "$PR_NUMBER" --add-label "agent:blocked"'],
  ])("%s: a refusal comments, then takes its label off, then blocks", (name, id, comment, removal, blocked) => {
    const body = bashFunctionBody(runOf(fileOf(name), id), "refuse");

    expect(body.indexOf(comment)).toBeGreaterThanOrEqual(0);
    expect(body.indexOf(removal)).toBeGreaterThan(body.indexOf(comment));
    expect(body.indexOf(blocked)).toBeGreaterThan(body.indexOf(removal));
    // Tolerated, since it now comes first: under `-e` a failed comment would
    // end the step before the removal, and the implement pair's last step
    // leaves a refused run's label alone, so it would stay on with no run.
    const line = body.split("\n").find((l) => l.includes(comment)) ?? "";
    expect(line).toMatch(/\|\| echo "::warning::[^"]+"$/);
  });

  /**
   * The review's pre-flight decides a refusal and cannot say it (#257): the
   * job that runs the model writes nothing. It hands the sentence and the
   * block over, and the posting job says it in the same order.
   */
  it("review.yml: a refusal comments, then takes its label off, then blocks", () => {
    const refuse = bashFunctionBody(runOf(REVIEW, "state"), "refuse");
    const say = writerStepsOf(REVIEW).find((s) => s.name === "Say why the review didn't run");
    const run = say?.run ?? "";
    const comment = run.indexOf('gh pr comment "$PR_NUMBER"');
    const removal = run.indexOf('gh pr edit "$PR_NUMBER" --remove-label "agent:review"');
    const blocked = run.indexOf('gh pr edit "$PR_NUMBER" --add-label "agent:blocked"');

    expect(refuse).toContain('echo "proceed=false"');
    expect(refuse).toContain('echo "refusal=$1"');
    expect(refuse).not.toMatch(/gh pr/);
    expect(jobOf(REVIEW).outputs?.["refusal"]).toBe("${{ steps.state.outputs.refusal }}");
    expect(jobOf(REVIEW).outputs?.["blocked"]).toBe("${{ steps.state.outputs.blocked }}");
    expect(say?.if).toBe("needs.review.outputs.proceed == 'false'");
    expect(say?.env?.["REFUSAL"]).toBe("${{ needs.review.outputs.refusal }}");
    expect(comment).toBeGreaterThanOrEqual(0);
    expect(removal).toBeGreaterThan(comment);
    expect(blocked).toBeGreaterThan(removal);
    expect(run.split("\n").find((l) => l.includes('gh pr comment "$PR_NUMBER"')) ?? "").toMatch(
      /\|\| echo "::warning::[^"]+"$/,
    );
  });

  it("update-branch.yml: a refusal comments, then takes its label off", () => {
    const run = runOf(fileOf("update-branch.yml"), "state");
    const comment = run.indexOf('gh pr comment "$PR_NUMBER"');
    const removal = run.indexOf('--remove-label "agent:update-branch"');

    expect(comment).toBeGreaterThanOrEqual(0);
    expect(removal).toBeGreaterThan(comment);
    expect(run.slice(comment, removal)).toContain('|| echo "::warning::');
  });

  /**
   * And a hand-off takes the run's own label off before it adds the next
   * step's, in the same step and only on its success path, so the issue or
   * pull request never carries both.
   */
  it.each([
    ["implement.yml", "Request review", 'gh issue edit "$ISSUE_NUMBER" --remove-label "agent:implement"', 'gh pr edit "$NEW_PR" --add-label "agent:review"'],
    ["implement-prd.yml", "Request review", 'gh issue edit "$ISSUE_NUMBER" --remove-label "agent:implement"', 'gh pr edit "$PRD_PR" --add-label "agent:review"'],
    ["implement-prd.yml", "handover", 'gh issue edit "$ISSUE_NUMBER" --remove-label "agent:implement"', 'gh pr edit "$PRD_PR" --add-label "agent:review"'],
    ["fix.yml", "Request re-review", 'gh pr edit "$PR_NUMBER" --remove-label "agent:fix"', 'gh pr edit "$PR_NUMBER" --add-label "agent:review"'],
    ["update-branch.yml", "Request a review of the resolution", 'gh pr edit "$PR_NUMBER" --remove-label "agent:update-branch"', 'gh pr edit "$PR_NUMBER" --add-label "agent:review"'],
  ])("%s: %s takes its own label off before it adds the next", (name, step, removal, add) => {
    const found = stepsOf(fileOf(name)).find((s) => s.name === step || s.id === step);
    const run = found?.run ?? "";

    expect(found?.if ?? "").toContain("success()");
    expect(run.indexOf(removal)).toBeGreaterThanOrEqual(0);
    expect(run.indexOf(add)).toBeGreaterThan(run.indexOf(removal));
  });

  /**
   * A review whose pull request moved while it worked says so, and what acts
   * on its verdict stands down: the verdict is about a commit the pull request
   * has left (#236). The fix round comes after the trigger label is off and the
   * moved check made (#257), in the posting job; the PRD chain's advance job
   * follows that job and reads the same answer.
   */
  it("review.yml: the fix round and the advance stand down where the head moved", () => {
    const steps = writerStepsOf(REVIEW);
    const names = steps.map((s) => s.name ?? "");
    const trigger = steps.find((s) => s.name === "Always remove the trigger label");

    expect(trigger?.id).toBe("trigger");
    expect(trigger?.run ?? "").toContain('echo "moved=true" >> "$GITHUB_OUTPUT"');
    for (const name of HANDOFFS["review.yml"] ?? []) {
      const step = steps.find((s) => s.name === name);
      expect(step?.if ?? "", name).toContain("steps.trigger.outputs.moved != 'true'");
      expect(names.indexOf(name), name).toBeGreaterThan(names.indexOf("Always remove the trigger label"));
    }
    expect(jobNamed(REVIEW, "advance").if ?? "").toContain("needs.post-review.outputs.moved != 'true'");
  });

  /**
   * The PRD chain's busy check reads the trigger labels alone, now that those
   * are on while their run works: the gate's, on the PRD PR.
   */
  it("reads the trigger labels where it asks whether a round is busy", () => {
    const merge = stepsOf(PRD).find((s) => s.id === "preflight")?.run ?? "";

    expect(merge).toContain('select(. == "agent:review" or . == "agent:fix" or . == "agent:update-branch")');
  });
});

/**
 * One plain pattern for every failure and refusal (#253). Before, a message
 * opened three ways ("`agent:X` run failed.", "Refused to run `agent:fix`:",
 * "Refused to run:"), and `agent:blocked` went on in some workflows and not in
 * others for the same situation. Now there are two:
 *
 * - **Stopped**, the run started and then failed:
 *   `**`agent:X` stopped:** <Reason>.` then `[Workflow run](<url>) · <what to do>`.
 * - **Didn't run**, refused before doing anything:
 *   `**`agent:X` didn't run:** <Reason>. <What to do>.`
 *
 * and `agent:blocked` goes on only where the maintainer has to act. The
 * failure steps are executed in `tests/failure-step.test.ts`; what is pinned
 * here is that each workflow writes the pattern, and every refusal fills it
 * with a sentence.
 */
describe("every failure and refusal says so in one of two patterns", () => {
  const FIX = path.join(WORKFLOW_DIR, "fix.yml");
  const UPDATE = path.join(WORKFLOW_DIR, "update-branch.yml");
  const STOPPED = [
    { file: IMPLEMENT, label: "agent:implement", step: "Mark blocked on failure" },
    { file: PRD, label: "agent:implement", step: "Mark blocked on failure" },
    { file: FIX, label: "agent:fix", step: "Mark blocked on failure" },
    { file: REVIEW, label: "agent:review", step: "Mark blocked on failure" },
    { file: UPDATE, label: "agent:update-branch", step: "Mark blocked on failure" },
    { file: FOLLOW_UPS, label: "agent:follow-ups", step: "Report the failure on the PR" },
  ] as const;
  const REFUSING = [
    { file: IMPLEMENT, label: "agent:implement", guard: "preflight" },
    { file: PRD, label: "agent:implement", guard: "preflight" },
    { file: FIX, label: "agent:fix", guard: "state" },
    { file: REVIEW, label: "agent:review", guard: "state" },
  ] as const;

  it.each(STOPPED)("$file: a run that stopped says `$label stopped:`, the reason, the run and what to do", (c) => {
    const run = writerStepsOf(c.file).find((s) => s.name === c.step)?.run ?? "";

    expect(run).toMatch(
      new RegExp(
        `printf '\\*\\*\`${c.label}\` stopped:\\*\\* %s\\\\n\\\\n\\[Workflow run\\]\\(%s\\) · %s\\\\n' "\\$reason" "\\$RUN_URL" `,
      ),
    );
    // The reason is made a sentence whoever wrote it.
    expect(run).toContain('reason="${reason^}"');
    expect(run).toContain('case "$reason" in *[.!?]) ;; *) reason="${reason}." ;; esac');
    // And none of the old openings survives.
    expect(run).not.toMatch(/run %s\.|\*\*Reason:\*\*|\*\*Workflow run:\*\*|Re-apply/);
  });

  it.each(REFUSING)("$file: every refusal says `$label didn't run:` and then a sentence", (c) => {
    const run = runOf(c.file, c.guard);
    const calls = run
      .split("\n")
      .map((line) => line.trim())
      // Less `refuse_shape`'s own forwarding of its argument.
      .filter((line) => /^(refuse|refuse_shape) "/.test(line) && !line.startsWith('refuse "$1"'));

    // The review's posting job says it, from the sentence handed over (#257).
    if (c.file === REVIEW) {
      expect(writerStepsOf(REVIEW).find((s) => s.name === "Say why the review didn't run")?.run ?? "").toContain(
        `--body "**\\\`${c.label}\\\` didn't run:** \${REFUSAL}"`,
      );
    } else {
      expect(bashFunctionBody(run, "refuse")).toContain(`--body "**\\\`${c.label}\\\` didn't run:** $1"`);
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // A capital, or the one shared sentence review keeps in a variable.
      expect(call, call).toMatch(/^(refuse|refuse_shape) "([A-Z]|\$\{?changed\b)/);
      expect(call, call).not.toMatch(/Refused|re-add/i);
    }
    expect(run).not.toContain("Refused to run");
  });

  it("update-branch: refuses a closed PR in the same pattern, with no block", () => {
    const run = runOf(UPDATE, "state");

    expect(run).toContain('gh pr comment "$PR_NUMBER" --body "**\\`agent:update-branch\\` didn\'t run:** This PR is closed."');
    expect(run).not.toContain("agent:blocked");
  });

  /**
   * `agent:blocked` only where the maintainer has to act. A closed issue or
   * PR, a finished PRD, a deleted branch and a fix with nothing to do get a
   * note and no label: there is nothing for anyone to unblock.
   */
  it("blocks nothing that is closed, finished or has nothing to do", () => {
    const implement = runOf(IMPLEMENT, "preflight");
    const prd = runOf(PRD, "preflight");
    const fix = runOf(FIX, "state");
    const review = runOf(REVIEW, "state");

    for (const run of [implement, prd]) {
      expect(armOf(run, '"$ISSUE_STATE" != "open"')).toContain(
        'refuse "This issue is closed. Reopen it, then add \\`agent:implement\\` again."',
      );
      expect(armOf(run, '"$ISSUE_STATE" != "open"')).not.toContain("refuse_shape");
    }
    expect(armOf(implement, '-n "$existing"')).not.toContain("refuse_shape");
    expect(fix).toContain('refuse "This PR is closed."\n');
    expect(review).toContain('refuse "This PR is closed."\n');
    // Review's refusal adds the block only where it is asked to, as fix's does.
    expect(bashFunctionBody(review, "refuse")).toContain('if [ "${2:-}" = "blocked" ]; then');
    // And the PR-changed refusals, which do need a human, are blocked.
    for (const line of review.split("\n").filter((l) => l.includes('refuse "$changed') || l.includes('refuse "${changed}'))) {
      expect(line.trim()).toMatch(/ blocked$/);
    }
  });

  /**
   * A fix with nothing to act on used to fail through the runner and add
   * `agent:blocked`. Now the runner exits 0 with a file saying so, and the
   * workflow posts a note and goes on to end green.
   */
  it("fix: a run with nothing to act on posts a note, blocks nothing and ends green", () => {
    const steps = stepsOf(FIX);
    const index = steps.findIndex((s) => s.name === "Say there was nothing to do");
    const step = steps[index];
    const run = step?.run ?? "";

    expect(step?.if).toBe("needs.fix.result == 'success' && success()");
    expect(index).toBeGreaterThan(steps.findIndex((s) => s.name === "Run fix agent"));
    expect(index).toBeLessThan(steps.findIndex((s) => s.name === "Push branch"));
    expect(run).toContain('[ -f "${RUNNER_TEMP}/nothing_to_do.txt" ] || exit 0');
    expect(run).toContain(
      '--body "**\\`agent:fix\\` had nothing to do:** There are no open review findings or comments for it to act on."',
    );
    expect(run).not.toContain("agent:blocked");
    expect(run).not.toContain("exit 1");
    expect(run).toMatch(/\|\| echo "::warning::[^"]+"$/m);
  });

  /**
   * But nothing to do is not a round that ended: nothing was read, so nothing
   * was decided. Its output skips the push, which leaves `pushed` unset, so the
   * pull request is not handed back as ready, and on a PRD PR no review is
   * asked for, since that arm is gated on `pushed == 'false'`.
   */
  it("fix: a run with nothing to act on pushes nothing, hands nothing back and asks for nothing", () => {
    const steps = stepsOf(FIX);
    const step = (name: string): Step | undefined => steps.find((s) => s.name === name);
    const skip = "steps.nothing.outputs.nothing != 'true'";

    expect(step("Say there was nothing to do")?.id).toBe("nothing");
    expect(step("Say there was nothing to do")?.run ?? "").toContain('echo "nothing=true" >> "$GITHUB_OUTPUT"');
    expect(step("Push branch")?.if ?? "").toContain(skip);
    expect(step("Mark PR ready for review")?.if ?? "").toContain(skip);
    // The PRD PR's re-review reads only `pushed`, which a skipped push never writes.
    expect(step("Request re-review")?.if ?? "").toContain("steps.push.outputs.pushed == 'false'");
    expect(step("Request re-review")?.if ?? "").not.toContain("pushed != ");
  });

  /**
   * A reason a PRD run's `block` writes is posted inside the stopped pattern,
   * whose footer already says how to try again. So none of them opens the old
   * way or gives the retry a second time.
   */
  it("implement-prd: no reason it blocks with opens the old way or repeats the retry", () => {
    const offenders = fs
      .readFileSync(PRD, "utf8")
      .split("\n")
      .filter((line) => /\bblock "/.test(line) && !line.trimStart().startsWith("#"))
      .filter((line) => /Refused|re-add/i.test(line));

    expect(offenders).toEqual([]);
  });

  /** The start and success comments #205 added, in the same pattern. */
  it("implement: says it started and what it opened in the same pattern", () => {
    const run = stepsOf(IMPLEMENT)
      .map((s) => s.run ?? "")
      .join("\n");

    expect(run).toContain('--body "**\\`agent:implement\\` started:** [Workflow run](${RUN_URL})"');
    expect(run).toContain('--body "**\\`agent:implement\\` opened PR #${NEW_PR}:** [Workflow run](${RUN_URL})"');
    for (const file of [IMPLEMENT, PRD]) expect(fs.readFileSync(file, "utf8")).not.toContain("[workflow run]");
  });
});

/**
 * And what those comments say is written for whoever reads the issue or the
 * pull request (#253): plain words, what happened and then what to do, with
 * no internal file name, variable or mechanism term. Held over the workflow
 * lines that post, and over the TypeScript that writes a reason, a reply, a
 * record or an issue body, as string literals so the code around them may
 * still use the words.
 */
describe("what the loop posts names no internal mechanism", () => {
  const INTERNAL =
    /\b(arms?|cursors?|anchor\w*|round 2|markers?|selections?|author gate|trust boundary|reason file|should not have been invoked|finished with status)\b|\.ts\b|failure_reason/i;

  /** A line that posts, as the em-dash check reads them, less the API calls. */
  const POSTS =
    /(^|[\s|&(])(printf|refuse|refuse_shape|block)\s|gh (?:issue|pr) comment|\b(body|headline|no_ci|pr_note|reason|retry|what)=/;

  it.each(workflowFiles)("%s: posts nothing naming one", (file: string) => {
    const offenders = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trimStart().startsWith("#") && !line.includes("gh api"))
      .filter(({ line }) => POSTS.test(line))
      // What a line writes, not where: the reason file's path is not a message.
      .map(({ line, n }) => ({ line: line.replace(/"\$\{RUNNER_TEMP\}\/[\w.-]+"/g, ""), n }))
      .filter(({ line }) => INTERNAL.test(line))
      .map(({ line, n }) => `${file}:${n} ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  /** Each source and the stretch of it that writes something a human reads. */
  const SOURCES: readonly (readonly [string, string, string])[] = [
    ["shared/pr-feedback.ts", "export const refusalReason", "export const nothingToActOn"],
    ["shared/pr-feedback.ts", "const threeDotRange", "return `${base}...HEAD`"],
    ["shared/fix-output.ts", "export const renderConversationOutcomes", "CONVERSATION_OUTCOME_MARKER}`;"],
    ["shared/review-output.ts", "const movedSentence", "._`;"],
    ["shared/review-output.ts", "const MOVED_NOTE", '._";'],
    ["shared/review-verification.ts", "export const declineReply", '].join("\\n");'],
    ["shared/follow-up-plan.ts", "const stubBody", "dedupPayload("],
    ["implement/implement.ts", "fail(", "\n"],
    ["implement-prd/implement-prd.ts", "fail(", "\n"],
    ["update-branch/update-branch.ts", "fail(", "\n"],
  ];

  /** The string literals on a line, with any `${…}` taken out of a template. */
  const literals = (line: string): string[] =>
    [...line.matchAll(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/g)].map((m) =>
      m[0].replace(/\$\{[^}]*\}/g, ""),
    );

  it.each(SOURCES)("%s, from `%s`: writes nothing naming one", (file, start, end) => {
    const source = fs.readFileSync(file, "utf8");
    const offenders: string[] = [];
    let from = source.indexOf(start);

    expect(from, `${file} has no \`${start}\``).toBeGreaterThanOrEqual(0);
    // Every occurrence, so each `fail(` in a runner is read.
    while (from >= 0) {
      const to = source.indexOf(end, from + start.length);
      const region = source.slice(from, to < 0 ? undefined : to + end.length);
      for (const line of region.split("\n")) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const text of literals(line)) if (INTERNAL.test(text)) offenders.push(`${file}: ${text}`);
      }
      from = source.indexOf(start, from + start.length);
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Progress without labels (PRD #222, #246). The chain's state is the progress
 * list in the PRD PR's body and the comments a run posts, never a state label
 * and never a closed sub-issue.
 */
describe("the PRD chain's progress", () => {
  const advanceSteps = (): readonly Step[] => jobNamed(REVIEW, "advance").steps ?? [];
  const progressStep = (): Step | undefined => advanceSteps().find((s) => s.name === "Re-render the progress list");

  /**
   * The list's markers and the final review's mark are spelled in the
   * workflows, which run no toolchain, and held equal here to the one copy
   * the renderer uses.
   */
  it("spells the list's markers and the final review's mark as the renderer does", () => {
    const prdPr = stepsOf(PRD).find((s) => s.id === "prd_pr");
    const handover = runOf(PRD, "handover");

    const stopped = stepsOf(PRD).find((s) => s.name === "Show the stopped slice in the progress list");
    const building = stepsOf(PRD).find((s) => s.name === "Show the slice building in the progress list");
    const prStatus = (jobNamed(REVIEW, "post-review").steps ?? []).find((s) => s.name === "Write the PR status line");
    for (const env of [progressStep()?.env, prdPr?.env, stopped?.env, building?.env]) {
      expect(env?.["PROGRESS_START"]).toBe(PROGRESS_START);
      expect(env?.["PROGRESS_END"]).toBe(PROGRESS_END);
    }
    for (const env of [progressStep()?.env, prdPr?.env, stopped?.env, building?.env, prStatus?.env]) {
      expect(env?.["STATUS_START"]).toBe(STATUS_START);
      expect(env?.["STATUS_END"]).toBe(STATUS_END);
    }
    for (const env of [progressStep()?.env, prStatus?.env]) expect(env?.["REVIEW_URL_SLOT"]).toBe(REVIEW_URL_SLOT);
    expect(handover).toContain(`mark="${FINAL_REVIEW_MARK}"`);
    expect(handover).toContain(`end="${PROGRESS_END}"`);
    expect(handover).toContain(`status_start="${STATUS_START}"`);
    expect(handover).toContain(`status_end="${STATUS_END}"`);
    expect(handover).toContain(`quoted=$'\\n> '`);
    const prUrl = "${SERVER_URL}/${GH_REPO}/pull/${PRD_PR}";
    expect(handover).toContain(
      `lines="${finalReviewRequestedLines(prUrl).replace(`\n${FINAL_REVIEW_MARK}\n`, "")}"$'\\n'"\${mark}"$'\\n'`,
    );
    expect(handover).toContain(
      `\${status_start}\${quoted}${renderPrdStatus({
        subIssues: [{ number: 1, title: "", state: "OPEN" }, { number: 2, title: "", state: "OPEN" }],
        ranges: { slices: [], next: null, current: null },
        verdict: "none",
        running: { kind: "review" },
        finalReview: "requested",
      }).replace("2", "${SUBS}")}\${quoted}\${status_end}`,
    );
  });

  /** A regular pull request's note opens with the status line its review rewrites. */
  it("opens a regular pull request's note with the status line the renderer names", () => {
    const step = stepsOf(IMPLEMENT).find((s) => s.name === "Open draft PR");

    expect(step?.env?.["OPENING_STATUS"]).toBe(OPENING_STATUS);
    expect(step?.run).toContain(`> ${statusBlock("${OPENING_STATUS}")}`);
    expect(statusBlock("x")).toBe("<!-- agent:status -->\n> x\n> <!-- /agent:status -->");
  });

  /** The regular pull request's status line is the posting job's; a PRD PR's is the advance job's. */
  it("writes a regular pull request's status line after its summary, and never a PRD PR's", () => {
    const names = (jobNamed(REVIEW, "post-review").steps ?? []).map((s) => s.name ?? "");
    const step = (jobNamed(REVIEW, "post-review").steps ?? []).find((s) => s.name === "Write the PR status line");

    expect(names.indexOf("Write the PR status line")).toBe(names.indexOf("Write the PR title and summary") + 1);
    expect(step?.if).toBe("steps.review.outcome == 'success' && !startsWith(github.event.pull_request.head.ref, 'agent/prd-')");
    expect(step?.env?.["REVIEW_URL"]).toBe("${{ steps.review.outputs.url }}");
    expect(step?.run).toContain("set -uo pipefail");
    expect(String(stepsOf(REVIEW).find((s) => s.name === "Hand the review to the posting job")?.with?.["path"])).toContain(
      "${{ runner.temp }}/pr_status.md",
    );
    expect(fs.readFileSync("review/review.ts", "utf8")).toContain('"pr_status.md"');
  });

  /**
   * The advance job writes the list at every ending of a round, before it
   * advances or parks, from the files the review rendered: so the review
   * hands them over, on the artifact that is uploaded however the run ends.
   */
  it("re-renders the list first at every ending of a round, from what the review rendered", () => {
    const names = advanceSteps().map((s) => s.name ?? "");
    const step = progressStep();
    const upload = stepsOf(REVIEW).find((s) => s.name === "Hand the park comment to the advance job");

    // Behind only the fetch, and ahead of the token (#330 review): the list
    // is the workflow token's, so a mint that fails cannot cost it.
    expect(names.slice(0, 3)).toEqual(["Fetch the park comment", "Re-render the progress list", "Resolve the loop's token"]);
    expect(names.indexOf("Re-render the progress list")).toBeLessThan(names.indexOf("Advance the PRD chain"));
    expect(step?.if).toBeUndefined();
    expect(step?.["continue-on-error"]).toBeUndefined();
    for (const ending of ["approved", "parked", "running"]) {
      expect(String(upload?.with?.["path"] ?? "")).toContain(`\${{ runner.temp }}/progress_${ending}.md`);
      expect(String(upload?.with?.["path"] ?? "")).toContain(`\${{ runner.temp }}/status_${ending}.md`);
    }
    expect(jobNamed(REVIEW, "advance").permissions).toEqual({ "pull-requests": "write" });
  });

  it("renders the list in each runner while the token is still in hand", () => {
    const review = fs.readFileSync("review/review.ts", "utf8");
    const implement = fs.readFileSync("implement-prd/implement-prd.ts", "utf8");

    expect(review.indexOf("progressAtRoundEnd(")).toBeGreaterThan(-1);
    expect(review.indexOf("progressAtRoundEnd(")).toBeLessThan(review.indexOf("scrubGitHubTokens();"));
    expect(implement.indexOf("writeProgress();")).toBeGreaterThan(-1);
    expect(implement.indexOf("writeProgress();")).toBeLessThan(implement.indexOf("scrubGitHubTokens();"));
    expect(stepsOf(PRD).find((s) => s.name === "Run implementation agent")?.env?.["PRD_PR"]).toBe(
      "${{ needs.gate.outputs.prd_pr }}",
    );
  });

  /**
   * The gate shows the slice building (#312), in a job that runs no agent and
   * already holds the write scope: only on a run that builds and has a PRD PR,
   * after the run claims its slice, and handing what it replaced to `publish`
   * on the artifact that is uploaded however the gate ends. The runner writes
   * nothing to the PRD PR's body.
   */
  it("shows the slice building from the gate, never from the agent's job", () => {
    const gate = jobNamed(PRD, "gate");
    const names = (gate.steps ?? []).map((s) => s.name ?? "");
    const step = (gate.steps ?? []).find((s) => s.name === "Show the slice building in the progress list");
    const upload = (gate.steps ?? []).find((s) => s.name === "Hand the PRD's snapshot on");
    const implement = fs.readFileSync("implement-prd/implement-prd.ts", "utf8");

    expect(step?.if).toBe(
      "steps.preflight.outputs.refused == 'false' && steps.preflight.outputs.build == 'true' && steps.preflight.outputs.prd_pr != ''",
    );
    expect(names.indexOf("Show the slice building in the progress list")).toBeGreaterThan(names.indexOf("Transition labels"));
    expect(names.indexOf("Show the slice building in the progress list")).toBeLessThan(names.indexOf("Hand the PRD's snapshot on"));
    expect(step?.run).toContain("set -uo pipefail");
    expect(step?.run).not.toContain("set -e");
    expect(JSON.stringify(step)).not.toContain("AGENT_PAT");
    expect(gate.permissions?.["pull-requests"]).toBe("write");
    for (const file of ["progress_unbuilt.md", "status_unbuilt.md"]) {
      expect(String(upload?.with?.["path"] ?? "")).toContain(`\${{ runner.temp }}/${file}`);
    }
    expect(implement).not.toContain('"PATCH"');
    expect(implement).not.toContain("could not be written");
    expect(implement).not.toMatch(/kind: "build"/);
  });

  /**
   * A build run that stops after its gate showed the slice building writes
   * the list back, since it starts no round and no advance job would: on a
   * park, a failure or a cancel of a run that builds, after the comment and
   * the labels, before the trigger label comes off, and never failing the
   * job. The runner's render where it got that far, and what the gate
   * replaced where it did not.
   */
  it("writes the list back where a build run stops", () => {
    const steps = stepsOf(PRD);
    const names = steps.map((s) => s.name ?? "");
    const step = steps.find((s) => s.name === "Show the stopped slice in the progress list");
    const run = step?.run ?? "";
    const implement = fs.readFileSync("implement-prd/implement-prd.ts", "utf8");

    // In the publish job since the split (#308), which runs however the jobs
    // ahead of it ended, so their results are read by name.
    expect(step?.if).toBe(
      "always() && needs.gate.outputs.refused == 'false' && needs.gate.outputs.build == 'true' && (failure() || cancelled() || needs.catch_up.result != 'success' || needs.implement-prd.result != 'success')",
    );
    expect(names.indexOf("Show the stopped slice in the progress list")).toBe(names.indexOf("Mark blocked on failure") + 1);
    expect(run).toContain("set -uo pipefail");
    expect(run).not.toContain("set -e");
    expect(step?.["continue-on-error"]).toBeUndefined();
    expect(step?.env?.["PUSHED"]).toBe("${{ steps.push.outputs.head }}");
    expect(steps.find((s) => s.name === "Run implementation agent")?.env?.["MERGED"]).toBe(
      "${{ needs.catch_up.outputs.merged }}",
    );
    for (const file of [
      "progress_stopped.md",
      "progress_stopped_pushed.md",
      "status_stopped.md",
      "status_stopped_pushed.md",
      "progress_unbuilt.md",
      "status_unbuilt.md",
    ]) {
      expect(run).toContain(file);
    }
    // The runner writes `progress<name>.md` and `status<name>.md` for each.
    for (const name of ['"_stopped"', '"_stopped_pushed"']) {
      expect(implement.indexOf(`write(${name}`)).toBeGreaterThan(-1);
    }
    expect(implement).toContain("writeText(`progress${name}.md`");
    expect(implement).toContain("writeText(`status${name}.md`");
  });

  /**
   * Labels stay triggers: every label the chain adds is one that starts a
   * run, or `agent:blocked` on a failure, and no step closes a sub-issue.
   */
  it("adds no state label for progress, and closes no issue", () => {
    const added = (text: string): string[] => [...text.matchAll(/--add-label "([^"]+)"/g)].map((m) => m[1] ?? "");
    const prd = fs.readFileSync(PRD, "utf8");
    const advance = (jobNamed(REVIEW, "advance").steps ?? []).map((s) => s.run ?? "").join("\n");
    const action = fs.readFileSync(path.join(".github", "actions", "advance-prd", "action.yml"), "utf8");

    expect(new Set(added(prd))).toEqual(new Set(["agent:implement", "agent:blocked", "agent:review"]));
    expect(added(advance)).toEqual([]);
    expect(added(action)).toEqual(["agent:implement"]);
    for (const text of [prd, advance, action]) expect(text).not.toMatch(/gh issue close|state=closed/);
  });

  /**
   * The approved-slice note never fails a run: the comment and the read of
   * the approving review each end in a warning, and the step is not `-e`.
   */
  it("notes the approved slice without being able to fail the run", () => {
    const step = stepsOf(PRD).find((s) => s.id === "approved_note");
    const run = step?.run ?? "";

    expect(step?.if).toBe("steps.preflight.outputs.refused == 'false' && steps.preflight.outputs.approved_sub != ''");
    expect(run).toContain("set -uo pipefail");
    expect(run).not.toContain("set -e");
    expect(run).toMatch(/gh issue comment "\$APPROVED_SUB" --body "\$note" \\\n\s*\|\| echo "::warning::/);
    const names = stepsOf(PRD).map((s) => s.name ?? "");
    expect(names.indexOf("Note the approved slice")).toBe(names.indexOf("Transition labels") + 1);
  });
});

/**
 * The red check (#231, PRD #212): a job that runs the tests a pull request adds
 * or changes against the merge-base, and reports each as red, broken or passed.
 * What its steps do to a tree and to a JUnit report is run in
 * `tests/red-check.test.ts`; this is what the job holds, where it sits, and that
 * it never stands between a pull request and its review.
 */
describe("the red check runs a PR's tests against the merge-base, holding nothing", () => {
  const redCheck = (): Job => jobNamed(REVIEW, "red-check");
  const INPUTS = ["red-check-command", "red-check-report", "red-check-test-globs"];

  /** Off unless configured: every input defaults to empty, and nothing requires one. */
  it("declares three optional inputs, all empty by default", () => {
    const inputs = workflowOf(REVIEW).on?.workflow_call?.inputs ?? {};

    for (const name of INPUTS) {
      expect(inputs[name], name).toMatchObject({ type: "string", default: "" });
      expect(inputs[name]?.required, name).toBeUndefined();
    }
    expect(inputs["red-check-command"]?.description).toMatch(/JUnit XML/);
  });

  /**
   * Skipped unless the command is set, so an adopter who sets nothing gets no
   * job. And the review's own two guards: it runs the PR's code, so a fork's
   * PR must never reach it.
   */
  it("runs only where it is configured, and carries the review's fork and label guards", () => {
    expect(redCheck().if).toBe(
      "github.event.label.name == 'agent:review' && " +
        "github.event.pull_request.head.repo.full_name == github.repository && " +
        "inputs.red-check-command != ''",
    );
  });

  it("holds only contents: read, and no secret", () => {
    expect(redCheck().permissions).toEqual({ contents: "read" });
    const text = JSON.stringify(redCheck());

    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/github\.token|GITHUB_TOKEN|GH_TOKEN/);
  });

  /**
   * The token the checkout used is not left in `.git/config` for the PR's
   * tests to read, and the toolchain saves no cache the PR's code could have
   * written into: one saved here would be restored on the base branch.
   */
  it("leaves no credential behind and saves no cache", () => {
    const steps = redCheck().steps ?? [];
    const checkout = steps.find((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    const node = steps.find((s) => (s.uses ?? "").startsWith("actions/setup-node@"));

    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(checkout?.with?.["ref"]).toBe("${{ github.event.pull_request.head.sha }}");
    expect(node?.with?.["cache"]).toBeUndefined();
    expect(node?.with?.["package-manager-cache"]).toBe(false);
  });

  /**
   * On a slice round its base is the PRD branch before the slice (#235), and
   * on the final review it runs nothing. It tells the two apart by the mark
   * the finishing run writes, a third spelling of it, held to the one the
   * progress list writes. The body reaches the shell through `env:`, never
   * inline: it is the pull request's to write.
   */
  it("tells a slice round from the final review by the mark the finishing run writes", () => {
    const place = (redCheck().steps ?? []).find((s) => s.id === "place");

    expect(place?.env?.["FINAL_REVIEW_MARK"]).toBe(FINAL_REVIEW_MARK);
    expect(place?.env?.["PR_BODY"]).toBe("${{ github.event.pull_request.body }}");
    expect(place?.env?.["HEAD_REF"]).toBe("${{ github.event.pull_request.head.ref }}");
    expect(place?.run ?? "").toContain('if [[ "$HEAD_REF" == agent/prd-* && "$PR_BODY" == *"$FINAL_REVIEW_MARK"* ]]; then');
    expect(place?.run ?? "").not.toContain("github.event");
  });

  /**
   * Nothing it produces is trusted beyond its report: no job output, and
   * nothing in the file reads one. The report is an artifact, written whatever
   * happened.
   */
  it("hands over its report as an artifact and nothing else", () => {
    expect(redCheck().outputs).toBeUndefined();
    expect(fs.readFileSync(REVIEW, "utf8")).not.toContain("needs.red-check.outputs");

    const upload = (redCheck().steps ?? []).find((s) => (s.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.["name"]).toBe("agent-red-check");
    expect(upload?.with?.["path"]).toBe("${{ runner.temp }}/red_check.json");
  });

  /**
   * The review `needs:` it so the report exists first, and runs however it
   * ended. `!cancelled()` drops the implicit "every need succeeded" that would
   * otherwise skip the review behind a skipped or failed red check, and
   * nothing in the condition reads the red check's result.
   */
  it("never stops the review, whether it was skipped or failed", () => {
    const review = jobOf(REVIEW);

    expect(review.needs).toContain("red-check");
    expect(review.if ?? "").toMatch(/^!cancelled\(\) && needs\.time-limit\.result == 'success' && /);
    expect(review.if ?? "").not.toContain("red-check");
    expect(review.if ?? "").not.toMatch(/\balways\(\)/);
  });

  /** Its check run reads red when it finds a red test, which is not CI. */
  it("never feeds ci_result", () => {
    expect("review / red-check").toMatch(new RegExp(waitStep().env?.["AGENT_CHECKS"] ?? ""));
    expect("agent-review / red-check").toMatch(new RegExp(waitStep().env?.["AGENT_CHECKS"] ?? ""));
  });

  /**
   * Both caller sets show the inputs commented out, the way an adopter turns
   * the check on, and neither sets them: this repository's caller pins a
   * release that may not declare them, and GitHub fails a caller passing an
   * input its reusable does not declare.
   */
  it.each(eachCaller(callersOfWorkflow(REVIEW)))(
    "%s: shows the inputs commented out",
    (_name, caller) => {
      const text = fs.readFileSync(caller.file, "utf8");

      for (const name of INPUTS) {
        expect(text).toMatch(new RegExp(`^\\s*# ${name}: \\S`, "m"));
        expect(caller.job.with?.[name]).toBeUndefined();
      }
    },
  );

  /**
   * The review reads the report (#232): fetched only where the check is on,
   * and never a step that can fail the review, since a report that did not
   * arrive is a fact the runner reads as unknown. Whether it is on goes to the
   * runner beside the file, since "off" and "lost" both leave no file.
   */
  it("hands the review its report, and whether the check is on", () => {
    const steps = stepsOf(REVIEW);
    const fetch = steps.find((s) => s.name === "Fetch the red check's report");
    const agent = steps.find((s) => s.name === "Run review agent");
    const names = steps.map((s) => s.name ?? "");

    expect(fetch?.uses).toMatch(/^actions\/download-artifact@/);
    expect(fetch?.with?.["name"]).toBe("agent-red-check");
    expect(fetch?.with?.["path"]).toBe("${{ runner.temp }}/red-check");
    expect(fetch?.if).toBe("steps.state.outputs.proceed == 'true' && inputs.red-check-command != ''");
    expect(fetch?.["continue-on-error"]).toBe(true);
    expect(names.indexOf("Fetch the red check's report")).toBeLessThan(names.indexOf("Run review agent"));
    expect(agent?.env?.["RED_CHECK_CONFIGURED"]).toBe("${{ inputs.red-check-command != '' }}");
    expect(agent?.env?.["RED_CHECK_FILE"]).toBe("${{ runner.temp }}/red-check/red_check.json");
  });
});

/**
 * **The job that runs the agent can write nothing, and the jobs that write run
 * no agent.** The agent runs with the runner's passwordless `sudo`, so it can
 * read the runner process's memory, which holds every secret its job names
 * from the job's start — in a step that never runs, too (probed 2026-10-02) —
 * and it can leave something behind for a later step on the same runner. So
 * the split, not the scrubbing, is the boundary: the agent's job names no PAT
 * and holds a read-only token, and everything that writes runs on a runner the
 * agent never touched, taking from it only an artifact it checks.
 *
 * Every assertion here reads the file, not a list of steps, where a PAT named
 * anywhere would put it on the agent's runner.
 */
describe("a split run keeps every write off the agent's runner", () => {
  const splits = Object.keys(SPLIT_RUNS).map((file) => [path.basename(file), file] as const);
  const PAT_REFERENCE = /secrets\.AGENT_PAT/;
  const otherLabel = (label: string): string =>
    `\${{ github.event.label.name != '${label}' && format('-other-{0}', github.run_id) || '' }}`;

  /**
   * What differs between the four, each for a reason the workflow states: the
   * agent's job's `if:` (update-branch's runs only on a conflicted merge, and
   * implement-prd's only on a run that builds a slice and did not park), the
   * read scopes its runner needs, what its gate writes to, the group it holds,
   * how it bundles, and what the publish job checks the bundle against.
   */
  const SPEC: Readonly<
    Record<
      string,
      {
        readonly agentIf: string;
        readonly agentPermissions: Readonly<Record<string, string>>;
        readonly gateWrites: readonly string[];
        readonly group: string;
        readonly bundle: string;
        readonly bundleIf: string;
        readonly branch: string;
        readonly ancestors: readonly string[];
        readonly pushed: string;
        readonly blocks: number;
        readonly patJobs: readonly string[];
      }
    >
  > = {
    "implement.yml": {
      agentIf: "needs.gate.outputs.refused == 'false'",
      agentPermissions: { contents: "read", issues: "read", packages: "read" },
      gateWrites: ["issues"],
      group: `agent-implement-issue-\${{ github.event.issue.number }}${otherLabel("agent:implement")}`,
      bundle: 'git bundle create "${RUNNER_TEMP}/branch.bundle" "refs/heads/${BRANCH}" "^refs/heads/${BASE_REF}"',
      bundleIf: "success()",
      branch: "BRANCH",
      ancestors: ["$BASE_SHA"],
      pushed: 'push --force origin "$BRANCH"',
      blocks: 5,
      patJobs: ["publish"],
    },
    "fix.yml": {
      agentIf: "needs.gate.outputs.refused == 'false'",
      // `issues: read` for a PRD's sub-issues, which place the fix round (#348).
      agentPermissions: { contents: "read", issues: "read", packages: "read", "pull-requests": "read" },
      gateWrites: ["pull-requests"],
      group: `agent-pr-\${{ github.event.pull_request.number }}${otherLabel("agent:fix")}`,
      bundle: 'git bundle create "${RUNNER_TEMP}/branch.bundle" "refs/heads/${BRANCH}" "^${BRANCH_HEAD_SHA}"',
      // However the job ended (#303): a stopped run's commits are rescued.
      bundleIf: "always()",
      branch: "BRANCH",
      ancestors: ["$BRANCH_HEAD_SHA"],
      pushed: 'push --force-with-lease="refs/heads/$BRANCH:$BRANCH_HEAD_SHA" origin "$BRANCH"',
      // No "finished without handing over": no bundle is no commits.
      blocks: 4,
      patJobs: ["publish"],
    },
    "update-branch.yml": {
      agentIf: "needs.gate.outputs.refused == 'false' && needs.gate.outputs.status == 'conflicts'",
      agentPermissions: { contents: "read", packages: "read", "pull-requests": "read" },
      gateWrites: ["pull-requests"],
      group: `agent-pr-\${{ github.event.pull_request.number }}${otherLabel("agent:update-branch")}`,
      bundle: 'git bundle create "${RUNNER_TEMP}/branch.bundle" "refs/heads/${BRANCH}" "^${BRANCH_HEAD_SHA}" "^${BASE_SHA}"',
      bundleIf: "success()",
      branch: "BRANCH",
      ancestors: ["$BRANCH_HEAD_SHA", "$BASE_SHA"],
      pushed: 'push --force-with-lease="refs/heads/$BRANCH:$BRANCH_HEAD_SHA" origin "$BRANCH"',
      blocks: 5,
      patJobs: ["publish"],
    },
    "implement-prd.yml": {
      agentIf: "needs.gate.outputs.refused == 'false' && needs.gate.outputs.build == 'true' && needs.catch_up.outputs.parked != 'true'",
      agentPermissions: { contents: "read", issues: "read", packages: "read", "pull-requests": "read" },
      gateWrites: ["issues", "pull-requests"],
      group: `agent-implement-prd-issue-\${{ github.event.issue.number }}${otherLabel("agent:implement")}`,
      bundle: 'git bundle create "${RUNNER_TEMP}/branch.bundle" "refs/heads/${BRANCH}" "^${BASE_SHA}"',
      // However the job ended (#303): a stopped run's commits are rescued.
      bundleIf: "always()",
      branch: "PRD_BRANCH",
      ancestors: ["$BASE_SHA"],
      pushed: 'push origin "$PRD_BRANCH"',
      blocks: 5,
      // The catch-up pushes the default branch's merge before the agent runs,
      // on a runner of its own.
      patJobs: ["catch_up", "publish"],
    },
  };
  const specOf = (name: string): (typeof SPEC)[string] => {
    const spec = SPEC[name];
    expect(spec, name).toBeDefined();
    return spec as (typeof SPEC)[string];
  };

  it("is every workflow that runs an agent to write code", () => {
    expect(splits.map(([name]) => name).sort()).toEqual(["fix.yml", "implement-prd.yml", "implement.yml", "update-branch.yml"]);
  });

  it.each(splits)("%s: runs gate, agent and publish in that order", (name, file) => {
    const jobs = workflowOf(file).jobs;
    const ids = SPLIT_RUNS[file] ?? [];
    const { gate, agent, publish } = rolesOf(file);
    const before = ids.slice(0, ids.indexOf(agent));

    expect(Object.keys(jobs)).toEqual(ids);
    expect(ids[0]).toBe(gate);
    expect(ids.at(-1)).toBe(publish);
    expect(jobs[agent]?.needs).toEqual(before.length === 1 ? gate : before);
    expect(jobs[agent]?.if).toBe(specOf(name).agentIf);
    expect(jobs[publish]?.needs).toEqual(ids.slice(0, -1));
    // However the agent's job ended, but never for another label's event or
    // a run the gate refused or deferred.
    expect(jobs[publish]?.if).toBe(
      `always() && needs.${gate}.result != 'skipped' && needs.${gate}.outputs.refused != 'true'`,
    );
  });

  it.each(splits)("%s: runs the agent in its own job and nowhere else", (_, file) => {
    const { agent } = rolesOf(file);
    const runs = (id: string): boolean =>
      (jobNamed(file, id).steps ?? []).some((s) => (s.run ?? "").includes("-- agent-workflows "));

    for (const id of SPLIT_RUNS[file] ?? []) expect(runs(id), id).toBe(id === agent);
  });

  it.each(splits)("%s: names no PAT anywhere in the agent's job, nor in the gate", (_, file) => {
    const { gate, agent } = rolesOf(file);
    for (const id of [gate, agent]) {
      expect(JSON.stringify(jobNamed(file, id)), id).not.toMatch(PAT_REFERENCE);
    }
  });

  it.each(splits)("%s: gives the agent's job a token that writes nothing", (name, file) => {
    const permissions = jobNamed(file, rolesOf(file).agent).permissions ?? {};

    expect(permissions).toEqual(specOf(name).agentPermissions);
    expect(Object.values(permissions)).not.toContain("write");
  });

  it.each(splits)("%s: writes from the gate only to the issue or the pull request", (name, file) => {
    const permissions = jobNamed(file, rolesOf(file).gate).permissions ?? {};

    expect(Object.entries(permissions).filter(([, level]) => level === "write").map(([scope]) => scope)).toEqual(
      specOf(name).gateWrites,
    );
  });

  /**
   * The agent's job's outputs are the agent's to write, so the publish job
   * reads none of them, and the agent's job declares none to read. What the
   * publish job pushes is the artifact; where it pushes it and what it checks
   * it against come from the jobs no agent ran in.
   */
  it.each(splits)("%s: takes nothing from the agent's job but its artifact", (_, file) => {
    const { agent } = rolesOf(file);
    expect(jobNamed(file, agent).outputs).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).not.toContain(`needs.${agent}.outputs`);
  });

  /**
   * One group for the whole run, at workflow level, or a second run for the
   * same issue or pull request could start between this run's agent and its
   * push: a job-level group is released when the job ends. And keyed on the
   * label, because a workflow-level group is entered before any job's `if:`
   * is evaluated (#309), and admits one pending run, cancelling the one it
   * replaces: another label's event would cancel a queued run of this one.
   */
  it.each(splits)("%s: holds the whole run in one group, which another label's event cannot take", (name, file) => {
    const workflow = workflowOf(file);

    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency?.group).toBe(specOf(name).group);
    for (const job of jobsOf(file)) expect(job.concurrency).toBeUndefined();
  });

  it.each(splits)("%s: hands the agent's commits over as a bundle of the one branch, however the job ended", (name, file) => {
    const steps = jobNamed(file, rolesOf(file).agent).steps ?? [];
    const names = steps.map((s) => s.name);
    const bundle = steps.find((s) => s.name === "Bundle the branch");
    const upload = steps.find((s) => s.name === "Hand the branch to the publish job");

    expect(bundle?.run ?? "").toContain(specOf(name).bundle);
    expect(bundle?.if).toBe(specOf(name).bundleIf);
    // Last, so it carries a reason file however the agent's run ended.
    expect(names.slice(-2)).toEqual(["Bundle the branch", "Hand the branch to the publish job"]);
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.["path"]).toContain("${{ runner.temp }}/branch.bundle");
    expect(upload?.with?.["path"]).toContain("${{ runner.temp }}/failure_reason.txt");
  });

  /**
   * The bundle's content is the agent's, as the pushed branch always was; what
   * the publish job checks is that it is the branch this run was for: intact,
   * exactly the one branch the gate named, built on what a job no agent ran in
   * read. Every check precedes the push, and none of them reads the agent's
   * job.
   */
  it.each(splits)("%s: checks the bundle before it pushes", (name, file) => {
    const spec = specOf(name);
    const push = (jobNamed(file, rolesOf(file).publish).steps ?? []).find((s) => s.id === "push");
    const run = push?.run ?? "";
    const at = (needle: string): number => {
      expect(run, needle).toContain(needle);
      return run.indexOf(needle);
    };

    const pushed = at(spec.pushed);
    for (const check of [
      'git bundle verify --quiet "$bundle"',
      'git bundle list-heads "$bundle"',
      `!= "refs/heads/\${${spec.branch}}"`,
      'git bundle unbundle "$bundle"',
      ...spec.ancestors.map((a) => `git merge-base --is-ancestor "${a}" "refs/heads/\${${spec.branch}}"`),
    ]) {
      expect(at(check), check).toBeLessThan(pushed);
    }
    // Each refusal names itself, for the failure comment.
    expect(run.match(/block "The agent's/g)).toHaveLength(spec.blocks);
  });

  /** What the bundle is checked against comes from a job no agent ran in. */
  it("checks each bundle against a job that ran no agent", () => {
    const pushEnv = (file: string): Readonly<Record<string, string>> =>
      (jobNamed(file, "publish").steps ?? []).find((s) => s.id === "push")?.env ?? {};

    expect(pushEnv(path.join(WORKFLOW_DIR, "implement.yml"))["BASE_SHA"]).toBe("${{ needs.gate.outputs.base }}");
    expect(jobNamed(path.join(WORKFLOW_DIR, "implement.yml"), "gate").outputs?.["base"]).toBe("${{ steps.base.outputs.sha }}");
    expect(pushEnv(path.join(WORKFLOW_DIR, "update-branch.yml"))["BASE_SHA"]).toBe("${{ needs.gate.outputs.base }}");
    expect(jobNamed(path.join(WORKFLOW_DIR, "update-branch.yml"), "gate").outputs?.["base"]).toBe("${{ steps.merge.outputs.base_sha }}");
    expect(pushEnv(path.join(WORKFLOW_DIR, "implement-prd.yml"))["BASE_SHA"]).toBe("${{ needs.catch_up.outputs.head }}");
    expect(jobNamed(path.join(WORKFLOW_DIR, "implement-prd.yml"), "catch_up").outputs?.["head"]).toBe("${{ steps.tip.outputs.sha }}");
    // fix's is the event's head, which the gate confirmed is the branch's.
    expect(jobNamed(path.join(WORKFLOW_DIR, "fix.yml"), "publish").env?.["BRANCH_HEAD_SHA"]).toBe("${{ github.event.pull_request.head.sha }}");
  });

  it.each(splits)("%s: spends the PAT only in the jobs that write and run no agent", (name, file) => {
    const allowed = specOf(name).patJobs;
    for (const [id, job] of Object.entries(workflowOf(file).jobs)) {
      if (allowed.includes(id)) expect(JSON.stringify(job), id).toMatch(PAT_REFERENCE);
      else expect(JSON.stringify(job), id).not.toMatch(PAT_REFERENCE);
    }
  });
});

/**
 * **The loop writes with the loop's token** (#319, #320, PRD #314). One
 * composite action, `.github/actions/loop-token`, chooses it: an installation
 * token minted for the loop's App where its ID and key are both set, else
 * `AGENT_PAT`, else the workflow token, and says which it chose. Every write
 * `AGENT_PAT` made, on either side, is now made with what it returns, and a
 * step deciding whether a label it adds fires anything reads its source.
 *
 * It mints only in a job that writes and runs no agent, at that job's start,
 * and no token passes between jobs. That is what keeps the App's key and
 * every token minted from it off the agent's runner, which holds every secret
 * its job names (#307). The one other job naming it is review's `time-limit`,
 * which asks it for the source alone, so that the review job can tell whether
 * a fix round would start without naming a secret.
 *
 * Executed in `tests/loop-token-step.test.ts`; what is asserted here is where
 * it runs, what it is handed and what reads its outputs.
 */
describe("the loop resolves its token in the jobs that write", () => {
  interface Action {
    readonly inputs?: Record<string, { readonly required?: boolean; readonly default?: string }>;
    readonly outputs?: Record<string, { readonly value?: string }>;
    readonly runs?: { readonly using?: string; readonly steps?: readonly Step[] };
  }
  const action = (): Action => parse(fs.readFileSync(TOKEN_ACTION, "utf8")) as Action;
  const actionStep = (id: string): Step | undefined => (action().runs?.steps ?? []).find((s) => s.id === id);

  const RESOLVER = `jeffwlawson/agent-workflows/.github/actions/loop-token@${PIN}`;
  const TOKEN = "${{ steps.token.outputs.token }}";
  const SOURCE = "${{ steps.token.outputs.source }}";
  /** Every expression naming a secret but the agent's token or the job token, as `forbidden` reads it below. */
  const writingSecrets = (node: unknown): string[] =>
    [...JSON.stringify(node).matchAll(/\$\{\{.*?\}\}/g)]
      .map((m) => m[0])
      .filter((e) => /(?<![\w.-])secrets(?![\w-])(?!\.(?:CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN)(?![\w-]))/i.test(e));
  const resolves = (s: Step): boolean => (s.uses ?? "").includes("/actions/loop-token@");
  /**
   * Each workflow's jobs that mint: the ones that write what the workflow
   * token cannot. A gate-side job, a publish job, or one of review's two
   * posting jobs, and never the agent's.
   */
  const MINTING: Readonly<Record<string, readonly string[]>> = {
    [IMPLEMENT]: ["publish"],
    // The catch-up pushes the default branch's merge before the agent runs.
    [PRD]: ["catch_up", "publish"],
    [REVIEW]: ["post-review", "advance"],
    [path.join(WORKFLOW_DIR, "fix.yml")]: ["publish"],
    [path.join(WORKFLOW_DIR, "update-branch.yml")]: ["publish"],
  };
  /** …and the one job that asks it only which token that would be. */
  const CHOOSING: Readonly<Record<string, readonly string[]>> = { [REVIEW]: ["time-limit"] };
  const MINTING_ROLES = ["gate", "catch_up", "publish", "post-review", "advance"];
  const mintingJobs = (file: string): readonly (readonly [string, Job])[] =>
    (MINTING[file] ?? []).map((id) => [id, jobNamed(file, id)] as const);
  const namingJobs = (file: string): readonly (readonly [string, Job])[] =>
    [...(MINTING[file] ?? []), ...(CHOOSING[file] ?? [])].map((id) => [id, jobNamed(file, id)] as const);
  /** Every line of a step's script that is not a shell comment. */
  const codeOf = (s: Step): string => (s.run ?? "").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

  it("covers every workflow that writes with more than the workflow token", () => {
    expect([...RESOLVING].sort()).toEqual(Object.keys(MINTING).sort());
    // follow-ups files its issues with the workflow token, and names no other.
    expect(runnerWorkflows.filter((f) => !RESOLVING.includes(f)).map((f) => path.basename(f))).toEqual(["follow-ups.yml"]);
  });

  it("is named only in the jobs that write and run no agent, and review's time limit, once in each", () => {
    const naming = runnerWorkflows.flatMap((file) =>
      Object.entries(workflowOf(file).jobs).flatMap(([id, job]) =>
        (job.steps ?? []).filter(resolves).map(() => `${path.basename(file)} ${id}`),
      ),
    );

    expect(naming.sort()).toEqual(
      RESOLVING.flatMap((file) => namingJobs(file).map(([id]) => `${path.basename(file)} ${id}`)).sort(),
    );
  });

  /** App tokens are minted in a gate, publish, `post-review` or `advance` job alone. */
  it("mints only in a gate, publish, post-review or advance job, never the agent's", () => {
    for (const file of RESOLVING) {
      for (const [id] of mintingJobs(file)) {
        expect(MINTING_ROLES, `${path.basename(file)} ${id}`).toContain(id);
        expect(id).not.toBe(path.basename(file, ".yml"));
      }
    }
  });

  it.each(RESOLVING)("%s: hands the resolver the App's secrets, the PAT and the job token, at a pin", (file) => {
    for (const [id, job] of namingJobs(file)) {
      const step = (job.steps ?? []).find(resolves);
      const choosing = (CHOOSING[file] ?? []).includes(id);

      expect(step?.uses, id).toBe(RESOLVER);
      expect(step?.id, id).toBe("token");
      expect(step?.with, id).toEqual({
        "app-id": "${{ secrets.AGENT_APP_ID }}",
        "private-key": "${{ secrets.AGENT_APP_PRIVATE_KEY }}",
        "agent-pat": "${{ secrets.AGENT_PAT }}",
        "github-token": "${{ secrets.GITHUB_TOKEN }}",
        ...(choosing ? { "choose-only": "true" } : {}),
      });
    }
  });

  /**
   * `time-limit` hands the source across, and the review job reads it where
   * the budget decides whether a round can start: a label the workflow token
   * adds starts none.
   */
  it("tells the review job which token the loop writes with, and nothing else", () => {
    const budget = (jobNamed(REVIEW, "review").steps ?? []).find((s) => s.id === "budget");

    expect(jobNamed(REVIEW, "time-limit").outputs?.["token-source"]).toBe(SOURCE);
    expect(budget?.env?.["TOKEN_SOURCE"]).toBe("${{ needs.time-limit.outputs.token-source }}");
    expect(codeOf(budget ?? {})).toContain(
      '[ "$spent" -lt "$budget" ] && { [ "$TOKEN_SOURCE" = "app" ] || [ "$TOKEN_SOURCE" = "pat" ]; }',
    );
    expect(JSON.stringify(jobNamed(REVIEW, "time-limit"))).not.toContain("steps.token.outputs.token");
  });

  /**
   * Before the job's first use of it. A gate-side or publish job resolves it
   * at its start, where nothing runs before it but the fetches of what the
   * jobs ahead handed over, and a publish job `always()`, since it also
   * reports a failed agent and takes the trigger label off after one.
   *
   * Review's two jobs resolve it **just before** that first use (#330
   * review), and `always()`: a mint that fails skips every later step whose
   * `if:` names no status function, and at the start that was the refusal
   * note, the posted review and the progress list, none of which needs it.
   */
  const LATE: readonly string[] = ["post-review", "advance"];
  it.each(RESOLVING)("%s: resolves the token before the job's first use of it", (file) => {
    for (const [id, job] of mintingJobs(file)) {
      const steps = job.steps ?? [];
      const at = steps.findIndex(resolves);
      const first = steps.findIndex((s) => JSON.stringify(s).includes("steps.token.outputs"));

      expect(first, id).toBeGreaterThan(at);
      if (LATE.includes(id)) {
        expect(first, `${id}: the resolver is not just before its first use`).toBe(at + 1);
        expect((steps[at]?.if ?? "").startsWith("always()"), id).toBe(true);
        continue;
      }
      for (const before of steps.slice(0, at)) expect(before.uses ?? "", `${id}: ${before.name}`).toMatch(/^actions\/download-artifact@/);
      expect(steps[at]?.if, id).toBe(id === "publish" ? "always()" : undefined);
    }
  });

  /**
   * Only the resolver is handed a secret that writes; every other step takes
   * the token it returns, and decides on the source it reports. No step asks
   * whether the PAT is set any more.
   */
  it.each(RESOLVING)("%s: names a writing secret only to hand it to the resolver", (file) => {
    for (const [id, job] of Object.entries(workflowOf(file).jobs)) {
      expect(writingSecrets(job.env ?? {}), id).toEqual([]);
      expect(writingSecrets(job.outputs ?? {}), id).toEqual([]);
      for (const step of job.steps ?? []) {
        if (resolves(step)) continue;
        expect(writingSecrets(step), `${id}: ${step.name}`).toEqual([]);
        expect(step.env?.["HAS_PAT"], `${id}: ${step.name}`).toBeUndefined();
        for (const name of ["PUSH_TOKEN", "REQUEST_TOKEN", "LOOP_TOKEN"]) {
          if (step.env?.[name] !== undefined) expect(step.env[name], `${id}: ${step.name}`).toBe(TOKEN);
        }
        if (step.env?.["TOKEN_SOURCE"] !== undefined && id !== "review") {
          expect(step.env["TOKEN_SOURCE"], `${id}: ${step.name}`).toBe(SOURCE);
        }
        const token = step.env?.["GH_TOKEN"];
        if (token !== undefined) expect([TOKEN, "${{ secrets.GITHUB_TOKEN }}"], `${id}: ${step.name}`).toContain(token);
      }
    }
  });

  /**
   * The writes `AGENT_PAT` made: every push, `gh pr create`, `gh pr ready`,
   * every trigger label added for another run to fire on, and whatever a step
   * writes under a token it names on the command itself. A gate's claim
   * re-adds the run's own label with the workflow token, on purpose, so that
   * it fires nothing; a re-request of it is made under a token named on the
   * command. Each is made with the resolved token, and
   * each `agent:review` or `agent:update-branch` added, and the park comment
   * on a PRD's parent, reads the source, to warn or comment instead where it
   * is the workflow token and the write would fire nothing or be refused.
   * `agent:fix` is added only where the budget, which read the source, said a
   * round starts.
   */
  it.each(RESOLVING)("%s: makes every write the workflow token cannot with the resolved token", (file) => {
    const INLINE = /\bGH_TOKEN="\$([A-Z_]+)" gh /;
    const own = `agent:${path.basename(file, ".yml").replace(/-prd$/, "")}`;
    const handOff = new RegExp(
      `--add-label "(?!${own}")agent:(review|fix|implement|update-branch)"`,
    );
    const writes = Object.values(workflowOf(file).jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((s) => /\bpush (--force )?origin\b|\bgh pr create\b|\bgh pr ready\b/.test(codeOf(s)) || handOff.test(codeOf(s)) || INLINE.test(codeOf(s)));

    expect(writes.length).toBeGreaterThan(0);
    for (const step of writes) {
      const code = codeOf(step);
      const inline = INLINE.exec(code)?.[1];
      const variable = inline ?? (/\bpush\b/.test(code) ? "PUSH_TOKEN" : "GH_TOKEN");
      expect(step.env?.[variable], `${step.name}: ${variable}`).toBe(TOKEN);
      if (/--add-label "agent:(review|update-branch)"|GH_TOKEN="\$[A-Z_]+" gh issue comment\b/.test(code)) {
        expect(step.env?.["TOKEN_SOURCE"], step.name).toBe(SOURCE);
        expect(code, step.name).toContain('[ "$TOKEN_SOURCE" != "app" ] && [ "$TOKEN_SOURCE" != "pat" ]');
      }
    }
  });

  /** The PRD chain's advance chooses nothing either: it is handed the token and its source. */
  it("hands the PRD chain's advance the resolved token and its source", () => {
    const advance = (jobNamed(REVIEW, "advance").steps ?? []).find((s) => (s.uses ?? "").includes("/actions/advance-prd@"));

    expect(advance?.with?.["token"]).toBe(TOKEN);
    expect(advance?.with?.["token-source"]).toBe(SOURCE);
  });

  it.each(RESOLVING)("%s: declares the App's two secrets, optional", (file) => {
    const declared = workflowOf(file).on?.workflow_call?.secrets ?? {};

    for (const name of APP_SECRETS) expect(declared[name]?.required, name).toBe(false);
  });

  /**
   * **Only the resolver chooses** (#320). Everywhere else a loop secret is
   * passed on as it is, `${{ secrets.<name> }}`: never compared, never ORed
   * with another, and never weighed against the workflow token. Over every
   * workflow, the callers included, and every composite action but the
   * resolver.
   */
  it("leaves the choice between App, PAT and workflow token to the resolver alone", () => {
    const actions = fs
      .readdirSync(path.join(".github", "actions"))
      .map((name) => path.join(".github", "actions", name, "action.yml"))
      .filter((file) => file !== TOKEN_ACTION);
    const files = [...workflowFiles, ...actions];

    expect(actions.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const expressions = [...text.matchAll(/\$\{\{[\s\S]*?\}\}/g)].map((m) => m[0]);
      const choosing = expressions.filter(
        (e) =>
          /AGENT_PAT|AGENT_APP_ID|AGENT_APP_PRIVATE_KEY/.test(e) &&
          !/^\$\{\{ secrets\.(AGENT_PAT|AGENT_APP_ID|AGENT_APP_PRIVATE_KEY) \}\}$/.test(e),
      );

      expect(choosing, file).toEqual([]);
      expect(expressions.filter((e) => /secrets\.GITHUB_TOKEN\s*\|\||\|\|\s*secrets\.GITHUB_TOKEN/.test(e)), file).toEqual([]);
      expect(text, file).not.toContain("HAS_PAT");
    }
  });

  /** Every input but the job token is optional, since an unset secret arrives empty. */
  it("is a composite taking the three optional secrets, the job token and a choose-only switch", () => {
    expect(action().runs?.using).toBe("composite");
    expect(action().inputs).toEqual({
      "app-id": expect.objectContaining({ required: false, default: "" }),
      "private-key": expect.objectContaining({ required: false, default: "" }),
      "agent-pat": expect.objectContaining({ required: false, default: "" }),
      "github-token": expect.objectContaining({ required: true }),
      "choose-only": expect.objectContaining({ required: false, default: "false" }),
    });
  });

  /** The choice needs no secret: its step is told only whether each is set. */
  it("chooses from whether each is set, never from a value", () => {
    expect(actionStep("choose")?.env).toEqual({
      HAS_APP_ID: "${{ inputs.app-id != '' }}",
      HAS_APP_KEY: "${{ inputs.private-key != '' }}",
      HAS_PAT: "${{ inputs.agent-pat != '' }}",
    });
  });

  /**
   * GitHub's own action mints, only for the App, for this repository alone,
   * and never under `choose-only`. Its token is returned in front of the PAT,
   * and the PAT in front of the job token: the mint runs only where the
   * source is `app`, and the PAT is set wherever the source is `pat`, so the
   * order follows the choice. Under `choose-only` nothing is returned.
   */
  it("mints only for the App, for this repository, and returns what it chose", () => {
    const mint = actionStep("mint");

    expect(mint?.uses).toMatch(/^actions\/create-github-app-token@v\d+$/);
    expect(mint?.if).toBe("steps.choose.outputs.source == 'app' && inputs.choose-only != 'true'");
    expect(mint?.with).toEqual({
      "client-id": "${{ inputs.app-id }}",
      "private-key": "${{ inputs.private-key }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
    });
    expect(action().outputs?.["token"]?.value).toBe(
      "${{ inputs.choose-only != 'true' && (steps.mint.outputs.token || inputs.agent-pat || inputs.github-token) || '' }}",
    );
    expect(action().outputs?.["source"]?.value).toBe("${{ steps.choose.outputs.source }}");
  });

  /**
   * A mint that fails fails the job, with a reason the failure comment can
   * read, and never falls back: an App set up and not used is worth stopping
   * on. An earlier reason, the agent's, is the one left.
   */
  it("says why a mint failed, keeping a reason already there", () => {
    const said = (action().runs?.steps ?? []).find((s) => (s.run ?? "").includes("failure_reason.txt"));

    expect(said?.if).toBe("failure() && steps.mint.outcome == 'failure'");
    expect(said?.run).toContain('[ -f "${RUNNER_TEMP}/failure_reason.txt" ] || printf');
    expect(said?.run).toContain("AGENT_APP_ID");
    expect(actionStep("mint")?.["continue-on-error"]).toBeUndefined();
  });
});

/**
 * **A status-check function is allowed only in an `if:`.** GitHub rejects
 * `success()`, `failure()`, `cancelled()` and `always()` anywhere else, in a
 * step's `env` or `with` or a job's `outputs`, and rejects the whole file with
 * it: every run of that workflow fails before any job starts. Nothing in this
 * suite parses an expression the way GitHub does, so a test that asserts the
 * text it was written with passes over a file GitHub will not load (#307).
 * Read over every workflow and composite action, at every key but `if`.
 */
describe("a status-check function appears only in an `if:`", () => {
  const STATUS_CALL = /\$\{\{[^}]*\b(?:success|failure|cancelled|always)\s*\(\s*\)[^}]*\}\}/;
  const actionFiles = fs
    .readdirSync(path.join(".github", "actions"))
    .map((d) => path.join(".github", "actions", d, "action.yml"))
    .filter((f) => fs.existsSync(f));

  const misplaced = (node: unknown, at: string): string[] => {
    if (typeof node === "string") return STATUS_CALL.test(node) ? [at] : [];
    if (Array.isArray(node)) return node.flatMap((n, i) => misplaced(n, `${at}[${i}]`));
    if (node !== null && typeof node === "object") {
      return Object.entries(node).flatMap(([k, v]) => (k === "if" ? [] : misplaced(v, `${at}.${k}`)));
    }
    return [];
  };

  it("reads at least one composite action", () => {
    expect(actionFiles).not.toHaveLength(0);
  });

  it.each([...workflowFiles, ...actionFiles])("%s", (file) => {
    expect(misplaced(parse(fs.readFileSync(file, "utf8")), "")).toEqual([]);
  });

  it("would catch one in a step's env", () => {
    expect(misplaced({ steps: [{ if: "cancelled()", env: { X: "${{ cancelled() }}" } }] }, "")).toEqual([".steps[0].env.X"]);
  });
});

/**
 * **No checkout an agent runs in leaves a credential behind.** The agent runs
 * unsandboxed in the checkout, and `scrubGitHubTokens` empties only its
 * environment. A checkout that persisted its token — from checkout v6 in a
 * `$RUNNER_TEMP` file `.git/config` includes — handed the agent's own `git`,
 * and anything that could read the file, `AGENT_PAT`, which carries
 * Workflows: write.
 *
 * So every checkout in every runner workflow sets `persist-credentials: false`
 * and is handed no token of its own choosing, and every fetch and push in a job
 * that checks out carries its token on its own command, as a masked header
 * computed in the same step. A push takes the push token from its step's `env:`
 * and a fetch the job's read token, so no fetch holds the PAT, and neither
 * does the job's `env:` or the agent's step.
 *
 * Over every checkout rather than the code-writing ones, since the rule costs
 * nothing where nothing is pushed and the review job's token is worth keeping
 * from its agent too. The job list is pinned so a new checkout arrives here
 * with a decision, not past a filter that has gone empty.
 */
describe("no checkout an agent runs in leaves a credential behind", () => {
  /** The loop's token, which every workflow that pushes resolves (#319, #320). */
  const PUSH_TOKEN = "${{ steps.token.outputs.token }}";
  const isCheckout = (s: Step): boolean => (s.uses ?? "").startsWith("actions/checkout@");
  const NETWORK = /\bgit\s+(?:-c\s+"[^"]*"\s+)*(push|fetch|pull|ls-remote|clone)\b/;
  const HEADER = /\bgit -c "http\.extraHeader=AUTHORIZATION: basic \$\{([a-z_]+)\}" (push|fetch|ls-remote) /;

  const checkingOut = runnerWorkflows.flatMap((file) =>
    Object.entries(workflowOf(file).jobs)
      .filter(([, job]) => (job.steps ?? []).some(isCheckout))
      .map(([id, job]) => ({ file, id, job })),
  );
  const label = ({ file, id }: { file: string; id: string }): string => `${path.basename(file)} / ${id}`;
  /** Every line of a step's script that is not a shell comment. */
  const codeOf = (s: Step): string[] => (s.run ?? "").split("\n").filter((l) => !l.trimStart().startsWith("#"));

  it("is every job that checks something out", () => {
    expect(checkingOut.map(label).sort()).toEqual([
      "fix.yml / fix",
      "fix.yml / publish",
      "implement-prd.yml / catch_up",
      "implement-prd.yml / implement-prd",
      "implement-prd.yml / publish",
      "implement.yml / implement",
      "implement.yml / publish",
      "review.yml / red-check",
      "review.yml / review",
      "update-branch.yml / gate",
      "update-branch.yml / publish",
      "update-branch.yml / update-branch",
    ]);
  });

  it.each(checkingOut.map((j) => [label(j), j] as const))("%s: persists no credential and hands checkout no token", (_, { job }) => {
    const checkouts = (job.steps ?? []).filter(isCheckout);

    expect(checkouts).not.toHaveLength(0);
    for (const step of checkouts) {
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(step.with?.["token"]).toBeUndefined();
    }
  });

  it.each(checkingOut.map((j) => [label(j), j] as const))("%s: authenticates each fetch and push on its own command", (_, { file, job }) => {
    for (const step of job.steps ?? []) {
      const run = step.run ?? "";
      for (const line of codeOf(step).filter((l) => NETWORK.test(l))) {
        const [, auth, verb] = HEADER.exec(line) ?? [];
        expect(auth, `${step.name}: ${line.trim()}`).toBeDefined();

        // A push spends the push token from its own step's env; a fetch the
        // job's read token, which is never the PAT.
        const source = verb === "push" ? "PUSH_TOKEN" : "GH_TOKEN";
        expect(run).toContain(`${auth}=$(printf 'x-access-token:%s' "$${source}" | base64 | tr -d '\\n')`);
        expect(run).toContain(`echo "::add-mask::\${${auth}}"`);
        if (verb === "push") expect(step.env?.["PUSH_TOKEN"], step.name).toBe(PUSH_TOKEN);
        else expect(job.env?.["GH_TOKEN"]).toBe("${{ secrets.GITHUB_TOKEN }}");
      }
    }
  });

  /**
   * The PAT is never in the job's own `env:`, and above all not in the step
   * that runs the agent. That step's `NODE_AUTH_TOKEN` is the job token, for
   * the install, and the runner removes it before the agent starts
   * (`scrubGitHubTokens`). A step whose env names `PUSH_TOKEN` must push with
   * it.
   *
   * That is all this asserts. Since the split (#307, #308) no job that runs an
   * agent names the PAT at all, which *a split run keeps every write off the
   * agent's runner* asserts; the steps that hold it are in the publish jobs,
   * and in implement-prd's catch-up, whose `Merge the default branch into the
   * PRD branch` pushes before the agent's job starts, on a runner of its own.
   */
  it.each(checkingOut.map((j) => [label(j), j] as const))("%s: keeps the PAT out of the job's env and the agent's step", (_, { job }) => {
    expect(JSON.stringify(job.env ?? {})).not.toContain("AGENT_PAT");
    for (const step of job.steps ?? []) {
      if (step.env?.["PUSH_TOKEN"] !== undefined) {
        expect(codeOf(step).some((l) => HEADER.exec(l)?.[2] === "push"), step.name).toBe(true);
      }
      if ((step.run ?? "").includes("agent-workflows ")) {
        expect(JSON.stringify(step.env ?? {}), step.name).not.toMatch(/AGENT_PAT|PUSH_TOKEN/);
      }
    }
  });

  /**
   * Moving the token changed how each push authenticates and nothing about what
   * it pushes: implement's new branch is forced, fix's and update-branch's
   * pushes keep the lease on the head the run started from, and the PRD
   * branch's stay plain (asserted with the chain, above).
   */
  it.each([
    [IMPLEMENT, 'push --force origin "$BRANCH"'],
    [
      path.join(WORKFLOW_DIR, "fix.yml"),
      'push --force-with-lease="refs/heads/$BRANCH:$BRANCH_HEAD_SHA" origin "$BRANCH"',
      // The rescue (#303), to a side branch and never the pull request's.
      'push --force-with-lease="refs/heads/${RESCUE_BRANCH}:${current}" origin "${tip}:refs/heads/${RESCUE_BRANCH}"',
    ],
    [path.join(WORKFLOW_DIR, "update-branch.yml"), 'push --force-with-lease="refs/heads/$BRANCH:$BRANCH_HEAD_SHA" origin "$BRANCH"'],
  ])("%s: pushes with the same force as before", (file, ...push) => {
    const pushes = stepsOf(file).flatMap((s) => codeOf(s).filter((l) => HEADER.exec(l)?.[2] === "push"));

    expect(pushes.map((l) => l.trim().replace(HEADER, "$2 "))).toEqual(push);
  });
});

/**
 * **No job that runs an agent names a secret that writes** (#307, #316). The
 * agent runs with `sudo` and can read its runner's memory, which holds every
 * secret the job names from its first step, a step whose `if:` is false
 * included. So the only secrets such a job may name are the agent's own token
 * and the job token, whose reach its `permissions:` decide. Whatever else a run
 * needs to know about a secret, such as whether it is set, it learns from a
 * job no agent runs in.
 *
 * Every reusable workflow, and every job in it that runs a runner which starts
 * an agent, read off the runner's source: a new workflow is covered the
 * moment its job runs one.
 */
describe("no job that runs an agent names a secret that writes", () => {
  const AGENT_COMMANDS = RUNNER_COMMANDS.filter((c) =>
    fs.readFileSync(path.join(c, `${c}.ts`), "utf8").includes('from "@ai-hero/sandcastle"'),
  );
  const reusables = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") && workflowOf(path.join(WORKFLOW_DIR, f)).on?.workflow_call !== undefined)
    .sort();
  const agentJobs = reusables.flatMap((f) => {
    const file = path.join(WORKFLOW_DIR, f);
    return Object.entries(workflowOf(file).jobs)
      .filter(([, job]) =>
        (job.steps ?? []).some((s) => AGENT_COMMANDS.some((c) => new RegExp(`-- agent-workflows ${c}\\s*$`).test(s.run ?? ""))),
      )
      .map(([id, job]) => [`${f} ${id}`, job] as const);
  });

  it("finds the job of every runner that starts an agent", () => {
    expect(agentJobs.map(([label]) => label).sort()).toEqual(
      ["fix.yml fix", "implement-prd.yml implement-prd", "implement.yml implement", "review.yml review", "update-branch.yml update-branch"],
    );
  });

  /**
   * Every reference to the `secrets` context in an expression that is not one
   * of the two allowed names, read fail-closed: a name outside the list, an
   * index, and the whole context (`toJSON(secrets)`, which delivers every
   * secret at once) are all refused, rather than each spelling being looked
   * for. Case-blind, as GitHub's expressions are.
   */
  const forbidden = (job: unknown): string[] =>
    [...JSON.stringify(job).matchAll(/\$\{\{.*?\}\}/g)]
      .map((m) => m[0])
      .filter((e) => /(?<![\w.-])secrets(?![\w-])(?!\.(?:CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN)(?![\w-]))/i.test(e));

  it.each([
    ["a name outside the list", "${{ secrets.AGENT_PAT }}"],
    ["a comparison against one", "${{ secrets.AGENT_PAT != '' }}"],
    ["the whole context", "${{ toJSON(secrets) }}"],
    ["an index", "${{ secrets['AGENT_PAT'] }}"],
    ["an index by an allowed name", "${{ secrets['GITHUB_TOKEN'] }}"],
    ["another case", "${{ SECRETS.agent_pat }}"],
    ["a name an allowed one prefixes", "${{ secrets.GITHUB_TOKEN_2 }}"],
    ["a second reference beside an allowed one", "${{ secrets.GITHUB_TOKEN || secrets.AGENT_PAT }}"],
  ])("refuses %s", (_, expression) => {
    expect(forbidden({ env: { X: expression } })).toEqual([expression]);
  });

  it.each([
    ["the agent's token", "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"],
    ["the job token, in another case", "${{ Secrets.github_token }}"],
    ["a property merely named for it", "${{ needs.time-limit.outputs.secrets }}"],
  ])("allows %s", (_, expression) => {
    expect(forbidden({ env: { X: expression } })).toEqual([]);
  });

  it.each(agentJobs)("%s: names no secret but the agent's token and the job token", (_, job) => {
    expect(forbidden(job)).toEqual([]);
  });

  /**
   * Named outright, beside the rule above that already refuses them: the
   * App's two secrets, the PAT, and the resolver that would be handed them
   * (#320). Not even in a step that never runs.
   */
  it.each(agentJobs)("%s: names neither the App's secrets nor the PAT, nor resolves a token", (_, job) => {
    const expressions = [...JSON.stringify(job).matchAll(/\$\{\{.*?\}\}/g)].map((m) => m[0]);

    expect(expressions.filter((e) => /AGENT_PAT|AGENT_APP_ID|AGENT_APP_PRIVATE_KEY/i.test(e))).toEqual([]);
    expect(JSON.stringify(job)).not.toContain("/actions/loop-token@");
  });
});

describe("every agent run keeps its session transcript, redacted, for a few days", () => {
  /**
   * The runners that start an agent, read off their source rather than listed:
   * a sixth that calls sandcastle is in the set the moment it imports it. The
   * list below it is what the derivation must find, so an empty one cannot
   * pass by asserting over nothing.
   */
  const AGENT_COMMANDS = RUNNER_COMMANDS.filter((c) =>
    fs.readFileSync(path.join(c, `${c}.ts`), "utf8").includes('from "@ai-hero/sandcastle"'),
  );
  /** Each workflow's step that runs the agent. */
  const AGENT_STEPS: Readonly<Record<string, string>> = {
    fix: "Run fix agent",
    implement: "Run implementation agent",
    "implement-prd": "Run implementation agent",
    review: "Run review agent",
    "update-branch": "Resolve conflicts",
  };
  const REDACT = "Redact the session transcript";
  const UPLOAD = "Upload the session transcript";
  const fileOf = (command: string): string => path.join(WORKFLOW_DIR, `${command}.yml`);
  const stepNamed = (command: string, name: string): Step => {
    const step = stepsOf(fileOf(command)).find((s) => s.name === name);

    expect(step, `${command} has no \`${name}\` step`).toBeDefined();
    return step as Step;
  };

  it("covers every runner that starts an agent", () => {
    expect([...AGENT_COMMANDS].sort()).toEqual(Object.keys(AGENT_STEPS).sort());
  });

  it.each(Object.keys(AGENT_STEPS))("%s: declares the retention input, a few days by default", (command) => {
    const input = workflowOf(fileOf(command)).on?.workflow_call?.inputs?.["transcript-retention-days"];

    expect(input?.type).toBe("number");
    expect(input?.default).toBe(3);
    expect(input?.required).toBeUndefined();
    expect(input?.description).toMatch(/0 turns the upload off/);
  });

  it.each(Object.keys(AGENT_STEPS))("%s: redacts the transcript right after the agent, however it ended", (command) => {
    const names = stepsOf(fileOf(command)).map((s) => s.name);
    const redact = stepNamed(command, REDACT);

    expect(names.indexOf(REDACT)).toBe(names.indexOf(AGENT_STEPS[command]) + 1);
    expect(redact.id).toBe("transcript");
    expect(redact.if).toBe("always() && inputs.transcript-retention-days > 0");
    // The record never fails the run it records.
    expect(redact["continue-on-error"]).toBe(true);
    // Every secret the job holds, so the step can take each one out, and not
    // the PAT, which no agent's job holds (#307, #316): naming it here to
    // redact it would deliver it to the job that must not have it.
    expect(redact.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
      GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    });
    expect(JSON.stringify(redact)).not.toContain("AGENT_PAT");
    // Found under the home directory, never under a path the checkout decides.
    expect(redact.run ?? "").toContain('".claude" / "projects"');
    expect(redact.run ?? "").not.toMatch(/GITHUB_WORKSPACE|\/home\/runner/);
    // One step, word for word, in every workflow that runs an agent.
    expect(redact.run).toBe(stepNamed("implement", REDACT).run);
  });

  it.each(Object.keys(AGENT_STEPS))("%s: uploads only what the redaction wrote, kept as long as the input says", (command) => {
    const names = stepsOf(fileOf(command)).map((s) => s.name);
    const upload = stepNamed(command, UPLOAD);

    expect(names.indexOf(UPLOAD)).toBe(names.indexOf(REDACT) + 1);
    // `always()`, so a failed, cancelled or timed-out run uploads too; and only
    // after a redaction that finished, so a half-written copy is never sent.
    expect(upload.if).toBe("always() && steps.transcript.outcome == 'success'");
    expect(upload["continue-on-error"]).toBe(true);
    expect(upload.uses).toBe("actions/upload-artifact@v7");
    expect(upload.with).toEqual({
      name: "agent-transcript",
      path: "${{ runner.temp }}/agent-transcript",
      "if-no-files-found": "ignore",
      "retention-days": "${{ inputs.transcript-retention-days }}",
      overwrite: true,
    });
  });

  it("starts no upload where no agent runs", () => {
    const follow = workflowOf(FOLLOW_UPS);

    expect(follow.on?.workflow_call?.inputs?.["transcript-retention-days"]).toBeUndefined();
    expect(stepsOf(FOLLOW_UPS).map((s) => s.name)).not.toContain(UPLOAD);
  });

  it("says in the adoption doc what is kept, who can read it and how to turn it off", () => {
    const doc = fs.readFileSync(path.join("docs", "ADOPTING.md"), "utf8");

    expect(doc).toContain("`agent-transcript`");
    expect(doc).toContain("transcript-retention-days: 0");
    expect(doc).toMatch(/\[REDACTED\]/);
    expect(doc).toMatch(/public repository/);
  });
});

/**
 * Rescue and resume (#303). A fix or implement-prd run that stops before it
 * finishes keeps the commits it made on a side branch with a fixed name, the
 * failure comment names it, and the next run of the label resumes from it.
 * What is asserted here is the shape that keeps a rescue from being anything
 * else: it runs only on a stopped run the preflight claimed, before the
 * failure comment that names it, with a lease, and it opens no pull request,
 * asks for no review and moves no label. `tests/rescue-step.test.ts` executes
 * the steps themselves.
 */
describe("rescue and resume for fix and implement-prd", () => {
  const CASES = [
    {
      file: path.join(WORKFLOW_DIR, "fix.yml"),
      agent: "fix",
      rescue: "agent/rescue/fix-${{ github.event.pull_request.number }}",
      prepare: "Prepare branch and make the PR base available for diffing",
      condition:
        "always() && needs.gate.outputs.refused == 'false' && (cancelled() || failure() || needs.fix.result == 'failure' || needs.fix.result == 'cancelled') && steps.push.outputs.pushed != 'true'",
      // Not on a nothing-to-do run, which exits before it reads the rescue.
      deleteIf: "needs.fix.result == 'success' && success() && steps.nothing.outputs.nothing != 'true'",
      label: "agent:fix",
    },
    {
      file: PRD,
      agent: "implement-prd",
      rescue: "agent/rescue/prd-${{ github.event.issue.number }}",
      prepare: "Prepare the PRD branch",
      condition:
        "always() && needs.gate.outputs.refused == 'false' && needs.gate.outputs.build == 'true' && (cancelled() || failure() || needs.implement-prd.result == 'failure' || needs.implement-prd.result == 'cancelled') && steps.push.outputs.head == ''",
      deleteIf: "needs.implement-prd.result == 'success' && success()",
      label: "agent:implement",
    },
  ] as const;
  const named = (steps: readonly Step[], name: string): number => {
    const at = steps.findIndex((s) => s.name === name);
    expect(at, name).toBeGreaterThan(-1);
    return at;
  };
  /** Every line of a step's script that is not a shell comment. */
  const code = (step: Step | undefined): string =>
    (step?.run ?? "").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

  it.each(CASES)("$agent: names one rescue branch in the job that resumes and the job that rescues", (c) => {
    expect(jobNamed(c.file, c.agent).env?.["RESCUE_BRANCH"]).toBe(c.rescue);
    expect(jobNamed(c.file, "publish").env?.["RESCUE_BRANCH"]).toBe(c.rescue);
  });

  it.each(CASES)("$agent: rescues only a stopped run the preflight claimed, before the failure comment", (c) => {
    const steps = jobNamed(c.file, "publish").steps ?? [];
    const at = named(steps, "Rescue the agent's commits");
    const step = steps[at];

    expect(step?.id).toBe("rescue");
    expect(step?.if).toBe(c.condition);
    // A rescue that cannot be made must not cost the run its failure comment.
    expect(step?.["continue-on-error"]).toBe(true);
    expect(at).toBeLessThan(named(steps, "Mark blocked on failure"));
    expect(steps.find((s) => s.name === "Mark blocked on failure")?.env?.["RESCUED"]).toBe("${{ steps.rescue.outputs.branch }}");
  });

  it.each(CASES)("$agent: pushes the rescue with a lease, to the rescue branch alone", (c) => {
    const run = code((jobNamed(c.file, "publish").steps ?? []).find((s) => s.id === "rescue"));
    const pushes = run.split("\n").filter((l) => /\bgit\b.*\bpush\b/.test(l));

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('push --force-with-lease="refs/heads/${RESCUE_BRANCH}:${current}" origin "${tip}:refs/heads/${RESCUE_BRANCH}"');
    expect(run).toContain('git bundle verify --quiet "$bundle"');
    expect(run).toContain('echo "branch=${RESCUE_BRANCH}" >> "$GITHUB_OUTPUT"');
  });

  it.each(CASES)("$agent: opens no pull request, asks for no review and moves no label in the rescue", (c) => {
    const run = code((jobNamed(c.file, "publish").steps ?? []).find((s) => s.id === "rescue"));

    expect(run).not.toContain("gh pr create");
    expect(run).not.toContain("agent:review");
    expect(run).not.toMatch(/\bgh\b/);
    expect(run).not.toMatch(/--(add|remove)-label/);
  });

  it.each(CASES)("$agent: hands a stopped run's commits over, and fetches the rescue where the runner looks", (c) => {
    const steps = jobNamed(c.file, c.agent).steps ?? [];
    const upload = steps.find((s) => s.name === "Hand the branch to the publish job");

    expect(steps.find((s) => s.name === "Bundle the branch")?.if).toBe("always()");
    expect(upload?.with?.["path"]).toContain("${{ runner.temp }}/rescue_ignored.md");
    expect(code(steps[named(steps, c.prepare)])).toContain(`"+refs/heads/\${RESCUE_BRANCH}:${rescueRef("${RESCUE_BRANCH}")}"`);
  });

  it.each(CASES)("$agent: deletes the rescue branch once a run succeeds, after its push", (c) => {
    const steps = jobNamed(c.file, "publish").steps ?? [];
    const at = named(steps, "Delete the rescue branch");
    const run = code(steps[at]);

    expect(steps[at]?.if).toBe(c.deleteIf);
    expect(at).toBeGreaterThan(steps.findIndex((s) => s.id === "push"));
    expect(run).toContain('gh api --method DELETE "repos/{owner}/{repo}/git/refs/heads/${RESCUE_BRANCH}"');
  });

  it.each(CASES)("$agent: says so where it set a rescue aside, however the run ends", (c) => {
    const step = (jobNamed(c.file, "publish").steps ?? []).find((s) => s.name === "Say the rescue was set aside");

    expect(step?.if).toBe("always()");
    expect(code(step)).toContain('note="${RUNNER_TEMP}/rescue_ignored.md"');
  });
});
