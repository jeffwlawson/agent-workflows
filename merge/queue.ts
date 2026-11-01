import type { CommitCheck, CommitStatus, GitHubReader } from "../engine/read.js";
import { WriteFailed, type Writer } from "../engine/writer.js";
import { describe, tolerated } from "../shared/command-helpers.js";
import { AGENT_CHECKS, isLoopStatus } from "../shared/loop-checks.js";
import type { LoopAccounts } from "../shared/loop-accounts.js";
import { armOn } from "../shared/merge-arm.js";
import { FIX_LABEL, MERGE_LABEL, REVIEW_LABEL, UPDATE_BRANCH_LABEL } from "../shared/record.js";
import { newestVerdict } from "../shared/verdict-status.js";

/** The trigger labels whose runs move or read the head: while one is on, nothing merges, and nothing is refreshed. */
export const TRIGGERS: readonly string[] = [REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL];

/**
 * What a head's checks and verdict say, as the gate reads them: `red`, the
 * reasons it is red, and `pending`, what it still waits on. A head is red
 * where a counted check failed or the newest verdict of the loop's accounts
 * is neither `success` nor `pending`.
 *
 * The counted checks are the ones the base requires, by GitHub's own
 * `isRequired`, rulesets and branch protection alike. Where it requires none,
 * every check on the head but the loop's own (`shared/loop-checks.ts`) counts.
 */
export const readHead = (checks: readonly CommitCheck[], verdict: CommitStatus | undefined): { readonly red: readonly string[]; readonly pending: readonly string[] } => {
  const required = checks.filter((check) => check.required);
  const counted = required.length > 0 ? required : checks.filter((check) => !isLoops(check));
  const failed = counted.filter((check) => outcomeOf(check) === "failed").map(nameOf);
  const running = counted.filter((check) => outcomeOf(check) === "pending").map(nameOf);

  const red: string[] = [];
  if (failed.length > 0) red.push(`${required.length > 0 ? "A required check failed" : "A check failed"}: ${failed.join(", ")}.`);
  if (verdict !== undefined && verdict.state !== "success" && verdict.state !== "pending") {
    red.push(`The newest review verdict on it is \`${verdict.state}\`, not an approval.`);
  }
  const pending: string[] = [];
  if (running.length > 0) pending.push(`${required.length > 0 ? "A required check is" : "A check is"} still running: ${running.join(", ")}.`);
  if (verdict === undefined || verdict.state === "pending") pending.push("No review has approved it yet.");
  return { red, pending };
};

/** A check the loop posts or runs, which is not CI. */
const isLoops = (check: CommitCheck): boolean => (check.kind === "checkRun" ? AGENT_CHECKS.test(check.name) : isLoopStatus(check.context));

const nameOf = (check: CommitCheck): string => `\`${check.kind === "checkRun" ? check.name : check.context}\``;

/** A check as passed, failed or still pending, in GraphQL's spelling of each state. */
const outcomeOf = (check: CommitCheck): "passed" | "failed" | "pending" => {
  if (check.kind === "status") {
    if (check.state === "SUCCESS") return "passed";
    return check.state === "PENDING" || check.state === "EXPECTED" ? "pending" : "failed";
  }
  if (check.status !== "COMPLETED") return "pending";
  return check.conclusion === "SUCCESS" || check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED" ? "passed" : "failed";
};

/**
 * How many armed pull requests one request reads, at most: their statuses
 * each, for the arm's time, and their compare and checks in arm order until
 * one is chosen. Those past it are named in a warning and not read.
 */
export const NEXT_READS = 10;

/**
 * How many pull requests one request asks, at most: a label GitHub refuses on
 * the one chosen tries the next, and each try is one `removeLabel` and one
 * `addLabel`. A command's limits hold this many of each for the request.
 */
export const NEXT_TRIES = 3;

/** What a request for the next refresh needs: where the arm left the queue, and how to read and write there. */
export interface NextRefresh {
  /** The pull request that left the queue, merged or not: never the one refreshed. */
  readonly pr: number;
  readonly base: string;
  readonly github: GitHubReader;
  /** The loop token's writer, since a label the workflow token adds starts nothing. */
  readonly loop: Writer;
  /** The loop token's account, the only one whose arm is read. */
  readonly loopLogin: string;
  /** Whose verdicts are the loop's. */
  readonly accounts: LoopAccounts;
}

/**
 * **The queue drains one pull request at a time** (#590). Where an armed pull
 * request leaves the queue, merged, disarmed, red or refused, the next one
 * into the same base is refreshed: of the other open pull requests into
 * `base` carrying `agent:merge`, the one whose arm is oldest that is behind
 * its base, not red, and has no trigger label on. It gets
 * `agent:update-branch` with the loop's token, removed first so the add
 * fires (#236); its clean refresh carries its arm (#589), and its own gate
 * decides from there.
 *
 * Only one: refreshing every armed pull request costs about N²/2 refreshes on
 * a serial worker, since each later merge puts the rest behind again, and the
 * chain drains all the same, since each merge, and each arm that leaves the
 * queue without one, asks for the next.
 *
 * The arm's time is the one its description gives, or else its status's
 * (`shared/merge-arm.ts`); the number breaks a tie, and orders the arms whose
 * time cannot be read, after the rest. **Not red** is read as the gate reads
 * it (`readHead`): a pending check or verdict is not red, since the refresh is
 * what a behind head needs first. Every pull request passed over is named in
 * the log, and one with a trigger label on is re-started by its own run's
 * ending. A listing that fails is said, with the way to do it by hand, and
 * never fails the run: what made the request has already happened.
 */
