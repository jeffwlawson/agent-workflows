import { isWorkflowBot, safeGh } from "./common.js";
import { VERDICT_CONTEXT, type ReviewRoundNumber } from "./review-output.js";

/**
 * The identity every workflow in the loop commits under — `implement`,
 * `implement-prd`, `fix` and `update-branch` all set it with `git config
 * user.name` before the agent starts.
 *
 * It is what separates "the loop has been round once already" from "a human has
 * pushed since", which is the whole of the round question below. A human's
 * commits — by hand, or through their own agent session — make the next review
 * a fresh first round, because the branch is no longer only what the loop put
 * there.
 */
export const LOOP_COMMIT_AUTHOR = "sandcastle-agent[bot]";

export interface ReviewRound {
  readonly round: ReviewRoundNumber;
  /**
   * What could not be read, when the history could not be — a clause, so the
   * two renderers below can each put it in their own sentence.
   *
   * Present only in that case, and it does **not** mean the round is a guess
   * that may be wrong in either direction: an unreadable history is taken as
   * round 2 deliberately, because that is the stricter reading, and this field
   * is how the review says so out loud rather than reporting a round it did not
   * establish.
   */
  readonly unreadable?: string;
}

/** One commit of the pull request, reduced to the two facts the round turns on. */
interface Commit {
  readonly sha: string;
  /**
   * The committed `user.name`, not a GitHub login. The loop's identity exists
   * only in git metadata — no account is behind it — so the REST `author` field
   * is null for exactly the commits this has to recognise.
   */
  readonly author: string;
}

const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The pull request's commits, oldest first, or `undefined` when the listing
 * could not be read at all.
 *
 * `--paginate --slurp` rather than a bare call, and the flattening below is
 * what that costs: a bare call returns the *first* page, which on a pull
 * request past thirty commits is the thirty **oldest** — every one of them
 * before the commit being reviewed. The answer would be readable, wrong, and
 * wrong in the direction that calls a second round a first.
 *
 * A commit whose `sha` is missing makes the whole listing unreadable rather
 * than being skipped. Skipping it would drop a commit from the "every commit
 * since" test below, which is the one test that can only be weakened by
 * missing data.
 */
const readCommits = (repo: string, prNumber: string): readonly Commit[] | undefined => {
  const pages = readJson(
    safeGh(["api", `repos/${repo}/pulls/${prNumber}/commits`, "--paginate", "--slurp"]),
  );
  if (!Array.isArray(pages)) return undefined;

  const commits: Commit[] = [];
  for (const raw of pages.flatMap((page) => (Array.isArray(page) ? (page as unknown[]) : [page]))) {
    const value = raw as { sha?: unknown; commit?: { author?: { name?: unknown } } };
    if (typeof value.sha !== "string" || value.sha === "") return undefined;
    const author = value.commit?.author?.name;
    commits.push({ sha: value.sha, author: typeof author === "string" ? author : "" });
  }
  return commits;
};

/**
 * Whether a commit carries a verdict this loop posted, or `undefined` when its
 * statuses could not be read.
 *
 * Two conditions beyond the context, and each is load-bearing.
 *
 * **The creator**, because a status is a thing any token with `statuses: write`
 * can post under any context it likes. Only one posted by the account this
 * loop's workflows run as counts, so nothing outside the loop can promote a
 * pull request to a second round — and a second round cannot produce "ready
 * after a fix", so a forged one is a way to make a review stricter, not a way
 * to make it pass.
 *
 * **Not `error`**, because that state is the review saying *there is no
 * verdict*: the run died before it reviewed anything. Counting it would make
 * every retry after a failed run a verification pass over findings that were
 * never posted — which can only end in "needs you", on a pull request nobody
 * has reviewed yet.
 */
