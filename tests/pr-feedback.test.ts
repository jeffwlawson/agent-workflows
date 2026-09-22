import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Same shape as tests/common.test.ts: only the two process-spawning exports are
// replaced, because everything else in the graph that reaches for
// `node:child_process` must keep working. Both `gh` and `git` arrive here —
// `execFileSync` is the one boundary the fetch crosses — so the stand-in below
// dispatches on the binary rather than on call order.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import {
  fetchPullRequestFeedback,
  refusalReason,
  surfaceText,
  unreadableNote,
} from "../shared/pr-feedback.js";
import { fetchPullRequestContext } from "../shared/review-context.js";

const spawned = vi.mocked(execFileSync);

/**
 * GraphQL answers *partially*. A query whose selections are mostly fine and one
 * of which is forbidden comes back `200` with valid `data` **and** an `errors[]`
 * array — and `gh` exits non-zero on that response anyway, having already
 * printed the good data to stdout (recorded against gh 2.100.0, #76):
 *
 *   $ gh api graphql -f query='{ repository(owner:"nodejs",name:"node")
 *                                 { name collaborators(first:1){ totalCount } } }'
 *   exit 1
 *   stdout: {"data":{"repository":{"name":"node","collaborators":null}},
 *            "errors":[{"type":"FORBIDDEN","path":["repository","collaborators"],…}]}
 *   stderr: gh: You do not have permission to view repository collaborators.
 *
 * The fetch used to run that through the throwing `gh` helper inside a `try`
 * whose `catch` set the whole pull request to `undefined`, so one forbidden
 * selection discarded every review summary, unresolved thread and conversation
 * comment that had returned correctly in the same response — and the runner then
 * refused as though the PR had no trusted feedback. Fail-closed with the wrong
 * reason: "nothing trusted was found" and "one field was forbidden" were the
 * same observable, and only one of them is something a human can act on.
 *
 * These tests are therefore mostly about *which of the four states* a response
 * lands in — ok, partial, failed, and readable-but-empty — because collapsing
 * any two of them is the defect.
 */

/** An error object shaped the way `execFileSync` throws one: the output is on it. */
const exitsNonZero = (stdout: string, stderr: string): Error => {
  const error = new Error("Command failed: gh api graphql") as Error & {
    status: number;
    stdout: string;
    stderr: string;
  };
  error.status = 1;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
};

const MAINTAINER = { author: { login: "maintainer" }, authorAssociation: "OWNER" };

const CONVERSATION_COMMENT = { body: "Please rename this before merge.", ...MAINTAINER };
const REVIEW_SUMMARY = { body: "Looks close — one thing.", state: "COMMENTED", ...MAINTAINER };
const THREAD_COMMENT = {
  path: "shared/pr-feedback.ts",
  line: 171,
  body: "This swallows the error.",
  ...MAINTAINER,
};
const THREAD = {
  id: "PRRT_kwthread",
  isResolved: false,
  comments: { nodes: [THREAD_COMMENT] },
};

interface Selections {
  comments?: unknown;
  reviews?: unknown;
  reviewThreads?: unknown;
}

/** A pull request with every surface answered, unless a selection is overridden. */
const pullRequest = (over: Selections = {}): unknown => ({
  comments: { nodes: [CONVERSATION_COMMENT] },
  reviews: { nodes: [REVIEW_SUMMARY] },
  reviewThreads: { nodes: [THREAD] },
  ...over,
});

const response = (pr: unknown, errors?: unknown[]): string =>
  JSON.stringify({
    data: { repository: { pullRequest: pr } },
    ...(errors === undefined ? {} : { errors }),
  });

const forbidden = (path: (string | number)[], message: string): unknown => ({
  type: "FORBIDDEN",
  path,
  message,
});

