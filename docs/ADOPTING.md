# Adopting this agent loop in another repo

A set of GitHub Actions workflows that let a labelled issue become a reviewed pull request without
a human in the middle — most of them working one issue, one working a parent issue's sub-issues in
sequence onto a single branch, and one — optional — filing the out-of-scope findings a review
recorded, once the pull request has merged. This is what it takes to install them somewhere else.

**Nothing below counts them.** A number in prose is a copy no test reads, so it goes stale in
silence the release after somebody adds a workflow — which is what happened to the nine places this
file used to say *five*. One count survives, in *Keeping the pins fresh*, because there the number
is the argument rather than a fact about the set.

Everything below was learned by hitting it. `docs/friction.md` has the narrative; this file is the
checklist, and it is ordered so the things that fail *silently* come first.

---

## 0. Two commands that do the mechanical half

The runner package carries the install path as two more subcommands of the same binary. Neither
replaces this file — most of what follows is judgement or a credential — but between them they do
the part that is mechanical and check the part that is invisible:

```bash
npx --yes @jeffwlawson/agent-workflows@<version> init      # in the repo you are adopting into
npx --yes @jeffwlawson/agent-workflows@<version> doctor    # once you have done the rest
```

**Configure the registry before either of them.** These two are the only `npx` lines in this file
typed at your own terminal: every other one runs inside a workflow, where `actions/setup-node` has
already written a scoped `.npmrc`. Nothing has written one here, so the scope resolves to npmjs and
`npx` exits `404 Not Found` — which reads as "there is no such package" rather than "you are not
authenticated", and `doctor` cannot diagnose its own absence. **GitHub Packages has no anonymous
install, even for a public package** (§4, *The install is authenticated*). Once, per machine:

```bash
gh auth refresh -h github.com -s read:packages     # if your gh token lacks the scope
npm config set @jeffwlawson:registry=https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken="$(gh auth token)"
```

`init` copies the reference callers out of [`examples/callers/`](../examples/callers/) into
`.github/workflows/`, one caller file per side (§4), as `agent-pr.yml` and `agent-issue.yml`,
substituting the one thing that is per-repo — the version pin — and writes a `SETUP.md` listing
what is left: the secrets (§2), the repository setting (§1), the labels (§3), and the two documents
§6 is about. A `SETUP.md` it did not write is left alone.

