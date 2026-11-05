import { execFileSync } from "node:child_process";
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
  comparisonProblems,
  controlRows,
  fisher,
  placeholders,
  reach,
  readCase,
  readSections,
  readSuite,
  removeSandbox,
  report,
  runRecords,
  sandboxOf,
  patchFiles,
  sections,
  stage,
  stageControls,
  CONTROL_FILE,
  SCOPE_PLACEHOLDERS,
  type EvalResult,
  type RunRecord,
  type StageMeta,
} from "../scripts/eval-prompts.js";
import { renderMinorFindingsForFix, surfaceText, type PullRequestFeedback } from "../shared/pr-feedback.js";
import { renderNotesForReview } from "../shared/fix-notes.js";
import { renderRedCheck } from "../shared/red-check.js";
import { resumeSection } from "../shared/rescue.js";
import type { SinceBriefSkip } from "../shared/review-output.js";
import { renderCarriedFindings, renderSettledFindings } from "../shared/review-verification.js";
import { currentSummary, summaryBlock } from "../review/pr-summary.js";
import { renderDiffScope } from "../review/review-diff.js";
import { renderFixDiffScope } from "../fix/fix-diff.js";
import { describeHistory } from "../review/review-round.js";
import { renderSinceBriefForReview } from "../review/since-brief.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

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

