/**
 * PROTOTYPE (#399), throwaway. `review:publish` and `review:conclude` run
 * against a fake GitHub at the transport, so the real writer's caps, log and
 * reply-then-resolve coupling are what is exercised. Each scenario writes its
 * write log to `prototype/review-publish/logs/` for the ticket to link.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubError, type RestRequest, type Transport } from "../engine/github.js";
import { githubReader } from "../engine/read.js";
import { createWriters, type Caps, type LogEntry } from "../engine/writer.js";
import { COMMANDS } from "../shared/contract.js";
import { STATUS_END, STATUS_START } from "../shared/progress-list.js";
import { REVIEW_URL_SLOT } from "../shared/prd-round.js";
import { SUMMARY_END, SUMMARY_START } from "../shared/pr-summary.js";
import { FIX_ROUND_STATUS, RESOLVED_SLOT, VERDICT_CONTEXT } from "../shared/review-output.js";
import { CONCLUDE_CAPS, PUBLISH_CAPS } from "../review/commands.js";
import { conclude, type ConcludeInputs, type Ended } from "../review/conclude.js";
import { directory, HandOverError, NO_CLEANUP, readReviewHandOver, readVerdict, type Cleanup } from "../review/hand-over.js";
import { publish } from "../review/publish.js";

const REPO = "o/r";
const PR = 7;
const SHA = "a".repeat(40);
const BOT = "github-actions[bot]";
const LOGS = path.join("prototype", "review-publish", "logs");

/** One pull request's worth of GitHub, in memory, failing wherever `failOn` says. */
class FakeGitHub {
  body = `> [!NOTE]\n${STATUS_START}\n> **🔍 In review:** waiting for its first review.\n> ${STATUS_END}\n\nCloses #3\n\nA maintainer's paragraph.`;
  title = "Old title";
  labels = new Set(["agent:review", "agent:blocked"]);
  draft = true;
  head = SHA;
  threads = new Map<string, { replies: string[]; resolved?: string }>([
    ["T1", { replies: [] }],
    ["T2", { replies: [] }],
  ]);
  statuses: { context: string; state: string; target_url: string | null; creator: { login: string } }[] = [];
  reviews: string[] = [];
  comments: { token: string; body: string }[] = [];
  calls: string[] = [];
  failOn: (call: string) => boolean = () => false;

