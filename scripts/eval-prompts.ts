import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/**
 * How a report counts a grader beyond its pass rate, from `grading` in the
 * case's `replay.yaml` (`evals/README.md`, *What a grader is counted as*).
 *
 * - `verdict`: it passes on any blocking finding, not on the case's own
 *   (*the review does not recommend approval*). Reported, and refused as a
 *   declared primary or guard: a rise in it says nothing about the finding.
 * - `given`: it is only ever true where another grader is (*the finding is one
 *   to fix before merge* needs the finding), so it is counted over the runs
 *   that passed that one: P(this | that), not a second copy of that.
 */
export type GraderRule = { readonly kind: "verdict" } | { readonly kind: "given"; readonly grader: string };

/** A grader's name as a report gives it: its file name without `.md`. */
const graderName = (file: string): string => file.slice(0, -".md".length);

/**
 * A control (#718): real text, a review or merge-check comment or a fix that
 * shipped, with what each grader named must rule on it. A grader that fails a
 * text it should pass is broken; one that passes a text it should fail is too
 * loose. `controls <prompt>` has the judge grade the text itself, which costs
 * the judge and a one-word reply.
 */
export interface Control {
  readonly name: string;
  /** Where the text came from, so it can be read again there. */
  readonly source: string;
  /** Per grader, whether the judge must pass it on this text. */
  readonly expect: Readonly<Record<string, boolean>>;
  readonly text: string;
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
  /** By grader name, the graders `replay.yaml` counts other than by pass rate. */
  readonly grading: Readonly<Record<string, GraderRule>>;
  readonly controls: readonly Control[];
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
  const graders = fs.existsSync(gradersDir) ? fs.readdirSync(gradersDir).filter((name) => name.endsWith(".md")).sort() : [];
  const names = graders.map(graderName);
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
    graders,
    grading: readGrading(data["grading"], names, file),
    controls: readControls(path.join(dir, "controls"), names),
  };
};

/** `replay.yaml`'s `grading`: `<grader>: verdict`, or `<grader>: { given: <grader> }`. */
const readGrading = (value: unknown, graders: readonly string[], file: string): Record<string, GraderRule> => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file}: \`grading\` is not a mapping.`);
  const rules: Record<string, GraderRule> = {};
  for (const [name, rule] of Object.entries(value)) {
    if (!graders.includes(name)) throw new Error(`${file}: \`grading\` names grader ${name}, which the case does not have.`);
    if (rule === "verdict") {
      rules[name] = { kind: "verdict" };
      continue;
    }
    const given = typeof rule === "object" && rule !== null && !Array.isArray(rule) ? (rule as Record<string, unknown>)["given"] : undefined;
    if (typeof given !== "string" || !graders.includes(given) || given === name) {
      throw new Error(`${file}: \`grading.${name}\` is neither \`verdict\` nor \`{ given: <another grader of the case> }\`.`);
    }
    rules[name] = { kind: "given", grader: given };
  }
  for (const [name, rule] of Object.entries(rules)) {
    if (rule.kind === "given" && rules[rule.grader] !== undefined) {
      throw new Error(`${file}: \`grading.${name}\` is given ${rule.grader}, which is not counted by its pass rate itself.`);
    }
  }
  return rules;
};

/**
 * A case's controls: each `controls/<name>.md`, YAML frontmatter with its
 * `source` and its `expect` (`<grader>: pass` or `fail`), then the text.
 */
const readControls = (dir: string, graders: readonly string[]): Control[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(fs.readFileSync(file, "utf8"));
      if (match === null) throw new Error(`${file} does not open with YAML frontmatter.`);
      const head = parse(match[1] ?? "") as Record<string, unknown> | null;
      const source = head?.["source"];
      const expect = head?.["expect"];
      if (typeof source !== "string" || source.trim() === "") throw new Error(`${file} names no \`source\`.`);
      if (typeof expect !== "object" || expect === null || Array.isArray(expect)) throw new Error(`${file} has no \`expect\` mapping.`);
      const expected = Object.fromEntries(
        Object.entries(expect).map(([grader, verdict]) => {
          if (!graders.includes(grader)) throw new Error(`${file}: \`expect\` names grader ${grader}, which the case does not have.`);
          if (verdict !== "pass" && verdict !== "fail") throw new Error(`${file}: \`expect.${grader}\` is neither \`pass\` nor \`fail\`.`);
          return [grader, verdict === "pass"];
        }),
      );
      const text = (match[2] ?? "").trim();
      if (text === "") throw new Error(`${file} holds no text.`);
      return { name: name.slice(0, -".md".length), source: source.trim(), expect: expected, text };
    });
};

/** Each placeholder a template names, once. */
export const placeholders = (template: string): readonly string[] => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "")),
];

/** One `# ` section of a prompt file: its heading and the bytes it holds, heading included. */
export interface Section {
  readonly heading: string;
  readonly bytes: number;
}

