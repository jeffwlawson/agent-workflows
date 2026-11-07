import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";

/**
 * `deploy/unraid/install-box.sh` and the operator's settings for every
 * repository on the box (#820): BOX_EXTRA_PACKAGES, EGRESS_PRESETS and
 * EGRESS_EXTRA_HOSTS.
 *
 * The script writes under /etc and /usr/local, so it cannot run whole here. A
 * refusal ends it before it changes anything, so the refusals run the script
 * as it stands. What it installs and writes is read from the script with the
 * sections between its checks and its packages (the terminal it asks secrets
 * at) and between its packages and tinyproxy taken out, and with tinyproxy's
 * folder moved into a scratch directory. `id`, `apt-get`, `chown` and
 * `systemctl` are stubs that log their argv to one calls file.
 */

const DEPLOY = path.join(import.meta.dirname, "..", "..", "deploy", "unraid");
const SCRIPT = fs.readFileSync(path.join(DEPLOY, "install-box.sh"), "utf8");

const STUBS: Record<string, string> = { id: "echo 0", "apt-get": "", chown: "", systemctl: "" };

/** The list install-box.sh writes, with HOST_IP at its default: v0.9.18's, and mise's version list (#822). */
const BASE_ALLOWLIST = [
  "^api\\.anthropic\\.com$",
  "^github\\.com$",
  "^api\\.github\\.com$",
  "^codeload\\.github\\.com$",
  "^objects\\.githubusercontent\\.com$",
  "^raw\\.githubusercontent\\.com$",
  "^release-assets\\.githubusercontent\\.com$",
  "^registry\\.npmjs\\.org$",
  "^mise-versions\\.jdx\\.dev$",
  "^192\\.168\\.250\\.1$",
];
const BASE_INSTALL = "apt-get install -y -qq bubblewrap tinyproxy nftables git curl ca-certificates xz-utils python3-venv";

