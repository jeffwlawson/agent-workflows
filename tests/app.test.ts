import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_PERMISSIONS,
  appManifest,
  manifestFlow,
  serviceAppManifest,
  suggestedAppName,
  type RegisteredApp,
  type RepoOwner,
} from "../setup/app.js";

/**
 * The live manifest flow (#322), against a stand-in GitHub: a local server
 * playing the conversion endpoint and recording every request it gets, and a
 * test playing the person's browser through the form and back.
 */

interface Recorded {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: http.IncomingHttpHeaders;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** GitHub's conversion endpoint, answering every exchange with `answer`. */
const fakeGitHub = async (answer: object): Promise<{ api: string; requests: Recorded[] }> => {
  const requests: Recorded[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify(answer));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
};

const unescape = (text: string): string =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** What the form page carries: where it posts, with which state, and the manifest. */
const readForm = async (url: string) => {
  const page = await (await fetch(url)).text();
  const action = unescape(/<form method="post" action="([^"]*)"/.exec(page)?.[1] ?? "");
  const manifest = JSON.parse(unescape(/name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? "{}")) as Record<
    string,
    unknown
  >;
  return { action, state: new URL(action).searchParams.get("state") ?? "", manifest };
};

const conversion = {
  id: 4242,
  slug: "acme-loop-bot",
  name: "Acme Loop Bot",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n",
  owner: { login: "acme" },
  html_url: "https://github.com/apps/acme-loop-bot",
};

/**
 * Run the flow, with `browse` as the person: handed the local page's URL, it
 * does whatever the test needs and returns what it saw.
 */
const flow = async <T>(
  owner: RepoOwner,
  api: string,
  browse: (url: string) => Promise<T>,
  manifest = appManifest(owner.login, "https://github.com/acme/agent-workflows"),
) => {
  let seen: Promise<T> | undefined;
  const outcome = await manifestFlow({
    owner,
    manifest,
    open: (url) => {
      seen = browse(url);
    },
    web: "https://github.example",
    api,
    timeoutMs: 10_000,
  });
  if (seen === undefined) throw new Error("the flow never sent the browser anywhere");
  return { outcome, seen: await seen };
};

