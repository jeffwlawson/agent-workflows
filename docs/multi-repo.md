# Serving many repositories from one box

Research for the maintainer, 2026-11-06, from `main` at `611ef8a` (v0.9.18). Prompted by adopting
`jeffwlawson/unraid-stacks`, a Python repository, onto the service (#818), and by #346, the same gap
on Actions. The question: how does one box serve 5, 10 or 20 repositories without every release
meaning an upgrade per repository, and without every repository's toolchain meaning a change to the
box? Repo claims carry a `file:line`. Claims about outside tools that were not checked against their
own documentation in this session are marked **UNVERIFIED**. Nothing here was run on a machine.

## Summary

1. **On the service, a repository already has no version of its own.** The dispatcher stamps its
   own release on every job, and the worker refuses a job from any other (`service/dispatcher.ts:762`,
   `service/worker.ts:2423-2427`). Every subcommand and prompt comes from the box's install. So the
   "box upgrades while the repo is older" worry is about the few things a repository *holds*, not its
   code, and those can be made the service's job to keep current. Upgrading the box is already
   upgrading every repository at once; the work is to make that safe, not to avoid it.
2. **Split dependencies into three layers, owned by different people.** The box's base (the same
   for every repository, changed only by a release of the deploy scripts); the repository's
   toolchain (declared in a standard file in the repository and installed **in user space, inside
   the sandbox**, never as root); and the repository's packages (`AGENT_SETUP`, as now). That keeps
   a new language out of this repository's issue tracker.
3. **Do not let a repository tell the box what to install as root.** A file in the repository can be
   changed by any pull request, setup runs the pull request's code, and the box serves every
   repository. The case is in section 3.2.
4. **Catch a missing dependency before the first labelled issue,** with a setup check: run the
   toolchain, `AGENT_SETUP` and the verify command on the default branch, in the sandbox, and report.
   Run it for every repository after a box upgrade, and the fleet has a smoke test.
5. **Order:** #818 and two operator settings now (they unblock `unraid-stacks`); the setup check;
   the toolchain layer, which also answers #346 on Actions; then the service keeping each
   repository's labels and settings current. Section 6.

## 1. What a repository holds, on each orchestrator

| | Actions | Service | Moves with a release? |
|---|---|---|---|
| The loop's code and prompts | the caller's pin, per repository | the box's release, for every repository | service: once, on the box |
| Toolchain | runner image, `node-version-file`, `setup:` | the box's `/usr`, bound read-only into the sandbox (`engine/bwrap-args.ts:123`), and `AGENT_SETUP`; `node-version-file` is not supported (`docs/deploying-the-service.md:831-833`) | service: whenever the box's packages change |
| Network for setup and agent | open | one allowlist for the whole box (`deploy/unraid/install-box.sh:224-234`: Anthropic, GitHub, npm) | when the box's allowlist changes |
| Labels | `init` converges them (`setup/labels.ts`) | the same; nothing on the service does | when a release adds or recolours one |
| Settings | repository variables | repository variables, read per job (`service/job.ts:13-48`) | when one is added or renamed |
| App permissions and events | per App and installation | per App and installation | once per account, not per repository |
| Callers | live | dormant: every job skips (`.github/workflows/fix.yml:135`), still pinned | only if the repository goes back to Actions |

The only `Adopter-Action` trailer in the history so far is an App permission (`git log`), which is
per account. Nothing yet has needed a per-repository change on the service, but labels and variables
could.

## 2. Versions

### 2.1 What is left to drift, and who should fix it

- **Labels.** A release that adds a label (as `agent:merge` once did) needs `init` re-run in each
  repository today. **The dispatcher should converge them itself**, for each opted-in repository, at
  its start and on an installation event, with the App's token (it can already write issues). Then
  a new label needs nothing per repository.
- **Settings.** Twenty repositories each holding `AGENT_MODEL`, `AGENT_EFFORT_*`, timeouts and the
  fix-round budget is twenty places to change one decision. **Give the dispatcher fleet defaults**:
  the same names in its settings, used where a repository leaves the variable unset, so a repository
  variable is an override, not a requirement. `AGENT_ORCHESTRATOR` and `AGENT_SETUP` stay per
  repository: the first is the opt-in and the second is the repository's own.
- **Dormant callers.** They change nothing while the service serves the repository. A caller pinned
  before v0.8.3 has no skip and would run on Actions as well, which `doctor` already checks
  (`setup/doctor.ts:284-289`). To confirm: whether a service-only repository needs callers at all.
  If not, `init` for such a repository should write none, and there is no per-repository pin left to
  bump.

