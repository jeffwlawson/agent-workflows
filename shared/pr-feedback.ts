import { fail, ghOutcome, git, isTrustedAuthor, isWorkflowBot, type GhOutcome } from "./common.js";
import { parseNameStatus } from "./diff-lines.js";
import {
  isAgentConversationOutcome,
  isAgentTopLevelComment,
  type ConversationComment,
} from "./fix-output.js";
import {
  lastFindingMarker,
  openingClaim,
  withSeverityBadgesAsText,
  type Severity,
} from "./review-findings.js";
import {
  closingReplyReason,
  type AgentThread,
  type MaintainerReply,
  type ResolutionReason,
  type SettledFinding,
} from "./review-verification.js";

/**
 * The three rendered feedback surfaces, named the same as the fields carrying
 * them below — so `surfaceText` can ask for one by name and get its text, its
 * refusal or "(none)".
 */
export type FeedbackSurface = "summaries" | "inline" | "conversation";

const ALL_SURFACES: readonly FeedbackSurface[] = ["summaries", "inline", "conversation"];

/**
 * How the one round trip went. Three answers, and the whole point is that no
 * two of them collapse into one:
 *
 * - `ok` — the response carried no errors. An empty surface is genuinely empty.
 * - `partial` — `200` with valid `data` **and** an `errors[]` array. Some
 *   selections answered and at least one did not; `unreadable` says which.
 * - `failed` — nothing usable came back at all (network, bad token, malformed
 *   JSON, or a query that resolved no pull request). Not "no feedback": no
 *   answer.
 */
export type FeedbackStatus = "ok" | "partial" | "failed";

/** A selection the API would not answer, and what its absence costs. */
export interface UnreadableSelection {
  /** The GraphQL path, dotted — `repository.pullRequest.reviews`. */
  readonly path: string;
  /** What the API said, type and message — `FORBIDDEN: Resource not accessible`. */
  readonly reason: string;
  /**
   * The rendered surfaces this takes out. Empty where the path maps to none of
   * them, which means the selection is not one of the three feedback surfaces
   * rather than that nothing was lost.
   *
   * Read from the path only where the pull request itself resolved. It did not
   * on `failed`, so nothing was read whatever any one error named, and every
   * entry there covers every surface.
   */
  readonly surfaces: readonly FeedbackSurface[];
  /**
   * True when what could not be read is something the **author gate** depends
   * on — the `author` / `authorAssociation` fields `isTrustedAuthor` is given,
   * or a selection nothing here can place, which is the same statement made
   * cautiously.
   *
   * The caution is deliberate and is the fail-closed half of #76: an unplaceable
   * selection is one this file was not taught about, so "it cannot matter to
   * trust" is a claim it is in no position to make. `collaborators(login:)` —
   * the selection under consideration at #73 — is exactly that shape, and it
   * arrives as a sibling of `pullRequest` rather than under it.
   */
  readonly trustBearing: boolean;
}

export interface PullRequestFeedback {
  /** Bodies of submitted reviews (the reviewer's overall note). */
  readonly summaries: string;
  /**
   * Comments in *unresolved* review threads, anchored to file + line, replies
   * included. A thread already carrying this workflow's closing reply, with no
   * human word after it, is rendered like any other, under a line saying what
   * is actually outstanding on it — the close, not a fix (#133).
   */
  readonly inline: string;
  /**
   * Top-level conversation comments on the PR, **excluding** the ones
   * `agent:fix` posted itself (see `TOP_LEVEL_COMMENT_MARKER`).
   */
  readonly conversation: string;
  /** All of the above rendered as one block, or "" when there is none. */
  readonly all: string;
  /**
   * Node ids of the unresolved threads a fix run is **asked to answer**. What
   * `filterOutcomes` keeps an outcome for, and so the whole of what can receive
   * a reply.
   *
   * Not every thread `inline` renders: one already carrying this workflow's
   * closing reply is shown for its evidence and left out of here (#133). A fix
   * run owes an outcome on every thread it is asked about and the workflow
   * posts each of them as this same bot, so leaving such a thread in this list
   * was one further comment on it per round — the pile-up the review half is
   * already capped against, arriving through the other half.
   */
  readonly threadIds: readonly string[];
  /**
   * The top-level conversation comments a fix run is **asked to answer**, each
   * with the id an outcome on it names and the author and permalink the record
   * of that outcome is written from (#104).
   *
   * Not every comment `conversation` renders, for the reason `threadIds` is not
   * every thread `inline` renders: a note **this loop posted itself** is shown
   * for its evidence and left out of here (#159). The marked kinds never reach
   * the render at all; the unmarked ones — a refusal, a failure comment, a
   * "no re-review will start" warning — are evidence a fix run may need, and
   * are nobody's instruction. An outcome on one is dropped rather than posted
   * (see `filterConversationOutcomes`), which is what stops the agent
   * publishing *Addressed — @github-actions's comment* about the loop's own
   * status note.
   */
  readonly conversationComments: readonly ConversationComment[];
  /**
   * The unresolved threads **this loop opened**, each with the finding id the
   * workflow wrote into it (#110) — the open half of the review record a later
   * review verifies against (#111).
   *
   * Neither a subset of `threadIds` nor a replacement for it: the fix runner
   * answers the threads it is asked about, a human's included, while only the
   * loop's own threads carry a finding a review can rule on. A thread already
   * holding its closing reply is in this list and not in that one — the review
   * still rules on it, and `closedAs` is what makes that ruling retry the
   * resolve rather than reply a second time (#133).
   */
  readonly agentThreads: readonly AgentThread[];
  /**
   * The findings on this pull request a **human** has closed — threads this
   * loop opened whose `resolvedBy` is somebody other than the workflow bot
   * (#109, decision 10; #112).
   *
   * Disjoint from `agentThreads` by construction, which is what the pair is
   * for: one is what a review is asked to rule on, the other what it is told
   * not to raise again. A resolved thread used to be dropped here and nowhere
   * recorded, so a maintainer's decision survived exactly as long as no later
   * review happened to re-derive the finding from the diff.
   */
  readonly settledFindings: readonly SettledFinding[];
  /**
   * The body of the **latest** review this loop posted, or `""` when it has
   * posted none.
   *
   * The current statement of what is open, rather than one of several: each
   * review re-lists the findings it verified as still open, so the newest body
   * supersedes the one before it. Returned whole rather than parsed, because
   * what a reader wants out of it differs by caller and the format is
   * `shared/review-findings.ts`'s to describe.
   */
  readonly latestAgentReviewBody: string;
  /**
   * Bodies of the top-level comments `agent:fix` already posted on this PR —
   * kept out of every rendered surface above, and returned only so a new run
   * can avoid posting the same note twice.
   */
  readonly priorTopLevelComments: readonly string[];
  /** Diff of the branch against the PR's base branch merge-base (three-dot). */
  readonly diff: string;
  /**
   * Every file that diff changes, read from git's machine format rather than
   * out of the patch (`parseNameStatus`). What decides which files a finding
   * can be anchored in; see `keyedByChangedFiles`.
   */
  readonly changedFiles: readonly string[];
  /**
   * False when nothing trusted was rendered **that a fix run could act on** —
   * a review summary, a thread in `threadIds` or a comment in
   * `conversationComments` (#160). A thread awaiting its close and this loop's
   * own status notes are rendered and do not count. Deliberately not the whole
   * question any more: it cannot tell "every surface answered and had nothing"
   * from "a surface was refused", and those two want opposite actions. Read it
   * alongside `status` and `unreadable` — or through `refusalReason`, which
   * holds the four-way decision in one place.
   */
  readonly hasFeedback: boolean;
  /** Whether the response was whole, partial, or no answer at all. */
  readonly status: FeedbackStatus;
  /** Every selection the API refused, in the order it reported them. Empty on `ok`. */
  readonly unreadable: readonly UnreadableSelection[];
}

