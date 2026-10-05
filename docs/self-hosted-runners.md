# Self-hosted runners, and the minutes the loop bills

The answer to #358: can the loop's jobs run somewhere other than a GitHub-hosted runner without
weakening a control, and how much of what the loop bills is overhead that can go. It is analysis,
not a change. **No workflow changes here** — the trust boundaries in §3 are the maintainer's to
draw, and the follow-up tickets in §9 are where each path becomes work.

**Baseline.** v0.7.10's reusables. Billing data from the jobs API for every *Agent PR* and *Agent
Issue* run in `jeffwlawson/bpc-watch` and `jeffwlawson/unraid-stacks` created 2026-10-01 → 10-05,
billed as GitHub bills it: per job, `max(1, ceil(minutes))`, for every job that got a runner. GitHub
docs and vendor pages read 2026-10-05. Prices and the self-hosted charge (§6) move; re-read before
trusting a figure here.

Facts carry a citation. Inferences are marked *(inference)*, and the four claims nobody has probed
yet are collected in §8 rather than scattered as caveats.

---

## 0. The answer in brief

1. **The data overturns two of the issue's premises.** Non-loop labels bill **nothing**: every
   reusable routes with a job-level `if:`, which skips without provisioning a runner (34 such runs,
   0 minutes). And the largest single overhead is not rounding but **review waiting for CI on a
   billed runner**: 198 of 1,225 billed minutes, 16% (§5.3).
2. **Consolidation cannot fix the overrun on its own.** The loop billed 1,225 minutes in the
   **three days** it actually ran (its first run in either repository is 2026-10-03), about 400 a
   day against a 2,000-minute month *(inference: a building-heavy stretch, two PRD chains)*. The
   credential-safe merges save ~6%, the CI wait ~16%. The agent jobs themselves are **71%** of the
   bill and are irreducible wherever they run on billed compute.
3. **So the lever is where the agent jobs run**, and only the agent jobs. The five jobs that run a
   model hold no loop credential by design (`CONTEXT.md` *The agent's own runner*), so they are the
   ones that can move to a machine the adopter owns without carrying the App key with them. Every
   job that holds the key stays on GitHub's runners (§3).
4. **Recommended interface: one input, `agent-runs-on`**, a runner label applied to the agent jobs
   and nothing else, default `ubuntu-latest` (§4). The credential jobs are not configurable at all,
   which is the trust boundary written as YAML.
5. **Where the agent jobs go is the adopter's choice, and three routes lead there** (§6–§7): pay
   (~$60 a month at the window's pace, minutes of work); a managed runner provider (~$11–37,
   an App install); or an ephemeral VM on hardware the adopter owns (free, with egress the adopter
   controls, and the most work). A fourth route — running the agent in a sandbox service such as
   Vercel's — is cheaper per minute, but the Actions job cannot wait for it without paying for the
   wait, so something always-on outside GitHub has to start the agent and report back. That
   something is a second orchestrator, which is what #57 maps (§6.4, §10).
6. **Two blockers before it is promised to anyone but this repo's owner** (§8): GitHub's docs give a
   reusable workflow the caller's self-hosted runners only when both are **owned by the same user
   or organization**, and the postponed $0.002/min self-hosted charge would, as announced, **count
   toward included minutes** — which would erase the quota saving that motivates all of this.

---

## 1. What the loop billed

| Repo | Workflow | Runs | Jobs on a runner | Billed min | Actual min |
|---|---|---:|---:|---:|---:|
| bpc-watch | Agent PR | 71 | 215 | 461 | 305.2 |
| bpc-watch | Agent Issue | 48 | 108 | 414 | 332.8 |
| unraid-stacks | Agent PR | 28 | 88 | 248 | 183.7 |
| unraid-stacks | Agent Issue | 22 | 55 | 102 | 60.7 |
| **Total** | | **169** | **466** | **1,225** | **882.3** |

The issue's table is right to within one job: unraid-stacks' extra `fix / gate` was cancelled while
queued and never got a runner (run 37247639238). The 1,210 **skipped** jobs bill nothing — no
runner, no steps, and timestamps that are bookkeeping (some complete before they start).

The same two repositories' other workflows billed **721** minutes in the window (security scan,
tests, builds, release watch), so the loop was ~63% of a 1,946-minute total. Neither is small enough
to ignore.

### By what a job holds

The classification §3 rests on, applied to the bill:

| Class | Jobs | Ran | Actual | Billed | Rounding |
|---|---|---:|---:|---:|---:|
| **Agent** — runs a model, no loop credential | `review`, `implement`, `implement-prd`, `fix`, `update-branch` | 113 | 814.5 | **872** | 57.5 |
| **Credential** — names the App key / `AGENT_PAT`, runs no model | `time-limit`, `post-review`, `advance`, `catch_up`, `publish` ×4 | 242 | 51.2 | **242** | 190.8 |
| **Gate** — write-scoped workflow token, no loop credential, no model | `gate` ×4 | 94 | 14.1 | **94** | 79.9 |
| **No model, no loop credential** | `follow-ups` | 17 | 2.5 | **17** | 14.5 |
| (never ran: no adopter sets `red-check-command`) | `red-check` | 0 | 0 | 0 | 0 |

Rounding is **342.7 billed minutes, 28%**, and five-sixths of it is in the small jobs: 353 jobs
whose median runtime is 5–21 seconds each bill a whole minute.

Per job name, with medians, is in §5.1.

---

## 2. Why the jobs are separate

The whole of §3 follows from one paragraph, and it is already written down; this restates it so the
table can cite it.

The agent runs **unsandboxed with the runner's passwordless `sudo`**
(`implement/implement.ts:52-56`: *"The ephemeral Actions runner IS the isolation"*). So it can read
the memory of the runner process, which holds **every secret its job names from the job's first
step**, whether or not a step using it runs (probed 2026-10-02), and it can **leave something
behind** — a hook, a git config entry, a replaced binary, a process watching `/proc` — for a later
step on the same runner (`.github/workflows/implement.yml:91-111`, `CONTEXT.md` *The agent's own
runner*). Two consequences:

- **No loop credential in a job that runs the agent.** The App key, every token minted from it, and
  `AGENT_PAT` are named only in jobs that run no model (`CONTEXT.md` *The loop's identity*, ADOPTING
  §2 and §8). That is what makes the App's Workflows: write acceptable.
- **No job that writes runs after the agent on the agent's machine.** A publish job runs on a fresh
  runner and takes nothing from the agent's job but a `git bundle`, which it checks against facts
  the gate established and the agent could not reach (`implement.yml:597-600`, `676-680`).

Both rest on **one disposable VM per job**: *"each GitHub-hosted runner is a new virtual machine"*
([GitHub-hosted runners][gh-hosted]), and *"GitHub-hosted runners execute code within ephemeral and
clean isolated virtual machines"* ([Secure use][secure-use]). A long-lived self-hosted runner breaks
both at once, which is the issue's starting point and is right: *"Self-hosted runners for GitHub do
not have guarantees around running in ephemeral clean virtual machines, and can be persistently
compromised by untrusted code in a workflow"* ([Secure use][secure-use]).

