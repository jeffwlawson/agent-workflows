# CLAUDE.md

## Commands

```bash
npm run verify   # typecheck + test. The gate: it must pass before you finish.
```

CI runs it, plus a build and a packaging guard that `verify` cannot cover:
[*Releasing*](./docs/agents/releasing.md).

A change to the review or fix prompt is measured by hand with the golden-PR evals in `evals/`
(`node scripts/eval-prompts.ts`, #617), under the protocol in `evals/README.md` (#717): a primary
grader and guards declared first, both arms in one `ab` session, its comparison in the pull
request, which CI checks is there (`prompt-evals.yml`, #718). The evals cost real money and are in
neither `verify` nor CI; see [`evals/README.md`](./evals/README.md). `verify` holds only their
layout.

## Domain

See [CONTEXT.md](./CONTEXT.md): read its Glossary, then the *three parts* section before changing a
workflow; that section decides where a change belongs.

## Read before a change of this kind

Read the file for your kind of change before you edit; it holds the steps, and the tests it names
are what fail when one is skipped.

- **Changing a reusable workflow or a caller** (`.github/workflows/`, `examples/callers/`):
  [*Changing a workflow*](./docs/agents/changing-a-workflow.md).
- **Adding or changing a runner or a command**, an input, an output file, or anything a runner
  reads from the record:
  [*Changing a runner or a command*](./docs/agents/changing-a-runner-or-a-command.md).
- **Cutting a release, or changing a pin** (`npm exec`, `npm install` or `uses:` versions,
  `shared/pins.ts`, `scripts/sync-version.ts`, `publish.yml`, bundled dependencies):
  [*Releasing*](./docs/agents/releasing.md).
- **Changing `init` or `doctor`** (`setup/`):
  [*Changing the install path*](./docs/agents/changing-the-install-path.md).
- **Changing a local caller's pin or interface, or asking why this repo runs the last release**:
  [*This repo runs its own loop, on the last release*](./docs/adr/0010-this-repo-runs-its-own-loop-on-the-last-release.md)
  (ADR 0010).
- **Triaging, writing a brief, or editing `docs/agents/` or `skills/`**:
  [*Agent skills*](./docs/agents/agent-skills.md).

## Conventions

- **Runners and commands take no arguments.** Input comes from the environment the workflow step
  sets; an argument is refused, not ignored. `init` and `doctor` are the exception and are not runners: they
  are typed by a human, so `--dir <path>` is the interface rather than a misunderstanding of it. An
  option they do not know is still refused.
- **A failure writes `OUTPUT_DIR/failure_reason.txt`** before the process ends (through `fail()`;
  `readInputs` does it for a missing input), so the workflow can post something a human can act
  on. A bare `exit 1` posts "It stopped without giving a reason.", which a stale branch's
  module-resolution failure posts as well. `OUTPUT_DIR` itself cannot report this way: with it
  unset stderr is the whole report.
- **A change an adopter must act on carries an `Adopter-Action: <one imperative sentence: what to
  do, and where>` trailer** (#621) at the start of its own line in the commit message;
  [*Releasing*](./docs/agents/releasing.md) says what counts.
- With `exactOptionalPropertyTypes`, build optional properties conditionally
  (`...(x === undefined ? {} : { x })`) rather than assigning `undefined`.
- Relative imports use the `.js` extension (NodeNext), except in `scripts/sync-version.ts`, which
  is run from source and names `../shared/pins.ts`.
- Prefer `execFileSync` argv over shell strings for anything holding a variable. A git ref may
  legally contain `` ` ``, `$()`, `;`, `|` and `&`.
- **A test that spawns synchronously bounds the spawn** at `SUBPROCESS_TIMEOUT`, imported from
  `vitest.config.ts` and never written out (`tests/vitest-config.test.ts` fails on a copy; the
  config's comment has the reasoning). A test that runs a subcommand does it through
  `tests/cli-inputs.ts` and writes `process.env` nowhere else.
- `docs/friction.md` is a dated narrative log. Append; never rewrite an entry to match today.

## Line endings

`.gitattributes` makes every file LF; do not add a file that defeats it, or commit an
`.editorconfig` that disagrees with it.

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
