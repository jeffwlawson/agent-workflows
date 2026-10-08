import * as fs from "node:fs";
import * as path from "node:path";
import type { OutputWriters } from "../shared/command-io.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { choice, count, json, list, matching, object, optional, readDirectory, text } from "../shared/hand-over.js";
import type { RedCheckReport, RedCheckTest, TestResult } from "../shared/red-check.js";
import { PLACEMENTS } from "./red-check-place.js";
import { parseXml, XmlError, type XmlElement } from "./xml.js";

type Inputs = InputValues<(typeof COMMANDS)["review:red-check-classify"]["inputs"]>;
type Outputs = OutputWriters<(typeof COMMANDS)["review:red-check-classify"]["outputs"]>;

/** A message's length, since a test's output is the PR's to make as long as it likes. */
const LIMIT = 2000;

const SHA = matching(/[0-9a-f]{40}|[0-9a-f]{64}/, "a commit");

/**
 * A file the pull request changes, by its name in git: anything but a line
 * break, which `review:red-check-place` drops.
 */
const CHANGED = matching(/[^\n]+/, "a path the pull request changes");

/** As many files as one pull request could name. */
const FILES = { max: 100_000 };

/**
 * `review:red-check-classify` (#422): the red check's report,
 * `red_check.json`, written whatever happened before it, so the review can
 * tell "no red test" from "the check did not run". `status` is `ran` where
 * the JUnit report was read, and otherwise why it was not.
 *
 * Each test in the report is:
 *
 *  - **red**: failed on an assertion, a JUnit `<failure>`, recorded with its
 *    message. The evidence the check exists for: this test catches the
 *    behaviour the PR changed.
 *  - **broken**: failed on collection, import or setup. A test that cannot
 *    import the function it tests fails against the merge-base too, and
 *    proves nothing about the behaviour.
 *  - **passed**.
 *
 * JUnit is the contract, but the reporters do not draw that line the same
 * way, so this reads each one's shape rather than one element:
 *
 *  - pytest's `--junitxml` writes a collection, import or fixture error as
 *    `<error>`, and so does jest-junit, for a suite that failed to run, once
 *    its `reportTestSuiteErrors` is on. Off, its default, it leaves such a
 *    suite out of the report altogether: never red, but never broken either.
 *  - vitest writes everything as `<failure>`. A file that failed to import or
 *    collect is a testcase named by the file, as its classname is, and a
 *    `beforeAll` or `afterAll` that threw is one named by its `describe`,
 *    after every test of the file; neither is a test. A test sharing that
 *    `describe`'s title comes before the run of them, and reads as a test.
 *
 * A hook that throws for each test (a `beforeEach`, or a jest `beforeAll`) is
 * reported on the test itself, and JUnit cannot tell it from the test
 * throwing; it reads as red, as pytest reads any exception in a test's body.
 *
 * **It runs after the pull request's code**, which could have changed anything
 * on the runner, this command's own install included. So it is handed no
 * token: what that code gains by tampering with it is the power to forge its
 * own report, which its tests already have, and which the review reads as
 * evidence, never as a fact. An install that is gone fails the command, and
 * leaves no report, which the review reads as unreadable.
 */
