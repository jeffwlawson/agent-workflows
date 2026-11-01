> *Filed by Claude Code from the profiling map #267, 2026-10-01.*

## Agent Brief

**Category:** enhancement

**Summary:** An implement run that reaches its time limit can lose finished, committed work. Push the agent's branch whenever it has commits, even on a cancelled or failed run, have the agent commit as soon as its work first passes verify, and have the retry resume from the pushed branch rather than overwrite it.

**Current behavior:**
- **#257's run nearly lost its work** ([run 36823054971](https://github.com/jeffwlawson/agent-workflows/actions/runs/36823054971)).
  - The agent committed finished work (`26fa544`, verify passing) and stopped at 29:40.
  - The job hit `timeout-minutes: 30` during `Push branch`, which was marked cancelled.
  - The push happened to reach GitHub. Had it not, 30 minutes of finished work would have been gone with the runner.
  - The PR was opened by hand afterwards.
- **`Push branch`, `Open draft PR` and `Request review` are all gated on `success()`.** A cancelled or failed job pushes nothing.
- **The agent commits once, at the very end.** #257's only commit came 3 minutes before the limit, after 27 minutes of uncommitted edits.
- **The failure comment never mentions a branch**, and a retry force-pushes over whatever is there (`git push --force`).

**Desired behavior:**
- **A salvage step in `implement.yml`**, on `cancelled() || failure()`, only where the preflight did not refuse:
  - if `BRANCH` has commits ahead of `BASE_REF`, push it;
  - open no PR, request no review, and change no labels beyond what the failure path already does;
  - run before `Mark blocked on failure`, so that step can name what it pushed.
- **The retry resumes** (decided in #302). When `agent:implement` is re-applied and `BRANCH` exists on the remote with commits ahead of the base, the agent starts from those commits instead of a fresh branch, and is told they are unverified: run the verify command `CLAUDE.md` names before going further. The rescued work reaches a PR only through the retry's normal push and PR steps. Check how the preflight treats an existing branch today; a retry must not force-push over it.
  - A retry that times out again rescues again; it started from the rescued commits, so it holds everything they held.
- **The failure comment names the pushed branch** and says re-applying `agent:implement` resumes from it.
- **One new line in `implement/prompt.md`:** commit as soon as the work first passes the verify command `CLAUDE.md` names, and make later changes as further commits.
  - Prompts name no domain and never the gate command itself; a test enforces this.
  - The squash merge keeps the history tidy.

**Acceptance criteria:**
- [ ] A timed-out run whose agent had committed leaves its branch on the remote, and the failure comment names it.
- [ ] A run with no commits ahead of the base pushes nothing.
- [ ] `tests/workflows.test.ts` asserts the step's condition, its position before `Mark blocked on failure`, and that it never runs `gh pr create` or adds `agent:review`.
- [ ] A retry after a rescue starts from the rescued commits, and its push does not overwrite them.
- [ ] The prompt line is present, and the existing prompt tests still pass.

**Out of scope:**
- implement-prd, fix and update-branch. Decided in #302 and filed as #303: fix and implement-prd rescue to a side branch, because an open PR already tracks their work branch; update-branch rescues nothing.
- Stopping the agent before the job limit (a runner deadline). Decided against in #339: this rescue works without one.
- Raising the default limit. The repository variable `AGENT_TIMEOUT_MINUTES` already does that, and is being set by hand.
