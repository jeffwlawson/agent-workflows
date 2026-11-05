import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `fs` is the real module, with its writes and flushes watched, so a test can
// make a write answer short or a directory refuse a flush (#675).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync), fsyncSync: vi.fn(actual.fsyncSync), openSync: vi.fn(actual.openSync) };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EMPTY_STATE, liveStateFiles, openState, serialiseState } from "../../service/dispatcher-state.js";

const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

describe("the state file on disk (#675)", () => {
  let scratch: string;
  let file: string;
  const lines: string[] = [];
  const GOOD = `${JSON.stringify({ version: 1, asks: [{ repo: "owner/repo", number: 7, label: "agent:review", dispatches: 2, told: true }], jobs: [] })}\n`;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-state-"));
    file = path.join(scratch, "state.json");
    fs.writeFileSync(file, GOOD);
    lines.length = 0;
  });

  afterEach(() => {
    vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
    vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
    vi.mocked(fs.openSync).mockClear();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("reads a good file, an older one's format, and writes it back whole", () => {
    const store = openState("STATE_FILE", file, liveStateFiles, (line) => lines.push(line));

    expect(store.initial.asks).toEqual([expect.objectContaining({ number: 7, dispatches: 2, told: true })]);
    expect(fs.readFileSync(file, "utf8")).toBe(serialiseState(store.initial));
    expect(fs.readdirSync(scratch)).toEqual(["state.json"]);
  });

  it("does not rename a short write over the good file, and reports it", () => {
    const store = openState("STATE_FILE", file, liveStateFiles, (line) => lines.push(line));
    const before = fs.readFileSync(file, "utf8");
    vi.mocked(fs.writeSync).mockImplementation(((fd: number, buffer: Uint8Array) => actual.writeSync(fd, buffer, 0, 10)) as typeof fs.writeSync);

    expect(() => store.save(EMPTY_STATE)).toThrow(/^the state file .* could not be written: only 10 of its \d+ bytes were written$/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(scratch)).toEqual(["state.json"]);
  });

  it("flushes the directory after the rename", () => {
    const store = openState("STATE_FILE", file, liveStateFiles, (line) => lines.push(line));
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.fsyncSync).mockClear();

    store.save(EMPTY_STATE);

    const opened = vi.mocked(fs.openSync).mock.calls.map((call, index) => ({ path: call[0], fd: vi.mocked(fs.openSync).mock.results[index]?.value as number }));
    const directory = opened.find((open) => open.path === scratch);
    expect(directory).toBeDefined();
    expect(vi.mocked(fs.fsyncSync).mock.calls.map((call) => call[0])).toContain(directory?.fd);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, asks: [], jobs: [] });
  });

  it("tolerates a file system that refuses to flush a directory (EINVAL)", () => {
    const store = openState("STATE_FILE", file, liveStateFiles, (line) => lines.push(line));
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (actual.fstatSync(fd).isDirectory()) throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
      actual.fsyncSync(fd);
    });

    expect(() => store.save(EMPTY_STATE)).not.toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, asks: [], jobs: [] });
  });
});
