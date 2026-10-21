import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertHostTarget, bwrap, CARRY_HOOKS, toHost, untrackedPaths } from "../../engine/bwrap.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * The guards are what this provider exists for: the sandbox chooses every name
 * that reaches them. None of these tests runs bubblewrap itself. CI's runners
 * cannot be relied on to have it, and a test that skips where it is missing
 * passes without testing anything; a live run on a host that has it is the
 * proof of the rest.
 */

interface Handle {
  readonly worktreePath: string;
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
  close(): Promise<void>;
}

let repo: string;
let home: string;

/** A sandbox as Sandcastle would create one, without running anything in it. */
const create = (): Promise<Handle> =>
  (
    bwrap({ roBinds: [], path: "/usr/bin:/bin", repoDir: repo, homeDir: home }) as unknown as {
      create(o: { env: Record<string, string> }): Promise<Handle>;
    }
  ).create({ env: {} });

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
    const provider = bwrap({ roBinds: [], path: "/usr/bin:/bin", repoDir: repo, homeDir: home }) as unknown as {
      create(o: { env: Record<string, string> }): Promise<Handle>;
    };
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-src-"));
    try {
      fs.mkdirSync(path.join(src, "-home-agent-workspace"));
      fs.writeFileSync(path.join(src, "-home-agent-workspace", "s-1.jsonl"), "{}\n");

      const first = await provider.create({ env: {} });
      await first.copyIn(src, "/home/agent/.claude/projects");
      await first.close();

      const encoded = repo.replace(/[\\/]/g, "-");
      expect(fs.readFileSync(path.join(home, ".claude", "projects", encoded, "s-1.jsonl"), "utf8")).toBe("{}\n");

      const second = await provider.create({ env: {} });
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
