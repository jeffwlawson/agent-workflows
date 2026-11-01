import type { CommitCheck, CommitStatus, GitHubReader, PullRequest } from "../engine/read.js";
import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import { describe, pullRequestNumber, seconds, tolerated } from "../shared/command-helpers.js";
import type { LoopReadingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { AGENT_CHECKS, isLoopStatus } from "../shared/loop-checks.js";
import { isWorkflowBot, loopAccounts, type LoopAccounts } from "../shared/loop-accounts.js";
import {
  ARMED_BY,
  armDescription,
  DEFAULT_LOOP_ACCOUNT,
  disarmComment,
  FIX_LABEL,
  MERGE_CONTEXT,
  MERGE_LABEL,
  mergeBehindComment,
  mergeBehindMark,
  mergeRedComment,
  mergeRedMark,
  mergeRefusal,
  REVIEW_LABEL,
  UPDATE_BRANCH_LABEL,
} from "../shared/record.js";
import { newestVerdict } from "../shared/verdict-status.js";

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
 *   naming them. Where the live head is already another commit, it disarms
 *   instead: a label added just after a push can carry the commit before it
 *   (#229). A label the loop's own account added never arms.
 * - **The state of the head**, polled up to `CHECK_WAIT_SECONDS` while
 *   anything is pending: `disarmed` where the head carries no arm of the loop
 *   token's account (never `github-actions[bot]`'s, which any workflow in the
 *   pull request's branch can post as); `wait` while another trigger label is
 *   on, a check or the verdict is pending, or the bound runs out; `red` where
 *   a required check failed or the verdict is not an approval, said once per
 *   head, the arm left on; `behind` where the base's tip is not in the head's
 *   history, said once per head, the arm left on; and `merge` otherwise.
 *
 * `gate.json` is the decision and the head it checked, written as soon as it
 * is decided and again however this ends, as `fix:gate`'s is: a cancel
 * reaches Node as a signal, which runs no `finally`.
 *
 * The arm is the loop token's, since only that account cannot be posted as
 * from a pull request's branch. The labeller's permission is read with it too
 * (#77). Every other write is the workflow token's: nothing here has to start
 * a run.
 */
export const gate = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const labelled = commit(inputs.HEAD_SHA, "HEAD_SHA");
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
    const refusal = refusalOf(inputs);
    if (refusal !== undefined) {
      await refuse(pr, workflow, refusal);
      decide("refused");
      return;
    }

    const byLoop = sameAccount(inputs.SENDER, inputs.LOOP_LOGIN);
    if (!byLoop) {
      const permission = await io.loopGithub.permission(inputs.SENDER);
      if (!WRITERS.has(permission)) {
        await refuse(
          pr,
          workflow,
          permission === "unknown"
            ? `@${inputs.SENDER} added it, and whether they can write to this repository could not be established, so it was not taken as a merge decision. Someone who can write has to add it.`
            : `@${inputs.SENDER} added it, and can only ${permission === "none" ? "read" : permission} here, so it was not taken as a merge decision: it is worth exactly what the merge button is. Someone who can write has to add it.`,
        );
        decide("refused");
        return;
      }
    }

    // The arm, on a writer's label only, and only on the head it was added
    // at: a live head that moved since is not the commit they decided on.
    let armedAt: Arm | undefined;
    if (!byLoop) {
      const live = await io.github.pullRequest(pr);
      if (live.headSha !== labelled) {
        await disarm(pr, workflow, live.headSha, { commit: labelled, login: inputs.SENDER });
        decide("disarmed", live.headSha);
        return;
      }
      try {
        await loop.setCommitStatus({ sha: labelled, context: MERGE_CONTEXT, state: "success", description: armDescription(inputs.SENDER) });
      } catch (error) {
        if (!(error instanceof WriteFailed)) throw error;
        throw new Error(
          `Couldn't arm \`${labelled}\` for @${inputs.SENDER}: GitHub refused the \`${MERGE_CONTEXT}\` status, so nothing was merged. Check that the loop's App has **Commit statuses: write**, accepted on this installation, or that \`AGENT_PAT\` can write commit statuses here.`,
          { cause: error },
        );
      }
      armedAt = { commit: labelled, login: inputs.SENDER };
      console.log(`Armed ${labelled} for @${inputs.SENDER}.`);
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
      const arm = armOf(statuses, inputs.LOOP_LOGIN, head);
      if (arm === undefined) {
        // Who armed what, for the comment: the arm this run saw, or the one
        // on the head the label was added at.
        const earlier = armedAt ?? (head === labelled ? undefined : armOf(await io.github.commitStatuses(labelled), inputs.LOOP_LOGIN, labelled));
        await disarm(pr, workflow, head, earlier, byLoop ? inputs.SENDER : undefined);
        decide("disarmed", head);
        return;
      }
      armedAt = arm;
      const state = await stateOf(io.github, { pr, live, statuses, base: inputs.BASE_REF, accounts });
      if (state.kind === "red") {
        await sayOnce(io.github, workflow, pr, accounts, mergeRedMark(head), mergeRedComment(head, state.reasons));
        decide("red", head);
        return;
      }
      if (state.kind === "behind") {
        await sayOnce(io.github, workflow, pr, accounts, mergeBehindMark(head), mergeBehindComment(head, inputs.BASE_REF));
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

/** A commit the loop's account armed, and who armed it where its description names them. */
interface Arm {
  readonly commit: string;
  readonly login?: string;
}

/** The permissions that can merge, as GitHub's merge button reads them. */
const WRITERS: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/** The trigger labels whose runs move or read the head: while one is on, nothing merges. */
const TRIGGERS = [REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL];

/**
 * The refusal the event's own facts settle, before anything is read, in
 * order: closed, draft, fork, then a token that cannot arm.
 */
const refusalOf = (inputs: Inputs): string | undefined => {
  if (inputs.PR_STATE !== "open" || inputs.PR_MERGED === "true") return "This PR is closed.";
  if (inputs.PR_DRAFT === "true") return `This PR is a draft. Mark it ready for review, then add \`${MERGE_LABEL}\` again.`;
  if (inputs.HEAD_REPO !== inputs.GH_REPO) return "This PR is from a fork, and the loop merges only pull requests from this repository's own branches.";
  if (inputs.LOOP_TOKEN_SOURCE !== "app" && inputs.LOOP_TOKEN_SOURCE !== "pat") {
    return `Neither the loop's App nor \`AGENT_PAT\` is set, so nothing was armed or merged. An arm posted with \`GITHUB_TOKEN\` is one any workflow in this PR's branch could post too, and a merge made with it starts no workflow, so neither CI on the base nor the follow-ups would run. Set up the loop's App, or \`AGENT_PAT\`, and add \`${MERGE_LABEL}\` again.`;
  }
  return undefined;
};

/** Two REST logins naming one account: compared without regard to case, as GitHub compares them. */
const sameAccount = (a: string, b: string): boolean => a !== "" && a.toLowerCase() === b.toLowerCase();

/**
 * The arm standing on a commit: the newest `agent-merge` status the loop
 * token's account posted, where it is `success`. Anyone else's, and
 * `github-actions[bot]`'s above all, is no arm, whatever it says.
 */
const armOf = (statuses: readonly CommitStatus[], loopLogin: string, sha: string): Arm | undefined => {
  if (sameAccount(loopLogin, DEFAULT_LOOP_ACCOUNT)) return undefined;
  const status = statuses.find((s) => s.context === MERGE_CONTEXT && sameAccount(s.creator, loopLogin));
  if (status === undefined || status.state !== "success") return undefined;
  const login = ARMED_BY.exec(status.description)?.[1];
  return login === undefined ? { commit: sha } : { commit: sha, login };
};

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
 * The checks are the ones the base requires, by GitHub's own `isRequired`,
 * rulesets and branch protection alike. Where it requires none, every check on
 * the head but the loop's own (`shared/loop-checks.ts`) has to pass instead.
 */
const stateOf = async (
  github: GitHubReader,
  { pr, live, statuses, base, accounts }: { pr: number; live: PullRequest; statuses: readonly CommitStatus[]; base: string; accounts: LoopAccounts },
): Promise<State> => {
  const busy = live.labels.filter((label) => TRIGGERS.includes(label));
  if (busy.length > 0) return { kind: "pending", reasons: [`It carries ${busy.map((l) => `\`${l}\``).join(", ")}, whose run is not done.`] };

  const head = live.headSha;
  const checks = await github.commitChecks(head, pr);
  const required = checks.filter((check) => check.required);
  const counted = required.length > 0 ? required : checks.filter((check) => !isLoops(check));
  const failed = counted.filter((check) => outcomeOf(check) === "failed").map(nameOf);
  const pending = counted.filter((check) => outcomeOf(check) === "pending").map(nameOf);
  const verdict = newestVerdict(statuses, accounts);

  const red: string[] = [];
  if (failed.length > 0) red.push(`${required.length > 0 ? "A required check failed" : "A check failed"}: ${failed.join(", ")}.`);
  if (verdict !== undefined && verdict.state !== "success" && verdict.state !== "pending") {
    red.push(`The newest review verdict on it is \`${verdict.state}\`, not an approval.`);
  }
  if (red.length > 0) return { kind: "red", reasons: red };

  const currency = await github.behindBase(base, head);
  if (currency === "behind") return { kind: "behind" };

  const waiting: string[] = [];
  if (pending.length > 0) waiting.push(`${required.length > 0 ? "A required check is" : "A check is"} still running: ${pending.join(", ")}.`);
  if (verdict === undefined || verdict.state === "pending") waiting.push("No review has approved it yet.");
  if (currency === "unknown") waiting.push(`Whether it is current with \`${base}\` could not be told yet.`);
  return waiting.length > 0 ? { kind: "pending", reasons: waiting } : { kind: "merge" };
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
 * A comment said once per head: posted only where no comment by the loop's
 * accounts already carries `mark`. A read that fails says it again rather
 * than staying quiet.
 */
const sayOnce = async (github: GitHubReader, workflow: Writer, pr: number, accounts: LoopAccounts, mark: string, body: string): Promise<void> => {
  try {
    const said = (await github.authoredComments(pr)).some((c) => isWorkflowBot(c.author, accounts) && c.body.includes(mark));
    if (said) {
      console.log(`PR #${pr} was already told this about its head, so it is not said again.`);
      return;
    }
  } catch (error) {
    console.log(`::warning::Could not read PR #${pr}'s comments (${describe(error)}), so this is said again rather than not at all.`);
  }
  await tolerated(`Could not post the comment on PR #${pr}.`, () => workflow.comment(pr, body));
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
const disarm = async (pr: number, workflow: Writer, head: string, armed: Arm | undefined, addedByLoop?: string): Promise<void> => {
  console.log(`PR #${pr}'s head ${head} is not an armed commit, so nothing merges.`);
  await tolerated(`Could not post the disarm comment on PR #${pr}.`, () => workflow.comment(pr, disarmComment(head, armed, addedByLoop)));
  await tolerated(undefined, () => workflow.removeLabel(pr, MERGE_LABEL));
};

/**
 * What the gate may write, and how many of each (ADR 0005): one comment (a
 * refusal, a disarm, a red head or a behind one; never two), `agent:merge`
 * off, and the arm.
 */
const LIMITS: Limits = { comment: 1, removeLabel: 1, setCommitStatus: 1 };

const commit = (value: string, name: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a full commit id.`);
  return value;
};
