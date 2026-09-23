import { asArray, asRecord, asString, standardSchema } from "./common.js";
import {
  findingMarker,
  isFixBeforeMerge,
  isPreviouslyMissed,
  openingClaim,
  parseFinding,
  parseSeverity,
  severityBadge,
  severityRank,
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

export interface ReviewOutput {
  readonly summary: string;
  /**
   * Every problem the review found in this pull request, as the model produced
   * them. Where each one is posted — a line thread, a file-level thread or an
   * entry in the body — is decided from the diff by `placeFindings`, not here
   * and not by the model (#110).
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
   * The heading the posted review body opens with, and the front of the status
   * description. Copilot code review's own wording, so it is recognised rather
   * than learned — which is why it is a literal here rather than composed from
   * the key beside it.
   *
   * Shared by the two *changes recommended* rows: what differs between those is
   * the step, not the assessment.
   */
  readonly heading: string;
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
   * behind the heading, because a status has one line and no formatting.
   */
  readonly nextStep: string;
  /**
   * What GitHub shows beside the status: `<heading>. <nextStep>`, written out
   * rather than composed, so the line a maintainer reads is in this table
   * verbatim. A test holds it equal to the two halves above, and holds it under
   * GitHub's 140-character limit — which truncates where the character ran out
   * rather than where the sentence ends.
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
    state: "success",
    nextStep: "Ready to merge. Nothing left to fix; any follow-ups are filed as issues when you merge.",
    description:
      "🟢 Approval recommended. Ready to merge. Nothing left to fix; any follow-ups are filed as issues when you merge.",
  },
  "changes recommended": {
    verdict: "changes recommended",
    heading: "🟡 Changes recommended",
    state: "failure",
    nextStep:
      "Add agent:fix. The fixes are clear, so no need to read them first. A re-review runs automatically.",
    description:
      "🟡 Changes recommended. Add agent:fix. The fixes are clear, so no need to read them first. A re-review runs automatically.",
  },
  // Same assessment, a different step: the fix round that was supposed to
  // settle these has already run. So the line stops promising an automatic
  // re-review and asks for the decision first.
  "changes recommended after a fix round": {
    verdict: "changes recommended after a fix round",
    heading: "🟡 Changes recommended",
    state: "failure",
    nextStep:
      "A fix round did not settle these. Read the review, then reply with your decision and add agent:fix.",
    description:
      "🟡 Changes recommended. A fix round did not settle these. Read the review, then reply with your decision and add agent:fix.",
  },
  "needs a closer look": {
    verdict: "needs a closer look",
    heading: "🔵 Needs a closer look",
    state: "failure",
    nextStep:
      "A fix round cannot settle this. Read the review, then reply with your decision or close the PR.",
    description:
      "🔵 Needs a closer look. A fix round cannot settle this. Read the review, then reply with your decision or close the PR.",
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
}

/**
 * How many findings this pull request must not merge without fixing.
 *
 * The **larger** of the two places a finding is recorded, not the count of the
 * list alone. The model is asked to put every one of them in both, so either
 * can be the one it forgot — and a finding labelled `**Fix before merge.**` in
 * a finding body but missing from `fixBeforeMerge` derives *approval
 * recommended*, which is the unsafe direction for the one signal meant to be
 * acted on without reading.
 *
 * Larger rather than the sum, because the two are restatements of one set of
 * findings: adding them would double-count every review that did as it was
 * asked.
 *
 * **This review's own findings, and not the ones it carried.** What an earlier
 * review left open is verified rather than re-found (#111) and reaches the
 * verdict through `VerdictInputs.stillOpen`; counting it here as well would
 * make every still-open finding worth two.
 *
 * Counted over the findings **as produced**, independently of where each one
 * was placed. Placement is the workflow's decision and it can no longer lose a
 * finding (#110), but the count must not depend on it either way: what a review
 * found and where GitHub would let it be posted are two different questions.
 */
export const countFixBeforeMerge = (output: ReviewOutput): number =>
  Math.max(output.fixBeforeMerge.length, labelledFindings(output).length);

/** The findings that carry the label, in the order the model produced them. */
const labelledFindings = (output: ReviewOutput): readonly Finding[] =>
  output.findings.filter(isFixBeforeMerge);

/**
 * One line of the review's record: what the finding is, how bad, where, and
 * whether this round is the one that found it (#109, decision 8).
 *
 * Four of its five fields are optional because the record holds three
 * populations that know different amounts about themselves. A finding this
 * review produced knows its severity, its anchor and — where GitHub has
 * nowhere to thread it — its whole evidence. A finding **carried** from an
 * earlier review knows the one line that review wrote and the severity that
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
   * finding with no thread. That asymmetry is the whole of what makes the body
   * a record rather than a rendering: a threaded finding's thread is its
   * record, and a second copy in the body is one a maintainer cannot close by
   * resolving the thread.
   *
   * Never on a resolved entry, for the same reason in the other direction: an
   * id written back would carry a closed finding into the next round.
   */
  readonly id?: string;
  /** Whether this review is the one that raised it — rendered as *new*. */
  readonly isNew: boolean;
  /**
   * The finding in full, for an entry with no thread to keep it on. A list of
   * anchors with no reasoning is a finding a reader cannot check (#110), and
   * this is the only surface that one has.
   */
  readonly evidence?: string;
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
   * `missed`. Never less than what `deriveVerdict` counted — see
   * `restatedEntries` for the one case where it is more.
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

  return {
    title: oneLine(title),
    severity: placed.finding.severity,
    anchor: `${placed.finding.path}:${placed.finding.line}`,
    // A thread carries both of these already; the body is the only surface a
    // finding in an untouched file has.
    ...(placed.placement === "body" ? { id: placed.id, evidence: placed.finding.body } : {}),
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
 * The `fixBeforeMerge` lines, recorded as entries when — and only when — the
 * list is longer than the findings it restates (#105).
 *
 * The count takes the larger of the two, so the case this exists for is a
 * finding the model wrote into the list and left out of `findings`: without
 * this the verdict would say *changes recommended* over a record showing fewer
 * findings than it counted, and the next round would verify against the
 * shorter one.
 *
 * **All of them, not the ones the findings left out.** The list restates the
 * same findings in the model's own words, and telling which line restates which
 * finding is the prose-matching this derivation exists to avoid. A finding
 * written down twice costs a reader a moment; one written down nowhere is the
 * failure this is here to remove — and it is why `ReviewRecord.findings` can
 * exceed the verdict's count but never fall short of it.
 *
 * Badge-less and anchor-less on purpose: a restatement is a line of prose, and
 * a severity invented for it would be this file rating a finding.
 */
const restatedEntries = (
  output: ReviewOutput,
  labelled: readonly PlacedFinding[],
): RecordEntry[] =>
  output.fixBeforeMerge.length > labelled.length
    ? output.fixBeforeMerge.map((line) => ({ title: oneLine(line), isNew: true }))
    : [];

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
  const labelled = parts.placed.filter((placed) => isFixBeforeMerge(placed.finding));
  const missed = labelled.filter((placed) => isPreviouslyMissed(placed.finding));
  const fresh = labelled.filter((placed) => !isPreviouslyMissed(placed.finding));

  const open = worstFirst([
    ...fresh.map(placedEntry),
    ...parts.stillOpen.map((finding) => carriedEntry(finding, true)),
    ...restatedEntries(parts.output, labelled),
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
 * it is new, and — where nothing else records it — its id.
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
    entry.title,
    entry.anchor === undefined ? undefined : `— \`${entry.anchor}\``,
    entry.isNew ? "*new*" : undefined,
    entry.id === undefined ? undefined : findingMarker(entry.id, entry.severity),
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");

/**
 * The evidence under an entry that has one, indented so it stays inside the
 * list item it belongs to — including a ```suggestion or any other fence the
 * finding carried.
 */
const evidenceBlock = (evidence: string): string[] =>
  ["", ...evidence.split("\n").map((line) => (line.trim() === "" ? "" : `  ${line}`))];

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
 */
const renderGroup = (
  title: string,
  entries: readonly RecordEntry[],
  expanded: boolean,
): string | undefined => {
  if (entries.length === 0) return undefined;

  // Said once per group rather than once per entry: an entry quoted in full is
  // one GitHub would not let a thread be opened for, and a reader who does not
  // know that reads the inconsistency as a bug.
  const note = entries.some((entry) => entry.evidence !== undefined)
    ? ["", "A finding quoted in full has no thread: it is in a file this pull request does not change."]
    : [];

  const lines = entries.flatMap((entry) =>
    entry.evidence === undefined
      ? [entryLine(entry)]
      : [entryLine(entry), ...evidenceBlock(entry.evidence), ""],
  );
  // A quoted entry leaves a blank line after it so the next one starts a fresh
  // item; the last one would leave a gap above the closing tag instead.
  while (lines[lines.length - 1] === "") lines.pop();

  return [
    `<details${expanded ? " open" : ""}>`,
    `<summary><b>${title}</b> — ${entries.length}</summary>`,
    ...note,
    "",
    ...lines,
    "",
    "</details>",
  ].join("\n");
};

/** Because "1 findings are open" is the sentence a reader stops trusting. */
const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

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
 * The body as it is posted: the findings record decision 8 describes, in one
 * fixed order, and the one place that order is written down.
 *
 * The order is Copilot code review's own overview, which is the point — a
 * maintainer who has read one of those already knows where to look. The
 * assessment, then one sentence saying what is unresolved, then the step in
 * italics, then the count, then the three groups, then what the change does,
 * then the run that produced all of it.
 *
 * Three parts sit between the step and the count and are not in decision 8's
 * list, because they qualify the assessment rather than the record: `needsYou`
 * is why another pass will not settle it, and it reached the derivation and
 * nobody else until #105; the round note is how the round was established, and
 * is a fact about the run rather than about the change. Both belong above the
 * count, where a reader meets them before deciding what the count means.
 *
 * What this replaced was a flat checklist of `fixBeforeMerge` lines with no
 * severity, no order, and no memory: a finding resolved since the last round
 * vanished with nothing saying it ever existed, and a finding the last round
 * missed read exactly like one it had never seen. The record is the same
 * information with the rounds kept in it.
 *
 * A function rather than a dozen lines in the runner, because this is the part
 * of the review a human acts on and the runner is a script with no test around
 * it.
 */
export const renderReviewBody = (parts: {
  /**
   * The row the derivation chose. The body opens with its heading and then its
   * next step — the same two halves the commit status carries as one line, so
   * the two surfaces cannot say different things — and the heading is *not*
   * repeated inside the step, which is why the status's `description` is not
   * what is rendered here.
   */
  readonly verdict: VerdictRow;
  /** The review as the agent produced it, which is what the verdict was derived from. */
  readonly output: ReviewOutput;
  /** The note a round that could not be established carries; see `shared/review-round.ts`. */
  readonly roundNote?: string | undefined;
  /**
   * The findings with their placements, from `placeFindings`. The ones GitHub
   * has nowhere to thread are quoted in full here, with the id the workflow
   * gave them (#110) — the body is the only surface a finding in an untouched
   * file has, and before this it had none at all.
   *
   * Required rather than defaulted to empty, for the reason `round` is: the
   * wrong default is the one with no symptom. A caller that forgot this posts a
   * body with a finding missing from it and nothing saying so.
   */
  readonly placed: readonly PlacedFinding[];
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
   * The run that produced this review. Optional — it is a link, and a review
   * that could not name its own run is still a review — so a caller outside
   * Actions renders a body without one rather than failing.
   */
  readonly runUrl?: string | undefined;
}): string => {
  const record = reviewRecord(parts);

  return [
    `### ${parts.verdict.heading}`,
    unresolvedSentence(record),
    `_${parts.verdict.nextStep}_`,
    parts.output.needsYou,
    parts.roundNote,
    `**Findings:** ${record.findings}`,
    renderGroup("Open", record.open, true),
    renderGroup("Resolved since last review", record.resolved, false),
    renderGroup("Previously missed", record.missed, true),
    parts.output.summary === "" ? undefined : `**What changed in this PR**\n\n${parts.output.summary}`,
    parts.runUrl === undefined ? undefined : `_Posted by [this workflow run](${parts.runUrl})._`,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join("\n\n");
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
  // open. Added rather than maximised, unlike the two halves inside
  // `countFixBeforeMerge`: those are two restatements of one set of findings,
  // and these are two disjoint sets — one this review found, one it verified.
  if (countFixBeforeMerge(output) + inputs.stillOpen > 0) {
    // **A round-2 review can never produce the round-1 row** (#96, decision 5),
    // and it is enforced here rather than asked of the prompt. The fix round
    // has already run and already pushed; findings that survived it are
    // findings a second one has no more reason to settle than the first, and
    // the loop's one bound is that a fix cannot ask for another fix. A prompt
    // line would leave that bound to a model's judgement about its own output.
    //
    // The two rows share a heading and differ in the step, which is where the
    // bound lives: the round-1 line promises an automatic re-review, and the
    // round-2 line asks the maintainer to read the review and reply first. The
    // key differs too, so the automatic fix PRD #101 describes can fire on the
    // round-1 case and on nothing else.
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

export const reviewOutputSchema = standardSchema<ReviewOutput>((value) => {
  const record = asRecord(value, "review output");
  const needsYou = optionalReason(record["needsYou"] ?? record["needs_you"], "needsYou");
  return {
    summary: asString(record["summary"], "summary"),
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
 */
export const capFollowUps = (
  followUps: readonly FollowUp[],
): { kept: FollowUp[]; dropped: number } => ({
  kept: followUps.slice(0, MAX_FOLLOW_UPS),
  dropped: Math.max(0, followUps.length - MAX_FOLLOW_UPS),
});

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
): { followUps: FollowUp[]; dropped: number } | undefined => {
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
  return {
    followUps: asArray(record["followUps"] ?? [], "followUps").map(parseFollowUp),
    dropped: typeof dropped === "number" && dropped > 0 ? Math.floor(dropped) : 0,
  };
};

/**
 * The block appended to the review body: one `<details>`, two readers.
 *
 * Visible and collapsed, because an opt-out the author cannot see is not an
 * opt-out — and the question it asks of them (*do I want these filed?*) is
 * answered by the titles alone. The bodies live only in the payload: a review
 * body has a hard 65,536-character ceiling whose overflow is a 422 that takes
 * the review's threads down with it, so the full stub text is not spent twice.
 *
 * **A run that recorded none writes the payload and nothing else** — the bare
 * comment, no `<details>`, invisible to a reader. That empty list is the
 * *retraction*, and it is why this is called on every review rather than only
 * on the ones with something to say: the reader takes the latest list, so a
 * round that records nothing has to be able to say so. Without it a round 2
 * that found the out-of-scope defect fixed leaves round 1's block standing as
 * the newest, and the merge files a stub for the thing the author just fixed.
 *
 * No `<details>` around it because there is nothing to offer: no finding to
 * show, and no opt-out to describe. An empty disclosure widget on every review
 * is how a channel teaches people to stop opening it.
 */
export const renderFollowUpsBlock = (kept: readonly FollowUp[], dropped: number): string => {
  const payload = embeddableJson({
    version: FOLLOW_UPS_VERSION,
    dropped,
    followUps: kept,
  });
  const marker = `<!-- ${FOLLOW_UPS_MARKER} ${payload} -->`;
  if (kept.length === 0) return marker;

  // Badged but **not reordered** — see `FollowUp.severity`. The order is the
  // reviewer's, the cap drops from the end of it, and the index into it is half
  // the key a filing run recognises its own work by.
  const items = kept.map(
    (f) => `- ${severityBadge(f.severity)} **${oneLine(f.title)}** — \`${oneLine(f.location)}\``,
  );

  // Said here as well as after the merge, because this is the half that is
  // actionable: it reaches the author while the pull request is still open and
  // raising the dropped finding by hand is still cheap.
  const truncation =
    dropped === 0
      ? []
      : [
          "",
          `Only the ${MAX_FOLLOW_UPS} most serious are listed; ${dropped} more were dropped by the cap. Raise them here if they matter.`,
        ];

  return [
    "<details>",
    `<summary>${kept.length} out-of-scope finding${kept.length === 1 ? "" : "s"} recorded to file when this pull request merges — remove the <code>${FOLLOW_UPS_LABEL}</code> label to skip them</summary>`,
    "",
    ...items,
    ...truncation,
    "",
    marker,
    "</details>",
  ].join("\n");
};
