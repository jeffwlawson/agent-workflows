# Triage into Agent Briefs

For an issue the gate sent to triage: no current *Agent Brief*, or one later commits made stale. The brief is the loop's contract: the review grades the PR against it. `issue-tracker.md` (*Before a brief*, *Criteria as behaviour*) and `triage-labels.md`, from the repo or the loop's release (SKILL.md, *Two sources of rules*), own the rules; `/triage`'s `AGENT-BRIEF.md` (in `~/.claude/skills/triage/`) owns the writing. Read them before dispatching.

## 1. One subagent per issue, in parallel

Clean context per issue. Send all of them in one message. Each gets this brief, filled in:

> Triage `<owner>/<repo>#<n>` into a draft Agent Brief. Post nothing to GitHub: no comment, label or edit.
>
> 1. Read the issue and its comments. Read the code at a clean, freshly fetched `origin/main` (a new worktree, not a working copy), the repo's `CLAUDE.md`, and the rules files SKILL.md names, from wherever SKILL.md says to read them.
> 2. Verify the issue's claim against the code: reproduce it, or find the lines that make it true or false.
> 3. Check overlap as `issue-tracker.md`'s *Before a brief* says: open issues, `ready-for-agent` issues, issues being built, open PRs and their diffs, PRDs, and commits since the issue was written.
> 4. Write the draft brief to `<path>/brief-<n>.md`, in the shape of the repo's three most recent *Agent Brief* comments. Mark each undecided point `[OPEN]`.
> 5. Return **only** the questions whose answer changes the brief. Each: the stake in one sentence, the question, the options, your recommendation with its reason, and the evidence (file and line). Add the claims your recommendation rests on, so they can be checked.

## 2. Check the load-bearing claims yourself

For each question, open the code the subagent's recommendation rests on and confirm it. Then form your own recommendation. Disagree where the evidence says so: in the run this came from, the orchestrator disagreed once and the maintainer took its call (under an unsandboxed mode, locking down one step protects nothing the agent cannot already reach).

## 3. Bring the maintainer the questions

Per issue, each question in SKILL.md's asking shape, with the subagent's recommendation **and yours**, marked where they differ. Each `[OPEN]` point in a draft is a question, unless the issue's own words settle it: then quote those words and list it as a decision. Questions that change nothing are decided by you and listed as decisions, not asked.

When the maintainer asks for one plainer ("explain like I'm not a network engineer"): what each side gains and loses, what common practice is, then the recommendation again.

## 4. On their answers

1. Update each draft until no `[OPEN]` is left, recording their decisions as decisions.
2. Post each as an *Agent Brief* comment, opening with `/triage`'s AI disclaimer.
3. Swap `needs-triage` for `ready-for-agent` plus a category label (`triage-labels.md`).

Done when every triaged issue carries a posted brief and its labels, and nothing is `[OPEN]`. Edges wait for the set's clusters (SKILL.md, step 3): the overlap each subagent found is their input.
