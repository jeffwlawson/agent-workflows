import * as path from "node:path";
import { GitError } from "../engine/git.js";
import { GitHubError } from "../engine/github.js";
import { ReadBackFailed, WriteFailed, type Lease, type Limits, type Writer } from "../engine/writer.js";
import { checkBundle } from "../shared/bundle.js";
import { describe, inWriteLog, issueNumber, seconds, tolerated } from "../shared/command-helpers.js";
import type { RewritingCheckoutIo } from "../shared/command-io.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { choice, count, json, list, nullable, object, readDirectory, text, type Parser } from "../shared/hand-over.js";
import { waitForHead } from "../shared/head-wait.js";
import { loopAccounts } from "../shared/loop-accounts.js";
import { renderPullRequestFrame } from "../shared/pr-frame.js";
import { readBranchLog } from "../shared/prd-round.js";
import {
  finalReviewRequestedLines,
  renderPrdStatus,
  renderProgressList,
  spliceProgressList,
  spliceStatus,
  statusBlock,
  type ProgressInputs,
} from "../shared/progress-list.js";
import {
  CLOSES_END,
  CLOSES_START,
  closesBlock,
  FINAL_REVIEW_MARK,
  FIX_LABEL,
  IMPLEMENT_LABEL,
  PROGRESS_END,
  PROGRESS_START,
  REVIEW_LABEL,
  SLICE_TRAILER,
  sliceTrailer,
} from "../shared/record.js";
import { roundCounts, type RoundCounts } from "../shared/round-header.js";
import { sliceRanges } from "../shared/slice-ranges.js";

