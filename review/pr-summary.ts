import {
  FINAL_SUMMARY_MARK,
  SUMMARY_END,
  SUMMARY_START,
  summaryHeadMark,
} from "../shared/record.js";

/**
 * The **summary block** in a pull request's body (#218): the one part of the
 * body the review writes, between two markers the opening run put there.
 *
 * The body is otherwise the opening run's **frame** (`Closes #N`, a note on
 * what the loop does, and on a PRD PR the `Closes` block and the progress
 * list) and whatever a maintainer added. The review owns the block and nothing else, so text outside
 * the markers survives every update byte for byte.
 *
 * Read here, in the review job, to decide whether this review rewrites it and
 * to hand the agent what it says now. **Written** by `review:publish`, against
 * the body as it stands when the review is posted rather than as it was read
 * here: a review spends minutes waiting on CI, and a maintainer's edit in that
 * window is outside the block and must survive it. So the splice is publish's,
 * through the engine's live edit, and the markers are `shared/record.ts`'s.
 */

/**
 * The head a summary was written at (`summaryHeadMark`), read back.
 *
 * In the block rather than read off the verdict history, which says whether a
 * *verdict* has seen the commits rather than whether a *summary* has: a review
 * whose summary write failed, or one from before the block existed, would
 * leave a block no later review ever filled.
 */
const HEAD_MARK = /<!-- agent:summary-head ([0-9a-f]{7,64}) -->\r?\n?/g;

const FINAL_MARK = /<!-- agent:summary-final -->\r?\n?/g;

/**
 * The block's text, and the head it was written at where a review wrote it.
 * `undefined` where the body has no block, or half of one: exactly one start
 * marker with exactly one end marker after it is a block, and anything else is
 * not one this file will say what is inside of. `review:publish` splices by the
 * same rule, so the two cannot disagree about which text is the review's.
 */
export const readSummaryBlock = (
  body: string,
): { readonly text: string; readonly head?: string; readonly final: boolean } | undefined => {
  const starts = body.split(SUMMARY_START);
  const ends = body.split(SUMMARY_END);
  if (starts.length !== 2 || ends.length !== 2) return undefined;

  const after = starts[1] ?? "";
  const end = after.indexOf(SUMMARY_END);
  if (end < 0) return undefined;

  const inner = after.slice(0, end);
  const heads = [...inner.matchAll(HEAD_MARK)].map((match) => match[1] ?? "");
  const final = inner.includes(FINAL_SUMMARY_MARK);
  const text = inner.replace(HEAD_MARK, "").replace(FINAL_MARK, "").trim();
  const head = heads[heads.length - 1];
  return head === undefined ? { text, final } : { text, head, final };
};

/**
 * Whether this review writes the title and the summary: **anything was pushed
 * since the summary was last written**. That is the first build, a
 * maintainer's push, a conflict resolution and a fix round alike; a review with
 * nothing pushed since leaves both as they are.
 *
 * A block no review has written yet, a body with no block at all, and a broken
 * one all read as due. The title is written in every one of those cases, and
 * `review:publish` decides what it can do with the body.
 *
 * And for a PRD PR's **final review**, a block no final review wrote (#247):
 * the last slice round wrote it at this same head, about one slice.
 */
export const summaryDue = (body: string, headSha: string, final = false): boolean => {
  const block = readSummaryBlock(body);
  return block?.head !== headSha || (final && !block.final);
};

/**
 * The block as the agent is handed it: what it says now, a maintainer's edit
 * included, which the agent carries forward where it is still true.
 */
export const currentSummary = (body: string): string => {
  const block = readSummaryBlock(body);
  if (block === undefined) return "(this pull request's body has no summary block)";
  return block.text === "" ? "(empty)" : block.text;
};

/**
 * The block as `review:publish` writes it, from the text it laid out (ADR
 * 0007): the markers, the head the summary was written at, and on a PRD PR's
 * final review its mark (#247), then the text.
 */
export const summaryBlock = (text: string, headSha: string, final: boolean): string =>
  `${SUMMARY_START}\n${summaryHeadMark(headSha)}\n${final ? `${FINAL_SUMMARY_MARK}\n` : ""}${text}\n${SUMMARY_END}`;

/**
 * Which of the four ways a review stands to the title and the summary (#218,
 * #247, #298): a slice round of a PRD of more than one slice leaves them for
 * the final review; a review with nothing pushed since the summary was last
 * written leaves them as they are; the final review writes the whole PRD's;
 * and any other review writes them.
 */
export type SummaryRound = "slice" | "unchanged" | "final" | "writes";

/** What the brief says of the title and the summary, for each of the four. */
export const SUMMARY_RULES: Readonly<Record<SummaryRound, string>> = {
  slice:
    "**This review leaves them as they are.** This is a slice round, and the final review writes the pull request's title and summary for the whole PRD, so the workflow writes neither; omit both fields.",
  unchanged:
    "**This review leaves them as they are.** Nothing was pushed since the summary was last written, so the workflow writes neither; omit both fields.",
  final:
    "**This review writes them.** It is the final review, so the workflow replaces the title and the summary block with yours, laid out as the section below says.",
  writes:
    "**This review writes them.** Something was pushed since the summary was last written, so the workflow replaces the title and the summary block with yours.",
};

/**
 * The final review's summary shape (#247, #356). The review writes the
 * outcome, and the Merge Danger's fields as every summary write does; the
 * workflow adds the *Differs from the PRD* lines and the Evidence from the
 * slice rounds' records, and the known issues from this review's follow-ups.
 */
