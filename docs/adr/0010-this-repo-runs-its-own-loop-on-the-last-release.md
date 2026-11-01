---
status: accepted
date: 2026-11-01
---

# This repo runs its own loop, on the last release

A caller per workflow is installed in `.github/workflows/`, in two caller files, one per side
(#225): `agent-pr.yml` and `agent-issue.yml`, prefixed `agent-` so they do not collide by filename
with the reusable workflows they call. Job ids stay unprefixed: `self-check` is built from job ids,
not filenames, so the `review` job in `agent-pr.yml` keeps `review / review`.

They use a **pinned remote** reference, `jeffwlawson/agent-workflows/...@v<tag>`, rather than a
local `./` path. The tag is not written out here on purpose — prose is the one copy of it no test
reads, and it sat two releases behind before anyone noticed. The local callers carry the live pin
and are checked against `package.json`; read it there.

That is a deliberate choice with one decisive reason and one supporting one.

**The runner version is baked into the reusable workflow** (`npm exec …@<version>`, held equal to
`package.json` by a test), so the `uses:` ref selects the runner too. A pinned remote therefore
takes YAML and runner from the *same release*, always. A local `./` path takes YAML from the **default
branch** instead — and the moment `npm version` lands on `main`, that YAML names a version the
registry does not have yet. Every agent run in this repo would die at the install step until the tag
is pushed and the publish finishes. A window that opens on every release.

**And a bad merge would break the loop you would use to fix it.** With a local path the base branch
supplies the workflow, so merging a broken reusable leaves no good version running. Pinned, a bad
merge is inert until you tag; the loop keeps working on the last good release while you repair
`main`.

The cost is real: **a change is not exercised by this repo's own loop until it is released.** That
is covered elsewhere — `npm run verify` and CI gate the working tree, and consuming repos exercise
the released loop. Dogfooding here answers "does the loop function end to end", not "does my
unreleased change work".

The pin covers the reusable half only. The **callers** are read from `main`, so a caller change is
live the moment it merges, against the *released* reusable. A caller passing a secret or input that
release does not declare is refused by GitHub before any job starts — every job in the file, no log
(#330 did this ahead of v0.7.9). `tests/workflows.test.ts` holds the local callers to the release
they pin, read with `git show v<pin>:…`, so a change to a caller's interface lands in two steps:
the reusable, released, then the local caller.

**Do not break the gate.** If `npm run verify` stops working, every agent run in every consuming
repo loses the instruction the prompts depend on.
