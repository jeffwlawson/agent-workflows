import { asRecord, asString } from "./common.js";
import { parseFindingMarkers, type Severity } from "./review-findings.js";

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
   * resolve.
   *
   * Absent for a **body entry**, which nothing writes any more: a finding in a
   * file the pull request never touched used to be recorded in the review body
   * for want of a diff line to hang a thread on, and since #127 it is anchored
   * at the change that causes it or recorded as a follow-up instead. What still
   * arrives with no thread is one of those entries on a pull request that was
   * already open when this version landed (#127, decision 5) — carried and
   * verified exactly as before, with nothing to close when it lands.
   */
  readonly threadId?: string;
  /** One line: where it is and what it claims, as the review that raised it wrote it. */
  readonly text: string;
  /**
   * The rating the review that raised it gave it, read back off the marker the
   * workflow wrote (#109, decision 9). Absent where the finding was posted by a
   * release that wrote no severity, which the record renders as a badge-less
   * entry rather than inventing one.
   *
   * Never re-rated here. Severity is the judgement of the review that found the
   * problem, and a later round that quietly moved it would make the record
   * disagree with the thread it came from.
   */
  readonly severity?: Severity;
  /**
   * A link to the thread it lives in, where the response carried one — the
   * record entry's link back to where it was raised (#109, decision 8).
   *
   * It matters most here rather than on a fresh finding: a fresh finding's
   * thread is opened by the same mutation that posts the body, so its URL does
   * not exist yet, and its thread renders directly beneath that review anyway.
   * A carried one's thread sits under an older review, which is where a reader
   * has to be taken rather than told to scroll.
   */
  readonly url?: string;
  /**
   * A maintainer's own word on this finding, where one of them answered the
   * thread it lives in (#109, decision 10).
   *
   * Present only where the reply passed the author gate, which is what makes it
   * usable as a permission rather than as evidence: a review may rule a finding
   * `declined`, and that ruling closes the thread **only** if a maintainer is
   * on record here. Every feedback surface is world-writable, so a decline the
   * gate did not pass is a stranger's, and a loop that closed its own findings
   * on one would be taking instructions from the pull request it is reviewing.
   */
  readonly maintainerReply?: MaintainerReply;
}

/**
 * What a maintainer said on one of this loop's threads, and who they were.
 *
 * Both halves are quoted into the reply that closes the thread. GitHub records
 * `resolutionReason` and exposes it nowhere afterwards (#109), so a thread
 * closed as `WONT_FIX` has nothing on it saying whose decision that was unless
 * the reply carries it — and "the reviewer decided not to pursue its own
 * finding" and "the maintainer declined it" are the two readings that must not
 * collapse.
 */
export interface MaintainerReply {
  readonly login: string;
  readonly body: string;
}

/**
 * An open review thread this loop opened, read off the pull request by
 * `pr-feedback.ts`.
 *
 * Separate from `CarriedFinding` because the two answer different questions: a
 * thread is a surface GitHub has, and a carried finding is a claim about the
 * code, which a legacy body entry records without one. Collapsing them would
 * make `threadId` a lie for those.
 */
export interface AgentThread {
  readonly threadId: string;
  readonly findingId: string;
  /** Where the thread is anchored and what its first comment claims. */
  readonly text: string;
  /** The rating on the marker the review that raised it wrote, where it carries one. */
  readonly severity?: Severity;
  /** The thread's own permalink, where the response carried one. */
  readonly url?: string;
  /**
   * The **latest** thing a maintainer said on it, where one of them did — and
   * the only reply a review may rule `declined` on, which is what keeps the
   * reply the review read and the reply the thread closes on one comment. See
   * `maintainerReplyOn` in `shared/pr-feedback.ts`.
   */
  readonly maintainerReply?: MaintainerReply;
}

/**
 * A finding a **human** closed, read off a thread this loop opened whose
 * `resolvedBy` is somebody other than the workflow bot (#109, decision 10).
 *
 * Not a `CarriedFinding`, and the difference is the whole point: a carried
 * finding is something this review is asked to rule on, and this is something
 * it is told not to. There is nothing left to verify and nothing left to close
 * — what it is handed for is so that it does not re-derive the same problem
 * from the diff and post it again, which is the one move that overrules a
 * maintainer without anybody deciding to.
 */
