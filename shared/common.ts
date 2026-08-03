import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as sandcastle from "@ai-hero/sandcastle";

export const outputDir = (): string => process.env["OUTPUT_DIR"] ?? "/tmp";

export const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
};

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

export const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const safeSh = (cmd: string): string => {
  try {
    return sh(cmd);
  } catch {
    return "";
  }
};

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

/** Run `gh` with argv (no shell), so arguments with spaces/quotes are safe. */
export const gh = (args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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
 *
 * Known gap, recorded rather than implied-clean: `fetchTrustedIssue` and
 * `fetchTrustedComments` below still interpolate variables into
 * ``safeSh(`gh api ...`)``. They are safe today only because of what those
 * variables happen to be — `GH_REPO` is `github.repository`, and the issue
 * number is a `\d+` capture in review-context.ts — not because of an argv
 * boundary. Closing that needs a `safeGh(args)` wrapper, not a call-site swap:
 * `safeSh` swallows non-zero exits and `gh()` throws, and both callers rely on
 * the swallowing via `|| "{}"` / `|| "[]"`. Tracked as issue #80.
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
 * children, not later workflow steps. It does NOT remove git credentials that
 * `actions/checkout` persists in `.git/config`; preventing `git push` is a
 * separate control (`contents: read`, or `persist-credentials: false`).
 */
export const scrubGitHubTokens = (): void => {
  delete process.env["GH_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
};

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Our own workflows post as `github-actions[bot]`, whose `author_association`
 * is `NONE` — so an association-only gate would discard the review agent's own
 * findings and break the review → fix handoff.
 *
 * Trusting this one login is sound because the identity is *transitively
 * write-gated*: only a workflow in this repository can post as it, and adding
 * or editing a workflow requires write access. Deliberately NOT `user.type ===
 * "Bot"` in general — that would also trust Dependabot and any GitHub App an
 * admin installs, which is a far wider surface for a workflow that commits code.
 */
// Both spellings on purpose: the REST API reports this account as
// `github-actions[bot]`, GraphQL reports the same account as `github-actions`.
// Listing only one silently drops our own review's comments on whichever path
// uses the other.
const TRUSTED_BOT_LOGINS = new Set(["github-actions[bot]", "github-actions"]);

export const isTrustedAuthor = (association: string | undefined, login: string | undefined): boolean =>
  TRUSTED_ASSOCIATIONS.has(association ?? "") || TRUSTED_BOT_LOGINS.has(login ?? "");

export interface TrustedIssue {
  readonly title: string;
  readonly body: string;
  /** True only when the issue's author has repo write access. */
  readonly trusted: boolean;
}

/**
 * Fetch an issue's title and body, but treat them as usable ONLY when the issue
 * author has repo write access (OWNER / MEMBER / COLLABORATOR).
 *
 * Why: on a public repo anyone can *open* an issue with arbitrary title and
 * body, and this text is fed verbatim to an unsandboxed agent that holds tokens
 * and produces public output — a prompt-injection / exfiltration source. Author
 * association is the structural boundary, not the field: title and body from a
 * write-access author sit behind the same trust boundary the loop already
 * assumes. Comments are never fetched at all — they are world-writable
 * regardless of who opened the issue.
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
    parsed = JSON.parse(safeSh(`gh api repos/${ghRepo}/issues/${issueNumber}`) || "{}");
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
    comments = JSON.parse(safeSh(`gh api repos/${ghRepo}/issues/${number}/comments`) || "[]");
  } catch {
    comments = [];
  }
  return comments
    .filter((c) => isTrustedAuthor(c.author_association, c.user?.login))
    .map((c) => `**@${c.user?.login ?? "unknown"}:**\n${(c.body ?? "").trim()}`)
    .filter((text) => text.trim().length > 0)
    .join("\n\n---\n\n");
};

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
 */
export const standardSchema = <T>(
  validate: (value: unknown) => T,
): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "winget-manifest-lint",
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
