import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs the red check's steps (#231), the real `run:` blocks read out of
 * `.github/workflows/review.yml`: the one that puts a pull request's test files
 * over the merge-base, against a real git repository, the one that runs the
 * command, and the one that classifies each test in a JUnit XML report.
 *
 * `tests/workflows.test.ts` asserts what the job holds and where it sits. What
 * it does to a tree, and what it makes of a report, only running it can show,
 * for the reason `tests/review-ci-wait.test.ts` gives.
 *
 * Skipped where `bash`, `git` or `python3` is not on PATH: authored on Windows
 * and gated on Linux CI, where all three are present and the coverage is real.
 */

const REVIEW = path.join(".github", "workflows", "review.yml");
const FIXTURES = path.resolve("tests", "fixtures", "red-check");

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly shell?: string;
  readonly env?: Record<string, string>;
  readonly run?: string;
}
interface Job {
  readonly env?: Record<string, string>;
  readonly steps?: readonly Step[];
}

const job = (): Job => {
  const found = (parse(fs.readFileSync(REVIEW, "utf8")) as { jobs: Record<string, Job> }).jobs["red-check"];

  expect(found).toBeDefined();
  return found as Job;
};

const step = (match: (s: Step) => boolean): Step => {
  const found = (job().steps ?? []).find(match);

  expect(found).toBeDefined();
  return found as Step;
};

const placeStep = (): Step => step((s) => s.id === "place");
const runStep = (): Step => step((s) => s.id === "run");
const classifyStep = (): Step => step((s) => (s.name ?? "").startsWith("Classify each test"));

const onPath = (command: string): boolean =>
  process.platform === "win32"
    ? spawnSync("where", [command], { timeout: SUBPROCESS_TIMEOUT }).status === 0
    : spawnSync("sh", ["-c", `command -v ${command}`], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

const CAN_RUN = ["bash", "git", "python3"].every(onPath);

/**
 * A step's `env:` with every expression replaced by the value a scenario gives
 * it. An expression the scenario does not name throws rather than expanding to
 * the empty string, so a new one cannot quietly turn a case into a test of
 * nothing.
 */
const resolved = (env: Record<string, string> | undefined, values: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => {
      const literal = values[value] ?? value;

      if (literal.includes("${{")) throw new Error(`no test value for ${key}: ${value}`);
      return [key, literal];
    }),
  );

/** `key=value` lines out of a `GITHUB_OUTPUT` file. */
const outputsOf = (file: string): Record<string, string> =>
  Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: Record<string, string>;
  readonly temp: string;
}

/**
 * One step, the way GitHub runs it: a `run:` block with no `shell:` under
 * `bash -e`, and `shell: python` under the image's Python.
 */
const runStepIn = (s: Step, cwd: string, values: Readonly<Record<string, string>>, temp = scratch()): Ran => {
  const script = path.join(temp, s.shell === "python" ? "step.py" : "step.sh");
  const output = path.join(temp, "github_output");

  fs.writeFileSync(script, s.run ?? "");
  fs.writeFileSync(output, "");
  const [command, args] = s.shell === "python" ? ["python3", [script]] : ["bash", ["-e", script]];
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? temp,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      ...resolved(job().env, { ...JOB, ...values }),
      ...resolved(s.env, values),
    },
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs: outputsOf(output), temp };
};

/** The job's own `env:`, which every step reads. */
const JOB = { "${{ github.event.pull_request.base.ref || inputs.default-branch }}": "main" };

const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "red-check-"));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

const write = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
};

const commit = (root: string, files: Readonly<Record<string, string>>, message: string): string => {
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

/**
 * A pull request as the checkout leaves one: the head checked out, detached,
 * and the base branch present as `origin/main` and moved on since the PR
 * branched, so the merge-base is not the base branch's tip.
 */
const pullRequest = (
  changes: Readonly<Record<string, string>>,
): { readonly root: string; readonly base: string; readonly head: string } => {
  const root = scratch();
  git(root, "init", "--quiet", "-b", "main");
  const base = commit(
    root,
    {
      "README.md": "as at the merge-base\n",
      "src/scale.ts": "the bug\n",
      "tests/scale.test.ts": "the old test\n",
      "tests/untouched.test.ts": "untouched\n",
    },
    "base",
  );
  git(root, "checkout", "--quiet", "-b", "feature");
  const head = commit(root, changes, "the PR");
  git(root, "checkout", "--quiet", "main");
  commit(root, { "README.md": "moved on since\n" }, "main moves on");
  git(root, "update-ref", "refs/remotes/origin/main", "main");
  git(root, "checkout", "--quiet", "--detach", head);
  return { root, base, head };
};

const PLACE = {
  "${{ inputs.red-check-report }}": "junit.xml",
  "${{ inputs.red-check-test-globs }}": "tests/**\n  **/*.test.ts  \n",
};

const read = (root: string, file: string): string | undefined =>
  fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), "utf8") : undefined;

