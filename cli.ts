#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeText } from "./shared/common.js";
import { VERSION } from "./shared/manifest.js";

/**
 * One binary for the whole loop. A workflow invokes it as
 * `npx --yes @jeffwlawson/agent-workflows@<version> <command>`, with the version
 * pinned in the workflow YAML — which is what makes the runner base-controlled
 * under `pull_request_target` and retires the stale-runner trap (#96).
 *
 * Dispatch is a table rather than separate bins because the package has two
 * surfaces: the five runners a workflow step invokes, and the install path
 * `init` and `doctor` are (#6). They belong to the same version as the runners
 * they set up — the version that writes a pin has to be the version that pin
 * names — so one install, one binary, one thing to keep in step. A table also
 * means adding a runner is one entry rather than a new bin, a new pin and a new
 * workflow line.
 */

/** Re-exported where it has always been read from; the lookup is in `shared/`. */
export { VERSION };

/** Bad usage, as distinct from a run that failed — see the exit codes below. */
class UsageError extends Error {}

export interface Command {
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
const runner = (name: string, load: () => Promise<unknown>): Command => ({
  summary: `Run the ${name} agent (input comes from the environment).`,
  run: async (args) => {
    if (args.length > 0) {
      throw new UsageError(`\`${name}\` takes no arguments, but got: ${args.join(" ")}`);
    }
    await load();
  },
});

/**
 * `--dir <path>`, the one option the install path takes, and the only one.
 *
 * Unlike a runner these are typed by a human, in somebody else's checkout, so
 * arguments are the interface rather than a misunderstanding of it. An unknown
 * flag is still refused rather than ignored, for the reason a runner refuses
 * every argument: a silently-dropped flag does the real thing while its author
 * believes it did not.
 */
const targetDir = (name: string, args: readonly string[]): string => {
  let dir = ".";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dir" || arg === "-C") {
      const value = args[i + 1];
      if (value === undefined) throw new UsageError(`\`${name} ${arg}\` needs a directory.`);
      dir = value;
      i += 1;
      continue;
    }
    throw new UsageError(`\`${name}\` does not know the option ${arg}. The only one is \`--dir <path>\`.`);
  }
  return dir;
};

export const COMMANDS: Readonly<Record<string, Command>> = {
  doctor: {
    summary: "Check an adopting repo for the setup failures that fail silently.",
    run: async (args, io) => {
      const { runDoctor } = await import("./setup/doctor.js");
      return runDoctor({ dir: targetDir("doctor", args) }, io);
    },
  },
  fix: runner("fix", () => import("./fix/fix.js")),
  implement: runner("implement", () => import("./implement/implement.js")),
  "implement-prd": runner("implement-prd", () => import("./implement-prd/implement-prd.js")),
  init: {
    summary: "Install the caller workflows into this repo, and say what is left.",
    run: async (args, io) => {
      const { init } = await import("./setup/init.js");
      for (const change of init({ dir: targetDir("init", args) })) {
        io.stdout(`  ${change.action.padEnd(9)} ${change.file}${change.note ? ` (${change.note})` : ""}\n`);
      }
    },
  },
  review: runner("review", () => import("./review/review.js")),
  "update-branch": runner("update-branch", () => import("./update-branch/update-branch.js")),
};

/**
 * Generated from the table, so a command added later documents itself. A
 * hand-written list is the copy that goes stale first, and `help` is exactly
 * where a stale copy is read as authoritative.
 */
const usage = (): string => {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const commands = Object.entries(COMMANDS)
    .map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`)
    .join("\n");

  return `Usage: agent-workflows <command>

Runners for a GitHub Actions agent loop, invoked one per workflow step, plus
the install path \`init\` and \`doctor\`, which you run by hand.

Commands:
${commands}
  ${"--version".padEnd(width)}  Print the version this run is on.

Exit codes:
  0  the command succeeded
  1  the run failed, or \`doctor\` found something; the reason is in
     OUTPUT_DIR/failure_reason.txt
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
 * gets on the first run after it.
 */
const refuse = (io: CliIo, message: string): number => {
  io.stderr(`${message}\n\n${usage()}`);
  writeText("failure_reason.txt", message);
  return 2;
};

/**
 * Parse argv, dispatch, and return the process exit code. Never calls
 * `process.exit` itself — but note that a runner it hands over to does, through
 * `fail()`, so this returns 0 only on a run that got all the way through.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [name, ...args] = argv;

  if (name === undefined) return refuse(io, "No command given.");
  if (name === "help" || name === "--help" || name === "-h") {
    io.stdout(usage());
    return 0;
  }
  if (name === "--version" || name === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    const known = Object.keys(COMMANDS).join(", ");
    return refuse(io, `Unknown command "${name}". Known commands: ${known}.`);
  }

  try {
    // Echoed for the reason the model id is (`shared/common.ts`): "which version
    // produced this?" is the first question asked of output that looks wrong,
    // and the answer should not depend on reading the YAML as of that week.
    io.stdout(`agent-workflows ${VERSION}: ${name}\n`);
    return (await command.run(args, io)) ?? 0;
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
      // failure comment would otherwise read "(no reason file written)".
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      writeText("failure_reason.txt", message);
      process.exitCode = 1;
    },
  );
}
