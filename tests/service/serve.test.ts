import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveDispatcher, serveWorker } from "../../service/serve.js";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "serve-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const SETTINGS = {
  WORKER_SECRET: "secret",
  DISPATCHER_TOKEN_URL: "http://192.0.2.1:8791/token",
  CLAUDE_CODE_VERSION: "0.0.0",
  CLAUDE_CODE_OAUTH_TOKEN: "the-model-token",
  JOBS_HOST: "127.0.0.1",
  JOBS_PORT: "8787",
  WORKER_PROXY: "",
  AGENT_SANDBOX: "bwrap",
  AGENT_SANDBOX_RO_BINDS: "",
  AGENT_SANDBOX_PATH: "/usr/bin",
  AGENT_SANDBOX_PROXY: "",
} as const;

describe("the worker's start", () => {
  it.each(["127.0.0.1:8888", "proxy", "socks5://127.0.0.1:1080"])("refuses a WORKER_PROXY of %s, naming the setting, before it installs anything", async (proxy) => {
    const lines: string[] = [];

    await expect(serveWorker({ ...SETTINGS, WORK_DIR: scratch, WORKER_PROXY: proxy }, (text) => lines.push(text))).rejects.toThrow(/`WORKER_PROXY`/);

    expect(lines).toEqual([]);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  // #461: `bwrap`'s network is its own, and the proxy is its only way out, so
  // a worker that would start every agent without one does not start.
  it("refuses the bwrap sandbox, its default, with no AGENT_SANDBOX_PROXY, naming the setting, before it installs anything", async () => {
    const lines: string[] = [];

    await expect(serveWorker({ ...SETTINGS, WORK_DIR: scratch }, (text) => lines.push(text))).rejects.toThrow(/needs `AGENT_SANDBOX_PROXY`/);

    expect(lines).toEqual([]);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it("refuses an AGENT_SANDBOX_PROXY that is not a URL with a host", async () => {
    await expect(serveWorker({ ...SETTINGS, WORK_DIR: scratch, AGENT_SANDBOX_PROXY: "127.0.0.1:3128" }, () => {})).rejects.toThrow(
      /`AGENT_SANDBOX_PROXY` is `127.0.0.1:3128`, which is not an `http:` URL with a host/,
    );
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  // #535: the sandbox reaches the proxy by a loopback address, which an
  // `https:` proxy's certificate does not name.
  it("refuses an https: AGENT_SANDBOX_PROXY under bwrap, its default, naming the setting, before it installs anything", async () => {
    const lines: string[] = [];

    await expect(serveWorker({ ...SETTINGS, WORK_DIR: scratch, AGENT_SANDBOX_PROXY: "https://proxy.example:3128" }, (text) => lines.push(text))).rejects.toThrow(
      /`AGENT_SANDBOX_PROXY` is `https:\/\/proxy.example:3128`, an `https:` URL.*`http:` URL/,
    );

    expect(lines).toEqual([]);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  // Past the refusal it installs the CLI, which this test stops at once with a
  // `WORK_DIR` that is a file, rather than reaching a registry.
  it.each([
    ["none, with no proxy", { AGENT_SANDBOX: "none" }],
    ["bwrap, with a proxy", { AGENT_SANDBOX_PROXY: "http://127.0.0.1:3128" }],
    ["none, with an https: sandbox proxy", { AGENT_SANDBOX: "none", AGENT_SANDBOX_PROXY: "https://proxy.example:3128" }],
    ["bwrap, with an https: WORKER_PROXY and an http: sandbox proxy", { WORKER_PROXY: "https://proxy.example:3128", AGENT_SANDBOX_PROXY: "http://127.0.0.1:3128" }],
  ] as const)("starts with %s", async (_, given) => {
    const lines: string[] = [];
    const file = path.join(scratch, "not-a-directory");
    fs.writeFileSync(file, "");

    await expect(serveWorker({ ...SETTINGS, WORK_DIR: file, ...given }, (text) => lines.push(text))).rejects.toThrow(/ENOTDIR|EEXIST/);

    expect(lines.join("")).toContain("installing the agent's CLI");
  });
});

describe("the dispatcher's start", () => {
  const DISPATCHER_SETTINGS = {
    GITHUB_APP_ID: "1",
    GITHUB_WEBHOOK_SECRET: "the-webhook-secret",
    WORKER_URL: "http://192.0.2.2:8787/jobs",
    WORKER_SECRET: "secret",
    WEBHOOK_HOST: "127.0.0.1",
    WEBHOOK_PORT: "8790",
    TOKEN_HOST: "127.0.0.1",
    TOKEN_PORT: "8791",
    JOB_DEADLINE_MARGIN_MINUTES: "60",
    EXTRA_OWNERS: "",
    SCAN_MERGED_WINDOW_DAYS: "7",
    SCAN_INTERVAL_MINUTES: "60",
    REDELIVERY_INTERVAL_MINUTES: "5",
    REDELIVERY_WINDOW_MINUTES: "30",
    STATE_FILE: "",
  } as const;

  // #596: a limit of 0 would not turn the scan off, only stop it dispatching.
  it.each([
    ["0", /`SCAN_DISPATCH_LIMIT` is `0`.*at least 1/],
    ["two", /`SCAN_DISPATCH_LIMIT` is `two`, which is not a whole number/],
  ])("refuses a SCAN_DISPATCH_LIMIT of %s, naming the setting, before it reads the App's key", async (limit, refusal) => {
    const lines: string[] = [];
    const key = path.join(scratch, "no-such-key.pem");

    await expect(
      serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: limit }, (text) => lines.push(text)),
    ).rejects.toThrow(refusal);

    expect(lines).toEqual([]);
  });

  // #603: a window of 0 days would list no merge at all.
  it.each([
    ["0", /`SCAN_MERGED_WINDOW_DAYS` is `0`.*at least 1/],
    ["-1", /`SCAN_MERGED_WINDOW_DAYS` is `-1`, which is not a whole number/],
    ["a week", /`SCAN_MERGED_WINDOW_DAYS` is `a week`, which is not a whole number/],
  ])("refuses a SCAN_MERGED_WINDOW_DAYS of %s, naming the setting, before it reads the App's key", async (days, refusal) => {
    const lines: string[] = [];
    const key = path.join(scratch, "no-such-key.pem");

    await expect(
      serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: "2", SCAN_MERGED_WINDOW_DAYS: days }, (text) => lines.push(text)),
    ).rejects.toThrow(refusal);

    expect(lines).toEqual([]);
  });

  // #774: a window of 0 minutes would redeliver nothing; an interval of 0 is the way to turn it off.
  it.each([
    ["REDELIVERY_WINDOW_MINUTES", "0", /`REDELIVERY_WINDOW_MINUTES` is `0`.*at least 1; `REDELIVERY_INTERVAL_MINUTES=0` turns the poll off/],
    ["REDELIVERY_WINDOW_MINUTES", "half an hour", /`REDELIVERY_WINDOW_MINUTES` is `half an hour`, which is not a whole number/],
    ["REDELIVERY_INTERVAL_MINUTES", "-5", /`REDELIVERY_INTERVAL_MINUTES` is `-5`, which is not a whole number/],
    // An interval past setInterval's 2^31-1 ms would fire every millisecond.
    ["REDELIVERY_INTERVAL_MINUTES", "1441", /`REDELIVERY_INTERVAL_MINUTES` is `1441`, more than a day.*at most 1440; `0` turns the poll off/],
    ["REDELIVERY_INTERVAL_MINUTES", "35792", /`REDELIVERY_INTERVAL_MINUTES` is `35792`, more than a day.*at most 1440/],
    // #790: the timed scan's interval, bounded as the redelivery poll's is.
    ["SCAN_INTERVAL_MINUTES", "-60", /`SCAN_INTERVAL_MINUTES` is `-60`, which is not a whole number/],
    ["SCAN_INTERVAL_MINUTES", "an hour", /`SCAN_INTERVAL_MINUTES` is `an hour`, which is not a whole number/],
    ["SCAN_INTERVAL_MINUTES", "1441", /`SCAN_INTERVAL_MINUTES` is `1441`, more than a day.*at most 1440; `0` turns the timed scan off/],
  ])("refuses a %s of %s, naming the setting, before it reads the App's key", async (name, value, refusal) => {
    const lines: string[] = [];
    const key = path.join(scratch, "no-such-key.pem");

    await expect(
      serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: "2", [name]: value }, (text) => lines.push(text)),
    ).rejects.toThrow(refusal);

    expect(lines).toEqual([]);
  });

  it("starts past a REDELIVERY_INTERVAL_MINUTES of 0, the poll off, as far as reading the App's key", async () => {
    const key = path.join(scratch, "no-such-key.pem");

    await expect(
      serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: "2", REDELIVERY_INTERVAL_MINUTES: "0" }, () => {}),
    ).rejects.toThrow(/`GITHUB_APP_PRIVATE_KEY_FILE` names/);
  });

  it("starts past a SCAN_MERGED_WINDOW_DAYS of 1, as far as reading the App's key", async () => {
    const key = path.join(scratch, "no-such-key.pem");

    await expect(
      serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: "2", SCAN_MERGED_WINDOW_DAYS: "1" }, () => {}),
    ).rejects.toThrow(/`GITHUB_APP_PRIVATE_KEY_FILE` names/);
  });

  // #618: a state file that silently does not persist is the failure it ends.
  it("refuses a STATE_FILE in no such directory, naming the setting, before it reads the App's key", async () => {
    const lines: string[] = [];
    const key = path.join(scratch, "no-such-key.pem");
    const file = path.join(scratch, "no-such-directory", "dispatcher.json");

    await expect(
      serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: "2", STATE_FILE: file }, (text) => lines.push(text)),
    ).rejects.toThrow(new RegExp(`^\`STATE_FILE\` names ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which cannot be written: `));
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  // #806: a full disk, read-only mount or no permission warns and runs from memory, rather than loop the container in a restart.
  it("starts past a STATE_FILE it has no permission to write, with one warning naming the setting, as far as reading the App's key", async () => {
    const lines: string[] = [];
    const key = path.join(scratch, "no-such-key.pem");
    const directory = path.join(scratch, "read-only");
    fs.mkdirSync(directory, { mode: 0o500 });
    const file = path.join(directory, "dispatcher.json");
    try {
      await expect(
        serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: "2", STATE_FILE: file }, (text) => lines.push(text)),
      ).rejects.toThrow(/`GITHUB_APP_PRIVATE_KEY_FILE` names/);
    } finally {
      fs.chmodSync(directory, 0o700);
    }
    expect(lines.filter((line) => line.includes(" warning: "))).toEqual([
      expect.stringMatching(new RegExp(` warning: \`STATE_FILE\` names ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which cannot be written: EACCES: .*Starting with the state in memory only`)),
    ]);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("starts past a STATE_FILE it can write to, as far as reading the App's key, and leaves the file written", async () => {
    const key = path.join(scratch, "no-such-key.pem");
    const file = path.join(scratch, "dispatcher.json");

    await expect(
      serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: "2", STATE_FILE: file }, () => {}),
    ).rejects.toThrow(/`GITHUB_APP_PRIVATE_KEY_FILE` names/);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, asks: [], jobs: [] });
    expect(fs.readdirSync(scratch)).toEqual(["dispatcher.json"]);
  });

  it("starts past a SCAN_DISPATCH_LIMIT of 1, as far as reading the App's key", async () => {
    const key = path.join(scratch, "no-such-key.pem");

    await expect(serveDispatcher({ ...DISPATCHER_SETTINGS, GITHUB_APP_PRIVATE_KEY_FILE: key, SCAN_DISPATCH_LIMIT: "1" }, () => {})).rejects.toThrow(
      /`GITHUB_APP_PRIVATE_KEY_FILE` names/,
    );
  });
});