/**
 * One query for every feedback surface a PR has: conversation comments, review
 * summaries, and review threads (whose `comments` include replies). Doing it in
 * a single GraphQL round trip — rather than three REST calls — is what makes
 * `isResolved` available, which REST does not expose at all.
 *
 * One round trip also means one *partial* answer: a selection added here that
 * the token may not read comes back as an entry in `errors[]` beside data that
 * is fine (#76). So a selection added to this query is a row added to
 * `SURFACE_OF_SELECTION` in the same change — without one, an error on it is
 * unplaceable, which is read as trust-bearing and makes the run refuse.
 *
 * `reviews` is the one selection taken from the **end** of its connection
 * (#127, decision 4; #125). GitHub returns reviews oldest-first, so `first:50`
 * on a pull request with more than fifty of them returns the fifty *oldest* —
 * and `latestAgentReviewBody` below, reading the last node of that page, hands
 * every later round the findings record of a review from long ago. Past the
 * fiftieth review that is not a stale link but a resurrection: findings later
 * rounds closed come back as still open, by id, with nothing on the pull
 * request to say why. `last:` is the cheap half of decision 4 — the same one
 * page, taken from the end — and it improves the rendered summaries for the
 * same reason, since the newest fifty are the ones a reviewer needs.
 *
 * That refusal is loud about an omission and silent about a **rename**: alias a
 * selection here, or follow a field of GitHub's that moves, and the query keeps
 * working while every error under it arrives unplaceable — a run refused on the
 * author gate, naming a selection the map has never heard of, for a query with
 * nothing wrong with it. So the transcription is checked against this string
 * rather than trusted to it: `tests/pr-feedback.test.ts` reads it and puts every
 * path it could produce through `classify`, and fails by name on either.
 */
const QUERY = `
query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      comments(first:100) { nodes { id url body author { login } authorAssociation } }
      reviews(last:50) { nodes { body state author { login } authorAssociation } }
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          subjectType
          resolvedBy { login }
          comments(first:50) {
            nodes {
              url path line startLine originalLine originalStartLine
              body author { login } authorAssociation
            }
          }
        }
      }
    }
  }
}`;

interface GqlAuthored {
  body?: string | null;
  author?: { login?: string } | null;
  authorAssociation?: string;
}
/**
 * A top-level conversation comment. `id` is what an outcome on it is keyed to
 * and `url` is what the record links, both read from GitHub rather than composed
 * here for the reason `GqlThreadComment.url` is.
 *
 * Both are `| null` though the schema marks `IssueComment.id` non-null, which is
 * the same width every field here carries: this reads a payload it did not type,
 * and a reader that trusts a non-null marking throws where it meant to report
 * (#76).
 */
interface GqlComment extends GqlAuthored {
  id?: string | null;
  url?: string | null;
}

interface GqlThreadComment extends GqlAuthored {
  /**
   * The comment's own permalink, which is what a record entry links to. Read
   * here rather than composed from the pull request number and a database id:
   * a link this file built would be a second description of a URL GitHub
   * already returns, and a wrong one lands a reader on the wrong thread.
   */
  url?: string | null;
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
}

interface GqlThread {
  id?: string;
  isResolved?: boolean;
  /**
   * `LINE` or `FILE` — what the thread is attached to, and the only thing that
   * tells a **file-level** thread's absent line from an *outdated* one's (#110
   * opened threads on files, and `anchorOf` below read a null `line` as the
   * code having moved).
   *
   * Nullable in this type for the reason `resolvedBy` is: a release before
   * this one selected no such field, and a refusal on it nulls the field
   * rather than the thread. Unknown is read as `LINE`, which is what every
   * thread was until #110 and is the reading that changes nothing for one.
   */
  subjectType?: string | null;
  /**
   * Who closed it, and the whole of what decision 10 turns on: a thread this
   * loop resolved is a finding it verified, and one anybody else resolved is a
   * finding a human settled (#112).
   *
   * `PullRequestReviewThread.resolvedBy: Actor` is **nullable**, so it is null
   * on an open thread and null again where an error on it null-propagated no
   * further than the field — the thread and its comments survive either way.
   * Those two are not told apart here and do not need to be: the reader below
   * treats an unknown resolver as *not established*, which on an open thread
   * is the truth and on a refused field is the reading that changes nothing.
   */
  resolvedBy?: { login?: string } | null;
  comments?: { nodes?: (GqlThreadComment | null)[] | null } | null;
}

/**
 * The connections, with **nullable elements** — which is what GitHub's schema
 * says and what a partial error actually produces.
 *
 * `nodes: [IssueComment]` nulls per element, and the fields the author gate
 * reads do not: `authorAssociation: CommentAuthorAssociation!`. A field error
 * on one of those null-propagates up to the nearest nullable parent, which is
 * the element — `comments: { nodes: [null, {…}] }` beside an entry in
 * `errors[]` naming `…comments.nodes.0.authorAssociation`. Typing the elements
 * as non-null is a claim the response does not support, and TypeScript would
 * then let a `null` reach `isTrustedAuthor` unchecked.
 *
 * **Where a refusal surfaces is decided by that same propagation, and it is not
 * uniform across the three.** From the published schema
 * (`docs.github.com/public/fpt/schema.docs.graphql`):
 *
 * - `PullRequest.comments: IssueCommentConnection!` and
 *   `PullRequest.reviewThreads: PullRequestReviewThreadConnection!` are
 *   **non-null**, so an error on either propagates past them to the nearest
 *   nullable ancestor — `Repository.pullRequest`, which is nullable. A token
 *   forbidden one of those two gets `pullRequest: null`, which `readResponse`
 *   rules `failed`. It never gets that connection nulled beside populated
 *   siblings.
 * - `PullRequest.reviews: PullRequestReviewConnection` is **nullable**, so it
 *   is the one selection here whose whole connection can go missing while the
 *   other two answer. That is the shape `partial` was built for at the
 *   connection level.
 * - Below the connections it is the elements that absorb it, per the paragraph
 *   above — `PullRequestReviewThread.comments` is non-null too, so an error
 *   there nulls the thread rather than the list. That is how `comments` and
 *   `reviewThreads` reach `partial`: through a hole in the list, not an absent
 *   connection.
 *
 * The `| null` on each connection below is therefore wider than the schema, and
 * stays: this reads a payload it did not type, and a reader that trusts a
 * non-null marking throws where it meant to report (#76).
 */
interface GqlPullRequest {
  comments?: { nodes?: (GqlComment | null)[] | null } | null;
  reviews?: { nodes?: ((GqlAuthored & { state?: string }) | null)[] | null } | null;
  reviewThreads?: { nodes?: (GqlThread | null)[] | null } | null;
}

/** One entry of a GraphQL `errors[]` array. `path` is absent on an error that names no selection. */
interface GqlError {
  message?: string;
  type?: string;
  path?: (string | number)[];
}

interface GqlResponse {
  data?: { repository?: { pullRequest?: GqlPullRequest | null } | null } | null;
  errors?: GqlError[];
}

/** Which selection of the query renders which surface. The map `classify` rules on. */
const SURFACE_OF_SELECTION: Record<string, FeedbackSurface> = {
  comments: "conversation",
  reviews: "summaries",
  reviewThreads: "inline",
};

