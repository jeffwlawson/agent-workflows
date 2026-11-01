import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVICE_APP_EVENTS, SERVICE_APP_PERMISSIONS } from "../../service/dispatcher.js";
import { TOKEN_KINDS } from "../../service/job.js";
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

// #560: what the dispatcher checks the App's own record against at start is
// the guide's Permissions table and event list, read by whoever sets up the App.
describe("the deployment guide's App permissions and events", () => {
  const app = sectionsOf(sectionsOf(GUIDE, 2).get("The GitHub App") ?? "", 3);
  // Every data row of the table, and every bolded name in the clause listing
  // the events, is kept, by its API name where it gives one and by its own
  // text where it does not: a row or an event without one fails the
  // comparison rather than being dropped before it, and a repeated one is
  // kept twice rather than collapsed.
  const permissions = ((app.get("Permissions") ?? "").match(/^\|.*\|$(?:\n^\|.*\|$)*/m)?.[0] ?? "")
    .split("\n")
    .slice(2)
    .map((row) => {
      const [label = "", api = "", access = ""] = row
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      return [/^`([^`]+)`$/.exec(api)?.[1] ?? `${label} (no API name: "${api}")`, access] as const;
    });
  const events = [...(/under \*Subscribe to events\*,([^.]*)\./.exec(app.get("The webhook") ?? "")?.[1] ?? "").matchAll(/\*\*([^*]+)\*\*(?: \(`([^`]+)`\))?/g)].map(
    (match) => match[2] ?? `${match[1]} (no API name)`,
  );

  it("finds the table and the list", () => {
    expect(permissions.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
  });

  it("lists every permission the service needs, by its API name, and no other, each at the access needed", () => {
    expect([...permissions].sort()).toEqual(Object.entries(SERVICE_APP_PERMISSIONS).sort());
  });

  it("lists every event the service needs, and no other", () => {
    expect([...events].sort()).toEqual([...SERVICE_APP_EVENTS].sort());
  });

  // #571: the paragraph under the table names each kind of token the worker
  // asks for, in the order the code declares them.
  it("names every token kind the code declares, and no other, in the paragraph on the kinds", () => {
    const paragraph = /^The worker asks for one of (\w+) kinds of token at each phase:([\s\S]*?)\n\n/m.exec(app.get("Permissions") ?? "");
    const named = [...(paragraph?.[2] ?? "").matchAll(/(?:^|; (?:and )?)\s*`([a-z]+)`, which/g)].map((match) => match[1]);
    expect(named).toEqual([...TOKEN_KINDS]);
    expect(paragraph?.[1]).toBe(["one", "two", "three", "four", "five"][TOKEN_KINDS.length - 1]);
  });
});
