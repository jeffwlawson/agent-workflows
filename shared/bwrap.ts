// PROTOTYPE (#364): a bubblewrap sandbox as an *isolated* Sandcastle provider.
//
// Isolated, not bind-mount, on purpose: Sandcastle hands a bind-mount provider
// the host repo's `.git` read-write, and host-side git afterwards runs whatever
// the agent planted there (sandcastle#1010; reproduced on #364 by two routes).
// Isolated mode never shares `.git`: Sandcastle copies a bundle in and patches
// out, through `copyIn` and `copyFileOut` below.
//
// Each job gets a private directory on the host, holding the sandbox's /home/agent
// and /tmp. Every `exec` is a fresh `bwrap` over those two binds, so state lives
// in the files and nowhere else. The rest of the host is invisible except /usr,
// a few named files under /etc, and the read-only directories the orchestrator
// names for the toolchain (`AGENT_SANDBOX_RO_BINDS`).

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createIsolatedSandboxProvider } from "@ai-hero/sandcastle";

const HOME = "/home/agent";
const WORKTREE = `${HOME}/workspace`;
/** Output kept per stream for the result; `onLine` sees everything. */
const TAIL = 1_000_000;

/** Files under /etc the toolchain needs: TLS roots, DNS, the user's name. */
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

const list = (v: string | undefined): string[] => (v ?? "").split(":").filter((s) => s !== "");

/** Map a sandbox path to the host path that backs it, or refuse. */
const toHost = (root: string, sandboxPath: string): string => {
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
 * Where `copyFileOut` may write on the host. Sandcastle writes patches and
 * untracked files under `<repo>/.sandcastle/patches/…` and session logs to
 * `<tmpdir>/sandcastle-*.jsonl`, and the sandbox chooses the names in both, so
 * anything else, and any `.git` component, is refused before a byte is copied.
 */
const assertHostTarget = (hostPath: string): void => {
  const abs = path.resolve(hostPath);
  const parts = abs.split(path.sep);
  if (parts.includes(".git")) throw new Error(`bwrap: refusing to write into .git: ${abs}`);
  const patches = path.join(process.cwd(), ".sandcastle");
  const inPatches = within(abs, patches) && parts.includes("patches");
  const isSession = path.dirname(abs) === path.resolve(tmpdir()) && /^sandcastle-[\w.-]+\.jsonl$/.test(path.basename(abs));
  if (!inPatches && !isSession) throw new Error(`bwrap: refusing to write outside the patch directory: ${abs}`);
};

/**
 * Sandcastle 0.12.0 captures and restores agent sessions for bind-mount
 * providers only (`bindMountHandle` in its `run`), so `resumeSession` fails
 * against any isolated provider, Vercel and Daytona included. The runners
 * depend on it: `runWithExtraction` resumes the work session for a second,
 * format-only pass. So this provider carries sessions itself: on close it keeps
 * the sandbox's `~/.claude/projects`, and seeds the next sandbox with it. The
 * sandbox's cwd is the same path every time, so the session paths line up.
 * It also writes the host-side copy Sandcastle checks for before resuming.
 */
let sessionStore: string | undefined;
const sessionsIn = (root: string): string => path.join(root, "home", ".claude", "projects");

/** Sandcastle's own naming for a session file's directory (`encodeProjectPath`). */
const encodeProjectPath = (cwd: string): string => cwd.replace(/[\\/]+$/, "").replace(/[\\/]/g, "-");

const keepSessions = async (root: string): Promise<void> => {
  const from = sessionsIn(root);
  if (!existsSync(from)) return;
  sessionStore ??= await mkdtemp(path.join(tmpdir(), "bwrap-sessions-"));
  await cp(from, sessionStore, { recursive: true });
  const hostDir = path.join(process.env["HOME"] ?? tmpdir(), ".claude", "projects", encodeProjectPath(process.cwd()));
  for (const dir of await readdir(from)) {
    for (const file of await readdir(path.join(from, dir))) {
      if (!/^[\w-]+\.jsonl$/.test(file)) continue;
      await mkdir(hostDir, { recursive: true });
      await cp(path.join(from, dir, file), path.join(hostDir, file));
    }
  }
};

export const bwrap = () =>
  createIsolatedSandboxProvider({
    name: "bwrap",
    create: async ({ env }) => {
      const root = await mkdtemp(path.join(tmpdir(), "bwrap-job-"));
      await mkdir(path.join(root, "home", "workspace"), { recursive: true });
      await mkdir(path.join(root, "tmp"), { recursive: true });
      if (sessionStore !== undefined) await cp(sessionStore, sessionsIn(root), { recursive: true });

      const roBinds = list(process.env["AGENT_SANDBOX_RO_BINDS"]);
      const sandboxPath = process.env["AGENT_SANDBOX_PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
      const proxy = process.env["AGENT_SANDBOX_PROXY"];

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
        ...roBinds.flatMap((p) => ["--ro-bind", p, p]),
        "--chdir", cwd,
        "--setenv", "HOME", HOME,
        "--setenv", "PATH", sandboxPath,
        "--setenv", "LANG", "C.UTF-8",
        "--setenv", "TMPDIR", "/tmp",
        ...(proxy === undefined ? [] : ["--setenv", "HTTPS_PROXY", proxy, "--setenv", "HTTP_PROXY", proxy]),
        ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
      ];

      return {
        worktreePath: WORKTREE,

        exec: (command, opts) =>
          new Promise((resolve, reject) => {
            // No sudo in here: the sandbox has no root to give. Sandcastle itself
            // never asks for it (`sudo: true` appears nowhere in 0.12.0).
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
          assertHostTarget(hostPath);
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
