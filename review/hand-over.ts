/**
 * What the review runner hands `review:publish` (ADR 0007): five files of
 * decisions and raw text, described once, here. The types are what the runner
 * writes, and the parsers are what publish reads them with, so the two halves
 * of the format sit side by side the way a marker's writer and reader do.
 *
 * | File | Holds |
 * |---|---|
 * | `findings.json` | One entry per finding to post: id, placement, severity, title, the agent's text, path, line, and whether it was previously missed |
 * | `review_body.json` | The verdict and its cause, the agent's assessment, the open, resolved and missed entries, criteria results, follow-ups and their cap, red-test results, and the data behind the header and the round note |
 * | `thread_resolutions.json` | Per thread: id, reason, whether it was already replied to, and the agent's note or the maintainer's reply to quote |
 * | `pr_summary.json` | The title, the agent's summary, whether the round is final, and the data behind Evidence and merge danger. Written only where this review rewrites them |
 * | `verdict.json` | The verdict's key, whether it starts a fix round, and how many findings it leaves open |
 *
 * None of them holds a marker, a status context or a commit. Every marker is
 * publish's to write, every free-text field comes out of these parsers
 * cleaned, every target is checked against what publish read from GitHub
 * itself, and every other field is a choice or a count of a fixed shape
 * (`shared/hand-over.ts`).
 */
import {
  choice,
  count,
  filePath,
  json,
  list,
  matching,
  object,
  optional,
  refine,
  target,
  text,
  type Parser,
} from "../shared/hand-over.js";
import type { MergeDanger } from "../shared/merge-danger.js";
import type { SliceCriteria } from "../shared/prd-round.js";
import type { EvidenceCheck, RedTestsRecord, SliceRedTests } from "../shared/red-check.js";
import type { HandedFinding } from "../shared/review-findings.js";
import type { CiResult, ReviewBodyHandOver, TestSketch, Verdict } from "../shared/review-output.js";
import type { ThreadResolution } from "../shared/review-verification.js";
import type { RoundScope } from "../shared/round-header.js";

/** `findings.json`: the findings to open a thread for, in the order the runner placed them. */
export type Findings = readonly HandedFinding[];

/**
 * `review_body.json`: the body's half of the hand-over, and the data behind
 * the three parts publish formats before it renders the body. The header is
 * the round's scope and number (#298), the round note the reason the history
 * could not be read, and the red tests a slice round's record of them (#235).
 */
export interface ReviewBody extends ReviewBodyHandOver {
  readonly header?: { readonly scope: RoundScope; readonly number: number } | undefined;
  readonly historyUnreadable?: string | undefined;
  readonly redTests?: RedTestsRecord | undefined;
}

/** `thread_resolutions.json`: the threads this review closed, and why. */
export type ThreadResolutions = readonly ThreadResolution[];

/**
 * `pr_summary.json`: the title and the summary block as this review would have
 * them (#218), written only where it rewrites them. The agent's own words, and
 * the data publish lays the rest of the block out from: the Evidence (#355)
 * and the Merge Danger (#356). No marker and no commit: the block's markers,
 * its head mark and the final review's mark are publish's, and the head is
 * `REVIEWED_SHA`.
 *
 * A regular pull request's, or a slice round's of a PRD of one slice, carries
 * the red check as the Evidence reads it, `redCheck`; the final review's
 * carries each slice's records instead, `prd` (#235, #247), as
 * `renderPrdSummary` takes them.
 */
export type PrSummary = PrSummaryText &
  (
    | { readonly final: true; readonly prd: PrdRecords }
    | { readonly final: false; readonly redCheck: EvidenceCheck }
  );

/** What every `pr_summary.json` carries, the final review's or not. */
export interface PrSummaryText {
  readonly title?: string | undefined;
  /** The agent's summary, or on the final review its outcome. Absent where it wrote none. */
  readonly summary?: string | undefined;
  /** CI's result at the head, the Evidence's After. */
  readonly ci: CiResult;
  readonly testSketches: readonly TestSketch[];
  readonly danger: MergeDanger;
}

