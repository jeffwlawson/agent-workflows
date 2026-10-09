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
> it owns, as prototyped on #364. A block for it appears only where it differs from the Actions
> orchestrator in a way a reader would trip on.

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
  named `<workflow>:<step>`: `follow-ups:file`, `review:gate`, `review:collect-checks`,
  `review:red-check-place`, `review:red-check-classify`, `review:publish`, `review:conclude` and
  `review:advance`. §2 says where it differs from a runner.
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
> command's name. The red check's job installs the package first, with
> `npm install --prefix "$RUNNER_TEMP"`, and runs its two commands from `RUNNER_TEMP`, where that
> line finds the install without asking the registry (§8).

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
| `GH_TOKEN` | required | | The token `gh` reads. The runners only read with it; `follow-ups:file` files issues with it, and `review:publish` posts the review, the summary and the verdict with it, `review:conclude` its comments, its error verdict and the labels nothing fires on, and `review:advance` a PRD PR's progress list and its notes there. |

A command that runs where no token is held, as the red check's two do beside the pull request's own
code, reads `OUTPUT_DIR` alone of these: it reads no repository, so it declares neither `GH_REPO`
nor `GH_TOKEN`, and an orchestrator hands it neither.

Each runner's and command's own inputs are in its workflow's section, §6 to §11.

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

> **Service orchestrator:** the CLI is installed on the box or in its sandbox image, and stays at
> whatever version that was. The prototype's first run died on an old one.

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
orchestrator selects. Unset means `none`: the agent runs in the runner's own process environment
and filesystem, and the orchestrator's isolation of the whole run is all there is. In this release
no input selects a provider, so every run is `none`. Whatever provider a runner gains ***must***
support resuming a session, since a runner that extracts a structured result runs the agent twice,
the second time resuming the first session.

**`doctor` cannot check this.** The provider is chosen where the runner runs, not in the
repository.

> **Actions orchestrator:** relies on the quiet default. The runner VM is the isolation, and
> outcomes 1 to 3 are met around the whole job rather than around the agent.

> **Service orchestrator:** the prototype found that Sandcastle 0.12.0, the version this package
> pins, resumes a session only for bind-mount providers. A provider that copies the checkout in
> rather than mounting it loses the session between the two passes, and the extraction fails.

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
carries forward, and the review bodies `follow-ups:file` files from. `review:gate` and
`review:conclude` match a status's creator against it in the REST spelling. Every runner and
command that asks declares `AGENT_LOOP_LOGINS`; `update-branch`, which asks neither question, does
not.

**`doctor` cannot check this.** The login is whichever account the orchestrator posts as, and the
Actions reusable will work out its own App's login at run time (#305); nothing in a repository
names it beforehand.

> **Actions orchestrator:** reviews, comments and statuses are posted with the job's
> `GITHUB_TOKEN`, so as `github-actions[bot]`, and the reusables leave `AGENT_LOOP_LOGINS` unset.
> Only a workflow in the repository can post as it, and adding or editing a workflow takes write
> access, which is why trusting the login is sound there. The loop's App carries pushes, pull
> requests, ready-marks and trigger labels, which no runner reads as text.

> **Service orchestrator:** a service that posts as its own App passes that App's login in
> `AGENT_LOOP_LOGINS` to every runner and command that declares it, and its reviews, verdicts and
> rounds are then read back as the loop's. Left unset, its posts are read as untrusted text, its
> verdicts are not counted, and every round reads as the first.

### 4.2 Labels

