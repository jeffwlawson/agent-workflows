import * as path from "node:path";
import { GitHubError } from "../engine/github.js";
import { GitError } from "../engine/git.js";
import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import type { CheckoutIo } from "../shared/command-io.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { MAX_OUT_OF_SCOPE_NOTES, renderOutOfScopeNote } from "../shared/fix-notes.js";
import { MAX_TOP_LEVEL_COMMENTS, renderConversationOutcomes, renderTopLevelComment } from "../shared/fix-output.js";
import { choice, json, list, matching, object, optional, readDirectory, target, text, type Parser } from "../shared/hand-over.js";
import { FIX_LABEL, PRD_BRANCH_PREFIX, REVIEW_LABEL } from "../shared/record.js";
import { ignoredNote } from "../shared/rescue.js";
import { headed, ROUND_HEADER } from "../shared/round-header.js";

type Declared = (typeof COMMANDS)["fix:publish"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CheckoutIo<Declared["outputs"]>;

/**
 * `fix:publish` (#468): the publish job's success arm, as a command. It
 * pushes the agent's commits, deletes the rescue branch, replies to the
 * threads, posts the conversation record, the top-level comments and the
 * out-of-scope notes, and then asks for the re-review or marks the pull
 * request ready, in that order and with the text the loop has always posted.
 * What happens after it, the rescue and the failure comment, is still the
 * publish job's YAML.
 *
 * **It writes every final string itself** (ADR 0007). The runner hands over
 * decisions and raw text: each outcome's id, status and reply, each comment's
 * text, each note's fields, the rescue it set aside, and the round header as
 * plain text. Every marker, every record and every note is composed here,
 * from text the readers give out cleaned. So the agent's runner, which can
 * write those files, cannot write a marker review or `follow-ups` reads back.
 *
 * **Everything it is aimed at, it found itself.** Every thread id has to be a
 * review thread on this pull request, and every conversation comment id a
 * comment on its conversation, whose author and link are taken from that
 * read and never from the hand-over, so the record cannot credit the wrong
 * person or link elsewhere. The bundle has to verify, hold exactly
 * `refs/heads/<BRANCH>`, and build on `HEAD_SHA`, the head the label's event
 * named, which no file the agent's job wrote can move (ADR 0006). All of it is
 * checked before the first write, so a hand-over that is wrong anywhere
 * writes nothing.
 *
 * Throws to stop, in a sentence a human can act on, which the CLI turns into
 * `fail()` and the publish job into the failure comment. A reply, a comment or
 * a note GitHub refuses is caught here, on purpose, as `continue-on-error`
 * tolerated it, said as a warning, and stays in the write log as a failure its
 * last line does not name. A failed push or `agent:review` add stops it.
 */
export const publish = async (inputs: Inputs, io: Io): Promise<void> => {
  const pr = pullRequestNumber(inputs.PR_NUMBER);
  const started = commit(inputs.HEAD_SHA, "HEAD_SHA");
  const branch = inputs.BRANCH;
  const finished = inputs.AGENT_RESULT === "success";

  // What the hand-over is checked against, read before it is: the threads and
  // the conversation comments on the pull request the number names.
  const threads = await read(`PR #${pr}'s review threads`, () => io.github.reviewThreadIds(pr));
  const comments = await read(`PR #${pr}'s conversation comments`, () => io.github.conversationComments(pr));
  const handOver = readDirectory(
    COMMANDS["fix:publish"].inputs.FIX_DIR,
    inputs.FIX_DIR,
    handOverParsers({ threads, comments: new Set(comments.map((comment) => comment.id)), rescueBranch: inputs.RESCUE_BRANCH }),
  );
  const bundled = readDirectory(COMMANDS["fix:publish"].inputs.BUNDLE_DIR, inputs.BUNDLE_DIR, { "branch.bundle": present });
  const rescue = handOver["rescue_ignored.json"];
  const nothing = handOver["nothing_to_do.txt"] !== undefined;

  // **A finished agent's hand-over must have arrived.** A runner that ends
  // well writes one of these two every time; without either, every file below
  // would read as "nothing of that kind", and the run would push nothing, say
  // nothing and mark the PR ready, green, with the agent's work dropped.
  if (finished && handOver["thread_outcomes.json"] === undefined && !nothing) {
    throw new Error("The agent finished, but what it handed over did not arrive, so nothing was pushed or posted.");
  }

  // The bundle, checked before anything is pushed from it: its content is the
  // agent's to write and the review's to judge, and what it is is ours.
  const tip =
    finished && !nothing && bundled["branch.bundle"] !== undefined
      ? await checkBundle(io, path.join(inputs.BUNDLE_DIR, "branch.bundle"), branch, started)
      : undefined;

  const { loop, workflow } = io.writers(limits(threads.size));
  const state: Published = { pushed: false, notesPosted: false, nothingToDo: false };
  const record = (): void => io.outputs.writeJson("published.json", state);
  record();

  // Step 1: a rescue branch the runner set aside because the pull request's
  // head moved since it was saved (#303), said however the run ended, so work
  // nobody built on is not dropped silently.
  if (rescue !== undefined) {
    await tolerated(
      () => workflow.comment(pr, ignoredNote(FIX_LABEL, rescue.branch, "this pull request's head")),
      `Could not say on PR #${pr} that ${rescue.branch} was set aside.`,
    );
  }
  // Every other ending is the failure arm's, which is still the publish
  // job's YAML.
  if (!finished) {
    console.log(`The agent's job ended ${inputs.AGENT_RESULT}, so nothing is pushed or posted here.`);
    return;
  }

  // Step 2: a fix with nothing to act on is a note, not a failure (#253). It
  // is not a round that ended either: nothing was read, so nothing was
  // decided, and it pushes nothing, deletes no rescue, and asks for nothing.
  if (nothing) {
    state.nothingToDo = true;
    record();
    await tolerated(() => workflow.comment(pr, NOTHING_TO_DO), `Could not post the nothing-to-do note on PR #${pr}.`);
    return;
  }

  // Step 3: the push, under a lease on the head this run started from: if
  // anything else moved the branch during the run, it is refused rather than
  // clobbered. With the loop's token, since the agent's commits may touch a
  // workflow file and a push made with the workflow token starts CI that waits
  // for a maintainer's approval.
  if (tip === undefined) {
    console.log("No new commits, so there is nothing to push.");
  } else {
    try {
      await loop.pushRef({ ref: `refs/heads/${branch}`, commit: tip, lease: { tip: started } });
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      const lost = error.cause instanceof GitError && error.cause.leaseLost;
      throw new Error(
        lost
          ? `\`${branch}\` moved while this run worked, so the agent's commits were not pushed over what is there now.`
          : `Couldn't push the agent's commits to \`${branch}\`, so nothing was pushed: ${describe(error.cause)}`,
        { cause: error },
      );
    }
    state.pushed = true;
    state.head = tip;
    record();
    console.log(`Pushed ${tip} to ${branch}.`);
  }

  // Step 4: a run that succeeded leaves no rescue branch behind (#303),
  // whether it resumed from it or set it aside.
  await deleteRescue(io, workflow, inputs.RESCUE_BRANCH);

  // Step 5: a reply in every thread the agent reported on, resolving **none**
  // of them (#111, and #109 decision 1). A thread closes when a review has read
  // the code, or a human closes it, never on the claim of its own fixer. So
  // the write is `reply`, and this command's limits name no other.
  for (const outcome of handOver["thread_outcomes.json"] ?? []) {
    await tolerated(
      async () => {
        await workflow.reply({ threadId: outcome.threadId, body: outcome.reply });
        console.log(`Replied to ${outcome.threadId} (${outcome.status}).`);
      },
      `Could not reply to review thread ${outcome.threadId}.`,
    );
  }

  // Step 6: what the run did with the **conversation** comments (#104), as one
  // record, under its own marker. Each comment's author and link are GitHub's.
  const header = handOver["round_header.txt"];
  const conversation = renderConversationOutcomes(
    handOver["conversation_outcomes.json"] ?? [],
    comments.map((comment) => ({ commentId: comment.id, author: comment.author, url: comment.url })),
  );
  if (conversation === "") {
    console.log("No conversation comment outcomes, so there is nothing to record.");
  } else {
    await tolerated(
      () => workflow.comment(pr, headed(header, conversation)),
      `Could not post the conversation comment outcomes on PR #${pr}.`,
    );
  }

  // Step 7: what belongs to no thread, each under the top-level marker, which
  // keeps it out of the next run's feedback. Silence is the normal outcome,
  // and the runner caps and dedupes the list.
  for (const [i, comment] of (handOver["top_level_comments.json"] ?? []).entries()) {
    await tolerated(
      () => workflow.comment(pr, headed(header, renderTopLevelComment(comment.body))),
      `Could not post top-level comment ${i} on PR #${pr}.`,
    );
  }

  // Step 8: what the run noticed outside this pull request's scope (#213),
  // one comment per note, for the next review to rule on. A note counts as
  // posted only where it went up: a note that failed is one no review can
  // rule on.
  for (const [i, note] of (handOver["out_of_scope_notes.json"] ?? []).entries()) {
    const posted = await tolerated(
      () => workflow.comment(pr, headed(header, renderOutOfScopeNote(note))),
      `Could not post out-of-scope note ${i} on PR #${pr}.`,
    );
    if (posted && !state.notesPosted) {
      state.notesPosted = true;
      record();
    }
  }

  // Step 9: the fix closes itself out, last, so a review never starts before
  // every reply and note is posted. A push asks for the review of what it
  // changed (#96), and a note for the review that rules on it (#213). **On a
  // PRD PR every run that got this far asks for one, whether or not it
  // pushed** (PRD #222), since there the end of a round is a verdict, and is
  // never marked ready. Anywhere else, a run that pushed nothing and noted
  // nothing hands the pull request back to the human (#159).
  if (state.pushed || state.notesPosted || branch.startsWith(PRD_BRANCH_PREFIX)) {
    await requestReview(inputs, io, pr, loop, workflow, state.head);
  } else {
    await tolerated(
      () => loop.markReadyForReview(pr),
      `Could not mark PR #${pr} ready for review. If neither the loop's App nor AGENT_PAT is set this is expected: GITHUB_TOKEN cannot do it. Mark it ready by hand.`,
    );
  }
};

/** What `published.json` holds, written as each becomes true, so a later failure still leaves it. */
interface Published {
  pushed: boolean;
  head?: string;
  notesPosted: boolean;
  nothingToDo: boolean;
}

const NOTHING_TO_DO =
  "**`agent:fix` had nothing to do:** There are no open review findings or comments for it to act on.";

const NO_REVIEW_STARTS =
  "This run asked for a re-review, but none will start on its own: neither the loop's App nor `AGENT_PAT` is set, so the `agent:review` label this run added triggers nothing. Remove and re-add `agent:review` by hand to review the fix and rule on any out-of-scope notes.";

const STATUSES = ["addressed", "declined"] as const;

/** A file whose presence is the whole of it. */
const present: Parser<true> = () => true;

/**
 * The runner's files, each read strictly: an id has to be one the command
 * read for itself, a status one of its two, the header of the round header's
 * one shape, and every other field is cleaned text. Each list is held to what
 * it can name: a thread outcome per thread, a conversation outcome per
 * comment, and comments and notes to the runner's own caps.
 */
const handOverParsers = (known: {
  readonly threads: ReadonlySet<string>;
  readonly comments: ReadonlySet<string>;
  readonly rescueBranch: string;
}) => ({
  "nothing_to_do.txt": present,
  "rescue_ignored.json": json(
    object({
      branch: target(new Set([known.rescueBranch]), `this pull request's rescue branch, \`${known.rescueBranch}\``),
      movedPast: matching(/[0-9a-f]{40}/, "a full commit id"),
    }),
  ),
  "round_header.txt": ((value, at) => matching(ROUND_HEADER, "a round header")(String(value).trim(), at)) satisfies Parser<string>,
  "thread_outcomes.json": json(
    list(
      object({ threadId: target(known.threads, "a review thread on this pull request"), status: choice(STATUSES), reply: text }),
      { max: known.threads.size },
    ),
  ),
  "conversation_outcomes.json": json(
    list(
      object({
        commentId: target(known.comments, "a comment on this pull request's conversation"),
        status: choice(STATUSES),
        reply: text,
      }),
      { max: known.comments.size },
    ),
  ),
  "top_level_comments.json": json(list(object({ body: text }), { max: MAX_TOP_LEVEL_COMMENTS })),
  "out_of_scope_notes.json": json(list(object({ title: text, body: text, location: optional(text) }), { max: MAX_OUT_OF_SCOPE_NOTES })),
});

/**
 * The bundle's one tip, where it is intact, holds exactly the pull request's
 * branch and nothing else, and builds on the head this run was started for.
 * Each failure is its own sentence, and nothing has been written yet.
 */
const checkBundle = async (io: Io, bundle: string, branch: string, started: string): Promise<string> => {
  let heads;
  try {
    heads = await io.git.verifyBundle(bundle);
  } catch (error) {
    throw new Error("The agent's commits arrived damaged or incomplete, so nothing was pushed.", { cause: error });
  }
  const [head, ...others] = heads;
  if (head === undefined || others.length > 0 || head.ref !== `refs/heads/${branch}`) {
    throw new Error(`The agent's commits arrived on a branch other than \`${branch}\`, or beside other branches, so nothing was pushed.`);
  }
  let builds: boolean;
  try {
    builds = await io.git.isAncestor(started, head.commit);
  } catch (error) {
    throw new Error(
      `Couldn't tell whether the agent's commits build on the PR's head as this run found it, so nothing was pushed: ${describe(error)}`,
      { cause: error },
    );
  }
  if (!builds) throw new Error("The agent's commits don't build on the PR's head as this run found it, so nothing was pushed.");
  return head.commit;
};

/**
 * The rescue branch, deleted under a lease on its tip as read here, so one
 * rewritten during the run is not removed. Never stops the command: a branch
 * left behind is set aside by the next run, whose head has moved past it.
 */
const deleteRescue = async (io: Io, workflow: Writer, rescue: string): Promise<void> => {
  let tip: string;
  try {
    tip = await io.github.branchTip(rescue);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      console.log(`No ${rescue} to delete.`);
    } else {
      console.log(`::warning::Could not read ${rescue}, so it was not deleted. The next run sets it aside; delete it by hand: ${describe(error)}`);
    }
    return;
  }
  const deleted = await tolerated(
    () => workflow.deleteRef({ ref: `refs/heads/${rescue}`, lease: { tip } }),
    `Could not delete ${rescue}. The next run sets it aside; delete it by hand.`,
  );
  if (deleted) console.log(`Deleted ${rescue}: this run succeeded.`);
};

