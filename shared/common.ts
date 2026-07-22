import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
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
