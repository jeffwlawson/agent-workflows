import * as fs from "node:fs";
import { asArray, asRecord, asString } from "./common.js";
import { MERGE_DANGER_HEADING } from "./merge-danger.js";
import { embeddableJson, type CiResult, type TestSketch } from "./review-output.js";

/**
 * The red check's evidence, as the review reads it (#232, PRD #212).
 *
 * The `red-check` job in `review.yml` runs the tests a pull request adds or
 * changes against the merge-base, and reports each one as **red** (it failed
 * there on an assertion), **broken** (it failed on import, collection or
 * setup) or **passed**. That report is what lets a review check "the fix is
 * covered by a test that was red" instead of taking the pull request's word
 * for it.
 *
 * Three cases, kept apart, because they lead to different reviews:
 *
 *  - **not configured**: the adopter has not turned the check on, so there is
 *    no evidence and nothing is owed;
 *  - **unreadable**: it is on, and its report is missing or not the shape
 *    written here. Unknown, which is never "no red tests" and never "all
 *    covered";
 *  - **ran**: the report was read. Its `status` still says whether any test was
 *    run: `ran` where the JUnit report was read, and otherwise why not.
 */
export type RedCheck =
  | { readonly kind: "not-configured" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "ran"; readonly report: RedCheckReport };

export type TestResult = "red" | "broken" | "passed";

export interface RedCheckTest {
  readonly name: string;
  readonly classname: string;
  readonly file?: string;
  readonly result: TestResult;
  readonly message?: string;
}

/** The job's `red_check.json`, field for field. */
export interface RedCheckReport {
  readonly status: string;
  readonly reason?: string;
  readonly base: string | null;
  readonly head: string | null;
  /** The test files the PR adds or changes, put over the merge-base. */
  readonly files: readonly string[];
  /**
   * The non-test files the PR changes. Absent where the job never got as far
   * as listing them, which is not the same as none.
   */
  readonly source?: readonly string[];
  /**
   * On a PRD PR's slice round (#235), the slice whose "before" `base` is: the
   * PRD branch as it stood before that slice, rather than the merge-base.
   */
  readonly slice?: number;
  readonly exitCode: number | null;
  readonly tests: readonly RedCheckTest[];
  readonly skipped: number;
}

const RESULTS: readonly string[] = ["red", "broken", "passed"];

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
};

const nullableString = (value: unknown, label: string): string | null =>
  value === null ? null : asString(value, label);

const strings = (value: unknown, label: string): string[] =>
  asArray(value, label).map((item) => {
    if (typeof item !== "string") throw new Error(`${label} must hold strings`);
    return item;
  });

const parseTest = (value: unknown): RedCheckTest => {
  const record = asRecord(value, "test");
  const result = record["result"];
  if (typeof result !== "string" || !RESULTS.includes(result)) {
    throw new Error(`a test's result must be one of ${RESULTS.join(", ")}`);
  }
  const name = record["name"];
  if (typeof name !== "string") throw new Error("a test's name must be a string");
  const classname = record["classname"];
  if (typeof classname !== "string") throw new Error("a test's classname must be a string");
  const file = optionalString(record["file"], "a test's file");
  const message = optionalString(record["message"], "a test's message");
  return {
    name,
    classname,
    ...(file === undefined ? {} : { file }),
    result: result as TestResult,
    ...(message === undefined ? {} : { message }),
  };
};

const parseReport = (value: unknown): RedCheckReport => {
  const record = asRecord(value, "the report");
  const reason = optionalString(record["reason"], "reason");
  const exitCode = record["exitCode"];
  if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error("exitCode must be an integer or null");
  const skipped = record["skipped"];
  if (!Number.isInteger(skipped)) throw new Error("skipped must be an integer");
  const slice = record["slice"];
  if (slice !== undefined && !Number.isInteger(slice)) throw new Error("slice must be an integer");
  return {
    status: asString(record["status"], "status"),
    ...(reason === undefined ? {} : { reason }),
    base: nullableString(record["base"], "base"),
    head: nullableString(record["head"], "head"),
    files: strings(record["files"], "files"),
    ...(record["source"] === undefined ? {} : { source: strings(record["source"], "source") }),
    ...(slice === undefined ? {} : { slice: slice as number }),
    exitCode: exitCode as number | null,
    tests: asArray(record["tests"], "tests").map(parseTest),
    skipped: skipped as number,
  };
};

