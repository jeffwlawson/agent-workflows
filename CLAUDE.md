# CLAUDE.md

## Commands

```bash
npm run verify      # typecheck + test. This is the gate — it must pass before you finish.
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run build       # tsc + copy prompts into dist/
```

`npm run verify` is the single command that matters. CI runs it, plus a build and a packaging guard
that `verify` cannot cover — see *Releasing*.

## Domain

See [CONTEXT.md](./CONTEXT.md). Read it before changing a workflow — especially the *three layers*
section, which decides where a change belongs.

## This repo runs its own loop, on the last release

Five callers are installed in `.github/workflows/`, prefixed `agent-` so they do not collide by
filename with the reusable workflows they call. Job ids stay unprefixed — `self-check` is built from
job ids, not filenames, so `agent-review.yml` keeps `review / review`.

They use a **pinned remote** reference, `jeffwlawson/agent-workflows/...@v0.1.1`, rather than a
local `./` path. That is a deliberate choice with one decisive reason and one supporting one.

**The runner version is baked into the reusable workflow** (`npx …@<version>`, held equal to
`package.json` by a test), so the `uses:` ref selects the runner too. A pinned remote therefore
takes YAML and runner from the *same release*, always. A local `./` path takes YAML from the **base
branch** instead — and the moment `npm version` lands on `main`, that YAML names a version the
registry does not have yet. Every agent run in this repo would die at `npx` until the tag is pushed
and the publish finishes. A window that opens on every release.

**And a bad merge would break the loop you would use to fix it.** With a local path the base branch
supplies the workflow, so merging a broken reusable leaves no good version running. Pinned, a bad
merge is inert until you tag; the loop keeps working on the last good release while you repair
`main`.

The cost is real: **a change is not exercised by this repo's own loop until it is released.** That
is covered elsewhere — `npm run verify` and CI gate the working tree, and consuming repos exercise
the released loop. Dogfooding here answers "does the loop function end to end", not "does my
unreleased change work".

**Do not break the gate.** If `npm run verify` stops working, every agent run in every consuming
repo loses the instruction the prompts depend on.

## Changing a workflow

1. Decide the layer first (CONTEXT.md). A guard belongs in the **reusable** half — an adopter
   references that and gets fixes for free; anything in the caller has to be copied by hand.
2. Edit `.github/workflows/<name>.yml`. Never add a step to a caller.
3. If a caller must change too, update **both** sets: `examples/callers/` is what adopters copy,
   and `.github/workflows/agent-*.yml` is what this repo runs. `tests/workflows.test.ts` reads both
   — deliberately, so a change to one cannot silently leave the other behind.
4. `tests/workflows.test.ts` asserts over both halves. Add the assertion in the same change; a
   workflow defect has no unit test to catch it and usually no error message either.

## Changing a runner

1. `<name>/<name>.ts` for the logic, `<name>/prompt.md` for what the agent is told.
2. Shared helpers live in `shared/`. Anything reading a GitHub surface goes there, not in a runner.
3. Add tests under `tests/`, mirroring the source.
4. **Prompts name no domain.** No consuming repo's vocabulary, and never the gate command — say
   "the verify command `CLAUDE.md` names". A test enforces both over the runner surface.

## Releasing

Publishing is a **tag push**, and the version in the tag and in `package.json` must agree:

```bash
npm version patch          # or minor / major
git push && git push --tags
```

`v*` on a commit reachable from `main` triggers `publish.yml`. It refuses a tag on an unmerged
commit, and no-ops if the version is already on the registry.

Then **bump the pin in both caller sets** — `examples/callers/*.yml` and
`.github/workflows/agent-*.yml`. `PIN` in `tests/workflows.test.ts` is derived from `package.json`
and checked against both, so a release that leaves either behind fails the build by name. A stale
example is an adopter running last release's runners; a stale local caller is *this* repo running
them.

Bump the `npx …@<version>` line in the five reusable workflows too — a test holds it equal to
`package.json`, so the build tells you.

> **`bin` must never start with `./`.** `npm publish` silently drops such an entry and exits 0,
> producing a package whose commands cannot be run. `ci.yml` runs `npm publish --dry-run` and fails
> on the one log line that reveals it — `npm pack` does not reproduce it and neither does npm 10, so
> a local check will pass. See CONTEXT.md.

## Conventions

- **Runners take no arguments.** Input comes from the environment the workflow step sets; an
  argument is refused, not ignored.
- **A failure must write `OUTPUT_DIR/failure_reason.txt`** before the process ends, so the workflow
  can post something a human can act on. A bare `exit 1` produces `(no reason file written)`, which
  is indistinguishable from the module-resolution failure a stale branch gives — one signature, two
  causes, and the signature is the *absence* of information.

  `shared/common.ts`'s `required()` is a **known exception**: it `process.exit(1)`s on a missing
  env var without writing the file. It is the reason that string has been seen twice for unrelated
  reasons (`docs/friction.md`, 2026-08-08). Do not copy the pattern, and fix it as its own change
  rather than folding it into an unrelated one.
- TypeScript is strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. With
  the latter, build optional properties conditionally (`...(x === undefined ? {} : { x })`) rather
  than assigning `undefined`.
- Relative imports use the `.js` extension — NodeNext ESM, even in `.ts` source.
- Prefer `execFileSync` argv over shell strings for anything holding a variable. A git ref may
  legally contain `` ` ``, `$()`, `;`, `|` and `&`.
- Test files live in `tests/`, mirroring the source.
- `docs/friction.md` is a dated narrative log. Append; never rewrite an entry to match today.

## Line endings

Authored on Windows, executed on Linux CI. `.gitattributes` normalises everything to LF. Do not add
files that defeat it, and do not commit an `.editorconfig` that disagrees with it.

## Agent skills

Per-repo config for the `mattpocock/skills` engineering skills lives in `docs/agents/`. Only
[`ticket-shape.md`](./docs/agents/ticket-shape.md) is present — it is loop doctrine and is never
regenerated. The three files `/setup-matt-pocock-skills` writes (`issue-tracker.md`,
`triage-labels.md`, `domain.md`) are **not** here yet; run the skill to generate them rather than
writing them by hand, since regenerating overwrites.