type Declared = (typeof COMMANDS)["implement-prd:publish"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = RewritingCheckoutIo<Declared["outputs"]>;

/** What `published.json` holds, written as each becomes true, so a later failure still leaves it. */
interface Published {
  pushed: boolean;
  /** The commit pushed, which the PRD PR has to show before the review is asked for. */
  head?: string;
  /** The PRD PR opened or reused, once it is known. */
  pr?: number;
  /** Whether `agent:review` went on. */
  requested: boolean;
  /** Whether the finishing run handed the PRD PR over: marked ready, or its final review asked for. */
  handedOver: boolean;
}

/**
 * `implement-prd:publish` (#502, #503): the publish job's success path, as a
 * command. On a build it checks the agent's bundle, marks the slice's
 * commits, pushes them to the PRD branch and deletes the rescue branch; then,
 * on a build and on the run that only opens a missing PRD PR (`BUILD`
 * false), it opens the PRD PR or reuses it, with its progress list and
 * status line, and asks for its review, in that order. On the finishing
 * run (`FINISHING` true, #504) it builds and pushes nothing and hands the PRD
 * PR over instead: see `handOver`.
 *
 * **The bundle is checked before anything is made from it**, against facts
 * the agent could not reach: it is there, intact, holds exactly the PRD
 * branch and nothing else, and builds on `BASE_SHA`, the tip
 * `implement-prd:catch-up` left, read from the catch-up job and never from
 * the agent's.
 *
 * **The mark is made here, outside the agent's reach** (#410): every commit
 * in the bundle's head and in neither `BASE_SHA` nor the default branch as
 * fetched, so the PRD branch's earlier slices and a default-branch commit the
 * agent merged in keep their identity, and commits a run resumed from a
 * rescue, pushed there unmarked, are marked as this slice's. Each loses any
 * `Agent-Slice` line the agent wrote, in any case, and gains this slice's,
 * the trailer `implement-prd:gate` reads which sub-issues are built from.
 * Trees, authors and dates are kept: only messages change. A bundle with no
 * such commit is refused, since a slice with no commits of its own would be
 * pushed as built.
 *
 * **The push is leased on `BASE_SHA`**, or on the branch not existing where
 * the gate found none, `PRD_TIP` empty, since the catch-up pushes no PRD
 * branch it made: a push someone made to the PRD branch during the run is
 * refused rather than overwritten. Plain otherwise: the marked head builds
 * on the tip, so it is a fast-forward of it.
 *
 * **The rescue branch** is deleted after the push, leased on its tip as read,
 * so a run that pushed its slice leaves none behind. None is nothing to
 * delete, and a failure warns: the next run sets it aside.
 *
 * **The PRD PR** is the open pull request from the PRD branch, found by its
 * head, or opened, as a draft, where there is none. Its progress list and
 * status line are rendered here from data (ADR 0007), with this run's slice,
 * or the slices built so far, in review: the sub-issues from the gate's
 * snapshot, the slices off the PRD branch's trailers as this run left it, and
 * a reused PRD PR's rounds read through the reader.
 *
 * Throws to stop, in a sentence a human can act on, which the CLI turns into
 * `fail()` and the publish job into the failure comment.
 */
export const publish = async (inputs: Inputs, io: Io): Promise<void> => {
  const parent = issueNumber(inputs.ISSUE_NUMBER);
  const branch = inputs.PRD_BRANCH;
  const base = inputs.BASE_REF;
  const build = inputs.BUILD === "true";

  // Every hand-over read before the first write.
  const { "prd-issue.json": snapshot } = readDirectory(COMMANDS["implement-prd:publish"].inputs.GATE_DIR, inputs.GATE_DIR, {
    "prd-issue.json": SNAPSHOT,
  });
  if (inputs.FINISHING === "true") {
    await handOver(inputs, io, parent, snapshot.subIssues.nodes);
    return;
  }

  let built: { readonly sub: number; readonly marked: string; readonly lease: Lease } | undefined;
  let fetched: string;
  let head: string;
  if (build) {
    const sub = numbered(inputs.SUB, "SUB", "a sub-issue number");
    const started = commit(inputs.BASE_SHA, "BASE_SHA");
    const bundled = readDirectory(COMMANDS["implement-prd:publish"].inputs.BUNDLE_DIR, inputs.BUNDLE_DIR, { "branch.bundle": present });
    if (bundled["branch.bundle"] === undefined) {
      throw new Error("The agent's job finished without handing over its commits, so nothing was pushed.");
    }
    const tip = await checkBundle(io.git, path.join(inputs.BUNDLE_DIR, "branch.bundle"), branch, started, "pushed", `\`${branch}\``);
    fetched = await fetchBase(io, base, "to tell the agent's commits from its, so nothing was pushed");
    let marked;
    try {
      marked = await io.rewriter.rewriteMessages({ head: tip, exclude: [started, fetched], message: (text) => markSlice(text, sub) });
    } catch (error) {
      throw new Error(`Couldn't mark the agent's commits as sub-issue #${sub}'s, so nothing was pushed: ${describe(error)}`, { cause: error });
    }
    if (marked.rewritten === 0) {
      throw new Error(
        `The agent's commits on \`${branch}\` are all on \`${branch}\` as this run left it or on \`${base}\` already, so sub-issue #${sub} has no commits of its own and nothing was pushed.`,
      );
    }
    console.log(`Marked ${marked.rewritten} commit(s) with ${sliceTrailer(sub)}.`);
    built = { sub, marked: marked.head, lease: inputs.PRD_TIP === "" ? { absent: true } : { tip: started } };
    head = marked.head;
  } else {
    // Nothing built: the PRD PR is opened over the slices already on the
    // branch, read as they are on GitHub.
    fetched = await fetchBase(io, base, "to read the slices on the PRD branch against it, so no PRD PR was opened");
    try {
      head = await io.fetcher.fetchRef(`refs/heads/${branch}`, `refs/remotes/origin/${branch}`);
    } catch (error) {
      throw new Error(`Couldn't fetch \`${branch}\` to read the slices built on it, so no PRD PR was opened: ${describe(error)}`, { cause: error });
    }
  }

  const { loop } = io.writers(LIMITS);
  const state: Published = { pushed: false, requested: false, handedOver: false };
  const record = (): void => io.outputs.writeJson("published.json", state);
  record();

  if (built !== undefined) {
    const { sub, marked, lease } = built;
    // The push, with the loop's token, since the agent's commits may touch a
    // workflow file, which the workflow token cannot push.
    try {
      await loop.pushRef({ ref: `refs/heads/${branch}`, commit: marked, lease });
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      const lost = error.cause instanceof GitError && error.cause.leaseLost;
      throw new Error(
        lost
          ? `\`${branch}\` changed while this run worked, so sub-issue #${sub}'s commits were not pushed over what is there now. Trying again builds it on top of that.`
          : `Couldn't push sub-issue #${sub}'s commits to \`${branch}\`, so nothing was pushed: ${describe(error.cause)}`,
        { cause: error },
      );
    }
    state.pushed = true;
    state.head = marked;
    record();
    console.log(`Pushed ${marked} to ${branch}.`);

    await deleteRescue(io, loop, inputs.RESCUE_BRANCH);
  }

  const chain: Chain = { parent, subIssues: snapshot.subIssues.nodes, ...(built === undefined ? {} : { sub: built.sub }) };
  const pr = await openOrReuse(inputs, io, loop, chain, { base: fetched, head });
  state.pr = pr;
  record();

  await requestReview(inputs, io, parent, pr, state.head, loop);
  state.requested = true;
  record();
};

/** The PRD as the gate's snapshot gives it, and the sub-issue this run built, where it built one. */
interface Chain {
  readonly parent: number;
  readonly subIssues: readonly { readonly number: number; readonly state: "OPEN" | "CLOSED" }[];
  readonly sub?: number;
}

/** `BASE_REF` fetched, and its tip, or a sentence ending in `outcome` where it could not be. */
const fetchBase = async (io: Io, base: string, outcome: string): Promise<string> => {
  try {
    return await io.fetcher.fetchRef(`refs/heads/${base}`, `refs/remotes/origin/${base}`);
  } catch (error) {
    throw new Error(`Couldn't fetch \`${base}\` ${outcome}: ${describe(error)}`, { cause: error });
  }
};

/**
 * **The PRD PR**, opened or reused, and its number. The one open pull request
 * from the PRD branch is reused; more than one is a sentence, since which is
 * the PRD PR is not a guess to make; none is one this run opens, which is the
 * first slice's run, or one that finds slices built and no PRD PR open, a run
 * that died between its push and here.
 */
const openOrReuse = async (inputs: Inputs, io: Io, loop: Writer, chain: Chain, branch: { readonly base: string; readonly head: string }): Promise<number> => {
  const from = inputs.PRD_BRANCH;
  let open: readonly { readonly number: number }[];
  try {
    open = await io.github.openPullRequests({ head: from });
  } catch (error) {
    throw new Error(
      `Couldn't look for the PRD PR from \`${from}\`. The slice is on the PRD branch, and trying again doesn't build it twice: ${describe(error)}`,
      { cause: error },
    );
  }
  if (open.length > 1) {
    throw new Error(
      `${open.length} open PRs come from this PRD's branch \`${from}\` (${open.map((pr) => `#${pr.number}`).join(", ")}), so it can't tell which one is the PRD PR. Close all but one.`,
    );
  }
  const reused = open[0]?.number;
  const rendered = await renderProgress(inputs, io, chain, branch, reused);
  if (reused === undefined) return openPrdPullRequest(inputs, loop, chain, rendered);
  console.log(`Reusing PRD PR #${reused}.`);
  await writeProgress(loop, chain, reused, rendered);
  return reused;
};

/** The progress list and the status line, between their markers. */
interface Rendered {
  readonly progress: string;
  readonly status: string;
}

/**
 * The PRD PR's **progress list** and **status line** (#246, #298), with the
 * chain in review: this run's slice, or the slices built so far, which is
 * what this run is about to ask the review for. Rendered from the gate's
 * snapshot of the sub-issues, the slices read off the PRD branch's trailers
 * as this run left it, and, on a PRD PR being reused, its rounds so far,
 * read through the reader, which the table counts and is told it could not
 * where they could not be read. Undefined where the branch could not be
 * read: the list is a view of the chain, and the slice is worth more than it.
 */
const renderProgress = async (
  inputs: Inputs,
  io: Io,
  chain: Chain,
  branch: { readonly base: string; readonly head: string },
  reused: number | undefined,
): Promise<Rendered | undefined> => {
  let ranges;
  try {
    ranges = sliceRanges(await readBranchLog(io.git, branch.base, branch.head), chain.subIssues);
  } catch (error) {
    console.log(`::warning::The PRD branch could not be read, so the PRD PR's progress list was not rendered: ${describe(error)}`);
    return undefined;
  }
  let rounds: RoundCounts | undefined;
  if (reused !== undefined) {
    try {
      const [reviews, fixes] = await Promise.all([io.github.reviews(reused), io.github.labelledAt(reused, FIX_LABEL)]);
      rounds = roundCounts({ reviews, fixes }, loopAccounts(inputs.AGENT_LOOP_LOGINS), ranges);
    } catch (error) {
      console.log(`::warning::The PRD PR's rounds could not be read, so the progress table does not count them: ${describe(error)}`);
    }
  }
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = inputs;
  const progress: ProgressInputs = {
    subIssues: chain.subIssues,
    ranges,
    verdict: "none",
    running: { kind: "review" },
    finalReview: "not requested",
    prUrl: reused !== undefined && server !== "" && repo !== "" ? `${server}/${repo}/pull/${reused}` : undefined,
    rounds,
  };
  return { progress: renderProgressList(progress), status: statusBlock(renderPrdStatus(progress)) };
};

/**
 * The draft PRD PR from the PRD branch into `BASE_REF`, with its frame, and
 * its number; then, on a build, the slice's chapter marker on it (#298), as
 * a later slice's gets it as its run starts. With the loop's token: the
 * Actions bot is forbidden from opening one. A pull request the read-back
 * found after a server error is carried on with, with a warning (#329).
 */
const openPrdPullRequest = async (inputs: Inputs, loop: Writer, chain: Chain, rendered: Rendered | undefined): Promise<number> => {
  const from = inputs.PRD_BRANCH;
  const into = inputs.BASE_REF;
  const open = chain.subIssues.filter((sub) => sub.state === "OPEN").map((sub) => sub.number);
  let number: number;
  try {
    const opened = await loop.openPullRequest({
      base: into,
      head: from,
      title: cut(inputs.ISSUE_TITLE, 256),
      body: renderPullRequestFrame({ prd: chain.parent, open, ...(rendered ?? UNRENDERED) }),
      draft: true,
    });
    if (opened.readBack !== undefined) {
      console.log(
        `::warning::GitHub answered opening the PRD PR with a server error (${opened.readBack}), but PR #${opened.number} from \`${from}\` into \`${into}\` is open, so this run goes on with it.`,
      );
    }
    console.log(`Opened PRD PR ${opened.url}`);
    number = opened.number;
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    if (error.cause instanceof ReadBackFailed) {
      throw new Error(
        `GitHub answered opening the PRD PR from \`${from}\` with a server error, and whether it opened anyway could not be read back (${describe(error.cause.read)}). Look for an open pull request from \`${from}\` before adding \`${IMPLEMENT_LABEL}\` again; if there is one, add \`${REVIEW_LABEL}\` to it instead.`,
        { cause: error },
      );
    }
    if (!startsRuns(inputs)) {
      throw new Error(
        "Couldn't open the PRD PR, because neither the loop's App nor `AGENT_PAT` is set and GitHub doesn't let the default token open PRs. Set up one of them first.",
        { cause: error },
      );
    }
    throw new Error(`Couldn't open the PRD PR from \`${from}\` into \`${into}\`: ${describe(error.cause)}`, { cause: error });
  }
  if (chain.sub !== undefined) {
    const sub = chain.sub;
    const k = chain.subIssues.findIndex((s) => s.number === sub) + 1;
    await tolerated(inWriteLog(`Could not say on PRD PR #${number} that sub-issue #${sub} started.`), () =>
      loop.comment(number, `**Slice ${k} of ${chain.subIssues.length} · #${sub} started**`),
    );
  }
  return number;
};

/**
 * What a PRD PR opens with where the PRD branch could not be read: a table
 * that says when it is written, and a status line that says what is in
 * review, as a run that built nothing opened it with before #503.
 */
const UNRENDERED: Rendered = {
  progress: `${PROGRESS_START}\n_The progress table is written when this slice's review round ends._\n${PROGRESS_END}`,
  status: statusBlock("**🔍 In review:** the slices built so far."),
};

/**
 * A reused PRD PR's progress list and status line, spliced into its live body
 * as every writer of them splices them (`spliceProgressList`, `spliceStatus`):
 * every byte outside the markers kept, a list appended to a body with none,
 * and half a list, or two, not written at all, with a warning. A status line
 * that cannot be spliced is left as it stands while the list is written.
 *
 * Pre-upgrade compatibility, removable under #224: a PRD PR an older release
 * opened has no `Closes` block, only `Closes #<parent>`, since that release
 * closed each sub-issue itself. A body with no `Closes` marker at all gets the
 * block at its end, in the same write, so the sub-issues still open close
 * when it merges.
 *
 * Never stops the command: the slice is pushed, and its review is what
 * matters now. A failed write warns.
 */
const writeProgress = async (loop: Writer, chain: Chain, pr: number, rendered: Rendered | undefined): Promise<void> => {
  if (rendered === undefined) return;
  const open = chain.subIssues.filter((sub) => sub.state === "OPEN").map((sub) => sub.number);
  let half = false;
  try {
    const edited = await loop.editPullRequest(pr, {
      body: (live) => {
        const listed = spliceProgressList(live, rendered.progress);
        if (listed === undefined) {
          half = true;
          return undefined;
        }
        const body = spliceStatus(listed, rendered.status) ?? listed;
        return live.includes(CLOSES_START) || live.includes(CLOSES_END) ? body : `${body}\n\n${closesBlock(chain.parent, open)}`;
      },
    });
    if (half) {
      console.log(
        `::warning::PRD PR #${pr}'s body carries half a progress list, or two, so it was not written. Restore the missing marker, or delete the markers and the text between them, and the next ending of a round writes it again.`,
      );
    } else if (edited.outcome === "applied") {
      console.log(`Wrote PRD PR #${pr}'s progress list.`);
    }
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    console.log(`::warning::${inWriteLog(`Could not write PRD PR #${pr}'s progress list.`)}`);
  }
};

/** Whether the loop's token is one a label added with starts a run: the App's or `AGENT_PAT`. */
const startsRuns = (inputs: Inputs): boolean => inputs.LOOP_TOKEN_SOURCE === "app" || inputs.LOOP_TOKEN_SOURCE === "pat";

/**
 * The slice's round: `agent:review` on the PRD PR, once it shows the pushed
 * head (#229), where this run pushed one. GitHub moves a pull request's head
 * asynchronously after a push, and a label added first can carry the commit
 * before it. Bounded: past it, the label goes on anyway, since review reads
 * the branch tip itself. This run adds nothing to the parent: the next slice
 * waits for this round's verdict.
 *
 * Then this run's own label off the parent (#236): every result is posted by
 * now, so what is left is the hand-off. Then `agent:review` removed first, as
 * every trigger label the loop adds (#236), since an add on a label already
 * there fires nothing, and added. All three with the loop's token: a label
 * added with the workflow token triggers nothing, so without the App or
 * `AGENT_PAT` the label goes on and nothing happens, which is warned of
 * rather than passed off as working. An add that fails stops the command, so
 * the failure comment names the PRD PR to label by hand.
 *
 * Safe because the hop it starts is bounded at the other end, as
 * `implement`'s is: the chain moves on only on the review's approval.
 */
const requestReview = async (inputs: Inputs, io: Io, parent: number, pr: number, pushed: string | undefined, loop: Writer): Promise<void> => {
  if (pushed !== undefined) {
    await waitForHead(io.github, pr, pushed, {
      waitSeconds: seconds(inputs.HEAD_WAIT_SECONDS, "HEAD_WAIT_SECONDS"),
      pollSeconds: seconds(inputs.HEAD_POLL_SECONDS, "HEAD_POLL_SECONDS"),
    });
  }
  await tolerated(inWriteLog(`Could not take \`${IMPLEMENT_LABEL}\` off #${parent}.`), () => loop.removeLabel(parent, IMPLEMENT_LABEL));
  await tolerated(
    inWriteLog(`Could not take \`${REVIEW_LABEL}\` off PRD PR #${pr} before adding it.`),
    () => loop.removeLabel(pr, REVIEW_LABEL),
  );
  try {
    await loop.addLabel(pr, REVIEW_LABEL);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(`Couldn't add \`${REVIEW_LABEL}\` to PRD PR #${pr}, so no review was requested.`, { cause: error });
  }
  console.log(`Asked for the review of PRD PR #${pr}.`);
  if (startsRuns(inputs)) return;
  console.log(
    `::warning::Neither the loop's App nor AGENT_PAT is set, so this label was added with GITHUB_TOKEN and will NOT trigger agent-review. Add ${REVIEW_LABEL} by hand on PRD PR #${pr}.`,
  );
};

/**
 * **The finishing run's hand-over** (#504): every sub-issue is built and the
 * last slice's round approved, so the PRD PR leaves the chain. A human merges
 * it; the loop never merges it and never approves.
 *
 * One slice landed means its round was a review of the whole PRD PR already,
 * and of the same lines, so the PRD PR is marked ready and no second review
 * runs. More than one means a **final review**: `requestFinalReview`.
 * `LANDED` counts the slices that landed before the upgrade too (pre-upgrade
 * compatibility, removable under #224): no round on the PRD PR reviewed them,
 * so one slice built beside them is not a review of the whole PRD PR.
 *
 * Refused, before any write, where the loop's token is the workflow token:
 * GitHub does not let it mark a draft ready, and a label added with it starts
 * no review, so half a hand-over is not attempted.
 */
const handOver = async (inputs: Inputs, io: Io, parent: number, subIssues: Chain["subIssues"]): Promise<void> => {
  const pr = numbered(inputs.PRD_PR, "PRD_PR", "a pull request number");
  const landed = numbered(inputs.LANDED, "LANDED", "a count of slices landed");
  if (!startsRuns(inputs)) {
    throw new Error(
      `Couldn't hand PRD PR #${pr} over, because neither the loop's App nor \`AGENT_PAT\` is set and GitHub doesn't let the default token mark a draft ready or start a review. Every sub-issue is built. Set up one of them; trying again resumes the handover and builds nothing.`,
    );
  }
  const { loop } = io.writers(LIMITS);
  const state: Published = { pushed: false, pr, requested: false, handedOver: false };
  const record = (): void => io.outputs.writeJson("published.json", state);
  record();

  if (landed > 1) {
    await requestFinalReview(inputs, loop, parent, pr, subIssues);
    state.requested = true;
  } else {
    try {
      await loop.markReadyForReview(pr);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      throw new Error(`Couldn't mark PRD PR #${pr} ready for review. Trying again resumes the handover and builds nothing.`, { cause: error });
    }
    console.log(`Marked PRD PR #${pr} ready: its one slice's round was the review of the whole PR.`);
  }
  state.handedOver = true;
  record();
};

/**
 * The final review, asked for. First the record that it is requested, in the
 * PRD PR's progress list, which a review of the PRD PR reads it from: the
 * final review's row and the `agent:final-review requested` mark written in
 * front of the end marker of the list the last slice's round left, every
 * slice approved, which is the list rendered for the final review requested
 * (`finalReviewRequestedLines`); a body with no list, one opened before #246,
 * gets the mark at its end. And the status line, where the body has exactly
 * one. The record goes first, so the review the label starts finds it, and a
 * body that has the mark already, a retry's, is not written again.
 *
 * The body is read as `$(gh pr view …)` read it, its trailing line breaks
 * dropped, so the bytes written are the ones the shell step wrote.
 *
 * Then `agent:implement` off the parent and `agent:review` off and on the PRD
 * PR, as `requestReview`. The mark is what `implement-prd:gate` calls the PRD
 * finished by, so where the label does not go on, the body this run marked is
 * put back before the command stops: left in, the retry would be refused as
 * finished with no final review ever asked for. Then the review's start
 * comment on the PRD PR (#298), with this run's link, since no sub-issue
 * holds one for it.
 */
const requestFinalReview = async (inputs: Inputs, loop: Writer, parent: number, pr: number, subIssues: Chain["subIssues"]): Promise<void> => {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = inputs;
  const prUrl = server !== "" && repo !== "" ? `${server}/${repo}/pull/${pr}` : undefined;
  const status = statusBlock(
    renderPrdStatus({ subIssues, ranges: sliceRanges([], subIssues), verdict: "approval", running: { kind: "review" }, finalReview: "requested" }),
  );
  let before: string | undefined;
  try {
    await loop.editPullRequest(pr, {
      body: (live) => {
        const body = live.replace(/\n+$/, "");
        if (body.includes(FINAL_REVIEW_MARK)) return undefined;
        before = body;
        const requested = body.includes(PROGRESS_END)
          ? body.replace(PROGRESS_END, () => `${finalReviewRequestedLines(prUrl)}${PROGRESS_END}`)
          : `${body}\n\n${FINAL_REVIEW_MARK}`;
        return spliceStatus(requested, status) ?? requested;
      },
    });
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(`Couldn't note on PRD PR #${pr} that its final review is due, so it wasn't requested. Trying again builds nothing.`, {
      cause: error,
    });
  }

  await tolerated(inWriteLog(`Could not take \`${IMPLEMENT_LABEL}\` off #${parent}.`), () => loop.removeLabel(parent, IMPLEMENT_LABEL));
  await tolerated(
    inWriteLog(`Could not take \`${REVIEW_LABEL}\` off PRD PR #${pr} before adding it.`),
    () => loop.removeLabel(pr, REVIEW_LABEL),
  );
  try {
    await loop.addLabel(pr, REVIEW_LABEL);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    const marked = before;
    if (marked !== undefined) {
      try {
        await loop.editPullRequest(pr, { body: () => marked });
      } catch (restore) {
        if (!(restore instanceof WriteFailed)) throw restore;
        throw new Error(
          `Couldn't add \`${REVIEW_LABEL}\` to PRD PR #${pr}, and couldn't take back out the note that its final review is due. Add \`${REVIEW_LABEL}\` to PRD PR #${pr} by hand.`,
          { cause: error },
        );
      }
    }
    throw new Error(
      `Couldn't add \`${REVIEW_LABEL}\` to PRD PR #${pr}, so its final review was not requested. Trying again resumes the handover and builds nothing.`,
      { cause: error },
    );
  }
  const total = subIssues.length;
  console.log(`Asked for the final review of PRD PR #${pr}, over its ${total} slices.`);
  await tolerated(inWriteLog(`Could not post the final review's start comment on PRD PR #${pr}.`), () =>
    loop.comment(pr, `**Final review of all ${total} slices started** · [Workflow run](${inputs.RUN_URL})`),
  );
};

/**
 * `message` marked as sub-issue `sub`'s: every `Agent-Slice` line in it
 * dropped, in any case, wherever it sits, and one naming `sub` added to the
 * trailer block git's own parser reads, the message's last paragraph. Where
 * that paragraph is not all trailers, or is the subject, the trailer is a
 * paragraph of its own, so the parser still finds it. A `---` line is text
 * like any other: the input is a commit message, not a patch email.
 */
const markSlice = (message: string, sub: number): string => {
  const trailer = sliceTrailer(sub);
  const agents = new RegExp(`^${SLICE_TRAILER}:`, "i");
  const kept = message
    .split("\n")
    .filter((line) => !agents.test(line))
    .join("\n")
    .trimEnd();
  if (kept === "") return `${trailer}\n`;
  const paragraphs = kept.split(/\n[ \t]*\n/);
  const last = paragraphs.at(-1) ?? "";
  const lines = last.split("\n");
  const trailers = paragraphs.length > 1 && /^[A-Za-z0-9-]+:/.test(lines[0] ?? "") && lines.every((line) => /^([A-Za-z0-9-]+:|[ \t])/.test(line));
  return `${kept}${trailers ? "\n" : "\n\n"}${trailer}\n`;
};

/**
 * The rescue branch, deleted under a lease on its tip as read here, so one
 * rewritten during the run is not removed. Never stops the command: a branch
 * left behind is set aside by the next run, whose tip has moved past it.
 */
const deleteRescue = async (io: Io, loop: Writer, rescue: string): Promise<void> => {
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
    inWriteLog(`Could not delete ${rescue}. The next run sets it aside; delete it by hand.`),
    () => loop.deleteRef({ ref: `refs/heads/${rescue}`, lease: { tip } }),
  );
  if (deleted) console.log(`Deleted ${rescue}: this run succeeded.`);
};

/**
 * What `implement-prd:publish` may write, and how many of each (ADR 0005),
 * every one with the loop's token: the PRD branch's push and the rescue
 * branch's deletion; the PRD PR opened, or its progress list written into it,
 * and the slice's chapter marker on one it opened; and `agent:review` on it,
 * after `agent:implement` off the parent and `agent:review` off it. On the
 * finishing run, the final review's mark and, where the label does not go
 * on, its restore, the review's start comment, or the PRD PR marked ready.
 * Anything else is refused and stops it.
 */
const LIMITS: Limits = {
  pushRef: 1,
  deleteRef: 1,
  openPullRequest: 1,
  editPullRequest: 2,
  markReadyForReview: 1,
  comment: 2,
  removeLabel: 2,
  addLabel: 1,
};

/** A file read for being there, and nothing more: the bundle's bytes are git's to check. */
const present: Parser<true> = () => true;

/**
 * The gate's snapshot of the PRD, `prd-issue.json`, in the shape it writes:
 * the sub-issues every branch of the gate ruled on, in the list's order, of
 * which the progress list and the `Closes` block read the numbers and states.
 */
const SNAPSHOT = json(
  object({
    parent: nullable(count({ min: 1, max: Number.MAX_SAFE_INTEGER })),
    labels: object({ nodes: list(object({ name: text }), { max: 100 }) }),
    subIssues: object({
      totalCount: count({ min: 0, max: 100 }),
      nodes: list(
        object({ number: count({ min: 1, max: Number.MAX_SAFE_INTEGER }), title: text, state: choice(["OPEN", "CLOSED"] as const) }),
        { max: 100 },
      ),
    }),
  }),
);

/** `text` cut to `max` characters, as bash's `${title:0:256}` cut it: by code point, never mid-character. */
const cut = (value: string, max: number): string => Array.from(value).slice(0, max).join("");

const numbered = (value: string, name: string, what: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`${name} is ${JSON.stringify(value)}, which is not ${what}.`);
  return Number(value);
};

const commit = (value: string, name: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} is ${JSON.stringify(value)}, which is not a full commit id, so there is nothing to check the agent's commits against.`);
  }
  return value;
};
