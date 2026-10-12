import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveWorker } from "../../service/serve.js";

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
});
