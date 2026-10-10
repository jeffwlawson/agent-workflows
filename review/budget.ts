import type { GitHubReader } from "../engine/read.js";
import type { ReadingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { isWorkflowBot, loopAccounts, type LoopAccounts } from "../shared/loop-accounts.js";
import { firstLine, readPrdBranch } from "../shared/prd-round.js";
import { FIX_ROUND_STATUS, PRD_BRANCH_PREFIX } from "../shared/record.js";
import { headerRound, type RoundScope } from "../shared/round-header.js";

type Inputs = InputValues<(typeof COMMANDS)["review:budget"]["inputs"]>;
type Io = ReadingIo<(typeof COMMANDS)["review:budget"]["outputs"]>;

/**
 * What `budget.json` holds, every value a string, under the names the review
 * job's step outputs have always had: the fix-round budget, the rounds spent
 * against it (empty where they could not be counted), and whether a review
 * that recommends changes starts a round.
 */
type Decision = "budget" | "spent" | "start";

/**
 * `review:budget` (#331): **the fix-round budget** (#201, PRD #200), whether
 * this review, if it recommends changes, starts a fix round itself. Settled
 * **before** the review, so the runner asks for a round only where one will
 * start, and the posting job's hand-off starts exactly the rounds asked for
 * (the `fix-round` output the runner derives from `start` is what it selects
 * on). `start` is a ceiling, not a promise: the runner still stops the loop
 * where the fix round this review follows closed none of its findings (#202),
 * and then asks for nothing. The verdict's line is the same either way (#297).
 *
 * The budget is `FIX_ROUND_BUDGET`, which `review:gate` read from the
 * repository variable `AGENT_MAX_FIX_ROUNDS` and refused before the checkout
 * where it is not a whole number: automatic fix rounds per round, default 3
 * and `0` for none.
 *
 * Run after the checkout, because on a PRD PR the budget is the **round's**,
 * not the pull request's (#331): each slice round has its own, and the final
 * review has its own. A budget shared across every slice parked a healthy
 * slice on the rounds earlier slices spent (PRD PRs #330 and #424). Which
 * slice is current is `readPrdBranch`'s answer, the one the review's header
 * scope is read from, and that reads the checkout's history.
 *
 * **Rounds spent are counted from the pull request**, not from a marker label:
 * the `agent-fix-round` statuses the loop posted on its commits, one beside
 * each verdict that asked for a round (#297). So the count survives a re-run
 * and a hand edit. Counted once per posted review, by the review URL the
 * status links to, because `update-branch` copies the statuses standing on a
 * commit, links and all, on to the merge commit it makes, and a copy is not a
 * second round. A human adding `agent:fix` posts no such status, so only
 * automatic rounds count (decision 7), and a push resets nothing.
 *
 * On a PRD PR a status counts toward a round by **the review it links to**,
 * whose header names its round, never by the commit it stands on: the final
 * review's first round stands on the last slice's tip, and the final review's
 * mark is in the body, on no commit. A status whose round cannot be told (no
 * link, a link to no review on the pull request, a review with no round
 * header) is not guessed at: the count is unreadable.
 *
 * **And no App or PAT, no round.** A label added with the workflow token
 * starts nothing, so with neither the loop's App nor `AGENT_PAT` the verdict
 * asks for the label instead of asking for a round that would never run. The
 * same holds for a count that could not be read: a run that cannot say how
 * many rounds are spent does not start another, and warns. Which token the
 * loop writes with is `LOOP_TOKEN_SOURCE`, chosen where no agent runs, so the
 * review job never names a secret that writes (#316).
 *
 * It writes nothing to the record, and `budget.json` is written however this
 * ends, with what was decided by then.
 */
export const budget = async (inputs: Inputs, io: Io): Promise<void> => {
  const decided: Partial<Record<Decision, string>> = {};
  try {
    const pr = pullRequestNumber(inputs.PR_NUMBER);
    const accounts = loopAccounts(inputs.AGENT_LOOP_LOGINS);
    const rounds = budgetOf(inputs.FIX_ROUND_BUDGET);
    decided.budget = String(rounds);

    const prd = inputs.BRANCH.startsWith(PRD_BRANCH_PREFIX);
    let scope: RoundScope = { kind: "regular" };
    let spent: number | undefined = 0;
    if (rounds > 0) {
      try {
        scope = prd ? roundScope(inputs) : { kind: "regular" };
        spent = await roundsSpent(io.github, pr, accounts, scope);
      } catch (error) {
        console.log(`Counting the fix rounds failed: ${error instanceof Error ? error.message : String(error)}`);
        spent = undefined;
      }
    }

    let start = false;
    if (spent === undefined) {
      console.log(
        `::warning::Could not count the automatic fix rounds already spent ${prd ? `in this round of PRD PR #${pr}` : `on PR #${pr}`}, so this review will not start one. The reason is printed above. Add \`agent:fix\` by hand if the review recommends changes.`,
      );
    } else if (spent < rounds && (inputs.LOOP_TOKEN_SOURCE === "app" || inputs.LOOP_TOKEN_SOURCE === "pat")) {
      start = true;
    }
    console.log(
      `Fix-round budget ${rounds}, spent ${spent ?? "unknown"}${described(scope)}; an automatic fix round starts on changes recommended: ${start}.`,
    );
    Object.assign(decided, { spent: spent === undefined ? "" : String(spent), start: String(start) });
  } finally {
    io.outputs.writeJson("budget.json", decided);
  }
};

/** Where the rounds were counted, for the log line: nothing off a PRD PR, where it is the pull request. */
const described = (scope: RoundScope): string =>
  scope.kind === "final" ? " in the final review" : scope.kind === "slice" ? ` in slice ${scope.k} of ${scope.n}, #${scope.subIssue}` : "";

/**
 * Which round of the PRD PR this is: the final review where `review:gate`
 * said so, and otherwise the current slice, read off the PRD branch by
 * `readPrdBranch`. Throws where the slice cannot be told: a count against a
 * round nobody can name is not one to start a fix round on.
 */
const roundScope = (inputs: Inputs): RoundScope => {
  if (inputs.ROUND === "final") return { kind: "final" };
  const parent = /^agent\/prd-(\d+)-/.exec(inputs.BRANCH)?.[1];
  if (parent === undefined) throw new Error(`${inputs.BRANCH} names no PRD, so which slice this round reviews could not be told.`);
  let current;
  try {
    current = readPrdBranch(inputs.GH_REPO, parent, inputs.BASE_REF).ranges.current;
  } catch (error) {
    throw new Error(`The PRD branch's history could not be read, so which slice this round reviews could not be told: ${firstLine(error)}`);
  }
  if (current === null) throw new Error("No commit on the PRD branch names its slice, so which slice this round reviews could not be told.");
  return { kind: "slice", ...current };
};

/**
 * The value `review:gate` settled. Anything but a whole number fails the run:
 * the gate refused the variable before the checkout, so a value that is not
 * one here is a wiring fault, not an adopter's.
 */
const budgetOf = (value: string): number => {
  if (!/^[0-9]{1,9}$/.test(value)) throw new Error(`FIX_ROUND_BUDGET is ${JSON.stringify(value)}, which is not a number of fix rounds.`);
  return Number(value);
};

/**
 * The automatic fix rounds `scope` has spent: one per distinct link among the
 * loop's `agent-fix-round` statuses, over every commit of the pull request.
 * The loop's are those posted by one of `accounts`, in the REST spelling a
 * status's creator has (§4.1).
 *
 * Off a PRD PR, every one counts, and a status with no link counts on its
 * own. On one, only those whose linked review's header names `scope`; and a
 * status whose round cannot be told throws. Throws where any of it could not
 * be read, which is not the same answer as none.
 */
const roundsSpent = async (github: GitHubReader, pr: number, accounts: LoopAccounts, scope: RoundScope): Promise<number> => {
  const links = new Set<string>();
  let unlinked = 0;
  for (const sha of await github.pullRequestCommits(pr)) {
    for (const status of await github.commitStatuses(sha)) {
      if (!isWorkflowBot(status.creator, accounts)) continue;
      if (status.context !== FIX_ROUND_STATUS.context) continue;
      if (status.targetUrl === null || status.targetUrl === "") {
        if (scope.kind !== "regular") {
          throw new Error(`An \`${FIX_ROUND_STATUS.context}\` status on ${sha} links no review, so which round it was spent in could not be told.`);
        }
        unlinked += 1;
      } else links.add(status.targetUrl);
    }
  }
  if (scope.kind === "regular") return links.size + unlinked;

  const headers = new Map((await github.reviews(pr)).map((review) => [review.url, review.body]));
  let spent = 0;
  for (const link of links) {
    const body = headers.get(link);
    if (body === undefined) {
      throw new Error(`An \`${FIX_ROUND_STATUS.context}\` status links ${link}, which is no review on PR #${pr}, so which round it was spent in could not be told.`);
    }
    const round = headerRound(body);
    if (round === undefined) {
      throw new Error(`An \`${FIX_ROUND_STATUS.context}\` status links ${link}, a review whose header names no round, so which round it was spent in could not be told.`);
    }
    if (round.kind === "final" ? scope.kind === "final" : scope.kind === "slice" && round.subIssue === scope.subIssue) spent += 1;
  }
  return spent;
};

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};
