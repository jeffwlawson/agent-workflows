import { GitHubError } from "../engine/github.js";
import type { GitHubReader } from "../engine/read.js";
import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import { describe, issueNumber, tolerated } from "../shared/command-helpers.js";
import type { CommandIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { BLOCKED_LABEL, closingReference, IMPLEMENT_LABEL, issueBranch } from "../shared/record.js";

type Declared = (typeof COMMANDS)["implement:gate"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/** What `gate.json` holds: the decision, and once read, the branch, the base and the branch's tip. */
interface Decided {
  proceed?: "true" | "false";
  branch?: string;
  base?: string;
  tip?: string;
}

/**
 * `implement:gate` (#490): everything the gate job settles before the agent's
 * job, in the order it settles it, before anything is checked out, so a
 * refusal costs no checkout and no install. Whether this run goes ahead,
 * said on the issue where it does not; the permission probe; `agent:blocked`
 * off; the start comment; and the facts the later jobs build on: the branch's
 * name, the commit `BASE_REF` is at, and the branch's current tip.
 *
 * `gate.json` is its decision, `proceed`, which the adapter copies into the
 * job's `refused`, written as soon as it is decided and again however this
 * ends, as `fix:gate`'s is: a gate that died before deciding writes no file
 * where an input could not be read, and `{}`, with no `proceed`, where it
 * failed after that. The later jobs read either as the third value of
 * `refused`, empty. One that decided to go ahead and then failed, at the
 * probe or a read after it, still says so, and its job's failure is what
 * keeps the agent's job from starting.
 *
 * Every write is the workflow token's: nothing here has to start a run.
 */
export const gate = async (inputs: Inputs, io: Io): Promise<void> => {
  const issue = issueNumber(inputs.ISSUE_NUMBER);
  const decided: Decided = {};
  // Written the moment it is decided, and again however this ends: a cancel
  // reaches Node as a signal, which ends the process without running a
  // `finally`, so a decision written only there is lost to one landing in a
  // read, and a run already claimed would read as undecided.
  const record = (facts: Decided): void => {
    Object.assign(decided, facts);
    io.outputs.writeJson("gate.json", decided);
  };
  try {
    const { workflow } = io.writers(LIMITS);
    const outcome = await preflight(issue, inputs.ISSUE_STATE, io.github);
    if (outcome.kind === "defer") {
      // Not a refusal, and deliberately touching nothing: `implement-prd` owns
      // this shape and is running right now on the same event. A comment here
      // would sit beside its comment saying the opposite, and a label edit
      // would race the re-label its chain depends on.
      console.log(outcome.line);
      record({ proceed: "false" });
      return;
    }
    if (outcome.kind === "refuse") {
      await refuse(issue, workflow, outcome);
      record({ proceed: "false" });
      return;
    }
    record({ proceed: "true" });

    // **The permission probe**: the label write a short token feels first,
    // ahead of the agent pass it would otherwise spend. It adds the label
    // this run already holds, which changes nothing, and is not tolerated,
    // so a short token fails the run here, before the agent's job starts.
    try {
      await workflow.addLabel(issue, IMPLEMENT_LABEL);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      throw new Error(
        `Couldn't add \`${IMPLEMENT_LABEL}\` to #${issue}, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants \`issues: write\`.`,
        { cause: error },
      );
    }
    // The trigger label stays on while this run works and comes off in its
    // last step (#236), so the one label to take off here is a block an
    // earlier run left. Re-adding `agent:implement` is the retry, and this
    // clears it.
    await tolerated(undefined, () => workflow.removeLabel(issue, BLOCKED_LABEL));
    // The run links itself on the issue (#205), so a run in progress can be
    // found from the issue rather than by matching timestamps in Actions. A
    // warning where it cannot be posted, never a failure: nothing has been
    // done yet that a stopped run would need to report.
    await tolerated(`Could not post the start comment on #${issue}. The run goes on; it is ${inputs.RUN_URL}.`, () =>
      workflow.comment(issue, `**\`${IMPLEMENT_LABEL}\` started:** [Workflow run](${inputs.RUN_URL})`),
    );

    const branch = issueBranch(issue, inputs.ISSUE_TITLE);
    record({ branch });
    // The base the agent's branch has to build on, read here so `publish`
    // checks the bundle against a commit the agent's job did not report.
    record({ base: await read(`the commit \`${inputs.BASE_REF}\` is at`, () => io.github.branchTip(inputs.BASE_REF)) });
    record({ tip: await currentTip(branch, io.github) });
  } finally {
    io.outputs.writeJson("gate.json", decided);
  }
};

/** What the pre-flight came to: go ahead, defer to `implement-prd` silently, or refuse on the issue. */
type Preflight =
  | { readonly kind: "proceed" }
  | { readonly kind: "defer"; readonly line: string }
  | ({ readonly kind: "refuse" } & Refusal);

/** Why this run does not go ahead, and whether a human has to act on it. */
interface Refusal {
  readonly sentence: string;
  readonly blocked: boolean;
}

/**
 * **The pre-flight**: one deferral and five refusals, in order.
 *
 * The **partition** comes first.
 * `implement-prd` shares this trigger label and owns every issue that has
 * sub-issues, so both start on every label event and exactly one of them may
 * speak. This settles which before it says anything at all, including about
 * a closed issue, which would otherwise collect the same "not open" comment
 * twice, seconds apart, from two runs that cannot see each other. The
 * sub-issue count is read first, so a *nested* PRD, with sub-issues and a
 * parent, goes to `implement-prd`, the one path that can explain what is
 * wrong with it.
 *
 * Then state. The open-PR read lists open PRs only, so an issue whose PR has
 * already merged looks exactly like one nobody has started.
 *
 * Then the rest of the shape, ahead of the open-PR read: an issue that must
 * never be implemented should not be handed "close that PR, then add the
 * label again", a remedy that leads straight back to a refusal. `wayfinder:*` ahead of the hierarchy, since a
 * planning ticket is refused whatever shape it has.
 *
 * **A failed shape query fails the run**, deliberately, where every other
 * read here proceeds on a blip: "no answer" read as "standalone" is exactly
 * the isolated sub-issue run the partition exists to prevent. A failed
 * blocker read is no blockers, as it always was.
 *
 * A shape refusal is blocked (#253): it repeats verbatim until somebody
 * restructures the work. A closed issue and an existing PR are transient. A
 * blocker is transient too, and blocked all the same, on purpose:
 * `agent:blocked` is the one way to find work that is waiting, and a plain
 * refusal would leave the issue carrying nothing at all.
 */
const preflight = async (issue: number, state: string, github: GitHubReader): Promise<Preflight> => {
  const shape = await github.issueShape(issue);
  if (shape.subIssues > 0) {
    return { kind: "defer", line: `#${issue} has ${shape.subIssues} sub-issue(s), so agent-implement-prd owns this label event.` };
  }
  if (state !== "open") {
    return { kind: "refuse", sentence: `This issue is closed. Reopen it, then add \`${IMPLEMENT_LABEL}\` again.`, blocked: false };
  }
  if (shape.labels.some((label) => label.startsWith("wayfinder:"))) {
    return {
      kind: "refuse",
      sentence: `This is a planning issue (\`wayfinder:*\`), not buildable work. Add \`${IMPLEMENT_LABEL}\` to the issues it produces instead.`,
      blocked: true,
    };
  }
  if (shape.parent !== undefined) {
    const parent = shape.parent;
    return {
      kind: "refuse",
      sentence: `This is a sub-issue of #${parent}. Add \`${IMPLEMENT_LABEL}\` to #${parent} instead; it builds its sub-issues in order.`,
      blocked: true,
    };
  }

  // Blocked-by is *sequencing*, not containment, which is why this is a
  // refusal rather than a chain: a blocker is a separate deliverable with its
  // own PR and its own reviewer, and building it because somebody labelled
  // the thing downstream would authorise work nobody asked for.
  let blockers: readonly number[] = [];
  try {
    blockers = await github.openBlockers(issue);
  } catch (error) {
    console.log(`::warning::Could not read what blocks #${issue}; going ahead as though nothing does. ${describe(error)}`);
  }
  if (blockers.length > 0) {
    const named = blockers.map((blocker) => `#${blocker}`).join(", ");
    return {
      kind: "refuse",
      sentence:
        blockers.length > 1
          ? `It's blocked by ${named}, which are still open. Add \`${IMPLEMENT_LABEL}\` again once they are closed, or remove the "blocked by" links that no longer apply.`
          : `It's blocked by ${named}, which is still open. Add \`${IMPLEMENT_LABEL}\` again once ${named} is closed, or remove the "blocked by" link if it no longer applies.`,
      blocked: true,
    };
  }

  const [existing] = await github.openPullRequestsClosing(closingReference(issue));
  if (existing !== undefined) {
    return {
      kind: "refuse",
      sentence: `PR #${existing} already exists for this issue. Keep working on that PR, or close it and add \`${IMPLEMENT_LABEL}\` again.`,
      blocked: false,
    };
  }
  return { kind: "proceed" };
};

/**
 * A refusal, in the loop's one order (#236): the comment first, then this
 * run's own label off, then `agent:blocked`, so the label that names the next
 * step goes on last. One pattern for every refusal (#253): the label that did
 * not run, then a sentence saying why and what to do. Each write is tolerated:
 * a comment that fails still takes the label off, rather than leaving it on
 * with nothing behind it.
 */
const refuse = async (issue: number, workflow: Writer, refusal: Refusal): Promise<void> => {
  await tolerated(`Could not post the refusal comment on #${issue}.`, () =>
    workflow.comment(issue, `**\`${IMPLEMENT_LABEL}\` didn't run:** ${refusal.sentence}`),
  );
  await tolerated(undefined, () => workflow.removeLabel(issue, IMPLEMENT_LABEL));
  if (refusal.blocked) await tolerated(undefined, () => workflow.addLabel(issue, BLOCKED_LABEL));
};

/**
 * The branch's current tip, or `""` where it does not exist: what publish's
 * push leases on, so a retry replaces what an earlier failed run left and a
 * push someone else made during the run is refused. Absent and unreadable are
 * different facts: a 404 is a branch nobody has pushed, and anything else
 * fails the run, since a lease taken on a guess is no lease.
 */
const currentTip = async (branch: string, github: GitHubReader): Promise<string> => {
  try {
    return await github.branchTip(branch);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return "";
    throw new Error(`Couldn't read whether \`${branch}\` already exists, so nothing was started. ${describe(error)}`, { cause: error });
  }
};

/** `fetch`, or a sentence naming `what` could not be read. */
const read = async (what: string, fetch: () => Promise<string>): Promise<string> => {
  try {
    return await fetch();
  } catch (error) {
    throw new Error(`Couldn't read ${what}, so nothing was started. ${describe(error)}`, { cause: error });
  }
};

/**
 * What the gate may write, and how many of each (ADR 0005). A refusal is one
 * comment, `agent:implement` off and, on a shape, `agent:blocked` on; a run
 * that goes ahead is the probe's `agent:implement`, `agent:blocked` off and
 * the start comment. Never both.
 */
const LIMITS: Limits = { comment: 2, removeLabel: 2, addLabel: 2 };