/**
 * What the review is handed. `configured` is whether the caller set
 * `red-check-command`, which the workflow knows and the report cannot say: a
 * check that is off writes no report, and neither does one whose report was
 * lost. So a missing file is `unreadable` where the check is on, never "off".
 */
export const readRedCheck = (configured: boolean, file: string | undefined): RedCheck => {
  if (!configured) return { kind: "not-configured" };
  if (!file) return { kind: "unreadable", reason: "the workflow named no file to read its report from" };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { kind: "unreadable", reason: "its report did not reach this review" };
  }
  try {
    return { kind: "ran", report: parseReport(JSON.parse(text)) };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `its report could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
};

/**
 * Why a report holds no results, for each `status` other than `ran` the job
 * writes. One the job adds later is still said, by its name, and still read as
 * unknown.
 */
const NOT_RUN: Readonly<Record<string, string>> = {
  misconfigured: "the check is only partly configured",
  "no-merge-base": "the pull request's head has no merge-base with its base branch",
  "setup-failed": "installing the merge-base's dependencies failed",
  "not-run": "the test command never ran",
  "no-report": "the test command wrote no JUnit report",
  "unreadable-report": "the JUnit report the test command wrote could not be parsed",
  failed: "the job failed before it could say what it ran",
  "final-review": "this is a PRD PR's final review, which reads each slice round's red check instead",
};

const UNKNOWN =
  "**Which tests are red is unknown.** That is not \"no red tests\", and it is not \"all covered\": judge the tests in the diff yourself, and take no claim that a test was red on the pull request's word.";

const code = (text: string): string => `\`${text.replaceAll("`", "'")}\``;

/** A fence no backtick run in the text can close: a test's message is the pull request's to write. */
const fenced = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

const describeTest = (test: RedCheckTest): string => {
  const where = [test.classname, test.file].filter((part): part is string => !!part && part !== test.name);
  return `${code(test.name)}${where.length === 0 ? "" : ` (${where.map(code).join(", ")})`}`;
};

const withMessage = (test: RedCheckTest): string =>
  test.message ? `- ${describeTest(test)}\n\n${fenced(test.message)}` : `- ${describeTest(test)} (no message reported)`;

/**
 * What the tests ran against: the merge-base, or on a PRD PR's slice round the
 * PRD branch as it stood before the slice (#235), which holds every earlier
 * slice.
 */
const before = (report: RedCheckReport): string =>
  report.slice === undefined ? "the merge-base" : `the PRD branch as it stood before this slice (#${report.slice})`;

const list = (files: readonly string[]): string => files.map((file) => `- ${code(file)}`).join("\n");

/** Whose changes the report covers: the pull request's, or on a slice round the slice's alone. */
const whose = (report: RedCheckReport): string => (report.slice === undefined ? "this pull request" : "this slice");

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The non-test files the PR changes, and what they are owed, given whether any test is red. */
const renderSource = (report: RedCheckReport, red: number): string => {
  if (report.source === undefined) {
    return "The report does not list the non-test files this pull request changes; read them off the diff.";
  }
  if (report.source.length === 0) {
    return `**${capital(whose(report))} changes no non-test file**, so there is no behaviour change for a red test to cover.`;
  }
  const heading =
    red === 0
      ? `**No test is red against ${before(report)}, and ${whose(report)} changes ${report.source.length} non-test file(s).** No behaviour change in them is covered by a red test:`
      : `**Non-test files ${whose(report)} changes** (${report.source.length}). Each behaviour change in them needs a red test above that covers it:`;
  return `${heading}\n\n${list(report.source)}`;
};

/**
 * How far the job got, which is the report's `status` and nothing else: only
 * a run that reached the test command may say it did. A status the job adds
 * later is not assumed to have got anywhere.
 */
const PLACED_AND_RAN: readonly string[] = ["ran", "no-report", "unreadable-report"];
const PLACED_ONLY: readonly string[] = ["setup-failed", "not-run"];

const opening = (report: RedCheckReport): string => {
  const at = report.base === null ? before(report) : `${before(report)}, ${code(report.base)}`;
  const tests = `${whose(report)} adds or changes`;
  const placed = `took the test files ${tests} and put them over ${at}, with every other file as it was there`;
  if (report.status === "ran") {
    return `The red check ran. It ${placed}, and ran the test command the repository configures for it.`;
  }
  if (PLACED_AND_RAN.includes(report.status)) {
    return `The red check is configured, and stopped after running its test command. It ${placed}, and ran the test command the repository configures for it.`;
  }
  if (PLACED_ONLY.includes(report.status)) {
    return `The red check is configured, and stopped before running its test command. It ${placed}, and never ran the test command.`;
  }
  if (report.status === "no-test-files") {
    return `The red check is configured, and stopped before running its test command: it looked for the test files ${tests} against ${at}, and placed and ran nothing.`;
  }
  return "The red check is configured, and stopped before running its test command: it placed no test file and ran nothing.";
};

const renderRan = (report: RedCheckReport, reviewedHead: string): string => {
  const parts: string[] = [opening(report)];
  if (report.head !== null && report.head !== reviewedHead) {
    parts.push(
      `**It read the pull request at ${code(report.head)}, and this review reads ${code(reviewedHead)}.** Anything pushed between the two is not in it, so whether a red test covers what those commits change is unknown, as for a report that could not be read.`,
    );
  }

  const status = report.status;
  if (status === "no-test-files") {
    parts.push(
      `**${capital(whose(report))} adds or changes no test file**, so no test is red against ${before(report)}.`,
    );
    parts.push(renderSource(report, 0));
    return parts.join("\n\n");
  }
  if (status !== "ran") {
    const why = NOT_RUN[status] ?? `it reported ${code(status)}`;
    parts.push(`**No test result came back:** ${why}.${report.reason ? ` It said:\n\n${fenced(report.reason)}` : ""}`);
    parts.push(UNKNOWN);
    return parts.join("\n\n");
  }

  if (report.files.length > 0) parts.push(`Test files it ran:\n\n${list(report.files)}`);

  // A report with no test that ran says nothing about what is red: every test
  // was skipped, or the command never ran the files above. Unknown, as for a
  // report that never arrived, never "none red" with every change uncovered.
  if (report.tests.length === 0) {
    const skipped =
      report.skipped > 0
        ? `the JUnit report it read held ${report.skipped} skipped test(s) and none that ran`
        : "the JUnit report it read held no test at all, so the command may not have run the files above";
    parts.push(`**No test result came back:** ${skipped}.`);
    parts.push(UNKNOWN);
    return parts.join("\n\n");
  }

  const red = report.tests.filter((test) => test.result === "red");
  const broken = report.tests.filter((test) => test.result === "broken");
  const passed = report.tests.filter((test) => test.result === "passed");

  parts.push(
    red.length === 0
      ? `**Red against ${before(report)}: none.** No test failed there on an assertion.`
      : `**Red against ${before(report)}** (${red.length}): each failed there on the assertion shown, so each is evidence that it catches the behaviour this pull request changes.\n\n${red.map(withMessage).join("\n\n")}`,
  );
  if (broken.length > 0) {
    parts.push(
      `**Broken against ${before(report)}** (${broken.length}): each failed there on import, collection or setup, before any assertion ran. **A broken test is not red, and is not coverage**, whatever it would assert.\n\n${broken.map(withMessage).join("\n\n")}`,
    );
  }
  if (passed.length > 0) {
    parts.push(
      `**Passed against ${before(report)}** (${passed.length}): each passes without this pull request's change too, so none is evidence for it.\n\n${passed.map((test) => `- ${describeTest(test)}`).join("\n")}`,
    );
  }
  parts.push(renderSource(report, red.length));
  return parts.join("\n\n");
};

/** The red check's evidence as the review prompt carries it. */
export const renderRedCheck = (check: RedCheck, reviewedHead: string): string => {
  switch (check.kind) {
    case "not-configured":
      return "**The red check is not configured** for this repository, so there is no red evidence. Review the tests as the rest of this brief says, and do not flag a change only for having no red test.";
    case "unreadable":
      return `**The red check is configured, and its result could not be read**: ${check.reason}.\n\n${UNKNOWN}`;
    case "ran":
      return renderRan(check.report, reviewedHead);
  }
};

/**
 * The red check's evidence as a PRD PR's final review is given it (#235): each
 * slice round's record, not a run of its own. Against the merge-base a later
 * slice's test of an earlier slice's code fails to import, and reads as
 * broken, so the job runs nothing on the final review, and each slice's
 * behaviour is held to the red check its own round ran against the PRD branch
 * as it stood before it. `slices` is undefined where the PRD branch could not
 * be read, which leaves every slice unknown.
 */
export const renderRedCheckForFinal = (slices: readonly SliceRedTests[] | undefined): string => {
  const intro =
    "**This is a PRD PR's final review, so the red check ran nothing here.** Each slice's tests were run in that slice's own round, against the PRD branch as it stood before the slice, where a test of an earlier slice's code can import it. Against the merge-base such a test reads as broken, so no merge-base run is evidence about a slice. What each slice round found is below, and it is the red evidence for that slice's changes: a test named red there covers the behaviour it exercises, whatever this review sees of it now.";
  if (slices === undefined) {
    return `${intro}

**The PRD branch's history could not be read**, so no slice's record is known.

${UNKNOWN}`;
  }
  if (slices.length === 0) return `${intro}

No slice has landed, so there is no record to read.`;
  const lines = slices.flatMap(({ subIssue, record }): string[] => {
    if (record === undefined) {
      return [`- #${subIssue}: **unknown**. No review of this slice recorded what its red check found.`];
    }
    if (!record.known) return [`- #${subIssue}: **unknown**. Its red check came back with no test results.`];
    if (record.red.length === 0) {
      return [`- #${subIssue}: **none red**. No test it adds or changes failed on an assertion before it.`];
    }
    return [
      `- #${subIssue}: **red** (${record.red.length + record.more}):`,
      ...record.red.map((test) => `  - ${describeTest({ ...test, result: "red" })}`),
      ...(record.more > 0 ? [`  - And ${record.more} more, not named in the record.`] : []),
    ];
  });
  return [
    intro,
    lines.join("\n"),
    "Hold each slice's behaviour changes to its own line above. Where a slice's record is **unknown**, which tests are red for that slice is unknown: raise no finding on the strength of the missing record, take no claim of a red test on trust, and judge that slice's coverage from the tests in the diff yourself. Where it is **none red**, a behaviour change that slice makes is not covered by a red test.",
  ].join("\n\n");
};

/** One line for the run's log. */
export const describeRedCheck = (check: RedCheck): string => {
  switch (check.kind) {
    case "not-configured":
      return "not configured";
    case "unreadable":
      return `configured, and unreadable: ${check.reason}`;
    case "ran": {
      const count = (result: TestResult): number => check.report.tests.filter((test) => test.result === result).length;
      return `${check.report.status}, ${count("red")} red, ${count("broken")} broken, ${count("passed")} passed`;
    }
  }
};

/**
 * `<!--` with a zero-width space after its `<`. The summary block is found by
 * its comment markers, and the head it was written at by another, so a test's
 * name or message holding one would end the block early, start a second, or
 * claim a head on the next splice. Defused rather than removed: an unclosed
 * comment removed to the end of the text would take the rest of the section.
 */
const defused = (text: string): string => text.replaceAll("<!--", "<​!--");

/** How much of a message the body carries: enough for the assertion, not a whole diff. */
const MAX_MESSAGE_LINES = 12;
const MAX_MESSAGE_CHARS = 800;
/** How many failing-first tests the body lists, so a large suite cannot crowd out the rest of it. */
const MAX_LISTED = 50;

const clipped = (message: string): string => {
  const lines = message.split(/\r?\n/);
  const text = lines.slice(0, MAX_MESSAGE_LINES).join("\n");
  if (lines.length <= MAX_MESSAGE_LINES && text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS).trimEnd()}\n…`;
};

/** How many tests the body sketches, so the model's pseudocode cannot crowd out the evidence it sits beside. */
export const MAX_TEST_SKETCHES = 3;

/**
 * The sketches the body carries (#355): each one naming a test the report
 * lists as failing first, `failingFirst` in the order the body lists them, the
 * first sketch for a test winning, and at most `MAX_TEST_SKETCHES`. Any other is
 * dropped, so the model can describe a failing-first test but never add one or
 * promote one to proven; a test past the cap stays listed by name.
 */
export const pickSketches = (
  sketches: readonly TestSketch[],
  failingFirst: readonly string[],
): Map<string, string> => {
  const listed = new Set(failingFirst);
  const picked = new Map<string, string>();
  for (const { test, sketch } of sketches) {
    if (picked.size === MAX_TEST_SKETCHES) break;
    if (listed.has(test) && !picked.has(test)) picked.set(test, sketch);
  }
  return picked;
};

/** Each line indented, blank ones left blank, so a block sits inside the list entry above it. */
const indented = (text: string, by: number): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `${" ".repeat(by)}${line}`))
    .join("\n");

/**
 * A sketch is taken from `sketches` as it is placed, so a test listed twice on
 * a PRD PR carries it once.
 */
const sketchOf = (test: Pick<RedCheckTest, "name">, sketches: Map<string, string>): string[] => {
  const sketch = sketches.get(test.name);
  if (sketch === undefined) return [];
  sketches.delete(test.name);
  return [fenced(clipped(sketch))];
};

/** A failing-first test as the body lists it: its name, what it checks where sketched, then why it failed. */
const failingFirst = (test: RedCheckTest, sketches: Map<string, string>): string =>
  [
    `- ${describeTest(test)}${test.message ? "" : " (no assertion reported)"}`,
    ...[...sketchOf(test, sketches), ...(test.message ? [fenced(clipped(test.message))] : [])].map((block) =>
      indented(block, 2),
    ),
  ].join("\n\n");

export const EVIDENCE_HEADING = "## Evidence";

/**
 * The heading the section had before #355. A body written then carries it in
 * the block the review is handed back, and cutting only at the new one would
 * keep that stale copy above the section written now.
 */
const LEGACY_HEADING = "### Failing-first tests";

/** And the Merge Danger the workflow writes after the Evidence (#356), which is carried forward with it. */
const HEADINGS = new RegExp(`^(?:${EVIDENCE_HEADING}|${LEGACY_HEADING}|${MERGE_DANGER_HEADING})[ \\t]*$`, "m");

/**
 * The **After** of every entry: CI's result at the head the summary describes,
 * from the same file the verdict reads. It claims CI's result and never that a
 * named test passed: the test-first check runs nothing at the head.
 */
const after = (ci: CiResult, head: string): string => {
  const at = code(head.slice(0, 7));
  return ci === "unknown" ? `CI's result at ${at} is unknown.` : `CI is ${ci} at ${at}.`;
};

