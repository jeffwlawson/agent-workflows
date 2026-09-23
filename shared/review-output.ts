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
  /**
   * One line per finding this pull request must not merge without fixing —
   * the other of the review's two finding types, beside `followUps` (#96).
   *
   * A **restatement** of what the summary and the inline comments already say,
   * and that is its job: the verdict is derived from how many there are, and
   * counting them out of prose is the sentence nothing acted on that the
   * verdict replaced. The detail stays where a human reads it.
   *
   * Not derived from the inline comments, which is the shape this could have
   * taken and the one that breaks. `filterInlineComments` drops an anchor that
   * is off-diff, so a finding whose line the model invented would leave the
   * count as well as the review — turning "ready after a fix" into "ready to
   * merge" on exactly the reviews that found something.
   */
  readonly fixBeforeMerge: string[];
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

/** One of three, derived from a review rather than written in it (#96). */
export type Verdict = "ready to merge" | "ready after a fix" | "needs you";

export interface VerdictRow {
  readonly verdict: Verdict;
  /**
   * The commit status's state. Only "ready to merge" is `success`: the other
   * two are things left to do, and a green tick beside them is the verdict
   * saying the opposite of what it means.
   */
  readonly state: "success" | "failure";
  /**
   * The next human step, and the whole promise of the feature — this line is
   * what makes the outcome actionable without reading the review.
   *
   * Under GitHub's 140-character limit for a status description, which
   * truncates where the character ran out rather than where the sentence ends.
   * A test holds each of these to it.
   */
  readonly description: string;
}

/**
 * The context the verdict is posted under. One per commit per context, so a
 * later review of the same commit replaces its own verdict and nothing else —
 * and a new commit carries none until one is posted for it, which is what stops
 * a stale "ready" surviving a push.
 */
export const VERDICT_CONTEXT = "agent-review";

