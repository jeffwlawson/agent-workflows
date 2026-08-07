# Parity with `mattpocock/course-video-manager`

A feature-by-feature comparison between this repo's agent loop and CVM's, the repo it was
modelled on. The point is to make every gap **a visible decision** rather than an accident.

**Baseline:** CVM clone dated **2026-07-21** (`mattpocock/course-video-manager`), cross-checked
against `mattpocock/sandcastle` @ `0.12.0`. CVM may have moved since; re-pull before trusting a
row marked ❌.

| | Meaning |
|---|---|
| ✅ | Present |
| 🟡 | Present in reduced form ("lite") |
| ❌ | Absent — **deliberate**, see the note |
| 📋 | Absent — **would take**, a plausible future addition |
| ➕ | We have it, CVM does not |

---

## 1. Workflows

| Workflow | CVM | Ours | Note |
|---|:--:|:--:|---|
| `agent-implement` — issue → branch → PR | ✅ | ✅ | |
| `agent-review` — review a PR | ✅ | 🟡 | review-only; see §3 |
| `agent-implement-pr` — act on PR feedback | ✅ | 🟡 | ours is `agent-fix`, label `agent:fix`; see §4 |
| `agent-update-branch` — refresh a stale PR branch | ✅ | ✅ | ours merges mechanically and only calls the agent on conflicts |
| `agent-explore` — read-only triage pass on an issue | — | ❌ | **upstream only**, not in CVM. Superseded by local planning skills *in this repo's usage* — see below, and the scope note |
| `agent-to-issues-prd` — PRD issue → sub-issues | ✅ | ❌ | PRD tier. Superseded locally by `wayfinder` |
| `agent-implement-prd` — work sub-issues in sequence | ✅ | ❌ | PRD tier; run-chaining. Nothing to sequence — the backlog is flat and independent |
| `agent-promote-queued` — auto-promote when blockers close | ✅ | ❌ | needs dependency chains we don't have |
| `architecture-review` — scheduled survey that files its own issues | ✅ | 📋 | the autonomy tier; revisit once the rest are boring. The only *scheduled agent* in either upstream repo |
| `ci` — typecheck + test | ✅ | ✅ | |
| `corpus` — lint a pinned winget-pkgs snapshot | — | ➕ | see §7 |
| `token-expiry` — warn before `AGENT_PAT` lapses | — | ➕ | weekly; #70 |

**4 of CVM's 8 agent workflows** — but measured against `mattpocock/sandcastle`, which ships five,
it is **4 of 5**, and the one missing is `agent-explore`. CVM and upstream diverge here on purpose,
and the divergence is the useful part: upstream has `explore` and no PRD tier, CVM has the PRD tier
and no `explore`. They are two answers to the same question — *how does a well-specified issue come
to exist?* Upstream assesses a spec that already exists and that you may not have written; CVM
generates the spec itself, top-down.

**Both are superseded by local skills — as standing practice, not as a current accident.** Issues
here are authored by the owner and planned with `wayfinder` (charts a large effort into decision
tickets on the tracker — the same job as `to-issues-prd`, better specified) and `grilling` /
`grill-with-docs` (relentless interview on one plan, and it looks facts up in the environment
rather than asking). That is the intended way in to every applicable issue going forward, which is
what makes these ❌ rather than 📋: the need does not return as the backlog grows.

**Scope of that decision.** It is about *how issues reach this repo*, not about the workflow set
being complete. If these workflows are ever packaged for another repo (see `docs/ADOPTING.md`), the
calculus is per-adopter: a repo that takes community issues has no owner-authored guarantee and no
local planning skill in the loop, and `agent-explore` is the upstream answer to exactly that. Do not
read these rows as "the template does not need explore."

