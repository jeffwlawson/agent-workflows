import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import * as path from "node:path";
import { hostEnvironment, type InputValues } from "../shared/env.js";
import { VERSION } from "../shared/manifest.js";
import { sandboxRefusal } from "../shared/sandbox.js";
import { appGaps, createDispatcher, parseOwners, type AppRecord, type DoorRequest, type DoorResponse } from "./dispatcher.js";
import { liveAppGitHub } from "./github-app.js";
import type { Job } from "./job.js";
import type { DISPATCHER, WORKER } from "./settings.js";
import { heldDoor, jobDoor, oneAtATime, runJob, SUMMARY_FILE } from "./worker.js";
import { announceStart, installCli, liveGit, liveLauncher, liveSandbox, liveTokens, routeThroughProxy } from "./worker-live.js";

/**
 * The service's two processes behind HTTP. The dispatcher's two doors, each
 * on its own address, over the live GitHub and the worker's address; and the
 * worker's job door, over the live edges in `worker-live.ts`. Each resolves
 * once it listens; the process then lives as long as its doors do.
 */

/** A body larger than this is refused: GitHub's deliveries and the worker's requests are far smaller. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** An `http:` or `https:` URL from a setting, or a throw naming it. Empty is none, and passes. */
const proxyUrl = (name: string, value: string): string => {
  if (value === "") return value;
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`\`${name}\` is \`${value}\`, which is not an \`http:\` or \`https:\` URL.`);
  }
  return value;
};

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

/** A door: `POST <path>` to its handler, for each path `routes` names, `GET /health` to `ok`, anything else `404`. */
const door = (routes: Readonly<Record<string, (request: DoorRequest) => Promise<DoorResponse>>>, log: (line: string) => void): Server =>
  createServer((request, response) => {
    const reply = ({ status, body }: DoorResponse): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(`${body}\n`);
    };
    if (request.method === "GET" && request.url === "/health") return reply({ status: 200, body: '"ok"' });
    const path = request.url ?? "";
    const handle = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (request.method !== "POST" || handle === undefined) return reply({ status: 404, body: '"not found"' });
    read(request)
      .then(async (body) => reply(body === undefined ? { status: 413, body: '"too large"' } : await handle({ headers: headersOf(request), body })))
      .catch((error: unknown) => {
        // Never left to reject: an unhandled rejection ends the process, and
        // with it every job in flight.
        log(`${path}: the request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) reply({ status: 500, body: '"failed"' });
      });
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

  const github = liveAppGitHub(settings.GITHUB_APP_ID, privateKey);
  // The App's owner, read once, here: the account whose installations are
  // served, beside the ones `EXTRA_OWNERS` lists. A dispatcher that cannot
  // read it does not start, rather than serving every account or none.
  let record: AppRecord;
  try {
    record = await github.app();
  } catch (error) {
    throw new Error(`The App's owner could not be read off the App's own record: ${error instanceof Error ? error.message : String(error)}`);
  }
  const owner = record.owner;
  // What the App is granted and subscribed to, off the same record: a gap
  // warns, by name, and the dispatcher starts regardless (#560).
  for (const gap of appGaps(record)) log(`warning: ${gap}`);
  const owners = [owner, ...parseOwners(settings.EXTRA_OWNERS)];

  const dispatcher = createDispatcher({
    github,
    owners,
    postJob: async (body, headers) => (await fetch(settings.WORKER_URL, { method: "POST", headers, body })).status,
    // The worker's held door, beside its job door: `/held` where `WORKER_URL` ends `/jobs`.
    askHeld: async (body, headers) => {
      const response = await fetch(new URL("held", settings.WORKER_URL), { method: "POST", headers, body });
      return { status: response.status, body: await response.text() };
    },
    log,
    webhookSecret: settings.GITHUB_WEBHOOK_SECRET,
    workerSecret: settings.WORKER_SECRET,
    deadlineMarginMinutes: margin,
    version: VERSION,
  });

  const webhook = door(
    {
      "/github": async (request) => {
        const { response, outcome } = dispatcher.delivery(request);
        const name = `${request.headers["x-github-delivery"] ?? "-"} ${request.headers["x-github-event"] ?? "-"}`;
        void outcome.then((line) => log(`delivery ${name}: ${line}`));
        return response;
      },
    },
    log,
  );
  const tokens = door(
    {
      "/token": async (request) => {
        const response = await dispatcher.token(request);
        // The body is a token where it was granted, and never logged.
        log(`token request: ${response.status}${response.status === 200 ? "" : ` ${response.body}`}`);
        return response;
      },
      // The worker's start (#581), on the door only the worker reaches.
      "/started": async (request) => {
        const { response } = dispatcher.started(request);
        log(`the worker's start: ${response.status}${response.status === 202 ? ", scanning" : ` ${response.body}`}`);
        return response;
      },
    },
    log,
  );

  await listen(webhook, settings.WEBHOOK_HOST, webhookPort);
  await listen(tokens, settings.TOKEN_HOST, tokenPort);
  log(
    `dispatcher ${VERSION} listening: webhooks at http://${settings.WEBHOOK_HOST}:${webhookPort}/github, ` +
      `tokens at http://${settings.TOKEN_HOST}:${tokenPort}/token; jobs to ${settings.WORKER_URL}; ` +
      `serving installations on ${owners.join(", ")}`,
  );
  // A restart strands no labelled work (#581): what nothing holds a job for is dispatched again.
  log("scanning for labelled work nothing holds a job for");
  void dispatcher.scan();
};

