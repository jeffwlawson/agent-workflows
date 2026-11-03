---
source: >-
  PR #572, the loop's Review 2 at 3586dd7 (this case's head), which approved and missed both defects: https://github.com/jeffwlawson/agent-workflows/pull/572#pullrequestreview-5725295938, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": fail
  "02": fail
  "03": fail
---

**Review 2**

## Agent review

### 🟢 Approval recommended

All three earlier findings are fixed. The single pack, the idempotent Release attach and the tokenless install check hold together, and the docs now match the deploy scripts on main.

_Nothing left to fix. You can merge once the PR is ready and no longer a draft._

**Findings:** 0

<details>
<summary><b>Resolved since last review</b> (3)</summary>

- Medium [Guide says the worked example installs tokenless; its scripts use a token](https://github.com/jeffwlawson/agent-workflows/pull/572#discussion_r4433500879) · `docs/deploying-the-service.md:509`
- Low [CLAUDE.md:156 still says publish no-ops on a published version](https://github.com/jeffwlawson/agent-workflows/pull/572#discussion_r4433500881) · `CLAUDE.md:234`
- Low ["The same test" no longer refers to the bundled-tree test](https://github.com/jeffwlawson/agent-workflows/pull/572#discussion_r4433500884) · `CLAUDE.md:235`

</details>

<details>
<summary><b>Acceptance criteria</b> (6) · 6 met</summary>

- **Met:** A release run publishes the same tarball to GitHub Packages and attaches it, with a `.sha256` file, to the Release for the tag; the digest in the file matches the attached tarball.
- **Met:** Re-running on an already-published tag with the Release or asset missing creates what is missing; with both present, changes nothing.
- **Met:** `npm install <asset url>` of the attached tarball, with no registry credentials in the environment, installs the package with its bundled tree intact (the same check `scripts/bundled-tree.ts` makes after a registry install).
- **Met:** The workflow's Release steps reference no repository or owner by name: they use the workflow's own context (`github.repository`, the tag), and the docs show the URL form with placeholders.
- **Met:** `tests/workflows.test.ts` asserts the permission and the shared tarball between the pack, publish and upload steps.
- **Met:** The guide names the tokenless install and says the registry route needs a token.

</details>

<details open>
<summary><b>Since the brief</b> (3) · commits since <code>a3a39c2</code> that touched the files it names</summary>

Files checked: `.github/workflows/publish.yml`, `scripts/bundled-tree.ts`, `tests/bundled-tree.test.ts`, `docs/deploying-the-service.md`.

On the base branch, newest first:

- `8e5d3a1` feat(deploy): move the Unraid install, upgrade and check scripts into deploy/unraid/ (#564)
- `a0c2980` fix(service): fetch the repository's tags into every checkout (#567) (#568)
- `573c7c2` fix(update-branch): conclude a conflicted merge under bwrap (#559)

**Ruling:** None of the listed commits changes what a criterion means. 8e5d3a1 (#564) only affects the worked example's wording, which the guide now reflects; a0c2980 and 573c7c2 do not touch the publish flow.

</details>

<details open>
<summary><b>Not checked here</b> (1) · tests exercising this change that the review's own run skipped</summary>

- **tests/workflows.test.ts publish suite**: vitest could not start: this checkout has no node_modules

</details>

<details>
<summary><b>Follow-ups</b> (1) · filed as issues on merge; remove <code>agent:follow-ups</code> to skip</summary>

- Low **Move the deploy/unraid install and upgrade scripts to the tokenless install** · `deploy/unraid/install-box.sh:235`

</details>

<details>
<summary><b>How this was checked</b></summary>

This is a verification of the earlier round. I read fix commit 3586dd7 and the whole of publish.yml, and compared the guide's worked-example line with install-box.sh and upgrade-box.sh at 8e5d3a1. I swept the checkout for 'no-op', 'already published', 'already on the registry', '--ignore-scripts' and 'read:packages': 7 hits, all still true (the read:packages hits describe npm exec on Actions). No new destination: the Release notes are a fixed string. My vitest run could not start because this checkout has no node_modules; CI verify is green.

</details>
