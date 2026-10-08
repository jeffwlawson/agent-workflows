---
status: accepted
date: 2026-10-07
---

# The reusable workflow keeps what only Actions can do; the package takes the rest

`CONTEXT.md`'s *three parts* put "every guard and every step" in the reusable workflow, so that an
adopter referencing it got every fix without editing a file. That left about 1,400 lines of inline
shell across the six reusables, and a second orchestrator has to rebuild all of it, writing each
record string in exactly the shape the runners read back (#386). The reason for keeping steps in
YAML no longer holds either: the pin selects the reusable and the package from the same release, so
code in the package reaches an adopter by the same reference. What is left that only YAML can do is
what only Actions can express. So that is what the reusable keeps (#395).

**The reusable keeps:**

- the Actions settings: the trigger, the job graph and its conditions (`if:`, `needs:`,
  `always()`, `failure()`), the permissions ceiling, which job names which secret,
  `concurrency:`, the timeouts and the fork guard;
- glue that only carries a value into one of those settings, such as the arithmetic
  `timeout-minutes:` cannot do, or a file copied into a job output for a later `if:`;
- the adopter's own commands: `inputs.setup` and the red check's test command;
- the plumbing only Actions provides: checkout, Node setup, artifacts between jobs, and choosing
  and minting the write token, whose mint masks it and revokes it at the job's end.

**The package takes everything else.** A step that reads or changes the PR or issue, or decides
anything, becomes package code. That includes the guards written as steps, such as the preflight
refusals and the bundle check, and not only the steps that write the record. The reusable hands a
command the token and which source it came from (`app`, `pat` or `workflow`), and the **command
chooses the token for each write**: whether a label starts the next run, or a status carries the
author later runs look for, is loop knowledge every orchestrator needs.

**Every step keeps its job.** Package code runs in the job its shell ran in, so the credential
split, the agent's job naming no write token, is untouched. This stage moves code, not trust
boundaries.

The rule is for all six reusables. `review` moves first (#393), and `CONTEXT.md` names the ones
still running their steps inline until each has moved.

## Considered options

- **Keep the guards in the reusable and move only the record writes** (#386's first guess).
  Rejected: the guards are code, not Actions features. A second orchestrator needs every refusal
  and the bundle check too, and would rebuild them, which is the cost this decision exists to
  remove.
- **Move the glue too.** Rejected: a job that only computes a timeout would install Node and the
  package to add two numbers.
- **Move the token's source choice into the package.** Rejected: choosing and minting belong
  together, and holding the write credential is the host's duty. A service mints its own way.

## Consequences

- Each job that runs package code installs the package, and more package code runs with the
  write token.
- `tests/workflows.test.ts` keeps the adapter rules, such as which job names which secret. The
  assertions about step shell become unit tests of the commands.
- The Actions log shows fewer, larger steps.
- `CLAUDE.md`'s *Changing a workflow* still sends a guard to the reusable. It changes when the first
  command lands, since until then there is nowhere else to put one.
