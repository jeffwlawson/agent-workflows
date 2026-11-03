---
source: >-
  Another pull request's review that asked for changes, since every review of #692 approved: PR #584, the loop's Review 1 at bbb7761: https://github.com/jeffwlawson/agent-workflows/pull/584#pullrequestreview-5725830856, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
---

**Review 1**

## Agent review

### 🟡 Changes recommended

The fix names every ref in full at the fetch, the checkout and the merge, and keeps the merge subject; two comments are left wrong by it.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 2 (2 Low)

<details open>
<summary><b>Open</b> (2)</summary>

- Low merge() doc still says git writes its own message · `engine/git.ts:488` *new*
- Low COMMIT_ID split liveGit from its doc comment · `service/worker-live.ts:196` *new*

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

- **tests/engine/git.test.ts and tests/service/worker-live.test.ts, including the three new #569 tests**: not run: node_modules is not installed in the checkout and installing it would modify the checkout

</details>

<details>
<summary><b>How this was checked</b></summary>

Read the diff, the `Git.checkout` contract and every caller in `service/worker.ts`: `sha` is a validated 40-character commit or a branch name. Read the merge callers in update-branch and `implement-prd/catch-up.ts`. Probed git 2.43 in a scratch repository with tags `main` and `origin/main`: the fully named fetch and `checkout --no-track -B` reach the branch's commit. Searched `checkout -B`, `origin/${base}`, `git merge origin` and `remote-tracking name` and ruled on all 5 hits. The change sends no text anywhere new. Red check not configured; CI `verify` passed.

</details>

## Inline comments

### On `engine/git.ts`

Low

With no `message`, the merge now passes its own `-m "Merge remote-tracking branch 'origin/${base}' into ${into}"`. The `GitMerger.merge` doc at `engine/git.ts:409-410` still says "without it, git writes its own." Someone reading the contract will expect git's own message, which follows config such as `merge.suppressDest`, and will get the literal subject built here instead. Reword those lines to say the merge is made under the subject a person's `git merge origin/<base>` makes.

### On `service/worker-live.ts`

Low

`COMMIT_ID` and its docblock sit between `liveGit`'s TSDoc (`service/worker-live.ts:188-195`, "The checkout, with the token passed to each fetch as a header...") and `export const liveGit`. That comment now attaches to `COMMIT_ID`, which ends up with two docblocks, and `liveGit` has none. Hover and generated docs no longer explain why the token is kept out of the checkout's configuration. Move the `COMMIT_ID` declaration above the `liveGit` docblock.
