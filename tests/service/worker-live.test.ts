import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCli, liveTokens, routeThroughProxy } from "../../service/worker-live.js";
import { hostEnvironment, PROXY_VARIABLES } from "../../shared/env.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * The worker's own requests through `WORKER_PROXY` (#460), against a proxy
 * that is a local server recording what it is asked for, so nothing reaches a
 * network. It tunnels a request for the token door, at an address reserved
 * for documentation (RFC 5737) that a request missing the proxy could not
 * reach, to a local door answering a token, and refuses every other.
 */

const DOOR = "192.0.2.1:8791";

let scratch: string;
let proxy: Server;
let door: Server;
let proxyUrl: string;
/** What the proxy was asked for: the absolute URL of a plain request, or `CONNECT host:port`. */
let asked: string[];
let restore: (() => void) | undefined;

beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "worker-live-"));
  asked = [];
  door = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "through-the-proxy" }));
  });
  await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", resolve));
  proxy = createServer((request, response) => {
    asked.push(request.url ?? "");
    response.writeHead(403).end();
  });
  proxy.on("connect", (request, socket, head) => {
    asked.push(`CONNECT ${request.url ?? ""}`);
    if (request.url !== DOOR) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const tunnel = connect((door.address() as AddressInfo).port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      tunnel.write(head);
      tunnel.pipe(socket).pipe(tunnel);
    });
    tunnel.on("error", () => socket.destroy());
    socket.on("error", () => tunnel.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterEach(async () => {
  restore?.();
  restore = undefined;
  vi.unstubAllEnvs();
  proxy.closeAllConnections();
  door.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => door.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the host's environment a subcommand gets", () => {
  it("is PATH, HOME and LANG alone where the worker has no proxy, whatever proxy its own environment names", () => {
    vi.stubEnv("PATH", "/host/bin");
    vi.stubEnv("HOME", "/host/home");
    vi.stubEnv("LANG", "C.UTF-8");
    for (const name of [...PROXY_VARIABLES, "NO_PROXY", "no_proxy"]) vi.stubEnv(name, "http://elsewhere:3128");

    expect(hostEnvironment("")).toEqual({ PATH: "/host/bin", HOME: "/host/home", LANG: "C.UTF-8" });
  });

  it("adds the proxy variables, each naming the setting's proxy and never the worker's own, and no NO_PROXY", () => {
    vi.stubEnv("PATH", "/host/bin");
    for (const name of [...PROXY_VARIABLES, "NO_PROXY", "no_proxy"]) vi.stubEnv(name, "http://elsewhere:3128");

    const host = hostEnvironment("http://127.0.0.1:8888");
    expect(host).toEqual({
      PATH: "/host/bin",
      HOME: process.env["HOME"],
      LANG: process.env["LANG"],
      HTTP_PROXY: "http://127.0.0.1:8888",
      HTTPS_PROXY: "http://127.0.0.1:8888",
      http_proxy: "http://127.0.0.1:8888",
      https_proxy: "http://127.0.0.1:8888",
      NODE_USE_ENV_PROXY: "1",
    });
  });
});

describe("the worker's own requests", () => {
  it("asks the dispatcher for a token through the proxy, even where its own environment says not to", async () => {
    vi.stubEnv("NO_PROXY", "*");
    vi.stubEnv("no_proxy", "*");
    restore = routeThroughProxy(hostEnvironment(proxyUrl));

    const token = await liveTokens(`http://${DOOR}/token`, "secret", "job-1")("read");

    expect(token).toBe("through-the-proxy");
    expect(asked).toEqual([`CONNECT ${DOOR}`]);
  });

  it("installs the agent's CLI through the proxy", async () => {
    // A home of its own, so npm's cache cannot answer in the proxy's place,
    // and no retries, so the refusal ends the install at once.
    const host = { ...hostEnvironment(proxyUrl), HOME: scratch, npm_config_fetch_retries: "0" };

    await expect(installCli(path.join(scratch, "prefix"), "0.0.0-proxy-test", host)).rejects.toThrow(/Installing/);

    expect(asked.filter((line) => line.startsWith("CONNECT "))).not.toEqual([]);
  }, SUBPROCESS_TIMEOUT * 2);
});
