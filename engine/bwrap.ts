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
 * Engine code (ADR 0005): it knows nothing of the loop and reads no
 * environment. Its settings are arguments, and the agent driver hands them in.
 * It uses the host's temporary directory as Sandcastle does, since Sandcastle
 * writes its session files there and the guard below has to find them.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { createIsolatedSandboxProvider } from "@ai-hero/sandcastle";

/** What a `bwrap` sandbox is given, beyond what Sandcastle hands each run. */
export interface BwrapSettings {
  /** Host directories bound read-only at the same path inside: the toolchain, `claude` and `node`. */
  readonly roBinds: readonly string[];
  /** `PATH` inside the sandbox. */
  readonly path: string;
  /** The proxy every request leaves through, set as every proxy variable. Absent is none. */
  readonly proxy?: string;
  /** The host directory the run starts in, the repository Sandcastle writes its patches under. */
  readonly repoDir: string;
  /** The host's home, under which Sandcastle looks for a session before it resumes one. */
  readonly homeDir: string;
}

const HOME = "/home/agent";
const WORKTREE = `${HOME}/workspace`;
/** Output kept per stream for the result; `onLine` sees everything. */
const TAIL = 1_000_000;

/** Files under `/etc` the toolchain needs: TLS roots, DNS, the user's name. */
const ETC = [
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/alternatives",
];

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

  const { proxy } = settings;
  const proxyVars =
    proxy === undefined ? [] : ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].flatMap((name) => ["--setenv", name, proxy]);

  return createIsolatedSandboxProvider({
    name: "bwrap",
    create: async ({ env }) => {
      // Resolved, so the symlink check in `copyFileOut` compares like with like.
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "bwrap-job-")));
      await mkdir(path.join(root, "home", "workspace"), { recursive: true });
      await mkdir(path.join(root, "tmp"), { recursive: true });
      if (sessionStore !== undefined) await cp(sessionStore, sessionsIn(root), { recursive: true });

      const args = (cwd: string): string[] => [
        "--unshare-all",
        "--share-net",
        "--die-with-parent",
        "--new-session",
        "--cap-drop", "ALL",
        "--hostname", "sandbox",
        "--clearenv",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin",
        "--symlink", "usr/lib", "/lib",
        ...(existsSync("/usr/lib64") ? ["--symlink", "usr/lib64", "/lib64"] : []),
        ...ETC.filter((p) => existsSync(p)).flatMap((p) => ["--ro-bind", p, p]),
        "--dev", "/dev",
        "--proc", "/proc",
        // Writable state, before the read-only toolchain binds: a later mount
        // over the same tree wins, and a tmpfs over /home would hide them.
        "--tmpfs", "/home",
        "--bind", path.join(root, "home"), HOME,
        "--bind", path.join(root, "tmp"), "/tmp",
        ...settings.roBinds.flatMap((p) => ["--ro-bind", p, p]),
        "--chdir", cwd,
        "--setenv", "HOME", HOME,
        "--setenv", "PATH", settings.path,
        "--setenv", "LANG", "C.UTF-8",
        "--setenv", "TMPDIR", "/tmp",
        ...proxyVars,
        // Telemetry and the auto-updater reach hosts no egress allowlist should
        // need to name; the agent's own work needs only the API.
        "--setenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1",
        "--setenv", "DISABLE_AUTOUPDATER", "1",
        ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
      ];

      return {
        worktreePath: WORKTREE,

        exec: (command, opts) =>
          new Promise((resolve, reject) => {
            // No sudo in here: the sandbox has no root to give. Sandcastle
            // itself never asks for it (`sudo: true` appears nowhere in 0.12.0).
            const child = spawn("bwrap", [...args(opts?.cwd ?? WORKTREE), "sh", "-c", command], {
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
          await keepSessions(root);
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
};