/**
 * The worker: the agent's CLI installed at the version its settings require,
 * then the job door, whose jobs run one at a time, each in a directory of its
 * own under `WORK_DIR/runs`, kept afterwards with each subcommand's output
 * directory and log and the run's summary. Each phase's outcome is logged as the job ends.
 * Where `WORKER_PROXY` names a proxy, everything the worker asks of the
 * network, and everything it starts, goes through it. A `bwrap` sandbox with
 * no `AGENT_SANDBOX_PROXY` is refused before anything is installed (#461).
 */
export const serveWorker = async (settings: InputValues<typeof WORKER>, stdout: (text: string) => void): Promise<void> => {
  const log = (line: string): void => stdout(`${new Date().toISOString()} ${line}\n`);
  const port = wholeNumber("JOBS_PORT", settings.JOBS_PORT);
  const host = hostEnvironment(proxyUrl("WORKER_PROXY", settings.WORKER_PROXY));
  // Refused here as a runner would refuse it, but at start: `AGENT_SANDBOX` is
  // `bwrap` where unset, and every job would otherwise fail the same way.
  const refusal = sandboxRefusal(settings.AGENT_SANDBOX, settings.AGENT_SANDBOX_PROXY);
  if (refusal !== undefined) throw new Error(refusal);
  routeThroughProxy(host);
  const prefix = path.join(settings.WORK_DIR, "claude-code", settings.CLAUDE_CODE_VERSION);
  log(`installing the agent's CLI, @anthropic-ai/claude-code@${settings.CLAUDE_CODE_VERSION}, into ${prefix}`);
  const cliBin = await installCli(prefix, settings.CLAUDE_CODE_VERSION, host);

  // What the runner is handed from these settings. The CLI's prefix is bound
  // read-only into the sandbox and put first on its `PATH`, so the agent runs
  // the `claude` installed here.
  const agent = {
    CLAUDE_CODE_OAUTH_TOKEN: settings.CLAUDE_CODE_OAUTH_TOKEN,
    AGENT_SANDBOX: settings.AGENT_SANDBOX,
    AGENT_SANDBOX_RO_BINDS: [settings.AGENT_SANDBOX_RO_BINDS, prefix].filter((part) => part !== "").join(":"),
    AGENT_SANDBOX_PATH: `${cliBin}:${settings.AGENT_SANDBOX_PATH}`,
    AGENT_SANDBOX_PROXY: settings.AGENT_SANDBOX_PROXY,
  };

  const work = async (job: Job): Promise<void> => {
    const runDir = path.join(settings.WORK_DIR, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${job.id}`);
    fs.mkdirSync(runDir, { recursive: true });
    log(`job ${job.id}: ${job.workflow} on ${job.repo}#${"issue" in job ? job.issue : "headSha" in job ? `${job.pr} at ${job.headSha}` : job.pr}, in ${runDir}`);
    const phases = await runJob(job, {
      token: liveTokens(settings.DISPATCHER_TOKEN_URL, settings.WORKER_SECRET, job.id),
      launch: liveLauncher,
      git: liveGit(host),
      sandbox: liveSandbox(host),
      host,
      agent,
      cliBin,
      runDir,
    });
    log(`job ${job.id}: ended. ${phases.map(({ name, outcome }) => `${name}: ${outcome}`).join("; ")}. Its summary: ${path.join(runDir, SUMMARY_FILE)}`);
  };
  const queue = oneAtATime(work, (error) => log(`a job failed: ${error instanceof Error ? error.message : String(error)}`));
  const accept = jobDoor({ secret: settings.WORKER_SECRET, version: VERSION, accept: queue.add });
  const held = heldDoor({ secret: settings.WORKER_SECRET, held: queue.held });

  const jobs = door(
    {
      "/jobs": async (request) => {
        const response = accept(request);
        log(`job request: ${response.status} ${response.body}`);
        return response;
      },
      "/held": async (request) => {
        const response = held(request);
        log(`held request: ${response.status}`);
        return response;
      },
    },
    log,
  );
  await listen(jobs, settings.JOBS_HOST, port);
  log(`worker ${VERSION} listening: jobs at http://${settings.JOBS_HOST}:${port}/jobs; tokens from ${settings.DISPATCHER_TOKEN_URL}`);
  // Listening first, so the scan the dispatcher answers with can ask what is held here.
  log(`the worker's start, announced: ${await announceStart(settings.DISPATCHER_TOKEN_URL, settings.WORKER_SECRET, VERSION)}`);
};
