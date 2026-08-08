# Adopting this agent loop in another repo

Five GitHub Actions workflows that let a labelled issue become a reviewed pull request without a
human in the middle — four for a single issue, and one that works a parent issue's sub-issues in
sequence onto one branch. This is what it takes to install them somewhere else.

Everything below was learned by hitting it. `docs/friction.md` has the narrative; this file is the
checklist, and it is ordered so the things that fail *silently* come first.

---

## 1. The four failures that look like something else

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

---

## 2. Secrets

| Secret | Required | What breaks without it |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | **yes** | every agent workflow fails immediately |
| `AGENT_PAT` | effectively yes | all three failures in §1 |

`AGENT_PAT` is a **fine-grained** personal access token scoped to the repo. Permissions:

| Permission | Why |
|---|---|
| Contents: **write** | push the agent's branch |
| Pull requests: **write** | open the PR, add labels to it |
| Issues: **write** | label transitions on issues |
| Workflows: **write** | only if agents may modify `.github/workflows/**` — a push touching those paths is rejected without it, *after* the agent has done all its work |

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

All six must exist. A missing label makes its transition a no-op, and the state machine drifts
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
the label deliberately. `agent:in-progress` is held for the duration and removed by an `always()`
step; `agent:blocked` is applied on failure alongside a comment carrying the reason — and by either
`implement` workflow when it refuses an issue's *shape* (a sub-issue, a nested PRD, or a
`wayfinder:*` planning ticket), since re-labelling would only reproduce the same refusal.

**The one exception is the PRD chain**, which re-adds `agent:implement` to the parent itself after
each sub-issue closes, and stops by *not* re-adding it. So on a parent issue the label is a cursor
rather than a one-shot: seeing it there means the next slice is due, and seeing it there with no run
happening means the PAT is missing (§1).

**Where the labels come from is a separate question.** These six are *workflow state*. If you also
run a triage step — a human or a planning skill deciding an issue is well enough specified to hand
over — that is a second vocabulary, and joining the two is a decision you have to make explicitly.
`docs/agents/triage-labels.md` records this repo's answer: the five canonical triage roles, the
seventh `agent:*` label (`agent:queued`, declared but inert), the `wayfinder:*` planning labels
that never trigger a workflow, and why `ready-for-agent` → `agent:implement` stays a human hand
rather than an automation. Take it alongside the workflows and edit the mapping — in the order §4
gives, since the file is also a skill's output path — and the reasoning survives the rename.

---

## 4. Files to write

**Nothing in the loop is copied any more.** As of #98 all five workflows are split in two: a
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
```

The runners are **not copied either**. They are an npm package — `@jeffwlawson/agent-workflows` —
and the reusable workflow invokes one subcommand of it at a version pinned in *its* YAML:

```yaml
run: npx --yes @jeffwlawson/agent-workflows@0.1.0 review
```

Prompts ship inside the package, so there is nothing to copy and nothing to keep in step. That pin
is ours rather than yours now, which is one fewer thing for you to get wrong — but the reasoning
still matters when you pin the `@ref` below: an **exact** version, never a range or a dist-tag, for
the reason `.nvmrc` exists, and because the pin being in base-controlled YAML is what closes §9's
first trap. Pinning through your own `package.json` would look equivalent and close nothing (§9).

### What a caller looks like

Four of the five are this, with the name, the job id, the label's workflow and the permissions
changed:

```yaml
name: Agent Fix

on:
  pull_request_target:      # `issues:` for the two implement workflows
    types: [labeled]

