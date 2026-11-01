import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `CLAUDE.md` is loaded into every agent run in this repository and every
 * session here, so its length is paid on each of them (#639). It keeps what
 * every change needs, and each topic for one kind of change lives in its own
 * file behind a pointer that says when to read it.
 */
const CLAUDE_MD = fs.readFileSync("CLAUDE.md", "utf8");
const MAX_LINES = 150;

const headings = (text: string): readonly string[] =>
  text
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => line.replace(/^#+ /, ""));

/** The headings of `CLAUDE.md` at 4896b68 that stayed in it. */
const KEPT = [
  "CLAUDE.md",
  "Commands",
  "Domain",
  "Conventions",
  "Line endings",
  "Asking me to decide",
  "When a message doesn't land",
] as const;

/** The headings of `CLAUDE.md` at 4896b68 that moved, each to the file that now holds it. */
const MOVED: Readonly<Record<string, string>> = {
  "This repo runs its own loop, on the last release": "docs/adr/0010-this-repo-runs-its-own-loop-on-the-last-release.md",
  "Changing a workflow": "docs/agents/changing-a-workflow.md",
  "Changing a runner or a command": "docs/agents/changing-a-runner-or-a-command.md",
  Releasing: "docs/agents/releasing.md",
  "Changing the install path": "docs/agents/changing-the-install-path.md",
  "Agent skills": "docs/agents/agent-skills.md",
  "Issue tracker": "docs/agents/agent-skills.md",
  "Triage labels": "docs/agents/agent-skills.md",
  "Domain docs": "docs/agents/agent-skills.md",
};

describe("CLAUDE.md is a short core", () => {
  it(`is at most ${MAX_LINES} lines`, () => {
    expect(CLAUDE_MD.trimEnd().split("\n").length).toBeLessThanOrEqual(MAX_LINES);
  });

  it.each(KEPT)("still has its section %s", (heading) => {
    expect(headings(CLAUDE_MD)).toContain(heading);
  });

  it("has no section that is neither kept nor moved", () => {
    const known = new Set<string>([...KEPT, ...Object.keys(MOVED)]);
    expect(headings(CLAUDE_MD).filter((heading) => !known.has(heading) && heading !== "Read before a change of this kind")).toEqual([]);
  });
});

describe.each(Object.entries(MOVED))("CLAUDE.md's section %s moved to %s", (heading, target) => {
  it("is a heading of the file it moved to", () => {
    expect(fs.existsSync(target)).toBe(true);
    expect(headings(fs.readFileSync(target, "utf8"))).toContain(heading);
  });

  it("is no longer a heading of CLAUDE.md", () => {
    expect(headings(CLAUDE_MD)).not.toContain(heading);
  });

  it("is linked from CLAUDE.md", () => {
    expect(CLAUDE_MD).toContain(`](./${target})`);
  });
});

/**
 * Moving a file under `docs/agents/` moves its relative links with it: a link
 * written for the repository root resolves nowhere from there.
 */
it.each([...new Set(["CLAUDE.md", ...Object.values(MOVED)])])("%s links only to files that exist", (file) => {
  const links = [...fs.readFileSync(file, "utf8").matchAll(/\]\((\.{1,2}\/[^)#\s]+)(?:#[^)]*)?\)/g)].map((match) => match[1] ?? "");
  expect(links.filter((link) => !fs.existsSync(path.join(path.dirname(file), link)))).toEqual([]);
});

/**
 * A moved section cited by name from another moved file was a section of the
 * same file before the split, so the bare `*name*` sent a reader nowhere once
 * it moved (#654's review). A citation of one is a link to the file that holds it.
 */
it.each([...new Set(Object.values(MOVED))])("%s cites a moved section only as a link", (file) => {
  const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ").replace(/\*\*[^*]+\*\*/g, "");
  const cited = [...text.matchAll(/(?<!\[)\*([^*]+)\*(?!\])/g)].map((match) => match[1] ?? "");
  const own = new Set(headings(fs.readFileSync(file, "utf8")));
  expect(cited.filter((name) => Object.keys(MOVED).some((heading) => !own.has(heading) && heading.startsWith(name)))).toEqual([]);
});
