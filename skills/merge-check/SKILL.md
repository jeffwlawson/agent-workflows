---
name: merge-check
description: "Pre-merge check of a pull request the agent loop handed back, a PRD PR or a plain issue's: verify its exact head, grade it against its briefs, run what CI skipped or only a real host can check, and report merge-ready or the findings. Use when asked to check, vet or sign off a PR before merging it, or whether a loop PR is safe to merge."
---

# Merge check

The loop has reviewed this PR. Your review is the one it cannot give: on a real environment, across the whole repo, and against briefs the world moved under. You report; the maintainer decides the merge, and either carries it out or arms the loop to (`agent:merge`, the loop's ADR 0009).

## Steps

1. **Repo rules.** `<owner>/<repo>` from `git remote -v`. Read the repo's `CLAUDE.md` (or its README or CI config, where it has none) for the verify command, the standards and how to ask the maintainer, and the loop's `CONTEXT.md` at the release the repo's callers pin (the `@v<tag>` on their `uses: jeffwlawson/agent-workflows/…` lines) for what a handed-over PR looks like. Read [references/environment.md](references/environment.md) before the first GitHub call.
2. **Handed over?** Read the PR's draft state, head SHA, latest agent review, labels and runs. A draft with a loop run in progress is not handed over yet: say so and stop, since a push or a label now collides with the run. Done when the PR is ready (or parked) and you have written down its head SHA.
3. **Briefs.** A PRD PR is graded against each sub-issue's latest *Agent Brief* and against the parent's body; a plain PR against its issue's latest brief. Collect every brief's *After merge, by a human* items.
4. **Verify** on that head, yourself, as environment.md's *Local verify* says (`scripts/verify.sh`). Done when its printed head equals the SHA from step 2 and it exited 0, or you have its failures.
5. **Review** by [references/review.md](references/review.md): spec, standards with the stale-text sweep, and the real-environment probes. Done when every criterion of every brief has a verdict, the sweep's every hit is still true or a finding, and each probe has run or is named as one you could not run, with why.
6. **Report**, then stop.

## The report

**Merge-ready at `<sha>`**, or **Not yet**, then:

- the verify line (head, Node, exit) and what the probes showed;
- each criterion's verdict, per brief;
- each finding, with its file and line, what is wrong, and a remedy: a comment plus `agent:fix` while the PR has fix rounds left, a small fix pushed to the branch, or a question for the maintainer;
- the *After merge, by a human* items, and whether the merge makes a release worth cutting;
- on **Merge-ready**, the two ways on, both at `<sha>`: the maintainer's own merge, the squash with the `sha` guard set to it, or `agent:merge` added while the PR's head is still `<sha>`, which arms the loop to merge that head once it is current and green, refreshing it from the base on the way and dropping the arm if anything else lands on it (environment.md).

Write nothing to the PR, add no label, and merge nothing, until the maintainer says which remedy, says merge, or says arm. On their merge: the squash with the `sha` guard set to the head you checked. On their arm: re-read the head first, and add `agent:merge` only while it is still the head you checked, since the label arms whatever head it lands on (environment.md).

## Stop and ask the maintainer

A fix would change an acceptance criterion; a design question triage did not settle, including anything that weakens a sandbox; the loop looks broken rather than the PR. Ask in this shape (`CLAUDE.md`'s *Asking me to decide*, where the repo has one): the stake in one sentence, the question, one recommendation with one reason.
