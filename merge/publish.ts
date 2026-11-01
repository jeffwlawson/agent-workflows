import { GitHubError } from "../engine/github.js";
import { WriteFailed, type Limits } from "../engine/writer.js";
import { describe, pullRequestNumber, tolerated } from "../shared/command-helpers.js";
import type { CommandIo } from "../shared/command-io.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { choice, json, matching, object, optional, readDirectory } from "../shared/hand-over.js";
import { MERGE_LABEL } from "../shared/record.js";

type Declared = (typeof COMMANDS)["merge:publish"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * `merge:publish` (#588): the merge `merge:gate` decided, and nothing else.
 *
 * On `merge` it squash-merges the pull request **guarded on the head the gate
 * checked**, so a head that moved in between is refused by GitHub rather than
 * merged on an old decision. The title is the pull request's title and
 * ` (#<n>)`, what GitHub's own default gives a pull request of more than one
 * commit, passed so a one-commit pull request gets the same. The message is
 * left to the repository's squash setting, so the commit carries what a
 * human's squash would. Made with the loop's token: a merge with the workflow
 * token starts no workflow, so neither CI on the base nor the follow-ups would
 * run. Then `agent:merge` off, tolerated: a merged pull request's label is
 * history, not a decision still standing.
 *
 * A merge GitHub refuses is thrown, with GitHub's reason, for
 * `merge:conclude` to say on the pull request. Nothing is retried: whether to
 * try again is a decision, and a decision is the maintainer's.
 *
 * On any other decision it does nothing: the gate said what there was to say.
 */
export const publish = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  // Read and checked before the first write.
  const gate = readDirectory(COMMANDS["merge:publish"].inputs.GATE_DIR, inputs.GATE_DIR, {
    "gate.json": json(object({ decision: choice(DECISIONS), head: optional(matching(/[0-9a-f]{40}/, "a full commit id")) })),
  })["gate.json"];
  if (gate.decision !== "merge") {
    console.log(`The gate decided \`${gate.decision}\`, so there is nothing to merge.`);
    return;
  }
  if (gate.head === undefined) throw new Error("The gate decided to merge but named no head to guard the merge on, so nothing was merged.");

  const { title } = await io.github.pullRequest(pr);
  const { workflow, loop } = io.writers(LIMITS);
  try {
    const merged = await loop.mergePullRequest({ pr, sha: gate.head, title: `${title} (#${pr})` });
    console.log(`Merged PR #${pr} at ${gate.head} as ${merged.sha}.`);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    const answer = error.cause instanceof GitHubError ? error.cause.reason : describe(error);
    throw new Error(
      `GitHub refused to squash-merge \`${gate.head}\`, answering "${answer.replace(/[.\s]+$/, "")}", so nothing was merged. A head that moved is no longer the armed commit; otherwise the repository's squash setting, a ruleset or a conflict is what to fix.`,
      { cause: error },
    );
  }
  await tolerated(`PR #${pr} merged, but \`${MERGE_LABEL}\` could not be taken off it.`, () => workflow.removeLabel(pr, MERGE_LABEL));
};

const DECISIONS = ["merge", "wait", "behind", "red", "disarmed", "refused"] as const;

/** What publish may write, and how many of each (ADR 0005): the merge, and `agent:merge` off. */
const LIMITS: Limits = { mergePullRequest: 1, removeLabel: 1 };
