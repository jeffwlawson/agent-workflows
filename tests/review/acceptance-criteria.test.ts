import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyCriteriaRulings,
  criterionId,
  extractCriteria,
  renderCriteriaForReview,
} from "../../review/acceptance-criteria.js";
import { placeFindings } from "../../shared/review-findings.js";
import {
  countFixBeforeMerge,
  deriveVerdict,
  readCriteriaChanges,
  reviewBodyHandOver,
  reviewOutputSchema,
  VERDICTS,
  type ReviewOutput,
} from "../../shared/review-output.js";
import { renderDecided } from "./decided.js";

/**
 * The review checks each pull request against its linked issue's acceptance
 * criteria (#214). On jeffwlawson/mealie-mcp-server#72/#82 the central criteria
 * were dropped by design and nothing recorded it, and criteria about the pull
 * request itself went unmet on most slices of a PRD without anyone noticing.
 */

const parse = (value: unknown): ReviewOutput => {
  const result = reviewOutputSchema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error(result.issues.map((i) => i.message).join("; "));
  }
  return (result as { value: ReviewOutput }).value;
};

/**
 * A brief appended to the body: the issue as first filed, then an agent brief
 * whose acceptance criteria supersede it. #72 had this shape. Triage more often
 * posts the brief as a comment, which the tests below it cover.
 */
const TRIAGED = [
  "# Report failed URLs in bulk import",
  "",
  "## Acceptance",
  "",
  "- The original criterion, before triage.",
  "",
  "## Agent Brief",
  "",
  "**Summary:** Report which URLs failed.",
  "",
  "**Acceptance criteria:**",
  "- [ ] The caller receives 2 recipes and 1 error naming that slug.",
  "- [x] A failed URL is reported with the",
  "  upstream status.",
  "- [ ] The PR description says which tests cover the failure path.",
  "",
  "**Out of scope:**",
  "- Retrying a failed URL.",
].join("\n");

describe("extractCriteria", () => {
  it("takes the acceptance section's items, the last one where triage wrote a second", () => {
    expect(extractCriteria(TRIAGED)).toEqual([
      "The caller receives 2 recipes and 1 error naming that slug.",
      "A failed URL is reported with the upstream status.",
      "The PR description says which tests cover the failure path.",
    ]);
  });

  /**
   * The shape #214 itself had: the issue as filed keeps its own `## Acceptance`
   * in the body, and triage posts the brief as a comment, whose criteria moved
   * two of the body's out of scope. Reading the body alone ruled on those.
   */
  it("prefers a triage brief posted as a comment over the body's acceptance section", () => {
    const body = ["## Acceptance", "", "- [ ] Retitle the PR.", "- [ ] Note #72 in the body."].join("\n");
    const brief = [
      "## Agent Brief",
      "",
      "**Acceptance criteria:**",
      "- [ ] Every review rules on each criterion.",
      "- [ ] An unmet one is a finding.",
      "",
      "**Out of scope:**",
      "- Retitling the PR (#218).",
    ].join("\n");

    expect(extractCriteria(body, ["Thanks, triaging.", brief, "Looks good."])).toEqual([
      "Every review rules on each criterion.",
      "An unmet one is a finding.",
    ]);
  });

  it("takes the latest comment with an acceptance section, and keeps the body's where none has one", () => {
    const body = "## Acceptance\n- The body's.";

    expect(extractCriteria(body, ["## Acceptance\n- First brief.", "## Acceptance\n- Revised brief."])).toEqual([
      "Revised brief.",
    ]);
    expect(extractCriteria(body, ["A comment.", "## Acceptance\n\nProse only."])).toEqual(["The body's."]);
  });

  it("reads a comment's acceptance section but never a comment's bare checklist", () => {
    expect(extractCriteria("No criteria.", ["- [ ] Somebody's to-do."])).toEqual([]);
    expect(extractCriteria("- [ ] The body's.", ["- [ ] Somebody's to-do."])).toEqual(["The body's."]);
    expect(extractCriteria("- [ ] The body's.", ["**Acceptance:**\n- [ ] The brief's."])).toEqual([
      "The brief's.",
    ]);
  });

  it("reads a Markdown heading as well as a bold label, and plain bullets as well as a checklist", () => {
    const body = [
      "## What to build",
      "- Not a criterion.",
      "",
      "## Acceptance criteria",
      "",
      "1. The first.",
      "2. The second,",
      "   wrapped.",
      "",
      "## Notes",
      "- Not a criterion either.",
    ].join("\n");

    expect(extractCriteria(body)).toEqual(["The first.", "The second, wrapped."]);
  });

  it("folds a nested item into the criterion it sits under", () => {
    const body = ["## Acceptance", "- Replay it:", "  - the title matches", "- A second."].join("\n");

    expect(extractCriteria(body)).toEqual(["Replay it: the title matches", "A second."]);
  });

  it("falls back to the issue's checklist where it has no acceptance section", () => {
    const body = [
      "Some prose.",
      "",
      "- A plain bullet, not a checklist item.",
      "- [ ] One.",
      "  - [x] Two, nested.",
    ].join("\n");

    expect(extractCriteria(body)).toEqual(["One.", "Two, nested."]);
  });

  it("falls back to the checklist where the acceptance section lists nothing", () => {
    const body = ["## Acceptance", "", "Prose only.", "", "## Tasks", "- [ ] One."].join("\n");

    expect(extractCriteria(body)).toEqual(["One."]);
  });

  it("finds nothing in an issue with neither", () => {
    expect(extractCriteria("Just a description.\n\n- A bullet.")).toEqual([]);
    expect(extractCriteria("")).toEqual([]);
  });

  it("reads nothing inside a code fence", () => {
    const body = ["```md", "## Acceptance", "- [ ] Quoted, not asked.", "```"].join("\n");

    expect(extractCriteria(body)).toEqual([]);
  });
});

