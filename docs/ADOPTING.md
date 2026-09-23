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
`.github/workflows/`, substituting the one thing that is per-repo — the version pin — and writes a
`SETUP.md` listing what is left: the two secrets (§2), the repository setting (§1), the labels (§3),
and the two documents §6 is about. A `SETUP.md` it did not write is left alone.

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
| both secrets are set — on the repository, or shared with it by its organization | §2 — and `AGENT_PAT`'s absence is three of §1's failures by itself |
| Actions may create pull requests | §1's first, unless `AGENT_PAT` makes it moot |
| every caller that declares a `permissions:` block grants each scope the job it calls spends — the whole of *The permissions per workflow* table below, at the severity the two rows under this one qualify | §4 — a 401 at `npx` that reads like a bad token, a `git push` that 403s with the agent pass already spent, and a label transition that 403s before the checkout on `Resource not accessible by integration`, which names neither the scope nor the file that grants it |
| the two scopes only a **private** repository needs — `checks: read` and `contents: read` on review — which are an error there and *a warning on a public repository*, where the same calls are served without them | §4 — a wait that spends its budget and reviews blind, and a checkout that 403s before the diff is read |
| `agent-follow-ups`' `contents: read`, the one grant no call here is known to fail without — *a warning everywhere, not a failure* | §4 — a `permissions:` block replaces the inherited token rather than adding to it, so dropping the line sets `contents: none`, which is a configuration the runner install has never run under |
| a caller that declares no `permissions:` block at all | §4 — it runs with the default token, whose restricted setting is `contents` and `packages` read, so the install works and every write 403s |
| every caller is pinned to a tag or a SHA | §9 — a ref that moves under a pull request nobody touched |
| every caller passes `AGENT_PAT` to the workflow it calls | §1's second, third and fourth — a called workflow gets only what it is handed, and an optional secret it was not handed arrives as the empty string, so the loop runs under `GITHUB_TOKEN` with the secret correctly set |
| `self-check` is the check run its job produces, byte for byte — **both** halves, and the calling half is that job's `name:` where it has one | §4 — a job that waits for itself for 15 of its 20 minutes |
| the labels exist | §3 — a transition that is a silent no-op |
| how many releases each pin is behind | *Keeping the pins fresh* — a report, not a failure |

The rows it cannot have are §1's last two, and for one reason: both are an event that never fired,
and nothing in a checkout records the absence of an event. They stay prose, below.

Everything `gh` could not answer — no auth, no admin — is reported as **unknown** rather than folded
into a pass. Run it in the repository being adopted, or pass `--dir <path>`; it asks GitHub about
whichever repository that directory is.

---

## 1. The failures that look like something else

Read these before setting anything up. Each cost a run to diagnose, and none of them says what is
actually wrong.

### "GitHub Actions is not permitted to create or approve pull requests"

Repository setting **Settings → Actions → General → Allow GitHub Actions to create and approve pull
requests**, off by default. The agent does its work correctly and the run dies at `gh pr create`.

Not a code defect and not in any upstream repo's docs, because both had it enabled long ago and the
requirement is invisible once satisfied. Using `AGENT_PAT` (below) bypasses it entirely — a user PAT
is not the Actions bot — which is the better fix.

### `GITHUB_TOKEN` pushes do not trigger workflows

A branch pushed with the built-in token starts **no** CI run on the resulting PR. Nothing errors;
the PR simply sits there with no checks, and you verify by hand forever.

This is a deliberate GitHub anti-recursion rule. The only fix is pushing under a user identity — the
PAT again.

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

`agent-implement` cascades to `agent-review` by adding a label, so without the PAT that cascade is
dead while looking alive. The workflow emits a `::warning::` when `AGENT_PAT` is unset for exactly
this reason.

`agent-implement-prd` has it worse: it *chains itself* by re-adding `agent:implement` to the parent
issue, so without the PAT the chain stops after one sub-issue with the trigger label sitting on the
parent, which reads as work in progress forever. It warns too, and names how many sub-issues are
left so the manual remedy is one remove-and-re-add.

### A label set when the issue is *created* fires no `labeled` event

The one failure here that has nothing to do with `GITHUB_TOKEN`, and the only one a correct PAT does
not fix.

Every trigger in this loop listens on `types: [labeled]` and gates on `github.event.label.name`.
Labels passed in the **create** call produce only `issues.opened` — they ride along in that
payload, but no `labeled` event is emitted and `github.event.label` does not exist on `opened`. The
label is really on the issue, and the workflow correctly never saw an event.

So **label in a separate call from creation**, always. This bites the moment anything publishes
issues programmatically — a script, a planning skill, an agent seeding its own backlog — and it
looks exactly like the `GITHUB_TOKEN` no-op above, so it gets misdiagnosed as a missing PAT.

