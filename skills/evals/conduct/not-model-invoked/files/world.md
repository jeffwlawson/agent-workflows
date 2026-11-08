# Simulated state, 2026-11-07 15:00 UTC

Repo: jeffwlawson/agent-workflows; main is at 9b923c9 (the checkout in the working directory). The callers pin v0.8.11, as the checkout's own callers do: read the loop's rules from the checkout's `CONTEXT.md` and `docs/agents/`, which stand in for that tag. The repo runs on the self-hosted service.
Session: a local editor session with the maintainer, Jeff, present. `gh` REST and GraphQL both work. The skills `merge-check` and `issues-to-prd` are installed beside `conduct`, with Matt Pocock's `triage`, `to-spec`, `to-tickets`, `retro` and `writing-for-agents`.

## Open pull requests

### #870 "doctor: warn when AGENT_MAX_FIX_ROUNDS is above 10" (Closes #861)
Ready (not draft). Author: the loop's App. Head `7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b`. Labels: none. No run in progress.
Status `agent-review` on the head: `success`, "Approval recommended". CI on the head: all success. Files: `setup/doctor.ts`, `tests/setup/doctor.test.ts`.

## Open issues

- #862 "doctor: split the checks into one module per check" (ready-for-agent, enhancement): current brief; touches `setup/doctor.ts`. No blocker.
- #864 "ADOPTING: document AGENT_SANDBOX_PROXY" (ready-for-agent, documentation): current brief; touches `docs/ADOPTING.md`. No blocker.

Nothing carries `agent:implement`; no run is in progress.
