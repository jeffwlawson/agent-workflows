import { createSign } from "node:crypto";
import { READER_PERMISSIONS, SCAN_PERMISSIONS, type AppGitHub, type AppRecord, type HeadPull, type Labelled } from "./dispatcher.js";
import type { TokenGrant } from "./job.js";

/**
 * The dispatcher's GitHub, live: GitHub's REST API, authenticated as the App
 * with a JWT signed by its key, and as one installation with a token minted
 * from it. Its own reads, a repository's variables, a sender's permission
 * and the pull requests a commit is the head of (#591), go through a token
 * that can read metadata, variables and pull requests and nothing else,
 * minted per repository and reused while it has a while to run. The scan's
 * reads (#581) go through one that can read issues and pull requests besides,
 * minted and reused the same way, but for listing an installation's
 * repositories, which needs a token for the whole installation that reads
 * metadata alone. The one comment it writes, where a scan stops dispatching
 * an item (#596), goes through a token minted for it alone.
 */

const API = "https://api.github.com";

/** How long before a reader token's expiry it is minted again. */
const REUSE_MARGIN_MS = 5 * 60_000;

/** The most variables GitHub lists on one page. */
const VARIABLES_PAGE = 30;

/** The most of anything else the scan lists on one page: GitHub's own limit. */
const PAGE = 100;

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

  /** A token from installation `id`, with `permissions`, for `repositories` where given, else the whole installation; `what` names it in a throw. */
  const installationToken = async (
    id: number,
    permissions: Readonly<Record<string, string>>,
    what: string,
    repositories?: readonly string[],
  ): Promise<TokenGrant> => {
    const reply = await api(`/app/installations/${id}/access_tokens`, jwt(), {
      method: "POST",
      body: { ...(repositories === undefined ? {} : { repositories }), permissions },
    });
    const token = field(reply, "token");
    const expiresAt = field(reply, "expires_at");
    if (reply.status !== 201 || typeof token !== "string" || typeof expiresAt !== "string") {
      // 422 is GitHub refusing a permission the App was not granted.
      throw new Error(`minting a token for ${what} answered ${reply.status}${reply.status === 422 ? ": the App lacks a permission it asks for" : ""}`);
    }
    return { token, expiresAt };
  };

  const mint = async (repo: string, permissions: Readonly<Record<string, string>>): Promise<TokenGrant> => {
    const id = (await installation(repo))?.id;
    if (id === undefined) throw new Error(`the App is not installed on ${repo}`);
    return installationToken(id, permissions, repo, [repo.slice(repo.indexOf("/") + 1)]);
  };

  /** A token reading `repo` with `permissions`, reused while it has a while to run. */
  const readers = new Map<string, TokenGrant>();
  const readerOf = async (repo: string, permissions: Readonly<Record<string, string>>): Promise<string> => {
    const key = `${repo} ${JSON.stringify(permissions)}`;
    const held = readers.get(key);
    if (held !== undefined && Date.parse(held.expiresAt) - Date.now() > REUSE_MARGIN_MS) return held.token;
    const grant = await mint(repo, permissions);
    readers.set(key, grant);
    return grant.token;
  };
  const reader = (repo: string): Promise<string> => readerOf(repo, READER_PERMISSIONS);
  const scanner = (repo: string): Promise<string> => readerOf(repo, SCAN_PERMISSIONS);

  /** Every page of a list at `path` (which carries no query of its own), each page's entries read off by `entries`. */
  const pages = async (path: string, auth: () => Promise<string> | string, entries: (reply: Reply) => unknown, what: string): Promise<unknown[]> => {
    const all: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const reply = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`, await auth());
      const listed = entries(reply);
      if (reply.status !== 200 || !Array.isArray(listed)) throw new Error(`reading ${what} answered ${reply.status}`);
      all.push(...(listed as unknown[]));
      if (listed.length < PAGE) return all;
    }
  };

  const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

  /** A pull request's record as GitHub gives it, read into what the dispatcher compares, or `undefined` where a field is missing. */
  const pullOf = (value: unknown): HeadPull | undefined => {
    const { number, state, merged, merged_at: mergedAt, draft, head, base, labels } = record(value);
    const { ref: branch, sha: headSha, repo: headRepo } = record(head);
    const baseRef = record(base)["ref"];
    if (typeof number !== "number" || typeof state !== "string" || typeof branch !== "string" || typeof headSha !== "string" || typeof baseRef !== "string") {
      return undefined;
    }
    const headName = record(headRepo)["full_name"];
    return {
      number,
      state,
      // A pull request's own record says `merged`; a list's carries `merged_at` alone.
      merged: merged === true || (typeof mergedAt === "string" && mergedAt !== ""),
      draft: draft === true,
      branch,
      headSha,
      headRepo: typeof headName === "string" ? headName : undefined,
      baseRef,
      labels: Array.isArray(labels) ? labels.map((label) => record(label)["name"]).filter((name): name is string => typeof name === "string") : [],
    };
  };

  /** Each installation's id, by its account's login lower-cased, as the last listing read it. */
  const installationIds = new Map<string, number>();

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
    installations: async () => {
      const listed = await pages("/app/installations", jwt, (reply) => reply.json, "the App's installations");
      const accounts: string[] = [];
      for (const entry of listed) {
        const { id, account } = record(entry);
        const login = record(account)["login"];
        if (typeof id !== "number" || typeof login !== "string") continue;
        installationIds.set(login.toLowerCase(), id);
        accounts.push(login);
      }
      return accounts;
    },
    repositories: async (account) => {
      const id = installationIds.get(account.toLowerCase());
      if (id === undefined) throw new Error(`no installation on ${account} was listed`);
      const token = (await installationToken(id, { metadata: "read" }, `the installation on ${account}`)).token;
      const listed = await pages("/installation/repositories", () => token, (reply) => field(reply, "repositories"), `the repositories of the installation on ${account}`);
      return listed.map((entry) => record(entry)["full_name"]).filter((name): name is string => typeof name === "string");
    },
    labelled: async (repo, label) => {
      const query = new URLSearchParams({ state: "open", labels: label });
      const listed = await pages(`/repos/${repo}/issues?${query.toString()}`, () => scanner(repo), (reply) => reply.json, `${repo}'s items labelled \`${label}\``);
      const items: Labelled[] = [];
      for (const entry of listed) {
        const { number, title, state, pull_request: pull } = record(entry);
        if (typeof number !== "number" || typeof state !== "string") continue;
        if (pull === undefined || pull === null) {
          if (typeof title === "string") items.push({ type: "issues", number, title, state });
          continue;
        }
        // The issues list carries no head or base: the pull request's own record does, read now.
        const reply = await api(`/repos/${repo}/pulls/${number}`, await scanner(repo));
        const read = reply.status === 200 ? pullOf(reply.json) : undefined;
        if (read === undefined) throw new Error(`reading ${repo}#${number} answered ${reply.status}`);
        const { labels: _, ...fields } = read;
        items.push({ type: "pull_request", ...fields, number });
      }
      return items;
    },
    labeller: async (repo, number, label) => {
      const listed = await pages(`/repos/${repo}/issues/${number}/events`, () => scanner(repo), (reply) => reply.json, `${repo}#${number}'s events`);
      let actor: string | undefined;
      // Oldest first, so the last one found is the latest.
      for (const entry of listed) {
        const event = record(entry);
        if (event["event"] !== "labeled" || record(event["label"])["name"] !== label) continue;
        const login = record(event["actor"])["login"];
        actor = typeof login === "string" ? login : undefined;
      }
      return actor;
    },
    comments: async (repo, number) => {
      const listed = await pages(`/repos/${repo}/issues/${number}/comments`, () => scanner(repo), (reply) => reply.json, `${repo}#${number}'s comments`);
      return listed.flatMap((entry) => {
        const { body, user } = record(entry);
        const login = record(user)["login"];
        return typeof body === "string" ? [{ body, author: typeof login === "string" ? login : "" }] : [];
      });
    },
    defaultBranch: async (repo) => {
      const reply = await api(`/repos/${repo}`, await scanner(repo));
      const branch = field(reply, "default_branch");
      if (reply.status !== 200 || typeof branch !== "string") throw new Error(`reading ${repo}'s default branch answered ${reply.status}`);
      return branch;
    },
    pullsAt: async (repo, sha) => {
      const listed = await pages(`/repos/${repo}/commits/${sha}/pulls`, () => reader(repo), (reply) => reply.json, `the pull requests of ${repo}'s commit ${sha}`);
      return listed.map(pullOf).filter((pull): pull is HeadPull => pull !== undefined);
    },
    comment: async (repo, number, body, token) => {
      const reply = await api(`/repos/${repo}/issues/${number}/comments`, token, { method: "POST", body: { body } });
      if (reply.status !== 201) throw new Error(`commenting on ${repo}#${number} answered ${reply.status}`);
    },
  };
};
