import { asArray, asRecord, asString, standardSchema } from "./common.js";
import {
  findingMarker,
  isPreviouslyMissed,
  openingClaim,
  parseFinding,
  parseSeverity,
  severityBadge,
  severityRank,
  SEVERITIES,
  withoutFindingMarkers,
  type Finding,
  type PlacedFinding,
  type Severity,
} from "./review-findings.js";
import {
  parseVerification,
  type CarriedFinding,
  type VerificationEntry,
} from "./review-verification.js";

/**
 * A problem the review found and this pull request will not fix — a defect in a
 * function the diff only calls, a missing test for behaviour it did not change.
 * The third output channel, beside the summary and the findings (#47).
 *
 * It exists because both of the other two lose it. A finding in the summary is
 * text on a review nobody reads once the PR has merged; and a `fixBeforeMerge`
 * finding is about this pull request by definition, which an out-of-scope one
 * is not.
 */
export interface FollowUp {
  /** One line, as a human scans it in a triage list. */
  readonly title: string;
  /** `path` or `path:line` — where a reader starts. Not validated against the diff. */
  readonly location: string;
  /** Evidence it is real, then why this PR cannot fix it. */
  readonly body: string;
  /**
   * How bad it is, for display (#109, decision 9) — shown in the recorded block
   * on the pull request and written into the stub filed once it merges, which
   * is the surface it matters on: a triage list is read at a glance, and a
   * stub that arrives without one is rated by whoever opens it first.
   *
   * It does **not** reorder this list. The cap drops from the end and the
   * finding's place in it is half the dedup key a filing run recognises its own
   * work by (`shared/follow-up-plan.ts`), so sorting here would change which
   * findings are filed and which stub a retry matched — a display field
   * deciding an outcome, which is the thing severity exists not to be.
   */
  readonly severity: Severity;
}

/**
 * At most this many per review. Enforced by `capFollowUps` and *never* by the
 * schema — see the comment there.
 */
export const MAX_FOLLOW_UPS = 3;

/**
 * What this pull request does, described and never evaluated (#109, decision 8
 * as the maintainer settled it).
 *
 * Two fields rather than one paragraph, and both capped by the schema rather
 * than only asked for in the brief: a prompt-only "under 250 words" is a limit
 * with no enforcement behind it, and the body it produced ran long enough to
 * bury the record above it.
 */
export interface WhatChanged {
  /** One sentence. What this pull request is. */
  readonly summary: string;
  /**
   * What it changes, one line each. Description only — an evaluation belongs in
   * a finding, where it is counted, or nowhere.
   */
  readonly changes: string[];
}

/** At most this many `changes` entries, enforced in the schema rather than asked for. */
export const MAX_WHAT_CHANGED = 5;

/**
 * The hard limit on `howChecked`, in words. The brief asks for about a hundred;
 * this is where that stops being a request.
 *
 * Truncated rather than refused, which is the choice `capFollowUps` and
 * `parseFinding` both make: a reviewer that wrote a long paragraph about what
 * it verified has not produced a broken review, and rejecting the output would
 * lose every finding in it.
 */
export const MAX_HOW_CHECKED_WORDS = 100;

export interface ReviewOutput {
  /**
   * **One sentence naming what is unresolved**, written by the review (#109,
   * decision 8), and the line the body carries under its assessment heading.
   *
   * What it is for is the thing a count cannot say. *Changes recommended* is
   * three words over one finding and over nine, and `**Findings:** 3` says how
   * many rather than what — so this names the subjects: "Sequence validation,
   * empty-column rules and undo-safe state handling have blocking defects."
   *
   * Optional, and a blank one is absent: the body falls back to a sentence
   * built from the record, so a slot in the layout is never empty. Counts stay
   * on the `**Findings:**` line and are not repeated here.
   */
  readonly assessment?: string;
  /**
   * What the reviewer actually verified — tests run, behaviour traced, files
   * scanned. Rendered collapsed, on every review, under *How this was checked*.
   *
   * Capped at `MAX_HOW_CHECKED_WORDS`.
   */
  readonly howChecked?: string;
  /**
   * What the pull request does. Rendered collapsed under *What changed in this
   * PR*, and **only on some reviews** — see `renderReviewBody`'s
   * `showWhatChanged`, which is the caller's to decide because it is a fact
   * about the round rather than about the review.
   */
  readonly whatChanged?: WhatChanged;
  /**
   * Every problem the review found in this pull request, as the model produced
   * them. Where each one is posted — a line thread or a file-level thread — is
   * decided from the diff by `placeFindings`, not here and not by the model
   * (#110); one it can anchor nowhere in the diff is moved to `followUps`
   * rather than posted (#127, decision 3).
   */
  readonly findings: Finding[];
  readonly followUps: FollowUp[];
  /**
   * One line per finding this pull request must not merge without fixing —
   * the other of the review's two finding types, beside `followUps` (#96).
   *
   * A **restatement** of what the summary and the findings already say,
   * and that is its job: the verdict is derived from how many there are, and
   * counting them out of prose is the sentence nothing acted on that the
   * verdict replaced. The detail stays where a human reads it.
   *
   * Not derived from the findings, which is the shape this could have taken.
   * The two are written independently on purpose: either can be the one the
   * model forgot, and the count below takes whichever is larger so that a
   * finding recorded in only one of them still reaches the verdict.
   */
  readonly fixBeforeMerge: string[];
  /**
   * One ruling per finding an earlier review of this pull request left open:
   * did it land, or is it still owed (#111)?
   *
   * The review's own answer about somebody else's finding, which is why it is
   * a field of its own rather than more `findings`. What it decides is not the
   * review's to act on either — a landed finding is resolved by the workflow,
   * with the reason stated in the thread, and one still open is counted toward
   * this review's verdict. See `shared/review-verification.ts`.
   */
  readonly verified: VerificationEntry[];
  /**
   * The agent's judgement that **another pass over this branch will not settle
   * it**, in one line naming which case it is: the wrong thing was built, the
   * issue itself was wrong, or a check fails and the diff does not explain why.
   *
   * Absent on nearly every review, and that is the point — it is what tells a
   * maintainer they have to read this one rather than act on it, so a review
   * that sets it for an ordinary finding spends the only signal that says so.
   */
  readonly needsYou?: string;
}

/**
 * What the pull request's other checks said when the review ran, collected by
 * the workflow from the check-runs API rather than read out of the prose the
 * same step hands the agent.
 *
 * `unknown` is its own value and is **not** folded into `red`: a review that
 * could not see CI has not seen a failure, it has seen nothing. Both send a
 * finding-free review to a human, and they say different things about why.
 */
export type CiResult = "green" | "red" | "unknown";

/**
 * What a review answers, derived from what it found rather than written in it
 * (#96). Three of them a reader has met before: the names are GitHub's own
 * Copilot code review headings, verbatim, so anyone who has read one of those
 * already knows what ours mean.
 *
 * Four keys and three headings, because *changes recommended* has a round-1
 * case and a round-2 one — the same heading, a different next step — and they
 * have to be told apart by something a machine reads. The key is that
 * something, and a consumer matches it **exactly**: the automatic fix PRD #101
 * describes fires on the round-1 case alone, and the round-1 key is a prefix of
 * the round-2 one.
 */
export type Verdict =
  | "approval recommended"
  | "changes recommended"
  | "changes recommended after a fix round"
  | "needs a closer look";