/**
 * **Which pairings GitHub can actually return**, because a fixture the schema
 * forbids tests the reader against a response it will never meet. From the
 * published schema (`docs.github.com/public/fpt/schema.docs.graphql`), a field
 * error null-propagates to the nearest *nullable* ancestor:
 *
 * - `PullRequest.comments` and `PullRequest.reviewThreads` are **non-null**
 *   (`IssueCommentConnection!`, `PullRequestReviewThreadConnection!`). A
 *   refusal of either propagates past the connection to `Repository.pullRequest`
 *   — nullable — so it arrives as `pullRequest: null`, which is a `failed`, not
 *   a `partial`. `{ comments: null }` beside populated siblings is not a shape
 *   that exists; see *a total failure stays distinguishable from a partial one*.
 * - `PullRequest.reviews` is **nullable**, so it is the one connection that can
 *   go missing on its own while the other two answer.
 * - Inside a list it is the element that absorbs the error, since
 *   `nodes: [X]` is nullable per element. `PullRequestReviewThread.comments` is
 *   non-null, so a refusal there nulls the *thread* — which is how `comments`
 *   and `reviewThreads` reach `partial` at all: a hole in the list, never an
 *   absent connection.
 *
 * `THREAD_HOLE` is that last shape, used wherever a test needs the inline
 * surface refused while its siblings answer.
 */
const THREAD_HOLE = { reviewThreads: { nodes: [null] } };
const THREAD_HOLE_ERROR = forbidden(
  ["repository", "pullRequest", "reviewThreads", "nodes", 0, "comments"],
  "Resource not accessible",
);

/**
 * Stand in for `gh`, and for the `git diff` the fetch takes in the same breath.
 * `answer` is a thunk so a scenario can throw the way a non-zero exit does.
 */
const ghAnswers = (answer: () => string): void => {
  spawned.mockImplementation(((file: string, args: readonly string[]) => {
    if (file === "git") return "diff --git a/shared/pr-feedback.ts b/shared/pr-feedback.ts\n";
    if (file !== "gh") throw new Error(`unexpected binary: ${file}`);
    if (args[0] === "api" && args[1] === "graphql") return answer();
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ title: "A PR", body: "No linked issue." });
    throw new Error(`unrecorded gh call: ${args.join(" ")}`);
  }) as never);
};

const PREVIOUS = { repo: process.env["GH_REPO"], base: process.env["BASE_REF"] };

beforeEach(() => {
  spawned.mockReset();
  process.env["GH_REPO"] = "o/r";
  process.env["BASE_REF"] = "main";
});

afterEach(() => {
  for (const [name, value] of [["GH_REPO", PREVIOUS.repo], ["BASE_REF", PREVIOUS.base]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * Every fixture here is a `partial`, which narrows what the refusal is allowed
 * to be: `reviews` nulled, or a hole in a node list. A refusal of the `comments`
 * or `reviewThreads` *connection* cannot appear in this block at all — those two
 * are non-null and null-propagate to `pullRequest`, so they land in *a total
 * failure stays distinguishable from a partial one* instead. See the note above
 * `THREAD_HOLE`.
 */
describe("a partial-error response keeps the selections that returned", () => {
  // The inline surface refused through the only route that leaves its siblings
  // standing: an error inside the thread list, nulling the thread.
  it("renders the surfaces that answered when one selection was refused", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(pullRequest(THREAD_HOLE), [THREAD_HOLE_ERROR]),
        "gh: Resource not accessible\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    // The whole point: these came back correctly in the same response that
    // carried the error, and used to be discarded with it.
    expect(feedback.summaries).toContain("Looks close");
    expect(feedback.conversation).toContain("Please rename this");
    expect(feedback.hasFeedback).toBe(true);
    // And the one that did not is empty *and* accounted for.
    expect(feedback.inline).toBe("");
    expect(feedback.threadIds).toEqual([]);
  });

  // `reviews` is the one nullable connection of the three, so this is the only
  // connection-level refusal that reaches `partial` rather than nulling the
  // pull request out from under its siblings.
  it("names the refused selection, the surface it takes out, and what the API said", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(pullRequest({ reviews: null }), [
          forbidden(["repository", "pullRequest", "reviews"], "Resource not accessible by integration"),
        ]),
        "gh: Resource not accessible by integration\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.status).toBe("partial");
    expect(feedback.unreadable).toEqual([
      {
        path: "repository.pullRequest.reviews",
        reason: "FORBIDDEN: Resource not accessible by integration",
        surfaces: ["summaries"],
        trustBearing: false,
      },
    ]);
  });

  it("reads a partial error that arrives with a zero exit too", () => {
    // `gh` exits non-zero today. The response is what decides, not the exit
    // code, so a gh that stopped doing that must not turn a refusal into a pass.
    //
    // `body` is `String!`, so the error nulls the element rather than the
    // connection — the conversation surface refused the way it actually is.
    ghAnswers(() =>
      response(pullRequest({ comments: { nodes: [null, CONVERSATION_COMMENT] } }), [
        forbidden(
          ["repository", "pullRequest", "comments", "nodes", 0, "body"],
          "Resource not accessible",
        ),
      ]),
    );

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.status).toBe("partial");
    expect(feedback.unreadable.map((u) => u.surfaces)).toEqual([["conversation"]]);
    expect(feedback.summaries).toContain("Looks close");
  });

  it("survives a response whose data is partially present under the error", () => {
    // `data` present, one node list null, the rest populated — the shape the
    // reproduction in #76 produced.
    ghAnswers(() => {
      throw exitsNonZero(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                comments: { nodes: [CONVERSATION_COMMENT] },
                reviews: null,
                reviewThreads: { nodes: [THREAD] },
              },
            },
          },
          errors: [forbidden(["repository", "pullRequest", "reviews"], "Forbidden")],
        }),
        "gh: Forbidden\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.conversation).toContain("Please rename this");
    expect(feedback.inline).toContain("This swallows the error.");
    expect(feedback.threadIds).toEqual(["PRRT_kwthread"]);
    expect(feedback.summaries).toBe("");
  });
});

