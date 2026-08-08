# Ticket shape: a parent PRD with sub-issues

How `/to-tickets` publishes a batch of slices into this repo's tracker — the question
`docs/agents/issue-tracker.md` deliberately left open until #93.

> **Scope.** The same boundary as `docs/agents/issue-tracker.md`: this file configures the
> **local, human-driven** skills. No workflow reads it. What a workflow *does* read is the result —
> the issue hierarchy this file tells you to build. `agent-implement-prd.yml` walks it on every
> `agent:implement` event.

## The shape

```
#100  parent PRD          ← body is the /to-spec output; label: ready-for-agent
 ├── #101  slice 1        ← sub-issue, ready-for-agent
 ├── #102  slice 2        ← sub-issue, ready-for-agent, blocked-by #101
 └── #103  slice 3        ← sub-issue, ready-for-agent, blocked-by #102
```

Two relationships, doing different jobs:

- **parent / child** — containment. It is one PR per PRD, and it is the work-list
  `agent-implement-prd` walks.
- **`blocked-by`** — ordering, and the machine-readable record of *why* the order is what it is.

Both are **native** GitHub relations, not prose in a body. Why that distinction is load-bearing —
what a consumer can and cannot see — is in
[`issue-tracker.md`](./issue-tracker.md#native-relations-sub-issues-and-blocking), with the
mechanics for setting both.

Upstream carries both relationships, but **as body prose, not natively**. #93 checked
`mattpocock/course-video-manager` on 2026-08-07 — its newest feature at the time, #1514–#1518 —
and found #1517 with `## Parent` → `#1514` and `## Blocked by` → `- #1516` written into its body,
while the API reports `parent: null`, `blocked_by: 0` and no sub-issues on #1514 (re-verified
2026-08-08). That is the `/to-tickets` defect below (#513) seen from the outside, and it is what
this file exists to correct. Only the labels already match: every ticket carries `ready-for-agent`
and no workflow trigger label.

## Creation order is execution order

The load-bearing detail, and the one that is easy to get wrong while getting the shape right.

`agent-implement-prd.yml` targets *the first still-open sub-issue, in the order the sub-issues API
returns them*. It **never reads `blocked-by`.** That is only safe because the sub-issues are
*created* in dependency order — the topological sort happens once, at publish time, here.

So a batch published in the wrong order produces a chain that runs slices before their blockers,
and nothing catches it: the edges are right there, and nothing consults them. Sequence the
`gh issue create` calls yourself, blockers first, one at a time — a parallel publish has no
defined order, which is the same bug arriving by accident. (The other direction is settled too:
`agent-implement-prd.yml` says, in its header, *do not add edge-reading here; fix the publish order
instead*.)

**What the API returns is a position, not a timestamp.** Each sub-issue holds a place in the
parent's list; creating one appends it, which is why publishing in order is enough. But the place
is editable — by dragging in the parent's UI, or through the sub-issue priority endpoint
([`issue-tracker.md`](./issue-tracker.md#native-relations-sub-issues-and-blocking)). So the order
is also *reorderable after the fact*, which is the repair below, and the hazard: dragging a
sub-issue in the parent
rewrites the execution order of a chain that has not run yet, silently and with no other effect
visible anywhere.

## Labels

| Issue | `/to-tickets` gives it | It never gets |
|---|---|---|
| the parent PRD | `ready-for-agent` | — (a human adds `agent:implement` later, deliberately) |
| each sub-issue | `ready-for-agent` | any `agent:*` label, ever |

`ready-for-agent` is triage's "fully specified", and a slice that isn't fully specified isn't a
slice yet — so every ticket in the batch carries it, which is `/to-tickets`' own default. Only the
**parent** is ever promoted to `agent:implement`, by a human, and that single label starts the
whole chain. See [`triage-labels.md`](./triage-labels.md) for why that promotion stays a human
hand, and for the two vocabularies it joins.

Labelling a sub-issue `agent:implement` does not fork the chain — `agent-implement.yml` refuses any
issue with a parent, and says to label the parent instead — but it is a refusal, not a plan. Don't
rely on it.

`agent:queued` is not part of this shape either. It is the tier *above*: dependencies between
top-level issues, promoted by a workflow this repo does not have. Within a PRD the ordering is
already carried by creation order, and the chain does not need to be told to wait.

## Publishing

`gh issue create` prints the new issue's URL as its last line; everything below keys off that.
`--parent` and `--blocked-by` need a recent `gh`; on an older one the same two relations are REST
endpoints. Both forms, and the database-id trap that comes with the endpoints, are in
[`issue-tracker.md`](./issue-tracker.md#native-relations-sub-issues-and-blocking).

```bash
new() { basename "$(gh issue create "$@" | tail -n1)"; }

# 1. The parent. Its body is the /to-spec output, unedited. No --parent of its own: a nested
#    PRD is refused by the chain, even when the /to-spec ran off a /wayfinder map.
prd=$(new --title "Adopt the PRD tier" --body-file spec.md --label "ready-for-agent")

# 2. The slices, one command per slice, in dependency order — blockers first.
s1=$(new --parent "$prd" --label "ready-for-agent" \
        --title "Slice 1: …" --body-file slice-1.md)
s2=$(new --parent "$prd" --label "ready-for-agent" --blocked-by "$s1" \
        --title "Slice 2: …" --body-file slice-2.md)
s3=$(new --parent "$prd" --label "ready-for-agent" --blocked-by "$s2" \
        --title "Slice 3: …" --body-file slice-3.md)
```

A slice may take more than one blocker. Edges only ever point *backwards*, at slices already
created — a forward edge means the order is wrong.

**Without those flags**, create each slice plainly and attach it with the two `POST` endpoints in
`issue-tracker.md`, still one slice at a time. Two consequences of that path belong here rather than
there:

- The **sub-issue** attach is the one that matters — it is the relation the chain walks. Miss it
  and the PRD has zero sub-issues: the chain defers, `agent-implement` takes the parent as a
  standalone issue, and one run implements the whole spec.
- Attaching a sub-issue **appends** it to the parent's list exactly as `--parent` does, so calling
  the endpoint slice by slice, blockers first, still gives execution order.

**Only publish slices you intend this chain to run.** The chain implements *every* open sub-issue,
so a slice parked as "maybe later" is a slice the chain will build. #91 had to be detached from #87
for exactly that reason. Park it as a standalone issue and link it from the PRD body instead.

## Verify natively before labelling anything

Not optional, and not a formality: upstream's `/to-tickets` does **not** reliably emit native
relations. As of #93 (2026-08-08), `mattpocock/skills` #513 records it writing a prose
`Blocked by:` line instead, and #262 — the issue tracking it — is still open. So a batch can look
perfect in the issue bodies and carry no edges at all. The prose reads the same either way; only
the API tells you which one you got.

Re-read all three, and read them the way the workflow does:

```bash
# The work-list, in the order the chain will walk it. This is the whole scheduling policy.
# `parent` on the PRD itself must come back null — see 5 below.
gh issue view "$prd" --json subIssues,parent,labels

# Per slice: the parent link, the edges, and that no agent:* label crept in.
gh issue view "$s2" --json number,parent,blockedBy,labels
```

For the authoritative check, run the query `agent-implement-prd.yml` runs — same connection, same
page size, same order:

```bash
gh api graphql -f owner=jeffwlawson -f name=winget-manifest-lint -F number="$prd" -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        subIssues(first: 100) { totalCount nodes { number title state } }
      }
    }
  }'
```

What to check, in order of how expensive it is to get wrong:

1. `nodes` lists every slice, **in dependency order**. This is the execution order. Nothing else
   sorts it.
2. Every slice has `parent` set to the PRD. A slice that missed the parent link is invisible to the
   chain — the PRD finishes without it, and nothing reports a gap.
3. Every slice after the first has the `blockedBy` edge the order implies.
4. `labels` is `ready-for-agent` and nothing else.
5. **The PRD's own `parent` is null.** The one item on this list that fails loudly rather than
   silently, which is why it is last — and the one that costs the most to fix afterwards. A PRD
   that is itself a sub-issue is refused by `agent-implement-prd` ("this PRD is itself a sub-issue
   of #N … Flatten the hierarchy") and deferred away by `agent-implement`, so `agent:implement`
   does nothing at all. It is an easy shape to reach by accident: a `/wayfinder` map's children are
   sub-issues of the map (`issue-tracker.md`), and `/to-spec` runs off that map — file the PRD as a
   top-level issue and link the map from its body.

If the order is wrong, move the slice rather than recreating it — `gh` has no flag for this, so it
is the sub-issue **priority** endpoint
([`issue-tracker.md`](./issue-tracker.md#native-relations-sub-issues-and-blocking), same database-id
trap): move the misplaced slice to sit after the one it should follow.

Then re-read the list and check it, because that is the only place the change shows up. Do this
before `agent:implement` reaches the parent; afterwards you are reordering a queue that is already
being consumed.

## What is kept, and what is overridden

`/to-tickets`' slicing judgement is the reason to run it, and it is kept in full: tracer bullets,
sizing each slice to one context, surfacing prefactoring first, expand–contract for wide refactors.

Overridden here, and only here:

| Upstream default | Here |
|---|---|
| publishes flat peers joined by blocking edges | a parent PRD with native sub-issues |
| no ordering contract on creation | created in dependency order, blockers first |
| `ready-for-agent` on every ticket "unless instructed otherwise" | kept — this file is that instruction for the `agent:*` labels only |

That last row is the seam. `/to-tickets` applies triage labels by default and says so; this file
is the "otherwise" it invites, and it spends it on one thing — no ticket in the batch gets a
workflow trigger label.

**Do not edit the upstream skill files to achieve any of this.** They are installed, not vendored,
and they get updated; a local edit is lost on the next update without telling anyone. The bridge
lives in this repo — `CLAUDE.md` and this directory — which is the constraint #87 states and the
reason `docs/agents/` exists at all.