export interface VerdictRow {
  readonly verdict: Verdict;
  /**
   * The heading the posted review body opens with: the assessment's marker and
   * its `label`. Copilot code review's own wording, so it is recognised rather
   * than learned — which is why it is a literal here rather than composed from
   * the key beside it.
   *
   * Shared by the two *changes recommended* rows: what differs between those is
   * the step, not the assessment.
   */
  readonly heading: string;
  /**
   * The heading without its marker, and the front of the status description.
   *
   * Two fields rather than one because the two surfaces accept different text.
   * A review body takes the emoji; a commit status description refuses any
   * character outside the Basic Multilingual Plane — `422 Description doesn't
   * accept 4-byte Unicode` — and every marker here is one. v0.3.0 put the
   * heading in the description, so every verdict it tried to post was
   * rejected, and the round rule that reads them back saw none (#121).
   */
  readonly label: string;
  /**
   * The commit status's state. Only *approval recommended* is `success`: every
   * other row is something left to do, and a green tick beside one of those is
   * the verdict saying the opposite of what it means.
   */
  readonly state: "success" | "failure";
  /**
   * The next human step, and the whole promise of the feature — this line is
   * what makes the outcome actionable without reading the review.
   *
   * The body carries this on its own, under the heading; the status carries it
   * behind `label` — the heading without its marker, which a description
   * refuses — because a status has one line and no formatting.
   */
  readonly nextStep: string;
  /**
   * What GitHub shows beside the status: `<label>. <nextStep>`, written out
   * rather than composed, so the line a maintainer reads is in this table
   * verbatim. A test holds it equal to the two halves above, under GitHub's
   * 140-character limit — which truncates where the character ran out rather
   * than where the sentence ends — and free of any character GitHub refuses
   * there (see `label`).
   */
  readonly description: string;
}

/**
 * The context the verdict is posted under. One per commit per context, so a
 * later review of the same commit replaces its own verdict and nothing else —
 * and a new commit carries none until one is posted for it, which is what stops
 * a stale approval surviving a push.
 */
export const VERDICT_CONTEXT = "agent-review";

/** The table, verbatim. #96 decision 2 is the copy a human argues with. */
export const VERDICTS: Readonly<Record<Verdict, VerdictRow>> = {
  "approval recommended": {
    verdict: "approval recommended",
    heading: "🟢 Approval recommended",
    label: "Approval recommended",
    state: "success",
    nextStep: "Nothing left to fix. Merge when ready; follow-ups are filed as issues on merge.",
    description:
      "Approval recommended. Nothing left to fix. Merge when ready; follow-ups are filed as issues on merge.",
  },
  "changes recommended": {
    verdict: "changes recommended",
    heading: "🟡 Changes recommended",
    label: "Changes recommended",
    state: "failure",
    nextStep:
      "The fixes are clear. Add agent:fix to start a fix round; a re-review follows automatically.",
    description:
      "Changes recommended. The fixes are clear. Add agent:fix to start a fix round; a re-review follows automatically.",
  },
  // Same assessment, a different step: the fix round that was supposed to
  // settle these has already run. So the line stops promising an automatic
  // re-review and asks for the decision first.
  "changes recommended after a fix round": {
    verdict: "changes recommended after a fix round",
    heading: "🟡 Changes recommended",
    label: "Changes recommended",
    state: "failure",
    nextStep:
      "A fix round didn't settle these. Read the review, add guidance where it helps, then add agent:fix.",
    description:
      "Changes recommended. A fix round didn't settle these. Read the review, add guidance where it helps, then add agent:fix.",
  },
  "needs a closer look": {
    verdict: "needs a closer look",
    heading: "🔵 Needs a closer look",
    label: "Needs a closer look",
    state: "failure",
    nextStep:
      "A fix round can't settle this alone. Read the review, add guidance, then add agent:fix or close the PR.",
    description:
      "Needs a closer look. A fix round can't settle this alone. Read the review, add guidance, then add agent:fix or close the PR.",
  },
};

/**
 * Which pass over this pull request a review is. 1 is the first review of these
 * commits; 2 is the verification pass that follows a fix round's push, and is
 * established from the repository rather than counted — see
 * `shared/review-round.ts`.
 *
 * A union rather than a number, so the two values are the whole of it: a third
 * round is a second round by everything that acts on this, and "how many times
 * have we been round" is a question nothing here asks.
 */
export type ReviewRoundNumber = 1 | 2;

/**
 * Everything the verdict depends on that is not in the review itself.
 *
 * An object rather than positional arguments, and `round` is required rather
 * than defaulted: a default of 1 would be a caller that forgot the round
 * silently getting the *weaker* reading, which is the one failure here with no
 * symptom — a second round that promises an automatic re-review and sends the
 * loop back around a fix that already did not work.
 */
export interface VerdictInputs {
  readonly ci: CiResult;
  readonly round: ReviewRoundNumber;
  /**
   * How many findings an **earlier** review raised that this one checked and
   * found still open (#111, and #109 decision 1).
   *
   * They count exactly as this review's own do: a finding lives until a review
   * verifies it fixed, so one that has survived a round is more reason to stop
   * the merge than a fresh one, not less. A review that found nothing new and
   * three things still unfixed is not an approval.
   *
   * Required rather than defaulted to zero, for the reason `round` is required:
   * a caller that forgot it recommends approving a pull request with unfixed
   * findings on it, which is the one failure here with no symptom.
   */
  readonly stillOpen: number;
  /**
   * How many of this review's own findings the workflow moved to `followUps`
   * because their anchor is in no file this pull request changes (#127,
   * decision 3).
   *
   * Subtracted rather than counted: a follow-up is by definition what this
   * pull request is not going to fix, so one of these blocking the merge is the
   * finding a maintainer has no thread to settle on — the state #124 closed.
   *
   * Required rather than defaulted to zero, for the reason `stillOpen` is. The
   * failure a default hides is the quiet one: the record is built from the
   * findings that were *placed* and so drops these on its own, so a caller that
   * forgot this derives a verdict from a bigger number than the body states —
   * the disagreement #105 closed, reopened from the other end.
   */
  readonly movedToFollowUps: number;
}

/**
 * The `fixBeforeMerge` lines that are a finding the `findings` list does not
 * carry — all of them, once the list is the longer of the two, and none of
 * them otherwise.
 *
 * The one place a `fixBeforeMerge` line becomes a countable, recordable thing
 * of its own, and it is why `countFixBeforeMerge` and `reviewRecord` can be
 * one set rather than two readings of one: both take the entries from here and
 * from `findings`, so the number the body states and the number the verdict
 * was derived from cannot differ.
 *
 * **All of them, not the ones the findings left out.** The list restates the
 * same findings in the model's own words, and telling which line restates
 * which finding is the prose-matching this derivation exists to avoid. So a
 * review that wrote one finding and two lines is counted at three: a finding
 * written down twice costs a reader a moment, and one written down nowhere is
 * the failure #105 closed.
 */
const restatedLines = (output: ReviewOutput): readonly string[] =>
  output.fixBeforeMerge.length > output.findings.length ? output.fixBeforeMerge : [];

/**
 * How many findings this pull request must not merge without fixing.
 *
 * **Every entry in `findings`**, whatever its placement and whatever its body
 * opens with, plus the restated lines above. The label is not read here and is
 * not read anywhere that counts or records: by #96's decision 1 a finding is
 * one of two kinds and `followUps` is the other, so an entry in this list is
 * fix-before-merge by definition, and a predicate over the label was a second
 * definition of that which disagreed with the first — in the unsafe direction,
 * since an unlabelled finding then derived *approval recommended* over a
 * record that listed it.
 *
 * The model is asked to write every finding into `fixBeforeMerge` as well, so
 * either half can be the one it forgot: a review that wrote the list and no
 * findings is counted off the list, which is the case #105 closed.
 *
 * **This review's own findings, and not the ones it carried.** What an earlier
 * review left open is verified rather than re-found (#111) and reaches the
 * verdict through `VerdictInputs.stillOpen`; counting it here as well would
 * make every still-open finding worth two.
 *
 * Counted over the findings **as produced**, independently of which of the two
 * threadable placements each one got. Placement is the workflow's decision and
 * it can no longer lose a finding (#110), but the count must not depend on it
 * either way: what a review found and where GitHub would let it be posted are
 * two different questions.
 *
 * The one thing that does come off the count is `movedToFollowUps` — the
 * findings whose anchor is in no changed file at all, which by #127 decision 3
 * are follow-ups rather than blockers. That is not a placement decision wearing
 * a different hat: it changes which of the review's **two kinds** a finding is,
 * and a follow-up has never counted. `restatedLines` is deliberately read from
 * the findings as produced, so moving one does not tip the list into being "the
 * longer of the two" and count every line in it.
 */
