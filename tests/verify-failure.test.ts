import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A verify failure is the change's unless it also fails at the base (#608).
 * Each runner that commits code is told how to show that before it commits
 * past a failure as the environment's, and what that commit then names.
 */
describe.each([
  { prompt: "implement/prompt.md", base: "`{{BASE_REF}}`" },
  { prompt: "implement-prd/prompt.md", base: "`{{BASE_REF}}`" },
  { prompt: "fix/prompt.md", base: "the PR's base branch" },
  { prompt: "update-branch/prompt.md", base: "`origin/{{BASE_REF}}`" },
])("$prompt tells a failure of the change from one of the environment", ({ prompt, base }) => {
  const text = fs.readFileSync(prompt, "utf8").replace(/\s+/g, " ");

  it("calls a failure the agent's own unless it also fails without the change", () => {
    expect(text).toContain("is yours unless it also fails without your change");
    expect(text).toContain("A failure you did not reproduce on the base is yours.");
  });

  it("shows it by running the failing tests on the base, in a separate worktree", () => {
    expect(text).toContain(`run the failing tests, not the whole suite, on ${base} in a separate worktree`);
  });

  it("edits nothing to make a failure the base shares pass, and sets the environment up where it can", () => {
    expect(text).toContain("do not edit code or tests to make them pass");
    expect(text).toContain("Where the failure says how to set the environment up and the sandbox allows it");
  });

  it("names each failing test, its message and that it fails on the base too, in the commit", () => {
    expect(text).toContain("name in the commit message each test still failing, its message, and that it fails on the base too");
  });
});

it("update-branch still makes the failure the first line of its comment", () => {
  const text = fs.readFileSync("update-branch/prompt.md", "utf8");
  expect(text).toContain("the **first line** of your comment");
});