/**
 * One Before/After entry: a list item, the Before on its first line and
 * anything it lists indented under it, then the After.
 */
const entry = (before: string, details: readonly string[], ci: CiResult, head: string, label?: string): string => {
  const opening = `${label === undefined ? "- " : `- ${label}\n  `}**Before:** ${before}`;
  const closing = `  **After:** ${after(ci, head)}`;
  return details.length === 0
    ? `${opening}\n${closing}`
    : [opening, ...details.map((detail) => indented(detail, 2)), closing].join("\n\n");
};

/** What CI and the review's model add to the test-first check's report, for the body's Evidence. */
export interface EvidenceInputs {
  readonly ci: CiResult;
  /** The head the summary describes, and CI's result is for. */
  readonly head: string;
  readonly testSketches?: readonly TestSketch[] | undefined;
}

/**
 * The **Evidence** as the pull request's body gives it (#234, #355), under the
 * summary the review writes: one Before/After entry. **Before** is what the
 * test-first check (the red check, under the name the body gives it) found
 * against the code as it was before this change: the tests red there, each
 * with the assertion it failed on. **After** is CI's result at the head.
 *
 * Only red tests are listed: a broken test failed before any assertion ran, so
 * it is counted and said to be not failing-first, never listed beside them. A
 * check that is off, and one whose report could not be read or held no
 * result, each say so, because an empty list would read as "none was red".
 */
