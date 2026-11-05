import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every runner prompt sends its agent to `CONTEXT.md`, which runs to hundreds
 * of lines and is read before any work on every run (#640). So it opens with a
 * glossary, and the prompts read that first and a section further down only
 * where the change touches it. A glossary is only a way in if every link in it
 * lands: a term whose anchor names no heading sends the agent to read the whole
 * file looking for it, or to read nothing.
 */
const CONTEXT_MD = fs.readFileSync("CONTEXT.md", "utf8");
const lines = CONTEXT_MD.split("\n");

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens, a repeat numbered. */
const anchors = (text: readonly string[]): ReadonlySet<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of text) {
    const match = /^#{1,6} (.*)$/.exec(line);
    if (match === null) continue;
    const base = (match[1] ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
};

const start = lines.indexOf("## Glossary");
const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
const glossary = lines.slice(start + 1, end);

/** The table's body rows: the header and its divider are not terms. */
const rows = glossary
  .filter((line) => line.startsWith("|"))
  .slice(2)
  .map((line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim()),
  );

describe("CONTEXT.md opens with a glossary", () => {
  it("has a Glossary section, and it is the first one", () => {
    expect(start).toBeGreaterThan(-1);
    expect(lines.find((line) => /^## /.test(line))).toBe("## Glossary");
  });

  it("has a header naming the term, its meaning, the words to avoid and its section", () => {
    expect(glossary.find((line) => line.startsWith("|"))).toMatch(/^\| Term \| Means \| Avoid \| Section \|$/);
  });

  it("has terms", () => {
    expect(rows.length).toBeGreaterThan(10);
  });

  it.each(rows.map((row) => [row[0] ?? "", row] as const))("%s: has a one-line meaning and a link to its section", (_term, row) => {
    expect(row).toHaveLength(4);
    expect(row[0]).not.toBe("");
    expect(row[1]).not.toBe("");
    expect(row[3]).toMatch(/\]\(#[^)]+\)/);
  });

  it("links only to headings the file has, outside the glossary itself", () => {
    const targets = anchors([...lines.slice(0, start), ...lines.slice(end)]);
    const links = [...glossary.join("\n").matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1] ?? "");
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((link) => !targets.has(link))).toEqual([]);
  });

  /**
   * A link saves reading only if what it lands on is short: the one ~480-line
   * `What this is` section, with no subheadings, took 25 rows to half the file
   * (#696). What a heading holds is read up to the next heading of any level.
   */
  it("links only to headings whose own text, up to the next heading, is short enough to read alone", () => {
    const MAX_LINES = 150;
    const below = lines.slice(end);
    const headings = below.flatMap((line, i) => (/^#{1,6} /.test(line) ? [i] : []));
    /** A heading's anchor is the last one `anchors` adds for the headings up to it, which numbers a repeat. */
    const sizes = new Map(
      headings.map((at, k) => [
        [...anchors(headings.slice(0, k + 1).map((i) => below[i] ?? ""))].at(-1) ?? "",
        (headings[k + 1] ?? below.length) - at,
      ]),
    );
    const links = new Set([...glossary.join("\n").matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1] ?? ""));
    const long = [...links].filter((link) => (sizes.get(link) ?? 0) > MAX_LINES).map((link) => `${link}: ${sizes.get(link)} lines`);
    expect(long).toEqual([]);
  });

  it("links to every section below it, so none is reachable only by reading the whole file", () => {
    const sections = lines.slice(end).filter((line) => /^## /.test(line));
    const linked = new Set([...glossary.join("\n").matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1] ?? ""));
    const missing = sections.filter((line) => ![...anchors([line])].every((anchor) => linked.has(anchor)));
    expect(missing).toEqual([]);
  });
});

/**
 * `docs/agents/domain.md` is what the engineering skills read for how to use
 * `CONTEXT.md`, and it promised "avoid" lists before the file had any.
 */
describe("docs/agents/domain.md describes the glossary", () => {
  const domain = fs.readFileSync(path.join("docs", "agents", "domain.md"), "utf8").replace(/\s+/g, " ");

  it("names the glossary at the top of CONTEXT.md and its Avoid column", () => {
    expect(domain).toContain("`## Glossary`");
    expect(domain).toContain("*Avoid*");
  });
});
