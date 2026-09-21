import { isWorkflowBot } from "./common.js";
import {
  capFollowUps,
  embeddableJson,
  FOLLOW_UPS_LABEL,
  hasFollowUpsBlock,
  parseFollowUpsBlock,
  type FollowUp,
} from "./review-output.js";

/**
 * The filing decision (#48): everything gathered from GitHub in, the list of
 * actions to perform out, and no I/O in between.
 *
 * The half that runs this gathers three things — the reviews on the pull
 * request, over GraphQL because REST cannot see whether a body was edited; the
 * marker label, re-fetched rather than read from the event payload; and the
 * label-filtered stub listing — and then performs what comes back. Neither half
 * decides anything, which is the point: this is where the authenticity gate and
 * the duplicate rules can be argued with from plain objects, rather than
 * observed in production while holding `issues: write`.
 */

/** The triage vocabulary's entry point. A stub arrives as work to judge, not as work to do. */
export const TRIAGE_LABEL = "needs-triage";

/**
 * And the label that says where a stub came from. Also the candidate filter the
 * gather half lists on: **list and match, never search**. A label filter is
 * exact, where issue search tokenizes on path punctuation and is fuzzy in both
 * directions — and a spurious search hit skips a real finding silently, which
 * is the one direction nothing here fails in.
 */
export const FOLLOW_UP_STUB_LABEL = "pr-follow-up";

export const STUB_LABELS: readonly string[] = [TRIAGE_LABEL, FOLLOW_UP_STUB_LABEL];

/**
 * Titles longer than this are truncated rather than refused. A triage list is
 * read at a glance, and a title that wraps costs every other row on the screen.
 */
export const MAX_STUB_TITLE = 80;

/** GitHub's close reason for a `wontfix` decision, in both spellings the two APIs report. */
const WONTFIX_REASON = "not_planned";

/** A review of the pull request, as the GraphQL read returns it. */
export interface FilingReview {
  /** `login`, in whichever of the two spellings the API that read it uses. */
  readonly author: string;
  readonly body: string;
  /**
   * When the body was last edited, `null` when it never was.
   *
   * Required rather than optional on purpose. An edit preserves the author, the
   * author association, and both timestamps a verifier would naively reach for,
   * so this is the only field that can answer the question — and a gather half
   * that could not read it must say so by failing rather than by omitting it
   * into a pass.
   */
  readonly lastEditedAt: string | null;
  /** Where a reader goes to see the finding in the context it was raised in. */
  readonly url: string;
}

/** An existing `pr-follow-up` issue, open or closed. */
export interface FilingStub {
  readonly number: number;
  /** `OPEN` / `CLOSED`, in either API's casing. */
  readonly state: string;
  /** `NOT_PLANNED` / `COMPLETED` / `null`, in either API's casing. */
  readonly stateReason: string | null;
  readonly body: string;
}

export interface FilingInput {
  /** The pull request currently filing — the idempotence case turns on this. */
  readonly prNumber: number;
  /** Every review on it, **oldest first**, as both APIs list them. */
  readonly reviews: readonly FilingReview[];
  /** Every `pr-follow-up` issue in the repository, open and closed. */
  readonly stubs: readonly FilingStub[];
}

export interface PlannedIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  /** The normalised path this was filed against — for the log, and for a reader of the plan. */
  readonly path: string;
  /**
   * The token standing in for this issue's reference in `report`, to be
   * replaced with `#<number>` once the issue exists.
   *
   * A plan is a pure function of what was gathered, and an issue number is not
   * something that can be gathered before the issue is created. The alternative
   * is a comment that names the path and not the issue, which is the one thing
   * a reader of that line wants to click.
   */
  readonly placeholder: string;
}

export interface PlannedStubComment {
  readonly issue: number;
  readonly body: string;
}

