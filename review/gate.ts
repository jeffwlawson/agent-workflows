import type { GitHubReader } from "../engine/read.js";
import type { ReadingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { isWorkflowBot, loopAccounts, type LoopAccounts } from "../shared/loop-accounts.js";
import { FINAL_REVIEW_MARK, FIX_ROUND_STATUS, PRD_BRANCH_PREFIX, REVIEW_LABEL, VERDICT_CONTEXT } from "../shared/record.js";
import { LEGACY_FIX_ROUND_STARTED } from "../shared/review-output.js";

type Inputs = InputValues<(typeof COMMANDS)["review:gate"]["inputs"]>;
type Io = ReadingIo<(typeof COMMANDS)["review:gate"]["outputs"]>;

/**
 * What `gate.json` holds: the review job's decisions, under the names its
 * outputs have always had, every value a string, so the adapter copies them
 * across as they are. A name is absent where it was not decided: `sha` on a
 * refusal, the budget's three past a refused time limit, `round` off a PRD PR.
 *
 * - `proceed`, `refusal` and `blocked`: whether the review runs, and if not,
 *   the sentence the posting job says and whether `agent:blocked` follows it.
 * - `sha`: the commit this run reviews.
 * - `budget`, `spent` and `start`: the fix-round budget, the rounds spent
 *   (empty where they could not be counted), and whether a review that
 *   recommends changes starts a round.
 * - `round`: on a PRD PR, `slice` or `final`.
 */
type Decision = "proceed" | "refusal" | "blocked" | "sha" | "budget" | "spent" | "start" | "round";

/**
 * `review:gate` (#420): everything the review job settles between its start
 * and its checkout, in the order it settles them. Whether this run reviews,
 * and which commit; a time limit that is not a positive integer; the
 * fix-round budget; and, on a PRD PR, a slice round or the final review.
 *
 * It writes nothing to the record. The review job holds no write (#257), so a
 * refusal is decided here and said by the posting job, as it always was.
 *
 * Two kinds of no. **The pre-flight's**, a pull request that is closed or has
 * moved, is a decision, `proceed` false, and the command succeeds. **A
 * variable's**, the time limit or the budget, is refused the way a failed run
 * is: `refusal_reason.txt`, then a throw, so the job fails and the posting job
 * says this run didn't run, naming the variable (#253). The pre-flight has
 * settled the commit by then, so the error verdict has one to go on.
 *
 * `gate.json` is written however this ends, with what was decided by then, so
 * a failure after the pre-flight still hands the posting job a commit.
 */
export const gate = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const decided: Partial<Record<Decision, string>> = {};
  try {
    // The loop's accounts, read first, so a malformed list fails the run
    // before it decides anything (#376).
    const accounts = loopAccounts(inputs.AGENT_LOOP_LOGINS);
    const settled = await settleCommit(inputs, io.github, pr);
    if (settled.refusal !== undefined) {
      Object.assign(decided, { proceed: "false", refusal: settled.refusal, blocked: String(settled.blocked) });
      return;
    }
    Object.assign(decided, { proceed: "true", sha: settled.sha });

    refuseTimeLimit(inputs, io);
    Object.assign(decided, await settleBudget(inputs, io, pr, accounts));
    const round = await settleRound(inputs, io.github, pr);
    if (round !== undefined) decided.round = round;
  } finally {
    io.outputs.writeJson("gate.json", decided);
  }
};

/**
 * One explanation for every way the pull request can have moved since the
 * label (#253): the reader's remedy is the same for all of them. The commits
 * are named in the log rather than in the comment.
 */
const CHANGED = `The PR changed after \`${REVIEW_LABEL}\` was added. Add \`${REVIEW_LABEL}\` again to review the latest version.`;

type Settled = { readonly sha: string; readonly refusal?: undefined } | { readonly refusal: string; readonly blocked: boolean };