/**
 * The fields `isTrustedAuthor` is given. An error on one of these is an error on
 * the gate. Transcribed from `QUERY` as the map above is, and held to it the
 * same way — but per selection set rather than across the query, because both
 * are selected three times over: a body the query asks for without these two
 * beside it fails the build, rather than reaching the gate with an association
 * it cannot read and an error on one classified as harmless.
 */
const GATE_FIELDS = new Set(["author", "authorAssociation"]);

const EVERYTHING = { surfaces: ALL_SURFACES, trustBearing: true } as const;
const UNPLACEABLE = { surfaces: [] as readonly FeedbackSurface[], trustBearing: true } as const;

/**
 * What an errored path costs, by reading the path.
 *
 * Three answers, and the default is the cautious one. A path under a selection
 * this map knows costs that one surface, and is trust-bearing only where the
 * error reaches one of the gate's own fields. A path that stops short of a
 * selection — `repository`, `repository.pullRequest`, or no path at all — costs
 * every surface. Anything else is **unplaceable**: a selection added to the
 * query and not added here, or one that is not a feedback surface at all. Those
 * count as trust-bearing, so a new permission-bearing selection is fail-closed
 * on arrival rather than after someone notices.
 *
 * That last rule is why this map is a fixed list rather than a derivation: a
 * surface added to `QUERY` is a row added here in the same change, exactly as a
 * new pin site is a change to `shared/pins.ts` in the same commit. Leaving it
 * out does not go unnoticed — it makes the new surface refuse, and a test that
 * reads `QUERY` fails on it by name, which is the half refusing cannot do for a
 * selection merely *renamed*.
 */
const classify = (
  segments: readonly string[],
): { readonly surfaces: readonly FeedbackSurface[]; readonly trustBearing: boolean } => {
  const [root, pullRequestField, selection, ...rest] = segments;

  if (root === undefined) return EVERYTHING;
  if (root !== "repository") return UNPLACEABLE;
  if (pullRequestField === undefined) return EVERYTHING;
  if (pullRequestField !== "pullRequest") return UNPLACEABLE;
  if (selection === undefined) return EVERYTHING;

  // Asked for as an **own** key rather than by indexing. An object literal
  // inherits `Object.prototype`, so `SURFACE_OF_SELECTION["toString"]` is a
  // function rather than `undefined` — and a path segment named `toString`,
  // `constructor`, `valueOf` or `__proto__` would skip `UNPLACEABLE` and come
  // back trust-bearing only if it also named a gate field. That is the rule
  // above inverted, in the one lookup here that reads a key out of a payload
  // this file did not type. No selection in `QUERY` is called any of those
  // today; nothing makes that a property of the reader rather than of the
  // query.
  const surface = Object.hasOwn(SURFACE_OF_SELECTION, selection)
    ? SURFACE_OF_SELECTION[selection]
    : undefined;
  if (surface === undefined) return UNPLACEABLE;

  return { surfaces: [surface], trustBearing: rest.some((segment) => GATE_FIELDS.has(segment)) };
};

/** An error that names no selection: nothing can be placed, so everything is unknown. */
const UNLOCATED = "(the error names no selection)";

const asUnreadable = (error: GqlError): UnreadableSelection => {
  const segments = (Array.isArray(error.path) ? error.path : []).map(String);
  const message = typeof error.message === "string" ? error.message.trim() : "no message given";

  return {
    path: segments.length > 0 ? segments.join(".") : UNLOCATED,
    reason: error.type ? `${error.type}: ${message}` : message,
    ...classify(segments),
  };
};

/** The query as a whole, for the case where no part of the response can be placed. */
const WHOLE_QUERY = "(the whole query)";

/** Said where a response resolved no pull request and offered no error explaining it. */
const NO_PULL_REQUEST = "the response resolved no pull request and said nothing about why";

/**
 * What `gh` said about a failure, in as few words as it used — or what Node
 * said, when the run failed around `gh` rather than in it. That is preferred
 * over both streams: a binary that never ran printed nothing, and one cut off at
 * the buffer printed JSON that stops mid-token (#131).
 */
const spokenReason = (outcome: GhOutcome): string => {
  const said = [outcome.spawnError ?? "", outcome.stderr, outcome.stdout]
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  if (said === undefined) return "gh produced no output at all";

  return said
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join(" ")
    .slice(0, 300);
};

/**
 * The state where **nothing was read**, however the response chose to say so.
 *
 * Each error keeps its path and its words — that is what names the cause for a
 * human — and loses its classification: a path is only evidence about *which*
 * surface when the surfaces around it were read, and here none were. So every
 * entry covers every surface and counts as trust-bearing, which is the same
 * fact stated twice: nothing rendered, and the author gate established nothing
 * either. An error that says nothing at all still has to leave a sentence
 * behind, hence the fallback.
 */
const nothingWasRead = (
  errors: readonly GqlError[],
  fallbackReason: string,
): {
  readonly pr: undefined;
  readonly status: FeedbackStatus;
  readonly unreadable: readonly UnreadableSelection[];
} => ({
  pr: undefined,
  status: "failed",
  unreadable:
    errors.length > 0
      ? errors.map(asUnreadable).map((selection) => ({
          ...selection,
          surfaces: ALL_SURFACES,
          trustBearing: true,
        }))
      : [
          {
            path: WHOLE_QUERY,
            reason: fallbackReason,
            surfaces: ALL_SURFACES,
            trustBearing: true,
          },
        ],
});

/**
 * Read the response, not the exit code.
 *
 * `gh` exits non-zero on a partial-error response while printing valid `data`
 * to stdout, so an exit code alone cannot tell a forbidden selection from an
 * unreachable API — and the old `try`/`catch` around a throwing `gh` read it as
 * the second and discarded everything that had returned (#76). What decides
 * here is whether the payload parses and what it holds.
 */
const readResponse = (
  outcome: GhOutcome,
): {
  readonly pr: GqlPullRequest | undefined;
  readonly status: FeedbackStatus;
  readonly unreadable: readonly UnreadableSelection[];
} => {
  let parsed: GqlResponse | undefined;
  try {
    const value: unknown = JSON.parse(outcome.stdout);
    parsed = typeof value === "object" && value !== null ? (value as GqlResponse) : undefined;
  } catch {
    parsed = undefined;
  }

  // Every shape below is read defensively rather than trusted to the interface:
  // this runs on whatever came back, and a response malformed enough to throw
  // here would be reported as the runner crashing rather than as the API
  // answering badly — the substitution this whole change is about.
  const errors = (Array.isArray(parsed?.errors) ? parsed.errors : []).filter(
    (error): error is GqlError => typeof error === "object" && error !== null,
  );
  const hasData = typeof parsed?.data === "object" && parsed.data !== null;

  // No answer at all — three ways in: nothing parseable, a response carrying no
  // `data` object (which is a whole-query failure however it is explained), and
  // a non-zero exit the payload does not account for. The errors, where there
  // are any, say more than `gh`'s stderr does.
  const noAnswer = parsed === undefined || !hasData || (errors.length === 0 && !outcome.ok);
  if (noAnswer) return nothingWasRead(errors, spokenReason(outcome));

  const pr = parsed?.data?.repository?.pullRequest ?? undefined;

  // The pull request did not resolve, so **no surface was read** — whatever any
  // individual error happened to name. That is the invariant, and it holds
  // without knowing a thing about the schema: every feedback selection in this
  // query is a child of `pullRequest`, so a null one leaves all three unread
  // rather than answered-and-empty.
  //
  // It decides a shape that otherwise lands in `partial` and misleads both
  // consumers. GitHub reports an invisible or absent pull request as `data`
  // present, the leaf nulled, an entry in `errors[]` — and where that entry is
  // *confined* to one selection (`…pullRequest.comments`), classifying it by its
  // path would hand the review agent one named selection above an empty
  // discussion, which reads as "the other two answered and nobody commented".
  // #76 one level up. Read as `partial` it also refuses through the *gate*
  // branch, naming a cause — "a selection the author gate depends on" — that has
  // nothing to do with "the pull request is not visible to this token".
  if (pr === undefined) return nothingWasRead(errors, NO_PULL_REQUEST);

  return { pr, status: errors.length > 0 ? "partial" : "ok", unreadable: errors.map(asUnreadable) };
};

