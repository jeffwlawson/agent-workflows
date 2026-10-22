# Deploying the service orchestrator

The loop has two orchestrators. The **Actions orchestrator** is the callers and reusables
[ADOPTING.md](./ADOPTING.md) installs. The **service orchestrator** is two processes you run on a
machine of your own, so the agent spends none of your Actions minutes:

- the **dispatcher**, which holds the GitHub App's key, receives GitHub's webhooks, decides which
  delivery is a job, and mints a short-lived token, scoped to one repository, each time the worker
  asks for one;
- the **worker**, which receives jobs from the dispatcher and runs review, fix, update-branch and
  implement the way `review.yml`, `fix.yml`, `update-branch.yml` and `implement.yml` do, with the
  runner in a sandbox.

Each is a subcommand of the published package, so deploying the service is configuration rather
than a build. A
repository opts in with the repository variable `AGENT_ORCHESTRATOR=service`
([ADOPTING §2e](./ADOPTING.md#2e-choosing-the-orchestrator)); the service refuses every other
repository, and answers `agent:review`, `agent:fix` and `agent:update-branch` on a pull request
and `agent:implement` on a regular issue, and nothing else. A PRD labelled `agent:implement` gets
silence, as on Actions, where `implement` defers it to `implement-prd`, which the service does not
run yet.

## What a host needs

Whatever the machine, the service needs:

- **Linux** for the worker, since the sandbox is Linux's: bubblewrap runs on user namespaces.
  Where the distribution restricts unprivileged user namespaces (Ubuntu 24.04's AppArmor does),
  allow them for `bwrap`. The dispatcher runs anywhere Node does.
- **bubblewrap** (`bwrap`) on the worker's host, for `AGENT_SANDBOX=bwrap`, the default.
- **A webhook endpoint GitHub can reach**: the dispatcher's webhook door, published through a
  reverse proxy or a tunnel. Nothing else of either process is published.
- **A proxy** the agent's traffic leaves through (`AGENT_SANDBOX_PROXY`), allowing what a review
  needs (GitHub, the model's API, the package registries) and nothing else. bubblewrap shares the
  host's network with the sandbox, so the proxy, and a firewall around the worker's host, are
  where its egress is controlled.
  Where the host's firewall lets the worker out only through a proxy, the worker's own traffic
  needs it too: its install of the agent's CLI, its token requests, and every step it runs, which
  `WORKER_PROXY` sends through it.
- **Node 24.14 or later** for both processes, with `git` and `npm` beside the worker, and read access
  to the registry the package is published to.
- **The GitHub App**, below.

The two processes may share a machine. Keeping the App's key off the machine that runs agents is
the point of the split, so put the worker on a machine, or a VM, of its own where you can.

## The GitHub App

The service acts as a GitHub App you own, which may be the loop's own App (ADOPTING §2) or one of
its own. Its login, `<slug>[bot]`, is what the service's reviews are posted as, and the dispatcher
reads it off the App's own record rather than from a setting, so a typo cannot make every round
the first.

### Permissions

Repository permissions:

| Permission | Access | Why |
|---|---|---|
| Metadata | read | every API call, and a label's sender's permission |
| Variables (`actions_variables` in the API) | read | `AGENT_ORCHESTRATOR`, re-read at every token, and the variables the service reads, `AGENT_SETUP` among them: the repository's own, else its organization's shared with it, as `vars` resolves them |
| Contents | write | the checkout and the pull request's history, read by every phase; a push, by a `push` token only |
| Pull requests | write | the review, its threads, the title and summary, and the ready mark |
| Issues | write | comments and labels, the issue an implement job builds, and a PRD's parent |
| Checks | read | CI's result, which the review's verdict reads |
| Commit statuses | write | the verdict and the fix-round statuses |
| Workflows | write | a push touching `.github/workflows/**` is refused without it, *after* the agent has done all its work |

The worker asks for one of three kinds of token at each phase: `read`, which every phase reads
with and the only one the runner is ever handed; `write`, which adds the pull request, issue and
status writes of the phases that post; and `push`, which adds Contents: write and Workflows: write
to `write`, for the phases that push and run no agent. Contents: write together with Workflows: write
is the pair that lets a holder push a workflow into a repository whose runs carry secrets, which is
why it is a kind of its own rather than a wider `write`, and why it is acceptable at all: as on
Actions (ADOPTING §2), neither the App's key nor a `push` token is ever where the agent runs. The
key stays with the dispatcher, and a token reaches a subcommand only where its phase was handed it.

A permission the App lacks fails the mint of the token that asks for it, so it is named in the
dispatcher's log as the job's phase starts, rather than surfacing as a failed write mid-run.

Under *Where can this GitHub App be installed?*, choose **Only on this account**. A public App
can be installed by anyone, on their own repositories, and every one of those would otherwise be a
repository the dispatcher might run agents for on your machine. The dispatcher's own check is the
second line of defence: it serves an installation only on the App's owner's account, which it reads
off the App's own record at start, or on an account its `EXTRA_OWNERS` setting lists, and refuses
every other, with the reason in its log.

Install the App on each repository the service is to serve. Installing it on all your
repositories enrols none of them: the dispatcher acts only where `AGENT_ORCHESTRATOR` is `service`.

### The webhook

In the App's settings, under *Webhook*:

- **Active**, with the **Webhook URL** the address your dispatcher's webhook door is reached at
  from the internet, ending `/github`;
- a **Webhook secret**, which is the dispatcher's `GITHUB_WEBHOOK_SECRET`;
- under *Subscribe to events*, **Pull request** and **Issues**. An issue's label reaches the
  dispatcher only on an `issues` delivery, so without **Issues** nothing answers `agent:implement`.

GitHub's *Recent Deliveries* page shows each delivery and the dispatcher's answer: `202` for every
delivery whose signature verified, whatever became of it, and `401` for one that did not. What
became of it is in the dispatcher's log.

## The dispatcher

The one process that holds the App's key. It needs:

- Node 24.14 or later, and the package (`npm exec @jeffwlawson/agent-workflows@<version> dispatcher`,
  or an install of it);
- the App's private key in a file it can read;
- its **webhook door** reachable from the internet, through whatever you use to publish a port
  (a reverse proxy, a tunnel);
- its **token door** reachable from the worker, and from nothing else. The two are separate
  listeners so the one you publish mints nothing;
- the worker's job door reachable from it.

It answers each delivery at once and does its work afterwards, and a delivery becomes a job only
when all of these hold:

- it is a pull request, or a regular issue, labelled with a label the service answers on that
  event (`SERVICE_LABELS` in `service/dispatcher.ts`, the labels its `LABEL_KINDS` maps to a job
  kind, per event: on a `pull_request` delivery `agent:review` to a review job, `agent:fix` to a
  fix job and `agent:update-branch` to an update-branch job, and on an `issues` delivery
  `agent:implement` to an implement job). A label is answered on its own event only, and an
  `issues` delivery about a pull request is ignored;
- the App is installed on the repository;
- the installation is on the App's owner's account, or on one `EXTRA_OWNERS` lists;
- the repository's `AGENT_ORCHESTRATOR` is `service`;
- on a pull request, the head is in the same repository, not a fork; an issue has no head;
- a pull request is open. An issue's state is not checked here: a closed issue becomes a job, and
  `implement:gate` refuses it on the issue and takes the label off, as on Actions;
- the label's sender can write to the repository, or is the App itself (`<slug>[bot]`), whose
  labels the loop's own commands add (ADR 0008).

Every other delivery is logged with its reason. A job carries what the label's event carried, the
repository variables the service reads (`AGENT_MODEL`, `AGENT_MODEL_REVIEW`, `AGENT_MODEL_FIX`,
`AGENT_MODEL_UPDATE_BRANCH`, `AGENT_MODEL_IMPLEMENT`, `AGENT_REVIEW_TIMEOUT_MINUTES`, `AGENT_TIMEOUT_MINUTES`, `AGENT_MAX_FIX_ROUNDS` and `AGENT_SETUP`,
each unset as empty), the App's login, a job id, a deadline and the package's version. An
implement job carries the issue's number, title and state, and the repository's default branch as
its base, which stands in for the `default-branch` a caller hands `implement.yml`. The
deadline is the job's own time limit, review's, or fix's, update-branch's and implement's (below), plus `JOB_DEADLINE_MARGIN_MINUTES`.
It carries no token: the worker asks for one per phase, `read`, `write` or `push`, and the dispatcher mints
one only for a job it dispatched, before that job's deadline, for that job's repository alone, while
the installation is still on an account it serves, and after reading `AGENT_ORCHESTRATOR` again. Deleting the variable stops a job in flight at its next
phase.

### Settings

Read from the environment. A missing required one stops the dispatcher at start, naming each, and
so does an App whose own record cannot be read, since that is where the App's owner comes from.
`tests/service/settings.test.ts` holds this table equal to `DISPATCHER` in `service/settings.ts`.

| Setting | Kind | Default | Meaning |
|---|---|---|---|
| `GITHUB_APP_ID` | required | | the App's ID |
| `GITHUB_APP_PRIVATE_KEY_FILE` | required | | a path to the App's private key, in PEM |
| `GITHUB_WEBHOOK_SECRET` | required | | the App's webhook secret |
| `WORKER_URL` | required | | the worker's job door, where a job is posted |
| `WORKER_SECRET` | required | | the secret the dispatcher and the worker share, which signs a job and a token request |
| `WEBHOOK_HOST` | optional | `127.0.0.1` | the address the webhook door listens on |
| `WEBHOOK_PORT` | optional | `8790` | the webhook door's port; GitHub's deliveries arrive at `POST /github` |
| `TOKEN_HOST` | optional | `127.0.0.1` | the address the token door listens on: one the worker reaches |
| `TOKEN_PORT` | optional | `8791` | the token door's port; the worker asks at `POST /token` |
| `JOB_DEADLINE_MARGIN_MINUTES` | optional | `60` | added to a job's own time limit for its deadline, review's (its CI wait and `AGENT_REVIEW_TIMEOUT_MINUTES`) or fix's, update-branch's and implement's (`AGENT_TIMEOUT_MINUTES`), covering the phases around the runner's and the time a job waits in the worker's queue |
| `EXTRA_OWNERS` | optional | `""` | accounts, comma-separated, whose installations the dispatcher serves besides the App owner's; empty is none. An installation on any other account is refused |

Each door also answers `GET /health` with `200`.

### What it does not keep

- **A delivery that arrives while the dispatcher is down is lost.** GitHub does not redeliver on
  its own; redeliver it from the App's *Recent Deliveries*, or remove the label and add it again.
- **The jobs it dispatched are held in memory.** A dispatcher restarted mid-job refuses that job's
  next token request as unknown, and the job ends there. Remove the label and add it again.

## The worker

The process that runs review, fix, update-branch and implement. It holds no key: it asks the dispatcher for a token at the
start of each phase. For review: `read` for the gate, the checkout, the budget and the CI wait, a
fresh `read` for the runner, so the token's hour starts as the agent does, and `write` for
`review:publish` and `review:conclude`. For fix: `write` for `fix:gate`, which posts its refusal and
probes the label; `read` for the checkout and `fix:prepare`, and a fresh `read` for the runner;
none for `fix:bundle`; and `push` for `fix:publish` and `fix:conclude`, the only phases that push. Where the `push`
token is refused, nothing is published, and `fix:conclude` asks for `write` instead, to post the
round's ending without a rescue. For update-branch: `write` for `update-branch:gate` and
`update-branch:merge`, which runs in the worker's checkout, outside the sandbox, and pushes nothing;
`read` for the agent's checkout and `update-branch:prepare`, and a fresh `read` for the runner; none
for `update-branch:bundle`; and `push` for `update-branch:publish` and `update-branch:conclude`, with
`write` for conclude where `push` is refused, as fix's. For implement: `write` for
`implement:gate`, which posts its refusals and the start comment and probes the label; `read` for
the checkout of the base, and a fresh `read` for the runner; none for `implement:prepare` and
`implement:bundle`; and `push` for `implement:publish` and `implement:conclude`, with `write` for
conclude where `push` is refused. A gate that refuses ends any of the three jobs there, as it
skips the publish job on Actions, and so does implement's deferral of a PRD: no token is asked for
after it, and neither publish nor conclude runs. A gate that failed before it decided is not a
refusal, and conclude still runs.
The runner never holds a token that writes. It needs:

- Linux, Node 24.14 or later, `git`, `npm`, and the package (`npm exec
  @jeffwlawson/agent-workflows@<version> worker`, or an install of it) at the **same version as the
  dispatcher**: a job from a dispatcher of another release is refused, `409`, and the dispatcher
  logs that the worker answered it;
- `bwrap` (bubblewrap), unless `AGENT_SANDBOX` says `none`, and a proxy for the agent's traffic
  (`AGENT_SANDBOX_PROXY`);
- its **job door** reachable from the dispatcher, and from nothing else;
- the dispatcher's token door reachable from it.

At start it installs the agent's CLI, `@anthropic-ai/claude-code` at `CLAUDE_CODE_VERSION`, into
`WORK_DIR/claude-code/<version>`, and refuses to start where the install fails. The host's own
`claude` is never used: the worker's goes first on the runner's `PATH`, first on
`AGENT_SANDBOX_PATH`, and into `AGENT_SANDBOX_RO_BINDS`. Bind the Node the agent's CLI runs on
read-only too, through `AGENT_SANDBOX_RO_BINDS`, and put it on `AGENT_SANDBOX_PATH`.

Jobs run one at a time, in the order they arrived. Each runs the subcommands its reusable runs, in
its order and under its conditions (spec §6 for `implement.yml`, §8 for `review.yml`, §9 for
`fix.yml`, §10 for `update-branch.yml`), each a child process of the worker's own
install, with an environment built from its declaration in the contract and the host's `PATH`,
`HOME` and `LANG`, and nothing else of the worker's. Not run, at this release: the red check. The
repository's setup is run by a fix job, an implement job, and an update-branch job whose merge
conflicted, before its runner, and not by a review, as on Actions.

The fix-round budget is the repository's `AGENT_MAX_FIX_ROUNDS`, read as on Actions: a review
asking for changes under a budget with a round left adds `agent:fix`, which the dispatcher answers
as the App's own label, and a spent budget leaves the round to a human, with the comment Actions
posts. Since the worker runs one job at a time, a fix round starts only once the review that asked
for it has finished, and the `agent-fix-round` status the budget counts stops the cycle.

A fix job runs `fix:gate`, then the agent's job: the checkout of the head the label's event named,
with the base, `fix:prepare`, which fetches a stopped round's rescue branch into it, the setup, the
runner, and `fix:bundle`, however those ended. Then `fix:publish` pushes the agent's commits and
asks for the re-review, and `fix:conclude` ends the round, pushing a stopped round's commits to
`agent/rescue/fix-<n>` for the next round to resume from. The checkout keeps no token in its
configuration: each command is handed its token in its environment. It does keep a committer, the
App's login and its no-reply address, as `fix.yml`'s checkout sets one, since the agent commits.

An update-branch job runs `update-branch:gate`, and ends there where it refused; where it claimed the run, it checks the head out
with the base and runs `update-branch:merge` there. A clean merge, or a branch already up to date,
goes straight to `update-branch:publish`, which makes the merge again in a checkout of its own,
pushes it and carries the verdict over; no setup and no runner run. A merge that conflicts runs the
agent's job first, in a third checkout: `update-branch:prepare`, which makes the same merge again,
the setup, the runner, and `update-branch:bundle` where those succeeded. Publish then pushes the
resolution and adds `agent:review` as the App, which the dispatcher answers as the App's own label.
`update-branch:conclude` ends every run, and asks for `agent:update-branch` again, as the App, where
the head moved on while the job ran and no other trigger label is on.

An implement job runs `implement:gate`, and ends there where it refused the issue or deferred a PRD
to implement-prd. Where it claimed the run, the agent's job checks out the commit the gate read the
default branch at, and runs `implement:prepare`, which creates the agent's branch there, the setup,
the runner, and `implement:bundle` where those succeeded. Where they did, `implement:publish`, in a
checkout of the base of its own, pushes the branch, opens the draft pull request as the App, links
it on the issue and adds `agent:review` as the App, which the dispatcher answers as the App's own
label: the pull request then flows into review. `implement:conclude` ends every run. The service
has no run page, so the link the implement commands give where Actions links its workflow run (the
start comment, the pull request's frame, the link on the issue and the failure comment) is the
App's own page, `https://github.com/apps/<slug>`.

On a PRD pull request (head `agent/prd-…`), where the review went ahead and the head did not move
while it ran, the worker asks for one more `write` token and runs `review:advance` after
`review:conclude`, as the reusable's advance job does. Advance may put `agent:implement` back on
the PRD's parent. The service answers that label with an implement job, whose gate defers a PRD to
implement-prd without a word, and the service does not run implement-prd yet, so on a repository it
serves the chain waits there for an orchestrator that does, or for you: that is expected.

`review:conclude` runs however the phases before it ended, and is told each one's real outcome: a
runner that failed, with the reason it wrote; a token the dispatcher would not grant; a publish
that failed; a phase ended at its time limit. A run that ends before anything can write to the
pull request, because no token to write with was granted, says why in the worker's log instead.

Each run leaves a directory under `WORK_DIR/runs`, named for when it started and its job: the
checkout (an update-branch job's `gate-checkout`, `checkout` and `publish-checkout`, and an
implement job's `checkout` and `publish-checkout`, one per job of its reusable that checks out), each subcommand's output directory under `out/` and its log under `logs/`, and
`summary.json`, the job, each phase's outcome, and each subcommand's environment, with every token
redacted. The worker's own log says how each phase ended, redacted the same way. Nothing removes
old runs: prune `WORK_DIR/runs` as you see fit.

Every phase has a time limit, as every job on Actions does, so a hung agent cannot hold the queue.
The gate, the checkout, the budget, the CI wait and the runner share the review's: 15 minutes of CI
wait plus `AGENT_REVIEW_TIMEOUT_MINUTES` (5 where unset). `review:publish` and `review:conclude`
get 10 minutes each, and `review:advance` 5. A phase still running at its limit is ended, with every process it started,
and the pull request's ending says the review timed out. A fix job's gate gets 15 minutes; the
checkout, `fix:prepare`, the setup and the runner share `AGENT_TIMEOUT_MINUTES` (30 where unset);
`fix:bundle` gets 5 minutes of its own, so a round stopped at its limit still hands its commits
over; and `fix:publish` and `fix:conclude` 15 each. A round ended at its limit still bundles,
publishes and concludes: its ending says it timed out, and any commits it made are rescued. An
update-branch job's gate, checkout and merge share 15 minutes; the agent's job's steps share
`AGENT_TIMEOUT_MINUTES` (30 where unset), and a refresh ended at it pushes nothing and says it timed
out; publish's checkout and `update-branch:publish` share 15 minutes, and `update-branch:conclude`
gets 15. An implement job's gate gets 10 minutes; the agent's job's steps share
`AGENT_TIMEOUT_MINUTES` (30 where unset), and a build ended at it publishes nothing and says it
timed out; publish's checkout and `implement:publish` share 15 minutes, and `implement:conclude`
gets 15. A job that waits in the queue for longer
than the dispatcher's `JOB_DEADLINE_MARGIN_MINUTES` is past its deadline by the time it asks to
post, and ends with nothing posted, so set the margin above the longest wait you expect.

### The repository's setup

A repository's setup is its repository variable `AGENT_SETUP`: a script, the install and anything
else its verify command needs, the same text a caller's `setup:` input holds on Actions. Only an
admin can set it. The dispatcher reads it with the other variables and the job carries it; the
worker hands it to the sandbox's shell through the environment, as written, and never splices it
into a command line. Unset or empty, the setup is skipped. A fix job runs it after `fix:prepare`
and before its runner, an implement job after `implement:prepare`, and an update-branch job after `update-branch:prepare`, only where its merge
conflicted; a review runs none, as `review.yml` runs none. A setup that fails starts no
runner, and the round's failure comment quotes the end of its output.

It runs **in the bwrap sandbox, never on the worker's host**, whatever `AGENT_SANDBOX` says of the
agent's, since the host holds what can ask for tokens and setup runs the pull request's code. So
`bwrap` is needed on the worker's host even with `AGENT_SANDBOX=none`. The sandbox is the agent's
shape: the checkout bound read-write at its own path, its `.git` read-only, so nothing setup runs can
plant a hook or a configuration that host-side git would later run; `AGENT_SANDBOX_RO_BINDS` and
`AGENT_SANDBOX_PATH` for the toolchain; a fresh home and `/tmp`, removed after; no token in its
environment; and its traffic through `AGENT_SANDBOX_PROXY`, which must therefore **let the package
registry through** for setup's install. It is run as Actions runs a `run:` step, by `bash` stopping
at the first failing command, under the job's time limit, and ended with everything it started at
that limit. A setup that exits non-zero fails its phase with the exit status and the end of its
output, kept in full in the run's `logs/setup.log`.

What it leaves in the checkout reaches the agent under either `AGENT_SANDBOX`. With `none` the
agent works in the checkout itself. With `bwrap` it works in a copy at `/home/agent/workspace`,
cloned from the checkout's history, and everything the checkout holds outside git, ignored or not,
is copied in beside it, and excluded there, so none of it comes back as the agent's work. So what setup builds **must not depend on the checkout's absolute path**:
`node_modules` moves as it is, and a Python virtual environment, whose scripts name its path, does
not.

**`node-version-file` is not supported.** The sandbox runs the agent box's own Node, the one
`AGENT_SANDBOX_RO_BINDS` and `AGENT_SANDBOX_PATH` give it. A repository that needs another
toolchain stays on Actions for now.

### Settings

Read from the environment. A missing required one stops the worker at start, naming each.
`tests/service/settings.test.ts` holds this table equal to `WORKER` in `service/settings.ts`.

| Setting | Kind | Default | Meaning |
|---|---|---|---|
| `WORKER_SECRET` | required | | the secret the dispatcher and the worker share, the dispatcher's own `WORKER_SECRET` |
| `DISPATCHER_TOKEN_URL` | required | | the dispatcher's token door, ending `/token` |
| `CLAUDE_CODE_VERSION` | required | | the version of `@anthropic-ai/claude-code` the worker installs at start, so "latest" is never chosen by accident |
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | the agent's model token, handed to the runner alone |
| `WORK_DIR` | required | | where the agent's CLI is installed and each run's directory is kept |
| `JOBS_HOST` | optional | `127.0.0.1` | the address the job door listens on: one the dispatcher reaches |
| `JOBS_PORT` | optional | `8787` | the job door's port; jobs arrive at `POST /jobs`, which the dispatcher's `WORKER_URL` names |
| `WORKER_PROXY` | optional | `""` | an `http:` or `https:` URL: the proxy the worker's own requests (the CLI's install, its token requests) and every subcommand it starts leave through, by `HTTP_PROXY`, `HTTPS_PROXY`, their lower-case forms and `NODE_USE_ENV_PROXY=1`, never with a `NO_PROXY`; empty connects directly, and the worker refuses to start on anything else. It does not reach the sandbox, whose proxy is `AGENT_SANDBOX_PROXY` |
| `AGENT_SANDBOX` | optional | `bwrap` | the sandbox the agent runs in, `bwrap` or `none` (spec §3); `none` runs the agent with the worker's own filesystem |
| `AGENT_SANDBOX_RO_BINDS` | optional | `""` | host directories, `:`-separated, bound read-only into the sandbox for the toolchain; the CLI's prefix is added |
| `AGENT_SANDBOX_PATH` | optional | `/usr/local/bin:/usr/bin:/bin` | `PATH` inside the sandbox; the CLI's directory is put first |
| `AGENT_SANDBOX_PROXY` | optional | `""` | the proxy every request from the sandbox leaves through |

The job door also answers `GET /health` with `200`.

## Restarts and outages

- **A delivery that arrives while the dispatcher is down is lost**, since GitHub does not
  redeliver on its own (*What it does not keep*, above): after an outage, redeliver from the App's
  *Recent Deliveries*, or remove the label and add it again. The worker's queue is in memory too: a worker restarted mid-job loses that job and
  the ones waiting behind it, and the pull request keeps its `agent:review` until you re-add it.
- **Each piece restarts itself, in order.** Run both processes under something that restarts them
  at boot and after a crash (a container's restart policy, a systemd unit), with the worker
  started after its proxy, and the firewall around the worker's host in place before the worker's
  host starts. The worker installs the agent's CLI again at each start, so give it a moment, and
  the network, before its door answers.

## A worked example: the maintainer's Unraid server

One deployment, recorded so it can be rebuilt; nothing in it is in the package's code. The
dispatcher runs on an Unraid server; the worker runs in a VM on it, the *agent box*, which is the
wall between the agents and the NAS (#364). GitHub reaches the dispatcher through Tailscale Funnel.

```text
GitHub ─► Funnel :10000 ─► Unraid 127.0.0.1:8790/github   dispatcher (container, host network)
                           Unraid 192.168.250.1:8791/token ◄─ worker asks for tokens
                           ─► 192.168.250.11:8787/jobs      worker (agent-box VM, on agentnet)
                                                            └─ bwrap ─► tinyproxy ─► the internet
```

**The agent box** is an Ubuntu 24.04 VM: Host Passthrough CPU (the agent's CLI hangs on an
emulated one), 4 vCPU, 8 GB, a raw disk, no Unraid shares and no passed-through devices, its own
Autostart off, and a VNC password, since Unraid's console otherwise listens on the LAN without one.
It sits on **`agentnet`**, a libvirt NAT network of its own, `192.168.250.0/24` on bridge
`virbr-agent`, at `192.168.250.11`; the host is `192.168.250.1` on it. That address is a DHCP
**reservation** for the VM's network card (`<host mac='…' ip='192.168.250.11'/>` in the network's
`<dhcp>`), not the first lease the range happened to give: `WORKER_URL` names it, and a rebuilt VM
or a second one on `agentnet` would otherwise take another, and every job would go unanswered.
Inside it:

- bubblewrap, with Ubuntu's AppArmor restriction on user namespaces lifted for `bwrap`;
- Node 24.14 or later, owned by root, and git. Node's tarball stores its files under a build
  account's uid, 1000 or 1001 depending on the release, which on a box whose first user is the
  admin is the admin or the worker's user. Unpacking it as is (`tar` as root keeps owners) hands
  `/usr/local/bin`, ahead of `/usr/bin` on root's `PATH`, to one of them; a release that happens to
  give the admin's uid is no reason to skip the flag, since the next may give the worker's.
  Unpack with `--no-same-owner`;
- tinyproxy, allowing GitHub, the model's API and the package registries by hostname, and the
  dispatcher's token door, `192.168.250.1`, which the worker reaches through it. Node tunnels a
  plain `http:` request through `CONNECT` too, so `ConnectPort 8791` sits beside `ConnectPort 443`;
- an nft rule (`meta skuid`) letting the worker's user open connections on loopback alone,
  that is to tinyproxy, so nothing on the box leaves except through the proxy, the worker included;
- the package installed once, as root, into `/opt/agent-workflows` (`npm install --prefix`), so
  the worker never reaches the registry itself and the box holds no registry token: an upgrade is
  the same install at a new version, then a restart;
- the worker as a systemd unit running that install (`node
  /opt/agent-workflows/node_modules/@jeffwlawson/agent-workflows/dist/cli.js worker`) as the
  worker's user, after tinyproxy, its settings in an `EnvironmentFile` only root can read,
  `WORKER_PROXY` sending its own traffic and every step it runs through tinyproxy, on
  `127.0.0.1:3128`:

```text
WORKER_SECRET=<shared with the dispatcher>
DISPATCHER_TOKEN_URL=http://192.168.250.1:8791/token
CLAUDE_CODE_VERSION=<a pinned version>
CLAUDE_CODE_OAUTH_TOKEN=<from `claude setup-token`>
WORK_DIR=/var/lib/agent-worker
JOBS_HOST=192.168.250.11
JOBS_PORT=8787
WORKER_PROXY=http://127.0.0.1:3128
AGENT_SANDBOX=bwrap
AGENT_SANDBOX_PROXY=http://127.0.0.1:3128
```

`AGENT_SANDBOX_RO_BINDS` and `AGENT_SANDBOX_PATH` keep their defaults: Node is under `/usr/local`,
which the sandbox's read-only `/usr` already holds, and `/usr/local/bin` is on the default path.

**The `agentnet` firewall** is the User Script `agentnet-firewall`, run *At Startup of Array*.
It puts an `AGENT-EGRESS` chain in the `mangle` table's `PREROUTING`, which libvirt, Docker and
Tailscale do not reorder, matching traffic from `virbr-agent`: established connections return; DNS
to `192.168.250.1:53`, DHCP, and the dispatcher's token door at `192.168.250.1:8791` are allowed;
everything to `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `224/4`
and `240/4` is dropped, and all of the bridge's IPv6. Only then does the script start the VM, so
the VM's own Autostart stays off. The token door is reachable from inside the agent box, the
sandbox included, which is why it mints only for a request signed with `WORKER_SECRET`, a file the
sandbox cannot see.

**The dispatcher** lives in `/mnt/user/appdata/agent-dispatcher/`: the App's key, `app.pem`, its
settings, `service.env`, and the package, installed once into `pkg/` by a throwaway container
(`docker run --rm … node:24-alpine npm install --prefix /pkg …`), so the server holds no registry
token either. `service.env` is root's alone; `app.pem` belongs to the user the container runs as,
uid 99, mode 600:

```text
GITHUB_APP_ID=<the App's ID>
GITHUB_APP_PRIVATE_KEY_FILE=/app/app.pem
GITHUB_WEBHOOK_SECRET=<the App's webhook secret>
WORKER_URL=http://192.168.250.11:8787/jobs
WORKER_SECRET=<shared with the worker>
WEBHOOK_HOST=127.0.0.1
WEBHOOK_PORT=8790
TOKEN_HOST=192.168.250.1
TOKEN_PORT=8791
```

It runs as a container with host networking, since libvirt's NAT network admits new connections
from the host and not from a container on Docker's own bridge, and restarts unless stopped. It runs
as `99:100` (Unraid's nobody:users), not root: it is the process the internet reaches, through the
Funnel, and it holds the App's key. That user has no home in the image and `/app` is read-only, so
it starts in `/tmp` with `HOME` there:

```bash
docker run -d --name agent-dispatcher --restart unless-stopped --network host \
  --user 99:100 -w /tmp -e HOME=/tmp \
  --env-file /mnt/user/appdata/agent-dispatcher/service.env \
  -v /mnt/user/appdata/agent-dispatcher:/app:ro node:24-alpine \
  node /app/pkg/node_modules/@jeffwlawson/agent-workflows/dist/cli.js dispatcher
```

Docker reads `--env-file` when it creates a container, not when it restarts one, so a change to
`service.env` means a new container. An upgrade is an install at the new version into `pkg/` and a
`docker restart`, with the worker moved to the same version alongside, since a worker refuses jobs
from a dispatcher of another release. **Tailscale Funnel** publishes the webhook door, on port 10000 (the server's `serve` already
holds 8443):

```bash
tailscale funnel --bg --https=10000 http://127.0.0.1:8790
```

The App's webhook URL is then the server's Funnel name, `https://<node>.<tailnet>.ts.net:10000/github`.
Leave *Settings → Tailscale → Allow Tailscale Funnel* at **Yes**, or the plugin's watcher removes
the Funnel.

**After a reboot the chain comes back on its own**, as #374 showed with the prototype, the same
chain of units and scripts: the array
starts, `agentnet-firewall` puts the rules in and starts the VM, the VM's units start in order
(its egress rules, tinyproxy, the worker), the dispatcher's container comes back, and the Funnel
stays public. About 11 minutes from *Reboot* to a review. Restarting the VM service alone does
**not** bring it back (Unraid cannot remount `libvirt.img` until a reboot), so reboot the server
instead of turning VM Manager off and on. Deliveries made while it was down are lost, as above:
re-add the label.