describe("renderCriteriaForReview", () => {
  it("lists each criterion under the id a ruling names, with the pull request's body", () => {
    const text = renderCriteriaForReview(["One.", "Two."], "Closes #1\n\nTests: none.");

    expect(text).toContain(`- \`${criterionId(0)}\`: One.`);
    expect(text).toContain(`- \`${criterionId(1)}\`: Two.`);
    expect(text).toContain("> Tests: none.");
  });

  it("says there is nothing to rule on where there are no criteria", () => {
    expect(renderCriteriaForReview([], "body")).toContain("leave `criteria` empty");
  });
});

describe("reviewOutputSchema: criteria", () => {
  it("reads the three statuses", () => {
    const output = parse({
      criteria: [
        { id: "C1", status: "met" },
        { id: "C2", status: "changed", reason: "The endpoint answers 202 before anything exists." },
        { id: "C3", status: "unmet", reason: "The body names no tests.", path: "src/a.ts", line: 4 },
      ],
    });

    expect(output.criteria).toEqual([
      { id: "C1", status: "met" },
      { id: "C2", status: "changed", reason: "The endpoint answers 202 before anything exists." },
      {
        id: "C3",
        status: "unmet",
        reason: "The body names no tests.",
        path: "src/a.ts",
        line: 4,
        severity: "medium",
      },
    ]);
  });

  it("is absent where the review ruled on none", () => {
    expect(parse({}).criteria).toBeUndefined();
  });

  /** A deliberate change with no reason is the silent drop #214 exists to end. */
  it("refuses a changed criterion with no reason", () => {
    expect(() => parse({ criteria: [{ id: "C1", status: "changed" }] })).toThrow(/reason/);
    expect(() => parse({ criteria: [{ id: "C1", status: "changed", reason: " " }] })).toThrow(/reason/);
  });

  /** An unmet criterion becomes a finding, and a finding needs an anchor. */
  it("refuses an unmet criterion with no anchor", () => {
    expect(() => parse({ criteria: [{ id: "C1", status: "unmet", line: 3 }] })).toThrow(/path/);
    expect(() => parse({ criteria: [{ id: "C1", status: "unmet", path: "a.ts" }] })).toThrow(/line/);
  });

  it("refuses a status it does not know", () => {
    expect(() => parse({ criteria: [{ id: "C1", status: "partly" }] })).toThrow(/status/);
  });
});

