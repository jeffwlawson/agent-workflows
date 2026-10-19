import type { GitHubReader, SubIssue } from "../engine/read.js";
import { WriteFailed, type Limits, type Writer } from "../engine/writer.js";
import { describe, inWriteLog, issueNumber, tolerated } from "../shared/command-helpers.js";
import type { CommandIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { showBuilding } from "../shared/progress-list.js";
import {
  BLOCKED_LABEL,
  IMPLEMENT_LABEL,
  PRD_STARTED_MARK,
  prdBranch,
  prdBranchStem,
  sliceApprovedMark,
  VERDICT_CONTEXT,
} from "../shared/record.js";
import { readCriteriaChanges } from "../shared/review-output.js";
import {
  afterVerdict,
  blockerRefusal,
  type Approved,
  chainOf,
  decide,
  linkRefusal,
  type Chain,
  type Outcome,
  type PrdPullRequest,
  type Verdict,
} from "./chain.js";

type Declared = (typeof COMMANDS)["implement-prd:gate"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * What `gate.json` holds: the decision, and with it the facts the later jobs
 * build on. `slice` is the sub-issue a build run builds, and `approved` the
 * slice an approval moved the chain past, where there is one.
 */
interface Decided {
  proceed?: "true" | "false";
  decision?: "build" | "open-only" | "finishing";
  prdBranch?: string;
  prdBranchExists?: boolean;
  /** The PRD branch's tip as the gate read it, `""` where it does not exist yet. */
  prdTip?: string;
  prdPr?: number;
  /** Every slice that landed, those before the upgrade included. */
  landed?: number;
  /** How many sub-issues the PRD has. */
  total?: number;
  slice?: { readonly number: number; readonly position: number; readonly title: string };
  approved?: { readonly number: number; readonly sha: string; readonly review: string };
}

/**
 * `implement-prd:gate` (#498): everything the gate job decides, before
 * anything is checked out. Whether this run goes ahead, said on the parent
 * where it does not; which slice it builds, or whether it only opens a
 * missing PRD PR or hands a finished one over; the permission probe;
 * `agent:blocked` off; the start comments; past an approval, the note on the
 * approved slice (#499); and on a build with a PRD PR, the slice building in
 * its progress list.
 *
 * `gate.json` is its decision, `proceed`, written the moment it is decided
 * and again however this ends, as `implement:gate`'s is: a gate that died
 * before deciding writes no file where an input could not be read, and `{}`,
 * with no `proceed`, where it failed after that. The adapter reads either as
 * undecided. One that decided to go ahead writes every fact with it, so a run
 * that then fails at the probe still names the slice it was building.
 *
 * Every write is the workflow token's: nothing here has to start a run.
 */
export const gate = async (inputs: Inputs, io: Io): Promise<void> => {
  const parent = issueNumber(inputs.ISSUE_NUMBER);
  const decided: Decided = {};
  const record = (facts: Decided): void => {
    Object.assign(decided, facts);
    io.outputs.writeJson("gate.json", decided);
  };
  try {
    const { workflow } = io.writers(LIMITS);
    const ruling = await preflight(parent, inputs, io);
    if (ruling.kind === "defer") {
      // Not a refusal, and deliberately touching nothing: `implement` owns
      // this shape and is running right now on the same event.
      console.log(ruling.line);
      record({ proceed: "false" });
      return;
    }
    if (ruling.kind === "refuse") {
      record({ proceed: "false" });
      await refuse(parent, workflow, ruling.sentence, ruling.blocked);
      return;
    }
    const { chain, branch, outcome, pr } = ruling;
    const next = outcome.kind === "build" ? chain.next : undefined;
    const approved = outcome.kind === "open-only" ? undefined : outcome.approved;
    record({
      proceed: "true",
      decision: outcome.kind,
      prdBranch: branch.name,
      prdBranchExists: branch.tip !== "",
      prdTip: branch.tip,
      ...(pr === undefined ? {} : { prdPr: pr.number }),
      landed: chain.landed,
      total: chain.subIssues.length,
      ...(next === undefined ? {} : { slice: { number: next.subIssue.number, position: next.position, title: next.subIssue.title } }),
      ...(approved === undefined ? {} : { approved: { number: approved.subIssue, sha: approved.sha, review: approved.review } }),
    });
    if (next !== undefined) {
      console.log(
        `Targeting sub-issue #${next.subIssue.number} of ${chain.subIssues.length}, with ${chain.built} built and ${chain.beforeUpgrade} landed before the upgrade.`,
      );
    }
    await claim(parent, inputs, io.github, workflow, { chain, branch: branch.name, pr, next });
    if (pr === undefined) return;
    if (approved !== undefined) await noteApproved(inputs, io.github, workflow, pr.number, approved);
    if (next !== undefined) {
      await showSliceBuilding(workflow, pr.number, { position: next.position, subIssue: next.subIssue.number, total: chain.subIssues.length });
    }
  } finally {
    io.outputs.writeJson("gate.json", decided);
  }
};

/** The PRD branch: its name, and its tip, `""` where it does not exist yet. */
interface Branch {
  readonly name: string;
  readonly tip: string;
}

/** What the pre-flight came to: defer to `implement` silently, refuse on the parent, or go ahead. */
type Ruling =
  | { readonly kind: "defer"; readonly line: string }
  | { readonly kind: "refuse"; readonly sentence: string; readonly blocked: boolean }
  | {
      readonly kind: "proceed";
      readonly chain: Chain;
      readonly branch: Branch;
      readonly pr: PrdPullRequest | undefined;
      readonly outcome: Exclude<Outcome, { readonly kind: "refuse" }>;
    };

/**
 * **The pre-flight**, in today's order. The partition first, before anything
 * that speaks: an issue with no sub-issues is `implement`'s, so a closed one
 * does not collect the same "not open" comment from both. Then state, the
 * shape (each blocked: it repeats until somebody restructures the work), the
 * PRD branch, the old slice PRs into it, which sub-issues are built, the PRD
 * PR, the decision table, and on a build the "blocked by" links.
 *
 * **A failed read fails the command, with a sentence**, wherever "could not
 * look" read as "nothing there" would build: the shape, the sub-issues, the
 * branches, the slice PRs, the built slices, the PRD PR, its verdict and a
 * sub-issue's links. The PRD's own blockers are the one read that is
 * tolerated, as they always were: a failed read is none.
 */
const preflight = async (parent: number, inputs: Inputs, io: Io): Promise<Ruling> => {
  const github = io.github;
  const shape = await github.issueShape(parent);
  if (shape.subIssues === 0) return { kind: "defer", line: `#${parent} has no sub-issues, so agent-implement owns this label event.` };

  if (inputs.ISSUE_STATE !== "open") {
    return { kind: "refuse", sentence: `This issue is closed. Reopen it, then add \`${IMPLEMENT_LABEL}\` again.`, blocked: false };
  }
  // A wayfinder map with sub-issues reaches this workflow rather than
  // `implement`, so the refusal has to exist in both.
  if (shape.labels.some((label) => label.startsWith("wayfinder:"))) {
    return {
      kind: "refuse",
      sentence: `This is a planning issue (\`wayfinder:*\`), not buildable work. Add \`${IMPLEMENT_LABEL}\` to the issues it produces instead.`,
      blocked: true,
    };
  }
  // A nested PRD has two owners of one ordering, and neither can see the
  // other's chain.
  if (shape.parent !== undefined) {
    const above = shape.parent;
    return {
      kind: "refuse",
      sentence: `This PRD is itself a sub-issue of #${above}. Remove it from #${above}, or move its sub-issues up to #${above}, then label the top-level issue.`,
      blocked: true,
    };
  }
  if (shape.subIssues > MAX_SUB_ISSUES) {
    return {
      kind: "refuse",
      sentence: `This PRD has ${shape.subIssues} sub-issues, and the loop handles at most ${MAX_SUB_ISSUES}. Split it into smaller PRDs.`,
      blocked: true,
    };
  }

  // Read once, every page, and held to the count: a list that came back short
  // would read its missing slices as never there, and could call a live chain
  // finished.
  const subIssues = await read("this PRD's sub-issues", () => github.subIssues(parent));
  if (subIssues.length !== shape.subIssues) {
    throw new Error(
      `This PRD's sub-issue list came back with ${subIssues.length} of its ${shape.subIssues} sub-issues, so nothing was built. Add \`${IMPLEMENT_LABEL}\` again.`,
    );
  }
  // Kept for `implement-prd:publish`, which writes its `Closes` lines from
  // the same snapshot every branch below rules on, in the shape the shell
  // query it replaced gave it.
  io.outputs.writeJson("prd-issue.json", {
    parent: null,
    labels: { nodes: shape.labels.map((name) => ({ name })) },
    subIssues: { totalCount: subIssues.length, nodes: subIssues.map((sub) => ({ number: sub.number, title: sub.title, state: sub.state })) },
  });

  const branch = await prdBranchOf(parent, inputs.ISSUE_TITLE, github);
  if (branch.tip !== "") {
    // Pre-upgrade compatibility, removable under #224: a slice PR an older
    // release opened into the PRD branch, still open, is a slice this release
    // cannot see on the branch and must not build over.
    const old = (await read(`slice PRs still open into \`${branch.name}\``, () => github.openPullRequests({ base: branch.name }), "look for")).filter(
      (pr) => pr.head.startsWith(OLD_SLICE_PREFIX),
    );
    if (old.length > 0) {
      return {
        kind: "refuse",
        sentence: `Slice PRs from an earlier release are still open into this PRD's branch \`${branch.name}\`: ${old.map((pr) => `#${pr.number} (\`${pr.head}\`)`).join(", ")}. This release builds every slice on the PRD branch itself and doesn't use slice PRs, so it won't build over them. Merge or close each by hand; if you close one without merging it, reopen its sub-issue so it's built again. Then add \`${IMPLEMENT_LABEL}\` again.`,
        blocked: true,
      };
    }
  }

  // Read from the commits the PRD branch has and the base lacks, so a
  // default-branch history the chain merged in names nothing.
  const messages =
    branch.tip === ""
      ? []
      : await read(
          `which sub-issues are already built on \`${branch.name}\``,
          () => github.commitMessages(inputs.BASE_REF, branch.tip),
          "read",
        );
  const chain = chainOf(subIssues, messages);
  const pr = branch.tip === "" ? undefined : await prdPullRequestOf(branch.name, github);

  let outcome: Outcome;
  const ruled = decide(chain, pr);
  if (ruled.kind === "verdict") {
    const head = ruled.pr.headSha;
    const statuses = await read(`the review verdict on PRD PR #${ruled.pr.number}'s latest commit`, () => github.commitStatuses(head), "read");
    const latest = statuses.find((status) => status.context === VERDICT_CONTEXT);
    const verdict: Verdict | undefined =
      latest === undefined ? undefined : { state: latest.state, description: latest.description, targetUrl: latest.targetUrl };
    if (verdict?.state === "success") console.log(`PRD PR #${ruled.pr.number}'s latest commit ${head} has an approval; the chain moves on.`);
    outcome = afterVerdict(chain, ruled.pr, verdict);
  } else {
    outcome = ruled;
  }
  if (outcome.kind === "refuse") return { kind: "refuse", sentence: outcome.sentence, blocked: false };
  if (outcome.kind === "open-only") {
    console.log(`Slices of #${parent} are on \`${branch.name}\` but no PRD PR is open from it; opening one and asking for its review. Nothing is built.`);
  }
  if (outcome.kind === "finishing") console.log(`Every sub-issue of #${parent} is built; finishing it.`);

  if (outcome.kind === "build") {
    // The links, once, before the first build: never as later slices are
    // reached (`linkRefusal`).
    if (chain.landed === 0) {
      const order = subIssues.map((sub) => sub.number);
      for (const sub of order) {
        const links = await read(`the "blocked by" links of sub-issue #${sub}`, () => github.blockedBy(sub), "read");
        const sentence = linkRefusal(order, sub, links);
        if (sentence !== undefined) return { kind: "refuse", sentence, blocked: true };
      }
    }
    // After the finished PRD's refusal, which is never blocked: this one is
    // only *not yet*, and gives way when they collide. Blocked all the same,
    // since `agent:blocked` is the one way to find work that is waiting.
    let blockers: readonly number[] = [];
    try {
      blockers = await github.openBlockers(parent);
    } catch (error) {
      console.log(`::warning::Could not read what blocks #${parent}; going ahead as though nothing does. ${describe(error)}`);
    }
    const sentence = blockerRefusal(blockers);
    if (sentence !== undefined) return { kind: "refuse", sentence, blocked: true };
  }
  return { kind: "proceed", chain, branch, pr, outcome };
};

/**
 * The PRD branch, found on the remote by the **stable half** of its name,
 * `agent/prd-<parent>-`: the slug half comes from the parent's title, which
 * is editable, and recomputing it every run would fork the chain on a retitle.
 * So the slug only ever names a branch that does not exist yet. Two branches
 * for one PRD is the fork the lookup exists to prevent, and picking either one
 * drops whatever is on the other.
 */
const prdBranchOf = async (parent: number, title: string, github: GitHubReader): Promise<Branch> => {
  const found = await read("this PRD's branch", () => github.branchesStarting(prdBranchStem(parent)), "look for");
  if (found.length > 1) {
    throw new Error(
      `More than one branch is named for this PRD: ${found.map((branch) => `\`${branch.name}\``).join(", ")}. It can't tell which one holds the slices already built. Delete or rename all but one.`,
    );
  }
  const [only] = found;
  return only === undefined ? { name: prdBranch(parent, title), tip: "" } : { name: only.name, tip: only.tip };
};

