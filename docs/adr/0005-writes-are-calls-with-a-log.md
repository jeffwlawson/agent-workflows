---
status: accepted
date: 2026-10-07
---

# A command writes through the engine's writer, one call at a time, and the log is kept afterwards

[ADR 0002](./0002-engine-and-loop-one-repo.md) lists "writes as a typed, capped list" among the
safety ideas the engine borrows from gh-aw. In gh-aw the agent emits that list, a separate writer
applies it, and the list is fixed before anything is applied. Here the list would come from loop
code reading the agent's output, and about a third of `review.yml`'s writes cannot be fixed in
advance (#394). Some carry the result of an earlier write: the review body's *Resolved* groups
name the threads that actually resolved, and the status line names the URL of the review just
posted. Others are decided from live state when they are applied: the trigger label is re-added
only if the head moved, and the fix round is started only if its guard passes. A list fixed before
applying cannot hold them, and a list applied in phases, with the loop deciding between phases,
leaves phases of one or two writes each (#397).

So **a command calls the engine's writer once per write**, and the engine keeps a log of what it
applied instead of receiving a plan of what to apply. The safety ideas move with the write, not
with a list:

- **Typed.** A write type names what GitHub does: add a label, set a commit status, replace the
  block between two markers, post a review, reply to a thread and then resolve it with a reason.
  Loop meanings such as "post the verdict" are loop functions that call these. The engine knows no
  record string. The loop passes in its markers, status contexts and labels (`docs/platform-spec.md`
  §4).
- **Capped.** Each write type has a count limit. The write past it is refused and the command
  stops with an error. Our writes come from our own code, so going past a limit is a bug, and
  quietly keeping the first N would post half of something.
- **Stops at the first failure.** GitHub has no transactions, so applying all or nothing cannot be
  done. A failed write stops the command, and the workflow's `always()` command for that job takes
  over the failure path. Later writes refer to earlier ones, so carrying on past a failure, as
  gh-aw does, would leave the record pointing at writes that never landed. A failure the loop can
  live without, such as one thread that will not resolve, is caught in loop code on purpose.
- **Logged.** The writer records each write and its outcome in a file the command declares as an
  output. Nothing replays it yet, and replay can be added later without changing the writer.
- **One token per writer.** The command is handed two writers, one for the loop's token and one for
  the workflow's, sharing one log and one set of limits. Which writes need the token whose writes
  start a workflow is loop knowledge (ADR 0003), so the choice stays in loop code.

**The agent's text is cleaned when it is read, not when it is written.** The typed readers a
command uses to read the agent's hand-over (ADR 0004) give out the agent's text only in cleaned
form, as a branded type. The loop then adds its own markers, status lines and `Closes #N` to it.
So cleanup (#391) never touches a loop string, an agent cannot forge one, and there is one place
where cleanup happens, enforced by the type rather than by checking each write path.

**Commands are split where Actions has to act in between.** A job's package code becomes one
command per stretch between steps only Actions can take, such as a checkout, an install, the
adopter's command, the agent, an artifact download or the token's mint. A job with a failure path
gets one more command, run `always()`, that holds that path, so a command that crashes or is
cancelled still has its failure written. For `review` that is seven: `review:red-check-place` and
`review:red-check-classify` around the adopter's test command, `review:gate` and
`review:collect-checks` around the installs, `review:publish` and `review:conclude` in the posting
job, and `review:advance`.

**A command is handed what it touches.** Its function takes its two writers and a GitHub reader as
arguments. `cli.ts` builds the real ones, and a test passes fakes and checks what the command tried
to write. The writer and the reader are the seam, and the real and the fake are its two adapters.

**The engine starts small.** `engine/` holds, at first, the writer, the GitHub calls and the marker
splicing, and code moves in only when engine code needs it. ADR 0002's rule is a test that walks
every module under `engine/` and fails on any relative import that resolves outside it. npm
packages and Node's built-ins are allowed. The writer reads no environment: it is handed its token
and throws on failure, and `cli.ts` turns the throw into `fail()`.

## Considered options

- **A list fixed before applying**, as gh-aw does. Rejected: about a third of review's writes
  depend on an earlier write's result or on live state (#394).
- **A list applied in phases**, with the loop deciding the next phase from the last one's outcomes.
  Rejected: review's phases come to one or two writes each, so it is one call at a time with a
  list to build around each call. Its one advantage, a plan to inspect before applying, is covered
  by a fake writer for a dry run and by the log for an audit.
- **Conditional write types**, which carry their own guard ("re-add this label if the head moved").
  Rejected: the loop's decisions would be rewritten in the engine's vocabulary, and the engine
  would grow with every new guard.
- **Carry on past a failed write and fail at the end**, as gh-aw does. Rejected for the reason under
  *Stops at the first failure*.
- **Caps that keep the first N**, which is what gh-aw's code does, or reject the whole type, which
  is what gh-aw's specification says. Rejecting the whole type needs the count up front, which
  calls one at a time do not have. Keeping the first N hides a bug.
- **Cleanup at each write.** Rejected: every write type would have to separate agent text from loop
  text, and a write path that forgot to would be one nothing checks.
- **One command per step.** Rejected: the YAML would keep the order and the branching on step
  outcomes, which is deciding, and ADR 0003 moves deciding into the package.
- **One command per job.** Not possible for most jobs: a job that runs the adopter's command or
  the agent has package work on both sides of it.

## Consequences

- In `post-review`, the token's mint moves to the start of the job. Today it runs after the posting
  writes.
- The engine gains the two write types gh-aw lacks: a commit status, and a reply to a thread coupled
  to its resolve with a reason.
- `follow-ups:file` writes outside the writer until its own workflow moves.
- #391's criterion that every write path goes through cleanup becomes a property of the readers.
  The hand-over's readers (#398) must give out the agent's text already cleaned.

## Revisit when

A write list has to outlive the run that made it: replay by a later run, a human approving a
plan before it is applied, or a second orchestrator that applies writes in another process.
