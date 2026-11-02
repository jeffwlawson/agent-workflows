---
status: accepted
date: 2026-11-02
---

# The service install is for others too; the contract is the product

[ADR 0001](./0001-personal-tooling-before-productising.md) parked work that only an outside adopter
needs, until someone outside asks. Nobody has. The maintainer now wants the self-hosted service
(the dispatcher and the worker, `docs/deploying-the-service.md`) to be something other people can
install, as well as himself, because the install is also too long for him: 23 steps and 12 typed
values the first time, and five ssh and two sudo prompts for one upgrade. This ADR supersedes 0001
in part. It does not claim 0001's first revisit condition has been met; it records a different
decision, taken for the maintainer's own reasons.

## Decision

**Unparked: an install others can run, for the self-hosted service.** One front door
(`agent-service.sh`) that installs, upgrades, checks and removes; deploy scripts shipped and
verifiable with each release; a `LICENSE` file; and an install that asks for a few things once.
The order is in `docs/installability.md`, section 4. The Actions-side path (the reusable workflows,
`init`, `doctor`) is untouched by this ADR.

**The contract is the product; the adapters are conveniences.** The service runs where its
operator is comfortable with the security of it, as Sandcastle lets its operator pick a sandbox
(`docs/landscape.md`). What makes that safe is a written contract any host must meet: the worker is
fenced in by the sandbox, reaches only an allowlist through a proxy, and gets its GitHub tokens,
short-lived, from the dispatcher's token door; the host drops the box's traffic to private ranges;
the machines share one secret. The check scripts already assert it, and `agent-service.sh check`
is the evidence shown to whoever installs. The install keeps what is specific to Claude (its sign-in token, its CLI on the box, the
Anthropic host in the proxy's allowlist) in named places and out of the flow, so a second agent
(#367) is a later addition and not a rewrite. A host file (`host/unraid.sh` first, then
`host/linux.sh`) implements the host-specific steps behind the one flow. Where it cannot give a
guarantee, it says so, and the check reports it; the operator makes the security call.

**Contributions.** Others may add host adapters as pull requests, once the adapter interface, a
`CONTRIBUTING.md` and the licence exist. A pull request carries the adapter, its host's
documentation, stubbed tests and the contributor's own `check` output from a real install. Two
tiers are stated in the docs: *maintained* (the maintainer runs it on a release) and *community*
(contributor-tested, may lag). These are scripts run as root on other people's machines, so a
change under `deploy/` is merged by the maintainer, as `agent:merge` already leaves the decision
to a person ([ADR 0009](./0009-agent-merge-executes-the-human-decision.md)).

**Still parked,** with the `parked` label: #360 and #362 (adopters' self-hosted runners), #367 (agent
neutrality: the maintainer's long-term aim is that the loop is not tied to Claude and works with
any suitable agent, as Sandcastle does, but that is far off, and an API-key path may come first for
people who cannot use a subscription), #371 to #373 (`doctor` checks on callers), #344 and #346 (`init` on a second or
non-Node repository), and the rename and registry move. Also far off, and it may not be feasible: running the loop's
workflows on platforms other than GitHub (GitLab, Linear and the like). The loop leans on GitHub's
labels, pull requests, review threads and App at every step, so that would need those behind an
interface first; there is no issue for it and this ADR builds nothing toward it. Nothing here
depends on any of these: the service
installs from the release tarball, which needs no token.

## What is not decided

`docs/installability.md`, section 5, lists ten decisions (D1 to D10). This ADR settles none of
them: the licence, immutable releases, where the App's manifest server runs and the wording of the
subscription terms gate the later phases, and are made when those phases start.

## Cost

Review: every adapter is a root script the maintainer must read. Support: each host the docs name
is one more thing to answer for, which is why the tiers are stated up front. Time: the install is
rebuilt in phases (`docs/installability.md`, section 4) that the loop builds one at a time, and
the first phases touch only the Unraid scripts that exist. The terms of using a Claude subscription
for other people's automation are not settled by this ADR (`docs/installability.md`, Q8).

## Revisit when

- **The first outside person completes an install.** That is the evidence for the next unparking
  step (a Community Applications template, the registry move, the rename), by 0001's own rule.
- **Anthropic restricts subscription use in automation.** The same condition as 0001: it removes
  the cost advantage, and the install loses its main reason to exist.
- **Reviewing adapters costs more than the maintainer can give.** Then narrow to the Unraid pair
  and stop accepting others.

## Considered options

- **Leave it parked** (0001 as it stood). Rejected: the maintainer's own install is too long, and
  the work to shorten it is the same work others need.
- **One installer for any machine.** Rejected: the security the service relies on is a property of
  the host (a firewall, a sandbox, a proxy), so a script that hides the host would hide whether
  that property holds. A contract plus adapters keeps it visible.
- **Polish the Unraid scripts and stop.** Kept as the first phases, and rejected as the end state:
  it serves the maintainer and no one else.
