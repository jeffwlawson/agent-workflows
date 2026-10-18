/**
 * **The newest verdict of ours on a commit** (`docs/platform-spec.md` §4.3):
 * the `agent-review` status that stands, selected one way for every command
 * that reads it. `review:conclude` asks whether a newer verdict than its
 * review's stands on the head, and `update-branch:publish` (#484) copies the
 * one standing on the old head on to the merge commit a clean refresh makes.
 *
 * Two conditions, and the second is the one a port drops: the **context**, and
 * the **creator**. A status is a thing any token holding `statuses: write` can
 * post under any context it likes, so without the creator an outside
 * integration's `agent-review` would read as the loop's verdict, and a refresh
 * would launder it on to a commit no review has read. The creator is one of
 * the loop's accounts (`shared/loop-accounts.ts`): `github-actions[bot]` on
 * Actions, which is the bound the verdict history is safe under, and the App
 * the service posts as besides.
 *
 * Imports nothing that loads the agent SDK, so a command can load it.
 */
import type { CommitStatus } from "../engine/read.js";
import { isWorkflowBot, type LoopAccounts } from "./loop-accounts.js";
import { VERDICT_CONTEXT } from "./record.js";

/**
 * The newest `agent-review` status one of the loop's accounts posted, out of
 * `statuses`, every status on the commit, newest first, as the endpoint
 * documents them and `commitStatuses` reads every page of them: the first
 * match is the verdict that stands, not the first one ever posted. None of
 * ours is `undefined`, which is not the same as a read that failed: that is
 * the caller's to tell apart, before it has a list to hand in.
 */
export const newestVerdict = (statuses: readonly CommitStatus[], accounts: LoopAccounts): CommitStatus | undefined =>
  statuses.find((status) => status.context === VERDICT_CONTEXT && isWorkflowBot(status.creator, accounts));
