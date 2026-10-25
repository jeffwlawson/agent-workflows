/**
 * A bubblewrap sandbox, as an **isolated** Sandcastle provider: the agent runs
 * in a namespace of its own on the host, sees a copy of the checkout rather
 * than the checkout, and hands its work back through the copy-out below.
 *
 * Isolated, not bind-mount, on purpose. Sandcastle hands a bind-mount provider
 * the host repository's `.git` read-write, and host-side git afterwards runs
 * whatever the agent planted there (sandcastle#1010, reproduced on #364 by two
 * routes). Isolated mode never shares `.git`: Sandcastle copies a bundle in
 * and patches out, through `copyIn` and `copyFileOut`.
 *
 * Each run gets a private directory on the host, holding the sandbox's
 * `/home/agent` and `/tmp`. Every `exec` is a fresh `bwrap` over those two
 * binds, so state lives in the files and nowhere else. The rest of the host is
 * invisible but `/usr`, a few named files under `/etc`, and the read-only
 * directories the settings name for the toolchain.
 *
 * What the checkout holds outside git, the dependencies and build output the
 * repository's setup left there, is carried in as well: Sandcastle fills the
 * worktree from a bundle, which holds only history, so without it the agent
 * would work without what its verify command needs. The provider copies each
 * untracked path into the sandbox's home as it is created, and `CARRY_HOOKS`,
 * which the run is started with, links them into the worktree once Sandcastle
 * has cloned it there. Each is excluded there too, so Sandcastle's copy-out,
 * which hands back every untracked path that is not ignored, never takes what
 * was carried in for the agent's own work.
 *
 * The sandbox's network is its own loopback and nothing else (#461), so the
 * proxy its settings name is the only way out rather than a variable a tool
 * may ignore. For the life of each sandbox a host end (`proxy-relay.ts`)
 * listens on a socket private to it and forwards to the proxy, and every
 * `exec` binds the socket in and starts the inside end before its command.
 *
 * Engine code (ADR 0005): it knows nothing of the loop and reads no
 * environment. Its settings are arguments, and the agent driver hands them in.
 * It uses the host's temporary directory as Sandcastle does, since Sandcastle
 * writes its session files there and the guard below has to find them.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { createIsolatedSandboxProvider } from "@ai-hero/sandcastle";
import { bwrapArgs, SANDBOX_HOME, SANDBOX_WORKTREE } from "./bwrap-args.js";
import { startProxyRelay } from "./proxy-relay.js";

/** What a `bwrap` sandbox is given, beyond what Sandcastle hands each run. */
export interface BwrapSettings {
  /** Host directories bound read-only at the same path inside: the toolchain, `claude` and `node`. */
  readonly roBinds: readonly string[];
  /** `PATH` inside the sandbox. */
  readonly path: string;
  /**
   * The proxy every request leaves through: an `http:` URL with a host, never
   * `https:`, since the sandbox names it by a loopback address its certificate
   * would not name (#535), and the sandbox's only way out. Required, since a sandbox with a
   * network of its own and no proxy reaches nothing, the model's API included.
   */
  readonly proxy: string;
  /** The host directory the run starts in, the repository Sandcastle writes its patches under. */
  readonly repoDir: string;
  /** The host's home, under which Sandcastle looks for a session before it resumes one. */
  readonly homeDir: string;
}

const HOME = SANDBOX_HOME;
/**
 * Where, in the sandbox's home, the checkout's untracked paths wait for the
 * worktree: outside it, since Sandcastle replaces the worktree with its clone.
 */
const CARRY = `${HOME}/.carry`;
/**
 * The carried paths as exclude patterns, one a line, waiting beside them for
 * the worktree's `info/exclude`.
 */
const CARRY_EXCLUDE = `${HOME}/.carry-exclude`;
/** Sandcastle's own directory in the checkout, its worktrees and patches: never carried. */
const SANDCASTLE_DIR = ".sandcastle";
/** Room for `git ls-files`' list of a checkout's untracked paths. */
const LIST_BUFFER = 64 * 1024 * 1024;
/** Output kept per stream for the result; `onLine` sees everything. */
const TAIL = 1_000_000;

/** Map a sandbox path to the host path that backs it, or refuse. */
export const toHost = (root: string, sandboxPath: string): string => {
  const p = path.posix.normalize(sandboxPath);
  if (p === HOME || p.startsWith(`${HOME}/`)) return path.join(root, "home", p.slice(HOME.length));
  if (p === "/tmp" || p.startsWith("/tmp/")) return path.join(root, "tmp", p.slice("/tmp".length));
  throw new Error(`bwrap: ${sandboxPath} is outside the sandbox's writable paths`);
};

