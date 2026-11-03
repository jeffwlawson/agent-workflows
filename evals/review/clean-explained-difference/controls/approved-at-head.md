---
source: >-
  PR #698, the loop's Review 3 at 5528a12 (this case's head), which approved and ruled C5 changed on the maintainer's direction: https://github.com/jeffwlawson/agent-workflows/pull/698#pullrequestreview-5746669908, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
  "02": pass
---

**Review 3**

## Agent review

### 🟢 Approval recommended

Nothing is unresolved. The size guard landed as the maintainer directed, every reachable path is tested, and only the eval criterion departs from the issue, on the maintainer's instruction.

_Nothing here blocks the merge; any minor findings below are filed as one follow-up. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Resolved since last review</b> (2)</summary>

- [Acceptance criterion not met: Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger.](https://github.com/jeffwlawson/agent-workflows/pull/698#discussion_r4450240459) · `evals/review/suite.yaml:25`
- [Acceptance criterion not met: Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger.](https://github.com/jeffwlawson/agent-workflows/pull/698#discussion_r4450293695) · `evals/review/suite.yaml:25`

</details>

<details open>
<summary><b>Acceptance criteria</b> (5) · 4 met, 1 changed</summary>

- **Met:** A verification review's prompt diff section is smaller than the full diff for a PR whose fix round touched one file; test on two fixtures.
- **Met:** A first review's and a final review's prompt carry the full diff; test.
- **Met:** A finding on a line outside the scoped diff but in the PR's diff is still placed on the line; test.
- **Met:** Where the range is unreadable, the full diff is used and `howChecked` says why; test.
- **Changed:** Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger. · The maintainer directed in IC_kwDOTzVKqM8AAAABiQnOCw that this PR not attempt the golden-PR eval: its cases replay first reviews only. A follow-up issue tracks the cases that would reach this path, and git-measured prompt sizes were posted in place of ledger figures.

</details>

_**Since the brief:** not checked, because the brief has no *Where things are* section._

_**Not checked here:** The review's own test run skipped nothing that exercises this change._

<details>
<summary><b>How this was checked</b></summary>

Verification pass of the earlier round. I read 5528a12 against the maintainer's direction in IC_kwDOTzVKqM8AAAABiQnOCw. readPromptDiff now returns the whole diff when scopedSize >= whole.length, and the log line in review.ts gives both sizes. In a scratch copy with dependencies installed, I ran the review-diff, review-round and evals tests (81 passed) and tsc --noEmit (clean). I searched CONTEXT.md, docs and the prompts for PR_DIFF, DIFF_SCOPE, 'whole diff', 'verification pass' and 'scoped'; none of the hits is made stale by this change. No text goes anywhere new: the log line carries only sizes and short SHAs.

</details>
