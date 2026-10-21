---
status: accepted
date: 2026-10-21
---

# The service runs one job kind per workflow, and its dispatcher trusts its own App as a sender

The service orchestrator (PRD #453) answered `agent:review` alone: the dispatcher built one job
shape, `ReviewJob`, and the worker ran `review.yml`'s subcommands in order. Serving `agent:fix`
(PRD #515), and after it update-branch, implement, implement-prd and follow-ups (#516 to #519),
needs two things that shape did not have: more than one kind of job, and a label the loop adds
itself. This records both.

## One job kind per workflow, each coded as its own run function

**The job is a union with one member per workflow the service serves**, discriminated by its
`workflow` field (`service/job.ts`). The dispatcher maps each trigger label to a kind
(`LABEL_KINDS` in `service/dispatcher.ts`), and `SERVICE_LABELS`, the labels the service answers,
is that map's keys, so a label the service answers always starts a job. The worker's job door
parses the union and refuses a kind it does not know, as the token door refuses a token kind it
does not know.

**Each kind has its own run function**, which follows its workflow's `Actions orchestrator:`
blocks in `docs/platform-spec.md` step by step. The steps they share are primitives in
`service/worker.ts`: ask the dispatcher for a token, run a subcommand in a fresh output directory
with the environment its declaration builds, run the sandboxed runner, hold a phase to a time
limit, and write the run's summary.

### Considered options

- **One declarative phase table, read by one interpreter.** Rejected. Phases wire each other
  differently: which token each is handed, which output directory feeds which `readsFrom` input,
  what still runs after a failure or a timeout, and what a later phase is told of an earlier one's
  ending. A table that can say all of that is a small Actions interpreter, and its mistakes fail
  at run time on a live pull request. A run function's mistakes mostly fail at typecheck, and the
  orchestrator blocks it follows are already written as steps.
- **One job shape with optional fields per workflow.** Rejected: every reader would have to ask
  which fields are set, and a field one workflow needs would be accepted, empty, on another's job.

## The dispatcher trusts its own App as a label's sender

The dispatcher's author gate looks up the label sender's permission on the repository and refuses
anything below write. When `review:conclude` adds `agent:fix` on the service, the sender is the
App's own login, `<slug>[bot]`, which that lookup is not built to answer for. **A sender equal to
the dispatcher's own App login is accepted without a lookup**; every other sender is checked as
before. The login is worked out of the App's own record (`appLogin` of its slug), the same one
each job carries as the loop's account, and compared without regard to case, as GitHub compares
logins.

Trusting the App's login is trusting the loop's own commands. The App adds a trigger label only
where a command decided to, such as `review:conclude` under the repository's fix-round budget, so
the budget remains the limit on what the loop starts by itself, as it is on Actions.

### Considered options

- **Look the App's permission up like anyone else's.** Rejected: the lookup asks for a
  collaborator's role on the repository, which it is not designed to answer for an App, whose
  grants are its installation's permissions. A refusal there would stop every round the loop
  starts by itself.
- **Trust any `[bot]` sender.** Rejected: another App installed on the repository could then
  start the loop's work by adding a label, which no person with write access asked for.

## Consequences

- A new workflow on the service is a new kind in `JOB_KINDS`, a new member of the union with its
  parser, an entry in `LABEL_KINDS`, the dispatcher's job for it, and a run function. A kind added
  without its parser or its run function fails typechecking.
- Review on the service runs exactly as before; only the job's `workflow` field is new.
- The only sender the dispatcher trusts without a lookup is its own App. A command that adds a
  trigger label when it should not now starts work on the service by itself, as it already does
  on Actions.
