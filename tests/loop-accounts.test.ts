import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isWorkflowBot, loopAccounts } from "../shared/loop-accounts.js";
import { DEFAULT_LOOP_ACCOUNT } from "../shared/record.js";

/**
 * The loop's accounts (#376): the one set every runner and command asks
 * whether something was posted by the loop, built from `AGENT_LOOP_LOGINS`
 * and the default.
 */
describe("loopAccounts", () => {
  it("is the default alone, in both spellings, with the list unset", () => {
    const accounts = loopAccounts("");

    expect(isWorkflowBot("github-actions[bot]", accounts)).toBe(true);
    expect(isWorkflowBot("github-actions", accounts)).toBe(true);
    expect(isWorkflowBot("my-loop[bot]", accounts)).toBe(false);
    expect(isWorkflowBot(undefined, accounts)).toBe(false);
    expect(isWorkflowBot("", accounts)).toBe(false);
  });

  /** REST reports an App as `<slug>[bot]` and GraphQL as `<slug>`: one entry, either way, matches both. */
  it.each(["my-loop[bot]", "my-loop"])("recognises both spellings of a listed account given as %j", (entry) => {
    const accounts = loopAccounts(entry);

    expect(isWorkflowBot("my-loop[bot]", accounts)).toBe(true);
    expect(isWorkflowBot("my-loop", accounts)).toBe(true);
  });

  it("always keeps the default beside the accounts passed in", () => {
    const accounts = loopAccounts("my-loop[bot],other-loop");

    expect(isWorkflowBot("github-actions[bot]", accounts)).toBe(true);
    expect(isWorkflowBot("github-actions", accounts)).toBe(true);
    expect(isWorkflowBot("other-loop[bot]", accounts)).toBe(true);
    expect(isWorkflowBot("someone-else", accounts)).toBe(false);
  });

  it("ignores an empty entry and the spaces around one", () => {
    const accounts = loopAccounts(" my-loop[bot] , ,other-loop,");

    expect(isWorkflowBot("my-loop", accounts)).toBe(true);
    expect(isWorkflowBot("other-loop", accounts)).toBe(true);
    expect(isWorkflowBot("", accounts)).toBe(false);
  });

  /** GitHub logins are unique without regard to case, and the API returns one spelling of it. */
  it("matches without regard to case", () => {
    expect(isWorkflowBot("My-Loop[bot]", loopAccounts("my-loop"))).toBe(true);
    expect(isWorkflowBot("my-loop", loopAccounts("MY-LOOP[bot]"))).toBe(true);
  });

  /** Required or loud (#60, decision 5): a list the orchestrator got wrong fails, naming the entry. */
  it.each(["my loop", "my-loop[bot", "@my-loop", "my/loop", "-my-loop", "my-loop[bot][bot]"])(
    "throws, naming it, on %j",
    (entry) => {
      expect(() => loopAccounts(`other-loop,${entry}`)).toThrow(
        `\`AGENT_LOOP_LOGINS\` holds \`${entry.trim()}\`, which is not a GitHub login.`,
      );
    },
  );
});

/**
 * What ships: every TypeScript file `tsconfig.build.json` emits. Read off the
 * tree rather than off the config's `exclude`, and held to it by naming the
 * same exclusions.
 */
const shipped = (): string[] => {
  const out: string[] = [];
  const skip = new Set(["node_modules", "dist", "tests", ".git"]);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path.relative(".", full).split(path.sep).join("/"));
    }
  };
  walk(".");
  return out.filter((file) => !["vitest.config.ts", "scripts/sync-version.ts", "scripts/bundled-tree.ts"].includes(file));
};

/** Every string literal and template piece in `text`, comments left out. */
const literalsIn = (name: string, text: string): string[] => {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const literals = (file: string): string[] => literalsIn(file, fs.readFileSync(file, "utf8"));

/**
 * No runner or command hard-codes the loop's account again (#376). The login
 * is spelled once, in `shared/record.ts`, and read everywhere through
 * `loopAccounts`, so an orchestrator posting as its own App is recognised at
 * every site, not at all of them but one. Prose may name it: a comment is not
 * read, so only a string literal counts.
 */
describe("the loop's account is written once", () => {
  const LOGIN = /^github-actions(?:\[bot\])?$/;
  const offending = (text: string): boolean => LOGIN.test(text.trim()) || text.includes("github-actions[bot]");

  it("is defined in shared/record.ts", () => {
    expect(DEFAULT_LOOP_ACCOUNT).toBe("github-actions[bot]");
    expect(literals("shared/record.ts").filter(offending)).toEqual(["github-actions[bot]"]);
  });

  it("is written as a string nowhere else in shipped code", () => {
    const files = shipped();
    expect(files).toContain("shared/loop-accounts.ts");
    expect(files).toContain("review/gate.ts");

    const written = files
      .filter((file) => file !== "shared/record.ts")
      .flatMap((file) => literals(file).filter(offending).map((text) => `${file}: ${JSON.stringify(text)}`));

    expect(written).toEqual([]);
  });

  it("would catch either spelling written as a string", () => {
    const probe = (text: string): string[] => literalsIn("probe.ts", text).filter(offending);

    expect(probe('const LOOP_ACCOUNT = "github-actions[bot]";')).toHaveLength(1);
    expect(probe("const login = 'github-actions';")).toHaveLength(1);
    expect(probe("const both = `${prefix}github-actions[bot]`;")).toHaveLength(1);
    expect(probe("// posted as `github-actions[bot]`, in prose\nconst x = 1;")).toEqual([]);
  });
});