const between = (text: string, from: string, to: string): [number, number] => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  expect(start, from).toBeGreaterThan(-1);
  expect(end, to).toBeGreaterThan(start);
  return [start, end];
};

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const setUp = (conf: readonly string[]): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-install-box-"));
  scratches.push(root);
  for (const dir of ["unraid", "bin", "state"]) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, "unraid", "check-box.sh"), "exit 0\n");
  fs.writeFileSync(path.join(root, "unraid", "agent-service.conf"), ["PACKAGE_SOURCE=owner/repo", ...conf, ""].join("\n"));
  for (const [name, body] of Object.entries(STUBS)) {
    const stub = path.join(root, "bin", name);
    fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "${name} $*" >>"$FAKE/state/calls"\n${body}\n`);
    fs.chmodSync(stub, 0o755);
  }
  return root;
};

const run = (root: string, script: string) => {
  const file = path.join(root, "unraid", "install-box.sh");
  fs.writeFileSync(file, script);
  const result = spawnSync("bash", [file, "1.2.3"], {
    encoding: "utf8",
    input: "",
    timeout: SUBPROCESS_TIMEOUT,
    env: { PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: root },
  });
  if (result.error !== undefined) throw result.error;
  const callsFile = path.join(root, "state", "calls");
  const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n") : [];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
};

/** The script's checks, its packages and its tinyproxy, writing tinyproxy's files into `root`. */
const install = (conf: readonly string[] = []) => {
  const root = setUp(conf);
  const [ttyStart, ttyEnd] = between(SCRIPT, "if ! : </dev/tty", "stamp=$(date");
  const [nodeStart, nodeEnd] = between(SCRIPT, 'echo "== Node', 'echo "== tinyproxy"');
  const [packageStart] = between(SCRIPT, 'echo "== The package"', "exit ");
  const script = [SCRIPT.slice(0, ttyStart), SCRIPT.slice(ttyEnd, nodeStart), SCRIPT.slice(nodeEnd, packageStart)]
    .join("")
    .replaceAll("/etc/tinyproxy/", `${root}/etc/tinyproxy/`);
  const result = run(root, script);
  const allowlist = path.join(root, "etc", "tinyproxy", "allowlist");
  return { ...result, allowlist: fs.existsSync(allowlist) ? fs.readFileSync(allowlist, "utf8").split("\n").slice(0, -1) : [] };
};

/** The script whole, which a refusal ends before it changes anything. */
const refuse = (conf: readonly string[]) => {
  const root = setUp(conf);
  return run(root, SCRIPT);
};

const installs = (calls: readonly string[]): string[] => calls.filter((call) => call.startsWith("apt-get install"));

describe("install-box.sh, with none of the operator's settings for every repository", () => {
  it("installs the base packages and writes the base allowlist, as before #820", () => {
    const { status, output, calls, allowlist } = install();

    expect(output).not.toContain("Nothing was changed");
    expect(status).toBe(0);
    expect(installs(calls)).toEqual([BASE_INSTALL]);
    expect(allowlist).toEqual(BASE_ALLOWLIST);
  });

  it("does the same where all three are set empty", () => {
    const { status, calls, allowlist } = install(['BOX_EXTRA_PACKAGES=""', 'EGRESS_PRESETS=""', 'EGRESS_EXTRA_HOSTS=""']);

    expect(status).toBe(0);
    expect(installs(calls)).toEqual([BASE_INSTALL]);
    expect(allowlist).toEqual(BASE_ALLOWLIST);
  });
});

describe("install-box.sh's BOX_EXTRA_PACKAGES", () => {
  it("installs the packages it names after the base", () => {
    const { status, output, calls } = install(['BOX_EXTRA_PACKAGES="libpq-dev  libssl-dev"']);

    expect(status).toBe(0);
    expect(installs(calls)).toEqual([BASE_INSTALL, "apt-get install -y -qq libpq-dev libssl-dev"]);
    expect(output).toContain("ensured    libpq-dev libssl-dev are installed (BOX_EXTRA_PACKAGES)");
  });

  it.each(["-y", "lib pq;", "LibPQ"])("refuses %j before changing anything, naming it", (name) => {
    const { status, output, calls } = refuse([`BOX_EXTRA_PACKAGES='${name}'`]);

    expect(status).toBe(2);
    expect(output).toContain("Nothing was changed.");
    expect(output).toMatch(/BOX_EXTRA_PACKAGES names '[^']*', which is not an apt package name/);
    expect(calls.filter((call) => !call.startsWith("id "))).toEqual([]);
  });
});

describe("install-box.sh's EGRESS_PRESETS and EGRESS_EXTRA_HOSTS", () => {
  it("adds the python preset's hosts beside the base, anchored and escaped", () => {
    const { status, allowlist } = install(['EGRESS_PRESETS="python"']);

    expect(status).toBe(0);
    expect(allowlist).toEqual([...BASE_ALLOWLIST, "^pypi\\.org$", "^files\\.pythonhosted\\.org$"]);
  });

  it("adds the node preset's host, nodejs.org, and leaves the python preset as it was (#822)", () => {
    expect(install(['EGRESS_PRESETS="node"']).allowlist).toEqual([...BASE_ALLOWLIST, "^nodejs\\.org$"]);
    expect(install(['EGRESS_PRESETS="python node"']).allowlist).toEqual([...BASE_ALLOWLIST, "^pypi\\.org$", "^files\\.pythonhosted\\.org$", "^nodejs\\.org$"]);
  });

  it("lets mise's version list through on every box, with no preset (#822)", () => {
    expect(install().allowlist).toContain("^mise-versions\\.jdx\\.dev$");
  });

  it("adds an extra host as an exact match", () => {
    const { status, allowlist } = install(['EGRESS_EXTRA_HOSTS="example.org"']);

    expect(status).toBe(0);
    expect(allowlist).toEqual([...BASE_ALLOWLIST, "^example\\.org$"]);
  });

  it("writes each host once, however many times the settings and the base name it", () => {
    const { status, allowlist } = install(['EGRESS_PRESETS="python python"', 'EGRESS_EXTRA_HOSTS="pypi.org github.com example.org example.org"']);

    expect(status).toBe(0);
    expect(allowlist).toEqual([...BASE_ALLOWLIST, "^pypi\\.org$", "^example\\.org$", "^files\\.pythonhosted\\.org$"]);
  });

  it("refuses an unknown preset before changing anything, naming it and the known presets", () => {
    const { status, output, calls } = refuse(['EGRESS_PRESETS="python pyhton"']);

    expect(status).toBe(2);
    expect(output).toContain("EGRESS_PRESETS names 'pyhton', which is no preset; the presets are: node python. Nothing was changed.");
    expect(calls.filter((call) => !call.startsWith("id "))).toEqual([]);
  });

  it.each(["https://example.org", "*.example.org", "example.org/simple", "example.org:443", "^example\\.org$"])(
    "refuses the extra host %j before changing anything, naming it",
    (host) => {
      const { status, output, calls } = refuse([`EGRESS_EXTRA_HOSTS='${host}'`]);

      expect(status).toBe(2);
      expect(output).toContain(`EGRESS_EXTRA_HOSTS names '${host}', which is not a plain host name`);
      expect(output).toContain("Nothing was changed.");
      expect(calls.filter((call) => !call.startsWith("id "))).toEqual([]);
    },
  );

  it("are defined in install-box.sh and repeated, the same, in check-box.sh, which is copied alone", () => {
    const presets = (text: string) => /^declare -A EGRESS_PRESET_HOSTS=\(\n[\s\S]*?^\)$/m.exec(text)?.[0];
    const install = presets(SCRIPT);
    expect(install).toContain('[python]="pypi.org files.pythonhosted.org"');
    expect(install).toContain('[node]="nodejs.org"');
    expect(presets(fs.readFileSync(path.join(DEPLOY, "check-box.sh"), "utf8"))).toBe(install);
  });
});

describe("install-box.sh's mise (#822)", () => {
  const VERSION = /^MISE_VERSION=\$\{MISE_VERSION:-([^}]+)\}$/m.exec(SCRIPT)?.[1] ?? "";
  const ASSET = `mise-v${VERSION}-linux-x64`;
  const BINARY = "#!/usr/bin/env bash\necho 'the release binary'\n";

  /**
   * The script's mise section alone, with /usr/local/bin/mise moved into
   * `root`, and `curl` and `install` stubbed: `curl` answers from
   * `root/release`, which holds what the release would, and logs each URL.
   */
  const installMise = (release: Readonly<Record<string, string>>, have?: string) => {
    const root = setUp([]);
    fs.mkdirSync(path.join(root, "release"));
    for (const [name, content] of Object.entries(release)) fs.writeFileSync(path.join(root, "release", name), content);
    const stub = (name: string, body: string): void => {
      fs.writeFileSync(path.join(root, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
      fs.chmodSync(path.join(root, "bin", name), 0o755);
    };
    stub(
      "curl",
      'out=; for a in "$@"; do if [ "$prev" = -o ]; then out=$a; fi; prev=$a; url=$a; done\n' +
        'echo "curl $url" >>"$FAKE/state/calls"\ncp "$FAKE/release/${url##*/}" "$out" 2>/dev/null',
    );
    stub("install", 'echo "install $*" >>"$FAKE/state/calls"\ncp "${@: -2:1}" "${@: -1}" && chmod 755 "${@: -1}"');
    const target = path.join(root, "mise");
    if (have !== undefined) {
      fs.writeFileSync(target, `#!/usr/bin/env bash\necho '${have} linux-x64 (2026-10-23)'\n`);
      fs.chmodSync(target, 0o755);
    }
    const [start, end] = between(SCRIPT, 'echo "== mise', 'echo "== The $WORKER_USER user"');
    const script = `set -euo pipefail\nMISE_VERSION=${VERSION}\n${SCRIPT.slice(start, end).replaceAll("/usr/local/bin/mise", target)}`;
    return { ...run(root, script), target };
  };
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

  it("pins a version", () => {
    expect(VERSION).toMatch(/^\d{4}\.\d+\.\d+$/);
  });

  it("installs the release's binary to /usr/local/bin/mise where it matches the release's checksums", () => {
    const { status, output, calls, target } = installMise({ [ASSET]: BINARY, "SHASUMS256.txt": `${sha("other")}  ./mise-v${VERSION}-macos-arm64\n${sha(BINARY)}  ./${ASSET}\n` });

    expect(output).toContain(`installed  mise ${VERSION} (was none), checked against the release's SHASUMS256.txt`);
    expect(status).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(BINARY);
    expect(calls).toContain(`curl https://github.com/jdx/mise/releases/download/v${VERSION}/${ASSET}`);
    expect(calls).toContain(`curl https://github.com/jdx/mise/releases/download/v${VERSION}/SHASUMS256.txt`);
  });

  it.each([
    ["does not match", (binary: string) => `${sha(`${binary}tampered`)}  ${ASSET}\n`],
    ["names no line for the binary", () => `${sha("other")}  mise-v${VERSION}-linux-arm64\n`],
  ])("refuses a download whose checksum file %s, and changes nothing", (_, sums) => {
    const { status, output, calls, target } = installMise({ [ASSET]: BINARY, "SHASUMS256.txt": sums(BINARY) }, "2024.1.0");

    expect(status).toBe(1);
    expect(output).toContain("does not match the release's SHASUMS256.txt. mise was not changed.");
    expect(calls.filter((call) => call.startsWith("install "))).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toContain("2024.1.0");
  });

  it("skips the install where that version is already there", () => {
    const { status, output, calls } = installMise({}, VERSION);

    expect(status).toBe(0);
    expect(output).toContain(`unchanged  mise ${VERSION}`);
    expect(calls.filter((call) => call.startsWith("curl ") || call.startsWith("install "))).toEqual([]);
  });

  it("is repeated, at the same version, in check-box.sh, which checks for it", () => {
    const check = fs.readFileSync(path.join(DEPLOY, "check-box.sh"), "utf8");
    expect(/^MISE_VERSION=\$\{MISE_VERSION:-([^}]+)\}$/m.exec(check)?.[1]).toBe(VERSION);
  });
});

