import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  COMMANDS,
  EVERY_SUBCOMMAND,
  EVERY_SUBCOMMAND_OUTPUTS,
  TOKENLESS,
  isDirectoryInput,
  readsFrom,
  RUNNERS,
  type Command,
  type DirectoryInput,
  type Inputs,
  type Runner,
} from "../shared/contract.js";

/**
 * The one place `docs/platform-spec.md` meets the code (PRD #375). The spec's
 * tables are the declarations in `shared/contract.ts` read a second time, by
 * a human building an orchestrator; this holds the two equal, on name and on
 * required or optional, in both directions. Defaults and meanings are prose,
 * and nothing here compares them.
 *
 * It also holds the spec's marking of binding text apart from description,
 * and the Actions reusables to the inputs their runners cannot run without.
 */

const SPEC = fs.readFileSync(path.join("docs", "platform-spec.md"), "utf8");

const RUNNER_NAMES = Object.keys(RUNNERS) as Runner[];
const COMMAND_NAMES = Object.keys(COMMANDS) as Command[];

/** A command's workflow, the part of `<workflow>:<step>` before the colon. */
const workflowOf = (command: Command): string => command.slice(0, command.indexOf(":"));

/** A subcommand's declaration, runner or command. */
const declarationOf = (subcommand: Runner | Command) =>
  subcommand in RUNNERS ? RUNNERS[subcommand as Runner] : COMMANDS[subcommand as Command];

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

/** The section whose heading starts `prefix`, or `""` where there is none. */
const sectionStarting = (sections: ReadonlyMap<string, string>, prefix: string): string =>
  [...sections].find(([heading]) => heading.startsWith(prefix))?.[1] ?? "";

/** Each table in `text`: its rows' cells, header and separator included. */
const tablesIn = (text: string): readonly (readonly (readonly string[])[])[] =>
  (text.match(/^\|.*\|$(?:\n^\|.*\|$)*/gm) ?? []).map((table) =>
    table.split("\n").map((row) =>
      row
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    ),
  );

/**
 * A table's rows keyed on the backticked first column, to their second
 * column. A row whose first cell is not one backticked name, the header and
 * the separator included, is not a row of the contract.
 */
const rowsOf = (table: readonly (readonly string[])[] | undefined): ReadonlyMap<string, string> =>
  new Map(
    (table ?? []).flatMap(([first = "", second = ""]) => {
      const name = /^`([^`]+)`$/.exec(first)?.[1];
      return name === undefined ? [] : [[name, second] as const];
    }),
  );

const PROCESS = sectionsOf(sectionStarting(sectionsOf(SPEC, 2), "2. "), 3);

/** §2.2's "every subcommand" table, name to `required` or `optional`. */
const everyRunnerInputs = (): ReadonlyMap<string, string> => rowsOf(tablesIn(sectionStarting(PROCESS, "2.2 "))[0]);

/** §2.4's common outputs table: its first, ahead of the exit codes. */
const everyRunnerOutputs = (): readonly string[] => [...rowsOf(tablesIn(sectionStarting(PROCESS, "2.4 "))[0]).keys()];

/**
 * A workflow's own section, `## <n>. \`<workflow>\``: its runner's, where it
 * has one, and its commands'.
 */
const workflowSection = (workflow: string): string =>
  [...sectionsOf(SPEC, 2)].find(([heading]) => new RegExp(`^\\d+\\. \`${workflow}\`$`).test(heading))?.[1] ?? "";

/** A runner's section is its workflow's, which is named after it. */
const runnerSection = workflowSection;

/** A command's section, `### \`<workflow>:<step>\``, inside its workflow's. */
const commandSection = (command: Command): string =>
  sectionsOf(workflowSection(workflowOf(command)), 3).get(`\`${command}\``) ?? "";

/**
 * A subcommand's `Inputs` or `Outputs` table: a runner's at `###` in its
 * workflow's section, and a command's at `####` in its own.
 */
const tableOf = (subcommand: Runner | Command, heading: "Inputs" | "Outputs") =>
  subcommand in RUNNERS
    ? tablesIn(sectionsOf(runnerSection(subcommand), 3).get(heading) ?? "")[0]
    : tablesIn(sectionsOf(commandSection(subcommand as Command), 4).get(heading) ?? "")[0];

/** An input's Kind column: `directory` for a directory input, else `required` or `optional`. */
const kindOf = (inputs: Inputs): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(inputs).map(([name, input]) => [
      name,
      isDirectoryInput(input) ? "directory" : input.required ? "required" : "optional",
    ]),
  );

