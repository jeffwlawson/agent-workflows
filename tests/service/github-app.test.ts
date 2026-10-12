import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveAppGitHub } from "../../service/github-app.js";

/**
 * The live GitHub's variable read, over a stand-in `fetch` answering in the
 * shapes GitHub's REST API documents. A variable resolves as `vars` resolves
 * it on Actions, and as `doctor`'s `gatherFacts` reads it: the repository's
 * own, else an organization variable shared with the repository.
 */

const REPO = "owner/repo";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface World {
  repository: Record<string, string>;
  /** The organization's variables shared with the repository, or `undefined` on a user-owned one. */
  organization: Record<string, string> | undefined;
  /** A path answered with this status instead, as an outage or a refusal is. */
  failing?: { path: RegExp; status: number };
}

let world: World;
const asked: string[] = [];

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

const answer = (url: string): Response => {
  const { pathname, searchParams } = new URL(url);
  asked.push(pathname);
  if (world.failing?.path.test(pathname)) return reply(world.failing.status, { message: "no" });
  if (pathname === `/repos/${REPO}/installation`) return reply(200, { id: 1, account: { login: "owner", type: "User" } });
  if (pathname === "/app") return reply(200, { id: 1, slug: "loop-app", owner: { login: "Owner", type: "User" } });
  if (pathname === "/app/installations/1/access_tokens") return reply(201, { token: "ghs_reader", expires_at: "2099-01-01T00:00:00Z" });
  if (pathname === `/repos/${REPO}`) return reply(200, { owner: { type: world.organization === undefined ? "User" : "Organization" } });
  const own = /^\/repos\/owner\/repo\/actions\/variables\/(.+)$/.exec(pathname);
  if (own !== null) {
    const value = world.repository[own[1] ?? ""];
    return value === undefined ? reply(404, { message: "Not Found" }) : reply(200, { name: own[1], value });
  }
  if (pathname === `/repos/${REPO}/actions/organization-variables`) {
    const all = Object.entries(world.organization ?? {}).map(([name, value]) => ({ name, value, visibility: "all" }));
    const size = Number(searchParams.get("per_page"));
    const page = Number(searchParams.get("page"));
    return reply(200, { total_count: all.length, variables: all.slice((page - 1) * size, page * size) });
  }
  return reply(404, { message: "Not Found" });
};

beforeEach(() => {
  world = { repository: {}, organization: {} };
  asked.length = 0;
  vi.stubGlobal("fetch", async (url: string) => answer(url));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("liveAppGitHub: a variable, as `vars` resolves it", () => {
  const read = (name: string) => liveAppGitHub("1", KEY).variable(REPO, name);

  it("reads the repository's own, over an organization one of the same name", async () => {
    world.repository = { AGENT_ORCHESTRATOR: "service" };
    world.organization = { AGENT_ORCHESTRATOR: "other" };

    expect(await read("AGENT_ORCHESTRATOR")).toBe("service");
    expect(asked).not.toContain(`/repos/${REPO}/actions/organization-variables`);
  });

  it.each(["AGENT_ORCHESTRATOR", "AGENT_MODEL", "AGENT_MODEL_REVIEW", "AGENT_REVIEW_TIMEOUT_MINUTES", "AGENT_MAX_FIX_ROUNDS"])(
    "falls back to an organization variable shared with the repository: %s",
    async (name) => {
      world.organization = { [name]: "from-the-organization" };

      expect(await read(name)).toBe("from-the-organization");
    },
  );

  it("finds an organization variable past the first page", async () => {
    world.organization = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`OTHER_${i}`, "x"]));
    world.organization["AGENT_ORCHESTRATOR"] = "service";

    expect(await read("AGENT_ORCHESTRATOR")).toBe("service");
  });

  it("is unset where neither has it", async () => {
    world.organization = { OTHER: "x" };

    expect(await read("AGENT_ORCHESTRATOR")).toBeUndefined();
  });

  it("is unset on a repository no organization owns, without asking for organization variables", async () => {
    world.organization = undefined;

    expect(await read("AGENT_ORCHESTRATOR")).toBeUndefined();
    expect(asked).not.toContain(`/repos/${REPO}/actions/organization-variables`);
  });

  it.each([
    ["the repository's variable", /\/actions\/variables\//, 403],
    ["the repository's owner", /^\/repos\/owner\/repo$/, 502],
    ["the organization's variables", /organization-variables/, 403],
  ])("throws, rather than reading unset, where %s could not be read", async (_, path, status) => {
    world.failing = { path, status };

    await expect(read("AGENT_ORCHESTRATOR")).rejects.toThrow(new RegExp(`answered ${status}`));
  });
});

describe("liveAppGitHub: the App and its installation, as GitHub records them", () => {
  it("reads the App's slug and its owner's login off the App's own record", async () => {
    expect(await liveAppGitHub("1", KEY).app()).toEqual({ slug: "loop-app", owner: "Owner" });
  });

  it("reads the account the App's installation on a repository is on", async () => {
    expect(await liveAppGitHub("1", KEY).installation(REPO)).toBe("owner");
  });

  it("is no installation where the App is not installed", async () => {
    world.failing = { path: /\/installation$/, status: 404 };

    expect(await liveAppGitHub("1", KEY).installation(REPO)).toBeUndefined();
  });

  it("throws where the App's own record could not be read", async () => {
    world.failing = { path: /^\/app$/, status: 401 };

    await expect(liveAppGitHub("1", KEY).app()).rejects.toThrow(/answered 401/);
  });
});
