import { describe, expect, it } from "vitest";
import { FINAL_SUMMARY_SHAPE, renderSummarySection, SUMMARY_RULES, type SummaryRound } from "../../review/pr-summary.js";
import { filled } from "./branch-rules.js";
import { REVIEW_PROMPT } from "./finding-history.js";

/**
 * The title-and-summary rules are printed only where the review writes the
 * title and the summary (#781, audit #704 H4, stage 2): they ride with the
 * section's placeholder, which the runner fills (`review/review.ts`), so a
 * review that omits both fields is handed the heading and the one line saying
 * so, and one that writes them is handed what the static prompt printed before.
 */

/** A section of a prompt, from its heading to the next. */
const section = (prompt: string): string =>
  prompt.match(/^# THE TITLE AND THE SUMMARY\n.*?(?=^# )/ms)?.[0] ?? "";

/** The section as `review/prompt.md` held it before #781, kept as it was. */
const BEFORE = `# THE TITLE AND THE SUMMARY

The pull request's body carries a **summary block**, the one part of it the workflow lets a review
write. The block says, now:

{{CURRENT_SUMMARY}}

The title, now, is the one at the top of this brief.

{{SUMMARY_RULE}}

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
commit subject, so write it as one.

{{FINAL_SUMMARY}}

`;

/** What the runner filled `SUMMARY_RULE` with before #781, for each round, kept as it was. */
const BEFORE_RULES: Record<SummaryRound, string> = {
  slice:
    "**This review leaves them as they are.** This is a slice round, and the final review writes the pull request's title and summary for the whole PRD, so the workflow writes neither; omit both fields.",
  unchanged:
    "**This review leaves them as they are.** Nothing was pushed since the summary was last written, so the workflow writes neither; omit both fields.",
  final:
    "**This review writes them.** It is the final review, so the workflow replaces the title and the summary block with yours, laid out as the section below says.",
  writes:
    "**This review writes them.** Something was pushed since the summary was last written, so the workflow replaces the title and the summary block with yours.",
};

const CURRENT = "Adds a lease to the queue.";

/** The static section, filled as the runner filled it before #781. */
const before = (round: SummaryRound): string =>
  BEFORE.replace("{{CURRENT_SUMMARY}}", CURRENT)
    .replace("{{SUMMARY_RULE}}", BEFORE_RULES[round])
    .replace("{{FINAL_SUMMARY}}", round === "final" ? FINAL_SUMMARY_SHAPE : "");

const rendered = (round: SummaryRound): string => section(filled({ SUMMARY_SECTION: renderSummarySection(round, CURRENT) }));

describe("the title and the summary section of the review prompt", () => {
  it("leaves no rule for the title or the summary in the static prompt", () => {
    expect(section(REVIEW_PROMPT)).toBe("# THE TITLE AND THE SUMMARY\n\n{{SUMMARY_SECTION}}\n\n");
    expect(REVIEW_PROMPT).not.toContain("Merge Danger");
    expect(REVIEW_PROMPT).not.toContain("smallest view that makes the point");
  });

  it("says, for each round, what the runner said before", () => {
    expect(SUMMARY_RULES).toEqual(BEFORE_RULES);
  });

  it("prints, on the final review, the same text the static prompt printed before", () => {
    expect(rendered("final")).toBe(before("final"));
  });

  it("prints, on a review that writes them, the same text but the blank lines the empty final shape left", () => {
    expect(before("writes")).toContain("write it as one.\n\n\n\n");
    expect(rendered("writes")).toBe(before("writes").replace("write it as one.\n\n\n\n", "write it as one.\n\n"));
  });

  it.each(["slice", "unchanged"] as const)("prints, on a %s round, the one line saying to omit both fields and nothing else", (round) => {
    expect(rendered(round)).toBe(`# THE TITLE AND THE SUMMARY\n\n${BEFORE_RULES[round]}\n\n`);
    expect(BEFORE_RULES[round]).not.toContain("\n");
    expect(BEFORE_RULES[round]).toContain("omit both fields");
    expect(rendered(round)).not.toMatch(/Merge Danger|`door`|`summary`|block says, now/);
    expect(rendered(round)).not.toContain(CURRENT);
  });

  it("keeps the prompt rules: no em dash and no gate command", () => {
    for (const round of ["slice", "unchanged", "final", "writes"] as const) {
      expect(renderSummarySection(round, CURRENT)).not.toMatch(/\u2014|npm run verify/);
    }
  });
});
