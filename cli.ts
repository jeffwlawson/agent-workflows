#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { commonWriters } from "./shared/common.js";
import type { CommandIo } from "./shared/command-io.js";
import { COMMANDS, type Command, type Runner } from "./shared/contract.js";
import { fail, readInputs, writers, type InputValues } from "./shared/env.js";
import { VERSION } from "./shared/manifest.js";

/**
 * One binary for the whole loop. A workflow invokes it as
 * `npx --yes @jeffwlawson/agent-workflows@<version> <command>`, with the version
 * pinned in the workflow YAML — which is what makes the runner base-controlled
 * under `pull_request_target` and retires the stale-runner trap.
 *
 * Dispatch is a table rather than separate bins because the package has two
 * surfaces: the runners and commands a workflow step invokes, and the install
 * path `init` and `doctor` are (#6). They belong to the same version as the
 * runners they set up (the version that writes a pin has to be the version
 * that pin names), so one install, one binary, one thing to keep in step. A table also
 * means adding a runner is one entry rather than a new bin, a new pin and a new
 * workflow line.
 */

/** Re-exported where it has always been read from; the lookup is in `shared/`. */
export { VERSION };

/** Bad usage, as distinct from a run that failed — see the exit codes below. */
class UsageError extends Error {}

/**
 * Every subcommand the binary dispatches on, of one of three kinds. A runner
 * and a command are declared in `shared/contract.ts`, in `RUNNERS` and
 * `COMMANDS`, and the kind here is held to the map it is declared in by
 * `tests/agent-cli.test.ts`. The install path is declared in neither: a human
 * types it, and it takes flags.
 */
export interface Subcommand {
  readonly kind: "runner" | "command" | "install";
  /** One line, shown in `help`. */
  readonly summary: string;
  /**
   * The process exit code, or nothing for the ordinary "it worked" case. A
   * number is how `doctor` reports a repository it found problems in, which is a
   * *result* rather than a crash — the run did exactly what it was asked to.
   */
  readonly run: (args: readonly string[], io: CliIo) => Promise<number | void>;
}

/**
 * A workflow runner. Its whole input is the environment the workflow step sets
 * — issue number, branch, model overrides, `OUTPUT_DIR` — so an argument to one
 * is a misunderstanding of the interface rather than a request. Refusing beats
 * ignoring: a silently-dropped `--dry-run` runs the real thing while its author
 * believes it did not.
 *
 * The module is imported lazily and running it *is* importing it: each runner is
 * a top-level script that does its work on load and exits non-zero through
 * `fail()`. So nothing may load before the argument check.
 */
const runner = (name: Runner, load: () => Promise<unknown>): Subcommand => ({
  kind: "runner",
  summary: `Run the ${name} agent (input comes from the environment).`,
  run: async (args) => {
    refuseArguments(name, args);
    await load();
  },
});

/** Refused rather than ignored, by runners and commands alike: see `runner`. */
const refuseArguments = (name: string, args: readonly string[]): void => {
  if (args.length > 0) {
    throw new UsageError(`\`${name}\` takes no arguments, but got: ${args.join(" ")}`);
  }
};

/**
 * A command (ADR 0004): `<workflow>:<step>`, invoked the way a runner is, with
 * no arguments and its whole input in the environment. Unlike a runner it does
 * nothing on import. Its module exports one function, and this reads the
 * inputs its declaration in `COMMANDS` names, calls it, and turns a throw into
 * `fail()`, so a command failure reads like a runner failure: the reason on
 * stderr and in `failure_reason.txt`, exit 1.
 *
 * The inputs are read after the module loads and before the call, so a
 * missing one stops the command at start, by name, with none of its own work
 * done.
 */
