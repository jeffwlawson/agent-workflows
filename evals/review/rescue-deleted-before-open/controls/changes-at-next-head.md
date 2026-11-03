---
source: >-
  PR #570, the loop's Review 4 at b41cecd (a merge of main onto this case's head), which found the deletion: https://github.com/jeffwlawson/agent-workflows/pull/570#pullrequestreview-5725356334, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
  "02": pass
  "03": pass
---

**Review 4**

## Agent review

### 🟡 Changes recommended

The rescue and resume work on both orchestrators, except that publish deletes the rescue before the pull request opens, so a failed open loses the rescued commits.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 1 (1 Medium)

<details open>
<summary><b>Open</b> (1)</summary>

- Medium Rescue is deleted before the PR opens, so a failed open loses it · `implement/publish.ts:104` *new*

</details>

<details>
<summary><b>Acceptance criteria</b> (10) · 10 met</summary>

- **Met:** A run that reaches its time limit, is cancelled, or fails after the agent committed leaves those commits on the issue's rescue branch, with no pull request and no review requested, on both orchestrators.
- **Met:** A stopped run with no commits ahead of the base saves nothing.
- **Met:** The failure comment names the rescue branch and says re-adding `agent:implement` resumes from it, or says the commits were not saved and why.
- **Met:** A retry whose rescue builds on its own base starts from the rescued commits and is told they are unverified; its push does not overwrite anything someone else pushed.
- **Met:** A rescue built on a different base is not built on, and the run says it started fresh.
- **Met:** A retitled issue resumes from its rescue.
- **Met:** A retry that publishes deletes the rescue; one that stops again rescues again without losing the earlier commits.
- **Met:** An unreadable answer about whether a rescue exists stops the run with a sentence a person can act on.
- **Met:** The prompt carries the commit-early instruction, and the prompt tests still pass.
- **Met:** A run that finishes behaves as today.

</details>

<details open>
<summary><b>Since the brief</b> (3) · commits since <code>16939c0</code> that touched the files it names</summary>

Files checked: `implement/bundle.ts`, `implement/prepare.ts`, `implement/implement.ts`, `implement/publish.ts`, `implement/conclude.ts`, `implement/prompt.md`, `shared/rescue.ts`, `shared/bundle.ts`, `shared/record.ts`, `fix/conclude.ts`, `fix/publish.ts`, `fix/fix.ts`, `fix/prepare.ts`, `fix/hand-over.ts`, `shared/contract.ts`, `.github/workflows/implement.yml`, `service/worker.ts`, `tests/implement`, `tests/fix`, `tests/rescue.test.ts`, `tests/service/worker.test.ts`, `tests/workflows.test.ts`.

On the base branch, newest first:

- `a0c2980` fix(service): fetch the repository's tags into every checkout (#567) (#568)
- `c8ff6c2` v0.9.2
- `573c7c2` fix(update-branch): conclude a conflicted merge under bwrap (#559)

**Ruling:** None of a0c2980 (tags in service checkouts), c8ff6c2 (version bump) or 573c7c2 (update-branch under bwrap) changes what any criterion means.

</details>

_**Not checked here:** The review ran no tests._

<details>
<summary><b>Follow-ups</b> (1) · filed as issues on merge; remove <code>agent:follow-ups</code> to skip</summary>

- Medium **A stopped run overwrites a rescue it set aside, losing those commits** · `implement/conclude.ts:271`

</details>

<details>
<summary><b>How this was checked</b></summary>

Read the diff, implement/publish.ts, implement/gate.ts's tip handling, shared/bundle.ts, and fix/conclude.ts for the shared rescue shape. Traced the path where the push lands and the PR open fails, through conclude and a retry. Searched docs, CONTEXT.md and source for stale wording: implement:prepare as having no token or being TOKENLESS, the bundle as success-only or a refusal, and "fix and implement-prd" rescue wording. Read about 12 hits; none is stale. The only new destinations are fixed sentences and the branch name in the issue comment. Ran no tests, since node_modules is absent. CI verify is green.

</details>

## Inline comments

### On `implement/publish.ts`

Medium

`deleteRescue` runs right after the push and before `openPullRequest`. If opening the PR then throws, `published.json` says `pushed: true` with no `pr`, so conclude rescues nothing and posts the plain retry. On that retry, prepare cuts `BRANCH` fresh at the base with no rescue left to resume from, and publish's push, leased on the tip the gate read, replaces the earlier branch. The rescued commits and everything built on them are lost. Move the deletion to after `state.pr = pr; record();`, and update the publish test's order and the publish order in `docs/platform-spec.md` to match.
