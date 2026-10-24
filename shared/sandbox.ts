import { proxyTarget } from "../engine/proxy-relay.js";

/**
 * Why the sandbox inputs cannot start an agent, or `undefined` where they can
 * (#461): `bwrap` gives the agent a network of its own whose only way out is
 * `AGENT_SANDBOX_PROXY`, so `bwrap` with no proxy, or one that is not a URL
 * the relay can reach, would start an agent that reaches nothing, and die
 * later on a connection error that names nothing. Today's shared network in
 * its place would fail open. `none` needs no proxy.
 *
 * One rule, read twice: by a runner before the agent starts (`agentSandbox`
 * in `shared/agent.ts`), and by the service's worker at start, where
 * `AGENT_SANDBOX` is `bwrap` unless it says otherwise. Here, apart from the
 * agent driver, so the worker need not load the agent SDK to ask.
 */
export const sandboxRefusal = (sandbox: "none" | "bwrap", proxy: string): string | undefined => {
  if (sandbox === "none") return undefined;
  if (proxy === "") {
    return (
      "`AGENT_SANDBOX` is `bwrap`, which needs `AGENT_SANDBOX_PROXY`: the sandbox's network is its own, " +
      "and the proxy is its only way out. Set `AGENT_SANDBOX_PROXY` to the proxy's `http:` URL, or set `AGENT_SANDBOX` to `none`."
    );
  }
  try {
    proxyTarget(proxy);
    return undefined;
  } catch {
    return `\`AGENT_SANDBOX_PROXY\` is \`${proxy}\`, which is not an \`http:\` or \`https:\` URL with a host.`;
  }
};
