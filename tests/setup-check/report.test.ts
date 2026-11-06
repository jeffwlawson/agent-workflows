import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Limits } from "../../engine/writer.js";
import { report } from "../../setup-check/report.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { SETUP_CHECK_LABEL } from "../../shared/record.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `setup-check:report` (#821), called the way the CLI calls it: the inputs the
 * worker hands it, a checkout on disk whose head it names, and the engine's
 * writers over a fake GitHub. What is asserted is the comment it posted and
 * the label it took off.
 */

const ISSUE = 12;
const RUN_URL = "https://github.com/apps/loop-app#job-job-1";

let root: string;
let checkout: string;
let sha: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let logged: string[];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT,
  }).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-check-report-"));
  checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  git(checkout, "init", "--quiet");
  git(checkout, "commit", "--quiet", "--allow-empty", "-m", "the default branch");
  sha = git(checkout, "rev-parse", "HEAD");
  github = fakeGitHub([]);
  github.issueLabels.set(ISSUE, [SETUP_CHECK_LABEL]);
  made = undefined;
  asked = undefined;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

type Inputs = Parameters<typeof report>[0];

/** A check where every step passed. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(root, "report"),
  GH_REPO: "owner/repo",
  GH_TOKEN: "write-token",
  ISSUE_NUMBER: String(ISSUE),
  BASE_REF: "main",
  RUN_URL,
  CHECKOUT: checkout,
  TIMEOUT_MINUTES: "30",
  CHECKOUT_RESULT: "passed",
  CHECKOUT_REASON: "",
  SETUP_RESULT: "passed",
  SETUP_EXIT: "",
  SETUP_OUTPUT: "",
  VERIFY_RESULT: "passed",
  VERIFY_EXIT: "",
  VERIFY_OUTPUT: "",
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["setup-check:report"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: fakeReader(github).reader,
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  try {
    await report(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

/** The one comment posted, which every case below expects. */
const posted = (): string => {
  expect(github.comments).toHaveLength(1);
  return github.comments[0]!.body;
};

const FOOTER = `[Run](${RUN_URL}) · To check again, add \`agent:setup-check\` again.`;