/**
 * **The pre-flight.** Same guard as `fix` and `update-branch`. Review had none
 * until an adopter's pilot found it, so labelling a merged PR ran a
 * full agent pass over merged work and then died at `gh pr ready`, which
 * cannot convert a merged PR, under a warning that blames a missing
 * `AGENT_PAT`. That is a real failure mode misreported as a setup problem,
 * which is worse than either.
 *
 * A refusal on a moved branch also adds `agent:blocked`: it is a run a human
 * asked for and did not get, and the comment alone scrolls away. A closed PR
 * does not (#253): there is nothing left for anyone to act on, so it gets the
 * note alone, as in `fix` and `update-branch`.
 *
 * The rest is settling **which commit this run reviews**, and everything after
 * this reads that one answer, `sha`: the checkout, the CI wait's check and
 * status reads, and, handed over as the review job's `sha`, every status the
 * posting job posts. The payload's `HEAD_SHA` is not read again past here.
 *
 * The payload is not enough on its own, for two reasons. It is snapshotted at
 * label time, and joining `agent-pr-*` means the run can start long after:
 * label `agent:review` while a fix is running and the review starts once the
 * fix has pushed. And GitHub moves a pull request's head **asynchronously**
 * after a push (#229), so a label added the moment a fix, a conflict
 * resolution or an implement run has pushed can carry the commit *before* the
 * push in its payload, and the pull request's head can agree with it for a
 * while. That is what #228 saw: the fix pushed `cb00b28`, the review checked
 * out `34c3fe5`, and its verdict went on `34c3fe5`, where branch protection
 * never looks.
 *
 * So the branch tip is read from the repository's **refs**, which move as soon
 * as the push lands, where the shell before this read them with `git
 * ls-remote`, as `fix`'s guard does (#188). Then:
 *
 *  - the tip is the payload's commit: review it;
 *  - the tip **descends** from it: the branch moved forward since the label,
 *    which is the push-then-label sequence above. Wait, bounded, for the pull
 *    request's head to catch up, then review the tip. The wait is what makes
 *    the posted review land on the pull request's head: GitHub anchors
 *    `commitOID` against it, and a review posted ahead of it is one the pull
 *    request does not yet know the commit for;
 *  - the tip does not descend from it (a rewritten branch), the ancestry
 *    cannot be read, or the head never catches up: refuse, naming both
 *    commits. None of those is a commit anybody pointed at.
 *
 * An unreadable tip proceeds on the payload's commit, with a warning: an API
 * blip is not evidence the branch moved, and this run only reads. `fix`
 * refuses there instead, because replying twice is its harm.
 */
