/**
 * What `implement-prd:publish` and `implement-prd:conclude` both read of an
 * implement-prd run's hand-over, described once, here (ADR 0006): the gate's
 * snapshot of the PRD, the bundle's presence, and the rescue the runner set
 * aside, said as the note conclude posts. The bundle itself is checked by
 * `shared/bundle.ts`.
 */
import { choice, count, json, list, matching, nullable, object, target, text, type Parser } from "../shared/hand-over.js";
import { IMPLEMENT_LABEL } from "../shared/record.js";
import { ignoredNote } from "../shared/rescue.js";

/** A file read for being there, and nothing more: the bundle's bytes are git's to check. */
export const present: Parser<true> = () => true;

/**
 * The gate's snapshot of the PRD, `prd-issue.json`, in the shape it writes:
 * the sub-issues every branch of the gate ruled on, in the list's order, of
 * which the progress list and the `Closes` block read the numbers and states.
 */
export const SNAPSHOT = json(
  object({
    parent: nullable(count({ min: 1, max: Number.MAX_SAFE_INTEGER })),
    labels: object({ nodes: list(object({ name: text }), { max: 100 }) }),
    subIssues: object({
      totalCount: count({ min: 0, max: 100 }),
      nodes: list(
        object({ number: count({ min: 1, max: Number.MAX_SAFE_INTEGER }), title: text, state: choice(["OPEN", "CLOSED"] as const) }),
        { max: 100 },
      ),
    }),
  }),
);

/**
 * `rescue_ignored.json`: the rescue branch the runner set aside because the
 * PRD branch moved since it was saved (#303), which has to be this PRD's,
 * and the commit it moved past.
 */
export const rescueIgnored = (rescueBranch: string) =>
  json(
    object({
      branch: target(new Set([rescueBranch]), `this PRD's rescue branch, \`${rescueBranch}\``),
      movedPast: matching(/[0-9a-f]{40}/, "a full commit id"),
    }),
  );

/** The note that says so on the PRD, however the run ended. */
export const setAsideNote = (branch: string): string => ignoredNote(IMPLEMENT_LABEL, branch, "the PRD branch");
