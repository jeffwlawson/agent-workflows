import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs each agent workflow's *Redact the session transcript* step (#269), the
 * real `run:` block read out of its reusable workflow, against a home
 * directory holding a session transcript the agent wrote.
 *
 * What it executes is the one promise the artifact makes on a public
 * repository: nothing uploaded carries a secret the job held. The transcript
 * fed in here has `CLAUDE_CODE_OAUTH_TOKEN`'s value in it, as it would where
 * the agent printed its environment, and the job token both bare and in the
 * basic-auth form a checkout's git config holds it in. No PAT: no job that runs
 * an agent holds one (#307, #316), and the step names none to look for.
 *
 * Skipped where `bash` or `python3` is not on PATH.
 */

const CAN_RUN =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v bash && command -v python3"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

interface Step {
  readonly name?: string;
  readonly run?: string;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

/** Each workflow whose runner starts an agent, and the job that runs it. */
const AGENT_JOBS = ["implement", "implement-prd", "fix", "review", "update-branch"] as const;

const STEP = "Redact the session transcript";

const runOf = (command: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${command}.yml`), "utf8")) as Workflow;
  const step = (workflow.jobs[command]?.steps ?? []).find((s) => s.name === STEP);

  expect(step?.run, `${command} has no \`${STEP}\` step in \`${command}\``).toBeDefined();
  return step?.run ?? "";
};

const OAUTH = "sk-ant-oat01-Abc_def-123456789";
const GITHUB_TOKEN = "ghs_0123456789abcdefABCDEF";
const basicAuth = (token: string): string => Buffer.from(`x-access-token:${token}`).toString("base64");

/** Every file under `dir`, relative to it, with its contents. */
const filesUnder = (dir: string): Record<string, string> => {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(
    (fs.readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .map((f) => [f.split(path.sep).join("/"), fs.readFileSync(path.join(dir, f), "utf8")]),
  );
};

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly uploaded: Record<string, string>;
}

/** Runs the step with `transcripts` under `~/.claude/projects/`, or no such directory where it is undefined. */
const run = (command: string, transcripts: Record<string, string> | undefined): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-step-"));
  try {
    const home = path.join(temp, "home");
    const runnerTemp = path.join(temp, "runner");
    fs.mkdirSync(home);
    fs.mkdirSync(runnerTemp);
    for (const [file, text] of Object.entries(transcripts ?? {})) {
      const at = path.join(home, ".claude", "projects", file);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, text);
    }
    const script = path.join(temp, "step.sh");
    fs.writeFileSync(script, runOf(command));
    const result = spawnSync("bash", ["-e", script], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        RUNNER_TEMP: runnerTemp,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
        GITHUB_TOKEN,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return { status: result.status, stdout: result.stdout, uploaded: filesUnder(path.join(runnerTemp, "agent-transcript")) };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};

/** One line of a transcript where the agent ran `env` and `git config -l`. */
const leaky = (): string =>
  `${JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content: `CLAUDE_CODE_OAUTH_TOKEN=${OAUTH}\nNODE_AUTH_TOKEN=${GITHUB_TOKEN}\nhttp.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth(GITHUB_TOKEN)}`,
        },
      ],
    },
  })}\n`;

describe.skipIf(!CAN_RUN)("the session transcript is uploaded with no secret the job held", () => {
  it.each(AGENT_JOBS)("%s: redacts the OAuth token and the job token from every transcript", (command) => {
    const session = "-home-runner-work-repo-repo/0b0e6c1e-session.jsonl";
    const subagent = "-home-runner-work-repo-repo/0b0e6c1e-session/subagents/agent-1.jsonl";
    const { uploaded } = run(command, { [session]: leaky(), [subagent]: leaky() });

    expect(Object.keys(uploaded).sort()).toEqual([session, subagent].sort());
    for (const text of Object.values(uploaded)) {
      for (const secret of [OAUTH, GITHUB_TOKEN, basicAuth(GITHUB_TOKEN)]) {
        expect(text).not.toContain(secret);
      }
      expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]");
      expect(text).toContain("AUTHORIZATION: basic [REDACTED]");
      // Still the transcript: every line still parses.
      for (const line of text.trim().split("\n")) expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it.each(AGENT_JOBS)("%s: leaves a transcript holding no secret as it was", (command) => {
    const text = `${JSON.stringify({ type: "assistant", message: { content: "nothing secret" } })}\n`;
    const { uploaded } = run(command, { "-repo/session.jsonl": text });

    expect(uploaded).toEqual({ "-repo/session.jsonl": text });
  });

  it.each(AGENT_JOBS)("%s: uploads nothing, and succeeds, where no agent ever started", (command) => {
    const { uploaded, stdout } = run(command, undefined);

    expect(uploaded).toEqual({});
    expect(stdout).toMatch(/no session transcript/i);
  });
});
