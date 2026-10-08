import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import {
  executeFilingPlan,
  fetchFilingInput,
  hasFollowUpsMarker,
} from "../shared/follow-up-filing.js";
import { planFollowUps } from "../shared/follow-up-plan.js";
import { FOLLOW_UPS_LABEL } from "../shared/record.js";

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
 * So this function is three lines of work and an order: gather, plan, perform.
 * It decides exactly one thing itself, and only because a plan cannot be made
 * without it: whether the marker is still on the pull request. The CLI reads
 * its inputs and hands them over, and turns anything it throws into `fail()`.
 *
 * It writes with its `GH_TOKEN` directly, outside the engine's writer, until
 * its own workflow moves (ADR 0005).
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

export const file = (inputs: InputValues<(typeof COMMANDS)["follow-ups:file"]["inputs"]>): void => {
  const PR_NUMBER = inputs.PR_NUMBER;

  // One unconditional call, and the only branch in this file. The label is the
  // opt-out, so it is re-read here rather than taken from the event payload —
  // which is assembled when the event fires and does not reflect a label
  // removed a second before the merge button.
  if (!hasFollowUpsMarker(PR_NUMBER)) {
    // A silent exit 0: no comment, no refusal, no label. A job condition cannot
    // make an API call, so this job starts on every merge and mostly ends
    // here — most merges have no findings, and a comment on each of those is
    // how a channel teaches people to stop reading it.
    console.log(`#${PR_NUMBER} does not carry \`${FOLLOW_UPS_LABEL}\`. Nothing to file.`);
    return;
  }

  const plan = planFollowUps(fetchFilingInput(inputs.GH_REPO, PR_NUMBER));
  const outcome = executeFilingPlan(inputs.GH_REPO, PR_NUMBER, plan);

  console.log(
    `Filed ${outcome.created.length} issue(s)${outcome.created.length === 0 ? "" : `: ${outcome.created.map((n) => `#${n}`).join(", ")}`}.`,
  );
  // Both are worth a line even when nothing was filed. A run that reported
  // without removing the marker is a refusal, and a run that removed it
  // without reporting decided there was nothing to say — and telling those
  // two apart in a log is the whole reason they are printed.
  console.log(`Reported on #${PR_NUMBER}: ${outcome.reported}.`);
  console.log(`Marker removed: ${outcome.markerRemoved}.`);
};
