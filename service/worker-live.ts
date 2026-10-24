import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bwrapArgs } from "../engine/bwrap-args.js";
import type { HostEnvironment } from "../shared/env.js";
import { sign, SIGNATURE_HEADER, type TokenKind } from "./job.js";
import type { Git, Launcher, Sandbox, TokenSource } from "./worker.js";

/**
 * The worker's edges, live: the dispatcher's token door over HTTP, each
 * subcommand a child process of the worker's own package, the sandbox the
 * repository's setup runs in, git, and the install of the agent's CLI. `runJob` in `worker.ts` decides; these do.
 */

const run = promisify(execFile);

// Node's own since v24.14.0, which `engines` requires; declared here until the
// `@types/node` this package builds with names it.
declare module "node:http" {
  function setGlobalProxyFromEnv(proxyEnv?: Readonly<Record<string, string | undefined>>): () => void;
}

/**
 * Every request of the worker's own, through `host`'s proxy where it has one
 * (#460): the token requests, and any request added later, since it is set
 * once, for the whole process, through Node's built-in proxy support rather
 * than per request. Read from `host`, never from the worker's environment,
 * and with no `NO_PROXY`, so none bypasses it. Answers what undoes it.
 */
export const routeThroughProxy = (host: HostEnvironment): (() => void) =>
  http.setGlobalProxyFromEnv({
    ...(host.HTTP_PROXY === undefined ? {} : { HTTP_PROXY: host.HTTP_PROXY }),
    ...(host.HTTPS_PROXY === undefined ? {} : { HTTPS_PROXY: host.HTTPS_PROXY }),
    NO_PROXY: "",
    no_proxy: "",
  });

/** The worker's own package's CLI, so every subcommand it starts is its own release (spec §5). */
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/** A token for one phase of `jobId`, asked of the dispatcher's token door and signed with the shared secret. */
export const liveTokens =
  (url: string, secret: string, jobId: string): TokenSource =>
  async (kind: TokenKind) => {
    const body = JSON.stringify({ jobId, kind });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(secret, body) },
      body,
    });
    const reply: unknown = await response.json().catch(() => null);
    const field = (name: string): unknown =>
      typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>)[name] : undefined;
    const token = field("token");
    if (response.status !== 200 || typeof token !== "string") {
      const refusal = field("refusal");
      throw new Error(`the dispatcher answered ${response.status}${typeof refusal === "string" ? `: ${refusal}` : ""}`);
    }
    return token;
  };

/** How long a subcommand ended by its time limit is given to exit before it is killed. */
const KILL_GRACE_MS = 10_000;

/**
 * `command` with `args`, in `cwd`, with `env` and nothing else, its output
 * appended to `log`, answering its exit code once it has ended.
 *
 * It is the leader of a process group of its own, so where `signal` aborts
 * the whole group is ended, it and every process it started: `SIGTERM`, then
 * `SIGKILL` for what is still there after `KILL_GRACE_MS`.
 */
const spawnGroup = (
  command: string,
  args: readonly string[],
  { cwd, env, log, signal }: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly log: string; readonly signal: AbortSignal },
): Promise<number> =>
  new Promise((resolve, reject) => {
    const out = fs.openSync(log, "a");
    // A child that fails to start can say so twice, `error` then `close`:
    // the log is closed, and the answer given, once.
    let ended = false;
    const end = (settle: () => void): void => {
      if (ended) return;
      ended = true;
      fs.closeSync(out);
      settle();
    };
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", out, out], detached: true });
    const group = (kill: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, kill);
      } catch {
        // The group has gone already.
      }
    };
    let killer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      group("SIGTERM");
      killer = setTimeout(() => group("SIGKILL"), KILL_GRACE_MS);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    const settle = (then: () => void): void => {
      signal.removeEventListener("abort", stop);
      if (killer !== undefined) clearTimeout(killer);
      end(then);
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code) => settle(() => resolve(code ?? 1)));
  });

/**
 * Each subcommand as `node <the package's cli.js> <subcommand>`, in its
 * working directory, with the environment it is handed and nothing else, its
 * output appended to its log, ended with the agent and every process it
 * started where its time limit aborts `signal`.
 */
export const liveLauncher: Launcher = ({ subcommand, env, cwd, log, signal }) =>
  spawnGroup(process.execPath, [CLI, subcommand], { cwd, env, log, signal });

/**
 * The shell command the sandbox runs a script with: Actions' own for a `run:`
 * step, bash without its startup files, stopping at the first failure,
 * including one inside a pipe. The script is read from the environment, so
 * nothing of it is ever a word of a command line.
 */