describe("applyCriteriaRulings", () => {
  const criteria = ["The caller receives 2 recipes and 1 error.", "The PR description names the tests."];

  /** The #72/#82 sequence: the central criterion dropped by design, with the reason. */
  it("records a deliberately changed criterion with its reason, and raises no finding for it", () => {
    const { results, findings } = applyCriteriaRulings(criteria, [
      { id: "C1", status: "changed", reason: "The endpoint answers 202 with a report id, so failures are not knowable." },
      { id: "C2", status: "met" },
    ]);

    expect(results).toEqual([
      {
        id: "C1",
        text: criteria[0],
        status: "changed",
        reason: "The endpoint answers 202 with a report id, so failures are not knowable.",
      },
      { id: "C2", text: criteria[1], status: "met" },
    ]);
    expect(findings).toEqual([]);
  });

  it("makes an unmet criterion a fix-before-merge finding at its anchor", () => {
    const { findings } = applyCriteriaRulings(criteria, [
      { id: "C1", status: "met" },
      { id: "C2", status: "unmet", reason: "The body names no tests.", path: "src/a.ts", line: 4, severity: "low" },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "src/a.ts", line: 4, severity: "low" });
    expect(findings[0]?.title).toContain(criteria[1]);
    expect(findings[0]?.body).toMatch(/^\*\*Fix before merge\.\*\*/);
    expect(findings[0]?.body).toContain("The body names no tests.");
  });

  it("lists a criterion nobody ruled on as not checked, and drops a ruling on one it was not handed", () => {
    const { results, findings } = applyCriteriaRulings(criteria, [
      { id: "C9", status: "met" },
      { id: "C2", status: "met" },
      { id: "C2", status: "unmet", path: "a.ts", line: 1, severity: "medium" },
    ]);

    expect(results.map((r) => r.status)).toEqual(["unchecked", "met"]);
    expect(findings).toEqual([]);
  });

  it("returns nothing where the issue named no criteria, whatever the review said", () => {
    expect(
      applyCriteriaRulings([], [{ id: "C1", status: "unmet", path: "a.ts", line: 1, severity: "high" }]),
    ).toEqual({ results: [], findings: [] });
  });

  /**
   * The finding counts toward the verdict and is posted like any other: placed
   * on the diff, counted once, and the verdict is not an approval over it.
   */
  it("stops an approval: an unmet criterion is counted like any finding", () => {
    const output = parse({
      criteria: [{ id: "C1", status: "unmet", path: "src/a.ts", line: 4 }],
    });
    const { findings } = applyCriteriaRulings(["The PR description names the tests."], output.criteria ?? []);
    const withCriteria = { ...output, findings: [...output.findings, ...findings] };
    const { placed, unanchored } = placeFindings(withCriteria.findings, new Map([["src/a.ts", new Set([4])]]));

    expect(placed.map((p) => p.placement)).toEqual(["line"]);
    expect(countFixBeforeMerge(withCriteria, unanchored.length)).toBe(1);
    expect(
      deriveVerdict(withCriteria, {
        ci: "green",
        fixRoundProgress: undefined,
        stillOpen: 0,
        movedToFollowUps: 0,
        autoFix: false,
      }).verdict,
    ).toBe("changes recommended");
  });
});

describe("the body's acceptance criteria section", () => {
  const parts = {
    verdict: VERDICTS["approval recommended"],
    output: { findings: [], followUps: [], verified: [] },
    placed: [],
    movedToFollowUps: 0,
    stillOpen: [],
    resolved: [],
    followUps: [],
    droppedFollowUps: 0,
  };

  it("renders each criterion with its status and reason, after the record", () => {
    const body = renderDecided({
      ...parts,
      criteria: [
        { id: "C1", text: "The caller receives 2 recipes.", status: "changed", reason: "The endpoint answers 202." },
        { id: "C2", text: "Tests cover it.", status: "met" },
        { id: "C3", text: "The PR names the tests.", status: "unmet", reason: "It does not." },
        { id: "C4", text: "Docs updated.", status: "unchecked" },
      ],
      runUrl: "https://example.test/run",
    });

    expect(body).toContain("<summary><b>Acceptance criteria</b> (4) · 1 met, 1 changed, 1 unmet, 1 not checked</summary>");
    expect(body).toContain("- **Changed:** The caller receives 2 recipes. · The endpoint answers 202.");
    expect(body).toContain("- **Met:** Tests cover it.");
    expect(body).toContain("- **Unmet:** The PR names the tests. · It does not.");
    expect(body).toContain("- **Not checked:** Docs updated.");
    expect(body).toContain("<details open>\n<summary><b>Acceptance criteria</b>");
    expect(body.indexOf("Acceptance criteria")).toBeLessThan(body.indexOf("Workflow run"));
  });

  it("starts folded where every criterion is met", () => {
    const body = renderDecided({
      ...parts,
      criteria: [{ id: "C1", text: "Tests cover it.", status: "met" }],
    });

    expect(body).toContain("<details>\n<summary><b>Acceptance criteria</b> (1) · 1 met</summary>");
  });

  it("is omitted where the runner says nothing about the linked issue", () => {
    expect(renderDecided({ ...parts, criteria: [] })).not.toContain("Acceptance criteria");
    expect(renderDecided(parts)).not.toContain("Acceptance criteria");
  });
});

/**
 * Where a review was handed no criteria, the body says why in one line, in the
 * group's place (#435). #376 had its criteria under `## Done when`, and its PR
 * was approved twice with none checked and nothing saying so: from the body,
 * an issue with none, a PR with no issue and an issue the loop did not read
 * all looked the same.
 */
