/**
 * The engine's door to git, beside `github.ts`'s door to GitHub's API: the
 * write types git makes (`pushRef`, `deleteRef`); a fetch, which reads the
 * remote with a token and changes nothing there; a merge of the base branch,
 * which fetches it so and changes only the checkout; a bundle check, which is
 * a read and holds no token; and a rewrite of commit messages, which makes
 * new commits in the repository, moves no ref and holds no token either.
 *
 * Each runs `git` in a repository the backend is bound to, with the
 * environment it is handed and only two additions: `GIT_TERMINAL_PROMPT=0`,
 * and, on a write or a fetch, the token as an `http.extraHeader` set through
 * `GIT_CONFIG_*`. So the token is in no argument, where a process listing
 * would show it, and in no file, where whatever next runs in the repository
 * could read it. The environment is handed in rather than read, since the
 * engine reads none (ADR 0005), and whoever builds it keeps any proxy the
 * process was given, so git leaves the way the API calls do.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Backend, Call, GitWriteType, Lease } from "./writer.js";

const run = promisify(execFile);

/** The environment a git spawn starts from, before the engine's additions. */
export type GitEnvironment = Readonly<Record<string, string>>;

/** A repository git runs in: its directory, and the environment each spawn there starts from. */
export interface GitRepository {
  readonly dir: string;
  readonly env: GitEnvironment;
}

/** The remote a run pushes to for `repo` (`owner/name`). */
export const githubRemote = (repo: string): string => `https://github.com/${repo}.git`;

/**
 * A git command that failed, with git's own reason for it. `leaseLost` is a
 * push or a delete refused because the ref was not where its lease said.
 */
