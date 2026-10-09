import * as fs from "node:fs";
import * as path from "node:path";
import { EVERY_SUBCOMMAND, EVERY_SUBCOMMAND_OUTPUTS, type Input, type Inputs, type Outputs } from "./contract.js";

/**
 * The one module in a runner, a command or `shared/` that touches the
 * process's environment, and a test in `tests/agent-cli.test.ts` holds it to
 * that: every input a subcommand reads is declared in `shared/contract.ts` and
 * read through `readInputs` or `input` here, and a helper that needs one is
 * handed the value by its subcommand. A command is handed its inputs by the
 * CLI, which reads them here. A read anywhere else would be an input the declaration does
 * not have, which is the quiet default the declarations exist to end.
 *
 * Three things here touch the environment besides the accessor, and each is
 * here rather than exempted somewhere else: the writer, which finds
 * `OUTPUT_DIR` without the accessor so a missing one can still be reported;
 * `fail()`, which writes through it; and `scrubGitHubTokens`, which deletes
 * rather than reads.
 */

/**
 * Every input `D` declares, read: its value, or an optional input's default.
 * An input declared with the values it accepts reads as one of them.
 */
export type InputValues<D extends Inputs> = {
  readonly [K in keyof D & string]: D[K] extends { readonly accepts: readonly (infer V extends string)[] } ? V : string;
};

/**
 * The environment's value for `name`, or `undefined` where it is unset **or
 * empty**: GitHub interpolates an unset `vars.X` into `""` rather than into
 * nothing, so an input a caller declared and never filled in arrives set and
 * empty, and it is the same absence.
 */
const present = (name: string): string | undefined => process.env[name] || undefined;

/**
 * Write a file into `OUTPUT_DIR`, or write nothing where it is unset. Not
 * exported: a name reaches it only through `writers`, which accepts only a
 * declared one.
 *
 * Nothing rather than a fallback directory, and that is the writer's rule for
 * every caller: a runner's `fail()`, the CLI's own refusals and `doctor`, which
 * is often run by hand with no `OUTPUT_DIR` at all. Each of those says what it
 * is writing on stderr as well, so the message still reaches whoever is
 * reading, and an orchestrator that never set `OUTPUT_DIR` was never going to
 * look anywhere for the file. The `/tmp` it used to fall back to was a
 * directory nobody read, shared by every run on the machine.
 *
 * Reads `OUTPUT_DIR` through `present`, the lookup under `input`, rather than
 * through `input` itself, which is what keeps a missing `OUTPUT_DIR` reportable
 * at all: `input` reports through `fail()`, and `fail()` writes through here.
 */
const writeOutput = (filename: string, value: string): void => {
  const dir = present("OUTPUT_DIR");
  if (dir === undefined) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), value);
};

/**
 * The writers for the files `declared` lists, a subcommand's outputs in
 * `shared/contract.ts`: a name it does not list fails typechecking, so a new
 * output file cannot be written without being declared first. `declared` is
 * read for its type alone.
 */
export const writers = <D extends Outputs>(declared: D) => ({
  writeText: (filename: D[number], value: string): void => writeOutput(filename, value),
  writeJson: (filename: D[number], value: unknown): void => writeOutput(filename, JSON.stringify(value, null, 2)),
  /**
   * One line added to the end of the file, for a log kept as it happens: the
   * engine's write log, so a command cancelled half way leaves every write it
   * made. The other two replace the file.
   */
  appendLine: (filename: D[number], line: string): void => {
    const dir = present("OUTPUT_DIR");
    if (dir === undefined) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, filename), `${line}\n`);
  },
});

/**
 * The writers for the file every subcommand writes, `failure_reason.txt`: what
 * `fail()` writes through, and the CLI's refusals and `doctor` with it.
 */
export const commonWriters = writers(EVERY_SUBCOMMAND_OUTPUTS);

/**
 * Write the reason somewhere the workflow's `if: failure()` step can read it,
 * then exit non-zero. Without this the issue comment can only say "check the
 * logs", which in practice means nobody checks.
 *
 * With `OUTPUT_DIR` unset the message on stderr is the whole report, and no
 * file is written (`writeOutput`).
 */
export const fail = (message: string): never => {
  console.error(`\nFAILED: ${message}`);
  commonWriters.writeText("failure_reason.txt", message);
  process.exit(1);
};

