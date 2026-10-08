/**
 * What the review runner hands `review:publish` (ADR 0007): three files of
 * decisions and raw text, described once, here. The types are what the runner
 * writes, and the parsers are what publish reads them with, so the two halves
 * of the format sit side by side the way a marker's writer and reader do.
 *
 * | File | Holds |
 * |---|---|
 * | `findings.json` | One entry per finding to post: id, placement, severity, title, the agent's text, path, line, and whether it was previously missed |
 * | `review_body.json` | The verdict and its cause, the agent's assessment, the open, resolved and missed entries, criteria results, follow-ups and their cap, red-test results, and the data behind the header and the round note |
 * | `thread_resolutions.json` | Per thread: id, reason, whether it was already replied to, and the agent's note or the maintainer's reply to quote |
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
import type { RedTestsRecord } from "../shared/red-check.js";
import type { HandedFinding } from "../shared/review-findings.js";
import type { ReviewBodyHandOver } from "../shared/review-output.js";
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
 * The most of each list a hand-over may carry. Far past any review this loop
 * has posted, and there so that a runner gone wrong is refused before it
 * writes rather than half way through.
 */
export const MAX_FINDINGS = 200;
export const MAX_RESOLUTIONS = 200;
const MAX_ENTRIES = 500;
const MAX_FOLLOW_UPS = 200;

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
        verdict: choice(["approval recommended", "changes recommended", "needs a closer look"]),
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
        redTests: optional(
          object({
            known: YES_NO,
            red: list(object({ name: text, classname: text, file: optional(text) }), { max: MAX_ENTRIES }),
            more: NUMBER,
          }),
        ),
      }),
    ),
    "thread_resolutions.json": json(list(resolution, { max: MAX_RESOLUTIONS })),
  } satisfies Readonly<Record<string, Parser<unknown>>>;
};