/** A `regex` grader's ruling on a text, as `claude plugin eval` 2.1.316 makes it. */
const regexRuling = (grader: Record<string, unknown>, text: string): boolean => {
  const flags = String(grader["flags"] ?? "");
  const match = String(grader["match"] ?? "contains");
  const pattern = String(grader["pattern"]);
  if (match === "contains") return new RegExp(pattern, flags).test(text);
  if (match === "not_contains") return !new RegExp(pattern, flags).test(text);
  const count = text.match(new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`))?.length ?? 0;
  return count === Number(match.slice("count:".length));
};

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

    it("has at least one grader, each an LLM grader with something to observe, or a regex over the final message", () => {
      expect(c.graders.length).toBeGreaterThan(0);
      for (const grader of c.graders) {
        const parsed = frontmatter(fs.readFileSync(path.join(dir, "graders", grader), "utf8"));

        expect(["llm", "regex"], grader).toContain(parsed["type"]);
        if (parsed["type"] === "llm") {
          expect(["last_message", "trace"], grader).toContain(parsed["focus"]);
        } else {
          // Deterministic, and free: held on its controls below with no model.
          expect(parsed["target"], grader).toBe("last_message");
          expect(() => new RegExp(String(parsed["pattern"]), String(parsed["flags"] ?? "")), grader).not.toThrow();
          expect(String(parsed["match"]), grader).toMatch(/^(contains|not_contains|count:\d+)$/);
        }
        // What it holds, in words: a regex's body is read by no tool, so by people.
        expect(parsed["body"], grader).not.toBe("");
      }
    });

    // A regex grader is free and needs no judge, so its controls are ruled on
    // here rather than in a run of the controls, by the rule `claude plugin
    // eval` 2.1.316 applies (its `regex` grader: `contains`, `not_contains`,
    // `count:N` over the target's text).
    it("has every regex grader rule on its controls as they expect", () => {
      for (const grader of c.graders) {
        const parsed = frontmatter(fs.readFileSync(path.join(dir, "graders", grader), "utf8"));
        if (parsed["type"] !== "regex") continue;
        const name = grader.slice(0, -".md".length);
        for (const control of c.controls.filter((x) => x.expect[name] !== undefined)) {
          expect(regexRuling(parsed, control.text), `${name} on ${control.name}`).toBe(control.expect[name]);
        }
      }
    });

    it("sets every input the shipped prompt and the replay note name, but the diff the run takes", () => {
      const inputs = caseInputs(suite, c);
      const missing = [...placeholders(template), ...placeholders(suite.note)].filter(
        (key) => key !== "PR_DIFF" && inputs[key] === undefined,
      );

      expect(missing).toEqual([]);
    });

    it("has a control its judge must pass and one it must fail, for every grader (#718)", () => {
      for (const grader of c.graders.map((file) => file.slice(0, -".md".length))) {
        const expected = c.controls.flatMap((control) => (control.expect[grader] === undefined ? [] : [control.expect[grader]]));

        expect(expected, `grader ${grader}: a positive control`).toContain(true);
        expect(expected, `grader ${grader}: a negative control`).toContain(false);
      }
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
  const body = (c: (typeof cases)[number], grader: string): string =>
    frontmatter(fs.readFileSync(path.join(c.dir, "graders", grader), "utf8"))["body"] as string;

  it("include three escapes at least and a clean case", () => {
    expect(cases.filter((c) => !c.clean).length).toBeGreaterThanOrEqual(3);
    expect(cases.filter((c) => c.clean).length).toBeGreaterThanOrEqual(1);
  });

  // #718: a grader that passes on any blocking finding, not the case's own,
  // is a verdict, which the report marks and a comparison refuses to declare.
  it("count a grader that asks only for no approval as a verdict", () => {
    for (const c of cases) {
      for (const grader of c.graders.filter((file) => /^The review does not recommend approval\b/.test(body(c, file)))) {
        expect(c.grading[grader.slice(0, -".md".length)], `${c.name}/${grader}`).toEqual({ kind: "verdict" });
      }
    }
  });

  // #718: 15 of 15 on every prompt, and implied by the case's other grader.
  it("grade a clean case on its false findings, not on its approval", () => {
    for (const c of cases.filter((c) => c.clean)) {
      for (const grader of c.graders) expect(body(c, grader), `${c.name}/${grader}`).not.toMatch(/^The review recommends approval\.?$/);
    }
  });

  // #718: restart-order's brief prescribes `curl -fsSL`, so a review that
  // follows it is right not to raise a hardening finding against it.
  it("rest no grader on a finding the case's brief contradicts", () => {
    const restart = cases.find((c) => c.name === "restart-order");

    expect(restart?.graders.map((grader) => body(restart, grader)).filter((text) => text.includes("curl -L"))).toEqual([]);
  });
});

/**
 * A grader is counted other than by its pass rate where `replay.yaml` says
 * (#718): a verdict is marked and refused as a declared grader, and one given
 * another is counted over the runs that passed the other.
 */
describe("a grader's grading", () => {
  const meta: StageMeta = {
    prompt: "review",
    revision: { file: "review/prompt.md", head: "a".repeat(40), lastChange: "b".repeat(40), blob: "c".repeat(40), uncommitted: false },
    cases: [{ name: "escape", pr: 1, head: "d".repeat(40), clean: false, case: "escape", graders: { "01": "h1", "02": "h2", "03": "h3" }, grading: { "02": { kind: "given", grader: "01" }, "03": { kind: "verdict" } } }],
  };
  const run = (passed: Record<string, boolean>) => ({ error: null, graders: Object.entries(passed).map(([name, ok]) => ({ name, passed: ok })) });
  const result: EvalResult = {
    suite: { modelOverride: "opus", judgeModel: "haiku" },
    claudeVersion: "2.1.316",
    cases: [
      {
        name: "escape",
        graders: [{ name: "01", graderMarkdown: "Raises it." }, { name: "02", graderMarkdown: "As blocking." }, { name: "03", graderMarkdown: "No approval." }],
        arms: {
          with: [
            run({ "01": true, "02": true, "03": true }),
            run({ "01": true, "02": false, "03": true }),
            run({ "01": false, "02": false, "03": true }),
            run({ "01": false, "02": false, "03": false }),
          ],
        },
      },
    ],
  };

  it("reports a conditional grader over the runs that passed the one it is given, and marks a verdict", () => {
    const text = report(meta, result);

    expect(text).toContain("| escape | #1 | 4 | 01: Raises it. | 2/4 | 50% |");
    expect(text).toContain("| escape | #1 | 4 | 02 given 01: As blocking. | 1/2 | 50% |");
    expect(text).toContain("| escape | #1 | 4 | 03 (verdict): No approval. | 3/4 | 75% |");
  });

  it("is kept in each run's record, and compared the same way", () => {
    const records = runRecords(meta, result, "s1");

    expect(records[0]?.graders.find((g) => g.name === "02")?.rule).toEqual({ kind: "given", grader: "01" });
    const text = compare(records, records.map((r) => ({ ...r, session: "s2" })), { primary: ["escape/02"] });
    expect(text).toMatch(/\| escape \| 02 given 01 \(primary\) \| 1\/2 /);
  });

  it("refuses a verdict as a declared primary or guard", () => {
    const records = runRecords(meta, result, "s1");

    expect(() => compare(records, records, { primary: ["escape/03"] })).toThrow(/verdict/);
    expect(() => compare(records, records, { guards: ["escape/03"] })).toThrow(/verdict/);
  });

  it("refuses to compare a grader counted one way against one counted another", () => {
    const records = runRecords(meta, result, "s1");
    const plain = records.map((r) => ({ ...r, graders: r.graders.map(({ rule: _rule, ...g }) => g) }));

    expect(() => compare(records, plain)).toThrow(/counted differently/);
  });
});

describe("a run of the controls", () => {
  const MERGE_CHECK = "Medium: the checkout persists a token.\n\nLow: the install check can be skipped.";
  const APPROVED = "### Approval recommended\n\nNothing is unresolved.";
  const meta: StageMeta = {
    prompt: "review",
    revision: { file: "review/prompt.md", head: "a".repeat(40), lastChange: "b".repeat(40), blob: "c".repeat(40), uncommitted: false },
    cases: [],
    controls: [
      { name: "escape--merge-check", case: "escape", control: "merge-check", expect: { "01": true, "02": true }, text: MERGE_CHECK },
      { name: "escape--approved", case: "escape", control: "approved", expect: { "01": false, "02": false }, text: APPROVED },
    ],
  };
  const run = (passed: Record<string, boolean>, evidence: string | undefined) => ({
    error: null,
    graders: Object.entries(passed).map(([name, ok]) => ({
      name,
      passed: ok,
      explanation: ok ? "It says so." : "It does not say so.",
      ...(evidence === undefined ? {} : { evidence }),
    })),
  });
  const result = (merge: string | undefined, approved: string | undefined): EvalResult => ({
    cases: [
      { name: "escape--merge-check", graders: [], arms: { with: [run({ "01": true, "02": false }, merge)] } },
      { name: "escape--approved", graders: [], arms: { with: [run({ "01": true, "02": false }, approved)] } },
    ],
  });

  it("says which grader fails its positive control and which passes its negative one, on the control's own text", () => {
    // The judge's evidence may frame the text and wrap it differently.
    const rows = controlRows(meta, result(`File control.md:\n${MERGE_CHECK.replaceAll("\n\n", "\n")}\n`, APPROVED));

    expect(rows.map((row) => `${row.control}/${row.grader}: ${row.check}`)).toEqual([
      "merge-check/01: as expected",
      "merge-check/02: **broken**: fails its positive control",
      "approved/01: **too loose**: passes its negative control",
      "approved/02: as expected",
    ]);
    expect(rows.find((row) => row.control === "merge-check" && row.grader === "02")?.explanations).toEqual(["It does not say so."]);
    const text = report(meta, result(MERGE_CHECK, APPROVED));
    expect(text).toContain("**2 of 4** grader rulings as the controls expect; **2** differ; **0** void");
    expect(text).toContain("- escape merge-check 02: It does not say so.");
  });

  // The maintainer's run on a00633d: the model asked to echo the text did not
  // always, and the graders judged what it wrote. A ruling on other text says
  // nothing about the grader.
  it("voids a ruling whose judge was not shown the control's text, rather than calling the grader broken", () => {
    const rows = controlRows(meta, result(MERGE_CHECK.slice(0, 20), undefined));

    expect(rows.map((row) => `${row.control}/${row.grader}: ${row.status}`)).toEqual([
      "merge-check/01: void",
      "merge-check/02: void",
      "approved/01: void",
      "approved/02: void",
    ]);
    expect(report(meta, result(MERGE_CHECK.slice(0, 20), undefined))).toContain("**0 of 4** grader rulings as the controls expect; **0** differ; **4** void");
  });

  it("stages each control's text as a file its graders read, with each grader's criteria as they are", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "controls-"));
    try {
      const staged = stageControls(ROOT, "review", out, (name) => name === "restart-order");
      const c = readCase(caseDirs(ROOT, "review").find((dir) => path.basename(dir) === "restart-order") ?? "");
      const control = c.controls.find((x) => x.name === "changes-after-fix");
      const dir = path.join(out, "evals", "restart-order--changes-after-fix");

      expect(staged.controls?.find((x) => x.control === "changes-after-fix")?.text).toBe(control?.text);
      expect(fs.readFileSync(path.join(dir, CONTROL_FILE), "utf8")).toBe(`${control?.text}\n`);
      expect(parse(fs.readFileSync(path.join(dir, "case.yaml"), "utf8"))).toMatchObject({ context: { scaffold_script: "place-files.sh" } });
      expect(fs.readFileSync(path.join(dir, "place-files.sh"), "utf8")).toContain(`cp '${path.join(dir, CONTROL_FILE)}' '${CONTROL_FILE}'`);
      for (const grader of Object.keys(control?.expect ?? {})) {
        const original = frontmatter(fs.readFileSync(path.join(c.dir, "graders", `${grader}.md`), "utf8"));
        const copy = frontmatter(fs.readFileSync(path.join(dir, "graders", `${grader}.md`), "utf8"));

        expect(copy["body"]).toBe(original["body"]);
        expect(copy["focus"]).toEqual({ source: "file", path: CONTROL_FILE });
        expect(copy["type"]).toBe(original["type"]);
      }
      expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).not.toContain(control?.text.slice(0, 40));
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

/**
 * The inputs `suite.yaml` fixes are the strings the runners' own renderers
 * return for that state (#718). They were read off the built modules when the
 * cases were written; this holds them there, so a renderer that changes its
 * words changes the replay with it, or fails here.
 *
 * Where review/review.ts writes the string inline, and runs on import, the
 * string is read in its source.
 */
describe("the inputs the suites fix", () => {
  const reviewSource = fs.readFileSync(path.join("review", "review.ts"), "utf8");
  const inSource = (literal: string) => () => expect(reviewSource.includes(literal), `review/review.ts holds ${literal}`).toBe(true);
  const review = readSuite(ROOT, "review").inputs;
  const fix = readSuite(ROOT, "fix").inputs;
  const EVAL_REPLAY = "this is an eval replay, which does not read the base branch's history since the brief";

  const renderers: Record<"review" | "fix", Record<string, () => void>> = {
    review: {
      PULL_REQUEST_KIND: inSource(`\`${(review["PULL_REQUEST_KIND"] ?? "").replace("`main`", "\\`${BASE_REF}\\`")}\``),
      CI_STATUS: inSource(`return ${JSON.stringify(review["CI_STATUS"])};`),
      RED_CHECK: () => expect(review["RED_CHECK"]).toBe(renderRedCheck({ kind: "not-configured" }, "a".repeat(40))),
      HISTORY: () => expect(review["HISTORY"]).toBe(describeHistory({ afterFixRound: false, unreviewedCommits: true })),
      OPEN_FINDINGS: () => expect(review["OPEN_FINDINGS"]).toBe(renderCarriedFindings([])),
      SETTLED_FINDINGS: () => expect(review["SETTLED_FINDINGS"]).toBe(renderSettledFindings([])),
      FIX_NOTES: () => expect(review["FIX_NOTES"]).toBe(renderNotesForReview([])),
      // The one input the replay words itself, in the renderer's form.
      SINCE_BRIEF: () => expect(review["SINCE_BRIEF"]).toBe(renderSinceBriefForReview({ kind: "not run", reason: EVAL_REPLAY as SinceBriefSkip })),
      DIFF_SCOPE: () => expect(review["DIFF_SCOPE"]).toBe(renderDiffScope({ kind: "whole", diff: "" }, "main")),
      CURRENT_SUMMARY: () => expect(review["CURRENT_SUMMARY"]).toBe(currentSummary(summaryBlock("", "a".repeat(40), false))),
      SUMMARY_RULE: inSource(JSON.stringify(review["SUMMARY_RULE"])),
      FINAL_SUMMARY: () => {
        expect(review["FINAL_SUMMARY"]).toBe("");
        inSource('FINAL_SUMMARY: final ? FINAL_SUMMARY_SHAPE : "",')();
      },
      CARRIED_FOLLOW_UPS: inSource(`const NOT_CARRIED =\n  ${JSON.stringify(review["CARRIED_FOLLOW_UPS"])};`),
    },
    fix: {
      RESUME: () => expect(fix["RESUME"]).toBe(resumeSection({ kind: "none" }, "agent/issue-1")),
      CONVERSATION: () =>
        expect(fix["CONVERSATION"]).toBe(surfaceText({ conversation: "", unreadable: [] } as unknown as PullRequestFeedback, "conversation")),
      MINOR_FINDINGS: () => expect(fix["MINOR_FINDINGS"]).toBe(renderMinorFindingsForFix([])),
      DIFF_SCOPE: () => expect(fix["DIFF_SCOPE"]).toBe(renderFixDiffScope({ kind: "whole", diff: "" }, "main")),
    },
  };

  it.each(PROMPTS)("%s: every input has the renderer it is held to", (prompt) => {
    expect(Object.keys(readSuite(ROOT, prompt).inputs).sort()).toEqual(Object.keys(renderers[prompt]).sort());
  });

  it.each(PROMPTS.flatMap((prompt) => Object.entries(renderers[prompt]).map(([key, check]) => [`${prompt} ${key}`, check] as const)))(
    "%s is what its renderer returns",
    (_name, check) => {
      check();
    },
  );
});

/**
 * A case that replays a verification pass (#699): a fix round written as a
 * patch, applied on the case's head, which is then the head the last review
 * read. What it sets in place of the suite's first-review inputs is what the
 * runner's renderers return for a review that follows a fix round, held here
 * as the suite's own inputs are, so a renderer that changes its words fails
 * here rather than leaving the case stale.
 */
describe("the review cases that replay a fix round", () => {
  const suite = readSuite(ROOT, "review");
  const cases = caseDirs(ROOT, "review").map(readCase);
  const rounds = cases.flatMap((c) => (c.fixRound === undefined ? [] : [{ c, round: c.fixRound }]));
  const SCOPED = ["HISTORY", "OPEN_FINDINGS", "DIFF_SCOPE"];

  it("include one, and only a fix-round case sets what a verification pass is given", () => {
    expect(rounds.length).toBeGreaterThan(0);
    for (const c of cases.filter((x) => x.fixRound === undefined)) {
      expect(SCOPED.filter((key) => c.inputs[key] !== undefined), c.name).toEqual([]);
    }
  });

  describe.each(rounds.map(({ c, round }) => [c.name, c, round] as const))("case %s", (_name, c, round) => {
    const patch = fs.readFileSync(path.join(c.dir, round.patch), "utf8");

    it("follows a fix round, as describeHistory says of one", () => {
      expect(c.inputs["HISTORY"]).toBe(describeHistory({ afterFixRound: true, unreviewedCommits: true, reviewedHead: c.head }));
    });

    it("hands over the findings the round was started on, as renderCarriedFindings renders them", () => {
      // The list lines; the rules around them are the renderer's own (#749).
      const open = c.inputs["OPEN_FINDINGS"] ?? "";
      const carried = open
        .split("\n")
        .filter((line) => line.startsWith("- `"))
        .map((line) => {
          const match = /^- `([^`]+)`: (.*)$/.exec(line);
          expect(match, line).not.toBeNull();
          return { id: match?.[1] ?? "", threadId: "", text: match?.[2] ?? "", title: "", anchor: "" };
        });

      expect(carried.length).toBeGreaterThan(0);
      expect(open).not.toBe(suite.inputs["OPEN_FINDINGS"]);
      expect(open).toBe(renderCarriedFindings(carried));
      // Each is on a thread the review is shown, as the runner shows it.
      for (const finding of carried) expect(c.inputs["DISCUSSION"], finding.id).toContain(`agent-finding ${finding.id} `);
    });

    it("says its diff is what changed since the last review, as renderDiffScope says of a scoped one, for the files the patch touches", () => {
      const files = patchFiles(patch);

      expect(files.length).toBeGreaterThan(0);
      expect(c.inputs["DIFF_SCOPE"]).toBe(
        renderDiffScope({ kind: "since", reviewedHead: c.head, stat: SCOPE_PLACEHOLDERS.stat, since: SCOPE_PLACEHOLDERS.since, files, diff: "" }, c.baseRef),
      );
    });

    it("reaches the sections a verification pass reads", () => {
      const template = fs.readFileSync(path.join("review", "prompt.md"), "utf8");
      const reached = reach(template, readSections(ROOT, "review"), suite, caseInputs(suite, c));

      expect(reached.reached).toEqual(expect.arrayContaining(["WHAT THIS REVIEW FOLLOWS", "FINDINGS AN EARLIER REVIEW LEFT OPEN"]));
    });
  });

  it("reads the files a patch changes off its diff --git lines", () => {
    const patch = ["diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "diff --git a/a.ts b/a.ts", "diff --git a/old.ts b/new.ts"].join("\n");

    expect(patchFiles(patch)).toEqual(["a.ts", "b.ts", "new.ts"]);
  });
});

/**
 * The stage of a fix-round case (#699), on a repository made here: the round
 * is committed on the reviewed head, the prompt carries the scoped diff, and
 * the scaffold's checkout holds the reviewed head under the round, so the
 * `git diff <reviewed head> HEAD` the scoped text gives prints the round.
 */
describe("a fix-round case's stage", { timeout: 12 * SUBPROCESS_TIMEOUT }, () => {
  const run = (cwd: string, command: string, args: readonly string[]): string =>
    execFileSync(command, [...args], { cwd, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT });
  const git = (cwd: string, ...args: string[]): string =>
    run(cwd, "git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...args]).trim();
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  it("commits the round on the reviewed head, carries the scoped diff, and checks out both", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fix-round-stage-"));
    try {
      const root = path.join(scratch, "repo");
      fs.mkdirSync(root);
      git(root, "init", "--quiet", "--initial-branch=main");
      write(path.join(root, "package-lock.json"), "{}\n");
      write(path.join(root, "kept.ts"), "export const kept = 1;\n");
      write(path.join(root, "touched.ts"), "export const touched = 1;\n");
      git(root, "add", ".");
      git(root, "commit", "--quiet", "-m", "base");
      const base = git(root, "rev-parse", "HEAD");
      write(path.join(root, "kept.ts"), `export const kept = 2;\n${"// the rest of the pull request\n".repeat(40)}`);
      write(path.join(root, "touched.ts"), "export const touched = 2;\n");
      git(root, "commit", "--quiet", "-am", "the pull request");
      const reviewed = git(root, "rev-parse", "HEAD");
      write(path.join(root, "touched.ts"), "export const touched = 3;\n");
      const patch = run(root, "git", ["diff"]);
      git(root, "checkout", "--quiet", "--", "touched.ts");
      fs.mkdirSync(path.join(root, "node_modules"));

      fs.mkdirSync(path.join(root, "evals"));
      fs.copyFileSync(path.join("evals", "checkout.sh"), path.join(root, "evals", "checkout.sh"));
      write(path.join(root, "review", "prompt.md"), "# HISTORY\n\n{{HISTORY}}\n\n# PR DIFF\n\n{{DIFF_SCOPE}}\n\n```diff\n{{PR_DIFF}}\n```\n");
      write(path.join(root, "evals", "review", "suite.yaml"), "execution: { max_turns: 1, timeout_seconds: 60, allowed_tools: [Read] }\ninputs:\n  HISTORY: none\nnote: \"At {{HEAD}}.\"\n");
      write(path.join(root, "evals", "review", "sections.yaml"), "always: [HISTORY, PR DIFF]\n");
      const dir = path.join(root, "evals", "review", "round");
      write(path.join(dir, "case.yaml"), "name: round\n");
      write(path.join(dir, "brief.md"), "The brief.\n");
      write(path.join(dir, "graders", "01.md"), "---\ntype: llm\nfocus: last_message\n---\n\nIt says so.\n");
      write(path.join(dir, "round.patch"), patch);
      write(path.join(dir, "inputs", "DIFF_SCOPE.md"), `Since the last review:\n\n${SCOPE_PLACEHOLDERS.stat}\n\n${SCOPE_PLACEHOLDERS.since}\n`);
      write(
        path.join(dir, "replay.yaml"),
        `pr: 1\nrepository: ${root}\nbase_ref: main\nbase: ${base}\nhead: ${reviewed}\nbrief: brief.md\nfix_round: { patch: round.patch, message: the round }\ninputs:\n  HISTORY: after a round\n  BRANCH: feature\n`,
      );

      const out = path.join(scratch, "stage");
      const meta = stage(root, "review", out);
      const head = meta.cases[0]?.head ?? "";
      const prompt = fs.readFileSync(path.join(out, "evals", "round", "prompt.md"), "utf8");

      expect(git(root, "rev-parse", `${head}^`)).toBe(reviewed);
      expect(git(root, "log", "-1", "--format=%s", head)).toBe("the round");
      // The same patch on the same head is the same commit at every stage.
      expect(stage(root, "review", path.join(scratch, "again")).cases[0]?.head).toBe(head);
      expect(prompt).toContain(`At ${head}.`);
      expect(prompt).toMatch(/ kept\.ts +\| 42 /);
      expect(prompt).toContain("+export const touched = 3;");
      expect(prompt).not.toContain(SCOPE_PLACEHOLDERS.since);
      // The prompt's diff is the pull request's diff of the touched file alone.
      expect(prompt).not.toContain("the rest of the pull request");

      const checkout = path.join(scratch, "checkout");
      fs.mkdirSync(checkout);
      run(checkout, "bash", [path.join(out, "evals", "round", "place-files.sh")]);
      expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
      expect(run(checkout, "git", ["diff", reviewed.slice(0, 7), "HEAD"])).toContain("+export const touched = 3;");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * Which sections of each prompt a case reaches (#718): `sections.yaml` names
 * every heading as reached by every case or gated by one input, and a case
 * reaches a gated one only where it sets that input other than as the suite does.
 */
describe.each(PROMPTS)("the %s prompt's section map", (prompt) => {
  const template = fs.readFileSync(path.join(prompt, "prompt.md"), "utf8");
  const map = readSections(ROOT, prompt);
  const suite = readSuite(ROOT, prompt);

  it("names every section of the prompt once, and nothing else", () => {
    const listed = [...map.always, ...Object.keys(map.gated)];

    expect([...listed].sort()).toEqual(sections(template).map((s) => s.heading).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("gates a section only on an input the prompt names and the suite fixes", () => {
    for (const input of Object.values(map.gated)) {
      expect(placeholders(template)).toContain(input);
      expect(suite.inputs[input]).toBeDefined();
    }
  });

  it("gives each case the gated sections it reaches, by its inputs", () => {
    const c = readCase(caseDirs(ROOT, prompt)[0] ?? "");
    const inputs = caseInputs(suite, c);
    const none = reach(template, map, suite, inputs);
    const gate = Object.entries(map.gated)[0] as [string, string];
    const set = reach(template, map, suite, { ...inputs, [gate[1]]: "(something there)" });

    expect(none.unreached.map((u) => u.section)).toContain(gate[0]);
    expect(set.unreached.map((u) => u.section)).not.toContain(gate[0]);
    expect(set.share).toBeGreaterThan(none.share);
    expect(none.share).toBeGreaterThan(0);
  });
});

/**
 * The CI check (#718, `prompt-evals.yml`): a pull request that changes a
 * prompt carries a comparison of the prompt's blob at its merge-base against
 * the one at its head, as `compare` prints it, or a waiver with its reason.
 */
describe("a prompt change's comparison", () => {
  const change = { prompt: "review" as const, before: "1".repeat(40), after: "2".repeat(40) };
  const comparison = (before: string, after: string, prompt = "review"): string =>
    [
      `### \`${prompt}\` comparison`,
      "",
      "- **Model:** opus; **judge:** haiku; **Claude Code:** 2.1.316",
      `- **before:** session s, blob \`${before.slice(0, 12)}\`, $1.00`,
      `- **after:** session s, blob \`${after.slice(0, 12)}\`, $1.00`,
    ].join("\n");

  it("is owed nothing where no prompt changed", () => {
    expect(comparisonProblems([], "", [])).toEqual([]);
  });

  it("is found in the body or a comment, with both blobs in order", () => {
    expect(comparisonProblems([change], "Summary.", [comparison(change.before, change.after)])).toEqual([]);
    expect(comparisonProblems([change], `Body.\n\n${comparison(change.before, change.after)}\n\n### Another heading\n\nblob \`${"9".repeat(12)}\``, [])).toEqual([]);
  });

  it("does not count a comparison of other blobs, of the other prompt, or the wrong way round", () => {
    const [stale] = comparisonProblems([change], "", [comparison(change.before, "3".repeat(40))]);

    expect(stale).toMatch(/review\/prompt\.md changed .*111111111111.*222222222222/);
    expect(stale).toContain(`111111111111 against 333333333333`);
    expect(comparisonProblems([change], comparison(change.after, change.before), [])).toHaveLength(1);
    expect(comparisonProblems([change], "", [comparison(change.before, change.after, "fix")])).toHaveLength(1);
    expect(comparisonProblems([change], "No comparison here.", [])[0]).toMatch(/none is in its body or comments/);
  });

  it("is waived by an Eval-Waiver line with a reason in the body, and only there", () => {
    expect(comparisonProblems([change], "Body.\n\nEval-Waiver: a typo in a heading no case reads.", [])).toEqual([]);
    expect(comparisonProblems([change], "Eval-Waiver:", [])).toHaveLength(1);
    // Anyone who can comment could post one: a comment's waiver waives nothing.
    expect(comparisonProblems([change], "Body.", ["Eval-Waiver: a typo in a heading no case reads."])).toHaveLength(1);
  });

  it("is checked on every pull request, the head's own blobs, again when the body is edited", () => {
    const workflow = parse(fs.readFileSync(path.join(".github", "workflows", "prompt-evals.yml"), "utf8")) as {
      on: { pull_request: { types: string[] } };
      jobs: Record<string, { steps: { uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }[] }>;
    };
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

    expect(workflow.on.pull_request.types).toEqual(expect.arrayContaining(["opened", "synchronize", "reopened", "edited"]));
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toMatchObject({
      ref: "${{ github.event.pull_request.head.sha }}",
      "fetch-depth": 0,
    });
    const check = steps.find((step) => step.run === "node scripts/eval-prompts.ts check-comparison");
    expect(Object.keys(check?.env ?? {}).sort()).toEqual(["BASE_SHA", "GH_REPO", "GH_TOKEN", "HEAD_SHA", "PR_NUMBER"]);
  });

  it("asks for each changed prompt's own", () => {
    const fixChange = { prompt: "fix" as const, before: "4".repeat(40), after: "5".repeat(40) };

    expect(comparisonProblems([change, fixChange], "", [comparison(change.before, change.after)])).toEqual([expect.stringMatching(/^fix\/prompt\.md/)]);
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

  // #719: the clean case for fix is one where the right change is none, held
  // by a grader no judge rules on: the printed diff is empty.
  it("include a clean case, graded on an empty change with no judge", () => {
    const clean = cases.filter((c) => c.clean);

    expect(clean.length).toBeGreaterThanOrEqual(1);
    for (const c of clean) {
      const deterministic = c.graders.map((grader) => frontmatter(fs.readFileSync(path.join(c.dir, "graders", grader), "utf8"))).filter((g) => g["type"] === "regex");
      expect(deterministic.map((g) => [g["pattern"], g["match"]]), c.name).toContainEqual(["^diff --git ", "not_contains"]);
    }
  });

  it("stage a control for the judge with only the graders a judge rules on", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "controls-"));
    try {
      const staged = stageControls(ROOT, "fix", out, (name) => name === "declined-unrunnable-eval");
      const control = staged.controls?.find((x) => x.control === "no-change-round");
      const dir = path.join(out, "evals", "declined-unrunnable-eval--no-change-round");

      expect(control?.expect).toEqual({ "02": true });
      expect(fs.readdirSync(path.join(dir, "graders"))).toEqual(["02.md"]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it("report a clean case's failures as changes where none was needed", () => {
    const meta: StageMeta = {
      prompt: "fix",
      revision: { file: "fix/prompt.md", head: "a".repeat(40), lastChange: "b".repeat(40), blob: "c".repeat(40), uncommitted: false },
      cases: [{ name: "no-change", pr: 1, head: "d".repeat(40), clean: true }],
    };
    const result: EvalResult = {
      cases: [
        {
          name: "no-change",
          graders: [{ name: "01" }],
          arms: { with: [{ error: null, graders: [{ name: "01", passed: true }] }, { error: null, graders: [{ name: "01", passed: false }] }] },
        },
      ],
    };
    const text = report(meta, result);

    expect(text).toContain("**False-change rate** (clean cases, where the right change is none):");
    expect(text).toContain("- **no-change:** 1 of 2 completed runs made a change or an outcome the case needs none of (50%).");
    expect(text).not.toContain("false finding");
  });

  describe.each(cases.map((c) => [c.name, c] as const))("case %s", (_name, c) => {
    it.each(c.graders)("grader %s reads the final message and asks for no commit", (grader) => {
      const parsed = frontmatter(fs.readFileSync(path.join(c.dir, "graders", grader), "utf8"));

      expect(parsed["type"] === "regex" ? parsed["target"] : parsed["focus"]).toBe("last_message");
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
    // One clean case is one pull request: the pooled line is for several.
    expect(text).not.toContain("all clean cases");
  });

  // #719: several clean pull requests make the false-finding rate a rate.
  it("pools the false-finding rate over the clean cases, where there are several", () => {
    const two: StageMeta = { ...meta, cases: [...meta.cases, { name: "clean2", pr: 3, head: "f".repeat(40), clean: true }] };
    const more: EvalResult = {
      ...result,
      cases: [...result.cases, { name: "clean2", graders: [{ name: "01" }], arms: { with: [run({ "01": true }), run({ "01": true })] } }],
    };

    expect(report(two, more)).toContain("- **all clean cases (2):** 1 of 4 completed runs raised a false finding (25%).");
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
