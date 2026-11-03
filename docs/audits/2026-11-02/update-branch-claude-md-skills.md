# Audit: update-branch/prompt.md, CLAUDE.md, skills/merge-check, skills/issues-to-prd

Read-only audit against the `writing-for-agents` skill (SKILL.md and SKILL-MECHANICS.md), at `origin/main` = `c53531d`.
All `path:line` cites are as at that commit. Nothing in the repo was changed.

Tally: 40 findings. Class: 16 safe prune, 24 behaviour-affecting. Priority: 2 high, 16 medium, 22 low.

| File | Findings | Safe | Behaviour | High | Medium | Low |
|---|---|---|---|---|---|---|
| update-branch/prompt.md (U1-U9) | 9 | 2 | 7 | 0 | 5 | 4 |
| CLAUDE.md (C1-C14) | 14 | 7 | 7 | 1 | 6 | 7 |
| skills/merge-check (M1-M11) | 11 | 5 | 6 | 1 | 4 | 6 |
| skills/issues-to-prd (I1-I6) | 6 | 2 | 4 | 0 | 1 | 5 |

"Needs a run" marks a finding where two readers could disagree about whether a sentence is a no-op, or where the effect rests on model behaviour that I did not measure.

---------------------------------------------------------------------------------------------------

# 1. update-branch/prompt.md (76 lines)

## What it does well

- Front-loads the task and the hand-off contract (lines 3-5): resolve, commit, describe. All inputs sit in labelled blocks.
- The reasons are positive and concrete: "worse than an imperfect resolution you have flagged" (30-31), "you cannot reconcile intents you have not read" (35-36).
- **Reconcile, do not invent** (39) is a good leading word with its positive half first, and it has an escape hatch ("go back to step 1", then smallest defensible option plus a flag).
- The "textually trivial but semantically real" paragraph (44-46) caches a gotcha that no config confesses. That is exactly what a prompt should cache.
- The base-failure procedure (52-64) is a concrete, checkable procedure with a named outcome for each branch. It is held identical across four prompts by `tests/verify-failure.test.ts`.
- It names no domain, never the gate command, and has no em dashes. It says `CLAUDE.md` is already loaded and reads `CONTEXT.md` by glossary. All of that is enforced by tests.

## Medium

### U1. "Resolve every conflict" has no completion criterion, and step 1 has no bound
- **Where:** `update-branch/prompt.md:4-5` ("Resolve every conflict, commit the merge"), `:32-36` ("Understand both sides before choosing").
- **Lever:** completion criteria (clarity and demand). Premature completion: nothing says how the agent tells resolved from not resolved, or "understood" from "skimmed".
- **Why it matters:** the runner checks only unmerged paths and MERGE_HEAD (`update-branch/update-branch.ts:92-97`). It does not check for conflict markers. Once an agent `git add`s a file with `<<<<<<<` left in it, the markers are committed and pushed. Only a verify failure in a compilable file would catch that, and a `.md` or `.yml` file would pass. Step 1 has a vague bound ("understand"), so the cheapest reading is a glance at `git log`. Yet step 2 needs the traded-away side named in the comment.
- **Proposal:** add after step 3:
  > Done when `git diff --name-only --diff-filter=U` prints nothing, `git diff --check` reports no conflict marker, and you can say in one sentence what each side of every conflict was for.
  Or append to step 1: "Done when you can state each side's intent in a sentence; step 2's comment needs both."
- **Risk:** no test pins lines 32-46 or the phrases above. `tests/verify-failure.test.ts` and `tests/prompt-ending.test.ts` are unaffected. `workflows.test.ts` bans em dashes, domain terms and "npm run verify", and none of those are in the proposal. `git diff --check` is not a domain term. It also flags trailing whitespace, so say "conflict markers" explicitly.
- **Class:** behaviour-affecting. **Priority:** medium.

### U2. "It must pass before you commit" contradicts the commit-anyway branches
- **Where:** `:50-51` ("It must pass before you commit.") against `:56-58` ("Otherwise commit, and name ...") and `:61-62` ("still gets committed").
- **Lever:** completion criteria (demand and clarity), plus single source and internal consistency. A hard "must" is stated first and then overridden twice, 6 and 11 lines later.
- **Why it matters:** an agent that stops at the hard sentence and is unable to make a failure pass has two live instructions. It may fail to commit, loop on an environment failure, or edit tests to get green. Line 55-56 forbids that edit but only after the "must".
- **Proposal:** replace lines 50-51 with:
  > Run the verify command `CLAUDE.md` names after resolving. Commit once it passes, or once each failure left is accounted for as below.
- **Risk:** no test pins lines 50-51. `tests/verify-failure.test.ts:17-39` pins the later paragraph phrases, and the proposal does not touch them.
- **Class:** behaviour-affecting. **Priority:** medium.

### U3. "Your comment" is never defined, and "describe what you did" competes with the promise ending
- **Where:** `:5` ("describe what you did"), `:38`, `:58-59`, `:62-63`, `:73-74` ("your comment is returned as structured output"), `:76` (promise). Compare `update-branch/extraction.md:5-8`.
- **Lever:** context pointers and information hierarchy (a noun used four times with no definition at first use). Also single source: "failure is the first line" is stated three times (`:58-59`, `:62-63`, `extraction.md:6-7`).
- **Why it matters:** the agent never writes the comment in this pass. A second extraction pass over the session does (`update-branch.ts:68-86`). The prompt says "describe what you did" and then "output `<promise>COMPLETE</promise>`". The implement and fix prompts are explicit that no summary is read (`tests/prompt-ending.test.ts:12-17`), and this one is silent. So the agent has no stated place to record the decision rationale that the later pass will quote. The only place the prompt names is the merge-commit body (`:69-70`).
- **Proposal:** at line 5, replace "and describe what you did" with:
  > and record each non-trivial resolution, and why, in the merge commit body. A later pass writes the PR comment from this session.
  Keep lines 58-59 and 62-63 verbatim. Both are pinned. Optionally collapse 58-59 into 62-63 as "Either way the failure is the first line of your comment", but only if the exact string at `:62-63` survives.
