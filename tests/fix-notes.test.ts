import { describe, expect, it } from "vitest";
import {
  applyNoteRulings,
  filterOutOfScopeNotes,
  isOutOfScopeNote,
  MAX_OUT_OF_SCOPE_NOTES,
  OUT_OF_SCOPE_NOTE_HEADING,
  readOutOfScopeNote,
  renderNotesForReview,
  renderOutOfScopeNote,
  type OutOfScopeNote,
  type PostedNote,
} from "../shared/fix-notes.js";
import { fixOutputSchema, type FixOutput } from "../shared/fix-output.js";
import { planFollowUps } from "../shared/follow-up-plan.js";
import {
  recordFollowUps,
  renderReviewBody,
  reviewOutputSchema,
  VERDICTS,
  type ReviewOutput,
} from "../shared/review-output.js";

/**
 * The fix agent's out-of-scope notes (#213). They used to be free prose in a
 * top-level comment that nothing read, so a real bug the fix agent found on
 * jeffwlawson/mealie-mcp-server#82 was filed only because a human read the
 * thread after the merge. Now each note is structured, posted under its own
 * marker, and ruled on by the next review: filed on merge, or dropped with a
 * reason. These hold every step of that path.
 */

const parseFix = (value: unknown): FixOutput => {
  const result = fixOutputSchema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error(result.issues.map((i) => i.message).join("; "));
  }
  return (result as { value: FixOutput }).value;
};

const parseReview = (value: unknown): ReviewOutput => {
  const result = reviewOutputSchema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error(result.issues.map((i) => i.message).join("; "));
  }
  return (result as { value: ReviewOutput }).value;
};

/** The two notes jeffwlawson/mealie-mcp-server#82's fix run posted, as structured notes. */
const IGNORED_FIELDS: OutOfScopeNote = {
  title: "Two tool parameters send fields the API ignores",
  location: "src/tools/recipes.ts:88",
  body: "`update_recipe` sends `tags` and `categories`, which the upstream endpoint ignores, so both silently do nothing. Pre-existing; this pull request does not touch that tool.",
};
const NEW_TOOL: OutOfScopeNote = {
  title: "Add a tool for shopping list items",
  body: "Nothing exposes shopping list items, which the recipe tools this pull request adds would pair with. A new tool, so not this change.",
};

const posted = (note: OutOfScopeNote, id: string): PostedNote => ({
  noteId: id,
  url: `https://github.test/o/r/pull/82#issuecomment-${id}`,
  ...note,
});

describe("fixOutputSchema outOfScopeNotes", () => {
  it("reads a note's title, body and location", () => {
    expect(parseFix({ outOfScopeNotes: [IGNORED_FIELDS] }).outOfScopeNotes).toEqual([IGNORED_FIELDS]);
  });

  it("reads a note with no location, and leaves the field out", () => {
    const [note] = parseFix({ outOfScopeNotes: [{ ...NEW_TOOL, location: "  " }] }).outOfScopeNotes;
    expect(note).toEqual(NEW_TOOL);
    expect(note).not.toHaveProperty("location");
  });

  it("is empty when absent, which is the usual answer", () => {
    expect(parseFix({}).outOfScopeNotes).toEqual([]);
  });

  /** A side channel, like the top-level comments: it must not fail the thread replies. */
  it("drops a malformed note rather than failing the run", () => {
    const out = parseFix({
      threadOutcomes: [{ threadId: "PRRT_a", status: "addressed", reply: "done" }],
      outOfScopeNotes: [{ body: "no title" }, NEW_TOOL],
    });
    expect(out.outOfScopeNotes).toEqual([NEW_TOOL]);
    expect(out.threadOutcomes).toHaveLength(1);
    expect(parseFix({ outOfScopeNotes: "a string" }).outOfScopeNotes).toEqual([]);
  });

  it("is a field of its own, apart from the top-level comments", () => {
    const out = parseFix({ topLevelComments: [{ body: "spans threads" }], outOfScopeNotes: [NEW_TOOL] });
    expect(out.topLevelComments.map((c) => c.body)).toEqual(["spans threads"]);
    expect(out.outOfScopeNotes).toEqual([NEW_TOOL]);
  });
});

describe("a posted note", () => {
  it("opens with a heading saying it is outside this pull request", () => {
    const body = renderOutOfScopeNote(IGNORED_FIELDS);
    expect(body.startsWith(`**${OUT_OF_SCOPE_NOTE_HEADING}** ${IGNORED_FIELDS.title}`)).toBe(true);
    expect(body).toContain("`src/tools/recipes.ts:88`");
    expect(body).toContain(IGNORED_FIELDS.body);
  });

  it("carries the note back out of its payload, exactly", () => {
    for (const note of [IGNORED_FIELDS, NEW_TOOL]) {
      const body = renderOutOfScopeNote(note);
      expect(isOutOfScopeNote(body)).toBe(true);
      expect(readOutOfScopeNote(body)).toEqual(note);
    }
  });

  /** Prose may legitimately hold `-->`, which would end the payload's comment early. */
  it("survives a body that would close an HTML comment", () => {
    const note = { ...NEW_TOOL, body: "An arrow --> in the middle." };
    expect(readOutOfScopeNote(renderOutOfScopeNote(note))).toEqual(note);
  });

  it("reads nothing from a comment with no payload", () => {
    expect(readOutOfScopeNote("Just a comment.")).toBeUndefined();
    expect(readOutOfScopeNote("<!-- agent-fix:out-of-scope not json -->")).toBeUndefined();
  });
});