export const SETUP_SHELL = ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", 'eval "$AGENT_SETUP"'] as const;

/**
 * The repository's setup in a bwrap sandbox of its own, on the worker's host
 * only as the sandbox's parent, never as its shell (#522): the agent's shape
 * (`engine/bwrap-args.ts`) but for its network, which is the host's, with the
 * proxy set as its proxy variables rather than its only way out (#461). The
 * checkout is bound read-write at the path the worker gives, where the agent
 * will work (#526), and its `.git` read-only inside it, so a setup that runs the pull request's code cannot plant a hook or a
 * configuration that host-side git, holding a token later, would run. Its
 * home and `/tmp` are fresh and removed after. Its
 * environment is the sandbox's own and `AGENT_SETUP`, so no token, and nothing
 * else of the worker's, reaches it. `bwrap` is found on `host`'s `PATH`.
 */
export const liveSandbox =
  (host: HostEnvironment): Sandbox =>
  async ({ script, dir, at, roBinds, path: sandboxPath, proxy, log, signal }) => {
    const state = await mkdtemp(path.join(tmpdir(), "agent-setup-"));
    try {
      const home = path.join(state, "home");
      const tmp = path.join(state, "tmp");
      fs.mkdirSync(home);
      fs.mkdirSync(tmp);
      const git = path.join(dir, ".git");
      const args = bwrapArgs({
        home,
        tmp,
        binds: [{ host: dir, at }],
        roBinds: [...(fs.existsSync(git) ? [{ host: git, at: path.join(at, ".git") }] : []), ...roBinds],
        cwd: at,
        path: sandboxPath,
        ...(proxy === undefined ? {} : { proxy }),
        env: { AGENT_SETUP: script },
      });
      return await spawnGroup("bwrap", [...args, ...SETUP_SHELL], { cwd: dir, env: { ...host }, log, signal });
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  };

/**
 * The checkout, with the token passed to each fetch as a header in the
 * command's own environment (`GIT_CONFIG_*`), so it is neither in the
 * checkout's configuration, where the agent could read it, nor in a process
 * listing's arguments. The committer's name and its no-reply address are the
 * one thing it configures there, as `fix.yml`'s checkout step does: the
 * agent's commits need a name, and the sandbox's home has no git config.
 */
export const liveGit = (host: HostEnvironment): Git => ({
  checkout: async ({ dir, repo, branch, sha, baseRef, token, committer, signal }) => {
    const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
    const env = { ...host, GIT_TERMINAL_PROMPT: "0" };
    const withToken = {
      ...env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
    };
    // An initial branch no pull request's base can be named, so the base's
    // fetch into its own local branch never meets the one checked out.
    await run("git", ["init", "--quiet", "--initial-branch=agent-workflows-unborn", dir], { env, signal });
    await run("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${repo}.git`], { env, signal });
    await run(
      "git",
      ["-C", dir, "fetch", "--quiet", "--no-tags", "origin", `+${sha}:refs/remotes/origin/${branch}`, `+refs/heads/${baseRef}:refs/heads/${baseRef}`],
      { env: withToken, signal },
    );
    await run("git", ["-C", dir, "checkout", "--quiet", "-B", branch, sha], { env, signal });
    await run("git", ["-C", dir, "config", "user.name", committer], { env, signal });
    await run("git", ["-C", dir, "config", "user.email", `${committer}@users.noreply.github.com`], { env, signal });
  },
});

/**
 * The agent's CLI, installed at `version` into `prefix`, the worker's own, so
 * the host's `claude` is never the one a review runs. Answers the directory
 * its `claude` is in, once that answers to its version.
 */
export const installCli = async (prefix: string, version: string, host: HostEnvironment): Promise<string> => {
  fs.mkdirSync(prefix, { recursive: true });
  try {
    await run("npm", ["install", "--prefix", prefix, "--no-save", "--no-fund", "--no-audit", `@anthropic-ai/claude-code@${version}`], {
      env: { ...host },
    });
  } catch (error) {
    throw new Error(`Installing \`@anthropic-ai/claude-code@${version}\` failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bin = path.join(prefix, "node_modules", ".bin");
  const { stdout } = await run(path.join(bin, "claude"), ["--version"], { env: { ...host } });
  if (!stdout.includes(version)) throw new Error(`The installed \`claude\` answers ${stdout.trim()}, not ${version}.`);
  return bin;
};