/** A table's rows keyed on the backticked first column, to the whole row. */
const fullRowsOf = (table: readonly (readonly string[])[] | undefined): ReadonlyMap<string, readonly string[]> =>
  new Map(
    (table ?? []).flatMap((row) => {
      const name = /^`([^`]+)`$/.exec(row[0] ?? "")?.[1];
      return name === undefined ? [] : [[name, row] as const];
    }),
  );

/**
 * Whether a directory input's row says what its declaration does: the row's
 * last cell names the producer, and the producer's outputs it names are the
 * declared files, each marked "where written" exactly when the producer writes
 * it only sometimes. Each disagreement comes back as a sentence.
 */
const directoryRowDrift = (row: readonly string[], declared: DirectoryInput, producerOutputs: readonly string[]): readonly string[] => {
  const cell = row[row.length - 1] ?? "";
  const named = [...cell.matchAll(/`([^`]+)`( \(where written\))?/g)];
  const files = new Map(
    named.filter(([, name]) => producerOutputs.includes(name ?? "")).map(([, name, sometimes]) => [name ?? "", sometimes ? "sometimes" : "always"]),
  );
  return [
    ...(named.some(([, name]) => name === declared.producer) ? [] : [`does not name its producer, \`${declared.producer}\``]),
    ...Object.entries(declared.files)
      .filter(([file, presence]) => files.get(file) !== presence)
      .map(([file, presence]) => `does not name \`${file}\`${presence === "sometimes" ? " (where written)" : ""}`),
    ...[...files.keys()].filter((file) => !(file in declared.files)).map((file) => `names \`${file}\`, which is not declared`),
  ];
};

/** A producer's declared outputs, runner or command. */
const outputsOf = (producer: string): readonly string[] =>
  producer in RUNNERS ? RUNNERS[producer as Runner].outputs : producer in COMMANDS ? COMMANDS[producer as Command].outputs : [];

const sorted = <T>(map: ReadonlyMap<string, T>): [string, T][] => [...map].sort(([a], [b]) => a.localeCompare(b));

