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
| `agent-implement-pr` — act on PR feedback | ✅ | 🟡 | ours is `agent:fix`; see §4 |
| `agent-update-branch` — refresh a stale PR branch | ✅ | ✅ | ours merges mechanically and only calls the agent on conflicts |
| `agent-to-issues-prd` — PRD issue → sub-issues | ✅ | ❌ | PRD tier. Backlog is flat, uniform rule issues |
| `agent-implement-prd` — work sub-issues in sequence | ✅ | ❌ | PRD tier; includes run-chaining |
| `agent-promote-queued` — auto-promote when blockers close | ✅ | ❌ | needs dependency chains we don't have |
| `architecture-review` — scheduled survey that files its own issues | ✅ | 📋 | the autonomy tier; revisit once the rest are boring |
| `ci` — typecheck + test | ✅ | ✅ | |
| `corpus` — lint a pinned winget-pkgs snapshot | — | ➕ | see §7 |

**4 of CVM's 8 agent workflows.** The four omitted are the PRD/autonomy tier, which handoff
Decision 4 deferred on purpose: live with one workflow, then two, before building a label state
machine.

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
| Refuses a **sub-issue** / PRD-shaped issue | ✅ | ❌ | needs the PRD tier to be meaningful |
| Issue body passed in by the runner (agent never calls `gh`) | ✅ | ✅ | |
| **Agent-authored PR title + body** (`write-pr.ts`) | ✅ | ❌ | ours is a fixed template — enough for uniform rule PRs |
| **Auto-cascade: adds `agent:review` to the new PR** | ✅ | ✅ | needs `AGENT_PAT`; warns loudly if absent, since a `GITHUB_TOKEN` label add is a silent no-op |
| `failure_reason.txt` → issue comment on failure | ✅ | ✅ | |
| Opens the PR as a draft | ✅ | ✅ | |

---

## 3. `agent-review`

| Feature | CVM | Ours | Note |
|---|:--:|:--:|---|
| Triggered by `agent:review` on a PR | ✅ | ✅ | |
| Structured output (schema-validated JSON from the agent) | ✅ | ✅ | |
| Inline comments filtered to lines actually in the diff | ✅ | ✅ | GitHub rejects the whole review otherwise |
| Posts a review summary | ✅ | ✅ | |
| Posts inline comments | ✅ | ✅ | |
| Reads review summaries + unresolved threads + conversation | ✅ | ✅ | one GraphQL query; skips resolved threads |
| **Agent self-improves: commits fixes and pushes** | ✅ | ❌ | biggest single gap. Would need `contents: write`; `agent:fix` covers it with a human deciding |
| **Replies in review threads** | ✅ | ❌ | the *review* does not reply — but `agent:fix` does, and resolves what it settled (§4) |
| **Marks the PR ready for review** when done | ✅ | ❌ | trivial to add |
| Emits a verdict (`improved` / `clean`) | ✅ | ❌ | only meaningful with self-improvement |
| Approve / request-changes | ❌ | ❌ | both always post `COMMENT` |
| Installs an external `code-review` skill at run time | ✅ | ❌ | CVM pulls `mattpocock/skills`; ours inlines the checklist in the prompt |
| `contents: read` (structurally cannot mutate the branch) | ❌ | ➕ | CVM needs `write` because it self-commits |

---

## 4. `agent-implement-pr` (ours: `agent:fix`)

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
| **Posts new inline comments** | ✅ | ❌ | it answers existing threads; it does not open new ones |
| **Posts top-level comments** | ✅ | ❌ | |

Ours converses in-thread and closes what it settled; CVM replies but never resolves, so its
threads accumulate until a human clears them. What ours still cannot do is *raise* something new —
it answers what it was asked, and anything else goes in the commit message.

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
| Project skills (`.claude/skills/`) | ✅ | ❌ | CVM has 7; ours relies on `CLAUDE.md` + `CONTEXT.md` |
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
| `agent:update-branch` | ✅ | 📋 with that workflow |
| `Sandcastle` (triage: "ready for an AFK agent") | ✅ | ❌ no triage step yet |

**Why `agent:fix` rather than overloading `agent:implement`:** CVM disambiguates by event type,
so the same label means two things depending on where you put it. Here that would be a footgun —
`agent-implement.yml` triggers on `issues:` only, so labelling a PR `agent:implement` would
silently do nothing.

---

## 9. If we closed the gaps, in order

Done since first written: **conversational replies + resolution** (#49/#50 — and ours also
*resolves* threads, which CVM does not), **`agent-update-branch`** (#52, motivated by a real trap,
not theory — see `friction.md`), and **implement → review auto-cascade**.

What remains is ranked by value per unit of risk, not by size. Anything that widens an agent's
write access sits below everything that does not, regardless of how useful it looks.

1. **Composite action for setup** (📋) — pure cleanup, now that four workflows duplicate
   checkout → node → ci → claude.
2. **Mark PR ready after review** (❌, trivial).
3. **Auto-cascade fix → review** (📋) — deliberately still manual. implement → review is safe to
   automate because it fires *once per PR*; fix → review fires *every iteration*, and keeping a
   human on that leg is what makes "should we act on this feedback?" a decision rather than a
   reflex.
4. **GitHub App identity** (📋, "D") — retires the untracked `AGENT_PAT` expiry via per-run tokens,
   and may occupy the Reviewers sidebar the way Copilot's App does.
5. **Review self-improvement** (❌) — biggest capability gain, but flips review to
   `contents: write`. Deliberately declined: a reviewer that can commit on the strength of a
   confidently-wrong claim is worse than one that can only say it (see #46).
6. **PRD tier** (❌ ×3) — only pays off for multi-week features decomposed into sub-issues.
7. **`architecture-review`** (📋) — self-directed work generation. The autonomy tier.

## 10. Invariants

Rules that must hold as features are added, each recording a decision that is cheap now and
expensive to rediscover.

- **Never auto-cascade review → fix.** `agent:fix` → `agent:review` is safe *only* because review
  adds no trigger label, so every round still needs a human `agent:fix`. Automating the return leg
  closes a true cycle with no gate.
- **Review stays `contents: read`.** It is the one agent that cannot mutate the branch, and that
  is what bounds the damage a wrong review can do. Adding self-improvement (§9.5) forfeits this
  and also requires moving review into the `agent-mutate-pr-*` concurrency group.
- **Only `addressed` resolves a thread.** A `declined` thread keeps its reply and stays open, so a
  human can push back; auto-resolving a decline lets an agent bury a disagreement silently.
- **Every world-writable input is author-gated.** Issue and PR text reaches agents only from
  collaborators or our own bot. `agent:fix` pushes code, so an ungated input there steers commits.
- **Agents never hold the GitHub token.** Context is fetched before the agent starts and the token
  is scrubbed, so the no-push/no-label/no-comment boundary is technical rather than conventional.