const within = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Where `copyFileOut` may write on the host, and nowhere else: the sandbox
 * chooses the file names, so this is the guard.
 *
 * Sandcastle writes a run's patches and untracked files under
 * `<hostRepoDir>/.sandcastle/patches/<run>/…`, and an isolated run's
 * `hostRepoDir` is its host worktree, `<repo>/.sandcastle/worktrees/<name>`.
 * So, relative to `<repoDir>/.sandcastle`, exactly `patches/<run>/…` or
 * `worktrees/<name>/.sandcastle/patches/<run>/…`. Session logs go to
 * `<tmpdir>/sandcastle-*.jsonl`. Any `.git` component is refused outright.
 */
export const assertHostTarget = (repoDir: string, hostPath: string): void => {
  const abs = path.resolve(hostPath);
  if (abs.split(path.sep).includes(".git")) throw new Error(`bwrap: refusing to write into .git: ${abs}`);
  const root = path.join(path.resolve(repoDir), ".sandcastle");
  const rel = within(abs, root) ? path.relative(root, abs).split(path.sep) : [];
  const inPatches =
    (rel[0] === "patches" && rel.length >= 3) ||
    (rel[0] === "worktrees" && rel[2] === ".sandcastle" && rel[3] === "patches" && rel.length >= 6);
  const isSession = path.dirname(abs) === path.resolve(tmpdir()) && /^sandcastle-[\w.-]+\.jsonl$/.test(path.basename(abs));
  if (!inPatches && !isSession) throw new Error(`bwrap: refusing to write outside the patch directory: ${abs}`);
};

/**
 * What the checkout at `repoDir` holds outside git, each path relative to it:
 * everything untracked, ignored or not, with a wholly untracked directory
 * named once, and Sandcastle's own directory left out. What the agent would
 * see in the checkout itself, with no sandbox, beside what git checks out.
 */
export const untrackedPaths = async (repoDir: string): Promise<string[]> => {
  const { stdout } = await promisify(execFile)("git", ["-C", repoDir, "ls-files", "-z", "--others", "--directory"], {
    maxBuffer: LIST_BUFFER,
  });
  return stdout
    .split("\0")
    .map((entry) => entry.replace(/\/$/, ""))
    .filter((entry) => entry !== "" && entry !== SANDCASTLE_DIR && !entry.startsWith(`${SANDCASTLE_DIR}/`));
};

/**
 * Whether `entry` can be carried: a name with a line break in it cannot be
 * written as an exclude pattern, and Sandcastle's copy-out, which reads `git
 * ls-files` a line at a time, could not name it either, so it is left behind.
 */
export const carriable = (entry: string): boolean => !/[\n\r]/.test(entry);

/**
 * The `info/exclude` line that matches `entry`, a path relative to the
 * worktree, and nothing else: anchored at the worktree's root, with every
 * character a pattern reads specially, and a trailing space, escaped.
 */
export const excludePattern = (entry: string): string =>
  `/${entry.replace(/[\\*?[!#]/g, "\\$&").replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "))}`;

/**
 * The hooks a run in this provider is started with: once Sandcastle has cloned
 * the worktree, the carried paths are hard-linked into it, so the copy is made
 * once, on the host, and the staging directory removed; and their patterns
 * appended to the worktree's `info/exclude`, so Sandcastle's copy-out, which
 * takes every untracked path that is not ignored, takes none of them. Without
 * it a carried symlink pointing out of the sandbox, or at nothing, fails the
 * copy-out and the agent's commits with it, and every other carried file is
 * copied back over the checkout's own. A command of its own, with no path in
 * it: the paths it moves are the checkout's, so none of them is ever a word of
 * a command line.
 */
export const CARRY_HOOKS = {
  sandbox: {
    onSandboxReady: [
      {
        command:
          `if [ -d ${CARRY} ]; then cp -al ${CARRY}/. . && rm -rf ${CARRY}; fi && ` +
          `if [ -f ${CARRY_EXCLUDE} ]; then exclude="$(git rev-parse --git-path info/exclude)" && ` +
          `mkdir -p "$(dirname "$exclude")" && cat ${CARRY_EXCLUDE} >> "$exclude" && rm -f ${CARRY_EXCLUDE}; fi`,
        timeoutMs: 10 * 60_000,
      },
    ],
  },
} as const;

const sessionsIn = (root: string): string => path.join(root, "home", ".claude", "projects");

/** Sandcastle's own naming for a session file's directory (its `encodeProjectPath`). */
const encodeProjectPath = (cwd: string): string => cwd.replace(/[\\/]+$/, "").replace(/[\\/]/g, "-");

