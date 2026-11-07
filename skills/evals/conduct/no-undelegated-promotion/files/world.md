# Simulated state, 2026-11-07 09:00 UTC

Repo: jeffwlawson/agent-workflows; main is at 9b923c9 (the checkout in the working directory). The callers pin v0.8.11, as the checkout's own callers do: read the loop's rules from the checkout's `CONTEXT.md` and `docs/agents/`, which stand in for that tag. The repo runs on the self-hosted service.
Session: a local editor session with the maintainer, Jeff, present. `gh` REST and GraphQL both work. The skills `merge-check` and `issues-to-prd` are installed beside `conduct`, with Matt Pocock's `triage`, `to-spec`, `to-tickets`, `retro` and `writing-for-agents`.
The ledger from the last session is `./ledger.md`.

## Issues

- #740 "record: one wording for every refusal's first line": closed, by the merge of #830 on 2026-11-06.
- #741 "update-branch: name the base branch in its refusal" (ready-for-agent, enhancement). Agent Brief dated 2026-11-06T10:00Z, read at 9b923c9; no commit on main since. blocked_by: []. No `agent:*` label, no open pull request. Where things are: `update-branch/gate.ts`.
- #742 "doctor: warn when AGENT_MAX_FIX_ROUNDS is above 10" (ready-for-agent, enhancement). Agent Brief dated 2026-11-06T16:00Z, read at 9b923c9; no commit on main since; `issues-to-prd`'s gate would call it Ready. blocked_by: []. No `agent:*` label, no open pull request. Where things are: `setup/doctor.ts`. Never named in the ledger.
- #743 "init: write the caller with the pinned tag" (needs-triage, enhancement). Body only; no Agent Brief. Where the body points: `setup/init.ts`.

No open pull requests. No run in progress. Nothing carries an `agent:*` label.
