import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNNERS } from "../shared/contract.js";

const read = (prompt: string): string => fs.readFileSync(prompt, "utf8").replace(/\s+/g, " ");

/**
 * Nothing reads a closing summary (#338): fix's runner reads only the
 * extraction pass's `<output>` block, and implement's (#272) and
 * implement-prd's only a `<stale>` tag. So a finished run ends on the promise and nothing else.
 */
describe.each(["fix/prompt.md", "implement/prompt.md", "implement-prd/prompt.md"])("%s ends without a summary", (prompt) => {
  it("asks for only the promise, and no summary", () => {
    const text = read(prompt);
    expect(text).toContain("output only `<promise>COMPLETE</promise>`, with no summary of what you did");
  });
});

it("fix still keeps track of which thread each change answers, which the extraction pass relies on", () => {
  expect(read("fix/prompt.md")).toContain("Keep track as you go of which thread each change answers");
});

it.each(["implement/prompt.md", "implement-prd/prompt.md"])("%s's stale stop still ends with its tag rather than the promise", (prompt) => {
  const text = read(prompt);
  expect(text).toContain("End your output with `<stale>` and `</stale>`");
  expect(text).toContain("A run you stopped as stale ends with its `<stale>` tag instead");
});

/**
 * implement-prd (#338) and implement (#272) verified after every round of edits. It runs the tests
 * that cover the change while iterating, and the verify command once, which
 * the commit-early line (#303) and a later commit's re-run agree with.
 */
describe.each(["implement/prompt.md", "implement-prd/prompt.md"])("%s verifies once", (prompt) => {
  const text = read(prompt);

  it("runs the test files that cover the change while iterating", () => {
    expect(text).toContain("While iterating, run the test files that cover your change, not the whole suite.");
  });

  it("runs the verify command once before committing, and again only after a change", () => {
    expect(text).toContain(
      "Run the verify command `CLAUDE.md` names once, before committing. It must pass. Run it again only if anything changed after it passed.",
    );
  });

  it("words a later commit as the change that re-runs it", () => {
    expect(text).toContain("A later commit is a change after that pass, so run the verify command again before making it.");
  });
});

it("implement searches a saved test run rather than running the tests again to search them", () => {
  expect(read("implement/prompt.md")).toContain(
    "Save the full output of a test run to a file and search that file, rather than running the tests again to search them.",
  );
});

/**
 * `claude -p` loads `CLAUDE.md` itself (#272), so implement says it is in
 * context rather than asking for a second copy, and keeps the reason it
 * defers to it. `CONTEXT.md` is not loaded, so that read stays.
 */
describe("implement treats CLAUDE.md as already loaded", () => {
  const text = read("implement/prompt.md");

  it("says CLAUDE.md is already in context and the rules to follow", () => {
    expect(text).toContain("`CLAUDE.md` is already in your context; do not read it again. It is the rules to follow");
  });

  it("keeps the reason for deferring to it", () => {
    expect(text).toContain("it is the copy that is kept current");
  });

  it("still asks for CONTEXT.md to be read", () => {
    expect(text).toContain("Read `CONTEXT.md` before changing code");
  });
});

/**
 * The same holds for every runner (#638): each starts `claude -p` in the
 * checkout, which loads `CLAUDE.md` before the prompt is read, so a prompt
 * asking for it again pays for a second copy on every run. Each says it is
 * already loaded, and none asks for it to be read; the `CONTEXT.md` read stays.
 */
describe.each(Object.keys(RUNNERS).map((runner) => `${runner}/prompt.md`))("%s does not re-read CLAUDE.md", (prompt) => {
  const text = fs.readFileSync(prompt, "utf8");

  it("asks for no read of CLAUDE.md", () => {
    // A sentence runs to a full stop that ends it, not the one in a file name.
    expect(read(prompt)).not.toMatch(/\bRead\b(?:[^.]|\.(?!\s))*`CLAUDE\.md`/);
    // Nor a list of what to read with it as an item.
    expect(text).not.toMatch(/^\s*- `CLAUDE\.md`:/m);
  });

  it("says CLAUDE.md is already in context, and still asks for CONTEXT.md", () => {
    expect(read(prompt)).toContain("`CLAUDE.md` is already in your context; do not read it again.");
    expect(read(prompt)).toMatch(/Read `CONTEXT\.md`/);
  });
});