**Where the bubblewrap facts fit.** The issue's runner-environment facts (bubblewrap, user
namespaces, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) came from bpc-watch's *own* audit workflow
(jeffwlawson/bpc-watch#67), which turns on the Claude CLI's Bash sandbox. **The loop does not**: it
runs the agent with sandcastle's `noSandbox()` on purpose (environment parity with CI, `docs/
friction.md` *Decision 2*), and the CLI's sandbox appears nowhere in this repository. So for the
loop the VM is the sandbox, and bwrap matters only to an adopter who wants a second layer (§7.4).

---

## 3. Which jobs may move

"Move" means: run on a runner the adopter supplies, under the isolation rules of §7. All 19 jobs are
`runs-on: ubuntu-latest` today and none takes an input for it.

| Workflow : job | Class | Holds | May move? | Why |
|---|---|---|:--:|---|
| `review : review` | Agent | model token, read-only workflow token | **Yes** | Names no loop credential by design; the largest job in the bill (391 billed). Its CI wait (§5.3) is free on a runner the adopter owns |
| `implement : implement` | Agent | same | **Yes** | Same class. Hands over a bundle, which `publish` re-checks on GitHub's runner |
| `implement-prd : implement-prd` | Agent | same | **Yes** | Same |
| `fix : fix` | Agent | same | **Yes** | Same |
| `update-branch : update-branch` | Agent | same | **Yes** | Same; runs only on a conflicted merge |
| `review : red-check` | No secret, runs the **PR's code** | `contents: read`, no cache | **Yes, with the agent jobs** | Same threat class as the agent (untrusted code, no secret) and same isolation needs. Never ran in the data |
| `review : time-limit` | Credential | App key, `AGENT_PAT` (choose-only) | **No** | Names the key though it mints nothing (`review.yml:215-223`) |
| `review : post-review` | Credential | mints the App token | **No** | All of review's writes |
| `review : advance` | Credential | mints | **No** | Re-labels the PRD parent |
| `implement-prd : catch_up` | Credential | mints, pushes | **No** | Pushes before any agent runs (`implement-prd.yml:913-916`) |
| `* : publish` (×4) | Credential | mints, pushes | **No** | The write boundary itself |
| `* : gate` (×4) | Gate | workflow token with `issues`/`pull-requests: write` | **No** (no reason to) | Records the branch, base and clock the agent cannot rewrite; 14 actual minutes in total, so nothing to gain |
| `follow-ups : follow-ups` | No model | `issues: write` | **No** (no reason to) | 2.5 actual minutes |

**Why not let the credential jobs move too, given an ephemeral VM?** With a correctly reset VM per
job, a credential job on the adopter's runner is as clean as one on GitHub's. The rule is about what
happens when the reset is *not* correct — a misconfigured overlay, a runner registered without
`--ephemeral`, a VM that shares a bridge with the last one. Then an agent job leaves something
behind and the next job on that machine holds the App key: the exact path `CONTEXT.md` closes.
Keeping the key on GitHub's runners makes the adopter's isolation a control for the **model token
and the adopter's own network**, and never for the loop's write credential. The price is small:
the credential jobs are 51 actual minutes of 882.

**What moving the agent jobs buys beyond minutes.** ADOPTING §8 names the loop's one residual it
cannot cheaply close — *"the agent runs unsandboxed with a model token readable in its environment
and unrestricted network egress"* — and answers it *"you need a sandbox with egress control, which
means self-hosted runners."* (also `docs/friction.md` on Decision 2: *"GitHub-hosted runners offer
no egress filtering"*). An egress-filtered VM (§7.1, rule 3) is that sandbox. So the same move is
both the billing fix and the first answer to that residual — but only if the egress rule is kept;
a self-hosted runner with open egress to the adopter's LAN is strictly worse than GitHub's.

---

## 4. The interface

**One string input, `agent-runs-on`, default `ubuntu-latest`,** on each of the five reusables that
run an agent, applied to the agent job (and to `red-check` on review). Every other job keeps a
literal `runs-on: ubuntu-latest`.

```yaml
# in the reusable (sketch, not a change)
on:
  workflow_call:
    inputs:
      agent-runs-on:
        description: Runner label for the job that runs the agent. Nothing else moves.
        type: string
        default: ubuntu-latest
jobs:
  implement:
    runs-on: ${{ inputs.agent-runs-on }}
```

Why this shape and not the alternatives the issue lists:

- **Not one `runs-on` for every job.** That would hand the adopter the decision §3 makes, and the
  first thing a cost-minded adopter would do with it is move the publish jobs too.
- **Not per-job inputs.** The only per-job distinction worth drawing is agent / not-agent, and the
  "not" side is not configurable. Five inputs for one decision is four places to set it wrong.
- **Not a JSON label list, yet.** `workflow_call` inputs are only `boolean`, `number` or `string`
  ([workflow syntax][wf-syntax]), so an array or a `{group, labels}` object has to arrive as JSON
  and be decoded with `fromJSON(inputs.x)` — a standard pattern that GitHub's docs never show inside
  `runs-on` (§8). And a single unique label is enough to route: a JIT runner registered with the
  label `agent-vm` takes `runs-on: agent-vm` without `self-hosted` being listed. A JSON form can be
  added later without breaking the string form only if it is a second input; decide that then.
- **A caller cannot do this itself.** `runs-on` is not among the keys a job calling a reusable
  workflow may set ([Reusing workflow configurations][reuse], *Supported keywords*), which is why
  this has to be an input at all.

The `self-check` input is unaffected: it names the review job's check by job id, not by runner.

**Two-step landing.** A new input lands in the reusable first, and in this repository's own callers
only once a release declares it (`CLAUDE.md`, *This repo runs its own loop*;
`tests/workflows.test.ts` reads the pinned release with `git show`).

### What `doctor` should say

`doctor` cannot see a runner, and should say so rather than pass. Ruled on the caller and facts, as
`diagnose` is (`CLAUDE.md` *Changing the install path*, 4–5): a new `InstalledCaller` field, read from
`with:`, and a rule in the same commit.

| When the caller sets `agent-runs-on` to a non-GitHub label | `doctor` says |
|---|---|
| always | **warn**: it cannot check the runner is ephemeral, a VM, or egress-filtered; link §7 |
| the repository is **public** | **warn** louder: GitHub says self-hosted runners *"should almost never be used for public repositories"* ([Secure use][secure-use]). The fork guard still holds, but a label added by a Triage-role collaborator now runs on the adopter's hardware (ADOPTING §8) |
| the caller's owner is not the reusable's owner | **fail** until §8.1 is settled: the job is likely to sit queued |
| `gatherFacts` can list the repository's runners (needs admin) and **none carries the label** | **fail**: a job with no matching runner *"will remain queued until a runner comes online"*, for up to 24 hours ([self-hosted reference][sh-ref]) — silent for a day, and `timeout-minutes` does not count queue time |
| the runner list is unreadable | leave the fact `undefined`, not a pass (`diagnose`'s existing rule) |

---

## 5. How much of the overhead can go

### 5.1 By job

| Job | Ran | Actual | Billed | Rounding | Median s |
|---|---:|---:|---:|---:|---:|
| review / review | 59 | 360.8 | 391 | 30.2 | 322 |
| implement-prd / implement-prd | 24 | 274.0 | 287 | 13.0 | 632 |
| implement / implement | 8 | 93.2 | 98 | 4.8 | 556 |
| fix / fix | 21 | 84.6 | 94 | 9.4 | 227 |
| review / time-limit | 59 | 5.3 | 59 | 53.7 | 5 |
| review / post-review | 59 | 16.6 | 59 | 42.4 | 16 |
| review / advance | 43 | 6.5 | 43 | 36.5 | 9 |
| implement-prd / gate | 36 | 7.8 | 36 | 28.2 | 14 |
| implement / gate | 36 | 3.4 | 36 | 32.6 | 5 |
| implement-prd / publish | 27 | 8.6 | 27 | 18.4 | 18 |
| implement-prd / catch_up | 24 | 3.7 | 24 | 20.3 | 9 |
| fix / publish | 21 | 7.2 | 21 | 13.8 | 21 |
| fix / gate | 21 | 2.9 | 21 | 18.1 | 8 |
| follow-ups / follow-ups | 17 | 2.5 | 17 | 14.5 | 8 |
| implement / publish | 8 | 3.0 | 8 | 5.0 | 22 |
| update-branch (3 jobs) | 1 each | 2.4 | 4 | 1.5 | — |

### 5.2 Caller-side event filtering: not worth it

The issue expected every label event to start every reusable's `gate`. It does not: the gates,
`time-limit` and `follow-ups` carry a job-level `if:` on the label, deliberately (*"A job-level
`if:` skips without provisioning a runner and costs nothing"*, `implement.yml:117-123`). Over the
window:

| Trigger | Runs | Billed |
|---|---:|---:|
| `ready-for-agent`, `ready-for-human`, `needs-triage`, `bug` (non-loop labels) | 34 | **0** |
| `agent:implement` | 36 | 516 |
| `agent:review` | 59 | 552 |
| `agent:fix` | 22 | 136 |
| `agent:update-branch` | 1 | 4 |
| `closed` (merged; follow-ups only) | 17 | 17 |

A caller-level label filter would have saved **nothing**. The scenario's best case is 2 minutes,
from one `agent:implement` run on which both gates ran and both declined, and a filter on "is this a
loop label" would have let that run through too. What it would cost is the routing written twice, once per caller
set, which ADOPTING §4 and `tests/workflows.test.ts:3947-3955` refuse for exactly that reason. The
existing rule stands, and now has a number behind it.

The only real routing waste is the **pair** of gates on `agent:implement`: `implement` and
`implement-prd` both gate on that label and partition by issue shape inside, so one of the two gates
on every such event bills a minute to say "not mine" (37 minutes, 3%). That is scenario (g) below.

### 5.3 The CI wait

`review / review` spends **195 of its 361 actual minutes** in *Wait for other checks, collect
results* (`review.yml:1218`), polling up to 900 s for the PR's CI before the agent starts. It is
the loop's single largest overhead, and it is a deliberate one: a review that does not wait reasons
from the spec alone, which is how one once certified a rule *"corpus-safe"* 96 seconds before the
corpus failed (`review.yml:1189-1195`). The wait stays; the question is only whose runner it sits
on. The two repositories differ a lot: unraid-stacks' median wait is 434 s (its CI is long), bpc-
watch's 90 s.

Moving it **to another job** saves nothing — a waiting runner bills the same in any job. It saves
minutes only where no billed runner waits at all:

- on a **runner the adopter owns** (§3), where it is free;
- by **starting the review when CI completes** instead of polling (§6.2);
- on a **1-vCPU `ubuntu-slim`** job, which is a third of the price per minute but has a hard
  15-minute job limit — equal to the wait's ceiling, so no margin — and an undocumented effect on
  the included-minutes quota (§6.1, §8.4).

### 5.4 Merging jobs

Each scenario merges jobs within one reusable in one run; a merged job bills `max(1, ceil(sum))`.
Savings are slight underestimates — a real merge also drops each job's setup, checkout and token
steps. Baseline 1,225.

| Scenario | Saved | % | Moves a credential next to the agent? |
|---|---:|---:|---|
| (c) `post-review` + `advance` (+ `publish` where several ran) as one post-agent job | 43 | 3.5 | **No.** All name the same key, none runs a model. #257 already folded `resolve` and `auto-fix` into `post-review` |
| (g) one gate for `agent:implement`, shared by `implement` and `implement-prd` | 36 | 2.9 | **No.** Gates hold only the workflow token |
| **(c)+(g): the credential-safe set** | **~79** | **~6.4** | — |
| (a) each gate folded into the job it guards | 54 | 4.4 | **Yes**: hands the agent a write-scoped workflow token and makes the gate's facts agent-writable (`implement-prd.yml:900-906`) |
| (a2) (a) plus `catch_up` | 71 | 5.8 | **Yes**: `catch_up` mints the App token |
| (b) `time-limit` folded into `review` | 54 | 4.4 | **Yes**: `time-limit` names the key. Safe only if its token-source choice moves out, and its arithmetic still needs a job (*"an expression cannot add"*, `review.yml:162-167`) |
| (f) one job per reusable per run — the floor for any merge | 236 | 19.3 | Yes; listed as the ceiling, not an option |
| (h) CI wait off the billed runner (§5.3) | 198 | 16.2 | No; not a merge |

**Read the credential-safe set with its costs.** (c) gives the PRD-only steps `contents: write`
and `statuses: write` they do not need today, and turns `advance`'s `always()` and
`needs.post-review.result` into step conditions — a least-privilege regression inside a job that
already runs no model. (g) is not a merge of two jobs but of two **reusable workflows'** routing:
the partition by issue shape (`implement.yml:169-175`, `implement-prd.yml:15-22`) would have to
happen once, in one place, for both — a design change for 3%.

**Recommendation:** do (h) first; it is the largest and weakens nothing. Do (c) only bundled with
other work on `review.yml`. Record (g) and do not do it for minutes alone.

### 5.5 The estimate against the table

Applied to the window's 1,225 billed minutes:

| Path | GitHub-billed after | Saved |
|---|---:|---:|
| Today | 1,225 | — |
| (h) CI wait off the runner | 1,027 | 198 (16%) |
| (h) + (c) + (g) | ~948 | ~277 (23%) |
| Agent jobs (and `red-check`) on the adopter's runner, §3 | 353 | 872 (71%) |
| … plus (c) + (g) | ~274 | ~951 (78%) |

At the window's rate *(inference: ~400 billed/day over a 30-day month, a building-heavy stretch)*
the loop alone would bill ~12,000 minutes a month; even the last row is ~2,700, above GitHub Free's
2,000 before the repositories' other workflows (another ~140/day: 721 over the five days). So for a building-heavy adopter
on GitHub Free, **no combination of merges keeps the loop inside the quota**; only moving the agent
jobs off billed compute, or paying, does. Paying, at the 2-core rate of $0.006/min
([runner pricing][pricing]), is ~$60 a month at that rate *(inference)* — a figure worth having
next to the effort of §7.

---

## 6. Alternatives to self-hosting

Five families, roughly in order of how much they change. The bar each has to clear is §5.5's: at a
building-heavy pace the loop overruns GitHub Free by about $60 a month at list price, so an option
that costs weeks of work to save that is a decision about control or isolation, not about money.

### 6.1 Pay, or change the plan

- **A payment method and a budget.** The refusal in #358 (*"recent account payments have failed or
  your spending limit needs to be increased"*) means there was no paid headroom, not that Actions
  stopped. Budgets alert at 75, 90 and 100%, can be scoped to one repository, and stop usage only if
  told to ([budgets][budgets]). Minutes of work; weakens nothing.
- **GitHub Pro or Team**: 3,000 included minutes rather than 2,000 ([Actions billing][billing]).
  +50%, which §5.5 says is not enough on its own.
- **Make the repository public**: standard runners are free ([Actions billing][billing]). Not a
  billing decision: every issue and comment becomes world-writable input (ADOPTING §8), and
  `pull_request_target` on a public repository has traps of its own (ADOPTING §1).
- **`ubuntu-slim` for the small jobs**: 1 vCPU, $0.002/min against 2-core's $0.006
  ([runner pricing][pricing]), with `gh`, `jq`, git and Node 24 on the image ([slim readme][slim]).
  Two limits: it is *"a container rather than a full VM"* with a **15-minute job cap**
  ([GitHub-hosted runners][gh-hosted-ref]), and whether a slim minute uses a whole included minute
  is undocumented (§8.4). The gates and `time-limit` fit it. The credential jobs fit it
  *technically*, but GitHub documents each slim container as having *"hypervisor level 2
  isolation"*, which is a weaker statement than the fresh VM §2 rests on — keep the jobs that hold
  the App key on a VM until that sentence is understood *(inference)*. No agent job fits it.

### 6.2 Starting the review when CI completes

The largest overhead (§5.3) is a polling loop on a billed runner. GitHub can deliver the same fact
as an event ([events that trigger workflows][events]):

- **`workflow_run: completed`** fires when a named workflow finishes, from the workflow file on the
  default branch — where the caller already lives — and carries the run's pull requests.
- **`check_suite` / `check_run` do not help**: they *"do not trigger workflows if the check suite
  was created by GitHub Actions"*. They do fire for third-party CI apps, and **`status`** covers CI
  that posts commit statuses.
- The recursion rule does not bite: the loop pushes with the App token, so CI starts on the agent's
  pushes and its `workflow_run` follows.

**A shape** *(inference, for the follow-up to design properly)*: when `agent:review` arrives and
checks are still pending, review's first job records that and ends inside a minute, leaving the
label. A `workflow_run: completed` (and `status`) trigger in the PR-side caller re-enters review,
whose guard asks "every check done, and the label still present?" and only then runs the agent. The
cost moves from up to 15 minutes of polling to about a minute per CI completion — a large win where
CI is slow (unraid-stacks, median wait 434 s), roughly even where it is fast (bpc-watch, 90 s).

**What it costs, and why it is a decision:** `workflow_run` filters by workflow **name**, so the
caller has to name the adopter's CI workflows. That is the first routing a caller would carry, which
ADOPTING §4 refuses and `diagnose` cannot check against anything — a stale name silently degrades
every review back to "no CI evidence". It also runs with *"secrets and write tokens, even if the
previous workflow was not"*, so it needs the fork guard and the author gate re-established on a new
event shape. A webhook receiver avoids naming workflows (an App's webhook does receive Actions'
`check_suite` events) but is an orchestrator outside Actions: #57.

### 6.3 Third-party runner providers

A provider runs the VM loop of §7 for you: install its GitHub App, point `runs-on` at its label.
Two facts govern everything else in this section:

- **To GitHub, every one of them is a self-hosted runner.** So the same-owner rule of §8.1 applies
  — a reusable here reaches a provider's runners for `jeffwlawson/*` callers, and likely not for
  anyone else's — and so would the postponed self-hosted charge (§8).
- **They change where the agent jobs run, not the interface.** `agent-runs-on` (§4) is the whole
  integration, and §3's rule still holds: the jobs that hold the App key stay on GitHub's runners.
  Every provider below claims a fresh VM per job, so the reset §3 worries about becomes the
  vendor's to get right rather than the adopter's.

| Provider | $/min, 2 vCPU x64 | Granularity | Free allowance | Isolation | Personal account? | Month at the window's pace *(inference)* |
|---|---:|---|---|---|---|---:|
| GitHub `ubuntu-latest` | 0.006 | per job, rounded up | 2,000 (Free) | fresh VM | yes | ~$61 over the quota |
| **Ubicloud** | 0.00125 std / 0.002 premium | per minute | $2.50/mo credit | ephemeral VM, JIT runner, disk deleted ([security][ubi-sec]) | likely — undocumented, but its source handles user installs | ~$13 |
| **RunsOn** (in your AWS) | ~0.0009 (spot) | EC2 per second, 60 s minimum | licence free for personal non-commercial use | fresh EC2 per job; a **private** App whose key is in *your* Secrets Manager ([security][runson-sec]) | **yes** ([install][runson]) | ~$11 plus control plane |
| **Namespace** | ~0.003 | 1-minute minimum, then per minute | 30-day trial | VM per job, runner in a container inside it ([privileged][ns-priv]) | **yes** ([docs][ns]) | ~$37 |
| **Tenki** | 0.004 | **per second** | $100 once | single-use VM | not stated | ~$35 |
| Blacksmith | 0.004 | not stated | 3,000 min/mo | Firecracker microVM per job ([security][bs-sec]) | **no**, organizations only | ~$23–37 |
| Depot | 0.006 over 2,000 | per second, billed as whole minutes monthly | 2,000 on $20/mo | ephemeral EC2, egress rules | **no** | ~$61 |
| WarpBuild | 0.004 | per minute | $10 once | ephemeral VM | **no** | ~$49 |
| Cirrus Runners, Actuated | flat $125–150/mo per runner or server | — | — | single-use VM / Firecracker | **no** | ≥$150 |
| BuildJet | — | — | — | — | stopped running jobs 2026-03-31 ([BuildJet][buildjet]) | — |

The month column is the window scaled ×10 (12,250 billed, 8,820 actual minutes) at the provider's
granularity, for the loop alone, all jobs moved; it is for ranking, not budgeting. Prices are list,
2026-10-05, from each provider's pricing page.

**What separates them for this loop:**

- **Personal accounts.** The motivating adopter is a personal account. Of the providers that bill
  the rounding away, only RunsOn documents personal-account support; Ubicloud's source suggests it,
  and Namespace supports them but keeps a one-minute floor.
- **What the vendor's App can do.** Registering a runner on a personal account's repository needs
  **Administration** on that repository (`generate-jitconfig`, [self-hosted runners REST][sh-rest]),
  which can also change branch protection and rulesets. Some ask for more: Blacksmith's App requests
  Contents, Workflows and Pull requests read-write ([app permissions][bs-app]) — a credential broader
  than the loop's own App, held by a third party. RunsOn is the one option where neither the App's
  key nor the VMs belong to anyone else.
- **Egress control** is offered by Namespace (per-profile domain allowlist), Depot (rules) and RunsOn
  (your VPC). Without it, a provider fixes the bill but not ADOPTING §8's residual.

**Recommendation** *(for the owner's repositories)*: RunsOn if an AWS account is acceptable,
since it is the only one that keeps every key in the adopter's hands and runs on a personal account;
otherwise Ubicloud, for price, once a trial confirms the personal-account install and its App's
permissions. Either is less work than §7.2 and leaves nothing on the adopter's LAN.

### 6.4 Moving the agent's compute off Actions

Keep Actions as the trigger and the publisher; run only the agent somewhere else. Every option
shares one trap *(inference)*: **if the Actions job waits for the remote agent, it bills the whole
wait** and saves nothing. The hand-off has to be asynchronous — dispatch and exit — with something
outside the sandbox calling back (`workflow_dispatch` and `repository_dispatch` create runs even from
the workflow token, [triggering a workflow][trigger]). That something is a small always-on
orchestrator, which is #57's seam arriving early.

Privilege separation survives if the sandbox gets only the model token and a read-only token, the
App key stays with `publish` or the orchestrator, and the agent's output comes back as untrusted data
— the bundle `publish` already re-checks. Several of these are *stronger* than today: they can broker
credentials at an egress proxy so the secret never enters the machine.

| Option | Isolation | Billing | ≈$/agent-min *(inference, 2 vCPU / 4 GiB)* | Fit |
|---|---|---|---:|---|
| **E2B** | Firecracker microVM ([security][e2b-sec]) | per second ([pricing][e2b-price]) | 0.0028 | Domain allow/deny lists behind a host-side proxy ([network][e2b-net]); Hobby sessions cap at 1 h |
| **Vercel Sandbox** | Firecracker microVM | CPU billed on active time only ([pricing][vercel-price]) | ~0.0015 | Deny-all by default; injects credentials at the firewall so *"the secrets never enter the sandbox"* ([firewall][vercel-fw]); Hobby sessions cap at 45 min |
| **Google Cloud Run jobs** | gen-2 microVM, the only option for jobs ([execution environments][cloudrun-env]) | 100 ms ([pricing][cloudrun-price]) | 0.0026 | Free tier ≈1,875 agent-minutes a month *(inference)* |
| **Cloudflare Sandbox** | container inside *"a microVM with its own kernel"* ([sandbox][cf-sandbox]) | 10 ms, CPU on active use ([pricing][cf-price]) | <0.001 + CPU | A Worker holds the credentials and can also receive webhooks — the cleanest full #57 end state, and the most work |
| **Daytona** | containers by default; VM class available ([isolation][daytona-iso]) | per second | 0.0028 | Choose the VM class |
| **Modal** | gVisor, not a VM ([Modal][modal]) | per second | 0.0040 | `sudo` and namespaces under gVisor unverified |
| **AWS CodeBuild as an Actions runner** | ephemeral build per job ([CodeBuild runner][codebuild]) | EC2 mode **rounds to the minute** at $0.005 ([pricing][codebuild-price]) | 0.005 | Keeps `runs-on`, so it is really §6.3; keeps the rounding |

Against Actions' $0.006 per *rounded* minute, the microVM options roughly halve the agent's cost
and bill the small jobs' seconds rather than minutes — but the small jobs stay on Actions in this
design, so the rounding of §1 does not go away.

**Anthropic's and GitHub's hosted agents do not fit the loop as it is built:**

- **Claude Code cloud sessions / Routines**: a fresh VM per session and no separate compute charge on
  a subscription, but GitHub triggers cover pull requests and releases, not issues, and the GitHub
  proxy lets the agent **push any branch as the user** ([cloud environments][cc-cloud-envs]) — the
  agent holding a write credential is what §2 exists to prevent.
- **Claude Code self-hosted environments** (Team/Enterprise, beta) run sessions on your hardware with
  per-session minted credentials ([self-hosted environments][cc-sh-envs]); the control plane is
  Anthropic's, so it is a second orchestrator — #57.
- **Claude Managed Agents** need an API key (tokens plus $0.08 per session-hour,
  [pricing][claude-pricing]) and their own toolset rather than the CLI: a rewrite of the runners.
- **`anthropics/claude-code-action`** and **Claude via GitHub's Copilot cloud agent** both run on
  Actions and *"use GitHub Actions minutes"* ([cloud agent][copilot-agent]); the latter also runs
  GitHub's harness, not the loop's prompts or its privilege split.

### 6.5 Other CI systems

None is worth the move for minutes. GitLab's free tier is 400 compute minutes and CI for an
external GitHub repository needs Premium ([GitLab][gitlab-ext]); Buildkite and CircleCI mean a
rewrite of every workflow ([Buildkite][buildkite], [CircleCI][circleci]); Cirrus CI shut down on
2026-06-01 ([MacStadium][cirrus]); Forgejo/Gitea Actions run near-identical YAML but need the
repository, issues and labels on that forge ([Forgejo][forgejo]) — the loop is built on GitHub's
labels, pull requests and sub-issues. Each is a #57-scale change justified, if at all, by something
other than this bill.

## 7. A self-hosted runner the docs can endorse

### 7.1 The rules

Platform-neutral. Each is a rule because breaking it reopens a path §2 closed.

1. **Ephemeral: one job per machine, and a fresh machine per job.** Register each runner
   **just-in-time** (`POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`, then `run.sh
   --jitconfig …`): *"These self-hosted runners perform at most one job before being automatically
   removed"* ([Secure use][secure-use]). `--ephemeral` alone is not enough: GitHub de-registers the
   runner, and *"You can then create your own automation that wipes the runner"*
   ([self-hosted reference][sh-ref]) — the wipe is yours. Boot every job from a pristine disk (a
   copy-on-write overlay over a golden image, discarded after the job) — not a cleaned one: an agent
   with `sudo` writes outside `_work`, and `RUNNER_TEMP`'s own cleanup *"will not remove"* files its
   user cannot delete ([variables][vars]).
2. **A VM, not a container.** The agent expects passwordless `sudo`, which a container cannot offer
   honestly, and a container shares the host kernel. Claude Code's own guidance: *"A dedicated
   virtual machine provides the strongest separation, with its own kernel"*
   ([sandbox environments][cc-envs]). This rules out Actions Runner Controller's default pods for
   the agent jobs ([ARC][arc]) and Docker-in-Docker, which *"requires privileged mode"*.
3. **Egress: GitHub and Anthropic, and nothing on the adopter's network.** Default-deny forward from
   the runner's network; allow HTTPS to the hostnames below; drop RFC 1918 and link-local
   destinations except the gateway and DNS. Hostname-based, through a DNS-aware firewall or an
   HTTPS proxy with a CONNECT allowlist — GitHub does *"not recommend allowing by IP address"*
   ([GitHub's IP addresses][gh-ips]).
   - **Actions** ([self-hosted reference][sh-ref], *Accessible domains by function*): `github.com`,
     `api.github.com`, `*.actions.githubusercontent.com`, `codeload.github.com`,
     `results-receiver.actions.githubusercontent.com`, `*.blob.core.windows.net` (artifacts — the
     agent's bundle travels this way), `objects.githubusercontent.com`,
     `objects-origin.githubusercontent.com`, `github-releases.githubusercontent.com`,
     `github-registry-files.githubusercontent.com`, `release-assets.githubusercontent.com`.
   - **Claude Code** ([network config][cc-net]): `api.anthropic.com`; `registry.npmjs.org` (the CLI
     and the runner are both installed from npm). Set
     `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and the telemetry hosts are not needed.
   - **The adopter's own setup** — whatever the `setup` input and the verify command fetch. This is
     the list that grows, and the one an adopter has to own.
   - Do **not** copy the host-subnet allowance in Anthropic's reference devcontainer firewall
     (`init-firewall.sh`, which accepts the host's /24); it is the rule this one exists to break.
4. **Mounts: nothing from the host.** No shared folders (9p / virtiofs), no Docker socket, no
   credentials baked into the image. The only credential that enters the VM is the JIT config.
5. **The minting credential stays on the host.** Generating a JIT config needs repository admin. It
   lives in the host's loop that creates VMs and never in a VM. On a personal account runners are
   repository-scoped ([self-hosted runners][sh-concepts]), so one loop per repository, or one token
   that covers several.
6. **Only the agent jobs** (§3). Register the runners with a label no other workflow in the
   repository uses, so `agent-runs-on` is the only way a job lands there.
7. **Upkeep.** Update the runner within 30 days or jobs stop being queued, even with
   `--disableupdate` ([self-hosted reference][sh-ref]); forward the runner's logs off the VM, since
   the VM is gone with them.

**What the image needs** (`ubuntu-latest` provides these today, and the loop assumes them —
ADOPTING §4 already records `jq` as an image assumption): Node 24 and npm with a writable global
prefix (`npm install -g @anthropic-ai/claude-code`), `git`, `gh`, `jq`, `python3` (transcript
redaction), bash, passwordless `sudo` for the runner user. Plus whatever the adopter's `setup` input
needs — which, for a non-Node adopter, is the #346 question arriving from another direction.

### 7.2 Worked example: a KVM VM on an Unraid server

Unraid's VM manager is KVM/QEMU under libvirt ([Unraid VMs][unraid]). The rules above, in that
vocabulary *(inference: assembled from primary docs; no maintained "runner on libvirt" project was
found worth citing)*:

1. **A golden image.** An Ubuntu cloud image with Node 24, git, gh, jq, python3, the Actions runner
   unpacked and **not** configured. Never booted read-write after it is built.
2. **A network that is not `br0` or `virbr0`.** `br0` puts the VM on the LAN, and libvirt's `nat`
   mode *"will allow outbound connections to any other network device"* ([libvirt network
   XML][libvirt-net]). Use a dedicated VLAN or a routed libvirt network, with the egress rule of
   §7.1 enforced **on the host or the router**, where the VM cannot change it: nftables' `bridge`
   family filters traffic crossing the bridge ([nftables bridge filtering][nft-bridge]), and
   libvirt's `nwfilter` rules *"cannot be circumvented from within the virtual machine"* (its
   `clean-traffic` filter adds anti-spoofing; [libvirt nwfilter][libvirt-nwf]).
3. **A host loop, one job per pass:**
   1. mint a JIT config for the repository, with the label `agent-runs-on` names;
   2. `qemu-img create -f qcow2 -b golden.qcow2 -F qcow2 job.qcow2` — the overlay records *"only the
      differences"* and the backing file *"will never be modified"* ([qemu-img][qemu-img]);
   3. write the JIT config into a cloud-init NoCloud seed (`genisoimage -volid cidata`;
      [NoCloud][nocloud]), whose user-data runs `run.sh --jitconfig …` and powers off;
   4. `virsh create` a transient domain from the overlay and the seed, with no `<filesystem>` share;
   5. when it powers off (or a wall-clock limit passes), destroy the domain and delete the overlay.
4. **Concurrency** is how many passes run at once. The loop's own concurrency groups serialise work
   on one PR or issue already; one or two VMs is enough for a personal account.

The Unraid-specific parts are only the hypervisor and where the disks live; the same loop runs on
any libvirt host, and the rules of §7.1 do not change.

### 7.3 Other local hosts

The worked example is a libvirt host, but most home setups have something else. Each is judged
against §7.1; rules 5–7 belong to the host loop and apply to all of them alike. **None filters
egress by hostname on its own** (Docker Sandboxes aside): the ones that fit can block the LAN on the
host by IP or CIDR, and the hostname allowlist is still an HTTPS proxy on the host.

| Host | Verdict | Minimum config, or why not |
|---|---|---|
| **Incus / LXD VM** (Linux) | **Fits — the best Linux option** | `incus launch --vm --ephemeral` (deleted on stop), JIT config through `cloud-init.user-data`, a dedicated bridge whose ACL drops egress by default, enforced by nftables on the host ([Incus ACLs][incus-acl]); set `security.guestapi=false` |
| **Proxmox VE** | Fits | Linked clone of a read-only template per job, destroyed after ([qm][pve-qm]); `pve-firewall` `policy_out DROP` plus allows, enforced on the node ([firewall][pve-fw]) |
| **Hyper-V VM** (Windows Pro/Enterprise) | Fits | Differencing VHDX per job (`New-VHD -Differencing`), its own internal switch with NAT, extended port ACLs dropping RFC 1918 and link-local at the vSwitch ([extended ACL][hv-acl]); leave Guest Service Interface off |
| **Tart** (macOS, Apple Silicon) | Fits — the best macOS option | Clone, run, delete per job; no `--dir`; `--net-softnet`, which by default lets the VM reach only globally routable addresses and the gateway ([Softnet][softnet]). Licensed FSL-1.1 |
| **Multipass** | Fits, weak network story | A non-primary instance (the primary mounts `$HOME`, [instances][mp-instance]); no ACL of its own, so the host firewall does rule 3 |
| **Docker Sandboxes** (`sbx`) | **Probably fits; unproven as a runner host** | A microVM per sandbox, default-deny egress through a host proxy that takes hostnames ([defaults][sbx-defaults]). Mountless `sbx create`, skills mount and SSH-agent forwarding off, `sbx rm` per job. Unproven: hosting `run.sh --jitconfig`, and whether an unmatched host fails or waits for an approval nobody gives |
| **Kata Containers** / firecracker-containerd | Fits technically, awkward | A VM per container ([Kata][kata-arch]), but egress is still host rules, and Docker inside Kata needs workarounds |
| **WSL2** | **Does not fit** | Distros are *"isolated containers inside of the WSL 2 managed VM"* sharing one kernel and network namespace ([WSL][wsl-about]) — with your everyday distro. Interop and drive automount are switched off in `/etc/wsl.conf`, which the guest's root edits, and a root user *"could still mount"* drives by hand ([wsl.conf][wsl-config]). Use a Hyper-V VM instead: the same hypervisor, without the integration |
| **Docker / Docker Desktop, ECI, Sysbox, gVisor** | Do not fit | Rule 2: shared kernel (gVisor is a user-space kernel, not a VM, [gVisor][gvisor-sec]); passwordless `sudo` in a container is root with fewer capabilities, not a machine |
| **OrbStack, Colima** | Do not fit as shipped | OrbStack machines share one VM and see the Mac at `/mnt/mac` ([OrbStack][orb-machines]); Colima mounts `$HOME` writable by default |
| **Lima, Vagrant** | Only with heavy config | Lima exposes the host's loopback as `host.lima.internal` ([Lima][lima-net]); Vagrant shares the project directory unless disabled — both are the provider VM underneath, and add nothing over it |

**Host-loop tooling worth starting from**, rather than §7.2's hand-rolled loop: GitHub's own
[`actions/scaleset`][scaleset] (public preview; a Go client that mints JIT configs and matches jobs
without polling, runners ephemeral by default), and Cloudbase's [GARM][garm] with its Incus provider,
which creates Incus VMs per job but *"does not apply any ACLs"* — rule 3 stays yours, and the VM's
callback to the GARM controller is one more hole to allow.

### 7.4 The CLI's sandbox, and `ubuntu-latest` moving to 26.04

Not needed for the loop (§2), but asked for, and relevant to an adopter that does turn the sandbox
on — and to everyone's GitHub-hosted jobs from 2026-10-19:

- **`ubuntu-latest` becomes Ubuntu 26.04**, rolling out from **2026-10-19** to 2026-11-19; pin
  `ubuntu-24.04` to stay ([actions/runner-images#14748][14748]).
- **Node:** the image's default Node moves from 22 to 24 ([24.04 readme][img2404],
  [26.04 readme][img2604]). The loop pins Node through `node-version-file` or `'24'` in every job
  that needs it, so nothing changes for it *(inference)*; `follow-ups.yml:178-184`'s comment, which
  names *"the image's Node: v22"*, becomes stale.
- **bubblewrap:** absent on 24.04; **present on 26.04** (`bubblewrap 0.11.1`, image SBOM), but only
  as a dependency of `glycin-loaders`, not a toolset entry, so it could disappear. **`socat`, which
  the CLI's sandbox also needs** ([sandboxing][cc-sandbox]), is on neither — the issue names only
  bwrap.
- **User namespaces:** nothing in the image build changes
  `kernel.apparmor_restrict_unprivileged_userns` (a PR to set it to 0, actions/runner-images#11489,
  was closed unmerged), so it is very likely still `1` *(inference)*. But 26.04 ships AppArmor's
  `bwrap-userns-restrict` profile, which *"only exists to allow bwrap to work on a system with user
  namespace restrictions being enforced"*. So bwrap may work out of the box on 26.04 without
  bpc-watch's `sysctl` — unverified (§8.3).
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`** strips credentials from subprocess environments but
  **keeps `GITHUB_TOKEN` / `GH_TOKEN`** ([env vars][cc-env]); with it set, every command runs
  sandboxed. The docs do not say it refuses to start without bwrap; that is bpc-watch#67's
  observation. The documented switch for refusing is `sandbox.failIfUnavailable`.
- **Containers:** in an unprivileged container *"bubblewrap can't mount a fresh `/proc`"*, and the
  workaround, `enableWeakerNestedSandbox`, *"considerably weakens security"* ([sandboxing][cc-sandbox])
  — the second reason for rule 2.

---

## 8. What nobody has probed yet

Each is cheap to settle and each changes a recommendation above.

1. **Cross-owner runners.** *"Called workflows that are owned by the same user or organization as
   the caller workflow can access self-hosted runners from the caller's context"* ([Reusing workflow
   configurations][reuse], *How reusable workflows use runners*). The docs are silent on a different
   owner. Read literally, an adopter outside `jeffwlawson` who calls these reusables could not reach
   their own runner, and the job would sit queued for a day. **This repository's owner is unaffected**
   (bpc-watch and unraid-stacks share the owner). Probe: a second account's repository calling a
   reusable here with `agent-runs-on` pointing at its own JIT runner. If it queues, the interface is
   owner-only and §4's doctor rule becomes a hard refusal — or the adopter vendors the reusables.
2. **`fromJSON` in `runs-on`.** Only matters if a JSON form is added (§4). Probe before adding it.
3. **Ubuntu 26.04 and bwrap** (§7.4). On `ubuntu-26.04`: `sysctl kernel.apparmor_restrict_unprivileged_userns;
   command -v bwrap socat; bwrap --ro-bind / / --proc /proc --dev /dev true`. Settles whether
   bpc-watch's `sysctl` workaround is still needed after 2026-10-19.
4. **How `ubuntu-slim` minutes count against the quota.** Its price is a third of 2-core's
   ($0.002 vs $0.006, [runner pricing][pricing]); whether a slim minute uses a whole included minute
   or a third of one is not documented, and the old multipliers page now redirects to the pricing
   page. Probe: one week of small jobs on slim, then read the account's usage report.

And one that is not a probe but a watch: **the self-hosted charge.** GitHub announced a
**$0.002/min "cloud platform charge"** for self-hosted runners in private repositories from
2026-03-01, under which *"Any usage subject to this charge will count toward the minutes included
in your plan"*, then postponed it *"to take time to re-evaluate our approach"*
([changelog][gh-2026-pricing]). No new date as of 2026-10-05; current docs still say self-hosted is
free ([Actions billing][billing]). If it returns as announced, self-hosted agent minutes would draw
the same included quota, and §5.5's 71% becomes a dollar saving above the quota rather than a quota
saving. Every follow-up below that leans on self-hosting should restate this.

---

## 9. Follow-ups

One ticket per path this recommends, each citing the section it implements. Paths recorded and
**not** recommended get no ticket: the credential-moving merges (§5.4 (a), (a2), (b)), the caller
label filter (§5.2), and the shared `agent:implement` gate (§5.4 (g)), which is a 3% saving for a
routing redesign. The post-agent merge (§5.4 (c)) is worth doing only alongside other work on
`review.yml`, and is noted on the first ticket rather than filed alone.

| Ticket | Implements | Waits on |
|---|---|---|
| #361 — Review: stop holding a billed runner while the PR's CI runs | §5.3, §6.2 | — |
| #360 — Probe the four unknowns before the runner input is promised | §8 | — |
| #362 — `agent-runs-on`: let the agent jobs, and only those, run on an adopter's runner | §3, §4, §7 | #360 (probe 1), for adopters outside this owner |
| #363 — Run the gates and `time-limit` on `ubuntu-slim` | §6.1 | #360 (probe 4) |

## 10. Related

- **#57** maps a runner ⇄ orchestrator seam for *replacing* Actions. This keeps Actions as the
  orchestrator and changes only where jobs run. Decisions here that #57 should honour:
  - **Placement is per trust class, not per job**: agent / credential / gate (§3). Any orchestrator
    the loop moves to must keep the class boundary — the loop's write credential never on a machine
    that ran a model — and the adopter's compute is offered for the agent class only.
  - **The CI wait is an orchestration concern** (§5.3, §6.2). A runner should not poll for evidence
    an orchestrator can deliver as an event.
  - **A concrete second orchestrator exists to aim at.** Sandcastle, which every runner already
    calls with `noSandbox()`, ships Vercel and Daytona microVM providers and a provider interface
    (`@ai-hero/sandcastle` 0.12.0). But `sandcastle.run()` holds its caller for the whole run, so
    swapping the provider inside an Actions job bills the wait (§6.4). The direction that pays: a
    small TypeScript service, woken by GitHub webhooks, that calls `sandcastle.run()` with a
    microVM provider and writes the result back as the App — GitHub stays the place every issue,
    pull request, label and review lives; only the execution moves. It holds the key the way the
    publish jobs do today, and the agent never shares a machine with it. The cost is environment
    parity with CI (`docs/friction.md`, *Decision 2*) and the pinned-reusable install for other
    adopters, so the Actions path would stay beside it.
- **#346** (non-Node adopters): a self-hosted image is a second place the loop's tool assumptions
  (Node 24, `gh`, `jq`, `python3`) become the adopter's to provide (§7.1, *What the image needs*).

[gh-hosted]: https://docs.github.com/en/actions/concepts/runners/github-hosted-runners
[secure-use]: https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners
[wf-syntax]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_callinputs
[reuse]: https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations
[sh-ref]: https://docs.github.com/en/actions/reference/runners/self-hosted-runners
[sh-concepts]: https://docs.github.com/en/actions/concepts/runners/self-hosted-runners
[vars]: https://docs.github.com/en/actions/reference/workflows-and-actions/variables
[arc]: https://docs.github.com/en/actions/concepts/runners/actions-runner-controller
[gh-ips]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-githubs-ip-addresses
[pricing]: https://docs.github.com/en/billing/reference/actions-runner-pricing
[billing]: https://docs.github.com/en/billing/concepts/product-billing/github-actions
[gh-2026-pricing]: https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/
[14748]: https://github.com/actions/runner-images/issues/14748
[img2404]: https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
[img2604]: https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md
[cc-envs]: https://code.claude.com/docs/en/sandbox-environments
[cc-sandbox]: https://code.claude.com/docs/en/sandboxing
[cc-env]: https://code.claude.com/docs/en/env-vars
[cc-net]: https://code.claude.com/docs/en/network-config#network-access-requirements
[unraid]: https://docs.unraid.net/unraid-os/using-unraid-to/create-virtual-machines/overview-and-system-prep
[libvirt-net]: https://libvirt.org/formatnetwork.html
[libvirt-nwf]: https://libvirt.org/formatnwfilter.html
[nft-bridge]: https://wiki.nftables.org/wiki-nftables/index.php/Bridge_filtering
[qemu-img]: https://www.qemu.org/docs/master/tools/qemu-img.html
[nocloud]: https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html
[budgets]: https://docs.github.com/en/billing/how-tos/set-up-budgets
[slim]: https://github.com/actions/runner-images/blob/main/images/ubuntu-slim/ubuntu-slim-Readme.md
[gh-hosted-ref]: https://docs.github.com/en/actions/reference/runners/github-hosted-runners#single-cpu-runners
[events]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
[trigger]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
[e2b-sec]: https://e2b.dev/security
[e2b-price]: https://e2b.dev/pricing
[e2b-net]: https://e2b.dev/docs/network/internet-access
[vercel-price]: https://vercel.com/docs/sandbox/pricing
[vercel-fw]: https://vercel.com/docs/sandbox/concepts/firewall
[cloudrun-env]: https://docs.cloud.google.com/run/docs/configuring/execution-environments
[cloudrun-price]: https://cloud.google.com/run/pricing
[cf-sandbox]: https://developers.cloudflare.com/sandbox/
[cf-price]: https://developers.cloudflare.com/containers/pricing/
[daytona-iso]: https://www.daytona.io/docs/en/isolation/
[modal]: https://modal.com/resources/run-untrusted-code-safely
[codebuild]: https://docs.aws.amazon.com/codebuild/latest/userguide/action-runner.html
[codebuild-price]: https://aws.amazon.com/codebuild/pricing/
[cc-cloud-envs]: https://code.claude.com/docs/en/cloud-environments
[cc-sh-envs]: https://code.claude.com/docs/en/self-hosted-environments
[claude-pricing]: https://platform.claude.com/docs/en/about-claude/pricing
[copilot-agent]: https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
[gitlab-ext]: https://docs.gitlab.com/ci/ci_cd_for_external_repos/
[buildkite]: https://buildkite.com/pricing
[circleci]: https://circleci.com/pricing/
[cirrus]: https://macstadium.com/blog/cirrus-labs-is-joining-openai
[forgejo]: https://forgejo.org/docs/v15.0/user/actions/github-actions/
[ubi-sec]: https://www.ubicloud.com/docs/github-actions-integration/security
[runson]: https://runs-on.com/installation/flex/
[runson-sec]: https://runs-on.com/docs/control-plane/security/
[ns]: https://namespace.so/docs/solutions/github-actions
[ns-priv]: https://namespace.so/docs/solutions/github-actions/runner-controls/privileged-workflows.md
[bs-sec]: https://www.blacksmith.sh/security
[bs-app]: https://docs.blacksmith.sh/blacksmith-administration/github-app
[buildjet]: https://buildjet.com/for-github-actions
[sh-rest]: https://docs.github.com/en/rest/actions/self-hosted-runners
[incus-acl]: https://linuxcontainers.org/incus/docs/main/howto/network_acls/
[pve-qm]: https://pve.proxmox.com/pve-docs/chapter-qm.html
[pve-fw]: https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html
[hv-acl]: https://learn.microsoft.com/en-us/powershell/module/hyper-v/add-vmnetworkadapterextendedacl
[softnet]: https://github.com/openai/softnet
[mp-instance]: https://canonical.com/multipass/docs/latest/explanation/instance/
[sbx-defaults]: https://docs.docker.com/ai/sandboxes/security/defaults/
[kata-arch]: https://github.com/kata-containers/kata-containers/blob/main/docs/design/architecture/README.md
[wsl-about]: https://learn.microsoft.com/en-us/windows/wsl/about
[wsl-config]: https://learn.microsoft.com/en-us/windows/wsl/wsl-config
[gvisor-sec]: https://gvisor.dev/docs/architecture_guide/security/
[orb-machines]: https://docs.orbstack.dev/machines/
[lima-net]: https://lima-vm.io/docs/config/network/user/
[scaleset]: https://github.com/actions/scaleset
[garm]: https://github.com/cloudbase/garm
