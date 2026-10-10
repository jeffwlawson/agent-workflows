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

See [CONTEXT.md](./CONTEXT.md). Read it before changing a workflow — especially the *three parts*
section, which decides where a change belongs.

## This repo runs its own loop, on the last release

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

## Changing a workflow

1. Decide the part first (CONTEXT.md). A guard belongs in a **command** of the package, run from
   the reusable: the reusable keeps only what Actions can do (ADR 0003), an adopter references
   both through the one pin and gets fixes for free, and anything in the caller has to be copied
   by hand. Only in a workflow whose steps have not moved yet, which CONTEXT.md's *three parts*
   names, does a guard still go in the reusable's YAML.
2. Put Actions-only changes (the job graph, permissions, artifacts, which step gets which token) in
   `.github/workflows/<name>.yml`, and everything else in the workflow's folder (*Changing a
   runner or a command*, below). Never add a step to a caller.
3. If a caller must change too, update **both** sets: `examples/callers/` is what adopters copy,
   and `.github/workflows/agent-*.yml` is what this repo runs. `tests/workflows.test.ts` reads both
   — deliberately, so a change to one cannot silently leave the other behind. The exception is a
   new secret or input: the reference caller moves with the reusable, and the local caller waits
   for the release that declares it (see *This repo runs its own loop*).
4. `tests/workflows.test.ts` asserts over both halves. Add the assertion in the same change; a
   workflow defect has no unit test to catch it and usually no error message either.
