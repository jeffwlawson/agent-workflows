import type { GitHubReader } from "../engine/read.js";
import { ReadBackFailed, WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import { describe, inWriteLog, pullRequestNumber } from "../shared/command-helpers.js";
import type { CommandIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { planChecklist, type ChecklistIssue } from "./checklist.js";
import { isStubFor, planFollowUps, type PlannedIssue } from "../shared/follow-up-plan.js";
import { loopAccounts, type LoopAccounts } from "../shared/loop-accounts.js";
import { FOLLOW_UP_STUB_LABEL, FOLLOW_UPS_LABEL, LINKED_ISSUE } from "../shared/record.js";
import { FOLLOW_UPS_LIST_LIMIT } from "../shared/review-output.js";

type Declared = (typeof COMMANDS)["follow-ups:file"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * File the out-of-scope findings a review recorded, once the pull request has
 * closed (#49).
 *
 * The first command (ADR 0004), `follow-ups:file`, which was the sixth runner,
 * the one that **runs no model**. There is no prompt beside this file and no
 * agent below it: the workflow that invokes it is the only one in the loop
 * holding `issues: write`, and reading arbitrary issue bodies with a model
 * while holding that is a prompt-injection surface nothing here has. What
 * would be the agent's judgement is a pure function instead: `planFollowUps`,
 * which every dedup and authenticity rule is unit-tested through.
 *
 * It has two jobs since #544. On every merge it posts the **post-merge
 * checklist**, the linked briefs' *After merge, by a human* items, planned by
 * `planChecklist` (`follow-ups/checklist.ts`). Then, only where the marker is
 * on, it **files**: three lines of work and an order, gather, plan, perform.
 * It decides exactly one thing itself, and only because a plan cannot be made
 * without it: whether the marker is still on the pull request, which gates
 * the filing and nothing else. The CLI reads
 * its inputs and hands them over, and turns anything it throws into `fail()`.
 *
 * It reads through the engine's reader and writes through its writer (#510),
 * with the workflow's token alone and within `LIMITS`, so every write it makes
 * is capped and in its write log, and a test drives it with the fakes. Issues
 * first, because the report names them and cannot be written until they have
 * numbers; the report; and the marker **last, and only on a plan that asked for
 * it**: it is left in place on every refusal and every failure, where it is both
 * the retry affordance and the signal that this pull request's findings are
 * unfiled. A retry is safe: every stub carries its finding's identity in its
 * marker, so the retry reports it as *already filed* and creates only what is
 * missing.
 *
 * The off switch is **the caller**. `follow-ups.yml` invokes this subcommand,
 * and nothing invokes a reusable except a caller's reference — so a repository
 * that copies the rest of the loop and not the `follow-ups` job in the PR-side
 * caller file (#225) never files anything, and turning it off later is deleting
 * that one job.
 * This said "no reusable references this one yet" while that was true (#49) and
 * stopped being true at #50, which is worse than an ordinary stale line: it
 * named an off switch nobody can use, where every other artifact here
 * (the PR-side caller file, `docs/ADOPTING.md` §4, `README.md`, `CONTEXT.md`)
 * names the caller.
 */

export const file = async (inputs: Inputs, io: Io): Promise<void> => {
  // Read before anything else, so a malformed list fails the run before it
  // reads the pull request.
  const accounts = loopAccounts(inputs.AGENT_LOOP_LOGINS);
  // Parsed rather than carried as text: it is the key the same-pull-request
  // case matches on, so a `NaN` would match nothing, quietly turning every
  // retry into a second copy of every stub.
  const pr = pullRequestNumber(inputs.PR_NUMBER);

  const pull = await io.github.pullRequest(pr);
  const { workflow } = io.writers(LIMITS);

  // On every merge, labelled or not (#544): the label is the opt-out of
  // filing, not of being reminded, and a brief can name a post-merge check on
  // a pull request whose review found nothing out of scope. So it comes first,
  // and the label below gates the filing alone.
  await postChecklist(io.github, workflow, pr, pull.body, accounts);

  // The only branch in the filing. The label is the opt-out, so it is re-read
  // here rather than taken from the event payload, which is assembled when the
  // event fires and does not reflect a label removed a second before the merge
  // button. A pull request that cannot be read throws rather than reading as
  // unmarked: that would drop its findings in silence, with the marker that
  // makes the retry possible still on.
  if (!pull.labels.includes(FOLLOW_UPS_LABEL)) {
    // No comment, no refusal, no label. A job condition cannot make an API
    // call, so this job starts on every merge and mostly ends here: most
    // merges have no findings, and a comment on each of those is how a
    // channel teaches people to stop reading it.
    console.log(`#${pr} does not carry \`${FOLLOW_UPS_LABEL}\`. Nothing to file.`);
    return;
  }

  const plan = planFollowUps(
    { prNumber: pr, reviews: await io.github.reviewHistory(pr), stubs: await io.github.labelledIssues(FOLLOW_UP_STUB_LABEL) },
    accounts,
  );
  const available = new Set(plan.issues.length === 0 ? [] : await io.github.repoLabels());

  const created: number[] = [];
  let report = plan.report;
  for (const issue of plan.issues) {
    const number = await createStub(workflow, issue, available);
    created.push(number);
    report = report?.replace(issue.placeholder, `#${number}`);
  }

  if (report !== undefined) {
    await stopping(`Couldn't post the report on #${pr}`, () => workflow.comment(pr, report));
  }
  if (plan.removeMarker) {
    await stopping(`Couldn't remove \`${FOLLOW_UPS_LABEL}\` from #${pr}`, () => workflow.removeLabel(pr, FOLLOW_UPS_LABEL));
  }

  console.log(`Filed ${created.length} issue(s)${created.length === 0 ? "" : `: ${created.map((n) => `#${n}`).join(", ")}`}.`);
  // Both are worth a line even when nothing was filed. A run that reported
  // without removing the marker is a refusal, and a run that removed it
  // without reporting decided there was nothing to say — and telling those
  // two apart in a log is the whole reason they are printed.
  console.log(`Reported on #${pr}: ${report !== undefined}.`);
  console.log(`Marker removed: ${plan.removeMarker}.`);
};

/**
 * What it may write, and how many of each, on the workflow's writer: stubs up
 * to the most a review's hand-over may carry, a guard against a runaway plan
 * rather than a quota; the post-merge checklist and the one report; and the
 * marker's removal. Every other
 * type is limited to none, and the loop's writer is never used: a stub made
 * with the workflow token starts no workflow, and a repository without
 * `AGENT_PAT` still files.
 */
const LIMITS: Limits = { createIssue: FOLLOW_UPS_LIST_LIMIT, comment: 2, removeLabel: 1 };

/**
 * The post-merge checklist (#544), gathered, planned by `planChecklist` and
 * posted. The linked issue is the first a closing keyword in the body names;
 * where it has sub-issues it is a PRD's parent, read first, then each
 * sub-issue in the list's order, open or closed: the list, not the `Closes`
 * block, which names only those open when it was last written.
 *
 * An issue that cannot be read fails the run rather than leaving its items out
 * of a checklist that would then look whole.
 */
const postChecklist = async (github: GitHubReader, workflow: Writer, pr: number, body: string, accounts: LoopAccounts): Promise<void> => {
  const linked = LINKED_ISSUE.exec(body)?.[1];
  if (linked === undefined) {
    console.log(`#${pr} links no issue, so there is no post-merge checklist.`);
    return;
  }
  const parent = Number(linked);
  const numbers = await reading(`#${parent}`, async () =>
    (await github.issueShape(parent)).subIssues > 0 ? [parent, ...(await github.subIssues(parent)).map((sub) => sub.number)] : [parent],
  );
  const issues: ChecklistIssue[] = [];
  for (const number of numbers) {
    issues.push(await reading(`#${number}`, async () => ({ number, body: await github.issueBody(number), comments: await github.authoredComments(number) })));
  }
  const existing = await reading(`the comments on #${pr}`, () => github.authoredComments(pr));

  const plan = planChecklist({ issues, existing }, accounts);
  if (plan.kind === "none") {
    console.log("No linked brief names a check for after the merge, so there is no post-merge checklist.");
    return;
  }
  if (plan.kind === "posted") {
    console.log(`#${pr} already carries the post-merge checklist, so it is not posted again.`);
    return;
  }
  try {
    await workflow.comment(pr, plan.body);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(`Couldn't post the post-merge checklist on #${pr}: ${describe(error.cause)}`, { cause: error });
  }
  console.log(`Posted the post-merge checklist on #${pr}.`);
};

/** `read`, or a sentence naming what could not be read for the checklist. */
const reading = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    throw new Error(`Couldn't read ${what} for the post-merge checklist: ${describe(error)}`, { cause: error });
  }
};

/**
 * One planned stub, filed with the labels of its own the repository has, and
 * its number. A server error is read back by the `pr-follow-up` issues and the
 * planner's own match, and a stub found there is carried on with, said as a
 * warning.
 */
const createStub = async (workflow: Writer, issue: PlannedIssue, available: ReadonlySet<string>): Promise<number> => {
  const labels = issue.labels.filter((label) => available.has(label));
  const missing = issue.labels.filter((label) => !available.has(label));
  const title = JSON.stringify(issue.title);

  let created;
  try {
    created = await workflow.createIssue({
      title: issue.title,
      body: issue.body,
      labels,
      readBack: { label: FOLLOW_UP_STUB_LABEL, matches: isStubFor(issue) },
    });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    if (error.cause instanceof ReadBackFailed) {
      throw new Error(
        `GitHub answered filing ${title} with a server error, and whether it was filed anyway could not be read back (${describe(error.cause.read)}). \`${FOLLOW_UPS_LABEL}\` is left on, so removing it and adding it back files whatever is missing, and nothing twice.`,
        { cause: error },
      );
    }
    throw new Error(`Couldn't file ${title}, so \`${FOLLOW_UPS_LABEL}\` is left on: ${describe(error.cause)}`, { cause: error });
  }
  if (created.readBack !== undefined) {
    console.log(
      `::warning::${inWriteLog(`GitHub answered filing ${title} with a server error (${created.readBack}), but #${created.number} is that stub, so this run goes on with it.`)}`,
    );
  }

  // Filed unlabelled rather than not filed. Both labels are newer than the
  // ones `docs/ADOPTING.md` §3 mandates, so an adopter can be current on the
  // pin and not have them — and a stub outside the triage flow is worth more
  // than a finding that was dropped for want of a label. Said out loud,
  // because an unlabelled stub is invisible to exactly the queue it was
  // filed for. On stdout, where the runner reads workflow commands from.
  if (missing.length > 0) {
    console.log(
      `::warning::Filed #${created.number} without ${missing.map((label) => `\`${label}\``).join(" and ")}, which this repository does not have. Create the label${missing.length === 1 ? "" : "s"} and add ${missing.length === 1 ? "it" : "them"} to the issue.`,
    );
  }
  return created.number;
};

/** `write`, or a sentence saying what failed and that `agent:follow-ups` is left on. */
const stopping = async (what: string, write: () => Promise<unknown>): Promise<void> => {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(`${what}, so \`${FOLLOW_UPS_LABEL}\` is left on: ${describe(error.cause)}`, { cause: error });
  }
};
