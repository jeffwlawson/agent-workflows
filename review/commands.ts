/**
 * PROTOTYPE (#399), throwaway. What `cli.ts` does for `review:publish` and
 * `review:conclude` (ADR 0004): read the declared inputs, build the real
 * writers and reader, call the function, and turn a throw into `fail()`.
 */
import { fetchTransport } from "../engine/github.js";
import { githubReader } from "../engine/read.js";
import { createWriters, type Caps } from "../engine/writer.js";
import { COMMANDS } from "../shared/contract.js";
import { fail, readInputs, writers } from "../shared/env.js";
import { conclude } from "./conclude.js";
import { directory, NO_CLEANUP, readReviewHandOver, readVerdict } from "./hand-over.js";
import { publish } from "./publish.js";

/**
 * Per command, since a cap is a bound on what one command can do. The thread
 * cap is the one that has a real number behind it: a review closes at most
 * the threads it carried.
 */
export const PUBLISH_CAPS: Caps = {
  replyAndResolve: 50,
  postReview: 1,
  editPullRequest: 2,
  addLabel: 1,
  removeLabel: 1,
  commitStatus: 2,
  markReady: 1,
  comment: 0,
};

export const CONCLUDE_CAPS: Caps = {
  replyAndResolve: 0,
  postReview: 0,
  editPullRequest: 0,
  addLabel: 2,
  removeLabel: 2,
  commitStatus: 1,
  markReady: 1,
  comment: 2,
};

const warn = (line: string): void => console.log(`::warning::${line}`);

export const runPublish = async (): Promise<void> => {
  const declared = COMMANDS["review:publish"];
  const env = readInputs(declared.inputs);
  const out = writers(declared.outputs);
  const { writers: w } = createWriters({
    repo: env.GH_REPO,
    transports: { workflow: fetchTransport(env.GH_TOKEN), loop: fetchTransport(env.LOOP_TOKEN) },
    caps: PUBLISH_CAPS,
    sink: (entry) => out.appendLine("write_log.jsonl", JSON.stringify(entry)),
  });
  try {
    const handOver = readReviewHandOver(directory(env.REVIEW_DIR, declared.reads.REVIEW_DIR), { reviewedSha: env.REVIEWED_SHA }, NO_CLEANUP);
    await publish(
      { prNumber: Number(env.PR_NUMBER), headRef: env.HEAD_REF, reviewedSha: env.REVIEWED_SHA, round: env.ROUND },
      {
        workflow: w.workflow,
        loop: w.loop,
        github: githubReader(env.GH_REPO, fetchTransport(env.GH_TOKEN)),
        handOver,
        warn,
        published: (value) => out.writeJson("published.json", value),
      },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
};

export const runConclude = async (): Promise<void> => {
  const declared = COMMANDS["review:conclude"];
  const env = readInputs(declared.inputs);
  const out = writers(declared.outputs);
  const { writers: w } = createWriters({
    repo: env.GH_REPO,
    transports: {
      workflow: fetchTransport(env.GH_TOKEN),
      ...(env.LOOP_TOKEN === "" ? {} : { loop: fetchTransport(env.LOOP_TOKEN) }),
    } as Record<"workflow" | "loop", ReturnType<typeof fetchTransport>>,
    caps: CONCLUDE_CAPS,
    sink: (entry) => out.appendLine("write_log.jsonl", JSON.stringify(entry)),
  });
  const publishDir = directory(env.PUBLISH_DIR, declared.reads.PUBLISH_DIR);
  try {
    const ended = await conclude(
      {
        prNumber: Number(env.PR_NUMBER),
        headRef: env.HEAD_REF,
        reviewedSha: env.REVIEWED_SHA,
        proceeded: env.PROCEEDED,
        reviewResult: env.REVIEW_RESULT,
        refusal: env.REFUSAL,
        blocked: env.BLOCKED === "true",
        reviewFailureReason: env.REVIEW_FAILURE_REASON,
        reviewRefusalReason: env.REVIEW_REFUSAL_REASON,
        timedOut: env.TIMED_OUT === "true",
        timeoutMinutes: env.TIMEOUT_MINUTES,
        mintOutcome: env.MINT_OUTCOME,
        publishOutcome: env.PUBLISH_OUTCOME,
        loopTokenSource: env.LOOP_TOKEN_SOURCE,
        runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
        loopAccount: "github-actions[bot]",
      },
      {
        workflow: w.workflow,
        loop: env.LOOP_TOKEN === "" ? undefined : w.loop,
        github: githubReader(env.GH_REPO, fetchTransport(env.GH_TOKEN)),
        published: () => {
          const value = publishDir.json("published.json") as { reviewUrl?: string } | undefined;
          return { reviewUrl: value?.reviewUrl, failureReason: publishDir.text("failure_reason.txt")?.trim() };
        },
        verdict: () => readVerdict(directory(env.REVIEW_DIR, declared.reads.REVIEW_DIR).json("verdict.json")),
        warn,
      },
    );
    out.writeJson("ended.json", ended);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
};
