/**
 * PROTOTYPE (#399), throwaway. `review:conclude`, run `always()`: how the run
 * ended, said in the loop's one order. A refusal's note, or a failure's error
 * verdict and comment; then `agent:review` off, however the run ended; then
 * the hand-off: `agent:review` again where the head moved, else `agent:fix`
 * where the review asked for a round.
 *
 * It is the ending, not only the failure path: taking the trigger label off
 * and the hand-offs after it happen on success too, and they come after
 * every result, so they cannot be publish's without publish being the ending.
 */
import { WriteFailed, type Writer } from "../engine/writer.js";
import type { GitHubReader } from "../engine/read.js";
import { FIX_ROUND_STATUS, VERDICT_CONTEXT, type Verdict } from "../shared/review-output.js";

export interface ConcludeInputs {
  readonly prNumber: number;
  readonly headRef: string;
  readonly reviewedSha: string;
  readonly proceeded: string;
  readonly reviewResult: string;
  readonly refusal: string;
  readonly blocked: boolean;
  readonly reviewFailureReason: string;
  readonly reviewRefusalReason: string;
  readonly timedOut: boolean;
  readonly timeoutMinutes: string;
  readonly mintOutcome: string;
  readonly publishOutcome: string;
  readonly loopTokenSource: string;
  readonly runUrl: string;
  /** The account the loop's own statuses carry. */
  readonly loopAccount: string;
}

export interface ConcludeIo {
  readonly workflow: Writer;
  /** Absent where the token's mint failed: one of the endings this reports. */
  readonly loop: Writer | undefined;
  readonly github: GitHubReader;
  /** What publish handed over, read only where publish finished. */
  readonly published: () => { readonly reviewUrl: string | undefined; readonly failureReason: string | undefined };
  readonly verdict: () => { readonly verdict: Verdict; readonly fixRound: boolean };
  readonly warn: (line: string) => void;
}

export interface Ended {
  readonly moved: boolean;
  readonly reviewUrl?: string;
}

const tolerated = async (warn: (line: string) => void, what: string, write: () => Promise<unknown>): Promise<void> => {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    warn(`${what}: ${error.message}`);
  }
};

