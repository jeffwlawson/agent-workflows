import type { FollowUp, ReviewOutput } from "./review-output.js";

/**
 * The **Merge Danger** a pull request's body gives (#356), the last section of
 * the summary block, after the Evidence: the last thing read before merging.
 *
 * Rendered here from fields the review returns rather than written by it, so
 * it is on every summary write, regular and PRD, laid out the same:
 *
 *  - the **door**: whether a revert undoes the change, and a note where it is
 *    one-way or two-way with a catch;
 *  - the **blast radius**: one word, and a note saying who is reached and
 *    from when;
 *  - a **Breaking:** line per change a caller or a user has to act on;
 *  - the **known issues**, the follow-ups this review records, which are filed
 *    as issues when the pull request merges.
 *
 * The last two are left out when there are none; the door and the blast
 * radius never are, and say so where the review gave none.
 */
export const MERGE_DANGER_HEADING = "## Merge Danger";

export type MergeDanger = Pick<ReviewOutput, "door" | "doorNote" | "blastRadius" | "blastRadiusNote" | "breaking">;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A model's text cannot open a comment, so it cannot forge or close one of the body's markers. */
const defused = (text: string): string => text.replaceAll("<!--", "<​!--");

export const renderMergeDanger = (danger: MergeDanger, followUps: readonly FollowUp[]): string => {
  const parts = [
    MERGE_DANGER_HEADING,
    `**Door:** ${danger.door ?? "not given. The review did not say whether a revert undoes this change."}`,
    ...(danger.doorNote === undefined ? [] : [danger.doorNote]),
    `**Blast Radius:** ${danger.blastRadius ?? "not given. The review did not say who this change reaches."}`,
    ...(danger.blastRadiusNote === undefined ? [] : [danger.blastRadiusNote]),
    ...(danger.breaking ?? []).map((line) => `**Breaking:** ${line}`),
    ...(followUps.length === 0
      ? []
      : [
          [
            "**Known issues**, filed when this merges:",
            "",
            ...followUps.map((f) => `- ${oneLine(f.title)} (\`${oneLine(f.location)}\`)`),
          ].join("\n"),
        ]),
  ];
  return defused(parts.join("\n\n"));
};
