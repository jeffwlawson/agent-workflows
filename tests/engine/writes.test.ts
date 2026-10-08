/**
 * The GitHub half of each write, and the reader, over a transport that
 * records what it was asked and answers from a script: the requests a run
 * sends, with the mutations the engine owns.
 */
import { describe, expect, it } from "vitest";
import { GitHubError, isServerError, type RestRequest, type Transport } from "../../engine/github.js";
import { githubReader } from "../../engine/read.js";
import { ADD_REVIEW, githubWrites, MARK_READY, REPLY_TO_THREAD, RESOLVE_THREAD } from "../../engine/writes.js";
import { createWriters, WriteFailed, type PullRequestEdit } from "../../engine/writer.js";
import { fakeGitHub, fakeWriters } from "./fakes.js";

const REPO = "o/r";
const SHA = "b".repeat(40);

type Sent = { readonly rest: RestRequest } | { readonly query: string; readonly variables: Readonly<Record<string, unknown>> };

/** A transport answering each call with `answer`'s value, or its throw, and keeping every call sent. */
const recording = (answer: (sent: Sent) => unknown = () => ({})): { readonly transport: Transport; readonly sent: Sent[] } => {
  const sent: Sent[] = [];
  return {
    sent,
    transport: {
      rest: async (rest) => {
        sent.push({ rest });
        return answer({ rest });
      },
      graphql: async (query, variables) => {
        sent.push({ query, variables });
        return answer({ query, variables });
      },
    },
  };
};

const rawPull = (fields: { draft?: boolean; body?: string | null; title?: string } = {}) => ({
  number: 7,
  node_id: "PR_7",
  state: "open",
  draft: fields.draft ?? false,
  title: fields.title ?? "Title",
  body: fields.body === undefined ? "Body" : fields.body,
  head: { sha: SHA },
  labels: [{ name: "agent:x" }],
});

const writerOver = (transport: Transport) =>
  createWriters({
    backends: { workflow: githubWrites(REPO, transport) },
    limits: {
      addLabel: 9,
      removeLabel: 9,
      setCommitStatus: 9,
      comment: 9,
      markReadyForReview: 9,
      postReview: 9,
      replyAndResolve: 9,
      editPullRequest: 9,
    },
    appendLine: () => undefined,
  });

