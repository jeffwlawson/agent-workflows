# CLAUDE.md

## Commands

```bash
npm run verify      # typecheck + test. This is the gate — it must pass before you finish.
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run build       # tsc + copy prompts into dist/
```

`npm run verify` is the single command that matters. CI runs it, plus a build and a packaging guard
that `verify` cannot cover; see [*Releasing*](./docs/agents/releasing.md).

A change to the review or fix prompt is measured by hand with the golden-PR evals in `evals/`
(`node scripts/eval-prompts.ts`, #617): a before run and an after run, same cases, runs and model,
both reports in the pull request. They cost real money and are in neither `verify` nor CI; see
[`evals/README.md`](./evals/README.md). `verify` holds only their layout.

## Domain

See [CONTEXT.md](./CONTEXT.md). Read it before changing a workflow — especially the *three parts*
section, which decides where a change belongs.

## Read before a change of this kind

Each topic below is in its own file, loaded only when it is read. Read the one your change is
before you edit; it holds the steps, and the tests it names are what fails when one is skipped.

- **Changing a reusable workflow or a caller** (`.github/workflows/`, `examples/callers/`): read
  [*Changing a workflow*](./docs/agents/changing-a-workflow.md).
- **Adding or changing a runner or a command**, an input, an output file, or anything a runner
  reads from the record: read
  [*Changing a runner or a command*](./docs/agents/changing-a-runner-or-a-command.md).
- **Cutting a release, or changing a pin** (`npm exec`, `npm install` or `uses:` versions,
  `shared/pins.ts`, `scripts/sync-version.ts`, `publish.yml`, bundled dependencies): read
  [*Releasing*](./docs/agents/releasing.md).
- **Changing `init` or `doctor`** (`setup/`): read
  [*Changing the install path*](./docs/agents/changing-the-install-path.md).
- **Changing a local caller's pin or interface, or asking why this repo runs the last release**:
  read [*This repo runs its own loop, on the last release*](./docs/adr/0010-this-repo-runs-its-own-loop-on-the-last-release.md)
  (ADR 0010).
- **Triaging, writing a brief, or editing `docs/agents/` or `skills/`**: read
  [*Agent skills*](./docs/agents/agent-skills.md).

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