const SURFACE_LABELS: Record<FeedbackSurface, string> = {
  summaries: "review summaries",
  inline: "unresolved review threads",
  conversation: "conversation comments",
};

/** Unreadable selections as one line: what was refused, why, and what it took out. */
export const describeUnreadable = (unreadable: readonly UnreadableSelection[]): string =>
  unreadable
    .map(
      (selection) =>
        `\`${selection.path}\` · ${selection.reason}` +
        (selection.surfaces.length === 0
          ? ""
          : ` (${selection.surfaces.map((surface) => SURFACE_LABELS[surface]).join(", ")})`),
    )
    .join("; ");

/**
 * The preamble, which is **two different statements** and must not be one.
 *
 * A refusal that renders one of the three surfaces makes that surface unknown
 * rather than empty, and that is the thing the agent has to be told. A refusal
 * that renders none of them — `repository.collaborators`, the selection #73 is
 * about, which arrives as a sibling of `pullRequest` — takes nothing out of what
 * is shown: all three answered in full, and telling the agent otherwise is the
 * one-sentence-two-facts collapse this change exists to take apart, now aimed
 * the other way. It is still said, because a refused selection is worth knowing
 * about and is what makes the run that *pushes* stop; it is just not a caveat on
 * the feedback below it.
 *
 * The per-entry lines already make this distinction by dropping the surface
 * suffix where none is named. Only the preamble generalised over both.
 */
const notePreamble = (unreadable: readonly UnreadableSelection[]): string =>
  unreadable.some((selection) => selection.surfaces.length > 0)
    ? "Part of the query behind this pull request's own feedback (its review summaries, " +
      "unresolved review threads and conversation comments) was refused, so what it " +
      "covers is **unknown** rather than empty. That holds whether the affected section " +
      "is short or missing entirely: do not read its absence as agreement, and say so in " +
      "your output if it matters to a conclusion you would otherwise draw."
    : "Part of the same query was refused, but none of it renders this pull request's " +
      "feedback: the review summaries, unresolved review threads and conversation comments " +
      "you were shown are what the API returned, in full. It is named here because a " +
      "refusal is worth knowing about, not as a caveat on anything below.";

/**
 * The same thing as a block for a prompt — for the consumer that **degrades**
 * rather than refusing. A review proceeds on what survived, so the gap has to
 * be visible in the context the agent is handed: an absent section reads as
 * agreement, and the agent would silently repeat work a human already commented
 * on. Empty when everything was readable, so nothing is said on the normal path.
 *
 * It names what it is a caveat on rather than saying "above". A note that points
 * at its own position is wrong the moment something is rendered after it, and
 * where nothing rendered at all it points at nothing — which is the case that
 * most needs saying, since an empty feedback section is exactly what a refusal
 * looks like from the agent's side.
 */
export const unreadableNote = (unreadable: readonly UnreadableSelection[]): string =>
  unreadable.length === 0
    ? ""
    : [
        "### Feedback that could not be read",
        "",
        notePreamble(unreadable),
        "",
        ...unreadable.map(
          (selection) =>
            `- \`${selection.path}\`: ${selection.reason}` +
            (selection.surfaces.length === 0
              ? ""
              : ` (${selection.surfaces.map((surface) => SURFACE_LABELS[surface]).join(", ")})`),
        ),
      ].join("\n");

/**
 * One surface as the agent should see it: its text, a named refusal, or
 * "(none)". The distinction is the deliverable — "nothing was said" and "we were
 * not allowed to look" are different facts, and rendering both as "(none)" is
 * the information loss #76 is about, one level down from the fetch.
 *
 * A refusal is said whether or not the surface also rendered something, because
 * a *partly* read surface is the case where silence does the most damage: the
 * agent sees comments, has no reason to doubt the list is complete, and treats
 * the missing ones as absent. Rendering a caveat beside real content is the same
 * rule `unreadableNote` follows for the review context, which appends
 * unconditionally — the two consumers should not disagree about when the agent
 * is told.
 */
export const surfaceText = (feedback: PullRequestFeedback, surface: FeedbackSurface): string => {
  const text = feedback[surface];
  const refused = feedback.unreadable.filter((selection) => selection.surfaces.includes(surface));

  if (refused.length === 0) return text || "(none)";

  const note = describeUnreadable(refused);
  return text
    ? `${text}\n\n---\n\n(part of this section could not be read, so what it covers is unknown rather than absent: ${note})`
    : `(could not be read: ${note})`;
};

/**
 * Why a run that **acts** on this feedback must not proceed, or `undefined` when
 * it may.
 *
 * The doctrine #76 settled, in one place because the four answers are only
 * useful apart: *fail-closed is correct when the gate itself failed, not merely
 * when data was missing*. An empty feedback set is a fine degradation for a
 * re-review; it is not a licence to push commits. So the review context does not
 * call this at all — it degrades and says so — and the fix runner, which holds
 * `contents: write`, refuses with whichever of these applies.
 *
 * Each answer names what a human would have to do about it, because the failure
 * class here is one signature with several causes: "nothing trusted was found"
 * and "one field was forbidden" used to be the same sentence, and only one of
 * them is actionable.
 */
export const refusalReason = (feedback: PullRequestFeedback): string | undefined => {
  if (feedback.status === "failed") {
    return (
      `The pull request's feedback could not be read at all: ${describeUnreadable(feedback.unreadable)}. ` +
      "That is not an empty feedback set, it is no answer. This refuses rather than pushing commits " +
      "without knowing what was asked for."
    );
  }

  const gating = feedback.unreadable.filter((selection) => selection.trustBearing);
  if (gating.length > 0) {
    return (
      `A selection the author gate depends on could not be read: ${describeUnreadable(gating)}. ` +
      "The feedback that did return cannot be placed behind the trust boundary, and this run " +
      "pushes commits, so it refuses rather than acting on feedback whose author it cannot establish."
    );
  }

  if (!feedback.hasFeedback && feedback.unreadable.length > 0) {
    return (
      `Nothing trusted to act on was rendered, and part of the feedback query was refused: ${describeUnreadable(feedback.unreadable)}. ` +
      '"Nothing to act on" and "a selection was refused" are not the same answer, so this refuses as the second.'
    );
  }

  if (!feedback.hasFeedback) {
    return (
      "Nothing from a repo collaborator (or our review agent) that a fix run owes an answer on. " +
      "Deliberately not counted: resolved threads, comments from non-collaborators, a thread " +
      "already carrying this workflow's closing reply (it waits on the review to close it), and " +
      "this loop's own status notes. The last two are shown to a fix run as evidence, not as asks."
    );
  }

  return undefined;
};

