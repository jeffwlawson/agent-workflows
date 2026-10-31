import { HttpsProxyRefused, proxyTarget } from "../engine/proxy-relay.js";

/**
 * `proxy` as a message may show it: with any user-info, the user name and the
 * password, left out, so a refusal quoted in a pull request's comment never
 * holds a credential. Read off the text rather than parsed, since a value
 * that is refused may not be a URL at all, and erring wide: everything after
 * any scheme up to the last `@`, wherever it is.
 */
const shown = (proxy: string): string => proxy.replace(/^([a-z][a-z\d+.-]*:\/\/)?.*@/is, "$1");

/**
 * Why the sandbox inputs cannot start an agent, or `undefined` where they can
 * (#461): `bwrap` gives the agent a network of its own whose only way out is
 * `AGENT_SANDBOX_PROXY`, so `bwrap` with no proxy, or one that is not a URL
 * the relay can reach, would start an agent that reaches nothing, and die
 * later on a connection error that names nothing. Today's shared network in
 * its place would fail open. An `https:` proxy is refused with a reason of its
 * own (#535): the sandbox names the proxy by a loopback address, so TLS to it
 * fails every request. `none` needs no proxy.
 *
 * One rule, read twice: by a runner before the agent starts (`agentSandbox`
 * in `shared/agent.ts`), and by the service's worker at start, where
 * `AGENT_SANDBOX` is `bwrap` unless it says otherwise. The repository's
 * setup on the service asks it a third time, of a proxy set under `none`,
 * since its sandbox has the relay wherever there is a proxy (#537). Here, apart from the
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
  } catch (error) {
    if (error instanceof HttpsProxyRefused) {
      return (
        `\`AGENT_SANDBOX_PROXY\` is \`${shown(proxy)}\`, an \`https:\` URL, which \`bwrap\` refuses: the sandbox reaches the proxy ` +
        "by a loopback address, which the proxy's TLS certificate does not name, so every request would fail. " +
        "Set `AGENT_SANDBOX_PROXY` to the proxy's `http:` URL."
      );
    }
    return `\`AGENT_SANDBOX_PROXY\` is \`${shown(proxy)}\`, which is not an \`http:\` URL with a host.`;
  }
};
