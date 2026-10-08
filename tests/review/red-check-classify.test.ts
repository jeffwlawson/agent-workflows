import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify } from "../../review/red-check-classify.js";
import type { RedCheckReport } from "../../shared/red-check.js";
import { BASE, classified, HEAD, READY } from "./classified.js";

/**
 * `review:red-check-classify` (#422), called the way the CLI calls it: its
 * declared inputs, a placement directory as `review:red-check-place` leaves
 * one, and a real reporter's JUnit XML from `tests/fixtures/red-check`. What
 * is asserted is the report it writes, `red_check.json`, which is the one the
 * review reads (`tests/red-check.test.ts`).
 *
 * The scenarios are the retired Python step's, carried over by behaviour; the
 * report is the one that step wrote for the same inputs, field for field.
 */

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Each test's name, classname and result, the shape every case below compares. */
const results = (report: RedCheckReport): { name: string; classname: string; result: string }[] =>
  report.tests.map(({ name, classname, result }) => ({ name, classname, result }));

const messageOf = (report: RedCheckReport, name: string): string => report.tests.find((t) => t.name === name)?.message ?? "";

/** `xml`, written to a checkout of its own, classified as `report.xml`. */
const classifiedXml = (xml: string): RedCheckReport => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "red-check-xml-"));
  fs.writeFileSync(path.join(checkout, "report.xml"), xml);
  return classified("report.xml", { checkout });
};