### 2.2 A repository contract

Name what a repository holds (the table above, less the code) as **the repository contract**, and
hold releases to it: a new variable is optional with a default; a renamed one is read under both
names for a release, with a warning; a label change is converged by the dispatcher. A release that
breaks it says so in its `Adopter-Action` trailer, which should also say its **scope**: per box, per
App, or per repository. Per repository is the one to keep rare, and a fleet check (2.3) is how it is
found.

### 2.3 One upgrade, every repository: make it safe

One version for the fleet is the strength of the service and also its blast radius: a bad release
breaks all twenty at once. What there is: `upgrade.sh <earlier>` rolls back
(`deploy/unraid/upgrade.sh:155`), and this repository runs on the box first. What to add:

- **A fleet check**, run on the box beside `status.sh`: every repository the App is installed on
  with `AGENT_ORCHESTRATOR=service`, and for each what `doctor` would say from the service's side
  (labels, a refused variable, `AGENT_SETUP` unset, a caller pinned before the guard). It is
  `doctor` for N repositories, with the App's token instead of a person's.
- **A written upgrade routine:** upgrade, run the setup check (section 4) for every repository, roll
  back on a failure. That turns "every repository at once" into "every repository checked at once".

## 3. Dependencies

### 3.1 Three layers

1. **The box's base.** Owned by the deploy scripts and the same for every repository: `bubblewrap`,
   `git`, `curl`, Node, and the few things every language's own tools assume: `python3-venv` (#818)
   and a C toolchain (`build-essential`, since packages with native parts compile on install), plus
   the toolchain manager below. It changes with a release of `deploy/`, not with a repository.
2. **The repository's toolchain.** Which Node, Python, Go or Rust, at which version. Declared in the
   repository in a standard file that also works on a laptop and in CI, and installed **inside the
   sandbox**, in user space, into the job's own home, which is thrown away when the job ends, as
   everything setup makes is today (section 3.3). No root, no change to the box, and two
   repositories wanting different versions of Python never meet.
3. **The repository's packages.** `AGENT_SETUP`, as now: `npm ci`, `uv sync`,
   `pip install -r` into a virtual environment in the checkout.

For layer 2, the recommendation is **mise** (`mise.toml`, or `.tool-versions`): one binary on the
box, prebuilt runtimes downloaded rather than compiled, and an Actions step to read the same file
(`jdx/mise-action`). From mise's own docs (`mise.jdx.dev/lang/python.html` and
`/configuration.html`, read 2026-11-06): Python is a prebuilt build from python-build-standalone by
default, needing no compiler, with its list of builds fetched from `mise-versions.jdx.dev`; files
such as `.nvmrc` and `.python-version` are read only once a setting turns them on, so `mise.toml` is
the file to ask for; and a `mise.toml` can set environment variables and run commands, which is why
mise has a trust check, and why it runs inside the sandbox here. Still **UNVERIFIED**: the full list
of download hosts for each runtime. The alternatives:
asdf (the same file, slower, plugins are shell scripts); Nix or devbox (exact and reproducible, and a
steep thing to ask of an adopter); one tool per language (`uv` for Python, `fnm` for Node), which is
fine for two languages and not for five.

The same file answers #346 and the `node-version-file` gap: the Actions reusables gain a step that
installs from the repository's toolchain file when there is one, and the service does the same
inside the sandbox. A non-Node repository then declares its toolchain once, for both orchestrators.

**System libraries** (an `apt` package such as `libpq-dev`, below every user-space tool) are the case
layer 2 cannot reach. For now, an operator setting: `BOX_EXTRA_PACKAGES` in `agent-service.conf`,
which `install-box.sh` installs and `check-box.sh` checks, so it is the operator's decision in the
operator's file and not a change to this repository. Later, only if a repository needs it: the
sandbox's `/usr` taken from a container image the repository names, extracted to a directory and
bound by `bwrap` in place of the host's, which keeps today's sandbox and proxy unchanged.

**Network.** Every language fetches from its own registry, and the proxy's allowlist is box-wide.
Now: named presets in `agent-service.conf` (`EGRESS_PRESETS="python"` adding `pypi.org` and
`files.pythonhosted.org`, and so on), so an operator turns on a language, not a list of hosts.
Later: a per-repository allowlist enforced in the worker's own relay (`engine/proxy-relay.ts`), which
already carries every request out of the sandbox, with tinyproxy's list as the box's ceiling.

### 3.2 Why not "the repository lists its packages and the box installs them"

It is the obvious design and the wrong one here, for three reasons:

- **A pull request would get root on the box.** A file in the repository is changed by any pull
  request; `AGENT_SETUP` is a variable only an admin can set, for this reason
  (`docs/deploying-the-service.md:794-797`). Installing as root from a file turns a pull request into
  root on the machine that serves every other repository and asks for their tokens. Reading the file
  from the default branch only, against an allowlist, is safe, and is then the operator's list with
  extra steps.
- **One `/usr` for every repository.** The box becomes the union of what all of them ever asked for,
  with conflicting versions and nothing ever removed, and `check-box.sh` can no longer say what the
  box should hold.
- **Every repository's change is a root change on shared infrastructure,** which is what made the
  upgrade path long in the first place (ADR 0011).

So, to the question of opening an issue here for each new dependency: no. A runtime is the
repository's own file (layer 2). A system library or a new registry host is the operator's
`agent-service.conf`. Only the base (layer 1) is this repository's code, and it changes rarely.

### 3.3 Keep nothing between jobs, to start

Start with every job downloading its tools afresh and throwing them away at the end, as setup's
packages already are. Nothing is shared between jobs, so nothing can be left behind by one for
another: not by another repository, and not by a pull request for its own repository's default
branch, which is the case that matters, since setup runs the pull request's code. The cost is a
download per job, small against an agent's run: a prebuilt Python or Node is tens of megabytes
(an estimate, not measured here). The run logs time each phase, so measure it before building more.

Conflicts between repositories are not a reason to throw tools away: mise keeps each version of each
tool in a folder of its own, so Python 3.11 and 3.13 sit side by side. Trust is the reason. If the
downloads are ever measured to cost too much, the cache to add is one folder per tool and version,
written only by jobs on a default branch and handed to every other job as a copy that is discarded,
as Actions scopes its cache, and the same then for the package caches (npm, pip).

A simpler fast path, if one is wanted: a **box-wide tools folder the sandbox can only read**, filled by
the operator rather than by any job. `agent-service.conf` lists the versions (`BOX_TOOLS="python@3.12
node@22"`), `install-box.sh` installs them with `mise install --system` (into
`/usr/local/share/mise/installs`, per mise's `directories` page), and every sandbox binds that folder
read-only. A job whose versions are there downloads nothing; one asking for another version
downloads it into its own throwaway home, as above. No job can write to it, so nothing is left
behind for another, and no repository's file decides what is in it. **UNVERIFIED**: whether mise run
as an ordinary user picks up system installs on its own, or needs a setting to.

## 4. Fail before the first labelled issue

Both #818 and #346 failed on the first real run, with `doctor` clean, because nothing ran the
repository's setup before then. A **setup check** closes that: a job kind the dispatcher can start
(from a label on an issue, or from the fleet check) that, on the default branch and in the sandbox,
installs the toolchain, runs `AGENT_SETUP`, runs the verify command `CLAUDE.md` names, and posts what
happened: the step that failed and the end of its output. It starts no agent, so it costs no usage.
Run for every repository after an upgrade, it is also the fleet's smoke test (2.3).

#346's other parts still stand for Actions: `doctor` checking the toolchain inputs against the
checkout, the caller comment, and a reason for a failed toolchain step.

## 5. Capacity

Twenty repositories share one queue and one Claude plan, and usage, not the box, is the limit. Two
things to keep in mind, neither urgent: a queue served in arrival order lets one busy repository
starve the rest (round-robin per repository is the cheap fix, before any concurrency, #627); and a
fleet that grows needs the plan to grow with it.

## 6. Order

1. **Now:** #818 (`python3-venv`, and the deployment guide saying the base is box-wide), plus
   `BOX_EXTRA_PACKAGES` and `EGRESS_PRESETS` in `agent-service.conf`. Small, `deploy/` only, and
   it unblocks `unraid-stacks`.
2. **The setup check** (section 4).
3. **The toolchain layer:** mise on the box, run in the sandbox with nothing kept between jobs,
   and the Actions step reading the same file. Answers #346 part 2 and the `node-version-file` gap.
4. **The service keeps repositories current:** labels converged by the dispatcher, fleet defaults
   for settings, the fleet check, and `init` writing no callers for a service-only repository if
   none are needed.
5. **An ADR** recording "the box is the version; a repository holds configuration", the three
   layers, and the refusal in 3.2: [ADR 0012](./adr/0012-the-box-is-the-version-a-repository-holds-configuration.md),
   filed with this document. ADR 0011 parked #346 and #344 (a second repository); 0012 unparks them.

Later, on evidence: a container image's `/usr` for system libraries, a per-repository allowlist in
the relay, a fair queue.
