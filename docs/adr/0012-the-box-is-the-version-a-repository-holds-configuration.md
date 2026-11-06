---
status: accepted
date: 2026-11-06
---

# The box is the version; a repository holds configuration

One box now serves more than one repository: this one, and `jeffwlawson/unraid-stacks`, a Python
repository whose first run stopped at setup (#818). The maintainer expects 5, 10 or 20. Two worries
came with that: that every release would mean an upgrade in every repository, and that every
repository's toolchain would mean an issue here and a change to the box. The research is in
[`docs/multi-repo.md`](../multi-repo.md); this ADR records what it decided.

## Decision

**On the service, the box is the version.** The dispatcher stamps its own release on every job and
the worker refuses a job from any other (`service/dispatcher.ts`, `service/worker.ts`), so every
subcommand and prompt a repository gets is the box's. A repository on the service has no version of
its own to fall behind. Upgrading the box upgrades every repository at once, and the work is to
make that safe (a fleet check, a setup check after each upgrade, `upgrade.sh <earlier>` to roll
back), not to avoid it.

**A repository holds configuration, under a written contract.** What a repository holds on the
service is its labels, its repository variables, its App installation and, while it has them, its
dormant callers: the *repository contract*. A release keeps to it: a new variable is optional with
a default, a renamed one is read under both names for a release with a warning, and a label change
is converged by the dispatcher, not by `init` in each repository. A release that breaks the
contract says so in its `Adopter-Action` trailer, and says the scope of the action: per box, per
App, or per repository. Per repository is the one to keep rare. Settings the fleet shares (model,
effort, timeouts, the fix-round budget) get fleet defaults in the dispatcher, so a repository
variable is an override and not a requirement; `AGENT_ORCHESTRATOR` and `AGENT_SETUP` stay per
repository.

**Dependencies sit in three layers, each owned by one party.**

1. **The box's base**, owned by the deploy scripts and the same for every repository: the sandbox,
   git, Node, what every language's own tools assume (`python3-venv`, a C toolchain), and the
   toolchain manager. It changes with a release of `deploy/`.
2. **The repository's toolchain**, declared in the repository in a standard file (`mise.toml`) and
   installed inside the sandbox, in user space, into the job's own home, which is thrown away with
   the job. The same file drives the Actions side, which answers #346.
3. **The repository's packages**, `AGENT_SETUP` as now.

What no layer covers is the operator's, in the operator's file (`agent-service.conf`): extra system
packages (`BOX_EXTRA_PACKAGES`), the registry hosts a language needs through the proxy
(`EGRESS_PRESETS`), and, if downloads are ever worth saving, the tool versions to install box-wide
and bind read-only (`BOX_TOOLS`). None of them is a change to this repository.

**Refused: a repository naming what the box installs as root.** A file in a repository is changed by
any pull request, and setup runs the pull request's code, so it would give a pull request root on
the machine that serves every other repository and asks for their tokens. It would also make the
box's one `/usr` the union of every repository's wishes, with nothing ever removed. `AGENT_SETUP` is
an admin-only variable for the same reason.

**Nothing a job writes is kept for another, to start.** Tools and packages are downloaded per job
and discarded. If that is measured to cost too much, the first remedy is the operator-filled,
read-only `BOX_TOOLS` folder, and only after it a cache written by default-branch jobs alone and
handed to others as a discarded copy.

**Unparked:** #346 (non-Node adopters, now answered by layer 2) and #344 (reusing one App on a
second repository, which is what a fleet is). [ADR 0011](./0011-the-service-install-is-for-others-too.md)
parked both; this ADR takes them out of its *Still parked* list. Everything else there stays parked.

## Cost

One release for the whole fleet is also one blast radius: a bad release stops every repository at
once, so the setup check and the rollback carry real weight. The contract is a promise every
release must keep, and a test or a reviewer has to hold it. The toolchain layer adds mise to the
box's base, a download host or two to the proxy's allowlist, and a few seconds to each job. The
dispatcher gains writes it does not make today (labels on every opted-in repository).

## Revisit when

- **A repository needs a system library that `BOX_EXTRA_PACKAGES` cannot give it** without
  breaking another repository. Then the next step is a sandbox `/usr` taken from a container image
  the repository names, not root installs from the repository.
- **Two repositories need different registry hosts that should not both be open to every job.**
  Then the per-repository allowlist moves into the worker's relay, with the proxy's list as the
  box's ceiling.
- **Per-job downloads are measured to matter** against an agent's run. Then `BOX_TOOLS`, then a
  default-branch cache.
- **A release has to break the contract for every repository.** Then the contract, or the fleet
  tooling, is not doing its job.

## Considered options

- **A repository pins its own version on the service**, and the box runs several. Rejected: the
  worker would carry every supported release at once, and the security fixes in a release would
  reach a repository only when it chose to upgrade.
- **The repository lists packages and the box installs them.** Refused, above.
- **An issue here for each new dependency.** Rejected: it makes this repository's tracker the
  bottleneck for every adopter's language, for what is an operator's decision.
- **One tool per language** (`uv` for Python, `fnm` for Node) instead of mise. Fine for two
  languages, not for five. **asdf** reads the same file and is slower; **Nix** or devbox is exact
  and a steep ask of an adopter.
- **A shared, writable tools cache from the start.** Rejected for now: a pull request's setup could
  leave a tampered tool behind for its repository's default branch. Conflicts were not the reason;
  mise keeps each version apart.