/**
 * The re-review, asked for once the pull request shows the pushed head
 * (#229): GitHub moves a pull request's head asynchronously after a push, and
 * a label added first can carry the commit before it. Bounded: past it, the
 * label goes on anyway, since review reads the branch tip itself. Then this
 * run's own label off (#236), `agent:review` removed first so its add fires
 * (#236), and the add, with the loop's token, since a label added with the
 * workflow token triggers nothing.
 *
 * A failed add stops the command, naming the review as what is missing: this
 * run's threads are answered and still open, so a second fix run would answer
 * them again (#111). Without the App or `AGENT_PAT` the label goes on and
 * fires nothing, so the pull request is told (#105).
 */
const requestReview = async (
  inputs: Inputs,
  io: Io,
  pr: number,
  loop: Writer,
  workflow: Writer,
  pushed: string | undefined,
): Promise<void> => {
  if (pushed !== undefined) await waitForHead(inputs, io, pr, pushed);
  await tolerated(() => loop.removeLabel(pr, FIX_LABEL), `Could not take \`${FIX_LABEL}\` off PR #${pr}.`);
  await tolerated(() => loop.removeLabel(pr, REVIEW_LABEL), `Could not take \`${REVIEW_LABEL}\` off PR #${pr} before adding it.`);
  try {
    await loop.addLabel(pr, REVIEW_LABEL);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(`Couldn't add \`${REVIEW_LABEL}\` after this run, so no re-review was requested.`, { cause: error });
  }
  if (inputs.LOOP_TOKEN_SOURCE === "app" || inputs.LOOP_TOKEN_SOURCE === "pat") return;
  console.log(
    `::warning::Neither the loop's App nor AGENT_PAT is set, so this label was added with GITHUB_TOKEN and will NOT trigger agent-review. Add agent:review by hand on PR #${pr}.`,
  );
  await tolerated(() => workflow.comment(pr, NO_REVIEW_STARTS), "…and that could not be said on the pull request either.");
};

