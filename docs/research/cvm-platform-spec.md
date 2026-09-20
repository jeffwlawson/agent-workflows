# What shape CVM's platform spec takes, and what transfers

Research for [#58](https://github.com/jeffwlawson/agent-workflows/issues/58), under map
[#57](https://github.com/jeffwlawson/agent-workflows/issues/57). Findings only — no structure is
proposed for our spec; that is [#60](https://github.com/jeffwlawson/agent-workflows/issues/60).

**Source, read 2026-09-20:** `mattpocock/course-video-manager`,
`docs/agents/afk-agent-platform-spec.md` (1092 lines, default branch), plus its neighbours
`docs/agents/{triage-labels,queued-promotion,backlog,domain,testing}.md` and
`docs/agents/prompts/*.prompt.md`, and `.github/workflows/*.yml`, `.sandcastle/`, `tests/`,
`.husky/`, `package.json`. Local facts read from `CONTEXT.md`, `CLAUDE.md`, `docs/ADOPTING.md`,
`docs/parity.md`, `README.md`, `tests/workflows.test.ts` in this repo at `8e16194` (v0.1.8).
`mattpocock/sandcastle` was not needed — CVM was unambiguous throughout.

---

## 0. What the document is, in one paragraph

It is a **re-implementation spec**, not a description of CVM. Its own framing:
*"This document is the source of truth. You should be able to re-implement the whole system in a
fresh repository from this spec alone, without reading the original workflow YAML."* It is
organised as **Part 3 shared foundations + Part 4 eight per-workflow contracts**, with Part 4
sections written to a fixed anatomy so they can be read as a checklist. Every concrete code block
is labelled *reference* and explicitly disclaimed as "one concrete realisation of an abstract
requirement, not a mandate". The runner is named as the **one pluggable axis** of four pillars;
orchestrator (GitHub Actions), tracker (Issues + PRs), VCS (git + GitHub) are declared **fixed**.

That is the sentence #7 was pointing at, and it holds up: the seam is stated as a rule, in §0 —
*"the orchestrator owns every tracker/VCS mutation … the agent runner only emits files"* — and
§3.8 gives it an input/output surface.

---

## 1. Section structure, and what kind of statement each makes

| § | Title | Statement kind |
|---|---|---|
| — | Preamble ("What this is") | Scope declaration + a normative claim about its own completeness |
| 0 | Fixed pillars and the one pluggable axis | **Descriptive table** (4 rows: pillar / fixed-or-pluggable / what is assumed) + one **normative** "central design rule" + a vocabulary glossary |
| 1 | The workflows at a glance | **Descriptive table**, 8 rows: # / workflow / trigger / one-line purpose. Pure index |
| 2 | End-to-end lifecycle | Two **Mermaid diagrams** (flowchart + `stateDiagram-v2` label state machine) + 2 sentences of rationale ("nothing merges to main", "the loop closes") |
| 3.1 | Prerequisites & setup | Three **descriptive tables** (secrets, labels, per-workflow permissions matrix) + a 5-step **normative** "runner baseline" list |
| 3.2 | The label state machine | **Normative**: 4 numbered invariant transitions (accept / success / failure / refusal), the in-progress-as-lock rule, the shape-disambiguation rule, and the two API calls that compute shape (REST sub_issues, a GraphQL parent query quoted in full) |
| 3.3 | Trigger model | **Descriptive table** (event / used by / gating expression) + one block of **rationale** on why `pull_request_target` and not `pull_request` |
| 3.4 | Downstream triggering & graceful degradation | **Rationale** (GITHUB_TOKEN suppresses triggers) + a reference bash snippet + a **normative** "degradation contract" clause |
| 3.5 | Concurrency model | **Descriptive table** (group / members / purpose) + one normative clause: all groups `cancel-in-progress: false` |
| 3.6 | Push safety | Reference snippet + **normative** per-workflow push strategy (force / plain / force-with-lease) with rationale per choice |
| 3.7 | Failure handling | **Normative**, 3 numbered clauses (reason file, `failure()` step, `always()` unlock) + a reference comment template |
| 3.8 | **The agent-runner contract** | The seam. Inputs prose; **two output tables** (plain-text convention files, structured JSON files); then two sub-sections that are **rationale + normative behaviour**: "produce vs. extract" (`runWithRetry` / `runWithExtraction`) and "input tolerance" (alias/coercion rules, drop hallucinated anchors) |
| 3.9 | Constraints, invariants & non-goals | **Normative**, explicitly three-tiered: **hard invariants** (5), **v1 scoping choices** (4), **non-goals** (3). Each bullet is a clause plus its reason |
| 4.1–4.8 | Per workflow | Fixed anatomy, same order every time: Purpose · Trigger · Concurrency · Permissions · **Preconditions & refusals** (a table: condition / mode / action) · Step sequence (numbered) · Agent-runner contract (env in, schema out, quoted as `field: type`) · Side-effects · Failure handling · Chaining · Prompt skeleton link |
| 5 | Worked end-to-end example | **Narrative**, 9 numbered hops with concrete issue/PR numbers |
| A | Reference implementation notes (Sandcastle / Claude Code) | **Descriptive** mapping of abstract role → concrete file, quarantined to an appendix |
| B | Prompt skeleton index | **Descriptive table**, workflow → `prompts/*.prompt.md` |
| C | Related docs in this repo | Pointer list; declares the spec **supersedes and absorbs** the narrower docs |

Two structural habits worth naming, because they are what make the seam readable:

- **Vendor concreteness is quarantined.** Every Claude-Code/Sandcastle detail sits either in a
  block labelled *reference*, or in Appendix A. §3.1's secrets table names the runner credential
  as *"Agent-runner credential — whatever the chosen runner needs. Reference:
  `CLAUDE_CODE_OAUTH_TOKEN`"*. This is directly relevant to the map's open question about
  `CLAUDE_CODE_OAUTH_TOKEN` being vendor-named on the contract surface: CVM's answer is **a
  generic row with a named reference realisation**, not an exception and not a leak to fix.
- **Schemas are stated language-neutrally.** `field: type` shapes in the prose, with a note that
  the reference expresses them in Zod: *"reproduce the validation and the tolerance, in any
  language."*

---

## 2. Per section: do we have the equivalent fact, and where does it live?

"Nowhere" below means no prose site — the fact may still be present in YAML or a test, which is
noted.

| CVM § | Our equivalent | Where it lives here |
|---|---|---|
| 0 pillars / pluggable axis | Partial | `CONTEXT.md` *The three layers* names caller / reusable / runner, but as **our** layering, not as a pillars-and-one-pluggable-axis claim. Nothing states which pillars are fixed. **The "orchestrator owns every mutation" rule is stated** — `CONTEXT.md` *trust boundary* (agent's GitHub token scrubbed), `docs/parity.md` §6 ("Agent never handles the trigger label / PR creation — workflow owns all state transitions") |
| 1 workflows at a glance | ✅ | `CONTEXT.md` *What this is* — label / fires / does table, 5 rows. `README.md` lists the six subcommands |
| 2 lifecycle diagram | ❌ nowhere | No diagram anywhere in this repo. The state machine is implied by `CONTEXT.md`'s table plus `docs/ADOPTING.md` §3's lifecycle column |
| 2 label state machine (diagram) | ❌ nowhere as a machine | See §3.2 row |
| 3.1 secrets | ✅ | `docs/ADOPTING.md` §2 — table of two secrets + a PAT permission table + expiry rationale. **Richer than CVM's**, and load-bearing for tests |
| 3.1 labels | ✅ | `docs/ADOPTING.md` §3 — `gh label create` block + a three-valued **lifecycle column** table (consumed / cursor / marker) CVM has no analogue for. `docs/agents/triage-labels.md` holds the second vocabulary + `wayfinder:*`. Asserted by `tests/agent-cli.test.ts` and `tests/workflows.test.ts` |
| 3.1 per-workflow permissions matrix | ✅ | `docs/ADOPTING.md` §4 — six-row matrix with a `checks` and a `packages` column CVM lacks |
| 3.1 runner baseline | 🟡 | Not stated as a baseline. It is in each reusable workflow's steps, and the `npm exec …@<version>` pin is held to `package.json` by `tests/workflows.test.ts`. `CLAUDE.md` *Releasing* describes the pin, not the step sequence. `docs/parity.md` §5 flags the duplication ("composite action for the repeated setup steps — 📋") |
| 3.2 accept/success/failure/refusal transitions | ❌ nowhere as a normative list | Enforced per-workflow in YAML and asserted piecemeal in `tests/workflows.test.ts` (e.g. "never enters agent:in-progress when it refuses"). No document states the four transitions as one rule |
| 3.2 `agent:in-progress` is a lock | ❌ nowhere | Implicit in the YAML |
| 3.2 shape disambiguation | ✅ | `CONTEXT.md` *What this is* ("partition on **issue shape**"), `docs/parity.md` §2a, and `docs/parity.md` §10's invariant *"Two workflows may share a trigger label only if exactly one of them speaks"* — which is **stronger and more general** than CVM's version |
| 3.3 trigger model table | 🟡 | The `pull_request_target` choice and its consequences are in `CONTEXT.md` *The trust boundary* and *Base-controlled* — but framed as **security**, where CVM frames it as **reliability** (no merge commit on a conflicting PR). Neither document carries the other's reason. No event/gate table exists here |
| 3.4 downstream triggering + degradation contract | ✅ | `docs/ADOPTING.md` §1 (three named silent failures), `CONTEXT.md` *Invariants with no runtime symptom*. The **degradation contract as a clause** ("the label still lands; a human re-adding resumes") is stated in ADOPTING §1 and §2 but not as a single named contract |
| 3.5 concurrency model | 🟡 and **divergent** — see §3 | `docs/parity.md` §10 *"One concurrency group per PR, one per issue"*, at length. Asserted by `tests/workflows.test.ts` ("every PR workflow shares one concurrency group per PR", "declares exactly one group") |
| 3.6 push safety | 🟡 | `--force-with-lease` pinned to the payload SHA: `docs/parity.md` §4 (a table row) and §10 (in the review-race discussion). PRD plain-push: `docs/parity.md` §2a *"Plain `git push`, never force"*. **No single place states the three strategies together** |
| 3.7 failure handling | ✅ | `CLAUDE.md` *Conventions* — the `failure_reason.txt` rule, with the `required()` known exception. `README.md` exit codes. `docs/parity.md` §5. The `failure()`/`always()` step pair is in YAML only |
| 3.8 inputs (env vars) | 🟡 | `README.md` names the input **shape** ("issue or PR number, branch, `CLAUDE_CODE_OAUTH_TOKEN`, model overrides, `OUTPUT_DIR`") and `CLAUDE.md` *Conventions* makes "runners take no arguments" normative. **No per-runner env table exists anywhere** — this is the gap standing decision 5 (tables tested) is aimed at |
| 3.8 outputs (files in OUTPUT_DIR) | ❌ mostly nowhere | Only `failure_reason.txt` is documented (`CLAUDE.md`). Our other outputs are structured objects in `shared/*-output.ts`, not a documented file table |
| 3.8 produce vs. extract | 🟡 | `docs/parity.md` §5 records that we have `run-with-extraction` and lack `run-with-retry` + `retry-feedback`. The **reason** to split produce from extract (side effects must not be repeated) is not written down here |
| 3.8 input tolerance | ❌ nowhere | We do drop inline comments not in the diff (`shared/diff-lines.ts`, `docs/parity.md` §3) but no document states the tolerance rules as a contract clause |
| 3.9 hard invariants | 🟡 | `docs/parity.md` §10 is our invariants section, and `CONTEXT.md` has *Invariants with no runtime symptom*. **Two lists, different axes**: CVM's are contract invariants; ours are (a) loop-design decisions in parity §10 and (b) silent-failure traps in CONTEXT. Overlap is partial — "nothing auto-merges", "one issue → one branch → one PR" are true here and stated nowhere |
| 3.9 v1 scoping choices | 🟡 | Scattered. Flat-PRDs-only is `docs/parity.md` §2a; one-sub-issue-per-run likewise; `agent:queued` human-only is `docs/agents/triage-labels.md` + parity §8 |
| 3.9 non-goals | 🟡 | "No auto-merge / never APPROVE" is `docs/parity.md` §3 (a table row, `Approve / request-changes ❌/❌`). "No cross-repo orchestration" — **false for us**, see §3. "No prose-based dependency parsing" is `docs/agents/issue-tracker.md` + `CLAUDE.md` *Issue tracker* |
| 4.x per-workflow contracts | ❌ nowhere | This is the single largest absence. We have no per-workflow documented anatomy at all: the refusal tables, step sequences and chaining live only in YAML and in `tests/workflows.test.ts`. `docs/parity.md` §§2–4 is the closest thing and is a **comparison**, not a contract |
| 5 worked example | ❌ nowhere | |
| A reference implementation notes | 🟡 | `CONTEXT.md` *The three layers* plus `README.md` do this job for our stack, but not as a "port from here" mapping |
| B prompt skeleton index | ❌ nowhere | Our prompts are `<name>/prompt.md` beside each runner, discoverable by convention (`CLAUDE.md` *Changing a runner*), not indexed |
| C related docs | ✅ | `CONTEXT.md` *Where the rest is written down* — a table. Note the opposite posture: CVM's spec **supersedes** its neighbours; our CONTEXT **delegates** to them |

**Facts we have that CVM's spec has no section for at all** (relevant to #60 as absences, not
proposals): the fork guard and the author gate (`CONTEXT.md` *trust boundary*, `docs/parity.md`
§6 — six ➕ rows), the version pin and what it keeps in step (`CONTEXT.md` *The version pin*),
the caller/reusable split (`CONTEXT.md` *three layers*, *Why reusable workflows*), the install
path (`init`/`doctor`, `CONTEXT.md`), and `self-check`.

---

## 3. Where the loops diverge enough that a section does not transfer

Citing `docs/parity.md` rather than restating it.

1. **CVM is one repo; we are a package plus an adopter.** CVM's workflows are self-contained —
   `.github/workflows/agent-review.yml` carries trigger, concurrency, permissions, env and every
   step inline, and calls `pnpm exec tsx .sandcastle/...`. There is **no caller/reusable split, no
   `uses:` reference and no version pin** anywhere in CVM. Consequence: §3.1's "runner baseline"
   (5 setup steps to copy) and §4.x's "step sequence" are written for someone re-typing YAML. For
   us the equivalent facts are split across two layers by design (`CONTEXT.md` *three layers*,
   `docs/parity.md` §5's composite-action row), and the version pin — `CONTEXT.md` *The version
   pin keeps two halves in step* — is a whole contract clause CVM's spec has no place for. **§3.1
   runner baseline and §4.x step sequences do not transfer.**
2. **Audience.** CVM's spec addresses a re-implementer of the *whole platform*; the map's standing
   decision 3 addresses **both halves of one seam** (a different runner behind our workflows, a
   different orchestrator driving our runners). CVM fixes three of its four pillars; decision 3
   does not. So §0's pillars table transfers only as a **shape**, not as content.
3. **Security.** `docs/parity.md` §6 lists six controls we have and CVM does not — fork guard,
   author-association gates (three rows), explicit bot-identity trust, token scrubbing,
   `contents: read` on review. CVM's spec has **no security section**, and its §3.3 justifies
   `pull_request_target` purely on reliability grounds without mentioning that it is a
   fork-code-execution path. **Nothing to transfer; this is a section CVM lacks.**
4. **Concurrency.** CVM §3.5 groups by *mutation family* (`agent-mutate-pr-*` for the three PR
   mutators, review included). We group **one per PR, one per issue** — and `docs/parity.md` §10
   records that review's exclusion from that group cost a live race (#102), that
   `cancel-in-progress: false` holds at most one waiter, and that the PRD tier has a residual
   cross-group race group keys cannot close. CVM's table is four lines; ours is the most
   thoroughly reasoned invariant we have. **The table shape transfers; every row's content is
   ours.**
5. **Workflow set.** CVM: 8 workflows. Ours: 6. `docs/parity.md` §1 — `agent-to-issues-prd` ❌
   (superseded by `/wayfinder` → `/to-spec` → `/to-tickets`), `agent-promote-queued` ❌ (deferred,
   #91), `architecture-review` 📋; and `agent-follow-ups` ➕ with no CVM counterpart. So CVM §§4.1,
   4.7 and 4.8 describe workflows we do not have, and §4.4/§4.5 describe ones that differ
   materially (`docs/parity.md` §3: no self-improvement, no thread replies from review, no
   verdict; §4: ours is `agent:fix`, resolves threads, posts no new inline comments).
6. **Review is `contents: read` here.** `docs/parity.md` §10 makes that an invariant. CVM's §3.6
   and §3.9 assume review pushes. **§3.6's review row does not transfer.**
7. **Cross-repo.** CVM's non-goal *"No cross-repo orchestration. Single repository."* is the
   opposite of our premise — `docs/ADOPTING.md` exists because the loop is meant to run in other
   people's repositories, and `docs/parity.md` §7 lists `init`/`doctor` as ours alone. **That
   non-goal inverts.**
8. **Prompt skeletons.** CVM ships runner-neutral prompt skeletons *inside* `docs/agents/prompts/`
   as part of the spec (Appendix B), with the project-specific half left to be filled per repo.
   Ours are the shipped artefact itself and are held domain-free by a test (`CONTEXT.md` *The
   prompts name no domain*). Same goal, opposite mechanism: CVM genericises a copy, we genericise
   the original. **Appendix B does not transfer as-is.**

Not a divergence but worth flagging: **CVM has no `ci.yml`.** `.github/workflows/` contains only
the eight agent workflows. `docs/parity.md` §1's `ci — typecheck + test | ✅` row for CVM does not
match what is on the default branch today; verification there is `.husky/pre-commit` +
`turbo run test`. Reported, not fixed — parity.md is not mine to rewrite, and the row is about
CVM's baseline clone date (2026-07-21), not about anything of ours.

---

## 4. Does CVM enforce any of the spec?

**No. It is prose throughout.** Checked:

- `tests/` at the workspace root holds exactly one file, `workspace-layout.test.ts`, and it
  asserts pnpm workspace package names and dependency declarations for Vercel's build graph.
  Nothing about labels, permissions, triggers, concurrency or output files.
- `.sandcastle/` holds three tests: `run-with-extraction.test.ts`, `run-with-retry.test.ts`,
  `no-recent-commits.test.ts`. These test the two output helpers §3.8 describes — i.e. the
  *behaviour* the spec recommends, not the spec's claims about it. Closest thing to enforcement,
  and it is indirect.
- No CI workflow runs tests at all; `.github/workflows/` is the eight agent workflows.
  Verification is `.husky/pre-commit` with `.lintstagedrc` = `{"*": "prettier --ignore-unknown
  --write"}` — formatting only.
- `scripts/` holds `check-file-tokens.sh`, `check-no-dirname.sh`, `cutover-wizard.sh`,
  `audit-export-durations.mts`. None reads `docs/agents/`.
- A repo-wide code search for `afk-agent-platform-spec` returns only the nine
  `docs/agents/prompts/*.prompt.md` files, which cite it as reading material for the agent. A
  search for `docs/agents` returns `CLAUDE.md`, `.sandcastle/review/prompt.md` and two unrelated
  docs. **Nothing machine-readable consumes the spec.**
- The spec's own consistency mechanism is Appendix C — a declaration that it *supersedes and
  absorbs* the narrower docs — and nothing checks that either.

**Prior art for standing decision 5 is therefore negative from CVM and positive from us.** CVM's
eight `permissions:` blocks, eight concurrency groups and label strings exist in exactly two
places (the YAML and the spec's tables) with nothing holding them equal. We already do the thing
the decision proposes, for a different set of tables: `tests/workflows.test.ts` derives `PIN` from
`package.json` and checks both caller sets, asserts one concurrency group per PR, asserts the fork
guard and its `ref:`, asserts `self-check`'s two job ids, asserts the refusal preflights, and
`tests/agent-cli.test.ts` asserts `docs/ADOPTING.md` ships and matches its §3 label table and §4
`with:` inputs. The pattern to copy for a spec's tables is **ours**, not CVM's — CVM's contribution
is the *document shape*, and the shape is unenforced.

One nuance for #60: CVM's tables are enforceable in principle (labels, permissions, triggers,
concurrency groups, output filenames are all greppable from YAML), and its prose is not
(rationale, non-goals, produce-vs-extract). That line falls in almost exactly the place standing
decision 5 draws it — which is a point in the decision's favour, arrived at independently.
