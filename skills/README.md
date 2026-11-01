# Skills for driving the loop

Claude Code skills for the maintainer's side of the loop, in any repository that runs it. They are not part of the package: `npm pack` ships `dist/` only, and nothing in the loop reads this folder.

| Skill | Invoked | What it does |
|---|---|---|
| [`issues-to-prd`](issues-to-prd/SKILL.md) | `/issues-to-prd` | Checks one issue and says what it needs, or stages a set of existing issues: triages the ones without a current brief, groups the ones that depend on or conflict with each other into PRDs (the existing issues become ordered sub-issues), leaves the rest as plain issues, and stops with everything ready for the maintainer to add `agent:implement`. |
| [`merge-check`](merge-check/SKILL.md) | `/merge-check <PR>`, or by Claude when asked to check a PR before merging | The review the loop cannot give a PR it handed back: verify on the exact head, grade against the briefs, sweep for stale text, run what CI skipped or only a real host can check, and report merge-ready, with the two ways on (the maintainer's own guarded merge, or `agent:merge` at the checked head), or the findings. |

Both read their rules at run time rather than carrying them: the repository's own `CLAUDE.md` and `docs/agents/`, and this repository's `CONTEXT.md` and `docs/agents/` at the release the repository's callers pin.

## Install

With the `skills` CLI, user-level, like Matt Pocock's:

```bash
npx skills add jeffwlawson/agent-workflows -g -s issues-to-prd -s merge-check
```

`npx skills update -g -y` updates them with the rest.

## Tests

`evals/<skill>/<case>/` holds each skill's test cases in the layout `claude plugin eval` reads (a prompt, a simulated `world.md`, and one grader per assertion). They are rehearsals: GitHub is simulated, so a run makes no call. `merge-check` has none yet.
