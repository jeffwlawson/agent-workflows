---
source: >-
  The fix that shipped for this round on PR #732 (2026-11-03T14:56Z): aeb9997's change against a00633d (this case's head), its commit message, and its outcome on the conversation comment (https://github.com/jeffwlawson/agent-workflows/pull/732#issuecomment-6607100112), laid out as the replay note asks. The round had no thread to reply on.
expect:
  "01": pass
  "02": pass
  "03": pass
  "04": pass
---

1. The change, as `git diff` prints it against the head:

```diff
diff --git a/evals/README.md b/evals/README.md
index 4de8293..9cc2f76 100644
--- a/evals/README.md
+++ b/evals/README.md
@@ -99,7 +99,9 @@ brief is right not to raise it. `restart-order` 05 is the finding 13 of 15 store
 no grader credited: the halves default `PKG_JSON` to a path under the package's own scope while
 `upgrade.sh` honours `PACKAGE_NAME`. It is a real defect against the brief ("No owner or repo name
 is written in any script"); the loop's own reviews of the head recorded it, and it is filed as #580.
-Grader numbers are not reused, so a stored run's 04 is still this 04.
+Grader numbers are not reused. The verdicts, `restart-order` 04 and `rescue-deleted-before-open` 03,
+were reworded after the first run of the controls (below) to say what counts as asking for a change,
+so a stored run's 04 was graded by the earlier file, and `compare` refuses to pool the two.
 
 ## Controls
 
@@ -118,12 +120,29 @@ is edited.
 node scripts/eval-prompts.ts controls review --model claude-haiku-5-5 --max-cost-usd 2
 ```
 
-stages each control as a case of its own, whose prompt has the model repeat the control's text as its
-final message, graded by the graders it names, as they are; no checkout, one run each. The report
-lists each ruling against what the control expects, and the command exits 1 where one differs. It
-costs the judge and an echo of the text. **No run of the controls had been made** when they were
-added: there was no credential where they were written. Run them, and fix a grader that fails one,
-before the next comparison that declares it.
+stages each control as a case of its own, whose scaffold puts the control's text in the run's
+sandbox as `control.md`. Its graders are the case's graders it names, criteria as they are, each
+with its `focus` moved from the final message to that file (`focus: { source: file, path:
+control.md }`), so the judge reads the text itself; the model is asked for one word, which nothing
+reads. One run each, no checkout. The cost is the judge's.
+
+The report lists each ruling against what the control expects, with the judge's reason where it
+differs. A ruling counts only where the judge was shown the control's text (the tool's `evidence`
+for that grader, which holds what the judge read): any other ruling is **void**, counted on its own
+line and never called broken or too loose. The command exits 1 only on a ruling that differs from
+`expect` on the control's own text.
+
+**The first run** (on `a00633d`, before this staging) had the model echo the text as its final
+message, so the judge graded the echo: 25 of 27 review rulings and 4 of 6 fix rulings held with a
+`claude-haiku-5-5` echo, and 23 of 27 and 6 of 6 with `claude-opus-5-5`. Most of the broken
+rulings were the echo: the two runs broke different controls. One broke under both,
+`restart-order/changes-after-fix` grader 04. That control is right: Review 3 at `58a8c32` of #577
+asked for changes, with a High (an acceptance criterion ruled unmet) and two Lows. The grader was
+the problem. It asked whether the review "asks for at least one change before merge", and this
+review's findings are ones the author may skip by replying, and its High one the pull request may
+depart from by saying why. So 04, and `rescue-deleted-before-open` 03, which had the same words,
+now say what counts. No run has yet graded the text directly. Run them, and fix a grader that
+fails one, before the next comparison that declares it.
 
 ## What a case reaches
 
@@ -299,7 +318,8 @@ reported does not depend on what was seen.
    (`### \`<prompt>\` comparison`) whose two sides ran the prompt's blob at the merge-base and at
    the head, in that order. A comparison of an earlier revision of the change does not count: edit
    the prompt again and the comparison is owed again. A change no eval can measure (a typo in a
-   heading no case reads) says so with a line `Eval-Waiver: <the reason>` in the body. The job
+   heading no case reads) says so with a line `Eval-Waiver: <the reason>` in the body; one in a
+   comment waives nothing, since anyone who can comment could post it. The job
    runs again when the body is edited; after posting the comparison as a comment, re-run it.
 
 **The words to use.** At p < 0.029 on a primary or guard: the grader *rose* or *fell*, with both
