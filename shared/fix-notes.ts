import { asRecord, asString } from "./common.js";
import {
  embeddableJson,
  type DroppedNote,
  type FollowUp,
  type NoteRuling,
} from "./review-output.js";
import { DEFAULT_SEVERITY } from "./review-findings.js";

/**
 * Something the fix agent noticed while fixing that is **not this pull
 * request's to fix** (#213): a pre-existing bug in code the change only calls,
 * a follow-up tool the change makes worth having, a redesign larger than the
 * change.
 *
 * Structured, where it used to be free prose in a top-level comment, because
 * prose had nowhere to go. Nothing read those comments: `follow-ups` files only
 * from the review body, and the feedback fetch strips marked comments from what
 * the next review sees. On jeffwlawson/mealie-mcp-server#82 a real bug and a
 * proposed tool were posted that way and found only because a human read the
 * thread after the merge.
 *
 * So a note now has the shape a follow-up has, less the severity, which is the
 * review's to give it. The fix agent never files one and never writes the
 * follow-ups record: the next review rules on each note, and either records it
 * as a follow-up `follow-ups` files on merge, or drops it with a reason in its
 * own body (`applyNoteRulings`). Two writers of the one record would break "the
 * newest record wins", which is why that half was rejected in triage.
 */
export interface OutOfScopeNote {
  /** One line, as a human scans it in a triage list. */
  readonly title: string;
  /** What it is, the evidence it is real, and why this pull request is not the place. */
  readonly body: string;
  /** `path` or `path:line`, where there is one. A proposed tool may have none. */
  readonly location?: string;
}

/**
 * The selector a posted note carries, followed by the note itself as JSON. A
 * **selector, not a control**, exactly as `FOLLOW_UPS_MARKER` is: anyone who
 * can comment can type it, so the review reads a note only from a comment the
 * workflow bot posted (`isWorkflowBot`), never on the marker alone.
 *
 * A different string from `TOP_LEVEL_COMMENT_MARKER`, because the two are not
 * the same kind of thing to anything that reads them: a top-level comment is
 * said and done, and a note is owed a ruling.
 */
export const OUT_OF_SCOPE_NOTE_MARKER = "agent-fix:out-of-scope";

/**
 * Opens every posted note, so it stands out from the other comments the loop
 * posts: every workflow here posts as the same bot.
 */
export const OUT_OF_SCOPE_NOTE_HEADING = "Noticed while fixing (outside this PR):";

/**
 * The payload's shape, versioned for the reason `FOLLOW_UPS_VERSION` is: a note
 * posted by one release is read by the review of the next.
 */
const NOTE_VERSION = 1;

const NOTE_BLOCK = new RegExp(`<!-- ${OUT_OF_SCOPE_NOTE_MARKER} (.*) -->`, "g");

/** True for a comment carrying a note's selector, whoever wrote it. */
export const isOutOfScopeNote = (body: string | null | undefined): boolean =>
  (body ?? "").includes(`<!-- ${OUT_OF_SCOPE_NOTE_MARKER} `);

/**
 * Read one note. `null` rather than a throw, for the reason
 * `parseTopLevelComment` gives: this is a side channel, and a malformed note
 * must not take the thread replies down with it. Dropped with a warning, so the
 * loss is in the log.
 */
const parseNote = (value: unknown): OutOfScopeNote | null => {
  try {
    const record = asRecord(value, "out-of-scope note");
    const location = record["location"];
    return {
      title: asString(record["title"], "out-of-scope note title").trim(),
      body: asString(record["body"], "out-of-scope note body").trim(),
      ...(typeof location === "string" && location.trim() !== ""
        ? { location: location.trim() }
        : {}),
    };
  } catch (error) {
    console.warn(
      `Dropping a malformed out-of-scope note: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

/** Absent means none, which is the usual answer. Never an error, as `parseTopLevelComments`. */
export const parseOutOfScopeNotes = (value: unknown): OutOfScopeNote[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    console.warn("Dropping outOfScopeNotes: expected an array.");
    return [];
  }
  return value.map(parseNote).filter((note): note is OutOfScopeNote => note !== null);
};

/**
 * The comment the workflow posts for one note: the heading and the note for a
 * reader, then the note again as the payload the next review reads it from.
 * Read back from the payload rather than from the prose, so nothing parses
 * Markdown to recover a title.
 */
export const renderOutOfScopeNote = (note: OutOfScopeNote): string =>
  [
    `**${OUT_OF_SCOPE_NOTE_HEADING}** ${note.title}`,
    ...(note.location === undefined ? [] : [`\`${note.location}\``]),
    note.body,
    "_The next review decides whether this is filed as an issue when the pull request merges._",
    `<!-- ${OUT_OF_SCOPE_NOTE_MARKER} ${embeddableJson({ version: NOTE_VERSION, ...note })} -->`,
  ].join("\n\n");

/**
 * The note a posted comment carries, or `undefined` where it carries none this
 * version can read. The **last** payload wins, as in a review body: the prose
 * above it is the model's and may quote one.
 */