const sentence = (reason: string): string => {
  const capital = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

export const conclude = async (inputs: ConcludeInputs, io: ConcludeIo): Promise<Ended> => {
  const { workflow, warn } = io;
  const pr = inputs.prNumber;
  const takeOff = () => tolerated(warn, "Could not remove agent:review", () => workflow.removeLabel(pr, "agent:review"));

  // A refusal, or a pre-flight that died before deciding.
  if (inputs.proceeded !== "true") {
    if (inputs.proceeded === "false") {
      await tolerated(warn, "Could not post the refusal", () => workflow.comment(pr, `**\`agent:review\` didn't run:** ${inputs.refusal}`));
    }
    await takeOff();
    if (inputs.proceeded === "false" && inputs.blocked) await tolerated(warn, "Could not add agent:blocked", () => workflow.addLabel(pr, "agent:blocked"));
    return { moved: false };
  }

  const reviewed = inputs.reviewResult === "success";
  const finished = reviewed && inputs.mintOutcome === "success" && inputs.publishOutcome === "success";
  if (!finished) {
    // The error verdict, then the comment, then the labels.
    await tolerated(warn, `Could not post the failed ${VERDICT_CONTEXT} verdict`, () =>
      workflow.commitStatus({
        sha: inputs.reviewedSha,
        context: VERDICT_CONTEXT,
        state: "error",
        description: "The review run did not finish, so there's no verdict. Check the run, then re-add agent:review.",
        targetUrl: inputs.runUrl,
      }),
    );
    const cancelled = "It was cancelled before it finished, by hand or by GitHub.";
    let reason = "It stopped without giving a reason. The workflow run's log has the details.";
    let refusal = "";
    if (reviewed) {
      // Three places a reason can come from now, one per step that can fail.
      if (inputs.mintOutcome !== "success") reason = "The loop's token could not be minted.";
      else if (inputs.publishOutcome === "cancelled") reason = cancelled;
      else reason = io.published().failureReason ?? reason;
    } else if (inputs.reviewResult === "cancelled") {
      reason = inputs.timedOut
        ? `It timed out after ${inputs.timeoutMinutes} minutes. The repository variable \`AGENT_REVIEW_TIMEOUT_MINUTES\` raises the review's own time, which its CI wait is added to.`
        : cancelled;
    } else {
      if (inputs.reviewFailureReason !== "") reason = inputs.reviewFailureReason;
      refusal = inputs.reviewRefusalReason;
    }
    const body =
      refusal !== ""
        ? `**\`agent:review\` didn't run:** ${refusal}\n`
        : `**\`agent:review\` stopped:** ${sentence(reason)}\n\n[Workflow run](${inputs.runUrl}) · To try again, add \`agent:review\`.\n`;
    await tolerated(warn, "Could not post the failure comment", () => workflow.comment(pr, body));
    await takeOff();
    await tolerated(warn, "Could not add agent:blocked", () => workflow.addLabel(pr, "agent:blocked"));
    const reviewUrl = reviewed && inputs.publishOutcome !== "skipped" ? io.published().reviewUrl : undefined;
    return { moved: false, ...(reviewUrl === undefined ? {} : { reviewUrl }) };
  }

  const { reviewUrl } = io.published();
  if (reviewUrl === undefined) throw new Error("publish finished without handing over the review's URL");
  await takeOff();

  // A request made while the run worked: the head moved, so ask again.
  const live = await io.github.pull(pr);
  if (live.state === "open" && live.headSha !== inputs.reviewedSha) {
    const busy = live.labels.filter((l) => l === "agent:review" || l === "agent:fix" || l === "agent:update-branch");
    if (busy.length > 0) {
      warn(`PR #${pr} moved on, but carries ${busy.join(",")}, so agent:review was not asked for again.`);
    } else if (io.loop === undefined || (inputs.loopTokenSource !== "app" && inputs.loopTokenSource !== "pat")) {
      await tolerated(warn, "Could not say the head moved", () =>
        workflow.comment(
          pr,
          `This PR moved on to \`${live.headSha}\` while its review of \`${inputs.reviewedSha}\` ran. No review of the new head will start on its own: neither the loop's App nor \`AGENT_PAT\` is set, and a label added with \`GITHUB_TOKEN\` starts nothing. Add \`agent:review\` by hand to review it.`,
        ),
      );
    } else {
      const loop = io.loop;
      await tolerated(warn, "Could not ask for agent:review again", () => loop.addLabel(pr, "agent:review"));
    }
    return { moved: true, reviewUrl };
  }

  // The fix round's hand-off, decided from live state.
  const { verdict, fixRound } = io.verdict();
  if (verdict !== "changes recommended" || !fixRound) return { moved: false, reviewUrl };
  const loop = io.loop;
  if (loop === undefined) throw new Error("a fix round was asked for with no loop token to start it");
  const noRound = async (why: string): Promise<never> => {
    await tolerated(warn, "…and that could not be said either", () =>
      loop.comment(pr, `No automatic fix round started: ${why}. Add \`agent:fix\` to start one by hand.`),
    );
    if (!inputs.headRef.startsWith("agent/prd-")) await tolerated(warn, "Could not mark it ready either", () => loop.markReady(pr));
    throw new Error(`No fix round started on PR #${pr}: ${why}.`);
  };
  if (live.labels.includes("agent:fix")) return { moved: false, reviewUrl };
  const statuses = await io.github.statuses(live.headSha);
  const ours = statuses.filter((s) => s.creator === inputs.loopAccount);
  const newest = ours.find((s) => s.context === VERDICT_CONTEXT);
  if (newest === undefined) return noRound(`the verdict that asked for it is not on the head commit \`${live.headSha}\``);
  if (newest.targetUrl !== reviewUrl) return { moved: false, reviewUrl };
  if (!ours.some((s) => s.context === FIX_ROUND_STATUS.context && s.targetUrl === reviewUrl)) {
    return noRound("the `agent-fix-round` status that counts it against the fix-round budget is not on the head");
  }
  await tolerated(warn, "Could not remove agent:fix first", () => loop.removeLabel(pr, "agent:fix"));
  try {
    await loop.addLabel(pr, "agent:fix");
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    return noRound("adding `agent:fix` failed, and GitHub's reply is in the write log");
  }
  return { moved: false, reviewUrl };
};