It also gives the loop **its own GitHub App** (§2, *The loop's App*), which is the recommended
identity: the loop's pushes, pull requests and trigger labels then carry the App's bot login rather
than yours, and no credential it uses expires. `init` opens GitHub's create-App page with the name
and permissions already filled in; you click Create, then Install, and pick the repositories it may
act on. `init` stores the App's ID and private key as secrets itself, so you never fill in a form
or handle a key file. What it does depends on what is already there:

| Already set | What `init` does |
|---|---|
| the App's secrets, `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` | nothing: it says the loop already writes as its App |
| `AGENT_PAT` | asks whether to switch to an App, defaulting to **no**, at a terminal; run without one (from a script), it keeps the PAT and prints how to switch. `init --app` switches without asking |
| neither | creates the App |
| a secret list it could not read | creates nothing, and names `init --app` |

It **never deletes `AGENT_PAT`**. After a switch it tells you the secret can be deleted and the
token revoked, and leaves both to you.

It also converges the loop's labels (§3): it creates one that is missing, recolours one whose colour
or description differs, and deletes a retired one that no open issue or pull request carries. A
re-run reports each of them `unchanged`. A retired label still in use is left, with the issues and
pull requests carrying it named, and a label it could not write is named with the command.

On a **public** repository it also creates the Actions event policy that lets the callers run on
`pull_request_target` (§1, *On a public repository, `pull_request_target` stops running*), targeted
at the caller files holding the pull-request side's callers, whether it installed them or found
them, and at nothing else. The policy follows the files rather than their names: merge your callers
by hand, re-run `init`, and it rewrites the policy's file list to match. A re-run that finds the
policy already right says `unchanged`. Creating it needs a repository admin; where the token `init` runs with is refused, it
says so and prints the exact `gh api` call and the settings page, and the install still completes.

It **updates on a re-run** rather than refusing, so it is also how you take a release — and an
update moves the pin in the files you have and changes nothing else. A caller is yours (§4): the
`with:` inputs below, a job you renamed, your own `permissions:` additions, a second job in the same
file. So a re-run pins what is installed, leaves a caller you deleted deleted, and names anything it
did not touch rather than writing it back. What it therefore does **not** do is carry across a
change a later release made to a caller itself — `doctor` reports the ones in the table below, with
the fix, and that table is the whole of what it rules on.

`doctor` exits non-zero on every §1 failure detectable from repo state, and names the fix for
each. A row that is a **warning** instead — printed, exit 0 — says so where it stands:

| What it checks | The failure it is for |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` is set, on the repository or shared with it by its organization | §2: every agent workflow fails immediately |
| which identity the loop writes as, read from the same secrets: its App, `AGENT_PAT`'s owner, or neither, which is an error | §2: having neither is three failures at once: [`GITHUB_TOKEN` pushes start CI that waits for approval](#github_token-pushes-start-ci-that-waits-for-approval), [`GITHUB_TOKEN` cannot mark a pull request ready for review](#github_token-cannot-mark-a-pull-request-ready-for-review) and [A label added with `GITHUB_TOKEN` is a silent no-op](#a-label-added-with-github_token-is-a-silent-no-op) |
| the App's secrets are both set or neither is: an ID without a key, or a key without an ID, is an error | §2: half an App cannot mint a token, so every run passes it over and writes as the PAT, or as `GITHUB_TOKEN` |
| Actions may create pull requests | ["GitHub Actions is not permitted to create or approve pull requests"](#github-actions-is-not-permitted-to-create-or-approve-pull-requests), unless the App or `AGENT_PAT` makes it moot |
| every caller that declares a `permissions:` block grants each scope the job it calls spends — the whole of *The permissions per workflow* table below, every scope an error, ruled per job in a caller file holding several | §4 — the label does nothing at all: a caller granting less than a job it calls declares is refused the elevation, and the run is a `startup_failure` with no job log, reported by `gh run view` only as a "workflow file issue" |
| `checks: read` on review, the one scope only a **private** repository *spends* — and an error whatever your visibility | §4 — a public repository is served the poll without the scope, so this one looks optional; the review job declares it, so a caller that omits it is refused at startup on a public repository too |
| `agent-follow-ups`' `contents: read`, the one grant no call in the job spends — and an error all the same | §4 — a `permissions:` block replaces the inherited token rather than adding to it, so dropping the line sets `contents: none`, which is below what the job declares and is refused like any other shortfall |
| a caller that declares no `permissions:` block at all | §4 — it runs with the default token, and the restricted setting is `contents` and `packages` read, which is less than every job here declares: refused at startup too. The permissive setting grants every scope write and under-grants nothing |
| a job with no `permissions:` block of its own in a caller file whose top-level `permissions: {}` grants nothing | §4: it runs with no scope at all, whatever your default, so it is refused at startup. The fix is the job's own block: a grant above `jobs:` is every caller's in the file |
| every caller is pinned to a tag or a SHA | §9 — a ref that moves under a pull request nobody touched |
| every caller passes `AGENT_PAT` to the workflow it calls, unless it passes a working App instead | [`GITHUB_TOKEN` pushes start CI that waits for approval](#github_token-pushes-start-ci-that-waits-for-approval), [`GITHUB_TOKEN` cannot mark a pull request ready for review](#github_token-cannot-mark-a-pull-request-ready-for-review) and [A label added with `GITHUB_TOKEN` is a silent no-op](#a-label-added-with-github_token-is-a-silent-no-op): a called workflow gets only what it is handed, and an optional secret it was not handed arrives as the empty string, so the loop runs under `GITHUB_TOKEN` with the secret correctly set |
| where the App's secrets are set, every caller that writes passes them, named per caller, in either layout; a warning where the secrets could not be read | §2: a caller that does not writes as the PAT's owner, or with `GITHUB_TOKEN`, while every other caller writes as the App, and nothing fails |
| no reusable workflow is called by more than one caller, in one caller file or across several | §4: every event that starts it starts it once per caller, and each run does the whole job: the shape copying the merged files in beside the older layout leaves |
| as a note, the older layout of a caller file per caller, with the merge that makes one label start one run | §4: nothing is broken. A caller you left out, `follow-ups` most of all, is read as declined in either layout, and raises nothing |
| `self-check` is the check run its job produces, byte for byte — **both** halves, and the calling half is that job's `name:` where it has one | §4 — a job that waits for itself for the whole of its 15-minute CI wait |
| the labels exist | §3 — a transition that is a silent no-op |
| no retired label is still here, as a warning with the `gh label delete` that removes it | §3, *Retired labels*: nothing reads it, and it reads as a run in progress that is not |
| the fix-round budget, `AGENT_MAX_FIX_ROUNDS`, is a whole number where it is set; and, as warnings, that a budget above 0 (the default of 3 included) has the App or `AGENT_PAT` behind it, and that no review caller still passes the deprecated `auto-fix` | §3b — a variable the review refuses fails every review; without the App or the PAT no automatic round ever starts, and every verdict asks for `agent:fix` by hand; and the release after this one fails a caller that passes `auto-fix` before any job starts |
| whether the review caller configures the red check, as a note either way; and, as a warning, one that is half configured: a `red-check-command` with no `red-check-report` or no `red-check-test-globs`, named, or either of those with no command | §4, *The red check*: half configured, the check reports itself misconfigured on every review and the review reads what is red as unknown; with no command, the other two are read by nothing |
| the time limits, `AGENT_TIMEOUT_MINUTES` and `AGENT_REVIEW_TIMEOUT_MINUTES`, are positive integers where they are set | §2c: the agent jobs fail before their first step, with no comment and the label left on; the review refuses to start |
| on a **public** repository, an active Actions policy allows `pull_request_target` for every caller that runs on it; silent on a private or internal one, and a warning where the policies or the visibility could not be read | [On a public repository, `pull_request_target` stops running](#on-a-public-repository-pull_request_target-stops-running): from 2026-11-02 a label is added and no run starts |
| how many releases each pin is behind | *Keeping the pins fresh* — a report, not a failure |

The rows it cannot have are
[A label set when the issue is *created* fires no `labeled` event](#a-label-set-when-the-issue-is-created-fires-no-labeled-event)
and [Re-adding a label that is already there fires nothing](#re-adding-a-label-that-is-already-there-fires-nothing).
Each says in §1 why `doctor` cannot check it, and stays prose there.

Everything `gh` could not answer — no auth, no admin — is reported as **unknown** rather than folded
into a pass. Run it in the repository being adopted, or pass `--dir <path>`; it asks GitHub about
whichever repository that directory is.

---

## 1. The failures that look like something else

`doctor` catches every failure below except the two that are an event that never fired, and
[§0's table](#0-two-commands-that-do-the-mechanical-half) says which of its checks is for which.

Read these before setting anything up. Each cost a run to diagnose, and none of them says what is
actually wrong.

### On a public repository, `pull_request_target` stops running

From **2026-11-02** GitHub blocks `pull_request_target` on every public repository that has no
Actions event policy allowing it ([workflow execution protections](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/),
in evaluate mode until then). The pull-request side's callers, `review`, `fix`, `update-branch` and
`follow-ups`, run on nothing else. The label lands, no run starts, and nothing in the loop can
say why: the refusal is GitHub's, before any step of ours exists to explain it. Private and internal
repositories are not affected.

The fix is a policy allowing the trigger for **the caller files holding them only**, so every other
workflow in the repository stays under the default block. `init` creates it, and on a re-run moves
its file list to whichever files hold those callers now; `doctor` fails a public repository without
it. By hand, as a repository admin, **Settings → Actions → Policies**, or the call `doctor`
prints, which has this shape:

```json
{
  "name": "jeffwlawson/agent-workflows callers: allow pull_request_target",
  "enforcement": "active",
  "conditions": { "workflow_path": { "include": [".github/workflows/agent-pr.yml"], "exclude": [] } },
  "rules": [{ "type": "restrict_action_events", "parameters": { "allowed_events": ["pull_request_target"] } }]
}
```

`allowed_events` lists every event the targeted callers trigger on, not only the blocked one: the
documentation does not say whether the list is exhaustive for the files it targets, and listing the
rest is right either way.

### "GitHub Actions is not permitted to create or approve pull requests"

Repository setting **Settings → Actions → General → Allow GitHub Actions to create and approve pull
requests**, off by default. The agent does its work correctly and the run dies at `gh pr create`.

Not a code defect and not in any upstream repo's docs, because both had it enabled long ago and the
requirement is invisible once satisfied. The loop's App (§2) bypasses it entirely, and so does
`AGENT_PAT` (neither is the Actions bot), which is the better fix.

### `GITHUB_TOKEN` pushes start CI that waits for approval

A branch pushed with the built-in token used to start **no** CI run on the resulting PR. Since
2026-06-11 it starts `pull_request` runs that **require approval**
([GitHub's docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)):
nothing errors, and the PR sits there with CI that has not run until a maintainer approves each run
from its page.

The review sees such a run and reads CI as **unknown**, never green, naming the run in its evidence,
so a clean review asks for a human rather than recommending approval of code no CI ran on. The
lasting fix is pushing under an identity that is not the Actions bot: the loop's App, or the PAT
(§2).

### `GITHUB_TOKEN` cannot mark a pull request ready for review

`gh pr ready` fails with `GraphQL: Resource not accessible by integration
(markPullRequestReadyForReview)` **even with `pull-requests: write` granted**. The Actions bot is an
App installation, and this mutation is not in its permission set regardless of the permissions block.

So every agent PR stays a draft — and a draft cannot be merged — until a human runs `gh pr ready`.
The permission being granted and the operation being refused is what makes this one hard to spot.

### A label added with `GITHUB_TOKEN` is a silent no-op

The same anti-recursion rule applies to labels, and this one is the nastiest of the three: the label
*appears on the PR*, so everything looks right, and the workflow it was supposed to trigger simply
never runs.

`agent-implement` cascades to `agent-review` by adding a label, so without the App or the PAT that
cascade is dead while looking alive. The workflow emits a `::warning::` when neither is set for
exactly this reason.

`agent-implement-prd` has it worse: it *chains itself* by re-adding `agent:implement` to the parent
issue, so without the App or the PAT the chain stops after one sub-issue with the trigger label sitting on the
parent, which reads as work in progress forever. It warns too, and names how many sub-issues are
left so the manual remedy is one remove-and-re-add.

### A label set when the issue is *created* fires no `labeled` event

The one failure here that has nothing to do with `GITHUB_TOKEN`, and the only one the App or a
correct PAT does not fix.

Every trigger in this loop listens on `types: [labeled]` and gates on `github.event.label.name`
(one also listens on `closed`: `follow-ups`, which files on a merge).
Labels passed in the **create** call produce only `issues.opened` — they ride along in that
payload, but no `labeled` event is emitted and `github.event.label` does not exist on `opened`. The
label is really on the issue, and the workflow correctly never saw an event.

So **label in a separate call from creation**, always. This bites the moment anything publishes
issues programmatically — a script, a planning skill, an agent seeding its own backlog — and it
looks exactly like the `GITHUB_TOKEN` no-op above, so it gets misdiagnosed as a missing PAT or App.

Recovery on an issue that already carries the label is **remove, then re-add** — which is the next
failure, reached from the other side.

**`doctor` cannot check this.** What went wrong is how an issue was created, by whatever script or
skill created it, and the issue carries the label either way. Nothing in a checkout, or in what `gh`
can read, records the `labeled` event that was never sent.

### Re-adding a label that is already there fires nothing

Same root cause: no state transition, so no event. What differs is when you meet it — this is the
one you hit while trying to *fix* something rather than while setting it up. `gh issue edit
--add-label` and `gh pr edit --add-label` exit 0 either way, and the label is on the issue
afterwards because it was on it before.

The worked example is the follow-ups marker (§3), the label this loop most often asks you to
re-add on purpose — the PRD chain's manual remedy above is the same gesture for the same reason.
`agent:follow-ups` stays on a merged pull request whenever the filing run did not finish: a missed
`closed` delivery, a partial failure, an opt-out you have since reconsidered. Adding it back is how
you drive the run again — and on a pull request that still carries it, adding it back is nothing at
all:

```bash
gh pr edit 42 --remove-label "agent:follow-ups"
gh pr edit 42 --add-label    "agent:follow-ups"
```

Two calls, in that order, and no useful way to tell from the outside that one call would have been
too few.

**`doctor` cannot check this.** The mistake is a call that succeeded and changed nothing: afterwards
the label is on the pull request exactly as it would be had the run started. Nothing in a checkout,
or in what `gh` can read, records that the add fired no event.

> **A warning about diagnosing any of these.** These share a signature with a GitHub Actions platform
> incident — label present, no run, no error, nothing in any log. During one such incident a label
> add was misread here as a further, structural rule (that a GitHub App's label adds are suppressed
> like `GITHUB_TOKEN`'s), which would have written off the App-identity path in `parity.md` §9.4.
> Re-running the same label add hours later dispatched normally, and the loop's App (§2) now adds
> its trigger labels exactly that way. The rules above are documented and
> **retestable**; an outage is neither. Before concluding a trigger is structurally dead, do it
> twice.

---

## 2. Secrets

| Secret | Required | What breaks without it |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | **yes** | every agent workflow fails immediately |
| `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` | the **recommended** identity; `init` sets both | without them, or `AGENT_PAT`, all three failures in §1 |
| `AGENT_PAT` | the **supported fallback**, where there is no App | the same, where there is no App either |

The loop needs an identity that is not the Actions bot for the writes that start the next stage:
its pushes, the pull requests it opens, marking them ready, and the trigger labels it adds (§1).
That is the loop's **App** where its two secrets are set, otherwise `AGENT_PAT`, otherwise
`GITHUB_TOKEN`, under a warning at every write that needed more. One shared step, the
`loop-token` action every reusable workflow names, makes that choice, so no workflow can drift into
choosing its own. An existing install on `AGENT_PAT` keeps working unchanged: switching is offered
(§0), never forced.

There is deliberately no secret for the package install. The runner package is installed from
**GitHub Packages**, which needs a token — but that token is the built-in `GITHUB_TOKEN`, so what a
consuming repo owes is a **permission**, `packages: read` in each caller (§4), not another secret
to mint and rotate. Leave it out of a caller and the run never starts (§4); the 401 at `npx` that
reads like a bad token is the *other* failure on the same seam, and §4's cross-repo caveat is where
that one is.

> **Verified cross-repo, not assumed.** GitHub Packages has no anonymous install even for a public
> package, so it was an open question whether a *consuming* repository's own `GITHUB_TOKEN` would
> be accepted for a package owned by a *different* repository, or whether an explicit package grant
> or a PAT would be needed. A probe run from `jeffwlawson/winget-manifest-lint` — nothing but
> `packages: read` and `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` — installed and ran
> `@jeffwlawson/agent-workflows` successfully. The permission is genuinely all an adopter owes.

### The loop's App

A GitHub App of your own, which `init` creates (§0). Each run mints a token for it that lasts an
hour and works on the one repository the run is in, so a leaked token is worth little and nothing
needs renewing. The loop's pushes, pull requests, ready-marks and trigger labels carry the App's bot
login, so you can tell at a glance what the loop did and what you did. And a pull request the loop
opens is not authored by you, so a branch rule requiring approval from someone other than the
author is one you can meet.

**One App per account or organization**, covering every repository you install it on. Minting a
token needs the App's private key, so an App cannot be shared between owners: there is no public
one to install, and each owner creates their own. `init` suggests a name derived from the owner,
since GitHub requires one unique across all of it; change it on GitHub's page if you like, and
`init` takes the name GitHub actually registered.

Its permissions, already filled in on the page you approve, are the writes `AGENT_PAT` makes and
nothing more:

| Permission | Why |
|---|---|
| Contents: **write** | push the agent's branch |
| Pull requests: **write** | open the PR, mark it ready, add labels to it |
| Issues: **write** | label transitions on issues, and the PRD chain's comment on the parent |
| Workflows: **write** | a push touching `.github/workflows/**` is rejected without it, *after* the agent has done all its work |
| Metadata: **read** | GitHub's own, and required of every App |

It has no webhook: nothing listens for one.

**Workflows: write is acceptable here because neither the key nor a token is ever on the agent's
runner.** `Contents: write` together with `Workflows: write` is the pair that lets a holder push a
workflow into a repository whose runs carry secrets. So the App's secrets are named only in jobs
that never run the agent: the publish job of every workflow that writes code, `implement-prd`'s
`catch_up` job, which pushes the default branch's merge before the agent runs, the review's
`post-review` and `advance` jobs, and the review's `time-limit` job, which only asks which token the
loop would write with and mints none. A job's runner holds every secret the job names from its
first step, so the job that runs the agent names none of the App's secrets and no `AGENT_PAT`, not
even in a step that never runs. Each job that writes mints its own token before its first write
that needs it and hands it to no other job, and the publish job starts on a fresh runner after the
agent has finished, so a long agent run cannot outlast the token that publishes its work.

**Where `init` puts the secrets.** On the organization, shared with its repositories, where the
owner is an organization and you are shown to be its admin; on the repository otherwise: a
personal account, which has no account-level Actions secrets, or an organization where you are not
an admin or your admin status cannot be read. Never on the organization on a guess. Where GitHub
refuses the organization, `init` tries the repository, and names what it could not store.
Repository secrets are one repository's, so a second repository under the same owner needs the
same two set on it too, and the key `init` stored was never written anywhere you can copy it
from. Install the App on that repository, generate a further private key on the App's settings
page, and set both by hand: `init` in a repository with neither creates a new App rather than
looking for one.

**By hand**, if you would rather: create an App under your account or organization with the table
above and no webhook, generate a private key, install it on the repositories running the loop, and
set its ID and the whole key file as `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY`. Both, or the
loop uses neither: `doctor` reports half an App as an error.

**What stays with the Actions bot.** Reviews, top-level comments, thread replies and commit
statuses are still posted with `GITHUB_TOKEN`, as `github-actions[bot]`, so the author gate's trust
in the loop's own earlier posts (§8) and every check that recognises them work unchanged. Moving
those to the App too is a separate change (#305).

### `AGENT_PAT`, the fallback

A **fine-grained** personal access token, for an install with no App. The loop then writes as the
token's owner (you, usually) and stops the day the token expires. Use **one token with every repo
running the loop in its access list**, not one token per repo: rotation is manual and a lapse is
silent, so N tokens means N chances to forget. Permissions:

| Permission | Why |
|---|---|
| Contents: **write** | push the agent's branch |
| Pull requests: **write** | open the PR, add labels to it |
| Issues: **write** | label transitions on issues |
| Workflows: **write** | required wherever agents may touch `.github/workflows/**`, which in *this* repo is unconditional — the workflows are the product. A push touching those paths is rejected without it, *after* the agent has done all its work |

> **On expiry.** A fine-grained token can be set to *No expiration*, and this one should not be.
> `Contents: write` together with `Workflows: write` is the pair that lets a holder push a workflow
> into a repo whose runs carry secrets — which means printing every other secret, including
> `CLAUDE_CODE_OAUTH_TOKEN`, from your own CI. Expiry is the only control that bounds that window
> without depending on you noticing the leak. Take the longest custom date offered — roughly a year —
> and let `token-expiry.yml` give you three weeks of warning. That monitor is what makes a long
> expiry safe rather than reckless. The App has none of this to manage: its tokens last an hour.

The workflows fall back to `GITHUB_TOKEN` when neither the App nor `AGENT_PAT` is set, so they still
run — they just hit §1. That fallback is deliberate: the shape stays identical, and the failure is
loud rather than structural.

> **Set a reminder for the token's expiry, or install `token-expiry.yml`.** A lapsed PAT produces
> [A label added with `GITHUB_TOKEN` is a silent no-op](#a-label-added-with-github_token-is-a-silent-no-op)
> (§1): reviews stop happening and nothing says why. That workflow reads the expiry weekly and
> files an issue at 21 days. It is in this repo and is repo-agnostic, and it checks
> nothing where the App's secrets are set: a warning about a token nothing uses trains you to
> ignore the next one.

**Switching to the App** is a re-run of `init`: at a terminal it asks, and `init --app` switches
without asking (§0). Every caller then has to pass the App's secrets, which the reference callers
do; `doctor` names any that does not. Afterwards, delete the `AGENT_PAT` secret and revoke the
token yourself: `init` says you can, and does neither.

---

## 2b. Choosing the model

Defaults are baked into the runner package (`shared/agent.ts` in its sources), and **most specific
wins**:

| Source | Scope |
|---|---|
| `AGENT_MODEL_<WORKFLOW>` variable | that workflow only — `AGENT_MODEL_REVIEW`, `AGENT_MODEL_UPDATE_BRANCH`, `AGENT_MODEL_IMPLEMENT`, `AGENT_MODEL_IMPLEMENT_PRD`, `AGENT_MODEL_FIX` |
| `AGENT_MODEL` variable | every workflow, **including** ones with their own default — "run everything on X" is the point of setting it |
| per-workflow default in code | `update-branch` → `claude-sonnet-5-5` |
| global default in code | everything else → `claude-opus-5-5` |

`update-branch` is the one mechanical job: the workflow merges in bash and only wakes the agent when
git reports a conflict, so the task is reconciling two known texts rather than designing anything.
Everything else — writing code from a spec, reviewing it, acting on review feedback — gets the
strongest model, because those are the steps where a plausible-but-wrong answer costs the most.

> **`claude-opus-5-5` needs Claude Code 2.1.280 or newer.** An older CLI refuses it outright ("does
> not support this model; version 2.1.280 or newer is required"). The workflows install Claude Code
> unpinned, so CI meets that — it was 2.1.284 when these defaults were set (2026-09-28). The minimum
> matters if you run a runner locally or on a pinned CLI: upgrade it, or override the model with
> the variables above.

Set them as **repository variables** (Settings → Secrets and variables → Actions → Variables). No
commit, no PR, and reverting means clearing the variable.

A **variable**, not a secret, deliberately: secrets are masked in logs, so "which model produced
this?" would become unanswerable. Each run echoes `Agent model: <id> (<source>)` — where source is the
variable that won, `<workflow> default`, or `default` — for the same reason.

> **The one trap.** An unset `vars.X` interpolates to the **empty string**, not to nothing. Resolve
> it with `||`, never `??` — nullish coalescing passes `""` straight through and hands the CLI an
> empty model id. An unset secret is the empty string too, which is what the loop's token fallback
> (§2) reads as "not set".

Pin an explicit id rather than tracking a floating alias, for the reason `.nvmrc` exists: the
runner, CI and a local run must not drift onto different versions. Bumping is then a decision with a
timestamp, which also lets you attribute a change in output quality to it.

The precedence chain is covered by tests in `tests/common.test.ts`, including the empty-string case
above. A wrong order does not error — it quietly runs every agent on the wrong model, and the only
trace is a log line nobody reads until output quality is questioned weeks later.

---

## 2c. Time limits

Every job runs under a `timeout-minutes`. Two are yours to move, as **repository variables** set the
way the model ones are:

| Variable | Default | What it bounds |
|---|---|---|
| `AGENT_TIMEOUT_MINUTES` | 30 | each `implement`, `implement-prd`, `fix` and `update-branch` run |
| `AGENT_REVIEW_TIMEOUT_MINUTES` | 5 | a review's own time, **after** its CI wait of up to 15 minutes |

The review's limit is the two added: 20 minutes with neither set, and a slow CI no longer eats into
the time the review itself gets. The small jobs (`follow-ups` and the review's posting job, which
resolves threads, posts the review and hands off, at 10 minutes, and the ones that advance a PRD
at 5) are fixed.

A value must be a positive integer, written without a leading zero. `AGENT_TIMEOUT_MINUTES` is read
straight into `timeout-minutes`, so a value that is not a number fails those jobs before their first
step, where nothing can comment, and one that is a number but not a whole one (`1.5`) runs, but its
timeout reads as a cancel. The review refuses its own on the pull request. `doctor` reports both.

A run that reaches its limit says so. GitHub **cancels** a job at its limit rather than failing it,
and the failure step runs on both: the comment says "timed out after N minutes", adds
`agent:blocked` and gives a failure's retry instructions. A run cancelled by hand says "cancelled"
instead. The two are told apart by how long the job ran, so a run cancelled by hand in its last
minute reads as a timeout. `follow-ups` comments the same way and, as on a failure, adds no label.

## 2d. The session transcript

Every run that starts an agent uploads the agent's Claude Code session transcript as a workflow
artifact named `agent-transcript`, on the run's page under *Artifacts*. It is the whole session as
Claude Code recorded it: every prompt, every tool call and its result (file reads and edits
included, which the job log never shows), the model's thinking, and its token usage. A failed,
cancelled or timed-out run uploads one too, which is when you are most likely to want it.
`follow-ups` runs no agent and uploads nothing.

**Who can read it.** Anyone who can read the repository's Actions runs can download it: on a
private repository, the people with read access; on a **public repository**, anyone. So treat it as
public on a public repository. Before the upload, every secret the job holds,
`CLAUDE_CODE_OAUTH_TOKEN` and `GITHUB_TOKEN`, is replaced with `[REDACTED]`, the GitHub token also
in the form a checkout's git config holds it in, so a transcript in which the agent printed its
environment does not carry the token. The job that runs the agent holds no `AGENT_PAT` and none of
the App's secrets (§2), so there is none of theirs to redact. What the agent read from your repository
and its issues is in it unredacted, which on a public repository is already public.

**How long.** Three days by default, set by the `transcript-retention-days` input on any agent
caller's `with:` block. A repository or organization limit on artifact retention that is shorter
wins. `0` turns the upload off:

```yaml
    with:
      transcript-retention-days: 0
```

---

## 3. Labels

All of these must exist. A missing label makes its transition a no-op, and the state machine drifts
without erroring.

```bash
gh label create "agent:implement"   --color 8250DF --description "Build this issue, or the next slice of this PRD. On while the run works."
gh label create "agent:review"      --color 0969DA --description "Review this PR. On while the review runs."
gh label create "agent:fix"         --color D4A72C --description "Act on review findings. On while the fix runs."
gh label create "agent:update-branch" --color 1B7C83 --description "Merge the base branch into this PR. On while it runs."
gh label create "agent:blocked"     --color CF222E --description "A run failed or was refused. Needs you."
```

`init` creates these, and recolours any whose colour or description differs, so an install made
before a release changed them catches up on its next run; the block is what to run where it could
not. Each colour is a **stage**: purple is building, blue reviewing, yellow fixing, teal refreshing,
grey a marker, red a run that needs you.

**A trigger label is on while its run works.** The run leaves it on as it starts and takes it off
when it ends, whether it succeeded, failed, was refused, timed out or was cancelled, so the label on
an issue or pull request is the run working on it now. A failure or a refusal also adds
`agent:blocked` and says why in a comment, and a human re-adds the trigger label to retry. A refusal
that leaves you nothing to act on (a closed issue or pull request, a finished PRD, a deleted branch,
a fix with nothing to do) says so and adds no label. It is not
a rule with exceptions, though. It is a three-valued property, and which value a label has is a
**column**:

| Label | Lifecycle | Cleared by |
|---|---|---|
| `agent:review`, `agent:fix`, `agent:update-branch` | **on while its run works** | the run, as it ends |
| `agent:implement` on an ordinary issue | **on while its run works** | the run, as it ends |
| `agent:implement` on a PRD parent | **cursor** | each run, as it ends, and put back by review's advance when a slice round on the PRD PR ends on an approval, which never happens after the final review |
| `agent:follow-ups` on a pull request | **marker, removed on success** | the filing run, on any run that reached a verdict — or you, to opt out |

**Fill the column in when you add a label.** Written as prose this said "consumed on entry, except
on a PRD parent, and also except for the marker" — which is read as "consumed on entry", and the
exception nobody read is the one that behaves differently at three in the morning.

**The loop adds a trigger label by removing it first.** Adding a label that is already there fires
no event (§1), so an add on its own could be swallowed by a stale label; removing an absent one
leaves nothing on the timeline. And a request made **while a run works** is not lost either: adding
the label then fires nothing, since it is already on, so a review or a branch refresh that ends to
find the pull request's head moved since it started, because somebody pushed, asks for itself
again, unless another trigger label is already on it: that is a run queued behind it, and a new
request would cancel it before it could take its own label off. `fix` does not: a second fix run would answer the threads this one answered, which stay open
until a review verifies them.

**A run's own label comes off before the next one goes on.** Every result is posted first, then
the trigger label comes off, then the next step's label goes on: `agent:review` on a hand-off,
`agent:blocked` after a failure or a refusal, whose comment comes first. A review that finds the head
moved while it worked does not start a fix round or advance a PRD chain off its verdict.

**The cursor.** Each `implement-prd` run holds `agent:implement` on the parent while it builds and
takes it off as it ends, and the chain moves on only when it comes back: review's **advance** re-adds it when a slice
round on the PRD PR ends on an approval (§3b, *The verdict on a slice round*). Re-adding it yourself
to a parked chain does not move it on: the run reads the verdict on the PRD PR's head and refuses
without an approval. Nothing re-adds it after the final review, so the chain stops by itself. So on
a parent issue the label is a cursor rather than a one-shot: seeing it there means the next step is
due. An approved slice round with no label on its parent and no run happening means the PAT is
missing (§1), and the PRD PR carries a comment saying so.

**The marker.** `agent:follow-ups` says *this pull request's latest review recorded out-of-scope
findings*. The review half adds it on any run that recorded one and never removes it; removing it
is how an author **opts out** before the merge, and the filing half removes it on any run that
reached a verdict — including one where an earlier attempt had already filed every finding, or
where the latest review retracted them — so a failed or partial run leaves the retry affordance
where it was. Adding it back to a **closed** pull request is the manual entry point, and it is
the gesture
[re-adding a label that is already there](#re-adding-a-label-that-is-already-there-fires-nothing)
in §1 is about: you will reach for it on a pull request that already carries the label, where it
does nothing at all.

`agent:blocked` is applied on failure alongside a comment carrying the reason, on a refusal you have
to act on (a pull request that changed after its label, a repository variable the review cannot
read), and by either `implement` workflow when it refuses an issue's *shape* (a sub-issue, a
nested PRD, or a `wayfinder:*` planning ticket), since re-labelling would only reproduce the same
refusal.

**Retired labels.** `agent:in-progress` went when the trigger labels began staying on while their
run works, and two others before it. Nothing writes or reads any of them.
`init` deletes each one no open issue or pull request still carries, and names the ones that are
still carrying it rather than stripping them; `doctor` reports one that is still here, with the
`gh label delete` that removes it.

**Amend the issue before you label it, never after.** The runner reads the issue body when the run
starts, so an edit made afterwards describes work the agent was never asked to do — the PR then
answers a spec that no longer exists, and the mismatch surfaces as a review finding rather than as
anything obviously a timing problem.

The PRD chain widens this. A parent's body is read fresh **by every slice**, so editing it mid-chain
changes the brief under the slices that have not run yet, and the same PRD PR ends up built against
two different specs. If something has to change after labelling, say so on the PRD PR instead:
that reaches the review and fix agents, which the issue body no longer does.

**Where the labels come from is a separate question.** These are all *workflow state*. If you also
run a triage step — a human or a planning skill deciding an issue is well enough specified to hand
over — that is a second vocabulary, and joining the two is a decision you have to make explicitly.
`docs/agents/triage-labels.md` records this repo's answer: the canonical triage roles, the
`wayfinder:*` planning labels that never trigger a workflow, why `ready-for-agent` → `agent:implement` stays a human hand
rather than an automation, and the one join that is *not* a human hand — a filed stub arriving
`needs-triage`. Take it alongside the workflows and edit the mapping — in the order §4 gives, since
the file is also a skill's output path — and the reasoning survives the rename.

### Three more, and none of them mandated

`doctor` demands none of them. `init` creates and recolours `agent:follow-ups`, the one in the
loop's own vocabulary, and *lists* the other two in the `SETUP.md` it writes, only for a repository
it installed the filing caller into, since a caller you declined is labels nothing will ever read.
They arrived after the labels above, so a repository can be current on the pin without them, and
nothing fails when they are missing, which is the problem. What each absence costs is below.

```bash
gh label create "agent:follow-ups" --color 6E7781 --description "This PR's review recorded out-of-scope findings; they are filed on merge."
gh label create "pr-follow-up"     --color D4C5F9 --description "Filed from a merged PR's review by the follow-ups workflow"
gh label create "needs-triage"     --color D93F0B --description "Maintainer needs to evaluate this issue"
```

- **`agent:follow-ups`** is the marker in the table above, and you want it whether or not you take
  the filing caller (§4). The review step that adds it warns rather than failing, so without the
  label the findings still reach the review body — but nothing marks the pull request, so nothing
  can file them later and nothing can list the ones that went unfiled.
- **`pr-follow-up`** and **`needs-triage`** are what a filed stub arrives carrying, and they are
  required **only if you install the filing caller**. Missing, the runner files the stub
  *unlabelled* and says so with a `::warning::` — a stub outside your triage queue is worth more
  than a finding nobody kept — but an unlabelled stub is invisible to exactly the queue it was
  filed for. Worse for `pr-follow-up` specifically: it is the candidate filter the duplicate check
  lists on, so unlabelled stubs are stubs the next merge cannot see. Filing afresh is the
  *intended* outcome for a chronic finding — since #82 a path match links the earlier issue from
  the new stub rather than suppressing it — but an unlabelled stub cannot be linked, so the triager
  never learns there is already an issue about that file. Sharper still: the same listing is how a
  filing run recognises its **own** stubs, so a run that failed half way through refiles every one
  of them on the retry.
- Both strings are **fixed in the runner**, not inputs. A tracker whose triage label is spelled
  differently gets a stub labelled `needs-triage` beside its own vocabulary rather than inside it;
  relabelling on arrival is a triage rule, not a configuration. This is the one place the two
  vocabularies above touch automatically.

---

## 3b. Reading the verdict

Labels are how you drive the loop; this is how it answers. Every review ends in one of three
assessments, derived from what the review found rather than written in it, and posted as a **commit
status** on the commit that was reviewed — context `agent-review`, linked to the review it is the
verdict on. GitHub shows it in the merge box, so the outcome of a review is readable without
opening the review.

The three are **GitHub's own**: they are the headings Copilot code review opens every overview
with, taken verbatim. If you have read one of those, you already know what ours mean.

| Verdict | Commit status | What GitHub shows you |
|---|---|---|
| **🟢 Approval recommended** | `success` | Approval recommended. Nothing left to fix. You can merge once the PR is ready and no longer a draft. |
| **🟡 Changes recommended** | `failure` | Changes recommended. If the agent isn't already working on them, add the agent:fix label to have it make the changes. |
| **🔵 Needs a closer look**, the review needs your judgement | `failure` | Needs a closer look. Read the review, then tell the agent what to fix, fix it yourself, merge as is, or close the PR. |
| **🔵 Needs a closer look**, a CI check failed | `failure` | Needs a closer look. A CI check failed and the review couldn't trace it to the code. Read the failing check, then fix it or merge as is. |
| **🔵 Needs a closer look**, CI hadn't finished or couldn't be read | `failure` | Needs a closer look. CI hadn't finished or couldn't be read. Once it's done, add agent:review, or merge as is if CI isn't needed. |

The third column is the status description **verbatim**. The review summary opens with the long
form of the same line, under the same heading, so the two cannot tell you different things. Each
line is **fixed**: it is true whatever the pull request's state, PRD or not, whichever round, budget
left or spent, so it never claims something the review cannot know. *Needs a closer look* has three
lines because what you do about it differs by cause, and the review knows the cause; each lists
merging as is among the ways on.

`failure` on anything but the first row is not the loop disliking the change. It is a step left to
do, and it is a `failure` because a green tick beside *add `agent:fix`* would say the opposite of
what it means. Nothing merges or blocks on any of this by default, and the two settings that make it
do so are the last part of this section.

**A run that failed is a fourth state and not a verdict.** It posts `error`, linked to the run:
there is no verdict, and re-adding `agent:review` (§3) retries. The state worth knowing is the
absent one — a commit with no `agent-review` status has not been reviewed, which is deliberate
rather than a gap. A status belongs to a commit, so a push leaves the new head with no verdict
instead of carrying a stale *approval recommended* over code nobody read. The status history on
the pull request is also the whole record of what earlier rounds said; nothing else keeps one.

If a review posted and no verdict arrived with it, it is **not** your caller's `statuses: write`: a
caller granting less than the review job declares is refused before any job starts (§4), so a run
that got as far as posting a review holds the write. What is left is GitHub refusing the status
itself, which is ours rather than yours. The run's warning prints what GitHub replied and says as
much, so read that before you touch the caller. If no run happened at all — no review either — that
is §4's refusal, and `doctor` names the scope.

**The loop keeps it current, and stops short of your hand.** A `fix` run that pushed asks for its
own re-review, so a round closes itself out rather than leaving *add `agent:fix`* standing over a
branch that was already fixed; a clean `agent:update-branch` refresh copies the verdict on to the
merge commit it makes, and one that had to resolve conflicts asks for a review of what it wrote
instead.

**One workflow does add `agent:fix`, up to a budget.** A review whose verdict is *Changes
recommended* adds the label itself while the pull request has automatic fix rounds left:
**3 by default**, set with the repository variable `AGENT_MAX_FIX_ROUNDS` (`0` for none). The
reusable workflow reads the variable from your repository, so it goes in *Settings → Secrets and
variables → Actions → Variables*, and nothing goes in a caller. A value that is not a whole number
fails the review, naming the variable and the value. The rounds spent are counted from the pull
request: a review that asks for an automatic round posts a second status beside its verdict,
context `agent-fix-round` (`success`, "This review asked for an automatic fix round."), and the
count is those statuses, so nothing records the rounds but the pull request itself. Only automatic
rounds count: your own `agent:fix` always starts a round, and your own push resets nothing. It needs
the loop's App or `AGENT_PAT` (§2); without either no round starts, and the 🟡 line asks you for the
label.

The verdict's line is the same 🟡 line either way, and says "if the agent isn't already working on
them" for that reason. The job that adds the label decides from the pull request as it is then, not
as it was: it adds nothing where `agent:fix` is already there or a newer verdict stands, and where
adding it fails, or the `agent-fix-round` status is missing, it says on the pull request that no
automatic fix round started. The pull
request also stays a draft, because the loop is still working and it is not your turn yet. It is
marked ready at the end of that round either way: by the re-review where the fix pushed, and by the
fix run itself where it declined everything and so asked for no re-review. It cannot cycle: the
budget bounds it per pull request, and the **early stop** ends it sooner. After a fix round that
closed none of the findings it was given, no further automatic round starts, whatever budget is
left; findings are matched by the ids the workflow wrote into them, so a finding that comes back
reworded is not progress, and new findings the re-review raised neither count as progress nor reset
anything. A later review may otherwise recommend changes and start another round, so a round that
closed two findings and uncovered a third carries on while budget is left. Once the loop stops, the
verdict is the same 🟡 line, which asks you for the label; on a PRD PR the park comment on the
parent says why it stopped (the budget is spent, or the last round made no progress).

The `auto-fix` input this replaced is **deprecated** and goes in the next release. Where a caller
still sets it, it wins over the variable (`true` is a budget of 1, `false` a budget of 0), and the
run warns. Remove it and set the variable instead.

**Upgrading turns it on.** Before the budget, automatic fixing was the `auto-fix` input and off by
default. A repository that sets nothing now gets **3 automatic rounds** on every regular pull
request, from the first review after the pin bump. That is deliberate: measured over 40 pull requests in this loop, 17
needed a human to add `agent:fix`, and most of the hours they were open were spent waiting on one. If you want your verdicts read first, set
`AGENT_MAX_FIX_ROUNDS` to `0` before you bump, and raise it once you trust them. A regular pull
request is still never merged automatically, whatever the budget.

It needs the loop's App or `AGENT_PAT` (a label added with `GITHUB_TOKEN` fires no event, so nothing
would start). `doctor` warns where the budget is above 0, the default included, and neither is set; it
fails a variable that is not a whole number, and warns on a caller still passing `auto-fix`, naming
the value to set instead.

Everywhere else, `agent:fix` is the human hand in the loop, and the table above is where you are
asked for it.

A **copied** verdict says what it said before: it is the review's word about the branch work, not a
claim about the merge commit it now sits on. That commit's own checks have not been read — they had
not run when the copy was made — so a `success` carried on to a merge commit means "the last review
of this branch found nothing to fix", and whether the merge itself is green is what the merge box's
other checks are for.

### The verdict on a slice round

A PRD (a parent issue with sub-issues, labelled `agent:implement`) is built one sub-issue at a
time, every slice as commits on one **PRD branch**, `agent/prd-<parent>-…`. The first run opens the
**PRD PR**, that branch into your default branch, as a draft, and its body ends with one `Closes`
line naming the parent and every sub-issue. Each slice is reviewed as a **slice
round** on the PRD PR: the ordinary review, told which slice it is and handed that slice's commits
and its sub-issue's acceptance criteria, and raising only what those commits cause. The chain waits
for the round to end before building the next slice. What the verdict means is unchanged; what
differs is what happens after it:

| How the slice round ends | What the chain does | What is left to you |
|---|---|---|
| **🟢 Approval recommended** | review's advance re-adds `agent:implement` to the parent. The next run builds the next slice, or finishes | nothing |
| **🟡 Changes recommended**, with the fix round already started | **waits**. Every fix run on the PRD PR asks for a re-review, whatever it pushed, and that review ends the round | nothing |
| **🟡 Changes recommended**, no automatic fix starting (off, spent, or no progress) | **parks** | a way on, below |
| **🔵 Needs a closer look** | **parks** | a way on, below |
| a failed run | **parks** | fix what the run names, then a way on, below |

**A parked chain says so on the parent**, in one comment naming the slice, why the round stopped,
the findings still open with links, and the ways on, all three on the PRD PR:

- `agent:fix` for another fix round, with a comment giving the direction if it needs one;
- declining a finding by replying to it, then `agent:review`, to accept the finding as it stands;
- pushing your own commit, then `agent:review`.

The round that ends on an approval moves the chain on, exactly as the first one would have.
Re-adding `agent:implement` to the parent is **not** a way on: the run reads the verdict on the PRD
PR's head, and without an approval it refuses and names these three. It refuses too while
`agent:review`, `agent:fix` or `agent:update-branch` is on the PRD PR, because a round is never cut
short.

**Before each slice the run merges your default branch into the PRD branch**, if it has moved, so
a change to your CI reaches the next slice with no hand steps. It never rebases or force-pushes. A
merge that conflicts parks the chain and builds nothing: add `agent:update-branch` to the PRD PR,
whose resolution is reviewed as a round of the slice just built, and the chain moves on from its
approval.

**Progress** is in the PRD PR body's progress table, one row per sub-issue: its status (⏳ not
started, 🔨 building, 🔍 in review, 🔧 fixing, ⏸️ parked or ✅ approved, with the findings open
beside it where any are), how many reviews it had, linking the latest, how many fix rounds ran,
automatic or added by hand, and a link to a diff of that slice's commits alone. The final review gets
a row of its own. A **status line** at the top of the body's note says where the chain is now.

**Each run's link lives on the sub-issue it builds**: a build run comments there with the link as it
starts, and puts a chapter marker on the PRD PR, *Slice 2 of 5 · #232 started*, with no link, the
`#232` reaching it in one click. The parent hears once, on the chain's first run, which sub-issue
is built first; after that it gets only refusals and park comments. The final review's start comment
on the PRD PR, and every failure comment, carry their own link. The run after an approval says on
the slice's sub-issue which commit was approved and which acceptance criteria changed.

**Every review and every fix run's own comments open with a header** naming the round: *Slice 2 of 5
· #232 · review 3*, or *· fix 2*; *Final review · review 1* on the final review; and *Review 3* or
*Fix 2* on a regular pull request. Numbers restart for each slice, a review you asked for by hand
counts, and so does a fix round you added after the budget ran out. Replies inside threads carry no
header.

**Sub-issues stay open** while the chain runs: the PRD PR's `Closes` line closes them when you merge
it, and closing it unmerged leaves them open. **Merge the PRD PR with a merge commit, or rebase it,
rather than squashing it**: each slice's commits then stay separate on your default branch, each
carrying the `Agent-Slice: #<sub>` trailer that says which sub-issue it built.

**The PRD PR stays a draft** through every slice round. After the last slice the finishing run
hands it over: for a PRD of more than one slice it asks for the **final review**, a full review of
the PRD PR that rules on every finding still open, never re-raises one you declined, looks for what
spans slices, and writes the PR's title and body; its approval marks the PRD PR ready, and any
other ending parks like a slice round. For a one-slice PRD, whose diff the slice round already
read, it marks the PRD PR ready directly. Either way, you merge the PRD PR; the loop never does.
Its base is your default branch, so the CI you already run on pull requests into it runs on every
slice round, and nothing more needs configuring.

**Upgrading mid-chain.** A chain an older release started, building each slice on a branch and pull
request of its own, carries on: a sub-issue that release already closed counts as landed and is not
built again. If one of those per-slice pull requests (`agent/slice-…`) is still open into the PRD
branch, the run refuses and names it: merge or close it by hand, reopen its sub-issue if you closed
it unmerged, then add `agent:implement` again.

### Reading the review body

The verdict is the one-line answer; the review body is the record it was derived from. It opens with
the round's header, *Review 2* or *Slice 2 of 5 · #232 · review 3*, then `## Agent review`, which
is how you tell it apart in a timeline where every agent in the loop posts
as `github-actions[bot]`, and is then laid out like Copilot code review's overview, in one fixed
order: the assessment heading from the table above, one sentence naming what is unresolved, the next
step in italics, `**Findings:** N` with the severities behind it, then the findings in collapsible
groups, then a collapsed section on how the review was checked, then a rule and a link to the run. There
is no other divider in it.

The groups are the part worth learning, because they are what the body remembers from one round to
the next. They appear in this order, and one with nothing in it is left out rather than rendered
empty:

- **Open** — everything owed now: what this review found, and what an earlier review raised that
  this one could not verify as fixed. Entries this review is the first to raise are marked *new*,
  which is how a round that found nothing new and left three findings standing reads differently
  from a fresh review that went badly. Expanded on arrival.
- **Previously missed** — findings this review made in code an earlier review had already read.
  They count toward the verdict exactly like the rest, and they say the record was wrong about this
  pull request rather than that the pull request got worse. Expanded, and rendered exactly like an
  *Open* entry, because that is what it is with one more thing said about it.
- **Resolved since last review** — findings an earlier review raised that this one checked against
  the current code and closed. Folded on arrival: it is the record's memory rather than your list.
  Nothing else keeps it, because a resolved thread drops out of the next round's view entirely.
- **Acceptance criteria** — the linked issue's acceptance criteria (its acceptance section, the
  latest one in a collaborator's comment where triage posted a brief there, or its checklist where
  it has none), each marked *met*, *changed* with the reason the change departs
  from it on purpose, *unmet*, or *not checked*. An unmet one is also a finding under *Open*, with
  a thread to answer it on; a changed one is not a finding. Expanded where anything is not met, and
  left out where the pull request has no linked issue or the issue names no criteria.
- **Follow-ups** — the out-of-scope findings this review recorded, filed as issues when the pull
  request merges. Folded, and **not** in `**Findings:** N`: that number is what blocks this pull
  request, and a follow-up is by definition what does not. Removing the `agent:follow-ups` label is
  how you decline them.

  A finding the review meant to block on can land here too, and the body says so in a line under
  the count: *"1 finding was moved to follow-ups"*. That is a finding whose anchor was in no file
  the pull request changes — see below.

One collapsed section follows the groups, and it is not a place a finding is ever restated:

- **How this was checked**: what the reviewer verified, the checks it ran or read, behaviour it
  traced, files it opened past the diff. It is how you weigh the review, and it is on every one.

What the change *is* is not in the review at all: it is in the pull request's body, below.

A carried entry's title is a **link to the thread it was raised in**, which is what saves you
scrolling back through an older review to find it. A finding this review is the first to raise has
no link, because its thread is opened by the same call that posts the body and renders directly
beneath it.

Every entry carries a **severity** — High, Medium or Low, shown as a small coloured chip — and each
group is sorted worst first. The thread the entry points at opens with the same chip, so the two
surfaces cannot tell you two different things about one finding. It is for reading and for ordering,
and for nothing else: the verdict is not derived from it, whether a finding blocks the merge or
becomes a follow-up issue does not read it, and three Low findings get the same assessment as three
High ones. That is deliberate — a dial the agent turns that changes the outcome is one you have to
check on every review to find out which way it was turned. Low means a real but small defect;
preferences are still posted nowhere, at any rating.

**The chip is an image, and it is served from `jeffwlawson/agent-workflows`.** GitHub's comment
Markdown cannot colour text, so a coloured badge has to be a picture: each review body and each
thread carries an `<img>` naming `assets/severity-<rating>.svg` at the **tag of the release that
posted it**, which is what makes it immutable — a body written today cannot acquire a different chip
later. What you are taking on is a dependency on this repository staying public under that name: if
it is made private, renamed or deleted, the chips in every past review in your repository fall back
to their alt text, which is the word — `Medium`. Nothing else about the review is affected, and
nothing your loop does is blocked by it, because the alt text is the copy every reader that renders
no images already gets: a notification email that blocks pictures, and every agent in the loop,
which is handed the word rather than the tag. One surface carries no image at all — an issue the
follow-ups workflow files after the merge, whose `**Severity:**` line stays a plain `` `Medium` ``,
because that body is an agent's task description and outlives the pull request it came from.

**Every entry is the one-line version of a thread**, and the thread is where you answer it.
That holds for a finding about a file the pull request never touches too: such a problem is caused
by something the change did, so the review anchors it at that change and names the untouched
location in the thread — *"This changes the signature, but `docs/api.md:18` still describes the old
one"* on `src/api.ts:42`. You reply, decline or resolve it exactly as you would any other.

If nothing in the diff causes it, it was never this pull request's to fix. The workflow does not
take the review's word for that: a finding anchored in a file the pull request does not change is
**moved to the follow-ups**, filed when it merges, and the line under the count says how many were
moved and why. Nothing is dropped; what changes is that it no longer holds the merge.

**The review resolves a thread; an `agent:fix` run resolves none.** A fix run replies in every
thread it was shown — `addressed` or `declined`, with its reason — and leaves all of them open. What
closes one is a *later review* reading the code as it now stands, finding the fix landed and saying
so in a reply on the way out; or you, resolving it yourself. So an open thread is not evidence that
nothing has been done about it: read the last reply. This is the other half of why the review after a fix
round exists — the pass that closes a finding is never the pass that wrote the fix.

A thread an `agent:fix` run **declined** is the case to know: it stays open until you rule on it.
The loop will not retire a finding on the strength of its own disagreement with it. Your own
decline, replied on the thread, is a different thing — the next review closes that one as
`WONT_FIX`, quoting you, and stops counting it. If it misreads you it leaves the thread open, which
is the direction that costs a round rather than a decision.

### The pull request's title and body

The run that opens a pull request writes its body once, and nothing rewrites it outside the blocks
the loop owns. Top to bottom: a note saying what the loop does with the pull request and how to
steer it, with a link to the run that opened it, opening with a one-line **status** the loop keeps
current; `## Summary` and the **summary block**; on a PRD PR the progress table; and `Closes #N` at
the bottom, on one line, where GitHub reads it as well as anywhere. A PRD PR's note says not to
merge it before every slice is done; the final review removes that sentence when it writes the
summary, so a PRD PR marked ready says nothing about being a draft. On a PRD PR the summary is the
final review's: until it runs, the block holds a placeholder, and a slice round writes neither the
title nor the summary, unless the PRD has one slice and so no final review.

The review writes the summary block and the title. The summary says what the change does, what
behaviour it changes (breaking changes marked), and where it departs from the linked issue and why.
It does not retell the issue. The title is one line, in the commit convention your `CLAUDE.md`
names, or conventional-commit style if it names none. Both are rewritten by any review that follows
a push (the first build, a fix round, your own push, a conflict resolution) and left alone by a
review with nothing pushed since.

**Your own notes go outside the block**, and the loop never touches them. Text inside the block is
yours to edit too, and an edit there is not lost: the next rewrite starts from it, keeps what is
still true, and corrects what the code has since contradicted. A title you edit is treated the same
way. The block's markers are HTML comments, so they show only in the edit box; delete one and the
review stops writing the summary, with a warning in its run, until the pair is whole again.

**Set the squash commit message to the pull request title.** In the repository's *Settings →
General → Pull Requests*, under *Allow squash merging*, choose *Default commit message → Pull
request title*. The default, *Default message*, takes the single commit's subject on a pull request
with one commit and the title on one with more, so what lands on your default branch depends on how
many commits the loop happened to make. With the title, it is always the line the review wrote for
the change as it stands.

### The pull request list as an inbox

`status:` in a GitHub search reads the head commit's **combined** state, so a saved search per state
covers the open pull requests the loop has ruled on:

- `is:pr is:open status:failure` — waiting on a fix, or on you. **This is the inbox to work from.**
- `is:pr is:open status:success` — approval recommended, where it works. See the trap below.

*Combined* means everything on the commit and not only this one — and **check runs count too**, not
just commit statuses: a pull request with no commit status at all still appears under
`status:success` and `status:pending` on the strength of its checks. So a pull request whose tests
are red is in the failure search whatever its verdict says, and one whose checks are still running
is in neither. The pair is a queue rather than a verdict filter, which is the right shape for it
anyway: the thing you act on is the line you read when you open one.

**The success search has a trap, and it is an installed app rather than anything you configured.** A
GitHub App that creates a check *suite* on every commit and never runs a check inside it leaves that
commit `pending` in search indefinitely — while the pull request's own merge box is green and its
rollup reads `SUCCESS`. On a repository with one of those installed, `status:success` silently omits
exactly the pull requests it is for, which is the failure mode worth knowing about: a search that
returns nothing looks like a quiet week. `status:failure` is unaffected, because an empty queued
suite is not a failure — which is why it is the one to work from.

### Making `agent-review` a required status check — later, if at all

Once the verdicts have proven themselves, `agent-review` can go into your branch protection rule as
a **required status check**: no merge until a review has posted `success` on the head commit.
Nothing here does that and nothing here will — it is a repository setting, added by hand, and the
reason to wait is that it moves who pays for a wrong verdict. Today one you disagree with costs you
the minute it takes to read the review and merge anyway. Required, it blocks the merge until a
review says otherwise, so a verdict that is flaky is a repository where nothing merges.

Three consequences to weigh before switching it on rather than after:

- **A pull request the loop never reviewed carries no status**, and a required check that is absent
  is not a check that passed. Your own one-line fix, pushed and opened by hand, stops being
  mergeable until you label it `agent:review`.
- **A required `agent-review` is not proof that the loop's review produced it.** Every workflow in
  your repository posts as `github-actions[bot]`, not just these — so a workflow file added in a
  pull request's *own branch*, running on that pull request's events, can post `agent-review:
  success` on the head commit after the real review has spoken, and a status is replaced by the
  newest post under its context. The loop is safe against that on its own terms: a forged verdict
  can at most make the next review judge a fix round's progress, which can only stop the loop for
  you, not pass anything. What it
  is not safe for is a merge gate, where the effect is the gate satisfying itself. So read the
  verdict alongside the diff that produced it — which on a branch that edits `.github/workflows/`
  you were going to do anyway.
- **The loop goes round until it stops, then waits for you.** A fix round that pushed gets a
  verification review, and that review may start another round while the budget lasts and each
  round closes at least one of the findings it was given. It stops on approval, on a spent budget,
  or on a round that made no progress, and a verdict that stopped without approval tells you why
  and the three ways on. As a merge gate that means the failing check is a parked loop, not a
  review still in flight.

### Requiring conversation resolution — later than that

The other gate GitHub offers is **"Require conversation resolution before merging"**, a branch
protection setting that sits beside the required check above: no pull request merges while a thread
on it is unresolved. Nothing here switches it on either, and for the same reason — it is a
repository setting, yours by hand, and what it changes is who pays when the loop is wrong.

What it gates here is the review's **verification**, because that is what resolving a thread now
means (above). Nearly everything the loop raises is a thread, and a thread closes when a review has
read the current code and found the finding settled, or when you close it. So with the
setting on, a merge waits until every finding the loop raised is either verified fixed or ruled on
by a human — **including the ones an `agent:fix` run declined**, which stay open by design and are
yours to resolve or to argue with.

Three things to weigh, and the third is why this one comes after the required check rather than
with it:

- **A finding the loop was wrong about still holds the merge.** The cost is one click — resolve the
  thread — but it is your click, on every one of them, and on a busy repository that is the cost
  you are actually signing up for.
- **It gates the threads, and the threads are now the whole record.** Every finding that counts
  toward the verdict is a thread you can answer: a finding about an untouched file is
  anchored at the change that causes it, and one nothing in the change causes is a follow-up rather
  than a blocker. So this setting and the required check cover much the same set from two
  directions: the check gates the verdict, this gates each finding in it. Running both is still
  the argument, since a verdict is one line and a finding is a decision.
- **Give the resolutions a few rounds first.** Which threads close is a judgement the review now
  makes on its own, against code a fix run wrote, and it is the newest thing in the loop. Watch a
  handful of rounds and read what it closed and what it left open before you make those closures
  the thing your merges wait on. The required check asks you to trust a verdict you can read in one
  line; this asks you to trust a decision per finding, so it is the later of the two to switch on.

---

## 4. Files to write

**Nothing in the loop is copied any more.** As of jeffwlawson/winget-manifest-lint#98 every workflow
in the loop is split in two: a `*-reusable.yml` here holding the job — the fork guard, the
permissions ceiling, the concurrency group, the preflight, every step — and a **caller** in your
repo holding the trigger, the token grant and the secrets. You write the callers; you reference the
jobs.

That is the difference between installing this loop and forking it. A control you copy is a control
that drifts; a control behind a pinned `uses:` is one you get fixes to.

```
.github/workflows/agent-pr.yml      # review, fix, update-branch, follow-ups (optional)
.github/workflows/agent-issue.yml   # implement, implement-prd
.github/dependabot.yml              # not part of the loop; see the end of this section
```

**One caller file per side.** The pull-request side's file triggers on
`pull_request_target: [labeled, closed]` and holds the `review`, `fix`, `update-branch` and
`follow-ups` callers; the issue side's triggers on `issues: [labeled]` and holds `implement` and
`implement-prd`. No caller carries a label `if:`: every reusable workflow's own guard decides
whether an event is its label, as it always has, so one label starts one run of its side's file
rather than one per caller, and the Actions tab shows the runs that did something.

Each file grants **nothing at the top level** (`permissions: {}`) and every scope on the job that
spends it, so a job added later starts with nothing rather than with its neighbours' scopes. Keep
it that way: a grant above `jobs:` is every caller's in the file. The one cost of sharing a file is
that a refused grant or a YAML error in it refuses the whole run, so every caller in that file stops
together; `doctor` rules on each job's grant on its own, which is what makes that acceptable.

**The older layout, a caller file per caller, still works.** A re-run of `init` on it moves the pins
and touches nothing else, and never writes the merged files beside yours: a reusable workflow with
a caller in each would run twice on every event, each run doing the whole job. `doctor` reports that
duplicate as an error wherever it finds one, and the older layout itself only as a note. To merge
by hand, move the jobs into one file per side as `examples/callers/` holds them, delete the files
they came from, and re-run `init`, which moves the `pull_request_target` policy (§1) to the new file.

**`follow-ups` is the first genuinely optional caller.** It files a merged pull request's recorded
out-of-scope findings as triageable issues, and having its job is the whole of switching that on:
the runner subcommand ships inside the package and the reusable lives here, but nothing invokes a
reusable except a caller's reference, so a repository without that job files nothing. Not a
mechanism invented for this: it is the same per-caller granularity that already lets you skip
`implement-prd`.

`init` (§0) scaffolds the lot on a first run, this job included, so **opting out is deleting its
job from `agent-pr.yml` afterwards** rather than declining it up front. `doctor` reads the missing
job as declined, not broken, in either layout. That is not a gap in the command: a re-run pins what
is installed, and a caller you deleted is named rather than written back into your tree.

Opting out does **not** turn the recording off, and that asymmetry is deliberate. The review half
still writes its out-of-scope findings into the review body and still marks the pull request, so
the findings are *unfiled* rather than invisible — invisible is the failure the workflow exists to
fix, and trading it away to avoid a stray label would invert the point. The markers are then an
index: searching merged pull requests for `agent:follow-ups` is the exact list of the ones whose
findings nobody filed. Every one of them stays recoverable — install the caller, then
[remove the label and add it back](#re-adding-a-label-that-is-already-there-fires-nothing) on
whichever of them you want filed.

The runners are **not copied either**. They are an npm package — `@jeffwlawson/agent-workflows` —
and the reusable workflow invokes one subcommand of it at a version pinned in *its* YAML:

```yaml
run: npm exec --prefix "$RUNNER_TEMP" --yes --package=@jeffwlawson/agent-workflows@<version> -- agent-workflows review
```

`--prefix "$RUNNER_TEMP"` rather than a bare `npx`, and that is not a flourish: `npx` will reuse a
local package that satisfies the spec, which in the repository that *is* the package means the
checkout runs instead of the pinned release. `--ignore-existing` does not prevent it. The version is
shown as a placeholder here because the real one lives in the workflow and is held equal to
`package.json` by a test — a literal in this file would only be a copy that goes stale.

Prompts ship inside the package, so there is nothing to copy and nothing to keep in step. That pin
is ours rather than yours now, which is one fewer thing for you to get wrong — but the reasoning
still matters when you pin the `@ref` below: an **exact** version, never a range or a dist-tag, for
the reason `.nvmrc` exists, and because the pin being in base-controlled YAML is what closes §9's
first trap. Pinning through your own `package.json` would look equivalent and close nothing (§9).

### The install is authenticated

The package is published to **GitHub Packages** (`https://npm.pkg.github.com`), not to npmjs. Two
consequences, and the second is the one that surprises people:

- The reusable workflow writes a **scoped** `.npmrc` with `actions/setup-node`'s `registry-url` and
  `scope` inputs, so only `@jeffwlawson` resolves there. Your own `npm ci` is untouched — it still
  goes to npmjs for everything else.
- **GitHub Packages has no anonymous install, even for a public package.** The token is
  unconditional rather than a consequence of visibility, which is why every caller below grants
  `packages: read` and why omitting it is not a "make the package public" problem.

Nothing here asks you for a secret: the token is `GITHUB_TOKEN`, and `packages: read` is what turns
it into one that can install (§2).

> **The cross-repo caveat.** A package published from *this* repo is not automatically readable by
> `GITHUB_TOKEN` in a *different* repo — that depends on the package's own access settings, which
> live with the package rather than with either workflow. When it is missing, the failure is a 401
> at `npx` time. A 401 reads like a bad token, so the first thing you will check is the secret you
> did not set and the permission you did — and both will be right. If your caller grants
> `packages: read` and `npx` still 401s, the grant is not the problem: the package needs this repo
> listed under its access settings. This is exactly the silent-until-confusing shape §1 exists for.

### What a caller looks like

**Copy them from [`examples/callers/`](../examples/callers/)** — or let `init` (§0) do it, which is
the same copy with the pin substituted. `pr.yml` and `issue.yml` there are the caller files for each
side, every job already carrying the correct permissions, secrets, `self-check` and pinned `uses:`,
and each file its trigger. Drop them into your `.github/workflows/` and rename the files if you
like — the job id is the only thing you cannot rename freely, for the reason below.

They are real files rather than a block quoted here, and that is load-bearing twice over. What you
install is the thing that was checked: `tests/workflows.test.ts` reads those files and asserts the
trigger, the permissions on both halves, the pin, and the `self-check` coupling. And the coupling
*needs* both halves present to be verified at all — while the callers were a code block, the
reusable half lived in this repo and the caller half lived in whichever repo had adopted the loop,
so the pair could only ever be checked by hand, in a repository this one cannot see.

For orientation, a caller is a job with two wires, under its file's trigger. Copy the real ones
from [`examples/callers/`](../examples/callers/), which carry the live pin where this sketch has a
placeholder, and the pull-request side's other jobs beside this one:

```yaml
name: Agent PR

on:
  pull_request_target:      # `issues: types: [labeled]` for the issue side
    types: [labeled, closed]

permissions: {}             # nothing here; every grant is on its job

jobs:
  fix:
    uses: jeffwlawson/agent-workflows/.github/workflows/fix.yml@v<latest tag>
    permissions:
      contents: write
      issues: read
      packages: read            # install the runner package; see above
      pull-requests: write
    # with:
    #   default-branch: main       # all three default to what is shown; a
    #   node-version-file: .nvmrc  # non-Node repo passes '' for the last two
    #   setup: npm ci              # and still gets the loop
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      AGENT_PAT: ${{ secrets.AGENT_PAT }}
      AGENT_APP_ID: ${{ secrets.AGENT_APP_ID }}
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
```

> **Pin a tag or a SHA, never a branch.** `pull_request_target` reads workflow YAML from the
> default branch (the PR's base, before 2025-12-08), so a pull request cannot edit your caller to change what runs. That protection used to
> cover the called workflow for free, when the `uses:` was a local path resolving against the same
> commit. Remote, the reference is what decides: `@main` hands a job holding `contents: write` and
> your secrets to whatever currently sits on this repository's default branch, and nothing anywhere
> reports it. A test enforces the tag-or-SHA shape on the reference callers.


The permissions per workflow, which are what each job actually spends:

| Caller (job) | `actions` | `checks` | `contents` | `issues` | `packages` | `pull-requests` | `statuses` |
|---|---|---|---|---|---|---|---|
| `implement` | — | — | write | write | read | write | — |
| `implement-prd` | — | — | write | write | read | write | **read** |
| `review` | **read** | **read** | **write** | **read** | read | write | **write** |
| `fix` | — | — | write | **read** | read | write | — |
| `update-branch` | — | — | write | — | read | write | **write** |
| `follow-ups` | — | — | read | **write** | read | write | — |

`packages: read` is the one row that is the same everywhere, because it is not about what the job
does — it is about installing the runner it runs.

**Granting less than a row asks for does not cost you that row's step. It costs you the run.** Every
job in this loop declares the scopes it spends, and a called job cannot hold more than its caller
granted: GitHub refuses the elevation rather than trimming it, and refuses it as an **invalid
workflow file** — so the run is a `startup_failure`, no job starts, and there is no job log to read
it in. An under-granted caller is a label that does nothing, not a run that half works.

**Where you read it.** `gh run view` says only *This run likely failed because of a workflow file
issue*, naming neither the scope nor the file. The run's page in the browser carries the annotation
that names both:

> **Invalid workflow file:** .github/workflows/agent-pr.yml#L*n* — Error calling workflow
> 'jeffwlawson/agent-workflows/.github/workflows/review.yml@\<sha>'. The nested job 'post-review' is
> requesting 'contents: write', but is only allowed 'contents: read'.

Two things in it are worth knowing before you go looking. The line it points at is your caller's
`uses:`, not the `permissions:` line that is short. And the job it names is the **called** one —
`post-review` here, the job that holds the grant, not the job in your file. A caller file holding
several callers is refused whole, so the run that did not start is every caller's in it, and the
annotation is what says which job was short. That is the whole diagnosis,
and it is one `doctor` gives you before a label rather than after one.

Probed on a real token (2026-09-27), because this had been asserted twice and observed never: four
scopes, a missing line and an explicit `none`, and a caller with no `permissions:` block at all
against a restricted default token. Every one was refused at startup and **no case reached a step**.
So the per-scope notes below say what each scope *buys*; none of them describes a 403 or a warning
as what a missing grant gets you, because a job that does not start cannot 403. The one
configuration that under-grants nothing is the **permissive** default token, which grants every
scope write.

> **`issues: write` is on one row only, and it is the one that creates issues.** No other workflow
> in the loop holds it to *file* anything — the `implement` pair spends it on labels and on
> comments. It is also the only caller that passes **no secrets at all**:
> the job runs no model, so there is no `CLAUDE_CODE_OAUTH_TOKEN` to hand over, and it creates its
> issues with `GITHUB_TOKEN`, so there is no `AGENT_PAT` and none of the App's secrets either: a
> repository without the App or the PAT files exactly as much as one with them. Adding any of them
> to your caller is not harmless: GitHub refuses a `secrets:` entry the called workflow does not
> declare, before the job starts.

> **`statuses: write` on review is what posts the verdict**, and it is a scope of its own rather
> than part of `pull-requests: write` — a commit status is attached to a commit, not to a pull
> request. Omit it from your caller and you get no review at all, for the reason at the head of this
> table. The step that posts the status is written to *warn* rather than to fail, on the grounds
> that a posted review is worth more than the line summarising it — so where the token is short for
> some other reason, the loop reads as one whose verdicts are switched off and nothing on the pull
> request says otherwise. Newer than the five scopes above it, so a caller installed against an
> earlier release is one to move rather than to leave. What the verdict says, and what you do with
> each one, is §3b.

> **`contents: write` on review is the posting job's, and only that job's, and it is the one row
> here that is newer than your caller.** GitHub refuses `resolveReviewThread`, which closes the
> threads a review verified, to a token without it; replying into those threads needs nothing extra,
> which is why v0.4.0 — which ran the resolve inside the review job — replied on every verified
> thread and closed none of them. The posting job (`post-review`, a `resolve` job until #257)
> checks nothing out, installs nothing and runs no agent: it resolves the threads over the list the
> review wrote, then posts the review, and nothing else. The review job narrows every grant back to
> `read`, so a review still cannot touch your branch, or write anything else.
>
> **Move the grant when you move the pin.** This is not a scope you lose the resolve without: a
> caller left on `contents: read` does not review at all, and the annotation quoted at the head of
> this table is that exact caller. `doctor` reports it as an error, and it is the reason to run
> `doctor` after a pin bump rather than before the next label.

> **`statuses: write` on update-branch is what keeps it.** A clean refresh copies the verdict from
> the commit that was reviewed on to the merge commit it creates, because the new commit carries
> none until something posts one. That copy is what stops every refresh of a reviewed pull request
> quietly costing a review round, and the step warns rather than failing because the merge is pushed
> by the time it runs. Omitting the grant does not buy you the warning, though — it buys you the
> refusal at the head of this table. A refresh that had to *resolve* conflicts copies nothing and
> adds `agent:review` instead, which is a label rather than a status and needs no scope of its own.

> **`statuses: read` on implement-prd is the approval gate.** Before it builds the next slice, the
> run reads the `agent-review` verdict on the PRD PR's head, and a status is a scope of its own.
> v0.7.0 read a verdict without declaring the scope, so the read 403d and the chain stopped (#199).
> **Move the grant when you move the pin**: a caller without it gets the refusal at the head of this
> table, not a 403.

> **`checks: read` on review is the row only a private repository *spends* — and it is not optional
> on a public one.** The CI wait polls `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`, which a
> **public** repository serves without the scope. Every repo in this pilot was public, so the grant
> was missing from v0.1.0 through v0.1.4 and nothing ever failed. The first private adopter got
> `403 Resource not accessible by integration` on every poll, and — because the count was defaulted
> over the error — the job spent its full 900-second budget before reviewing with no CI evidence at
> all, the exact outcome jeffwlawson/winget-manifest-lint#48 exists to prevent.
>
> All of that is about the **poll**, and it was the whole story while your caller and the job were
> one file. They are two now, and the review job declares `checks: read`: a caller that omits it is
> refused the elevation and never reaches a poll to be served without one. Probed on a real token,
> on a public repository. So `doctor` reports it as an error whatever your repository's visibility,
> and the pin in [`examples/callers/`](../examples/callers/) carries the grant — adding it to your
> caller alone still changes nothing on a pin older than the release that fixed the other half.

> **The same wait needs `jq` on the runner**, which is new in this release — before it the only
> filtering was gh's own embedded `--jq`. Nothing you configure here can take it away: this
> workflow hard-codes `runs-on: ubuntu-latest`, an image that ships `jq`, and exposes no `runs-on`
> input. So this is recorded for whoever changes that line, not as a step for you to take. Without
> `jq` the wait reports itself blind in exactly the words above — and that message names
> `checks: read` only to rule it out, since a caller short of it never reaches a poll at all. What
> separates the causes that remain is the line printed underneath it: the step echoes whatever `gh`
> or `jq` wrote to stderr, so a runner without `jq` says `jq: command not found` outright.

> **The loop's identity decides which token makes a call; it grants nothing, and `doctor` reports
> every missing grant whether or not you have the App or the PAT.** The push runs under the token
> the `loop-token` action resolves (§2: the App's, else `AGENT_PAT`, else `GITHUB_TOKEN`), as do
> `gh pr create` and every `agent:review` label the loop adds itself: on the `implement` pair, on a
> `fix` run that pushed, and on an `update-branch` run that resolved conflicts. That is a choice
> *inside* a job that is already running: a caller missing `contents: write` or
> `pull-requests: write` is refused before any job starts, App or no App. What the identity is
> actually for is the three `GITHUB_TOKEN` failures in §1:
> [a push whose CI waits for approval](#github_token-pushes-start-ci-that-waits-for-approval),
> [a `gh pr ready` that is refused](#github_token-cannot-mark-a-pull-request-ready-for-review) and
> [a label add that is a silent no-op](#a-label-added-with-github_token-is-a-silent-no-op). What the
> PAT costs you when it expires is §2.

Four things about that shape are worth knowing before you paste it:

- **`permissions` has to be on your job too.** The called workflow can only *downgrade* the token it
  is handed, so it cannot grant itself the `pull-requests: write` its label edits spend. On a repo
  whose default `GITHUB_TOKEN` is the restricted one, omitting this block gives you no run at all:
  that token is `contents` and `packages` read, which is less than every job here declares, and the
  default token is the ceiling like any other — probed, and it is the case this file used to give as
  the exception. The two blocks say the same thing for opposite reasons — yours grants, ours
  bounds — which is why `contents: read` on the review job stays an invariant no caller can widen,
  even though your review caller grants `write` for the posting job beside it.
- **Pin the `@ref`.** Same reasoning as the runner version above, and the same trap: a floating
  `@main` is a workflow that changes under a pull request nobody touched. An exact pin is a pin
  that goes stale, which nothing in this repository can see from here — *Keeping the pins fresh*,
  at the end of this section, is the other half of the instruction.
- **Name each workflow `Agent …`.** A called workflow contributes no run of its own, so the run is
  yours, and review's CI wait and failure-log collector skip runs whose name starts with `Agent `
  on the grounds that an agent job is not evidence about the diff. A renamed one is still
  recognised by what its `uses:` calls.
- **Name the secrets rather than `secrets: inherit`.** Inheriting hands the called workflow every
  secret your repository holds. `AGENT_PAT` and the App's secrets are declared optional, so passing
  an unset one is fine — it arrives as the empty string, which is what the fallback in §2 reads as
  "not set". Pass all three wherever the reference caller does, whichever identity you use today:
  a caller that does not pass the App's secrets writes as the PAT even after you switch, and
  `doctor` names it.

### `agent-review` needs one input more

Review polls every check on the head commit and waits for the ones still running, so it has to
recognise its own — and a called workflow's job appears as `<caller job id> / <called job id>`,
which nothing inside the called workflow can read. Hence `self-check`, required:

```yaml
jobs:
  review:
    uses: jeffwlawson/agent-workflows/.github/workflows/review.yml@v<latest tag>
    # This workflow's whole row of the table above, and a subset is not a
    # smaller feature: a caller granting less than a job it calls declares
    # fails the run before any job starts. `contents: write` is the posting
    # job's alone — the review job narrows it back to `read`.
    permissions:
      actions: read
      checks: read
      contents: write
      issues: read
      packages: read
      pull-requests: write
      statuses: write
    with:
      self-check: review / review    # `<this job's id> / review`
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      AGENT_PAT: ${{ secrets.AGENT_PAT }}
      AGENT_APP_ID: ${{ secrets.AGENT_APP_ID }}
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
```

Rename the job, change the input. A name review does not recognise as its own is a job waiting for
itself — the whole 15-minute CI wait, then a review with degraded evidence and no error anywhere.

How many fix rounds a review may start by itself is the repository variable
`AGENT_MAX_FIX_ROUNDS`, not an input: §3b is where you decide about it. The `auto-fix` input it
replaced is deprecated and not in the reference caller.

The `implement-prd` caller is optional but **not independent**: it shares the `agent:implement`
label with `implement`, and the two partition every label event by issue shape. Keep both jobs in
`agent-issue.yml` or neither. Keeping only the PRD one leaves ordinary issues unhandled; keeping
only `implement` is fine in itself, but a PRD-shaped issue then reaches a job that *defers* to a
workflow you did not install, and nothing happens at all.

Optional, and the one file still copied verbatim: `.github/workflows/token-expiry.yml`. It is
offered as-is because it is already repo-agnostic — no branch names, no toolchain, no paths, just
`AGENT_PAT` and the GitHub API — so there is nothing for a `workflow_call` surface to parameterise.
Splitting it would add a file and a pin to save nobody an edit. It is for the PAT alone: where the
App's secrets are set it checks nothing, so a repository on the App has no need of it (§2).

Optional, and needs its mapping rewritten for your labels: `docs/agents/triage-labels.md` (§3).
Run `/setup-matt-pocock-skills` **first** — it writes every file in `docs/agents/`, including
`triage-labels.md` at that same path — then copy this repo's version on top of what it generated.
The reverse order silently loses everything below the mapping table, because the skill rewrites
the file with its own default version.

**If you keep the `implement-prd` caller, take `docs/agents/ticket-shape.md` with it.** The workflow
reads a hierarchy it does not create: a parent issue with **native sub-issues**, created in
dependency order. That file is the publishing side of the contract, and it is the half nothing
enforces — whoever writes the tickets, a skill or a human, owns the topological sort (§5).

Publishing it natively needs **`gh` >= 2.94.0**, the release that added sub-issues and issue
relationships to `gh issue` — `gh issue create --parent <n>` and `--blocked-by <n>` (verified on
2.96.0). On an older `gh`, use the REST sub-issue endpoints instead, where every id is the issue's
numeric **database id** rather than its `#number`. What you must not do is settle for a
`Blocked by: #12` line in the body: the sub-issues API does not report it, no UI draws it, and the
chain cannot see it, so a batch that reads perfectly to a human is one the workflow finds empty.
Read the hierarchy back through the API before labelling anything.

**Do not copy** `corpus.yml` or `scripts/lint-corpus.ts` — they lint a pinned `microsoft/winget-pkgs`
snapshot. The *pattern* is worth stealing and is discussed in §7.

The runners bring their own dependencies, so an adopting repo needs none of them. The list below is
what **this** repo needs to develop the package, whose sources are this repository:

```
@ai-hero/sandcastle  @standard-schema/spec  tsx  typescript
```

`prepack` runs the build, so a publish cannot ship a stale `dist/`.

> **A note for anyone reading the history.** Until the package moved to its own repository it lived
> at `.sandcastle/agent-workflows/` inside the linter, was **not** an npm workspace, and declared
> `typescript` without ever installing it — the build resolved `tsc` by walking up into the parent's
> `node_modules`, and was green only because both pins matched. Commits before the move describe
> that layout and are accurate about it.

Publishing is `publish-agent-workflows.yml`, triggered by pushing an `agent-workflows-v<version>`
tag. The trigger is a bare `v*` tag push. It was originally chosen to work around a
`workflow_dispatch` bootstrap deadlock that existed only while this package lived inside another
repository; that reason is gone, and the trigger is kept now for simplicity rather than necessity.
The ancestor guard that the bootstrap made impossible — `git merge-base --is-ancestor "$GITHUB_SHA"
origin/<default>` — is in place, so a tag on an unmerged commit is refused.

> **`bin` paths must not start with `./`.** `npm publish` silently strips a `bin` entry written as
> `./dist/cli.js`, logging `"bin[agent-workflows]" script name dist/cli.js was invalid and removed`
> among its other warnings, and **publishes anyway**. The tarball still contains the file and the
> manifest inside it still names it — only the registry manifest loses the entry, so nothing looks
> wrong until `npx <package> <command>` resolves the package and finds no command to run. Version
> 0.1.0 shipped exactly this.
>
> `npm pack` does not reproduce it and neither does npm 10, so a local check passes. `ci.yml` runs
> `npm publish --dry-run` under the `.nvmrc` Node and fails on that string, which is the only signal
> there is.

### The red check

A slice's acceptance criteria often say a test must be shown to **fail against the code as it was
before the fix**. Without the red check the review takes the pull request's word for it. With it, a
job in `review.yml` proves it: it takes the test files the pull request adds or changes, puts them
over the **merge-base's** source (every other file is the merge-base's), runs your test command, and
reports each of those tests as one of three things:

- **red**: failed on an assertion, with the assertion it failed on. Evidence that the test catches
  the behaviour the pull request changes.
- **broken**: failed on collection, import or setup. A test that cannot import the function it
  tests fails against the old code whatever it asserts, so broken is **not** red.
- **passed**: passes without the change too, so it is no evidence for it.

The review is handed that report, and flags each behaviour change in non-test source that no red
test covers. Where the report could not be read, or holds no test that ran, what is red is unknown,
and the review says so rather than flagging anything on the strength of it.

The pull request's body lists the **failing-first tests** under the summary the review writes, as
the *Before* of its `## Evidence` section, where the red check is called the *test-first check*:
each red test, with the assertion it failed on. Broken tests are counted there and not listed, and a
check that is not configured, or whose report could not be read, says which rather than listing
nothing. The *After* beside it is CI's result at the head, never a claim that a named test passed.

**On a PRD PR**, each slice is built on the slices before it, so a slice round's red check runs
that slice's test files against the **PRD branch as it stood before the slice**, not the merge-base:
against the merge-base a test of an earlier slice's code would fail to import, and read as broken
rather than red. Each slice round records its red tests in its review, since the body's list is
rewritten by the next slice, and the final review's body lists the failing-first tests **by slice**,
from those records. The final review's red check runs nothing: the review holds each slice's
changes to that slice's record instead, since a merge-base run would read later slices' tests as
broken.

**The contract is JUnit XML.** Your command writes a JUnit XML report, and `<failure>` versus
`<error>` is the red-versus-broken line, which holds across languages. Any runner that writes one
will do; three that do:

| Runner | `red-check-command` | `red-check-report` |
|---|---|---|
| pytest | `pytest --junitxml=junit.xml` | `junit.xml` |
| vitest | `npx vitest run --reporter=junit --outputFile=junit.xml` | `junit.xml` |
| jest, with `jest-junit` installed | `JEST_JUNIT_OUTPUT_FILE=junit.xml JEST_JUNIT_REPORT_TEST_SUITE_ERRORS=true npx jest --ci --reporters=jest-junit` | `junit.xml` |

Under jest-junit, `JEST_JUNIT_REPORT_TEST_SUITE_ERRORS=true` is not optional in practice: without
it, a test file that fails to import is left out of the report altogether, never red and never
broken. vitest writes every failure as `<failure>`, and the check reads a file-level or hook-level
one as broken by its shape, so nothing there needs configuring.

**The three inputs**, in the review caller's `with:` block. The reference caller carries them
commented out:

```yaml
    with:
      self-check: review / review
      red-check-command: npx vitest run --reporter=junit --outputFile=junit.xml
      red-check-report: junit.xml
      red-check-test-globs: |
        tests/**
        **/*.test.ts
```

- `red-check-command`: the command that runs the tests and writes the report. Empty, the default,
  turns the check off. It runs after `setup`, on the merge-base's dependencies, and the test files
  it was given are in `RED_CHECK_FILES`, one a line, for a command that runs only those. Like
  `setup`, it is a literal from your workflow file, never an expression that reads the event.
- `red-check-report`: where the command writes the report, relative to the repository root.
- `red-check-test-globs`: globs, one a line, matched the way `.gitignore` matches, that tell test
  files from source. The pull request's files that match are put over the merge-base; nothing else
  of the pull request's is.

All three or none. A command with either of the others missing runs on every review, reports itself
misconfigured, and leaves the review with unknown red evidence; `doctor` warns about it, naming what
is missing, and notes whether the check is configured at all.

**It is evidence for the review and never a required status.** The job runs the pull request's
code, so it holds no secret, and only `contents: read` and the `packages: read` that installs the
loop's package, before any of that code runs and by the one step handed the job's token. It carries
the review's fork guard, and nothing it produces is trusted beyond its report. The review waits for it but runs whether it passed, failed
or was skipped, and its check run is excluded from the CI the review waits on, so it never turns the
CI result red. Do not make it required: a pull request that only refactors has no red test to show,
and is not wrong for it.

### Keeping the pins fresh

Everything above is an **exact** pin, one per caller you installed, and a pin is a thing that goes
stale silently. A release here moves nothing in your repository and tells nobody: no check fails,
no run changes, the loop keeps working — on the version you installed. Measured in September 2026
across the three repositories running this loop, one of them was **four releases behind** and
nobody had noticed. It was the repository the loop was piloted on.

Nothing in this repository can see that. The `@ref` in the reference callers is derived from
`package.json` and checked by name, and the same check covers this repo's own callers — it covers no
copy in a tree we cannot read.

`doctor` (§0) can, on demand: it compares each caller's `@ref` against this package's tags and says
how many releases behind it is. That is the other half of the same problem rather than a duplicate
of what follows — Dependabot *fixes* drift going forward, `doctor` *reports* it now, including for
a repository that never installed Dependabot, which is exactly the repository most likely to have
drifted. It is a warning rather than a failure: an old pin is a working loop on an old version.

[Dependabot can, and has read reusable-workflow refs since March 2023][dependabot-reusable]. With
the `github-actions` ecosystem it reads every `uses:` under `.github/workflows`, compares each
against the latest tag, and opens a pull request. Write this:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      agent-loop:
        patterns: ["jeffwlawson/agent-workflows*"]
      actions:
        patterns: ["*"]
        exclude-patterns: ["jeffwlawson/agent-workflows*"]
```

to `.github/dependabot.yml`. That is the config this repository runs, held equal to the block above
by a test, so it is one copy rather than two — but not for the same reason you run it, and the
asymmetry is worth a line:

| | the loop pins | the ordinary action pins |
|---|---|---|
| **here** | moved by the release and held to `package.json` by a test, so `agent-loop` is inert — a pull request from it means a release step was missed | nothing else tracks them; Dependabot is the only thing that does |
| **your repo** | nothing moves them, which is the whole reason this section exists | same as here |

So the group you need most is the one that never fires here.

`directory: "/"` is the repository root — for this ecosystem Dependabot looks under it for
`.github/workflows` itself, and naming the workflow directory finds nothing.

**The grouping is the part worth reading.** Ungrouped, each caller is its own dependency, so a
release opens **six** pull requests and six is enough to merge three of them. A repository whose
callers name two different tags is calling two releases at once — and since the runner version is
baked into the reusable half, that is two *runner* versions too, which is the split-brain the pin
exists to close. Grouped, it is one pull request moving all of them or none.

That is the one number this file still writes down, against its own rule, because here the number
*is* the argument: the claim is that ungrouped there are enough pull requests for a partial merge
to be the likely outcome, and "enough" cannot be said without counting. It moves when a workflow is
added, so a test derives it from the reference callers and fails when it lags.

**Taking the filing caller needs no change here.** The pattern matches on
`jeffwlawson/agent-workflows*`, which is the repository rather than the workflow, so a caller is in
the group the moment its job is in your file. A caller needing a line of config of its own would be
a pin that splits across two releases the first time somebody forgot to write it.

The second group is why `actions/checkout` and `astral-sh/setup-uv` do not each arrive on their own.
The ecosystem is repository-wide: those pins are in scope whether or not you say anything about
them, so the choice is a second group or a stray pull request each — not "covered" or "ignored".
Keeping them out of `agent-loop` is deliberate; "the loop moved" and "the actions moved" are
different reviews.

Three things it does **not** do.

- **It moves the `@ref`, and a release is sometimes more than a `@ref`.** Dependabot rewrites the
  `uses:` line and touches nothing else in the file — which is `init`'s limit too, for the same
  reason and said the same way in §0: a caller is yours, so neither of them carries across a change
  a later release made to a caller *body*. A scope added to your `permissions:` block is the case
  where that costs you something, because a caller granting less than a job it calls declares fails
  the **whole run** before any job starts, with no job log (§4). **This release is one**: the review
  caller now grants `contents: write`, which only the review's posting job spends. Merge its `agent-loop`
  pull request on its own and every `agent:review` after it does nothing at all.

  So the rule is **`doctor` after a pin bump, not before the next label** (§0). It reads the callers
  in your tree against the pin they now carry and names the row that is short, with the fix — which
  is the only thing on either side of this that can see a caller two releases old. The release notes
  say when a bump needs one; `doctor` says so whether or not you read them.
- **It is better, not free.** One pull request per repository per release still has to be merged by
  someone. The failure mode changes from a stale pin — invisible — to a stale *open pull request*,
  which at least appears in a list you already read. If a repository has three of them open, it is
  three releases behind and now says so.
- **The agent loop does not start itself on these.** Runs Dependabot itself triggers get a
  read-only `GITHUB_TOKEN` and no access to your Actions secrets, so `CI` runs and nothing else
  does — and the loop is label-triggered, so nothing else starts one either. Label one `agent:fix`
  by hand and it *will* run, with your secrets: the branch is in your repository, so the fork guard
  passes, and the run's actor is you. The author gate (§8) does not trust `dependabot[bot]`, but
  that gates the text the agent reads, not whether the job runs. Leaving them alone is the right
  outcome rather than a gap: a version bump is a diff you can read, and reviewing it is not worth
  an agent pass.

**Why this and not a workflow here that bumps every adopter.** A fleet-bump would be easy — the PAT
already knows which repositories have adopted the loop — and it inverts the relationship this
document describes. You reference a control and receive fixes; this repository does not reach into
your tree. Dependabot keeps that direction: you still decide when to take a version, you just stop
having to notice one exists.

**And a moving `@v0` tag is not the answer either**, for §9's reason. `pull_request_target` hands
the called workflow `contents: write` and your secrets, so a ref that moves is a job that changes
under a pull request nobody touched. A pull request you can read is the cost of a pin you can trust.

[dependabot-reusable]: https://github.blog/changelog/2023-03-13-dependabot-updates-support-reusable-workflows-for-github-actions/

---

## 5. What you must change

Nothing in the loop, any more. Every coupling this table used to list is an **input** you set in
your caller — or, in three cases, was never a coupling to begin with and is recorded here so the
next person does not go looking for it.

| Assumption | Now | Notes |
|---|---|---|
| Default branch is `main` | `default-branch`, on every caller that takes inputs | It means two different things by event, and both are right. On `review`, `fix` and `update-branch` the base comes from the pull request (jeffwlawson/winget-manifest-lint#71, jeffwlawson/winget-manifest-lint#100) and this is only the fallback for an event carrying none — which never happens on a real PR, but degrades *silently* when it does. On the two `implement` workflows there is no event field to read: an `issues` event says nothing about branches, so this **is** the branch they cut from and open the PR against. It reaches the runners as `BASE_REF` too, so the prompts name a branch that exists (jeffwlawson/winget-manifest-lint#98) — `implement/implement.ts` used to count commits against a literal `main`, which was the one site here that *hard-errored* rather than misbehaving quietly |
| `npm ci` and `.nvmrc` | `setup` and `node-version-file`, on the same set | the whole toolchain assumption, and both are skippable: pass `''` and a repo whose toolchain is not Node still gets the loop, running on the Node the runner package requires. The filing caller is outside this row rather than exempt from it — it declares no inputs, because it checks nothing out and has no toolchain to configure. Only `npm install -g @anthropic-ai/claude-code` is unconditional, and that is the agent's own runtime rather than yours |
| The gate command (`npm run verify` here) | not an input, and not a coupling | each prompt says to run "the verify command `CLAUDE.md` names", so writing your gate down once in `CLAUDE.md` (§6) is the whole of it. It cannot become an input: `runWithExtraction` drops prompt arguments before the extraction pass, so a placeholder would reach one prompt literal |
| `CONTEXT.md` and `CLAUDE.md` exist | still yours to write | see §6. This is the coupling the others turned into — a de-domained prompt makes it total rather than partial |
| Project domain | **not a coupling** (jeffwlawson/winget-manifest-lint#95) | the prompts name no domain of their own. A test walks every prompt and runner file and fails on any adopting repo's vocabulary, so it stays that way |
| Sub-issues are created blockers-first | **not an input, by design** | `agent-implement-prd` walks sub-issues in **API order**, so whatever publishes them owns the topological sort. It reads the "blocked by" links once, before the first slice, and refuses a list whose order contradicts them, or a sub-issue blocked from outside the PRD, naming the links to fix; it never reorders. The publishing side is `docs/agents/ticket-shape.md` — including the repair, which reorders the parent's list rather than recreating the slice |

Your own CI is the one place a branch name is still yours to write, and it always was: `ci.yml`
here triggers on `branches: [main]`. A workflow's *trigger* cannot come from a `workflow_call`
input — that is the same limitation that keeps the trigger in your caller rather than in the
reusable half — and your CI is not part of this loop anyway. Nothing about the conversion changes
it; it is named here only because the row it used to share is gone.

### Your CI and the PRD chain

Nothing to change. Every slice of a PRD is reviewed on the PRD PR, whose base is your default
branch, so a CI that runs on pull requests into it runs on every slice round. Releases before
#249 opened a pull request per slice into the PRD branch and asked you to add the PRD branches to
your CI's branch filter; that entry is harmless if you keep it, and nothing needs it now.

Nothing above will error if you get it wrong — with one exception worth knowing, because it is the
exception on purpose. An empty base ref used to default to `main` inside the runners; since
jeffwlawson/winget-manifest-lint#98 it fails the run with a message naming the input, on the grounds
that a review silently diffing against the wrong branch is worse than a run that stops and says so.

This table used to be the longest section in the file, and the work did not disappear — it moved to
§6, where it belongs. An agent is only as good as the `CONTEXT.md` and `CLAUDE.md` it is pointed at,
and every coupling turned into an input is one less place to look when the output is wrong.

---

## 6. What makes the agent's output good

Two documents do most of the work, and skipping them is the difference between an agent that stays
inside your architecture and one that invents a new one per issue.

- **`CONTEXT.md`** — the domain model. Not API docs; the *concepts*, their relationships, and the
  seams between them. In this repo it earned its cost immediately: an agent implementing a
  cross-file rule deferred part of the job to a sibling rule it could not see, reasoning purely from
  the domain model, and documented the boundary for whoever picked up the sibling.
- **`CLAUDE.md`** — commands and conventions. Most importantly the **one command that gates
  everything** (`npm run verify` here). CI runs exactly it; the agent is told to run exactly it.

---

## 7. Before you trust it: get an external oracle

The single most valuable finding of this pilot. Four mechanisms catch genuinely different things,
and **three of them only ever check the work against the team's own beliefs**:

| Mechanism | Catches | Blind to |
|---|---|---|
| `verify` | behaviour contradicting its own tests | anything the spec got wrong |
| **external oracle** | **spec errors nobody on the team knows are errors** | design, duplication, style |
| `agent:review` | design problems with no runtime symptom | errors it shares the author's premise about |
| `agent:fix` | acts on findings, with judgement to decline | whatever was never flagged |

Tests encode the team's beliefs, review reasons from them, fix acts on that reasoning. When the
belief is wrong all three agree with each other and produce confident, mutually-reinforcing
justification — which is worse than silence, because it manufactures assurance.

In this repo the oracle is a corpus of 4,000 real `winget-pkgs` manifests. Microsoft accepted every
one, so any **error** is by definition a false positive. It caught 417 on its first run, then a bug
in its own gate, then a spec error that the review agent had explicitly certified as safe 96 seconds
earlier.

Yours will look different — a golden corpus, a production dataset, a reference implementation,
property tests against a real system. Find one. Without it, the loop is fast and self-consistent
and will confidently build the wrong thing.

Two implementation notes, both learned the hard way: make the gate **severity-aware** (errors fail
the build, warnings are counted and printed) or warning-severity rules become structurally
impossible; and **ground every spec claim in a primary source** before filing the issue. Every spec
error here came from a confidently-written issue, and the corrections that landed clean were the
ones citing the upstream schema or source directly.

**Concretely: every acceptance criterion cites the primary source it came from** — the upstream
schema, the spec section, the API doc, the file and line. Not the issue that proposed it and not
the plan that decomposed it. This is where it has to land because an acceptance criterion is the
one part of an issue the agent treats as a contract: prose above it is context to be weighed, a
checkbox is a thing to be made true. An uncited criterion is therefore a belief that gets
*implemented*, then encoded in a test, then confirmed by review reasoning from the same belief —
the three-way agreement the table above is about, with the citation being the cheapest place to
break it. It is cheap in the other direction too: a criterion nobody can find a source for is
usually the one that was wrong, and noticing that while writing the ticket costs a sentence.

The PRD tier raises the stakes rather than changing the rule. A chain implements its slices
unattended, and each slice's review reads that slice against its own sub-issue (docs/parity.md §2a)
— so an uncited criterion is checked by a review reasoning from the same ticket, and on an approval
the next slice is built on it before any human has read it.

---

## 8. If your repo is public

The pull-request side's callers, `review`, `fix`, `update-branch` and (if you kept it)
`follow-ups`, use `pull_request_target`, which runs with write access, and with secrets everywhere but the last. From
2026-11-02 it runs on a public repository only where an Actions policy allows it (§1). These
controls are not decoration — and since jeffwlawson/winget-manifest-lint#98 you no longer copy any
of them: every one lives in a `*-reusable.yml` you reference, where a caller can skip the job but
cannot loosen it. Read them anyway. Not to install them, but because a control you cannot see is one
you cannot reason about, and the paragraph after the table is a decision only you can make.

| Control | Why |
|---|---|
| **Fork guard**: `head.repo.full_name == github.repository` in the job-level `if` | without it a fork PR runs its own code with your secrets in scope. Fails closed before a runner is provisioned |
| **Author-association gate** on every issue/PR/comment/review-thread body | all world-writable. Anyone can *open* an issue or comment on a PR; `agent:fix` acts on that text and pushes code. Trusts `OWNER` / `MEMBER` / `COLLABORATOR` — org-adjacent or better, *not* write access; see the paragraph below |
| **Trust your own bot by login** — `github-actions[bot]` **and** `github-actions` | REST and GraphQL spell the same account differently. List one and the review→fix handoff silently drops its own agent's comments |
| **Scrub the GitHub token** from the agent's environment after fetching context | the agent runs unsandboxed; it has no legitimate `gh` use once context is read |
| **`contents: read`** on the review job | the one agent structurally unable to mutate the branch. The posting job beside it holds `contents: write`, because closing a thread needs it, and so it runs no agent and checks nothing out |
| **The loop's credentials never on the agent's runner** | the App's key, any token minted from it, and `AGENT_PAT` are named only in jobs that run no agent (§2). An agent that was steered, unsandboxed with `sudo`, can read every secret its own job names; its job names none of these, which is what makes the App's Workflows: write acceptable |
| **No model in the job that files** | `follow-ups` holds `issues: write` and reads issue bodies to decide what is a duplicate. Both at once is a prompt-injection surface, so it installs no agent, declares no secrets and checks nothing out; what would be an agent's judgement is a pure function in the command |

**Neither the trigger nor the input gate is the write boundary, and it is the same role on both
sides.** The **trigger** is a label, and GitHub's **Triage** role can add labels with no push access
at all — so a triage-role collaborator can add `agent:fix` and cause an agent to push code. The
**author-association gate** admits that same person's text: `COLLABORATOR` is GitHub's word for
"has been invited to collaborate on the repository", Read and Triage roles included, and `MEMBER` is
membership of the owning organization with no repository grant implied at all. Only `OWNER` is
write-gated by its definition (`CommentAuthorAssociation` enum descriptions, introspected
2026-09-20). So the gate establishes *org-adjacent or better*, not *can push* — one role, below the
write boundary, both triggering the run and authoring what it reads.

On a personal repository the two coincide, because a collaborator there has write access and
`MEMBER` cannot occur without an owning org; on an organization repository they come apart. If you
are adopting into an org, this is your exposure and not ours, which is the wrong way round and is
why it is written here. Moot while you are the only collaborator, and a real escalation path the day
that changes. Two ways out, and it is a decision rather than a defect: check
`github.event.sender`'s permission level, or treat "never grant Triage on a repo running this loop"
as part of the setup. Pick one before you add a collaborator (jeffwlawson/winget-manifest-lint#102).

If you take the first, it goes in **your caller's** job-level `if:`. That is the one direction the
seam allows — a caller's `if:` can narrow what runs, never widen it — and it is why the trade is
still yours to make after the conversion rather than ours to make for everyone.

Either way you have closed the *trigger* half only: a Read-role collaborator cannot add a label, and
their comment still passes the author-association gate. Whether that gate should narrow to a
permission check of its own is an open decision (#68) and a change to the reusable half, which you
would get for free. Until it is taken, what the gate gives you is *org-adjacent or better*, not
*can push*.

The residual you cannot cheaply close: the agent runs unsandboxed with a model token readable in its
environment and unrestricted network egress. Every *injection source* is behind the author gate —
org-adjacent or better, which on an org repo is a wider set than the write boundary (above) — so the
exposure is "a compromised collaborator, org member or poisoned dependency could exfiltrate a
scoped, rotatable model token." Bounded and monitorable. If your threat model includes untrusted
code or long-lived secrets, you need a sandbox with egress control, which means self-hosted
runners.

---

## 9. Two traps once it is running

**Stale runner scripts, silently — closed, and worth understanding anyway.** `pull_request_target`
takes the workflow YAML from the *default* branch but checks out the **PR head**, so anything a run
reads out of the working tree comes from the pull request. While the runners were scripts in the
repo, a PR opened before a runner change kept executing the old ones with no error.

The version pin in §4 closes it: the workflow file is base-controlled, so the runner version is too.
That holds **only** because the pin is in the YAML. Depending on the package from your own
`package.json` and invoking it from `node_modules` puts the version back on the PR-head side of the
split — the same trap, wearing the fix's clothes. A test asserts no workflow runs a runner out of
the checkout.

The conversion in §4 widens the same property from the runner to the whole job: your caller is
base-controlled, so the `@ref` it pins is, so every step behind it is. Nothing a pull request can
write reaches a control any more — only the working tree the agent reads, below.

What is still PR-head-controlled is your `CONTEXT.md` and `CLAUDE.md`: an agent on an old branch
applies superseded *conventions*. That is a weaker failure than running the wrong code, and the
remedy is the same — refresh in-flight agent PRs with `agent:update-branch`.

**Silence is ambiguous.** GitHub rejects an **entire** review if one line anchor falls outside the
diff, so a broken placement posts nothing — identical to a review that found nothing. Since #110 an
anchor it cannot resolve is rerouted rather than dropped: to a thread on the file when the diff
covers no such line in it — the anchor has drifted past the hunks, or the change deleted, renamed or
rewrote the file and it has no lines to cover — and since #127 to the follow-ups when the file is
not in the diff at all.
The runner logs `Findings: N produced — a on a line, b on a file, c moved to follow-ups for having
no anchor in the diff`; trust that counter, not an agent's argument that its own placement is
sound.

---

## 10. Local development

Don't, on Windows. `@ai-hero/sandcastle`'s `shellEscape` is POSIX-only with no platform branch, so
the model id reaches the CLI wrapped in literal single quotes and the API returns a 404 that reads
like an entitlement problem. It affects every provider the tool supports, not just Claude. Linux CI
is unaffected — `sh` strips the quotes.

Develop against CI, or use WSL.