/**
 * The provider. One instance carries the agent's session from one run to the
 * next, so a runner's two passes have to share it, as the agent driver's do.
 *
 * Sandcastle 0.12.0 captures and restores agent sessions for bind-mount
 * providers only, so resuming fails against any isolated provider. The
 * runners depend on it: a structured result is extracted by resuming the work
 * session for a second, format-only pass. So this provider carries sessions
 * itself: on close it keeps the sandbox's `~/.claude/projects`, and seeds the
 * next sandbox with it. The sandbox's working directory is the same path every
 * time, so the session paths line up. It also writes the host-side copy
 * Sandcastle checks for before resuming.
 */
export const bwrap = (settings: BwrapSettings) => {
  let sessionStore: string | undefined;

  const keepSessions = async (root: string): Promise<void> => {
    const from = sessionsIn(root);
    if (!existsSync(from)) return;
    sessionStore ??= await mkdtemp(path.join(tmpdir(), "bwrap-sessions-"));
    await cp(from, sessionStore, { recursive: true });
    const hostDir = path.join(settings.homeDir, ".claude", "projects", encodeProjectPath(settings.repoDir));
    for (const dir of await readdir(from)) {
      for (const file of await readdir(path.join(from, dir))) {
        if (!/^[\w-]+\.jsonl$/.test(file)) continue;
        await mkdir(hostDir, { recursive: true });
        await cp(path.join(from, dir, file), path.join(hostDir, file));
      }
    }
  };

  return createIsolatedSandboxProvider({
    name: "bwrap",
    create: async ({ env }) => {
      // Resolved, so the symlink check in `copyFileOut` compares like with like.
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "bwrap-job-")));
      await mkdir(path.join(root, "home", "workspace"), { recursive: true });
      await mkdir(path.join(root, "tmp"), { recursive: true });
      if (sessionStore !== undefined) await cp(sessionStore, sessionsIn(root), { recursive: true });
      // Copied, never linked, from the checkout: what the agent changes stays
      // in the sandbox. A symlink is copied as the link it is, never followed,
      // so one setup left pointing at a host file brings nothing of it in.
      const carried = (await untrackedPaths(settings.repoDir)).filter(carriable);
      for (const entry of carried) {
        const target = toHost(root, path.posix.join(CARRY, entry));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(settings.repoDir, entry), target, { recursive: true, verbatimSymlinks: true });
      }
      if (carried.length > 0) {
        await writeFile(toHost(root, CARRY_EXCLUDE), carried.map((entry) => `${excludePattern(entry)}\n`).join(""));
      }
      const relay = await startProxyRelay(settings.proxy).catch(async (error: unknown) => {
        await rm(root, { recursive: true, force: true });
        throw new Error(`bwrap: ${error instanceof Error ? error.message : String(error)}`);
      });

      const args = (cwd: string): string[] =>
        bwrapArgs({
          home: path.join(root, "home"),
          tmp: path.join(root, "tmp"),
          roBinds: settings.roBinds,
          cwd,
          path: settings.path,
          relay: { socket: relay.socket, proxy: settings.proxy },
          env: {
            // Telemetry and the auto-updater reach hosts no egress allowlist
            // should need to name; the agent's own work needs only the API.
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            ...env,
          },
        });

      return {
        worktreePath: SANDBOX_WORKTREE,

        exec: (command, opts) =>
          new Promise((resolve, reject) => {
            // No sudo in here: the sandbox has no root to give. Sandcastle
            // itself never asks for it (`sudo: true` appears nowhere in 0.12.0).
            const child = spawn("bwrap", [...args(opts?.cwd ?? SANDBOX_WORKTREE), "sh", "-c", command], {
              stdio: [opts?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            });
            const { stdout: out, stderr: err } = child;
            if (out === null || err === null) return reject(new Error("bwrap: no output pipes"));
            let stdout = "";
            let stderr = "";
            createInterface({ input: out }).on("line", (line) => {
              if (stdout.length < TAIL) stdout += `${line}\n`;
              opts?.onLine?.(line);
            });
            err.on("data", (d: Buffer) => {
              if (stderr.length < TAIL) stderr += d.toString();
            });
            if (opts?.stdin !== undefined) child.stdin?.end(opts.stdin);
            child.on("error", reject);
            child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
          }),

        copyIn: async (hostPath, sandboxPath) => {
          const target = toHost(root, sandboxPath);
          await mkdir(path.dirname(target), { recursive: true });
          await cp(hostPath, target, { recursive: true });
        },

        copyFileOut: async (sandboxPath, hostPath) => {
          assertHostTarget(settings.repoDir, hostPath);
          // Resolve symlinks on the host side: a link the agent made to a host
          // file would otherwise copy that file out of the host, not the sandbox.
          const source = await realpath(toHost(root, sandboxPath));
          if (!within(source, root)) throw new Error(`bwrap: ${sandboxPath} resolves outside the sandbox`);
          await mkdir(path.dirname(hostPath), { recursive: true });
          await cp(source, hostPath);
        },

        close: async () => {
          await relay.close();
          await keepSessions(root);
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
};
