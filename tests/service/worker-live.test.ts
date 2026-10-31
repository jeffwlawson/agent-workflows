import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_WORKTREE } from "../../engine/bwrap-args.js";
import { RELAY_PORT } from "../../engine/proxy-relay.js";
import { installCli, liveGit, liveSandbox, liveTokens, routeThroughProxy, SETUP_SHELL } from "../../service/worker-live.js";
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
 * exiting as it does. A `--chdir` into a `--bind` is followed to the last
 * such bind's host directory, since the mount that would show it there is
 * not made. Where the arguments end by starting the relay's inside end, it
 * records which bound paths are live sockets as it starts, and runs the
 * command after the inside end's own four words, since the Node and the
 * script they name are seen only inside. A real `bwrap` is the live proof of
 * the rest.
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
const binds = [];
let at = 0;
while (at < args.length && args[at].startsWith("--")) {
  const option = args[at];
  if (option === "--clearenv") env = {};
  if (option === "--setenv") env[args[at + 1]] = args[at + 2];
  if (option === "--bind") binds.push([args[at + 1], args[at + 2]]);
  if (option === "--chdir") cwd = args[at + 1];
  at += 1 + (arity[option] ?? 0);
}
if (args[at] === "/run/proxy-relay/node") {
  const sockets = binds.filter(([from]) => fs.statSync(from, { throwIfNoEntry: false })?.isSocket() === true);
  fs.writeFileSync(path.join(__dirname, "sockets.json"), JSON.stringify(sockets));
  at += 4;
}
const inside = binds.findLast(([, dest]) => cwd === dest || cwd.startsWith(dest + "/"));
if (inside !== undefined) cwd = inside[0] + cwd.slice(inside[1].length);
const ran = spawnSync(args[at], args.slice(at + 1), { cwd, env, stdio: "inherit" });
process.exit(ran.status ?? 1);
`;

describe("the sandbox the repository's setup runs in", () => {
  let checkout: string;
  let fakes: string;
  let log: string;

  /** The host's temporary directory for these tests, so every socket directory a host end leaves is one of theirs. */
  let tmp: string;

  beforeEach(() => {
    tmp = path.join(scratch, "tmp");
    fs.mkdirSync(tmp);
    vi.stubEnv("TMPDIR", tmp);
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

  /** The proxy the sandbox is handed: the host end connects to it only when a connection reaches it, and none does here. */
  const SANDBOX_PROXY = "http://sandbox-proxy:3128";
  /** The proxy as the sandbox names it: the inside end, on its own loopback (#537). */
  const INSIDE = `http://127.0.0.1:${RELAY_PORT}`;

  const run = (
    script: string,
    signal: AbortSignal = new AbortController().signal,
    at = SANDBOX_WORKTREE,
    /** `null` is no proxy, as under `AGENT_SANDBOX=none` with none set. */
    proxy: string | null = SANDBOX_PROXY,
    env: HostEnvironment = host(),
  ) =>
    liveSandbox(env)({
      script,
      dir: checkout,
      at,
      roBinds: ["/opt/node"],
      path: "/usr/bin:/bin",
      ...(proxy === null ? {} : { proxy }),
      log,
      signal,
    });

  const argv = (): string[] => JSON.parse(fs.readFileSync(path.join(fakes, "argv.json"), "utf8")) as string[];

  it("runs AGENT_SETUP as the script, shell metacharacters and all, never as words of a command line", async () => {
    const script = [
      `printf '%s\\n' "$((6 * 7))" 'a b; c | d' "$(echo nested)" > made.txt`,
      "echo `echo backticks` >> made.txt && echo '$NOT_EXPANDED' >> made.txt",
    ].join("\n");

    expect(await run(script)).toBe(0);

    expect(fs.readFileSync(path.join(checkout, "made.txt"), "utf8")).toBe("42\na b; c | d\nnested\nbackticks\n$NOT_EXPANDED\n");
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
      HTTPS_PROXY: INSIDE,
      HTTP_PROXY: INSIDE,
      https_proxy: INSIDE,
      http_proxy: INSIDE,
      AGENT_SETUP: "env > seen.txt",
    });
  });

  /** Where in `words` `flag` mounts `from`, and the path it mounts it at: -1 and undefined where it does not. */
  const mountedAt = (words: readonly string[], flag: string, from: string): { at: number; to: string | undefined } => {
    const at = words.findIndex((word, i) => word === flag && words[i + 1] === from);
    return { at, to: at === -1 ? undefined : words[at + 2] };
  };

  it("shows setup the checkout at the agent's working path, its .git read-only inside it, and the toolchain read-only (#526)", async () => {
    await run("echo made > here.txt");

    const words = argv();
    const bind = mountedAt(words, "--bind", checkout);
    const git = mountedAt(words, "--ro-bind", path.join(checkout, ".git"));
    expect(bind.to).toBe(SANDBOX_WORKTREE);
    expect(git.at).toBeGreaterThan(bind.at);
    expect(git.to).toBe(`${SANDBOX_WORKTREE}/.git`);
    expect(words.join(" ")).toContain("--ro-bind /opt/node /opt/node");
    expect(words.join(" ")).toContain(`--chdir ${SANDBOX_WORKTREE}`);
    expect(words).toContain("--die-with-parent");
    expect(fs.readFileSync(path.join(checkout, "here.txt"), "utf8")).toBe("made\n");
  });

  it("binds the checkout at its own path where it is given that path, its .git read-only inside it", async () => {
    await run("true", new AbortController().signal, checkout);

    const words = argv();
    const bind = mountedAt(words, "--bind", checkout);
    const git = mountedAt(words, "--ro-bind", path.join(checkout, ".git"));
    expect(bind.to).toBe(checkout);
    expect(git.at).toBeGreaterThan(bind.at);
    expect(git.to).toBe(path.join(checkout, ".git"));
    expect(words.join(" ")).toContain(`--chdir ${checkout}`);
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

  /** The socket directories host ends have left in the host's temporary directory. */
  const socketDirs = (): string[] => fs.readdirSync(tmp).filter((name) => name.startsWith("bwrap-proxy-"));

  it("gives setup a network of its own, the host end's socket bound in and the proxy variables naming the inside end (#537)", async () => {
    expect(await run("true")).toBe(0);

    const words = argv();
    expect(words).not.toContain("--share-net");
    const socket = mountedAt(words, "--bind", JSON.parse(fs.readFileSync(path.join(fakes, "sockets.json"), "utf8"))[0][0] as string);
    expect(socket.to).toBe("/run/proxy-relay/proxy.sock");
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
      expect(words[words.indexOf(name) + 1]).toBe(INSIDE);
    }
    expect(words).not.toContain("NO_PROXY");
    expect(words.slice(-SETUP_SHELL.length - 4)).toEqual([
      "/run/proxy-relay/node",
      "/run/proxy-relay/relay.mjs",
      "/run/proxy-relay/proxy.sock",
      String(RELAY_PORT),
      ...SETUP_SHELL,
    ]);
  });

  it("starts the host end before the sandbox, and stops it and removes its socket once setup exits zero or non-zero", async () => {
    expect(await run("true")).toBe(0);
    const sockets = JSON.parse(fs.readFileSync(path.join(fakes, "sockets.json"), "utf8")) as [string, string][];
    expect(sockets.map(([, at]) => at)).toEqual(["/run/proxy-relay/proxy.sock"]);
    expect(socketDirs()).toEqual([]);

    expect(await run("exit 4")).toBe(4);
    expect(socketDirs()).toEqual([]);
  });

  it("stops the host end and removes its socket once the time limit has ended setup", async () => {
    const limit = new AbortController();
    const ended = run("sleep 30", limit.signal);
    setTimeout(() => limit.abort(), 200);

    expect(await ended).not.toBe(0);
    expect(socketDirs()).toEqual([]);
  });

  it("stops the host end and removes its socket where bwrap cannot be started", async () => {
    const empty = path.join(scratch, "no-bwrap");
    fs.mkdirSync(empty);

    await expect(run("true", undefined, SANDBOX_WORKTREE, SANDBOX_PROXY, { ...host(), PATH: empty })).rejects.toThrow(/ENOENT/);
    expect(socketDirs()).toEqual([]);
  });

  it("starts no bwrap where the host end cannot be started", async () => {
    await expect(run("true", undefined, SANDBOX_WORKTREE, "sandbox-proxy:3128")).rejects.toThrow(/not an `http:` URL with a host/);

    expect(fs.existsSync(path.join(fakes, "argv.json"))).toBe(false);
    expect(socketDirs()).toEqual([]);
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith("agent-setup-"))).toEqual([]);
  });

  it("keeps the host's network, with no proxy variable and no host end, where it is handed no proxy", async () => {
    expect(await run("env > seen.txt", undefined, checkout, null)).toBe(0);

    const words = argv();
    expect(words).toContain("--share-net");
    expect(words.some((word) => word.startsWith("/run/proxy-relay"))).toBe(false);
    expect(words.slice(-SETUP_SHELL.length)).toEqual([...SETUP_SHELL]);
    expect(fs.readFileSync(path.join(checkout, "seen.txt"), "utf8")).not.toMatch(/proxy/i);
    expect(fs.existsSync(path.join(fakes, "sockets.json"))).toBe(false);
    expect(socketDirs()).toEqual([]);
  });

  it("removes the sandbox's home and /tmp once it has ended", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("agent-setup-"));
    await run("true");

    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("agent-setup-"))).toEqual(before);
  });
});

