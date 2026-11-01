import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  PROMPTS,
  caseDirs,
  caseInputs,
  placeholders,
  readCase,
  readSuite,
  report,
  type EvalResult,
  type StageMeta,
} from "../scripts/eval-prompts.js";

/**
 * The golden-PR evals' layout (#617), held with no model and no network.
 *
 * The evals themselves are run by hand (`evals/README.md`): what a run finds is
 * not this suite's to check. What is, is that every case can be run at all:
 * it pins the commits it replays, carries the brief it is graded against and a
 * grader per outcome, supplies every input the shipped prompt names, and holds
 * no copy of the prompt, which `scripts/eval-prompts.ts` renders from the
 * runner's own file at each run. Read through that script's own readers, so
 * this and the run agree on what a case is.
 */

const ROOT = ".";

/** Every file under a directory, relative to it. */
const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full).map((rel) => path.join(entry.name, rel)) : [entry.name];
  });

const frontmatter = (text: string): Record<string, unknown> => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  expect(match, "a grader opens with YAML frontmatter").not.toBeNull();
  return { ...(parse(match?.[1] ?? "") as Record<string, unknown>), body: (match?.[2] ?? "").trim() };
};

describe.each(PROMPTS)("the %s evals", (prompt) => {
  const suite = readSuite(ROOT, prompt);
  const dirs = caseDirs(ROOT, prompt);
  const template = fs.readFileSync(path.join(prompt, "prompt.md"), "utf8");

  it("have cases", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  describe.each(dirs.map((dir) => [path.basename(dir), dir]))("case %s", (name, dir) => {
    const c = readCase(dir);

    it("has the case.yaml claude plugin eval reads, naming itself and the scaffold the run writes", () => {
      const yaml = parse(fs.readFileSync(path.join(dir, "case.yaml"), "utf8")) as Record<string, unknown>;

      expect(yaml["schema_version"]).toBe("1.1");
      expect(yaml["name"]).toBe(name);
      expect(yaml["context"]).toEqual({ scaffold_script: "place-files.sh" });
      expect(typeof yaml["expected_outcome"]).toBe("string");
    });

    it("pins full SHAs for its base and head, and carries its brief", () => {
      // readCase refuses anything else; asserted again so the rule is read here.
      expect(c.base).toMatch(/^[0-9a-f]{40}$/);
      expect(c.head).toMatch(/^[0-9a-f]{40}$/);
      expect(c.base).not.toBe(c.head);
      expect(fs.readFileSync(path.join(dir, c.brief), "utf8").trim()).not.toBe("");
    });

    it("has at least one grader, each an LLM grader with something to observe", () => {
      expect(c.graders.length).toBeGreaterThan(0);
      for (const grader of c.graders) {
        const parsed = frontmatter(fs.readFileSync(path.join(dir, "graders", grader), "utf8"));

        expect(parsed["type"], grader).toBe("llm");
        expect(["last_message", "trace"], grader).toContain(parsed["focus"]);
        expect(parsed["body"], grader).not.toBe("");
      }
    });

    it("sets every input the shipped prompt and the replay note name, but the diff the run takes", () => {
      const inputs = caseInputs(suite, c);
      const missing = [...placeholders(template), ...placeholders(suite.note)].filter(
        (key) => key !== "PR_DIFF" && inputs[key] === undefined,
      );

      expect(missing).toEqual([]);
    });

    it("holds no copy of a prompt", () => {
      const files = filesUnder(dir);

      expect(files.filter((file) => path.basename(file) === "prompt.md")).toEqual([]);
      // Nor a prompt's text under another name: no line of either runner's
      // prompt long enough to be its own prose.
      const prose = PROMPTS.flatMap((p) => fs.readFileSync(path.join(p, "prompt.md"), "utf8").split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.length >= 80);
      for (const file of files) {
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        expect(prose.filter((line) => text.includes(line)), file).toEqual([]);
      }
    });
  });
});

describe("the review evals' cases", () => {
  const cases = caseDirs(ROOT, "review").map(readCase);

  it("include three escapes at least and a clean case", () => {
    expect(cases.filter((c) => !c.clean).length).toBeGreaterThanOrEqual(3);
    expect(cases.filter((c) => c.clean).length).toBeGreaterThanOrEqual(1);
  });
});

describe("evals/", () => {
  // `tsconfig.json` includes every `.ts` in the checkout, and a `.ts` here would
  // be one more file the build could reach. The runner is in `scripts/`.
  it("holds no TypeScript", () => {
    expect(filesUnder("evals").filter((file) => file.endsWith(".ts"))).toEqual([]);
  });

  it("is not in the package", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { files: string[] };

    expect(pkg.files).toEqual(["dist"]);
  });
});

describe("an eval run's report", () => {
  const meta: StageMeta = {
    prompt: "review",
    revision: { file: "review/prompt.md", head: "a".repeat(40), lastChange: "b".repeat(40), blob: "c".repeat(40), uncommitted: true },
    cases: [
      { name: "escape", pr: 1, head: "d".repeat(40), clean: false },
      { name: "clean", pr: 2, head: "e".repeat(40), clean: true },
    ],
  };
  // As the tool writes a run: `error` on every one, `null` where it finished.
  const run = (passed: Record<string, boolean>, error: string | null = null) => ({
    error,
    graders: Object.entries(passed).map(([name, ok]) => ({ name, passed: ok })),
  });
  const result: EvalResult = {
    claudeVersion: "2.1.290",
    costUsd: 12.345,
    partial: false,
    suite: { modelOverride: "opus" },
    cases: [
      {
        name: "escape",
        graders: [{ name: "01", graderMarkdown: "Raises the finding." }, { name: "02", graderMarkdown: "Asks for changes." }],
        arms: { with: [run({ "01": true, "02": true }), run({ "01": false, "02": true }), run({ "01": true, "02": false })] },
      },
      {
        name: "clean",
        graders: [{ name: "01", graderMarkdown: "No fix-before-merge finding." }],
        arms: { with: [run({ "01": true }), run({ "01": false }), run({ "01": false }, "timed out")] },
      },
    ],
  };
  const text = report(meta, result);

  it("gives each grader's pass rate per case, with the runs", () => {
    expect(text).toContain("| escape | #1 | 3 | 01: Raises the finding. | 2/3 | 67% |");
    expect(text).toContain("| escape | #1 | 3 | 02: Asks for changes. | 2/3 | 67% |");
    expect(text).toContain("| clean | #2 | 3 (1 errored) | 01: No fix-before-merge finding. | 1/3 | 33% |");
  });

  it("gives the false-finding rate on a clean case", () => {
    expect(text).toContain("- **clean:** 1 of 2 completed runs raised a false finding (50%).");
    expect(text).not.toContain("- **escape:**");
  });

  it("names the model, the prompt's revision and the cost", () => {
    expect(text).toContain("**Model:** opus");
    expect(text).toContain(`last changed in \`${"b".repeat(12)}\`, run from \`${"a".repeat(12)}\`, blob \`${"c".repeat(12)}\` (**uncommitted changes**)`);
    expect(text).toContain("**Cost:** $12.35");
  });
});
