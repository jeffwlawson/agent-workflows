import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as sandcastle from "@ai-hero/sandcastle";

export const outputDir = (): string => process.env["OUTPUT_DIR"] ?? "/tmp";

/**
 * Write the reason somewhere the workflow's `if: failure()` step can read it,
 * then exit non-zero. Without this the issue comment can only say "check the
 * logs", which in practice means nobody checks.
 */
export const fail = (message: string): never => {
  console.error(`\nFAILED: ${message}`);
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), "failure_reason.txt"), message);
  process.exit(1);
};

/**
 * Read an input the workflow step was supposed to set, failing the run when it
 * did not.
 *
 * Out through `fail`, not `process.exit`, and that is the whole point of the
 * function: this runs at module scope, before any of a runner's own work, so
 * the run it ends is the one with nothing else in its log to go on. Exiting
 * silently left the comment reading `(no reason file written)` — the same
 * string a runner that will not load at all produces, one signature for two
 * causes whose difference is the only thing worth knowing (`docs/friction.md`,
 * 2026-08-08).
 *
 * Empty counts as missing: GitHub interpolates an unset `vars.X` into `""`
 * rather than into nothing, so a `with:` input a caller declared and never
 * filled in arrives set and empty.
 */
export const required = (name: string): string => {
  const value = process.env[name];
  // `return`, rather than a bare call and a fallthrough: `fail` is a const, so
  // TypeScript does not narrow on its `never` return and would still see
  // `string | undefined` below.
  if (!value) return fail(`Missing required env var: ${name}`);
  return value;
};

/**
 * Run a **literal** command through a shell, throwing on a non-zero exit. The
 * rule is *variables go through argv*, not *never use `sh`* (#75): anything
 * holding a value goes to `git()`, and anything reaching a GitHub surface to
 * `gh()` or `safeGh()`, neither of which spawns a shell. Three `gh` calls were
 * once built as text for this, and the only thing keeping a crafted issue
 * reference out of `/bin/sh` was a regex three files away (#2, #10). A test
 * walks the runner surface for that shape, so a fourth is caught on arrival.
 */
export const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * The model agents run on unless something overrides it. Pinned deliberately
 * rather than floating: the same reasoning as `.nvmrc` — the runner, CI and a
 * local run must not silently drift onto different versions. Bumping it is a
 * decision, so it gets a commit or a variable change.
 */
const DEFAULT_MODEL = "claude-opus-5";

/**
 * Per-workflow defaults, listed only where they differ from `DEFAULT_MODEL`.
 *
 * `update-branch` is the one mechanical job in the set: the workflow merges in
 * bash and only wakes the agent when git reports a conflict, so the task is
 * "reconcile two known texts" rather than "design something". Sonnet is sized
 * for that.
 *
 * Caveat worth keeping visible — the one real conflict this has resolved was
 * *not* purely mechanical (see friction.md, 2026-07-25): a naive "preserve both
 * sides" merge would have re-listed shipped features as future work, and the
 * agent avoided that by noticing what had actually shipped. If a future
 * conflict is resolved badly, this row is the first thing to suspect; raise it
 * by setting AGENT_MODEL_UPDATE_BRANCH rather than editing code.
 */
const WORKFLOW_MODELS: Record<string, string> = {
  "update-branch": "claude-sonnet-5",
};

/** Workflow name → the env var that overrides it. `update-branch` → `AGENT_MODEL_UPDATE_BRANCH`. */
const overrideVar = (workflow: string): string =>
  `AGENT_MODEL_${workflow.toUpperCase().replace(/-/g, "_")}`;

/**
 * Resolve the model, most specific wins:
 *
 *   AGENT_MODEL_<WORKFLOW>  → this workflow only
 *   AGENT_MODEL             → every workflow, including ones with a per-workflow
 *                             default; "run everything on X" is the whole point
 *                             of setting it, so it deliberately outranks the
 *                             table above
 *   WORKFLOW_MODELS         → the baked per-workflow default
 *   DEFAULT_MODEL           → everything else
 *
 * `||` rather than `??` throughout: GitHub interpolates an **unset** `vars.X`
 * into the empty string, not into nothing, so on any repo that has not set the
 * variable the env var arrives as `""`. `??` would pass that straight through
 * and hand the CLI an empty model id.
 */
