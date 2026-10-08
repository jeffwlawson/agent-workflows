import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { place, type Placed } from "../../review/red-check-place.js";
import { FINAL_REVIEW_MARK } from "../../shared/record.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `review:red-check-place` (#422), called the way the CLI calls it: its
 * declared inputs, with `CHECKOUT` a real git repository shaped as the
 * red-check job's checkout leaves one, and its declared outputs. What is
 * asserted is the tree it leaves and what it wrote, `place.json`.
 *
 * The scenarios are the retired shell step's, carried over by behaviour.
 */

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "red-check-place-"));

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

const read = (root: string, file: string): string | undefined =>
  fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), "utf8") : undefined;

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

/**
 * A PRD PR as the checkout leaves one (#235): the PRD branch, every slice built
 * on it as commits carrying `implement-prd`'s `Agent-Slice` trailer, and the
 * default branch merged in before the second slice by the chain's own
 * catch-up merge. The second slice is two commits, the build and a fix
 * round's, and only the first carries the trailer.
 */
const prdPullRequest = (): {
  readonly root: string;
  readonly mergeBase: string;
  readonly catchUp: string;
} => {
  const root = scratch();
  git(root, "init", "--quiet", "-b", "main");
  commit(
    root,
    {
      "README.md": "as at the merge-base\n",
      "src/scale.ts": "the bug\n",
      "src/units.ts": "no units\n",
      "tests/scale.test.ts": "the old test\n",
    },
    "base",
  );
  git(root, "checkout", "--quiet", "-b", "agent/prd-212-red-check");
  commit(root, { "src/units.ts": "slice one's units\n", "tests/units.test.ts": "slice one's test\n" }, "slice one\n\nAgent-Slice: #231");
  git(root, "checkout", "--quiet", "main");
  commit(root, { "README.md": "moved on since\n" }, "main moves on");
  git(root, "checkout", "--quiet", "agent/prd-212-red-check");
  git(root, "merge", "--quiet", "--no-ff", "-m", "catch up\n\nAgent-Catch-Up: #232", "main");
  const catchUp = git(root, "rev-parse", "HEAD");
  commit(root, { "src/scale.ts": "the fix\n", "tests/scale.test.ts": "slice two's test\n" }, "slice two\n\nAgent-Slice: #232");
  commit(root, { "tests/added.test.ts": "a fix round's test\n" }, "a fix round");
  git(root, "update-ref", "refs/remotes/origin/main", "main");
  const mergeBase = git(root, "merge-base", "HEAD", "main");
  git(root, "checkout", "--quiet", "--detach", "HEAD");
  return { root, mergeBase, catchUp };
};

type Inputs = Parameters<typeof place>[0];

const INPUTS = (checkout: string, over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  CHECKOUT: checkout,
  BRANCH: "feature",
  BASE_REF: "main",
  PR_BODY: "",
  REPORT_PATH: "junit.xml",
  TEST_GLOBS: "tests/**\n  **/*.test.ts  \n",
  ...over,
});

const PRD = { BRANCH: "agent/prd-212-red-check" } as const;

/** The placement `place` writes for `inputs`, as the CLI would hand it its outputs. */
const placed = (inputs: Inputs): Placed => {
  const written = new Map<string, unknown>();
  place(inputs, {
    writeJson: (name, value) => written.set(name, value),
    writeText: (name, value) => written.set(name, value),
    appendLine: () => {},
  });
  return written.get("place.json") as Placed;
};

