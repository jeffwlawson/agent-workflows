import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, RUNNERS } from "../shared/contract.js";

/**
 * **Every link to a workflow run is labelled `[Workflow run](…)`** (#298),
 * wherever the loop posts one, and no run's URL is posted bare. Held over the
 * sources that write posted text: the workflows and the composite action, the
 * shared helpers, and the runners.
 *
 * A run URL is `RUN_URL` in a workflow, a `runUrl` interpolated into a
 * template, or a literal `…/actions/runs/…`. Each one must sit in a Markdown
 * link labelled exactly `Workflow run`, or be a `printf` argument whose format
 * links it so, or be something nobody reads as text: a log line, a status's
 * `target_url`, an API call, or the definition of the URL itself.
 */

/** Each runner's module, and each command's, `<workflow>:<step>` at `<workflow>/<step>.ts`. */
const SUBCOMMAND_MODULES = [
  ...Object.keys(RUNNERS).map((name) => path.join(name, `${name}.ts`)),
  ...Object.keys(COMMANDS).map((name) => path.join(...name.split(":")) + ".ts"),
];

const SOURCES: readonly string[] = [
  ...fs
    .readdirSync(path.join(".github", "workflows"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => path.join(".github", "workflows", f)),
  ...fs
    .readdirSync(path.join(".github", "actions"))
    .map((d) => path.join(".github", "actions", d, "action.yml"))
    .filter((f) => fs.existsSync(f)),
  ...fs
    .readdirSync("shared")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join("shared", f)),
  ...SUBCOMMAND_MODULES,
];

/** One occurrence of a run's URL in a line. */
const RUN_URL = /\$\{RUN_URL\}|\$RUN_URL\b|\$\{[\w.?]*\brunUrl\}|https?:\/\/[^\s)"'`]*\/actions\/runs\/[^\s)"'`]*/g;

/** What a line says that nobody reads as posted text. */
const NOT_POSTED = [
  // A log line, which the run's page shows and no comment does.
  /\|\| echo "::(warning|error)::.*$/,
  /echo "::(warning|error)::.*$/,
  // A status's link, an API call, and the URL's own definition.
  /"target_url=\$\{RUN_URL\}"/,
  /^\s*RUN_URL: \$\{\{.*$/,
  /gh api .*$/,
  /return `\$\{server\}\/\$\{repo\}\/actions\/runs\/\$\{runId\}`;/,
];

/** Every run URL in `text` that is posted unlabelled or under another label, as `line: text`. */
const offendersIn = (text: string): string[] =>
  text.split("\n").flatMap((raw, i) => {
    if (/^\s*(#|\/\/|\*|\/\*)/.test(raw)) return [];
    let line = raw;
    for (const pattern of NOT_POSTED) line = line.replace(pattern, "");
    const found: string[] = [];
    // A Markdown link to a run must be labelled exactly so.
    for (const link of line.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)) {
      const target = link[2] ?? "";
      const toRun = new RegExp(RUN_URL.source).test(target) || (target === "%s" && /\$\{?RUN_URL\b/.test(line));
      if (toRun && link[1] !== "Workflow run") found.push(`${i + 1}: ${raw.trim()}`);
    }
    // And no run URL outside such a link, nor as a `printf` argument whose
    // format links it any other way.
    const linked = line.replace(/\[Workflow run\]\([^)]*\)/g, "");
    const printfLinked = /^\s*printf '[^']*\[Workflow run\]\(%s\)[^']*' .*"\$RUN_URL"/.test(line);
    const bare = linked.replace(printfLinked ? /"\$RUN_URL"/g : /$^/g, "");
    if (new RegExp(RUN_URL.source).test(bare)) found.push(`${i + 1}: ${raw.trim()}`);
    return [...new Set(found)];
  });

describe("every posted link to a workflow run is labelled Workflow run", () => {
  it.each(SOURCES)("%s", (file) => {
    expect(offendersIn(fs.readFileSync(file, "utf8"))).toEqual([]);
  });

  it("reads the sources it means to", () => {
    expect(SOURCES).toContain(path.join(".github", "workflows", "implement.yml"));
    expect(SOURCES).toContain(path.join("shared", "review-output.ts"));
    expect(SOURCES).toContain(path.join("review", "review.ts"));
    expect(SOURCES).toContain(path.join(".github", "actions", "advance-prd", "action.yml"));
  });

  /** What it catches, so a check that passes is one that looked. */
  it.each([
    ["another label", '          gh pr comment 1 --body "Opened ([run](${RUN_URL}))."'],
    ["another label in a template", "  `_Posted by [this workflow run](${parts.runUrl})._`,"],
    ["another label in a printf", "          printf '[the run](%s)\\n' \"$RUN_URL\" > \"$body_file\""],
    ["a bare URL", '          gh issue comment 1 --body "It ran at ${RUN_URL}."'],
    ["a bare literal", '          body="See https://github.com/o/r/actions/runs/7 for it."'],
    ["a bare interpolation", "  `It ran at ${runUrl}.`,"],
  ])("catches %s", (_case, line) => {
    expect(offendersIn(line)).toHaveLength(1);
  });

  it.each([
    ["the label", '          gh pr comment 1 --body "Started · [Workflow run](${RUN_URL})"'],
    ["a printf that links it so", "          printf '**x** %s\\n\\n[Workflow run](%s) · %s\\n' \"$reason\" \"$RUN_URL\" \"$retry\" > \"$f\""],
    ["a log line", '          gh pr comment 1 --body "x" || echo "::warning::Could not post. The run goes on; it is ${RUN_URL}."'],
    ["a status link", '            -f "context=agent-review" -f "state=error" -f "target_url=${RUN_URL}" \\'],
  ])("passes %s", (_case, line) => {
    expect(offendersIn(line)).toEqual([]);
  });
});
