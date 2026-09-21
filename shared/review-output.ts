import { asArray, asRecord, asString, standardSchema } from "./common.js";

export interface InlineComment {
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
 * A problem the review found and this pull request will not fix — a defect in a
 * function the diff only calls, a missing test for behaviour it did not change.
 * The third output channel, beside the summary and the inline comments (#47).
 *
 * It exists because both of the other two lose it. A finding in the summary is
 * text on a review nobody reads once the PR has merged; an out-of-scope finding
 * is *off-diff* by construction, and an off-diff inline comment is dropped
 * before posting by `filterInlineComments` above.
 */
export interface FollowUp {
  /** One line, as a human scans it in a triage list. */
  readonly title: string;
  /** `path` or `path:line` — where a reader starts. Not validated against the diff. */
  readonly location: string;
  /** Evidence it is real, then why this PR cannot fix it. */
  readonly body: string;
}

/**
 * At most this many per review. Enforced by `capFollowUps` and *never* by the
 * schema — see the comment there.
 */
export const MAX_FOLLOW_UPS = 3;

export interface ReviewOutput {
  readonly summary: string;
  readonly inlineComments: InlineComment[];
  readonly followUps: FollowUp[];
}

const positiveInt = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
};

const parseInlineComment = (value: unknown): InlineComment => {
  const record = asRecord(value, "inline comment");
  const line = positiveInt(record["line"], "inline comment line");

  const rawStart = record["startLine"] ?? record["start_line"];
  let startLine: number | undefined;
  if (rawStart !== undefined && rawStart !== null) {
    startLine = positiveInt(rawStart, "inline comment startLine");
    if (startLine > line) {
      throw new Error("inline comment startLine must be <= line");
    }
    // A one-line "range" is just a single-line comment; GitHub rejects
    // start_line == line, so normalise it away rather than fail the review.
    if (startLine === line) startLine = undefined;
  }

  return {
    path: asString(record["path"] ?? record["file"], "inline comment path"),
    line,
    ...(startLine === undefined ? {} : { startLine }),
    body: asString(record["body"] ?? record["comment"], "inline comment body"),
  };
};

const parseFollowUp = (value: unknown): FollowUp => {
  const record = asRecord(value, "follow-up");
  return {
    title: asString(record["title"], "follow-up title"),
    location: asString(record["location"], "follow-up location"),
    body: asString(record["body"], "follow-up body"),
  };
};

export const reviewOutputSchema = standardSchema<ReviewOutput>((value) => {
  const record = asRecord(value, "review output");
  return {
    summary: asString(record["summary"], "summary"),
    inlineComments: asArray(record["inlineComments"] ?? [], "inlineComments").map(
      parseInlineComment,
    ),
    // Absent is the ordinary case — most reviews find nothing out of scope —
    // so it defaults rather than being required. Nothing here rejects a list
    // longer than the cap: see `capFollowUps`.
    followUps: asArray(record["followUps"] ?? record["follow_ups"] ?? [], "followUps").map(
      parseFollowUp,
    ),
  };
});

/**
 * Drop any inline comment whose (path, line) is not in the diff. The model
 * routinely invents plausible line numbers, and GitHub rejects the *entire*
 * review if even one comment is off-diff — so this filter is what stands
 * between a useful review and a 422 that posts nothing.
 */
export const filterInlineComments = (
  comments: readonly InlineComment[],
  diffLines: Map<string, Set<number>>,
): InlineComment[] =>
  comments.filter((comment) => {
    const fileLines = diffLines.get(comment.path);
    if (!fileLines) {
      console.warn(`Dropping comment for ${comment.path}:${comment.line}; file not in diff.`);
      return false;
    }
    // Every line of a multi-line anchor must be in the diff, not just the end
    // of the range — GitHub rejects the whole review otherwise.
    const from = comment.startLine ?? comment.line;
    for (let line = from; line <= comment.line; line++) {
      if (!fileLines.has(line)) {
        console.warn(
          `Dropping comment for ${comment.path}:${from}-${comment.line}; line ${line} not in diff hunks.`,
        );
        return false;
      }
    }
    return true;
  });

/**
 * Apply the cap, and report what it cost.
 *
 * Truncation rather than a schema error, deliberately: throwing would fail
 * extraction and lose the *whole* review — summary and inline comments with it
 * — and a model that emitted a fourth follow-up has not produced a broken
 * review. This sits beside `filterInlineComments` for that reason; both drop
 * bad output rather than rejecting the run.
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
 * the inline comments down with it, so the full stub text is not spent twice.
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

  // One line each. A title is meant to be one line; whitespace-collapsing it
  // means a model that wrapped one cannot break the list it sits in.
  const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
  const items = kept.map((f) => `- **${oneLine(f.title)}** — \`${oneLine(f.location)}\``);

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