interface ResolvedModel {
  readonly model: string;
  /** Which rung of the chain won, for the log line. */
  readonly source: string;
}

/**
 * The ordering lives here **once**. It previously existed twice — once to pick
 * the model and once to name the winner for the log — which meant reordering
 * one and not the other would have the log confidently report the wrong source.
 * A log that lies about provenance is worse than no log, and nothing would have
 * caught it: the naming half was unexported and untestable.
 */
const resolveModel = (workflow: string): ResolvedModel => {
  const perWorkflowOverride = process.env[overrideVar(workflow)];
  if (perWorkflowOverride) return { model: perWorkflowOverride, source: overrideVar(workflow) };

  const globalOverride = process.env["AGENT_MODEL"];
  if (globalOverride) return { model: globalOverride, source: "AGENT_MODEL" };

  const perWorkflowDefault = WORKFLOW_MODELS[workflow];
  if (perWorkflowDefault) return { model: perWorkflowDefault, source: `${workflow} default` };

  return { model: DEFAULT_MODEL, source: "default" };
};

export const agentModel = (workflow: string): string => resolveModel(workflow).model;

/**
 * @param workflow Directory name under `agent-workflows/` — `implement`,
 *   `fix`, `review`, `update-branch`. Drives model selection, so it
 *   must match the directory or the workflow silently gets the global default.
 */
export const claudeAgent = (workflow: string) => {
  const { model, source } = resolveModel(workflow);
  // Echoed so a run is self-documenting — "which model produced this?" is the
  // first question asked of any output that looks off, and the answer should
  // not require knowing what a repository variable was set to that week.
  console.log(`Agent model: ${model} (${source})`);
  return sandcastle.claudeCode(model, {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: required("CLAUDE_CODE_OAUTH_TOKEN"),
    },
  });
};

/**
 * Where `gh` should think it is. `gh` resolves `{owner}/{repo}` and every
 * repo-scoped subcommand from the git remote of its working directory, so a
 * command asked about *another* checkout — which is what `doctor --dir` is —
 * answers about this one unless it is told otherwise, and answers confidently.
 */
export interface GhOptions {
  readonly cwd?: string | undefined;
}

/** Run `gh` with argv (no shell), so arguments with spaces/quotes are safe. */
export const gh = (args: string[], options: GhOptions = {}): string =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

/**
 * `gh` with argv, returning "" instead of throwing when it exits non-zero.
 *
 * Both halves are load-bearing. The argv half is the same rule as `gh` and
 * `git`: a variable reaching a subprocess must arrive as one argument, not as
 * text a shell re-parses. The swallowing half is what `fetchTrustedIssue` and
 * `fetchTrustedComments` need — for them a missing issue is an ordinary outcome
 * absorbed by `|| "{}"` / `|| "[]"`, so `gh()`'s throw would turn an absence
 * into an exception mid-run. That mismatch is why this is a wrapper rather than
 * a call-site swap (issue #2).
 */
export const safeGh = (args: readonly string[], options: GhOptions = {}): string => {
  try {
    return gh([...args], options);
  } catch {
    return "";
  }
};

/** What `gh` did, when the caller has to rule on the answer rather than on the exit code. */
export interface GhOutcome {
  /** True when `gh` exited zero. */
  readonly ok: boolean;
  /** What `gh` printed to stdout — present on a non-zero exit too, and often the whole answer. */
  readonly stdout: string;
  /** What `gh` printed to stderr, which is where it explains a refusal in words. */
  readonly stderr: string;
}

/** `execFileSync` hands back whatever the stdio encoding produced; normalise it to text. */
const capturedText = (value: unknown): string =>
  typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";