describe("review:red-check-classify reads each reporter's shape", () => {
  /**
   * pytest 9.1.1 under `--continue-on-collection-errors`, which the class needs
   * in one report: without it pytest stops at the collection error and the
   * report holds that alone.
   */
  it("reads pytest's assertion as red with its message, and setup and collection errors as broken", () => {
    const report = classified("pytest.xml");

    expect(report).toMatchObject({
      status: "ran",
      base: BASE,
      head: HEAD,
      files: ["tests/test_recipes.py"],
      exitCode: 1,
      skipped: 1,
    });
    expect(results(report)).toEqual([
      // An import error fails against the merge-base too, and proves nothing.
      { name: "tests.test_units", classname: "", result: "broken" },
      { name: "test_scales_servings", classname: "tests.test_recipes", result: "red" },
      { name: "test_keeps_units", classname: "tests.test_recipes", result: "passed" },
      { name: "test_needs_a_fixture", classname: "tests.test_recipes", result: "broken" },
    ]);
    expect(messageOf(report, "test_scales_servings")).toBe("assert 2 == 4\n +  where 2 = scale(1, 2)");
    expect(messageOf(report, "tests.test_units")).toBe("collection failure");
    expect(messageOf(report, "test_needs_a_fixture")).toContain("fixture 'client' not found");
  });

  /**
   * vitest 3.2.4 writes every one of these as a `<failure>`, `errors="0"`: an
   * import error and a throw at collection as a testcase named by the file, and
   * a `beforeAll` that threw, nested or not, as one named by its `describe`.
   */
  it("reads vitest's import, collection and beforeAll failures as broken, and its assertion as red", () => {
    const report = classified("vitest.xml");

    expect(results(report)).toEqual([
      { name: "pantry > opens", classname: "tests/client.test.ts", result: "passed" },
      { name: "needs a client", classname: "tests/client.test.ts", result: "broken" },
      { name: "needs a shelf", classname: "tests/client.test.ts", result: "broken" },
      { name: "tests/collect.test.ts", classname: "tests/collect.test.ts", result: "broken" },
      { name: "scale > doubles a serving", classname: "tests/scale.test.ts", result: "red" },
      { name: "scale > keeps the unit", classname: "tests/scale.test.ts", result: "passed" },
      { name: "tests/units.test.ts", classname: "tests/units.test.ts", result: "broken" },
    ]);
    // The tests under a `beforeAll` that threw never ran.
    expect(report.skipped).toBe(2);
    expect(messageOf(report, "scale > doubles a serving")).toBe("expected 2 to be 4 // Object.is equality");
    expect(messageOf(report, "tests/units.test.ts")).toContain("Cannot find module '../src/units'");
    expect(messageOf(report, "needs a client")).toBe("no client");
  });

  /**
   * vitest 3.2.4 again, on tests that share a `describe`'s title: one before
   * it, one beside a nested one, one throwing a `TypeError`, and one beside a
   * `describe` whose `beforeAll` threw, so both are reported under one name.
   * Every test comes first and the failed `describe`s after the last of them,
   * whatever the error's type: `ready`'s `beforeAll` failed on an `expect`.
   */
  it("reads a vitest test that shares a describe's title as a test, and the describe as broken", () => {
    const report = classified("vitest-shared-titles.xml");

    expect(results(report).filter((t) => !t.name.includes(" > "))).toEqual([
      { name: "parse", classname: "t/a.test.ts", result: "red" },
      { name: "rename", classname: "t/a.test.ts", result: "red" },
      { name: "deep", classname: "t/a.test.ts", result: "red" },
      { name: "load", classname: "t/a.test.ts", result: "red" },
      { name: "load", classname: "t/a.test.ts", result: "broken" },
      { name: "close", classname: "t/a.test.ts", result: "broken" },
      { name: "ready", classname: "t/a.test.ts", result: "broken" },
    ]);
    expect(report.tests.filter((t) => t.name === "load").map((t) => t.message)).toEqual([
      "expected 'a' to be 'b' // Object.is equality",
      "no server",
    ]);
    expect(messageOf(report, "parse")).toBe("expected 1 to be 2 // Object.is equality");
  });

  /**
   * jest 30 with jest-junit, `reportTestSuiteErrors` and `addFileAttribute` on.
   * It writes no `message` attribute, so the message is the body's first line,
   * and a suite that failed to run twice under one name, an `<error>` and a
   * `<failure>`: one test, and broken.
   */
  it("reads jest-junit's suite that failed to run as one broken test, and takes a message from the body", () => {
    expect(classified("jest.xml").tests).toEqual([
      {
        name: "scale doubles a serving",
        classname: "scale doubles a serving",
        file: "tests/scale.test.js",
        result: "red",
        message: "Error: expect(received).toBe(expected) // Object.is equality",
      },
      { name: "scale keeps the unit", classname: "scale keeps the unit", file: "tests/scale.test.js", result: "passed" },
      {
        name: "tests/units.test.js",
        classname: "Test suite failed to run",
        file: "tests/units.test.js",
        result: "broken",
        message: "● Test suite failed to run",
      },
    ]);
  });

  /** vitest 3.2.4, every test skipped, and `--passWithNoTests` with no test file found. */
  it("reads a report with no test that ran as one that ran and holds none", () => {
    expect(classified("vitest-all-skipped.xml")).toMatchObject({ status: "ran", tests: [], skipped: 2 });
    expect(classified("vitest-no-tests.xml")).toMatchObject({ status: "ran", tests: [], skipped: 0 });
  });
});

