import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  PROMPTS,
  caseDirs,
  caseInputs,
  compare,
  fisher,
  placeholders,
  readCase,
  readSuite,
  removeSandbox,
  report,
  runRecords,
  sandboxOf,
  type EvalResult,
  type RunRecord,
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

/**
 * A fix run cannot commit (#716): `claude plugin eval` denies writes to the
 * run's `.git`, so its change is only ever in the working tree. The replay note
 * has the run print that, untracked files included, in its final message, and
 * the graders read that message, never a commit.
 */
describe("the fix evals' grading", () => {
  const suite = readSuite(ROOT, "fix");
  const cases = caseDirs(ROOT, "fix").map(readCase);

  it("asks for the working tree's diff in the final message, new files included", () => {
    expect(suite.note).toContain("git diff origin/{{BRANCH}}");
    expect(suite.note).toContain("git diff --no-index /dev/null");
    expect(suite.note).toMatch(/final message/);
    // A diff of commits, which prints nothing for a change that could not be committed.
    expect(suite.note).not.toContain("..HEAD");
  });

  describe.each(cases.map((c) => [c.name, c] as const))("case %s", (_name, c) => {
    it.each(c.graders)("grader %s reads the final message and asks for no commit", (grader) => {
      const parsed = frontmatter(fs.readFileSync(path.join(c.dir, "graders", grader), "utf8"));

      expect(parsed["focus"]).toBe("last_message");
      expect(parsed["body"]).not.toMatch(/commit/i);
    });
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
    // An errored run is out of the denominator: it measured nothing.
    expect(text).toContain("| clean | #2 | 3 (1 errored) | 01: No fix-before-merge finding. | 1/2 | 50% |");
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

  it("names the run directory it is kept in", () => {
    expect(report(meta, result, "/runs/2026-11-03-review")).toContain("**Run directory:** `/runs/2026-11-03-review`");
  });
});

describe("a two-sided Fisher exact test", () => {
  it("gives the figures the protocol rests on", () => {
    // evals/README.md, *The protocol*: the best case at 3 per arm is p = 0.10.
    expect(fisher(3, 3, 0, 3)).toBeCloseTo(0.1, 6);
    expect(fisher(2, 3, 0, 3)).toBeCloseTo(0.4, 6);
    expect(fisher(4, 6, 1, 6)).toBeCloseTo(0.2424, 4);
    expect(fisher(7, 9, 2, 9)).toBeCloseTo(0.0567, 4);
    expect(fisher(1, 3, 1, 3)).toBeCloseTo(1, 6);
    expect(fisher(0, 0, 1, 3)).toBeUndefined();
  });
});

describe("a run's records", () => {
  const meta: StageMeta = {
    prompt: "fix",
    revision: { file: "fix/prompt.md", head: "a".repeat(40), lastChange: "b".repeat(40), blob: "c".repeat(40), uncommitted: false },
    arms: {
      before: { file: "fix/prompt.md", head: "1".repeat(40), lastChange: "2".repeat(40), blob: "3".repeat(40), uncommitted: false },
      after: { file: "fix/prompt.md", head: "a".repeat(40), lastChange: "b".repeat(40), blob: "c".repeat(40), uncommitted: false },
    },
    cases: [
      { name: "rescue.before", case: "rescue", arm: "before", pr: 1, head: "d".repeat(40), clean: false, graders: { "01": "h1" } },
      { name: "rescue.after", case: "rescue", arm: "after", pr: 1, head: "d".repeat(40), clean: false, graders: { "01": "h1" } },
    ],
  };
  const result: EvalResult = {
    claudeVersion: "2.1.316",
    suite: { modelOverride: "opus", judgeModel: "haiku" },
    cases: ["rescue.before", "rescue.after"].map((name) => ({
      name,
      graders: [{ name: "01" }],
      arms: {
        with: [
          { error: null, costUsd: 1.5, judgeCostUsd: 0.03, turns: 40, tracePath: "/tmp/x/trace.jsonl", graders: [{ name: "01", passed: true, judgeVotes: [true, true, false] }] },
        ],
      },
    })),
  };

  it("carry each run's case, arm, prompt blob, result, judge votes, cost and grader hashes", () => {
    const records = runRecords(meta, result, "session-1", () => "traces/rescue.before/1.jsonl");

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      session: "session-1",
      prompt: "fix",
      case: "rescue",
      arm: "before",
      blob: "3".repeat(40),
      model: "opus",
      judgeModel: "haiku",
      claudeVersion: "2.1.316",
      run: 1,
      error: null,
      costUsd: 1.5,
      judgeCostUsd: 0.03,
      turns: 40,
      trace: "traces/rescue.before/1.jsonl",
      graders: [{ name: "01", hash: "h1", passed: true, judgeVotes: [true, true, false] }],
    });
    expect(records[1]?.blob).toBe("c".repeat(40));
  });
});

