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

/**
 * Every section of one text whose title `title` matches, in order. A section
 * opens at a heading, or a bold label on a line of its own, and runs to the
 * next of either.
 */
const sectionsTitled = (lines: readonly string[], title: RegExp): string[][] => {
  const sections: string[][] = [];
  let section: string[] | undefined;
  for (const line of lines) {
    const found = HEADING.exec(line)?.[1] ?? LABEL.exec(line)?.[1];
    if (found !== undefined) {
      section = title.test(found) ? [] : undefined;
      if (section !== undefined) sections.push(section);
      continue;
    }
    section?.push(line);
  }
  return sections;
};

/** The items of the last acceptance section in one text that lists any, or `undefined`. */
const acceptanceSection = (lines: readonly string[]): string[] | undefined =>
  sectionsTitled(lines, ACCEPTANCE)
    .map(listItems)
    .filter((items) => items.length > 0)
    .at(-1);

/**
 * The linked issue's **brief**: the one text its criteria are read from, and
 * every other section of it a workflow reads (#541). `lines` are that text's,
 * with code fences removed; `criteria` are its acceptance items.
 */
export interface Brief {
  readonly lines: readonly string[];
  readonly criteria: readonly string[];
}

/**
 * The brief of a linked issue: the **last** of its body and `comments` (its
 * trusted comments, oldest first) with an **acceptance section** that lists
 * any items, and those items. Where none has one, the body, and every
 * **checklist** item in it. With neither, the body and no criteria, which is
 * the case the review's section is omitted for.
 *
 * A section opens at a heading or a bold label on a line of its own naming
 * *acceptance*, and runs to the next of either. The last one found wins:
 * triage posts its brief as a comment on the issue as filed (or appends it to
 * the body), and the brief's criteria are the ones the work was scoped to,
 * superseding the body's own. The checklist fallback reads the body only,
 * since a checklist in a comment is somebody's notes rather than the issue
 * asking for anything. Nothing inside a code fence is read, for the same
 * reason: a quoted template is not a request.
 *
 * The one reader of "the latest brief": a section of it is read with
 * `briefSection`, so every section comes from the text the criteria did.
 */
export const readBrief = (body: string, comments: readonly string[] = []): Brief => {
  const bodyLines = unfenced(body);
  const fromSection = [bodyLines, ...comments.map(unfenced)]
    .flatMap((lines): Brief[] => {
      const criteria = acceptanceSection(lines);
      return criteria === undefined ? [] : [{ lines, criteria }];
    })
    .at(-1);
  if (fromSection !== undefined) return fromSection;

  return {
    lines: bodyLines,
    criteria: bodyLines.map((line) => CHECKLIST_ITEM.exec(line)?.[1]?.trim() ?? "").filter((item) => item !== ""),
  };
};

/** The criteria of a linked issue, as `readBrief` reads them. */
export const extractCriteria = (body: string, comments: readonly string[] = []): string[] => [
  ...readBrief(body, comments).criteria,
];

/**
 * The lines of the brief's last section whose heading or bold label `title`
 * matches, and that holds anything but blank lines, or `undefined` where it
 * has none.
 */
export const briefSection = (brief: Brief, title: RegExp): string[] | undefined =>
  sectionsTitled(brief.lines, title)
    .filter((lines) => lines.some((line) => line.trim() !== ""))
    .at(-1);

/**
 * The list items of the brief's last section `title` names, read as criteria
 * are: a wrapped or nested line belongs to the item above it. Empty where the
 * brief has no such section, or the section lists nothing.
 */
export const briefItems = (brief: Brief, title: RegExp): string[] =>
  listItems(
    sectionsTitled(brief.lines, title)
      .filter((lines) => listItems(lines).length > 0)
      .at(-1) ?? [],
  );

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
 * the anchor the review gave it, which meets the repository's fix threshold
 * whatever its severity (#616); a **changed** one is not, and carries its
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
        // Whatever it was rated (#616): an approval over a criterion this
        // review says is unmet is the contradiction the threshold must not make.
        alwaysMeets: true,
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
