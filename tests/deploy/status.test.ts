import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type DispatcherState, serialiseState } from "../../service/dispatcher-state.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `deploy/unraid/status.sh`, what the loop is running now (#778), run with
 * Unraid stubbed. The script is copied into a scratch directory beside an
 * `agent-service.conf` pointing `APPDATA` into it, so no setting of the
 * checkout's is read. `id` answers root and `docker` answers `inspect` from
 * `FAKE_CONTAINER`; its `exec` runs the script status.sh hands the container
 * with the real `node`, the container's `WORKER_URL` and `WORKER_SECRET` set,
 * and `fetch` replaced by one that answers the worker's held door from
 * `held-answer.json` and records each question in `calls/held-requests`.
 * Every stub call is logged to `calls/calls`.
 *
 * The state file is written by the dispatcher's own `serialiseState`, so the
 * format the script reads is the one the dispatcher writes.
 */

const SCRIPT = path.join(import.meta.dirname, "..", "..", "deploy", "unraid", "status.sh");
/** The dispatcher container's WORKER_SECRET, which no output or command line may carry. */
const SECRET = "the-shared-secret-0123456789";

const STUBS: Record<string, string> = {
  id: `echo "\${FAKE_UID:-0}"`,
  docker: `
case "$1" in
  inspect)
    case "\${FAKE_CONTAINER:-running}" in
      running) echo "running 2026-11-05T09:00:00.000Z" ;;
      exited) echo "exited 2026-11-04T08:00:00.000Z" ;;
      *) echo "Error: No such object: $4" >&2; exit 1 ;;
    esac ;;
  exec)
    shift 3
    WORKER_URL=http://box.example:8787/jobs WORKER_SECRET='${SECRET}' exec "$1" --import "file://$FAKE/fetch.mjs" "\${@:2}" ;;
  *) echo "docker: not a read: $*" >&2; exit 1 ;;
esac`,
};

const FAKE_FETCH = `import * as fs from "node:fs";
const answer = JSON.parse(fs.readFileSync(process.env.FAKE + "/held-answer.json", "utf8"));
globalThis.fetch = async (url, init) => {
  fs.appendFileSync(process.env.FAKE + "/calls/held-requests", JSON.stringify({ url: String(url), method: init.method, headers: init.headers, body: init.body }) + "\\n");
  if (answer === "unreachable") throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
  return new Response(JSON.stringify(answer.body), { status: answer.status });
};
`;

type HeldAnswer = { readonly status: number; readonly body: unknown } | "unreachable";

const STATE: DispatcherState = {
  jobs: [
    { id: "job-b", repo: "owner/repo", deadline: new Date("2026-11-05T12:00:00.000Z"), workflow: "review", number: 14, posted: false, scanned: true, order: 7 },
    { id: "job-a", repo: "owner/repo", deadline: new Date("2026-11-05T11:00:00.000Z"), workflow: "implement", number: 12, posted: true, scanned: false, order: 3, label: "agent:implement" },
  ],
  asks: [
    { repo: "owner/repo", number: 12, label: "agent:implement", dispatches: 1, told: false, at: Date.parse("2026-11-05T10:00:00.000Z") },
    { repo: "owner/other", number: 5, label: "agent:fix", dispatches: 2, told: true },
  ],
};

