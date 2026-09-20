import { asRecord, gh } from "./common.js";
import {
  FOLLOW_UP_STUB_LABEL,
  type FilingInput,
  type FilingPlan,
  type FilingReview,
  type FilingStub,
} from "./follow-up-plan.js";
import { FOLLOW_UPS_LABEL } from "./review-output.js";

/**
 * The two halves either side of `planFollowUps` (#49): everything here talks to
 * GitHub and decides nothing, and everything the planner does decides and talks
 * to nothing.
 *
 * It lives in `shared/` rather than in the runner for the reason everything
 * reading a GitHub surface does — a runner is the environment it reads and the
 * order it does things in, and a query in one is a query no test can reach and
 * no second caller can reuse. What is *not* here is any judgement: which review
 * counts, which finding is a duplicate and what the pull request is told are
 * all the planner's, where they are argued with from plain objects.
 *
 * Every call below resolves its repository from `GH_REPO` and never from a git
 * remote, which is load-bearing rather than conventional here: the filing
 * workflow checks nothing out, so there is no remote to resolve from. `gh`
 * reads that variable for exactly this case.
 */

const ghRepo = (): string => process.env["GH_REPO"] ?? "";

/**
 * Is the marker still on the pull request?
 *
 * **Re-fetched, always, and never read from the event payload.** The payload's
 * label list is assembled when the event fires and is not trustworthy at close
 * time — and "remove the label, then click merge" is precisely the race the
 * opt-out exists for. There is deliberately no cheap negative fast-path around
 * this call either: a shortcut that skipped the fetch when the payload showed
 * no label would fire exactly when a label was added late, silently skipping a
 * pull request that should have filed.
 *
 * Throws rather than answering `false` when `gh` fails. A missing marker is a
 * silent exit, so an unreadable answer collapsing into one would drop a pull
 * request's findings without saying anything — and the marker is what makes the
 * retry possible, so the run has to end loudly with it still in place.
 */
export const hasFollowUpsMarker = (prNumber: string): boolean =>
  gh(["pr", "view", prNumber, "--json", "labels", "--jq", ".labels[].name"])
    .split("\n")
    .map((line) => line.trim())
    .includes(FOLLOW_UPS_LABEL);

/**
 * Reviews over GraphQL, because REST cannot answer the question at all: the
 * review-list endpoint returns no update timestamp, only a submission time an
 * edit does not move. An edit preserves the author, the author association and
 * both timestamps, so `lastEditedAt` is the one field that can tell a submitted
 * body from a rewritten one.
 *
 * `last:` rather than `first:`, which matters at the boundary and nowhere else:
 * the newest block wins, so a pull request with more reviews than fit in one
 * page has to lose the *oldest*. `first:` would drop the only one that counts.
 *
 * Review bodies only. PR conversation comments are not read here and must not
 * be added: the loop closed that channel deliberately, and reopening it would
 * readmit bodies from authors who never needed write access to post them.
 */
const REVIEWS_QUERY = `
query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      reviews(last:100) { nodes { body url lastEditedAt author { login } } }
    }
  }
}`;

interface GqlReview {
  body?: string | null;
  url?: string;
  lastEditedAt?: string | null;
  author?: { login?: string } | null;
}

const fetchReviews = (prNumber: string): FilingReview[] => {
  const [owner = "", repo = ""] = ghRepo().split("/");
  const raw = gh([
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repo}`,
    "-F",
    `number=${prNumber}`,
    "-f",
    `query=${REVIEWS_QUERY}`,
  ]);

  const nodes: unknown = JSON.parse(raw)?.data?.repository?.pullRequest?.reviews?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(
      `The reviews on #${prNumber} could not be read: the GraphQL response carried no review list.`,
    );
  }

  return nodes.map((node: unknown) => {
    const record = asRecord(node, `a review on #${prNumber}`);
    // An absent field is not the same answer as `null`, and the difference is
    // the whole control: `null` is "never edited", absent is "nobody asked", and
    // reading the second as the first turns an edited body into a filing.
    if (!("lastEditedAt" in record)) {
      throw new Error(
        `A review on #${prNumber} came back without \`lastEditedAt\`, so whether it was edited cannot be established.`,
      );
    }
    const review = record as GqlReview;
    return {
      author: review.author?.login ?? "",
      body: review.body ?? "",
      lastEditedAt: review.lastEditedAt ?? null,
      url: review.url ?? "",
    };
  });
};

/**
 * How many stubs are read. There is a cap because the set only ever grows — a
 * `wontfix` suppression never expires — and the listing is newest first, so
 * what falls off the end is the oldest. That direction is the point: a stub
 * missed files a duplicate, which is loud and cheap, where the other ordering
 * would start skipping real findings once a repository got old enough.
 */
const STUB_LIMIT = 500;

interface GhStub {
  number?: number;
  state?: string;
  stateReason?: string | null;
  body?: string | null;
}

/**
 * Every `pr-follow-up` issue, open and closed — **listed by label and matched
 * locally, never searched.** A label filter is exact; issue search tokenizes on
 * path punctuation and is fuzzy in both directions, and a spurious search hit
 * skips a real finding silently, which is the one direction nothing in this
 * feature fails in.
 *
 * Both states, because the planner needs to tell a stub closed as `wontfix` —
 * a decision not to relitigate — from one closed because somebody fixed it,
 * where a finding that is true again has to file again.
 */