The residual, and the qualifier that matters: `wayfinder` applies to a large effort, so **a small
issue written quickly and confidently** falls beneath the threshold at which anyone invokes it. All
six of the pilot's spec errors came from exactly there. `agent-explore` only half-addresses it — its
prompt verifies an issue's claims *against the code*, and three of the six were wrong about
**winget**, not about this repo. So the gap is real but a fifth workflow is not the fix; `explore`
is advisory too, and nothing would force reading it before labelling `agent:implement`. Grounding
claims in primary sources at authoring time is what actually closed it before (#36/#37).

> **Keeping this file honest.** It drifted once already — §4 still marked thread replies ❌ after
> #50 shipped them, while §9 listed the same feature as done. A parity doc that contradicts itself
> is worse than none, because it is consulted precisely when nobody remembers the answer. Update
> the relevant row in the same PR that changes behaviour, not afterwards.

---

## 2. `agent-implement`

| Feature | CVM | Ours | Note |
|---|:--:|:--:|---|
| Triggered by label on an issue | ✅ | ✅ | |
| Job-level `if` (skip before provisioning a runner) | ✅ | ✅ | |
| Consumes the trigger label; `in-progress` / `blocked` transitions | ✅ | ✅ | |
| Deterministic branch name `agent/issue-<n>-<slug>` | ✅ | ✅ | |
| Refuses when a PR already targets the issue | ✅ | ✅ | |
| Refuses a **closed** issue | ✅ | ✅ | added #102. Must precede the PR check, which lists *open* PRs only — so a merged-and-closed issue otherwise looks untouched |
| Refuses a **sub-issue** / PRD-shaped issue | ✅ | ❌ | needs the PRD tier to be meaningful |
| Issue body passed in by the runner (agent never calls `gh`) | ✅ | ✅ | |
| **Agent-authored PR title + body** (`write-pr.ts`) | ✅ | ❌ | ours is a fixed heredoc in the workflow. Re-rated 2026-08-01: this is the only channel an agent has for reporting a **non-code** finding, and #63 hit that limit — see §9.2 |
| **Auto-cascade: adds `agent:review` to the new PR** | ✅ | ✅ | needs `AGENT_PAT`; warns loudly if absent, since a `GITHUB_TOKEN` label add is a silent no-op |
| `failure_reason.txt` → issue comment on failure | ✅ | ✅ | |
| Opens the PR as a draft | ✅ | ✅ | |

---

## 3. `agent-review`

| Feature | CVM | Ours | Note |
|---|:--:|:--:|---|
| Triggered by `agent:review` on a PR | ✅ | ✅ | |
| Refuses when the PR is closed/merged | ✅ | ✅ | added #102. Without it, labelling a merged PR ran a full agent pass and then failed at `gh pr ready`, which cannot convert a merged PR — under a warning that blames a missing `AGENT_PAT` |
| Structured output (schema-validated JSON from the agent) | ✅ | ✅ | |
| Inline comments filtered to lines actually in the diff | ✅ | ✅ | GitHub rejects the whole review otherwise |
| Posts a review summary | ✅ | ✅ | |
| Posts inline comments | ✅ | ✅ | |
| Reads review summaries + unresolved threads + conversation | ✅ | ✅ | one GraphQL query; skips resolved threads |
| **Agent self-improves: commits fixes and pushes** | ✅ | ❌ | biggest single gap. Would need `contents: write`; `agent:fix` covers it with a human deciding |
| **Replies in review threads** | ✅ | ❌ | the *review* does not reply — but `agent:fix` does, and resolves what it settled (§4) |
| **Marks the PR ready for review** when done | ✅ | ✅ | `success()` only, so a failed review leaves the PR in draft — see the invariant in §10. **Requires `AGENT_PAT`**: `GITHUB_TOKEN` cannot convert a draft at all |
| Emits a verdict (`improved` / `clean`) | ✅ | ❌ | only meaningful with self-improvement |
| Approve / request-changes | ❌ | ❌ | both always post `COMMENT` |
| Installs an external `code-review` skill at run time | ✅ | ❌ | CVM pulls `mattpocock/skills`; ours inlines the checklist in the prompt |
| `contents: read` (structurally cannot mutate the branch) | ❌ | ➕ | CVM needs `write` because it self-commits |

---

## 4. `agent-implement-pr` (ours: `agent-fix`, label `agent:fix`)

| Feature | CVM | Ours | Note |
|---|:--:|:--:|---|
| Triggered by a label on a PR | ✅ | ✅ | CVM overloads `agent:implement`; ours uses a distinct `agent:fix` |
| Reads review summaries | ✅ | ✅ | |
| Reads inline review-thread comments **and replies** | ✅ | ✅ | |
| Reads top-level PR conversation comments | ✅ | ✅ | |
| Skips **resolved** threads | ✅ | ✅ | |
| Refuses when there is nothing to act on | ✅ | ✅ | ours also refuses when nothing is *trusted* |
| Refuses when the PR is closed/merged | ✅ | ✅ | |
| Agent may **decline** feedback with a reason | ✅ | ✅ | explicit in both prompts |
| Pushes with `--force-with-lease` pinned to the run's head SHA | ✅ | ✅ | |
| **Posts thread replies back** | ✅ | ✅ | one reply per thread, `addressed` or `declined`, with the reason |
| **Resolves the threads it addressed** | ❌ | ➕ | declines stay **open** so a human can push back |
| **Posts new inline comments** | ✅ | ❌ | **decision, not omission** — see below |
| **Posts top-level comments** | ✅ | ✅ | ours states in the prompt what the channel is *for*; CVM has the field and no guidance anywhere |

**On the name.** CVM calls this `agent-implement-pr` and triggers it with `agent:implement`,
disambiguated only by event type. Ours is `agent-fix.yml`, triggered by `agent:fix`. Two reasons:
labelling a *PR* `agent:implement` here would silently do nothing, since `agent-implement.yml`
listens on `issues:` only; and every other workflow in this repo holds **file name == display name
== trigger label**, so `agent-implement-pr` + `agent:fix` was the one pair you had to remember. The
`-pr` suffix is redundant besides — it triggers on `pull_request_target` and refuses on a closed or
merged PR, so it cannot run on anything else.

Ours converses in-thread and closes what it settled; CVM replies but never resolves, so its
threads accumulate until a human clears them. Since #78 it can also *raise* something that belongs
to no thread, as a top-level comment on the PR conversation — the channel that was missing when
#63's documented bug ended up buried in a test-file comment, and when #77 offered an option
(`open a follow-up and reference it`) the agent had no way to take.

**Why we post top-level but not inline comments.** Inline comments need the diff-line allow-list,
and that machinery produced two silent-failure bugs in three days: #65 (a phantom line past the end
of the last file) and #71 (the wrong diff base on a stacked PR). Both fail identically — the review
posts nothing and looks clean. A second producer doubles the exposure to a failure class whose
whole signature is invisibility, for marginal value: a top-level comment can name
`shared/pr-feedback.ts:206` in prose. Secondarily, `agent:fix` is the *author* of the diff by then,
and an author annotating their own lines inverts the review-raises / fix-answers split.

