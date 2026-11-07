import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
 *
 * `docker exec` runs the script upgrade.sh hands the dispatcher's container
 * with the real `node`, the container's `WORKER_URL` and `WORKER_SECRET` set
 * as `--env-file` sets them, and `fetch` replaced by one that answers the
 * worker's held door (#602): each question in turn takes the next answer in
 * `held-answers.json`, the last one again once they run out, and is recorded,
 * URL, headers and body, in `state/held-requests`.
 */

const DEPLOY = path.join(import.meta.dirname, "..", "..", "deploy", "unraid");
const NAME = "@jeffwlawson/agent-workflows";
const TARBALL = "jeffwlawson-agent-workflows-1.2.3.tgz";
const INSTALLED_PATH = path.join("node_modules", ...NAME.split("/"), "package.json");

/** The dispatcher container's WORKER_SECRET, which no output or command line may carry. */
const SECRET = "the-shared-secret-0123456789";
/** The box's sudo password, typed at the terminal: on no command line, in no output or file. */
const SUDO_PASSWORD = "the-sudo-password-9876543210";

/**
 * What ssh and scp both record of their options (#690): the mode of the key
 * `-i` names, as it is when they run, in `state/key-modes`.
 */
const SSH_KEY_MODE = `
prev=
for a in "$@"; do
  if [ "$prev" = -i ]; then stat -c '%a %n' "$a" >>"$FAKE/state/key-modes"; fi
  prev=$a
done`;

const STUBS: Record<string, string> = {
  id: `echo 0`,
  // FAKE_INTERRUPT stands for a Ctrl-C while upgrade.sh waits for the worker.
  sleep: `if [ -n "\${FAKE_INTERRUPT:-}" ]; then kill -TERM "$PPID"; fi`,
  // The box's sudo, wanting a password on stdin as `sudo -S -p ''` reads it,
  // unless its command names FAKE_SUDO_NOPASSWD. Each password it reads is
  // counted in state/sudo-reads.
  sudo: `
if [ "$1" != -S ] || [ "$2" != -p ] || [ "$3" != "" ]; then echo "sudo: not -S -p ''" >&2; exit 1; fi
shift 3
case " $* " in *" \${FAKE_SUDO_NOPASSWD:-@none@} "*) exec "$@" ;; esac
IFS= read -r password || true
if [ "$password" != '${SUDO_PASSWORD}' ]; then echo "sudo: a password is required" >&2; exit 1; fi
echo read >>"$FAKE/state/sudo-reads"
exec "$@"`,
  curl: `
out= url=
while [ $# -gt 0 ]; do
  case "$1" in -o|--proto|--proto-redir) [ "$1" = -o ] && out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
done
src="$FAKE/release/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"`,
  scp: `${SSH_KEY_MODE}
files=()
while [ $# -gt 1 ]; do
  case "$1" in -o|-i) shift 2 ;; *) files+=("$1"); shift ;; esac
done
for f in "\${files[@]}"; do
  if [ -n "\${FAKE_SCP_FAIL_AT:-}" ] && [ "$(basename "$f")" = "$FAKE_SCP_FAIL_AT" ]; then exit 1; fi
  cp "$f" "$FAKE/box-home/"
  case "$f" in *.tgz) if [ -n "\${FAKE_CORRUPT_SCP:-}" ]; then echo x >>"$FAKE/box-home/$(basename "$f")"; fi ;; esac
done`,
  // The shared connection: -M -N -f opens it, recording its ControlPath
  // directory's mode, and -O exit closes it. Anything else runs its last
  // argument in the box admin's home.
  ssh: `${SSH_KEY_MODE}
for a in "$@"; do
  case "$a" in
    -M)
      control=$(printf '%s\\n' "$@" | sed -n 's/^ControlPath=//p')
      stat -c '%a %n' "$(dirname "$control")" >>"$FAKE/state/control-dirs"
      exit "\${FAKE_MASTER_STATUS:-0}" ;;
    -O) exit 0 ;;
  esac
done
HOME="$FAKE/box-home" bash -c "\${@: -1}"`,
  npm: `
prefix= tgz=
while [ $# -gt 0 ]; do
  case "$1" in --prefix) prefix=$2; shift 2 ;; -*|install) shift ;; *) tgz=$1; shift ;; esac
done
name=$(sed -n 's/.*"name": *"\\([^"]*\\)".*/\\1/p' "$tgz")
mkdir -p "$prefix/node_modules/$name" && cp "$tgz" "$prefix/node_modules/$name/package.json"`,
  docker: `
installed() { sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$FAKE/appdata/pkg/${INSTALLED_PATH}"; }
c="$FAKE/state/container"
case "$1" in
  run)
    case " $* " in *" --rm "*) ;; *)
      # The dispatcher's container: what it is created with is what inspect answers.
      shift
      rm -rf "$c" && mkdir -p "$c" && : >"$c/env" && : >"$c/mounts"
      while [ $# -gt 0 ]; do
        case "$1" in
          -d) shift ;;
          --name) shift 2 ;;
          --restart) echo "$2" >"$c/restart"; shift 2 ;;
          --network) echo "$2" >"$c/network"; shift 2 ;;
          --user) echo "$2" >"$c/user"; shift 2 ;;
          -w) echo "$2" >"$c/workdir"; shift 2 ;;
          -e) echo "$2" >>"$c/env"; shift 2 ;;
          --env-file) grep -Ev '^[[:space:]]*(#|$)' "$2" >>"$c/env"; shift 2 ;;
          -v) dst=\${2#*:}; rw=true; case "$dst" in *:ro) rw=false; dst=\${dst%:ro} ;; esac
              echo "\${2%%:*} $dst $rw" >>"$c/mounts"; shift 2 ;;
          *) echo "$1" >"$c/image"; shift; echo "$*" >"$c/cmd"; break ;;
        esac
      done
      installed >"$FAKE/state/dispatcher-running"
      exit 0 ;;
    esac
    pkg= release= tgz=
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) case "$2" in *:/pkg) pkg=\${2%:/pkg} ;; *:/release:ro) release=\${2%:/release:ro} ;; esac; shift 2 ;;
        /release/*) tgz="$release/\${1#/release/}"; shift ;;
        *) shift ;;
      esac
    done
    if [ -n "\${FAKE_UNRAID_INSTALL_FAIL:-}" ]; then exit 1; fi
    name=$(sed -n 's/.*"name": *"\\([^"]*\\)".*/\\1/p' "$tgz")
    mkdir -p "$pkg/node_modules/$name" && cp "$tgz" "$pkg/node_modules/$name/package.json" ;;
  restart)
    if [ -n "\${FAKE_DISPATCHER_RESTART_FAIL:-}" ]; then exit 1; fi
    installed >"$FAKE/state/dispatcher-running" ;;
  exec)
    shift 3
    WORKER_URL=http://box.example:8787/jobs WORKER_SECRET='${SECRET}' exec "$1" --import "file://$FAKE/fetch.mjs" "\${@:2}" ;;
  rm) rm -rf "$c" ;;
  # The image the dispatcher runs on: here unless FAKE_IMAGE_ABSENT, and pulled
  # unless FAKE_PULL_FAIL.
  image) [ "$2 $3" = "inspect node:24-alpine" ] && [ -z "\${FAKE_IMAGE_ABSENT:-}" ] ;;
  pull)
    if [ -n "\${FAKE_PULL_FAIL:-}" ]; then echo "Error response from daemon: manifest for $2 not found" >&2; exit 1; fi ;;
  inspect)
    if [ "$2" != -f ]; then [ "$2" = agent-dispatcher ] && [ -d "$c" ]; exit; fi
    [ "$4" = agent-dispatcher ] && [ -d "$c" ] || { echo "Error: No such object: $4" >&2; exit 1; }
    case "$3" in
      *StartedAt*) echo 2026-10-31T00:00:00Z ;;
      *State.Running*) echo true ;;
      *Config.Image*) cat "$c/image" ;;
      *NetworkMode*) cat "$c/network" ;;
      *RestartPolicy*) cat "$c/restart" ;;
      *Config.Cmd*) cat "$c/cmd" ;;
      *Config.User*) cat "$c/user" ;;
      *WorkingDir*) cat "$c/workdir" ;;
      *Mounts*) cat "$c/mounts" ;;
      *Config.Env*) cat "$c/env" ;;
    esac ;;
  logs) echo "dispatcher $(cat "$FAKE/state/dispatcher-running") listening" ;;
esac`,
  systemctl: `
case "$1" in
  restart)
    if [ -n "\${FAKE_WORKER_RESTART_FAIL:-}" ]; then exit 1; fi
    sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$FAKE/opt/${INSTALLED_PATH}" >"$FAKE/state/worker-running" ;;
  show) echo invocation ;;
esac`,
  journalctl: `echo "worker $(cat "$FAKE/state/worker-running") listening"`,
  // Logged only: the tests do not run as root, and the call is what is checked.
  chown: ``,
  // What install-unraid.sh reads of the rest of Unraid, all already set up:
  // agentnet reserving the box's address for the VM's card, the firewall's
  // chain in, and the Funnel public.
  virsh: `
case "$1" in
  domiflist) printf ' Interface  Type  Source  Model  MAC\\n vnet0  bridge  agentnet  virtio  52:54:00:aa:bb:cc\\n' ;;
  net-info) echo "Active:         yes" ;;
  net-dumpxml) echo "    <host mac='52:54:00:aa:bb:cc' name='agent-box' ip='box.example'/>" ;;
esac`,
  iptables: ``,
  openssl: `echo made-by-openssl`,
  tailscale: `
case "$1 $2" in
  "funnel status") printf 'https://unraid.example:10000 (Funnel on)\\n|-- / proxy http://127.0.0.1:8790\\n' ;;
  "status --json") echo '"DNSName": "unraid.example.",' ;;
esac`,
};

