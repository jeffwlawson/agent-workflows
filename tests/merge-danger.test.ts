import { describe, expect, it } from "vitest";
import { MERGE_DANGER_HEADING, renderMergeDanger } from "../shared/merge-danger.js";
import type { FollowUp } from "../shared/review-output.js";

/**
 * The body's **Merge Danger** (#356): the door, the blast radius, a line per
 * breaking change and the known issues, laid out by the workflow from the
 * review's fields so it reads the same on every pull request.
 */
describe("renderMergeDanger", () => {
  const followUp = (title: string, location: string): FollowUp => ({ title, location, body: "b", severity: "medium" });

  it("gives the door and the blast radius alone where nothing else applies", () => {
    expect(renderMergeDanger({ door: "two-way", blastRadius: "internal" }, [])).toBe(
      "## Merge Danger\n\n**Door:** two-way\n\n**Blast Radius:** internal",
    );
  });

  it("puts each note under its own part, a line per breaking change, then the known issues", () => {
    expect(
      renderMergeDanger(
        {
          door: "one-way",
          doorNote: "The release is published, and a revert does not unpublish it.",
          blastRadius: "users",
          blastRadiusNote: "Everyone on the next release.",
          breaking: ["Rename the `token` input to `app-token`.", "Drop the `closed` trigger."],
        },
        [followUp("the cache key omits the tenant", "src/cache.ts:12"), followUp("a  second\n one", "src/b.ts")],
      ),
    ).toBe(
      [
        MERGE_DANGER_HEADING,
        "**Door:** one-way",
        "The release is published, and a revert does not unpublish it.",
        "**Blast Radius:** users",
        "Everyone on the next release.",
        "**Breaking:** Rename the `token` input to `app-token`.",
        "**Breaking:** Drop the `closed` trigger.",
        "**Known issues**, filed when this merges:\n\n- the cache key omits the tenant (`src/cache.ts:12`)\n- a second one (`src/b.ts`)",
      ].join("\n\n"),
    );
  });

  it.each([
    ["doorNote", { doorNote: "A catch." }, "**Door:** two-way\n\nA catch.\n\n**Blast Radius:** x"],
    ["blastRadiusNote", { blastRadiusNote: "On merge." }, "**Blast Radius:** x\n\nOn merge."],
  ])("takes %s on its own", (_part, extra, expected) => {
    expect(renderMergeDanger({ door: "two-way", blastRadius: "x", ...extra }, [])).toContain(expected);
  });

  it("leaves the breaking lines and the known issues out where there are none", () => {
    const text = renderMergeDanger({ door: "two-way", blastRadius: "x", breaking: [] }, []);

    expect(text).not.toContain("Breaking");
    expect(text).not.toContain("Known issues");
  });

  /** Always present, so a review that gave no door or blast radius is said to have given none rather than leaving a gap. */
  it("says so where the review gave no door or blast radius", () => {
    const text = renderMergeDanger({}, []);

    expect(text).toContain("**Door:** not given.");
    expect(text).toContain("**Blast Radius:** not given.");
  });

  /** The model's text goes inside the summary block's markers, and cannot open a comment there. */
  it("cannot forge a marker", () => {
    const text = renderMergeDanger({ door: "two-way", blastRadius: "x", doorNote: "<!-- /agent:summary -->" }, [
      followUp("<!-- agent:summary-final -->", "a"),
    ]);

    expect(text).not.toContain("<!--");
  });
});
