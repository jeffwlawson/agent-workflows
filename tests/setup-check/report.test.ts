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
  TOOLCHAIN_RESULT: "skipped",
  TOOLCHAIN_EXIT: "",
  TOOLCHAIN_OUTPUT: "",
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
        "- **Toolchain** (`mise.toml`): skipped: the repository has no `mise.toml` at its root, so the box's own tools were used.",
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
        TOOLCHAIN_RESULT: "not-run",
        SETUP_RESULT: "not-run",
        VERIFY_RESULT: "not-run",
      }),
    );

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` failed:\*\* `main` could not be checked out, so neither the setup nor the verify command ran\./);
    expect(body).toContain("- **Checkout** of `main`: failed. Why:\n\n  ```\n  `main` could not be checked out: remote: Repository not found.\n  ```");
    expect(body).toContain("- **Toolchain** (`mise.toml`): not run, since the checkout did not finish.");
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

  it("caps a run of backticks in a step's output at 200, says it was shortened, and keeps the fence under 256", async () => {
    const long = "`".repeat(300);
    await run(INPUTS({ VERIFY_RESULT: "failed", VERIFY_EXIT: "1", VERIFY_OUTPUT: `before\n${long}\n@someone [x](https://example.com)` }));

    const body = posted();
    const runs = [...body.matchAll(/`+/g)].map(([found]) => found.length);
    expect(Math.max(...runs)).toBeLessThan(256);
    expect(body).not.toContain(long);
    const fence = "`".repeat(201);
    expect(body).toContain(`  ${fence}\n  before\n  ${"`".repeat(200)} (100 more backticks removed)\n  @someone [x](https://example.com)\n  ${fence}`);
  });

  it("fences the checkout's failure reason, so a mention or a link in it does not render", async () => {
    await run(
      INPUTS({
        CHECKOUT: "",
        CHECKOUT_RESULT: "failed",
        CHECKOUT_REASON: "`main` could not be checked out: <!-- x -->fatal: ask @someone at https://example.com/x ```",
        SETUP_RESULT: "not-run",
        VERIFY_RESULT: "not-run",
      }),
    );

    const body = posted();
    expect(body).not.toContain("<!--");
    expect(body).toContain("- **Checkout** of `main`: failed. Why:\n\n  ````\n  `main` could not be checked out: fatal: ask @someone at https://example.com/x ```\n  ````");
  });

  it("says a checkout that failed with no reason gave none", async () => {
    await run(INPUTS({ CHECKOUT: "", CHECKOUT_RESULT: "failed", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" }));

    expect(posted()).toContain("- **Checkout** of `main`: failed: it gave no reason.");
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

describe("setup-check:report's toolchain row (#822)", () => {
  /** The report's lines, from its first step's on. */
  const steps = (body: string): string[] => body.split("\n").filter((line) => line.startsWith("- **"));

  it("puts the toolchain row after the checkout and before the setup", async () => {
    await run(INPUTS({ TOOLCHAIN_RESULT: "passed" }));

    expect(steps(posted()).map((line) => /^- \*\*(\w+)\*\*/.exec(line)?.[1])).toEqual(["Checkout", "Toolchain", "Setup", "Verify"]);
  });

  it("says a toolchain that installed passed, and the check passed", async () => {
    await run(INPUTS({ TOOLCHAIN_RESULT: "passed" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` passed:\*\*/);
    expect(body).toContain("- **Toolchain** (`mise.toml`): passed: `mise install` installed what it asks for.");
  });

  it("says the toolchain was skipped where the repository has no mise.toml, and the check goes on", async () => {
    await run(INPUTS({ TOOLCHAIN_RESULT: "skipped" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` passed:\*\*/);
    expect(body).toContain("- **Toolchain** (`mise.toml`): skipped: the repository has no `mise.toml` at its root, so the box's own tools were used.");
  });

  it("gives a failed toolchain's exit code and the end of its output, and marks setup and verify as not run, and why", async () => {
    await run(
      INPUTS({ TOOLCHAIN_RESULT: "failed", TOOLCHAIN_EXIT: "1", TOOLCHAIN_OUTPUT: "mise ERROR python@9.9 not found", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" }),
    );

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` failed:\*\* the toolchain `mise\.toml` asks for \(`mise install`\) failed on `main` at [0-9a-f]{40}, in the sandbox, so neither the setup nor the verify command ran\./);
    expect(body).toContain("- **Toolchain** (`mise.toml`): failed: `mise install` exited with code 1. The end of its output:\n\n  ```\n  mise ERROR python@9.9 not found\n  ```");
    expect(body).toContain("- **Setup** (`AGENT_SETUP`): not run, since the toolchain `mise.toml` asks for failed to install.");
    expect(body).toContain("- **Verify** (`AGENT_VERIFY`): not run, since the toolchain `mise.toml` asks for failed to install.");
  });

  it("says a toolchain that could not be started could not, with why", async () => {
    const why = "The toolchain `mise.toml` asks for (`mise install`) could not be installed: `/usr/local/bin/mise` is missing from the agent box. Re-run `install-box.sh` on the agent box to install mise.";
    await run(INPUTS({ TOOLCHAIN_RESULT: "failed", TOOLCHAIN_OUTPUT: why, SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" }));

    expect(posted()).toContain("- **Toolchain** (`mise.toml`): failed: `mise install` could not be started. The end of its output:");
    expect(posted()).toContain("install-box.sh");
  });

  it("says a toolchain that ran out of time did not finish, naming the limit, and marks setup and verify as not run, and why", async () => {
    await run(INPUTS({ TOOLCHAIN_RESULT: "timed-out", SETUP_RESULT: "not-run", VERIFY_RESULT: "not-run" }));

    const body = posted();
    expect(body).toMatch(/^\*\*`agent:setup-check` timed out:\*\* the toolchain `mise\.toml` asks for \(`mise install`\) did not finish on/);
    expect(body).toContain("- **Toolchain** (`mise.toml`): timed out: `mise install` did not finish within its time limit, 30 minutes.");
    expect(body).toContain("- **Setup** (`AGENT_SETUP`): not run, since the toolchain `mise.toml` asks for timed out.");
    expect(body).toContain("- **Verify** (`AGENT_VERIFY`): not run, since the toolchain `mise.toml` asks for timed out.");
  });
});
