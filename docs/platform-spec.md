# The runner ⇄ orchestrator platform spec

The contract between a **runner**, the program that does one step of the loop, and an
**orchestrator**, whatever invokes it and acts on what it returns. Each fact here has one binding
location: this spec holds a fact, or links to the tested home that holds it, and never copies it.
Either half can be replaced; on the runner's side, Claude Code is the agent.

## 0. Reading this

**Who it is for.** The author of an orchestrator that is not the GitHub Actions one this repository
ships, and the maintainer changing a runner that such an orchestrator depends on. Installing the
Actions orchestrator is [ADOPTING](./ADOPTING.md)'s, and this spec is not needed for it.

**Binding against description.** A sentence that binds every orchestrator, or every runner, says
so in bold italics, written `***must***` or `***must not***`. Those words appear in no other
sentence. How one orchestrator does a thing is description, and sits in a quoted block that names it:

> **Actions orchestrator:** the caller and reusable workflow pair this repository ships.

> **Service orchestrator:** a service that receives GitHub's webhooks and runs the runner on a box
> it owns: the `dispatcher` and `worker` subcommands of this package, whose code is
> [`service/`](../service/) and whose deployment is
> [deploying-the-service.md](./deploying-the-service.md). It answers every trigger label the loop
> has but `agent:merge`: `agent:review`, `agent:fix`, `agent:update-branch` and `agent:follow-ups`
> on a pull request, `agent:implement` on an issue, a regular one or a PRD, and every merge, for
> `follow-ups`. At this release it does not serve `agent:merge` (§12). A block for it appears only where it differs from the Actions orchestrator in a way a
> reader would trip on.

Neither block binds anyone. Where they disagree with a bold sentence, the bold sentence is right.

