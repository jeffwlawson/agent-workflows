import { randomUUID } from "node:crypto";
import { asRecord, asString } from "./common.js";
import { unquotePath } from "./diff-lines.js";
import { PACKAGE_NAME, VERSION } from "./manifest.js";
import { FINDING_MARKER, RESOLUTION_MARKER } from "./record.js";

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

/** The one word a severity is written as, shared by both badges below. */
export const severityWord = (severity: Severity): string =>
  `${severity.charAt(0).toUpperCase()}${severity.slice(1)}`;

/**
 * The badge for a surface that must render **no image**: a code span,
 * `` `Medium` ``.
 *
 * One surface needs it, and it is not a review surface — the `**Severity:**`
 * line of an issue the follow-ups workflow files after the merge (#135). That
 * body is handed to an implement agent verbatim as its task and outlives the
 * pull request whose review rated it — and a pinned URL outlives nothing by
 * accident, so the one surface that is read after the release it names is the
 * one that carries the word instead. It is also the fallback below, for a runner
 * that cannot say which version it is.
 *
 * It sits beside `severityBadge` rather than in the filing module so the two
 * renderings share one word per severity. Two spellings of *Medium* is the
 * drift this is one module to avoid.
 */
export const severityTextBadge = (severity: Severity): string => `\`${severityWord(severity)}\``;

/**
 * Where the chips live, relative to the repository root — and **the one copy of
 * that path**, read by the URL below and by the test that holds the three files
 * to it.
 *
 * Renaming or moving one of these files is an invariant with no runtime symptom
 * in this repository: every review body and every thread of every past release
 * names the file at the tag it was posted under, so the break shows up in
 * somebody else's pull request from a year ago and nowhere in the build.
 */
export const severityAssetPath = (severity: Severity): string =>
  `assets/severity-${severity}.svg`;

/** `@owner/repo` as npm spells it → `owner/repo`, as a raw asset URL does. */
const REPO_SLUG = PACKAGE_NAME.replace(/^@/, "");

/**
 * Whether this runner can say who and what version it is — which is what the
 * image URL is built out of, so a runner that cannot is one that would name a
 * tag like `vunknown` and render a broken image. It renders the text badge
 * instead: a plain word is a worse chip and a far better failure.
 */
const IDENTIFIED = VERSION !== "unknown" && PACKAGE_NAME !== "unknown";

/**
 * Tag-pinned, and that is the whole of why an image is allowed here at all: the
 * URL names a tag rather than a branch, so what a body written today points at
 * is immutable. Built from the manifest rather than written down, so it is not a
 * nineteenth site `scripts/sync-version.ts` has to rewrite — and a runner that
 * posts a review is always a released version, so its tag always exists.
 */
const severityAssetUrl = (severity: Severity): string =>
  `https://raw.githubusercontent.com/${REPO_SLUG}/v${VERSION}/${severityAssetPath(severity)}`;

/**
 * The badge every **review** surface renders: a tinted pill image, self-hosted
 * and tag-pinned (#135).
 *
 * #109 decision 9 ruled an image out, and what it ruled out was a *hotlink*:
 * GitHub serves its own severity chips off its own domain, so a body that has to
 * stay readable for as long as the pull request exists would carry a dead image
 * the day that URL moved. Chips drawn for this repository and served from a tag
 * of it remove that, and are drawn rather than copied because redistributing
 * GitHub's assets from a public repository other people adopt is a licensing
 * risk.
 *
 * What it costs is recorded in `docs/ADOPTING.md`: an adopter's review bodies
 * load an image from this repository, so making it private, renaming it or
 * deleting it leaves every past review showing the alt text.
 *
 * **Wrapped in `<picture>`**, because GitHub links a bare `<img>` to its own
 * image URL, so the chip would read as a clickable link; inside `<picture>` it
 * renders as the inline chip it is, as GitHub's own severity chips do. There is
 * no dark `<source>`: the chips are a translucent tint over a mid-tone colour,
 * legible on either theme, so a second set of files would only be a second thing
 * to keep in step.
 *
 * **The alt text is the word**, which is what keeps the picture from being the
 * only copy: a notification email that blocks images, and every reader that
 * turns a body or a thread into prompt text for an agent
 * (`withSeverityBadgesAsText`), gets `Medium`.
 */
export const severityBadge = (severity: Severity): string =>
  IDENTIFIED
    ? `<picture><img src="${severityAssetUrl(severity)}" height="18" alt="${severityWord(severity)}" align="top"></picture>`
    : severityTextBadge(severity);

/**
 * The image badge wherever it appears in a string, matched on **the asset path
 * and not the whole tag**: the tag carries the release it was written under, so
 * an exact string only ever recognises the badges of the version doing the
 * reading.
 */