/** A prompt file's sections, in order; what comes before the first heading is in none. */
export const sections = (template: string): Section[] => {
  const found: { heading: string; start: number }[] = [];
  for (const match of template.matchAll(/^# (.+)$/gm)) found.push({ heading: (match[1] ?? "").trim(), start: match.index });
  return found.map((s, i) => ({ heading: s.heading, bytes: Buffer.byteLength(template.slice(s.start, found[i + 1]?.start ?? template.length)) }));
};

/**
 * `evals/<prompt>/sections.yaml`: every section of the prompt, as one every
 * case reaches (`always`) or one written for a state of one input (`gated`,
 * by heading, naming the input). A case reaches a gated section only where it
 * sets that input to something other than the "nothing here" value
 * `suite.yaml` fixes it to, which `tests/evals.test.ts` holds equal to what
 * the runner's own renderer returns for that state.
 */
export interface SectionMap {
  readonly always: readonly string[];
  readonly gated: Readonly<Record<string, string>>;
}

export const readSections = (root: string, prompt: PromptName): SectionMap => {
  const file = path.join(suiteDir(root, prompt), "sections.yaml");
  const data = readYaml(file);
  const always = data["always"];
  if (!Array.isArray(always) || !always.every(isString)) throw new Error(`${file} has no valid \`always\` list.`);
  return { always, gated: strings(data["gated"], `${file} gated`) };
};

/** What one case reaches of a prompt: the sections, the gated ones it does not, and the share of the prompt's bytes. */
export interface Reach {
  readonly reached: readonly string[];
  readonly unreached: readonly { readonly section: string; readonly input: string }[];
  /** Of the bytes in the prompt's sections, the share in the sections reached. */
  readonly share: number;
}

export const reach = (template: string, map: SectionMap, suite: Suite, inputs: Readonly<Record<string, string>>): Reach => {
  const all = sections(template);
  const unreached = all.flatMap((s) => {
    const input = map.gated[s.heading];
    return input !== undefined && inputs[input] === suite.inputs[input] ? [{ section: s.heading, input }] : [];
  });
  const missed = new Set(unreached.map((u) => u.section));
  const total = all.reduce((n, s) => n + s.bytes, 0);
  const reachedBytes = all.filter((s) => !missed.has(s.heading)).reduce((n, s) => n + s.bytes, 0);
  return { reached: all.filter((s) => !missed.has(s.heading)).map((s) => s.heading), unreached, share: total === 0 ? 0 : reachedBytes / total };
};

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

/**
 * The revision at a git ref, for the `before` arm of `ab`: what `git show`
 * hands the stage, so it is never uncommitted.
 */
const revisionAt = (root: string, prompt: PromptName, ref: string): PromptRevision => {
  const file = `${prompt}/prompt.md`;
  const head = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  return {
    file,
    head,
    lastChange: git(root, ["log", "-1", "--format=%H", head, "--", file]).trim(),
    blob: git(root, ["rev-parse", `${head}:${file}`]).trim(),
    uncommitted: false,
  };
};

/** A file's git blob hash, as `git hash-object` gives it, with no git. */
const blobHash = (file: string): string => {
  const body = fs.readFileSync(file);
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
};

/** One case as staged: its name in the staged suite, and what it was staged from. */
export interface StagedCase {
  readonly name: string;
  readonly pr: number;
  readonly head: string;
  readonly clean: boolean;
  /** The case under `evals/` it was staged from, where the staged name adds its arm. */
  readonly case?: string;
  /** The arm it belongs to in a two-arm run (`ab`, `noise`). */
  readonly arm?: string;
  /** Each grader's blob hash, by the grader's name: two runs compare only under the same graders. */
  readonly graders?: Readonly<Record<string, string>>;
  /** The case's graders counted other than by pass rate (`Case.grading`). */
  readonly grading?: Readonly<Record<string, GraderRule>>;
}

/** What a staged run records beside the tool's result, for its report. */
export interface StageMeta {
  readonly prompt: PromptName;
  /** The working tree's prompt revision; in a one-arm run, the one that ran. */
  readonly revision: PromptRevision;
  /** In a two-arm run, each arm's revision, by its name. */
  readonly arms?: Readonly<Record<string, PromptRevision>>;
  readonly cases: readonly StagedCase[];
  /** In a run of the controls, each control as staged: a case of the tool's, by its staged name. */
  readonly controls?: readonly StagedControl[];
}

/** One control staged as a case of its own, `<case>--<control>`. */
export interface StagedControl {
  readonly name: string;
  readonly case: string;
  readonly control: string;
  readonly expect: Readonly<Record<string, boolean>>;
  /** The text its graders must have read, which a run's `evidence` is checked against. */
  readonly text: string;
}

/** One prompt staged under a name; a run with more than one stages every case once per arm. */
export interface Arm {
  readonly name: string;
  readonly template: string;
  readonly revision: PromptRevision;
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The suite as `claude plugin eval` reads it, under `stage/evals/`: per case
 * its `case.yaml` and graders as they are, a `prompt.md` rendered from the
 * prompt file, and a `place-files.sh` that runs `evals/checkout.sh` on its pins.
 *
 * With `arms`, every case is staged once per arm as `<case>.<arm>`, each
 * rendered from its arm's prompt, so both arms run in one session of the tool.
 * Without, the one arm is the working tree's prompt, under the case's own name.
 */
export const stage = (
  root: string,
  prompt: PromptName,
  out: string,
  only?: (name: string) => boolean,
  arms?: readonly Arm[],
): StageMeta => {
  const suite = readSuite(root, prompt);
  const revision = promptRevision(root, prompt);
  const armList = arms ?? [{ name: "", template: fs.readFileSync(path.join(root, prompt, "prompt.md"), "utf8"), revision }];
  const cases = caseDirs(root, prompt)
    .map(readCase)
    .filter((c) => only === undefined || only(c.name));
  if (cases.length === 0) throw new Error(`No ${prompt} case matched.`);
  const frontmatter = stringify({ tags: [prompt], ...suite.execution }).trimEnd();
  const map = readSections(root, prompt);
  const staged: StagedCase[] = [];
  for (const c of cases) {
    ensureCommits(root, c);
    const inputs = { ...caseInputs(suite, c), PR_DIFF: git(root, ["diff", `${c.base}...${c.head}`]) };
    const graders = Object.fromEntries(c.graders.map((file) => [graderName(file), blobHash(path.join(c.dir, "graders", file))]));
    const reached = reach(armList.at(-1)?.template ?? "", map, suite, inputs);
    console.log(
      `${c.name}: reaches ${reached.reached.length} of ${reached.reached.length + reached.unreached.length} sections, ${Math.round(100 * reached.share)}% of the prompt${
        reached.unreached.length === 0 ? "" : `; not ${reached.unreached.map((u) => `${u.section} (${u.input})`).join(", ")}`
      }.`,
    );
    for (const arm of armList) {
      const what = arm.name === "" ? `${prompt}/prompt.md` : `${prompt}/prompt.md (${arm.name})`;
      const unused = Object.keys(c.inputs).filter((key) => !placeholders(arm.template).includes(key) && !placeholders(suite.note).includes(key));
      for (const key of unused) console.log(`::warning::${c.name}: input ${key} is not in ${what} any more.`);
      const body = render(arm.template, inputs, what);
      const note = render(suite.note, inputs, `evals/${prompt}/suite.yaml's note`);
      const name = arm.name === "" ? c.name : `${c.name}.${arm.name}`;
      const dir = path.join(out, "evals", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "prompt.md"), `---\n${frontmatter}\n---\n\n${body.trimEnd()}\n\n${note.trimEnd()}\n`);
      if (arm.name === "") {
        fs.copyFileSync(path.join(c.dir, "case.yaml"), path.join(dir, "case.yaml"));
      } else {
        // The tool reports a case by the name its case.yaml gives.
        fs.writeFileSync(path.join(dir, "case.yaml"), stringify({ ...readYaml(path.join(c.dir, "case.yaml")), name }));
      }
      fs.cpSync(path.join(c.dir, "graders"), path.join(dir, "graders"), { recursive: true });
      const checkout = path.join(root, "evals", "checkout.sh");
      const args = [root, c.base, c.head, String(c.inputs["BRANCH"] ?? `eval/${c.name}`), c.baseRef].map(quote).join(" ");
      fs.writeFileSync(path.join(dir, "place-files.sh"), `#!/usr/bin/env bash\nexec bash ${quote(checkout)} ${args}\n`, { mode: 0o755 });
      staged.push({
        name,
        pr: c.pr,
        head: c.head,
        clean: c.clean,
        case: c.name,
        ...(arm.name === "" ? {} : { arm: arm.name }),
        graders,
        ...(Object.keys(c.grading).length === 0 ? {} : { grading: c.grading }),
      });
    }
  }
  const meta: StageMeta = {
    prompt,
    revision,
    ...(arms === undefined ? {} : { arms: Object.fromEntries(arms.map((arm) => [arm.name, arm.revision])) }),
    cases: staged,
  };
  fs.writeFileSync(path.join(out, "stage.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
};

/** A grader file's `type`: `llm` for a judge's, `regex` for a deterministic one. */
const graderType = (file: string): unknown => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(file, "utf8"));
  return ((parse(match?.[1] ?? "") ?? {}) as Record<string, unknown>)["type"];
};

/** Where a staged control's text is put in its run's sandbox, which its graders read. */
export const CONTROL_FILE = "control.md";

/**
 * A grader as a control stages it: its criteria as they are, with its
 * `focus` moved from the run's final message to the control's text in the
 * sandbox. Only the judge's ruling is under test, so it reads the text
 * itself and nothing a model wrote (#718).
 */
export const controlGrader = (grader: string): string => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(grader);
  if (match === null) throw new Error("A grader does not open with YAML frontmatter.");
  const head = (parse(match[1] ?? "") ?? {}) as Record<string, unknown>;
  return `---\n${stringify({ ...head, focus: { source: "file", path: CONTROL_FILE } }).trimEnd()}\n---\n${match[2] ?? ""}`;
};

/**
 * The controls as `claude plugin eval` reads them (#718): one staged case per
 * control, whose scaffold puts the control's text in the run's sandbox as
 * `control.md`, graded from that file by the case's graders the control names,
 * criteria as they are. The model is asked for one word and its message is
 * read by nothing: what a judge rules on is the text, not an echo of it. The
 * run costs the judge and a one-word reply.
 */
export const stageControls = (root: string, prompt: PromptName, out: string, only?: (name: string) => boolean): StageMeta => {
  const cases = caseDirs(root, prompt)
    .map(readCase)
    .filter((c) => only === undefined || only(c.name));
  const frontmatter = stringify({ tags: [prompt, "control"], max_turns: 1, timeout_seconds: 300, allowed_tools: [] }).trimEnd();
  const staged: StagedCase[] = [];
  const controls: StagedControl[] = [];
  for (const c of cases) {
    const hashes = Object.fromEntries(c.graders.map((file) => [graderName(file), blobHash(path.join(c.dir, "graders", file))]));
    for (const control of c.controls) {
      // A judge rules only on an `llm` grader. A `regex` one is deterministic
      // and free, and `tests/evals.test.ts` holds it on its controls.
      const graders = Object.keys(control.expect).filter((grader) => graderType(path.join(c.dir, "graders", `${grader}.md`)) === "llm");
      if (graders.length === 0) continue;
      const name = `${c.name}--${control.name}`;
      const dir = path.join(out, "evals", name);
      fs.mkdirSync(path.join(dir, "graders"), { recursive: true });
      fs.writeFileSync(path.join(dir, "prompt.md"), `---\n${frontmatter}\n---\n\nReply with the one word \`done\`. Use no tool.\n`);
      fs.writeFileSync(path.join(dir, CONTROL_FILE), `${control.text}\n`);
      fs.writeFileSync(
        path.join(dir, "place-files.sh"),
        `#!/usr/bin/env bash\nexec cp ${quote(path.join(dir, CONTROL_FILE))} ${quote(CONTROL_FILE)}\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(dir, "case.yaml"),
        stringify({
          schema_version: "1.1",
          name,
          context: { scaffold_script: "place-files.sh" },
          expected_outcome: `The graders rule on ${CONTROL_FILE}, ${control.name} of ${c.name}, as its expect says.\n`,
        }),
      );
      for (const grader of graders) {
        fs.writeFileSync(path.join(dir, "graders", `${grader}.md`), controlGrader(fs.readFileSync(path.join(c.dir, "graders", `${grader}.md`), "utf8")));
      }
      staged.push({ name, pr: c.pr, head: c.head, clean: false, case: c.name, graders: Object.fromEntries(graders.map((g) => [g, hashes[g] ?? ""])) });
      controls.push({ name, case: c.name, control: control.name, expect: Object.fromEntries(graders.map((g) => [g, control.expect[g] === true])), text: control.text });
    }
  }
  if (controls.length === 0) throw new Error(`No ${prompt} case matched has a control.`);
  const meta: StageMeta = { prompt, revision: promptRevision(root, prompt), cases: staged, controls };
  fs.writeFileSync(path.join(out, "stage.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
};

/** The fields of `claude plugin eval --json`'s result this reads. */
export interface EvalResult {
  readonly claudeVersion?: string;
  readonly costUsd?: number;
  readonly partial?: boolean;
  readonly suite?: { readonly modelOverride?: string; readonly judgeModel?: string };
  readonly cases: readonly {
    readonly name: string;
    readonly graders: readonly { readonly name: string; readonly graderMarkdown?: string }[];
    readonly arms: {
      readonly with?: readonly {
        /** `null` on a run that finished: the tool writes the field on every run. */
        readonly error: string | null;
        readonly costUsd?: number;
        readonly judgeCostUsd?: number;
        readonly turns?: number;
        /** In the run's sandbox, which the tool deletes after the run unless given `--keep-temp`. */
        readonly tracePath?: string;
        readonly graders: readonly {
          readonly name: string;
          readonly passed: boolean;
          readonly judgeVotes?: readonly boolean[];
          /** The judge's reason for its ruling. */
          readonly explanation?: string;
          /** What the judge was shown, capped by the tool at 100 KB. */
          readonly evidence?: string;
        }[];
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

/** A grader's result in one run, as the tool and a run's records both give it. */
interface Graded {
  readonly graders: readonly { readonly name: string; readonly passed: boolean }[];
}

const passes = (run: Graded, grader: string): boolean => run.graders.some((g) => g.name === grader && g.passed);

/**
 * Of completed runs, how many a grader is counted over and how many of those
 * passed it: all of them, or under `given` only those that passed the other
 * grader.
 */
const tally = (runs: readonly Graded[], grader: string, rule: GraderRule | undefined): { passed: number; n: number } => {
  const over = rule?.kind === "given" ? runs.filter((run) => passes(run, rule.grader)) : runs;
  return { passed: over.filter((run) => passes(run, grader)).length, n: over.length };
};

/** A grader as a table names it: `04 (verdict)`, `02 given 01`, or its name. */
const graderLabel = (name: string, rule: GraderRule | undefined): string =>
  rule === undefined ? name : rule.kind === "verdict" ? `${name} (verdict)` : `${name} given ${rule.grader}`;

/** One grader of one control, against what it must rule. */
export interface ControlRow {
  readonly case: string;
  readonly control: string;
  readonly grader: string;
  readonly expected: boolean;
  /** The ruling every counted run agrees on; `undefined` where none is counted or they split. */
  readonly judged: boolean | undefined;
  /**
   * `held` as expected; `differs` a ruling against it, on the control's own
   * text; `void` where no completed run's judge was shown that text, so its
   * ruling says nothing about the grader; `none` where no run completed.
   */
  readonly status: "held" | "differs" | "void" | "none";
  readonly check: string;
  /** The judge's reasons, one per counted run, where its ruling differs. */
  readonly explanations: readonly string[];
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Each grader of each control against what it must rule, from a run of the
 * controls. A run is counted for a grader only where the judge was shown the
 * control's text (the tool's `evidence`, which holds what the judge read): a
 * ruling on anything else is **void**, never broken or too loose, so a
 * verdict here depends on the text and not on how the run went (#718).
 */
export const controlRows = (meta: StageMeta, result: EvalResult): ControlRow[] =>
  (meta.controls ?? []).flatMap((control) => {
    const runs = (result.cases.find((c) => c.name === control.name)?.arms.with ?? []).filter((run) => !erroredRun(run));
    const want = typeof control.text === "string" ? squash(control.text) : undefined;
    return Object.entries(control.expect).map(([grader, expected]): ControlRow => {
      const rulings = runs.flatMap((run) => run.graders.filter((g) => g.name === grader));
      const read = rulings.filter((g) => want !== undefined && want !== "" && typeof g.evidence === "string" && squash(g.evidence).includes(want));
      const passedIn = read.filter((g) => g.passed).length;
      // With more than one run, the control holds only where every run agrees.
      const judged = read.length === 0 ? undefined : passedIn === read.length ? true : passedIn === 0 ? false : undefined;
      const row = { case: control.case, control: control.control, grader, expected, judged };
      if (runs.length === 0) return { ...row, status: "none", check: "no completed run", explanations: [] };
      if (read.length === 0) {
        return { ...row, status: "void", check: "void: the judge was not shown the control's text", explanations: [] };
      }
      if (judged === expected) return { ...row, status: "held", check: "as expected", explanations: [] };
      const check =
        judged === undefined
          ? `split (${passedIn}/${read.length})`
          : expected
            ? "**broken**: fails its positive control"
            : "**too loose**: passes its negative control";
      const explanations = read.filter((g) => g.passed !== expected).map((g) => g.explanation ?? "").filter((text) => text.trim() !== "");
      return { ...row, status: "differs", check, explanations };
    });
  });

/** The report of a run of the controls: per control and grader, what it must rule and what the judge ruled. */
export const controlsReport = (meta: StageMeta, result: EvalResult, dir?: string): string => {
  const rows = controlRows(meta, result);
  const count = (status: ControlRow["status"]): number => rows.filter((row) => row.status === status).length;
  const word = (b: boolean | undefined): string => (b === undefined ? "n/a" : b ? "pass" : "fail");
  const differing = rows.filter((row) => row.status === "differs" && row.explanations.length > 0);
  return `${[
    `### \`${meta.prompt}\` grader controls`,
    "",
    `- **Model:** ${result.suite?.modelOverride ?? "(not recorded)"}; **judge:** ${result.suite?.judgeModel ?? "(not recorded)"}; **Claude Code:** ${result.claudeVersion ?? "(not recorded)"}`,
    `- **Cost:** $${(result.costUsd ?? 0).toFixed(2)}${result.partial === true ? " (**partial**: the cost ceiling stopped the run)" : ""}`,
    ...(dir === undefined ? [] : [`- **Run directory:** \`${dir}\``]),
    `- **${count("held")} of ${rows.length}** grader rulings as the controls expect; **${count("differs")}** differ; **${count("void")}** void (the judge was not shown the control's text); **${count("none")}** with no completed run.`,
    "",
    "| Case | Control | Grader | Expected | Judged | Check |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.case} | ${row.control} | ${row.grader} | ${word(row.expected)} | ${word(row.judged)} | ${row.check} |`),
    ...(differing.length === 0
      ? []
      : ["", "**Why the judge ruled otherwise:**", "", ...differing.flatMap((row) => row.explanations.map((text) => `- ${row.case} ${row.control} ${row.grader}: ${oneLine(text, 400)}`))]),
  ].join("\n")}\n`;
};

/**
 * The report a run is compared by, as Markdown to paste into a pull request:
 * per case its runs and each grader's pass rate (the catch rate), the
 * false-finding rate on a clean case, and the model and prompt revision.
 *
 * A clean case's graders all hold false findings, so a finished run that fails
 * any of them is a run that raised one.
 */
export const report = (meta: StageMeta, result: EvalResult, dir?: string): string => {
  if (meta.controls !== undefined) return controlsReport(meta, result, dir);
  const revisionLine = (r: PromptRevision): string =>
    `\`${r.file}\` last changed in \`${r.lastChange.slice(0, 12)}\`, run from \`${r.head.slice(0, 12)}\`, blob \`${r.blob.slice(0, 12)}\`${r.uncommitted ? " (**uncommitted changes**)" : ""}`;
  const prompts =
    meta.arms === undefined
      ? [`- **Prompt:** ${revisionLine(meta.revision)}`]
      : Object.entries(meta.arms).map(([arm, r]) => `- **Prompt, arm \`${arm}\`:** ${revisionLine(r)}`);
  const lines = [
    `### \`${meta.prompt}\` evals`,
    "",
    `- **Model:** ${result.suite?.modelOverride ?? "(not recorded)"}`,
    ...prompts,
    `- **Claude Code:** ${result.claudeVersion ?? "(not recorded)"}`,
    `- **Cost:** $${(result.costUsd ?? 0).toFixed(2)}${result.partial === true ? " (**partial**: the cost ceiling stopped the run)" : ""}`,
    ...(dir === undefined ? [] : [`- **Run directory:** \`${dir}\``]),
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
    // Of the runs that finished: one that errored measured nothing, so it is
    // neither a pass nor a fail, and is out of every denominator.
    const completed = runs.filter((run) => !erroredRun(run));
    for (const grader of c.graders) {
      const rule = known?.grading?.[grader.name];
      const { passed, n } = tally(completed, grader.name, rule);
      lines.push(
        `| ${c.name} | ${known === undefined ? "" : `#${known.pr}`} | ${runsCell} | ${graderLabel(grader.name, rule)}: ${oneLine(grader.graderMarkdown)} | ${passed}/${n} | ${percent(passed, n)} |`,
      );
    }
    if (known?.clean === true) {
      const raised = completed.filter((run) => c.graders.some((g) => !run.graders.some((rg) => rg.name === g.name && rg.passed))).length;
      // A fix case is clean where the right change is none (#719): a run that
      // fails it changed something, or answered a thread as though it had.
      const what = meta.prompt === "fix" ? "made a change or an outcome the case needs none of" : "raised a false finding";
      clean.push(`- **${c.name}:** ${raised} of ${completed.length} completed runs ${what} (${percent(raised, completed.length)}).`);
    }
  }
  if (clean.length > 0) lines.push("", meta.prompt === "fix" ? "**False-change rate** (clean cases, where the right change is none):" : "**False-finding rate** (clean cases):", "", ...clean);
  if (meta.cases.some((c) => Object.keys(c.grading ?? {}).length > 0)) {
    lines.push(
      "",
      "A grader marked **verdict** passes on any blocking finding, not on the case's own, and is never declared as a primary or a guard. One marked **given** another is counted over the completed runs that passed that one.",
    );
  }
  return `${lines.join("\n")}\n`;
};

/**
 * One run as a run directory keeps it in `runs.json`: what it ran (case, arm,
 * prompt blob, model, judge, Claude Code, grader hashes), what it cost, its
 * trace, and each grader's result with the judge's votes. A comparison reads
 * these, from one run directory or several.
 */
export interface RunRecord {
  /** The run directory's name: one session of `claude plugin eval`. */
  readonly session: string;
  readonly prompt: PromptName;
  /** The case under `evals/`, without its arm. */
  readonly case: string;
  /** `""` in a one-arm run. */
  readonly arm: string;
  readonly blob: string;
  readonly model: string;
  readonly judgeModel: string;
  readonly claudeVersion: string;
  /** 1-based, within the case. */
  readonly run: number;
  readonly error: string | null;
  readonly costUsd: number;
  readonly judgeCostUsd: number;
  readonly turns: number;
  /** The trace copied into the run directory, relative to it; `null` where none survived. */
  readonly trace: string | null;
  readonly graders: readonly {
    readonly name: string;
    readonly hash: string | null;
    readonly passed: boolean;
    readonly judgeVotes: readonly boolean[];
    /** How it is counted, where not by its pass rate (`Case.grading`). */
    readonly rule?: GraderRule;
  }[];
}

const NOT_RECORDED = "(not recorded)";

/** Every run of a result as records, `trace` naming the copy kept of each run's trace. */
export const runRecords = (
  meta: StageMeta,
  result: EvalResult,
  session: string,
  trace: (stagedCase: string, run: number) => string | null = () => null,
): RunRecord[] =>
  result.cases.flatMap((c) => {
    const known = meta.cases.find((m) => m.name === c.name);
    const arm = known?.arm ?? "";
    const revision = meta.arms?.[arm] ?? meta.revision;
    return (c.arms.with ?? []).map((run, i) => ({
      session,
      prompt: meta.prompt,
      case: known?.case ?? c.name,
      arm,
      blob: revision.blob,
      model: result.suite?.modelOverride ?? NOT_RECORDED,
      judgeModel: result.suite?.judgeModel ?? NOT_RECORDED,
      claudeVersion: result.claudeVersion ?? NOT_RECORDED,
      run: i + 1,
      error: erroredRun(run) ? run.error : null,
      costUsd: run.costUsd ?? 0,
      judgeCostUsd: run.judgeCostUsd ?? 0,
      turns: run.turns ?? 0,
      trace: trace(c.name, i + 1),
      graders: run.graders.map((g) => {
        const rule = known?.grading?.[g.name];
        return { name: g.name, hash: known?.graders?.[g.name] ?? null, passed: g.passed, judgeVotes: g.judgeVotes ?? [], ...(rule === undefined ? {} : { rule }) };
      }),
    }));
  });

const logChoose = (n: number, k: number): number => {
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
};

/**
 * The exact two-sided Fisher p for `a` of `n1` against `c` of `n2`: the
 * probability, with the margins fixed, of a table no more likely than the one
 * seen. `undefined` when a side has no runs.
 */
export const fisher = (a: number, n1: number, c: number, n2: number): number | undefined => {
  if (n1 === 0 || n2 === 0) return undefined;
  const k = a + c;
  const total = logChoose(n1 + n2, k);
  const p = (x: number): number => Math.exp(logChoose(n1, x) + logChoose(n2, k - x) - total);
  const seen = p(a);
  let sum = 0;
  for (let x = Math.max(0, k - n2); x <= Math.min(k, n1); x++) {
    const px = p(x);
    if (px <= seen * (1 + 1e-7)) sum += px;
  }
  return Math.min(1, sum);
};

/** The Wilson 95% interval for `k` of `n`, as whole percents. */
const wilson = (k: number, n: number): string => {
  if (n === 0) return "n/a";
  const z = 1.96;
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return `${Math.round(100 * Math.max(0, centre - half))}-${Math.round(100 * Math.min(1, centre + half))}%`;
};

/** The protocol's boundary (`evals/README.md`, *The protocol*): a Pocock boundary for two looks. */
export const EFFECT_P = 0.029;

/** Two or more errored runs on a case void that side of it (`evals/README.md`, *The protocol*). */
const VOID_ERRORS = 2;

export interface CompareOptions {
  /** The declared primary graders, each `<case>/<grader>`. */
  readonly primary?: readonly string[];
  readonly guards?: readonly string[];
  readonly labels?: { readonly before: string; readonly after: string };
}

const single = (values: readonly string[], what: string, side: string): string => {
  const set = [...new Set(values)];
  if (set.length !== 1) throw new Error(`The ${side} runs are of more than one ${what} (${set.join(", ")}): pool only runs of one.`);
  return set[0] ?? "";
};

/**
 * Before and after side by side per case and grader: completed runs passed,
 * the Wilson interval, and the exact two-sided Fisher p. Errored runs are out
 * of each denominator and counted beside it. A side holding runs of more than
 * one session is labelled pooled, and may hold only one prompt blob.
 *
 * Refused, by throwing: sides of different prompts, models, judges or Claude
 * Code versions, or a grader whose file differs between them; and a declared
 * primary or guard that names no compared grader.
 *
 * Only a declared primary or guard gets a verdict: `rose` or `fell` at
 * p < EFFECT_P, `not shown` otherwise, `void` where a side has two or more
 * errored runs of its case or no completed run of it (a case one side never
 * ran, or ran only into errors): that side measured nothing, so there is no
 * result to call. Every other row is descriptive.
 */
export const compare = (before: readonly RunRecord[], after: readonly RunRecord[], options: CompareOptions = {}): string => {
  const labels = options.labels ?? { before: "Before", after: "After" };
  if (before.length === 0 || after.length === 0) throw new Error(`The ${before.length === 0 ? labels.before : labels.after} side has no runs.`);
  const both = [...before, ...after];
  single(both.map((r) => r.prompt), "prompt", "compared");
  const sides = [
    { label: labels.before, runs: before },
    { label: labels.after, runs: after },
  ];
  for (const [field, what] of [
    ["model", "model"],
    ["judgeModel", "judge model"],
    ["claudeVersion", "Claude Code version"],
  ] as const) {
    const values = sides.map((side) => single(side.runs.map((r) => r[field]), what, side.label.toLowerCase()));
    if (values[0] !== values[1]) throw new Error(`The sides ran a different ${what} (${values.join(" against ")}): compare only runs of the same one.`);
  }
  const blobs = sides.map((side) => single(side.runs.map((r) => r.blob), "prompt blob", side.label.toLowerCase()));

  const keys: { case: string; grader: string }[] = [];
  for (const r of both) {
    for (const g of r.graders) {
      if (!keys.some((k) => k.case === r.case && k.grader === g.name)) keys.push({ case: r.case, grader: g.name });
    }
  }
  const unhashed = new Set<string>();
  const rules = new Map<string, GraderRule>();
  for (const k of keys) {
    const hashes = sides.map(
      (side) => new Set(side.runs.filter((r) => r.case === k.case).flatMap((r) => r.graders.filter((g) => g.name === k.grader).map((g) => g.hash))),
    );
    const known = hashes.flatMap((set) => [...set]).filter((h): h is string => h !== null);
    if (new Set(known).size > 1) throw new Error(`Grader ${k.case}/${k.grader} differs between the runs: compare only runs graded by the same file.`);
    if (hashes.some((set) => set.has(null))) unhashed.add(`${k.case}/${k.grader}`);
    const counted = new Set(both.filter((r) => r.case === k.case).flatMap((r) => r.graders.filter((g) => g.name === k.grader).map((g) => JSON.stringify(g.rule ?? null))));
    if (counted.size > 1) throw new Error(`Grader ${k.case}/${k.grader} is counted differently between the runs (${[...counted].join(" against ")}): compare only runs under the same grading.`);
    const rule = both.find((r) => r.case === k.case)?.graders.find((g) => g.name === k.grader)?.rule;
    if (rule !== undefined) rules.set(`${k.case}/${k.grader}`, rule);
  }
  const role = new Map<string, "primary" | "guard">();
  for (const [ids, name] of [
    [options.primary ?? [], "primary"],
    [options.guards ?? [], "guard"],
  ] as const) {
    for (const id of ids) {
      if (!keys.some((k) => `${k.case}/${k.grader}` === id)) throw new Error(`No compared grader is ${id}: name a ${name} as <case>/<grader>.`);
      if (rules.get(id)?.kind === "verdict") {
        throw new Error(`${id} is a verdict, which passes on any blocking finding: declare the grader of the finding the change is about instead.`);
      }
      role.set(id, name);
    }
  }

  const describe = (side: { label: string; runs: readonly RunRecord[] }, blob: string): string => {
    const sessions = [...new Set(side.runs.map((r) => r.session))];
    const from = sessions.length > 1 ? `pooled from ${sessions.length} sessions (${sessions.join(", ")})` : `session ${sessions[0] ?? ""}`;
    const cost = side.runs.reduce((sum, r) => sum + r.costUsd, 0);
    return `- **${side.label}:** ${from}, blob \`${blob.slice(0, 12)}\`, $${cost.toFixed(2)}`;
  };
  const first = before[0] as RunRecord;
  const lines = [
    `### \`${first.prompt}\` comparison`,
    "",
    `- **Model:** ${first.model}; **judge:** ${first.judgeModel}; **Claude Code:** ${first.claudeVersion}`,
    describe(sides[0] as (typeof sides)[number], blobs[0] ?? ""),
    describe(sides[1] as (typeof sides)[number], blobs[1] ?? ""),
    ...(blobs[0] === blobs[1] ? ["- **The same prompt blob on both sides:** every difference below is noise."] : []),
    ...(unhashed.size > 0 ? [`- **Grader files not recorded** for ${[...unhashed].join(", ")} (a run staged before #717), so they could not be checked equal.`] : []),
    "",
    `Passed of completed runs, with the Wilson 95% interval; errored runs are out of the denominator. An effect is called only on a declared primary or guard, at two-sided Fisher p < ${EFFECT_P}.`,
    "",
    `| Case | Grader | ${labels.before} | ${labels.after} | Fisher p | Verdict |`,
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const k of keys) {
    const id = `${k.case}/${k.grader}`;
    const rule = rules.get(id);
    const counts = sides.map((side) => {
      const runs = side.runs.filter((r) => r.case === k.case);
      const completed = runs.filter((r) => r.error === null);
      const errored = runs.length - completed.length;
      return { ...tally(completed, k.grader, rule), errored };
    });
    const [b, a] = counts as [(typeof counts)[number], (typeof counts)[number]];
    const cell = (c: typeof b): string => `${c.passed}/${c.n} (${percent(c.passed, c.n)}; ${wilson(c.passed, c.n)})${c.errored > 0 ? `, ${c.errored} errored` : ""}`;
    const p = fisher(b.passed, b.n, a.passed, a.n);
    const r = role.get(id);
    const verdict =
      r === undefined
        ? "descriptive"
        : counts.some((c) => c.errored >= VOID_ERRORS || c.n === 0)
          ? "void"
          : p !== undefined && p < EFFECT_P
            ? a.passed / a.n > b.passed / b.n
              ? "rose"
              : "fell"
            : "not shown";
    lines.push(`| ${k.case} | ${graderLabel(k.grader, rule)}${r === undefined ? "" : ` (${r})`} | ${cell(b)} | ${cell(a)} | ${p === undefined ? "n/a" : p.toFixed(3)} | ${verdict} |`);
  }
  return `${lines.join("\n")}\n`;
};

/** A prompt a pull request changes, by its blob at the merge-base and at the head. */
export interface PromptChange {
  readonly prompt: PromptName;
  readonly before: string;
  readonly after: string;
}

/** The line that waives the comparison for a change no eval can measure, with its reason. */
const WAIVER = /^Eval-Waiver:[ \t]*(\S.*)$/m;

/**
 * What a pull request that changes a prompt still owes (#718,
 * `evals/README.md`, *The protocol*, step 7): for each changed prompt, a
 * comparison in its body or a comment whose two sides ran the prompt's blob at
 * the merge-base and at the head, as `compare` prints them (`blob` and its
 * first 12 hex, before then after). A comparison of other blobs is one of an
 * earlier revision of the change, and does not count. An `Eval-Waiver:` line
 * with a reason in the body stands for all of them; one in a comment does not,
 * since anyone who can comment could post it. Empty when nothing is owed.
 */
export const comparisonProblems = (
  changes: readonly PromptChange[],
  body: string,
  comments: readonly string[],
  mergeBase = "<merge-base>",
): string[] => {
  if (changes.length === 0) return [];
  if (WAIVER.test(body)) return [];
  const texts = [body, ...comments];
  return changes.flatMap((change) => {
    const heading = `### \`${change.prompt}\` comparison`;
    const found = texts.flatMap((text) =>
      text
        .split(heading)
        .slice(1)
        .map((block) => [...(block.split(/^### /m)[0] ?? "").matchAll(/blob `([0-9a-f]{12})`/g)].map((m) => m[1] ?? "").slice(0, 2)),
    );
    const want = [change.before.slice(0, 12), change.after.slice(0, 12)];
    if (found.some(([before, after]) => before === want[0] && after === want[1])) return [];
    const seen = found.length === 0 ? "none is in its body or comments" : `the one(s) there ran ${found.map((pair) => pair.join(" against ")).join("; ")}`;
    return [
      `${change.prompt}/prompt.md changed (blob ${want[0]} at the merge-base, ${want[1]} at the head), and no comparison of those two blobs is posted: ${seen}. Run \`node scripts/eval-prompts.ts ab ${change.prompt} ${mergeBase}\` under the protocol in evals/README.md and paste its comparison into the pull request, or add a line \`Eval-Waiver: <why no eval can measure this change>\` to its body.`,
    ];
  });
};

/**
 * `check-comparison`, the CI check of a pull request (`prompt-evals.yml`):
 * which prompts it changes, from git, and whether its body and comments carry
 * the comparison each owes. Its input is the environment the step sets:
 * `GH_REPO`, `PR_NUMBER`, `BASE_SHA` and `HEAD_SHA`.
 */
const checkComparison = (root: string): never => {
  const env = (key: string): string => {
    const value = process.env[key] ?? "";
    if (value === "") {
      console.error(`::error::${key} is not set: the workflow step sets GH_REPO, PR_NUMBER, BASE_SHA and HEAD_SHA.`);
      process.exit(1);
    }
    return value;
  };
  const [repo, pr, base, head] = [env("GH_REPO"), env("PR_NUMBER"), env("BASE_SHA"), env("HEAD_SHA")];
  const mergeBase = git(root, ["merge-base", base, head]).trim();
  const blobAt = (commit: string, file: string): string => {
    try {
      return git(root, ["rev-parse", `${commit}:${file}`]).trim();
    } catch {
      return "";
    }
  };
  const changes = PROMPTS.map((prompt) => ({ prompt, before: blobAt(mergeBase, `${prompt}/prompt.md`), after: blobAt(head, `${prompt}/prompt.md`) })).filter(
    (c) => c.before !== c.after && c.after !== "",
  );
  if (changes.length === 0) {
    console.log(`No prompt with evals changed since ${mergeBase.slice(0, 12)}: nothing is owed.`);
    process.exit(0);
  }
  const gh = (args: readonly string[]): string => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const body = gh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".body // \"\""]);
  const comments = [gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", ".[].body"])];
  const problems = comparisonProblems(changes, body, comments, mergeBase.slice(0, 12));
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`Each changed prompt (${changes.map((c) => c.prompt).join(", ")}) carries its comparison, or the change is waived.`);
  process.exit(0);
};

const USAGE = [
  "Usage:",
  "  node scripts/eval-prompts.ts <review|fix> --model <model> --max-cost-usd <usd> [--runs <n>] [--case <glob>] [-j <n>] [--stage-only]",
  "  node scripts/eval-prompts.ts ab <review|fix> <ref> --model <model> --max-cost-usd <usd> [same options]",
  "  node scripts/eval-prompts.ts noise <review|fix> --model <model> --max-cost-usd <usd> [same options]",
  "  node scripts/eval-prompts.ts controls <review|fix> --model <model> --max-cost-usd <usd> [--runs <n>] [--case <glob>] [-j <n>] [--stage-only]",
  "  node scripts/eval-prompts.ts check-comparison   (CI: GH_REPO, PR_NUMBER, BASE_SHA and HEAD_SHA from the environment)",
  "  node scripts/eval-prompts.ts report <run-dir>",
  "  node scripts/eval-prompts.ts compare <ab-or-noise-run-dir> [--primary <case>/<grader>]... [--guard <case>/<grader>]...",
  "  node scripts/eval-prompts.ts compare --before <run-dir>[#<arm>]... --after <run-dir>[#<arm>]... [--primary ...]... [--guard ...]...",
].join("\n");

const refuse = (why: string): never => {
  console.error(`${why}\n\n${USAGE}`);
  process.exit(1);
};

/**
 * A `--case` glob, `*` and `?` only, matched against the whole case name; or
 * several, comma-separated, so one `ab` session holds a primary's case and its
 * guards'.
 */
const globMatcher = (globs: string): ((name: string) => boolean) => {
  const patterns = globs
    .split(",")
    .map((glob) => new RegExp(`^${glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`));
  return (name) => patterns.some((pattern) => pattern.test(name));
};

/**
 * Where run directories are kept: `EVAL_RUNS_DIR`, else the user's cache. Not
 * the checkout, whose `evals/` the layout test reads, and not `/tmp`, which
 * is cleared.
 */
const runsRoot = (): string =>
  process.env["EVAL_RUNS_DIR"] ?? path.join(process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache"), "agent-workflows", "evals");

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

const realOr = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * The sandbox the tool kept for a run, from its trace path: the directory the
 * tool made with `mkdtemp`, which is `claude-eval-*` under the temp dir, or on
 * macOS `e-*` under `/tmp` (Claude Code 2.1.316 shortens it there). The tool
 * names it by its real path, so on macOS it is under `/private/tmp`.
 * `undefined` where the trace is in no such directory.
 */
export const sandboxOf = (trace: string, platform: NodeJS.Platform = process.platform, tmp: string = os.tmpdir()): string | undefined => {
  const [base, prefix] = platform === "darwin" ? ["/tmp", "e-"] : [tmp, "claude-eval-"];
  const bases = new Set([base, realOr(base)]);
  for (let up = path.dirname(trace); up !== path.dirname(up); up = path.dirname(up)) {
    if (path.basename(up).startsWith(prefix) && bases.has(path.dirname(up))) return up;
  }
  return undefined;
};

/**
 * Removes a kept sandbox, and says so where it cannot. With `--keep-temp` the
 * tool seals it: its root is left read-only (0500) and the `sealed/` directory
 * holding the run's home and tmp at mode 000, so a plain recursive remove fails
 * with EACCES. Every directory is opened (0700) before it is read, which its
 * owner may do whatever its mode. A removal that still fails is a warning
 * naming the path, not the end of the run: the traces are already copied.
 */
export const removeSandbox = (sandbox: string): boolean => {
  try {
    const open = (dir: string): void => {
      fs.chmodSync(dir, 0o700);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) open(path.join(dir, entry.name));
      }
    };
    open(sandbox);
    fs.rmSync(sandbox, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.log(`::warning::Could not remove the kept sandbox ${sandbox}: ${error instanceof Error ? error.message : String(error)}. Remove it by hand.`);
    return false;
  }
};

/**
 * Keeps what the tool would delete: each run's trace, copied from its sandbox
 * (kept by `--keep-temp`) into `traces/<case>/<run>.jsonl`, after which the
 * sandbox is removed; then every run as a record in `runs.json`.
 */
const persistRuns = (dir: string): void => {
  const meta = readJson<StageMeta>(path.join(dir, "stage.json"));
  const result = readJson<EvalResult>(path.join(dir, "result.json"));
  const sandboxes = new Set<string>();
  const copied = new Map<string, string>();
  for (const c of result.cases) {
    (c.arms.with ?? []).forEach((run, i) => {
      const from = run.tracePath;
      if (from === undefined || from === "" || !fs.existsSync(from)) return;
      const rel = path.join("traces", c.name, `${i + 1}.jsonl`);
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.copyFileSync(from, path.join(dir, rel));
      copied.set(`${c.name}\n${i + 1}`, rel);
      const sandbox = sandboxOf(from);
      if (sandbox !== undefined) sandboxes.add(sandbox);
    });
  }
  for (const sandbox of sandboxes) removeSandbox(sandbox);
  const records = runRecords(meta, result, path.basename(dir), (name, run) => copied.get(`${name}\n${run}`) ?? null);
  fs.writeFileSync(path.join(dir, "runs.json"), `${JSON.stringify(records, null, 2)}\n`);
  const runs = result.cases.reduce((n, c) => n + (c.arms.with?.length ?? 0), 0);
  console.log(`Kept ${runs} run(s) in ${path.join(dir, "runs.json")}, ${copied.size} with its trace.`);
};

/** A run directory's records: its `runs.json`, or, for one made before it was written, read off its result. */
const loadRecords = (dir: string): RunRecord[] => {
  const file = path.join(dir, "runs.json");
  if (fs.existsSync(file)) return readJson<RunRecord[]>(file);
  return runRecords(readJson<StageMeta>(path.join(dir, "stage.json")), readJson<EvalResult>(path.join(dir, "result.json")), path.basename(dir));
};

/** One side's records, from `<dir>` or `<dir>#<arm>`; a run of two arms needs its arm named. */
const sideRecords = (spec: string): RunRecord[] => {
  const hash = spec.lastIndexOf("#");
  const [dir, arm] = hash === -1 ? [spec, undefined] : [spec.slice(0, hash), spec.slice(hash + 1)];
  const records = loadRecords(dir);
  const arms = [...new Set(records.map((r) => r.arm))];
  if (arm === undefined) {
    if (arms.length > 1) throw new Error(`${dir} has arms ${arms.join(" and ")}: name one, as ${dir}#${arms[0] ?? ""}.`);
    return records;
  }
  if (!arms.includes(arm)) throw new Error(`${dir} has no arm ${arm}${arms.length > 0 ? ` (it has ${arms.join(", ")})` : ""}.`);
  return records.filter((r) => r.arm === arm);
};

/** A two-arm run's own comparison: `before` against `after`, or `a` against `b`. */
const armsComparison = (dir: string, options: CompareOptions): string => {
  const meta = readJson<StageMeta>(path.join(dir, "stage.json"));
  const arms = Object.keys(meta.arms ?? {});
  if (arms.length !== 2) throw new Error(`${dir} is a run of one arm: compare it with another, as --before ${dir} --after <run-dir>.`);
  const [first, second] = arms as [string, string];
  const records = loadRecords(dir);
  return compare(
    records.filter((r) => r.arm === first),
    records.filter((r) => r.arm === second),
    { ...options, labels: { before: first, after: second } },
  );
};

const printReport = (dir: string): void => {
  const meta = readJson<StageMeta>(path.join(dir, "stage.json"));
  const result = readJson<EvalResult>(path.join(dir, "result.json"));
  let text = report(meta, result, dir);
  if (Object.keys(meta.arms ?? {}).length === 2) {
    try {
      text += `\n${armsComparison(dir, {})}`;
    } catch (error) {
      text += `\n**No comparison:** ${error instanceof Error ? error.message : String(error)}\n`;
    }
  }
  fs.writeFileSync(path.join(dir, "report.md"), text);
  console.log(`\n${text}\nWritten to ${path.join(dir, "report.md")}.`);
};

/** `compare`'s arguments: one two-arm run directory, or `--before` and `--after` sides; and the declared graders. */
const runCompare = (args: readonly string[]): void => {
  const before: string[] = [];
  const after: string[] = [];
  const primary: string[] = [];
  const guards: string[] = [];
  const positional: string[] = [];
  const lists: Record<string, string[]> = { "--before": before, "--after": after, "--primary": primary, "--guard": guards };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const list = lists[arg];
    if (list !== undefined && args[i + 1] !== undefined) list.push(args[++i] ?? "");
    else if (!arg.startsWith("-")) positional.push(arg);
    else refuse(`Refusing \`${arg}\`.`);
  }
  const options: CompareOptions = { primary, guards };
  let text: string;
  try {
    if (positional.length === 1 && before.length === 0 && after.length === 0) {
      text = armsComparison(positional[0] ?? "", options);
    } else if (positional.length === 0 && before.length > 0 && after.length > 0) {
      // A directory named twice is one session, not two to pool.
      text = compare([...new Set(before)].flatMap(sideRecords), [...new Set(after)].flatMap(sideRecords), options);
    } else {
      return refuse("`compare` takes one run directory of two arms, or `--before` and `--after` run directories.");
    }
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  console.log(text);
};

/** The options every command that runs cases takes. */
interface RunOptions {
  readonly model: string;
  readonly ceiling: string;
  readonly runs?: string;
  readonly glob?: string;
  readonly concurrency?: string;
  readonly stageOnly: boolean;
}

const parseRunOptions = (args: readonly string[]): RunOptions => {
  const options = new Map<string, string>();
  let stageOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const key = arg === "-j" ? "--concurrency" : arg;
    if (arg === "--stage-only") {
      stageOnly = true;
    } else if (["--model", "--max-cost-usd", "--runs", "--case", "--concurrency"].includes(key) && args[i + 1] !== undefined) {
      options.set(key, args[++i] ?? "");
    } else {
      refuse(`Refusing \`${arg}\`.`);
    }
  }
  // Both required: a report says which model it measured, and a before and an
  // after are only comparable at the same one; and an agent run has no cost
  // bound of its own beyond its turns.
  const model = options.get("--model") ?? refuse("Name the model: `--model`, the same for a before run and an after run.");
  const ceiling = options.get("--max-cost-usd") ?? refuse("Set a cost ceiling: `--max-cost-usd`.");
  const runs = options.get("--runs");
  const glob = options.get("--case");
  const concurrency = options.get("--concurrency");
  return {
    model,
    ceiling,
    stageOnly,
    ...(runs === undefined ? {} : { runs }),
    ...(glob === undefined ? {} : { glob }),
    ...(concurrency === undefined ? {} : { concurrency }),
  };
};

/** Stages the arms, runs them in one session of the tool, keeps every run, and prints the report. */
const runCases = (root: string, prompt: PromptName, mode: string, opts: RunOptions, arms?: readonly Arm[]): never => {
  // A stage alone is not a run: it goes to the temp dir, and nothing is kept.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parent = opts.stageOnly ? os.tmpdir() : runsRoot();
  fs.mkdirSync(parent, { recursive: true });
  const out = fs.mkdtempSync(path.join(parent, opts.stageOnly ? `prompt-evals-${prompt}-` : `${stamp}-${mode}-${prompt}-`));
  const controls = mode === "controls";
  const only = opts.glob === undefined ? undefined : globMatcher(opts.glob);
  try {
    const meta = controls ? stageControls(root, prompt, out, only) : stage(root, prompt, out, only, arms);
    console.log(`Staged ${meta.cases.length} ${prompt} ${controls ? "control" : "case"}(s) in ${out}.`);
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
  if (opts.stageOnly) process.exit(0);

  // A control's graders read its text from the sandbox: no checkout, and no
  // tool to grant.
  const tools = controls ? [] : readSuite(root, prompt).execution.allowed_tools.filter((tool) => GATED_TOOLS.has(tool));
  const runs = opts.runs ?? (controls ? "1" : undefined);
  const args = [
    "plugin", "eval", out,
    // The staged cases are this repository's, written by this script: their
    // scaffold is `evals/checkout.sh`, or for a control a copy of its text.
    "--scaffold", "--trust-plugin",
    // No plugin is under test, so no without-plugin arm; and the report stays
    // on this machine rather than being published.
    "--ablation", "none", "--no-publish",
    // A case below full marks is the finding, not a failure of the command.
    "--threshold", "0",
    "--model", opts.model,
    "--max-cost-usd", opts.ceiling,
    "--json", path.join(out, "result.json"),
    // The tool's own results beside ours, in the run directory.
    "--output-dir", path.join(out, "tool"),
    // Without it the tool deletes each run's sandbox, and its trace.jsonl with
    // it; persistRuns copies the trace out and removes the sandbox.
    ...(controls ? [] : ["--keep-temp"]),
    ...(tools.length === 0 ? [] : ["--allow-tools", ...tools]),
    ...(runs === undefined ? [] : ["--runs", runs]),
    ...(opts.concurrency === undefined ? [] : ["--concurrency", opts.concurrency]),
  ];
  console.log(`claude ${args.join(" ")}`);
  const run = spawnSync("claude", args, { cwd: out, stdio: "inherit" });
  if (!fs.existsSync(path.join(out, "result.json"))) {
    console.error(`claude plugin eval wrote no result (exit ${run.status ?? run.signal}). The stage is kept in ${out}.`);
    process.exit(1);
  }
  persistRuns(out);
  printReport(out);
  // 2 is the cost ceiling, whose partial report is printed above.
  if (run.status === 2) process.exit(2);
  // A control the judge ruled against, on the control's own text, is a grader
  // to fix: say so in the status too. A void ruling is in the report, not here.
  if (controls) {
    const rows = controlRows(readJson<StageMeta>(path.join(out, "stage.json")), readJson<EvalResult>(path.join(out, "result.json")));
    process.exit(rows.some((row) => row.status === "differs") ? 1 : 0);
  }
  process.exit(0);
};

const promptArg = (value: string | undefined): PromptName =>
  PROMPTS.includes(value as PromptName) ? (value as PromptName) : refuse(`Name a prompt: ${PROMPTS.join(" or ")}.`);

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "..");
  const [first, ...rest] = process.argv.slice(2);
  if (first === "report") {
    if (rest.length !== 1 || rest[0] === undefined) refuse("`report` takes the run directory a run printed.");
    printReport(rest[0] as string);
    process.exit(0);
  }
  if (first === "compare") {
    runCompare(rest);
    process.exit(0);
  }
  if (first === "check-comparison") {
    if (rest.length > 0) refuse("`check-comparison` takes no arguments: its input is the environment.");
    checkComparison(root);
  }
  if (first === "controls") {
    runCases(root, promptArg(rest[0]), "controls", parseRunOptions(rest.slice(1)));
  }
  if (first === "ab") {
    const prompt = promptArg(rest[0]);
    const ref = rest[1];
    if (ref === undefined || ref.startsWith("-")) refuse("`ab` takes the git ref of the prompt to compare against: the before arm.");
    let arms: Arm[] = [];
    try {
      const before = revisionAt(root, prompt, ref as string);
      arms = [
        { name: "before", template: git(root, ["show", `${before.head}:${before.file}`]), revision: before },
        { name: "after", template: fs.readFileSync(path.join(root, prompt, "prompt.md"), "utf8"), revision: promptRevision(root, prompt) },
      ];
    } catch (error) {
      refuse(`Cannot read ${prompt}/prompt.md at ${ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (arms[0]?.revision.blob === arms[1]?.revision.blob) console.log(`::warning::${prompt}/prompt.md is the same at ${ref} and in the working tree: this is a noise run.`);
    runCases(root, prompt, "ab", parseRunOptions(rest.slice(2)), arms);
  }
  if (first === "noise") {
    const prompt = promptArg(rest[0]);
    const template = fs.readFileSync(path.join(root, prompt, "prompt.md"), "utf8");
    const revision = promptRevision(root, prompt);
    runCases(root, prompt, "noise", parseRunOptions(rest.slice(1)), [
      { name: "a", template, revision },
      { name: "b", template, revision },
    ]);
  }
  runCases(root, promptArg(first), "run", parseRunOptions(rest));
}
