import * as fs from "node:fs";
import * as path from "node:path";
import { clean, type Cleaned } from "./clean.js";
import type { DirectoryFiles, DirectoryInput } from "./contract.js";

/**
 * The readers a command reads another subcommand's files through (ADR 0004,
 * ADR 0006, #403): the mirror of `writers` in `shared/env.ts`. `writers` takes
 * a subcommand's declared outputs and writes no other name; `readDirectory`
 * takes a command's declared directory input and reads no other name, and
 * wants a parser for each one it declares.
 *
 * Every declared file is read and parsed in the one call, so a command that
 * makes it before its first write has checked its whole hand-over before it
 * changes anything. A failure throws a sentence naming the producer, the file
 * and the field, which the CLI turns into `fail()`.
 *
 * Parsing is strict. A JSON object carries the fields its parser names and no
 * others, and each field that is not free text is one of three kinds:
 *
 * - a **target**, an id a write acts on, which has to be one of the ids the
 *   command read for itself (`target`);
 * - a **choice**, which has to be one of a fixed set (`choice`);
 * - a **count or position**, which has to be in range and of its shape
 *   (`count`, `filePath`, `matching`).
 *
 * Free text comes out only as `Cleaned` (`text`), whoever wrote it.
 */

/**
 * A value read from a file, at `at` (`findings[2].line`, or `""` for the
 * whole file), to what the command reads it as. Throws `Malformed` where it
 * is not that.
 */
export type Parser<T> = (value: unknown, at: string) => T;

/** A value that is not what its parser reads. Rewrapped with the file it was in. */
class Malformed extends Error {
  constructor(
    readonly at: string,
    what: string,
  ) {
    super(what);
  }
}

const shown = (value: unknown): string => (value === undefined ? "missing" : JSON.stringify(value));

const fieldOf = (at: string, key: string): string => (at === "" ? key : `${at}.${key}`);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Free text, cleaned (`shared/clean.ts`). The only way text leaves a reader,
 * so a formatter handed a reader's output is handed cleaned text.
 */
export const text: Parser<Cleaned> = (value, at) => {
  if (typeof value !== "string") throw new Malformed(at, `is ${shown(value)}, where text was expected`);
  return clean(value);
};

/**
 * A choice: one of `choices`, compared exactly. A field that starts or
 * decides something is read this way, so a value the command does not know
 * stops it rather than passing through.
 */
export const choice =
  <const C extends readonly (string | number | boolean)[]>(choices: C): Parser<C[number]> =>
  (value, at) => {
    const found = choices.find((c) => c === value);
    if (found === undefined) {
      throw new Malformed(at, `is ${shown(value)}, which is not one of ${choices.map((c) => JSON.stringify(c)).join(", ")}`);
    }
    return found;
  };

/** A count or a position: a whole number from `min` to `max`, both included. */
export const count =
  (range: { readonly min: number; readonly max: number }): Parser<number> =>
  (value, at) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < range.min || value > range.max) {
      throw new Malformed(at, `is ${shown(value)}, where a whole number from ${range.min} to ${range.max} was expected`);
    }
    return value;
  };

/**
 * A position in the checkout: a relative path, `/`-separated, with no empty,
 * `.` or `..` segment and no control character. Shape only: whether the file
 * is in the diff is GitHub's to refuse.
 */
export const filePath: Parser<string> = (value, at) => {
  const ok =
    typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f\\]/.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!ok) throw new Malformed(at, `is ${shown(value)}, where a relative path in the checkout was expected`);
  return value;
};

/**
 * A value of a fixed shape: a string `pattern` matches whole, such as an id
 * a marker carries or a link. Shape only, like `filePath`: a pattern that
 * refuses `<`, `>` and whitespace is one no value can close a comment with.
 */
export const matching =
  (pattern: RegExp, what: string): Parser<string> =>
  (value, at) => {
    if (typeof value !== "string" || !new RegExp(`^(?:${pattern.source})$`, pattern.flags).test(value)) {
      throw new Malformed(at, `is ${shown(value)}, where ${what} was expected`);
    }
    return value;
  };

/**
 * A target: an id a write acts on, which has to be one of `known`, the ids
 * the command read from GitHub itself (a thread on this pull request, this
 * pull request's node id). So a hand-over cannot aim a write anywhere the
 * command did not already find.
 */
export const target =
  (known: ReadonlySet<string>, what: string): Parser<string> =>
  (value, at) => {
    if (typeof value !== "string" || !known.has(value)) throw new Malformed(at, `is ${shown(value)}, which is not ${what}`);
    return value;
  };

/** A field that may be left out, read as `undefined` where it is. Present, it is read by `parser`. */
export const optional =
  <T>(parser: Parser<T>): Parser<T | undefined> =>
  (value, at) =>
    value === undefined ? undefined : parser(value, at);