export const countFixBeforeMerge = (output: ReviewOutput, movedToFollowUps: number): number =>
  output.findings.length - movedToFollowUps + restatedLines(output).length;

/**
 * One line of the review's record: what the finding is, how bad, where, and
 * whether this round is the one that found it (#109, decision 8).
 *
 * Four of its six fields are optional because the record holds three
 * populations that know different amounts about themselves. A finding this
 * review produced knows its severity and its anchor. A finding **carried** from
 * an earlier review knows the one line that review wrote and the severity that
 * review gave it, read back off the marker rather than re-rated. And a
 * `fixBeforeMerge` line the model restated without a matching finding knows
 * nothing but itself, which is why it renders badge-less and sorts last.
 */
export interface RecordEntry {
  /** One line, as a reader scans a list of what is open. */
  readonly title: string;
  readonly severity?: Severity;
  /** `path:line`, where the entry has one of its own rather than inside `title`. */
  readonly anchor?: string;
  /**
   * The id, written into the body **only where nothing else records it** — a
   * carried finding with no thread. That asymmetry is the whole of what makes
   * the body a record rather than a rendering: a threaded finding's thread is
   * its record, and a second copy in the body is one a maintainer cannot close
   * by resolving the thread.
   *
   * Since #127 nothing new lands here: every finding this review raises is
   * anchored on the diff and so has a thread. What still does is a **body entry
   * a v0.4.0 review wrote** on a pull request that was open when this version
   * landed (#127, decision 5) — it is carried and verified as before, and the
   * id is what keeps it alive until a round rules it landed.
   *
   * Never on a resolved entry, for the same reason in the other direction: an
   * id written back would carry a closed finding into the next round.
   */
  readonly id?: string;
  /**
   * A link to the thread the entry lives in, where there is one to link to
   * (#109, decision 8).
   *
   * Present on a **carried** entry and absent on a fresh one, which is a fact
   * about GitHub rather than a choice: a fresh finding's thread is opened by
   * the same `addPullRequestReview` call that posts this body, so its URL does
   * not exist while the body is being composed — and its thread renders
   * directly beneath the review anyway. A carried one's thread sits under an
   * older review, several screens up, which is where the link earns its keep.
   */
  readonly url?: string;
  /** Whether this review is the one that raised it — rendered as *new*. */
  readonly isNew: boolean;
}

/**
 * The review's findings as a record, in the three groups decision 8 names.
 *
 * A pure function of what the review produced and what it verified, separate
 * from the rendering so the grouping and the ordering can be argued with
 * directly rather than read out of a Markdown string.
 *
 * The groups are **disjoint**: a previously-missed finding is open, and it is
 * listed under *Previously missed* and nowhere else. That is decision 4 shown
 * rather than stated — the record having been wrong about this pull request is
 * the thing worth a group of its own.
 */
export interface ReviewRecord {
  /** Everything owed now: this round's findings and the earlier ones still unfixed. */
  readonly open: RecordEntry[];
  /** What this round verified landed, or closed on a maintainer's decline. */
  readonly resolved: RecordEntry[];
  /** This round's findings in code an earlier review had already read. */
  readonly missed: RecordEntry[];
  /**
   * The number the body states, which is **what is unresolved**: `open` plus
   * `missed`.
   *
   * Exactly `countFixBeforeMerge(output, moved) + stillOpen.length` — the
   * count `deriveVerdict` was given, entry for entry, because both are taken
   * from one set: this list is built from the findings that were *placed*, and
   * the count subtracts exactly the ones that were not. A test asserts it over
   * every shape of review, including the two an unlabelled finding used to
   * break it in and the one #127 added.
   */
  readonly findings: number;
}

/**
 * One line each, for the same reason a follow-up title is collapsed: a finding
 * the model wrapped cannot be allowed to break the list it sits in.
 */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The *new* flag `entryLine` writes behind a claim, taken back off. */
const NEW_SUFFIX = /\s*\*new\*\s*$/i;

/**
 * A carried finding's claim, with this renderer's own decorations stripped.
 *
 * The inverse of `entryLine`, and deliberately next to it. A finding with no
 * thread is read back out of the last review body it was written into, so the
 * line this file wrote is the line this file is handed next round — and without
 * the strip, a body entry would collect another badge and keep a stale *new*
 * every round it stayed open.
 *
 * The badge stripped is **the one this entry's own severity would render**, not
 * any badge: `entryLine` writes a badge exactly when it writes a severity into
 * the marker, so the two arrive together or not at all. A looser rule would eat
 * the opening of a claim that legitimately starts by quoting `` `Low` ``, which
 * on a codebase with severities in it is a claim somebody will eventually make.
 *
 * A no-op on a threaded finding, whose line comes off the thread rather than
 * out of a body and so carried neither decoration.
 */
const carriedClaim = (finding: CarriedFinding): string => {
  const claim = oneLine(finding.text).replace(NEW_SUFFIX, "");
  const badge = finding.severity === undefined ? undefined : severityBadge(finding.severity);

  return (badge !== undefined && claim.startsWith(badge) ? claim.slice(badge.length) : claim).trim();
};

/**
 * A finding this review produced, as an entry.
 *
 * The title rather than the claim, which is what `title` is for — and the claim
 * the body opens with where the model left the title empty, for the reason
 * `parseFinding` defaults it: this is display, and a blank line in a list is
 * worse than a reworded one.
 */
const placedEntry = (placed: PlacedFinding): RecordEntry => {
  const title = oneLine(placed.finding.title) || openingClaim(placed.finding.body);

  // No id and no evidence: every finding this review raises now has a thread
  // (#127, decision 1), and the thread carries both.
  return {
    title: oneLine(title),
    severity: placed.finding.severity,
    anchor: `${placed.finding.path}:${placed.finding.line}`,
    isNew: true,
  };
};

/**
 * A finding an earlier review raised, as an entry. `keepId` is false for a
 * resolved one — see `RecordEntry.id`.
 */
const carriedEntry = (finding: CarriedFinding, keepId: boolean): RecordEntry => ({
  title: carriedClaim(finding),
  ...(finding.severity === undefined ? {} : { severity: finding.severity }),
  ...(keepId && finding.threadId === undefined ? { id: finding.id } : {}),
  ...(finding.url === undefined ? {} : { url: finding.url }),
  isNew: false,
});

/**
 * Worst first, stable within a rating. A plain sort, because `Array#sort` has
 * been stable since ES2019 and the order the review produced its findings in is
 * the tie-break worth keeping.
 */
const worstFirst = (entries: readonly RecordEntry[]): RecordEntry[] =>
  [...entries].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

/**
 * The restated `fixBeforeMerge` lines, as entries (#105).
 *
 * The same `restatedLines` the count takes, which is what makes the record and
 * the count one set: the case this exists for is a finding the model wrote
 * into the list and left out of `findings`, and without it the verdict would
 * say *changes recommended* over a record showing fewer findings than it
 * counted, with the next round verifying against the shorter one.
 *
 * Badge-less and anchor-less on purpose: a restatement is a line of prose, and
 * a severity invented for it would be this file rating a finding.
 */
const restatedEntries = (output: ReviewOutput): RecordEntry[] =>
  restatedLines(output).map((line) => ({ title: oneLine(line), isNew: true }));

/**
 * The record, from the review and what it verified.
 *
 * Handed `placed` rather than `output.findings` so every entry can carry the id
 * and the placement the workflow decided, and handed the whole `output` so the
 * set it records cannot be a different set from the one `deriveVerdict`
 * counted — which is the disagreement #105 closed and the one a caller passing
 * `fixBeforeMerge` straight through would reopen.
 */
