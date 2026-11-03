import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (prompt: string): string => fs.readFileSync(prompt, "utf8").replace(/\s+/g, " ");

/**
 * A brief can name the test seam (#619): the surface its criteria are observed
 * through. An unattended run has nobody to agree a seam with, so each implement
 * prompt tests at the one the brief names, otherwise at one that already exists,
 * and says so in the commit message where the named one cannot be used.
 */
describe.each(["implement/prompt.md", "implement-prd/prompt.md"])("%s tests at the brief's seam", (prompt) => {
  const text = read(prompt);

  it("writes the tests at the seam the brief names, otherwise at the nearest existing one", () => {
    expect(text).toContain(
      "Where the brief names a test seam, write the tests there; otherwise write them at the nearest seam the code already has, rather than one made for the test",
    );
  });

  it("uses the nearest existing seam where the named one is missing or cannot observe a criterion, and says so", () => {
    expect(text).toContain(
      "Where the named seam does not exist in the code, or cannot observe a criterion, use that nearest seam too and say so in the commit message; carry on with the run either way.",
    );
  });

  it("keeps the guidance against a seam made for the test once (#706), in the positive form, with its example", () => {
    expect(text).not.toContain("Do not improvise new test seams");
    expect(text.match(/seam the code already has/g)).toHaveLength(1);
    expect(text.match(/seam that already exists|nearest existing seam/g)).toBeNull();
    expect(text).toContain("extracting a function purely so it can be tested in isolation");
  });

  it("uses no em dash", () => {
    expect(text).not.toContain("—");
  });
});

it("implement-prd reads the slice's brief first, and the PRD's where the slice names none", () => {
  expect(read("implement-prd/prompt.md")).toContain("the slice's brief, or the PRD's where the slice names none");
});