describe("the red check puts only the PR's test files over the merge-base", () => {
  it.skipIf(!CAN_RUN)("runs on the merge-base's source, with the test files the PR adds or changes", () => {
    const { root, base, head } = pullRequest({
      "src/scale.ts": "the fix\n",
      "src/new-module.ts": "new source\n",
      "tests/scale.test.ts": "the new test\n",
      "tests/added.test.ts": "an added test\n",
      "src/lib/other.test.ts": "a test beside its source\n",
    });

    const ran = runStepIn(placeStep(), root, PLACE);

    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.outputs).toMatchObject({ status: "ready", base, head });
    // Every non-test file is the merge-base's: the fix is not there, a module
    // the PR added is not there, and the base branch's later commits are not
    // either.
    expect(read(root, "src/scale.ts")).toBe("the bug\n");
    expect(read(root, "src/new-module.ts")).toBeUndefined();
    expect(read(root, "README.md")).toBe("as at the merge-base\n");
    // Every test file the PR added or changed is the PR's, under either glob.
    expect(read(root, "tests/scale.test.ts")).toBe("the new test\n");
    expect(read(root, "tests/added.test.ts")).toBe("an added test\n");
    expect(read(root, "src/lib/other.test.ts")).toBe("a test beside its source\n");
    expect(read(root, "tests/untouched.test.ts")).toBe("untouched\n");
    expect(fs.readFileSync(path.join(ran.temp, "red_check_files.txt"), "utf8").split("\n").filter(Boolean).sort()).toEqual([
      "src/lib/other.test.ts",
      "tests/added.test.ts",
      "tests/scale.test.ts",
    ]);
  });

  it.skipIf(!CAN_RUN)("says there is nothing to run where the PR changes no test file", () => {
    const { root } = pullRequest({ "src/scale.ts": "the fix\n" });

    const ran = runStepIn(placeStep(), root, PLACE);

    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.outputs["status"]).toBe("no-test-files");
    expect(read(root, "src/scale.ts")).toBe("the fix\n");
  });

  it.skipIf(!CAN_RUN)("says which input is missing where the command is set without the others", () => {
    const { root } = pullRequest({ "tests/scale.test.ts": "the new test\n" });

    const ran = runStepIn(placeStep(), root, { ...PLACE, "${{ inputs.red-check-test-globs }}": "" });

    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.outputs["status"]).toBe("misconfigured");
    expect(ran.outputs["reason"]).toContain("red-check-test-globs");
    expect(ran.outputs["reason"]).not.toContain("red-check-report");
  });
});

describe("the red check runs the command and keeps its exit code", () => {
  /**
   * A failing test is what the check looks for, so the command failing does
   * not fail the step. And a report the merge-base's tree already held is not
   * one the command wrote.
   */
  it.skipIf(!CAN_RUN)("hands the command the test files, and removes a stale report first", () => {
    const root = scratch();
    const temp = scratch();
    fs.writeFileSync(path.join(root, "junit.xml"), "stale");
    fs.writeFileSync(path.join(temp, "red_check_files.txt"), "tests/a.test.ts\ntests/b.test.ts\n");

    const ran = runStepIn(
      runStep(),
      root,
      {
        "${{ inputs.red-check-command }}": 'test ! -e junit.xml\nprintf "%s" "$RED_CHECK_FILES" > seen.txt\nexit 3',
        "${{ inputs.red-check-report }}": "junit.xml",
      },
      temp,
    );

    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.outputs["exit-code"]).toBe("3");
    expect(read(root, "seen.txt")).toBe("tests/a.test.ts\ntests/b.test.ts");
  });
});

interface Report {
  readonly status: string;
  readonly reason?: string;
  readonly base: string | null;
  readonly head: string | null;
  readonly files: readonly string[];
  readonly exitCode: number | null;
  readonly skipped: number;
  readonly tests: readonly {
    readonly name: string;
    readonly classname: string;
    readonly file?: string;
    readonly result: string;
    readonly message?: string;
  }[];
}

const CLASSIFY = {
  "${{ steps.place.outputs.status }}": "ready",
  "${{ steps.place.outputs.reason }}": "",
  "${{ steps.place.outputs.base }}": "b".repeat(40),
  "${{ steps.place.outputs.head }}": "h".repeat(40),
  "${{ steps.setup.outcome }}": "success",
  "${{ steps.run.outputs.exit-code }}": "1",
};

const classify = (report: string, values: Readonly<Record<string, string>> = {}): Report => {
  const temp = scratch();
  fs.writeFileSync(path.join(temp, "red_check_files.txt"), "tests/test_recipes.py\n");
  const ran = runStepIn(classifyStep(), FIXTURES, { ...CLASSIFY, "${{ inputs.red-check-report }}": report, ...values }, temp);

  expect(ran.status, ran.stderr).toBe(0);
  return JSON.parse(fs.readFileSync(path.join(temp, "red_check.json"), "utf8")) as Report;
};