describe("githubWrites", () => {
  it("posts a review with the engine's own mutation and event, from the variables alone", async () => {
    const { transport, sent } = recording(() => ({ addPullRequestReview: { pullRequestReview: { url: "https://r/1" } } }));
    const variables = {
      pullRequestId: "PR_7",
      commitOID: SHA,
      body: "the body",
      threads: [{ path: "a.ts", line: 3, side: "RIGHT" as const, body: "a finding" }],
    };
    // A caller passing a query of its own has nowhere to put it: an extra field is not read.
    const smuggled = { ...variables, query: "mutation { deleteRepository }", event: "APPROVE" };

    const posted = await writerOver(transport).writers.workflow.postReview(smuggled);

    expect(posted).toEqual({ outcome: "applied", url: "https://r/1" });
    expect(sent).toEqual([{ query: ADD_REVIEW, variables: { input: { ...variables, event: "COMMENT" } } }]);
  });

  it("replies then resolves with the reason, and resolves alone where the reply is already there", async () => {
    const { transport, sent } = recording();
    const { writers } = writerOver(transport);

    await writers.workflow.replyAndResolve({ threadId: "T1", reply: "why", reason: "WONT_FIX" });
    await writers.workflow.replyAndResolve({ threadId: "T2", reply: undefined, reason: "ADDRESSED" });

    expect(sent).toEqual([
      { query: REPLY_TO_THREAD, variables: { threadId: "T1", body: "why" } },
      { query: RESOLVE_THREAD, variables: { threadId: "T1", reason: "WONT_FIX" } },
      { query: RESOLVE_THREAD, variables: { threadId: "T2", reason: "ADDRESSED" } },
    ]);
  });

  it("logs a label that is not there as unchanged, and throws any other refusal", async () => {
    const { transport } = recording((s) => {
      if ("rest" in s && s.rest.path.endsWith("/absent")) throw new GitHubError("Label does not exist", 404);
      if ("rest" in s && s.rest.path.endsWith("/locked")) throw new GitHubError("Forbidden", 403);
      return undefined;
    });
    const { writers, log } = writerOver(transport);

    expect(await writers.workflow.removeLabel(7, "absent")).toEqual({ outcome: "unchanged" });
    await expect(writers.workflow.removeLabel(7, "locked")).rejects.toBeInstanceOf(WriteFailed);
    expect(log.entries.map((e) => e.outcome)).toEqual(["unchanged", "failed"]);
  });

  it("sends a label, a status and a comment to their REST endpoints", async () => {
    const { transport, sent } = recording((s) => ("rest" in s && s.rest.path.endsWith("/comments") ? { html_url: "https://c/1" } : {}));
    const { writers } = writerOver(transport);

    await writers.workflow.addLabel(7, "agent:fix");
    await writers.workflow.removeLabel(7, "a b");
    await writers.workflow.setCommitStatus({ sha: SHA, context: "ctx", state: "failure", description: "d", targetUrl: "https://u" });
    expect(await writers.workflow.comment(7, "hi")).toEqual({ outcome: "applied", url: "https://c/1" });

    expect(sent).toEqual([
      { rest: { method: "POST", path: "/repos/o/r/issues/7/labels", body: { labels: ["agent:fix"] } } },
      { rest: { method: "DELETE", path: "/repos/o/r/issues/7/labels/a%20b" } },
      { rest: { method: "POST", path: `/repos/o/r/statuses/${SHA}`, body: { context: "ctx", state: "failure", description: "d", target_url: "https://u" } } },
      { rest: { method: "POST", path: "/repos/o/r/issues/7/comments", body: { body: "hi" } } },
    ]);
  });

  it("marks a draft ready by its node id, and leaves one that is not a draft", async () => {
    let draft = true;
    const { transport, sent } = recording((s) => ("rest" in s ? rawPull({ draft }) : {}));
    const { writers } = writerOver(transport);

    expect(await writers.workflow.markReadyForReview(7)).toEqual({ outcome: "applied" });
    draft = false;
    expect(await writers.workflow.markReadyForReview(7)).toEqual({ outcome: "unchanged" });

    expect(sent.filter((s) => "query" in s)).toEqual([{ query: MARK_READY, variables: { id: "PR_7" } }]);
  });

  it("edits against the body it reads at the write, and sends only what changed", async () => {
    const { transport, sent } = recording((s) => ("rest" in s && s.rest.method === "GET" ? rawPull({ body: null }) : {}));
    const { writers } = writerOver(transport);

    await writers.workflow.editPullRequest(7, { title: "Title", body: (live) => `${live}spliced` });

    expect(sent.at(-1)).toEqual({ rest: { method: "PATCH", path: "/repos/o/r/pulls/7", body: { body: "spliced" } } });
  });

  /**
   * Every shape an edit can take, title or body or both or neither, is judged
   * against the live pull request, so one with nothing to change is `unchanged`
   * and sends no PATCH, whichever field it names.
   */
  it("leaves a title-only edit that changes nothing, and sends one that does", async () => {
    const { transport, sent } = recording((s) => ("rest" in s && s.rest.method === "GET" ? rawPull({ title: "Same" }) : {}));
    const { writers, log } = writerOver(transport);

    expect(await writers.workflow.editPullRequest(7, { title: "Same" })).toEqual({ outcome: "unchanged" });
    expect(await writers.workflow.editPullRequest(7, {})).toEqual({ outcome: "unchanged" });
    expect(await writers.workflow.editPullRequest(7, { title: "New" })).toEqual({ outcome: "applied" });

    expect(sent.filter((s) => "rest" in s && s.rest.method === "PATCH")).toEqual([
      { rest: { method: "PATCH", path: "/repos/o/r/pulls/7", body: { title: "New" } } },
    ]);
    expect(log.entries.map((e) => [e.target, e.outcome, e.calls])).toEqual([
      ["#7 title", "unchanged", ["GET pull ok"]],
      ["#7", "unchanged", ["GET pull ok"]],
      ["#7 title", "applied", ["GET pull ok", "PATCH title ok"]],
    ]);
  });

  /** The fake a command's test stands on logs what a run logs, for every shape of edit. */
  it.each<[string, PullRequestEdit]>([
    ["the same title", { title: "Title" }],
    ["a new title", { title: "New" }],
    ["the same body", { body: (live) => live }],
    ["a new body", { body: (live) => `${live}!` }],
    ["a body left alone", { body: () => undefined }],
    ["the same title and a new body", { title: "Title", body: (live) => `${live}!` }],
    ["nothing", {}],
  ])("logs an edit of %s as the fake does", async (_name, edit) => {
    const { transport } = recording((s) => ("rest" in s && s.rest.method === "GET" ? rawPull() : {}));
    const real = writerOver(transport);
    const fake = fakeWriters(fakeGitHub([{ number: 7, title: "Title", body: "Body" }]), ["workflow"], { editPullRequest: 1 });

    expect(await real.writers.workflow.editPullRequest(7, edit)).toEqual(await fake.writers.workflow.editPullRequest(7, edit));
    expect(real.log.entries).toEqual(fake.entries);
  });
});