export const renderEvidence = (check: RedCheck, inputs: EvidenceInputs): string => {
  const { ci, head } = inputs;
  const section = ((): string => {
    switch (check.kind) {
      case "not-configured":
        return entry(
          "not checked. The test-first check is off, so no test here is shown to fail without this change.",
          [],
          ci,
          head,
        );
      case "unreadable":
        return entry(
          `unknown. The test-first check is on, and its report could not be read: ${check.reason}. Which tests fail without this change is unknown.`,
          [],
          ci,
          head,
        );
      case "ran":
        break;
    }
    const report = check.report;
    if (report.status === "no-test-files") {
      return entry("none. This pull request adds or changes no test file.", [], ci, head);
    }
    if (report.status !== "ran" || report.tests.length === 0) {
      const why =
        report.status !== "ran"
          ? (NOT_RUN[report.status] ?? `it reported ${code(report.status)}`)
          : "its JUnit report held no test that ran";
      return entry(
        `unknown. The test-first check came back with no test results: ${why}. Which tests fail without this change is unknown.`,
        [],
        ci,
        head,
      );
    }

    const red = report.tests.filter((test) => test.result === "red");
    const listed = red.slice(0, MAX_LISTED);
    const broken = report.tests.filter((test) => test.result === "broken").length;
    const sketches = pickSketches(
      inputs.testSketches ?? [],
      listed.map((test) => test.name),
    );
    const details: string[] = [];
    if (listed.length > 0) details.push(listed.map((test) => failingFirst(test, sketches)).join("\n\n"));
    if (red.length > MAX_LISTED) {
      details.push(`And ${red.length - MAX_LISTED} more, not listed here to keep the body short.`);
    }
    if (broken > 0) {
      details.push(
        `${broken} more failed there on import, collection or setup, before any assertion ran. Those are not failing-first, and are not listed.`,
      );
    }
    if (report.head !== null && report.head !== head) {
      details.push(
        `The test-first check read this pull request at ${code(report.head)}, not at ${code(head)}, so a test added after that is not listed.`,
      );
    }
    const found =
      red.length === 0
        ? "none. No test this pull request adds or changes failed on an assertion against the code as it was before this change."
        : `${red.length} test(s) fail without this change. Each failed on the assertion shown against the code as it was before this change, ${
            report.base === null ? before(report) : `${before(report)} ${code(report.base)}`
          }, with ${whose(report)}'s test files put over it:`;
    return entry(found, details, ci, head);
  })();
  return defused(`${EVIDENCE_HEADING}\n\n${section}`);
};