- **Risk:** tests pin `"the **first line** of your comment"` (`tests/verify-failure.test.ts:43`) and `"make the failure the **first line** of your comment, naming it as your own and not the environment's"` (`:50-52`). Do not touch those. Nothing pins `:5`. **Needs a run:** comment quality is the output, and it varies by model.
- **Class:** behaviour-affecting. **Priority:** medium.

### U4. `git log -p <path>` is unbounded and "on each side" is ambiguous
- **Where:** `:34-35` ("`git log -p <path>` on each side shows how they got there").
- **Lever:** completion criteria (demand) and relevance. This is a legwork instruction that is both under-specified and unbounded.
- **Why it matters:** `git log -p <path>` with no revision range dumps the file's whole history. On a hot file that is thousands of lines of attention and tokens, per conflicted file. "Each side" has no argv. An agent may run it only for HEAD, or may confuse `<path>` with a revision.
- **Proposal:**
  > `git log --merge -p -- <path>` shows only the commits from either side that touch it since they diverged; commit messages usually state the intent.
  `--merge` is the git-native form for "refs that touch the conflicting files, on either head".
- **Risk:** no test pins it. **Needs a run:** confirm MERGE_HEAD survives `concludingMerge`'s sandbox carry (`tests/agent.test.ts:142-260` builds a mid-merge fixture and implies it does).
- **Class:** behaviour-affecting. **Priority:** medium.

### U5. The one high-value gotcha sits after the steps as loose reference, and it contradicts step 2
- **Where:** `:44-46` ("Taking 'both' compiles and is still wrong") against `:37` ("Preserve both wherever possible").
- **Lever:** information hierarchy. In-file reference sitting under steps makes attending to it a coin flip. It is also a premature-completion path: step 2 reads as done once both sides are kept.
- **Why it matters:** this is where unattended merges go wrong silently: two registry entries added, a helper moved on one side and edited on the other. It is the least-visible instruction in the file, and it sits next to "preserve both" without saying how they relate.
- **Proposal:** fold it into step 2:
  > 2. **Preserve both wherever possible.** Where both sides touch one registry or one helper (two entries in the same list, a function moved on one side and edited on the other), keeping both compiles and can still be wrong: read the other side's change to it first. Where they are genuinely incompatible, favour the one matching this PR's stated goal, and say in your comment what you traded away.
  Then delete `:44-46`.
- **Risk:** no test pins the phrases. **Needs a run:** the effect is a reduction in variance on the semantic-conflict case. Measure it on a fixture.
- **Class:** behaviour-affecting. **Priority:** medium.

## Low

### U6. Prophylactic negations name the forbidden action
- **Where:** `:29` ("Never `git merge --abort`"), `:68-69` ("do not switch branches or start the merge again"), `:73-74` ("Do not push. Do not edit labels. Do not create GitHub comments").
- **Lever:** negation. Each line puts the forbidden move into context. Also the no-op test and environment as source: the runner scrubs the token before the agent starts (`update-branch/update-branch.ts:61`, "the agent has no `gh` afterwards" at `:58`), so "edit labels" and "create comments" cannot be done anyway.
- **Why it matters:** "the agent might `git merge --abort`" is a guess. `git grep "merge --abort"` finds it nowhere but this line, so there is no incident behind it. Three bare "do not" lines in a row also push the one positive fact (the workflow pushes and posts the comment) to the last clause.
- **Proposal:**
  > Finish the merge in progress; a merge left unfinished fails the run and leaves the branch untouched, which is worse than an imperfect resolution you have flagged.
  and, at the end:
  > The workflow pushes the branch and posts your comment (returned as structured output); you only commit.
  Keep "on the branch already checked out" at `:68`.
- **Risk:** `tests/workflows.test.ts:6567` pins `Do not push.` only for `implement-prd/prompt.md`. Nothing pins these lines in update-branch. **Needs a run:** if the agent never aborts or pushes unprompted, the original sentences were no-ops, and the rewrite changes nothing. If it does, "do not push" may be load-bearing, and the positive form should be tested.
- **Class:** behaviour-affecting. **Priority:** low.

### U7. A sentence that restates its own heading
- **Where:** `:39` ("This is not the place for new behaviour.") under "Reconcile, do not invent."
- **Lever:** no-ops. The leading phrase already carries it, and the next sentence supplies the escape hatch.
- **Proposal:** delete the sentence.
- **Risk:** none pinned. **Class:** safe prune. **Priority:** low.

### U8. `# CONFLICTED FILES` duplicates `# WORKING TREE`
- **Where:** `:11-21`. The runner builds the first with `git diff --name-only --diff-filter=U` and the second with `git status --short` (`update-branch/update-branch.ts:53,80-81`). The status lines already show every `UU/AA/DU` path with its conflict kind.
- **Lever:** environment as source and cache. Both blocks are one-command lookups that go stale as soon as the agent edits.
- **Proposal:** delete the `# CONFLICTED FILES` block and the `CONFLICTED_FILES` entry in `promptArgs`.
- **Risk:** no test names `CONFLICTED_FILES` (grep over `tests/` is empty). It touches the runner. Confirm that sandcastle tolerates an unused prompt arg before dropping only the placeholder.
- **Class:** safe prune. **Priority:** low.

### U9. Commit-message instructions are split across two sections
- **Where:** `:56-58` (name each failing test in the commit message, inside VERIFY) and `:69-70` (the commit body is a summary of resolutions, in COMMIT).
- **Lever:** co-location. An agent reading COMMIT to write the message does not see the failure-naming rule 15 lines up.
- **Proposal:** add to `:70`: "(and, if verify still fails, the failures VERIFY has you name)".
- **Risk:** none pinned. **Class:** behaviour-affecting. **Priority:** low.

---------------------------------------------------------------------------------------------------

# 2. CLAUDE.md (132 lines)

Pins: `tests/claude-md.test.ts` holds only the following.
- At most 150 lines (`:44-47`).
- The seven KEPT headings (`:21-29`): `CLAUDE.md`, `Commands`, `Domain`, `Conventions`, `Line endings`, `Asking me to decide`, `When a message doesn't land`.
- No heading that is neither kept nor moved.
- The nine moved headings and their `](./docs/...)` links (`:59-72`).
- Links that resolve.
- No bare `*name*` citation of a moved section from the moved files.

