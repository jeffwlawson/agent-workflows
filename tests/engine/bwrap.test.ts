import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertHostTarget, bwrap, toHost } from "../../engine/bwrap.js";

/**
 * The guards are what this provider exists for: the sandbox chooses every name
 * that reaches them. None of these tests runs bubblewrap itself. CI's runners
 * cannot be relied on to have it, and a test that skips where it is missing
 * passes without testing anything; a live run on a host that has it is the
 * proof of the rest.
 */

interface Handle {
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

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-repo-"));
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
      expect(fs.existsSync(path.join(repo, ".git"))).toBe(false);
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
