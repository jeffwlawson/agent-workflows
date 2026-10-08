/**
 * What a command that writes is handed besides its inputs (ADR 0005): two
 * writers, one per token, sharing one log and one set of limits; a GitHub
 * reader; and its declared output files. The command's function takes these
 * as an argument, so the CLI hands it the real ones and a test hands it fakes
 * over the same engine, and neither reads the environment.
 *
 * Which token a write is made with is the command's to choose, per write:
 * `loop` is the token whose writes start the loop's next workflow, and
 * `workflow` is the job's own, which the loop recognises its reviews, comments
 * and statuses by (`docs/platform-spec.md` §4.1).
 */
import { fetchTransport } from "../engine/github.js";
import { githubReader, type GitHubReader } from "../engine/read.js";
import { createWriters, type Limits, type WriteLog, type Writer } from "../engine/writer.js";
import { githubWrites } from "../engine/writes.js";
import type { Outputs } from "./contract.js";
import type { writers } from "./env.js";

/** The two tokens a command writes with. */
export type Token = "loop" | "workflow";

/** A command's declared output files, as `writers` in `shared/env.ts` gives them. */
export type OutputWriters<O extends Outputs> = ReturnType<typeof writers<O>>;

export interface CommandIo<O extends Outputs> {
  /**
   * The two writers, limited to `limits`, the command's own: what it may
   * write, and how many of each. Asked for once, before the first write, so
   * the limits sit in the command beside the writes they bound.
   */
  readonly writers: (limits: Limits) => Readonly<Record<Token, Writer>>;
  /** Reads, with the workflow's token. Never limited or logged: a read changes nothing. */
  readonly github: GitHubReader;
  readonly outputs: OutputWriters<O>;
}

/**
 * The real ones, for `repo` with the two tokens, each line of the write log
 * handed to `appendLine` as it is made. `end` writes the log's last line, how
 * the command ended, and writes nothing where the command never asked for its
 * writers: a command that wrote nothing has no log, and its
 * `failure_reason.txt` says why.
 */
export const liveCommandIo = <O extends Outputs>(
  tokens: { readonly GH_REPO: string; readonly GH_TOKEN: string; readonly LOOP_TOKEN: string },
  outputs: OutputWriters<O>,
  appendLine: (line: string) => void,
): { readonly io: CommandIo<O>; readonly end: (error?: unknown) => void } => {
  let log: WriteLog | undefined;
  const workflow = fetchTransport(tokens.GH_TOKEN);
  return {
    io: {
      writers: (limits) => {
        if (log !== undefined) throw new Error("A command asked for its writers twice; the second set would keep a second log.");
        const made = createWriters({
          backends: {
            loop: githubWrites(tokens.GH_REPO, fetchTransport(tokens.LOOP_TOKEN)),
            workflow: githubWrites(tokens.GH_REPO, workflow),
          },
          limits,
          appendLine,
        });
        log = made.log;
        return made.writers;
      },
      github: githubReader(tokens.GH_REPO, workflow),
      outputs,
    },
    end: (error) => {
      log?.end(error);
    },
  };
};
