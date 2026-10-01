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
 * to hand the agent what it says now. **Written** by the posting job, against
 * the body as it stands when the review is posted rather than as it was read
 * here: a review spends minutes waiting on CI, and a maintainer's edit in that
 * window is outside the block and must survive it. So the splice is the posting
 * job's, and this file hands it the markers to find rather than the posting job
 * keeping a second copy of them.
 */

export const SUMMARY_START = "<!-- agent:summary -->";
export const SUMMARY_END = "<!-- /agent:summary -->";

/**
 * The head a summary was written at, as the first line inside the block. What
 * the update rule reads: a summary is rewritten when the pull request has moved
 * since, and left alone when it has not.
 *
 * In the block rather than read off the verdict history, which says whether a
 * *verdict* has seen the commits rather than whether a *summary* has: a review
 * whose summary write failed, or one from before the block existed, would
 * leave a block no later review ever filled.
 */
const HEAD_MARK = /<!-- agent:summary-head ([0-9a-f]{7,64}) -->\r?\n?/g;

const headMark = (sha: string): string => `<!-- agent:summary-head ${sha} -->`;

/**
 * Written inside the block by a PRD PR's **final review** (#247), beside the
 * head mark. The last slice round wrote the block at the same head the final
 * review reads, so the head alone would leave the final review's title and PRD
 * sections unwritten: a block without this mark is due to the final review
 * whatever head it was written at.
 */
export const FINAL_SUMMARY_MARK = "<!-- agent:summary-final -->";

const FINAL_MARK = /<!-- agent:summary-final -->\r?\n?/g;

/**
 * The PRD PR frame's **draft-only** text (#247): the note that the PR stays a
 * draft until every slice is done, between these markers, which the opening
 * run writes and the final review's write of the summary removes, markers and
 * all. Once the final review runs every slice is done, and a ready PRD PR
 * carries nothing that says otherwise. Held equal to `implement-prd.yml`'s
 * frame by a test.
 */
export const DRAFT_NOTE_START = "<!-- agent:draft-note -->";
export const DRAFT_NOTE_END = "<!-- /agent:draft-note -->";

/**
 * The block's text, and the head it was written at where a review wrote it.
 * `undefined` where the body has no block, or half of one: exactly one start
 * marker with exactly one end marker after it is a block, and anything else is
 * not one this file will say what is inside of. The posting job applies the
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
 * the posting job decides what it can do with the body.
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
 * What the posting job writes, from what the review produced: the title, and
 * the block's new inner text with the markers it goes between. Either half is
 * left out where the review wrote none, and `undefined` is "write nothing".
 */
export interface SummaryUpdate {
  readonly title?: string;
  readonly summary?: { readonly start: string; readonly end: string; readonly inner: string };
  /**
   * Draft-only text to remove from the body, markers and all, where the body
   * carries exactly one such block (#247). Only the final review's update has
   * it.
   */
  readonly drop?: { readonly start: string; readonly end: string };
}

export const summaryUpdate = (
  written: { readonly title?: string; readonly summary?: string },
  headSha: string,
  final = false,
): SummaryUpdate | undefined => {
  const update: SummaryUpdate = {
    ...(written.title === undefined ? {} : { title: written.title }),
    ...(written.summary === undefined
      ? {}
      : {
          summary: {
            start: SUMMARY_START,
            end: SUMMARY_END,
            inner: `${headMark(headSha)}\n${final ? `${FINAL_SUMMARY_MARK}\n` : ""}${written.summary}`,
          },
        }),
  };
  if (update.title === undefined && update.summary === undefined) return undefined;
  return final ? { ...update, drop: { start: DRAFT_NOTE_START, end: DRAFT_NOTE_END } } : update;
};
