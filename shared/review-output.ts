import { randomUUID } from "node:crypto";
import { asArray, asRecord, asString, standardSchema } from "./common.js";
import {
  findingMarker,
  findingTitle,
  isPreviouslyMissed,
  parseFinding,
  parseSeverity,
  severityBadge,
  severityRank,
  SEVERITIES,
  withoutFindingMarkers,
  withoutSeverityBadge,
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
  /**
   * The id the workflow gave it when it was first recorded (#247), carried
   * verbatim in the payload from then on. What a later round on a PRD PR
   * carries it forward by and de-duplicates on, never its text: a finding
   * reworded between rounds is the case an id exists for.
   *
   * Never the model's: `recordFollowUps` gives everything the model recorded a
   * fresh one, so an entry cannot name an earlier round's to displace it.
   * Absent on a payload written before ids existed.
   */
  readonly id?: string;
}

/**
 * At most this many **out-of-scope** follow-ups per review — the ones the
 * model records in `followUps`. Enforced by `capFollowUps` and *never* by the
 * schema — see the comment there.
 *
 * Not a bound on the recorded list as a whole. Findings the diff could not
 * anchor are moved to follow-ups ahead of these and are exempt (#127), so the
 * list runs past this by exactly their number — see `recordFollowUps`.
 */
export const MAX_FOLLOW_UPS = 3;

/**
 * The cap for a pull request with `landedSlices` slices on it (#247):
 * `MAX_FOLLOW_UPS` per slice. A PRD PR carries every slice of its PRD, and its
 * newest review carries forward what every earlier round recorded, so a
 * six-slice PRD is not held to one pull request's budget. A regular pull
 * request is one slice, and anything under one is read as one, so its cap
 * stays `MAX_FOLLOW_UPS`.
 */
export const followUpsCap = (landedSlices: number): number =>
  MAX_FOLLOW_UPS * Math.max(1, Number.isFinite(landedSlices) ? Math.floor(landedSlices) : 1);

/**
 * A fresh follow-up id, random for the reason a finding's is (`newFindingId`):
 * derived from the text, it would change when a round reworded the entry.
 */
