---
source: >-
  PR #584, the loop's Review 2 at 1159e02 (this case's head), which approved: https://github.com/jeffwlawson/agent-workflows/pull/584#pullrequestreview-5725875415, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
---

**Review 2**

## Agent review

### 🟢 Approval recommended

Nothing is unresolved. Every ref the checkout's fetch, the checkout and the merge name is now spelled in full, a test with a shadowing tag covers each, and both docs findings landed.

_Nothing left to fix. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Resolved since last review</b> (2)</summary>

- Low [merge() doc still says git writes its own message](https://github.com/jeffwlawson/agent-workflows/pull/584#discussion_r4433955107) · `engine/git.ts:491`
- Low [COMMIT_ID split liveGit from its doc comment](https://github.com/jeffwlawson/agent-workflows/pull/584#discussion_r4433955112) · `service/worker-live.ts:196`

</details>

<details>
<summary><b>Acceptance criteria</b> (6) · 6 met</summary>

- **Met:** An implement job's checkout succeeds, and is at the base branch's commit, when a tag named like the base branch exists in the repository.
- **Met:** An implement job's base is the branch's commit, not the tag's, when the tag is on a different commit.
- **Met:** update-branch's merge brings in the base branch's commit, not that of a tag named `origin/<base>`, and its report names the real base.
- **Met:** The merge commit's subject is unchanged from today's: `Merge remote-tracking branch 'origin/<base>' into <branch>`.
- **Met:** A test for each of the three sites runs with a shadowing tag present and fails without the change.
- **Met:** Tags are still fetched into the checkout (#567).

</details>

_**Since the brief:** no commit since `4896b68` touched the 5 files its *Where things are* names._

**Not found at `4896b68`:** `origin/${base}`.

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/engine/git.test.ts and tests/service/worker-live.test.ts**: not run: node_modules is not installed in this checkout, so tsc and vitest could not start; this review relies on CI's green verify

</details>

<details>
<summary><b>How this was checked</b></summary>

This pass checks whether the earlier round's two findings landed. I checked both against engine/git.ts:400-500 and service/worker-live.ts:185-230 at 1159e02. That commit changes only comments and the order of declarations. I searched the checkout for `git merge origin/`, `checkout -B` and `git writes its own` and ruled on all 7 hits: the prompt, platform-spec and update-branch.ts hits still describe the merge correctly. No text goes anywhere new. CI verify is green.

</details>
