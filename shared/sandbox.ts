import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

/**
 * PROTOTYPE (#364): which Sandcastle provider the agent runs in, chosen by the
 * orchestrator through `AGENT_SANDBOX` rather than hard-coded per runner.
 * Unset is `none`, today's behaviour, so the Actions path is unchanged.
 */
export const sandboxFromEnv = () => {
  const choice = process.env["AGENT_SANDBOX"] ?? "none";
  switch (choice) {
    case "none":
      return noSandbox();
    case "docker":
      return docker();
    case "podman":
      return podman();
    default:
      throw new Error(`AGENT_SANDBOX=${choice}: expected none, docker or podman`);
  }
};