export const refreshNext = async ({ pr, base, github, loop, loopLogin, accounts }: NextRefresh): Promise<number | undefined> => {
  const byHand = `Add \`${UPDATE_BRANCH_LABEL}\` to the next armed pull request into \`${base}\` by hand to move the queue on.`;
  let listed;
  try {
    listed = await github.openPullRequestsLabelled(base, MERGE_LABEL);
  } catch (error) {
    console.log(`::warning::The open pull requests into ${base} carrying ${MERGE_LABEL} could not be read (${describe(error)}), so no other armed pull request was refreshed. ${byHand}`);
    return undefined;
  }

  const others = listed.filter((other) => other.number !== pr).sort((a, b) => a.number - b.number);
  const idle = others.filter((other) => {
    // A draft's gate waits without moving the queue on, so asking it would
    // stall the rest behind a merge that is not coming.
    if (other.draft) {
      console.log(`Not refreshing PR #${other.number}: it is a draft, which nothing merges until it is marked ready.`);
      return false;
    }
    const busy = other.labels.filter((label) => TRIGGERS.includes(label));
    if (busy.length > 0) console.log(`Not refreshing PR #${other.number}: it carries ${busy.join(", ")}, and that run's ending re-starts its gate.`);
    return busy.length === 0;
  });
  const read = idle.slice(0, NEXT_READS);
  const past = idle.slice(NEXT_READS);
  if (past.length > 0) {
    console.log(`::warning::More than ${NEXT_READS} armed pull requests into ${base}, so ${past.map((p) => `#${p.number}`).join(", ")} were not read for the refresh.`);
  }

  // Each one's statuses, for the arm's time and the verdict, before any is chosen.
  const armed: { readonly number: number; readonly head: string; readonly at: string | undefined; readonly verdict: CommitStatus | undefined }[] = [];
  for (const other of read) {
    try {
      const statuses = await github.commitStatuses(other.headSha);
      const arm = armOn(statuses, loopLogin);
      if (arm === undefined) {
        console.log(`Not refreshing PR #${other.number}: its head carries no arm, and its own gate disarms it.`);
        continue;
      }
      armed.push({ number: other.number, head: other.headSha, at: arm.at, verdict: newestVerdict(statuses, accounts) });
    } catch (error) {
      console.log(`::warning::Not refreshing PR #${other.number}: its head's statuses could not be read (${describe(error)}).`);
    }
  }
  armed.sort((a, b) => {
    if (a.at !== b.at) {
      if (a.at === undefined) return 1;
      if (b.at === undefined) return -1;
      return a.at < b.at ? -1 : 1;
    }
    return a.number - b.number;
  });

  let tries = 0;
  for (const [at, other] of armed.entries()) {
    if (tries === NEXT_TRIES) {
      console.log(`::warning::${NEXT_TRIES} armed pull requests into ${base} refused ${UPDATE_BRANCH_LABEL}, so ${armed.slice(at).map((p) => `#${p.number}`).join(", ")} were not asked. ${byHand}`);
      return undefined;
    }
    try {
      const currency = await github.behindBase(base, other.head);
      if (currency !== "behind") {
        console.log(`Not refreshing PR #${other.number}: ${currency === "current" ? `it is current with ${base}` : `whether it is behind ${base} could not be told`}.`);
        continue;
      }
      const { red } = readHead(await github.commitChecks(other.head, other.number), other.verdict);
      if (red.length > 0) {
        console.log(`Not refreshing PR #${other.number}: it is red. ${red.join(" ")}`);
        continue;
      }
    } catch (error) {
      console.log(`::warning::Not refreshing PR #${other.number}: its head could not be read (${describe(error)}).`);
      continue;
    }
    tries++;
    await tolerated(undefined, () => loop.removeLabel(other.number, UPDATE_BRANCH_LABEL));
    try {
      await loop.addLabel(other.number, UPDATE_BRANCH_LABEL);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      console.log(`::warning::GitHub refused ${UPDATE_BRANCH_LABEL} on PR #${other.number}, so the next armed pull request is asked instead.`);
      continue;
    }
    console.log(`Asked for ${UPDATE_BRANCH_LABEL} on PR #${other.number}, the oldest armed pull request into ${base} that is behind and not red.`);
    return other.number;
  }
  if (tries > 0) {
    console.log(`::warning::No armed pull request into ${base} took ${UPDATE_BRANCH_LABEL}. ${byHand}`);
  } else {
    console.log(`No other armed pull request into ${base} is behind and not red, so none was refreshed.`);
  }
  return undefined;
};