/** The dispatcher's settings as install-unraid.sh writes them for the conf below, without its STATE_FILE line. */
const SERVICE_ENV_BEFORE_STATE = [
  "GITHUB_APP_ID=12345",
  "GITHUB_WEBHOOK_SECRET=the-webhook-secret",
  "GITHUB_APP_PRIVATE_KEY_FILE=/app/app.pem",
  "WORKER_URL=http://box.example:8787/jobs",
  "WEBHOOK_HOST=127.0.0.1",
  "WEBHOOK_PORT=8790",
  "TOKEN_HOST=192.168.250.1",
  "TOKEN_PORT=8791",
  `WORKER_SECRET=${SECRET}`,
  "",
].join("\n");
const SERVICE_ENV = `${SERVICE_ENV_BEFORE_STATE}STATE_FILE=/state/dispatcher.json\n`;
const DISPATCHER_CMD = "node /app/pkg/node_modules/@jeffwlawson/agent-workflows/dist/cli.js dispatcher";

/**
 * The dispatcher's container the run starts with (#691): as install-unraid.sh
 * makes it, one made before the state file (#618), with no `/state` mount and
 * no `STATE_FILE`, one on another image, or none.
 */
type Container = "clean" | "before-state" | "other-image" | "missing";

const CHECK_UNRAID = `#!/usr/bin/env bash
echo "  INFO  dispatcher version: $(cat "$FAKE/state/dispatcher-running") (the box's check prints the worker's: they must match)"
echo "  INFO  shared secret fingerprint: \${FAKE_FP_UNRAID:-0123456789abcdef} (the box's check prints its own: they must match)"
exit "\${FAKE_CHECK_UNRAID_STATUS:-0}"
`;
// With no terminal on the box's end of ssh, its lines arrive as written.
const CHECK_BOX = `#!/usr/bin/env bash
printf '  INFO  worker version: %s (check-unraid.sh prints the other)\\n' "\${FAKE_BOX_VERSION:-$(cat "$FAKE/state/worker-running")}"
printf '  INFO  shared secret fingerprint: %s (check-unraid.sh prints its own: they must match)\\n' "\${FAKE_FP_BOX:-0123456789abcdef}"
`;

const FAKE_FETCH = `import * as fs from "node:fs";
const state = process.env.FAKE + "/state";
const file = process.env.FAKE + "/held-answers.json";
const answers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [{ status: 200, body: { jobs: [] } }];
globalThis.fetch = async (url, init) => {
  const asked = fs.existsSync(state + "/held-requests") ? fs.readFileSync(state + "/held-requests", "utf8").split("\\n").filter(Boolean).length : 0;
  fs.appendFileSync(state + "/held-requests", JSON.stringify({ url: String(url), method: init.method, headers: init.headers, body: init.body }) + "\\n");
  const answer = answers[Math.min(asked, answers.length - 1)];
  if (answer === "unreachable") throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
  return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status });
};
`;

type HeldAnswer = { readonly status: number; readonly body: unknown } | "unreachable";

const heldJobs = (...jobs: readonly [string, string, number][]): HeldAnswer => ({
  status: 200,
  body: { jobs: jobs.map(([workflow, repo, number], index) => ({ id: `job-${index}`, workflow, repo, number })) },
});

const pkgJson = (version: string, extra = ""): string =>
  `{\n  "name": "${NAME}",\n  "version": "${version}",${extra}\n  "type": "module"\n}\n`;

interface Setup {
  readonly conf?: string;
  readonly installedExtra?: string;
  readonly digest?: string;
  /** No package installed on either machine yet, as before a first install. */
  readonly fresh?: boolean;
  /** What the worker's held door answers, question by question; unset, it holds nothing. */
  readonly held?: readonly HeldAnswer[];
  /** The dispatcher's container; unset, as install-unraid.sh makes it. */
  readonly container?: Container;
  /** service.env as it is; unset, as install-unraid.sh writes it, or without STATE_FILE for a container made before it. */
  readonly serviceEnv?: string;
}

/** Writes the container the stubbed docker answers inspect from, as `docker run -d` would leave it. */
const writeContainer = (root: string, container: Container, serviceEnv: string): void => {
  if (container === "missing") return;
  const dir = path.join(root, "state", "container");
  fs.mkdirSync(dir);
  const appdata = path.join(root, "appdata");
  const settings = serviceEnv.split("\n").filter((line) => line !== "");
  const answers: Record<string, string> = {
    image: container === "other-image" ? "node:22-alpine" : "node:24-alpine",
    network: "host",
    restart: "unless-stopped",
    user: "99:100",
    workdir: "/tmp",
    cmd: DISPATCHER_CMD,
    env: ["HOME=/tmp", "TZ=UTC", ...settings].join("\n"),
    mounts: [`${appdata} /app false`, ...(container === "before-state" ? [] : [`${appdata}/state /state true`])].join("\n"),
  };
  for (const [name, answer] of Object.entries(answers)) fs.writeFileSync(path.join(dir, name), `${answer}\n`);
};

// Removed once the file is done rather than after each test: the tests run
// concurrently, and an afterEach would remove the scratch of a test still running.
const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const setUp = (setup: Setup = {}): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-upgrade-"));
  scratches.push(root);
  for (const dir of ["unraid", "box-home", "bin", "state", "release", "stage", "opt", "home"]) {
    fs.mkdirSync(path.join(root, dir));
  }
  for (const script of ["upgrade.sh", "upgrade-unraid.sh", "upgrade-box.sh", "dispatcher-container.sh", "install-unraid.sh"]) {
    fs.copyFileSync(path.join(DEPLOY, script), path.join(root, "unraid", script));
  }
  fs.writeFileSync(path.join(root, "unraid", "check-unraid.sh"), CHECK_UNRAID);
  fs.writeFileSync(path.join(root, "unraid", "check-box.sh"), CHECK_BOX);
  fs.writeFileSync(path.join(root, "fetch.mjs"), FAKE_FETCH);
  // The terminal the operator types the box's sudo password at.
  fs.writeFileSync(path.join(root, "tty"), `${SUDO_PASSWORD}\n`);
  if (setup.held !== undefined) fs.writeFileSync(path.join(root, "held-answers.json"), JSON.stringify(setup.held));
  fs.writeFileSync(
    path.join(root, "unraid", "agent-service.conf"),
    [
      `APPDATA=${root}/appdata`,
      `PREFIX=${root}/opt`,
      `STAGE_DIR=${root}/stage`,
      `BOX_IP=box.example`,
      `BOX_SSH_USER=admin`,
      `FIREWALL_DIR=${root}/firewall`,
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
    if (setup.fresh !== true) fs.writeFileSync(installed, pkgJson("1.2.2", setup.installedExtra ?? ""));
  }
  // The dispatcher's install prefix, whose one dependency is the package.
  if (setup.fresh !== true) {
    fs.writeFileSync(path.join(root, "appdata", "pkg", "package.json"), `{\n  "dependencies": {\n    "${NAME}": "1.2.2"\n  }\n}\n`);
  }
  const container = setup.container ?? "clean";
  const serviceEnv = setup.serviceEnv ?? (container === "before-state" ? SERVICE_ENV_BEFORE_STATE : SERVICE_ENV);
  fs.mkdirSync(path.join(root, "appdata"), { recursive: true });
  fs.writeFileSync(path.join(root, "appdata", "service.env"), serviceEnv, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "appdata", "app.pem"), "the App's key\n", { mode: 0o600 });
  writeContainer(root, container, serviceEnv);
  fs.writeFileSync(path.join(root, "state", "dispatcher-running"), "1.2.2\n");
  fs.writeFileSync(path.join(root, "state", "worker-running"), "1.2.2\n");
  const tarball = pkgJson("1.2.3");
  fs.writeFileSync(path.join(root, "release", TARBALL), tarball);
  const digest = setup.digest ?? createHash("sha256").update(tarball).digest("hex");
  fs.writeFileSync(path.join(root, "release", `${TARBALL}.sha256`), `${digest}  ${TARBALL}\n`);
  return root;
};

