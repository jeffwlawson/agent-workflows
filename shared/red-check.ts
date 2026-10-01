import * as fs from "node:fs";
import { asArray, asRecord, asString } from "./common.js";

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
  return {
    status: asString(record["status"], "status"),
    ...(reason === undefined ? {} : { reason }),
    base: nullableString(record["base"], "base"),
    head: nullableString(record["head"], "head"),
    files: strings(record["files"], "files"),
    ...(record["source"] === undefined ? {} : { source: strings(record["source"], "source") }),
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

const list = (files: readonly string[]): string => files.map((file) => `- ${code(file)}`).join("\n");

/** The non-test files the PR changes, and what they are owed, given whether any test is red. */
const renderSource = (report: RedCheckReport, red: number): string => {
  if (report.source === undefined) {
    return "The report does not list the non-test files this pull request changes; read them off the diff.";
  }
  if (report.source.length === 0) {
    return "**This pull request changes no non-test file**, so there is no behaviour change for a red test to cover.";
  }
  const heading =
    red === 0
      ? `**No test is red against the merge-base, and this pull request changes ${report.source.length} non-test file(s).** No behaviour change in them is covered by a red test:`
      : `**Non-test files this pull request changes** (${report.source.length}). Each behaviour change in them needs a red test above that covers it:`;
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
  const at = report.base === null ? "the merge-base" : `the merge-base, ${code(report.base)}`;
  const placed = `took the test files this pull request adds or changes and put them over ${at}, with every other file as it was there`;
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
    return `The red check is configured, and stopped before running its test command: it looked for the test files this pull request adds or changes against ${at}, and placed and ran nothing.`;
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
    parts.push("**This pull request adds or changes no test file**, so no test is red against the merge-base.");
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
      ? "**Red against the merge-base: none.** No test failed there on an assertion."
      : `**Red against the merge-base** (${red.length}): each failed there on the assertion shown, so each is evidence that it catches the behaviour this pull request changes.\n\n${red.map(withMessage).join("\n\n")}`,
  );
  if (broken.length > 0) {
    parts.push(
      `**Broken against the merge-base** (${broken.length}): each failed there on import, collection or setup, before any assertion ran. **A broken test is not red, and is not coverage**, whatever it would assert.\n\n${broken.map(withMessage).join("\n\n")}`,
    );
  }
  if (passed.length > 0) {
    parts.push(
      `**Passed against the merge-base** (${passed.length}): each passes without this pull request's change too, so none is evidence for it.\n\n${passed.map((test) => `- ${describeTest(test)}`).join("\n")}`,
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

const failingFirst = (test: RedCheckTest): string =>
  test.message
    ? `- ${describeTest(test)}\n\n${fenced(clipped(test.message))}`
    : `- ${describeTest(test)} (no assertion reported)`;

export const FAILING_FIRST_HEADING = "### Failing-first tests";

/**
 * The **failing-first tests** as the pull request's body lists them (#234),
 * under the summary the review writes: the tests the red check found red
 * against the merge-base, each with the assertion it failed on.
 *
 * Only red tests are listed: a broken test failed before any assertion ran, so
 * it is counted and said to be not failing-first, never listed beside them. A
 * check that is off, and one whose report could not be read or held no
 * result, each say so, because an empty list would read as "none was red".
 */
export const renderFailingFirst = (check: RedCheck, reviewedHead: string): string => {
  const body = ((): string => {
    switch (check.kind) {
      case "not-configured":
        return "The red check is not configured for this repository, so no test here is shown to fail against the code as it was before this change.";
      case "unreadable":
        return `The red check is configured, and its report could not be read: ${check.reason}. Which tests fail against the code as it was before this change is unknown.`;
      case "ran":
        break;
    }
    const report = check.report;
    if (report.status === "no-test-files") {
      return "None: this pull request adds or changes no test file.";
    }
    if (report.status !== "ran" || report.tests.length === 0) {
      const why =
        report.status !== "ran"
          ? (NOT_RUN[report.status] ?? `it reported ${code(report.status)}`)
          : "its JUnit report held no test that ran";
      return `The red check is configured, and came back with no test results: ${why}. Which tests fail against the code as it was before this change is unknown.`;
    }

    const red = report.tests.filter((test) => test.result === "red");
    const broken = report.tests.filter((test) => test.result === "broken").length;
    const parts: string[] = [
      red.length === 0
        ? "None: no test this pull request adds or changes failed on an assertion against the code as it was before this change."
        : `Each of these failed on the assertion shown against the code as it was before this change, ${
            report.base === null ? "the merge-base" : `the merge-base ${code(report.base)}`
          }, with this pull request's test files put over it:\n\n${red.slice(0, MAX_LISTED).map(failingFirst).join("\n\n")}`,
    ];
    if (red.length > MAX_LISTED) {
      parts.push(`And ${red.length - MAX_LISTED} more, not listed here to keep the body short.`);
    }
    if (broken > 0) {
      parts.push(
        `${broken} more failed there on import, collection or setup, before any assertion ran. Those are not failing-first, and are not listed.`,
      );
    }
    if (report.head !== null && report.head !== reviewedHead) {
      parts.push(
        `The check read this pull request at ${code(report.head)}, not at ${code(reviewedHead)}, so a test added after that is not listed.`,
      );
    }
    return parts.join("\n\n");
  })();
  return defused(`${FAILING_FIRST_HEADING}\n\n${body}`);
};

/**
 * The summary the body carries: the agent's text, then the failing-first
 * tests. The block it rewrites is handed back to it as input, list and all, so
 * a list it carried forward is cut from its text first rather than kept as a
 * second, stale copy above the one the report gives.
 */
export const withFailingFirst = (summary: string, check: RedCheck, reviewedHead: string): string => {
  const at = summary.indexOf(FAILING_FIRST_HEADING);
  const own = (at === -1 ? summary : summary.slice(0, at)).trimEnd();
  const section = renderFailingFirst(check, reviewedHead);
  return own === "" ? section : `${own}\n\n${section}`;
};
