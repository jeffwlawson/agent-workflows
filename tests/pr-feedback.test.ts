import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Same shape as tests/common.test.ts: only the process-spawning exports are
// replaced, because everything else in the graph that reaches for
// `node:child_process` must keep working. Both `gh` and `git` arrive here, so
// the stand-in below dispatches on the binary rather than on call order.
//
// Two boundaries, not one: the fetch reaches `gh api graphql` through
// `ghOutcome`, which spawns rather than execs so that stderr survives a zero
// exit (#90), and everything else it runs — `gh pr view`, `git diff` — through
// `execFileSync`. The `spawnSync` stand-in delegates to the `execFileSync` one
// rather than duplicating it, so a scenario is still written once.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  fetchPullRequestFeedback,
  refusalReason,
  surfaceText,
  unreadableNote,
} from "../shared/pr-feedback.js";
import { fetchPullRequestContext } from "../shared/review-context.js";

const spawned = vi.mocked(execFileSync);
const captured = vi.mocked(spawnSync);

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

/**
 * A non-zero exit, as a scenario writes it: thrown, the way `execFileSync`
 * throws one, with the output on it. `ghOutcome` no longer *catches* anything —
 * it reads `spawnSync`'s report — so `answersGh` below translates this into
 * that report rather than letting it propagate. Kept as a throw because it is
 * how a stand-in says "this call did not succeed" in one expression, mid-branch.
 */
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

/**
 * `gh` as `ghOutcome` sees it, in terms of the `execFileSync` stand-in every
 * scenario here writes. A returned string is a zero exit with nothing on
 * stderr; an error thrown the way `execFileSync` throws one is the exit it
 * describes, with whatever output it carried.
 *
 * The translation, not a second stand-in: the two boundaries answer the same
 * `gh`, and a scenario that had to set up both could set them up differently.
 * The one shape it cannot express is a **zero exit that printed to stderr** —
 * which `execFileSync` cannot express either, that being the defect — so the
 * test that needs one replaces this implementation outright.
 */