describe("setup-check:report says how each step of a setup check ended", () => {
  it("reports checkout, setup and verify as passed, names the commit, and takes the label off", async () => {
    await run();

    expect(posted()).toBe(
      [
        `**\`agent:setup-check\` passed:** the setup and the verify command passed on \`main\` at ${sha}, in the sandbox. No agent was started.`,
        "",
        `- **Checkout** of \`main\`: passed, at ${sha}.`,
        "- **Setup** (`AGENT_SETUP`): passed.",
        "- **Verify** (`AGENT_VERIFY`): passed.",
        "",
        FOOTER,
        "",
      ].join("\n"),
    );
    expect(github.comments[0]!.issue).toBe(ISSUE);
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
    expect((made?.writes ?? []).map((w) => `${w.token} ${w.type}`)).toEqual(["workflow comment", "workflow removeLabel"]);
  });

  it("gives a failed setup's exit code and the end of its output, and says verify was not run because setup failed", async () => {
    await run(INPUTS({ SETUP_RESULT: "failed", SETUP_EXIT: "2", SETUP_OUTPUT: "npm ERR! code ENOENT\nnpm ERR! python3-venv", VERIFY_RESULT: "not-run" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` failed:\*\* the setup \(`AGENT_SETUP`\) failed on `main` at [0-9a-f]{40}, in the sandbox\./);
    expect(body).toContain(
      "- **Setup** (`AGENT_SETUP`): failed, with exit code 2. The end of its output:\n\n  ```\n  npm ERR! code ENOENT\n  npm ERR! python3-venv\n  ```",
    );
    expect(body).toContain("- **Verify** (`AGENT_VERIFY`): not run, since the setup failed.");
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
  });

  it("gives a failed verify's exit code and the end of its output", async () => {
    await run(INPUTS({ VERIFY_RESULT: "failed", VERIFY_EXIT: "1", VERIFY_OUTPUT: "1 test failed" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` failed:\*\* the verify command \(`AGENT_VERIFY`\) failed on/);
    expect(body).toContain("- **Setup** (`AGENT_SETUP`): passed.");
    expect(body).toContain("- **Verify** (`AGENT_VERIFY`): failed, with exit code 1. The end of its output:\n\n  ```\n  1 test failed\n  ```");
  });

  it("says a step that could not be started in the sandbox could not, with why", async () => {
    await run(INPUTS({ SETUP_RESULT: "failed", SETUP_OUTPUT: "spawn bwrap ENOENT", VERIFY_RESULT: "not-run" }));

    expect(posted()).toContain("- **Setup** (`AGENT_SETUP`): failed: it could not be started in the sandbox. The end of its output:\n\n  ```\n  spawn bwrap ENOENT\n  ```");
  });

  it("says verify was skipped where AGENT_VERIFY is unset, naming it and how to set it", async () => {
    await run(INPUTS({ VERIFY_RESULT: "unset" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` incomplete:\*\* the setup passed, but nothing verified it on `main` at [0-9a-f]{40}: `AGENT_VERIFY` is unset\./);
    expect(body).toContain(
      '- **Verify** (`AGENT_VERIFY`): skipped: `AGENT_VERIFY` is unset. Set it to the command that checks this repository, as a repository variable (`gh variable set AGENT_VERIFY --body "npm test"`',
    );
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
  });

  it("says setup was skipped where AGENT_SETUP is unset, and reports the verify that still ran", async () => {
    await run(INPUTS({ SETUP_RESULT: "unset" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` passed:\*\* the verify command passed on/);
    expect(body).toContain("- **Setup** (`AGENT_SETUP`): skipped: `AGENT_SETUP` is unset, so nothing was installed before the verify command.");
    expect(body).toContain("- **Verify** (`AGENT_VERIFY`): passed.");
  });

  it("says a checkout that failed did not finish, with its reason, and that neither script ran; and takes the label off", async () => {
    await run(
      INPUTS({
        CHECKOUT: "",
        CHECKOUT_RESULT: "failed",
        CHECKOUT_REASON: "`main` could not be checked out: remote: Repository not found.",
        SETUP_RESULT: "not-run",
        VERIFY_RESULT: "not-run",
      }),
    );

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` failed:\*\* `main` could not be checked out, so neither the setup nor the verify command ran\./);
    expect(body).toContain("- **Checkout** of `main`: failed: `main` could not be checked out: remote: Repository not found.");
    expect(body).toContain("- **Setup** (`AGENT_SETUP`): not run, since the checkout did not finish.");
    expect(body).toContain("- **Verify** (`AGENT_VERIFY`): not run, since the checkout did not finish.");
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
  });

  it("says which step ran out of time, naming the limit, and takes the label off", async () => {
    await run(INPUTS({ SETUP_RESULT: "timed-out", VERIFY_RESULT: "not-run" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` timed out:\*\* the setup \(`AGENT_SETUP`\) did not finish on/);
    expect(body).toContain("- **Setup** (`AGENT_SETUP`): timed out: it did not finish within its time limit, 30 minutes.");
    expect(body).toContain("- **Verify** (`AGENT_VERIFY`): not run, since the setup timed out.");
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
  });

  it("says a checkout that ran out of time did not finish", async () => {
    await run(INPUTS({ CHECKOUT: "", CHECKOUT_RESULT: "timed-out", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` timed out:\*\* `main` could not be checked out/);
    expect(body).toContain("- **Checkout** of `main`: timed out: it did not finish within its time limit, 30 minutes.");
  });

  it("fences output holding backticks and an HTML comment so neither escapes the block", async () => {
    await run(INPUTS({ VERIFY_RESULT: "failed", VERIFY_EXIT: "1", VERIFY_OUTPUT: "```\n<!-- agent:marker -->@someone" }));

    const body = posted();
    expect(body).not.toContain("<!--");
    expect(body).toContain("  ````\n  ```\n  @someone\n  ````");
  });

  it("names no commit, and still reports, where the checkout's head cannot be read", async () => {
    await run(INPUTS({ CHECKOUT: path.join(root, "not-a-checkout") }));

    expect(posted()).toContain("- **Checkout** of `main`: passed.");
    expect(logged.some((line) => line.startsWith("::warning::"))).toBe(true);
  });

  it("asks for one comment and one label removal, and nothing else", async () => {
    await run();

    expect(asked).toEqual({ comment: 1, removeLabel: 1 });
  });

  it("still takes the label off where GitHub refuses the report, and says so", async () => {
    github.fails = ({ type }) => type === "comment";

    await run();

    expect(github.comments).toEqual([]);
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
    expect(logged.some((line) => line.startsWith("::warning::") && line.includes(`#${ISSUE}`))).toBe(true);
  });
});
