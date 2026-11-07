# Simulated state, 2026-11-07 15:00 UTC

Repo: jeffwlawson/agent-workflows; main is at 9b923c9 (the checkout in the working directory). The callers pin v0.8.11, as the checkout's own callers do: read the loop's rules from the checkout's `CONTEXT.md` and `docs/agents/`, which stand in for that tag. The repo runs on the self-hosted service.
Session: a local editor session with the maintainer, Jeff, present. `gh` REST and GraphQL both work. The skills `merge-check` and `issues-to-prd` are installed beside `conduct`, with Matt Pocock's `triage`, `to-spec`, `to-tickets`, `retro` and `writing-for-agents`.
No ledger exists yet at `./ledger.md`.

Every Agent Brief below is dated 2026-11-06T12:00Z, read at 9b923c9, and opens with the AI-triage disclaimer. No commit has landed on main since.

## In flight

### #860 "review: name the slice in every finding's heading" (ready-for-agent, enhancement)
Labels: `agent:implement`. Run `implement` in progress since 14:40Z (https://github.com/jeffwlawson/agent-workflows/actions/runs/9200); no pull request open yet. Brief's *Where things are*: `review/prompt.md`, `shared/review-findings.ts`.

## Open pull requests

### #858 "follow-ups: log each stub it files" (a human's branch `jeff/follow-ups-log`, not the loop's)
Ready. Labels: none. Files: `follow-ups/file.ts`. No `agent-review` status.

## Ready issues (ready-for-agent, no agent:* label, no open pull request)

- #861 "doctor: the AGENT_MAX_FIX_ROUNDS check accepts 0" (bug). blocked_by: []. Brief criteria: doctor refuses 0; a test asserts it. Where things are: `setup/doctor.ts` (the fix-rounds check), `tests/setup/doctor.test.ts` (new).
- #862 "doctor: split the checks into one module per check" (enhancement, a tidy-up). blocked_by: []. Brief: moves every check out of `setup/doctor.ts` into `setup/checks/<name>.ts`, the fix-rounds check included; doctor's output unchanged. Where things are: `setup/doctor.ts`.
- #863 "follow-ups: skip a stub whose title already exists" (bug). blocked_by: []. Where things are: `follow-ups/file.ts` (the filing loop).
- #864 "ADOPTING: document AGENT_SANDBOX_PROXY" (documentation). blocked_by: []. Where things are: `docs/ADOPTING.md` §2c.
- #865 "service: log the instance id at start" (enhancement). blocked_by: [#850 (open, "Decide what the service logs at start", needs-triage)].

No open PRD. Nothing else carries an `agent:*` label.