/** The table, verbatim. #96 decision 2 is the copy a human argues with. */
export const VERDICTS: Readonly<Record<Verdict, VerdictRow>> = {
  "ready to merge": {
    verdict: "ready to merge",
    state: "success",
    description:
      "Ready to merge. Nothing left to fix; any follow-ups are filed as issues when you merge.",
  },
  "ready after a fix": {
    verdict: "ready after a fix",
    state: "failure",
    description:
      "Add agent:fix. The fixes are clear, so no need to read them first. A re-review runs automatically.",
  },
  "needs you": {
    verdict: "needs you",
    state: "failure",
    description:
      "Read the review, then reply with your decision and add agent:fix. If the issue itself was wrong, close the PR instead.",
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
 * symptom — a second round that says "ready after a fix" and sends the loop
 * back around a fix that already did not work.
 */
export interface VerdictInputs {
  readonly ci: CiResult;
  readonly round: ReviewRoundNumber;
}

/**
 * The label every *fix before merge* inline comment opens with, exactly as the
 * prompt and the extraction brief spell it. A fixed token, read as one — the
 * count below looks for it at the start of a comment body and nowhere else,
 * because reading the summary for findings is the prose-parsing this whole
 * derivation exists to replace.
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
 * How many findings this pull request must not merge without fixing.
 *
 * The **larger** of the two places a finding is recorded, not the count of the
 * list alone. The model is asked to put every one of them in both, so either
 * can be the one it forgot — and a finding labelled `**Fix before merge.**` in
 * an inline comment but missing from `fixBeforeMerge` derives *ready to merge*,
 * which is the unsafe direction for the one signal meant to be acted on without
 * reading.
 *
 * Larger rather than the sum, because the two are restatements of one set of
 * findings: adding them would double-count every review that did as it was
 * asked.
 *
 * Counted over the inline comments **as produced**, before
 * `filterInlineComments` drops the off-diff anchors. A finding whose line the
 * model invented is still a finding; dropping it from the count as well as from
 * the review is how a review that found something ends up saying nothing is
 * wrong.
 */
export const countFixBeforeMerge = (output: ReviewOutput): number =>
  Math.max(
    output.fixBeforeMerge.length,
    output.inlineComments.filter((comment) => LABELLED.test(comment.body)).length,
  );

/**
 * The checklist the posted review body carries, or `undefined` when there is
 * nothing to fix.
 *
 * In the **body**, because that is the only place round 2 can read it. A fix
 * run resolves every thread it addressed, and resolved threads are dropped from
 * the feedback the next review is handed — so a list carried only by the inline
 * comments is invisible to the pass whose whole job is checking that it landed.
 *
 * Open rather than collapsed, unlike the follow-ups block: these are the
 * findings the verdict just told a reader to act on, and a disclosure widget
 * over them is one more click between the line and the work.
 */
const renderFixBeforeMerge = (findings: readonly string[]): string | undefined => {
  if (findings.length === 0) return undefined;
  // One line each, for the same reason a follow-up title is collapsed: a
  // finding the model wrapped cannot be allowed to break the list it sits in.
  const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

  return ["**To fix before merge**", "", ...findings.map((f) => `- [ ] ${oneLine(f)}`)].join("\n");
};

/**
 * The summary as it is posted: four parts in one fixed order, and the one place
 * that order is written down (#105).
 *
 * Each part is there because a reader needs it before the one after it — what
 * to do, why it cannot be automated, what to fix, and then the evidence — and
 * two of them are parts the review used to lose. `needsYou` reached the
 * derivation and nothing else, so the case the agent named ("the wrong thing
 * was built", "the issue itself was wrong") never reached the maintainer whose
 * decision it is. And `fixBeforeMerge` was posted nowhere at all, which left
 * round 2 verifying the last round's findings against summary prose: the fix
 * run resolves every thread it addressed, and resolved threads are dropped from
 * the feedback the next review is handed.
 *
 * A function rather than four lines in the runner, because this is the part of
 * the review a human acts on and the runner is a script with no test around it.
 */
export const renderReviewSummary = (parts: {
  /** The verdict's next-step line — the same sentence the commit status carries. */
  readonly verdict: string;
  readonly needsYou?: string | undefined;
  /** The note a round that could not be established carries; see `shared/review-round.ts`. */
  readonly roundNote?: string | undefined;
  readonly fixBeforeMerge: readonly string[];
  readonly summary: string;
}): string =>
  [
    parts.verdict,
    parts.needsYou,
    parts.roundNote,
    renderFixBeforeMerge(parts.fixBeforeMerge),
    parts.summary,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join("\n\n");

/**
 * The verdict, from the review and the checks and nothing else.
 *
 * The order of the arms is the whole of it. The agent's own "a fix round will
 * not settle this" comes first, because it is a statement about the findings
 * rather than one more of them. Findings come next, *including* when the checks
 * are red: red checks with findings have an explanation and something for a fix
 * round to aim at. Red or unreadable checks with **nothing** behind them is the
 * case with no finding to act on at all, and it is precisely the one a
 * derivation keyed only on findings would call ready to merge.
 */
export const deriveVerdict = (output: ReviewOutput, inputs: VerdictInputs): VerdictRow => {
  if (output.needsYou !== undefined) return VERDICTS["needs you"];
  if (countFixBeforeMerge(output) > 0) {
    // **A round-2 review can never say "ready after a fix"** (#96, decision 5),
    // and it is enforced here rather than asked of the prompt. The fix round
    // has already run and already pushed; findings that survived it are
    // findings a second one has no more reason to settle than the first, and
    // the loop's one bound is that a fix cannot ask for another fix. A prompt
    // line would leave that bound to a model's judgement about its own output.
    //
    // It costs a true "ready after a fix" on the round where a fix broke
    // something new and obvious, which reads as a human being asked to look at
    // a PR they did not have to. That is the direction this is meant to fail
    // in: the alternative is a cycle with no gate in it.
    return inputs.round === 2 ? VERDICTS["needs you"] : VERDICTS["ready after a fix"];
  }
  if (inputs.ci !== "green") return VERDICTS["needs you"];
  return VERDICTS["ready to merge"];
};

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
    inlineComments: asArray(record["inlineComments"] ?? [], "inlineComments").map(
      parseInlineComment,
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
    ...(needsYou === undefined ? {} : { needsYou }),
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