describe("an unreadable selection is distinguishable from an empty one", () => {
  const readableButEmpty = (): void => {
    ghAnswers(() =>
      response({ comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } }),
    );
  };

  it('renders "(none)" for a surface that answered and had nothing', () => {
    readableButEmpty();

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.status).toBe("ok");
    expect(feedback.unreadable).toEqual([]);
    expect(surfaceText(feedback, "summaries")).toBe("(none)");
    expect(surfaceText(feedback, "inline")).toBe("(none)");
    expect(surfaceText(feedback, "conversation")).toBe("(none)");
  });

  it("says a surface could not be read, rather than passing it off as empty", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(pullRequest(THREAD_HOLE), [THREAD_HOLE_ERROR]),
        "gh: Resource not accessible\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    const rendered = surfaceText(feedback, "inline");
    expect(rendered).not.toBe("(none)");
    expect(rendered).toContain("could not be read");
    expect(rendered).toContain("repository.pullRequest.reviewThreads");
    // The surfaces that answered are untouched by the note.
    expect(surfaceText(feedback, "summaries")).toContain("Looks close");
  });

  /**
   * The case where silence does the most damage, and the one an empty-surface
   * substitution cannot cover: an error *inside* a surface that rendered. The
   * agent sees comments, has no reason to doubt the list is complete, and reads
   * the missing ones as absent. `line` is nullable on a review comment, so this
   * is an error that leaves its element standing — and it is not trust-bearing,
   * so the fix runner proceeds and the note is the only thing that tells it.
   */
  it("says so beside the comments a partly-read surface did hold", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(
          pullRequest({
            reviewThreads: {
              nodes: [{ ...THREAD, comments: { nodes: [{ ...THREAD_COMMENT, line: null }] } }],
            },
          }),
          [
            forbidden(
              ["repository", "pullRequest", "reviewThreads", "nodes", 0, "comments", "nodes", 0, "line"],
              "Forbidden",
            ),
          ],
        ),
        "gh: Forbidden\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");
    const rendered = surfaceText(feedback, "inline");

    expect(feedback.unreadable[0]?.trustBearing).toBe(false);
    // And the consumer that pushes proceeds on it, which is the half the
    // comment above claims and nothing asserted: a refusal that left trusted
    // feedback standing is not a reason to stop, so refusing on *any* partial
    // error — the pre-#76 outcome with better wording — has to fail here.
    expect(refusalReason(feedback)).toBeUndefined();
    // Both halves: what was read, and that it is not all there was.
    expect(rendered).toContain("This swallows the error.");
    expect(rendered).toContain("could not be read");
    expect(rendered).toContain("nodes.0.line");
    // The surfaces the error did not name are handed over unchanged.
    expect(surfaceText(feedback, "summaries")).toBe(feedback.summaries);
  });

  it("renders a note for the agent naming what is unknown rather than absent", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(pullRequest(THREAD_HOLE), [THREAD_HOLE_ERROR]),
        "gh: Resource not accessible\n",
      );
    });

    const note = unreadableNote(fetchPullRequestFeedback("12").unreadable);

    expect(note).toContain("repository.pullRequest.reviewThreads");
    expect(note).toContain("unknown");
    // It names what it qualifies rather than its own position: the note is not
    // always last, and where nothing rendered "above" points at nothing.
    expect(note).toContain("review summaries");
    expect(note).not.toContain("above");
  });

  it("renders no note at all when everything was readable", () => {
    readableButEmpty();

    expect(unreadableNote(fetchPullRequestFeedback("12").unreadable)).toBe("");
  });
});