export interface FilingPlan {
  /** Stubs to open, in the order the reviewer listed them. */
  readonly issues: readonly PlannedIssue[];
  /** Comments to add to existing stubs — the chronic case, and nothing else. */
  readonly stubComments: readonly PlannedStubComment[];
  /**
   * What to post on the pull request, or `undefined` for the silent exit.
   *
   * Silence is for *no findings block at all*. It is not licence to suppress
   * the report of a suppression: a run that files nothing but matched something
   * still says so, or a wrong skip is invisible.
   */
  readonly report: string | undefined;
  /**
   * Whether to remove the marker label. Removed on success — including a
   * success in which everything was suppressed — and left in place on every
   * refusal, where it is the retry affordance and the signal that this pull
   * request's findings are unfiled.
   */
  readonly removeMarker: boolean;
}

/** Nothing to do and nothing to say. A fresh object each time, so no caller can share one. */
const silent = (): FilingPlan => ({
  issues: [],
  stubComments: [],
  report: undefined,
  removeMarker: false,
});

const refusal = (report: string): FilingPlan => ({
  issues: [],
  stubComments: [],
  report,
  removeMarker: false,
});

/** A title is meant to be one line, and a model that wrapped one must not break the list it sits in. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Anything with a `/` or a `.` in it. Deliberately loose: the job is to skip
 * the connecting words in `src/a.ts and src/b.ts`, not to adjudicate what is a
 * path — a stricter rule fails closed, and failing closed here loses a finding.
 */
const PATH_SHAPED = /[/.]/;

/**
 * A `location` reduced to the key duplicate detection runs on.
 *
 * The trailing line number is **stripped and discarded**. Line numbers drift,
 * so two reviews of the same chronic problem nearly always disagree on the
 * line, and keying on it makes dedup fail precisely where the feature is aimed.
 * Not case-folded: two paths differing only in case are two files on the
 * platform this runs on.
 *
 * A multi-file location matches on its first path-shaped token and the rest is
 * ignored. Multi-file is the agent freelancing on a single-value field, "any
 * overlap" is the closest honest reading of it, and refusing would lose the
 * finding — which is the one outcome worse than filing a duplicate.
 */
const normaliseLocation = (location: string): string => {
  const tokens = location.trim().split(/[\s,;]+/).filter((token) => token.length > 0);
  const token = tokens.find((candidate) => PATH_SHAPED.test(candidate)) ?? tokens[0] ?? "";
  const path = token.replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "");
  return path === "" ? token : path;
};

/**
 * The stub payload's shape, versioned for the same reason the review block is
 * and on its own timeline (#81): the two are written and read by different
 * pairs of releases, and the gap this one spans is the longer of the two — a
 * key written into an issue is read back by every run after it, for as long as
 * the issue is open.
 *
 * Deliberately **not** the block's `FOLLOW_UPS_VERSION`, which they shared
 * until this was split out. Moving one to reshape the other's payload is a cost
 * with no connection to the change that caused it: a bump here would also
 * refuse every findings block already posted by the previous release, filing
 * nothing for pull requests that recorded their findings correctly.
 * `embeddableJson` stays shared, because a JSON escaper is not the coupling.
 */
export const STUB_KEY_VERSION = 1;

/**
 * The key a stub is matched on, written into the stub and read back on the next
 * run. Never the prose: a stub may be reworded freely, and a matcher that read
 * the prose would break on the first person who tidied one up.
 */
const dedupPayload = (path: string, prNumber: number): string =>
  `<!--${embeddableJson({ version: STUB_KEY_VERSION, location: path, pr: prNumber })}-->`;

/**
 * Any HTML comment holding a bare JSON object. The review body's block carries
 * its marker word before the `{`, so this cannot pick that one up by accident.
 */
const STUB_PAYLOAD = /<!--\s*(\{[\s\S]*?\})\s*-->/g;

interface StubKey {
  readonly path: string;
  readonly pr: number;
}

/**
 * The payload on a stub, or `undefined` when it has none this version can read.
 *
 * A stub without one — hand-written, or from before a format change — simply
 * does not match, so the finding is filed as a duplicate rather than skipped.
 * An unreadable payload is treated the same way for the same reason: a
 * duplicate issue is loud and cheap, and a skipped finding is silent and
 * unrecoverable.
 *
 * The **last** readable payload wins, which is `parseFollowUpsBlock`'s rule for
 * the identical hazard and for the identical reason: `stubBody` writes the
 * agent's prose *before* the key, and that prose is evidence quoting the code —
 * which on this feature's own files is a payload. Reading the first would let a
 * quoted decoy key a real finding, absorbing it as a re-flag of somewhere else:
 * a silent skip, the one direction nothing here fails in.
 */