export const FINAL_SUMMARY_SHAPE = [
  "**This is the final review of a PRD PR, so the summary is the whole PRD's**, in the layout the summary section above describes. Write:",
  "",
  "- **`summary`**: the **outcome**, what the PRD delivered as a whole. Open it as the summary section above asks, with the **smallest view that makes the point**: zero, one or two sketches of the whole change, drawn from the diff as it stands and never from the PRD, each beside the short text it supports. Then a few sentences, brief and with no preamble, and a bullet per behaviour the PRD changes, cut to what the sketches do not already show; sketches do not count against the word budget, which stays for the prose. Nothing about the review, and no list of slices: the body already shows them.",
  "- **`door`**, **`blastRadius`**, their notes and **`breaking`**: as the summary section above asks, of the whole PRD. A breaking change goes in `breaking`, never in a bullet.",
  "",
  "A **Differs from the PRD:** line for each slice that changed or dropped one of its criteria, and the Evidence (each slice's failing-first tests, where the red check is configured, beside CI's result), are added from each slice round's record, and the known issues from the follow-ups this review records, so write none of them. The title is the whole PRD's, never the PRD issue's title copied. Nothing in what you write may say the pull request is a draft or that slices are still to come: every slice is built.",
].join("\n");

/**
 * The brief's *THE TITLE AND THE SUMMARY* section, below its heading (#781,
 * audit #704 H4, stage 2). A review that writes the title and the summary is
 * handed every rule for them, the Merge Danger's included, with what the block
 * says now; one that omits them is handed the one line saying so, since each
 * rule is about fields it does not write. `current` is `currentSummary`'s.
 */
export const renderSummarySection = (round: SummaryRound, current: string): string => {
  if (round === "slice" || round === "unchanged") return SUMMARY_RULES[round];
  const rules = `The pull request's body carries a **summary block**, the one part of it the workflow lets a review
write. The block says, now:

${current}

The title, now, is the one at the top of this brief.

${SUMMARY_RULES[round]}

**\`summary\`** is about **what was built, not what was asked**.

It opens with the **smallest view that makes the point**: zero, one or two sketches, each beside the
short text it supports. A sketch is one of:

- a \`diff\` of a call tree, a file tree, a state or a control flow;
- pseudocode;
- a call tree;
- a component tree;
- a Mermaid diagram.

Prefer a \`diff\` when the surrounding shape already exists: its added and removed lines are the
change, and its unchanged ones say where it sits. Most changes need one sketch; some need none, and
a change one sentence explains is one of them. Draw each sketch **from the diff as it stands, never
from the issue**: the issue is what was asked, and a sketch of it can show a change the reader is
not merging. Keep only the calls, files and states the point needs. Put each in a fenced code block
(\`mermaid\` for a Mermaid diagram).

The prose beside the sketches covers:

- what the change does;
- the behaviour it changes, cut to what the sketches do not already show.

A breaking change is not marked in the prose: it goes in \`breaking\`, under **Merge Danger** below.

Where the change does something other than what the linked issue asked, add one line led by
**Differs from the issue:**, with the reason. Say it plainly even where the reason is good: a reader
deciding whether to merge needs to know the change is not the one the issue describes. Leave the
line out when nothing differs.

Keep the prose brief, in Markdown, with no preamble, under about 150 words. Sketches do not count
against those words. Where the project's own docs define a domain term for
something, use that term rather than a word of your own. Describe the pull request as it
stands now, all of it, and not only the commits since the last summary. Where the block already
says something (an earlier review's summary, or a maintainer's edit to it), treat it as **input**:
keep what is still true, in its words where they still fit, and correct whatever the code now
contradicts.

\`summary\` ends before \`## Evidence\`: the workflow lays out the Evidence and the Merge Danger after
it. The **Evidence** is what the red check's report found failing before this change, beside CI's
result now. Where the report lists tests as red, you may sketch what up to three of them check in
\`testSketches\`, as the extraction step describes; a sketch of any other test is dropped.

The **Merge Danger**, at a \`## Merge Danger\` heading, is laid out from fields you write beside
\`summary\`, and its **known issues** from your \`followUps\`, which are filed when it merges. Write:

- **\`door\`**: \`one-way\` or \`two-way\`. A **one-way door is one a revert cannot undo**: a published
  release, deleted data, a migration. Anything a revert restores is two-way, however many it reaches
  and however soon. Keep the two questions apart: a change cheap to revert whose danger is *when* it
  takes effect, live the moment it merges, is a two-way door with a wide blast radius.
- **\`doorNote\`**: only for a one-way door, saying what a revert leaves behind, or a two-way door
  with a catch.
- **\`blastRadius\`**: **one word** for who or what the change reaches, in the project's own terms.
- **\`blastRadiusNote\`**: who is reached, and **from when**: on merge, or at the next release. Name
  what is reached on merge only where something is (a file read from the default branch, rather
  than from a release, is live the moment it merges).
- **\`breaking\`**: one line per change a caller or a user has to act on, saying what they must do.
  An empty list where there is none.

**\`title\`** is one line, true of the change as it now stands. Use the commit convention \`CLAUDE.md\`
names, if it names one; otherwise conventional-commit style, \`type(scope): subject\`, with the scope
optional. The **type comes from what the diff does**, not from the issue's title: a change the issue
called a fix that adds a capability is \`feat\`. It is not the issue's title copied, and a title a
maintainer edited is input in the same way the block is. A squash merge may land this line as the
commit subject, so write it as one.`;
  return round === "final" ? `${rules}\n\n${FINAL_SUMMARY_SHAPE}` : rules;
};
