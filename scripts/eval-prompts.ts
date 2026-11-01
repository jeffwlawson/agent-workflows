import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

/**
 * Golden-PR evals for the `review` and `fix` prompts (#617): past pull requests
 * with known outcomes, replayed against the prompt file as it stands, graded by
 * `claude plugin eval`, and reported as a catch rate per case.
 *
 * `claude plugin eval` reads a case's prompt from a `prompt.md` it takes as
 * written, and a runner's prompt is a template the runner renders with its
 * inputs. So a case under `evals/` holds the inputs and no prompt, and this
 * stages a copy of the suite where each case's `prompt.md` is `review/prompt.md`
 * or `fix/prompt.md` rendered with them, then runs the tool on that copy. An
 * edit to the prompt file is the next run's prompt, with nothing to regenerate.
 *
 * Run by hand, never by the verify command or CI: each run is a full agent
 * session on the caller's credential, and its output is not deterministic.
 * `evals/README.md` says how and why. `tests/evals.test.ts` holds the layout
 * this reads, with no model and no network.
 *
 * **Run from source and never emitted**, as `sync-version.ts` is:
 * `tsconfig.build.json` excludes it, and nothing built imports it.
 */

/** The prompts with cases, each the folder of its runner and of its cases under `evals/`. */
export const PROMPTS = ["review", "fix"] as const;
export type PromptName = (typeof PROMPTS)[number];

/** A placeholder as sandcastle substitutes it into a runner's prompt file. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * A sandcastle shell block, which the runner executes while rendering and this
 * does not. Neither prompt has one; one added is refused rather than replayed
 * as literal text.
 */
const SHELL_BLOCK = /!`[^`]+`/;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The tools `claude plugin eval` grants only when the operator names them too. */
const GATED_TOOLS = new Set(["Bash", "Write", "Edit", "WebFetch"]);

/** What every case of one prompt shares: `evals/<prompt>/suite.yaml`. */
export interface Suite {
  readonly execution: { readonly max_turns: number; readonly timeout_seconds: number; readonly allowed_tools: readonly string[] };
  readonly inputs: Readonly<Record<string, string>>;
  /** Appended after the rendered prompt, rendered with the same inputs. */
  readonly note: string;
}

/** One case, as its folder holds it. */
export interface Case {
  readonly name: string;
  readonly dir: string;
  readonly pr: number;
  readonly repository: string;
  readonly baseRef: string;
  readonly base: string;
  readonly head: string;
  /** The case's file holding the brief or finding it is graded against. */
  readonly brief: string;
  /** A case whose every grader holds false findings. */
  readonly clean: boolean;
  /** Its own inputs: `replay.yaml`'s, then one per file under `inputs/`, named for the placeholder. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly graders: readonly string[];
}

const readYaml = (file: string): Record<string, unknown> => {
  const value: unknown = parse(fs.readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} is not a YAML mapping.`);
  }
  return value as Record<string, unknown>;
};

const strings = (value: unknown, where: string): Record<string, string> => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} is not a mapping.`);
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => {
      if (typeof v !== "string") throw new Error(`${where}.${key} is not a string: quote it.`);
      return [key, v];
    }),
  );
};

const field = <T>(data: Record<string, unknown>, key: string, test: (v: unknown) => v is T, where: string): T => {
  const value = data[key];
  if (!test(value)) throw new Error(`${where} has no valid \`${key}\`.`);
  return value;
};
const isString = (v: unknown): v is string => typeof v === "string" && v !== "";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** The folder of one prompt's cases. */
export const suiteDir = (root: string, prompt: PromptName): string => path.join(root, "evals", prompt);

export const readSuite = (root: string, prompt: PromptName): Suite => {
  const file = path.join(suiteDir(root, prompt), "suite.yaml");
  const data = readYaml(file);
  const execution = data["execution"] as Record<string, unknown> | undefined;
  if (execution === undefined) throw new Error(`${file} has no \`execution\`.`);
  const tools = execution["allowed_tools"];
  if (!Array.isArray(tools) || !tools.every(isString)) throw new Error(`${file} has no valid \`execution.allowed_tools\`.`);
  return {
    execution: {
      max_turns: field(execution, "max_turns", isNumber, file),
      timeout_seconds: field(execution, "timeout_seconds", isNumber, file),
      allowed_tools: tools,
    },
    inputs: strings(data["inputs"], `${file} inputs`),
    note: field(data, "note", isString, file),
  };
};

/** Every case folder of one prompt: a folder beside `suite.yaml` holding a `case.yaml`. */
export const caseDirs = (root: string, prompt: PromptName): readonly string[] =>
  fs
    .readdirSync(suiteDir(root, prompt), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(suiteDir(root, prompt), entry.name))
    .sort();