const command = <C extends Command>(
  name: C,
  load: () => Promise<(inputs: InputValues<(typeof COMMANDS)[C]["inputs"]>) => unknown>,
  summary: string,
): Subcommand => ({
  kind: "command",
  summary,
  run: async (args) => {
    refuseArguments(name, args);
    const fn = await load();
    const inputs = readInputs(COMMANDS[name].inputs);
    try {
      await fn(inputs);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  },
});

/**
 * A command that writes through the engine's writer (ADR 0005): one that
 * declares the loop's token and a write log, and is handed, besides its
 * inputs, the real writers over both tokens and the reader, built here from
 * those inputs. Every write it makes is appended to `write_log.jsonl` as it
 * lands, and the log's last line says how the command ended, whether it
 * returned or threw.
 */
type WritingCommand = {
  [C in Command]: (typeof COMMANDS)[C]["inputs"] extends { readonly LOOP_TOKEN: unknown }
    ? "write_log.jsonl" extends (typeof COMMANDS)[C]["outputs"][number]
      ? C
      : never
    : never;
}[Command];

const writingCommand = <C extends WritingCommand>(
  name: C,
  load: () => Promise<
    (inputs: InputValues<(typeof COMMANDS)[C]["inputs"]>, io: CommandIo<(typeof COMMANDS)[C]["outputs"]>) => Promise<unknown>
  >,
  summary: string,
): Subcommand => ({
  kind: "command",
  summary,
  run: async (args) => {
    refuseArguments(name, args);
    const fn = await load();
    const { liveCommandIo } = await import("./shared/command-io.js");
    const declared = COMMANDS[name];
    const inputs = readInputs(declared.inputs);
    const outputs = writers<(typeof COMMANDS)[C]["outputs"]>(declared.outputs);
    const { io, end } = liveCommandIo(inputs, outputs, (line) => outputs.appendLine("write_log.jsonl", line));
    try {
      await fn(inputs, io);
      end();
    } catch (error) {
      end(error);
      fail(error instanceof Error ? error.message : String(error));
    }
  },
});

/**
 * `--dir <path>`, the one option both halves of the install path take, and
 * the switches one of them knows: `init --app` (PRD #314).
 *
 * Unlike a runner these are typed by a human, in somebody else's checkout, so
 * arguments are the interface rather than a misunderstanding of it. An unknown
 * flag is still refused rather than ignored, for the reason a runner refuses
 * every argument: a silently-dropped flag does the real thing while its author
 * believes it did not.
 *
 * A path that is not an existing directory is refused on the same grounds.
 * `init` writes through a recursive mkdir, so a mistyped `--dir` scaffolds a
 * whole repository at a path nobody has — reporting the same repo-relative lines a correct run
 * does, while the repository being adopted is untouched — and `doctor` reads the
 * same typo as "no caller here, run `init`". The commands already refuse a
 * `SETUP.md` they did not write and a filename they do not own; "this directory
 * is not there" is the same refusal, and the answer is absolute so the report
 * names where it is working.
 */
const installArgs = (
  name: string,
  args: readonly string[],
  known: readonly string[] = [],
): { readonly dir: string; readonly switches: ReadonlySet<string> } => {
  let dir = ".";
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== undefined && known.includes(arg)) {
      switches.add(arg);
      continue;
    }
    if (arg === "--dir" || arg === "-C") {
      const value = args[i + 1];
      if (value === undefined) throw new UsageError(`\`${name} ${arg}\` needs a directory.`);
      dir = value;
      i += 1;
      continue;
    }
    const options = ["`--dir <path>`", ...known.map((flag) => `\`${flag}\``)];
    throw new UsageError(
      `\`${name}\` does not know the option ${arg}. ` +
        (options.length === 1 ? `The only one is ${options[0]}.` : `It knows ${options.join(" and ")}.`),
    );
  }
  // Not a directory counts as not there. `init` writes through a recursive
  // mkdir, which turns a path that is a file into an `ENOTDIR` thrown from
  // somewhere inside the scaffolding — exit 1, with a message about a directory
  // nobody asked for — and `doctor` reads it as "no caller here, run `init`",
  // which is a finding about a repository that does not exist.
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new UsageError(
      `\`${name}\`: ${JSON.stringify(dir)} is not a directory. Give \`--dir\` the root of a checkout that already exists.`,
    );
  }
  return { dir: path.resolve(dir), switches };
};

