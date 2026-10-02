import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { safeGh, type GhOptions } from "../shared/common.js";
import { availableSecrets, parseList } from "./doctor.js";

/**
 * The loop's GitHub App (PRD #314), as `init` creates it: the third surface
 * beside `policies.ts`'s and `labels.ts`'s, and supplied by the tests the same
 * way.
 *
 * GitHub's App **manifest flow** does the registration. `init` serves a page on
 * the loopback interface that posts a manifest to GitHub's create-App page, so
 * the person sees that page already filled in and clicks Create. GitHub sends
 * the browser back to the same local server with a one-time code, and the code
 * is exchanged for the App's ID, private key and slug. The person never fills
 * in a form and never handles a key file: the key is held here, in memory,
 * until it is stored as a secret.
 *
 * The exchange is an **unauthenticated** `POST`, and never goes through `gh`:
 * the conversion endpoint refuses fine-grained PATs and App tokens, which are
 * exactly what a `gh` may be logged in with. The code itself is the credential.
 * The handoff, a localhost `redirect_url` and the unauthenticated exchange were
 * confirmed live on 2026-10-02 (#226).
 */

/**
 * The App's permissions: the writes `AGENT_PAT` makes today and nothing more.
 * Workflows: write because a branch touching `.github/workflows/` is otherwise
 * rejected at the push, after the agent's work is done; acceptable because
 * neither the key nor a token minted from it is ever on the agent's runner.
 */
export const APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  workflows: "write",
  metadata: "read",
} as const;

/**
 * What `init` asks GitHub to register. No `hook_attributes`: the App has no
 * webhook, since nothing listens for one. `redirect_url` is the flow's to add,
 * since only the flow knows where it is listening.
 */
export interface AppManifest {
  readonly name: string;
  readonly url: string;
  readonly public: false;
  readonly default_permissions: typeof APP_PERMISSIONS;
  readonly default_events: readonly string[];
}

/** GitHub's limit on an App's name. */
const NAME_LIMIT = 34;
const NAME_SUFFIX = "-agent-loop";

/**
 * A name derived from the owner, since GitHub requires one that is unique
 * across all of it. A **suggestion**: the person may change it on GitHub's
 * page, so nothing downstream reads it; the registered name is the one the
 * conversion answers with.
 */
export const suggestedAppName = (owner: string): string =>
  `${owner.slice(0, NAME_LIMIT - NAME_SUFFIX.length).replace(/-+$/, "")}${NAME_SUFFIX}`;

export const appManifest = (owner: string, homepage: string): AppManifest => ({
  name: suggestedAppName(owner),
  url: homepage,
  public: false,
  default_permissions: APP_PERMISSIONS,
  default_events: [],
});

/** Who owns the repository, which decides where the App is created and where its secrets can go. */
export interface RepoOwner {
  readonly login: string;
  readonly organization: boolean;
}

/** What the conversion answers with, as far as anything here reads it. */
export interface RegisteredApp {
  readonly id: number;
  readonly slug: string;
  /** As registered, which is not necessarily as suggested. */
  readonly name: string;
  /** The private key. Held in memory until it is stored, and never printed. */
  readonly pem: string;
}

/**
 * Where a secret goes: on the organization, for every repository in it, or on
 * this repository alone.
 */
export type SecretPlacement = { readonly level: "organization"; readonly org: string } | { readonly level: "repository" };

/** What `init` asks GitHub about the App and the writes it may make. The tests supply their own. */
export interface AppSurface {
  /**
   * Every Actions secret a workflow here can read, this repository's own and
   * its organization's shared with it, as `doctor` reads them; `undefined`
   * where they could not be listed, which is never "none".
   */
  readonly secrets: () => readonly string[] | undefined;
  /** The repository's owner, or `undefined` where it could not be read. */
  readonly owner: () => RepoOwner | undefined;
  /**
   * Whether the person running this is an admin of the organization `org`, or
   * `undefined` where that could not be read, which is never a yes.
   */
  readonly orgAdmin: (org: string) => boolean | undefined;
  /** Run the manifest flow: the App, or words saying why there is none. */
  readonly register: (owner: RepoOwner, manifest: AppManifest) => Promise<RegisteredApp | string>;
  /** `undefined` on success, and GitHub's words for the refusal otherwise. There is no delete. */
  readonly setSecret: (name: string, value: string, placement: SecretPlacement) => string | undefined;
  /** Send the person to the App's install page, to pick its repositories. */
  readonly openInstall: (url: string) => void;
}

