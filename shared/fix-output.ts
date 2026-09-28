import { asArray, asRecord, asString, standardSchema } from "./common.js";
import { withoutFindingMarkers } from "./review-findings.js";

/** What the fix agent decided about one review thread. */
export interface ThreadOutcome {
  /** GraphQL node id of the thread, taken verbatim from the feedback shown. */
  readonly threadId: string;
  /**
   * `addressed` — the comment's concern is satisfied in the current HEAD.
   * That includes work done by an *earlier* commit, not only by this run: a
   * thread with nothing outstanding is one a review should be able to close,
   * regardless of which commit settled it.
   *
   * `declined` — you disagree, or deliberately are not acting.
   *
   * **Neither closes the thread**, since #111: a fix run replies and resolves
   * nothing, and a thread closes when a *review* has read the code and verified
   * the finding is gone (#109, decision 1). So this is a claim recorded in the
   * reply, and the difference it makes is to what the reply says rather than to
   * what happens to the thread — which is the point, because the author of a
   * fix is the one party that cannot check it.
   *
   * The split is deliberately "is anything still outstanding?", not "did I
   * personally change something?". An earlier, narrower wording ("the code was
   * changed to satisfy the comment") made the agent classify already-handled
   * threads as declined, and a reply that understates what has been done is a
   * review round spent re-checking work nobody claimed.
   */
  readonly status: "addressed" | "declined";
  /** Markdown reply posted into the thread. */
  readonly reply: string;
}

/**
 * A comment posted on the PR conversation rather than into a thread.
 *
 * The channel exists for a finding that belongs to **no** thread — something
 * noticed while fixing that is out of scope, a refusal that spans threads
 * rather than sitting in one, a cross-cutting observation answering no specific
 * comment. Before it existed such a finding had nowhere to go: #63's documented
 * bug ended up as a `DOCUMENTED BUG` comment inside a test file, and #77's
 * "open a follow-up and reference it" option was simply not executable, so the
 * agent would take the weaker option and reply as if it had chosen it.
 *
 * The agent never posts these itself — it reports them, the workflow posts
 * them from validated output, and the token scrub stays exactly as it is.
 */
export interface TopLevelComment {
  /** Markdown body, posted verbatim as a PR conversation comment. */
  readonly body: string;
}

/**
 * What the fix agent decided about one **top-level conversation comment** — the
 * same two answers a review thread gets, for the surface that has no threads
 * (#104; PRD #101 decision 6, superseding #3).
 *
 * The run read these comments and acted on them and said nothing about either,
 * so a **declined** one was invisible: no reply, no record, nothing to push back
 * on. Since PRD #101 decision 5 a maintainer's steering arrives as exactly such
 * a comment, which is what turns that silence from an untidiness into the
 * failure that matters.
 *
 * Not a thread reply and not a top-level comment: GitHub gives a conversation
 * comment nothing to reply *into*, so the outcomes are rendered as one comment
 * on the same conversation (`renderConversationOutcomes`) — where the person who
 * left the comment is already looking.
 */
export interface ConversationOutcome {
  /** Node id of the comment, taken verbatim from the feedback shown. */
  readonly commentId: string;
  /** `addressed` / `declined`, read exactly as `ThreadOutcome.status` is. */
  readonly status: "addressed" | "declined";
  /** Markdown, posted in the record this run writes on the conversation. */
  readonly reply: string;
}

/**
 * A conversation comment a fix run **is asked to answer**: its id, who wrote it,
 * and where it is.
 *
 * Declared here rather than in `shared/pr-feedback.ts` because it is the key of
 * this channel — the fetch produces it, and that file already imports from this
 * one, so the type going the other way would be a second import edge between
 * the two.
 */
export interface ConversationComment {
  readonly commentId: string;
  /** Login of whoever wrote it, so the record can name who an outcome is owed to. */
  readonly author: string;
  /** The comment's own permalink, where GitHub returned one. */
  readonly url?: string;
}

export interface FixOutput {
  readonly threadOutcomes: ThreadOutcome[];
  readonly conversationOutcomes: ConversationOutcome[];
  readonly topLevelComments: TopLevelComment[];
}

const parseStatus = (value: unknown, label: string): "addressed" | "declined" => {
  const status = asString(value, `${label} status`);
  if (status !== "addressed" && status !== "declined") {
    throw new Error(`${label} status must be "addressed" or "declined", got "${status}"`);
  }
  return status;
};

