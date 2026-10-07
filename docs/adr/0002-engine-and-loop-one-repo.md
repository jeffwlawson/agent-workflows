---
status: accepted
date: 2026-10-07
---

# Engine and loop: one repository, with a tested boundary between them

The code splits into two kinds. The **engine** is generic plumbing for running an agent against
GitHub: triggers, the separate writer, the egress-locked sandbox, the subscription token, the
orchestrators, and the safety ideas borrowed from gh-aw (writes as a typed, capped list, cleanup of
what the agent posts, threat detection). The **loop** is this project's own workflows: implement,
review, fix, the PRD chain, the red check, and their prompts. We will draw that line **inside this
repository**, enforced by a test that the engine imports nothing from the loop. We will not split
it into two repositories yet.

A separate engine repository would have exactly one consumer, the loop. Its interface would be
designed by guessing what other loops need: the same guess #367 declined for agent neutrality.
Across two repositories, every wrong guess costs a release on one side and a pin bump on the other.
A generic engine is also a product for strangers, which
[ADR 0001](./0001-personal-tooling-before-productising.md) parks. And it competes with gh-aw where
gh-aw is strongest, with the subscription and running outside Actions as its only differences.

The boundary keeps the option open at no cost. Once the engine never imports the loop, moving it
to its own repository is a mechanical change rather than a redesign. #386, which moves the loop out
of the reusable workflows and into the package, is where the line is first drawn.

## Revisit when

A second consumer of the engine exists: a loop that is not this one, or someone outside asking to
run their own workflows on it. That is also ADR 0001's first revisit condition.
