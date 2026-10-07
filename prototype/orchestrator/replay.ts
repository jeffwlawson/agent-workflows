// Stand-in for GitHub's delivery: builds the `pull_request` `labeled` payload
// GitHub would send for a real PR, signs it, and posts it to the server. Proves
// everything after the network hop without a public endpoint or a webhook.
//
//   node prototype/orchestrator/replay.ts owner/name 123          → /github
//   node prototype/orchestrator/replay.ts owner/name 123 --generic → /jobs

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gh, sign } from "./github.ts";

const [repo, prArg, mode] = process.argv.slice(2);
if (repo === undefined || prArg === undefined) {
  console.error("usage: replay.ts owner/name <pr> [--generic]");
  process.exit(2);
}
const secretsFile = process.env["ORCH_SECRETS_FILE"] ?? path.join(homedir(), ".config", "agent-orchestrator", "secrets.env");
const secret = readFileSync(secretsFile, "utf8")
  .split("\n")
  .find((l) => l.startsWith("WEBHOOK_SECRET="))
  ?.slice("WEBHOOK_SECRET=".length)
  .trim();
if (secret === undefined) throw new Error(`no WEBHOOK_SECRET in ${secretsFile}`);
const port = process.env["ORCH_PORT"] ?? "8787";
const label = process.env["ORCH_LABEL"] ?? "proto:review";

const pull = JSON.parse(gh(["api", `repos/${repo}/pulls/${prArg}`])) as { number: number; head: { sha: string } };
const generic = mode === "--generic";
const body = generic
  ? JSON.stringify({ kind: "review", repo, pr: pull.number, headSha: pull.head.sha })
  : JSON.stringify({
      action: "labeled",
      label: { name: label },
      pull_request: pull,
      repository: JSON.parse(gh(["api", `repos/${repo}`])) as unknown,
      sender: { login: "replay" },
    });

const res = await fetch(`http://127.0.0.1:${port}/${generic ? "jobs" : "github"}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(generic
      ? { "x-signature-256": sign(secret, body) }
      : { "x-github-event": "pull_request", "x-github-delivery": randomUUID(), "x-hub-signature-256": sign(secret, body) }),
  },
  body,
});
console.log(res.status, (await res.text()).trim());