export class GitError extends Error {
  constructor(
    message: string,
    readonly leaseLost = false,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** One ref's line of `git push --porcelain`: its flag, and git's summary of what it did. */
interface Pushed {
  readonly flag: string;
  readonly summary: string;
}

/** The line for `ref` in porcelain `output`, where git wrote one. */
const pushedLine = (output: string, ref: string): Pushed | undefined => {
  for (const line of output.split("\n")) {
    const [flag, refs, summary] = line.split("\t");
    if (flag === undefined || refs === undefined || summary === undefined) continue;
    if (refs.endsWith(`:${ref}`)) return { flag, summary };
  }
  return undefined;
};

/** Git's last word on stderr, which is its reason where it gives one. */
const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? "";

const outputOf = (error: unknown, stream: "stdout" | "stderr"): string => {
  const value = typeof error === "object" && error !== null ? (error as Record<string, unknown>)[stream] : undefined;
  return typeof value === "string" ? value : "";
};

const leaseArgument = (ref: string, lease: Lease): string => `--force-with-lease=${ref}:${"tip" in lease ? lease.tip : ""}`;

/** `env` with the token as git's `http.extraHeader`, through `GIT_CONFIG_*`. */
const authorized = (env: GitEnvironment, token: string): GitEnvironment => ({
  ...env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

/** `ref`, refused where it is not a full ref name. */
const fullRef = (ref: string): string => {
  if (!ref.startsWith("refs/")) throw new GitError(`\`${ref}\` is not a full ref name; name it as \`refs/heads/${ref}\`.`);
  return ref;
};

/**
 * The git writes, pushing to `remote` from `repository` with `token`. A ref is
 * a full ref name, since git takes a commit pushed to a bare name only where
 * the ref already exists.
 */
export const gitWrites = (repository: GitRepository & { readonly remote: string }, token: string): Pick<Backend, GitWriteType> => {
  const env = authorized(repository.env, token);

  /** `git push` of `refspec` under `lease`: `applied`, or `unchanged` where the ref was already there. */
  const push = async (call: Call, ref: string, refspec: string, lease: Lease): Promise<{ readonly outcome: "applied" | "unchanged" }> => {
    fullRef(ref);
    const output = await call("git push", async () => {
      try {
        const { stdout } = await run(
          "git",
          ["push", "--porcelain", "--no-verify", leaseArgument(ref, lease), repository.remote, refspec],
          { cwd: repository.dir, env, encoding: "utf8" },
        );
        return stdout;
      } catch (error) {
        const pushed = pushedLine(outputOf(error, "stdout"), ref);
        if (pushed !== undefined && pushed.flag === "!") {
          throw new GitError(`rejected: ${pushed.summary}`, pushed.summary.includes("stale info"));
        }
        throw new GitError(lastLine(outputOf(error, "stderr")) || (error instanceof Error ? error.message : String(error)));
      }
    });
    return { outcome: pushedLine(output, ref)?.flag === "=" ? "unchanged" : "applied" };
  };

  return {
    pushRef: (call, { ref, commit, lease }) => push(call, ref, `${commit}:${ref}`, lease),
    deleteRef: (call, { ref, lease }) => push(call, ref, `:${ref}`, lease),
  };
};

/**
 * What git can fetch for a command with a token: a read of the remote, which
 * changes nothing there, so it is no write and goes through no writer. It
 * changes only the repository it fetches into.
 */
export interface GitFetcher {
  /**
   * `ref` on the remote fetched to `into` in the repository, over whatever
   * `into` held: the commit fetched. Both are full ref names. A ref the
   * remote does not have throws, and leaves `into` as it was.
   */
  fetchRef(ref: string, into: string): Promise<string>;
}

/** The fetcher into `repository`, from `remote`, with `token`. */
export const gitFetcher = (repository: GitRepository & { readonly remote: string }, token: string): GitFetcher => {
  const env = authorized(repository.env, token);
  const git = async (args: readonly string[]): Promise<string> => {
    try {
      return (await run("git", args, { cwd: repository.dir, env, encoding: "utf8" })).stdout;
    } catch (error) {
      throw new GitError(lastLine(outputOf(error, "stderr")) || (error instanceof Error ? error.message : String(error)));
    }
  };
  return {
    fetchRef: async (ref, into) => {
      await git(["fetch", "--quiet", "--no-tags", repository.remote, `+${fullRef(ref)}:${fullRef(into)}`]);
      return (await git(["rev-parse", "--verify", `${into}^{commit}`])).trim();
    },
  };
};

/** One head a bundle carries: the ref it names, and the commit there. */
export interface BundleHead {
  readonly ref: string;
  readonly commit: string;
}

/**
 * One commit of a first-parent log: its parents, in git's order, and the
 * values of each trailer key asked for, as git's own trailer parser reads
 * them, by key, with no entry for a key the commit does not carry.
 */
export interface LoggedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly trailers: Readonly<Record<string, readonly string[]>>;
}

/** What git can tell a command without a token. */
export interface GitReader {
  /**
   * The bundle at `path` checked against the repository, which must hold
   * every commit it builds on, and unbundled into it: the heads it carries.
   * Which of them is acceptable is the caller's to decide. A bundle that does
   * not verify throws.
   */
  verifyBundle(path: string): Promise<readonly BundleHead[]>;
  /**
   * Whether `ancestor` is in `commit`'s history, `commit` itself included:
   * whether a commit builds on another. Both have to be in the repository.
   */
  isAncestor(ancestor: string, commit: string): Promise<boolean>;
  /**
   * Every path under `under` that `to` changes from `from`, in git's order:
   * which files a commit touches there. Both have to be in the repository.
   */
  changedPaths(from: string, to: string, under: string): Promise<readonly string[]>;
  /**
   * The commits of `head`'s first-parent history that `base`'s lacks, newest
   * first, as `git log --first-parent` lists them, each with the values of
   * the trailer keys in `keys`. The keys are the caller's: the engine spells
   * no record string. Both have to be in the repository.
   */
  firstParentLog(base: string, head: string, keys: readonly string[]): Promise<readonly LoggedCommit[]>;
}

/** The reader over `repository`. */
export const gitReader = (repository: GitRepository): GitReader => {
  const env = { ...repository.env, GIT_TERMINAL_PROMPT: "0" };
  const git = async (args: readonly string[]): Promise<string> => {
    try {
      return (await run("git", args, { cwd: repository.dir, env, encoding: "utf8" })).stdout;
    } catch (error) {
      throw new GitError(lastLine(outputOf(error, "stderr")) || (error instanceof Error ? error.message : String(error)));
    }
  };
  return {
    isAncestor: async (ancestor, commit) => {
      try {
        await run("git", ["merge-base", "--is-ancestor", ancestor, commit], { cwd: repository.dir, env, encoding: "utf8" });
        return true;
      } catch (error) {
        // 1 is git's "not an ancestor"; anything else is a failure to answer.
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === 1) return false;
        throw new GitError(lastLine(outputOf(error, "stderr")) || (error instanceof Error ? error.message : String(error)));
      }
    },
    changedPaths: async (from, to, under) =>
      (await git(["diff", "--name-only", "-z", from, to, "--", under])).split("\0").filter((p) => p !== ""),
    firstParentLog: async (base, head, keys) => {
      // A unit separator between fields, a group separator between a key's
      // values and a record separator between commits: none can be in a sha,
      // and git's trailer parser folds a value onto one line.
      const fields = ["%H", "%P", ...keys.map((key) => `%(trailers:key=${key},valueonly,separator=%x1d)`)];
      const log = await git(["log", "--first-parent", `--format=${fields.join("%x1f")}%x1e`, `${base}..${head}`, "--"]);
      return log
        .split("\x1e")
        .map((record) => record.replace(/^\n/, ""))
        .filter((record) => record !== "")
        .map((record) => {
          const [sha = "", parents = "", ...values] = record.split("\x1f");
          const trailers = Object.fromEntries(
            keys.flatMap((key, i) => {
              const found = (values[i] ?? "").split("\x1d").map((value) => value.trim()).filter((value) => value !== "");
              return found.length === 0 ? [] : [[key, found]];
            }),
          );
          return { sha, parents: parents.split(" ").filter((parent) => parent !== ""), trailers };
        });
    },
    verifyBundle: async (path) => {
      await git(["bundle", "verify", "--quiet", path]);
      const listed = await git(["bundle", "unbundle", path]);
      return listed
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const [commit = "", ref = ""] = line.trim().split(/\s+/);
          return { ref, commit };
        });
    },
  };
};

