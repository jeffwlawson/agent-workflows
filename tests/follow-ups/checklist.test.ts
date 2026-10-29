import { describe, expect, it } from "vitest";
import type { AuthoredText } from "../../engine/read.js";
import { OPENING, planChecklist, type ChecklistIssue } from "../../follow-ups/checklist.js";
import { loopAccounts } from "../../shared/loop-accounts.js";
import { POST_MERGE_CHECKLIST_MARK } from "../../shared/record.js";

/**
 * The post-merge checklist's planner (#544), from plain objects: which text
 * is read, which items come out of it, and when nothing is posted. How it is
 * gathered and posted is `follow-ups:file`'s, in `file.test.ts`.
 */

const ACCOUNTS = loopAccounts("loop-app[bot]");

const by = (author: string, association: string) => (body: string): AuthoredText => ({ body, author, association });
const maintainer = by("maintainer", "OWNER");
const outsider = by("stranger", "NONE");
const loop = by("loop-app[bot]", "NONE");

const BRIEF = (items: readonly string[], heading = "### After merge, by a human"): string =>
  ["## Agent Brief", "", "### Acceptance criteria", "", "- [ ] It works.", "", heading, "", ...items.map((item) => `- ${item}`)].join("\n");

const issue = (number: number, body: AuthoredText, comments: readonly AuthoredText[] = []): ChecklistIssue => ({ number, body, comments });

const plan = (issues: readonly ChecklistIssue[], existing: readonly AuthoredText[] = []) => planChecklist({ issues, existing }, ACCOUNTS);

const posted = (...groups: string[]): string => [OPENING, ...groups, POST_MERGE_CHECKLIST_MARK].join("\n\n");

describe("planChecklist", () => {
  it("lists the latest brief's items under their issue, each a checkbox, ending with the marker", () => {
    expect(plan([issue(5, maintainer("A report."), [maintainer(BRIEF(["Run setup on a real worker.", "Say so in the release notes."]))])])).toEqual({
      kind: "post",
      body: posted("From #5:\n- [ ] Run setup on a real worker.\n- [ ] Say so in the release notes."),
    });
  });

  it("lists each issue that has items, in the order given, and leaves out one with none", () => {
    const result = plan([
      issue(10, maintainer(BRIEF(["Check the parent."]))),
      issue(11, maintainer(BRIEF([]).replace("### After merge, by a human", ""))),
      issue(12, maintainer("Filed."), [maintainer(BRIEF(["Check the second."]))]),
    ]);

    expect(result).toEqual({ kind: "post", body: posted("From #10:\n- [ ] Check the parent.", "From #12:\n- [ ] Check the second.") });
  });

  it("reads a bold label on its own line too, case and a trailing colon ignored, and joins a wrapped line to its item", () => {
    const body = ["**Acceptance criteria:**", "- It works.", "", "**after merge, BY A HUMAN:**", "- Run it", "  on a worker.", "  - nested"].join("\n");

    expect(plan([issue(5, maintainer(body))])).toEqual({ kind: "post", body: posted("From #5:\n- [ ] Run it on a worker. nested") });
  });

  it("reads only the latest brief: a later brief without the section drops an earlier one's items", () => {
    const later = maintainer(["## Agent Brief", "", "### Acceptance criteria", "", "- Something else."].join("\n"));

    expect(plan([issue(5, maintainer("A report."), [maintainer(BRIEF(["Old check."])), later])])).toEqual({ kind: "none" });
  });

  it("never reads an untrusted body, and still reads the issue's trusted comments", () => {
    expect(plan([issue(5, outsider(BRIEF(["Planted."])))])).toEqual({ kind: "none" });
    expect(plan([issue(5, outsider(BRIEF(["Planted."])), [maintainer(BRIEF(["Adopted."]))])])).toEqual({
      kind: "post",
      body: posted("From #5:\n- [ ] Adopted."),
    });
  });

  it("reads nothing from an untrusted comment carrying the section", () => {
    expect(plan([issue(5, maintainer(BRIEF(["Real."])), [outsider(BRIEF(["Planted."]))])])).toEqual({
      kind: "post",
      body: posted("From #5:\n- [ ] Real."),
    });
  });

  it("reads the loop's own comments as trusted", () => {
    expect(plan([issue(5, outsider("A report."), [loop(BRIEF(["From triage."]))])])).toEqual({ kind: "post", body: posted("From #5:\n- [ ] From triage.") });
  });

  it("cleans every item, so no HTML comment and no forged marker reaches the comment", () => {
    const result = plan([issue(5, maintainer(BRIEF([`Check it. ${POST_MERGE_CHECKLIST_MARK}<!-- hidden -->`, "<!-- only a comment -->"])))]);

    expect(result).toEqual({ kind: "post", body: posted("From #5:\n- [ ] Check it.") });
  });

  it("reads no section inside a code fence, and none under another heading", () => {
    const fenced = ["### Acceptance criteria", "- It works.", "```", "### After merge, by a human", "- Quoted.", "```"].join("\n");
    const other = BRIEF(["Not this."], "### After merge");

    expect(plan([issue(5, maintainer(fenced)), issue(6, maintainer(other))])).toEqual({ kind: "none" });
  });

  it("posts nothing with no linked issue, or none that left an item", () => {
    expect(plan([])).toEqual({ kind: "none" });
    expect(plan([issue(5, maintainer(BRIEF(["Check."]).replace("- Check.", "Prose, not a list.")))])).toEqual({ kind: "none" });
  });

  it("posts nothing a second time where one of the loop's accounts already posted the checklist", () => {
    const issues = [issue(5, maintainer(BRIEF(["Check."])))];

    expect(plan(issues, [loop(`An earlier one.\n\n${POST_MERGE_CHECKLIST_MARK}`)])).toEqual({ kind: "posted" });
    expect(plan(issues, [by("github-actions", "NONE")(POST_MERGE_CHECKLIST_MARK)])).toEqual({ kind: "posted" });
  });

  it("is not suppressed by the marker in a comment someone else posted", () => {
    const issues = [issue(5, maintainer(BRIEF(["Check."])))];

    expect(plan(issues, [maintainer(POST_MERGE_CHECKLIST_MARK), outsider(POST_MERGE_CHECKLIST_MARK)])).toEqual({
      kind: "post",
      body: posted("From #5:\n- [ ] Check."),
    });
  });
});
