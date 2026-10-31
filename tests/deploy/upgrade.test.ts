import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `deploy/unraid/upgrade.sh` run end to end with both machines stubbed (#575).
 *
 * The scripts are copied into a scratch directory as they would sit in
 * `/boot/config/agent-service/`, beside two stand-in check scripts that print
 * the `INFO` lines the real ones end their sections with. `curl` serves the
 * release from a folder, `scp` copies into a folder standing for the box
 * admin's home, `ssh` runs its command there with `sudo` a pass-through, and
 * `docker`, `npm`, `systemctl` and `journalctl` keep the two machines'
 * installed and running versions in files. Every stub logs its argv to one
 * calls file, which is what "neither machine was touched" is read from.
 */

const DEPLOY = path.join(import.meta.dirname, "..", "..", "deploy", "unraid");
const NAME = "@jeffwlawson/agent-workflows";
const TARBALL = "jeffwlawson-agent-workflows-1.2.3.tgz";
const INSTALLED_PATH = path.join("node_modules", ...NAME.split("/"), "package.json");

const STUBS: Record<string, string> = {
  id: `echo 0`,
  sleep: `exit 0`,
  sudo: `exec "$@"`,
  curl: `
out= url=
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
done
src="$FAKE/release/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"`,
  scp: `
files=()
while [ $# -gt 1 ]; do
  case "$1" in -o|-i) shift 2 ;; *) files+=("$1"); shift ;; esac
done
for f in "\${files[@]}"; do
  cp "$f" "$FAKE/box-home/"
  case "$f" in *.tgz) if [ -n "\${FAKE_CORRUPT_SCP:-}" ]; then echo x >>"$FAKE/box-home/$(basename "$f")"; fi ;; esac
done`,
  ssh: `HOME="$FAKE/box-home" bash -c "\${@: -1}"`,
  npm: `
prefix= tgz=
while [ $# -gt 0 ]; do
  case "$1" in --prefix) prefix=$2; shift 2 ;; -*|install) shift ;; *) tgz=$1; shift ;; esac
done
name=$(sed -n 's/.*"name": *"\\([^"]*\\)".*/\\1/p' "$tgz")
mkdir -p "$prefix/node_modules/$name" && cp "$tgz" "$prefix/node_modules/$name/package.json"`,
  docker: `
installed() { sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$FAKE/appdata/pkg/${INSTALLED_PATH}"; }
case "$1" in
  run)
    pkg= release= tgz=
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) case "$2" in *:/pkg) pkg=\${2%:/pkg} ;; *:/release:ro) release=\${2%:/release:ro} ;; esac; shift 2 ;;
        /release/*) tgz="$release/\${1#/release/}"; shift ;;
        *) shift ;;
      esac
    done
    name=$(sed -n 's/.*"name": *"\\([^"]*\\)".*/\\1/p' "$tgz")
    mkdir -p "$pkg/node_modules/$name" && cp "$tgz" "$pkg/node_modules/$name/package.json" ;;
  restart) installed >"$FAKE/state/dispatcher-running" ;;
  inspect) echo 2026-10-31T00:00:00Z ;;
  logs) echo "dispatcher $(cat "$FAKE/state/dispatcher-running") listening" ;;
esac`,
  systemctl: `
case "$1" in
  restart) sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$FAKE/opt/${INSTALLED_PATH}" >"$FAKE/state/worker-running" ;;
  show) echo invocation ;;
esac`,
  journalctl: `echo "worker $(cat "$FAKE/state/worker-running") listening"`,
};

const CHECK_UNRAID = `#!/usr/bin/env bash
echo "  INFO  dispatcher version: $(cat "$FAKE/state/dispatcher-running") (the box's check prints the worker's: they must match)"
echo "  INFO  shared secret fingerprint: \${FAKE_FP_UNRAID:-0123456789abcdef} (the box's check prints its own: they must match)"
exit "\${FAKE_CHECK_UNRAID_STATUS:-0}"
`;
// Through ssh -t, the box's lines arrive ending in a carriage return.
const CHECK_BOX = `#!/usr/bin/env bash
printf '  INFO  worker version: %s (check-unraid.sh prints the other)\\r\\n' "\${FAKE_BOX_VERSION:-$(cat "$FAKE/state/worker-running")}"
printf '  INFO  shared secret fingerprint: %s (check-unraid.sh prints its own: they must match)\\r\\n' "\${FAKE_FP_BOX:-0123456789abcdef}"
`;

const pkgJson = (version: string, extra = ""): string =>
  `{\n  "name": "${NAME}",\n  "version": "${version}",${extra}\n  "type": "module"\n}\n`;

interface Setup {
  readonly conf?: string;
  readonly installedExtra?: string;
  readonly digest?: string;
}

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const setUp = (setup: Setup = {}): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-upgrade-"));
  scratches.push(root);
  for (const dir of ["unraid", "box-home", "bin", "state", "release", "stage", "opt", "home"]) {
    fs.mkdirSync(path.join(root, dir));
  }
  for (const script of ["upgrade.sh", "upgrade-unraid.sh", "upgrade-box.sh"]) {
    fs.copyFileSync(path.join(DEPLOY, script), path.join(root, "unraid", script));
  }
  fs.writeFileSync(path.join(root, "unraid", "check-unraid.sh"), CHECK_UNRAID);
  fs.writeFileSync(path.join(root, "unraid", "check-box.sh"), CHECK_BOX);
  fs.writeFileSync(
    path.join(root, "unraid", "agent-service.conf"),
    [
      `APPDATA=${root}/appdata`,
      `PREFIX=${root}/opt`,
      `STAGE_DIR=${root}/stage`,
      `BOX_IP=box.example`,
      `BOX_SSH_USER=admin`,
      setup.conf ?? `PACKAGE_SOURCE=owner/repo`,
      "",
    ].join("\n"),
  );
  for (const [name, body] of Object.entries(STUBS)) {
    const stub = path.join(root, "bin", name);
    fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "${name} $*" >>"$FAKE/state/calls"\n${body}\n`);
    fs.chmodSync(stub, 0o755);
  }
  for (const prefix of ["appdata/pkg", "opt"]) {
    const installed = path.join(root, prefix, INSTALLED_PATH);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, pkgJson("1.2.2", setup.installedExtra ?? ""));
  }
  // The dispatcher's install prefix, whose one dependency is the package.
  fs.writeFileSync(path.join(root, "appdata", "pkg", "package.json"), `{\n  "dependencies": {\n    "${NAME}": "1.2.2"\n  }\n}\n`);
  fs.writeFileSync(path.join(root, "state", "dispatcher-running"), "1.2.2\n");
  fs.writeFileSync(path.join(root, "state", "worker-running"), "1.2.2\n");
  const tarball = pkgJson("1.2.3");
  fs.writeFileSync(path.join(root, "release", TARBALL), tarball);
  const digest = setup.digest ?? createHash("sha256").update(tarball).digest("hex");
  fs.writeFileSync(path.join(root, "release", `${TARBALL}.sha256`), `${digest}  ${TARBALL}\n`);
  return root;
};

const run = (root: string, env: Record<string, string> = {}) => {
  const result = spawnSync("bash", [path.join(root, "unraid", "upgrade.sh"), "1.2.3"], {
    encoding: "utf8",
    input: "",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`,
      HOME: path.join(root, "home"),
      FAKE: root,
      ...env,
    },
  });
  if (result.error !== undefined) throw result.error;
  const callsFile = path.join(root, "state", "calls");
  const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n") : [];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
};

