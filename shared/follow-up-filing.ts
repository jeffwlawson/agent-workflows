import { asRecord, gh } from "./common.js";
import type { FilingReview } from "./follow-up-plan.js";

/**
 * The review history over `gh`, for the two runner-side callers that still
 * read it that way: the `review` runner and `shared/round-header.ts`.
 * `follow-ups:file`, which this module served whole until #510, reads the same
 * query through the engine's reader (`reviewHistory` in `engine/read.ts`), so
 * two copies of it exist until those two move too.
 *
 * The repository is resolved from `ghRepo`, `GH_REPO`, and never from a git
 * remote.
 */

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
      reviews(last:100) { nodes { body url lastEditedAt submittedAt author { login } commit { oid } } }
    }
  }
}`;

interface GqlReview {
  body?: string | null;
  url?: string;
  lastEditedAt?: string | null;
  submittedAt?: string | null;
  author?: { login?: string } | null;
  commit?: { oid?: string } | null;
}

/**
 * Every review on the pull request, oldest first. Also read by a PRD PR's
 * review (#247), which carries forward what the earlier rounds recorded and,
 * on the final review, reads each slice round's record by the commit it
 * reviewed: the same reviews through the same gate, rather than a second query
 * that could disagree with the one the filing end reads.
 */
export const fetchReviews = (ghRepo: string, prNumber: string): FilingReview[] => {
  const [owner = "", repo = ""] = ghRepo.split("/");
  const raw = gh([
    "api",
    "graphql",
    // `-f` for the two strings and `-F` for the number, which is not stylistic:
    // `-F` type-converts an integer-shaped value, so a repository named in
    // digits — `org/2048` — would send `repo` as an `Int` against `String!` and
    // every merge in it would die at the GraphQL layer. `number` is the one
    // that genuinely wants `Int!`.
    "-f",
    `owner=${owner}`,
    "-f",
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
      ...(typeof review.commit?.oid === "string" ? { commit: review.commit.oid } : {}),
      ...(typeof review.submittedAt === "string" ? { submittedAt: review.submittedAt } : {}),
    };
  });
};