**And why the channel has a stated purpose.** CVM has `topLevelComments` and — verified by grepping
`implement-pr/prompt.md` — no guidance for when to use it. A channel with no stated purpose either
goes unused or gets used arbitrarily, and "arbitrarily" on a PR conversation is noise. Ours says
what it is for, what it is not (a summary of what changed), and that silence is the default.

---

## 5. Shared machinery

| Feature | CVM | Ours | Note |
|---|:--:|:--:|---|
| `run-with-extraction` (resume session → emit structured output) | ✅ | ✅ | |
| Extraction retry on schema-validation failure | ✅ | ✅ | ours via `Output`'s `maxRetries: 2` |
| `run-with-retry` + `retry-feedback` (retry a whole run with the error fed back) | ✅ | ❌ | a different pattern from extraction retry; ours has only the latter |
| Shared `common.ts` helpers (`required` / `fail` / `sh` / `gh`) | ✅ | ✅ | |
| `failure_reason.txt` convention | ✅ | ✅ | |
| Diff-line parser for inline-comment validation | ✅ | ✅ | |
| Shared **feedback fetch** used by more than one workflow | ❌ | ➕ | CVM duplicates fetch logic per workflow |
| Composite action for the repeated setup steps | ❌ | 📋 | both currently duplicate checkout→node→ci→install |
| `Dockerfile` + local-loop `main.ts` | ✅ | ❌ | N/A by design: `noSandbox()` on the runner (Decision 2) |
| Project skills (`.claude/skills/`) | ✅ | ❌ | CVM has 7, checked into the repo so its CI agents can load them. Ours relies on `CLAUDE.md` + `CONTEXT.md`, plus **user-level** skills (`wayfinder`, `grilling`) that are available to a human driving Claude Code locally but *not* to a CI agent. That split is deliberate: planning happens with a human in the loop, execution happens in CI |
| `docs/agents/` platform spec + backlog + label docs | ✅ | 🟡 | ours: `CONTEXT.md`, `CLAUDE.md`, this file, `friction.md` |
| `CODING_STANDARDS.md` referenced from prompts | ✅ | 🟡 | folded into `CLAUDE.md` |