export const reviewRecord = (parts: {
  readonly output: ReviewOutput;
  readonly placed: readonly PlacedFinding[];
  readonly stillOpen: readonly CarriedFinding[];
  readonly resolved: readonly CarriedFinding[];
}): ReviewRecord => {
  // **Every placed finding, whatever its body opens with.** The label is
  // presentation and is read only for which group an entry lands in (below): a
  // record that filtered on it recorded a different set from the one the
  // verdict counted, and the two disagreed in the unsafe direction — an
  // unlabelled finding in an untouched file was posted *nowhere*, since the
  // body was its only surface, while the runner logged it as "in the body" and
  // `docs/ADOPTING.md` told an adopter to trust that counter; an unlabelled
  // one on a diff line got a thread and an id, reached no group and no count
  // in the round that raised it, and then counted through `stillOpen` in every
  // round after — blocking a merge it had not blocked when it was found.
  //
  // *Placed* rather than produced is the one filter here, and it is the same
  // set the count reads: a finding with no anchor in the diff is not in
  // `parts.placed`, is subtracted from the count, and is in `followUps`
  // instead (#127, decision 3).
  const missed = parts.placed.filter((placed) => isPreviouslyMissed(placed.finding));
  const fresh = parts.placed.filter((placed) => !isPreviouslyMissed(placed.finding));

  const open = worstFirst([
    ...fresh.map(placedEntry),
    ...parts.stillOpen.map((finding) => carriedEntry(finding, true)),
    ...restatedEntries(parts.output),
  ]);
  const missedEntries = worstFirst(missed.map(placedEntry));

  return {
    open,
    resolved: worstFirst(parts.resolved.map((finding) => carriedEntry(finding, false))),
    missed: missedEntries,
    findings: open.length + missedEntries.length,
  };
};

/**
 * One entry, as the body writes it: the badge, the claim, where it is, whether
 * it is new, and — where nothing else records it, which since #127 is only a
 * legacy body entry being carried — its id.
 *
 * The badge is text rather than one of GitHub's severity images, which decision
 * 9 rules out: see `severityBadge`. The marker goes last so the visible line
 * ends where the claim does, and `carriedClaim` is the half that reads this
 * back.
 */
