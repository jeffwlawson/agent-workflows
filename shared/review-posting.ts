import type { GitHubReader } from "../engine/read.js";
import { REVIEW_LABEL } from "./record.js";

/**
 * **The wait for a review's posting to finish** (#257), for a run that reads
 * what a review posts: its threads, its findings and its verdict.
 *
 * A review's posting job runs outside the pull request's concurrency group:
 * the group is released when the review job ends, before the review, its
 * threads and its verdict are posted, so a run that waited in the group
 * behind a review starts while they are still being written. So this waits
 * while `agent:review` is on the pull request, which the posting job takes off
 * only after every result is posted (`review.yml`'s *No concurrency group* on
 * `post-review`).
 *
 * Bounded, by the posting job's own `timeout-minutes`, and then it goes on
 * with a warning: a label nobody will take off (a review run that never
 * started, or one labelled behind this run in the group) is no reason to
 * fail, and is what the bound is for. An unreadable label keeps waiting,
 * since "could not tell" must not read as "nothing is posting". It writes
 * nothing.
 *
 * `fix:gate` waits with it (#470), and `update-branch` will when its steps
 * move; until then `update-branch.yml` keeps a shell copy, and
 * `tests/post-wait-step.test.ts` runs the same scenarios over both.
 */
export const waitForReviewPosting = async (
  github: Pick<GitHubReader, "pullRequest">,
  pr: number,
  bound: { readonly waitSeconds: number; readonly pollSeconds: number },
): Promise<void> => {
  const deadline = Date.now() + bound.waitSeconds * 1000;
  for (;;) {
    let labels: readonly string[] | undefined;
    try {
      labels = (await github.pullRequest(pr)).labels;
    } catch (error) {
      console.log(`Could not read PR #${pr}'s labels (${error instanceof Error ? error.message : String(error)}), so this keeps waiting.`);
    }
    if (labels !== undefined && !labels.includes(REVIEW_LABEL)) {
      console.log(`No review is posting on PR #${pr}.`);
      return;
    }
    if (Date.now() >= deadline) {
      console.log(
        `::warning::\`${REVIEW_LABEL}\` is still on PR #${pr} (or its labels could not be read) after ${bound.waitSeconds} seconds, so this run goes on without waiting for a review to finish posting. If a review was posting, this run may not see its findings or its verdict.`,
      );
      return;
    }
    if (labels !== undefined) console.log(`${REVIEW_LABEL} is on PR #${pr}: waiting for the review's posting job to finish.`);
    await new Promise((resolve) => setTimeout(resolve, bound.pollSeconds * 1000));
  }
};
