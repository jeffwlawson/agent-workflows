import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { bwrap, CARRY_HOOKS } from "../engine/bwrap.js";
import { agentSandbox, concludingMerge, type AgentSandbox, type SandboxInputs } from "../shared/agent.js";
import { SANDBOX } from "../shared/contract.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The sandbox selector, fed what `readInputs` hands it. An unknown
 * `AGENT_SANDBOX` never reaches it: `readInputs` fails the run first, naming
 * the value, which `tests/common.test.ts` holds for every runner.
 */
describe("agentSandbox: the provider a runner's inputs select", () => {
  /** The declared defaults, which is what an orchestrator that sets none of them gives. */
  const unset: SandboxInputs = {
    AGENT_SANDBOX: SANDBOX.AGENT_SANDBOX.default,
    AGENT_SANDBOX_RO_BINDS: SANDBOX.AGENT_SANDBOX_RO_BINDS.default,
    AGENT_SANDBOX_PATH: SANDBOX.AGENT_SANDBOX_PATH.default,
    AGENT_SANDBOX_PROXY: SANDBOX.AGENT_SANDBOX_PROXY.default,
  };

  it("keeps today's behaviour when unset", () => {
    expect(agentSandbox(unset).sandbox.name).toBe("no-sandbox");
    expect(agentSandbox(unset)).not.toHaveProperty("hooks");
  });

  it("selects bwrap, with the hooks that carry the checkout's untracked files into its worktree", () => {
    const selected = agentSandbox({ ...unset, AGENT_SANDBOX: "bwrap", AGENT_SANDBOX_PROXY: "http://127.0.0.1:3128" });
    expect(selected.sandbox.name).toBe("bwrap");
    expect(selected).toHaveProperty("hooks", CARRY_HOOKS);
  });

  /**
   * `bwrap`'s network is its own, the proxy its only way out (#461), so with
   * none the agent would reach nothing: the run ends before the agent starts,
   * through `fail()`, so `failure_reason.txt` names the input.
   */
  describe("refusing bwrap without a proxy it can reach", () => {
    class Exited extends Error {}
    let scratch: string;
    let exit: MockInstance<typeof process.exit>;
    let logged: MockInstance<typeof console.error>;

    beforeEach(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sandbox-"));
      vi.stubEnv("OUTPUT_DIR", scratch);
      exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Exited();
      }) as never);
      logged = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      exit.mockRestore();
      logged.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(scratch, { recursive: true, force: true });
    });

    const reason = (): string => fs.readFileSync(path.join(scratch, "failure_reason.txt"), "utf8");

    it("ends the run on an empty AGENT_SANDBOX_PROXY, naming it", () => {
      expect(() => agentSandbox({ ...unset, AGENT_SANDBOX: "bwrap" })).toThrow(Exited);
      expect(exit).toHaveBeenCalledWith(1);
      expect(reason()).toContain("`AGENT_SANDBOX_PROXY`");
    });

    it.each(["127.0.0.1:3128", "socks5://127.0.0.1:1080"])("ends the run on an AGENT_SANDBOX_PROXY of %s, naming it", (proxy) => {
      expect(() => agentSandbox({ ...unset, AGENT_SANDBOX: "bwrap", AGENT_SANDBOX_PROXY: proxy })).toThrow(Exited);
      expect(reason()).toBe(`\`AGENT_SANDBOX_PROXY\` is \`${proxy}\`, which is not an \`http:\` URL with a host.`);
    });

    // #535: the sandbox names the proxy by a loopback address, which an
    // `https:` proxy's certificate does not name, so TLS to it would fail.
    it("ends the run on an https: AGENT_SANDBOX_PROXY, naming it and asking for the http: URL", () => {
      const proxy = "https://proxy.example:3128";
      expect(() => agentSandbox({ ...unset, AGENT_SANDBOX: "bwrap", AGENT_SANDBOX_PROXY: proxy })).toThrow(Exited);
      expect(exit).toHaveBeenCalledWith(1);
      expect(reason()).toContain(`\`AGENT_SANDBOX_PROXY\` is \`${proxy}\`, an \`https:\` URL`);
      expect(reason()).toContain("loopback address");
      expect(reason()).toContain("Set `AGENT_SANDBOX_PROXY` to the proxy's `http:` URL.");
      expect(reason()).not.toContain("not an `http:` URL with a host");
    });

    it("asks no proxy of none", () => {
      expect(agentSandbox(unset).sandbox.name).toBe("no-sandbox");
      expect(exit).not.toHaveBeenCalled();
    });
  });
});

