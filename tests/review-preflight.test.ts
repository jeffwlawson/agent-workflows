import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs `agent-review`'s pre-flight, the real `run:` block read out of
 * `.github/workflows/review.yml`, under `bash -e` against the recorded `gh` in
 * `tests/fixtures/gh-replay` and a **real** `git`, the seam
 * `tests/review-ci-wait.test.ts` built.
 *
 * What it executes is how the step settles on the commit a review is about
 * (#229). A label added the moment a run pushed can carry the commit before
 * the push, because GitHub moves a pull request's head asynchronously; #228's
 * review checked out and posted its verdict on that commit. The tip is read
 * with `git ls-remote` against a bare repository standing in for the remote,
 * so the half of the step that talks to git is not a replay at all.
 *
 * Skipped where `bash`, `git`, `jq` or `node` are not on PATH.
 */

const REVIEW = path.join(".github", "workflows", "review.yml");
const REPLAY_DIR = path.join("tests", "fixtures", "gh-replay");

interface Step {
  readonly id?: string;
  readonly shell?: string;
  readonly env?: Record<string, string>;
  readonly run?: string;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const guard = (): Step => {
  const step = ((parse(fs.readFileSync(REVIEW, "utf8")) as Workflow).jobs["review"]?.steps ?? []).find(
    (s) => s.id === "state",
  );

  expect(step).toBeDefined();
  return step as Step;
};

/** Bounded, for the reason `review-ci-wait.test.ts` gives its own copy. */
const onPath = (command: string): boolean =>
  process.platform === "win32"
    ? spawnSync("where", [command], { timeout: SUBPROCESS_TIMEOUT }).status === 0
    : spawnSync("sh", ["-c", `command -v ${command}`], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

const CAN_RUN = ["bash", "git", "jq", "node"].every(onPath);

const GH_REPO = "acme/widgets";
const BRANCH = "agent/issue-228-fix";
const PR = 228;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
  }).trim();

/**
 * A remote whose branch is at `after`, a child of `before`: the fix's push in
 * #228, `34c3fe5` then `cb00b28`. Served from `file://`, which `ls-remote`
 * reads as it would the `https://` remote the workflow names.
 */
interface Remote {
  /** What `GITHUB_SERVER_URL` names: the directory the bare repository is under. */
  readonly server: string;
  readonly before: string;
  readonly after: string;
}

const makeRemote = (): Remote => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-remote-"));
  const work = path.join(temp, "work");
  const server = path.join(temp, "server");
  const bare = path.join(server, ...GH_REPO.split("/")) + ".git";

  fs.mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", BRANCH);
  git(work, "commit", "-q", "--allow-empty", "-m", "before the fix");
  const before = git(work, "rev-parse", "HEAD");
  git(work, "commit", "-q", "--allow-empty", "-m", "the fix");
  const after = git(work, "rev-parse", "HEAD");
  git(temp, "clone", "-q", "--bare", work, bare);
  return { server, before, after };
};

/**
 * Built once, before the scenarios: it is six spawns, and a test making six
 * would need a ceiling of six times the one bound. The hook carries that
 * instead, and each scenario spawns once.
 */
const GIT_SPAWNS = 6;
let REMOTE: Remote | undefined;

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly outputs: Record<string, string>;
  /** Every tracker write, as argv. */
  readonly writes: readonly (readonly string[])[];
}

/**
 * The step's and the job's environment, which the harness supplies in place of
 * the event. `headRefOids` is what the pull request reports on each `pr view`.
 */
