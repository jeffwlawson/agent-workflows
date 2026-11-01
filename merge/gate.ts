import type { CommitStatus, GitHubReader, PullRequest } from "../engine/read.js";
import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import { describe, pullRequestNumber, seconds, tolerated } from "../shared/command-helpers.js";
import type { LoopReadingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { isWorkflowBot, loopAccounts, type LoopAccounts } from "../shared/loop-accounts.js";
import { armOn, sameAccount } from "../shared/merge-arm.js";
import {
  armDescription,
  disarmComment,
  MERGE_CONTEXT,
  MERGE_LABEL,
  mergeBehindComment,
  mergeBehindMark,
  mergeRedComment,
  mergeRedMark,
  mergeRefreshCapComment,
  mergeRefusal,
  UPDATE_BRANCH_LABEL,
} from "../shared/record.js";
import { newestVerdict } from "../shared/verdict-status.js";
import { NEXT_TRIES, readHead, refreshNext, TRIGGERS } from "./queue.js";

type Declared = (typeof COMMANDS)["merge:gate"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = LoopReadingIo<Declared["outputs"]>;

/** What the gate came to, as `gate.json` hands it on. */
export type Decision = "merge" | "wait" | "behind" | "red" | "disarmed" | "refused";

/**
 * `merge:gate` (#588): the maintainer's merge decision, checked against the
 * record and carried out only as far as deciding. It merges nothing itself:
 * `merge:publish` does that, on `merge`, guarded on the head this checked.
 *
 * In the loop's order:
 *
 * - **Refusals**, each said on the pull request in the `didn't run` pattern,
 *   with `agent:merge` off: a closed pull request, a draft, a fork, only the
 *   workflow token, and a labeller who can neither write nor is the loop
 *   token's account. Nothing is armed or merged.
 * - **The arm**, on a label a person who can write added: `agent-merge`
 *   posted on the payload's head with the loop's token, its description
 *   naming them, the time, and a refresh count of 0 (#589). Where the live
 *   head is already another commit, it disarms instead: a label added just
 *   after a push can carry the commit before it (#229). A label the loop's
 *   own account added never arms, and neither does a push (`synchronize`).
 * - **The state of the head**, polled up to `CHECK_WAIT_SECONDS` while
 *   anything is pending: `disarmed` where the head carries no arm of the loop
 *   token's account (never `github-actions[bot]`'s, which any workflow in the
 *   pull request's branch can post as), unless `agent:update-branch` is on,
 *   which is a `wait`: that refresh's push starts a gate before its carry of
 *   the arm may have landed, and its conclusion re-starts the gate; `wait`
 *   while another trigger label is on, a check or the verdict is pending, or
 *   the bound runs out; `red` where a required check failed or the verdict is
 *   not an approval, said once per head, the arm left on; `behind` where the
 *   base's tip is not in the head's history, said once per head, the arm left
 *   on and `agent:update-branch` asked for with the loop's token, or
 *   `disarmed` once the arm has survived `MAX_REFRESHES` clean refreshes; and
 *   `merge` otherwise.
 *
 * **The queue moves on** where an arm leaves it without a merge (#590): a
 * refusal, a disarm, and the first gate to say a head is red each ask for the
 * next armed pull request's refresh, as `merge:publish` does after a merge
 * (`refreshNext` in `merge/queue.ts`). A second gate on the same red head
 * asks for nothing.
 *
 * `gate.json` is the decision and the head it checked, written as soon as it
 * is decided and again however this ends, as `fix:gate`'s is: a cancel
 * reaches Node as a signal, which runs no `finally`.
 *
 * The arm is the loop token's, since only that account cannot be posted as
 * from a pull request's branch. The labeller's permission is read with it too
 * (#77), and the refresh is asked for with it, since a label the workflow
 * token adds starts nothing. Every other write is the workflow token's.
 */
export const gate = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const eventHead = commit(inputs.HEAD_SHA, "HEAD_SHA");
  const waitSeconds = seconds(inputs.CHECK_WAIT_SECONDS, "CHECK_WAIT_SECONDS");
  const pollSeconds = seconds(inputs.CHECK_POLL_SECONDS, "CHECK_POLL_SECONDS");
  const accounts = loopAccounts(inputs.AGENT_LOOP_LOGINS);
  const decided: { decision?: Decision; head?: string } = {};
  const decide = (decision: Decision, head?: string): void => {
    decided.decision = decision;
    if (head !== undefined) decided.head = head;
    io.outputs.writeJson("gate.json", decided);
  };
  try {
    const { workflow, loop } = io.writers(LIMITS);
    // An arm that leaves the queue without a merge moves it on (#590): it may
    // have been the one the last merge refreshed, and the rest would wait on
    // a merge that is not coming.
    const next = async (): Promise<void> => {
      await refreshNext({ pr, base: inputs.BASE_REF, github: io.github, loop, loopLogin: inputs.LOOP_LOGIN, accounts });
    };
    const refusal = refusalOf(inputs);
    if (refusal !== undefined) {
      await refuse(pr, workflow, refusal);
      // Without the loop's token, a label added starts nothing.
      if (canStart(inputs)) await next();
      decide("refused");
      return;
    }

    // A label the loop's own account added re-starts the gate and never arms,
    // and a push (`synchronize`, #589) arms nothing either: it is what moved
    // the head off the commit the maintainer decided on.
    const labelled = inputs.ACTION === "labeled";
    const byLoop = labelled && sameAccount(inputs.SENDER, inputs.LOOP_LOGIN);
    const arming = labelled && !byLoop;
    if (arming) {
      const permission = await io.loopGithub.permission(inputs.SENDER);
      if (!WRITERS.has(permission)) {
        await refuse(
          pr,
          workflow,
          permission === "unknown"
            ? `@${inputs.SENDER} added it, and whether they can write to this repository could not be established, so it was not taken as a merge decision. Someone who can write has to add it.`
            : `@${inputs.SENDER} added it, and can only ${permission === "none" ? "read" : permission} here, so it was not taken as a merge decision: it is worth exactly what the merge button is. Someone who can write has to add it.`,
        );
        await next();
        decide("refused");
        return;
      }
    }

    // The arm, on a writer's label only, and only on the head it was added
    // at: a live head that moved since is not the commit they decided on.
    let armedAt: Armed | undefined;
    if (arming) {
      const live = await io.github.pullRequest(pr);
      if (live.headSha !== eventHead) {
        await disarm(pr, workflow, live.headSha, { commit: eventHead, login: inputs.SENDER });
        await next();
        decide("disarmed", live.headSha);
        return;
      }
      // From #589 the arm says when it was made and how many clean refreshes
      // it has survived, which a clean refresh's carry keeps and counts.
      const at = new Date().toISOString().replace(/\.[0-9]+Z$/, "Z");
      try {
        await loop.setCommitStatus({
          sha: eventHead,
          context: MERGE_CONTEXT,
          state: "success",
          description: armDescription({ login: inputs.SENDER, at, refreshes: 0 }),
        });
      } catch (error) {
        if (!(error instanceof WriteFailed)) throw error;
        throw new Error(
          `Couldn't arm \`${eventHead}\` for @${inputs.SENDER}: GitHub refused the \`${MERGE_CONTEXT}\` status, so nothing was merged. Check that the loop's App has **Commit statuses: write**, accepted on this installation, or that \`AGENT_PAT\` can write commit statuses here.`,
          { cause: error },
        );
      }
      armedAt = { commit: eventHead, login: inputs.SENDER };
      console.log(`Armed ${eventHead} for @${inputs.SENDER}.`);
    }

    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const live = await io.github.pullRequest(pr);
      if (live.state !== "open" || live.draft) {
        console.log(`PR #${pr} is no longer open and ready while this gate waited, so it ends here with nothing merged.`);
        decide("wait", live.headSha);
        return;
      }
      const head = live.headSha;
      const statuses = await io.github.commitStatuses(head);
      const arm = armOn(statuses, inputs.LOOP_LOGIN);
      if (arm === undefined) {
        // A refresh is working on the pull request (#589): its own push starts
        // a gate before its carry of the arm may have landed, and its
        // conclusion re-starts the gate once it is done, which rules then.
        if (live.labels.includes(UPDATE_BRANCH_LABEL)) {
          console.log(`PR #${pr}'s head ${head} carries no arm yet, but ${UPDATE_BRANCH_LABEL} is on: that run hands back to this gate when it is done, so this one waits.`);
          decide("wait", head);
          return;
        }
        // Who armed what, for the comment: the arm this run saw, the one on
        // the head the event named, or the newest on the pull request's
        // earlier commits.
        const earlier =
          armedAt ??
          (head === eventHead ? undefined : armedOn(eventHead, await io.github.commitStatuses(eventHead), inputs.LOOP_LOGIN)) ??
          (await earlierArm(io.github, pr, head, inputs.LOOP_LOGIN));
        await disarm(pr, workflow, head, earlier, byLoop ? inputs.SENDER : undefined);
        await next();
        decide("disarmed", head);
        return;
      }
      armedAt = arm.login === undefined ? { commit: head } : { commit: head, login: arm.login };
      const state = await stateOf(io.github, { pr, live, statuses, base: inputs.BASE_REF, accounts });
      if (state.kind === "red") {
        // Only the first gate to say it moves the queue on: a second on the
        // same red head asks for nothing.
        if (await sayOnce(io.github, workflow, pr, accounts, mergeRedMark(head), mergeRedComment(head, state.reasons))) await next();
        decide("red", head);
        return;
      }
      if (state.kind === "behind") {
        if (arm.refreshes >= MAX_REFRESHES) {
          console.log(`PR #${pr} is behind ${inputs.BASE_REF} again after ${arm.refreshes} clean refreshes, so it is disarmed rather than refreshed again.`);
          await tolerated(`Could not post the disarm comment on PR #${pr}.`, () =>
            workflow.comment(pr, mergeRefreshCapComment(head, inputs.BASE_REF, arm.login, MAX_REFRESHES)),
          );
          await tolerated(undefined, () => workflow.removeLabel(pr, MERGE_LABEL));
          await next();
          decide("disarmed", head);
          return;
        }
        await sayOnce(io.github, workflow, pr, accounts, mergeBehindMark(head), mergeBehindComment(head, inputs.BASE_REF));
        await refresh(pr, loop, head, inputs.BASE_REF);
        decide("behind", head);
        return;
      }
      if (state.kind === "merge") {
        console.log(`PR #${pr} is armed at ${head}, current with ${inputs.BASE_REF} and green: it merges.`);
        decide("merge", head);
        return;
      }
      if (Date.now() >= deadline) {
        console.log(
          `::notice::PR #${pr} is still waiting after ${waitSeconds} seconds (${state.reasons.join(" ")}), so this gate ends with ${MERGE_LABEL} on and nothing merged. Remove ${MERGE_LABEL} and add it again to re-start it.`,
        );
        decide("wait", head);
        return;
      }
      console.log(`Waiting on PR #${pr}: ${state.reasons.join(" ")}`);
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  } finally {
    io.outputs.writeJson("gate.json", decided);
  }
};

/**
 * How many clean refreshes an arm survives (#589): behind again after the
 * third, the gate disarms rather than ask for a fourth, so a base that keeps
 * moving cannot hold a pull request in a refresh loop. A constant, not a
 * setting: a setting is a caller input, which lands in two releases, and this
 * bounds a pathology rather than expressing a preference.
 */
export const MAX_REFRESHES = 3;

/**
 * The refresh the up-to-date rule forces (#589): `agent:update-branch`, with
 * the loop's token, since a label added with the workflow token starts
 * nothing, removed first, as every trigger label the loop adds (#236). Never
 * while another trigger label is on: `stateOf` waits on that before it reads
 * the base. A failed add stops the run, which names the way on.
 */
const refresh = async (pr: number, loop: Writer, head: string, base: string): Promise<void> => {
  await tolerated(undefined, () => loop.removeLabel(pr, UPDATE_BRANCH_LABEL));
  try {
    await loop.addLabel(pr, UPDATE_BRANCH_LABEL);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(
      `\`${head}\` is behind \`${base}\`, and adding \`${UPDATE_BRANCH_LABEL}\` to refresh it failed, so it was neither refreshed nor merged. Add \`${UPDATE_BRANCH_LABEL}\` by hand, then \`${MERGE_LABEL}\` again.`,
      { cause: error },
    );
  }
  console.log(`PR #${pr} is behind ${base}: asked for ${UPDATE_BRANCH_LABEL}, with the arm kept.`);
};

/** How many of a pull request's commits before its head are read for the arm a disarm names. */
const EARLIER_COMMITS = 20;

/**
 * The newest arm on the pull request's commits before `head`, newest first
 * and at most `EARLIER_COMMITS` of them, for the human a disarm names: a push
 * of any kind leaves the commit it moved off in the history. A read that
 * fails names no one rather than stopping the disarm.
 */
const earlierArm = async (github: GitHubReader, pr: number, head: string, loopLogin: string): Promise<Armed | undefined> => {
  try {
    const commits = (await github.pullRequestCommits(pr)).filter((sha) => sha !== head).reverse().slice(0, EARLIER_COMMITS);
    for (const sha of commits) {
      const arm = armedOn(sha, await github.commitStatuses(sha), loopLogin);
      if (arm !== undefined) return arm;
    }
  } catch (error) {
    console.log(`::warning::Could not read PR #${pr}'s earlier commits for who armed it (${describe(error)}), so the disarm names no one.`);
  }
  return undefined;
};

/** The arm on `sha`, as the commit and who armed it. */
const armedOn = (sha: string, statuses: readonly CommitStatus[], loopLogin: string): Armed | undefined => {
  const arm = armOn(statuses, loopLogin);
  if (arm === undefined) return undefined;
  return arm.login === undefined ? { commit: sha } : { commit: sha, login: arm.login };
};

/** A commit the loop's account armed, and who armed it where its description names them. */
interface Armed {
  readonly commit: string;
  readonly login?: string;
}

/** The permissions that can merge, as GitHub's merge button reads them. */
const WRITERS: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/**
 * The refusal the event's own facts settle, before anything is read, in
 * order: closed, draft, fork, then a token that cannot arm.
 */
const refusalOf = (inputs: Inputs): string | undefined => {
  if (inputs.PR_STATE !== "open" || inputs.PR_MERGED === "true") return "This PR is closed.";
  if (inputs.PR_DRAFT === "true") return `This PR is a draft. Mark it ready for review, then add \`${MERGE_LABEL}\` again.`;
  if (inputs.HEAD_REPO !== inputs.GH_REPO) return "This PR is from a fork, and the loop merges only pull requests from this repository's own branches.";
  if (!canStart(inputs)) {
    return `Neither the loop's App nor \`AGENT_PAT\` is set, so nothing was armed or merged. An arm posted with \`GITHUB_TOKEN\` is one any workflow in this PR's branch could post too, and a merge made with it starts no workflow, so neither CI on the base nor the follow-ups would run. Set up the loop's App, or \`AGENT_PAT\`, and add \`${MERGE_LABEL}\` again.`;
  }
  return undefined;
};

/** Whether the loop's token is one whose label starts a run: the App's or `AGENT_PAT`, never the workflow token. */
const canStart = (inputs: Inputs): boolean => inputs.LOOP_TOKEN_SOURCE === "app" || inputs.LOOP_TOKEN_SOURCE === "pat";

/** Where an armed head stands, and why it is waiting or red. */
type State =
  | { readonly kind: "merge" }
  | { readonly kind: "behind" }
  | { readonly kind: "red"; readonly reasons: readonly string[] }
  | { readonly kind: "pending"; readonly reasons: readonly string[] };

/**
 * An armed head's state, in order: another trigger label on is a wait, since
 * that run moves or reads the head; then a failed required check or a verdict
 * that is not an approval, red; then the base, behind where its tip is not in
 * the head's history; then anything pending; and otherwise a merge.
 *
 * The checks and the verdict are read as `readHead` in `merge/queue.ts`
 * reads them, the one rule the queue's "not red" is read by too.
 */
const stateOf = async (
  github: GitHubReader,
  { pr, live, statuses, base, accounts }: { pr: number; live: PullRequest; statuses: readonly CommitStatus[]; base: string; accounts: LoopAccounts },
): Promise<State> => {
  const busy = live.labels.filter((label) => TRIGGERS.includes(label));
  if (busy.length > 0) return { kind: "pending", reasons: [`It carries ${busy.map((l) => `\`${l}\``).join(", ")}, whose run is not done.`] };

  const head = live.headSha;
  const { red, pending } = readHead(await github.commitChecks(head, pr), newestVerdict(statuses, accounts));
  if (red.length > 0) return { kind: "red", reasons: red };

  const currency = await github.behindBase(base, head);
  if (currency === "behind") return { kind: "behind" };

  const waiting = currency === "unknown" ? [...pending, `Whether it is current with \`${base}\` could not be told yet.`] : pending;
  return waiting.length > 0 ? { kind: "pending", reasons: waiting } : { kind: "merge" };
};

