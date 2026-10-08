import { FIX_BEFORE_MERGE_LABEL, type Finding } from "../shared/review-findings.js";
import type { CriterionResult, CriterionRuling } from "../shared/review-output.js";

/**
 * The linked issue's acceptance criteria, checked one by one by every review
 * of a pull request that has a linked issue (#214).
 *
 * Read here, from the issue's text, rather than left to the model to find: the
 * list the review rules on is then the list the body shows, and a criterion
 * the review skipped is visible as skipped instead of absent. The review
 * reports each as met, changed on purpose with the reason, or unmet; an unmet
 * one is a fix-before-merge finding like any other.
 */

/** The id a criterion is handed to the review under, and a ruling names it by. */
export const criterionId = (index: number): string => `C${index + 1}`;

const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
/** A bold label on a line of its own, as a brief writes `**Acceptance criteria:**`. */
const LABEL = /^ {0,3}\*\*([^*]+?)\*\*:?\s*$/;
const FENCE = /^ {0,3}(?:```|~~~)/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const CHECKLIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+(.*)$/;
const ACCEPTANCE = /\bacceptance\b/i;

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? "").length;

/**
 * The items of one section's list: an item at the list's outer indent starts a
 * criterion, and anything indented deeper (a wrapped line, a nested item) is
 * part of the one above it. A paragraph back at the outer indent ends it.
 */
const listItems = (lines: readonly string[]): string[] => {
  const outer = Math.min(
    ...lines.filter((line) => ITEM.test(line)).map(indentOf),
    Number.POSITIVE_INFINITY,
  );
  const items: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const item = ITEM.exec(line);
    if (item !== null && indentOf(line) === outer) {
      current = [item[2] ?? ""];
      items.push(current);
    } else if (current !== undefined && indentOf(line) > outer) {
      current.push(item === null ? line : (item[2] ?? ""));
    } else {
      current = undefined;
    }
  }
  return items.map((parts) => parts.map((part) => part.trim()).join(" ").trim()).filter(Boolean);
};

/** A text's lines with everything inside a code fence removed. */
const unfenced = (text: string): string[] => {
  let fenced = false;
  return text.split(/\r?\n/).filter((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
};

/** The items of the last acceptance section in one text that lists any, or `undefined`. */
const acceptanceSection = (lines: readonly string[]): string[] | undefined => {
  const sections: string[][] = [];
  let section: string[] | undefined;
  for (const line of lines) {
    const title = HEADING.exec(line)?.[1] ?? LABEL.exec(line)?.[1];
    if (title !== undefined) {
      section = ACCEPTANCE.test(title) ? [] : undefined;
      if (section !== undefined) sections.push(section);
      continue;
    }
    section?.push(line);
  }
  return sections
    .map(listItems)
    .filter((items) => items.length > 0)
    .at(-1);
};

/**
 * The criteria of a linked issue: the items of its **acceptance section**, or
 * where it has none with any items, every **checklist** item in its body.
 * Nothing otherwise, which is the case the review's section is omitted for.
 *
 * A section opens at a heading or a bold label on a line of its own naming
 * *acceptance*, and runs to the next of either. It is looked for in the body
 * and then in `comments`, the issue's trusted comments oldest first, and the
 * **last** one found wins: triage posts its brief as a comment on the issue as
 * filed (or appends it to the body), and the brief's criteria are the ones the
 * work was scoped to, superseding the body's own. The checklist fallback reads
 * the body only, since a checklist in a comment is somebody's notes rather
 * than the issue asking for anything. Nothing inside a code fence is read, for
 * the same reason: a quoted template is not a request.
 */
export const extractCriteria = (body: string, comments: readonly string[] = []): string[] => {
  const bodyLines = unfenced(body);
  const fromSection = [bodyLines, ...comments.map(unfenced)]
    .map(acceptanceSection)
    .filter((items) => items !== undefined)
    .at(-1);
  if (fromSection !== undefined) return fromSection;

  return bodyLines
    .map((line) => CHECKLIST_ITEM.exec(line)?.[1]?.trim() ?? "")
    .filter((item) => item !== "");
};

const NO_CRITERIA =
  "(The linked issue names no acceptance criteria this workflow could identify, or there is no linked issue, so there is nothing to rule on: leave `criteria` empty.)";

/**
 * The criteria as the review agent is shown them, each under the id a ruling
 * names, then the pull request's body: some criteria are about the pull
 * request itself ("the description says which tests…"), and those are checked
 * against its title and body.
 */
export const renderCriteriaForReview = (criteria: readonly string[], prBody: string): string => {
  if (criteria.length === 0) return NO_CRITERIA;
  const quoted = prBody.trim() === "" ? "> (empty)" : prBody.trim().split(/\r?\n/).map((line) => `> ${line}`.trimEnd()).join("\n");
  return [
    criteria.map((text, index) => `- \`${criterionId(index)}\`: ${text}`).join("\n"),
    "The pull request's body as it stands, for the criteria about the pull request itself:",
    quoted,
  ].join("\n\n");
};

/**
 * The review's rulings, made into the body's list and the findings they add.
 *
 * Every criterion handed over is listed once, in the issue's order. A ruling
 * naming a criterion the review was not handed is dropped, the first ruling on
 * one is the one kept, and one nobody ruled on is listed as **not checked**
 * rather than left out. An **unmet** criterion is a fix-before-merge finding at
 * the anchor the review gave it; a **changed** one is not, and carries its
 * reason instead.
 */
export const applyCriteriaRulings = (
  criteria: readonly string[],
  rulings: readonly CriterionRuling[],
): { results: CriterionResult[]; findings: Finding[] } => {
  const ids = new Set(criteria.map((_, index) => criterionId(index)));
  const ruled = new Map<string, CriterionRuling>();
  for (const ruling of rulings) {
    if (!ids.has(ruling.id)) {
      console.warn(`Dropping a ruling on criterion ${ruling.id}, which this review was not handed.`);
      continue;
    }
    if (ruled.has(ruling.id)) {
      console.warn(`Dropping a second ruling on criterion ${ruling.id}.`);
      continue;
    }
    ruled.set(ruling.id, ruling);
  }

  const results: CriterionResult[] = [];
  const findings: Finding[] = [];
  criteria.forEach((text, index) => {
    const id = criterionId(index);
    const ruling = ruled.get(id);
    if (ruling === undefined) {
      results.push({ id, text, status: "unchecked" });
      return;
    }
    const reason = ruling.status === "met" ? undefined : ruling.reason;
    results.push({ id, text, status: ruling.status, ...(reason === undefined ? {} : { reason }) });
    if (ruling.status === "unmet") {
      findings.push({
        title: `Acceptance criterion not met: ${text}`,
        path: ruling.path,
        line: ruling.line,
        severity: ruling.severity,
        body: [
          `**${FIX_BEFORE_MERGE_LABEL}.** The linked issue's acceptance criterion is not met: "${text}".`,
          ruling.reason,
          "If this pull request departs from it on purpose, say why in its body, and the next review records the criterion as changed.",
        ]
          .filter((part) => part !== undefined && part !== "")
          .join(" "),
      });
    }
  });
  return { results, findings };
};
