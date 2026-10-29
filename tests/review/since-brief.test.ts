import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { briefSection, extractCriteria, readBrief } from "../../review/acceptance-criteria.js";
import { checkSinceBrief, renderSinceBriefForReview } from "../../review/since-brief.js";
import { MAX_SINCE_COMMITS, type SinceBrief } from "../../shared/review-output.js";

/**
 * What merged since the linked issue's brief was read (#541): the commits
 * since the commit its *Where things are* names that touched the files it
 * names, read from a real repository.
 */

/** Where the check's git runs, and every argument list it was handed. */
const fixture = vi.hoisted(() => ({ dir: "", calls: [] as string[][] }));

vi.mock("../../shared/common.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/common.js")>()),
  git: (args: readonly string[]) => {
    fixture.calls.push([...args]);
    return execFileSync("git", ["-C", fixture.dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SUBPROCESS_TIMEOUT,
    });
  },
}));

const g = (...args: string[]): string =>
  execFileSync("git", ["-C", fixture.dir, ...args], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT }).trim();
const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(fixture.dir, file)), { recursive: true });
  fs.writeFileSync(path.join(fixture.dir, file), text);
};
const commitAll = (message: string): string => {
  g("add", "-A");
  g("commit", "-q", "-m", message);
  return g("rev-parse", "HEAD");
};
const short = (sha: string): string => sha.slice(0, 7);

/** A brief, as triage posts it: criteria, then where things are. */
const brief = (where: string): ReturnType<typeof readBrief> =>
  readBrief("The issue as filed.", [`### Acceptance criteria\n\n- [ ] It works.\n\n${where}`]);

/** The ways the latest briefs write the section and its read-at line. */
const FORMS = [
  ["a heading, `main` and a date after a comma", (sha: string) => `### Where things are\n\nRead at \`main\` ${sha}, 2026-10-25.\n- \`src/a.ts\`: \`run\`.`],
  [
    "a heading, `main`, a tag in brackets and a date",
    (sha: string) => `### Where things are\n\nRead at \`main\` ${sha} (v0.8.11), 2026-10-24.\n- \`src/a.ts\` (\`run\`)`,
  ],
  ["a bold label and a date in brackets", (sha: string) => `**Where things are**\n\nRead at ${sha} (2026-10-25); hints only.\n- \`src/a.ts\``],
] as const;

let readAt: string;

beforeEach(() => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "since-brief-"));
  fixture.calls = [];
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.test");
  g("config", "user.name", "test");
  write("src/a.ts", "a\n");
  write("src/b.ts", "b\n");
  write("docs/c.md", "c\n");
  readAt = commitAll("base");
});