const parseOutcome = (value: unknown): ThreadOutcome => {
  const record = asRecord(value, "thread outcome");
  return {
    threadId: asString(record["threadId"] ?? record["thread_id"], "thread outcome threadId"),
    status: parseStatus(record["status"], "thread outcome"),
    reply: asString(record["reply"] ?? record["body"], "thread outcome reply"),
  };
};

/**
 * Parsed like a thread outcome and **not** like a top-level comment: a malformed
 * one throws, which surfaces as a validation issue the extraction retry feeds
 * back. The reasoning that makes `parseTopLevelComment` drop instead does not
 * reach here — a top-level comment is a side channel that must not veto the
 * mandatory payload, and this *is* part of that payload. The whole of #104 is
 * that an unreported conversation comment is invisible, and a parser that
 * dropped a decline with a warning would rebuild that invisibility one layer
 * down.
 */
const parseConversationOutcome = (value: unknown): ConversationOutcome => {
  const record = asRecord(value, "conversation outcome");
  return {
    commentId: asString(
      record["commentId"] ?? record["comment_id"],
      "conversation outcome commentId",
    ),
    status: parseStatus(record["status"], "conversation outcome"),
    reply: asString(record["reply"] ?? record["body"], "conversation outcome reply"),
  };
};

/**
 * A list entry may arrive as `{ body }` or as a bare string. That is wider than
 * the key aliasing `parseOutcome` does for `thread_id`, but rests on the same
 * reasoning: the shape the model picks for a one-field object is not worth a
 * failed extraction.
 *
 * Returns `null` rather than throwing, which is the one place this parser
 * deliberately differs from `parseOutcome`. A throw here becomes a validation
 * issue, burns both `maxRetries` in `run-with-extraction.ts`, and if it persists
 * takes the whole extraction down — losing every thread reply and resolve with
 * it. `threadOutcomes` is the payload the run exists to produce; this is an
 * optional side channel, and a side channel does not get veto power over the
 * mandatory one. Dropping with a warning keeps the replies flowing and still
 * leaves the problem visible in the log.
 */
