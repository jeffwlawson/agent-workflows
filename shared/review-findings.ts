import { randomUUID } from "node:crypto";
import { asRecord, asString } from "./common.js";

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

/** The marker as written. One format, one place it is spelled. */
export const findingMarker = (id: string): string => `<!-- ${FINDING_MARKER} ${id} -->`;

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
 * The label at the head of a body, past whatever emphasis it was written in.
 * `(?![A-Za-z0-9])` rather than `\b`, because the emphasis it is most often
 * written in ends in `_` — a word character, so `\b` refuses the very case
 * `__Fix before merge__` this has to read.
 */
const LABELLED = new RegExp(`^[\\s*_]*${FIX_BEFORE_MERGE_LABEL}(?![A-Za-z0-9])`, "i");

/**
 * Whether a finding is one this pull request must not merge without fixing.
 *
 * A predicate rather than the pattern, so the one description of what the label
 * looks like stays in this file: the verdict counts these and the body lists
 * them, and two readings of the same emphasis is how one of them starts
 * counting a finding the other does not.
 */
export const isFixBeforeMerge = (finding: Finding): boolean => LABELLED.test(finding.body);

/**
 * The claim a finding's body opens with: the label stripped, up to the first
 * line break.
 *
 * Up to the line break rather than the whole body, which is what keeps a
 * ```suggestion block out of the one-line surfaces this feeds. The body is
 * where the evidence and the fix live; a list wants the claim and a way to
 * reach the rest.
 */
export const openingClaim = (body: string): string => {
  const [opening = ""] = body.replace(LABELLED, "").split("\n");
  return opening.replace(/^[\s*_.:;,—–-]+/, "").trim();
};

/** One line, so a model that wrapped a title cannot break the entry it heads. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * A body entry's heading: where it is, then what it is. The title is dropped
 * where there is none to show rather than leaving a dangling dash — a finding
 * whose body was empty enough to yield no claim is still a finding, and the
 * anchor alone is a reader's way in.
 */
const headingOf = (entry: PlacedFinding): string => {
  const anchor = `\`${entry.finding.path}:${entry.finding.line}\``;
  const title = oneLine(entry.finding.title);

  return title === "" ? `**${anchor}**` : `**${anchor} — ${title}**`;
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
  `${placed.finding.body}\n\n${findingMarker(placed.id)}`;

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
 * The findings with no thread, rendered into the review body.
 *
 * `undefined` rather than an empty string when there are none, so the caller
 * composing the body drops the section rather than leaving a heading over
 * nothing — the same shape the checklist uses.
 *
 * The evidence is carried here in full, unlike the body's one-line checklist.
 * A threaded finding has somewhere else to keep it; this one does not, and a
 * list of anchors with no reasoning is a finding a reader cannot check.
 */
export const renderBodyFindings = (placed: readonly PlacedFinding[]): string | undefined => {
  const entries = placed.filter((p) => p.placement === "body");
  if (entries.length === 0) return undefined;

  return [
    "**Findings with no thread**",
    "",
    "Each is in a file this pull request does not change, so there is no diff line to anchor a thread to.",
    // The marker on its own line with a blank line either side: an HTML block
    // that ran into the heading under it would take the heading with it, and
    // the entry a reader sees is the half this is here to keep.
    ...entries.flatMap((entry) => ["", findingMarker(entry.id), "", headingOf(entry), "", entry.finding.body]),
  ].join("\n");
};

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
