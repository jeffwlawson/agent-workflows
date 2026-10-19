import * as path from "node:path";
import { GitError } from "../engine/git.js";
import { GitHubError } from "../engine/github.js";
import { WriteFailed, type Lease, type Limits, type Writer } from "../engine/writer.js";
import { checkBundle } from "../shared/bundle.js";
import { describe, inWriteLog, tolerated } from "../shared/command-helpers.js";
import type { RewritingCheckoutIo } from "../shared/command-io.js";
import { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { readDirectory, type Parser } from "../shared/hand-over.js";
import { SLICE_TRAILER, sliceTrailer } from "../shared/record.js";

type Declared = (typeof COMMANDS)["implement-prd:publish"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = RewritingCheckoutIo<Declared["outputs"]>;

/** What `published.json` holds, written as each becomes true, so a later failure still leaves it. */
interface Published {
  pushed: boolean;
  /** The commit pushed, which the PRD PR has to show before the review is asked for. */
  head?: string;
}

/**
 * `implement-prd:publish` (#502): the publish job's push of a built slice, as
 * a command. It checks the agent's bundle, marks the slice's commits, pushes
 * them to the PRD branch and deletes the rescue branch, in that order. The
 * PRD PR, the review request and the hand-over are still the publish job's
 * steps.
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
 * Throws to stop, in a sentence a human can act on, which the CLI turns into
 * `fail()` and the publish job into the failure comment.
 */
export const publish = async (inputs: Inputs, io: Io): Promise<void> => {
  const sub = numbered(inputs.SUB);
  const branch = inputs.PRD_BRANCH;
  const base = inputs.BASE_REF;
  const started = commit(inputs.BASE_SHA, "BASE_SHA");
  const lease: Lease = inputs.PRD_TIP === "" ? { absent: true } : { tip: started };

  const bundled = readDirectory(COMMANDS["implement-prd:publish"].inputs.BUNDLE_DIR, inputs.BUNDLE_DIR, { "branch.bundle": present });
  if (bundled["branch.bundle"] === undefined) {
    throw new Error("The agent's job finished without handing over its commits, so nothing was pushed.");
  }
  const tip = await checkBundle(io.git, path.join(inputs.BUNDLE_DIR, "branch.bundle"), branch, started, "pushed", `\`${branch}\``);

  let fetched: string;
  try {
    fetched = await io.fetcher.fetchRef(`refs/heads/${base}`, `refs/remotes/origin/${base}`);
  } catch (error) {
    throw new Error(`Couldn't fetch \`${base}\` to tell the agent's commits from its, so nothing was pushed: ${describe(error)}`, { cause: error });
  }
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

  const { loop } = io.writers(LIMITS);
  const state: Published = { pushed: false };
  const record = (): void => io.outputs.writeJson("published.json", state);
  record();

  // The push, with the loop's token, since the agent's commits may touch a
  // workflow file, which the workflow token cannot push.
  try {
    await loop.pushRef({ ref: `refs/heads/${branch}`, commit: marked.head, lease });
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
  state.head = marked.head;
  record();
  console.log(`Pushed ${marked.head} to ${branch}.`);

  await deleteRescue(io, loop, inputs.RESCUE_BRANCH);
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
 * What `implement-prd:publish` may write, and how many of each (ADR 0005):
 * the PRD branch's push and the rescue branch's deletion, with the loop's
 * token. Anything else is refused and stops it.
 */
const LIMITS: Limits = { pushRef: 1, deleteRef: 1 };

/** A file read for being there, and nothing more: the bundle's bytes are git's to check. */
const present: Parser<true> = () => true;

const numbered = (value: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`SUB is ${JSON.stringify(value)}, which is not a sub-issue number.`);
  return Number(value);
};

const commit = (value: string, name: string): string => {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} is ${JSON.stringify(value)}, which is not a full commit id, so there is nothing to check the agent's commits against.`);
  }
  return value;
};
