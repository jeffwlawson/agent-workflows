import { randomUUID } from "node:crypto";
import { asRecord, asString } from "./common.js";

/**
 * How bad a finding is, for **display and ordering and nothing else** (#109,
 * decision 9).
 *
 * It is deliberately not a fourth verdict input: `deriveVerdict` never reads
 * it, and a test permutes every finding's severity and holds the verdict
 * identical. The reason is the one that retired *judgement call* in #96 — a
 * dial the model turns decides the outcome, and every review then has to be
 * read to find out which way it was turned. What severity buys instead is a
 * reader's eye: three high findings and one low read differently from four of
 * each, and the list is sorted so the first one they meet is the worst.
 *
 * **Low is a real but small defect, never a nit.** The bar for posting anything
 * at all has not moved: a preference, a "consider…", a rename the reviewer
 * would accept being overruled on is still not posted, at any severity. A
 * severity that meant "I was not sure this was worth saying" would be that bar
 * quietly reopened.
 */
export type Severity = "high" | "medium" | "low";

/** Worst first, which is both the display order and the sort key below. */
export const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];

/**
 * What a finding is rated when the model said nothing, or said something this
 * does not recognise.
 *
 * The middle, not the top and not the bottom. This is display, so the failure
 * to avoid is a default that *says* something: `high` would make every
 * unlabelled finding shout, and `low` would bury one. Losing the review over a
 * missing severity is out of the question for the reason a missing title does
 * not lose it either.
 */
export const DEFAULT_SEVERITY: Severity = "medium";

const isSeverity = (value: string): value is Severity =>
  (SEVERITIES as readonly string[]).includes(value);

/** Any casing the model reaches for, and `DEFAULT_SEVERITY` for anything else. */
export const parseSeverity = (value: unknown): Severity => {
  if (typeof value !== "string") return DEFAULT_SEVERITY;
  const normalised = value.trim().toLowerCase();
  return isSeverity(normalised) ? normalised : DEFAULT_SEVERITY;
};

/**
 * The badge as written: **text, never an image**.
 *
 * GitHub serves severity chips as assets on its own domain, and hotlinking one
 * puts a third-party request — and a dead image on the day the URL moves — into
 * a body that has to stay readable for as long as the pull request exists
 * (#109, decision 9). A code span renders as a chip in every GitHub surface
 * and in a plain-text reader alike.
 */
export const severityBadge = (severity: Severity): string =>
  `\`${severity.charAt(0).toUpperCase()}${severity.slice(1)}\``;

/**
 * Worst first, and **stable** within a severity: the order the review produced
 * its findings in is the order it thought about them, and nothing here knows
 * better. An entry with no severity at all sorts last — those are the
 * restatement lines the record falls back to, which carry no finding to rate.
 */
export const severityRank = (severity: Severity | undefined): number =>
  severity === undefined ? SEVERITIES.length : SEVERITIES.indexOf(severity);

/**
 * One problem the review found in this pull request, as the model produced it.
 *
 * Called a *finding* rather than an inline comment because where it is posted
 * is no longer part of what it is (#110). The model says what is wrong and
 * where in the source it is; `placeFindings` below decides whether that becomes
 * a line thread, a file-level thread or an entry in the review body, and the
 * model is told nothing about which.
 */
export interface Finding {
  /**
   * One line, as it appears in a list of what is open. Short enough to scan
   * beside a dozen others — the evidence stays in `body`.
   *
   * Always present after parsing: a model that omitted one gets the claim its
   * body opens with, because a title is display and losing the whole review
   * over a missing one would cost far more than it is worth.
   */
  readonly title: string;
  readonly path: string;
  /** Last line of the range — the only line when `startLine` is absent. */
  readonly line: number;
  /**
   * First line of a multi-line range. Needed when a ```suggestion block
   * replaces more than one line: GitHub applies the suggestion to exactly
   * `startLine..line`, so a stale sentence spanning two lines cannot be fixed
   * from a single-line anchor.
   */
  readonly startLine?: number;
  readonly body: string;
  /**
   * Always present after parsing, defaulted rather than required — see
   * `DEFAULT_SEVERITY`. Read by the record's ordering and by nothing that
   * decides anything.
   */
  readonly severity: Severity;
}

/**
 * Where a finding is posted, decided here from the diff.
 *
 * Three values, and the reason there are three is that **none of them is
 * "nowhere"**. What this replaced was a filter: an anchor outside the diff
 * hunks was dropped before posting, because one unresolvable anchor makes
 * GitHub reject the entire review. That guard is still here — it is the `file`
 * and `body` arms — but it now reroutes the finding instead of deleting it, so
 * a review can no longer count a finding toward its verdict and post no record
 * of what it was.
 */