No test pins any Conventions or Commands prose. `tests/prompt-ending.test.ts` and `setup/SETUP.md:100-102` depend on `CLAUDE.md` naming one gate command ("the verify command `CLAUDE.md` names").

## What it does well

- The pointer list (25-44) is mostly well formed. Each branch leads with a bold trigger noun in the pointer's first words ("Changing a reusable workflow or a caller", "Changing `init` or `doctor`"). Paths in parentheses let an agent that is editing a file recognise itself. `Changing init or doctor (setup/)` is the model pointer: one trigger, one target.
- The line "the tests it names are what fails when one is skipped" gives the reason an agent should read before editing, and that reason does not appear in the target files.
- `verify ... must pass before you finish` (6) is a strong completion criterion. It is exactly what the prompts' "verify command `CLAUDE.md` names" resolves to.
- `Prefer execFileSync argv ...` (88-89) is the right kind of line: a convention with its reason ("A git ref may legally contain ..."), and no config states it.
- `Asking me to decide` is a positive, ordered shape with a reason attached, and an explicit escape ("Go long when the reasoning is the finding").
- The `docs/friction.md` line (108) is one line, with the positive verb first.
- The 132 lines are already down from the pre-#654 version, and the heading structure is enforced.

## High

### C1. The `failure_reason.txt` bullet is 21 lines (16% of the file) of mostly history
- **Where:** `CLAUDE.md:52-72`.
- **Lever:** pruning (sediment, relevance) and the context-load budget. This is paid by every CI agent run, but it bears only on someone writing a runner or command's failure path.
- **Why it matters:** the live rule is two sentences (52-54 plus the OUTPUT_DIR exception). The rest is the history of an exception that "is no longer one" (58), a function that was "replaced" (`required()`, 59), a former signature "before #253" (54), and the surviving-cause note that is only useful when reading a CI message. These layers are what the skill calls sediment: you have to core down through them to find the rule.
- **Proposal:** replace 52-72 with:
  > - **A failure writes `OUTPUT_DIR/failure_reason.txt`** before the process ends (through `fail()`; `readInputs` does it for a missing input), so the workflow can post something a human can act on. A bare `exit 1` posts "It stopped without giving a reason.", which a stale branch's module-resolution failure posts as well. `OUTPUT_DIR` itself cannot report this way: with it unset stderr is the whole report.
  Optionally move the "run never got as far as the runner" note (64-67) to `docs/agents/changing-a-runner-or-a-command.md`. That file has no mention of `failure_reason` today; the only other home is `CONTEXT.md:993`.
- **Risk:** no test pins the prose. The 150-line cap is unaffected. Behaviour tests are `tests/agent-cli.test.ts:368,533,551,606`, which test code, not this text. If the note moves, that doc needs a line, or a rule that is currently in no other agent-facing file is lost.
- **Class:** safe prune (the history trim). **Priority:** high.

## Medium

