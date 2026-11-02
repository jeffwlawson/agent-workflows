import { describe, expect, it } from "vitest";
import { adopterActionSection, NO_ACTION, NO_EARLIER_RELEASE, releaseNotes } from "../scripts/release-notes.js";

/**
 * The Release's *Adopter action* section (#621), read from `Adopter-Action:`
 * trailers in the commits between the previous `v*` tag and this one. The log
 * is the text `git log --format=LOG_FORMAT` prints: each commit a record that
 * starts with the record separator, its short SHA on the first line and its
 * whole message after.
 */
const commit = (sha: string, message: string): string => `\x1e${sha}\n${message}\n`;
const log = (...commits: readonly string[]): string => commits.join("");

describe("the adopter action section", () => {
  it("says there is no adopter action when no commit carries a trailer", () => {
    const section = adopterActionSection(log(commit("abc1234", "fix(review): a thing (#10)\n\nBody.")));

    expect(section).toBe(`## Adopter action\n\n${NO_ACTION}\n`);
    expect(NO_ACTION).toBe("No adopter action.");
  });

  it("says so for a range with no commits at all", () => {
    expect(adopterActionSection("")).toBe(`## Adopter action\n\n${NO_ACTION}\n`);
  });

  it("lists one trailer with its short SHA and pull request", () => {
    const section = adopterActionSection(
      log(commit("abc1234", "feat(merge): a thing (#585)\n\nBody.\n\nAdopter-Action: Subscribe the App to the `pull_request_review` event in its settings.")),
    );

    expect(section).toBe(
      "## Adopter action\n\n- Subscribe the App to the `pull_request_review` event in its settings. (abc1234, #585)\n",
    );
  });

  it("lists several, from one commit and from several, in log order", () => {
    const section = adopterActionSection(
      log(
        commit("1111111", "feat: one (#2)\n\nAdopter-Action: First.\nAdopter-Action: Second."),
        commit("2222222", "feat: two (#1)\n\nAdopter-Action: Third."),
      ),
    );

    expect(section).toBe("## Adopter action\n\n- First. (1111111, #2)\n- Second. (1111111, #2)\n- Third. (2222222, #1)\n");
  });

  // A squash merge puts each commit's message end to end, so a trailer of an
  // early commit sits in the middle of the body, not in its last paragraph.
  it("takes a trailer from the middle of a squash body", () => {
    const body = [
      "feat(doctor): a change (#611) (#678)",
      "",
      "* feat(doctor): first commit (#611)",
      "",
      "Its body.",
      "",
      "Adopter-Action: Re-copy the caller from examples/callers/review.yml.",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "",
      "* docs: second commit (#611)",
      "",
      "More.",
      "",
      "---------",
      "",
      "Co-authored-by: someone <someone@users.noreply.github.com>",
    ].join("\n");

    expect(adopterActionSection(log(commit("ba0c0d6", body)))).toBe(
      "## Adopter action\n\n- Re-copy the caller from examples/callers/review.yml. (ba0c0d6, #678)\n",
    );
  });

  it("does not take the key mentioned mid-sentence, or indented", () => {
    const section = adopterActionSection(
      log(commit("abc1234", "docs: the convention (#621)\n\nA change carries an Adopter-Action: trailer when it must.\n  Adopter-Action: indented, quoted.")),
    );

    expect(section).toBe(`## Adopter action\n\n${NO_ACTION}\n`);
  });

  it("matches the key at the start of a line in any case", () => {
    const section = adopterActionSection(
      log(commit("abc1234", "feat: x (#3)\n\nadopter-action: Lower.\nADOPTER-ACTION:Upper, no space.")),
    );

    expect(section).toBe("## Adopter action\n\n- Lower. (abc1234, #3)\n- Upper, no space. (abc1234, #3)\n");
  });

  it("names only the SHA where the subject ends in no pull request number", () => {
    const section = adopterActionSection(
      log(commit("abc1234", "chore: pushed directly (#3 is mentioned)\n\nAdopter-Action: Do it.")),
    );

    expect(section).toBe("## Adopter action\n\n- Do it. (abc1234)\n");
  });

  it("skips a trailer with no sentence, and reads a CRLF message", () => {
    const section = adopterActionSection(log(commit("abc1234", "feat: x (#4)\r\n\r\nAdopter-Action:   \r\nAdopter-Action: Real.\r\n")));

    expect(section).toBe("## Adopter action\n\n- Real. (abc1234, #4)\n");
  });

  it("says there is no earlier release to compare with when there is no earlier tag", () => {
    expect(adopterActionSection(undefined)).toBe(`## Adopter action\n\n${NO_EARLIER_RELEASE}\n`);
    expect(NO_EARLIER_RELEASE).toBe("No earlier release to compare with.");
  });
});

describe("the Release body", () => {
  it("keeps the install sentence and carries the section after it", () => {
    const body = releaseNotes(log(commit("abc1234", "feat: x (#4)\n\nAdopter-Action: Real.")));

    expect(body).toMatch(/^Install without a registry token: npm install the tarball attached below, by its URL\. /);
    expect(body).toContain(".sha256");
    expect(body.endsWith("\n\n## Adopter action\n\n- Real. (abc1234, #4)\n")).toBe(true);
  });
});