export type Placement =
  /** Anchored in a hunk (or its context lines): a thread on the line. */
  | "line"
  /** In a file the pull request changes, past its hunks: a thread on the file. */
  | "file"
  /** In a file the pull request never touches: an entry in the review body. */
  | "body";

export interface PlacedFinding {
  /**
   * The finding's identity, written here and never by the model — a later
   * review reads it back off the thread rather than matching the text, which is
   * the only way a finding can survive being reworded.
   */
  readonly id: string;
  readonly placement: Placement;
  readonly finding: Finding;
}

/**
 * What a reader selects a finding's id on, and nothing more than that. The
 * marker is a **selector, not a control**, exactly as the follow-ups block's
 * is: anyone who can comment can type one, so whatever reads this establishes
 * that the thread is the loop's own by who opened it.
 */
export const FINDING_MARKER = "agent-finding";

/**
 * The marker as written. One format, one place it is spelled.
 *
 * The severity rides along with the id because it has nowhere else to survive a
 * round. A finding's severity is the model's, written once by the review that
 * raised it; the rounds after that read the finding back off the thread as an
 * id and one line of text, so without this the record would show a badge on
 * what this round found and nothing on what it carried — and the sort that puts
 * the worst first would be sorting half a list.
 *
 * Written by the workflow, exactly as the id is, and read back by
 * `parseFindingMarkers`. It is omitted where there is none to write — a marker
 * from a release before this one, re-emitted — and a reader defaults those, so
 * an old body stays readable rather than becoming a parse failure.
 */
export const findingMarker = (id: string, severity?: Severity): string =>
  `<!-- ${FINDING_MARKER} ${id}${severity === undefined ? "" : ` ${severity}`} -->`;

/**
 * A fresh id, unrelated to the finding's text or its place in the list.
 *
 * Random rather than derived, for both halves of "stable for the life of the
 * finding". Derived from the text, it would change the moment a round reworded
 * the finding — which is the case identity exists for. Derived from the
 * position, two different findings in two rounds would share one id, which is
 * worse: a later review would read a thread as being about something it is not.
 * Carrying an id **forward** across rounds is reading it off the thread, not
 * recomputing it.
 */
export const newFindingId = (): string => `f-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

/**
 * The label every *fix before merge* finding opens with, exactly as the prompt
 * and the extraction brief spell it. A fixed token, read as one — the verdict's
 * count looks for it at the start of a finding's body and nowhere else, because
 * reading the summary for findings is the prose-parsing that derivation exists
 * to replace.
 */
export const FIX_BEFORE_MERGE_LABEL = "Fix before merge";

/**
 * The label a finding carries when it is a real problem this pull request
 * introduced *and an earlier review of it already read that code* (#109,
 * decision 4).
 *
 * It counts as *fix before merge* exactly like the label above — which is the
 * decision, and the thing that makes it worth a second spelling rather than a
 * sentence in the prose. A missed finding says the review record was wrong
 * about this pull request, and that is a stronger reason to stop the merge
 * than an ordinary finding, not a weaker one. Before #111 the round-2 prompt
 * sent these to `followUps`, where they were filed after the merge they should
 * have stopped (`docs/parity.md` §10).
 */
export const PREVIOUSLY_MISSED_LABEL = "Previously missed";

/**
 * A label at the head of a body, past whatever emphasis it was written in.
 * `(?![A-Za-z0-9])` rather than `\b`, because the emphasis it is most often
 * written in ends in `_` — a word character, so `\b` refuses the very case
 * `__Fix before merge__` this has to read.
 */
const labelled = (label: string): RegExp => new RegExp(`^[\\s*_]*${label}(?![A-Za-z0-9])`, "i");

const MISSED = labelled(PREVIOUSLY_MISSED_LABEL);
const LABELS = [labelled(FIX_BEFORE_MERGE_LABEL), MISSED] as const;

/** The punctuation and emphasis a label leaves behind it. */
const LEADING = /^[\s*_.:;,—–-]+/;

/**
 * Whether a finding is one this pull request must not merge without fixing.
 *
 * A predicate rather than the pattern, so the one description of what the label
 * looks like stays in this file: the verdict counts these and the body lists
 * them, and two readings of the same emphasis is how one of them starts
 * counting a finding the other does not.
 *
 * **Either label answers yes.** A *previously missed* finding is a
 * fix-before-merge finding with a second thing said about it, so a body that
 * carries only that label is still counted — which is what stops the decision
 * resting on the model also remembering to write the first one.
 */
export const isFixBeforeMerge = (finding: Finding): boolean =>
  LABELS.some((label) => label.test(finding.body));

/** Whether an earlier review had already read the code this finding is about. */
export const isPreviouslyMissed = (finding: Finding): boolean => MISSED.test(finding.body);

/**
 * The claim a finding's body opens with: the labels stripped, up to the first
 * line break.
 *
 * Up to the line break rather than the whole body, which is what keeps a
 * ```suggestion block out of the one-line surfaces this feeds. The body is
 * where the evidence and the fix live; a list wants the claim and a way to
 * reach the rest.
 *
 * Stripped in a loop rather than once, because a finding may carry both labels
 * and in either order — `**Fix before merge — previously missed.**` is the
 * shape the prompt asks for and `**Previously missed.**` is the shape a model
 * reaches for, and a single pass over the first would leave the second in the
 * one-line surfaces this feeds.
 */
