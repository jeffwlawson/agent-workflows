# Changing a workflow

1. Decide the part first (CONTEXT.md). A guard belongs in a **command** of the package, run from
   the reusable: the reusable keeps only what Actions can do (ADR 0003), an adopter references
   both through the one pin and gets fixes for free, and anything in the caller has to be copied
   by hand. Only in a workflow whose steps have not moved yet, which CONTEXT.md's *three parts*
   names, does a guard still go in the reusable's YAML.
2. Put Actions-only changes (the job graph, permissions, artifacts, which step gets which token) in
   `.github/workflows/<name>.yml`, and everything else in the workflow's folder
   ([*Changing a runner or a command*](./changing-a-runner-or-a-command.md)). Never add a step to a caller.
3. If a caller must change too, update **both** sets: `examples/callers/` is what adopters copy,
   and `.github/workflows/agent-*.yml` is what this repo runs. `tests/workflows.test.ts` reads both
   — deliberately, so a change to one cannot silently leave the other behind. The exception is a
   new secret or input: the reference caller moves with the reusable, and the local caller waits
   for the release that declares it (see [*This repo runs its own loop*](../adr/0010-this-repo-runs-its-own-loop-on-the-last-release.md),
   ADR 0010).
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
