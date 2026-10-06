// Two doors into one core:
//   POST /github  — GitHub's webhook, verified with its signature
//   POST /jobs    — any caller, with a Job body signed the same way
// Jobs run one at a time; this is a prototype, not a queue.
//
// Run:  node prototype/orchestrator/server.ts   (Node 24 strips the types)

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fromGitHub, verifySignature } from "./github.ts";
import { parseJob, type Job } from "./job.ts";
import { runReview, type Config } from "./review-job.ts";

// Secrets come from a file the user writes, so they never pass through a
// command line or this process's parent environment: WEBHOOK_SECRET and
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`).
const secretsFile = process.env["ORCH_SECRETS_FILE"] ?? path.join(homedir(), ".config", "agent-orchestrator", "secrets.env");
if (!existsSync(secretsFile)) {
  console.error(`No secrets file at ${secretsFile}. See prototype/orchestrator/README.md.`);
  process.exit(1);
}
const secrets = Object.fromEntries(
  readFileSync(secretsFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const need = (k: string): string => {
  const v = secrets[k];
  if (v === undefined || v === "") {
    console.error(`${k} is missing from ${secretsFile}.`);
    process.exit(1);
  }
  return v;
};

const webhookSecret = need("WEBHOOK_SECRET");
const label = process.env["ORCH_LABEL"] ?? "proto:review";
const port = Number(process.env["ORCH_PORT"] ?? "8787");
const model = process.env["ORCH_MODEL"];
const cfg: Config & { pathPrefix: string; toolchain: readonly string[] } = {
  runnerCli: path.resolve(import.meta.dirname, "../../dist/cli.js"),
  claudeToken: need("CLAUDE_CODE_OAUTH_TOKEN"),
  // The prototype reads and posts with the user's own gh login (finding: a real
  // one wants a read-only token for the runner and an App for the writes).
  readToken: execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(),
  sandbox: process.env["ORCH_SANDBOX"] ?? "none",
  pathPrefix: "",
  toolchain: [],
  ...(model === undefined ? {} : { model }),
  timeoutMs: 30 * 60 * 1000,
};
// The agent's CLI is the orchestrator's to provide, as review.yml's
// `npm install -g @anthropic-ai/claude-code` does on every run: the host's own
// `claude` was too old for the loop's model on the first real run (finding).
const cliVersion = process.env["ORCH_CLAUDE_VERSION"] ?? "latest";
const cliPrefix = path.join(tmpdir(), "orch-claude-cli");
execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--prefix", cliPrefix, `@anthropic-ai/claude-code@${cliVersion}`], {
  stdio: "inherit",
});
const cliBin = path.join(cliPrefix, "node_modules", ".bin");
const installed = execFileSync(path.join(cliBin, "claude"), ["--version"], { encoding: "utf8" }).trim();

if (!existsSync(cfg.runnerCli)) {
  console.error(`No runner at ${cfg.runnerCli}; run \`npm run build\` first.`);
  process.exit(1);
}

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
cfg.pathPrefix = cliBin;
cfg.toolchain = [path.dirname(path.dirname(process.execPath)), cliPrefix];
log(`agent CLI: ${installed} (from ${cliPrefix})`);

let busy: Promise<unknown> = Promise.resolve();
const enqueue = (job: Job): void => {
  busy = busy.then(async () => {
    log(`job: ${job.kind} ${job.repo}#${job.pr} (from ${job.source})`);
    try {
      const record = await runReview(job, cfg, log);
      log(`stood in for review.yml ${record.stoodIn.length} times; record at ${record.workDir}/run.json`);
    } catch (e) {
      log(`job threw: ${(e as Error).message}`);
    }
  });
};

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const reply = (status: number, text: string): void => {
      res.writeHead(status, { "content-type": "text/plain" }).end(`${text}\n`);
      log(`${req.method} ${req.url} → ${status} ${text}`);
    };
    if (req.method !== "POST" || (req.url !== "/github" && req.url !== "/jobs")) return reply(404, "not found");
    const signature = req.headers[req.url === "/github" ? "x-hub-signature-256" : "x-signature-256"];
    if (!verifySignature(webhookSecret, body, typeof signature === "string" ? signature : undefined)) {
      return reply(401, "bad signature");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return reply(400, "body is not JSON");
    }
    const job =
      req.url === "/github"
        ? fromGitHub(req.headers["x-github-event"] as string | undefined, parsed, label)
        : parseJob(parsed);
    if (typeof job === "string") return reply(req.url === "/github" ? 202 : 400, job);
    enqueue(job);
    return reply(202, `accepted ${job.kind} ${job.repo}#${job.pr}`);
  });
}).listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port}; trigger label ${label}; sandbox ${cfg.sandbox}`));
