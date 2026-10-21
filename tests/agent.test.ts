import { describe, expect, it } from "vitest";
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
    const selected = agentSandbox({ ...unset, AGENT_SANDBOX: "bwrap" });
    expect(selected.sandbox.name).toBe("bwrap");
    expect(selected).toHaveProperty("hooks", CARRY_HOOKS);
  });
});
