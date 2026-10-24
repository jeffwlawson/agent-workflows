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
      /`AGENT_SANDBOX_PROXY` is `127.0.0.1:3128`/,
    );
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  // Past the refusal it installs the CLI, which this test stops at once with a
  // `WORK_DIR` that is a file, rather than reaching a registry.
  it.each([
    ["none, with no proxy", { AGENT_SANDBOX: "none" }],
    ["bwrap, with a proxy", { AGENT_SANDBOX_PROXY: "http://127.0.0.1:3128" }],
  ] as const)("starts with %s", async (_, given) => {
    const lines: string[] = [];
    const file = path.join(scratch, "not-a-directory");
    fs.writeFileSync(file, "");

    await expect(serveWorker({ ...SETTINGS, WORK_DIR: file, ...given }, (text) => lines.push(text))).rejects.toThrow(/ENOTDIR|EEXIST/);

    expect(lines.join("")).toContain("installing the agent's CLI");
  });
});