export const readCase = (dir: string): Case => {
  const file = path.join(dir, "replay.yaml");
  const data = readYaml(file);
  const sha = (key: string): string => {
    const value = data[key];
    if (typeof value !== "string" || !FULL_SHA.test(value)) throw new Error(`${file}: \`${key}\` must be a full 40-hex commit SHA.`);
    return value;
  };
  const inputsDir = path.join(dir, "inputs");
  const fromFiles = fs.existsSync(inputsDir)
    ? Object.fromEntries(
        fs
          .readdirSync(inputsDir)
          .filter((name) => name.endsWith(".md"))
          .map((name) => [name.slice(0, -".md".length), fs.readFileSync(path.join(inputsDir, name), "utf8").trimEnd()]),
      )
    : {};
  const brief = field(data, "brief", isString, file);
  if (!fs.existsSync(path.join(dir, brief))) throw new Error(`${file}: its brief, \`${brief}\`, is not in the case.`);
  const gradersDir = path.join(dir, "graders");
  return {
    name: path.basename(dir),
    dir,
    pr: field(data, "pr", isNumber, file),
    repository: field(data, "repository", isString, file),
    baseRef: field(data, "base_ref", isString, file),
    base: sha("base"),
    head: sha("head"),
    brief,
    clean: data["clean"] === true,
    inputs: { ...strings(data["inputs"], `${file} inputs`), ...fromFiles },
    graders: fs.existsSync(gradersDir) ? fs.readdirSync(gradersDir).filter((name) => name.endsWith(".md")).sort() : [],
  };
};

/** Each placeholder a template names, once. */
export const placeholders = (template: string): readonly string[] => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "")),
];

/**
 * The inputs a case's prompt is rendered with, but the diff: the suite's, then
 * the case's, then what the replay itself decides.
 */
export const caseInputs = (suite: Suite, c: Case): Record<string, string> => ({
  ...suite.inputs,
  ...c.inputs,
  HEAD: c.head,
  BASE: c.base,
  BASE_REF: c.baseRef,
});

/** A template with every placeholder replaced, as sandcastle does; a missing input is refused. */
export const render = (template: string, inputs: Readonly<Record<string, string>>, what: string): string => {
  if (SHELL_BLOCK.test(template)) {
    throw new Error(`${what} has a shell block, which the runner executes and a replay cannot: replay it by hand.`);
  }
  const missing = placeholders(template).filter((key) => inputs[key] === undefined);
  if (missing.length > 0) throw new Error(`${what} needs ${missing.map((key) => `{{${key}}}`).join(", ")}, which nothing in the case or its suite.yaml sets.`);
  return template.replace(PLACEHOLDER, (_match, key: string) => inputs[key] ?? "");
};

