import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { readPromptDiff, renderDiffScope, scopedSize, type PromptDiff } from "../../review/review-diff.js";
import type { ReviewHistory } from "../../review/review-round.js";
import { keyedByChangedFiles, parseDiffLines, parseNameStatus } from "../../shared/diff-lines.js";
import { changedFilesCommandAgainstBase, diffCommandAgainstBase } from "../../shared/pr-feedback.js";
import { placeFindings } from "../../shared/review-findings.js";

/**
 * The diff a review's prompt carries (#641): on a verification pass, what
 * changed since the last review plus the pull request's hunks of the files
 * that touched and its `--stat`; on every other review, the whole diff. Read
 * from a real repository, as the runner reads its checkout.
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
const commitAll = (message: string): string => {
  g("add", "-A");
  g("commit", "-q", "-m", message);
  return g("rev-parse", "HEAD").trim();
};
const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n") + "\n";

/** The pull request as the runner reads it: its whole diff, and the files it changes. */
const pullRequest = (): { whole: string; changed: string[] } => ({
  whole: g(...diffCommandAgainstBase("main")),
  changed: parseNameStatus(g(...changedFilesCommandAgainstBase("main"))),
});

/** The `# PR DIFF` section as the prompt renders it, the scope line and the fenced diff. */
const section = (d: PromptDiff): string => `${renderDiffScope(d, "main")}\n\n\`\`\`diff\n${d.diff}\n\`\`\``;

const afterFixRound = (reviewedHead: string): ReviewHistory => ({ afterFixRound: true, unreviewedCommits: true, reviewedHead });

interface Built {
  /** The head the review before the fix round read. */
  readonly reviewed: string;
  /** The one file the fix round touched. */
  readonly fixed: string;
  /** A file the pull request changes and the fix round did not touch. */
  readonly untouched: string;
}

/**
 * Two pull requests whose fix round touched one file: one where the round was
 * one commit, and one where it was two, after a pull request that added a new
 * file and edited an old one.
 */
const FIXTURES: readonly (readonly [string, () => Built])[] = [
  [
    "a fix round of one commit, over three changed files",
    () => {
      write("src/a.ts", lines("a, changed", 40));
      write("src/b.ts", lines("b, changed", 120));
      write("docs/c.md", lines("c, changed", 80));
      const reviewed = commitAll("feat: the change");
      write("src/a.ts", lines("a, changed", 40).replace("a, changed line 7", "a, fixed line 7"));
      commitAll("fix: the finding on a");
      return { reviewed, fixed: "src/a.ts", untouched: "src/b.ts" };
    },
  ],
  [
    "a fix round of two commits, over a new file and an edited one",
    () => {
      write("src/new.ts", lines("new", 200));
      write("docs/c.md", lines("c, changed", 30));
      const reviewed = commitAll("feat: the change");
      write("docs/c.md", lines("c, changed", 30).replace("c, changed line 3", "c, fixed line 3"));
      commitAll("fix: the first finding");
      write("docs/c.md", lines("c, changed", 30).replace("c, changed line 3", "c, fixed line 3") + "c, appended\n");
      commitAll("fix: the second finding");
      return { reviewed, fixed: "docs/c.md", untouched: "src/new.ts" };
    },
  ],
];

beforeEach(() => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-diff-"));
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.test");
  g("config", "user.name", "test");
  write("src/a.ts", lines("a", 40));
  write("src/b.ts", lines("b", 120));
  write("docs/c.md", lines("c", 80));
  commitAll("base");
  g("checkout", "-q", "-b", "agent/issue-1-change");
});