/**
 * The `git diff` that defines the PR, as GitHub sees it. GitHub computes a PR's
 * diff against the merge-base of its *base branch*, and the inline-comment
 * allow-list (built from this same diff by `parseDiffLines`) must match exactly:
 * too permissive and GitHub rejects the whole review, too restrictive and
 * legitimate comments are dropped — both surface as a silent, empty review. So
 * the base is the PR's real base, not a hardcoded `main`.
 *
 * Three-dot on purpose: `<base>...HEAD` is changes since the merge-base, which
 * is what GitHub shows. A two-dot diff has different semantics and would
 * silently mis-filter; the fallback to it was deliberately removed once already
 * (see review-context.ts) — do not reintroduce it.
 *
 * `core.quotePath=false` so a non-ASCII path is shown as itself — `café.ts`,
 * not `"caf\303\251.ts"`. The model reads this diff and copies paths out of
 * it, and a finding whose path matches no key is demoted (#127); an escaped
 * spelling is one more way to miss. `parseDiffLines` still undoes quoting,
 * because a `"`, a `\` or a control character is quoted under any setting.
 *
 * Refuses an absent or empty base rather than defaulting to one. It defaulted
 * to `main` until the loop was split into reusable workflows, which is the same
 * silent wrong-branch failure one level down: on a `master` repo every review diffed against a ref that did not
 * exist, and on one that had a stale `main` it diffed against that instead.
 * Every workflow in the loop that runs git against a base — all but
 * `follow-ups.yml` — now sets a non-empty `BASE_REF`, so an empty value is a
 * misconfiguration to say out loud, and `fail()` puts the message on the PR.
 * The three pull-request workflows — `review.yml` and `fix.yml`, whose
 * runners reach this function, and `update-branch.yml` — set it from the event
 * with the `default-branch` input behind it. The two `implement` workflows
 * trigger on `issues`, which carries no base, so they set it from the input
 * alone, and neither runner reaches this function. `tests/workflows.test.ts`
 * holds both forms.
 *
 * Returns argv for `git`, not a command string: `git()` runs `execFileSync`, so
 * `baseRef` arrives as one argument and is never shell-parsed. That matters
 * because a git ref may legally contain `` ` ``, `$()`, `;`, `|` and `&`. This
 * previously carried a "must stay trusted input" warning instead.
 * The input is in fact narrow, and both sources this function can receive are
 * push-gated: a PR's `base.ref` names a branch in the *base* repository, which
 * somebody had to create there, and the `default-branch` input behind it is either set in
 * caller YAML, which `pull_request_target` reads from the base branch, or left
 * to the pinned reusable's `default: main` — a pull request can edit neither.
 * Push access is this input's provenance and nothing wider — it is not the
 * line `isTrustedAuthor` draws over the world-writable feedback surfaces,
 * which admits org-adjacent or better (#68). Neither is what makes this call
 * safe: the argv form is, and it holds however the ref got here.
 */
export const diffCommandAgainstBase = (baseRef: string | undefined): readonly string[] => [
  "-c",
  "core.quotePath=false",
  "diff",
  threeDotRange(baseRef),
];

/**
 * The same diff as `diffCommandAgainstBase`, as the list of files it changes:
 * the same range, so the two cannot describe different changes. `-z` is what
 * makes the list exact — see `parseNameStatus`.
 */
export const changedFilesCommandAgainstBase = (baseRef: string | undefined): readonly string[] => [
  "diff",
  "--name-status",
  "-z",
  threeDotRange(baseRef),
];

/** `<base>...HEAD`, refusing an absent base — the reasons are on `diffCommandAgainstBase`. */
const threeDotRange = (baseRef: string | undefined): string => {
  const base = (baseRef ?? "").trim();
  if (!base) {
    throw new Error(
      "BASE_REF is empty. The workflow sets it from the pull request's base ref, falling back to its `default-branch` input; without it this diff would have to guess a branch, and a wrong guess is a review that silently comments on the wrong lines.",
    );
  }
  return `${base}...HEAD`;
};

/**
 * The three-dot patch, or a refusal that says why there is none (#138).
 *
 * `git()` reads through `execFileSync`'s default buffer, 1 MiB, and a pull
 * request past that — a regenerated lockfile, a vendored directory, a large
 * fixture — made Node throw `spawnSync git ENOBUFS`, which names neither the
 * pull request nor the limit. That overflow, and only that, becomes a refusal
 * through `fail()`: any other git failure is thrown on unchanged, and the diff
 * is never truncated, because a review of part of a change reads as a review
 * of all of it.
 */
const readDiff = (prNumber: string): string => {
  try {
    return git(diffCommandAgainstBase(process.env["BASE_REF"]));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOBUFS") throw error;
    return fail(
      `The diff of pull request #${prNumber} against its base is larger than the 1 MiB this run can read, so the run stopped rather than work from part of it. Split the change, or keep generated and vendored files out of it.`,
    );
  }
};

/**
 * The finding marker a comment carries, or `undefined` for one that carries
 * none — a human's comment, a reply, or a review posted before ids existed.
 *
 * **`lastFindingMarker`, not a reader of this file's own.** This was one, and
 * it disagreed with `parseFindingMarkers` about a line holding two markers:
 * this half took the last, that half took the first, and a line holding two is
 * exactly the line the question matters on. One function, one answer — the
 * last, because the workflow appends its own at the end of what it posts
 * (`threadBody`), so an earlier one is a marker the body quoted.
 *
 * It matters because the `inline` surface renders markers verbatim into the
 * prompt, so a model is shown the exact syntax and the live ids. Read the wrong
 * one and a finding that copied a marker impersonates the finding it copied:
 * two threads on one id, one of them invisible to `carriedFindings` and
 * unclosable.
 *
 * Markers are stripped from every string a model wrote before any of it is
 * posted (`withoutFindingMarkers`, at each output schema), which is the guard
 * this backs up rather than replaces.
 */
const findingIdIn = (body: string): string | undefined => lastFindingMarker(body)?.id;

/**
 * And the severity written beside it, where the marker carries one. Same
 * marker, same reader, same "the last one wins" rule — a finding's rating
 * belongs to the review that raised it, so it is read back rather than
 * re-derived (#109, decision 9).
 */
const findingSeverityIn = (body: string): Severity | undefined =>
  lastFindingMarker(body)?.severity;

/**
 * Whether a thread hangs on a **file** rather than on a line — `subjectType`
 * read back, with the pre-#110 reading for a thread that answered nothing.
 */
const isFileLevel = (thread: { readonly subjectType?: string | null | undefined }): boolean =>
  thread.subjectType === "FILE";

/**
 * Where a thread comment points, and whether that anchor is still live.
 *
 * `line` is null once the code under a comment has changed — GitHub calls this
 * *outdated* and keeps `originalLine` as the position it was written against.
 * Saying so matters: an agent handed a bare line number cannot tell whether it
 * describes today's code or code that has since moved.
 *
 * **A file-level thread has no line and never had one** (#110), so a null
 * `line` acquired a second cause that has nothing to do with the code moving.
 * Told apart by the thread's `subjectType` rather than guessed at from the
 * comment: `src/queue.ts:? (outdated — the code here has changed since)` tells
 * a fix agent the code moved when nothing did, which is the one reading that
 * invites it to decline.
 */
const anchorOf = (c: GqlThreadComment, fileLevel = false): string => {
  if (fileLevel) return `${locationOf(c, fileLevel)} (the whole file)`;

  const outdated = c.line === null || c.line === undefined;
  return `${locationOf(c)}${outdated ? " (outdated: the code here has changed since)" : ""}`;
};

/**
 * The same anchor with no clause: `path:line`, or the path alone for a
 * file-level thread. What a record entry writes as its `— \`path:line\``, where
 * a sentence in a code span would be a sentence in a code span (#134).
 */
const locationOf = (c: GqlThreadComment, fileLevel = false): string => {
  if (fileLevel) return c.path ?? "unknown";

  const end = c.line ?? c.originalLine;
  const start = c.startLine ?? c.originalStartLine;
  const range = start !== null && start !== undefined && start !== end ? `${start}-${end}` : `${end ?? "?"}`;
  return `${c.path ?? "unknown"}:${range}`;
};