describe("the spec's structure", () => {
  /**
   * Every comparison below reads a table found by its heading, and a table
   * that is not found compares as empty. So a restructured spec would pass
   * the equality checks by comparing nothing; this is what stops it.
   */
  it.each(RUNNER_NAMES)("has a section for %s, with its trigger label, both tables and what it reads from the record", (runner) => {
    const section = runnerSection(runner);

    expect(section).toMatch(/^Trigger label: `agent:[a-z-]+`/m);
    expect(tableOf(runner, "Inputs")?.[0]?.[0]).toBe("Input");
    expect(tableOf(runner, "Outputs")?.[0]?.[0]).toBe("Output");
    expect(sectionsOf(section, 3).has("What it reads from the record")).toBe(true);
    expect(section).toMatch(/^> \*\*Actions orchestrator:\*\*/m);
  });

  /**
   * A command sits in its workflow's section, after the runner where the
   * workflow has one (ADR 0004), under a heading of its own with both tables
   * beneath it.
   */
  it.each(COMMAND_NAMES)("has a section for %s in its workflow's, with both tables", (command) => {
    const section = commandSection(command);

    expect(workflowSection(workflowOf(command))).toMatch(/^Trigger label: `agent:[a-z-]+`/m);
    expect(tableOf(command, "Inputs")?.[0]?.[0]).toBe("Input");
    expect(tableOf(command, "Outputs")?.[0]?.[0]).toBe("Output");
    expect(section).toMatch(/^> \*\*Actions orchestrator:\*\*/m);
  });

  it("has a section for no workflow the contract lacks", () => {
    const sections = [...sectionsOf(SPEC, 2).keys()].flatMap((heading) => /^\d+\. `([^`]+)`$/.exec(heading)?.[1] ?? []);
    const workflows = new Set([...RUNNER_NAMES, ...COMMAND_NAMES.map(workflowOf)]);
    expect([...sections].sort()).toEqual([...workflows].sort());
  });

  it("has a section for no command the contract lacks", () => {
    const sections = [...sectionsOf(SPEC, 2).values()].flatMap((section) =>
      [...sectionsOf(section, 3).keys()].flatMap((heading) => /^`([a-z-]+:[a-z-]+)`$/.exec(heading)?.[1] ?? []),
    );
    expect([...sections].sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it("has the reading guide, the terms, the process boundary, safety, the record and the version rule", () => {
    const top = [...sectionsOf(SPEC, 2).keys()];
    for (const prefix of ["0. ", "1. ", "2. ", "3. ", "4. ", "5. "]) {
      expect(top.some((heading) => heading.startsWith(prefix))).toBe(true);
    }
    for (const prefix of ["2.1 ", "2.2 ", "2.3 ", "2.4 ", "2.5 "]) {
      expect(sectionStarting(PROCESS, prefix)).not.toBe("");
    }
    const record = sectionsOf(sectionStarting(sectionsOf(SPEC, 2), "4. "), 3);
    for (const prefix of ["4.1 ", "4.2 ", "4.3 "]) {
      expect(sectionStarting(record, prefix)).not.toBe("");
    }
    expect(everyRunnerInputs().size).toBeGreaterThan(0);
    expect(everyRunnerOutputs().length).toBeGreaterThan(0);
  });
});

describe("the spec's tables equal the declarations", () => {
  it("§2.2's table is the inputs every subcommand reads", () => {
    expect(sorted(everyRunnerInputs())).toEqual(sorted(kindOf(EVERY_SUBCOMMAND)));
  });

  it("§2.4's table carries failure_reason.txt, the file every subcommand writes", () => {
    expect(everyRunnerOutputs()).toEqual([...EVERY_SUBCOMMAND_OUTPUTS]);
  });

  /**
   * §2.2's table plus the subcommand's own make its input set. A name in one
   * of the subcommand's tables and §2.2's both is refused rather than merged:
   * it would be two rows for one input, free to disagree.
   */
  it.each([...RUNNER_NAMES, ...COMMAND_NAMES])("%s: the inputs, by name and kind, both ways", (subcommand) => {
    const own = rowsOf(tableOf(subcommand, "Inputs"));
    const all = everyRunnerInputs();
    // A command that holds no token reads `TOKENLESS` of §2.2's, which §2.2
    // says, and only a command may.
    const tokenless = !("GH_TOKEN" in declarationOf(subcommand).inputs);
    const every = tokenless ? new Map([...all].filter(([name]) => name in TOKENLESS)) : all;

    if (tokenless) expect(subcommand in COMMANDS).toBe(true);

    expect([...own.keys()].filter((name) => every.has(name))).toEqual([]);
    expect(sorted(new Map([...every, ...own]))).toEqual(sorted(kindOf(declarationOf(subcommand).inputs)));
  });

  /**
   * A directory input's row names the producer and the files read from it,
   * so an orchestrator reading the spec knows which outputs to keep. One
   * loop over every directory input rather than a case each, since there
   * may be none.
   */
  it("each directory input's row names its producer and exactly its files", () => {
    for (const subcommand of [...RUNNER_NAMES, ...COMMAND_NAMES]) {
      const rows = fullRowsOf(tableOf(subcommand, "Inputs"));
      for (const [name, input] of Object.entries(declarationOf(subcommand).inputs as Inputs)) {
        if (!isDirectoryInput(input)) continue;
        expect(outputsOf(input.producer), `${subcommand}'s ${name}: no such producer`).not.toEqual([]);
        expect(directoryRowDrift(rows.get(name) ?? [], input, outputsOf(input.producer)), `${subcommand}'s ${name}`).toEqual([]);
      }
    }
  });

  /** The row's own rules, on a table of its own, so the check above is reading something. */
  it("accepts a directory input row, and names what one leaves out", () => {
    const declared = readsFrom("review", { "verdict.json": "always", "pr_summary.json": "sometimes" });
    const table = tablesIn(
      [
        "| Input | Kind | Default | What it is |",
        "|---|---|---|---|",
        "| `REVIEW_DIR` | directory | | The `review` runner's `OUTPUT_DIR`. Reads `verdict.json`, and `pr_summary.json` (where written). |",
        "| `PARTIAL_DIR` | directory | | Reads `verdict.json` (where written) and `findings.json`. |",
      ].join("\n"),
    )[0];
    const outputs = outputsOf("review");

    expect(sorted(rowsOf(table))).toEqual(sorted(kindOf({ REVIEW_DIR: declared, PARTIAL_DIR: declared })));
    expect(directoryRowDrift(fullRowsOf(table).get("REVIEW_DIR") ?? [], declared, outputs)).toEqual([]);
    expect(directoryRowDrift(fullRowsOf(table).get("PARTIAL_DIR") ?? [], declared, outputs)).toEqual([
      "does not name its producer, `review`",
      "does not name `verdict.json`",
      "does not name `pr_summary.json` (where written)",
      "names `findings.json`, which is not declared",
    ]);
  });

  it.each([...RUNNER_NAMES, ...COMMAND_NAMES])("%s: the output files, both ways", (subcommand) => {
    const own = [...rowsOf(tableOf(subcommand, "Outputs")).keys()];
    const every = everyRunnerOutputs();

    expect(own.filter((name) => every.includes(name))).toEqual([]);
    expect([...every, ...own].sort()).toEqual([...declarationOf(subcommand).outputs].sort());
  });
});

/** Where a quoted prompt or command may say "must" without binding anyone. */
const withoutCode = (text: string): string => text.replace(/^```[\s\S]*?^```$/gm, "").replace(/(`+)[^`]*?\1/g, "");

