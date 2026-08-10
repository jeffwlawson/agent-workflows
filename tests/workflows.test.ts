import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
 * work against the PR's *real* base, not a hardcoded `main` (#71, #100).
 *
 * All three are named by their **reusable** half: the guards, the env and every
 * step live there, and each caller is a trigger and two wires (#97 for review,
 * #98 for the rest). A check aimed at a caller would pass by reading a file that
 * no longer contains the thing it is checking — which is the coverage failure
 * this whole file exists to catch, one level up.
 */
const PR_WORKFLOWS = [
  "review.yml",
  "fix.yml",
  "update-branch.yml",
].map((f) => path.join(WORKFLOW_DIR, f));

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
const RUNNER_SURFACE = ["cli.ts", "shared", "scripts", "fix", "implement", "implement-prd", "review", "update-branch"];

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
  // it — a called workflow can only downgrade the token it is handed (#98).
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
]);

const issuesWriteChecked = workflowFiles.filter(
  (f) => !ISSUES_WRITE_EXEMPT.has(path.basename(f)),
);

const indentOf = (s: string): number => s.length - s.trimStart().length;

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, string>;
  readonly "working-directory"?: string;
}

interface Job {
  readonly if?: string;
  readonly permissions?: Record<string, string>;
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: boolean };
  readonly steps?: readonly Step[];
  /** Set on a caller job — the reusable workflow it hands the work to (#97). */
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
 * The single job each agent workflow declares. Parsed rather than pattern
 * matched: the checks below are about step *order* and which step carries which
 * `if:`, and a regex over the raw text cannot see either.
 */
const jobOf = (file: string): Job => {
  const jobs = Object.values(workflowOf(file).jobs);

  expect(jobs).toHaveLength(1);
  return jobs[0] as Job;
};

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
const RUNNER_COMMANDS = ["fix", "implement", "implement-prd", "review", "update-branch"];
/** Both halves of the loop: what a caller grants and what the called job bounds. */
const agentWorkflows = (): readonly string[] => [...callerWorkflows, ...runnerWorkflows];
const runnerWorkflows = RUNNER_COMMANDS.map((c) => path.join(WORKFLOW_DIR, `${c}.yml`));

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

/** The review job — the reusable half, where every step now lives (#97). */
const REVIEW = path.join(WORKFLOW_DIR, "review.yml");
/** …and the caller that triggers it. */
const REVIEW_CALLER = path.join(CALLER_DIR, "review.yml");