/**
 * The finding a thread of this loop's is about: its id, and the one line the
 * review that raised it opened with.
 *
 * Selected by the marker the workflow wrote, and only where the comment
 * carrying it is the workflow bot's. The marker is a **selector, not a
 * control** — anyone who can comment can type one — so what makes a thread the
 * loop's own is who opened it, exactly as it is for the follow-ups block.
 *
 * Shared by the two readers below because they ask the same question of the
 * same threads and differ only in what has happened to them since: one wants
 * the open ones so a review can rule on them, the other the ones a human closed
 * so it will not. Two copies of this would drift on the release that changes
 * how a finding is marked, and the half that drifted would go quiet rather than
 * wrong.
 */
const findingOn = (
  thread: {
    readonly subjectType?: string | null | undefined;
    readonly comments: readonly GqlThreadComment[];
  },
): {
  readonly findingId: string;
  readonly severity?: Severity;
  readonly text: string;
  readonly title: string;
  readonly anchor: string;
  readonly url?: string;
} | undefined => {
  const marked = thread.comments.find(
    (c) => isWorkflowBot(c.author?.login ?? undefined) && findingIdIn(c.body ?? "") !== undefined,
  );
  const findingId = marked === undefined ? undefined : findingIdIn(marked.body ?? "");
  if (marked === undefined || findingId === undefined) return undefined;

  const severity = findingSeverityIn(marked.body ?? "");
  const claim = openingClaim(marked.body ?? "");
  // The comment's own permalink, which is the link a record entry carries back
  // to the thread a later round has to reach (#109, decision 8). Optional
  // because it is a link: a response that did not carry one renders an entry
  // without it rather than losing the finding.
  const url = marked.url ?? undefined;

  // `anchorOf` and not a bare `path:line`, so a thread whose code has moved
  // says so wherever this line is shown — and so a file-level thread says what
  // it is instead of claiming the code moved. It is left unfenced for that
  // reason: the anchor may carry a clause, and a code span around a sentence is
  // a sentence in a code span.
  return {
    findingId,
    ...(severity === undefined ? {} : { severity }),
    ...(url === undefined ? {} : { url }),
    text: `${anchorOf(marked, isFileLevel(thread))} · ${claim}`,
    // What a record entry lists it as (#134): the title the raising review
    // wrote, off the marker, and the claim alone for a thread a release before
    // that wrote — never `text`, whose anchor and clause belong beside a title
    // rather than inside the link that is one.
    title: lastFindingMarker(marked.body ?? "")?.title ?? claim,
    anchor: locationOf(marked, isFileLevel(thread)),
  };
};

/**
 * The last thing a **maintainer** said in a thread, which is what a review may
 * be permitted to close it on (#109, decision 10).
 *
 * Two filters, and neither is the other. `isTrustedAuthor` is the author gate
 * and has already run over these comments — the world-writable surface never
 * gets this far — but it passes the workflow bot deliberately, which is what
 * makes the review → fix handoff work. So the bot is excluded again here: a
 * fix run replies "declined, this is intended" in every thread it was shown,
 * and reading that as a maintainer's decision would let the loop close its own
 * findings on its own say-so, which is the whole failure #111 moved the cause
 * of.
 *
 * The **latest**, and that is a rule rather than a convenience: it is the only
 * reply a review may rule `declined` on, and both halves of the brief say so
 * (`review/prompt.md`, `review/extraction.md`). A thread is a conversation, so
 * an earlier refusal a later reply revisits is not the maintainer's position —
 * and the closing reply quotes exactly this comment, so "the reply the review
 * read" and "the reply the thread closes on" cannot be two different comments.
 * Without the rule they can: a maintainer declines, somebody else asks a
 * question after them, and the thread closes quoting the question.
 *
 * What is not guaranteed is that the review obeyed it — a reading is prose and
 * this file matches none. What *is* guaranteed is that the misreading is
 * visible: the closing reply carries this comment verbatim, so a reply that is
 * plainly not a decline is one glance from being reopened (`declineReply`).
 */
const maintainerReplyOn = (
  comments: readonly GqlThreadComment[],
): MaintainerReply | undefined => {
  const reply = comments.filter((c) => !isWorkflowBot(c.author?.login ?? undefined)).pop();
  const login = reply?.author?.login;

  // An anonymous reply is nobody's decision. A login is what the closing reply
  // quotes *by*, so one this file cannot name is one a maintainer reading the
  // thread could not recognise as theirs.
  return reply === undefined || login === undefined
    ? undefined
    : { login, body: (reply.body ?? "").trim() };
};

/**
 * The closing reply this workflow already posted on a thread, where nobody has
 * answered it since (#133). It says a review verified the thread, but the
 * resolve after the reply did not go through.
 *
 * **Nobody**, not *nothing*: the search walks back from the end over the
 * workflow's own later comments and stops at the first one that is not ours. A
 * human who answers the reply has reopened the conversation, maybe to say the
 * fix did not land, so the thread is open feedback again — but *we* answer it
 * routinely, because the thread is still shown to `agent:fix`, which owes an
 * outcome on every thread it was shown and posts that outcome as this same bot.
 * Reading only the last comment made a fix round for an unrelated finding erase
 * the record, and the review after it posted the second `**Verified fixed.**`
 * this whole field exists to prevent.
 *
 * What is read is the **marker** on the reply and never the words above it
 * (`closingReplyReason`). Those words are rendered into this very surface, and
 * the fix agent whose replies land here as this same bot is shown them — so a
 * prose match is one the loop's own fixer can satisfy, and the marker is not:
 * it is stripped out of every string a model wrote before any of it is posted.
 *
 * Only the workflow bot's own copy counts either way. A marker is a selector
 * anyone can type, so a copy from anybody else is not a record — and is a
 * comment from somebody who is not us, which ends the walk.
 */
const closedAsOn = (comments: readonly GqlThreadComment[]): ResolutionReason | undefined => {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]!;
    if (!isWorkflowBot(comment.author?.login ?? undefined)) return undefined;

    const reason = closingReplyReason(comment.body ?? "");
    if (reason !== undefined) return reason;
  }
  return undefined;
};

/**
 * Rendered under a thread `closedAsOn` recognised, and read by both agents that
 * are shown the inline feedback (#133).
 *
 * It says what is outstanding, because the thread's own text no longer does: a
 * reader seeing a finding, a reply verifying it, and an open thread has no way
 * to tell a close that was refused from a fix that regressed. The fix agent
 * answered "already settled" on one of these every round for want of that
 * sentence; the review, which is handed the same finding again, rules on the
 * code either way.
 *
 * It also says that no reply is owed, which is the half a sentence cannot
 * carry on its own: the thread is out of `threadIds` below, so an outcome
 * reported for it is dropped rather than posted. Said here as well as enforced
 * there because an agent told why it is being shown something writes a better
 * commit than one whose answer is silently discarded.
 */
const AWAITING_CLOSE =
  "_(this workflow has already verified this finding and replied above. The thread is open only because the close that should have followed it did not go through; a later review retries that close, and does not reply again. Nothing here is owed a fix unless the code now says otherwise, and nothing is owed a reply: this thread is shown for its evidence, and is not one of the threads to report an outcome on.)_";

