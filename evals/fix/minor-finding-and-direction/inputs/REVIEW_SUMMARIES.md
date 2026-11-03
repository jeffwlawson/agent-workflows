**@jeffwlawson-agent-loop[bot]** (COMMENTED):
**Review 1**

## Agent review

### 🟢 Approval recommended

The comparison check accepts an `Eval-Waiver:` line from any comment, though the README says the waiver goes in the body; the rest does what #718 asks.

_Nothing here blocks the merge; any minor findings below are filed as one follow-up. You can merge once the PR is ready and no longer a draft._

_Nothing here blocks the merge: the 1 minor finding below is filed as one follow-up when this pull request merges. To fix it now, add the `agent:fix` label; to have automatic fix rounds fix every finding, set the repository variable `AGENT_FIX_MIN_SEVERITY` to `low`._

**Findings:** 0

<details>
<summary><b>Minor findings</b> (1) · in this pull request's code, below the fix threshold; filed together as one issue on merge, remove <code>agent:follow-ups</code> to skip</summary>

- Low `scripts/eval-prompts.ts:1009` Waiver accepted from any comment, not only the body

</details>

<details>
<summary><b>Acceptance criteria</b> (2) · 2 met</summary>

- **Met:** Every box is either done or struck through with a reason.
- **Met:** The verify command `CLAUDE.md` names passes.

</details>

_**Since the brief:** not checked, because the brief has no *Where things are* section._

<details open>
<summary><b>Not checked here</b> (2) · tests exercising this change that the review's own run skipped</summary>

- **tests/evals.test.ts**: not run: the checkout has no node_modules; CI verify is green
- **the grader controls (`controls review|fix`)**: need a model credential and real spend; the README says no run has been made

</details>

<details>
<summary><b>How this was checked</b></summary>

Matched `comparisonProblems` parsing against `compare`'s printed heading and `blob` lines, and checked `hash-object` against `rev-parse` blob hashes. Read every grader and checked each control's `expect` against its text. Searched for "curl -L", "recommends approval" and the removed grader names; the only hits are runtime strings unrelated to the graders and `baseline.md`'s historical tables. New destinations: only `::error::` lines in the CI log, carrying blob hashes and fixed text. Ran no tests: the checkout has no node_modules. CI verify and comparison are green.

</details>

<!-- agent-follow-ups {"version":1,"dropped":0,"moved":1,"cap":3,"followUps":[{"title":"Waiver accepted from any comment, not only the body","location":"scripts/eval-prompts.ts:1009","body":"`if (texts.some((text) =\u003e WAIVER.test(text))) return [];` reads the waiver from every text it is given. `checkComparison` passes it the body and all issue comments, but `evals/README.md:302` says the waiver goes \"in the body\". Anyone who can comment can post `Eval-Waiver: x`, and the next run after a push or body edit passes a prompt change with no comparison, without saying where the waiver came from. Read the waiver from the body (the first text) only:\n\n```suggestion\n  if (WAIVER.test(texts[0] ?? \"\")) return [];\n```","severity":"low","id":"fu-0b4e2f81","kind":"minor"}]} -->