What each `agent:*` label means, which object it goes on, and its lifecycle (on while the run
works) is [ADOPTING §3](./ADOPTING.md#3-labels)'s, and the build reads that table. A label is
record: an orchestrator that answers one ***must*** give it that meaning.

A repository ***must*** be served by one orchestrator, for every label. Two listening for the same
label on the same repository would run the same step twice, on the same branch, and post twice.
Split by label, each would run a step of a loop the other started: a label's run adds the next
label, so one orchestrator would be continuing the other's chain, through the record.

**`doctor` cannot check this.** `doctor` checks that each label exists, but which orchestrator
listens is a matter of what is installed where, and a service listens from outside the repository.
Nor can it see whether a service's App is installed on the repository, since that App is the
service's and not the loop's.

What an orchestrator does after a runner returns, including adding the next label, is chaining.
Chaining is each orchestrator's own and is described in each runner's section: review adding
`agent:fix` (§8), fix asking for the next review (§9), and the PRD advance that puts
`agent:implement` back on the parent (§7, §8).

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
| `**Review <r>**`, `**Slice <k> of <n> · #<sub> · review <r>**`, `**Final review · review <r>**` | The round header, the first line of a review or fix comment. | `review:publish`, from `review`'s `review_body.json`, and `fix`, in its outputs | the same three, to tell a PRD PR's rounds apart by slice |
| `<!-- agent-finding <id> … -->` | Each finding's inline comment. A review body carries none since #224. | `review:publish`, from `review`'s `findings.json` and `review_body.json` | `review`, `fix`, as the findings still open |
| `<!-- agent-resolution ADDRESSED -->`, `<!-- agent-resolution WONT_FIX -->` | The reply that closes a finding's thread. | `review:publish`, from `review`'s `thread_resolutions.json` | `review`, `fix`, as the findings settled |
| `<!-- agent-fix:out-of-scope {…} -->` | A note on a finding the fix judged out of scope. | `fix`'s `out_of_scope_notes.json` | `review`, which rules on it; `fix`, to not repeat it |
| `<!-- agent-fix:top-level -->` | A top-level comment the fix posted. Read on a trusted author's post too. | `fix`'s `top_level_comments.json` | `review`, `fix`, to leave the loop's own comments out of the feedback |
| `<!-- agent-fix:conversation-outcomes -->` | The comment saying what the fix did with the conversation. | `fix`'s `conversation_outcomes.md` | `review`, `fix`, the same |
| `<!-- agent-follow-ups {…} -->` | A review body that recorded out-of-scope findings. An edited review's is refused. | `review:publish`, from `review`'s `review_body.json` | `review`, to not record one twice; `follow-ups:file`, to file them |
| `<!-- agent-red-tests {…} -->` | A slice round's review body: the red check's tests. | `review:publish`, from `review`'s `review_body.json` | `review`, on the PRD PR's final review |
| `<summary><b>Acceptance criteria</b>` | A review body's criteria group, its `- **Changed:**` and `- **Unmet:**` lines. | `review:publish`, from `review`'s `review_body.json` | `review`, on later rounds of the same slice |
| `<!--{"version",…,"location","pr","seq"}-->` | The body of a filed follow-up issue. | `follow-ups:file`, which files it | `follow-ups:file`, to not file one twice |

**Markers in a pull request's body.** The orchestrator writes the body; `review:publish` writes
the summary block, its marks and a regular pull request's status line from `review`'s hand-over,
`review:advance` a PRD PR's progress list and status line from `review`'s park hand-over, and the
other blocks are written from a runner's output files. A runner reads them back from the
body.

| String | What it holds | Read by |
|---|---|---|
| `<!-- agent:summary -->` … `<!-- /agent:summary -->` | The review's summary of the pull request. | `review` |
| `<!-- agent:summary-head <sha> -->` | Inside the summary: the commit it was written at, which decides whether it is due again. | `review` |
| `<!-- agent:summary-final -->` | Inside the summary: the final review wrote it. | `review` |
| `Closes #<n>`, `Fixes #<n>`, `Resolves #<n>` | The issue the pull request delivers, whose criteria a review checks. | `review` |

**Commit status contexts.** Read off each of the pull request's commits, newest first, counting
only a status whose creator is the loop's identity (§4.1).

| Context | What it records | Written by | Read by |
|---|---|---|---|
| `agent-review` | The review's verdict on the commit. A state of `error` is no verdict. | `review:publish`, from `review`'s `verdict.json`; `error` by `review:conclude` | `review`, to know what changed since the last verdict |
| `agent-fix-round` | Beside a verdict, with the same target URL: that verdict started a fix round. | `review:publish`, from `review`'s `verdict.json` | `review`, to count fix rounds since the last verdict; `review:gate`, to count the rounds the budget has spent |

**Commit trailers.** Read from the PRD branch's first-parent log.

| Trailer | What it records | Written by | Read by |
|---|---|---|---|
| `Agent-Slice: #<sub>` | The commit is part of slice `<sub>`'s build. Which slice is next, and which commits a slice round reviews, are read from these and nothing else. | the orchestrator, on every commit a build run makes, before the push | `implement-prd`, `review`, `fix` |
| `Agent-Catch-Up: #<sub>` | The commit is the orchestrator's merge of the default branch, made before slice `<sub>`. | the orchestrator | the same three, to keep that merge out of any slice |

**Branch names and refs.**

| Name | What it means | Read by |
|---|---|---|
| `agent/prd-<parent>-<slug>` | A PRD branch, and so a PRD PR, of parent issue `<parent>`. A pull request whose head does not match is an ordinary one. | `review`, `fix` |
| `refs/rescue/<RESCUE_BRANCH>` | An earlier stopped run's commits, fetched for the runner to resume from (§7, §9). | `implement-prd`, `fix` |

**Label events.**

| Event | What it records | Read by |
|---|---|---|
| `agent:fix` added to the pull request | One fix round, automatic or by hand, each time it was added. | `review`, `fix`, `implement-prd`, to count rounds |
| `agent:follow-ups` on the pull request | Findings wait to be filed. Read live, and taken off once filed. | `follow-ups:file` |
| `pr-follow-up` on an issue | An issue `follow-ups:file` filed earlier, read with its body's key. | `follow-ups:file` |

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
> names the same version in its `npm exec`, so one pin selects the YAML and the runner together.

## 6. `implement`

Trigger label: `agent:implement`, on an issue with no sub-issues. `doctor` checks that the label
exists.

Builds one issue as commits on a new branch from the default branch, and fails where the agent
made none. Preconditions: the default
branch checked out, at `BASE_REF`, and a new branch named `BRANCH` created from it and checked out.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. Empty is the baked default. |
| `AGENT_MODEL_IMPLEMENT` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `ISSUE_NUMBER` | required | | The issue to build. |
| `ISSUE_TITLE` | required | | Its title. |
| `BRANCH` | required | | The branch checked out for the work. |
| `BASE_REF` | required | | The branch it was cut from, which the runner counts its commits against. |

### Outputs

| Output | When it is written |
|---|---|
| | Nothing beyond §2.4. The result is the commits on `BRANCH`. |

**`doctor` cannot check this.** These tables are the runner's, held to its declaration by the
build, and an orchestrator other than Actions sets its environment in its own code.

### What it reads from the record

The issue's body and comments, through `isTrustedAuthor` (§4.1): a body or comment by an author
it does not trust is left out of what the agent is shown. Nothing else of the record.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** a publish job pushes `BRANCH`, opens a draft pull request into the
> default branch, links it on the issue, and adds `agent:review` to it.

## 7. `implement-prd`

Trigger label: `agent:implement`, on an issue with sub-issues: a PRD parent. `doctor` checks that
the label exists.

Builds the next sub-issue as commits on the PRD branch. Preconditions: the PRD branch checked out
as `BRANCH`, at the remote's tip, or created from `BASE_REF` on the first slice; and, where an
earlier run of this PRD left commits on `RESCUE_BRANCH`, that branch fetched to
`refs/rescue/<RESCUE_BRANCH>` for the runner to resume from.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. |
| `AGENT_MODEL_IMPLEMENT_PRD` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `ISSUE_NUMBER` | required | | The PRD parent. |
| `ISSUE_TITLE` | required | | Its title. |
| `SUB_NUMBER` | required | | The sub-issue to build. |
| `SUB_TITLE` | required | | Its title. |
| `BRANCH` | required | | The PRD branch. |
| `BASE_REF` | required | | The default branch. |
| `RESCUE_BRANCH` | required | | Where an earlier run of this PRD that stopped left its commits. |
| `PRD_PR` | optional | `""` | The PRD PR. Empty on the first slice, which opens it. |
| `MERGED` | optional | `""` | Set where the orchestrator merged the default branch in before this run. |
| `GITHUB_SERVER_URL` | optional | `""` | With `GITHUB_REPOSITORY`, the link to the pull request. Empty renders none. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |

### Outputs

| Output | When it is written |
|---|---|
| `progress.md` | The PRD PR's progress list, with this slice built. |
| `status.md` | Its status line, to match. |
| `progress_stopped.md` | The progress list, where this run stopped before it finished. |
| `status_stopped.md` | Its status line, to match. |
| `progress_stopped_pushed.md` | The progress list, where this run stopped and its commits were pushed anyway. |
| `status_stopped_pushed.md` | Its status line, to match. |
| `rescue_ignored.md` | Signals by existing: a rescue branch was found and set aside. The note says so. |

**`doctor` cannot check this.** These tables are the runner's, for the reason §6 gives.

### What it reads from the record

- The parent's and the sub-issue's bodies and comments, through `isTrustedAuthor` (§4.1).
- The PRD branch's `Agent-Slice` and `Agent-Catch-Up` trailers (§4.3), for which slices are built.
- The PRD PR's rounds, where `PRD_PR` is set: its reviews headed `## Agent review` by the loop's
  identity, and each time `agent:fix` was added, for the progress list's counts.
- `refs/rescue/<RESCUE_BRANCH>`, where it exists, to resume from.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** a publish job adds the `Agent-Slice` trailer to the slice's commits,
> pushes the PRD branch, opens the PRD PR as a draft the first time or reuses it, writes the
> progress list and status line into its body, and adds `agent:review`. A run that fails has its
> commits pushed to `RESCUE_BRANCH`, and the `stopped` lists written.

> **Service orchestrator:** the chain moves on only when a review ends on an approval and
> `review:advance` puts `agent:implement` back on the parent. An orchestrator that does not run it
> leaves the chain waiting on a human to add the label.

## 8. `review`

Trigger label: `agent:review`, on a pull request. `doctor` checks that the label exists.

Reviews a pull request and writes everything a posting step needs; it posts nothing itself.
Preconditions: the pull request's head checked out as `BRANCH`, and its base, `BASE_REF`, fetched
so the diff matches GitHub's.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. |
| `AGENT_MODEL_REVIEW` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch. |
| `BASE_REF` | required | | Its base branch, which the diff is taken against. |
| `ROUND` | optional | `""` | `final` on a PRD PR's final review; anything else is a slice round or an ordinary pull request. |
| `CI_STATUS_FILE` | optional | `""` | A file of the other checks' results, as evidence for the agent. Empty is "not collected". |
| `CI_RESULT_FILE` | optional | `""` | A file holding `green` or `red`. Empty, unreadable or anything else is unknown, which no approval is given on. |
| `AUTO_FIX` | optional | `""` | `true` where the orchestrator will start a fix round itself on a verdict asking for one. |
| `FIX_ROUNDS_SPENT` | optional | `""` | The fix rounds this pull request has spent, for the verdict's line. |
| `FIX_ROUND_BUDGET` | optional | `""` | The budget, for the same line. Both have to be numbers for it to be written. |
| `RED_CHECK_CONFIGURED` | optional | `""` | `true` where the red check is configured. |
| `RED_CHECK_FILE` | optional | `""` | The red check's report. |

### Outputs

| Output | When it is written |
|---|---|
| `findings.json` | The findings to open a thread for: where each goes, its severity and title, the agent's text, and whether an earlier review had read its code. |
| `review_body.json` | What the body is written from: the verdict, the agent's assessment, the record's entries, the criteria, the follow-ups, and the data behind the header, the round note and the red tests. |
| `thread_resolutions.json` | The earlier findings this review verified: each thread, why it closes, and the agent's note or the maintainer's reply to quote. Written on every run. |
| `verdict.json` | The verdict's key, whether it starts a fix round, and how many findings it leaves open. |
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
- Earlier reviews' `agent-follow-ups`, `agent-red-tests` and acceptance criteria groups.
- The pull request body's `agent:summary` block, and its `Closes #<n>` line.
- The feedback threads, the linked issue and its comments, through `isTrustedAuthor`, with the
  fix's own comments (`agent-fix:top-level`, `agent-fix:conversation-outcomes`) left out.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the review job starts with `review:gate`, before its checkout, and runs
> the rest only where it went ahead, on the commit it settled on, handing the runner its budget and
> its round. Before the runner, `review:collect-checks` waits up to 15 minutes for the pull
> request's other checks and writes the files the runner reads as `CI_STATUS_FILE` and
> `CI_RESULT_FILE`. Where the red check is configured, a separate job runs
> `review:red-check-place`, the adopter's install and test command, and `review:red-check-classify`,
> whose report the runner reads as `RED_CHECK_FILE`. A posting job then mints the loop's token,
> sets up Node, downloads the hand-over, and runs `review:publish`, which answers and resolves the verified threads, posts the
> review, marks the pull request with `agent:follow-ups`, writes the title, the summary and the
> status line, and posts the verdict. `review:conclude` then ends the run however it ended: the
> refusal's note, or the error verdict and the failure comment, or the ready mark; `agent:review`
> off; and the hand-off, `agent:review` again where the head moved, else `agent:fix` where the
> review asked for a fix round. A glue step copies its `ended.json` into the job's outputs, and the
> job keeps both commands' write logs as one artifact. On a PRD PR an advance job follows, which
> sets up Node, mints the loop's token, downloads the runner's park hand-over and runs
> `review:advance`: the progress list for how the round ended, then `agent:implement` back on the
> PRD's parent on a slice round's approval, or the park comment there on any ending but an approval
> or a fix round starting.

> **Service orchestrator:** the CI wait is `review:collect-checks`, not the runner's. A service
> that does not run it leaves both CI files unset, and the review reads the checks as unknown, so it
> never recommends an approval. Chaining is each orchestrator's too: the runner adds
> no label, so a service that does not add `agent:fix` or run the advance leaves the next step to a
> human.

### `review:gate`

Decides, before anything is checked out, whether the review runs, which commit it reviews, and what
kind of round it is. It runs no model and needs no checkout, and it writes nothing to the record:
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
- **The fix-round budget.** `DEPRECATED_AUTO_FIX`, where set, is a budget of 1 (`true`) or 0
  (`false`), and anything else is refused; otherwise `MAX_FIX_ROUNDS`, 3 where unset, and a value
  that is not a whole number is refused, naming it. The rounds spent are the loop's own
  `agent-fix-round` statuses on the pull request's commits, counted once per link. A round starts where fewer are spent than the
  budget and `LOOP_TOKEN_SOURCE` is `app` or `pat`; a count that cannot be read starts none.
- **The round.** On a PRD branch only: `final` where the pull request's body carries the final
  review's mark, else `slice`. A body that cannot be read fails the command.

A refusal of the pre-flight's is a decision, and the command succeeds. A variable it refuses is
written to `refusal_reason.txt` and the command fails, so the run ends as one that didn't run.
`gate.json` is written however the command ends, with what was decided by then.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch, whose tip is read, and which tells a PRD PR. |
| `HEAD_SHA` | required | | The head the request to review named. |
| `PR_STATE` | required | | The pull request's state as the request saw it: `open` or `closed`. |
| `PR_MERGED` | optional | `""` | `true` where the request saw it merged. |
| `HEAD_WAIT_SECONDS` | optional | `"60"` | How long the pull request gets to show a tip that moved on as its head. |
| `HEAD_POLL_SECONDS` | optional | `"5"` | How often it is asked meanwhile. |
| `REVIEW_TIMEOUT_MINUTES` | optional | `""` | The review's own time limit, as configured; empty is the default. |
| `MAX_FIX_ROUNDS` | optional | `""` | The fix-round budget, as configured; empty is 3. |
| `DEPRECATED_AUTO_FIX` | optional | `""` | The deprecated `auto-fix` setting, which wins over `MAX_FIX_ROUNDS` where set. |
| `LOOP_TOKEN_SOURCE` | optional | `""` | Where the loop's token will come from: `app`, `pat` or `workflow`. No round starts on anything but the first two. |

#### Outputs

| Output | When it is written |
|---|---|
| `gate.json` | Always. Its decisions, every value a string: `proceed`, and `refusal` and `blocked` where it refused; `sha`, the commit to review; `budget`, `spent` (empty where it could not be counted) and `start`; and `round` on a PRD PR. A name not yet decided when it ended is absent. |
| `refusal_reason.txt` | Where it refuses a variable: the sentence, before it fails. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `BRANCH`'s tip, and how it relates to `HEAD_SHA`.
- The pull request `PR_NUMBER` names, for its head while it waits and, on a PRD branch, for the
  final review's mark in its body.
- The statuses on the pull request's commits, for the loop's own `agent-fix-round`, counting only
  the loop's own (§4.1).

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the review job's first work, after its clock and a Node set up for it,
> since nothing is checked out yet. `HEAD_SHA`, `PR_STATE` and `PR_MERGED` are the label's event's;
> the budget and the time limit are the caller's repository variables, and `LOOP_TOKEN_SOURCE` is
> the `time-limit` job's choice, made where no agent runs. `OUTPUT_DIR` is `runner.temp`, where the
> job's outcome step reads `refusal_reason.txt`. A glue step copies `gate.json` into step outputs
> under its own names, `always()`, which the later steps' `if:`s, the runner and the posting job
> read; `review:conclude` says the refusal.

### `review:collect-checks`

Waits for the pull request's other checks on `REVIEWED_SHA`, then writes their results for the
runner: evidence for the agent, and one word the verdict's CI half is derived from. It runs no
model, needs no checkout, and writes nothing to the record.

It reads three surfaces, because each sees what the others cannot: the commit's check runs, its
commit statuses (the latest per context), and its workflow runs, the only place a run that is
queued or waiting for approval shows. The loop's own are left out of all three: a check run named
`SELF_CHECK`, or whose name either side of ` / ` is one of the loop's job ids; the `agent-review`
status; and the run `SELF_RUN_ID`, a run whose workflow is named `Agent …`, or one that calls the
loop's reusable workflows.

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
  has not posted yet.

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
linking the review, and `agent-fix-round` beside it where the review claimed a fix round. The
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
| `published.json` | The posted review's URL, `reviewUrl`, written the moment the review is posted. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended. Not written where it wrote nothing. |

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
  and on a PRD PR only on the final review's approval; `agent:review` off; then, where the pull
  request is open and its head has moved on from `REVIEWED_SHA`, `agent:review` again with the
  loop's token, or a comment saying it was not asked for where `LOOP_TOKEN_SOURCE` is neither `app`
  nor `pat`, or nothing where another trigger label is on. Otherwise, on *changes recommended*
  with `FIX_ROUND` `true`, `agent:fix`, removed and added with the loop's token, unless it is
  already on, a newer `agent-review` verdict than this review's stands on the head, or the head
  lacks this review's `agent-fix-round` status. A round that does not start where it should is said
  on the pull request, which is marked ready off a PRD PR, and the command fails.

Every write but the last case's fix round is tolerated: one GitHub refuses is a warning, so a run
that cannot comment still takes its label off. The labels a run fires on (`agent:review` again,
`agent:fix`) and the ready mark are made with `LOOP_TOKEN`; everything else with `GH_TOKEN`.

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
| `ROUND` | optional | `""` | `final` on a PRD PR's final review. |
| `FAILURE_REASON` | optional | `""` | The reason a failed review gave. |
| `REFUSAL_REASON` | optional | `""` | A variable the review refused before reviewing anything. |
| `TIMED_OUT` | optional | `""` | `true` where a cancelled review ran its whole limit. |
| `TIMEOUT_MINUTES` | optional | `""` | That limit, for the comment. |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting `LOOP_TOKEN`: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `DOWNLOAD_OUTCOME` | optional | `""` | The same, for fetching the review's hand-over. |
| `PUBLISH_OUTCOME` | optional | `""` | The same, for `review:publish`. |
| `PUBLISH_DIR` | directory | | `review:publish`'s `OUTPUT_DIR`. Reads `published.json` (where written) and `failure_reason.txt` (where written). |
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the link to the run the failure comment and the error verdict name. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

#### Outputs

| Output | When it is written |
|---|---|
| `ended.json` | `moved`, whether the head moved while the review ran, and `reviewUrl`, the posted review's, where there is one. Written before the fix round's hand-off, so a round that does not start still has it. |
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- The pull request `PR_NUMBER` names, once the review is posted, for its state, its head and its
  trigger labels.
- Where it would start a fix round, the statuses on that head, for the newest `agent-review` and
  the `agent-fix-round` beside it, counting only the loop's own (§4.1).

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the posting job's step after publish, run `always()`. It is told the
> review job's result and outputs, and the outcomes of the mint, the download and publish, and
> reads publish's directory. `ended.json` is copied by a glue step into the job's two outputs,
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
| `ROUND` | optional | `""` | `slice` on a slice round, `final` on the final review. Only a slice round's approval moves the chain on. |
| `MINT_OUTCOME` | optional | `""` | The outcome of minting `LOOP_TOKEN`: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
| `PARK_DIR` | directory | | The `review` runner's `OUTPUT_DIR`. Reads `park.json` (where written) and `progress.json` (where written). |
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the links to the pull request and the run. Empty renders none. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

#### Outputs

| Output | When it is written |
|---|---|
| `write_log.jsonl` | Every write as it lands, one JSON line each, and a last line for how the command ended. |

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
posting step. Preconditions: the head checked out as `BRANCH`, its base, `BASE_REF`, fetched for
diffing, and `RESCUE_BRANCH` fetched to `refs/rescue/<RESCUE_BRANCH>` where it exists.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. |
| `AGENT_MODEL_FIX` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The pull request. |
| `BRANCH` | required | | Its head branch. |
| `BASE_REF` | required | | Its base branch. |
| `RESCUE_BRANCH` | required | | Where an earlier fix run on this pull request that stopped left its commits. |

### Outputs

| Output | When it is written |
|---|---|
| `nothing_to_do.txt` | Signals by existing: there was no feedback to act on. |
| `rescue_ignored.md` | Signals by existing: a rescue branch was found and set aside. |
| `thread_outcomes.json` | The reply to each review thread it was asked about. |
| `conversation_outcomes.md` | What it did with the conversation comments. |
| `top_level_comments.json` | Top-level comments to post. |
| `out_of_scope_notes.json` | Notes on findings it judged out of scope, for the next review to rule on. |

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

> **Actions orchestrator:** a publish job pushes the branch, replies to every thread and closes
> none, posts the conversation outcomes, the comments and the notes, then adds `agent:review` where
> it pushed or left a note, or marks the pull request ready where it did neither. On a PRD PR it
> always asks for the review.

> **Service orchestrator:** the re-review request is chaining, and each orchestrator's. Without it
> the round ends on the fix, with its findings open.

## 10. `update-branch`

Trigger label: `agent:update-branch`, on a pull request. `doctor` checks that the label exists.

Resolves the conflicts of a merge of the base branch into the pull request's branch. Preconditions:
the head checked out as `BRANCH`, with `git merge origin/<BASE_REF>` already run and stopped on its
conflicts. A merge that does not conflict needs no runner.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | required | | The agent's model token. |
| `AGENT_MODEL` | optional | `""` | The model for every runner, where set. |
| `AGENT_MODEL_UPDATE_BRANCH` | optional | `""` | This runner's model, where set, over `AGENT_MODEL`. |
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
> a publish job pushes the resolution, posts `update_comment.md`, carries the earlier verdict over
> to the merge commit or adds `agent:review`.

## 11. `follow-ups`

Trigger label: `agent:follow-ups`, on a merged pull request. `doctor` does not demand the label,
since only a repository that installed the filing caller reads it.

A workflow with no runner: one command, and no agent.

### `follow-ups:file`

Files the out-of-scope findings a pull request's reviews recorded, as issues. It runs no model, so
it needs no `claude` and no checkout.

#### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `AGENT_LOOP_LOGINS` | optional | `""` | The loop's accounts, a comma-separated list, recognised beside `github-actions[bot]` (§4.1). Empty is that one alone. This is trust. |
| `PR_NUMBER` | required | | The merged pull request. |

#### Outputs

| Output | When it is written |
|---|---|
| | Nothing beyond §2.4. The result is the issues it files. |

**`doctor` cannot check this.** These tables are the command's, for the reason §6 gives.

#### What it reads from the record

- `agent:follow-ups` on the pull request, read live, so a second run files nothing.
- The newest review by the loop's identity carrying `agent-follow-ups`; an edited one is refused.
- Every `pr-follow-up` issue, with the key in its body, so as not to file one twice.

**`doctor` cannot check this.** The record is written by the orchestrator's posting code, for the reason §4.3 gives.

> **Actions orchestrator:** the command files the issues itself, with its `GH_TOKEN`, which can
> write issues, unlike any runner's. A failure is commented on the pull request.