const run = (root: string, env: Record<string, string> = {}, args: readonly string[] = ["1.2.3"]) => runScript(root, "upgrade.sh", args, env);

/**
 * Runs `script` as `spawnSync` did, but without blocking the worker, so the
 * file's tests run concurrently (#271): stdin closed at once, the exit status
 * reported as `status` (`null` where a signal ended it), and the same
 * `SUBPROCESS_TIMEOUT` bound, which throws where it fires.
 */
const runScript = async (root: string, script: string, args: readonly string[], env: Record<string, string> = {}) => {
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      "bash",
      [path.join(root, "unraid", script), ...args],
      {
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT,
        env: {
          PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? ""}`,
          HOME: path.join(root, "home"),
          FAKE: root,
          PROMPT_TTY: path.join(root, "tty"),
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve({ status: 0, stdout, stderr });
        else if (typeof error.code === "number") resolve({ status: error.code, stdout, stderr });
        else if (error.signal != null && !error.killed) resolve({ status: null, stdout, stderr });
        else reject(error);
      },
    );
    child.stdin?.end();
  });
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

describe("upgrade.sh", { concurrent: true }, () => {
  it("moves both machines to the version from the release's tarball, with no token", async () => {
    const root = setUp();
    const { status, output, calls } = await run(root);

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

  it("downloads over https only, redirects included", async () => {
    const { status, calls } = await run(setUp());

    expect(status).toBe(0);
    const downloads = calls.filter((call) => call.startsWith("curl "));
    expect(downloads).toHaveLength(2);
    for (const call of downloads) expect(call).toContain("--proto =https --proto-redir =https");
  });

  it("stops before restarting the dispatcher when the worker's restart fails, and names the commands that finish", async () => {
    const root = setUp();
    const { status, output, calls } = await run(root, { FAKE_WORKER_RESTART_FAIL: "1" });

    expect(status).toBe(1);
    expect(calls.filter((call) => call.startsWith("docker restart"))).toEqual([]);
    expect(running(root, "dispatcher")).toBe("1.2.2");
    expect(output).toContain("the dispatcher was not restarted");
    expect(output).toMatch(/ssh -o UserKnownHostsFile=\S+\/unraid\/known_hosts -o StrictHostKeyChecking=accept-new -t admin@box\.example 'sudo bash ~\/upgrade-box\.sh --restart 1\.2\.3'/);
    expect(output).toContain(`bash ${root}/unraid/upgrade-unraid.sh --restart 1.2.3`);
    expect(output).not.toContain("got 409 from the worker, for about");
  });

  it("names the command that finishes when the dispatcher's restart fails after the worker's", async () => {
    const root = setUp();
    const { status, output } = await run(root, { FAKE_DISPATCHER_RESTART_FAIL: "1" });

    expect(status).toBe(1);
    expect(running(root, "worker")).toBe("1.2.3");
    expect(output).toContain(`Fix the cause, then finish on Unraid: bash ${root}/unraid/upgrade-unraid.sh --restart 1.2.3`);
    expect(output).not.toContain("got 409 from the worker, for about");
  });

  it("names the earlier version as the way back when the install on Unraid fails", async () => {
    const root = setUp();
    const { status, output, calls } = await run(root, { FAKE_UNRAID_INSTALL_FAIL: "1" });

    expect(status).toBe(1);
    expect(calls.filter((call) => /^(systemctl|docker) restart/.test(call))).toEqual([]);
    expect(installed(root, "opt")).toBe("1.2.3");
    expect(output).toContain(`To put the box back instead: bash ${root}/unraid/upgrade.sh 1.2.2.`);
    // An earlier release may carry no tarball, and no script installs one of those.
    expect(output).toContain("older release may not.\nA release published before its tarball was attached to it cannot be rolled back to by script.");
    expect(output).not.toContain("install-box.sh");
  });

  it("names the same way back when the install on the box fails", async () => {
    const root = setUp();
    fs.rmSync(path.join(root, "bin", "npm"));
    fs.writeFileSync(path.join(root, "bin", "npm"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const { status, output, calls } = await run(root);

    expect(status).toBe(1);
    expect(calls.filter((call) => call.startsWith("docker"))).toEqual([]);
    expect(output).toContain(`To put the box back instead: bash ${root}/unraid/upgrade.sh 1.2.2.`);
    expect(output).toContain("cannot be rolled back to by script.");
    expect(output).not.toContain("install-box.sh");
  });

  it("says which files may already be on the box when the copy fails partway", async () => {
    const root = setUp();
    const { status, output, calls } = await run(root, { FAKE_SCP_FAIL_AT: "check-box.sh" });

    expect(status).toBe(2);
    expect(output).toContain(`Could not copy all of ${TARBALL} ${TARBALL}.sha256 upgrade-box.sh check-box.sh agent-service.conf`);
    expect(output).toContain("Some may already be there");
    expect(output).not.toContain("Nothing was changed");
    expect(touches(calls)).toEqual([]);
  });

  it("copies the run index to the box where it is beside the script", async () => {
    const root = setUp();
    fs.copyFileSync(path.join(DEPLOY, "runs.sh"), path.join(root, "unraid", "runs.sh"));
    const { status, output } = await run(root);

    expect(status).toBe(0);
    expect(output).toContain(`Copied ${TARBALL} ${TARBALL}.sha256 upgrade-box.sh check-box.sh runs.sh agent-service.conf to `);
    expect(fs.readFileSync(path.join(root, "box-home", "runs.sh"), "utf8")).toBe(fs.readFileSync(path.join(DEPLOY, "runs.sh"), "utf8"));
  });

  it("copies install-box.sh to the box where it is beside the script, and runs it nowhere", async () => {
    const root = setUp();
    fs.copyFileSync(path.join(DEPLOY, "install-box.sh"), path.join(root, "unraid", "install-box.sh"));
    const { status, output, calls } = await run(root);

    expect(status).toBe(0);
    expect(output).toContain(`Copied ${TARBALL} ${TARBALL}.sha256 upgrade-box.sh check-box.sh install-box.sh agent-service.conf to `);
    expect(fs.readFileSync(path.join(root, "box-home", "install-box.sh"))).toEqual(fs.readFileSync(path.join(DEPLOY, "install-box.sh")));
    // Copied for a person to run when a release says to: no command sent to the box names it.
    const named = calls.filter((call) => /^(ssh|scp) /.test(call) && call.includes("install-box.sh"));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/^scp /);
  });

  it("upgrades without install-box.sh beside the script, copying the rest", async () => {
    const root = setUp();
    fs.rmSync(path.join(root, "unraid", "install-box.sh"), { force: true });
    const { status, output } = await run(root);

    expect(status).toBe(0);
    expect(output).toContain(`Copied ${TARBALL} ${TARBALL}.sha256 upgrade-box.sh check-box.sh agent-service.conf to `);
    expect(fs.existsSync(path.join(root, "box-home", "install-box.sh"))).toBe(false);
  });

  it("upgrades onto machines with no package installed yet, printing no stray error", async () => {
    const root = setUp({ fresh: true, conf: `PACKAGE_SOURCE=owner/repo\nPACKAGE_NAME=${NAME}` });
    const { status, output } = await run(root);

    expect(output).not.toMatch(/no such file/i);
    expect(output).toContain("Installed now: none. Moving to 1.2.3.");
    expect(status).toBe(0);
    expect([installed(root, "appdata/pkg"), installed(root, "opt")]).toEqual(["1.2.3", "1.2.3"]);
  });

  it("refuses with no package installed and no PACKAGE_NAME, printing no stray error", async () => {
    const { status, output } = await run(setUp({ fresh: true }));

    expect(status).toBe(2);
    expect(output).not.toMatch(/no such file/i);
    expect(output).toContain("set PACKAGE_NAME");
  });

  it("says, with --now, that the worker's restart drops its queue, and how long the 409 window lasted", async () => {
    const { output } = await run(setUp(), {}, ["--now", "1.2.3"]);

    expect(output).toContain("Restarting the worker drops any job queued in it: its queue is in memory.");
    expect(output).toMatch(/the dispatcher got 409 from the worker, for about \d+ seconds/);
  });

  describe("waiting for the worker to hold no job (#602)", () => {
    const held = (root: string) => {
      const file = path.join(root, "state", "held-requests");
      return fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { url: string; method: string; headers: Record<string, string>; body: string })
        : [];
    };
    const restarts = (calls: readonly string[]) => calls.filter((call) => /^(systemctl|docker) restart/.test(call));
    const sleeps = (calls: readonly string[]) => calls.filter((call) => call.startsWith("sleep "));

    it("restarts at once where the worker holds no job, having asked once", async () => {
      const root = setUp();
      const { status, output, calls } = await run(root);

      expect(status).toBe(0);
      expect(output).toContain("The worker holds no job.");
      expect(held(root)).toHaveLength(1);
      expect(sleeps(calls)).toEqual([]);
      expect(restarts(calls).map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual(["systemctl restart", "docker restart"]);
      // After the installs, before either restart.
      const asked = calls.findIndex((call) => call.startsWith("docker exec"));
      expect(asked).toBeGreaterThan(calls.findIndex((call) => call.startsWith("docker run")));
      expect(asked).toBeLessThan(calls.findIndex((call) => call.startsWith("systemctl restart")));
      expect(output).toContain("dispatcher's scan dispatches it again");
    });

    it("asks the held door a signed read that names no instance, with the secret on no command line and in no output", async () => {
      const root = setUp();
      const { status, output, calls } = await run(root);

      expect(status).toBe(0);
      const [request] = held(root);
      expect(request?.url).toBe("http://box.example:8787/held");
      expect(request?.method).toBe("POST");
      const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["asked"]);
      expect(Number.isNaN(Date.parse(String(body["asked"])))).toBe(false);
      expect(request?.headers["x-signature-256"]).toBe(`sha256=${createHmac("sha256", SECRET).update(request?.body ?? "").digest("hex")}`);
      expect(calls.find((call) => call.startsWith("docker exec"))).toBe("docker exec -i agent-dispatcher node --input-type=module -");
      expect(calls.join("\n")).not.toContain(SECRET);
      expect(output).not.toContain(SECRET);
    });

    it("waits while the worker holds a job, printing it and each change, and restarts once it holds none", async () => {
      const root = setUp({
        held: [
          heldJobs(["implement", "owner/repo", 12], ["review", "owner/repo", 14]),
          heldJobs(["implement", "owner/repo", 12], ["review", "owner/repo", 14]),
          heldJobs(["review", "owner/repo", 14]),
          heldJobs(),
        ],
      });
      const { status, output, calls } = await run(root);

      expect(status).toBe(0);
      expect(output).toContain("The worker holds 2 job(s); waiting up to 90 minutes for it to hold none:\n  implement on owner/repo#12\n  review on owner/repo#14\n");
      expect(output).toContain("The worker now holds 1 job(s):\n  review on owner/repo#14\n");
      expect(output.match(/implement on owner\/repo#12/g)).toHaveLength(1);
      expect(output).toContain("The worker holds no job now, after about 1 minutes.");
      expect(held(root)).toHaveLength(4);
      expect(sleeps(calls)).toEqual(["sleep 30", "sleep 30", "sleep 30"]);
      const lastAsked = calls.findLastIndex((call) => call.startsWith("docker exec"));
      expect(restarts(calls)).toHaveLength(2);
      expect(calls.findIndex((call) => call.startsWith("systemctl restart"))).toBeGreaterThan(lastAsked);
      expect([running(root, "dispatcher"), running(root, "worker")]).toEqual(["1.2.3", "1.2.3"]);
    });

    it("prints a heartbeat at a fixed interval while nothing held changes", async () => {
      const same = heldJobs(["fix", "owner/repo", 7]);
      const root = setUp({ held: [...Array.from({ length: 11 }, () => same), heldJobs()] });
      const { status, output } = await run(root);

      expect(status).toBe(0);
      expect(output.match(/Still waiting/g)).toHaveLength(1);
      expect(output).toContain("Still waiting, 5 of 90 minutes: the worker holds the same 1 job(s).");
    });

    it("restarts nothing past the bound, naming what is held, re-running and --now", async () => {
      const root = setUp({ conf: "PACKAGE_SOURCE=owner/repo\nIDLE_WAIT_MINUTES=1", held: [heldJobs(["implement-prd", "owner/repo", 3])] });
      const { status, output, calls } = await run(root);

      expect(status).toBe(1);
      expect(restarts(calls)).toEqual([]);
      expect(sleeps(calls)).toHaveLength(2);
      expect(output).toContain("The worker still holds 1 job(s) after 1 minutes:\n  implement-prd on owner/repo#3\n");
      expect(output).toContain("Both machines have 1.2.3 installed, and neither service was restarted.");
      expect(output).toContain("Run upgrade.sh 1.2.3 again later, or run upgrade.sh --now 1.2.3");
      expect([installed(root, "appdata/pkg"), installed(root, "opt")]).toEqual(["1.2.3", "1.2.3"]);
      expect([running(root, "dispatcher"), running(root, "worker")]).toEqual(["1.2.2", "1.2.2"]);
    });

    it("with --now, restarts without asking the worker", async () => {
      const root = setUp({ held: [heldJobs(["implement", "owner/repo", 12])] });
      const { status, output, calls } = await run(root, {}, ["--now", "1.2.3"]);

      expect(status).toBe(0);
      expect(calls.filter((call) => call.startsWith("docker exec"))).toEqual([]);
      expect(held(root)).toEqual([]);
      expect(output).toContain("--now: not asking the worker");
      expect(restarts(calls)).toHaveLength(2);
    });

    it.each([[[]], [["1.2.3", "--later"]], [["--now"]], [["1.2.3", "1.2.4"]]])("refuses %j with the usage line", async (args) => {
      const root = setUp();
      const { status, output, calls } = await run(root, {}, args);

      expect(status).toBe(2);
      expect(output).toContain("Usage: bash ");
      expect(output).toContain("[--now] <version>");
      expect(calls).toEqual([]);
    });

    it.each<[string, HeldAnswer, string]>([
      ["an unreachable worker", "unreachable", "the worker could not be reached at http://box.example:8787/held: connect ECONNREFUSED"],
      ["a refused signature", { status: 401, body: { refusal: "bad signature" } }, "the worker refused the question's signature (401: bad signature): the dispatcher's WORKER_SECRET is not the worker's"],
      ["a refused question", { status: 400, body: { refusal: "`asked` is not a time" } }, "the worker answered 400: `asked` is not a time"],
      ["an answer that is not a list", { status: 200, body: { jobs: "none" } }, "the worker's answer is not a list of jobs"],
      ["an answer that is not JSON", { status: 200, body: "<html>" }, "the worker's answer is not a list of jobs"],
    ])("stops before either restart on %s, naming --now", async (_, answer, reason) => {
      const root = setUp({ held: [answer] });
      const { status, output, calls } = await run(root);

      expect(status).toBe(1);
      expect(output).toContain(`Could not tell which jobs the worker holds: ${reason}.`);
      expect(output).toContain("Both machines have 1.2.3 installed, and neither service was restarted.");
      expect(output).toContain("run upgrade.sh --now 1.2.3");
      expect(restarts(calls)).toEqual([]);
      expect(output).not.toContain(SECRET);
    });

    it("stops on a worker it cannot ask partway through the wait", async () => {
      const root = setUp({ held: [heldJobs(["fix", "owner/repo", 7]), "unreachable"] });
      const { status, output, calls } = await run(root);

      expect(status).toBe(1);
      expect(output).toContain("Could not tell which jobs the worker holds, after waiting 0 minutes: the worker could not be reached");
      expect(output).toContain("--now");
      expect(restarts(calls)).toEqual([]);
    });

    it("stops where the dispatcher's container cannot be asked", async () => {
      const root = setUp();
      fs.writeFileSync(path.join(root, "bin", "docker"), fs.readFileSync(path.join(root, "bin", "docker"), "utf8").replace("  exec)\n", "  exec)\n    echo 'Error: container agent-dispatcher is not running' >&2; exit 1\n"));
      const { status, output, calls } = await run(root);

      expect(status).toBe(1);
      expect(output).toContain("the dispatcher's container, agent-dispatcher, could not be asked to ask it: Error: container agent-dispatcher is not running.");
      expect(output).toContain("--now");
      expect(restarts(calls)).toEqual([]);
    });

    it("says a worker with no held door cannot tell, and goes on once", async () => {
      const root = setUp({ held: [{ status: 404, body: { refusal: "no such door" } }] });
      const { status, output, calls } = await run(root);

      expect(status).toBe(0);
      expect(output).toContain("whether it holds a job cannot be told. Going on without waiting.");
      expect(output).toContain("Restarting the worker drops any job queued in it: its queue is in memory.");
      expect(held(root)).toHaveLength(1);
      expect(sleeps(calls)).toEqual([]);
      expect(restarts(calls)).toHaveLength(2);
    });

    it("refuses an IDLE_WAIT_MINUTES that is not a whole number", async () => {
      const root = setUp({ conf: "PACKAGE_SOURCE=owner/repo\nIDLE_WAIT_MINUTES=an-hour" });
      const { status, output, calls } = await run(root);

      expect(status).toBe(2);
      expect(output).toContain("IDLE_WAIT_MINUTES");
      expect(calls).toEqual(["id -u"]);
    });
  });

  it("reaches the box with host keys beside the conf, accept-new, and nothing under ~/.ssh", async () => {
    const { status, calls } = await run(setUp());
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
    // No box command has a terminal (#690): its sudo reads the password on stdin.
    expect(remote.filter((call) => call.includes(" -t "))).toEqual([]);
  });

  describe("one connection and one sudo password (#690)", () => {
    const remote = (calls: readonly string[]) => calls.filter((call) => /^(ssh|scp) /.test(call));
    const controlPath = (call: string): string | undefined => call.match(/-o ControlPath=(\S+)/)?.[1];

    it("opens one master connection, which every other ssh and scp shares, and closes it", async () => {
      const { status, calls } = await run(setUp());

      expect(status).toBe(0);
      const masters = calls.filter((call) => call.startsWith("ssh ") && / -M -N -f /.test(call));
      expect(masters).toHaveLength(1);
      const [master] = masters;
      const path_ = controlPath(master ?? "");
      expect(path_).toMatch(/\/%C$/);
      const rest = remote(calls).filter((call) => call !== master);
      expect(rest.length).toBeGreaterThan(0);
      for (const call of rest) expect(controlPath(call)).toBe(path_);
      // Opened before the copy, and asked to exit last.
      expect(remote(calls)[0]).toBe(master);
      expect(remote(calls).at(-1)).toMatch(/^ssh .* -O exit admin@box\.example$/);
    });

    it.each<[string, () => string, Record<string, string>, number]>([
      ["a successful run", () => setUp(), {}, 0],
      ["a failed run", () => setUp(), { FAKE_WORKER_RESTART_FAIL: "1" }, 1],
      ["an interrupted run", () => setUp({ held: [heldJobs(["fix", "owner/repo", 7])] }), { FAKE_INTERRUPT: "1" }, 143],
    ])("keeps the socket in a private directory outside the conf's and /boot, gone after %s", async (_, make, env, expected) => {
      const root = make();
      const { status, calls } = await run(root, env);

      expect(status).toBe(expected);
      const [recorded] = fs.readFileSync(path.join(root, "state", "control-dirs"), "utf8").trim().split("\n");
      const [mode, dir] = (recorded ?? "").split(" ");
      expect(mode).toBe("700");
      expect(dir).toBe(path.dirname(controlPath(calls.find((call) => / -M /.test(call)) ?? "") ?? ""));
      expect(path.dirname(dir ?? "")).toBe(os.tmpdir());
      expect(dir?.startsWith(path.join(root, "unraid"))).toBe(false);
      expect(dir?.startsWith("/boot")).toBe(false);
      expect(fs.existsSync(dir ?? "")).toBe(false);
      expect(calls.filter((call) => / -O exit /.test(call))).toHaveLength(1);
      expect(fs.readdirSync(path.join(root, "stage"))).toEqual([]);
    });

    it("goes on, a connection a step, where the master cannot be opened", async () => {
      const root = setUp();
      const { status, output } = await run(root, { FAKE_MASTER_STATUS: "255" });

      expect(status).toBe(0);
      expect(output).toContain("Could not open one shared connection to admin@box.example");
      expect(output).toContain("Both machines run 1.2.3 and share the secret.");
    });

    it("reads the sudo password once and hands it to each box sudo on stdin, never on a command line, in output or in a file", async () => {
      const root = setUp();
      const { status, output, calls } = await run(root);

      expect(status).toBe(0);
      // The install, the restart and the check each ran sudo, which read it.
      const sudos = calls.filter((call) => call.startsWith("sudo "));
      expect(sudos.map((call) => call.split(" ").slice(0, 5).join(" "))).toEqual([
        "sudo -S -p  bash",
        "sudo -S -p  bash",
        "sudo -S -p  bash",
      ]);
      expect(fs.readFileSync(path.join(root, "state", "sudo-reads"), "utf8").trim().split("\n")).toHaveLength(3);
      expect(output.match(/admin@box\.example's sudo password: /g)).toHaveLength(1);
      expect(calls.join("\n")).not.toContain(SUDO_PASSWORD);
      expect(output).not.toContain(SUDO_PASSWORD);
      const files = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name);
          return entry.isDirectory() ? files(full) : [full];
        });
      // The terminal and the sudo stub hold it before the run starts; any other file is the run's.
      const leaving = files(root).filter((file) => ![path.join(root, "tty"), path.join(root, "bin", "sudo")].includes(file));
      expect(leaving.filter((file) => fs.readFileSync(file, "utf8").includes(SUDO_PASSWORD))).toEqual([]);
    });

    it("parses the box's check, which comes through no terminal, with no carriage return to strip", async () => {
      const { status, output } = await run(setUp());

      expect(status).toBe(0);
      expect(output).toContain("worker version:            1.2.3\n");
      expect(output).toContain("box secret fingerprint:    0123456789abcdef\n");
    });

    it("with no terminal to read the password from, fails the step whose sudo wants one, naming the terminal and the commands that finish", async () => {
      const root = setUp();
      const { status, output, calls } = await run(root, { PROMPT_TTY: path.join(root, "no-such-terminal"), FAKE_SUDO_NOPASSWD: "--install" });

      expect(status).toBe(1);
      expect(installed(root, "opt")).toBe("1.2.3");
      expect(output).not.toContain("sudo password: ");
      expect(output).toContain("There was no terminal to read the box's sudo password from");
      expect(output).toContain("run upgrade.sh from a terminal");
      expect(output).toContain("the dispatcher was not restarted");
      expect(output).toMatch(/-t admin@box\.example 'sudo bash ~\/upgrade-box\.sh --restart 1\.2\.3'/);
      expect(calls.filter((call) => call.startsWith("docker restart"))).toEqual([]);
    });

    it("uses a mode 600 copy of the key BOX_SSH_KEY names for every ssh and scp, removed at the end, the original untouched", async () => {
      const root = setUp();
      const key = path.join(root, "unraid", "box_key");
      fs.writeFileSync(key, "a private key\n", { mode: 0o644 });
      fs.chmodSync(key, 0o644);
      const conf = path.join(root, "unraid", "agent-service.conf");
      fs.appendFileSync(conf, `BOX_SSH_KEY=${key}\n`);
      const { status, output, calls } = await run(root);

      expect(status).toBe(0);
      const copy = calls.find((call) => call.startsWith("ssh "))?.match(/ -i (\S+)/)?.[1] ?? "";
      const dir = path.dirname(controlPath(calls.find((call) => call.startsWith("ssh ")) ?? "") ?? "");
      expect(copy).toBe(path.join(dir, "key"));
      for (const call of remote(calls)) {
        expect(call).toContain(` -i ${copy} `);
        expect(call).not.toContain(` -i ${key} `);
      }
      const modes = fs.readFileSync(path.join(root, "state", "key-modes"), "utf8").trim().split("\n");
      expect(modes).toHaveLength(remote(calls).length);
      for (const line of modes) expect(line).toBe(`600 ${copy}`);
      expect(fs.existsSync(copy)).toBe(false);
      expect(fs.statSync(key).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(key, "utf8")).toBe("a private key\n");
      // The commands for an operator to paste name the original: the copy is gone by then.
      expect(output).not.toContain(copy);
    });

    it("pastes the original key, not the copy, into the commands that finish", async () => {
      const root = setUp();
      const key = path.join(root, "unraid", "box_key");
      fs.writeFileSync(key, "a private key\n");
      fs.appendFileSync(path.join(root, "unraid", "agent-service.conf"), `BOX_SSH_KEY=${key}\n`);
      const { status, output } = await run(root, { FAKE_WORKER_RESTART_FAIL: "1" });

      expect(status).toBe(1);
      expect(output).toContain(`-i ${key} -t admin@box.example 'sudo bash ~/upgrade-box.sh --restart 1.2.3'`);
      expect(output).not.toContain("ControlPath");
    });
  });

  it("stops before either machine is touched when the tarball does not match its .sha256", async () => {
    const root = setUp({ digest: "0".repeat(64) });
    const { status, output, calls } = await run(root);

    expect(status).not.toBe(0);
    expect(output).toContain("does not match its .sha256");
    expect(output).toContain("Nothing was changed on either machine.");
    expect(calls.filter((call) => /^(ssh|scp) /.test(call))).toEqual([]);
    expect(touches(calls)).toEqual([]);
  });

  it("stops before either machine is touched when the tarball arrives on the box changed", async () => {
    const root = setUp();
    const { status, output, calls } = await run(root, { FAKE_CORRUPT_SCP: "1" });

    expect(status).not.toBe(0);
    expect(output).toContain(`${TARBALL} does not match its .sha256. Nothing was changed.`);
    expect(touches(calls)).toEqual([]);
    expect([installed(root, "appdata/pkg"), installed(root, "opt")]).toEqual(["1.2.2", "1.2.2"]);
  });

  it("refuses, naming PACKAGE_SOURCE, when neither it nor the installed package names the repository", async () => {
    const root = setUp({ conf: "" });
    const { status, output, calls } = await run(root);

    expect(status).toBe(2);
    expect(output).toContain("set PACKAGE_SOURCE=<owner>/<repo>");
    expect(output).toContain("Nothing was changed on either machine.");
    expect(calls).toEqual(["id -u"]);
  });

  it.each([
    ['"repository": "github:owner/repo",'],
    ['"repository": { "type": "git", "url": "git+https://github.com/owner/repo.git" },'],
  ])("reads the repository from the installed package where PACKAGE_SOURCE is unset: %s", async (field) => {
    const root = setUp({ conf: "", installedExtra: `\n  ${field}` });
    const { status, calls } = await run(root);

    expect(status).toBe(0);
    expect(calls.find((call) => call.startsWith("curl"))).toMatch(
      new RegExp(`https://github\\.com/owner/repo/releases/download/v1\\.2\\.3/${TARBALL}$`),
    );
  });

  it("refuses a repository that is not on github.com", async () => {
    const root = setUp({ conf: "", installedExtra: `\n  "repository": "https://gitlab.com/owner/repo",` });
    const { status, output, calls } = await run(root);

    expect(status).toBe(2);
    expect(output).toContain("PACKAGE_SOURCE");
    expect(calls).toEqual(["id -u"]);
  });

  it("refuses without BOX_SSH_USER, naming it", async () => {
    const root = setUp();
    const conf = path.join(root, "unraid", "agent-service.conf");
    fs.writeFileSync(conf, fs.readFileSync(conf, "utf8").replace("BOX_SSH_USER=admin\n", ""));
    const { status, output, calls } = await run(root);

    expect(status).toBe(2);
    expect(output).toContain("Set BOX_SSH_USER");
    expect(calls).toEqual(["id -u"]);
  });

  it("exits non-zero, printing both, when the two machines report different versions", async () => {
    const { status, output } = await run(setUp(), { FAKE_BOX_VERSION: "1.2.2" });

    expect(status).toBe(1);
    expect(output).toContain("dispatcher version:        1.2.3");
    expect(output).toContain("worker version:            1.2.2");
    expect(output.trim().split("\n").at(-1)).toMatch(/^FAILED: the dispatcher runs 1\.2\.3 and the worker 1\.2\.2/);
  });

  it("exits non-zero, printing both, when the shared secret's fingerprints differ", async () => {
    const { status, output } = await run(setUp(), { FAKE_FP_BOX: "fedcba9876543210" });

    expect(status).toBe(1);
    expect(output).toContain("FAILED: the shared secret's fingerprints differ (0123456789abcdef on Unraid, fedcba9876543210 on the box).");
  });

  it("fails the run when a check script fails, though versions and fingerprints match", async () => {
    const { status, output } = await run(setUp(), { FAKE_CHECK_UNRAID_STATUS: "1" });

    expect(status).toBe(1);
    expect(output).toContain("FAILED: a restart or a check failed");
  });
});

