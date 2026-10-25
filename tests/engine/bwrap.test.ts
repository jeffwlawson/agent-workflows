import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bwrapArgs } from "../../engine/bwrap-args.js";
import { assertHostTarget, bwrap, CARRY_HOOKS, carriable, excludePattern, toHost, untrackedPaths } from "../../engine/bwrap.js";
import { RELAY_PORT } from "../../engine/proxy-relay.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * The guards are what this provider exists for: the sandbox chooses every name
 * that reaches them. Only the network's tests run bubblewrap itself, at the
 * end, and skip where it cannot run: CI's runners cannot be relied on to have
 * it, or to allow the user namespaces it needs. The rest read the arguments
 * the provider starts it with, through a `bwrap` on `PATH` that prints them.
 */

interface Handle {
  readonly worktreePath: string;
  exec(command: string, opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
  close(): Promise<void>;
}

let repo: string;
let home: string;

/** No proxy listens here; the host end connects only when a connection reaches it. */
const NO_PROXY_HERE = "http://127.0.0.1:9";

type Provider = { create(o: { env: Record<string, string> }): Promise<Handle> };

const provider = (proxy = NO_PROXY_HERE): Provider =>
  bwrap({ roBinds: [], path: "/usr/bin:/bin", proxy, repoDir: repo, homeDir: home }) as unknown as Provider;

/** A sandbox as Sandcastle would create one, without running anything in it. */
const create = (proxy?: string): Promise<Handle> => provider(proxy).create({ env: {} });

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT });

/** The host directory backing a sandbox path, found through a file copied in, as the provider keeps its root to itself. */
const hostOf = async (h: Handle, sandboxPath: string): Promise<string> => {
  const marker = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-marker-"));
  try {
    fs.writeFileSync(path.join(marker, "m"), "");
    await h.copyIn(path.join(marker, "m"), "/home/agent/.marker");
  } finally {
    fs.rmSync(marker, { recursive: true, force: true });
  }
  const roots = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("bwrap-job-"))
    .map((name) => path.join(fs.realpathSync(os.tmpdir()), name))
    .filter((root) => fs.existsSync(path.join(root, "home", ".marker")));
  if (roots.length !== 1) throw new Error(`expected one sandbox root, found ${roots.length}`);
  fs.rmSync(path.join(roots[0]!, "home", ".marker"));
  return toHost(roots[0]!, sandboxPath);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-repo-"));
  git(repo, "init", "--quiet");
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-home-"));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("assertHostTarget", () => {
  const sc = (...p: string[]) => path.join(repo, ".sandcastle", ...p);

  it("accepts Sandcastle's patch directories, at the repo and under an isolated run's host worktree", () => {
    for (const ok of [
      sc("patches", "20261006-055100", "0001-work.patch"),
      sc("patches", "20261006-055100", "untracked", "src", "new.ts"),
      sc("worktrees", "review-pr-1", ".sandcastle", "patches", "20261006-055100", "0001-work.patch"),
      sc("worktrees", "review-pr-1", ".sandcastle", "patches", "20261006-055100", "untracked", "a", "b.ts"),
    ]) {
      expect(() => assertHostTarget(repo, ok), ok).not.toThrow();
    }
  });

  it("accepts Sandcastle's session temp files, and no other temp file", () => {
    expect(() => assertHostTarget(repo, path.join(os.tmpdir(), "sandcastle-claude-cap-1-x7.jsonl"))).not.toThrow();
    expect(() => assertHostTarget(repo, path.join(os.tmpdir(), "other.jsonl"))).toThrow(/outside the patch directory/);
  });

  it("refuses anything with a .git component", () => {
    expect(() => assertHostTarget(repo, sc("patches", "r", "..", "..", "..", ".git", "config"))).toThrow(/\.git/);
    expect(() => assertHostTarget(repo, sc("patches", "r", "untracked", ".git", "hooks", "post-checkout"))).toThrow(/\.git/);
  });

  // #365's review: the first guard only asked that "patches" appear somewhere in the path.
  it("refuses other places under .sandcastle, even ones naming patches", () => {
    for (const bad of [
      sc("worktrees", "x", "hooks-y"),
      sc("other", "patches", "z"),
      sc("worktrees", "x", "src", "patches", "r", "f"),
      sc("patches"),
      sc("patches", "r"),
    ]) {
      expect(() => assertHostTarget(repo, bad), bad).toThrow(/outside the patch directory/);
    }
  });

  it("does not take a 'patches' in the repository's own path as permission", () => {
    const nested = path.join(repo, "patches", "repo");
    expect(() => assertHostTarget(nested, path.join(nested, ".sandcastle", "worktrees", "x", "hooks-y"))).toThrow();
  });

  it("refuses escapes out of the patch directory and paths elsewhere on the host", () => {
    expect(() => assertHostTarget(repo, sc("patches", "r", "..", "..", "..", "src", "index.ts"))).toThrow();
    expect(() => assertHostTarget(repo, path.join(os.homedir(), "evil.txt"))).toThrow();
  });
});

