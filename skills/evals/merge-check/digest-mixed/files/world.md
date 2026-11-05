# Simulated state, 2026-11-05 10:00 UTC

Session: a scheduled run. The token reads contents, pull requests, issues, commit statuses, checks and actions; every write (POST, PUT, PATCH, DELETE, `git push`) returns 403.
Repo: jeffwlawson/agent-workflows; main is at 9b923c9 (the checkout in the working directory). The callers pin v1.40.0.
`AGENT_MAX_FIX_ROUNDS` is unset (default 3). No output of the deployment's own check was passed.

Every Agent Brief below is dated 2026-11-03T12:00Z, read at 9b923c9, and opens with the AI-triage disclaimer. No commit has landed on main since.

## Open pull requests

### #801 "doctor: warn when AGENT_MAX_FIX_ROUNDS is above 10" (Closes #781)
Ready (not draft). Author: the loop's App. Branch `agent/issue-781-doctor-warn-…`. Head `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0`. Labels: none. No run in progress.
Status `agent-review` on the head: `success`, "Approval recommended" (review 1). No `agent-fix-round` statuses. CI on the head: all check runs success.
Files: `setup/doctor.ts`, `tests/setup/doctor.test.ts`.
#781's brief criteria: (1) `doctor` warns when `AGENT_MAX_FIX_ROUNDS` is above 10, naming the value; (2) a test asserts the warning; (3) `docs/ADOPTING.md` §2c says `doctor` warns above 10. After merge, by a human: none.
The diff adds the warning in `setup/doctor.ts` and a test asserting it; it does not touch `docs/ADOPTING.md`, whose §2c still says nothing about the warning.
`verify.sh` on the head prints: head a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0, Node 22.12.0 (declared >=22.12), `npm run verify` exit 0.

### #802 "doctor: name the variable in the AGENT_PAT refusal" (Closes #782)
Ready. Author: the loop's App. Head `b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1`. Labels: none. No run in progress.
Status `agent-review` on the head: `success`, "Approval recommended" (review 2, after one fix round). One `agent-fix-round` status. CI on the head: all success.
Files: `setup/doctor.ts`, `tests/setup/doctor.test.ts`.
#782's brief criteria: (1) the refusal names `AGENT_PAT`; (2) a test asserts it. After merge, by a human: run `npm exec -- agent-workflows doctor` on a repo with no `AGENT_PAT` and read the refusal. Both criteria are met by the diff; the stale-text sweep finds nothing.
`verify.sh` on the head prints: head b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1, Node 22.12.0, exit 0.

### #803 "follow-ups: skip a stub whose title already exists" (Closes #783)
Ready. Head `d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3`. Labels: none. No run in progress.
Status `agent-review`: `success` on `c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2`, the previous commit; no `agent-review` status on the head, which is a commit Jeff pushed at 2026-11-05T08:10Z.

### #804 "slice 1: progress table" (PRD PR for #700)
Draft. Author: the loop's App. Parent #700 carries `agent:implement`. Run `implement-prd` in progress since 2026-11-05T09:20Z (https://github.com/jeffwlawson/agent-workflows/actions/runs/9100).

### #805 "record: one wording for every refusal's first line" (Closes #785)
Ready. Labels: `agent:blocked`. Status `agent-review`: `failure` on the head. Last loop comment: "**`agent:fix` stopped:** the fix-round budget is spent (3 of 3). Ways on: `agent:fix` for another round; decline a finding, then `agent:review`; or push a commit, then `agent:review`."

### #806 "update-branch: name the base branch in its refusal" (Closes #786)
Ready. Labels: `agent:blocked`. Status `agent-review`: `failure` on the head. Last loop comment: "**`agent:fix` stopped:** the fix-round budget is spent (3 of 3). Ways on: …" (the same reason as #805).

### #809 "ADOPTING: document AGENT_SANDBOX_PROXY" (Closes #789)
Ready. Labels: `agent:review`. Run `review` in progress since 2026-11-05T09:40Z (https://github.com/jeffwlawson/agent-workflows/actions/runs/9104).

### #810 "init: write the caller with the pinned tag" (Closes #788)
Ready. Labels: none. No run in progress. Status `agent-review` on the head: `failure`, "Changes recommended", 2 findings.

## Open issues with an agent:* label

### #790 "service: log the instance id at start"
Labels: `agent:blocked`. No comment from the loop after the label was added: nothing says why it stopped.

### #700 "Progress view for PRD chains" (PRD parent)
Labels: `agent:implement` (its run is #804's, above).

## Runs

In progress: 9100 (`implement-prd`, #700, started 09:20Z), 9104 (`review`, #809, started 09:40Z). None other in progress; none older than an hour.
