import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `deploy/unraid/check-box.sh` run with the box stubbed. The script is copied
 * into a scratch directory beside an `agent-service.conf` pointing its paths
 * into it, and every command that would read the real machine or the network
 * (`id`, `runuser`, `find`, `nft`, `systemctl`, `journalctl`, `curl`) answers
 * from a stub. `python3` is a stub too: it answers the ensurepip probe from
 * `FAKE_ENSUREPIP`, standing for a box with or without python3-venv (#818).
 */

const DEPLOY = path.join(import.meta.dirname, "..", "..", "deploy", "unraid");

const STUBS: Record<string, string> = {
  id: `echo 0`,
  runuser: `exit 1`,
  find: `exit 0`,
  nft: `exit 1`,
  systemctl: `exit 1`,
  journalctl: `exit 0`,
  curl: `printf 000`,
  python3: `
if [ "$1" = -c ] && [ "$2" = "import ensurepip" ]; then
  if [ "\${FAKE_ENSUREPIP:-}" = yes ]; then exit 0; fi
  echo "ModuleNotFoundError: No module named 'ensurepip'" >&2; exit 1
fi
echo "python3: unexpected $*" >&2; exit 2`,
};

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const setUp = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-check-box-"));
  scratches.push(root);
  for (const dir of ["unraid", "bin", "work"]) fs.mkdirSync(path.join(root, dir));
  fs.copyFileSync(path.join(DEPLOY, "check-box.sh"), path.join(root, "unraid", "check-box.sh"));
  fs.writeFileSync(
    path.join(root, "unraid", "agent-service.conf"),
    [`NODE=${process.execPath}`, `ENV_FILE=${root}/worker.env`, `WORK_DIR=${root}/work`, `PREFIX=${root}/opt`, `TINYPROXY_CONF=${root}/tinyproxy.conf`, ""].join("\n"),
  );
  for (const [name, body] of Object.entries(STUBS)) {
    const stub = path.join(root, "bin", name);
    fs.writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(stub, 0o755);
  }
  return root;
};

const checkBox = (root: string, env: Record<string, string> = {}) => {
  const result = spawnSync("bash", [path.join(root, "unraid", "check-box.sh")], {
    encoding: "utf8",
    input: "",
    timeout: SUBPROCESS_TIMEOUT,
    env: { PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: root, ...env },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

describe("check-box.sh, whether the box can build a Python repository's virtualenv (#818)", () => {
  it("fails without ensurepip, naming python3-venv and the install that fixes it", () => {
    const { status, output } = checkBox(setUp());

    expect(status).toBe(1);
    expect(output).toContain("  FAIL  python3 cannot build a virtualenv, so a Python repository's setup fails: install python3-venv with: sudo apt-get install -y python3-venv\n");
    expect(output).not.toContain("PASS  python3");
  });

  it("passes where python3 -m venv would work", () => {
    const { output } = checkBox(setUp(), { FAKE_ENSUREPIP: "yes" });

    expect(output).toContain("  PASS  python3 can build a virtualenv (ensurepip is installed)\n");
    expect(output).not.toContain("python3-venv");
  });
});

describe("the box's packages", () => {
  it("are installed by install-box.sh, python3-venv among them, and by no upgrade", () => {
    const install = fs.readFileSync(path.join(DEPLOY, "install-box.sh"), "utf8");
    const upgrade = fs.readFileSync(path.join(DEPLOY, "upgrade-box.sh"), "utf8");

    expect(install).toMatch(/^apt-get install -y -qq [^\n]*\bpython3-venv\b/m);
    expect(upgrade).not.toMatch(/\bapt(-get)?\b|\bdpkg\b/);
  });
});