jobs:
  fix:
    uses: jeffwlawson/winget-manifest-lint/.github/workflows/agent-fix-reusable.yml@<commit sha>
    permissions:
      contents: write
      pull-requests: write
    # with:
    #   default-branch: main       # all three default to what is shown; a
    #   node-version-file: .nvmrc  # non-Node repo passes '' for the last two
    #   setup: npm ci              # and still gets the loop
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      AGENT_PAT: ${{ secrets.AGENT_PAT }}
```

The permissions per workflow, which are what each job actually spends:

| Caller | `contents` | `issues` | `pull-requests` |
|---|---|---|---|
| `agent-implement` | write | write | write |
| `agent-implement-prd` | write | write | write |
| `agent-review` | **read** | — | write |
| `agent-fix` | write | — | write |
| `agent-update-branch` | write | — | write |

Four things about that shape are worth knowing before you paste it:

- **`permissions` has to be on your job too.** The called workflow can only *downgrade* the token it
  is handed, so it cannot grant itself the `pull-requests: write` its label edits spend. On a repo
  whose default `GITHUB_TOKEN` is read-only, omitting this block gives you a run that costs a full
  agent pass and silently transitions nothing. The two blocks say the same thing for opposite
  reasons — yours grants, ours bounds — which is why `contents: read` on review stays an invariant
  no caller can widen.
- **Pin the `@ref`.** Same reasoning as the runner version above, and the same trap: a floating
  `@main` is a workflow that changes under a pull request nobody touched.
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
Run `/setup-matt-pocock-skills` **first** — it writes all three files in `docs/agents/`, including
`triage-labels.md` at that same path — then copy this repo's version on top of what it generated.
The reverse order silently loses everything below the mapping table, because the skill rewrites
the file with its own default five-row version.

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
what **this** repo needs to develop the package, since its sources live here in
`.sandcastle/agent-workflows/`:

```
@ai-hero/sandcastle  @standard-schema/spec  tsx  typescript
```

Its `tsconfig.json` includes `.sandcastle/**/*.ts` so `npm run typecheck` covers the runner code.
Keep `rootDir` out of the base config — put it in a separate build config — or `tsc` fails with
TS6059 the moment a file lives outside it. The package has its own build config doing exactly that
(`npm run build:agent-workflows`), and `prepack` runs it so a publish cannot ship a stale `dist/`.

---

## 5. What you must change

Nothing in the loop, any more. Every coupling this table used to list is an **input** you set in
your caller — or, in three cases, was never a coupling to begin with and is recorded here so the
next person does not go looking for it.

| Assumption | Now | Notes |
|---|---|---|
| Default branch is `main` | `default-branch`, on all five | It means two different things by event, and both are right. On `review`, `fix` and `update-branch` the base comes from the pull request (#71, #100) and this is only the fallback for an event carrying none — which never happens on a real PR, but degrades *silently* when it does. On the two `implement` workflows there is no event field to read: an `issues` event says nothing about branches, so this **is** the branch they cut from and open the PR against. It reaches the runners as `BASE_REF` too, so the prompts name a branch that exists (#98) — `implement/implement.ts` used to count commits against a literal `main`, which was the one site here that *hard-errored* rather than misbehaving quietly |
| `npm ci` and `.nvmrc` | `setup` and `node-version-file`, on all five | the whole toolchain assumption, and both are skippable: pass `''` and a repo whose toolchain is not Node still gets the loop, running on the image's own Node. Only `npm install -g @anthropic-ai/claude-code` is unconditional, and that is the agent's own runtime rather than yours |
| The gate command (`npm run verify` here) | not an input, and not a coupling | each prompt says to run "the verify command `CLAUDE.md` names", so writing your gate down once in `CLAUDE.md` (§6) is the whole of it. It cannot become an input: `runWithExtraction` drops prompt arguments before the extraction pass, so a placeholder would reach one prompt literal |
| `CONTEXT.md` and `CLAUDE.md` exist | still yours to write | see §6. This is the coupling the others turned into — a de-domained prompt makes it total rather than partial |
| Project domain | **not a coupling** (#95) | the prompts name no domain of their own. A test walks every file under `.sandcastle/` and fails on this repo's vocabulary, so it stays that way |
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

`agent-review`, `agent-fix` and `agent-update-branch` use `pull_request_target`, which runs with
secrets and write access. These controls are not decoration — and since #98 you no longer copy any
of them: every one lives in a `*-reusable.yml` you reference, where a caller can skip the job but
cannot loosen it. Read them anyway. Not to install them, but because a control you cannot see is
one you cannot reason about, and the paragraph after the table is a decision only you can make.

| Control | Why |
|---|---|
| **Fork guard**: `head.repo.full_name == github.repository` in the job-level `if` | without it a fork PR runs its own code with your secrets in scope. Fails closed before a runner is provisioned |
| **Author-association gate** on every issue/PR/comment/review-thread body | all world-writable. Anyone can *open* an issue or comment on a PR; `agent:fix` acts on that text and pushes code |
| **Trust your own bot by login** — `github-actions[bot]` **and** `github-actions` | REST and GraphQL spell the same account differently. List one and the review→fix handoff silently drops its own agent's comments |
| **Scrub the GitHub token** from the agent's environment after fetching context | the agent runs unsandboxed; it has no legitimate `gh` use once context is read |
| **`contents: read`** on review | the one agent structurally unable to mutate the branch |

**The trigger is weaker than the trust boundary.** Every control above gates an *input*; the
**trigger** is a label, and GitHub's **Triage** role can add labels with no push access at all. So a
triage-role collaborator can add `agent:fix` and cause an agent to push code — below the write
boundary the rest of the design assumes. Moot while you are the only collaborator, and a real
escalation path the day that changes. Two ways out, and it is a decision rather than a defect: check
`github.event.sender`'s permission level, or treat "never grant Triage on a repo running this loop"
as part of the setup. Pick one before you add a collaborator (#102).

If you take the first, it goes in **your caller's** job-level `if:`. That is the one direction the
seam allows — a caller's `if:` can narrow what runs, never widen it — and it is why the trade is
still yours to make after the conversion rather than ours to make for everyone.

The residual you cannot cheaply close: the agent runs unsandboxed with a model token readable in its
environment and unrestricted network egress. Every *injection source* is behind the write boundary,
so the exposure is "a compromised collaborator or a poisoned dependency could exfiltrate a scoped,
rotatable model token." Bounded and monitorable. If your threat model includes untrusted code or
long-lived secrets, you need a sandbox with egress control, which means self-hosted runners.

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

**Silence is ambiguous.** GitHub rejects an **entire** review if one inline comment anchors outside
the diff, so a broken line filter posts nothing — identical to a review that found nothing. The
runner logs `Inline comments: N kept of M produced`; trust that counter, not an agent's argument that
its own filtering is sound.

---

## 10. Local development

Don't, on Windows. `@ai-hero/sandcastle`'s `shellEscape` is POSIX-only with no platform branch, so
the model id reaches the CLI wrapped in literal single quotes and the API returns a 404 that reads
like an entitlement problem. It affects every provider the tool supports, not just Claude. Linux CI
is unaffected — `sh` strips the quotes.

Develop against CI, or use WSL.