describe("review:red-check-classify reads XML as the step it replaces did", () => {
  /**
   * The Python standard library's parser read the report before (#422), and
   * these are its readings: the five entities and character references, a
   * line break or tab in an attribute read as a space, CDATA as text, a
   * comment read past, an element in a namespace not the one of its name, and
   * one test reported twice kept where it first was, with the worse result.
   * Each element's own testcases are read before those of the elements in it.
   */
  it("reads entities, CDATA, comments and attribute whitespace as it did", () => {
    const report = classifiedXml(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE testsuites>",
        "<!-- a comment -->",
        '<testsuites name="all">',
        '  <testsuite name="outer">',
        '    <testcase name="a &amp; b" classname="c&#46;d" file="x.py"><failure message="  ">first line &lt;here&gt;\nsecond</failure></testcase>',
        '    <testcase name="multi\nline" classname=\'q"uote\'><failure message="tab\tand&#10;newline"/></testcase>',
        '    <testcase name="cdata" classname="c"><error><![CDATA[boom <in> cdata\nmore]]></error></testcase>',
        '    <testcase name="commented" classname="c"><failure>before<!-- hidden -->after</failure></testcase>',
        '    <testcase name="a &amp; b" classname="c&#46;d" file="x.py"><error message="worse"/></testcase>',
        '    <testcase name="skipped" classname="c"><skipped/></testcase>',
        '    <testcase classname="c"><failure message="no name"/></testcase>',
        '    <x:testcase xmlns:x="urn:x" name="prefixed" classname="c"/>',
        '    <testsuite name="inner">',
        '      <testcase name="deep" classname="i"/>',
        '      <testcase name="inner" classname="inner"><failure message="file level"/></testcase>',
        "    </testsuite>",
        `    <testcase name="long" classname="c"><failure message="${"x".repeat(2500)}"/></testcase>`,
        "  </testsuite>",
        "</testsuites>",
      ].join("\r\n"),
    );

    expect(report.status).toBe("ran");
    expect(report.skipped).toBe(1);
    expect(report.tests.map(({ name, classname, result, message }) => ({ name, classname, result, message }))).toEqual([
      { name: "a & b", classname: "c.d", result: "broken", message: "worse" },
      { name: "multi line", classname: 'q"uote', result: "red", message: "tab and\nnewline" },
      { name: "cdata", classname: "c", result: "broken", message: "boom <in> cdata" },
      { name: "commented", classname: "c", result: "red", message: "beforeafter" },
      { name: "", classname: "c", result: "red", message: "no name" },
      { name: "long", classname: "c", result: "red", message: `${"x".repeat(2000)} [truncated]` },
      { name: "deep", classname: "i", result: "passed", message: undefined },
      { name: "inner", classname: "inner", result: "broken", message: "file level" },
    ]);
  });

  /** UTF-8, by any spelling, and US-ASCII, which is a subset of it, are read. */
  it.each(["UTF-8", "utf-8", "utf8", "US-ASCII"])("reads a report that declares %s", (encoding) => {
    expect(
      classifiedXml(`<?xml version="1.0" encoding="${encoding}"?><testsuite name="s"><testcase name="café" classname="c"/></testsuite>`).tests,
    ).toEqual([{ name: "café", classname: "c", result: "passed" }]);
  });

  it("reads nothing in a default namespace as a testcase", () => {
    expect(classifiedXml('<testsuite xmlns="urn:x" name="s"><testcase name="t" classname="c"/></testsuite>')).toMatchObject({
      status: "ran",
      tests: [],
    });
  });

  /** Not well-formed is unreadable, with where, in expat's words, never read as far as it goes. */
  it.each([
    ["no element", "", "no element found: line 1, column 0"],
    ["text before the root", "import x", "syntax error: line 1, column 0"],
    ["a mismatched tag", "<a><b></a>", "mismatched tag: line 1, column 8"],
    ["an undefined entity", "<a>&bogus;</a>", "undefined entity: line 1, column 3"],
    ["a second root", "<a></a><b/>", "junk after document element: line 1, column 7"],
    ["text after the root", '<testsuite name="s"><testcase name="t"/></testsuite>\ntrailing', "junk after document element: line 2, column 0"],
    ["an unclosed root", "<a><b/>", "no element found: line 1, column 7"],
    ["a duplicate attribute", '<a b="1" b="2"/>', "duplicate attribute: line 1, column 9"],
    ["a control character", "<a>\u0001</a>", "not well-formed (invalid token): line 1, column 3"],
    ["a declared ISO-8859-1", '<?xml version="1.0" encoding="ISO-8859-1"?><a/>', 'encoding "ISO-8859-1" is not UTF-8, which this report is read as: line 1, column 30'],
    ["a declared windows-1252", "<?xml version='1.0' encoding='windows-1252'?><a/>", 'encoding "windows-1252" is not UTF-8, which this report is read as: line 1, column 30'],
    ["a declared UTF-16", '<?xml version="1.0" encoding="UTF-16"?><a/>', 'encoding "UTF-16" is not UTF-8, which this report is read as: line 1, column 30'],
  ])("reads %s as an unreadable report", (_, xml, reason) => {
    expect(classifiedXml(xml)).toMatchObject({ status: "unreadable-report", tests: [], skipped: 0, reason });
  });
});

