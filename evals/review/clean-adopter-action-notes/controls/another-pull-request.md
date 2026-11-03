---
source: >-
  Another pull request's review that asked for a change, since every review of #681 approved: PR #678, the loop's Review 1 at 7994896: https://github.com/jeffwlawson/agent-workflows/pull/678#pullrequestreview-5740279050, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
---

**Review 1**

## Agent review

### 🟡 Changes recommended

The doctor check and the doc warnings do what #611 asks, but ADOPTING.md §0 still says its table is all doctor rules on, and that §2e replaces every other check on the service.

_The review found changes to make. To skip one, reply to its comment explaining why you're leaving it as is. Then, if the agent isn't already working, add the `agent:fix` label._

**Findings:** 1 (1 Medium)

<details open>
<summary><b>Open</b> (1)</summary>

- Medium ADOPTING.md §0 no longer matches what doctor checks · `setup/doctor.ts:611` *new*

</details>

<details>
<summary><b>Acceptance criteria</b> (6) · 6 met</summary>

- **Met:** `docs/agents/domain.md` tells the reader to read `CONTEXT.md` wherever an upstream skill says `GLOSSARY.md`, to decline the rename, and to add resolved terms to `CONTEXT.md`.
- **Met:** `setup/SETUP.md` and `docs/ADOPTING.md` each warn an adopter, in the place they tell them to write the domain model, that the loop's prompts read `CONTEXT.md` and a rename to `GLOSSARY.md` would leave them reading nothing.
- **Met:** `doctor` reports an error (and exits non-zero) for a checkout with `GLOSSARY.md` and no `CONTEXT.md`, naming both files and the `git mv` that fixes it.
- **Met:** `doctor` notes a checkout with both files and passes one with only `CONTEXT.md` or with neither, as today.
- **Met:** A checkout `doctor` cannot read is reported as unknown for this check, not as a pass.
- **Met:** `setup/SETUP.md` is still copied into `dist/` (it is an asset), and the verify command `CLAUDE.md` names passes.

</details>

<details open>
<summary><b>Since the brief</b> (13) · commits since <code>eb394fe</code> that touched the files it names</summary>

Files checked: `docs/agents/domain.md`, `setup/SETUP.md`, `docs/ADOPTING.md`, `CONTEXT.md`, `setup/doctor.ts`, `tests/agent-cli.test.ts`.

On the base branch, newest first:

- `a993404` docs(agents): correct label, upstream and tag drift; the issues-to-prd gate counts /to-tickets slices as briefed (#609) (#676)
- `6e41c32` feat(service): the dispatcher keeps its scan counts and dispatched jobs in one atomically written state file (#618) (#674)
- `a692846` feat(service): the restart scan dispatches follow-ups for a merged pull request still carrying agent:follow-ups (#603) (#670)
- `025f0c8` fix(service): a merge delivery with a later deadline replaces the queued merge job (#664)
- `c03dbab` feat(usage-limit): a run the plan's usage limit stopped resumes by itself on the service (#658)
- `ca43755` feat(follow-ups): file a pull request's minor findings as one issue (#625) (#657)
- `b383533` feat(review): AGENT_FIX_MIN_SEVERITY, a review whose open findings are all below it approves over m… (#655)
- `fe1da7e` docs(claude-md): split CLAUDE.md into a short core with a pointer per topic (#654)
- `06850da` feat(agent): pin Claude Code, add effort and prompt-cache TTL inputs, stop re-reading CLAUDE.md (#650)
- `ec1b392` feat(merge): agent:merge, the maintainer's merge decision carried out by the loop (#599)
- `c7455e8` feat(service): run follow-ups and update-branch's merge in a light lane beside the agent lane (#636)
- `0f9d602` feat(evals): golden-PR evals for the review and fix prompts, run by hand with a catch rate per case (#630)
- `dcc44bc` fix(service): drop a restarted dispatcher's old queued jobs at the held door (#597) (#601)

**Ruling:** None of the listed commits changes what a criterion means: fe1da7e moved the install-path rules into docs/agents/changing-the-install-path.md with the same text, and a993404 and ec1b392 edit other sections of ADOPTING.md and doctor.ts.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/agent-cli.test.ts 'the domain model' block (8 tests)**: vitest could not start: node_modules is absent in this checkout (ERR_MODULE_NOT_FOUND)

</details>

<details>
<summary><b>How this was checked</b></summary>

Read the commit message, setup/doctor.ts (the diagnose split, gatherFacts, runDoctor, nothingRead), the new tests, domain.md, and ADOPTING.md §0 and §6. Searched for 'whole of what it rules on', 'every other row', 'asks gh what a checkout', 'GLOSSARY' and the §0 table pointer in CONTEXT.md; read 6 hits, 3 made false. Tests did not run locally (no node_modules); relied on CI's green verify. New destinations for text: none, since the findings name only fixed file names.

</details>

## Inline comments

### On `setup/doctor.ts`

Medium

`diagnose` now adds `...domainModelFindings(facts.domainModel)` on either orchestrator, which makes three docs false. `docs/ADOPTING.md:85` says the §0 table "is the whole of what it rules on", and `CONTEXT.md:642` points to that table, but it has no domain-model row. `docs/ADOPTING.md:116` says "With `service`, the checks in §2e replace every other row", yet this check runs on the service too (the test `fails it on the service orchestrator too` pins it). `docs/agents/changing-the-install-path.md:19` says `gatherFacts` "asks `gh` what a checkout cannot answer", but it now also lists the checkout's root. Fix: add a §0 row (error, note, unknown warning; either orchestrator), exclude it from line 116's "every other row", and reword rule 4.