export const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  doctor: {
    kind: "install",
    summary: "Check an adopting repo for the setup failures that fail silently.",
    run: async (args, io) => {
      const { runDoctor } = await import("./setup/doctor.js");
      const { dir } = installArgs("doctor", args);
      // Named, because every finding below is repo-relative and `gh` was asked
      // about whichever repository this directory is — "which repo did that
      // answer come from?" must not depend on remembering what `--dir` said.
      io.stdout(`  in ${dir}\n`);
      return runDoctor({ dir }, io);
    },
  },
  fix: runner("fix", () => import("./fix/fix.js")),
  "follow-ups:file": command(
    "follow-ups:file",
    async () => (await import("./follow-ups/file.js")).file,
    "File a closed PR's recorded review findings as triageable issues (no model).",
  ),
  implement: runner("implement", () => import("./implement/implement.js")),
  "implement-prd": runner("implement-prd", () => import("./implement-prd/implement-prd.js")),
  init: {
    kind: "install",
    summary: "Install the caller workflows into this repo, create the loop's GitHub App, and say what is left.",
    run: async (args, io) => {
      const { init } = await import("./setup/init.js");
      const { livePolicySurface } = await import("./setup/policies.js");
      const { liveLabelSurface } = await import("./setup/labels.js");
      const { liveAppSurface } = await import("./setup/app.js");
      const { dir, switches } = installArgs("init", args, ["--app"]);
      io.stdout(`  in ${dir}\n`);
      const changes = await init({
        dir,
        github: livePolicySurface(dir),
        labels: liveLabelSurface(dir),
        app: liveAppSurface(dir, io.stdout),
        createApp: switches.has("--app"),
      });
      for (const change of changes) {
        io.stdout(`  ${change.action.padEnd(9)} ${change.file}${change.note ? ` (${change.note})` : ""}\n`);
      }
    },
  },
  review: runner("review", () => import("./review/review.js")),
  "review:publish": writingCommand(
    "review:publish",
    async () => (await import("./review/publish.js")).publish,
    "Resolve the threads a review closed and post the review (no model).",
  ),
  "review:conclude": writingCommand(
    "review:conclude",
    async () => (await import("./review/conclude.js")).conclude,
    "End a review run however it ended: its labels, its failure comment and the hand-off (no model).",
  ),
  "update-branch": runner("update-branch", () => import("./update-branch/update-branch.js")),
};

/**
 * Generated from the table, so a subcommand added later documents itself. A
 * hand-written list is the copy that goes stale first, and `help` is exactly
 * where a stale copy is read as authoritative.
 */
const usage = (): string => {
  const width = Math.max(...Object.keys(SUBCOMMANDS).map((name) => name.length));
  const commands = Object.entries(SUBCOMMANDS)
    .map(([name, subcommand]) => `  ${name.padEnd(width)}  ${subcommand.summary}`)
    .join("\n");

  return `Usage: agent-workflows <subcommand>

Runners and commands for a GitHub Actions agent loop, invoked one per workflow
step, plus the install path \`init\` and \`doctor\`, which you run by hand.

Subcommands:
${commands}
  ${"--version".padEnd(width)}  Print the version this run is on.

Exit codes:
  0  the command succeeded
  1  the run failed, or \`doctor\` found something; the reason is on
     stderr, and in OUTPUT_DIR/failure_reason.txt where OUTPUT_DIR is set
  2  bad usage
`;
};

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * A usage error is written where the *workflow* can read it, not only to the
 * log. Every runner does this through `fail()`, and for the same reason: the
 * `if: failure()` step turns that file into the comment on the issue or PR, and
 * a comment that can only say "check the logs" is one nobody checks. Mistyping a
 * subcommand is now a base-branch YAML edit, so this is the message a maintainer
 * gets on the first run after it. Typed by hand, with no `OUTPUT_DIR`, stderr
 * is the whole of it: the writer writes no file without one.
 */
const refuse = (io: CliIo, message: string): number => {
  io.stderr(`${message}\n\n${usage()}`);
  commonWriters.writeText("failure_reason.txt", message);
  return 2;
};

/**
 * Parse argv, dispatch, and return the process exit code. Never calls
 * `process.exit` itself — but note that a runner it hands over to does, through
 * `fail()`, so this returns 0 only on a run that got all the way through.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [name, ...args] = argv;

  if (name === undefined) return refuse(io, "No subcommand given.");
  if (name === "help" || name === "--help" || name === "-h") {
    io.stdout(usage());
    return 0;
  }
  if (name === "--version" || name === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  const subcommand = SUBCOMMANDS[name];
  if (!subcommand) {
    const known = Object.keys(SUBCOMMANDS).join(", ");
    return refuse(io, `Unknown subcommand "${name}". Known subcommands: ${known}.`);
  }

  try {
    // Echoed for the reason the model id is (`shared/agent.ts`): "which version
    // produced this?" is the first question asked of output that looks wrong,
    // and the answer should not depend on reading the YAML as of that week.
    io.stdout(`agent-workflows ${VERSION}: ${name}\n`);
    return (await subcommand.run(args, io)) ?? 0;
  } catch (error) {
    if (error instanceof UsageError) return refuse(io, error.message);
    throw error;
  }
}

// Only run as a CLI, not when imported by a test. Compare realpaths so the guard
// holds when launched through the npm-created `bin` symlink, where
// `process.argv[1]` is the symlink but `import.meta.url` is the realpath.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Reached only by an error a runner did not handle — a failing runner
      // exits through `fail()`, which never returns. The commonest such error is
      // the module not loading at all, which is precisely when the workflow's
      // failure comment would otherwise read "It stopped without giving a reason."
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      commonWriters.writeText("failure_reason.txt", message);
      process.exitCode = 1;
    },
  );
}
