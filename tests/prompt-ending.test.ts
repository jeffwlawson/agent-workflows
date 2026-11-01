import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (prompt: string): string => fs.readFileSync(prompt, "utf8").replace(/\s+/g, " ");

/**
 * Nothing reads a closing summary (#338): fix's runner reads only the
 * extraction pass's `<output>` block, and implement-prd's only a `<stale>`
 * tag. So a finished run ends on the promise and nothing else.
 */
describe.each(["fix/prompt.md", "implement-prd/prompt.md"])("%s ends without a summary", (prompt) => {
  it("asks for only the promise, and no summary", () => {
    const text = read(prompt);
    expect(text).toContain("output only `<promise>COMPLETE</promise>`, with no summary of what you did");
  });
});

it("fix still keeps track of which thread each change answers, which the extraction pass relies on", () => {
  expect(read("fix/prompt.md")).toContain("Keep track as you go of which thread each change answers");
});

it("implement-prd's stale stop still ends with its tag rather than the promise", () => {
  const text = read("implement-prd/prompt.md");
  expect(text).toContain("End your output with `<stale>` and `</stale>`");
  expect(text).toContain("A run you stopped as stale ends with its `<stale>` tag instead");
});

/**
 * implement-prd verified after every round of edits (#338). It runs the tests
 * that cover the change while iterating, and the verify command once, which
 * the commit-early line (#303) and a later commit's re-run agree with.
 */
describe("implement-prd verifies once", () => {
  const text = read("implement-prd/prompt.md");

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