/**
 * The shape of these fixtures is the finding, not decoration. An error on a
 * *field* does not leave the object beside it intact: `authorAssociation` is
 * `CommentAuthorAssociation!` and `nodes` is `[IssueComment]`, so the error
 * null-propagates up to the nearest nullable parent, which is the element. The
 * pairing GitHub actually returns is `nodes: [null, {…}]` **with** the error —
 * never a fully-populated list — and asserting the classification against a
 * populated one is asserting it against a response no API produces, which is
 * how a `TypeError` in the reader stays invisible.
 */
describe("a selection the author gate reads is trust-bearing", () => {
  it("marks an errored authorAssociation as trust-bearing, and steps over the hole", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        // The element the error nulled, beside one that survived it.
        response(pullRequest({ comments: { nodes: [null, CONVERSATION_COMMENT] } }), [
          forbidden(
            ["repository", "pullRequest", "comments", "nodes", 0, "authorAssociation"],
            "Resource not accessible",
          ),
        ]),
        "gh: Resource not accessible\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.unreadable).toEqual([
      {
        path: "repository.pullRequest.comments.nodes.0.authorAssociation",
        reason: "FORBIDDEN: Resource not accessible",
        surfaces: ["conversation"],
        trustBearing: true,
      },
    ]);
    // The hole is skipped rather than read: the comment beside it still renders.
    expect(feedback.conversation).toContain("Please rename this");
  });

  /**
   * `author` is the gate field whose error leaves the element **standing**:
   * `PullRequestReview.author` is `Actor`, nullable, so it absorbs the error
   * itself rather than propagating to the node the way `authorAssociation!`
   * does above. The review therefore renders, under `@unknown`, and
   * `isTrustedAuthor` passes on `OWNER` alone — the login half of the gate is
   * an `||`, so losing it cannot loosen anything.
   *
   * Which is exactly why the classification has to carry: nothing about the
   * rendered output says the author could not be established, and the only
   * thing that stops the run which *pushes* is `trustBearing` reaching
   * `refusalReason`. A review degrades and is handed a comment whose author is
   * unknown; a fix refuses.
   */
  it("marks an errored author login as trust-bearing, though the element survives it", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(
          pullRequest({
            reviews: { nodes: [{ ...REVIEW_SUMMARY, author: null }] },
          }),
          [forbidden(["repository", "pullRequest", "reviews", "nodes", 0, "author"], "Forbidden")],
        ),
        "gh: Forbidden\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.unreadable[0]?.trustBearing).toBe(true);
    // The review is still rendered — with the author it could not establish.
    expect(feedback.summaries).toContain("**@unknown** (COMMENTED)");
    expect(feedback.hasFeedback).toBe(true);
    // And the consumer that pushes stops anyway, naming the gate.
    expect(refusalReason(feedback)).toContain("author gate");
  });

  /**
   * Every list in the query at once, because the hole appears in whichever one
   * the error reached and each is read by different code: the conversation
   * split, the `render` filter, the thread filter, and the per-thread comment
   * filter. Reading a `null` in any of them throws a `TypeError` that the
   * runner writes into `failure_reason.txt` in place of its named refusal —
   * one signature standing in for another, which is the whole subject of #76.
   *
   * One error per hole, because that is the correspondence: a nulled element is
   * the shadow of an entry in `errors[]`, and a fixture with four holes and one
   * error would be asserting against a response GitHub does not send.
   */
  it("reads a response whose every node list has a hole in it", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(
          {
            comments: { nodes: [null, CONVERSATION_COMMENT] },
            reviews: { nodes: [REVIEW_SUMMARY, null] },
            reviewThreads: {
              nodes: [
                null,
                { ...THREAD, comments: { nodes: [null, ...THREAD.comments.nodes] } },
              ],
            },
          },
          [
            forbidden(
              ["repository", "pullRequest", "comments", "nodes", 0, "authorAssociation"],
              "Resource not accessible",
            ),
            forbidden(["repository", "pullRequest", "reviews", "nodes", 1, "body"], "Forbidden"),
            forbidden(
              ["repository", "pullRequest", "reviewThreads", "nodes", 0, "comments"],
              "Forbidden",
            ),
            forbidden(
              ["repository", "pullRequest", "reviewThreads", "nodes", 1, "comments", "nodes", 0, "body"],
              "Forbidden",
            ),
          ],
        ),
        "gh: Resource not accessible\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.conversation).toContain("Please rename this");
    expect(feedback.summaries).toContain("Looks close");
    expect(feedback.inline).toContain("This swallows the error.");
    expect(feedback.threadIds).toEqual(["PRRT_kwthread"]);
    expect(feedback.hasFeedback).toBe(true);
    expect(feedback.unreadable).toHaveLength(4);
  });

  /**
   * The case #76 is a prerequisite for: `collaborators(login:)` is the selection
   * under consideration at #73, and it sits beside `pullRequest` rather than
   * under it. Nothing here can say which rendered surface it takes out, so it
   * takes out none of them — and "a selection this file cannot place" is read as
   * trust-bearing rather than as harmless, which is the fail-closed reading.
   */
  it("treats a selection it cannot place as trust-bearing rather than harmless", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(pullRequest(), [
          forbidden(
            ["repository", "collaborators"],
            "You do not have permission to view repository collaborators.",
          ),
        ]),
        "gh: You do not have permission to view repository collaborators.\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.unreadable).toEqual([
      {
        path: "repository.collaborators",
        reason: "FORBIDDEN: You do not have permission to view repository collaborators.",
        surfaces: [],
        trustBearing: true,
      },
    ]);
    // Everything the query *did* answer is still rendered: the refusal is a
    // reason to refuse the run, not a reason to throw the response away.
    expect(feedback.summaries).toContain("Looks close");
  });

  it("treats an error with no path as covering everything", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        JSON.stringify({ data: null, errors: [{ message: "API rate limit exceeded" }] }),
        "gh: API rate limit exceeded\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.unreadable).toHaveLength(1);
    expect(feedback.unreadable[0]?.surfaces).toEqual(["summaries", "inline", "conversation"]);
    expect(feedback.unreadable[0]?.trustBearing).toBe(true);
    // No `data` object at all is a whole-query failure however it is explained,
    // so it is the *failed* state rather than a partial one — and the error says
    // more about it than gh's stderr does.
    expect(feedback.status).toBe("failed");
    expect(feedback.unreadable[0]?.reason).toContain("API rate limit exceeded");
  });
});