const missingMessage = (names: readonly string[]): string =>
  `Missing required env var${names.length === 1 ? "" : "s"}: ${names.join(", ")}`;

const unacceptedMessage = (name: string, value: string, accepts: readonly string[]): string =>
  `\`${name}\` holds \`${value}\`, which is not a value it accepts. Give one of ${accepts.map((v) => `\`${v}\``).join(", ")}.`;

/**
 * One input, read as `declared` says it is to be read: a required one that is
 * unset or empty fails the run through `fail()`, naming it, and an optional
 * one falls back to the default its declaration states. A value outside the
 * ones an input accepts, where it declares them, fails the run the same way,
 * naming the input, the value and the accepted values: a value no reader
 * expected otherwise reads as whatever its comparison makes of it, which for
 * `AUTO_FIX` was off while the workflow started a fix round (#378). `declared` is a
 * runner's inputs in `shared/contract.ts`, so `name` has to be an input the
 * declaration has, and an undeclared one fails typechecking.
 *
 * Out through `fail`, not `process.exit`, and that is the point of it: a
 * runner reads its inputs at module scope, before any of its own work, so the
 * run a missing one ends is the one with nothing else in its log to go on.
 * Exiting silently left the comment reading `(no reason file written)`, the
 * same string a runner that will not load at all produces: one signature for
 * two causes whose difference is the only thing worth knowing
 * (`docs/friction.md`, 2026-08-08). `required()` did this before the
 * declarations, and this replaced it.
 */
export const input = <D extends Inputs>(declared: D, name: keyof D & string): string => {
  const value = present(name);
  const declaration: Input | undefined = declared[name];
  if (value === undefined) {
    if (declaration?.required === false) return declaration.default;
    return fail(missingMessage([name]));
  }
  const accepts = declaration?.accepts;
  if (accepts !== undefined && !accepts.includes(value)) return fail(unacceptedMessage(name, value, accepts));
  return value;
};

/**
 * Every input `declared` has, read at once: the check a runner makes **at
 * start**, before any of its own work, so a hole in its input stops the run
 * there and names every input missing rather than the first one a later read
 * happens to reach.
 *
 * That includes an input only a subprocess reads. `GH_TOKEN` is read by `gh`
 * and by nothing here, and without this check a missing one did not stop
 * anything: every trusted fetch came back empty and the run carried on as if
 * the issue had nothing trusted in it. Read before `scrubGitHubTokens`, which
 * deletes it.
 */
export const readInputs = <D extends Inputs>(declared: D): InputValues<D> => {
  const missing = Object.entries(declared)
    .filter(([name, declaration]) => declaration.required && present(name) === undefined)
    .map(([name]) => name);
  if (missing.length > 0) return fail(missingMessage(missing));
  return Object.fromEntries(Object.keys(declared).map((name) => [name, input(declared, name)])) as InputValues<D>;
};

/**
 * Where the runner writes its results. Required, through the accessor: a
 * caller that reaches for it is past the start-of-run check, so a missing one
 * here is a runner that never made it.
 */
export const outputDir = (): string => input(EVERY_SUBCOMMAND, "OUTPUT_DIR");

/**
 * Remove the GitHub tokens from this process's environment. The agent runs
 * unsandboxed (`noSandbox` merges `process.env`) and its Bash tool can read the
 * environment, so a prompt-injected agent could use `gh` to act on the repo or
 * exfiltrate the token. Neither runner's agent legitimately needs it: issue/PR
 * context is fetched *before* the agent starts, and all pushing/labelling/
 * commenting happens in separate workflow steps.
 *
 * `NODE_AUTH_TOKEN` is the same job token under another name: the workflow
 * hands it to the runner step so `npm exec` can install this package from
 * GitHub Packages, and by the time this runs that install is done. In every
 * job but review it holds `contents: write`, so left in place it would be a
 * push credential the agent could read off its own environment.
 *
 * Scope and limits: this affects only the current Node process and its
 * children, not later workflow steps. Nor does it reach the git credentials
 * `actions/checkout` would persist — from v6 in a `$RUNNER_TEMP` file that
 * `.git/config` includes — and it does not need to: every checkout an agent
 * runs in sets `persist-credentials: false`, and each fetch or push passes
 * its token on its own command (asserted in `tests/workflows.test.ts`).
 */
export const scrubGitHubTokens = (): void => {
  delete process.env["GH_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
  delete process.env["NODE_AUTH_TOKEN"];
};