/**
 * A comment said once per head: posted only where no comment by the loop's
 * accounts already carries `mark`. A read that fails says it again rather
 * than staying quiet. Whether it was said this time, which a comment that
 * failed to post counts as: it was not said before.
 */
const sayOnce = async (github: GitHubReader, workflow: Writer, pr: number, accounts: LoopAccounts, mark: string, body: string): Promise<boolean> => {
  try {
    const said = (await github.authoredComments(pr)).some((c) => isWorkflowBot(c.author, accounts) && c.body.includes(mark));
    if (said) {
      console.log(`PR #${pr} was already told this about its head, so it is not said again.`);
      return false;
    }
  } catch (error) {
    console.log(`::warning::Could not read PR #${pr}'s comments (${describe(error)}), so this is said again rather than not at all.`);
  }
  await tolerated(`Could not post the comment on PR #${pr}.`, () => workflow.comment(pr, body));
  return true;
};

/**
 * A refusal, in the loop's one order (#236): the comment first, then
 * `agent:merge` off. Each write is tolerated: a comment that fails still takes
 * the label off.
 */
const refuse = async (pr: number, workflow: Writer, sentence: string): Promise<void> => {
  await tolerated(`Could not post the refusal comment on PR #${pr}.`, () => workflow.comment(pr, mergeRefusal(sentence)));
  await tolerated(undefined, () => workflow.removeLabel(pr, MERGE_LABEL));
};

/** A disarm, in the same order: the comment naming who armed what, then `agent:merge` off. */
const disarm = async (pr: number, workflow: Writer, head: string, armed: Armed | undefined, addedByLoop?: string): Promise<void> => {
  console.log(`PR #${pr}'s head ${head} is not an armed commit, so nothing merges.`);
  await tolerated(`Could not post the disarm comment on PR #${pr}.`, () => workflow.comment(pr, disarmComment(head, armed, addedByLoop)));
  await tolerated(undefined, () => workflow.removeLabel(pr, MERGE_LABEL));
};

/**
 * What the gate may write, and how many of each (ADR 0005): one comment (a
 * refusal, a disarm, a red head or a behind one; never two), one label off
 * (`agent:merge`, or `agent:update-branch` before it is added), the refresh
 * asked for, and the arm. A refusal, a disarm or a first red moves the queue
 * on as well (#590), with up to `NEXT_TRIES` of `agent:update-branch` removed
 * and added on other pull requests; a behind head, which asks for its own
 * refresh, does not.
 */
const LIMITS: Limits = { comment: 1, removeLabel: 1 + NEXT_TRIES, addLabel: NEXT_TRIES, setCommitStatus: 1 };

const commit = (value: string, name: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a full commit id.`);
  return value;
};