describe("the dispatcher's container on an upgrade (#691)", { concurrent: true }, () => {
  /** The container as the stubbed docker holds it, one file an answer. */
  const container = (root: string): Record<string, string> | undefined => {
    const dir = path.join(root, "state", "container");
    if (!fs.existsSync(dir)) return undefined;
    return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
  };
  /** The calls that remove, create or restart a container, with the scratch directory named <root>. */
  const changes = (root: string, calls: readonly string[]): string[] =>
    calls.filter((call) => /^docker (rm|run -d|restart)/.test(call)).map((call) => call.replaceAll(root, "<root>"));
  const stateDir = (root: string) => path.join(root, "appdata", "state");
  const serviceEnv = (root: string) => fs.readFileSync(path.join(root, "appdata", "service.env"), "utf8");

  it("recreates a container made before the state file with the /state mount and the install's options, adding STATE_FILE", async () => {
    const root = setUp({ container: "before-state" });
    const { status, output, calls } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"]);

    expect(status).toBe(0);
    expect(changes(root, calls)).toEqual([
      "docker rm -f agent-dispatcher",
      `docker run -d --name agent-dispatcher --restart unless-stopped --network host --user 99:100 -w /tmp -e HOME=/tmp -e TZ=UTC --env-file <root>/appdata/service.env -v <root>/appdata:/app:ro -v <root>/appdata/state:/state node:24-alpine ${DISPATCHER_CMD}`,
    ]);
    expect(output).toContain("removed    agent-dispatcher, whose state mount,settings differed");
    expect(output).toContain("The dispatcher 1.2.2 is listening.");
    expect(output).not.toContain("Run install-unraid.sh");
    // What it was created with is what the install's container has.
    expect(container(root)?.["mounts"]).toBe(`${root}/appdata /app false\n${root}/appdata/state /state true\n`);
    expect(container(root)?.["env"]).toContain("STATE_FILE=/state/dispatcher.json\n");
  });

  it("adds the one STATE_FILE line where service.env has none, and makes the state folder as the install does", async () => {
    const root = setUp({ container: "before-state" });
    const { status, output, calls } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"]);

    expect(status).toBe(0);
    expect(serviceEnv(root)).toBe(`${SERVICE_ENV_BEFORE_STATE}STATE_FILE=/state/dispatcher.json\n`);
    expect(output).toContain(`added      STATE_FILE=/state/dispatcher.json to ${root}/appdata/service.env`);
    expect(output).toContain(`made       ${stateDir(root)}`);
    expect(fs.statSync(stateDir(root)).mode & 0o777).toBe(0o700);
    expect(calls).toContain(`chown 99:100 ${stateDir(root)}`);
  });

  it("adds the line on a line of its own where service.env ends with no newline", async () => {
    const root = setUp({ container: "before-state", serviceEnv: SERVICE_ENV_BEFORE_STATE.trimEnd() });
    const { status } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"]);

    expect(status).toBe(0);
    expect(serviceEnv(root)).toBe(`${SERVICE_ENV_BEFORE_STATE}STATE_FILE=/state/dispatcher.json\n`);
  });

  it("restarts a container with no drift, removing and creating nothing, and leaves service.env byte for byte", async () => {
    const root = setUp();
    const before = container(root);
    const { status, output, calls } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"]);

    expect(status).toBe(0);
    expect(changes(root, calls)).toEqual(["docker restart agent-dispatcher"]);
    expect(serviceEnv(root)).toBe(SERVICE_ENV);
    expect(output).not.toContain("added ");
    expect(output).not.toContain("Run install-unraid.sh");
    expect(container(root)).toEqual(before);
    expect(fs.statSync(stateDir(root)).mode & 0o777).toBe(0o700);
  });

  it("recreates a container on another image, with service.env left as it was", async () => {
    const root = setUp({ container: "other-image" });
    const { status, output, calls } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"]);

    expect(status).toBe(0);
    expect(output).toContain("whose image differed");
    expect(changes(root, calls).map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual(["docker rm", "docker run"]);
    expect(serviceEnv(root)).toBe(SERVICE_ENV);
  });

  // #738: the image is checked, or pulled, before the old container goes, so a
  // pull that fails leaves the dispatcher running rather than none at all.
  const imageCalls = (calls: readonly string[]) => calls.filter((call) => /^docker (image|pull|rm|run -d)/.test(call)).map((call) => call.split(" ").slice(0, 2).join(" "));

  it.each(["upgrade-unraid.sh", "install-unraid.sh"])("%s removes nothing, and says why, where the image is neither here nor pulled", async (script) => {
    const root = setUp({ container: "before-state" });
    const before = container(root);
    const { status, output, calls } = await runScript(root, script, script === "install-unraid.sh" ? ["1.2.2"] : ["--restart", "1.2.2"], { FAKE_IMAGE_ABSENT: "1", FAKE_PULL_FAIL: "1" });

    expect(status).toBe(1);
    expect(imageCalls(calls)).toEqual(["docker image", "docker pull"]);
    expect(container(root)).toEqual(before);
    expect(output).toContain("manifest for node:24-alpine not found");
    expect(output).toContain("node:24-alpine is not on this server and could not be pulled: agent-dispatcher was left as it is.");
    expect(output).not.toContain("removed ");
  });

  it("pulls an image that is not here, then recreates the container", async () => {
    const root = setUp({ container: "before-state" });
    const { status, calls } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"], { FAKE_IMAGE_ABSENT: "1" });

    expect(status).toBe(0);
    expect(imageCalls(calls)).toEqual(["docker image", "docker pull", "docker rm", "docker run"]);
  });

  it("pulls nothing where the image is here", async () => {
    const root = setUp({ container: "before-state" });
    const { status, calls } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"], { FAKE_PULL_FAIL: "1" });

    expect(status).toBe(0);
    expect(imageCalls(calls)).toEqual(["docker image", "docker rm", "docker run"]);
  });

  it("does it all within upgrade.sh, with the dispatcher's settings asked for nowhere", async () => {
    const root = setUp({ container: "before-state" });
    const { status, output, calls } = await run(root);

    expect(status).toBe(0);
    expect(output).toContain("Both machines run 1.2.3 and share the secret.");
    expect(changes(root, calls).map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual(["docker rm", "docker run"]);
    expect(container(root)?.["mounts"]).toContain("/state true");
    expect(output).not.toMatch(/webhook secret|App's ID|GitHub token/i);
  });

  it("reads no terminal on Unraid's side of an upgrade", async () => {
    for (const file of ["upgrade-unraid.sh", "dispatcher-container.sh"]) {
      const code = fs.readFileSync(path.join(DEPLOY, file), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
      expect(code, file).not.toMatch(/\/dev\/tty|\bread -r?s?p\b/);
    }
  });

  it("stops before the restart, naming install-unraid.sh, where there are no settings to create a container from", async () => {
    const root = setUp();
    fs.rmSync(path.join(root, "appdata", "service.env"));
    const { status, output, calls } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"]);

    expect(status).toBe(1);
    expect(output).toContain(`No settings at ${root}/appdata/service.env: run install-unraid.sh 1.2.2`);
    expect(changes(root, calls)).toEqual([]);
  });

  it("refuses, changing nothing, where dispatcher-container.sh is not beside it", async () => {
    const root = setUp({ container: "before-state" });
    fs.rmSync(path.join(root, "unraid", "dispatcher-container.sh"));
    const { status, output, calls } = await runScript(root, "upgrade-unraid.sh", ["--restart", "1.2.2"]);

    expect(status).toBe(2);
    expect(output).toContain("dispatcher-container.sh is not beside this script");
    expect(calls).toEqual([]);
    expect(serviceEnv(root)).toBe(SERVICE_ENV_BEFORE_STATE);
  });

  // The same drift check and create step: install-unraid.sh, run with nothing
  // to ask, changes the container as the upgrade does from the same start.
  it.each<Container>(["before-state", "other-image", "missing"])("changes a %s container as install-unraid.sh does, reading no terminal", async (start) => {
    const upgraded = setUp({ container: start });
    const installedRoot = setUp({ container: start });
    const upgrade = await runScript(upgraded, "upgrade-unraid.sh", ["--restart", "1.2.2"]);
    const install = await runScript(installedRoot, "install-unraid.sh", ["1.2.2"]);

    expect(install.output).not.toContain("needs a terminal");
    expect(install.status).toBe(0);
    expect(upgrade.status).toBe(0);
    expect(changes(installedRoot, install.calls).length).toBeGreaterThan(0);
    expect(changes(upgraded, upgrade.calls)).toEqual(changes(installedRoot, install.calls));
    expect(serviceEnv(upgraded)).toBe(serviceEnv(installedRoot));
    expect(JSON.stringify(container(upgraded)).replaceAll(upgraded, "<root>")).toBe(JSON.stringify(container(installedRoot)).replaceAll(installedRoot, "<root>"));
    expect(fs.statSync(stateDir(installedRoot)).mode & 0o777).toBe(0o700);
    expect(install.calls).toContain(`chown 99:100 ${stateDir(installedRoot)}`);
  });
});

describe("the install scripts' package, from the release's tarball (#576)", { concurrent: true }, () => {
  const RELEASE_URL = `https://github.com/owner/repo/releases/download/v1.2.3/${TARBALL}`;
  const downloads = (calls: readonly string[]): string[] =>
    calls.filter((call) => call.startsWith("curl ")).map((call) => call.split(" ").at(-1) ?? "");

  describe("install-unraid.sh", () => {
    const install = (root: string, version = "1.2.3") => runScript(root, "install-unraid.sh", [version]);

    it("installs a version that is not installed from the downloaded tarball, its digest checked, asking for no token and reading no terminal", async () => {
      const root = setUp();
      const { status, output, calls } = await install(root);

      expect(output).not.toContain("needs a terminal");
      expect(output).not.toMatch(/GitHub token|read:packages/);
      expect(status).toBe(0);
      expect(downloads(calls)).toEqual([RELEASE_URL, `${RELEASE_URL}.sha256`]);
      for (const call of calls.filter((c) => c.startsWith("curl "))) expect(call).toContain("--proto =https --proto-redir =https");
      const npm = calls.filter((call) => call.startsWith("docker run --rm"));
      expect(npm).toHaveLength(1);
      expect(npm[0]).toMatch(new RegExp(`npm install --prefix /pkg .*/release/${TARBALL.replaceAll(".", "\\.")}$`));
      expect(npm[0]).not.toContain("npmrc");
      expect(installed(root, "appdata/pkg")).toBe("1.2.3");
      expect(output).toContain(`installed  ${NAME} 1.2.3`);
      // The downloaded tarball is removed once installed.
      expect(fs.readdirSync(path.join(root, "stage"))).toEqual([]);
    });

    it("installs onto a server with no package yet", async () => {
      const root = setUp({ fresh: true });
      const { status, output } = await install(root);

      expect(output).not.toMatch(/GitHub token|no such file/i);
      expect(status).toBe(0);
      expect(installed(root, "appdata/pkg")).toBe("1.2.3");
    });

    it.each([
      ["the tarball", TARBALL, RELEASE_URL],
      ["its .sha256", `${TARBALL}.sha256`, `${RELEASE_URL}.sha256`],
    ])("stops, naming the URL and leaving the package as it was, when %s cannot be downloaded", async (_what, file, url) => {
      const root = setUp();
      fs.rmSync(path.join(root, "release", file));
      const { status, output, calls } = await install(root);

      expect(status).toBe(1);
      expect(output).toContain(`Could not download ${url}`);
      expect(calls.filter((call) => call.startsWith("docker run"))).toEqual([]);
      expect(installed(root, "appdata/pkg")).toBe("1.2.2");
      expect(fs.readdirSync(path.join(root, "stage"))).toEqual([]);
    });

    it("stops, naming the URL and leaving the package as it was, when the tarball does not match its .sha256", async () => {
      const root = setUp({ digest: "0".repeat(64) });
      const { status, output, calls } = await install(root);

      expect(status).toBe(1);
      expect(output).toContain(`${RELEASE_URL} does not match its .sha256`);
      expect(calls.filter((call) => call.startsWith("docker run"))).toEqual([]);
      expect(installed(root, "appdata/pkg")).toBe("1.2.2");
    });

    it("refuses before changing anything, naming PACKAGE_SOURCE, where it is not set and the package is not at the version", async () => {
      const root = setUp({ conf: "" });
      const { status, output, calls } = await install(root);

      expect(status).toBe(2);
      expect(output).toContain("set PACKAGE_SOURCE=<owner>/<repo>");
      expect(output).toContain("Nothing was changed.");
      expect(calls.filter((call) => !call.startsWith("id "))).toEqual([]);
    });

    it("leaves the package at the version already installed alone, downloading nothing and needing no PACKAGE_SOURCE or terminal", async () => {
      const root = setUp({ conf: "" });
      const { status, output, calls } = await install(root, "1.2.2");

      expect(output).not.toContain("needs a terminal");
      expect(status).toBe(0);
      expect(output).toContain(`unchanged  ${NAME} 1.2.2`);
      expect(downloads(calls)).toEqual([]);
      expect(calls.filter((call) => call.startsWith("docker run --rm"))).toEqual([]);
    });
  });

  describe("install-box.sh", () => {
    // The script writes under /etc and /usr/local, so it cannot run whole here:
    // its "The package" section is run as it stands in the script, with the
    // settings and installed() it is reached with.
    const runSection = (root: string, version: string, env: Record<string, string> = {}) => {
      const text = fs.readFileSync(path.join(DEPLOY, "install-box.sh"), "utf8");
      const start = text.indexOf('echo "== The package"');
      const end = text.indexOf(`echo "== The worker's settings"`);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const definesInstalled = /^installed\(\) .*$/m.exec(text)?.[0];
      expect(definesInstalled).toBeDefined();
      fs.writeFileSync(
        path.join(root, "unraid", "box-package.sh"),
        [
          "set -euo pipefail",
          `. "$(dirname "$0")/agent-service.conf"`,
          `version=${version}`,
          `PKG_JSON=$PREFIX/${INSTALLED_PATH}`,
          definesInstalled,
          text.slice(start, end),
        ].join("\n"),
      );
      return runScript(root, "box-package.sh", [], { TMPDIR: path.join(root, "stage"), ...env });
    };

    it("installs a version that is not installed from the downloaded tarball, its digest checked, asking for no token", async () => {
      const root = setUp();
      const { status, output, calls } = await runSection(root, "1.2.3");

      expect(output).not.toMatch(/GitHub token|read:packages/);
      expect(status).toBe(0);
      expect(downloads(calls)).toEqual([RELEASE_URL, `${RELEASE_URL}.sha256`]);
      for (const call of calls.filter((c) => c.startsWith("curl "))) expect(call).toContain("--proto =https --proto-redir =https");
      const npm = calls.filter((call) => call.startsWith("npm "));
      expect(npm).toHaveLength(1);
      expect(npm[0]).toMatch(new RegExp(`^npm install --prefix ${root}/opt .*/${TARBALL.replaceAll(".", "\\.")}$`));
      expect(npm[0]).not.toContain("userconfig");
      expect(installed(root, "opt")).toBe("1.2.3");
      expect(fs.readdirSync(path.join(root, "stage"))).toEqual([]);
    });

    it.each([
      ["the tarball", TARBALL, RELEASE_URL],
      ["its .sha256", `${TARBALL}.sha256`, `${RELEASE_URL}.sha256`],
    ])("stops, naming the URL and leaving the package as it was, when %s cannot be downloaded", async (_what, file, url) => {
      const root = setUp();
      fs.rmSync(path.join(root, "release", file));
      const { status, output, calls } = await runSection(root, "1.2.3");

      expect(status).toBe(1);
      expect(output).toContain(`Could not download ${url}`);
      expect(calls.filter((call) => call.startsWith("npm"))).toEqual([]);
      expect(installed(root, "opt")).toBe("1.2.2");
      expect(fs.readdirSync(path.join(root, "stage"))).toEqual([]);
    });

    it("stops, naming the URL and leaving the package as it was, when the tarball does not match its .sha256", async () => {
      const root = setUp({ digest: "0".repeat(64) });
      const { status, output, calls } = await runSection(root, "1.2.3");

      expect(status).toBe(1);
      expect(output).toContain(`${RELEASE_URL} does not match its .sha256`);
      expect(calls.filter((call) => call.startsWith("npm"))).toEqual([]);
      expect(installed(root, "opt")).toBe("1.2.2");
    });

    it("leaves the package at the version already installed alone, downloading nothing", async () => {
      const root = setUp();
      const { status, output, calls } = await runSection(root, "1.2.2");

      expect(status).toBe(0);
      expect(output).toContain(`unchanged  ${NAME} 1.2.2`);
      expect(calls).toEqual([]);
    });

    it("refuses before changing anything, naming PACKAGE_SOURCE, where it is not set and the package is not at the version", async () => {
      const root = setUp({ conf: "" });
      fs.copyFileSync(path.join(DEPLOY, "install-box.sh"), path.join(root, "unraid", "install-box.sh"));
      const { status, output, calls } = await runScript(root, "install-box.sh", ["1.2.3"]);

      expect(status).toBe(2);
      expect(output).toContain("set PACKAGE_SOURCE=<owner>/<repo>");
      expect(output).toContain("Nothing was changed.");
      expect(calls.filter((call) => !call.startsWith("id "))).toEqual([]);
    });
  });
});

describe("the deploy scripts", () => {
  const scripts = fs.readdirSync(DEPLOY).filter((file) => file.endsWith(".sh"));

  it("use no registry token, and no doc of the deployment tells an operator to make one", async () => {
    expect(scripts).toContain("install-unraid.sh");
    expect(scripts).toContain("install-box.sh");
    const doc = fs.readFileSync(path.join(DEPLOY, "..", "..", "docs", "deploying-the-service.md"), "utf8");
    const workedExample = doc.slice(doc.indexOf("## A worked example: the maintainer's Unraid server"));
    expect(workedExample).not.toBe(doc);
    const texts: [string, string][] = [
      ...fs.readdirSync(DEPLOY).map((file): [string, string] => [file, fs.readFileSync(path.join(DEPLOY, file), "utf8")]),
      ["the deployment doc's worked example", workedExample],
    ];
    for (const [file, text] of texts) {
      for (const word of ["read:packages", "_authToken", "npm.pkg.github.com", "GitHub token", "registry route"]) {
        expect(text, `${file} names ${word}`).not.toContain(word);
      }
    }
  });

  it("name a tarball wherever a half's closing advice names the other half", async () => {
    for (const file of ["upgrade-unraid.sh", "upgrade-box.sh"]) {
      const text = fs.readFileSync(path.join(DEPLOY, file), "utf8");
      const advice = text.match(/\((upgrade-(?:box|unraid)\.sh [^,]*),/)?.[1];
      expect(advice, file).toBe(`upgrade-${file === "upgrade-box.sh" ? "unraid" : "box"}.sh $version <tarball>`);
    }
  });

  // CI's shellcheck runs without -x and knows no shell for a file with neither:
  // a script read with `.` names its shell in a directive instead (#737).
  it("name their shell on the first line, by a shebang or, for one read with ., a shellcheck directive", async () => {
    expect(scripts).toContain("dispatcher-container.sh");
    for (const file of scripts) {
      const first = fs.readFileSync(path.join(DEPLOY, file), "utf8").split("\n")[0];
      expect(first, file).toMatch(/^(#!\/usr\/bin\/env bash|# shellcheck shell=bash)$/);
    }
  });

  it("name no owner, address or account in the orchestrator", async () => {
    const text = fs.readFileSync(path.join(DEPLOY, "upgrade.sh"), "utf8");
    const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(text).not.toContain("jeffwlawson");
  });
});
