import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import {
  fail,
  git,
  readInputs,
  readLoopAccounts,
  scrubGitHubTokens,
  sh,
  writers,
} from "../shared/common.js";
import { agentSandbox, claudeAgent, runWithExtraction, usageLedger } from "../shared/agent.js";
import { RUNNERS } from "../shared/contract.js";
import { filterOutOfScopeNotes } from "../shared/fix-notes.js";
import { filterConversationOutcomes, filterOutcomes, filterTopLevelComments, fixOutputSchema } from "../shared/fix-output.js";
import {
  describeUnreadable,
  fetchPullRequestFeedback,
  nothingToActOn,
  refusalReason,
  renderMinorFindingsForFix,
  surfaceText,
} from "../shared/pr-feedback.js";
import { firstLine, readPrdBranch } from "../shared/prd-round.js";
import { fixHeader, fixScope, readRoundRecord, roundCounts } from "../shared/round-header.js";
import { rescueRef, resumeFromRescue, resumeSection } from "../shared/rescue.js";
import type { SliceRanges } from "../shared/slice-ranges.js";

const INPUTS = readInputs(RUNNERS["fix"].inputs);
/** Chosen at start, so a sandbox that cannot run the agent stops the run before any of its work. */
const SANDBOX = agentSandbox(INPUTS);
const LOOP_ACCOUNTS = readLoopAccounts(INPUTS.AGENT_LOOP_LOGINS);
const { writeJson, writeText } = writers(RUNNERS["fix"].outputs);
/** What the agent spent, pass by pass (#637). */
const USAGE = usageLedger((usage) => writeJson("usage.json", usage));

const PR_NUMBER = INPUTS.PR_NUMBER;
const BRANCH = INPUTS.BRANCH;

/**
 * Where a run of this pull request that stopped before it finished left its
 * commits (#303), and where this one looks for them to resume from.
 */
const RESCUE_BRANCH = INPUTS.RESCUE_BRANCH;

/**
 * The header this run's top-level comments open with (#298): which slice and
 * which fix round, numbered off the pull request's record, or which fix round
 * of a regular pull request. Undefined where the record cannot be read, and
 * the comments go out without one rather than with a number guessed.
 *
 * Handed over as plain text, `round_header.txt`, for `fix:publish` to put on
 * each comment, which checks it has the header's shape. Nothing reads a fix
 * comment's header back to count rounds, so the runner's text is safe there.
 */
const readFixHeader = (): string | undefined => {
  try {
    const parent = /^agent\/prd-(\d+)-/.exec(BRANCH)?.[1];
    const record = readRoundRecord(INPUTS.GH_REPO, PR_NUMBER);
    // A PRD branch that cannot be read leaves the reviews' own headers to
    // place this run, which they do for every review that carries one.
    let ranges: SliceRanges | undefined;
    if (parent !== undefined) {
      try {
        ranges = readPrdBranch(INPUTS.GH_REPO, parent, INPUTS.BASE_REF).ranges;
      } catch (error) {
        console.log(`::warning::The PRD branch could not be read, so this run is placed by the reviews' headers: ${firstLine(error)}`);
      }
    }
    const prd = parent !== undefined;
    return fixHeader(fixScope(record, LOOP_ACCOUNTS, ranges, prd), roundCounts(record, LOOP_ACCOUNTS, ranges, prd));
  } catch (error) {
    console.log(`::warning::This pull request's rounds could not be read, so this run's comments are not numbered: ${firstLine(error)}`);
    return undefined;
  }
};

