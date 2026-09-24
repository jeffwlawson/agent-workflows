# Parity with `mattpocock/course-video-manager`

A feature-by-feature comparison between this repo's agent loop and CVM's, the repo it was
modelled on. The point is to make every gap **a visible decision** rather than an accident.

**Baseline:** CVM clone dated **2026-07-21** (`mattpocock/course-video-manager`), cross-checked
against `mattpocock/sandcastle` @ `0.12.0` (last pushed 2026-06-29). CVM may have moved since;
re-pull before trusting a row marked ❌. sandcastle is compared twice over: as the workflow set
§1 measures against, and — for its `init` templates, which are a different thing entirely — as the
third execution model in §2b.

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
| `agent-to-issues-prd` — PRD issue → sub-issues | ✅ | ❌ | **the planning half of the PRD tier**, superseded locally by `/wayfinder` → `/to-spec` → `/to-tickets`. The **ordering contract** it owes the chain below — sub-issues *created* blockers-first (§2a) — is no longer owed but written down: `docs/agents/ticket-shape.md` (#93) is where a batch's shape and publish order are settled |
| `agent-implement-prd` — work sub-issues in sequence | ✅ | ✅ | **the execution half, shipped** (#92). Shares the `agent:implement` label with `agent-implement`; the two partition by issue shape. See §2a |
| `agent-promote-queued` — auto-promote when blockers close | ✅ | ❌ | **deferred: nothing to sequence between PRDs yet.** #91, detached from #87 so the chain would not build a slice nobody wanted. Not blocked on missing edges — `/wayfinder` records blockers as native dependencies, and on a `/to-tickets` batch `docs/agents/ticket-shape.md` requires them (upstream's skill writes a prose line, so they are added and verified by hand) — the point is that this tier sequences **top-level** issues, and ordering *within* a PRD is already carried by creation order (§2a). Its label exists and is human-written (§8) |
| `architecture-review` — scheduled survey that files its own issues | ✅ | 📋 | the autonomy tier; revisit once the rest are boring. The only *scheduled agent* in either upstream repo |
| `agent-follow-ups` — file a merged PR's recorded findings | — | ➕ | #44. The review agent records what it cannot fix in the PR in front of it; this files each finding as a `needs-triage` stub once that PR merges. The only workflow here that turns an agent's output into **new issues** — `token-expiry` files a fixed one about the loop itself, and the `implement` pair only label and close — and the only one in the loop that runs **no model**, which is what makes holding `issues: write` while reading issue bodies safe. Optional per adopter: the caller file is the off switch. See §10 |
| `ci` — typecheck + test | ✅ | ✅ | |
| `corpus` — lint a pinned winget-pkgs snapshot | — | ➕ | see §7 |
| `token-expiry` — warn before `AGENT_PAT` lapses | — | ➕ | weekly; #70 |

**5 of CVM's 8 agent workflows** since #92 — but measured against `mattpocock/sandcastle`, which
ships five and has no PRD tier at all, it is still **4 of 5**: `agent-implement-prd` is not one of
the five, and the one missing there is `agent-explore`. CVM and upstream diverge here on purpose,
and the divergence is the useful part: upstream has `explore` and no PRD tier, CVM has the PRD tier
and no `explore`. They are two answers to the same question — *how does a well-specified issue come
to exist?* Upstream assesses a spec that already exists and that you may not have written; CVM
generates the spec itself, top-down.

**Both are superseded by local skills — as standing practice, not as a current accident.** Issues
here are authored by the owner and planned with `/wayfinder` → `/to-spec` → `/to-tickets` (charts a
large effort into decision tickets, then a spec, then sliced tickets on the tracker — the same job
as `to-issues-prd`, better specified) and `grilling` / `grill-with-docs` (relentless interview on
one plan, and it looks facts up in the environment rather than asking). That is the intended way in
to every applicable issue going forward, which is what makes these ❌ rather than 📋: the need does
not return as the backlog grows.

**The seam that pipeline inherits.** `to-issues-prd` was not only a decomposer; it also *published*
the result in the shape its own chain reads back. Handing decomposition to a skill hands that
obligation over with it, and a skill run by a human on a laptop is not held to it by anything. So
the contract is written down instead — `docs/agents/ticket-shape.md` (#93): a parent PRD with
native sub-issues, published blockers-first — and §10 carries the invariants. The failure it guards
is silent in both directions: a batch of flat peers is a PRD the chain cannot walk at all, and a
batch in the wrong order is one it walks confidently through the wrong slice first.

There is a third answer upstream, which discharges the same obligation by not having it: sandcastle's
planner templates infer the ordering from issue text every round and read no tracker relation at all.
§2b records it, and records why it stays recorded rather than adopted.

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
| Refuses a **sub-issue** / PRD-shaped issue | ✅ | ✅ | added #90, narrowed in #92. One GraphQL query settles the shape; a sub-issue is refused outright — its parent drives it — while a PRD-shaped parent is now **deferred** to `agent-implement-prd` rather than refused. §2a says why a deferral has to touch nothing at all |
| Refuses a `wayfinder:*` **planning artifact** | ❌ | ➕ | maps and decision tickets describe work rather than being it. CVM has no equivalent because its PRDs *are* issues on the tracker; ours are planned in a skill (§1) and land labelled |
| Issue body passed in by the runner (agent never calls `gh`) | ✅ | ✅ | |
| **Agent-authored PR title + body** (`write-pr.ts`) | ✅ | ❌ | ours is a fixed heredoc in the workflow. Re-rated 2026-08-01: this is the only channel an agent has for reporting a **non-code** finding, and #63 hit that limit — see §9.2 |
| **Auto-cascade: adds `agent:review` to the new PR** | ✅ | ✅ | needs `AGENT_PAT`; warns loudly if absent, since a `GITHUB_TOKEN` label add is a silent no-op |
| `failure_reason.txt` → issue comment on failure | ✅ | ✅ | |
| Opens the PR as a draft | ✅ | ✅ | |

---

## 2a. `agent-implement-prd`

Lettered rather than numbered so the cross-references in the rest of this file keep working. #92.

Labelling a **parent** issue `agent:implement` implements its sub-issues one at a time — one per
run — accumulating onto a single branch and a single PR, and requesting review once, at the end.

| Feature | CVM | Ours | Note |
|---|:--:|:--:|---|
| Triggered by `agent:implement` on a parent issue | ✅ | ✅ | |
| Refuses a **nested** PRD (a PRD that is itself a sub-issue) | ✅ | ✅ | two owners of one ordering, neither able to see the other's chain |
| Refuses a PRD whose sub-issues have **all closed** | ✅ | ✅ | and *without* `agent:blocked` — a finished PRD is a success state, and the label would be the stale one §10 warns about |
| Refuses a `wayfinder:*` planning artifact | ❌ | ➕ | the same refusal `agent-implement` carries, for the map that has sub-issues and so reaches this workflow instead |
| Refuses a parent with open `blocked_by` edges | ❌ | ➕ | #14, and the one place this workflow reads an edge — see the ordering note below. Being a coordinator exempts nothing, and the cost of running anyway is larger than the flat case's one wasted run: a single label lands every slice on one branch, as one PR, built on work that does not exist yet. **Last** of the refusals, after the finished one: a finished PRD can still carry an open edge, and read first it would collect the `agent:blocked` the row above withholds, on an issue no later run can clear it from |
| Targets the **first still-open** sub-issue, in sub-issues API order | ✅ | ✅ | see the ordering note below |
| One branch `agent/prd-<n>-<slug>`, reused across the chain | ✅ | ✅ | found on the remote by `agent/prd-<n>-*`, never by the whole recomputed name — the slug comes from the parent's *title* and a title is editable, so a retitle mid-chain would otherwise fork slice N off `main` and open a second PR. Two matches is ambiguous and fails the run rather than guessing |
| Plain `git push`, never force | ✅ | ✅ | the branch carries every earlier slice; a force push is a chain eating its own history |
| One PR, opened once and reused | ✅ | ✅ | draft until the last slice |
| Closes each finished sub-issue with a comment naming the commit SHA | ✅ | ✅ | the only record tying a closed sub-issue to its code while the PR is still growing |
| Chains by re-labelling the **parent** with `AGENT_PAT` | ✅ | ✅ | warns loudly when the PAT is absent — a `GITHUB_TOKEN` label add is a silent no-op, and here it stops the chain dead while looking like work in progress |
| Adds `agent:review` to the PR only when no sub-issues remain | ✅ | ✅ | the trade below |
| Both label adds run under `set -e` | — | ➕ | each step ends with the warn-if-no-PAT `if`, which returns 0 when the PAT *is* set; without `-e` a failed add exits the step green, `failure()` never fires, and the chain halts unlabelled or the PR sits finished in draft |
| `failure_reason.txt` → issue comment, `agent:blocked`, `agent:in-progress` held | ✅ | ✅ | on the **parent**; the failure comment names which sub-issue stopped the chain, and — when there is one — the PR to hand `agent:review` to if the chain died *after* closing that sub-issue |
| Agent-authored PR title + body | ✅ | ❌ | same gap as §2, same fixed heredoc |

**Ordering comes from creation order, not from the edges.** The chain walks sub-issues API order
and never reads `blocked-by`. That is safe only because sub-issues are *created* in dependency
order, blockers first — the topological sort happens once, at publish time. Since #93 that is a
written contract rather than an assumption about whoever publishes: `docs/agents/ticket-shape.md`
holds the publish order, the verification steps, and the repair. Do not add edge-reading here; fix
the publish order instead. The edges exist as the record of why the order is what it is (§10).

**The preflight reads one edge, and it is not the walk.** Since #14 it asks whether the **parent**
is `blocked_by` anything still open, and refuses the whole run if so. That is not the edge-reading
the rule above forbids: it is one question, asked once, about whether the chain starts at all —
about a deliverable whose blocker sits outside the PRD entirely — and it decides nothing about
*order*. Sequencing within the walk is still creation order, still edge-free. The distinction is
also why the refusal belongs on the parent and nowhere else: slices are pieces of one feature
landing on one branch, so a slice that needs outside work blocks the whole PRD rather than itself
(you cannot merge four of five and wait), and on a correctly published batch a mid-walk read would
in any case tell the walk nothing it does not already know. `docs/agents/ticket-shape.md` has each
slice `blocked-by` its predecessor by construction, and the chain closes each slice before targeting
the next, so those edges are satisfied by the time such a read would see them. What an out-of-order
publish does to that, and why it is still not an argument for reading edges per slice, is below under
[*Containment transfers authorisation*](#containment-transfers-authorisation-sequencing-does-not).

**Two workflows, one label, and exactly one of them speaks.** `agent-implement` and
`agent-implement-prd` share `agent:implement` on `issues: [labeled]`, so both jobs start on every
label event and partition the work by issue *shape*: sub-issues present → the PRD path, anything
else → `agent-implement`. Whichever does not own the shape calls `defer` and exits having touched
nothing:

- **no comment**, or a human sees two bot comments about one event saying opposite things;
- **no label edit**, and this is the load-bearing half — the chain re-adds `agent:implement` to the
  parent to start the next slice, and a second job racing to remove it eats the chain silently.

The partition is therefore settled *before* either preflight says anything, which is why the shape
query moved above the state check in `agent-implement`: a closed PRD parent would otherwise collect
the same "this issue is not open" comment twice, seconds apart, from two runs that cannot see each
other. A nested PRD routes to the PRD path deliberately — it is the one shape both could claim, and
the PRD path is the one that can explain what is wrong with it.

**One count is computed rather than read.** After closing its sub-issue the run re-reads the
parent's sub-issues — so a slice added or closed by hand mid-run still counts — but subtracts the
one it just closed regardless of what the API reports. That read is not guaranteed to have caught
up with the close, and reading it back as still open is the one wrong answer with no recovery: the
chain re-labels, the next run's preflight finds nothing open and refuses "the PRD is finished", and
`agent:review` is only ever added on the *other* leg. The PR would sit finished, in draft, reviewed
by nobody.

**The same state is still reachable by failing, so both messages name the way out.** Every step
after `Close the finished sub-issue` fails with that sub-issue already closed — so on the *last*
slice, the failure comment's own remedy ("re-apply `agent:implement`") lands on the finished-PRD
refusal instead of retrying anything, and the run has walked a human into the
remedy-that-refuses-again trap the single-issue preflight warns about. Neither end of that loop can
fix it alone, so both say the other thing: the failure comment names the PR and asks for `agent:review`
on it by hand, and the finished-PRD refusal names the still-draft PR on `agent/prd-<n>-*`. The
alternative — making `agent:review` reachable from a second place — is a second owner of the one
handoff, which is what §10's residual race is already about.

### The trade: review is once per PR, not once per slice

Verified against CVM on 2026-08-07. Its handoff step is gated on the remaining count being zero, so
`agent:review` is applied **only** when no open sub-issues remain. Intermediate iterations close
their sub-issue with a commit-SHA comment and nothing else — no review agent, no review label, not
even as an addition. Adopted deliberately.

The PR is the unit of review because it is the unit of merge. A per-slice review would critique code
the next slice is about to rewrite, with inline comments going outdated as the branch advances —
the stale-anchor problem #102/#105 spent two rounds fixing at the workflow level.

**The cost, stated plainly:** a design error in slice 1 is not caught until slice N is written on
top of it. Partly covered already — `corpus.yml` runs per push on `src/**` and `verify` runs per
slice, so behavioural regressions surface at the slice that caused them. Only *design* feedback is
deferred.

**If that ever bites, do not add a per-slice review workflow.** The cheap fix is a prompt line
telling the implement agent to run its own review pass over the slice before committing — which is
what a human's local `/implement` … `/code-review` loop does anyway. `implement-prd/prompt.md`
already carries that line ("BEFORE YOU COMMIT"), which pulls correctness feedback earlier while
keeping one review per PR. Escalating it into a workflow is the thing to resist.

### Containment transfers authorisation. Sequencing does not.

Two blocker checks exist, one per implement workflow, and a third place that deliberately has none.
The rule sorting them is not "check blockers wherever you can" — it is which *relationship* the
check would sit on.
Written down here (#19) because it had been derived twice without ever being recorded — once when
`36cdc47` shipped the flat check, again when #14 argued the parent one — and the clearest statement
of it lived in a comment thread on an issue being closed. A rule that has to be re-derived each
time it is questioned is not written down yet.

A PRD parent **contains** its sub-issues: the body is the spec, the slices are pieces of it, so
authorising the parent authorises them. That is what makes one label safe to drive five runs onto
one branch, reviewed once — the whole of §2a rests on it, and so does §10's "the parent is the
control point".

`blocked_by` is **sequencing**. The blocker is a separate deliverable with its own PR and its own
reviewer. Chaining through it would authorise work nobody asked for, transitively — A→B→C means
labelling C implements three things — and some blockers are decision tickets that are not
implementable at all, which is the same reason the `wayfinder:` refusal exists.

So a blocker check belongs wherever the thing being labelled is the thing being authorised, and
nowhere else:

| | check blockers? | |
|---|:--:|---|
| flat issue | ✅ | shipped, `36cdc47` |
| PRD **parent** | ✅ | #14, and the cost of running anyway is a whole chain, not one wasted run |
| PRD **sub-issue** | ❌ | contradicts the ordering contract — see below |

**The sub-issue row is the load-bearing one, and it is a decision rather than an omission.** The
chain walks sub-issues in API order and reads `blocked_by` **nowhere**:
[`docs/agents/ticket-shape.md`](./agents/ticket-shape.md#creation-order-is-execution-order) puts
the topological sort on whoever publishes the batch, and the ordering note above records reading
edges mid-walk as a deliberate non-goal (§10 too, and `implement-prd.yml`'s own header). Underneath
the contract is the design reason it exists: slices are pieces of one feature landing on one branch,
so a slice that needs outside work means the *whole PRD* is blocked — you cannot merge four of five
and wait. That dependency belongs as an edge on the parent, which is the one the preflight reads.
And a mid-walk read is in any case the wrong place to catch it. Every slice after the first is
`blocked-by` its predecessor by construction, but the chain closes each slice before targeting the
next, and both existing checks refuse on *open* blockers only — `select(.state == "open")` — so a
per-slice read mirroring them passes on every in-PRD edge a correct publish gives, spending a call
per slice to re-derive the order the walk already has. **Two cases do make it refuse on an in-PRD
edge**, and together they are the strongest argument for reading per slice. They are one defect
wearing two faces — the walk order and the edges disagree — and this file names both: a batch
published out of dependency order, which `ticket-shape.md` calls, in the section linked above, the
one nothing catches; and a batch published correctly and *then* reordered by a drag in the parent's
UI, which §10 names as the hazard the ordering rule buys. It is still the wrong shape of answer. The
refusal lands mid-walk, after however many slices are already committed to the branch — the hazard
arriving late rather than a repair for it, and the repair in both cases is the order itself, fixed
where it is set: the publish sequence, or the sub-issue moved back through the parent's ordering
(§10). That is where `ticket-shape.md` and `implement-prd.yml`'s header both put it. Every *other*
edge such a read could refuse on points outside the PRD, and that is precisely the edge that belongs
on the parent: read once, before anything lands, rather than discovered four slices in with the
branch already carrying them and the PR left in draft.

**The distinction is easy to lose while holding it**, which is the argument for a section rather
than an aside. `36cdc47` states it in full and then defers the second check with "same argument
applies" — true of the parent, and at three words the natural reading is *check blockers
everywhere*, which walks straight into the sub-issue row above. The author who drew the line wrote
that sentence, and #5's thread is where it was caught; this section is what was caught.

---

## 2b. A third execution model: `sandcastle`'s parallel planner

Lettered for the same reason §2a is. **Recorded, not adopted** — nothing below proposes a change.

`mattpocock/sandcastle` ships five `sandcastle init` templates — `blank`, `simple-loop`,
`sequential-reviewer`, `parallel-planner`, `parallel-planner-with-review`. The last two build a
dependency graph, and they build it in a way neither model compared elsewhere in this file uses.
Verified against `@ai-hero/sandcastle@0.12.0` on 2026-08-08, reading the published templates
directly.

**The graph is inferred by an LLM from issue text, not read from native relations.**
`plan-prompt.md` hands an opus agent the open-issue list and asks it to decide, per pair, whether B
is blocked by A:

> - B requires code or infrastructure that A introduces
> - B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
> - B's requirements depend on a decision or API shape that A will establish

There is no tracker relation behind any of that. Grepping the package for `sub_issue`, `subIssues`,
`blocked_by`, `blockedBy`, `--parent`, `parent_issue` and `dependencies/` across every `.ts`,
`.mts`, `.md` and `.json` returns **zero matches** — no parent/child concept exists in sandcastle at
all. (Grepping the bundled `dist/*.js` too returns only an HTTP status constant from a vendored
dependency.) The issue list itself arrives through a configurable `{{LIST_TASKS_COMMAND}}`, so the
planner does not know what a GitHub issue *is*, let alone that one can have a parent.

**It also inverts the execution model.** `main.mts` runs three phases in a loop of up to ten
iterations: plan → N implementers **in parallel**, one branch each → one merge agent. Each
implementer gets `sandcastle/issue-{id}`, deterministic *by design* so that re-planning the same
issue lands on the same branch and accumulated progress survives. `Promise.allSettled` keeps one
failing agent from cancelling the others, and only branches that actually produced commits reach
the merge phase, where a single agent merges each in turn, resolves conflicts by reading both
sides, runs typecheck and tests, and closes the issues. Newly-unblocked work is picked up next
round.

| | dependency source | execution | collision handling | runs where |
|---|---|---|---|---|
| sandcastle planner | LLM infers from issue text | parallel, N branches | dedicated merge agent | local, docker |
| CVM PRD tier (ours, §2a) | sub-issue creation order | sequential, one branch | avoided by serialising | GitHub Actions |
| `/to-tickets` flat (upstream skill) | native `blocked_by` | *(no executor)* | — | — |

**Why it is worth recording.** It needs no native relations, so it sidesteps the `/to-tickets`
prose-vs-native defect (`mattpocock/skills` #513/#262) entirely — the defect that cost #109 three
review rounds and that the *Verify natively* section of `docs/agents/ticket-shape.md` exists to
catch by hand. If publishing real batches keeps hitting it, this is the escape hatch, and reaching
for a model that already exists upstream beats inventing one.

**Why it is not adopted.** The PRD tier is built, proven end to end (#87), and matches CVM, which is
the actively-maintained reference. sandcastle is local-only and tracker-agnostic, its templates
still pin `claude-opus-4-8` / `claude-sonnet-4-6`, and the repo was last pushed 2026-06-29. Two of
its properties are also live costs rather than free wins here: an inferred graph can be wrong with
no edge to check it against, and a merge agent resolving conflicts is a second writer on work no
human has reviewed — which is the shape §10's "never auto-cascade review → fix" invariant exists to
keep out. What it buys is parallelism this repo has never needed; every ordering that has actually
come up was *inside* one PRD.

---

## 3. `agent-review`

| Feature | CVM | Ours | Note |
|---|:--:|:--:|---|
| Triggered by `agent:review` on a PR | ✅ | ✅ | |
| Refuses when the PR is closed/merged | ✅ | ✅ | added #102. Without it, labelling a merged PR ran a full agent pass and then failed at `gh pr ready`, which cannot convert a merged PR — under a warning that blames a missing `AGENT_PAT` |
| Structured output (schema-validated JSON from the agent) | ✅ | ✅ | |
| Findings placed against the diff rather than where the model said | ✅ | ➕ | GitHub rejects the **whole** review if one line anchor is off-hunk, so the anchor has to be checked either way. CVM filters; since #110 we reroute — an off-hunk anchor in a changed file becomes a **file-level** thread, and a finding in a file the PR never touched becomes an entry in the review body. No finding is dropped, which matters because the verdict counts findings the old filter could delete |
| Posts a review summary | ✅ | ✅ | |
| Posts inline comments | ✅ | ✅ | as GraphQL `addPullRequestReview` threads since #110 — REST review-create cannot open a file-level thread (422) and its `comments` field is deprecated in favour of `threads` |
| **Every finding carries an id the workflow wrote** | ❌ | ➕ | #110. A hidden marker in each thread and each body entry, so a later round recognises a finding it has seen without matching its text. The model is told to write none: one it invented would be matched against a thread it never opened |
| Reads review summaries + unresolved threads + conversation | ✅ | ✅ | one GraphQL query. Resolved threads are out of the rendered feedback, but no longer simply dropped: since #112 the query reads `resolvedBy`, and the ones a human closed come back as the *settled* list (below) |
| **Verifies the findings an earlier review left open, and resolves the ones that landed** | ❌ | ➕ | #111. Every review — round 1 included — is handed the open threads this loop opened and the open entries in the latest review body, each with its id, and rules `landed` / `open` on each. Landed closes the thread with `resolutionReason: ADDRESSED` and a reply saying why; still open counts toward this review's verdict. A finding a review says nothing about stays open |
| **A maintainer's decisions stick** | ❌ | ➕ | #112 (#109, decision 10). A thread a *human* resolved is handed to every later review as **settled — never raise again**, in any wording; a thread a maintainer replied to declining the finding is closed as `WONT_FIX` quoting them, and stops counting toward the verdict. The review never overrules a maintainer: a reply it cannot read as a decline leaves the thread open, only a reply the **author gate** passed can close one at all, and only a maintainer's **latest** reply on the thread — the one the closing reply quotes — may be ruled on |
| **Agent self-improves: commits fixes and pushes** | ✅ | ❌ | biggest single gap. Would need `contents: write`; `agent:fix` covers it with a human deciding |
| **Replies in review threads** | ✅ | ➕ | the review replies where it **closes** a thread, and only there (#111): `resolutionReason` is recorded by GitHub and readable nowhere afterwards, so the reply is the only record of why a finding closed. `agent:fix` replies in every thread and closes none (§4) |
| **Marks the PR ready for review** when done | ✅ | ✅ | `success()` only, so a failed review leaves the PR in draft — see the invariant in §10. **Requires `AGENT_PAT`**: `GITHUB_TOKEN` cannot convert a draft at all |
| Emits a verdict (`improved` / `clean`) | ✅ | ❌ | only meaningful with self-improvement |
| Approve / request-changes | ❌ | ❌ | both always post `COMMENT` |
| Installs an external `code-review` skill at run time | ✅ | ❌ | CVM pulls `mattpocock/skills`; ours inlines the checklist in the prompt |
| `contents: read` (structurally cannot mutate the branch) | ❌ | ➕ | CVM needs `write` because it self-commits |
| **Records out-of-scope findings for filing** | ❌ | ➕ | #44. A third output channel beside the summary and the findings, serialised into the review body as a collapsed block with a versioned payload, and capped at three. A run that recorded none posts the payload alone, invisibly: the filing half reads the latest list, so recording nothing has to be sayable or a fixed finding files anyway. The review still cannot file: it marks the PR `agent:follow-ups` and stops (§8), and a separate workflow reads the body on merge (§1) |

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
| **Resolves the threads it addressed** | ❌ | ❌ | it did until #111 and now resolves **nothing**: the author of a fix marked its own work done, and a resolved thread is dropped from what the next review is shown, so the pass that checks it could not see it. The reviewer closes threads now (§3), and `addressed` / `declined` is a claim recorded in the reply |
| **Posts new inline comments** | ✅ | ❌ | **decision, not omission** — see below |
| **Posts top-level comments** | ✅ | ✅ | ours states in the prompt what the channel is *for*; CVM has the field and no guidance anywhere |

**On the name.** CVM calls this `agent-implement-pr` and triggers it with `agent:implement`,
disambiguated only by event type. Ours is `agent-fix.yml`, triggered by `agent:fix`. Two reasons:
labelling a *PR* `agent:implement` here would silently do nothing, since `agent-implement.yml`
listens on `issues:` only; and every other workflow in this repo holds **file name == display name
== trigger label**, so `agent-implement-pr` + `agent:fix` was the one pair you had to remember. The
`-pr` suffix is redundant besides — it triggers on `pull_request_target` and refuses on a closed or
merged PR, so it cannot run on anything else.

Ours converses in-thread; CVM replies too, and neither closes a thread. The difference is what
happens next: ours are closed by the **review** that verifies them (§3, #111), so they neither
accumulate until a human clears them nor close on the word of the run that wrote the fix. Since #78
it can also *raise* something that belongs to no thread, as a top-level comment on the PR
conversation — the channel that was missing when
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
| `docs/agents/` platform spec + backlog + label docs | ✅ | 🟡 | ours has `docs/agents/` since #89 and four files in it — `triage-labels.md`, `issue-tracker.md`, `domain.md` (a pointer to `CONTEXT.md`, not a second copy) and `ticket-shape.md` (#93). All of it is per-repo config for the **local** skills; no workflow loads any of it, and the one file a workflow depends on the *output* of is `ticket-shape.md` (§2a). Still no platform spec or backlog: `CONTEXT.md`, `CLAUDE.md`, this file and `friction.md` cover that ground |
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
| `init` and `doctor` | The install path, as subcommands of the runner binary (#6). Neither upstream mechanism covers the Actions half: `sandcastle init` sets up the local loop and refuses a re-run, `/setup-matt-pocock-skills` sets up the skills' config, and **neither sets up GitHub Actions** — nor the labels, the two secrets, the repository setting or the version pin. `doctor` has no upstream counterpart at all; it exists because every failure in `docs/ADOPTING.md` §1 is a condition with no runtime symptom |
| `CONTEXT.md` domain model | CVM has one too; ours is load-bearing for rule-class reasoning |

---

## 8. Labels

| Label | CVM | Ours |
|---|:--:|:--:|
| `agent:implement` | ✅ issues **and** PRs | ✅ issues only — two workflows, partitioned by shape (§2a) |
| `agent:fix` | ❌ | ➕ PRs — CVM overloads `agent:implement` instead |
| `agent:review` | ✅ | ✅ |
| `agent:in-progress` | ✅ | ✅ |
| `agent:blocked` | ✅ | ✅ |
| `agent:queued` | ✅ | 🟡 declared in `docs/agents/triage-labels.md`, written by a human, read by nothing — `promote-queued` is deferred (§1). 🟡 and not ✅ on this file's own legend: the label is present, the tier it belongs to is not |
| `agent:to-issues` | ✅ | ❌ PRD tier — and the string is double-booked on the tracker: #79 (harvest agent comments into issues, §10) proposes the same label for an unrelated job. Neither exists here yet, so it costs nothing to settle, but #79 is the one that has to move — this row is upstream's name for upstream's workflow |
| `agent:follow-ups` | ❌ | ➕ PRs — the marker *and* the manual trigger in one string, disambiguated by event type rather than by a second label a human could choose wrong. Added by review, removed by any filing run that reached a verdict — including one that found every finding already filed by an earlier attempt, and one that read a retraction; removing it by hand is the opt-out (`docs/ADOPTING.md` §3) |
| `agent:update-branch` | ✅ | ✅ |
| `Sandcastle` (triage: "ready for an AFK agent") | ✅ | 🟡 ours is `ready-for-agent`, written by the local `/triage` and `/to-tickets` skills; no workflow reads it |

**Why `agent:fix` rather than overloading `agent:implement`:** CVM disambiguates by event type,
so the same label means two things depending on where you put it. Here that would be a footgun —
`agent-implement.yml` triggers on `issues:` only, so labelling a PR `agent:implement` would
silently do nothing.

**And why overloading it by issue *shape* is not the same footgun.** Since #92, `agent:implement`
on an issue does start two workflows — but they disambiguate on something the labeller can see on
the issue in front of them (does it have sub-issues?), not on where they put the label, and the one
that does not own the shape leaves nothing behind. The event-type version fails silently in the
labeller's face; this one cannot, because whichever workflow owns the shape always acts and always
says so.

**Two further vocabularies sit alongside this table**, neither of which any workflow triggers on:
the five canonical triage roles (`ready-for-agent`, …) and `wayfinder:*`. `docs/agents/triage-labels.md`
(#89) maps all three and records why `ready-for-agent` → `agent:implement` stays a human hand.

**No ticket a skill publishes carries a label from this table.** `/to-tickets` gives every ticket in
a batch `ready-for-agent` and nothing else, parent and slices alike (`docs/agents/ticket-shape.md`,
#93). The promotion to `agent:implement` is one deliberate human action on **one** issue — the
parent — and §10 records why the sub-issues stay out of it.

---

## 9. If we closed the gaps, in order

Done since first written: **conversational replies + resolution** (#49/#50 — and ours also
*resolves* threads, which CVM does not; since #111 it is the review that closes them, not the fix), **`agent-update-branch`** (#52, motivated by a real trap,
not theory — see `friction.md`), **implement → review auto-cascade**, **review marks the
PR ready** (it had become a manual step on every agent PR), **`agent-implement-prd`** (#92 — the
execution half of the PRD tier, which had been off this list entirely), and **the publish contract
it reads back** (#93, `docs/agents/ticket-shape.md` — not a workflow, and the reason the item below
is one line rather than three).

What remains is ranked by value per unit of risk, not by size. Anything that widens an agent's
write access sits below everything that does not, regardless of how useful it looks.

1. **Composite action for setup** (📋) — pure cleanup, now that five workflows duplicate
   checkout → node → ci → claude. #92 added the fifth copy without changing a line of it, which is
   the argument.
2. **Agent-authored PR body** (❌, `write-pr`) — promoted from "cosmetic" on 2026-08-01. The body is
   a hardcoded heredoc in the implement workflow, so it is the one thing an agent **cannot** write.
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
6. **`agent-promote-queued`** (❌, **deferred** — #91) — all that is left of what this list once
   carried as "PRD tier, ❌ ×3". Written off originally because nothing here needed sequencing;
   #87 then needed it, and the answer was `agent-implement-prd` (#92) plus a publish contract
   (#93), neither of which is this workflow. This one sequences **top-level** issues, and every
   ordering that has actually come up was *inside* one PRD, where creation order already carries it.
   Ranked here rather than higher because the numerator is currently zero: what would raise it is a
   second PRD that cannot start until a first one merges. #91 is open, unscheduled, and was detached
   from #87 precisely so this chain would not build it. The label is already declared (§8), so the
   remaining cost is the workflow alone.

   Its former companion, `to-issues-prd`, has **left this list**: superseded rather than deferred
   (§1). What kept it here as a gap was the ordering obligation it used to discharge by publishing
   the sub-issues itself; that is now written down and verified by hand (#93), so nothing is
   outstanding.
7. **`architecture-review`** (📋) — self-directed work generation. The autonomy tier, and the only
   *scheduled agent* in either upstream repo. Upstream publishes via `/to-prd-project`; here the
   equivalent is filing a PRD and stopping, with a human running `/to-tickets` on it to get the
   sub-issue shape the chain reads — which §10 requires anyway ("an agent that raises work never
   files it" applies at the *decomposition* step just as much). So what it now waits on is project
   skills, not the missing planning workflows: #92 and #93 between them removed the piece that would
   have had nothing to run the result.

## 10. Invariants

Rules that must hold as features are added, each recording a decision that is cheap now and
expensive to rediscover.

- **Never auto-cascade review → fix.** `agent:fix` → `agent:review` is safe *only* because review
  adds no trigger label, so every round still needs a human `agent:fix`. Automating the return leg
  closes a true cycle with no gate.

  **Since #98 that safe leg is walked by the loop rather than by a human.** A `fix` run that
  pushed adds `agent:review` itself, so a round closes itself out instead of leaving a fixed
  branch whose verdict still reads "add agent:fix" — the state nothing re-checked, which is the
  problem #96 exists to remove. Nothing above changes: review still adds no trigger label, so the
  arrow stops at review, and `agent:fix` is still a human's to add.

  **And since #111 the leg is load-bearing rather than tidying.** A fix run resolves nothing, so
  the review it asks for is the pass that *ends* the round's findings: it reads the code the fix
  wrote, closes what landed and counts what did not. "A round closes itself out" used to mean the
  verdict got refreshed, with the threads already closed by the run that wrote the fix; it now
  means the findings themselves are ruled on by something other than their fixer. What this costs
  is that the leg is no longer optional in practice — a round nobody reviews again is a round whose
  threads all stay open — and that is the right cost, because the alternative is the fixer
  closing them.

  A second bound now sits under the first, and it is what makes the leg safe to automate rather
  than merely acyclic. The review a fix asks for is by construction a **round 2** (an earlier
  verdict stands, every commit since is the loop's own, and at least one of them is a non-merge
  commit — `shared/review-round.ts`), and a round-2 review can never produce the **round-1**
  *Changes recommended*: findings that survived a fix round get the round-2 row instead, whose line
  drops the promise of an automatic re-review and asks the maintainer to read the review, adding
  guidance where it helps, before labelling again (#96 decision 5, enforced in `deriveVerdict`, not in the prompt). The two rows share a heading and
  differ in the next step and in the key `verdict.json` carries, which is what an automatic fix
  would have to match on. So the leg cannot be walked twice off one human label — the second
  round's only outcomes are *Approval recommended* and a human.

  And a fix run that pushed *nothing* requests nothing. The threads it replied to already say why
  it declined, and the verdict standing on the head commit is still the right one: nothing has
  happened for a review to be about. Those threads stay **open**, which is the same answer #111
  gives everywhere else and lands here as a statement about who decides: a finding the loop
  declined is not a finding the loop may retire, so the round ends on a maintainer reading the
  decline and resolving the thread or pushing back. That is also what makes the optional
  "require conversation resolution" gate mean something (`docs/ADOPTING.md` §3b) — under it, the
  merge waits on exactly that reading.

  **Since #99 `update-branch` walks the same leg**, on the half of its work an agent wrote: a
  conflict resolution adds `agent:review` and a clean merge does not, because a clean merge carries
  the last verdict forward instead (#96, decision 6). The first bound is what holds it — one hop to
  a review that adds no trigger label, and review still adds none — and the second one does not
  apply, because the review a resolution asks for is a **round 1**: round 2 needs a non-merge loop
  commit since the verdict, and a resolution leaves only a merge commit. That is the reading rather
  than a gap in it (#105). The findings of the verdict a conflict interrupted have never been
  attempted, so counting the merge as a fix round would answer them with "a fix round didn't
  settle these" — spending a human on a base branch moving, and on findings no fix round ever saw,
  which is the one thing on this leg nobody chose. What is worth saying twice is which arrow this
  is *not*: no workflow in the loop adds `agent:fix`.
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
  and `commitOID` on the posted review — and that payload is snapshotted at *label* time while the
  group decides *start* time. So: a fix is running, a human labels `agent:review`, the run snapshots
  A and waits, the fix pushes B and frees the group, and review then reads A cleanly and reviews it.
  Reading-during-a-write became reading-after-one: no torn tree, but every inline comment lands on
  an ancestor commit and GitHub renders it outdated. The mutates already catch their version of this
  at push time — `--force-with-lease` pinned to the same payload SHA — so review, which publishes
  rather than fails, is the only one that needed a check, and it makes it in its own preflight
  (#105). It refuses rather than re-targeting the live tip: a review is a statement about the commit
  a human pointed at, re-pointing it would drag `commitOID` and the CI wait to a SHA nobody
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

  **Residual, live since #92 (PRD tier).** `agent-implement-prd` pushes to a PR's branch under
  `agent-implement-prd-issue-<parent>` while review and fix use `agent-pr-<prNumber>` — different
  groups, so the same read-during-write race exists one level up. Group keys cannot close it: an
  `issues` event carries no PR number, so the two cannot compute a shared key. The happy path does
  not overlap (the chain adds `agent:review` itself only after the last sub-issue closes), but a
  human labelling `agent:review` mid-chain would hit it. Accepted knowingly rather than fixed; if
  it ever bites, the fix is a preflight refusal in review when the linked issue has an active PRD
  chain — not a concurrency change.
- **Review is requested once per PR, never once per slice.** `agent-implement-prd` adds
  `agent:review` only when its parent has no open sub-issues left; every intermediate run closes its
  sub-issue with a commit SHA and stops. The PR is the unit of review because it is the unit of
  merge, and a per-slice review critiques code the next slice is about to rewrite from inline
  comments that go outdated as the branch advances — the stale-anchor problem #102/#105 spent two
  rounds fixing. The cost is real and is stated in §2a: a design error in slice 1 waits for slice N.
  If it bites, the fix is a prompt line asking the implement agent to review its own slice — which
  `implement-prd/prompt.md` already carries — **not** a per-slice review workflow.
- **Two workflows may share a trigger label only if exactly one of them speaks.** `agent-implement`
  and `agent-implement-prd` both fire on `agent:implement`, and partition by issue shape. Whichever
  does not own the shape defers: no comment, no label edit, `exit 0`. A comment there is a second
  voice contradicting the run that *is* handling the event; a label edit is a race — and the one
  label at stake is `agent:implement` itself, which the PRD chain re-adds to start its next slice.
  So the partition is settled before either preflight says anything at all, ahead of even the
  closed-issue refusal. See §2a; `tests/workflows.test.ts` holds both `defer` bodies to it.
- **The parent is the control point; a sub-issue is never labelled directly.** A batch carries
  `ready-for-agent` on every ticket and `agent:*` on none of them; one human adds `agent:implement`
  to the parent and that starts the whole chain (`docs/agents/ticket-shape.md`, §8). The chain is
  the only thing that schedules a slice, so hand-labelling one is a second scheduler with no view of
  the first — it would branch that slice off `main` while the chain accumulates onto
  `agent/prd-<n>-*`, giving one PRD two PRs. `agent-implement` refuses any issue with a parent
  (#90), so today that attempt is caught rather than obeyed, but the refusal is a backstop and not
  the rule: the rule is that nothing labels a sub-issue in the first place.
- **Creation order is execution order, and the edges are the record rather than the schedule.**
  `agent-implement-prd` walks sub-issues in API order and never reads `blocked-by`; the topological
  sort happens once, at publish time (§2a, `docs/agents/ticket-shape.md`). Two consequences that
  only look like details. **Publish sequentially, blockers first** — a parallel publish has no
  defined order, which is the same bug arriving by accident. And **a wrong order is repaired by
  moving the sub-issue**, through the parent's ordering, not by teaching the chain to read edges: an
  edge-reading chain has to decide what to do with a cycle, a missing edge and an edge pointing out
  of the PRD, and each of those answers is a scheduler nobody asked for. The hazard the rule buys is
  worth naming: dragging a sub-issue in the parent's UI silently rewrites the execution order of a
  chain that has not run yet, with no other visible effect anywhere.
- **Containment transfers authorisation; sequencing does not.** One `agent:implement` on a PRD
  parent authorises every slice, because the parent *contains* them — the body is the spec and the
  slices are pieces of it. `blocked_by` is the other relationship: it orders separate deliverables,
  each with its own PR and its own reviewer, so chaining through it would authorise work nobody
  asked for, transitively (A→B→C: labelling C implements three things), and some blockers are
  decision tickets `wayfinder:` already refuses. That is why a blocker check belongs on a flat issue
  and on a PRD parent (#14) but never on a sub-issue, where it would contradict the ordering
  contract and discover mid-chain what belongs on the parent. The table and the sub-issue row's
  reasoning are in §2a, under
  [*Containment transfers authorisation*](#containment-transfers-authorisation-sequencing-does-not);
  it is there rather than only here because the rule keeps being re-derived when it is questioned.
- **`agent:queued` is written by a human, never by a workflow.** It is the one `agent:*` label no
  workflow touches at all (§8) — `agent:in-progress` and `agent:blocked` have no consumer either,
  but a workflow applies and clears them — and until `promote-queued` exists (§1, §9.6) nothing
  removes it either, so a workflow applying it would be manufacturing a state only a human can
  clear. It also does not
  belong *inside* a PRD: every slice after the first is queued by construction, and a label saying
  so is one more thing that can go stale against an ordering the chain already holds. If
  `promote-queued` ever ships, this becomes "written by a human or by that workflow, on top-level
  issues only" — and not before.
- **Every workflow refuses a terminal target before it does any work.** A closed or merged PR, a
  closed issue: the guard is the first step, it is itself ungated, and it runs before checkout,
  before `npm ci`, and before the label transitions — so a refused run never claims
  `agent:in-progress` and never has a working tree to be wrong about. The failure it prevents is
  not a crash but a *plausible* result: review had no guard until #102 and would review merged work
  in full, then fail at `gh pr ready` under a warning blaming a missing `AGENT_PAT`, which is a
  wrong diagnosis of a real problem. Each refusal says which state it refused; two refusals that
  read alike are two states a human cannot tell apart from the comment. `tests/workflows.test.ts`
  holds all five workflows to all three properties — guard first, guard ungated, no
  `agent:in-progress` on a refused run. In `agent-implement-prd` the third covers a *deferral* as
  well as a refusal, which is the same property for a stronger reason: a run that stepped aside for
  its sibling must not have claimed the issue on the way past.

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
- **The reviewer closes a thread; the fixer never does.** Since #111 (#109, decision 1) an
  `agent:fix` run replies in every thread it was shown — `addressed` or `declined`, with the reason
  — and resolves none of them. A thread closes when a **review** has read the current code and
  ruled the finding landed, with `resolutionReason: ADDRESSED` and a reply saying why, or when a
  human closes it.

  This used to read "*only `addressed` resolves a thread*", which bounded the right hazard on the
  wrong side. Auto-resolving a *decline* would let an agent bury a disagreement; auto-resolving an
  *addressed* one let it mark its own work done — and because a resolved thread is dropped from the
  feedback the next review is handed, the one pass whose job is "did it land?" could not see what
  it was checking. #105 patched that with a checklist in the review body; moving the close to the
  reviewer is the cause rather than the symptom.

  Every review does it, round 1 included: a human may have pushed the fix, and "is this still true
  of the code in front of me" has the same answer whoever wrote the commit. A finding the review
  says nothing about **stays open**, which is the direction this has to fail in — a finding nobody
  checked is not a finding anybody settled.
- **A maintainer's decision on a finding is final, and the loop may not revisit it.** Since #112
  (#109, decision 10) a thread a *human* resolved is passed to every later review as settled, with
  the instruction not to raise it again **including by rephrasing** — the record matches findings by
  id and never by text, so a re-derived finding gets a new id and nothing downstream could tell it
  was the settled one coming back. And a thread where a maintainer replied declining the finding is
  closed by the reviewer as `WONT_FIX`, quoting their reply, and stops counting toward the verdict.

  The review reports the decline; it never takes one. It has no `declined` to reach for on its own
  authority, a reply it cannot read as a refusal leaves the thread **open**, and — the half that is
  structural rather than asked for — a decline closes a thread only where a reply that passed
  `isTrustedAuthor` is on the thread. Every feedback surface on a public pull request is
  world-writable, so a gate the *agent* applied would be one a comment could argue its way past.

  The asymmetry is deliberate: an open finding that should have closed costs a round, and a closed
  finding that should have stayed open costs the decision — silently, since `resolutionReason` is
  readable nowhere afterwards. That is why the quote is the reply's whole content: a maintainer
  whose words were misread can see it in one glance and reopen the thread.

  **The quote is evidence, not an attribution.** A `VerificationEntry` is `id`, `status` and `note`
  — no field names *which* comment the review read as a refusal — so the closing reply says "this
  review read a refusal here; the latest maintainer reply on the thread is this", and the brief
  rules the decline on that same latest reply. Written the other way round it asserted "@x declined
  this", which on a thread where two people spoke lands on whoever wrote last: a maintainer named
  as having taken a decision they did not take, and — where the last word reversed an earlier
  refusal — a finding retired on a reply asking for it to be fixed.
- **A finding an earlier review missed counts against the merge, in every round.** A real problem a
  later review finds in code an earlier review already read is labelled *previously missed*, is a
  `fixBeforeMerge` finding like any other, and in round 2 therefore derives the round-2 *Changes
  recommended* (#109, decision 4; `shared/review-findings.ts`).

  **This changes #96's round-2 rule**, which sent everything a verification pass newly noticed to
  `followUps` — filed as an issue *after* the merge it should have stopped. The reasoning then was
  that round 2 is a verification pass and not a fresh review, which is right about its *job* and
  wrong about this case: a finding in code the record already covered says the record was wrong
  about this pull request, which is a stronger reason to stop the merge than an ordinary finding
  rather than a weaker one. What is unchanged is the bound around it — a round-2 review still
  cannot produce the round-1 row, so a previously-missed finding asks a maintainer to read and
  reply rather than sending the loop round again. Genuinely out-of-scope findings still go to
  `followUps`, on the bar stated with that list.
- **A label on a finding is presentation, and one predicate decides what counts.** Every entry in
  `findings` is fix-before-merge by definition — #96's decision 1 leaves a finding two kinds and
  `followUps` is the other — so `countFixBeforeMerge` and `reviewRecord` both take *every* finding,
  whatever its placement and whatever its body opens with, plus the carried findings ruled still
  open. `**Findings:** N` is therefore the record's own size, entry for entry, and a test asserts
  that equality over every shape of review rather than over an example.

  A predicate over the label was a **second definition of "a finding counts"**, and the two
  disagreed in the unsafe direction twice. In a file the pull request never touches there is no
  thread, so the record is the only surface: an unlabelled finding was recorded and counted
  nowhere, and the review posted *Approval recommended* and a `success` status over a populated
  *Open* group. On a diff line it got a thread and an id and still reached no group and no count in
  the round that raised it — then counted through `stillOpen` in every round after, so the same
  finding was non-blocking when found and blocking for ever after with no code change between.

  The label is still asked for in both halves of the brief, because it is the first thing a human
  reads on the thread. What it may never be again is a thing the machinery reads: the one
  survivor is *previously missed*, which selects a **group** and not a count.
- **Severity is display and ordering, and nothing reads it that decides anything.** Since #113
  (#109, decision 9) every finding and every follow-up carries `high` / `medium` / `low`. The
  review body sorts each group worst first and badges each entry; `deriveVerdict` never sees it,
  the routing between the two finding types never sees it, and the follow-up cap never sees it.
  A test permutes the ratings across a review and holds the verdict, the count and the kept
  follow-ups identical.

  That is the whole of the bargain, and it is the one #96 struck when it retired *judgement call*:
  a dial the model turns that changes the outcome means every review has to be read to find out
  which way it was turned. `low` is a **real but small defect** — nameable, with a stateable
  consequence — and not a place to put the preferences that are still posted nowhere at any
  rating.

  The rating is written into the finding's own marker by the workflow, beside the id, because it
  has nowhere else to survive a round: a carried finding reaches a later review as an id and one
  line of text, and a record that badged what this round found and nothing it carried would be
  sorting half a list.
- **The review body is a record, and its newest copy is the current statement.** Since #113 (#109,
  decision 8) it is Copilot's overview in order — `## Agent review`, the assessment, one sentence
  naming what is unresolved, the step in italics, `**Findings:** N` with its severities, then
  collapsible *Open* (this round's entries marked *new*), *Previously missed*, *Resolved since last
  review* and *Follow-ups*, then *How this was checked* and *What changed in this PR*, then a rule
  and the run. `shared/review-output.ts` is the one place that order is written down.

  The heading is there because **every agent in the loop posts as `github-actions[bot]`**, so in a
  timeline the overview and a fix run's thread replies are one author saying more things. The rule
  above the run link is the body's **only** divider: between the groups it would read as a section
  break in a list that is one record.

  Two rules make it a record rather than a rendering, and both are about which entries carry a
  finding id. An entry with **no thread** carries its id, because the newest body naming it is the
  only thing keeping it alive; an entry **with** one does not, because the thread is its record and
  a second copy is one a maintainer cannot close. And a **resolved** entry carries none in either
  case — an id written back would hand a closed finding to the next round as something still to
  rule on. A threaded entry carries a **link** instead, read off the thread's own comment; a fresh
  finding carries neither, because its thread is opened by the same `addPullRequestReview` call
  that posts the body and so has no URL while the body is being composed.
- **The prose beside the record restates no finding, and is capped where it is read rather than
  where it is asked for.** One 250-word `summary` mixed what the change is with what the reviewer
  verified, and a prompt-only limit is one a model can talk its way past — #122's body was a
  checklist and then every finding again as a paragraph. It is now `assessment` (one sentence
  naming what is unresolved, under the heading, with a code-built fallback), `howChecked` (capped
  in the schema, on every review) and `whatChanged` (a sentence and at most five lines, capped in
  the schema).

  `whatChanged` is also the one part of the body that is **not** on every review: it appears on the
  first review of a pull request and on a later round 1 with commits nothing has described — a
  human's push, or a conflict resolution — and is omitted on a round-2 verification and on a
  re-review with nothing pushed since the last verdict (`describesTheChange`). Describing the
  change again, at the top, to a reader handed that description last round is the body spending its
  opening on something already read.
- **A label name renders as code in the body and as plain text in the status, from one sentence.**
  `VERDICTS` holds the plain wording because a commit status description renders no Markdown —
  a backtick shows up in it literally — and the body decorates it on the way out. Two spellings in
  the table would be two lines that can disagree, which is the failure the derived verdict exists
  to remove.
- **Every world-writable input is author-gated.** Issue and PR text reaches agents only from
  collaborators or our own bot. `agent:fix` pushes code, so an ungated input there steers commits.
- **Agents never hold the GitHub token.** Context is fetched before the agent starts and the token
  is scrubbed, so the no-push/no-label/no-comment boundary is technical rather than conventional.
  Top-level comments (§4) do not weaken this: the agent *reports* them in its structured output and
  the workflow posts them, which is the same shape as thread replies.
- **An agent that raises work never files it.** `agent:fix` may say a follow-up is needed; it
  cannot create the issue. `architecture-review` upstream has the same shape — it files a PRD and
  stops, and a human labels it `agent:implement`. Collapsing the two closes a cycle with no gate,
  the same failure "never auto-cascade review → fix" above already guards against. Concretely: no
  workflow gets `issues: write` unless filing is its job — `tests/workflows.test.ts` holds every
  workflow to that, exempting only the two `implement` workflows — both halves of each pair since
  #98 — `token-expiry.yml` by name, and the `follow-ups` pair for the reason immediately below, so
  a new one is covered on arrival (`agent-review` had been granted it unused, #101) — and harvesting those comments into
  issues (#79) is a separate workflow behind its own label.

  **Amended by `follow-ups` (#44), in its second half only.** This used to continue "*filing is a
  separate, human-labelled step*", and that clause is now false: a merged pull request's recorded
  out-of-scope findings become issues with nobody labelling anything. The clause is written out
  here rather than deleted, because an invariant that quietly loses a sentence reads to the next
  person as an oversight in whichever workflow contradicts it.

  What was being protected survives intact, and is the whole of what this bullet now asserts:

  - **The agent that raises the finding still never files it.** It is the review agent, and review
    holds `contents: read` and no `issues:` scope at all. It emits the findings into its own review
    body; a separate workflow, started by the merge, reads that body.
  - **The workflow that holds the permission runs no model.** `follow-ups` installs no agent and
    declares no secrets — what would be the agent's judgement is a pure function over plain objects
    (`shared/follow-up-plan.ts`). That is also what keeps reading arbitrary issue bodies while
    holding `issues: write` from being a prompt-injection surface, which is a property the
    human-labelled step never gave us.

  **Why the change is a move of the gate rather than the removal of one.** The concern behind the
  invariant is an *unattended cycle* — work raised, filed and built with no human in it. The gate
  is still there and has moved from **before filing** to **before building**: stubs arrive
  `needs-triage`, never `agent:implement`, so nothing a review raises is ever built until a person
  decides it should be. What the old position actually bought was a maintainer reading every review
  before merging and opening the issues by hand, which is the labour this loop exists to remove —
  and the failure it produced was silent, since an unfiled finding leaves no trace at all. Opt-in
  is what had already failed.
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

  **Narrowed by #111, knowingly.** A fix run's thread replies used to leave the `inline` surface by
  being *resolved*; now nothing resolves them until a review does, so a second `agent:fix` run on
  the same round reads its own replies back. Accepted rather than filtered, on two grounds. The
  reply is not an instruction — it is this agent's answer to somebody else's finding, and the
  finding above it is still what the prompt asks it to decide about — and the thread is the surface
  the *review* has to read to verify the claim, so a marker that hid it from one workflow would
  have to be read by the other. What it costs is a second fix run answering a thread twice, which
  is visible on the pull request; the failure the invariant is about is a workflow silently
  building what it asked for, and nothing here does that.
- **A channel the prompt bounds is also bounded mechanically.** Prompt guidance sets intent; it is
  not a control. `filterOutcomes` drops invented thread ids because a model invents them, and
  `filterTopLevelComments` caps a run at two comments and drops verbatim repeats of ones already
  posted, because "silence is the default" is otherwise aspirational — three `agent:fix` rounds
  would leave three copies of the same note, and three issues once #79 harvests them.

  **And the bound is on the channel, not on a field of it.** The brief tells the model to write no
  finding id of any kind; the half that enforces it is `withoutFindingMarkers`, run over the
  **whole output** at each schema boundary — `reviewOutputSchema` and `fixOutputSchema` — rather
  than called per field. The per-field version stripped `body` and left `title`, `assessment`,
  `howChecked`, `whatChanged` and a follow-up's three strings, so the sentence above was true of
  one field of five and the marker the prompt forbids reached the posted body through the other
  four. Walking the value is what makes a field added later bounded without anyone remembering to,
  which is the property the enumeration could not have.

  The reading side is one function for the same reason. `parseFindingMarkers` and the reader in
  `shared/pr-feedback.ts` disagreed about a line holding two markers — first against last — and a
  line holding two is the only line the question is about. There is one now
  (`lastFindingMarker`), it takes the **last**, because the workflow writes its own last, and it
  shares its regex with the stripper: what is removed and what is recognised are the same set by
  construction, so there is no marker that survives the strip and is still read as an id.
- **An optional channel never has veto power over the mandatory one.** A malformed top-level
  comment is dropped with a warning, not thrown on: throwing would burn both extraction retries and
  take every thread reply down with it. A malformed *thread outcome* still throws — that
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
