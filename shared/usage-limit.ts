import type { GitHubReader } from "../engine/read.js";
import { isWorkflowBot, type LoopAccounts } from "./loop-accounts.js";
import { RESUME_NOTE_MARKER, SERVICE_ORCHESTRATOR } from "./record.js";

/**
 * **A run the plan's usage limit stopped** (#635): not a failure, but a wait.
 * The agent's CLI ends such a run with a message like `You've hit your session
 * limit · resets 5:50am (UTC)`, which reaches the runner's
 * `failure_reason.txt` through `fail()`. Every kind that starts an agent reads
 * it here from its conclude command, and the service's worker reads it to
 * hold its agent lane until the reset.
 *
 * Imports nothing that loads the agent SDK: a command loads this.
 */

/**
 * The CLI's message, as seen: `hit your <kind> limit · resets <h>[:<mm>]<am|pm> (UTC)`.
 * Narrow on purpose. Any other shape, a zone other than UTC included, is not
 * this ending, and the run ends as any other stopped run does.
 */
const LIMIT_MESSAGE = /hit your [a-z][a-z -]* limit · resets ([0-9]{1,2})(?::([0-9]{2}))?(am|pm) \(UTC\)/i;

/**
 * How long past the stated time a reader still takes it as today's reset.
 * The message is read after the CLI wrote it: by the worker as the runner
 * ends, by conclude a phase or a job later, each on its own host's clock. A
 * run that stopped at 05:49 on `resets 5:50am (UTC)` and is read at 05:51 has
 * a reset that just passed, not one a day ahead. The CLI states no reset more
 * than a session window ahead, so a time this recently past is never
 * tomorrow's.
 */
export const RESET_GRACE_MINUTES = 60;

/**
 * The instant the plan's usage limit resets, read off a failure `reason`, or
 * `undefined` where the reason is not the CLI's usage-limit message. The
 * message gives a time of day and no date, so the answer is the **next** such
 * instant after `readAt`, less `RESET_GRACE_MINUTES`: later today, today's
 * where it passed within the grace, or tomorrow where it passed before that.
 * So every reader of one message answers the same instant, read within the
 * grace of it on whichever host's clock.
 */
export const usageLimitReset = (reason: string | undefined, readAt: Date): Date | undefined => {
  if (reason === undefined) return undefined;
  const match = LIMIT_MESSAGE.exec(reason);
  if (match === null || match[1] === undefined || match[3] === undefined) return undefined;
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const hours = (hour % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
  const after = readAt.getTime() - RESET_GRACE_MINUTES * 60_000;
  const at = new Date(Date.UTC(readAt.getUTCFullYear(), readAt.getUTCMonth(), readAt.getUTCDate(), hours, minute));
  if (at.getTime() <= after) at.setUTCDate(at.getUTCDate() + 1);
  else if (at.getTime() - after > 24 * 60 * 60_000) at.setUTCDate(at.getUTCDate() - 1);
  return at;
};

/** A resume note's two instants, as its marker names them. */
export interface ResumeNote {
  /** The reset instant the item waits for. */
  readonly until: Date;
  /** When the run that posted it stopped. */
  readonly stopped: Date;
}

const ISO = String.raw`([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z)`;
const RESUME_NOTE = new RegExp(String.raw`<!-- ${RESUME_NOTE_MARKER} ${ISO} stopped ${ISO} -->`);

/**
 * The newest resume note among `comments`, oldest first as GitHub lists them,
 * read only off one the loop's accounts posted; `undefined` where there is
 * none.
 */
export const newestResumeNote = (
  comments: readonly { readonly body: string; readonly author: string }[],
  accounts: LoopAccounts,
): ResumeNote | undefined => {
  for (const comment of [...comments].reverse()) {
    if (!isWorkflowBot(comment.author, accounts)) continue;
    const match = RESUME_NOTE.exec(comment.body);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    return { until: new Date(match[1]), stopped: new Date(match[2]) };
  }
  return undefined;
};

/** How a run the plan's usage limit stopped ends: `resumes` on the service, `waits` for a person on Actions. */
export interface LimitEnding {
  readonly kind: "resumes" | "waits";
  readonly until: Date;
  /** When the run ended, which a resume note names. */
  readonly stopped: Date;
}

/**
 * **Which ending a stopped run takes**, from its `reason`: `undefined` where
 * it is not the plan's usage limit, and the run ends as any stopped run does.
 *
 * - **On Actions** (`orchestrator` anything but `SERVICE_ORCHESTRATOR`) it
 *   `waits` for a person: nothing there schedules a resume.
 * - **On the service** it `resumes`, but once per request: an item whose
 *   newest resume note, from one of the loop's accounts, is newer than the
 *   latest time anyone added `label` has had its automatic resume, and ends
 *   as any stopped run does. The resume itself adds no label, since the label
 *   stayed on, so a stop after it with no add between is the same request
 *   stopping twice. Any add after the note is a new request, a person's or
 *   the loop's own (the App re-adds `agent:review`, `agent:fix` and a PRD
 *   parent's `agent:implement` as the chain moves on), and allows one more.
 *   A record that cannot be read ends it so too, the direction that cannot
 *   resume without bound.
 */
export const limitEnding = async ({
  reason,
  orchestrator,
  item,
  label,
  github,
  accounts,
  now,
}: {
  readonly reason: string | undefined;
  readonly orchestrator: string;
  readonly item: number;
  readonly label: string;
  readonly github: Pick<GitHubReader, "authoredComments" | "labelledAt">;
  readonly accounts: LoopAccounts;
  readonly now: Date;
}): Promise<LimitEnding | undefined> => {
  const until = usageLimitReset(reason, now);
  if (until === undefined) return undefined;
  if (orchestrator !== SERVICE_ORCHESTRATOR) return { kind: "waits", until, stopped: now };
  try {
    const [comments, added] = await Promise.all([github.authoredComments(item), github.labelledAt(item, label)]);
    const note = newestResumeNote(comments, accounts);
    const asked = Math.max(-Infinity, ...added.map((at) => Date.parse(at)));
    if (note !== undefined && note.stopped.getTime() > asked) {
      console.log(
        `#${item} has already resumed once after the plan's usage limit since ${label} was last added, so this stop ends as any other: adding ${label} again allows one more.`,
      );
      return undefined;
    }
  } catch (error) {
    console.log(
      `::warning::Whether #${item} has already resumed after the plan's usage limit could not be read (${error instanceof Error ? error.message : String(error)}), so this stop ends as any other.`,
    );
    return undefined;
  }
  return { kind: "resumes", until, stopped: now };
};