export const GITHUB_WEB = "https://github.com";
const GITHUB_API = "https://api.github.com";

/** Where the person picks the repositories the App may act on. */
export const installUrl = (slug: string, web: string = GITHUB_WEB): string =>
  `${web}/apps/${encodeURIComponent(slug)}/installations/new`;

/** The App's settings page, where a new private key can be generated. */
export const appSettingsUrl = (owner: RepoOwner, slug: string, web: string = GITHUB_WEB): string =>
  owner.organization
    ? `${web}/organizations/${encodeURIComponent(owner.login)}/settings/apps/${encodeURIComponent(slug)}`
    : `${web}/settings/apps/${encodeURIComponent(slug)}`;

/** GitHub's create-App page for the owner, which the form posts the manifest to. */
const createAppUrl = (owner: RepoOwner, web: string, state: string): string =>
  owner.organization
    ? `${web}/organizations/${encodeURIComponent(owner.login)}/settings/apps/new?state=${state}`
    : `${web}/settings/apps/new?state=${state}`;

/**
 * How long the local server waits for GitHub to send the browser back. GitHub
 * gives a manifest code an hour; the exchange happens the moment the callback
 * arrives, so a wait no longer than that keeps the whole flow inside it.
 */
export const FLOW_LIMIT_MS = 60 * 60 * 1000;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** The one page: a form posting the manifest to GitHub, submitted as soon as it loads. */
const formPage = (action: string, manifest: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create the loop's GitHub App</title></head>
<body>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<p>Sending you to GitHub to create the loop's App.</p>
<button type="submit">Continue to GitHub</button>
</form>
<script>document.forms[0].submit();</script>
</body>
</html>
`;

const donePage = (message: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>The loop's GitHub App</title></head>
<body><p>${escapeHtml(message)}</p></body>
</html>
`;

export interface ManifestFlowOptions {
  readonly owner: RepoOwner;
  readonly manifest: AppManifest;
  /** Send the person's browser to the local form page. */
  readonly open: (url: string) => void;
  /** GitHub's web root, where the create-App page is. */
  readonly web: string;
  /** GitHub's REST root, where the code is exchanged. */
  readonly api: string;
  readonly timeoutMs: number;
}

/** The conversion's answer, read, or `undefined` where it lacks what the loop needs. */
const asRegistered = (body: unknown): RegisteredApp | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const { id, slug, name, pem } = body as Record<string, unknown>;
  if (typeof id !== "number" || typeof slug !== "string" || typeof name !== "string" || typeof pem !== "string") {
    return undefined;
  }
  return { id, slug, name, pem };
};

/**
 * Exchange the code for the App. No `Authorization` header, on purpose: see
 * the header.
 */
const exchange = async (api: string, code: string): Promise<RegisteredApp | string> => {
  try {
    const response = await fetch(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    const text = await response.text();
    if (!response.ok) {
      return `GitHub refused the code exchange (HTTP ${response.status}: ${text.split("\n")[0] ?? ""})`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
    return asRegistered(parsed) ?? "GitHub's answer to the code exchange carried no App ID, slug, name and key";
  } catch (error) {
    return `the code exchange did not reach GitHub (${error instanceof Error ? error.message : String(error)})`;
  }
};

/**
 * The live manifest flow. Serves the form on `127.0.0.1` and waits for the one
 * callback whose `state` is the one the form carried: any other is refused
 * and the wait goes on, so a stray or forged request can neither complete the
 * flow nor end it. Resolves with the App, or with words saying why there is
 * none, and closes the server either way.
 */
export const manifestFlow = (options: ManifestFlowOptions): Promise<RegisteredApp | string> =>
  new Promise((resolve) => {
    const state = randomBytes(32).toString("hex");
    let settled = false;
    let base = "";

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const reply = (status: number, body: string, after?: () => void): void => {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(body, after);
      };

      // Every request names the address the server listens on, or is refused
      // before anything is read or served. A page that rebinds its own
      // hostname to this port reaches the server with its own name in `Host`,
      // and could otherwise read the form, `state` and all, and answer the
      // callback with a code for an App of its choosing (#330 review). The
      // browser this sent here, and GitHub's redirect back, both name
      // `127.0.0.1:<port>`.
      if (base === "" || request.headers.host !== base.replace(/^http:\/\//, "")) {
        reply(421, donePage("This request was not addressed to the setup that is waiting, so it was ignored."));
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const manifest = JSON.stringify({ ...options.manifest, redirect_url: `${base}/callback` });
        reply(200, formPage(createAppUrl(options.owner, options.web, state), manifest));
        return;
      }
      if (request.method !== "GET" || url.pathname !== "/callback") {
        reply(404, donePage("Nothing here."));
        return;
      }
      if (settled) {
        reply(410, donePage("This setup has already finished. Return to your terminal."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        reply(400, donePage("This request did not come from the setup that is waiting, so it was ignored."));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        reply(400, donePage("GitHub sent no code back, so no App was received."));
        return;
      }

      settled = true;
      void exchange(options.api, code).then((outcome) => {
        const message =
          typeof outcome === "string"
            ? `The App could not be received: ${outcome}. Return to your terminal.`
            : `Created the GitHub App "${outcome.name}". Return to your terminal to finish.`;
        reply(typeof outcome === "string" ? 502 : 200, donePage(message), () => finish(outcome));
      });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      finish(`GitHub did not send the browser back within ${Math.round(options.timeoutMs / 60000)} minutes`);
    }, options.timeoutMs);

    const finish = (outcome: RegisteredApp | string): void => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      resolve(outcome);
    };

    server.on("error", (error) => {
      if (settled) return;
      settled = true;
      finish(`the local server could not start (${error.message})`);
    });
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      options.open(`${base}/`);
    });
  });

