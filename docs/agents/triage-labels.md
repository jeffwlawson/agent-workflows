# Triage labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repo's tracker — and, because this repo also runs an agent loop, records
the **second** vocabulary those roles sit beside and how the two are joined.

> **Scope.** The same boundary as [`issue-tracker.md`](./issue-tracker.md): this file configures the
> **local, human-driven** skills. `/triage` reads it. No workflow reads it — the workflows read
> labels, and the `agent:*` half of the table below is described here only so the seam between the
> two vocabularies is written down in one place.

## The five canonical roles

Defaults, unchanged — each label string equal to its role name.

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from this table.

Only `wontfix` exists in the repo today, as GitHub's stock label. Create the other four before
running `/triage` for the first time:

```bash
gh label create "needs-triage"    --color D93F0B --description "Maintainer needs to evaluate this issue"
gh label create "needs-info"      --color FBCA04 --description "Waiting on reporter for more information"
gh label create "ready-for-agent" --color 0E8A16 --description "Fully specified, ready for an AFK agent"
gh label create "ready-for-human" --color 5319E7 --description "Requires human implementation"
```

## Two vocabularies, not one

`docs/ADOPTING.md` §3 names this as a decision that has to be made explicitly rather than drifted
into. This is the answer.

| | What it says | Who writes it | Who reads it |
| --- | --- | --- | --- |
| **triage roles** (above) | *how well specified is this, and who should do it* | a human, or `/triage` | humans, and the local skills |
| **`agent:*`** | *workflow state — what is running, or refused, right now* | the workflows, and a human at the one entry point below | the five workflows |

They are **not merged, and neither is derived from the other.** A triage role is a judgement about
an issue; an `agent:*` label is a position in a state machine. An issue can sit at
`ready-for-agent` indefinitely and carry no `agent:*` label at all — that is the normal resting
state, not an unfinished transition.

The six workflow-state labels are listed in `docs/ADOPTING.md` §3 and their transitions in
`CONTEXT.md`; this file does not restate them, because a second copy is a second thing to keep in
step.

## The one join: `ready-for-agent` → `agent:implement`, by hand

This is the only place the two vocabularies touch, and it stays a **human hand**. Not because
automating it is hard, but because the two labels authorise different things:

- `ready-for-agent` says *this issue is specified well enough that an agent could build it.*
- `agent:implement` says *build it, now, on this repo, and open a PR.*

The gap between those is a decision about when and whether, which the triage judgement does not
contain. A promoter watching for `ready-for-agent` would collapse the two and turn every
well-written ticket into a running agent, which is not what triage was asserting.

Two mechanical reasons reinforce it:

- **Trigger labels are consumed on entry** (`ADOPTING.md` §3), which is what makes a retry
  idempotent — a human re-adds the label deliberately. An automatic promoter would re-add it
  automatically, and the idempotence is gone.
- **On a PRD parent the label is a cursor, not a one-shot.** The chain re-adds `agent:implement` to
  the parent after each slice closes, and stops by *not* re-adding it. A promoter writing the same
  label from a different rule would be writing into a live cursor.

