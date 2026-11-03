# Audits of the agent-facing documents, 2026-11-02

Read-only audits of every prompt, the extraction files, `CLAUDE.md`, `CONTEXT.md`, the two skills and the
evals, against the `writing-for-agents` skill and (for the evals) the benchmarking method of
`skill-creator`. Each was written by a separate agent reading the repo at `origin/main` `c53531d`
(v0.9.10 plus the merges up to #698), then spot-checked by the maintainer's session. Findings are not all
verified: each issue that carries them says to re-read the finding against the current code and strike
any that no longer holds.

| File | Covers | Findings |
| --- | --- | --- |
| [`review-prompt.md`](./review-prompt.md) | `review/prompt.md` | 27 (H1-H4, M1-M11, L1-L12) |
| [`extraction.md`](./extraction.md) | `review/extraction.md`, `fix/extraction.md`, `update-branch/extraction.md` | 19 (H1-H4, M1-M9, L1-L6) |
| [`implement.md`](./implement.md) | `implement/prompt.md`, `implement-prd/prompt.md` | 24 (H1-H4, M1-M9, L1-L11) |
| [`update-branch-claude-md-skills.md`](./update-branch-claude-md-skills.md) | `update-branch/prompt.md` (U1-U9), `CLAUDE.md` (C1-C14), `skills/merge-check` (M1-M11), `skills/issues-to-prd` (I1-I6) | 40 |
| [`context.md`](./context.md) | `CONTEXT.md` | 14 (F1-F14) |
| [`fix-prompt-structural.md`](./fix-prompt-structural.md) | `fix/prompt.md`, the structural changes held out of #700 | 8 |
| [`evals.md`](./evals.md) | `evals/`, `scripts/eval-prompts.ts` against `skill-creator` | recommendations, not numbered findings |

Each finding names a lever from the skill, the proposal written out, the tests that pin the wording it
would change, a class (**safe prune**: no behaviour change expected; **behaviour-affecting**: needs the
golden-PR evals in `evals/` before it merges) and a priority. The work is tracked in issues, one
checklist per area, ordered by native blocking.
