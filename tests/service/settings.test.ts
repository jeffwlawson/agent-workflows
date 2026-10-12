import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DISPATCHER, WORKER } from "../../service/settings.js";
import type { Inputs } from "../../shared/contract.js";

/**
 * The deployment guide's settings tables are the declarations in
 * `service/settings.ts` read a second time, by whoever deploys the service:
 * held equal here, on name and on required or optional, in both directions,
 * the way `tests/platform-spec.test.ts` holds the runners' tables.
 */

const GUIDE = fs.readFileSync(path.join("docs", "deploying-the-service.md"), "utf8");

/** The text under each heading of `level`, keyed by the heading's own text. */
const sectionsOf = (text: string, level: number): ReadonlyMap<string, string> => {
  const marker = `${"#".repeat(level)} `;
  return new Map(
    text
      .split(new RegExp(`^(?=${marker})`, "m"))
      .filter((section) => section.startsWith(marker))
      .map((section) => {
        const [heading = "", ...body] = section.split("\n");
        return [heading.slice(marker.length).trim(), body.join("\n")];
      }),
  );
};

/** The first table in `text`, as its backticked first column to its second. */
const rowsOf = (text: string): ReadonlyMap<string, string> =>
  new Map(
    (text.match(/^\|.*\|$(?:\n^\|.*\|$)*/m)?.[0] ?? "").split("\n").flatMap((row) => {
      const [first = "", second = ""] = row
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      const name = /^`([^`]+)`$/.exec(first)?.[1];
      return name === undefined ? [] : [[name, second] as const];
    }),
  );

const kindOf = (settings: Inputs): ReadonlyMap<string, string> =>
  new Map(Object.entries(settings).map(([name, setting]) => [name, setting.required ? "required" : "optional"]));

describe("the deployment guide's dispatcher settings", () => {
  const table = rowsOf(sectionsOf(sectionsOf(GUIDE, 2).get("The dispatcher") ?? "", 3).get("Settings") ?? "");

  it("finds the table", () => {
    expect(table.size).toBeGreaterThan(0);
  });

  it("lists every setting the dispatcher declares, and no other, each as required or optional as declared", () => {
    expect(new Map([...table].sort())).toEqual(new Map([...kindOf(DISPATCHER)].sort()));
  });
});

describe("the deployment guide's worker settings", () => {
  const table = rowsOf(sectionsOf(sectionsOf(GUIDE, 2).get("The worker") ?? "", 3).get("Settings") ?? "");

  it("finds the table", () => {
    expect(table.size).toBeGreaterThan(0);
  });

  it("lists every setting the worker declares, and no other, each as required or optional as declared", () => {
    expect(new Map([...table].sort())).toEqual(new Map([...kindOf(WORKER)].sort()));
  });
});