const answersGh = ((file: string, args: readonly string[]) => {
  try {
    return { status: 0, stdout: spawned(file, args as string[]), stderr: "" };
  } catch (thrown) {
    const failure = thrown as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}) as never;

const PREVIOUS = { repo: process.env["GH_REPO"], base: process.env["BASE_REF"] };

beforeEach(() => {
  spawned.mockReset();
  captured.mockReset();
  captured.mockImplementation(answersGh);
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

  /**
   * The other half of that sentence, and the case #73 walks into:
   * `repository.collaborators` is refused, it renders none of the three
   * surfaces, and all three answered in full. A preamble that generalises over
   * both tells the agent its feedback is unknown when it is complete — the same
   * two-facts-in-one-sentence collapse this change exists to take apart, aimed
   * the other way. The refusal is still named; it is just not a caveat on the
   * comments below it.
   */
  it("does not call the feedback unknown when the refusal renders none of it", () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(pullRequest(), [
          forbidden(["repository", "collaborators"], "You do not have permission"),
        ]),
        "gh: You do not have permission\n",
      );
    });

    const note = unreadableNote(fetchPullRequestFeedback("12").unreadable);

    // Said, by name, with what the API said about it.
    expect(note).toContain("repository.collaborators");
    expect(note).toContain("You do not have permission");
    // But not as a claim about the three surfaces, which answered.
    expect(note).not.toContain("unknown");
    expect(note).toContain("in full");
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

  /**
   * The one lookup here that reads a key out of a payload this file did not
   * type, so the payload gets to choose the key. `SURFACE_OF_SELECTION` is an
   * object literal and therefore inherits `Object.prototype`: indexing it with
   * `toString` returns a *function*, not `undefined`, so a selection named that
   * would sail past the unplaceable branch and be classified — fail-open, in
   * the one place the rule is to fail closed. Not reachable from today's
   * `QUERY`, whose paths are its own field names; reachable the moment a
   * selection is aliased to one of these, and cheaper to close than to notice.
   */
  it("treats a selection named after an Object.prototype key as unplaceable", () => {
    for (const key of ["toString", "constructor", "valueOf", "__proto__"]) {
      ghAnswers(() => {
        throw exitsNonZero(
          response(pullRequest(), [
            forbidden(["repository", "pullRequest", key], "Resource not accessible"),
          ]),
          "gh: Resource not accessible\n",
        );
      });

      expect(fetchPullRequestFeedback("12").unreadable).toEqual([
        {
          path: `repository.pullRequest.${key}`,
          reason: "FORBIDDEN: Resource not accessible",
          surfaces: [],
          trustBearing: true,
        },
      ]);
    }
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

/**
 * Both lists `classify` rules on are hand-transcribed from `QUERY`, and the
 * query's own comment says so: a selection added to it is a row added to
 * `SURFACE_OF_SELECTION` in the same change.
 *
 * An **omission** is already loud — an unplaceable path is read as trust-bearing
 * and the run refuses. A **rename** is not. Alias `comments` to anything, or
 * follow a field of GitHub's that moves, and the query keeps working while every
 * error under it arrives unplaceable: a refusal blamed on the author gate,
 * naming a selection the map has never heard of, for a query with nothing wrong
 * with it. The same for the gate's own two fields, which are transcribed the
 * same way.
 *
 * So the transcription is checked against the thing it was transcribed from.
 * `QUERY` is read out of the module's text because nothing exports it — the way
 * the fix runner's wiring is asserted over `fix/fix.ts` below — and every path
 * an error in it could name is put through the one seam that shows what the
 * classification made of it.
 *
 * The data half of the fixture is deliberately whole. What is under test is the
 * classification of a *path*, which `asUnreadable` computes from the error
 * alone; which shape each individual refusal leaves behind in `data` is the
 * business of the blocks above, one refusal at a time.
 */
describe("the classification is checked against the query it was transcribed from", () => {
  /** One selection of the query, under the response key an error path would name. */
  interface Selection {
    readonly key: string;
    readonly children: readonly Selection[];
  }

  /**
   * Enough GraphQL to read this one query: field names, selection sets, and the
   * alias that decides the response key. Arguments go first — they carry no
   * selections — and the operation's own header with them, so the walk starts at
   * `repository`.
   *
   * The alias is the point rather than a detail. `conversation: comments(...)`
   * puts `conversation` in every error path GitHub reports, so the alias, not the
   * field, is what the map has to be keyed on.
   */
  const parseSelections = (graphql: string): readonly Selection[] => {
    const withoutArguments = graphql.replace(/\([^)]*\)/g, " ");
    const tokens =
      withoutArguments
        .slice(withoutArguments.indexOf("{") + 1)
        .match(/[_A-Za-z][_A-Za-z0-9]*|[{}:]/g) ?? [];

    let at = 0;
    const selectionSet = (): Selection[] => {
      const selections: Selection[] = [];
      for (let token = tokens[at]; token !== undefined && token !== "}"; token = tokens[at]) {
        at += 1;
        // `alias: field` — the alias is the response key, so the field name is
        // the half that gets dropped.
        if (tokens[at] === ":") at += 2;

        let children: readonly Selection[] = [];
        if (tokens[at] === "{") {
          at += 1;
          children = selectionSet();
          at += 1;
        }
        selections.push({ key: token, children });
      }
      return selections;
    };
    return selectionSet();
  };

  const refuse = (what: string): never => {
    throw new Error(`${what} — this check reads shared/pr-feedback.ts and can no longer find it.`);
  };

  const querySource = (): string =>
    /\bconst QUERY = `([^`]*)`/.exec(fs.readFileSync("shared/pr-feedback.ts", "utf8"))?.[1] ??
    refuse("`QUERY` is no longer a template literal");

  const childrenOf = (selections: readonly Selection[], key: string): readonly Selection[] =>
    selections.find((selection) => selection.key === key)?.children ??
    refuse(`\`QUERY\` no longer selects \`${key}\``);

  /** The query's own selections under `pullRequest`, by response key. */
  const SELECTIONS = childrenOf(childrenOf(parseSelections(querySource()), "repository"), "pullRequest");

  /**
   * Every path an error in those selections could name. The `0` after `nodes` is
   * the list index GitHub puts there: `classify` reads names and not positions,
   * but a path without it is not one the API sends.
   */
  const pathsUnder = (
    selections: readonly Selection[],
    prefix: readonly (string | number)[],
  ): readonly (readonly (string | number)[])[] =>
    selections.flatMap((selection) => {
      const here = [...prefix, ...(selection.key === "nodes" ? ["nodes", 0] : [selection.key])];
      return [here, ...pathsUnder(selection.children, here)];
    });

  const PATHS = pathsUnder(SELECTIONS, ["repository", "pullRequest"]);
  const dotted = (path: readonly (string | number)[]): string => path.map(String).join(".");

  /** Every path at once: one response, one error per path, in that order. */
  const classified = () => {
    ghAnswers(() => {
      throw exitsNonZero(
        response(
          pullRequest(),
          PATHS.map((path) => forbidden([...path], "Resource not accessible")),
        ),
        "gh: Resource not accessible\n",
      );
    });
    return fetchPullRequestFeedback("12").unreadable;
  };

  it("places every selection the query makes on a rendered surface", () => {
    // The parse itself, since an empty list would agree with everything below.
    // Not the three names: transcribing them here is the habit under test, and
    // an added selection should fail on the row it is missing rather than on a
    // list in a test that has to be updated to say the same thing twice.
    expect(SELECTIONS.length).toBeGreaterThan(0);

    const unplaceable = classified().filter((selection) => selection.surfaces.length === 0);

    expect(unplaceable.map((selection) => selection.path)).toEqual([]);
  });

  /**
   * The gate's own fields, in the query's words for them. `isTrustedAuthor` is
   * handed `authorAssociation` and the `login` under `author`, and it is
   * `author` that matters of that second pair: a path through it costs the gate
   * its login whether it stops there or goes on to the leaf.
   *
   * Named here because `GATE_FIELDS` is the transcription under test and cannot
   * also be the expectation. What this catches is the two coming apart — an
   * error on a field the gate reads, classified as harmless because the query
   * calls that field something else now.
   */
  const GATE_READS = ["author", "authorAssociation"];

  /** Every selection set in the query, under the dotted path that reaches it. */
  const selectionSets = (
    selections: readonly Selection[],
    at: readonly string[],
  ): readonly { readonly at: string; readonly keys: readonly string[] }[] => [
    { at: at.join("."), keys: selections.map((selection) => selection.key) },
    ...selections.flatMap((selection) => selectionSets(selection.children, [...at, selection.key])),
  ];

  /**
   * The selection sets asking for a **body** — text somebody wrote, which is the
   * whole reason the gate exists. Derived rather than listed, because a list of
   * the three would be the transcription this block is here to distrust.
   */
  const AUTHORED = selectionSets(SELECTIONS, ["repository", "pullRequest"]).filter((set) =>
    set.keys.includes("body"),
  );

  /**
   * Per selection set, not across the query. The gate's two fields are selected
   * three times over, so a check against the union of every path segment passes
   * while two of the three still name them — and aliasing `authorAssociation` in
   * the conversation comments alone is then a gate the API can refuse in silence:
   * the error classified harmless, `fix` pushing on feedback whose author
   * association it never read.
   */
  it("selects both gate fields beside every body the query asks for", () => {
    // Vacuous over an empty list, and an empty list is itself the finding: this
    // query asks for no feedback text at all.
    expect(AUTHORED.length).toBeGreaterThan(0);

    expect(
      AUTHORED.filter((set) => !GATE_READS.every((field) => set.keys.includes(field))),
    ).toEqual([]);
  });

  it("marks the paths naming a gate field trust-bearing, and only those", () => {
    const trustBearing = classified().filter((selection) => selection.trustBearing);

    expect(trustBearing.map((selection) => selection.path)).toEqual(
      PATHS.filter((path) => path.map(String).some((segment) => GATE_READS.includes(segment))).map(
        dotted,
      ),
    );
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
   * And the sentence it reports is `gh`'s, on the exit code where that used to
   * be impossible (#90). A zero exit is not a promise of JSON — an intercepting
   * proxy answers 200 with a page, and `gh` says so on stderr while exiting
   * zero — and the reader prefers stderr precisely because it is the half
   * written for a human. With it discarded on this path the fallback was the
   * first three lines of the unparseable body, which names the symptom in the
   * one vocabulary nobody can act on.
   *
   * The stand-in is replaced rather than driven here: a zero exit carrying
   * stderr is the shape `execFileSync` cannot express, which is the whole of
   * the defect.
   */
  it("reports what gh said, not raw stdout, when a zero exit answered with neither", () => {
    ghAnswers(() => "<html>502 Bad Gateway</html>");
    captured.mockReturnValue({
      status: 0,
      stdout: "<html>502 Bad Gateway</html>",
      stderr: "gh: HTTP 502 from api.github.com\n",
    } as never);

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.status).toBe("failed");
    expect(feedback.unreadable).toHaveLength(1);
    expect(feedback.unreadable[0]?.reason).toContain("HTTP 502 from api.github.com");
    expect(feedback.unreadable[0]?.reason).not.toContain("<html>");
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

/**
 * The review record, read back off the pull request (#111). A later review
 * rules on what an earlier one left open, and both halves of that record are
 * selected by the **id the workflow wrote** rather than by what anything says:
 * the open threads this loop opened, and the latest review body it posted.
 *
 * The failure this guards is silent in the worst direction. A thread whose id
 * is not read is a finding no review verifies, so it stays open forever and
 * counts against every later verdict; a *body* whose entries are not read is a
 * finding that vanishes, since it has no thread to stay open on at all.
 */
describe("the findings an earlier review left open", () => {
  const AGENT = { author: { login: "github-actions[bot]" }, authorAssociation: "NONE" };

  const agentThread = (id: string, findingId: string): unknown => ({
    id,
    isResolved: false,
    comments: {
      nodes: [
        {
          path: "src/queue.ts",
          line: 206,
          body: `**Fix before merge.** the guard runs after the return\n\n<!-- agent-finding ${findingId} -->`,
          ...AGENT,
        },
      ],
    },
  });

  it("carries an open agent thread with the id the workflow wrote into it", () => {
    ghAnswers(() => response({ reviewThreads: { nodes: [agentThread("PRRT_one", "f-1")] } }));

    expect(fetchPullRequestFeedback("12").agentThreads).toEqual([
      {
        threadId: "PRRT_one",
        findingId: "f-1",
        text: "src/queue.ts:206 — the guard runs after the return",
      },
    ]);
  });

  /**
   * And the rating beside it, which is how a finding's severity survives a
   * round: a carried finding reaches a later review as an id and one line, so
   * without this the record could badge what the round found and nothing it
   * carried (#113).
   */
  it("carries the severity the marker holds, and none where it holds none", () => {
    const rated = {
      id: "PRRT_two",
      isResolved: false,
      comments: {
        nodes: [
          {
            path: "src/queue.ts",
            line: 206,
            body: "**Fix before merge.** the guard runs after the return\n\n<!-- agent-finding f-2 high -->",
            ...AGENT,
          },
        ],
      },
    };
    ghAnswers(() =>
      response({ reviewThreads: { nodes: [agentThread("PRRT_one", "f-1"), rated] } }),
    );

    const threads = fetchPullRequestFeedback("12").agentThreads;
    expect(threads.map((t) => t.severity)).toEqual([undefined, "high"]);
  });

  /**
   * A human's thread is feedback and not a finding this loop can rule on, so it
   * stays in `threadIds` — where `agent:fix` answers it — and out of the record
   * a review verifies.
   */
  it("leaves a human's thread out of the record while still showing it", () => {
    ghAnswers(() => response({ reviewThreads: { nodes: [THREAD] } }));
    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.agentThreads).toEqual([]);
    expect(feedback.threadIds).toEqual(["PRRT_kwthread"]);
  });

  /**
   * The marker is a **selector, not a control**: anyone who can comment can
   * type one. What makes a thread the loop's own is who opened it.
   */
  it("ignores a marker in a comment this loop did not write", () => {
    const forged = {
      id: "PRRT_forged",
      isResolved: false,
      comments: {
        nodes: [{ path: "src/queue.ts", line: 206, body: "Nothing to see <!-- agent-finding f-1 -->", ...MAINTAINER }],
      },
    };
    ghAnswers(() => response({ reviewThreads: { nodes: [forged] } }));

    expect(fetchPullRequestFeedback("12").agentThreads).toEqual([]);
  });

  /**
   * A resolved thread is a settled finding — closed by a review that verified
   * it, or by a human — and re-raising it is the accumulation this record
   * exists to end.
   */
  it("carries no resolved thread", () => {
    ghAnswers(() =>
      response({ reviewThreads: { nodes: [{ ...(agentThread("PRRT_one", "f-1") as object), isResolved: true }] } }),
    );

    expect(fetchPullRequestFeedback("12").agentThreads).toEqual([]);
  });

  /**
   * The **latest** loop review, because each one re-lists what it verified as
   * still open: the newest body is the current statement and an older one is
   * the statement it replaced.
   */
  it("takes the newest review this loop posted", () => {
    ghAnswers(() =>
      response({
        reviews: {
          nodes: [
            { body: "round 1 body", state: "COMMENTED", ...AGENT },
            { body: "round 2 body", state: "COMMENTED", ...AGENT },
          ],
        },
      }),
    );

    expect(fetchPullRequestFeedback("12").latestAgentReviewBody).toBe("round 2 body");
  });

  /**
   * And never a human's review, however trusted. Their prose carries no finding
   * ids, so reading it as the record would replace the loop's statement of what
   * is open with something that states nothing.
   */
  it("ignores a maintainer's own review, which carries no record", () => {
    ghAnswers(() =>
      response({
        reviews: {
          nodes: [
            { body: "round 1 body", state: "COMMENTED", ...AGENT },
            { body: "Looks good to me.", state: "APPROVED", ...MAINTAINER },
          ],
        },
      }),
    );

    expect(fetchPullRequestFeedback("12").latestAgentReviewBody).toBe("round 1 body");
  });

  it("says the record is empty for a pull request this loop has never reviewed", () => {
    ghAnswers(() => response({ reviews: { nodes: [REVIEW_SUMMARY] }, reviewThreads: { nodes: [] } }));
    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.agentThreads).toEqual([]);
    expect(feedback.latestAgentReviewBody).toBe("");
  });

  /**
   * **Past fifty reviews, "latest" was the fiftieth oldest** (#125; #127,
   * decision 4).
   *
   * GitHub returns a review connection oldest-first, so `reviews(first:50)`
   * hands back the fifty *oldest* and the last node of that page is the newest
   * of those — the newest review only while a pull request has had fewer than
   * fifty. Past that the findings record read into every later round is a
   * body from long ago: findings the rounds since verified and closed come
   * back by id as still open, with nothing on the pull request to say why, and
   * the round that closed them cannot close them again because it already did.
   *
   * The stand-in below **honours the pagination argument**, which is the whole
   * of what makes this a test rather than a restatement: a fixture that
   * returned all fifty-one nodes whatever was asked would pass on the broken
   * query too, since the reader takes the last node either way.
   */
  it("reads the newest review on a pull request with more than fifty of them", () => {
    // Fifty human reviews, then the loop's — so the newest page holds the one
    // that matters and the oldest page holds none of it.
    const nodes = [
      ...Array.from({ length: 50 }, (_unused, n) => ({
        body: `human review ${n}`,
        state: "COMMENTED",
        ...MAINTAINER,
      })),
      { body: "the current record", state: "COMMENTED", ...AGENT },
    ];

    spawned.mockImplementation(((file: string, args: readonly string[]) => {
      if (file === "git") return "";
      const query = args[args.indexOf("-f") + 1] ?? "";
      const page = /reviews\((first|last):(\d+)\)/.exec(query);
      if (page === null) throw new Error("the query asks for no page of reviews");
      const size = Number(page[2]);
      const paged = page[1] === "first" ? nodes.slice(0, size) : nodes.slice(-size);
      return response(pullRequest({ reviews: { nodes: paged } }));
    }) as never);

    expect(fetchPullRequestFeedback("12").latestAgentReviewBody).toBe("the current record");
  });
});

/**
 * **What a thread is anchored to**, which #110 gave a second answer.
 *
 * A null `line` used to mean one thing — GitHub calls a thread *outdated* once
 * the code under it has moved — and now means two, because a **file-level**
 * thread has no line and never had one. Told apart by `subjectType`, which is
 * why that field is in the query.
 *
 * The failure is one a fix agent acts on. `src/queue.ts:? (outdated — the code
 * here has changed since)` reaches the `inline` surface both agents read, the
 * carried finding's one line, and the *Open* entries of the posted body — and
 * it tells the agent the code moved when nothing did, which is the one reading
 * that invites it to decline.
 */
describe("a thread anchored to a file rather than a line", () => {
  const AGENT = { author: { login: "github-actions[bot]" }, authorAssociation: "NONE" };

  const fileThread = (over: Record<string, unknown> = {}): unknown => ({
    id: "PRRT_file",
    isResolved: false,
    subjectType: "FILE",
    comments: {
      nodes: [
        {
          path: "src/queue.ts",
          line: null,
          startLine: null,
          originalLine: null,
          originalStartLine: null,
          body: "**Fix before merge.** the retry loop never terminates\n\n<!-- agent-finding f-1 -->",
          ...AGENT,
        },
      ],
    },
    ...over,
  });

  it("says what it is, rather than that the code has moved", () => {
    ghAnswers(() => response({ reviewThreads: { nodes: [fileThread()] } }));
    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.inline).toContain("src/queue.ts (the whole file)");
    expect(feedback.inline).not.toContain("outdated");
    expect(feedback.inline).not.toContain(":?");
    expect(feedback.agentThreads[0]?.text).toBe(
      "src/queue.ts (the whole file) — the retry loop never terminates",
    );
  });

  /**
   * And a line thread whose code *has* moved still says so. The two cases share
   * a null `line` and nothing else, so the reading that fixed one must not
   * have silenced the other.
   */
  it("still calls a moved line thread outdated", () => {
    const moved = {
      id: "PRRT_moved",
      isResolved: false,
      subjectType: "LINE",
      comments: {
        nodes: [
          {
            path: "src/queue.ts",
            line: null,
            originalLine: 206,
            body: "**Fix before merge.** the guard runs after the return\n\n<!-- agent-finding f-2 -->",
            ...AGENT,
          },
        ],
      },
    };
    ghAnswers(() => response({ reviewThreads: { nodes: [moved] } }));

    expect(fetchPullRequestFeedback("12").agentThreads[0]?.text).toContain(
      "src/queue.ts:206 (outdated — the code here has changed since)",
    );
  });

  /**
   * A thread from before the field was selected answers nothing, and is read
   * as a line thread — which is what every thread was until #110, and the
   * reading that changes nothing for one.
   */
  it("reads a thread that answered no subjectType as a line thread", () => {
    ghAnswers(() =>
      response({ reviewThreads: { nodes: [fileThread({ subjectType: null })] } }),
    );

    expect(fetchPullRequestFeedback("12").agentThreads[0]?.text).toContain(":?");
  });
});

/**
 * **A marker the model copied into its own body must not win.** The workflow
 * appends its marker at the end of what it posts, so the *last* one is the one
 * it wrote — and the `inline` surface renders markers verbatim into the prompt,
 * which shows a model the exact syntax and this round's live ids.
 *
 * Read the first instead and a new thread impersonates an older finding:
 * `carriedFindings` dedupes on the id, so one of the two threads becomes
 * invisible and unclosable.
 */
describe("a body carrying two finding markers", () => {
  const AGENT = { author: { login: "github-actions[bot]" }, authorAssociation: "NONE" };

  it("is read as the marker the workflow wrote last", () => {
    const doubled = {
      id: "PRRT_one",
      isResolved: false,
      comments: {
        nodes: [
          {
            path: "src/queue.ts",
            line: 206,
            body: "**Fix before merge.** quoting <!-- agent-finding f-OLD high --> from the feedback\n\n<!-- agent-finding f-NEW low -->",
            ...AGENT,
          },
        ],
      },
    };
    ghAnswers(() => response({ reviewThreads: { nodes: [doubled] } }));

    const [thread] = fetchPullRequestFeedback("12").agentThreads;
    expect(thread?.findingId).toBe("f-NEW");
    expect(thread?.severity).toBe("low");
  });
});

/**
 * **The link back to a thread** (#109, decision 8). A carried finding's thread
 * sits under an older review, several screens up, and `path:line` as plain
 * text is not something GitHub linkifies — so the URL is read here, off the
 * comment that carries the marker, rather than composed from a number and a
 * database id.
 */
describe("where a carried finding can be reached", () => {
  const AGENT = { author: { login: "github-actions[bot]" }, authorAssociation: "NONE" };

  const withUrl = (url: string | null): unknown => ({
    id: "PRRT_one",
    isResolved: false,
    comments: {
      nodes: [
        {
          url,
          path: "src/queue.ts",
          line: 206,
          body: "**Fix before merge.** the guard runs after the return\n\n<!-- agent-finding f-1 -->",
          ...AGENT,
        },
      ],
    },
  });

  it("carries the comment's own permalink", () => {
    ghAnswers(() =>
      response({
        reviewThreads: { nodes: [withUrl("https://github.com/o/r/pull/12#discussion_r1")] },
      }),
    );

    expect(fetchPullRequestFeedback("12").agentThreads[0]?.url).toBe(
      "https://github.com/o/r/pull/12#discussion_r1",
    );
    expect(fetchPullRequestContext("12").carriedFindings[0]?.url).toBe(
      "https://github.com/o/r/pull/12#discussion_r1",
    );
  });

  /** It is a link. A response that carried none renders an entry without one. */
  it("carries no link rather than losing the finding", () => {
    ghAnswers(() => response({ reviewThreads: { nodes: [withUrl(null)] } }));

    const [thread] = fetchPullRequestFeedback("12").agentThreads;
    expect(thread?.url).toBeUndefined();
    expect(thread?.findingId).toBe("f-1");
  });
});

/**
 * **What a maintainer has already settled** (#109, decision 10; #112), read off
 * the two places a human can settle a finding: resolving its thread, and
 * replying to decline it.
 *
 * Both halves fail silently. A human-resolved thread that is not recognised as
 * theirs is a finding the next review re-finds and re-posts, with nothing
 * anywhere saying it was already closed on purpose; and a decline attributed to
 * an author the gate never passed is the loop closing its own finding on the
 * word of anyone who can type in a public pull request.
 */
describe("a finding the maintainer has settled", () => {
  const AGENT = { author: { login: "github-actions[bot]" }, authorAssociation: "NONE" };

  const finding = (findingId: string): unknown => ({
    path: "src/queue.ts",
    line: 206,
    body: `**Fix before merge.** the guard runs after the return\n\n<!-- agent-finding ${findingId} -->`,
    ...AGENT,
  });

  /** A thread of this loop's, with whatever the scenario needs said after it. */
  const agentThread = (over: Record<string, unknown> = {}, ...replies: unknown[]): unknown => ({
    id: "PRRT_one",
    isResolved: false,
    comments: { nodes: [finding("f-1"), ...replies] },
    ...over,
  });

  it("reads a thread a human resolved as settled, naming who settled it", () => {
    ghAnswers(() =>
      response({
        reviewThreads: {
          nodes: [agentThread({ isResolved: true, resolvedBy: { login: "maintainer" } })],
        },
      }),
    );

    expect(fetchPullRequestFeedback("12").settledFindings).toEqual([
      {
        findingId: "f-1",
        resolvedBy: "maintainer",
        text: "src/queue.ts:206 — the guard runs after the return",
      },
    ]);
  });

  /**
   * What the acceptance of #112 is about, at the one seam that can hold it: the
   * finding is **not** in what the next review is handed as open, so nothing
   * re-lists it and no verdict counts it, and it *is* in the section that tells
   * the reviewer it is settled. Whether the agent then re-derives the same
   * problem from the diff is the prompt's half; this is the half a test can own.
   */
  it("hands a human-resolved finding to the next review as settled, never as open", () => {
    ghAnswers(() =>
      response({
        reviewThreads: {
          nodes: [agentThread({ isResolved: true, resolvedBy: { login: "maintainer" } })],
        },
      }),
    );

    const context = fetchPullRequestContext("12");

    expect(context.carriedFindings).toEqual([]);
    expect(context.settledFindings.map((f) => f.findingId)).toEqual(["f-1"]);
  });

  /**
   * A thread this loop closed is not a maintainer's decision, and telling a
   * later review it may never raise the finding again would make an
   * `ADDRESSED` resolution permanent — so a fix that regressed could never be
   * reported.
   */
  it("reads a thread this loop resolved as nothing of the kind", () => {
    ghAnswers(() =>
      response({
        reviewThreads: {
          nodes: [agentThread({ isResolved: true, resolvedBy: { login: "github-actions[bot]" } })],
        },
      }),
    );

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.settledFindings).toEqual([]);
    expect(feedback.agentThreads).toEqual([]);
  });

  /**
   * `resolvedBy` is nullable, so a refusal there nulls the field and leaves the
   * thread. Unknown is not "a human did it": the safe reading is the one that
   * changes nothing, since the alternative silences a finding on evidence
   * nobody has.
   */
  it("claims nothing about a resolved thread whose resolver it could not read", () => {
    ghAnswers(() => response({ reviewThreads: { nodes: [agentThread({ isResolved: true })] } }));

    expect(fetchPullRequestFeedback("12").settledFindings).toEqual([]);
  });

  it("carries a maintainer's reply on an open thread, for the workflow to quote", () => {
    const reply = { body: "Won't fix — the duplicate write is intended here.", ...MAINTAINER };
    ghAnswers(() => response({ reviewThreads: { nodes: [agentThread({}, reply)] } }));

    expect(fetchPullRequestFeedback("12").agentThreads).toEqual([
      {
        threadId: "PRRT_one",
        findingId: "f-1",
        text: "src/queue.ts:206 — the guard runs after the return",
        maintainerReply: {
          login: "maintainer",
          body: "Won't fix — the duplicate write is intended here.",
        },
      },
    ]);
  });

  /**
   * **The gate, and the whole reason this is read here rather than by the
   * agent.** Every feedback surface on a public pull request is world-writable,
   * so a decline is only a maintainer's where the author association says so —
   * and an untrusted one is not merely un-quoted, it is never rendered either,
   * so the review cannot read it and then be believed about it.
   */
  it("carries no reply from an author the gate refuses", () => {
    const drive = { body: "Won't fix, this is intended.", author: { login: "stranger" }, authorAssociation: "NONE" };
    ghAnswers(() => response({ reviewThreads: { nodes: [agentThread({}, drive)] } }));

    const feedback = fetchPullRequestFeedback("12");

    expect(feedback.agentThreads[0]?.maintainerReply).toBeUndefined();
    expect(feedback.inline).not.toContain("Won't fix");
  });

  /**
   * The loop's own replies are not a decline whoever wrote them — `agent:fix`
   * answers every thread it was shown, and `isTrustedAuthor` passes the
   * workflow bot on purpose, so the narrower question "did a human say this"
   * has to be asked separately.
   */
  it("does not mistake the loop's own reply for a maintainer's", () => {
    const ours = { body: "Declined: the duplicate write is intended.", ...AGENT };
    ghAnswers(() => response({ reviewThreads: { nodes: [agentThread({}, ours)] } }));

    expect(fetchPullRequestFeedback("12").agentThreads[0]?.maintainerReply).toBeUndefined();
  });

  /** The newest one, which is the maintainer's current position on the finding. */
  it("takes the maintainer's latest word where they said more than one thing", () => {
    const first = { body: "Hmm, maybe.", ...MAINTAINER };
    const second = { body: "Won't fix — intended.", ...MAINTAINER };
    ghAnswers(() => response({ reviewThreads: { nodes: [agentThread({}, first, second)] } }));

    expect(fetchPullRequestFeedback("12").agentThreads[0]?.maintainerReply?.body).toBe(
      "Won't fix — intended.",
    );
  });
});