const settleCommit = async (inputs: Inputs, github: GitHubReader, pr: number): Promise<Settled> => {
  if (inputs.PR_STATE !== "open" || inputs.PR_MERGED === "true") return { refusal: "This PR is closed.", blocked: false };

  const labelled = inputs.HEAD_SHA;
  const branch = inputs.BRANCH;
  let tip: string;
  try {
    tip = await github.branchTip(branch);
  } catch {
    console.log(
      `::warning::Could not read the tip of ${branch}, so this reviews ${labelled}, the commit the label was added at, without confirming it is still the head.`,
    );
    return { sha: labelled };
  }
  if (tip === labelled) return { sha: tip };

  // `ahead` is the compare API's word for "the second commit descends from
  // the first". Anything else, or no answer, is not a review of what the
  // label pointed at.
  let relation: string;
  try {
    relation = await github.compare(labelled, tip);
  } catch {
    console.log(`::warning::The label was added at ${labelled}, but ${branch} is now at ${tip}, and whether that descends from it could not be read.`);
    return { refusal: CHANGED, blocked: true };
  }
  if (relation !== "ahead") {
    console.log(
      `::warning::The branch moved while this run was queued: the label was added at ${labelled}, but ${branch} is now at ${tip}, which does not descend from it (${relation}).`,
    );
    return { refusal: CHANGED, blocked: true };
  }

  const waitMs = seconds(inputs.HEAD_WAIT_SECONDS, "HEAD_WAIT_SECONDS") * 1000;
  const pollMs = seconds(inputs.HEAD_POLL_SECONDS, "HEAD_POLL_SECONDS") * 1000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let head: string | undefined;
    try {
      head = (await github.pullRequest(pr)).headSha;
    } catch {
      head = undefined;
    }
    if (head === tip) break;
    if (Date.now() >= deadline) {
      console.log(
        `::warning::The label was added at ${labelled}, and ${branch} has since moved on to ${tip}, but after ${waitMs / 1000}s this PR still shows ${head ?? "an unreadable head"} as its head, so a review of ${tip} could not be posted against it.`,
      );
      return { refusal: `${CHANGED} If the PR still shows the old commit, close and reopen it so GitHub catches up.`, blocked: true };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  console.log(`::notice::The label was added at ${labelled}; ${branch} has moved on to ${tip}, which descends from it, so this run reviews ${tip}.`);
  return { sha: tip };
};

/**
 * The review's own time, refused the way the fix-round budget is: a limit
 * nobody wrote down is not one to guess (#220). The time-limit job summed the
 * default in its place so that this run could start and say so. Empty is the
 * default, which is no refusal.
 */
const refuseTimeLimit = (inputs: Inputs, io: Io): void => {
  const minutes = inputs.REVIEW_TIMEOUT_MINUTES;
  if (minutes === "" || /^[1-9][0-9]*$/.test(minutes)) return;
  refuse(
    io,
    `The repository variable \`AGENT_REVIEW_TIMEOUT_MINUTES\` is \`${minutes}\`. It must be a whole number of minutes (1 or more), or delete it to use the default of 5. Then add \`${REVIEW_LABEL}\` again.`,
  );
};

/**
 * **The fix-round budget** (#201, PRD #200): whether this review, if it
 * recommends changes, starts a fix round itself. Settled **before** the
 * review, so the runner asks for a round only where one will start, and the
 * posting job's hand-off starts exactly the rounds asked for (the `fix-round`
 * output the runner derives from `start` is what it selects on). `start` is a
 * ceiling, not a promise: the runner still stops the loop where the fix round
 * this review follows closed none of its findings (#202), and then asks for
 * nothing. The verdict's line is the same either way (#297).
 *
 * The budget is `MAX_FIX_ROUNDS`, the repository variable
 * `AGENT_MAX_FIX_ROUNDS`: automatic fix rounds per pull request, default 3 and
 * `0` for none. A value that is not a non-negative integer is refused, naming
 * the variable and the value: guessing a budget out of `three` or `-1` is a
 * loop running a number of rounds nobody wrote down. The deprecated `auto-fix`
 * input wins where a caller still passes it, for one release (decision 4):
 * `true` is a budget of 1, `false` of 0.
 *
 * **Rounds spent are counted from the pull request**, not from a marker label:
 * the `agent-fix-round` statuses the loop posted on its commits, one beside
 * each verdict that asked for a round (#297). So the count survives a re-run
 * and a hand edit. Counted once per posted review, by the review URL the
 * status links to, because `update-branch` copies the statuses standing on a
 * commit, links and all, on to the merge commit it makes, and a copy is not a
 * second round. A human adding `agent:fix` posts no such status, so only
 * automatic rounds count (decision 7), and a push resets nothing. A 0.7.6
 * verdict that started a round has no such status, and counts by its line.
 *
 * **And no App or PAT, no round.** A label added with the workflow token
 * starts nothing, so with neither the loop's App nor `AGENT_PAT` the verdict
 * asks for the label instead of asking for a round that would never run. The
 * same holds for a count that could not be read: a run that cannot say how
 * many rounds are spent does not start another, and warns. Which token the
 * loop writes with is `LOOP_TOKEN_SOURCE`, chosen where no agent runs, so the
 * review job never names a secret that writes (#316).
 */
const settleBudget = async (
  inputs: Inputs,
  io: Io,
  pr: number,
  accounts: LoopAccounts,
): Promise<Record<"budget" | "spent" | "start", string>> => {
  const budget = budgetOf(inputs, io);

  let spent: number | undefined = 0;
  if (budget > 0) {
    try {
      spent = await roundsSpent(io.github, pr, accounts);
    } catch (error) {
      console.log(`Counting the fix rounds failed: ${error instanceof Error ? error.message : String(error)}`);
      spent = undefined;
    }
  }

  let start = false;
  if (spent === undefined) {
    console.log(
      `::warning::Could not count the automatic fix rounds already spent on PR #${pr}, so this review will not start one. GitHub's reply is printed above. Add \`agent:fix\` by hand if the review recommends changes.`,
    );
  } else if (spent < budget && (inputs.LOOP_TOKEN_SOURCE === "app" || inputs.LOOP_TOKEN_SOURCE === "pat")) {
    start = true;
  }
  console.log(`Fix-round budget ${budget}, spent ${spent ?? "unknown"}; an automatic fix round starts on changes recommended: ${start}.`);
  return { budget: String(budget), spent: spent === undefined ? "" : String(spent), start: String(start) };
};

const budgetOf = (inputs: Inputs, io: Io): number => {
  const autoFix = inputs.DEPRECATED_AUTO_FIX;
  if (autoFix !== "") {
    if (autoFix !== "true" && autoFix !== "false") {
      refuse(
        io,
        `The review workflow still sets \`auto-fix\`, which has been replaced. Remove it and set the repository variable \`AGENT_MAX_FIX_ROUNDS\` instead, then add \`${REVIEW_LABEL}\` again.`,
      );
    }
    const budget = autoFix === "true" ? 1 : 0;
    console.log(
      `::warning::The \`auto-fix\` input is deprecated and goes away in the next release. It sets this run's fix-round budget to ${budget}, over the repository variable \`AGENT_MAX_FIX_ROUNDS\`. Remove \`auto-fix\` from the review caller's \`with:\` block and set \`AGENT_MAX_FIX_ROUNDS\` instead: \`1\` is what \`auto-fix: true\` did, and \`0\` what \`false\` did.`,
    );
    return budget;
  }
  const value = inputs.MAX_FIX_ROUNDS === "" ? "3" : inputs.MAX_FIX_ROUNDS;
  if (!/^[0-9]+$/.test(value)) {
    refuse(
      io,
      `The repository variable \`AGENT_MAX_FIX_ROUNDS\` is \`${inputs.MAX_FIX_ROUNDS}\`. It must be a whole number (0 or more), or delete it to use the default of 3. Then add \`${REVIEW_LABEL}\` again.`,
    );
  }
  // Leading zeros stripped, and anything past nine digits held at nine: no
  // pull request is going to spend that many, and a number has to stop
  // somewhere an arbitrary digit string does not.
  const digits = value.replace(/^0*/, "");
  return digits.length > 9 ? 999_999_999 : Number(digits);
};

/**
 * The automatic fix rounds the pull request has spent: one per distinct link
 * among the loop's `agent-fix-round` statuses, and 0.7.6's round-starting
 * verdicts, over every commit of the pull request. A status with no link
 * counts on its own. The loop's are those posted by one of `accounts`, in the
 * REST spelling a status's creator has (§4.1). Throws where any of it could
 * not be read, which is not the same answer as none.
 */
const roundsSpent = async (github: GitHubReader, pr: number, accounts: LoopAccounts): Promise<number> => {
  const links = new Set<string>();
  let unlinked = 0;
  for (const sha of await github.pullRequestCommits(pr)) {
    for (const status of await github.commitStatuses(sha)) {
      if (!isWorkflowBot(status.creator, accounts)) continue;
      const round =
        status.context === FIX_ROUND_STATUS.context ||
        (status.context === VERDICT_CONTEXT && status.description === LEGACY_FIX_ROUND_STARTED);
      if (!round) continue;
      if (status.targetUrl === null || status.targetUrl === "") unlinked += 1;
      else links.add(status.targetUrl);
    }
  }
  return links.size + unlinked;
};

/**
 * **Which round of a PRD PR this is** (PRD #222): a slice round, scoped to the
 * slice the PRD branch last built, or the final review of the whole PRD PR.
 * The finishing run in `implement-prd` asks for the final review by writing
 * its mark into the PRD PR's body, and every review of a PRD PR whose body
 * carries it, the re-reviews of its fix rounds included, is the final review.
 *
 * Decided here, before anything can fail, rather than by the runner: the
 * advance job reads it whichever way this run ends, and the posting job's
 * ready mark goes on a PRD PR only on the final review's approval. The runner
 * is handed this answer rather than reading the mark again. Only on a PRD PR,
 * recognised by its head as `implement-prd` names it; anywhere else there is
 * no round. A body that cannot be read fails the run, which parks the chain,
 * rather than guessing which round it is.
 */
const settleRound = async (inputs: Inputs, github: GitHubReader, pr: number): Promise<"slice" | "final" | undefined> => {
  if (!inputs.BRANCH.startsWith(PRD_BRANCH_PREFIX)) return undefined;
  let body: string;
  try {
    body = (await github.pullRequest(pr)).body;
  } catch (error) {
    throw new Error(
      `Could not read PRD PR #${pr}'s body, so whether this is a slice round or the final review could not be told (${error instanceof Error ? error.message : String(error)}). Add \`${REVIEW_LABEL}\` again.`,
    );
  }
  const round = body.includes(FINAL_REVIEW_MARK) ? "final" : "slice";
  console.log(`This review of PRD PR #${pr} is a ${round} round.`);
  return round;
};

/**
 * A refusal rather than a stop (#253): nothing was reviewed, so the posting
 * job says this run didn't run, from `refusal_reason.txt`. Thrown as well, so
 * the run fails, which is what it reads the reason on.
 */
const refuse = (io: Io, reason: string): never => {
  io.outputs.writeText("refusal_reason.txt", reason);
  console.log(`::error::${reason}`);
  throw new Error(reason);
};

const seconds = (value: string, name: string): number => {
  if (!/^[0-9]{1,6}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a number of seconds.`);
  return Number(value);
};

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};