describe("a comparison", () => {
  const record = (over: Partial<RunRecord> & { passed: Record<string, boolean> }): RunRecord => {
    const { passed, ...rest } = over;
    return {
      session: "s1",
      prompt: "review",
      case: "escape",
      arm: "",
      blob: "c".repeat(40),
      model: "opus",
      judgeModel: "haiku",
      claudeVersion: "2.1.316",
      run: 1,
      error: null,
      costUsd: 1,
      judgeCostUsd: 0,
      turns: 1,
      trace: null,
      graders: Object.entries(passed).map(([name, ok]) => ({ name, hash: `h${name}`, passed: ok, judgeVotes: [] })),
      ...rest,
    };
  };
  const times = (n: number, make: () => RunRecord): RunRecord[] => Array.from({ length: n }, make);
  const before = [...times(6, () => record({ passed: { "01": true, "02": true } }))];
  const after = [
    ...times(6, () => record({ blob: "f".repeat(40), passed: { "01": false, "02": true } })),
    record({ blob: "f".repeat(40), error: "timed out", passed: {} }),
  ];

  it("sets each grader side by side, with the exact two-sided Fisher p", () => {
    const text = compare(before, after);

    expect(text).toMatch(/\| escape \| 01 \| 6\/6 \(100%; [^)]*\) \| 0\/6 \(0%; [^)]*\), 1 errored \| 0\.002 \|/);
    expect(text).toMatch(/\| escape \| 02 \| 6\/6 [^|]*\| 6\/6 [^|]*\| 1\.000 \|/);
  });

  it("keeps errored runs out of the denominator, and says how many there were", () => {
    const text = compare(before, after);

    expect(text).toContain("0/6 (0%");
    expect(text).toMatch(/1 errored/);
  });

  it("calls an effect only on a declared primary or guard, at p < 0.029, and 'not shown' otherwise", () => {
    const text = compare(before, after, { primary: ["escape/01"], guards: ["escape/02"] });

    expect(text).toMatch(/\| escape \| 01 \(primary\) \|.*\| fell \|/);
    expect(text).toMatch(/\| escape \| 02 \(guard\) \|.*\| not shown \|/);
    expect(compare(before, after)).toMatch(/\| escape \| 01 \|.*\| descriptive \|/);
    expect(() => compare(before, after, { primary: ["escape/09"] })).toThrow(/escape\/09/);
  });

  it("voids a declared grader a side has no completed run of, rather than ruling on 0/0", () => {
    const onlyErrored = [record({ blob: "f".repeat(40), error: "timed out", passed: {} })];
    const otherCase = [...after, record({ blob: "f".repeat(40), case: "clean", passed: { "01": true } })];

    // A side whose only run of the case errored.
    expect(compare(before, onlyErrored, { primary: ["escape/01"] })).toMatch(/\| escape \| 01 \(primary\) \|.*\| n\/a \| void \|/);
    // A case only one side's session ran (different `--case` sets).
    expect(compare(otherCase, after, { guards: ["clean/01"] })).toMatch(/\| clean \| 01 \(guard\) \|.*\| n\/a \| void \|/);
    expect(compare(before.concat(record({ case: "clean", passed: { "01": true } })), after, { guards: ["clean/01"] })).toMatch(/\| clean \| 01 \(guard\) \|.*\| n\/a \| void \|/);
  });

  it("voids a side with two or more errored runs on the case", () => {
    const errored = [...after, record({ blob: "f".repeat(40), error: "plan limit", passed: {} })];

    expect(compare(before, errored, { primary: ["escape/01"] })).toMatch(/\| escape \| 01 \(primary\) \|.*\| void \|/);
  });

  it("labels same-blob runs from more than one session as pooled", () => {
    const pooled = [...before, ...times(3, () => record({ session: "s0", passed: { "01": true, "02": true } }))];
    const text = compare(pooled, after);

    expect(text).toMatch(/\*\*Before:\*\* pooled from 2 sessions/);
    expect(text).toContain("9/9");
  });

  it("refuses to pool runs of different prompt blobs on one side", () => {
    expect(() => compare([...before, record({ blob: "9".repeat(40), passed: { "01": true } })], after)).toThrow(/blob/);
  });

  it("refuses a model, Claude Code, judge or grader that differs between the sides", () => {
    const changed = (over: Partial<RunRecord>): RunRecord[] => after.map((r) => ({ ...r, ...over }));

    expect(() => compare(before, changed({ model: "sonnet" }))).toThrow(/model/);
    expect(() => compare(before, changed({ claudeVersion: "2.1.400" }))).toThrow(/Claude Code/);
    expect(() => compare(before, changed({ judgeModel: "sonnet" }))).toThrow(/judge/);
    const regraded = after.map((r) => ({ ...r, graders: r.graders.map((g) => ({ ...g, hash: "other" })) }));
    expect(() => compare(before, regraded)).toThrow(/grader/i);
  });

  it("says when both sides ran one blob, so every difference is noise", () => {
    expect(compare(before, before.map((r) => ({ ...r, session: "s2" })))).toMatch(/same prompt blob/i);
  });
});

