/**
 * The GitHub half of each write, and the reader, over a transport that
 * records what it was asked and answers from a script: the requests a run
 * sends, with the mutations the engine owns.
 */
import { describe, expect, it } from "vitest";
import { GitHubError, type RestRequest, type Transport } from "../../engine/github.js";
import { githubReader } from "../../engine/read.js";
import { ADD_REVIEW, githubWrites, MARK_READY, REPLY_TO_THREAD, RESOLVE_THREAD } from "../../engine/writes.js";
import { createWriters, WriteFailed } from "../../engine/writer.js";

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
    const status = (n: number) => ({ context: `c${n}`, state: "success", target_url: null, creator: { login: "bot" } });
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => status(i)) : [status(100)],
    );

    const statuses = await githubReader(REPO, transport).commitStatuses(SHA);

    expect(statuses).toHaveLength(101);
    expect(statuses[100]).toEqual({ context: "c100", state: "success", targetUrl: null, creator: "bot" });
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
});