describe("a total failure stays distinguishable from a partial one", () => {
  it("reports a failed status when gh printed nothing usable", () => {
    ghAnswers(() => {
      throw exitsNonZero("", "gh: could not connect to api.github.com\n");
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.status).toBe("failed");
    expect(feedback.hasFeedback).toBe(false);
    expect(feedback.unreadable).toHaveLength(1);
    expect(feedback.unreadable[0]?.reason).toContain("could not connect");
    expect(feedback.unreadable[0]?.surfaces).toEqual(["summaries", "inline", "conversation"]);
  });

  it("reports a failed status on malformed JSON, whatever the exit code", () => {
    for (const answer of [
      () => {
        throw exitsNonZero("<html>502 Bad Gateway</html>", "gh: HTTP 502\n");
      },
      () => "<html>502 Bad Gateway</html>",
    ]) {
      ghAnswers(answer);

      expect(fetchPullRequestFeedback("12").status).toBe("failed");
    }
  });

  /**
   * The response is read defensively rather than trusted to its type: a payload
   * malformed enough to throw inside the reader would be reported as the runner
   * crashing rather than as the API answering badly, which is the substitution
   * this whole change exists to remove.
   */
  it("reads a response whose errors are not the shape they should be", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        JSON.stringify({
          data: { repository: { pullRequest: pullRequest() } },
          errors: [null, { path: "not-an-array", message: 7 }],
        }),
        "gh: something\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.status).toBe("partial");
    expect(feedback.summaries).toContain("Looks close");
    // The unplaceable error still counts, and still fails closed.
    expect(feedback.unreadable).toHaveLength(1);
    expect(feedback.unreadable[0]?.trustBearing).toBe(true);
  });

  /**
   * GitHub reports a pull request this token cannot see as a *partial* answer by
   * construction: `data` present, the leaf nulled, `NOT_FOUND` in `errors[]`.
   * Taken at face value that refuses through the author-gate branch — "a
   * selection the author gate depends on could not be read" — which names a
   * cause that has nothing to do with it. Nothing resolved, so the honest state
   * is the one whose sentence is "no answer".
   */
  it("reads the not-found shape as no answer rather than as a refused selection", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(null, [
          {
            type: "NOT_FOUND",
            path: ["repository", "pullRequest"],
            message: "Could not resolve to a PullRequest with the number of 12.",
          },
        ]),
        "gh: Could not resolve to a PullRequest with the number of 12.\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");
    const reason = refusalReason(feedback);

    expect(feedback.status).toBe("failed");
    expect(reason).toContain("could not be read at all");
    expect(reason).toContain("Could not resolve to a PullRequest");
    expect(reason).not.toContain("author gate");
  });

  /**
   * **What a `FORBIDDEN` on a feedback connection actually looks like**, and
   * the acceptance criterion a reader should check here rather than in the
   * `partial` block. `PullRequest.comments` is `IssueCommentConnection!` — as
   * is `reviewThreads` — so the error cannot stop at the connection: it
   * propagates to the nearest nullable ancestor, `repository.pullRequest`, and
   * the token is handed the whole pull request nulled. Two of the three
   * feedback selections therefore have nothing to preserve when refused
   * outright, and preservation is for `reviews`, for holes in a node list, for
   * nullable leaves and for siblings of `pullRequest` such as
   * `repository.collaborators`.
   *
   * It is also the shape that used to slip through, because the error is
   * *confined*: classifying `…pullRequest.comments` by its path says the other
   * two surfaces answered, and nothing answered. Read as `partial` the review
   * agent is handed one named selection above an empty discussion — #76 one
   * level up; read as a refused *gate* selection the fix runner names a cause
   * that has nothing to do with it.
   */
  it("reads a refused non-null connection as no answer, since it arrives as a null pull request", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(null, [
          forbidden(["repository", "pullRequest", "comments"], "Resource not accessible"),
        ]),
        "gh: Resource not accessible\n",
      );
    });

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.status).toBe("failed");
    // The path and the words survive — they are what names the cause — and the
    // classification does not: no surface was read, so none of them is empty.
    expect(feedback.unreadable).toEqual([
      {
        path: "repository.pullRequest.comments",
        reason: "FORBIDDEN: Resource not accessible",
        surfaces: ["summaries", "inline", "conversation"],
        trustBearing: true,
      },
    ]);
    for (const surface of ["summaries", "inline", "conversation"] as const) {
      expect(surfaceText(feedback, surface)).toContain("could not be read");
    }

    const reason = refusalReason(feedback);
    expect(reason).toContain("could not be read at all");
    expect(reason).not.toContain("author gate");
  });

  // Nothing resolved and nothing said about why — legal GraphQL, and the state
  // whose sentence must not become "nobody has commented on this PR".
  it("reads a null pull request with no errors at all as no answer", () => {
    ghAnswers(() => response(null));

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.status).toBe("failed");
    expect(feedback.unreadable).toHaveLength(1);
    expect(feedback.unreadable[0]?.surfaces).toEqual(["summaries", "inline", "conversation"]);
    expect(refusalReason(feedback)).toContain("resolved no pull request");
  });

  it("keeps a one-selection refusal partial, however little else rendered", () => {
    // The other half of that rule, and the code now enforces its premise: the
    // pull request resolved, so the surfaces the error does not name answered
    // and were empty — a different fact from "no answer" even though nothing
    // rendered either way.
    ghAnswers(() => {
      throw exitsNonZero(
        response({ comments: { nodes: [] }, reviews: null, reviewThreads: { nodes: [] } }, [
          forbidden(["repository", "pullRequest", "reviews"], "Forbidden"),
        ]),
        "gh: Forbidden\n",
      );
    });

    expect(fetchPullRequestFeedback("12").status).toBe("partial");
  });

  it("is not a partial error, and not an empty result", () => {
    ghAnswers(() => {
      throw exitsNonZero("", "gh: could not connect to api.github.com\n");
    });
    const failed = fetchPullRequestFeedback("12");

    ghAnswers(() =>
      response({ comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } }),
    );
    const empty = fetchPullRequestFeedback("12");

    expect(new Set([failed.status, empty.status]).size).toBe(2);
    expect(refusalReason(failed)).not.toBe(refusalReason(empty));
  });
});