/**
 * `gh` with argv, returning its **output** on a non-zero exit rather than
 * throwing it away.
 *
 * The third wrapper, and the reason it is not one of the other two: GraphQL
 * answers partially. A query whose selections are mostly fine and one of which
 * is forbidden returns `200` with valid `data` *and* an `errors[]` array, and
 * `gh` exits non-zero on that response while printing the good data to stdout
 * (#76). `gh()` throws it away because `execFileSync` throws; `safeGh()`
 * swallows it into `""`, which its two callers want — for them a missing issue
 * is an ordinary absence — and which here is the same information loss by a
 * politer route.
 *
 * So this is for the caller that must *inspect* what came back: a response is
 * the evidence, the exit code is not. Deliberately not a widening of `safeGh`,
 * whose swallowing is load-bearing where it is used.
 */
export const ghOutcome = (args: readonly string[], options: GhOptions = {}): GhOutcome => {
  try {
    return { ok: true, stdout: gh([...args], options), stderr: "" };
  } catch (error) {
    const thrown = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: capturedText(thrown.stdout), stderr: capturedText(thrown.stderr) };
  }
};

/**
 * Run `git` with argv (no shell) — the same decision as `gh`, for the same
 * reason. Use this whenever a **variable** reaches git: `execFileSync` passes
 * each element as one argument and never spawns `/bin/sh`, so a value cannot be
 * re-parsed as syntax. Git ref names may legally contain `` ` ``, `$()`, `;`,
 * `|` and `&` (`git check-ref-format --branch` permits all five), so "it's only
 * a branch name" is not a reason to skip it.
 *
 * Literal `sh("git ...")` calls elsewhere are fine and deliberately left alone:
 * the rule is *variables go through argv*, not *never use `sh`* (issue #75).
 */
export const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Remove the GitHub token from this process's environment. The agent runs
 * unsandboxed (`noSandbox` merges `process.env`) and its Bash tool can read the
 * environment, so a prompt-injected agent could use `gh` to act on the repo or
 * exfiltrate the token. Neither runner's agent legitimately needs it: issue/PR
 * context is fetched *before* the agent starts, and all pushing/labelling/
 * commenting happens in separate workflow steps.
 *
 * Scope and limits: this affects only the current Node process and its
 * children, not later workflow steps. It does NOT remove the git credentials
 * `actions/checkout` persists — from v6 in a `$RUNNER_TEMP` file that
 * `.git/config` includes rather than in `.git/config` itself, which changes
 * where they are and not that `git` finds them. Preventing `git push` is a
 * separate control (`contents: read`, or `persist-credentials: false`).
 */
