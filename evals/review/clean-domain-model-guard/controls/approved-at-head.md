---
source: >-
  PR #678, the loop's Review 3 at b18b87f (this case's head), which approved: https://github.com/jeffwlawson/agent-workflows/pull/678#pullrequestreview-5740485810, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
---

**Review 3**

## Agent review

### 🟢 Approval recommended

Nothing is unresolved: the §0 table is whole again, and the domain-model check covers each state the issue lists, on either orchestrator, with a test for each.

_Nothing here blocks the merge; any minor findings below are filed as one follow-up. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Resolved since last review</b> (1)</summary>

- Medium [The §0 table's orchestrator row lost its failure column](https://github.com/jeffwlawson/agent-workflows/pull/678#discussion_r4445376101) · `docs/ADOPTING.md:116`

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

**Ruling:** None of the listed commits changes what a criterion means; ec1b392 and fe1da7e touched ADOPTING.md, doctor.ts and the install-path rules, which the change edits where they now stand.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/agent-cli.test.ts domain model suite (8 tests)**: Not run: node_modules is not installed in this checkout (vitest failed with ERR_MODULE_NOT_FOUND); CI verify is green.

</details>

<details>
<summary><b>How this was checked</b></summary>

This pass verifies the earlier round. I checked f-c745cd0d by reading b18b87f and counting cells on docs/ADOPTING.md:116-117 (two each). I searched for 'every other row', 'instead of what Actions', 'none of what follows' and 'No repository fact' and read 5 hits; all still true, including ADOPTING.md:550, doctor.ts:620 and the nothingRead message. No text goes anywhere new: findings carry only fixed file names. I ran no tests (no node_modules) and relied on CI verify passing.

</details>
