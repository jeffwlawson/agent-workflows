---
source: >-
  PR #681, the loop's Review 1 at c237a40 (this case's head), which approved: https://github.com/jeffwlawson/agent-workflows/pull/681#pullrequestreview-5740735881, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
---

**Review 1**

## Agent review

### 🟢 Approval recommended

The trailer parser, the Release body written only on creation, and the convention docs each do what #621 asks; a real git run gave the output the tests expect.

_Nothing here blocks the merge; any minor findings below are filed as one follow-up. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Acceptance criteria</b> (8) · 8 met</summary>

- **Met:** The script, given a log containing `Adopter-Action:` lines, returns a section listing each with its short SHA and pull request number; given none, a section saying there is no adopter action; given no earlier tag, the "no earlier release" line.
- **Met:** A line that merely mentions the key mid-sentence is not taken; the key matches at the start of a line, ignoring case.
- **Met:** The Release `publish.yml` creates has the install sentence and the *Adopter action* section as its body, built from the history between the previous `v*` tag and this one, and a re-run that finds the Release present does not change its body.
- **Met:** The script is excluded from the tarball and nothing built imports it, the way `scripts/sync-version.ts` is, and a test says so.
- **Met:** A test in `tests/workflows.test.ts` holds `publish.yml` to calling the script on the Release's creation and to passing the body by file.
- **Met:** `CLAUDE.md` says when a change owes an adopter action and the trailer's exact form, and `docs/ADOPTING.md`'s *Keeping the pins fresh* tells an adopter to read the section when moving the pin.
- **Met:** The PR states what a real squash-merged commit on `main` showed for a trailer.
- **Met:** The verify command `CLAUDE.md` names passes.

</details>

<details open>
<summary><b>Since the brief</b> (14) · commits since <code>eb394fe</code> that touched the files it names</summary>

Files checked: `.github/workflows/publish.yml`, `scripts/sync-version.ts`, `scripts/bundled-tree.ts`, `tests/sync-version.test.ts`, `scripts`, `CLAUDE.md`, `docs/ADOPTING.md`, `setup/doctor.ts`, `docs/platform-spec.md`.

On the base branch, newest first:

- `ba0c0d6` feat(doctor): fail a checkout whose domain model was renamed from CONTEXT.md to GLOSSARY.md (#611) (#678)
- `a993404` docs(agents): correct label, upstream and tag drift; the issues-to-prd gate counts /to-tickets slices as briefed (#609) (#676)
- `5480095` feat(service): the Workflow run link names the job, and a run index lists the runs on the worker's machine (#604) (#672)
- `025f0c8` fix(service): a merge delivery with a later deadline replaces the queued merge job (#664)
- `c03dbab` feat(usage-limit): a run the plan's usage limit stopped resumes by itself on the service (#658)
- `ca43755` feat(follow-ups): file a pull request's minor findings as one issue (#625) (#657)
- `b383533` feat(review): AGENT_FIX_MIN_SEVERITY, a review whose open findings are all below it approves over m… (#655)
- `fe1da7e` docs(claude-md): split CLAUDE.md into a short core with a pointer per topic (#654)
- `06850da` feat(agent): pin Claude Code, add effort and prompt-cache TTL inputs, stop re-reading CLAUDE.md (#650)
- `10100b2` feat(usage): record each agent run's token usage and cost in usage.json and the job summary (#647)
- `257f996` feat(callers): run agent:merge here, now the local callers pin v0.9.5 (#646)
- `ec1b392` feat(merge): agent:merge, the maintainer's merge decision carried out by the loop (#599)
- `c7455e8` feat(service): run follow-ups and update-branch's merge in a light lane beside the agent lane (#636)
- `0f9d602` feat(evals): golden-PR evals for the review and fix prompts, run by hand with a catch rate per case (#630)

**Ruling:** fe1da7e split CLAUDE.md, so C6's 'Changing a workflow step 3' and 'Releasing' now live in docs/agents/changing-a-workflow.md and docs/agents/releasing.md, both of which this change edits; no other listed commit changes a criterion.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **npm run verify (the whole suite, including tests/release-notes.test.ts, tests/workflows.test.ts and tests/sync-version.test.ts)**: node_modules is not installed here (sh: tsc: not found); CI's verify is green on this commit

</details>

<details>
<summary><b>How this was checked</b></summary>

Read the diff, publish.yml around the Release step, .nvmrc (Node 24 runs .ts from source) and the real squash body of ba0c0d6. Ran scripts/release-notes.ts on this checkout (v0.9.5), and in a mktemp repo on a first tag, a trailer in the middle of a squash body, and an unknown tag (exits 1). Searched 'install sentence', '--notes', 'release notes', 'Release body', 'creates no Release'; none of the 9 relevant hits was made false. One new destination: commit-message lines in the Release body, which are already public on main.

</details>
