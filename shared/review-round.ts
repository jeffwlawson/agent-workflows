import { isWorkflowBot, safeGh } from "./common.js";
import {
  FIX_ROUND_STATUS,
  LEGACY_FIX_ROUND_STARTED,
  VERDICT_CONTEXT,
  type FixRoundProgress,
} from "./review-output.js";
import type { CarriedFinding } from "./review-verification.js";

/**
 * What the verdicts already posted on a pull request say about the review now
 * running (#202, PRD #200): whether it follows a fix round, and whether it is
 * looking at commits nothing has described.
 *
 * Read from the **verdict history** alone. The round rule this replaces (#96)
 * decided a "round 2" from who authored the commits since the last verdict and
 * whether they were merges; that rule is retired, and nothing here reads a
 * commit's author or parents. The commits are walked only to find the verdicts
 * posted on them.
 */
export interface ReviewHistory {
  /**
   * Whether this review **follows a fix round**: the latest verdict this loop
   * posted on the pull request asked for an automatic fix round (its commit
   * carries `FIX_ROUND_STATUS` linking the same review), and commits have
   * landed since it. That is the shape an automatic round leaves behind: the
   * review asked for it, `agent:fix` pushed, and the push asked for this
   * review. It is what the early stop judges (`fixRoundProgress`).
   *
   * **Or the round pushed nothing but posted an out-of-scope note** (#213),
   * which asks for this review too. That round declined or answered every
   * finding without a commit, and it is exactly the one the early stop must
   * see: read as following no round, its 🟡 would start another until the
   * budget ran out, and the brief would not ask this review to restate the
   * follow-ups its record replaces.
   *
   * Only the automatic rounds, because only they spend the budget (PRD #200
   * decision 7), and they are the rounds the early stop exists to bound. A round
   * a human started by adding `agent:fix` posts no verdict of its own, so the
   * review after it reads as following none, exactly as after a human's push:
   * the brief names it among those cases. It starts another automatic round where budget is left, and
   * that round is judged.
   */
  readonly afterFixRound: boolean;
  /**
   * Whether this pull request carries commits **no verdict has been posted
   * over**: the whole pull request on its first review, or whatever has landed
   * since the last verdict on a later one.
   *
   * What reads it is `describeHistory`, for the brief. Whether the summary
   * block is rewritten is not read from here: the block records the head it
   * was written at (`shared/pr-summary.ts`, #218).
   *
   * **False wherever the history could not be read.** A fact this file could
   * not establish is not one to assert.
   */
  readonly unreviewedCommits: boolean;
  /**
   * What could not be read, when the history could not be: a clause, so the
   * two renderers below can each put it in their own sentence.
   *
   * Present only in that case, and the history is then taken as **following a
   * fix round** deliberately, because that is the stricter reading: the early
   * stop may then park the loop for a human, where the other reading could
   * spend a round nobody can judge. This field is how the review says so out
   * loud rather than reporting a history it did not establish.
   */
  readonly unreadable?: string;
}

const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The pull request's commit SHAs, oldest first, or `undefined` when the listing
 * could not be read at all.
 *
 * `--paginate --slurp` rather than a bare call, and the flattening below is
 * what that costs: a bare call returns the *first* page, which on a pull
 * request past thirty commits is the thirty **oldest**, every one of them
 * before the commit being reviewed.
 *
 * A commit whose `sha` is missing makes the whole listing unreadable rather
 * than being skipped: skipping it would drop a commit from the "commits since
 * the verdict" count, which could turn a review after a fix round into one
 * with nothing pushed.
 */
const readCommits = (repo: string, prNumber: string): readonly string[] | undefined => {
  const pages = readJson(
    safeGh(["api", `repos/${repo}/pulls/${prNumber}/commits`, "--paginate", "--slurp"]),
  );
  if (!Array.isArray(pages)) return undefined;

  const shas: string[] = [];
  for (const raw of pages.flatMap((page) => (Array.isArray(page) ? (page as unknown[]) : [page]))) {
    const sha = (raw as { sha?: unknown }).sha;
    if (typeof sha !== "string" || sha === "") return undefined;
    shas.push(sha);
  }
  return shas;
};

/**
 * Whether the latest verdict this loop posted on a commit asked for an
 * automatic fix round, `null` where the commit carries no verdict, or
 * `undefined` when its statuses could not be read.
 *
 * Two conditions beyond the context, and each is load-bearing.
 *
 * **The creator**, because a status is a thing any token with `statuses: write`
 * can post under any context it likes. Only one posted by the account this
 * loop's workflows run as counts, which narrows it to *a workflow in this
 * repository* and no further. That is enough here and not enough for a merge
 * gate: a forged verdict can at most make the early stop judge a round, which
 * parks the loop for a human rather than passing anything. The merge-gate half
 * of that caveat is `docs/ADOPTING.md` §3b's.
 *
 * **Not `error`**, because that state is the review saying *there is no
 * verdict*: the run died before it reviewed anything. Counting it would make
 * every retry after a failed run look like a review with nothing pushed since.
 *
 * The **first** match, because the endpoint lists a commit's statuses newest
 * first and a re-review of one commit posts a second verdict on it. Paginated
 * and flattened the way `readCommits` is: the page is thirty statuses and an
 * adopter's external CI spends two on every `pending → success`, so the verdict
 * falls off page 1 on an ordinary repository.
 *
 * The round is the `FIX_ROUND_STATUS` record (#297), matched to the verdict by
 * the review both link, so a record an earlier review of the same commit left
 * is not read as this verdict's. Or, for one release, the verdict's own line
 * is 0.7.6's *fix round started* one (`LEGACY_FIX_ROUND_STARTED`), which is all
 * a round in flight at the upgrade carries.
 */