const waitForHead = async (inputs: Inputs, io: Io, pr: number, pushed: string): Promise<void> => {
  const waitSeconds = seconds(inputs.HEAD_WAIT_SECONDS, "HEAD_WAIT_SECONDS");
  const pollMs = seconds(inputs.HEAD_POLL_SECONDS, "HEAD_POLL_SECONDS") * 1000;
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    let head: string | undefined;
    try {
      head = (await io.github.pullRequest(pr)).headSha;
    } catch {
      head = undefined;
    }
    if (head === pushed) return;
    if (Date.now() >= deadline) {
      console.log(
        `::warning::PR #${pr} still shows ${head ?? "an unreadable head"} as its head ${waitSeconds}s after ${pushed} was pushed. Asking for the review anyway: it reads the branch tip itself, and refuses by name if it cannot settle on ${pushed}.`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

/**
 * What `fix:publish` may write, and how many of each (ADR 0005): one push and
 * one rescue deletion; a reply per thread on the pull request, and no
 * resolve; a comment each for the rescue note, the nothing-to-do note, the
 * conversation record and the note that no review will start, and the
 * runner's caps of top-level comments and notes; two label removals and one
 * `agent:review`; and one ready mark. Anything else is refused and stops it.
 */
const limits = (threads: number): Limits => ({
  pushRef: 1,
  deleteRef: 1,
  reply: threads,
  comment: 4 + MAX_TOP_LEVEL_COMMENTS + MAX_OUT_OF_SCOPE_NOTES,
  removeLabel: 2,
  addLabel: 1,
  markReadyForReview: 1,
});

/**
 * A write the loop can live without: made, or said as a warning where GitHub
 * refused it. Whether it landed. A write past its limit is still thrown: that
 * is our own bug, never one to read past.
 */
const tolerated = async (write: () => Promise<unknown>, warning: string): Promise<boolean> => {
  try {
    await write();
    return true;
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::${warning} GitHub's reply is in the write log.`);
    return false;
  }
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A read publish cannot go on without, its failure said as a sentence: nothing has been written yet. */
const read = async <T>(what: string, request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    throw new Error(`Could not read ${what} from GitHub, so nothing was pushed or posted: ${describe(error)}`, { cause: error });
  }
};

const seconds = (value: string, name: string): number => {
  if (!/^[0-9]{1,6}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not a number of seconds.`);
  return Number(value);
};

const pullRequestNumber = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`PR_NUMBER is ${JSON.stringify(value)}, which is not a pull request number.`);
  return Number(value);
};

const commit = (value: string, name: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} is ${JSON.stringify(value)}, which is not a full commit id, so there is no head to check the agent's commits against.`);
  }
  return value;
};