5. A **new** workflow is a reusable plus a caller of it in each caller set, all three carrying a
   version pin: the reusable file, and a job in the local and the reference caller file for its
   side (#225). `scripts/sync-version.ts` refuses the next release until each caller set calls
   every reusable exactly once. That refusal is the point: two of the three is a release that pins
   what it found.
6. A change to what the Actions orchestrator does with a runner's result is a change to that
   runner's `Actions orchestrator:` block in `docs/platform-spec.md`, in the same commit. Nothing
   checks it: the blocks are description, and no test reads them against the YAML.

## Changing a runner or a command

A **runner** starts the agent; a **command** does an orchestrator's work on the record and starts
none (ADR 0004). Both are subcommands, and the kind is declared: runners in `RUNNERS` and commands
in `COMMANDS`, in `shared/contract.ts`. `tests/agent-cli.test.ts` holds the CLI's `SUBCOMMANDS`
equal to the two maps, kind for kind, with `init` and `doctor` the only subcommands in neither.

1. A runner is `<name>/<name>.ts` for the logic, `<name>/prompt.md` for what the agent is told.
   It does its work when imported.
2. A command is `<workflow>:<step>`, at `<workflow>/<step>.ts`, and starts no agent. Its module
   exports one function taking its declared inputs; it reads no environment itself. `cli.ts` reads
   the inputs, calls the function, and turns a throw into `fail()`, so throw a sentence a person
   can act on. Only a command may declare `LOOP_TOKEN`: in a runner's declaration it is a type
   error.
   **A command loads nothing that loads the agent SDK.** The agent driver is `shared/agent.ts`,
   the one module under `shared/` that imports it; `tests/agent-cli.test.ts` walks each command's
   imports from `COMMANDS` and fails on reaching it, or on any module naming `GITHUB_OUTPUT`,
   `GITHUB_ENV`, `GITHUB_PATH` or `GITHUB_STEP_SUMMARY`: a value an adapter needs leaves a command
   as a declared output. So a helper that only reads GitHub or the environment never imports the
   driver, and a record string a command writes lives in `shared/record.ts`, which imports nothing.
3. **Folders follow the workflow** (ADR 0004). A workflow's folder, named after its reusable,
   holds its runner where it has one and every command that runs in its jobs. `shared/` holds
   only loop code two or more workflows use. The one folder drawn by layer is `engine/`, which
   ADR 0005 adds: the writer, the GitHub reader and marker splicing. It imports nothing from the
   loop, reads no environment and spells no record string, and `tests/engine/boundary.test.ts`
   fails on each. A command's tests use the fakes in `tests/engine/fakes.ts`.
4. Add tests under `tests/`, mirroring the source.
5. **Every input a runner or command reads is declared** in `shared/contract.ts`, required or
   optional with a default, and read through `readInputs`: at the top of a runner, and by `cli.ts`
   for a command. A helper is handed the values it needs as arguments and reads no environment.
   `shared/env.ts` is the one module in a runner, a command or `shared/` that names
   `process.env`, and `tests/agent-cli.test.ts` fails on any other.
   **Every file it writes into `OUTPUT_DIR` is declared there too**, as its outputs, and written
   through the `writers` that declaration gives it, so an undeclared name fails typechecking. A
   computed name is typed over a fixed set, and each name in the set is listed.
   **A command reads another subcommand's files through a directory input** (ADR 0006), declared
   with `readsFrom` and read with `readDirectory` (`shared/hand-over.ts`), once, before its first
   write. Each field is parsed as a target, a choice or a count, and free text comes out only as
   `Cleaned` (`shared/clean.ts`), the type a formatter takes. Any upload of those files is held to
   the declaration by `expectHandsOver` in `tests/workflows.test.ts`.
   **A new input is three parts, landed together**: its declaration there, its row in the runner's
   `### Inputs` table (or the command's `#### Inputs`) in `docs/platform-spec.md`, and, where it is
   required, the reusable's `env:` setting it, in the step or its job. `tests/platform-spec.test.ts`
   is red until all three are in; a new output file is the same, without the third. Where the
   reusable needs a new caller input or secret to set it, the two-step rule in *This repo runs its
   own loop* applies.
6. **A change to anything a runner reads from the record** (a marker, a status context, a trailer,
   a branch pattern, a trusted login) is a change to `docs/platform-spec.md` §4 in the same commit.
   Where TypeScript spells it, it spells it once, in `shared/record.ts`.
   Nothing checks it: YAML shell steps write those strings as well as TypeScript, with no one call
   shape a test could read, and the record is exactly what a second orchestrator trips on.
7. **Prompts name no domain.** No consuming repo's vocabulary, and never the gate command — say
   "the verify command `CLAUDE.md` names". A test enforces both over the runner surface.

## Releasing

Publishing is a **tag push**, and the version in the tag and in `package.json` must agree:

```bash
npm version patch          # or minor / major
git push --follow-tags
```

`v*` on a commit reachable from `main` triggers `publish.yml`. It refuses a tag on an unmerged
commit, and no-ops if the version is already on the registry.

**That first command is the whole release.** The version appears in twelve files and `npm
version` bumps two of them; `scripts/sync-version.ts` writes the other ten — the `npm exec`
pin of each step that runs the package (fourteen: one in each of the six reusable workflows, and
`review:gate`, `review:budget`, `review:collect-checks`, `review:red-check-place`, `review:red-check-classify`,
`review:publish`, `review:conclude` and `review:advance` beside the runner in `review.yml`), the
`npm install` pin of
the step that installs it ahead of the red check's two (one, in `review.yml`), the `uses:` ref of
each caller in the two caller files
of each of the two caller sets, and the `uses:` ref a reusable's step names a composite action in
`.github/actions/` with (eight of those: `loop-token` once in each of `implement.yml`, `fix.yml`
and `update-branch.yml`, twice in `implement-prd.yml` and three times in `review.yml`, so
thirty-five pins in the ten files). It
runs from the `version` lifecycle script, which npm fires *after* the manifest is bumped and
*before* the commit is made, so everything it stages lands in the same `v<version>` commit. It
stages **by path** — the ten it wrote, never `-A`: npm's dirty-tree check passes untracked
files, so `-A` would carry a stray one into the tag `publish.yml` fires on, and nothing here would
see it. It propagates and never decides: the version is read from `package.json`, never passed in,
and nothing there commits or tags — `npm version` does both, and a second tagging path is a second
way to publish.

It refuses to run anywhere but the tip of origin's default branch — on that branch, at the commit
origin has, asked of origin rather than of a possibly stale `origin/main`. `publish.yml` refuses an
unmerged tag too, but only after the push; v0.7.9 was first cut in a worktree one merge behind.

It refuses rather than doing part of the job. Both caller sets must hold the same caller files,
each set must call every reusable exactly once, and each file must carry exactly the pins expected
of it, one recognisable pin per site, so a seventh workflow whose caller is missing from either
set, or a caller file missing from either, stops the release instead of quietly propagating to
what it found. A step naming a composite action, and a caller naming a reusable workflow, is
counted by its path, not by its pin, so one named under a ref that is not a pin is refused rather
than skipped.

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

The release also ships the dependency tree it was tested with, inside the package (#430): every
runtime dependency is listed in `bundleDependencies`, so `npm pack` puts the tree `npm ci` built
from `package-lock.json` under the tarball's own `node_modules`, and npm installs it from there as
it is. Not a shrinkwrap, which #414 tried: npm reads a dependency's `npm-shrinkwrap.json` only when
the registry's metadata sets `_hasShrinkwrap`, and GitHub Packages never sets it, so the file shipped
and was never read. The lockfile stays the one copy. `scripts/bundled-tree.ts`, run from source and
excluded from the build like `sync-version.ts`, holds a package's bundled tree to the lockfile's
runtime entries, version for version, with no dev package: `tests/bundled-tree.test.ts` runs it on a
pack and an install of that pack, and `publish.yml` runs it on the pack before publishing and on the
release installed through `npm exec` after. The same test fails, naming the package, on a runtime
dependency with an install script or an `os` or `cpu` field: bundling builds the tree once, on the
publishing runner, so adding one is a decision to make on purpose.

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
local callers and never `examples/callers/` or the `npm exec` lines, and its PR stays red until you
move those by hand.

Changing what a pin looks like — a new workflow, a renamed one, a different invocation — is a
change to `shared/pins.ts` and `tests/pins.test.ts` in the same commit, and to
`scripts/sync-version.ts` and its tests if the *set* of sites changed too. `shared/pins.ts` knows
four forms, `@<version>` for the npm spec `npm exec` takes, `@<version>` for the one `npm install`
takes (#422), `@v<version>` for a caller's `uses:` ref to a reusable workflow, and `@v<version>`
for a reusable's `uses:` ref to a composite action in `.github/actions/` (#257), and a fifth would
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
so a `setup/setup.ts` would quietly enrol these two in every rule written for the runners.

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

- **Runners and commands take no arguments.** Input comes from the environment the workflow step
  sets; an argument is refused, not ignored. `init` and `doctor` are the exception and are not runners: they
  are typed by a human, so `--dir <path>` is the interface rather than a misunderstanding of it. An
  option they do not know is still refused.
- **A failure must write `OUTPUT_DIR/failure_reason.txt`** before the process ends, so the workflow
  can post something a human can act on. A bare `exit 1` produces "It stopped without giving a
  reason." (`(no reason file written)` before #253), which is indistinguishable from the
  module-resolution failure a stale branch gives: one signature, two causes, and the signature is
  the *absence* of information.

  A missing required input was the known exception and is no longer one (#88): the accessor
  (`readInputs` in `shared/env.ts`, which replaced `required()`) exits through `fail()`, so the run
  that dies at module scope — before any of a runner's own work — still names the input it wanted.
  That is the case the convention is hardest to keep and most needed, since nothing else has
  happened yet for a human to read.

  One cause of the string survives and is not fixable from here: a step that fails *before* the
  runner exists to write anything, which is where `CONTEXT.md`'s note on the toolchain-free auth
  step points. So it now means "the run never got as far as the runner", rather than that plus a
  missing input.

  `OUTPUT_DIR` itself is the one input that cannot report through the file. With it unset the
  writer writes nothing, for every caller, and stderr is the whole report: no `/tmp` fallback.
  A runner checks it at start with the other inputs every runner reads (`readInputs` over
  `shared/contract.ts`), so in practice only `doctor` and the CLI's refusals, run by hand, meet it.
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
- **A test runs a subcommand through `tests/cli-inputs.ts`** (#428), which sets the inputs the test
  gives and unsets the subcommand's other declared inputs for the run, so a forgotten input fails
  on the build agent's runner as it does on CI's clean one. A test file that runs the CLI writes
  `process.env` nowhere else; `tests/agent-cli.test.ts` fails on one that does.
- **A test that spawns synchronously bounds the spawn itself**, at `SUBPROCESS_TIMEOUT` from
  `vitest.config.ts` — the same figure that file gives the suite as `testTimeout`. vitest's timeout
  cannot interrupt a synchronous spawn, so the setting is a flake guard for cold starts and the
  spawn's own `timeout` is what ends a hang.
- **The figure is imported, never repeated**, and that is checked rather than asked for:
  `tests/vitest-config.test.ts` fails if any file under `tests/` writes the number out. #144 and
  #145 each wrote their own copy in the same week, equal by coincidence, neither branch able to see
  the other's — prose said "imported" and nothing read it. The suite-wide ceiling is **one spawn's
  worth**, so a test making one needs no `it()` timeout of its own; a test making several raises
  its ceiling to a multiple of the same figure (`tests/sync-version.test.ts`'s `ceiling`), because
  a ceiling under the sum of its children's bounds fails while every one of them is still inside
  its own. That raise hides no hang — the spawn's bound still fires first, and the spawn is what
  reports it.
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
Before writing a brief, `/triage` checks other issues, open PRs and work in flight for overlap: see
[*Before a brief*](./docs/agents/issue-tracker.md#before-a-brief-overlap-with-other-work).

### Triage labels

The five canonical triage roles at their default strings, kept as a **second vocabulary** beside
`agent:*` workflow state rather than merged into it; the one join, `ready-for-agent` →
`agent:implement`, stays a human hand. Also the only definition of the `wayfinder:*` planning
labels, which two workflows refuse and nothing else describes. See
[`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md).

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](./docs/agents/domain.md).

## Asking me to decide

**In a session with me in it.** A CI runner has no channel to ask: it decides, and records the
decision in the surface its prompt gives it — a commit message, a review finding, a top-level
comment. Same shape the prompts already use for a follow-up issue: say what the question was and
what you chose, and stop there.

- **Lead with the stake** — one sentence on what changes depending on my answer. Where nothing
  changes, decide it and tell me what you decided.
- **The question is sentence two**, then at most three sentences of body. Supporting evidence goes
  after the question, where I can skip it.
- **One recommendation, one reason.**
- **Go long when the reasoning is the finding** — a risk I would miss if you compressed it — and
  say that is why.

## When a message doesn't land

Also a session with me in it. When I say something is over my head, re-pitch it in plain English.