afterEach(() => {
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

describe("checkSinceBrief", () => {
  const SPAWNS = 40;
  const ceiling = SUBPROCESS_TIMEOUT * SPAWNS;

  it.each(FORMS)(
    "reads the read-at commit and the files from %s",
    (_form, where) => {
      write("src/a.ts", "a, changed\n");
      const touched = commitAll("feat: change a");

      const since = checkSinceBrief(brief(where(short(readAt))), "main");

      expect(since).toEqual({
        kind: "ran",
        commit: short(readAt),
        files: ["src/a.ts"],
        gone: [],
        notFound: [],
        onBase: { commits: [{ sha: touched, subject: "feat: change a" }], more: 0 },
      });
    },
    ceiling,
  );

  it(
    "lists a base commit that touched a named file, and not one that touched none, nor the commits under review",
    () => {
      write("src/a.ts", "a, changed\n");
      const touched = commitAll("feat: change a");
      write("src/other.ts", "other\n");
      commitAll("feat: an unrelated file");
      g("checkout", "-q", "-b", "topic");
      write("src/a.ts", "a, under review\n");
      commitAll("feat: the change under review");

      const since = checkSinceBrief(brief(`## Where things are\n\nRead at ${readAt}.\n- \`src/a.ts\`, \`docs/c.md\``), "main");

      expect(since.kind === "ran" && since.onBase).toEqual({ commits: [{ sha: touched, subject: "feat: change a" }], more: 0 });
      expect(since.kind === "ran" && since.files).toEqual(["src/a.ts", "docs/c.md"]);
    },
    ceiling,
  );

  it(
    "on a slice round, lists an earlier slice's commit apart from the base's, and never this slice's",
    () => {
      write("docs/c.md", "c, on main\n");
      const onMain = commitAll("docs: change c on main");
      g("checkout", "-q", "-b", "agent/prd-9-x");
      write("src/a.ts", "a, slice one\n");
      const earlier = commitAll("feat: slice one\n\nAgent-Slice: #10");
      write("src/b.ts", "b, slice one\n");
      const sliceBase = commitAll("feat: slice one, more\n\nAgent-Slice: #10");
      write("src/a.ts", "a, slice two\n");
      commitAll("feat: slice two\n\nAgent-Slice: #11");

      const since = checkSinceBrief(
        brief(`### Where things are\n\nRead at \`main\` ${short(readAt)}, 2026-10-26.\n- \`src/a.ts\`\n- \`docs/c.md\``),
        "main",
        sliceBase,
      );

      expect(since.kind === "ran" && since.onBase.commits.map((c) => c.sha)).toEqual([onMain]);
      expect(since.kind === "ran" && since.onBranch).toEqual({ commits: [{ sha: earlier, subject: "feat: slice one" }], more: 0 });
    },
    ceiling,
  );

  it(
    "takes a backticked word for a file only where it names a path at the read-at commit",
    () => {
      const since = checkSinceBrief(
        brief(
          `### Where things are\n\nRead at ${short(readAt)}.\n- \`src/a.ts\` (\`readBrief\`, \`main\`), \`src/\`, \`src/gone.ts\`, \`./docs/c.md\`, \`src/a.ts\``,
        ),
        "main",
      );

      expect(since.kind === "ran" && since.files).toEqual(["src/a.ts", "src", "docs/c.md"]);
      expect(since.kind === "ran" && since.notFound).toEqual(["src/gone.ts"]);
    },
    ceiling,
  );

  it(
    "names a file that existed at the read-at commit and is gone at the base",
    () => {
      g("rm", "-q", "src/b.ts");
      const removed = commitAll("refactor: remove b");

      const since = checkSinceBrief(brief(`### Where things are\n\nRead at ${short(readAt)}.\n- \`src/a.ts\`, \`src/b.ts\``), "main");

      expect(since.kind === "ran" && since.gone).toEqual(["src/b.ts"]);
      expect(since.kind === "ran" && since.onBase.commits.map((c) => c.sha)).toEqual([removed]);
    },
    ceiling,
  );

  it(
    "on a slice round whose start could not be read, lists the base's commits and says the branch's were not",
    () => {
      write("src/a.ts", "a, changed\n");
      const touched = commitAll("feat: change a");

      const since = checkSinceBrief(brief(`### Where things are\n\nRead at ${short(readAt)}.\n- \`src/a.ts\``), "main", null);

      expect(since).toEqual({
        kind: "ran",
        commit: short(readAt),
        files: ["src/a.ts"],
        gone: [],
        notFound: [],
        onBase: { commits: [{ sha: touched, subject: "feat: change a" }], more: 0 },
        branchUnread: true,
      });
    },
    ceiling,
  );

  it(
    `lists at most ${MAX_SINCE_COMMITS} commits, newest first, and counts the rest`,
    () => {
      const shas = Array.from({ length: MAX_SINCE_COMMITS + 3 }, (_, i) => {
        write("src/a.ts", `a ${i}\n`);
        return commitAll(`feat: change ${i}`);
      });
      g("checkout", "-q", "-b", "agent/prd-9-x");
      write("src/a.ts", "a, an earlier slice\n");
      const sliceBase = commitAll("feat: slice one");
      write("src/a.ts", "a, this slice\n");
      commitAll("feat: slice two");

      const since = checkSinceBrief(brief(`### Where things are\n\nRead at ${short(readAt)}.\n- \`src/a.ts\``), "main", sliceBase);

      expect(since.kind === "ran" && since.onBase.commits.map((c) => c.sha)).toEqual(shas.reverse().slice(0, MAX_SINCE_COMMITS));
      expect(since.kind === "ran" && since.onBase.more).toBe(3);
      expect(since.kind === "ran" && since.onBranch).toEqual({ commits: [], more: 1 });
    },
    SUBPROCESS_TIMEOUT * 120,
  );

  it.each([
    ["no *Where things are* section", "### Notes\n\nRead at abcdef1.", { kind: "not run", reason: "no section" }],
    ["no read-at commit in it", "### Where things are\n\n- `src/a.ts`", { kind: "not run", reason: "no read-at commit" }],
    ["a read-at commit that does not resolve", "### Where things are\n\nRead at abcdef1.\n- `src/a.ts`", { kind: "not run", reason: "unresolved", commit: "abcdef1" }],
  ] as const)(
    "says the check could not run on %s",
    (_case, where, expected) => {
      expect(checkSinceBrief(brief(where), "main")).toEqual(expected);
    },
    ceiling,
  );

  it(
    "says the check could not run on a read-at commit that is not on the base",
    () => {
      g("checkout", "-q", "-b", "elsewhere");
      write("src/a.ts", "a, elsewhere\n");
      const elsewhere = commitAll("feat: not on main");
      g("checkout", "-q", "main");

      expect(checkSinceBrief(brief(`### Where things are\n\nRead at ${short(elsewhere)}.\n- \`src/a.ts\``), "main")).toEqual({
        kind: "not run",
        reason: "not an ancestor",
        commit: short(elsewhere),
      });
    },
    ceiling,
  );

  it(
    "says the check could not run where no file it names exists at the read-at commit",
    () => {
      expect(checkSinceBrief(brief(`### Where things are\n\nRead at ${short(readAt)}.\n- \`src/nowhere.ts\`, \`readBrief\``), "main")).toEqual({
        kind: "not run",
        reason: "no file found",
        commit: short(readAt),
        notFound: ["src/nowhere.ts"],
      });
    },
    ceiling,
  );

  it(
    "never hands git a read-at word that is not hex, or a path, as an option",
    () => {
      write("-n/file.ts", "a path that starts with a dash\n");
      const base = commitAll("add a dash path");
      write("-n/file.ts", "changed\n");
      const touched = commitAll("feat: change the dash path");

      expect(checkSinceBrief(brief("### Where things are\n\nRead at --output=/tmp/x.\n- `src/a.ts`"), "main")).toEqual({
        kind: "not run",
        reason: "no read-at commit",
      });
      expect(fixture.calls).toEqual([]);

      const since = checkSinceBrief(brief(`### Where things are\n\nRead at ${short(base)}.\n- \`-n/file.ts\`, \`--all\``), "main");

      expect(since.kind === "ran" && since.files).toEqual(["-n/file.ts"]);
      expect(since.kind === "ran" && since.onBase.commits.map((c) => c.sha)).toEqual([touched]);
      // Every word from the brief reaches git after a `<commit>:` or after `--`, never as an argument of its own.
      for (const args of fixture.calls) {
        const end = args.indexOf("--");
        const options = (end === -1 ? args : args.slice(0, end)).filter((arg) => arg.startsWith("-"));
        expect(options.every((arg) => ["--verify", "--quiet", "--is-ancestor", "-t", "--literal-pathspecs", "--format=%H%x1f%s%x1e"].includes(arg))).toBe(true);
      }
    },
    ceiling,
  );
});

/**
 * One reader of "the latest brief" (#541, #544): the section comes from the
 * text the criteria do, never an earlier or a later one.
 */
describe("readBrief and briefSection", () => {
  const WHERE = /where things are/i;

  it("reads a section from the text the criteria come from", () => {
    const read = readBrief("## Acceptance criteria\n- [ ] The body's.\n\n## Where things are\n- `body.ts`", [
      "## Acceptance criteria\n- [ ] The brief's.\n\n**Where things are**\n- `brief.ts`",
      "## Where things are\n- `a-later-comment.ts`",
    ]);

    expect(read.criteria).toEqual(["The brief's."]);
    expect(briefSection(read, WHERE)).toEqual(["- `brief.ts`"]);
  });

  it("has no section where the brief has none, though an earlier text does", () => {
    const read = readBrief("## Acceptance criteria\n- [ ] The body's.\n\n## Where things are\n- `body.ts`", [
      "## Acceptance criteria\n- [ ] The brief's.",
    ]);

    expect(briefSection(read, WHERE)).toBeUndefined();
  });

  it("is the body where its criteria come from a checklist, and agrees with extractCriteria", () => {
    const body = "- [ ] One.\n\n**Where things are:**\n\nRead at abcdef1.";
    expect(readBrief(body).criteria).toEqual(extractCriteria(body));
    expect(briefSection(readBrief(body), WHERE)).toEqual(["", "Read at abcdef1."]);
  });
});

describe("renderSinceBriefForReview", () => {
  const ran: SinceBrief = {
    kind: "ran",
    commit: "abcdef1",
    files: ["src/a.ts"],
    gone: [],
    notFound: [],
    onBase: { commits: [{ sha: "1234567890", subject: "feat: change a" }], more: 2 },
    onBranch: { commits: [{ sha: "0987654321", subject: "feat: slice one" }], more: 0 },
  };

  it("lists the commits by group, with how many more", () => {
    const text = renderSinceBriefForReview(ran);
    expect(text).toContain("read at `abcdef1`");
    expect(text).toContain("- `1234567` feat: change a\n- (and 2 more, which `git log` lists)");
    expect(text).toContain("before this slice");
    expect(text).toContain("- `0987654` feat: slice one");
  });

  it("says the branch before this slice could not be read, with commits or without", () => {
    const unread = { ...ran, onBranch: undefined, branchUnread: true } as const;
    expect(renderSinceBriefForReview(unread)).toContain("branch before this slice could not be read");
    expect(renderSinceBriefForReview({ ...unread, onBase: { commits: [], more: 0 } })).toContain(
      "branch before this slice could not be read",
    );
  });

  it("says where git could not read the commits", () => {
    expect(renderSinceBriefForReview({ kind: "not run", reason: "unreadable" })).toContain("could not run: unreadable");
  });

  it.each([
    ["no check", undefined],
    ["a check that could not run", { kind: "not run", reason: "no section" } as const],
    ["a check that listed nothing", { ...ran, onBase: { commits: [], more: 0 }, onBranch: undefined }],
  ])("asks for no ruling on %s", (_case, since) => {
    expect(renderSinceBriefForReview(since)).toContain("leave `sinceBrief` out");
  });
});
