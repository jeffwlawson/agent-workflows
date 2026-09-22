import { ghOutcome, git, isTrustedAuthor, type GhOutcome } from "./common.js";
import { isAgentTopLevelComment } from "./fix-output.js";

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
  /** Comments in *unresolved* review threads, anchored to file + line, replies included. */
  readonly inline: string;
  /**
   * Top-level conversation comments on the PR, **excluding** the ones
   * `agent:fix` posted itself (see `TOP_LEVEL_COMMENT_MARKER`).
   */
  readonly conversation: string;
  /** All of the above rendered as one block, or "" when there is none. */
  readonly all: string;
  /** Node ids of the unresolved threads shown to the agent, for reply/resolve. */
  readonly threadIds: readonly string[];
  /**
   * Bodies of the top-level comments `agent:fix` already posted on this PR —
   * kept out of every rendered surface above, and returned only so a new run
   * can avoid posting the same note twice.
   */
  readonly priorTopLevelComments: readonly string[];
  /** Diff of the branch against the PR's base branch merge-base (three-dot). */
  readonly diff: string;
  /**
   * False when nothing trusted was **rendered**. Deliberately not the whole
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
 */
const QUERY = `
query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      comments(first:100) { nodes { body author { login } authorAssociation } }
      reviews(first:50) { nodes { body state author { login } authorAssociation } }
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:50) {
            nodes {
              path line startLine originalLine originalStartLine
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
interface GqlThreadComment extends GqlAuthored {
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
}

interface GqlThread {
  id?: string;
  isResolved?: boolean;
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
 */
interface GqlPullRequest {
  comments?: { nodes?: (GqlAuthored | null)[] | null } | null;
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

/** The fields `isTrustedAuthor` is given. An error on one of these is an error on the gate. */
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
 * out does not go unnoticed — it makes the new surface refuse.
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

  const surface = SURFACE_OF_SELECTION[selection];
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

/** What `gh` said about a failure, in as few words as it used. */
const spokenReason = (outcome: GhOutcome): string => {
  const said = [outcome.stderr, outcome.stdout]
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
        `\`${selection.path}\` — ${selection.reason}` +
        (selection.surfaces.length === 0
          ? ""
          : ` (${selection.surfaces.map((surface) => SURFACE_LABELS[surface]).join(", ")})`),
    )
    .join("; ");

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
        "Part of the query behind this pull request's own feedback — its review summaries, " +
          "unresolved review threads and conversation comments — was refused, so what it " +
          "covers is **unknown** rather than empty. That holds whether the affected section " +
          "is short or missing entirely: do not read its absence as agreement, and say so in " +
          "your output if it matters to a conclusion you would otherwise draw.",
        "",
        ...unreadable.map(
          (selection) =>
            `- \`${selection.path}\` — ${selection.reason}` +
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
    ? `${text}\n\n---\n\n(part of this section could not be read, so what it covers is unknown rather than absent — ${note})`
    : `(could not be read — ${note})`;
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
      "That is not an empty feedback set, it is no answer — refusing rather than pushing commits " +
      "without knowing what was asked for."
    );
  }

  const gating = feedback.unreadable.filter((selection) => selection.trustBearing);
  if (gating.length > 0) {
    return (
      `A selection the author gate depends on could not be read: ${describeUnreadable(gating)}. ` +
      "The feedback that did return cannot be placed behind the trust boundary, and this run " +
      "pushes commits — so it refuses rather than acting on feedback whose author it cannot establish."
    );
  }

  if (!feedback.hasFeedback && feedback.unreadable.length > 0) {
    return (
      `Nothing trusted was rendered, and part of the feedback query was refused: ${describeUnreadable(feedback.unreadable)}. ` +
      '"Nothing to act on" and "a selection was refused" are not the same answer, so this refuses as the second.'
    );
  }

  if (!feedback.hasFeedback) {
    return (
      "No unresolved feedback from a repo collaborator (or our review agent) to act on. " +
      "Resolved threads and comments from non-collaborators are deliberately ignored."
    );
  }

  return undefined;
};

