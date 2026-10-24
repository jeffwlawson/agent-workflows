import * as fs from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insideProxy, proxyTarget, RELAY_PORT, startProxyRelay } from "../../engine/proxy-relay.js";

/**
 * The host end of a `bwrap` sandbox's one way out (#461), with no sandbox: a
 * stand-in proxy on the host's loopback, and connections made to the socket
 * as the inside end would make them.
 */

/** A stand-in proxy: everything each connection sends, as it arrives, and a reply of `PROXY` to each. */
const standIn = async (): Promise<{ server: Server; port: number; received: string[] }> => {
  const received: string[] = [];
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (d: Buffer) => {
      text += d.toString();
      received.push(text);
      socket.write("PROXY");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, port: address.port, received };
};

/** Send `text` down the socket at `socket`, and answer the first reply. */
const through = (socket: string, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const client: Socket = connect(socket, () => client.write(text));
    client.once("data", (d: Buffer) => {
      resolve(d.toString());
      client.end();
    });
    client.on("error", reject);
  });

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("proxyTarget: where the host end forwards", () => {
  it("is the proxy's host and port, the scheme's port where none is written", () => {
    expect(proxyTarget("http://127.0.0.1:3128")).toEqual({ host: "127.0.0.1", port: 3128 });
    expect(proxyTarget("http://user:pw@proxy.internal:8080/")).toEqual({ host: "proxy.internal", port: 8080 });
    expect(proxyTarget("http://proxy.internal")).toEqual({ host: "proxy.internal", port: 80 });
    expect(proxyTarget("https://proxy.internal")).toEqual({ host: "proxy.internal", port: 443 });
    expect(proxyTarget("http://[::1]:3128")).toEqual({ host: "::1", port: 3128 });
  });

  it.each(["127.0.0.1:3128", "proxy", "socks5://127.0.0.1:1080", "http://", "file:///tmp/proxy.sock"])("refuses %s", (proxy) => {
    expect(() => proxyTarget(proxy)).toThrow(/is not an `http:` or `https:` URL with a host/);
  });
});

describe("insideProxy: the proxy as the sandbox names it", () => {
  it("is the inside end's loopback address, keeping the scheme and any user-info", () => {
    expect(insideProxy("http://10.0.0.5:8888")).toBe(`http://127.0.0.1:${RELAY_PORT}`);
    expect(insideProxy("https://proxy.internal")).toBe(`https://127.0.0.1:${RELAY_PORT}`);
    expect(insideProxy("http://agent:s%40cret@proxy.internal:3128/")).toBe(`http://agent:s%40cret@127.0.0.1:${RELAY_PORT}`);
    expect(insideProxy("http://agent@proxy.internal:3128")).toBe(`http://agent@127.0.0.1:${RELAY_PORT}`);
  });
});

describe("startProxyRelay: the host end", () => {
  it("copies each connection's bytes to the configured proxy, whatever destination they name", async () => {
    const proxy = await standIn();
    servers.push(proxy.server);
    const relay = await startProxyRelay(`http://127.0.0.1:${proxy.port}`);
    try {
      expect(await through(relay.socket, "CONNECT 1.1.1.1:443 HTTP/1.1\r\n\r\n")).toBe("PROXY");
      expect(await through(relay.socket, "GET http://169.254.169.254/ HTTP/1.1\r\n\r\n")).toBe("PROXY");
      expect(proxy.received).toEqual(["CONNECT 1.1.1.1:443 HTTP/1.1\r\n\r\n", "GET http://169.254.169.254/ HTTP/1.1\r\n\r\n"]);
    } finally {
      await relay.close();
    }
  });

  it("listens in a directory only its user can enter", async () => {
    const relay = await startProxyRelay("http://127.0.0.1:9");
    try {
      expect(fs.statSync(path.dirname(relay.socket)).mode & 0o077).toBe(0);
      expect(fs.statSync(relay.socket).isSocket()).toBe(true);
    } finally {
      await relay.close();
    }
  });

  it("refuses a proxy that is not a URL with a host, before it listens", async () => {
    await expect(startProxyRelay("proxy:3128")).rejects.toThrow(/`proxy:3128` is not an `http:` or `https:` URL with a host/);
  });

  // The trap triage found: `sun_path` holds 108 bytes, and `listen` fails with
  // `EINVAL` on a socket under a temporary directory deeper than that.
  it("binds its socket within a Unix socket's length limit, under a long temporary directory too", async () => {
    const long = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-long-"));
    const deep = path.join(long, "a".repeat(60), "b".repeat(60));
    fs.mkdirSync(deep, { recursive: true });
    vi.stubEnv("TMPDIR", deep);
    expect(os.tmpdir()).toBe(deep);
    const proxy = await standIn();
    servers.push(proxy.server);
    const relay = await startProxyRelay(`http://127.0.0.1:${proxy.port}`);
    try {
      expect(Buffer.byteLength(relay.socket)).toBeLessThanOrEqual(107);
      expect(await through(relay.socket, "x")).toBe("PROXY");
    } finally {
      await relay.close();
      fs.rmSync(long, { recursive: true, force: true });
    }
  });

  it("stops on close: open connections end, and the socket and its directory are gone", async () => {
    const proxy = await standIn();
    servers.push(proxy.server);
    const relay = await startProxyRelay(`http://127.0.0.1:${proxy.port}`);
    const client = connect(relay.socket);
    await new Promise((resolve) => client.once("connect", resolve));
    const ended = new Promise((resolve) => client.once("close", resolve));

    await relay.close();

    await ended;
    expect(fs.existsSync(relay.socket)).toBe(false);
    expect(fs.existsSync(path.dirname(relay.socket))).toBe(false);
  });

  it("gives each sandbox a socket of its own", async () => {
    const [a, b] = await Promise.all([startProxyRelay("http://127.0.0.1:9"), startProxyRelay("http://127.0.0.1:9")]);
    try {
      expect(a.socket).not.toBe(b.socket);
      expect(path.dirname(a.socket)).not.toBe(path.dirname(b.socket));
      await a.close();
      expect(fs.existsSync(b.socket)).toBe(true);
    } finally {
      await b.close();
    }
  });
});
