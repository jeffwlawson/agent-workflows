/**
 * What each write type does on GitHub: the `Backend` a run's writers are built
 * over. Every mutation is written here, so a write's caller supplies values and
 * never a query.
 */
import { GitHubError, type Transport } from "./github.js";
import { toPullRequest, type RawPullRequest } from "./read.js";
import type { Backend, Call } from "./writer.js";

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

/** The writes for `repo` (`owner/name`), over `transport`, which holds the token. */
export const githubWrites = (repo: string, transport: Transport): Backend => {
  const issue = (number: number): string => `/repos/${repo}/issues/${number}`;
  const pull = (number: number): string => `/repos/${repo}/pulls/${number}`;
  const livePull = async (call: Call, number: number) =>
    toPullRequest((await call("GET pull", () => transport.rest({ method: "GET", path: pull(number) }), "read")) as RawPullRequest);

  return {
    addLabel: async (call, number, label) => {
      await call("POST labels", () => transport.rest({ method: "POST", path: `${issue(number)}/labels`, body: { labels: [label] } }));
      return { outcome: "applied" };
    },
    removeLabel: async (call, number, label) => {
      try {
        await call("DELETE label", () => transport.rest({ method: "DELETE", path: `${issue(number)}/labels/${encodeURIComponent(label)}` }));
        return { outcome: "applied" };
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return { outcome: "unchanged" };
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
    editPullRequest: async (call, number, edit) => {
      const live = edit.body === undefined ? undefined : await livePull(call, number);
      const body = live === undefined || edit.body === undefined ? undefined : edit.body(live.body);
      const patch = {
        ...(edit.title === undefined || edit.title === live?.title ? {} : { title: edit.title }),
        ...(body === undefined || body === live?.body ? {} : { body }),
      };
      if (Object.keys(patch).length === 0) return { outcome: "unchanged" };
      await call(`PATCH ${Object.keys(patch).join("+")}`, () => transport.rest({ method: "PATCH", path: pull(number), body: patch }));
      return { outcome: "applied" };
    },
  };
};