/**
 * The merge `update-branch:prepare` leaves in progress, carried to the agent
 * and its commit carried back (#463's run). With no sandbox there is nothing
 * to carry. An isolated sandbox starts from the checkout's history and hands
 * commits back as patches, so it carries neither `MERGE_HEAD` nor a merge
 * commit, and Sandcastle's own merge back into the checkout is refused
 * mid-merge, which is how the run on #463 stopped.
 */
describe("concludingMerge: the merge in progress, through the agent's sandbox", () => {
  let scratch: string;
  let repo: string;
  let head: string;
  let base: string;

  const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT }).trim();
  const SUBJECT = "Merge remote-tracking branch 'origin/main' into feat";
  const BRANCH = "sandcastle/update-branch-pr-1/merge";

  /** A checkout as `update-branch:prepare` leaves one: `feat` mid-merge with `origin/main`, `f` conflicted, `g` added. */
  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "concluding-merge-")));
    repo = path.join(scratch, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.name", "loop");
    git(repo, "config", "user.email", "loop@example.com");
    fs.writeFileSync(path.join(repo, "f"), "a\n");
    git(repo, "add", "f");
    git(repo, "commit", "--quiet", "-m", "base");
    git(repo, "checkout", "--quiet", "-b", "feat");
    fs.writeFileSync(path.join(repo, "f"), "feat\n");
    git(repo, "commit", "--quiet", "-am", "feat");
    git(repo, "checkout", "--quiet", "main");
    fs.writeFileSync(path.join(repo, "f"), "main\n");
    fs.writeFileSync(path.join(repo, "g"), "g\n");
    git(repo, "add", "f", "g");
    git(repo, "commit", "--quiet", "-m", "main");
    git(repo, "update-ref", "refs/remotes/origin/main", "main");
    git(repo, "checkout", "--quiet", "feat");
    spawnSync("git", ["merge", "--no-edit", "origin/main"], { cwd: repo, timeout: SUBPROCESS_TIMEOUT });
    // What the setup leaves outside git, which the carry hook brings in.
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.writeFileSync(path.join(repo, "node_modules", "dep.js"), "");
    head = git(repo, "rev-parse", "HEAD");
    base = git(repo, "rev-parse", "MERGE_HEAD");
    expect(git(repo, "diff", "--name-only", "--diff-filter=U")).toBe("f");
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const isolated = (): AgentSandbox => ({
    sandbox: bwrap({ roBinds: [], path: "/usr/bin:/bin", proxy: "http://127.0.0.1:9", repoDir: repo, homeDir: scratch }),
    hooks: CARRY_HOOKS,
  });

  /** The merge `conclude` should leave: on `feat`, the head and the base its parents, committed, nothing in progress. */
  const expectMerged = (resolved: string, body: string): void => {
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
    expect(git(repo, "log", "-1", "--format=%P").split(" ")).toEqual([head, base]);
    expect(git(repo, "show", "HEAD:f")).toBe(resolved);
    expect(git(repo, "show", "HEAD:g")).toBe("g");
    expect(git(repo, "log", "-1", "--format=%B")).toBe(`${SUBJECT}\n\n${body}`);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(git(repo, "branch", "--list", BRANCH)).toBe("");
    expect(fs.existsSync(path.join(repo, "node_modules", "dep.js"))).toBe(true);
  };

  it("is the sandbox's own options with no sandbox, where the agent concludes the merge in the checkout", () => {
    const chosen = agentSandbox({
      AGENT_SANDBOX: "none",
      AGENT_SANDBOX_RO_BINDS: "",
      AGENT_SANDBOX_PATH: SANDBOX.AGENT_SANDBOX_PATH.default,
      AGENT_SANDBOX_PROXY: "",
    });
    const merge = concludingMerge(chosen, repo, "update-branch-pr-1");
    expect(merge.options).toBe(chosen);
    merge.conclude();
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  });

  it("gives an isolated sandbox's agent a branch of its own at the head, so nothing is merged into the checkout mid-merge", () => {
    const merge = concludingMerge(isolated(), repo, "update-branch-pr-1");
    expect(merge.options.branchStrategy).toEqual({ type: "branch", branch: BRANCH });
    expect(git(repo, "rev-parse", BRANCH)).toBe(head);
    expect(merge.options.hooks?.sandbox?.onSandboxReady).toHaveLength(1);
  });

  describe("its hook, in a copy cloned as Sandcastle clones one", () => {
    /** Sandcastle's sync-in: a worktree on the branch, bundled with every ref and cloned, the branch checked out. */
    const copy = (branch: string): { readonly dir: string; readonly carry: string } => {
      const worktree = path.join(scratch, "worktree");
      git(repo, "worktree", "add", "--quiet", worktree, branch);
      git(worktree, "bundle", "create", "--quiet", path.join(scratch, "repo.bundle"), "--all");
      const dir = path.join(scratch, "copy");
      git(scratch, "clone", "--quiet", path.join(scratch, "repo.bundle"), dir);
      git(dir, "checkout", "--quiet", branch);
      git(repo, "worktree", "remove", worktree);
      const carry = path.join(scratch, "carry");
      fs.mkdirSync(path.join(carry, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(carry, "node_modules", "dep.js"), "");
      return { dir, carry };
    };
    const runHook = (merge: ReturnType<typeof concludingMerge>, at: { readonly dir: string; readonly carry: string }) => {
      const [hook] = merge.options.hooks?.sandbox?.onSandboxReady ?? [];
      return spawnSync("sh", ["-c", hook!.command.split("/home/agent/.carry").join(at.carry)], {
        cwd: at.dir,
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT,
      });
    };

    it("puts the copy mid-merge as a squash: the same conflicts staged, the carried paths beside them, and no MERGE_HEAD", () => {
      const merge = concludingMerge(isolated(), repo, "update-branch-pr-1");
      const at = copy(BRANCH);
      expect(git(at.dir, "status", "--porcelain")).toBe("");
      expect(runHook(merge, at).status).toBe(0);
      expect(git(at.dir, "diff", "--name-only", "--diff-filter=U")).toBe("f");
      expect(git(at.dir, "diff", "--cached", "--name-only", "--diff-filter=A")).toBe("g");
      expect(fs.existsSync(path.join(at.dir, ".git", "MERGE_HEAD"))).toBe(false);
      expect(fs.existsSync(path.join(at.dir, "node_modules", "dep.js"))).toBe(true);
    });

    it("leaves a copy that is not at the head as it is: the extraction pass's, at the agent's commit", () => {
      const merge = concludingMerge(isolated(), repo, "update-branch-pr-1");
      const worktree = path.join(scratch, "agent");
      git(repo, "worktree", "add", "--quiet", worktree, BRANCH);
      fs.writeFileSync(path.join(worktree, "f"), "resolved\n");
      git(worktree, "commit", "--quiet", "-am", "resolved");
      git(repo, "worktree", "remove", worktree);
      const at = copy(BRANCH);
      expect(runHook(merge, at).status).toBe(0);
      expect(git(at.dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
    });
  });

  describe("concluding, once Sandcastle has left the agent's commits on its branch", () => {
    /** Sandcastle's copy-out: the agent's commit applied on its branch in a worktree it then removes. */
    const agentCommits = (resolved: string, message: readonly string[]): void => {
      const worktree = path.join(scratch, "agent");
      git(repo, "worktree", "add", "--quiet", worktree, BRANCH);
      fs.writeFileSync(path.join(worktree, "f"), resolved);
      fs.writeFileSync(path.join(worktree, "g"), "g\n");
      git(worktree, "add", "f", "g");
      git(worktree, "commit", "--quiet", ...message.flatMap((m) => ["-m", m]));
      git(repo, "worktree", "remove", worktree);
    };

    it("makes the merge in the checkout: the head and the base its parents, the agent's tree, git's subject and the agent's body", () => {
      const merge = concludingMerge(isolated(), repo, "update-branch-pr-1");
      agentCommits("resolved\n", ["Squashed commit of the following:", "Kept both: feat's wording, main's line."]);
      merge.conclude();
      expectMerged("resolved", "Kept both: feat's wording, main's line.");
    });

    it("refuses where the agent committed nothing, leaving the checkout mid-merge", () => {
      const merge = concludingMerge(isolated(), repo, "update-branch-pr-1");
      expect(() => merge.conclude()).toThrow("The agent finished without committing its resolution, so nothing was pushed.");
      expect(git(repo, "rev-parse", "HEAD")).toBe(head);
      expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
    });

    it("refuses where Sandcastle kept its worktree, a copy-out that did not finish", () => {
      const merge = concludingMerge(isolated(), repo, "update-branch-pr-1");
      const kept = path.join(scratch, "kept");
      git(repo, "worktree", "add", "--quiet", kept, BRANCH);
      fs.writeFileSync(path.join(kept, "f"), "half\n");
      git(kept, "commit", "--quiet", "-am", "half");
      expect(() => merge.conclude()).toThrow(
        `The agent's work didn't come out of its sandbox whole (its copy is kept at \`${kept}\`), so nothing was pushed.`,
      );
      expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    });
  });

  /** Whether bubblewrap runs here with a network of its own, as `tests/engine/bwrap.test.ts` asks. */
  const bwrapRuns = (): boolean =>
    spawnSync("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

  describe.skipIf(!bwrapRuns())("through Sandcastle and a real bwrap sandbox (skipped where bwrap cannot run)", () => {
    /** An agent that is a shell command, run where the agent would be. */
    const agent = (command: string): sandcastle.AgentProvider => ({
      name: "shell",
      env: {},
      captureSessions: false,
      buildPrintCommand: () => ({ command }),
      parseStreamLine: (line) => [{ type: "text", text: line }],
    });
    const pass = (options: ReturnType<typeof concludingMerge>["options"], command: string) =>
      sandcastle.run({
        ...options,
        agent: agent(command),
        cwd: repo,
        prompt: "Resolve the conflicts and commit the merge.",
        maxIterations: 1,
        name: "update-branch-pr-1",
        logging: { type: "file", path: path.join(scratch, "sandcastle.log") },
      });
    /** The agent: finds the conflict and the carried install, with no `MERGE_HEAD`, resolves it and commits. */
    const RESOLVE = [
      `test "$(git diff --name-only --diff-filter=U)" = f`,
      `test ! -e "$(git rev-parse --git-path MERGE_HEAD)"`,
      "test -e node_modules/dep.js",
      "printf 'resolved\\n' > f",
      "git add f",
      "git commit --quiet -m 'Merge it' -m 'Took both sides.'",
    ].join(" && ");

    it("used to stop where #463's run did: Sandcastle's merge back into the checkout, refused mid-merge", async () => {
      await expect(pass({ ...isolated() }, "printf 'resolved\\n' > f && git commit --quiet -am resolve")).rejects.toThrow(
        /^Merge of 'sandcastle\/update-branch-pr-1\/[^']+' onto 'feat' failed\./,
      );
    });

    it("hands the agent the conflicts and leaves the checkout on the merge, across both of a runner's passes", async () => {
      const merge = concludingMerge(isolated(), repo, "update-branch-pr-1");
      await pass(merge.options, RESOLVE);
      // The extraction pass: a copy at the agent's commit, with nothing to resolve.
      await pass(merge.options, `test -z "$(git status --porcelain --untracked-files=no)" && test "$(cat f)" = resolved`);
      merge.conclude();
      expectMerged("resolved", "Took both sides.");
    });
  });
});
