/**
 * The way out of a `bwrap` sandbox's network, which is its own loopback and
 * nothing else (#461): one Unix socket, bound into the sandbox, whose host end
 * copies every connection's bytes to the proxy and nowhere else.
 *
 * Two halves, and only this one is trusted. The host end runs in the process
 * that owns the sandbox, takes no destination from the sandbox and parses
 * nothing it sends: the proxy's allowlist is the policy, and this is not a
 * second one. The inside end, `relay.mjs`, listens on the sandbox's loopback
 * for the tools that read the proxy variables and forwards to the socket; the
 * agent may kill or replace it and still reaches nothing but the proxy.
 *
 * Engine code (ADR 0005): it reads no environment. The proxy is an argument,
 * and the socket lives under the host's temporary directory as the sandbox's
 * own state does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** The port the inside end listens on, on the sandbox's own loopback, where nothing else listens. */
export const RELAY_PORT = 3128;

/** The socket's name in its directory. */
const SOCKET_NAME = "proxy.sock";
/** A private directory per sandbox, holding its socket. */
const SOCKET_DIR_PREFIX = "bwrap-proxy-";
/**
 * The longest path a Unix socket can be bound at: `sun_path` is 108 bytes on
 * Linux, its last a NUL. A longer one fails `listen` with `EINVAL`.
 */
const MAX_SOCKET_PATH = 107;
/** Where the socket goes when the host's temporary directory is too deep for one. */
const SHORT_TMP = "/tmp";

/**
 * The refusal of an `https:` proxy (#535), apart from the one for a value that
 * is not a URL with a host, so a caller can say which. The sandbox names the
 * proxy by the inside end's loopback address, and a client speaking TLS to it
 * checks the proxy's certificate against that address, which the certificate
 * does not name: every request would fail.
 */
export class HttpsProxyRefused extends Error {}

/** Where the proxy is, as `proxy`, an `http:` URL with a host, names it; or a throw. */
export const proxyTarget = (proxy: string): { readonly host: string; readonly port: number } => {
  const url = URL.parse(proxy);
  if (url?.protocol === "https:") {
    throw new HttpsProxyRefused(
      `the proxy \`${proxy}\` is an \`https:\` URL: the sandbox reaches the proxy by a loopback address, which its TLS certificate does not name. Give the proxy's \`http:\` URL`,
    );
  }
  if (url === null || url.protocol !== "http:" || url.hostname === "") {
    throw new Error(`the proxy \`${proxy}\` is not an \`http:\` URL with a host`);
  }
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? 80 : Number(url.port),
  };
};

/**
 * The proxy as the sandbox names it: the inside end's loopback address, always
 * `http:`, with any user-info `proxy` has, so a proxy that asks for
 * credentials still gets them.
 */
export const insideProxy = (proxy: string): string => {
  proxyTarget(proxy);
  const url = new URL(proxy);
  const userInfo = url.username === "" ? "" : `${url.username}${url.password === "" ? "" : `:${url.password}`}@`;
  return `http://${userInfo}127.0.0.1:${RELAY_PORT}`;
};

/** A host end, listening: the socket to bind into the sandbox, and how to stop it. */
export interface ProxyRelay {
  /** The host path of the socket. */
  readonly socket: string;
  /** Stop listening, end every open connection, and remove the socket. */
  close(): Promise<void>;
}

/** A directory for one socket, at a path short enough for a Unix socket to be bound in it. */
const socketDir = (): Promise<string> => {
  const fits = (base: string): boolean =>
    Buffer.byteLength(path.join(base, `${SOCKET_DIR_PREFIX}XXXXXX`, SOCKET_NAME)) <= MAX_SOCKET_PATH;
  return mkdtemp(path.join(fits(tmpdir()) ? tmpdir() : SHORT_TMP, SOCKET_DIR_PREFIX));
};

/**
 * Start a host end for `proxy`: a socket in a directory of its own, which
 * only this user can enter, each connection to it copied byte for byte to the
 * proxy's host and port. A connection the proxy refuses is ended, and nothing
 * else is tried.
 */
export const startProxyRelay = async (proxy: string): Promise<ProxyRelay> => {
  const target = proxyTarget(proxy);
  const dir = await socketDir();
  const socket = path.join(dir, SOCKET_NAME);
  const open = new Set<Socket>();
  const server = createServer((inside) => {
    const upstream = connect(target.port, target.host);
    for (const end of [inside, upstream]) {
      open.add(end);
      end.on("close", () => open.delete(end));
      end.on("error", () => {
        inside.destroy();
        upstream.destroy();
      });
    }
    inside.pipe(upstream);
    upstream.pipe(inside);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    socket,
    close: async () => {
      for (const end of open) end.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
};