/** The PRD PR, found by its **head**, the PRD branch, where one is open. Two open from it is a guess it will not make. */
const prdPullRequestOf = async (branch: string, github: GitHubReader): Promise<PrdPullRequest | undefined> => {
  const what = `the PRD PR from \`${branch}\``;
  const open = await read(what, () => github.openPullRequests({ head: branch }), "look for");
  if (open.length > 1) {
    throw new Error(`${open.map((pr) => `#${pr.number}`).join(", ")} are all open from this PRD's branch \`${branch}\`, so it can't tell which one is the PRD PR. Close all but one.`);
  }
  const [only] = open;
  if (only === undefined) return undefined;
  const pr = await read(what, () => github.pullRequest(only.number), "look for");
  return { number: pr.number, draft: pr.draft, labels: pr.labels, body: pr.body, headSha: pr.headSha };
};

/**
 * A run it claims: the permission probe, `agent:blocked` off, then the start
 * comments (#298), each run's link once, on the sub-issue it builds, and the
 * other surfaces pointing there by `#N`: the parent on the chain's first run
 * only, with no link, and the PRD PR a chapter marker. Each comment is a
 * warning where it cannot be posted: nothing has been done yet that a stopped
 * run would need to report.
 */
const claim = async (
  parent: number,
  inputs: Inputs,
  github: GitHubReader,
  workflow: Writer,
  facts: {
    readonly chain: Chain;
    readonly branch: string;
    readonly pr: PrdPullRequest | undefined;
    readonly next: { readonly subIssue: SubIssue; readonly position: number } | undefined;
  },
): Promise<void> => {
  // **The permission probe**: it adds the label this run already holds,
  // which changes nothing, and is not tolerated, so a short token fails the
  // run here, before the checkout.
  try {
    await workflow.addLabel(parent, IMPLEMENT_LABEL);
  } catch (error) {
    if (!(error instanceof WriteFailed)) throw error;
    throw new Error(
      `Couldn't add \`${IMPLEMENT_LABEL}\` to #${parent}, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants \`issues: write\`.`,
      { cause: error },
    );
  }
  // The trigger label stays on while this run works and comes off in its
  // last step (#236), so the one label to take off here is a block an earlier
  // run left.
  await tolerated(undefined, () => workflow.removeLabel(parent, BLOCKED_LABEL));
  const { next, pr, chain } = facts;
  if (next === undefined) return;
  const sub = next.subIssue.number;

  // The chain's first run, once: a retry of a first run that stopped finds
  // the comment it posted, by its mark, and posts no second. A failed read is
  // none posted, as it always was.
  if (chain.landed === 0) {
    let posted = false;
    try {
      posted = (await github.issueComments(parent)).some((body) => body.includes(PRD_STARTED_MARK));
    } catch (error) {
      console.log(`::warning::Could not read the comments on #${parent}, so the start comment may be posted twice. ${describe(error)}`);
    }
    if (!posted) {
      await tolerated(`Could not post the start comment on #${parent}. The run goes on; it is ${inputs.RUN_URL}.`, () =>
        workflow.comment(parent, `**\`${IMPLEMENT_LABEL}\` started:** building #${sub} first.\n\n${PRD_STARTED_MARK}`),
      );
    }
  }
  const where =
    pr === undefined ? `on the PRD branch \`${facts.branch}\`, whose PRD PR opens once this slice is pushed` : `on PRD PR #${pr.number}`;
  await tolerated(`Could not post the start comment on sub-issue #${sub}. The run goes on; it is ${inputs.RUN_URL}.`, () =>
    workflow.comment(sub, `**\`${IMPLEMENT_LABEL}\` started:** Building now ${where} · [Workflow run](${inputs.RUN_URL})`),
  );
  if (pr !== undefined) {
    await tolerated(`Could not say on PRD PR #${pr.number} that sub-issue #${sub} started.`, () =>
      workflow.comment(pr.number, `**Slice ${next.position} of ${chain.subIssues.length} · #${sub} started**`),
    );
  }
};

/**
 * **The approved slice, on its own sub-issue** (#246): the run past an
 * approval has passed its gate, so the slice the PRD PR's head was approved on
 * is done with, and its sub-issue records what shipped for it, while it stays
 * open until the PRD PR merges. Built in the approved head, reviewed on the
 * PRD PR, and the criteria the approving round's record (#214) says changed
 * or went unmet, read back from the approving review's body, which the
 * verdict links, by `readCriteriaChanges`, or that none did.
 *
 * Once per approved head, by its mark: a retry past the same approval, after
 * a run that failed, finds the note it posted. A tolerated write: a note that
 * cannot be read or posted says so in a warning, and the chain goes on.
 */
const noteApproved = async (inputs: Inputs, github: GitHubReader, workflow: Writer, pr: number, approved: Approved): Promise<void> => {
  const { subIssue: sub, sha, review } = approved;
  const mark = sliceApprovedMark(sha);
  try {
    if ((await github.issueComments(sub)).some((body) => body.includes(mark))) {
      console.log(`Sub-issue #${sub} already has its approved-slice note for ${sha}.`);
      return;
    }
  } catch (error) {
    console.log(`::warning::Could not read the comments on sub-issue #${sub}, so its approved-slice note may be posted twice. ${describe(error)}`);
  }
  const id = /#pullrequestreview-([0-9]+)$/.exec(review)?.[1];
  let body = "";
  if (id !== undefined) {
    try {
      body = (await github.reviews(pr)).find((posted) => posted.url.endsWith(`#pullrequestreview-${id}`))?.body ?? "";
    } catch (error) {
      console.log(`Could not read the reviews on PRD PR #${pr}: ${describe(error)}`);
    }
  }
  let criteria = "**Acceptance criteria changed or unmet:** none.";
  if (body === "") {
    criteria =
      "**Acceptance criteria changed or unmet:** the approving review couldn't be read, so they aren't listed here; its *Acceptance criteria* section has them.";
    console.log(`::warning::Could not read the review that approved sub-issue #${sub} (${review || "no link"}), so its note does not list the criteria.`);
  } else {
    const changes = readCriteriaChanges(body) ?? [];
    if (changes.length > 0) {
      const lines = changes.map((change) => `- **${change.status === "changed" ? "Changed" : "Unmet"}:** ${change.line}`);
      criteria = `**Acceptance criteria changed or unmet:**\n\n${lines.join("\n")}`;
    }
  }
  const short = `\`${sha.slice(0, 7)}\``;
  const commit = inputs.GITHUB_SERVER_URL === "" ? short : `[${short}](${inputs.GITHUB_SERVER_URL}/${inputs.GH_REPO}/commit/${sha})`;
  const reviewed = review === "" ? `reviewed on PRD PR #${pr}` : `[reviewed](${review}) on PRD PR #${pr}`;
  await tolerated(`Could not post the approved-slice note on sub-issue #${sub}. The run goes on.`, () =>
    workflow.comment(
      sub,
      `**Slice approved:** built in ${commit}, ${reviewed}. This sub-issue stays open until the PRD PR merges.\n\n${criteria}\n\n${mark}`,
    ),
  );
};

/**
 * **The slice building** in the PRD PR's progress list and status line (#246,
 * #312), written here because the gate runs no agent: the agent's job reads
 * only (#308). Spliced into the live body, as `showBuilding` builds it from
 * the slice alone. A body with half a list, or two, or a list with no row for
 * the slice, is left as it stands, with a warning, and one with no list is
 * left with a line saying so.
 *
 * A run that stops after this writes the stopped slice's row back,
 * `implement-prd:conclude`, from the PRD branch as the run left it (#325).
 * A tolerated write: the list is a view of the chain, and a slice is worth
 * more than it.
 */
const showSliceBuilding = async (
  workflow: Writer,
  pr: number,
  slice: { readonly position: number; readonly subIssue: number; readonly total: number },
): Promise<void> => {
  const sub = slice.subIssue;
  let shown: ReturnType<typeof showBuilding> | undefined;
  const wrote = await tolerated(inWriteLog(`Could not write PRD PR #${pr}'s progress list, so it does not show sub-issue #${sub} building.`), () =>
    workflow.editPullRequest(pr, {
      body: (live) => {
        shown = showBuilding(live, slice);
        return shown.kind === "write" ? shown.body : undefined;
      },
    }),
  );
  if (!wrote) return;
  switch (shown?.kind) {
    case "half":
      console.log(
        `::warning::PRD PR #${pr}'s body carries half a progress list, or two, so it was not written. Restore the missing marker, or delete the markers and the text between them, and the next ending of a round writes it again.`,
      );
      return;
    case "none":
      console.log(`PRD PR #${pr}'s body carries no progress list, so none shows sub-issue #${sub} building.`);
      return;
    case "no row":
      console.log(
        `::warning::PRD PR #${pr}'s progress list has no row for sub-issue #${sub} as slice ${slice.position}, so it was not written. The next ending of a round writes it again.`,
      );
      return;
    default:
      console.log(`PRD PR #${pr}'s progress list shows sub-issue #${sub} building.`);
  }
};

/**
 * A refusal, in the loop's one order (#236): the comment first, then this
 * run's own label off, then `agent:blocked` where it is durable, so the label
 * that names the next step goes on last. Each write is tolerated: a comment
 * that fails still takes the label off.
 */
const refuse = async (parent: number, workflow: Writer, sentence: string, blocked: boolean): Promise<void> => {
  await tolerated(`Could not post the refusal comment on #${parent}.`, () =>
    workflow.comment(parent, `**\`${IMPLEMENT_LABEL}\` didn't run:** ${sentence}`),
  );
  await tolerated(undefined, () => workflow.removeLabel(parent, IMPLEMENT_LABEL));
  if (blocked) await tolerated(undefined, () => workflow.addLabel(parent, BLOCKED_LABEL));
};

/** `fetch`, or a sentence saying `what` could not be read and nothing was built. */
const read = async <T>(what: string, fetch: () => Promise<T>, verb: "read" | "look for" = "read"): Promise<T> => {
  try {
    return await fetch();
  } catch (error) {
    throw new Error(`Couldn't ${verb} ${what}, so nothing was built. ${describe(error)}`, { cause: error });
  }
};

/**
 * The most sub-issues the loop takes on. The reader pages past it, so the
 * count this refuses on is true; the refusal stays, as it was.
 */
const MAX_SUB_ISSUES = 100;

/** Pre-upgrade compatibility, removable under #224: the head an older release's slice PR came from. */
const OLD_SLICE_PREFIX = "agent/slice-";

/**
 * What the gate may write, and how many of each (ADR 0005). A refusal is one
 * comment, `agent:implement` off and, where durable, `agent:blocked` on; a
 * run that goes ahead is the probe's `agent:implement`, `agent:blocked` off,
 * at most three start comments and the approved slice's note, and the one
 * edit that shows the slice building. Never both.
 */
const LIMITS: Limits = { comment: 4, removeLabel: 2, addLabel: 2, editPullRequest: 1 };
