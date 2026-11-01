# Changing a runner or a command

A **runner** starts the agent; a **command** does an orchestrator's work on the record and starts
none (ADR 0004). Both are subcommands, and the kind is declared: runners in `RUNNERS` and commands
in `COMMANDS`, in `shared/contract.ts`. `tests/agent-cli.test.ts` holds the CLI's `SUBCOMMANDS`
equal to the two maps, kind for kind, with the install path (`init` and `doctor`) and the service
orchestrator's processes (`dispatcher` and `worker`) the only subcommands in neither. A service process takes no
arguments either: its settings are declared in `service/settings.ts`, read through `readInputs`,
and listed in `docs/deploying-the-service.md`, which `tests/service/settings.test.ts` holds equal to
the declaration.

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
   ADR 0005 adds: the writer, the GitHub reader and marker splicing, and the `bwrap` sandbox
   provider, which only the agent driver imports, since it loads the agent SDK. It imports nothing
   from the loop, reads no environment and spells no record string, and `tests/engine/boundary.test.ts`
   fails on each. A command's tests use the fakes in `tests/engine/fakes.ts`.
4. Add tests under `tests/`, mirroring the source.
5. **Every input a runner or command reads is declared** in `shared/contract.ts`, required or
   optional with a default, and read through `readInputs`: at the top of a runner, and by `cli.ts`
   for a command. A helper is handed the values it needs as arguments and reads no environment.
   `shared/env.ts` is the one module in a runner, a command, `shared/` or `service/` that names
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
