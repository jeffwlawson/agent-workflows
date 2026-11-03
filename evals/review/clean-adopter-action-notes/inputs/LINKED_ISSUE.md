> *Filed by AI from a comparison with Matt Pocock's skills (`mattpocock/skills` at 4ae2317), 2026-10-31. The plan was decided by the maintainer. The idea is the content of his changesets, not the tool: each release entry says what changed and, where it matters, what the user must do ("Re-run `/setup-matt-pocock-skills` to refresh `docs/agents/`", `CHANGELOG.md`, 1.3.2). This repository already rejects the tool: `scripts/sync-version.ts` does the propagation.*

## Agent Brief

**Category:** enhancement

**Summary:** Make each GitHub Release body carry an **Adopter action** section: the changes in that release a repository running the loop must act on (a caller edit, an App permission or event subscription, a repository variable or secret, a changed default). It is collected from a trailer in the commit messages between the previous release and this one, so it needs no new tool and no model.

**Why:**
- `publish.yml` now creates the Release (#572, #561) with one fixed install sentence. Nothing tells an adopter what to do on upgrading, and the moment of upgrading is when they read it.
- Some releases need an action and this repository already knows which: a caller *body* change is a change to `diagnose` in `setup/doctor.ts` (`CLAUDE.md`, *Changing the install path*), a new caller input or secret is a two-step release, a new App event subscription is something only a person can do in the App's settings. Examples that would have been flagged: the App event subscription `agent:merge` needs (#585), and a default that changes behaviour on upgrade, such as `AGENT_FIX_MIN_SEVERITY` defaulting to `medium` (#616).
- The knowledge exists at the moment a change is written and is gone by release day. A convention that records it with the change keeps it.

**Current behaviour:**
- `publish.yml`'s *Attach the tarball to the Release* step runs `gh release create "$TAG" --verify-tag --title "$TAG" --notes "<the install sentence>"` only when the Release is absent, then attaches the tarball and its `.sha256`. The body is the same sentence for every release.
- The job already checks out with `fetch-depth: 0` and the tag is on `main`, so the history between two tags is available to it.
- Commits reach `main` as squash merges whose messages keep each commit's subject and body (as `Agent-Slice:` trailers already survive into the PRD branch's first-parent log, `docs/platform-spec.md` §4.3).
- #260 (parked) asks for an agent-written release-notes workflow and says `publish.yml` creates no Release; that is out of date since #572. This issue is the cheap, deterministic part of that question and does not close it.

**Desired behaviour:**
- **The source is a commit-message trailer**, `Adopter-Action: <one sentence, imperative, saying what to do and where>`, on its own line in a commit's message. A pull request that needs the adopter to act carries one (more than one is allowed). Squash merging keeps it in the commit body on `main`, which is where the release reads it.
  - **Why a trailer and not a section of the pull request's body:** it lives in the history the tag points at, so the release reads it offline, with no API call, no rate limit and no dependence on a body that was edited after the merge. It is reviewed with the diff. It follows the convention the repository already uses for commit-borne facts (`Agent-Slice:`, `Agent-Catch-Up:`). A pull request body can be edited without a trace and says nothing to a re-run of the release.
