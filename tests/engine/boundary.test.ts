/**
 * ADR 0002's line, held by a test rather than by care: nothing under `engine/`
 * loads the loop, so moving the engine to a repository of its own stays a
 * mechanical change. npm packages and Node's built-ins are allowed; a relative
 * import that resolves outside `engine/` is not, type-only or not, since a
 * type the engine borrows from the loop is still a dependency on it.
 *
 * And ADR 0005's two conditions on the engine's code: it reads no environment
 * (it is handed its token), and it holds no record string (the loop hands in
 * its markers, contexts and labels).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as record from "../../shared/record.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ENGINE = "engine";

const modules = fs
  .readdirSync(path.join(ROOT, ENGINE), { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".ts"))
  .map((name) => path.posix.join(ENGINE, name.split(path.sep).join("/")));

const parse = (rel: string, text: string): ts.SourceFile => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
const source = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Every module specifier `text` names, in an import, a re-export or a dynamic import. */
const specifiers = (rel: string, text: string): string[] => {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(rel, text));
  return found;
};

/** The relative imports in `text`, the module at `rel`, that resolve outside `engine/`. */
const escapes = (rel: string, text: string): string[] =>
  specifiers(rel, text)
    .filter((s) => s.startsWith("."))
    .filter((s) => !path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)).startsWith(`${ENGINE}/`))
    .map((s) => `${rel}: ${s}`);

/** The text of every string literal and template piece in code, not comments. */
const literals = (rel: string, text: string): string[] => {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(rel, text));
  return found;
};

/**
 * Every string `shared/record.ts` spells, the fix round's status included but
 * for its `state`: `success` is GitHub's word, which the engine's commit
 * status type spells too.
 */
const RECORD_STRINGS = Object.values(record).flatMap((value) =>
  typeof value === "string"
    ? [value]
    : typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, v]) => (key !== "state" && typeof v === "string" ? [v] : []))
      : [],
);

describe("the engine imports nothing from the loop", () => {
  it("walks every module under engine/, the writer among them", () => {
    expect(modules).toContain("engine/writer.ts");
    expect(modules).toContain("engine/splice.ts");
  });

  it.each(modules)("%s: no relative import resolves outside engine/", (rel) => {
    expect(escapes(rel, source(rel))).toEqual([]);
  });

  it("finds an escape however it is written, and allows packages, built-ins and engine modules", () => {
    const text = [
      'import * as fs from "node:fs";',
      'import ts from "typescript";',
      'import { a } from "./writer.js";',
      'import { b } from "./sub/../read.js";',
      'import type { C } from "../shared/record.js";',
      'export { d } from "../shared/env.js";',
      'const lazy = () => import("../review/review.js");',
      'type E = import("./../cli.js").E;',
      'import { f } from "./../engine/github.js";',
    ].join("\n");

    expect(escapes("engine/x.ts", text)).toEqual([
      "engine/x.ts: ../shared/record.js",
      "engine/x.ts: ../shared/env.js",
      "engine/x.ts: ../review/review.js",
      "engine/x.ts: ./../cli.js",
    ]);
  });
});

describe("the engine reads no environment and holds no record string", () => {
  it.each(modules)("%s: names no process.env", (rel) => {
    expect(source(rel)).not.toMatch(/\bprocess\s*(\.\s*env\b|\[\s*["'`]env)/);
  });

  it("knows the record strings it checks for", () => {
    expect(RECORD_STRINGS).toContain(record.STATUS_START);
    expect(RECORD_STRINGS).toContain(record.FIX_LABEL);
    expect(RECORD_STRINGS).toContain(record.FIX_ROUND_STATUS.context);
  });

  it.each(modules)("%s: spells none of the loop's record strings", (rel) => {
    const spelled = literals(rel, source(rel)).filter((literal) => RECORD_STRINGS.some((string) => literal.includes(string)));

    expect(spelled).toEqual([]);
  });

  it("finds a record string in code, and not in a comment", () => {
    const text = [`// ${record.REVIEW_LABEL}`, `const label = "${record.REVIEW_LABEL}";`, `const block = \`${record.STATUS_START}\${x}\`;`].join("\n");

    expect(literals("engine/x.ts", text).filter((l) => RECORD_STRINGS.some((s) => l.includes(s)))).toEqual([
      record.REVIEW_LABEL,
      record.STATUS_START,
    ]);
  });
});
