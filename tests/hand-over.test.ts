import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cleaned } from "../shared/clean.js";
import { readsFrom } from "../shared/contract.js";
import {
  choice,
  count,
  filePath,
  json,
  list,
  matching,
  object,
  optional,
  readDirectory,
  refine,
  target,
  text,
} from "../shared/hand-over.js";

/**
 * The readers a command reads another subcommand's files through, exercised
 * on a directory input of the shape a command declares: two of the review
 * runner's files, one written on every outcome and one only on some.
 */

const DECLARED = readsFrom("review", { "verdict.json": "always", "pr_summary.json": "sometimes" });

const THREADS = new Set(["PRRT_one", "PRRT_two"]);

const PARSERS = {
  "verdict.json": json(
    object({
      verdict: choice(["approval recommended", "changes recommended", "needs a closer look"]),
      fixRound: choice([true, false]),
      note: optional(text),
      threads: list(
        object({ threadId: target(THREADS, "a thread on this pull request"), path: filePath, line: count({ min: 1, max: 1_000_000 }) }),
        { max: 2 },
      ),
    }),
  ),
  "pr_summary.json": json(object({ summary: text })),
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-over-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (name: string, value: unknown): void =>
  fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));

const VERDICT = {
  verdict: "changes recommended",
  fixRound: true,
  threads: [{ threadId: "PRRT_one", path: "shared/env.ts", line: 12 }],
};

const read = () => readDirectory(DECLARED, dir, PARSERS);

