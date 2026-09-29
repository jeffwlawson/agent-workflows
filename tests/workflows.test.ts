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
  deriveVerdict,
  FOLLOW_UPS_LABEL,
  renderReviewBody,
  type Verdict,
  VERDICT_CONTEXT,
  VERDICTS,
} from "../shared/review-output.js";

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
 * *inverted* closed-PR guard, no checkout, no in-progress labelling — and two
 * of those assert that a checkout step and an in-progress step *exist*, which
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
  "agent-implement.yml",
  "implement.yml",
  // Same, plus it closes each sub-issue it finishes and re-labels the parent to
  // chain the next one. Note what it still cannot do: create an issue. Closing
  // one the PRD already lists is not filing work, so "an agent that raises work
  // never files it" (docs/parity.md §10) is untouched.
  "agent-implement-prd.yml",
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
  // and no `issues:` scope. And **the workflow holding the permission runs no
  // model** — this pair installs no Claude Code and invokes a runner whose
  // judgement is a pure function, which is also what keeps reading arbitrary
  // issue bodies with `issues: write` from being a prompt-injection surface.
  "agent-follow-ups.yml",
  "follow-ups.yml",
]);

const issuesWriteChecked = workflowFiles.filter(
  (f) => !ISSUES_WRITE_EXEMPT.has(path.basename(f)),
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
  readonly "timeout-minutes"?: number;
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
 * `TRIGGER_TYPES`. A second job in a reusable workflow is a second set of
 * permissions under the caller's grant, and it should arrive with an entry here
 * that says so, not slip past a check that picks "the" job.
 *
 * Empty for every caller. A caller is a trigger and one `uses:`.
 */
const EXTRA_JOBS: Readonly<Record<string, readonly string[]>> = {
  /**
   * The thread resolve (#133). `resolveReviewThread` wants `contents: write`,
   * which the review job must not hold (docs/parity.md §10), so it runs in a
   * job of its own with no checkout and no agent.
   *
   * …and the automatic fix (#102), which is the only place this workflow adds
   * a trigger label and the only place it spends `AGENT_PAT`. Both are kept
   * out of the job that reads untrusted pull-request content and runs a model,
   * which is why it is a job rather than a step.
   *
   * …and the PRD chain's advance (#176), in `review` and in `fix` alike: it
   * spends `AGENT_PAT` on the parent issue when a slice PR's round ends, and is
   * kept out of the job that runs a model for the same reason.
   */
  [path.join(WORKFLOW_DIR, "review.yml")]: ["resolve", "auto-fix", "advance"],
  [path.join(WORKFLOW_DIR, "fix.yml")]: ["advance"],
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

const stepsOf = (file: string): readonly Step[] => jobOf(file).steps ?? [];

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
const agentWorkflows = (): readonly string[] => [...callerWorkflows, ...runnerWorkflows];
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
const callersIn = (dir: string, prefix = ""): readonly string[] =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") && f.startsWith(prefix))
    .map((f) => path.join(dir, f));
const callerWorkflows = [...callersIn(CALLER_DIR), ...callersIn(WORKFLOW_DIR, "agent-")];

/** The runner half a caller hands over to. */
const targetOf = (file: string): string =>
  (jobOf(file).uses ?? "").replace(/^[^/]+\/[^/]+\//, "").replace(/@.*$/, "");

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
const wiredCallers = (): readonly string[] =>
  callerWorkflows.filter((file) => !MERGE_GATED.includes(targetOf(file)));

/**
 * What each caller's trigger fires on, keyed by filename (#46). Everything
 * absent takes `TRIGGER_TYPES_DEFAULT` — which today is every caller there is,
 * so the map is empty and the default is exactly the assertion it replaces.
 *
 * It exists ahead of the first entry on purpose. The assertion below ran over
 * every caller with no list at all, which reads as *derived* — the good kind of
 * check in this file — but it was carrying an undeclared premise: that every
 * caller in the loop is label-triggered. The first one that legitimately needs
 * a second event type turns that assertion red with no hint that the premise is
 * what moved, and the cheapest way out of a red derived check is to weaken it.
 * A list announces itself when you add an entry; the entry is where the reason
 * goes.
 *
 * Exact equality survives, per file: `pull_request_target` reaching a job that
 * holds write is a security surface, so a caller must not be able to widen its
 * own trigger. The exception is declared here rather than dissolved into a
 * subset check, which would let *any* caller grow *any* extra type unnoticed.
 */
const TRIGGER_TYPES_DEFAULT: readonly string[] = ["labeled"];
const TRIGGER_TYPES: Readonly<Record<string, readonly string[]>> = {
  /**
   * The filing pair, in both caller sets (#50). `closed` is what the feature is
   * *for* — findings become issues when the pull request merges — and it is
   * **not** a default `pull_request_target` activity type, so a caller that
   * listed only `labeled` would file nothing on a merge and read exactly like
   * one that did. `labeled` is the manual entry point on an already-closed pull
   * request: a missed close event, a reconsidered opt-out, a partial failure.
   */
  "agent-follow-ups.yml": ["closed", "labeled"],
  "follow-ups.yml": ["closed", "labeled"],
};
const triggerTypesOf = (file: string): readonly string[] =>
  TRIGGER_TYPES[path.basename(file)] ?? TRIGGER_TYPES_DEFAULT;

/**
 * The review job — the reusable half, where every step now lives
 * (jeffwlawson/winget-manifest-lint#97).
 */
const REVIEW = path.join(WORKFLOW_DIR, "review.yml");
/** …and the caller that triggers it. */
const REVIEW_CALLER = path.join(CALLER_DIR, "review.yml");

/**
 * The two workflows that share the `agent:implement` label
 * (jeffwlawson/winget-manifest-lint#92), again named by the half that holds the
 * steps (jeffwlawson/winget-manifest-lint#98).
 */
const IMPLEMENT = path.join(WORKFLOW_DIR, "implement.yml");
const PRD = path.join(WORKFLOW_DIR, "implement-prd.yml");
/** …and their callers, which is where the trigger and the label guard are read. */
const IMPLEMENT_CALLER = path.join(CALLER_DIR, "implement.yml");
const PRD_CALLER = path.join(CALLER_DIR, "implement-prd.yml");

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

  it.each(PR_WORKFLOWS)("%s: is in the per-PR group, first-come", (file) => {
    const { concurrency } = jobOf(file);

    expect(concurrency?.group).toBe(PR_GROUP);
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
    // Every called job, not just the first: `review / resolve` is a check run
    // on the pull request too (#133).
    const checkRuns = [
      ...new Set(
        callerWorkflows.flatMap((file) =>
          Object.keys(workflowOf(targetOf(file)).jobs).map(
            (called) => `${Object.keys(workflowOf(file).jobs)[0]} / ${called}`,
          ),
        ),
      ),
    ];

    expect(checkRuns).toHaveLength(10);
    expect(checkRuns).toContain("review / resolve");
    // …and the third (#102), on the same footing: it runs after this wait, and
    // it is not evidence about the diff whenever it does.
    expect(checkRuns).toContain("review / auto-fix");
    // …and the fourth (#176), in both workflows whose round can end a slice's.
    expect(checkRuns).toContain("review / advance");
    expect(checkRuns).toContain("fix / advance");
    for (const name of checkRuns) expect(name).toMatch(excluded);
    // And under a caller job an adopter renamed, where only the second half is
    // ours to know.
    expect("agent-review / resolve").toMatch(excluded);
    // `auto-fix` is in the pattern in its own right: `fix` does not match it,
    // because the alternation is anchored on `/ ` and the name begins `auto-`.
    expect("agent-review / auto-fix").toMatch(excluded);
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
   * `Corpus`, so the prefix is the whole test.
   */
  it("agent-review tails no agent workflow's failure log", () => {
    const run = waitStep().run ?? "";

    expect(run).toContain('case "$rname" in "Agent "*)');
    expect(run).not.toContain('[ "$rname" = "Agent Review" ]');
  });

  /**
   * The listing that feeds that tail needs `actions: read`, which the loop
   * deliberately does not request: run logs can carry an echoed secret, and a
   * log tail is not worth the scope (#80). So on a private repository the
   * listing is refused, and fed straight to `for` that was silent. It is gated
   * on gh's exit status instead, and a failure says in the evidence that the
   * tail is missing — naming the likely cause, never a remedy. Behaviour is
   * `tests/review-ci-wait.test.ts`'s; this pins the shape and the ceiling.
   */
  it("agent-review says so when it cannot list the runs to tail", () => {
    const run = waitStep().run ?? "";

    expect(run).toContain('if ! failed_runs=$(gh api "repos/${GH_REPO}/actions/runs?');
    expect(run).toContain("for rid in $failed_runs; do");
    expect(run).not.toMatch(/for rid in \$\(gh api/);
    expect(run).toMatch(/Could not list this commit's workflow runs[^\n]*actions: read[^\n]*>> "\$out"/);
    // No grant: the reusable half's ceiling stays without the scope.
    expect(jobOf(REVIEW).permissions).not.toHaveProperty("actions");
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

    expect(groups).toEqual([PR_GROUP]);
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

  it.each(PR_WORKFLOWS)("%s: the guard is the first step and is itself ungated", (file) => {
    const first = stepsOf(file)[0];

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
    for (const step of checkout) expect(step.if ?? "").toContain(PROCEED);
  });

  it.each(PR_WORKFLOWS)("%s: the run never enters agent:in-progress", (file) => {
    const labelling = stepsOf(file).filter((s) => (s.run ?? "").includes('--add-label "agent:in-progress"'));

    expect(labelling).not.toHaveLength(0);
    for (const step of labelling) expect(step.if ?? "").toContain(PROCEED);
  });
});

/**
 * The refusal the shared group made necessary. Review pins everything to the
 * head SHA in its `labeled` payload — the checkout, and `commitOID` on the
 * posted review — and that payload is snapshotted at label time, so a review
 * queued behind a fix starts once the fix has pushed and still reviews the
 * pre-fix commit. Serialising turned reading-during-a-write into
 * reading-after-one; it did not remove the race. The mutates catch their
 * version at push time via `--force-with-lease` on the same SHA, review
 * publishes instead of failing, so it has to check up front.
 */
describe("agent-review refuses a head that moved while it was queued", () => {
  it("compares the payload SHA against the live head, in the guard", () => {
    const guard = stepsOf(REVIEW)[0];
    const run = guard?.run ?? "";

    expect(guard?.env?.["HEAD_SHA"]).toBe("${{ github.event.pull_request.head.sha }}");
    expect(run).toContain("--json headRefOid");
    expect(run).toContain('"$current" != "$HEAD_SHA"');
    // Distinct from the not-open refusal: same step, two states, and a human
    // reading only the comment has to be able to tell them apart.
    expect(run).toContain("this PR is not open");
    expect(run).toContain("moved while this run was queued");
  });

  /**
   * An unreadable `gh pr view` must not refuse — an API blip is not evidence
   * the branch moved — so the comparison is guarded on a non-empty answer.
   */
  it("proceeds when the live head cannot be read", () => {
    expect(stepsOf(REVIEW)[0]?.run ?? "").toContain('[ -n "$current" ]');
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
  const guard = (): Step | undefined => stepsOf(FIX)[0];
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

  it("says why, as a warning and as one comment naming both SHAs and the way out", () => {
    const arm = run().slice(run().indexOf('[ "$live" != "$BRANCH_HEAD_SHA" ]'));
    const stale = arm.slice(0, arm.indexOf("exit 0"));

    expect(stale).toContain("::warning::");
    expect(stale.match(/refuse "/g)).toHaveLength(1);
    expect(stale).toContain("\\`${BRANCH_HEAD_SHA}\\`");
    expect(stale).toContain("\\`${live}\\`");
    expect(stale).toContain("close and reopen the PR");
    expect(stale).toContain("re-add \\`agent:fix\\`");
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
    for (const arm of ["if ! remote=$(git", 'if [ -z "$live" ]; then']) {
      const body = run().slice(run().indexOf(arm));
      expect(body.slice(0, body.indexOf("exit 0"))).toMatch(/refuse ".*" blocked/);
    }
    expect(fs.readFileSync(FIX, "utf8")).toContain("**An unreadable head refuses, deliberately**");
  });

  /** And the proceed line is reached only past every refusal. */
  it("proceeds only after the head is confirmed", () => {
    expect(run().lastIndexOf('echo "proceed=true"')).toBeGreaterThan(run().indexOf('[ "$live" != "$BRANCH_HEAD_SHA" ]'));
    expect(run().match(/proceed=true/g)).toHaveLength(1);
  });
});

/**
 * A slice PR is the ordinary `review` round on one slice of a PRD (#175). Two
 * things change for it and nothing else does: the reviewer is told which slice
 * of which PRD it reads, and a slice PR no CI ran on is not green. The second
 * is executed in `tests/review-ci-wait.test.ts`; what is held here is that both
 * halves recognise a slice PR by the one prefix `implement-prd` names its
 * branches with, and that the doc the evidence line points at says the fix.
 */
describe("agent-review knows when it is reading a slice PR", () => {
  const RUNNER = "review/review.ts";
  const PROMPT = "review/prompt.md";
  const waitStep = (): Step | undefined =>
    stepsOf(REVIEW).find((s) => (s.name ?? "").startsWith("Wait for other checks"));

  it("recognises a slice branch by the prefix implement-prd names it with", () => {
    expect(fs.readFileSync(PRD, "utf8")).toContain('slice="agent/slice-${ISSUE_NUMBER}-${SUB}-${slug}"');
    expect(fs.readFileSync(RUNNER, "utf8")).toContain("/^agent\\/slice-(\\d+)-(\\d+)-/");
    expect(waitStep()?.run ?? "").toContain("agent/slice-*)");
  });

  it("gives the reviewer the slice, its PRD, and the earlier slices as settled context", () => {
    const runner = fs.readFileSync(RUNNER, "utf8");

    expect(fs.readFileSync(PROMPT, "utf8")).toContain("{{PULL_REQUEST_KIND}}");
    expect(runner).toMatch(/PULL_REQUEST_KIND: pullRequestKind\(/);
    expect(runner).toContain("settled context");
    expect(runner).toContain("three-dot diff");
    // The slice PR's body says `Part of`, which links nothing, so the sub-issue
    // is handed to the context fetch as the linked issue in its place.
    expect(runner).toMatch(/fetchPullRequestContext\(PR_NUMBER, slice\?\.subIssue\)/);
  });

  it("points the no-CI evidence at the adoption doc, which carries the branches: line", () => {
    const run = waitStep()?.run ?? "";
    const doc = fs.readFileSync("docs/ADOPTING.md", "utf8");
    const section5 = doc.split(/^(?=## )/m).find((s) => s.startsWith("## 5.")) ?? "";

    expect(run).toContain("No CI ran on this slice PR");
    expect(run).toContain("docs/ADOPTING.md §5, *Slice PRs and your CI*");
    expect(section5).toContain("### Slice PRs and your CI");
    expect(section5).toMatch(/branches: \[main, 'agent\/prd-\*\*'\]/);
  });
});

/**
 * A PRD PR's review is the chain's **integration review** (#179). The finishing
 * run asks for it only when the chain holds more than one slice, and it looks
 * only at what spans slices — except the two things no slice round saw, which
 * it is handed by name and reviews in full. What is held here is that it is
 * recognised by the PRD branch's prefix and no other, that it is handed the
 * slice PRs, the pre-upgrade slices and the agent-resolved merges, and that
 * the brief limits its scope. The brief's wording is the prompt rule's to
 * police (no domain); these pin the instructions a reader would miss.
 */
describe("agent-review gives a PRD PR an integration review", () => {
  const RUNNER = "review/review.ts";
  const CONTEXT = "shared/prd-context.ts";
  const runner = (): string => fs.readFileSync(RUNNER, "utf8");

  it("recognises a PRD PR by the prefix implement-prd names its branch with, and nothing else", () => {
    const prefix = /^agent\/prd-(\d+)-/;

    expect(fs.readFileSync(PRD, "utf8")).toContain('name="agent/prd-${ISSUE_NUMBER}-${slug}"');
    expect(runner()).toContain("/^agent\\/prd-(\\d+)-/");
    // Ordinary pull requests and slice PRs get no integration-review context.
    expect(prefix.test("agent/slice-171-179-integration-review")).toBe(false);
    expect(prefix.test("agent/issue-179-integration-review")).toBe(false);
    expect(prefix.test("agent/prd-171-prd-slice-prs")).toBe(true);
    expect(runner()).toMatch(
      /prdParent === undefined \? undefined : fetchPrdContext\(prdParent, BRANCH, BASE_REF, PR_NUMBER\)/,
    );
    expect(runner()).toMatch(/prd !== undefined \? integrationReview\(prd\) : sliceOrOrdinary\(\)/);
  });

  it("reads the chain while the token is still in hand", () => {
    const text = runner();
    expect(text.indexOf("fetchPrdContext(prdParent")).toBeGreaterThan(-1);
    expect(text.indexOf("fetchPrdContext(prdParent")).toBeLessThan(text.indexOf("scrubGitHubTokens();"));
  });

  it("is handed the slice PRs, the pre-upgrade slices and the agent-resolved merges", () => {
    const context = fs.readFileSync(CONTEXT, "utf8");
    const brief = runner();

    // Slice PRs by base, never by name; pre-upgrade slices by the same test the
    // finishing run counts them with.
    expect(context).toMatch(/"--base",\s*prdBranch/);
    expect(context).toMatch(/state === "CLOSED"/);
    expect(context).toContain("subIssues(first: 100)");
    // The marker update-branch writes on a draft PRD PR's conflicted refresh.
    const updateBranch = fs.readFileSync(path.join(WORKFLOW_DIR, "update-branch.yml"), "utf8");
    expect(updateBranch).toContain("<!-- agent-resolved-merge ${RESOLVED_SHA} -->");
    expect(context).toContain("/<!-- agent-resolved-merge ([0-9a-f]{7,40}) -->/g");
    expect(context).toMatch(/isTrustedAuthor\(/);

    expect(brief).toContain("Slice PRs it holds, in merge order");
    expect(brief).toContain("**Slices built before slice PRs**, which had **no review of their own**");
    expect(brief).toContain("**Merge commits whose conflicts an agent resolved**");
    // An unreadable fact is said to be unreadable, never rendered as "none".
    expect(brief).toContain("**could not be read**. Do not assume there are none");
  });

  it("limits scope to cross-slice problems and forbids re-raising slice leftovers", () => {
    const brief = runner();

    expect(brief).toContain("**integration review**");
    expect(brief).toContain("in full");
    expect(brief).toContain("**Everything else, look at only for what spans slices**");
    expect(brief).toContain("**contracts between slices**");
    expect(brief).toContain("**duplication**");
    expect(brief).toContain("**dead scaffolding**");
    expect(brief).toContain("**never re-raise a slice's leftover findings** — not as a finding, not as a follow-up");
    expect(brief).toContain("it means **the slices fit together** — not a roll-up");
  });

  it("needs no new input, so no caller changes", () => {
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
    stepsOf(REVIEW).find((s) => (s.run ?? "").includes("--add-label \"agent:follow-ups\""));

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
    expect(markStep()?.if).toBe("steps.state.outputs.proceed == 'true' && success()");

    const names = stepsOf(REVIEW).map((s) => s.name ?? "");

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
    stepsOf(REVIEW).find((s) => s.name === name);
  const postStep = (): Step | undefined => stepNamed("Post the verdict as a commit status");
  const errorStep = (): Step | undefined => stepNamed("Post an error verdict");

  /**
   * On the SHA the payload named, which is the same one the checkout, the CI
   * wait and the review's own `commitOID` are pinned to — and which the
   * pre-flight above refuses to proceed past if the branch has moved. Reading
   * the live head here instead would post a verdict about a diff nobody read.
   */
  it.each([
    ["the verdict", "Post the verdict as a commit status"],
    ["an error", "Post an error verdict"],
  ])("posts %s on the commit that was reviewed", (_case: string, name: string) => {
    const step = stepNamed(name);

    expect(step?.env?.["HEAD_SHA"]).toBe("${{ github.event.pull_request.head.sha }}");
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
    const names = stepsOf(REVIEW).map((s) => s.name ?? "");

    expect(postStep()?.if).toBe("steps.state.outputs.proceed == 'true' && success()");
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

    expect(step?.if).toBe("steps.state.outputs.proceed == 'true' && failure()");
    expect(step?.run ?? "").toContain("state=error");

    // Below every step it is the arm for, the verdict's own posting included:
    // a `failure()` step covers what precedes it, so one placed beside the
    // success arm would miss the failure that leaves no status at all.
    const names = stepsOf(REVIEW).map((s) => s.name ?? "");

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
 * The one automatic fix (#102, PRD #101 decisions 1–4). Where the verdict is
 * the round-1 *Changes recommended* — the line that already promises an
 * automatic re-review — the review workflow adds `agent:fix` itself, once per
 * pull request, if the adopter asked for it.
 *
 * This is the review → fix leg `docs/parity.md` §10 forbade outright, so every
 * bound on it is asserted here rather than left to read correctly. None has a
 * runtime symptom when it breaks and each fails differently: a job that fires
 * on the wrong verdict spends a fix round on findings a maintainer was supposed
 * to read; one that fires twice is the cycle the invariant exists to prevent;
 * one that never fires is a feature switched on and silently off, under a
 * verdict telling a maintainer a fix round started.
 */
describe("agent-review starts one fix round, where it was asked to", () => {
  const AUTO_FIX_VERDICT = "changes recommended, fix round started";
  const job = (): Job => jobNamed(REVIEW, "auto-fix");
  const startStep = (): Step | undefined =>
    (job().steps ?? []).find((s) => (s.run ?? "").includes('--add-label "agent:fix"'));

  /**
   * The key the job selects on is the one the derivation emits, held to the
   * constant rather than to a string that happens to match today. The three
   * *changes recommended* rows share a heading, a label and a state, so the
   * key is the only field that can tell the one this fires on from the two it
   * must not.
   */
  it("selects on the verdict key only a round-1 derivation can produce", () => {
    expect(VERDICTS[AUTO_FIX_VERDICT].verdict).toBe(AUTO_FIX_VERDICT);
    expect(job().if ?? "").toContain(`needs.review.outputs.verdict == '${AUTO_FIX_VERDICT}'`);
  });

  /**
   * **Off unless an adopter said otherwise** (decision 3). A boolean input
   * defaulting `false`, so an upgrade changes nothing for a repository that has
   * not read enough verdicts to trust them — and restated in the job's own
   * `if:`, where a human looking for "is this on?" looks.
   */
  it("is off by default, and says so in the input and in the guard", () => {
    const input = workflowOf(REVIEW).on?.workflow_call?.inputs?.["auto-fix"];

    expect(input?.type).toBe("boolean");
    expect(input?.default).toBe(false);
    expect(input?.required).toBeUndefined();
    expect(input?.description ?? "").not.toBe("");
    expect(job().if ?? "").toContain("inputs.auto-fix");
  });

  /**
   * **Never on a round 2.** Twice over, and the second is the one that holds:
   * the key above is unreachable from a round-2 derivation (`deriveVerdict`,
   * asserted in `tests/review-output.test.ts`), and the round is restated in
   * the guard so a reader of this file can see the bound without reconstructing
   * it from a string literal.
   *
   * The round comes out of the review job as an output for that restatement and
   * for nothing else, which is why it is asserted as a wire as well as a guard.
   */
  it("cannot fire on the round that followed a fix", () => {
    expect(
      deriveVerdict(
        { findings: [], followUps: [], fixBeforeMerge: ["the guard runs after the return"], verified: [] },
        { ci: "green", round: 2, stillOpen: 0, movedToFollowUps: 0, autoFix: true },
      ).verdict,
      "a round-2 derivation must not be able to produce the key this job fires on",
    ).not.toBe(AUTO_FIX_VERDICT);

    expect(job().if ?? "").toContain("needs.review.outputs.round == '1'");
    expect(jobOf(REVIEW).outputs?.["round"]).toBe("${{ steps.verdict.outputs.round }}");
    expect(jobOf(REVIEW).outputs?.["verdict"]).toBe("${{ steps.verdict.outputs.verdict }}");
  });

  /**
   * **Never twice on one pull request.** The round rule bounds a chain; this
   * bounds the pull request, which is the different thing PRD #101 decision 1
   * asks for: a human's own commits make a later review a fresh round 1, and
   * without the marker each of those could start another fix round.
   *
   * Read off the `labeled` payload, which is the same snapshot the review job
   * hands the runner — so the sentence the verdict posts and the job that makes
   * it true cannot disagree about a label added in between.
   */
  it("spends the fix once, against a label on the pull request", () => {
    expect(job().if ?? "").toContain(
      "!contains(github.event.pull_request.labels.*.name, 'agent:auto-fixed')",
    );
    expect(stepsOf(REVIEW).find((s) => (s.name ?? "") === "Run review agent")?.env?.["AUTO_FIXED"]).toBe(
      "${{ contains(github.event.pull_request.labels.*.name, 'agent:auto-fixed') }}",
    );
  });

  /**
   * …and the marker goes on **first**. A failure between the two adds costs
   * this pull request its automatic fix and nothing else; the other order
   * leaves a fix round running with nothing recording it, and the next round-1
   * verdict starts another.
   */
  it("records the fix as spent before starting it", () => {
    const run = startStep()?.run ?? "";
    const marker = run.indexOf('--add-label "agent:auto-fixed"');
    const fix = run.indexOf('--add-label "agent:fix"');

    expect(marker).toBeGreaterThanOrEqual(0);
    expect(fix).toBeGreaterThan(marker);
    // Neither add is tolerated away. A label this cannot add is a loop that has
    // stopped transitioning, under a posted verdict saying a fix round started
    // — and a red job is the only thing that says it did not.
    expect(run).toContain("set -euo pipefail");
    expect(run).not.toContain("|| true");
  });

  /**
   * The two standing guards, restated rather than inherited through `needs:`,
   * for the reason `resolve` restates them: today a skipped review skips this
   * job too, but only while this `if:` carries no status function, and a later
   * `always()` added for some other reason would drop both at once.
   */
  it.each([
    ["the trigger label", "github.event.label.name == 'agent:review'"],
    ["the fork", "github.event.pull_request.head.repo.full_name == github.repository"],
  ])("restates %s guard rather than inheriting it", (_case: string, guard: string) => {
    expect(job().if ?? "").toContain(guard);
    expect(job().needs).toBe("review");
  });

  /**
   * **No checkout and no agent** (decision 2). This is the only job in the
   * workflow that spends `AGENT_PAT`, and it must not be the one that reads
   * untrusted pull-request content and runs a model over it. Its whole input is
   * two literals and a key the review job derived.
   */
  it("checks nothing out, installs nothing and runs no model", () => {
    const steps = job().steps ?? [];

    expect(steps).toHaveLength(1);
    for (const step of steps) {
      expect(step.uses, "the automatic fix uses no action").toBeUndefined();
      expect(step.run ?? "").not.toContain("npm exec");
      expect(step.run ?? "").not.toContain("claude");
    }
  });

  /**
   * …and holds one scope, narrower than the job it follows. Not `issues:
   * write`: that covers labels on an *issue*, and the one thing this must never
   * be able to do is file work (docs/parity.md §10).
   */
  it("holds the one scope a label add spends", () => {
    expect(job().permissions).toEqual({ "pull-requests": "write" });
  });

  /**
   * MUST use `AGENT_PAT`: a label added with `GITHUB_TOKEN` fires no `labeled`
   * event, so `agent:fix` would sit on the pull request triggering nothing.
   * Without the secret the label still goes on and a warning names what to do
   * by hand — the shape `implement-prd.yml` already uses — because the verdict
   * has already told a maintainer a fix round started.
   */
  it("labels with the PAT, and says so when there is none", () => {
    const step = startStep();

    expect(step?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
    expect(step?.env?.["HAS_PAT"]).toBe("${{ secrets.AGENT_PAT != '' }}");
    expect(step?.run ?? "").toContain('[ "$HAS_PAT" != "true" ]');
    expect(step?.run ?? "").toContain("::warning::");
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
          [...(jobOf(file).if ?? "").matchAll(/github\.event\.label\.name == '(agent:[a-z-]+)'/g)].map(
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

    // The second is the PRD chain's advance (#176), and it is not a label on
    // the pull request under review: it goes on the slice PR's **parent
    // issue**, through `gh issue edit`, and only from the `advance` job.
    expect(added).toEqual(["agent:fix", "agent:implement"]);
    // …and in these jobs. `stepsOf` reads the review job alone, so its silence
    // is the assertion: each add is somewhere `jobOf` does not reach.
    for (const step of stepsOf(REVIEW)) {
      expect(step.run ?? "").not.toContain('--add-label "agent:fix"');
      expect(step.run ?? "").not.toContain('--add-label "agent:implement"');
    }
    expect(startStep()).toBeDefined();
    for (const step of job().steps ?? []) {
      expect(step.run ?? "").not.toContain('--add-label "agent:implement"');
    }
    expect(
      (jobNamed(REVIEW, "advance").steps ?? []).some((s) =>
        (s.run ?? "").includes('gh issue edit "$parent" --add-label "agent:implement"'),
      ),
    ).toBe(true);
  });

  /**
   * **Draft means the loop is still working** (decision 4). A pull request
   * whose fix round is about to start is not the human's turn, and the end of
   * that round is what marks it ready — the re-review where the fix pushed,
   * and the fix run's own no-push arm where it did not (#159, asserted with
   * that arm). Predicted from the same verdict key the job selects on rather
   * than from a second reading of the three facts behind it, so the draft state
   * and the job cannot disagree.
   */
  it("leaves the pull request in draft exactly when the fix round is starting", () => {
    const ready = stepsOf(REVIEW).find((s) => (s.name ?? "") === "Mark PR ready for review");
    const condition = (ready?.if ?? "").replace(/\s+/g, " ").trim();

    expect(condition).toBe(
      `steps.state.outputs.proceed == 'true' && success() && ` +
        `steps.verdict.outputs.verdict != '${AUTO_FIX_VERDICT}'`,
    );
  });

  /**
   * The wire the two halves meet on: the runner derives the key from the input
   * and the marker, and writes it into `verdict.json`; one step lifts it into a
   * job output; the job and the draft step read it back. A job cannot read
   * another job's `RUNNER_TEMP`, and nothing in YAML may re-derive the key —
   * that would be a second copy of #96's table where nothing can test it.
   */
  it("carries the key out of the file the runner wrote, deriving nothing", () => {
    const hand = stepsOf(REVIEW).find((s) => s.id === "verdict");

    expect(hand?.if).toBe("steps.state.outputs.proceed == 'true' && success()");
    expect(hand?.run ?? "").toContain("${RUNNER_TEMP}/verdict.json");
    expect(hand?.run ?? "").toContain("verdict=");
    expect(hand?.run ?? "").toContain("round=");
    // A run that wrote no file hands over nothing, and this job does not run.
    expect(hand?.run ?? "").toContain('[ -f "$file" ]');
    // The input the runner reads the other half of the decision from.
    expect(stepsOf(REVIEW).find((s) => (s.name ?? "") === "Run review agent")?.env?.["AUTO_FIX"]).toBe(
      "${{ inputs.auto-fix }}",
    );
  });

  /**
   * In no concurrency group, for the reason `resolve` is in none: the
   * `agent-pr-*` waiter slot has depth 1 and holds the newest arrival, so
   * joining would let this job evict a fix a human queued while the review ran.
   * The `agent:fix` it adds fires a run that *does* join the group, so the
   * serialisation still happens where the work is.
   */
  it("joins no concurrency group", () => {
    expect(job().concurrency).toBeUndefined();
  });

  /**
   * And both caller sets move with it (#102). This repository turns it on —
   * it is the one that has been reading these verdicts since #96 — and the
   * reference caller ships the input commented out beside a line saying what it
   * does, like the other optional inputs. A reference caller that turned it on
   * would switch the feature on for every adopter who copied it.
   */
  it("is on in this repo's caller and offered, off, in the reference one", () => {
    expect(jobOf(path.join(WORKFLOW_DIR, "agent-review.yml")).with?.["auto-fix"]).toBe(true);

    expect(jobOf(REVIEW_CALLER).with?.["auto-fix"]).toBeUndefined();
    const lines = fs.readFileSync(REVIEW_CALLER, "utf8").split("\n");
    const offered = lines.findIndex((line) => /^\s*#\s*auto-fix:\s*true\s*$/.test(line));

    expect(offered, "examples/callers/review.yml offers no commented auto-fix").toBeGreaterThan(0);
    // And a line saying what it does, since "what happens if I uncomment this"
    // is the whole of what a commented input has to answer.
    expect(lines[offered - 1] ?? "").toMatch(/^\s*#\s*\S/);
    expect(lines.slice(0, offered).join(" ")).toMatch(/fix round/);
  });
});

/**
 * The fix round closes itself out (#96): a push asks for the review of what it
 * pushed, instead of leaving a pull request whose verdict says "add agent:fix"
 * on a branch where the fix has already landed.
 *
 * This is the `agent:fix` → `agent:review` leg that `docs/parity.md` §10
 * already calls safe, and the bound it rests on is that a round-2 review cannot
 * answer with the round-1 *Changes recommended* line, the one that promises an
 * automatic re-review (`deriveVerdict`) — so this leg cannot be walked a second
 * time off one human label. (Not "review adds no trigger label of its own",
 * which stopped being true at #102.)
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
    expect(push?.run ?? "").toContain('echo "pushed=true" >> "$GITHUB_OUTPUT"');
    expect(push?.run ?? "").toContain('echo "pushed=false" >> "$GITHUB_OUTPUT"');
  });

  it("requests the review only when the fix pushed something", () => {
    expect(request()?.if).toBe(
      "steps.state.outputs.proceed == 'true' && success() && steps.push.outputs.pushed == 'true'",
    );
    expect(request()?.run ?? "").toContain('--add-label "agent:review"');
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
      "steps.state.outputs.proceed == 'true' && success() && steps.push.outputs.pushed != 'true'",
    );
    expect(ready()?.run ?? "").toContain('gh pr ready "$PR_NUMBER"');
  });

  /**
   * MUST use `AGENT_PAT`, for the reason review's own step does: `GITHUB_TOKEN`
   * cannot convert a draft at all, whatever it is granted. A warning rather
   * than a failure, also for review's reason — by this point every thread has
   * its reply, and a pull request stuck in draft is not worth failing the run
   * that answered them.
   */
  it("marks it ready with the PAT, and warns rather than failing without one", () => {
    expect(ready()?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
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

    expect(request()?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
    expect(request()?.env?.["HAS_PAT"]).toBe("${{ secrets.AGENT_PAT != '' }}");
    expect(run).toContain("::warning::");
    expect(run).toContain("gh pr comment");
    expect(run).toContain("AGENT_PAT");
    // Inside the arm that knows there is no PAT, not on every run: a comment
    // on the pull requests where the re-review *did* start is noise on the
    // channel this one needs to be read on.
    const arm = run.slice(run.indexOf('if [ "$HAS_PAT" != "true" ]'));

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
    expect(run).not.toContain("|| true");
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
 * copied and a review is asked for instead — a full **round 1** by the round
 * rule (`shared/review-round.ts`), because round 2 needs a non-merge loop
 * commit since the verdict and a resolution leaves only the merge (#105).
 *
 * Neither has a runtime symptom when it breaks. A copy that never fires leaves a
 * refreshed pull request looking unreviewed, which is merely the cost of the
 * feature being off; a copy that fired on the conflicts path would put "ready to
 * merge" on code an agent wrote and nobody read.
 */
/**
 * The PRD chain advances by itself when a slice PR's review round ends (#176,
 * PRD #171). A job of its own in `review`, and the same job in `fix` for the
 * round a fix run ends itself, re-adds `agent:implement` to the parent — so the
 * next `implement-prd` run merges the slice PR and builds the next slice.
 *
 * Nothing here has a runtime symptom when it breaks. An advance that never
 * fires is a chain that stops after its first slice looking finished; one that
 * fires on a fix round starting builds the next slice under a slice whose fix
 * is still in flight; one that fires on an ordinary pull request labels an
 * issue that has no chain at all.
 */
describe("a slice PR's round ends by advancing the PRD chain", () => {
  const FIX = path.join(WORKFLOW_DIR, "fix.yml");
  const HOLDERS = [
    ["review", REVIEW],
    ["fix", FIX],
  ] as const;
  const advance = (file: string): Job => jobNamed(file, "advance");
  const condition = (file: string): string => (advance(file).if ?? "").replace(/\s+/g, " ");

  /**
   * The verdict keys the chain moves on from: 🟢, 🟡 with no automatic fix
   * starting, and 🟡 after a fix round. Exactly those, matched as keys — the
   * three *changes recommended* rows share a heading, so only the key tells
   * the fix round starting from the two that end a round.
   */
  const ADVANCING: readonly Verdict[] = [
    "approval recommended",
    "changes recommended",
    "changes recommended after a fix round",
  ];

  it("selects on the advancing verdict keys, and on no other", () => {
    const selected = [...condition(REVIEW).matchAll(/needs\.review\.outputs\.verdict == '([^']+)'/g)].map(
      ([, key]) => key ?? "",
    );

    expect(selected).toEqual([...ADVANCING]);
    for (const key of selected) expect(Object.keys(VERDICTS)).toContain(key);
    // Every key is either one this selects or one it must not: a sixth row
    // added to the table arrives here as a decision rather than as a gap.
    const parked = Object.keys(VERDICTS).filter((key) => !selected.includes(key as Verdict));
    expect(parked.sort()).toEqual(["changes recommended, fix round started", "needs a closer look"]);
    expect(condition(REVIEW)).not.toContain("!=");
    expect(advance(REVIEW).needs).toEqual(["review", "resolve"]);
  });

  /**
   * In `fix`, the round ends where the run pushed nothing and so asked for no
   * re-review. A run that pushed hands the round to that re-review, whose
   * verdict decides. `== 'false'`, never `!= 'true'`: the push writes the
   * output on both arms, and unset is a run that never reached it.
   */
  it("advances from fix only where the run pushed nothing", () => {
    expect(condition(FIX)).toContain("needs.fix.outputs.pushed == 'false'");
    expect(condition(FIX)).not.toContain("pushed != ");
    expect(advance(FIX).needs).toBe("fix");
    expect(jobOf(FIX).outputs?.["pushed"]).toBe("${{ steps.push.outputs.pushed }}");
  });

  /**
   * **A failed run parks the chain.** `fix`'s `if:` carries no status
   * function, so a failed fix skips the job through `needs:` — the guard that
   * an `always()` added for another reason would quietly drop.
   */
  it("fix: does not fire on a failed run", () => {
    expect(condition(FIX)).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|success\(\)/);
  });

  /**
   * `review`'s copy waits for `resolve`, because the `implement-prd` run it
   * starts reads the slice PR's unresolved threads into a row that is never
   * refreshed — read beside `resolve`, it could link findings this round
   * verified fixed as open. Waiting on a job that is skipped whenever there is
   * nothing to close takes a status function, so what `needs:` alone gave —
   * park on a failed review — is spelled out by result instead: it fires on a
   * review that succeeded and a `resolve` that succeeded or had nothing to do,
   * and on nothing else. `!cancelled()`, never `always()`.
   */
  it("review: waits for resolve, and does not fire on a failed review or resolve", () => {
    const text = condition(REVIEW);

    expect(text).not.toMatch(/always\(\)|failure\(\)|[^!]cancelled\(\)|success\(\)/);
    expect(text.startsWith("!cancelled() && ")).toBe(true);
    expect(text).toContain("needs.review.result == 'success' && ");
    expect(text).toContain(
      "(needs.resolve.result == 'success' || needs.resolve.result == 'skipped') && ",
    );
    expect([...text.matchAll(/needs\.(\w+)\.result == '(\w+)'/g)].map(([, job, result]) => `${job}:${result}`)).toEqual([
      "review:success",
      "resolve:success",
      "resolve:skipped",
    ]);
  });

  /**
   * **Only on a slice PR.** Recognised by its head — `agent/slice-…`, the name
   * `implement-prd` gives it and the one the parent is read from. An ordinary
   * pull request has no chain, and a PRD PR's head is `agent/prd-…`.
   */
  it.each(HOLDERS)("%s: fires on slice PRs only", (_name: string, file: string) => {
    expect(condition(file)).toContain("startsWith(github.event.pull_request.head.ref, 'agent/slice-')");
    expect(condition(file)).not.toContain("agent/prd-");
    expect(advance(file).env?.["HEAD_REF"]).toBe("${{ github.event.pull_request.head.ref }}");
    expect(step(file)?.run ?? "").toContain("^agent/slice-([0-9]+)-[0-9]+-");
  });

  it.each(HOLDERS)("%s: restates the trigger label and fork guards", (name: string, file: string) => {
    expect(condition(file)).toContain(`github.event.label.name == 'agent:${name}'`);
    expect(condition(file)).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  const step = (file: string): Step | undefined =>
    (advance(file).steps ?? []).find((s) => s.name === "Advance the PRD chain");

  /**
   * **No checkout and no model**, in `auto-fix`'s shape: this job spends
   * `AGENT_PAT` and must not be the one that reads untrusted pull-request
   * content and runs a model over it.
   */
  it.each(HOLDERS)("%s: checks nothing out, installs nothing and runs no model", (_name: string, file: string) => {
    const steps = advance(file).steps ?? [];

    expect(steps).toHaveLength(1);
    for (const s of steps) {
      expect(s.uses, "the advance uses no action").toBeUndefined();
      expect(s.run ?? "").not.toContain("npm exec");
      expect(s.run ?? "").not.toContain("claude");
      expect(s.run ?? "").not.toContain("git ");
    }
  });

  /**
   * …and holds one scope, for the no-PAT arm's comment on the slice PR. The
   * label on the parent is added with the PAT or not at all, so the workflow
   * token never writes an issue — and `issues: write` would be a scope no
   * caller of either workflow grants, which GitHub answers by refusing the
   * whole run.
   */
  it.each(HOLDERS)("%s: holds only what it needs", (_name: string, file: string) => {
    expect(advance(file).permissions).toEqual({ "pull-requests": "write" });
    expect(advance(file).concurrency).toBeUndefined();
  });

  /**
   * MUST use `AGENT_PAT`: `agent:implement` added with `GITHUB_TOKEN` starts
   * nothing. So without the PAT nothing is added, and the slice PR — where the
   * maintainer is already looking — is told which re-label advances the chain
   * by hand. The add itself is under `bash -e`: a chain that did not advance
   * is a stall with no other symptom.
   */
  it.each(HOLDERS)("%s: labels the parent with the PAT, and comments when there is none", (_name: string, file: string) => {
    const s = step(file);
    const run = s?.run ?? "";

    expect(s?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
    expect(s?.env?.["HAS_PAT"]).toBe("${{ secrets.AGENT_PAT != '' }}");
    expect(run).toContain("set -euo pipefail");

    const noPat = run.indexOf('if [ "$HAS_PAT" != "true" ]; then');
    const add = run.indexOf('gh issue edit "$parent" --add-label "agent:implement"');
    expect(noPat).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(noPat);
    const arm = run.slice(noPat, run.indexOf("\nfi", noPat));
    expect(arm).toContain("::warning::");
    expect(arm).toContain('gh pr comment "$PR_NUMBER"');
    expect(arm).toContain("Re-add \\`agent:implement\\` to #${parent} by hand");
    // Nothing is labelled on that arm: it exits before the add.
    expect(arm).toContain("exit 0");
    expect(arm).not.toContain("--add-label");
    // …and the add is not tolerated away.
    expect(run.slice(add).split("\n")[0]).not.toContain("||");
  });

  /**
   * The same job in both files: the review's copy carries the reasoning, and
   * the fix's is the round a fix run ends. Held equal, so the two cannot come
   * to advance differently.
   */
  it("is the same step in review and in fix", () => {
    expect(advance(FIX).steps).toEqual(advance(REVIEW).steps);
    expect(advance(FIX).env).toEqual(advance(REVIEW).env);
  });

  /** No caller changes: both callers already grant the one scope it holds. */
  it.each([
    REVIEW_CALLER,
    path.join(CALLER_DIR, "fix.yml"),
    path.join(WORKFLOW_DIR, "agent-review.yml"),
    path.join(WORKFLOW_DIR, "agent-fix.yml"),
  ])(
    "%s grants what the advance holds, with no change",
    (caller: string) => {
      expect(jobOf(caller).permissions?.["pull-requests"]).toBe("write");
      expect(jobOf(caller).permissions?.["issues"]).toBeUndefined();
    },
  );
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
  const resolveJob = (): Job => jobNamed(REVIEW, "resolve");
  const resolveRun = (): string =>
    (resolveJob().steps ?? []).find((s) => s.name === "Resolve the threads this review verified")
      ?.run ?? "";
  const handoff = (): Step | undefined => stepsOf(REVIEW).find((s) => s.id === "resolutions");

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
   * holds `contents: read` on purpose. The step that tried it replied into
   * every thread and resolved none, for a release.
   */
  it("resolves nothing in the review job, which cannot", () => {
    for (const step of stepsOf(REVIEW)) expect(step.run ?? "").not.toContain(RESOLVE_MUTATION);
  });

  /**
   * The review job's half is a handoff: the list the runner wrote, on one line,
   * after the verdict and only on a review that posted.
   */
  it("hands the runner's list over after the verdict, only on a posted review", () => {
    const names = stepsOf(REVIEW).map((s) => s.name ?? "");

    expect(handoff()?.env?.["RESOLUTIONS"]).toBe("${{ runner.temp }}/thread_resolutions.json");
    expect(handoff()?.run ?? "").toContain("jq -c .");
    expect(handoff()?.run ?? "").toContain("$GITHUB_OUTPUT");
    expect(handoff()?.if).toBe("steps.state.outputs.proceed == 'true' && success()");
    expect(names.indexOf(handoff()?.name ?? "")).toBeGreaterThan(
      names.indexOf("Post the verdict as a commit status"),
    );
    expect(jobOf(REVIEW).outputs?.["resolutions"]).toBe(
      "${{ steps.resolutions.outputs.resolutions }}",
    );
  });

  /**
   * The resolve job holds `contents: write`, so what it *cannot* do is the
   * point. It has no checkout, no toolchain and no runner, so the scope reaches
   * nothing but two fixed mutations over data. One of those three added later
   * would bring the pull request's own code into a job holding the write.
   */
  it("resolves in a job with nothing to write with", () => {
    const steps = resolveJob().steps ?? [];

    expect(steps).toHaveLength(1);
    for (const step of steps) {
      expect(step.uses).toBeUndefined();
      // The runner's invocation and any git write, not the words: the warning
      // text names this repository, and that is not a checkout.
      expect(step.run ?? "").not.toMatch(/\bnpm\b|\bnpx\b|\bgit (clone|fetch|checkout|push)\b/);
    }
  });

  it("holds exactly the two scopes a resolve needs, and nothing else", () => {
    expect(resolveJob().permissions).toEqual({ contents: "write", "pull-requests": "write" });
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

    expect(writers).toEqual(["resolve"]);
  });

  /**
   * After the review, on its guards restated rather than inherited, and only
   * when there is something to close.
   */
  it("runs after a review that handed something over, behind both guards", () => {
    const condition = resolveJob().if ?? "";

    expect(resolveJob().needs).toBe("review");
    expect(condition).toContain("github.event.label.name == 'agent:review'");
    expect(condition).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(condition).toContain("needs.review.outputs.resolutions != ''");
    expect(condition).toContain("needs.review.outputs.resolutions != '[]'");
    // A status function would run it after a review that failed or was skipped.
    expect(condition).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
  });

  /**
   * **Outside the per-PR group**, and deliberately. The group holds one
   * waiting run and a newer arrival evicts it silently (docs/parity.md §10), so
   * joining would put this job in a position to evict a fix a human queued.
   * Overlap is harmless: a fix no longer sees a verified thread, and a racing
   * review posts no second reply.
   */
  it("joins no concurrency group", () => {
    expect(resolveJob().concurrency).toBeUndefined();
  });

  /**
   * The list arrives through `env:`. A reply quotes a maintainer's words, and
   * an expression spliced into the script would make those words a script.
   */
  it("reads the list through the environment, never interpolated", () => {
    expect(resolveJob().env?.["RESOLUTIONS"]).toBe("${{ needs.review.outputs.resolutions }}");
    expect(resolveRun()).not.toContain("${{");
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

    expect(after).toMatch(/\|\| echo "::warning::Could not resolve/);
    expect(after).toContain("GitHub's reply is printed above");
    expect(after).toMatch(/not the caller's .*contents:.* grant/);
    expect(run).not.toMatch(/\bexit 1\b/);
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
    expect(push()?.run ?? "").toContain("head=$(git rev-parse HEAD)");
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
   * Except on a draft PRD PR, where a review is the integration review and
   * would start over a partial chain (#178). The resolution is still code no
   * review has seen, so it is named on the PRD PR instead — by the commit the
   * push reported, under a marker the integration review can find — and the
   * request is skipped only there: a handed-over PRD PR is not a draft, and an
   * ordinary pull request is not under `agent/prd-`.
   */
  it("holds the review on a draft PRD PR and names the resolved merge commit instead", () => {
    const hold = stepNamed("Name the resolution on a draft PRD PR");
    const run = hold?.run ?? "";

    expect(hold?.id).toBe("prd");
    expect(hold?.if).toBe("steps.merge.outputs.status == 'conflicts' && success()");
    expect(hold?.env?.["RESOLVED_SHA"]).toBe("${{ steps.push.outputs.head }}");
    expect(run).toContain('[[ "$BRANCH" != agent/prd-* ]]');
    expect(run).toContain("isDraft");
    expect(run).toContain("<!-- agent-resolved-merge ${RESOLVED_SHA} -->");
    expect(run).toContain("gh pr comment");
    expect(run).toContain("held=true");
    expect(run).not.toContain("agent:review\"");
    expect(run).not.toContain("--add-label");

    // Between the push that names the commit and the request it stands in for.
    const names = stepsOf(UPDATE).map((s) => s.name ?? "");
    expect(names.indexOf(hold?.name ?? "")).toBeGreaterThan(names.indexOf("Comment on the PR"));
    expect(names.indexOf(hold?.name ?? "")).toBeLessThan(names.indexOf(request()?.name ?? ""));
  });

  /**
   * A comment that did not land leaves a resolution nothing will review, so it
   * fails the run the way a failed `agent:review` add does, with the commit in
   * the reason — the one place left that still names it.
   */
  it("fails naming the commit when the resolution could not be recorded", () => {
    const run = stepNamed("Name the resolution on a draft PRD PR")?.run ?? "";

    expect(run).toContain("set -euo pipefail");
    expect(run).toContain("failure_reason.txt");
    expect(run.slice(run.indexOf("failure_reason.txt") - 400)).toContain("${RESOLVED_SHA}");
    expect(run).toContain("exit 1");
  });

  /**
   * The two are opposite arms of the same merge, and the gates are what keep
   * them that way. A copy on the conflicts path is a verdict about code an
   * agent wrote unread; a request on the clean path is a review round nothing
   * happened to justify, and one that would post a fresh verdict over the
   * carried one.
   */
  it("never does both: the copy is the clean path, the request the conflicts one", () => {
    expect(copy()?.if).toBe("steps.merge.outputs.status == 'clean' && success()");
    expect(request()?.if).toBe(
      "steps.merge.outputs.status == 'conflicts' && steps.prd.outputs.held != 'true' && success()",
    );
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

    expect(request()?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
    expect(request()?.env?.["HAS_PAT"]).toBe("${{ secrets.AGENT_PAT != '' }}");
    expect(run).toContain("::warning::");
    // What is unreviewed here is a conflict resolution an agent wrote, which
    // is the one thing this loop produces that no review has seen (#105).
    expect(run.slice(run.indexOf('if [ "$HAS_PAT" != "true" ]'))).toContain("gh pr comment");
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
    expect(run).not.toContain("|| true");
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
    const halves = [UPDATE, ...callerWorkflows.filter((file) => targetOf(file) === UPDATE)];

    expect(halves).toHaveLength(3);
    for (const file of halves) expect(jobOf(file).permissions?.["statuses"]).toBe("write");
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
  const CALLERS = callerWorkflows.filter((file) => targetOf(file) === FOLLOW_UPS);

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
    expect(CALLERS.map((f) => path.basename(f)).sort()).toEqual([
      "agent-follow-ups.yml",
      "follow-ups.yml",
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
    for (const file of CALLERS) {
      expect(jobOf(file).with).toBeUndefined();
      expect(jobOf(file).secrets).toBeUndefined();
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
    ["the called job bounds", FOLLOW_UPS],
    ["agent-follow-ups.yml grants", path.join(WORKFLOW_DIR, "agent-follow-ups.yml")],
    ["examples/callers/follow-ups.yml grants", path.join(CALLER_DIR, "follow-ups.yml")],
  ])("%s exactly the four scopes the job spends", (_half: string, file: string) => {
    expect(jobOf(file).permissions).toEqual({
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
        callerWorkflows
          .filter((file) => workflowOf(file).on?.pull_request_target !== undefined)
          .map(targetOf),
      ),
    ].sort();

    expect(triggered).toEqual([...PR_WORKFLOWS, ...MERGE_GATED].sort());
    expect(PR_WORKFLOWS.filter((file) => MERGE_GATED.includes(file))).toEqual([]);
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
    expect(callerWorkflows.map((f) => path.basename(f)).sort()).toEqual([
      "agent-fix.yml",
      "agent-follow-ups.yml",
      "agent-implement-prd.yml",
      "agent-implement.yml",
      "agent-review.yml",
      "agent-update-branch.yml",
      "fix.yml",
      "follow-ups.yml",
      "implement-prd.yml",
      "implement.yml",
      "review.yml",
      "update-branch.yml",
    ]);
    // Both caller sets point at the same reusables, so dedupe before
    // comparing: what matters is that every runner has a caller and every
    // caller reaches a runner, not the multiplicity.
    expect([...new Set(callerWorkflows.map(targetOf))].sort()).toEqual(runnerWorkflows.slice().sort());
  });

  /**
   * Whatever a caller hands over to has to be a file this suite reads. The
   * empty-expression guard is the one that bites: a `${{ }}` in the extracted
   * YAML rejects the whole file at *startup*, with no log and no failed job —
   * exactly the two-day failure this suite was written for — and the caller it
   * was extracted from would still parse clean.
   */
  it.each(callerWorkflows)("%s: calls a workflow this suite already checks", (file) => {
    expect(runnerWorkflows).toContain(targetOf(file));
    expect(workflowFiles).toContain(targetOf(file));
  });

  /**
   * The trigger is the one thing `workflow_call` cannot carry, so it stays with
   * the caller — and nothing else does. A caller with `steps:` is a caller that
   * has started keeping a copy.
   */
  it.each(callerWorkflows)("%s: is a trigger and nothing else", (file) => {
    const doc = workflowOf(file);
    const trigger = doc.on?.pull_request_target ?? doc.on?.issues;

    expect(trigger?.types).toEqual(triggerTypesOf(file));
    expect(jobOf(file).steps).toBeUndefined();
    expect(jobOf(file).uses).toBe(
      `jeffwlawson/agent-workflows/${targetOf(file)}@${PIN}`,
    );
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
  it.each(callerWorkflows)("%s: pins the called workflow to a tag or a SHA", (file) => {
    const ref = (jobOf(file).uses ?? "").split("@")[1] ?? "";

    expect(ref).toMatch(/^(v\d+\.\d+\.\d+|[0-9a-f]{40})$/);
  });

  /**
   * The run keeps the caller's name, and that is load-bearing rather than
   * cosmetic: review's failure-log tail skips workflow runs named `Agent …`
   * (`case "$rname" in "Agent "*`), and a called workflow contributes no run of
   * its own — there is one run, named here. Rename these and every agent run's
   * failure log starts arriving in review's prompt as evidence about the diff.
   */
  it.each(callerWorkflows)("%s: keeps the name the failure-log filter matches on", (file) => {
    expect(workflowOf(file).name ?? "").toMatch(/^Agent /);
  });

  /**
   * The label guard is on the **called** side, in every pair. A caller's `if:`
   * can only skip the job, never loosen it, so a guard put there is a guard an
   * adopter can leave behind.
   */
  it.each(runnerWorkflows)("%s: guards its trigger label on this side of the seam", (file) => {
    expect(jobOf(file).if ?? "").toMatch(/github\.event\.label\.name == 'agent:[a-z-]+'/);
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
    expect(jobOf(file).if ?? "").toContain(
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
   */
  it.each(PR_WORKFLOWS)("%s: checks the PR head out by explicit ref", (file) => {
    const checkout = stepsOf(file).filter((s) => (s.uses ?? "").startsWith("actions/checkout@"));

    expect(checkout).not.toHaveLength(0);
    for (const step of checkout) {
      expect(step.with?.["ref"]).toBe("${{ github.event.pull_request.head.sha }}");
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
  it.each(callerWorkflows)("%s: grants exactly what the called jobs bound", (file) => {
    const granted = jobOf(file).permissions;
    const RANK: Readonly<Record<string, number>> = { none: 0, read: 1, write: 2 };
    const widest: Record<string, string> = {};
    for (const job of jobsOf(targetOf(file))) {
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
   * one step *above* their checkout, and the `--add-label` ending it is
   * deliberately not written `|| true`, so Actions' default `bash -e` fails the
   * run there. Loud, and before the diff is fetched.
   *
   * A property of these three workflows rather than an oversight in them: a
   * `|| true` added to that line would buy back exactly the silent, paid-for run
   * the prose once claimed. What it is *not* is what a caller's missing
   * `pull-requests: write` gets you — that run never starts (#146) — so this is
   * about a token that is short for some other reason, which is why the
   * assertion is about step order rather than about a grant.
   */
  it.each(PR_WORKFLOWS)("%s: a 403 on the label transition fails before the checkout", (file) => {
    const steps = stepsOf(file);
    const transition = steps.findIndex((s) =>
      (s.run ?? "").includes('--add-label "agent:in-progress"'),
    );
    const checkout = steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"));

    expect(transition).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeGreaterThan(transition);

    // Keyed on the tolerance rather than on the command: the two `--remove-label`
    // lines in the same step are `|| true` on purpose — a label that is not
    // there is not a failure — so it is this line alone that must be bare.
    const adds = (steps[transition]?.run ?? "")
      .split("\n")
      .filter((l) => l.includes('--add-label "agent:in-progress"'));

    expect(adds).not.toHaveLength(0);
    for (const line of adds) expect(line).not.toContain("|| true");
  });

  /**
   * And the sentence that described it. Review is the one workflow whose
   * `permissions:` block spells the grant/bound split out at length, so it is
   * the one that can get the cost wrong; the claim also reached #45's issue
   * body and from there `REQUIRED_PERMISSIONS`, which is why the correction is
   * asserted rather than just made.
   */
  it("review.yml's permissions comment describes that failure, not a silent one", () => {
    const [comment] = permissionComments(REVIEW);

    expect(comment).toBeDefined();
    expect(comment).toContain("grants nothing");
    expect(comment).not.toMatch(/silently transitions no label/i);
    expect(comment).toMatch(/before the checkout/i);
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
  it.each(wiredCallers())("%s: passes both secrets by name", (file) => {
    const declared = callOf(targetOf(file))?.secrets ?? {};

    expect(Object.keys(declared).sort()).toEqual(["AGENT_PAT", "CLAUDE_CODE_OAUTH_TOKEN"]);
    // The agent cannot run without its token. The PAT is optional everywhere —
    // every use of it falls back to `GITHUB_TOKEN` under a warning (§1) — and
    // an unset optional secret arrives as the empty string, which is what those
    // fallbacks test.
    expect(declared["CLAUDE_CODE_OAUTH_TOKEN"]?.required).toBe(true);
    expect(declared["AGENT_PAT"]?.required).toBe(false);

    expect(jobOf(file).secrets).not.toBe("inherit");
    expect(Object.keys(jobOf(file).secrets ?? {}).sort()).toEqual([
      "AGENT_PAT",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
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
 * The one input that is a fact about the *caller* rather than about the repo,
 * and the one control the extraction itself put at risk
 * (jeffwlawson/winget-manifest-lint#97).
 */
describe("agent-review tells its caller what it cannot know", () => {
  const caller = (): Job => jobOf(REVIEW_CALLER);
  const call = () => workflowOf(REVIEW).on?.workflow_call;

  /**
   * `contents: read` on the review job is the invariant that bounds what a
   * wrong review can do (docs/parity.md §10). The generic check above holds the
   * caller equal to the widest called job; this is the one pair where the
   * *value* is the point. The caller grants `contents: write`, which only the
   * `resolve` job spends (#133). The review job narrows it back to `read`.
   */
  it.each([
    ["the caller grants", REVIEW_CALLER, "write"],
    ["the called job bounds", REVIEW, "read"],
  ])("%s exactly the permissions the job uses", (_half: string, file: string, contents: string) => {
    expect(jobOf(file).permissions).toEqual({
      // The CI wait polls the check-runs API. A public repository serves it
      // without this scope, so every repo in the pilot passed without it and
      // the first private adopter got a 403 that spent the whole wait budget.
      checks: "read",
      contents,
      // Installing the runner package, not reading the PR — the one scope here
      // that is about the toolchain rather than about the review.
      packages: "read",
      "pull-requests": "write",
      // The verdict (#96). A commit status is not a pull-request write, so
      // nothing this job already held covers it. A caller short of it gets no
      // run rather than a review with no verdict on it (#146); what looks like
      // the feature simply being off is a token short for some other reason,
      // since the step that posts the status warns rather than failing.
      statuses: "write",
    });
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
    const [callerJob] = Object.keys(workflowOf(REVIEW_CALLER).jobs);
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
    const preflight = stepsOf(FILE)[0];
    const run = preflight?.run ?? "";

    expect(preflight?.id).toBe("preflight");
    // Ungated, like the three PR guards: a guard with an `if:` is a guard that
    // can be skipped into the work it exists to prevent.
    expect(preflight?.if).toBeUndefined();
    expect(run).toContain('"$ISSUE_STATE" != "open"');
    expect(run).toContain("this issue is not open");
    // Distinct from the refusal that was already there — two refusals reading
    // the same is two states a human cannot tell apart from the comment alone.
    expect(run).toContain("already targets this issue");
    expect(run.indexOf("$ISSUE_STATE")).toBeLessThan(run.indexOf("gh pr list"));
  });

  const NOT_REFUSED = "steps.preflight.outputs.refused == 'false'";

  it("checks nothing out when it refuses", () => {
    const checkout = stepsOf(FILE).filter((s) => (s.uses ?? "").startsWith("actions/checkout@"));

    expect(checkout).not.toHaveLength(0);
    for (const step of checkout) expect(step.if ?? "").toContain(NOT_REFUSED);
  });

  it("never enters agent:in-progress when it refuses", () => {
    const labelling = stepsOf(FILE).filter((s) =>
      (s.run ?? "").includes('--add-label "agent:in-progress"'),
    );

    expect(labelling).not.toHaveLength(0);
    for (const step of labelling) expect(step.if ?? "").toContain(NOT_REFUSED);
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
  const preflightRun = (): string => stepsOf(FILE)[0]?.run ?? "";

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
    ["a sub-issue", "sub-issue of"],
    ["a wayfinder ticket", "planning artifact"],
    ["an issue with open blockers", "blocked by"],
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
  it("tells the reader to remove and re-add, and that the edge is the source of truth", () => {
    const run = preflightRun();

    expect(run).toMatch(/remove and re-add/i);
    expect(run).toMatch(/blocking relation is the thing to remove/i);
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
    const blocked = stepsOf(FILE).find((s) => (s.run ?? "").includes("failure_reason.txt"));

    expect(blocked?.if ?? "").toContain("steps.preflight.outputs.refused != 'true'");
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
    for (const step of install) expect(step.if ?? "").toContain(NOT_REFUSED);
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
  const preflight = (file: string): string => stepsOf(file)[0]?.run ?? "";

  /**
   * The trigger is on the caller and the label guard on the called job
   * (jeffwlawson/winget-manifest-lint#98) — so the pair is read across both
   * halves, which is what the partition actually depends on: two workflows
   * woken by one event, each deciding for itself whether the shape is theirs.
   */
  it.each([
    [IMPLEMENT_CALLER, IMPLEMENT],
    [PRD_CALLER, PRD],
  ])("%s: is triggered by agent:implement on an issue", (callerFile: string, file: string) => {
    expect(workflowOf(callerFile).on?.issues?.types).toEqual(["labeled"]);
    expect(jobOf(file).if ?? "").toBe("github.event.label.name == 'agent:implement'");
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
 * The PRD chain itself. One sub-issue per run, in sub-issues API order, each
 * built on a slice branch of its own and opened as a draft slice PR against
 * one PRD branch, with its own review round (#172). The run re-labels nothing
 * on the parent: the next slice waits on this one's slice PR.
 *
 * **Ordering comes from creation order, not from the edges.** The chain walks
 * sub-issue API order and never reads `blocked-by`; that is safe only because
 * sub-issues are *created* blockers-first, so the topological sort happens once,
 * at publish time. Do not add edge-reading here — fix the publish order.
 */
describe("agent-implement-prd works one sub-issue per run", () => {
  const NOT_REFUSED = "steps.preflight.outputs.refused == 'false'";
  const PRD_GROUP = "agent-implement-prd-issue-${{ github.event.issue.number }}";

  /**
   * Per *parent issue*, first-come. Not the per-PR group the three PR workflows
   * share: an `issues` event carries no PR number, so the two cannot compute a
   * common key. That residual is recorded in docs/parity.md §10 rather than
   * papered over here.
   */
  it("serialises the chain on the parent issue", () => {
    const { concurrency } = jobOf(PRD);

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
    const first = stepsOf(PRD)[0];

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
   * The whole scheduling policy, in one jq filter: keep the OPEN ones in the
   * order the API returned them, take the head. No sort, no edge read.
   */
  it("targets the first still-open sub-issue in API order", () => {
    const run = runOf(PRD, "preflight");

    expect(run).toContain('select(.state == "OPEN")');
    expect(run).toContain("| .[0]");
    expect(run).toContain("sub=");
  });

  /**
   * Four refusals, four messages, and each one names a different thing to do
   * about it. `agent:blocked` on every shape but the finished one: a PRD whose
   * sub-issues have all closed is *finished*, and labelling a completed parent
   * blocked leaves exactly the stale label docs/parity.md §10 warns about.
   */
  it.each([
    ["a nested PRD", "nested"],
    ["a wayfinder ticket", "planning artifact"],
    ["a PRD with nothing left to do", "closed"],
    ["a parent with open blockers", "blocked by"],
  ])("refuses %s with its own message", (_case: string, phrase: string) => {
    expect(runOf(PRD, "preflight")).toContain(phrase);
  });

  /**
   * The blocked-by refusal, mirrored from `agent-implement` (#14). Being a
   * coordinator exempts the parent from nothing — it is a deliverable like any
   * other, and here getting it wrong costs more than the flat case does: one
   * label starts a chain that lands every slice on one branch as one PR, built
   * on work that does not exist yet.
   *
   * Only **open** blockers refuse. A closed one has been satisfied, and treating
   * it otherwise would make every PRD in a finished chain permanently unrunnable.
   */
  it("refuses a blocked parent on open blockers only", () => {
    const run = runOf(PRD, "preflight");

    expect(run).toContain("/dependencies/blocked_by");
    expect(run).toContain('select(.state == "open")');
    expect(armOf(run, '-n "$blockers"')).toContain("refuse_shape");
  });

  /**
   * **Last of the refusals**, after every shape above it — the nested PRD, the
   * truncated list, and above all the *finished* one. Those shapes can never run
   * at all; this one is only *not yet*, so it is the one that gives way when
   * they collide.
   *
   * The collision is real: a PRD whose sub-issues have all closed can still
   * carry an open `blocked_by` edge — the blocker reopened, or the edge added
   * after the chain finished. Read first, that parent takes `refuse_shape` and
   * is handed `agent:blocked`, which is exactly the label the finished case
   * withholds (`docs/parity.md` §10) and which nothing then removes: `Transition
   * labels` is gated on `refused == 'false'`, and no later run can reach it. The
   * message would misdirect too — re-adding `agent:implement` once the blocker
   * closes lands on the finished refusal, not on a slice.
   *
   * Pinned by *position*, because the sibling test below ("the finished PRD
   * not") reads only the `no open sub-issues` arm and stays green with the
   * behaviour reachable around it.
   */
  it("settles the finished PRD before it reads the parent's blockers", () => {
    const run = runOf(PRD, "preflight");
    const read = run.indexOf("/dependencies/blocked_by");

    expect(run.indexOf("nested PRDs have no single owner")).toBeLessThan(read);
    expect(run.indexOf("no open sub-issues")).toBeLessThan(read);
  });

  /**
   * **The parent, and never the sub-issues.** The chain walks them in sub-issues
   * API order and reads `blocked_by` nowhere: whatever publishes the batch owns
   * the topological sort (`docs/agents/ticket-shape.md`), and reading edges
   * mid-walk is a recorded non-goal (`docs/parity.md` §2a, and this file's own
   * header). Teaching the walk to check blockers would contradict both.
   *
   * Underneath the doctrine is a design reason: slices are pieces of *one*
   * feature landing on *one* branch, so a slice needing outside work blocks the
   * whole PRD — you cannot merge four of five and wait. The dependency belongs
   * as an edge on the parent, which is the one this reads.
   */
  it("reads blocked_by for the parent only, and says why", () => {
    const run = runOf(PRD, "preflight");
    const calls = run
      .split("\n")
      .filter((l) => l.includes("dependencies/blocked_by") && !l.trimStart().startsWith("#"));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("${ISSUE_NUMBER}");
    expect(calls[0]).not.toContain("sub");
    expect(run).toContain("docs/agents/ticket-shape.md");
    expect(run).toContain("docs/parity.md §2a");
  });

  /**
   * The remedy names both halves, as the flat refusal does. Re-adding a label
   * that is still attached fires no event (`docs/ADOPTING.md` §1), so "re-add"
   * alone is inert on the path the refusal leaves it on — and a human who
   * believes the work *can* proceed has to be told the edge is the thing to
   * remove, or they fight the preflight in a loop.
   */
  it("tells the reader to remove and re-add, and that the edge is the source of truth", () => {
    const run = runOf(PRD, "preflight");

    expect(run).toMatch(/remove and re-add/i);
    expect(run).toMatch(/blocking relation is the thing to remove/i);
  });

  /**
   * `totalCount` is unpaged and `nodes` is not, so past the page size the head
   * of the open list can sit off the end of the page — and "no open sub-issue"
   * is read as *finished*. Refusing loudly beats closing a PRD that has work
   * left in it.
   */
  it("refuses rather than silently reading a truncated sub-issue list", () => {
    const run = runOf(PRD, "preflight");

    expect(run).toContain("subIssues(first: 100)");
    expect(armOf(run, '"$subs" -gt 100')).toContain("refuse_shape");
    expect(run.indexOf('"$subs" -gt 100')).toBeLessThan(run.indexOf("no open sub-issues"));
  });

  it("marks the durable shape refusals blocked, and the finished PRD not", () => {
    const run = runOf(PRD, "preflight");

    expect(bashFunctionBody(run, "refuse_shape")).toContain('--add-label "agent:blocked"');
    expect(armOf(run, "no open sub-issues")).not.toContain("refuse_shape");
  });

  /**
   * Same exception as jeffwlawson/winget-manifest-lint#90: "no answer" must
   * never be read as a shape.
   */
  it("does not swallow a failed shape query", () => {
    const tolerant = runOf(PRD, "preflight")
      .split("\n")
      .filter((l) => l.includes("|| true") && !l.trimStart().startsWith("#"));

    expect(tolerant).not.toHaveLength(0);
    for (const line of tolerant) expect(line).toContain("gh issue edit");
  });

  it.each([
    ["checks nothing out", (s: Step) => (s.uses ?? "").startsWith("actions/checkout@")],
    ["installs nothing", isInstallStep],
    ["never enters agent:in-progress", (s: Step) => (s.run ?? "").includes('--add-label "agent:in-progress"')],
  ])("%s when it refuses or defers", (_case: string, match: (s: Step) => boolean) => {
    const steps = stepsOf(PRD).filter(match);

    expect(steps).not.toHaveLength(0);
    for (const step of steps) expect(step.if ?? "").toContain(NOT_REFUSED);
  });

  /**
   * The branch is the unit of accumulation, so it is created once and reused —
   * looked up on the remote first, and only branched from the base when it is
   * genuinely absent.
   */
  it("reuses one branch across the chain", () => {
    const branch = runOf(PRD, "branch");
    const prepare = runOf(PRD, "prepare");

    expect(branch).toContain("git ls-remote");
    expect(branch).toContain("agent/prd-${ISSUE_NUMBER}-${slug}");
    expect(branch).toContain('name="$existing"');
    expect(prepare.indexOf('"$EXISTS" = "true"')).toBeLessThan(prepare.indexOf("git checkout -b"));
  });

  /**
   * The lookup is keyed on the **issue number**, not on the whole computed
   * name. A branch name is `agent/prd-<n>-<slug>` and the slug comes from the
   * parent's *title*, which a human may edit at any point; the number is the
   * half nobody can. Recomputing the whole name every run means a retitle
   * mid-chain misses the branch carrying slices 1..N-1, forks slice N off
   * `main`, and opens a second draft PR with the same `Closes #<parent>` — the
   * "created once and reused" property broken by an edit nobody would think of
   * as dangerous. So the slug may only ever *name* a branch, never find one.
   */
  it("finds the branch by the half of its name a human cannot edit", () => {
    const run = runOf(PRD, "branch");

    expect(run).toContain('git ls-remote --heads origin "agent/prd-${ISSUE_NUMBER}-*"');
    expect(run.indexOf("git ls-remote")).toBeLessThan(run.indexOf("${slug}"));
  });

  /**
   * **Plain `git push` for the PRD branch.** It carries every earlier slice, so
   * a force push there is a chain that silently eats its own history, and a
   * rejected non-fast-forward is the correct outcome instead.
   *
   * The slice branch is the one exception, and it is forced for
   * `agent-implement`'s reason: this run cut it and owns it. What a force can
   * replace there is an earlier attempt at the same sub-issue that never became
   * an open slice PR — a sub-issue closes as its slice PR opens, so one with an
   * open slice PR is never built again.
   */
  it("pushes the PRD branch without force, and forces only the slice branch", () => {
    const pushes = fs
      .readFileSync(PRD, "utf8")
      .split("\n")
      .filter((l) => /^\s*git push\b/.test(l));

    expect(pushes).toContain('            git push origin "$PRD_BRANCH"');
    expect(pushes.filter((l) => l.includes("--force"))).toEqual(['          git push --force origin "$SLICE_BRANCH"']);
  });

  /**
   * One slice branch per sub-issue, cut from the PRD branch **tip** — the
   * remote one when the PRD branch exists, so slice N is built on every slice
   * already merged there — and handed to the runner as the branch it is on.
   */
  it("builds each slice on an agent/slice- branch cut from the PRD branch tip", () => {
    const prepare = runOf(PRD, "prepare");
    const agent = stepsOf(PRD).find((s) => (s.run ?? "").includes("agent-workflows implement-prd"));

    expect(prepare).toContain('slice="agent/slice-${ISSUE_NUMBER}-${SUB}-${slug}"');
    expect(prepare.indexOf('git checkout -B "$PRD_BRANCH" "refs/remotes/origin/${PRD_BRANCH}"')).toBeLessThan(
      prepare.indexOf('git checkout -b "$slice"'),
    );
    expect(prepare).toContain('echo "slice=$slice" >> "$GITHUB_OUTPUT"');
    expect(agent?.env?.["BRANCH"]).toBe("${{ steps.prepare.outputs.slice }}");
    expect(agent?.env?.["PRD_BRANCH"]).toBe("${{ steps.branch.outputs.name }}");
  });

  /**
   * The PRD branch is found by a glob on the stable half of its name, and a
   * slice branch must never be a second match — that is the ambiguity the
   * lookup refuses — nor a base the preflight's slice PR filter reads as the
   * PRD branch. Both are read out of the workflow and run against a slice
   * branch built from the prepare step's own template, so a slice prefix moved
   * under `agent/prd-` fails here by name rather than on the next chain.
   *
   * `git ls-remote` matches its pattern against the tail of each ref, with a
   * `*` that crosses `/`, so the glob is anchored at a path boundary only.
   */
  it("finds the PRD branch by a lookup no slice branch can match", () => {
    const lookup = /git ls-remote --heads origin "([^"]+)"/.exec(runOf(PRD, "branch"))?.[1] ?? "";
    const template = /slice="([^"]+)"/.exec(runOf(PRD, "prepare"))?.[1] ?? "";
    const base = /startswith\(\\"([^\\]+)\\"\)/.exec(runOf(PRD, "preflight"))?.[1] ?? "";
    const expand = (text: string): string =>
      text.replaceAll("${ISSUE_NUMBER}", "171").replaceAll("${SUB}", "172").replaceAll("${slug}", "prd-171-x");

    expect(lookup).not.toBe("");
    expect(template).toMatch(/^agent\/slice-/);
    const glob = new RegExp(
      `(^|/)${expand(lookup).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
    );
    const slice = `refs/heads/${expand(template)}`;

    // Live rather than vacuous: the same glob does find the PRD branch.
    expect("refs/heads/agent/prd-171-slice-prs").toMatch(glob);
    expect(slice).not.toMatch(glob);
    expect(expand(base)).toBe("agent/prd-171-");
    expect(expand(template).startsWith(expand(base))).toBe(false);
  });

  /**
   * A **draft**, against the PRD branch rather than the base branch, and `Part
   * of` rather than `Closes`: the sub-issue's state is the chain's "built"
   * marker, and a closing keyword would tie it to the slice PR's merge.
   */
  it("opens each slice as a draft slice PR against the PRD branch, part of its sub-issue", () => {
    const step = stepsOf(PRD).find((s) => s.id === "slice_pr");
    const run = step?.run ?? "";

    expect(run).toContain('gh pr create --draft --base "$PRD_BRANCH" --head "$SLICE_BRANCH"');
    expect(run).toContain('echo "Part of #${SUB}"');
    expect(run).not.toMatch(/\b(Closes|Fixes|Resolves) #/);
    expect(step?.env?.["PRD_BRANCH"]).toBe("${{ steps.branch.outputs.name }}");
    expect(step?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
  });

  /**
   * Closed the moment its slice PR opens, so "first open sub-issue" is still
   * the next slice to build — and with the SHA, the only record tying a closed
   * sub-issue to the code that closed it.
   */
  it("closes the finished sub-issue with a comment naming the commit, once its slice PR is open", () => {
    const steps = stepsOf(PRD);
    const close = steps.findIndex((s) => (s.run ?? "").includes("gh issue close"));
    const opened = steps.findIndex((s) => s.id === "slice_pr");

    expect(opened).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(opened);
    expect(steps[close]?.if ?? "").toContain(NOT_REFUSED);
    expect(steps[close]?.if ?? "").toContain("success()");
    expect(steps[close]?.run ?? "").toContain("git rev-parse HEAD");
    expect(steps[close]?.run ?? "").toContain("--comment");
    expect(steps[close]?.env?.["SLICE_PR"]).toBe("${{ steps.slice_pr.outputs.number }}");
  });

  /**
   * The slice PR asks for its review the way `agent-implement`'s PR does. The
   * chain no longer re-labels the parent after a slice, and no longer asks for
   * review of the whole PRD on the last one: the next slice waits on this
   * one's round. The one other trigger label it adds is the finishing run's
   * integration review on the PRD PR (#177), which a building run never adds.
   */
  it("requests review on the slice PR, and re-labels nothing else", () => {
    const adds = stepsOf(PRD).filter((s) => /--add-label "agent:(implement|review)"/.test(s.run ?? ""));

    expect(adds).toHaveLength(2);
    expect(adds[0]?.run ?? "").toContain('gh pr edit "$SLICE_PR" --add-label "agent:review"');
    expect(adds[0]?.env?.["SLICE_PR"]).toBe("${{ steps.slice_pr.outputs.number }}");
    expect(adds[0]?.if ?? "").toContain("steps.preflight.outputs.finishing == 'false'");
    expect(adds[0]?.if ?? "").not.toContain("steps.remaining");
    expect(adds[1]?.id).toBe("handover");
    expect(adds[1]?.run ?? "").toContain('gh pr edit "$PRD_PR" --add-label "agent:review"');
    expect(adds[1]?.if ?? "").toContain("steps.preflight.outputs.finishing == 'true'");
    expect(runOf(PRD, "handover")).not.toContain("agent:implement\" ");
    expect(stepsOf(PRD).map((s) => s.id)).not.toContain("remaining");
  });

  /**
   * The label add is a silent no-op under `GITHUB_TOKEN` — the anti-recursion
   * rule (docs/ADOPTING.md §1) — so the slice PR would sit in draft with nobody
   * asked to review it. Warn loudly.
   */
  it("warns loudly when AGENT_PAT is absent for the review label", () => {
    const step = stepsOf(PRD).find((s) => (s.run ?? "").includes('--add-label "agent:review"'));

    expect(step?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
    expect(step?.env?.["HAS_PAT"]).toBe("${{ secrets.AGENT_PAT != '' }}");
    expect(step?.run ?? "").toContain("::warning::");
  });

  /**
   * …and fails when the add itself fails, which is a different thing and needs
   * `-e` to hold. The step ends with that warn-if-no-PAT `if`, which returns 0
   * whenever the PAT *is* set — and it is the last command, so without `-e` a
   * failed `gh ... --add-label` exits the step green and `Mark blocked on
   * failure`, gated on `failure()`, never says which slice PR wants the label.
   */
  it("fails the run rather than swallowing a failed review label", () => {
    const step = stepsOf(PRD).find((s) => (s.run ?? "").includes('--add-label "agent:review"'));

    expect(step?.run ?? "").toContain("set -euo pipefail");
  });

  /**
   * Once the slice PR is open, re-applying `agent:implement` — the failure
   * comment's own remedy — starts by **merging** it rather than retrying
   * anything, and the merge never reads a verdict (#173). A run that died
   * before asking for the review would land that slice unreviewed. So the
   * comment names the slice PR whenever there is one, the two things the steps
   * after it may not have done — the sub-issue's close and the review label —
   * and says the re-label waits for that round.
   */
  it("names the slice PR as the way out when the chain dies after opening it", () => {
    const failed = stepsOf(PRD).find((s) => s.name === "Mark blocked on failure");

    expect(failed?.env?.["SLICE_PR"]).toBe("${{ steps.slice_pr.outputs.number }}");
    expect(failed?.run ?? "").toContain("agent:review");
    expect(failed?.run ?? "").toMatch(/close that sub-issue by hand/);
    expect(failed?.run ?? "").toMatch(/would merge it into the PRD branch as it stands/);
    expect(failed?.run ?? "").toMatch(/only once that round has ended/);
  });

  /**
   * The waiting slice PR is merged into the PRD branch in a step of its own,
   * named for it, and before anything is built (#173) — before the checkout,
   * so the PRD branch the slice branch is cut from already holds it. The
   * preflight is still first: it is the step that finds the slice PR.
   */
  it("merges the waiting slice PR in its own named step, before the build", () => {
    const steps = stepsOf(PRD);
    const merge = steps.findIndex((s) => s.id === "merge");
    const checkout = steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    const agent = steps.findIndex((s) => (s.run ?? "").includes("agent-workflows implement-prd"));

    expect(steps[merge]?.name).toBe("Merge slice PR #${{ steps.preflight.outputs.slice_pr }}");
    expect(merge).toBeGreaterThan(steps.findIndex((s) => s.id === "preflight"));
    expect(merge).toBeLessThan(checkout);
    expect(checkout).toBeLessThan(agent);
    expect(steps[merge]?.if).toBe(`${NOT_REFUSED} && steps.preflight.outputs.slice_pr != ''`);
    expect(steps[merge]?.env?.["SLICE_PR"]).toBe("${{ steps.preflight.outputs.slice_pr }}");
    expect(runOf(PRD, "preflight")).toContain(`echo "slice_pr=$(jq -r '.[0].number // ""' <<< "$slice_prs")"`);
  });

  /**
   * The merge rules on the round and on mergeability, never on the verdict: a
   * human's re-label and the chain's own are one path. The refusals, the method
   * order and the draft case are executed in
   * `tests/implement-prd-preflight.test.ts`; this pins what they stand on.
   */
  it("reads no verdict, and refuses while the slice PR's round is still running", () => {
    const run = runOf(PRD, "merge");

    expect(run).not.toMatch(/agent-review|verdict|statuses/);
    for (const label of ["agent:review", "agent:fix", "agent:in-progress"]) expect(run).toContain(`. == "${label}"`);
    expect(run).toContain("agent:update-branch");
    expect(run.indexOf('gh pr ready "$SLICE_PR"')).toBeLessThan(run.indexOf("gh pr merge"));
  });

  /**
   * Pinned to the head it read, merged with `AGENT_PAT` — a `GITHUB_TOKEN`
   * merge fires no event, so no PRD PR CI and no Follow-ups run — and warning
   * on the fallback, naming the follow-ups it left unfiled when there are some.
   */
  it("merges pinned to the inspected head, with AGENT_PAT, and warns on the fallback", () => {
    const step = stepsOf(PRD).find((s) => s.id === "merge");
    const run = step?.run ?? "";

    expect(run).toContain('--match-head-commit "$head"');
    expect(run).toContain("head=$(jq -r '.headRefOid' <<< \"$pr\")");
    expect(step?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
    expect(step?.env?.["HAS_PAT"]).toBe("${{ secrets.AGENT_PAT != '' }}");
    expect(run).toContain("::warning::");
    expect(run).toContain("the PRD PR's CI did not run");
    expect(run).toContain("agent:follow-ups");
  });

  it("reads the merge method from the repo settings, squash then rebase then merge commit", () => {
    const run = runOf(PRD, "merge");
    const squash = run.indexOf("allow_squash_merge");

    expect(squash).toBeGreaterThanOrEqual(0);
    expect(squash).toBeLessThan(run.indexOf("allow_rebase_merge"));
    expect(run.indexOf("allow_rebase_merge")).toBeLessThan(run.indexOf("allow_merge_commit"));
  });

  it("deletes the slice branch on merge", () => {
    const run = runOf(PRD, "merge");

    expect(run).toContain('gh api -X DELETE "repos/${GH_REPO}/git/refs/heads/${head_ref}"');
    expect(run.indexOf("gh api -X DELETE")).toBeGreaterThan(run.indexOf("gh pr merge"));
  });

  /**
   * The PRD PR opens in the run that merges the first slice — before that the
   * PRD branch has nothing the base lacks — as a draft carrying `Closes
   * #<parent>`, and is found by its **head** after, which is also what adopts a
   * pre-upgrade draft PR from the PRD branch. Also before the build, so the
   * PRD PR a run needs exists whether or not the build that follows succeeds.
   */
  it("opens the PRD PR as a draft closing the parent once a slice merges, and finds it by head after", () => {
    const steps = stepsOf(PRD);
    const at = steps.findIndex((s) => s.id === "prd_pr");
    const step = steps[at];
    const run = step?.run ?? "";

    expect(at).toBeGreaterThan(steps.findIndex((s) => s.id === "merge"));
    expect(at).toBeLessThan(steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@")));
    expect(step?.if).toBe(`${NOT_REFUSED} && steps.merge.outputs.merged == 'true'`);
    expect(step?.env?.["PRD_BRANCH"]).toBe("${{ steps.merge.outputs.prd_branch }}");
    expect(step?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
    expect(run).toContain('gh pr list --state open --head "$PRD_BRANCH"');
    expect(run).toContain('gh pr create --draft --base "$BASE_REF" --head "$PRD_BRANCH"');
    expect(run).toContain('echo "Closes #${ISSUE_NUMBER}"');
    expect(run.indexOf("gh pr list")).toBeLessThan(run.indexOf("gh pr create"));
  });

  /**
   * Every refusal of the merge and the PRD PR steps is a stop, like the
   * preflight's: a reason file and a failed step, which `Mark blocked on
   * failure` turns into `agent:blocked` and a comment.
   */
  it.each(["merge", "slice_row", "prd_pr"])("%s blocks through the reason file, not a comment of its own", (id: string) => {
    const run = runOf(PRD, id);
    const body = bashFunctionBody(run, "block");

    expect(body).toContain('> "${RUNNER_TEMP}/failure_reason.txt"');
    expect(body).toContain("exit 1");
    expect(run).not.toMatch(/gh (issue|pr) comment/);
    expect(run).not.toContain("--add-label");
  });

  /**
   * The slices table (#174). The merged slice's row is gathered in a step of
   * its own right after the merge — so the merge still reads no verdict — from
   * the verdict on the **merged head** and the threads left open, and rendered
   * into the PRD PR body by the runner, which is handed the PRD PR only when a
   * slice merged. The gathering is executed in
   * `tests/implement-prd-preflight.test.ts`; the rendering and the splice are
   * `tests/slices-table.test.ts`.
   */
  it("gathers the merged slice's row after the merge, and hands the runner the PRD PR to write it into", () => {
    const steps = stepsOf(PRD);
    const at = steps.findIndex((s) => s.id === "slice_row");
    const step = steps[at];
    const run = step?.run ?? "";
    const agent = steps.find((s) => (s.run ?? "").includes("agent-workflows implement-prd"));

    expect(at).toBe(steps.findIndex((s) => s.id === "merge") + 1);
    expect(at).toBeLessThan(steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@")));
    expect(step?.if).toBe(`${NOT_REFUSED} && steps.merge.outputs.merged == 'true'`);
    expect(step?.env?.["GH_TOKEN"]).toBeUndefined();
    expect(run).toContain('gh api "repos/${GH_REPO}/commits/${head}/status"');
    expect(run).toContain('select(.context == "agent-review")');
    expect(run).toContain("head=$(jq -r '.headRefOid' <<< \"$pr\")");
    expect(run).toContain("reviewThreads");
    expect(run).toContain("select(.isResolved | not)");
    expect(run).toContain('> "${RUNNER_TEMP}/slices-table.json"');
    expect(run).not.toMatch(/gh (pr|issue) (edit|comment|merge|ready)/);
    expect(runOf(PRD, "preflight")).toContain('> "${RUNNER_TEMP}/prd-issue.json"');
    expect(agent?.env?.["PRD_PR"]).toBe("${{ steps.prd_pr.outputs.number }}");
    expect(agent?.env?.["OUTPUT_DIR"]).toBe("${{ runner.temp }}");
  });

  /**
   * The waiting slice PR is found by its **base**, never by the name of the
   * branch it comes from — a renamed slice branch must not hide it — and before
   * the finished refusal, since a PRD whose last slice PR is still open is not
   * finished. The no / one / many outcomes are executed in
   * `tests/implement-prd-preflight.test.ts`; this pins where they sit.
   */
  it("looks up open slice PRs by base, before it calls the PRD finished", () => {
    const run = runOf(PRD, "preflight");

    const lookup = run.split("\n").find((l) => l.startsWith("slice_prs=")) ?? "";

    expect(run).toContain("gh pr list --state open");
    expect(lookup).toContain('select(.baseRefName | startswith(\\"agent/prd-${ISSUE_NUMBER}-\\"))');
    expect(lookup).not.toContain("headRefName");
    expect(run.indexOf('"$open_slices" -gt 1')).toBeLessThan(run.indexOf("no open sub-issues"));
    expect(run.indexOf('"$open_slices" -eq 1')).toBeLessThan(run.indexOf("no open sub-issues"));
    expect(armOf(run, '"$open_slices" -gt 1')).toContain("block ");
  });

  /**
   * The preflight's state table (#177), every row safe to re-run. With no
   * sub-issue left, one open slice PR is the **finishing run**, and none with a
   * draft PRD PR resumes the handover — the PRD PR found by its head, the only
   * lookup here that reads one. The rows are executed in
   * `tests/implement-prd-preflight.test.ts`; this pins that the finishing run
   * is a run of its own, built on nothing the build steps do.
   */
  it("finishes the PRD in a run of its own once no sub-issue is left", () => {
    const run = runOf(PRD, "preflight");
    const finishing = armOf(run, 'if [ -z "$next" ]');

    expect(finishing).toContain('"$open_slices" -eq 1');
    expect(finishing).toContain('select(.headRefName | startswith(\\"agent/prd-${ISSUE_NUMBER}-\\"))');
    expect(finishing).toContain(".isDraft");
    expect(finishing).toContain("the PRD is finished");
    expect(finishing).toContain('echo "finishing=true"');
    expect(finishing).toContain("exit 0");
    expect(run.indexOf('if [ -z "$next" ]')).toBeLessThan(run.indexOf("/dependencies/blocked_by"));
    expect(run).toContain('echo "finishing=false"');
  });

  /**
   * The finishing run **runs no model**: it checks nothing out, installs no
   * toolchain and no Claude Code, and the runner — handed the run only to
   * write the last slice's row — exits before any agent starts. Nothing a
   * build does happens on it either.
   */
  it("runs no model on the finishing run", () => {
    const BUILDING = "steps.preflight.outputs.finishing == 'false'";
    const steps = stepsOf(PRD);
    const building = steps.filter(
      (s) =>
        (s.uses ?? "").startsWith("actions/checkout@") ||
        (s.run ?? "").includes("${{ inputs.setup }}") ||
        (s.if ?? "").includes("inputs.node-version-file") ||
        (s.run ?? "").includes("@anthropic-ai/claude-code") ||
        ["branch", "prepare", "slice_pr"].includes(s.id ?? "") ||
        /git push|gh issue close|--add-label "agent:review"/.test(s.run ?? ""),
    );
    const agent = steps.find((s) => (s.run ?? "").includes("agent-workflows implement-prd"));
    const runner = fs.readFileSync("implement-prd/implement-prd.ts", "utf8");

    expect(building.filter((s) => s.id !== "handover")).toHaveLength(10);
    for (const step of building.filter((s) => s.id !== "handover")) expect(step.if ?? "").toContain(BUILDING);
    expect(agent?.if).toBe(`${NOT_REFUSED} && (${BUILDING} || steps.merge.outputs.merged == 'true')`);
    expect(agent?.env?.["FINISHING"]).toBe("${{ steps.preflight.outputs.finishing }}");
    expect(runner).toContain('process.env["FINISHING"] === "true"');
    expect(runner.indexOf("writeSliceRow(PRD_PR)")).toBeLessThan(runner.indexOf("if (FINISHING)"));
    expect(runner.indexOf("if (FINISHING)")).toBeLessThan(runner.indexOf("sandcastle.run"));
  });

  /**
   * The handover (#177). More than one slice — a pre-upgrade slice counting —
   * asks for the integration review, and review marks the PRD PR ready; one
   * slice has had its review on its slice PR, so the PRD PR is marked ready
   * here. Both need AGENT_PAT. After the runner, so the last row is written
   * first, and the loop never merges the PRD PR nor approves anything. The
   * counting is executed in `tests/implement-prd-preflight.test.ts`.
   */
  it("hands the PRD PR over on the finishing run, and never merges or approves it", () => {
    const steps = stepsOf(PRD);
    const at = steps.findIndex((s) => s.id === "handover");
    const step = steps[at];
    const run = step?.run ?? "";

    expect(at).toBeGreaterThan(steps.findIndex((s) => (s.run ?? "").includes("agent-workflows implement-prd")));
    expect(at).toBeLessThan(steps.findIndex((s) => s.name === "Mark blocked on failure"));
    expect(step?.if).toBe(`${NOT_REFUSED} && steps.preflight.outputs.finishing == 'true' && success()`);
    expect(step?.env?.["PRD_PR"]).toBe("${{ steps.prd_pr.outputs.number || steps.preflight.outputs.prd_pr }}");
    expect(step?.env?.["PRD_BRANCH"]).toBe("${{ steps.merge.outputs.prd_branch || steps.preflight.outputs.prd_branch }}");
    expect(step?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
    expect(step?.env?.["HAS_PAT"]).toBe("${{ secrets.AGENT_PAT != '' }}");
    expect(armOf(run, 'if [ "$slices" -gt 1 ]')).toContain('--add-label "agent:review"');
    expect(armOf(run, 'if [ "$slices" -gt 1 ]')).toContain('gh pr ready "$PRD_PR"');
    expect(run.indexOf('"$HAS_PAT" != "true"')).toBeLessThan(run.indexOf("gh pr edit"));
    expect(bashFunctionBody(run, "block")).toContain('> "${RUNNER_TEMP}/failure_reason.txt"');

    const merges = fs
      .readFileSync(PRD, "utf8")
      .split("\n")
      .filter((l) => /\bgh pr (merge|review)\b/.test(l) && !l.trimStart().startsWith("#"));

    expect(merges).toEqual(['            gh pr merge "$SLICE_PR" "--${method}" --match-head-commit "$head" \\']);
  });

  /**
   * "Add `agent:review` to the PRD PR by hand" was the remedy for a run that
   * died after the last slice, in the finished refusal and in the failure
   * comment. The resume-the-handover row replaced it: the re-label is the
   * remedy, so neither place sends a human to the PRD PR any more.
   */
  it("sends nobody to add agent:review to the PRD PR by hand", () => {
    const preflight = runOf(PRD, "preflight");
    const failed = stepsOf(PRD).find((s) => s.name === "Mark blocked on failure");
    const run = (failed?.run ?? "")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");

    expect(preflight).not.toMatch(/agent:review/);
    expect(run).not.toMatch(/PRD PR[^.]*by hand|by hand instead/);
    expect(failed?.env?.["FINISHING"]).toBe("${{ steps.preflight.outputs.finishing }}");
    expect(armOf(run, 'if [ "${FINISHING}" = "true" ]')).toMatch(/resumes the handover/);
  });

  /**
   * Those two refusals are stops, not shapes: they fail into `Mark blocked on
   * failure` with a reason file, rather than commenting from the preflight.
   */
  it("blocks through the reason file and the failure step, not a comment of its own", () => {
    const body = bashFunctionBody(runOf(PRD, "preflight"), "block");

    expect(body).toContain('> "${RUNNER_TEMP}/failure_reason.txt"');
    expect(body).toContain("exit 1");
    expect(body).not.toContain("gh ");
    expect(body).not.toContain("refused=");
  });

  /**
   * Same `!= 'true'` gate as jeffwlawson/winget-manifest-lint#90: a preflight
   * that *dies* writes no output.
   */
  it("comments on a preflight that fails rather than refuses", () => {
    const blocked = stepsOf(PRD).find((s) => s.name === "Mark blocked on failure");

    expect(blocked?.if ?? "").toContain("steps.preflight.outputs.refused != 'true'");
    expect(blocked?.if ?? "").toContain("failure()");
    expect(blocked?.run ?? "").toContain('--add-label "agent:blocked"');
  });

  it("removes agent:in-progress however the run ends", () => {
    const last = stepsOf(PRD).at(-1);

    expect(last?.if ?? "").toContain("always()");
    expect(last?.run ?? "").toContain('--remove-label "agent:in-progress"');
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
   * and no `issues:` scope, and the workflow that spends the permission runs no
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
    expect(trade).toMatch(/automatic-fix bound is unchanged/);
    expect(section).toContain("Adds `agent:review` to **every** slice PR");
    expect(section).toMatch(/resumes the handover/);
  });

  /**
   * §10 names the clause it overturns in the words it used to be true in, and
   * keeps the bound it did not touch: the automatic fix is still once per pull
   * request, which is now once per slice PR and once on the PRD PR.
   */
  it("amends parity §10's review bullet, keeping the once-per-PR automatic fix", () => {
    const invariants = topLevel(parity, "## 10.");
    const amended = bullet(invariants, "Review is requested once per slice PR, plus one integration review.");

    expect(bullet(invariants, "Review is requested once per PR, never once per slice.")).toBe("");
    expect(amended).not.toBe("");
    expect(amended).toContain('"once per PR, never once per slice"');
    expect(amended).toMatch(/no per-slice\s+review workflow/);
    expect(amended).toMatch(/once per pull\s+request/);
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

    const second = context.split(/\n\n/).find((p) => p.includes("**advance job**")) ?? "";
    expect(second).toMatch(/second arrow/);
    expect(second).toMatch(/\*\*parent\*\*/);
    expect(second).toMatch(/\*\*bounded by the number of sub-issues\*\*/);

    const rows = context.match(/^\| `agent:implement` on .*\|$/gm) ?? [];
    expect(rows.find((r) => r.includes("**issue**"))).toContain("| `implement` |");
    const prd = rows.find((r) => r.includes("**PRD parent**")) ?? "";
    expect(prd).toContain("| `implement-prd` |");
    expect(prd).toMatch(/slice PR/);
    expect(prd).toMatch(/hand the PRD PR over/);
  });

  /**
   * What an adopter sees per verdict on a slice PR — every heading the verdict
   * table names, since each one moves the chain differently — beside the CI
   * note the zero-checks rule already added.
   */
  it("gives ADOPTING.md the slice-PR experience per verdict", () => {
    const section = subsection(adopting, /^### The verdict on a slice PR$/);

    expect(topLevel(adopting, "## 3b.")).toContain(section);
    expect(section).not.toBe("");
    for (const row of Object.values(VERDICTS)) expect(section).toContain(row.heading);
    expect(section).toMatch(/\*\*parks\*\*/);
    expect(section).toMatch(/\*\*waits\*\*/);
    expect(section).toContain("accepted by hand");
    expect(section).toContain("*Slice PRs and your CI*");
    expect(adopting).not.toMatch(/reviews once at the end/);
  });

  it("amends ticket-shape.md: one slice PR per sub-issue plus one PRD PR", () => {
    expect(ticketShape).not.toMatch(/one PR per PRD/);
    expect(ticketShape).toMatch(/one slice PR per sub-issue/);
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
    const callers = dependenciesIn(callerWorkflows).filter((d) => d.startsWith(LOOP));

    expect(callers.length).toBeGreaterThan(0);
    for (const dependency of [...callers, LOOP]) {
      expect(groupsFor(dependency)).toEqual([groupsFor(callers[0] as string)[0]]);
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
    "consumed on entry",
    "cursor",
    "marker, removed on success",
    // The fourth (#102). `agent:auto-fixed` records that this pull request's
    // one automatic fix is spent, which is a fact about the pull request's
    // whole life rather than about a run — so nothing clears it, and the
    // lifecycle it needed did not exist.
    "marker, never removed",
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
   * reading the file will reach for, and `agent:queued` — declared, inert, and
   * named in two workflow comments — is exactly that case.
   */
  it("names every agent label the workflow files name", () => {
    const used = [
      ...new Set(
        workflowFiles.flatMap((file) => fs.readFileSync(file, "utf8").match(/agent:[a-z-]+/g) ?? []),
      ),
    ].sort();

    expect(used.length).toBeGreaterThan(0);
    for (const label of used) expect(labelSection()).toContain(`\`${label}\``);
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

    for (const row of Object.values(VERDICTS)) {
      // The heading rather than the key: the heading is what an adopter sees on
      // their own pull requests, and the key is the machine-readable half only
      // `verdict.json` carries. Four rows share three headings, and the
      // descriptions below are what tell the two that share one apart here.
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
        whatChanged: { summary: "It moves thread resolution to the review.", changes: [] },
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
      showWhatChanged: true,
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
      "What changed in this PR",
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
    expect(NUMBERS[(written?.[1] ?? "").toLowerCase()]).toBe(callersIn(CALLER_DIR).length);
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
  it.each(agentWorkflows())("%s: grants packages: read", (file) => {
    expect(jobOf(file).permissions?.["packages"]).toBe("read");
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