export const openingClaim = (body: string): string => {
  const [opening = ""] = body.split("\n");

  let claim = opening.replace(LEADING, "");
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const label of LABELS) {
      const next = claim.replace(label, "");
      if (next !== claim) {
        claim = next.replace(LEADING, "");
        stripped = true;
      }
    }
  }
  return claim.trim();
};

/**
 * Every finding id written into a body, with the line each one labels.
 *
 * The **reader** of `findingMarker`, and here rather than beside its callers
 * for the reason `parseFollowUpsBlock` sits beside its renderer: the marker and
 * the text it selects are one format, and a parser living with the half that
 * reads it is a second description of that format, drifting on the release that
 * changes either.
 *
 * One rule covers both places a marker is written, which is what keeps it one
 * format: **the entry is the rest of the marker's own line, or the next
 * non-empty line where the marker sits alone.** A body finding's marker is
 * written on its own line above the heading it introduces; a carried finding
 * with no thread of its own is written at the end of the checklist line it
 * belongs to.
 *
 * Deliberately not a parse of the *whole* entry. What a later review needs off
 * an earlier body is the id — which is identity — and one line a human can read
 * beside it. The evidence stays where it was posted.
 */
export interface MarkedEntry {
  readonly id: string;
  /**
   * The rating the review that raised it gave it, where the marker carries one.
   * Absent for a marker written before severities existed, which the reader
   * defaults rather than refusing — see `findingMarker`.
   */
  readonly severity?: Severity;
  /** The line the marker labels, stripped of its list marker and emphasis. */
  readonly text: string;
}

/**
 * The id, then optionally the severity. The severity is matched against the
 * three words rather than as another `\S+`, so a marker this version does not
 * understand loses the trailing token rather than the id — identity is the half
 * that must survive a format it has not met.
 */
const MARKER = new RegExp(`<!--\\s*${FINDING_MARKER}\\s+(\\S+?)(?:\\s+(high|medium|low))?\\s*-->`);

/** A checklist's own furniture, which is the list's rather than the entry's. */
const LIST_ITEM = /^[-*]\s+(\[[ xX]\]\s+)?/;

export const parseFindingMarkers = (body: string): MarkedEntry[] => {
  const lines = body.split("\n");

  return lines.flatMap((line, index) => {
    const match = line.match(MARKER);
    const id = match?.[1];
    if (id === undefined) return [];
    const severity = match?.[2];

    const onItsLine = line.replace(MARKER, "").trim();
    const text =
      onItsLine === ""
        ? (lines.slice(index + 1).find((later) => later.trim() !== "") ?? "").trim()
        : onItsLine;

    return [
      {
        id,
        ...(severity === undefined ? {} : { severity: parseSeverity(severity) }),
        text: text.replace(LIST_ITEM, "").replace(/^\*\*|\*\*$/g, "").trim(),
      },
    ];
  });
};

const positiveInt = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
};

/**
 * A finding as the model emitted it. Any `id` it wrote is dropped here by
 * having nowhere to go — the identity is the workflow's, and one the model
 * invented would be matched against a thread it never opened.
 */
export const parseFinding = (value: unknown): Finding => {
  const record = asRecord(value, "finding");
  const line = positiveInt(record["line"], "finding line");

  const rawStart = record["startLine"] ?? record["start_line"];
  let startLine: number | undefined;
  if (rawStart !== undefined && rawStart !== null) {
    startLine = positiveInt(rawStart, "finding startLine");
    if (startLine > line) {
      throw new Error("finding startLine must be <= line");
    }
    // A one-line "range" is just a single-line anchor; GitHub rejects
    // start_line == line, so normalise it away rather than fail the review.
    if (startLine === line) startLine = undefined;
  }

  const body = asString(record["body"] ?? record["comment"], "finding body");
  const rawTitle = record["title"];
  const title = typeof rawTitle === "string" && rawTitle.trim() !== "" ? rawTitle : openingClaim(body);

  return {
    title,
    path: asString(record["path"] ?? record["file"], "finding path"),
    line,
    ...(startLine === undefined ? {} : { startLine }),
    body,
    severity: parseSeverity(record["severity"]),
  };
};

