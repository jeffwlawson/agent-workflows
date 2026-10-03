import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The token-expiry check (#321, PRD #314), executed: the real `run:` block of
 * its `Check AGENT_PAT expiry` step, under `bash`, against a `curl` that
 * records that it was asked and answers as GitHub does for a PAT with no
 * expiry date.
 *
 * Where the loop's App is set up, the resolver writes with it and nothing uses
 * the PAT, so the check skips. Anywhere else, half an App included, it checks
 * the PAT as before, which is what keeps the fallback safe to rely on.
 *
 * Skipped where `bash` is not on PATH.
 */

const CAN_RUN =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v bash"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

interface Step {
  readonly id?: string;
  readonly run?: string;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const checkRun = (): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", "token-expiry.yml"), "utf8")) as Workflow;
  const step = (workflow.jobs["check"]?.steps ?? []).find((s) => s.id === "check");

  expect(step?.run, "token-expiry has no `check` step").toBeDefined();
  return step?.run ?? "";
};

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  /** Each `curl` call's argv. */
  readonly curl: readonly string[];
  readonly output: string;
}

const execute = (env: Readonly<Record<string, string>>): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-token-expiry-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "curl.log");
  const file = path.join(temp, "step.sh");
  // Its own, never the runner's: a test run inside a workflow job inherits
  // that job's `GITHUB_OUTPUT`.
  const output = path.join(temp, "output");
  fs.writeFileSync(output, "");
  fs.mkdirSync(bin);
  // Writes an empty header file wherever `-D` points and answers 200: a PAT
  // GitHub accepts and that carries no expiry date.
  fs.writeFileSync(
    path.join(bin, "curl"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CURL_LOG"\n' +
      'while [ $# -gt 0 ]; do [ "$1" = "-D" ] && : > "$2"; shift; done\nprintf 200\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(file, checkRun());

  const result = spawnSync("bash", [file], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      CURL_LOG: log,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: temp,
      WARN_DAYS: "21",
      PAT: "",
      APP_ID: "",
      APP_KEY: "",
      ...env,
    },
  });
  const curl = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  const written = fs.readFileSync(output, "utf8");
  fs.rmSync(temp, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, curl, output: written };
};

describe.skipIf(!CAN_RUN)("the token-expiry check skips the PAT only where the App is set up, executed", () => {
  it("skips with the App's ID and key both set, asking GitHub nothing about the PAT", () => {
    const outcome = execute({ PAT: "pat", APP_ID: "123", APP_KEY: "key" });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.output).toBe("state=app\n");
    expect(outcome.curl).toEqual([]);
    expect(outcome.stdout).toContain("GitHub App");
  });

  it.each([
    ["no App", "", ""],
    ["an App ID without a key", "123", ""],
    ["an App key without an ID", "", "key"],
  ])("checks the PAT with %s", (_, id, key) => {
    const outcome = execute({ PAT: "pat", APP_ID: id, APP_KEY: key });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.curl).toHaveLength(1);
    expect(outcome.output).toContain("state=no-expiry");
  });

  it("still says the PAT is unset where neither is set up", () => {
    const outcome = execute({});

    expect(outcome.output).toBe("state=unset\n");
    expect(outcome.curl).toEqual([]);
  });
});
