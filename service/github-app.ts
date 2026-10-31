import { createSign } from "node:crypto";
import { READER_PERMISSIONS, type AppGitHub, type AppRecord } from "./dispatcher.js";
import type { TokenGrant } from "./job.js";

/**
 * The dispatcher's GitHub, live: GitHub's REST API, authenticated as the App
 * with a JWT signed by its key, and as one installation with a token minted
 * from it. Its own reads, a repository's variables and a sender's permission,
 * go through a token that can read metadata and variables and nothing else,
 * minted per repository and reused while it has a while to run.
 */

const API = "https://api.github.com";

/** How long before a reader token's expiry it is minted again. */
const REUSE_MARGIN_MS = 5 * 60_000;

/** The most variables GitHub lists on one page. */
const VARIABLES_PAGE = 30;

interface Reply {
  readonly status: number;
  readonly json: unknown;
}

const b64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

export const liveAppGitHub = (appId: string, privateKey: string): AppGitHub => {
  /** A JWT for the App, nine minutes long and backdated one for clock drift: GitHub's limit is ten. */
  const jwt = (): string => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
    const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
    return `${head}.${body}.${b64url(signature)}`;
  };

  const api = async (path: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<Reply> => {
    const response = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${auth}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agent-workflows-dispatcher",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  const field = (reply: Reply, name: string): unknown =>
    typeof reply.json === "object" && reply.json !== null ? (reply.json as Record<string, unknown>)[name] : undefined;

  /**
   * The installation on `repo`, its id and the login of the account it is on,
   * or `undefined` where the App is not installed there.
   */
  const installation = async (repo: string): Promise<{ readonly id: number; readonly account: string } | undefined> => {
    const reply = await api(`/repos/${repo}/installation`, jwt());
    if (reply.status === 404) return undefined;
    const id = field(reply, "id");
    const account = field(reply, "account");
    const login = typeof account === "object" && account !== null ? (account as Record<string, unknown>)["login"] : undefined;
    if (reply.status !== 200 || typeof id !== "number" || typeof login !== "string") {
      throw new Error(`reading the App's installation on ${repo} answered ${reply.status}`);
    }
    return { id, account: login };
  };

  const mint = async (repo: string, permissions: Readonly<Record<string, string>>): Promise<TokenGrant> => {
    const id = (await installation(repo))?.id;
    if (id === undefined) throw new Error(`the App is not installed on ${repo}`);
    const name = repo.slice(repo.indexOf("/") + 1);
    const reply = await api(`/app/installations/${id}/access_tokens`, jwt(), {
      method: "POST",
      body: { repositories: [name], permissions },
    });
    const token = field(reply, "token");
    const expiresAt = field(reply, "expires_at");
    if (reply.status !== 201 || typeof token !== "string" || typeof expiresAt !== "string") {
      // 422 is GitHub refusing a permission the App was not granted.
      throw new Error(`minting a token for ${repo} answered ${reply.status}${reply.status === 422 ? ": the App lacks a permission it asks for" : ""}`);
    }
    return { token, expiresAt };
  };

  const readers = new Map<string, TokenGrant>();
  const reader = async (repo: string): Promise<string> => {
    const held = readers.get(repo);
    if (held !== undefined && Date.parse(held.expiresAt) - Date.now() > REUSE_MARGIN_MS) return held.token;
    const grant = await mint(repo, READER_PERMISSIONS);
    readers.set(repo, grant);
    return grant.token;
  };

  /**
   * An organization variable shared with `repo`, or `undefined` where there is
   * none of that name, or no organization: what `vars` falls back to where the
   * repository has no variable of its own, and what `doctor`'s `gatherFacts`
   * reads too, so the three agree on what a repository asks for. GitHub has no
   * endpoint for one by name here, so the list is read a page at a time.
   */
  const organizationVariable = async (repo: string, name: string, token: string): Promise<string | undefined> => {
    const owner = await api(`/repos/${repo}`, token);
    const type = field(owner, "owner");
    const ownerType = typeof type === "object" && type !== null ? (type as Record<string, unknown>)["type"] : undefined;
    if (owner.status !== 200 || typeof ownerType !== "string") throw new Error(`reading ${repo}'s owner answered ${owner.status}`);
    if (ownerType !== "Organization") return undefined;
    for (let page = 1, seen = 0; ; page += 1) {
      const reply = await api(`/repos/${repo}/actions/organization-variables?per_page=${VARIABLES_PAGE}&page=${page}`, token);
      const total = field(reply, "total_count");
      const listed = field(reply, "variables");
      if (reply.status !== 200 || typeof total !== "number" || !Array.isArray(listed)) {
        throw new Error(`reading ${repo}'s organization variables answered ${reply.status}`);
      }
      for (const entry of listed as unknown[]) {
        if (typeof entry !== "object" || entry === null) continue;
        const { name: listedName, value } = entry as Record<string, unknown>;
        if (listedName === name && typeof value === "string") return value;
      }
      seen += listed.length;
      if (listed.length === 0 || seen >= total) return undefined;
    }
  };

  let app: AppRecord | undefined;

  return {
    app: async () => {
      if (app !== undefined) return app;
      const reply = await api("/app", jwt());
      const slug = field(reply, "slug");
      const owner = field(reply, "owner");
      const login = typeof owner === "object" && owner !== null ? (owner as Record<string, unknown>)["login"] : undefined;
      if (reply.status !== 200 || typeof slug !== "string" || typeof login !== "string") {
        throw new Error(`reading the App's own record answered ${reply.status}`);
      }
      // A record without either field grants nothing, so every need reads as a gap.
      const permissions = field(reply, "permissions");
      const events = field(reply, "events");
      app = {
        slug,
        owner: login,
        permissions:
          typeof permissions === "object" && permissions !== null
            ? Object.fromEntries(Object.entries(permissions).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
            : {},
        events: Array.isArray(events) ? events.filter((event): event is string => typeof event === "string") : [],
      };
      return app;
    },
    installation: async (repo) => (await installation(repo))?.account,
    variable: async (repo, name) => {
      const token = await reader(repo);
      const reply = await api(`/repos/${repo}/actions/variables/${name}`, token);
      if (reply.status !== 404) {
        const value = field(reply, "value");
        if (reply.status !== 200 || typeof value !== "string") throw new Error(`reading ${name} on ${repo} answered ${reply.status}`);
        return value;
      }
      return organizationVariable(repo, name, token);
    },
    permission: async (repo, login) => {
      const reply = await api(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, await reader(repo));
      if (reply.status === 404) return undefined;
      const permission = field(reply, "permission");
      if (reply.status !== 200 || typeof permission !== "string") throw new Error(`reading ${login}'s permission on ${repo} answered ${reply.status}`);
      return permission;
    },
    mint,
  };
};