### C2. The test-spawn and CLI-inputs bullets restate what the test files already say and enforce
- **Where:** `CLAUDE.md:91-94` (cli-inputs), `:95-98`, `:99-107` (SUBPROCESS_TIMEOUT).
- **Lever:** pruning (environment as source of truth, single source, sediment).
- **Why it matters:** 17 lines. The same rule and its reasons are in `vitest.config.ts`'s header comment, `tests/vitest-config.test.ts:5-45`, `tests/sync-version.test.ts:64-91` (the `ceiling` helper, including "a ceiling under the sum of its children's bounds"), and `tests/agent-cli.test.ts:~995-1003`. `tests/vitest-config.test.ts` fails with the message "these write ... rather than importing it". The #144/#145 narrative (100-102) is history about two branches and bears on no action an agent takes.
- **Proposal:** replace the three bullets with:
  > - **A test that spawns synchronously bounds the spawn** at `SUBPROCESS_TIMEOUT`, imported from `vitest.config.ts` and never written out (`tests/vitest-config.test.ts` fails on a copy; the config's comment has the reasoning). A test that runs a subcommand does it through `tests/cli-inputs.ts` and writes `process.env` nowhere else.
- **Risk:** no test pins the prose. The comments in `tests/vitest-config.test.ts:30-32` and `tests/sync-version.test.ts` that say "`CLAUDE.md` said ..." are comments, not assertions. **Needs a run?** No. Every fact the lines carry is reachable from a failing test message or a header comment.
- **Class:** safe prune. **Priority:** medium.

### C3. The `Adopter-Action:` convention is stated in three places
- **Where:** `CLAUDE.md:73-77`, `docs/agents/changing-a-workflow.md:16-19`, `docs/agents/releasing.md:101-110`.
- **Lever:** pruning (single source of truth; inflated prominence).
- **Why it matters:** the fullest copy, and the one that also explains why a trailer in a PR description does not count, is `releasing.md`. The CLAUDE.md copy lists the triggers a second time. A change to the trigger list is a three-place edit, and the copies already differ ("a default that changes behaviour on upgrade" vs "a default that changes behaviour").
- **Proposal:** keep the form here (it is needed at commit time, for any change) and point to the list:
  > - **A change an adopter must act on carries an `Adopter-Action: <one imperative sentence: what to do, and where>` trailer** at the start of its own line in the commit message; [*Releasing*](./docs/agents/releasing.md) says what counts.
  Also trim the matching sentence in `changing-a-workflow.md:16-19` to a link.
- **Risk:** `tests/release-notes.test.ts` tests the parser, not this prose. No `claude-md` test pins it.
- **Class:** safe prune. **Priority:** medium.

### C4. The Commands block caches `package.json` and dilutes the one command the prompts depend on
- **Where:** `CLAUDE.md:5-13`.
- **Lever:** pruning (environment as cache) and completion criteria (clarity). Lines 7-9 restate `package.json` `scripts`. Line 12 repeats line 6 ("the gate"/"the single command that matters").
- **Why it matters:** `setup/SETUP.md:100-102` says `CLAUDE.md` holds "the one command that gates everything" and that every runner prompt says "the verify command `CLAUDE.md` names". An unattended agent finds four candidate commands in one code block. It is disambiguated only by a trailing comment and line 12. `npm run build` is the expensive wrong guess. `build: tsc + copy prompts into dist/` is also a paraphrase of `tsc -p tsconfig.build.json && node dist/scripts/copy-assets.js`, so it can go stale.
- **Proposal:**
  ```bash
  npm run verify   # typecheck + test. The gate: it must pass before you finish.
  ```
  > CI runs it, plus a build and a packaging guard that `verify` cannot cover: [*Releasing*](./docs/agents/releasing.md).
  Delete lines 7-9 and 12. (`package.json` lists `typecheck`, `test`, `build`.)
- **Risk:** no test pins the code block. `tests/workflows.test.ts:8205` and `tests/review-output.test.ts:3356` only bar "npm run verify" from prompts and carried text. Do not remove `npm run verify` from CLAUDE.md.
- **Class:** safe prune. **Priority:** medium.

### C5. The evals paragraph is a pointer branch sitting outside the pointer list, and duplicates `evals/README.md`
- **Where:** `CLAUDE.md:15-18`.
- **Lever:** context pointers (a branch, "change to the review or fix prompt", with its trigger and target) and single source of truth.
- **Why it matters:** the procedure "a before run and an after run, same cases, runs and model, both reports in the pull request" is in `evals/README.md:107-111` ("Comparing a before and an after"). The "cost real money / neither verify nor CI" is in `evals/README.md:7-12`. Here it hides in Commands, so an agent changing `review/prompt.md` does not meet it in the "Read before a change of this kind" list. The "#617" issue number is history.
- **Proposal:** delete 15-18 and add to the list:
  > - **Changing the review or fix prompt** (`review/prompt.md`, `fix/prompt.md`): read [`evals/README.md`](./evals/README.md); a before and an after run go in the pull request.
- **Risk:** the link needs `evals/README.md` to exist, which `claude-md.test.ts:78-81` checks. `tests/evals.test.ts` checks only layout. No test pins the paragraph. Both are lost only if the README stops saying "Paste both reports into the pull request", which it now does.
- **Class:** behaviour-affecting (it moves a rule into the trigger list). **Priority:** medium.

### C6. The Domain pointer sends interactive agents to the whole 1,024-line CONTEXT.md
- **Where:** `CLAUDE.md:22-23` ("Read it before changing a workflow").
- **Lever:** context pointers (trigger wording) and sprawl. `CONTEXT.md` opens with `## Glossary` ("Read this first, then only the sections below that a change touches", `CONTEXT.md:7-9`), and `tests/context-md.test.ts` keeps its links honest. Every runner prompt reads glossary-first (`tests/prompt-ending.test.ts:111-120`, #640). The CLAUDE.md pointer, the human-session entry, does not use it.
- **Why it matters:** the pointer's wording decides how much is read. A session told only "read it" loads about 1,000 lines. The trigger also mismatches the file's own ("Read this before changing anything", `CONTEXT.md:3`), so for non-workflow changes the agent has no instruction.
- **Proposal:**
  > ## Domain
  >
  > [CONTEXT.md](./CONTEXT.md): read its `## Glossary` first, then only the sections the change touches. [*The three parts*](./CONTEXT.md#the-three-parts-and-what-belongs-in-each) decides where a change to a workflow belongs.
- **Risk:** `claude-md.test.ts` keeps the heading `Domain`. The link anchor must resolve; `claude-md.test.ts:78-81` ignores `#` fragments, so verify the anchor by hand. Nothing else is pinned.
- **Class:** behaviour-affecting. **Priority:** medium.

### C7. The pointer list omits "a runner's prompt" and spells one branch several ways
- **Where:** `CLAUDE.md:32-34` ("Adding or changing a runner or a command, an input, an output file, or anything a runner reads from the record") and `:35-36` ("`npm exec`, `npm install` or `uses:` versions").
- **Lever:** context pointers: one trigger per branch; the pointer's job is to state the branches an agent would take.
- **Why it matters:** editing `<runner>/prompt.md` (frequent in recent history, e.g. #638, #640, #650) is a change to a runner, but the pointer never says "prompt". The rules for it ("Prompts name no domain ... never the gate command", `changing-a-runner-or-a-command.md:57`) sit behind it. The tests catch violations after the fact; the pointer should have fired before. "An input, an output file" are facets of "a runner or a command", while `npm exec` / `npm install` / `uses:` are three spellings of one pin branch.
- **Proposal:**
  > - **Changing a runner or a command** (its `prompt.md`, inputs or output files), **or anything a runner reads from the record** (a marker, a status context, a trailer): read [*Changing a runner or a command*](./docs/agents/changing-a-runner-or-a-command.md).
  > - **Cutting a release, or changing a pinned version** (`shared/pins.ts`, `scripts/sync-version.ts`, `publish.yml`, bundled dependencies): read [*Releasing*](./docs/agents/releasing.md).
- **Risk:** only the link targets are pinned (`claude-md.test.ts:69-71`). **Needs a run:** whether the stronger "prompt" trigger reaches the doc more often than the bare "runner" wording is a model-behaviour question.
- **Class:** behaviour-affecting. **Priority:** medium.

## Low

### C8. The ADR 0010 pointer overlaps two others and bundles a question branch
- **Where:** `CLAUDE.md:40-42`.
- **Lever:** context pointers (one trigger per branch), pruning (identity the body carries).
- **Why it matters:** "changing a local caller's pin or interface" fires for every caller edit. That already matches branch 1 ("a caller") and branch 3 ("changing a pin"). `changing-a-workflow.md:15` (the new-input case) and `changing-a-runner-or-a-command.md:51` already link ADR 0010, so it is reached from those. The branch left over is "asking why this repo runs the last release", a question, not a change. The ADR's long title and "(ADR 0010)" repeat the target twice.
- **Proposal:**
  > - **Asking why this repo's callers pin the last release**: [ADR 0010](./docs/adr/0010-this-repo-runs-its-own-loop-on-the-last-release.md).
- **Risk:** `claude-md.test.ts:33,69-71` pins only the link `](./docs/adr/0010-...)`. The pointer keeps it. Check that `changing-a-workflow.md` step 3 stays the route for pin-only edits.
- **Class:** behaviour-affecting (a trigger is dropped). **Priority:** low.

### C9. The list intro has an exposition no-op and repeats "read" six times
- **Where:** `CLAUDE.md:27-28` ("Each topic below is in its own file, loaded only when it is read.") and every item ending ": read ...".
- **Lever:** no-ops, pointer identity.
- **Proposal:**
  > Read the file for your kind of change before you edit; it holds the steps, and the tests it names are what fail when one is skipped.
  and drop "read" from each item (`- **Changing `init` or `doctor`** (`setup/`): [*Changing the install path*](...)`).
- **Risk:** the heading `Read before a change of this kind` is pinned (`claude-md.test.ts:55`); keep it. Nothing else is.
- **Class:** safe prune. **Priority:** low.

### C10. The last pointer mixes two jobs and routes through a hub
- **Where:** `CLAUDE.md:43-44` ("Triaging, writing a brief, or editing `docs/agents/` or `skills/`" to `agent-skills.md`).
- **Lever:** context pointers (one trigger per branch) and the information hierarchy (an extra hop).
- **Why it matters:** "triaging / writing a brief" (doing the work) and "editing docs/agents or skills" (maintaining the docs) are different branches. The target (`agent-skills.md`) is an index whose substance (`issue-tracker.md` *Before a brief*, `triage-labels.md`, `ticket-shape.md`) is one hop further. That works for `/triage`, which reads `docs/agents/` itself, but a hand-written brief hits the hub first.
- **Proposal:** split into two bullets; the first links `docs/agents/issue-tracker.md` and `triage-labels.md` directly, the second `agent-skills.md`.
- **Risk:** `claude-md.test.ts:38-41` and `:69-71` require the link to `agent-skills.md` to remain; keep it and add the direct ones.
- **Class:** behaviour-affecting. **Priority:** low.

### C11. Small environment caches in Conventions
- **Where:** `CLAUDE.md:78-80` (strict TypeScript flags are in `tsconfig.json:10,12`), `:81-87` (the `.js` rule; `tsconfig.json:22` comments it and tsc reports it), `:90` ("Test files live in `tests/`, mirroring the source").
- **Lever:** pruning (environment as cache, no-ops). `:90` is also half wrong: `tests/agent-cli.test.ts` and `tests/workflows.test.ts` do not mirror a source file.
- **Proposal:**
  > - With `exactOptionalPropertyTypes`, build optional properties conditionally (`...(x === undefined ? {} : { x })`) rather than assigning `undefined`.
  > - Relative imports use the `.js` extension (NodeNext), except in `scripts/sync-version.ts`, which is run from source and names `../shared/pins.ts`.
  Delete 90.
- **Risk:** none pinned. `tests/sync-version.test.ts:670-780` enforces the `.js` rule on the shipped build.
- **Class:** safe prune. **Priority:** low.

### C12. The "no arguments" bullet is runner-specific
- **Where:** `CLAUDE.md:48-51`.
- **Lever:** progressive disclosure (a branch only some changes reach), single source.
- **Why it matters:** only an agent adding or changing a runner, command, `init` or `doctor` needs it. The "no arguments" fact is also in `CONTEXT.md:43,614`, `changing-a-runner-or-a-command.md:7-8`, and `changing-the-install-path.md:5`.
- **Proposal:** move it to `changing-a-runner-or-a-command.md` and keep the `--dir` exception in `changing-the-install-path.md`; or keep a one-line copy here.
- **Risk:** none pinned. If moved, add the `init`/`doctor` clause to the install-path doc, since neither doc has it today.
- **Class:** behaviour-affecting. **Priority:** low.

### C13. "Line endings" is five lines of a lookup, possibly stale
- **Where:** `CLAUDE.md:110-113`.
- **Lever:** pruning (environment as source, staleness). `.gitattributes` is `* text=auto eol=lf`. "Authored on Windows" may no longer hold: this session and the maintainer's agent box are Linux, though `tests/common.test.ts:661` and `tests/red-check.test.ts:41` repeat the claim. Needs the maintainer's confirmation.
- **Proposal:** replace the section with one Conventions line: "`.gitattributes` makes every file LF; do not commit an `.editorconfig` or a file that disagrees."
- **Risk:** `claude-md.test.ts:26` requires the heading `Line endings` in KEPT; removing it needs a test edit, so leave it unless the maintainer wants that.
- **Class:** safe prune. **Priority:** low.

### C14. The interactive-only sections are paid for on every CI run
- **Where:** `CLAUDE.md:115-132` (17 lines).
- **Lever:** the two loads (context load) and relevance. Every runner starts `claude -p` in the checkout, which loads this file (`tests/prompt-ending.test.ts:78-83`). A CI runner has no "me". Only 117-120 addresses it.
- **Why it matters:** lines 122-132 are dead context in unattended runs. Moving them to the user-level `~/.claude/CLAUDE.md` would drop about 13% of the file from every CI turn.
- **Proposal and caveat:** the skills `merge-check` and `issues-to-prd` cite `CLAUDE.md`'s *Asking me to decide* "where the repo has one", and carry a restated copy (so they survive its absence). `claude-md.test.ts:27-28` pins both headings. This is the maintainer's call. If kept, no change is needed.
- **Risk:** the pinned headings. Nothing tests the skills' cross-reference, so renaming the section would break it silently.
- **Class:** behaviour-affecting. **Priority:** low. **Needs a maintainer decision.**

---------------------------------------------------------------------------------------------------

# 3. skills/merge-check (SKILL.md 33 lines; references/environment.md, references/review.md; scripts/verify.sh)

Pins: `tests/skills.test.ts` and `tests/skills.ts` hold frontmatter validity, a "Use when" trigger list for a model-invoked description, `name` equals the folder, relative links resolve, and a row in `skills/README.md`. `skills/README.md` says `merge-check` has no evals yet, so its description's firing is unmeasured. Nothing pins the body prose.

## What it does well

- Strong, checkable completion criteria at the steps that matter. Step 2: "Done when the PR is ready (or parked) and you have written down its head SHA". Step 4: "Done when its printed head equals the SHA from step 2 and it exited 0, or you have its failures". Step 5: "every criterion of every brief has a verdict, the sweep's every hit is still true or a finding, and each probe has run or is named ... with why". These are exhaustive and checkable.
- It hides the post-completion material well: "Report, then stop" and the report shape come after the work.
- The head SHA is carried as a single token from step 2 through verify, the report and the `sha` guard. That is a clean design.
- The leading words **stale text**, **sweep**, **probe**, **handed over**, **head** recur consistently. The sweep's demand is concrete (`review.md:24`, "write down the phrases that described the old behaviour ... grep the whole checkout for each, and read every hit").
- `environment.md:3` conditions its own workarounds ("use them the moment a call is refused"). The file is read at the right step ("before the first GitHub call", "as environment.md's *Local verify* says").
- `scripts/verify.sh` makes the head and the toolchain observable, not asserted.

## High

### M1. Two instructions disagree about writing to the PR (and to issues) during the review
- **Where:** `references/review.md:39` ("A finding you argue away instead goes in a PR comment saying why, so the record shows it was weighed.") and `:16` ("Such a gap becomes a new issue"), against `SKILL.md:29` ("Write nothing to the PR, add no label, and merge nothing, until the maintainer says ...").
- **Lever:** completion criteria (post-completion rules that disagree with the stop rule) and single source of truth.
- **Why it matters:** both are in context at step 5. One agent posts a PR comment, and another does not. A posted comment is a public, irreversible side effect on a PR the maintainer has not seen the verdict on. Likewise "becomes a new issue" can be read as "file one". Whichever the maintainer wants, the file contradicts itself.
- **Proposal:** `review.md:39`: "A finding you argue away goes in the report with why, so the maintainer sees it was weighed." `review.md:16`: "Such a gap is a finding that recommends a new issue, not scope creep." (The remedy list at `SKILL.md:25` already holds "a question for the maintainer".)
- **Risk:** no test pins either. `skills.test.ts` checks only structure.
- **Class:** behaviour-affecting. **Priority:** high.

## Medium

### M2. The criteria source names only "the latest Agent Brief", with no branch for a slice or a missing brief; steps 1 and 3 lack a bound
- **Where:** `SKILL.md:14` (step 3), `references/review.md:7` ("The issue's latest Agent Brief comment. It replaces the body's criteria").
- **Lever:** completion criteria (clarity) and information hierarchy (a missing branch). Steps 1 and 3 have no "Done when", unlike 2, 4, 5.
- **Why it matters:** the loop reads criteria from a brief comment, an acceptance section in a trusted comment (the last one supersedes), or the body's checklist (`CONTEXT.md:426-435`). `issues-to-prd/SKILL.md:39` already handles the `/to-tickets` slice whose criteria are in its body. For such a PR (or one on an outsider's issue) merge-check finds no brief and has no instruction. Step 5's "every criterion of every brief" then has nothing to bind.
- **Proposal:** step 3:
  > 3. **Criteria.** For each issue, the criteria the loop's review graded against (`CONTEXT.md`, *Every review checks the linked issue's acceptance criteria*): the latest *Agent Brief* or acceptance section, else the body's. Done when each issue has its criteria written down, or you have said it has none. Collect every brief's *After merge, by a human* items.
  And in `review.md:7` replace "latest Agent Brief comment. It replaces" with "latest criteria (above), which replace".
- **Risk:** no test pins them. **Needs a run:** build a fixture PR from a `/to-tickets` slice.
- **Class:** behaviour-affecting. **Priority:** medium.

### M3. The description is a long pointer: synonym triggers, body-carried identity, and always-loaded for every repo
- **Where:** `SKILL.md:3`.
- **Lever:** context pointers: one trigger per branch ("check, vet or sign off" and "whether a loop PR is safe to merge" are one branch written four times), cut identity the body carries (the middle clause restates steps 4-6), front-load the leading word. And the invocation choice (SKILL-MECHANICS.md): the skill is installed user-level (`skills/README.md:14-18`, `-g`), so its description is paid on every turn in every repository.
- **Why it matters:** about 75 words are always loaded. The distinct discriminator against other skills (`code-review`, `pr`) is "a PR the agent loop handed back"; the rest adds nothing the branch does not already say.
- **Proposal:**
  > description: "Pre-merge check of a pull request the agent loop handed back, reporting merge-ready or the findings. Use when asked to check a loop PR before merging, or whether it is safe to merge."
  A bigger decision, the maintainer's: the loop's own comments tell a human to type `/merge-check` (`tests/merge/gate.test.ts:206,488`). If the skill only ever fires by hand, SKILL-MECHANICS.md says make it `disable-model-invocation: true` and pay no context load. `skills/README.md:8` promises "or by Claude when asked to check a PR before merging", so that is a product choice.
- **Risk:** `tests/skills.test.ts:129-145` requires a "Use when" trigger for a model-invoked description, which the proposal keeps. The README row is checked only for existence. **Needs a run:** there are no evals for merge-check. Skill-trigger rates for the shortened wording must be measured before shipping.
- **Class:** behaviour-affecting. **Priority:** medium.

### M4. The head-guard and arm rule is stated three times, and the role twice
- **Where:** `SKILL.md:27` ("both at `<sha>` ... which arms the loop to merge that head once it is current and green, refreshing it from the base on the way and dropping the arm if anything else lands on it"), `:29` ("re-read the head first, and add `agent:merge` only while it is still the head you checked, since the label arms whatever head it lands on"), `references/environment.md:31-36`. Also the role: `SKILL.md:8` against `references/review.md:3` (near-verbatim: "The loop has reviewed ... your review is the one it cannot give / exists for what it cannot see").
- **Lever:** pruning (single source; duplication inflates prominence). `agent:merge` is an optional follow-up, and it gets about 10 of the 33 lines in the main file.
- **Why it matters:** three copies mean a three-place edit when ADR 0009 changes, and an agent that skims line 27 holds a different rule from the one at `environment.md:31`.
- **Proposal:** `SKILL.md:27`: "- on **Merge-ready**, the two ways on, both at `<sha>`: the maintainer's own squash with the `sha` guard, or `agent:merge` added while the head is still `<sha>` (environment.md)." `:29`: "Write nothing to the PR, add no label, and merge nothing until the maintainer says which remedy, says merge, or says arm; then act as environment.md says." Delete `review.md:3` (the file is read at step 5, after `SKILL.md:8`).
- **Risk:** none pinned (grep of `tests/` for these phrases finds only `tests/merge/gate.test.ts`, which checks the loop's own comments).
- **Class:** safe prune. **Priority:** medium.

### M9. The loop's `CONTEXT.md` is read at a tag with no command, and in full (also applies to issues-to-prd)
- **Where:** `SKILL.md:12` ("and the loop's `CONTEXT.md` at the release the repo's callers pin"), against `issues-to-prd/SKILL.md:15` (which carries the `gh api ... ?ref=v<tag>` command and a four-file list).
- **Lever:** context pointers and sprawl (the whole 1,024-line file is read), and consistency across the sibling skills.
- **Why it matters:** merge-check gives a read target with no mechanism, so each run improvises (`git show v<tag>:CONTEXT.md`, `gh api`, a web fetch, or no read). At the pinned tag the file may not have a glossary, but where it does (since #640) the runner prompts already read glossary-first with a whole-file fallback.
- **Proposal:** in both skills, use the prompts' sentence: "read `## Glossary` first, then only the sections the PR touches; where it has no glossary, read it whole". In merge-check also give the fetch command, or point to `issues-to-prd/SKILL.md:15`'s form. Cross-skill links break under per-skill install, so copy the one line.
- **Risk:** `tests/skills.test.ts` checks only links inside each skill. Nothing pins the prose.
- **Class:** behaviour-affecting. **Priority:** medium.

## Low

### M5. Incident anecdotes and a trap sentence in `review.md` bear on nothing
- **Where:** `references/review.md:16` ("one sandbox brief predated a second sandbox the same code built"), `:18` ("A refusal echoing a proxy URL ..."), `:33` (the `bwrap` run, the route list, and "A trap from that run: a synchronous spawn blocked an in-process host end's event loop and looked like a hang.").
- **Lever:** pruning (relevance, sediment). The trap sentence describes one test in one run and matters to no later probe. The three examples anchor a generic skill on sandboxes, so a non-sandbox PR gets sandbox probes (and `SKILL.md:32` repeats "anything that weakens a sandbox").
- **Proposal:** delete the trap sentence (`:33`, last sentence). Keep one example per rule and trim `:33`'s route list to "try every route past it (loopback, the host's real address, IPv6, outside and private ranges)". **Needs a run** for the trim of examples.
- **Risk:** none pinned. **Class:** safe prune (the trap sentence). **Priority:** low.

### M6. `environment.md` carries instructions the skill never reaches
- **Where:** `references/environment.md:38` (blocking edges and the database-id trap), `:23` (ready for review, resolving threads, auto-merge have no REST route), `:46` (merged branches you cannot delete are listed).
- **Lever:** pruning (relevance). merge-check adds no edge, marks nothing ready, resolves no thread, and has no step that merges and then deletes a branch (`SKILL.md:29` merges on request but never says to delete). Line 46 refers to a step that does not exist.
- **Proposal:** delete 38 and 23. Either delete 46 or add the delete-branch step it presupposes.
- **Risk:** none pinned. **Class:** safe prune (38 and 23); 46 is behaviour-affecting. **Priority:** low.

### M7. A duplicate tail and a garbled completion line
- **Where:** `references/review.md:41` ("Collect the brief's *After merge* items as you go; they go in the final report.") repeats `SKILL.md:14`, `:26`, and `review.md:31`. And `:35` ("Each probe ends run, with what it showed, or named as one you could not run here, with why.") does not parse.
- **Lever:** pruning (single source), and completion criteria (clarity).
- **Proposal:** delete `:41`. Rewrite `:35`: "Each probe ends in one of two ways: run, with what it showed, or named as one you could not run here, with why."
- **Risk:** none pinned. **Class:** safe prune. **Priority:** low.

### M8. A finding is defined twice, with different parts
- **Where:** `references/review.md:39` ("the file and line, what is wrong, and the rule that fixes it") against `SKILL.md:25` ("its file and line, what is wrong, and a remedy").
- **Lever:** single source of truth, and completion criteria (demand).
- **Why it matters:** "the rule that fixes it" is the standard violated; "a remedy" is the action. A reader sees one shape in the file that governs writing findings and another in the report spec.
- **Proposal:** in `review.md`, say: "Each finding is as `SKILL.md` writes it, plus the rule it breaks. For a fix round, add 'change nothing else' ..."
- **Risk:** none pinned. **Class:** behaviour-affecting. **Priority:** low.

### M10. Two report items have no source for their test
- **Where:** `SKILL.md:25` ("while the PR has fix rounds left") and `:26` ("whether the merge makes a release worth cutting").
- **Lever:** completion criteria (clarity). Neither names where the answer comes from (the loop's fix budget in `CONTEXT.md`; the repo's `docs/agents/releasing.md`) or what makes a release worth cutting.
- **Proposal:** "(`CONTEXT.md`, the fix-round budget)" and "(the repo's release doc, where it has one)". Or delete the release item if it is not acted on.
- **Risk:** none pinned. **Needs a run:** two readers will disagree on whether the release clause changes behaviour today.
- **Class:** behaviour-affecting. **Priority:** low.

### M11. A fetch is repeated, and the script path is ambiguous
- **Where:** `references/environment.md:54-61` (step 3 fetches `origin main`; step 4 says "Fetch `origin main` first") and `SKILL.md:15` / `environment.md:62` (`scripts/verify.sh`, relative to what?).
- **Lever:** pruning (duplication), pointers (a path with no anchor).
- **Proposal:** step 4: "Diff against `git merge-base HEAD origin/main` (step 3 fetched it; a stale local `main` fills the diff with other PRs' changes)." Write the script as "this skill's `scripts/verify.sh`".
- **Risk:** none pinned. `tests/skills.test.ts` checks links in SKILL.md and references/ only; `scripts/verify.sh` is not linked. **Class:** safe prune. **Priority:** low.

---------------------------------------------------------------------------------------------------

# 4. skills/issues-to-prd (SKILL.md 83 lines; references/github.md, references/triage.md)

Pins: `tests/skills.test.ts` (frontmatter, `disable-model-invocation: true` with no "Use when" trigger list, links, README row). The behaviour is held by plan-only evals in `skills/evals/issues-to-prd/` (4 cases, 23 graders). The graders cover: gate verdicts, "sub-issues of a published PRD are not Wrong level", the stale-brief row, no `agent:*` label written, no write before the maintainer's yes, attach by database id, and a verify natively step. None reads the hand-over bullet, "Hard limits", or `triage.md`.

## What it does well

- The description is correctly user-invoked: a one-line summary with no trigger list (zero context load, as SKILL-MECHANICS.md prescribes).
- **Stage** is a good leading word, backed by "then stop" and "you touch no pull request and watch no run".
- "Two sources of rules ... they own everything this skill applies, and where they differ from it, they win" is the right stance: the environment is the source, and the skill is a thin layer over it. The precedence rule is stated at line 21.
- The gate is an ordered, exclusive decision table ("Report the first row that matches"), with a reason attached to the least obvious row ("A range catches what a date misses: commit dates carry their author's offset").
- The set procedure has "Done when" on steps 1, 2, 3 and 6, a hard "Propose, then wait" gate at step 4, and a verify step that reads back from the API rather than from what was written.
- `github.md` is a concise REST table; the `triage.md` brief to the subagent is explicit about outputs ("Return **only** the questions whose answer changes the brief").

## Medium

### I1. The triage draft is written by a subagent that is not pointed at the writing rules the orchestrator reads
- **Where:** `references/triage.md:3` (orchestrator reads `AGENT-BRIEF.md` "which owns the writing", hard-coded path `~/.claude/skills/triage/`), against the subagent brief at `:9-16`: item 5 says "in the shape of the repo's three most recent *Agent Brief* comments"; item 1 re-reads the rules files per subagent.
- **Lever:** context pointers and information hierarchy (the material is loaded by the party that does not use it), and the two loads (N subagents each re-read four files).
- **Why it matters:** the draft's shape is set by whichever three recent briefs the subagent finds, which may predate `AGENT-BRIEF.md`'s rules. The orchestrator spends tokens on a doc it only uses at step 4.2 ("opening with `/triage`'s AI disclaimer"). The absolute path breaks where the skill is installed elsewhere.
- **Proposal:** in item 5 add: "Follow `AGENT-BRIEF.md` (`<path>`) for the writing; the recent briefs show the repo's habits." Tell the orchestrator to read it for the disclaimer only. Pass `<path>` as a filled-in value like `<owner>/<repo>`.
- **Risk:** no test or eval grades it (the `issues-to-prd` evals do not reach triage dispatch beyond "sends #725 to triage using subagents that post nothing", grader `set-into-prds/02`). Re-run `set-into-prds` after any change.
- **Class:** behaviour-affecting. **Priority:** medium.

## Low

### I2. "Hard limits" is last, far from the step it binds
- **Where:** `SKILL.md:81-83`.
- **Lever:** co-location, and information hierarchy (in-file reference after the steps). The rule that `agent:implement` is never written unasked, and that detaching, closing and removing others' edges needs a question, is most relevant at step 5 (Build, `:56-61`). It sits two sections after it.
- **Proposal:** move it into step 5 as its first line (or to line 9 under the opening), keeping its text.
- **Risk:** the eval graders `single-issue-ready/01`, `set-into-prds/08` and `published-prd-of-slices/04` grade the no-label behaviour. Re-run them after the move.
- **Class:** behaviour-affecting. **Priority:** low.

### I3. The "plainer" rule is duplicated
- **Where:** `references/triage.md:26` against `SKILL.md:79`.
- **Lever:** pruning (single source). SKILL.md is in context whenever triage.md is.
- **Proposal:** delete `triage.md:26`.
- **Risk:** none pinned. **Class:** safe prune. **Priority:** low.

### I4. The hand-over restates merge-check's decision procedure
- **Where:** `SKILL.md:71` (one 70-word bullet: "before deciding the merge ... `/merge-check <PR>`; on merge-ready, the maintainer merges it at the checked head with the `sha` guard, or adds `agent:merge` at that head for the loop to merge").
- **Lever:** pruning (single source; `merge-check/SKILL.md:27-29` and `environment.md:31` hold it).
- **Proposal:** "- `/merge-check <PR>` before deciding the merge of each PR the loop hands back."
- **Risk:** no grader reads the bullet. **Class:** behaviour-affecting (the printed hand-over shrinks). **Priority:** low.

### I5. `github.md` re-lists "the five checks" the doc says it does not own
- **Where:** `references/github.md:25-33`, against `SKILL.md:13-21` ("they own everything this skill applies").
- **Lever:** pruning (cache of the pinned `ticket-shape.md`, with a hard-coded count: "five checks").
- **Why it matters:** if the pinned release adds or splits a check, the skill's list and the loop's differ, and the skill's list will win in practice because it is closer.
- **Proposal:** "For each check in `ticket-shape.md`'s *Verify natively before labelling anything*, read it back from the API: ..." and keep only the endpoint for each, not the restated check text.
- **Risk:** eval `set-into-prds/07` grades "verifies the result natively". Re-run after the change. **Class:** behaviour-affecting. **Priority:** low.

### I6. "Briefed" is defined after the table that uses it
- **Where:** `SKILL.md:34-35` use it ("not briefed (below)") and `:39` defines it.
- **Lever:** co-location. The definition decides two rows and carries the `/to-tickets` branch, which the eval `published-prd-of-slices/02` grades.
- **Proposal:** move `:39-41` (the "Briefed" definition and the stale-brief command) above the table.
- **Risk:** the move keeps the text; re-run `published-prd-of-slices` to confirm. **Class:** safe prune (a move). **Priority:** low.

(The whole-file read of the loop's `CONTEXT.md` in `SKILL.md:16` is the same finding as M9 and is counted once there.)

---------------------------------------------------------------------------------------------------

# Out-of-scope observations (not counted)

- `docs/agents/releasing.md:14-40` spells out the thirty-four `npm exec` pins, the six `npm install` pins and the nine `loop-token` counts that `scripts/sync-version.ts` already writes and `tests/sync-version.test.ts` already guards. That is a cache of the environment, and it will go stale at the next workflow edit. It sits behind a pointer, so it costs only the agents that read it.
- `docs/agents/changing-a-workflow.md:16-19` repeats the `Adopter-Action:` form (see C3).
- Several `CLAUDE.md` claims are verified true at `c53531d`: `readInputs` is in `shared/env.ts:164`; `tests/vitest-config.test.ts` does fail on a copy of the timeout figure; `tests/agent-cli.test.ts` does enforce "writes `process.env` nowhere else"; `CONTEXT.md:988` is the toolchain-free auth note.
