# Agent skills

Per-repo config for the `mattpocock/skills` engineering skills lives in `docs/agents/`. The three
files below were **generated** by `/setup-matt-pocock-skills` and then hand-extended — edit them
directly, and do not re-run the skill to change one: it rewrites each file with its own defaults,
and `triage-labels.md` would lose everything below its mapping table (`docs/ADOPTING.md` §4).
[`ticket-shape.md`](./ticket-shape.md) is the exception: loop doctrine, hand-written,
never regenerated.

The loop's own skills, `issues-to-prd` and `merge-check`, live in [`skills/`](../../skills/README.md),
outside the package. They read `CONTEXT.md` and `docs/agents/` from the release a repository pins,
so a change to how those files describe the PRD shape, briefs or blocking is a change to what the
skills do once it is released.

## Issue tracker

GitHub Issues in this repo, via the `gh` CLI, with **native** sub-issue and blocking relations —
prose in an issue body is invisible to every workflow here. See
[`docs/agents/issue-tracker.md`](./issue-tracker.md).
Before writing a brief, `/triage` checks other issues, open PRs and work in flight for overlap: see
[*Before a brief*](./issue-tracker.md#before-a-brief-overlap-with-other-work).

## Triage labels

The five canonical triage roles at their default strings, kept as a **second vocabulary** beside
`agent:*` workflow state rather than merged into it; the one join, `ready-for-agent` →
`agent:implement`, stays a human hand, and `agent:merge`, the merge decision, is the second human
hand into `agent:*` (ADR 0009). Also the only definition of the `wayfinder:*` planning
labels, which two workflows refuse and nothing else describes. See
[`docs/agents/triage-labels.md`](./triage-labels.md).

## Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](./domain.md).