- **The release reads the range** from the previous `v*` tag reachable from this tag to this tag, takes every line that begins `Adopter-Action:` (case-insensitive key, at the start of a line), and lists them, each with its short commit SHA and, where the subject ends `(#<n>)`, the pull request.
- **The body always has the section:** the list, or a line saying "No adopter action." when there is none, so an empty section is distinguishable from one nobody checked. The fixed install sentence stays.
- **The first release, or a tag with no earlier tag, gets the section with "No earlier release to compare with."**, not a failure.
- **It runs only where the Release is created**, as today: a re-run that finds the Release present does not rewrite its body.
- **The logic is a script under `scripts/`**, run from source like `scripts/sync-version.ts` and excluded from the tarball (release policy for this repository, not something an adopter's install runs), with a function that takes the log text and returns the section, so it is tested without git. `publish.yml` calls it and passes the body to `gh release create` by file.
- **The convention is written down where an author reads it:** `CLAUDE.md` (*Changing a workflow* step 3 and *Releasing*, in a sentence each) says when a change owes an adopter action and the trailer's form, and `docs/ADOPTING.md`'s *Keeping the pins fresh* (§4) tells an adopter to read the Release's *Adopter action* section when moving the pin.
- **The review is not taught it.** The prompts name no domain; `CLAUDE.md` is read by the review as the repository's standards, so a line there is enough for it to notice a caller change with no trailer.

**Decisions made here (the implementer may change one with a reason in the PR):**
- **Squash bodies, checked against a real one.** The implementer confirms with a real squash-merged commit on `main` that a trailer in a commit message of the pull request appears as its own line in the squash body, and that one written in the pull request description does when the repository's squash setting uses it; the PR says what was found and which of the two the convention names. If GitHub prefixes or wraps it, the script's match is adjusted, not the convention.
- **Plain trailer lines, not `git interpret-trailers`:** squash bodies put commit messages end to end, so a trailer is not always in a final paragraph.
- **A mistake is cheap.** A wrong or missing trailer is fixed by editing the Release body by hand; nothing is blocked on it.
- **Not enforced.** No test can know a change owes an action. The trailer is a convention a review can notice.

**Acceptance criteria:**
- [ ] The script, given a log containing `Adopter-Action:` lines, returns a section listing each with its short SHA and pull request number; given none, a section saying there is no adopter action; given no earlier tag, the "no earlier release" line.
- [ ] A line that merely mentions the key mid-sentence is not taken; the key matches at the start of a line, ignoring case.
- [ ] The Release `publish.yml` creates has the install sentence and the *Adopter action* section as its body, built from the history between the previous `v*` tag and this one, and a re-run that finds the Release present does not change its body.
- [ ] The script is excluded from the tarball and nothing built imports it, the way `scripts/sync-version.ts` is, and a test says so.
- [ ] A test in `tests/workflows.test.ts` holds `publish.yml` to calling the script on the Release's creation and to passing the body by file.
- [ ] `CLAUDE.md` says when a change owes an adopter action and the trailer's exact form, and `docs/ADOPTING.md`'s *Keeping the pins fresh* tells an adopter to read the section when moving the pin.
- [ ] The PR states what a real squash-merged commit on `main` showed for a trailer.
- [ ] The verify command `CLAUDE.md` names passes.

## Tests

- The script's function over fixture logs: no trailer, one, several, a trailer in a squash body's middle, a mid-sentence mention, mixed-case key, a subject without a pull request number, no earlier tag.
- `tests/workflows.test.ts`: `publish.yml` calls the script and passes a body file to `gh release create`.
- `tests/sync-version.test.ts`'s check that nothing built imports from `scripts/` still holds.

## After merge, by a human

- On the next release, open the Release and check its *Adopter action* section against what changed. If a change that needed an action has no trailer, say so on the release's pull request so the convention is learned.

## Out of scope

An agent-written changelog (#260); a `CHANGELOG.md` file; the changesets tool; enforcing the trailer; grouping notes by label (GitHub's generated notes could be added with `--generate-notes` as a separate decision); editing a Release after it exists.

## Where things are

Read at `main` eb394fe, 2026-10-31. Hints only: the implementer re-reads them on the code as it then stands.
- `.github/workflows/publish.yml`: *Attach the tarball to the Release* (the `gh release create` and its `--notes`); the checkout's `fetch-depth: 0`.
- `scripts/sync-version.ts` and `scripts/bundled-tree.ts` for how a release-only script is run from source; `tests/sync-version.test.ts` for the "nothing built imports `scripts/`" test.
- `CLAUDE.md`: *Changing a workflow* step 3 and *Releasing*; `docs/ADOPTING.md` §4, *Keeping the pins fresh*; `setup/doctor.ts` (`diagnose`) for the caller-body rule.
- `docs/platform-spec.md` §4.3 for how commit trailers are written up (this one is read by the release script, not by a runner, so it is not a record string a runner reads; the PR decides whether it still belongs there).

## Overlap checked

- #260 (parked: an agent-written release-notes workflow) is the nearest. It is a different decision (an agent, a repo-defined format, a new trigger) and its premise that `publish.yml` makes no Release is out of date. This issue does not revive or close it.
- #572 (merged) made the Release and #576 (needs-triage: move the deploy scripts to the tokenless install) edits the deploy scripts, not `publish.yml`'s notes. #605 (the skills as a plugin) edits `scripts/sync-version.ts` and `CLAUDE.md`'s *Releasing*: wording in a shared file, so no edge.
- No similar request in `.out-of-scope/`.
