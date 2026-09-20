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

They use a **pinned remote** reference, `jeffwlawson/agent-workflows/...@v<tag>`, rather than a
local `./` path. The tag is not written out here on purpose — prose is the one copy of it no test
reads, and it sat two releases behind before anyone noticed. The five callers carry the live pin
and are checked against `package.json`; read it there.

That is a deliberate choice with one decisive reason and one supporting one.

**The runner version is baked into the reusable workflow** (`npm exec …@<version>`, held equal to
`package.json` by a test), so the `uses:` ref selects the runner too. A pinned remote therefore
takes YAML and runner from the *same release*, always. A local `./` path takes YAML from the **base
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
5. A **new** workflow is three files carrying a version pin — the reusable, the local caller and
   the reference caller — and `scripts/sync-version.ts` refuses the next release until all three
   exist. That refusal is the point: two of the three is a release that pins what it found.

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
git push --follow-tags
```

`v*` on a commit reachable from `main` triggers `publish.yml`. It refuses a tag on an unmerged
commit, and no-ops if the version is already on the registry.

**That first command is the whole release.** The version appears in seventeen files and `npm
version` bumps two of them; `scripts/sync-version.ts` writes the other fifteen — the `npm exec`
pin in each of the five reusable workflows, and the `uses:` ref in each of the two caller sets. It
runs from the `version` lifecycle script, which npm fires *after* the manifest is bumped and
*before* the commit is made, so everything it stages lands in the same `v<version>` commit. It
stages **by path** — the fifteen it wrote, never `-A`: npm's dirty-tree check passes untracked
files, so `-A` would carry a stray one into the tag `publish.yml` fires on, and nothing here would
see it. It propagates and never decides: the version is read from `package.json`, never passed in,
and nothing there commits or tags — `npm version` does both, and a second tagging path is a second
way to publish.

It refuses rather than doing part of the job. All fifteen sites must exist and each must carry
exactly one recognisable pin, so a sixth workflow whose caller or example is missing stops the
release instead of quietly propagating to fifteen of eighteen.

A refusal leaves no commit and no tag, but it does leave the **manifest and lockfile bumped** in
the working tree — npm writes those before the hook runs and does not roll them back. Undo them
before you retry, or the retry dies on npm's dirty-tree check instead of on the fault you were
fixing:

```bash
git checkout -- package.json package-lock.json
```

The commit's message is `.npmrc`'s `message=v%s`, the `v` matching the tag `publish.yml` fires on.
That is the whole file: the registry and the token live in the `.npmrc` `actions/setup-node` writes
under `RUNNER_TEMP`, and a second copy of the scope here is a second place for it to be wrong.

The checks that made this a chore rather than a hazard are still the backstop, and are what a
rewrite gone wrong lands on: `PIN` in `tests/workflows.test.ts` is derived from `package.json` and
checked against **both caller sets** — `examples/callers/*.yml` and `.github/workflows/agent-*.yml`
— so a release that leaves either behind fails the build by name. A stale example is an adopter
running last release's runners; a stale local caller is *this* repo running them.

`.github/dependabot.yml` is **not** the mechanism for that bump, and is not installed here for the
loop pins at all — `PIN` already holds both caller sets to `package.json`, so they cannot go stale.
It is here for the ordinary action pins (`actions/checkout` and friends), which nothing else tracks;
it exists as a documented adoption step because an adopter has no test that can see their pin
(`docs/ADOPTING.md` §4, which holds the one copy of the config).

Its `agent-loop` group should therefore never open a pull request here, and one that does is a
second signal that a release step was missed — it reads `.github/workflows` only, so it moves the
five callers and never `examples/callers/` or the `npm exec` lines, and its PR stays red until you
move those by hand.

Changing what a pin looks like — a new workflow, a renamed one, a different invocation — is a
change to `shared/pins.ts` and `tests/pins.test.ts` in the same commit, and to
`scripts/sync-version.ts` and its tests if the *set* of sites changed too. `shared/pins.ts` knows
two forms, `@<version>` for the npm spec and `@v<version>` for the `uses:` ref, and a third would
be a site it skips.

The split is not cosmetic. `shared/pins.ts` is the rewrite itself and **ships**, because `init`
(#6) performs the same rewrite into an adopter's tree; `scripts/sync-version.ts` is the release
policy around it and is excluded from the tarball. That exclusion holds only while nothing built
imports the script — `tsc` emits an excluded file the moment something pulls it in — so put shared
code in `shared/`, never in `scripts/`. A test in `tests/sync-version.test.ts` asserts it.

> **`bin` must never start with `./`.** `npm publish` silently drops such an entry and exits 0,
> producing a package whose commands cannot be run. `ci.yml` runs `npm publish --dry-run` and fails
> on the one log line that reveals it — `npm pack` does not reproduce it and neither does npm 10, so
> a local check will pass. See CONTEXT.md.

## Changing the install path

`setup/` is `init` and `doctor` — the half a human runs, in somebody else's checkout. It is
deliberately **not** shaped like a runner: a runner is `<name>/<name>.ts` plus a prompt and takes no
arguments, and the walk in `tests/agent-cli.test.ts` derives "the runners" from exactly that shape,
so a `setup/setup.ts` would quietly enrol these two in every rule written for the other five.

1. `setup/callers.ts` is the half both use — reading a caller out of an adopter's tree. A caller is
   recognised by **what it calls**, never by its filename: adopters rename files and job ids, and a
   re-run that does not find theirs writes a second copy beside it.
2. `init` copies `examples/callers/`; it does not generate. A generator is a second description of a
   caller, and the release after it drifts is one where an adopter installs a file nothing tested.
   It copies **once**: a caller already installed has its pin moved in the adopter's own text and
   nothing else touched, and one they do not have is named rather than written back. A caller is
   what an adopter owns, so a re-run that re-copied would silently revert their `with:` inputs,
   their job id and their extra permissions — the silent-failure class this command exists to
   remove. Drift in the caller *body* is `doctor`'s to report, not `init`'s to overwrite.
3. The rewrite is `shared/pins.ts` — the same one the release performs. See *Releasing*.
4. `doctor` is two halves: `gatherFacts` asks `gh` what a checkout cannot answer, and `diagnose`
   rules on callers and facts and nothing else. Keep the second one pure — every check is exercised
   through it, and an unreadable fact must stay `undefined` rather than collapsing into a pass.
   "No secrets are set" and "you are not an admin here" lead to opposite actions.
5. `diagnose` rules on a **fixed list**, and nothing diffs an adopter's caller against
   `examples/callers/`. So a release that changes a caller *body* — a new `with:` input, a changed
   trigger, another grant — is a change to `diagnose` in the same commit, the way a new pin site is
   a change to `shared/pins.ts` in the same commit. Neither half carries it otherwise, and a re-run
   of `init` reports `unchanged` on a caller that is now wrong.
6. `examples/callers/*.yml` and `setup/SETUP.md` are **assets**: `scripts/copy-assets.ts` puts them
   under `dist/` at the same relative path, exactly as it does a prompt, because `tsc` emits `.js`
   and nothing else. An asset that is not copied resolves in a checkout and is absent from the
   tarball — a failure only a published version shows.

## Conventions

- **Runners take no arguments.** Input comes from the environment the workflow step sets; an
  argument is refused, not ignored. `init` and `doctor` are the exception and are not runners: they
  are typed by a human, so `--dir <path>` is the interface rather than a misunderstanding of it. An
  option they do not know is still refused.
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
- Relative imports use the `.js` extension — NodeNext ESM, even in `.ts` source. The one
  exception is `scripts/sync-version.ts`, which is **run from source and never emitted**: `npm
  version` executes it through Node's type stripping, and Node resolves a relative specifier
  literally rather than mapping `.js` back to `.ts`. It names `../shared/pins.ts` for that reason.
  `allowImportingTsExtensions` is on in `tsconfig.json` and back off in `tsconfig.build.json`, so
  the same spelling in a file that ships fails the build — and `tests/sync-version.test.ts` runs
  that build's typecheck, so it fails the gate too rather than only CI.
- Prefer `execFileSync` argv over shell strings for anything holding a variable. A git ref may
  legally contain `` ` ``, `$()`, `;`, `|` and `&`.
- Test files live in `tests/`, mirroring the source.
- `docs/friction.md` is a dated narrative log. Append; never rewrite an entry to match today.

## Line endings

Authored on Windows, executed on Linux CI. `.gitattributes` normalises everything to LF. Do not add
files that defeat it, and do not commit an `.editorconfig` that disagrees with it.

## Agent skills

Per-repo config for the `mattpocock/skills` engineering skills lives in `docs/agents/`. The three
files below were **generated** by `/setup-matt-pocock-skills` and then hand-extended — edit them
directly, and do not re-run the skill to change one: it rewrites each file with its own defaults,
and `triage-labels.md` would lose everything below its mapping table (`docs/ADOPTING.md` §4).
[`ticket-shape.md`](./docs/agents/ticket-shape.md) is the exception: loop doctrine, hand-written,
never regenerated.

### Issue tracker

GitHub Issues in this repo, via the `gh` CLI, with **native** sub-issue and blocking relations —
prose in an issue body is invisible to every workflow here. See
[`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).

### Triage labels

The five canonical triage roles at their default strings, kept as a **second vocabulary** beside
`agent:*` workflow state rather than merged into it; the one join, `ready-for-agent` →
`agent:implement`, stays a human hand. Also the only definition of the `wayfinder:*` planning
labels, which two workflows refuse and nothing else describes. See
[`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md).

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](./docs/agents/domain.md).
