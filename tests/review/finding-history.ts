import * as fs from "node:fs";
import * as path from "node:path";
import { renderNotesForReview } from "../../shared/fix-notes.js";
import { renderCarriedFindings, renderSettledFindings } from "../../shared/review-verification.js";

/**
 * The review prompt's three finding-history sections as a review with
 * something under each is handed them (#749, audit #704 H4): one open finding,
 * one settled finding and one fix note, each filled in by the renderer the
 * runner fills it with (`review/review.ts`). Their rules ride with the
 * placeholder and are printed only where there is something to rule on, so a
 * test about those rules reads this rather than the static file.
 */
export const LIVE_FINDING_HISTORY = {
  OPEN_FINDINGS: renderCarriedFindings([
    { id: "f-1", threadId: "PRRT_one", text: "src/queue.ts:206 · the guard runs after the return", title: "the guard runs after the return", anchor: "src/queue.ts:206" },
  ]),
  SETTLED_FINDINGS: renderSettledFindings([
    { findingId: "f-0", resolvedBy: "maintainer", text: "src/cache.ts:12 · the cache key omits the tenant" },
  ]),
  FIX_NOTES: renderNotesForReview([
    { noteId: "IC_one", title: "Two tool parameters send fields the API ignores", body: "`update_recipe` sends them.", location: "src/tools/recipes.ts:88" },
  ]),
} as const;

/** The same three, empty: what nearly every review is handed. */
export const EMPTY_FINDING_HISTORY = {
  OPEN_FINDINGS: renderCarriedFindings([]),
  SETTLED_FINDINGS: renderSettledFindings([]),
  FIX_NOTES: renderNotesForReview([]),
} as const;

export const REVIEW_PROMPT = fs.readFileSync(path.join("review", "prompt.md"), "utf8");

/** The review prompt with the three placeholders filled; every other placeholder is left as it is. */
export const withFindingHistory = (inputs: Readonly<Record<keyof typeof LIVE_FINDING_HISTORY, string>>): string =>
  REVIEW_PROMPT.replace(/\{\{(OPEN_FINDINGS|SETTLED_FINDINGS|FIX_NOTES)\}\}/g, (_match, key: keyof typeof inputs) => inputs[key]);
