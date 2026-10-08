---
status: accepted
date: 2026-10-07
---

# A command is runner-shaped, and lives in its workflow's folder

[ADR 0003](./0003-reusable-keeps-what-only-actions-can-do.md) moves every step that reads or changes
the PR or issue into the package. That makes a third kind of subcommand beside the runners and the
install path: a **command**, which does an orchestrator's work on the record and starts no agent
(#396). This records its shape and where its code goes.

**A command is invoked the way a runner is.** It is `agent-workflows <workflow>:<step>`, with no
arguments. Its whole input is the environment, declared in `shared/contract.ts` and read through
`readInputs`, and it fails through `fail()` and `failure_reason.txt` with the runner's exit codes.
The contract is what lets an orchestrator build a subcommand's environment without loading it, and
an argument would be an input channel the contract cannot declare. Flags stay with `init` and
`doctor`, which a human types. `follow-ups` has already proved the shape: it runs no model, holds a
write token, and reads only declared environment. So it is reclassified as a command and renamed
`follow-ups:file`.

**The kind is declared, not inferred.** `shared/contract.ts` holds two maps, `RUNNERS` and
`COMMANDS`. An orchestrator imports that file, and the kind tells it which subcommand gets which
credential. It cannot see the package's folders.

**A command is a function.** Its module exports one, and `cli.ts` reads the declared inputs, calls
it, and turns a thrown failure into `fail()`. A runner does its work when it is imported, which no
process can do twice. The end state calls the phases in order in one process, and a function is
what allows that and lets a test call a command without spawning it.

**The write token reaches commands only.** A command that writes declares `LOOP_TOKEN` and
`LOOP_TOKEN_SOURCE` beside `GH_TOKEN`, and picks a token per write. Three checks hold it, each
seeing what the others cannot:
- the compiler refuses `LOOP_TOKEN` in a runner's declaration;
- a test fails where a command's imports reach the agent driver;
- `tests/workflows.test.ts` keeps the token's mint out of every job that runs a runner.

**A command reads another subcommand's files through a declared directory input.** Every
invocation gets its own fresh `OUTPUT_DIR`. A command reads the runner's files through typed
readers built from that runner's declared outputs, the mirror of `writers`, so a renamed output is
a type error rather than a broken live run. Which files cross is #398's.

**Folders follow the workflow.** A folder holds one workflow's package code, named after its
reusable: its runner where it has one, and every command that runs in its jobs. Review's `advance`
goes in `review/` because it runs in `review.yml`, though it changes the PRD chain's parent.
`follow-ups/` is a workflow folder with no runner. The one folder drawn by layer is `engine/`,
because ADR 0002's rule runs along it: engine code imports nothing from loop code. `shared/` keeps
only loop code that two or more workflows use. This replaces `CLAUDE.md`'s "anything reading a
GitHub surface goes in `shared/`". That rule kept GitHub code out of runners that run on import,
and commands as functions plus `engine/` now do that job.

**The spec follows the same split.** `docs/platform-spec.md` §2 covers every subcommand and says
once where a command differs from a runner. Each workflow's section lists its commands after its
runner, with `### Inputs` and `### Outputs` tables held by `tests/platform-spec.test.ts`.

## Considered options

- **Commands take arguments**, such as `publish --runner review`. Rejected: a second input channel
  the contract cannot declare, for a subcommand no human types.
- **A `commands/` folder**, the way oclif finds commands by scanning `src/commands/`. Rejected: a
  command changes together with the runner whose outputs it reads, and the folder would be a
  second registry beside the contract. gh-aw keeps its write handlers flat beside its other scripts
  and lists them in a hand-written map (`HANDLER_MAP` in `safe_output_handler_manager.cjs`).
  Sandcastle registers its CLI commands explicitly in one `cli.ts`, and draws folders only where a
  seam or an import rule runs: `sandboxes/` for the adapters behind one interface, and
  `templates/<name>/` for self-contained workflows that may import only the package's public
  exports (Sandcastle's ADR 0009).
- **Infer the kind from file layout**, as the build infers a runner from `<name>/<name>.ts`.
  Rejected: an orchestrator cannot see the layout, and every command already has a contract entry.
- **Keep `follow-ups` a runner, or keep its bare name as a command.** Rejected: either way the name
  or the file shape would say "runner" for one command, and the tests would carve it out by name.

## Consequences

- `cli.ts`'s `Command` interface becomes `Subcommand`, and its `COMMANDS` table of every
  subcommand becomes `SUBCOMMANDS`, so *command* means only the new kind and the one `COMMANDS`
  export is the contract's. `shared/contract.ts`'s `CONTRACT` map becomes `RUNNERS` beside it.
- `follow-ups` moves to `follow-ups/file.ts` as `follow-ups:file`, and spec §11 becomes a command
  section with no runner above it.
- The review-only modules in `shared/` move into `review/` with review's PRD. The other workflows'
  modules move with theirs.
- `CLAUDE.md`'s *Changing a runner* gains commands, and its `shared/` rule changes, when the first
  command lands.