/**
 * The `git diff` that defines the PR, as GitHub sees it. GitHub computes a PR's
 * diff against the merge-base of its *base branch*, and the inline-comment
 * allow-list (built from this same diff by `parseDiffLines`) must match exactly:
 * too permissive and GitHub rejects the whole review, too restrictive and
 * legitimate comments are dropped — both surface as a silent, empty review
 * (issue #71). So the base is the PR's real base, not a hardcoded `main`.
 *
 * Three-dot on purpose: `<base>...HEAD` is changes since the merge-base, which
 * is what GitHub shows. A two-dot diff has different semantics and would
 * silently mis-filter; the fallback to it was deliberately removed once already
 * (see review-context.ts) — do not reintroduce it.
 *
 * Refuses an absent or empty base rather than defaulting to one. It defaulted
 * to `main` until #98, which is the same silent wrong-branch failure one level
 * down: on a `master` repo every review diffed against a ref that did not
 * exist, and on one that had a stale `main` it diffed against that instead.
 * Every workflow in the loop now sets `BASE_REF` from the pull-request event
 * with the `default-branch` input behind it, so an empty value is a
 * misconfiguration to say out loud — and `fail()` puts the message on the PR.
 *
 * Returns argv for `git`, not a command string: `git()` runs `execFileSync`, so
 * `baseRef` arrives as one argument and is never shell-parsed. That matters
 * because a git ref may legally contain `` ` ``, `$()`, `;`, `|` and `&`. This
 * previously carried a "must stay trusted input" warning instead (issue #75) —
 * write access is still the loop's trust boundary, but it is no longer the only
 * thing standing between a ref name and `/bin/sh`.
 */
export const diffCommandAgainstBase = (baseRef: string | undefined): readonly string[] => {
  const base = (baseRef ?? "").trim();
  if (!base) {
    throw new Error(
      "BASE_REF is empty. The workflow sets it from the pull request's base ref, falling back to its `default-branch` input; without it this diff would have to guess a branch, and a wrong guess is a review that silently comments on the wrong lines (#71).",
    );
  }
  return ["diff", `${base}...HEAD`];
};

/**
 * Where a thread comment points, and whether that anchor is still live.
 *
 * `line` is null once the code under a comment has changed — GitHub calls this
 * *outdated* and keeps `originalLine` as the position it was written against.
 * Saying so matters: an agent handed a bare line number cannot tell whether it
 * describes today's code or code that has since moved.
 */
const anchorOf = (c: GqlThreadComment): string => {
  const outdated = c.line === null || c.line === undefined;
  const end = c.line ?? c.originalLine;
  const start = c.startLine ?? c.originalStartLine;
  const range = start !== null && start !== undefined && start !== end ? `${start}-${end}` : `${end ?? "?"}`;
  return `${c.path ?? "unknown"}:${range}${outdated ? " (outdated — the code here has changed since)" : ""}`;
};

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

/** Trusted, non-empty, and rendered — the filter every surface shares. */
const render = <T extends GqlAuthored>(
  nodes: readonly (T | null | undefined)[] | null | undefined,
  format: (node: T, login: string) => string,
): string =>
  present(nodes)
    .filter((n) => isTrustedAuthor(n.authorAssociation, n.author?.login ?? undefined))
    .filter((n) => (n.body ?? "").trim().length > 0)
    .map((n) => format(n, n.author?.login ?? "unknown"))
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

  const conversation = render(
    commentNodes.filter((n) => !isAgentTopLevelComment(n.body)),
    (n, login) => `**@${login}:**\n${(n.body ?? "").trim()}`,
  );

  const summaries = render(
    pr?.reviews?.nodes,
    (n, login) => `**@${login}** (${n.state ?? "COMMENTED"}):\n${(n.body ?? "").trim()}`,
  );

  // Grouped by thread, not flattened: the fix agent has to name a thread to
  // reply to or resolve it, so thread identity must survive into the prompt.
  const threads = present(pr?.reviewThreads?.nodes)
    .filter((thread): thread is GqlThread & { id: string } =>
      thread.isResolved !== true && typeof thread.id === "string",
    )
    .map((thread) => {
      const trusted = present(thread.comments?.nodes).filter(
        (c) =>
          isTrustedAuthor(c.authorAssociation, c.author?.login ?? undefined) &&
          (c.body ?? "").trim().length > 0,
      );
      return { id: thread.id, comments: trusted };
    })
    .filter((thread) => thread.comments.length > 0);

  const inline = threads
    .map((thread) => {
      const first = thread.comments[0];
      const header = `**${anchorOf(first!)}** — thread \`${thread.id}\``;
      const body = thread.comments
        .map((c) => `@${c.author?.login ?? "unknown"}:\n${(c.body ?? "").trim()}`)
        .join("\n\n");
      return `${header}\n\n${body}`;
    })
    .join("\n\n---\n\n");

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
    threadIds: threads.map((t) => t.id),
    priorTopLevelComments,
    diff: git(diffCommandAgainstBase(process.env["BASE_REF"])),
    // Deliberately computed from `all`, which no longer contains our own
    // top-level comments: a PR with every thread resolved and no human input
    // must still refuse, rather than find "feedback" the agent wrote itself.
    hasFeedback: all.length > 0,
    status,
    unreadable,
  };
};