/**
 * The split #76 resolved to: **fail-closed is correct when the gate itself
 * failed, not merely when data was missing.** An empty feedback set is a fine
 * degradation for a re-review; it is not a licence to push commits. So the
 * refusal has four distinct answers, and the fix runner — which holds
 * `contents: write` — takes whichever applies.
 */
describe("refusalReason names which of the four states it is refusing on", () => {
  const feedbackFrom = (answer: () => string) => {
    ghAnswers(answer);
    return fetchPullRequestFeedback("12");
  };

  it("lets a run proceed when every selection was readable and something is there", () => {
    expect(refusalReason(feedbackFrom(() => response(pullRequest())))).toBeUndefined();
  });

  it("refuses a genuinely empty result with the sentence it always had", () => {
    const reason = refusalReason(
      feedbackFrom(() =>
        response({ comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } }),
      ),
    );

    expect(reason).toContain("No unresolved feedback from a repo collaborator");
    // And crucially it does not claim anything was unreadable.
    expect(reason).not.toContain("could not be read");
  });

  it("refuses a trust-bearing refusal even though feedback did return", () => {
    const feedback = feedbackFrom(() => {
      throw exitsNonZero(
        response(pullRequest(), [
          forbidden(["repository", "collaborators"], "You do not have permission"),
        ]),
        "gh: You do not have permission\n",
      );
    });

    expect(feedback.hasFeedback).toBe(true);
    const reason = refusalReason(feedback);
    // The reason a human can act on: the selection, by name.
    expect(reason).toContain("repository.collaborators");
    expect(reason).toContain("author gate");
    expect(reason).not.toContain("No unresolved feedback");
  });

  it("refuses an empty result that had a selection refused, as the refusal", () => {
    const reason = refusalReason(
      feedbackFrom(() => {
        throw exitsNonZero(
          response({ comments: { nodes: [] }, reviews: null, reviewThreads: { nodes: [] } }, [
            forbidden(["repository", "pullRequest", "reviews"], "Forbidden"),
          ]),
          "gh: Forbidden\n",
        );
      }),
    );

    expect(reason).toContain("repository.pullRequest.reviews");
    expect(reason).not.toContain("No unresolved feedback from a repo collaborator");
  });

  it("refuses a total failure as no answer rather than as no feedback", () => {
    const reason = refusalReason(
      feedbackFrom(() => {
        throw exitsNonZero("", "gh: could not connect to api.github.com\n");
      }),
    );

    expect(reason).toContain("could not connect");
    expect(reason).not.toContain("No unresolved feedback from a repo collaborator");
  });
});