---

## 6. Security controls

Where we deliberately diverge **upward**. CVM's posture is "ephemeral runner + label requires
write access + trust collaborators"; ours adds structural gates because this repo is public.

| Control | CVM | Ours | Note |
|---|:--:|:--:|---|
| Fork guard on `pull_request_target` (`head.repo.full_name == github.repository`) | ❌ | ➕ | without it, a fork PR runs with secrets in scope |
| Author-association gate on issue text | ❌ | ➕ | anyone can *open* an issue on a public repo |
| Author-association gate on PR comments / reviews / threads | ❌ | ➕ | all world-writable; `agent:fix` pushes code |
| Explicit trust for our own bot identity | ❌ | ➕ | `github-actions[bot]` **and** `github-actions` — REST and GraphQL spell it differently |
| GitHub token scrubbed from the agent's environment | ❌ | ➕ | `noSandbox` merges `process.env`; agent has no legitimate `gh` use |
| `contents: read` on the review workflow | ❌ | ➕ | |
| Agent never handles the trigger label / PR creation | ✅ | ✅ | workflow owns all state transitions |
| Model token present in an unsandboxed agent | ⚠️ | ⚠️ | unavoidable under `noSandbox`; see the residual entry in `friction.md` |
| Network egress restriction | ❌ | ❌ | not available on GitHub-hosted runners |

---

## 7. This repo only

| Feature | Note |
|---|---|
| `corpus.yml` + `scripts/lint-corpus.ts` | Lints a pinned `microsoft/winget-pkgs` snapshot. Every manifest there is known-good, so any **error** is by definition a false positive — a free pre-labelled regression suite. Caught 417 false positives, then a bug in its own gate |
| Severity-aware corpus gate | Errors fail the build; warnings are reported but do not. Without this, warning-severity rules are structurally impossible |
| `docs/friction.md` | The actual deliverable of the pilot — every time a human reached into the loop |
| `CONTEXT.md` domain model | CVM has one too; ours is load-bearing for rule-class reasoning |

---

## 8. Labels

| Label | CVM | Ours |
|---|:--:|:--:|
| `agent:implement` | ✅ issues **and** PRs | ✅ issues only |
| `agent:fix` | ❌ | ➕ PRs — CVM overloads `agent:implement` instead |
| `agent:review` | ✅ | ✅ |
| `agent:in-progress` | ✅ | ✅ |
| `agent:blocked` | ✅ | ✅ |
| `agent:queued` | ✅ | ❌ needs `promote-queued` |
| `agent:to-issues` | ✅ | ❌ PRD tier |
| `agent:update-branch` | ✅ | ✅ |
| `Sandcastle` (triage: "ready for an AFK agent") | ✅ | ❌ no triage step yet |

**Why `agent:fix` rather than overloading `agent:implement`:** CVM disambiguates by event type,
so the same label means two things depending on where you put it. Here that would be a footgun —
`agent-implement.yml` triggers on `issues:` only, so labelling a PR `agent:implement` would
silently do nothing.

---

## 9. If we closed the gaps, in order

Done since first written: **conversational replies + resolution** (#49/#50 — and ours also
*resolves* threads, which CVM does not), **`agent-update-branch`** (#52, motivated by a real trap,
not theory — see `friction.md`), **implement → review auto-cascade**, and **review marks the
PR ready** (it had become a manual step on every agent PR).