const SEVERITY_IMAGE =
  /(?:<picture>\s*)?<img\b[^>]*assets\/severity-(high|medium|low)\.svg[^>]*>(?:\s*<\/picture>)?/gi;

/** Just the head of one, for the readers that strip an opening badge. */
const OPENING_SEVERITY_IMAGE =
  /^(?:<picture>\s*)?<img\b[^>]*assets\/severity-(?:high|medium|low)\.svg[^>]*>(?:\s*<\/picture>)?/i;

const altOf = (tag: string): string | undefined => /\balt="([^"]*)"/i.exec(tag)?.[1];

/**
 * Every badge image in a string reduced to its alt text — what a reader that
 * renders **no images** should be handed (#135).
 *
 * Every agent in this loop is one: a review body and an inline thread reach the
 * fix agent and the next round's reviewer as prompt text, and an `<img>` tag
 * passed through spends a line of it on a URL and says the severity nowhere a
 * model is reading. The alt is the word, so this is lossless.
 *
 * Applied where text is rendered *for an agent* rather than where it is read
 * off GitHub, because the same text has a second reader that needs the tag
 * intact: `carriedClaim` strips this file's own badge off a carried entry, and
 * a badge already reduced to a bare `Medium` is one it could only strip by
 * eating a claim that opens with the word.
 */
export const withSeverityBadgesAsText = (text: string): string =>
  text.replace(SEVERITY_IMAGE, (tag: string, severity: string) =>
    altOf(tag) ?? severityWord(severity as Severity),
  );

/**
 * A badge this loop wrote for **this** severity, taken off the head of a line —
 * in every form a release of it has written one: the image, the bold code span
 * of the decision the image superseded, and the plain code span v0.4.0 and
 * v0.5.0 bodies carry.
 *
 * Three forms because a body entry is read back out of the last review that
 * wrote it, which may be any earlier release (#127, decision 5): a form this
 * does not recognise is an entry that collects a second badge every round it
 * stays open.
 *
 * **This severity's badge and not any badge.** The caller knows what the entry
 * is rated, and a looser rule would eat the opening of a claim that
 * legitimately quotes another rating — `` `Low` is not a place for
 * preferences`` is a claim somebody reviewing this codebase will eventually
 * make.
 */