const entryLine = (entry: RecordEntry): string =>
  [
    "-",
    entry.severity === undefined ? undefined : severityBadge(entry.severity),
    // Linked where there is a thread to link to, which is a carried entry and
    // not a fresh one — see `RecordEntry.url`. The link wraps the title rather
    // than sitting beside it as "(thread)", so the line a reader scans is the
    // claim and the way to reach it is the claim.
    entry.url === undefined ? entry.title : `[${entry.title}](${entry.url})`,
    entry.anchor === undefined ? undefined : `— \`${entry.anchor}\``,
    entry.isNew ? "*new*" : undefined,
    entry.id === undefined ? undefined : findingMarker(entry.id, entry.severity),
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");

/**
 * The subtitle under *Previously missed*, in Copilot code review's own words
 * for the same group.
 *
 * The group name alone does not say what was missed or by whom, and the
 * sentence that would say it in the prose is the prose this body spent #113
 * getting out of the way of the record. Copilot puts one line directly under
 * the summary; borrowing the wording is the point, the way the body's order is
 * borrowed — a maintainer who has read one of those overviews already knows
 * what the group means.
 */
export const PREVIOUSLY_MISSED_SUBTITLE = "In code that hasn't changed since last review";

/**
 * One group, or `undefined` where it is empty — so the body drops the heading
 * rather than leaving a disclosure widget over nothing, which is how a channel
 * teaches people to stop opening it.
 *
 * `open` is the attribute rather than the group name: *Open* and *Previously
 * missed* are the findings the verdict has just told a reader to act on, so
 * they render expanded and a click is not put between the line and the work.
 * *Resolved since last review* is the record's memory rather than its to-do
 * list and starts folded. Both are `<details>` either way, which is what
 * decision 8 asks for — collapsible, not collapsed.
 *
 * `subtitle` is one line under the summary, and the blank line before it is
 * load-bearing: GitHub renders no Markdown in a `<details>` until the content
 * is separated from `</summary>`.
 */
const renderGroup = (
  title: string,
  entries: readonly RecordEntry[],
  expanded: boolean,
  subtitle?: string,
): string | undefined => {
  if (entries.length === 0) return undefined;

  return [
    `<details${expanded ? " open" : ""}>`,
    `<summary><b>${title}</b> — ${entries.length}</summary>`,
    ...(subtitle === undefined ? [] : ["", `_${subtitle}_`]),
    "",
    ...entries.map(entryLine),
    "",
    "</details>",
  ].join("\n");
};

/** Because "1 findings are open" is the sentence a reader stops trusting. */
const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * The count line: how many are unresolved, and how they are rated.
 *
 * The number is `open` plus `missed` — what this pull request still owes — and
 * the follow-ups are **not** in it, at any rating: they are what this pull
 * request is not going to fix, and a count that mixed them would be a number a
 * reader has to subtract before acting on.
 *
 * The breakdown lists only the ratings that occur, worst first, and is dropped
 * entirely where nothing carries one — a restatement line has no finding behind
 * it to rate, and `— 0 \`High\`, 0 \`Medium\`` is noise standing in for a fact.
 */
const findingsLine = (record: ReviewRecord): string => {
  const entries = [...record.open, ...record.missed];
  const counted = SEVERITIES.map((severity) => ({
    severity,
    count: entries.filter((entry) => entry.severity === severity).length,
  })).filter(({ count }) => count > 0);

  const breakdown = counted
    .map(({ severity, count }) => `${count} ${severityBadge(severity)}`)
    .join(", ");

  return `**Findings:** ${record.findings}${breakdown === "" ? "" : ` — ${breakdown}`}`;
};

/**
 * What the body says about the findings the workflow moved out of the record
 * (#127, decision 3), or `undefined` where it moved none.
 *
 * Said in the body rather than only in the run log, because this is the one
 * thing about the record a reader cannot otherwise see: the finding is not in
 * *Open*, it is not in the count, and the entry that does appear — down in
 * *Follow-ups*, folded — does not look like something a review meant to block
 * the merge with. A record that quietly demoted a blocker would be the same
 * silence #110 removed, one door along.
 *
 * Directly under the count, because it is what the count does not say.
 */
const movedSentence = (moved: number): string | undefined =>
  moved === 0
    ? undefined
    : `_${moved} ${plural(moved, "finding was", "findings were")} moved to follow-ups: ${plural(moved, "its anchor is", "their anchors are")} in no file this pull request changes, so nothing this pull request changes causes ${plural(moved, "it", "them")}._`;

/**
 * A label name the body mentions, rendered as code.
 *
 * One renderer rather than a second copy of each sentence, because the same
 * words go to two surfaces that accept different text: a commit status
 * description renders no Markdown at all, so backticks show up in it literally
 * — `VERDICTS` therefore holds the plain wording, and this is what the body
 * does to it on the way out. Every other place the loop names a label already
 * writes it as code, and the review body was the one that did not.
 *
 * A label already in backticks is left alone, so this is safe to run over a
 * line that was written with them.
 */
const BARE_LABEL = /(^|[^`])(agent:[a-z][a-z-]*)(?![`a-z-])/g;

export const labelsAsCode = (line: string): string => line.replace(BARE_LABEL, "$1`$2`");

/**
 * The one sentence under the heading: what is unresolved, in numbers.
 *
 * It is what the heading cannot say. *Changes recommended* is the same three
 * words over one finding and over nine, and over a round that found nothing new
 * and left three of the last round's unfixed — which is the case a reader most
 * needs told apart, because nothing they can see distinguishes it from a fresh
 * review that went badly.
 */
const unresolvedSentence = (record: ReviewRecord): string => {
  if (record.findings === 0) {
    return record.resolved.length === 0
      ? "Nothing is open on this pull request."
      : `Nothing is open on this pull request; ${record.resolved.length} ${plural(record.resolved.length, "finding an earlier review raised was", "findings an earlier review raised were")} closed this round.`;
  }

  const carried = record.open.filter((entry) => !entry.isNew).length;
  const clauses = [
    carried === 0 ? undefined : `${carried} carried from an earlier review`,
    record.missed.length === 0
      ? undefined
      : `${record.missed.length} in code an earlier review had already read`,
  ].filter((clause) => clause !== undefined);

  const head = `${record.findings} ${plural(record.findings, "finding is", "findings are")} open`;
  return clauses.length === 0 ? `${head}.` : `${head}, ${clauses.join(", ")}.`;
};

/**
 * The fixed heading the body opens with.
 *
 * Every agent in the loop posts as `github-actions[bot]`, so in the timeline a
 * review overview and a fix run's thread replies look like the same author
 * saying more things. A heading marks the one to read, and this wording matches
 * the `agent-review` status and the `agent:review` label — the way Copilot's
 * overview opens with "Copilot review overview".
 *
 * Level 2 rather than level 1: `#` renders very large inside a comment, and the
 * assessment heading below it stays level 3.
 */
export const BODY_HEADING = "## Agent review";

/**
 * How this was checked, and what changed — the two collapsed sections that
 * replaced one 250-word paragraph.
 *
 * Rendered from fields the schema caps rather than from prose the brief asked
 * to be short, which is the whole of the change: the cap is the part a review
 * cannot talk its way past.
 */
const renderHowChecked = (howChecked: string | undefined): string | undefined =>
  howChecked === undefined
    ? undefined
    : ["<details>", "<summary><b>How this was checked</b></summary>", "", howChecked, "", "</details>"].join(
        "\n",
      );

const renderWhatChanged = (whatChanged: WhatChanged | undefined): string | undefined => {
  if (whatChanged === undefined) return undefined;

  const lines = [
    ...(whatChanged.summary === "" ? [] : [whatChanged.summary, ""]),
    ...whatChanged.changes.map((change) => `- ${oneLine(change)}`),
  ];
  while (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;

  return [
    "<details>",
    "<summary><b>What changed in this PR</b></summary>",
    "",
    ...lines,
    "",
    "</details>",
  ].join("\n");
};

/**
 * The body as it is posted: the findings record decision 8 describes, in one
 * fixed order, and the one place that order is written down.
 *
 * Top to bottom: the heading that says which comment this is, the assessment,
 * the review's own sentence naming what is unresolved, the step in italics, the
 * count and — on the rounds that have one — the line saying a finding was moved
 * to the follow-ups, then *Open*, *Previously missed*, *Resolved since last
 * review*, *Follow-ups*, *How this was checked* and *What changed in this PR*,
 * then a rule and the run that produced it. The order is Copilot code review's
 * own overview, which is the point — a maintainer who has read one of those
 * already knows where to look.
 *
 * Three rules about the groups are worth stating because breaking one of them
 * is invisible. **A group with nothing in it is omitted**, so a disclosure
 * widget never opens on nothing. **What is owed is expanded and what is done is
 * folded**: *Open* and *Previously missed* are what the verdict has just told a
 * reader to act on — and *Previously missed* counts toward that verdict, which
 * is why it is not collapsed the way Copilot collapses its equivalent — while
 * *Resolved*, *Follow-ups* and the two prose sections start closed. And **the
 * only horizontal rule in the body is the one above the run link**: a divider
 * between groups reads as a section break in a list that is one record.
 *
 * Two parts sit between the step and the count and are in none of that, because
 * they qualify the assessment rather than the record: `needsYou` is why another
 * pass will not settle it, and it reached the derivation and nobody else until
 * #105; the round note is how the round was established, and is a fact about
 * the run rather than about the change. Both belong above the count, where a
 * reader meets them before deciding what the count means.
 *
 * A function rather than two dozen lines in the runner, because this is the
 * part of the review a human acts on and the runner is a script with no test
 * around it.
 */
export const renderReviewBody = (parts: {
  /**
   * The row the derivation chose. The body opens with its heading and then its
   * next step — the same two halves the commit status carries, except that the
   * status fronts its line with `label` because a description refuses the
   * heading's marker (see `label`), so the two surfaces cannot say different
   * things — and the heading is *not* repeated inside the step, which is why
   * the status's `description` is not what is rendered here.
   *
   * The step is put through `labelsAsCode` on the way in: the body renders
   * Markdown and the status does not, so the same sentence is written once and
   * decorated for the surface it is going to.
   */
  readonly verdict: VerdictRow;
  /** The review as the agent produced it, which is what the verdict was derived from. */
  readonly output: ReviewOutput;
  /** The note a round that could not be established carries; see `shared/review-round.ts`. */
  readonly roundNote?: string | undefined;
  /**
   * The findings with their placements, from `placeFindings` — every one of
   * which has a thread (#127, decision 1), so each entry here is the one-line
   * version of something a maintainer can reply to.
   *
   * The ones that reached no placement are not in this list and are not in the
   * record: they are in `followUps`, and `movedToFollowUps` below is what the
   * body says about them.
   *
   * Required rather than defaulted to empty, for the reason `round` is: the
   * wrong default is the one with no symptom. A caller that forgot this posts a
   * body with a finding missing from it and nothing saying so.
   */
  readonly placed: readonly PlacedFinding[];
  /**
   * How many of this review's findings were moved to `followUps` for having no
   * anchor in the diff — the same number `deriveVerdict` subtracted.
   *
   * A count rather than the findings themselves: they are already rendered, in
   * the *Follow-ups* group below, and a second copy here would be the body
   * telling a reader the same finding twice under two headings.
   */
  readonly movedToFollowUps: number;
  /**
   * The earlier reviews' findings this one checked and found still open, from
   * `verifyCarried`. Listed under *Open* beside this round's, each with the id
   * it has carried since it was raised (#111).
   *
   * Required rather than defaulted, for the reason `placed` is: a caller that
   * forgot this posts a body whose record is shorter than the count the verdict
   * was derived from — the exact disagreement #105 closed — and, for a finding
   * with no thread of its own, drops the only record that it is still open.
   */
  readonly stillOpen: readonly CarriedFinding[];
  /**
   * The ones it found settled, from the same call. Required for the reason the
   * two above are, and this is the half with no other trace at all: a thread
   * closes and disappears from the next round's feedback, so a body that
   * omitted this would be a record with no memory of the work that was done.
   */
  readonly resolved: readonly CarriedFinding[];
  /**
   * This review's whole follow-up list, from `recordFollowUps`: the moved
   * findings first, then the out-of-scope ones the cap kept. And what the cap
   * cost, which is a number about the second half alone.
   *
   * **The moved ones lead it**, and that is a fact this relies on rather than
   * one it checks: `movedToFollowUps` above is written into the payload as the
   * length of the exempt prefix, so a caller that appended them instead would
   * exempt the wrong entries at the filing end. One function builds the list and
   * the count together for that reason.
   *
   * Rendered as a group like the others rather than appended after the body,
   * which is where they used to land — below the run link, looking unlike
   * everything above them. The **payload** is unchanged and still goes out with
   * every review, empty list included: the filing half reads it on merge, and a
   * round that recorded nothing has to be able to say so.
   */
  readonly followUps: readonly FollowUp[];
  readonly droppedFollowUps: number;
  /**
   * Whether *What changed in this PR* is rendered at all.
   *
   * The caller's, because it is a fact about the **round** and not about the
   * review: it belongs on the first review of a pull request and on a later
   * round-1 review with commits on it no verdict has seen — a human push, or a
   * conflict resolution — and nowhere else. A round-2 verification pass is
   * answering an earlier review's findings, and a re-review with nothing pushed
   * since the last verdict would be describing a change it has already
   * described. *How this was checked* carries no such rule and appears on every
   * review.
   */
  readonly showWhatChanged: boolean;
  /**
   * The run that produced this review. Optional — it is a link, and a review
   * that could not name its own run is still a review — so a caller outside
   * Actions renders a body without one rather than failing.
   */
  readonly runUrl?: string | undefined;
}): string => {
  const record = reviewRecord(parts);

  // The review's own sentence, and a sentence built from the record where it
  // wrote none. The fallback is not a lesser version of the same thing: it says
  // how many and where they came from, where the field says *what* — but an
  // empty slot in a fixed layout reads as a rendering fault, so the body never
  // has one.
  //
  // Blank is absent here as well as in the schema. The schema normalises what a
  // model emits, and this is the same question asked of whatever a caller was
  // handed — a body with an empty line under its heading is the failure either
  // one of them missing it produces.
  const written = parts.output.assessment?.trim();
  const assessment = written === undefined || written === "" ? unresolvedSentence(record) : written;

  const body = [
    BODY_HEADING,
    `### ${parts.verdict.heading}`,
    assessment,
    `_${labelsAsCode(parts.verdict.nextStep)}_`,
    parts.output.needsYou,
    parts.roundNote === undefined ? undefined : labelsAsCode(parts.roundNote),
    findingsLine(record),
    movedSentence(parts.movedToFollowUps),
    renderGroup("Open", record.open, true),
    renderGroup("Previously missed", record.missed, true, PREVIOUSLY_MISSED_SUBTITLE),
    renderGroup("Resolved since last review", record.resolved, false),
    renderFollowUpsGroup(parts.followUps, parts.droppedFollowUps),
    renderHowChecked(parts.output.howChecked),
    parts.showWhatChanged ? renderWhatChanged(parts.output.whatChanged) : undefined,
    // The only rule in the body, and it is here rather than between the groups
    // because this is the only place the subject changes: everything above is
    // the review, and this is the run that posted it.
    parts.runUrl === undefined
      ? undefined
      : `---\n\n_Posted by [this workflow run](${parts.runUrl})._`,
    // Last, and invisible. The filing half reads the latest one off the body
    // (#47), so it goes out on every review including the one that recorded
    // nothing — which is how a round retracts an earlier round's list.
    followUpsPayload(parts.followUps, parts.droppedFollowUps, parts.movedToFollowUps),
  ]
    .filter((part) => part !== undefined && part !== "")
    .join("\n\n");

  return body;
};

/**
 * The verdict, from the review and the checks and nothing else.
 *
 * The order of the arms is the whole of it. The agent's own "a fix round will
 * not settle this" comes first, because it is a statement about the findings
 * rather than one more of them. Findings come next, *including* when the checks
 * are red: red checks with findings have an explanation and something for a fix
 * round to aim at. Red or unreadable checks with **nothing** behind them is the
 * case with no finding to act on at all, and it is precisely the one a
 * derivation keyed only on findings would recommend approving.
 */
export const deriveVerdict = (output: ReviewOutput, inputs: VerdictInputs): VerdictRow => {
  if (output.needsYou !== undefined) return VERDICTS["needs a closer look"];
  // This review's findings **and** the earlier ones it checked and found still
  // open. Added, because the two are disjoint sets — one this review found,
  // one it verified — where the two halves inside `countFixBeforeMerge` are
  // two restatements of one set. Their sum is the record's own size, which is
  // what `**Findings:** N` states.
  if (countFixBeforeMerge(output, inputs.movedToFollowUps) + inputs.stillOpen > 0) {
    // **A round-2 review can never produce the round-1 row** (#96, decision 5),
    // and it is enforced here rather than asked of the prompt. The fix round
    // has already run and already pushed; findings that survived it are
    // findings a second one has no more reason to settle than the first, and
    // the loop's one bound is that a fix cannot ask for another fix. A prompt
    // line would leave that bound to a model's judgement about its own output.
    //
    // The two rows share a heading and differ in the step, which is where the
    // bound lives: the round-1 line promises an automatic re-review, and the
    // round-2 line asks the maintainer to read the review first, guidance
    // optional. The key differs too, so the automatic fix PRD #101 describes
    // can fire on the round-1 case and on nothing else.
    //
    // It costs a true round-1 answer on the round where a fix broke something
    // new and obvious, which reads as a human being asked to look at a PR they
    // did not have to. That is the direction this is meant to fail in: the
    // alternative is a cycle with no gate in it.
    return inputs.round === 2
      ? VERDICTS["changes recommended after a fix round"]
      : VERDICTS["changes recommended"];
  }
  if (inputs.ci !== "green") return VERDICTS["needs a closer look"];
  return VERDICTS["approval recommended"];
};

const parseFollowUp = (value: unknown): FollowUp => {
  const record = asRecord(value, "follow-up");
  return {
    title: asString(record["title"], "follow-up title"),
    location: asString(record["location"], "follow-up location"),
    body: asString(record["body"], "follow-up body"),
    // Defaulted rather than required, like a finding's: this is read back out
    // of a block a previous release wrote as well as out of a model's answer,
    // and neither is worth losing a follow-up over.
    severity: parseSeverity(record["severity"]),
  };
};

/**
 * An optional string comes back from a model in four shapes — omitted, `null`,
 * `""` and `"   "` — and all four mean the same thing here.
 * Read as present, a blank one is a review that sends every pull request to a
 * human and gives no reason for it, which is the verdict at its least useful
 * and the hardest state to notice from the outside.
 */
const optionalReason = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  return asString(value, label);
};

/**
 * `howChecked`, held to `MAX_HOW_CHECKED_WORDS`.
 *
 * Truncated rather than refused. The words are display — a collapsed section
 * saying what the reviewer verified — and the review they are part of carries
 * the findings, so losing it over a long paragraph is the trade `capFollowUps`
 * and `parseFinding` both refuse to make. The ellipsis is what says the cap
 * bit, so a reader is not left thinking the sentence ended there.
 */
const cappedWords = (text: string, limit: number): string => {
  const words = text.trim().split(/\s+/);
  return words.length <= limit ? text.trim() : `${words.slice(0, limit).join(" ")}…`;
};

/**
 * `whatChanged`, held to `MAX_WHAT_CHANGED` entries.
 *
 * The first five, not a chosen five: the order is the reviewer's account of the
 * change, and re-ranking it here would need a judgement about which parts
 * matter that nothing in this file can make — the same rule the follow-up cap
 * follows.
 */
const parseWhatChanged = (value: unknown): WhatChanged | undefined => {
  if (value === undefined || value === null) return undefined;

  // A model prompted for two fields may still answer with the one this
  // replaced. A bare string is the summary with nothing under it, which renders
  // as a section rather than being dropped.
  if (typeof value === "string") {
    const summary = value.trim();
    return summary === "" ? undefined : { summary, changes: [] };
  }

  const record = asRecord(value, "whatChanged");
  const summary = record["summary"];
  return {
    summary: typeof summary === "string" ? oneLine(summary) : "",
    changes: asArray(record["changes"] ?? [], "whatChanged changes")
      .map((change, index) => asString(change, `whatChanged change ${index + 1}`))
      .slice(0, MAX_WHAT_CHANGED),
  };
};

/**
 * **The one boundary a finding marker is stripped at** (`withoutFindingMarkers`).
 *
 * Every string below this line is the model's, and the whole output goes
 * through the strip before any of it is read — titles and bodies,
 * `assessment`, `howChecked`, `whatChanged` and its bullets, `needsYou`, a
 * follow-up's title, body and location, and whatever is added next. The
 * per-field version of this stripped `body` alone, so a marker in `howChecked`
 * reached the posted body and carried a closed finding's id into the next
 * round as a fragment of prose.
 */
export const reviewOutputSchema = standardSchema<ReviewOutput>((raw) => {
  const record = asRecord(withoutFindingMarkers(raw), "review output");
  const needsYou = optionalReason(record["needsYou"] ?? record["needs_you"], "needsYou");
  // Blank-normalised exactly as `needsYou` is: omitted, `null`, `""` and
  // `"   "` all mean the same thing from a model, and read as present this
  // would put an empty line where the body's one sentence should be.
  const assessment = optionalReason(record["assessment"], "assessment");
  const howChecked = optionalReason(record["howChecked"] ?? record["how_checked"], "howChecked");
  // `summary` was one 250-word paragraph until the two fields split it, and a
  // model prompted for the new shape still reaches for the old one. It is read
  // as *what changed*, never as the assessment: the one thing the brief now
  // forbids that paragraph is restating the findings, and feeding it to the
  // sentence under the heading would be putting it back above them.
  const whatChanged = parseWhatChanged(record["whatChanged"] ?? record["what_changed"] ?? record["summary"]);
  return {
    ...(assessment === undefined ? {} : { assessment }),
    ...(howChecked === undefined ? {} : { howChecked: cappedWords(howChecked, MAX_HOW_CHECKED_WORDS) }),
    ...(whatChanged === undefined ? {} : { whatChanged }),
    // Both spellings, because the field was `inlineComments` until placement
    // stopped being the model's to state (#110) and a model prompted for one
    // shape still reaches for the other.
    findings: asArray(record["findings"] ?? record["inlineComments"] ?? [], "findings").map(
      parseFinding,
    ),
    // Absent is the ordinary case — most reviews find nothing out of scope —
    // so it defaults rather than being required. Nothing here rejects a list
    // longer than the cap: see `capFollowUps`.
    followUps: asArray(record["followUps"] ?? record["follow_ups"] ?? [], "followUps").map(
      parseFollowUp,
    ),
    // Absent is the ordinary case here too — a clean review finds nothing to
    // fix — so this defaults rather than being required. Uncapped, unlike the
    // follow-ups: the count *is* the verdict, and truncating it would be this
    // file deciding a pull request is closer to mergeable than the review said.
    fixBeforeMerge: asArray(
      record["fixBeforeMerge"] ?? record["fix_before_merge"] ?? [],
      "fixBeforeMerge",
    ).map((finding, index) => asString(finding, `fix-before-merge finding ${index + 1}`)),
    // Absent is an ordinary answer too — the first review of a pull request
    // has nothing carried to rule on. An id this review was not given is
    // dropped later, by `verifyCarried`, rather than here: what the model may
    // rule on is a fact about the run and not about the shape of its output.
    verified: asArray(record["verified"] ?? [], "verified").map(parseVerification),
    ...(needsYou === undefined ? {} : { needsYou }),
  };
});

/**
 * Apply the cap, and report what it cost.
 *
 * Truncation rather than a schema error, deliberately: throwing would fail
 * extraction and lose the *whole* review — summary and findings with it — and
 * a model that emitted a fourth follow-up has not produced a broken review.
 * It drops bad output rather than rejecting the run, which is the same choice
 * `parseFinding` makes over a missing title.
 *
 * The first three, not a re-ranked three. The extraction prompt states the
 * ordering axis and states that anything past the third is dropped from the
 * end, so the order is a contract the model can be held to; re-deriving one
 * here would need a seriousness judgement nothing in this file can make.
 *
 * **The model's out-of-scope list, and only that.** A moved finding is not in
 * what this is handed — `recordFollowUps` caps this half and then puts the
 * moved ones in front of the result — because the cap's whole justification is
 * that the model wrote the list knowing it was out of scope and was told where
 * it would be cut. A finding the review meant to stop the merge with was told
 * nothing of the kind, and dropping one leaves it on no surface at all: not a
 * thread, not the count, not the payload the filing run reads.
 */
export const capFollowUps = (
  followUps: readonly FollowUp[],
): { kept: FollowUp[]; dropped: number } => ({
  kept: followUps.slice(0, MAX_FOLLOW_UPS),
  dropped: Math.max(0, followUps.length - MAX_FOLLOW_UPS),
});

/**
 * The sentence appended to a moved finding, so the issue filed for it says why
 * it arrived as a follow-up rather than as a thread on the pull request.
 *
 * It is written to the person who opens the filed stub, which is the surface
 * that outlives everything else here: the finding's own body opens with *Fix
 * before merge* — the review meant it — and without this line that label is the
 * first thing they read on an issue nobody is being asked to fix before a
 * merge that has already happened.
 *
 * It names no issue and no repository. A filed stub lands in the adopter's own
 * tracker, where `#127` is one of *their* issues; a cross-reference this loop
 * cannot resolve is worse than none.
 */
const MOVED_NOTE =
  "_Raised by the review as a problem to fix before merge, then moved: its anchor was in no file that pull request changed, so nothing in the change caused it and there was nowhere in the diff to open a thread on it._";

/**
 * The same sentence for a finding whose path is **no file in the repository**
 * (`pathErrors`), where `MOVED_NOTE`'s inference does not hold: the path is a
 * slip, and the problem behind it may be in a file the pull request did
 * change. The review body says so in *needs you*, but the body is not what the
 * filed stub's reader opens — this line is, so the correction has to travel
 * with it rather than stay behind in the review.
 */
const PATH_ERROR_NOTE =
  "_Raised by the review as a problem to fix before merge, then moved: its path is no file in the repository, so the diff could not place it. That is a slip in the review, not evidence the change is uninvolved; the problem may be in a file that pull request changed. Check it against the merged change before triaging it as pre-existing._";

/**
 * A finding the diff gives no anchor to, as the follow-up it becomes (#127,
 * decision 3).
 *
 * The finding is kept whole — title, location and evidence — because the thing
 * that changed is which of the review's two kinds it is, not how good it is.
 * What is added is the sentence above saying how it got here.
 *
 * The `location` is the finding's own `path:line`. It is the follow-up field
 * that is read back verbatim on merge — half the key a filing run recognises
 * its own work by — and a finding's anchor is exactly the "where a reader
 * should open first" that field asks for.
 */
export const movedFollowUp = (finding: Finding, pathError = false): FollowUp => ({
  title: finding.title,
  location: `${finding.path}:${finding.line}`,
  body: `${finding.body.trim()}\n\n${pathError ? PATH_ERROR_NOTE : MOVED_NOTE}`,
  severity: finding.severity,
});

/** The review's whole follow-up list, and how it is divided. */
export interface RecordedFollowUps {
  /** The moved findings, then what survived the cap. In filing order. */
  readonly followUps: FollowUp[];
  /**
   * How many entries at the **front** of that list are moved findings — the
   * length of the exempt prefix, written into the payload so the filing end can
   * apply the same cap to the same half (`shared/follow-up-plan.ts`).
   *
   * A count rather than a flag on each entry, because a flag would be a field
   * the *model* can write: `parseFollowUp` reads a model's answer and a payload
   * through the same door, and an entry that exempts itself from the cap is a
   * control handed to the thing the cap exists to bound.
   */
  readonly moved: number;
  /** What the cap cost — out-of-scope entries only, by the rule above. */
  readonly dropped: number;
}

/**
 * The review's follow-ups: the moved findings first, then the ones the model
 * recorded as out of scope, capped.
 *
 * **First and exempt**, which are two separate facts about them. First, because
 * the order is the filing order and a finding the review meant to stop the
 * merge with reads ahead of a note about a function the diff only calls. Exempt,
 * because the cap can only be the announced, survivable loss it is for a list
 * whose writer was told where it would be cut — and for these it is the last
 * door out: an unanchored finding is already off the count and out of the
 * record, so a cap that dropped one would delete it. The body would then state
 * *"4 findings were moved to follow-ups"* over three, and no stub would ever be
 * filed for the fourth.
 *
 * So the list can run past `MAX_FOLLOW_UPS`, and only ever by the number of
 * findings the diff gave no anchor to.
 *
 * `pathErrors` is the subset of `unanchored` whose path names no file — by
 * identity, as `pathErrors` returns them — and those carry `PATH_ERROR_NOTE`
 * instead of `MOVED_NOTE`.
 */
export const recordFollowUps = (
  unanchored: readonly Finding[],
  followUps: readonly FollowUp[],
  pathErrors: readonly Finding[] = [],
): RecordedFollowUps => {
  const moved = unanchored.map((finding) => movedFollowUp(finding, pathErrors.includes(finding)));
  const { kept, dropped } = capFollowUps(followUps);
  return { followUps: [...moved, ...kept], moved: moved.length, dropped };
};

/**
 * What a reader selects the payload on, and nothing more than that. The
 * marker is a **selector, not a control**: it says where the block is and
 * contributes nothing to trusting it. Whatever reads this establishes that the
 * review is the runner's own by checking who posted it and whether it was
 * edited — never by the presence of this string, which anyone who can comment
 * can type.
 */
export const FOLLOW_UPS_MARKER = "agent-follow-ups";

/**
 * The payload shape a reader gets back. Versioned because the review runner and
 * whatever reads this are same-version at *install* time and not at *read*
 * time: a review posted before a release is read after it. The field is the
 * cheapest way for a reader to refuse a shape it does not know.
 *
 * **This block and nothing else** — the dedup key on a filed stub carries its
 * own `STUB_KEY_VERSION` (`shared/follow-up-plan.ts`), and the two move
 * separately on purpose (#81). One constant for both made a bump for either
 * payload refuse the other, so a key change cost the filing of every review
 * body the previous release had already posted.
 */
export const FOLLOW_UPS_VERSION = 1;

/** The label whose removal opts a pull request out of having these filed. */
export const FOLLOW_UPS_LABEL = "agent:follow-ups";

/**
 * JSON that survives being put inside an HTML comment.
 *
 * `<` and `>` are escaped into the JSON rather than stripped: prose carried in
 * the payload may legitimately contain `-->`, which would end the comment early
 * and truncate what is left to invalid JSON — a reader that files nothing
 * rather than one that files three. `JSON.parse` decodes the escapes, so the
 * round trip is exact.
 *
 * Shared by both payloads deliberately. The block in a review body and the
 * dedup payload on a filed stub are written by different halves of the feature
 * and read by the same one, and this hazard is identical in both.
 */
export const embeddableJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * The block as written, found wherever it sits in a body.
 *
 * The **last** match wins. The block is appended after the summary, and the
 * summary is model prose that may quote one — so a body holding two carries the
 * real one last.
 */
const BLOCK = new RegExp(`<!-- ${FOLLOW_UPS_MARKER} (.*) -->`, "g");

/** Cheap enough to run over every review on a pull request, and answers only "is one here". */
export const hasFollowUpsBlock = (body: string): boolean =>
  new RegExp(`<!-- ${FOLLOW_UPS_MARKER} `).test(body);

/**
 * Read a block back out of a review body: `undefined` when there is none, and a
 * **throw** when there is one this cannot read.
 *
 * The split is the difference between the two failure modes a reader has to
 * keep apart. No block at all means *no review run of this version posted this
 * body* — an older release, a `fix` run's thread replies, a human's review —
 * and is answered with silence; a run that found nothing out of scope writes an
 * **empty** block rather than no block, which is a different answer and the one
 * that retracts. A block that cannot be read is a shape this version does not
 * know, which is an ordinary consequence of a release rather than a defect, and
 * the message is what says so out loud instead of guessing at fields that may
 * have moved.
 *
 * Lives beside the renderer because the two are one format. A parser in the
 * half that files would be a second description of it, drifting from the first
 * on the release that changes either.
 */
export const parseFollowUpsBlock = (
  body: string,
): { followUps: FollowUp[]; dropped: number; moved: number } | undefined => {
  const matches = [...body.matchAll(BLOCK)];
  const raw = matches[matches.length - 1]?.[1];
  if (raw === undefined) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("its payload is not readable JSON");
  }

  const record = asRecord(payload, "follow-ups payload");
  const version = record["version"];
  if (version !== FOLLOW_UPS_VERSION) {
    throw new Error(
      `it declares payload version ${JSON.stringify(version)}, and this version reads ${FOLLOW_UPS_VERSION}`,
    );
  }

  const dropped = record["dropped"];
  const followUps = asArray(record["followUps"] ?? [], "followUps").map(parseFollowUp);
  // Absent on a payload written before the moved findings existed, which reads
  // as "none of these are exempt" — the behaviour that release had, applied to
  // the list it wrote. Clamped to the list because it is an index into it, and
  // an exempt prefix longer than the list would exempt the whole of one this
  // block did not come from.
  const moved = record["moved"];
  return {
    followUps,
    dropped: typeof dropped === "number" && dropped > 0 ? Math.floor(dropped) : 0,
    moved:
      typeof moved === "number" && moved > 0 ? Math.min(Math.floor(moved), followUps.length) : 0,
  };
};