export interface SettledFinding {
  readonly findingId: string;
  /** Who closed it. Named in the prompt, so the reviewer can see it was not this loop. */
  readonly resolvedBy: string;
  /** One line: where it was and what it claimed, as the review that raised it wrote it. */
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
 * finding's id is deliberately left off the body (`carriedEntry`, in
 * `shared/review-output.ts`): the
 * thread is its record, and a maintainer who resolves one by hand has settled
 * it. Since #127 that half reads only what an older release wrote — a v0.4.0
 * body entry on a pull request open at the upgrade (decision 5) — and a body
 * this version posts carries an id only for one of those it is still carrying.
 * So the two sources should be disjoint. **The thread still wins** where
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
    carried.push({
      id: thread.findingId,
      threadId: thread.threadId,
      text: thread.text,
      ...(thread.severity === undefined ? {} : { severity: thread.severity }),
      ...(thread.url === undefined ? {} : { url: thread.url }),
      ...(thread.maintainerReply === undefined ? {} : { maintainerReply: thread.maintainerReply }),
    });
  }

  for (const entry of parseFindingMarkers(parts.latestReviewBody)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    carried.push({
      id: entry.id,
      text: entry.text,
      ...(entry.severity === undefined ? {} : { severity: entry.severity }),
    });
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

/** Said where no maintainer has closed anything, for the reason `NOTHING_CARRIED` is said. */
const NOTHING_SETTLED = "(no finding on this pull request has been closed by a maintainer.)";

/**
 * What a maintainer has already closed, as the review agent is shown it — and
 * the instruction that goes with it, which is the whole of why the section
 * exists (#109, decision 10).
 *
 * No identifier leads these, unlike `renderCarriedFindings`: there is nothing
 * for the review to answer about them, and an id in a list it may not respond
 * to is an invitation to respond. What it is given instead is who closed it and
 * what it said, which is what a reviewer needs to recognise the same problem if
 * it derives it again from the diff.
 *
 * *Including by rephrasing* is stated rather than implied. The record matches
 * findings by id and never by text (#109, decision 2), so a re-derived finding
 * gets a **new** id and nothing downstream can tell it is the settled one
 * coming back — this line is the only thing standing between a maintainer's
 * decision and a loop that re-litigates it every round.
 */
export const renderSettledFindings = (settled: readonly SettledFinding[]): string =>
  settled.length === 0
    ? NOTHING_SETTLED
    : [
        ...settled.map((finding) => `- ${finding.text} — closed by @${finding.resolvedBy}`),
        "",
        "Each of these is **settled by the maintainer**. Do not raise it again, in these words or in any others.",
      ].join("\n");

/**
 * What a review says about one carried finding.
 *
 * Two of these answer *did the code change*, and there is no third answer to
 * that question. *Partly* is the value that is not here on purpose: a finding
 * that is half fixed is a finding, and the surface it is open on is the place
 * to say what is left. A middle value would have to decide whether it closes
 * the thread, and either answer is one of the two below written less plainly.
 *
 * `declined` answers a different question, which is why it is a third value
 * rather than a shade of the other two (#109, decision 10; #112): a maintainer
 * replied on the thread saying they will not fix this, and the code is
 * therefore not going to change. The review reports what it read; whether that
 * reading closes anything is `verifyCarried`'s, and it does only where a
 * maintainer is on record.
 */
export type VerificationStatus = "landed" | "open" | "declined";

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
  if (status !== "landed" && status !== "open" && status !== "declined") {
    throw new Error(`verification status must be "landed", "open" or "declined", got "${status}"`);
  }

  const note = record["note"] ?? record["why"];
  return {
    id: asString(record["id"] ?? record["findingId"] ?? record["finding_id"], "verification id"),
    status,
    ...(typeof note === "string" && note.trim() !== "" ? { note: note.trim() } : {}),
  };
};

/**
 * Why a thread closed, in GitHub's own words for it.
 *
 * Two of the three `resolveReviewThread` takes. `INVALID` is the one left out:
 * a finding that was never real is one this loop has no way to establish — the
 * review that would say so is the same one that raised it — and a maintainer
 * saying it is arrives here as a decline, which is a `WONT_FIX` with a human
 * behind it rather than a judgement of its own.
 */
export type ResolutionReason = "ADDRESSED" | "WONT_FIX";