/**
 * The final review's per-slice records: `criteria` absent where the PRD branch
 * could not be read, and `redTests` absent where the red check is off, its
 * `slices` absent where the branch could not be read.
 */
export interface PrdRecords {
  readonly criteria?: readonly SliceCriteria[] | undefined;
  readonly redTests?: { readonly slices?: readonly SliceRedTests[] | undefined } | undefined;
}

/**
 * `verdict.json`: the verdict's key, whether the review asked for an
 * automatic fix round (#297), and how many findings it leaves open, for the
 * status line (#298). Never a context, a state or a description: those are
 * publish's own (`VERDICT_CONTEXT`, `FIX_ROUND_STATUS` and the verdict table),
 * so the agent's runner can claim a verdict but not name a status.
 */
export interface VerdictHandOver {
  readonly verdict: Verdict;
  readonly fixRound: boolean;
  readonly open: number;
}

/**
 * The most of each list a hand-over may carry. Far past any review this loop
 * has posted, and there so that a runner gone wrong is refused before it
 * writes rather than half way through.
 */
export const MAX_FINDINGS = 200;
export const MAX_RESOLUTIONS = 200;
const MAX_ENTRIES = 500;
const MAX_FOLLOW_UPS = 200;
/** The red check's tests: the ones a pull request adds or changes, which a run lists in full. */
const MAX_TESTS = 10_000;
const MAX_SLICES = 1_000;

const SEVERITY = choice(["high", "medium", "low"]);
const YES_NO = choice([true, false]);
const LINE = count({ min: 1, max: 10_000_000 });
const NUMBER = count({ min: 0, max: 1_000_000 });
const SLICE = count({ min: 1, max: 1_000 });
const ISSUE = count({ min: 1, max: 1_000_000_000 });

/**
 * An id a marker carries, a finding's or a follow-up's: no whitespace, no `<`
 * and no `>`, so it cannot end the comment it is written into.
 */
