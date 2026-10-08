---
status: accepted
date: 2026-10-08
---

# The hand-over is the agent's declared files, checked on read, and the gate's facts travel apart

[ADR 0004](./0004-command-shape-and-folders.md) fixes how a command reads another subcommand's
files: a declared directory input, read through typed readers. [ADR
0005](./0005-writes-are-calls-with-a-log.md) has those readers give out the agent's text only
already cleaned. This records what crosses from the agent to publish, what is checked before the
first write, and how the write token stays out of the agent's reach once the phases can run in one
process (#398).

Today `review.yml`'s agent job uploads a hand-picked list of seven files, and the posting job reads
them with `jq` and `cat`. The reviewed commit and the round number travel separately, as job
outputs set before the agent ran. Nothing compares the commit the payload says it reviewed with the
one the preflight recorded. Nothing checks a file's shape beyond the one slot count in the review
body.

**The gate's facts travel apart from the agent's files.** The reviewed commit, the round number
and the other facts recorded before the agent runs are not files in the hand-over. A command that
needs them declares them as ordinary inputs. Actions fills those from job outputs, which a later
step cannot overwrite, and a service orchestrator fills them from its own memory. These are the
values the agent's output is checked against, so an agent steered by text it read must not be able
to write them. A file beside the agent's would let it edit both sides of the check.

**A command declares exactly which of a producer's files it reads.** Its directory input names the
producer and the files, in `shared/contract.ts`. The typed readers cover those files and no
others, and a file the producer writes only sometimes, such as `pr_summary.json`, reads as absent.
The input gets a row in the command's `### Inputs` table in `docs/platform-spec.md`. The upload
step's paths are held equal to the declared set by `tests/workflows.test.ts`, which replaces the
list `review.yml` keeps by hand. The park files that `review:advance` reads follow the same rule.

**The readers check before anything is written.** Each file is parsed strictly, and a declared
file that is missing or malformed fails the command through `fail()`. The review payload's
`commitOID` must equal the reviewed commit from the gate's facts, or the command fails. Both checks
sit in the readers beside cleanup, so no write is reachable from an unchecked file.

**Threat detection gets a place and nothing more.** #392's check is its own step after the agent
and before publish. It holds no write token, reads the same hand-over through the same readers,
and writes a ruling. Once it exists, publish declares the ruling as an input and refuses to write
without it. Whether that step is a job of its own or runs in the posting job before the token's
mint is #392's.

**The agent is always a child process.** An orchestrator that runs the phases in one process still
starts the agent's phase as a child, with an environment built from the runner's declared inputs
only and never inherited from the parent. The write token stays in the parent, and the parent
reads the runner's outputs after the child exits. In Actions this already holds, because the agent
and the token are in different jobs.

## Considered options

- **The gate's facts as files in the hand-over.** One channel instead of two, but the agent's
  runner could write the values the agent is checked against.
- **Hand over every file the runner declares.** Simpler to declare, but the upload and the
  readers would carry files no consumer reads, and the list a test can hold the YAML to would be
  "everything" rather than what is used.
- **Check shape only.** Leaves the gap that exists today: a payload naming a different commit from
  the one the preflight recorded would be posted.
- **Threat detection inside publish, before the first write.** It would run in the process that
  holds the write token, and #392 asks for a step with no write credential.
- **Every phase its own process.** Keeps the token out of the agent's process too, but costs a
  process per phase and makes the token no safer than isolating the agent's phase alone.

## Consequences

- `shared/contract.ts` gains a directory input kind that names a producer and the files read from
  it. Readers are built from it the way `writers` are built from declared outputs.
- `review:publish` declares the reviewed commit as an input, filled in Actions from
  `needs.review.outputs.sha`.
- The commit check is new behaviour: a payload whose `commitOID` differs from the reviewed commit
  stops publish before its first write.
- The agent job's two upload steps are checked against the declared sets of `review:publish` and
  `review:advance`, rather than kept by hand.
- [ADR 0007](./0007-publish-writes-every-final-string.md) changes what the files hold: decisions
  and raw text, never finished text. That takes review's hand-over from seven files to five, and
  removes the `commitOID` check, since no file names a commit any more.

## Revisit when

The agent's phase has to run without a separate process, for example on a host that cannot start
one. The token's isolation would then need another mechanism before that host is supported.
