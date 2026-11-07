# The ledger, the lock and the handoff

## Where it lives

`$CONDUCT_LEDGER` where the maintainer set it, else `~/.local/state/conduct/<owner>-<repo>/ledger.md`: outside the repository, so nothing commits it, and outside `$TMPDIR`, which differs between a sandboxed and an unsandboxed shell and is cleared. Say the path in your first message. Write it with the file tools, or an unsandboxed shell where the sandbox refuses the path.

## Shape

A dated claim per line, **appended, never rewritten**. A later entry supersedes an earlier one by naming it; an entry is **in force** until one lapses it.

```markdown
# Conduct ledger: <owner>/<repo>

- L1 2026-11-07 14:02Z lock: taken by conduct-20261107T1402Z-7f3a.
- L2 2026-11-07 14:10Z delegation: build #A, then #B, one at a time; the maintainer, "yes, in that order".
- L3 2026-11-07 14:11Z watching: #A, until a run starts ('.[0].comments > 2').
- L4 2026-11-07 15:30Z decision: merge #812 at 3f9c…(40) on a clean check; will be on the record as the merge.
- L5 2026-11-07 15:31Z lapses L2 for #A: merged as #812.
- L6 2026-11-07 15:40Z escape: #812, review/prompt.md:40, judgement; the review approved a criterion the diff left unmet. Proposal: a standards line on criteria a docs file carries.
- L7 2026-11-07 18:40Z lock: released by conduct-20261107T1402Z-7f3a at handoff (handoff-2026-11-07.md).
```

- **Delegation**: the task or tasks, the step (build, fix, merge, a release, a restart), the scope (the order, a SHA, "standing: merge each on a clean check"), when, and the maintainer's words. A standing delegation is in force until the maintainer withdraws it, and a new session confirms it before acting on it.
- **Decision**: what the maintainer decided that no record holds yet, and where it will be written (a brief, a comment, a merge). Lapse it once it is there.
- **Watching**: the items and the predicate. Never the pid; it dies with the shell.
- **Escape**: the pull request, the finding and its file, its class (**mechanical**: a check could have caught it; **judgement**: a reader had to notice), and the proposal (a test or a check; a line in the repo's standards, or in the review's prompt where it is domain-free).
- **Lock**: taken or released, and by which session.

## The lock

Take it as your first write: a `lock: taken by conduct-<UTC start time>-<4 random hex>` entry, the id written into your first message so the maintainer can tell sessions apart. A ledger whose last lock entry is a take by another id means another session is conducting, or died without releasing. Either way, ask before taking over (briefs.md), and on a yes append a release of the old id and a take of yours.

## Handoff

At a natural boundary (a release, the batch merged, the context near full), or when the maintainer says so:

1. Append to the ledger what is still in force and what you watched.
2. Write `handoff-<date>.md` beside it, in `/handoff`'s shape: a summary that **points** (issue and pull request numbers, the release tag, the ledger's entry ids) rather than copies, what is in flight and what it waits for, a *Suggested skills* section (`conduct`, `merge-check`, `issues-to-prd`), and no secrets. It goes beside the ledger, not in `/handoff`'s `$TMPDIR`, so the next session finds it. Start it with the line to give the next session: "Run `/conduct`; the ledger is at <path>."
3. Stop every watcher you started, by its pid.
4. Release the lock.

Then conduct nothing more: take no action, add no label, start no watch. A successor started in the background has no human at its checkpoints, so the next session starts with the maintainer present, reads the ledger, and confirms the delegations in force in one question before acting on any.
