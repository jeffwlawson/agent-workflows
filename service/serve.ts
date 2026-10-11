import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { InputValues } from "../shared/env.js";
import { VERSION } from "../shared/manifest.js";
import { createDispatcher, type DoorRequest, type DoorResponse } from "./dispatcher.js";
import { liveAppGitHub } from "./github-app.js";
import type { DISPATCHER } from "./settings.js";

/**
 * The dispatcher behind HTTP: its two doors, each on its own address, over
 * the live GitHub and the worker's address. Resolves once both listen; the
 * process then lives as long as they do.
 */

/** A body larger than this is refused: GitHub's deliveries and the worker's requests are far smaller. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** A whole number from a setting, or a throw naming it. */
const wholeNumber = (name: string, value: string): number => {
  if (!/^[0-9]+$/.test(value)) throw new Error(`\`${name}\` is \`${value}\`, which is not a whole number.`);
  return Number(value);
};

const read = (request: IncomingMessage): Promise<Buffer | undefined> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks)));
    request.on("error", reject);
  });

const headersOf = (request: IncomingMessage): DoorRequest["headers"] =>
  Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]));

/** A door: `POST <path>` to `handle`, `GET /health` to `ok`, anything else `404`. */
const door = (path: string, handle: (request: DoorRequest) => Promise<DoorResponse>, log: (line: string) => void): Server =>
  createServer((request, response) => {
    const reply = ({ status, body }: DoorResponse): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(`${body}\n`);
    };
    if (request.method === "GET" && request.url === "/health") return reply({ status: 200, body: '"ok"' });
    if (request.method !== "POST" || request.url !== path) return reply({ status: 404, body: '"not found"' });
    read(request).then(
      async (body) => reply(body === undefined ? { status: 413, body: '"too large"' } : await handle({ headers: headersOf(request), body })),
      (error: unknown) => {
        log(`${path}: reading the request failed: ${error instanceof Error ? error.message : String(error)}`);
        reply({ status: 400, body: '"unreadable"' });
      },
    );
  });

const listen = (server: Server, host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

export const serveDispatcher = async (
  settings: InputValues<typeof DISPATCHER>,
  stdout: (text: string) => void,
): Promise<void> => {
  const log = (line: string): void => stdout(`${new Date().toISOString()} ${line}\n`);
  const webhookPort = wholeNumber("WEBHOOK_PORT", settings.WEBHOOK_PORT);
  const tokenPort = wholeNumber("TOKEN_PORT", settings.TOKEN_PORT);
  const margin = wholeNumber("JOB_DEADLINE_MARGIN_MINUTES", settings.JOB_DEADLINE_MARGIN_MINUTES);
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(settings.GITHUB_APP_PRIVATE_KEY_FILE, "utf8");
  } catch (error) {
    throw new Error(
      `\`GITHUB_APP_PRIVATE_KEY_FILE\` names ${settings.GITHUB_APP_PRIVATE_KEY_FILE}, which could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const dispatcher = createDispatcher({
    github: liveAppGitHub(settings.GITHUB_APP_ID, privateKey),
    postJob: async (body, headers) => (await fetch(settings.WORKER_URL, { method: "POST", headers, body })).status,
    webhookSecret: settings.GITHUB_WEBHOOK_SECRET,
    workerSecret: settings.WORKER_SECRET,
    deadlineMarginMinutes: margin,
    version: VERSION,
  });

  const webhook = door(
    "/github",
    async (request) => {
      const { response, outcome } = dispatcher.delivery(request);
      const name = `${request.headers["x-github-delivery"] ?? "-"} ${request.headers["x-github-event"] ?? "-"}`;
      void outcome.then((line) => log(`delivery ${name}: ${line}`));
      return response;
    },
    log,
  );
  const tokens = door(
    "/token",
    async (request) => {
      const response = await dispatcher.token(request);
      // The body is a token where it was granted, and never logged.
      log(`token request: ${response.status}${response.status === 200 ? "" : ` ${response.body}`}`);
      return response;
    },
    log,
  );

  await listen(webhook, settings.WEBHOOK_HOST, webhookPort);
  await listen(tokens, settings.TOKEN_HOST, tokenPort);
  log(
    `dispatcher ${VERSION} listening: webhooks at http://${settings.WEBHOOK_HOST}:${webhookPort}/github, ` +
      `tokens at http://${settings.TOKEN_HOST}:${tokenPort}/token; jobs to ${settings.WORKER_URL}`,
  );
};
