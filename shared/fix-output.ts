import { asArray, asRecord, asString, standardSchema } from "./common.js";

/** What the fix agent decided about one review thread. */
export interface ThreadOutcome {
  /** GraphQL node id of the thread, taken verbatim from the feedback shown. */
  readonly threadId: string;
  /**
   * `addressed` — the comment's concern is satisfied in the current HEAD.
   * That includes work done by an *earlier* commit, not only by this run: a
   * thread with nothing outstanding should close regardless of which commit
   * settled it. The workflow replies and **resolves**.
   *
   * `declined` — you disagree, or deliberately are not acting. The workflow
   * replies with the reason and leaves the thread **open** so a human can push
   * back; resolving a decline would let the agent quietly bury a disagreement.
   *
   * The split is deliberately "is anything still outstanding?", not "did I
   * personally change something?". An earlier, narrower wording ("the code was
   * changed to satisfy the comment") made the agent classify already-handled
   * threads as declined, so they stayed open forever — reviving exactly the
   * accumulation this reply/resolve machinery exists to prevent.
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

export interface FixOutput {
  readonly threadOutcomes: ThreadOutcome[];
  readonly topLevelComments: TopLevelComment[];
}

const parseOutcome = (value: unknown): ThreadOutcome => {
  const record = asRecord(value, "thread outcome");
  const status = asString(record["status"], "thread outcome status");
  if (status !== "addressed" && status !== "declined") {
    throw new Error(`thread outcome status must be "addressed" or "declined", got "${status}"`);
  }
  return {
    threadId: asString(record["threadId"] ?? record["thread_id"], "thread outcome threadId"),
    status,
    reply: asString(record["reply"] ?? record["body"], "thread outcome reply"),
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

export const fixOutputSchema = standardSchema<FixOutput>((value) => {
  const record = asRecord(value, "fix output");
  return {
    threadOutcomes: asArray(record["threadOutcomes"] ?? [], "threadOutcomes").map(parseOutcome),
    topLevelComments: parseTopLevelComments(
      record["topLevelComments"] ?? record["top_level_comments"],
    ),
  };
});

/**
 * Drop outcomes naming a thread that was not shown to the agent.
 *
 * Models invent plausible-looking ids, and an invented one either fails the
 * mutation or — worse — resolves an unrelated thread. Only ids we actually
 * handed over are honoured. Duplicates are collapsed so a thread cannot be
 * replied to twice in one run.
 */
export const filterOutcomes = (
  outcomes: readonly ThreadOutcome[],
  knownThreadIds: readonly string[],
): ThreadOutcome[] => {
  const known = new Set(knownThreadIds);
  const seen = new Set<string>();
  return outcomes.filter((outcome) => {
    if (!known.has(outcome.threadId)) {
      console.warn(`Dropping outcome for unknown thread ${outcome.threadId}.`);
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
