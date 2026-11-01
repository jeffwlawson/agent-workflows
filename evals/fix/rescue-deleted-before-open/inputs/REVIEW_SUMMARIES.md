**@jeffwlawson-agent-loop[bot]** (COMMENTED):
**Review 1**

## Agent review

### 🟡 Changes recommended

The rescue and resume work as the brief describes, but a rescue that fails with commits in hand is never mentioned in the failure comment, and two comments still describe the old token boundary.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 2 (1 Medium, 1 Low)

<details open>
<summary><b>Open</b> (2)</summary>

- Medium Acceptance criterion not met: The failure comment names the rescue branch and says re-adding `agent:implement` resumes from it, or says the commits were not saved and why. · `implement/conclude.ts:253` *new*
- Low Comments still say prepare is tokenless and only fix and implement-prd rescue · `tests/workflows.test.ts:4902` *new*

</details>

<details open>
<summary><b>Acceptance criteria</b> (10) · 9 met, 1 unmet</summary>

- **Met:** A run that reaches its time limit, is cancelled, or fails after the agent committed leaves those commits on the issue's rescue branch, with no pull request and no review requested, on both orchestrators.
- **Met:** A stopped run with no commits ahead of the base saves nothing.
- **Unmet:** The failure comment names the rescue branch and says re-adding `agent:implement` resumes from it, or says the commits were not saved and why. · Only the missing-token case says the commits were not saved. A failed bundle check, an unreadable rescue tip, a failed push, or a failed service publish checkout all return kind 'none' and post the plain retry, as though there were no commits; a test asserts the comment is silent when the push fails.
- **Met:** A retry whose rescue builds on its own base starts from the rescued commits and is told they are unverified; its push does not overwrite anything someone else pushed.
- **Met:** A rescue built on a different base is not built on, and the run says it started fresh.
- **Met:** A retitled issue resumes from its rescue.
- **Met:** A retry that publishes deletes the rescue; one that stops again rescues again without losing the earlier commits.
- **Met:** An unreadable answer about whether a rescue exists stops the run with a sentence a person can act on.
- **Met:** The prompt carries the commit-early instruction, and the prompt tests still pass.
- **Met:** A run that finishes behaves as today.

</details>

<details open>
<summary><b>Since the brief</b> (2) · commits since <code>16939c0</code> that touched the files it names</summary>

Files checked: `implement/bundle.ts`, `implement/prepare.ts`, `implement/implement.ts`, `implement/publish.ts`, `implement/conclude.ts`, `implement/prompt.md`, `shared/rescue.ts`, `shared/bundle.ts`, `shared/record.ts`, `fix/conclude.ts`, `fix/publish.ts`, `fix/fix.ts`, `fix/prepare.ts`, `fix/hand-over.ts`, `shared/contract.ts`, `.github/workflows/implement.yml`, `service/worker.ts`, `tests/implement`, `tests/fix`, `tests/rescue.test.ts`, `tests/service/worker.test.ts`, `tests/workflows.test.ts`.

On the base branch, newest first:

- `c8ff6c2` v0.9.2
- `573c7c2` fix(update-branch): conclude a conflicted merge under bwrap (#559)

**Ruling:** Neither c8ff6c2 (version bump) nor 573c7c2 (update-branch conclude under bwrap) changes what any criterion means.

</details>

_**Not checked here:** The review ran no tests._

<details>
<summary><b>Follow-ups</b> (1) · filed as issues on merge; remove <code>agent:follow-ups</code> to skip</summary>

- Medium **A stopped run overwrites a rescue it set aside, losing those commits** · `implement/conclude.ts:235`

</details>

<details>
<summary><b>How this was checked</b></summary>

Read the diff against shared/rescue.ts, fix/conclude.ts, implement-prd/conclude.ts, cli.ts fetchingCommand, liveFetchingIo, implement.yml's publish job (checkout and download conditions) and runImplement in service/worker.ts. Traced the outcomes of conclude's rescue paths through retryOf. Searched for: 'no token' beside implement:prepare, 'fix or implement-prd', 'where the runner succeeded', and 'success()'/'refus' beside the bundle; about 12 hits read. New destinations: the rescue branch name and BASE_REF reach issue comments; both are fixed strings with no secret. Red check not configured. I ran no tests; CI verify passed.

</details>

<!-- agent-follow-ups {"version":1,"dropped":0,"moved":0,"cap":3,"followUps":[{"title":"A stopped run overwrites a rescue it set aside, losing those commits","location":"implement/conclude.ts:235","body":"Suppose a run sets the rescue aside because the base moved, then stops with commits of its own. `rescueCommits` leases on the rescue's current tip (`lease = { tip: await io.github.branchTip(rescue) }`) and replaces it. The set-aside commits are gone, though the note said the branch is deleted only \"once a run succeeds\". fix/conclude.ts and implement-prd/conclude.ts have the same shape from #303, so the fix is a shared design change across three workflows, beyond this PR's scope. `movedPast` in rescue_ignored.json could let conclude refuse that overwrite.","severity":"medium","id":"fu-545a97a6"}]} -->

---

**@jeffwlawson-agent-loop[bot]** (COMMENTED):
**Review 2**

## Agent review

### 🟡 Changes recommended

Both earlier findings landed. One rare gap is left: a bundle step killed before it writes anything reads as a run with no commits, so the comment does not say they went unsaved.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 1 (1 Low)

<details open>
<summary><b>Previously missed</b> (1)</summary>

_In code that hasn't changed since last review_

- Low A bundle step ended by its limit reads as no commits · `service/worker.ts:1641` *new*

</details>

<details>
<summary><b>Resolved since last review</b> (2)</summary>

- Medium [Acceptance criterion not met: The failure comment names the rescue branch and says re-adding `agent:implement` resumes from it, or says the commits were not saved and why.](https://github.com/jeffwlawson/agent-workflows/pull/570#discussion_r4433438719) · `implement/conclude.ts:253`
- Low [Comments still say prepare is tokenless and only fix and implement-prd rescue](https://github.com/jeffwlawson/agent-workflows/pull/570#discussion_r4433438710) · `tests/workflows.test.ts`

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

**Ruling:** None of a0c2980 (tags fetched into service checkouts), c8ff6c2 (version bump) or 573c7c2 (update-branch conclude under bwrap) changes what any criterion means.

</details>

_**Not checked here:** The review ran no tests._

<details>
<summary><b>Follow-ups</b> (1) · filed as issues on merge; remove <code>agent:follow-ups</code> to skip</summary>

- Medium **A stopped run overwrites a rescue it set aside, losing those commits** · `implement/conclude.ts:271`

</details>

<details>
<summary><b>How this was checked</b></summary>

This is a check of whether the earlier round's two findings were fixed, read against 4d4b5e0. I read rescueCommits and retryOf in implement/conclude.ts, the doc comments in shared/rescue.ts and the comment in tests/workflows.test.ts. I followed bundleBranch on a checkout with no repository (it reports no-branch quietly) and the worker's own time limit for the bundle step. I searched for stale text ('prepare ... no token', 'only where the agent succeeded', 'nothing to bundle is a refusal', 'fix or implement-prd run', 'workflow token alone') and read about 15 hits; none is made false by this change. The only new place text…

</details>

<!-- agent-follow-ups {"version":1,"dropped":0,"moved":0,"cap":3,"followUps":[{"title":"A stopped run overwrites a rescue it set aside, losing those commits","location":"implement/conclude.ts:271","body":"Suppose the runner sets a rescue aside because the base moved, then the run stops again. `rescueCommits` reads the old rescue's tip as `lease = { tip: await io.github.branchTip(rescue) }` and pushes this run's commits over it. The set-aside commits are lost, though the set-aside note says they stay on the branch until a run succeeds. Fix and implement-prd share the shape, so the change belongs in the shared rescue design across workflows, not in this PR.","severity":"medium","id":"fu-6e7c5263"}]} -->

---

**@jeffwlawson-agent-loop[bot]** (COMMENTED):
**Review 3**

## Agent review

### 🟢 Approval recommended

Nothing is unresolved. The bundle-outcome fix landed, and the rescue, resume, deletion and failure text hold on both orchestrators with no regression in the fix commit.

_Nothing left to fix. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Resolved since last review</b> (1)</summary>

- Low [A bundle step ended by its limit reads as no commits](https://github.com/jeffwlawson/agent-workflows/pull/570#discussion_r4433494071) · `service/worker.ts:1645`

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

**Ruling:** None of a0c2980 (tags fetched into service checkouts), c8ff6c2 (version bump) or 573c7c2 (update-branch conclude under bwrap) changes what any criterion means.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/implement, tests/service/worker.test.ts, tests/workflows.test.ts, tests/rescue.test.ts and the typecheck**: The checkout has no node_modules, so vitest and tsc could not load (ERR_MODULE_NOT_FOUND).

</details>

<details>
<summary><b>Follow-ups</b> (1) · filed as issues on merge; remove <code>agent:follow-ups</code> to skip</summary>

- Low **A stopped run overwrites a rescue it set aside, losing those commits** · `implement/conclude.ts:271`

</details>

<details>
<summary><b>How this was checked</b></summary>

This pass verifies the previous round's fix. I checked f-96daeb67 against service/worker.ts:1638-1646 (bundleOutcome passed as BUNDLE_OUTCOME), rescueCommits in implement/conclude.ts, the agent job's new bundled output in implement.yml, and their tests. I read 4d56bbc for regressions: the only remaining 'none' reading is a bundle step reported as successful, or one with no outcome given. I compared the rescue lease with fix/conclude.ts. I searched for stale 'refusal', 'one output' and 'no commits' text and found no stale hits. New destinations: only fixed sentences and branch names reach the issue comment.

</details>

<!-- agent-follow-ups {"version":1,"dropped":0,"moved":0,"cap":3,"followUps":[{"title":"A stopped run overwrites a rescue it set aside, losing those commits","location":"implement/conclude.ts:271","body":"rescueCommits leases the push on the rescue tip as read (`lease = { tip: await io.github.branchTip(rescue) }`). Where the runner set that rescue aside because the base moved, the stopped run's bundle does not hold the older commits, so they are replaced and lost. fix/conclude.ts:257-265 has the same shape, so the fix belongs in the shared rescue policy across fix, implement-prd and implement, not in this PR.","severity":"low","id":"fu-c496b699"}]} -->

---

**@jeffwlawson-agent-loop[bot]** (COMMENTED):
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

<!-- agent-follow-ups {"version":1,"dropped":0,"moved":0,"cap":3,"followUps":[{"title":"A stopped run overwrites a rescue it set aside, losing those commits","location":"implement/conclude.ts:271","body":"Where the runner set aside a rescue built on an older base and the run then stops, `rescueCommits` pushes the new bundle leased on that rescue's tip (`lease = { tip: await io.github.branchTip(rescue) }`), replacing commits this run never held. `fix/conclude.ts:257-268` does the same, so the fix belongs in the shared rescue shape across workflows, which this pull request does not own.","severity":"medium","id":"fu-3e1d930f"}]} -->