Recovery on an issue that already carries the label is **remove, then re-add** — which is the next
failure, reached from the other side.

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

> **A warning about diagnosing any of these.** These share a signature with a GitHub Actions platform
> incident — label present, no run, no error, nothing in any log. During one such incident a label
> add was misread here as a further, structural rule (that a GitHub App's label adds are suppressed
> like `GITHUB_TOKEN`'s), which would have written off the App-identity path in `parity.md` §9.4.
> Re-running the same label add hours later dispatched normally. The rules above are documented and
> **retestable**; an outage is neither. Before concluding a trigger is structurally dead, do it
> twice.

---

## 2. Secrets

| Secret | Required | What breaks without it |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | **yes** | every agent workflow fails immediately |
| `AGENT_PAT` | effectively yes | all three failures in §1 |

Two secrets, and there is deliberately no third. The runner package is installed from **GitHub
Packages**, which needs a token — but that token is the built-in `GITHUB_TOKEN`, so what a
consuming repo owes is a **permission**, `packages: read` in each caller (§4), not another secret
to mint and rotate. Miss it and the run dies at `npx` with a 401; see §4 for why that reads like
the wrong thing.

> **Verified cross-repo, not assumed.** GitHub Packages has no anonymous install even for a public
> package, so it was an open question whether a *consuming* repository's own `GITHUB_TOKEN` would
> be accepted for a package owned by a *different* repository, or whether an explicit package grant
> or a PAT would be needed. A probe run from `jeffwlawson/winget-manifest-lint` — nothing but
> `packages: read` and `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` — installed and ran
> `@jeffwlawson/agent-workflows` successfully. The permission is genuinely all an adopter owes.

`AGENT_PAT` is a **fine-grained** personal access token. Use **one token with every repo running
the loop in its access list**, not one token per repo: rotation is manual and a lapse is silent, so
N tokens means N chances to forget. Permissions:

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
> expiry safe rather than reckless.

The workflows fall back to `GITHUB_TOKEN` when `AGENT_PAT` is absent, so they still run — they just
hit §1. That fallback is deliberate: the shape stays identical, and the failure is loud rather than
structural.

> **Set a reminder for the token's expiry, or install `token-expiry.yml`.** A lapsed PAT produces
> §1's third failure — reviews stop happening and nothing says why. That workflow reads the expiry
> weekly and files an issue at 21 days. It is in this repo and is repo-agnostic.

---

## 2b. Choosing the model

Defaults are baked into the runner package (`shared/common.ts` in its sources), and **most specific
wins**:

| Source | Scope |
|---|---|
| `AGENT_MODEL_<WORKFLOW>` variable | that workflow only — `AGENT_MODEL_REVIEW`, `AGENT_MODEL_UPDATE_BRANCH`, `AGENT_MODEL_IMPLEMENT`, `AGENT_MODEL_IMPLEMENT_PRD`, `AGENT_MODEL_FIX` |
| `AGENT_MODEL` variable | every workflow, **including** ones with their own default — "run everything on X" is the point of setting it |
| per-workflow default in code | `update-branch` → `claude-sonnet-5` |
| global default in code | everything else → `claude-opus-5` |

`update-branch` is the one mechanical job: the workflow merges in bash and only wakes the agent when
git reports a conflict, so the task is reconciling two known texts rather than designing anything.
Everything else — writing code from a spec, reviewing it, acting on review feedback — gets the
strongest model, because those are the steps where a plausible-but-wrong answer costs the most.

Set them as **repository variables** (Settings → Secrets and variables → Actions → Variables). No
commit, no PR, and reverting means clearing the variable.

A **variable**, not a secret, deliberately: secrets are masked in logs, so "which model produced
this?" would become unanswerable. Each run echoes `Agent model: <id> (<source>)` — where source is the
variable that won, `<workflow> default`, or `default` — for the same reason.

> **The one trap.** An unset `vars.X` interpolates to the **empty string**, not to nothing. Resolve
> it with `||`, never `??` — nullish coalescing passes `""` straight through and hands the CLI an
> empty model id. Same shape as the `secrets.AGENT_PAT || secrets.GITHUB_TOKEN` fallbacks.

Pin an explicit id rather than tracking a floating alias, for the reason `.nvmrc` exists: the
runner, CI and a local run must not drift onto different versions. Bumping is then a decision with a
timestamp, which also lets you attribute a change in output quality to it.

The precedence chain is covered by tests in `tests/common.test.ts`, including the empty-string case
above. A wrong order does not error — it quietly runs every agent on the wrong model, and the only
trace is a log line nobody reads until output quality is questioned weeks later.

---

## 3. Labels

All of these must exist. A missing label makes its transition a no-op, and the state machine drifts
without erroring.

```bash
gh label create "agent:implement"   --color 0E8A16 --description "Ready for the implement workflow to run"
gh label create "agent:review"      --color 1D76DB --description "PR is ready for the automated review workflow"
gh label create "agent:fix"         --color 1D76DB --description "Address review feedback on this PR"
gh label create "agent:update-branch" --color 5319E7 --description "Refresh this PR branch from its base branch"
gh label create "agent:in-progress" --color FBCA04 --description "An agent run is currently active"
gh label create "agent:blocked"     --color B60205 --description "A run failed or was refused; needs human attention"
```

**Trigger labels are consumed on entry.** That is what makes a retry idempotent — a human re-adds
the label deliberately. It is not a rule with exceptions, though. It is a three-valued property,
and which value a label has is a **column**:

| Label | Lifecycle | Cleared by |
|---|---|---|
| `agent:review`, `agent:fix`, `agent:update-branch` | **consumed on entry** | the run, as it starts |
| `agent:implement` on an ordinary issue | **consumed on entry** | the run, as it starts |
| `agent:implement` on a PRD parent | **cursor** | the chain, by *not* re-adding it after the last slice |
| `agent:follow-ups` on a pull request | **marker, removed on success** | the filing run, on any run that reached a verdict — or you, to opt out |

**Fill the column in when you add a label.** Written as prose this said "consumed on entry, except
on a PRD parent, and also except for the marker" — which is read as "consumed on entry", and the
exception nobody read is the one that behaves differently at three in the morning.

**The cursor.** The PRD chain re-adds `agent:implement` to the parent itself after each sub-issue
closes, and stops by *not* re-adding it. So on a parent issue the label is a cursor rather than a
one-shot: seeing it there means the next slice is due, and seeing it there with no run happening
means the PAT is missing (§1).

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

`agent:in-progress` is held for the duration and removed by an `always()` step; `agent:blocked` is
applied on failure alongside a comment carrying the reason — and by either `implement` workflow
when it refuses an issue's *shape* (a sub-issue, a nested PRD, or a `wayfinder:*` planning ticket),
since re-labelling would only reproduce the same refusal.

**Amend the issue before you label it, never after.** The runner reads the issue body when the run
starts, so an edit made afterwards describes work the agent was never asked to do — the PR then
answers a spec that no longer exists, and the mismatch surfaces as a review finding rather than as
anything obviously a timing problem.

The PRD chain widens this. A parent's body is read fresh **by every slice**, so editing it mid-chain
changes the brief under the slices that have not run yet, and the same PR ends up built against two
different specs. If something has to change after labelling, say so on the PR instead: that reaches
the review and fix agents, which the issue body no longer does.

**Where the labels come from is a separate question.** These are all *workflow state*. If you also
run a triage step — a human or a planning skill deciding an issue is well enough specified to hand
over — that is a second vocabulary, and joining the two is a decision you have to make explicitly.
`docs/agents/triage-labels.md` records this repo's answer: the canonical triage roles, the
`agent:*` label no workflow reads (`agent:queued`, declared but inert), the `wayfinder:*` planning
labels that never trigger a workflow, why `ready-for-agent` → `agent:implement` stays a human hand
rather than an automation, and the one join that is *not* a human hand — a filed stub arriving
`needs-triage`. Take it alongside the workflows and edit the mapping — in the order §4 gives, since
the file is also a skill's output path — and the reasoning survives the rename.

### Three more, and none of them mandated

`init` creates none of them and `doctor` demands none of them; `init` does *list* them in the
`SETUP.md` it writes, and only for a repository it installed the filing caller into, since a caller
you declined is three labels nothing will ever read. They arrived after the six above, so a
repository can be current on the pin without them — and nothing fails when they are missing, which
is the problem. What each absence costs is below.

```bash
gh label create "agent:follow-ups" --color 0052CC --description "This PR's review recorded out-of-scope findings"
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
| **🟢 Approval recommended** | `success` | Approval recommended. Nothing left to fix. Merge when ready; follow-ups are filed as issues on merge. |
| **🟡 Changes recommended** | `failure` | Changes recommended. The fixes are clear. Add agent:fix to start a fix round; a re-review follows automatically. |
| **🟡 Changes recommended**, after a fix round | `failure` | Changes recommended. A fix round didn't settle these. Read the review, add guidance where it helps, then add agent:fix. |
| **🔵 Needs a closer look** | `failure` | Needs a closer look. A fix round can't settle this alone. Read the review, add guidance, then add agent:fix or close the PR. |

The third column is the status description **verbatim** — what GitHub shows you is what is written
here, and the same words open the review summary, so the two cannot tell you different things.
Three headings and four rows: *Changes recommended* has a first-round line and a second-round one,
because a fix round that has already run and not settled the findings is the same assessment with a
different next step. Only the last two rows ask you to read anything.

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

If no verdict arrives on *any* pull request, a caller missing `statuses: write` is the likeliest
cause — the review still posts, so there is nothing on the pull request to say so. That is §4, and
`doctor` reports it. It is not the only cause: GitHub can refuse the status itself, which is ours
rather than yours. The run's warning prints what GitHub replied and says which of the two it was, so
read that before you touch the caller.

**The loop keeps it current, and stops short of your hand.** A `fix` run that pushed asks for its
own re-review, so a round closes itself out rather than leaving *add `agent:fix`* standing over a
branch that was already fixed; a clean `agent:update-branch` refresh copies the verdict on to the
merge commit it makes, and one that had to resolve conflicts asks for a review of what it wrote
instead. What no workflow here does is add `agent:fix`. That label is the human hand in the loop,
and the table above is where you are asked for it.

A **copied** verdict says what it said before: it is the review's word about the branch work, not a
claim about the merge commit it now sits on. That commit's own checks have not been read — they had
not run when the copy was made — so a `success` carried on to a merge commit means "the last review
of this branch found nothing to fix", and whether the merge itself is green is what the merge box's
other checks are for.

### Reading the review body

The verdict is the one-line answer; the review body is the record it was derived from. It opens with
`## Agent review`, which is how you tell it apart in a timeline where every agent in the loop posts
as `github-actions[bot]`, and is then laid out like Copilot code review's overview, in one fixed
order: the assessment heading from the table above, one sentence naming what is unresolved, the next
step in italics, `**Findings:** N` with the severities behind it, then the findings in collapsible
groups, then two collapsed sections on the review itself, then a rule and a link to the run. There
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
- **Follow-ups** — the out-of-scope findings this review recorded, filed as issues when the pull
  request merges. Folded, and **not** in `**Findings:** N`: that number is what blocks this pull
  request, and a follow-up is by definition what does not. Removing the `agent:follow-ups` label is
  how you decline them.

Two collapsed sections follow the groups, and neither is a place a finding is ever restated:

- **How this was checked** — what the reviewer verified: checks it ran or read, behaviour it
  traced, files it opened past the diff. It is how you weigh the review, and it is on every one.
- **What changed in this PR** — one sentence and up to five lines describing the change. It appears
  on the first review of a pull request, and again when commits have landed that no verdict has
  seen — your own push, or a conflict resolution. A verification pass after a fix round omits it,
  because you were handed that description last round.

A carried entry's title is a **link to the thread it was raised in**, which is what saves you
scrolling back through an older review to find it. A finding this review is the first to raise has
no link, because its thread is opened by the same call that posts the body and renders directly
beneath it.

Every entry carries a **severity** — `High`, `Medium` or `Low` — and each group is sorted worst
first. It is for reading and for ordering, and for nothing else: the verdict is not derived from it,
whether a finding blocks the merge or becomes a follow-up issue does not read it, and three `Low`
findings get the same assessment as three `High` ones. That is deliberate — a dial the agent turns
that changes the outcome is one you have to check on every review to find out which way it was
turned. `Low` means a real but small defect; preferences are still posted nowhere, at any rating.

An entry quoted in full, with its evidence indented under it, is a finding in a file this pull
request does not change. GitHub has no diff line to hang a thread on there, so the body is the only
place it can live. Every other entry is the one-line version of a thread, and the thread is where
you answer it.

**The review resolves a thread; an `agent:fix` run resolves none.** A fix run replies in every
thread it was shown — `addressed` or `declined`, with its reason — and leaves all of them open. What
closes one is a *later review* reading the code as it now stands, finding the fix landed and saying
so in a reply on the way out; or you, resolving it yourself. So an open thread is not evidence that
nothing has been done about it: read the last reply. This is the other half of why the second round
exists — the pass that closes a finding is never the pass that wrote the fix.

A thread an `agent:fix` run **declined** is the case to know: it stays open until you rule on it.
The loop will not retire a finding on the strength of its own disagreement with it. Your own
decline, replied on the thread, is a different thing — the next review closes that one as
`WONT_FIX`, quoting you, and stops counting it. If it misreads you it leaves the thread open, which
is the direction that costs a round rather than a decision.

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
  can only make the next review a second round, and a second round is stricter, not laxer. What it
  is not safe for is a merge gate, where the effect is the gate satisfying itself. So read the
  verdict alongside the diff that produced it — which on a branch that edits `.github/workflows/`
  you were going to do anyway.
- **The second round is strict on purpose.** A fix round that pushed gets a verification review,
  and that round cannot answer with the first-round *Changes recommended* line — a finding that
  survived a fix round gets the second-round one instead, which asks you to read the review (adding
  guidance where it helps) before labelling again, on the grounds that a second fix has no more reason to settle it than the
  first did. That is the right default while you are the one deciding what happens next. As a merge
  gate it means the second round sends you to the review rather than round the loop again, which is
  a good deal more of your attention than the un-gated version asks for.

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
- **It gates the threads, not the whole record.** A finding in a file the pull request never
  touches has no thread to resolve, so this setting cannot see it; it is in the review body under
  *Open* and it counts toward the verdict, which is what the required check gates. The two settings
  cover different halves of the same record, which is an argument for running both rather than for
  picking one.
- **Give the resolutions a few rounds first.** Which threads close is a judgement the review now
  makes on its own, against code a fix run wrote, and it is the newest thing in the loop. Watch a
  handful of rounds and read what it closed and what it left open before you make those closures
  the thing your merges wait on. The required check asks you to trust a verdict you can read in one
  line; this asks you to trust a decision per finding, so it is the later of the two to switch on.

---

## 4. Files to write

**Nothing in the loop is copied any more.** As of #98 every workflow in the loop is split in two: a
`*-reusable.yml` here holding the job — the fork guard, the permissions ceiling, the concurrency
group, the preflight, every step — and a **caller** in your repo holding the trigger, the token
grant and the secrets. You write the callers; you reference the jobs.

That is the difference between installing this loop and forking it. A control you copy is a control
that drifts; a control behind a pinned `uses:` is one you get fixes to.

```
.github/workflows/agent-implement.yml
.github/workflows/agent-implement-prd.yml
.github/workflows/agent-review.yml
.github/workflows/agent-fix.yml
.github/workflows/agent-update-branch.yml
.github/workflows/agent-follow-ups.yml      # optional — this file is the off switch
.github/dependabot.yml                      # not part of the loop; see the end of this section
```

**`agent-follow-ups.yml` is the first genuinely optional file in that list.** It files a merged
pull request's recorded out-of-scope findings as triageable issues, and copying it is the whole of
switching that on: the runner subcommand ships inside the package and the reusable lives here, but
nothing invokes a reusable except a caller's reference, so a repository without this file files
nothing. Not a mechanism invented for this: it is the same per-file granularity that already lets
you skip `agent-implement-prd.yml`.

`init` (§0) scaffolds the lot on a first run, this file included, so **opting out is deleting it
afterwards** rather than declining it up front. That is not a gap in the command: a re-run pins
what is installed, and a caller you deleted is named rather than written back into your tree.

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
the same copy with the pin substituted. One file per workflow, each already
carrying the correct trigger, permissions, `self-check` and pinned `uses:`. Drop them into your
`.github/workflows/` and rename if you like — the job id is the only thing you cannot rename
freely, for the reason below.

They are real files rather than a block quoted here, and that is load-bearing twice over. What you
install is the thing that was checked: `tests/workflows.test.ts` reads those files and asserts the
trigger, the permissions on both halves, the pin, and the `self-check` coupling. And the coupling
*needs* both halves present to be verified at all — while the callers were a code block, the
reusable half lived in this repo and the caller half lived in whichever repo had adopted the loop,
so the pair could only ever be checked by hand, in a repository this one cannot see.

For orientation, a caller is a trigger and two wires — copy the real ones from
[`examples/callers/`](../examples/callers/), which carry the live pin where this sketch has a
placeholder:

```yaml
name: Agent Fix

on:
  pull_request_target:      # `issues:` for the two implement workflows
    types: [labeled]

jobs:
  fix:
    uses: jeffwlawson/agent-workflows/.github/workflows/fix.yml@v<latest tag>
    permissions:
      contents: write
      packages: read            # install the runner package; see above
      pull-requests: write
    # with:
    #   default-branch: main       # all three default to what is shown; a
    #   node-version-file: .nvmrc  # non-Node repo passes '' for the last two
    #   setup: npm ci              # and still gets the loop
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      AGENT_PAT: ${{ secrets.AGENT_PAT }}
```

> **Pin a tag or a SHA, never a branch.** `pull_request_target` reads workflow YAML from the base
> branch, so a pull request cannot edit your caller to change what runs. That protection used to
> cover the called workflow for free, when the `uses:` was a local path resolving against the same
> commit. Remote, the reference is what decides: `@main` hands a job holding `contents: write` and
> your secrets to whatever currently sits on this repository's default branch, and nothing anywhere
> reports it. A test enforces the tag-or-SHA shape on the reference callers.


The permissions per workflow, which are what each job actually spends:

| Caller | `checks` | `contents` | `issues` | `packages` | `pull-requests` | `statuses` |
|---|---|---|---|---|---|---|
| `agent-implement` | — | write | write | read | write | — |
| `agent-implement-prd` | — | write | write | read | write | — |
| `agent-review` | **read** | **read** | — | read | write | **write** |
| `agent-fix` | — | write | — | read | write | — |
| `agent-update-branch` | — | write | — | read | write | **write** |
| `agent-follow-ups` | — | read | **write** | read | write | — |

`packages: read` is the one row that is the same everywhere, because it is not about what the job
does — it is about installing the runner it runs.

> **`issues: write` is on one row only, and it is the one that creates issues.** No other workflow
> in the loop holds it to *file* anything — the `implement` pair spends it on labels and on closing
> a sub-issue the PRD already lists. It is also the only caller that passes **no secrets at all**:
> the job runs no model, so there is no `CLAUDE_CODE_OAUTH_TOKEN` to hand over, and it creates its
> issues with `GITHUB_TOKEN`, so there is no `AGENT_PAT` either — a repository without the PAT
> files exactly as much as one with it. Adding either to your caller is not harmless: GitHub
> refuses a `secrets:` entry the called workflow does not declare, before the job starts.

> **`statuses: write` on review is what posts the verdict**, and it is a scope of its own rather
> than part of `pull-requests: write` — a commit status is attached to a commit, not to a pull
> request. Without it the review posts, the run stays green and no verdict appears anywhere: the
> step warns rather than failing, on the grounds that a posted review is worth more than the line
> summarising it. So nothing on the pull request says the grant is missing, which is why `doctor`
> reports it as an error. Newer than the five scopes above it, so a caller installed against an
> earlier release has a review that works and a verdict that never arrives. What the verdict says,
> and what you do with each one, is §3b.

> **`statuses: write` on update-branch is what keeps it**, for the same reason and with the same
> silence when it is missing. A clean refresh copies the verdict from the commit that was reviewed
> on to the merge commit it creates, because the new commit carries none until something posts one.
> Without the scope the copy 403s and the step warns — it cannot fail, since the merge is pushed by
> then — so the pull request reads as unreviewed and every refresh quietly costs a review round.
> A refresh that had to *resolve* conflicts copies nothing and adds `agent:review` instead, which
> is a label rather than a status and needs no scope of its own.

> **`checks: read` on review is the row that only a private repository needs — and it is not
> optional there.** The CI wait polls `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`, which a
> **public** repository serves without the scope. Every repo in this pilot was public, so the grant
> was missing from v0.1.0 through v0.1.4 and nothing ever failed. The first private adopter got
> `403 Resource not accessible by integration` on every poll, and — because the count was defaulted
> over the error — the job spent its full 900-second budget before reviewing with no CI evidence at
> all, the exact outcome #48 exists to prevent. Fixed on both halves — the pin in
> [`examples/callers/`](../examples/callers/) carries the release that has it; since a called
> workflow can only *downgrade*, adding it to your caller alone changes nothing on an older pin.

> **The same wait needs `jq` on the runner**, which is new in this release — before it the only
> filtering was gh's own embedded `--jq`. Nothing you configure here can take it away: this
> workflow hard-codes `runs-on: ubuntu-latest`, an image that ships `jq`, and exposes no `runs-on`
> input. So this is recorded for whoever changes that line, not as a step for you to take. Without
> `jq` the wait reports itself blind in exactly the words above — and that message names
> `checks: read`, because a missing grant is overwhelmingly the likelier cause. What separates them
> is the line printed underneath it: the step echoes whatever `gh` or `jq` wrote to stderr, so a
> runner without `jq` says `jq: command not found` outright.

> **`AGENT_PAT` defers two of these; it does not replace them, and `doctor` reports both as
> failures whether or not you have one.** The checkout that pushes runs under
> `${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}`, as do `gh pr create` and every `agent:review`
> label the loop adds itself — on the `implement` pair, on a `fix` run that pushed, and on an
> `update-branch` run that resolved conflicts. So with the PAT set, a caller missing
> `contents: write` or `pull-requests: write` keeps working — until the token expires (§2), and
> then loses a full agent pass to a 403 at the push. Nothing defers the calls the workflow token
> serves: every label transition 403s the first time it runs, and on a **private** repository so
> does `implement`'s preflight `gh pr list`, before any branch exists. The grants are what your
> job has to hold; the PAT only decides when you find out.

Four things about that shape are worth knowing before you paste it:

- **`permissions` has to be on your job too.** The called workflow can only *downgrade* the token it
  is handed, so it cannot grant itself the `pull-requests: write` its label edits spend. On a repo
  whose default `GITHUB_TOKEN` is read-only, omitting this block gives you a run that dies at its
  first label edit — `Resource not accessible by integration`, on a step named for labels, before
  anything is checked out. The two blocks say the same thing for opposite reasons — yours grants,
  ours bounds — which is why `contents: read` on review stays an invariant no caller can widen.
- **Pin the `@ref`.** Same reasoning as the runner version above, and the same trap: a floating
  `@main` is a workflow that changes under a pull request nobody touched. An exact pin is a pin
  that goes stale, which nothing in this repository can see from here — *Keeping the pins fresh*,
  at the end of this section, is the other half of the instruction.
- **Name each workflow `Agent …`.** A called workflow contributes no run of its own, so the run is
  yours — and review's failure-log collector skips runs whose name starts with `Agent ` on the
  grounds that a failed agent job is not evidence about the diff.
- **Name the secrets rather than `secrets: inherit`.** Inheriting hands the called workflow every
  secret your repository holds. `AGENT_PAT` is declared optional, so passing an unset one is fine —
  it arrives as the empty string, which is what the fallbacks in §1 expect.

### `agent-review` needs one input more

Review polls every check on the head commit and waits for the ones still running, so it has to
recognise its own — and a called workflow's job appears as `<caller job id> / <called job id>`,
which nothing inside the called workflow can read. Hence `self-check`, required:

```yaml
jobs:
  review:
    uses: jeffwlawson/winget-manifest-lint/.github/workflows/agent-review-reusable.yml@<commit sha>
    permissions:
      contents: read
      packages: read
      pull-requests: write
    with:
      self-check: review / review    # `<this job's id> / review`
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      AGENT_PAT: ${{ secrets.AGENT_PAT }}
```

Rename the job, change the input. A name review does not recognise as its own is a job waiting for
itself — 15 of its 20 minutes, then a review with degraded evidence and no error anywhere.

`agent-implement-prd` is optional but **not independent**: it shares the `agent:implement` label
with `agent-implement`, and the two partition every label event by issue shape. Take both or
neither. Taking only the PRD one leaves ordinary issues unhandled; taking only `agent-implement` is
fine in itself, but a PRD-shaped issue then reaches a job that *defers* to a workflow you did not
install, and nothing happens at all.

Optional, and the one file still copied verbatim: `.github/workflows/token-expiry.yml`. It is
offered as-is because it is already repo-agnostic — no branch names, no toolchain, no paths, just
`AGENT_PAT` and the GitHub API — so there is nothing for a `workflow_call` surface to parameterise.
Splitting it would add a file and a pin to save nobody an edit.

Optional, and needs its mapping rewritten for your labels: `docs/agents/triage-labels.md` (§3).
Run `/setup-matt-pocock-skills` **first** — it writes every file in `docs/agents/`, including
`triage-labels.md` at that same path — then copy this repo's version on top of what it generated.
The reverse order silently loses everything below the mapping table, because the skill rewrites
the file with its own default version.

**If you take `agent-implement-prd.yml`, take `docs/agents/ticket-shape.md` with it.** The workflow
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
the group the moment you copy the file. A sixth file needing a seventh line of config would be a
pin that splits across two releases the first time somebody forgot to write it.

The second group is why `actions/checkout` and `astral-sh/setup-uv` do not each arrive on their own.
The ecosystem is repository-wide: those pins are in scope whether or not you say anything about
them, so the choice is a second group or a stray pull request each — not "covered" or "ignored".
Keeping them out of `agent-loop` is deliberate; "the loop moved" and "the actions moved" are
different reviews.

Two things it does **not** do.

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
| Default branch is `main` | `default-branch`, on every caller that takes inputs | It means two different things by event, and both are right. On `review`, `fix` and `update-branch` the base comes from the pull request (#71, #100) and this is only the fallback for an event carrying none — which never happens on a real PR, but degrades *silently* when it does. On the two `implement` workflows there is no event field to read: an `issues` event says nothing about branches, so this **is** the branch they cut from and open the PR against. It reaches the runners as `BASE_REF` too, so the prompts name a branch that exists (#98) — `implement/implement.ts` used to count commits against a literal `main`, which was the one site here that *hard-errored* rather than misbehaving quietly |
| `npm ci` and `.nvmrc` | `setup` and `node-version-file`, on the same set | the whole toolchain assumption, and both are skippable: pass `''` and a repo whose toolchain is not Node still gets the loop, running on the image's own Node. The filing caller is outside this row rather than exempt from it — it declares no inputs, because it checks nothing out and has no toolchain to configure. Only `npm install -g @anthropic-ai/claude-code` is unconditional, and that is the agent's own runtime rather than yours |
| The gate command (`npm run verify` here) | not an input, and not a coupling | each prompt says to run "the verify command `CLAUDE.md` names", so writing your gate down once in `CLAUDE.md` (§6) is the whole of it. It cannot become an input: `runWithExtraction` drops prompt arguments before the extraction pass, so a placeholder would reach one prompt literal |
| `CONTEXT.md` and `CLAUDE.md` exist | still yours to write | see §6. This is the coupling the others turned into — a de-domained prompt makes it total rather than partial |
| Project domain | **not a coupling** (#95) | the prompts name no domain of their own. A test walks every prompt and runner file and fails on any adopting repo's vocabulary, so it stays that way |
| Sub-issues are created blockers-first | **not an input, by design** | `agent-implement-prd` walks sub-issues in **API order** and never reads `blocker` edges, so whatever publishes them owns the topological sort. If yours publishes in an arbitrary order, fix that rather than teaching the chain to read edges (docs/parity.md §2a). The publishing side is `docs/agents/ticket-shape.md` — including the repair, which reorders the parent's list rather than recreating the slice |

Your own CI is the one place a branch name is still yours to write, and it always was: `ci.yml`
here triggers on `branches: [main]`. A workflow's *trigger* cannot come from a `workflow_call`
input — that is the same limitation that keeps the trigger in your caller rather than in the
reusable half — and your CI is not part of this loop anyway. Nothing about the conversion changes
it; it is named here only because the row it used to share is gone.

Nothing above will error if you get it wrong — with one exception worth knowing, because it is the
exception on purpose. An empty base ref used to default to `main` inside the runners; since #98 it
fails the run with a message naming the input, on the grounds that a review silently diffing
against the wrong branch is worse than a run that stops and says so.

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
unattended and reviews once at the end (docs/parity.md §2a), so an uncited criterion in slice 1 is
built on for the length of the PRD before anybody reads it.

---

## 8. If your repo is public

`agent-review`, `agent-fix`, `agent-update-branch` and — if you took it — `agent-follow-ups` use
`pull_request_target`, which runs with write access, and with secrets everywhere but the last.
These controls are not decoration — and since #98 you no longer copy any of them: every one lives
in a `*-reusable.yml` you reference, where a caller can skip the job but cannot loosen it. Read
them anyway. Not to install them, but because a control you cannot see is one you cannot reason
about, and the paragraph after the table is a decision only you can make.

| Control | Why |
|---|---|
| **Fork guard**: `head.repo.full_name == github.repository` in the job-level `if` | without it a fork PR runs its own code with your secrets in scope. Fails closed before a runner is provisioned |
| **Author-association gate** on every issue/PR/comment/review-thread body | all world-writable. Anyone can *open* an issue or comment on a PR; `agent:fix` acts on that text and pushes code. Trusts `OWNER` / `MEMBER` / `COLLABORATOR` — org-adjacent or better, *not* write access; see the paragraph below |
| **Trust your own bot by login** — `github-actions[bot]` **and** `github-actions` | REST and GraphQL spell the same account differently. List one and the review→fix handoff silently drops its own agent's comments |
| **Scrub the GitHub token** from the agent's environment after fetching context | the agent runs unsandboxed; it has no legitimate `gh` use once context is read |
| **`contents: read`** on review | the one agent structurally unable to mutate the branch |
| **No model in the job that files** | `agent-follow-ups` holds `issues: write` and reads issue bodies to decide what is a duplicate. Both at once is a prompt-injection surface, so it installs no agent, declares no secrets and checks nothing out; what would be an agent's judgement is a pure function in the runner |

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
as part of the setup. Pick one before you add a collaborator (#102).

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
takes the workflow YAML from the *base* branch but checks out the **PR head**, so anything a run
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
anchor it cannot resolve is rerouted rather than dropped: to a thread on the file, or to an entry in
the review body when the file is not in the diff at all. The runner logs
`Findings: N produced — a on a line, b on a file, c in the body`; trust that counter, not an agent's
argument that its own placement is sound.

---

## 10. Local development

Don't, on Windows. `@ai-hero/sandcastle`'s `shellEscape` is POSIX-only with no platform branch, so
the model id reaches the CLI wrapped in literal single quotes and the API returns a 404 that reads
like an entitlement problem. It affects every provider the tool supports, not just Claude. Linux CI
is unaffected — `sh` strips the quotes.

Develop against CI, or use WSL.