const ORCHESTRATOR_BLOCK = /^> \*\*(?:Actions|Service) orchestrator:\*\*/;

/**
 * Every "must" the spec says outside the one place it may: as bold
 * `***must***` or `***must not***`, outside an orchestrator block. Each is
 * returned as its line, for the failure to name.
 *
 * An orchestrator block is a quote whose first line names its orchestrator,
 * and runs to the end of the quote. Case is ignored, and "mustn't" is a must.
 */
const strayMusts = (markdown: string): readonly string[] => {
  const found: string[] = [];
  let inBlock = false;
  for (const line of withoutCode(markdown).split("\n")) {
    inBlock = line.startsWith(">") && (inBlock || ORCHESTRATOR_BLOCK.test(line));
    const rest = inBlock ? line : line.replace(/\*\*\*must(?: not)?\*\*\*/gi, "");
    if (/\bmust/i.test(rest)) found.push(line);
  }
  return found;
};

describe("only binding sentences say must", () => {
  it("says no plain must, and none inside an orchestrator block", () => {
    expect(strayMusts(SPEC)).toEqual([]);
  });

  it("binds somewhere, so the lint above is reading the spec", () => {
    expect(SPEC).toMatch(/\*\*\*must\*\*\*/);
  });

  /**
   * §2.5's one vendor rule: the only binding sentence about the agent's CLI.
   * Its version, and how it gets there, is each orchestrator's to describe.
   */
  it("binds one vendor precondition in §2.5: claude on PATH", () => {
    const binding = withoutCode(sectionStarting(PROCESS, "2.5 ").replace(/^>.*$/gm, ""))
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /\*\*\*must/.test(sentence));
    const vendor = binding.filter((sentence) => /claude|model/i.test(sentence));

    expect(vendor).toHaveLength(1);
    expect(sectionStarting(PROCESS, "2.5 ")).toMatch(/\*\*\*must\*\*\* put `claude` on `PATH`/);
  });

  /** The lint's own rules, so a lint that matched nothing would not pass here. */
  it.each([
    ["a plain must", "A runner must start.", 1],
    ["a capitalised one", "MUST is binding.", 1],
    ["mustn't", "An orchestrator mustn't.", 1],
    ["bold must", "An orchestrator ***must*** start.", 0],
    ["bold must not", "An orchestrator ***must not*** start.", 0],
    ["bold must inside an orchestrator block", "> **Actions orchestrator:** it\n> ***must*** do so.", 1],
    ["a plain must inside a service block", "> **Service orchestrator:** it must.", 1],
    ["a must in an unlabelled quote, bold", "> ***must*** here is a quote.", 0],
    ["a must in an inline code span", "Run `echo must`.", 0],
    ["a must in a fenced block", "```\nyou must\n```", 0],
  ])("%s", (_, markdown, count) => {
    expect(strayMusts(markdown)).toHaveLength(count);
  });
});

/**
 * Each reusable sets every input its runners and commands declare required,
 * in the step's `env:` or its job's. A subcommand gaining a required input the
 * reusable does not set would be released and then fail every run in every
 * adopter, at start, naming an input no adopter can set.
 *
 * Optional inputs are not checked: unset is their declared default.
 */
describe("each reusable sets its subcommands' required inputs", () => {
  interface Step {
    readonly run?: string;
    readonly env?: Readonly<Record<string, unknown>>;
  }
  interface Job {
    readonly env?: Readonly<Record<string, unknown>>;
    readonly steps?: readonly Step[];
  }

  /**
   * Each step that invokes `subcommand`, in the reusable named after its
   * workflow, with the env its job and itself give it.
   */
  const subcommandSteps = (subcommand: Runner | Command): readonly Readonly<Record<string, unknown>>[] => {
    const workflowName = subcommand in RUNNERS ? subcommand : workflowOf(subcommand as Command);
    const workflow = parse(fs.readFileSync(path.join(".github", "workflows", `${workflowName}.yml`), "utf8")) as {
      readonly jobs: Readonly<Record<string, Job>>;
    };
    const invokes = new RegExp(`agent-workflows ${subcommand}\\s*$`, "m");
    return Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) => invokes.test(step.run ?? "")).map((step) => ({ ...job.env, ...step.env })),
    );
  };

  it.each([...RUNNER_NAMES, ...COMMAND_NAMES])("%s", (subcommand) => {
    const steps = subcommandSteps(subcommand);
    const required = Object.entries(declarationOf(subcommand).inputs as Inputs)
      .filter(([, input]) => input.required)
      .map(([name]) => name);

    expect(steps).toHaveLength(1);
    for (const env of steps) {
      expect(required.filter((name) => typeof env[name] !== "string" || env[name] === "")).toEqual([]);
    }
  });
});
