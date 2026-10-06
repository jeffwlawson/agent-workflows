import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertHostTarget, bwrap, toHost } from "../shared/bwrap.js";
import { sandboxFromEnv } from "../shared/sandbox.js";

// The guards are what this provider exists for: the sandbox chooses every name
// that reaches them. None of these tests runs bwrap itself.

interface Handle {
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
  close(): Promise<void>;
}
const create = (): Promise<Handle> =>
  (bwrap() as unknown as { create(o: { env: Record<string, string> }): Promise<Handle> }).create({ env: {} });

let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-repo-"));
  vi.spyOn(process, "cwd").mockReturnValue(repo);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
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
      expect(() => assertHostTarget(ok), ok).not.toThrow();
    }
  });

  it("accepts Sandcastle's session temp files, and no other temp file", () => {
    expect(() => assertHostTarget(path.join(os.tmpdir(), "sandcastle-claude-cap-1-x7.jsonl"))).not.toThrow();
    expect(() => assertHostTarget(path.join(os.tmpdir(), "other.jsonl"))).toThrow(/outside the patch directory/);
  });

  it("refuses anything with a .git component", () => {
    expect(() => assertHostTarget(sc("patches", "r", "..", "..", "..", ".git", "config"))).toThrow(/\.git/);
    expect(() => assertHostTarget(sc("patches", "r", "untracked", ".git", "hooks", "post-checkout"))).toThrow(/\.git/);
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
      expect(() => assertHostTarget(bad), bad).toThrow(/outside the patch directory/);
    }
  });

  it("does not take a 'patches' in the repository's own path as permission", () => {
    const nested = path.join(repo, "patches", "repo");
    vi.spyOn(process, "cwd").mockReturnValue(nested);
    expect(() => assertHostTarget(path.join(nested, ".sandcastle", "worktrees", "x", "hooks-y"))).toThrow();
  });

  it("refuses escapes out of the patch directory and paths elsewhere on the host", () => {
    expect(() => assertHostTarget(sc("patches", "r", "..", "..", "..", "src", "index.ts"))).toThrow();
    expect(() => assertHostTarget(path.join(os.homedir(), "evil.txt"))).toThrow();
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
      await expect(
        h.copyFileOut("/etc/passwd", path.join(repo, ".sandcastle", "patches", "r", "p")),
      ).rejects.toThrow(/outside the sandbox's writable paths/);
    } finally {
      await h.close();
    }
  });
});

describe("sandboxFromEnv", () => {
  afterEach(() => {
    delete process.env["AGENT_SANDBOX"];
  });
  it("keeps today's behaviour when unset", () => {
    delete process.env["AGENT_SANDBOX"];
    expect((sandboxFromEnv() as { name: string }).name).not.toBe("bwrap");
  });
  it("selects bwrap", () => {
    process.env["AGENT_SANDBOX"] = "bwrap";
    expect((sandboxFromEnv() as { name: string }).name).toBe("bwrap");
  });
  it("refuses an unknown value rather than falling back", () => {
    process.env["AGENT_SANDBOX"] = "vm";
    expect(() => sandboxFromEnv()).toThrow(/AGENT_SANDBOX=vm/);
  });
});