const running = (root: string, machine: "dispatcher" | "worker"): string =>
  fs.readFileSync(path.join(root, "state", `${machine}-running`), "utf8").trim();
const installed = (root: string, prefix: string): string =>
  fs.readFileSync(path.join(root, prefix, INSTALLED_PATH), "utf8").match(/"version": "([^"]*)"/)?.[1] ?? "";

/** What changes a machine: an install or a restart on either. */
const touches = (calls: readonly string[]): string[] =>
  calls.filter((call) => /^(npm|systemctl restart|docker (run|restart))/.test(call));

describe("upgrade.sh", () => {
  it("moves both machines to the version from the release's tarball, with no token", () => {
    const root = setUp();
    const { status, output, calls } = run(root);

    expect(output).toContain("Both machines run 1.2.3 and share the secret.");
    expect(status).toBe(0);
    expect(output).not.toMatch(/token/i);
    expect(calls.filter((call) => call.startsWith("curl")).map((call) => call.split(" ").at(-1))).toEqual([
      `https://github.com/owner/repo/releases/download/v1.2.3/${TARBALL}`,
      `https://github.com/owner/repo/releases/download/v1.2.3/${TARBALL}.sha256`,
    ]);
    expect([installed(root, "appdata/pkg"), installed(root, "opt")]).toEqual(["1.2.3", "1.2.3"]);
    expect([running(root, "dispatcher"), running(root, "worker")]).toEqual(["1.2.3", "1.2.3"]);
    // Both installs, then the worker's restart, then the dispatcher's.
    expect(touches(calls).map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
      "npm install",
      "docker run",
      "systemctl restart",
      "docker restart",
    ]);
    // The staging directory under STAGE_DIR is removed however the run ends.
    expect(fs.readdirSync(path.join(root, "stage"))).toEqual([]);
  });

  it("says the worker's restart drops its queue, and how long the 409 window lasted", () => {
    const { output } = run(setUp());

    expect(output).toContain("Restarting the worker drops any job queued in it: its queue is in memory.");
    expect(output).toMatch(/the dispatcher got 409 from the worker, for about \d+ seconds/);
  });

  it("reaches the box with host keys beside the conf, accept-new, and nothing under ~/.ssh", () => {
    const { status, calls } = run(setUp());
    expect(status).toBe(0);

    const remote = calls.filter((call) => /^(ssh|scp) /.test(call));
    expect(remote.length).toBeGreaterThan(0);
    for (const call of remote) {
      expect(call).toContain(`-o UserKnownHostsFile=`);
      expect(call).toMatch(/UserKnownHostsFile=\S+\/unraid\/known_hosts /);
      expect(call).toContain("-o StrictHostKeyChecking=accept-new");
      expect(call).not.toContain(".ssh");
      expect(call).not.toContain("StrictHostKeyChecking=no");
      expect(call).toContain("admin@box.example");
    }
    expect(remote.filter((call) => call.startsWith("ssh ")).every((call) => call.includes(" -t "))).toBe(true);
  });

  it("passes the key BOX_SSH_KEY names to every ssh and scp", () => {
    const root = setUp({ conf: `PACKAGE_SOURCE=owner/repo\nBOX_SSH_KEY=${DEPLOY}/upgrade.sh` });
    const { status, calls } = run(root);

    expect(status).toBe(0);
    const remote = calls.filter((call) => /^(ssh|scp) /.test(call));
    expect(remote.every((call) => call.includes(`-i ${DEPLOY}/upgrade.sh`))).toBe(true);
  });

  it("stops before either machine is touched when the tarball does not match its .sha256", () => {
    const root = setUp({ digest: "0".repeat(64) });
    const { status, output, calls } = run(root);

    expect(status).not.toBe(0);
    expect(output).toContain("does not match its .sha256");
    expect(output).toContain("Nothing was changed on either machine.");
    expect(calls.filter((call) => /^(ssh|scp) /.test(call))).toEqual([]);
    expect(touches(calls)).toEqual([]);
  });

  it("stops before either machine is touched when the tarball arrives on the box changed", () => {
    const root = setUp();
    const { status, output, calls } = run(root, { FAKE_CORRUPT_SCP: "1" });

    expect(status).not.toBe(0);
    expect(output).toContain(`${TARBALL} does not match its .sha256. Nothing was changed.`);
    expect(touches(calls)).toEqual([]);
    expect([installed(root, "appdata/pkg"), installed(root, "opt")]).toEqual(["1.2.2", "1.2.2"]);
  });

  it("refuses, naming PACKAGE_SOURCE, when neither it nor the installed package names the repository", () => {
    const root = setUp({ conf: "" });
    const { status, output, calls } = run(root);

    expect(status).toBe(2);
    expect(output).toContain("set PACKAGE_SOURCE=<owner>/<repo>");
    expect(output).toContain("Nothing was changed on either machine.");
    expect(calls).toEqual(["id -u"]);
  });

  it.each([
    ['"repository": "github:owner/repo",'],
    ['"repository": { "type": "git", "url": "git+https://github.com/owner/repo.git" },'],
  ])("reads the repository from the installed package where PACKAGE_SOURCE is unset: %s", (field) => {
    const root = setUp({ conf: "", installedExtra: `\n  ${field}` });
    const { status, calls } = run(root);

    expect(status).toBe(0);
    expect(calls.find((call) => call.startsWith("curl"))).toMatch(
      new RegExp(`https://github\\.com/owner/repo/releases/download/v1\\.2\\.3/${TARBALL}$`),
    );
  });

  it("refuses a repository that is not on github.com", () => {
    const root = setUp({ conf: "", installedExtra: `\n  "repository": "https://gitlab.com/owner/repo",` });
    const { status, output, calls } = run(root);

    expect(status).toBe(2);
    expect(output).toContain("PACKAGE_SOURCE");
    expect(calls).toEqual(["id -u"]);
  });

  it("refuses without BOX_SSH_USER, naming it", () => {
    const root = setUp();
    const conf = path.join(root, "unraid", "agent-service.conf");
    fs.writeFileSync(conf, fs.readFileSync(conf, "utf8").replace("BOX_SSH_USER=admin\n", ""));
    const { status, output, calls } = run(root);

    expect(status).toBe(2);
    expect(output).toContain("Set BOX_SSH_USER");
    expect(calls).toEqual(["id -u"]);
  });

  it("exits non-zero, printing both, when the two machines report different versions", () => {
    const { status, output } = run(setUp(), { FAKE_BOX_VERSION: "1.2.2" });

    expect(status).toBe(1);
    expect(output).toContain("dispatcher version:        1.2.3");
    expect(output).toContain("worker version:            1.2.2");
    expect(output.trim().split("\n").at(-1)).toMatch(/^FAILED: the dispatcher runs 1\.2\.3 and the worker 1\.2\.2/);
  });

  it("exits non-zero, printing both, when the shared secret's fingerprints differ", () => {
    const { status, output } = run(setUp(), { FAKE_FP_BOX: "fedcba9876543210" });

    expect(status).toBe(1);
    expect(output).toContain("FAILED: the shared secret's fingerprints differ (0123456789abcdef on Unraid, fedcba9876543210 on the box).");
  });

  it("fails the run when a check script fails, though versions and fingerprints match", () => {
    const { status, output } = run(setUp(), { FAKE_CHECK_UNRAID_STATUS: "1" });

    expect(status).toBe(1);
    expect(output).toContain("FAILED: a restart or a check failed");
  });
});

describe("the deploy scripts", () => {
  const scripts = fs.readdirSync(DEPLOY).filter((file) => file.endsWith(".sh"));

  it("use no registry token outside the install scripts", () => {
    const upgrades = scripts.filter((file) => !file.startsWith("install-"));
    expect(upgrades).toContain("upgrade.sh");
    for (const file of upgrades) {
      const text = fs.readFileSync(path.join(DEPLOY, file), "utf8");
      for (const word of ["read:packages", "_authToken", "npm.pkg.github.com"]) {
        expect(text, `${file} names ${word}`).not.toContain(word);
      }
    }
  });

  it("name no owner, address or account in the orchestrator", () => {
    const text = fs.readFileSync(path.join(DEPLOY, "upgrade.sh"), "utf8");
    const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(text).not.toContain("jeffwlawson");
  });
});
