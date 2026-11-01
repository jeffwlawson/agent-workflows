import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
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

const STUBS: Record<string, string> = {
  id: `echo 0`,
  sleep: `exit 0`,
  sudo: `exec "$@"`,
  curl: `
out= url=
while [ $# -gt 0 ]; do
  case "$1" in -o|--proto|--proto-redir) [ "$1" = -o ] && out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
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
  if [ -n "\${FAKE_SCP_FAIL_AT:-}" ] && [ "$(basename "$f")" = "$FAKE_SCP_FAIL_AT" ]; then exit 1; fi
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
    if [ -n "\${FAKE_UNRAID_INSTALL_FAIL:-}" ]; then exit 1; fi
    name=$(sed -n 's/.*"name": *"\\([^"]*\\)".*/\\1/p' "$tgz")
    mkdir -p "$pkg/node_modules/$name" && cp "$tgz" "$pkg/node_modules/$name/package.json" ;;
  restart)
    if [ -n "\${FAKE_DISPATCHER_RESTART_FAIL:-}" ]; then exit 1; fi
    installed >"$FAKE/state/dispatcher-running" ;;
  exec)
    shift 3
    WORKER_URL=http://box.example:8787/jobs WORKER_SECRET='${SECRET}' exec "$1" --import "file://$FAKE/fetch.mjs" "\${@:2}" ;;
  inspect) echo 2026-10-31T00:00:00Z ;;
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
  fs.writeFileSync(path.join(root, "fetch.mjs"), FAKE_FETCH);
  if (setup.held !== undefined) fs.writeFileSync(path.join(root, "held-answers.json"), JSON.stringify(setup.held));
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
    if (setup.fresh !== true) fs.writeFileSync(installed, pkgJson("1.2.2", setup.installedExtra ?? ""));
  }
  // The dispatcher's install prefix, whose one dependency is the package.
  if (setup.fresh !== true) {
    fs.writeFileSync(path.join(root, "appdata", "pkg", "package.json"), `{\n  "dependencies": {\n    "${NAME}": "1.2.2"\n  }\n}\n`);
  }
  fs.writeFileSync(path.join(root, "state", "dispatcher-running"), "1.2.2\n");
  fs.writeFileSync(path.join(root, "state", "worker-running"), "1.2.2\n");
  const tarball = pkgJson("1.2.3");
  fs.writeFileSync(path.join(root, "release", TARBALL), tarball);
  const digest = setup.digest ?? createHash("sha256").update(tarball).digest("hex");
  fs.writeFileSync(path.join(root, "release", `${TARBALL}.sha256`), `${digest}  ${TARBALL}\n`);
  return root;
};

const run = (root: string, env: Record<string, string> = {}, args: readonly string[] = ["1.2.3"]) => {
  const result = spawnSync("bash", [path.join(root, "unraid", "upgrade.sh"), ...args], {
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

  it("downloads over https only, redirects included", () => {
    const { status, calls } = run(setUp());

    expect(status).toBe(0);
    const downloads = calls.filter((call) => call.startsWith("curl "));
    expect(downloads).toHaveLength(2);
    for (const call of downloads) expect(call).toContain("--proto =https --proto-redir =https");
  });

  it("stops before restarting the dispatcher when the worker's restart fails, and names the commands that finish", () => {
    const root = setUp();
    const { status, output, calls } = run(root, { FAKE_WORKER_RESTART_FAIL: "1" });

    expect(status).toBe(1);
    expect(calls.filter((call) => call.startsWith("docker restart"))).toEqual([]);
    expect(running(root, "dispatcher")).toBe("1.2.2");
    expect(output).toContain("the dispatcher was not restarted");
    expect(output).toMatch(/ssh -o UserKnownHostsFile=\S+\/unraid\/known_hosts -o StrictHostKeyChecking=accept-new -t admin@box\.example 'sudo bash ~\/upgrade-box\.sh --restart 1\.2\.3'/);
    expect(output).toContain(`bash ${root}/unraid/upgrade-unraid.sh --restart 1.2.3`);
    expect(output).not.toContain("got 409 from the worker, for about");
  });

  it("names the command that finishes when the dispatcher's restart fails after the worker's", () => {
    const root = setUp();
    const { status, output } = run(root, { FAKE_DISPATCHER_RESTART_FAIL: "1" });

    expect(status).toBe(1);
    expect(running(root, "worker")).toBe("1.2.3");
    expect(output).toContain(`Fix the cause, then finish on Unraid: bash ${root}/unraid/upgrade-unraid.sh --restart 1.2.3`);
    expect(output).not.toContain("got 409 from the worker, for about");
  });

  it("names the earlier version as the way back when the install on Unraid fails", () => {
    const root = setUp();
    const { status, output, calls } = run(root, { FAKE_UNRAID_INSTALL_FAIL: "1" });

    expect(status).toBe(1);
    expect(calls.filter((call) => /^(systemctl|docker) restart/.test(call))).toEqual([]);
    expect(installed(root, "opt")).toBe("1.2.3");
    expect(output).toContain(`To put the box back instead: bash ${root}/unraid/upgrade.sh 1.2.2.`);
    // An earlier release may carry no tarball, so the registry route is named too.
    expect(output).toMatch(/older release may not\.\nWhere it does not, use the registry route, .*-t admin@box\.example 'sudo bash ~\/install-box\.sh 1\.2\.2'/);
  });

  it("names the same way back when the install on the box fails", () => {
    const root = setUp();
    fs.rmSync(path.join(root, "bin", "npm"));
    fs.writeFileSync(path.join(root, "bin", "npm"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const { status, output, calls } = run(root);

    expect(status).toBe(1);
    expect(calls.filter((call) => call.startsWith("docker"))).toEqual([]);
    expect(output).toContain(`To put the box back instead: bash ${root}/unraid/upgrade.sh 1.2.2.`);
    expect(output).toContain("'sudo bash ~/install-box.sh 1.2.2'");
  });

  it("says which files may already be on the box when the copy fails partway", () => {
    const root = setUp();
    const { status, output, calls } = run(root, { FAKE_SCP_FAIL_AT: "check-box.sh" });

    expect(status).toBe(2);
    expect(output).toContain(`Could not copy all of ${TARBALL} ${TARBALL}.sha256 upgrade-box.sh check-box.sh agent-service.conf`);
    expect(output).toContain("Some may already be there");
    expect(output).not.toContain("Nothing was changed");
    expect(touches(calls)).toEqual([]);
  });

  it("upgrades onto machines with no package installed yet, printing no stray error", () => {
    const root = setUp({ fresh: true, conf: `PACKAGE_SOURCE=owner/repo\nPACKAGE_NAME=${NAME}` });
    const { status, output } = run(root);

    expect(output).not.toMatch(/no such file/i);
    expect(output).toContain("Installed now: none. Moving to 1.2.3.");
    expect(status).toBe(0);
    expect([installed(root, "appdata/pkg"), installed(root, "opt")]).toEqual(["1.2.3", "1.2.3"]);
  });

  it("refuses with no package installed and no PACKAGE_NAME, printing no stray error", () => {
    const { status, output } = run(setUp({ fresh: true }));

    expect(status).toBe(2);
    expect(output).not.toMatch(/no such file/i);
    expect(output).toContain("set PACKAGE_NAME");
  });

  it("says, with --now, that the worker's restart drops its queue, and how long the 409 window lasted", () => {
    const { output } = run(setUp(), {}, ["--now", "1.2.3"]);

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

    it("restarts at once where the worker holds no job, having asked once", () => {
      const root = setUp();
      const { status, output, calls } = run(root);

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

    it("asks the held door a signed read that names no instance, with the secret on no command line and in no output", () => {
      const root = setUp();
      const { status, output, calls } = run(root);

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

    it("waits while the worker holds a job, printing it and each change, and restarts once it holds none", () => {
      const root = setUp({
        held: [
          heldJobs(["implement", "owner/repo", 12], ["review", "owner/repo", 14]),
          heldJobs(["implement", "owner/repo", 12], ["review", "owner/repo", 14]),
          heldJobs(["review", "owner/repo", 14]),
          heldJobs(),
        ],
      });
      const { status, output, calls } = run(root);

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

    it("prints a heartbeat at a fixed interval while nothing held changes", () => {
      const same = heldJobs(["fix", "owner/repo", 7]);
      const root = setUp({ held: [...Array.from({ length: 11 }, () => same), heldJobs()] });
      const { status, output } = run(root);

      expect(status).toBe(0);
      expect(output.match(/Still waiting/g)).toHaveLength(1);
      expect(output).toContain("Still waiting, 5 of 90 minutes: the worker holds the same 1 job(s).");
    });

    it("restarts nothing past the bound, naming what is held, re-running and --now", () => {
      const root = setUp({ conf: "PACKAGE_SOURCE=owner/repo\nIDLE_WAIT_MINUTES=1", held: [heldJobs(["implement-prd", "owner/repo", 3])] });
      const { status, output, calls } = run(root);

      expect(status).toBe(1);
      expect(restarts(calls)).toEqual([]);
      expect(sleeps(calls)).toHaveLength(2);
      expect(output).toContain("The worker still holds 1 job(s) after 1 minutes:\n  implement-prd on owner/repo#3\n");
      expect(output).toContain("Both machines have 1.2.3 installed, and neither service was restarted.");
      expect(output).toContain("Run upgrade.sh 1.2.3 again later, or run upgrade.sh --now 1.2.3");
      expect([installed(root, "appdata/pkg"), installed(root, "opt")]).toEqual(["1.2.3", "1.2.3"]);
      expect([running(root, "dispatcher"), running(root, "worker")]).toEqual(["1.2.2", "1.2.2"]);
    });

    it("with --now, restarts without asking the worker", () => {
      const root = setUp({ held: [heldJobs(["implement", "owner/repo", 12])] });
      const { status, output, calls } = run(root, {}, ["--now", "1.2.3"]);

      expect(status).toBe(0);
      expect(calls.filter((call) => call.startsWith("docker exec"))).toEqual([]);
      expect(held(root)).toEqual([]);
      expect(output).toContain("--now: not asking the worker");
      expect(restarts(calls)).toHaveLength(2);
    });

    it.each([[[]], [["1.2.3", "--later"]], [["--now"]], [["1.2.3", "1.2.4"]]])("refuses %j with the usage line", (args) => {
      const root = setUp();
      const { status, output, calls } = run(root, {}, args);

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
    ])("stops before either restart on %s, naming --now", (_, answer, reason) => {
      const root = setUp({ held: [answer] });
      const { status, output, calls } = run(root);

      expect(status).toBe(1);
      expect(output).toContain(`Could not tell which jobs the worker holds: ${reason}.`);
      expect(output).toContain("Both machines have 1.2.3 installed, and neither service was restarted.");
      expect(output).toContain("run upgrade.sh --now 1.2.3");
      expect(restarts(calls)).toEqual([]);
      expect(output).not.toContain(SECRET);
    });

    it("stops on a worker it cannot ask partway through the wait", () => {
      const root = setUp({ held: [heldJobs(["fix", "owner/repo", 7]), "unreachable"] });
      const { status, output, calls } = run(root);

      expect(status).toBe(1);
      expect(output).toContain("Could not tell which jobs the worker holds, after waiting 0 minutes: the worker could not be reached");
      expect(output).toContain("--now");
      expect(restarts(calls)).toEqual([]);
    });

    it("stops where the dispatcher's container cannot be asked", () => {
      const root = setUp();
      fs.writeFileSync(path.join(root, "bin", "docker"), fs.readFileSync(path.join(root, "bin", "docker"), "utf8").replace("  exec)\n", "  exec)\n    echo 'Error: container agent-dispatcher is not running' >&2; exit 1\n"));
      const { status, output, calls } = run(root);

      expect(status).toBe(1);
      expect(output).toContain("the dispatcher's container, agent-dispatcher, could not be asked to ask it: Error: container agent-dispatcher is not running.");
      expect(output).toContain("--now");
      expect(restarts(calls)).toEqual([]);
    });

    it("says a worker with no held door cannot tell, and goes on once", () => {
      const root = setUp({ held: [{ status: 404, body: { refusal: "no such door" } }] });
      const { status, output, calls } = run(root);

      expect(status).toBe(0);
      expect(output).toContain("whether it holds a job cannot be told. Going on without waiting.");
      expect(output).toContain("Restarting the worker drops any job queued in it: its queue is in memory.");
      expect(held(root)).toHaveLength(1);
      expect(sleeps(calls)).toEqual([]);
      expect(restarts(calls)).toHaveLength(2);
    });

    it("refuses an IDLE_WAIT_MINUTES that is not a whole number", () => {
      const root = setUp({ conf: "PACKAGE_SOURCE=owner/repo\nIDLE_WAIT_MINUTES=an-hour" });
      const { status, output, calls } = run(root);

      expect(status).toBe(2);
      expect(output).toContain("IDLE_WAIT_MINUTES");
      expect(calls).toEqual(["id -u"]);
    });
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

  it("name a tarball wherever a half's closing advice names the other half", () => {
    for (const file of ["upgrade-unraid.sh", "upgrade-box.sh"]) {
      const text = fs.readFileSync(path.join(DEPLOY, file), "utf8");
      const advice = text.match(/\((upgrade-(?:box|unraid)\.sh [^,]*),/)?.[1];
      expect(advice, file).toBe(`upgrade-${file === "upgrade-box.sh" ? "unraid" : "box"}.sh $version <tarball>`);
    }
  });

  it("name no owner, address or account in the orchestrator", () => {
    const text = fs.readFileSync(path.join(DEPLOY, "upgrade.sh"), "utf8");
    const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(text).not.toContain("jeffwlawson");
  });
});
