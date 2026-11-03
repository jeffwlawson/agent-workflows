---
source: >-
  PR #698, the loop's Review 2 at e0bd934, before the maintainer's comment, which ruled C5 unmet and asked for it: https://github.com/jeffwlawson/agent-workflows/pull/698#pullrequestreview-5746494817, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
  "02": fail
---

**Review 2**

## Agent review

### 🟡 Changes recommended

C1 to C4 hold and the base-merge leak is fixed. Still owed: the golden-PR eval and the usage-ledger prompt sizes, which a maintainer must run.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 2 (1 Medium)

<details open>
<summary><b>Open</b> (2)</summary>

- Medium Acceptance criterion not met: Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger. · `evals/review/suite.yaml:25` *new*
- [Acceptance criterion not met: Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger.](https://github.com/jeffwlawson/agent-workflows/pull/698#discussion_r4450240459) · `evals/review/suite.yaml:25`

</details>

<details>
<summary><b>Resolved since last review</b> (1)</summary>

- Medium [Scoped diff carries the base branch's changes after a merge](https://github.com/jeffwlawson/agent-workflows/pull/698#discussion_r4450240445) · `review/review-diff.ts:75`

</details>

<details open>
<summary><b>Acceptance criteria</b> (5) · 4 met, 1 unmet</summary>

- **Met:** A verification review's prompt diff section is smaller than the full diff for a PR whose fix round touched one file; test on two fixtures.
- **Met:** A first review's and a final review's prompt carry the full diff; test.
- **Met:** A finding on a line outside the scoped diff but in the PR's diff is still placed on the line; test.
- **Met:** Where the range is unreadable, the full diff is used and `howChecked` says why; test.
- **Unmet:** Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger. · No golden-PR eval result and no before and after prompt sizes from the usage ledger are reported; the body only says they are owed.

</details>

_**Since the brief:** not checked, because the brief has no *Where things are* section._

_**Not checked here:** The review's own test run skipped nothing that exercises this change._

<details>
<summary><b>How this was checked</b></summary>

This is a verification pass of the earlier round, checked against e0bd934. I read review-diff.ts, `readReviewHistory`, the `git` wrapper, and the `fetch-depth: 0` checkout in review.yml. I confirmed that merge-tree and is-ancestor throw on exit status 128 and are not treated as a conflict. I ran the review-diff and review-round tests from a scratch copy: 46 passed. I searched the prompts, CONTEXT.md and the evals for `PR_DIFF`, `PR DIFF`, `whole diff` and `outside the diff`: 22 hits, none made false. The one new destination is git's first error line in the prompt, and it carries no credentials.

</details>

## Inline comments

### On `evals/review/suite.yaml`

Medium

The linked issue's acceptance criterion is not met: "Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger.". No golden-PR eval result and no before and after prompt sizes from the usage ledger are reported; the body only says they are owed. If this pull request departs from it on purpose, say why in its body, and the next review records the criterion as changed.
