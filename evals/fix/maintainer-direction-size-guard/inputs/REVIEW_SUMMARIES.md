**@jeffwlawson-agent-loop[bot]** (COMMENTED):
**Review 1**

## Agent review

### 🟡 Changes recommended

After a base merge, the verification pass's scoped diff takes in the base branch's changes, and the golden-PR eval the issue asks for has not been run.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 2 (2 Medium)

<details open>
<summary><b>Open</b> (2)</summary>

- Medium Scoped diff carries the base branch's changes after a merge · `review/review-diff.ts:75` *new*
- Medium Acceptance criterion not met: Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger. · `evals/review/suite.yaml:25` *new*

</details>

<details open>
<summary><b>Acceptance criteria</b> (5) · 4 met, 1 unmet</summary>

- **Met:** A verification review's prompt diff section is smaller than the full diff for a PR whose fix round touched one file; test on two fixtures.
- **Met:** A first review's and a final review's prompt carry the full diff; test.
- **Met:** A finding on a line outside the scoped diff but in the PR's diff is still placed on the line; test.
- **Met:** Where the range is unreadable, the full diff is used and `howChecked` says why; test.
- **Unmet:** Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger. · Neither the golden-PR eval nor the before and after prompt sizes from the usage ledger are reported; the commit message says the measurement is still owed.

</details>

_**Since the brief:** not checked, because the brief has no *Where things are* section._

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/review/review-diff.test.ts, review-round.test.ts, evals.test.ts**: vitest is not installed in this checkout (ERR_MODULE_NOT_FOUND on 'vitest/config'); CI verify passed

</details>

<details>
<summary><b>How this was checked</b></summary>

This is the PR's first review, not a verification of an earlier round. I read the diff, `review/review-round.ts` (which no longer reads commit parents), `shared/pr-feedback.ts`, and `review.yml` (it checks out with `fetch-depth: 0`, so the reviewed head is present). In a mktemp repo I reproduced a base merge after the reviewed head: `git diff <reviewed> HEAD` gave 3 files and 52 insertions, while `main...HEAD` gave 1 file. I searched the prompt, CONTEXT.md and docs/agents for 'whole diff', 'full diff' and 'PR DIFF': two hits, both still true. The only new destination is the prompt, which gets checkout git output; no…

</details>

<!-- agent-follow-ups {"version":1,"dropped":0,"moved":0,"cap":3,"followUps":[]} -->

---

**@jeffwlawson-agent-loop[bot]** (COMMENTED):
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

<!-- agent-follow-ups {"version":1,"dropped":0,"moved":0,"cap":3,"followUps":[]} -->
