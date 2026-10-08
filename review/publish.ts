/**
 * PROTOTYPE (#399), throwaway. `review:publish`: every result the review
 * produced, posted in the loop's one order, against the engine's writers.
 * Steps 1 to 5 of `post-review` in `review.yml`. Taking `agent:review` off,
 * re-requesting it and the fix round's hand-off are `review:conclude`'s,
 * because they happen however the run ended.
 *
 * Throws to stop. A write the loop can live without is caught here, on
 * purpose, and said as a warning, which is what `|| echo ::warning::` was.
 */
import { dropBlock, spliceBlock } from "../engine/splice.js";
import { WriteFailed, type Writer } from "../engine/writer.js";
import type { GitHubReader } from "../engine/read.js";
import { STATUS_END, STATUS_START } from "../shared/progress-list.js";
import { REVIEW_URL_SLOT } from "../shared/prd-round.js";
import { FIX_ROUND_STATUS, VERDICT_CONTEXT } from "../shared/review-output.js";
import type { ReviewHandOver } from "./hand-over.js";

export interface PublishInputs {
  readonly prNumber: number;
  readonly headRef: string;
  readonly reviewedSha: string;
  readonly round: string;
}

export interface PublishIo {
  readonly workflow: Writer;
  readonly loop: Writer;
  readonly github: GitHubReader;
  readonly handOver: ReviewHandOver;
  readonly warn: (line: string) => void;
  /** What `review:conclude` reads: written the moment the review is posted, so a later crash keeps it. */
  readonly published: (value: { readonly reviewUrl: string }) => void;
}

/** One group, as the runner's `renderGroup` writes it, or nothing where it is empty. The `jq` `group` def, ported. */
const group = (head: { readonly title: string; readonly open: boolean; readonly subtitle?: string }, lines: readonly string[]): string | undefined =>
  lines.length === 0
    ? undefined
    : [
        `<details${head.open ? " open" : ""}>`,
        `<summary><b>${head.title}</b> (${lines.length})</summary>`,
        ...(head.subtitle === undefined ? [] : ["", `_${head.subtitle}_`]),
        "",
        ...lines,
        "",
        "</details>",
      ].join("\n");

/** A write the loop can live without: tried, and said as a warning where it fails. */
const tolerated = async (warn: (line: string) => void, what: string, write: () => Promise<unknown>): Promise<void> => {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    warn(`${what}: ${error.message}`);
  }
};

export const publish = async (inputs: PublishInputs, io: PublishIo): Promise<void> => {
  const { workflow, loop, handOver, warn } = io;
  const pr = inputs.prNumber;
  const prd = inputs.headRef.startsWith("agent/prd-");

  // A block an earlier run left. Tolerated, as `|| true` was.
  await tolerated(warn, "Could not remove agent:blocked", () => workflow.removeLabel(pr, "agent:blocked"));

  // Step 1: the threads this review closed. A target (#403): a thread id that
  // is not one of this pull request's is refused before any write is made
  // with it. Read here, since the check needs live state the reader cannot have.
  const threads = await io.github.reviewThreadIds(pr);
  const strays = handOver.resolutions.filter((r) => !threads.has(r.threadId));
  if (strays.length > 0) throw new Error(`The review closed threads that are not on PR #${pr}: ${strays.map((r) => r.threadId).join(", ")}`);
  const closed = new Set<string>();
  for (const resolution of handOver.resolutions) {
    try {
      await workflow.replyAndResolve({
        threadId: resolution.threadId,
        reply: resolution.alreadyReplied ? undefined : resolution.reply,
        reason: resolution.reason,
      });
      closed.add(resolution.threadId);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      warn(`Thread ${resolution.threadId} is left open, and the overview lists it as still open: ${error.message}`);
    }
  }

  // Step 2: the review, its Resolved groups from what step 1 actually closed.
  const { body } = handOver;
  const unclosed = body.resolved.filter((r) => r.threadId !== undefined && !closed.has(r.threadId));
  const kept = body.resolved.filter((r) => r.threadId === undefined || closed.has(r.threadId));
  const [before = "", after = ""] = body.slotted.split(`\n\n${body.slot}`);
  const groups = [group(body.groups.unclosed, unclosed.map((r) => r.line)), group(body.groups.resolved, kept.map((r) => r.line))]
    .filter((g) => g !== undefined)
    .map((g) => `\n\n${g}`)
    .join("");
  // Not tolerated: no review, no verdict. The throw ends publish, and conclude
  // posts the error verdict and the failure comment.
  //
  // The engine's error names the call, not what it means, so a write that
  // stops the command is caught here for the sentence the failure comment
  // shows a human, the one `failure_reason.txt` carried before.
  let url: string;
  try {
    ({ url } = await workflow.postReview({ ...handOver.review, body: `${before}${groups}${after}` }));
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(
      "GitHub refused the review, so it was not posted. Its threads are not on the pull request and there is no verdict; the earlier threads this review closed were resolved where GitHub allowed it, and the write log names any that were not.",
      { cause: error },
    );
  }
  io.published({ reviewUrl: url });

  // Step 3: the title and the summary block, against the body as it stands now.
  const summary = handOver.summary;
  if (summary !== undefined) {
    await tolerated(warn, "Could not write the title and summary", () =>
      workflow.editPullRequest(pr, {
        ...(summary.title === undefined ? {} : { title: summary.title }),
        ...(summary.block === undefined && summary.drop === undefined
          ? {}
          : {
              body: (live) => {
                const block = summary.block;
                const spliced = block === undefined ? live : spliceBlock(live, block, `${block.start}\n${block.inner}\n${block.end}`, "append");
                if (spliced === undefined) {
                  warn(`PR #${pr}'s body carries half a summary block, or two, so the summary was not written.`);
                  return undefined;
                }
                return summary.drop === undefined ? spliced : (dropBlock(spliced, summary.drop) ?? spliced);
              },
            }),
      }),
    );
  }

  // Step 3b: off a PRD PR, the status line, linking the review just posted.
  const statusLine = handOver.statusLine;
  if (!prd && statusLine !== undefined) {
    const line = statusLine.split(REVIEW_URL_SLOT).join(url);
    await tolerated(warn, "Could not write the status line", () =>
      workflow.editPullRequest(pr, { body: (live) => (live === "" ? undefined : spliceBlock(live, { start: STATUS_START, end: STATUS_END }, line, "leave")) }),
    );
  }

  // The follow-ups marker, where the run recorded any.
  if (handOver.followUps) await tolerated(warn, "Could not add agent:follow-ups", () => workflow.addLabel(pr, "agent:follow-ups"));

  // Step 4: the verdict on the reviewed commit, and the fix round's record beside it.
  await tolerated(warn, `Could not post the ${VERDICT_CONTEXT} verdict`, () =>
    workflow.commitStatus({ sha: inputs.reviewedSha, context: VERDICT_CONTEXT, ...handOver.status, targetUrl: url }),
  );
  if (handOver.fixRound) {
    await tolerated(warn, `Could not post the ${FIX_ROUND_STATUS.context} status`, () =>
      workflow.commitStatus({ sha: inputs.reviewedSha, ...FIX_ROUND_STATUS, targetUrl: url }),
    );
  }

  // Step 5: ready, unless a fix round is about to start; on a PRD PR only on
  // the final review's approval. The loop's token: the workflow's cannot.
  if (!handOver.fixRound && (!prd || (inputs.round === "final" && handOver.verdict === "approval recommended"))) {
    await tolerated(warn, `Could not mark PR #${pr} ready for review`, () => loop.markReady(pr));
  }
};
