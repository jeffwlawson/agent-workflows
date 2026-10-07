---
status: accepted
date: 2026-10-07
---

# Personal tooling first; adopter-facing work is parked

#388's survey (`docs/landscape.md`, #389) recommends productising the loop. We decided not to yet.
For its maintainer the loop clearly beats the nearest alternative, GitHub Agentic Workflows
(gh-aw). It runs on a Claude subscription that gh-aw refuses, it runs outside Actions on hardware
we own (#364), and the loop logic is already built and tested: the fix budget, PRD slices, the red
check, review against acceptance criteria. For anyone else the case is unproven. The subscription
advantage mostly serves solo maintainers, since a team sharing one person's subscription raises a
terms question. gh-aw does the plumbing better: several engines, a firewall, threat detection. A
reusable workflow reaches self-hosted runners only for callers with the same owner. And the
project has one maintainer, is eleven weeks old, and has no adopter but its maintainer
(bpc-watch, unraid-stacks).

So work goes to what the maintainer's own repositories use: loop correctness, and the
self-hosted orchestrator (#374, #375, #386, #387). Work that only matters to an outside adopter
is labelled `parked`. It is paused, not refused, and nothing is deleted:

- #344, #346: `init` friction on a second, or non-Node, repository. Already worked around by hand.
- #360, #362: running the agent jobs on an adopter's self-hosted runner. Superseded for us by
  the orchestrator.
- #367: a second agent.
- #371, #372, #373: `doctor` checks against mistakes in callers we write ourselves.
- The rename and the move to the public npm registry (`docs/landscape.md` §6). Not filed.

## Revisit when

- **Someone outside asks to use it.** That is the evidence productising needs. Unpark, then file
  the rename and registry move.
- **gh-aw accepts subscription tokens** (open as
  [github/gh-aw#16498](https://github.com/github/gh-aw/issues/16498)), **or ships a budgeted
  review → fix loop.** Then narrow: offer
  the PRD chain and the red check as gh-aw workflows, and stop maintaining the rest.
- **Anthropic restricts subscription use in automation.** That removes our own cost advantage
  too, and gh-aw likely wins outright.

## Considered options

- **Productise now** (the survey's recommendation). Rejected for now: the gap it names is real but
  narrow, and nobody outside has asked for it. The work it needs (a rename, a registry move,
  `init`/`doctor` polish, a second agent) is all spent on a guess.
- **Narrow into gh-aw workflows.** Rejected for now: gh-aw refuses the subscription token, so for
  us it means paying per use for inference on top of the subscription. It is also a public preview
  that releases several times a week.
- **gh-aw's workflow format as our target, with the subscription and running outside Actions as
  our value-add.** Rejected: both additions go against how gh-aw is built. A subscription token is
  dropped by its secret handling and stripped by its sandbox's API proxy. The only reported
  workaround turns the sandbox off, and the sandbox is gh-aw's main security feature. Running
  outside Actions means reimplementing its compiled job graph, against a safe-outputs spec that
  calls itself a working draft, requires "GitHub Actions artifact storage" for the agent's hand-off,
  and had eight releases flagged as breaking between July and October 2026. gh-aw's own maintainers
  hold back subscription support because they believe Anthropic is restricting it (#16498). That is
  the third revisit condition above, seen from their side. Its extension points (imports, custom
  engines, custom safe-output jobs) would carry the narrow option, inside Actions, if that ever
  becomes the plan.