/**
 * The agent's own text, cut at the first section the workflow writes after it
 * (the Evidence under either heading, or the Merge Danger), which the block it
 * was handed back carried and which is written afresh under it.
 */
export const withoutCarriedSections = (summary: string): string => {
  const at = HEADINGS.exec(summary)?.index ?? -1;
  return (at === -1 ? summary : summary.slice(0, at)).trimEnd();
};

/**
 * The summary the body carries: the agent's text, then the Evidence. The
 * block it rewrites is handed back to it as input, Evidence and all, so a
 * section it carried forward is cut from its text first rather than kept as a
 * second, stale copy above the one the report gives. Under either heading:
 * a body written before #355 carries the old one. Cut at the Merge Danger's
 * heading too (#356), which follows the Evidence and is written afresh with it.
 */
export const withEvidence = (summary: string, check: RedCheck, inputs: EvidenceInputs): string => {
  const own = withoutCarriedSections(summary);
  const section = renderEvidence(check, inputs);
  return own === "" ? section : `${own}\n\n${section}`;
};

/**
 * A slice round's red tests, as its review records them for the final review
 * (#235): the PRD PR's body is rewritten every round, so the one place a
 * slice's failing-first tests outlive the next slice is the review of that
 * slice. Names only, and capped as the body's list is, so the record cannot
 * crowd a review body toward GitHub's limit: the assertions were in the body
 * while the slice was under review.
 *
 * `known` is false where the check is on and which tests were red is unknown,
 * which the final review says rather than listing none.
 */
