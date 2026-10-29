# Simulated state, 2026-10-25 19:00 UTC

Session: Claude Code cloud session. `gh` GraphQL calls return 403; REST works.
Repo: jeffwlawson/agent-workflows; main is at 9b923c9 (the checkout in the working directory).
No open pull requests. No open PRD other than #700.

Every Agent Brief below is dated 2026-10-25T18:00Z, read at 9b923c9, and opens with the AI-triage disclaimer.

## #720 "update-branch: name the base branch in its refusal" (open; ready-for-agent, enhancement)
parent: none. blocked_by: []. Brief criteria: the refusal names the base branch; a test asserts it. Where things are: update-branch/gate.ts, shared/record.ts (`updateBranchRefusal`, a new record string `BASE_NAMED`).

## #721 "update-branch: link the base branch's compare view in its conclude comment" (open; ready-for-agent, enhancement)
parent: none. blocked_by: []. Brief criteria: the conclude comment links `compare/<base>...<head>`, reusing the base-branch record string #720 adds. Where things are: update-branch/conclude.ts, shared/record.ts (`BASE_NAMED`, added by #720).

## #722 "record: one wording for every refusal's first line" (open; ready-for-agent, enhancement)
parent: none. blocked_by: []. Brief criteria: every `**agent:X didn't run:**` line comes from one helper. Where things are: shared/record.ts (rewrites `updateBranchRefusal` and the other refusal builders).

## #723 "follow-ups: skip a stub whose title already exists" (open; ready-for-agent, bug)
parent: none. blocked_by: []. Where things are: follow-ups/file.ts.

## #724 "ADOPTING: document AGENT_SANDBOX_PROXY for service adopters" (open; ready-for-agent, documentation)
parent: none. blocked_by: [#650 (open, "Decide whether service adopters need a proxy at all", needs-triage)]. Where things are: docs/ADOPTING.md.

## #725 "doctor: warn when AGENT_MAX_FIX_ROUNDS is above 10" (open; needs-triage)
parent: none. blocked_by: []. Body only, no comments, no Agent Brief.

## #726 "slice 2: render the progress table on the parent" (open; ready-for-agent)
parent: #700 (open PRD "Progress view for PRD chains"; its chain has not started, no agent:* label on #700). blocked_by: [#699 (slice 1 of #700)].