/**
 * The two workflows that share the `agent:implement` label (#92), again named by
 * the half that holds the steps (#98).
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
 * scalars would pass over the very line #71 fixed.
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
 * rather than on `npm ci`: the command is the adopter's since #98, and a filter
 * still naming this repo's would match nothing and pass by finding nothing.
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
   * `review`, which was granted it unused (#101). Granted-but-unused reads as
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
 * A hardcoded `main` is the #71/#100 failure class: on a PR stacked on another
 * branch — or in a repo whose default branch is `master` — every git operation
 * silently addresses the wrong branch. No error, wrong result.
 *
 * #71 and #100 fixed the three PR workflows, which read the base from the event.
 * The two `implement` workflows have no event field to read: they *choose* a
 * branch to work from, and #98 made that choice the `default-branch` input
 * rather than a literal. So the rule is now one rule over the whole loop — no
 * workflow, and no runner, names a default branch of its own.
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
   * package (#96), so a `main` in one is not a hand-edit an adopter forgot but a
   * branch name they have no way to change at all.
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
 * One group per PR, across every workflow that touches it (#102). Review used
 * to sit in `agent-review-pr-*` while fix and update-branch shared
 * `agent-mutate-pr-*`, so a review could diff a branch *while* a fix pushed to
 * it — a review of a tree state that never existed. The hazard is review
 * reading during another job's write, which its `contents: read` does nothing
 * to prevent.
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
    // id>`, so every sibling was renamed by the conversion (#98). This check
    // used to assert the pattern *contained* the words `review`, `fix` and so
    // on — which `^(review|fix|update-branch|implement)$` did while matching
    // none of the names below, so it stayed green over a review that would
    // queue behind a labelled `fix` and burn its whole 900 s on it.
    //
    // Deduplicated because there are two caller sets — the reference copies and
    // this repo's own — and they deliberately share job ids, so both produce
    // the same five names. The property is about the names the loop emits, not
    // how many files happen to emit them.
    const checkRuns = [
      ...new Set(
        callerWorkflows.map(
          (file) => `${Object.keys(workflowOf(file).jobs)[0]} / ${Object.keys(workflowOf(targetOf(file)).jobs)[0]}`,
        ),
      ),
    ];

    expect(checkRuns).toHaveLength(5);
    for (const name of checkRuns) expect(name).toMatch(excluded);
    // Bare job ids too — an adopter is free to inline a job rather than call
    // one, and the pattern predates the split.
    for (const name of ["review", "fix", "update-branch", "implement", "implement-prd"]) {
      expect(name).toMatch(excluded);
    }

    // Bounded at both ends, or the exclusion eats the CI it exists to collect.
    // These are repo checks whose names merely start or end near an agent's.
    for (const name of ["fixtures", "CI", "CI / verify", "CI / fix-lint", "build / fixtures"]) {
      expect(name).not.toMatch(excluded);
    }
    // Both jq filters — the one that decides whether to keep waiting and the
    // one that writes the list into the prompt. A pattern only the second used
    // would still deadlock on a queued agent job.
    const filters = [...(waitStep().run ?? "").matchAll(/test\(\\"\$\{AGENT_CHECKS\}\\"\)/g)];

    expect(filters).toHaveLength(2);
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
 * blamed a missing `AGENT_PAT` for it (#102).
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
 * head SHA in its `labeled` payload — the checkout, and `commit_id` on the
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
 * The whole loop is now callable (#98, slice 4 of #88; #97 proved the pattern on
 * review). The loop is the deliverable and it is installed in other repos, so
 * what an adopter writes per workflow has to be a trigger and two wires — every
 * control stays on this side, in a file they reference rather than copy.
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
   * Five pairs, and *only* five: a workflow that is neither half of one is a
   * workflow an adopter would have to copy. Derived from `uses:` rather than
   * from the file names, so a half-done conversion — a `-reusable.yml` with no
   * caller, or a caller left doing the work itself — lands here rather than
   * being silently bucketed.
   */
  it("splits every agent workflow into a caller and a runner", () => {
    expect(callerWorkflows.map((f) => path.basename(f)).sort()).toEqual([
      "agent-fix.yml",
      "agent-implement-prd.yml",
      "agent-implement.yml",
      "agent-review.yml",
      "agent-update-branch.yml",
      "fix.yml",
      "implement-prd.yml",
      "implement.yml",
      "review.yml",
      "update-branch.yml",
    ]);
    // Both caller sets point at the same five reusables, so dedupe before
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

    expect(trigger?.types).toEqual(["labeled"]);
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
   * Permissions are declared **twice** — for opposite reasons, which is why this
   * is not the duplication it looks like.
   *
   * A called workflow can only *downgrade* the token it is handed. So the
   * callee's block is the bound: it cannot be widened from the caller, which is
   * what keeps `contents: read` on review an invariant (docs/parity.md §10). And
   * the caller's block is the grant: on a repo whose default `GITHUB_TOKEN` is
   * read-only, a permission declared only in the callee grants nothing, and
   * every `gh` call needing it 403s — a run that costs a full agent pass and
   * silently transitions no label at all.
   *
   * Asserted as equality between the halves rather than against a table, so the
   * property held is the one that matters: neither half can drift from the
   * other, whatever the job ends up needing.
   */
  it.each(callerWorkflows)("%s: grants exactly what the called job bounds", (file) => {
    const granted = jobOf(file).permissions;

    expect(granted).toEqual(jobOf(targetOf(file)).permissions);
    expect(Object.keys(granted ?? {})).not.toHaveLength(0);
  });

  /**
   * Named, not inherited. `secrets: inherit` hands the called workflow every
   * secret the repository holds, including the ones this loop has no use for —
   * and it is the form that reads as tidier, so the list is worth pinning.
   */
  it.each(callerWorkflows)("%s: passes both secrets by name", (file) => {
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

  it.each(runnerWorkflows)("%s: declares the three shared inputs, typed and described", (file) => {
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
  it.each(runnerWorkflows)("%s: takes the toolchain from the caller", (file) => {
    const node = stepsOf(file).find((s) => (s.uses ?? "").startsWith("actions/setup-node@"));
    const install = stepsOf(file).find((s) => (s.run ?? "").includes("${{ inputs.setup }}"));

    expect(node?.with?.["node-version-file"]).toBe("${{ inputs.node-version-file }}");
    expect(node?.if ?? "").toContain("inputs.node-version-file != ''");
    expect(install?.if ?? "").toContain("inputs.setup != ''");
  });
});

/**
 * The one input that is a fact about the *caller* rather than about the repo,
 * and the one control the extraction itself put at risk (#97).
 */
describe("agent-review tells its caller what it cannot know", () => {
  const caller = (): Job => jobOf(REVIEW_CALLER);
  const call = () => workflowOf(REVIEW).on?.workflow_call;

  /**
   * `contents: read` is the invariant that bounds what a wrong review can do
   * (docs/parity.md §10). The generic check above holds the two halves equal to
   * each other; this is the one pair where the *value* is the point.
   */
  it.each([
    ["the caller grants", REVIEW_CALLER],
    ["the called job bounds", REVIEW],
  ])("%s exactly the permissions the job uses", (_half: string, file: string) => {
    expect(jobOf(file).permissions).toEqual({
      contents: "read",
      // Installing the runner package, not reading the PR — the one scope here
      // that is about the toolchain rather than about the review.
      packages: "read",
      "pull-requests": "write",
    });
  });

  it("declares the self-check input, typed and described", () => {
    const input = call()?.inputs?.["self-check"];

    expect(input?.type).toBe("string");
    expect(input?.description ?? "").not.toBe("");
  });

  /**
   * The CI wait polls every check on the head commit and excludes its own, or
   * it waits for itself: 15 of this job's 20 minutes, then a review with
   * degraded evidence — the failure mode #48 exists to prevent, reintroduced by
   * the extraction.
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
  it("excludes its own check run from the wait, in both filters", () => {
    const step = waitStep();

    expect(step.env?.["SELF_CHECK"]).toBe("${{ inputs.self-check }}");
    const filters = [...(step.run ?? "").matchAll(/select\(\.name != env\.SELF_CHECK\)/g)];

    expect(filters).toHaveLength(2);
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
    const [calledJob] = Object.keys(workflowOf(REVIEW).jobs);

    expect(caller().with?.["self-check"]).toBe(`${callerJob} / ${calledJob}`);
  });
});

/**
 * The issue-side equivalent (#102). `agent-implement`'s preflight only listed
 * *open* PRs, so a merged-and-closed issue that got relabelled checked out
 * `main`, found the work already there, and died at "no commits were made" —
 * or, worse, invented a spurious change and opened a duplicate PR.
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
 * Issue *shape* (#90). An issue's position in a hierarchy decides whether it can
 * be implemented at all, and the workflow used to accept anything carrying the
 * label:
 *
 * - **has a parent** — a sub-issue implemented alone loses the ordering and the
 *   shared context its parent holds; the parent drives it or nobody does.
 * - **`wayfinder:*`** — maps and decision tickets are planning artifacts. They
 *   describe work; they are not work.
 *
 * Both are refused in the preflight step, which is what keeps them job-level
 * rather than agent-level: no checkout, no `npm ci`, no `agent:in-progress`.
 *
 * The third shape — **has sub-issues** — was refused too until #92, and is now
 * handed to `agent-implement-prd` instead. See the partition describe below.
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
 * `agent-implement-prd` (#92) is triggered by the **same label on the same
 * event** as `agent-implement`, so both jobs start on every `agent:implement`
 * label event and the pair has to partition the work between them. The key is
 * the sub-issue count: an issue that has sub-issues belongs to the PRD path,
 * every other shape to `agent-implement`.
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
   * The trigger is on the caller and the label guard on the called job (#98) —
   * so the pair is read across both halves, which is what the partition
   * actually depends on: two workflows woken by one event, each deciding for
   * itself whether the shape is theirs.
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
   * been first since #102, when nothing else claimed the label).
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
 * The PRD chain itself. One sub-issue per run, in sub-issues API order,
 * accumulating onto one branch and one PR, chaining to the next run by
 * re-labelling the parent, and asking for review exactly once at the end.
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

  /** One query for parent, labels and the sub-issue list together — see #90. */
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

  /** Same exception as #90: "no answer" must never be read as a shape. */
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
   * **Plain `git push`.** `agent-implement` force-pushes because it owns a
   * branch it created this run; here the branch carries every earlier slice, so
   * a force push is a chain that silently eats its own history. A rejected
   * non-fast-forward is the correct outcome instead.
   */
  it("pushes without force", () => {
    const text = fs.readFileSync(PRD, "utf8");

    expect(text).toContain('git push origin "$BRANCH"');
    expect(text).not.toMatch(/git push[^\n]*--force/);
  });

  /** The PR is opened once and reused, the same way the branch is. */
  it("reuses one PR across the chain", () => {
    const run = runOf(PRD, "pr");

    expect(run).toContain('gh pr list --head "$BRANCH"');
    expect(run.indexOf("gh pr list")).toBeLessThan(run.indexOf("gh pr create"));
    // Draft until review says otherwise: a PR mid-chain is precisely a pipeline
    // that has not finished (docs/parity.md §10).
    expect(run).toContain("gh pr create --draft");
  });

  it("closes the finished sub-issue with a comment naming the commit", () => {
    const close = stepsOf(PRD).find((s) => (s.run ?? "").includes("gh issue close"));

    expect(close?.if ?? "").toContain(NOT_REFUSED);
    expect(close?.if ?? "").toContain("success()");
    expect(close?.run ?? "").toContain("git rev-parse HEAD");
    expect(close?.run ?? "").toContain("--comment");
  });

  /**
   * Chain or hand off, never both, and gated on a **re-read** count rather than
   * on the preflight's snapshot minus one — a sub-issue may have been added or
   * closed by hand while the agent was running.
   */
  it("chains while sub-issues remain and requests review when none do", () => {
    const chain = stepsOf(PRD).find((s) => (s.run ?? "").includes('--add-label "agent:implement"'));
    const review = stepsOf(PRD).find((s) => (s.run ?? "").includes('--add-label "agent:review"'));

    expect(runOf(PRD, "remaining")).toContain("gh api graphql");
    expect(chain?.if ?? "").toContain("steps.remaining.outputs.count != '0'");
    expect(review?.if ?? "").toContain("steps.remaining.outputs.count == '0'");
    expect(chain?.run ?? "").toContain('gh issue edit "$ISSUE_NUMBER"');
  });

  /**
   * Both label adds are silent no-ops under `GITHUB_TOKEN` — the anti-recursion
   * rule (docs/ADOPTING.md §1). For the chain that is worse than for review: the
   * label appears on the parent and the next slice simply never happens, which
   * reads as "still working" forever.
   */
  it.each(['--add-label "agent:implement"', '--add-label "agent:review"'])(
    "warns loudly when AGENT_PAT is absent for `%s`",
    (adds: string) => {
      const step = stepsOf(PRD).find((s) => (s.run ?? "").includes(adds));

      expect(step?.env?.["GH_TOKEN"]).toBe("${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}");
      expect(step?.env?.["HAS_PAT"]).toBe("${{ secrets.AGENT_PAT != '' }}");
      expect(step?.run ?? "").toContain("::warning::");
    },
  );

  /**
   * …and fails when the add itself fails, which is a different thing and needs
   * `-e` to hold. Both steps end with that warn-if-no-PAT `if`, which returns 0
   * whenever the PAT *is* set — and it is the last command, so without `-e` a
   * failed `gh ... --add-label` exits the step green. `Mark blocked on failure`
   * is gated on `failure()` and would never fire: the chain halts on a green
   * run with no agent label left on the parent, or the PR sits finished and in
   * draft with nobody asked to review it.
   */
  it.each(['--add-label "agent:implement"', '--add-label "agent:review"'])(
    "fails the run rather than swallowing a failed `%s`",
    (adds: string) => {
      const step = stepsOf(PRD).find((s) => (s.run ?? "").includes(adds));

      expect(step?.run ?? "").toContain("set -euo pipefail");
    },
  );

  /**
   * Every step after `Close the finished sub-issue` fails with that sub-issue
   * *already closed*, so on the last slice the failure comment's own remedy —
   * re-apply `agent:implement` — lands on the finished-PRD refusal instead of
   * retrying anything. Both ends of that loop therefore have to name the other
   * way in: the PR, still open and in draft, wanting `agent:review` by hand.
   * Otherwise it is the remedy-that-refuses-again trap the single-issue
   * preflight warns about, with no exit at all.
   */
  it("names the draft PR as the way out when the chain dies after its last close", () => {
    const failed = stepsOf(PRD).find((s) => (s.run ?? "").includes("failure_reason.txt"));

    expect(failed?.env?.["PR_NUMBER"]).toBe("${{ steps.pr.outputs.number }}");
    expect(failed?.run ?? "").toContain("agent:review");
    expect(armOf(runOf(PRD, "preflight"), "no open sub-issues")).toContain("agent:review");
  });

  /** Same `!= 'true'` gate as #90: a preflight that *dies* writes no output. */
  it("comments on a preflight that fails rather than refuses", () => {
    const blocked = stepsOf(PRD).find((s) => (s.run ?? "").includes("failure_reason.txt"));

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
 * addressed by path (#96).
 *
 * That is what retires the stale-runner trap. `pull_request_target` takes the
 * workflow YAML from the *base* branch and checks out the **PR head**, so
 * `npx tsx .sandcastle/…/review.ts` ran whatever version of the runner the PR
 * happened to carry — silently, with no error, which is how #46 reviewed a diff
 * with the pre-suggestion `review.ts`. A version in the YAML is on the base side
 * of that split, so the runner is base-controlled like every other security
 * control in these files.
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
   * are one workflow with one runner between them (#97).
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
   * commands `init` / `doctor` (#112) share an entry point and therefore a
   * version, so "which runner version is this repo on?" has one answer rather
   * than five.
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
});

/**
 * …and the registry it is pinned *on* is GitHub Packages, not npmjs.
 *
 * That choice adds one thing to every workflow and one thing to every caller,
 * and neither fails in a way that names itself. GitHub Packages has **no
 * anonymous install** — even for a public package — so the install needs a
 * scoped `.npmrc` and a token, and a missing `packages: read` surfaces as a 401
 * at `npx` time, which reads like a bad token rather than a missing grant.
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
  it.each(runnerWorkflows)("%s: authenticates after the toolchain, before the run", (file) => {
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
   * Gated exactly as the run it exists for. An ungated auth step would run on
   * every refusal — cheap, but it is the same `setup-node` the refusal checks
   * elsewhere in this file assert a refused run never reaches.
   */
  it.each(runnerWorkflows)("%s: is gated the same as the run it serves", (file) => {
    expect(authStep(file)?.if).toBe(stepsOf(file)[runnerStepIndex(file)]?.if);
  });

  /**
   * `setup-node` writes `_authToken=${NODE_AUTH_TOKEN}` into the `.npmrc` and
   * exports a placeholder value, so the variable is not optional — without it
   * the install fails against a token that was never a token.
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
 * The publish side of the same registry (#113 review). One workflow, one tag
 * shape, two guards.
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
 * never spawn a shell. Same rule as `git` (issue #75), and the same reason: a
 * value that reaches a subprocess as syntax is a value someone else can write.
 * The workflow half ships too and reaches `gh` from bash; there the boundary is
 * a quoted env var (`gh pr edit "$PR_NUMBER"`), not argv, and this test says
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
 * `.sandcastle/` is the agent loop, and the loop is the deliverable (#88) — it
 * ships to other repos rather than living in this one. So nothing in it may name
 * this repo's domain, and nothing in it may name this repo's toolchain.
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
   * The four terms are this repo's domain vocabulary as it actually leaked (#95):
   * the product name, the field that is the whole role-vs-`ManifestType`
   * distinction, the directory rules are registered in, and the constructor a
   * rule is defined with.
   *
   * `.ts` files are in scope too, not only prompts — `shared/common.ts` carried
   * the repo name as a Standard Schema `vendor`, which is exactly the kind of
   * site a prompt-focused pass reads straight past.
   */
  const DOMAIN = /winget|ManifestType|src\/rules|defineRule/;

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
