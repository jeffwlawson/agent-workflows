# CONTEXT.md

The domain model. Read this before changing anything; [CLAUDE.md](./CLAUDE.md) has the commands and
the conventions, [README.md](./README.md) is for people installing the package, and
[docs/ADOPTING.md](./docs/ADOPTING.md) is for people installing the loop.

## What this is

A **GitHub Actions agent loop**: a labelled issue becomes a reviewed pull request with no human in
the middle. One workflow per label transition, near enough:

| Label | Fires | Does |
|---|---|---|
| `agent:implement` on an **issue** | `implement` or `implement-prd` | branch, implement, open a draft PR, request review |
| `agent:review` on a **PR** | `review` | wait for CI, review the diff, mark ready |
| `agent:fix` on a **PR** | `fix` | act on review feedback, reply, resolve threads |
| `agent:update-branch` on a **PR** | `update-branch` | merge the base branch in, resolve conflicts |
| `agent:follow-ups` on a **merged PR** | `follow-ups` | file the out-of-scope findings its review recorded, as `needs-triage` stubs |

`implement` and `implement-prd` share one label and partition on **issue shape**: a parent with
sub-issues goes to the PRD chain, everything else to the single-issue run. The chain works one
sub-issue per run onto one branch, and re-adds its own label to advance.

`follow-ups` is the row that is not quite a label transition. The **merge** is what fires it and
the label is a marker it reads — re-adding that label to a closed PR is a manual entry point rather
than the normal path — and it is the one workflow an adopter can decline by not copying its caller
(`docs/ADOPTING.md` §4). It is also the only one that runs **no model**: the review agent records
the findings and cannot file them, and the workflow holding `issues: write` decides what to file
with a pure function (`docs/parity.md` §10).

## The three layers, and what belongs in each

This is the distinction to get right, because a change put in the wrong layer either cannot be
tested or cannot be fixed for an adopter without them editing a file.

```
consumer repo                    this repo
─────────────                    ─────────
.github/workflows/agent-*.yml    .github/workflows/<name>.yml     <name>/*.ts + prompt.md
  the CALLER                       the REUSABLE workflow            the RUNNER
  a trigger and two wires          every guard and every step       the agent's actual work
```

**The caller** is what an adopter owns: the trigger, the permissions grant, the secrets, and
`self-check`. It is deliberately tiny — anything an adopter can get wrong is something that drifts
across repos. Reference copies live in [`examples/callers/`](./examples/callers/) and are under
test.

**The reusable workflow** holds everything that bounds what a wrong run can do: the fork guard, the
permissions ceiling, the concurrency group, the preflight refusals. An adopter *references* it, so
a fix reaches them without them touching anything.

**The runner** is TypeScript plus a prompt, invoked as one subcommand of one published binary. It
takes its whole input from the environment; passing an argument is refused rather than ignored.

### And the install path, which is none of the three

`init` and `doctor` (`setup/`) are two more subcommands of the same binary, run by a human rather
than by a workflow. They are not a fourth layer so much as the thing that *puts* the first one in
place and then checks it: `init` copies the reference callers in with the pin substituted, and
`doctor` looks for the failures `docs/ADOPTING.md` §1 is about — every one of which is a condition
with no runtime symptom, which is why looking has to be deliberate.

The boundary between them follows the one above: the caller is the adopter's, so a re-run of `init`
moves the pin in the files they have and changes nothing else about them. What a later release
changed *inside* a caller is `doctor`'s to name, with the fix, rather than `init`'s to overwrite —
a scaffolder that silently reverted a `with:` input would be manufacturing exactly the failure
class the pair exists to remove.

`doctor` names it only where it was taught to. `diagnose` rules on a **fixed list** — every grant
the job a caller calls spends, an absent `permissions:` block, the `AGENT_PAT` wire, the pin's shape
and its freshness, `self-check`, the labels — and reads nothing out of `examples/callers/`, so a
release that changes a caller *body* is a release that teaches `diagnose` about it in the same
commit, exactly as a new pin site is a change to `shared/pins.ts` in the same commit. Diffing an
adopter's caller against the reference is the other design and it is the wrong one here: most of
what differs is a decision they made, and a preflight that reported those as faults would be read
for about one release.

They ship in the same package as the runners on purpose. The version that writes a pin has to be the
version that pin names, and the version that diagnoses a loop has to be the one whose guards it
knows about; a separate installer is a second thing to keep in step with the release.

### Why reusable workflows and not a composite action

A composite action cannot declare `on:`, `permissions:`, `concurrency:` or a job-level `if:` —
which is every security control here, and **the fork guard is a job-level `if:`**. An action could
have absorbed checkout → node → install and left the controls to be copy-pasted per repo, which is
exactly how they drift.

## The trust boundary

`pull_request_target` is the load-bearing trigger, and it is a fork-code-execution path on a public
repo: it runs with repo secrets and write access. Three things close it, and none is cosmetic.