describe("review:red-check-classify says why there is nothing to classify", () => {
  /** The non-test files the PR changes reach the review in the report (#232), and "not listed" stays apart from "none". */
  it("carries the non-test files the PR changes, and leaves them out where they were never listed", () => {
    expect(classified("pytest.xml", { placed: { ...READY, source: ["src/recipes.py", "src/units.py"] } }).source).toEqual([
      "src/recipes.py",
      "src/units.py",
    ]);
    expect(classified("pytest.xml", { placed: { ...READY, source: [] } }).source).toEqual([]);
    expect(classified("pytest.xml").source).toBeUndefined();
  });

  it("records the slice in the report, beside the base it ran against (#235)", () => {
    expect(classified("pytest.xml", { placed: { ...READY, slice: 232 } }).slice).toBe(232);
    expect(classified("pytest.xml").slice).toBeUndefined();
  });

  /** "No red test" and "the check did not run" are different answers. */
  it("says why, rather than reporting no tests", () => {
    expect(classified("missing.xml").status).toBe("no-report");
    expect(classified("").status).toBe("no-report");
    expect(classified("pytest.xml", { SETUP_OUTCOME: "failure" })).toMatchObject({ status: "setup-failed", exitCode: 1, tests: [] });
    expect(classified("pytest.xml", { EXIT_CODE: "" })).toMatchObject({ status: "not-run", exitCode: null, tests: [] });
    expect(classified("pytest.xml", { placed: { status: "no-test-files", head: HEAD, base: BASE, files: [] } })).toMatchObject({
      status: "no-test-files",
      exitCode: null,
      tests: [],
    });
    expect(classified("pytest.xml", { placed: { status: "misconfigured", reason: "Set them.", head: HEAD, files: [] } })).toEqual({
      status: "misconfigured",
      base: null,
      head: HEAD,
      files: [],
      exitCode: null,
      tests: [],
      skipped: 0,
      reason: "Set them.",
    });
    expect(classified("pytest.xml", { placed: { status: "final-review", head: HEAD, files: [] } })).toMatchObject({
      status: "final-review",
      tests: [],
    });
  });

  /** A placement that never ran leaves no `place.json`, which is a run that failed before it ran anything. */
  it("reads no placement as failed, knowing neither commit", () => {
    expect(classified("pytest.xml", { placed: null })).toEqual({
      status: "failed",
      base: null,
      head: null,
      files: [],
      exitCode: null,
      tests: [],
      skipped: 0,
    });
  });

  /**
   * The placement is written before the pull request's code runs, and read
   * after, so it is read strictly: one that is not what `review:red-check-place`
   * writes fails the command, which leaves no report, and the review reads
   * that as unreadable rather than as anything the file claimed.
   */
  it("fails on a placement it does not recognise, writing no report", () => {
    const written = new Map<string, unknown>();
    const run = (placed: unknown): void => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "red-check-place-"));
      fs.writeFileSync(path.join(dir, "place.json"), JSON.stringify(placed));
      classify(
        { OUTPUT_DIR: "/out", CHECKOUT: "/", REPORT_PATH: "r.xml", SETUP_OUTCOME: "", EXIT_CODE: "0", PLACE_DIR: dir },
        { writeJson: (name, value) => written.set(name, value), writeText: () => {}, appendLine: () => {} },
      );
    };

    expect(() => run({ ...READY, status: "ran" })).toThrow(/review:red-check-place's place.json `status` is "ran"/);
    expect(() => run({ ...READY, head: "HEAD" })).toThrow(/`head` is "HEAD", where a commit was expected/);
    expect(() => run({ ...READY, tests: [] })).toThrow(/has `tests`, which it does not declare/);
    expect(written.size).toBe(0);
  });

  it("says what it found in the log", () => {
    classified("pytest.xml");

    expect(logged).toContain("Red check: ran, 2 broken, 1 red, 1 passed.");
  });
});
