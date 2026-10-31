/**
 * What `fix:publish` and `fix:conclude` both read of a fix run's hand-over,
 * described once, here: the rescue the runner set aside, said as the note
 * either command posts (ADR 0006). `fix:bundle`'s bundle is made and checked
 * by `shared/bundle.ts`, which update-branch bundles with too (#483).
 */
import { json, matching, object, target, type Parser } from "../shared/hand-over.js";
import { FIX_LABEL } from "../shared/record.js";
import { ignoredNote } from "../shared/rescue.js";

/** A file whose presence is the whole of it. */
export const present: Parser<true> = () => true;

/**
 * `rescue_ignored.json`: the rescue branch the runner set aside because the
 * pull request's head moved since it was saved (#303), which has to be this
 * pull request's, and the commit it moved past.
 */
export const rescueIgnored = (rescueBranch: string) =>
  json(
    object({
      branch: target(new Set([rescueBranch]), `this pull request's rescue branch, \`${rescueBranch}\``),
      movedPast: matching(/[0-9a-f]{40}/, "a full commit id"),
    }),
  );

/** The note that says so on the pull request, however the run ended. */
export const setAsideNote = (branch: string): string => ignoredNote(FIX_LABEL, branch, "this pull request's head");