1. **The fork guard** — `head.repo.full_name == github.repository` as a job-level `if:`, in the
   *reusable* half. A caller can skip the job; it cannot loosen the guard. `actions/checkout`
   refuses a fork head under `pull_request_target` on its own too, so the guard holds twice — but
   only where the step passes an explicit `ref:`, which makes the second half a property of *this
   step* as much as of the version: the action skips its check on a default self-checkout, GitHub
   having resolved that ref itself. A test asserts the `ref:` alongside the `if:`. Not something the
   `@v7` bump bought, either — the refusal was backported into `v6.1.0`, `v5.1.0` and `v4.4.0`, and
   `@v4` floats to the last of those. What matters here is the opt-out:
   `allow-unsafe-pr-checkout: true` turns the action's half off outright, and that input lives in
   the reusable half where no caller can see it. A test asserts no checkout step sets it.
2. **The author gate** — `isTrustedAuthor` in `shared/`. Every PR feedback surface is
   world-writable, and `fix` acts on that feedback with `contents: write` and pushes. An injection
   would steer *committed code*, so the gate is read by the workflow, not by the agent, whose GitHub
   token is scrubbed before it starts.
3. **The pin** — see below.

## Base-controlled, and what that now depends on

`pull_request_target` reads workflow YAML from the **base** branch while checking out the **PR
head**. So a pull request cannot edit a caller to change what runs.

That protection used to extend to the called workflow for free, because `uses:` was a local path
resolving against the same commit. **Remote, the reference is what decides.** `@main` would hand a
job holding `contents: write` and every secret to whatever currently sits on this repository's
default branch, and nothing would report it. Callers pin a tag or a SHA; a test enforces the shape.

## The version pin keeps two halves in step

The workflow YAML and the runner code come from different places — YAML from the base branch,
runner from the published package. Pinning the version **in the YAML** is what makes them move
together.

This is not hygiene. Before the pin existed, a pull request that changed the runner's interface
broke every later run against it: new runner on the branch, old YAML on `main`, both current as of
different commits. **A change that refactors the runner it executes on has a split brain by
construction**, and the pin is the only thing that closes it. `docs/friction.md`, 2026-08-08.

## Invariants with no runtime symptom

The ones worth knowing because nothing fails when they break:

- **`self-check`** is `<caller job id> / <called job id>`. The CI wait excludes its own check run or
  it waits for itself — 15 of 20 minutes, then a review on degraded evidence. Nothing inside a
  called workflow can read its caller's job id, hence a required input with no default.
- **`bin` must not start with `./`.** `npm publish` silently drops such an entry and exits 0. The
  tarball is fine; only the registry manifest loses it, and the symptom is `npx <pkg> <cmd>` finding
  no command. `0.1.0` shipped exactly that.
- **A label set when an issue is *created* fires no `labeled` event.** Label in a separate call,
  always; recovery is remove-then-re-add.
- **A label added with `GITHUB_TOKEN` is a silent no-op**, which is why `AGENT_PAT` exists.
- **The *Authenticate to GitHub Packages* step is deliberately toolchain-free.** It is the registry
  half of `setup-node` — it runs on repos that skipped the toolchain step entirely, so it declares
  no `node-version-file` and passes `package-manager-cache: false` to stop the action inferring one
  from a `packageManager` field (automatic and defaulted on from v5; v6/v7 also read
  `devEngines.packageManager`). An input added there that does toolchain work fails *before* the
  runner exists to write `failure_reason.txt`, and this repo cannot reproduce it: it declares no
  `packageManager`, so the caching never fires here.

## The prompts name no domain

The runners and prompts must stay free of any consuming repo's vocabulary — a test walks the runner
surface and fails on it. The gate command is not named either: prompts say *"the verify command
`CLAUDE.md` names"*, so an adopter writes their gate down once, in their own `CLAUDE.md`.

This is why the loop can run anywhere. It is also why **this** repo needs its own `CLAUDE.md` and
`CONTEXT.md` — it is an adopter of itself.

## Where the rest is written down

| File | What |
|---|---|
| [`docs/ADOPTING.md`](./docs/ADOPTING.md) | installing the loop elsewhere; §1 is the silent failures |
| [`docs/friction.md`](./docs/friction.md) | a dated log of every time a human reached into the loop, and why |
| [`docs/parity.md`](./docs/parity.md) | how this compares to the upstream loops it was modelled on; §10 holds invariants |
| [`docs/agents/ticket-shape.md`](./docs/agents/ticket-shape.md) | how a batch of tickets is published, and in what order |
| [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md) | the triage vocabulary beside `agent:*`, and the only definition of the `wayfinder:*` labels two workflows refuse |
| [`setup/SETUP.md`](./setup/SETUP.md) | the prompt `init` leaves in an adopter's tree for the judgement work it cannot do |

`friction.md` is a **narrative log**, not a changelog: the commits are its timestamps, and entries
describe what was true when written. Do not edit history into it.