const parseTopLevelComment = (value: unknown): TopLevelComment | null => {
  try {
    if (typeof value === "string") {
      return { body: asString(value, "top-level comment body") };
    }
    const record = asRecord(value, "top-level comment");
    return { body: asString(record["body"] ?? record["comment"], "top-level comment body") };
  } catch (error) {
    console.warn(
      `Dropping a malformed top-level comment: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

/**
 * Absent means silence, not an error. Most runs have nothing that belongs
 * outside a thread, and that is the case this channel must stay quiet for. A
 * non-array value is dropped with a warning for the same reason `parseTopLevelComment`
 * drops a malformed entry: this field must not be able to fail the run.
 */
const parseTopLevelComments = (value: unknown): TopLevelComment[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    console.warn("Dropping topLevelComments: expected an array.");
    return [];
  }
  return value
    .map(parseTopLevelComment)
    .filter((comment): comment is TopLevelComment => comment !== null);
};

/**
 * **The same one boundary the review's output has** — every string below this
 * line is the model's, and a finding marker in any of them is gone before any
 * of it is read (`withoutFindingMarkers`).
 *
 * A fix run is shown the live markers too: the `inline` surface renders a
 * thread's comments verbatim, so this agent is handed the exact syntax and this
 * round's real ids exactly as the reviewer is. Its replies are posted **by the
 * workflow bot**, which is what makes a copied marker reachable — the reader
 * that decides which thread is one of this loop's findings looks for a marker
 * in a bot-authored comment, so a reply quoting one could hand a later review a
 * finding on a thread this loop never opened, under a closed finding's id.
 */
export const fixOutputSchema = standardSchema<FixOutput>((raw) => {
  const record = asRecord(withoutFindingMarkers(raw), "fix output");
  return {
    threadOutcomes: asArray(record["threadOutcomes"] ?? [], "threadOutcomes").map(parseOutcome),
    conversationOutcomes: asArray(
      record["conversationOutcomes"] ?? record["conversation_outcomes"] ?? [],
      "conversationOutcomes",
    ).map(parseConversationOutcome),
    topLevelComments: parseTopLevelComments(
      record["topLevelComments"] ?? record["top_level_comments"],
    ),
  };
});

/**
 * Drop outcomes naming a thread this run was not asked to answer.
 *
 * Two shapes, and the list is the same answer to both. Models invent
 * plausible-looking ids, and an invented one either fails the mutation or —
 * worse — resolves an unrelated thread. And a thread can be *rendered* without
 * being answerable: one already carrying this workflow's closing reply is shown
 * for its evidence and kept out of `threadIds`, or every fix round would add
 * another comment to it (#133). Only ids the fetch offered are honoured.
 * Duplicates are collapsed so a thread cannot be replied to twice in one run.
 */
export const filterOutcomes = (
  outcomes: readonly ThreadOutcome[],
  knownThreadIds: readonly string[],
): ThreadOutcome[] => {
  const known = new Set(knownThreadIds);
  const seen = new Set<string>();
  return outcomes.filter((outcome) => {
    if (!known.has(outcome.threadId)) {
      // Not "unknown": since #133 a thread the agent was shown can be one it
      // was not asked about, and a log line calling that an invented id sends
      // whoever reads it looking for the wrong fault.
      console.warn(
        `Dropping outcome for thread ${outcome.threadId}, which this run was not asked to answer.`,
      );
      return false;
    }
    if (seen.has(outcome.threadId)) {
      console.warn(`Dropping duplicate outcome for thread ${outcome.threadId}.`);
      return false;
    }
    seen.add(outcome.threadId);
    return true;
  });
};

/**
 * Drop outcomes naming a conversation comment this run was not shown, and
 * collapse duplicates. `filterOutcomes` for the other surface, and the same two
 * hazards: an invented id names somebody else's comment in the record, and a
 * comment answered twice is answered twice.
 *
 * It carries one more, and it is the reason this filter exists rather than the
 * prompt being trusted. **The comments this workflow posted itself are not in
 * `knownCommentIds`** — an out-of-scope note and an earlier round's record alike:
 * `fetchPullRequestFeedback` splits both off by their markers before rendering
 * the conversation surface, so neither is ever offered as a comment to answer. An
 * outcome naming one is therefore dropped here, which is what stops the first run
 * after #104 acknowledging its own posts.
 */
export const filterConversationOutcomes = (
  outcomes: readonly ConversationOutcome[],
  knownCommentIds: readonly string[],
): ConversationOutcome[] => {
  const known = new Set(knownCommentIds);
  const seen = new Set<string>();
  return outcomes.filter((outcome) => {
    if (!known.has(outcome.commentId)) {
      console.warn(
        `Dropping outcome for comment ${outcome.commentId}, which this run was not shown.`,
      );
      return false;
    }
    if (seen.has(outcome.commentId)) {
      console.warn(`Dropping duplicate outcome for comment ${outcome.commentId}.`);
      return false;
    }
    seen.add(outcome.commentId);
    return true;
  });
};

/**
 * Marks the record of what a run did with the conversation comments. A
 * **different** string from `TOP_LEVEL_COMMENT_MARKER`, and both halves of that
 * are load-bearing.
 *
 * *Marked*, because `pr-feedback.ts` keeps marked comments out of the
 * conversation surface: unmarked, the next `agent:fix` run would read this
 * record back as feedback to act on and owe an outcome on it — the agent
 * answering its own post, which is the shape #104 was written around.
 *
 * *Different*, because the two are not the same kind of thing to anything that
 * reads them. The top-level marker is the selector for harvesting an
 * out-of-scope finding into an issue (#79), and an outcome record raises no
 * work; it is also the key `filterTopLevelComments` dedupes that channel on, and
 * a record repeated across rounds is correct because each round's is about that
 * round.
 */
export const CONVERSATION_OUTCOME_MARKER = "<!-- agent-fix:conversation-outcomes -->";

/** True for a conversation-outcome record this workflow posted. */
export const isAgentConversationOutcome = (body: string | null | undefined): boolean =>
  (body ?? "").includes(CONVERSATION_OUTCOME_MARKER);

/**
 * The record a run posts on the conversation, or `""` when it has no outcome to
 * report — which is the normal case, since most pull requests carry no
 * conversation comment at all.
 *
 * **Declines first.** A run with three addressed outcomes and one decline buries
 * the only half a human has to act on, and the addressed half is a claim the
 * next review checks against the code regardless. Within each half the agent's
 * own order is kept, which is the order it was shown the comments in.
 *
 * `comments` supplies the author and the permalink. A lookup that misses is not
 * allowed to lose the outcome: `filterConversationOutcomes` has already reduced
 * this list to ids the fetch offered, so a miss means the metadata went astray
 * between the two — and dropping a decline over a missing link is the invisible
 * decline this whole channel removes.
 */
export const renderConversationOutcomes = (
  outcomes: readonly ConversationOutcome[],
  comments: readonly ConversationComment[],
): string => {
  if (outcomes.length === 0) return "";

  const known = new Map(comments.map((comment) => [comment.commentId, comment] as const));
  const entry = (outcome: ConversationOutcome): string => {
    const comment = known.get(outcome.commentId);
    const label = outcome.status === "declined" ? "Declined" : "Addressed";
    const target =
      comment === undefined
        ? "a comment on this conversation"
        : comment.url === undefined
          ? `@${comment.author}'s comment`
          : `@${comment.author}'s [comment](${comment.url})`;
    return `**${label}** — ${target}:\n\n${outcome.reply.trim()}`;
  };

  const ordered = [
    ...outcomes.filter((outcome) => outcome.status === "declined"),
    ...outcomes.filter((outcome) => outcome.status !== "declined"),
  ];

  const heading =
    "**What this run did with the comments on this conversation.** These are not review " +
    "threads, so there is nowhere to reply into and this is the record. Nothing here closes " +
    "anything.";

  const body = [heading, ...ordered.map(entry)].join("\n\n---\n\n");

  return `${body}\n\n${CONVERSATION_OUTCOME_MARKER}`;
};

/**
 * Appended to every top-level comment the workflow posts. An HTML comment, so
 * it is invisible in rendered Markdown.
 *
 * It does two jobs. First, `pr-feedback.ts` drops marked comments from the
 * `conversation` surface, which is what stops the next `agent:fix` run reading
 * this agent's own out-of-scope note back as feedback to act on. Without it the
 * "an agent that raises work never files it" invariant closes by a different
 * door: the agent raises the follow-up and the agent, one label later, does it,
 * with no human in between — and the quiet variant, where it simply addresses
 * the note and expands scope in exactly the way the note existed to avoid,
 * looks like an ordinary run. Narrowing that surface costs nothing that
 * matters: the review → fix handoff does not go through `comments` at all, as
 * `agent-review.yml` posts a *review*, which arrives via `reviews` /
 * `reviewThreads`.
 *
 * Second, it is a reliable selector for harvesting these comments into issues
 * (#79), which matching on prose would not be.
 */
export const TOP_LEVEL_COMMENT_MARKER = "<!-- agent-fix:top-level -->";

/** True for a PR conversation comment this workflow posted. */
export const isAgentTopLevelComment = (body: string | null | undefined): boolean =>
  (body ?? "").includes(TOP_LEVEL_COMMENT_MARKER);

/** A body with its marker removed, so a new comment compares against a posted one. */
export const unmarkedBody = (body: string): string =>
  body.split(TOP_LEVEL_COMMENT_MARKER).join("").trim();

/**
 * How many top-level comments one run may post. Two, because the channel's
 * stated purpose is narrow enough that a run with three separate things
 * belonging to no thread is a channel misfiring rather than a productive run.
 */
const MAX_TOP_LEVEL_COMMENTS = 2;

/**
 * Bound the channel mechanically, in the same spirit as `filterOutcomes`: the
 * prompt says silence is the default, and model behaviour is not something to
 * take on trust. Without this, nothing caps how many comments one run posts and
 * nothing dedupes against an earlier run's, so a PR taking three `agent:fix`
 * rounds can accumulate three copies of the same note — and three issues once
 * #79 harvests them.
 *
 * `alreadyPosted` is the bodies of marked comments already on the PR. The
 * comparison is exact after stripping the marker and trimming, so it catches a
 * verbatim repeat and not a reworded one; the cap, not the dedupe, is the real
 * bound. Kept bodies come back stamped, since the marker is what makes both
 * this dedupe and the `conversation` filter possible.
 */
export const filterTopLevelComments = (
  comments: readonly TopLevelComment[],
  alreadyPosted: readonly string[] = [],
): TopLevelComment[] => {
  const seen = new Set(alreadyPosted.map(unmarkedBody));
  const kept: TopLevelComment[] = [];
  let overCap = 0;
  for (const comment of comments) {
    const body = unmarkedBody(comment.body);
    if (body.length === 0) {
      console.warn("Dropping a top-level comment that is empty once its marker is removed.");
      continue;
    }
    if (seen.has(body)) {
      console.warn("Dropping a top-level comment already posted on this PR.");
      continue;
    }
    seen.add(body);
    if (kept.length >= MAX_TOP_LEVEL_COMMENTS) {
      overCap += 1;
      continue;
    }
    kept.push({ body: `${body}\n\n${TOP_LEVEL_COMMENT_MARKER}` });
  }
  if (overCap > 0) {
    console.warn(`Dropping ${overCap} top-level comment(s) beyond the cap of ${MAX_TOP_LEVEL_COMMENTS}.`);
  }
  return kept;
};