/**
 * Whether bubblewrap runs here with a network of its own: it needs the binary
 * and unprivileged user namespaces, which AppArmor refuses on some hosts.
 */
const bwrapRuns = (): boolean =>
  spawnSync("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

describe.skipIf(!bwrapRuns())("setup's network, in a real sandbox (skipped where bwrap or unprivileged user namespaces are unavailable)", () => {
  /** A stand-in proxy on the host's loopback, answering every request with `200 proxied`. */
  let standIn: NetServer;
  let standInPort: number;
  let checkout: string;

  beforeEach(async () => {
    standIn = createNetServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\nproxied"));
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    standInPort = (standIn.address() as AddressInfo).port;
    checkout = path.join(scratch, "checkout");
    fs.mkdirSync(checkout);
  });

  afterEach(async () => {
    await new Promise((resolve) => standIn.close(resolve));
  });

  /** A Node one-liner, run inside by the Node the relay binds in: connect to `host`:`port`, send a request, print the reply or the error's code. */
  const probe = (host: string, port: string): string =>
    `/run/proxy-relay/node -e '` +
    `const s = require("net").connect(${port}, ${host}, () => s.write("GET http://example.com/ HTTP/1.1\\r\\nhost: example.com\\r\\n\\r\\n"));` +
    `let out = ""; s.on("data", (d) => (out += d)); s.on("end", () => console.log("reply:" + out.split("\\r\\n\\r\\n")[1]));` +
    `s.setTimeout(3000, () => { console.log("error:timeout"); s.destroy(); }); s.on("error", (e) => console.log("error:" + e.code));'`;

  it("reaches nothing directly, the host's loopback and the proxy's own port included, and the proxy through the variables (#537)", async () => {
    const script = [
      `${probe(`"127.0.0.1"`, String(standInPort))} > direct.txt`,
      `${probe(`"1.1.1.1"`, "80")} > external.txt`,
      `${probe(`new URL(process.env.HTTP_PROXY).hostname`, `Number(new URL(process.env.HTTP_PROXY).port)`)} > proxied.txt`,
      "cat /proc/net/dev > interfaces.txt",
    ].join("\n");
    const log = path.join(scratch, "setup.log");
    const host = { PATH: process.env["PATH"] ?? "", HOME: scratch, LANG: "C.UTF-8" };

    const code = await liveSandbox(host)({
      script,
      dir: checkout,
      at: SANDBOX_WORKTREE,
      roBinds: [],
      path: "/usr/bin:/bin",
      proxy: `http://127.0.0.1:${standInPort}`,
      log,
      signal: new AbortController().signal,
    });

    const read = (name: string): string => fs.readFileSync(path.join(checkout, name), "utf8");
    expect(code, fs.readFileSync(log, "utf8")).toBe(0);
    expect(read("direct.txt")).toMatch(/^error:/);
    expect(read("external.txt")).toMatch(/^error:/);
    expect(read("proxied.txt").trim()).toBe("reply:proxied");
    const interfaces = read("interfaces.txt").split("\n").slice(2).filter((line) => line.trim() !== "");
    expect(interfaces.map((line) => line.split(":")[0]!.trim())).toEqual(["lo"]);
  });
});

/**
 * The checkout the service's git edge makes (#567), from a repository on disk
 * that `HOME`'s git configuration names in place of the GitHub URL, so
 * nothing reaches a network. The base carries a release tag behind its tip,
 * annotated as `npm version` makes one, and a lightweight tag at its tip.
 */
describe("the checkout the service makes", () => {
  let home: string;
  let origin: string;
  let dir: string;
  let head: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "tag.gpgSign=false", "-c", "commit.gpgSign=false", ...args], {
      cwd,
      env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT,
    });

  beforeEach(async () => {
    home = path.join(scratch, "home");
    origin = path.join(scratch, "origin");
    dir = path.join(scratch, "checkout");
    fs.mkdirSync(home);
    fs.mkdirSync(origin);
    fs.writeFileSync(path.join(home, ".gitconfig"), `[url "file://${origin}"]\n\tinsteadOf = https://github.com/owner/repo.git\n`);
    git(origin, "init", "--quiet", "--initial-branch=main");
    fs.writeFileSync(path.join(origin, "version.txt"), "1.0.0\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "v1.0.0");
    git(origin, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
    fs.writeFileSync(path.join(origin, "version.txt"), "1.1.0\n");
    git(origin, "commit", "--quiet", "-am", "later");
    git(origin, "tag", "base-tip");
    git(origin, "checkout", "--quiet", "-b", "feature");
    fs.writeFileSync(path.join(origin, "change.txt"), "change\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "change");
    head = git(origin, "rev-parse", "HEAD").trim();
    git(origin, "checkout", "--quiet", "main");

    await liveGit({ PATH: process.env["PATH"] ?? "", HOME: home }).checkout({
      dir,
      repo: "owner/repo",
      branch: "feature",
      sha: head,
      baseRef: "main",
      token: "the-token",
      committer: "agent[bot]",
      signal: new AbortController().signal,
    });
  }, SUBPROCESS_TIMEOUT * 4);

  it("holds every tag the base has, as Actions' fetch-depth: 0 does, with the head checked out and the base beside it", () => {
    expect(git(dir, "tag", "--list").trim().split("\n")).toEqual(["base-tip", "v1.0.0"]);
    expect(git(dir, "show", "v1.0.0:version.txt")).toBe("1.0.0\n");
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(dir, "rev-parse", "main").trim()).toBe(git(origin, "rev-parse", "main").trim());
  });

  it("hands the tags to the agent's copy, which Sandcastle clones from a bundle of the checkout's every ref", () => {
    const bundle = path.join(scratch, "repo.bundle");
    const copy = path.join(scratch, "copy");
    git(dir, "bundle", "create", bundle, "--all");
    git(scratch, "clone", "--quiet", bundle, copy);

    expect(git(copy, "show", "v1.0.0:version.txt")).toBe("1.0.0\n");
    expect(git(copy, "show", "base-tip:version.txt")).toBe("1.1.0\n");
  });

  it("stores no token in the checkout's configuration", () => {
    const config = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
    expect(config).not.toContain(Buffer.from("x-access-token:the-token").toString("base64"));
    expect(config).not.toContain("extraHeader");
    expect(config).not.toContain("the-token");
  });
});
