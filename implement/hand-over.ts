/**
 * What `implement:conclude` reads of an implement run's hand-over beside its
 * reasons, described once, here (ADR 0006): the bundle's presence, and the
 * rescue the runner set aside (#270), said as the note conclude posts. The
 * bundle itself is checked by `shared/bundle.ts`.
 */
import { json, matching, object, target, type Parser } from "../shared/hand-over.js";
import { IMPLEMENT_LABEL } from "../shared/record.js";
import { ignoredNote } from "../shared/rescue.js";

/** A file read for being there, and nothing more: the bundle's bytes are git's to check. */
export const present: Parser<true> = () => true;

/**
 * `rescue_ignored.json`: the rescue branch the runner set aside because the
 * base moved since it was saved (#270), which has to be this issue's, and the
 * commit it moved past.
 */
export const rescueIgnored = (rescueBranch: string) =>
  json(
    object({
      branch: target(new Set([rescueBranch]), `this issue's rescue branch, \`${rescueBranch}\``),
      movedPast: matching(/[0-9a-f]{40}/, "a full commit id"),
    }),
  );

/** The note that says so on the issue, however the run ended: `base` is the base branch, which moved. */
export const setAsideNote = (branch: string, base: string): string => ignoredNote(IMPLEMENT_LABEL, branch, `\`${base}\``);
