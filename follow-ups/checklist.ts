import type { AuthoredText } from "../engine/read.js";
import { briefItems, readBrief } from "../review/acceptance-criteria.js";
import { clean } from "../shared/clean.js";
import { isTrustedAuthor } from "../shared/common.js";
import { isWorkflowBot, type LoopAccounts } from "../shared/loop-accounts.js";
import { POST_MERGE_CHECKLIST_MARK } from "../shared/record.js";

/**
 * The **post-merge checklist** (#544): every *After merge, by a human* item
 * the linked briefs left, posted once on the merged pull request. Everything
 * gathered in, the comment to post out, and no I/O in between, as
 * `planFollowUps` is for the filing.
 *
 * Each issue's items come from its **latest brief**, the text the review takes
 * its acceptance criteria from (`readBrief`), so the checklist and the criteria
 * cannot name different briefs, and a re-brief that drops the section drops its
 * items. Only text an author `isTrustedAuthor` passes is read: an untrusted
 * issue's body never is, and its trusted comments still are, as for criteria
 * (#444). Every item is `clean`ed before it is formatted, so no HTML comment,
 * and so no forged marker, reaches the comment.
 */

/** The heading, or bold label, an item list is read under: case and a trailing colon ignored. */
const AFTER_MERGE = /^\s*after merge,\s*by a human\s*:?\s*$/i;

/** One linked issue, as `follow-ups:file` reads it, in the order the checklist lists it. */
export interface ChecklistIssue {
  readonly number: number;
  readonly body: AuthoredText;
  /** Its comments, oldest first. */
  readonly comments: readonly AuthoredText[];
}

export interface ChecklistInput {
  /** The linked issues: the one a pull request closes, or a PRD's parent and then each sub-issue. */
  readonly issues: readonly ChecklistIssue[];
  /** The comments already on the pull request, oldest first. */
  readonly existing: readonly AuthoredText[];
}

export type ChecklistPlan =
  /** No linked issue left an item. */
  | { readonly kind: "none" }
  /** One of the loop's accounts already posted the checklist. */
  | { readonly kind: "posted" }
  | { readonly kind: "post"; readonly body: string };

export const OPENING =
  "**After merge, by a human.** The linked briefs left these checks for a person to make now that this pull request has merged.";

export const planChecklist = (input: ChecklistInput, accounts: LoopAccounts): ChecklistPlan => {
  const trusted = (text: AuthoredText): boolean => isTrustedAuthor(text.association, text.author, accounts);
  const groups = input.issues.flatMap((issue) => {
    const brief = readBrief(
      trusted(issue.body) ? issue.body.body : "",
      issue.comments.filter(trusted).map((comment) => comment.body),
    );
    const items = briefItems(brief, AFTER_MERGE)
      .map((item) => clean(item).trim())
      .filter((item) => item !== "");
    return items.length === 0 ? [] : [{ number: issue.number, items }];
  });
  if (groups.length === 0) return { kind: "none" };

  // The marker alone is not enough: anyone who can comment can type it.
  const posted = input.existing.some((comment) => comment.body.includes(POST_MERGE_CHECKLIST_MARK) && isWorkflowBot(comment.author, accounts));
  if (posted) return { kind: "posted" };

  return {
    kind: "post",
    body: [
      OPENING,
      ...groups.map((group) => [`From #${group.number}:`, ...group.items.map((item) => `- [ ] ${item}`)].join("\n")),
      POST_MERGE_CHECKLIST_MARK,
    ].join("\n\n"),
  };
};
