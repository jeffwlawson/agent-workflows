import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

/**
 * The structure of `skills/` (#620), read with no process and no network.
 *
 * Nothing in the loop reads that folder, so without this the gate never sees
 * it: a skill's frontmatter is parsed by the harness in the maintainer's editor,
 * and `skills/README.md` is read by a person. Each check returns the problems it
 * found as sentences naming what to fix, empty when there are none, so the test
 * over the real folder and the tests over a faulty fixture run the same code.
 *
 * Structure only: a skill's prose, its length and its eval coverage are not
 * judged here.
 */

/**
 * Every skill under a `skills/` folder, by name, sorted: a folder directly under
 * it that holds a `SKILL.md`. `skills/evals/` holds none, so it is not one. The
 * one list of skills; a later test (the plugin manifest, #605) imports it.
 */
export const skillNames = (skillsDir: string): string[] =>
  fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();

const rel = (skillsDir: string, file: string): string =>
  path.posix.join("skills", path.relative(skillsDir, file).split(path.sep).join("/"));

/** The trigger list a model-invoked skill's description ends with. */
const TRIGGER = /\bUse when\b/;

/** A skill's frontmatter, and its invocation pairing. */
export const frontmatterProblems = (skillsDir: string, name: string): string[] => {
  const file = path.join(skillsDir, name, "SKILL.md");
  const shown = rel(skillsDir, file);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(fs.readFileSync(file, "utf8"));
  if (match === null) return [`${shown} does not open with YAML frontmatter between \`---\` lines.`];

  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return [`${shown}'s frontmatter does not parse as YAML (${reason}); quote a value that holds a colon.`];
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [`${shown}'s frontmatter is not a YAML mapping.`];
  }
  const fields = data as Record<string, unknown>;
  const problems: string[] = [];

  if (fields["name"] !== name) {
    problems.push(`${shown} has name ${JSON.stringify(fields["name"])}; it must be its folder's name, "${name}".`);
  }
  const description = fields["description"];
  const hasDescription = typeof description === "string" && description.trim() !== "";
  if (!hasDescription) problems.push(`${shown} has no description; it needs a non-empty string.`);

  const flag = fields["disable-model-invocation"];
  if (flag !== undefined && typeof flag !== "boolean") {
    problems.push(`${shown} sets disable-model-invocation to ${JSON.stringify(flag)}; it must be true or false.`);
  } else if (hasDescription) {
    if (flag === true && TRIGGER.test(description)) {
      problems.push(
        `${shown} sets disable-model-invocation: true but its description has a "Use when" trigger list; a user-invoked skill's description is for a person, so drop the list.`,
      );
    }
    if (flag !== true && !TRIGGER.test(description)) {
      problems.push(
        `${shown} is model-invoked but its description has no "Use when" trigger list; add one, or set disable-model-invocation: true.`,
      );
    }
  }
  return problems;
};

/**
 * The target of every markdown link in a text. Fenced blocks and inline code
 * are removed first: a backticked path in prose is not a link.
 */
export const linkTargets = (text: string): string[] => {
  const prose = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g)].map((m) =>
    (m[1] ?? "").replace(/^<|>$/g, ""),
  );
};

/** A link to a URL, a bare anchor or an absolute path is not checked. */
const isRelative = (target: string): boolean =>
  target !== "" && !target.startsWith("#") && !target.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(target);

/** The markdown files whose links are checked: the README, each `SKILL.md`, and each skill's `references/`. */
const linkedFiles = (skillsDir: string): string[] => {
  const files = [path.join(skillsDir, "README.md")].filter((f) => fs.existsSync(f));
  for (const name of skillNames(skillsDir)) {
    files.push(path.join(skillsDir, name, "SKILL.md"));
    const refs = path.join(skillsDir, name, "references");
    if (fs.existsSync(refs)) {
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name);
          return entry.isDirectory() ? walk(full) : entry.name.endsWith(".md") ? [full] : [];
        });
      files.push(...walk(refs).sort());
    }
  }
  return files;
};

/** Every relative link that points at nothing. An anchor on a relative link is ignored. */
export const linkProblems = (skillsDir: string): string[] =>
  linkedFiles(skillsDir).flatMap((file) =>
    linkTargets(fs.readFileSync(file, "utf8"))
      .filter(isRelative)
      .filter((target) => {
        const bare = decodeURI(target.replace(/[#?].*$/, ""));
        return bare !== "" && !fs.existsSync(path.resolve(path.dirname(file), bare));
      })
      .map((target) => `${rel(skillsDir, file)} links to ${target}, which does not exist.`),
  );

/** `skills/README.md` against the folders: a table row per skill, and no row for a skill that is gone. */
export const readmeProblems = (skillsDir: string): string[] => {
  const readme = path.join(skillsDir, "README.md");
  if (!fs.existsSync(readme)) return ["skills/README.md does not exist; it lists every skill."];
  const text = fs.readFileSync(readme, "utf8");
  const names = skillNames(skillsDir);

  const linkedSkill = (target: string): string | undefined =>
    /^(?:\.\/)?([^/#?]+)\/SKILL\.md(?:[#?].*)?$/.exec(target)?.[1];
  const rowed = new Set(
    text
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"))
      .flatMap((line) => linkTargets(line).map(linkedSkill))
      .filter((skill): skill is string => skill !== undefined),
  );
  const linked = new Set(linkTargets(text).map(linkedSkill).filter((skill): skill is string => skill !== undefined));

  return [
    ...names
      .filter((name) => !rowed.has(name))
      .map((name) => `skills/README.md has no table row linking to ${name}/SKILL.md; add one for the skill ${name}.`),
    ...[...linked]
      .filter((name) => !names.includes(name))
      .sort()
      .map((name) => `skills/README.md links to the skill ${name}, which has no folder under skills/ with a SKILL.md.`),
  ];
};