describe("filterOutOfScopeNotes", () => {
  it(`posts at most ${MAX_OUT_OF_SCOPE_NOTES}`, () => {
    const notes = [1, 2, 3].map((n) => ({ ...NEW_TOOL, title: `tool ${n}` }));
    expect(filterOutOfScopeNotes(notes)).toHaveLength(MAX_OUT_OF_SCOPE_NOTES);
  });

  /** A note posted twice would be ruled on, and filed, twice. */
  it("drops a note an earlier run already posted on this pull request", () => {
    const kept = filterOutOfScopeNotes([IGNORED_FIELDS, NEW_TOOL], [renderOutOfScopeNote(IGNORED_FIELDS)]);
    expect(kept).toEqual([renderOutOfScopeNote(NEW_TOOL)]);
  });

  it("drops a repeat within the same run", () => {
    expect(filterOutOfScopeNotes([NEW_TOOL, NEW_TOOL])).toHaveLength(1);
  });
});

describe("the notes the review is handed", () => {
  it("lists each under the id a ruling names", () => {
    const text = renderNotesForReview([posted(IGNORED_FIELDS, "IC_one"), posted(NEW_TOOL, "IC_two")]);
    expect(text).toContain("note `IC_one`: **Two tool parameters send fields the API ignores** · `src/tools/recipes.ts:88`");
    expect(text).toContain("note `IC_two`: **Add a tool for shopping list items**");
    expect(text).toContain("  `update_recipe` sends");
  });

  it("says there are none rather than rendering an empty section", () => {
    expect(renderNotesForReview([])).toMatch(/no out-of-scope notes/);
  });
});

describe("reviewOutputSchema noteRulings", () => {
  it("reads a promotion and a drop", () => {
    const out = parseReview({
      noteRulings: [
        { noteId: "IC_one", status: "promoted", severity: "high", location: "src/a.ts:1" },
        { noteId: "IC_two", status: "dropped", reason: "Already tracked." },
      ],
    });
    expect(out.noteRulings).toEqual([
      { noteId: "IC_one", status: "promoted", severity: "high", location: "src/a.ts:1" },
      { noteId: "IC_two", status: "dropped", reason: "Already tracked." },
    ]);
  });

  /** A drop with no reason is the silent loss the ruling exists to end. */
  it("refuses a drop without a reason", () => {
    expect(() => parseReview({ noteRulings: [{ noteId: "IC_two", status: "dropped" }] })).toThrow(
      /reason/,
    );
  });

  it("refuses a status that is neither", () => {
    expect(() => parseReview({ noteRulings: [{ noteId: "IC_two", status: "ignored" }] })).toThrow(
      /"promoted" or "dropped"/,
    );
  });

  it("is left out of a review handed no notes", () => {
    expect(parseReview({})).not.toHaveProperty("noteRulings");
  });
});

describe("applyNoteRulings", () => {
  const notes = [posted(IGNORED_FIELDS, "IC_one"), posted(NEW_TOOL, "IC_two")];

  it("promotes a note into a follow-up with the review's severity and location", () => {
    const { promoted, dropped } = applyNoteRulings(notes.slice(0, 1), [
      { noteId: "IC_one", status: "promoted", severity: "high", location: "src/tools/recipes.ts:90" },
    ]);
    expect(dropped).toEqual([]);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      title: IGNORED_FIELDS.title,
      location: "src/tools/recipes.ts:90",
      severity: "high",
    });
    expect(promoted[0]?.body).toContain(IGNORED_FIELDS.body);
    expect(promoted[0]?.body).toContain("https://github.test/o/r/pull/82#issuecomment-IC_one");
  });

  it("falls back to the note's location, then its permalink", () => {
    const { promoted } = applyNoteRulings(notes, [
      { noteId: "IC_one", status: "promoted", severity: "medium" },
      { noteId: "IC_two", status: "promoted", severity: "low" },
    ]);
    expect(promoted.map((f) => f.location)).toEqual([
      "src/tools/recipes.ts:88",
      "https://github.test/o/r/pull/82#issuecomment-IC_two",
    ]);
  });

  it("records a dropped note with its reason, and files nothing for it", () => {
    const { promoted, dropped } = applyNoteRulings(notes, [
      { noteId: "IC_one", status: "promoted", severity: "medium" },
      { noteId: "IC_two", status: "dropped", reason: "Already tracked in #12." },
    ]);
    expect(promoted.map((f) => f.title)).toEqual([IGNORED_FIELDS.title]);
    expect(dropped).toEqual([
      {
        title: NEW_TOOL.title,
        reason: "Already tracked in #12.",
        url: "https://github.test/o/r/pull/82#issuecomment-IC_two",
      },
    ]);
  });

  /** The safe direction: a note nobody ruled on must not disappear. */
  it("promotes a note the review said nothing about, at the default severity", () => {
    const { promoted, dropped } = applyNoteRulings(notes, []);
    expect(dropped).toEqual([]);
    expect(promoted.map((f) => [f.title, f.severity])).toEqual([
      [IGNORED_FIELDS.title, "medium"],
      [NEW_TOOL.title, "medium"],
    ]);
  });

  it("ignores a ruling on a note it was not handed, and a second ruling on one it was", () => {
    const { promoted, dropped } = applyNoteRulings(notes.slice(0, 1), [
      { noteId: "IC_invented", status: "dropped", reason: "x" },
      { noteId: "IC_one", status: "dropped", reason: "first" },
      { noteId: "IC_one", status: "promoted", severity: "high" },
    ]);
    expect(promoted).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual(["first"]);
  });
});