  transport(token: string): Transport {
    const check = (call: string): void => {
      this.calls.push(`${token}: ${call}`);
      if (this.failOn(`${token}: ${call}`)) throw new GitHubError(`${call}: 422 refused by the fake`, 422);
    };
    const pull = () => ({
      number: PR,
      node_id: "PR_node",
      state: "open",
      draft: this.draft,
      title: this.title,
      body: this.body,
      head: { sha: this.head },
      labels: [...this.labels].map((name) => ({ name })),
    });
    return {
      rest: async ({ method, path: p, body }: RestRequest) => {
        check(`${method} ${p}`);
        const b = body as Record<string, unknown> | undefined;
        if (method === "GET" && p === `/repos/${REPO}/pulls/${PR}`) return pull();
        if (method === "PATCH" && p === `/repos/${REPO}/pulls/${PR}`) {
          if (typeof b?.["title"] === "string") this.title = b["title"];
          if (typeof b?.["body"] === "string") this.body = b["body"];
          return pull();
        }
        if (method === "POST" && p.endsWith("/labels")) {
          for (const l of b?.["labels"] as string[]) this.labels.add(l);
          return [];
        }
        const label = /\/labels\/(.+)$/.exec(p);
        if (method === "DELETE" && label !== null) {
          const name = decodeURIComponent(label[1] ?? "");
          if (!this.labels.delete(name)) throw new GitHubError("Label does not exist", 404);
          return undefined;
        }
        if (method === "POST" && p.endsWith("/comments")) {
          this.comments.push({ token, body: b?.["body"] as string });
          return { html_url: `https://github.com/${REPO}/pull/${PR}#issuecomment-${this.comments.length}` };
        }
        if (method === "POST" && p.includes("/statuses/")) {
          this.statuses.unshift({
            context: b?.["context"] as string,
            state: b?.["state"] as string,
            target_url: (b?.["target_url"] as string | undefined) ?? null,
            creator: { login: token === "workflow" ? BOT : "loop-app[bot]" },
          });
          return {};
        }
        if (method === "GET" && p.includes("/statuses")) return this.statuses;
        throw new Error(`fake has no route for ${method} ${p}`);
      },
      graphql: async (query, variables) => {
        const name = /\{\s*(\w+)/.exec(query.replace(/^(mutation|query)[^{]*/, ""))?.[1] ?? "?";
        check(`graphql ${name}${variables["threadId"] === undefined ? "" : ` ${String(variables["threadId"])}`}`);
        if (name === "repository") return { repository: { pullRequest: { reviewThreads: { nodes: [...this.threads.keys()].map((id) => ({ id })) } } } };
        if (name === "addPullRequestReviewThreadReply") {
          this.threads.get(variables["threadId"] as string)?.replies.push(variables["body"] as string);
          return {};
        }
        if (name === "resolveReviewThread") {
          const t = this.threads.get(variables["threadId"] as string);
          if (t !== undefined) t.resolved = variables["reason"] as string;
          return {};
        }
        if (name === "addPullRequestReview") {
          this.reviews.push((variables["input"] as { body: string }).body);
          return { addPullRequestReview: { pullRequestReview: { url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-${this.reviews.length}` } } };
        }
        if (name === "markPullRequestReadyForReview") {
          this.draft = false;
          return {};
        }
        throw new Error(`fake has no graphql for ${name}`);
      },
    };
  }
}

/** The runner's hand-over, as `review/review.ts` writes it today. */
const handOverDir = (overrides: Record<string, unknown> = {}): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handover-"));
  const files: Record<string, unknown> = {
    "review_payload.json": {
      query: "mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { url } } }",
      variables: {
        input: {
          pullRequestId: "PR_node",
          commitOID: SHA,
          event: "COMMENT",
          body: "the body where every closure held",
          threads: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "🟠 **Should fix:** a new finding <!-- agent-review:finding f-9 -->" }],
        },
      },
    },
    "review_body.json": {
      slotted: `## Review\n\nOne new finding.\n\n${RESOLVED_SLOT}\n\n<!-- agent-review:follow-ups [] -->`,
      slot: RESOLVED_SLOT,
      resolved: [
        { threadId: "T1", line: "- ~~First finding~~ fixed" },
        { threadId: "T2", line: "- ~~Second finding~~ fixed" },
      ],
      groups: { resolved: { title: "Resolved since last review", open: false }, unclosed: { title: "Closed, but still open on GitHub", open: true } },
    },
    "verdict.json": {
      context: VERDICT_CONTEXT,
      verdict: "changes recommended",
      state: "failure",
      description: "Changes recommended: one finding to fix.",
      fixRound: FIX_ROUND_STATUS,
    },
    "thread_resolutions.json": [
      { threadId: "T1", findingId: "f-1", reason: "ADDRESSED", reply: "**Verified fixed.** <!-- agent-review:resolution ADDRESSED -->", alreadyReplied: false },
      { threadId: "T2", findingId: "f-2", reason: "ADDRESSED", reply: "**Verified fixed.** <!-- agent-review:resolution ADDRESSED -->", alreadyReplied: false },
    ],
    "pr_summary.json": { title: "Add the thing", summary: { start: SUMMARY_START, end: SUMMARY_END, inner: `<!-- agent:summary-head ${SHA} -->\nWhat it does.` } },
    "pr_status.md": `${STATUS_START}\n> **🔧 Fixing:** 1 finding open. [See it](${REVIEW_URL_SLOT})\n> ${STATUS_END}`,
    "follow_ups.md": "the follow-ups block",
    ...overrides,
  };
  for (const [name, value] of Object.entries(files)) {
    if (value === undefined) continue;
    fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
};

const CONCLUDE_BASE: ConcludeInputs = {
  prNumber: PR,
  headRef: "agent/issue-3",
  reviewedSha: SHA,
  proceeded: "true",
  reviewResult: "success",
  refusal: "",
  blocked: false,
  reviewFailureReason: "",
  reviewRefusalReason: "",
  timedOut: false,
  timeoutMinutes: "30",
  mintOutcome: "success",
  publishOutcome: "success",
  loopTokenSource: "app",
  runUrl: "https://github.com/o/r/actions/runs/1",
  loopAccount: BOT,
};

const render = (title: string, log: readonly LogEntry[], warnings: readonly string[], extra = ""): string =>
  [
    `# ${title}`,
    "",
    "| # | token | write | target | outcome | calls |",
    "|---|---|---|---|---|---|",
    ...log.map((e) => `| ${e.seq} | ${e.token} | ${e.type} | \`${e.target}\` | **${e.outcome}** | ${e.calls.join("; ").replace(/\|/g, "\\|")} |`),
    "",
    ...(warnings.length === 0 ? [] : ["Warnings:", "", ...warnings.map((w) => `- ${w}`), ""]),
    extra,
  ].join("\n");

/** Publish, then conclude with publish's outcome, the way the two steps run in one job. */
const run = async (
  name: string,
  gh: FakeGitHub,
  options: { dir?: string; conclude?: Partial<ConcludeInputs>; skipPublish?: boolean; cleanup?: Cleanup; caps?: Caps } = {},
) => {
  const dir = options.dir ?? handOverDir();
  const log: LogEntry[] = [];
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);
  const published: { reviewUrl?: string; failureReason?: string } = {};
  let publishOutcome = "skipped";
  let publishError: unknown;
  const reader = githubReader(REPO, gh.transport("workflow"));

  if (options.skipPublish !== true) {
    const { writers } = createWriters({
      repo: REPO,
      transports: { workflow: gh.transport("workflow"), loop: gh.transport("loop") },
      caps: options.caps ?? PUBLISH_CAPS,
      sink: (e) => log.push({ ...e, token: `publish/${e.token}` }),
    });
    try {
      const handOver = readReviewHandOver(directory(dir, COMMANDS["review:publish"].reads.REVIEW_DIR), { reviewedSha: SHA }, options.cleanup ?? NO_CLEANUP);
      await publish(
        { prNumber: PR, headRef: options.conclude?.headRef ?? "agent/issue-3", reviewedSha: SHA, round: "" },
        { ...writers, github: reader, handOver, warn, published: (v) => (published.reviewUrl = v.reviewUrl) },
      );
      publishOutcome = "success";
    } catch (error) {
      publishOutcome = "failure";
      publishError = error;
      published.failureReason = error instanceof Error ? error.message : String(error);
    }
  }

  const { writers: c } = createWriters({
    repo: REPO,
    transports: { workflow: gh.transport("workflow"), loop: gh.transport("loop") },
    caps: CONCLUDE_CAPS,
    sink: (e) => log.push({ ...e, seq: log.length + 1, token: `conclude/${e.token}` }),
  });
  let ended: Ended | undefined;
  let concludeError: unknown;
  try {
    ended = await conclude(
      { ...CONCLUDE_BASE, publishOutcome, ...options.conclude },
      {
        ...c,
        github: reader,
        published: () => ({ reviewUrl: published.reviewUrl, failureReason: published.failureReason }),
        verdict: () => readVerdict(directory(dir, COMMANDS["review:conclude"].reads.REVIEW_DIR).json("verdict.json")),
        warn,
      },
    );
  } catch (error) {
    concludeError = error;
  }
  const relog = log.map((e, i) => ({ ...e, seq: i + 1 }));
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(
    path.join(LOGS, `${name}.md`),
    render(
      name,
      relog,
      warnings,
      [
        `publish: **${publishOutcome}**${publishError === undefined ? "" : ` (${String(publishError)})`}`,
        `conclude: **${concludeError === undefined ? "success" : "failure"}**${concludeError === undefined ? "" : ` (${String(concludeError)})`}`,
        `ended: \`${JSON.stringify(ended)}\``,
        `labels after: \`${[...gh.labels].join(", ")}\``,
      ].join("\n\n"),
    ),
  );
  return { log: relog, warnings, publishOutcome, publishError, ended, concludeError };
};

describe("PROTOTYPE #399: review:publish and review:conclude", () => {
  it("posts a changes-recommended review and hands off to a fix round, in the loop's one order", async () => {
    const gh = new FakeGitHub();
    const r = await run("01-fix-round", gh);
    expect(r.publishOutcome).toBe("success");
    expect(r.log.map((e) => `${e.token} ${e.type}`)).toEqual([
      "publish/workflow removeLabel",
      "publish/workflow replyAndResolve",
      "publish/workflow replyAndResolve",
      "publish/workflow postReview",
      "publish/workflow editPullRequest",
      "publish/workflow editPullRequest",
      "publish/workflow addLabel",
      "publish/workflow commitStatus",
      "publish/workflow commitStatus",
      "conclude/workflow removeLabel",
      "conclude/loop removeLabel",
      "conclude/loop addLabel",
    ]);
    expect(gh.reviews[0]).toContain("<summary><b>Resolved since last review</b> (2)</summary>");
    expect(gh.body).toContain("**🔧 Fixing:** 1 finding open. [See it](https://github.com/o/r/pull/7#pullrequestreview-1)");
    expect(gh.body).toContain("A maintainer's paragraph.");
    expect(gh.draft).toBe(true);
    expect([...gh.labels].sort()).toEqual(["agent:fix", "agent:follow-ups"]);
  });

  it("lists a thread whose resolve failed as still open, and carries on", async () => {
    const gh = new FakeGitHub();
    gh.failOn = (call) => call === "workflow: graphql resolveReviewThread T2";
    const r = await run("02-one-resolve-fails", gh);
    expect(r.publishOutcome).toBe("success");
    const t2 = r.log.find((e) => e.target.startsWith("T2"));
    expect(t2?.outcome).toBe("failed");
    expect(t2?.calls).toEqual(["reply ok", expect.stringContaining("resolve")]);
    expect(gh.reviews[0]).toContain("<summary><b>Closed, but still open on GitHub</b> (1)</summary>");
  });

  it("stops at a refused review, and conclude says so where the verdict goes", async () => {
    const gh = new FakeGitHub();
    gh.failOn = (call) => call === "workflow: graphql addPullRequestReview";
    const r = await run("03-review-refused", gh);
    expect(r.publishOutcome).toBe("failure");
    expect(r.log.map((e) => `${e.type}:${e.outcome}`)).toEqual([
      "removeLabel:applied",
      "replyAndResolve:applied",
      "replyAndResolve:applied",
      "postReview:failed",
      "commitStatus:applied",
      "comment:applied",
      "removeLabel:applied",
      "addLabel:applied",
    ]);
    expect(gh.statuses[0]?.state).toBe("error");
    expect(gh.comments[0]?.body).toContain("GitHub refused the review, so it was not posted.");
    expect([...gh.labels]).toEqual(["agent:follow-ups", "agent:blocked"].filter((l) => gh.labels.has(l)));
  });

  it("refuses a payload for another commit before the first write", async () => {
    const gh = new FakeGitHub();
    const dir = handOverDir();
    const payload = JSON.parse(fs.readFileSync(path.join(dir, "review_payload.json"), "utf8"));
    payload.variables.input.commitOID = "b".repeat(40);
    fs.writeFileSync(path.join(dir, "review_payload.json"), JSON.stringify(payload));
    const r = await run("04-commit-mismatch", gh, { dir });
    expect(r.publishError).toBeInstanceOf(HandOverError);
    expect(r.log.filter((e) => e.token.startsWith("publish"))).toEqual([]);
  });

  it("refuses a thread id that is not on the pull request before replying to anything", async () => {
    const gh = new FakeGitHub();
    const dir = handOverDir({
      "thread_resolutions.json": [{ threadId: "T-elsewhere", findingId: "f", reason: "ADDRESSED", reply: "x", alreadyReplied: false }],
    });
    const r = await run("05-stray-thread", gh, { dir });
    expect(String(r.publishError)).toContain("T-elsewhere");
    expect(r.log.filter((e) => e.type === "replyAndResolve")).toEqual([]);
  });

  it("re-requests the review, and starts no round, where the head moved", async () => {
    const gh = new FakeGitHub();
    const r = await (async () => {
      const original = gh.transport.bind(gh);
      // The head moves once publish has posted.
      gh.transport = (token) => {
        const t = original(token);
        return { ...t, graphql: async (q, v) => { const a = await t.graphql(q, v); if (q.includes("addPullRequestReview(")) gh.head = "c".repeat(40); return a; } };
      };
      return run("06-head-moved", gh);
    })();
    expect(r.ended?.moved).toBe(true);
    expect(gh.labels.has("agent:review")).toBe(true);
    expect(gh.labels.has("agent:fix")).toBe(false);
  });

  it("ends red without an error verdict where only the fix round's hand-off failed", async () => {
    const gh = new FakeGitHub();
    gh.failOn = (call) => call === "loop: POST /repos/o/r/issues/7/labels";
    const r = await run("07-hand-off-fails", gh);
    expect(r.publishOutcome).toBe("success");
    expect(String(r.concludeError)).toContain("No fix round started");
    expect(gh.statuses.some((s) => s.state === "error")).toBe(false);
    expect(gh.draft).toBe(false);
  });

  it("reports a mint that failed, with publish skipped and no loop writer", async () => {
    const gh = new FakeGitHub();
    const r = await run("08-mint-failed", gh, { skipPublish: true, conclude: { mintOutcome: "failure", loopTokenSource: "" } });
    expect(gh.comments[0]?.body).toContain("The loop's token could not be minted.");
    expect(r.log.every((e) => e.token === "conclude/workflow")).toBe(true);
  });

  it("refuses the write past a cap, and stops", async () => {
    const gh = new FakeGitHub();
    const r = await run("09-cap", gh, { caps: { ...PUBLISH_CAPS, replyAndResolve: 1 } });
    expect(r.publishOutcome).toBe("failure");
    expect(r.log.find((e) => e.outcome === "refused")?.calls).toEqual(["cap of 1 replyAndResolve reached"]);
  });

  it("FINDING: cleaning at read cannot tell the loop's markers from the agent's text", async () => {
    // The obvious cleanup, and what `withoutComments` in shared/review-output.ts already does to agent text.
    const stripComments: Cleanup = (text) => text.replace(/<!--[\s\S]*?-->/g, "");
    const handOver = readReviewHandOver(directory(handOverDir(), COMMANDS["review:publish"].reads.REVIEW_DIR), { reviewedSha: SHA }, stripComments);
    // The runner composed loop strings into the agent's text before the hand-over, so they go too:
    expect(handOver.resolutions[0]?.reply).not.toContain("agent-review:resolution"); // what `alreadyReplied` is read from
    expect(handOver.body.slotted).not.toContain("agent-review:follow-ups"); // what follow-ups:file reads
    expect(handOver.summary?.block?.inner).not.toContain("agent:summary-head"); // what `summaryDue` reads
  });
});

describe("PROTOTYPE #399: the engine imports nothing from the loop (ADR 0002)", () => {
  const relativeImports = (file: string): string[] =>
    [...fs.readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)].map((m) => path.resolve(path.dirname(file), m[1] ?? ""));

  it("every relative import under engine/ resolves inside engine/", () => {
    const engine = path.resolve("engine");
    for (const file of fs.readdirSync(engine).filter((f) => f.endsWith(".ts"))) {
      for (const target of relativeImports(path.join(engine, file))) expect(target.startsWith(engine + path.sep), `${file} imports ${target}`).toBe(true);
    }
  });

  it("FINDING: review:publish reaches the agent driver through the record strings' module", () => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^".][^"]*)"/gm)) packages.add(m[1] ?? "");
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm)) walk(path.resolve(path.dirname(file), (m[1] ?? "").replace(/\.js$/, ".ts")));
    };
    walk(path.resolve("review/publish.ts"));
    expect(packages.has("@ai-hero/sandcastle")).toBe(true);
  });
});