export const classify = (inputs: Inputs, outputs: Outputs): void => {
  const { "place.json": placed } = readDirectory(COMMANDS["review:red-check-classify"].inputs.PLACE_DIR, inputs.PLACE_DIR, {
    "place.json": json(
      object({
        status: choice(PLACEMENTS),
        reason: optional(text),
        head: SHA,
        base: optional(SHA),
        slice: optional(count({ min: 1, max: Number.MAX_SAFE_INTEGER })),
        files: list(CHANGED, FILES),
        source: optional(list(CHANGED, FILES)),
      }),
    ),
  });

  const status = placed?.status ?? "failed";
  let report: Mutable<RedCheckReport> = {
    status,
    base: placed?.base ?? null,
    head: placed?.head ?? null,
    files: placed?.files ?? [],
    exitCode: null,
    tests: [],
    skipped: 0,
    ...(placed?.reason === undefined || placed.reason === "" ? {} : { reason: placed.reason }),
    // On a slice round (#235), the slice whose "before" `base` is: the PRD
    // branch as it stood before it. Absent where `base` is the merge-base.
    ...(placed?.slice === undefined ? {} : { slice: placed.slice }),
    // The non-test files the PR changes, where the merge-base was found to
    // list them against. Absent, not empty, where it was not: an empty list
    // says the PR changes no source.
    ...(placed?.source === undefined ? {} : { source: placed.source }),
  };

  if (status === "ready") {
    const exitCode = /^\d+$/.test(inputs.EXIT_CODE) ? Number(inputs.EXIT_CODE) : null;
    report.exitCode = exitCode;
    const file = path.resolve(inputs.CHECKOUT, inputs.REPORT_PATH);
    if (inputs.SETUP_OUTCOME === "failure") report.status = "setup-failed";
    else if (exitCode === null) report.status = "not-run";
    else if (inputs.REPORT_PATH === "" || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) report.status = "no-report";
    else report = { ...report, ...read(fs.readFileSync(file, "utf8")) };
  }

  outputs.writeJson("red_check.json", report);
  const counts = new Map<TestResult, number>();
  for (const test of report.tests) counts.set(test.result, (counts.get(test.result) ?? 0) + 1);
  console.log(`Red check: ${report.status}${[...counts].map(([result, n]) => `, ${n} ${result}`).join("")}.`);
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A JUnit report's tests, or why it could not be read. */
const read = (xml: string): Pick<RedCheckReport, "status" | "tests" | "skipped" | "reason"> => {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (error) {
    if (!(error instanceof XmlError)) throw error;
    return { status: "unreadable-report", tests: [], skipped: 0, reason: capped(error.message) };
  }
  const tests: RedCheckTest[] = [];
  let skipped = 0;
  // One test reported twice is one test, with the worse result: jest-junit
  // writes a suite that failed to run as an `<error>` and again as a
  // `<failure>`, under one name. A vitest test and a failed `describe` that
  // share a title are two, so whether it is a test is in the key.
  const seen = new Map<string, number>();
  for (const parent of everyElement(root)) {
    const cases = childrenNamed(parent, "testcase");
    const names = cases.map((c) => c.attributes.get("name") ?? "");
    cases.forEach((testcase, index) => {
      const { result, message, container } = classifyCase(cases, index, parent.attributes.get("name"), names);
      if (result === "skipped") {
        skipped += 1;
        return;
      }
      const file = testcase.attributes.get("file");
      const test: RedCheckTest = {
        name: testcase.attributes.get("name") ?? "",
        classname: testcase.attributes.get("classname") ?? "",
        ...(file ? { file } : {}),
        result,
        ...(message === undefined ? {} : { message }),
      };
      const key = JSON.stringify([test.name, test.classname, test.file ?? null, container]);
      const at = seen.get(key);
      if (at === undefined) {
        seen.set(key, tests.length);
        tests.push(test);
      } else if (RANK[result] > RANK[(tests[at] as RedCheckTest).result]) {
        tests[at] = test;
      }
    });
  }
  return { status: "ran", tests, skipped };
};

const RANK: Readonly<Record<TestResult, number>> = { passed: 0, red: 1, broken: 2 };

/** `element` and every element under it, in document order. */
function* everyElement(element: XmlElement): Generator<XmlElement> {
  yield element;
  for (const child of element.children) yield* everyElement(child);
}

const childrenNamed = (element: XmlElement, name: string): XmlElement[] =>
  element.children.filter((child) => !child.namespaced && child.name === name);

const childNamed = (element: XmlElement, name: string): XmlElement | undefined => childrenNamed(element, name)[0];

/** Trimmed and capped, by characters. */
const capped = (said: string): string => {
  const chars = [...said.trim()];
  return chars.length <= LIMIT ? chars.join("") : `${chars.slice(0, LIMIT).join("")} [truncated]`;
};

/** Every line break Python's `splitlines` splits on, which the step this replaces read the first line by. */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** What a failure or an error says: its `message`, or else the first line of its body. */
const messageOf = (element: XmlElement): string => {
  const given = element.attributes.get("message") ?? "";
  if (given.trim() !== "") return capped(given);
  const body = element.text.trim();
  return capped(body === "" ? "" : (body.split(LINE_BREAK)[0] ?? ""));
};

/**
 * A testcase that is not a test: vitest reports a file that failed to import
 * or collect as a testcase named by the file, as its classname and its
 * testsuite are, and a `describe` whose `beforeAll` or `afterAll` threw as one
 * named by the `describe`, which the tests under it are named after, joined by
 * ` > `. Either one's failure is the file's or the suite's, not a test's.
 * (jest-junit names every testcase as its classname, but never its testsuite,
 * which is why all three are compared.)
 *
 * A test may share a `describe`'s title, so the name alone does not say which
 * a testcase is. Where it is: vitest writes every test of a file first and
 * appends the failed `describe`s after the last of them, so one is a
 * `describe` only if it, and every testcase after it, is a failure named like
 * one. A test with any testcase after it that passed, was skipped, or is named
 * like no `describe` is never in that run. The one left ambiguous, a failing
 * test that shares a title and is its file's last, reads as broken: evidence
 * lost, never evidence made up. (Not the error's type: a hook can fail on an
 * `expect` too, and a test on a `TypeError`.)
 */
const namesADescribe = (testcase: XmlElement, names: readonly string[]): boolean => {
  const name = testcase.attributes.get("name") ?? "";
  const prefix = `${name} > `;
  return (
    name !== "" &&
    childNamed(testcase, "failure") !== undefined &&
    names.some((other) => other.startsWith(prefix) || other.includes(` > ${prefix}`))
  );
};

const isContainer = (cases: readonly XmlElement[], index: number, suite: string | undefined, names: readonly string[]): boolean => {
  const testcase = cases[index] as XmlElement;
  const name = testcase.attributes.get("name") ?? "";
  if (name !== "" && name === testcase.attributes.get("classname") && name === suite) return true;
  return cases.slice(index).every((later) => namesADescribe(later, names));
};

/**
 * An error outranks a failure: a test that could not be set up never reached
 * the assertion it would have failed on. `container` says the testcase is a
 * file or a `describe` rather than a test.
 */
const classifyCase = (
  cases: readonly XmlElement[],
  index: number,
  suite: string | undefined,
  names: readonly string[],
): { readonly result: TestResult | "skipped"; readonly message?: string; readonly container: boolean } => {
  const testcase = cases[index] as XmlElement;
  const error = childNamed(testcase, "error");
  const failure = childNamed(testcase, "failure");
  if (error !== undefined) return { result: "broken", message: messageOf(error), container: false };
  if (failure !== undefined) {
    return isContainer(cases, index, suite, names)
      ? { result: "broken", message: messageOf(failure), container: true }
      : { result: "red", message: messageOf(failure), container: false };
  }
  if (childNamed(testcase, "skipped") !== undefined) return { result: "skipped", container: false };
  return { result: "passed", container: false };
};
