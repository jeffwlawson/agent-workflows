import type { Blocker, SubIssue } from "../engine/read.js";
import { FINAL_REVIEW_MARK, FIX_LABEL, IMPLEMENT_LABEL, REVIEW_LABEL, SLICE_TRAILER_LINE, UPDATE_BRANCH_LABEL } from "../shared/record.js";

/**
 * Where a PRD's chain stands, and what its next run does (PRD #222, #243):
 * the slice choice, the decision table and the "blocked by" checks
 * `implement-prd:gate` rules with. Pure. The gate reads the sub-issues, the
 * PRD branch's commits, the PRD PR and its head's verdict; this rules on
 * plain values, so every row of the table is a test without GitHub.
 */

/** Where the chain stands: what is built, and what is next. */
export interface Chain {
  /** The sub-issues, in the list's order, which is execution order. */
  readonly subIssues: readonly SubIssue[];
  /**
   * The slice to build next: the first open sub-issue no commit names in its
   * `Agent-Slice` trailer, and its place in the list, from 1. Undefined where
   * none is left.
   */
  readonly next: { readonly subIssue: SubIssue; readonly position: number } | undefined;
  /** The sub-issues a commit on the PRD branch names: built by this release. */
  readonly built: number;
  /**
   * Pre-upgrade compatibility, removable under #224: the closed sub-issues no
   * commit names, which landed before the upgrade, as slice PRs an older
   * release merged with no trailer. Never built again.
   */
  readonly beforeUpgrade: number;
  /** Every slice that landed, `built` and `beforeUpgrade` together: what the handover asks "more than one?" of. */
  readonly landed: number;
  /** The last sub-issue in the list a commit names: the slice the PRD PR's head is a round of. */
  readonly current: number | undefined;
}

/**
 * The chain, from the parent's sub-issues and the messages of the commits the
 * PRD branch has and the base lacks. A sub-issue is built when one of those
 * commits carries its `Agent-Slice` trailer, in any case, as git's own parser
 * reads it; never because it is closed, since no run closes one and closing
 * or reopening one by hand must not make the chain skip or repeat work. A
 * trailer naming no sub-issue in the list builds nothing.
 */
export const chainOf = (subIssues: readonly SubIssue[], messages: readonly string[]): Chain => {
  const named = new Set(messages.flatMap((message) => [...message.matchAll(SLICE_TRAILER_LINE)].map((match) => Number(match[1]))));
  const built = subIssues.filter((sub) => named.has(sub.number));
  const index = subIssues.findIndex((sub) => sub.state === "OPEN" && !named.has(sub.number));
  const next = subIssues[index];
  const beforeUpgrade = subIssues.filter((sub) => sub.state === "CLOSED" && !named.has(sub.number)).length;
  return {
    subIssues,
    next: next === undefined ? undefined : { subIssue: next, position: index + 1 },
    built: built.length,
    beforeUpgrade,
    landed: built.length + beforeUpgrade,
    current: built.at(-1)?.number,
  };
};

/** The PRD PR, as far as the decision reads it. */
export interface PrdPullRequest {
  readonly number: number;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
  readonly headSha: string;
}

/** The `agent-review` status on the PRD PR's head, the latest one, where there is one. */
export interface Verdict {
  readonly state: string;
  readonly description: string;
  readonly targetUrl: string | null;
}

/** The slice an approval moved the chain past: its sub-issue, the approved head and the review it links. */
export interface Approved {
  readonly subIssue: number;
  readonly sha: string;
  readonly review: string;
}

/** What the run does, once decided. A refusal is said on the parent, and is never blocked. */
export type Outcome =
  | { readonly kind: "build"; readonly approved?: Approved }
  | { readonly kind: "open-only" }
  | { readonly kind: "finishing"; readonly approved: Approved }
  | { readonly kind: "refuse"; readonly sentence: string };

/** Where the decision cannot be made without the PRD PR head's verdict: `afterVerdict` makes it. */
export interface NeedsVerdict {
  readonly kind: "verdict";
  readonly pr: PrdPullRequest;
}

/**
 * **The decision table**, up to the approval gate:
 *
 *   built   | PRD PR              | the run
 *   nothing | -                   | builds the first slice, or the first after the upgrade
 *   some    | none open           | opens it and asks for its review, since a run
 *           |                     |   died after its push
 *   some    | handed over, none   | refused: the PRD is finished
 *           |   left              |
 *   some    | a round in flight   | refused, until its label is gone
 *   some    | otherwise           | the head's verdict decides (`afterVerdict`)
 *
 * **Finished** is read off what the handover leaves, never off the draft
 * state alone: review keeps a PRD PR a draft through every slice round, but a
 * human can mark one ready by hand. With more than one slice landed, the
 * handover's mark in the body is the test; with one, ready is the whole
 * handover, so ready is finished, whoever marked it.
 *
 * A round in flight is never cut short, read off the trigger labels, which
 * are on while their run works and while it is queued (#236).
 */
