import { asRecord, asString } from "./common.js";
import { parseFindingMarkers } from "./review-findings.js";

/**
 * A finding an earlier review of this pull request raised and **nothing has yet
 * verified as fixed**.
 *
 * It is carried rather than re-found: the id was written by the workflow when
 * the finding was first posted (#110) and is read back off the surface it was
 * posted on, so a finding survives being reworded, re-anchored, or answered by
 * a fix run that reworded it again. Text is never matched across rounds.
 *
 * Every review is handed these, round 1 included (#109, decision 1). A human
 * may have pushed the fix, and the question "is this still true of the code in
 * front of me" has the same answer whoever wrote the commit.
 */
export interface CarriedFinding {
  /** The identifier the workflow wrote when the finding was first posted. */
  readonly id: string;
  /**
   * The thread it lives in, and the thing this file exists to be able to
   * resolve. Absent for a finding recorded in the review body, which is where
   * a finding in a file the pull request never touched goes — there is no diff
   * line for GitHub to hang a thread on, so there is nothing to close.
   */
  readonly threadId?: string;
  /** One line: where it is and what it claims, as the review that raised it wrote it. */
  readonly text: string;
}

/**
 * An open review thread this loop opened, read off the pull request by
 * `pr-feedback.ts`.
 *
 * Separate from `CarriedFinding` because the two answer different questions: a
 * thread is a surface GitHub has, and a carried finding is a claim about the
 * code that may be recorded on one of two surfaces. The body entries have no
 * thread at all, and collapsing them would make `threadId` a lie for half the
 * list.
 */
export interface AgentThread {
  readonly threadId: string;
  readonly findingId: string;
  /** Where the thread is anchored and what its first comment claims. */
  readonly text: string;
}

/**
 * Everything an earlier review of this pull request left open, from the two
 * surfaces a finding can be posted on.
 *
 * Only the **latest** review body is read, and that is what makes the body a
 * record rather than an archive: each review re-lists what it verified as still
 * open, so the newest body is the current statement and an older one is the
 * statement it replaced. Reading them all would re-raise every finding a later
 * round already closed.
 *
 * The body half carries only the findings with no thread, because a threaded
 * finding's id is deliberately left off the body (`renderStillOpen`): the
 * thread is its record, and a maintainer who resolves one by hand has settled
 * it. So the two sources should be disjoint. **The thread still wins** where
 * they are not — a body posted by another version, or an id somehow written
 * twice — because taking the body's copy would leave a landed finding with no
 * `threadId` and so nothing to resolve, which is the failure that looks like
 * everything working.
 */
export const carriedFindings = (parts: {
  readonly threads: readonly AgentThread[];
  readonly latestReviewBody: string;
}): CarriedFinding[] => {
  const seen = new Set<string>();
  const carried: CarriedFinding[] = [];

  for (const thread of parts.threads) {
    if (seen.has(thread.findingId)) continue;
    seen.add(thread.findingId);
    carried.push({ id: thread.findingId, threadId: thread.threadId, text: thread.text });
  }

  for (const entry of parseFindingMarkers(parts.latestReviewBody)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    carried.push({ id: entry.id, text: entry.text });
  }

  return carried;
};

/** Said where there is nothing to verify, so the absence is a statement rather than a gap. */
const NOTHING_CARRIED =
  "(no finding from an earlier review of this pull request is open — either this is the first review, or every earlier finding has been verified fixed.)";

/**
 * The open findings as the review agent is shown them: one line each, the id
 * first.
 *
 * The id is what the agent answers on, so it leads. What follows it is the
 * earlier review's own one-line claim — enough to know which finding is meant,
 * and not a re-statement of the evidence, which is still on the thread the
 * agent can read in the feedback it was already given.
 */
export const renderCarriedFindings = (carried: readonly CarriedFinding[]): string =>
  carried.length === 0
    ? NOTHING_CARRIED
    : carried.map((finding) => `- \`${finding.id}\` — ${finding.text}`).join("\n");

/**
 * What a review says about one carried finding.
 *
 * Two values and no third. *Partly* is the value that is not here on purpose:
 * a finding that is half fixed is a finding, and the surface it is open on is
 * the place to say what is left. A third value would have to decide whether it
 * closes the thread, and either answer is one of the two below written less
 * plainly.
 */
