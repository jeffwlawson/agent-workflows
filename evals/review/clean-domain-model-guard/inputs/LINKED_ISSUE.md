> *Filed by AI from a comparison with Matt Pocock's skills (`mattpocock/skills` at 4ae2317), 2026-10-31. The plan was decided by the maintainer. The risk comes from upstream's `setup-matt-pocock-skills` and `domain-modeling` skills.*

## Agent Brief

**Category:** enhancement

**Summary:** Upstream renamed the domain-model file from `CONTEXT.md` to `GLOSSARY.md` (`d80fa0f`). This repo's five runner prompts read `CONTEXT.md` by name. A re-run of upstream's setup that accepts its recommended rename would leave every prompt pointing at a file that no longer exists, and nothing reports it, because a missing file reads as an empty one. Say so in the docs and have `doctor` report the state.

**Current behaviour:**
- Upstream `setup-matt-pocock-skills` now looks for `GLOSSARY.md` and, finding the legacy `CONTEXT.md`, offers to `git mv` it and to rewrite the names in `docs/agents/domain.md`. `domain-modeling` creates `GLOSSARY.md` lazily when none exists, and `tdd` and `diagnosing-bugs` read it. The installed copies of these skills are current.
- This repo's `implement`, `implement-prd`, `review`, `fix` and `update-branch` prompts tell the agent to read `CONTEXT.md`. `docs/agents/domain.md` maps the layout onto `CONTEXT.md`. `setup/SETUP.md` section 4 and `docs/ADOPTING.md` section 6 tell an adopter to write one.
- So: in an adopter's repository, accepting the rename leaves the runners reading nothing, silently; in this one, `/domain-modeling` or `/grill-with-docs` would start a second glossary beside `CONTEXT.md`.

**Desired behaviour:**
- `docs/agents/domain.md` gets one paragraph: where an upstream skill says `GLOSSARY.md`, read `CONTEXT.md`; decline setup's offer to rename it, because the loop's prompts read `CONTEXT.md`; never create `GLOSSARY.md`; add resolved terms to `CONTEXT.md`.
- `setup/SETUP.md` section 4 and `docs/ADOPTING.md` section 6 carry the same warning for an adopter, in a sentence each.
- `doctor` reports, as an error with a fix, a checkout that has a `GLOSSARY.md` (or a `GLOSSARY-MAP.md`) and no `CONTEXT.md`: the fix is `git mv GLOSSARY.md CONTEXT.md`. A checkout with both files gets a note, not an error, that the prompts read only `CONTEXT.md`. A checkout with neither is unchanged (the existing guidance already treats that as the adopter's to write). A repository `doctor` cannot read the files of stays *unknown*, never a pass.

**Decisions made here (the implementer may change one with a reason in the PR):**
- The prompts are **not** reworded to say "or `GLOSSARY.md`". Five prompts, each pinned by tests, for a case `doctor` now catches. If `doctor` proves not enough, that is a separate change.
- Glossary-only is an **error** (the runners then read nothing), and both files is a **note** (the prompts read only `CONTEXT.md`, which may be what the adopter wants).

**Acceptance criteria:**
- [ ] `docs/agents/domain.md` tells the reader to read `CONTEXT.md` wherever an upstream skill says `GLOSSARY.md`, to decline the rename, and to add resolved terms to `CONTEXT.md`.
- [ ] `setup/SETUP.md` and `docs/ADOPTING.md` each warn an adopter, in the place they tell them to write the domain model, that the loop's prompts read `CONTEXT.md` and a rename to `GLOSSARY.md` would leave them reading nothing.
- [ ] `doctor` reports an error (and exits non-zero) for a checkout with `GLOSSARY.md` and no `CONTEXT.md`, naming both files and the `git mv` that fixes it.
- [ ] `doctor` notes a checkout with both files and passes one with only `CONTEXT.md` or with neither, as today.
- [ ] A checkout `doctor` cannot read is reported as unknown for this check, not as a pass.
- [ ] `setup/SETUP.md` is still copied into `dist/` (it is an asset), and the verify command `CLAUDE.md` names passes.

## Tests

`doctor` is two halves (`CLAUDE.md`, *Changing the install path*, rule 4): the fact is gathered from the checkout, and `diagnose` rules on facts alone. Test `diagnose` through the fact, for each state above, and the gather for the files present. Per rule 5, a change to what `diagnose` rules on needs its test in the same commit.

## Out of scope

Rewording the five prompts; migrating this repo's `CONTEXT.md` to a glossary-first layout (D2 in the research); anything about `CONTEXT-MAP.md`; upstream's `GLOSSARY-FORMAT.md` conventions.

## Where things are

Read at `main` eb394fe, 2026-10-31. Hints only.
- `docs/agents/domain.md`: *Before exploring, read these*, *Use the glossary's vocabulary*.
- `setup/SETUP.md`: section 4, the two bullets.
- `docs/ADOPTING.md`: section 6 (the `CONTEXT.md` bullet).
- `setup/doctor.ts`: `RepoFacts`, `gatherFacts(dir)`, `diagnose`.
- `tests/agent-cli.test.ts`: the `doctor` tests.
- Upstream (not in this repo): setup-matt-pocock-skills/SKILL.md step 1 and domain-modeling/SKILL.md.

## Overlap checked

Open PR #599 edits `setup/SETUP.md`, `docs/ADOPTING.md`, `setup/doctor.ts` and `setup/callers.ts` for `agent:merge`; other sections, so wording overlap only. No open issue covers this; #548 and #514 touch `docs/ADOPTING.md` and `doctor` for other reasons (#514 is `needs-triage`; a ready issue is never blocked on an unscheduled one). No similar request in `.out-of-scope/`.