**Why some parts are links.** A fact with a tested home is linked rather than restated: label
meanings are [ADOPTING §3](./ADOPTING.md#3-labels)'s, and each runner's and command's inputs and
outputs are declared once, in [`shared/contract.ts`](../shared/contract.ts), which an orchestrator
can import to build the environment it hands a runner or a command. The tables below are the same
facts read twice, and a test holds them equal, so they are not a copy that can drift.

**Tested, and held by convention.** `tests/platform-spec.test.ts` holds:

- the §2.2 table and each runner's and command's `Inputs` table to its declaration, on name and on
  required or optional, in both directions;
- the §2.4 table and each runner's and command's `Outputs` table to its declared output files, in
  both directions;
- that every runner section, both its tables and its record part are present, that every command
  has a section with both its tables in its workflow's, and that §3 and §4.1 to §4.3 are present;
- that each Actions reusable sets every input its runners and commands declare required;
- that the binding words appear only in bold, and never in an orchestrator block.

Everything else here is held by convention: the conventions in
[`CLAUDE.md`](../CLAUDE.md) that name this spec, and review. That includes all of §3 and §4: the
safety outcomes, and the record strings, which YAML steps write as well as TypeScript, with no one
call shape a test could read. A default, a meaning, or what an
orchestrator does with a result is prose, and nothing compares it with the code.

**`doctor`.** Each clause says whether `doctor`, the Actions orchestrator's install check, checks
it. Where it does not, the clause says **`doctor` cannot check this.** and why. A clause `doctor`
cannot check is one only an orchestrator's author will catch.

## 1. Terms

- **Runner.** One of five subcommands of this package's binary: `implement`, `implement-prd`,
  `review`, `fix` and `update-branch`. It reads its inputs from the environment, starts the agent,
  and writes files and commits. It is not the agent.
- **Command.** A subcommand that does an orchestrator's work on the record and starts no agent,
  named `<workflow>:<step>`: `fix:gate`, `fix:prepare`, `fix:bundle`, `fix:publish`, `fix:conclude`, `follow-ups:file`, `follow-ups:conclude`, `implement:gate`, `implement:prepare`, `implement:bundle`, `implement:publish`, `implement:conclude`, `implement-prd:gate`, `implement-prd:catch-up`, `implement-prd:prepare`, `implement-prd:bundle`, `implement-prd:publish`, `implement-prd:conclude`, `merge:gate`, `merge:publish`, `merge:conclude`, `review:gate`, `review:budget`,
  `review:collect-checks`, `review:red-check-place`, `review:red-check-classify`, `review:publish`,
  `review:conclude`, `review:advance`, `update-branch:gate`, `update-branch:merge`,
  `update-branch:prepare`, `update-branch:bundle`, `update-branch:publish` and
  `update-branch:conclude`. §2 says where it differs from a runner.
- **Orchestrator.** Whatever invokes a runner and acts on its result: it decides when a runner runs,
  prepares the checkout, sets the inputs, and posts, pushes and labels with what comes back. The
  Actions orchestrator is a caller plus its reusable workflow, and `CONTEXT.md`'s *three parts*
  describe its internals.
- **The agent.** The model CLI a runner drives inside its sandbox: Claude Code, run as `claude`.
- **The record.** What the loop leaves on GitHub that a later run reads back: posts by the loop's
  accounts, markers in their text, status contexts, commit trailers and branch names. A runner reads
  it to know which round it is in and what earlier rounds found.
- **The loop's identity.** The accounts whose posts a runner counts as the loop's own, and so as
  part of the record rather than as untrusted text.

## 2. The process boundary

This section is written of a runner, and holds for a command too, with one difference: a command
starts no agent, so §2.5's `claude` precondition and §3's outcomes about the agent do not apply to
it, and it is the one kind of subcommand an orchestrator may hand a write credential. Which kind a
subcommand is, is declared in `shared/contract.ts`, in `RUNNERS` and `COMMANDS`.

### 2.1 Invocation

An orchestrator ***must*** invoke a runner as `<bin> <runner>`, with `<bin>` the package's binary,
`agent-workflows`, and no further arguments. All of a runner's input is its environment. A runner
refuses an argument rather than ignoring it, and exits 2.

**`doctor` cannot check this.** The invocation is the orchestrator's code, and `doctor` reads a
repository, not a running orchestrator. The Actions orchestrator's invocation is in its reusable
workflows, which the build reads.

> **Actions orchestrator:** each reusable's runner step is
> `npm exec --prefix "$RUNNER_TEMP" --yes --package=@jeffwlawson/agent-workflows@<version> -- agent-workflows <runner>`,
> with the inputs in that step's `env:` and its job's, and each command step the same with the
> command's name. The red check's job, fix's agent job, and update-branch's gate and agent jobs
> install the package first, with `npm install --prefix "$RUNNER_TEMP"`, and run their commands
> from `RUNNER_TEMP`, where that line finds the install without asking the registry (§8, §9, §10).
> Fix's runner and update-branch's work in the checkout, where `npm exec` finds no install under its
> `--prefix`, so each runs that install's binary by its path,
> `"$RUNNER_TEMP/node_modules/.bin/agent-workflows" <runner>`, and is handed no registry token.

### 2.2 Inputs

Every input is an environment variable, declared in `shared/contract.ts` as **required** or
**optional**. An empty value is the same as an unset one.

- An orchestrator ***must*** set every required input of the runner it invokes, non-empty.
- A required input that is missing stops the runner at start, before any of its own work, with a
  `failure_reason.txt` (§2.4) naming the input. `OUTPUT_DIR` is the exception: it is where that file
  would go, so a missing one is reported on stderr alone, and no file is written.
- An optional input has a declared default, and a runner ***must not*** read an input its
  declaration lacks. This is the loud-default rule: an input is either one a run stops without, or
  one whose absence means something stated, never a quiet fallback nobody chose. An input read only
  by a subprocess, such as `GH_TOKEN` read by `gh`, is declared all the same and checked at start.

A command may declare a third kind, a **directory** input: the path of another subcommand's
`OUTPUT_DIR`, required like any other, naming that subcommand, its producer, and exactly the files
read from it. Its row's Kind is `directory`, and its last cell names the producer and each file,
with `(where written)` after a file the producer writes only on some outcomes. Such a file that is
not there reads as absent. A file the producer always writes that is missing, or any declared file
that does not parse, fails the command (§2.4) before its first write. The command reads no other
file in the directory, so an orchestrator ***must*** hand over at least the files named there.

Defaults and meanings are prose; the test compares the name and the Kind column only, and a
directory input's producer and files.

**`doctor` cannot check this.** For the Actions orchestrator the reusable sets the runner's inputs,
and the build holds each reusable to them. A caller missing a required input of its own (a
`with:` input or a secret the reusable declares required) is refused by GitHub before any job
starts, naming the input, and #373 verifies that. `doctor` does check that
`CLAUDE_CODE_OAUTH_TOKEN` is set as a secret, which is where the Actions orchestrator reads it from.

The inputs every runner reads, set once for any of them:

| Input | Kind | Default | What it is |
|---|---|---|---|
| `OUTPUT_DIR` | required | | The directory the runner writes its files into (§2.3). |
| `GH_REPO` | required | | The repository, `owner/name`. Required rather than left to whatever `gh` infers. |
| `GH_TOKEN` | required | | The token `gh` reads. The runners only read with it, `fix:prepare` reads and fetches the rescue branch with it, and `update-branch:merge`, `update-branch:prepare` and `update-branch:publish` fetch the base branch with it; `follow-ups:file` posts the post-merge checklist, files its issues, posts its report and takes `agent:follow-ups` off with it, through the writer, `follow-ups:conclude` posts its failure comment with it, `implement:gate` makes its refusals, its start comment and its label transitions with it, `implement:prepare` reads and fetches the rescue branch with it, `implement:publish` the link on the issue with it and reads the rescue branch's tip, `implement:conclude` its set-aside note, its failure comment, `agent:implement` off and `agent:blocked` on, and reads the rescue branch's tip with it, `implement-prd:gate` its refusals, its start comments, its label transitions, the approved slice's note and the PRD PR's building row, `implement-prd:catch-up` fetches the PRD branch and the base branch with it and parks the chain with it, `implement-prd:prepare` reads and fetches the PRD branch and the rescue branch with it, `implement-prd:publish` fetches the base branch and the PRD branch and reads the rescue branch's tip, the open pull requests from the PRD branch and a reused PRD PR's rounds and head with it, `implement-prd:conclude` its set-aside note, its failure comment, `agent:implement` off and `agent:blocked` on, and fetches the base branch and the PRD branch and reads the rescue branch's tip and the PRD PR's rounds with it, and `review:publish` posts the review, the summary and the verdict with it, `review:conclude` its comments, its error verdict and the labels nothing fires on, `review:advance` a PRD PR's progress list and its notes there, `fix:gate` its refusals and its label transitions, `fix:publish` its thread replies, its comments and notes, and the rescue branch's deletion, `fix:conclude` its failure comment, the rescue-set-aside note where `fix:publish` did not post it, and `agent:fix` off and `agent:blocked` on, `update-branch:gate` its refusal and its label transitions, `update-branch:publish` the verdict it carries over, its comment, and the comment that no review will start, and `update-branch:conclude` its failure comment, `agent:update-branch` off and `agent:blocked` on, and the comment that no refresh of a moved head will start, `merge:gate` its refusals, its disarm, its red and behind comments and `agent:merge` off, and reads the head's statuses, checks and compare with its base with it, `merge:publish` `agent:merge` off after the merge, and reads the pull request's title with it, and `merge:conclude` its failure comment, `agent:merge` off and `agent:blocked` on, and reads whether the pull request merged with it. The arm and the merge are not made with it: they are `LOOP_TOKEN`'s. |

A command that runs where no token is held, as the red check's two do beside the pull request's own
code, and `fix:bundle`, `update-branch:bundle`, `implement:bundle` and `implement-prd:bundle` do after the agent,
reads `OUTPUT_DIR` alone of these: it reads no repository, so it declares neither `GH_REPO`
nor `GH_TOKEN`, and an orchestrator hands it neither.

Every runner starts the agent, so every runner reads the inputs that choose its sandbox (§3). An
orchestrator that sets none of them gets `none`. Each is a row in each runner's own table too:

| Input | Kind | Default | What it is |
|---|---|---|---|
| `AGENT_SANDBOX` | optional | `none` | Accepts `none` or `bwrap`: the sandbox the agent runs in (§3). Unset or empty is `none`, and any other value fails the run, naming it. |
| `AGENT_SANDBOX_RO_BINDS` | optional | `""` | Host directories, `:`-separated, that `bwrap` binds read-only at the same path: the toolchain, `claude` and `node`. Empty is none. |
| `AGENT_SANDBOX_PATH` | optional | `/usr/local/bin:/usr/bin:/bin` | `PATH` inside `bwrap`. |
| `AGENT_SANDBOX_PROXY` | optional | `""` | An `http:` URL with a host: the proxy every `bwrap` request leaves through, and the sandbox's only way out (§3). **Required when `AGENT_SANDBOX` is `bwrap`**: empty, or not such a URL, fails the run before the agent starts, naming it. An `https:` URL fails it too, with a reason of its own: the sandbox names the proxy by a loopback address, which the proxy's TLS certificate does not name. Means nothing under `none`. |

The last three mean nothing under `none`, where the agent has the runner's own environment and
filesystem.

Each runner's and command's own inputs are in its workflow's section, §6 to §12.

### 2.3 Outputs

A runner returns three things.

- **Files in `OUTPUT_DIR`.** Each runner's are listed in its `### Outputs` table, and the one
  every runner can write in §2.4. Some carry content and some **signal by existing**: a runner
  writes them only on one outcome, so their presence is the outcome. The orchestrator ***must***
  give every run a fresh, empty `OUTPUT_DIR`, so that a file an earlier run left is never read as
  this run's signal.
- **Commits on the checked-out branch.** The runners that change code commit on the branch they are
  handed and push nothing; publishing the commits is the orchestrator's.
- **The exit code** (§2.4).

**`doctor` cannot check this.** A fresh directory is a property of each run, not of anything in the
repository.

> **Actions orchestrator:** `OUTPUT_DIR` is `runner.temp`, which is fresh for every job. The agent
> job hands its files and a bundle of its commits to a publish job, which pushes, posts and labels.

### 2.4 Failure

| Output | When it is written |
|---|---|
| `failure_reason.txt` | On a failure the runner caught: the reason, in words a human can act on. Every runner can write it. |

| Exit code | Means |
|---|---|
| `0` | The runner did its step. |
| `1` | The run failed. The reason is on stderr, and in `failure_reason.txt` where `OUTPUT_DIR` is set. |
| `2` | Bad usage: an unknown subcommand, or an argument (§2.1). Reported the same way. |

An orchestrator ***must*** report every run that does not exit 0 somewhere a human will read it,
with the text of `failure_reason.txt` where the file exists. Where it does not, the runner never
wrote a reason, and the orchestrator ***must*** say so in its own words rather than say nothing.
That covers:

- a runner that **never ran**: a step before it failed, such as the install or the checkout;
- a runner that **was killed**: cancelled, or stopped at a time limit, which leaves no file;
- a runner started with **no `OUTPUT_DIR`**, which reports on stderr and writes no file (§2.2).

**`doctor` cannot check this.** Reporting is what the orchestrator does after a run, and `doctor`
reads no run.

> **Actions orchestrator:** the failure step comments on the issue or pull request with the reason
> file's text, or with *It stopped without giving a reason.* where there is none, which it replaces
> with the time limit where the job ran out of time, and with *It was cancelled* on a cancel. It then
> takes the trigger label off and adds `agent:blocked`.

### 2.5 Preconditions

A runner starts in a checkout its orchestrator prepared, and each runner's section says which:
which branch is checked out, and which refs the runner reads beside it. The orchestrator
***must*** prepare the checkout and the refs that section names before it invokes the runner.

**`doctor` cannot check this.** The checkout is prepared per run.

The orchestrator ***must*** put `claude` on `PATH`, at a version the configured model accepts, for
every runner that starts the agent. Which version, and how it gets there, is each orchestrator's.

**`doctor` cannot check this.** The version is whatever is installed on the machine that runs the
runner, at the time it runs, and the model is a repository variable that can change between runs.

> **Actions orchestrator:** `npm install -g @anthropic-ai/claude-code` in the agent job, so the
> latest release, on every run.

> **Service orchestrator:** the worker installs the CLI itself at start, into its own prefix, at
> the version its required setting `CLAUDE_CODE_VERSION` names, and refuses to start without one,
> so "latest" is never chosen by accident. The host's own `claude` is never used: the worker's
> goes first on the runner's `PATH` and the sandbox's, and is bound into the sandbox read-only.

## 3. Safety

The agent reads text anybody can write, an issue body or a review comment, and runs commands on
what it reads. So what it can reach is the orchestrator's to bound. These are outcomes, and how an
orchestrator meets each one is its own; the blocks below say how the two do.

1. **No write credential reaches the agent.** It ***must*** be given its model token and no
   other credential: no token that can push, post, label or read a secret.
2. **The agent's environment is an allowlist.** An orchestrator ***must*** hand the agent only the
   variables it names, never everything its own process holds.
3. **The agent cannot reach the orchestrator's secrets or other jobs.** The agent ***must not***
   be able to read a secret the orchestrator holds for its own use, or reach another run's
   process, files or credentials.
4. **The agent's output is checked before anything is published.** An orchestrator ***must***
   publish only through its own code, after the runner has returned, and ***must not*** let the
   agent push, post or label itself.

**`doctor` cannot check this.** Each outcome is a property of the machine a run happens on and of
the orchestrator's code, and `doctor` reads a repository. For the Actions orchestrator the build
holds the reusables to several of the mechanisms below (`tests/workflows.test.ts`).

> **Actions orchestrator:** outcome 1 is met in two places. The App's key, its minted token and
> `AGENT_PAT` are named only in jobs that never start the agent; and the runner deletes `GH_TOKEN`,
> `GITHUB_TOKEN` and `NODE_AUTH_TOKEN` from its own environment before the agent starts
> (`scrubGitHubTokens`, in `shared/env.ts`), so the context it fetched with them is all it kept.
> Outcome 2: the provider is `none`, so the agent inherits the runner step's environment, which is
> what the step and its job write out in `env:` and what Actions gives every step, less the
> scrubbed tokens. Outcome 3 is met by the runner VM, which is fresh for every job and holds only
> the secrets that job names. Outcome 4 is met by the publish jobs, which push, post and label from
> the runner's files after the agent job has ended. The controls themselves are listed in
> [parity §6](./parity.md#6-security-controls).

**The sandbox.** Which provider, and what it ***must*** support, is a runner concern the
orchestrator selects, through the runner's `AGENT_SANDBOX` input (§2.2). Unset means `none`: the
agent runs in the runner's own process environment and filesystem, and the orchestrator's isolation
of the whole run is all there is. `bwrap` runs the agent in bubblewrap on the host, with no access to
the host's home, credentials or other runs:

- every command the agent runs gets a fresh namespace, every capability dropped and the
  environment cleared but for what the runner hands the agent;
- the network is the sandbox's own: no interface but its loopback, no DNS, and `AGENT_SANDBOX_PROXY`
  the only way out. For the life of the sandbox, a process on the host listens on a Unix socket
  private to the run and copies every connection to the proxy's host and port, taking no
  destination from the sandbox; the socket is bound in, and before each command a relay inside
  listens on the sandbox's loopback and forwards to it. A direct connection to any address, the
  host's own included, fails. The relay is untrusted, and nothing depends on it: killed or replaced,
  it still reaches nothing but the proxy, whose allowlist is the policy;
- `/usr` and the directories `AGENT_SANDBOX_RO_BINDS` names are read-only, and the run gets a
  writable home and temporary directory of its own;
- the proxy variables, `HTTPS_PROXY`, `HTTP_PROXY` and their lower-case forms, name the relay's
  loopback address, always as an `http:` URL, with any user-info `AGENT_SANDBOX_PROXY` has, and no
  `NO_PROXY` is set;
- **`bwrap` requires a proxy.** Without one the agent could reach nothing, the model's API
  included, and would fail later on a connection error that names nothing, while the host's shared
  network in its place would fail open. So `bwrap` with `AGENT_SANDBOX_PROXY` empty, or not an
  `http:` URL with a host, fails the run before the agent starts, naming it. An `https:` one fails it
  too, with its own reason: a client checks an `https:` proxy's certificate against the name it was
  given, here the relay's loopback address, which no certificate names, so every request would fail;
- the agent works in a copy of the checkout: its history, cloned in, and what the checkout holds
  outside git, ignored or not, such as the install the repository's setup left there, copied in
  beside it, so the agent sees what it would see in the checkout itself; each path carried in is
  excluded in the copy's `info/exclude`, so it is never handed back as the agent's work, and a
  setup's untracked file the agent means to commit takes `git add -f` there;
- the agent's work comes back only as Sandcastle's patches and session files: a write under `.git`,
  or of a symlink that leaves the sandbox, is refused;
- so a merge in progress in the checkout is not in the copy, which is cloned from history, and a
  merge commit the agent made would not come back, since the patches leave merges out. A runner
  whose agent concludes a merge, `update-branch`'s (§10), has its agent work on a branch of its
  own, has the copy put mid-merge as a squash, and makes the merge itself, in the checkout, from
  the tree the agent committed.

Whatever provider a runner offers ***must*** support resuming a session, since a runner that
extracts a structured result runs the agent twice, the second time resuming the first session.
That is why `docker` and `podman` are not offered.

**`doctor` cannot check this.** The provider is chosen where the runner runs, not in the
repository.

> **Actions orchestrator:** relies on the quiet default. The runner VM is the isolation, and
> outcomes 1 to 3 are met around the whole job rather than around the agent.

> **Service orchestrator:** sets `AGENT_SANDBOX=bwrap`. The `bwrap` provider is isolated, not
> bind-mount, on purpose: a bind-mount provider hands the agent the checkout's `.git` read-write
> (sandcastle#1010), so `bwrap` copies the checkout in and the patches out instead. Sandcastle
> 0.12.0, the version this package pins, resumes a session only for bind-mount providers; its
> `docker` and `podman` are isolated, so they resume none. So `bwrap` carries the session between
> the two passes itself: it keeps the agent's sessions when a pass ends and seeds the next pass's
> sandbox with them. It sets `AGENT_SANDBOX_PROXY` too, since `bwrap` requires it, and its worker
> refuses to start with `bwrap` and no proxy rather than fail every job the same way. The
> repository's setup runs in a `bwrap` sandbox of the same shape, its network included: wherever
> `AGENT_SANDBOX_PROXY` is set, under `AGENT_SANDBOX=none` too, setup's network is its own
> loopback with the proxy its only way out, as the agent's is (#537). Under `none` with no proxy,
> setup's network is the host's, with no proxy variables, as the agent's is there.

## 4. The record

A runner reads back what earlier runs of the loop left on GitHub. An orchestrator that drives the
runners ***must*** leave that record in the shape this section gives, or the runners read the
pull request as one the loop has never touched: the prototype posted a real review and got
*Review 1* on every round, because its posts were not by an account the runner recognises.

### 4.1 The loop's identity

The runner recognises as the loop's own every account on a list: `github-actions[bot]`, always, and
each account the orchestrator passes in `AGENT_LOOP_LOGINS`, a comma-separated list of logins. It
is a list rather than one name because, at a migration, pull requests in flight carry both
accounts. Each account is matched in both the spellings GitHub reports it, from one entry given in
either:

| Login | Where GitHub reports it so |
|---|---|
| `<slug>[bot]`, so `github-actions[bot]` | The REST API, and a commit status's creator. |
| `<slug>`, so `github-actions` | GraphQL. |

Logins are matched without regard to case. An empty entry, as a trailing comma leaves, is ignored,
so with the input unset or empty the list is `github-actions[bot]` alone. An entry that is not a
login fails the run (§2.4), naming it.

This list is **trust**. It feeds `isTrustedAuthor` in `shared/common.ts`, the gate over every
world-writable surface a runner reads: a comment, review or thread by one of these logins passes
it whatever its author association, beside the `OWNER`, `MEMBER` and `COLLABORATOR` the gate
trusts by association. Whatever posts as one of these logins therefore becomes text `fix` acts on
and commits code from. Passing an account in is safe only because the orchestrator that passes it
already holds the write token. An orchestrator ***must*** post the loop's findings, notes and
statuses as one of these logins for a runner to read them back, and ***must not*** list, or let
anything it does not control post as, an account it does not control.

The same list, without the association half (`isWorkflowBot`), is what a runner or a command asks
where the question is *did the loop post this* rather than *is this trusted*: the reviews it
numbers rounds by, the verdict and fix-round statuses it counts (§4.3), the earlier findings it
carries forward, and the review bodies `follow-ups:file` files from. `review:budget`,
`review:conclude` and `update-branch:publish`, which carries the newest verdict of these accounts
over to a clean merge, match a status's creator against it in the REST spelling. Every runner and
command that asks declares `AGENT_LOOP_LOGINS`; the `update-branch` runner, which asks neither
question, does not.

One record is read by a narrower identity than this list: the merge arm (§4.3, §12). `merge:gate`,
and `update-branch:publish`, which carries it over to a clean merge (§10), read an `agent-merge`
status only where its creator is `LOOP_LOGIN`, the one account the loop's
token writes as, and never `github-actions[bot]`, which any workflow in a pull request's own branch
can post as. Where the loop's token is the workflow token, nothing is an arm.

**`doctor` cannot check this.** The login is whichever account the orchestrator posts as, and the
Actions reusable will work out its own App's login at run time (#305); nothing in a repository
names it beforehand.

> **Actions orchestrator:** reviews, comments and statuses are posted with the job's
> `GITHUB_TOKEN`, so as `github-actions[bot]`, and the reusables leave `AGENT_LOOP_LOGINS` unset.
> Only a workflow in the repository can post as it, and adding or editing a workflow takes write
> access, which is why trusting the login is sound there. The loop's App carries pushes, pull
> requests, ready-marks and trigger labels, which no runner reads as text, and the merge arm and
> the merge itself (§12), whose arm `merge:gate` reads back as the loop token's account alone.

> **Service orchestrator:** posts as its own App, and passes that App's login in
> `AGENT_LOOP_LOGINS` to every runner and command that declares it, so its reviews, verdicts and
> rounds are read back as the loop's. The dispatcher works the login out from the App's own
> record, `<slug>[bot]`, and the job carries it; nothing configures it, so a typo cannot make every
> round the first. Left unset, its posts would be read as untrusted text, its verdicts not
> counted, and every round as the first.

### 4.2 Labels

What each `agent:*` label means, which object it goes on, and its lifecycle (on while the run
works; for `agent:merge`, the maintainer's merge decision, armed until merged or disarmed) is
[ADOPTING §3](./ADOPTING.md#3-labels)'s, and the build reads that table. A label is
record: an orchestrator that answers one ***must*** give it that meaning.

A repository ***must*** be served by one orchestrator, for every label. Two listening for the same
label on the same repository would run the same step twice, on the same branch, and post twice.
Split by label, each would run a step of a loop the other started: a label's run adds the next
label, so one orchestrator would be continuing the other's chain, through the record.

A repository says which orchestrator serves it in the repository variable `AGENT_ORCHESTRATOR`
(`ORCHESTRATOR_VARIABLE` in `shared/record.ts`). Unset means the Actions orchestrator, and
`service` the service orchestrator. Any other value names neither: an orchestrator ***must not***
answer a label on such a repository unless it would answer one with the variable unset, so a typo
falls back to the orchestrator the repository already had rather than to two. A service
orchestrator answers only the labels `SERVICE_LABELS` in `service/dispatcher.ts` lists, the keys
of its map from trigger label to job kind, per event type: `agent:review`, `agent:fix`,
`agent:update-branch` and `agent:follow-ups` on a pull request's delivery and `agent:implement` on
an issue's, which is every trigger label the loop has but `agent:merge`. That one is not in
`SERVICE_LABELS` at this release (§12). A label is answered on its own event type only, and on a
service-served repository every other label, `agent:merge` included, is answered by nothing. A merge is the
one trigger that is not a label: a `follow-ups` job is started as well on the `closed` delivery of
every pull request merged, whatever its labels (§11).

`doctor` reads the variable. It reports any value but unset or `service` as an error, and one it
could not read as unknown. With `service`, it checks that the labels the service answers exist,
and names, as a warning, each trigger label nothing answers there. At this release that is
`agent:merge`, which it names whether or not the `merge` caller is installed.

**`doctor` cannot check this.** It reads which orchestrator a repository asks for, not which one
listens: a caller left installed listens and skips, and a service listens from outside the
repository. Nor can it see whether a service's App is installed on the repository, since that App
is the service's and not the loop's.

> **Actions orchestrator:** every job of every reusable opens its `if:` with
> `vars.AGENT_ORCHESTRATOR != 'service'`, so on a service-served repository a caller's run skips
> every job. The skip is in the reusable, so a caller needs no change to carry it.

> **Service orchestrator:** answers a repository whose `AGENT_ORCHESTRATOR` is `service`, and
> refuses one where it is unset or holds anything else. Opting in is not enough on its own: the
> dispatcher serves an installation of its App only on the App's owner's account, read off the
> App's own record at start, or on an account its `EXTRA_OWNERS` setting lists, and refuses any
> other's, at delivery and again at each token, so a stranger who installs a public App and sets the
> variable is still refused. The App being installable on its owner's account only is the first
> line of defence, and this check the second.

What an orchestrator does after a runner returns, including adding the next label, is chaining.
Chaining is each orchestrator's own and is described in each runner's section: review adding
`agent:fix` (§8), fix asking for the next review (§9), and the PRD advance that puts
`agent:implement` back on the parent (§7, §8). Where a command makes the hand-off, it is package
code every orchestrator runs rather than each one's own: review's fix round is `review:conclude`'s,
and fix's re-review is `fix:publish`'s. So is taking a run's own label off however it ended:
`review:conclude` takes `agent:review` off, and `fix:conclude` `agent:fix`, or `fix:gate` where it refused the run;
`update-branch:conclude` takes `agent:update-branch` off, or `update-branch:gate` where it refused the run.
Update-branch's re-review of a resolution is `update-branch:publish`'s, and its request for itself
again where the head moved while it worked is `update-branch:conclude`'s. `agent:merge` is not a
run's label and stays on when a run merely ends: `merge:gate` takes it off where it refuses or
disarms the run, `merge:publish` after the merge, and `merge:conclude` where the run stopped (§12).
The hand-offs to and from merge are commands' too (#589): `merge:gate` asks for
`agent:update-branch` on a behind head, and `update-branch:conclude`, on a run that finished, and
`review:conclude`, on an approval, re-add `agent:merge` to re-start the gate, which never arms.

### 4.3 Markers, status contexts, trailers and branch names

The strings a runner reads back. Each is written by a runner's output, by the orchestrator, or by
both, and the runner that reads it is named in its section.

Every marker below is an HTML comment, invisible on GitHub, and every one is a selector rather
than a control: a runner counts it only on a post by the loop's identity (§4.1), or by a trusted
author where the table says so. `review` strips the finding and resolution markers from every
string the agent wrote, so the agent cannot forge one of those through a review.

**Headings and markers in posts.**

| String | Where it sits | Written by | Read by |
|---|---|---|---|
| `## Agent review` | The opening of a review's body, after its round header. A review by the loop with this heading is one round. | `review:publish`, from `review`'s `review_body.json` | `review`, `fix`, `implement-prd`, to count rounds |
| `**Review <r>**`, `**Slice <k> of <n> · #<sub> · review <r>**`, `**Final review · review <r>**` | The round header, the first line of a review or fix comment. | `review:publish`, from `review`'s `review_body.json`, and `fix:publish`, from `fix`'s `round_header.txt` | the same three, to tell a PRD PR's rounds apart by slice; `review:budget`, to tell which round a fix-round status was spent in |
| `<!-- agent-finding <id> … -->` | Each finding's inline comment. A review body carries none since #224. | `review:publish`, from `review`'s `findings.json` and `review_body.json` | `review`, `fix`, as the findings still open |
| `<!-- agent-resolution ADDRESSED -->`, `<!-- agent-resolution WONT_FIX -->` | The reply that closes a finding's thread. | `review:publish`, from `review`'s `thread_resolutions.json` | `review`, `fix`, as the findings settled |
| `<!-- agent-fix:out-of-scope {…} -->` | A note on a finding the fix judged out of scope. | `fix:publish`, from `fix`'s `out_of_scope_notes.json` | `review`, which rules on it; `fix`, to not repeat it |
| `<!-- agent-fix:top-level -->` | A top-level comment the fix posted. Read on a trusted author's post too. | `fix:publish`, from `fix`'s `top_level_comments.json` | `review`, `fix`, to leave the loop's own comments out of the feedback |
| `<!-- agent-fix:conversation-outcomes -->` | The comment saying what the fix did with the conversation. | `fix:publish`, from `fix`'s `conversation_outcomes.json` | `review`, `fix`, the same |
| `<!-- agent-follow-ups {…} -->` | A review body that recorded out-of-scope findings: `version` (`1`), `dropped`, `moved`, `cap`, `cut` where not zero, `followUps`, and on a PRD PR `resolved`, the ids of every carried follow-up a round on it ruled resolved (#495), written where not empty, so a later round carries none of them from an older review. A reader that does not know a field ignores it. An edited review's is refused. | `review:publish`, from `review`'s `review_body.json` | `review`, to not record one twice; `follow-ups:file`, to file them |
| `<!-- agent-red-tests {…} -->` | A slice round's review body: the red check's tests. | `review:publish`, from `review`'s `review_body.json` | `review`, on the PRD PR's final review |
| `<summary><b>Acceptance criteria</b>` | A review body's criteria group, its `- **Changed:**` and `- **Unmet:**` lines. | `review:publish`, from `review`'s `review_body.json` | `review`, on later rounds of the same slice |
| `<!--{"version",…,"location","pr","seq"}-->` | The end of a filed follow-up issue's body. | `follow-ups:file`, which files it through `createIssue`, as `stubMarker` in `shared/record.ts` spells it | `follow-ups:file`, to not file one twice, and to read back a stub GitHub filed while answering with a server error |
| `<!-- agent:prd-started -->` | The end of a PRD chain's first run's comment on the parent, saying which sub-issue it builds first. | `implement-prd:gate`, as `PRD_STARTED_MARK` in `shared/record.ts` spells it | `implement-prd:gate`, to not post it twice on a retry |
| `<!-- agent:slice-approved <sha> -->` | The end of the note on an approved slice's sub-issue, `<sha>` the PRD PR head it was approved on. | `implement-prd:gate`, past an approval, as `sliceApprovedMark` in `shared/record.ts` spells it | `implement-prd:gate`, to not post it twice on a retry |
| `<!-- agent:post-merge-checklist -->` | The end of the post-merge checklist on a merged pull request (§11). | `follow-ups:file`, as `POST_MERGE_CHECKLIST_MARK` in `shared/record.ts` spells it | `follow-ups:file`, to not post it twice on a retry |
| `<!-- agent:merge-red <sha> -->` | The end of the comment saying an armed head `<sha>` is not green, so it was not merged and the arm stays (§12). | `merge:gate`, as `mergeRedMark` and `mergeRedComment` in `shared/record.ts` spell it | `merge:gate`, to say it once per head |
| `<!-- agent:merge-behind <sha> -->` | The end of the comment saying an armed head `<sha>` is behind its base, so `agent:update-branch` was asked for, and the arm stays (§12). | `merge:gate`, as `mergeBehindMark` and `mergeBehindComment` in `shared/record.ts` spell it | `merge:gate`, to say it once per head |
| `### After merge, by a human`, or `**After merge, by a human:**` on a line of its own | A brief's list of checks only a person can make after merging, in the linked issue's latest brief (the text the review reads its criteria from). Read from a trusted author's text only (§4.1). | triage, by hand | `follow-ups:file`, for the post-merge checklist |

**Markers in a pull request's body.** The orchestrator writes the body, and a regular pull
request's is written by `implement:publish`, as `renderPullRequestFrame` in `shared/pr-frame.ts`
spells it: the note with the status line between its markers, the run link, the `---` rule, the
summary block with its placeholder, and `Closes #<n>`. A PRD PR's is written by
`implement-prd:publish`, as the same renderer spells a PRD PR's frame: the note with the status
line and the draft-only note between their markers, the `---` rule, the summary block with the
final review's placeholder, a second rule, the progress list, and the `Closes` block; on a PRD PR
it reuses, it splices the progress list and status line in, and appends the `Closes` block where
the body has no `Closes` marker. `review:publish` writes
the summary block, its marks and a regular pull request's status line from `review`'s hand-over,
`review:advance` a PRD PR's progress list and status line from `review`'s park hand-over,
`implement-prd:gate` the building row and status line of the slice a build run starts, as
`showBuilding` in `shared/progress-list.ts` builds them, `implement-prd:conclude` the stopped
slice's progress list and status line, rendered from the PRD branch as the run left it, and the
other blocks are written from a runner's output files. A runner reads them back from the
body.

| String | What it holds | Read by |
|---|---|---|
| `<!-- agent:summary -->` … `<!-- /agent:summary -->` | The review's summary of the pull request. | `review` |
| `<!-- agent:summary-head <sha> -->` | Inside the summary: the commit it was written at, which decides whether it is due again. | `review` |
| `<!-- agent:summary-final -->` | Inside the summary: the final review wrote it. | `review` |
| `Closes #<n>`, `Fixes #<n>`, `Resolves #<n>` | The issue the pull request delivers, the first one named, whose criteria a review checks and whose brief's post-merge checks the merge lists. | `review`; `follow-ups:file` |
| `<!-- agent:progress -->` … `<!-- /agent:progress -->`, `<!-- agent:status -->` … `<!-- /agent:status -->` | A PRD PR's progress list and its status line, rendered by `shared/progress-list.ts`. Written by `implement-prd:publish` with the slice in review, into the frame of a PRD PR it opens and over the blocks of one it reuses; by `implement-prd:conclude` where a build run stops, rendered from the PRD branch's trailers as the run left it (#325); then by `review:advance` at each round's end. | nothing: a view of the chain, re-rendered by the next writer |
| `<!-- agent:closes -->` … `<!-- /agent:closes -->` | A PRD PR's `Closes` line: the parent and every sub-issue still open. Written by `implement-prd:publish`, as `closesBlock` in `shared/record.ts` spells it, in the frame, and appended to a reused PRD PR an older release opened, whose body has no `Closes` marker. | `review`, through `Closes #<n>`; `implement-prd:publish`, for whether a reused body has the block |
| `<!-- agent:draft-note -->` … `<!-- /agent:draft-note -->` | A PRD PR's note that it stays a draft until every slice is done. Written by `implement-prd:publish` in the frame. | `review`, whose final review's write of the summary removes it |
| `\| <k> · #<sub> \| 🔨 Building \| – \| – \| – \|`, `**🔨 Building slice <k> of <n>** · #<sub>` | In a PRD PR's `<!-- agent:progress -->` and `<!-- agent:status -->` blocks: the row and the status line of slice `<k>`, sub-issue `<sub>`, while a build run builds it, as the renderer renders them. Written by `implement-prd:gate`. | nothing: a view of the chain, re-rendered by the next writer |
| `<!-- agent:final-review requested -->` | A PRD PR's body: the finishing run asked for the final review. Written by `implement-prd:publish` on the finishing run, with the final review's row, in front of the progress list's end marker, or at the body's end where it has no list; taken back out where `agent:review` does not go on. | `review`, as the final review; `implement-prd:gate`, as `FINAL_REVIEW_MARK` in `shared/record.ts` spells it, to call a PRD of more than one slice finished |

**Commit status contexts.** Read off each of the pull request's commits, newest first, counting
only a status whose creator is the loop's identity (§4.1). `agent-merge` is the exception: it is
counted only where its creator is the loop token's account, a narrower set (§4.1).

| Context | What it records | Written by | Read by |
|---|---|---|---|
| `agent-review` | The review's verdict on the commit. A state of `error` is no verdict. | `review:publish`, from `review`'s `verdict.json`; `error` by `review:conclude`; copied unparsed from the old head on to a clean merge by `update-branch:publish` | `review`, to know what changed since the last verdict |
| `agent-fix-round` | Beside a verdict, with the same target URL: that verdict started a fix round. | `review:publish`, from `review`'s `verdict.json` | `review`, to count fix rounds since the last verdict; `review:budget`, to count the rounds the budget has spent, on a PRD PR by the round its linked review's header names |
| `agent-merge` | The arm (ADR 0009): the maintainer's merge decision for the commit, `success`, its description `Armed by @<login> at <time> to merge this commit. Refreshes: <n>.` naming who armed it, when, to the second in UTC (`YYYY-MM-DDTHH:MM:SSZ`), and how many clean refreshes it has survived, as `armDescription` and `readArmDescription` in `shared/record.ts` spell and read it (#589). One #588 wrote, `Armed by @<login> to merge this commit.`, reads as 0 refreshes, made at its status's own creation time. Posted with the loop's token. Read only where its creator is the loop token's account, `LOOP_LOGIN`, and never `github-actions[bot]`, whatever the list in §4.1 holds: any workflow in a pull request's own branch posts as that, and could arm its own push, or forge its count. A head with none, a push since the arm included, is disarmed. Never CI: `review:collect-checks` and `merge:gate` leave it out of their checks. | `merge:gate`, on a label added by someone who can write, at the head it was added at, with 0 refreshes; `update-branch:publish`, on a clean merge only, copied with the loop's token from the old head on to the merge commit, its state and target URL as they were, the human and the time kept and the count one higher | `merge:gate`, for whether the head is armed, by whom, and how many refreshes it has survived; `update-branch:publish`, for the arm it carries |

**Commit trailers.** Read from the PRD branch's first-parent log.

| Trailer | What it records | Written by | Read by |
|---|---|---|---|
| `Agent-Slice: #<sub>` | The commit is part of slice `<sub>`'s build. Which slice is next, and which commits a slice round reviews, are read from these and nothing else. The key is read in any case, on a line of its own. | `implement-prd:publish`, in the publish job, out of the agent's reach: on every commit of the slice, those the bundle's tip has and neither the tip the catch-up left nor the default branch has, any the agent wrote stripped, before the push | `implement-prd`, `review`, `fix`; `implement-prd:gate`, over the commits the PRD branch has and the base lacks, as `SLICE_TRAILER_LINE` in `shared/record.ts` matches it, for which slice is next |
| `Agent-Catch-Up: #<sub>` | The commit is the orchestrator's merge of the default branch, made before slice `<sub>`. | `implement-prd:catch-up`, as `catchUpMessage` in `shared/record.ts` spells the merge's message | the same three, to keep that merge out of any slice |

**Branch names and refs.**

| Name | What it means | Written by | Read by |
|---|---|---|---|
| `agent/issue-<n>-<slug>` | The branch, and so the pull request's head, an `implement` run builds issue `<n>` on. `<slug>` is the issue's title, lowercased in ASCII alone, every run of anything but `[a-z0-9]` one `-`, the ends trimmed, then cut to 50, which can leave a trailing `-`. A retry lands on the branch an earlier run named. | named by `implement:gate`, as `ISSUE_BRANCH_PREFIX` and `issueBranch` in `shared/record.ts` spell it; pushed by `implement:publish`, from `implement:bundle`'s `branch.bundle`, leased on the tip the gate read | `implement:gate`, for its tip |
| `agent/prd-<parent>-<slug>` | A PRD branch, and so a PRD PR, of parent issue `<parent>`. A pull request whose head does not match is an ordinary one. Found by its stable half, `agent/prd-<parent>-`, so a retitled parent keeps its chain; `<slug>` is made as an issue branch's is, and names only a branch that does not exist yet. | named by `implement-prd:gate`, as `prdBranchStem` and `prdBranch` in `shared/record.ts` spell it; pushed by `implement-prd:catch-up`, its merge of the default branch, and `implement-prd:publish`, a slice | `review`, `fix`; `implement-prd:gate`, for its tip and the slices on it |
| `agent/rescue/fix-<n>` | An earlier stopped fix run's commits on pull request `<n>`, its `RESCUE_BRANCH` (§9). Deleted, under a lease, by a run that succeeds. | `fix:conclude`, from `fix:bundle`'s `branch.bundle`; deleted by `fix:publish` | `fix:prepare`, which fetches it for the runner as `refs/rescue/…` |
| `agent/rescue/issue-<n>` | An earlier stopped implement run's commits on issue `<n>`, its `RESCUE_BRANCH` (§6). Keyed to the number alone, so a retitled issue still finds it. Deleted, under a lease, by a run that pushes. | `implement:conclude`, from `implement:bundle`'s `branch.bundle`, leased on its tip as read, as `issueRescueBranch` in `shared/record.ts` spells it; deleted by `implement:publish` | `implement:prepare`, which fetches it for the runner as `refs/rescue/…` |
| `agent/rescue/prd-<parent>` | An earlier stopped implement-prd run's commits on PRD parent `<parent>`, its `RESCUE_BRANCH` (§7). Deleted, under a lease, by a run that pushes its slice. | `implement-prd:conclude`, from `implement-prd:bundle`'s `branch.bundle`, leased on its tip as read; deleted by `implement-prd:publish` | `implement-prd:prepare`, which fetches it for the runner as `refs/rescue/…` |
| `refs/rescue/<RESCUE_BRANCH>` | An earlier stopped run's commits, fetched for the runner to resume from (§6, §7, §9). | `fix:prepare` for `fix`, `implement-prd:prepare` for `implement-prd`, and `implement:prepare` for `implement`, from the rescue branch | `implement`, `implement-prd`, `fix` |

**Label events.**

| Event | What it records | Read by |
|---|---|---|
| `agent:fix` added to the pull request | One fix round, automatic or by hand, each time it was added. | `review`, `fix`, `implement-prd`, to count rounds |
| `agent:follow-ups` on the pull request | Findings wait to be filed. It gates the filing alone, not the post-merge checklist (§11). Read live, and taken off once filed, by `follow-ups:file` through `removeLabel`, last, and left on by any run that fails: `follow-ups:conclude`, which says so, never takes it off. | `follow-ups:file` |
| `agent:merge` on the pull request | The maintainer's merge decision, standing until the merge or a disarm: armed until merged or disarmed. Its addition by someone who can write arms the head it was added at; an addition by the loop token's account arms nothing. Re-added by the loop's token, removed first, to re-start the gate: by `update-branch:conclude` on a run that finished, and by `review:conclude` on an approval (#589). Taken off by `merge:gate` on a refusal or a disarm, by `merge:publish` after the merge, and by `merge:conclude` on a run that stopped, never by a run that merely ended. | `merge:gate`, through the event, and through `SENDER` for who added it |
| `pr-follow-up` on an issue | An issue `follow-ups:file` filed earlier, labelled as `createIssue` creates it, where the repository has the label, and read with its body's key. | `follow-ups:file` |

**`doctor` cannot check this.** These strings are written by the orchestrator's posting code, and
read back at run time; nothing in a repository holds them before a run.

## 5. Versions

The contract holds within one release. An orchestrator ***must*** pin one exact runner version,
and read this spec at that version's tag.

A release fixes its dependency tree too: the package bundles its runtime dependencies
(`bundleDependencies`), at the versions its lockfile resolves, and npm installs them from the
tarball whatever the registry's metadata says. So the version pinned selects every package that
runs with it. Not a shrinkwrap: npm reads one inside a dependency only when the registry sets
`_hasShrinkwrap`, and GitHub Packages, where the package is published, does not.

There is no promise across releases, and no changelog of contract changes beside this file's own
history: `git diff v<a>..v<b> -- docs/platform-spec.md` is what changed between two releases. Read
it on every bump.

A runner gaining an input is red in this repository's build until three things land together: its
declaration in `shared/contract.ts`, its row in the runner's `### Inputs` table here, and, where it
is required, the reusable's `env:` setting it. Where the reusable needs a new caller input or
secret to set it, the two-step caller rule in `CLAUDE.md` applies: the reusable is released first,
and this repository's own caller follows.

`doctor` checks that every caller is pinned to a tag or a SHA, and reports how many releases each
pin is behind. For any other orchestrator, **`doctor` cannot check this.** Its pin is in its own
code, not in the repository.

> **Actions orchestrator:** the caller's `uses:` ref names a release, and that release's reusable
> names the same version in its `npm exec`, or, in fix's agent job, in the `npm install` whose
> binary its runner runs, so one pin selects the YAML and the runner together.

> **Service orchestrator:** one install is one release for the service and every subcommand it
> runs. The worker starts each runner and command as a child process of its own installed package,
> never another, and refuses a job from a dispatcher of another release, which each job names, so
> the job's format between the two only has to hold within one.

## 6. `implement`

Trigger label: `agent:implement`, on an issue with no sub-issues. `doctor` checks that the label
exists.

Builds one issue as commits on a new branch from the default branch, and fails where the agent
made none. It fails with the agent's reason, whether or not it made commits, where the agent
reports that the issue no longer matches the code. Preconditions: the default
branch checked out, at `BASE_REF`, and a new branch named `BRANCH` created from it and checked out:
from the commit the orchestrator read the default branch at, where it read one (`implement:prepare`);
and, where an earlier run of this issue left commits on `RESCUE_BRANCH`, that branch fetched to
`refs/rescue/<RESCUE_BRANCH>` for the runner to resume from.

**A resume** (#270): where the rescue builds on the commit `BRANCH` was created at, the runner
fast-forwards onto it before the agent starts, and the prompt opens by saying the commits are
unverified and to run the verify command first. Where it does not, the base having moved since it
was saved, it is set aside, and `rescue_ignored.json` says so. Its commits count toward the ones the
runner requires.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. Empty is the baked default. |
| `AGENT_MODEL_IMPLEMENT` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_SANDBOX` | optional | `none` | Accepts `none` or `bwrap`: the agent's sandbox (§2.2, §3). Any other value fails the run, naming it. |
| `AGENT_SANDBOX_RO_BINDS` | optional | `""` | Read-only binds for `bwrap` (§2.2). |
| `AGENT_SANDBOX_PATH` | optional | `/usr/local/bin:/usr/bin:/bin` | `PATH` inside `bwrap` (§2.2). |
| `AGENT_SANDBOX_PROXY` | optional | `""` | The proxy for `bwrap`, required with it (§2.2). |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `ISSUE_NUMBER` | required | | The issue to build. |
| `ISSUE_TITLE` | required | | Its title. |
| `BRANCH` | required | | The branch checked out for the work. |
| `BASE_REF` | required | | The branch it was cut from, which the runner counts its commits against. |
| `RESCUE_BRANCH` | required | | Where an earlier run of this issue that stopped left its commits. |

### Outputs

| Output | When it is written |
|---|---|
| `rescue_ignored.json` | Where a rescue branch was found and set aside because the base moved since it was saved: `branch`, the rescue branch, and `movedPast`, its tip. `implement:conclude` says so. |

The result is the commits on `BRANCH`.

**`doctor` cannot check this.** These tables are the runner's, held to its declaration by the
build, and an orchestrator other than Actions sets its environment in its own code.

### What it reads from the record

- The issue's body and comments, through `isTrustedAuthor` (§4.1): a body or comment by an author
  it does not trust is left out of what the agent is shown.
- `refs/rescue/<RESCUE_BRANCH>`, where it exists, to resume from.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** a gate job runs `implement:gate` first, before anything is checked
> out, which defers to `implement-prd`, refuses the run on the issue, or claims it and names
> `BRANCH`, the commit `BASE_REF` is at and the branch's tip; a glue step copies its decision and
> those facts into the job's outputs, which every later job reads, and the job's last step starts
> the agent's clock. The agent's job checks out the default branch, installs the package once,
> before the adopter's `setup`, with the one step there handed the registry token, and runs
> `implement:prepare`, which creates `BRANCH` at the gate's base commit and fetches the rescue
> branch, then the runner, by the install's path, and, however it ended, `implement:bundle`; it
> hands the bundle, every reason file and the rescue it set aside to the publish job as one
> artifact, and its last step measures whether it ran out of time, as its `timed-out` output, beside
> the bundle step's outcome, as its `bundled` output. `RESCUE_BRANCH` is `agent/rescue/issue-<n>`, set on the agent's job and the publish job. A publish
> job mints the loop's token, checks the default branch out and runs, where the agent's job
> succeeded, `implement:publish`, which checks the bundle, pushes `BRANCH`, opens a draft pull
> request into the default branch, deletes the rescue branch, links it on the issue, and adds
> `agent:review` to it; then, `always()`, `implement:conclude`, which ends every run: the set-aside
> note, a stopped run's commits rescued to the rescue branch where nothing was pushed, the failure
> comment and `agent:blocked` where the run stopped, and `agent:implement` off wherever the gate
> decided the run was its own.

> **Service orchestrator:** the worker runs the gate job's, the agent's job's and the publish job's
> subcommands, in the order above and under each job's and step's `if:` in `implement.yml`, not
> under the order alone, each a child process with a fresh `OUTPUT_DIR` of its own and an
> environment built from its declaration, and writes nothing to the record itself. The dispatcher
> answers `agent:implement` on an `issues` delivery alone, on an issue that is not a pull
> request's, from a person who can write or from its own App (ADR 0008); `agent:implement` on a pull
> request's delivery starts nothing. It does not check the issue's state: a closed issue reaches
> `implement:gate`, whose refusal says so on the issue and takes the label off, as on Actions. The worker asks the dispatcher for a `write` token and runs
> `implement:gate` with the issue's number, title and state as the label's event carried them: the
> gate writes, its refusals, its permission probe and the start comment, as the gate job's token does
> with `issues: write`.
>
> - **A refusal or a deferral ends the run at the gate.** Where `gate.json` says `proceed` `false`,
>   the gate job's `refused` is `true`, and on Actions neither the agent's job (`refused ==
>   'false'`) nor the publish job (`refused != 'true'`) runs. So no token is asked for after the
>   gate, neither the agent's phases, `implement:publish` nor `implement:conclude` run, and the
>   run's summary notes it. An issue with sub-issues is deferred to `implement-prd` that way, and
>   the implement-prd job the dispatcher sends beside this one on the same label builds it (§7).
> - **An undecided gate**, one that failed or ran out of time before `gate.json` said `proceed`, is
>   not a refusal: `refused` is empty, the agent's job does not run, and the publish job does. Its
>   token is asked for and `implement:conclude` runs, told `REFUSED` empty; the checkout and the
>   fetch, which need `refused == 'false'`, are skipped. So is the agent's job where the gate
>   claimed the run and then failed, as at the probe, since the job needs the gate's success.
> - **The agent's job**, where the gate succeeded and claimed the run: a `read` token; a checkout
>   of the base branch, by name, with the repository's tags, as `implement.yml`'s, with no token stored in it;
>   `implement:prepare`, with the same `read` token, which creates `BRANCH` there at `base`, the
>   commit the gate read the base branch at, and fetches the rescue branch; the repository's setup,
>   `AGENT_SETUP`, in the bwrap sandbox with no token, where Actions runs the caller's `setup:`; a
>   fresh `read` token, then the runner in the sandbox its settings name, with it as `GH_TOKEN`;
>   and `implement:bundle`, handed no token, however those ended, as the bundle step's
>   `always()`, under a time limit of its own, since the agent's may have fired.
> - **The publish job**, wherever the gate did not refuse: a `push` token, since the job holds
>   `contents: write`, or a `write` token where that is refused, and, where the gate claimed the
>   run, a checkout of the base branch, by name, of its own, made with it, which the bundle is
>   checked in. `implement:publish` runs only where the agent's job succeeded and the steps before
>   it in the publish job did, the mint and the checkout among them: pointed at
>   `implement:bundle`'s directory, it pushes `BRANCH`, opens the draft pull request as the App,
>   deletes the rescue branch, links it on the issue and adds `agent:review` with the App's token.
>   Then `implement:conclude`, however the run ended, in the same checkout, pointed at publish's,
>   prepare's, the runner's and bundle's directories. Publish holds `push` as both `GH_TOKEN` and
>   `LOOP_TOKEN`, with `LOOP_TOKEN_SOURCE` `app`; conclude holds it as both too, or the `write`
>   token as `GH_TOKEN` and no `LOOP_TOKEN` where `push` was refused, so it rescues nothing then.
>   The runner never holds a token that writes.
>
> Where `implement.yml` passes something the service does not have, it passes the nearest
> equivalent:
>
> - **`BASE_REF` is the repository's default branch**, as the `issues` delivery carries it, which
>   stands in for the caller's `default-branch` input.
> - **The gate job's outputs are its files.** `REFUSED` is read from `gate.json` as for `fix`;
>   `BRANCH`, `BASE_SHA` and `BRANCH_TIP` are its `branch`, `base` and `tip`; `GATE_REASON` is
>   `implement:gate`'s `failure_reason.txt`.
> - **`RESCUE_BRANCH` is `agent/rescue/issue-<n>`**, as `issueRescueBranch` in `shared/record.ts`
>   spells it, the name `implement.yml` gives it.
> - **`RUN_URL` is the App's own page**, `https://github.com/apps/<slug>`: the service has no run
>   page, and the commands require a link, which the start comment, the pull request's frame, the
>   link on the issue and the failure comment give where Actions links its workflow run.
> - **The time limits are the jobs'.** `implement:gate` gets the gate job's 10 minutes. The agent's
>   job's steps share `AGENT_TIMEOUT_MINUTES` (30 where unset or not a positive integer), and one
>   still running at it is ended with every process it started: the agent's job is then
>   `cancelled`, with `TIMED_OUT` `true` and `TIMEOUT_MINUTES` the limit, which on Actions the job's
>   last step measures. `implement:bundle` gets 5 minutes of its own after it, as `fix:bundle`
>   does; one still running at it is `BUNDLE_OUTCOME` `cancelled`, as the step's outcome is on
>   Actions, so conclude says the commits went unsaved. Publish's checkout and `implement:publish` share the publish job's 15 minutes, and
>   `implement:conclude` gets 15 of its own. The dispatcher's deadline for the job is
>   the agent's limit plus its margin.
> - **A phase not started leaves its reason** where `implement:conclude` reads the next one: a
>   `read` token not granted, or a checkout that failed, as `implement:prepare`'s
>   `failure_reason.txt`; a setup that failed, or a runner's token not granted, as the runner's; a
>   publish checkout that failed as `implement:publish`'s.
> - **A checkout that fails before publish is publish's failure, on purpose.** Where publish's
>   checkout fails, `implement:publish` does not run, and conclude is told `PUBLISH_OUTCOME` `failure`
>   with the checkout's reason as publish's, or `cancelled` where the checkout ran out of the
>   publish job's time. On Actions the failed checkout fails its step, and the publish step's
>   status check then reports `skipped`, which tells conclude, and so the person reading its
>   comment, nothing of why. The service names the cause instead, as every run function with a
>   checkout before publish does.
> - **The download is a success** wherever the agent's job ran: the hand-over is on the worker's
>   disk.
> - **The mint is the `push` token's.** One not granted is `MINT_OUTCOME` `failure`, and nothing is
>   published; `implement:conclude` is then handed a `write` token, enough for its comment and
>   labels. Where none is granted to conclude, nothing can write to the issue, and the worker's log
>   says why the run ended.
> - **The hand back to review needs nothing new.** The `pull_request` delivery for the
>   `agent:review` `implement:publish` adds names the App's login as its sender, which the
>   dispatcher trusts, so it answers it as a review job.
>
> Not run: `node-version-file`, since the sandbox runs the worker box's own Node, and the session
> transcript's upload.

### `implement:gate`

Refuses, defers or claims the issue, before anything is checked out and before the agent's job. It
runs no model and needs no checkout. In order:

- **The partition.** The issue's parent, sub-issue count and labels are read in one query. An
  issue with sub-issues is `implement-prd`'s (§7), which answers the same label event, so it is
  deferred: nothing is written to the record, whatever else is true of it, a closed issue
  included. A query that fails, or answers with no issue, fails the command: "no answer" is never
  read as "no sub-issues".
- **The refusals**, in this order, each with its own sentence: an `ISSUE_STATE` that is not `open`;
  a `wayfinder:*` label, blocked; a parent, blocked; open issues it is blocked by, blocked, one
  sentence for one and another for several; an open pull request whose body closes the issue
  (`Closes`, `Fixes` or `Resolves`, any case, then `#<n>`), not blocked. A failed read of the
  blockers is none; a failed read of the pull requests fails the command.
- **A refusal** is said in the loop's one order: the comment,
  `` **`agent:implement` didn't run:** `` and the sentence; then `agent:implement` off; then
  `agent:blocked` where it is blocked. Each of the three is tolerated, so a comment that fails
  still takes the label off.
- **The permission probe.** On a run it claims, it adds `agent:implement`, which the issue already
  carries, so a token short of the write fails the command before the agent runs. Not tolerated.
- **`agent:blocked` off**, tolerated: re-adding `agent:implement` is the retry after a block.
- **The start comment**, `` **`agent:implement` started:** `` and a link to `RUN_URL`, tolerated.
- **The facts the run builds on**: the branch's name (§4.3), the commit `BASE_REF` is at, and the
  branch's current tip. A branch that does not exist is a tip of `""`; one that cannot be read
  fails the command, as does a base that cannot be read.

Every write is made with `GH_TOKEN`: none of them has to start a run. A refusal or a deferral is a
decision, and the command succeeds. `gate.json` is written the moment the run is decided, ahead of
the probe, and again as each fact is read and however the command ends, so a run that failed at
the probe still says it went ahead. One that died before deciding writes no `gate.json` where an
input could not be read, and `{}`, with no `proceed`, where it failed after that; the adapter
reads either as undecided, an empty `refused`.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `ISSUE_NUMBER` | required | | The issue. |
| `ISSUE_TITLE` | required | | Its title, which the branch's name is made from. |
| `ISSUE_STATE` | required | | The issue's state as the event saw it: `open` or `closed`. |
| `BASE_REF` | required | | The branch the work is cut from, whose commit it reads. |
| `RUN_URL` | required | | The run's page, which the start comment links. |

#### Outputs

| Output | When it is written |
|---|---|
| `gate.json` | Where it decided: `proceed`, `true` where the run goes ahead and `false` where it refused or deferred, then on a run it claims `branch`, `base` and `tip` as each is read, every value a string. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The issue's parent, sub-issue count and labels, for `wayfinder:*`.
- The issues it is blocked by, and whether each is open.
- The open pull requests' bodies, for one that closes the issue.
- The tip of `agent/issue-<n>-<slug>` (§4.3), or that there is none.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the gate job's first work, after a Node set up for it, since nothing is
> checked out yet; no adopter step runs in that job. `ISSUE_STATE` and `ISSUE_TITLE` are the
> label's event's, and `GH_TOKEN` is the job's own, with `issues: write`, held by this step alone.
> `OUTPUT_DIR` is `runner.temp`. A glue step copies `gate.json` into step outputs, `always()`, and
> the job's `refused` output is `false` where `proceed` is `true`, `true` where it is `false`, and
> empty where there is none: a gate that died before deciding, which `implement:conclude` reads
> as such. `branch`, `base` and `tip` become the job's outputs of the same names. The same step copies
> `implement:gate`'s `failure_reason.txt`, where it wrote one, into the job's `failure-reason`
> output, which `implement:conclude` posts as `GATE_REASON` where no reason file reached it. The job
> fails where the command does, so a failed probe never starts the agent's job.

### `implement:prepare`

Creates the agent's branch: `BRANCH`, in `CHECKOUT`, at `BASE_SHA`, the commit the gate read
`BASE_REF` at, checked out, with the loop's committer, `sandcastle-agent[bot]` and its noreply
address, as the checkout's identity, so the agent's commits are made by it. Not the default
branch's tip, which may have moved since the gate read it: the agent builds on exactly the base the
publish job checks its commits against. Then it fetches the rescue an earlier stopped run of this
issue left (#270). It runs no model, reads with `GH_TOKEN`, and writes nothing to the record.

- **A checkout without the base commit.** Where `CHECKOUT` does not hold `BASE_SHA`, the default
  branch rewritten since the gate read it, it fails with `` The checkout of `<BASE_REF>` doesn't
  hold <BASE_SHA>, the commit this run found it at, so no branch was made for the agent. ``, and
  creates no branch.
- **A failure of git.** Fails the command, naming the branch and the commit.
- **The rescue**, as `fix:prepare` fetches it: `RESCUE_BRANCH`'s tip is read from the repository's
  branches, and where it exists the branch is fetched into `CHECKOUT` as
  `refs/rescue/<RESCUE_BRANCH>`, outside `refs/remotes/`, so its commits count as this run's. A 404
  is no rescue, and fetches nothing. **An unreadable answer stops the run**, rather than reading as
  no rescue, since a run that started over without the rescue, and succeeded, would delete it: it
  fails with `` Couldn't check whether an earlier run left commits on `<RESCUE_BRANCH>`, so this run
  stopped rather than start over without them. ``, and a rescue that is there but cannot be fetched
  fails it too, naming the branch.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout of the default branch the agent will work in. |
| `BRANCH` | required | | The branch to create: `implement:gate`'s `branch`. |
| `BASE_REF` | required | | The branch the work is cut from, named in the refusal. |
| `BASE_SHA` | required | | The commit `implement:gate` read `BASE_REF` at, which the branch is created at. |
| `RESCUE_BRANCH` | required | | Where an earlier run of this issue that stopped left its commits, fetched where it exists. |

#### Outputs

| Output | When it is written |
|---|---|
| | Nothing beyond §2.4. The result is the branch it checked out, and the rescue it fetched. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `RESCUE_BRANCH`'s tip; a 404 is no rescue.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the agent's job, after the checkout of the default branch and before
> the adopter's toolchain and `setup`, from the package installed early in that job, run from
> `RUNNER_TEMP`. It is handed the job's `GH_TOKEN`, read-only there, which meets no git config
> entry or hook of the adopter's this early. `CHECKOUT` is the workspace, `RESCUE_BRANCH` the job's,
> and `BRANCH` and `BASE_SHA` the gate job's `branch` and `base` outputs. `OUTPUT_DIR`
> is a directory of its own under `runner.temp`, which the job's upload carries, for the failure
> comment.

### `implement:bundle`

Bundles the agent's commits for whatever pushes or rescues them: the commits on
`refs/heads/<BRANCH>` in the checkout ahead of `BASE_SHA`, the gate's base commit, as a thin bundle
holding exactly that one ref, with `BASE_SHA` its prerequisite. Bundled as `fix:bundle` bundles,
commits the run resumed from a rescue among them. It runs no model, reads no repository, holds no
token, and writes nothing to the record.

- **Nothing to bundle.** It runs however the agent ended (#270), so no commits ahead of `BASE_SHA`,
  or no `refs/heads/<BRANCH>` at all, writes nothing and succeeds, which whatever reads the bundle
  reads as nothing to push or rescue.
- **A failure of git.** Fails the command, naming the branch and `BASE_SHA`.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout the agent worked in, with its branch as `BRANCH`. |
| `BRANCH` | required | | The agent's branch: `implement:gate`'s `branch`. |
| `BASE_SHA` | required | | The commit the branch was created at: `implement:gate`'s `base`. |

#### Outputs

| Output | When it is written |
|---|---|
| `branch.bundle` | Where there are commits ahead of `BASE_SHA`: the bundle. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

Nothing. Its inputs are the checkout and the gate's facts.

> **Actions orchestrator:** the agent's job, `always()`, after the runner and the
> transcript, from the package installed early in that job, run from `RUNNER_TEMP`, where `npm
> exec` finds that install without asking the registry. It is handed no token: the job's
> `GH_TOKEN` is set empty for it. `CHECKOUT` is the workspace, and `BRANCH` and `BASE_SHA` the gate
> job's `branch` and `base` outputs. `OUTPUT_DIR` is a directory of its own under `runner.temp`,
> which the job's upload carries beside the runner's files; the publish job checks the bundle
> before it pushes or rescues anything from it.

### `implement:publish`

Checks the agent's bundle, pushes it, opens the draft pull request and hands it to the review. It
runs no model. It writes the pull request's title and frame itself: the title `Fix #<n>: <title>`,
cut at 256 characters, and the frame §4.3 describes, linking `RUN_URL`. Before its first write it
checks `branch.bundle`:

- that it is there, or `The agent's job finished without handing over its commits, so nothing was
  pushed.`;
- that it verifies in `CHECKOUT`, or `The agent's commits arrived damaged or incomplete, so nothing
  was pushed.`;
- that it holds exactly `refs/heads/<BRANCH>`, or `` The agent's commits arrived on a branch other
  than `<BRANCH>`, or beside other branches, so nothing was pushed. ``;
- and that its tip builds on `BASE_SHA`, or `` The agent's commits don't build on `<BASE_REF>` as
  this run found it, so nothing was pushed. ``

A check that fails fails the command, and nothing is written.

The order: the push of the bundle's tip to `refs/heads/<BRANCH>` with the loop's token, leased on
`BRANCH_TIP`, or on the branch not existing where it is empty, so a retry replaces a branch an
earlier run left and a branch someone pushed to during the run is refused; the draft pull request
from `BRANCH` into `BASE_REF`, with the loop's token; `RESCUE_BRANCH` deleted, with the loop's
token, leased on its tip as read, where it exists (#270): what the run resumed from is in what it
pushed, and the pull request now holds it, whereas an open that failed sends the retry back to the
base, whose push replaces `BRANCH`, leaving the rescue the one copy; a deletion that fails, or a tip
that cannot be read, is a warning; `` **`agent:implement` opened PR #<pr>:** ``
and a link to `RUN_URL` on the issue, with `GH_TOKEN`, tolerated; a bounded wait for the pull
request to show the pushed head; `agent:implement` off the issue, tolerated; and `agent:review` off
the pull request, tolerated, and on, with the loop's token, warning where `LOOP_TOKEN_SOURCE` is
neither `app` nor `pat`, since the label then starts nothing. A failed push, open or `agent:review`
add fails the command, naming it.

- **A server error opening the pull request is read back.** GitHub has answered an open with an
  error and opened it all the same (#329). On a 5xx, or GraphQL's internal error, the open pull
  requests from exactly `BRANCH` into exactly `BASE_REF` are read: one found is this run's, and the
  command goes on with it, with a warning. A pull request from another head, or into another base,
  is never taken for it, nor one whose body only closes the same issue. None found fails the
  command; a read-back that fails too fails it with a sentence saying to look for a pull request
  from `BRANCH` before adding `agent:implement` again.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | required | | The token whose writes start the loop's next workflow: the push, the pull request and the labels. |
| `LOOP_TOKEN_SOURCE` | required | | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `ISSUE_NUMBER` | required | | The issue. |
| `ISSUE_TITLE` | required | | Its title, which the pull request's is made from. |
| `BASE_REF` | required | | The branch the pull request is opened into, named in the bundle's refusal. |
| `BRANCH` | required | | The agent's branch: `implement:gate`'s `branch`, which the bundle has to hold and the push moves. |
| `BASE_SHA` | required | | The commit `implement:gate` read `BASE_REF` at, which the bundle has to build on. |
| `BRANCH_TIP` | optional | `""` | `implement:gate`'s `tip`, which the push is leased on. Empty is a branch that did not exist, and the push is leased on its still not existing. |
| `RESCUE_BRANCH` | required | | The rescue branch, deleted once the push lands. |
| `RUN_URL` | required | | The run's page, which the frame and the link on the issue name. |
| `CHECKOUT` | required | | A checkout of the repository holding `BASE_SHA`, the bundle is checked in and pushed from. |
| `HEAD_WAIT_SECONDS` | optional | `60` | How long to wait for the pull request to show the pushed head before the review is asked for anyway. |
| `HEAD_POLL_SECONDS` | optional | `5` | How often to look while waiting. |
| `BUNDLE_DIR` | directory | | `implement:bundle`'s `OUTPUT_DIR`. Reads `branch.bundle` (where written). |

#### Outputs

| Output | When it is written |
|---|---|
| `published.json` | From its first write: `pushed`, whether it pushed, `head`, the pushed commit, where it did, `pr`, the pull request's number, where one opened, and `requested`, whether `agent:review` went on, each written as it becomes true. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:publish`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `RESCUE_BRANCH`'s tip, for the deletion's lease; a 404 is none.
- The open pull requests from `BRANCH` into `BASE_REF`, on a server error opening one.
- The pull request it opened, for whether it shows the pushed head yet.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the publish job mints the loop's token at its start, then checks the
> default branch out, with no credential left in it, `always()` where the gate claimed the run,
> and sets up Node. `implement:publish` runs from `RUNNER_TEMP`, working in the checkout, where the
> agent's job succeeded and every step before it did. It is handed the workflow token as
> `GH_TOKEN` and the loop's. `BRANCH`, `BASE_SHA` and `BRANCH_TIP` are the gate job's `branch`,
> `base` and `tip` outputs, never a file the agent's job wrote; `BUNDLE_DIR` is where the agent's
> artifact puts `implement:bundle`'s directory, and `OUTPUT_DIR` a directory of its own under
> `runner.temp`, whose files `implement:conclude` reads and whose write log the job keeps.

### `implement:conclude`

Ends every implement run, success included, in the loop's one order: every result posted, then
`agent:implement` off, then `agent:blocked` where the run stopped. It runs no model, and works in a
checkout only to check a stopped run's bundle before it rescues it. It is told how
the run went rather than reading it off which steps ran: the gate's decision, result and reason,
the agent's job's result, whether that job ran out of time, and the outcome of each step the
orchestrator ran before it, and it works out the ending from them. Each is one of:

- **A refusal or a deferral** (`REFUSED` is `true`): nothing, since the gate said it and took the
  label off, or says nothing by design.
- **A rescue the runner set aside** (#270), on any other ending: `` **`agent:implement` started
  fresh:** `` and that the earlier run's commits on `RESCUE_BRANCH` were not built on, since
  `` `<BASE_REF>` `` has moved since, first, with `GH_TOKEN`. A `rescue_ignored.json` naming another
  branch is a warning and is skipped.
- **A run that finished**: the gate, the agent's job and every step before this one.
  `agent:implement` off, even where `implement:publish` took it off before it asked for the
  review, since that removal is tolerated and may have failed. Every other word of it is publish's.
- **A run that stopped**, after a gate that decided the run was its own (`REFUSED` is `false`): its
  commits rescued, where `published.json` does not say it pushed; the failure comment,
  `` **`agent:implement` stopped:** `` and the reason as a sentence, the run's link, and the retry;
  then `agent:implement` off, then `agent:blocked`.

**The rescue** (#270): where `BUNDLE_DIR` holds `branch.bundle`, its tip is pushed to
`refs/heads/<RESCUE_BRANCH>` with `LOOP_TOKEN`, leased on the rescue's tip as read, or on there
being none, so a retry that stops again replaces the rescue it started from and holds everything it
held. Never `BRANCH`, no pull request, no review and no label. No bundle is no commits ahead of
`BASE_SHA`, and nothing is pushed. The bundle is checked in `CHECKOUT` as `implement:publish`
checks it, against `BRANCH` and `BASE_SHA`. An empty `LOOP_TOKEN` or a mint that did not succeed,
a bundle that fails a check, a rescue's tip that cannot be read, a push that fails, and, with no
bundle, a `failure_reason.txt` in `BUNDLE_DIR`, a `DOWNLOAD_OUTCOME` of `failure`, or a
`BUNDLE_OUTCOME` of `failure` or `cancelled` (a bundle step ended before it wrote anything), each
rescue nothing, with a warning, and the comment says the commits were not saved, and why.
- **A gate that did not decide** (`REFUSED` is empty): the same comment and `agent:blocked`, and
  `agent:implement` is **left on**: that run may have been the event `implement-prd` answers, which
  holds the label while it works.

The reason is, where the gate, the agent's job or a step was cancelled, a cancel, or the time limit
where `TIMED_OUT` is `true`. Otherwise the first `failure_reason.txt` written, of the runner's,
`implement:prepare`'s, `implement:bundle`'s and `implement:publish`'s; then a fixed sentence where
the mint failed; then `GATE_REASON`; then, where the agent's job failed, the time limit where
`TIMED_OUT` is `true`; then a fixed sentence where the agent finished and the download failed; and
failing all of those, that it gave no reason. The retry is `` It opened PR #<pr> before it stopped,
so adding `agent:implement` again would be refused. Fix the problem above, then add `agent:review`
to PR #<pr>. `` where `published.json` names a pull request; after a gate that did not decide,
`` To try again, remove `agent:implement` if it is still on this issue, then add it. ``, since
adding a label already there fires nothing; and `` To try again, add `agent:implement`. ``
otherwise. Where it rescued the commits, the plain retry is `` Its commits so far are saved on
`<RESCUE_BRANCH>`. To resume from them, add `agent:implement`. ``, and any other is followed by
`` Its commits so far are saved on `<RESCUE_BRANCH>`, and adding `agent:implement` resumes from
them. ``; where they went unsaved, the retry is followed by `` Its commits were not saved on
`<RESCUE_BRANCH>`: `` and why: `` the loop's token was not minted, so there was nothing to push
them with. ``, `` they could not be checked against `<BASE_REF>` before the push, and the workflow
run's log says why. ``, `` GitHub would not say whether the branch already holds commits, so
pushing could have overwritten them. ``, `` GitHub refused the push, and the workflow run's log
says why. ``, `` the agent's job could not bundle them, and the workflow run's log says why. ``,
`` the agent's job was stopped before it finished bundling them, and the workflow run's log says
why. `` or
`` what the agent's job handed over could not be fetched, so there were none to push. ``

Each directory is read on its own, so a file that does not read is a warning and is read as not
written, and costs the comment no reason another producer gave; the runner's two files are read
each on its own. Every write is tolerated: one GitHub refuses is a warning, so a run that cannot
comment still takes its label off. Every write but the rescue is made with `GH_TOKEN`.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | optional | `""` | The loop's token, which the rescue is pushed with. Empty where it was not minted, and nothing is rescued. |
| `LOOP_TOKEN_SOURCE` | optional | `""` | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `ISSUE_NUMBER` | required | | The issue. |
| `BASE_REF` | required | | The default branch, named in the set-aside note and the bundle's check. |
| `RUN_URL` | required | | The run's page, which the failure comment links. |
| `RESCUE_BRANCH` | required | | Where a stopped run's commits are pushed, and the rescue the runner set aside has to name. |
| `CHECKOUT` | required | | A checkout of the repository holding `BASE_SHA`, which the bundle is checked in and rescued from. |
| `BRANCH` | optional | `""` | `implement:gate`'s `branch`, which the bundle has to hold. Empty where the gate did not decide. |
| `BASE_SHA` | optional | `""` | `implement:gate`'s `base`, which the bundle has to build on. |
| `REFUSED` | optional | `""` | Accepts `true` or `false`: `false` where the gate claimed the run, `true` where it refused or deferred. Empty is a gate that died before it decided. |
| `GATE_RESULT` | required | | How the gate's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `GATE_REASON` | optional | `""` | The sentence `implement:gate` failed with, where it wrote one. |
| `AGENT_RESULT` | required | | How the agent's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `TIMED_OUT` | optional | `""` | `true` where the agent's job ran its whole limit. |
| `TIMEOUT_MINUTES` | optional | `""` | That limit, for the comment. |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting the loop's token: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `DOWNLOAD_OUTCOME` | optional | `""` | The same, for fetching the agent's hand-over. |
| `PUBLISH_OUTCOME` | optional | `""` | The same, for `implement:publish`. |
| `BUNDLE_OUTCOME` | optional | `""` | The same, for `implement:bundle`, in the agent's job. With no bundle, `failure` or `cancelled` is commits not saved rather than none. |
| `PUBLISH_DIR` | directory | | `implement:publish`'s `OUTPUT_DIR`. Reads `published.json` (where written) and `failure_reason.txt` (where written). |
| `PREPARE_DIR` | directory | | `implement:prepare`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `IMPLEMENT_DIR` | directory | | The `implement` runner's `OUTPUT_DIR`. Reads `failure_reason.txt` (where written) and `rescue_ignored.json` (where written). |
| `BUNDLE_DIR` | directory | | `implement:bundle`'s `OUTPUT_DIR`. Reads `branch.bundle` (where written) and `failure_reason.txt` (where written). |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `RESCUE_BRANCH`'s tip, for the rescue's lease; a 404 is none.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the publish job's step after `implement:publish`, run `always()`, from
> `RUNNER_TEMP`, as are the Node setup and the upload around it, and the checkout and the download
> wherever the gate claimed the run. It is told the gate's `refused` output, result and
> `failure-reason` output, which the gate job's glue step copies from `implement:gate`'s reason
> file, the agent's job's result, its `timed-out` output and its `bundled` output, the bundle step's
> outcome, the limit as `AGENT_TIMEOUT_MINUTES` or 30, and the outcomes of the mint, the download and
> `implement:publish`. `PUBLISH_DIR` is
> `implement:publish`'s `OUTPUT_DIR`, and `PREPARE_DIR`, `IMPLEMENT_DIR` and `BUNDLE_DIR` where the
> agent's artifact is downloaded, a directory of its own under `runner.temp`, so the mint's reason
> file is never read as the runner's. `CHECKOUT` is the publish job's one checkout, `RESCUE_BRANCH`
> the job's, and `BRANCH` and `BASE_SHA` the gate job's `branch` and `base` outputs. It is handed
> the workflow token as `GH_TOKEN` and the loop's, empty where the mint failed. Both commands' write
> logs are uploaded `always()`.

## 7. `implement-prd`

Trigger label: `agent:implement`, on an issue with sub-issues: a PRD parent. `doctor` checks that
the label exists.

Builds the next sub-issue as commits on the PRD branch, and fails where the agent made none. It
fails with the agent's reason, whether or not it made commits, where the agent reports that the
sub-issue no longer matches the code. Preconditions: the PRD branch checked out
as `BRANCH`, at the tip the orchestrator brought up to date with `BASE_REF`, or created from
`BASE_REF` on the first slice (`implement-prd:prepare`); and, where an
earlier run of this PRD left commits on `RESCUE_BRANCH`, that branch fetched to
`refs/rescue/<RESCUE_BRANCH>` for the runner to resume from.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. |
| `AGENT_MODEL_IMPLEMENT_PRD` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_SANDBOX` | optional | `none` | Accepts `none` or `bwrap`: the agent's sandbox (§2.2, §3). Any other value fails the run, naming it. |
| `AGENT_SANDBOX_RO_BINDS` | optional | `""` | Read-only binds for `bwrap` (§2.2). |
| `AGENT_SANDBOX_PATH` | optional | `/usr/local/bin:/usr/bin:/bin` | `PATH` inside `bwrap` (§2.2). |
| `AGENT_SANDBOX_PROXY` | optional | `""` | The proxy for `bwrap`, required with it (§2.2). |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `ISSUE_NUMBER` | required | | The PRD parent. |
| `ISSUE_TITLE` | required | | Its title. |
| `SUB_NUMBER` | required | | The sub-issue to build. |
| `SUB_TITLE` | required | | Its title. |
| `BRANCH` | required | | The PRD branch. |
| `BASE_REF` | required | | The default branch. |
| `RESCUE_BRANCH` | required | | Where an earlier run of this PRD that stopped left its commits. |

### Outputs

| Output | When it is written |
|---|---|
| `rescue_ignored.json` | Where a rescue branch was found and set aside because the PRD branch moved since it was saved: `branch`, the rescue branch, and `movedPast`, its tip. `implement-prd:conclude` says so. |

**`doctor` cannot check this.** These tables are the runner's, for the reason §6 gives.

### What it reads from the record

- The parent's and the sub-issue's bodies and comments, through `isTrustedAuthor` (§4.1).
- `refs/rescue/<RESCUE_BRANCH>`, where it exists, to resume from.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** a gate job runs `implement-prd:gate` first, before anything is checked
> out, which defers to `implement`, refuses the run on the parent, or claims it and decides what it
> does; a glue step copies its decision and facts into the job's outputs, which every later job
> reads, and the job's last step starts the agent's clock.
> On a build, a catch-up job mints the loop's token, checks the default branch out and runs
> `implement-prd:catch-up`, which merges the default branch into the PRD branch and pushes it, or
> parks the chain on a conflict; a glue step copies its `catch-up.json` into the job's `parked`,
> `merged` and `head`, and the agent's job runs only where it did not park.
> The agent's job installs the package once, before the adopter's toolchain and `setup`, and runs
> its binary by path: `implement-prd:prepare`, which checks the PRD branch out at the tip the
> catch-up left and fetches the rescue branch, then the runner, then, however it ended,
> `implement-prd:bundle`; it hands the bundle, unmarked, every reason file and the rescue it set
> aside over as an artifact, and its last step measures whether it ran out of time.
> A publish job runs `implement-prd:publish` where the agent's job succeeded, which marks the
> slice's commits with the `Agent-Slice` trailer, pushes them to the PRD branch and deletes the
> rescue branch, then opens the PRD PR as a draft the first time or reuses it, writing its progress
> list and status line, and adds `agent:review`; and on a run that only opens a missing PRD PR,
> which does the last two alone; and on the finishing run, which hands the PRD PR over: marked
> ready, or its final review recorded and `agent:review` added. Then, however the run ended,
> `implement-prd:conclude`: a run that stopped has its commits pushed to `RESCUE_BRANCH`, its
> failure comment and `agent:blocked`, and, on a build, the stopped slice's row written back from
> the PRD branch; every run the gate decided has `agent:implement` taken off.

> **Service orchestrator:** the worker runs the gate job's, the catch-up job's, the agent's job's
> and the publish job's subcommands, in the order above and under each job's and step's `if:` in
> `implement-prd.yml`, not under the order alone, each a child process with a fresh `OUTPUT_DIR` of
> its own and an environment built from its declaration, and writes nothing to the record itself.
> The dispatcher answers `agent:implement` on an `issues` delivery, on an issue that is not a pull
> request's, from a person who can write or from its own App (ADR 0008), with **two** jobs, an
> implement job (§6) and an implement-prd job, as Actions starts both workflows on the label. It
> reads nothing of the issue's shape and checks nothing a gate would refuse with a comment: each
> gate partitions on the shape, and the one whose shape it is not defers without a word. The worker
> asks the dispatcher for a `write` token and runs `implement-prd:gate` with the parent's number,
> title and state as the label's event carried them.
>
> - **A refusal or a deferral ends the run at the gate.** Where `gate.json` says `proceed` `false`,
>   the gate job's `refused` is `true`, and on Actions no job after the gate runs. So no token is
>   asked for after the gate, neither the catch-up, the agent's phases, `implement-prd:publish` nor
>   `implement-prd:conclude` run, and the run's summary notes it. A regular issue is deferred to
>   `implement` that way, and gets silence from this job.
> - **An undecided gate**, one that failed or ran out of time before `gate.json` said `proceed`, is
>   not a refusal: `refused`, `build` and `finishing` are empty, the catch-up and the agent's job do
>   not run, and the publish job does, its checkout skipped. Neither runs where the gate claimed the
>   run and then failed, as at the probe, since both jobs need the gate's success.
> - **The catch-up**, only where the gate succeeded, claimed the run and decided to build: a `push`
>   token, since it pushes the merge of the base and parks with a comment; a checkout of the base
>   branch, by name, of its own; and `implement-prd:catch-up` in it, as both `GH_TOKEN` and
>   `LOOP_TOKEN`. It merges with the engine's merge itself, as Actions runs it, and not through
>   `update-branch:merge`, which pushes nothing. Its `catch-up.json` is the job's `parked`, `merged`
>   and `head`.
> - **The agent's job**, only where the catch-up succeeded and did not park the chain: a `read`
>   token; a checkout of the base branch, by name, of its own, as `implement-prd.yml`'s;
>   `implement-prd:prepare` with the same token, which fetches the PRD branch, checks it out at
>   `head`, the tip the catch-up left, and fetches the rescue branch;
>   the repository's setup, `AGENT_SETUP`, in the bwrap sandbox with no token; a fresh `read`
>   token, then the runner in the sandbox its settings name, with it as `GH_TOKEN`; and
>   `implement-prd:bundle`, handed no token, however those ended, as the bundle step's `always()`,
>   so a stopped build hands its commits over for the rescue.
> - **The publish job**, wherever the gate did not refuse: a `push` token, or, where that is
>   refused, a `write` token for conclude; and, where the gate claimed the run, a checkout of its
>   own, with whichever was granted: of `head` as the PRD branch where the catch-up left one, and
>   of the base branch by name otherwise. This differs from `implement-prd.yml`'s checkout of the
>   base on purpose: the bundle is the PRD branch less `head`, and `implement-prd:publish` and
>   `implement-prd:conclude`'s rescue each check it before they fetch anything, which fails in a
>   checkout without `head`. Actions' `fetch-depth: 0` fetches every branch, the PRD branch among
>   them; the service's checkout fetches the base alone, beside the head, and every tag, the set
>   `fetch-depth: 0` brings. `implement-prd:publish` runs where the gate succeeded and the run is the finishing
>   one, builds nothing (`open-only`), or its agent's job succeeded, and the mint and the checkout
>   did, pointed at the gate's and bundle's directories. Then `implement-prd:conclude`, however the
>   run ended, pointed at every producer's directory. Publish holds `push` as both `GH_TOKEN` and
>   `LOOP_TOKEN`, and conclude the same, or the `write` token as `GH_TOKEN` and no loop token where
>   `push` was refused; the runner never holds a token that writes.
>
> Where `implement-prd.yml` passes something the service does not have, it passes the nearest
> equivalent:
>
> - **`BASE_REF` is the repository's default branch**, as the `issues` delivery carries it, which
>   stands in for the caller's `default-branch` input.
> - **The gate job's and the catch-up job's outputs are their files**, read as the glue steps read
>   them: `REFUSED` from `gate.json`'s `proceed`; `BUILD` and `FINISHING` from its `decision`, empty
>   where it has none; `PRD_BRANCH`, `PRD_TIP`, `PRD_PR`, `LANDED`, `SUB` and `SUB_TITLE` from its
>   facts; `BASE_SHA` and `MERGED` from `catch-up.json`'s `head` and `merged`; `GATE_REASON` from
>   `implement-prd:gate`'s `failure_reason.txt`.
> - **`RESCUE_BRANCH` is `agent/rescue/prd-<parent>`**, as `prdRescueBranch` in `shared/record.ts`
>   spells it, the name `implement-prd.yml` gives it.
> - **`RUN_URL` is the App's own page**, `https://github.com/apps/<slug>`, as for implement (§6).
>   `GITHUB_SERVER_URL` and `GITHUB_REPOSITORY` are unset, so the approved slice's note names its
>   head unlinked and the progress list links no diffs.
> - **The time limits are the jobs'.** `implement-prd:gate` gets the gate job's 10 minutes, the
>   catch-up's checkout and `implement-prd:catch-up` share the catch-up job's 10. The agent's job's
>   steps share `AGENT_TIMEOUT_MINUTES` (30 where unset or not a positive integer), and one still
>   running at it is ended with every process it started: the agent's job is then `cancelled`, with
>   `TIMED_OUT` `true` and `TIMEOUT_MINUTES` the limit. `implement-prd:bundle` gets 5 minutes of its
>   own, as fix's does. Publish's checkout and `implement-prd:publish` share the publish job's 15
>   minutes, and `implement-prd:conclude` gets 15 of its own. The dispatcher's deadline for the job
>   is the sum of the jobs' limits, 35 minutes and the agent's, plus its margin, since two of its
>   jobs ask for a token before the agent's starts.
> - **A phase not started leaves its reason** where `implement-prd:conclude` reads the next one: a
>   catch-up token not granted, or a catch-up checkout that failed, as `implement-prd:catch-up`'s
>   `failure_reason.txt`; a `read` token not granted, or the agent's checkout failed, as
>   `implement-prd:prepare`'s; a setup that failed, or a runner's token not granted, as the
>   runner's; a publish checkout that failed, where publish would have run, as
>   `implement-prd:publish`'s.
> - **A checkout that fails before publish is publish's failure, on purpose.** Where publish's
>   checkout fails, `implement-prd:publish` does not run, and conclude is told `PUBLISH_OUTCOME` `failure`
>   with the checkout's reason as publish's, or `cancelled` where the checkout ran out of the
>   publish job's time. On Actions the failed checkout fails its step, and the publish step's
>   status check then reports `skipped`, which tells conclude, and so the person reading its
>   comment, nothing of why. The service names the cause instead, as every run function with a
>   checkout before publish does. This holds only where publish would have run: **a publish its `if:` skips is
>   `skipped`**, as on Actions, whatever the checkout did, since conclude reads `skipped` as an
>   ending of its own, a parked chain, which a checkout's failure is not.
> - **The download is as the reusable's**: `success` where the agent's job ran, since the hand-over
>   is on the worker's disk; `failure` on a build whose agent's job did not run, as an artifact
>   never uploaded is; and `skipped` on a run that builds nothing.
> - **The catch-up's directory** holds a reason only where the catch-up failed, as its hand-over is
>   uploaded only then.
>
> **The chain's loop runs on the service alone.** The chain moves on only when a review ends on an
> approval and `review:advance` puts `agent:implement` back on the parent. The service runs it
> (§8), and answers the `agent:implement` it re-adds with the pair again: the implement job defers
> the PRD without a word, and the implement-prd job builds the next slice, or hands the PRD PR
> over. Nothing about the chain is kept in the service between slices: each gate reads where the
> chain stands from the record, as on Actions, so a worker restarted between two slices picks the
> chain up at the next `agent:implement`. Each slice is a job of its own, so another repository's
> jobs run between two slices of a chain.
>
> Not run: `node-version-file`, since the sandbox runs the worker box's own Node, the session
> transcript's upload, and the write logs' upload, which stay in the run's directory.

### `implement-prd:gate`

Refuses, defers or claims a PRD parent, and decides what the run does, before anything is checked
out and before the agent's job. It runs no model and needs no checkout. In order:

- **The partition.** The parent's parent, sub-issue count and labels are read in one query. An
  issue with no sub-issues is `implement`'s (§6), which answers the same label event, so it is
  deferred: nothing is written to the record, a closed issue included. A query that fails fails
  the command.
- **The shape's refusals**, each with its own sentence: an `ISSUE_STATE` that is not `open`; a
  `wayfinder:*` label, blocked; a parent, blocked; more than 100 sub-issues, blocked.
- **The sub-issues**, read once, in the list's order, every page. A list shorter than the count
  fails the command, so a short read is never a chain whose slices all landed.
- **The PRD branch**, found by its stem (§4.3). More than one fails the command, naming each; none
  is a chain not started, and the branch is named from `ISSUE_TITLE`.
- **Slice PRs an older release opened into the PRD branch**, still open from an `agent/slice-`
  head: refused, blocked, naming each. Pre-upgrade compatibility, removable under #224.
- **Which sub-issues are built**: the `Agent-Slice` trailers (§4.3) in the commits the PRD branch
  has over `BASE_REF`. The next slice is the first open sub-issue none names; a closed one none
  names landed before the upgrade, and counts as landed.
- **The PRD PR**, the open pull request from the PRD branch. More than one fails the command.
- **The decision**: nothing built builds the first slice, or the first after the upgrade, and with
  every sub-issue closed before the upgrade is refused; slices built and no PRD PR open only opens
  it; a PRD PR already handed over is refused as finished (with more than one slice landed, its
  body carries `agent:final-review requested`, §4.3; with one, it is not a draft); one carrying
  `agent:review`, `agent:fix` or `agent:update-branch` is refused while its round runs; otherwise
  the `agent-review` status on its head decides, and only `success` goes on, to the next slice, or
  with none left, to a finishing run that builds nothing. Every other verdict, and none, is
  refused, naming the ways on. None of these refusals is blocked.
- **The links, on a first build only**: a sub-issue blocked by one listed after it, whatever its
  state, or by an open issue outside the PRD, is refused, blocked. Then, on any build, the parent's
  own open blockers, blocked; a failed read of those is none, the one read here that is tolerated.
- **A refusal** is said in the loop's one order: the comment,
  `` **`agent:implement` didn't run:** `` and the sentence; then `agent:implement` off; then
  `agent:blocked` where it is blocked. Each is tolerated.
- **The permission probe** on a run it claims: `agent:implement` added to the parent, which already
  carries it, not tolerated. Then `agent:blocked` off, tolerated.
- **The start comments**, on a build, each tolerated: on the chain's first run, the parent's
  `` **`agent:implement` started:** building #<sub> first. `` ending with
  `<!-- agent:prd-started -->` (§4.3), unless a comment on the parent already carries it; the
  sub-issue's, linking `RUN_URL`; and, where the PRD PR is open, its chapter marker,
  `**Slice <k> of <n> · #<sub> started**`.
- **The approved slice's note**, past an approval, on a build or a finishing run, on the approved
  slice's sub-issue: `**Slice approved:**`, built in the head, linked under
  `GITHUB_SERVER_URL`, and reviewed on the PRD PR, linking the review the verdict links; then the
  `- **Changed:**` and `- **Unmet:**` lines of the approving review's criteria group (§4.3), or
  that none were, or that the review could not be read; ending with
  `<!-- agent:slice-approved <sha> -->` (§4.3), unless a comment on the sub-issue already carries
  it. Tolerated, and so is every read it makes: a warning, and the run goes on.
- **The building row**, on a build with a PRD PR: the slice's row in the progress list and the
  status line, spliced into the live body as the renderer renders them with the slice building.
  A run that stops after it has the row written back by `implement-prd:conclude`. Half
  a progress marker pair, or two, or no row for the slice, leaves the body as it stands with a
  warning, and no list leaves it with a line saying so. Tolerated.

Every failed read but the parent's blockers fails the command with a sentence naming what could not
be read: "could not look" is never "nothing there". Every write is made with `GH_TOKEN`: none of
them has to start a run. A refusal or a deferral is a decision, and the command succeeds.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `ISSUE_NUMBER` | required | | The PRD parent. |
| `ISSUE_TITLE` | required | | Its title, which a PRD branch not yet made is named from. |
| `ISSUE_STATE` | required | | The parent's state as the event saw it: `open` or `closed`. |
| `BASE_REF` | required | | The default branch, which the built slices are read over. |
| `RUN_URL` | required | | The run's page, which the sub-issue's start comment links. |
| `GITHUB_SERVER_URL` | optional | `""` | With `GH_REPO`, the link to the approved head in the approved slice's note. Empty renders the commit unlinked. |

#### Outputs

| Output | When it is written |
|---|---|
| `gate.json` | Where it decided: `proceed`, `true` where the run goes ahead and `false` where it refused or deferred, as a string. On a run it claims, beside it: `decision`, `build`, `open-only` or `finishing`; `prdBranch`, `prdBranchExists` and `prdTip`, empty where the branch does not exist; `prdPr`, where one is open; `landed`, every slice landed, those before the upgrade included; `total`, the sub-issues; on a build, `slice`, its `number`, `position` from 1 and `title`; and past an approval, `approved`, the approved slice's `number`, the head's `sha` and the approving `review`'s link. Written the moment it decides, and again however it ends: one that died before deciding writes none where an input could not be read, and `{}` where it failed after that. |
| `prd-issue.json` | Once the sub-issues are read: the parent's labels and its sub-issues, each with its number, title and state, as the shell query this replaced gave them. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The parent's parent, sub-issue count and labels, for `wayfinder:*`, and its sub-issues in order.
- `agent/prd-<parent>-` branches (§4.3), and the `Agent-Slice` trailers on the PRD branch.
- The open pull requests into the PRD branch and from it, and the PRD PR's labels, draft state and
  body, for `agent:final-review requested` (§4.3).
- The `agent-review` status on the PRD PR's head (§4.3).
- The issues each sub-issue and the parent are blocked by.
- The parent's comments, for `<!-- agent:prd-started -->`.
- Past an approval, the approved sub-issue's comments, for `<!-- agent:slice-approved <sha> -->`,
  and the PRD PR's reviews, for the approving one's criteria group.
- On a build with a PRD PR, its live body, for the `agent:progress` and `agent:status` blocks.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the gate job's first work, after a Node set up for it, since nothing is
> checked out yet; no adopter step runs in that job. `ISSUE_STATE` and `ISSUE_TITLE` are the
> label's event's, and `GH_TOKEN` is the job's own, with `issues: write`, `pull-requests: write`
> and `statuses: read`. `OUTPUT_DIR` is `runner.temp`. A glue step copies `gate.json` into step
> outputs, `always()`, under the names the later jobs read: the job's `refused` is `false` where
> `proceed` is `true`, `true` where it is `false`, and empty where there is none, a gate that died
> before deciding; `build` and `finishing` are read off `decision`; `prd_branch`,
> `prd_branch_exists`, `prd_tip`, `prd_pr`, `landed`, `subs`, `sub`, `sub_k` and `sub_title` off
> the rest. The same step copies the command's `failure_reason.txt`, where it wrote one, into the
> job's `failure-reason`, which `implement-prd:conclude` is told as `GATE_REASON`, and the job
> uploads `prd-issue.json` for the publish job's two commands. The job
> fails where the command does, so a failed probe never starts the catch-up or the agent's job.

### `implement-prd:catch-up`

Brings the PRD branch up to date with the default branch before a slice is built, so a change made
there mid-chain reaches the next slice's round with no hand steps. It runs no model, and runs in a
checkout of the repository. In order:

- **Prepare.** Where `PRD_TIP` is set, the PRD branch is fetched with `GH_TOKEN` and checked out at
  its tip. Where it is empty, the gate found no PRD branch, and it is made at `BASE_REF` as fetched:
  nothing is merged and nothing is pushed, since a PRD branch is pushed with its first slice. A
  fetch that fails fails the command, naming why.
- **The merge.** `BASE_REF`, fetched with `GH_TOKEN`, merged into the PRD branch as the loop's
  committer, always as a merge commit, never a rebase or a fast-forward, with the message
  `Merge <BASE_REF> into <PRD_BRANCH>`, a blank line and `Agent-Catch-Up: #<SUB>` (§4.3). A branch
  already holding the base merges nothing and pushes nothing. A merge that stops on no conflict
  fails the command with git's reason.
- **The park**, on a conflict: nothing is built or pushed, and `catch-up.json` says `parked`
  first. Then the comment on `ISSUE_NUMBER`, `` **`agent:implement` didn't run:** `` and a sentence
  naming the conflicted files and the slice it parked before, with the way on: `agent:update-branch`
  on `PRD_PR` where it is set, otherwise a merge by hand; then `agent:implement` off. No
  `agent:blocked`: the chain moves on by itself once the conflict is resolved. Each is tolerated,
  and the command succeeds.
- **The push** of the merge to `refs/heads/<PRD_BRANCH>` with `LOOP_TOKEN`, leased on `PRD_TIP`,
  so a push someone made to the PRD branch during the run is refused rather than overwritten, and
  the command fails saying the branch moved. A push refused otherwise fails it too, and where the
  merge changes a file under `.github/workflows`, names it and the token's missing Workflows:
  write, since a retry fails the same way.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | required | | The token whose writes start the loop's next workflow: the push. |
| `LOOP_TOKEN_SOURCE` | required | | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `ISSUE_NUMBER` | required | | The PRD parent, which a park comments on. |
| `BASE_REF` | required | | The default branch, merged into the PRD branch. |
| `PRD_BRANCH` | required | | The PRD branch: `implement-prd:gate`'s `prdBranch`. |
| `PRD_TIP` | optional | `""` | `implement-prd:gate`'s `prdTip`, which the push is leased on. Empty is a PRD branch that does not exist yet. |
| `PRD_PR` | optional | `""` | The PRD PR, where one is open, which a park names. |
| `SUB` | required | | The sub-issue this run builds, named in the merge's trailer and in a park. |
| `CHECKOUT` | required | | A checkout of the repository, the merge is made and pushed in. |

#### Outputs

| Output | When it is written |
|---|---|
| `catch-up.json` | Where it did not fail: `parked`, whether the chain parked; `merged`, the merge commit, where it pushed one; and `head`, the PRD branch's tip as it left it, where it did not park. On a park it is written before the comment. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- Nothing GitHub's API answers: the PRD branch and `BASE_REF`, fetched.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the catch-up job runs on a build, where the gate claimed the run. It
> mints the loop's token, checks the default branch out with no credential left in it, and sets up
> Node; `implement-prd:catch-up` runs from `RUNNER_TEMP`, working in the checkout, handed the
> workflow token as `GH_TOKEN` and the loop's. `PRD_BRANCH`, `PRD_TIP`, `PRD_PR` and `SUB` are the
> gate job's outputs. A glue step copies `catch-up.json` into the job's `parked`, `merged` and
> `head`: the agent's job runs only where `parked` is not `true`, the runner reads `merged` as
> `MERGED`, and the agent's and publish jobs read `head` as `BASE_SHA`. Where the command fails, the
> job uploads its `failure_reason.txt` for the publish job to report.

### `implement-prd:prepare`

Checks the PRD branch out for the agent, and fetches the rescue an earlier stopped run left. It runs
no model, and writes nothing to the record: it reads and fetches with `GH_TOKEN`, and is handed no
writer. In order:

- **The PRD branch.** Where `PRD_TIP` is set, the gate found the PRD branch, and it is fetched
  with `GH_TOKEN` to `refs/remotes/origin/<PRD_BRANCH>`; where it is empty, the catch-up made it at
  `BASE_REF`, which the checkout holds. Then it is checked out as `PRD_BRANCH` at `BASE_SHA`, the
  tip the catch-up left it at, not the tip the fetch found, so the agent builds on exactly the tip
  the publish job checks its commits against, with the loop's committer, `sandcastle-agent[bot]`
  and its noreply address, as the checkout's identity. A fetch that fails fails the command, naming
  why; a checkout that does not hold `BASE_SHA` fails it with `` The checkout doesn't hold
  <BASE_SHA>, the tip `<PRD_BRANCH>` was brought up to date at for this run, so nothing was built.
  ``.
- **The rescue**, as `fix:prepare` fetches it: `RESCUE_BRANCH`'s tip is read from the repository's
  refs, and where there is one, the branch is fetched into `CHECKOUT` as
  `refs/rescue/<RESCUE_BRANCH>`, outside `refs/remotes/`, so its commits count as this run's. A 404
  is no rescue, and fetches nothing. **An unreadable answer stops the run**, rather than reading as
  no rescue, since a run that started over without the rescue, and succeeded, would delete it: it
  fails with `` Couldn't check whether an earlier run left commits on `<RESCUE_BRANCH>`, so this run
  stopped rather than start over without them. ``, and a rescue that is there but cannot be fetched
  fails it too, naming the branch.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout of the default branch the agent will work in. |
| `PRD_BRANCH` | required | | The PRD branch: `implement-prd:gate`'s `prdBranch`. |
| `PRD_TIP` | optional | `""` | `implement-prd:gate`'s `prdTip`. Empty is a PRD branch the catch-up made, which is not fetched. |
| `BASE_SHA` | required | | The PRD branch's tip as `implement-prd:catch-up` left it, its `head`, which the branch is checked out at. |
| `SUB` | required | | The sub-issue this run builds, named in its log and in a failed fetch. |
| `RESCUE_BRANCH` | required | | Where an earlier run of this PRD that stopped left its commits. |

#### Outputs

| Output | When it is written |
|---|---|
| | Nothing beyond §2.4. The result is the branch it checked out and the ref it fetched. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The PRD branch, fetched.
- `RESCUE_BRANCH`'s tip; a 404 is no rescue.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the agent's job, after the checkout of the default branch and before
> the adopter's toolchain and `setup`, so nothing of the adopter's has run on the runner while it
> holds the token. It runs the binary of the package installed early in that job, by its path, from
> `RUNNER_TEMP`, handed the job's `GH_TOKEN`, which is read-only there, and no registry token.
> `CHECKOUT` is the workspace; `PRD_BRANCH`, `PRD_TIP` and `SUB` are the gate job's outputs, and
> `BASE_SHA` the catch-up job's `head`. `OUTPUT_DIR` is a directory of its own under `runner.temp`,
> which the job's upload carries, for the failure comment.

### `implement-prd:bundle`

Bundles the agent's commits for whatever pushes or rescues them: the commits on
`refs/heads/<PRD_BRANCH>` in the checkout ahead of `BASE_SHA`, the tip the catch-up left, as a thin
bundle holding exactly that one ref, with `BASE_SHA` its prerequisite. Bundled as `fix:bundle`
bundles. It runs no model, reads no repository, holds no token, and writes nothing to the record.

- **Nothing to bundle.** No commits ahead of `BASE_SHA`, or no `refs/heads/<PRD_BRANCH>` at all,
  writes nothing, which whatever reads the bundle reads as nothing to push or rescue.
- **A failure of git.** Fails the command, naming the branch and the tip.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout the agent worked in, with the PRD branch as `PRD_BRANCH`. |
| `PRD_BRANCH` | required | | The PRD branch: `implement-prd:gate`'s `prdBranch`. |
| `BASE_SHA` | required | | The PRD branch's tip as `implement-prd:catch-up` left it, its `head`. |

#### Outputs

| Output | When it is written |
|---|---|
| `branch.bundle` | Where there are commits ahead of `BASE_SHA`: the bundle. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

Nothing. Its inputs are the checkout and the catch-up's tip.

> **Actions orchestrator:** the agent's job, `always()` after the runner and the transcript, so
> a failed, cancelled or timed-out run hands its commits over too. They are unmarked: the
> `Agent-Slice` trailer is `implement-prd:publish`'s to write. It runs the binary of the package
> installed early in that job, by its path, from `RUNNER_TEMP`, and is handed no token: the job's
> `GH_TOKEN` is set empty for it.
> `CHECKOUT` is the workspace, `PRD_BRANCH` the gate job's output and `BASE_SHA` the catch-up job's
> `head`. `OUTPUT_DIR` is a directory of its own under `runner.temp`, which the job's upload
> carries beside the runner's files; the publish job checks the bundle before it pushes or rescues
> anything from it.

### `implement-prd:publish`

On a build, `BUILD` `true`, checks the agent's bundle, marks the slice's commits and pushes them to
the PRD branch, then deletes the rescue branch; then, on a build and on a run that only opens a
missing PRD PR, `BUILD` `false`, opens the PRD PR or reuses it and asks for its review. It runs no
model. Before its first write it reads `prd-issue.json`, the gate's snapshot of the sub-issues,
and on a build it checks `branch.bundle`:

- that it is there, or `The agent's job finished without handing over its commits, so nothing was
  pushed.`;
- that it verifies in `CHECKOUT`, or `The agent's commits arrived damaged or incomplete, so nothing
  was pushed.`;
- that it holds exactly `refs/heads/<PRD_BRANCH>`, or `` The agent's commits arrived on a branch
  other than `<PRD_BRANCH>`, or beside other branches, so nothing was pushed. ``;
- and that its tip builds on `BASE_SHA`, or `` The agent's commits don't build on `<PRD_BRANCH>` as
  this run found it, so nothing was pushed. ``

Then **the mark** (#410): `BASE_REF` is fetched with `GH_TOKEN`, and every commit in the bundle's
tip's history and in neither `BASE_SHA`'s nor `BASE_REF`'s as fetched is made again with its
message rewritten, so the PRD branch's earlier slices and a default-branch commit the agent merged
in keep their identity, and commits a run resumed from a rescue are marked as this slice's. Each
loses every `Agent-Slice` line the agent wrote, in any case, and gains `Agent-Slice: #<SUB>` in the
trailer block git's parser reads, the message's last paragraph, or a paragraph of its own where
that is not all trailers. Trees, authors, committers and dates are kept, a merge's parents are
remapped through the rewrite, and no ref is moved. A range with no commit fails the command with
`` The agent's commits on `<PRD_BRANCH>` are all on `<PRD_BRANCH>` as this run left it or on
`<BASE_REF>` already, so sub-issue #<SUB> has no commits of its own and nothing was pushed. ``; a
fetch that fails fails it, naming why.

The order: the push of the marked tip to `refs/heads/<PRD_BRANCH>` with the loop's token, leased on
`BASE_SHA`, or on the branch not existing where `PRD_TIP` is empty, since the catch-up pushes no
PRD branch it made. A push someone made to the PRD branch during the run is refused, with
`` `<PRD_BRANCH>` changed while this run worked, so sub-issue #<SUB>'s commits were not pushed over
what is there now. Trying again builds it on top of that. ``; any other refusal fails it, naming
GitHub's reason. Then `RESCUE_BRANCH`'s tip is read, and the branch deleted with the loop's token,
leased on that tip. A 404 is nothing to delete; a read or a delete that fails is a warning, since
the next run sets the branch aside.

Then **the PRD PR** (#503), with the loop's token throughout. `BASE_REF` is fetched, and on a run
that built nothing `PRD_BRANCH` too, and the open pull requests from `PRD_BRANCH` are read: more
than one fails the command with `` <n> open PRs come from this PRD's branch `<PRD_BRANCH>` (#<a>,
#<b>), so it can't tell which one is the PRD PR. Close all but one. ``, and a read that fails fails
it. The progress list and status line are rendered with the chain in review, from the snapshot's
sub-issues, the slices read off the PRD branch's first-parent log since `BASE_REF` as this run
left it, and, on a PRD PR being reused, its reviews and each time `agent:fix` was added to it, for
the counts; rounds that cannot be read are a warning, and the table says so in each cell. A
branch that cannot be read is a warning: a PRD PR opened then says when its table is written.

- **None open:** a draft from `PRD_BRANCH` into `BASE_REF`, titled `ISSUE_TITLE` cut to 256
  characters, with the PRD frame (§4.3). A server error is read back, by this head and this base,
  and a PRD PR found is carried on with, with a warning; a read-back that fails too fails the
  command, saying to look for the PRD PR before adding `agent:implement` again. A refusal fails
  it, saying to set the App or `AGENT_PAT` up first where `LOOP_TOKEN_SOURCE` is neither. Then,
  on a build, `**Slice <k> of <n> · #<SUB> started**` on it; a failure is a warning.
- **One open:** reused, its progress list and status line spliced into its live body, and the
  `Closes` block appended where the body has no `Closes` marker, in one edit. Half a list, or two,
  is left as it stands with a warning, and so is a failed edit.

Then the review: on a build, a wait of up to `HEAD_WAIT_SECONDS` for the PRD PR to show the pushed
commit, polled every `HEAD_POLL_SECONDS`, then a warning; `agent:implement` off `ISSUE_NUMBER` and
`agent:review` off the PRD PR, each a warning where it fails; and `agent:review` added, or the
command fails with `` Couldn't add `agent:review` to PRD PR #<n>, so no review was requested. ``.
Where `LOOP_TOKEN_SOURCE` is neither `app` nor `pat` it warns that the label starts nothing.

On **the finishing run**, `FINISHING` `true` (#504), it builds, fetches and pushes nothing, and
hands `PRD_PR` over, with the loop's token. Where `LOOP_TOKEN_SOURCE` is neither `app` nor `pat`
it writes nothing and fails with `` Couldn't hand PRD PR #<n> over, because neither the loop's App
nor `AGENT_PAT` is set and GitHub doesn't let the default token mark a draft ready or start a
review. Every sub-issue is built. Set up one of them; trying again resumes the handover and builds
nothing. ``

- **`LANDED` one:** the slice's round was the review of the whole PRD PR, so it is marked ready
  for review, or the command fails with `` Couldn't mark PRD PR #<n> ready for review. Trying again
  resumes the handover and builds nothing. ``
- **More than one:** the final review. Its live body, its trailing line breaks dropped, gets the
  final review's row, in review, and `agent:final-review requested` (§4.3) in front of the
  progress list's end marker, or the mark at its end after a blank line where it has no list, and
  its status line, where it has exactly one, becomes `**🔍 Final review of all <n> slices**`, `<n>`
  the snapshot's sub-issues; a body that has the mark already, a retry's, is not written. A failed
  edit fails the command. Then `agent:implement` off `ISSUE_NUMBER` and `agent:review` off the PRD
  PR, each a warning where it fails, and `agent:review` added. Where the add fails, a body this run
  marked is written back as it read it, and the command fails with `` Couldn't add `agent:review`
  to PRD PR #<n>, so its final review was not requested. Trying again resumes the handover and
  builds nothing. ``, or, where the write back fails too, with a sentence saying to add the label
  by hand. Then `**Final review of all <n> slices started** · [Workflow run](<RUN_URL>)` on the
  PRD PR; a failure is a warning.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | required | | The token whose writes start the loop's next workflow: every write it makes. |
| `LOOP_TOKEN_SOURCE` | required | | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `GITHUB_SERVER_URL` | optional | `""` | With `GITHUB_REPOSITORY`, the link to a reused PRD PR's diffs in its progress list. Empty renders none. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `ISSUE_NUMBER` | required | | The PRD parent, which `agent:implement` comes off and the frame names. |
| `ISSUE_TITLE` | required | | Its title, the title of a PRD PR it opens. |
| `BASE_REF` | required | | The default branch, fetched so its commits are left unmarked, and what the PRD PR goes into. |
| `PRD_BRANCH` | required | | The PRD branch: `implement-prd:gate`'s `prdBranch`, which the bundle has to hold, the push moves and the PRD PR comes from. |
| `PRD_TIP` | optional | `""` | `implement-prd:gate`'s `prdTip`. Empty is a PRD branch the catch-up made and did not push, and the push is leased on its not existing. |
| `BUILD` | required | | Accepts `true` or `false`: whether `implement-prd:gate` decided this run builds a slice, or only opens a missing PRD PR. |
| `FINISHING` | required | | Accepts `true` or `false`: whether `implement-prd:gate` decided this is the finishing run, which hands the PRD PR over and builds nothing. |
| `PRD_PR` | optional | `""` | Required on the finishing run: the PRD PR `implement-prd:gate` found, its `prdPr`, which is handed over. |
| `LANDED` | optional | `""` | Required on the finishing run: `implement-prd:gate`'s `landed`, every slice that landed, those before the upgrade included. One is marked ready; more is a final review. |
| `RUN_URL` | required | | This run's page, which the final review's start comment links. |
| `BASE_SHA` | optional | `""` | Required on a build: the PRD branch's tip as `implement-prd:catch-up` left it, its `head`: what the bundle has to build on, what the mark starts after, and what the push is leased on. |
| `SUB` | optional | `""` | Required on a build: the sub-issue this run built, which the trailer names. |
| `RESCUE_BRANCH` | required | | Where an earlier run of this PRD that stopped left its commits, deleted once the slice is pushed. |
| `CHECKOUT` | required | | A checkout of the repository holding `BASE_SHA`, the bundle is checked, marked and pushed in. |
| `HEAD_WAIT_SECONDS` | optional | `60` | How long to wait for the PRD PR to show the pushed commit before asking for the review anyway. |
| `HEAD_POLL_SECONDS` | optional | `5` | How often to look while waiting. |
| `GATE_DIR` | directory | | `implement-prd:gate`'s `OUTPUT_DIR`. Reads `prd-issue.json`. |
| `BUNDLE_DIR` | directory | | `implement-prd:bundle`'s `OUTPUT_DIR`. Reads `branch.bundle` (where written). |

#### Outputs

| Output | When it is written |
|---|---|
| `published.json` | From its first write: `pushed`, whether it pushed; `head`, the marked commit pushed, where it did; `pr`, the PRD PR opened or reused, once it is known; `requested`, whether `agent:review` went on; and `handedOver`, whether the finishing run handed the PRD PR over. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:publish`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `BASE_REF`, fetched, and on a run that built nothing `PRD_BRANCH` too.
- `RESCUE_BRANCH`'s tip; a 404 is nothing to delete.
- The PRD branch's `Agent-Slice` and `Agent-Catch-Up` trailers (§4.3), for the progress list.
- The open pull requests from `PRD_BRANCH`, for the PRD PR.
- A reused PRD PR's reviews headed `## Agent review` by the loop's identity, and each time
  `agent:fix` was added to it, for the progress list's counts; its live body, for the
  `agent:progress`, `agent:status` and `agent:closes` blocks; and its head, for the wait.
- On the finishing run, the PRD PR's live body, for `agent:final-review requested`, the progress
  list's end marker and the status line.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the publish job, after the downloads, the mint, the checkout of the
> default branch and the Node setup, wherever the gate decided the run and, on a build, the
> agent's job succeeded: the finishing run's included, which has no agent's job. It runs from
> `npm exec` from `RUNNER_TEMP`, handed the workflow token as `GH_TOKEN` and the loop's.
> `CHECKOUT` is the workspace; `PRD_BRANCH`, `PRD_TIP`, `BUILD`, `FINISHING`, `PRD_PR`, `LANDED`
> and `SUB` are the gate job's outputs, `RUN_URL` the job's, `BASE_SHA` the catch-up job's `head`,
> `GATE_DIR` where the gate's artifact is downloaded, and `BUNDLE_DIR` where the agent's job's
> artifact puts `implement-prd:bundle`'s files, each artifact in a directory of its own under
> `runner.temp`. `OUTPUT_DIR` is a directory of its own there too, which `implement-prd:conclude`
> reads. The write log is kept as an artifact, beside conclude's.
### `implement-prd:conclude`

Ends every implement-prd run the gate did not refuse or defer, success included, in the loop's one
order: every result posted, then `agent:implement` off, then `agent:blocked`, then the progress
list. It runs no model, and runs in a checkout of the repository. It is told how the run went rather
than reading it off which steps ran: the gate's decision, result and reason, the catch-up's and the
agent's job's results, whether that job ran out of time, and the outcome of the mint, the agent's
download and `implement-prd:publish`, and it works out the ending from them. First, wherever the
runner wrote `rescue_ignored.json`, the note that the rescue was set aside (#303), on
`ISSUE_NUMBER`: `` **`agent:implement` started fresh:** `` and that the PRD branch has moved since.
Then the ending, one of:

- **A refusal or a deferral** (`REFUSED` is `true`): nothing, not the note either.
- **A run that finished**: every step it needed says `success`, the gate, the mint and publish,
  and on a build the catch-up and the agent's job too; anything else, a publish skipped behind a
  failed checkout among it, is a run that stopped. `agent:implement` off, even where publish took it off before it asked for the review,
  since that removal is tolerated and may have failed (#494).
- **A chain the catch-up parked**: a build whose agent's job, and so publish, was skipped behind a
  catch-up that succeeded. The catch-up said so; `agent:implement` off, and the stopped slice's row.
- **A run that stopped**, after a gate that decided the run was its own (`REFUSED` is `false`):
  on a build where `published.json` says nothing was pushed and a bundle arrived, the bundle checked
  in `CHECKOUT` as publish checks it and its tip pushed to `RESCUE_BRANCH` with the loop's token,
  leased on that branch's tip as read, or on its not existing on a 404; a check that fails, a read
  or a push that fails, and a loop token not minted, are each a warning and rescue nothing. Then
  the failure comment, `` **`agent:implement` stopped:** ``, the reason as a sentence, then
  `It was handing the PRD PR over, with every sub-issue built.` on the finishing run or
  `It was building sub-issue #<SUB>.` where `SUB` is set, the run's link and the retry; then
  `agent:implement` off; then `agent:blocked`; then, on a build, the stopped slice's row.
- **A gate that did not decide** (`REFUSED` is empty, in either shape `gate.json` leaves it, none or
  one with no `proceed`): the same comment and `agent:blocked`, and `agent:implement` is **left
  on**: that run may have been the event `implement` answers, which holds the label while it works.

The reason is, where the gate, the catch-up, the agent's job, the mint or publish was cancelled, a
cancel, or the time limit where `TIMED_OUT` is `true`. Otherwise the first given, of `GATE_REASON`
and the `failure_reason.txt` of `implement-prd:catch-up`, the runner, `implement-prd:publish`,
`implement-prd:prepare` and `implement-prd:bundle`; then a fixed sentence where the mint failed;
then, where the agent's job failed, the time limit where `TIMED_OUT` is `true`; then a fixed
sentence where the agent finished and the download failed; and failing all of those, that it gave
no reason. The retry is `` To try again, add `agent:implement`. ``, or on the finishing run
`` To try again, add `agent:implement`; it resumes the handover and builds nothing. ``; after a gate
that did not decide, `` To try again, remove `agent:implement` if it is still on this issue, then
add it. ``; where `MERGED` is set, nothing was pushed and there is a PRD PR, that the default
branch's merge has no review yet and to add `agent:review` to it; and where the slice was pushed,
that it won't be built again, and to add `agent:review` to the PRD PR, or `agent:implement` where
there is none. A rescue is named beside any of those, and is the retry where the plain one was.

**The stopped slice's row** (#246, #325), on a build that did not finish, where the gate decided,
into the PRD PR `published.json` names or `PRD_PR`: `BASE_REF` and `PRD_BRANCH` fetched with
`GH_TOKEN`, and the progress list and status line rendered from the slices read off the PRD
branch's first-parent log since `BASE_REF`, the gate's snapshot of the sub-issues, and the PRD PR's
reviews and each time `agent:fix` was added to it, with nothing running. The latest slice on the
branch is parked where this run pushed its slice, or `MERGED` is set, a catch-up merge no review
has seen, and approved otherwise, which is what the gate built on. Spliced into the live body with
the loop's token, the status line where the body has exactly one; a body with no list is left
alone, and half a list, or two, is left with a warning. No PRD PR, no snapshot, no loop token, a
branch that cannot be read and a failed edit are each a warning, or a line, and write nothing.

Each file of each directory is read on its own, so a file that does not read is a warning and is
read as not written, and costs the comment nothing another file gave. Every write is tolerated:
one GitHub refuses is a warning. The note, the comment and the labels are made with `GH_TOKEN`.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | optional | `""` | The loop's token, which the rescue and the row are written with. Empty where it was not minted, and neither is written. |
| `LOOP_TOKEN_SOURCE` | optional | `""` | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `GITHUB_SERVER_URL` | optional | `""` | With `GITHUB_REPOSITORY`, the link to the PRD PR's diffs in its progress list. Empty renders none. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `ISSUE_NUMBER` | required | | The PRD parent. |
| `BASE_REF` | required | | The default branch, which the slices are read over and the retry names. |
| `RUN_URL` | required | | The run's page, which the failure comment links. |
| `RESCUE_BRANCH` | required | | Where a stopped run's commits are pushed, and the rescue the runner set aside has to name. |
| `CHECKOUT` | required | | A checkout of the repository holding `BASE_SHA`, the bundle is checked and the branch read in. |
| `REFUSED` | optional | `""` | Accepts `true` or `false`: `false` where the gate claimed the run, `true` where it refused or deferred. Empty is a gate that died before it decided. |
| `BUILD` | optional | `""` | Accepts `true` or `false`: whether the gate decided this run builds a slice. Empty where it did not decide. |
| `FINISHING` | optional | `""` | Accepts `true` or `false`: whether the gate decided this is the finishing run. |
| `PRD_BRANCH` | optional | `""` | The PRD branch, the gate's `prdBranch`: what the bundle has to hold, and what is read for the row. |
| `PRD_PR` | optional | `""` | The PRD PR the gate found, where `published.json` names none. |
| `SUB` | optional | `""` | The sub-issue this run builds, which the comment names. |
| `BASE_SHA` | optional | `""` | The PRD branch's tip as `implement-prd:catch-up` left it, which the bundle has to build on. |
| `MERGED` | optional | `""` | The catch-up's merge of the default branch, where it pushed one. |
| `GATE_RESULT` | required | | How the gate's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `GATE_REASON` | optional | `""` | The sentence `implement-prd:gate` failed with, where it wrote one. |
| `CATCH_UP_RESULT` | required | | How the catch-up's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `AGENT_RESULT` | required | | How the agent's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `TIMED_OUT` | optional | `""` | `true` where the agent's job ran its whole limit. |
| `TIMEOUT_MINUTES` | optional | `""` | That limit, for the comment. |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting the loop's token: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `DOWNLOAD_OUTCOME` | optional | `""` | The same, for fetching the agent's hand-over. |
| `PUBLISH_OUTCOME` | optional | `""` | The same, for `implement-prd:publish`. |
| `GATE_DIR` | directory | | `implement-prd:gate`'s `OUTPUT_DIR`. Reads `prd-issue.json` (where written). |
| `CATCH_UP_DIR` | directory | | `implement-prd:catch-up`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `PREPARE_DIR` | directory | | `implement-prd:prepare`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `IMPLEMENT_PRD_DIR` | directory | | The `implement-prd` runner's `OUTPUT_DIR`. Reads `failure_reason.txt` (where written) and `rescue_ignored.json` (where written). |
| `BUNDLE_DIR` | directory | | `implement-prd:bundle`'s `OUTPUT_DIR`. Reads `branch.bundle` (where written) and `failure_reason.txt` (where written). |
| `PUBLISH_DIR` | directory | | `implement-prd:publish`'s `OUTPUT_DIR`. Reads `published.json` (where written) and `failure_reason.txt` (where written). |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `RESCUE_BRANCH`'s tip, for the rescue's lease; a 404 is none.
- `BASE_REF` and `PRD_BRANCH`, fetched, and the PRD branch's `Agent-Slice` and `Agent-Catch-Up`
  trailers (§4.3), for the stopped slice's row.
- The PRD PR's reviews headed `## Agent review` by the loop's identity, and each time `agent:fix`
  was added to it, for the row's counts; and its live body, for the `agent:progress` and
  `agent:status` blocks.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the publish job's step after `implement-prd:publish`, run `always()`,
> from `RUNNER_TEMP`, as are the Node setup and the write logs' upload around it, and the checkout
> wherever the gate claimed the run, so the bundle is never checked in an empty workspace (#473).
> Each job's artifact is downloaded `always()` into a directory of its own under `runner.temp`: the
> agent's job's, where `IMPLEMENT_PRD_DIR` is, with `PREPARE_DIR` and `BUNDLE_DIR` under it, the
> catch-up's, `CATCH_UP_DIR`, and the gate's, `GATE_DIR`; `PUBLISH_DIR` is publish's `OUTPUT_DIR`.
> So the mint's reason file, written at `runner.temp`, is never read as a producer's. It is told
> the gate's `refused`, `build`, `finishing`, `prd_branch`, `prd_pr`, `sub` and `failure-reason`
> outputs and result, the catch-up's `head`, `merged` and result, the agent's job's result and its
> `timed-out` output, which that job's last step measures off the gate's clock, the limit as
> `AGENT_TIMEOUT_MINUTES` or 30, and the outcomes of the mint, the agent's download and
> `implement-prd:publish`. It is handed the workflow token as `GH_TOKEN` and the loop's. Nothing of
> the agent's job is read but its artifact and `timed-out`.

## 8. `review`

Trigger label: `agent:review`, on a pull request. `doctor` checks that the label exists.

Reviews a pull request and writes everything a posting step needs; it posts nothing itself.
Preconditions: the pull request's head checked out as `BRANCH`, and its base, `BASE_REF`, fetched
so the diff matches GitHub's.

**When the verdict asks for a fix round.** On *changes recommended*, where `AUTO_FIX` is `true` and
the fix round this review follows closed at least one of its findings, or it follows none. Except on
a PRD PR when the earlier rounds could not be read (#442): the review then carries no round header,
and `review:budget` counts a status there by the header of the review it links, so a round started
from it would make every later count on the PR unreadable. That review asks for none, says under
*How this was checked* that none was started and why, warns in the log, and hands `review:advance`
the park reason `unnumbered`, so the park comment gives that reason rather than the budget or the
token; the way on is
`agent:fix` by hand. The line is the same either way. Off a PRD PR the budget counts every status,
so a review asks with or without a header.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. |
| `AGENT_MODEL_REVIEW` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_SANDBOX` | optional | `none` | Accepts `none` or `bwrap`: the agent's sandbox (§2.2, §3). Any other value fails the run, naming it. |
| `AGENT_SANDBOX_RO_BINDS` | optional | `""` | Read-only binds for `bwrap` (§2.2). |
| `AGENT_SANDBOX_PATH` | optional | `/usr/local/bin:/usr/bin:/bin` | `PATH` inside `bwrap` (§2.2). |
| `AGENT_SANDBOX_PROXY` | optional | `""` | The proxy for `bwrap`, required with it (§2.2). |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch. |
| `BASE_REF` | required | | Its base branch, which the diff is taken against. |
| `ROUND` | optional | `""` | Accepts `slice` or `final`: `slice` on a PRD PR's slice round, `final` on its final review. Unset or empty is an ordinary pull request, and any other value fails the run, naming it (#377). |
| `CI_STATUS_FILE` | optional | `""` | A file of the other checks' results, as evidence for the agent. Empty is "not collected". |
| `CI_RESULT_FILE` | optional | `""` | A file holding `green` or `red`. Empty, unreadable or anything else is unknown, which no approval is given on. |
| `AUTO_FIX` | optional | `false` | Accepts `true` or `false`: `true` where the orchestrator will start a fix round itself on a verdict asking for one, `false` where it will not. Unset or empty is `false`, and any other value fails the run, naming it. |
| `FIX_ROUNDS_SPENT` | optional | `""` | The fix rounds this pull request has spent, or on a PRD PR this round, for the verdict's line. |
| `FIX_ROUND_BUDGET` | optional | `""` | The budget, for the same line. Both have to be numbers for it to be written. |
| `RED_CHECK_CONFIGURED` | optional | `""` | `true` where the red check is configured. |
| `RED_CHECK_FILE` | optional | `""` | The red check's report. |

### Outputs

| Output | When it is written |
|---|---|
| `findings.json` | The findings to open a thread for: where each goes, its severity and title, the agent's text, and whether an earlier review had read its code. |
| `review_body.json` | What the body is written from: the verdict, the agent's assessment, the record's entries, the criteria and, except on a PRD PR's final review, why there are none where there are none (`criteria found`, `none in the issue`, `no linked issue` or `untrusted issue`), where criteria were handed what merged since the brief (#541: the commits since its read-at commit that touched the files it names, or why the check could not run) with the review's ruling, what the review's own test run left unrun (#543: whether it ran tests, and each test or suite exercising the change it skipped for want of something in the environment, with the reason, at most 20 and how many more; absent where the review did not say), the follow-ups, on a PRD PR the carried follow-ups this review ruled resolved, each with its reason, and the ids of every one ruled resolved on the pull request so far (#495), both absent where there are none, and the data behind the header, the round note and the red tests, and, where a PRD PR's review with no header asked for no round it would have, that it withheld one (`unnumbered`). |
| `thread_resolutions.json` | The earlier findings this review verified: each thread, why it closes, and the agent's note or the maintainer's reply to quote. Written on every run. |
| `verdict.json` | The verdict's key, whether it starts a fix round, how many findings it leaves open, and, on *changes recommended* with no round, which of #200's stops kept it from asking for one (`budget spent` or `no progress`), where one did. |
| `pr_summary.json` | Signals by existing: the title, the agent's summary, whether the round is final, and the data behind the Evidence and the Merge Danger. |
| `park.json` | On a PRD PR: the round, the findings open before this review and, once it has ruled, its verdict, why its round parks where it does, and the findings it leaves open. Written before the work, and again once the review has ruled. |
| `progress.json` | On a PRD PR whose branch could be read: the sub-issues, the slice ranges, whether the final review is requested, the rounds so far and the findings left open, which the progress list and status line are rendered from. Written with `park.json`. |

None of these files holds a marker, a status context or a commit: they carry decisions and raw
text, and `review:publish` and `review:advance` write every final string from them.

**`doctor` cannot check this.** These tables are the runner's, for the reason §6 gives.

### What it reads from the record

- Its own head, `BRANCH`, against `agent/prd-<parent>-<slug>`: a match is a PRD PR, and the slice
  round is read from the branch's `Agent-Slice` and `Agent-Catch-Up` trailers.
- The rounds so far, for its header: the reviews headed `## Agent review` and their round headers,
  and the `agent:fix` label events.
- The `agent-review` and `agent-fix-round` statuses on the pull request's commits, for what changed
  since the last verdict.
- The open and settled findings: `agent-finding` markers on the loop's threads,
  and `agent-resolution` on the loop's closing replies.
- The fix's `agent-fix:out-of-scope` notes, posted since the last review, to rule on.
- Earlier reviews' `agent-follow-ups`, `agent-red-tests` and acceptance criteria groups. On a PRD
  PR the agent is shown each follow-up an earlier round recorded, less those any round ruled
  resolved, with its id, and rules on each (#495): `open`, or `resolved` with a reason. One ruled
  resolved is left out of this review's follow-ups; every other stays, an unruled one and one with
  no id included.
- The pull request body's `agent:summary` block, and its `Closes #<n>` line.
- The feedback threads, the linked issue and its comments, through `isTrustedAuthor`, with the
  fix's own comments (`agent-fix:top-level`, `agent-fix:conversation-outcomes`) left out.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the review job starts with `review:gate`, before its checkout, and runs
> the rest only where it went ahead, on the commit it settled on, handing the runner its round.
> Right after the checkout and the base fetch, `review:budget` counts the fix rounds this round has
> spent and hands the runner the budget, the rounds spent and whether a round starts. Before the runner, `review:collect-checks` waits up to 15 minutes for the pull
> request's other checks and writes the files the runner reads as `CI_STATUS_FILE` and
> `CI_RESULT_FILE`. Where the red check is configured, a separate job runs
> `review:red-check-place`, the adopter's install and test command, and `review:red-check-classify`,
> whose report the runner reads as `RED_CHECK_FILE`. A posting job then mints the loop's token,
> sets up Node, downloads the hand-over, and runs `review:publish`, which answers and resolves the verified threads, posts the
> review, marks the pull request with `agent:follow-ups`, writes the title, the summary and the
> status line, and posts the verdict. `review:conclude` then ends the run however it ended: the
> refusal's note, or the error verdict and the failure comment, or the ready mark and, where a
> review recommending changes asked for no round because of a stop or a count that could not be
> read, a top-level comment saying no automatic fix round is starting, why, and the ways on;
> `agent:review` off; and the hand-off, `agent:review` again where the head moved, else `agent:fix` where the
> review asked for a fix round. A glue step copies its `ended.json` into the job's outputs, and the
> job keeps both commands' write logs as one artifact. On a PRD PR an advance job follows, which
> sets up Node, mints the loop's token, downloads the runner's park hand-over and runs
> `review:advance`: the progress list for how the round ended, then `agent:implement` back on the
> PRD's parent on a slice round's approval, or the park comment there on any ending but an approval
> or a fix round starting.

> **Service orchestrator:** the worker runs the review job's and the posting job's subcommands, in
> the order and under the conditions above, each a child process with a fresh `OUTPUT_DIR` of its
> own and an environment built from its declaration, and writes nothing to the record itself. It
> asks the dispatcher for a `read` token and runs `review:gate` with the head commit, state and
> merged flag the label's event carried, and the repository's variables. Where the gate went ahead
> it checks out the settled commit as `BRANCH`, fetches `BASE_REF` and the repository's tags, the token passed with each
> fetch and never stored in the checkout, then runs `review:budget` and `review:collect-checks`,
> and the runner, in the sandbox its settings name, with a fresh `read` token as `GH_TOKEN`. Where the
> review finished it asks for a `resolve` token, `write`'s permissions with Contents: write, without
> which a thread on a pull request the App did not open cannot be resolved, and runs
> `review:publish` with it, pointed at the runner's directory; where that is refused, a `write`
> token, so the review posts and the threads it found fixed stay open, listed as still open. Then
> `review:conclude`, however the run ended, pointed at publish's directory, with a `write` token,
> publish's where it fell back to one, and `LOOP_TOKEN_SOURCE` `app`. On a PRD pull request, where the gate went ahead
> and conclude's `ended.json` says the head did not move, it then asks for a `write` token of
> advance's own and runs `review:advance`, pointed at the runner's directory for `park.json` and
> `progress.json`, and told how the review ended (`REVIEW_RESULT`), how the posting ended
> (`POSTING_RESULT`: `failure` where the posting token's mint, publish or conclude failed,
> `cancelled` where publish or conclude was ended at its limit, else `success`), and
> conclude's `moved` and review URL. The dispatcher refuses a fork, so every job is from the
> repository itself. Each command gets its token as both `GH_TOKEN` and,
> where it declares one, `LOOP_TOKEN`. Where `review.yml` passes something the service does not
> have, it passes the nearest equivalent:
>
> - **`SELF_CHECK` is `review`.** The service has no check of its own on the pull request to leave
>   out, so it names the review job's id, which the command leaves out already.
> - **No run link.** There is no Actions run, so `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY` and
>   `GITHUB_RUN_ID` are unset, and so is `SELF_RUN_ID`.
> - **The download is a success** wherever the review finished: the hand-over is on the worker's
>   disk, and there is nothing to fetch.
> - **The time limits are the jobs'.** The gate, the checkout, the budget, the CI wait and the
>   runner share the review's time limit, the CI wait plus `AGENT_REVIEW_TIMEOUT_MINUTES`, as the
>   review job's `timeout-minutes` does, and `review:publish` and `review:conclude` get the posting
>   job's 10 minutes each, and `review:advance` the advance job's 5. A phase still running at its
>   limit is ended with every process it started. One of the review's is then `REVIEW_RESULT`
>   `cancelled` with `TIMED_OUT` `true` and `TIMEOUT_MINUTES` the limit, which conclude says as a
>   timeout; a publish ended so is `PUBLISH_OUTCOME` `cancelled`.
> - **The failures are the reusable's.** Conclude runs however the phases before it ended and is
>   told each one's real outcome: a runner that failed is `REVIEW_RESULT` `failure` with the
>   `FAILURE_REASON` its `failure_reason.txt` gave; a `read` token not granted is a review that
>   failed, saying so; neither a `resolve` nor a `write` token granted for publish is `MINT_OUTCOME` `failure`; a
>   publish that failed is `PUBLISH_OUTCOME` `failure`. Where no token is granted to conclude
>   either, nothing can write to the pull request, and the worker's log says why the run ended.
> - **Each run leaves a directory**: the checkout, each subcommand's output directory and log, and
>   a summary of the job, each phase's outcome and each subcommand's environment, with every token
>   redacted.
>
> Not run: the red check, so `RED_CHECK_CONFIGURED` is unset; the repository's own install and
> setup commands, so the agent reviews a checkout without its dependencies.

### `review:gate`

Decides, before anything is checked out, whether the review runs, which commit it reviews, the
fix-round budget, and what kind of round it is. It runs no model and needs no checkout, and it writes nothing to the record:
what it decided is handed on, and the posting step says it. In order:

- **The pre-flight.** A pull request whose `PR_STATE` is not `open`, or that is `PR_MERGED`, is
  refused with `This PR is closed.`, and not blocked. Otherwise the commit is settled. `BRANCH`'s
  tip is read from the repository's refs, which move the moment a push lands, since the pull
  request's head moves asynchronously after one: a tip that is `HEAD_SHA` is reviewed; a tip that
  descends from it is reviewed once the pull request shows it as its head, waiting up to
  `HEAD_WAIT_SECONDS`; a tip that does not descend from it, whose ancestry cannot be read, or that
  the pull request never shows, is refused, blocked, with one sentence for all three. A tip that
  cannot be read proceeds on `HEAD_SHA`, with a warning.
- **The time limit.** A `REVIEW_TIMEOUT_MINUTES` that is set and is not a positive integer is
  refused, naming the variable.
- **The fix-round budget.** `MAX_FIX_ROUNDS`, 3 where unset, and a value that is not a whole
  number is refused, naming it. The rounds spent against it are `review:budget`'s, after the
  checkout.
- **The round.** On a PRD branch only: `final` where the pull request's body carries the final
  review's mark, else `slice`. A body that cannot be read fails the command.

A refusal of the pre-flight's is a decision, and the command succeeds. A variable it refuses is
written to `refusal_reason.txt` and the command fails, so the run ends as one that didn't run.
`gate.json` is written however the command ends, with what was decided by then.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch, whose tip is read, and which tells a PRD PR. |
| `HEAD_SHA` | required | | The head the request to review named. |
| `PR_STATE` | required | | The pull request's state as the request saw it: `open` or `closed`. |
| `PR_MERGED` | optional | `""` | `true` where the request saw it merged. |
| `HEAD_WAIT_SECONDS` | optional | `"60"` | How long the pull request gets to show a tip that moved on as its head. |
| `HEAD_POLL_SECONDS` | optional | `"5"` | How often it is asked meanwhile. |
| `REVIEW_TIMEOUT_MINUTES` | optional | `""` | The review's own time limit, as configured; empty is the default. |
| `MAX_FIX_ROUNDS` | optional | `""` | The fix-round budget, as configured; empty is 3. |

#### Outputs

| Output | When it is written |
|---|---|
| `gate.json` | Always. Its decisions, every value a string: `proceed`, and `refusal` and `blocked` where it refused; `sha`, the commit to review; `budget`; and `round` on a PRD PR. A name not yet decided when it ended is absent. |
| `refusal_reason.txt` | Where it refuses a variable: the sentence, before it fails. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `BRANCH`'s tip, and how it relates to `HEAD_SHA`.
- The pull request `PR_NUMBER` names, for its head while it waits and, on a PRD branch, for the
  final review's mark in its body.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the review job's first work, after its clock and a Node set up for it,
> since nothing is checked out yet. `HEAD_SHA`, `PR_STATE` and `PR_MERGED` are the label's event's;
> the budget and the time limit are the caller's repository variables. `OUTPUT_DIR` is
> `runner.temp`, where the job's outcome step reads `refusal_reason.txt`. A glue step copies
> `gate.json` into step outputs under its own names, `always()`, which the later steps' `if:`s,
> `review:budget`, the runner and the posting job read; `review:conclude` says the refusal.

### `review:budget`

Counts the automatic fix rounds already spent against `FIX_ROUND_BUDGET`, and decides whether a
review that recommends changes starts another. It runs no model and writes nothing to the record.
It needs the checkout on a PRD branch, with `BASE_REF` a local ref, since which slice is current is
read off the branch's history.

- **The rounds spent** are the loop's own `agent-fix-round` statuses on the pull request's commits
  (§4.1), counted once per link, since a status copied on to a merge commit is not a second round.
- **Off a PRD PR** every one counts, the pull request's whole budget, and a status with no link
  counts on its own.
- **On a PRD PR** the budget is the round's (#331): each slice round has its own, and the final
  review has its own. A status counts toward the round its linked review's header names (§4.3),
  never by the commit it stands on: in a slice round, a review headed with the current slice's
  sub-issue, the last slice with an `Agent-Slice` trailer; in the final review (`ROUND` `final`), a
  review headed as the final review. A status with no link, a link to no review on the pull request,
  or a linked review with no round header makes the count unreadable, as does a branch whose
  current slice cannot be told. A review that could not number itself posts no status there (§8),
  so it costs no round and leaves the count readable.
- **The decision.** A round starts where fewer are spent than the budget and `LOOP_TOKEN_SOURCE` is
  `app` or `pat`. A count that cannot be read starts none and warns, and is never read as none spent.
  A budget of 0 counts nothing.

A `FIX_ROUND_BUDGET` that is not a whole number fails the command. `budget.json` is written however
the command ends, with what was decided by then.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch, which tells a PRD PR and names its parent. |
| `BASE_REF` | required | | Its base branch, a local ref, which the PRD branch's history is read against. |
| `ROUND` | optional | `""` | Accepts `slice` or `final`, as `review:gate` decided it. Unset or empty off a PRD PR. |
| `FIX_ROUND_BUDGET` | required | | The fix-round budget `review:gate` settled, a whole number. |
| `LOOP_TOKEN_SOURCE` | optional | `""` | Where the loop's token will come from: `app`, `pat` or `workflow`. No round starts on anything but the first two. |

#### Outputs

| Output | When it is written |
|---|---|
| `budget.json` | Always. Its decisions, every value a string: `budget`, `spent` (empty where it could not be counted) and `start`. A name not yet decided when it ended is absent. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The statuses on the pull request's commits, for the loop's own `agent-fix-round`, counting only
  the loop's own (§4.1).
- On a PRD PR, the reviews those statuses link to, for their round headers, and the PRD branch's
  `Agent-Slice` and `Agent-Catch-Up` trailers and its parent's sub-issues, for the current slice.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** a step of the review job right after the checkout and the base fetch,
> where the gate went ahead, and before the adopter's toolchain, the CI wait and the runner, with
> the job's read-only token. `FIX_ROUND_BUDGET` and `ROUND` are the gate's, and
> `LOOP_TOKEN_SOURCE` is the `time-limit` job's choice, made where no agent runs. `OUTPUT_DIR` is
> `runner.temp`, where the job's outcome step reads a reason it fails with. A glue step copies
> `budget.json` into step outputs, which the runner reads as `FIX_ROUND_BUDGET`,
> `FIX_ROUNDS_SPENT` and `AUTO_FIX`.

### `review:collect-checks`

Waits for the pull request's other checks on `REVIEWED_SHA`, then writes their results for the
runner: evidence for the agent, and one word the verdict's CI half is derived from. It runs no
model, needs no checkout, and writes nothing to the record.

It reads three surfaces, because each sees what the others cannot: the commit's check runs, its
commit statuses (the latest per context), and its workflow runs, the only place a run that is
queued or waiting for approval shows. The loop's own are left out of all three, as
`shared/loop-checks.ts` knows them, the one copy `merge:gate` reads too: a check run named
`SELF_CHECK`, or whose name either side of ` / ` is one of the loop's job ids, the `merge / merge`
job among them, since a review waiting on a merge gate that waits for that review's verdict would
hold both; the `agent-review` and `agent-merge` statuses, the loop's answers rather than CI; and the
run `SELF_RUN_ID`, a run whose workflow is named `Agent …`, or one that calls the loop's reusable
workflows.

- **The wait.** Up to 15 minutes, ending as soon as nothing it can see is pending: no check run
  unfinished (one waiting on an environment's reviewers aside), no status `pending`, and no
  workflow run unfinished (one waiting for approval aside, since it cannot start until a human
  acts). Where nothing has reported at all, it keeps looking for up to a minute, since a run is
  created a moment after the push that starts it. A check-run read that fails ends the wait at
  once.
- **The word.** Each surface is `none`, `red` where something completed without passing,
  `unknown` where something is unfinished, waiting for approval or could not be read, else
  `green`. `none` on all three is green, and the evidence says no CI ran. `red` on any beats
  `unknown`, and `green` needs all three.
- **The evidence.** Each check run with its conclusion or status, the workflow runs that did not
  pass and those waiting for approval with their links, the ceiling where it was reached, and the
  end of each failed run's failing jobs' logs. Each surface that could not be read is said.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `REVIEWED_SHA` | required | | The commit `review:gate` settled. |
| `SELF_CHECK` | required | | The name of the check run the job it runs in appears under, which is not CI. |
| `SELF_RUN_ID` | optional | `""` | The workflow run it runs in, which is not CI. Empty is none. |

#### Outputs

| Output | When it is written |
|---|---|
| `ci_status.md` | Unless it fails: the other checks' results, as evidence for the agent. |
| `ci_result.txt` | Unless it fails: `green`, `red` or `unknown`. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The `agent-review` status on `REVIEWED_SHA`, only to leave it out: it is the verdict this review
  has not posted yet. The `agent-merge` status the same way: it is the merge arm, not CI.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** a step of the review job after the adopter's installs, where the gate
> went ahead, with `REVIEWED_SHA` from the gate, `SELF_CHECK` the caller's `self-check` input and
> `SELF_RUN_ID` the caller's run. `continue-on-error`, so it never fails the review: a command that
> wrote nothing leaves the runner reading the checks as unknown. `OUTPUT_DIR` is a directory of its
> own under `runner.temp`, and the runner reads its two files from there as `CI_STATUS_FILE` and
> `CI_RESULT_FILE`. The `time-limit` job adds its 15 minutes to the review's own.

### `review:red-check-place`

Puts the test files a pull request adds or changes over the code as it was before the change, in
the pull request's checkout, so the red check's tests run against it. It runs no model, reads no
repository, holds no token, and writes nothing to the record. Each outcome below is a placement,
written to `place.json`, and only a failure of git itself fails the command.

- **Misconfigured.** An empty `REPORT_PATH` or `TEST_GLOBS` (whitespace only) is `misconfigured`,
  with a reason naming the caller's input that is missing.
- **The final review.** On a PRD branch whose `PR_BODY` carries the final review's mark, nothing is
  placed: `final-review`.
- **The base.** The merge-base of the checkout's `HEAD` and `origin/<BASE_REF>`, or
  `no-merge-base` where there is none. On a PRD branch, the first parent of the earliest
  first-parent commit of the slice started last, by the `Agent-Slice` trailer, since `BASE_REF`; a
  PRD branch with no trailered commit keeps the merge-base, with a warning.
- **The files.** `TEST_GLOBS` is one `:(glob)` pathspec a line. The non-test files changed between
  the base and the head, deleted ones included, are its `source`. The test files added or changed,
  renames split, are put over the base, the base checked out detached and each file taken from the
  head as a literal path; none is `no-test-files`, and some is `ready`. A name with a line break is
  dropped from both lists.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The pull request's checkout, at its head, with `origin/<BASE_REF>` fetched. |
| `BRANCH` | required | | Its head branch, which tells a PRD PR. |
| `BASE_REF` | required | | Its base branch. |
| `PR_BODY` | optional | `""` | Its body, as the request saw it, for the final review's mark. |
| `REPORT_PATH` | optional | `""` | Where the test command writes its JUnit report. Empty is `misconfigured`. |
| `TEST_GLOBS` | optional | `""` | Which files are tests, one glob a line. Empty is `misconfigured`. |

#### Outputs

| Output | When it is written |
|---|---|
| `place.json` | Unless it fails: `status`, `ready`, `no-test-files`, `misconfigured`, `final-review` or `no-merge-base`; `reason` where it is one; `head`; `base` and `slice` where they were found; `files`, the test files placed, which the test command is handed; and `source` where `base` was found. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The final review's mark in `PR_BODY`, on a PRD branch.
- The `Agent-Slice` trailers on the PRD branch's first-parent commits since `BASE_REF`.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the `red-check` job, where `red-check-command` is set, after a checkout
> that persists no credential. That job runs the pull request's code, so it holds no secret, and
> the package is installed before any of that code runs, by the one step handed the registry
> token, `npm install --prefix "$RUNNER_TEMP"`. This command and `review:red-check-classify` run
> from `RUNNER_TEMP`, where `npm exec` finds that install without asking the registry, and neither
> is handed a token. `CHECKOUT` is the workspace, `BRANCH` and `PR_BODY` the label's event's, and
> `REPORT_PATH` and `TEST_GLOBS` the caller's `red-check-report` and `red-check-test-globs`. A glue
> step copies `place.json`'s `status` into a step output, which gates the adopter's toolchain,
> their `setup` and their `red-check-command`, handed the files as `RED_CHECK_FILES`.

### `review:red-check-classify`

Writes the red check's report, `red_check.json`, whatever happened before it, so the review can
tell "no red test" from "the check did not run". It runs no model, reads no repository, holds no
token, and writes nothing to the record. The report is what `review`'s `RED_CHECK_FILE` reads:
`status`, `base`, `head` (each `null` where unknown), `files`, `exitCode`, `tests` and `skipped`,
with `reason`, `slice` and `source` where `review:red-check-place` gave them.

- **The status.** `place.json`'s, or `failed` where there is none. Where it is `ready`:
  `setup-failed` where `SETUP_OUTCOME` is `failure`, `not-run` where `EXIT_CODE` is not a number,
  `no-report` where `REPORT_PATH` is not a file, `unreadable-report`, with the parser's reason,
  where it is not well-formed XML or its declaration names an encoding other than UTF-8, else `ran`.
- **Each test.** Each `testcase` of every element of the JUnit report: an `<error>` is `broken`; a
  `<failure>` is `red`, unless the testcase is a file or a `describe` rather than a test (named as
  its classname and its suite are, or, with every testcase after it, a failure named like a
  `describe` the others are named under), which is `broken`; a `<skipped>` is counted and left
  out; anything else is `passed`. A failure's or an error's `message`, or else its body's first
  line, is kept, cut at 2,000 characters. A test reported twice under one name, classname and file
  is one test, with the worse result.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The pull request's checkout, which `REPORT_PATH` is relative to. |
| `REPORT_PATH` | optional | `""` | Where the test command wrote its JUnit report. |
| `SETUP_OUTCOME` | optional | `""` | The outcome of the adopter's install step, empty where it did not run. |
| `EXIT_CODE` | optional | `""` | The test command's exit code, empty where it did not run. |
| `PLACE_DIR` | directory | | `review:red-check-place`'s `OUTPUT_DIR`. Reads `place.json` (where written). |

#### Outputs

| Output | When it is written |
|---|---|
| `red_check.json` | Unless it fails: the report. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

Nothing. Its inputs are the checkout and what `review:red-check-place` wrote.

> **Actions orchestrator:** the `red-check` job's step after the adopter's test command,
> `always()`, from the install `review:red-check-place` used and with no token, since the pull
> request's code has run and could have changed anything on the runner. An install that code
> removed fails the step, which leaves no report, and the review reads that as unreadable, never
> as "no red tests". `OUTPUT_DIR` is `runner.temp`, and the job uploads `red_check.json` as the
> `agent-red-check` artifact, `always()`, which the review job downloads.

### `review:publish`

Resolves the threads a review closed and posts the review, then writes the pull request's title,
summary and status line and posts the verdict, from the runner's hand-over, which it reads and
checks in full before its first write. It runs no model, so it needs no `claude` and no checkout.
It writes every final string itself: the body and its groups, each thread's body, the two closing
replies, the summary block with its Evidence and Merge Danger, the status line and every marker in
them, holding the body to GitHub's limit and shedding in a fixed order down to cutting
out-of-scope follow-ups. Each commit status's context, state and description are its own, chosen
by the verdict's key and cause, never read from the hand-over. The pull request's node id is read
from the pull request `PR_NUMBER` names, and every thread id in the hand-over has to be a review
thread on it, the verdict and the fix-round claim are read strictly into their fixed sets, and
`verdict.json` has to name the verdict `review_body.json` does, or nothing is written.

The order: every reply and resolve first, a thread that will not resolve tolerated and listed in
the body as still open; then the review, on `REVIEWED_SHA`, its *Resolved since last review* naming
only the threads that resolved; then `agent:follow-ups`, only where follow-ups survive the body's
shedding; then, where `pr_summary.json` is there, the title and the summary block, spliced against
the body as it stands, headed by `REVIEWED_SHA` (a body with half a block, or two, gets the title
alone, and the final review's write drops the draft-only note); then, off a PRD PR, the status
line, between its markers and nowhere else; then the `agent-review` status on `REVIEWED_SHA`,
linking the review, and `agent-fix-round` beside it where the review claimed a fix round, never on a
PRD PR for a review with no round header, which the budget could not count (#442: a warning says
so). The
title, summary, status line and statuses are tolerated: one GitHub refuses is a warning, since a
posted review is worth more than any of them. A server error on the review (a 5xx, or GraphQL's "An internal error occurred") is read
back before it is taken as "not posted": a review on `REVIEWED_SHA` with the posted body is this
run's, and the command goes on with its URL.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | required | | The token whose writes start the loop's next workflow. |
| `LOOP_TOKEN_SOURCE` | required | | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | The pull request's head branch. A PRD branch's pull request gets no status line here: it is the advance's. |
| `REVIEWED_SHA` | required | | The commit the review read, recorded before the agent ran; the review and the verdict are posted on it. |
| `REVIEW_DIR` | directory | | The `review` runner's `OUTPUT_DIR`. Reads `findings.json`, `review_body.json`, `thread_resolutions.json`, `pr_summary.json` (where written) and `verdict.json`. |
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the link to the run the body ends with. Empty renders none. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

#### Outputs

| Output | When it is written |
|---|---|
| `published.json` | The posted review's URL, `reviewUrl`, written the moment the review is posted, and `header`, its round header's scope and number, where the review has one. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended. A write's line lists its GitHub calls, each `<call> ok`, `<call> expected: <reason>` for a refusal the write accepts (`label not present`), or `<call> <status> <reason>` with GitHub's own `message`; a `failed` or `partial` write also keeps GitHub's answer, capped, as `response`. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The pull request `PR_NUMBER` names, for its node id, and its review threads, for the ids the
  hand-over may name.
- The pull request's title and body as they stand when it writes them, for the summary block, the
  draft-only note and the status line it splices.
- On a server error posting the review, the pull request's reviews, for one on `REVIEWED_SHA` with
  the body it posted.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the posting job's mint runs first, so the command holds the loop's
> token; it is the one step handed both tokens, the workflow's as `GH_TOKEN`. `REVIEWED_SHA` is the review job's `sha`
> output, `BRANCH` is the head the event names, `REVIEW_DIR` is where the review's artifact is downloaded, and `OUTPUT_DIR` is a
> directory of its own under `runner.temp`, whose `published.json` and `failure_reason.txt`
> `review:conclude` reads. A failure is commented on the pull request, with `agent:blocked`, by
> `review:conclude`.

### `review:conclude`

Ends every review run, success included, in the loop's one order: every result posted, then
`agent:review` off, then the label that names the next step. It runs no model and needs no
checkout. It is told how the run went rather than reading it off which steps ran: the review's
result and outputs, and the outcome of each step the orchestrator ran before it, and it works out
the ending from them. Each is one of:

- **A refusal** (`PROCEED` is `false`): the comment `` **`agent:review` didn't run:** `` and
  `REFUSAL`, then `agent:review` off, then `agent:blocked` where `BLOCKED` is `true`.
- **A review cancelled before deciding** (`PROCEED` is neither, and `REVIEW_RESULT` is not
  `failure`): `agent:review` off, and nothing else, since nothing is known to say. One that
  *failed* before deciding, as a gate whose package would not install does, is a run that did not
  finish, below, with no verdict, since no commit was settled.
- **A run that did not finish**, the review's or the posting's: the `agent-review` status `error`
  on `REVIEWED_SHA`, then the failure comment, then `agent:review` off, then `agent:blocked`. The
  comment's reason is, in order: the time limit or a cancel where the review was cancelled; the
  review's refusal or failure reason where it failed; and where the review finished, the first of
  the mint, the download and publish that did not succeed: a fixed sentence for the mint and the
  download, publish's `failure_reason.txt`, or a cancel where that step was cancelled or skipped.
- **A posted review**: `agent:blocked` off; the ready mark, unless a fix round is about to start,
  and on a PRD PR only on the final review's approval; the stop comment, below; `agent:review` off; then, where the pull
  request is open and its head has moved on from `REVIEWED_SHA`, `agent:review` again with the
  loop's token, or a comment saying it was not asked for where `LOOP_TOKEN_SOURCE` is neither `app`
  nor `pat`, or nothing where another trigger label is on. Otherwise, on *changes recommended*
  with `FIX_ROUND` `true`, `agent:fix`, removed and added with the loop's token, unless it is
  already on, a newer `agent-review` verdict than this review's stands on the head, or the head
  lacks this review's `agent-fix-round` status. A round that does not start where it should is said
  on the pull request, which is marked ready off a PRD PR, and the command fails. Otherwise, on
  *approval recommended* (on a PRD PR, the final review's only), where the pull request is open and
  carries `agent:merge` and no other trigger label, `agent:merge` removed and added again with the
  loop's token, so the merge gate rules on the approval (#589); a warning instead where
  `LOOP_TOKEN_SOURCE` is neither `app` nor `pat`. The fix round and this never both happen.

**The stop comment** (#425): on *changes recommended* with `FIX_ROUND` not `true`, a top-level
comment saying no automatic fix round is starting, opening with the review's round header from
`published.json` where there is one. Its reason is `STOP` where set: `no progress`, the last fix
round closed none of the findings it was given; or `budget spent`, the automatic fix rounds are
spent, the pull request's, or on a PRD PR the slice's or the final review's, with
`FIX_ROUNDS_SPENT` of `FIX_ROUND_BUDGET`. With no `STOP`, a budget above 0, an empty
`FIX_ROUNDS_SPENT` and `LOOP_TOKEN_SOURCE` `app` or `pat`, it says the rounds already spent could
not be counted. Then the ways on: `agent:fix` for another round; reply to a finding to decline it,
then `agent:review`; and for a spent budget, raise `AGENT_MAX_FIX_ROUNDS`. Nothing on a budget of
0, and nothing with neither the App nor `AGENT_PAT` and no `STOP`: no automatic round was possible.
It carries no marker. It is posted whether or not the head moved, and on a PRD PR it adds to the
park comment `review:advance` posts on the parent.

Every write but the last case's fix round is tolerated: one GitHub refuses is a warning, so a run
that cannot comment still takes its label off. The labels a run fires on (`agent:review` again,
`agent:fix`, `agent:merge` again) and the ready mark are made with `LOOP_TOKEN`; everything else
with `GH_TOKEN`.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | optional | `""` | The token whose writes start the loop's next workflow. Empty where it was not minted, which is one of the endings this reports. |
| `LOOP_TOKEN_SOURCE` | optional | `""` | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch, which tells a PRD PR. |
| `REVIEW_RESULT` | required | | How the review ended: `success`, `failure` or `cancelled`. |
| `PROCEED` | optional | `""` | `true` where the pre-flight let the review go ahead, `false` where it refused. |
| `REFUSAL` | optional | `""` | The pre-flight's refusal, where it refused. |
| `BLOCKED` | optional | `""` | `true` where the refusal needs a maintainer, and adds `agent:blocked`. |
| `REVIEWED_SHA` | optional | `""` | The commit the review read; the error verdict goes on it, and a head that is not it has moved. |
| `VERDICT` | optional | `""` | The verdict's key. |
| `FIX_ROUND` | optional | `""` | `true` where the review asked for an automatic fix round. |
| `ROUND` | optional | `""` | Accepts `slice` or `final`: `final` on a PRD PR's final review, `slice` on a slice round. Unset or empty is an ordinary pull request, and any other value fails the run, naming it (#377). |
| `FAILURE_REASON` | optional | `""` | The reason a failed review gave. |
| `REFUSAL_REASON` | optional | `""` | A variable the review refused before reviewing anything. |
| `TIMED_OUT` | optional | `""` | `true` where a cancelled review ran its whole limit. |
| `TIMEOUT_MINUTES` | optional | `""` | That limit, for the comment. |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting `LOOP_TOKEN`: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `DOWNLOAD_OUTCOME` | optional | `""` | The same, for fetching the review's hand-over. |
| `PUBLISH_OUTCOME` | optional | `""` | The same, for `review:publish`. |
| `STOP` | optional | `""` | Accepts `budget spent` or `no progress`: the stop the review's verdict row records, where a review recommending changes asked for no round because of one. Empty is none. |
| `FIX_ROUND_BUDGET` | optional | `""` | The fix-round budget `review:budget` decided from, for the stop comment. |
| `FIX_ROUNDS_SPENT` | optional | `""` | The rounds `review:budget` counted as spent, empty where it could not count them. |
| `PUBLISH_DIR` | directory | | `review:publish`'s `OUTPUT_DIR`. Reads `published.json` (where written) and `failure_reason.txt` (where written). |
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the link to the run the failure comment and the error verdict name. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

#### Outputs

| Output | When it is written |
|---|---|
| `ended.json` | `moved`, whether the head moved while the review ran, and `reviewUrl`, the posted review's, where there is one. Written before the fix round's hand-off, so a round that does not start still has it. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended. A write's line lists its GitHub calls, each `<call> ok`, `<call> expected: <reason>` for a refusal the write accepts (`label not present`), or `<call> <status> <reason>` with GitHub's own `message`; a `failed` or `partial` write also keeps GitHub's answer, capped, as `response`. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The pull request `PR_NUMBER` names, once the review is posted, for its state, its head, its
  trigger labels and `agent:merge`.
- Where it would start a fix round, the statuses on that head, for the newest `agent-review` and
  the `agent-fix-round` beside it, counting only the loop's own (§4.1).

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the posting job's step after publish, run `always()`. It is told the
> review job's result and outputs, and the outcomes of the mint, the download and publish, and
> reads publish's directory. `STOP` is the review job's `stop` output, read from `verdict.json`, and
> `FIX_ROUND_BUDGET` and `FIX_ROUNDS_SPENT` its `fix-round-budget` and `fix-rounds-spent`, the
> budget step's `budget` and `spent`. `ended.json` is copied by a glue step into the job's two outputs,
> `moved` and `review-url`, which the advance job reads with the job's result. It fails only on a
> fix round that did not start, so the job's result still means "everything posted".

### `review:advance`

Moves a PRD PR's chain on after a review, or parks it (PRD #222). It runs no model and needs no
checkout. It is told how the review and its posting ended, rather than reading it off which steps
ran, and works out how the round ended: **approved** where both finished and the verdict is
*approval recommended*; **running** where both finished on *changes recommended* with `FIX_ROUND`
`true`; **parked** on every other ending, a run that did not finish included. Where `MOVED` is
`true` it does nothing: the review of the new head decides. Otherwise, in order:

- **The progress list and status line**, rendered from `progress.json` for that ending, linking
  `REVIEW_URL` where a review was posted and the pull request where not, and spliced into the PRD
  PR's live body between their markers with `GH_TOKEN`: a body with no list gets one appended, and
  half a list, or two, is left as it stands. Tolerated: one GitHub refuses is a warning.
- **On a slice round's approval**, `agent:implement` removed from and added to the PRD's parent,
  read off `BRANCH`, with `LOOP_TOKEN`. Where `LOOP_TOKEN_SOURCE` is neither `app` nor `pat`,
  nothing is added, and a comment on the PRD PR says which re-label advances the chain by hand.
  Where `MINT_OUTCOME` is `failure`, the same comment names the mint's failure, and the command
  fails.
- **On a parked ending**, the park comment on the PRD's parent with `LOOP_TOKEN`: the round, why it
  stopped, the open findings and the ways on. For a round that ended, the reason in `park.json` and
  the verdict's next step; for a verdict posted whose posting then failed, that verdict, linked;
  otherwise, that the review did not finish, with the findings open before it. Where the hand-over
  is missing, a comment saying only that the review did not finish. Without the App or the PAT
  the comment goes on the PRD PR, saying where it was meant for; where the mint failed, the same
  with the reason, and the command fails. A comment that cannot be posted fails the command.

A head that is not `agent/prd-<parent>-<slug>`, where the parent is needed, fails the command.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | optional | `""` | The token whose writes start the loop's next workflow, and the one the parent is written with. Empty where it was not minted. |
| `LOOP_TOKEN_SOURCE` | optional | `""` | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `PR_NUMBER` | required | | The PRD PR. |
| `BRANCH` | required | | Its head branch, which names the PRD's parent. |
| `REVIEW_RESULT` | required | | How the review ended: `success`, `failure` or `cancelled`. |
| `POSTING_RESULT` | required | | How the posting ended, the same way. Its `success` means everything was posted. |
| `MOVED` | optional | `""` | `true` where the head moved while the review ran. |
| `REVIEW_URL` | optional | `""` | The posted review, where one was posted. |
| `VERDICT` | optional | `""` | The verdict's key. |
| `FIX_ROUND` | optional | `""` | `true` where the review asked for an automatic fix round. |
| `ROUND` | optional | `""` | Accepts `slice` or `final`: `slice` on a slice round, `final` on the final review. Only a slice round's approval moves the chain on. Unset or empty is an ordinary pull request, and any other value fails the run, naming it (#377). |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting `LOOP_TOKEN`: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `PARK_DIR` | directory | | The `review` runner's `OUTPUT_DIR`. Reads `park.json` (where written) and `progress.json` (where written). |
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the links to the pull request and the run. Empty renders none. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended. A write's line lists its GitHub calls, each `<call> ok`, `<call> expected: <reason>` for a refusal the write accepts (`label not present`), or `<call> <status> <reason>` with GitHub's own `message`; a `failed` or `partial` write also keeps GitHub's answer, capped, as `response`. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- Its head, `BRANCH`, against `agent/prd-<parent>-<slug>`, for the PRD's parent.
- The PRD PR's body, live, for the `agent:progress` and `agent:status` blocks it replaces.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the advance job, after the posting job, on a same-repository PRD PR's
> `agent:review` where the review went ahead and the head did not move. It sets up Node, mints the
> loop's token, downloads the runner's park hand-over and runs this, each of the last two whatever
> the mint did. It is told the review job's and the posting job's results and outputs, and the
> mint's outcome. It holds `pull-requests: write` and `packages: read`.

## 9. `fix`

Trigger label: `agent:fix`, on a pull request. `doctor` checks that the label exists.

Acts on review feedback as commits on the pull request's branch, and writes the replies for a
posting step. Preconditions: the head checked out as `BRANCH` and its base, `BASE_REF`, fetched for
diffing, which the orchestrator prepares, and `RESCUE_BRANCH` fetched to
`refs/rescue/<RESCUE_BRANCH>` where it exists, which `fix:prepare` does.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. |
| `AGENT_MODEL_FIX` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_SANDBOX` | optional | `none` | Accepts `none` or `bwrap`: the agent's sandbox (§2.2, §3). Any other value fails the run, naming it. |
| `AGENT_SANDBOX_RO_BINDS` | optional | `""` | Read-only binds for `bwrap` (§2.2). |
| `AGENT_SANDBOX_PATH` | optional | `/usr/local/bin:/usr/bin:/bin` | `PATH` inside `bwrap` (§2.2). |
| `AGENT_SANDBOX_PROXY` | optional | `""` | The proxy for `bwrap`, required with it (§2.2). |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch. |
| `BASE_REF` | required | | Its base branch. |
| `RESCUE_BRANCH` | required | | Where an earlier fix run on this pull request that stopped left its commits. |

### Outputs

| Output | When it is written |
|---|---|
| `nothing_to_do.txt` | Signals by existing: there was no feedback to act on. |
| `rescue_ignored.json` | Where a rescue branch was found and set aside: the branch, `branch`, and its tip, `movedPast`. |
| `round_header.txt` | Where the rounds could be read: the round header its comments open with, as plain text. |
| `thread_outcomes.json` | Each review thread it was asked about: its id, `threadId`, its `status`, `addressed` or `declined`, and the `reply`. |
| `conversation_outcomes.json` | Each conversation comment it answered: its id, `commentId`, its `status` and the `reply`. No author and no link. |
| `top_level_comments.json` | Top-level comments to post, each its text, `body`, with no marker. |
| `out_of_scope_notes.json` | Notes on findings it judged out of scope, for the next review to rule on: each note's `title`, `body` and `location`, with no marker. |

**`doctor` cannot check this.** These tables are the runner's, for the reason §6 gives.

### What it reads from the record

- The review feedback, through `isTrustedAuthor` (§4.1): the open findings by their
  `agent-finding` markers, less the ones an `agent-resolution` reply closed, with its own earlier
  `agent-fix:top-level` comments and `agent-fix:conversation-outcomes` left out.
- Its own earlier `agent-fix:top-level` comments and `agent-fix:out-of-scope` notes, so as not to
  post one twice.
- Its own head against `agent/prd-<parent>-<slug>`, and on a PRD PR the branch's trailers, for
  which slice the round is in.
- The rounds so far, the way `review` reads them, for its header.
- `refs/rescue/<RESCUE_BRANCH>`, where it exists, to resume from.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** a gate job runs `fix:gate` first, which refuses the run on the pull
> request or claims it and waits while a review is posting; a glue step copies its decision into the
> job's `refused`, which every later job's `if:` reads, and the job's last step starts the agent's
> clock. In the agent's job, after the checkout and the base fetch and before the adopter's
> `setup`, `fix:prepare` fetches the rescue branch, and stops the run where it cannot tell whether
> there is one. Then `fix:bundle` bundles the agent's commits, however the runner ended,
> and in a publish job `fix:publish` pushes the branch, replies to every thread and closes none,
> posts the conversation outcomes, the comments and the notes, then adds `agent:review` where it
> pushed or left a note, or marks the pull request ready where it did neither. On a PRD PR it always
> asks for the review. Then `fix:conclude`, however the run ended, rescues a stopped run's commits
> to `RESCUE_BRANCH` where nothing was pushed, posts the failure comment, and takes `agent:fix`
> off, then adds `agent:blocked` where the run stopped. The publish job holds no shell step that
> writes, and no job runs inline shell that decides.

> **Service orchestrator:** the re-review request is `fix:publish`'s, package code every
> orchestrator runs, as `review:conclude`'s fix round is: an orchestrator that runs the command has
> it. Without it the round ends on the fix, with its findings open.

> **Service orchestrator:** the worker runs the gate job's, the agent's job's and the publish job's
> subcommands, in the order and under the conditions above, each a child process with a fresh
> `OUTPUT_DIR` of its own and an environment built from its declaration, and writes nothing to the
> record itself. It answers an `agent:fix` from a person who can write and from its own App alike,
> since the App adds one only under the budget (ADR 0008). It asks the dispatcher for a `write`
> token and runs `fix:gate` with the head commit, state and merged flag the label's event carried:
> the gate writes, its refusal and its permission probe, as the gate job's token does with
> `pull-requests: write`. A refusal ends the run there, as on Actions it skips the publish job:
> no token is asked for after it, `fix:publish` and `fix:conclude` do not run, and the run's
> summary notes the refusal. An undecided gate is not a refusal, and conclude still runs. Where the
> gate succeeded and claimed the
> run, it asks for a `read` token and checks out the event's head as `BRANCH`, fetching
> `BASE_REF` and the repository's tags, the token passed with each fetch and never stored in the checkout, which keeps only a
> committer, the App's login, as `fix.yml`'s checkout step sets one. Then `fix:prepare`, with the
> same token, which fetches `RESCUE_BRANCH` into the checkout; the repository's setup, `AGENT_SETUP`,
> in the bwrap sandbox with no token; and the runner, in the sandbox its settings name, with a fresh
> `read` token as `GH_TOKEN`. Then `fix:bundle`, however those ended, handed no token. It asks for
> a `push` token, or, where that is refused, a `write` token for conclude, and where the gate
> claimed the run checks the event's head out again, in a directory of its own, with whichever
> was granted, as `fix.yml`'s publish job does. In it, `fix:publish` runs where the agent's job ran
> and the mint and the checkout succeeded, pointed at the runner's and `fix:bundle`'s directories,
> and then `fix:conclude`, however the run ended, pointed at publish's, prepare's, the runner's and
> bundle's. `fix:publish` and `fix:conclude` alone hold `push`, each as
> both `GH_TOKEN` and `LOOP_TOKEN`, with `LOOP_TOKEN_SOURCE` `app`; the runner never holds a token
> that writes. Where `fix.yml` passes something the service does not have, it passes the nearest
> equivalent:
>
> - **The gate's outputs are its files.** `REFUSED` is `false` where `gate.json` says `proceed`
>   `true`, `true` where it says `false`, and empty where there is none; `GATE_REASON` is
>   `fix:gate`'s `failure_reason.txt`.
> - **The time limits are the jobs'.** `fix:gate` gets the gate job's 15 minutes. The checkout,
>   `fix:prepare`, the setup and the runner share the agent's job's, `AGENT_TIMEOUT_MINUTES` (30
>   where unset or not a positive integer), and one still running at it is ended with every
>   process it started: the agent's job is then `cancelled`, with `TIMED_OUT` `true` and
>   `TIMEOUT_MINUTES` the limit, as the *Measure* step says it. `fix:bundle` gets 5 minutes of its
>   own, so a round stopped at its limit still hands its commits over. Publish's checkout and
>   `fix:publish` share the publish job's 15 minutes, and `fix:conclude` gets 15 of its own. The dispatcher's deadline for the job is the agent's
>   limit plus its margin.
> - **A phase not started leaves its reason** where `fix:conclude` reads the next one: a `read`
>   token not granted, or a checkout that failed, as `fix:prepare`'s `failure_reason.txt`; a setup
>   that failed, with its exit status and the end of its output, or a runner's token not granted,
>   as the runner's; a publish checkout that failed as `fix:publish`'s. On Actions a failed setup
>   leaves no reason, and the comment says none was given.
> - **A checkout that fails before publish is publish's failure, on purpose.** Where publish's
>   checkout fails, `fix:publish` does not run, and conclude is told `PUBLISH_OUTCOME` `failure`
>   with the checkout's reason as publish's, or `cancelled` where the checkout ran out of the
>   publish job's time. On Actions the publish step's `if:` opens with `always()`, so it runs after
>   the failed checkout, in an empty workspace, and fails there with a reason that names the
>   missing repository rather than the checkout. The service names the cause instead, as every
>   run function with a checkout before publish does.
> - **No run link, and the download is a success** wherever the agent's job ran: the hand-over is
>   on the worker's disk. `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` are unset.
> - **The mint is the `push` token's.** One not granted is `MINT_OUTCOME` `failure`, and nothing is
>   published; `fix:conclude` is then handed a `write` token, since a second `push` would be refused
>   as the first was, and uses it for its comment and labels alone: told the mint failed, it
>   rescues nothing, so it needs no push. Where none is granted to conclude
>   either, nothing can write to the pull request, and the worker's log says why the run ended.
> - **A checkout per job**, as on Actions: `fix:publish` and `fix:conclude` work in a checkout of
>   the head of their own, never the agent's, so nothing the agent's job touched is where the
>   `push` token is used, and a rescue is checked against the head the round started from.
>
> Not run: `node-version-file`, since the sandbox runs the worker box's own Node, and the session
> transcript's upload.

### `fix:gate`

Refuses or claims the pull request, before anything is checked out and before the agent's job. It
runs no model and needs no checkout. In order:

- **The pre-flight.** A pull request whose `PR_STATE` is not `open`, or that is `PR_MERGED`, is
  refused with `This PR is closed.`, and not blocked. Otherwise `BRANCH`'s tip is read from the
  repository's refs, never from the pull request, whose head can go on naming a commit the branch
  has moved on from. A 404 is a branch that no longer exists, refused and not blocked. Any other
  failure to read it is refused and blocked, **unlike `review:gate`**, which proceeds: this run
  pushes and replies, so "could not tell" is never read as "not stale". A tip that is not
  `HEAD_SHA` is refused and blocked. Each refusal has its own sentence.
- **A refusal** is said in the loop's one order: the comment, `` **`agent:fix` didn't run:** ``
  and the sentence; then `agent:fix` off; then `agent:blocked` where it is blocked. Each of the
  three is tolerated, so a comment that fails still takes the label off.
- **The permission probe.** On a run it claims, it adds `agent:fix`, which the pull request already
  carries, so a token short of the write fails the command before the agent runs. Not tolerated.
- **`agent:blocked` off**, tolerated: re-adding `agent:fix` is the retry after a block.
- **The wait for a review's posting.** While `agent:review` is on the pull request, which a
  review's posting takes off only once every result is posted, it waits, up to
  `POST_WAIT_SECONDS`, asking every `POST_POLL_SECONDS`. Labels it cannot read keep it waiting. At
  the bound it goes on, with a warning.

Every write is made with `GH_TOKEN`: none of them has to start a run. A refusal is a decision, and
the command succeeds. `gate.json` is written the moment the run is refused or claimed, ahead of the
probe and the wait, so a cancel during either still finds it, and again however the command ends, with what was decided by
then, so a run that failed at the probe still says it went ahead. One that died before deciding
writes no `gate.json` where an input could not be read, and `{}`, with no `proceed`, where it
failed after that; the adapter reads either as undecided, an empty `refused`.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch, whose tip is read. |
| `HEAD_SHA` | required | | The head the event that asked for the run named, which the tip has to be. |
| `PR_STATE` | required | | The pull request's state as the event saw it: `open` or `closed`. |
| `PR_MERGED` | optional | `""` | `true` where the event saw it merged. |
| `POST_WAIT_SECONDS` | optional | `"600"` | How long it waits while a review is posting: a review's posting job's own time limit. |
| `POST_POLL_SECONDS` | optional | `"10"` | How often it asks meanwhile. |

#### Outputs

| Output | When it is written |
|---|---|
| `gate.json` | Where it decided: `proceed`, `true` where the run goes ahead and `false` where it refused, as a string. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `BRANCH`'s tip, against `HEAD_SHA`.
- The labels on the pull request `PR_NUMBER` names, for `agent:review`, while it waits.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the gate job's first work, after a Node set up for it, since nothing is
> checked out yet; no adopter step runs in that job. `HEAD_SHA`, `PR_STATE` and `PR_MERGED` are the
> label's event's, and `GH_TOKEN` is the job's own, with `pull-requests: write`. `OUTPUT_DIR` is
> `runner.temp`. A glue step copies `gate.json` into the step output `proceed`, `always()`, and the
> job's `refused` output is `false` where it is `true`, `true` where it is `false`, and empty where
> there is none: a gate that died before deciding, which `fix:conclude` reads as such. The same
> step copies `fix:gate`'s `failure_reason.txt`, where it wrote one, into the job's
> `failure-reason` output, which `fix:conclude` is handed as `GATE_REASON`. The job
> fails where the command does, so a failed probe never starts the agent's job.

### `fix:prepare`

Fetches the rescue branch an earlier stopped run of this pull request left, for the runner to
resume from: `RESCUE_BRANCH`'s tip is read from the repository's refs, and where there is one, the
branch is fetched into `CHECKOUT` as `refs/rescue/<RESCUE_BRANCH>`, over whatever was there. The
runner decides whether it still builds on the head; this only fetches it. It runs no model and
writes nothing to the record: it reads and fetches with `GH_TOKEN`, and is handed no writer.

- **No rescue.** A 404 for the branch is no rescue: it fetches nothing, and succeeds.
- **An unreadable answer stops the run**, rather than reading as no rescue, since a run that
  started over without the rescue, and succeeded, would delete it. Any other failure to read the
  tip fails the command with `` Couldn't check whether an earlier run left commits on
  `<RESCUE_BRANCH>`, so this run stopped rather than start over without them. ``, and a rescue
  that is there but cannot be fetched fails it too, naming the branch.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout the runner will work in, which the rescue is fetched into. |
| `RESCUE_BRANCH` | required | | Where an earlier fix run on this pull request that stopped left its commits. |

#### Outputs

| Output | When it is written |
|---|---|
| | Nothing beyond §2.4. The result is the ref it fetched into the checkout. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `RESCUE_BRANCH`'s tip; a 404 is no rescue.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the agent's job, after the checkout and the base fetch and before the
> adopter's toolchain and `setup`, so nothing of the pull request's has run on the runner while it
> holds the token: the pull request's own code can leave a git config entry or a hook behind for a
> later step. It runs from the package install `fix:bundle` runs from, from `RUNNER_TEMP`, and is
> handed the job's `GH_TOKEN`, which is read-only there. `CHECKOUT` is the workspace. `OUTPUT_DIR`
> is a directory of its own under `runner.temp`, which the job's upload carries, for
> `fix:conclude`'s failure comment.

### `fix:bundle`

Bundles the agent's commits for whatever pushes them: the commits on `refs/heads/<BRANCH>` in the
checkout ahead of `HEAD_SHA`, the head the run started from, as a thin bundle holding exactly that
one ref, with `HEAD_SHA` its prerequisite. It runs no model, reads no repository, holds no token,
and writes nothing to the record.

- **Nothing to bundle.** No commits ahead of `HEAD_SHA`, or no `refs/heads/<BRANCH>` at all, writes
  nothing, which whatever reads the bundle reads as nothing to push.
- **A failure of git.** Fails the command, naming the branch and the head.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout the agent worked in, with its head branch as `BRANCH`. |
| `BRANCH` | required | | The pull request's head branch. |
| `HEAD_SHA` | required | | The head the run started from, as the event that asked for it saw it. |

#### Outputs

| Output | When it is written |
|---|---|
| `branch.bundle` | Where there are commits ahead of `HEAD_SHA`: the bundle. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

Nothing. Its inputs are the checkout and the head the event named.

> **Actions orchestrator:** the agent's job, `always()` after the runner and the transcript, so a
> failed, cancelled or timed-out run hands its commits over too. The package is installed early in
> that job, before the adopter's `setup`, by the one step there handed the registry token, `npm
> install --prefix "$RUNNER_TEMP"`, and this command runs from `RUNNER_TEMP`, where `npm exec` finds
> that install without asking the registry. It is handed no token: the job's `GH_TOKEN` is set empty
> for it. `CHECKOUT` is the workspace, and `BRANCH` and `HEAD_SHA` the label's event's. `OUTPUT_DIR`
> is a directory of its own under `runner.temp`, which the job's upload carries beside the runner's
> files; the publish job checks the bundle before it pushes or rescues anything from it.

### `fix:publish`

Posts a fix round from the runner's hand-over and pushes the agent's commits, then hands the round
on. It runs no model. It writes every final string itself: the rescue-set-aside note, the
nothing-to-do note, the conversation record with its marker, each top-level comment and
out-of-scope note with theirs, and the round header on each, from the hand-over's data and text,
none of which carries a marker. It reads and checks the whole hand-over before its first write:

- every piece of free text is cleaned (§4.3: no HTML comment the agent wrote survives);
- each thread's status is `addressed` or `declined`, and each list holds no more than its
  runner's cap, a thread outcome per review thread and a conversation outcome per comment;
- every thread id is a review thread on the pull request, and every conversation comment id a
  comment on its conversation, read from GitHub, which also gives each comment's author and link
  for the record: the hand-over carries neither;
- the header, where there is one, has the round header's shape;
- the rescue note names `RESCUE_BRANCH`;
- `branch.bundle`, where there is one, verifies in `CHECKOUT`, holds exactly
  `refs/heads/<BRANCH>`, and builds on `HEAD_SHA`;
- and, where the agent's job finished, `thread_outcomes.json` or `nothing_to_do.txt` is there, or
  the hand-over did not arrive.

A check that fails fails the command, naming it, and nothing is written.

The order: the rescue-set-aside note, where the runner set one aside; then, on any ending of the
agent's job but `success`, nothing more. Then the nothing-to-do note, where there was nothing to do,
and nothing more. Then the push of the bundle's tip to `refs/heads/<BRANCH>`, leased on `HEAD_SHA`,
with the loop's token; the rescue branch's deletion, leased on its tip as read; a reply in every
thread it reported on, resolving none; the conversation record, where it has an outcome; the
top-level comments; and the out-of-scope notes. Last, where it pushed, posted a note, or is on a PRD
branch, the re-review: a bounded wait for the pull request to show the pushed head, where it pushed,
then `agent:fix` off, `agent:review` off and on again with the loop's token, and, where
`LOOP_TOKEN_SOURCE` is neither `app` nor `pat`, a comment saying no review will start. Otherwise,
off a PRD branch, the ready mark with the loop's token. A failed push or `agent:review` add stops
the command; every other write is tolerated, a warning where GitHub refuses it.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | required | | The token whose writes start the loop's next workflow: the push, the labels and the ready mark. |
| `LOOP_TOKEN_SOURCE` | required | | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch, which the bundle has to hold and the push moves. A PRD branch's pull request always gets a re-review, and is never marked ready. |
| `HEAD_SHA` | required | | The head the run started from, as the event that asked for it saw it: what the bundle has to build on, and the push's lease. |
| `RESCUE_BRANCH` | required | | Where an earlier stopped run left its commits, which a run that succeeds deletes. |
| `AGENT_RESULT` | required | | How the agent's job ended: `success`, `failure`, `cancelled` or `skipped`. Only `success` posts the round. |
| `CHECKOUT` | required | | A checkout of the repository, at `HEAD_SHA`, the bundle is checked in and pushed from. |
| `HEAD_WAIT_SECONDS` | optional | `60` | How long to wait for the pull request to show the pushed head before the re-review is asked for anyway. |
| `HEAD_POLL_SECONDS` | optional | `5` | How often to look while waiting. |
| `FIX_DIR` | directory | | The `fix` runner's `OUTPUT_DIR`. Reads `nothing_to_do.txt` (where written), `rescue_ignored.json` (where written), `round_header.txt` (where written), `thread_outcomes.json` (where written), `conversation_outcomes.json` (where written), `top_level_comments.json` (where written) and `out_of_scope_notes.json` (where written). |
| `BUNDLE_DIR` | directory | | `fix:bundle`'s `OUTPUT_DIR`. Reads `branch.bundle` (where written). |

#### Outputs

| Output | When it is written |
|---|---|
| `published.json` | From its first write: `pushed`, whether it pushed, `head`, the pushed commit, where it did, `notesPosted`, whether an out-of-scope note went up, `nothingToDo`, and `rescueNoted`, whether the rescue-set-aside note went up, each written as it becomes true. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:publish`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The pull request's review threads, for the ids the hand-over may name, and its conversation
  comments, for the ids it may name and each one's author and link.
- `RESCUE_BRANCH`'s tip, which the deletion is leased on.
- The pull request `PR_NUMBER` names, after a push, for whether it shows the pushed head yet.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the publish job mints the loop's token at its start, then checks the
> head out once, with no credential left in it, and sets up Node. `fix:publish` runs from
> `RUNNER_TEMP`, working in the checkout, on a mint that succeeded wherever the agent's job ran, and
> never on a finished agent's run being cancelled. It is the one step of the success arm handed a
> token, the workflow's as `GH_TOKEN` and the loop's, beside `fix:conclude`; the job sets none. `HEAD_SHA` is the label's
> event's, `AGENT_RESULT` the agent's job's result, `FIX_DIR` and `BUNDLE_DIR` where the agent's
> artifact is downloaded, and `OUTPUT_DIR` a directory of its own under `runner.temp`, which
> `fix:conclude` reads as its `PUBLISH_DIR`.

### `fix:conclude`

Ends every fix run, success included, in the loop's one order: every result posted, then
`agent:fix` off, then `agent:blocked` where the run stopped. It runs no model. It is told how the
run went rather than reading it off which steps ran: the gate's decision and result, the agent's
job's result, whether that job ran out of time, and the outcome of each step the orchestrator ran
before it, and it works out the ending from them. Each is one of:

- **A refusal** (`REFUSED` is `true`): nothing, since the gate said it and took the label off.
- **A pre-flight that did not decide** (`REFUSED` is empty): `agent:fix` off, and nothing else,
  since nothing is known to say.
- **A run that finished**, the agent's job and every step before this one: `agent:fix` off.
  Every other word of it is `fix:publish`'s.
- **A run that stopped**: the rescue, below; then the failure comment, `` **`agent:fix` stopped:** ``
  and the reason as a sentence, the run's link where there is a run, and the retry; then
  `agent:fix` off, then `agent:blocked`. The reason is, where the agent's job finished, the first of the mint, the
  download and `fix:publish` that did not succeed: a fixed sentence for the mint and the download,
  `fix:publish`'s `failure_reason.txt`, or a cancel where that step was cancelled or skipped.
  Otherwise, where the gate, the agent's job or a step was cancelled, a cancel, or the time limit
  where `TIMED_OUT` is `true`; and failing that, `GATE_REASON` where the gate failed, then
  `fix:prepare`'s `failure_reason.txt`, or the
  runner's, or `fix:bundle`'s, or, where none was written, that it gave no reason, or the time limit where
  the agent's job failed and `TIMED_OUT` is `true`. The retry is to add `agent:review` where
  `published.json` says it pushed, or posted a note, and to add `agent:fix` otherwise; a rescue is
  named beside it, and is the retry where nothing else was.

**The rescue.** Only on a run that stopped, where `published.json` does not say it pushed, and
where there is a `branch.bundle`. The bundle is checked as `fix:publish` checks it: it verifies in
`CHECKOUT`, holds exactly `refs/heads/<BRANCH>`, and builds on `HEAD_SHA`. Its tip is pushed to
`refs/heads/<RESCUE_BRANCH>` with the loop's token, leased on the rescue's tip as read, or on there
being none. A bundle that fails a check, a rescue that cannot be read and a push GitHub refuses
are each a warning, and nothing is rescued. With no loop token (`LOOP_TOKEN` empty, or
`MINT_OUTCOME` not `success`) it pushes nothing, and the comment says the commits were not saved.

Before any of these, the rescue-set-aside note, where the runner set a rescue aside and
`published.json` does not say `fix:publish` posted it: it did not run, or stopped before it got
that far, reading the pull request or checking the hand-over. Every write is
tolerated: one GitHub refuses is a warning, so a run that cannot comment still takes its label
off. The rescue is made with `LOOP_TOKEN`; everything else with `GH_TOKEN`.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | optional | `""` | The token whose writes start the loop's next workflow: the rescue's push. Empty where it was not minted, which is one of the endings this reports. |
| `LOOP_TOKEN_SOURCE` | optional | `""` | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch, which the bundle has to hold. |
| `HEAD_SHA` | required | | The head the run started from, as the event that asked for it saw it: what the bundle has to build on. |
| `RESCUE_BRANCH` | required | | Where a stopped run's commits are rescued to, and the only branch a rescue-set-aside note may name. |
| `CHECKOUT` | required | | A checkout of the repository, at `HEAD_SHA`, the bundle is checked in and rescued from. |
| `REFUSED` | optional | `""` | Accepts `true` or `false`: `false` where the gate claimed the run, `true` where it refused. Empty is a gate that died before it decided. |
| `GATE_RESULT` | required | | How the gate's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `GATE_REASON` | optional | `""` | The sentence `fix:gate` failed with, where it failed after claiming the run, such as at the permission probe. |
| `AGENT_RESULT` | required | | How the agent's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `TIMED_OUT` | optional | `""` | `true` where the agent's job ran its whole limit. |
| `TIMEOUT_MINUTES` | optional | `""` | That limit, for the comment. |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting `LOOP_TOKEN`: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `DOWNLOAD_OUTCOME` | optional | `""` | The same, for fetching the agent's hand-over. |
| `PUBLISH_OUTCOME` | optional | `""` | The same, for `fix:publish`. |
| `PUBLISH_DIR` | directory | | `fix:publish`'s `OUTPUT_DIR`. Reads `published.json` (where written) and `failure_reason.txt` (where written). |
| `PREPARE_DIR` | directory | | `fix:prepare`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `FIX_DIR` | directory | | The `fix` runner's `OUTPUT_DIR`. Reads `failure_reason.txt` (where written) and `rescue_ignored.json` (where written). |
| `BUNDLE_DIR` | directory | | `fix:bundle`'s `OUTPUT_DIR`. Reads `branch.bundle` (where written) and `failure_reason.txt` (where written). |
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the link to the run the failure comment names. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `RESCUE_BRANCH`'s tip, where it rescues, which the push is leased on; a 404 is no rescue yet.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the publish job's step after `fix:publish`, run `always()`, from
> `RUNNER_TEMP` and working in the job's one checkout. It is told the gate's `refused` output,
> result and `failure-reason` output, which the gate job's glue step copies from `fix:gate`'s
> reason file, the agent's job's result and its `timed-out` output, the limit as
> `AGENT_TIMEOUT_MINUTES` or 30, and the outcomes of the mint, the download and `fix:publish`.
> `timed-out` is the agent's job's last step's, `always()`, which compares the time since the
> gate's clock with the limit, less a minute, wherever that job did not succeed: glue only
> Actions can do, and the one output that job declares. `PUBLISH_DIR` is `fix:publish`'s
> `OUTPUT_DIR`, and `PREPARE_DIR`, `FIX_DIR` and `BUNDLE_DIR` where the agent's artifact is downloaded, a
> directory of its own under `runner.temp`. It is handed both tokens, the loop's empty where the
> mint failed; with `fix:publish`, the only steps in the job that are.

## 10. `update-branch`

Trigger label: `agent:update-branch`, on a pull request. `doctor` checks that the label exists.

Resolves the conflicts of a merge of the base branch into the pull request's branch. Preconditions:
the head checked out as `BRANCH`, with `git merge origin/<BASE_REF>` already run and stopped on its
conflicts, `origin/<BASE_REF>` at the base commit `update-branch:merge` read: `update-branch:prepare`
leaves the checkout so, and refuses where it cannot. A merge that does not conflict needs no runner.

It ends with the merge committed in the checkout, on `BRANCH`: the head and the base commit its
parents, in that order, and the agent's resolution its tree. Under `none` the agent commits it
there itself. Under `bwrap` (§2.2) the agent's copy holds no merge in progress and hands back no
merge commit, and Sandcastle's own merge of its work into the checkout is one git refuses
mid-merge, which is how #463's first run on the service stopped. So the agent works on
`sandcastle/update-branch-pr-<PR_NUMBER>/merge`, made at the head, where Sandcastle leaves its
commits; the copy, where it is at the head, is put mid-merge with `git merge --squash` of the base
commit, after the checkout's untracked paths are carried in, so the agent meets the same conflicts
staged and its commit is an ordinary one; and the runner makes the merge with `git commit-tree`,
from the tree of that branch's tip, git's subject for the merge and the body of the agent's last
message, moves `BRANCH` onto it with `git reset --hard`, and deletes the branch. A branch with no
commit of the agent's on it, or one Sandcastle left checked out in a worktree of its own, a
copy-out that did not finish, fails the run, and nothing is pushed.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. |
| `AGENT_MODEL_UPDATE_BRANCH` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_SANDBOX` | optional | `none` | Accepts `none` or `bwrap`: the agent's sandbox (§2.2, §3). Any other value fails the run, naming it. |
| `AGENT_SANDBOX_RO_BINDS` | optional | `""` | Read-only binds for `bwrap` (§2.2). |
| `AGENT_SANDBOX_PATH` | optional | `/usr/local/bin:/usr/bin:/bin` | `PATH` inside `bwrap` (§2.2). |
| `AGENT_SANDBOX_PROXY` | optional | `""` | The proxy for `bwrap`, required with it (§2.2). |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch. |
| `BASE_REF` | required | | The branch being merged in. |

### Outputs

| Output | When it is written |
|---|---|
| `update_comment.md` | The comment saying how the conflicts were resolved. |

**`doctor` cannot check this.** These tables are the runner's, for the reason §6 gives.

### What it reads from the record

Nothing. It reads the pull request's title and body as context for the agent, and parses
neither.

> **Actions orchestrator:** a merge that does not conflict is pushed without the runner. Otherwise
> the agent's job installs the package under `RUNNER_TEMP` after its checkout, the one step of the
> job handed the registry token, runs `update-branch:prepare` from it before the adopter's toolchain
> and `setup`, runs the runner as that install's binary, by its path, from the checkout, and
> `update-branch:bundle` from it after the runner, and measures in its last step whether it ran out
> of time; and a publish job runs `update-branch:publish`, which pushes the clean merge or the
> resolution, carries the earlier verdict over to a clean merge, posts the comment,
> `update_comment.md` on a resolution, and asks for the resolution's review, then
> `update-branch:conclude`, `always()`, which ends every run: the failure comment,
> `agent:update-branch` off, `agent:blocked`, and the re-request where the head moved. No step of
> the workflow decides anything in inline shell: what is left is glue and what only Actions can do.

> **Service orchestrator:** the worker runs the gate job's, the agent's job's and the publish job's
> subcommands, in the order and under the conditions above, each a child process with a fresh
> `OUTPUT_DIR` of its own and an environment built from its declaration, and writes nothing to the
> record itself. It answers an `agent:update-branch` from a person who can write and from its own
> App alike (ADR 0008). It asks the dispatcher for a `write` token and runs `update-branch:gate`
> with the state and merged flag the label's event carried. A refusal ends the run there, as on
> Actions it skips the publish job: no token is asked for after it, publish and
> `update-branch:conclude` do not run, and the run's summary notes the refusal. Where the gate
> claimed the run, it checks out the event's head as `BRANCH`, fetching `BASE_REF` and the repository's tags, with that token passed with each
> fetch and never stored, and runs `update-branch:merge` there with the same token: outside the
> sandbox, since it runs none of the pull request's code, and holding no `push` token, since
> nothing is pushed until publish. Only where the merge conflicted does the agent's job run: a
> `read` token, a checkout of its own, `update-branch:prepare` with that token, the repository's
> setup, `AGENT_SETUP`, in the bwrap sandbox with no token, the runner in the sandbox its settings
> name with a fresh `read` token as `GH_TOKEN`, and `update-branch:bundle`, handed no token, where
> those succeeded. A clean merge, or a branch already up to date, runs no setup and no runner.
> Otherwise it asks for a `push` token; where the gate claimed the run and, on
> a conflict, the agent's job succeeded, it checks the head out once more and runs
> `update-branch:publish` there, pointed at the runner's and `update-branch:bundle`'s directories.
> Then `update-branch:conclude`, however the run ended, pointed at publish's, prepare's, the
> runner's and bundle's. `update-branch:publish` and `update-branch:conclude` alone hold `push`,
> each as both `GH_TOKEN` and `LOOP_TOKEN`, with `LOOP_TOKEN_SOURCE` `app`; the runner never holds
> a token that writes. Where `update-branch.yml` passes something the service does not have, it
> passes the nearest equivalent:
>
> - **The gate job's outputs are its files.** `REFUSED` is read from `gate.json` as for `fix`;
>   `STATUS` and `BASE_SHA` are `merge.json`'s `status` and `base`; `GATE_REASON` is
>   `update-branch:gate`'s `failure_reason.txt`, or `update-branch:merge`'s where the merge ran, or
>   the checkout's error where the head could not be checked out. The gate job's result is a
>   failure where any of the three failed.
> - **A checkout per job**, as on Actions: the gate's merge leaves its checkout merged, or stopped
>   on its conflicts, and `update-branch:prepare` and `update-branch:publish` each make that merge
>   again from the head the event named, so each needs the head as the event named it. The agent's
>   checkout is the one the setup's sandbox binds.
> - **The time limits are the jobs'.** The gate, its checkout and the merge share the gate job's
>   15 minutes. The agent's job's steps share `AGENT_TIMEOUT_MINUTES` (30 where unset or not a
>   positive integer), and one still running at it is ended with every process it started: the
>   agent's job is then `cancelled`, with `TIMED_OUT` `true` and `TIMEOUT_MINUTES` the limit, which
>   on Actions the job's last step measures. Publish's checkout and `update-branch:publish` share
>   the publish job's 15 minutes, and `update-branch:conclude` gets 15 of its own. The dispatcher's
>   deadline for the job is the agent's limit plus its margin.
> - **A phase not started leaves its reason** where `update-branch:conclude` reads the next one: a
>   `read` token not granted, or a checkout that failed, as `update-branch:prepare`'s
>   `failure_reason.txt`; a setup that failed, or a runner's token not granted, as the runner's; a
>   publish checkout that failed as `update-branch:publish`'s.
> - **A checkout that fails before publish is publish's failure, on purpose.** Where publish's
>   checkout fails, `update-branch:publish` does not run, and conclude is told `PUBLISH_OUTCOME` `failure`
>   with the checkout's reason as publish's, or `cancelled` where the checkout ran out of the
>   publish job's time. On Actions the publish step's `if:` opens with `always()`, so it runs after
>   the failed checkout, in an empty workspace, and fails there with a reason that names the
>   missing repository rather than the checkout. The service names the cause instead, as every
>   run function with a checkout before publish does.
> - **No run link, and the download is a success** wherever the agent's job ran: the hand-over is
>   on the worker's disk. `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` are unset.
> - **The mint is the `push` token's.** One not granted is `MINT_OUTCOME` `failure`, and nothing is
>   published; `update-branch:conclude` is then handed a `write` token, enough for its comment and
>   labels. An undecided gate, one that failed or timed out before it decided, is not a refusal:
>   conclude runs then, told `REFUSED` empty, as on Actions. Where no token is
>   granted to conclude, nothing can write to the pull request, and the worker's log says why the
>   run ended.
> - **The hand back to review needs nothing new.** `update-branch:publish` adds `agent:review` with
>   the loop's token, the App's, which the dispatcher answers as the App's own label.
> - **A head that moves while a refresh runs.** `update-branch:conclude` is unchanged. Its comment
>   that no refresh of the new head will start fires only without a loop token, and the service
>   always passes the App's, so on the service it never fires: conclude adds `agent:update-branch`
>   again, as the App. Its guard against re-requesting while another trigger label is on is
>   reasoned from Actions' concurrency group, whose waiting slot holds one run and cancels the run
>   it replaces. The worker queues jobs one at a time and cancels none, so on the service that
>   reason does not hold: the guard is harmless there, and only leaves the re-request to a person
>   where another label's job is still to run.
>
> Not run: `node-version-file`, since the sandbox runs the worker box's own Node, and the session
> transcript's upload.

### `update-branch:gate`

Refuses or claims the pull request, before anything is checked out. It runs no model and needs no
checkout. In order:

- **The pre-flight.** A pull request whose `PR_STATE` is not `open`, or that is `PR_MERGED`, is
  refused with `This PR is closed.`, and not blocked. That is the only refusal: unlike `fix:gate`
  it reads no branch tip, so a deleted base or head fails at `update-branch:merge`'s fetch instead.
- **A refusal** is said in the loop's one order: the comment, `` **`agent:update-branch` didn't
  run:** `` and the sentence; then `agent:update-branch` off. Each is tolerated, so a comment that
  fails still takes the label off.
- **The permission probe.** On a run it claims, it adds `agent:update-branch`, which the pull
  request already carries, so a token short of the write fails the command before the checkout.
  Not tolerated.
- **`agent:blocked` off**, tolerated: re-adding `agent:update-branch` is the retry after a block.
- **The wait for a review's posting**, as `fix:gate`'s: while `agent:review` is on the pull
  request, up to `POST_WAIT_SECONDS`, asking every `POST_POLL_SECONDS`, and on at the bound with a
  warning. This run carries the review's verdict on to the merge commit, so it waits rather than
  read it half posted.

Every write is made with `GH_TOKEN`: none of them has to start a run. A refusal is a decision, and
the command succeeds. `gate.json` is written as `fix:gate`'s is: the moment the run is refused or
claimed, and again however the command ends, and not at all where it died before deciding.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch. |
| `PR_STATE` | required | | The pull request's state as the event saw it: `open` or `closed`. |
| `PR_MERGED` | optional | `""` | `true` where the event saw it merged. |
| `POST_WAIT_SECONDS` | optional | `"600"` | How long it waits while a review is posting: a review's posting job's own time limit. |
| `POST_POLL_SECONDS` | optional | `"10"` | How often it asks meanwhile. |

#### Outputs

| Output | When it is written |
|---|---|
| `gate.json` | Where it decided: `proceed`, `true` where the run goes ahead and `false` where it refused, as a string. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The labels on the pull request `PR_NUMBER` names, for `agent:review`, while it waits.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the gate job's first work, after a Node set up for it, since nothing is
> checked out yet, and the package installed under `RUNNER_TEMP` with the registry token, which
> this command and `update-branch:merge` both run from; no adopter step runs in that job.
> `PR_STATE` and `PR_MERGED` are the label's
> event's, and `GH_TOKEN` is the job's own, with `pull-requests: write`. `OUTPUT_DIR` is
> `runner.temp`. A glue step copies `gate.json` into the step output `proceed`, `always()`, which
> the checkout, `update-branch:merge` and the job's `refused` output read, `refused` with
> `fix:gate`'s three values. The same step copies the command's `failure_reason.txt`, where it
> wrote one, into the job's `failure-reason` output, which `update-branch:conclude` reads as its
> `GATE_REASON`.

### `update-branch:merge`

Tries the merge, to decide whether there is anything for the runner to do. `BASE_REF` is fetched
from the repository into `CHECKOUT` as `refs/remotes/origin/<BASE_REF>`, the commit checked out
there is checked out as the branch `BRANCH`, and the base is merged into it, as the loop's
committer, `sandcastle-agent[bot]`. It runs no model and writes nothing to the record: it fetches
with `GH_TOKEN`, which reaches git in its environment, never on its argv or in the checkout's
config, and is handed no writer.

- **Up to date**, where the branch already holds the base commit: nothing is merged.
- **Clean**, where the merge made a commit, or fast-forwarded, without a conflict.
- **Conflicts**, where it stopped on one: the conflicted tree is left in the checkout.
- **A fetch that fails**, a deleted base among its causes, fails the command with `` Couldn't fetch
  `<BASE_REF>` to merge it, so the branch was left untouched: `` and git's reason. A merge that
  fails on no conflict fails it too, naming the base and the branch.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout of the pull request's head, which the base is merged into. |
| `BRANCH` | required | | The pull request's head branch, which the head is checked out as. |
| `BASE_REF` | required | | The branch being merged in. |

#### Outputs

| Output | When it is written |
|---|---|
| `merge.json` | Where it fetched and merged: `status`, `uptodate`, `clean` or `conflicts`; `base`, the base commit it fetched; and `conflicts`, the conflicted paths, empty but on a conflict. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

Nothing. It reads `BASE_REF`'s commits, and parses no record string.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the gate job, after the checkout of the head and only where
> `update-branch:gate` claimed the run. It runs none of the pull request's code, and still runs
> from `RUNNER_TEMP` with no registry token, from the install the gate job made before its checkout. `GH_TOKEN`
> is the job's, and `CHECKOUT` the workspace. `OUTPUT_DIR` is a directory of its own under
> `runner.temp`. A glue step, `always()` where the gate went ahead, copies `merge.json` into the
> job's `status`, `base` and `conflicts` outputs, the paths joined by spaces, and its
> `failure_reason.txt`, where it wrote one, into the job's `failure-reason` output, which
> `update-branch:conclude` reads as its `GATE_REASON`.

### `update-branch:prepare`

Makes the gate's merge again, so the runner starts from the conflicted tree `update-branch:merge`
found. `BASE_REF` is fetched into `CHECKOUT` as `refs/remotes/origin/<BASE_REF>`, that ref is set
back to `BASE_SHA`, the base commit `update-branch:merge` merged, the commit checked out there is
checked out as the branch `BRANCH`, and the base is merged into it under its name, as the loop's
committer: the same two commits and the same message as that merge. It runs no model and writes
nothing to the record: it fetches with `GH_TOKEN`, and is handed no writer.

- **Conflicts** are the one success: the conflicted tree is left in the checkout for the runner.
- **The base moved.** Where `BASE_REF`, fetched, no longer contains `BASE_SHA`, it fails with ``
  `<BASE_REF>` no longer holds the commit this run set out to merge, so the branch was left
  untouched. ``, before anything is checked out.
- **No conflict.** Where the merge is clean, or the branch already holds the base, it fails with
  `` Merging `<BASE_REF>` again didn't conflict, so there was nothing for the agent to resolve and
  the branch was left untouched. ``
- **A fetch that fails** fails it with `` Couldn't fetch `<BASE_REF>` to merge it again for the
  agent, so the branch was left untouched: `` and git's reason. A merge that fails on no conflict
  fails it too, naming the base and the branch.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout of the pull request's head, which the base is merged into. |
| `BRANCH` | required | | The pull request's head branch, which the head is checked out as. |
| `BASE_REF` | required | | The branch being merged in. |
| `BASE_SHA` | required | | The base commit `update-branch:merge` merged, its `merge.json`'s `base`: a gate fact. |

#### Outputs

| Output | When it is written |
|---|---|
| | Nothing beyond §2.4. The result is the conflicted tree it leaves in the checkout. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

Nothing. It reads `BASE_REF`'s commits, and parses no record string.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the agent's job, after the checkout and before the adopter's toolchain
> and `setup`, so nothing of the pull request's has run on the runner while it holds the token: the
> pull request's own code can leave a git config entry or a hook behind for a later step. It runs
> from the package install the job makes after its checkout, from `RUNNER_TEMP`, and is handed the
> job's `GH_TOKEN`, which is read-only there. `BASE_SHA` is the gate job's `base` output and
> `CHECKOUT` the workspace. `OUTPUT_DIR` is a directory of its own under `runner.temp`, which the
> job's upload carries under `prepare/`; `update-branch:conclude` reads its reason there as its
> `PREPARE_DIR`.

### `update-branch:bundle`

Bundles the agent's resolution for whatever pushes it, as `fix:bundle` bundles: the commits on
`refs/heads/<BRANCH>` in the checkout that neither `HEAD_SHA`, the head the run started from, nor
`BASE_SHA`, the base commit `update-branch:merge` merged, holds, as a thin bundle holding exactly
that one ref, with those two commits its prerequisites. It runs no model, reads no repository,
holds no token, and writes nothing to the record.

- **Nothing to bundle** is a refusal, unlike `fix:bundle`'s: a run that resolved the conflicts
  committed a merge of the two. No such commit fails it with `` The agent finished without
  committing a merge of the base into `<BRANCH>`, so there was no resolution to push and the branch
  was left untouched. ``, and no `refs/heads/<BRANCH>` at all with `` The agent's job has no
  `<BRANCH>` to hand over, so the branch was left untouched. ``
- **A failure of git.** Fails the command, naming the branch, with git's reason.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CHECKOUT` | required | | The checkout the agent worked in, with its head branch as `BRANCH`. |
| `BRANCH` | required | | The pull request's head branch. |
| `HEAD_SHA` | required | | The head the run started from, as the event that asked for it saw it. |
| `BASE_SHA` | required | | The base commit `update-branch:merge` merged, its `merge.json`'s `base`: a gate fact. |

#### Outputs

| Output | When it is written |
|---|---|
| `branch.bundle` | Where there are commits ahead of `HEAD_SHA` and `BASE_SHA`: the bundle. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

Nothing. Its inputs are the checkout, the head the event named and the base commit the gate read.

> **Actions orchestrator:** the agent's job, after the runner and the transcript, where the runner
> succeeded. It runs from the package install the job makes after its checkout, from
> `RUNNER_TEMP`, and is handed no token: the job's `GH_TOKEN` is set empty for it. `CHECKOUT` is
> the workspace, `BRANCH` and `HEAD_SHA` the label's event's, and `BASE_SHA` the gate job's `base`
> output. `OUTPUT_DIR` is a directory of its own under `runner.temp`, which the job's upload
> carries under `bundle/`; `update-branch:publish` reads the bundle there as its `BUNDLE_DIR` and
> checks it before it pushes, and `update-branch:conclude` reads the reason there as its
> `BUNDLE_DIR`.

### `update-branch:publish`

Publishes the refresh: pushes what the gate's merge came to, carries the verdict and the
maintainer's merge arm over to a clean merge, says on the pull request what it did, and asks for a
review of a resolution. It runs no
model. Each path does one of the two hand-offs, never both: a clean merge changed nothing a review
read, so the verdict on the old head still stands; a resolution is code an agent wrote that no
review has read, so it asks for one. What is pushed is settled, and checked, before its first
write:

- **`uptodate`.** Nothing to push.
- **`clean`.** The merge is made again in `CHECKOUT`, as the loop's committer, of `BASE_SHA` under
  `BASE_REF`'s name: `update-branch:merge`'s merge, by construction. It fails the command with ``
  `<BASE_REF>` no longer holds the commit this run set out to merge, so the branch was left
  untouched. `` where the base fetched no longer holds `BASE_SHA`, and with `` Merging `<BASE_REF>`
  again didn't go cleanly, though it did a moment before, so the branch was left untouched. ``
  where the merge does not.
- **`conflicts`.** `branch.bundle`, which has to be there, is checked as `fix:publish` checks its
  own: it verifies in `CHECKOUT`, holds exactly `refs/heads/<BRANCH>`, and builds on `HEAD_SHA`.
  `BASE_REF` is fetched first, the bundle's other prerequisite, and has to hold `BASE_SHA`, which
  the bundle's tip has to hold too: a resolution is a merge of the two. On any ending of the agent's
  job but `success` it does nothing.

A check that fails fails the command, naming it, and nothing is written. A fetch that fails fails it
too, with git's reason.

The order: the push to `refs/heads/<BRANCH>`, leased on `HEAD_SHA`, with the loop's token. Then, on
a clean merge, the verdict carried over and then the arm (below). Then the comment, with the workflow token:
`` `agent:update-branch`: already up to date with `<BASE_REF>`, so no merge was needed. ``, `` `agent:update-branch`: merged `<BASE_REF>` (`<BASE_SHA>`'s first seven) cleanly, with no conflicts. ``,
or, on a resolution, the runner's `update_comment.md`, cleaned (§4.3: no HTML comment the agent
wrote survives), or `` `agent:update-branch`: resolved conflicts merging `<BASE_REF>`. `` where it
is missing or nothing is left of it. Last, on a resolution, its review: a bounded wait for the pull
request to show the pushed head, then `agent:update-branch` off, `agent:review` off and on again
with the loop's token, and, where `LOOP_TOKEN_SOURCE` is neither `app` nor `pat`, a comment saying
no review will start. A failed push, comment or `agent:review` add stops the command; the label
removals and the no-review comment are tolerated, a warning where GitHub refuses them.

**The verdict carried over** is the newest `agent-review` status on `HEAD_SHA` posted by one of the
loop's accounts (§4.1), never one another account posted under the same context. It is copied
unparsed on to the pushed merge: its state, description and target URL, an `error` included, with
the **workflow** token, since a status from any other account is not one a later round reads as
the loop's. A read of the statuses that fails and a commit with no verdict of ours are two
results: the first warns that whether a verdict stood could not be told, the second says there is
nothing to carry over. Neither fails the command, and nor does a copy GitHub refuses, which warns:
the merge is pushed by then.

**The arm carried over** (#589, ADR 0009) is the newest `agent-merge` status on `HEAD_SHA` whose
creator is `LOOP_LOGIN`, where it is `success`, read off the same statuses as the verdict, so a read
that fails carries neither. It is copied on to the pushed merge with the **loop's** token, so the
copy is still the loop token's: its state and target URL as they were, and its description written
again with the human and the arm's time kept and its refresh count one higher (§4.3), which
`merge:gate`'s cap reads. Only on `clean`: a resolution, `uptodate`, and every push but this one
carry nothing, and a head with no arm is disarmed by the next gate. With `LOOP_TOKEN_SOURCE`
neither `app` nor `pat` it copies nothing and warns, and with `LOOP_LOGIN` empty it copies nothing
and says it could not tell whose an arm is. An arm whose description names no one it can read is
not carried, and warns: a count it cannot read is one it cannot raise. A copy GitHub refuses
warns, as the verdict's does.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | required | | The token whose writes start the loop's next workflow: the push and the labels, and the carried arm. |
| `LOOP_TOKEN_SOURCE` | required | | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. Anything but the first two carries no arm. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch, which the push moves and the bundle has to hold. |
| `BASE_REF` | required | | The branch merged in. |
| `HEAD_SHA` | required | | The head the run started from, as the event that asked for it saw it: what a resolution has to build on, the verdict is copied from, and the push's lease. |
| `STATUS` | required | | Accepts `uptodate`, `clean` or `conflicts`: what `update-branch:merge` came to, its `merge.json`'s `status`. A gate fact. |
| `BASE_SHA` | required | | The base commit `update-branch:merge` merged, its `merge.json`'s `base`: a gate fact. |
| `AGENT_RESULT` | required | | How the agent's job ended: `success`, `failure`, `cancelled` or `skipped`. On `conflicts`, only `success` publishes. |
| `CHECKOUT` | required | | A checkout of the repository, at `HEAD_SHA`, the merge is made in, the bundle checked in, and both pushed from. |
| `LOOP_LOGIN` | optional | `""` | The account `LOOP_TOKEN` writes as, in REST's spelling, as `merge:gate` takes it: the arm is carried only where this account posted it. Empty carries none. |
| `HEAD_WAIT_SECONDS` | optional | `60` | How long to wait for the pull request to show the pushed head before the review is asked for anyway. |
| `HEAD_POLL_SECONDS` | optional | `5` | How often to look while waiting. |
| `UPDATE_BRANCH_DIR` | directory | | The `update-branch` runner's `OUTPUT_DIR`. Reads `update_comment.md` (where written). |
| `BUNDLE_DIR` | directory | | `update-branch:bundle`'s `OUTPUT_DIR`. Reads `branch.bundle` (where written). |

#### Outputs

| Output | When it is written |
|---|---|
| `published.json` | At its start: `pushed`, whether it pushed, `head`, the pushed commit, where it did, and `requested`, whether it asked for the resolution's review, each written as it becomes true. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:publish`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The statuses on `HEAD_SHA`, every page, for the newest `agent-review` of the loop's accounts, and
  on a clean merge the newest `agent-merge` by `LOOP_LOGIN`.
- The pull request `PR_NUMBER` names, after a resolution's push, for whether it shows the pushed
  head yet.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the publish job mints the loop's token at its start, checks the head
> out once, with no credential left in it, wherever the gate claimed the run, sets up Node, and
> downloads the agent's artifact into a directory of its own under `runner.temp` on a conflict.
> `update-branch:publish` runs from `RUNNER_TEMP`, working in the checkout, where the gate claimed
> the run and, on a conflict, the agent's job succeeded, on a mint that succeeded, and never on a
> run being cancelled. It is handed the workflow's token as `GH_TOKEN` and the loop's; the job sets
> none. The mint is asked for `account`, whose `login` output is `LOOP_LOGIN`, as in `merge.yml`
> (§12). `HEAD_SHA` is the label's event's, `STATUS` and `BASE_SHA` the gate job's `status` and
> `base` outputs, `AGENT_RESULT` the agent's job's result, `UPDATE_BRANCH_DIR` the download's
> directory and `BUNDLE_DIR` its `bundle/`, and `OUTPUT_DIR` a directory of its own under
> `runner.temp`, which `update-branch:conclude` reads as its `PUBLISH_DIR`.

### `update-branch:conclude`

Ends every update-branch run, success included, in the loop's one order: every result posted, then
`agent:update-branch` off, then the label that names the next step. It runs no model and needs no
checkout. It is told how the run went rather than reading it off which steps ran: the gate's
decision, result and merge, the agent's job's result, whether that job ran out of time, and the
outcome of each step the orchestrator ran before it, and it works out the ending from them. Each is
one of:

- **A refusal** (`REFUSED` is `true`): nothing, since the gate said it and took the label off.
- **A pre-flight that did not decide** (`REFUSED` is empty): `agent:update-branch` off, and nothing
  else, since nothing is known to say.
- **A run that finished**: the gate, the agent's job where `STATUS` is `conflicts` (skipped
  otherwise, which is not a failure), and every step before this one. `agent:update-branch` off,
  then the re-request and the hand-back, below. Every other word of it is
  `update-branch:publish`'s.
- **A run that stopped**: the failure comment, `` **`agent:update-branch` stopped:** `` and the
  reason as a sentence, the run's link where there is a run, and the retry; then
  `agent:update-branch` off, then `agent:blocked`. The reason is, where the gate and the agent's job finished, the first of the
  mint, the download (on `conflicts` only) and `update-branch:publish` that did not succeed: a
  fixed sentence for the mint and the download, `update-branch:publish`'s `failure_reason.txt`, or
  a cancel where that step was cancelled or skipped. Otherwise, where the gate, the agent's job or
  a step was cancelled, a cancel, or the time limit where `TIMED_OUT` is `true`; and failing that,
  `GATE_REASON` where the gate failed, then `update-branch:prepare`'s `failure_reason.txt`, or
  `update-branch:bundle`'s, or the runner's, or, where none was written, that it gave no reason, or
  the time limit where the agent's job failed and `TIMED_OUT` is `true`. The retry is ``The merge
  was pushed before it stopped, so running it again would do nothing. Fix the problem above.``
  where `published.json` says it pushed, and to add `agent:update-branch` otherwise.

**The re-request.** Only on a run that finished, and not where `published.json` says
`update-branch:publish` asked for the resolution's review: the two are one hand-off or the other,
never both. The head the run left is `published.json`'s `head` where it pushed, and `HEAD_SHA`
otherwise. Where the pull request is open and its head is another commit, because somebody pushed
while the run worked, `agent:update-branch` is added again with the loop's token; not while
`agent:review`, `agent:fix` or `agent:update-branch` is on, which is a queued run a request would
cancel (a notice); and, where `LOOP_TOKEN_SOURCE` is neither `app` nor `pat`, a warning and a
comment saying no refresh of the new head will start, with the workflow token. A pull request
that is gone (a 404) is said as gone, and one that could not be read as a read that failed: two
sentences, and neither blocks, since the run finished.

**The hand-back** (#589). On a run that finished, refused and stopped runs never, after the
re-request where there is one, and whether or not publish asked for a review: where the pull request
is open and carries `agent:merge`, that label is removed and added again with the loop's token, so
the merge gate rules on the head the run left. The gate that asked for this refresh ended there, and
the one the refresh's own push started may have read the head before the arm was carried on to it,
and waited (§12); the loop's `agent-merge` post is no trigger. That gate merges, waits, or disarms a
resolution's head, and a label the loop adds never arms. Where `LOOP_TOKEN_SOURCE` is neither `app`
nor `pat` it is not re-added, and warns. A pull request that could not be read is not one without
`agent:merge`: the hand-back is skipped and warns, naming the label and the retry, on every path,
the ones that ask for nothing again included. A run that stopped leaves `agent:blocked` and the arm
for the maintainer, and re-adds nothing.

Each directory is read on its own, so a file that does not read is a warning and is read as not
written, and costs the comment no reason another producer gave; a `published.json` that does not
read asks for nothing again. Every write is tolerated: one GitHub refuses is a warning, so a run
that cannot comment still takes its label off. The re-request and the hand-back are made with
`LOOP_TOKEN`; everything else with `GH_TOKEN`.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | optional | `""` | The token whose writes start the loop's next workflow: the re-request and the hand-back. Empty where it was not minted, which is one of the endings this reports. |
| `LOOP_TOKEN_SOURCE` | optional | `""` | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `PR_NUMBER` | required | | The pull request. |
| `HEAD_SHA` | required | | The head the run started from, as the event that asked for it saw it: the head it left where it pushed nothing. |
| `REFUSED` | optional | `""` | Accepts `true` or `false`: `false` where the gate claimed the run, `true` where it refused. Empty is a gate that died before it decided. |
| `GATE_RESULT` | required | | How the gate's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `GATE_REASON` | optional | `""` | The sentence `update-branch:gate` or `update-branch:merge` failed with, where it failed after the run was claimed, such as at the permission probe or the base's fetch. |
| `STATUS` | optional | `""` | Accepts `uptodate`, `clean` or `conflicts`: what `update-branch:merge` came to. Empty where it came to nothing. |
| `AGENT_RESULT` | required | | How the agent's job ended: `success`, `failure`, `cancelled` or `skipped`. |
| `TIMED_OUT` | optional | `""` | `true` where the agent's job ran its whole limit. |
| `TIMEOUT_MINUTES` | optional | `""` | That limit, for the comment. |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting `LOOP_TOKEN`: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `DOWNLOAD_OUTCOME` | optional | `""` | The same, for fetching the agent's hand-over. Read only where `STATUS` is `conflicts`. |
| `PUBLISH_OUTCOME` | optional | `""` | The same, for `update-branch:publish`. |
| `PUBLISH_DIR` | directory | | `update-branch:publish`'s `OUTPUT_DIR`. Reads `published.json` (where written) and `failure_reason.txt` (where written). |
| `PREPARE_DIR` | directory | | `update-branch:prepare`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `UPDATE_BRANCH_DIR` | directory | | The `update-branch` runner's `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `BUNDLE_DIR` | directory | | `update-branch:bundle`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the link to the run the failure comment names. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The pull request `PR_NUMBER` names, on a run that finished: its state, its head and its labels,
  for whether to ask again, where it asked for no review, and whether it carries `agent:merge`, for
  the hand-back. A 404 is a pull request that is gone.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the publish job's step after `update-branch:publish`, run `always()`,
> from `RUNNER_TEMP`. It is told the gate's `refused` output, result, `status` output and
> `failure-reason` output, which the gate job's glue steps copy from `update-branch:gate`'s and
> `update-branch:merge`'s reason files, the agent's job's result and its `timed-out` output, the
> limit as `AGENT_TIMEOUT_MINUTES` or 30, and the outcomes of the mint, the download and
> `update-branch:publish`. `timed-out` is the agent's job's last step's, `always()`, which compares
> the time since the gate's clock with the limit, less a minute, wherever that job did not succeed:
> glue only Actions can do, and the one output that job declares. `PUBLISH_DIR` is
> `update-branch:publish`'s `OUTPUT_DIR`, and `PREPARE_DIR`, `UPDATE_BRANCH_DIR` and `BUNDLE_DIR`
> where the agent's artifact is downloaded. It is handed both tokens, the loop's empty where the
> mint failed; with `update-branch:publish`, the only steps in the job that are. Both commands'
> write logs are uploaded `always()`.

## 11. `follow-ups`

Trigger label: `agent:follow-ups`, added to a closed pull request; and every merge of a
same-repository pull request, labelled or not. `doctor` does not demand the label, since only a
repository that installed the filing caller reads it.

A workflow with no runner: two commands, the filing and its ending, and no agent. The run has
**two jobs** (#544). On every merge, labelled or not, it posts the **post-merge checklist**: one
comment listing the *After merge, by a human* items of the linked issue's latest brief, or on a PRD
PR of the parent's and every sub-issue's, each under its issue. Then, only where
`agent:follow-ups` is on, it **files** the out-of-scope findings: the label gates the filing alone.

> **Service orchestrator:** the dispatcher starts a `follow-ups` job on either of `follow-ups.yml`'s
> two entry points, each behind the fork guard every route has. **A merge**: a `pull_request`
> `closed` delivery whose `merged` is literally `true`, whatever its labels, as Actions starts its
> job on every merge (#544): the checklist is posted on every merge, and `follow-ups:file` reads the
> marker live to decide whether to file, as on Actions. A merge with neither ends silently, and a
> close without a merge is ignored with its reason logged. A merge has **no author gate**: whoever
> merged could write, and a merge queue or auto-merge can send the event as a bot that a sender check would refuse, dropping the
> follow-ups without a word, and Actions' job checks no sender either. **The manual entry point**:
> `agent:follow-ups` added to a closed pull request, merged or not, with the author gate every
> other label has; on an open one it is refused, as Actions' condition refuses it. Either way the
> job carries the pull request's number alone, since nothing is checked out, and its time limit is
> the job's `timeout-minutes`, 10.
>
> The worker asks for one `write` token and runs `follow-ups:file` with it, with the App's login as
> `AGENT_LOOP_LOGINS`, since the review it reads was posted as the App, and then
> `follow-ups:conclude` with the same token, however `file` ended, pointed at its directory. It
> checks nothing out and runs no setup, no sandbox and no agent; each command runs in the run's own
> directory. `follow-ups:file` gets the 10 minutes, and one still running at it is ended:
> `follow-ups:conclude` is then told `JOB_STATUS` `cancelled` and `TIMED_OUT` `true`, as the
> *Measure* step says it, and `TIMEOUT_MINUTES` 10, and gets 10 minutes of its own. Otherwise it is
> told `success` or `failure`, and `TIMED_OUT` `false`. `RUN_URL` is the App's own page, as the
> implement commands are given. Where no token is granted, neither command runs, the marker stays
> on, and the worker's log says why.
>
> The token is the App's, so the stubs are filed as the App's bot, where Actions files them with
> the workflow token, which starts no workflow. A stub carries `needs-triage` and `pr-follow-up`,
> neither of them a trigger label, so the `issues` deliveries its labels send start nothing.
>
> **Concurrency relies on one worker.** Actions holds this job in the pull request's concurrency
> group, so a label added while a merge's run files cannot file twice. The service has no lock of
> its own: the worker's queue runs one job at a time, so a second run starts only once the first
> has ended, finds the checklist it posted and the marker it took off, and ends silently. A deployment with more than one
> worker would lose that guarantee.

### `follow-ups:file`

Posts the post-merge checklist, then files the out-of-scope findings a pull request's reviews
recorded, as issues, where `agent:follow-ups` is on. It runs no model, so it needs no `claude` and
no checkout.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The merged pull request. |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- Whether the pull request merged, read live: the checklist is posted only where it did, since the
  manual entry point also runs on a pull request closed without merging.
- The pull request's body, for its linked issue: the first `Closes #<n>`, `Fixes #<n>` or
  `Resolves #<n>`. Where that issue has sub-issues it is a PRD's parent, read first, then each
  sub-issue in the sub-issue list's order, open or closed.
- Each of those issues' body and comments, with their authors, and from them the latest brief: the
  last trusted text, oldest first, with an acceptance section, as the review reads it (§4.3). Its
  *After merge, by a human* items are the checklist's, each passed through `clean`. An issue's body
  is read only where its author passes the trust gate (§4.1), and its comments one by one the
  same way. A linked number that is no issue of this repository (a pull request, an issue deleted
  or transferred out) names no brief, and posts no checklist. Any other that cannot be read fails
  the run, but only after the filing, which it never prevents.
- The comments on the pull request, for a checklist already posted: one carrying
  `<!-- agent:post-merge-checklist -->` by the loop's identity. One by anyone else does not count.
- `agent:follow-ups` on the pull request, read live, which gates the filing and nothing else, so a
  merge without it files nothing, and a second run files nothing.
- The newest review by the loop's identity carrying `agent-follow-ups`; an edited one is refused,
  after the checklist is posted.
- Every `pr-follow-up` issue, with the key in its body, so as not to file one twice.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the job's step after the Node setup, from `RUNNER_TEMP`, in the one
> job, which checks nothing out. The command files the issues through the writer, with its
> `GH_TOKEN`, which can write issues, unlike any runner's, and its `OUTPUT_DIR` is a `file/`
> directory of its own, which `follow-ups:conclude` reads. Its write log is kept as an artifact
> however the job ended, beside `follow-ups:conclude`'s.

### `follow-ups:conclude`

Ends every filing run, success included. It runs no model and needs no checkout. It is told how
the job ended and whether it ran out of time, and works out the ending from them:

- **A run that finished** (`JOB_STATUS` is `success`): nothing. The report is `follow-ups:file`'s,
  and a merge with no checklist and nothing to file stays silent.
- **A run that stopped** (`failure` or `cancelled`): one comment, `` **`agent:follow-ups`
  stopped:** `` and the reason as a sentence, starting with a capital and ending in a full stop
  (#253), the run's link, and `` The post-merge checklist may not have been posted, and some
  follow-up issues may not have been filed. To try again, remove `agent:follow-ups` and add it
  back. Where it is not on, adding it is the retry, but it also files the follow-ups the review
  recorded; re-running the failed job on Actions retries without filing. Nothing is posted or filed
  twice. ``

The reason is, in this order: `` It timed out after <TIMEOUT_MINUTES> minutes. `` where `TIMED_OUT`
is `true`; `It was cancelled before it finished, by hand or by GitHub.` where the job was cancelled;
the `failure_reason.txt` `follow-ups:file` wrote; and failing those, `It stopped without giving a
reason. The workflow run's log has the details.` The reason file is not read on a timeout or a
cancel, and one that cannot be read is a warning and is read as not written. The strings are
`FOLLOW_UPS_STOPPED` and `followUpsStoppedComment` in `shared/record.ts`.

It never takes `agent:follow-ups` off: `follow-ups:file` takes it off last and only on a plan that
asked, so on a run that stopped it still says the findings are unfiled, and removing and re-adding
it is the retry. It never adds `agent:blocked`: a merged pull request has no pipeline left to
block. It may write one comment and nothing else, with `GH_TOKEN`, and a comment GitHub refuses is
a warning.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `PR_NUMBER` | required | | The merged pull request. |
| `RUN_URL` | required | | The run's page, which the failure comment links. |
| `JOB_STATUS` | required | | How the job ended: `success`, `failure` or `cancelled`. |
| `TIMED_OUT` | optional | `""` | `true` where the job ran its whole limit. |
| `TIMEOUT_MINUTES` | optional | `""` | That limit, for the comment. |
| `FILE_DIR` | directory | | `follow-ups:file`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

Nothing: what it says comes from its inputs and its directory.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the job's step after `follow-ups:file`, run `always()`, from
> `RUNNER_TEMP`. The job's first step starts a clock, and a step before this one, also `always()`,
> measures whether the job ran out of time: a cancelled job that ran its whole limit, less a
> minute, did, and a limit that is not a positive integer reads as no timeout. That step and this
> one read the limit from the job's `TIMEOUT_MINUTES`, which `tests/workflows.test.ts` holds equal
> to its `timeout-minutes`. It is told the job's status and that step's `timed-out` output.
> `FILE_DIR` is `follow-ups:file`'s `file/` directory, and its own `OUTPUT_DIR` is a `conclude/`
> directory, so the reason file it reads is never its own. Both commands' write logs are uploaded
> `always()`. A failure before the package installs, the Node setup's own, posts nothing: the run
> never got as far as the command.

## 12. `merge`

Trigger label: `agent:merge`, added to an open, ready pull request from the repository's own
branches; and a push to a pull request carrying it (`synchronize`, #589). The `merge` caller job is
opt-in: a repository that deleted it has a label that does nothing, so `doctor` checks that the
label exists only where that caller is installed, reports one installed with neither the loop's App
nor `AGENT_PAT` set as an error, and one whose caller file lists no `synchronize` as a warning,
since a push then disarms nothing when it lands.

A workflow with no runner: three commands and no agent, in **one job that checks nothing out**, so
the loop's token is minted where neither an agent nor the pull request's own code runs (ADR 0003).
Adding `agent:merge` **is** the maintainer's merge decision, for the head it was added at, and the
loop only carries it out ([ADR 0009](./adr/0009-agent-merge-executes-the-human-decision.md)).
`merge:gate` records the decision as the **arm**, an `agent-merge` status on that head (§4.3),
posted with the loop's token, and decides from the record whether the head merges now.
`merge:publish` makes the squash merge on that decision alone, guarded on the head the gate
checked. `merge:conclude` says a run that stopped. Nothing else merges: a pull request no human
armed is never merged, and a head that gained any commit since the arm is disarmed rather than
merged.

The label is not a run's label. Its lifecycle is **armed until merged or disarmed**: `merge:gate`
takes it off where it refuses or disarms, `merge:publish` after the merge, and `merge:conclude`
where a run stopped, and a run that merely ends leaves it on. The gate's decision, in
`gate.json`, is one of:

- `merge`: the head carries an arm, is current with its base, every counted check passed and the
  newest verdict approves it. `merge:publish` merges it.
- `wait`: the head carries an arm, and another trigger label is on, a counted check or the verdict
  is still pending, or whether it is current could not be told, when the bound ran out; the head
  carries no arm yet while `agent:update-branch` is on, since that refresh's push starts a gate
  before its carry of the arm may have landed, and its conclusion re-starts the gate (§10); or the
  pull request stopped being open and ready while the gate waited. Nothing is said, and the label
  stays on.
- `behind`: the head carries an arm and nothing on it is red, but the base's tip is not in its
  history. `agent:update-branch` is asked for with the loop's token, and the arm stays: a clean
  refresh carries it on to the merge commit (§10). Said once per head.
- `red`: the head carries an arm, and a counted check failed or the newest verdict is not an
  approval. Said once per head; the arm and the label stay.
- `disarmed`: the head carries no arm, or is behind again after its arm's third clean refresh.
  Said, and the label taken off.
- `refused`: the run was refused before anything was armed. Said, and the label taken off.

The run starts on `agent:merge` being added, and on a push to a pull request carrying it. Only an
addition by someone who can write arms, the head they added it at; a push and the loop's own
addition re-start the gate and arm nothing. Besides a human, the loop re-adds the label, removed
first, with its token, in three places, so a gate that ended `wait` or `behind` is started again
when what it waited on lands (#589):

- `update-branch:conclude`, on a refresh that finished, on a pull request carrying it (§10): the
  hand-back, after a clean refresh, a resolution, or a branch already up to date.
- `review:conclude`, on an approval of a pull request carrying it with no other trigger label on
  (§8): the review waits for CI, so its approval is usually the last thing to land.
- A push, which is not a label but GitHub's `synchronize`: the disarm is said when the head moves.

**An arm survives at most three clean refreshes** (`MAX_REFRESHES` in `merge/gate.ts`, a constant
rather than a setting: a setting is a caller input, which lands in two releases, and this bounds a
pathology rather than expressing a preference). Its count is in its description (§4.3), raised by
each clean refresh's carry. A gate that finds an armed head behind after the third does not ask for
a fourth: it disarms, saying the base moved past it three times while it waited, and that adding
`agent:merge` again re-arms the head as it is, which a human's re-add does at count 0. It asks for
no fresh merge-check, since the head is the armed commit plus clean merges of the base.

> **Service orchestrator:** does not serve `agent:merge` at this release. The label is not in
> `SERVICE_LABELS`, so on a service-served repository it is answered by nothing, and `doctor` names
> it as such (§4.2). The service's `merge` job kind is a later release's.

### `merge:gate`

Refuses, arms, or decides the head. It runs no model and needs no checkout. In order:

- **The refusals the event settles**, before anything is read: a pull request whose `PR_STATE` is
  not `open`, or that is `PR_MERGED`, with `This PR is closed.`; a draft (`PR_DRAFT`); a fork, whose
  `HEAD_REPO` is not `GH_REPO`; and a `LOOP_TOKEN_SOURCE` that is neither `app` nor `pat`, since an
  arm posted with the workflow token is one any workflow in the pull request's branch could post
  too, and a merge made with it starts no workflow.
- **The labeller.** On `ACTION` `labeled`, where `SENDER` is not `LOOP_LOGIN`, compared without
  regard to case, their permission on the repository is read with the loop's token. A push
  (`synchronize`) reads none: it arms nothing. Anything but `admin`, `maintain` or
  `write` is refused, and so is a permission GitHub answered without establishing; a read that
  fails fails the command, writing nothing.
- **A refusal** is said in the loop's one order: the comment, `` **`agent:merge` didn't run:** ``
  and the sentence, as `mergeRefusal` in `shared/record.ts` spells it; then `agent:merge` off. Both
  are tolerated, so a comment that fails still takes the label off. It never adds `agent:blocked`:
  a refusal is a decision, and the command succeeds.
- **The arm.** On a label `SENDER` added who is not the loop token's account, the live head is read
  first. Where it is still `HEAD_SHA`, the arm is posted on `HEAD_SHA` with `LOOP_TOKEN`:
  `agent-merge`, `success`, its description naming `SENDER`, the time and a refresh count of 0
  (§4.3). Where it has moved, a label
  added just after a push carrying the commit before it, the run disarms instead and arms nothing.
  A status GitHub refuses fails the command, naming the grant to check: the App's Commit statuses:
  write, accepted on the installation, or a PAT that can write commit statuses. A label the loop
  token's own account added never arms, and nor does a push: each re-starts the gate on a head
  already armed, and disarms any other.
- **The head.** Read live, then polled every `CHECK_POLL_SECONDS`, up to `CHECK_WAIT_SECONDS`,
  while anything is pending. In order:
  - A pull request no longer open, or now a draft: `wait`, and nothing said.
  - **No arm**: the newest `agent-merge` status on the head whose creator is `LOOP_LOGIN`, where it
    is `success`, is the arm, and anything else is none; with `LOOP_LOGIN` `github-actions[bot]`
    no status is an arm at all. A head with none while `agent:update-branch` is on is a `wait`,
    nothing said and no label taken off: the refresh hands back to the gate when it is done. A
    head with none otherwise is **disarmed**: the comment, `` **`agent:merge` disarmed:** ``,
    naming who armed which commit where the record says (the arm this run posted or read, else the
    one on `HEAD_SHA`, else the newest on the pull request's commits before the head, newest first
    and at most 20, a read that fails naming no one), the head, and the retry, `/merge-check` on
    the head and `agent:merge` added again, as `disarmComment` spells it; then `agent:merge` off,
    both tolerated. It never says what kind of push moved the head: the record cannot tell a
    human's from an agent's.
  - **Another trigger label** on the pull request, `agent:review`, `agent:fix` or
    `agent:update-branch`: pending, since that run moves or reads the head.
  - **Red**: a counted check failed, or the newest `agent-review` status of the loop's accounts
    (§4.1) is a state other than `success` or `pending`. Said once per head, the comment ending in
    `<!-- agent:merge-red <sha> -->` (§4.3), the arm and the label left on: `red`.
  - **Behind**: the compare of `BASE_REF` with the head reports the head `behind_by` one commit or
    more. Where the arm's refresh count is under three, said once per head, the comment ending in
    `<!-- agent:merge-behind <sha> -->`, then `agent:update-branch` removed and added with
    `LOOP_TOKEN`, the arm and the label left on: `behind`. Another trigger label on is a wait
    above, so none is added then. An add GitHub refuses fails the command, naming the way on. Where
    the count is three or more, **disarmed** instead: the comment `` **`agent:merge` disarmed:** ``
    naming who armed it, that the base moved past it three times while it waited, and that adding
    `agent:merge` again re-arms the head as it is, as `mergeRefreshCapComment` spells it; then
    `agent:merge` off, both tolerated, and no `agent:update-branch`.
  - **Pending**: a counted check unfinished (a check run not completed, a status `pending` or
    `expected`), no verdict of the loop's accounts or a `pending` one, or a compare that gave no
    count. At the bound, `wait`, nothing said, the label left on.
  - Otherwise `merge`.

The **counted checks** are the ones the base requires of this pull request, by GitHub's own
`isRequired`, rulesets and branch protection alike. Where it requires none, every check on the head
counts but the loop's own, as `shared/loop-checks.ts` knows them: a check run whose name either side
of ` / ` is one of the loop's job ids, `merge` among them, and the `agent-review` and `agent-merge`
statuses. A check run passes on `SUCCESS`, `NEUTRAL` or `SKIPPED`, and a status on `SUCCESS`.

**Once per head** is a comment by the loop's accounts (§4.1) already carrying the head's mark; one
by anyone else does not count, and a comment read that fails says it again rather than not at all.

The arm, the labeller's permission and the refresh asked for are the loop token's; every other
write is made with `GH_TOKEN`, since none of them has to start a run. It writes at most one
comment, one label off (`agent:merge`, or `agent:update-branch` before it is added), one label
added, and one status. `gate.json` is written the moment it decides and again however the command
ends; one that failed before deciding writes `{}`, and one whose inputs could not be read writes
none.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | required | | The loop's token, the App's or `AGENT_PAT`: the arm is posted with it, the labeller's permission read with it, and `agent:update-branch` asked for with it. |
| `LOOP_TOKEN_SOURCE` | required | | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. Anything but the first two is refused. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1): whose verdicts and comments it reads as the loop's. Empty is that one alone. This is trust. |
| `LOOP_LOGIN` | required | | The account `LOOP_TOKEN` writes as, in REST's spelling: the App's `<slug>[bot]`, or the PAT's owner. An arm is read only where this account posted it, and a label it added never arms. |
| `PR_NUMBER` | required | | The pull request. |
| `BASE_REF` | required | | Its base branch, which the head has to be current with. |
| `ACTION` | required | | Accepts `labeled` or `synchronize`: the event's action. Only `labeled` arms. |
| `SENDER` | required | | Who added the label, or who pushed, in REST's spelling. |
| `HEAD_SHA` | required | | The head the label was added at, or the push left, as the event saw it, a full commit id: the commit a writer's label arms. |
| `HEAD_REPO` | required | | The head's repository, `owner/name`. One that is not `GH_REPO` is a fork, and refused. |
| `PR_STATE` | required | | The pull request's state as the event saw it: `open` or `closed`. |
| `PR_MERGED` | optional | `""` | `true` where the event saw it merged. |
| `PR_DRAFT` | optional | `"false"` | Accepts `true` or `false`: whether the event saw it a draft. |
| `CHECK_WAIT_SECONDS` | optional | `"900"` | How long it waits while anything on the head is pending: the review's CI wait, which a test holds it equal to. |
| `CHECK_POLL_SECONDS` | optional | `"20"` | How often it reads the head meanwhile. |

#### Outputs

| Output | When it is written |
|---|---|
| `gate.json` | Where it read its inputs: `decision`, one of `merge`, `wait`, `behind`, `red`, `disarmed` and `refused`, and `head`, the head it checked, where it read one. `{}` where it failed before deciding. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The pull request, read live: its state, whether it is a draft, its head and its labels.
- `SENDER`'s permission on the repository, with the loop's token.
- The statuses on the head, every page: the newest `agent-merge` by `LOOP_LOGIN`, and the newest
  `agent-review` by the loop's accounts (§4.3). Where the head is not `HEAD_SHA` and this run armed
  nothing, the statuses on `HEAD_SHA` too, for who armed it, which the disarm names; and where that
  names no one, the pull request's commits and the statuses on the newest 20 before the head.
- The checks on the head, through its status rollup, with whether the base requires each of this
  pull request.
- The compare of `BASE_REF` with the head, for `behind_by`.
- The comments on the pull request, for the red and behind marks of the loop's accounts.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the job's step after the Node setup, from `RUNNER_TEMP`, in the one
> job, which checks nothing out. The job runs only on a same-repository pull request's `labeled`
> event for `agent:merge`, or its `synchronize` event where the payload's labels hold
> `agent:merge` (#589), which the PR-side caller file lists for this job alone and every other job
> it starts skips, in a concurrency group of its own, `agent-merge-<n>`, which both events share,
> not the `agent-pr-<n>` review, fix and update-branch share: the gate polls for the verdict a review
> posts, so holding the review's group would hold that review behind it. A second `agent:merge`
> waits behind the first. Its time limit is 20 minutes, above the gate's bound. The step before
> resolves the loop's token with `.github/actions/loop-token`, asked for `account`, whose `login`
> output is `LOOP_LOGIN`: the App's `<slug>[bot]` from the mint, the PAT's owner read with the
> PAT, or `github-actions[bot]` for the workflow token. A PAT whose owner could not be read leaves
> it empty, and the gate fails at start, naming it. `ACTION`, `SENDER`, `HEAD_SHA`, `HEAD_REPO`,
> `PR_STATE`, `PR_MERGED`, `PR_DRAFT` and `BASE_REF` are the event's, and
> `CHECK_WAIT_SECONDS` and `CHECK_POLL_SECONDS` are left at their defaults. `GH_TOKEN` is the job's
> own, granted `checks: read`, `contents: read`, `packages: read`, `pull-requests: write` and
> `statuses: read`, and no `contents: write` or `statuses: write`: the arm and the merge are the
> loop token's. `OUTPUT_DIR` is a `gate/` directory of its own, which `merge:publish` and
> `merge:conclude` read. A glue step copies `gate.json`'s `decision` into the step output
> `decision`, and nothing where there is no `gate.json`.

### `merge:publish`

Makes the merge `merge:gate` decided, and nothing else. It runs no model and needs no checkout. It
reads `gate.json` before its first write; a decision that is not one of the six, or a `head` that
is not a full commit id, fails it.

- **On `merge`**: the pull request is squash-merged with `LOOP_TOKEN`, **guarded on the head the
  gate checked**, so a head that moved in between is refused by GitHub rather than merged on an
  old decision. The title is the pull request's own and `` (#<n>)``, which GitHub's default gives a
  pull request of more than one commit, passed so a one-commit pull request gets the same. The
  message is left to the repository's squash setting. Then `agent:merge` off with `GH_TOKEN`,
  tolerated: a merged pull request's label is history, not a decision still standing.
- **A merge GitHub refuses** fails the command with GitHub's reason, for `merge:conclude` to say.
  Nothing is retried: whether to try again is the maintainer's decision. A `merge` with no `head`
  fails it too, and nothing is merged.
- **On any other decision**: nothing. The gate said what there was to say.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `LOOP_TOKEN` | required | | The loop's token, the App's or `AGENT_PAT`, which the merge is made with: a merge made with the workflow token starts no workflow, so neither CI on the base nor the follow-ups would run. |
| `LOOP_TOKEN_SOURCE` | required | | Where `LOOP_TOKEN` came from: `app`, `pat` or `workflow`. |
| `PR_NUMBER` | required | | The pull request. |
| `GATE_DIR` | directory | | `merge:gate`'s `OUTPUT_DIR`. Reads `gate.json`. |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The pull request's title, for the merge commit's.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the job's step after the gate, run only where the glue step's
> `decision` is `merge`, from `RUNNER_TEMP`. The head it guards on is the gate's, read from
> `gate.json`, never the event's. `GATE_DIR` is the gate's `gate/` directory, and its own
> `OUTPUT_DIR` a `publish/` directory, which `merge:conclude` reads. It is handed the loop's token
> and the job's own.

### `merge:conclude`

Ends every merge run, success included. It runs no model and needs no checkout. It is told how the
job ended and whether it ran out of time, and works out the ending from them:

- **A run that finished** (`JOB_STATUS` is `success`): nothing. The gate or publish said what
  there was to say, and `agent:merge` is a standing decision, so a run that merely ended does not
  take it off.
- **A pull request that merged** before the run stopped, read live: nothing, since there is nothing
  to retry and nothing left to block. A read that fails is a warning, and read as not merged.
- **A run that stopped** (`failure` or `cancelled`), in the loop's one order: one comment,
  `` **`agent:merge` stopped:** `` and the reason as a sentence, starting with a capital and ending
  in a full stop (#253), the run's link where there is one, and `` To try again, add
  `agent:merge`. ``, as `mergeStoppedComment` in `shared/record.ts` spells it; then `agent:merge`
  off; then `agent:blocked`. A merge GitHub refused is so not retried on every event that follows,
  and adding the label again is the retry.

The reason is, in this order: `` It timed out after <TIMEOUT_MINUTES> minutes. `` where `TIMED_OUT`
is `true`; `It was cancelled before it finished, by hand or by GitHub.` where the job was cancelled;
the mint's failure, in the words `.github/actions/loop-token` uses, where `MINT_OUTCOME` is
`failure`; the `failure_reason.txt` `merge:publish` wrote; the one `merge:gate` wrote; and failing
those, `It stopped without giving a reason. The workflow run's log has the details.` The reason
files are not read on a timeout or a cancel, since what wrote one was stopped, not failing, and one
that cannot be read is a warning and is read as not written.

Every write is made with `GH_TOKEN` and tolerated, so a comment that fails still takes the label
off: one comment, `agent:merge` off and `agent:blocked` on.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `PR_NUMBER` | required | | The pull request. |
| `JOB_STATUS` | required | | How the job ended: `success`, `failure` or `cancelled`. |
| `TIMED_OUT` | optional | `""` | `true` where the job ran its whole limit. |
| `TIMEOUT_MINUTES` | optional | `""` | That limit, for the comment. |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting the loop's token: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `GATE_DIR` | directory | | `merge:gate`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `PUBLISH_DIR` | directory | | `merge:publish`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the link to the run the failure comment names. Empty renders none. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended, as `review:conclude`'s. Not written where it wrote nothing. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- Whether the pull request merged, read live, on a run that stopped.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the job's last command, run `always()`, from `RUNNER_TEMP`. The job's
> first step starts a clock, and a step before this one, also `always()`, measures whether the job
> ran out of time, as `follow-ups.yml`'s does: a cancelled job that ran its whole limit, less a
> minute, did, and a limit that is not a positive integer reads as no timeout. Both read the limit
> from the job's `TIMEOUT_MINUTES`, 20, the figure its `timeout-minutes` states. It is told the job's status, that step's `timed-out` output, and the
> outcome of the token step as `MINT_OUTCOME`. `GATE_DIR` and `PUBLISH_DIR` are the gate's and
> publish's directories, and its own `OUTPUT_DIR` is a `conclude/` directory, so the reason file it
> reads is never its own. The three commands' write logs are uploaded `always()`, as one artifact.
> A failure before the package installs, the Node setup's own, posts nothing: the run never got as
> far as the command.