`/to-tickets` applies `ready-for-agent` to every ticket in a batch and no `agent:*` label to any of
them — see [`ticket-shape.md`](./ticket-shape.md#labels), which is the instruction that makes that
so. Exactly one issue per batch is ever promoted, the parent, by a person.

## `agent:queued` — declared, and inert

There is a seventh `agent:*` label. It is **written by a human, never by a workflow, and read by
nothing.**

It marks a dependency between *top-level* issues: this one is specified and authorised, but waits
on another. The workflow that would consume it, `promote-queued`, does not exist in this repo — so
nothing removes it either, which is why no workflow applies it. A workflow that did would be
manufacturing a state only a human can clear. `docs/parity.md` §10 carries the full reasoning; §8
is where the label is tabulated.

It also does not belong **inside** a PRD. Every slice after the first is queued by construction,
and the chain already holds that ordering in the parent's sub-issue list; a label saying the same
thing is one more thing that can go stale against it.

The label does not exist in the repo. Create it only when you actually intend to hand-mark a
waiting issue:

```bash
gh label create "agent:queued" --color C5DEF5 --description "Authorised, but waiting on another issue; read by nothing today"
```

If `promote-queued` ever ships, this becomes "written by a human **or** by that workflow, on
top-level issues only" — and not before.

## The `wayfinder:*` planning labels

A third, small vocabulary, written by `/wayfinder` and by hand. These mark **planning artifacts**:
work that decides what to build, as opposed to work that builds it.

| Label | On | Means |
| --- | --- | --- |
| `wayfinder:map` | the map issue | The map itself — Notes, Decisions-so-far, Fog. Holds the child tickets as sub-issues. |
| `wayfinder:research` | a child ticket | An open question to be answered from sources, not code. |
| `wayfinder:prototype` | a child ticket | A throwaway build to answer a design question. |
| `wayfinder:grilling` | a child ticket | A decision to be stress-tested before it is committed to. |
| `wayfinder:task` | a child ticket | A concrete step within the map that is not itself the feature. |

None of them exist in the repo yet. Create them when you first run `/wayfinder`:

```bash
for t in map research prototype grilling task; do
  gh label create "wayfinder:$t" --color BFD4F2 --description "Planning artifact; never implementable"
done
```

**No `wayfinder:*` issue is ever implementable, and both implement workflows refuse one on sight.**
The refusal matches on the **prefix** — `select(startswith("wayfinder:"))` — not on the list above,
so it already holds for any label added to this table later, and held before any of them existed.
A refused run applies `agent:blocked` rather than leaving the trigger label to be re-added, since
re-labelling would only reproduce the same refusal.

The refusal says: *"Label the issues they produce instead."* That path is:

1. `/wayfinder` resolves the map's tickets and records the answers in Decisions-so-far.
2. `/to-spec` runs off the resolved map and produces a PRD. **File the PRD as a top-level issue**
   and link the map from its body — a PRD that is itself a sub-issue of the map is refused by
   `agent-implement-prd` and deferred away by `agent-implement`, so `agent:implement` would do
   nothing at all ([`ticket-shape.md`](./ticket-shape.md#verify-natively-before-labelling-anything),
   item 5).
3. `/to-tickets` publishes the slices under that PRD, in dependency order, each `ready-for-agent`
   ([`ticket-shape.md`](./ticket-shape.md)).
4. A human adds `agent:implement` to the PRD.
5. Once the slices are published and verified natively **and every child ticket is closed**,
   **close the map** — `gh issue close <map> --reason completed --comment "Sliced into PRD
   #<prd>"`. After `/to-tickets`, not before: slicing is the map's last consumer and the step most
   likely to surface a decision the PRD under-specifies, and the map is where that ticket would go.
   An open child under a closed map is not a state this path produces — the frontier query reads
   children regardless of the map's own state, so a later `/wayfinder` session would be handed a
   frontier on a route that has left planning. Close the child, or reopen the map.

Closing is bookkeeping, not disposal. **A map and its tickets are never implementable at any point
in their lives** — that is what the refusal above is about, and it holds whether they are open or
closed. They remain the record of why the PRD says what it says, reachable from the PRD's body link
and from GitHub's own back-reference on the map. They are not a queue that eventually drains into
the loop.

Child tickets close earlier and one at a time, as they are answered:
[`issue-tracker.md`](./issue-tracker.md#wayfinding-operations)'s *Resolve* operation closes each one
and appends a pointer to Decisions-so-far, and the **frontier query reads the map's open children**
to find the next one. So issue state carries information here — an open child is an unanswered
question, and an open map is a route that has not yet been sliced into a PRD. Neither reads on
promotion: step 4 is a scheduling decision, and a map whose slices are waiting for one has already
finished its own job.