const ID = matching(/[A-Za-z0-9._:-]{1,100}/, "an id of letters, digits, dots, colons, underscores and hyphens");
const CRITERION_ID = matching(/[A-Za-z0-9._-]{1,20}/, "a criterion id");
const LINK = matching(/https?:\/\/[^\s<>()]+/, "a link");
const LOGIN = matching(/[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?/, "a GitHub login");
/** A commit the red check names, shown in the Evidence and never written to. */
const SHA = matching(/[0-9a-f]{7,64}/, "a commit id");
/** The red check's `status`: a word the job writes, and the Evidence names one it does not know. */
const STATUS = matching(/[a-z][a-z-]{0,40}/, "a red check status");
const VERDICT = choice(["approval recommended", "changes recommended", "needs a closer look"]);

/** What publish checks the targets against: what it read from GitHub itself. */
export interface Known {
  readonly pr: number;
  /** The node id of every review thread on the pull request. */
  readonly threads: ReadonlySet<string>;
}

const finding = refine(
  object({
    id: ID,
    placement: choice(["line", "file"]),
    severity: SEVERITY,
    title: text,
    body: text,
    path: filePath,
    line: LINE,
    startLine: optional(LINE),
    previouslyMissed: YES_NO,
  }),
  (f, wrong): HandedFinding =>
    f.startLine !== undefined && f.startLine >= f.line ? wrong(`starts at line ${f.startLine}, not before its last line, ${f.line}`) : f,
);

const entry = {
  title: text,
  severity: optional(SEVERITY),
  anchor: optional(text),
  id: optional(ID),
  url: optional(LINK),
  isNew: YES_NO,
};

const followUp = object({ title: text, location: text, body: text, severity: SEVERITY, id: optional(ID) });

const header = refine(
  object({
    scope: object({
      kind: choice(["slice", "final", "regular"]),
      k: optional(SLICE),
      n: optional(SLICE),
      subIssue: optional(ISSUE),
    }),
    number: count({ min: 1, max: 10_000 }),
  }),
  ({ scope, number }, wrong): NonNullable<ReviewBody["header"]> => {
    if (scope.kind !== "slice") {
      return scope.k === undefined && scope.n === undefined && scope.subIssue === undefined
        ? { scope: { kind: scope.kind }, number }
        : wrong("names a slice's place on a round that is not a slice round");
    }
    const { k, n, subIssue } = scope;
    return k === undefined || n === undefined || subIssue === undefined
      ? wrong("is a slice round's, and does not name the slice's place in full")
      : { scope: { kind: "slice", k, n, subIssue }, number };
  },
);

const redTestsRecord = object({
  known: YES_NO,
  red: list(object({ name: text, classname: text, file: optional(text) }), { max: MAX_ENTRIES }),
  more: NUMBER,
});

/**
 * The red check as the Evidence reads it. Its tests' names and messages are the
 * pull request's to write, so they are text, read cleaned like the agent's.
 */
const redCheck = refine(
  object({
    kind: choice(["not-configured", "unreadable", "ran"]),
    reason: optional(text),
    report: optional(
      object({
        status: STATUS,
        base: optional(SHA),
        head: optional(SHA),
        slice: optional(ISSUE),
        tests: list(
          object({
            name: text,
            classname: text,
            file: optional(text),
            result: choice(["red", "broken", "passed"]),
            message: optional(text),
          }),
          { max: MAX_TESTS },
        ),
      }),
    ),
  }),
  ({ kind, reason, report }, wrong): EvidenceCheck => {
    if (kind === "not-configured") return reason === undefined && report === undefined ? { kind } : wrong("is off, and carries a reason or a report");
    if (kind === "unreadable") {
      return reason !== undefined && report === undefined ? { kind, reason } : wrong("is unreadable, and carries no reason, or a report");
    }
    if (report === undefined || reason !== undefined) return wrong("ran, and carries no report, or a reason");
    const { base, head, ...rest } = report;
    return { kind, report: { ...rest, base: base ?? null, head: head ?? null } };
  },
);

const sliceCriteriaRecord = refine(
  object({
    kind: choice(["recorded", "none checked", "no record"]),
    changes: optional(list(object({ status: choice(["changed", "unmet"]), line: text }), { max: MAX_ENTRIES })),
  }),
  ({ kind, changes }, wrong): SliceCriteria["record"] => {
    if (kind === "recorded") return changes === undefined ? wrong("is recorded, and lists no changes") : { kind, changes };
    return changes === undefined ? { kind } : wrong(`is ${kind}, and lists changes`);
  },
);

/** A slice with no record of its red tests is listed with none, which the Evidence says. */
const prdRecords = refine(
  object({
    criteria: optional(list(object({ subIssue: ISSUE, record: sliceCriteriaRecord }), { max: MAX_SLICES })),
    redTests: optional(
      object({ slices: optional(list(object({ subIssue: ISSUE, record: optional(redTestsRecord) }), { max: MAX_SLICES })) }),
    ),
  }),
  ({ criteria, redTests }): PrdRecords => ({
    ...(criteria === undefined ? {} : { criteria }),
    ...(redTests === undefined
      ? {}
      : { redTests: redTests.slices === undefined ? {} : { slices: redTests.slices.map(({ subIssue, record }) => ({ subIssue, record })) } }),
  }),
);

const prSummary = refine(
  object({
    title: optional(text),
    summary: optional(text),
    final: YES_NO,
    ci: choice(["green", "red", "unknown"]),
    testSketches: list(object({ test: text, sketch: text }), { max: MAX_ENTRIES }),
    danger: object({
      door: optional(choice(["one-way", "two-way"])),
      doorNote: optional(text),
      blastRadius: optional(text),
      blastRadiusNote: optional(text),
      breaking: optional(list(text, { max: MAX_ENTRIES })),
    }),
    redCheck: optional(redCheck),
    prd: optional(prdRecords),
  }),
  ({ final, redCheck, prd, ...text }, wrong): PrSummary => {
    if (final) {
      return redCheck === undefined && prd !== undefined
        ? { ...text, final, prd }
        : wrong("is the final review's, and carries the red check rather than each slice's records");
    }
    if (text.title === undefined && text.summary === undefined) return wrong("carries neither a title nor a summary");
    return prd === undefined && redCheck !== undefined
      ? { ...text, final, redCheck }
      : wrong("is not the final review's, and carries each slice's records rather than the red check");
  },
);

/**
 * A fix round is claimed only on *changes recommended*, the one verdict that
 * can start one (#201): a claim on any other is refused rather than posted.
 * Whether one starts is still the live guard's and the budget's, after publish.
 */
const verdict = refine(
  object({ verdict: VERDICT, fixRound: YES_NO, open: count({ min: 0, max: MAX_ENTRIES * 2 }) }),
  (v, wrong): VerdictHandOver => (v.fixRound && v.verdict !== "changes recommended" ? wrong(`claims a fix round on ${v.verdict}`) : v),
);

/**
 * The parser for each file, with every target held to `known`. Each thread id
 * a resolution or a resolved entry names has to be a review thread on this
 * pull request, so no hand-over can aim a reply or a resolve elsewhere.
 */
export const handOverParsers = (known: Known) => {
  const thread = target(known.threads, `a review thread on PR #${known.pr}`);
  const resolution = refine(
    object({
      threadId: thread,
      reason: choice(["ADDRESSED", "WONT_FIX"]),
      alreadyReplied: YES_NO,
      note: optional(text),
      maintainerReply: optional(object({ login: LOGIN, body: text })),
    }),
    ({ threadId, alreadyReplied, ...r }, wrong): ThreadResolution => {
      if (r.reason === "ADDRESSED") {
        return r.maintainerReply === undefined
          ? { threadId, alreadyReplied, reason: r.reason, ...(r.note === undefined ? {} : { note: r.note }) }
          : wrong("carries a maintainer reply on a thread closed as fixed");
      }
      if (r.maintainerReply === undefined) return wrong("closes a thread as WONT_FIX with no maintainer reply to quote");
      return r.note === undefined
        ? { threadId, alreadyReplied, reason: r.reason, maintainerReply: r.maintainerReply }
        : wrong("carries a note on a thread a maintainer declined, where the reply is theirs");
    },
  );
  return {
    "findings.json": json(list(finding, { max: MAX_FINDINGS })),
    "review_body.json": json(
      object({
        verdict: VERDICT,
        cause: optional(choice(["needs you", "red", "unknown"])),
        assessment: optional(text),
        needsYou: optional(text),
        howChecked: optional(text),
        open: list(object(entry), { max: MAX_ENTRIES }),
        missed: list(object(entry), { max: MAX_ENTRIES }),
        resolved: list(object({ ...entry, threadId: optional(thread) }), { max: MAX_ENTRIES }),
        movedToFollowUps: NUMBER,
        followUps: list(followUp, { max: MAX_FOLLOW_UPS }),
        droppedFollowUps: NUMBER,
        followUpsCap: NUMBER,
        followUpsCarried: YES_NO,
        droppedNotes: list(object({ title: text, reason: text, url: optional(LINK) }), { max: MAX_ENTRIES }),
        criteria: list(
          object({ id: CRITERION_ID, text, status: choice(["met", "changed", "unmet", "unchecked"]), reason: optional(text) }),
          { max: MAX_ENTRIES },
        ),
        header: optional(header),
        historyUnreadable: optional(text),
        redTests: optional(redTestsRecord),
      }),
    ),
    "thread_resolutions.json": json(list(resolution, { max: MAX_RESOLUTIONS })),
    "pr_summary.json": json(prSummary),
    "verdict.json": json(verdict),
  } satisfies Readonly<Record<string, Parser<unknown>>>;
};