/**
 * Rendered under a conversation comment **this loop wrote** and did not mark
 * (#159), and the conversation half of `AWAITING_CLOSE`.
 *
 * `isWorkflowBot` trusts `github-actions` on purpose, so every refusal note,
 * failure comment and "no re-review will start" warning any workflow here posts
 * lands on this surface and reaches the agent. That is wanted — it is evidence
 * about what has already happened on the pull request, which is why the marker
 * split does not take them out of the render. What none of them is, is somebody
 * asking for something, so none is owed an outcome: the fix run publishing
 * *Addressed — @github-actions's comment* about the loop's own status note is
 * the self-answer the markers bound, arriving from the nine unmarked posts the
 * markers were never put on.
 *
 * Said as well as enforced, for the reason `AWAITING_CLOSE` is: the comment
 * carries no id here, so an outcome on it cannot be reported at all, and an
 * agent told why it is being shown something writes a better commit than one
 * whose answer is silently discarded.
 */
const LOOP_NOTE =
  "_(posted by this loop's own workflows rather than by a person: a status note, shown for its evidence. It asks for nothing, so no outcome is owed on it, which is why it carries no comment id.)_";

/**
 * The elements a partial answer actually left behind.
 *
 * A nulled element is a hole in the list, not an object with absent fields, so
 * every read below has to step over it: `n.authorAssociation` on a `null` is a
 * `TypeError`, and a runner that throws there writes *that* into
 * `failure_reason.txt` instead of the refusal it meant to give — one signature
 * standing in for another, which is the substitution #76 exists to remove.
 *
 * Nothing is lost by dropping them. Every hole is the shadow of an entry in
 * `errors[]`, so `unreadable` already names it — and an error reaching one of
 * the gate's own fields is trust-bearing, which is what makes the run that
 * pushes refuse rather than act on the elements that survived.
 */
const present = <T>(nodes: readonly (T | null | undefined)[] | null | undefined): T[] =>
  (nodes ?? []).filter((node): node is T => node !== null && node !== undefined);

/**
 * Trusted and non-empty — the filter every surface shares, as the nodes rather
 * than as text.
 *
 * One definition, read twice, which is what #104 needs of it: the conversation
 * surface is rendered from this list *and* the ids an outcome may name are taken
 * from it, and a surface whose text and whose answerable set were filtered
 * separately is one where they can disagree — an outcome owed on a comment the
 * agent was never shown, or none owed on one it was.
 *
 * The answerable half narrows from here by exactly one subtraction, named where
 * it is made (`owedAnOutcome`) rather than by filtering twice: this loop's own
 * unmarked notes are rendered and carry no id (#159). One derived from the
 * other is the property; identical is not.
 */
const renderable = <T extends GqlAuthored>(
  nodes: readonly (T | null | undefined)[] | null | undefined,
): T[] =>
  present(nodes)
    .filter((n) => isTrustedAuthor(n.authorAssociation, n.author?.login ?? undefined))
    .filter((n) => (n.body ?? "").trim().length > 0);

/**
 * Those nodes as one block of text.
 *
 * The severity chips a review body carries come out as their alt text
 * (`withSeverityBadgesAsText`): this is prompt text, and a reader that renders
 * no images is handed `Medium` rather than the `<img>` tag that says it (#135).
 */
const render = <T extends GqlAuthored>(
  nodes: readonly (T | null | undefined)[] | null | undefined,
  format: (node: T, login: string) => string,
): string =>
  renderable(nodes)
    .map((n) => withSeverityBadgesAsText(format(n, n.author?.login ?? "unknown")))
    .join("\n\n---\n\n");

/**
 * Gather the feedback on a PR, keeping only what a repo collaborator — or our
 * own review agent — wrote.
 *
 * SECURITY: every surface here is world-writable on a public repo; anyone can
 * comment on a PR or submit a review. `agent:fix` acts on this with
 * `contents: write` and pushes, so an injection would steer *committed code*.
 * The author gate is therefore load-bearing, not cosmetic. Read here rather
 * than by the agent, whose GitHub token is scrubbed before it starts.
 *
 * Resolved threads are dropped: resolving a thread is how a human says "handled,
 * ignore this", and re-feeding it would have the agent redo dismissed work.
 *
 * A selection the API refuses is dropped too — but *named*, in `unreadable`,
 * rather than absorbed into an empty surface. What a caller does about that is
 * the caller's: a review degrades on what survived and says so, and the run that
 * pushes takes `refusalReason`. The one thing neither may do is read a refusal
 * as an absence.
 */