/** The dispatcher's settings for a start that listens: any free port, the redelivery poll off. */
const DISPATCHER_START = {
  GITHUB_APP_ID: "1",
  GITHUB_WEBHOOK_SECRET: "the-webhook-secret",
  WORKER_URL: "http://192.0.2.2:8787/jobs",
  WORKER_SECRET: "secret",
  WEBHOOK_HOST: "127.0.0.1",
  WEBHOOK_PORT: "0",
  TOKEN_HOST: "127.0.0.1",
  TOKEN_PORT: "0",
  JOB_DEADLINE_MARGIN_MINUTES: "60",
  EXTRA_OWNERS: "",
  SCAN_DISPATCH_LIMIT: "2",
  SCAN_MERGED_WINDOW_DAYS: "7",
  REDELIVERY_INTERVAL_MINUTES: "0",
  REDELIVERY_WINDOW_MINUTES: "30",
  STATE_FILE: "",
} as const;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The scan on a timer (#790), observed at the dispatcher's start with the
 * network stubbed: each scan asks the worker's held door first, so each ask
 * there is one scan. The worker cannot say, so each scan is skipped and logged.
 */
describe("the dispatcher's timed scan", () => {
  const servers: Server[] = [];
  let asks: Array<() => void>;
  let lines: string[];

  beforeEach(() => {
    asks = [];
    lines = [];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const listen = Server.prototype.listen;
    vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
      servers.push(this);
      return (listen as (...a: unknown[]) => Server).apply(this, args);
    });
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const where = String(url);
      if (where.endsWith("/held")) {
        // Held open until the test lets it go, so a scan can be kept running.
        await new Promise<void>((resolve) => asks.push(resolve));
        throw new Error("connect ECONNREFUSED");
      }
      if (where.endsWith("/app")) return new Response(JSON.stringify({ slug: "loop", owner: { login: "owner" }, permissions: {}, events: [] }), { status: 200 });
      return new Response("[]", { status: 200 });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) server.close();
  });

  const start = async (interval: string): Promise<void> => {
    const key = path.join(scratch, "app.pem");
    fs.writeFileSync(key, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));
    await serveDispatcher(
      {
        ...DISPATCHER_START,
        GITHUB_APP_PRIVATE_KEY_FILE: key,
        SCAN_INTERVAL_MINUTES: interval,
      },
      (text) => lines.push(text),
    );
  };
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const release = async (): Promise<void> => {
    for (const resolve of asks.splice(0)) resolve();
    await settle();
  };

  it("scans again every SCAN_INTERVAL_MINUTES after the start scan, and a failed scan does not stop the timer", async () => {
    await start("60");
    await settle();
    expect(asks).toHaveLength(1);
    await release();
    expect(lines.filter((line) => line.includes("timed scan: every 60 minutes"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("scan: skipped: the worker could not say"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HOUR - MINUTE);
    await settle();
    expect(asks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await settle();
    expect(asks).toHaveLength(1);
    await release();

    await vi.advanceTimersByTimeAsync(HOUR);
    await settle();
    expect(asks).toHaveLength(1);
    await release();
    expect(lines.filter((line) => line.includes("scan: skipped: the worker could not say"))).toHaveLength(3);
  });

  it("starts no timed scan while the timer's last one is still running", async () => {
    await start("60");
    await settle();
    await release();

    await vi.advanceTimersByTimeAsync(HOUR);
    await settle();
    expect(asks).toHaveLength(1);
    // Three more ticks with that scan still waiting on the worker: none asks again.
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    await settle();
    expect(asks).toHaveLength(1);
    await release();
    expect(asks).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(HOUR);
    await settle();
    expect(asks).toHaveLength(1);
    await release();
  });

  it("turns the timer off at 0, with one line at start, and scans only at start", async () => {
    await start("0");
    await settle();
    await release();
    expect(lines.filter((line) => line.includes("timed scan: off, SCAN_INTERVAL_MINUTES is 0"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    await settle();
    expect(asks).toHaveLength(0);
  });
});