diff --git a/evals/baseline.md b/evals/baseline.md
index ff2d385..c552111 100644
--- a/evals/baseline.md
+++ b/evals/baseline.md
@@ -16,7 +16,7 @@ and is the only fix record taken on the graders as they now stand.
 
 **The graders have changed since** (#718, `README.md`, *What a grader is counted as*): the clean
 case's 02 and `restart-order` 03 are removed, `restart-order` 05 is added, 03 of
-`rescue-deleted-before-open` and 04 of `restart-order` are now verdicts, and 02 of
+`rescue-deleted-before-open` and 04 of `restart-order` are now verdicts (and reworded), and 02 of
 `persisted-checkout-token` is counted given 01. The tables below are as they were taken.
 
 Misses are part of the baseline: several graders pass in none of their runs. The tables are the
diff --git a/evals/review/rescue-deleted-before-open/graders/03.md b/evals/review/rescue-deleted-before-open/graders/03.md
index 2c76b03..43ec945 100644
--- a/evals/review/rescue-deleted-before-open/graders/03.md
+++ b/evals/review/rescue-deleted-before-open/graders/03.md
@@ -4,4 +4,4 @@ focus: last_message
 weight: 1
 ---
 
-The review does not recommend approval: it asks for at least one change before merge.
+The review does not recommend approval: it raises at least one finding to fix before merge, at any severity, or rules an acceptance criterion unmet, or says changes are recommended or requested. A finding the author may skip by replying with a reason, or one the pull request may depart from by saying why in its body, still asks for a change. Follow-ups and notes for later do not.
diff --git a/evals/review/restart-order/graders/04.md b/evals/review/restart-order/graders/04.md
index 2c76b03..43ec945 100644
--- a/evals/review/restart-order/graders/04.md
+++ b/evals/review/restart-order/graders/04.md
@@ -4,4 +4,4 @@ focus: last_message
 weight: 1
 ---
 
-The review does not recommend approval: it asks for at least one change before merge.
+The review does not recommend approval: it raises at least one finding to fix before merge, at any severity, or rules an acceptance criterion unmet, or says changes are recommended or requested. A finding the author may skip by replying with a reason, or one the pull request may depart from by saying why in its body, still asks for a change. Follow-ups and notes for later do not.
diff --git a/scripts/eval-prompts.ts b/scripts/eval-prompts.ts
index 9be4639..a191f6a 100644
--- a/scripts/eval-prompts.ts
+++ b/scripts/eval-prompts.ts
@@ -74,8 +74,8 @@ const graderName = (file: string): string => file.slice(0, -".md".length);
  * A control (#718): real text, a review or merge-check comment or a fix that
  * shipped, with what each grader named must rule on it. A grader that fails a
  * text it should pass is broken; one that passes a text it should fail is too
- * loose. `controls <prompt>` has the judge grade them, which costs only the
- * judge and an echo of the text.
+ * loose. `controls <prompt>` has the judge grade the text itself, which costs
+ * the judge and a one-word reply.
  */
 export interface Control {
   readonly name: string;
@@ -443,6 +443,8 @@ export interface StagedControl {
   readonly case: string;
   readonly control: string;
   readonly expect: Readonly<Record<string, boolean>>;
+  /** The text its graders must have read, which a run's `evidence` is checked against. */
+  readonly text: string;
 }
 
 /** One prompt staged under a name; a run with more than one stages every case once per arm. */
@@ -532,22 +534,35 @@ export const stage = (
   return meta;
 };
 
-/** The marker lines a control's text is set between in the prompt that echoes it. */
-const CONTROL_START = "=====CONTROL TEXT START=====";
-const CONTROL_END = "=====CONTROL TEXT END=====";
+/** Where a staged control's text is put in its run's sandbox, which its graders read. */
+export const CONTROL_FILE = "control.md";
+
+/**
+ * A grader as a control stages it: its criteria as they are, with its
+ * `focus` moved from the run's final message to the control's text in the
+ * sandbox. Only the judge's ruling is under test, so it reads the text
+ * itself and nothing a model wrote (#718).
+ */
+export const controlGrader = (grader: string): string => {
+  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(grader);
+  if (match === null) throw new Error("A grader does not open with YAML frontmatter.");
+  const head = (parse(match[1] ?? "") ?? {}) as Record<string, unknown>;
+  return `---\n${stringify({ ...head, focus: { source: "file", path: CONTROL_FILE } }).trimEnd()}\n---\n${match[2] ?? ""}`;
+};
 
 /**
  * The controls as `claude plugin eval` reads them (#718): one staged case per
- * control, whose prompt has the model repeat the control's text as its final
- * message, graded by the case's graders the control names, as they are. Only
- * the judge's ruling is under test, so no scaffold and no checkout: the run
- * costs the judge and an echo of the text.
+ * control, whose scaffold puts the control's text in the run's sandbox as
+ * `control.md`, graded from that file by the case's graders the control names,
+ * criteria as they are. The model is asked for one word and its message is
+ * read by nothing: what a judge rules on is the text, not an echo of it. The
+ * run costs the judge and a one-word reply.
  */
 export const stageControls = (root: string, prompt: PromptName, out: string, only?: (name: string) => boolean): StageMeta => {
   const cases = caseDirs(root, prompt)
     .map(readCase)
     .filter((c) => only === undefined || only(c.name));
-  const frontmatter = stringify({ tags: [prompt, "control"], max_turns: 2, timeout_seconds: 300, allowed_tools: ["Read"] }).trimEnd();
+  const frontmatter = stringify({ tags: [prompt, "control"], max_turns: 1, timeout_seconds: 300, allowed_tools: [] }).trimEnd();
   const staged: StagedCase[] = [];
   const controls: StagedControl[] = [];
   for (const c of cases) {
@@ -556,27 +571,28 @@ export const stageControls = (root: string, prompt: PromptName, out: string, onl
       const name = `${c.name}--${control.name}`;
       const dir = path.join(out, "evals", name);
       fs.mkdirSync(path.join(dir, "graders"), { recursive: true });
+      fs.writeFileSync(path.join(dir, "prompt.md"), `---\n${frontmatter}\n---\n\nReply with the one word \`done\`. Use no tool.\n`);
+      fs.writeFileSync(path.join(dir, CONTROL_FILE), `${control.text}\n`);
       fs.writeFileSync(
-        path.join(dir, "prompt.md"),
-        [
-          `---\n${frontmatter}\n---`,
-          "",
-          `Your final message is the text between the line \`${CONTROL_START}\` and the line \`${CONTROL_END}\` below, exactly as it stands: every line of it, in order, and nothing else. No preamble, no comment, no summary, and not the marker lines. Use no tool.`,
-          "",
-          CONTROL_START,
-          control.text,
-          CONTROL_END,
-          "",
-        ].join("\n"),
+        path.join(dir, "place-files.sh"),
+        `#!/usr/bin/env bash\nexec cp ${quote(path.join(dir, CONTROL_FILE))} ${quote(CONTROL_FILE)}\n`,
+        { mode: 0o755 },
       );
       fs.writeFileSync(
         path.join(dir, "case.yaml"),
-        stringify({ schema_version: "1.1", name, expected_outcome: `Repeats the control text, ${control.name} of ${c.name}, as its final message.\n` }),
+        stringify({
+          schema_version: "1.1",
+          name,
+          context: { scaffold_script: "place-files.sh" },
+          expected_outcome: `The graders rule on ${CONTROL_FILE}, ${control.name} of ${c.name}, as its expect says.\n`,
+        }),
       );
       const graders = Object.keys(control.expect);
-      for (const grader of graders) fs.copyFileSync(path.join(c.dir, "graders", `${grader}.md`), path.join(dir, "graders", `${grader}.md`));
+      for (const grader of graders) {
+        fs.writeFileSync(path.join(dir, "graders", `${grader}.md`), controlGrader(fs.readFileSync(path.join(c.dir, "graders", `${grader}.md`), "utf8")));
+      }
       staged.push({ name, pr: c.pr, head: c.head, clean: false, case: c.name, graders: Object.fromEntries(graders.map((g) => [g, hashes[g] ?? ""])) });
-      controls.push({ name, case: c.name, control: control.name, expect: control.expect });
+      controls.push({ name, case: c.name, control: control.name, expect: control.expect, text: control.text });
     }
   }
   if (controls.length === 0) throw new Error(`No ${prompt} case matched has a control.`);
@@ -603,7 +619,15 @@ export interface EvalResult {
         readonly turns?: number;
         /** In the run's sandbox, which the tool deletes after the run unless given `--keep-temp`. */
         readonly tracePath?: string;
-        readonly graders: readonly { readonly name: string; readonly passed: boolean; readonly judgeVotes?: readonly boolean[] }[];
+        readonly graders: readonly {
+          readonly name: string;
+          readonly passed: boolean;
+          readonly judgeVotes?: readonly boolean[];
+          /** The judge's reason for its ruling. */
+          readonly explanation?: string;
+          /** What the judge was shown, capped by the tool at 100 KB. */
+          readonly evidence?: string;
+        }[];
       }[];
     };
   }[];
@@ -639,47 +663,81 @@ const tally = (runs: readonly Graded[], grader: string, rule: GraderRule | undef
 const graderLabel = (name: string, rule: GraderRule | undefined): string =>
   rule === undefined ? name : rule.kind === "verdict" ? `${name} (verdict)` : `${name} given ${rule.grader}`;
 
-/** Each grader of each control against what it must rule, from a run of the controls. */
-export const controlRows = (
-  meta: StageMeta,
-  result: EvalResult,
-): { case: string; control: string; grader: string; expected: boolean; judged: boolean | undefined; check: string }[] =>
+/** One grader of one control, against what it must rule. */
+export interface ControlRow {
+  readonly case: string;
+  readonly control: string;
+  readonly grader: string;
+  readonly expected: boolean;
+  /** The ruling every counted run agrees on; `undefined` where none is counted or they split. */
+  readonly judged: boolean | undefined;
+  /**
+   * `held` as expected; `differs` a ruling against it, on the control's own
+   * text; `void` where no completed run's judge was shown that text, so its
+   * ruling says nothing about the grader; `none` where no run completed.
+   */
+  readonly status: "held" | "differs" | "void" | "none";
+  readonly check: string;
+  /** The judge's reasons, one per counted run, where its ruling differs. */
+  readonly explanations: readonly string[];
+}
+
+const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
+
+/**
+ * Each grader of each control against what it must rule, from a run of the
+ * controls. A run is counted for a grader only where the judge was shown the
+ * control's text (the tool's `evidence`, which holds what the judge read): a
+ * ruling on anything else is **void**, never broken or too loose, so a
+ * verdict here depends on the text and not on how the run went (#718).
+ */
+export const controlRows = (meta: StageMeta, result: EvalResult): ControlRow[] =>
   (meta.controls ?? []).flatMap((control) => {
     const runs = (result.cases.find((c) => c.name === control.name)?.arms.with ?? []).filter((run) => !erroredRun(run));
-    return Object.entries(control.expect).map(([grader, expected]) => {
-      const passedIn = runs.filter((run) => passes(run, grader)).length;
+    const want = typeof control.text === "string" ? squash(control.text) : undefined;
+    return Object.entries(control.expect).map(([grader, expected]): ControlRow => {
+      const rulings = runs.flatMap((run) => run.graders.filter((g) => g.name === grader));
+      const read = rulings.filter((g) => want !== undefined && want !== "" && typeof g.evidence === "string" && squash(g.evidence).includes(want));
+      const passedIn = read.filter((g) => g.passed).length;
       // With more than one run, the control holds only where every run agrees.
-      const judged = runs.length === 0 ? undefined : passedIn === runs.length ? true : passedIn === 0 ? false : undefined;
+      const judged = read.length === 0 ? undefined : passedIn === read.length ? true : passedIn === 0 ? false : undefined;
+      const row = { case: control.case, control: control.control, grader, expected, judged };
+      if (runs.length === 0) return { ...row, status: "none", check: "no completed run", explanations: [] };
+      if (read.length === 0) {
+        return { ...row, status: "void", check: "void: the judge was not shown the control's text", explanations: [] };
+      }
+      if (judged === expected) return { ...row, status: "held", check: "as expected", explanations: [] };
       const check =
-        runs.length === 0
-          ? "no completed run"
-          : judged === expected
-            ? "as expected"
-            : judged === undefined
-              ? `split (${passedIn}/${runs.length})`
-              : expected
-                ? "**broken**: fails its positive control"
-                : "**too loose**: passes its negative control";
-      return { case: control.case, control: control.control, grader, expected, judged, check };
+        judged === undefined
+          ? `split (${passedIn}/${read.length})`
+          : expected
+            ? "**broken**: fails its positive control"
+            : "**too loose**: passes its negative control";
+      const explanations = read.filter((g) => g.passed !== expected).map((g) => g.explanation ?? "").filter((text) => text.trim() !== "");
+      return { ...row, status: "differs", check, explanations };
     });
   });
 
 /** The report of a run of the controls: per control and grader, what it must rule and what the judge ruled. */
 export const controlsReport = (meta: StageMeta, result: EvalResult, dir?: string): string => {
   const rows = controlRows(meta, result);
-  const held = rows.filter((row) => row.check === "as expected").length;
+  const count = (status: ControlRow["status"]): number => rows.filter((row) => row.status === status).length;
   const word = (b: boolean | undefined): string => (b === undefined ? "n/a" : b ? "pass" : "fail");
+  const differing = rows.filter((row) => row.status === "differs" && row.explanations.length > 0);
   return `${[
     `### \`${meta.prompt}\` grader controls`,
     "",
     `- **Model:** ${result.suite?.modelOverride ?? "(not recorded)"}; **judge:** ${result.suite?.judgeModel ?? "(not recorded)"}; **Claude Code:** ${result.claudeVersion ?? "(not recorded)"}`,
     `- **Cost:** $${(result.costUsd ?? 0).toFixed(2)}${result.partial === true ? " (**partial**: the cost ceiling stopped the run)" : ""}`,
     ...(dir === undefined ? [] : [`- **Run directory:** \`${dir}\``]),
-    `- **${held} of ${rows.length}** grader rulings as the controls expect.`,
+    `- **${count("held")} of ${rows.length}** grader rulings as the controls expect; **${count("differs")}** differ; **${count("void")}** void (the judge was not shown the control's text); **${count("none")}** with no completed run.`,
     "",
     "| Case | Control | Grader | Expected | Judged | Check |",
     "| --- | --- | --- | --- | --- | --- |",
     ...rows.map((row) => `| ${row.case} | ${row.control} | ${row.grader} | ${word(row.expected)} | ${word(row.judged)} | ${row.check} |`),
+    ...(differing.length === 0
+      ? []
+      : ["", "**Why the judge ruled otherwise:**", "", ...differing.flatMap((row) => row.explanations.map((text) => `- ${row.case} ${row.control} ${row.grader}: ${oneLine(text, 400)}`))]),
   ].join("\n")}\n`;
 };
 
@@ -1002,11 +1060,18 @@ const WAIVER = /^Eval-Waiver:[ \t]*(\S.*)$/m;
  * the merge-base and at the head, as `compare` prints them (`blob` and its
  * first 12 hex, before then after). A comparison of other blobs is one of an
  * earlier revision of the change, and does not count. An `Eval-Waiver:` line
- * with a reason stands for all of them. Empty when nothing is owed.
+ * with a reason in the body stands for all of them; one in a comment does not,
+ * since anyone who can comment could post it. Empty when nothing is owed.
  */
-export const comparisonProblems = (changes: readonly PromptChange[], texts: readonly string[], mergeBase = "<merge-base>"): string[] => {
+export const comparisonProblems = (
+  changes: readonly PromptChange[],
+  body: string,
+  comments: readonly string[],
+  mergeBase = "<merge-base>",
+): string[] => {
   if (changes.length === 0) return [];
-  if (texts.some((text) => WAIVER.test(text))) return [];
+  if (WAIVER.test(body)) return [];
+  const texts = [body, ...comments];
   return changes.flatMap((change) => {
     const heading = `### \`${change.prompt}\` comparison`;
     const found = texts.flatMap((text) =>
@@ -1056,11 +1121,9 @@ const checkComparison = (root: string): never => {
     process.exit(0);
   }
   const gh = (args: readonly string[]): string => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
-  const texts = [
-    gh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".body // \"\""]),
-    gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", ".[].body"]),
-  ];
-  const problems = comparisonProblems(changes, texts, mergeBase.slice(0, 12));
+  const body = gh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".body // \"\""]);
+  const comments = [gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", ".[].body"])];
+  const problems = comparisonProblems(changes, body, comments, mergeBase.slice(0, 12));
   for (const problem of problems) console.log(`::error::${problem}`);
   if (problems.length > 0) process.exit(1);
   console.log(`Each changed prompt (${changes.map((c) => c.prompt).join(", ")}) carries its comparison, or the change is waived.`);
@@ -1325,14 +1388,15 @@ const runCases = (root: string, prompt: PromptName, mode: string, opts: RunOptio
   }
   if (opts.stageOnly) process.exit(0);
 
-  // A control is only an echo of its text: no checkout, and no tool to grant.
+  // A control's graders read its text from the sandbox: no checkout, and no
+  // tool to grant.
   const tools = controls ? [] : readSuite(root, prompt).execution.allowed_tools.filter((tool) => GATED_TOOLS.has(tool));
   const runs = opts.runs ?? (controls ? "1" : undefined);
   const args = [
     "plugin", "eval", out,
     // The staged cases are this repository's, written by this script: their
-    // scaffold is `evals/checkout.sh`.
-    ...(controls ? [] : ["--scaffold"]), "--trust-plugin",
+    // scaffold is `evals/checkout.sh`, or for a control a copy of its text.
+    "--scaffold", "--trust-plugin",
     // No plugin is under test, so no without-plugin arm; and the report stays
     // on this machine rather than being published.
     "--ablation", "none", "--no-publish",
@@ -1360,10 +1424,11 @@ const runCases = (root: string, prompt: PromptName, mode: string, opts: RunOptio
   printReport(out);
   // 2 is the cost ceiling, whose partial report is printed above.
   if (run.status === 2) process.exit(2);
-  // A control the judge ruled against is a grader to fix: say so in the status too.
+  // A control the judge ruled against, on the control's own text, is a grader
+  // to fix: say so in the status too. A void ruling is in the report, not here.
   if (controls) {
     const rows = controlRows(readJson<StageMeta>(path.join(out, "stage.json")), readJson<EvalResult>(path.join(out, "result.json")));
-    process.exit(rows.every((row) => row.check === "as expected") ? 0 : 1);
+    process.exit(rows.some((row) => row.status === "differs") ? 1 : 0);
   }
   process.exit(0);
 };
diff --git a/tests/evals.test.ts b/tests/evals.test.ts
index 425ba72..ce166fa 100644
--- a/tests/evals.test.ts
+++ b/tests/evals.test.ts
@@ -21,6 +21,8 @@ import {
   runRecords,
   sandboxOf,
   sections,
+  stageControls,
+  CONTROL_FILE,
   type EvalResult,
   type RunRecord,
   type StageMeta,
@@ -237,31 +239,88 @@ describe("a grader's grading", () => {
 });
 
 describe("a run of the controls", () => {
+  const MERGE_CHECK = "Medium: the checkout persists a token.\n\nLow: the install check can be skipped.";
+  const APPROVED = "### Approval recommended\n\nNothing is unresolved.";
   const meta: StageMeta = {
     prompt: "review",
     revision: { file: "review/prompt.md", head: "a".repeat(40), lastChange: "b".repeat(40), blob: "c".repeat(40), uncommitted: false },
     cases: [],
     controls: [
-      { name: "escape--merge-check", case: "escape", control: "merge-check", expect: { "01": true, "02": true } },
-      { name: "escape--approved", case: "escape", control: "approved", expect: { "01": false, "02": false } },
+      { name: "escape--merge-check", case: "escape", control: "merge-check", expect: { "01": true, "02": true }, text: MERGE_CHECK },
+      { name: "escape--approved", case: "escape", control: "approved", expect: { "01": false, "02": false }, text: APPROVED },
     ],
   };
-  const run = (passed: Record<string, boolean>) => ({ error: null, graders: Object.entries(passed).map(([name, ok]) => ({ name, passed: ok })) });
-  const result: EvalResult = {
+  const run = (passed: Record<string, boolean>, evidence: string | undefined) => ({
+    error: null,
+    graders: Object.entries(passed).map(([name, ok]) => ({
+      name,
+      passed: ok,
+      explanation: ok ? "It says so." : "It does not say so.",
+      ...(evidence === undefined ? {} : { evidence }),
+    })),
+  });
+  const result = (merge: string | undefined, approved: string | undefined): EvalResult => ({
     cases: [
-      { name: "escape--merge-check", graders: [], arms: { with: [run({ "01": true, "02": false })] } },
-      { name: "escape--approved", graders: [], arms: { with: [run({ "01": true, "02": false })] } },
+      { name: "escape--merge-check", graders: [], arms: { with: [run({ "01": true, "02": false }, merge)] } },
+      { name: "escape--approved", graders: [], arms: { with: [run({ "01": true, "02": false }, approved)] } },
     ],
-  };
+  });
+
+  it("says which grader fails its positive control and which passes its negative one, on the control's own text", () => {
+    // The judge's evidence may frame the text and wrap it differently.
+    const rows = controlRows(meta, result(`File control.md:\n${MERGE_CHECK.replaceAll("\n\n", "\n")}\n`, APPROVED));
 
-  it("says which grader fails its positive control and which passes its negative one", () => {
-    expect(controlRows(meta, result).map((row) => `${row.control}/${row.grader}: ${row.check}`)).toEqual([
+    expect(rows.map((row) => `${row.control}/${row.grader}: ${row.check}`)).toEqual([
       "merge-check/01: as expected",
       "merge-check/02: **broken**: fails its positive control",
       "approved/01: **too loose**: passes its negative control",
       "approved/02: as expected",
     ]);
-    expect(report(meta, result)).toContain("**2 of 4** grader rulings as the controls expect.");
+    expect(rows.find((row) => row.control === "merge-check" && row.grader === "02")?.explanations).toEqual(["It does not say so."]);
+    const text = report(meta, result(MERGE_CHECK, APPROVED));
+    expect(text).toContain("**2 of 4** grader rulings as the controls expect; **2** differ; **0** void");
+    expect(text).toContain("- escape merge-check 02: It does not say so.");
+  });
+
+  // The maintainer's run on a00633d: the model asked to echo the text did not
+  // always, and the graders judged what it wrote. A ruling on other text says
+  // nothing about the grader.
+  it("voids a ruling whose judge was not shown the control's text, rather than calling the grader broken", () => {
+    const rows = controlRows(meta, result(MERGE_CHECK.slice(0, 20), undefined));
+
+    expect(rows.map((row) => `${row.control}/${row.grader}: ${row.status}`)).toEqual([
+      "merge-check/01: void",
+      "merge-check/02: void",
+      "approved/01: void",
+      "approved/02: void",
+    ]);
+    expect(report(meta, result(MERGE_CHECK.slice(0, 20), undefined))).toContain("**0 of 4** grader rulings as the controls expect; **0** differ; **4** void");
+  });
+
+  it("stages each control's text as a file its graders read, with each grader's criteria as they are", () => {
+    const out = fs.mkdtempSync(path.join(os.tmpdir(), "controls-"));
+    try {
+      const staged = stageControls(ROOT, "review", out, (name) => name === "restart-order");
+      const c = readCase(caseDirs(ROOT, "review").find((dir) => path.basename(dir) === "restart-order") ?? "");
+      const control = c.controls.find((x) => x.name === "changes-after-fix");
+      const dir = path.join(out, "evals", "restart-order--changes-after-fix");
+
+      expect(staged.controls?.find((x) => x.control === "changes-after-fix")?.text).toBe(control?.text);
+      expect(fs.readFileSync(path.join(dir, CONTROL_FILE), "utf8")).toBe(`${control?.text}\n`);
+      expect(parse(fs.readFileSync(path.join(dir, "case.yaml"), "utf8"))).toMatchObject({ context: { scaffold_script: "place-files.sh" } });
+      expect(fs.readFileSync(path.join(dir, "place-files.sh"), "utf8")).toContain(`cp '${path.join(dir, CONTROL_FILE)}' '${CONTROL_FILE}'`);
+      for (const grader of Object.keys(control?.expect ?? {})) {
+        const original = frontmatter(fs.readFileSync(path.join(c.dir, "graders", `${grader}.md`), "utf8"));
+        const copy = frontmatter(fs.readFileSync(path.join(dir, "graders", `${grader}.md`), "utf8"));
+
+        expect(copy["body"]).toBe(original["body"]);
+        expect(copy["focus"]).toEqual({ source: "file", path: CONTROL_FILE });
+        expect(copy["type"]).toBe(original["type"]);
+      }
+      expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).not.toContain(control?.text.slice(0, 40));
+    } finally {
+      fs.rmSync(out, { recursive: true, force: true });
+    }
   });
 });
 
@@ -376,27 +435,29 @@ describe("a prompt change's comparison", () => {
     ].join("\n");
 
   it("is owed nothing where no prompt changed", () => {
-    expect(comparisonProblems([], [])).toEqual([]);
+    expect(comparisonProblems([], "", [])).toEqual([]);
   });
 
   it("is found in the body or a comment, with both blobs in order", () => {
-    expect(comparisonProblems([change], ["Summary.", comparison(change.before, change.after)])).toEqual([]);
-    expect(comparisonProblems([change], [`Body.\n\n${comparison(change.before, change.after)}\n\n### Another heading\n\nblob \`${"9".repeat(12)}\``])).toEqual([]);
+    expect(comparisonProblems([change], "Summary.", [comparison(change.before, change.after)])).toEqual([]);
+    expect(comparisonProblems([change], `Body.\n\n${comparison(change.before, change.after)}\n\n### Another heading\n\nblob \`${"9".repeat(12)}\``, [])).toEqual([]);
   });
 
   it("does not count a comparison of other blobs, of the other prompt, or the wrong way round", () => {
-    const [stale] = comparisonProblems([change], [comparison(change.before, "3".repeat(40))]);
+    const [stale] = comparisonProblems([change], "", [comparison(change.before, "3".repeat(40))]);
 
     expect(stale).toMatch(/review\/prompt\.md changed .*111111111111.*222222222222/);
     expect(stale).toContain(`111111111111 against 333333333333`);
-    expect(comparisonProblems([change], [comparison(change.after, change.before)])).toHaveLength(1);
-    expect(comparisonProblems([change], [comparison(change.before, change.after, "fix")])).toHaveLength(1);
-    expect(comparisonProblems([change], ["No comparison here."])[0]).toMatch(/none is in its body or comments/);
+    expect(comparisonProblems([change], comparison(change.after, change.before), [])).toHaveLength(1);
+    expect(comparisonProblems([change], "", [comparison(change.before, change.after, "fix")])).toHaveLength(1);
+    expect(comparisonProblems([change], "No comparison here.", [])[0]).toMatch(/none is in its body or comments/);
   });
 
-  it("is waived by an Eval-Waiver line with a reason, and only with one", () => {
-    expect(comparisonProblems([change], ["Body.\n\nEval-Waiver: a typo in a heading no case reads."])).toEqual([]);
-    expect(comparisonProblems([change], ["Eval-Waiver:"])).toHaveLength(1);
+  it("is waived by an Eval-Waiver line with a reason in the body, and only there", () => {
+    expect(comparisonProblems([change], "Body.\n\nEval-Waiver: a typo in a heading no case reads.", [])).toEqual([]);
+    expect(comparisonProblems([change], "Eval-Waiver:", [])).toHaveLength(1);
+    // Anyone who can comment could post one: a comment's waiver waives nothing.
+    expect(comparisonProblems([change], "Body.", ["Eval-Waiver: a typo in a heading no case reads."])).toHaveLength(1);
   });
 
   it("is checked on every pull request, the head's own blobs, again when the body is edited", () => {
@@ -418,7 +479,7 @@ describe("a prompt change's comparison", () => {
   it("asks for each changed prompt's own", () => {
     const fixChange = { prompt: "fix" as const, before: "4".repeat(40), after: "5".repeat(40) };
 
-    expect(comparisonProblems([change, fixChange], [comparison(change.before, change.after)])).toEqual([expect.stringMatching(/^fix\/prompt\.md/)]);
+    expect(comparisonProblems([change, fixChange], "", [comparison(change.before, change.after)])).toEqual([expect.stringMatching(/^fix\/prompt\.md/)]);
   });
 });
 
```

2. The commit message I would have written:

```text
fix(evals): grade a control's own text, not an echo of it, and read the waiver from the body only (#718)

Addresses the maintainer's comment on #732 (the controls run on a00633d):

1. A control's verdict now depends on its text. The tool can do it:
   Claude Code 2.1.316's `llm` grader takes `focus: { source: file, path }`,
   read from the run's sandbox. Each staged control gets a scaffold that
   copies its text in as `control.md`, and a copy of each grader it names
   with the same criteria and its focus moved to that file. The model is
   asked for one word, and nothing reads it. As a guard, a ruling counts
   only where the grader's `evidence` (what the judge was shown, in the
   tool's result) holds the control's text, whitespace aside. Any other
   ruling is "void: the judge was not shown the control's text", counted
   on its own line. The command exits 1 only on a ruling that differs from
   `expect` on the control's own text. The report also prints the judge's
   `explanation` for each ruling that differs.
2. restart-order/changes-after-fix grader 04: the grader was the problem,
   not the control. The control is Review 3 at 58a8c32 of #577, which
   asked for changes (a High, an acceptance criterion ruled unmet, and two
   Lows), so `expect: pass` is right. The grader asked whether the review
   "asks for at least one change before merge". But this review's findings
   are ones the author may skip by replying, and its High is one the pull
   request may depart from by saying why. It now says what counts: a
   finding to fix before merge at any severity, an unmet criterion, or
   changes recommended or requested, skippable ones included, with
   follow-ups and notes excluded. rescue-deleted-before-open 03 had the
   same words and gets the same change. This is my reading of the
   failure: the earlier report did not print the judge's reason, so the
   next run's report, which does, is what confirms it.
3. The README's "No run of the controls had been made" is replaced with
   the first run's result, why most of it was the echo, and what the next
   run measures. The maintainer will post the table on this push.

Minor finding fu-0b4e2f81, fixed: `comparisonProblems` now takes the body
and the comments apart and reads `Eval-Waiver:` from the body only. A
waiver in a comment waives nothing, since anyone who can comment could
post it. Tested, and the README says so.

Verify passes.
```

3. Each thread's outcome: none. This pull request has no review thread.

4. Each conversation comment's outcome:

- `IC_kwDOTzVKqM8AAAABicpGXw` (@jeffwlawson): **addressed**. The reason:

  > Done in 90ee270. Controls no longer use an echo: a scaffold puts the text in the sandbox as `control.md`, and each grader reads that file via `focus: { source: file }`. A ruling counts only if the judge's `evidence` holds the text. Any other ruling is void, and exit 1 only on a real mismatch. The 04 failure was the grader, not the control; 04 and rescue 03 are reworded. Unconfirmed until your run, whose report now shows the judge's reasons. README updated.