describe("the operator's settings for every repository, in the operator's docs", () => {
  it("are listed in agent-service.conf.example and the guide's What a host needs, with how a change is applied", () => {
    const example = fs.readFileSync(path.join(DEPLOY, "agent-service.conf.example"), "utf8");
    const guide = fs.readFileSync(path.join(DEPLOY, "..", "..", "docs", "deploying-the-service.md"), "utf8");
    const [start, end] = between(guide, "## What a host needs", "### Installing the package");
    const hostNeeds = guide.slice(start, end);
    for (const text of [example, hostNeeds]) {
      for (const name of ["BOX_EXTRA_PACKAGES", "EGRESS_PRESETS", "EGRESS_EXTRA_HOSTS"]) expect(text).toContain(name);
      expect(text).toMatch(/re-run[\s#]+`?install-box\.sh/);
      expect(text).toMatch(/every[\s#]+repository/);
    }
    expect(example).toMatch(/^#BOX_EXTRA_PACKAGES="libpq-dev"$/m);
    expect(example).toMatch(/^#EGRESS_PRESETS="python"$/m);
    expect(example).toMatch(/^#EGRESS_EXTRA_HOSTS="example\.org"$/m);
    expect(hostNeeds).toContain('EGRESS_PRESETS="python"');
    expect(hostNeeds).not.toContain("Until #820");
  });
});