afterEach(() => {
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

/** Each test makes a fixture's worth of commits and up to six reads: well inside this. */
const ceiling = SUBPROCESS_TIMEOUT * 20;

describe("readPromptDiff on a verification pass", () => {
  it.each(FIXTURES)(
    "is smaller than the whole diff, and holds what the round changed, for %s",
    (_name, build) => {
      const built = build();
      const { whole, changed } = pullRequest();

      const scoped = readPromptDiff(afterFixRound(built.reviewed), undefined, "main", whole, changed);

      expect(scoped.kind).toBe("since");
      if (scoped.kind !== "since") return;
      expect(scoped.files).toEqual([built.fixed]);
      expect(section(scoped).length).toBeLessThan(whole.length);
      // The round's own diff, the pull request's whole diff of the file it
      // touched, and the stat of every file, each by its own reading.
      expect(scoped.since).toContain("fixed line");
      expect(scoped.diff).toBe(g("--literal-pathspecs", ...diffCommandAgainstBase("main"), "--", built.fixed));
      expect(scoped.diff).not.toContain(built.untouched);
      for (const file of changed) expect(scoped.stat).toContain(file);
      // And the brief says where the rest is.
      const scope = renderDiffScope(scoped, "main");
      expect(scope).toContain("`git diff main...HEAD -- <file>`");
      expect(scope).toContain(built.reviewed.slice(0, 7));
    },
    ceiling,
  );

  it(
    "carries the whole diff, and says how large the scoped form would be, where the round touched most of the pull request",
    () => {
      write("src/a.ts", lines("a, changed", 40));
      write("src/b.ts", lines("b, changed", 120));
      write("docs/c.md", lines("c, changed", 80));
      const reviewed = commitAll("feat: the change");
      write("src/a.ts", lines("a, changed", 40).replace("a, changed line 7", "a, fixed line 7"));
      write("src/b.ts", lines("b, changed", 120).replace("b, changed line 7", "b, fixed line 7"));
      write("docs/c.md", lines("c, changed", 80).replace("c, changed line 7", "c, fixed line 7"));
      commitAll("fix: the findings on a, b and c");
      const { whole, changed } = pullRequest();

      const d = readPromptDiff(afterFixRound(reviewed), undefined, "main", whole, changed);

      expect(d.kind).toBe("whole");
      if (d.kind !== "whole") return;
      expect(d.diff).toBe(whole);
      // The scoped form, read as readPromptDiff reads it, is no smaller.
      const stat = g(...diffCommandAgainstBase("main"), "--stat=1000").trimEnd();
      const since = g("-c", "core.quotePath=false", "diff", reviewed, "HEAD").trimEnd();
      const touched = g("--literal-pathspecs", ...diffCommandAgainstBase("main"), "--", ...[...changed].sort());
      expect(d.scopedSize).toBe(scopedSize({ stat, since, diff: touched }));
      expect(d.scopedSize).toBeGreaterThanOrEqual(whole.length);
      // Nothing was left out, so the brief asks howChecked for nothing.
      expect(renderDiffScope(d, "main")).toBe("The whole pull request's diff against `main`, `git diff main...HEAD`:");
    },
    ceiling,
  );

  it(
    "places a finding on a line the prompt left out but the pull request changed",
    () => {
      const built = FIXTURES[0]![1]();
      const { whole, changed } = pullRequest();
      const scoped = readPromptDiff(afterFixRound(built.reviewed), undefined, "main", whole, changed);
      expect(section(scoped)).not.toContain("b, changed line 60");

      // As the runner places them: off the whole pull request's diff lines.
      const { placed, unanchored } = placeFindings(
        [{ title: "off by one", path: built.untouched, line: 60, body: "**Fix before merge.** off by one", severity: "medium" }],
        keyedByChangedFiles(parseDiffLines(whole), changed),
      );

      expect(unanchored).toEqual([]);
      expect(placed[0]?.placement).toBe("line");
    },
    ceiling,
  );

  it(
    "carries the whole diff, and asks howChecked to say why, where the history could not be read",
    () => {
      FIXTURES[0]![1]();
      const { whole, changed } = pullRequest();
      const history: ReviewHistory = {
        afterFixRound: true,
        unreviewedCommits: false,
        unreadable: "this pull request's commits could not be listed",
      };

      const d = readPromptDiff(history, undefined, "main", whole, changed);

      expect(d).toEqual({ kind: "unreadable", reason: "this pull request's commits could not be listed", diff: whole });
      expect(renderDiffScope(d, "main")).toMatch(/this pull request's commits could not be listed[\s\S]*Say so in `howChecked`/);
    },
    ceiling,
  );

  it(
    "carries the whole diff, and asks howChecked to say why, where git cannot read the range",
    () => {
      FIXTURES[0]![1]();
      const { whole, changed } = pullRequest();
      const gone = "0123456789abcdef0123456789abcdef01234567";

      const d = readPromptDiff(afterFixRound(gone), undefined, "main", whole, changed);

      expect(d.kind).toBe("unreadable");
      expect(d.diff).toBe(whole);
      const scope = renderDiffScope(d, "main");
      expect(scope).toContain("git could not read the commits since 0123456, the head the last review read");
      expect(scope).toContain("Say so in `howChecked`");
    },
    ceiling,
  );
});

/**
 * A merge of the base branch since the reviewed head (#698): `update-branch`
 * merges the base into the pull request, and its review still follows the fix
 * round. Each fixture is made by git itself: a commit on `main`, then `git
 * merge main` on the pull request's branch.
 */
describe("readPromptDiff after a merge of the base branch", () => {
  /** Commits on `main`, then back to the pull request's branch. */
  const onMain = (change: () => void): void => {
    g("checkout", "-q", "main");
    change();
    commitAll("base: someone else's change");
    g("checkout", "-q", "agent/issue-1-change");
  };
  const mergeMain = (): void => {
    g("merge", "-q", "--no-edit", "main");
  };

  it.each([
    ["after the fix commit", false],
    ["before the fix commit", true],
  ] as const)(
    "leaves the base branch's changes out of what changed since, where the merge landed %s",
    (_name, mergeFirst) => {
      write("src/a.ts", lines("a, changed", 40));
      write("src/b.ts", lines("b, changed", 120));
      const reviewed = commitAll("feat: the change");
      onMain(() => {
        write("docs/c.md", lines("c, on main", 80));
        write("src/other.ts", lines("other, on main", 60));
      });
      const fix = (): void => {
        write("src/a.ts", lines("a, changed", 40).replace("a, changed line 7", "a, fixed line 7"));
        commitAll("fix: the finding on a");
      };
      if (mergeFirst) mergeMain();
      fix();
      if (!mergeFirst) mergeMain();
      const { whole, changed } = pullRequest();
      // Two-dot, the merge's changes are in the range: the defect this guards.
      expect(g("diff", "--name-only", reviewed, "HEAD")).toContain("src/other.ts");

      const scoped = readPromptDiff(afterFixRound(reviewed), undefined, "main", whole, changed);

      expect(scoped.kind).toBe("since");
      if (scoped.kind !== "since") return;
      expect(scoped.mergedBase).toBe(g("merge-base", "main", "HEAD").trim());
      expect(scoped.files).toEqual(["src/a.ts"]);
      expect(scoped.since).toContain("a, fixed line 7");
      expect(scoped.since).not.toContain("on main");
      expect(scoped.since).not.toContain("src/other.ts");
      expect(scoped.stat).not.toContain("src/other.ts");
      expect(section(scoped).length).toBeLessThan(whole.length);
      expect(renderDiffScope(scoped, "main")).toContain(`git merge-tree --write-tree ${reviewed.slice(0, 7)}`);
    },
    ceiling,
  );

  it(
    "leaves out the base branch's change to a file the pull request also changes",
    () => {
      write("src/b.ts", lines("b", 120).replace("b line 100", "b, changed line 100"));
      // A second file the round leaves alone, so the scoped form is the smaller.
      write("docs/c.md", lines("c, changed", 80));
      const reviewed = commitAll("feat: the change");
      onMain(() => write("src/b.ts", lines("b", 120).replace("b line 5", "b, on main line 5")));
      mergeMain();
      write("src/b.ts", g("show", "HEAD:src/b.ts").replace("b, changed line 100", "b, fixed line 100"));
      commitAll("fix: the finding on b");
      const { whole, changed } = pullRequest();

      const scoped = readPromptDiff(afterFixRound(reviewed), undefined, "main", whole, changed);

      expect(scoped.kind).toBe("since");
      if (scoped.kind !== "since") return;
      expect(scoped.files).toEqual(["src/b.ts"]);
      expect(scoped.since).toContain("b, fixed line 100");
      expect(scoped.since).not.toContain("on main");
    },
    ceiling,
  );

  it(
    "carries the whole diff, and asks howChecked to say why, where the merge conflicted",
    () => {
      write("src/a.ts", lines("a", 40).replace("a line 7", "a, changed line 7"));
      const reviewed = commitAll("feat: the change");
      onMain(() => write("src/a.ts", lines("a", 40).replace("a line 7", "a, on main line 7")));
      try {
        mergeMain();
      } catch {
        // The conflict, resolved as a person would: the pull request's side.
      }
      write("src/a.ts", lines("a", 40).replace("a line 7", "a, resolved line 7"));
      commitAll("merge main");
      const { whole, changed } = pullRequest();

      const d = readPromptDiff(afterFixRound(reviewed), undefined, "main", whole, changed);

      expect(d.kind).toBe("unreadable");
      expect(d.diff).toBe(whole);
      const scope = renderDiffScope(d, "main");
      expect(scope).toContain(`does not merge cleanly into ${reviewed.slice(0, 7)}`);
      expect(scope).toContain("Say so in `howChecked`");
    },
    ceiling,
  );
});

describe("readPromptDiff on any other review", () => {
  it(
    "carries the whole diff on a first review, a final review and a slice round",
    () => {
      const built = FIXTURES[0]![1]();
      const { whole, changed } = pullRequest();

      const first = readPromptDiff({ afterFixRound: false, unreviewedCommits: true }, undefined, "main", whole, changed);
      const final = readPromptDiff(afterFixRound(built.reviewed), { kind: "final", parent: "7" }, "main", whole, changed);
      const slice = readPromptDiff(
        afterFixRound(built.reviewed),
        { kind: "slice", parent: "7", slice: undefined, unknownBecause: "no slice" },
        "main",
        whole,
        changed,
      );

      for (const d of [first, final, slice]) {
        expect(d).toEqual({ kind: "whole", diff: whole });
        expect(renderDiffScope(d, "main")).toBe("The whole pull request's diff against `main`, `git diff main...HEAD`:");
      }
    },
    ceiling,
  );

  it(
    "carries the whole diff after a fix round that pushed nothing",
    () => {
      FIXTURES[0]![1]();
      const { whole, changed } = pullRequest();

      expect(readPromptDiff({ afterFixRound: true, unreviewedCommits: false }, undefined, "main", whole, changed)).toEqual({
        kind: "whole",
        diff: whole,
      });
    },
    ceiling,
  );
});

describe("the review runner and its prompt", () => {
  const RUNNER = fs.readFileSync(path.join(import.meta.dirname, "../../review/review.ts"), "utf8");
  const PROMPT = fs.readFileSync(path.join(import.meta.dirname, "../../review/prompt.md"), "utf8");

  it("hands the prompt the diff readPromptDiff chose, under the line that says what it is", () => {
    expect(RUNNER).toContain("readPromptDiff(history, round, BASE_REF, context.diff, context.diffLines.keys())");
    expect(RUNNER).toContain("DIFF_SCOPE: renderDiffScope(promptDiff, BASE_REF)");
    expect(RUNNER).toContain("PR_DIFF: promptDiff.diff");
    expect(PROMPT).toContain("# PR DIFF\n\n{{DIFF_SCOPE}}\n\n```diff\n{{PR_DIFF}}\n```");
  });

  it("logs both sizes where the scoped form was no smaller than the whole", () => {
    expect(RUNNER).toContain("because the scoped form would be ${promptDiff.scopedSize} bytes");
  });

  it("places findings off the whole pull request's diff, not the prompt's", () => {
    expect(RUNNER).toContain("placeFindings(reviewed.findings, context.diffLines)");
  });
});
