import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { readFixDiff, renderFixDiffScope, type FixDiff } from "../../fix/fix-diff.js";
import { parseNameStatus } from "../../shared/diff-lines.js";
import { changedFilesCommandAgainstBase, diffCommandAgainstBase, type PullRequestFeedback } from "../../shared/pr-feedback.js";
import type { FollowUp } from "../../shared/review-output.js";

/**
 * The diff a fix run's prompt carries (#642): the files the open findings
 * name, a stat of the rest, and where the rest is; the whole diff where
 * anything owed work names no file. Read from a real repository, as the
 * runner reads its checkout.
 */

/** Where the reader's git runs. */
const fixture = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../shared/common.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/common.js")>()),
  git: (args: readonly string[]) =>
    execFileSync("git", ["-C", fixture.dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SUBPROCESS_TIMEOUT,
    }),
}));

const g = (...args: string[]): string =>
  execFileSync("git", ["-C", fixture.dir, ...args], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT });
const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(fixture.dir, file)), { recursive: true });
  fs.writeFileSync(path.join(fixture.dir, file), text);
};
const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n") + "\n";

const FILES = ["src/a.ts", "src/b.ts", "docs/c.md", "tests/d.test.ts"] as const;

/**
 * The feedback a fix run reads, over the fixture's pull request: its whole
 * diff and the files it changes, read the way `fetchPullRequestFeedback`
 * reads them, and nothing owed work unless a test says so.
 */
const feedback = (over: Partial<PullRequestFeedback> = {}): PullRequestFeedback =>
  ({
    humanSummaries: "",
    conversationComments: [],
    threadPaths: [],
    minorFindings: [],
    unreadable: [],
    diff: g(...diffCommandAgainstBase("main")),
    changedFiles: parseNameStatus(g(...changedFilesCommandAgainstBase("main"))),
    ...over,
  }) as unknown as PullRequestFeedback;

const minor = (location: string): FollowUp => ({ kind: "minor", severity: "Low", title: "t", body: "b", location }) as unknown as FollowUp;

/** The `# PR DIFF` section as the prompt renders it, the scope line and the fenced diff. */
const section = (d: FixDiff): string => `${renderFixDiffScope(d, "main")}\n\n\`\`\`diff\n${d.diff}\n\`\`\``;

beforeEach(() => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-diff-"));
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.test");
  g("config", "user.name", "test");
  for (const file of FILES) write(file, lines(file, 60));
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  g("checkout", "-q", "-b", "agent/issue-1-change");
  for (const file of FILES) write(file, lines(`${file}, changed`, 60));
  g("add", "-A");
  g("commit", "-q", "-m", "feat: the change");
});

afterEach(() => {
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

/** Each test makes two commits and up to four reads: well inside this. */
const ceiling = SUBPROCESS_TIMEOUT * 10;

describe("readFixDiff", () => {
  it(
    "carries the diff of the one file of four the findings name, and the rest in a stat",
    () => {
      const read = feedback({ threadPaths: ["src/b.ts", "src/b.ts"] });

      const d = readFixDiff(read, "main");

      expect(d.kind).toBe("named");
      if (d.kind !== "named") return;
      expect(d.files).toEqual(["src/b.ts"]);
      expect(d.diff).toBe(g("--literal-pathspecs", ...diffCommandAgainstBase("main"), "--", "src/b.ts"));
      expect(section(d).length).toBeLessThan(read.diff.length);
      for (const other of ["src/a.ts", "docs/c.md", "tests/d.test.ts"]) {
        expect(d.diff).not.toContain(other);
        expect(d.stat).toContain(other);
      }
      expect(d.stat).not.toContain("src/b.ts");
      const scope = renderFixDiffScope(d, "main");
      expect(scope).toContain("`git diff main...HEAD`");
      expect(scope).toContain("`git diff main...HEAD -- <file>`");
      expect(scope).toContain(d.stat);
    },
    ceiling,
  );

  it(
    "names a minor finding's file beside a thread's",
    () => {
      const d = readFixDiff(feedback({ threadPaths: ["src/b.ts"], minorFindings: [minor("docs/c.md:3-5")] }), "main");

      // In the order git lists the changed files.
      expect(d.kind === "named" ? d.files : d.kind).toEqual(["docs/c.md", "src/b.ts"]);
    },
    ceiling,
  );

  it.each<readonly [string, Partial<PullRequestFeedback>]>([
    ["a conversation-only finding", { conversationComments: [{ commentId: "IC_1", author: "maintainer" }] }],
    ["a conversation comment beside a thread", { threadPaths: ["src/b.ts"], conversationComments: [{ commentId: "IC_1", author: "maintainer" }] }],
    ["a maintainer's review body", { threadPaths: ["src/b.ts"], humanSummaries: "**@maintainer** (COMMENTED):\nTighten this up." }],
    ["a thread whose path did not come back", { threadPaths: ["src/b.ts", undefined] }],
    ["a thread on a file the pull request does not change", { threadPaths: ["src/b.ts", "README.md"] }],
    ["a minor finding on a path the pull request does not change", { threadPaths: ["src/b.ts"], minorFindings: [minor("src/typo.ts:4")] }],
    ["a surface that could not be read", { threadPaths: ["src/b.ts"], unreadable: [{ path: "repository.pullRequest.comments", reason: "FORBIDDEN", surfaces: ["conversation"], trustBearing: false }] }],
    ["findings that name every file", { threadPaths: [...FILES] }],
    ["nothing that names a file", {}],
  ])(
    "carries the whole diff for %s",
    (_name, over) => {
      const read = feedback(over);

      const d = readFixDiff(read, "main");

      expect(d).toEqual({ kind: "whole", diff: read.diff });
      expect(renderFixDiffScope(d, "main")).toBe(
        "The change under review: the pull request's whole diff against `main`, `git diff main...HEAD`, exactly what GitHub shows:",
      );
    },
    ceiling,
  );
});

describe("the fix runner and its prompt", () => {
  const RUNNER = fs.readFileSync(path.join(import.meta.dirname, "../../fix/fix.ts"), "utf8");
  const PROMPT = fs.readFileSync(path.join(import.meta.dirname, "../../fix/prompt.md"), "utf8");

  it("hands the prompt the diff readFixDiff chose, under the line that says what it is", () => {
    expect(RUNNER).toContain("readFixDiff(feedback, INPUTS.BASE_REF)");
    expect(RUNNER).toContain("DIFF_SCOPE: renderFixDiffScope(fixDiff, INPUTS.BASE_REF)");
    expect(RUNNER).toContain("PR_DIFF: fixDiff.diff");
    expect(PROMPT).toContain("# PR DIFF\n\n{{DIFF_SCOPE}}\n\n```diff\n{{PR_DIFF}}\n```");
  });
});