/** Open a URL in the person's browser, best effort: the URL is printed beside it either way. */
const openBrowser = (url: string): void => {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Printed beside it; a person can open it by hand.
  }
};

/**
 * `gh` against the repository `dir` is a checkout of, and no other, for
 * `livePolicySurface`'s reason: `GH_REPO` is set in every agent job this
 * repository runs. `say` is where the flow tells the person what to do in
 * their browser.
 */
export const liveAppSurface = (dir: string, say: (text: string) => void): AppSurface => {
  const { GH_REPO: _ignored, ...env } = process.env;
  const options: GhOptions = { cwd: dir, env };
  const list = (args: readonly string[], jq: string): readonly string[] | undefined =>
    parseList(safeGh([...args, "--jq", `[${jq}] | @json`], options));

  const owner = (): RepoOwner | undefined => {
    const [login, inOrganization] =
      list(["repo", "view", "--json", "owner,isInOrganization"], ".owner.login, .isInOrganization") ?? [];
    if (login === undefined || login === "") return undefined;
    if (inOrganization === "true") return { login, organization: true };
    if (inOrganization === "false") return { login, organization: false };
    return undefined;
  };

  return {
    owner,
    // The two lists `doctor` reads, judged the same way: see `availableSecrets`.
    secrets: () => {
      const organization = owner()?.organization;
      const repository = list(["api", "repos/{owner}/{repo}/actions/secrets?per_page=100"], ".secrets[].name");
      const shared =
        repository === undefined || organization !== true
          ? undefined
          : list(["api", "repos/{owner}/{repo}/actions/organization-secrets?per_page=100"], ".secrets[].name");
      return availableSecrets(repository, shared, organization);
    },
    orgAdmin: (org) => {
      const [state, role] = list(["api", `user/memberships/orgs/${encodeURIComponent(org)}`], ".state, .role") ?? [];
      if (state === undefined) return undefined;
      return state === "active" && role === "admin";
    },
    register: (who, manifest) =>
      manifestFlow({
        owner: who,
        manifest,
        open: (url) => {
          say(
            `  Opening ${url} in your browser, which takes you to GitHub's create-App page, filled in.\n` +
              `  Click Create there. If no browser opens, visit that address yourself.\n`,
          );
          openBrowser(url);
        },
        web: GITHUB_WEB,
        api: GITHUB_API,
        timeoutMs: FLOW_LIMIT_MS,
      }),
    // The value goes in on stdin, never on the command line, where any process
    // on the machine could read the key.
    setSecret: (name, value, placement) => {
      const result = spawnSync(
        "gh",
        [
          "secret",
          "set",
          name,
          ...(placement.level === "organization" ? ["--org", placement.org, "--visibility", "all"] : []),
        ],
        { cwd: dir, env, input: value, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      if (result.error === undefined && result.status === 0) return undefined;
      return (
        (result.stderr ?? "").trim() ||
        result.error?.message ||
        (result.stdout ?? "").trim() ||
        "gh exited non-zero"
      ).split("\n")[0];
    },
    openInstall: (url) => {
      say(`  Opening ${url}: install the App there, on the repositories it may act on.\n`);
      openBrowser(url);
    },
  };
};
