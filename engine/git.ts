/**
 * The engine's door to git, beside `github.ts`'s door to GitHub's API: the
 * write types git makes (`pushRef`, `deleteRef`), and a bundle check, which
 * is a read and holds no token.
 *
 * Each runs `git` in a repository the backend is bound to, with the
 * environment it is handed and only two additions: `GIT_TERMINAL_PROMPT=0`,
 * and, on a write, the token as an `http.extraHeader` set through
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

/**
 * The git writes, pushing to `remote` from `repository` with `token`. A ref is
 * a full ref name, since git takes a commit pushed to a bare name only where
 * the ref already exists.
 */
export const gitWrites = (repository: GitRepository & { readonly remote: string }, token: string): Pick<Backend, GitWriteType> => {
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = {
    ...repository.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
  };

  /** `git push` of `refspec` under `lease`: `applied`, or `unchanged` where the ref was already there. */
  const push = async (call: Call, ref: string, refspec: string, lease: Lease): Promise<{ readonly outcome: "applied" | "unchanged" }> => {
    if (!ref.startsWith("refs/")) throw new GitError(`\`${ref}\` is not a full ref name; name it as \`refs/heads/${ref}\`.`);
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

/** One head a bundle carries: the ref it names, and the commit there. */
export interface BundleHead {
  readonly ref: string;
  readonly commit: string;
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
