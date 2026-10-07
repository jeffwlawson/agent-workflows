// The GitHub adapter: the only module that knows a payload is GitHub's, plus
// the write-back. Signature verification, event → Job, and posting the review.

import { createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Job } from "./job.ts";

/** GitHub's scheme, and the generic endpoint's too: `sha256=<hex HMAC of the raw body>`. */
export const verifySignature = (secret: string, body: Buffer, header: string | undefined): boolean => {
  if (header === undefined || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const sign = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/**
 * `pull_request` `labeled` with the trigger label → a review Job. Anything else
 * is ignored, which is the same routing the reusable's job-level `if:` does.
 * The fork guard is applied here too: review.yml carries it as a job `if:`, so a
 * second orchestrator has to re-establish it (finding).
 */
export const fromGitHub = (event: string | undefined, payload: unknown, label: string): Job | string => {
  if (event !== "pull_request") return `ignored event ${String(event)}`;
  const p = payload as {
    action?: string;
    label?: { name?: string };
    repository?: { full_name?: string };
    pull_request?: { number?: number; head?: { sha?: string; repo?: { full_name?: string } } };
  };
  if (p.action !== "labeled") return `ignored action ${String(p.action)}`;
  if (p.label?.name !== label) return `ignored label ${String(p.label?.name)}`;
  const repo = p.repository?.full_name;
  const pr = p.pull_request?.number;
  const headSha = p.pull_request?.head?.sha;
  if (repo === undefined || pr === undefined || headSha === undefined) return "payload is missing repo, number or head";
  if (p.pull_request?.head?.repo?.full_name !== repo) return "refused: head is on a fork";
  return { kind: "review", repo, pr, headSha, source: "github" };
};

/** `token`, when given, is the job's own token (minted by the dispatcher); otherwise gh's login. */
export const gh = (args: readonly string[], input?: string, token?: string): string =>
  execFileSync("gh", [...args], {
    encoding: "utf8",
    ...(token === undefined ? {} : { env: { ...process.env, GH_TOKEN: token } }),
    ...(input === undefined ? {} : { input }),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

export interface PullRequest {
  readonly state: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepo: string;
  readonly baseRef: string;
}

export const readPullRequest = (repo: string, pr: number, token?: string): PullRequest => {
  const j = JSON.parse(gh(["api", `repos/${repo}/pulls/${pr}`], undefined, token)) as {
    state: string;
    head: { ref: string; sha: string; repo: { full_name: string } | null };
    base: { ref: string };
  };
  return {
    state: j.state,
    headRef: j.head.ref,
    headSha: j.head.sha,
    headRepo: j.head.repo?.full_name ?? "",
    baseRef: j.base.ref,
  };
};

/**
 * One look at the PR's checks, no waiting: the event-driven version (start the
 * review when CI completes) is #361's to design. Writes what review.yml's
 * *Wait for other checks* step would, minus the polling.
 */
export const snapshotChecks = (repo: string, pr: number, statusFile: string, resultFile: string, token?: string): string => {
  let rows: { name: string; bucket: string }[];
  try {
    rows = JSON.parse(gh(["pr", "checks", String(pr), "--repo", repo, "--json", "name,bucket"], undefined, token)) as typeof rows;
  } catch (e) {
    // `gh pr checks` exits non-zero while checks fail or are pending, but still prints them.
    const out = (e as { stdout?: string }).stdout ?? "";
    try {
      rows = JSON.parse(out) as typeof rows;
    } catch {
      writeFileSync(statusFile, "(CI results could not be read by the prototype orchestrator.)\n");
      return "unknown";
    }
  }
  const lines = rows.map((r) => `- ${r.name}: ${r.bucket}`);
  writeFileSync(statusFile, `CI checks at the moment the review started (one snapshot, no waiting):\n\n${lines.join("\n")}\n`);
  const result =
    rows.length === 0 || rows.some((r) => r.bucket === "pending")
      ? "unknown"
      : rows.some((r) => r.bucket === "fail" || r.bucket === "cancel")
        ? "red"
        : "green";
  // `unknown` is the absence of the file, as the runner reads it.
  if (result !== "unknown") writeFileSync(resultFile, `${result}\n`);
  return result;
};

/**
 * Post the review the runner prepared, reproducing review.yml's *Post PR review*
 * step: the payload is a ready GraphQL request whose body carries one slot, into
 * which the two thread groups are rendered. This orchestrator resolves no
 * threads (review.yml's *Resolve the threads this review closed*), so every
 * thread-bearing line lands in the unclosed group.
 */
export const postReview = (outputDir: string, token?: string): string => {
  const payload = JSON.parse(readFileSync(path.join(outputDir, "review_payload.json"), "utf8")) as {
    variables: { input: { body: string } };
  };
  const parts = JSON.parse(readFileSync(path.join(outputDir, "review_body.json"), "utf8")) as {
    slotted: string;
    slot: string;
    resolved: { threadId: string | null; line: string }[];
    groups: Record<"unclosed" | "resolved", { title: string; subtitle?: string | null; open?: boolean }>;
  };
  const group = (head: (typeof parts.groups)["unclosed"], lines: string[]): string =>
    lines.length === 0
      ? ""
      : `\n\n${[
          `<details${head.open ? " open" : ""}>`,
          `<summary><b>${head.title}</b> (${lines.length})</summary>`,
          ...(head.subtitle ? ["", `_${head.subtitle}_`] : []),
          "",
          ...lines,
          "",
          "</details>",
        ].join("\n")}`;
  const unclosed = parts.resolved.filter((r) => r.threadId !== null).map((r) => r.line);
  const closed = parts.resolved.filter((r) => r.threadId === null).map((r) => r.line);
  const halves = parts.slotted.split(`\n\n${parts.slot}`);
  if (halves.length !== 2) throw new Error(`the review body carries its slot ${halves.length - 1} times`);
  payload.variables.input.body =
    halves[0] + group(parts.groups.unclosed, unclosed) + group(parts.groups.resolved, closed) + halves[1];
  const posted = path.join(outputDir, "review_posted.json");
  writeFileSync(posted, JSON.stringify(payload));
  return gh(["api", "graphql", "--input", posted, "--jq", ".data.addPullRequestReview.pullRequestReview.url"], undefined, token).trim();
};
