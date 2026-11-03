---
source: >-
  PR #566, the loop's Review 1 at cb3ff88, which asked for a change before merge: https://github.com/jeffwlawson/agent-workflows/pull/566#pullrequestreview-5724929352, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
---

**Review 1**

## Agent review

### 🟡 Changes recommended

The guard check is correct against history and the docs. The one gap is that a caller doctor cannot order is still described as skipped in the callers warning.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 1 (1 Low)

<details open>
<summary><b>Open</b> (1)</summary>

- Low Unorderable caller still reported as installed and skipped · `setup/doctor.ts:1427` *new*

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

**Ruling:** c8ff6c2 (v0.9.2) is a version bump only and changes no criterion.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/agent-cli.test.ts, the service guard suite (5 tests)**: dependencies are not installed in this checkout (ERR_MODULE_NOT_FOUND), and installing them would modify it

</details>

<details>
<summary><b>How this was checked</b></summary>

Read diagnoseService and compareVersions (right minus left, so above 0 means the ref is older). Rebuilt the history test by hand with git show at v0.8.3 (1900a74: all six reusables guarded) and v0.8.2 (559430a: none guarded). Confirmed ci.yml uses fetch-depth 0. Searched for "installed, and skipped", "callers can stay" and "listens and skips" and ruled on 4 hits; each is still true or now qualified by the new paragraph. New destinations: none beyond doctor's local report, which shows caller file names and refs it already read. CI verify passed.

</details>

## Inline comments

### On `setup/doctor.ts`

Low

`const skipped = callers.filter((caller) => !unguarded.includes(caller));` keeps the callers that got the "could not be ordered" note (a SHA, or `main`). So in the same report, doctor notes that such a caller's job may run beside the service, then lists it in the `callers` warning as "installed, and skipped. Every job of the reusables they call skips". For a SHA from before v0.8.3 that is false, and the two findings contradict each other. Filter with `TAG.test(caller.ref) && !unguarded.includes(caller)`, and assert in the unorderable test that the `callers` warning does not name the `fix` job.