export const withoutSeverityBadge = (text: string, severity: Severity): string => {
  const word = severityWord(severity);
  const forms = [
    `(?:<picture>\\s*)?<img\\b[^>]*assets\\/severity-${severity}\\.svg[^>]*>(?:\\s*<\\/picture>)?`,
    `(?:<picture>\\s*)?<img\\b[^>]*\\balt="${word}"[^>]*>(?:\\s*<\\/picture>)?`,
    `\\*\\*\`${word}\`\\*\\*`,
    `\`${word}\``,
  ];
  return text.replace(new RegExp(`^(?:${forms.join("|")})\\s*`, "i"), "");
};

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
 * a line thread or a file-level thread — or, where the diff does not reach it
 * at all, a follow-up — and the model is told nothing about which.
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
 * Two values, and **both of them are on the diff** (#127, decision 1). A
 * fix-before-merge finding is a claim about this pull request, so there is
 * always a changed place to attach it to — a line the diff covers, or, where
 * the diff covers no such line, the changed file itself. The `body`
 * arm that used to sit under these is gone: a finding posted where GitHub can
 * open no thread is one a maintainer cannot reply to, cannot decline and
 * cannot resolve, and one of those could hold a pull request at *Changes
 * recommended* for ever (#124).
 *
 * What replaced it is not the filter that came before either. An anchor in a
 * file this pull request never touches does not go nowhere: it goes to
 * `followUps`, by `placeFindings` below, and the review body says so.
 */
export type Placement =
  /** Anchored in a hunk (or its context lines): a thread on the line. */
  | "line"
  /**
   * In a file the pull request changes, with no line in it the anchor can
   * take: a thread on the file. Past the hunks is one way to get here; the
   * other is a file with no new side to have hunks in — a deletion, a pure
   * rename, a binary change, a mode change — which `parseDiffLines` keys with
   * an empty set for exactly this arm to read.
   */
  | "file";

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
 *
 * The **title** rides along for the same reason (#134). A later round reads a
 * threaded finding back off its thread, where the only prose is the body, and
 * the record entry it renders wants the title the review that raised it wrote
 * — not the thread's opening paragraph. It is base64, because a title is the
 * model's prose and an HTML comment ends at the first `-->`: the alphabet holds
 * no `-` and no `>`, so nothing in a title can close the comment early or leave
 * half of it rendered. A marker written before this carries none, and a reader
 * falls back to the claim.
 */
export const findingMarker = (id: string, severity?: Severity, title?: string): string =>
  [
    `<!-- ${FINDING_MARKER} ${id}`,
    severity === undefined ? "" : ` ${severity}`,
    title === undefined || title === "" ? "" : ` title:${Buffer.from(title, "utf8").toString("base64")}`,
    " -->",
  ].join("");

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
 * and the extraction brief spell it.
 *
 * **Presentation, and not a criterion.** The brief still asks for it, because
 * it is the first thing a human reads on the thread — but nothing counts or
 * records a finding on the strength of it. By the design this builds on (#96,
 * decision 1) a finding is one of two kinds and `followUps` is the other, so
 * **every entry in `findings` is fix-before-merge by definition**. A predicate
 * over the label was a second definition of that, and the two disagreed: an
 * unlabelled finding was recorded where the body was its only surface and
 * counted nowhere, so a review could post *Approval recommended* over a
 * populated *Open* group — and an unlabelled one on a diff line got a thread
 * and an id, went uncounted in the round that raised it, and then counted
 * through `stillOpen` in every round after.
 */
export const FIX_BEFORE_MERGE_LABEL = "Fix before merge";

/**
 * The label a finding carries when it is a real problem this pull request
 * introduced *and an earlier review of it already read that code* (#109,
 * decision 4).
 *
 * It counts exactly as every other finding does, and it is read for one thing
 * only: which group of the record it lands in. That group is the decision, and
 * the thing that makes it worth a second spelling rather than a sentence in
 * the prose — a missed finding says the review record was wrong
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
 *
 * `#` and `>` are in the class for the drift a model actually produces —
 * `### Fix before merge` and `> **Fix before merge.**`. Nothing is counted or
 * dropped on this answer any more, so what refusing one of those costs is what
 * the two readers below are for: a *previously missed* finding filed under
 * *Open*, and a label left standing at the front of the one-line claim the
 * record shows. Both are display faults rather than lost findings, and both
 * are still worth not having.
 *
 * `·` is in it for a shape this file writes rather than one a model does:
 * `threadBody` opens a previously-missed thread `<badge> · Previously missed`,
 * and the reader that takes the badge off hands the rest of that line to this
 * (#135).
 */
const labelled = (label: string): RegExp =>
  new RegExp(`^[\\s*_#>·]*${label}(?![A-Za-z0-9])`, "i");

const MISSED = labelled(PREVIOUSLY_MISSED_LABEL);
const LABELS = [labelled(FIX_BEFORE_MERGE_LABEL), MISSED] as const;

/** The punctuation and emphasis a label leaves behind it. */
const LEADING = /^[\s*_#>.:;,·—–-]+/;

/**
 * Whether an earlier review had already read the code this finding is about.
 *
 * The one thing a label decides, and it decides a **group** rather than a
 * count: a previously-missed finding is listed under *Previously missed*
 * instead of *Open*, and counts toward the verdict either way. There is
 * deliberately no `isFixBeforeMerge` beside it — that predicate existed, and a
 * finding it did not recognise was a finding the verdict did not see.
 */
export const isPreviouslyMissed = (finding: Finding): boolean => MISSED.test(finding.body);

/**
 * A line's opening labels taken off, and **nothing else** — the half
 * `threadBody` uses, where what follows the label is a whole body rather than a
 * claim, so a leading `>` or `-` that no label put there is the model's own
 * formatting and stays.
 *
 * Stripped in a loop rather than once, because a finding may carry both labels
 * and in either order — `**Fix before merge — previously missed.**` is the
 * shape the prompt asks for and `**Previously missed.**` is the shape a model
 * reaches for, and a single pass over the first would leave the second in the
 * surfaces this feeds.
 */
const withoutLabels = (line: string): string => {
  let claim = line;
  let removed = false;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const label of LABELS) {
      const next = claim.replace(label, "");
      if (next !== claim) {
        claim = next.replace(LEADING, "");
        stripped = true;
        removed = true;
      }
    }
  }

  // The emphasis a label opened is closed *after* the claim where the model
  // wrote both in one span — `**Fix before merge. The guard runs late.**` — so
  // taking the label away leaves a `**` with nothing to pair with. Harmless
  // where this feeds a one-line surface that strips emphasis anyway, and two
  // literal asterisks on a thread, which posts what this returns verbatim.
  const dangling = removed && claim.endsWith("**") && (claim.split("**").length - 1) % 2 === 1;
  return dangling ? claim.slice(0, -2).trimEnd() : claim;
};

/**
 * And for a one-line surface, this file's own opening badge with them, plus
 * whatever decoration is left at the front.
 *
 * The badge is why this exists as a second reader (#135): `threadBody` opens a
 * thread with the severity chip, so a reader that stopped at the labels would
 * return an `<img>` tag as the finding's claim — and the record entry that tag
 * lands in is the one line a human scans the round by.
 */
const strippedOfLabels = (line: string): string =>
  withoutLabels(line.replace(OPENING_SEVERITY_IMAGE, "").replace(LEADING, "")).trim();

/**
 * A body with its opening label taken off and **everything else left alone** —
 * what a thread is posted with, now that the badge says what the label used to
 * (#135).
 *
 * The label is dropped rather than kept because on a thread it says nothing:
 * every entry in `findings` is fix-before-merge by definition
 * (`FIX_BEFORE_MERGE_LABEL`), so the one thing a reader could learn from the
 * opening was the severity, and the severity was in the marker where only this
 * loop could see it.
 *
 * The **line** goes with the label where stripping it leaves nothing, which is
 * what a model writing the label as a heading produces: `### Fix before merge`,
 * then a blank line, then the claim. `openingClaim` admits that shape, so this
 * has to as well — a thread opening on a blank line and a rule is a body that
 * looks truncated.
 *
 * Untouched where there was no label at all, rather than cleaned up: this
 * returns a whole body, and a strip that ran unconditionally would take the `>`
 * off a body the model chose to open with a quote.
 */
const withoutOpeningLabel = (body: string): string => {
  const lines = body.split("\n");
  const first = lines[0] ?? "";
  const stripped = withoutLabels(first);
  if (stripped === first) return body;

  const rest = lines.slice(1);
  if (stripped.trim() !== "") return [stripped, ...rest].join("\n");

  while (rest.length > 0 && (rest[0] ?? "").trim() === "") rest.shift();
  return rest.join("\n");
};

/**
 * The claim a finding's body opens with: the badge and the labels stripped, up
 * to the first line break.
 *
 * Up to the line break rather than the whole body, which is what keeps a
 * ```suggestion block out of the one-line surfaces this feeds. The body is
 * where the evidence and the fix live; a list wants the claim and a way to
 * reach the rest.
 *
 * And the **next** line where stripping leaves nothing — a label written as a
 * heading, or a thread of this loop's own, whose first line is the badge and
 * nothing else. A finding that counted toward the verdict and entered the
 * record as a blank line is the same silence with an extra step in it.
 */
export const openingClaim = (body: string): string => {
  const lines = body.split("\n");
  const claim = strippedOfLabels(lines[0] ?? "");
  if (claim !== "") return claim;

  return strippedOfLabels(lines.slice(1).find((line) => line.trim() !== "") ?? "");
};

/**
 * A finding's title as a record entry shows it: the model's, on one line, or
 * the claim its body opens with where it left the title empty — this is
 * display, and a blank line in a list is worse than a reworded one.
 *
 * One function because two surfaces write it: the record entry of the round
 * that raised the finding, and the thread's marker, which is where every later
 * round reads it back from (#134). Two derivations would let the same finding
 * carry two titles depending on which round listed it.
 */
export const findingTitle = (finding: Finding): string =>
  finding.title.replace(/\s+/g, " ").trim() || openingClaim(finding.body);

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
  /**
   * The finding's title as the review that raised it wrote it, where the marker
   * carries one — a thread's marker since #134. Absent on an older marker and
   * on a body entry's, which is itself the title.
   */
  readonly title?: string;
  /** The line the marker labels, stripped of its list marker and emphasis. */
  readonly text: string;
}

/**
 * The id, then optionally the severity, then optionally the title, then any
 * tokens this version does not know. The severity is matched against the three
 * words rather than as another `\S+`, and the unknown tail is matched and
 * dropped, so a marker a later release writes loses what this one cannot read
 * rather than the id — identity is the half that must survive a format it has
 * not met. The title is matched on the base64 alphabet `findingMarker` writes
 * it in.
 *
 * That holds from this release on, not before it: a release older than #134
 * has no tail and matches nothing on a marker carrying a title, so a runner
 * pinned back past it reads no finding off a thread this release wrote. A tail
 * token is any run of non-space that is not the comment's own close, so the
 * match still ends at the first `-->`.
 */
const MARKER = new RegExp(
  `<!--\\s*${FINDING_MARKER}\\s+(\\S+?)(?:\\s+(high|medium|low))?(?:\\s+title:([A-Za-z0-9+/]+=*))?(?:\\s+(?:(?!-->)\\S)+)*\\s*-->`,
);

/** A checklist's own furniture, which is the list's rather than the entry's. */
const LIST_ITEM = /^[-*]\s+(\[[ xX]\]\s+)?/;

/**
 * Every marker in a body — the one regex both halves below run on.
 *
 * That it is one regex is the guarantee rather than a tidiness: what the
 * stripper removes and what the reader recognises are the same set by
 * construction, so there is no marker a model can write that survives the
 * strip and is still read as an id.
 */
const EVERY_MARKER = new RegExp(MARKER.source, "g");

/**
 * Every **resolution** marker in a body, matched by name with whatever payload
 * follows it (#133).
 *
 * Deliberately wider than the reader in `shared/review-verification.ts`, which
 * accepts the two reasons and nothing else. The strip has to be a superset of
 * every reader of every marker in this family, or a payload one release does
 * not recognise is a payload the next one might — matching by name is what
 * makes that true without this file knowing the format. The direction is the
 * safe one in both halves: strip more than is read, read less than is written.
 */
const EVERY_RESOLUTION_MARKER = new RegExp(`<!--\\s*${RESOLUTION_MARKER}\\b[^>]*-->`, "g");

/**
 * A string with every marker this loop writes taken out of it.
 *
 * The prompt tells the model to write no identifier of any kind, and this is
 * the mechanical half of that instruction (`docs/parity.md` §10: a channel the
 * prompt bounds is also bounded mechanically). It is no longer a hypothetical
 * risk: the feedback surface renders live markers verbatim into the prompt, so
 * the model is shown the exact syntax and this round's real ids, and a string
 * that copied one would post a thread — or a body entry — carrying two, with a
 * later round unable to tell which finding it is about.
 *
 * The resolution marker is here for a sharper version of the same thing (#133).
 * A fix run's reply is posted into a review thread **by this same bot**, so a
 * reply that copied the marker off the closing reply it is answering would tell
 * the next review that thread already carries a closing reply — and the review
 * would then resolve it under the fixer's words, having posted no record of its
 * own. The marker is the record, so a model must not be able to write one.
 */
const withoutMarkers = (text: string): string =>
  text
    .replace(EVERY_MARKER, "")
    .replace(EVERY_RESOLUTION_MARKER, "")
    .replace(/[^\S\n]+$/gm, "");

/**
 * The same strip over **every string a model wrote**, wherever it sits in the
 * output — the one boundary, rather than a call per field.
 *
 * Field by field is how this was first done and how it failed: `body` was
 * stripped and `title` was not, and neither were `assessment`, `howChecked`,
 * `whatChanged` or a follow-up's three strings. A marker in any of them reached
 * the posted body intact, and one in `howChecked` was enough to turn a round's
 * *approval recommended* into the next round's *changes recommended* under a
 * fragment of the previous review's prose.
 *
 * So it walks the value rather than naming the fields: a field added later is
 * stripped without anyone remembering to, which is the property the per-field
 * version could not have. It runs on the **raw** output, before the parsers
 * below, so nothing downstream of a schema ever sees a marker it did not write
 * — including the fallbacks, like the title `parseFinding` derives from a body.
 *
 * A string whose whole content was a marker is left empty, and the parser that
 * wanted it refuses it exactly as it refuses an empty one. That is the right
 * reading: a field holding nothing but an identifier the model was told not to
 * write is a field it did not fill in.
 */
export const withoutFindingMarkers = (value: unknown): unknown => {
  if (typeof value === "string") return withoutMarkers(value);
  if (Array.isArray(value)) return value.map(withoutFindingMarkers);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        withoutFindingMarkers(entry),
      ]),
    );
  }
  return value;
};