describe("toHost", () => {
  const root = "/job";
  it("maps the sandbox's home and /tmp into the job directory", () => {
    expect(toHost(root, "/home/agent/workspace/a.ts")).toBe("/job/home/workspace/a.ts");
    expect(toHost(root, "/tmp/sandcastle-1/repo.bundle")).toBe("/job/tmp/sandcastle-1/repo.bundle");
  });
  it("refuses every other sandbox path, after normalising it", () => {
    for (const bad of ["/etc/passwd", "/home/agentx/f", "/home/agent/../../etc/shadow", "/tmpx/f", "/usr/bin/git"]) {
      expect(() => toHost(root, bad), bad).toThrow(/outside the sandbox's writable paths/);
    }
  });
});

describe("copyFileOut", () => {
  it("copies a sandbox file into the patch directory", async () => {
    const h = await create();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-src-"));
    try {
      fs.writeFileSync(path.join(src, "f.patch"), "diff\n");
      await h.copyIn(src, "/home/agent/workspace/out");
      const dest = path.join(repo, ".sandcastle", "patches", "r", "f.patch");
      await h.copyFileOut("/home/agent/workspace/out/f.patch", dest);
      expect(fs.readFileSync(dest, "utf8")).toBe("diff\n");
    } finally {
      await h.close();
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it("refuses a symlink the agent pointed at a host file", async () => {
    const h = await create();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-src-"));
    const secret = path.join(src, "secret.txt");
    try {
      fs.writeFileSync(secret, "host secret\n");
      fs.mkdirSync(path.join(src, "dir"));
      fs.symlinkSync(secret, path.join(src, "dir", "link.patch"));
      await h.copyIn(path.join(src, "dir"), "/home/agent/workspace/out");
      const dest = path.join(repo, ".sandcastle", "patches", "r", "link.patch");
      await expect(h.copyFileOut("/home/agent/workspace/out/link.patch", dest)).rejects.toThrow(/outside the sandbox/);
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      await h.close();
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it("refuses a sandbox path outside its writable area", async () => {
    const h = await create();
    try {
      await expect(h.copyFileOut("/etc/passwd", path.join(repo, ".sandcastle", "patches", "r", "p"))).rejects.toThrow(
        /outside the sandbox's writable paths/,
      );
    } finally {
      await h.close();
    }
  });

  it("refuses to write into the repository's .git, whatever the sandbox path", async () => {
    const h = await create();
    try {
      await expect(h.copyFileOut("/home/agent/workspace/x", path.join(repo, ".git", "hooks", "post-checkout"))).rejects.toThrow(/\.git/);
      expect(fs.existsSync(path.join(repo, ".git", "hooks", "post-checkout"))).toBe(false);
    } finally {
      await h.close();
    }
  });
});

/**
 * Sandcastle 0.12.0 resumes a session only for bind-mount providers, so this
 * one carries it from the run that wrote it to the next: kept on close, seeded
 * into the next sandbox, and copied to where Sandcastle looks on the host.
 */
describe("the session, between a runner's two passes", () => {
  it("is seeded into the next sandbox of the same provider, and copied where Sandcastle looks for it", async () => {
    const sessions = provider();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-src-"));
    try {
      fs.mkdirSync(path.join(src, "-home-agent-workspace"));
      fs.writeFileSync(path.join(src, "-home-agent-workspace", "s-1.jsonl"), "{}\n");

      const first = await sessions.create({ env: {} });
      await first.copyIn(src, "/home/agent/.claude/projects");
      await first.close();

      const encoded = repo.replace(/[\\/]/g, "-");
      expect(fs.readFileSync(path.join(home, ".claude", "projects", encoded, "s-1.jsonl"), "utf8")).toBe("{}\n");

      const second = await sessions.create({ env: {} });
      try {
        const out = path.join(repo, ".sandcastle", "patches", "r", "s-1.jsonl");
        await second.copyFileOut("/home/agent/.claude/projects/-home-agent-workspace/s-1.jsonl", out);
        expect(fs.readFileSync(out, "utf8")).toBe("{}\n");
      } finally {
        await second.close();
      }
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });
});

/**
 * Sandcastle fills the worktree from a bundle of the checkout, which holds its
 * history and nothing else, so the provider carries what the checkout holds
 * outside git, the setup's install and build output, into the sandbox, and its
 * hook links it into the worktree once Sandcastle has cloned it there.
 */
describe("what the checkout holds outside git", () => {
  /** A checkout as the repository's setup leaves it: tracked files, an ignored install, untracked output, and Sandcastle's own directory. */
  const populate = (): void => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "tracked\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "base");
    fs.mkdirSync(path.join(repo, "node_modules", "pkg", "bin"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "bin", "run.js"), "installed\n");
    fs.mkdirSync(path.join(repo, "node_modules", ".bin"));
    fs.symlinkSync("../pkg/bin/run.js", path.join(repo, "node_modules", ".bin", "run"));
    fs.mkdirSync(path.join(repo, "dist"));
    fs.writeFileSync(path.join(repo, "dist", "index.js"), "built\n");
    fs.writeFileSync(path.join(repo, "src", "generated.ts"), "generated\n");
    fs.symlinkSync(path.join(home, "host-secret"), path.join(repo, "secret-link"));
    fs.writeFileSync(path.join(home, "host-secret"), "host secret\n");
    fs.mkdirSync(path.join(repo, ".sandcastle", "worktrees", "w"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".sandcastle", "worktrees", "w", "f"), "sandcastle's\n");
  };

  it("lists every untracked path, ignored or not, a wholly untracked directory once, and not Sandcastle's", async () => {
    populate();

    expect((await untrackedPaths(repo)).sort()).toEqual(["dist", "node_modules", "secret-link", "src/generated.ts"]);
  });

  it("copies each into the sandbox's home as it is created, links as links, nothing tracked", async () => {
    populate();
    const h = await create();
    try {
      const carry = await hostOf(h, "/home/agent/.carry");
      expect(fs.readFileSync(path.join(carry, "node_modules", "pkg", "bin", "run.js"), "utf8")).toBe("installed\n");
      expect(fs.readlinkSync(path.join(carry, "node_modules", ".bin", "run"))).toBe("../pkg/bin/run.js");
      expect(fs.readFileSync(path.join(carry, "dist", "index.js"), "utf8")).toBe("built\n");
      expect(fs.readFileSync(path.join(carry, "src", "generated.ts"), "utf8")).toBe("generated\n");
      // Copied as the link it is: the host file it names is not brought in.
      expect(fs.lstatSync(path.join(carry, "secret-link")).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(carry, "src", "index.ts"))).toBe(false);
      expect(fs.existsSync(path.join(carry, ".sandcastle"))).toBe(false);
      expect(fs.existsSync(path.join(carry, ".git"))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("is a copy: a change in the sandbox leaves the checkout's own untouched", async () => {
    populate();
    const h = await create();
    try {
      const carry = await hostOf(h, "/home/agent/.carry");
      fs.writeFileSync(path.join(carry, "dist", "index.js"), "changed\n");
      expect(fs.readFileSync(path.join(repo, "dist", "index.js"), "utf8")).toBe("built\n");
    } finally {
      await h.close();
    }
  });

  it("carries nothing where the checkout holds nothing outside git", async () => {
    fs.writeFileSync(path.join(repo, "tracked"), "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "base");
    const h = await create();
    try {
      expect(fs.existsSync(await hostOf(h, "/home/agent/.carry"))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("writes each carried path's exclude pattern beside them, for the hook", async () => {
    populate();
    const h = await create();
    try {
      const exclude = await hostOf(h, "/home/agent/.carry-exclude");
      expect(fs.readFileSync(exclude, "utf8").split("\n").sort()).toEqual(["", "/dist", "/node_modules", "/secret-link", "/src/generated.ts"]);
    } finally {
      await h.close();
    }
  });

  it("carries no path with a line break in it, which no exclude line can name", async () => {
    populate();
    fs.writeFileSync(path.join(repo, "two\nlines"), "x\n");
    const h = await create();
    try {
      expect(fs.existsSync(path.join(await hostOf(h, "/home/agent/.carry"), "two\nlines"))).toBe(false);
      expect(fs.readFileSync(await hostOf(h, "/home/agent/.carry-exclude"), "utf8")).not.toContain("two");
    } finally {
      await h.close();
    }
    expect(carriable("a\rb")).toBe(false);
    expect(carriable("a b")).toBe(true);
  });

  /**
   * Sandcastle's copy-out hands back every path `git ls-files --others
   * --exclude-standard` names in the worktree, and fails on a symlink that
   * leaves the sandbox. So every carried path is excluded, whatever its name,
   * and what the agent makes itself is still handed back.
   */
  it("excludes every carried path from the copy-out, whatever its name, and nothing the agent makes", () => {
    const [hook] = CARRY_HOOKS.sandbox.onSandboxReady;
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-sandbox-home-"));
    try {
      const carry = path.join(sandboxHome, ".carry");
      const worktree = path.join(sandboxHome, "workspace");
      fs.mkdirSync(worktree);
      git(worktree, "init", "--quiet");
      fs.writeFileSync(path.join(worktree, "tracked"), "x\n");
      git(worktree, "add", ".");
      git(worktree, "commit", "--quiet", "-m", "base");
      const names = ["#hash", "!bang", "star*", "q?", "[br]", "back\\slash", "trail ", "ünïcode", "a b", "secret-link", "dist"];
      fs.mkdirSync(carry);
      for (const name of names) fs.writeFileSync(path.join(carry, name), "carried\n");
      fs.rmSync(path.join(carry, "secret-link"));
      fs.symlinkSync("/nowhere/host-secret", path.join(carry, "secret-link"));
      fs.rmSync(path.join(carry, "dist"));
      fs.mkdirSync(path.join(carry, "dist"));
      fs.writeFileSync(path.join(carry, "dist", "index.js"), "built\n");
      fs.writeFileSync(`${carry}-exclude`, names.map((name) => `${excludePattern(name)}\n`).join(""));

      execFileSync("sh", ["-c", hook.command.split("/home/agent/.carry").join(carry)], { cwd: worktree, timeout: SUBPROCESS_TIMEOUT });
      // The agent's own, beside them, named like some of them.
      fs.writeFileSync(path.join(worktree, "made"), "new\n");
      fs.writeFileSync(path.join(worktree, "q1"), "new\n");
      fs.writeFileSync(path.join(worktree, "starry"), "new\n");
      fs.mkdirSync(path.join(worktree, "src"));
      fs.writeFileSync(path.join(worktree, "src", "dist"), "new\n");

      // What Sandcastle's copy-out runs, as it runs it.
      const handedBack = git(worktree, "ls-files", "--others", "--exclude-standard").trim().split("\n").sort();
      expect(handedBack).toEqual(["made", "q1", "src/dist", "starry"]);
      expect(fs.existsSync(`${carry}-exclude`)).toBe(false);
      for (const name of names) expect(fs.lstatSync(path.join(worktree, name)), name).toBeDefined();
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  it("is linked into the worktree by the hook, beside what Sandcastle cloned, and the staging removed", () => {
    const [hook] = CARRY_HOOKS.sandbox.onSandboxReady;
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-sandbox-home-"));
    try {
      const carry = path.join(sandboxHome, ".carry");
      const worktree = path.join(sandboxHome, "workspace");
      fs.mkdirSync(path.join(carry, "src"), { recursive: true });
      fs.mkdirSync(path.join(carry, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(carry, "src", "generated.ts"), "generated\n");
      fs.writeFileSync(path.join(carry, "node_modules", "run.js"), "installed\n");
      fs.symlinkSync("../run.js", path.join(carry, "node_modules", ".bin", "run"));
      fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
      fs.writeFileSync(path.join(worktree, "src", "index.ts"), "tracked\n");

      // The hook's own command, run where Sandcastle runs it, with the sandbox's home here instead.
      execFileSync("sh", ["-c", hook.command.split("/home/agent/.carry").join(carry)], { cwd: worktree, timeout: SUBPROCESS_TIMEOUT });

      expect(fs.readFileSync(path.join(worktree, "src", "index.ts"), "utf8")).toBe("tracked\n");
      expect(fs.readFileSync(path.join(worktree, "src", "generated.ts"), "utf8")).toBe("generated\n");
      expect(fs.readFileSync(path.join(worktree, "node_modules", "run.js"), "utf8")).toBe("installed\n");
      expect(fs.readlinkSync(path.join(worktree, "node_modules", ".bin", "run"))).toBe("../run.js");
      expect(fs.existsSync(carry)).toBe(false);

      // And does nothing where nothing was carried.
      execFileSync("sh", ["-c", hook.command.split("/home/agent/.carry").join(carry)], { cwd: worktree, timeout: SUBPROCESS_TIMEOUT });
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });
});

/**
 * The sandbox's network is its own loopback (#461): the proxy is its only way
 * out, through a socket bound in, rather than a variable a tool may ignore.
 */
describe("the network", () => {
  /** A `bwrap` that prints its arguments, one a line, put first on `PATH` for the test. */
  const fakeBwrap = (): string => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-bin-"));
    fs.writeFileSync(path.join(bin, "bwrap"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
    return bin;
  };
  /** The value following `flag`'s occurrence whose next word is `next`, or each `--setenv`'s value for `name`. */
  const after = (args: readonly string[], flag: string, next: string): string | undefined =>
    args.find((_, i) => args[i - 1] === flag && args[i + 1] === next);
  const setenv = (args: readonly string[], name: string): string[] =>
    args.flatMap((arg, i) => (args[i - 1] === "--setenv" && arg === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));

  let bin: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (bin !== undefined) fs.rmSync(bin, { recursive: true, force: true });
    bin = undefined;
  });

  it("is not the host's, and its one way out is the host end's socket, the relay started before the command", async () => {
    bin = fakeBwrap();
    const h = await create("http://agent:pw@10.0.0.5:8888");
    try {
      const { stdout } = await h.exec("echo hi");
      const args = stdout.trimEnd().split("\n");
      expect(args).toContain("--unshare-all");
      expect(args).not.toContain("--share-net");
      const socket = after(args, "--bind", "/run/proxy-relay/proxy.sock");
      expect(socket).toBeDefined();
      expect(fs.statSync(socket!).isSocket()).toBe(true);
      expect(after(args, "--ro-bind", "/run/proxy-relay/relay.mjs")).toBe(path.resolve("engine", "relay.mjs"));
      expect(after(args, "--ro-bind", "/run/proxy-relay/node")).toBe(process.execPath);
      for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
        expect(setenv(args, name), name).toEqual([`http://agent:pw@127.0.0.1:${RELAY_PORT}`]);
      }
      expect(args.filter((arg) => /^no_proxy$/i.test(arg))).toEqual([]);
      expect(args.slice(-7)).toEqual([
        "/run/proxy-relay/node",
        "/run/proxy-relay/relay.mjs",
        "/run/proxy-relay/proxy.sock",
        String(RELAY_PORT),
        "sh",
        "-c",
        "echo hi",
      ]);
    } finally {
      await h.close();
    }
  });

  it("is the same socket for every exec of one sandbox, gone on close, and another sandbox's is its own", async () => {
    bin = fakeBwrap();
    const socketOf = async (h: Handle): Promise<string> =>
      after((await h.exec("true")).stdout.trimEnd().split("\n"), "--bind", "/run/proxy-relay/proxy.sock")!;
    const [a, b] = await Promise.all([create(), create()]);
    const socket = await socketOf(a);
    try {
      expect(await socketOf(a)).toBe(socket);
      expect(await socketOf(b)).not.toBe(socket);
    } finally {
      await a.close();
    }
    expect(fs.existsSync(socket)).toBe(false);
    expect(fs.existsSync(path.dirname(socket))).toBe(false);
    try {
      expect(fs.statSync(await socketOf(b)).isSocket()).toBe(true);
    } finally {
      await b.close();
    }
  });

  it("refuses a proxy that is not a URL with a host, leaving no sandbox behind", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("bwrap-job-")).length;
    await expect(create("127.0.0.1:3128")).rejects.toThrow(/`127.0.0.1:3128` is not an `http:` URL with a host/);
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("bwrap-job-")).length).toBe(before);
  });

  it("is the host's, with no proxy variable at all, for a sandbox started with no relay (#537)", () => {
    const args = bwrapArgs({ home: "/h", tmp: "/t", roBinds: [], cwd: "/h", path: "/usr/bin", env: {} });
    expect(args).toContain("--share-net");
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy"]) expect(setenv(args, name)).toEqual([]);
    expect(args.some((arg) => arg.startsWith("/run/proxy-relay"))).toBe(false);
  });

  it("is its own for a sandbox started with a relay, the socket bound in and the inside end last", () => {
    const args = bwrapArgs({
      home: "/h",
      tmp: "/t",
      roBinds: [],
      cwd: "/h",
      path: "/usr/bin",
      relay: { socket: "/s/proxy.sock", proxy: "http://u:p@proxy:3128" },
      env: {},
    });
    expect(args).not.toContain("--share-net");
    expect(args.join(" ")).toContain("--bind /s/proxy.sock /run/proxy-relay/proxy.sock");
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
      expect(setenv(args, name)).toEqual([`http://u:p@127.0.0.1:${RELAY_PORT}`]);
    }
    expect(args.slice(-4)).toEqual(["/run/proxy-relay/node", "/run/proxy-relay/relay.mjs", "/run/proxy-relay/proxy.sock", String(RELAY_PORT)]);
  });
});

describe("a bind", () => {
  const layout = { home: "/h", tmp: "/t", cwd: "/h", path: "/usr/bin", env: {} };

  it("named by its path alone is mounted at that path, read-write or read-only", () => {
    const args = bwrapArgs({ ...layout, binds: ["/w"], roBinds: ["/w/.git", "/opt/node"] }).join(" ");
    expect(args).toContain("--bind /t /tmp --bind /w /w --ro-bind /w/.git /w/.git --ro-bind /opt/node /opt/node --chdir /h");
  });

  it("named with a path inside is mounted there, in the same place among the mounts (#526)", () => {
    const args = bwrapArgs({
      ...layout,
      binds: [{ host: "/w", at: "/home/agent/workspace" }],
      roBinds: [{ host: "/w/.git", at: "/home/agent/workspace/.git" }, "/opt/node"],
    }).join(" ");
    expect(args).toContain(
      "--bind /t /tmp --bind /w /home/agent/workspace --ro-bind /w/.git /home/agent/workspace/.git --ro-bind /opt/node /opt/node --chdir /h",
    );
  });
});

/**
 * Whether bubblewrap runs here with a network of its own: it needs the binary
 * and unprivileged user namespaces, which AppArmor refuses on some hosts.
 */
const bwrapRuns = (): boolean =>
  spawnSync("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

describe.skipIf(!bwrapRuns())("the network, in a real sandbox (skipped where bwrap or unprivileged user namespaces are unavailable)", () => {
  /** A stand-in proxy on the host's loopback, answering every request with `200 proxied`. */
  let proxy: Server;
  let proxyPort: number;
  beforeEach(async () => {
    proxy = createServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\nproxied"));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    proxyPort = address.port;
  });
  afterEach(async () => {
    await new Promise((resolve) => proxy.close(resolve));
  });

  /** A Node one-liner, run inside by the Node bound in: connect to `host`:`port`, send a request, print the reply or the error's code. */
  const probe = (host: string, port: string): string =>
    `/run/proxy-relay/node -e '` +
    `const s = require("net").connect(${port}, ${host}, () => s.write("GET http://example.com/ HTTP/1.1\\r\\nhost: example.com\\r\\n\\r\\n"));` +
    `let out = ""; s.on("data", (d) => (out += d)); s.on("end", () => console.log("reply:" + out.split("\\r\\n\\r\\n")[1]));` +
    `s.setTimeout(3000, () => { console.log("error:timeout"); s.destroy(); }); s.on("error", (e) => console.log("error:" + e.code));'`;

  it("reaches nothing directly, the host's loopback and the proxy's own port included, and the proxy through the variables", async () => {
    const h = await create(`http://127.0.0.1:${proxyPort}`);
    try {
      const direct = await h.exec(probe(`"127.0.0.1"`, String(proxyPort)));
      expect(direct.stdout).toMatch(/^error:/);
      const external = await h.exec(probe(`"1.1.1.1"`, "80"));
      expect(external.stdout).toMatch(/^error:/);
      const proxied = await h.exec(
        probe(`new URL(process.env.HTTP_PROXY).hostname`, `Number(new URL(process.env.HTTP_PROXY).port)`),
      );
      expect(proxied.stdout.trim()).toBe("reply:proxied");
      const interfaces = await h.exec("cat /proc/net/dev");
      expect(interfaces.stdout.split("\n").slice(2).filter((line) => line.trim() !== "").map((line) => line.split(":")[0]!.trim())).toEqual(["lo"]);
    } finally {
      await h.close();
    }
  });

  it("ends as the command ends, with its exit status", async () => {
    const h = await create(`http://127.0.0.1:${proxyPort}`);
    try {
      expect((await h.exec("exit 3")).exitCode).toBe(3);
      expect((await h.exec("echo out")).stdout).toBe("out\n");
    } finally {
      await h.close();
    }
  });
});