export const fetchPullRequestFeedback = (prNumber: string): PullRequestFeedback => {
  const [owner = "", repo = ""] = (process.env["GH_REPO"] ?? "").split("/");

  // Read through `ghOutcome`, not `gh`: a partial-error response exits non-zero
  // with the good data on stdout, so the throwing helper inside a `try` was
  // discarding every surface that had answered along with the one that had not
  // (#76). `readResponse` rules on the payload instead, per errored path.
  const { pr, status, unreadable } = readResponse(
    ghOutcome([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `number=${prNumber}`,
      "-f",
      `query=${QUERY}`,
    ]),
  );

  // Our own top-level comments are split off before rendering rather than
  // filtered by author: `github-actions` is trusted on purpose (that is what
  // makes the review → fix handoff work), so an author-based filter would be
  // both too blunt and, on the `reviews` surface, actively wrong. The marker
  // names exactly the comments this workflow wrote. Feeding them back would put
  // the agent's own "worth a follow-up issue" note under a prompt heading that
  // says to decide whether to address or decline it — which is the invariant in
  // docs/parity.md §10 closed by a different door.
  const commentNodes = present(pr?.comments?.nodes);
  const priorTopLevelComments = commentNodes
    .filter((n) => isTrustedAuthor(n.authorAssociation, n.author?.login ?? undefined))
    .filter((n) => isAgentTopLevelComment(n.body))
    .map((n) => n.body ?? "");

  // Both markers, not just the top-level one: since #104 this workflow also
  // posts a record of what it did with these comments, and an unmarked record
  // would come back next round as a comment to act on — and to report an outcome
  // on, the agent answering its own post. One predicate for "we wrote this".
  const conversationNodes = renderable(
    commentNodes.filter(
      (n) => !isAgentTopLevelComment(n.body) && !isAgentConversationOutcome(n.body),
    ),
  );

  // Which of them an outcome is owed on — the conversation half of
  // `answerable`, and the one place the two halves differ.
  //
  // **Not this loop's own unmarked notes** (#159). The markers above name the
  // two kinds a fix run writes *to be read*; they are not on the refusal note,
  // the failure comment or the `AGENT_PAT` warning that this and every other
  // workflow here posts as the same trusted bot, and marking those would drop
  // evidence out of the render to fix an answer nobody was waiting for. The
  // author is the bound that covers all of them at once, including an adopter's
  // own jobs posting under the same login, and it costs nothing a fix run
  // needed: a status note asks for nothing.
  //
  // A comment whose `id` did not come back is unanswerable for the other
  // reason, and still rendered. `IssueComment.id` is non-null and a refusal
  // nulls the whole element, so that is unreachable rather than a case with a
  // reading to get right — and of the two readings available, dropping feedback
  // a run might be steered by is the worse one.
  const owedAnOutcome = (n: GqlComment): n is GqlComment & { id: string } =>
    typeof n.id === "string" && !isWorkflowBot(n.author?.login ?? undefined);

  // The id is rendered for the same reason a thread's is: the agent has to name
  // a comment to report an outcome on it, so identity must survive into the
  // prompt (#104). A comment no outcome is owed on carries none — there is
  // nothing for it to name — and the loop's own notes say why rather than
  // leaving the omission to be read as an oversight.
  const conversation = render(conversationNodes, (n, login) =>
    owedAnOutcome(n)
      ? `**@${login}** · comment \`${n.id}\`\n${(n.body ?? "").trim()}`
      : [
          `**@${login}:**\n${(n.body ?? "").trim()}`,
          ...(isWorkflowBot(login) ? [LOOP_NOTE] : []),
        ].join("\n\n"),
  );

  const conversationComments = conversationNodes
    .filter(owedAnOutcome)
    .map((n): ConversationComment => ({
      commentId: n.id,
      author: n.author?.login ?? "unknown",
      ...(typeof n.url === "string" ? { url: n.url } : {}),
    }));

  const summaries = render(
    pr?.reviews?.nodes,
    (n, login) => `**@${login}** (${n.state ?? "COMMENTED"}):\n${(n.body ?? "").trim()}`,
  );

  // Grouped by thread, not flattened: the fix agent has to name a thread to
  // reply to or resolve it, so thread identity must survive into the prompt.
  //
  // Resolved threads are kept this far rather than filtered out at the top, and
  // that is the change #112 rests on: a thread a **human** closed is a decision
  // a later review has to be told about, and "it is gone from the feedback"
  // cannot say that. They are split below, and only the open ones are rendered
  // or answered.
  const allThreads = present(pr?.reviewThreads?.nodes)
    .filter((thread): thread is GqlThread & { id: string } => typeof thread.id === "string")
    .map((thread) => {
      const trusted = present(thread.comments?.nodes).filter(
        (c) =>
          isTrustedAuthor(c.authorAssociation, c.author?.login ?? undefined) &&
          (c.body ?? "").trim().length > 0,
      );
      return {
        id: thread.id,
        isResolved: thread.isResolved === true,
        subjectType: thread.subjectType ?? undefined,
        resolvedBy: thread.resolvedBy?.login ?? undefined,
        comments: trusted,
      };
    })
    .filter((thread) => thread.comments.length > 0);

  const threads = allThreads
    .filter((thread) => !thread.isResolved)
    .map((thread) => ({ ...thread, closedAs: closedAsOn(thread.comments) }));

  // A thread already carrying this workflow's closing reply is rendered like
  // any other, and `AWAITING_CLOSE` is what is added rather than what is taken
  // away (#133). Dropping it was the first attempt and it removed the evidence
  // with the noise: the quote and the failure scenario live in the thread's
  // first comment, and both readers need them. The review is handed the
  // finding again whatever happens here, and its safe ruling on anything it
  // cannot settle is `open` — which would leave a finding counting toward the
  // verdict that `agent:fix` was never shown and could not have replied to.
  const inline = threads
    .map((thread) => {
      const first = thread.comments[0];
      const header = `**${anchorOf(first!, isFileLevel(thread))}** · thread \`${thread.id}\``;
      // The chip a thread opens with, as its alt text — the same reduction the
      // review bodies get, for the same reason: this is what the fix agent and
      // the next round's reviewer read (#135).
      const body = thread.comments
        .map(
          (c) =>
            `@${c.author?.login ?? "unknown"}:\n${withSeverityBadgesAsText((c.body ?? "").trim())}`,
        )
        .join("\n\n");
      return [header, body, ...(thread.closedAs === undefined ? [] : [AWAITING_CLOSE])].join("\n\n");
    })
    .join("\n\n---\n\n");

  // Every thread rendered above **except** one already carrying its closing
  // reply (#133). This list is the whole of what a fix run may reply into
  // (`filterOutcomes`), and such a thread is shown for its evidence rather than
  // for an answer: the prompt asks for one outcome per thread it was given, the
  // workflow posts each as this same bot, and the next review reads the thread
  // back. Left in, the review half was capped at one reply and the fix half was
  // not — every fix round, whatever it was labelled for, added another comment
  // to every thread whose resolve had failed.
  //
  // Rendered and unanswerable is the pair that holds. Dropping the thread from
  // the render was the first attempt at the same cap and it took the evidence
  // with the noise; leaving it answerable was the second and it capped nothing.
  const answerable = threads.filter((thread) => thread.closedAs === undefined).map((t) => t.id);

  // The loop's own open findings, selected by the id the workflow wrote into
  // each thread rather than by what the thread says — text is never matched
  // across rounds (#109, decision 2); see `findingOn` for what makes a thread
  // the loop's own. Each carries a maintainer's reply where one exists, because
  // a review may rule the finding declined and only that reply lets the
  // workflow act on the ruling (#112).
  const agentThreads = threads.flatMap((thread): AgentThread[] => {
    const found = findingOn(thread);
    if (found === undefined) return [];

    const reply = maintainerReplyOn(thread.comments);
    return [
      {
        threadId: thread.id,
        findingId: found.findingId,
        text: found.text,
        title: found.title,
        anchor: found.anchor,
        ...(found.severity === undefined ? {} : { severity: found.severity }),
        ...(found.url === undefined ? {} : { url: found.url }),
        ...(reply === undefined ? {} : { maintainerReply: reply }),
        ...(thread.closedAs === undefined ? {} : { closedAs: thread.closedAs }),
      },
    ];
  });

  // The findings a **human** closed (#109, decision 10). Read off the same
  // threads, by who resolved them: this loop resolves what it has verified
  // fixed, so its own resolutions are settled findings in a different sense —
  // re-raising one is how a regressed fix gets reported, and telling a later
  // review it may never mention them again would make every `ADDRESSED` close
  // permanent.
  //
  // An unknown resolver establishes nothing and is carried nowhere. The cost is
  // a maintainer's decision this run cannot see; the alternative is silencing a
  // finding on the strength of a field that did not answer.
  const settledFindings = allThreads.flatMap((thread): SettledFinding[] => {
    const resolvedBy = thread.resolvedBy;
    if (!thread.isResolved || resolvedBy === undefined || isWorkflowBot(resolvedBy)) return [];

    const found = findingOn(thread);
    // The severity is deliberately dropped here rather than carried: a settled
    // finding is shown to the reviewer as an instruction not to raise it again,
    // and a rating on something nobody may act on is an invitation to weigh it.
    return found === undefined
      ? []
      : [{ findingId: found.findingId, text: found.text, resolvedBy }];
  });

  // The newest review this loop posted, which is the one whose body is current.
  // `isWorkflowBot` rather than `isTrustedAuthor`: the question is "did this
  // loop write it", and the wider gate would admit a maintainer's own review,
  // whose body carries no finding ids and whose prose is not a record to verify
  // against.
  //
  // **The last node of the last page**, which is what `reviews(last:50)` in the
  // query makes this: `.pop()` over a page taken from the *front* is the newest
  // of the fifty oldest, which is only the newest review while a pull request
  // has had fewer than fifty (#125).
  const latestAgentReviewBody =
    present(pr?.reviews?.nodes)
      .filter((review) => isWorkflowBot(review.author?.login ?? undefined))
      .map((review) => (review.body ?? "").trim())
      .filter((body) => body !== "")
      .pop() ?? "";

  const all = [
    summaries && `### Review summaries\n\n${summaries}`,
    inline && `### Inline comments (unresolved threads)\n\n${inline}`,
    conversation && `### Conversation\n\n${conversation}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    summaries,
    inline,
    conversation,
    all,
    threadIds: answerable,
    conversationComments,
    agentThreads,
    settledFindings,
    latestAgentReviewBody,
    priorTopLevelComments,
    diff: readDiff(prNumber),
    changedFiles: parseNameStatus(git(changedFilesCommandAgainstBase(process.env["BASE_REF"]))),
    // Deliberately **not** computed from `all` (#160). What is rendered and
    // what is owed an answer came apart in #133 and #159: a thread awaiting its
    // close and this loop's own unmarked status notes are shown for their
    // evidence and ask for nothing, so a PR holding only those must still
    // refuse rather than spend a run with nothing to act on. A review summary
    // counts as it always has.
    hasFeedback: summaries !== "" || answerable.length > 0 || conversationComments.length > 0,
    status,
    unreadable,
  };
};
