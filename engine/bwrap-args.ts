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
import { fileURLToPath } from "node:url";
import { insideProxy, RELAY_PORT } from "./proxy-relay.js";

/** The sandbox's home, backed by a host directory of the caller's. */
export const SANDBOX_HOME = "/home/agent";

/**
 * Where the agent works inside its sandbox, and so where the repository's
 * setup sees the checkout when the agent works in a copy of it (#526).
 */
export const SANDBOX_WORKTREE = `${SANDBOX_HOME}/workspace`;

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

/**
 * Where the way out is bound inside a sandbox with a network of its own: the
 * host end's socket, the inside end (`relay.mjs`) and the Node that runs it,
 * which is the host's own, so the relay needs no `node` on the sandbox's
 * `PATH`.
 */
const RELAY_DIR = "/run/proxy-relay";
const RELAY_SOCKET = `${RELAY_DIR}/proxy.sock`;
const RELAY_SCRIPT = `${RELAY_DIR}/relay.mjs`;
const RELAY_NODE = `${RELAY_DIR}/node`;
/** The inside end, beside this module in a checkout and in `dist/` alike. */
const RELAY_SOURCE = fileURLToPath(new URL("./relay.mjs", import.meta.url));

/** A sandbox's way out when its network is its own: a host end's socket, leading to `proxy`. */
export interface Relay {
  /** The host path of the socket the host end listens on (`startProxyRelay`). */
  readonly socket: string;
  /** The proxy the host end forwards to, as configured: an `http:` URL, whose user-info carries inside. */
  readonly proxy: string;
}

/**
 * A host directory and where it is seen inside: a bare path at the same path,
 * or `host` at `at`.
 */
export type Bind = string | { readonly host: string; readonly at: string };

const mount = (flag: "--bind" | "--ro-bind", bind: Bind): string[] =>
  typeof bind === "string" ? [flag, bind, bind] : [flag, bind.host, bind.at];

/** What one sandbox sees, and where it starts. */
export interface SandboxLayout {
  /**
   * The sandbox's network: with a relay, one of its own, whose only way out is
   * the relay's socket; without, the host's, with no proxy variables at all,
   * which only a repository's setup under `AGENT_SANDBOX=none` with no proxy
   * is started with. Nothing here shares the host's network with a proxy set, since a proxy
   * given only as variables is one a tool may ignore: wherever there is a
   * proxy there is a relay (#537).
   */
  readonly relay?: Relay;
  /** The host directory bound at `SANDBOX_HOME`. */
  readonly home: string;
  /** The host directory bound at `/tmp`. */
  readonly tmp: string;
  /** Host directories bound read-write, after the home and `/tmp`. */
  readonly binds?: readonly Bind[];
  /**
   * Host directories bound read-only, after every
   * writable bind: the toolchain, and anything inside a writable bind that
   * is to stay read-only, since a later mount over the same tree wins.
   */
  readonly roBinds: readonly Bind[];
  /** The directory inside the sandbox it starts in. */
  readonly cwd: string;
  /** `PATH` inside the sandbox. */
  readonly path: string;
  /** The rest of the sandbox's environment, set after its own. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * `bwrap`'s arguments for `layout`, up to the command it runs, which follows
 * them. The sandbox shares nothing with the host but, without a relay, its
 * network, and then sets no proxy variable: its environment is cleared and
 * set from `layout` alone, it sees `/usr`, a few named files under `/etc`
 * and the directories `layout` binds, and it ends with the process that started it.
 *
 * With a relay its network is its own loopback and nothing else, the relay's
 * socket is bound in, the proxy variables name the inside end, and the
 * arguments end by starting the inside end, which runs the command after it.
 * No `NO_PROXY` is set: nothing inside has anywhere else to go.
 */
export const bwrapArgs = (layout: SandboxLayout): string[] => {
  const { relay } = layout;
  const proxyVars =
    relay === undefined
      ? []
      : ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].flatMap((name) => ["--setenv", name, insideProxy(relay.proxy)]);
  return [
    "--unshare-all",
    ...(relay === undefined ? ["--share-net"] : []),
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
    ...(layout.binds ?? []).flatMap((bind) => mount("--bind", bind)),
    ...layout.roBinds.flatMap((bind) => mount("--ro-bind", bind)),
    ...(relay === undefined
      ? []
      : ["--bind", relay.socket, RELAY_SOCKET, "--ro-bind", RELAY_SOURCE, RELAY_SCRIPT, "--ro-bind", process.execPath, RELAY_NODE]),
    "--chdir", layout.cwd,
    "--setenv", "HOME", SANDBOX_HOME,
    "--setenv", "PATH", layout.path,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "TMPDIR", "/tmp",
    ...proxyVars,
    ...Object.entries(layout.env).flatMap(([k, v]) => ["--setenv", k, v]),
    ...(relay === undefined ? [] : [RELAY_NODE, RELAY_SCRIPT, RELAY_SOCKET, String(RELAY_PORT)]),
  ];
};