export interface RedTestsRecord {
  readonly known: boolean;
  readonly red: readonly Pick<RedCheckTest, "name" | "classname" | "file">[];
  /** Red tests past the cap, counted and not named. */
  readonly more: number;
}

/**
 * What a reader selects the record on: a selector, not a control, as
 * `FOLLOW_UPS_MARKER` is. Only a review this loop posted is read.
 */
export const RED_TESTS_MARKER = "agent-red-tests";

/** Versioned for the reason the follow-ups payload is: a review posted before a release is read after it. */
export const RED_TESTS_VERSION = 1;

/** The record of a configured check's report. Undefined where the check is not configured: there is nothing to record. */
export const redTestsRecord = (check: RedCheck): RedTestsRecord | undefined => {
  if (check.kind === "not-configured") return undefined;
  if (check.kind === "unreadable") return { known: false, red: [], more: 0 };
  const report = check.report;
  if (report.status === "no-test-files") return { known: true, red: [], more: 0 };
  if (report.status !== "ran" || report.tests.length === 0) return { known: false, red: [], more: 0 };
  const red = report.tests.filter((test) => test.result === "red");
  return {
    known: true,
    red: red.slice(0, MAX_LISTED).map((test) => ({
      name: test.name,
      classname: test.classname,
      ...(test.file === undefined ? {} : { file: test.file }),
    })),
    more: Math.max(0, red.length - MAX_LISTED),
  };
};