describe("review:red-check-place puts only the PR's test files over the merge-base", () => {
  it("runs on the merge-base's source, with the test files the PR adds or changes", () => {
    const { root, base, head } = pullRequest({
      "src/scale.ts": "the fix\n",
      "src/new-module.ts": "new source\n",
      "tests/scale.test.ts": "the new test\n",
      "tests/added.test.ts": "an added test\n",
      "src/lib/other.test.ts": "a test beside its source\n",
    });

    const result = placed(INPUTS(root));

    expect(result).toMatchObject({ status: "ready", base, head });
    expect(result.slice).toBeUndefined();
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
    expect([...result.files].sort()).toEqual(["src/lib/other.test.ts", "tests/added.test.ts", "tests/scale.test.ts"]);
    // And the non-test files it changes, for the review to hold the red tests
    // against (#232).
    expect([...(result.source ?? [])].sort()).toEqual(["src/new-module.ts", "src/scale.ts"]);
  });

  it("says there is nothing to run where the PR changes no test file", () => {
    const { root, base } = pullRequest({ "src/scale.ts": "the fix\n" });

    const result = placed(INPUTS(root));

    expect(result).toMatchObject({ status: "no-test-files", base, files: [] });
    expect(read(root, "src/scale.ts")).toBe("the fix\n");
    // A change to source with no test is the case the review most needs to see.
    expect(result.source).toEqual(["src/scale.ts"]);
  });

  it("says which input is missing where the command is set without the others", () => {
    const { root, head } = pullRequest({ "tests/scale.test.ts": "the new test\n" });

    const globs = placed(INPUTS(root, { TEST_GLOBS: " \n " }));

    expect(globs).toEqual({
      status: "misconfigured",
      reason:
        "The red check is configured with `red-check-command` but not `red-check-test-globs`. Set them in the review caller's `with:` block.",
      head,
      files: [],
    });
    expect(logged).toContain(`::error::${globs.reason ?? ""}`);
    expect(placed(INPUTS(root, { TEST_GLOBS: "", REPORT_PATH: "" })).reason).toContain(
      "but not `red-check-report` `red-check-test-globs`.",
    );
    // Nothing was placed.
    expect(read(root, "tests/scale.test.ts")).toBe("the new test\n");
  });

  it("says where there is no merge-base", () => {
    const { root, head } = pullRequest({ "tests/scale.test.ts": "the new test\n" });

    expect(placed(INPUTS(root, { BASE_REF: "nowhere" }))).toEqual({
      status: "no-merge-base",
      reason: `${head} has no merge-base with nowhere.`,
      head,
      files: [],
    });
  });

  /** git itself failing is not a placement: the command fails, and `classify` reports `failed`. */
  it("fails where the checkout is not a repository", () => {
    expect(() => placed(INPUTS(scratch()))).toThrow();
  });
});

describe("review:red-check-place runs a slice round against the PRD branch as it stood before the slice (#235)", () => {
  it("puts the slice's test files over the slice's base, with every earlier slice in it", () => {
    const { root, catchUp } = prdPullRequest();

    const result = placed(INPUTS(root, PRD));

    // The base is what the slice was built on: the catch-up merge, so the
    // default branch's later commits and slice one are both in it.
    expect(result).toMatchObject({ status: "ready", base: catchUp, slice: 232 });
    expect(read(root, "src/units.ts")).toBe("slice one's units\n");
    expect(read(root, "README.md")).toBe("moved on since\n");
    // And the slice's own change to source is not.
    expect(read(root, "src/scale.ts")).toBe("the bug\n");
    expect(read(root, "tests/scale.test.ts")).toBe("slice two's test\n");
    // Only this slice's tests, the fix round's included; slice one's was run
    // in its own round.
    expect([...result.files].sort()).toEqual(["tests/added.test.ts", "tests/scale.test.ts"]);
    expect(result.source).toEqual(["src/scale.ts"]);
    expect(logged.some((line) => line.startsWith("Slice round of #232"))).toBe(true);
  });

  /**
   * Against the merge-base, slice two's test of slice one's code would fail to
   * import and read as broken, telling the final review that slice two's change
   * is uncovered when its own round found it red. So nothing runs, and the
   * review reads each slice round's record instead.
   */
  it("runs nothing on the final review, which reads each slice round's record", () => {
    const { root } = prdPullRequest();
    const before = git(root, "rev-parse", "HEAD");

    const result = placed(INPUTS(root, { ...PRD, PR_BODY: `A body.\n${FINAL_REVIEW_MARK}\n` }));

    expect(result).toEqual({ status: "final-review", head: before, files: [] });
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
    expect(read(root, "src/units.ts")).toBe("slice one's units\n");
    // The mark counts only on a PRD branch.
    expect(placed(INPUTS(root, { PR_BODY: FINAL_REVIEW_MARK })).status).toBe("ready");
  });

  it("keeps the merge-base off a PRD branch, and on one with no slice trailer, saying so", () => {
    const { root, mergeBase } = prdPullRequest();

    const ordinary = placed(INPUTS(root));

    expect(ordinary).toMatchObject({ status: "ready", base: mergeBase });
    expect(ordinary.slice).toBeUndefined();

    const { root: untrailered, base } = pullRequest({ "tests/scale.test.ts": "the new test\n" });
    const result = placed(INPUTS(untrailered, PRD));

    expect(result).toMatchObject({ status: "ready", base });
    expect(result.slice).toBeUndefined();
    expect(logged.some((line) => line.startsWith("::warning::No commit on this PRD branch carries an `Agent-Slice` trailer"))).toBe(true);
  });
});
