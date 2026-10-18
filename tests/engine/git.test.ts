/**
 * The engine's git writes and its bundle check, against a real temporary bare
 * repository rather than a fake: a lease is git's to check, and a fake push
 * proves nothing about one. Every spawn the test makes itself is bounded at
 * `SUBPROCESS_TIMEOUT`; the engine's own are asynchronous, inside the test's.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, gitReader, gitWrites, githubRemote, type GitEnvironment } from "../../engine/git.js";
import { createWriters, WriteFailed, type LogEntry } from "../../engine/writer.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

const TOKEN = "ghs_not-a-real-token-0123456789";
const HEADER = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const REF = "refs/heads/feature";

let scratch: string;
let remote: string;
let work: string;
let env: GitEnvironment;
/** Commits in `work`: `base`, `next` on top of it, and `other`, a sibling of `next`. */
let base: string;
let next: string;
let other: string;

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd: dir,
    env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
  }).trim();

const commit = (message: string, parent?: string): string =>
  git(work, "commit-tree", git(work, "write-tree"), ...(parent === undefined ? [] : ["-p", parent]), "-m", message);

const remoteTip = (ref: string): string | undefined => {
  try {
    return git(remote, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return undefined;
  }
};

/** Writers over the git writes alone, pushing from `work` to `remote`; any other type is not this file's. */
const writersFor = (spawnEnv: GitEnvironment = env) => {
  const lines: string[] = [];
  const { writers, log } = createWriters({
    backends: {
      loop: {
        ...unusedGitHubHalf,
        ...gitWrites({ dir: work, env: spawnEnv, remote }, TOKEN),
      },
    },
    limits: { pushRef: 9, deleteRef: 9 },
    appendLine: (line) => lines.push(line),
  });
  return { writer: writers.loop, entries: log.entries as readonly LogEntry[], lines };
};

const unused = (): never => {
  throw new Error("not a git write");
};
const unusedGitHubHalf = {
  addLabel: unused,
  removeLabel: unused,
  setCommitStatus: unused,
  comment: unused,
  markReadyForReview: unused,
  postReview: unused,
  replyAndResolve: unused,
  reply: unused,
  editPullRequest: unused,
};

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "engine-git-"));
  env = { PATH: process.env["PATH"] ?? "", HOME: scratch };
  remote = path.join(scratch, "remote.git");
  work = path.join(scratch, "work");
  git(scratch, "init", "--quiet", "--bare", remote);
  git(scratch, "init", "--quiet", work);
  base = commit("base");
  next = commit("next", base);
  other = commit("other", base);
  git(work, "push", "--quiet", remote, `${base}:${REF}`);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("pushRef", () => {
  it("pushes over the tip its lease names", async () => {
    const { writer, entries } = writersFor();

    expect(await writer.pushRef({ ref: REF, commit: next, lease: { tip: base } })).toEqual({ outcome: "applied" });

    expect(remoteTip(REF)).toBe(next);
    expect(entries[0]).toMatchObject({ type: "pushRef", target: `${REF} ${next.slice(0, 7)} over ${base.slice(0, 7)}`, outcome: "applied", calls: ["git push ok"] });
  });

  it("forces a push that is not a fast-forward, where the lease holds", async () => {
    git(work, "push", "--quiet", remote, `${next}:${REF}`, "--force");
    const { writer } = writersFor();

    await writer.pushRef({ ref: REF, commit: other, lease: { tip: next } });

    expect(remoteTip(REF)).toBe(other);
  });

  it("logs a lost lease failed, throws WriteFailed, and leaves the ref where another push put it", async () => {
    git(work, "push", "--quiet", remote, `${other}:${REF}`, "--force");
    const { writer, entries } = writersFor();

    const failed = await writer.pushRef({ ref: REF, commit: next, lease: { tip: base } }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(WriteFailed);
    expect((failed as WriteFailed).cause).toBeInstanceOf(GitError);
    expect(((failed as WriteFailed).cause as GitError).leaseLost).toBe(true);
    expect(entries[0]).toMatchObject({ outcome: "failed" });
    expect(entries[0]?.calls[0]).toMatch(/^git push rejected: .*stale info/);
    expect(remoteTip(REF)).toBe(other);
  });

  it("pushes a new ref where its lease says it must not exist", async () => {
    const { writer, entries } = writersFor();

    await writer.pushRef({ ref: "refs/heads/rescue", commit: next, lease: { absent: true } });

    expect(remoteTip("refs/heads/rescue")).toBe(next);
    expect(entries[0]?.target).toBe(`refs/heads/rescue ${next.slice(0, 7)} new`);
  });

  it("fails where the ref it must not find is there, and leaves it", async () => {
    const { writer, entries } = writersFor();

    await expect(writer.pushRef({ ref: REF, commit: next, lease: { absent: true } })).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]?.outcome).toBe("failed");
    expect(remoteTip(REF)).toBe(base);
  });

  it("is unchanged where the ref is already at the commit", async () => {
    const { writer } = writersFor();

    expect(await writer.pushRef({ ref: REF, commit: base, lease: { tip: base } })).toEqual({ outcome: "unchanged" });
  });

  it("is unchanged where the ref is already at the commit, whatever the lease says", async () => {
    const { writer } = writersFor();

    expect(await writer.pushRef({ ref: REF, commit: base, lease: { tip: next } })).toEqual({ outcome: "unchanged" });
    expect(await writer.pushRef({ ref: REF, commit: base, lease: { absent: true } })).toEqual({ outcome: "unchanged" });
    expect(remoteTip(REF)).toBe(base);
  });

  it("refuses a bare branch name before any push", async () => {
    const { writer, entries } = writersFor();

    await expect(writer.pushRef({ ref: "feature", commit: next, lease: { tip: base } })).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]?.calls).toEqual(["`feature` is not a full ref name; name it as `refs/heads/feature`."]);
    expect(remoteTip(REF)).toBe(base);
  });
});