export type VerificationStatus = "landed" | "open";

export interface VerificationEntry {
  /** The id, exactly as it was given. One this file did not hand over is dropped. */
  readonly id: string;
  readonly status: VerificationStatus;
  /**
   * Why, in one line — posted into the thread as the reply that records the
   * resolution.
   *
   * Optional, and defaulted rather than required, for the reason a missing
   * title is: this is display. Refusing the output over it would lose the whole
   * review, including the verification it is part of.
   */
  readonly note?: string;
}

export const parseVerification = (value: unknown): VerificationEntry => {
  const record = asRecord(value, "verification");
  const status = asString(record["status"], "verification status");
  if (status !== "landed" && status !== "open") {
    throw new Error(`verification status must be "landed" or "open", got "${status}"`);
  }

  const note = record["note"] ?? record["why"];
  return {
    id: asString(record["id"] ?? record["findingId"] ?? record["finding_id"], "verification id"),
    status,
    ...(typeof note === "string" && note.trim() !== "" ? { note: note.trim() } : {}),
  };
};

/** One thread the workflow closes, with the reply that records why. */
export interface ThreadResolution {
  readonly threadId: string;
  /** Carried for the log and for a human reading the file, never sent to GitHub. */
  readonly findingId: string;
  readonly reply: string;
}

/** Said in the reply where the review verified the fix but wrote nothing about it. */
const NO_NOTE = "The current change resolves this.";

/**
 * The reply posted into a thread as it closes.
 *
 * It says who closed it, because that is the part a reader cannot see: GitHub
 * records `resolutionReason` and exposes it nowhere afterwards (#109), so the
 * reply is the only record that this thread was closed by a review that read
 * the code rather than by the run that claimed to have fixed it.
 */
export const resolutionReply = (entry: VerificationEntry): string =>
  `**Verified fixed.** ${entry.note ?? NO_NOTE}\n\n_Resolved by the review that checked it, rather than by the run that fixed it._`;

/**
 * What the review's verification means for each carried finding: the threads to
 * close, and the findings still owed.
 *
 * **Silence is "still open".** A carried finding the review said nothing about
 * stays open and counts, rather than being taken as settled — the same
 * direction every other unreadable thing in this loop fails in. A review that
 * ran out of attention before it reached the last finding must not thereby
 * close it, and the cost of the other reading is a thread that vanishes with
 * nobody having checked it.
 *
 * An id nobody handed over is dropped, for the reason `filterOutcomes` drops an
 * invented thread id: models invent plausible-looking ones, and an invented id
 * here would either resolve nothing or — if it collided — close a finding the
 * review never looked at.
 *
 * A **landed body entry** produces no resolution and no still-open entry. There
 * is no thread to close, so it simply stops being re-listed, which is how a
 * body-recorded finding closes.
 */
export const verifyCarried = (
  carried: readonly CarriedFinding[],
  verified: readonly VerificationEntry[],
): { resolutions: ThreadResolution[]; stillOpen: CarriedFinding[] } => {
  const known = new Map(carried.map((finding) => [finding.id, finding] as const));
  const reported = new Map<string, VerificationEntry>();

  for (const entry of verified) {
    if (!known.has(entry.id)) {
      console.warn(`Dropping a verification of unknown finding ${entry.id}.`);
      continue;
    }
    if (reported.has(entry.id)) {
      console.warn(`Dropping a duplicate verification of finding ${entry.id}.`);
      continue;
    }
    reported.set(entry.id, entry);
  }

  const resolutions: ThreadResolution[] = [];
  const stillOpen: CarriedFinding[] = [];

  for (const finding of carried) {
    const entry = reported.get(finding.id);
    if (entry === undefined) {
      console.warn(`Finding ${finding.id} was not verified either way; it stays open.`);
      stillOpen.push(finding);
      continue;
    }
    if (entry.status === "open") {
      stillOpen.push(finding);
      continue;
    }
    if (finding.threadId !== undefined) {
      resolutions.push({
        threadId: finding.threadId,
        findingId: finding.id,
        reply: resolutionReply(entry),
      });
    }
  }

  return { resolutions, stillOpen };
};
