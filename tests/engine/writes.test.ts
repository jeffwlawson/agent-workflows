/**
 * The GitHub half of each write, and the reader, over a transport that
 * records what it was asked and answers from a script: the requests a run
 * sends, with the mutations the engine owns.
 */
import { describe, expect, it } from "vitest";
import { gitWrites } from "../../engine/git.js";
import { GitHubError, isServerError, type RestRequest, type Transport } from "../../engine/github.js";
import { githubReader, LABELLED_ISSUES_LIMIT } from "../../engine/read.js";
import { ADD_REVIEW, githubWrites, MARK_READY, REPLY_TO_THREAD, RESOLVE_THREAD } from "../../engine/writes.js";
import { createWriters, ReadBackFailed, WriteFailed, type PullRequestEdit } from "../../engine/writer.js";
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
    backends: { workflow: { ...githubWrites(REPO, transport), ...gitWrites({ dir: ".", env: {}, remote: "" }, "unused") } },
    limits: {
      addLabel: 9,
      removeLabel: 9,
      setCommitStatus: 9,
      comment: 9,
      markReadyForReview: 9,
      postReview: 9,
      replyAndResolve: 9,
      reply: 9,
      editPullRequest: 9,
      openPullRequest: 9,
      createIssue: 9,
      mergePullRequest: 9,
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

  it("replies with the reply mutation alone, and never resolves", async () => {
    const { transport, sent } = recording();
    const { writers, log } = writerOver(transport);

    expect(await writers.workflow.reply({ threadId: "T1", body: "why" })).toEqual({ outcome: "applied" });

    expect(sent).toEqual([{ query: REPLY_TO_THREAD, variables: { threadId: "T1", body: "why" } }]);
    expect(log.entries[0]).toMatchObject({ type: "reply", target: "T1", outcome: "applied", calls: ["reply ok"] });
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
    // The tolerated 404 is an expected result, with no error text and no raw answer kept.
    expect(log.entries[0]).toEqual({
      seq: 1,
      token: "workflow",
      type: "removeLabel",
      target: "#7 absent",
      outcome: "unchanged",
      calls: ["DELETE label expected: label not present"],
    });
    expect(log.entries[1]?.calls).toEqual(["DELETE label 403 Forbidden"]);
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

/**
 * `openPullRequest` (#492): a server error is read back before it is called a
 * failure, by exactly this head and base and never by the body, since an
 * adopter's own PR can close the same issue (#329).
 */
describe("openPullRequest", () => {
  const OPEN = { base: "main", head: "agent/issue-9-x", title: "Fix #9: x", body: "Closes #9", draft: true };
  const listed = (head: string, base: string, number = 31, repo = REPO) => ({
    number,
    html_url: `https://github.com/o/r/pull/${number}`,
    head: { ref: head, repo: { full_name: repo } },
    base: { ref: base },
    body: "Closes #9",
  });
  /** A transport whose POST answers `post`, and whose listing answers `list`. */
  const answering = (post: () => unknown, list: () => unknown) =>
    recording((s) => ("rest" in s && s.rest.method === "POST" ? post() : list()));
  const serverError = () => {
    throw new GitHubError("POST /repos/o/r/pulls: 502 Bad Gateway", 502, { reason: "Bad Gateway" });
  };

  it("opens the pull request with the fields it is given, and returns its number and link", async () => {
    const { transport, sent } = answering(() => ({ number: 31, html_url: "https://github.com/o/r/pull/31" }), () => []);
    const { writers, log } = writerOver(transport);

    expect(await writers.workflow.openPullRequest(OPEN)).toEqual({ outcome: "applied", number: 31, url: "https://github.com/o/r/pull/31" });
    expect(sent).toEqual([{ rest: { method: "POST", path: "/repos/o/r/pulls", body: OPEN } }]);
    expect(log.entries[0]).toMatchObject({ type: "openPullRequest", target: "agent/issue-9-x into main draft", url: "https://github.com/o/r/pull/31" });
  });

  it("carries on with the pull request from this head into this base where GitHub errored but opened it", async () => {
    const { transport, sent } = answering(serverError, () => [listed("other", "main", 30), listed(OPEN.head, OPEN.base)]);
    const { writers, log } = writerOver(transport);

    const opened = await writers.workflow.openPullRequest(OPEN);

    expect(opened).toEqual({ outcome: "applied", number: 31, url: "https://github.com/o/r/pull/31", readBack: "POST /repos/o/r/pulls: 502 Bad Gateway" });
    expect(sent[1]).toEqual({
      rest: { method: "GET", path: "/repos/o/r/pulls?state=open&head=o%3Aagent%2Fissue-9-x&base=main&per_page=100&page=1" },
    });
    expect(log.entries[0]?.calls).toEqual(["POST pulls 502 Bad Gateway", "GET pulls ok"]);
  });

  it.each([
    ["from another head", [listed("someone/else", "main")]],
    ["into another base", [listed("agent/issue-9-x", "develop")]],
    ["from a fork's branch of the same name", [listed("agent/issue-9-x", "main", 31, "fork/r")]],
    ["that only closes the same issue", [{ ...listed("feature", "main"), body: "Closes #9" }]],
  ])("fails a server error where the only open pull request is one %s", async (_name, open) => {
    const { transport } = answering(serverError, () => open);
    const { writers } = writerOver(transport);

    const failed = await writers.workflow.openPullRequest(OPEN).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(WriteFailed);
    expect((failed as WriteFailed).cause).toBeInstanceOf(GitHubError);
    expect((failed as WriteFailed).entry.outcome).toBe("failed");
  });

  it("fails a refusal without reading back", async () => {
    const { transport, sent } = answering(() => {
      throw new GitHubError("POST /repos/o/r/pulls: 422 A pull request already exists", 422);
    }, () => [listed(OPEN.head, OPEN.base)]);

    await expect(writerOver(transport).writers.workflow.openPullRequest(OPEN)).rejects.toBeInstanceOf(WriteFailed);
    expect(sent).toHaveLength(1);
  });

  it("fails a server error whose read-back fails too, naming both", async () => {
    const { transport } = answering(serverError, () => {
      throw new GitHubError("GET /repos/o/r/pulls: 503 Unavailable", 503);
    });

    const failed = (await writerOver(transport).writers.workflow.openPullRequest(OPEN).catch((error: unknown) => error)) as WriteFailed;

    expect(failed.cause).toBeInstanceOf(ReadBackFailed);
    expect((failed.cause as Error).message).toContain("502 Bad Gateway");
    expect((failed.cause as Error).message).toContain("503 Unavailable");
  });

  /** The fake a command's test stands on opens, and reads back, as a run does. */
  it("is logged by the fake as a run logs it, opened and read back", async () => {
    const real = writerOver(answering(serverError, () => [listed(OPEN.head, OPEN.base)]).transport);
    const github = fakeGitHub([{ number: 31, headRef: OPEN.head, baseRef: OPEN.base }]);
    github.fails = (_write, call) => (call === "POST pulls" ? { status: 502, landed: false } : false);
    const fake = fakeWriters(github, ["workflow"], { openPullRequest: 1 });

    const [a, b] = [await real.writers.workflow.openPullRequest(OPEN), await fake.writers.workflow.openPullRequest(OPEN)];
    expect({ ...a, readBack: "" }).toEqual({ ...b, readBack: "" });
    expect(real.log.entries.map((e) => [e.type, e.target, e.outcome, e.calls.map((c) => c.split(" ").slice(0, 3).join(" "))])).toEqual(
      fake.entries.map((e) => [e.type, e.target, e.outcome, e.calls.map((c) => c.split(" ").slice(0, 3).join(" "))]),
    );
  });
});

/**
 * `createIssue`: a server error is read back before it is called a failure,
 * by the caller's label and match, listed and never searched, so only the
 * issue the caller's match accepts can stand in for the one asked for.
 */
describe("createIssue", () => {
  const KEY = "<!-- key:a.ts#1 -->";
  const CREATE = {
    title: "Follow-up: a.ts",
    body: `Finding.\n\n${KEY}`,
    labels: ["pr-follow-up", "needs-triage"],
    readBack: { label: "pr-follow-up", matches: (body: string) => body.endsWith(KEY) },
  };
  const node = (number: number, body: string) => ({ number, url: `https://github.com/o/r/issues/${number}`, state: "OPEN", stateReason: null, body });
  const page = (nodes: readonly unknown[]) => ({ repository: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  /** A transport whose POST answers `post`, and whose listing answers `list`. */
  const answering = (post: () => unknown, list: () => unknown) => recording((s) => ("rest" in s ? post() : list()));
  const serverError = () => {
    throw new GitHubError("POST /repos/o/r/issues: 502 Bad Gateway", 502, { reason: "Bad Gateway" });
  };

  it("creates the issue with its title, body and labels in one call, and returns its number and link", async () => {
    const { transport, sent } = answering(() => ({ number: 41, html_url: "https://github.com/o/r/issues/41" }), () => page([]));
    const { writers, log } = writerOver(transport);

    expect(await writers.workflow.createIssue(CREATE)).toEqual({ outcome: "applied", number: 41, url: "https://github.com/o/r/issues/41" });
    expect(sent).toEqual([{ rest: { method: "POST", path: "/repos/o/r/issues", body: { title: CREATE.title, body: CREATE.body, labels: CREATE.labels } } }]);
    expect(log.entries[0]).toMatchObject({ type: "createIssue", target: '"Follow-up: a.ts" pr-follow-up needs-triage', url: "https://github.com/o/r/issues/41" });
  });

  it("logs the title and labels, never the body", async () => {
    const lines: string[] = [];
    const { writers } = createWriters({
      backends: { workflow: { ...githubWrites(REPO, answering(() => ({ number: 41, html_url: "u" }), () => page([])).transport), ...gitWrites({ dir: ".", env: {}, remote: "" }, "unused") } },
      limits: { createIssue: 1 },
      appendLine: (line) => lines.push(line),
    });

    await writers.workflow.createIssue(CREATE);

    expect(lines.join("\n")).not.toContain("key:a.ts");
  });

  it("carries on with the issue the caller's match accepts where GitHub errored but created it, keeping the error", async () => {
    const { transport, sent } = answering(serverError, () => page([node(43, "Another.\n\n<!-- key:b.ts#1 -->"), node(42, CREATE.body)]));
    const { writers, log } = writerOver(transport);

    expect(await writers.workflow.createIssue(CREATE)).toEqual({
      outcome: "applied",
      number: 42,
      url: "https://github.com/o/r/issues/42",
      readBack: "POST /repos/o/r/issues: 502 Bad Gateway",
    });
    expect(sent[1]).toMatchObject({ variables: { owner: "o", name: "r", label: "pr-follow-up", after: null } });
    expect(log.entries[0]).toMatchObject({ outcome: "applied", calls: ["POST issues 502 Bad Gateway", "GET issues ok"] });
  });

  /** The match is the caller's: a body that only quotes the key, ahead of its own, is not this issue. */
  it("takes only the issue the caller's match accepts, never one quoting a decoy under the same label", async () => {
    const decoy = `Quoting ${KEY} from elsewhere.\n\n<!-- key:c.ts#1 -->`;
    const { transport } = answering(serverError, () => page([node(44, decoy)]));

    const failed = await writerOver(transport).writers.workflow.createIssue(CREATE).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(WriteFailed);
    expect((failed as WriteFailed).cause).toBeInstanceOf(GitHubError);
    expect(((failed as WriteFailed).cause as Error).message).toBe("POST /repos/o/r/issues: 502 Bad Gateway");
  });

  it("throws the server error where the read-back finds nothing", async () => {
    const { transport } = answering(serverError, () => page([]));

    const failed = (await writerOver(transport).writers.workflow.createIssue(CREATE).catch((error: unknown) => error)) as WriteFailed;

    expect(failed).toBeInstanceOf(WriteFailed);
    expect(failed.cause).toBeInstanceOf(GitHubError);
    expect(failed.entry.outcome).toBe("failed");
  });

  it("fails a refusal without reading back", async () => {
    const { transport, sent } = answering(() => {
      throw new GitHubError("POST /repos/o/r/issues: 422 Validation Failed", 422);
    }, () => page([node(42, CREATE.body)]));

    const failed = (await writerOver(transport).writers.workflow.createIssue(CREATE).catch((error: unknown) => error)) as WriteFailed;

    expect(failed).toBeInstanceOf(WriteFailed);
    expect((failed.cause as GitHubError).status).toBe(422);
    expect(sent).toHaveLength(1);
  });

  it("fails a server error whose read-back fails too, naming both", async () => {
    const { transport } = answering(serverError, () => {
      throw new GitHubError("POST /graphql: 503 Unavailable", 503);
    });

    const failed = (await writerOver(transport).writers.workflow.createIssue(CREATE).catch((error: unknown) => error)) as WriteFailed;

    expect(failed.cause).toBeInstanceOf(ReadBackFailed);
    expect((failed.cause as Error).message).toContain("502 Bad Gateway");
    expect((failed.cause as Error).message).toContain("503 Unavailable");
  });

  /** The fake a command's test stands on creates, and reads back, as a run does. */
  it("is logged by the fake as a run logs it, created and read back", async () => {
    const real = writerOver(answering(serverError, () => page([node(42, CREATE.body)])).transport);
    const github = fakeGitHub();
    github.fails = (_write, call) => (call === "POST issues" ? { status: 502, landed: true } : false);
    const fake = fakeWriters(github, ["workflow"], { createIssue: 1 });

    const [a, b] = [await real.writers.workflow.createIssue(CREATE), await fake.writers.workflow.createIssue(CREATE)];
    expect({ ...a, number: 0, url: "", readBack: "" }).toEqual({ ...b, number: 0, url: "", readBack: "" });
    expect(github.issueLabels.get(b.number)).toEqual(CREATE.labels);
    expect(real.log.entries.map((e) => [e.type, e.target, e.outcome, e.calls.map((c) => c.split(" ").slice(0, 3).join(" "))])).toEqual(
      fake.entries.map((e) => [e.type, e.target, e.outcome, e.calls.map((c) => c.split(" ").slice(0, 3).join(" "))]),
    );
  });

  it.each([
    ["finds nothing", { status: 502, landed: false }, false, GitHubError],
    ["fails", { status: 502, landed: true }, true, ReadBackFailed],
  ] as const)("fails through the fake where a server error's read-back %s", async (_name, error, readFails, cause) => {
    const github = fakeGitHub();
    github.fails = (_write, call) => (call === "POST issues" ? error : call === "GET issues" && readFails);
    const { writers, entries } = fakeWriters(github, ["workflow"], { createIssue: 1 });

    const failed = (await writers.workflow.createIssue(CREATE).catch((e: unknown) => e)) as WriteFailed;

    expect(failed).toBeInstanceOf(WriteFailed);
    expect(failed.cause).toBeInstanceOf(cause);
    expect(entries[0]?.outcome).toBe("failed");
  });

  it("is refused by the fake on a client error, with no read-back", async () => {
    const github = fakeGitHub();
    github.fails = (_write, call) => call === "POST issues";
    const { writers, entries } = fakeWriters(github, ["workflow"], { createIssue: 1 });

    const failed = (await writers.workflow.createIssue(CREATE).catch((e: unknown) => e)) as WriteFailed;

    expect((failed.cause as GitHubError).status).toBe(422);
    expect(entries[0]?.calls).toHaveLength(1);
    expect(github.filed.size).toBe(0);
  });
});

describe("mergePullRequest", () => {
  const MERGE = { pr: 7, sha: SHA, title: "feat: a thing (#7)" };
  const refusal = (status: number, message: string) => () => {
    throw new GitHubError(`PUT /repos/o/r/pulls/7/merge: ${status} {"message":"${message}"}`, status, {
      reason: message,
      raw: JSON.stringify({ message }),
    });
  };

  it("squash-merges guarded on the full head, with the title, and returns the merge commit", async () => {
    const { transport, sent } = recording(() => ({ sha: "c".repeat(40), merged: true, message: "Pull Request successfully merged" }));
    const { writers, log } = writerOver(transport);

    expect(await writers.workflow.mergePullRequest(MERGE)).toEqual({ outcome: "applied", sha: "c".repeat(40) });
    expect(sent).toEqual([
      { rest: { method: "PUT", path: "/repos/o/r/pulls/7/merge", body: { merge_method: "squash", sha: SHA, commit_title: MERGE.title } } },
    ]);
    expect(log.entries[0]).toMatchObject({ type: "mergePullRequest", target: `#7 at ${SHA} "feat: a thing (#7)"`, outcome: "applied", calls: ["PUT merge ok"] });
  });

  it("sends a message where one is given, and logs it nowhere", async () => {
    const lines: string[] = [];
    const { transport, sent } = recording(() => ({ sha: "c".repeat(40) }));
    const { writers } = createWriters({
      backends: { workflow: { ...githubWrites(REPO, transport), ...gitWrites({ dir: ".", env: {}, remote: "" }, "unused") } },
      limits: { mergePullRequest: 1 },
      appendLine: (line) => lines.push(line),
    });

    await writers.workflow.mergePullRequest({ ...MERGE, message: "the squashed body" });

    expect(sent[0]).toMatchObject({ rest: { body: { commit_message: "the squashed body" } } });
    expect(lines.join("\n")).not.toContain("squashed body");
  });

  it.each(["abc1234", "B".repeat(40), "b".repeat(39), "b".repeat(41), `${"b".repeat(39)}g`, ""])(
    "refuses %j as the guard before any request",
    async (sha) => {
      const { transport, sent } = recording(() => ({ sha: "c".repeat(40) }));
      const { writers, log } = writerOver(transport);

      const failed = (await writers.workflow.mergePullRequest({ ...MERGE, sha }).catch((error: unknown) => error)) as WriteFailed;

      expect(failed).toBeInstanceOf(WriteFailed);
      expect(failed.message).toContain("not a full 40-character SHA");
      expect(sent).toEqual([]);
      expect(log.entries[0]).toMatchObject({ outcome: "refused" });
    },
  );

  it.each([
    [409, "Head branch was modified. Review and try the merge again."],
    [405, "Merge commits are not allowed on this repository."],
    [422, "Validation Failed"],
  ])("fails a %i with GitHub's answer in the log, and does not retry it", async (status, message) => {
    const { transport, sent } = recording(refusal(status, message));
    const { writers, log } = writerOver(transport);

    const failed = (await writers.workflow.mergePullRequest(MERGE).catch((error: unknown) => error)) as WriteFailed;

    expect(failed).toBeInstanceOf(WriteFailed);
    expect((failed.cause as GitHubError).status).toBe(status);
    expect(sent).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ outcome: "failed", calls: [`PUT merge ${status} ${message}`], response: JSON.stringify({ message }) });
  });

  it("does not retry a server error either", async () => {
    const { transport, sent } = recording(() => {
      throw new GitHubError("PUT /repos/o/r/pulls/7/merge: 502 Bad Gateway", 502, { reason: "Bad Gateway" });
    });

    await expect(writerOver(transport).writers.workflow.mergePullRequest(MERGE)).rejects.toBeInstanceOf(WriteFailed);
    expect(sent).toHaveLength(1);
  });

  /** It merged, so it is not "not done"; what it made is what went unread. */
  it("is partial where GitHub answers the merge without the merge commit", async () => {
    const { transport } = recording(() => ({ merged: true }));
    const { writers, log } = writerOver(transport);

    await expect(writers.workflow.mergePullRequest(MERGE)).rejects.toThrow("without the merge commit's SHA");
    expect(log.entries[0]?.outcome).toBe("partial");
  });

  /** The fake a command's test stands on merges, and refuses, as a run does. */
  it("is merged by the fake on the guarded head, closing the pull request and moving its base", async () => {
    const github = fakeGitHub([{ number: 7, headSha: SHA, baseRef: "main", mergeCommit: "c".repeat(40) }]);
    github.branches.set("main", "d".repeat(40));
    const { writers, entries } = fakeWriters(github, ["loop"], { mergePullRequest: 1 });

    expect(await writers.loop.mergePullRequest(MERGE)).toEqual({ outcome: "applied", sha: "c".repeat(40) });
    expect(github.pullRequests.get(7)).toMatchObject({ state: "closed", merged: true });
    expect(github.branches.get("main")).toBe("c".repeat(40));
    expect(entries[0]).toMatchObject({ token: "loop", target: `#7 at ${SHA} "feat: a thing (#7)"`, outcome: "applied", calls: ["PUT merge ok"] });
  });

  it.each([
    ["a head that moved", { headSha: "a".repeat(40) }, 409],
    ["a draft", { draft: true }, 405],
    ["a closed pull request", { state: "closed" as const }, 405],
  ])("is refused by the fake on %s, merging nothing", async (_name, pr, status) => {
    const github = fakeGitHub([{ number: 7, headSha: SHA, ...pr }]);
    const { writers, entries } = fakeWriters(github, ["loop"], { mergePullRequest: 1 });

    const failed = (await writers.loop.mergePullRequest(MERGE).catch((error: unknown) => error)) as WriteFailed;

    expect((failed.cause as GitHubError).status).toBe(status);
    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.response).toBeDefined();
    expect(github.pullRequests.get(7)?.merged).toBeUndefined();
  });

  it("is refused by the fake on a short guard before it reaches the fake", async () => {
    const github = fakeGitHub([{ number: 7, headSha: SHA }]);
    github.fails = () => {
      throw new Error("reached the fake");
    };
    const { writers, entries } = fakeWriters(github, ["loop"], { mergePullRequest: 1 });

    await expect(writers.loop.mergePullRequest({ ...MERGE, sha: SHA.slice(0, 7) })).rejects.toThrow("not a full 40-character SHA");
    expect(entries[0]).toMatchObject({ outcome: "refused" });
    expect(github.pullRequests.get(7)?.state).toBe("open");
  });
});

describe("githubReader", () => {
  it("reads a pull request", async () => {
    const { transport } = recording(() => rawPull({ draft: true }));

    expect(await githubReader(REPO, transport).pullRequest(7)).toEqual({
      number: 7,
      nodeId: "PR_7",
      state: "open",
      merged: false,
      draft: true,
      headSha: SHA,
      title: "Title",
      body: "Body",
      labels: ["agent:x"],
    });
  });

  it("reads whether a pull request merged, as REST's `merged` says it, literally `true`", async () => {
    const merged = async (raw: Record<string, unknown>) =>
      (await githubReader(REPO, recording(() => ({ ...rawPull(), state: "closed", ...raw })).transport).pullRequest(7)).merged;

    expect(await merged({ merged: true })).toBe(true);
    expect(await merged({ merged: false })).toBe(false);
    expect(await merged({ merged: "true" })).toBe(false);
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

  it("reads every page of a pull request's conversation comments, with their authors and links", async () => {
    const { transport, sent } = recording((s) => {
      const after = "variables" in s ? s.variables["after"] : undefined;
      return {
        repository: {
          pullRequest: {
            comments:
              after === null
                ? { nodes: [{ id: "IC_1", url: "https://github.com/o/r/pull/7#issuecomment-1", author: { login: "maintainer" } }], pageInfo: { hasNextPage: true, endCursor: "c1" } }
                : { nodes: [{ id: "IC_2", url: "https://github.com/o/r/pull/7#issuecomment-2", author: null }], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      };
    });

    expect(await githubReader(REPO, transport).conversationComments(7)).toEqual([
      { id: "IC_1", author: "maintainer", url: "https://github.com/o/r/pull/7#issuecomment-1" },
      { id: "IC_2", author: "unknown", url: "https://github.com/o/r/pull/7#issuecomment-2" },
    ]);
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
      submitted_at: "2026-01-01T00:00:00Z",
    });
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, i) => review(i))
        : [{ html_url: "u", commit_id: null, body: null, user: null, submitted_at: null }],
    );

    const reviews = await githubReader(REPO, transport).reviews(7);

    expect(reviews).toHaveLength(101);
    expect(reviews[0]).toEqual({
      url: "https://github.com/o/r/pull/7#pullrequestreview-0",
      commit: SHA,
      body: "review 0",
      author: "github-actions[bot]",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    expect(reviews[100]).toEqual({ url: "u", commit: "", body: "", author: "" });
    expect(sent.map((s) => ("rest" in s ? s.rest.path : ""))).toEqual([
      "/repos/o/r/pulls/7/reviews?per_page=100&page=1",
      "/repos/o/r/pulls/7/reviews?per_page=100&page=2",
    ]);
  });

  /** The label is the caller's: the engine spells none, and reads every page of the timeline for it. */
  it("reads when a label was added, each time it was, off every page of the events, and nothing else", async () => {
    const labelled = (label: string, at: string) => ({ event: "labeled", label: { name: label }, created_at: at });
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1")
        ? [
            labelled("agent:fix", "2026-01-01T00:00:00Z"),
            { event: "unlabeled", label: { name: "agent:fix" }, created_at: "2026-01-01T00:01:00Z" },
            labelled("agent:review", "2026-01-01T00:02:00Z"),
            ...Array.from({ length: 97 }, () => ({ event: "commented", created_at: "2026-01-01T00:03:00Z" })),
          ]
        : [labelled("agent:fix", "2026-01-02T00:00:00Z"), { event: "labeled", label: null, created_at: "x" }],
    );

    expect(await githubReader(REPO, transport).labelledAt(7, "agent:fix")).toEqual(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]);
    expect(sent.map((s) => ("rest" in s ? s.rest.path : ""))).toEqual([
      "/repos/o/r/issues/7/events?per_page=100&page=1",
      "/repos/o/r/issues/7/events?per_page=100&page=2",
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

  it("reads an issue's parent, sub-issue count and labels in one query", async () => {
    const { transport, sent } = recording(() => ({
      repository: { issue: { parent: { number: 3 }, subIssues: { totalCount: 2 }, labels: { nodes: [{ name: "bug" }, { name: "wayfinder:map" }] } } },
    }));

    expect(await githubReader(REPO, transport).issueShape(9)).toEqual({ parent: 3, subIssues: 2, labels: ["bug", "wayfinder:map"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ variables: { owner: "o", name: "r", number: 9 } });
  });

  it("reads an issue with no parent as having none", async () => {
    const { transport } = recording(() => ({ repository: { issue: { parent: null, subIssues: { totalCount: 0 }, labels: { nodes: [] } } } }));

    expect(await githubReader(REPO, transport).issueShape(9)).toEqual({ parent: undefined, subIssues: 0, labels: [] });
  });

  /** "No answer" read as "standalone" is the isolated sub-issue run the shape guards against. */
  it.each([
    ["no issue", { repository: { issue: null } }],
    ["no repository", { repository: null }],
    ["no data", undefined],
  ])("throws on an answer holding %s, rather than reading it as standalone", async (_, answer) => {
    const { transport } = recording(() => answer);

    await expect(githubReader(REPO, transport).issueShape(9)).rejects.toThrow("The shape of issue #9 came back empty.");
  });

  it("reads an issue's open blockers, every page, and leaves the closed ones out", async () => {
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: i === 0 ? "open" : "closed" }))
        : [{ number: 200, state: "open" }],
    );

    expect(await githubReader(REPO, transport).openBlockers(9)).toEqual([1, 200]);
    expect(paths(sent)).toEqual([
      "/repos/o/r/issues/9/dependencies/blocked_by?per_page=100&page=1",
      "/repos/o/r/issues/9/dependencies/blocked_by?per_page=100&page=2",
    ]);
  });

  it("reads the open pull requests whose body the pattern matches, in the order listed", async () => {
    const { transport, sent } = recording(() => [
      { number: 12, body: "Closes #9" },
      { number: 11, body: null },
      { number: 10, body: "fixes #9" },
    ]);

    expect(await githubReader(REPO, transport).openPullRequestsClosing(/closes|fixes/i)).toEqual([12, 10]);
    expect(paths(sent)).toEqual(["/repos/o/r/pulls?state=open&per_page=100&page=1"]);
  });

  it("reads the open pull request from exactly a head into exactly a base, and none where there is none", async () => {
    const pr = (number: number, head: string, base: string) => ({
      number,
      html_url: `https://github.com/o/r/pull/${number}`,
      head: { ref: head, repo: { full_name: REPO } },
      base: { ref: base },
    });
    const { transport } = recording(() => [pr(4, "agent/x-y", "develop"), pr(5, "agent/x", "main")]);

    expect(await githubReader(REPO, transport).openPullRequest("agent/x", "main")).toEqual({ number: 5, url: "https://github.com/o/r/pull/5" });
    expect(await githubReader(REPO, transport).openPullRequest("agent/x", "develop")).toBeUndefined();
  });

  describe("reviewHistory", () => {
    const review = (fields: Record<string, unknown>) => ({
      body: "b",
      url: "https://github.com/o/r/pull/7#pullrequestreview-1",
      lastEditedAt: null,
      submittedAt: "2026-01-01T00:00:00Z",
      author: { login: "bot" },
      commit: { oid: SHA },
      ...fields,
    });
    const answer = (nodes: unknown) => ({ repository: { pullRequest: { reviews: { nodes } } } });

    it("reads the newest 100 by last:, oldest first, with what tells an edited body apart", async () => {
      const { transport, sent } = recording(() =>
        answer([review({ body: "first" }), review({ body: "second", lastEditedAt: "2026-01-02T00:00:00Z", commit: null, submittedAt: null, author: null })]),
      );

      expect(await githubReader(REPO, transport).reviewHistory(7)).toEqual([
        { author: "bot", body: "first", lastEditedAt: null, url: "https://github.com/o/r/pull/7#pullrequestreview-1", commit: SHA, submittedAt: "2026-01-01T00:00:00Z" },
        { author: "", body: "second", lastEditedAt: "2026-01-02T00:00:00Z", url: "https://github.com/o/r/pull/7#pullrequestreview-1" },
      ]);
      expect((sent[0] as { readonly query: string }).query).toContain("reviews(last:100)");
    });

    /** A repository named in digits is still a `String!`: sent as a number, every merge in it would die at GraphQL. */
    it("sends a repository name that looks like a number as a string", async () => {
      const { transport, sent } = recording(() => answer([]));

      await githubReader("org/2048", transport).reviewHistory(7);

      expect(sent[0]).toMatchObject({ variables: { owner: "org", repo: "2048", number: 7 } });
    });

    it("throws on an answer with no review list, rather than reading it as no reviews", async () => {
      const { transport } = recording(() => ({ repository: { pullRequest: null } }));

      await expect(githubReader(REPO, transport).reviewHistory(7)).rejects.toThrow(
        "The reviews on #7 could not be read: the GraphQL response carried no review list.",
      );
    });

    /** Absent is "nobody asked", which is not `null`'s "never edited". */
    it("throws on a review without the lastEditedAt field, and reads a null one", async () => {
      const { lastEditedAt: _, ...unasked } = review({});
      const { transport } = recording(() => answer([review({}), unasked]));

      await expect(githubReader(REPO, transport).reviewHistory(7)).rejects.toThrow(
        "A review on #7 came back without `lastEditedAt`, so whether it was edited cannot be established.",
      );
    });
  });

  describe("labelledIssues", () => {
    const node = (number: number) => ({
      number,
      url: `https://github.com/o/r/issues/${number}`,
      state: number % 2 === 0 ? "OPEN" : "CLOSED",
      stateReason: number % 2 === 0 ? null : "NOT_PLANNED",
      body: number === 1 ? null : `body ${number}`,
    });
    const pages = (total: number) =>
      recording((s) => {
        const at = "variables" in s ? Number(s.variables["after"] ?? 0) : 0;
        const nodes = Array.from({ length: Math.min(100, total - at) }, (_, i) => node(total - at - i));
        const next = at + nodes.length;
        return { repository: { issues: { nodes, pageInfo: { hasNextPage: next < total, endCursor: String(next) } } } };
      });

    it("reads the issues carrying the label, open and closed, newest first, listed by label", async () => {
      const { transport, sent } = pages(3);

      expect(await githubReader(REPO, transport).labelledIssues("pr-follow-up")).toEqual([
        { number: 3, url: "https://github.com/o/r/issues/3", state: "CLOSED", stateReason: "NOT_PLANNED", body: "body 3" },
        { number: 2, url: "https://github.com/o/r/issues/2", state: "OPEN", stateReason: null, body: "body 2" },
        { number: 1, url: "https://github.com/o/r/issues/1", state: "CLOSED", stateReason: "NOT_PLANNED", body: "" },
      ]);
      const query = (sent[0] as { readonly query: string }).query;
      expect(query).toContain("issues(labels:[$label],states:[OPEN,CLOSED]");
      expect(query).toContain("orderBy:{field:CREATED_AT,direction:DESC}");
      expect(sent[0]).toMatchObject({ variables: { owner: "o", name: "r", label: "pr-follow-up", after: null } });
    });

    it("follows every page, and stops at the limit", async () => {
      const short = pages(250);
      const long = pages(LABELLED_ISSUES_LIMIT + 150);

      expect(await githubReader(REPO, short.transport).labelledIssues("x")).toHaveLength(250);
      const read = await githubReader(REPO, long.transport).labelledIssues("x");

      expect(LABELLED_ISSUES_LIMIT).toBe(500);
      expect(read).toHaveLength(LABELLED_ISSUES_LIMIT);
      expect(read.at(-1)?.number).toBe(151);
      expect(long.sent).toHaveLength(5);
    });

    it("throws on an answer with no repository, rather than reading it as no issues", async () => {
      const { transport } = recording(() => ({ repository: null }));

      await expect(githubReader(REPO, transport).labelledIssues("pr-follow-up")).rejects.toThrow("The issues labelled pr-follow-up came back empty.");
    });
  });

  it("reads every page of the repository's labels, by name", async () => {
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` })) : [{ name: "pr-follow-up" }],
    );

    const labels = await githubReader(REPO, transport).repoLabels();

    expect(labels).toHaveLength(101);
    expect(labels.at(-1)).toBe("pr-follow-up");
    expect(paths(sent)).toEqual(["/repos/o/r/labels?per_page=100&page=1", "/repos/o/r/labels?per_page=100&page=2"]);
  });

  /** The chain's order is the list's, so a read that reorders or stops at a page would build the wrong slice. */
  it("reads an issue's sub-issues in list order, every page past 100", async () => {
    const node = (number: number) => ({ number, title: `Slice ${number}`, state: number % 2 === 0 ? "OPEN" : "CLOSED" });
    const { transport, sent } = recording((s) =>
      "variables" in s && s.variables["after"] === null
        ? { repository: { issue: { subIssues: { nodes: Array.from({ length: 100 }, (_, i) => node(200 - i)), pageInfo: { hasNextPage: true, endCursor: "c1" } } } } }
        : { repository: { issue: { subIssues: { nodes: [node(1)], pageInfo: { hasNextPage: false, endCursor: "c2" } } } } },
    );

    const subIssues = await githubReader(REPO, transport).subIssues(9);

    expect(subIssues).toHaveLength(101);
    expect([subIssues[0], subIssues[99], subIssues[100]]).toEqual([
      { number: 200, title: "Slice 200", state: "OPEN" },
      { number: 101, title: "Slice 101", state: "CLOSED" },
      { number: 1, title: "Slice 1", state: "CLOSED" },
    ]);
    expect(sent.map((s) => ("variables" in s ? s.variables : {}))).toEqual([
      { owner: "o", name: "r", number: 9, after: null },
      { owner: "o", name: "r", number: 9, after: "c1" },
    ]);
  });

  /** "No answer" read as "no sub-issues" is a chain whose every slice landed. */
  it.each([
    ["no issue", { repository: { issue: null } }],
    ["no repository", { repository: null }],
    ["no data", undefined],
  ])("throws on a sub-issue answer holding %s, rather than returning none", async (_, answer) => {
    const { transport } = recording(() => answer);

    await expect(githubReader(REPO, transport).subIssues(9)).rejects.toThrow("The sub-issues of issue #9 came back empty.");
  });

  it("throws on a failed sub-issue read rather than returning what it had", async () => {
    let calls = 0;
    const { transport } = recording(() => {
      calls += 1;
      if (calls > 1) throw new GitHubError("graphql: something");
      return { repository: { issue: { subIssues: { nodes: [{ number: 1, title: "", state: "OPEN" }], pageInfo: { hasNextPage: true, endCursor: "c" } } } } };
    });

    await expect(githubReader(REPO, transport).subIssues(9)).rejects.toThrow("graphql: something");
  });

  it("reads every issue an issue is blocked by, open or closed", async () => {
    const { transport, sent } = recording(() => [
      { number: 3, state: "open" },
      { number: 4, state: "closed" },
    ]);

    expect(await githubReader(REPO, transport).blockedBy(9)).toEqual([
      { number: 3, open: true },
      { number: 4, open: false },
    ]);
    expect(paths(sent)).toEqual(["/repos/o/r/issues/9/dependencies/blocked_by?per_page=100&page=1"]);
  });

  it("reads the body of every comment on an issue, every page", async () => {
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ body: "x" })) : [{ body: null }, { body: "last" }],
    );

    const bodies = await githubReader(REPO, transport).issueComments(9);

    expect(bodies).toHaveLength(102);
    expect(bodies.slice(100)).toEqual(["", "last"]);
    expect(paths(sent)).toEqual(["/repos/o/r/issues/9/comments?per_page=100&page=1", "/repos/o/r/issues/9/comments?per_page=100&page=2"]);
  });

  it("reads an issue's body with its author's login and association", async () => {
    const { transport, sent } = recording(() => ({ body: "A brief.", user: { login: "maintainer" }, author_association: "OWNER" }));

    expect(await githubReader(REPO, transport).issueBody(9)).toEqual({ body: "A brief.", author: "maintainer", association: "OWNER", isIssue: true });
    expect(paths(sent)).toEqual(["/repos/o/r/issues/9"]);
  });

  it("reads a pull request's number, and an issue transferred out, as not an issue of this repository", async () => {
    const isIssue = async (raw: Record<string, unknown>) =>
      (await githubReader(REPO, recording(() => ({ body: "x", user: { login: "a" }, author_association: "OWNER", ...raw })).transport).issueBody(9)).isIssue;

    expect(await isIssue({ repository_url: "https://api.github.com/repos/O/R" })).toBe(true);
    expect(await isIssue({ pull_request: { url: "https://api.github.com/repos/o/r/pulls/9" } })).toBe(false);
    expect(await isIssue({ repository_url: "https://api.github.com/repos/o/elsewhere" })).toBe(false);
  });

  it("reads every comment on an issue with its author, every page, a deleted account and a null body included", async () => {
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1")
        ? Array.from({ length: 100 }, () => ({ body: "x", user: { login: "a" }, author_association: "MEMBER" }))
        : [{ body: null, user: null, author_association: "NONE" }, { body: "last", user: { login: "b" } }],
    );

    const comments = await githubReader(REPO, transport).authoredComments(9);

    expect(comments).toHaveLength(102);
    expect(comments[0]).toEqual({ body: "x", author: "a", association: "MEMBER" });
    expect(comments.slice(100)).toEqual([
      { body: "", author: "", association: "NONE" },
      { body: "last", author: "b", association: "NONE" },
    ]);
    expect(paths(sent)).toEqual(["/repos/o/r/issues/9/comments?per_page=100&page=1", "/repos/o/r/issues/9/comments?per_page=100&page=2"]);
  });

  it("reads the branches whose name starts with a prefix, with their tips", async () => {
    const { transport, sent } = recording(() => [{ ref: "refs/heads/agent/prd-17-a", object: { sha: SHA } }]);

    expect(await githubReader(REPO, transport).branchesStarting("agent/prd-17-")).toEqual([{ name: "agent/prd-17-a", tip: SHA }]);
    expect(paths(sent)).toEqual(["/repos/o/r/git/matching-refs/heads/agent/prd-17-"]);
  });

  it("reads the open pull requests from a head, or into a base, with their branches", async () => {
    const { transport, sent } = recording(() => [{ number: 5, head: { ref: "agent/x" }, base: { ref: "main" } }]);
    const reader = githubReader(REPO, transport);

    expect(await reader.openPullRequests({ head: "agent/x" })).toEqual([{ number: 5, head: "agent/x", base: "main" }]);
    await reader.openPullRequests({ base: "agent/prd-1-a" });
    expect(paths(sent)).toEqual([
      "/repos/o/r/pulls?state=open&head=o%3Aagent%2Fx&per_page=100&page=1",
      "/repos/o/r/pulls?state=open&base=agent%2Fprd-1-a&per_page=100&page=1",
    ]);
  });

  it("reads the message of every commit a head has over a base, every page", async () => {
    const { transport, sent } = recording((s) =>
      "rest" in s && s.rest.path.endsWith("page=1")
        ? { status: "ahead", commits: Array.from({ length: 100 }, (_, i) => ({ commit: { message: `m${i}` } })) }
        : { status: "ahead", commits: [{ commit: { message: "last" } }] },
    );

    const messages = await githubReader(REPO, transport).commitMessages("main", SHA);

    expect(messages).toHaveLength(101);
    expect(messages[100]).toBe("last");
    expect(paths(sent)).toEqual([`/repos/o/r/compare/main...${SHA}?per_page=100&page=1`, `/repos/o/r/compare/main...${SHA}?per_page=100&page=2`]);
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

  describe("commitChecks", () => {
    const rollup = (nodes: readonly unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null }) => ({
      repository: { object: { statusCheckRollup: { contexts: { nodes, pageInfo } } } },
    });
    const run = (name: string, required = true) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", isRequired: required });
    const context = (name: string, required = false) => ({ __typename: "StatusContext", context: name, state: "PENDING", isRequired: required });

    it("reads every check run and status context, each with whether it is required for the pull request, every page", async () => {
      const { transport, sent } = recording((s) =>
        "variables" in s && s.variables["after"] === null
          ? rollup([run("verify"), context("ci/x")], { hasNextPage: true, endCursor: "c1" })
          : rollup([{ ...run("lint", false), status: "IN_PROGRESS", conclusion: null }]),
      );

      expect(await githubReader(REPO, transport).commitChecks(SHA, 7)).toEqual([
        { kind: "checkRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS", required: true },
        { kind: "status", context: "ci/x", state: "PENDING", required: false },
        { kind: "checkRun", name: "lint", status: "IN_PROGRESS", conclusion: null, required: false },
      ]);
      expect(sent.map((s) => ("variables" in s ? s.variables : undefined))).toEqual([
        { owner: "o", name: "r", sha: SHA, number: 7, after: null },
        { owner: "o", name: "r", sha: SHA, number: 7, after: "c1" },
      ]);
      expect("query" in sent[0]! && sent[0].query).toContain("isRequired(pullRequestNumber:$number)");
    });

    it("reads a commit with no check and no status, GitHub's null rollup, as none", async () => {
      const { transport } = recording(() => ({ repository: { object: { statusCheckRollup: null } } }));

      expect(await githubReader(REPO, transport).commitChecks(SHA, 7)).toEqual([]);
    });

    it.each([
      ["no repository", { repository: null }],
      ["no commit", { repository: { object: null } }],
      ["a commit without its rollup", { repository: { object: {} } }],
      ["a rollup with no list", { repository: { object: { statusCheckRollup: {} } } }],
      ["a list with no page info", { repository: { object: { statusCheckRollup: { contexts: { nodes: [] } } } } }],
      ["a check without isRequired", rollup([{ ...run("verify"), isRequired: undefined }])],
      ["a check of another kind", rollup([{ __typename: "Something", isRequired: true }])],
      ["a check run without a name", rollup([{ ...run("verify"), name: undefined }])],
      ["a status context without a state", rollup([{ ...context("ci/x"), state: undefined }])],
      ["a next page with no cursor", rollup([run("verify")], { hasNextPage: true, endCursor: null })],
    ])("throws on an answer with %s, rather than reading it as no checks", async (_name, answer) => {
      await expect(githubReader(REPO, recording(() => answer).transport).commitChecks(SHA, 7)).rejects.toThrow(/could not be read|cannot be read/);
    });
  });

  describe("behindBase", () => {
    it.each([
      [{ status: "ahead", behind_by: 0 }, "current"],
      [{ status: "identical", behind_by: 0 }, "current"],
      [{ status: "diverged", behind_by: 3 }, "behind"],
      [{ status: "behind", behind_by: 1 }, "behind"],
      [{ status: "ahead" }, "unknown"],
      [{ behind_by: "0" }, "unknown"],
      [{ behind_by: -1 }, "unknown"],
      [{ behind_by: 0.5 }, "unknown"],
      [null, "unknown"],
    ])("reads %j as %s", async (answer, currency) => {
      const { transport, sent } = recording(() => answer);

      expect(await githubReader(REPO, transport).behindBase("main", SHA)).toBe(currency);
      expect(paths(sent)).toEqual([`/repos/o/r/compare/main...${SHA}?per_page=1`]);
    });

    it("throws a refused compare rather than reading it as current", async () => {
      const { transport } = recording(() => {
        throw new GitHubError("GET compare: 404 Not Found", 404);
      });

      await expect(githubReader(REPO, transport).behindBase("main", SHA)).rejects.toBeInstanceOf(GitHubError);
    });
  });

  describe("permission", () => {
    it.each([
      [{ permission: "admin", role_name: "admin" }, "admin"],
      [{ permission: "write", role_name: "maintain" }, "maintain"],
      [{ permission: "write", role_name: "write" }, "write"],
      [{ permission: "read", role_name: "triage" }, "triage"],
      [{ permission: "read", role_name: "read" }, "read"],
      [{ permission: "none", role_name: "none" }, "none"],
      [{ permission: "write", role_name: "release-manager" }, "write"],
      [{ permission: "write" }, "write"],
      [{ permission: "superuser", role_name: "superuser" }, "unknown"],
      [{}, "unknown"],
      [null, "unknown"],
    ])("reads %j as %s", async (answer, permission) => {
      const { transport, sent } = recording(() => answer);

      expect(await githubReader(REPO, transport).permission("some[bot]")).toBe(permission);
      expect(paths(sent)).toEqual(["/repos/o/r/collaborators/some%5Bbot%5D/permission"]);
    });

    it("throws a refused lookup rather than reading it as none", async () => {
      const { transport } = recording(() => {
        throw new GitHubError("GET permission: 403 Resource not accessible by integration", 403);
      });

      await expect(githubReader(REPO, transport).permission("someone")).rejects.toBeInstanceOf(GitHubError);
    });
  });

  describe("openPullRequestsLabelled", () => {
    const pr = (number: number, labels: readonly string[]) => ({ number, head: { sha: SHA }, labels: labels.map((name) => ({ name })) });

    it("reads the open pull requests into a base carrying the label, every page, with their heads and labels", async () => {
      const { transport, sent } = recording((s) =>
        "rest" in s && s.rest.path.endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => pr(200 - i, i === 0 ? ["armed", "x"] : [])) : [pr(9, ["armed"])],
      );

      expect(await githubReader(REPO, transport).openPullRequestsLabelled("agent/prd-1-a", "armed")).toEqual([
        { number: 200, headSha: SHA, labels: ["armed", "x"] },
        { number: 9, headSha: SHA, labels: ["armed"] },
      ]);
      expect(paths(sent)).toEqual([
        "/repos/o/r/pulls?state=open&base=agent%2Fprd-1-a&per_page=100&page=1",
        "/repos/o/r/pulls?state=open&base=agent%2Fprd-1-a&per_page=100&page=2",
      ]);
    });

    it.each([
      ["an answer that is not a list", { message: "odd" }],
      ["a pull request without its labels", [{ number: 5, head: { sha: SHA } }]],
      ["a pull request without its head", [{ number: 5, labels: [{ name: "armed" }] }]],
    ])("throws on %s, rather than reading it as none", async (_name, answer) => {
      await expect(githubReader(REPO, recording(() => answer).transport).openPullRequestsLabelled("main", "armed")).rejects.toThrow(/could not be read|came back without/);
    });
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
