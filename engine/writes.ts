/**
 * What each write type does on GitHub: the `Backend` a run's writers are built
 * over. Every mutation is written here, so a write's caller supplies values and
 * never a query.
 */
import { GitHubError, isServerError, type Transport } from "./github.js";
import { githubReader, toPullRequest, type RawPullRequest } from "./read.js";
import { ReadBackFailed, type Backend, type Call, type GitWriteType, type Tolerated } from "./writer.js";

/** A label that is not there to remove: the write is already done. */
const LABEL_ABSENT: Tolerated = {
  when: (error) => error instanceof GitHubError && error.status === 404,
  reason: "label not present",
};

export const ADD_REVIEW = `mutation($input:AddPullRequestReviewInput!){
  addPullRequestReview(input:$input){pullRequestReview{url}}
}`;

export const REPLY_TO_THREAD = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){clientMutationId}
}`;

export const RESOLVE_THREAD = `mutation($threadId:ID!,$reason:PullRequestReviewThreadResolutionReason!){
  resolveReviewThread(input:{threadId:$threadId,resolutionReason:$reason}){clientMutationId}
}`;

export const MARK_READY = `mutation($id:ID!){
  markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}
}`;

/**
 * The writes for `repo` (`owner/name`), over `transport`, which holds the
 * token: every write type but the git ones, which `gitWrites` makes.
 */
export const githubWrites = (repo: string, transport: Transport): Omit<Backend, GitWriteType> => {
  const issue = (number: number): string => `/repos/${repo}/issues/${number}`;
  const pull = (number: number): string => `/repos/${repo}/pulls/${number}`;
  const reader = githubReader(repo, transport);
  const livePull = async (call: Call, number: number) =>
    toPullRequest((await call("GET pull", () => transport.rest({ method: "GET", path: pull(number) }), "read")) as RawPullRequest);

  return {
    addLabel: async (call, number, label) => {
      await call("POST labels", () => transport.rest({ method: "POST", path: `${issue(number)}/labels`, body: { labels: [label] } }));
      return { outcome: "applied" };
    },
    removeLabel: async (call, number, label) => {
      try {
        await call(
          "DELETE label",
          () => transport.rest({ method: "DELETE", path: `${issue(number)}/labels/${encodeURIComponent(label)}` }),
          "write",
          LABEL_ABSENT,
        );
        return { outcome: "applied" };
      } catch (error) {
        if (LABEL_ABSENT.when(error)) return { outcome: "unchanged" };
        throw error;
      }
    },
    setCommitStatus: async (call, status) => {
      await call("POST status", () =>
        transport.rest({
          method: "POST",
          path: `/repos/${repo}/statuses/${status.sha}`,
          body: {
            context: status.context,
            state: status.state,
            description: status.description,
            ...(status.targetUrl === undefined ? {} : { target_url: status.targetUrl }),
          },
        }),
      );
      return { outcome: "applied" };
    },
    comment: async (call, number, body) => {
      const posted = (await call("POST comment", () => transport.rest({ method: "POST", path: `${issue(number)}/comments`, body: { body } }))) as {
        readonly html_url: string;
      };
      return { outcome: "applied", url: posted.html_url };
    },
    markReadyForReview: async (call, number) => {
      const live = await livePull(call, number);
      if (!live.draft) return { outcome: "unchanged" };
      await call("markPullRequestReadyForReview", () => transport.graphql(MARK_READY, { id: live.nodeId }));
      return { outcome: "applied" };
    },
    postReview: async (call, variables) => {
      const data = (await call("addPullRequestReview", () =>
        transport.graphql(ADD_REVIEW, {
          input: {
            pullRequestId: variables.pullRequestId,
            commitOID: variables.commitOID,
            body: variables.body,
            event: "COMMENT",
            threads: variables.threads,
          },
        }),
      )) as { readonly addPullRequestReview: { readonly pullRequestReview: { readonly url: string } } };
      return { outcome: "applied", url: data.addPullRequestReview.pullRequestReview.url };
    },
    replyAndResolve: async (call, thread) => {
      const { reply } = thread;
      if (reply !== undefined) {
        await call("reply", () => transport.graphql(REPLY_TO_THREAD, { threadId: thread.threadId, body: reply }));
      }
      await call("resolve", () => transport.graphql(RESOLVE_THREAD, { threadId: thread.threadId, reason: thread.reason }));
      return { outcome: "applied" };
    },
    reply: async (call, reply) => {
      await call("reply", () => transport.graphql(REPLY_TO_THREAD, { threadId: reply.threadId, body: reply.body }));
      return { outcome: "applied" };
    },
    openPullRequest: async (call, open) => {
      let opened: { readonly number: number; readonly html_url: string };
      try {
        opened = (await call("POST pulls", () =>
          transport.rest({
            method: "POST",
            path: `/repos/${repo}/pulls`,
            body: { base: open.base, head: open.head, title: open.title, body: open.body, draft: open.draft },
          }),
        )) as typeof opened;
      } catch (error) {
        // GitHub has answered an open with an error and opened the pull
        // request all the same (#329), so a server error is read back before
        // it is called a failure: by head and base, never by the body.
        if (!isServerError(error)) throw error;
        let found;
        try {
          found = await call("GET pulls", () => reader.openPullRequest(open.head, open.base), "read");
        } catch (readError) {
          throw new ReadBackFailed(error, readError);
        }
        if (found === undefined) throw error;
        return { outcome: "applied", number: found.number, url: found.url, readBack: error instanceof Error ? error.message : String(error) };
      }
      return { outcome: "applied", number: opened.number, url: opened.html_url };
    },
    createIssue: async (call, create) => {
      let created: { readonly number: number; readonly html_url: string };
      try {
        created = (await call("POST issues", () =>
          transport.rest({
            method: "POST",
            path: `/repos/${repo}/issues`,
            body: { title: create.title, body: create.body, labels: create.labels },
          }),
        )) as typeof created;
      } catch (error) {
        // As an open is (#329): a server error is read back before it is
        // called a failure, by the caller's label and match, never by search.
        if (!isServerError(error)) throw error;
        let found;
        try {
          found = (await call("GET issues", () => reader.labelledIssues(create.readBack.label), "read")).find((issue) =>
            create.readBack.matches(issue.body),
          );
        } catch (readError) {
          throw new ReadBackFailed(error, readError);
        }
        if (found === undefined) throw error;
        return { outcome: "applied", number: found.number, url: found.url, readBack: error instanceof Error ? error.message : String(error) };
      }
      return { outcome: "applied", number: created.number, url: created.html_url };
    },
    editPullRequest: async (call, number, edit) => {
      // Read whatever the edit names, title or body or neither, so "nothing to
      // change" is judged against the live pull request the same way for each.
      const live = await livePull(call, number);
      const body = edit.body?.(live.body);
      const patch = {
        ...(edit.title === undefined || edit.title === live.title ? {} : { title: edit.title }),
        ...(body === undefined || body === live.body ? {} : { body }),
      };
      if (Object.keys(patch).length === 0) return { outcome: "unchanged" };
      await call(`PATCH ${Object.keys(patch).join("+")}`, () => transport.rest({ method: "PATCH", path: pull(number), body: patch }));
      return { outcome: "applied" };
    },
  };
};