export const decide = (chain: Chain, pr: PrdPullRequest | undefined): Outcome | NeedsVerdict => {
  if (chain.built === 0) {
    // Pre-upgrade compatibility, removable under #224: every sub-issue
    // closed before this release built any, so there is nothing to build and
    // no round of its own to finish on.
    if (chain.next === undefined) {
      return {
        kind: "refuse",
        sentence:
          "Every sub-issue of this PRD was closed before this release built any of them, so there's nothing left to build. To build more, add a sub-issue, or reopen one, first.",
      };
    }
    return { kind: "build" };
  }
  if (pr === undefined) return { kind: "open-only" };
  if (chain.next === undefined) {
    if (chain.landed > 1 && pr.body.includes(FINAL_REVIEW_MARK)) {
      return {
        kind: "refuse",
        sentence: `Every sub-issue of this PRD is built and the final review of PRD PR #${pr.number} was requested, so it's yours from here. To build more, add a sub-issue first.`,
      };
    }
    if (chain.landed === 1 && !pr.draft) {
      return { kind: "refuse", sentence: "Every sub-issue of this PRD is built and its PRD PR is ready for you. To build more, add a sub-issue first." };
    }
  }
  const busy = pr.labels.filter((label) => BUSY_LABELS.includes(label));
  if (busy.length > 0) {
    return {
      kind: "refuse",
      sentence: `PRD PR #${pr.number} still has \`${busy.join("`, `")}\`, so its review round hasn't ended and nothing was built. Add \`${IMPLEMENT_LABEL}\` again once that label is gone.`,
    };
  }
  return { kind: "verdict", pr };
};

/** The trigger labels whose run is a round of the PRD PR. */
const BUSY_LABELS: readonly string[] = [REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL];

/**
 * **The approval gate.** Read live off the PRD PR's head, never off the label
 * that started the run: anyone with triage rights can add that, and a human
 * re-adding it to a parked chain must get this refusal rather than the next
 * slice. Only an approval is `success`; a review that died posts `error`.
 * Past an approval the next slice is built, or, with none left, the PRD PR is
 * handed over by a finishing run that builds nothing.
 */
export const afterVerdict = (chain: Chain, pr: PrdPullRequest, verdict: Verdict | undefined): Outcome => {
  const ways = `To move on, add \`${FIX_LABEL}\` to PRD PR #${pr.number} for another fix round; or decline a finding by replying to it, then add \`${REVIEW_LABEL}\` there; or push a commit, then add \`${REVIEW_LABEL}\` there. The chain moves on once a review of the PRD PR's latest commit recommends approval.`;
  if (verdict === undefined) {
    return { kind: "refuse", sentence: `PRD PR #${pr.number}'s latest commit hasn't been reviewed, so the next slice wasn't started. ${ways}` };
  }
  if (verdict.state === "error") {
    return {
      kind: "refuse",
      sentence: `The review of PRD PR #${pr.number}'s latest commit didn't finish, so there's no verdict and the next slice wasn't started. ${ways}`,
    };
  }
  if (verdict.state !== "success") {
    const first = verdict.description.split(". ")[0] ?? "";
    return {
      kind: "refuse",
      sentence: `The review of PRD PR #${pr.number}'s latest commit didn't recommend approval (${first}), so the next slice wasn't started. ${ways}`,
    };
  }
  // `decide` asks for a verdict only where something is built, so there is a current slice.
  const approved: Approved = { subIssue: chain.current ?? 0, sha: pr.headSha, review: verdict.targetUrl ?? "" };
  return chain.next === undefined ? { kind: "finishing", approved } : { kind: "build", approved };
};

/**
 * **The links, checked once, before the first build**, one sub-issue at a
 * time, in the list's order: the refusal for sub-issue `sub`, blocked by
 * `blockers`, or undefined where its links agree with the order. A sub-issue
 * listed before one it is blocked by would be built on work that does not
 * exist yet, whatever that one's state; one blocked by an open issue outside
 * the PRD waits on a deliverable the chain does not build. Never as later
 * slices are reached: sub-issues stay open until the PRD PR merges, so a link
 * between two slices never clears while the chain runs.
 */
export const linkRefusal = (order: readonly number[], sub: number, blockers: readonly Blocker[]): string | undefined => {
  const at = order.indexOf(sub);
  const late = blockers.find((blocker) => order.indexOf(blocker.number) > at);
  if (late !== undefined) {
    return `Sub-issue #${sub} comes before #${late.number} in this PRD's sub-issue list, but it's blocked by #${late.number}, so it would be built first. Reorder the sub-issues so #${late.number} comes before #${sub}, then add \`${IMPLEMENT_LABEL}\` again.`;
  }
  const outside = blockers.find((blocker) => blocker.open && !order.includes(blocker.number));
  if (outside !== undefined) {
    return `Sub-issue #${sub} is blocked by #${outside.number}, which isn't part of this PRD, and the chain can't build #${sub} until #${outside.number} is done. Move that "blocked by" link from #${sub} to this issue, then add \`${IMPLEMENT_LABEL}\` again.`;
  }
  return undefined;
};

/**
 * The PRD's own open blockers, the refusal `implement` makes for the same
 * reason: a blocker is a separate deliverable, and labelling the thing
 * downstream must not authorise it. One sentence for one, another for several.
 */
export const blockerRefusal = (blockers: readonly number[]): string | undefined => {
  if (blockers.length === 0) return undefined;
  const named = blockers.map((blocker) => `#${blocker}`).join(", ");
  return blockers.length > 1
    ? `It's blocked by ${named}, which are still open. Add \`${IMPLEMENT_LABEL}\` again once they are closed, or remove the "blocked by" links that no longer apply.`
    : `It's blocked by ${named}, which is still open. Add \`${IMPLEMENT_LABEL}\` again once ${named} is closed, or remove the "blocked by" link if it no longer applies.`;
};