/**
 * The payload, and nothing a reader can see.
 *
 * **Written on every review, including the one that recorded nothing**, where
 * it is the whole of what this contributes. That empty list is the
 * *retraction*, and it is why this is called unconditionally: the filing half
 * reads the latest list, so a round that recorded none has to be able to say
 * so. Without it a round 2 that found the out-of-scope defect fixed leaves
 * round 1's list standing as the newest, and the merge files a stub for work
 * already done.
 *
 * A review body has a hard 65,536-character ceiling whose overflow is a 422
 * that takes the review's threads down with it, so the bodies live here and the
 * visible group carries titles alone.
 *
 * `moved` is the length of the exempt prefix (`recordFollowUps`), carried so the
 * cap the filing end re-applies bites on the same half this one capped. Without
 * it that second cap — a belt at the end holding `issues: write` — would cut a
 * list of four back to three and file nothing for the moved finding this end
 * deliberately kept. The field is additive and the version stays `1`: a reader
 * that has never heard of it reads `0` and caps exactly as it does today, where
 * a bump would make it refuse the block and file nothing at all.
 */
export const followUpsPayload = (
  kept: readonly FollowUp[],
  dropped: number,
  moved: number,
): string =>
  `<!-- ${FOLLOW_UPS_MARKER} ${embeddableJson({
    version: FOLLOW_UPS_VERSION,
    dropped,
    moved,
    followUps: kept,
  })} -->`;