/** What a rewrite of commit messages came to: the new head, and how many commits it rewrote. */
export interface Rewritten {
  readonly head: string;
  readonly rewritten: number;
}

/** What git can make in a repository without a token: new commits from old ones, moving no ref. */
export interface GitRewriter {
  /**
   * Every commit in `head`'s history and in none of `exclude`'s made again
   * with its message passed through `message`: the same tree, its author and
   * committer, names, emails and dates, kept, and each parent that was
   * rewritten replaced by its rewrite, a merge's every parent included. The
   * new head, which is `head` itself where the range is empty, and how many
   * it rewrote. No ref and no working tree is touched: the commits are made
   * in the object store, and what is done with the head is the caller's.
   * What any message says is the caller's too; this spells none.
   */
  rewriteMessages(options: {
    readonly head: string;
    readonly exclude: readonly string[];
    readonly message: (message: string) => string;
  }): Promise<Rewritten>;
}

/** One person line of a raw commit, `Name <email> <seconds> <zone>`, as git's environment takes it. */
const person = (line: string): { readonly name: string; readonly email: string; readonly date: string } => {
  const match = /^(.*) <([^>]*)> (\S+ \S+)$/.exec(line);
  if (match === null) throw new GitError(`Couldn't read the person line ${JSON.stringify(line)}.`);
  return { name: match[1] ?? "", email: match[2] ?? "", date: match[3] ?? "" };
};