/** One thread the workflow closes, with the reason and the reply that record why. */
export interface ThreadResolution {
  readonly threadId: string;
  /** Carried for the log and for a human reading the file, never sent to GitHub. */
  readonly findingId: string;
  /**
   * What the workflow sends as `resolutionReason`. GitHub validates it and then
   * exposes it on no field at all, so it is the reply below — not this — that a
   * later reader can see; both are written so the two cannot disagree.
   */
  readonly reason: ResolutionReason;
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
 * The reply posted into a thread the maintainer declined.
 *
 * It is **their words, quoted**, and not the review's summary of them. The
 * review read a reply and judged it a decline; if it read wrong, a quote is
 * what lets the maintainer see that in one glance and reopen the thread, while
 * a paraphrase would close their thread under a sentence they did not write.
 *
 * What it quotes is the **latest** maintainer reply on the thread, which is the
 * only one a review may rule on (`maintainerReplyOn`), and it is written as
 * *this is the reply the review read as a refusal* rather than as *@x declined
 * this*. The difference is the whole of what this reply can honestly claim: no
 * field on a `VerificationEntry` names which comment the review read, so an
 * assertion about who decided would be this file inventing an attribution on a
 * thread where two people spoke. Stating the evidence instead leaves a
 * misreading legible — a quoted question is plainly not a decline — where an
 * attribution would put a maintainer's name on a decision they never took.
 *
 * Quoted line by line rather than as one block, so a reply carrying its own
 * blank lines, list or fence stays inside the quote instead of ending it half
 * way through.
 */
export const declineReply = (reply: MaintainerReply): string => {
  const quoted = reply.body
    .trim()
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

  return [
    `**Closed as won't fix.** This review read a maintainer's refusal on this thread. The latest maintainer reply on it, from @${reply.login}:`,
    "",
    quoted,
    "",
    "_Closed on a maintainer's reply, never on the review's own judgement — a review cannot decline a finding itself. If that reply was not a refusal, reopen this thread._",
  ].join("\n");
};

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
 * body-recorded finding closes. That arm is kept for the v0.4.0 entries still
 * in flight (#127, decision 5) — nothing writes a new one — and it is the whole
 * of what "carried and verified as before, until they close" means.
 *
 * A **declined** one closes too, as `WONT_FIX` rather than `ADDRESSED` — the
 * code did not change, the person who owns it decided — and stops counting
 * toward the verdict, which is what "the maintainer's decisions stick" costs
 * and is meant to cost. It closes only where a maintainer's reply reached this
 * far; see the gate inside.
 */
export const verifyCarried = (
  carried: readonly CarriedFinding[],
  verified: readonly VerificationEntry[],
): {
  resolutions: ThreadResolution[];
  stillOpen: CarriedFinding[];
  /**
   * Every carried finding that stopped being open on this round, whatever
   * closed it — the record's *Resolved since last review* (#109, decision 8).
   *
   * Not the same list as `resolutions`, and that is why it is a third field
   * rather than a projection of the second. A landed finding with no thread
   * produces no resolution at all, because there is nothing to close; it still
   * closed, and a reader is owed the line saying so. What the two lists agree
   * on is that neither includes a finding still owed.
   */
  resolved: CarriedFinding[];
} => {
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
  const resolved: CarriedFinding[] = [];

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
    if (entry.status === "declined") {
      // **The author gate, and the one place it is spent.** The review read
      // prose and called it a decline; what makes that closeable is not the
      // reading but the reply it read, which reaches here only where
      // `isTrustedAuthor` passed its author. So a decline with no maintainer
      // behind it — an untrusted stranger's, or one on a body-recorded finding
      // that has no thread for anybody to have replied on — leaves the finding
      // open and counting, which is the direction every other unreadable thing
      // in this loop fails in.
      if (finding.threadId === undefined || finding.maintainerReply === undefined) {
        console.warn(
          `Finding ${finding.id} was ruled declined, but no maintainer reply on it passed the author gate; it stays open.`,
        );
        stillOpen.push(finding);
        continue;
      }
      resolutions.push({
        threadId: finding.threadId,
        findingId: finding.id,
        reason: "WONT_FIX",
        reply: declineReply(finding.maintainerReply),
      });
      resolved.push(finding);
      continue;
    }
    if (finding.threadId !== undefined) {
      resolutions.push({
        threadId: finding.threadId,
        findingId: finding.id,
        reason: "ADDRESSED",
        reply: resolutionReply(entry),
      });
    }
    // Including a legacy body-recorded one, which has no thread and so no
    // resolution: it closes by no longer being re-listed, and the record is the
    // only place that closure is ever visible.
    resolved.push(finding);
  }

  return { resolutions, stillOpen, resolved };
};
