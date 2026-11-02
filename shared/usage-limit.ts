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
 * The instant the plan's usage limit resets, read off a failure `reason`, or
 * `undefined` where the reason is not the CLI's usage-limit message. The
 * message gives a time of day and no date, so the answer is the **next** such
 * instant after `endedAt`, the moment the run ended: later today, or tomorrow
 * where today's has passed.
 */
export const usageLimitReset = (reason: string | undefined, endedAt: Date): Date | undefined => {
  if (reason === undefined) return undefined;
  const match = LIMIT_MESSAGE.exec(reason);
  if (match === null || match[1] === undefined || match[3] === undefined) return undefined;
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const hours = (hour % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
  const at = new Date(Date.UTC(endedAt.getUTCFullYear(), endedAt.getUTCMonth(), endedAt.getUTCDate(), hours, minute));
  if (at.getTime() <= endedAt.getTime()) at.setUTCDate(at.getUTCDate() + 1);
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
 * - **On the service** it `resumes`, but once per item per limit window: an
 *   item whose newest resume note, from one of the loop's accounts, is newer
 *   than the latest time a person (an account not the loop's) added `label`
 *   has had its automatic resume, and ends as any stopped run does. So a
 *   person adding the label again allows one more. A record that cannot be
 *   read ends it so too, the direction that cannot resume without bound.
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
  readonly github: Pick<GitHubReader, "authoredComments" | "labelEvents">;
  readonly accounts: LoopAccounts;
  readonly now: Date;
}): Promise<LimitEnding | undefined> => {
  const until = usageLimitReset(reason, now);
  if (until === undefined) return undefined;
  if (orchestrator !== SERVICE_ORCHESTRATOR) return { kind: "waits", until, stopped: now };
  try {
    const [comments, events] = await Promise.all([github.authoredComments(item), github.labelEvents(item, label)]);
    const note = newestResumeNote(comments, accounts);
    const asked = Math.max(-Infinity, ...events.filter((event) => !isWorkflowBot(event.actor, accounts)).map((event) => Date.parse(event.at)));
    if (note !== undefined && note.stopped.getTime() > asked) {
      console.log(
        `#${item} has already resumed once after the plan's usage limit since a person last added ${label}, so this stop ends as any other: adding ${label} again allows one more.`,
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
