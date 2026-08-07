# Adopting this agent loop in another repo

Four GitHub Actions workflows that let a labelled issue become a reviewed pull request without a
human in the middle. This is what it takes to install them somewhere else.

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

Defaults live in `shared/common.ts`, and **most specific wins**:

| Source | Scope |
|---|---|
| `AGENT_MODEL_<WORKFLOW>` variable | that workflow only — `AGENT_MODEL_REVIEW`, `AGENT_MODEL_UPDATE_BRANCH`, `AGENT_MODEL_IMPLEMENT`, `AGENT_MODEL_FIX` |
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
step; `agent:blocked` is applied on failure alongside a comment carrying the reason.

---

## 4. Files to copy

```
.github/workflows/agent-implement.yml
.github/workflows/agent-fix.yml
.github/workflows/agent-review.yml
.github/workflows/agent-update-branch.yml
.sandcastle/agent-workflows/            # runners, prompts, shared helpers
```

Optional, and repo-agnostic: `.github/workflows/token-expiry.yml`.

**Do not copy** `corpus.yml` or `scripts/lint-corpus.ts` — they lint a pinned `microsoft/winget-pkgs`
snapshot. The *pattern* is worth stealing and is discussed in §7.

Dev dependencies the runners need:

```
@ai-hero/sandcastle  @standard-schema/spec  tsx  typescript
```

Your `tsconfig.json` must include `.sandcastle/**/*.ts` so `npm run typecheck` covers the runner
code. Keep `rootDir` out of the base config — put it in a separate build config — or `tsc` fails
with TS6059 the moment a file lives outside it.

---

## 5. What you must change

The workflows are not yet parameterised. These are the couplings to edit by hand.

| Assumption | Where | Notes |
|---|---|---|
| Default branch is `main` | `agent-implement.yml` (×3), `implement/prompt.md`, `implement/implement.ts`, `ci.yml`; plus the `main` defaults in `shared/pr-feedback.ts` and `update-branch/update-branch.ts` (`implement/implement.ts`'s `git rev-list --count main..HEAD` is the only unconditional `main` in a runner rather than in YAML, and the only site here that *hard-errors* — `sh` is `execSync`, so a missing `main` ref aborts the run) | `implement` branches from `main` and opens its PR against it, unconditionally — that is the one that is wrong on a `master`/`develop` repo. `review`, `fix` and `update-branch` take the base from the PR event (#71, #100), so their `main` is a fallback that never fires on a real PR; change it anyway, or an absent `base.ref` degrades to the wrong branch |
| `npm ci`, `npm run verify`, `.nvmrc` | four workflows, and `implement` / `fix` / `update-branch` prompts | the whole toolchain assumption; a non-Node repo replaces all of it |
| `CONTEXT.md` and `CLAUDE.md` exist | every prompt reads them first | see §6 |
| Project domain | `implement/prompt.md` has an "IF THIS ISSUE ADDS A RULE" section; it and `review/prompt.md` cite this repo's domain model (role vs. `ManifestType`, the rule classes); `fix/prompt.md` and `update-branch/prompt.md` cite `src/rules/index.ts` | roughly half of `implement/prompt.md` is this repo's domain. The extraction prompts and the rest of `review/prompt.md` are already domain-neutral |

With the one exception called out above, nothing here will error — it will produce agents
confidently doing the wrong project's conventions. Budget real time for the prompts specifically.

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

---

## 8. If your repo is public

`agent-review` and `agent-fix` use `pull_request_target`, which runs with secrets and write
access. Copy these controls with the workflows — they are not decoration.

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
`github.event.sender`'s permission level in the job-level `if:`, or treat "never grant Triage on a
repo running this loop" as part of the setup. Pick one before you add a collaborator (#102).

The residual you cannot cheaply close: the agent runs unsandboxed with a model token readable in its
environment and unrestricted network egress. Every *injection source* is behind the write boundary,
so the exposure is "a compromised collaborator or a poisoned dependency could exfiltrate a scoped,
rotatable model token." Bounded and monitorable. If your threat model includes untrusted code or
long-lived secrets, you need a sandbox with egress control, which means self-hosted runners.

---

## 9. Two traps once it is running

**Stale runner scripts, silently.** `pull_request_target` takes the workflow YAML from the *base*
branch but checks out the **PR head** — so `.sandcastle/` scripts come from the PR branch. A PR
opened before a runner change keeps executing the old scripts with no error. After any
`.sandcastle/` change, refresh in-flight agent PRs (`agent:update-branch`) before trusting a run.

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