const git = (root: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const hasCommit = (root: string, sha: string): boolean => {
  try {
    git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Both pinned commits in the local clone, fetched by SHA from the case's
 * repository where they are not. Neither is reachable from `main` once its pull
 * request is squashed, so a fresh clone has neither. No ref is written.
 */
const ensureCommits = (root: string, c: Case): void => {
  const absent = [c.base, c.head].filter((sha) => !hasCommit(root, sha));
  if (absent.length === 0) return;
  console.log(`${c.name}: fetching ${absent.map((sha) => sha.slice(0, 7)).join(" and ")} from ${c.repository}.`);
  git(root, ["fetch", "--quiet", "--no-tags", c.repository, ...absent]);
};

/** Which revision of the prompt a run used, for the report. */
export interface PromptRevision {
  readonly file: string;
  /** The checkout's commit when the run was staged. */
  readonly head: string;
  /** The last commit that changed the prompt file. */
  readonly lastChange: string;
  /** The file's blob as it ran, which names it exactly even when uncommitted. */
  readonly blob: string;
  readonly uncommitted: boolean;
}

const promptRevision = (root: string, prompt: PromptName): PromptRevision => {
  const file = `${prompt}/prompt.md`;
  return {
    file,
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    lastChange: git(root, ["log", "-1", "--format=%H", "--", file]).trim(),
    blob: git(root, ["hash-object", file]).trim(),
    uncommitted: git(root, ["status", "--porcelain", "--", file]).trim() !== "",
  };
};

/** What a staged run records beside the tool's result, for its report. */
export interface StageMeta {
  readonly prompt: PromptName;
  readonly revision: PromptRevision;
  readonly cases: readonly { readonly name: string; readonly pr: number; readonly head: string; readonly clean: boolean }[];
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The suite as `claude plugin eval` reads it, under `stage/evals/`: per case
 * its `case.yaml` and graders as they are, a `prompt.md` rendered from the
 * prompt file, and a `place-files.sh` that runs `evals/checkout.sh` on its pins.
 */
export const stage = (root: string, prompt: PromptName, out: string, only?: (name: string) => boolean): StageMeta => {
  const suite = readSuite(root, prompt);
  const template = fs.readFileSync(path.join(root, prompt, "prompt.md"), "utf8");
  const cases = caseDirs(root, prompt)
    .map(readCase)
    .filter((c) => only === undefined || only(c.name));
  if (cases.length === 0) throw new Error(`No ${prompt} case matched.`);
  const frontmatter = stringify({ tags: [prompt], ...suite.execution }).trimEnd();
  for (const c of cases) {
    ensureCommits(root, c);
    const inputs = { ...caseInputs(suite, c), PR_DIFF: git(root, ["diff", `${c.base}...${c.head}`]) };
    const unused = Object.keys(c.inputs).filter((key) => !placeholders(template).includes(key) && !placeholders(suite.note).includes(key));
    for (const key of unused) console.log(`::warning::${c.name}: input ${key} is not in ${prompt}/prompt.md any more.`);
    const body = render(template, inputs, `${prompt}/prompt.md`);
    const note = render(suite.note, inputs, `evals/${prompt}/suite.yaml's note`);
    const dir = path.join(out, "evals", c.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "prompt.md"), `---\n${frontmatter}\n---\n\n${body.trimEnd()}\n\n${note.trimEnd()}\n`);
    fs.copyFileSync(path.join(c.dir, "case.yaml"), path.join(dir, "case.yaml"));
    fs.cpSync(path.join(c.dir, "graders"), path.join(dir, "graders"), { recursive: true });
    const checkout = path.join(root, "evals", "checkout.sh");
    const args = [root, c.base, c.head, String(c.inputs["BRANCH"] ?? `eval/${c.name}`), c.baseRef].map(quote).join(" ");
    fs.writeFileSync(path.join(dir, "place-files.sh"), `#!/usr/bin/env bash\nexec bash ${quote(checkout)} ${args}\n`, { mode: 0o755 });
  }
  const meta: StageMeta = {
    prompt,
    revision: promptRevision(root, prompt),
    cases: cases.map((c) => ({ name: c.name, pr: c.pr, head: c.head, clean: c.clean })),
  };
  fs.writeFileSync(path.join(out, "stage.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
};

/** The fields of `claude plugin eval --json`'s result this reads. */
export interface EvalResult {
  readonly claudeVersion?: string;
  readonly costUsd?: number;
  readonly partial?: boolean;
  readonly suite?: { readonly modelOverride?: string };
  readonly cases: readonly {
    readonly name: string;
    readonly graders: readonly { readonly name: string; readonly graderMarkdown?: string }[];
    readonly arms: {
      readonly with?: readonly {
        /** `null` on a run that finished: the tool writes the field on every run. */
        readonly error: string | null;
        readonly costUsd?: number;
        readonly graders: readonly { readonly name: string; readonly passed: boolean }[];
      }[];
    };
  }[];
}

/** A run that did not finish, as the tool records it: an error string, never `null`. */
const erroredRun = (run: { readonly error: string | null }): boolean => typeof run.error === "string";

const percent = (n: number, of: number): string => (of === 0 ? "n/a" : `${Math.round((100 * n) / of)}%`);
const oneLine = (text: string | undefined, max = 90): string => {
  const line = (text ?? "").replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The report a run is compared by, as Markdown to paste into a pull request:
 * per case its runs and each grader's pass rate (the catch rate), the
 * false-finding rate on a clean case, and the model and prompt revision.
 *
 * A clean case's graders all hold false findings, so a finished run that fails
 * any of them is a run that raised one.
 */
export const report = (meta: StageMeta, result: EvalResult): string => {
  const r = meta.revision;
  const lines = [
    `### \`${meta.prompt}\` evals`,
    "",
    `- **Model:** ${result.suite?.modelOverride ?? "(not recorded)"}`,
    `- **Prompt:** \`${r.file}\` last changed in \`${r.lastChange.slice(0, 12)}\`, run from \`${r.head.slice(0, 12)}\`, blob \`${r.blob.slice(0, 12)}\`${r.uncommitted ? " (**uncommitted changes**)" : ""}`,
    `- **Claude Code:** ${result.claudeVersion ?? "(not recorded)"}`,
    `- **Cost:** $${(result.costUsd ?? 0).toFixed(2)}${result.partial === true ? " (**partial**: the cost ceiling stopped the run)" : ""}`,
    "",
    "| Case | PR | Runs | Grader | Passed | Rate |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const clean: string[] = [];
  for (const c of result.cases) {
    const known = meta.cases.find((m) => m.name === c.name);
    const runs = c.arms.with ?? [];
    const errored = runs.filter(erroredRun).length;
    const runsCell = `${runs.length}${errored > 0 ? ` (${errored} errored)` : ""}`;
    for (const grader of c.graders) {
      const passed = runs.filter((run) => run.graders.some((g) => g.name === grader.name && g.passed)).length;
      lines.push(
        `| ${c.name} | ${known === undefined ? "" : `#${known.pr}`} | ${runsCell} | ${grader.name}: ${oneLine(grader.graderMarkdown)} | ${passed}/${runs.length} | ${percent(passed, runs.length)} |`,
      );
    }
    if (known?.clean === true) {
      // Of the runs that finished: one that errored raised nothing, false or not.
      const completed = runs.filter((run) => !erroredRun(run));
      const raised = completed.filter((run) => c.graders.some((g) => !run.graders.some((rg) => rg.name === g.name && rg.passed))).length;
      clean.push(`- **${c.name}:** ${raised} of ${completed.length} completed runs raised a false finding (${percent(raised, completed.length)}).`);
    }
  }
  if (clean.length > 0) lines.push("", "**False-finding rate** (clean cases):", "", ...clean);
  return `${lines.join("\n")}\n`;
};

const USAGE = [
  "Usage:",
  "  node scripts/eval-prompts.ts <review|fix> --model <model> --max-cost-usd <usd> [--runs <n>] [--case <glob>] [--stage-only]",
  "  node scripts/eval-prompts.ts report <stage-dir>",
].join("\n");

const refuse = (why: string): never => {
  console.error(`${why}\n\n${USAGE}`);
  process.exit(1);
};

/** A `--case` glob, `*` and `?` only, matched against the whole case name. */
const globMatcher = (glob: string): ((name: string) => boolean) => {
  const pattern = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
  return (name) => pattern.test(name);
};

const printReport = (dir: string): void => {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "stage.json"), "utf8")) as StageMeta;
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as EvalResult;
  const text = report(meta, result);
  fs.writeFileSync(path.join(dir, "report.md"), text);
  console.log(`\n${text}\nWritten to ${path.join(dir, "report.md")}.`);
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "..");
  const [first, ...rest] = process.argv.slice(2);
  if (first === "report") {
    if (rest.length !== 1 || rest[0] === undefined) refuse("`report` takes the stage directory a run printed.");
    printReport(rest[0] as string);
    process.exit(0);
  }
  if (!PROMPTS.includes(first as PromptName)) refuse(`Name a prompt: ${PROMPTS.join(" or ")}.`);
  const prompt = first as PromptName;

  const options = new Map<string, string>();
  let stageOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--stage-only") {
      stageOnly = true;
    } else if (["--model", "--max-cost-usd", "--runs", "--case"].includes(arg) && rest[i + 1] !== undefined) {
      options.set(arg, rest[++i] ?? "");
    } else {
      refuse(`Refusing \`${arg}\`.`);
    }
  }
  // Both required: a report says which model it measured, and a before and an
  // after are only comparable at the same one; and an agent run has no cost
  // bound of its own beyond its turns.
  const model = options.get("--model") ?? refuse("Name the model: `--model`, the same for a before run and an after run.");
  const ceiling = options.get("--max-cost-usd") ?? refuse("Set a cost ceiling: `--max-cost-usd`.");
  const glob = options.get("--case");

  const out = fs.mkdtempSync(path.join(os.tmpdir(), `prompt-evals-${prompt}-`));
  try {
    const meta = stage(root, prompt, out, glob === undefined ? undefined : globMatcher(glob));
    console.log(`Staged ${meta.cases.length} ${prompt} case(s) in ${out}.`);
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
  if (stageOnly) process.exit(0);

  const tools = readSuite(root, prompt).execution.allowed_tools.filter((tool) => GATED_TOOLS.has(tool));
  const args = [
    "plugin", "eval", out,
    // The staged cases are this repository's, written by this script: their
    // scaffold is `evals/checkout.sh`.
    "--scaffold", "--trust-plugin",
    // No plugin is under test, so no without-plugin arm; and the report stays
    // on this machine rather than being published.
    "--ablation", "none", "--no-publish",
    // A case below full marks is the finding, not a failure of the command.
    "--threshold", "0",
    "--model", model,
    "--max-cost-usd", ceiling,
    "--json", path.join(out, "result.json"),
    ...(tools.length === 0 ? [] : ["--allow-tools", ...tools]),
    ...(options.has("--runs") ? ["--runs", options.get("--runs") ?? ""] : []),
  ];
  console.log(`claude ${args.join(" ")}`);
  const run = spawnSync("claude", args, { cwd: out, stdio: "inherit" });
  if (!fs.existsSync(path.join(out, "result.json"))) {
    console.error(`claude plugin eval wrote no result (exit ${run.status ?? run.signal}).`);
    process.exit(1);
  }
  printReport(out);
  // 2 is the cost ceiling, whose partial report is printed above.
  process.exit(run.status === 2 ? 2 : 0);
}