const stubKey = (body: string): StubKey | undefined => {
  for (const match of [...body.matchAll(STUB_PAYLOAD)].reverse()) {
    let payload: unknown;
    try {
      payload = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    if (typeof payload !== "object" || payload === null) continue;
    const record = payload as Record<string, unknown>;
    if (record["version"] !== STUB_KEY_VERSION) continue;
    const location = record["location"];
    const pr = record["pr"];
    if (typeof location !== "string" || typeof pr !== "number") continue;
    // Re-normalised on the way in as well as on the way out, so a payload
    // written by hand — or by a release whose normalisation was narrower —
    // still matches what this run would produce.
    return { path: normaliseLocation(location), pr };
  }
  return undefined;
};

type MatchKind = "same-pr" | "open" | "wontfix";

interface StubMatch {
  readonly stub: FilingStub;
  readonly kind: MatchKind;
}

const isClosed = (stub: FilingStub): boolean => stub.state.toLowerCase() === "closed";
const isWontfix = (stub: FilingStub): boolean =>
  isClosed(stub) && (stub.stateReason ?? "").toLowerCase() === WONTFIX_REASON;

/**
 * The stub a finding is a duplicate of, if any.
 *
 * Open stubs and `wontfix`-closed ones are candidates and nothing else is: a
 * stub closed because someone **fixed** it has to refile if the problem
 * returns, or a regression is swallowed. Known and accepted, and stated here so
 * a reader neither re-derives it nor assumes it was overlooked: a `wontfix`
 * suppression never expires, and the set read here only ever grows.
 *
 * The priority is a tie-break with a reason rather than an ordering that fell
 * out of the list. Same pull request first, because that answer is exactly
 * right and the other two would both be wrong on a retry. Then open over
 * `wontfix`, because an open stub at a path someone also declined work at is
 * the later decision of the two. Highest number within a category, which is the
 * most recent.
 *
 * **The idempotence that buys is same-pull-request-scoped, and the re-flag path
 * is at-least-once.** A retry after a partial failure meets a stub *this* pull
 * request filed through its `pr` field and reports it as already filed; a
 * *chronic* stub carries somebody else's number, so the retry takes the `open`
 * branch again and comments "Flagged again by #N" a second time. Accepted
 * rather than overlooked: closing it means reading every candidate stub's
 * comments before re-flagging — a page of comments per match, on the one
 * workflow here holding `issues: write` — to prevent a duplicate line on an
 * issue that is already about exactly that. A duplicate comment is loud and
 * cheap, which is the direction everything in this file fails in.
 */
const matchStub = (
  stubs: readonly FilingStub[],
  path: string,
  prNumber: number,
): StubMatch | undefined => {
  const candidates = stubs
    .map((stub) => ({ stub, key: stubKey(stub.body) }))
    .filter((candidate): candidate is { stub: FilingStub; key: StubKey } =>
      candidate.key?.path === path,
    )
    .filter(({ stub }) => !isClosed(stub) || isWontfix(stub))
    .sort((a, b) => b.stub.number - a.stub.number);

  const samePr = candidates.find(({ key }) => key.pr === prNumber);
  if (samePr) return { stub: samePr.stub, kind: "same-pr" };

  const open = candidates.find(({ stub }) => !isClosed(stub));
  if (open) return { stub: open.stub, kind: "open" };

  const wontfix = candidates[0];
  return wontfix ? { stub: wontfix.stub, kind: "wontfix" } : undefined;
};

/**
 * The stub body: the agent's two prose beats, then the location line, then
 * provenance, then the key.
 *
 * The title is not repeated as a heading — GitHub renders it already. The
 * location line is for a human and is **never read back**; matching is on the
 * payload, so this one keeps the line number the agent gave.
 *
 * Provenance links the review the block was *read* from, which is the latest
 * one, and says so in words. Walking back through nine reviews to find the
 * first occurrence would have to match on prose, so a finding the agent
 * reworded between rounds would look new.
 */
const stubBody = (
  followUp: FollowUp,
  review: FilingReview,
  prNumber: number,
  path: string,
): string =>
  [
    followUp.body.trim(),
    "",
    `**Location:** \`${oneLine(followUp.location)}\``,
    "",
    "---",
    "",
    `Read from [a review](${review.url}) on #${prNumber}. That review is where this finding was *read*, not necessarily where it was first raised — each review restates its whole list, so an earlier one may have raised it first.`,
    "",
    dedupPayload(path, prNumber),
  ].join("\n");

/** "Flagged again by #N" is evidence of chronicity, and chronicity is what triage most wants to see. */
const reflagBody = (followUp: FollowUp, review: FilingReview, prNumber: number): string =>
  [
    `Flagged again by #${prNumber}: **${oneLine(followUp.title)}** at \`${oneLine(followUp.location)}\`.`,
    "",
    `Read from [a review](${review.url}) on that pull request. No second issue was opened — this one already covers the path.`,
  ].join("\n");

/**
 * Decide what a merged pull request's recorded findings become.
 *
 * Four gates sit in front of the rules, and they are deliberately not all the
 * same kind. No block at all is **silent**, and so is a block nothing but the
 * review runner posted — that is the ordinary case, and a comment on every
 * merge is noise that teaches people to stop reading these. An edited body and
 * a payload version this does not know both **refuse out loud**, because both
 * populations who reach them need to see it: a tamper attempt should not be
 * absorbed in silence, and someone who edited a review to fix a typo has to
 * learn that the edit cost them the filing.
 */
export const planFollowUps = (input: FilingInput): FilingPlan => {
  // The latest bot review carrying a block wins, and earlier ones are ignored
  // rather than merged. That is the restatement rule seen from the reading end:
  // because each run restates the whole set, the newest block is the complete
  // answer and every older one is a superseded draft. Nine reviews on one pull
  // request is an ordinary shape.
  //
  // A block is what a review *run* leaves, found or not — a run that recorded
  // nothing writes an empty one — so the newest block is the newest run and a
  // later round genuinely retracts. Carrying none means no run of this version
  // posted that body: a `fix` run's thread replies, an older release, a human.
  // Those are skipped rather than read as an all-clear, which is what stops a
  // thread reply from retracting a finding nobody addressed.
  //
  // The login is part of the *selection*, not a veto applied afterwards. A
  // review is world-writable on a public repository, so refusing because
  // somebody else posted a block last would hand anyone a way to stop a filing.
  const carrying = input.reviews.filter(
    (review) => isWorkflowBot(review.author) && hasFollowUpsBlock(review.body),
  );
  const review = carrying[carrying.length - 1];
  if (!review) return silent();

  // No fallback to an earlier review. An edit preserves every other field a
  // verifier would reach for, so this is the check; falling back would turn
  // "edit the newest review" into a way of choosing which set of findings gets
  // filed. The manual entry point does not override it either — a control with
  // a one-label bypass is not a control — and the escape hatch is the right one
  // already: a human who has read the finding opens the issue by hand.
  if (review.lastEditedAt !== null) {
    return refusal(
      [
        `**No follow-ups were filed.** [The review](${review.url}) they were recorded in has been edited since it was submitted, and an edited body cannot drive issue creation.`,
        "",
        `The check is that the body changed at all, not what changed in it, and re-applying \`${FOLLOW_UPS_LABEL}\` does not override it. If the findings are real, open the issues by hand; the label is left in place so this pull request stays findable.`,
      ].join("\n"),
    );
  }

  let block: { followUps: FollowUp[]; dropped: number } | undefined;
  try {
    block = parseFollowUpsBlock(review.body);
  } catch (error) {
    return refusal(
      [
        `**No follow-ups were filed.** [The review](${review.url}) carries a findings block this version cannot read: ${error instanceof Error ? error.message : String(error)}.`,
        "",
        `Guessing at a shape it does not know would file issues from fields that may have moved, so it filed none. The \`${FOLLOW_UPS_LABEL}\` label is left in place.`,
      ].join("\n"),
    );
  }
  if (!block) return silent();

  // Capped again, at the end that holds `issues: write`. The review runner
  // already applied it, so this bites only on a payload that did not come from
  // one — and the note below stays truthful either way.
  const { kept, dropped: over } = capFollowUps(block.followUps);
  const dropped = block.dropped + over;

  const issues: PlannedIssue[] = [];
  const stubComments: PlannedStubComment[] = [];
  const lines: string[] = [];
  /** Paths already spoken for by an earlier finding in this same batch, and by which one. */
  const claimed = new Map<string, string>();

  for (const followUp of kept) {
    const path = normaliseLocation(followUp.location);
    const title = oneLine(followUp.title);

    // The same rule within the batch, first wins. Applying it against the
    // tracker but not here would make the second finding's fate depend on a
    // race with issue creation. This is also where path-only matching is most
    // likely to be genuinely wrong, which is why the sibling is named: that is
    // what makes a wrong skip correctable rather than merely regrettable.
    const sibling = claimed.get(path);
    if (sibling !== undefined) {
      lines.push(
        `- **Suppressed** — \`${path}\` — the same path as *${sibling}*, listed first in this review and handled above.`,
      );
      continue;
    }
    claimed.set(path, title);

    const match = matchStub(input.stubs, path, input.prNumber);
    if (!match) {
      const placeholder = `{{follow-up-issue-${issues.length}}}`;
      issues.push({
        // Verbatim and unprefixed. A pull-request-number prefix is provenance
        // visible without opening the issue, but it eats the left edge of every
        // title in a triage list — where a scanner's eye lands — and
        // `pr-follow-up` already carries the same fact in colour.
        title: title.length <= MAX_STUB_TITLE ? title : `${title.slice(0, MAX_STUB_TITLE - 1)}…`,
        body: stubBody(followUp, review, input.prNumber, path),
        labels: STUB_LABELS,
        path,
        placeholder,
      });
      lines.push(`- **Filed** — \`${path}\` — ${placeholder}`);
      continue;
    }

    if (match.kind === "same-pr") {
      // Neither new nor chronic: this is the same pull request meeting itself
      // on a retry, and it is what makes that retry exactly idempotent.
      lines.push(
        `- **Already filed by this pull request** — \`${path}\` — #${match.stub.number}, which it opened for this same path already.`,
      );
      continue;
    }

    if (match.kind === "wontfix") {
      // Visible here and commented nowhere. Notifying the people who decided
      // not to do it, to tell them it is still true, is relitigating a closed
      // decision on a schedule.
      lines.push(
        `- **Suppressed** — \`${path}\` — #${match.stub.number} was closed as \`wontfix\`; nothing was commented there.`,
      );
      continue;
    }

    stubComments.push({
      issue: match.stub.number,
      body: reflagBody(followUp, review, input.prNumber),
    });
    lines.push(`- **Re-flagged** — \`${path}\` — commented on #${match.stub.number}.`);
  }

  // A readable block that asked for nothing: the retraction, and the ordinary
  // shape of every review that found nothing out of scope. Nothing to file and
  // nothing to say — but the marker comes off, because this pull request's
  // latest list is empty and there is nothing left unfiled to find it by.
  if (lines.length === 0 && dropped === 0) {
    return { issues: [], stubComments: [], report: undefined, removeMarker: true };
  }

  return {
    issues,
    stubComments,
    report: [
      `**Out-of-scope findings**, read from [the review](${review.url}) on this pull request:`,
      "",
      ...lines,
      // The post-merge half of announcing truncation. The review body said it
      // first, where the author could still act on it; this is the half that
      // survives the merge as a record of what was lost.
      ...(dropped === 0
        ? []
        : [
            "",
            `${dropped} further finding${dropped === 1 ? " was" : "s were"} dropped by the cap, so nothing was filed for ${dropped === 1 ? "it" : "them"}.`,
          ]),
    ].join("\n"),
    removeMarker: true,
  };
};
