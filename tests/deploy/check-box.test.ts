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
 * `dpkg-query` answers that a package is installed where it is named in
 * `FAKE_INSTALLED`, for the operator's BOX_EXTRA_PACKAGES (#820).
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
  "dpkg-query": `
package=\${*: -1}
case " \${FAKE_INSTALLED:-} " in *" $package "*) printf 'install ok installed' ;; *) echo "dpkg-query: no packages found matching $package" >&2; exit 1 ;; esac`,
};

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const setUp = (conf: readonly string[] = []): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-check-box-"));
  scratches.push(root);
  for (const dir of ["unraid", "bin", "work"]) fs.mkdirSync(path.join(root, dir));
  fs.copyFileSync(path.join(DEPLOY, "check-box.sh"), path.join(root, "unraid", "check-box.sh"));
  fs.writeFileSync(
    path.join(root, "unraid", "agent-service.conf"),
    [`NODE=${process.execPath}`, `ENV_FILE=${root}/worker.env`, `WORK_DIR=${root}/work`, `PREFIX=${root}/opt`, `TINYPROXY_CONF=${root}/tinyproxy.conf`, ...conf, ""].join("\n"),
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

describe("check-box.sh, against the operator's settings for every repository (#820)", () => {
  const BASE = ["api.anthropic.com", "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com", "registry.npmjs.org", "mise-versions.jdx.dev", "192.168.250.1"];
  const line = (host: string) => `^${host.replaceAll(".", "\\.")}$`;
  /** A box whose tinyproxy filters through a list holding `hosts`. */
  const withAllowlist = (conf: readonly string[], hosts: readonly string[]): string => {
    const root = setUp(conf);
    fs.writeFileSync(path.join(root, "tinyproxy.conf"), `Filter "${root}/allowlist"\n`);
    fs.writeFileSync(path.join(root, "allowlist"), `${hosts.map(line).join("\n")}\n`);
    return root;
  };

  it("fails for a package BOX_EXTRA_PACKAGES names that is not installed, naming it, and passes for one that is", () => {
    const { status, output } = checkBox(setUp(['BOX_EXTRA_PACKAGES="libpq-dev libssl-dev"']), { FAKE_INSTALLED: "libssl-dev" });

    expect(status).toBe(1);
    expect(output).toContain("  FAIL  libpq-dev, which BOX_EXTRA_PACKAGES names, is not installed: re-run install-box.sh\n");
    expect(output).toContain("  PASS  libssl-dev is installed (BOX_EXTRA_PACKAGES)\n");
  });

  it("passes where every package BOX_EXTRA_PACKAGES names is installed", () => {
    const { output } = checkBox(setUp(['BOX_EXTRA_PACKAGES="libpq-dev"']), { FAKE_INSTALLED: "libpq-dev" });

    expect(output).toContain("  PASS  libpq-dev is installed (BOX_EXTRA_PACKAGES)\n");
    expect(output).not.toMatch(/FAIL .*BOX_EXTRA_PACKAGES/);
  });

  it("fails for each host EGRESS_PRESETS and EGRESS_EXTRA_HOSTS ask for that the live list lacks, naming it", () => {
    const root = withAllowlist(['EGRESS_PRESETS="python"', 'EGRESS_EXTRA_HOSTS="example.org"'], [...BASE, "pypi.org"]);
    const { status, output } = checkBox(root);

    expect(status).toBe(1);
    expect(output).toContain(`  PASS  it allows ^pypi\\.org$\n`);
    expect(output).toContain(`  FAIL  its list in ${root}/allowlist lacks ^files\\.pythonhosted\\.org$: re-run install-box.sh\n`);
    expect(output).toContain(`  FAIL  its list in ${root}/allowlist lacks ^example\\.org$: re-run install-box.sh\n`);
  });

  it("passes where the live list holds every host they ask for", () => {
    const root = withAllowlist(['EGRESS_PRESETS="python"', 'EGRESS_EXTRA_HOSTS="example.org"'], [...BASE, "pypi.org", "files.pythonhosted.org", "example.org"]);
    const { output } = checkBox(root);

    for (const host of [...BASE, "pypi.org", "files.pythonhosted.org", "example.org"]) expect(output).toContain(`  PASS  it allows ${line(host)}\n`);
    expect(output).not.toContain("lacks");
  });

  it("fails for an unknown preset, naming it", () => {
    const { output } = checkBox(withAllowlist(['EGRESS_PRESETS="pyhton"'], BASE));

    expect(output).toContain("  FAIL  EGRESS_PRESETS names 'pyhton', which is no preset (the presets are: node python): install-box.sh refuses it\n");
  });
});

describe("check-box.sh's mise (#822)", () => {
  const VERSION = /^MISE_VERSION=\$\{MISE_VERSION:-([^}]+)\}$/m.exec(fs.readFileSync(path.join(DEPLOY, "check-box.sh"), "utf8"))?.[1] ?? "";
  /** A box whose mise answers `version`, or that has none. */
  const withMise = (version?: string): string => {
    const root = setUp([`MISE=${path.join(os.tmpdir(), "no-such-dir", "mise")}`]);
    if (version === undefined) return root;
    const mise = path.join(root, "mise");
    fs.writeFileSync(mise, `#!/usr/bin/env bash\necho '${version} linux-x64 (2025-10-01)'\n`);
    fs.chmodSync(mise, 0o755);
    fs.appendFileSync(path.join(root, "unraid", "agent-service.conf"), `MISE=${mise}\n`);
    return root;
  };

  it("fails where mise is missing, saying to re-run install-box.sh", () => {
    const { status, output } = checkBox(withMise());

    expect(status).toBe(1);
    expect(output).toMatch(/ {2}FAIL {2}mise at \S+ is missing, not [\d.]+, so a repository's mise\.toml cannot be installed: re-run install-box\.sh\n/);
  });

  it("fails where mise is not at the pinned version, naming both", () => {
    const { status, output } = checkBox(withMise("2024.1.0"));

    expect(status).toBe(1);
    expect(output).toContain(`is 2024.1.0, not ${VERSION}, so a repository's mise.toml cannot be installed: re-run install-box.sh`);
  });

  it("passes where mise is at the pinned version", () => {
    const { output } = checkBox(withMise(VERSION));

    expect(output).toContain(`  PASS  mise is ${VERSION}\n`);
    expect(output).not.toMatch(/FAIL .*mise/);
  });
});