/** The record as a review body carries it: invisible, and read back by `readRedTestsBlock`. */
export const renderRedTestsBlock = (record: RedTestsRecord): string =>
  `<!-- ${RED_TESTS_MARKER} ${embeddableJson({ version: RED_TESTS_VERSION, ...record })} -->`;

const RED_TESTS_BLOCK = new RegExp(`<!-- ${RED_TESTS_MARKER} (.*) -->`, "g");

/**
 * The record a review body carries, or undefined where it carries none or one
 * this version cannot read: either way, there is no record of that round to
 * list. The last match wins, as the follow-ups payload's does.
 */
export const readRedTestsBlock = (body: string): RedTestsRecord | undefined => {
  const raw = [...body.matchAll(RED_TESTS_BLOCK)].pop()?.[1];
  if (raw === undefined) return undefined;
  try {
    const record = asRecord(JSON.parse(raw), "the red tests record");
    if (record["version"] !== RED_TESTS_VERSION || typeof record["known"] !== "boolean") return undefined;
    const more = record["more"];
    return {
      known: record["known"],
      red: asArray(record["red"], "red").map((value) => {
        const test = parseTest({ ...asRecord(value, "a red test"), result: "red" });
        return { name: test.name, classname: test.classname, ...(test.file === undefined ? {} : { file: test.file }) };
      }),
      more: typeof more === "number" && Number.isInteger(more) && more > 0 ? more : 0,
    };
  } catch {
    return undefined;
  }
};

/** One landed slice's record, as the final review collects them; undefined where no review of it carried one. */
export interface SliceRedTests {
  readonly subIssue: number;
  readonly record: RedTestsRecord | undefined;
}

/**
 * The **Evidence** as the PRD PR's final body gives it (#235, #355). With the
 * test-first check on, one Before/After entry per slice: Before is each
 * slice's red tests as its own round's check found them, against the PRD
 * branch as it stood before that slice, and After is CI's result at the head.
 * With it off, one entry for the whole pull request.
 *
 * `redTests` is undefined where the check is off, and its `slices` undefined
 * where the PRD branch could not be read.
 */
export const renderEvidenceBySlice = (
  redTests: { readonly slices: readonly SliceRedTests[] | undefined } | undefined,
  inputs: EvidenceInputs,
): string => {
  const { ci, head } = inputs;
  const section = ((): string => {
    if (redTests === undefined) {
      return entry(
        "not checked. The test-first check is off, so no test in any slice is shown to fail without its change.",
        [],
        ci,
        head,
      );
    }
    const slices = redTests.slices;
    if (slices === undefined) {
      return entry(
        "unknown. The PRD branch's history could not be read, so what each slice's test-first check found is not listed here.",
        [],
        ci,
        head,
      );
    }
    if (slices.length === 0) return entry("none. No slice has landed, so there is nothing to list.", [], ci, head);
    const sketches = pickSketches(
      inputs.testSketches ?? [],
      slices.flatMap(({ record }) => (record === undefined ? [] : record.red.map((test) => test.name))),
    );
    return slices
      .map(({ subIssue, record }): string => {
        const label = `#${subIssue}`;
        if (record === undefined) {
          return entry(
            "no record. No review of this slice recorded what its test-first check found.",
            [],
            ci,
            head,
            label,
          );
        }
        if (!record.known) {
          return entry("unknown. Its test-first check came back with no test results.", [], ci, head, label);
        }
        if (record.red.length === 0) {
          return entry(
            "none. No test it adds or changes failed on an assertion against the PRD branch as it stood before it.",
            [],
            ci,
            head,
            label,
          );
        }
        const tests = record.red.map((test) => {
          const sketch = sketchOf(test, sketches);
          return [`- ${describeTest({ ...test, result: "red" })}`, ...sketch.map((block) => indented(block, 2))].join(
            "\n\n",
          );
        });
        return entry(
          `${record.red.length + record.more} test(s) fail without this slice. Each failed on an assertion against the PRD branch as it stood before it:`,
          [
            tests.join("\n"),
            ...(record.more > 0 ? [`And ${record.more} more, not listed here to keep the body short.`] : []),
          ],
          ci,
          head,
          label,
        );
      })
      .join("\n\n");
  })();
  return defused(`${EVIDENCE_HEADING}\n\n${section}`);
};