/**
 * Where each finding goes, and what it is called. The placement is read off the
 * diff the review was given; the id is assigned here.
 *
 * `nextId` is a parameter so a test can name the ids it then asserts on. It is
 * the only non-deterministic thing in this file, and defaulting it keeps the
 * runner's call to the two things it actually decides.
 */
export const placeFindings = (
  findings: readonly Finding[],
  diffLines: Map<string, Set<number>>,
  nextId: () => string = newFindingId,
): PlacedFinding[] =>
  findings.map((finding) => ({
    id: nextId(),
    placement: placementOf(finding, diffLines),
    finding,
  }));

const placementOf = (finding: Finding, diffLines: Map<string, Set<number>>): Placement => {
  const fileLines = diffLines.get(finding.path);
  // Not a file this pull request touches, so there is no thread of any kind to
  // hang it on — GitHub will not open one against a file that is not in the
  // diff. The body is the only surface left.
  if (!fileLines) return "body";

  // Every line of a range must be in a hunk, not just the end of it: GitHub
  // rejects the whole review over any one of them.
  const from = finding.startLine ?? finding.line;
  for (let line = from; line <= finding.line; line++) {
    if (!fileLines.has(line)) return "file";
  }
  return "line";
};

/**
 * One thread as `addPullRequestReview` takes it. A file-level thread is the
 * same object with **no `line` at all** — not a null and not a zero, which are
 * both rejected.
 */
export interface ReviewThread {
  readonly path: string;
  readonly line?: number;
  readonly startLine?: number;
  readonly side?: "RIGHT";
  readonly startSide?: "RIGHT";
  readonly body: string;
}

/**
 * The thread text: the finding as the model wrote it, then its id.
 *
 * The marker goes at the **end**. A finding's body opens with its label and its
 * claim — which is what a reader's eye lands on and what the body's checklist
 * reads back — and a hidden comment ahead of it displaces both for no gain.
 */
const threadBody = (placed: PlacedFinding): string =>
  `${placed.finding.body}\n\n${findingMarker(placed.id, placed.finding.severity)}`;

/** The threads the mutation carries — every placed finding except the body ones. */
export const reviewThreads = (placed: readonly PlacedFinding[]): ReviewThread[] =>
  placed
    .filter((p) => p.placement !== "body")
    .map((p) =>
      p.placement === "file"
        ? { path: p.finding.path, body: threadBody(p) }
        : {
            path: p.finding.path,
            line: p.finding.line,
            side: "RIGHT" as const,
            // startLine/startSide turn the anchor into a range, which is what
            // makes a multi-line ```suggestion replace all of it rather than
            // just the last line. Omitted entirely for a single line — GitHub
            // rejects startLine == line.
            ...(p.finding.startLine === undefined
              ? {}
              : { startLine: p.finding.startLine, startSide: "RIGHT" as const }),
            body: threadBody(p),
          },
    );

/**
 * The mutation, in the shape the GraphQL endpoint takes a request body in.
 *
 * GraphQL rather than `POST /pulls/{n}/reviews`, for the one thing REST cannot
 * do: a **file-level** thread in the same call as the review (#109, decision 5
 * — REST review-create answers that with a 422, and its `comments` field is
 * deprecated in favour of `threads` besides).
 *
 * `commitOID` pins the review to the head that was reviewed, so a push that
 * lands while the agent is running does not silently move what the threads are
 * anchored against. `event: COMMENT` because the verdict is a commit status,
 * not an approval — see `VERDICTS` in `shared/review-output.ts`.
 *
 * The `url` selection is the review's own, and the response to this call is the
 * only place it exists; the commit status links it.
 */
export const ADD_REVIEW_MUTATION = `mutation($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) {
    pullRequestReview { url }
  }
}`;

export const reviewMutation = (parts: {
  readonly pullRequestId: string;
  readonly commitOID: string;
  readonly body: string;
  readonly placed: readonly PlacedFinding[];
}): {
  query: string;
  variables: {
    input: {
      pullRequestId: string;
      commitOID: string;
      event: "COMMENT";
      body: string;
      threads: ReviewThread[];
    };
  };
} => ({
  query: ADD_REVIEW_MUTATION,
  variables: {
    input: {
      pullRequestId: parts.pullRequestId,
      commitOID: parts.commitOID,
      event: "COMMENT",
      body: parts.body,
      threads: reviewThreads(parts.placed),
    },
  },
});
