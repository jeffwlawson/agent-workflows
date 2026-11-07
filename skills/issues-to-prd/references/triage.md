# Triage into Agent Briefs

For an issue the gate sent to triage: no current *Agent Brief*, or one later commits made stale. The brief is the loop's contract: the review grades the PR against it. `issue-tracker.md` (*Before a brief*, *Criteria as behaviour*) and `triage-labels.md`, from the repo or the loop's release (SKILL.md, *Two sources of rules*), own the rules; `/triage`'s `AGENT-BRIEF.md` (in its folder beside this skill's: `~/.claude/skills/triage/` for a user-level install) owns the writing. Read them before dispatching. Where `AGENT-BRIEF.md` is missing, `/triage` is not installed: say so with the install line from the loop's `skills/README.md`, and stop.

## 1. One subagent per issue, in parallel

Clean context per issue. Send all of them in one message. Each gets this brief, filled in:

> Triage `<owner>/<repo>#<n>` into a draft Agent Brief. Post nothing to GitHub: no comment, label or edit.
>
> 1. Read the issue and its comments. Read the code at a clean, freshly fetched `origin/main` (a new worktree, not a working copy), the repo's `CLAUDE.md`, and the rules files SKILL.md names, from wherever SKILL.md says to read them.
> 2. Verify the issue's claim against the code: reproduce it, or find the lines that make it true or false.
> 3. Check overlap as `issue-tracker.md`'s *Before a brief* says: open issues, `ready-for-agent` issues, issues being built, open PRs and their diffs, PRDs, and commits since the issue was written.
> 4. Check each acceptance criterion can fail, as `issue-tracker.md`'s *Criteria as behaviour* says: name the observation that would show it false, and confirm that observation holds at the clean, freshly fetched `origin/main` from step 1. List the criteria that grade nothing: already true there, satisfiable only by another ticket, or a restatement of the request. A guard (true there on purpose, such as "the verify command passes") is not one of them; mark it as a guard in the draft instead.
> 5. Write the draft brief to `<path>/brief-<n>.md`, in the shape of the repo's three most recent *Agent Brief* comments. Mark each undecided point `[OPEN]`.
> 6. Return **only** the questions whose answer changes the brief, with each criterion step 4 listed among them: the criterion, which of the three kinds it is, and a rewrite or its removal. Each: the stake in one sentence, the question, the options, your recommendation with its reason, and the evidence (file and line). Add the claims your recommendation rests on, so they can be checked.

## 2. Check the load-bearing claims yourself

For each question, open the code the subagent's recommendation rests on and confirm it. Then form your own recommendation. Disagree where the evidence says so.

## 3. Bring the maintainer the questions

Per issue, each question in SKILL.md's asking shape, with the subagent's recommendation **and yours**, marked where they differ. Each `[OPEN]` point in a draft is a question, unless the issue's own words settle it: then quote those words and list it as a decision. Questions that change nothing are decided by you and listed as decisions, not asked.

## 4. On their answers

1. Update each draft until no `[OPEN]` is left, recording their decisions as decisions.
2. Post each as an *Agent Brief* comment, opening with `/triage`'s AI disclaimer.
3. Swap `needs-triage` for `ready-for-agent` plus a category label (`triage-labels.md`).

Done when every triaged issue carries a posted brief and its labels, and nothing is `[OPEN]`. Edges wait for the set's clusters (SKILL.md, step 3): the overlap each subagent found is their input.
