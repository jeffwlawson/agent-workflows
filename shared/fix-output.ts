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

export interface FixOutput {
  readonly threadOutcomes: ThreadOutcome[];
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

export const fixOutputSchema = standardSchema<FixOutput>((value) => {
  const record = asRecord(value, "fix output");
  return {
    threadOutcomes: asArray(record["threadOutcomes"] ?? [], "threadOutcomes").map(parseOutcome),
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