describe("a kept sandbox", () => {
  // As Claude Code 2.1.316 names it: `mkdtemp` of `claude-eval-` in the temp
  // dir, or of `/tmp/e-` on macOS, by its real path; the trace in `out/`.
  it("is found from a run's trace on Linux and on macOS", () => {
    expect(sandboxOf("/tmp/claude-eval-Ab12/out/trace.jsonl", "linux", "/tmp")).toBe("/tmp/claude-eval-Ab12");
    expect(sandboxOf("/tmp/e-Ab12/out/trace.jsonl", "darwin")).toBe("/tmp/e-Ab12");
    expect(sandboxOf("/private/tmp/e-Ab12/out/trace.jsonl", "darwin")).toBe(fs.existsSync("/private/tmp") ? "/private/tmp/e-Ab12" : undefined);
    expect(sandboxOf("/tmp/e-Ab12/out/trace.jsonl", "linux", "/tmp")).toBeUndefined();
    expect(sandboxOf("/elsewhere/claude-eval-Ab12/out/trace.jsonl", "linux", "/tmp")).toBeUndefined();
  });

  it("is removed when the tool has sealed it, and a removal that fails is a warning", () => {
    // The seal `--keep-temp` leaves: home/ and tmp/ moved into sealed/ at mode
    // 000, and the root at 0500.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-eval-test-"));
    fs.mkdirSync(path.join(root, "out"));
    fs.writeFileSync(path.join(root, "out", "trace.jsonl"), "{}\n");
    fs.mkdirSync(path.join(root, "sealed", "home", "cwd"), { recursive: true });
    fs.mkdirSync(path.join(root, "sealed", "tmp"));
    fs.writeFileSync(path.join(root, "sealed", "home", "cwd", "file"), "x");
    fs.chmodSync(path.join(root, "sealed"), 0o000);
    fs.chmodSync(root, 0o500);

    expect(removeSandbox(root)).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
    expect(removeSandbox(path.join(root, "missing"))).toBe(false);
  });
});