What remains is ranked by value per unit of risk, not by size. Anything that widens an agent's
write access sits below everything that does not, regardless of how useful it looks.

1. **Composite action for setup** (📋) — pure cleanup, now that four workflows duplicate
   checkout → node → ci → claude.
2. **Agent-authored PR body** (❌, `write-pr`) — promoted from "cosmetic" on 2026-08-01. The body is
   a hardcoded heredoc in `agent-implement.yml`, so it is the one thing an agent **cannot** write.
   Issue #63 asked the agent to report a bug it was told not to fix; it had nowhere to put it but a
   comment inside a test file. Top-level comments (#78) now give `agent:fix` somewhere to put such
   a finding, so this is no longer the *only* non-code channel — but `agent:implement` still has
   none, and the body is still the first thing a human reads. Widens no write access: the workflow
   already authors the PR.
3. **Auto-cascade fix → review** (📋) — deliberately still manual. implement → review is safe to
   automate because it fires *once per PR*; fix → review fires *every iteration*, and keeping a
   human on that leg is what makes "should we act on this feedback?" a decision rather than a
   reflex.
4. **GitHub App identity** (📋, "D") — retires the untracked `AGENT_PAT` expiry via per-run tokens,
   and may occupy the Reviewers sidebar the way Copilot's App does.
5. **Review self-improvement** (❌) — biggest capability gain, but flips review to
   `contents: write`. Deliberately declined: a reviewer that can commit on the strength of a
   confidently-wrong claim is worse than one that can only say it (see #46).
6. **PRD tier** (❌ ×3) — only pays off for multi-week features decomposed into sub-issues, and the
   planning half is already covered locally by `wayfinder` (§1). Off the list rather than low on it.
7. **`architecture-review`** (📋) — self-directed work generation. The autonomy tier, and the only
   *scheduled agent* in either upstream repo. Note it depends on the PRD tier (it publishes via
   `/to-prd-project`) and on project skills, so it is three pieces of work, not one.

## 10. Invariants

Rules that must hold as features are added, each recording a decision that is cheap now and
expensive to rediscover.

- **Never auto-cascade review → fix.** `agent:fix` → `agent:review` is safe *only* because review
  adds no trigger label, so every round still needs a human `agent:fix`. Automating the return leg
  closes a true cycle with no gate.
- **Review stays `contents: read`.** It is the one agent that cannot mutate the branch, and that
  is what bounds the damage a wrong review can do. Adding self-improvement (§9.5) forfeits this.

  This used to read "…and also requires moving review into the `agent-mutate-pr-*` group", which
  had the concurrency argument backwards and cost a live race to notice (#102). Review's exclusion
  from that group was never a consequence of it being `contents: read`: the hazard is not review
  *writing*, it is review *reading during another job's write*, and `contents: read` does nothing
  about that. See the next invariant.
- **One concurrency group per PR, one per issue.** Every workflow that touches PR *n* — review,
  fix, update-branch — sits in `agent-pr-${{ github.event.pull_request.number }}` with
  `cancel-in-progress: false`; `agent-implement` sits in a per-issue group. Not one group per
  *mutation*: until #102, review had its own group on the theory that a `contents: read` job is
  harmless to run alongside a push, and so `agent:fix` could push while `agent:review` was diffing
  the same branch. The review that comes out of that describes a tree state that never existed —
  plausible, confident, and about nothing. There is no case where concurrent review + mutate on
  one PR is wanted.

  **The group displaces one race rather than closing it, and review has to refuse the remainder.**
  A first draft of this said "the cost of serialising is a review that waits", which is the one cost
  it does not have. Review pins everything to the head SHA in its `labeled` payload — the checkout,
  and `commit_id` on the posted review — and that payload is snapshotted at *label* time while the
  group decides *start* time. So: a fix is running, a human labels `agent:review`, the run snapshots
  A and waits, the fix pushes B and frees the group, and review then reads A cleanly and reviews it.
  Reading-during-a-write became reading-after-one: no torn tree, but every inline comment lands on
  an ancestor commit and GitHub renders it outdated. The mutates already catch their version of this
  at push time — `--force-with-lease` pinned to the same payload SHA — so review, which publishes
  rather than fails, is the only one that needed a check, and it makes it in its own preflight
  (#105). It refuses rather than re-targeting the live tip: a review is a statement about the commit
  a human pointed at, re-pointing it would drag `commit_id` and the CI wait to a SHA nobody
  labelled, and re-adding the label is one action.

  **What `cancel-in-progress: false` actually buys**, since it is not a queue and the difference
  bites: GitHub holds **at most two runs per group — one running, one waiting** — and the waiting
  slot has depth 1 and always holds the *newest* arrival. A third arrival cancels the current
  waiter. So the flag protects the run already going, **not** the work behind it, and repeatedly
  re-labelling cannot stack runs (found by re-labelling #100 three times). There is no
  "reject the newcomer, keep what is running" mode — only cancel-active or cancel-waiter — and a
  job-level `if:` cannot supply one, since it reads context data only and is evaluated after the
  group frees.

  **The collapse extends that rule across workflows, and the loss is silent.** The waiter slot is
  per *group*, not per workflow, so a queued review is now evictable by a mutate label — which it
  was not in `agent-review-pr-*`, where nothing else could reach it. Concretely: `agent:fix` is
  running on PR *n*, a human adds `agent:review` (takes the waiter slot), then adds
  `agent:update-branch` — a third arrival, so by the rule above the queued review is cancelled
  before its first step. Having run nothing it never reached `Transition labels`, so `agent:review`
  is still on the PR with no comment and no `agent:blocked`: it reads as pending and will never
  run, and re-adding a label already present fires no `labeled` event, so recovery is
  remove-then-re-add. Accepted rather than fixed, because a cancelled run executes no step —
  nothing inside these workflows can observe or report it — and the alternative is the separate
  group whose race this invariant exists to close.

  **Residual, recorded against #92 (PRD tier).** Once `agent-implement-prd` lands it pushes to a
  PR's branch under `agent-implement-prd-issue-<parent>` while review and fix use
  `agent-pr-<prNumber>` — different groups, so the same read-during-write race exists one level up.
  Group keys cannot close it: an `issues` event carries no PR number, so the two cannot compute a
  shared key. The happy path does not overlap (the chain adds `agent:review` itself only after the
  last sub-issue closes), but a human labelling `agent:review` mid-chain would hit it. If it ever
  bites, the fix is a preflight refusal in review when the linked issue has an active PRD chain —
  not a concurrency change.
- **Every workflow refuses a terminal target before it does any work.** A closed or merged PR, a
  closed issue: the guard is the first step, it is itself ungated, and it runs before checkout,
  before `npm ci`, and before the label transitions — so a refused run never claims
  `agent:in-progress` and never has a working tree to be wrong about. The failure it prevents is
  not a crash but a *plausible* result: review had no guard until #102 and would review merged work
  in full, then fail at `gh pr ready` under a warning blaming a missing `AGENT_PAT`, which is a
  wrong diagnosis of a real problem. Each refusal says which state it refused; two refusals that
  read alike are two states a human cannot tell apart from the comment. `tests/workflows.test.ts`
  holds all four workflows to all three properties — guard first, guard ungated, no
  `agent:in-progress` on a refused run.

  One difference is not yet reconciled: review adds `agent:blocked` when it refuses (#102 asked for
  it), while fix, update-branch and implement leave only a comment. That is a difference in what a
  refused label leaves behind, not in what gets refused. Unify it in either direction when someone
  next touches these — the argument for the label is that a comment scrolls away; against, that a
  merged PR keeps a stale `agent:blocked` nobody will ever clear.

  Re-examined in #105 for the moved-head refusal specifically, where the PR being refused is
  healthy and green, and kept, on two grounds. The label is defined as "a run failed **or was
  refused**; needs human attention" (docs/ADOPTING.md §3), and attention is precisely what is owed:
  `refuse()` also consumes `agent:review`, so without the label a PR that silently never got
  reviewed carries no signal at all. And this refusal is self-clearing where the closed/merged one
  is not — the remedy the comment gives is re-adding `agent:review`, and `Transition labels`
  removes `agent:blocked` on the way in. So the objection above (a stale label nobody clears)
  applies to the terminal-state refusal only.
- **Only `addressed` resolves a thread.** A `declined` thread keeps its reply and stays open, so a
  human can push back; auto-resolving a decline lets an agent bury a disagreement silently.
- **Every world-writable input is author-gated.** Issue and PR text reaches agents only from
  collaborators or our own bot. `agent:fix` pushes code, so an ungated input there steers commits.
- **Agents never hold the GitHub token.** Context is fetched before the agent starts and the token
  is scrubbed, so the no-push/no-label/no-comment boundary is technical rather than conventional.
  Top-level comments (§4) do not weaken this: the agent *reports* them in its structured output and
  the workflow posts them, which is the same shape as thread replies.
- **An agent that raises work never files it.** `agent:fix` may say a follow-up is needed; it
  cannot create the issue. Filing is a separate, human-labelled step. `architecture-review`
  upstream has the same shape — it files a PRD and stops, and a human labels it `agent:implement`.
  Collapsing the two closes a cycle with no gate, the same failure "never auto-cascade review →
  fix" above already guards against. Concretely: no workflow gets `issues: write` unless filing is
  its job — `tests/workflows.test.ts` holds every workflow to that, exempting only
  `agent-implement.yml` and `token-expiry.yml` by name, so a new one is covered on arrival
  (`agent-review.yml` had been granted it unused, #101) — and harvesting those comments into issues
  (#79) is a separate workflow behind its own label.
- **No agent reads its own output back as input.** The invariant above closes by a different door
  if it does. `gh pr comment` posts as `github-actions[bot]`, which `isTrustedAuthor` trusts on
  purpose — so without a filter the agent's own "worth a follow-up issue" note returns next run as
  `# CONVERSATION`, under a prompt heading that says to address or decline it. The agent raises the
  follow-up and the agent, one label later, does it, with no human in between; the quieter variant
  is worse, where it simply addresses the note and expands scope in exactly the way the note existed
  to avoid. So every top-level comment carries `<!-- agent-fix:top-level -->` and
  `pr-feedback.ts` drops marked comments from the `conversation` surface. Narrowing that surface
  costs nothing: the review → fix handoff runs through `reviews`/`reviewThreads`, not `comments`.
  It also keeps `hasFeedback` honest — a PR with every thread resolved and no human input still
  refuses, rather than finding "feedback" the agent wrote itself.
- **A channel the prompt bounds is also bounded mechanically.** Prompt guidance sets intent; it is
  not a control. `filterOutcomes` drops invented thread ids because a model invents them, and
  `filterTopLevelComments` caps a run at two comments and drops verbatim repeats of ones already
  posted, because "silence is the default" is otherwise aspirational — three `agent:fix` rounds
  would leave three copies of the same note, and three issues once #79 harvests them.
- **An optional channel never has veto power over the mandatory one.** A malformed top-level
  comment is dropped with a warning, not thrown on: throwing would burn both extraction retries and
  take every thread reply and resolve down with it. A malformed *thread outcome* still throws — that
  is the payload the run exists to produce.
- **Draft means the pipeline has not finished, not that the agent is still typing.** Review marks
  the PR ready, and only on `success()`. So a PR left in draft after a run is a PR whose automated
  pipeline did not complete — a second signal that agrees with `agent:blocked` instead of
  presenting an unreviewed PR as finished. Moving the mark-ready step earlier (into implement)
  forfeits that, and fires "your turn" during a window when the review has not posted and there is
  nothing yet to decide.

  **This invariant depends on `AGENT_PAT`.** `GITHUB_TOKEN` cannot convert a draft PR at all —
  `Resource not accessible by integration (markPullRequestReadyForReview)` — so without the PAT
  every reviewed PR stays in draft and "still draft" stops meaning anything. It was silently false
  for the first three PRs after it was written, because the step swallowed the error with
  `|| true`. An invariant that depends on a secret being set is only as true as the setup, which is
  why the step now warns loudly rather than failing quietly.