/**
 * The refusal has to reach a human, which is `fail()`'s half — it writes
 * `OUTPUT_DIR/failure_reason.txt` and the workflow's `if: failure()` step puts
 * that on the PR. Nothing else can see that the fix runner actually routes the
 * reason there: importing the runner starts a run. So this asserts the wiring
 * over the source, the way `tests/agent-cli.test.ts` asserts that `follow-ups`
 * holds no model.
 */
describe("the fix runner refuses through the reason file", () => {
  const source = fs.readFileSync("fix/fix.ts", "utf8");

  it("takes its refusal from refusalReason and hands it to fail", () => {
    expect(source).toContain("refusalReason(feedback)");
    expect(source).toMatch(/fail\(refusal\)/);
  });

  it("no longer branches on hasFeedback alone", () => {
    expect(source).not.toContain("!feedback.hasFeedback");
  });

  it("shows the agent each surface through surfaceText, so a refusal is not an empty one", () => {
    for (const surface of ["summaries", "inline", "conversation"]) {
      expect(source).toContain(`surfaceText(feedback, "${surface}")`);
    }
  });
});

/**
 * The other consumer, and the one that degrades rather than refusing: a review
 * proceeds on what survived. It had no `hasFeedback` check at all, so a partial
 * error produced an empty feedback section and the review agent silently
 * repeated work a human had already commented on, with nothing anywhere
 * recording why.
 */
