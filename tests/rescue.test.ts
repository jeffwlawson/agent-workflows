import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ignoredNote, rescueRef, resumeFromRescue, resumeSection } from "../shared/rescue.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The runner's half of rescue and resume (#303), against real git: a
 * repository standing in for the agent's checkout, at the head the run
 * started from, with the rescue branch fetched where the workflow fetches it.
 *
 * Skipped where `git` is not on PATH.
 */

const CAN_RUN = spawnSync("git", ["--version"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

/** A few git spawns to build the repository, and the helper's own. */
const CEILING = 12 * SUBPROCESS_TIMEOUT;

const BRANCH = "agent/rescue/fix-12";

const IDENTITY = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: { ...process.env, ...IDENTITY },
  }).trim();

const commit = (cwd: string, file: string): string => {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
};

const home = process.cwd();
afterEach(() => process.chdir(home));

/** A checkout at `head`, the commit the run starts from, and that commit. */
const checkout = (): { readonly dir: string; readonly head: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rescue-"));
  git(dir, "init", "--quiet", "--initial-branch=work");
  const head = commit(dir, "base.txt");
  return { dir, head };
};

/** Commits on top of `from`, saved at the rescue ref as the agent's job fetches it, with `HEAD` left where it was. */
const rescue = (dir: string, from: string, files: readonly string[]): string => {
  const back = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--quiet", "--detach", from);
  for (const file of files) commit(dir, file);
  const tip = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", rescueRef(BRANCH), tip);
  git(dir, "checkout", "--quiet", "work");
  git(dir, "reset", "--quiet", "--hard", back);
  return tip;
};

describe.skipIf(!CAN_RUN)("resumeFromRescue", () => {
  it(
    "starts from the rescued commits where they build on the head",
    () => {
      const { dir, head } = checkout();
      const tip = rescue(dir, head, ["one.txt", "two.txt"]);
      process.chdir(dir);

      expect(resumeFromRescue(BRANCH)).toEqual({ kind: "resumed", commits: 2 });
      expect(git(dir, "rev-parse", "HEAD")).toBe(tip);
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work");
    },
    CEILING,
  );

  it(
    "sets the rescue aside where the head moved since it was saved",
    () => {
      const { dir, head } = checkout();
      rescue(dir, head, ["one.txt"]);
      const moved = commit(dir, "moved.txt");
      process.chdir(dir);

      expect(resumeFromRescue(BRANCH)).toEqual({ kind: "ignored" });
      expect(git(dir, "rev-parse", "HEAD")).toBe(moved);
    },
    CEILING,
  );

  it(
    "does nothing where there is no rescue branch",
    () => {
      const { dir, head } = checkout();
      process.chdir(dir);

      expect(resumeFromRescue(BRANCH)).toEqual({ kind: "none" });
      expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    },
    CEILING,
  );

  /**
   * A rescue at the head holds nothing to resume. One behind it was saved
   * before the head moved, as any other is, and is set aside.
   */
  it(
    "does nothing where the rescue is the head itself, and sets aside one behind it",
    () => {
      const { dir } = checkout();
      const head = commit(dir, "landed.txt");
      git(dir, "update-ref", rescueRef(BRANCH), git(dir, "rev-parse", "HEAD~1"));
      process.chdir(dir);

      expect(resumeFromRescue(BRANCH)).toEqual({ kind: "ignored" });
      git(dir, "update-ref", rescueRef(BRANCH), head);
      expect(resumeFromRescue(BRANCH)).toEqual({ kind: "none" });
    },
    CEILING,
  );
});

describe("the resume prompt section", () => {
  it("tells a resumed agent its commits are unverified and to run the verify command first", () => {
    const section = resumeSection({ kind: "resumed", commits: 3 }, BRANCH);

    expect(section).toContain(`\`${BRANCH}\``);
    expect(section).toContain("3 commit(s)");
    expect(section).toContain("unverified");
    expect(section).toContain("Run the verify command `CLAUDE.md` names before going further");
  });

  it("is empty where the run did not resume", () => {
    expect(resumeSection({ kind: "none" }, BRANCH)).toBe("");
    expect(resumeSection({ kind: "ignored" }, BRANCH)).toBe("");
  });

  it("says a set-aside rescue was not used, naming the branch", () => {
    const note = ignoredNote("agent:fix", BRANCH, "this pull request's head");

    expect(note).toMatch(/^\*\*`agent:fix` started fresh:\*\* /);
    expect(note).toContain(`\`${BRANCH}\``);
    expect(note).toContain("this pull request's head has moved since");
    expect(note).not.toContain("—");
  });
});

/**
 * Each prompt the rescue serves (#303): the section a resumed run opens with,
 * and the line asking for the first commit as soon as the work passes, since
 * only committed work survives a run stopped at its limit.
 */
describe.each([
  { prompt: "fix/prompt.md", runner: "fix/fix.ts" },
  { prompt: "implement-prd/prompt.md", runner: "implement-prd/implement-prd.ts" },
])("$prompt resumes and commits early", ({ prompt, runner }) => {
  const text = fs.readFileSync(prompt, "utf8");

  it("asks for a commit as soon as the work first passes the verify command", () => {
    expect(text.replace(/\s+/g, " ")).toContain(
      "Commit as soon as the work first passes the verify command `CLAUDE.md` names, and make later changes as further commits.",
    );
  });

  it("has a place for the resume section, which its runner fills", () => {
    expect(text).toContain("{{RESUME}}");
    expect(fs.readFileSync(runner, "utf8")).toContain("RESUME: resumeSection(resume, RESCUE_BRANCH)");
  });
});