describe("readDirectory", () => {
  it("reads every declared file through its parser", () => {
    put("verdict.json", { ...VERDICT, note: "Looks close." });
    put("pr_summary.json", { summary: "It moves the guard." });

    expect(read()).toEqual({
      "verdict.json": { ...VERDICT, note: "Looks close." },
      "pr_summary.json": { summary: "It moves the guard." },
    });
  });

  it("reads a file the producer writes only sometimes as absent", () => {
    put("verdict.json", VERDICT);

    expect(read()["pr_summary.json"]).toBeUndefined();
  });

  it("reads no file the declaration does not name", () => {
    put("verdict.json", VERDICT);
    put("review_body.json", "not even JSON");

    expect(Object.keys(read())).toEqual(["verdict.json", "pr_summary.json"]);
  });

  it("fails on a file the producer always writes that is not there, naming it", () => {
    put("pr_summary.json", { summary: "It moves the guard." });

    expect(read).toThrow(`review's verdict.json is not in ${dir}, and review writes it on every outcome.`);
  });

  /**
   * One call reads the whole directory, so a bad file anywhere in it fails
   * the read, and a command that reads before writing has written nothing.
   */
  it("fails on any one malformed file, whatever the others hold", () => {
    put("verdict.json", VERDICT);
    put("pr_summary.json", "{");

    expect(read).toThrow("review's pr_summary.json is not JSON.");
  });

  it.each([
    ["an unknown choice", { ...VERDICT, verdict: "merge it" }, '`verdict` is "merge it", which is not one of'],
    ["a choice of the wrong type", { ...VERDICT, fixRound: "true" }, '`fixRound` is "true", which is not one of true, false'],
    ["a missing field", { verdict: "changes recommended", threads: [] }, "`fixRound` is missing"],
    ["a field it does not declare", { ...VERDICT, context: "agent-review" }, "has `context`, which it does not declare"],
    [
      "a target the command did not read",
      { ...VERDICT, threads: [{ threadId: "PRRT_elsewhere", path: "a.ts", line: 1 }] },
      '`threads[0].threadId` is "PRRT_elsewhere", which is not a thread on this pull request',
    ],
    ["a position out of range", { ...VERDICT, threads: [{ threadId: "PRRT_one", path: "a.ts", line: 0 }] }, "`threads[0].line` is 0"],
    ["a position that is not whole", { ...VERDICT, threads: [{ threadId: "PRRT_one", path: "a.ts", line: 1.5 }] }, "`threads[0].line` is 1.5"],
    ["a path out of the checkout", { ...VERDICT, threads: [{ threadId: "PRRT_one", path: "../x", line: 1 }] }, "`threads[0].path`"],
    ["an absolute path", { ...VERDICT, threads: [{ threadId: "PRRT_one", path: "/etc/x", line: 1 }] }, "`threads[0].path`"],
    ["a list over its count", { ...VERDICT, threads: [1, 2, 3] }, "`threads` has 3 items, more than 2"],
    ["text that is not text", { ...VERDICT, note: 3 }, "`note` is 3, where text was expected"],
    ["an array for an object", [], "is [], where an object was expected"],
  ])("fails on %s, naming the producer, the file and the field", (_case, verdict, message) => {
    put("verdict.json", verdict);

    expect(read).toThrow(/^review's verdict\.json /);
    expect(read).toThrow(message);
  });

  it("gives free text out cleaned, in the file the agent wrote and in any other", () => {
    put("verdict.json", { ...VERDICT, note: "Fine.<!-- agent-resolution -->" });
    put("pr_summary.json", { summary: "<!-- /agent:summary -->Moved." });

    const handOver = read();
    const note: Cleaned | undefined = handOver["verdict.json"].note;
    const summary: Cleaned | undefined = handOver["pr_summary.json"]?.summary;

    expect(note).toBe("Fine.");
    expect(summary).toBe("Moved.");
  });

  it("reads a whole file as text, cleaned", () => {
    const failure = readsFrom("review", { "failure_reason.txt": "sometimes" });
    put("failure_reason.txt", "It stopped.<!-- hidden -->");

    expect(readDirectory(failure, dir, { "failure_reason.txt": text })["failure_reason.txt"]).toBe("It stopped.");
  });
});

/**
 * The two parsers a hand-over's own shapes are built from beside the kinds:
 * a value of a fixed shape, and a rule between fields.
 */
describe("a shape and a rule between fields", () => {
  const ID = matching(/f-[0-9a-f]{8}/, "a finding id");
  const CLOSE = refine(
    object({ reason: choice(["ADDRESSED", "WONT_FIX"]), quote: optional(text) }),
    (value, wrong) => (value.reason === "WONT_FIX" && value.quote === undefined ? wrong("closes as WONT_FIX with nothing to quote") : value),
  );
  const shapes = readsFrom("review", { "verdict.json": "always" });
  const readWith = (parser: Parameters<typeof json>[0]) => () => readDirectory(shapes, dir, { "verdict.json": json(parser) })["verdict.json"];

  it("reads a value its pattern matches whole", () => {
    put("verdict.json", { id: "f-0123abcd" });

    expect(readWith(object({ id: ID }))()).toEqual({ id: "f-0123abcd" });
  });

  it.each([
    ["a value with more around it", "f-0123abcd -->"],
    ["a value of another shape", "PRRT_one"],
    ["a value that is not a string", 7],
  ])("fails on %s, naming the field and the shape", (_case, id) => {
    put("verdict.json", { id });

    expect(readWith(object({ id: ID }))).toThrow(/^review's verdict\.json `id` is .*, where a finding id was expected\.$/);
  });

  it("holds a value to a rule between its fields, after each field is read", () => {
    put("verdict.json", { reason: "WONT_FIX", quote: "No.<!-- x -->" });
    expect(readWith(CLOSE)()).toEqual({ reason: "WONT_FIX", quote: "No." });

    put("verdict.json", { reason: "WONT_FIX" });
    expect(readWith(CLOSE)).toThrow("review's verdict.json closes as WONT_FIX with nothing to quote.");

    put("verdict.json", { reason: "LATER" });
    expect(readWith(CLOSE)).toThrow('`reason` is "LATER", which is not one of');
  });
});

/**
 * The declaration is the type the readers are built from, as `writers` are
 * built from declared outputs. These fail typechecking, which the gate runs
 * over this file, if the type stops refusing them.
 */
describe("a directory input's types", () => {
  it("refuses a file the producer does not declare, so a renamed output is a type error", () => {
    // @ts-expect-error: `review` declares no `review_payload.md`.
    readsFrom("review", { "review_payload.md": "always" });
    // @ts-expect-error: and no `ended.json` either, though another subcommand may.
    readsFrom("review", { "verdict.json": "always", "ended.json": "always" });
  });

  it("wants a parser for every declared file, and for no other", () => {
    put("verdict.json", VERDICT);
    put("pr_summary.json", { summary: "It moves the guard." });

    // @ts-expect-error: `pr_summary.json` has no parser.
    expect(() => readDirectory(DECLARED, dir, { "verdict.json": PARSERS["verdict.json"] })).toThrow();
    // @ts-expect-error: `summary.md` is not declared.
    readDirectory(DECLARED, dir, { ...PARSERS, "summary.md": text });
  });

  it("types a file the producer writes only sometimes as possibly absent", () => {
    put("verdict.json", VERDICT);
    const handOver = read();

    // @ts-expect-error: `pr_summary.json` may be absent, and here it is.
    expect(() => handOver["pr_summary.json"].summary).toThrow(TypeError);
    expect(handOver["verdict.json"].verdict).toBe("changes recommended");
  });
});