const verdictOn = (repo: string, sha: string): boolean | undefined => {
  const parsed = readJson(safeGh(["api", `repos/${repo}/commits/${sha}/statuses`]));
  if (!Array.isArray(parsed)) return undefined;

  return parsed.some((raw) => {
    const status = raw as { context?: unknown; state?: unknown; creator?: { login?: unknown } };
    const login = status.creator?.login;
    return (
      status.context === VERDICT_CONTEXT &&
      status.state !== "error" &&
      isWorkflowBot(typeof login === "string" ? login : undefined)
    );
  });
};

/**
 * Which round this review is, from the pull request's commits and the verdicts
 * posted on them (#96, decision 4).
 *
 * **Round 2** is: a verdict this loop posted stands on a commit of this pull
 * request, and every commit made since is the loop's own. That is the shape a
 * fix round leaves behind — review posts a verdict, `agent:fix` pushes, and the
 * push asks for this review — and it is the only shape that means "the last
 * review's findings have had their chance to land".
 *
 * Walked newest commit first, so the verdict it finds is the **latest** one and
 * the commits it has already walked past are exactly the ones that have to be
 * the loop's. A human commit among them is a fresh round 1: the branch now
 * contains work no review has seen, and a verification pass over an earlier
 * round's findings is the wrong reading of it.
 *
 * Both misclassifications are safe, which is what makes the cheap signal
 * enough. A human commit read as the loop's gets the stricter review; a loop
 * commit read as a human's gets a full one.
 *
 * A verdict on the **head** commit itself counts, with nothing after it to
 * test: re-reviewing a commit that has already been reviewed is a second pass
 * over it however it was asked for, and this is the reading #96's decision 4 is
 * written in ("a commit of this pull request … every commit after it"). The
 * case is a human re-adding `agent:review` without pushing, and taking it as a
 * second round costs them a "read the review" they could have had as "add
 * agent:fix" — the safe direction, and the one the rest of this function fails
 * in. A run that *failed* does not reach here at all: the `error` status it
 * posts is not a verdict, and `verdictOn` says so.
 */
export const detectReviewRound = (prNumber: string): ReviewRound => {
  const repo = process.env["GH_REPO"] ?? "";
  const commits = readCommits(repo, prNumber);
  if (commits === undefined) {
    return { round: 2, unreadable: "this pull request's commits could not be listed" };
  }

  for (let i = commits.length - 1; i >= 0; i -= 1) {
    const commit = commits[i];
    if (commit === undefined) continue;

    const reviewed = verdictOn(repo, commit.sha);
    if (reviewed === undefined) {
      return {
        round: 2,
        unreadable: `the commit statuses on ${commit.sha.slice(0, 7)} could not be read`,
      };
    }
    if (!reviewed) continue;

    const since = commits.slice(i + 1);
    return { round: since.every((c) => c.author === LOOP_COMMIT_AUTHOR) ? 2 : 1 };
  }

  return { round: 1 };
};

/** The one line the prompt carries, so the agent knows which pass it is doing. */
export const describeRound = (detected: ReviewRound): string => {
  if (detected.unreadable !== undefined) {
    return `This is **round 2**, taken as the stricter reading because ${detected.unreadable}.`;
  }
  if (detected.round === 2) {
    return "This is **round 2**: a verdict from an earlier review of this pull request stands, and every commit made since is the loop's own.";
  }
  return "This is **round 1**: no earlier verdict stands on these commits, or a human has pushed since one did.";
};

/**
 * And the line the *posted* summary carries in the one case a reader has to
 * know about: the round was not established, it was assumed.
 *
 * Written here rather than asked of the agent for the same reason the verdict
 * is: a fact about how the run read the repository is not the agent's to
 * report, and a review that quietly reads as a verification pass of an earlier
 * round that may not exist is the hardest state to notice from the outside.
 */
export const unreadableRoundNote = (detected: ReviewRound): string | undefined =>
  detected.unreadable === undefined
    ? undefined
    : `_Reviewed as a second round — the stricter reading — because ${detected.unreadable}._`;