describe("the review context surfaces what it could not read", () => {
  it("carries the refusal into the discussion the agent is shown", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(pullRequest(THREAD_HOLE), [THREAD_HOLE_ERROR]),
        "gh: Resource not accessible\n",
      );
    });

    const context = fetchPullRequestContext("12");

    expect(context.discussion).toContain("Looks close");
    expect(context.discussion).toContain("repository.pullRequest.reviewThreads");
    expect(context.unreadableFeedback).toHaveLength(1);
  });

  it("says so even when nothing else survived, rather than rendering no comments", () => {
    ghAnswers(() => {
      throw exitsNonZero("", "gh: could not connect to api.github.com\n");
    });

    const context = fetchPullRequestContext("12");

    // The runner renders `discussion || "(no collaborator comments)"`, which is
    // exactly the sentence a forbidden field must not turn into.
    expect(context.discussion).not.toBe("");
    expect(context.discussion).toContain("could not connect");
  });

  it("adds nothing when every selection was readable", () => {
    ghAnswers(() => response(pullRequest()));

    const context = fetchPullRequestContext("12");

    expect(context.unreadableFeedback).toEqual([]);
    expect(context.discussion).not.toContain("could not be read");
  });

  /**
   * The note qualifies the PR's own feedback and nothing else. The linked-issue
   * comments below it come from a different fetch the refusal says nothing
   * about, so a note placed after them spans a section it has no bearing on and
   * leaves the agent to guess how far it reaches.
   */
  it("places the note with the feedback it qualifies, above the linked-issue comments", () => {
    spawned.mockImplementation(((file: string, args: readonly string[]) => {
      if (file === "git") return "diff --git a/x b/x\n";
      if (args[0] === "pr" && args[1] === "view")
        return JSON.stringify({ title: "A PR", body: "Closes #5" });
      if (args[0] === "api" && args[1] === "graphql")
        throw exitsNonZero(
          response(pullRequest(THREAD_HOLE), [THREAD_HOLE_ERROR]),
          "gh: Resource not accessible\n",
        );
      if (args[1] === "repos/o/r/issues/5")
        return JSON.stringify({
          title: "The issue",
          body: "What was asked for.",
          author_association: "OWNER",
          user: { login: "maintainer" },
        });
      if (args[1] === "repos/o/r/issues/5/comments")
        return JSON.stringify([
          { body: "Steering the agent.", author_association: "OWNER", user: { login: "maintainer" } },
        ]);
      throw new Error(`unrecorded gh call: ${args.join(" ")}`);
    }) as never);

    const { discussion } = fetchPullRequestContext("12");
    const note = discussion.indexOf("Feedback that could not be read");
    const issue = discussion.indexOf("### On the linked issue");

    expect(discussion).toContain("Steering the agent.");
    expect(note).toBeGreaterThan(-1);
    expect(issue).toBeGreaterThan(-1);
    expect(note).toBeLessThan(issue);
  });
});

/**
 * The note is data the agent is handed; the framing for it belongs in the
 * prompt the runner controls, or the two consumers disagree about when the
 * agent is told. `fix` says it in prose because its refusal renders inside a
 * surface; `review` has to name the heading, so the heading is read out of the
 * renderer rather than transcribed — `tests/pins.test.ts` is the precedent.
 */
describe("both prompts frame a section that could not be read", () => {
  const heading = unreadableNote([
    { path: "repository.pullRequest.reviews", reason: "FORBIDDEN", surfaces: [], trustBearing: true },
  ])
    .split("\n")[0]!
    .replace(/^#+\s*/, "");

  it("names in review/prompt.md the heading the note actually emits", () => {
    expect(fs.readFileSync("review/prompt.md", "utf8")).toContain(heading);
  });

  it("tells the fix agent a surface may say it could not be read", () => {
    expect(fs.readFileSync("fix/prompt.md", "utf8")).toContain("could not be read");
  });
});
