---
source: >-
  PR #601, the loop's Review 1 at bceed0c (this case's head), which approved: https://github.com/jeffwlawson/agent-workflows/pull/601#pullrequestreview-5726185336, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
  "02": fail
---

**Review 1**

## Agent review

### 🟢 Approval recommended

Nothing is unresolved: the instance id is validated on both wires, the queue's drop never takes the running job, and the docs now name the running job as the only loss.

_Nothing left to fix. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Acceptance criteria</b> (8) · 8 met</summary>

- **Met:** After a dispatcher restart, a job the worker holds queued from the previous instance is dropped, never run, and its item is dispatched again by the dispatcher's start scan if its label is still on.
- **Met:** A job queued from the *current* instance is never dropped, whichever scan or delivery asked.
- **Met:** The running job is never dropped by this; the scan skips its item while the worker holds it.
- **Met:** A job whose body lacks an instance id, or carries a malformed one, is refused as any malformed job is, with a reason a person can act on.
- **Met:** A worker that cannot be reached at the dispatcher's start still skips the pass and logs it, as today; the worker's own start announcement scans again.
- **Met:** The held door's request and answer are validated, and refuse a signature that does not verify, as they do now.
- **Met:** `docs/deploying-the-service.md`'s *What it does not keep* and its account of the worker's queue say the queued jobs are recovered by a dispatcher restart and that only the running one is not.
- **Met:** The verify command `CLAUDE.md` names passes.

</details>

<details open>
<summary><b>Since the brief</b> (4) · commits since <code>4896b68</code> that touched the files it names</summary>

Files checked: `service/dispatcher.ts`, `service/worker.ts`, `service/job.ts`, `service/serve.ts`, `docs/deploying-the-service.md`, `tests/service/dispatcher.test.ts`, `tests/service/worker.test.ts`.

On the base branch, newest first:

- `eb394fe` fix(service): stop the scan re-dispatching an item past a limit (#596) (#598)
- `ccc5d4d` fix(service): resolve review threads on a person's pull request with a resolve token (#595)
- `5786d3c` feat(service): re-queue labelled work after a restart (#593)
- `b87ba46` feat(init): register a service-ready App with init --service (#579)

**Ruling:** None of the listed commits changes what a criterion means: 5786d3c (#593) and eb394fe (#596) are the scan code the brief anticipated, and the change builds on them as merged; ccc5d4d and b87ba46 touch nothing these criteria rely on.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/service/dispatcher.test.ts and tests/service/worker.test.ts**: not run: the checkout has no node_modules, so vitest and tsc are unavailable; read only, and CI verify passed

</details>

<details>
<summary><b>How this was checked</b></summary>

Read the PR commit's message, and in context service/worker.ts (heldDoor, oneAtATime: the running item, the includes check, finally), dispatcher.ts askWorker, job.ts parsers and serve.ts. Searched docs, CONTEXT.md and service/ for 'held door', 'restarted mid-job', 'dispatcher restart', 'until the worker' and 'waiting behind': about 15 hits read, none made false (deploying-the-service.md:583 is still true). One new destination: the worker log names a dropped job's instance id, which carries no secret. Tests were not run locally; relied on CI verify passing.

</details>
