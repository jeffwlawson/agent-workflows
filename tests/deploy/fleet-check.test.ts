import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `deploy/unraid/fleet-check.sh`, doctor for every repository the service
 * serves (#825), run with Unraid stubbed, as `tests/deploy/status.test.ts`
 * runs `status.sh`. The script is copied into a scratch directory beside an
 * `agent-service.conf` naming the container. `id` answers root, and `docker`
 * answers `inspect` from `FAKE_CONTAINER` and `exec` with the check's lines
 * and `FAKE_CODE`, as the subcommand in the container would. Every stub call
 * is logged to `calls`. The container's environment holds the App's key and
 * the shared secret, and nothing the script prints or runs may carry them.
 */

const SCRIPT = path.join(import.meta.dirname, "..", "..", "deploy", "unraid", "fleet-check.sh");
const CONTAINER_SCRIPT = path.join(import.meta.dirname, "..", "..", "deploy", "unraid", "dispatcher-container.sh");
const SECRET = "the-shared-secret-0123456789";

const STUBS: Record<string, string> = {
  id: `echo "\${FAKE_UID:-0}"`,
  docker: `
case "$1" in
  inspect)
    case "\${FAKE_CONTAINER:-running}" in
      running) echo "running" ;;
      exited) echo "exited" ;;
      *) echo "Error: No such object: $4" >&2; exit 1 ;;
    esac ;;
  exec)
    echo "agent-workflows 0.9.20: fleet-check"
    echo "owner/repo: ok"
    exit "\${FAKE_CODE:-0}" ;;
  *) echo "docker: not a read: $*" >&2; exit 1 ;;
esac`,
};

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const setUp = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-fleet-check-"));
  scratches.push(root);
  for (const dir of ["unraid", "bin", "appdata"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "unraid", "fleet-check.sh"));
  fs.writeFileSync(path.join(root, "unraid", "agent-service.conf"), `APPDATA=${root}/appdata\nCONTAINER=the-dispatcher\n`);
  fs.writeFileSync(path.join(root, "appdata", "service.env"), `GITHUB_APP_PRIVATE_KEY_FILE=/app/app.pem\nWORKER_SECRET=${SECRET}\n`);
  for (const [name, body] of Object.entries(STUBS)) {
    const stub = path.join(root, "bin", name);
    fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "${name} $*" >>"$FAKE/calls"\n${body}\n`);
    fs.chmodSync(stub, 0o755);
  }
  return root;
};

const check = (root: string, args: readonly string[] = [], env: Record<string, string> = {}) => {
  const result = spawnSync("bash", [path.join(root, "unraid", "fleet-check.sh"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: SUBPROCESS_TIMEOUT,
    env: { PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: root, ...env },
  });
  if (result.error !== undefined) throw result.error;
  const log = path.join(root, "calls");
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}`, calls };
};

describe("fleet-check.sh, doctor for every repository the service serves (#825)", () => {
  it("runs the subcommand in the dispatcher's container with the CLI it runs, and prints the check's lines", () => {
    const root = setUp();
    const { status, stdout, calls } = check(root);

    expect(status).toBe(0);
    expect(stdout).toBe("agent-workflows 0.9.20: fleet-check\nowner/repo: ok\n");
    expect(calls).toEqual([
      "id -u",
      "docker inspect -f {{.State.Status}} the-dispatcher",
      "docker exec the-dispatcher node /app/pkg/node_modules/@jeffwlawson/agent-workflows/dist/cli.js fleet-check",
    ]);
  });

  it("names the CLI the dispatcher's container is started with", () => {
    const started = /^dispatcher_cmd="node (\S+) dispatcher"$/m.exec(fs.readFileSync(CONTAINER_SCRIPT, "utf8"))?.[1];
    const named = /^CLI=(\S+)$/m.exec(fs.readFileSync(SCRIPT, "utf8"))?.[1];

    expect(started).toBeDefined();
    expect(named).toBe(started);
  });

  it("prints no secret and puts none on a command line", () => {
    const root = setUp();
    const { output, calls } = check(root);

    expect(output).not.toContain(SECRET);
    expect(calls.join("\n")).not.toContain(SECRET);
    expect(calls.join("\n")).not.toContain("app.pem");
  });

  it("exits 1 where the check found an error or a repository it could not read", () => {
    const { status } = check(setUp(), [], { FAKE_CODE: "1" });

    expect(status).toBe(1);
  });

  it("exits 1, saying so, where the check could not be run in the container", () => {
    const { status, output } = check(setUp(), [], { FAKE_CODE: "126" });

    expect(status).toBe(1);
    expect(output).toContain("The check could not be run in the-dispatcher (it ended with 126)");
  });

  it.each([
    ["exited", "the-dispatcher is exited, not running"],
    ["missing", "docker has no container named the-dispatcher"],
  ])("with the container %s, says so, exits 1 and runs nothing in it", (container, said) => {
    const { status, output, calls } = check(setUp(), [], { FAKE_CONTAINER: container });

    expect(status).toBe(1);
    expect(output).toContain(said);
    expect(calls.filter((call) => call.startsWith("docker exec"))).toEqual([]);
  });

  it.each([["owner/repo"], ["--now"], [""]])("refuses an argument, %j, with 2, and runs nothing", (arg) => {
    const { status, output, calls } = check(setUp(), [arg]);

    expect(status).toBe(2);
    expect(output).toContain("fleet-check.sh takes no argument");
    expect(calls).toEqual([]);
  });

  it("refuses to run as anyone but root, with 2", () => {
    const { status, output, calls } = check(setUp(), [], { FAKE_UID: "1000" });

    expect(status).toBe(2);
    expect(output).toContain("Run this as root on Unraid");
    expect(calls).toEqual(["id -u"]);
  });
});
