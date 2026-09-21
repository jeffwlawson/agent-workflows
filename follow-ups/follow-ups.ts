import { fail, required } from "../shared/common.js";
import {
  executeFilingPlan,
  fetchFilingInput,
  hasFollowUpsMarker,
} from "../shared/follow-up-filing.js";
import { planFollowUps } from "../shared/follow-up-plan.js";
import { FOLLOW_UPS_LABEL } from "../shared/review-output.js";

/**
 * File the out-of-scope findings a review recorded, once the pull request has
 * closed (#49).
 *
 * The sixth runner, and the one that **runs no model**. There is no prompt
 * beside this file and no agent below it: the workflow that invokes it is the
 * only one in the loop holding `issues: write`, and reading arbitrary issue
 * bodies with a model while holding that is a prompt-injection surface nothing
 * here has. What would be the agent's judgement is a pure function instead —
 * `planFollowUps`, which every dedup and authenticity rule is unit-tested
 * through.
 *
 * So this file is three lines of work and an order: gather, plan, perform. It
 * decides exactly one thing itself, and only because a plan cannot be made
 * without it — whether the marker is still on the pull request.
 *
 * The off switch is **the caller file**. `follow-ups.yml` invokes this
 * subcommand, and nothing invokes a reusable except a caller's reference — so a
 * repository that copies the rest of the loop and not `agent-follow-ups.yml`
 * never files anything, and turning it off later is deleting that one file.
 * This said "no reusable references this one yet" while that was true (#49) and
 * stopped being true at #50, which is worse than an ordinary stale line: it
 * named an off switch nobody can use, where every other artifact here
 * (`agent-follow-ups.yml`, `docs/ADOPTING.md` §4, `README.md`, `CONTEXT.md`)
 * names the caller.
 */

const PR_NUMBER = required("PR_NUMBER");

try {
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
  } else {
    const plan = planFollowUps(fetchFilingInput(PR_NUMBER));
    const outcome = executeFilingPlan(PR_NUMBER, plan);

    console.log(
      `Filed ${outcome.created.length} issue(s)${outcome.created.length === 0 ? "" : `: ${outcome.created.map((n) => `#${n}`).join(", ")}`}.`,
    );
    // Both are worth a line even when nothing was filed. A run that reported
    // without removing the marker is a refusal, and a run that removed it
    // without reporting decided there was nothing to say — and telling those
    // two apart in a log is the whole reason they are printed.
    console.log(`Reported on #${PR_NUMBER}: ${outcome.reported}.`);
    console.log(`Marker removed: ${outcome.markerRemoved}.`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