/**
 * The body a review posts, and what `follow-ups` files from it on merge: the
 * acceptance criteria of #213, end to end over the pure halves.
 */
describe("a note's end, in the review body and on merge", () => {
  const body = (output: ReviewOutput, notes: readonly PostedNote[]): string => {
    const ruled = applyNoteRulings(notes, output.noteRulings ?? []);
    const { followUps, dropped, moved } = recordFollowUps([], [...ruled.promoted, ...output.followUps]);
    return renderReviewBody({
      verdict: VERDICTS["approval recommended"],
      output,
      placed: [],
      movedToFollowUps: moved,
      stillOpen: [],
      resolved: [],
      followUps,
      droppedFollowUps: dropped,
      droppedNotes: ruled.dropped,
    });
  };

  const fileOnMerge = (reviewBody: string) =>
    planFollowUps({
      prNumber: 82,
      reviews: [
        {
          author: "github-actions",
          body: reviewBody,
          lastEditedAt: null,
          url: "https://github.test/o/r/pull/82#pullrequestreview-1",
        },
      ],
      stubs: [],
    });

  /** jeffwlawson/mealie-mcp-server#82, replayed: both notes are filed when the PR merges. */
  it("files both of jeffwlawson/mealie-mcp-server#82's notes as issues", () => {
    const notes = filterOutOfScopeNotes([IGNORED_FIELDS, NEW_TOOL]).map((comment, i) => {
      const note = readOutOfScopeNote(comment);
      if (note === undefined) throw new Error("the posted note did not read back");
      return posted(note, `IC_${i}`);
    });
    const output = parseReview({
      noteRulings: [
        { noteId: "IC_0", status: "promoted", severity: "medium" },
        { noteId: "IC_1", status: "promoted", severity: "low" },
      ],
    });

    const plan = fileOnMerge(body(output, notes));

    expect(plan.issues.map((issue) => issue.title)).toEqual([IGNORED_FIELDS.title, NEW_TOOL.title]);
  });

  it("shows a dropped note in the body with its reason, and files nothing for it", () => {
    const notes = [posted(IGNORED_FIELDS, "IC_one"), posted(NEW_TOOL, "IC_two")];
    const output = parseReview({
      noteRulings: [
        { noteId: "IC_one", status: "promoted", severity: "medium" },
        { noteId: "IC_two", status: "dropped", reason: "The upstream API has no shopping list endpoint." },
      ],
    });

    const posted_ = body(output, notes);

    expect(posted_).toContain("not filed");
    expect(posted_).toContain(
      `**${NEW_TOOL.title}** ([note](https://github.test/o/r/pull/82#issuecomment-IC_two)): The upstream API has no shopping list endpoint.`,
    );
    expect(fileOnMerge(posted_).issues.map((issue) => issue.title)).toEqual([IGNORED_FIELDS.title]);
  });

  /** Promoted notes count toward the review's cap, ahead of its own follow-ups. */
  it("puts a promoted note inside the follow-ups cap, ahead of the review's own", () => {
    const own = [1, 2, 3].map((n) => ({
      title: `own ${n}`,
      location: `src/own.ts:${n}`,
      body: "Evidence. Why not here.",
      severity: "medium",
    }));
    const output = parseReview({
      followUps: own,
      noteRulings: [{ noteId: "IC_one", status: "promoted", severity: "medium" }],
    });

    const plan = fileOnMerge(body(output, [posted(IGNORED_FIELDS, "IC_one")]));

    expect(plan.issues.map((issue) => issue.title)).toEqual([IGNORED_FIELDS.title, "own 1", "own 2"]);
  });

  it("renders no group where nothing was dropped", () => {
    expect(body(parseReview({}), [])).not.toContain("not filed");
  });
});
