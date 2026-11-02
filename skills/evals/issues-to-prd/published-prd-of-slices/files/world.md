# Simulated state, 2026-10-25 19:00 UTC

Session: Claude Code cloud session. `gh` GraphQL calls return 403; REST works.
Repo: jeffwlawson/agent-workflows; main is at 9b923c9 (the checkout in the working directory).

## Issue #730 "PRD: follow-ups names its source in each stub" (open)
Labels: ready-for-agent, enhancement. No assignee.
Body: "## Problem Statement ... ## Solution ... ## Implementation Decisions ... (written by /to-spec, 2026-10-25)"
issues/730/parent: 404 (none). issues/730/sub_issues: [#731, #732] (in that order). issues/730/dependencies/blocked_by: [].
Timeline: no cross-referenced PR. No open PR has a head branch agent/issue-730-*.
Comments: none.

## Issue #731 "follow-ups: carry the merged PR's number into the stub plan" (open)
Published by /to-tickets from #730, 2026-10-25T18:20Z.
Labels: ready-for-agent, enhancement. No assignee.
Body: "## Parent\n#730\n\n## What to build\nThe stub plan records the number of the merged pull request each finding came from.\n\n## Acceptance criteria\n- [ ] Each planned stub carries the merged PR's number.\n- [ ] A test asserts the number on a plan built from a two-finding review.\n\n## Where things are\n(read at 9b923c9, 2026-10-25): shared/follow-up-plan.ts."
issues/731/parent: #730. issues/731/sub_issues: []. issues/731/dependencies/blocked_by: [].
Timeline: no cross-referenced PR. No open PR has a head branch agent/issue-731-*.
Comments: none.

## Issue #732 "follow-ups: end each filed stub's title with (from #<pr>)" (open)
Published by /to-tickets from #730, 2026-10-25T18:21Z.
Labels: ready-for-agent, enhancement. No assignee.
Body: "## Parent\n#730\n\n## What to build\nA filed stub's title ends with `(from #<pr>)`, kept whole when the title is cut to its cap.\n\n## Acceptance criteria\n- [ ] A stub filed by follow-ups has a title ending in `(from #<pr>)`.\n- [ ] A test asserts the suffix survives on a title longer than the cap.\n\n## Blocked by\n#731\n\n## Where things are\n(read at 9b923c9, 2026-10-25): shared/follow-up-plan.ts (`MAX_STUB_TITLE`), follow-ups/file.ts."
issues/732/parent: #730. issues/732/sub_issues: []. issues/732/dependencies/blocked_by: [#731].
Timeline: no cross-referenced PR. No open PR has a head branch agent/issue-732-*.
Comments: none.