/**
 * The **last** marker on a line, where it holds more than one.
 *
 * The workflow writes its own marker last — at the end of a thread body
 * (`threadBody`) and at the end of a record entry (`entryLine`) — so the last
 * one is this loop's and an earlier one is a marker the line quoted. Reading
 * the first lets a copied id displace the workflow's own, which is a thread
 * carrying an identity that belongs to another finding.
 *
 * One rule, in one place. The reader over a whole body (`lastFindingMarker`)
 * takes the last marker in it, and this takes the last on a line; a reader that
 * disagreed with this one on which of two markers counts would hand two halves
 * of this loop two different findings for one thread.
 */
const lastMarkerOn = (line: string): RegExpMatchArray | undefined => {
  const matches = [...line.matchAll(EVERY_MARKER)];
  return matches[matches.length - 1];
};

/**
 * A title read back off a marker, as one line. Decoded rather than trusted to
 * be one: anyone can write a marker, and a newline in what becomes a list
 * entry's link text breaks the list it sits in.
 */
const oneLineTitle = (encoded: string): string =>
  Buffer.from(encoded, "base64").toString("utf8").replace(/\s+/g, " ").trim();

export const parseFindingMarkers = (body: string): MarkedEntry[] => {
  const lines = body.split("\n");

  return lines.flatMap((line, index) => {
    const match = lastMarkerOn(line);
    const id = match?.[1];
    if (match === undefined || id === undefined) return [];
    const severity = match[2];
    const title = match[3] === undefined ? "" : oneLineTitle(match[3]);

    // Every marker off the line, not just the one that won: the text is what a
    // human reads beside the id, and a quoted marker left in it would be
    // rendered back into the next round's body as prose.
    const onItsLine = line.replace(EVERY_MARKER, "").trim();
    const text =
      onItsLine === ""
        ? (lines.slice(index + 1).find((later) => later.trim() !== "") ?? "").trim()
        : onItsLine;

    return [
      {
        id,
        ...(severity === undefined ? {} : { severity: parseSeverity(severity) }),
        ...(title === "" ? {} : { title }),
        text: text.replace(LIST_ITEM, "").replace(/^\*\*|\*\*$/g, "").trim(),
      },
    ];
  });
};