const fetchStubs = (): FilingStub[] => {
  const raw = gh([
    "issue",
    "list",
    "--label",
    FOLLOW_UP_STUB_LABEL,
    "--state",
    "all",
    "--limit",
    String(STUB_LIMIT),
    "--json",
    "number,state,stateReason,body",
  ]);

  const issues: unknown = JSON.parse(raw || "[]");
  if (!Array.isArray(issues)) {
    throw new Error(`The \`${FOLLOW_UP_STUB_LABEL}\` issues could not be read.`);
  }

  return issues
    .filter((issue: GhStub | null) => typeof issue?.number === "number")
    .map((issue: GhStub) => ({
      number: issue.number as number,
      state: issue.state ?? "",
      stateReason: issue.stateReason ?? null,
      body: issue.body ?? "",
    }));
};

/**
 * Everything the planner rules on, gathered in two calls.
 *
 * The pull request number is parsed here rather than carried as text, and a
 * value that is not a number is refused rather than passed through: it is the
 * key the same-pull-request case matches on, so a `NaN` would match nothing,
 * quietly turning every retry into a second copy of every stub.
 */
export const fetchFilingInput = (prNumber: string): FilingInput => {
  const number = Number.parseInt(prNumber, 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`PR_NUMBER is ${JSON.stringify(prNumber)}, which is not a pull request number.`);
  }
  return { prNumber: number, reviews: fetchReviews(prNumber), stubs: fetchStubs() };
};

/** Every label this repository actually has, so a stub is never refused for naming one it lacks. */
const repoLabels = (): Set<string> =>
  new Set(
    gh(["api", `repos/${ghRepo()}/labels`, "--paginate", "--jq", ".[].name"])
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.length > 0),
  );

/** `gh issue create` answers with the new issue's URL and nothing else. */
const issueNumberIn = (url: string): number => {
  const match = /\/(\d+)\s*$/.exec(url.trim());
  if (!match) throw new Error(`Filed an issue but could not read its number from ${JSON.stringify(url.trim())}.`);
  return Number(match[1]);
};

export interface FilingOutcome {
  /** Issues opened, in the order the reviewer listed them. */
  readonly created: readonly number[];
  /** Existing stubs re-flagged. */
  readonly commented: readonly number[];
  readonly reported: boolean;
  readonly markerRemoved: boolean;
}

/**
 * Perform the plan, in the order the plan's own guarantees depend on.
 *
 * Issues first, because the report names them and cannot be written until they
 * have numbers. The marker **last, and only on a plan that asked for it**: it
 * is removed on success and left in place on every refusal and every failure,
 * where it is both the retry affordance and the signal that this pull request's
 * findings are unfiled.
 *
 * A throw anywhere in here fails the run with the marker still on, which is
 * what makes a partial failure recoverable — and safe to recover, because a
 * stub this pull request already filed carries its number in the dedup payload
 * and is reported as *already filed* on the retry rather than re-flagged.
 */
export const executeFilingPlan = (prNumber: string, plan: FilingPlan): FilingOutcome => {
  const available = plan.issues.length === 0 ? new Set<string>() : repoLabels();
  const created: number[] = [];
  let report = plan.report;

  for (const issue of plan.issues) {
    const labels = issue.labels.filter((label) => available.has(label));
    const missing = issue.labels.filter((label) => !available.has(label));

    const number = issueNumberIn(
      gh([
        "issue",
        "create",
        "--title",
        issue.title,
        "--body",
        issue.body,
        ...labels.flatMap((label) => ["--label", label]),
      ]),
    );
    created.push(number);

    // Filed unlabelled rather than not filed. Both labels are newer than the
    // ones `docs/ADOPTING.md` §3 mandates, so an adopter can be current on the
    // pin and not have them — and a stub outside the triage flow is worth more
    // than a finding that was dropped for want of a label. Said out loud,
    // because an unlabelled stub is invisible to exactly the queue it was
    // filed for.
    if (missing.length > 0) {
      // On stdout, where the runner reads workflow commands from: a warning
      // that does not become an annotation is one nobody sees, which is the
      // failure this line exists to prevent.
      console.log(
        `::warning::Filed #${number} without ${missing.map((label) => `\`${label}\``).join(" and ")}, which this repository does not have. Create the label${missing.length === 1 ? "" : "s"} and add ${missing.length === 1 ? "it" : "them"} to the issue.`,
      );
    }

    report = report?.replace(issue.placeholder, `#${number}`);
  }

  for (const comment of plan.stubComments) {
    gh(["issue", "comment", String(comment.issue), "--body", comment.body]);
  }

  if (report !== undefined) gh(["pr", "comment", prNumber, "--body", report]);

  if (plan.removeMarker) gh(["pr", "edit", prNumber, "--remove-label", FOLLOW_UPS_LABEL]);

  return {
    created,
    commented: plan.stubComments.map((comment) => comment.issue),
    reported: report !== undefined,
    markerRemoved: plan.removeMarker,
  };
};