export const readOutOfScopeNote = (body: string | null | undefined): OutOfScopeNote | undefined => {
  const matches = [...(body ?? "").matchAll(NOTE_BLOCK)];
  const raw = matches[matches.length - 1]?.[1];
  if (raw === undefined) return undefined;
  try {
    const record = asRecord(JSON.parse(raw), "out-of-scope note payload");
    if (record["version"] !== NOTE_VERSION) return undefined;
    return parseNote(record) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * How many notes one run may post. Two, the top-level comments' cap, for its
 * reason: a run with three separate things outside its scope is a channel
 * misfiring. And a third would crowd the review's own three follow-ups, which
 * a promoted note counts toward.
 */
export const MAX_OUT_OF_SCOPE_NOTES = 2;

const sameNote = (a: OutOfScopeNote, b: OutOfScopeNote): boolean =>
  a.title === b.title && a.body === b.body && a.location === b.location;

/**
 * The comments to post, capped and deduped against the notes earlier runs
 * already posted on this pull request, in the spirit of `filterTopLevelComments`:
 * the prompt says one or none is usual, and model behaviour is not taken on
 * trust. A note posted twice would be ruled on, and filed, twice.
 */
export const filterOutOfScopeNotes = (
  notes: readonly OutOfScopeNote[],
  alreadyPosted: readonly string[] = [],
): string[] => {
  const seen = alreadyPosted
    .map(readOutOfScopeNote)
    .filter((note): note is OutOfScopeNote => note !== undefined);
  const kept: string[] = [];
  let overCap = 0;
  for (const note of notes) {
    if (seen.some((prior) => sameNote(prior, note))) {
      console.warn("Dropping an out-of-scope note already posted on this PR.");
      continue;
    }
    seen.push(note);
    if (kept.length >= MAX_OUT_OF_SCOPE_NOTES) {
      overCap += 1;
      continue;
    }
    kept.push(renderOutOfScopeNote(note));
  }
  if (overCap > 0) {
    console.warn(
      `Dropping ${overCap} out-of-scope note(s) beyond the cap of ${MAX_OUT_OF_SCOPE_NOTES}.`,
    );
  }
  return kept;
};

/** A note as the review is handed it: the comment it was posted in, and the note. */
export interface PostedNote extends OutOfScopeNote {
  /** Node id of the comment, which a ruling names. */
  readonly noteId: string;
  /** The comment's permalink, where GitHub returned one. */
  readonly url?: string;
}

const NO_NOTES = "(the fix run has left no out-of-scope notes since the last review.)";

/**
 * The notes as the review agent is shown them, each under the id a ruling on
 * it names. Said where there are none, as `renderCarriedFindings` says it: an
 * empty section reads as a template that failed to fill.
 */
export const renderNotesForReview = (notes: readonly PostedNote[]): string =>
  notes.length === 0
    ? NO_NOTES
    : notes
        .map((note) =>
          [
            `- note \`${note.noteId}\`: **${note.title}**` +
              (note.location === undefined ? "" : ` · \`${note.location}\``),
            ...note.body.split("\n").map((line) => (line === "" ? "" : `  ${line}`)),
          ].join("\n"),
        )
        .join("\n\n");

/**
 * Where a promoted note says it came from, so whoever triages the filed issue
 * can find the conversation it was raised in.
 */
const raisedIn = (note: PostedNote): string =>
  note.url === undefined
    ? "_Noticed by `agent:fix` while fixing this pull request._"
    : `_Noticed by \`agent:fix\` while fixing this pull request ([note](${note.url}))._`;

/**
 * What the review's rulings make of the notes it was handed: the ones it
 * **promoted**, as follow-ups `follow-ups` files on merge, and the ones it
 * **dropped**, each with its reason, for the body.
 *
 * Every note ends in exactly one of the two, which is the whole of #213: an
 * out-of-scope note posted by the loop ends as a filed issue or as a stated
 * decision not to file. So a ruling naming a note the review was not handed is
 * dropped (an invented id would otherwise name nothing), the first ruling on a
 * note is the one kept, and **a note the review said nothing about is
 * promoted**, at the default severity. That is the safe direction, as an
 * unruled carried finding stays open: a filed issue a triager closes costs a
 * minute, and a note nobody ruled on is the silent loss this exists to end.
 *
 * The location is the review's where it gave one, then the note's, then the
 * note's permalink: a follow-up needs one, and a filing run keys on it.
 */
export const applyNoteRulings = (
  notes: readonly PostedNote[],
  rulings: readonly NoteRuling[],
): { promoted: FollowUp[]; dropped: DroppedNote[] } => {
  const known = new Set(notes.map((note) => note.noteId));
  const ruled = new Map<string, NoteRuling>();
  for (const ruling of rulings) {
    if (!known.has(ruling.noteId)) {
      console.warn(`Dropping a ruling on note ${ruling.noteId}, which this review was not handed.`);
      continue;
    }
    if (ruled.has(ruling.noteId)) {
      console.warn(`Dropping a second ruling on note ${ruling.noteId}.`);
      continue;
    }
    ruled.set(ruling.noteId, ruling);
  }

  const promoted: FollowUp[] = [];
  const dropped: DroppedNote[] = [];
  for (const note of notes) {
    const ruling = ruled.get(note.noteId);
    if (ruling?.status === "dropped") {
      dropped.push({
        title: note.title,
        reason: ruling.reason,
        ...(note.url === undefined ? {} : { url: note.url }),
      });
      continue;
    }
    if (ruling === undefined) {
      console.warn(`Note ${note.noteId} was not ruled on, so it is recorded as a follow-up.`);
    }
    promoted.push({
      title: note.title,
      location:
        ruling?.location ?? note.location ?? note.url ?? "this pull request's conversation",
      body: `${note.body}\n\n${raisedIn(note)}`,
      severity: ruling?.severity ?? DEFAULT_SEVERITY,
    });
  }
  return { promoted, dropped };
};
