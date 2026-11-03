---
source: >-
  Another pull request's review, for a negative of grader 02, which every real review of #570 passes: PR #566, the loop's Review 2 at 85a04f0: https://github.com/jeffwlawson/agent-workflows/pull/566#pullrequestreview-5725040210, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
  "02": fail
  "03": fail
---

**Review 2**

## Agent review

### 🟢 Approval recommended

Nothing is unresolved. The earlier finding has landed, and the guard check, the history-held constant and the docs each do what #563 asks.

_Nothing left to fix. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Resolved since last review</b> (1)</summary>

- Low [Unorderable caller still reported as installed and skipped](https://github.com/jeffwlawson/agent-workflows/pull/566#discussion_r4433301741) · `setup/doctor.ts:1427`

</details>

<details>
<summary><b>Acceptance criteria</b> (6) · 6 met</summary>

- **Met:** With the orchestrator variable `service`, a caller pinned below the minimum yields an error naming the file, its pin and the minimum, with `init` as the fix; a caller at or above it yields nothing.
- **Met:** A SHA-pinned or otherwise unorderable pin is a note saying it could not be ordered.
- **Met:** Without `service`, the Actions path's findings are unchanged.
- **Met:** The minimum is derived in exactly one place, and a test fails if the constant names a release whose workflows lack the guard (checked against the repository's own history or a fixture, not a hard-coded tag list).
- **Met:** The finding is covered through `diagnose`, the pure half; `gatherFacts` gains no new fact if the pin is already on the caller.
- **Met:** Docs: `docs/ADOPTING.md` or the deployment guide says a service repository's callers must be at the minimum release or later.

</details>

<details open>
<summary><b>Since the brief</b> (1) · commits since <code>a3a39c2</code> that touched the files it names</summary>

Files checked: `setup/doctor.ts`, `.github/workflows/review.yml`.

On the base branch, newest first:

- `c8ff6c2` v0.9.2

**Ruling:** c8ff6c2 (v0.9.2) only bumps pins. It changes no criterion and leaves the reusables' guard in place.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/agent-cli.test.ts, the service guard suite (5 tests)**: not run: the checkout has no node_modules, so vitest failed with ERR_MODULE_NOT_FOUND

</details>

<details>
<summary><b>How this was checked</b></summary>

This pass verifies the earlier round. I checked f-c06a6b67 against the current `diagnoseService` filter and the unorderable test. I traced `compareVersions`, which is positive when the caller is older than the minimum. Git history has 40 `v<version>` release commits for the history test to read. I searched for "installed, and skipped" and "callers can stay": two hits, both still true. The change sends text nowhere new: doctor's output uses the caller file and ref it already printed. CI `verify` is green. I ran no tests locally.

</details>