describe("the red check classifies each test as red, broken or passed", () => {
  it("runs under Python, as GitHub's `shell: python`", () => {
    expect(classifyStep().shell).toBe("python");
  });

  /** Each test's name, classname and result, the shape every case below compares. */
  const results = (report: Report): { name: string; classname: string; result: string }[] =>
    report.tests.map(({ name, classname, result }) => ({ name, classname, result }));

  const messageOf = (report: Report, name: string): string => report.tests.find((t) => t.name === name)?.message ?? "";

  /**
   * pytest 9.1.1 under `--continue-on-collection-errors`, which the class needs
   * in one report: without it pytest stops at the collection error and the
   * report holds that alone.
   */
  it.skipIf(!CAN_RUN)("reads pytest's assertion as red with its message, and setup and collection errors as broken", () => {
    const report = classify("pytest.xml");

    expect(report).toMatchObject({
      status: "ran",
      base: "b".repeat(40),
      head: "h".repeat(40),
      files: ["tests/test_recipes.py"],
      exitCode: 1,
      skipped: 1,
    });
    expect(results(report)).toEqual([
      // An import error fails against the merge-base too, and proves nothing.
      { name: "tests.test_units", classname: "", result: "broken" },
      { name: "test_scales_servings", classname: "tests.test_recipes", result: "red" },
      { name: "test_keeps_units", classname: "tests.test_recipes", result: "passed" },
      { name: "test_needs_a_fixture", classname: "tests.test_recipes", result: "broken" },
    ]);
    expect(messageOf(report, "test_scales_servings")).toBe("assert 2 == 4\n +  where 2 = scale(1, 2)");
    expect(messageOf(report, "tests.test_units")).toBe("collection failure");
    expect(messageOf(report, "test_needs_a_fixture")).toContain("fixture 'client' not found");
  });

  /**
   * vitest 3.2.4 writes every one of these as a `<failure>`, `errors="0"`: an
   * import error and a throw at collection as a testcase named by the file, and
   * a `beforeAll` that threw, nested or not, as one named by its `describe`.
   */
  it.skipIf(!CAN_RUN)("reads vitest's import, collection and beforeAll failures as broken, and its assertion as red", () => {
    const report = classify("vitest.xml");

    expect(results(report)).toEqual([
      { name: "pantry > opens", classname: "tests/client.test.ts", result: "passed" },
      { name: "needs a client", classname: "tests/client.test.ts", result: "broken" },
      { name: "needs a shelf", classname: "tests/client.test.ts", result: "broken" },
      { name: "tests/collect.test.ts", classname: "tests/collect.test.ts", result: "broken" },
      { name: "scale > doubles a serving", classname: "tests/scale.test.ts", result: "red" },
      { name: "scale > keeps the unit", classname: "tests/scale.test.ts", result: "passed" },
      { name: "tests/units.test.ts", classname: "tests/units.test.ts", result: "broken" },
    ]);
    // The tests under a `beforeAll` that threw never ran.
    expect(report.skipped).toBe(2);
    expect(messageOf(report, "scale > doubles a serving")).toBe("expected 2 to be 4 // Object.is equality");
    expect(messageOf(report, "tests/units.test.ts")).toContain("Cannot find module '../src/units'");
    expect(messageOf(report, "needs a client")).toBe("no client");
  });

  /**
   * jest 30 with jest-junit, `reportTestSuiteErrors` and `addFileAttribute` on.
   * It writes no `message` attribute, so the message is the body's first line,
   * and a suite that failed to run twice under one name, an `<error>` and a
   * `<failure>`: one test, and broken.
   */
  it.skipIf(!CAN_RUN)("reads jest-junit's suite that failed to run as one broken test, and takes a message from the body", () => {
    expect(classify("jest.xml").tests).toEqual([
      {
        name: "scale doubles a serving",
        classname: "scale doubles a serving",
        file: "tests/scale.test.js",
        result: "red",
        message: "Error: expect(received).toBe(expected) // Object.is equality",
      },
      { name: "scale keeps the unit", classname: "scale keeps the unit", file: "tests/scale.test.js", result: "passed" },
      {
        name: "tests/units.test.js",
        classname: "Test suite failed to run",
        file: "tests/units.test.js",
        result: "broken",
        message: "● Test suite failed to run",
      },
    ]);
  });

  /** "No red test" and "the check did not run" are different answers. */
  it.skipIf(!CAN_RUN)("says why there is nothing to classify, rather than reporting no tests", () => {
    expect(classify("missing.xml").status).toBe("no-report");
    expect(classify("pytest.xml", { "${{ steps.setup.outcome }}": "failure" }).status).toBe("setup-failed");
    expect(classify("pytest.xml", { "${{ steps.run.outputs.exit-code }}": "" }).status).toBe("not-run");
    expect(classify("pytest.xml", { "${{ steps.place.outputs.status }}": "" }).status).toBe("failed");
    expect(classify("pytest.xml", { "${{ steps.place.outputs.status }}": "no-test-files" })).toMatchObject({
      status: "no-test-files",
      tests: [],
    });
    expect(
      classify("pytest.xml", {
        "${{ steps.place.outputs.status }}": "misconfigured",
        "${{ steps.place.outputs.reason }}": "Set them.",
      }),
    ).toMatchObject({ status: "misconfigured", reason: "Set them." });

    const unreadable = classify("../../red-check.test.ts");

    expect(unreadable.status).toBe("unreadable-report");
    expect(unreadable.tests).toEqual([]);
  });
});
