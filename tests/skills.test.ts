import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evalCaseProblems, frontmatterProblems, linkProblems, readmeProblems, skillNames } from "./skills.js";

/**
 * `skills/` held to its structure (#620). The real folder must have no problem;
 * each rule then has a fixture with one fault in it, run through the same
 * check, so a rule that never fires is caught.
 */

const SKILLS = "skills";

describe("the skills in this repository", () => {
  const names = skillNames(SKILLS);

  it("are found, and skills/evals/ is not one", () => {
    expect(names).toContain("issues-to-prd");
    expect(names).toContain("merge-check");
    expect(names).not.toContain("evals");
  });

  it.each(names)("%s has valid frontmatter and invocation pairing", (name) => {
    expect(frontmatterProblems(SKILLS, name)).toEqual([]);
  });

  it("have no relative link that points at nothing", () => {
    expect(linkProblems(SKILLS)).toEqual([]);
  });

  it("each have a row in skills/README.md, which links no missing skill", () => {
    expect(readmeProblems(SKILLS)).toEqual([]);
  });

  it("have eval cases in the layout claude plugin eval reads", () => {
    expect(evalCaseProblems(SKILLS)).toEqual([]);
  });

  it("include merge-check's digest case (#583)", () => {
    expect(fs.existsSync(path.join(SKILLS, "evals", "merge-check", "digest-mixed", "case.yaml"))).toBe(true);
  });
});

/** A `skills/` tree in a temporary folder: one model-invoked skill and one user-invoked, both valid. */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const MODEL = `---\nname: alpha\ndescription: "Does alpha. Use when asked to alpha."\n---\n\nSee [the guide](references/guide.md#top).\n`;
const USER = `---\nname: beta\ndescription: "Does beta for a person."\ndisable-model-invocation: true\n---\n\nBody.\n`;
const README = [
  "# Skills",
  "",
  "| Skill | What |",
  "|---|---|",
  "| [`alpha`](alpha/SKILL.md) | Alpha. |",
  "| [`beta`](beta/SKILL.md) | Beta. |",
  "",
  "Cases are in [evals](evals/), and [upstream](https://example.com/x) and [here](#skills) are not checked.",
  "",
].join("\n");

const fixture = (overrides: Record<string, string | null> = {}): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
  dirs.push(root);
  const files: Record<string, string | null> = {
    "README.md": README,
    "alpha/SKILL.md": MODEL,
    "alpha/references/guide.md": "Back to [the skill](../SKILL.md).\n",
    "beta/SKILL.md": USER,
    "evals/alpha/case/case.yaml": "name: case\n",
    "evals/alpha/case/prompt.md": "---\ntags: [alpha]\n---\n\nA case.\n",
    "evals/alpha/case/place-files.sh": "#!/usr/bin/env bash\n",
    "evals/alpha/case/files/world.md": "# World\n",
    "evals/alpha/case/graders/01.md": "An assertion.\n",
    ...overrides,
  };
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
};

const allProblems = (root: string): string[] => [
  ...skillNames(root).flatMap((name) => frontmatterProblems(root, name)),
  ...linkProblems(root),
  ...readmeProblems(root),
  ...evalCaseProblems(root),
];

