# PRD chains: hold after slice 1

The chain has no pause. When a slice round ends on an approval, review's **advance** re-adds `agent:implement` to the PRD's parent, and the next slice is built at once; the PRD PR stays a draft until every slice is built. So an eight-slice chain can spend dozens of fix rounds with no human, and the first look is at the end. Until chains have earned the maintainer's trust, hold each one after slice 1 and `merge-check` that slice's commits first.

A PRD with one sub-issue needs no hold: its PRD PR is marked ready as soon as the slice is approved, and is an ordinary hand-back.

## The mechanism: a blocker on the parent

`implement-prd`'s gate reads the **parent's open blockers before every slice it builds**, not only the first, and refuses while one is open: it takes `agent:implement` off, adds `agent:blocked`, and comments "It's blocked by #H, which is still open." So a blocker added to the parent after slice 1's run has passed its gate holds the chain at slice 2, and nothing is built.

**Verify it at the pinned release before relying on it**, since a later release may change the gate. Read `implement-prd/gate.ts` at the tag (the same `contents/…?ref=v<tag>` read as the rules): in `preflight`, the `outcome.kind === "build"` branch must call `github.openBlockers(parent)` outside the `chain.landed === 0` block, and return a refusal when it finds one. Where it does not, the hold does not work at that release: say so to the maintainer and run the chain unheld or not at all; that is their call.

## Steps

All of them are part of checkpoint 1's question for this PRD ("build #P, held after slice 1 by a hold issue"), so its yes covers them.

1. **The hold issue.** Create one plain issue, `Hold #<P> after slice 1 for a merge-check`, with a body of one line saying what closes it. No labels: it is not work for the loop.
2. **Start the chain**: `agent:implement` on the parent, alone, and see slice 1's run start on the first sub-issue (github.md).
3. **Then add the edge**, the parent blocked by the hold issue, by the hold issue's database id (`issue-tracker.md`'s *Native relations*). Not before: the gate reads the parent's blockers before slice 1 too, and would refuse it.
4. **Watch** the parent for `agent:blocked` with the gate's "It's blocked by #<H>" comment, and the PRD PR for its slice round's verdict. A slice round that parks the chain instead (a budget spent, no progress) is a parked task: brief it as one.
5. **Check slice 1**: `merge-check` on the PRD PR, graded against slice 1's sub-issue only, on slice 1's commits (the slice range: from the PRD branch's first commit to the last commit before slice 2's, which has not been built). Choose its model as *Hand-backs* says.
6. **Ask**: let the chain run on, or post the findings and add `agent:fix` on the PRD PR. On run on: close the hold issue, remove `agent:blocked` from the parent, then add `agent:implement` again, alone. The edge is left; a closed blocker is not counted.

Record the hold in the ledger as a delegation (the PRD, the hold issue) and the watch by its predicate.
