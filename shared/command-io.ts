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
import {
  gitFetcher,
  gitMerger,
  gitReader,
  gitRewriter,
  gitWrites,
  githubRemote,
  type GitFetcher,
  type GitMerger,
  type GitReader,
  type GitRepository,
  type GitRewriter,
} from "../engine/git.js";
import { fetchTransport } from "../engine/github.js";
import { githubReader, type GitHubReader } from "../engine/read.js";
import { createWriters, type Backend, type Limits, type WriteLog, type Writer } from "../engine/writer.js";
import { githubWrites } from "../engine/writes.js";
import type { Outputs } from "./contract.js";
import type { writers } from "./env.js";

/** The two tokens a command writes with. */
export type Token = "loop" | "workflow";

/** A command's declared output files, as `writers` in `shared/env.ts` gives them. */
export type OutputWriters<O extends Outputs> = ReturnType<typeof writers<O>>;

/**
 * What a command that reads GitHub and writes nothing to it is handed besides
 * its inputs: the reader and its declared output files. A command that writes
 * is handed these and its writers.
 */
export interface ReadingIo<O extends Outputs> {
  /** Reads, with the workflow's token. Never limited or logged: a read changes nothing. */
  readonly github: GitHubReader;
  readonly outputs: OutputWriters<O>;
}

export interface CommandIo<O extends Outputs> extends ReadingIo<O> {
  /**
   * The two writers, limited to `limits`, the command's own: what it may
   * write, and how many of each. Asked for once, before the first write, so
   * the limits sit in the command beside the writes they bound.
   */
  readonly writers: (limits: Limits) => Readonly<Record<Token, Writer>>;
}

/**
 * What a command that works in a checkout is handed besides: what git can tell
 * it there, without a token, such as whether a bundle verifies. `fix:publish`
 * checks the agent's bundle with it before it pushes from it.
 */
export interface CheckoutIo<O extends Outputs> extends CommandIo<O> {
  readonly git: GitReader;
}

/**
 * What a command that reads GitHub and fetches into a checkout is handed,
 * and still no writer: the reader, and a fetcher from the repository on
 * GitHub with the same token. A fetch changes the checkout and nothing on
 * GitHub. `fix:prepare` fetches the rescue branch with it.
 */
export interface FetchingIo<O extends Outputs> extends ReadingIo<O> {
  readonly fetcher: GitFetcher;
}

/**
 * The same, and a merger in the checkout that fetches with that fetcher: a
 * merge of the base branch changes the checkout and nothing on GitHub.
 * `update-branch:merge` tries the gate's merge with it.
 */
export interface MergingIo<O extends Outputs> extends FetchingIo<O> {
  readonly merger: GitMerger;
}

/**
 * What a command that writes, works in a checkout and merges the base branch
 * there is handed: all of `CheckoutIo`, and a fetcher and a merger in the
 * checkout over the workflow's token. `update-branch:publish` makes the
 * clean merge again with it, and fetches the base a resolution is checked
 * against.
 */
export interface MergingCheckoutIo<O extends Outputs> extends CheckoutIo<O> {
  readonly fetcher: GitFetcher;
  readonly merger: GitMerger;
}

/**
 * All of `MergingCheckoutIo`, and a rewriter in the checkout, which makes
 * commits there and moves no ref. `implement-prd:publish` marks the slice's
 * commits with it before it pushes them.
 */
export interface RewritingCheckoutIo<O extends Outputs> extends MergingCheckoutIo<O> {
  readonly rewriter: GitRewriter;
}

/** The real ones, for `repo` with the workflow's token. */
export const liveReadingIo = <O extends Outputs>(
  tokens: { readonly GH_REPO: string; readonly GH_TOKEN: string },
  outputs: OutputWriters<O>,
): ReadingIo<O> => ({ github: githubReader(tokens.GH_REPO, fetchTransport(tokens.GH_TOKEN)), outputs });

/** The real ones, for `repo` with the workflow's token, fetching into and merging in `checkout`. */
export const liveFetchingIo = <O extends Outputs>(
  tokens: { readonly GH_REPO: string; readonly GH_TOKEN: string },
  outputs: OutputWriters<O>,
  checkout: GitRepository,
): MergingIo<O> => {
  const fetcher = gitFetcher({ ...checkout, remote: githubRemote(tokens.GH_REPO) }, tokens.GH_TOKEN);
  return { ...liveReadingIo(tokens, outputs), fetcher, merger: gitMerger(checkout, fetcher) };
};

/**
 * The real ones, for `repo` with the two tokens, each line of the write log
 * handed to `appendLine` as it is made. Each token's backend makes its GitHub
 * writes over the API and its git writes in `checkout`, the repository the
 * command runs in, pushing to the repository's remote on GitHub, and its git
 * reader reads the same checkout. Its fetcher, merger and rewriter work in the same
 * checkout and fetch with the workflow's token; a command that asks them for
 * nothing spawns nothing. `end` writes the log's last line, how
 * the command ended, and writes nothing where the command never asked for its
 * writers: a command that wrote nothing has no log, and its
 * `failure_reason.txt` says why.
 */
export const liveCommandIo = <O extends Outputs>(
  tokens: { readonly GH_REPO: string; readonly GH_TOKEN: string; readonly LOOP_TOKEN: string },
  outputs: OutputWriters<O>,
  appendLine: (line: string) => void,
  checkout: GitRepository,
): { readonly io: RewritingCheckoutIo<O>; readonly end: (error?: unknown) => void } => {
  let log: WriteLog | undefined;
  const workflow = fetchTransport(tokens.GH_TOKEN);
  const remote = { ...checkout, remote: githubRemote(tokens.GH_REPO) };
  const fetcher = gitFetcher(remote, tokens.GH_TOKEN);
  const backend = (token: string, transport = fetchTransport(token)): Backend => ({
    ...githubWrites(tokens.GH_REPO, transport),
    ...gitWrites(remote, token),
  });
  return {
    io: {
      writers: (limits) => {
        if (log !== undefined) throw new Error("A command asked for its writers twice; the second set would keep a second log.");
        const made = createWriters({
          backends: {
            loop: backend(tokens.LOOP_TOKEN),
            workflow: backend(tokens.GH_TOKEN, workflow),
          },
          limits,
          appendLine,
        });
        log = made.log;
        return made.writers;
      },
      github: githubReader(tokens.GH_REPO, workflow),
      git: gitReader(checkout),
      fetcher,
      merger: gitMerger(checkout, fetcher),
      rewriter: gitRewriter(checkout),
      outputs,
    },
    end: (error) => {
      log?.end(error);
    },
  };
};