describe("the checks over a fixture", () => {
  it("find nothing wrong with a valid tree, and list only the folders holding a SKILL.md", () => {
    const root = fixture({ "notes/plan.md": "Not a skill.\n" });
    expect(skillNames(root)).toEqual(["alpha", "beta"]);
    expect(allProblems(root)).toEqual([]);
  });

  describe("frontmatter", () => {
    it("fails a description with an unquoted colon, naming the file", () => {
      const root = fixture({ "alpha/SKILL.md": `---\nname: alpha\ndescription: Does alpha: Use when asked.\n---\n` });
      const problems = frontmatterProblems(root, "alpha");
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^skills\/alpha\/SKILL\.md's frontmatter does not parse as YAML/);
    });

    it("fails a SKILL.md with no frontmatter", () => {
      const root = fixture({ "alpha/SKILL.md": "# Alpha\n" });
      expect(frontmatterProblems(root, "alpha")).toEqual([
        "skills/alpha/SKILL.md does not open with YAML frontmatter between `---` lines.",
      ]);
    });

    it("fails a missing or empty description", () => {
      for (const line of ["", 'description: ""\n', "description: 3\n"]) {
        const root = fixture({ "beta/SKILL.md": `---\nname: beta\n${line}disable-model-invocation: true\n---\n` });
        expect(frontmatterProblems(root, "beta")).toEqual([
          "skills/beta/SKILL.md has no description; it needs a non-empty string.",
        ]);
      }
    });

    it("fails a name that is not the folder's", () => {
      const root = fixture({ "alpha/SKILL.md": MODEL.replace("name: alpha", "name: alfa") });
      expect(frontmatterProblems(root, "alpha")).toEqual([
        'skills/alpha/SKILL.md has name "alfa"; it must be its folder\'s name, "alpha".',
      ]);
    });

    it("fails a disable-model-invocation that is not a boolean", () => {
      const root = fixture({ "beta/SKILL.md": USER.replace("invocation: true", 'invocation: "yes"') });
      expect(frontmatterProblems(root, "beta")).toEqual([
        'skills/beta/SKILL.md sets disable-model-invocation to "yes"; it must be true or false.',
      ]);
    });
  });

  describe("invocation pairing", () => {
    it("fails a user-invoked skill whose description has a trigger list", () => {
      const root = fixture({ "beta/SKILL.md": USER.replace("for a person.", "for a person. Use when asked.") });
      const problems = frontmatterProblems(root, "beta");
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^skills\/beta\/SKILL\.md sets disable-model-invocation: true but its description has a "Use when" trigger list/);
    });

    it("fails a model-invoked skill whose description has no trigger list", () => {
      for (const text of [MODEL.replace(" Use when asked to alpha.", ""), USER.replace("invocation: true", "invocation: false")]) {
        const name = text.includes("name: alpha") ? "alpha" : "beta";
        const root = fixture({ [`${name}/SKILL.md`]: text });
        const problems = frontmatterProblems(root, name);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(new RegExp(`^skills/${name}/SKILL\\.md is model-invoked but its description has no "Use when" trigger list`));
      }
    });
  });

  describe("relative links", () => {
    it("fails a dead link in a SKILL.md, a references/ file and the README, naming the file and the link", () => {
      const root = fixture({
        "alpha/SKILL.md": `${MODEL}And [gone](references/gone.md#part).\n`,
        "alpha/references/guide.md": "Back to [the skill](../SKILL.md) and [a script](../scripts/run.sh).\n",
        "README.md": `${README}See [the old one](gamma/notes.md).\n`,
      });
      expect(linkProblems(root)).toEqual([
        "skills/README.md links to gamma/notes.md, which does not exist.",
        "skills/alpha/SKILL.md links to references/gone.md#part, which does not exist.",
        "skills/alpha/references/guide.md links to ../scripts/run.sh, which does not exist.",
      ]);
    });

    it("does not check inline code, a fenced block, a URL or a bare anchor", () => {
      const root = fixture({
        "beta/SKILL.md": `${USER}\`[x](nowhere.md)\` and [y](https://example.com/nowhere.md) and [z](#nowhere)\n\n\`\`\`md\n[w](nowhere.md)\n\`\`\`\n`,
      });
      expect(linkProblems(root)).toEqual([]);
    });
  });

  describe("the README against the folders", () => {
    it("fails a skill folder with no row", () => {
      const root = fixture({ "README.md": README.replace("| [`beta`](beta/SKILL.md) | Beta. |\n", "") });
      expect(readmeProblems(root)).toEqual([
        "skills/README.md has no table row linking to beta/SKILL.md; add one for the skill beta.",
      ]);
    });

    it("fails a row for a skill that has no folder", () => {
      const root = fixture({ "beta/SKILL.md": null });
      expect(readmeProblems(root)).toEqual([
        "skills/README.md links to the skill beta, which has no folder under skills/ with a SKILL.md.",
      ]);
    });
  });

  describe("eval cases", () => {
    it("fail a case missing a file or its graders, naming the case and the file", () => {
      const root = fixture({ "evals/alpha/case/files/world.md": null, "evals/alpha/case/graders/01.md": null });
      expect(evalCaseProblems(root)).toEqual([
        "skills/evals/alpha/case has no files/world.md; every case holds case.yaml, prompt.md, place-files.sh, files/world.md and graders/.",
        "skills/evals/alpha/case has no grader; add one graders/<nn>.md per assertion.",
      ]);
    });

    it("fail a case.yaml not named for its folder, and a prompt not tagged with its skill", () => {
      const root = fixture({
        "evals/alpha/case/case.yaml": "name: other\n",
        "evals/alpha/case/prompt.md": "---\ntags: [beta]\n---\n",
      });
      expect(evalCaseProblems(root)).toEqual([
        'skills/evals/alpha/case/case.yaml has name "other"; it must be its folder\'s name, "case".',
        'skills/evals/alpha/case/prompt.md\'s frontmatter has no tags list holding "alpha"; add tags: [alpha].',
      ]);
    });

    it("fail a folder of cases not named for a skill", () => {
      const root = fixture({ "evals/gamma/case/case.yaml": "name: case\n" });
      expect(evalCaseProblems(root)).toEqual([
        "skills/evals/gamma/ is not named for a skill; rename it to the skill its cases test.",
      ]);
    });
  });
});