try {
  const feedback = fetchPullRequestFeedback(INPUTS.GH_REPO, PR_NUMBER, INPUTS.BASE_REF, LOOP_ACCOUNTS);

  // Said in the log whether or not it is a reason to stop, because a run that
  // proceeded on a partial answer is one someone will later ask about.
  if (feedback.unreadable.length > 0) {
    console.log(
      `Feedback selections that could not be read: ${describeUnreadable(feedback.unreadable)}`,
    );
  }

  // This is the run that pushes, so it refuses where a review degrades. The
  // decision lives with the fetch: a refused selection, a refused selection
  // the author gate reads, and no answer at all are different reasons, and a
  // human can only act on one of them if it is named (#76). `fail()` puts
  // whichever it is on the PR.
  const refusal = refusalReason(feedback);
  if (refusal) fail(refusal);

  // Not a failure (#253): every surface was read and none of it is owed an
  // answer, so there is nothing to do. The workflow posts a note rather than a
  // failure, and adds no `agent:blocked`; this file is how it tells.
  if (nothingToActOn(feedback)) {
    writeText("nothing_to_do.txt", "");
    console.log("Nothing to act on: no open review findings or comments are owed an answer.");
    process.exit(0);
  }
  console.log(`Minor findings handed over: ${feedback.minorFindings.length}.`);

  const header = readFixHeader();
  console.log(`Header: ${header ?? "none, since the rounds could not be read"}.`);
  if (header !== undefined) writeText("round_header.txt", header);

  // Context is gathered; the agent must not hold the GitHub token. This matters
  // more here than anywhere else — this workflow can push.
  scrubGitHubTokens();

  const before = sh("git rev-parse HEAD").trim();

  // An earlier run's unpushed commits (#303), where they still build on the
  // head this run was started for. Set aside, and said so on the pull
  // request by `fix:publish`, where the head moved since they were saved:
  // handed over as the branch and its tip, the commit this run moved past.
  const resume = resumeFromRescue(RESCUE_BRANCH);
  if (resume.kind === "resumed") {
    console.log(`Resuming from ${resume.commits} commit(s) an earlier run saved on ${RESCUE_BRANCH}.`);
  } else if (resume.kind === "ignored") {
    console.log(`::warning::${RESCUE_BRANCH} was saved on an older head of ${BRANCH}, so this run starts fresh.`);
    writeJson("rescue_ignored.json", { branch: RESCUE_BRANCH, movedPast: git(["rev-parse", rescueRef(RESCUE_BRANCH)]).trim() });
  }

  const result = await runWithExtraction({
    name: `fix-${PR_NUMBER}`,
    agent: claudeAgent("fix", INPUTS),
    usage: USAGE,
    ...SANDBOX,
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      PR_NUMBER,
      BRANCH,
      // Each surface as the agent should see it: its text, or a named refusal
      // where the API would not answer — never "(none)" for both, which is the
      // same collapse one level down from the fetch.
      REVIEW_SUMMARIES: surfaceText(feedback, "summaries"),
      INLINE_COMMENTS: surfaceText(feedback, "inline"),
      CONVERSATION: surfaceText(feedback, "conversation"),
      // The minor findings the newest review records (#616): this pull
      // request's own code, below the repository's threshold, with no thread
      // to answer. Their own section, since no outcome is owed on them.
      MINOR_FINDINGS: renderMinorFindingsForFix(feedback.minorFindings),
      PR_DIFF: feedback.diff,
      RESUME: resumeSection(resume, RESCUE_BRANCH),
    },
    output: sandcastle.Output.object({ tag: "output", schema: fixOutputSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, "extraction.md"), "utf8"),
  });

  const outcomes = filterOutcomes(result.output.threadOutcomes, feedback.threadIds);
  writeJson("thread_outcomes.json", outcomes);

  // The same report for the surface with no threads to reply into (#104). One
  // comment per run rather than one per outcome, rendered and posted by
  // `fix:publish`, which reads each comment's author and link from GitHub
  // itself. Written unconditionally, an empty list when there is nothing to
  // record.
  const conversationOutcomes = filterConversationOutcomes(
    result.output.conversationOutcomes,
    feedback.conversationComments.map((comment) => comment.commentId),
  );
  writeJson("conversation_outcomes.json", conversationOutcomes);

  // Findings that belong to no thread, capped and deduped against what earlier
  // runs already posted, as their text alone. Written unconditionally: an
  // empty list is the normal case, and `fix:publish` posts nothing for it.
  const topLevelComments = filterTopLevelComments(
    result.output.topLevelComments,
    feedback.priorTopLevelComments,
  );
  writeJson("top_level_comments.json", topLevelComments);

  // What the run noticed outside this pull request's scope (#213), capped and
  // deduped against the notes earlier runs posted, as each note's fields.
  // Written unconditionally like the comments above. `fix:publish` renders and
  // posts them, and a run that posted one asks for the review that rules on it.
  const outOfScopeNotes = filterOutOfScopeNotes(
    result.output.outOfScopeNotes,
    feedback.priorOutOfScopeNotes,
  );
  writeJson("out_of_scope_notes.json", outOfScopeNotes);

  const after = sh("git rev-parse HEAD").trim();
  if (before === after) {
    // Not a failure: the agent may have judged every comment already handled or
    // not worth acting on. It still owes replies, which the workflow posts.
    console.log("Agent made no commits, so there is nothing to push.");
  } else {
    // `HEAD` moving is not the agent committing (#188). An agent that fetched
    // the branch and fast-forwarded onto commits already there moves `HEAD`
    // too, and calling that a commit contradicted the push step's "nothing to
    // push" one line later. Counted the way that step counts — what is on
    // `HEAD` and not on the branch it pushes to.
    const made = Number(git(["rev-list", "--count", `refs/remotes/origin/${BRANCH}..HEAD`]).trim());
    console.log(
      made === 0
        ? `Agent made no commits; HEAD fast-forwarded on ${BRANCH} to a commit already on the remote ` +
            `(${before.slice(0, 7)} -> ${after.slice(0, 7)}) and there is nothing to push.`
        : `Agent committed ${made} commit(s) on ${BRANCH} (${before.slice(0, 7)} -> ${after.slice(0, 7)}).`,
    );
  }
  console.log(
    `Thread outcomes: ${outcomes.filter((o) => o.status === "addressed").length} addressed, ` +
      `${outcomes.filter((o) => o.status === "declined").length} declined ` +
      `(${result.output.threadOutcomes.length} produced, ${outcomes.length} kept).`,
  );
  // Said whichever way it went, because "nothing was reported" and "there was
  // nothing to report" are the two this slice exists to tell apart — a decline
  // that never reached the pull request is only visible here.
  const declined = conversationOutcomes.filter((o) => o.status === "declined").length;
  console.log(
    feedback.conversationComments.length === 0
      ? "Conversation comments: none shown, so no outcome to record."
      : `Conversation outcomes: ${conversationOutcomes.length - declined} addressed, ` +
        `${declined} declined (${result.output.conversationOutcomes.length} produced, ` +
        `${conversationOutcomes.length} kept, ${feedback.conversationComments.length} shown).`,
  );
  const produced = result.output.topLevelComments.length;
  console.log(
    topLevelComments.length > 0
      ? `Top-level comments: ${topLevelComments.length} to post (${produced} produced).`
      : produced === 0
        ? "Top-level comments: none, nothing outside the threads."
        : `Top-level comments: none posted (${produced} produced, all dropped; see warnings above).`,
  );
  const noted = result.output.outOfScopeNotes.length;
  console.log(
    outOfScopeNotes.length > 0
      ? `Out-of-scope notes: ${outOfScopeNotes.length} to post (${noted} produced), for the next review to rule on.`
      : noted === 0
        ? "Out-of-scope notes: none."
        : `Out-of-scope notes: none posted (${noted} produced, all dropped; see warnings above).`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
