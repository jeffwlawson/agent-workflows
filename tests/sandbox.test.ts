import { describe, expect, it } from "vitest";
import { sandboxRefusal } from "../shared/sandbox.js";

describe("a refusal of the sandbox's proxy", () => {
  /** A refused proxy with user-info, in every shape a refusal names it. */
  const refused = [
    "https://someone:hunter2@proxy.example:3128",
    "https://someone@proxy.example:3128",
    "someone:hunter2@proxy.example:3128",
    "http://someone:hun@ter2@:3128",
    "socks5://someone:hunter2@proxy.example:1080",
  ];

  it.each(refused)("names the proxy with its user name and password left out (%s)", (proxy) => {
    const reason = sandboxRefusal("bwrap", proxy);

    expect(reason).toMatch(/^`AGENT_SANDBOX_PROXY` is `/);
    expect(reason).not.toMatch(/someone|hunter2|hun|ter2/);
  });

  it("still names a proxy with no user-info as it was given", () => {
    expect(sandboxRefusal("bwrap", "https://proxy.example:3128")).toContain("`https://proxy.example:3128`");
    expect(sandboxRefusal("bwrap", "proxy.example:3128")).toContain("`proxy.example:3128`");
  });

  it("refuses nothing under none, and an http: proxy with user-info under bwrap", () => {
    expect(sandboxRefusal("none", "")).toBeUndefined();
    expect(sandboxRefusal("bwrap", "http://someone:hunter2@proxy.example:3128")).toBeUndefined();
  });
});
