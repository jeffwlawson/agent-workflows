import type { CommitStatus } from "../engine/read.js";
import { DEFAULT_LOOP_ACCOUNT, MERGE_CONTEXT, readArmDescription } from "./record.js";

/**
 * An arm standing on a commit (ADR 0009): the `agent-merge` status the loop
 * token's account posted, and what its description says. `login` is absent
 * where the description names no one the loop can read; `at` where neither
 * the description nor the status gives a time.
 */
export interface Arm {
  readonly status: CommitStatus;
  readonly login?: string;
  readonly at?: string;
  readonly refreshes: number;
}

/** Two REST logins naming one account: compared without regard to case, as GitHub compares them. */
export const sameAccount = (a: string, b: string): boolean => a !== "" && a.toLowerCase() === b.toLowerCase();

/**
 * The arm standing on a commit, given its statuses newest first: the newest
 * `agent-merge` the loop token's account (`loopLogin`) posted, where it is
 * `success`. Anyone else's, and `github-actions[bot]`'s above all, is no arm,
 * whatever it says: any workflow in a pull request's own branch posts as that
 * account. Read by `merge:gate`, and by `update-branch:publish` to carry it,
 * so a count no one but the loop wrote is the only one either reads.
 *
 * An arm #588 wrote names the human alone: its count is 0, and its time is
 * the status's own.
 */
export const armOn = (statuses: readonly CommitStatus[], loopLogin: string): Arm | undefined => {
  if (sameAccount(loopLogin, DEFAULT_LOOP_ACCOUNT)) return undefined;
  const status = statuses.find((s) => s.context === MERGE_CONTEXT && sameAccount(s.creator, loopLogin));
  if (status === undefined || status.state !== "success") return undefined;
  const said = readArmDescription(status.description);
  const at = said?.at ?? status.createdAt?.replace(/\.[0-9]+Z$/, "Z");
  return {
    status,
    ...(said === undefined ? {} : { login: said.login }),
    ...(at === undefined ? {} : { at }),
    refreshes: said?.refreshes ?? 0,
  };
};
