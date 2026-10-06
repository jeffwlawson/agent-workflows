// PROTOTYPE (#364): the dispatcher. It runs on Unraid, holds the loop App's
// private key, and is the only thing that does.
//
//   GitHub App webhook ──► Tailscale Funnel ──► POST /github (this, on 127.0.0.1)
//     verify signature · route the label · refuse forks and non-writers
//     mint a 1-hour token: this repo only, read + post a review
//   ──► POST <worker>/jobs, signed ──► the orchestrator in the agent box
//
// The agent box never sees the key, only one job's token at a time.
// No dependencies: Node 24 runs this file directly (it strips the types).
//
// Config: a `KEY=VALUE` file at DISPATCHER_ENV (default /app/dispatcher.env):
//   APP_ID, APP_KEY_FILE, GITHUB_WEBHOOK_SECRET, WORKER_URL, WORKER_SECRET,
//   ALLOWED_OWNERS (comma-separated), LABEL (default proto:review), PORT (default 8790).

import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const envFile = process.env["DISPATCHER_ENV"] ?? "/app/dispatcher.env";
const conf = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const need = (k: string): string => {
  const v = conf[k];
  if (v === undefined || v === "") throw new Error(`${k} is missing from ${envFile}`);
  return v;
};

const APP_ID = need("APP_ID");
const APP_KEY = readFileSync(need("APP_KEY_FILE"), "utf8");
const WEBHOOK_SECRET = need("GITHUB_WEBHOOK_SECRET");
const WORKER_URL = need("WORKER_URL");
const WORKER_SECRET = need("WORKER_SECRET");
const ALLOWED_OWNERS = new Set(need("ALLOWED_OWNERS").split(",").map((s) => s.trim().toLowerCase()));
const LABEL = conf["LABEL"] ?? "proto:review";
const PORT = Number(conf["PORT"] ?? "8790");

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

const hmac = (secret: string, body: Buffer | string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const verify = (secret: string, body: Buffer, header: string | undefined): boolean => {
  if (header === undefined) return false;
  const a = Buffer.from(hmac(secret, body));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
};

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** A 9-minute JWT signed with the App key: GitHub's App authentication. */
const appJwt = (): string => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: APP_ID }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(APP_KEY);
  return `${head}.${body}.${b64url(sig)}`;
};

const api = async (path: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown }> => {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: auth,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "agent-dispatcher",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** What a review job may do: read the code and the conversation, post a review. */
const REVIEW_PERMISSIONS = { contents: "read", pull_requests: "write", issues: "read" };
/** Asked for too, for the CI evidence; dropped if the App was not granted them. */
const REVIEW_OPTIONAL = { checks: "read", statuses: "read", actions: "read" };

const mintRepoToken = async (repo: string): Promise<string> => {
  const jwt = `Bearer ${appJwt()}`;
  const inst = await api(`/repos/${repo}/installation`, jwt);
  if (inst.status !== 200) throw new Error(`the App is not installed on ${repo} (HTTP ${inst.status})`);
  const id = (inst.json as { id: number }).id;
  const name = repo.split("/")[1];
  for (const permissions of [{ ...REVIEW_PERMISSIONS, ...REVIEW_OPTIONAL }, REVIEW_PERMISSIONS]) {
    const t = await api(`/app/installations/${id}/access_tokens`, jwt, { method: "POST", body: { repositories: [name], permissions } });
    if (t.status === 201) return (t.json as { token: string }).token;
    if (t.status !== 422) throw new Error(`token request failed (HTTP ${t.status})`);
  }
  throw new Error("the App lacks contents:read, pull_requests:write or issues:read on this repository");
};

/** The label's author must be able to push, as the loop's author gate requires (ADOPTING §8). */
const canWrite = async (repo: string, login: string, token: string): Promise<boolean> => {
  if (login.toLowerCase() === repo.split("/")[0]?.toLowerCase()) return true;
  const r = await api(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, `Bearer ${token}`);
  const p = (r.json as { permission?: string } | null)?.permission;
  return r.status === 200 && (p === "admin" || p === "maintain" || p === "write");
};

interface LabeledPr {
  action?: string;
  label?: { name?: string };
  sender?: { login?: string };
  repository?: { full_name?: string; owner?: { login?: string } };
  pull_request?: { number?: number; state?: string; head?: { sha?: string; repo?: { full_name?: string } | null } };
}

const handle = async (event: string | undefined, p: LabeledPr): Promise<string> => {
  if (event === "ping") return "pong";
  if (event !== "pull_request" || p.action !== "labeled" || p.label?.name !== LABEL) return "ignored";
  const repo = p.repository?.full_name;
  const pr = p.pull_request?.number;
  const headSha = p.pull_request?.head?.sha;
  const sender = p.sender?.login;
  if (repo === undefined || pr === undefined || headSha === undefined || sender === undefined) return "refused: incomplete payload";
  if (!ALLOWED_OWNERS.has(repo.split("/")[0]?.toLowerCase() ?? "")) return `refused: owner of ${repo} is not allowed`;
  if (p.pull_request?.head?.repo?.full_name !== repo) return "refused: head is on a fork";
  if (p.pull_request?.state !== "open") return "refused: PR is not open";

  const token = await mintRepoToken(repo);
  if (!(await canWrite(repo, sender, token))) return `refused: ${sender} cannot push to ${repo}`;

  const body = JSON.stringify({ kind: "review", repo, pr, headSha, token, source: "dispatcher" });
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-256": hmac(WORKER_SECRET, body) },
    body,
  });
  return `forwarded ${repo}#${pr} → worker ${res.status} ${(await res.text()).trim()}`;
};

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const reply = (status: number, text: string): void => {
      res.writeHead(status, { "content-type": "text/plain" }).end(`${text}\n`);
    };
    if (req.method === "GET" && req.url === "/health") return reply(200, "ok");
    if (req.method !== "POST" || req.url !== "/github") return reply(404, "not found");
    const body = Buffer.concat(chunks);
    const sig = req.headers["x-hub-signature-256"];
    if (!verify(WEBHOOK_SECRET, body, typeof sig === "string" ? sig : undefined)) {
      log("POST /github → 401 bad signature");
      return reply(401, "bad signature");
    }
    const event = req.headers["x-github-event"] as string | undefined;
    const delivery = req.headers["x-github-delivery"] as string | undefined;
    // Answer GitHub at once; its delivery times out at 10 s, a job takes minutes.
    reply(202, "accepted");
    let payload: LabeledPr;
    try {
      payload = JSON.parse(body.toString("utf8")) as LabeledPr;
    } catch {
      return log(`${delivery} ${event}: body is not JSON`);
    }
    handle(event, payload).then(
      (outcome) => log(`${delivery} ${event}/${payload.action ?? "-"}: ${outcome}`),
      (e: unknown) => log(`${delivery} ${event}/${payload.action ?? "-"}: failed: ${(e as Error).message}`),
    );
  });
}).listen(PORT, "127.0.0.1", () => log(`dispatcher listening on 127.0.0.1:${PORT}; label ${LABEL}; worker ${WORKER_URL}`));