const verdictOn = (repo: string, sha: string): { fixRound: boolean } | null | undefined => {
  const pages = readJson(
    safeGh(["api", `repos/${repo}/commits/${sha}/statuses`, "--paginate", "--slurp"]),
  );
  if (!Array.isArray(pages)) return undefined;

  const statuses = (
    pages.flatMap((page) => (Array.isArray(page) ? (page as unknown[]) : [page])) as {
      context?: unknown;
      state?: unknown;
      description?: unknown;
      target_url?: unknown;
      creator?: { login?: unknown };
    }[]
  ).filter((status) => {
    const login = status.creator?.login;
    return isWorkflowBot(typeof login === "string" ? login : undefined);
  });
  const verdict = statuses.find(
    (status) => status.context === VERDICT_CONTEXT && status.state !== "error",
  );
  if (verdict === undefined) return null;

  const url = verdict.target_url;
  return {
    fixRound:
      verdict.description === LEGACY_FIX_ROUND_STARTED ||
      (typeof url === "string" &&
      url !== "" &&
      statuses.some((status) => status.context === FIX_ROUND_STATUS.context && status.target_url === url)),
  };
};

/**
 * The verdict history of a pull request (#202): walked newest commit first, so
 * the verdict it finds is the **latest** one and the commits it has walked past
 * are exactly the ones landed since.
 *
 * A verdict on the head itself, with nothing after it, follows no fix round:
 * that is a human re-adding `agent:review` without pushing, and there is
 * nothing a fix round did for the early stop to judge. **Unless** `noted`: the
 * fix run posted an out-of-scope note since this loop's latest review, so a
 * round did run, and pushed nothing (#213). The note is read off the
 * conversation, which this file does not fetch, so the caller says.
 */
export const readReviewHistory = (prNumber: string, noted = false): ReviewHistory => {
  const repo = process.env["GH_REPO"] ?? "";
  const commits = readCommits(repo, prNumber);
  if (commits === undefined) {
    return {
      afterFixRound: true,
      unreadable: "this pull request's commits could not be listed",
      unreviewedCommits: false,
    };
  }

  for (let i = commits.length - 1; i >= 0; i -= 1) {
    const sha = commits[i];
    if (sha === undefined) continue;

    const verdict = verdictOn(repo, sha);
    if (verdict === undefined) {
      return {
        afterFixRound: true,
        unreadable: `the commit statuses on ${sha.slice(0, 7)} could not be read`,
        unreviewedCommits: false,
      };
    }
    if (verdict === null) continue;

    const since = commits.length - 1 - i;
    return {
      afterFixRound: (since > 0 || noted) && verdict.fixRound,
      unreviewedCommits: since > 0,
    };
  }

  // No verdict anywhere on this pull request: the first review of it, and every
  // commit on it is one nothing has described.
  return { afterFixRound: false, unreviewedCommits: true };
};

/**
 * What the fix round this review follows did with the findings it was given
 * (#202, PRD #200 decision 5), for `deriveVerdict`'s early stop, or `undefined`
 * where this review follows no fix round.
 *
 * **Given** is every finding open when this review started, by id: the fix run
 * is shown every open thread, so what is open now is what it was asked to
 * address. **Closed** is those of them this review closed, whatever closed them:
 * verified fixed, or declined by a maintainer, which is a human moving the pull
 * request on. Matched by the ids the workflow wrote, never by text or by count,
 * so a finding that returns reworded is not progress and a new one this review
 * raised is in neither set.
 *
 * A finding whose thread already carries this workflow's closing reply is left
 * out of both. An earlier review verified it and only the resolve failed, so
 * closing it again says nothing about the fix round.
 */
export const fixRoundProgress = (
  history: ReviewHistory,
  carried: readonly CarriedFinding[],
  resolved: readonly CarriedFinding[],
): FixRoundProgress | undefined => {
  if (!history.afterFixRound) return undefined;
  const given = new Set(carried.filter((f) => f.closedAs === undefined).map((f) => f.id));
  const closed = new Set(resolved.map((f) => f.id).filter((id) => given.has(id)));
  return { given: given.size, closed: closed.size };
};

/** The one line the prompt carries, so the agent knows which pass it is doing. */
export const describeHistory = (history: ReviewHistory): string => {
  if (history.unreadable !== undefined) {
    return `This review is taken to **follow a fix round**, the stricter reading, because ${history.unreadable}.`;
  }
  if (history.afterFixRound) {
    return history.unreviewedCommits
      ? "This review **follows a fix round**: an earlier review of this pull request started one, and commits have landed since."
      : "This review **follows a fix round**: an earlier review of this pull request started one, and the fix run pushed nothing but left out-of-scope notes.";
  }
  if (history.unreviewedCommits) {
    return "This review follows **no fix round** it can recognise: either no earlier verdict stands on this pull request, or the commits since the last one are a human's push, a merge, or a fix round a human started by adding `agent:fix`, which posts no verdict of its own. Review them as a change in full.";
  }
  return "This review follows **no fix round**: an earlier verdict stands on these very commits, and nothing has been pushed since.";
};

/**
 * And the line the *posted* summary carries in the one case a reader has to
 * know about: the history was not established, it was assumed.
 *
 * Written here rather than asked of the agent for the same reason the verdict
 * is: a fact about how the run read the repository is not the agent's to
 * report.
 */
export const unreadableHistoryNote = (history: ReviewHistory): string | undefined =>
  history.unreadable === undefined
    ? undefined
    : `_Reviewed as following a fix round, the stricter reading, because ${history.unreadable}._`;
