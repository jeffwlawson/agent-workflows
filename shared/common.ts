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

export const claudeAgent = () =>
  sandcastle.claudeCode("claude-opus-4-8", {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: required("CLAUDE_CODE_OAUTH_TOKEN"),
    },
  });

/** Run `gh` with argv (no shell), so arguments with spaces/quotes are safe. */
export const gh = (args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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
  let parsed: { title?: string; body?: string | null; author_association?: string } = {};
  try {
    parsed = JSON.parse(safeSh(`gh api repos/${ghRepo}/issues/${issueNumber}`) || "{}");
  } catch {
    parsed = {};
  }
  if (!TRUSTED_ASSOCIATIONS.has(parsed.author_association ?? "")) {
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
    .filter((c) => TRUSTED_ASSOCIATIONS.has(c.author_association ?? ""))
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