describe("the line a review handed no criteria carries", () => {
  const parts = {
    verdict: VERDICTS["approval recommended"],
    output: { findings: [], followUps: [], verified: [] },
    placed: [],
    movedToFollowUps: 0,
    stillOpen: [],
    resolved: [],
    followUps: [],
    droppedFollowUps: 0,
    runUrl: "https://example.test/run",
  };
  const NONE_IN_THE_ISSUE =
    '_No acceptance criteria found in #376. To have each one checked, put them under a heading containing "Acceptance criteria", or write them as `- [ ]` items in the issue body._';
  const NO_LINKED_ISSUE = "_No linked issue, so there are no acceptance criteria to check._";
  const UNTRUSTED =
    '_The text of #9 was not read, because of who opened it, so no acceptance criteria were checked. A maintainer can restate them in a comment on the issue, under a heading containing "Acceptance criteria"._';

  it.each([
    ["the linked issue was read and yields none", { kind: "read", number: 376 }, { kind: "none in the issue", issue: 376 }],
    ["there is no linked issue", { kind: "none" }, { kind: "no linked issue" }],
    ["the linked issue was not read for who opened it", { kind: "untrusted", number: 9 }, { kind: "untrusted issue", issue: 9 }],
  ] as const)("is handed over as its case where %s", (_case, linkedIssue, expected) => {
    expect(reviewBodyHandOver({ ...parts, criteria: [], linkedIssue }).criteriaCase).toEqual(expected);
  });

  it("is handed over as criteria found wherever criteria were, whatever the issue", () => {
    const criteria = [{ id: "C1", text: "Tests cover it.", status: "met" as const }];
    expect(reviewBodyHandOver({ ...parts, criteria, linkedIssue: { kind: "read", number: 5 } }).criteriaCase).toEqual({
      kind: "criteria found",
    });
  });

  it("is handed over as no case at all on a PRD's final review, which is handed no linked issue", () => {
    expect(reviewBodyHandOver({ ...parts, criteria: [] })).not.toHaveProperty("criteriaCase");
  });

  it.each([
    ["names the issue and both ways to make its criteria checkable", { kind: "read", number: 376 }, NONE_IN_THE_ISSUE],
    ["says there was no linked issue", { kind: "none" }, NO_LINKED_ISSUE],
    ["says the issue was not read for who opened it, and how a maintainer supplies criteria", { kind: "untrusted", number: 9 }, UNTRUSTED],
  ] as const)("%s, where the group would be", (_case, linkedIssue, line) => {
    const body = renderDecided({ ...parts, criteria: [], linkedIssue });

    expect(body.split("\n\n")).toContain(line);
    expect(body).not.toContain("<summary><b>Acceptance criteria</b>");
    expect(body.indexOf(line)).toBeLessThan(body.indexOf("Workflow run"));
    // A note is not a recorded group: the final review reads none back from it.
    expect(readCriteriaChanges(body)).toBeUndefined();
    // Nor a finding, nor a change to the verdict.
    expect(body).toContain("Approval recommended");
    expect(body).not.toContain("<summary><b>Open</b>");
  });

  // Only a maintainer's comment is read on that issue (#444), so the note
  // speaks to a maintainer, and never suggests the body's checklist.
  it("suggests nothing an untrusted issue's author could do to be read", () => {
    expect(UNTRUSTED).toContain("A maintainer can restate them in a comment");
    expect(UNTRUSTED).not.toMatch(/- \[ \]|issue body|put them/);
  });

  it("is not there where criteria were found, which render as they did", () => {
    const criteria = [{ id: "C1", text: "Tests cover it.", status: "met" as const }];
    const body = renderDecided({ ...parts, criteria, linkedIssue: { kind: "read", number: 5 } });

    expect(body).toBe(renderDecided({ ...parts, criteria }));
    expect(body).toContain("<summary><b>Acceptance criteria</b> (1) · 1 met</summary>");
    expect(body).not.toContain("No acceptance criteria");
  });

  it("is not there on a PRD's final review", () => {
    const body = renderDecided({ ...parts, criteria: [] });

    expect(body).not.toContain("acceptance criteria");
    expect(body).not.toContain("Acceptance criteria");
  });
});

/**
 * The criteria reach the agent through one placeholder the runner fills, and
 * come back through one field both briefs name. A placeholder with nothing
 * behind it reaches the agent as literal braces, and a field only one brief
 * names is one the extraction drops.
 */
describe("the review brief's acceptance criteria", () => {
  const PROMPT = fs.readFileSync("review/prompt.md", "utf8");
  const EXTRACTION = fs.readFileSync("review/extraction.md", "utf8");
  const RUNNER = fs.readFileSync("review/review.ts", "utf8");

  it("is a section the runner fills", () => {
    expect(PROMPT).toContain("# ACCEPTANCE CRITERIA\n");
    expect(PROMPT).toContain("{{ACCEPTANCE_CRITERIA}}");
    expect(RUNNER).toContain("ACCEPTANCE_CRITERIA: renderCriteriaForReview(");
  });

  it.each([
    ["prompt.md", PROMPT],
    ["extraction.md", EXTRACTION],
  ])("%s asks for every status by name, in `criteria`", (_half, text) => {
    expect(text).toContain("`criteria`");
    for (const status of ["`met`", "`changed`", "`unmet`"]) expect(text).toContain(status);
  });
});