describe("githubReader", () => {
  it("reads a pull request", async () => {
    const { transport } = recording(() => rawPull({ draft: true }));

    expect(await githubReader(REPO, transport).pullRequest(7)).toEqual({
      number: 7,
      nodeId: "PR_7",
      state: "open",
      draft: true,
      headSha: SHA,
      title: "Title",
      body: "Body",
      labels: ["agent:x"],
    });
  });

  it("reads every page of a commit's statuses", async () => {
    const status = (n: number) => ({ context: `c${n}`, state: "success", target_url: null, description: null, creator: { login: "bot" } });
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => status(i)) : [status(100)],
    );

    const statuses = await githubReader(REPO, transport).commitStatuses(SHA);

    expect(statuses).toHaveLength(101);
    expect(statuses[100]).toEqual({ context: "c100", state: "success", targetUrl: null, description: "", creator: "bot" });
    expect(sent).toHaveLength(2);
  });

  it("reads every page of a pull request's thread ids", async () => {
    const { transport, sent } = recording((s) => {
      const after = "variables" in s ? s.variables["after"] : undefined;
      return {
        repository: {
          pullRequest: {
            reviewThreads:
              after === null
                ? { nodes: [{ id: "T1" }], pageInfo: { hasNextPage: true, endCursor: "c1" } }
                : { nodes: [{ id: "T2" }], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      };
    });

    expect([...(await githubReader(REPO, transport).reviewThreadIds(7))]).toEqual(["T1", "T2"]);
    expect(sent.map((s) => ("variables" in s ? s.variables : undefined))).toEqual([
      { owner: "o", name: "r", number: 7, after: null },
      { owner: "o", name: "r", number: 7, after: "c1" },
    ]);
  });

  it("reads every page of a pull request's reviews, oldest first", async () => {
    const review = (n: number) => ({
      html_url: `https://github.com/o/r/pull/7#pullrequestreview-${n}`,
      commit_id: SHA,
      body: `review ${n}`,
      user: { login: "github-actions[bot]" },
    });
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, i) => review(i))
        : [{ html_url: "u", commit_id: null, body: null, user: null }],
    );

    const reviews = await githubReader(REPO, transport).reviews(7);

    expect(reviews).toHaveLength(101);
    expect(reviews[0]).toEqual({ url: "https://github.com/o/r/pull/7#pullrequestreview-0", commit: SHA, body: "review 0", author: "github-actions[bot]" });
    expect(reviews[100]).toEqual({ url: "u", commit: "", body: "", author: "" });
    expect(sent.map((s) => ("rest" in s ? s.rest.path : ""))).toEqual([
      "/repos/o/r/pulls/7/reviews?per_page=100&page=1",
      "/repos/o/r/pulls/7/reviews?per_page=100&page=2",
    ]);
  });

  it("reads every page of a pull request's commits, oldest first", async () => {
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => ({ sha: `s${i}` })) : [{ sha: "last" }],
    );

    const commits = await githubReader(REPO, transport).pullRequestCommits(7);

    expect(commits).toHaveLength(101);
    expect([commits[0], commits[100]]).toEqual(["s0", "last"]);
    expect(sent.map((s) => ("rest" in s ? s.rest.path : ""))).toEqual([
      "/repos/o/r/pulls/7/commits?per_page=100&page=1",
      "/repos/o/r/pulls/7/commits?per_page=100&page=2",
    ]);
  });

  /** A ref may hold characters a path does not; each segment is encoded, and the slashes kept. */
  it("reads a branch's tip from the repository's refs", async () => {
    const { transport, sent } = recording(() => ({ ref: "refs/heads/agent/x", object: { sha: SHA } }));

    expect(await githubReader(REPO, transport).branchTip("agent/issue-1-a#b")).toBe(SHA);
    expect(sent).toEqual([{ rest: { method: "GET", path: "/repos/o/r/git/ref/heads/agent/issue-1-a%23b" } }]);
  });

  it("reads how one commit relates to another", async () => {
    const { transport, sent } = recording(() => ({ status: "ahead" }));

    expect(await githubReader(REPO, transport).compare("a".repeat(40), SHA)).toBe("ahead");
    expect(sent).toEqual([{ rest: { method: "GET", path: `/repos/o/r/compare/${"a".repeat(40)}...${SHA}?per_page=1` } }]);
  });

  const paths = (sent: readonly Sent[]): readonly string[] => sent.map((s) => ("rest" in s ? s.rest.path : ""));

  it("reads every page of a commit's check runs", async () => {
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1")
        ? { total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, status: "completed", conclusion: "success", id: i })) }
        : { total_count: 101, check_runs: [{ name: "last", status: "queued", conclusion: null, id: 100 }] },
    );

    const runs = await githubReader(REPO, transport).checkRuns(SHA);

    expect(runs).toHaveLength(101);
    expect(runs[100]).toEqual({ name: "last", status: "queued", conclusion: null });
    expect(paths(sent)).toEqual([`/repos/o/r/commits/${SHA}/check-runs?per_page=100&page=1`, `/repos/o/r/commits/${SHA}/check-runs?per_page=100&page=2`]);
  });

  it("reads a commit's latest status per context from the combined endpoint", async () => {
    const { transport, sent } = recording(() => ({ state: "pending", statuses: [{ context: "ci/build", state: "pending", target_url: null }] }));

    expect(await githubReader(REPO, transport).latestStatuses(SHA)).toEqual([{ context: "ci/build", state: "pending" }]);
    expect(paths(sent)).toEqual([`/repos/o/r/commits/${SHA}/status?per_page=100&page=1`]);
  });

  it("reads the workflow runs whose head is a commit, with what each calls", async () => {
    const { transport, sent } = recording(() => ({
      total_count: 2,
      workflow_runs: [
        { id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "https://u/1", referenced_workflows: [{ path: "o/agent-workflows/.github/workflows/fix.yml@v1" }] },
        { id: 2, name: null, status: "queued", conclusion: null, html_url: "https://u/2" },
      ],
    }));

    expect(await githubReader(REPO, transport).workflowRuns(SHA)).toEqual([
      { id: 1, name: "CI", status: "completed", conclusion: "failure", url: "https://u/1", referencedWorkflows: ["o/agent-workflows/.github/workflows/fix.yml@v1"] },
      { id: 2, name: "", status: "queued", conclusion: null, url: "https://u/2", referencedWorkflows: [] },
    ]);
    expect(paths(sent)).toEqual([`/repos/o/r/actions/runs?head_sha=${SHA}&per_page=100&page=1`]);
  });

  /** A job's log is plain text, so it is asked for as text rather than parsed. */
  it("reads the log of each job of a run that failed, as text", async () => {
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.includes("/jobs?")
        ? { total_count: 3, jobs: [{ id: 11, conclusion: "success" }, { id: 12, conclusion: "failure" }, { id: 13, conclusion: "failure" }] }
        : `log of ${"rest" in s ? s.rest.path : ""}`,
    );

    expect(await githubReader(REPO, transport).failedJobLogs(7)).toEqual(["log of /repos/o/r/actions/jobs/12/logs", "log of /repos/o/r/actions/jobs/13/logs"]);
    expect(sent).toEqual([
      { rest: { method: "GET", path: "/repos/o/r/actions/runs/7/jobs?per_page=100&page=1" } },
      { rest: { method: "GET", path: "/repos/o/r/actions/jobs/12/logs", text: true } },
      { rest: { method: "GET", path: "/repos/o/r/actions/jobs/13/logs", text: true } },
    ]);
  });
});

describe("a server error", () => {
  /** GitHub failing, not refusing: neither says the call did nothing. */
  it("is a 5xx, or GraphQL's internal error with no status", () => {
    expect(isServerError(new GitHubError("POST /graphql: 502 Bad Gateway", 502))).toBe(true);
    expect(isServerError(new GitHubError("graphql: Something went wrong. An internal error occurred, please retry."))).toBe(true);
    expect(isServerError(new GitHubError("POST /graphql: 422 Unprocessable", 422))).toBe(false);
    expect(isServerError(new GitHubError("graphql: Could not resolve to a node"))).toBe(false);
    expect(isServerError(new Error("An internal error occurred"))).toBe(false);
  });

  /** The loop judges a failed write by what GitHub threw, so the writer hands it on. */
  it("reaches the loop as the cause of the write that failed", async () => {
    const thrown = new GitHubError("graphql: An internal error occurred");
    const { writers } = writerOver(
      recording(() => {
        throw thrown;
      }).transport,
    );

    const failed = await writers.workflow
      .postReview({ pullRequestId: "PR_7", commitOID: SHA, body: "b", threads: [] })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(WriteFailed);
    expect((failed as WriteFailed).cause).toBe(thrown);
  });
});