/**
 * A value read by `parser`, then by `read`, for a rule between its fields that
 * no one field's parser can see: which fields one choice requires. `read`
 * returns the value as the command reads it, narrowed to the case it is, or
 * calls `wrong` with what is wrong with it.
 */
export const refine =
  <T, U>(parser: Parser<T>, read: (value: T, wrong: (what: string) => never) => U): Parser<U> =>
  (value, at) =>
    read(parser(value, at), (what) => {
      throw new Malformed(at, what);
    });

type Shape = Readonly<Record<string, Parser<unknown>>>;

type ParsedField<P> = P extends Parser<infer T> ? T : never;

/** The fields of a shape that may be left out: those whose parser can read `undefined`. */
type OptionalField<S extends Shape> = { [K in keyof S]: undefined extends ParsedField<S[K]> ? K : never }[keyof S];

/**
 * What a shape reads as: each field, as its parser reads it, and a field that
 * may be left out an optional property, since `object` leaves it out where it
 * was.
 */
export type Parsed<S extends Shape> = {
  readonly [K in Exclude<keyof S, OptionalField<S>>]: ParsedField<S[K]>;
} & { readonly [K in OptionalField<S>]?: Exclude<ParsedField<S[K]>, undefined> };

/**
 * A JSON object with the fields `shape` names, each read by its parser, and no
 * other field. A field read as `undefined` is left out, so a value read here
 * is one an optional property can hold under `exactOptionalPropertyTypes`.
 */
export const object =
  <S extends Shape>(shape: S): Parser<Parsed<S>> =>
  (value, at) => {
    if (!isRecord(value)) throw new Malformed(at, `is ${shown(value)}, where an object was expected`);
    const undeclared = Object.keys(value).filter((key) => !Object.hasOwn(shape, key));
    if (undeclared.length > 0) {
      throw new Malformed(at, `has ${undeclared.map((key) => `\`${key}\``).join(", ")}, which it does not declare`);
    }
    return Object.fromEntries(
      Object.entries(shape).flatMap(([key, parser]) => {
        const read = parser(value[key], fieldOf(at, key));
        return read === undefined ? [] : [[key, read]];
      }),
    ) as Parsed<S>;
  };

/** A JSON array of at most `max` items, each read by `item`. */
export const list =
  <T>(item: Parser<T>, range: { readonly max: number }): Parser<readonly T[]> =>
  (value, at) => {
    if (!Array.isArray(value)) throw new Malformed(at, `is ${shown(value)}, where a list was expected`);
    if (value.length > range.max) throw new Malformed(at, `has ${value.length} items, more than ${range.max}`);
    return value.map((entry, index) => item(entry, `${at}[${index}]`));
  };

/**
 * A file read as JSON, then by `parser`. The file is the reader's input as a
 * string; `text` alone reads a file that is free text.
 */
export const json =
  <T>(parser: Parser<T>): Parser<T> =>
  (value, at) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(value));
    } catch {
      throw new Malformed(at, "is not JSON");
    }
    return parser(parsed, at);
  };

/** A parser for each file a directory input declares, and for no other name. */
export type FileParsers<F extends DirectoryFiles> = { readonly [K in keyof F]: Parser<unknown> };

/**
 * What `readDirectory` gives out: each declared file as its parser reads it,
 * or `undefined` for a file the producer writes only sometimes and did not.
 */
export type HandOver<F extends DirectoryFiles, P extends FileParsers<F>> = {
  readonly [K in keyof F]: P[K] extends Parser<infer T> ? (F[K] extends "sometimes" ? T | undefined : T) : never;
};

/**
 * Every file `declared` names, read from `dir` and parsed, at once. A file the
 * producer always writes that is not there, or any file its parser refuses,
 * throws a sentence naming it. Call it before the first write, so that no
 * write is reachable from an unchecked file.
 */
export const readDirectory = <F extends DirectoryFiles, const P extends FileParsers<F>>(
  declared: DirectoryInput<F>,
  dir: string,
  parsers: P & Readonly<Record<Exclude<keyof P, keyof F>, never>>,
): HandOver<F, P> =>
  Object.fromEntries(
    Object.entries(declared.files).map(([name, presence]) => {
      const where = `${declared.producer}'s ${name}`;
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        if (presence === "sometimes") return [name, undefined];
        throw new Error(
          `${where} is not in ${dir}, and ${declared.producer} writes it on every outcome. ` +
            "Check that the step handing it over ran and succeeded.",
        );
      }
      const parser = parsers[name as keyof F] as Parser<unknown>;
      try {
        return [name, parser(fs.readFileSync(file, "utf8"), "")];
      } catch (error) {
        if (!(error instanceof Malformed)) throw error;
        throw new Error(`${where}${error.at === "" ? "" : ` \`${error.at}\``} ${error.message}.`);
      }
    }),
  ) as HandOver<F, P>;
