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
import { BaseMoved, FetchFailed, GitError, gitFetcher, gitMerger, gitReader, gitWrites, githubRemote, type GitEnvironment } from "../../engine/git.js";
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
  openPullRequest: unused,
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

describe("fetchRef", () => {
  it("fetches a ref on the remote to the ref it names, over whatever was there, and returns its commit", async () => {
    git(work, "update-ref", "refs/rescue/feature", other);

    expect(await gitFetcher({ dir: work, env, remote }, TOKEN).fetchRef(REF, "refs/rescue/feature")).toBe(base);

    expect(git(work, "rev-parse", "refs/rescue/feature")).toBe(base);
  });

  it("throws where the remote has no such ref, and leaves the ref it names alone", async () => {
    await expect(gitFetcher({ dir: work, env, remote }, TOKEN).fetchRef("refs/heads/gone", "refs/rescue/gone")).rejects.toBeInstanceOf(GitError);

    expect(() => git(work, "rev-parse", "--verify", "--quiet", "refs/rescue/gone")).toThrow();
  });

  it("refuses a ref that is not a full ref name", async () => {
    await expect(gitFetcher({ dir: work, env, remote }, TOKEN).fetchRef("feature", "refs/rescue/feature")).rejects.toThrow(
      "`feature` is not a full ref name",
    );
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

  it("is left in no file under .git by a fetch either", async () => {
    await gitFetcher({ dir: work, env, remote }, TOKEN).fetchRef(REF, "refs/rescue/feature");

    const files = fs.readdirSync(path.join(work, ".git"), { recursive: true, encoding: "utf8" });
    for (const file of files) {
      const full = path.join(work, ".git", file);
      if (!fs.statSync(full).isFile()) continue;
      const text = fs.readFileSync(full, "latin1");
      expect(text, file).not.toContain(TOKEN);
      expect(text, file).not.toContain(HEADER);
    }
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

describe("isAncestor", () => {
  it("is true for a commit in another's history, and for the commit itself", async () => {
    const reader = gitReader({ dir: work, env });

    expect(await reader.isAncestor(base, next)).toBe(true);
    expect(await reader.isAncestor(next, next)).toBe(true);
  });

  it("is false for a sibling and for a descendant", async () => {
    const reader = gitReader({ dir: work, env });

    expect(await reader.isAncestor(next, other)).toBe(false);
    expect(await reader.isAncestor(next, base)).toBe(false);
  });

  it("throws where the repository does not hold a commit, rather than reading it as not built on", async () => {
    await expect(gitReader({ dir: work, env }).isAncestor("f".repeat(40), next)).rejects.toBeInstanceOf(GitError);
  });
});

describe("changedPaths", () => {
  it("names each path under the directory handed in that one commit changes from another, and nothing outside it", async () => {
    git(work, "checkout", "--quiet", "--detach", base);
    fs.mkdirSync(path.join(work, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(work, ".github", "workflows", "ci.yml"), "on: push\n");
    fs.writeFileSync(path.join(work, "notes.md"), "notes\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "both");
    const changed = git(work, "rev-parse", "HEAD");
    const reader = gitReader({ dir: work, env });

    expect(await reader.changedPaths(base, changed, ".github/workflows")).toEqual([".github/workflows/ci.yml"]);
    expect(await reader.changedPaths(base, base, ".github/workflows")).toEqual([]);
  });

  it("throws where the repository does not hold a commit, rather than reading it as no change", async () => {
    await expect(gitReader({ dir: work, env }).changedPaths("f".repeat(40), next, ".github/workflows")).rejects.toBeInstanceOf(GitError);
  });
});

/**
 * The merge of a base branch into a pull request's (#481), against a real
 * origin and a clone of it checked out at the pull request's head, as a
 * workflow's checkout leaves it: detached. Each case spawns git about a
 * dozen times.
 */
describe("merge", { timeout: 20 * SUBPROCESS_TIMEOUT }, () => {
  const IDENTITY = { name: "loop[bot]", email: "loop[bot]@example.com" };
  let origin: string;
  let seed: string;
  let clone: string;
  let head: string;

  const write = (dir: string, file: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, "add", file);
    git(dir, "commit", "--quiet", "-m", file);
    return git(dir, "rev-parse", "HEAD");
  };

  /** `seed`'s `main` moved on, pushed to `origin`. */
  const moveMain = (file: string, text: string): string => {
    git(seed, "checkout", "--quiet", "main");
    const moved = write(seed, file, text);
    git(seed, "push", "--quiet", origin, "main");
    return moved;
  };

  /** The clone checked out detached at the pull request's head, as `actions/checkout` leaves it. */
  const checkOut = (): void => {
    clone = path.join(scratch, "clone");
    git(scratch, "clone", "--quiet", "--no-checkout", origin, clone);
    git(clone, "checkout", "--quiet", "--detach", head);
  };

  const mergeIn = (base = "main", spawnEnv: GitEnvironment = env, commit?: string) =>
    gitMerger({ dir: clone, env: spawnEnv }, gitFetcher({ dir: clone, env: spawnEnv, remote: origin }, TOKEN)).merge({
      base,
      into: "feature",
      identity: IDENTITY,
      ...(commit === undefined ? {} : { commit }),
    });

  beforeEach(() => {
    origin = path.join(scratch, "origin.git");
    seed = path.join(scratch, "seed");
    git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(scratch, "init", "--quiet", "--initial-branch=main", seed);
    write(seed, "shared.txt", "one\n");
    git(seed, "push", "--quiet", origin, "main");
    git(seed, "checkout", "--quiet", "-b", "feature");
    head = write(seed, "feature.txt", "feature\n");
    git(seed, "push", "--quiet", origin, "feature");
  }, 20 * SUBPROCESS_TIMEOUT);

  it("is up to date where the branch already holds the base, and makes no commit", async () => {
    checkOut();

    expect(await mergeIn()).toEqual({ status: "uptodate", base: git(seed, "rev-parse", "main") });
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "symbolic-ref", "HEAD")).toBe("refs/heads/feature");
  });

  it("merges a base that moved on cleanly, as the identity handed in, and returns the commit", async () => {
    const moved = moveMain("main.txt", "main\n");
    checkOut();

    const merged = await mergeIn();

    const commit = git(clone, "rev-parse", "HEAD");
    expect(merged).toEqual({ status: "clean", base: moved, commit });
    expect(git(clone, "rev-parse", "HEAD^1", "HEAD^2").split("\n")).toEqual([head, moved]);
    expect(git(clone, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s")).toBe(
      "loop[bot] <loop[bot]@example.com>|loop[bot] <loop[bot]@example.com>|Merge remote-tracking branch 'origin/main' into feature",
    );
    expect(git(clone, "symbolic-ref", "HEAD")).toBe("refs/heads/feature");
    expect(git(clone, "rev-parse", "refs/remotes/origin/main")).toBe(moved);
  });

  it("stops on a conflict, naming each conflicted path, and leaves the conflicted tree", async () => {
    git(seed, "checkout", "--quiet", "feature");
    write(seed, "shared.txt", "feature's\n");
    write(seed, "a dir/with space.txt", "feature's\n");
    head = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "--quiet", origin, "feature");
    moveMain("shared.txt", "main's\n");
    moveMain("a dir/with space.txt", "main's\n");
    write(seed, "main-only.txt", "clean\n");
    git(seed, "push", "--quiet", origin, "main");
    checkOut();

    const merged = await mergeIn();

    expect(merged).toEqual({ status: "conflicts", base: git(seed, "rev-parse", "main"), conflicts: ["a dir/with space.txt", "shared.txt"] });
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(clone, "shared.txt"), "utf8")).toContain("<<<<<<<");
    expect(git(clone, "config", "user.name")).toBe(IDENTITY.name);
  });

  /**
   * `implement-prd:catch-up`'s merge (#500): its own message, carrying the
   * trailer the record reads, and always a merge commit, even where the
   * branch is behind the base, so the trailer is never fast-forwarded away.
   */
  it("makes the merge commit with the message handed in, never a fast-forward", async () => {
    git(seed, "checkout", "--quiet", "feature");
    git(seed, "reset", "--quiet", "--hard", "main");
    head = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "--quiet", "--force", origin, "feature");
    const moved = moveMain("main.txt", "main\n");
    checkOut();

    const merged = await gitMerger({ dir: clone, env }, gitFetcher({ dir: clone, env, remote: origin }, TOKEN)).merge({
      base: "main",
      into: "feature",
      identity: IDENTITY,
      message: "Merge main into feature\n\nAgent-Catch-Up: #7",
    });

    expect(merged).toEqual({ status: "clean", base: moved, commit: git(clone, "rev-parse", "HEAD") });
    expect(git(clone, "rev-parse", "HEAD^1", "HEAD^2").split("\n")).toEqual([head, moved]);
    expect(git(clone, "log", "-1", "--format=%B")).toBe("Merge main into feature\n\nAgent-Catch-Up: #7");
  });

  it("makes the branch at the commit handed in as `from`, rather than at the one checked out", async () => {
    const moved = moveMain("main.txt", "main\n");
    const before = git(seed, "rev-parse", "main~1");
    checkOut();
    git(clone, "checkout", "--quiet", "--detach", before);

    const merged = await gitMerger({ dir: clone, env }, gitFetcher({ dir: clone, env, remote: origin }, TOKEN)).merge({
      base: "main",
      into: "feature",
      identity: IDENTITY,
      from: head,
    });

    expect(merged.status).toBe("clean");
    expect(git(clone, "rev-parse", "HEAD^1", "HEAD^2").split("\n")).toEqual([head, moved]);
    expect(git(clone, "symbolic-ref", "HEAD")).toBe("refs/heads/feature");
  });

  it("throws FetchFailed where the base cannot be fetched, and leaves the checkout as it was", async () => {
    checkOut();

    await expect(mergeIn("gone")).rejects.toBeInstanceOf(FetchFailed);

    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(() => git(clone, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(() => git(clone, "config", "user.name")).toThrow();
  });

  /**
   * A merge made again (#482): the base commit an earlier merge read, merged
   * under the base's name though the base has moved on since, so the merge
   * and its message are the earlier one's.
   */
  it("merges the base commit handed in, where the base has moved on from it, under the base's name", async () => {
    const earlier = moveMain("main.txt", "main\n");
    const later = moveMain("later.txt", "later\n");
    checkOut();

    const merged = await mergeIn("main", env, earlier);

    expect(merged).toMatchObject({ status: "clean", base: earlier });
    expect(git(clone, "rev-parse", "HEAD^2")).toBe(earlier);
    expect(git(clone, "rev-parse", "refs/remotes/origin/main")).toBe(earlier);
    expect(git(clone, "log", "-1", "--format=%s")).toBe("Merge remote-tracking branch 'origin/main' into feature");
    expect(later).not.toBe(earlier);
  });

  it("throws BaseMoved where the base no longer holds the commit handed in, and merges nothing", async () => {
    const earlier = moveMain("main.txt", "main\n");
    // Cloned while the base held it, so the commit is in the repository: what moved is the base.
    checkOut();
    git(seed, "reset", "--quiet", "--hard", "HEAD~1");
    write(seed, "rewritten.txt", "rewritten\n");
    git(seed, "push", "--quiet", "--force", origin, "main");

    await expect(mergeIn("main", env, earlier)).rejects.toBeInstanceOf(BaseMoved);
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(() => git(clone, "symbolic-ref", "--quiet", "HEAD")).toThrow();
  });

  it("throws BaseMoved where the repository holds no such commit at all", async () => {
    checkOut();

    await expect(mergeIn("main", env, "f".repeat(40))).rejects.toBeInstanceOf(BaseMoved);
  });

  it("fetches with the token in its environment, never on an argv or in a file under .git", async () => {
    moveMain("main.txt", "main\n");
    checkOut();
    const real = execFileSync("sh", ["-c", "command -v git"], { env, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT }).trim();
    const bin = path.join(scratch, "bin");
    const record = path.join(scratch, "record");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${record}.argv"\nexec "${real}" "$@"\n`, { mode: 0o755 });

    expect((await mergeIn("main", { ...env, PATH: `${bin}:${env["PATH"] ?? ""}` })).status).toBe("clean");

    const argv = fs.readFileSync(`${record}.argv`, "utf8");
    expect(argv).toContain("fetch");
    expect(argv).toContain("merge");
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(HEADER);
    for (const file of fs.readdirSync(path.join(clone, ".git"), { recursive: true, encoding: "utf8" })) {
      const full = path.join(clone, ".git", file);
      if (!fs.statSync(full).isFile()) continue;
      const text = fs.readFileSync(full, "latin1");
      expect(text, file).not.toContain(TOKEN);
      expect(text, file).not.toContain(HEADER);
    }
  });
});