/** The rewriter in `repository`. */
export const gitRewriter = (repository: GitRepository): GitRewriter => {
  const env = { ...repository.env, GIT_TERMINAL_PROMPT: "0" };
  const git = async (args: readonly string[], options: { readonly env?: GitEnvironment; readonly input?: string } = {}): Promise<string> => {
    try {
      const running = run("git", args, { cwd: repository.dir, env: options.env ?? env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (options.input !== undefined) {
        // An error writing is git's to report, by its exit and its stderr.
        running.child.stdin?.on("error", () => {});
        running.child.stdin?.end(options.input);
      }
      return (await running).stdout;
    } catch (error) {
      throw new GitError(lastLine(outputOf(error, "stderr")) || (error instanceof Error ? error.message : String(error)));
    }
  };
  return {
    rewriteMessages: async ({ head: named, exclude, message }) => {
      const head = (await git(["rev-parse", "--verify", `${named}^{commit}`])).trim();
      const range = (await git(["rev-list", "--reverse", "--topo-order", head, ...exclude.map((commit) => `^${commit}`), "--"]))
        .split("\n")
        .filter((line) => line !== "");
      const rewritten = new Map<string, string>();
      for (const commit of range) {
        // The raw commit: its headers, a blank line, and its message byte for byte.
        const raw = await git(["cat-file", "commit", commit]);
        const split = raw.indexOf("\n\n");
        const headers = (split === -1 ? raw : raw.slice(0, split)).split("\n");
        const text = split === -1 ? "" : raw.slice(split + 2);
        const field = (name: string): string[] =>
          headers.filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1));
        const [tree] = field("tree");
        const [author] = field("author");
        const [committer] = field("committer");
        if (tree === undefined || author === undefined || committer === undefined) {
          throw new GitError(`Couldn't read commit ${commit}: it has no tree, author or committer.`);
        }
        const by = person(author);
        const at = person(committer);
        const parents = field("parent").flatMap((parent) => ["-p", rewritten.get(parent) ?? parent]);
        const made = await git(["commit-tree", tree, ...parents], {
          env: {
            ...env,
            GIT_AUTHOR_NAME: by.name,
            GIT_AUTHOR_EMAIL: by.email,
            GIT_AUTHOR_DATE: by.date,
            GIT_COMMITTER_NAME: at.name,
            GIT_COMMITTER_EMAIL: at.email,
            GIT_COMMITTER_DATE: at.date,
          },
          input: message(text),
        });
        rewritten.set(commit, made.trim());
      }
      return { head: rewritten.get(head) ?? head, rewritten: rewritten.size };
    },
  };
};

/** Who a merge commit is made by: the name and email git writes into it. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * What a merge of the base into a branch came to, with the base commit it
 * merged: the branch already contained it, it merged cleanly into `commit`, or
 * it stopped on the conflicts in `conflicts`, left in the working tree.
 */
export type Merged =
  | { readonly status: "uptodate"; readonly base: string }
  | { readonly status: "clean"; readonly base: string; readonly commit: string }
  | { readonly status: "conflicts"; readonly base: string; readonly conflicts: readonly string[] };

/** A fetch that failed, as against a merge that did: the remote was not read. */
export class FetchFailed extends GitError {
  constructor(message: string) {
    super(message);
    this.name = "FetchFailed";
  }
}

/** A base commit handed to a merge that the base, fetched, no longer contains. */
export class BaseMoved extends GitError {
  constructor(message: string) {
    super(message);
    this.name = "BaseMoved";
  }
}

/** What git can do for a command in its checkout with a fetch: merge the base branch in. */
export interface GitMerger {
  /**
   * The branch `base` fetched from the remote, to `refs/remotes/origin/<base>`,
   * then the commit checked out as the branch `into`, and the base merged
   * into it as `identity`. A fetch that fails throws `FetchFailed` and leaves
   * the repository as it was; a merge that fails without a conflict throws
   * `GitError`.
   *
   * With `commit`, the merge an earlier one read is made again: that commit,
   * which the base fetched has to contain, is what is merged, under the
   * base's name, so the merge and its message are the earlier one's. A base
   * that no longer contains it throws `BaseMoved`, before anything is
   * checked out.
   *
   * With `from`, the branch `into` is made at that commit, or ref, rather
   * than at the one checked out: resolved after the fetch, so the base's
   * remote-tracking name is the base as fetched. With `message`, a merge
   * commit is made with that message, and always made, never a fast-forward,
   * so a mark the message carries is never lost; without it, git writes its
   * own.
   */
  merge(options: {
    readonly base: string;
    readonly into: string;
    readonly identity: GitIdentity;
    readonly commit?: string;
    readonly from?: string;
    readonly message?: string;
  }): Promise<Merged>;
}

