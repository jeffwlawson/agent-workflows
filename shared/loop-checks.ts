/**
 * **The loop's own checks** (#588): which check runs, statuses and workflow
 * runs on a commit are the loop's, not CI. Two workflows ask: the review's CI
 * wait (`review:collect-checks`), which must not wait on, or count, a sibling
 * agent job or its own verdict, and `merge:gate`, which waits for CI on an
 * armed head and must not wait on its own job or read the loop's statuses as
 * CI. One copy, here, so the two cannot disagree about what CI is.
 *
 * Imports nothing but `shared/record.ts`, so a command can load it.
 */
import { MERGE_CONTEXT, VERDICT_CONTEXT } from "./record.js";

/**
 * The loop's own jobs, which are not CI. A called workflow's job appears as
 * `<caller job id> / <called job id>`, so `agent-fix.yml` produces `fix / fix`.
 * The pattern matches a name whose *either* half is an agent job, because the
 * two halves are owned by different people: the second is a job id in one of
 * the reusable files and cannot change under an adopter, the first is whatever
 * they called their caller job. `^(…)$` alone stopped matching every sibling
 * the moment the loop was split, which put a queued `fix` back in the wait:
 * review would burn the full ceiling on a job that cannot start until review
 * ends, then review on degraded evidence after all.
 *
 * Still bounded at both ends, which is the point of anchoring at all:
 * `fixtures`, `CI / fix-lint` and `build / fixtures` are repo checks, not
 * agents, and none of them match.
 *
 * - `follow-ups` is **not** named (#224): that workflow fires only on a closed
 *   pull request (#50), and this wait runs on an open one, so its check run
 *   can never be here to exclude.
 * - `post-review` (#257) and `advance` (PRD #222) run after the review job, so
 *   a review never waits on its own, but a later round on the same head would
 *   read them as CI, as it would under a renamed caller job. `post-review`
 *   rather than `post`, so a repository's own CI job called `post` is still CI.
 *   `( / |$)` keeps `advance` from matching a name that goes on past it.
 * - `time-limit` (#220) has finished by the time this reads anything, and a
 *   job that sums two numbers is not CI.
 * - `red-check` (#231) is **never** CI: it runs the PR's tests against the
 *   merge-base, where a fix's new test is meant to fail, so its check run
 *   reading red is the check working. Counted here, it would turn the result
 *   red on every PR it found a red test on. Its report reaches the review
 *   instead.
 * - `merge` (#588) is the merge gate's own job, which polls while it runs: a
 *   gate waiting on itself would wait out its whole bound, and a review that
 *   waited on a gate waiting for that review's verdict would deadlock both.
 */
export const AGENT_CHECKS = /(^|\/ )(review|time-limit|red-check|post-review|advance|fix|update-branch|implement-prd|implement|merge)( \/ |$)/;

/** A caller of one of the loop's reusable workflows, by the path it calls. */
export const LOOP_WORKFLOW = /^[^/]+\/agent-workflows\/\.github\/workflows\//;

/**
 * The status contexts the loop posts, which are its answers rather than CI:
 * the verdict, `agent-review`, and the arm, `agent-merge`. Counted as CI, a
 * `failure` verdict on the previous round would be evidence for the next one,
 * and every "changes recommended" would derive "needs a closer look" one round
 * later, by reading its own answer back.
 */
export const isLoopStatus = (context: string): boolean => context === VERDICT_CONTEXT || context === MERGE_CONTEXT;

/**
 * Whether a workflow run is the loop's own, three ways, each for a case the
 * others miss: an `Agent …` workflow by its name, and a renamed caller by
 * what it calls, which is how `init` and `doctor` recognise one too. A run's
 * own id is the caller's to compare.
 */
export const isLoopRun = (run: { readonly name: string; readonly referencedWorkflows: readonly string[] }): boolean =>
  run.name.startsWith("Agent ") || run.referencedWorkflows.some((called) => LOOP_WORKFLOW.test(called));