describe("deleteRef", () => {
  it("deletes the ref where it is at the tip the lease names", async () => {
    const { writer, entries } = writersFor();

    expect(await writer.deleteRef({ ref: REF, lease: { tip: base } })).toEqual({ outcome: "applied" });

    expect(remoteTip(REF)).toBeUndefined();
    expect(entries[0]).toMatchObject({ type: "deleteRef", target: `${REF} at ${base.slice(0, 7)}`, outcome: "applied" });
  });

  it("logs a lost lease failed, throws WriteFailed, and keeps a ref another run rewrote", async () => {
    git(work, "push", "--quiet", remote, `${next}:${REF}`);
    const { writer, entries } = writersFor();

    await expect(writer.deleteRef({ ref: REF, lease: { tip: base } })).rejects.toBeInstanceOf(WriteFailed);

    expect(entries[0]?.outcome).toBe("failed");
    expect(remoteTip(REF)).toBe(next);
  });
});

describe("the token", () => {
  it("never reaches the checkout's git config or any file under .git", async () => {
    const { writer, lines } = writersFor();

    await writer.pushRef({ ref: REF, commit: next, lease: { tip: base } });

    expect(fs.readFileSync(path.join(work, ".git", "config"), "utf8")).not.toMatch(/extraheader|AUTHORIZATION/i);
    const files = fs.readdirSync(path.join(work, ".git"), { recursive: true, encoding: "utf8" });
    for (const file of files) {
      const full = path.join(work, ".git", file);
      if (!fs.statSync(full).isFile()) continue;
      const text = fs.readFileSync(full, "latin1");
      expect(text, file).not.toContain(TOKEN);
      expect(text, file).not.toContain(HEADER);
    }
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("is passed to git in its environment, never on its argv, over the environment handed in", async () => {
    // A `git` first on the handed-in PATH that records what it was started with, then runs the real one.
    const real = execFileSync("sh", ["-c", "command -v git"], { env, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT }).trim();
    const bin = path.join(scratch, "bin");
    const record = path.join(scratch, "record");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\nenv > "${record}.env"\nprintf '%s\\n' "$@" > "${record}.argv"\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    const handed = { ...env, PATH: `${bin}:${env["PATH"] ?? ""}`, HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" };
    const { writer } = writersFor(handed);

    await writer.pushRef({ ref: REF, commit: next, lease: { tip: base } });

    const started = Object.fromEntries(
      fs
        .readFileSync(`${record}.env`, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    // What the shell itself sets on starting is not git's environment.
    for (const shell of ["PWD", "OLDPWD", "SHLVL", "_"]) delete started[shell];
    expect(started).toEqual({
      ...handed,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${HEADER}`,
    });
    const argv = fs.readFileSync(`${record}.argv`, "utf8");
    expect(argv).toContain(`--force-with-lease=${REF}:${base}`);
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(HEADER);
    expect(argv).not.toMatch(/extraheader/i);
  });

  it("is pushed to the repository on GitHub, named as the checkout fetches it", () => {
    expect(githubRemote("o/r")).toBe("https://github.com/o/r.git");
  });
});

describe("verifyBundle", () => {
  let bundle: string;
  let clone: string;

  beforeEach(() => {
    git(work, "update-ref", "refs/heads/main", base);
    git(work, "update-ref", REF, next);
    bundle = path.join(scratch, "branch.bundle");
    git(work, "bundle", "create", "--quiet", bundle, "main..feature");
    // A repository holding what the bundle builds on and nothing it carries.
    clone = path.join(scratch, "clone");
    git(scratch, "init", "--quiet", clone);
    git(clone, "fetch", "--quiet", remote, `${REF}:refs/heads/base`);
  });

  it("returns the heads of a good bundle, and unbundles its commits into the repository", async () => {
    const heads = await gitReader({ dir: clone, env }).verifyBundle(bundle);

    expect(heads).toEqual([{ ref: REF, commit: next }]);
    expect(git(clone, "cat-file", "-t", next)).toBe("commit");
  });

  it("rejects a damaged bundle", async () => {
    const bytes = fs.readFileSync(bundle);
    fs.writeFileSync(bundle, bytes.subarray(0, bytes.length - 20));

    await expect(gitReader({ dir: clone, env }).verifyBundle(bundle)).rejects.toBeInstanceOf(GitError);
  });

  it("rejects a bundle whose base the repository does not have", async () => {
    const empty = path.join(scratch, "empty");
    git(scratch, "init", "--quiet", empty);

    await expect(gitReader({ dir: empty, env }).verifyBundle(bundle)).rejects.toBeInstanceOf(GitError);
  });
});
