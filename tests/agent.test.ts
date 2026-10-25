import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { CARRY_HOOKS } from "../engine/bwrap.js";
import { agentSandbox, type SandboxInputs } from "../shared/agent.js";
import { SANDBOX } from "../shared/contract.js";

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
