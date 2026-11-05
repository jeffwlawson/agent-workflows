import { describe, expect, it } from "vitest";
import { describeHistory } from "../../review/review-round.js";
import { renderRedCheck, renderRedCheckForFinal } from "../../shared/red-check.js";
import { EMPTY_BRANCHES, EMPTY_PROMPT, filled, LIVE_BRANCHES, LIVE_PROMPT, REFUSED_NOTE, REVIEWED_HEAD } from "./branch-rules.js";
import { REVIEW_PROMPT } from "./finding-history.js";

/**
 * The verification pass, the unreadable-feedback paragraph and the red
 * check's rules are printed only where they apply (#780, audit #704 H4, stage
 * 1b): each rides with the placeholder the runner fills, so a review where a
 * branch is not live is handed its heading and the renderer's line, and one
 * where it is live is handed what the static prompt printed before.
 */

/** A section of a prompt, from its heading to the next. */
const section = (prompt: string, heading: string): string =>
  prompt.match(new RegExp(`^# ${heading}\n.*?(?=^# )`, "ms"))?.[0] ?? "";

/** The three sections as `review/prompt.md` held them before #780, kept as they were. */
const BEFORE_FEEDBACK = `# EXISTING FEEDBACK

Feedback already on this PR: earlier review summaries, unresolved inline threads (replies
included), and conversation comments, plus any collaborator comments on the linked issue.
Resolved threads are omitted deliberately: a thread is closed by a review that checked the code and
found the finding fixed, or by a human, so one that is gone is one that is settled. The ones a
**human** closed are listed under *WHAT THE MAINTAINER HAS SETTLED* below, because those carry an
instruction rather than only an absence.

**Raise only what is new.** A finding an earlier review left open is ruled in \`verified\`
(*FINDINGS AN EARLIER REVIEW LEFT OPEN* below); a point a human made that the code still bears out,
and that no earlier finding covers, is a finding of yours on the usual terms. Treat maintainer
steering as authoritative, and keep your own judgement about the code.

A note headed *Feedback that could not be read* below says what the API refused and what that
leaves unknown, which can change a conclusion (\`howChecked\` records where it does).

{{DISCUSSION}}

`;

const BEFORE_FOLLOWS = `# WHAT THIS REVIEW FOLLOWS

{{HISTORY}}

**A review that follows a fix round is a verification pass.** An earlier review of this pull request
stands, a fix round has pushed since, and the question is no longer *what is wrong with this change*
but *did the last round's findings land, and did the new commits break anything?* Rule on every open
finding (the section below), and read the new commits for what they broke: a fix that resolves its
own finding and regresses something else is what nothing else is looking for. A real problem in
code an earlier review of this pull request already read is *previously missed* (*THE TWO KINDS OF
FINDING*); one outside this pull request's scope is still a \`followUps\` entry, and *FOLLOW-UPS
EARLIER ROUNDS RECORDED* says whether to re-record an earlier round's (\`howChecked\` records that
this was a verification pass, and what you checked the earlier findings against).

`;

const BEFORE_RED_CHECK = `# RED CHECK

The **red check**, where the repository configures it, runs the tests this pull request adds or
changes against the code as it was **before** the change. Its report, as the workflow read it:

{{RED_CHECK}}

**Where the check ran, hold every behaviour change to it.** For each behaviour change this pull
request makes in a non-test file, find the red test that covers it: one whose failing assertion
exercises that behaviour. **A broken test is not red**, so it covers nothing. Where no red test
covers it, **flag it plainly**, as a finding to fix before merge, anchored at the change, naming the
behaviour and saying that no red test covers it. One finding per uncovered behaviour, or one naming
the class where several share a cause. A change that alters no behaviour (a comment, a rename, a
refactor the existing tests pin, documentation) is owed nothing (\`howChecked\` records which
changes you treated that way). A claim in the pull request's body or a commit message that a test was red is
not evidence: the report is.

Where the report says which tests are red is unknown, raise no finding on the strength of the
missing report (\`howChecked\` records that the red evidence was unavailable).

`;

/** The two red-check rules the static section printed, as it printed them. */
const [HOLD = "", WHERE_UNKNOWN = ""] = BEFORE_RED_CHECK.split("\n\n").filter((p) => /^(?:\*\*)?Where the/.test(p));

/** What each renderer printed, for these fixtures, before the rules moved into it. */
const BEFORE_RAN = `The red check ran. It took the test files this pull request adds or changes and put them over the merge-base, \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`, with every other file as it was there, and ran the test command the repository configures for it.

Test files it ran:

- \`tests/queue.test.ts\`

**Red against the merge-base** (1): each failed there on the assertion shown, so each is evidence that it catches the behaviour this pull request changes.

- \`drops a stale lease\` (\`queue\`)

\`\`\`text
expected 1 to be 0
\`\`\`

**Non-test files this pull request changes** (1). Each behaviour change in them needs a red test above that covers it:

- \`src/queue.ts\``;
const BEFORE_UNREADABLE = `**The red check is configured, and its result could not be read**: the artifact was missing.

**Which tests are red is unknown.** That is not "no red tests", and it is not "all covered": judge the tests in the diff yourself, and take no claim that a test was red on the pull request's word.`;
const BEFORE_FINAL = `**This is a PRD PR's final review, so the red check ran nothing here.** Each slice's tests were run in that slice's own round, against the PRD branch as it stood before the slice, where a test of an earlier slice's code can import it. Against the merge-base such a test reads as broken, so no merge-base run is evidence about a slice. What each slice round found is below, and it is the red evidence for that slice's changes: a test named red there covers the behaviour it exercises, whatever this review sees of it now.

- #7: **red** (1):
  - \`t\` (\`c\`)
- #8: **unknown**. No review of this slice recorded what its red check found.

Hold each slice's behaviour changes to its own line above. Where a slice's record is **unknown**, which tests are red for that slice is unknown: raise no finding on the strength of the missing record, take no claim of a red test on trust, and judge that slice's coverage from the tests in the diff yourself. Where it is **none red**, a behaviour change that slice makes is not covered by a red test.`;

const UNREADABLE = renderRedCheck({ kind: "unreadable", reason: "the artifact was missing" }, REVIEWED_HEAD);
const FINAL = renderRedCheckForFinal([
  { subIssue: 7, record: { known: true, red: [{ name: "t", classname: "c" }], more: 0 } },
  { subIssue: 8, record: undefined },
]);

describe("the branch sections of the review prompt", () => {
  it("leave no branch rule in the static prompt", () => {
    expect(REVIEW_PROMPT).not.toContain("A note headed *Feedback that could not be read*");
    expect(REVIEW_PROMPT).not.toContain("is a verification pass.**");
    expect(REVIEW_PROMPT).not.toContain("Where the check ran");
    expect(REVIEW_PROMPT).not.toContain("Where the report says which tests are red is unknown");
    expect(HOLD).toMatch(/^\*\*Where the check ran/);
    expect(WHERE_UNKNOWN).toMatch(/^Where the report says/);
  });

  describe("the verification pass", () => {
    it("prints, after a fix round, the same text the static prompt printed before", () => {
      const line = "This review **follows a fix round**: an earlier review of this pull request started one, and commits have landed since.";

      expect(section(LIVE_PROMPT, "WHAT THIS REVIEW FOLLOWS")).toBe(BEFORE_FOLLOWS.replace("{{HISTORY}}", line));
    });

    it("rides with an assumed fix round too, the stricter reading", () => {
      const history = describeHistory({ afterFixRound: true, unreadable: "the commits could not be listed", unreviewedCommits: false });

      expect(history).toContain("is a verification pass.**");
    });

    it("prints, after no fix round, the one line and nothing of the pass", () => {
      expect(section(EMPTY_PROMPT, "WHAT THIS REVIEW FOLLOWS")).toBe(`# WHAT THIS REVIEW FOLLOWS\n\n${EMPTY_BRANCHES.HISTORY}\n\n`);
      expect(EMPTY_BRANCHES.HISTORY).not.toContain("\n");
    });
  });

  describe("the unreadable-feedback paragraph", () => {
    it("prints, where a selection was refused, the same text the static prompt printed before", () => {
      expect(section(LIVE_PROMPT, "EXISTING FEEDBACK")).toBe(BEFORE_FEEDBACK.replace("{{DISCUSSION}}", REFUSED_NOTE));
    });

    it("prints nothing where every selection was read", () => {
      const before = BEFORE_FEEDBACK.replace("{{DISCUSSION}}", EMPTY_BRANCHES.DISCUSSION);

      expect(section(EMPTY_PROMPT, "EXISTING FEEDBACK")).toBe(before.replace(/A note headed .*?\n\n(?=\(no collaborator)/s, ""));
      expect(section(EMPTY_PROMPT, "EXISTING FEEDBACK")).not.toContain("could not be read");
    });
  });

  describe("the red check", () => {
    const live = (redCheck: string): string => section(filled({ RED_CHECK: redCheck }), "RED CHECK");
    const before = (render: string): string => BEFORE_RED_CHECK.replace("{{RED_CHECK}}", render);
    const without = (text: string, rule: string): string => text.replace(`\n\n${rule}`, "");

    it("prints, where the check ran, what the static prompt printed before but the rule for an unknown", () => {
      expect(live(LIVE_BRANCHES.RED_CHECK)).toBe(without(before(BEFORE_RAN), WHERE_UNKNOWN));
    });

    it("prints, where its result is unknown, what the static prompt printed before but the rule for a report it read", () => {
      expect(live(UNREADABLE)).toBe(without(before(BEFORE_UNREADABLE), HOLD));
    });

    it("prints, on a final review with a known and an unknown slice, the same text the static prompt printed before", () => {
      expect(live(FINAL)).toBe(before(BEFORE_FINAL));
    });

    it("prints, where the check is not configured, the not-configured sentence and nothing of the other two", () => {
      const text = live(EMPTY_BRANCHES.RED_CHECK);

      expect(text).toBe(without(without(before(EMPTY_BRANCHES.RED_CHECK), HOLD), WHERE_UNKNOWN));
      expect(EMPTY_BRANCHES.RED_CHECK).not.toContain("\n");
      expect(text).not.toMatch(/Where the check ran|Where the report says|unknown/);
    });
  });
});