export const newFollowUpId = (): string => `fu-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

/**
 * The hard limit on the pull request's `title`, in characters (#218). A title
 * is one line a reader scans in a list, and the commit subject a squash merge
 * lands; GitHub's own limit is far past where either reads well.
 */
export const MAX_TITLE_LENGTH = 100;

/**
 * The hard limit on the pull request's `summary`, in words (#218). The brief
 * asks for something short about what was built; this is where that stops
 * being a request.
 */
export const MAX_SUMMARY_WORDS = 150;

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

/**
 * What the review decided about one **out-of-scope note** the fix run left
 * (#213): record it as a follow-up, filed on merge like any other, or drop it
 * with a reason the body states. See `applyNoteRulings`.
 *
 * A drop carries a reason by type, because a drop with none is the silent loss
 * the ruling exists to end. A promotion carries what makes it a follow-up and
 * the note does not have: a severity, and a location where the review can name
 * a better one than the note gave.
 */
export type NoteRuling =
  | {
      readonly noteId: string;
      readonly status: "promoted";
      readonly severity: Severity;
      readonly location?: string;
    }
  | { readonly noteId: string; readonly status: "dropped"; readonly reason: string };

/**
 * What the review decided about one of the linked issue's **acceptance
 * criteria** (#214), named by the id it was handed it under (`C1`, `C2`, …).
 *
 * `changed` carries its reason by type: a criterion dropped or replaced on
 * purpose with nothing saying why is the silent change #214 exists to end. An
 * `unmet` one carries an anchor, because it becomes a fix-before-merge finding
 * (`applyCriteriaRulings`) and a finding is posted on the diff.
 */
export type CriterionRuling =
  | { readonly id: string; readonly status: "met" }
  | { readonly id: string; readonly status: "changed"; readonly reason: string }
  | {
      readonly id: string;
      readonly status: "unmet";
      readonly reason?: string;
      readonly path: string;
      readonly line: number;
      readonly severity: Severity;
    };

/**
 * One criterion as the body lists it: the issue's own words, and what the
 * review said. `unchecked` is a criterion the review said nothing about, shown
 * as such rather than left out, so a list that looks complete is complete.
 */
export interface CriterionResult {
  readonly id: string;
  readonly text: string;
  readonly status: "met" | "changed" | "unmet" | "unchecked";
  readonly reason?: string;
}

/** One behaviour a PRD changes, as its final review lists it (#247). */
export interface BehaviourChange {
  readonly change: string;
  /** A caller or a user has to act on it. */
  readonly breaking: boolean;
}

/** A note the review dropped, as the body lists it. */
export interface DroppedNote {
  readonly title: string;
  readonly reason: string;
  /** The note's permalink, where GitHub returned one. */
  readonly url?: string;
}

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
   * The pull request's title as the review would have it: one line, true of
   * the change as it now stands, in the adopter's commit convention (#218).
   * Written by the workflow, and only where anything was pushed since the
   * summary was last written (`summaryDue`).
   *
   * Capped at `MAX_TITLE_LENGTH`.
   */
  readonly title?: string;
  /**
   * What this pull request does, for the **summary block** in its body rather
   * than for the review comment (#218): the description lives in one place, and
   * it is the place a reader opens first. Written under the same rule as
   * `title`, between the block's markers and nowhere else.
   *
   * Capped at `MAX_SUMMARY_WORDS`.
   */
  readonly summary?: string;
  /**
   * On a PRD PR's **final review** only (#247): each behaviour the PRD as a
   * whole changes, one line each, with the breaking ones flagged. The workflow
   * renders them into the summary's *Behaviour changes* section and marks the
   * breaking ones, so the mark is not left to the model's formatting. Absent
   * on every other review.
   */
  readonly behaviourChanges?: BehaviourChange[];
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
  /**
   * One ruling per out-of-scope note the fix run left since the last verdict
   * (#213). Absent where the review was handed none, which is nearly every
   * review.
   */
  readonly noteRulings?: NoteRuling[];
  /**
   * One ruling per acceptance criterion of the linked issue (#214). Absent
   * where the review was handed none: no linked issue, or one with no
   * criteria to identify.
   */
  readonly criteria?: CriterionRuling[];
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
 * (#96). The names are GitHub's own Copilot code review headings, verbatim, so
 * anyone who has read one of those already knows what ours mean.
 *
 * Three keys for three headings. *Changes recommended* used to have a second
 * key, the one the workflow posted where it was adding `agent:fix` itself
 * (#102), and its line said a fix round had started. That key is retired
 * (#297, #201's *Verdict lines*): every verdict now carries one fixed line,
 * true in every state, and whether a round starts is `startsFixRound` on the
 * row, which no line reads.
 *
 * A fourth, *changes recommended after a fix round*, was the round-2 answer and
 * went with the round rule (#202, PRD #200 decision 6): a later review may now
 * start another round, and the budget and the early stop bound the loop.
 */
export type Verdict = "approval recommended" | "changes recommended" | "needs a closer look";

export interface VerdictRow {
  readonly verdict: Verdict;
  /**
   * The heading the posted review body opens with: the assessment's marker and
   * its `label`. Copilot code review's own wording, so it is recognised rather
   * than learned — which is why it is a literal here rather than composed from
   * the key beside it.
   *
   * Shared by the three causes of *needs a closer look*: what differs between
   * those is the step, not the assessment.
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
   * rejected, and the round detection that read them back saw none (#121).
   */
  readonly label: string;
  /**
   * The commit status's state. Only *approval recommended* is `success`: every
   * other row is something left to do, and a green tick beside one of those is
   * the verdict saying the opposite of what it means.
   */
  readonly state: "success" | "failure";
  /**
   * The next human step, and the whole promise of the feature: this line is
   * what makes the outcome actionable without reading the review.
   *
   * The body carries this on its own, under the heading. It is the long form,
   * and it is fixed per verdict (#201's *Verdict lines*, #297): true whatever
   * the pull request's state, PRD or not, auto-fix on or off, whichever round,
   * budget left or spent. A line that changes with any of those is a line that
   * can claim something the review cannot know.
   */
  readonly nextStep: string;
  /**
   * What GitHub shows beside the status: `<label>. <status line>`, written out
   * rather than composed, so the line a maintainer reads is in this table
   * verbatim. The status line is the short form of `nextStep`, and may differ
   * from it on every row: a status has 140 characters and no formatting. A
   * test holds it under GitHub's 140-character limit, which truncates where
   * the character ran out rather than where the sentence ends, and free of any
   * character GitHub refuses there (see `label`).
   */
  readonly description: string;
  /**
   * Which of #200's stops a *changes recommended* row is, where it is one: the
   * automatic fix rounds are spent, or the last one made no progress. Absent on
   * every row of the table itself. Read by the PRD chain's park comment
   * (`shared/prd-round.ts`), which names the reason a round stopped; the key
   * cannot, since both stops keep the plain row's key and its line.
   */
  readonly stop?: "budget spent" | "no progress";
  /**
   * Whether the workflow adds `agent:fix` itself on this verdict: a *changes
   * recommended* row where the budget step said a round would start and the
   * early stop did not fire (#201, #202). Present only then.
   *
   * A field rather than a key or a line (#297). The line is fixed and makes no
   * promise about automatic fixing, so this is the one thing that tells the
   * two cases apart, and the hand-off to the fix round selects on it.
   */
  readonly startsFixRound?: true;
}

/**
 * The context the verdict is posted under. One per commit per context, so a
 * later review of the same commit replaces its own verdict and nothing else —
 * and a new commit carries none until one is posted for it, which is what stops
 * a stale approval surviving a push.
 */
export const VERDICT_CONTEXT = "agent-review";

/**
 * The record that a review asked for an automatic fix round (#297): a second
 * status, under a context of its own, posted beside the verdict on the same
 * commit and linking the same review, only where the row has
 * `startsFixRound`.
 *
 * The verdict's line used to be that record: a fix round's status line was
 * its own, and the budget counted rounds by it, word for word. #201's
 * *Verdict lines* made every line fixed whatever the state, so the fact moved
 * here. It is what *Settle the fix-round budget* counts rounds by and what
 * `readReviewHistory` reads a fix round off, matched to its verdict by link.
 *
 * `success`, because it records a step taken rather than something left to
 * do, and a `pending` one would read as a check that never finished.
 */
export const FIX_ROUND_STATUS = {
  context: "agent-fix-round",
  state: "success",
  description: "This review asked for an automatic fix round.",
} as const;

/**
 * The line a 0.7.6 verdict carried where it started a round, before
 * `FIX_ROUND_STATUS` existed (#297). A pull request whose round was in flight
 * at the upgrade has only this to show for it, so the two readers of a round,
 * `readReviewHistory` and *Settle the fix-round budget*, count an
 * `agent-review` status carrying it as a round too. For one release: the
 * statuses outlive it, but a round started under 0.7.6 has finished by then.
 */
export const LEGACY_FIX_ROUND_STARTED =
  "Changes recommended. The fixes are clear. A fix round has already started; a re-review follows automatically.";

/**
 * The table, verbatim: #201's *Verdict lines*, settled with the maintainer on
 * 2026-09-30 and shipped by #297. The issue is the copy a human argues with.
 *
 * *Needs a closer look* is here once, for its key, heading, label and state,
 * and its lines are `CLOSER_LOOK`'s: three causes, one row each.
 */
export const VERDICTS: Readonly<Record<Verdict, VerdictRow>> = {
  "approval recommended": {
    verdict: "approval recommended",
    heading: "🟢 Approval recommended",
    label: "Approval recommended",
    state: "success",
    nextStep: "Nothing left to fix. You can merge once the PR is ready and no longer a draft.",
    description:
      "Approval recommended. Nothing left to fix. You can merge once the PR is ready and no longer a draft.",
  },
  "changes recommended": {
    verdict: "changes recommended",
    heading: "🟡 Changes recommended",
    label: "Changes recommended",
    state: "failure",
    nextStep:
      "The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label.",
    description:
      "Changes recommended. If the agent isn't already working on them, add the agent:fix label to have it make the changes.",
  },
  "needs a closer look": {
    verdict: "needs a closer look",
    heading: "🔵 Needs a closer look",
    label: "Needs a closer look",
    state: "failure",
    nextStep:
      "This needs your judgement before anything is changed. Read the review, then do one of these: (1) comment with what to change and add the `agent:fix` label, (2) push a fix yourself, (3) merge as is if you're satisfied, or (4) close the PR.",
    description:
      "Needs a closer look. Read the review, then tell the agent what to fix, fix it yourself, merge as is, or close the PR.",
  },
};

/**
 * Why a review needs a closer look, which decides what the step says (#209).
 * Three ways into one row: the agent said a fix round cannot settle it, a
 * failing check the review could not explain, and CI that never reported, or
 * had not finished (waiting for approval, or still running at the wait's
 * ceiling, #221). The action differs and the review knows the cause.
 */
export type CloserLookCause = "needs you" | Exclude<CiResult, "green">;

/**
 * *Needs a closer look*'s lines, one per cause, verbatim from the same table.
 * None depends on PRD, auto-fix or round.
 */
export const CLOSER_LOOK: Readonly<
  Record<CloserLookCause, Pick<VerdictRow, "nextStep" | "description">>
> = {
  "needs you": {
    nextStep: VERDICTS["needs a closer look"].nextStep,
    description: VERDICTS["needs a closer look"].description,
  },
  red: {
    nextStep:
      "A CI check failed, and the review couldn't trace it to the code. Read the failing check named in the review, then do one of these: (1) comment with what to change and add the `agent:fix` label, (2) push a fix yourself, (3) merge as is if the failure doesn't matter here, or (4) close the PR.",
    description:
      "Needs a closer look. A CI check failed and the review couldn't trace it to the code. Read the failing check, then fix it or merge as is.",
  },
  unknown: {
    nextStep:
      "CI hadn't finished, or couldn't be read, when the review ran. Approve any run that's waiting for approval, and once CI is done, add the `agent:review` label to review again. If this change doesn't need CI, you can merge it as is.",
    description:
      "Needs a closer look. CI hadn't finished or couldn't be read. Once it's done, add agent:review, or merge as is if CI isn't needed.",
  },
};

/**
 * Everything the verdict depends on that is not in the review itself.
 *
 * An object rather than positional arguments, and the facts a caller could
 * forget are required rather than defaulted: a default is a caller that forgot
 * one silently getting the reading with no symptom.
 */
export interface VerdictInputs {
  readonly ci: CiResult;
  /**
   * What the fix round this review follows did with the findings it was given
   * (#202, PRD #200 decision 5), or `undefined` where this review follows no
   * fix round: the first review, or one nothing was pushed for.
   *
   * Where it closed none of them, no further automatic round starts, whatever
   * budget is left, and the verdict says why. New findings this review raised
   * are not in it: they neither count as progress nor reset anything.
   *
   * Required rather than optional, for the reason `stillOpen` is: a caller that
   * forgot it would never early-stop, and a loop that keeps spending rounds on
   * a fix that changes nothing looks, from outside, like a loop working.
   */
  readonly fixRoundProgress: FixRoundProgress | undefined;
  /**
   * How many findings an **earlier** review raised that this one checked and
   * found still open (#111, and #109 decision 1).
   *
   * They count exactly as this review's own do: a finding lives until a review
   * verifies it fixed, so one that has survived a round is more reason to stop
   * the merge than a fresh one, not less. A review that found nothing new and
   * three things still unfixed is not an approval.
   *
   * Required rather than defaulted to zero: a caller that forgot it recommends approving a pull request with unfixed
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
  /**
   * Whether the workflow will add `agent:fix` itself if this review recommends
   * changes: the pull request's automatic fix rounds are fewer than its
   * fix-round budget, and `AGENT_PAT` is there to start one (#201, PRD #200).
   *
   * Facts only the workflow holds, and none is about the review: a repository
   * variable, the verdicts already posted on the pull request, and a secret.
   * Whether the last fix round made progress is not one of them (it is an
   * input of its own, and the arm below reads it first), so the conditions the
   * automatic fix fires on are ruled on in one place.
   *
   * Required rather than defaulted to `false`, for the reason `stillOpen` is. A
   * caller that forgot it derives a row without `startsFixRound`, which the
   * automatic-fix step selects on: the fix never starts, and the feature is off
   * with nothing anywhere saying so.
   */
  readonly autoFix: boolean;
  /**
   * The fix-round budget and how much of it this pull request has spent, where
   * the workflow could count it (#201). Read only where no round is starting:
   * a spent budget is a reason the loop has stopped, which the PRD chain's
   * park comment names (`stop`). The line does not: it is the same either way.
   *
   * Optional, because nothing is lost where it is absent: the row carries no
   * `stop`, and the park comment gives the plain reason.
   */
  readonly fixRounds?: FixRounds;
}

/** A pull request's fix-round budget, and the automatic rounds spent against it. */
export interface FixRounds {
  readonly spent: number;
  readonly budget: number;
}

/**
 * The findings a fix round was asked to address, and how many of them the
 * review after it closed, matched by the ids the workflow wrote into them
 * (#202). Counts rather than the ids themselves, because the early stop only
 * asks whether any closed; the matching is `fixRoundProgress`'s, in
 * `shared/review-round.ts`.
 */
export interface FixRoundProgress {
  readonly given: number;
  readonly closed: number;
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
 * And in **every form a release wrote one in**, not the form this release
 * writes: the image chip of #135, and the code span v0.4.0 and v0.5.0 bodies
 * carry, which are exactly the bodies decision 5's carried entries come out of.
 * `withoutSeverityBadge` holds the list, beside the renderer.
 *
 * A no-op on a threaded finding, whose line comes off the thread rather than
 * out of a body and so carried neither decoration.
 */
const carriedClaim = (finding: CarriedFinding): { readonly title: string; readonly anchor?: string } => {
  const claim = oneLine(finding.text).replace(NEW_SUFFIX, "");
  const unbadged = (
    finding.severity === undefined ? claim : withoutSeverityBadge(claim, finding.severity)
  ).trim();

  // The anchor `entryLine` wrote behind the claim, in both separators a release
  // wrote it with: ` · ` now, and the em dash every body before #136 carries.
  // Taken off so it is rendered again as an anchor, in this release's form,
  // rather than kept as part of the title in the form it arrived in.
  const anchored = ANCHOR_SUFFIX.exec(unbadged);
  return anchored?.[2] === undefined
    ? { title: unbadged }
    : { title: unbadged.slice(0, anchored.index).trim(), anchor: anchored[2] };
};

/** The anchor `entryLine` writes behind a claim, in the current and the pre-#136 form. */
const ANCHOR_SUFFIX = /\s+(·|—)\s+`([^`\s]+)`$/;

/**
 * A finding this review produced, as an entry.
 *
 * The title rather than the claim, which is what `title` is for — by
 * `findingTitle`, the same derivation the thread's marker carries forward, so a
 * later round lists this finding under the words this one did.
 */
const placedEntry = (placed: PlacedFinding): RecordEntry => {
  // No id and no evidence: every finding this review raises now has a thread
  // (#127, decision 1), and the thread carries both.
  return {
    title: oneLine(findingTitle(placed.finding)),
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
  // A threaded finding's own title where the thread carried one (#134); the
  // body entry's line, stripped of what this file wrote around it, otherwise.
  ...(finding.title === undefined ? carriedClaim(finding) : { title: oneLine(finding.title) }),
  ...(finding.anchor === undefined ? {} : { anchor: finding.anchor }),
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
 * The badge is the image chip of #135 — self-hosted and tag-pinned, which is
 * what decision 9 ruled out a *hotlink* of: see `severityBadge`. The marker goes
 * last so the visible line ends where the claim does, and `carriedClaim` is the
 * half that reads this back.
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
    entry.anchor === undefined ? undefined : `· \`${entry.anchor}\``,
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
 * How a group the posting job renders opens: its title, whether it starts
 * expanded, and the line under its summary where it has one (#257).
 */
export interface GroupHead {
  readonly title: string;
  readonly open: boolean;
  readonly subtitle?: string;
}

/** *Resolved since last review*, as `renderReviewBody` renders it and the posting job does. */
export const RESOLVED_GROUP: GroupHead = { title: "Resolved since last review", open: false };

/**
 * The group a closure the posting job could not make lands in (#257): this
 * review closed the finding, and GitHub refused to resolve its thread or take
 * the reply before it. The thread is still open, so the record says so rather
 * than listing it under *Resolved*, and the next review retries it.
 *
 * Expanded, as *Open* is: an open thread is something a reader may have to act
 * on. Rendered by nothing here, since the runner cannot know which resolves will
 * fail; the posting job renders it, from these words, where one did.
 */
export const UNCLOSED_GROUP: GroupHead = {
  title: "Still open",
  open: true,
  subtitle:
    "This review closed these, but their threads could not be resolved, so they stay open until the next review retries",
};

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
    `<summary><b>${title}</b> (${entries.length})</summary>`,
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
 * it to rate, and `— 0 High, 0 Medium` is noise standing in for a fact.
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

  return `**Findings:** ${record.findings}${breakdown === "" ? "" : ` (${breakdown})`}`;
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
 *
 * It states where the finding could not go, and **not** why: "nothing this
 * change causes it" is the demotion's inference, and it is false for a path
 * error (`pathErrors`), whose `needsYou` warning sits two lines above this
 * one. A line that asserted it would contradict that warning for the one case
 * the warning exists for.
 */
const movedSentence = (moved: number): string | undefined =>
  moved === 0
    ? undefined
    : `_${moved} ${plural(moved, "finding was", "findings were")} moved to follow-ups: ${plural(moved, "it points", "they point")} at no file this pull request changes, so there was nowhere in the diff to comment on ${plural(moved, "it", "them")}._`;

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
 * How this was checked: the collapsed section that, with the summary block in
 * the pull request's body (#218), replaced one 250-word paragraph.
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

/**
 * GitHub's ceiling on a review body. Over it, `addPullRequestReview` answers
 * with a 422 and posts nothing — the inline threads included, since they go out
 * in the same call (#140).
 */
export const REVIEW_BODY_LIMIT = 65_536;

/**
 * What `renderReviewBody` holds a body to: the ceiling less a margin for what is
 * added after it measures — the GraphQL request escaping nothing GitHub counts,
 * but a margin costing a kilobyte of a sixty-four kilobyte record is cheaper
 * than finding out which of the two was wrong.
 */
export const REVIEW_BODY_BUDGET = REVIEW_BODY_LIMIT - 1_024;

/**
 * A body's size as it is held to `REVIEW_BODY_BUDGET`: **UTF-8 bytes**.
 *
 * GitHub's message says *characters* and documents nothing more, and the
 * reports of it disagree about multibyte text. So this counts the unit that is
 * never smaller than any of the candidates — bytes are at least code points and
 * at least UTF-16 units — which makes the wrong guess an entry shortened that
 * would have fitted rather than a review lost to a 422.
 */
export const reviewBodySize = (body: string): number => Buffer.byteLength(body, "utf8");

/**
 * How long a record entry's title may run once the body has to shed. Long
 * enough to say what the finding is; the rest is on its thread, or — for a
 * carried body entry with none — was on the review that raised it.
 */
const SHED_TITLE_LENGTH = 160;

/** By code point, so a cut never lands inside a surrogate pair. */
const shortened = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("").trimEnd()}…`;
};

/**
 * What `renderReviewBody` gave up to fit, in the order it gives it up. Each
 * later step keeps every earlier one.
 */
interface Shed {
  /** The record's entries were cut to `SHED_TITLE_LENGTH`. */
  readonly titles: boolean;
  /** The *Follow-ups* group lists no titles, only how many there are. */
  readonly followUpTitles: boolean;
  /** How many entries were cut off the payload's tail, out-of-scope half only. */
  readonly cutFollowUps: number;
}

const NOTHING_SHED: Shed = { titles: false, followUpTitles: false, cutFollowUps: 0 };

/**
 * The visible sentence saying what was cut, or `undefined` where nothing was —
 * so a body that fits is the body it always was.
 */
const shedSentence = (shed: Shed): string | undefined => {
  const clauses = [
    shed.titles ? "the evidence quoted in the entries below was shortened" : undefined,
    shed.followUpTitles ? "the follow-up titles were left out" : undefined,
    shed.cutFollowUps === 0
      ? undefined
      : `${shed.cutFollowUps} out-of-scope ${plural(shed.cutFollowUps, "follow-up was", "follow-ups were")} cut from the end of the list filed on merge`,
  ].filter((clause) => clause !== undefined);

  return clauses.length === 0
    ? undefined
    : `_To fit GitHub's ${REVIEW_BODY_LIMIT.toLocaleString("en-US")}-character limit on a review body, ${clauses.join("; ")}._`;
};

/**
 * The body as it is posted: the findings record decision 8 describes, in one
 * fixed order, and the one place that order is written down.
 *
 * Top to bottom: the heading that says which comment this is, the assessment,
 * the review's own sentence naming what is unresolved, the step in italics, the
 * count and — on the rounds that have one — the line saying a finding was moved
 * to the follow-ups, then *Open*, *Previously missed*, *Resolved since last
 * review*, *Acceptance criteria* (#214), *Follow-ups* and *How this was checked*, then a rule and the run
 * that produced it. What the change *is* is not here: it is the summary block
 * in the pull request's body (#218), so it is said in one place. The order is Copilot code review's
 * own overview, which is the point — a maintainer who has read one of those
 * already knows where to look.
 *
 * Three rules about the groups are worth stating because breaking one of them
 * is invisible. **A group with nothing in it is omitted**, so a disclosure
 * widget never opens on nothing. **What is owed is expanded and what is done is
 * folded**: *Open* and *Previously missed* are what the verdict has just told a
 * reader to act on — and *Previously missed* counts toward that verdict, which
 * is why it is not collapsed the way Copilot collapses its equivalent — while
 * *Resolved*, *Follow-ups* and *How this was checked* start closed. And **the
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
export const renderReviewBody = (parts: ReviewBodyParts): string => renderReviewPost(parts).body;

/**
 * The body, and what the posting job needs to put *Resolved since last review*
 * right after it has tried to resolve the threads (#257).
 *
 * The review job runs the model and posts nothing; a job that runs no model
 * resolves the threads this review closed and then posts the body. So the body
 * cannot know, when it is rendered, which of those closures will hold. `body` is
 * the body as it reads where every one did, and is what the run log and the
 * payload carry. `slotted` is the same body with `slot` where the resolved group
 * goes, and `resolved` is that group's lines, worst first, each with the thread
 * the posting job has to have resolved for the line to stay there. A line whose
 * thread it could not resolve moves to `UNCLOSED_GROUP` instead, in the same
 * place in the body.
 *
 * The lines are rendered here, shed as the rest of the body was, so the posting
 * job writes no entry and composes only the two group wrappers, from `groups`.
 * A legacy body entry has no thread and closes by not being listed again, so it
 * carries no `threadId` and always stays.
 *
 * Measured with the resolved group in place. A closure that fails costs the
 * unclosed group's summary and subtitle on top, a few hundred bytes inside the
 * margin `REVIEW_BODY_BUDGET` keeps under GitHub's limit.
 */
export interface ReviewPost {
  readonly body: string;
  readonly slotted: string;
  readonly slot: string;
  readonly resolved: readonly { readonly threadId?: string; readonly line: string }[];
  readonly groups: { readonly resolved: GroupHead; readonly unclosed: GroupHead };
}

/**
 * Where the resolved groups go in `ReviewPost.slotted`: an HTML comment, so a
 * slot nothing replaced renders as nothing.
 */
export const RESOLVED_SLOT = "<!-- agent-review:resolved-groups -->";

export const renderReviewPost = (parts: ReviewBodyParts): ReviewPost => {
  const record = reviewRecord(parts);
  // The resolved entries with their threads, in the record's order: the same
  // comparator over the same list, and `Array#sort` is stable.
  const closures = parts.resolved
    .map((finding) => ({ threadId: finding.threadId, entry: carriedEntry(finding, false) }))
    .sort((a, b) => severityRank(a.entry.severity) - severityRank(b.entry.severity));
  const body = renderBody(parts, record);
  const cut = cutFor(body.shed);

  return {
    body: body.text,
    slotted: body.compose(body.shed, true),
    slot: RESOLVED_SLOT,
    resolved: closures.map(({ threadId, entry }) => ({
      ...(threadId === undefined ? {} : { threadId }),
      line: entryLine(cut([entry])[0] as RecordEntry),
    })),
    groups: { resolved: RESOLVED_GROUP, unclosed: UNCLOSED_GROUP },
  };
};

/** The record's entries as a shed renders them: titles cut where it cut them. */
const cutFor =
  (shed: Shed) =>
  (entries: readonly RecordEntry[]): RecordEntry[] =>
    shed.titles
      ? entries.map((entry) => ({ ...entry, title: shortened(entry.title, SHED_TITLE_LENGTH) }))
      : [...entries];

/** What `renderReviewBody` is handed. */
export interface ReviewBodyParts {
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
   * The cap `recordFollowUps` held the list to, written into the payload for
   * the filing end to re-apply (#247). `MAX_FOLLOW_UPS` where absent, which is
   * every regular pull request's.
   */
  readonly followUpsCap?: number | undefined;
  /**
   * Whether earlier rounds' entries lead the capped list (#247), from
   * `recordFollowUps`: the cap then drops the newest rather than the least
   * serious, and the body says so.
   */
  readonly followUpsCarried?: boolean | undefined;
  /**
   * The fix run's out-of-scope notes this review chose not to file, each with
   * its reason (#213), from `applyNoteRulings`. The promoted ones are in
   * `followUps` above and are not repeated here.
   *
   * Optional, because nearly every review is handed no notes; empty and absent
   * both render nothing.
   */
  readonly droppedNotes?: readonly DroppedNote[] | undefined;
  /**
   * The linked issue's acceptance criteria and what this review said about
   * each (#214), from `applyCriteriaRulings`. Optional, because a pull request
   * with no linked issue, or one whose issue names no criteria, has none; empty
   * and absent both render nothing.
   */
  readonly criteria?: readonly CriterionResult[] | undefined;
  /**
   * On a PRD PR's slice round, the red check's record of the slice's red tests
   * (#235), as `renderRedTestsBlock` writes it: invisible, and read back by the
   * final review, which lists each slice's. Optional, because only a slice
   * round where the check is configured has one.
   */
  readonly redTestsBlock?: string | undefined;
  /**
   * The run that produced this review. Optional — it is a link, and a review
   * that could not name its own run is still a review — so a caller outside
   * Actions renders a body without one rather than failing.
   */
  readonly runUrl?: string | undefined;
  /**
   * Where to say what was shed when the body had to be made to fit. Optional,
   * because the body says it too; this is the run log's copy, for the human who
   * opens the run rather than the review.
   */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * The body, measured and shed until it fits, and how to compose it again: the
 * slotted copy `renderReviewPost` needs is the same composition, with the same
 * shed.
 */
const renderBody = (
  parts: ReviewBodyParts,
  record: ReviewRecord,
): {
  readonly text: string;
  readonly shed: Shed;
  readonly compose: (shed: Shed, slotted?: boolean) => string;
} => {

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

  const compose = (shed: Shed, slotted = false): string => {
    const cut = cutFor(shed);
    const followUps = parts.followUps.slice(0, parts.followUps.length - shed.cutFollowUps);
    // The payload accounts for every entry it does not carry, so `dropped` is
    // the sum and `cut` names the part of it the size took. The visible group
    // gets the cap's count alone: the shed sentence already says what the size
    // took, and "dropped by the cap" is the wrong cause for any of that.
    const dropped = parts.droppedFollowUps + shed.cutFollowUps;

    return [
      BODY_HEADING,
      `### ${parts.verdict.heading}`,
      assessment,
      `_${labelsAsCode(parts.verdict.nextStep)}_`,
      parts.output.needsYou,
      parts.roundNote === undefined ? undefined : labelsAsCode(parts.roundNote),
      findingsLine(record),
      movedSentence(parts.movedToFollowUps),
      shedSentence(shed),
      renderGroup("Open", cut(record.open), true),
      renderGroup("Previously missed", cut(record.missed), true, PREVIOUSLY_MISSED_SUBTITLE),
      slotted
        ? RESOLVED_SLOT
        : renderGroup(RESOLVED_GROUP.title, cut(record.resolved), RESOLVED_GROUP.open),
      renderCriteriaGroup(parts.criteria ?? [], shed.titles),
      renderFollowUpsGroup(
        followUps,
        parts.droppedFollowUps,
        !shed.followUpTitles,
        parts.followUpsCap,
        parts.followUpsCarried,
      ),
      renderDroppedNotesGroup(parts.droppedNotes ?? []),
      renderHowChecked(parts.output.howChecked),
      // The only rule in the body, and it is here rather than between the groups
      // because this is the only place the subject changes: everything above is
      // the review, and this is the run that posted it.
      parts.runUrl === undefined
        ? undefined
        : `---\n\n_Posted by [this workflow run](${parts.runUrl})._`,
      // Invisible, like the payload after it (#235).
      parts.redTestsBlock,
      // Last, and invisible. The filing half reads the latest one off the body
      // (#47), so it goes out on every review including the one that recorded
      // nothing — which is how a round retracts an earlier round's list.
      followUpsPayload(followUps, dropped, parts.movedToFollowUps, shed.cutFollowUps, parts.followUpsCap),
    ]
      .filter((part) => part !== undefined && part !== "")
      .join("\n\n");
  };

  // Measured, and shed in a fixed order until it fits (#140) — least costly to
  // lose first. The entries' quoted text goes first: a threaded finding's
  // thread holds all of it. The follow-up titles next: the payload still files
  // every one. And the payload last, from its **tail** and never from the
  // moved prefix, because an entry cut from it is a follow-up retracted — the
  // out-of-scope half is the one the cap already announces a loss on, and the
  // moved half is the last door a finding has (`recordFollowUps`).
  //
  // A body that fits is returned before any of this, so it is byte for byte
  // the body it was before the measurement existed.
  let shed = NOTHING_SHED;
  let body = compose(shed);
  if (reviewBodySize(body) <= REVIEW_BODY_BUDGET) return { text: body, shed, compose };

  const unexempt = parts.followUps.length - parts.movedToFollowUps;
  const steps: Shed[] = [
    { titles: true, followUpTitles: false, cutFollowUps: 0 },
    { titles: true, followUpTitles: true, cutFollowUps: 0 },
    ...Array.from({ length: Math.max(0, unexempt) }, (_, i) => ({
      titles: true,
      followUpTitles: true,
      cutFollowUps: i + 1,
    })),
  ];
  for (const step of steps) {
    shed = step;
    body = compose(shed);
    if (reviewBodySize(body) <= REVIEW_BODY_BUDGET) break;
  }

  // Refused by name rather than met as a 422. What is left — the assessment,
  // the moved findings' whole text — is nothing this can cut without deleting
  // something the verdict or the filing run was told is there.
  const size = reviewBodySize(body);
  if (size > REVIEW_BODY_BUDGET) {
    throw new Error(
      `The review body is ${size} bytes after shedding everything it can, over the ${REVIEW_BODY_BUDGET} this holds it to beneath GitHub's ${REVIEW_BODY_LIMIT}-character limit. Posting it would be refused with a 422 that loses the review's threads as well, so nothing was posted.`,
    );
  }

  parts.log?.(
    `Review body: ${shedSentence(shed)?.replace(/^_|_$/g, "")} It is now ${size} bytes.`,
  );
  return { text: body, shed, compose };
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
  if (output.needsYou !== undefined) return closerLook("needs you");
  // This review's findings **and** the earlier ones it checked and found still
  // open. Added, because the two are disjoint sets — one this review found,
  // one it verified — where the two halves inside `countFixBeforeMerge` are
  // two restatements of one set. Their sum is the record's own size, which is
  // what `**Findings:** N` states.
  const open = countFixBeforeMerge(output, inputs.movedToFollowUps) + inputs.stillOpen;
  if (open > 0) {
    const row = VERDICTS["changes recommended"];
    // **A fix round that closed none of its findings stops the loop** (#202,
    // PRD #200 decision 5), whatever budget is left, and ahead of `autoFix` so
    // no round can start out of it. Judged by id, not by count: a round that
    // closed two findings and uncovered two new ones made progress, and one
    // where the same finding returns reworded did not. Where this review
    // follows no fix round there is nothing to judge, so a pull request with
    // one review round so far never stops here.
    //
    // This and the budget are what bound review → fix now. The round rule that
    // did it before, a later review barred from recommending another round,
    // is retired: it asked for guidance 9 times in 40 PRs and got it 0 times.
    const progress = inputs.fixRoundProgress;
    if (progress !== undefined && progress.given > 0 && progress.closed === 0) {
      return { ...row, stop: "no progress" };
    }
    // Whether the workflow is about to add `agent:fix` itself is a fact about
    // the *workflow* rather than about the review (#102), so it changes the
    // row's `startsFixRound` and nothing a maintainer reads (#297). The
    // automatic fix selects on that field, which is what makes the derivation
    // and the job one decision.
    if (inputs.autoFix) return { ...row, startsFixRound: true };
    // And where no round starts because the budget is spent, the row records
    // why (#201), for the park comment. Not on a budget of 0, where nothing
    // was spent.
    const rounds = inputs.fixRounds;
    if (rounds !== undefined && rounds.budget > 0 && rounds.spent >= rounds.budget) {
      return { ...row, stop: "budget spent" };
    }
    return row;
  }
  if (inputs.ci !== "green") return closerLook(inputs.ci);
  return VERDICTS["approval recommended"];
};

/**
 * The *needs a closer look* row for one cause.
 *
 * The key, heading, label and state are the table's, so everything that
 * selects on the verdict (the PRD chain's advance job parks on it) reads all
 * three causes as one. Only the step and the status line differ.
 */
const closerLook = (cause: CloserLookCause): VerdictRow => ({
  ...VERDICTS["needs a closer look"],
  ...CLOSER_LOOK[cause],
});

/**
 * One criterion ruling, thrown on where it is malformed as a note ruling is: a
 * change with no reason, or an unmet criterion with nowhere to post it, is the
 * extraction retry's to get right rather than this file's to guess.
 */
const parseCriterionRuling = (value: unknown): CriterionRuling => {
  const record = asRecord(value, "criterion ruling");
  const id = asString(record["id"] ?? record["criterionId"], "criterion ruling id").trim();
  const status = asString(record["status"], "criterion ruling status");
  const reason = optionalReason(record["reason"], "criterion reason");
  if (status === "met") return { id, status };
  if (status === "changed") {
    if (reason === undefined) throw new Error(`criterion ${id} is changed but carries no reason`);
    return { id, status, reason: reason.trim() };
  }
  if (status !== "unmet") {
    throw new Error(`criterion ruling status must be "met", "changed" or "unmet", got "${status}"`);
  }
  const path = asString(record["path"] ?? record["file"], `unmet criterion ${id} path`);
  const line = record["line"];
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    throw new Error(`unmet criterion ${id} line must be a positive integer`);
  }
  return {
    id,
    status,
    ...(reason === undefined ? {} : { reason: reason.trim() }),
    path,
    line,
    severity: parseSeverity(record["severity"]),
  };
};

/**
 * One ruling, thrown on rather than dropped where it is malformed, as a
 * verification is: a drop without a reason would be a note lost with nothing
 * said, and the extraction retry is what gets the reason written.
 */
const parseNoteRuling = (value: unknown): NoteRuling => {
  const record = asRecord(value, "note ruling");
  const noteId = asString(record["noteId"] ?? record["note_id"] ?? record["id"], "note ruling noteId");
  const status = asString(record["status"], "note ruling status");
  if (status === "dropped") {
    return { noteId, status, reason: asString(record["reason"], "dropped note reason").trim() };
  }
  if (status !== "promoted") {
    throw new Error(`note ruling status must be "promoted" or "dropped", got "${status}"`);
  }
  const location = record["location"];
  return {
    noteId,
    status,
    severity: parseSeverity(record["severity"]),
    ...(typeof location === "string" && location.trim() !== "" ? { location: location.trim() } : {}),
  };
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
    // Read back off a payload, where the workflow wrote it. A model's answer
    // goes through this same door, and `recordFollowUps` replaces whatever it
    // carries.
    ...(typeof record["id"] === "string" && record["id"] !== "" ? { id: record["id"] } : {}),
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
 * `cappedWords` for prose whose line breaks are its shape: the summary is
 * Markdown, a sentence over a few bullets, and joining it on spaces would make
 * one paragraph of it. Cut at the last word kept, with everything before it
 * exactly as written.
 */
const cappedWordsKeepingLines = (text: string, limit: number): string => {
  const trimmed = text.trim();
  let count = 0;
  for (const word of trimmed.matchAll(/\S+/g)) {
    count += 1;
    if (count === limit) {
      const end = word.index + word[0].length;
      return end < trimmed.length ? `${trimmed.slice(0, end)}…` : trimmed;
    }
  }
  return trimmed;
};

/**
 * An HTML comment, taken out of what the review writes into a pull request's
 * title or body. It renders as nothing, so no reader loses a word, and the
 * block's own markers are comments: a summary carrying one would end the block
 * early, or start a second, on the next splice.
 */
const withoutComments = (text: string): string => text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");

/**
 * `title`, one line held to `MAX_TITLE_LENGTH` characters. Truncated rather
 * than refused, as `howChecked` is: a long title is not a broken review.
 */
const parseTitle = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const title = oneLine(withoutComments(value));
  if (title === "") return undefined;
  const chars = Array.from(title);
  return chars.length <= MAX_TITLE_LENGTH ? title : `${chars.slice(0, MAX_TITLE_LENGTH - 1).join("").trimEnd()}…`;
};

/**
 * `summary`, held to `MAX_SUMMARY_WORDS`.
 *
 * Lenient about its shape, because a summary is display and the review it
 * comes with carries the findings: a model that answers with the
 * `{ summary, changes }` object this field replaced has its sentence and its
 * lines kept, and anything else that is not a string is no summary rather than
 * a refused review.
 */
const parseSummary = (value: unknown): string | undefined => {
  let text: string | undefined;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const sentence = typeof record["summary"] === "string" ? record["summary"] : "";
    const changes = Array.isArray(record["changes"])
      ? record["changes"].filter((change): change is string => typeof change === "string")
      : [];
    text = [sentence, changes.map((change) => `- ${oneLine(change)}`).join("\n")]
      .filter((part) => part.trim() !== "")
      .join("\n\n");
  }
  if (text === undefined) return undefined;
  const summary = withoutComments(text).trim();
  return summary === "" ? undefined : cappedWordsKeepingLines(summary, MAX_SUMMARY_WORDS);
};

/**
 * **The one boundary a finding marker is stripped at** (`withoutFindingMarkers`).
 *
 * Every string below this line is the model's, and the whole output goes
 * through the strip before any of it is read — titles and bodies,
 * `assessment`, `howChecked`, `title`, `summary`, `needsYou`, a
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
  // `whatChanged` is the field `summary` replaced (#218), and a model prompted
  // for the new shape may still reach for the old one.
  const title = parseTitle(record["title"]);
  const summary = parseSummary(record["summary"] ?? record["whatChanged"] ?? record["what_changed"]);
  const noteRulings = asArray(
    record["noteRulings"] ?? record["note_rulings"] ?? [],
    "noteRulings",
  ).map(parseNoteRuling);
  const criteria = asArray(record["criteria"] ?? [], "criteria").map(parseCriterionRuling);
  const behaviourChanges = asArray(
    record["behaviourChanges"] ?? record["behaviorChanges"] ?? record["behaviour_changes"] ?? [],
    "behaviourChanges",
  ).flatMap(parseBehaviourChange);
  return {
    ...(assessment === undefined ? {} : { assessment }),
    ...(howChecked === undefined ? {} : { howChecked: cappedWords(howChecked, MAX_HOW_CHECKED_WORDS) }),
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
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
    // Absent on nearly every review, and left out of the output then, so a
    // review handed no notes reads exactly as it did before they existed. An
    // id this review was not handed is dropped by `applyNoteRulings`, for the
    // reason `verified` defers the same check.
    ...(noteRulings.length === 0 ? {} : { noteRulings }),
    // Absent where the review was handed no criteria, for the same reason.
    ...(criteria.length === 0 ? {} : { criteria }),
    // Absent on every review but a PRD PR's final review.
    ...(behaviourChanges.length === 0 ? {} : { behaviourChanges }),
  };
});

/**
 * A behaviour change, from an object or from a bare string (not breaking).
 * One that says nothing is dropped rather than failing the review: it is one
 * line of a description, and the findings beside it are worth more.
 */
const parseBehaviourChange = (value: unknown): BehaviourChange[] => {
  if (typeof value === "string") return value.trim() === "" ? [] : [{ change: oneLine(value), breaking: false }];
  const record = asRecord(value, "behaviour change");
  const change = typeof record["change"] === "string" ? oneLine(record["change"]) : "";
  return change === "" ? [] : [{ change, breaking: record["breaking"] === true }];
};

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
  cap: number = MAX_FOLLOW_UPS,
): { kept: FollowUp[]; dropped: number } => ({
  kept: followUps.slice(0, cap),
  dropped: Math.max(0, followUps.length - cap),
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
  "_Raised by the review as a problem to fix before merge, then moved here: it points at no file that pull request changed, so nothing in the change caused it and there was nowhere in the diff to comment on it._";

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
  /** The cap it was held to, written into the payload for the filing end to re-apply (#247). */
  readonly cap: number;
  /**
   * Whether earlier rounds' out-of-scope entries lead the capped half (#247),
   * so the cap drops the newest rather than the least serious.
   */
  readonly carried: boolean;
}

/**
 * One earlier round's recorded follow-ups, split where its payload's `moved`
 * splits them: the exempt prefix, and the out-of-scope rest.
 */
export interface EarlierFollowUps {
  readonly moved: readonly FollowUp[];
  readonly rest: readonly FollowUp[];
}

export interface RecordOptions {
  /** `followUpsCap` of the slices landed; `MAX_FOLLOW_UPS` where absent. */
  readonly cap?: number;
  /**
   * What every earlier round on the pull request recorded, oldest first, to
   * carry forward (#247). Only a PRD PR's review is handed any: there each
   * round is scoped to one slice, so no round restates another's, and the
   * newest review body is the one `follow-ups` files from.
   */
  readonly carried?: readonly EarlierFollowUps[];
  /** The id each new entry is given. A parameter so a test can name them. */
  readonly nextId?: () => string;
}

/**
 * Entries in order, each once: by id, or where an entry from before ids has
 * none, by being the same entry byte for byte, which is a copy and not a
 * rewording.
 */
export const dedupeFollowUps = (entries: readonly FollowUp[], seen: Set<string>): FollowUp[] =>
  entries.filter((entry) => {
    const key = entry.id ?? JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

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
 * So the list can run past the cap, and only ever by the number of findings
 * the diff gave no anchor to.
 *
 * **On a PRD PR, every earlier round's entries lead their half** (#247),
 * de-duplicated by id: the moved ones an earlier round kept stay exempt, and
 * its out-of-scope ones join this round's under the one cap, ahead of them, so
 * what the cap drops is the newest. The cap there is `followUpsCap` of the
 * slices landed, three per slice. Everything this round records gets a fresh
 * id, whatever the model wrote.
 *
 * `pathErrors` is the subset of `unanchored` whose path names no file — by
 * identity, as `pathErrors` returns them — and those carry `PATH_ERROR_NOTE`
 * instead of `MOVED_NOTE`.
 */
export const recordFollowUps = (
  unanchored: readonly Finding[],
  followUps: readonly FollowUp[],
  pathErrors: readonly Finding[] = [],
  options: RecordOptions = {},
): RecordedFollowUps => {
  const { cap = MAX_FOLLOW_UPS, carried = [], nextId = newFollowUpId } = options;
  const seen = new Set<string>();
  const moved = [
    ...dedupeFollowUps(carried.flatMap((earlier) => earlier.moved), seen),
    ...unanchored.map((finding) => ({ ...movedFollowUp(finding, pathErrors.includes(finding)), id: nextId() })),
  ];
  const earlierRest = dedupeFollowUps(carried.flatMap((earlier) => earlier.rest), seen);
  const rest = [...earlierRest, ...followUps.map((followUp) => ({ ...followUp, id: nextId() }))];
  const { kept, dropped } = capFollowUps(rest, cap);
  return { followUps: [...moved, ...kept], moved: moved.length, dropped, cap, carried: earlierRest.length > 0 };
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
): { followUps: FollowUp[]; dropped: number; moved: number; cut: number; cap: number } | undefined => {
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
  // The part of `dropped` cut to fit the body rather than by the cap (#140).
  // Absent wherever nothing was cut, which is every payload before it existed.
  // Clamped to `dropped` because it is a part of it.
  const count = typeof dropped === "number" && dropped > 0 ? Math.floor(dropped) : 0;
  const cut = record["cut"];
  // The cap the review held the list to (#247), which the filing end re-applies:
  // three per landed slice on a PRD PR. Absent on a payload written before it
  // was recorded, which is one capped at `MAX_FOLLOW_UPS`, and anything that is
  // not a whole number of at least that reads the same.
  const cap = record["cap"];
  return {
    followUps,
    cap: typeof cap === "number" && Number.isInteger(cap) && cap >= MAX_FOLLOW_UPS ? cap : MAX_FOLLOW_UPS,
    dropped: count,
    moved:
      typeof moved === "number" && moved > 0 ? Math.min(Math.floor(moved), followUps.length) : 0,
    cut: typeof cut === "number" && cut > 0 ? Math.min(Math.floor(cut), count) : 0,
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
 * A review body has a hard ceiling (`REVIEW_BODY_LIMIT`) whose overflow is a
 * 422 that takes the review's threads down with it, so the bodies live here and
 * the visible group carries titles alone — and `renderReviewBody` measures the
 * whole and cuts this list's tail, never its moved prefix, where nothing else
 * it can shed is enough.
 *
 * `moved` is the length of the exempt prefix (`recordFollowUps`), carried so the
 * cap the filing end re-applies bites on the same half this one capped. Without
 * it that second cap — a belt at the end holding `issues: write` — would cut a
 * list of four back to three and file nothing for the moved finding this end
 * deliberately kept. The field is additive and the version stays `1`: a reader
 * that has never heard of it reads `0` and caps exactly as it does today, where
 * a bump would make it refuse the block and file nothing at all.
 *
 * `cut` is how much of `dropped` the body's size took rather than the cap
 * (#140), so the merge comment names the right cause for each. Additive on the
 * same terms as `moved`, and written only where it is not zero, so a body that
 * fits carries the payload it always did. `dropped` stays the sum: a reader
 * that has never heard of `cut` still accounts for every entry, if under the
 * cap's name.
 *
 * `cap` is the cap the list was held to (#247), three per landed slice, so
 * the filing end re-applies the one this end applied rather than its own.
 * Additive on the same terms: a reader that has never heard of it caps at
 * three, which is every regular pull request's cap anyway.
 */
export const followUpsPayload = (
  kept: readonly FollowUp[],
  dropped: number,
  moved: number,
  cut = 0,
  cap: number = MAX_FOLLOW_UPS,
): string =>
  `<!-- ${FOLLOW_UPS_MARKER} ${embeddableJson({
    version: FOLLOW_UPS_VERSION,
    dropped,
    moved,
    cap,
    ...(cut > 0 ? { cut } : {}),
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
  titles = true,
  cap: number = MAX_FOLLOW_UPS,
  carried = false,
): string | undefined => {
  if (kept.length === 0) return undefined;

  // Badged but **not reordered** — see `FollowUp.severity`. The order is the
  // reviewer's, the cap drops from the end of it, and the index into it is half
  // the key a filing run recognises its own work by.
  //
  // Without titles only where the body had to shed them to fit (#140), and the
  // sentence above the record says so; the payload still carries every one.
  const items = titles
    ? kept.map(
        (f) => `- ${severityBadge(f.severity)} **${oneLine(f.title)}** · \`${oneLine(f.location)}\``,
      )
    : ["_Titles left out to fit the review body; every one counted here is still filed on merge._"];

  // Said here as well as after the merge, because this is the half that is
  // actionable: it reaches the author while the pull request is still open and
  // raising the dropped finding by hand is still cheap.
  //
  // *Out-of-scope* is load-bearing since the list can be longer than the cap: a
  // moved finding is exempt (`recordFollowUps`), so a sentence claiming only
  // three entries are listed would be false above four and would name the wrong
  // population for the loss either way.
  //
  // Without titles nothing is listed, and what is kept may be fewer than the
  // cap once the body's size has cut some too (#140) — so that case says only
  // what the cap did, and leaves what the size did to the shed sentence.
  //
  // Where earlier rounds' entries lead the list (#247), the cap drops the
  // newest whatever their severity, and the sentence says that instead: the
  // order is not re-ranked, so "most serious" would be a claim about it that
  // no longer holds.
  const newest = dropped === 1 ? "the newest was" : `the ${dropped} newest were`;
  const truncation =
    dropped === 0
      ? []
      : [
          "",
          carried
            ? titles
              ? `Only ${cap} out-of-scope findings are listed, earlier rounds' first; ${newest} dropped by the cap, whatever their severity. Raise them here if they matter.`
              : `The cap keeps ${cap} out-of-scope findings, earlier rounds' first; ${newest} dropped by it, whatever their severity. Raise them here if they matter.`
            : titles
              ? `Only the ${cap} most serious out-of-scope findings are listed; ${dropped} more were dropped by the cap. Raise them here if they matter.`
              : `The cap keeps the ${cap} most serious out-of-scope findings; ${dropped} more were dropped by it. Raise them here if they matter.`,
        ];

  return [
    "<details>",
    `<summary><b>Follow-ups</b> (${kept.length}) · filed as issues on merge; remove <code>${FOLLOW_UPS_LABEL}</code> to skip</summary>`,
    "",
    ...items,
    ...truncation,
    "",
    "</details>",
  ].join("\n");
};

/** How the body names each status, in the order the summary counts them. */
const CRITERION_STATUS: readonly [CriterionResult["status"], string, string][] = [
  ["met", "Met", "met"],
  ["changed", "Changed", "changed"],
  ["unmet", "Unmet", "unmet"],
  ["unchecked", "Not checked", "not checked"],
];

/**
 * The linked issue's acceptance criteria, one line each with what the review
 * said (#214), or `undefined` where there are none, so a pull request with no
 * linked issue or no criteria gets no section.
 *
 * In the issue's order rather than by status, because that is the order a
 * reader holding the issue checks them in. Expanded where any is not met: a
 * change or a gap is what a reader deciding whether to merge has to see, and
 * a list that is all *met* is the record's memory, folded like *Resolved*.
 *
 * An unmet one is also a finding, in *Open* with a thread to answer it on;
 * this list is the issue's view of the same pass, not a second count.
 */
export const renderCriteriaGroup = (
  criteria: readonly CriterionResult[],
  shorten = false,
): string | undefined => {
  if (criteria.length === 0) return undefined;
  const label = new Map(CRITERION_STATUS.map(([status, word]) => [status, word]));
  const counts = CRITERION_STATUS.map(([status, , word]) => ({
    word,
    count: criteria.filter((criterion) => criterion.status === status).length,
  }))
    .filter(({ count }) => count > 0)
    .map(({ word, count }) => `${count} ${word}`)
    .join(", ");
  const text = (value: string): string =>
    shorten ? shortened(oneLine(value), SHED_TITLE_LENGTH) : oneLine(value);
  const items = criteria.map(
    (criterion) =>
      `- **${label.get(criterion.status) ?? criterion.status}:** ${text(criterion.text)}` +
      (criterion.reason === undefined ? "" : ` · ${text(criterion.reason)}`),
  );
  const expanded = criteria.some((criterion) => criterion.status !== "met");
  return [
    `<details${expanded ? " open" : ""}>`,
    `<summary><b>Acceptance criteria</b> (${criteria.length}) · ${counts}</summary>`,
    "",
    ...items,
    "",
    "</details>",
  ].join("\n");
};

/** A criterion a round's record says was not met as written: changed on purpose, or unmet. */
export interface CriterionChange {
  readonly status: "changed" | "unmet";
  /** The criterion and its reason, as the record's line gives them. */
  readonly line: string;
}

/**
 * The criteria a review body's *Acceptance criteria* group lists as changed or
 * unmet, read back out of what `renderCriteriaGroup` wrote (#247): the final
 * review collects each slice round's record from it. `undefined` where the body
 * has no such group, which is a round that was handed no criteria.
 *
 * Beside the renderer because the two are one format.
 */
export const readCriteriaChanges = (body: string): CriterionChange[] | undefined => {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("<summary><b>Acceptance criteria</b>"));
  if (start < 0) return undefined;
  const changes: CriterionChange[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("</details>")) break;
    const match = /^- \*\*(Changed|Unmet):\*\* (.*)$/.exec(line);
    if (match !== null) {
      changes.push({ status: match[1] === "Changed" ? "changed" : "unmet", line: match[2] ?? "" });
    }
  }
  return changes;
};

/**
 * The fix run's out-of-scope notes this review decided not to file, each with
 * the reason (#213). A note the loop posted ends as a filed issue or as a
 * decision not to file one, and this group is where the second is recorded:
 * on the pull request, while raising it by hand is still cheap, and in the body
 * that is the round's record.
 *
 * Collapsed like the follow-ups beside it: neither counts against the merge.
 */
export const renderDroppedNotesGroup = (dropped: readonly DroppedNote[]): string | undefined => {
  if (dropped.length === 0) return undefined;
  const items = dropped.map(
    (note) =>
      `- **${oneLine(note.title)}**${note.url === undefined ? "" : ` ([note](${note.url}))`}: ${oneLine(note.reason)}`,
  );
  return [
    "<details>",
    `<summary><b>Notes from <code>agent:fix</code> not filed</b> (${dropped.length}) · out of scope, and judged not worth an issue</summary>`,
    "",
    ...items,
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
  cap: number = MAX_FOLLOW_UPS,
  carried = false,
): string => {
  const group = renderFollowUpsGroup(kept, dropped, true, cap, carried);
  const payload = followUpsPayload(kept, dropped, moved, 0, cap);
  return group === undefined ? payload : `${group}\n\n${payload}`;
};