const runGuard = (options: {
  readonly payload: "before" | "after" | string;
  readonly headRefOids?: readonly ("before" | "after")[];
  readonly compare?: string;
  readonly compareUnreadable?: boolean;
  readonly noRemote?: boolean;
  readonly waitSeconds?: string;
}): Outcome & { readonly before: string; readonly after: string } => {
  if (REMOTE === undefined) throw new Error("the remote is built in beforeAll");
  const { server, before, after } = REMOTE;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-preflight-"));
  const sha = (name: string): string => (name === "before" ? before : name === "after" ? after : name);
  const script = path.join(temp, "step.sh");
  const output = path.join(temp, "github_output");
  const log = path.join(temp, "gh.log");
  const pulls = path.join(temp, "pulls.json");
  const compare = path.join(temp, "compare.json");

  fs.writeFileSync(script, guard().run ?? "");
  fs.writeFileSync(output, "");
  fs.writeFileSync(
    pulls,
    JSON.stringify([
      { number: PR, state: "OPEN", headRefName: BRANCH, headRefOids: (options.headRefOids ?? ["before"]).map(sha) },
    ]),
  );
  if (options.compare !== undefined) fs.writeFileSync(compare, JSON.stringify({ status: options.compare }));

  const ghDir = path.resolve(REPLAY_DIR);
  for (const file of fs.readdirSync(ghDir)) fs.chmodSync(path.join(ghDir, file), 0o755);

  const result = spawnSync("bash", ["-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      HEAD_SHA: sha(options.payload),
      HEAD_WAIT_SECONDS: options.waitSeconds ?? guard().env?.["HEAD_WAIT_SECONDS"] ?? "",
      HEAD_POLL_SECONDS: "0",
      PR_NUMBER: String(PR),
      PR_STATE: "open",
      PR_MERGED: "false",
      BRANCH,
      GH_REPO,
      GH_TOKEN: "test-token",
      GITHUB_SERVER_URL: options.noRemote === true ? `file://${path.join(temp, "nowhere")}` : `file://${server}`,
      GITHUB_OUTPUT: output,
      GH_REPLAY_PULLS: pulls,
      GH_REPLAY_VIEW_COUNTER: path.join(temp, "view.calls"),
      GH_REPLAY_LOG: log,
      ...(options.compare === undefined ? {} : { GH_REPLAY_COMPARE: compare }),
      ...(options.compareUnreadable === true ? { GH_REPLAY_COMPARE_FAILURE: "unreachable" } : {}),
      PATH: `${ghDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
    },
  });

  const outputs = Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const writes = fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[])
    : [];

  return { status: result.status, stdout: result.stdout ?? "", outputs, writes, before, after };
};

const comment = (outcome: Outcome): string =>
  outcome.writes.find((argv) => argv[0] === "pr" && argv[1] === "comment")?.join(" ") ?? "";

describe.skipIf(!CAN_RUN)("agent-review's pre-flight settles on one commit, executed", () => {
  beforeAll(() => {
    REMOTE = makeRemote();
  }, GIT_SPAWNS * SUBPROCESS_TIMEOUT);

  it("runs under the shell the workflow actually gets", () => {
    expect(guard().shell).toBeUndefined();
  });

  /**
   * The #228 sequence: the fix pushed and labelled at once, so the payload and
   * the pull request both still name the commit before the push, and the pull
   * request catches up a poll later. The review is of the pushed commit.
   */
  it("reviews the pushed commit when the label was added before the PR head moved", () => {
    const outcome = runGuard({ payload: "before", headRefOids: ["before", "before", "after"], compare: "ahead" });

    expect(outcome.status).toBe(0);
    expect(outcome.outputs["proceed"]).toBe("true");
    expect(outcome.outputs["sha"]).toBe(outcome.after);
    expect(outcome.writes).toHaveLength(0);
    expect(outcome.stdout).toContain(`so this run reviews ${outcome.after}`);
  });

  it("reviews the labelled commit, asking nothing more, when it is the tip", () => {
    // No comparison is recorded, so asking for one would refuse.
    const outcome = runGuard({ payload: "after" });

    expect(outcome.outputs["proceed"]).toBe("true");
    expect(outcome.outputs["sha"]).toBe(outcome.after);
    expect(outcome.writes).toHaveLength(0);
  });

  it.each(["diverged", "behind"])("refuses by name a tip that does not descend from the labelled commit (%s)", (relation) => {
    const stale = "0123456789abcdef0123456789abcdef01234567";
    const outcome = runGuard({ payload: stale, compare: relation });

    expect(outcome.outputs["proceed"]).toBe("false");
    expect(outcome.outputs["sha"]).toBeUndefined();
    expect(comment(outcome)).toContain("moved while this run was queued");
    expect(comment(outcome)).toContain(stale);
    expect(comment(outcome)).toContain(outcome.after);
    expect(outcome.writes.map((argv) => argv.join(" "))).toContain(`pr edit ${PR} --add-label agent:blocked`);
  });

  it("refuses by name when whether the tip descends cannot be read", () => {
    const outcome = runGuard({ payload: "before", compareUnreadable: true });

    expect(outcome.outputs["proceed"]).toBe("false");
    expect(comment(outcome)).toContain(outcome.before);
    expect(comment(outcome)).toContain(outcome.after);
    expect(comment(outcome)).toContain("could not be read");
  });

  it("refuses by name when the PR never shows the tip as its head", () => {
    const outcome = runGuard({ payload: "before", headRefOids: ["before"], compare: "ahead", waitSeconds: "0" });

    expect(outcome.outputs["proceed"]).toBe("false");
    expect(outcome.outputs["sha"]).toBeUndefined();
    expect(comment(outcome)).toContain(`still shows \`${outcome.before}\``);
    expect(comment(outcome)).toContain(outcome.after);
  });

  /** An unreadable tip is not evidence the branch moved, and this run only reads. */
  it("proceeds on the labelled commit, with a warning, when the tip cannot be read", () => {
    const outcome = runGuard({ payload: "before", noRemote: true });

    expect(outcome.outputs["proceed"]).toBe("true");
    expect(outcome.outputs["sha"]).toBe(outcome.before);
    expect(outcome.stdout).toContain("::warning::Could not read the tip");
  });
});