/**
 * The marker a body carries, or `undefined` for one that carries none — a
 * human's comment, a reply, or a review posted before ids existed.
 *
 * **The last**, by the rule `lastMarkerOn` states: the workflow writes its own
 * last, so an earlier one is quoted rather than assigned. Exported because it
 * is the only way anything outside this file should ask "which finding is this
 * body about" — `shared/pr-feedback.ts` had its own, and the two disagreed on a
 * line holding two markers, which is precisely the line the question matters on.
 */
export const lastFindingMarker = (body: string): MarkedEntry | undefined => {
  const markers = parseFindingMarkers(body);
  return markers[markers.length - 1];
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
 *
 * A marker it wrote into any **string** is already gone by the time this runs:
 * `withoutFindingMarkers` is applied to the whole output at the schema
 * boundary, for the reason above — having nowhere to go is not a guard where
 * the id can be smuggled in as prose. Deliberately not re-stripped here. This
 * used to be the one field that stripped, and the four that did not were the
 * hole; a second call would say the rule is a field's to remember, which is
 * how the first four came to forget it.
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
 * The findings split by whether this pull request gives them anywhere to hang.
 *
 * Two lists rather than one with a third placement on it, because the two
 * halves leave by different doors: `placed` is posted as threads and counted
 * toward the verdict, and `unanchored` is not posted at all — it becomes a
 * follow-up, filed when the pull request merges.
 */
export interface PlacedFindings {
  readonly placed: PlacedFinding[];
  /**
   * The findings whose `path` is in no hunk of this diff because it is in no
   * file of it, under any spelling `diffKeyOf` recognises — nothing this pull
   * request changed causes them, so by #127 decision 3 they are not this pull
   * request's to fix before merge.
   *
   * They carry no id: an id exists so a later round can recognise a finding it
   * has already raised, and these are never raised. A follow-up's identity is
   * the issue that gets filed for it.
   */
  readonly unanchored: Finding[];
}

/**
 * Where each finding goes, and what it is called. The placement is read off the
 * diff the review was given; the id is assigned here.
 *
 * **A finding with no anchor in the diff is not posted** (#127, decision 3).
 * The model is told to anchor a problem in an untouched file at the change that
 * causes it — that is what makes it this pull request's — so a `path` the diff
 * does not cover is the review saying, mechanically, that nothing here causes
 * it. This is the deterministic half of that instruction: the workflow decides
 * it from the diff rather than asking the model to classify its own finding,
 * and the caller records what comes back in `followUps`.
 *
 * The `path` is resolved against the diff's own spelling first (`diffKeyOf`),
 * because the inference above only holds if the lookup can fail for one reason.
 *
 * `nextId` is a parameter so a test can name the ids it then asserts on. It is
 * the only non-deterministic thing in this file, and defaulting it keeps the
 * runner's call to the two things it actually decides.
 */
export const placeFindings = (
  findings: readonly Finding[],
  diffLines: Map<string, Set<number>>,
  nextId: () => string = newFindingId,
): PlacedFindings => {
  const placed: PlacedFinding[] = [];
  const unanchored: Finding[] = [];

  for (const finding of findings) {
    const key = diffKeyOf(finding.path, diffLines);
    if (key === undefined) {
      unanchored.push(finding);
      continue;
    }

    // Rewritten to the diff's spelling rather than the model's, and only ever
    // to one the diff has: GitHub matches a thread's `path` against the diff
    // the same way this map does, so a finding placed under `./src/api.ts`
    // would be a placement that then fails to post — and one unpostable thread
    // is the whole review rejected.
    const anchored = key === finding.path ? finding : { ...finding, path: key };
    const placement = placementOf(anchored, diffLines.get(key));
    placed.push({ id: nextId(), placement, finding: anchored });
  }

  return { placed, unanchored };
};

/**
 * The leading noise a model puts in front of a path it read out of a diff: the
 * `a/` and `b/` of `diff --git`, and the `./` or `/` of a path it re-rooted.
 * Repeated because `./b/src/api.ts` is one model away.
 */
const PATH_NOISE = /^(?:\.\/|\/|a\/|b\/)+/;

/**
 * The key this diff holds for a `path`, or `undefined` where it holds none.
 *
 * The lookup is the whole of "nothing this pull request changed causes it"
 * (#127, decision 3), and that inference is only sound while it can fail for
 * exactly one reason — the file is not in the diff. Two others were found and
 * closed, and both cost a real blocker its place in the count rather than only
 * its thread: *approval recommended* and a `success` status over a finding the
 * review meant to stop the merge with.
 *
 * **The spelling.** `parseFinding` stores the model's path verbatim, so
 * `./src/api.ts`, `b/src/api.ts` or a trailing space missed a key of
 * `src/api.ts`. A miss is retried against the spellings a model reaches for,
 * and **only a candidate the diff actually holds is accepted**. Nothing is
 * normalised into existence: a repository with a directory genuinely called
 * `b` keeps its `b/queue.ts`, because that key matches on the first try and
 * the stripping below is never reached.
 *
 * **The quoting.** A path git had to escape is shown to the model quoted, and
 * a model that copies it copies the quotes. That spelling is undone the way
 * the keys' own is (`unquotePath`), so the two meet at the real path.
 *
 * **The key that was never written.** A deletion, a pure rename, a binary
 * change and a mode change name no new side, so keys sliced off `+++ b/` alone
 * held none of them — and "you deleted `src/gone.ts`, which `src/index.ts`
 * still imports" is a finding anchored at exactly what the change did. That is
 * fixed where the keys are written rather than here (`shared/diff-lines.ts`):
 * every file the diff touches is a key, and one with no new side is an empty
 * one, which `placementOf` reads as a file-level thread.
 */
const diffKeyOf = (path: string, diffLines: Map<string, Set<number>>): string | undefined =>
  spellingsOf(path).find((candidate) => diffLines.has(candidate));

/**
 * The spellings of a model's `path` worth trying, most literal first — so a
 * repository with a directory really called `b` matches `b/queue.ts` before
 * the stripping that would turn it into `queue.ts`.
 *
 * A path copied out of the diff as git quoted it — `"b/caf\303\251.ts"` — is
 * unquoted before the noise comes off, since the `b/` is inside the quotes.
 * Malformed quoting keeps the text as it was, which then misses.
 */
const spellingsOf = (path: string): string[] => {
  const trimmed = path.trim();
  const unquoted = unquotePath(trimmed) ?? trimmed;
  return [path, trimmed, unquoted.replace(PATH_NOISE, "")];
};

/**
 * The unanchored findings whose `path` is **no file in the repository** under
 * any spelling `spellingsOf` tries.
 *
 * `placeFindings` reads a path outside the diff as "nothing this pull request
 * changed causes it", and that holds for a real file the change did not touch.
 * It does not hold for a path that names nothing: that is the review
 * mistyping, or quoting, or inventing a location, and the finding behind it may
 * be a blocker in a file the change did touch. Demoting it would turn a slip in
 * a string into *approval recommended* and a green status. So these are still
 * recorded as follow-ups — the record stays one set with the count — but the
 * review says why a human has to look (`pathErrorNote`), which puts the verdict
 * on *needs a closer look*.
 *
 * `isFile` answers for one path at the reviewed head. A question per path
 * rather than a list of the tree, because a repository-wide list is unbounded
 * output — past `execSync`'s 1 MiB buffer on a large repository, which killed
 * the review after the agent run was paid for — while the paths asked about
 * are only the unanchored ones, usually none. A file the change deleted is
 * not at the head, and needs no exception: it is in the diff, so a finding
 * about it is never unanchored.
 */
export const pathErrors = (
  unanchored: readonly Finding[],
  isFile: (path: string) => boolean,
): Finding[] =>
  unanchored.filter((finding) => !spellingsOf(finding.path).some((candidate) => isFile(candidate)));

/**
 * What the review says about `pathErrors`, as the reason it needs a human —
 * or `undefined` where there are none. Names each path, so a reader can see
 * the slip without opening the follow-ups.
 */
export const pathErrorNote = (errors: readonly Finding[]): string | undefined => {
  if (errors.length === 0) return undefined;
  const paths = [...new Set(errors.map((finding) => `\`${finding.path.trim()}\``))].join(", ");
  const count = errors.length === 1 ? "A finding names" : `${errors.length} findings name`;
  return `${count} a path that is no file in this repository (${paths}), so the diff could not place ${errors.length === 1 ? "it" : "them"}. ${errors.length === 1 ? "It is" : "They are"} recorded as follow-ups, but a mistyped path can hide a real blocker in a file this pull request changed. Check ${errors.length === 1 ? "it" : "each"} before merging.`;
};

/**
 * The placement of a finding in a file the diff **does** hold, from that file's
 * covered lines.
 *
 * Takes the lines rather than the map because the question of *which* file is
 * already answered by the time this runs — `diffKeyOf` decides it, and a second
 * lookup here would be a second answer to it.
 */
const placementOf = (finding: Finding, fileLines: Set<number> | undefined): Placement => {
  // Every line of a range must be in a hunk, not just the end of it: GitHub
  // rejects the whole review over any one of them.
  const from = finding.startLine ?? finding.line;
  for (let line = from; line <= finding.line; line++) {
    if (!fileLines?.has(line)) return "file";
  }
  return "line";
};

/**
 * One finding as the review runner hands it to `review:publish` (ADR 0007):
 * every choice about it made, and none of the text the loop adds to it. Where
 * it is posted, the title the record lists it under, how bad it is and whether
 * an earlier review had read its code are the runner's to decide; the badge,
 * the label and the marker its thread carries are publish's to write, from
 * these.
 *
 * `body` is the model's own, label and all: taking the label off is part of
 * writing the thread (`threadBody`), and so happens to the text publish read,
 * cleaned, rather than to the text the runner had.
 */
export interface HandedFinding {
  readonly id: string;
  readonly placement: Placement;
  readonly severity: Severity;
  /** By `findingTitle`: what the record lists it as, and what its marker carries forward. */
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly line: number;
  readonly startLine?: number | undefined;
  readonly previouslyMissed: boolean;
}

/** The placed findings, as the runner hands them over: one each, in order. */
export const findingsHandOver = (placed: readonly PlacedFinding[]): HandedFinding[] =>
  placed.map(({ id, placement, finding }) => ({
    id,
    placement,
    severity: finding.severity,
    title: findingTitle(finding),
    body: finding.body,
    path: finding.path,
    line: finding.line,
    ...(finding.startLine === undefined ? {} : { startLine: finding.startLine }),
    previouslyMissed: isPreviouslyMissed(finding),
  }));

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
 * The thread text: the **badge**, the finding as the model wrote it minus the
 * label the badge replaces, then its id (#135).
 *
 * The badge is the same one the record entry for this finding shows, written
 * from the same `severityBadge`, so the two surfaces cannot disagree about how
 * bad it is. Before this they did, and in the most confusing possible way: the
 * body listed the finding as `Medium` while its own thread opened **Fix before
 * merge.** — a label every finding carries by definition, over a severity a
 * reader could only get at by viewing the source of the hidden marker.
 *
 * *Previously missed* survives the strip because it is the one label that says
 * something: it decides the group the record files the finding under
 * (`isPreviouslyMissed`), and the runner hands that decision over beside the
 * body, which is why the strip happens here and the prompt still asks for both
 * labels.
 *
 * The marker goes at the **end**. What a reader's eye lands on is the badge and
 * the claim, and a hidden comment ahead of them displaces both for no gain.
 */
const threadBody = (finding: HandedFinding): string => {
  const opening = [severityBadge(finding.severity), finding.previouslyMissed ? PREVIOUSLY_MISSED_LABEL : undefined]
    .filter((part) => part !== undefined)
    .join(" · ");

  return [opening, withoutOpeningLabel(finding.body), findingMarker(finding.id, finding.severity, finding.title)]
    .filter((part) => part !== "")
    .join("\n\n");
};

/**
 * The threads the review carries — **one per handed finding**, with nothing
 * filtered out. Written by `review:publish` from what the runner handed over.
 *
 * Every finding that reaches here has a thread by construction since #127:
 * `placeFindings` returns only the two threadable placements, and the ones it
 * cannot anchor never enter this list. The filter that used to stand here was
 * the half that made a body entry possible.
 *
 * The mutation the threads go out in is the engine's own (`engine/writes.ts`),
 * so nothing here names a query: GraphQL's `addPullRequestReview` rather than
 * REST, for the one thing REST cannot do, a **file-level** thread in the same
 * call as the review (#109, decision 5).
 */
export const reviewThreads = (findings: readonly HandedFinding[]): ReviewThread[] =>
  findings.map((f) =>
    f.placement === "file"
      ? { path: f.path, body: threadBody(f) }
      : {
          path: f.path,
          line: f.line,
          side: "RIGHT" as const,
          // startLine/startSide turn the anchor into a range, which is what
          // makes a multi-line ```suggestion replace all of it rather than
          // just the last line. Omitted entirely for a single line — GitHub
          // rejects startLine == line.
          ...(f.startLine === undefined ? {} : { startLine: f.startLine, startSide: "RIGHT" as const }),
          body: threadBody(f),
        },
  );
