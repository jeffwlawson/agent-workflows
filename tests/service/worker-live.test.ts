import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCli, liveSandbox, liveTokens, routeThroughProxy, SETUP_SHELL } from "../../service/worker-live.js";
import { gitEnvironment, hostEnvironment, PROXY_VARIABLES, type HostEnvironment } from "../../shared/env.js";
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

  it("is what a command hands its git spawns, the proxy kept and nothing else of its environment", () => {
    const host = hostEnvironment("http://127.0.0.1:8888");
    for (const [name, value] of Object.entries(host)) vi.stubEnv(name, value);
    vi.stubEnv("GH_TOKEN", "not-for-git");
    vi.stubEnv("NO_PROXY", "*");

    expect(gitEnvironment()).toEqual(host);
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

/**
 * A stand-in for `bwrap`, since CI's runners cannot be relied on to have it:
 * it records its arguments beside itself, applies the ones that decide what
 * the command sees (`--clearenv`, `--setenv`, `--chdir`), skips the mounts
 * and namespaces it cannot make, and runs the command that follows them,
 * exiting as it does. A real `bwrap` is the live proof of the rest.
 */
const FAKE_BWRAP = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, "argv.json"), JSON.stringify(args));
const arity = { "--cap-drop": 1, "--hostname": 1, "--dev": 1, "--proc": 1, "--tmpfs": 1, "--chdir": 1, "--ro-bind": 2, "--bind": 2, "--symlink": 2, "--setenv": 2 };
let env = { ...process.env };
let cwd = process.cwd();
let at = 0;
while (at < args.length && args[at].startsWith("--")) {
  const option = args[at];
  if (option === "--clearenv") env = {};
  if (option === "--setenv") env[args[at + 1]] = args[at + 2];
  if (option === "--chdir") cwd = args[at + 1];
  at += 1 + (arity[option] ?? 0);
}
const ran = spawnSync(args[at], args.slice(at + 1), { cwd, env, stdio: "inherit" });
process.exit(ran.status ?? 1);
`;

describe("the sandbox the repository's setup runs in", () => {
  let checkout: string;
  let fakes: string;
  let log: string;

  beforeEach(() => {
    checkout = path.join(scratch, "checkout");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    fakes = path.join(scratch, "fakes");
    fs.mkdirSync(fakes);
    fs.writeFileSync(path.join(fakes, "bwrap"), FAKE_BWRAP, { mode: 0o755 });
    log = path.join(scratch, "setup.log");
  });

  /** The worker's host, with the stand-in first on its `PATH`, and the worker's own proxy, which the sandbox must not get. */
  const host = (): HostEnvironment => ({
    PATH: [fakes, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: scratch,
    LANG: "C.UTF-8",
    HTTPS_PROXY: "http://worker-proxy:3128",
  });

  const run = (script: string, signal: AbortSignal = new AbortController().signal) =>
    liveSandbox(host())({ script, dir: checkout, roBinds: ["/opt/node"], path: "/usr/bin:/bin", proxy: "http://sandbox-proxy:3128", log, signal });

  const argv = (): string[] => JSON.parse(fs.readFileSync(path.join(fakes, "argv.json"), "utf8")) as string[];

  it("runs AGENT_SETUP as the script, shell metacharacters and all, never as words of a command line", async () => {
    const script = [
      `printf '%s\\n' "$((6 * 7))" 'a b; c | d' "$(echo nested)" > made.txt`,
      "echo `echo backticks` >> made.txt && echo '$NOT_EXPANDED' >> made.txt",
      'pwd >> made.txt',
    ].join("\n");

    expect(await run(script)).toBe(0);

    expect(fs.readFileSync(path.join(checkout, "made.txt"), "utf8")).toBe(`42\na b; c | d\nnested\nbackticks\n$NOT_EXPANDED\n${checkout}\n`);
    const words = argv();
    expect(words.filter((word) => word === script)).toHaveLength(1);
    expect(words[words.indexOf(script) - 1]).toBe("AGENT_SETUP");
    expect(words[words.indexOf(script) - 2]).toBe("--setenv");
    expect(words.slice(-SETUP_SHELL.length)).toEqual([...SETUP_SHELL]);
  });

  it("hands the script the sandbox's environment and AGENT_SETUP, and nothing of the worker's", async () => {
    expect(await run("env > seen.txt")).toBe(0);

    const seen = Object.fromEntries(
      fs
        .readFileSync(path.join(checkout, "seen.txt"), "utf8")
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    // Bash's own: the shell sets these for whatever it runs.
    for (const name of ["PWD", "SHLVL", "_", "OLDPWD"]) delete seen[name];
    expect(seen).toEqual({
      HOME: "/home/agent",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      HTTPS_PROXY: "http://sandbox-proxy:3128",
      HTTP_PROXY: "http://sandbox-proxy:3128",
      https_proxy: "http://sandbox-proxy:3128",
      http_proxy: "http://sandbox-proxy:3128",
      AGENT_SETUP: "env > seen.txt",
    });
  });

  it("binds the checkout read-write at its own path, its .git read-only inside it, and the toolchain read-only", async () => {
    await run("true");

    const words = argv();
    const bind = words.findIndex((word, at) => word === "--bind" && words[at + 1] === checkout);
    const git = words.findIndex((word, at) => word === "--ro-bind" && words[at + 1] === path.join(checkout, ".git"));
    expect(bind).toBeGreaterThan(-1);
    expect(words[bind + 2]).toBe(checkout);
    expect(git).toBeGreaterThan(bind);
    expect(words[git + 2]).toBe(path.join(checkout, ".git"));
    expect(words.join(" ")).toContain("--ro-bind /opt/node /opt/node");
    expect(words.join(" ")).toContain(`--chdir ${checkout}`);
    expect(words).toContain("--die-with-parent");
  });

  it("answers the script's exit status, and appends its output to the log", async () => {
    expect(await run("echo installing; echo broken >&2; exit 3")).toBe(3);

    expect(fs.readFileSync(log, "utf8")).toBe("installing\nbroken\n");
  });

  it("stops at the first command that fails, as an Actions run step does", async () => {
    expect(await run("false\necho after > after.txt")).toBe(1);

    expect(fs.existsSync(path.join(checkout, "after.txt"))).toBe(false);
  });

  it("ends the sandbox and everything in it where its time limit aborts", async () => {
    const limit = new AbortController();
    const started = Date.now();
    const ended = run("sleep 30", limit.signal);
    setTimeout(() => limit.abort(), 200);

    expect(await ended).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(SUBPROCESS_TIMEOUT);
  });

  it("removes the sandbox's home and /tmp once it has ended", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("agent-setup-"));
    await run("true");

    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("agent-setup-"))).toEqual(before);
  });
});