/**
 * The visible half: one collapsed group in the body, shaped like every other
 * group in it (#109, decision 8 as the maintainer settled it).
 *
 * It used to be appended *after* the body, so it landed below the run link and
 * looked unlike everything above it — the shape a reader learns to skip. What
 * has not changed is what it is for: the opt-out has to be visible or it is not
 * an opt-out, and the question it asks an author (*do I want these filed?*) is
 * answered by the titles alone.
 *
 * Collapsed, and **not counted** on the `**Findings:**` line: that number is
 * what blocks this pull request, and a follow-up is by definition what does
 * not.
 *
 * `<code>` rather than backticks inside the `<summary>`, as `<b>` is used for
 * the group names: the summary line is HTML, and Markdown inside one is not
 * something to rely on for the sentence that teaches an author the opt-out.
 */
export const renderFollowUpsGroup = (
  kept: readonly FollowUp[],
  dropped: number,
): string | undefined => {
  if (kept.length === 0) return undefined;

  // Badged but **not reordered** — see `FollowUp.severity`. The order is the
  // reviewer's, the cap drops from the end of it, and the index into it is half
  // the key a filing run recognises its own work by.
  const items = kept.map(
    (f) => `- ${severityBadge(f.severity)} **${oneLine(f.title)}** — \`${oneLine(f.location)}\``,
  );

  // Said here as well as after the merge, because this is the half that is
  // actionable: it reaches the author while the pull request is still open and
  // raising the dropped finding by hand is still cheap.
  //
  // *Out-of-scope* is load-bearing since the list can be longer than the cap: a
  // moved finding is exempt (`recordFollowUps`), so a sentence claiming only
  // three entries are listed would be false above four and would name the wrong
  // population for the loss either way.
  const truncation =
    dropped === 0
      ? []
      : [
          "",
          `Only the ${MAX_FOLLOW_UPS} most serious out-of-scope findings are listed; ${dropped} more were dropped by the cap. Raise them here if they matter.`,
        ];

  return [
    "<details>",
    `<summary><b>Follow-ups</b> — ${kept.length} · filed as issues on merge; remove <code>${FOLLOW_UPS_LABEL}</code> to skip</summary>`,
    "",
    ...items,
    ...truncation,
    "",
    "</details>",
  ].join("\n");
};

/**
 * Both halves together, for the artifact a human debugging the run opens
 * (`follow_ups.md`).
 *
 * The posted body composes the two separately — the group sits with the other
 * groups and the payload goes last, invisibly — so this is not how the review
 * is assembled. It is one call for "everything this run recorded", and having
 * it here is what keeps the *format* described once: a second rendering in the
 * runner would drift on the release that changes either half.
 */
export const renderFollowUpsBlock = (
  kept: readonly FollowUp[],
  dropped: number,
  moved: number,
): string => {
  const group = renderFollowUpsGroup(kept, dropped);
  const payload = followUpsPayload(kept, dropped, moved);
  return group === undefined ? payload : `${group}\n\n${payload}`;
};