/**
 * The merger in `repository`, fetching with `fetcher`. Its spawns start from
 * the repository's environment, as the fetcher's do, and hold no token: only
 * the fetch reaches the remote. The identity is written to the repository's
 * config, as the shell steps before it did, so a commit made in the checkout
 * after a conflicted merge, the resolution's, is made by the same account.
 */
export const gitMerger = (repository: GitRepository, fetcher: GitFetcher): GitMerger => {
  const env = { ...repository.env, GIT_TERMINAL_PROMPT: "0" };
  const git = async (args: readonly string[]): Promise<string> => {
    try {
      return (await run("git", args, { cwd: repository.dir, env, encoding: "utf8" })).stdout;
    } catch (error) {
      throw new GitError(lastLine(outputOf(error, "stderr")) || (error instanceof Error ? error.message : String(error)));
    }
  };
  /** Whether `tip` contains `commit`; false too where the repository holds no such commit. */
  const contains = async (tip: string, commit: string): Promise<boolean> => {
    try {
      await git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
    } catch {
      return false;
    }
    try {
      await run("git", ["merge-base", "--is-ancestor", commit, tip], { cwd: repository.dir, env, encoding: "utf8" });
      return true;
    } catch (error) {
      // 1 is git's "not an ancestor"; anything else is a failure to answer.
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === 1) return false;
      throw new GitError(lastLine(outputOf(error, "stderr")) || (error instanceof Error ? error.message : String(error)));
    }
  };
  return {
    merge: async ({ base, into, identity, commit: earlier, from, message }) => {
      const tracking = `refs/remotes/origin/${base}`;
      let commit: string;
      try {
        commit = await fetcher.fetchRef(`refs/heads/${base}`, tracking);
      } catch (error) {
        throw new FetchFailed(error instanceof Error ? error.message : String(error));
      }
      if (earlier !== undefined) {
        if (!(await contains(commit, earlier))) {
          throw new BaseMoved(`\`${base}\` is at ${commit}, which does not contain ${earlier}.`);
        }
        await git(["update-ref", tracking, earlier]);
        commit = (await git(["rev-parse", "--verify", `${tracking}^{commit}`])).trim();
      }
      await git(["config", "user.name", identity.name]);
      await git(["config", "user.email", identity.email]);
      await git(["checkout", "--quiet", "-B", into, ...(from === undefined ? [] : [from])]);
      try {
        await run("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: repository.dir, env, encoding: "utf8" });
        return { status: "uptodate", base: commit };
      } catch (error) {
        // 1 is git's "not an ancestor"; anything else is a failure to answer.
        if (!(typeof error === "object" && error !== null && (error as { code?: unknown }).code === 1)) {
          throw new GitError(lastLine(outputOf(error, "stderr")) || (error instanceof Error ? error.message : String(error)));
        }
      }
      try {
        // By its full remote-tracking ref, where a tag named `origin/<base>`
        // would win over the short name (#569), and with the message a
        // person's `git merge origin/<base>` makes, which git would otherwise
        // spell with the full ref.
        const own =
          message === undefined ? ["-m", `Merge remote-tracking branch 'origin/${base}' into ${into}`] : ["--no-ff", "-m", message];
        await run("git", ["merge", "--no-edit", "--no-verify", ...own, tracking], { cwd: repository.dir, env, encoding: "utf8" });
      } catch (error) {
        const conflicts = (await git(["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter((p) => p !== "");
        if (conflicts.length > 0) return { status: "conflicts", base: commit, conflicts };
        throw new GitError(lastLine(outputOf(error, "stderr")) || lastLine(outputOf(error, "stdout")) || (error instanceof Error ? error.message : String(error)));
      }
      return { status: "clean", base: commit, commit: (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim() };
    },
  };
};
