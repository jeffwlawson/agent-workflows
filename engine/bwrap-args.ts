/**
 * The arguments a bubblewrap sandbox is started with: the one description of
 * what a sandbox sees, shared by the agent's provider (`bwrap.ts`) and anything
 * else run in a sandbox of the same shape, such as a repository's setup. Here,
 * apart from the provider, so a caller that runs no agent need not load the
 * agent SDK to start one.
 *
 * Engine code (ADR 0005): it reads no environment. What a sandbox gets is an
 * argument, and the host directories it binds are the caller's.
 */
import { existsSync } from "node:fs";

/** The sandbox's home, backed by a host directory of the caller's. */
export const SANDBOX_HOME = "/home/agent";

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

/** What one sandbox sees, and where it starts. */
export interface SandboxLayout {
  /** The host directory bound at `SANDBOX_HOME`. */
  readonly home: string;
  /** The host directory bound at `/tmp`. */
  readonly tmp: string;
  /** Host directories bound read-write at the same path inside, after the home and `/tmp`. */
  readonly binds?: readonly string[];
  /**
   * Host directories bound read-only at the same path inside, after every
   * writable bind: the toolchain, and anything inside a writable bind that
   * is to stay read-only, since a later mount over the same tree wins.
   */
  readonly roBinds: readonly string[];
  /** The directory inside the sandbox it starts in. */
  readonly cwd: string;
  /** `PATH` inside the sandbox. */
  readonly path: string;
  /** The proxy every request leaves through, set as every proxy variable. Absent is none. */
  readonly proxy?: string;
  /** The rest of the sandbox's environment, set after its own. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * `bwrap`'s arguments for `layout`, up to the command it runs, which follows
 * them. The sandbox shares the host's network and nothing else: its
 * environment is cleared and set from `layout` alone, it sees `/usr`, a few
 * named files under `/etc` and the directories `layout` binds, and it ends
 * with the process that started it.
 */
export const bwrapArgs = (layout: SandboxLayout): string[] => {
  const { proxy } = layout;
  const proxyVars =
    proxy === undefined ? [] : ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].flatMap((name) => ["--setenv", name, proxy]);
  return [
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
    // Writable state, before the read-only binds: a later mount over the same
    // tree wins, and a tmpfs over /home would hide them.
    "--tmpfs", "/home",
    "--bind", layout.home, SANDBOX_HOME,
    "--bind", layout.tmp, "/tmp",
    ...(layout.binds ?? []).flatMap((p) => ["--bind", p, p]),
    ...layout.roBinds.flatMap((p) => ["--ro-bind", p, p]),
    "--chdir", layout.cwd,
    "--setenv", "HOME", SANDBOX_HOME,
    "--setenv", "PATH", layout.path,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "TMPDIR", "/tmp",
    ...proxyVars,
    ...Object.entries(layout.env).flatMap(([k, v]) => ["--setenv", k, v]),
  ];
};
