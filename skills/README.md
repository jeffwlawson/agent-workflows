# Skills for driving the loop

Claude Code skills for the maintainer's side of the loop, in any repository that runs it. They are not part of the package: `npm pack` ships `dist/` only, and nothing in the loop reads this folder.

| Skill | Invoked | What it does |
|---|---|---|
| [`conduct`](conduct/SKILL.md) | `/conduct`, `/conduct #A #B` or `/conduct #P` | Drives the loop from an editor session, with the maintainer at four checkpoints only (delegate a batch, decide a hand-back, cut a release, restart the service): picks and orders the ready work around conflicts, stages it through `issues-to-prd`, queues one task at a time, watches the record with its `scripts/snapshot` and `scripts/wait-until` (conditional REST requests, so a quiet poll costs none of the token's limit), sends each hand-back to `merge-check` on a model chosen by what it touches, and carries out only what the maintainer delegated. It keeps a dated ledger and a lock outside the repository, and ends with the digest, an escape retro and a handoff. |
| [`issues-to-prd`](issues-to-prd/SKILL.md) | `/issues-to-prd` | Checks one issue and says what it needs, or stages a set of existing issues: triages the ones without a current brief, groups the ones that depend on or conflict with each other into PRDs (the existing issues become ordered sub-issues), leaves the rest as plain issues, and stops with everything ready for the maintainer to add `agent:implement`. |
| [`merge-check`](merge-check/SKILL.md) | `/merge-check <PR>`, or by Claude when asked to check a PR before merging | The review the loop cannot give a PR it handed back: verify on the exact head, grade against the briefs, sweep for stale text, run what CI skipped or only a real host can check, and report merge-ready, with the two ways on (the maintainer's own guarded merge, or `agent:merge` at the checked head), or the findings. As a digest (`/merge-check --digest`, or "digest the open loop PRs"), the same check on every open loop PR approved at its head, writing nothing, so it can run on a schedule under a read-only token (read access to contents, pull requests, issues, commit statuses, checks and actions); it ends in one brief, *Needs you* first, that `conduct` reads. |

All three read their rules at run time rather than carrying them: the repository's own `CLAUDE.md` and `docs/agents/`, and this repository's `CONTEXT.md` and `docs/agents/` at the release the repository's callers pin.

## Where they fit

[Matt Pocock's skills](https://github.com/mattpocock/skills) plan the work and these three run it:

1. `/wayfinder` maps work too big for one session; `/to-spec` writes a PRD; `/to-tickets` slices it into issues. `/triage` briefs a single issue.
2. `issues-to-prd` stages the issues the loop will build: briefs, PRDs, order.
3. `conduct` queues them, watches the loop, and brings each hand-back, release and restart to the maintainer.
4. `merge-check` checks a pull request the loop handed back before it merges.

## Install

With the `skills` CLI, user-level, beside Matt Pocock's, which they use:

```bash
npx skills add jeffwlawson/agent-workflows -g -s conduct -s issues-to-prd -s merge-check
npx skills add mattpocock/skills -g -s triage -s to-spec -s to-tickets -s retro -s writing-for-agents
```

What each needs installed beside it:

- `issues-to-prd`: `triage`, whose `AGENT-BRIEF.md` is the shape of every brief it writes.
- `conduct`: `issues-to-prd` and `merge-check`, which it routes to, and `retro`, which runs its end-of-session retrospective (and reads `writing-for-agents`).
- `merge-check`: nothing beyond `gh` and the repository.

`to-spec` and `to-tickets` are for planning a PRD before any of these run. `conduct` checks for what it needs before its first action, and `issues-to-prd` before it triages; each stops with the lines above. `npx skills update -g -y` updates them all.

## Tests

`evals/<skill>/<case>/` holds each skill's test cases in the layout `claude plugin eval` reads (a prompt, a simulated `world.md`, and one grader per assertion). They are rehearsals: GitHub is simulated, so a run makes no call. `tests/skills.test.ts` holds each case to that layout.
