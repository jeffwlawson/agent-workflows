import { WriteFailed } from "../engine/writer.js";

/**
 * The small pieces every command spelled for itself: how a write the loop can
 * live without is made, how an error is said in a sentence, and how the
 * inputs every workflow shares are parsed. One copy each, so a command reads
 * as its own decisions and nothing else.
 */

/**
 * A write the loop can live without: made, or said as `warning`, where there
 * is one, when GitHub refused it. The failure stays in the write log either
 * way. Anything but a failed write, a limit reached included, still throws:
 * that is our own bug, never one to read past. Whether the write landed, for
 * the caller that says something different when it did not.
 */
export const tolerated = async (warning: string | undefined, write: () => Promise<unknown>): Promise<boolean> => {
  try {
    await write();
    return true;
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    if (warning !== undefined) console.log(`::warning::${warning}`);
    return false;
  }
};

/** `warning`, pointing the reader at the write log for what GitHub answered. */
export const inWriteLog = (warning: string): string => `${warning} GitHub's reply is in the write log.`;

export const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `value` as a number of seconds, the form every wait and poll input takes. */
export const seconds = (value: string, name: string): number => {
  if (!/^[0-9]{1,6}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a number of seconds.`);
  return Number(value);
};

/** `ISSUE_NUMBER` as a number. */
export const issueNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`ISSUE_NUMBER is ${JSON.stringify(value)}, which is not an issue number.`);
  return Number(value);
};

/** `PR_NUMBER` as a number. */
export const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};
