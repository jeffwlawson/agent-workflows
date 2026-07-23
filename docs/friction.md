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

## Pending — not yet exercised

The loop is proven for implement across all three rule classes, and the corpus has closed the
find→fix→validate cycle. Still unexercised or outstanding:

- **`agent-review.yml` does not exist.** Review is still a human step. When it is added it uses
  `pull_request_target` — on this public repo, add
  `if: github.event.pull_request.head.repo.full_name == github.repository` from the first commit,
  or forks can execute code with secrets in scope. The shared-helper extraction (a composite
  action for the setup steps; backfilling `shared/common.ts`) pays off when this second workflow
  lands, not before.
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