export const scrubGitHubTokens = (): void => {
  delete process.env["GH_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
};

/**
 * What the association half of the gate establishes is **org-adjacent or
 * better**, which is not the same thing as repository write access. Only
 * `OWNER` is write-gated by its own definition; GraphQL describes the other
 * two as "Author has been invited to collaborate on the repository"
 * (`COLLABORATOR` — which includes the Read and Triage roles, neither of which
 * can push) and "Author is a member of the organization that owns the
 * repository" (`MEMBER` — org membership, implying no repository grant at
 * all). Introspected from `CommentAuthorAssociation` on 2026-09-20; evidence
 * and method in #35.
 *
 * The two readings coincide on a personal repository — a collaborator there
 * has write, and `MEMBER` cannot occur without an owning org — and come apart
 * on an organization one. So this set is write-gated *here* and not in
 * general, which is the wrong way round: the adopter is the one exposed.
 *
 * The belief that association implied write access was adopted locally from a
 * community pattern, not from GitHub, which describes the field only as "How
 * the author is associated with the repository" and publishes the
 * OWNER/MEMBER/COLLABORATOR triple nowhere (#71).
 *
 * Whether the set itself should narrow is the open decision at #68. Until it
 * is taken, every description of this gate says what it establishes rather
 * than what it was believed to.
 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Our own workflows post as `github-actions[bot]`, and its
 * `author_association` is never one this gate trusts — the value is
 * repository-dependent, `NONE` where the bot has never committed and
 * `CONTRIBUTOR` where it has (`nodejs/node` #66163 and #65881, checked
 * 2026-09-20, #71), and neither is in the set above. So an association-only
 * gate would discard the review agent's own findings and break the review
 * → fix handoff, on this repository and on an adopter's alike.
 *
 * Trusting this one login is sound because the identity is *transitively
 * write-gated*: only a workflow in this repository can post as it, and adding
 * or editing a workflow requires write access. That is a property of the
 * login. The association half above establishes rather less (#68), so this is
 * the stronger of the two halves rather than a convenience on top of it.
 *
 * Deliberately NOT `user.type === "Bot"` in general — that would also trust
 * Dependabot and any GitHub App an admin installs, which is a far wider
 * surface for a workflow that commits code.
 */
// Both spellings on purpose: the REST API reports this account as
// `github-actions[bot]`, GraphQL reports the same account as `github-actions`.
// Listing only one silently drops our own review's comments on whichever path
// uses the other.
const WORKFLOW_BOT_LOGINS = new Set(["github-actions[bot]", "github-actions"]);

/**
 * The login half of the gate on its own, for the one caller that must **not**
 * take the association half: filing issues from a review body asks "is this the
 * review runner's own output", not "is this from someone trusted", and the
 * wider question would admit a human collaborator's hand-written review.
 *
 * Named rather than re-listed there, so the two spellings above stay one fact.
 *
 * What this does not establish, stated so it is not mistaken for an oversight:
 * the workflow bot is the identity of *every* workflow in a repository, so this
 * says a workflow posted it and never *which* workflow did.
 */
export const isWorkflowBot = (login: string | undefined): boolean =>
  WORKFLOW_BOT_LOGINS.has(login ?? "");

export const isTrustedAuthor = (association: string | undefined, login: string | undefined): boolean =>
  TRUSTED_ASSOCIATIONS.has(association ?? "") || isWorkflowBot(login);

export interface TrustedIssue {
  readonly title: string;
  readonly body: string;
  /**
   * True only when the author passes `isTrustedAuthor`: a trusted association
   * — org-adjacent or better, which on an organization repository is weaker
   * than write access (#68) — or our own workflow login.
   */
  readonly trusted: boolean;
}

/**
 * Fetch an issue's title and body, but treat them as usable ONLY when the issue
 * author is OWNER / MEMBER / COLLABORATOR — org-adjacent or better, not
 * necessarily write-gated; see `TRUSTED_ASSOCIATIONS` and #68.
 *
 * Why: on a public repo anyone can *open* an issue with arbitrary title and
 * body, and this text is fed verbatim to an unsandboxed agent that holds tokens
 * and produces public output — a prompt-injection / exfiltration source. Author
 * association is the structural boundary, not the field: title and body from an
 * author the repository already knows sit behind the same trust boundary the
 * rest of the loop assumes. Comments are never fetched at all — they are
 * world-writable regardless of who opened the issue.
 */
export const fetchTrustedIssue = (issueNumber: string): TrustedIssue => {
  const ghRepo = process.env["GH_REPO"] ?? "";
  let parsed: {
    title?: string;
    body?: string | null;
    author_association?: string;
    user?: { login?: string };
  } = {};
  try {
    parsed = JSON.parse(safeGh(["api", `repos/${ghRepo}/issues/${issueNumber}`]) || "{}");
  } catch {
    parsed = {};
  }
  if (!isTrustedAuthor(parsed.author_association, parsed.user?.login)) {
    return { title: "", body: "", trusted: false };
  }
  return { title: parsed.title ?? "", body: (parsed.body ?? "").trim(), trusted: true };
};

/**
 * Fetch the conversation comments on an issue or PR, keeping ONLY those authored
 * by a repo collaborator (same trust boundary as `fetchTrustedIssue`). This is
 * what lets a maintainer steer the agent with a comment; a drive-by comment from
 * a non-collaborator is dropped. Returns "" when there are none.
 *
 * The `issues/{n}/comments` endpoint serves both issues and PRs (a PR is an
 * issue for this endpoint). It does NOT include inline review-thread comments —
 * those are a separate surface handled by the full review workflow, and would
 * need the same author gate. Only the first page (~30, oldest-first) is read;
 * that is plenty for steering and avoids pulling a huge thread into the prompt.
 */
export const fetchTrustedComments = (number: string): string => {
  const ghRepo = process.env["GH_REPO"] ?? "";
  let comments: { body?: string; author_association?: string; user?: { login?: string } }[] = [];
  try {
    comments = JSON.parse(safeGh(["api", `repos/${ghRepo}/issues/${number}/comments`]) || "[]");
  } catch {
    comments = [];
  }
  return comments
    .filter((c) => isTrustedAuthor(c.author_association, c.user?.login))
    .map((c) => `**@${c.user?.login ?? "unknown"}:**\n${(c.body ?? "").trim()}`)
    .filter((text) => text.trim().length > 0)
    .join("\n\n---\n\n");
};

/**
 * The Actions run this process is part of, or `undefined` off a runner.
 *
 * Composed from the three variables every Actions step is given rather than
 * from an input the workflow sets, because that is what they are: a step that
 * had to pass them could forget to, and there is nothing a runner could do
 * about a link it was not handed. `undefined` rather than a guess, so a caller
 * renders no link instead of a dead one.
 */
export const workflowRunUrl = (): string | undefined => {
  const server = process.env["GITHUB_SERVER_URL"];
  const repo = process.env["GITHUB_REPOSITORY"];
  const runId = process.env["GITHUB_RUN_ID"];
  if (!server || !repo || !runId) return undefined;
  return `${server}/${repo}/actions/runs/${runId}`;
};

/**
 * Renders a pull request as a Markdown heading and its description, in jq
 * because `gh` will do it in one call and there is nothing to parse on this
 * side. The `\n\n` here is a real newline pair, not a backslash and an `n`:
 * as argv it reaches jq exactly as written, and re-escaping it would put a
 * literal `\n` into the middle of the prompt.
 *
 * `// ""` is load-bearing — `gh` reports an empty PR description as JSON null,
 * and `string + null` is an error in jq rather than an empty string.
 */
const PR_HEADING_JQ = `"# " + .title + "\n\n" + (.body // "")`;

/**
 * The PR's title and body as one block of Markdown, for a runner that needs the
 * PR's own words as context.
 *
 * Read through `safeGh` on both counts. Argv, because a command string is where
 * the value of a variable becomes syntax — `PR_NUMBER` is a GitHub-produced
 * integer, but "safe because of what it happens to hold" is the argument the
 * argv boundary exists to stop making (#10). And swallowing, because the caller
 * is `update-branch`, which the workflow only reaches once git has left the tree
 * conflicted: an unreadable `gh pr view` is an API blip, not a reason to abandon
 * a merge resolution, so the fallback is the reference itself.
 */
export const fetchPullRequestHeading = (prNumber: string): string =>
  safeGh(["pr", "view", prNumber, "--json", "title,body", "--jq", PR_HEADING_JQ]) ||
  `PR #${prNumber}`;

export const writeJson = (filename: string, value: unknown): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), filename), JSON.stringify(value, null, 2));
};

export const writeText = (filename: string, value: string): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), filename), value);
};

/**
 * Wrap a plain validation function as a Standard Schema, so it can be handed to
 * `sandcastle.Output.object({ schema })` without pulling in a schema library.
 * On a thrown error the message is surfaced as a validation issue, which the
 * extraction retry loop feeds back to the agent.
 *
 * `vendor` names the library implementing the schema, so it is these runners —
 * not whichever repo they happen to be installed in. It read as the host repo's
 * name while the two were the same thing (#95).
 */
export const standardSchema = <T>(
  validate: (value: unknown) => T,
): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "agent-workflows",
    validate: (value: unknown) => {
      try {
        return { value: validate(value) };
      } catch (error) {
        return {
          issues: [{ message: error instanceof Error ? error.message : "Validation failed" }],
        };
      }
    },
  },
});

export const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

export const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
};
