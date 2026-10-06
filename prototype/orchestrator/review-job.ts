// The core: one review Job → a checkout, the existing `review` runner, and the
// result posted back. What review.yml spreads over five jobs, in one process,
// with every place this had to fake or replicate the workflow logged (#364's
// deliverable).

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Job } from "./job.ts";
import { postReview, readPullRequest, snapshotChecks } from "./github.ts";

export interface Config {
  readonly runnerCli: string;
  readonly claudeToken: string;
  /** The token the runner reads GitHub with, before it scrubs it. */
  readonly readToken: string;
  /** `none` (the runners' own `noSandbox()`), `docker` or `podman`. */
  readonly sandbox: string;
  readonly model?: string;
  readonly timeoutMs: number;
  /** Prepended to PATH, so the runner finds the orchestrator's own `claude`. */
  readonly pathPrefix: string;
  /** Directories a `bwrap` sandbox sees read-only: Node, and the agent's CLI. */
  readonly toolchain: readonly string[];
}

export interface RunRecord {
  readonly job: Job;
  readonly workDir: string;
  readonly outcome: "posted" | "refused" | "failed";
  readonly detail: string;
  /** Each place the orchestrator stood in for review.yml. */
  readonly stoodIn: readonly string[];
}

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const runReview = async (job: Job, cfg: Config, log: (line: string) => void): Promise<RunRecord> => {
  const stoodIn: string[] = [];
  const workDir = mkdtempSync(path.join(tmpdir(), `orch-${job.repo.replace("/", "-")}-${job.pr}-`));
  const done = (outcome: RunRecord["outcome"], detail: string): RunRecord => {
    const record = { job, workDir, outcome, detail, stoodIn };
    writeFileSync(path.join(workDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    log(`${outcome}: ${detail}`);
    return record;
  };

  // Pre-flight, as review.yml's `review` job does before anything is checked out.
  const pr = readPullRequest(job.repo, job.pr);
  stoodIn.push("pre-flight: refuse a closed PR, a fork head, or a head that moved (review.yml *Pre-flight*)");
  if (pr.state !== "open") return done("refused", `PR is ${pr.state}`);
  if (pr.headRepo !== job.repo) return done("refused", "head is on a fork");
  if (job.headSha !== undefined && job.headSha !== pr.headSha) {
    return done("refused", `head moved: asked for ${job.headSha.slice(0, 7)}, PR is at ${pr.headSha.slice(0, 7)}`);
  }

  // The checkout review.yml makes: the PR head on its own branch name, and the
  // base as a *local* branch, which the runner diffs against.
  const checkout = path.join(workDir, "checkout");
  log(`cloning ${job.repo} at ${pr.headSha.slice(0, 7)}`);
  execFileSync("gh", ["repo", "clone", job.repo, checkout, "--", "--no-tags", "--quiet"], { stdio: "ignore" });
  // Detach first: git refuses to fetch into the branch the clone checked out.
  git(checkout, ["checkout", "--quiet", "--detach"]);
  git(checkout, ["fetch", "--quiet", "origin", `+refs/heads/${pr.baseRef}:refs/heads/${pr.baseRef}`]);
  git(checkout, ["fetch", "--quiet", "origin", pr.headSha]);
  git(checkout, ["checkout", "--quiet", "-B", pr.headRef, pr.headSha]);
  stoodIn.push("checkout: PR head as BRANCH, BASE_REF as a local branch (review.yml *Checkout PR head*, *Make the PR base available*)");
  stoodIn.push("no `setup` input run (review.yml runs the adopter's `npm ci` on the head before the agent)");

  // A fresh OUTPUT_DIR: several of its files mean something by existing (#59).
  const outputDir = path.join(workDir, "output");
  execFileSync("mkdir", ["-p", outputDir]);
  const statusFile = path.join(workDir, "ci_status.md");
  const resultFile = path.join(workDir, "ci_result.txt");
  const ci = snapshotChecks(job.repo, job.pr, statusFile, resultFile);
  stoodIn.push(`CI evidence: one snapshot (${ci}), no waiting (review.yml polls up to 900 s; #361)`);
  stoodIn.push("no fix-round budget, round detection, red check or auto-fix (review.yml *Settle the fix-round budget*, *Tell a slice round*, `red-check`)");

  // An allowlisted environment, never this process's: the agent sees whatever
  // the runner is started with, minus three GitHub tokens (#59).
  const home = path.join(workDir, "home");
  execFileSync("mkdir", ["-p", home]);
  const env: Record<string, string> = {
    PATH: `${cfg.pathPrefix}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: home,
    LANG: process.env["LANG"] ?? "C.UTF-8",
    GH_TOKEN: cfg.readToken,
    GH_REPO: job.repo,
    PR_NUMBER: String(job.pr),
    BRANCH: pr.headRef,
    BASE_REF: pr.baseRef,
    OUTPUT_DIR: outputDir,
    CI_STATUS_FILE: statusFile,
    CI_RESULT_FILE: resultFile,
    CLAUDE_CODE_OAUTH_TOKEN: cfg.claudeToken,
    AGENT_SANDBOX: cfg.sandbox,
    // For `bwrap`: the toolchain the sandbox may see, read-only, and its PATH.
    AGENT_SANDBOX_RO_BINDS: cfg.toolchain.join(":"),
    AGENT_SANDBOX_PATH: `${cfg.toolchain.map((d) => `${d}/bin:${d}/node_modules/.bin`).join(":")}:/usr/local/bin:/usr/bin:/bin`,
    // Actions sets these on its own; the runner renders links from them (#59).
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: job.repo,
    ...(cfg.model === undefined ? {} : { AGENT_MODEL_REVIEW: cfg.model }),
  };
  stoodIn.push("env: GITHUB_SERVER_URL and GITHUB_REPOSITORY faked; GITHUB_RUN_ID absent, so the review links no run");
  stoodIn.push("env: HOME is an empty directory, so the agent does not inherit the host's gh or git credentials *through HOME* — an absolute path still reaches them under `none`");

  log(`running the review runner (sandbox: ${cfg.sandbox})`);
  const logFile = path.join(workDir, "runner.log");
  const code = await new Promise<number>((resolve) => {
    const out = createWriteStream(logFile);
    const child = spawn(process.execPath, [cfg.runnerCli, "review"], { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    const timer = setTimeout(() => child.kill("SIGTERM"), cfg.timeoutMs);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
  });
  log(`runner exited ${code}; log at ${logFile}`);

  const reasonFile = path.join(outputDir, "failure_reason.txt");
  if (code !== 0) {
    const reason = existsSync(reasonFile) ? readFileSync(reasonFile, "utf8").trim() : "no failure_reason.txt written";
    return done("failed", reason);
  }

  // What `post-review` does, cut down to the review itself. Posted with this
  // orchestrator's token, so as *its* identity, not `github-actions[bot]` (#59).
  const url = postReview(outputDir);
  stoodIn.push("posted the review only: no thread resolution, verdict status, PR title/body, labels or advance (review.yml `post-review`, `advance`)");
  stoodIn.push("posted as the orchestrator's identity, not github-actions[bot]: the loop's next Actions run would not recognise it");
  const verdict = existsSync(path.join(outputDir, "verdict.json"))
    ? (JSON.parse(readFileSync(path.join(outputDir, "verdict.json"), "utf8")) as { verdict?: string }).verdict
    : undefined;
  return done("posted", `${url}${verdict === undefined ? "" : ` (verdict: ${verdict}, not posted as a status)`}`);
};