describe("the manifest flow creates the loop's App", () => {
  it("posts the manifest to the owner's create-App page, and comes back to the local server", async () => {
    const { api } = await fakeGitHub(conversion);

    const { seen } = await flow({ login: "acme", organization: true }, api, async (url) => {
      const form = await readForm(url);
      const redirect = new URL(String(form.manifest["redirect_url"]));
      await fetch(`${redirect.href}?code=abc&state=${form.state}`);
      return { ...form, redirect };
    });

    expect(seen.action).toMatch(/^https:\/\/github\.example\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{64}$/);
    expect(seen.redirect.hostname).toBe("127.0.0.1");
    expect(seen.manifest["name"]).toBe(suggestedAppName("acme"));
    expect(seen.manifest).not.toHaveProperty("hook_attributes");
  });

  it("posts to the personal create-App page for a personal account", async () => {
    const { api } = await fakeGitHub(conversion);

    const { seen } = await flow({ login: "octo", organization: false }, api, async (url) => {
      const form = await readForm(url);
      await fetch(`${String(form.manifest["redirect_url"])}?code=abc&state=${form.state}`);
      return form.action;
    });

    expect(seen).toMatch(/^https:\/\/github\.example\/settings\/apps\/new\?state=[0-9a-f]{64}$/);
  });

  it("rejects a callback whose state does not match, and keeps waiting for the one that does", async () => {
    const { api, requests } = await fakeGitHub(conversion);

    const { outcome, seen } = await flow({ login: "acme", organization: true }, api, async (url) => {
      const form = await readForm(url);
      const callback = String(form.manifest["redirect_url"]);
      const forged = await fetch(`${callback}?code=forged&state=not-the-state`);
      const exchangedBefore = requests.length;
      await fetch(`${callback}?code=abc&state=${form.state}`);
      return { forged: forged.status, exchangedBefore };
    });

    expect(seen).toEqual({ forged: 400, exchangedBefore: 0 });
    expect(requests.map((r) => r.url)).toEqual(["/app-manifests/abc/conversions"]);
    expect((outcome as RegisteredApp).slug).toBe("acme-loop-bot");
  });

  /**
   * A page that rebinds its hostname to the local port reaches the server
   * with its own name in `Host` (#330 review). Refused on the form, which
   * carries `state`, and on the callback, even one carrying the right state.
   */
  it("refuses a request addressed to any host but the one it listens on", async () => {
    const { api, requests } = await fakeGitHub(conversion);
    const as = (url: string, host: string): Promise<{ status: number; body: string }> =>
      new Promise((done, fail) => {
        const target = new URL(url);
        http
          .get({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: { Host: host } }, (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.on("end", () => done({ status: response.statusCode ?? 0, body }));
          })
          .on("error", fail);
      });

    const { outcome, seen } = await flow({ login: "acme", organization: true }, api, async (url) => {
      const form = await readForm(url);
      const callback = String(form.manifest["redirect_url"]);
      const page = await as(url, `evil.example:${new URL(url).port}`);
      const local = await as(url, `localhost:${new URL(url).port}`);
      const rebound = await as(`${callback}?code=forged&state=${form.state}`, "evil.example");
      const exchangedBefore = requests.length;
      await fetch(`${callback}?code=abc&state=${form.state}`);
      return { page, local: local.status, rebound: rebound.status, exchangedBefore };
    });

    expect(seen.page.status).toBe(421);
    expect(seen.page.body).not.toContain("state=");
    expect(seen.local).toBe(421);
    expect(seen.rebound).toBe(421);
    expect(seen.exchangedBefore).toBe(0);
    expect(requests.map((r) => r.url)).toEqual(["/app-manifests/abc/conversions"]);
    expect((outcome as RegisteredApp).slug).toBe("acme-loop-bot");
  });

  it("takes the slug and name from the conversion, never from the suggestion", async () => {
    const { api } = await fakeGitHub(conversion);

    const { outcome } = await flow({ login: "acme", organization: true }, api, async (url) => {
      const form = await readForm(url);
      await fetch(`${String(form.manifest["redirect_url"])}?code=abc&state=${form.state}`);
    });

    expect(outcome).toEqual({ id: 4242, slug: "acme-loop-bot", name: "Acme Loop Bot", pem: conversion.pem });
  });

  /**
   * A service-ready App (#562) is registered with its webhook, and GitHub
   * answers with the secret it generated, which is read; an Actions App's
   * answer carries none, and the App is read as before.
   */
  it("posts a service-ready manifest with its webhook, and reads the webhook secret back", async () => {
    const { api } = await fakeGitHub({ ...conversion, webhook_secret: "s3cret" });
    const manifest = serviceAppManifest("acme", "https://github.com/acme/agent-workflows", "https://hooks.example.test/github");

    const { outcome, seen } = await flow(
      { login: "acme", organization: true },
      api,
      async (url) => {
        const form = await readForm(url);
        await fetch(`${String(form.manifest["redirect_url"])}?code=abc&state=${form.state}`);
        return form.manifest;
      },
      manifest,
    );

    expect(seen["hook_attributes"]).toEqual({ url: "https://hooks.example.test/github", active: true });
    expect(seen["default_events"]).toEqual(["pull_request", "issues", "check_suite", "status"]);
    expect(seen["public"]).toBe(false);
    expect(outcome).toEqual({ id: 4242, slug: "acme-loop-bot", name: "Acme Loop Bot", pem: conversion.pem, webhookSecret: "s3cret" });
  });

  /**
   * The conversion endpoint refuses fine-grained PATs and App tokens, and the
   * code is the whole credential: the exchange carries no authentication.
   */
  it("exchanges the code with no authentication", async () => {
    const { api, requests } = await fakeGitHub(conversion);

    await flow({ login: "acme", organization: true }, api, async (url) => {
      const form = await readForm(url);
      await fetch(`${String(form.manifest["redirect_url"])}?code=abc&state=${form.state}`);
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(requests[0]?.headers).not.toHaveProperty("cookie");
  });

  it("answers with GitHub's words where the conversion carries no App", async () => {
    const { api } = await fakeGitHub({ message: "Not Found" });

    const { outcome } = await flow({ login: "acme", organization: true }, api, async (url) => {
      const form = await readForm(url);
      await fetch(`${String(form.manifest["redirect_url"])}?code=abc&state=${form.state}`);
    });

    expect(typeof outcome).toBe("string");
  });

  it("stops waiting at its limit", async () => {
    const outcome = await manifestFlow({
      owner: { login: "acme", organization: true },
      manifest: appManifest("acme", "https://github.com/acme/agent-workflows"),
      open: () => undefined,
      web: "https://github.example",
      api: "http://127.0.0.1:9",
      timeoutMs: 50,
    });

    expect(outcome).toMatch(/did not send the browser back/);
  });
});

describe("the suggested App name", () => {
  it("is derived from the owner, inside GitHub's 34-character limit", () => {
    expect(suggestedAppName("acme")).toBe("acme-agent-loop");
    const long = suggestedAppName("a-very-long-organisation-name-indeed");
    expect(long.length).toBeLessThanOrEqual(34);
    expect(long.endsWith("-agent-loop")).toBe(true);
  });
});

/**
 * The App's permissions are written twice (#324): in the manifest `init`
 * posts, which is what GitHub registers, and in `docs/ADOPTING.md` §2, which is
 * what a person approves them against and what someone creating the App by
 * hand copies. The label table's trick, applied to them: parse the table the
 * doc ships and compare it by value, so a permission added to the manifest
 * cannot leave the doc one behind, and the reverse.
 */
describe("the App's permissions in the adoption doc", () => {
  it("are exactly the ones the manifest asks for", () => {
    const section =
      fs
        .readFileSync(path.join("docs", "ADOPTING.md"), "utf8")
        .split(/^(?=### )/m)
        .find((part) => part.startsWith("### The loop's App")) ?? "";
    // GitHub's page names a permission otherwise than its API does in one
    // case the App asks for: *Commit statuses* is `statuses`.
    const API_NAMES: Readonly<Record<string, string>> = { commit_statuses: "statuses" };
    const documented = Object.fromEntries(
      [...section.matchAll(/^\| ([A-Z][\w ]*): \*\*(read|write)\*\* \|/gm)].map(([, name, access]) => {
        const shown = (name ?? "").toLowerCase().replaceAll(" ", "_");
        return [API_NAMES[shown] ?? shown, access];
      }),
    );

    // The table has to still be there: a restructure that moved it would
    // otherwise make this pass by comparing nothing.
    expect(Object.keys(documented).length).toBeGreaterThan(0);
    expect(documented).toEqual(APP_PERMISSIONS);
  });

  /**
   * The `agent-merge` arm (ADR 0009) is a commit status the loop's token
   * posts, so the App asks for it, and the doc tells the owner of an App made
   * before this release to add it by hand.
   */
  it("ask for Commit statuses: write, and say an older App needs it added by hand", () => {
    expect(APP_PERMISSIONS.statuses).toBe("write");
    const doc = fs.readFileSync(path.join("docs", "ADOPTING.md"), "utf8");
    expect(doc).toContain("**An App made before this release has no Commit statuses: write**");
  });
});
