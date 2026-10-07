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
meanings are [ADOPTING §3](./ADOPTING.md#3-labels)'s, and each runner's inputs and outputs are
declared once, in [`shared/contract.ts`](../shared/contract.ts), which an orchestrator can import
to build the environment it hands a runner. The tables below are the same facts read twice, and a
test holds them equal, so they are not a copy that can drift.

**Tested, and held by convention.** `tests/platform-spec.test.ts` holds:

- the §2.2 table and each runner's `### Inputs` table to its declaration, on name and on required
  or optional, in both directions;
- the §2.4 table and each runner's `### Outputs` table to its declared output files, in both
  directions;
- that every runner section, and both its tables, are present;
- that each Actions reusable sets every input its runner declares required;
- that the binding words appear only in bold, and never in an orchestrator block.

Everything else here is held by convention: the conventions in
[`CLAUDE.md`](../CLAUDE.md) that name this spec, and review. A default, a meaning, or what an
orchestrator does with a result is prose, and nothing compares it with the code.

**`doctor`.** Each clause says whether `doctor`, the Actions orchestrator's install check, checks
it. Where it does not, the clause says **`doctor` cannot check this.** and why. A clause `doctor`
cannot check is one only an orchestrator's author will catch.

## 1. Terms

- **Runner.** One of six subcommands of this package's binary: `implement`, `implement-prd`,
  `review`, `fix`, `update-branch` and `follow-ups`. It reads its inputs from the environment, does
  its step, and writes files and commits. It is not the agent: five of the six start the agent, and
  `follow-ups` runs no model at all.
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

### 2.1 Invocation

An orchestrator ***must*** invoke a runner as `<bin> <runner>`, with `<bin>` the package's binary,
`agent-workflows`, and no further arguments. All of a runner's input is its environment. A runner
refuses an argument rather than ignoring it, and exits 2.

**`doctor` cannot check this.** The invocation is the orchestrator's code, and `doctor` reads a
repository, not a running orchestrator. The Actions orchestrator's invocation is in its reusable
workflows, which the build reads.

> **Actions orchestrator:** each reusable's runner step is
> `npm exec --prefix "$RUNNER_TEMP" --yes --package=@jeffwlawson/agent-workflows@<version> -- agent-workflows <runner>`,
> with the inputs in that step's `env:` and its job's.

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

Defaults and meanings are prose; the test compares the name and the required column only.

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
| `GH_TOKEN` | required | | The token `gh` reads. The five runners that start the agent only read with it; `follow-ups` files issues with it. |

Each runner's own inputs are in its section, §6 to §11.

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
| `2` | Bad usage: an unknown runner, or an argument (§2.1). Reported the same way. |

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

## 5. Versions

The contract holds within one release. An orchestrator ***must*** pin one exact runner version,
and read this spec at that version's tag.

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

> **Actions orchestrator:** a publish job adds the `Agent-Slice` trailer to the slice's commits,
> pushes the PRD branch, opens the PRD PR as a draft the first time or reuses it, writes the
> progress list and status line into its body, and adds `agent:review`. A run that fails has its
> commits pushed to `RESCUE_BRANCH`, and the `stopped` lists written.

> **Service orchestrator:** the chain moves on only when a review ends on an approval and the
> Actions orchestrator's review advance puts `agent:implement` back on the parent. An orchestrator
> that does not run that advance leaves the chain waiting on a human to add the label.

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
| `GITHUB_SERVER_URL` | optional | `""` | With the next two, the links to the pull request and the run. Empty renders none. |
| `GITHUB_REPOSITORY` | optional | `""` | See `GITHUB_SERVER_URL`. |
| `GITHUB_RUN_ID` | optional | `""` | See `GITHUB_SERVER_URL`. |

### Outputs

| Output | When it is written |
|---|---|
| `review_payload.json` | The review to post: body, findings and the commit reviewed. |
| `summary.md` | The review's body, as a human debugging the run reads it. |
| `review_body.json` | What the body is rebuilt from once the posting knows which thread resolutions held. |
| `thread_resolutions.json` | The earlier findings this review verified, with their replies. Written on every run. |
| `verdict.json` | The commit status to post: context, state and line, and the fix round it starts, if any. |
| `pr_summary.json` | Signals by existing: the title and summary block to write into the pull request. |
| `pr_status.md` | Off a PRD PR, the status line for the pull request's body. |
| `follow_ups.md` | Signals by existing: out-of-scope findings were recorded, to be filed on merge. |
| `park.md` | On a slice round that does not end on an approval: the comment that parks the chain. |
| `park_posted.md` | On a slice round: the comment for a verdict posted whose posting then failed. |
| `park_failed.md` | On a slice round: the comment for a review that fails, written before the work. |
| `progress_running.md` | On a PRD PR: the progress list while the round runs on. |
| `status_running.md` | Its status line, to match. |
| `progress_approved.md` | On a PRD PR: the progress list where the round ends on an approval. |
| `status_approved.md` | Its status line, to match. |
| `progress_parked.md` | On a PRD PR: the progress list where the round parks. |
| `status_parked.md` | Its status line, to match. |

**`doctor` cannot check this.** These tables are the runner's, for the reason §6 gives.

> **Actions orchestrator:** before the runner, the review job waits up to 15 minutes for the pull
> request's other checks and writes `CI_STATUS_FILE` and `CI_RESULT_FILE`, and a separate job may
> run the red check. A posting job then answers and resolves the verified threads, posts the
> review, writes the summary and the status line, posts the verdict and marks the pull request
> ready on an approval. It adds `agent:fix` where `verdict.json` says a fix round starts, marks the
> pull request with `agent:follow-ups` where `follow_ups.md` exists, and on a slice round runs the
> advance: `agent:implement` back on the PRD parent on an approval, or the park comment on its
> parent otherwise.

> **Service orchestrator:** the CI wait is the Actions orchestrator's step, not the runner's. A
> service with no wait of its own leaves both CI files unset, and the review reads the checks as
> unknown, so it never recommends an approval. Chaining is each orchestrator's too: the runner adds
> no label, so a service that does not add `agent:fix` or run the advance leaves the next step to a
> human.

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

> **Actions orchestrator:** a merge that does not conflict is pushed without the runner. Otherwise
> a publish job pushes the resolution, posts `update_comment.md`, carries the earlier verdict over
> to the merge commit or adds `agent:review`.

## 11. `follow-ups`

Trigger label: `agent:follow-ups`, on a merged pull request. `doctor` does not demand the label,
since only a repository that installed the filing caller reads it.

Files the out-of-scope findings a pull request's reviews recorded, as issues. It runs no model, so
it needs no `claude` and no checkout.

### Inputs

| Input | Kind | Default | What it is |
|---|---|---|---|
| `PR_NUMBER` | required | | The merged pull request. |

### Outputs

| Output | When it is written |
|---|---|
| | Nothing beyond §2.4. The result is the issues it files. |

**`doctor` cannot check this.** These tables are the runner's, for the reason §6 gives.

> **Actions orchestrator:** the runner files the issues itself, so its `GH_TOKEN` can write issues,
> unlike the other five runners'. A failure is commented on the pull request.
