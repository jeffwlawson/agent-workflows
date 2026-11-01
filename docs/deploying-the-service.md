# Deploying the service orchestrator

The loop has two orchestrators. The **Actions orchestrator** is the callers and reusables
[ADOPTING.md](./ADOPTING.md) installs. The **service orchestrator** is two processes you run on a
machine of your own, so the agent spends none of your Actions minutes:

- the **dispatcher**, which holds the GitHub App's key, receives GitHub's webhooks, decides which
  delivery is a job, and mints a short-lived token, scoped to one repository, each time the worker
  asks for one;
- the **worker**, which receives jobs from the dispatcher and runs review, fix, update-branch,
  implement, implement-prd, follow-ups and merge the way `review.yml`, `fix.yml`,
  `update-branch.yml`, `implement.yml`, `implement-prd.yml`, `follow-ups.yml` and `merge.yml` do,
  with the runner in a sandbox where there is one.

Each is a subcommand of the published package, so deploying the service is configuration rather
than a build. A
repository opts in with the repository variable `AGENT_ORCHESTRATOR=service`
([ADOPTING §2e](./ADOPTING.md#2e-choosing-the-orchestrator)); the service refuses every other
repository, and answers every trigger label the loop has: `agent:review`, `agent:fix`,
`agent:update-branch`, `agent:follow-ups` and `agent:merge` on a pull request, `agent:implement` on
an issue, a regular one or a PRD, and every merge, which posts the post-merge checklist and, where
`agent:follow-ups` is on, files the follow-ups its review recorded. `agent:merge`, the maintainer's
merge decision, is carried out by a merge job, which a push, a check suite's completion and a status
on the armed head start again, so the wait for CI holds no worker slot
([platform-spec §12](./platform-spec.md#12-merge)). A repository on the service loses nothing it
had on Actions. A PRD labelled
`agent:implement` is built one slice at a time, as on Actions, with no Actions involved.

## What a host needs

Whatever the machine, the service needs:

- **Linux** for the worker, since the sandbox is Linux's: bubblewrap runs on user namespaces.
  Where the distribution restricts unprivileged user namespaces (Ubuntu 24.04's AppArmor does),
  allow them for `bwrap`. The dispatcher runs anywhere Node does.
- **bubblewrap** (`bwrap`) on the worker's host, for `AGENT_SANDBOX=bwrap`, the default.
- **A webhook endpoint GitHub can reach**: the dispatcher's webhook door, published through a
  reverse proxy or a tunnel. Nothing else of either process is published.
- **A proxy** the agent's traffic leaves through (`AGENT_SANDBOX_PROXY`), allowing what a review
  needs (GitHub, the model's API, the package registries) and nothing else. Required with
  `AGENT_SANDBOX=bwrap`, the default: the worker refuses to start without one. **The sandbox
  enforces it itself** (spec §3): the agent's network is its own loopback and nothing else, and its
  one way out is a socket the worker's process holds, which forwards to the proxy alone. A direct
  connection from the agent to any address, the worker's host included, fails whatever the host's
  firewall allows, so the proxy's allowlist is the agent's egress policy. The repository's setup
  gets the same network wherever a proxy is set, under `AGENT_SANDBOX=none` too (below), so a
  firewall around the worker's host is defence in depth for both. Under `none` with no proxy, the
  agent and setup both have the host's network, and the host's firewall is what limits them.
  Where the host's firewall lets the worker out only through a proxy, the worker's own traffic
  needs it too: its install of the agent's CLI, its token requests, and every step it runs, which
  `WORKER_PROXY` sends through it.
- **Node 24.14 or later** for both processes, with `git` and `npm` beside the worker, and the
  package, installed one of the two ways below. Read access to the registry the package is
  published to is needed only for the registry route, or for `npm exec`.
- **The GitHub App**, below.

### Installing the package

Each release's GitHub Release carries the packed tarball, the same file the registry serves, with
its dependency tree bundled inside it, and a `<tarball>.sha256` beside it. On a public repository a
Release asset needs no token, so this is the **tokenless install**: download the tarball, check it,
and install that file:

```bash
url=https://github.com/<owner>/<repo>/releases/download/v<version>/<tarball>
curl -fsSLO "$url" && curl -fsSLO "$url.sha256"
sha256sum -c <tarball>.sha256
npm install --prefix /opt/agent-workflows ./<tarball>
```

`<owner>/<repo>` is the repository the package is released from, and `<tarball>` the asset's name
on its Release, `<scope>-<name>-<version>.tgz` (the package name with its `@` dropped and `/` made
`-`). `npm install --prefix /opt/agent-workflows "$url"` installs the same file in one step, without
the check. An **upgrade** is the same commands at the new version, then a restart. This route
works only where the repository is public: a private repository's Release assets need a token too.

**The registry route** is the other one: `npm install --prefix /opt/agent-workflows
@<scope>/agent-workflows@<version>`, or `npm exec` of the same spec. GitHub Packages' npm registry
needs a token with `read:packages` for it, even for a public package, set up in an `.npmrc` the
install reads.

The two processes may share a machine. Keeping the App's key off the machine that runs agents is
the point of the split, so put the worker on a machine, or a VM, of its own where you can.

## The GitHub App

The service acts as a GitHub App you own, which may be the loop's own App (ADOPTING §2) or one of
its own. Its login, `<slug>[bot]`, is what the service's reviews are posted as, and the dispatcher
reads it off the App's own record rather than from a setting, so a typo cannot make every round
the first.

### Registering it with `init`

`init --service` registers a service-ready App through the same manifest flow `init` uses for the
loop's App (ADOPTING §2), run from a checkout of a repository the App's owner owns. It asks, at a
terminal, for:

- the **webhook URL**, whose path must end `/github`, with no query or fragment, and which is never
  defaulted;
- the **dispatcher settings file** to write, which must not exist yet;
- the **private key file** to write, `app.pem` beside the settings file unless you name another,
  which must not exist yet either.

An answer it refuses (a URL whose path does not end `/github`, a file that exists, a path inside the checkout)
stops it before anything is registered, and an existing file is never written over. Without a
terminal it asks nothing and registers nothing. The manifest is the loop's App's with the
permissions below added, the webhook, **Active**, at the URL as given, the events under *The
webhook*, and the App private (**Only on this account**), so the table and the event list here are
what GitHub's page shows you before you click Create.

From GitHub's answer it writes the key to the key file and `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY_FILE` (the key file's path) and `GITHUB_WEBHOOK_SECRET` to the settings
file, as `NAME=value` lines, each file mode 600. Neither the key nor the secret is printed, and
neither goes in the repository's Actions secrets. An answer carrying no webhook secret writes
nothing and says so; the App exists by then, so set a secret and generate a key on its settings
page. Everything else the dispatcher reads (`WORKER_URL`, `WORKER_SECRET`, the doors' hosts and
ports) is yours to add to the settings file, as its closing output says. A `NAME=value` file is
what both systemd's `EnvironmentFile=` and Docker's `--env-file` read; how the file reaches the
dispatcher's environment is your host's to decide. Install the App afterwards, at the page it
opens.

### Permissions

Repository permissions:

| Permission | In the API | Access | Why |
|---|---|---|---|
| Metadata | `metadata` | read | every API call, a label's sender's permission, and the repositories each installation reaches, which a scan lists |
| Variables | `actions_variables` | read | `AGENT_ORCHESTRATOR`, re-read at every token, and the variables the service reads, `AGENT_SETUP` among them: the repository's own, else its organization's shared with it, as `vars` resolves them |
| Contents | `contents` | write | the checkout and the pull request's history, read by every phase; resolving a review thread on a pull request the App did not open, by a `resolve` token; a push, and `agent:merge`'s merge, by a `push` token only |
| Pull requests | `pull_requests` | write | the review, its threads, the title and summary, the ready mark, and `agent:merge`'s merge; a scan reads an open pull request's head and base, and the dispatcher's reads the pull requests a check suite's or a status's commit belongs to, with their labels |
| Issues | `issues` | write | comments and labels, the issue an implement job builds, and a PRD's parent; a scan reads the open items carrying a trigger label and their `labeled` events, and comments on one it stops dispatching |
| Checks | `checks` | read | CI's result, which the review's verdict reads |
| Commit statuses | `statuses` | write | the verdict and the fix-round statuses, and `agent:merge`'s arm, `agent-merge` |
| Workflows | `workflows` | write | a push touching `.github/workflows/**` is refused without it, *after* the agent has done all its work |

The worker asks for one of four kinds of token at each phase: `read`, which every phase reads
with and the only one the runner is ever handed; `write`, which adds the pull request, issue and
status writes of the phases that post; `resolve`, which adds Contents: write and nothing else to
`write`, for `review:publish` alone; and `push`, which adds Contents: write and Workflows: write
to `write`, for the phases that push or merge and run no agent. GitHub lets a review thread be resolved by
the pull request's author or by a holder of repository write access, so with `write` the App
resolves threads only on the pull requests it opened (#571): with `resolve`, the one phase that
resolves threads is given what that takes, rather than every posting phase given Contents: write
through a wider `write`, or Workflows: write through `push`. Like the posting job on Actions, it
runs no agent, checks nothing out, and reads the agent's output only through the checked
hand-over readers. Contents: write together with Workflows: write
is the pair that lets a holder push a workflow into a repository whose runs carry secrets, which is
why it is a kind of its own rather than a wider `write`, and why it is acceptable at all: as on
Actions (ADOPTING §2), neither the App's key nor a `push` token is ever where the agent runs. The
key stays with the dispatcher, and a token reaches a subcommand only where its phase was handed it.

The dispatcher reads what the App is granted and subscribed to off the App's own record at start,
and logs a `warning:` line for each gap: a permission not granted, or granted below the access
this table needs, naming the access it holds and the tokens whose mint it fails, and an event
under *The webhook* the App is not subscribed to. A gap warns and the dispatcher starts regardless,
since review alone needs less than the whole table; a token the gap fails is refused when a phase
asks for it, `422`, with `the App lacks a permission it asks for` in the log.

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
- under *Subscribe to events*, **Pull request** (`pull_request`), **Issues** (`issues`), **Check
  suite** (`check_suite`) and **Status** (`status`). An issue's label reaches the dispatcher only on
  an `issues` delivery, so without **Issues** nothing answers `agent:implement`. A check suite's
  completion and a status are what start an armed pull request's merge job again once CI lands, so
  without them `agent:merge` waits for the next push or label.

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

- it is a pull request, or an issue, labelled with a label the service answers on that
  event (`SERVICE_LABELS` in `service/dispatcher.ts`, the labels its `LABEL_KINDS` maps to a job
  kind, per event: on a `pull_request` delivery `agent:review` to a review job, `agent:fix` to a
  fix job, `agent:update-branch` to an update-branch job, `agent:follow-ups` to a follow-ups
  job and `agent:merge` to a merge job, and on an `issues` delivery
  `agent:implement` to two jobs, an implement job and an implement-prd job, as Actions starts both
  workflows on it). A label is answered on its own event only, and an `issues` delivery about a
  pull request is ignored. The dispatcher reads nothing of an issue's shape: each job's gate does,
  and the one whose shape it is not ends without a word. Or it is a merge: a `pull_request`
  `closed` delivery with `merged` `true`, whatever its labels, which becomes a follow-ups job, as
  Actions starts its job on every merge: the run posts the post-merge checklist, and files only
  where `agent:follow-ups` is on the pull request. A close without a merge is ignored before the
  repository is read. Or it is an event that can change an armed pull request's merge gate, each a
  merge job only for an open pull request carrying `agent:merge`, with no sender check, since none
  of them arms: a push to it (`synchronize`), by the labels its payload carries; a check suite's
  completion (`check_suite` `completed`); or a status in a final state, `success`, `failure` or
  `error`, from a context that is not the loop's own (`agent-merge`, `agent-review`,
  `agent-fix-round`). For the last two the dispatcher reads the pull requests the commit belongs
  to, with its reader, and starts nothing where the commit is no open pull request's head. Any other
  check suite action, a `pending` status, and a status of the loop's own are ignored before anything
  is read;
- the App is installed on the repository;
- the installation is on the App's owner's account, or on one `EXTRA_OWNERS` lists;
- the repository's `AGENT_ORCHESTRATOR` is `service`;
- on a pull request, the head is in the same repository, not a fork; an issue has no head;
- a pull request is open, but for `agent:follow-ups`, which is answered on a closed one, merged or
  not, as `follow-ups.yml` answers it. An issue's state is not checked here: a closed issue becomes
  a job, and `implement:gate` refuses it on the issue and takes the label off, as on Actions;
- the label's sender can write to the repository, or is the App itself (`<slug>[bot]`), whose
  labels the loop's own commands add (ADR 0008). A merge has no such check: whoever merged could
  write, and a merge queue or auto-merge can send it as a bot that would be refused, which would
  drop the follow-ups without a word.

Every other delivery is logged with its reason. A job carries what the label's event carried, the
repository variables the service reads (`AGENT_MODEL`, `AGENT_MODEL_REVIEW`, `AGENT_MODEL_FIX`,
`AGENT_MODEL_UPDATE_BRANCH`, `AGENT_MODEL_IMPLEMENT`, `AGENT_MODEL_IMPLEMENT_PRD`, `AGENT_REVIEW_TIMEOUT_MINUTES`, `AGENT_TIMEOUT_MINUTES`, `AGENT_MAX_FIX_ROUNDS` and `AGENT_SETUP`,
each unset as empty), the App's login, a job id, a deadline and the package's version. An
implement job and an implement-prd job each carry the issue's number, title and state, and the
repository's default branch as its base, which stands in for the `default-branch` a caller hands
`implement.yml` and `implement-prd.yml`. A follow-ups job carries the pull request's number alone,
since nothing is checked out. A merge job carries what a review job does, and whether the pull
request is a draft, whether it was started by `agent:merge`'s own delivery, the one that may arm,
and its sender. The deadline is the job's own time limit, review's, or
fix's, update-branch's and implement's, or implement-prd's, the sum of its jobs' limits, or
follow-ups', 10 minutes, or merge's, 20 (below), plus `JOB_DEADLINE_MARGIN_MINUTES`.
It carries no token: the worker asks for one per phase, `read`, `write`, `resolve` or `push`, and the dispatcher mints
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
| `WORKER_URL` | required | | the worker's job door, where a job is posted, ending `/jobs`; a scan asks what the worker holds at `/held` beside it |
| `WORKER_SECRET` | required | | the secret the dispatcher and the worker share, which signs a job and a token request |
| `WEBHOOK_HOST` | optional | `127.0.0.1` | the address the webhook door listens on |
| `WEBHOOK_PORT` | optional | `8790` | the webhook door's port; GitHub's deliveries arrive at `POST /github` |
| `TOKEN_HOST` | optional | `127.0.0.1` | the address the token door listens on: one the worker reaches |
| `TOKEN_PORT` | optional | `8791` | the token door's port; the worker asks at `POST /token`, and announces its start at `POST /started` |
| `JOB_DEADLINE_MARGIN_MINUTES` | optional | `60` | added to a job's own time limit for its deadline, review's (its CI wait and `AGENT_REVIEW_TIMEOUT_MINUTES`) or fix's, update-branch's and implement's (`AGENT_TIMEOUT_MINUTES`), or implement-prd's (35 minutes and `AGENT_TIMEOUT_MINUTES`), or follow-ups' (10 minutes), or merge's (20 minutes), covering the phases around the runner's and the time a job waits in the worker's queue: in its lane, behind an earlier job for its item, and, for an update-branch whose merge conflicted, for the agent lane (*The worker*, below) |
| `EXTRA_OWNERS` | optional | `""` | accounts, comma-separated, whose installations the dispatcher serves besides the App owner's; empty is none. An installation on any other account is refused |
| `SCAN_DISPATCH_LIMIT` | optional | `2` | how many times the scan dispatches an item for a label that stays on across scans before it leaves the item for a person, and comments once to say so (*The scan's limit*, below), never applied to `agent:merge`. At least `1`: `0` is refused at start, since it would not turn the scan off |

Each door also answers `GET /health` with `200`.

### What it does not keep

- **A delivery that arrives while the dispatcher is down is lost.** GitHub does not redeliver on
  its own; redeliver it from the App's *Recent Deliveries*, or remove the label and add it again.
- **The jobs it dispatched are held in memory, and only the started ones are lost to a restart.** Each
  job carries the id of the dispatcher instance that sent it, fresh at each start, and the scan at
  a restarted dispatcher's start names its own at the worker's held door. The worker drops every
  job it holds *queued* from another instance before it answers, so none of them runs, and the
  scan dispatches their items again, in the order it lists them, behind the running jobs. A
  running job, one in each lane at most, is not dropped, since the held door cannot stop it, nor is
  an update-branch job waiting for the agent lane after its merge: each ends at its next token
  request, which the new dispatcher refuses as unknown, and the scan skips its item while the
  worker still holds it. Remove that item's label and add it again.
- **The scan's counts are held in memory.** A restarted dispatcher forgets how many times its scans
  have dispatched each item (*The scan's limit*, below), so each item's count starts from zero
  again, and the comment saying the scan stopped may be posted once more.

**What a restart recovers: the scan.** At its start, and again whenever the worker announces its
own start, the dispatcher scans for labelled work nothing holds a job for, one pass at a time (a
request while one waits is folded into it). For each installation it serves, each repository that
opts in, it lists the open issues and pull requests carrying `agent:implement`, `agent:review`,
`agent:fix`, `agent:update-branch` or `agent:merge`, and decides each one as that label's delivery would be
decided: the same installation, owner and opt-in checks, a head in the same repository, an open
pull request, and the same job. A scan has no sender, so the actor of the item's latest `labeled`
event for that label stands in for one, held to the same rule: the App's own login, or someone who
can write to the repository *now*. An item with no such event is skipped and logged, never
dispatched on a guess.

`agent:follow-ups` is never scanned: it is a marker that stays on until the pull request is merged
and filed, not a label that says a run is working, and a merge's follow-ups job comes from the merge.
`agent:merge` is not a run's label either, but the maintainer's standing decision, so a gate that
ends with it on is the normal case: the scan dispatches a merge job for an armed pull request
nothing holds one for, so a dropped gate, or a check that completed while the service was down, is
not stranded, but that job arms nothing, and the scan's limit below is not applied to it.

Before deciding, the scan asks the worker at its held door which jobs it has queued or is running,
and skips any item a job is held for there or that the dispatcher itself has dispatched and is
still posting. That second check is made again at the moment each job is dispatched, so a label's
delivery landing while the scan decides the same item makes one job, not two: whichever of the
two gets there first is dispatched, and the other is skipped and logged. A delivery is skipped for a
scan's job only where that job cannot have ended yet: the scan dispatched it after the delivery
arrived, or the worker has not taken it yet. One the worker took before the delivery arrived may
have run and ended, and the label may be one a later run added again, as a fix round adds
`agent:review`, so that delivery is dispatched. A delivery is never skipped for another delivery's
job, since a label added again is asked for again, but for a merge job, which the worker coalesces
(*The worker*, below). A worker that cannot be reached skips the whole scan, logged; its own start
announcement scans again. The question names the dispatcher's instance, and the worker drops
every job it holds queued from another before answering, so after a dispatcher's restart the scan
dispatches those items again rather than skipping them. A question that names no instance only
reads: the worker answers what it holds and drops nothing, so a script of your own can ask it,
signed with `WORKER_SECRET` as a job is, without emptying its queue. Either way the question
carries the time it was `asked`, and the worker refuses one more than 5 minutes old or more than
a minute ahead of its own clock, so a captured question cannot be replayed later to drop jobs;
keep both hosts' clocks synchronised. A refused question skips the scan, and both logs name the
refusal (`scan: skipped: the worker refused to say which jobs it holds: …` in the dispatcher's).
Asking again meets the same refusal, so nothing scans again, the worker's start included, until
the clock or the secret is mended. The same answer lets the dispatcher forget
every job it dispatched that the worker no longer holds, which after a worker's restart is every
job it held before.

A label still on an item with nothing held for it is a run that never reached its ending, since
the loop's commands take the trigger label off however a decided run ends. Two limits follow:

- a run that ended because the dispatcher **granted no token** leaves its label on by design
  (adding it again is the retry), so a scan after it dispatches it once more, once per start, up
  to the scan's limit;
- a job **running in the worker when only the dispatcher restarted** is skipped, since the worker
  still holds it, and dies at its next token request, as above. The jobs queued behind it are not:
  the worker drops them at the scan's question, and the scan dispatches their items again.

**The scan's limit.** A job that ends the worker's *process*, rather than a phase that fails
cleanly, leaves its label on; the worker is restarted, its start makes the dispatcher scan, and the
scan dispatches the item again, which ends the process again. So the dispatcher counts the
dispatches its scans make, whatever started the scan, per item and label: another item, and
another label on the same item, count apart. Past `SCAN_DISPATCH_LIMIT` (default `2`) a crashing
job is tried no more: each later scan skips the item with a line naming it, the label and the
limit, and the first one comments once on the item, naming the label to remove and add again by
hand. A comment that cannot be posted is logged, the scan goes on, and the next scan tries it
again. The comment is posted with a token minted for it alone; the scan's reads stay read-only.
That label's delivery, from a person adding it again or from the App, passes the same checks as
any, is dispatched, and resets the count, so the scan answers the item again up to the limit. A
delivery's own dispatch is never counted, and neither is a scan's for `agent:merge`. An item a scan no longer lists with the label had its
job end and the label taken off, so its count is forgotten, and a label added to it later is
counted from zero.

Every line a scan logs starts `scan:`, with the item and the reason it was dispatched, skipped or
refused; a repository or a listing that cannot be read is logged and the scan goes on.

## The worker

The process that runs review, fix, update-branch, implement, implement-prd and follow-ups. It holds no key: it asks the dispatcher for a token at the
start of each phase. For review: `read` for the gate, the checkout, the budget and the CI wait, a
fresh `read` for the runner, so the token's hour starts as the agent does, `resolve` for
`review:publish`, and `write` for `review:conclude`. Where the `resolve` token is refused, publish
asks for `write` instead and conclude reuses it: the review posts, the threads it found fixed stay
open and are listed under *Still open*, and the worker's log says the `resolve` token was refused. For fix: `write` for `fix:gate`, which posts its refusal and
probes the label; `read` for the checkout and `fix:prepare`, and a fresh `read` for the runner;
none for `fix:bundle`; and `push` for the publish checkout, `fix:publish` and `fix:conclude`, the only phases that push. Where the `push`
token is refused, nothing is published, and `fix:conclude` asks for `write` instead, which the publish
checkout is made with, to post the round's ending without a rescue. For update-branch: `write` for `update-branch:gate` and
`update-branch:merge`, which runs in the worker's checkout, outside the sandbox, and pushes nothing;
`read` for the agent's checkout and `update-branch:prepare`, and a fresh `read` for the runner; none
for `update-branch:bundle`; and `push` for `update-branch:publish` and `update-branch:conclude`, with
`write` for conclude where `push` is refused, as fix's. For implement: `write` for
`implement:gate`, which posts its refusals and the start comment and probes the label; `read` for
the checkout of the base and `implement:prepare`, which fetches a stopped run's rescue branch, and
a fresh `read` for the runner; none for `implement:bundle`; and `push` for the publish checkout,
`implement:publish` and `implement:conclude`, with `write` for the checkout and conclude where
`push` is refused, to post the run's ending without a rescue. For implement-prd: `write` for `implement-prd:gate`; `push` for
the catch-up's checkout and `implement-prd:catch-up`, which pushes the merge of the default branch
into the PRD branch, before any agent runs; `read` for the agent's checkout and
`implement-prd:prepare`, and a fresh `read` for the runner; none for `implement-prd:bundle`; and
`push` for the publish checkout, `implement-prd:publish` and `implement-prd:conclude`, with `write`
for the checkout and conclude where `push` is refused. For follow-ups: one `write` token, for
`follow-ups:file`, which files the stubs with it as the App, and `follow-ups:conclude`. For merge:
`write` for `merge:gate`, `push` for `merge:publish` alone, asked for only where the gate decided
`merge`, and a fresh `write` for `merge:conclude`, the gate's where that is refused. A gate that refuses ends any of these jobs
there, as it skips the jobs after it on Actions, and so does each deferral, implement's of a PRD
and implement-prd's of a regular issue: no token is asked for after it, and nothing after the gate
runs. A gate that failed before it decided is not a
refusal, and conclude still runs.
The runner never holds a token that writes. It needs:

- Linux, Node 24.14 or later, `git`, `npm`, and the package (`npm exec
  @jeffwlawson/agent-workflows@<version> worker`, or an install of it) at the **same version as the
  dispatcher**: a job from a dispatcher of another release is refused, `409`, and the dispatcher
  logs that the worker answered it;
- `bwrap` (bubblewrap), unless `AGENT_SANDBOX` says `none`, and a proxy for the agent's traffic
  (`AGENT_SANDBOX_PROXY`), the sandbox's only way out, without which a `bwrap` worker refuses to
  start;
- its **job door** reachable from the dispatcher, and from nothing else;
- the dispatcher's token door reachable from it.

At start it installs the agent's CLI, `@anthropic-ai/claude-code` at `CLAUDE_CODE_VERSION`, into
`WORK_DIR/claude-code/<version>`, and refuses to start where the install fails. The host's own
`claude` is never used: the worker's goes first on the runner's `PATH`, first on
`AGENT_SANDBOX_PATH`, and into `AGENT_SANDBOX_RO_BINDS`. Bind the Node the agent's CLI runs on
read-only too, through `AGENT_SANDBOX_RO_BINDS`, and put it on `AGENT_SANDBOX_PATH`.

Jobs run in two lanes, each one job at a time, beneath a chain per pull request or issue (#582):

- **The agent lane** runs every job that can start an agent: review, fix, implement and
  implement-prd, and an update-branch job's agent part. It runs them strictly in the order they
  arrived, so two agent jobs never run at once, and a gate that refuses ends its job in this lane.
- **The light lane** runs, beside it, what starts no agent: follow-ups, and an update-branch job up
  to its merge. A clean merge's job ends there, publish and conclude included, so a refresh or a
  filing that takes seconds no longer waits behind a build that takes up to an hour. It takes the
  first job that arrived whose item is free.
- **An update-branch job whose merge conflicts is handed off** at the point it would start its
  agent: it leaves the light lane, and its agent's job, publish and conclude run in the agent lane,
  never beside another agent job. It holds its place in the agent lane from its arrival until it
  ends, or asks for the lane, so an agent job that arrived after it waits for the whole of it: its
  gate and merge, then its agent if it conflicted, or its publish and conclude
  (`UPDATE_BRANCH_POSTING_MINUTES`) if it was clean. None that arrived before it waits behind it.
  One wait is added to a single queue's: where its item is still busy when the light lane comes
  free, the light lane starts a later light job, and the hand-off, with the agent jobs after it,
  waits for that one job to end. Its phases still run in their one
  order; the hand-off only waits between the merge and the agent's job, whose time limit starts once
  it has the lane.
- **Per item**, a job starts only once every job for the same pull request or issue that arrived
  before it has ended, whatever the lanes: a merge's follow-ups waits for an earlier run on the pull
  request, and a refresh and a review on one head never overlap. A pull request whose head is a
  loop branch is in its issue's chain too, since both push to that branch: a PRD PR's jobs run in
  line with its parent's implement-prd jobs (`agent/prd-<parent>-…`), and an issue branch's PR's
  with its issue's (`agent/issue-<n>-…`).

Whether a job starts an agent is often known only once its gate or merge has run, so the lane is
the kind's, by what it *can* do. The lanes run no more than one agent at a time, so the host's
capacity is unchanged. A job that fails or throws stops nothing behind it, in its lane or its item's
chain.

Each runs the subcommands its reusable runs, in
its order and under its conditions (spec §6 for `implement.yml`, §7 for `implement-prd.yml`, §8 for `review.yml`, §9 for
`fix.yml`, §10 for `update-branch.yml`, §11 for `follow-ups.yml`), each a child process of the worker's own
install, with an environment built from its declaration in the contract and the host's `PATH`,
`HOME` and `LANG`, and nothing else of the worker's. Not run, at this release: the red check. The
repository's setup is run by a fix job, an implement job, an implement-prd job that builds a slice, and an update-branch job whose merge
conflicted, before its runner, and not by a review, as on Actions.

The fix-round budget is the repository's `AGENT_MAX_FIX_ROUNDS`, read as on Actions: a review
asking for changes under a budget with a round left adds `agent:fix`, which the dispatcher answers
as the App's own label, and a spent budget leaves the round to a human, with the comment Actions
posts. A review and the fix round it asks for are both agent jobs for one pull request, so the fix
round starts only once the review has finished, through the agent lane and the item's chain alike, and the `agent-fix-round` status the budget counts stops the cycle.

A fix job runs `fix:gate`, then the agent's job: the checkout of the head the label's event named,
with the base, `fix:prepare`, which fetches a stopped round's rescue branch into it, the setup, the
runner, and `fix:bundle`, however those ended. Then, in a checkout of the head of its own, as
`fix.yml`'s publish job makes, `fix:publish` pushes the agent's commits and asks for the re-review, and `fix:conclude` ends the round, pushing a stopped round's commits to
`agent/rescue/fix-<n>` for the next round to resume from. The checkout keeps no token in its
configuration: each command is handed its token in its environment. Every checkout the worker
makes fetches the head, the base and every tag the repository has, the tags `fetch-depth: 0` gives
on Actions, so a verify command that reads a release by its tag (a version check, `git describe`)
passes here as it does there; it fetches no other branch. It does keep a committer, the
App's login and its no-reply address, as `fix.yml`'s checkout sets one, since the agent commits.

An update-branch job runs `update-branch:gate`, and ends there where it refused; where it claimed the run, it checks the head out
with the base and runs `update-branch:merge` there. A clean merge, or a branch already up to date,
goes straight to `update-branch:publish`, which makes the merge again in a checkout of its own,
pushes it and carries the verdict over; no setup and no runner run. A merge that conflicts runs the
agent's job first, in a third checkout: `update-branch:prepare`, which makes the same merge again,
the setup, the runner, and `update-branch:bundle` where those succeeded. In the `bwrap` sandbox the
agent resolves the conflicts as a squash, on a branch of its own, and the runner makes the merge
commit in the checkout from what it committed, since the sandbox can carry neither a merge in
progress in nor a merge commit out (`docs/platform-spec.md` §10). Publish then pushes the
resolution and adds `agent:review` as the App, which the dispatcher answers as the App's own label.
`update-branch:conclude` ends every run, and asks for `agent:update-branch` again, as the App, where
the head moved on while the job ran and no other trigger label is on.

An implement job runs `implement:gate`, and ends there where it refused the issue or deferred a PRD
to implement-prd. Where it claimed the run, the agent's job checks out the commit the gate read the
default branch at, and runs `implement:prepare`, which creates the agent's branch there and fetches
a stopped run's rescue branch, the setup, the runner, and `implement:bundle`, however those ended.
Where they succeeded, `implement:publish`, in a checkout of the base of its own, pushes the branch,
opens the draft pull request as the App, deletes the rescue branch, links it on the issue and adds
`agent:review` as the App, which the dispatcher answers as the App's own label: the pull request
then flows into review. `implement:conclude` ends every run, in the same checkout, pushing a stopped
run's commits to `agent/rescue/issue-<n>` for the next run to resume from. The service
has no run page, so the link the implement commands give where Actions links its workflow run (the
start comment, the pull request's frame, the link on the issue and the failure comment) is the
App's own page, `https://github.com/apps/<slug>`. Review's, fix's and update-branch's failure
comments, which build their link from the Actions run, give none on the service.

An implement-prd job runs `implement-prd:gate`, and ends there where it refused the PRD or deferred
a regular issue to implement. Where it claimed the run, the gate decided one of three things. **A
build** runs the catch-up first, in a checkout of the default branch of its own:
`implement-prd:catch-up` merges the default branch into the PRD branch where it has moved and
pushes it, or parks the chain on a conflict, naming `agent:update-branch`. Unless it parked or
failed, the agent's job checks out the default branch, as `implement-prd.yml`'s does, and runs
`implement-prd:prepare`, which checks the PRD branch out at the tip the catch-up left and fetches a
stopped run's rescue branch, the setup, the runner, and
`implement-prd:bundle`, however those ended. Where they succeeded, `implement-prd:publish` marks the
slice's commits, pushes them to the PRD branch, opens or reuses the PRD PR and adds `agent:review`
as the App. **A run that only opens a missing PRD PR**, and **the finishing run**, which hands the
PRD PR over, run neither the catch-up nor the agent's job: publish does their work alone.
`implement-prd:conclude` ends every run the gate did not refuse, pushing a stopped build's commits
to `agent/rescue/prd-<parent>` for the next run to resume from.

A follow-ups job runs `follow-ups:file`, then `follow-ups:conclude` however it ended, told whether
it failed or timed out, and nothing else: no checkout, no setup and no agent. `follow-ups:file`
posts the post-merge checklist of the linked briefs' *After merge, by a human* items, then, only
where `agent:follow-ups` is on the pull request, files the stubs the newest review recorded, posts
its report and takes the label off, as on Actions; `follow-ups:conclude` posts the one failure comment on a run
that stopped. A stub is filed as the App, carrying `needs-triage` and `pr-follow-up`, which no
route answers, so it starts nothing. Actions holds this job in the pull request's concurrency group
so that a label added while a merge's run files cannot file twice; the service relies on its one
worker instead, which runs a second run only once the first has ended, and that run finds the label
already off and ends silently. Run one worker.

A merge job runs `merge:gate`, then `merge:publish` where the gate decided `merge`, then
`merge:conclude` however the run went, and nothing else: no checkout, no setup, no sandbox and no
runner, so the `push` token that makes the merge, with Workflows: write for a pull request that
changes `.github/workflows/`, is never where an agent runs. The gate is told the App's login as the
loop's account, the one an arm is read back by, and **waits for nothing**: on Actions it polls for up
to the review's CI wait, but here a polling gate would hold the worker's one slot, so it decides
once and ends, `wait` included, and the next push, check suite's completion or status starts it
again. Merge jobs are **coalesced** per pull request, so they cannot pile up in the one queue: at
most one runs and one waits. A merge job for a pull request with one waiting is absorbed by it,
and the worker's log says `absorbed by merge job …`; the one waiting reads the record when it
starts, so nothing the absorbed delivery reported is lost. The exception is a person adding
`agent:merge`, the one start that arms, at the head its delivery named: it replaces the one waiting,
logged `replaced merge job …`. Nothing is absorbed into the running job, since a gate that read a
check just before it completed would end `wait` with nothing left to start it again.

On a PRD pull request (head `agent/prd-…`), where the review went ahead and the head did not move
while it ran, the worker asks for one more `write` token and runs `review:advance` after
`review:conclude`, as the reusable's advance job does. Advance may put `agent:implement` back on
the PRD's parent. The service answers that label with an implement job and an implement-prd job
again: the implement job's gate defers the PRD without a word, and the implement-prd job builds the
next slice. So the whole chain runs on the service, a job per slice, with other jobs between them.
The service keeps nothing of the chain between slices: each gate reads where it stands from the
record, so a worker restarted between two slices picks the chain up at the next
`agent:implement`.

`review:conclude` runs however the phases before it ended, and is told each one's real outcome: a
runner that failed, with the reason it wrote; a token the dispatcher would not grant; a publish
that failed; a phase ended at its time limit. A run that ends before anything can write to the
pull request, because no token to write with was granted, says why in the worker's log instead.

Each run leaves a directory under `WORK_DIR/runs`, named for when it started and its job: the
checkout (a fix job's `checkout` and `publish-checkout`, an update-branch job's `gate-checkout`,
`checkout` and `publish-checkout`, an implement job's `checkout` and `publish-checkout`, and an implement-prd job's `catch-up-checkout`,
`checkout` and `publish-checkout`, one per job of its reusable that checks out), each subcommand's output directory under `out/` and its log under `logs/`, and
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
over; publish's checkout and `fix:publish` share 15 minutes, and `fix:conclude` gets 15. A round ended at its limit still bundles,
publishes and concludes: its ending says it timed out, and any commits it made are rescued. An
update-branch job's gate, checkout and merge share 15 minutes; the agent's job's steps share
`AGENT_TIMEOUT_MINUTES` (30 where unset), and a refresh ended at it pushes nothing and says it timed
out; publish's checkout and `update-branch:publish` share 15 minutes, and `update-branch:conclude`
gets 15. An implement job's gate gets 10 minutes; the agent's job's steps share
`AGENT_TIMEOUT_MINUTES` (30 where unset), and a build ended at it publishes nothing and says it
timed out; `implement:bundle` gets 5 of its own, so a build stopped at its limit still hands its
commits over for the rescue; publish's checkout and `implement:publish` share 15 minutes, and
`implement:conclude` gets 15. An implement-prd job's gate gets 10 minutes, and the catch-up's checkout and
`implement-prd:catch-up` 10 together; the agent's job's steps share `AGENT_TIMEOUT_MINUTES` (30 where
unset); `implement-prd:bundle` gets 5 of its own, so a build stopped at its limit still hands its
commits over for the rescue; publish's checkout and `implement-prd:publish` share 15 minutes, and
`implement-prd:conclude` gets 15. A follow-ups job's `follow-ups:file` gets 10 minutes, the job's
`timeout-minutes` in `follow-ups.yml`, and `follow-ups:conclude` 10 of its own. A merge job's gate
and publish share 20 minutes, the job's `timeout-minutes` in `merge.yml`, and `merge:conclude` gets
20 of its own. A job's deadline is
set at dispatch and the worker never moves it, whichever lane the job waits in: a hand-off to the
agent lane neither restarts nor extends it. A job that waits in the queue for longer than the
dispatcher's `JOB_DEADLINE_MARGIN_MINUTES` is past its deadline by the time it asks for its next
token, and ends with nothing posted, so set the margin above the longest wait you expect: for an
agent job, the agent jobs ahead of it; for a light one, the light jobs ahead of it and any earlier
job for its item.

### The repository's setup

A repository's setup is its repository variable `AGENT_SETUP`: a script, the install and anything
else its verify command needs, the same text a caller's `setup:` input holds on Actions. Only an
admin can set it. The dispatcher reads it with the other variables and the job carries it; the
worker hands it to the sandbox's shell through the environment, as written, and never splices it
into a command line. Unset or empty, the setup is skipped. A fix job runs it after `fix:prepare`
and before its runner, an implement job after `implement:prepare`, an implement-prd job after
`implement-prd:prepare`, and an update-branch job after `update-branch:prepare`, only where its merge
conflicted; a review runs none, as `review.yml` runs none. A setup that fails starts no
runner, and the round's failure comment quotes the end of its output.

It runs **in the bwrap sandbox, never on the worker's host**, whatever `AGENT_SANDBOX` says of the
agent's, since the host holds what can ask for tokens and setup runs the pull request's code. So
`bwrap` is needed on the worker's host even with `AGENT_SANDBOX=none`. The sandbox is the agent's
shape: the checkout bound read-write at the path the agent will work at (below), its `.git` read-only, so nothing setup runs can
plant a hook or a configuration that host-side git would later run; `AGENT_SANDBOX_RO_BINDS` and
`AGENT_SANDBOX_PATH` for the toolchain; a fresh home and `/tmp`, removed after; no token in its
environment; and the agent's network (#537): wherever `AGENT_SANDBOX_PROXY` is set, under `none`
too, setup's network is its own loopback, and **the proxy is its only way out**, so the proxy must
**let the package registry through** for setup's install. A tool that ignores the proxy variables,
or resolves names itself, fails there: nothing inside resolves a name or reaches an address but
through the proxy. A proxy the sandbox cannot use, an `https:` one or one that is not a URL, fails
setup's phase under `none` with the reason the worker refuses it for under `bwrap`, and starts no
sandbox. Under `none` with no proxy, setup has the host's network, with no proxy variables, as the
agent has there, and the host's firewall is what limits its egress. It is run as Actions runs a `run:` step, by `bash` stopping
at the first failing command, under the job's time limit, and ended with everything it started at
that limit. A setup that exits non-zero fails its phase with the exit status and the end of its
output, kept in full in the run's `logs/setup.log`.

What it leaves in the checkout reaches the agent under either `AGENT_SANDBOX`, and setup sees the
checkout at the path the agent will work at, so a path setup records still holds for the agent. With
`none` the agent works in the checkout itself, and setup sees the checkout at its own path. With
`bwrap` the agent works in a copy at `/home/agent/workspace`, cloned from the checkout's history,
and everything the checkout holds outside git, ignored or not, is copied in beside it, and excluded
there, so none of it comes back as the agent's work; setup sees the checkout at
`/home/agent/workspace` too (#526). So a Python virtual environment, whose scripts name its path,
works for the agent as `node_modules` does.

**`node-version-file` is not supported.** The sandbox runs the agent box's own Node, the one
`AGENT_SANDBOX_RO_BINDS` and `AGENT_SANDBOX_PATH` give it. A repository that needs another
toolchain stays on Actions for now.

### Settings

Read from the environment. A missing required one stops the worker at start, naming each.
`tests/service/settings.test.ts` holds this table equal to `WORKER` in `service/settings.ts`.

| Setting | Kind | Default | Meaning |
|---|---|---|---|
| `WORKER_SECRET` | required | | the secret the dispatcher and the worker share, the dispatcher's own `WORKER_SECRET` |
| `DISPATCHER_TOKEN_URL` | required | | the dispatcher's token door, ending `/token`; the worker announces its start at `/started` beside it, once its own door listens |
| `CLAUDE_CODE_VERSION` | required | | the version of `@anthropic-ai/claude-code` the worker installs at start, so "latest" is never chosen by accident |
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | the agent's model token, handed to the runner alone |
| `WORK_DIR` | required | | where the agent's CLI is installed and each run's directory is kept |
| `JOBS_HOST` | optional | `127.0.0.1` | the address the job door listens on: one the dispatcher reaches |
| `JOBS_PORT` | optional | `8787` | the job door's port; jobs arrive at `POST /jobs`, which the dispatcher's `WORKER_URL` names, and a scan asks what the worker holds at `POST /held` |
| `WORKER_PROXY` | optional | `""` | an `http:` or `https:` URL: the proxy the worker's own requests (the CLI's install, its token requests) and every subcommand it starts leave through, by `HTTP_PROXY`, `HTTPS_PROXY`, their lower-case forms and `NODE_USE_ENV_PROXY=1`, never with a `NO_PROXY`; empty connects directly, and the worker refuses to start on anything else. It does not reach the sandbox, whose proxy is `AGENT_SANDBOX_PROXY`. Unlike that one it may be `https:`, since the worker names the proxy by its own host, which its certificate names |
| `AGENT_SANDBOX` | optional | `bwrap` | the sandbox the agent runs in, `bwrap` or `none` (spec §3); `none` runs the agent with the worker's own filesystem |
| `AGENT_SANDBOX_RO_BINDS` | optional | `""` | host directories, `:`-separated, bound read-only into the sandbox for the toolchain; the CLI's prefix is added |
| `AGENT_SANDBOX_PATH` | optional | `/usr/local/bin:/usr/bin:/bin` | `PATH` inside the sandbox; the CLI's directory is put first |
| `AGENT_SANDBOX_PROXY` | optional | `""` | an `http:` URL with a host: the proxy every request from the sandbox leaves through, the only way out of the agent's sandbox, and, wherever it is set, of the repository's setup's (spec §3). **Required when `AGENT_SANDBOX` is `bwrap`**, the default: the worker refuses to start with it empty or not such a URL, and refuses an `https:` one, since the sandbox reaches the proxy by a loopback address its TLS certificate does not name. Inside, the proxy variables name a relay on the sandbox's loopback, as an `http:` URL keeping this one's user-info |

The job door also answers `GET /health` with `200`.

## Restarts and outages

- **A delivery that arrives while the dispatcher is down is lost**, since GitHub does not
  redeliver on its own (*What it does not keep*, above): after an outage, redeliver from the App's
  *Recent Deliveries*, or remove the label and add it again. A label a lost delivery added
  to an open item is picked up by the scan at the dispatcher's start (*What it does not keep*,
  above). What a scan does not list stays lost: a merge's follow-ups, above all.
- **A dispatcher restarted alone** recovers the jobs the worker holds queued from it: its start
  scan has the worker drop them and dispatches their items again. Only the jobs that had started
  are lost: the one running in each lane, and every update-branch job waiting for the agent lane
  after its merge conflicted, of which there can be several. Each keeps its label until a person
  adds it again (*What it does not keep*, above).
- **The worker's queue is in memory too**: a worker restarted mid-job loses the jobs running and the ones
  waiting behind them. Its start announcement makes the dispatcher scan, which dispatches each of
  them again, the running ones and the queued ones alike, since each item keeps its label. Where
  the dispatcher is down when the worker starts, its own start scans instead. A job that itself
  ends the worker's process is dispatched again by the scan up to `SCAN_DISPATCH_LIMIT`'s number of
  times, and then left for a person, with a comment on its item saying so (*The scan's limit*,
  above).
- **Each piece restarts itself, in order.** Run both processes under something that restarts them
  at boot and after a crash (a container's restart policy, a systemd unit), with the worker
  started after its proxy, and the firewall around the worker's host in place before the worker's
  host starts. The worker installs the agent's CLI again at each start, so give it a moment, and
  the network, before its door answers.

## A worked example: the maintainer's Unraid server

One deployment, recorded so it can be rebuilt; nothing in it is in the package's code. The
dispatcher runs on an Unraid server; the worker runs in a VM on it, the *agent box*, which is the
wall between the agents and the NAS (#364). GitHub reaches the dispatcher through Tailscale Funnel.
The scripts that build, upgrade and check it are in [`deploy/unraid/`](../deploy/unraid/README.md),
with this deployment's own values in an `agent-service.conf` beside them; they are not part of the
package.

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
  that is to tinyproxy, so nothing on the box leaves except through the proxy, the worker included.
  For the agent it is now defence in depth: the sandbox has a network of its own, which reaches
  tinyproxy only through the worker's socket, and loopback in there is the sandbox's own, so the
  box's services on `lo`, the job door among them, are out of the agent's reach whatever this rule
  says. The repository's setup has the same network (#537), so for setup too it is defence in
  depth. What it still limits on its own is the worker's own traffic;
- the package installed, as root, into `/opt/agent-workflows`, so the worker never fetches it
  itself. The first install still takes the registry route (*Installing the package*, above):
  `install-box.sh` asks for a token, uses it and deletes it. An upgrade takes the tokenless
  install, from a tarball Unraid downloads and copies here (*Upgrading both*, below), and no
  longer uses the registry;
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
the VM's own Autostart stays off. This firewall is a control in its own right, not made redundant
by the sandbox's network: it is what holds the whole VM, not only the agent, off the LAN and the
NAS, and what holds tinyproxy itself to the token door among `agentnet`'s addresses. The token door
is reachable from inside the agent box, the sandbox included through tinyproxy, which is why it
mints only for a request signed with `WORKER_SECRET`, a file the sandbox cannot see; that signature,
too, stays a control of its own.

**The dispatcher** lives in `/mnt/user/appdata/agent-dispatcher/`: the App's key, `app.pem`, its
settings, `service.env`, and the package, installed once into `pkg/` by a throwaway container
(`docker run --rm … node:24-alpine npm install --prefix /pkg …`), so the server keeps no registry
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
from a dispatcher of another release (*Upgrading both*, below). **Tailscale Funnel** publishes the webhook door, on port 10000 (the server's `serve` already
holds 8443):

```bash
tailscale funnel --bg --https=10000 http://127.0.0.1:8790
```

The App's webhook URL is then the server's Funnel name, `https://<node>.<tailnet>.ts.net:10000/github`.
Leave *Settings → Tailscale → Allow Tailscale Funnel* at **Yes**, or the plugin's watcher removes
the Funnel.

**Upgrading both** is one command, run as root on Unraid, and needs no registry token:

```bash
bash /boot/config/agent-service/upgrade.sh [--now] <version>
```

It downloads the release's tarball and its `.sha256` once, on Unraid (the tokenless install,
above, from the repository `PACKAGE_SOURCE` names in `agent-service.conf`), checks it, and copies
it to the box over ssh as `BOX_SSH_USER`, with the box's `upgrade-box.sh`, `check-box.sh` and the
conf, where the digest is checked again. Then it installs on both with neither service touched,
waits for the worker to hold no job, restarts the worker and straight after it the dispatcher, and
runs both check scripts, failing where their versions or the shared secret's fingerprints differ.

The wait is there because the worker's queue is in memory (*The worker's queue is in memory too*,
above): a restart drops every job it holds, and a running one, which may have run for most of its
time limit, starts again from the beginning. So the script asks the worker's held door which jobs
it holds, from inside the dispatcher's container with the `WORKER_SECRET` already set there, so
the secret is never printed, written or put on a command line. The question names no dispatcher
instance, so it is a read only and the worker drops nothing for it. Nothing held, it goes on;
anything held, it waits, printing the jobs (workflow, repository and number), a line when they
change and a line every five minutes, for up to `IDLE_WAIT_MINUTES` in `agent-service.conf`, 90 by
default: one job reaching the longest default time limit, implement-prd's 65 minutes, with room to
spare. Past the bound it restarts nothing, says both machines have the version installed, names
what is still held, and names the two ways on: run it again later, or run it with `--now`, which
restarts without asking and drops what the worker holds. A worker it cannot ask (unreachable, a
refused signature, an answer that is not a list of jobs) is not read as idle: it stops the same
way, naming `--now`. The one exception is a `404`, from a worker of a release before the held door,
where it says it cannot tell and goes on. One window stays open: a webhook that lands between the
worker's empty answer and its restart queues a job the restart drops, and the dispatcher's scan
dispatches it again.

Between the two restarts the dispatcher gets 409 from the worker, its scan's dispatches included;
the script says for how many seconds. The
restarted dispatcher's own scan dispatches the dropped jobs again. Where the worker's restart fails, it
stops before restarting the dispatcher, and where any step stops it prints the commands that
finish the job, or the way back: `upgrade.sh` at the earlier version, which installs it on the box
first. Its halves, `upgrade-unraid.sh` and
`upgrade-box.sh`, each install a tarball they are handed and can still be run alone, to recover or
roll back one machine. None of the three uses the registry route any more.

**After a reboot the chain comes back on its own**, as #374 showed with the prototype, the same
chain of units and scripts: the array
starts, `agentnet-firewall` puts the rules in and starts the VM, the VM's units start in order
(its egress rules, tinyproxy, the worker), the dispatcher's container comes back, and the Funnel
stays public. About 11 minutes from *Reboot* to a review. Restarting the VM service alone does
**not** bring it back (Unraid cannot remount `libvirt.img` until a reboot), so reboot the server
instead of turning VM Manager off and on. Deliveries made while it was down are lost, as above,
but a label they added to an open item is dispatched by the dispatcher's start scan; only what a
scan does not list, a merge's follow-ups above all, needs a hand.
