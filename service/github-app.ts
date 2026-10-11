import { createSign } from "node:crypto";
import type { AppGitHub } from "./dispatcher.js";
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

  /** The installation on `repo`, or `undefined` where the App is not installed there. */
  const installation = async (repo: string): Promise<number | undefined> => {
    const reply = await api(`/repos/${repo}/installation`, jwt());
    if (reply.status === 404) return undefined;
    const id = field(reply, "id");
    if (reply.status !== 200 || typeof id !== "number") throw new Error(`reading the App's installation on ${repo} answered ${reply.status}`);
    return id;
  };

  const mint = async (repo: string, permissions: Readonly<Record<string, string>>): Promise<TokenGrant> => {
    const id = await installation(repo);
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
    const grant = await mint(repo, { metadata: "read", variables: "read" });
    readers.set(repo, grant);
    return grant.token;
  };

  let slug: string | undefined;

  return {
    slug: async () => {
      if (slug !== undefined) return slug;
      const reply = await api("/app", jwt());
      const read = field(reply, "slug");
      if (reply.status !== 200 || typeof read !== "string") throw new Error(`reading the App's own record answered ${reply.status}`);
      slug = read;
      return slug;
    },
    installed: async (repo) => (await installation(repo)) !== undefined,
    variable: async (repo, name) => {
      const reply = await api(`/repos/${repo}/actions/variables/${name}`, await reader(repo));
      if (reply.status === 404) return undefined;
      const value = field(reply, "value");
      if (reply.status !== 200 || typeof value !== "string") throw new Error(`reading ${name} on ${repo} answered ${reply.status}`);
      return value;
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