interface Setup {
  readonly held?: HeldAnswer;
  /** The state file's text; `null` for no file. Unset, `STATE`. */
  readonly state?: string | null;
  /** service.env's lines; unset, a STATE_FILE at the mount. */
  readonly env?: readonly string[];
}

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) {
    fs.chmodSync(path.join(dir, "appdata", "state"), 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const setUp = (setup: Setup = {}): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-status-"));
  scratches.push(root);
  for (const dir of ["unraid", "bin", "calls", "appdata/state"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "unraid", "status.sh"));
  fs.writeFileSync(path.join(root, "unraid", "agent-service.conf"), `APPDATA=${root}/appdata\n`);
  fs.writeFileSync(path.join(root, "appdata", "service.env"), [...(setup.env ?? ["WORKER_URL=http://box.example:8787/jobs", "STATE_FILE=/state/dispatcher.json"]), ""].join("\n"));
  const state = setup.state === undefined ? serialiseState(STATE) : setup.state;
  if (state !== null) fs.writeFileSync(path.join(root, "appdata", "state", "dispatcher.json"), state);
  fs.writeFileSync(path.join(root, "fetch.mjs"), FAKE_FETCH);
  fs.writeFileSync(path.join(root, "held-answer.json"), JSON.stringify(setup.held ?? { status: 200, body: { jobs: [] } }));
  for (const [name, body] of Object.entries(STUBS)) {
    const stub = path.join(root, "bin", name);
    fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "${name} $*" >>"$FAKE/calls/calls"\n${body}\n`);
    fs.chmodSync(stub, 0o755);
  }
  return root;
};

const status = (root: string, args: readonly string[] = [], env: Record<string, string> = {}) => {
  const result = spawnSync("bash", [path.join(root, "unraid", "status.sh"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: SUBPROCESS_TIMEOUT,
    env: { PATH: `${path.join(root, "bin")}:${path.dirname(process.execPath)}:${process.env["PATH"] ?? ""}`, FAKE: root, ...env },
  });
  if (result.error !== undefined) throw result.error;
  const read = (name: string): string[] => {
    const file = path.join(root, "calls", name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: read("calls"), held: read("held-requests") };
};

/** Every file under `root` but the stubs' call logs, with its mode, its modification time and its text. */
const snapshot = (root: string): string[] =>
  (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.startsWith(path.join(root, "calls")))
    .sort()
    .map((file) => {
      const stat = fs.statSync(file);
      return `${file} ${stat.mode} ${stat.mtimeMs} ${stat.isFile() ? fs.readFileSync(file, "utf8") : ""}`;
    });

const HELD = { status: 200, body: { jobs: [{ id: "job-a", workflow: "implement", repo: "owner/repo", number: 12 }, { id: "job-c", workflow: "fix", repo: "owner/repo", number: 20 }] } };

describe("status.sh, what the loop is running now", () => {
  it("prints the dispatcher's state, the jobs the worker holds in order, and the state file's jobs and at-limit items", () => {
    const root = setUp({ held: HELD });
    const { status: code, output } = status(root);

    expect(code).toBe(0);
    expect(output).toContain("\n== The dispatcher\n  agent-dispatcher is running, since 2026-11-05T09:00:00.000Z\n");
    expect(output).toContain(
      "\n== The worker\n  the worker answers, and holds 2 job(s), in the order they arrived (running or queued):\n    implement on owner/repo#12, job job-a\n    fix on owner/repo#20, job job-c\n",
    );
    const file = path.join(root, "appdata", "state", "dispatcher.json");
    expect(output).toContain(
      [
        `  ${file} records 2 dispatched job(s), oldest first:`,
        "    implement on owner/repo#12, job job-a, deadline 2026-11-05T11:00:00.000Z",
        "    review on owner/repo#14, job job-b, deadline 2026-11-05T12:00:00.000Z, not yet handed to the worker",
        "  and 1 item(s) at SCAN_DISPATCH_LIMIT (2), which the scan leaves for a person:",
        "    owner/other#5, agent:fix, started 2 times, commented on",
        "",
      ].join("\n"),
    );
    expect(output).not.toContain("cannot tell");
  });

  it("asks the held door a signed read that names no instance, with the secret on no command line and in no output", () => {
    const root = setUp({ held: HELD });
    const { status: code, output, calls, held } = status(root);

    expect(code).toBe(0);
    expect(held).toHaveLength(1);
    const request = JSON.parse(held[0] ?? "{}") as { url: string; method: string; headers: Record<string, string>; body: string };
    expect(request.url).toBe("http://box.example:8787/held");
    expect(request.method).toBe("POST");
    // No `instance`: the worker drops nothing for a question that names none (#601).
    expect(Object.keys(JSON.parse(request.body) as object)).toEqual(["asked"]);
    expect(request.headers["x-signature-256"]).toBe(`sha256=${createHmac("sha256", SECRET).update(request.body).digest("hex")}`);
    expect(calls).toContain("docker exec -i agent-dispatcher node --input-type=module -");
    expect(calls.join("\n")).not.toContain(SECRET);
    expect(output).not.toContain(SECRET);
  });

  it("writes nothing and calls docker only to read", () => {
    const root = setUp({ held: HELD });
    const before = snapshot(root);
    const { status: code, calls } = status(root);

    expect(code).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(calls.filter((call) => call.startsWith("docker ")).map((call) => call.split(" ")[1])).toEqual(["inspect", "exec"]);
  });

  it("with the dispatcher stopped, says so and that the worker cannot be asked, and still reads the state file", () => {
    const root = setUp();
    const { status: code, output, calls } = status(root, [], { FAKE_CONTAINER: "exited" });

    expect(code).toBe(0);
    expect(output).toContain("  agent-dispatcher is exited, not running (it last started 2026-11-04T08:00:00.000Z)");
    expect(output).toContain("  cannot tell: the worker is asked from inside agent-dispatcher, which is not running");
    expect(output).toContain("records 2 dispatched job(s)");
    expect(calls.some((call) => call.startsWith("docker exec"))).toBe(false);
  });

  it("with no dispatcher container, says so", () => {
    const root = setUp();
    const { status: code, output } = status(root, [], { FAKE_CONTAINER: "missing" });

    expect(code).toBe(0);
    expect(output).toContain("  cannot tell: docker has no container named agent-dispatcher, or docker does not answer");
    expect(output).toContain("records 2 dispatched job(s)");
  });

  it.each<[string, HeldAnswer, string]>([
    ["unreachable", "unreachable", "  cannot tell: the worker could not be reached at http://box.example:8787/held: connect ECONNREFUSED"],
    ["refusing the signature", { status: 401, body: { refusal: "bad signature" } }, "the worker refused the question's signature (401: bad signature)"],
    ["with no held door", { status: 404, body: {} }, "  the worker answers, but has no held door"],
  ])("with the worker %s, says so and goes on", (_name, held, line) => {
    const root = setUp({ held });
    const { status: code, output } = status(root);

    expect(code).toBe(0);
    expect(output).toContain(line);
    expect(output).toContain("records 2 dispatched job(s)");
  });

  it("says the worker holds no job where it holds none", () => {
    const { output } = status(setUp());
    expect(output).toContain("  the worker answers, and holds no job\n");
  });

  it.each<[string, Setup, string]>([
    ["absent", { state: null }, "cannot tell: there is no {file} yet (the dispatcher writes it at its start)"],
    ["not a state file", { state: '{"version": 9}\n' }, "cannot tell: {file} is not a state file this script reads"],
    ["not set", { env: ["WORKER_URL=http://box.example:8787/jobs"] }, "none: {env} sets no STATE_FILE, so the dispatcher keeps its jobs and counts in memory only"],
  ])("with the state file %s, says so and still answers for the rest", (_name, setup, line) => {
    const root = setUp({ ...setup, held: HELD });
    const { status: code, output } = status(root);

    expect(code).toBe(0);
    const file = path.join(root, "appdata", "state", "dispatcher.json");
    expect(output).toContain(line.replace("{file}", file).replace("{env}", path.join(root, "appdata", "service.env")));
    expect(output).toContain("holds 2 job(s)");
  });

  it.skipIf(process.getuid?.() === 0)("with the state file unreadable, says so", () => {
    const root = setUp();
    fs.chmodSync(path.join(root, "appdata", "state", "dispatcher.json"), 0o000);
    expect(status(root).output).toContain(`cannot tell: ${path.join(root, "appdata", "state", "dispatcher.json")} cannot be read`);
    fs.chmodSync(path.join(root, "appdata", "state"), 0o000);
    const { status: code, output } = status(root);

    expect(code).toBe(0);
    expect(output).toContain(`cannot tell: ${path.join(root, "appdata", "state")}, where the state file is, cannot be read`);
  });

  it("exits 1 where no part answered, with a line for each", () => {
    const root = setUp({ state: null });
    const { status: code, output } = status(root, [], { FAKE_CONTAINER: "missing" });

    expect(code).toBe(1);
    expect(output.match(/cannot tell/g)).toHaveLength(3);
    expect(output).toContain("No part answered.");
  });

  it("lists as many of the state file's jobs and at-limit items as the count given", () => {
    const root = setUp({ held: HELD, env: ["STATE_FILE=/state/dispatcher.json", "SCAN_DISPATCH_LIMIT=1"] });
    const { status: code, output } = status(root, ["1"]);

    expect(code).toBe(0);
    expect(output).toContain("records 2 dispatched job(s), oldest first:\n    implement on owner/repo#12, job job-a, deadline 2026-11-05T11:00:00.000Z\n  and 2 item(s) at SCAN_DISPATCH_LIMIT (1)");
    expect(output).toContain("SCAN_DISPATCH_LIMIT (1), which the scan leaves for a person:\n    owner/repo#12, agent:implement, started 1 times\n");
    expect(output).not.toContain("job-b");
    expect(output).not.toContain("owner/other#5");
  });

  it.each([["--prune"], ["/etc/passwd"], ["0"], [""], ["ls -la"]])("refuses '%s', with a usage line, and does nothing", (arg) => {
    const root = setUp();
    const { status: code, output, calls } = status(root, [arg]);

    expect(code).toBe(2);
    expect(output).toContain("Usage: bash");
    expect(calls).toEqual([]);
  });

  it("refuses a second count", () => {
    const { status: code, output } = status(setUp(), ["2", "3"]);
    expect(code).toBe(2);
    expect(output).toContain("One count at a time: '2' and '3' were given.");
  });

  it("refuses to run as anyone but root", () => {
    const root = setUp();
    const { status: code, output, calls } = status(root, [], { FAKE_UID: "1000" });

    expect(code).toBe(2);
    expect(output).toContain("Run this as root on Unraid");
    expect(calls.filter((call) => call.startsWith("docker"))).toEqual([]);
  });
});
